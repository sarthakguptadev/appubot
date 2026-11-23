/**
 * The ACP registry (agentclientprotocol.com/registry): a public catalog of ACP agents and how to run each one. The
 * Settings › Agents catalog lists the ones that can run on this Mac; adding one makes it an agent of its own (a custom
 * provider with `registry` set) that bots can run on, signed in with the user's own account for it.
 *
 * How one runs, in this order of preference: its own build for this platform (`binary`: downloaded, checked against
 * the registry's sha256 when it gives one, unpacked under `<dataDir>/agents/<id>/<version>`), else its npm package
 * (`npx` entries) or Python package (`uvx` entries) at the registry's exact version, installed once with the Mac's
 * own `npm` / `uv` into `<dataDir>/agents/<id>/<version>/npm|uv` (Node.js / uv must be on the Mac to add one) and run
 * from there, so it starts without fetching anything. The registry and its icons are cached in
 * `<dataDir>/acp-registry.json`.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep, win32 } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { machineName, type Provider, type RegistryAgent } from '@appubot/protocol';
import { getPathString, killTree, resolveExecutable, spawnCommand, withPath, type ProviderSpec } from '@appubot/agent-runtime';
import type { CoreCtx } from '../context';
import { errMsg, notFound, RpcError } from '../util';

export const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
/** A cached registry this young is used as is. */
const FRESH_MS = 6 * 60 * 60_000;
const MAX_ICON_BYTES = 16 * 1024;
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const PACKAGE_INSTALL_MS = 20 * 60_000;
/** a whole download (Antigravity's Linux build is ~340 MB) */
const DOWNLOAD_MS = 30 * 60_000;
/** a package install that finished (its folder is only reused with it) */
const INSTALLED_MARK = '.installed';

/** Registry entries that are AppuBot's built-in agents (they run through the built-in, nothing to add). */
const BUILTIN_OF: Record<string, string> = {
  'claude-acp': 'claude-code',
  'codex-acp': 'codex',
  cursor: 'cursor',
  'github-copilot-cli': 'copilot',
  'grok-build': 'grok',
  opencode: 'opencode',
};

const Launch = z.object({ args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() });
const Package = Launch.extend({ package: z.string().min(1) });
const Binary = Launch.extend({ archive: z.string().url().startsWith('https://'), cmd: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/i).optional() });
const EntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,40}$/i),
  name: z.string().min(1),
  version: z.string().min(1).regex(/^[\w.+-]+$/),
  description: z.string().optional(),
  website: z.string().optional(),
  repository: z.string().optional(),
  icon: z.string().optional(),
  distribution: z.object({ binary: z.record(z.string(), Binary).optional(), npx: Package.optional(), uvx: Package.optional() }),
});
type Entry = z.infer<typeof EntrySchema>;

interface Cache { fetchedAt: number; entries: Entry[]; icons: Record<string, string> }

/** The registry's name for this machine's platform (`darwin-aarch64`, …). */
export function platformTarget(platform: string = process.platform, arch: string = process.arch): string {
  const os = platform === 'win32' ? 'windows' : platform;
  return `${os}-${arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch}`;
}

/** How an entry runs here: its build for this platform, else npx, else uvx; undefined when none applies. */
export function chooseInstall(e: Entry, target = platformTarget()):
  | { kind: 'binary'; binary: z.infer<typeof Binary> }
  | { kind: 'npx' | 'uvx'; pkg: z.infer<typeof Package> }
  | undefined {
  const binary = e.distribution.binary?.[target];
  if (binary) return { kind: 'binary', binary };
  if (e.distribution.npx) return { kind: 'npx', pkg: e.distribution.npx };
  if (e.distribution.uvx) return { kind: 'uvx', pkg: e.distribution.uvx };
  return undefined;
}

const isArchive = (url: string) => /\.(zip|tar|tgz|tar\.gz|tbz2?|tar\.bz2|txz|tar\.xz)$/i.test(new URL(url).pathname);

/**
 * The programs that can unpack `file` (the archive at `url`) into `dir` here, in the order to try them (the next one
 * only when one isn't installed). macOS: its bsdtar, which reads zip and tar (gz/bz2/xz) alike and refuses absolute and
 * `..` paths. Windows (10 1803+): its own bsdtar, System32's tar.exe. Linux: GNU tar for tarballs, which can't read
 * zip; zips go to unzip, else bsdtar, else Python's zipfile (all three drop `..` and absolute paths too).
 */
export function unpackCommands(url: string, file: string, dir: string, platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] }[] {
  const tar = (command: string) => ({ command, args: ['-xf', file, '-C', dir] });
  if (platform === 'darwin') return [tar('/usr/bin/tar')];
  if (platform === 'win32') return [tar(win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'tar.exe'))];
  if (/\.zip$/i.test(new URL(url).pathname)) {
    return [
      { command: 'unzip', args: ['-q', '-o', file, '-d', dir] },
      tar('bsdtar'),
      { command: 'python3', args: ['-I', '-m', 'zipfile', '-e', file, dir] },
    ];
  }
  return existsSync('/usr/bin/tar') ? [tar('/usr/bin/tar'), tar('tar')] : [tar('tar')];
}

/** Unpack with the first of `unpackCommands` that is installed. */
async function unpack(url: string, file: string, dir: string, name: string): Promise<void> {
  const tried: string[] = [];
  for (const c of unpackCommands(url, file, dir)) {
    try {
      await promisify(execFile)(c.command, c.args, { timeout: 5 * 60_000, windowsHide: true });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      tried.push(c.command);
    }
  }
  throw new RpcError('internal', `Could not unpack ${name}: none of ${tried.join(', ')} is installed.`);
}

/** How npm and uv run for a package install (swapped in tests through `deps.packageRunner`). */
export interface PackageRunner {
  /** where `name` is on the login-shell PATH */
  which(name: string): Promise<string | undefined>;
  /** run to the end with `env` added (login-shell PATH, no stdin) */
  run(command: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<{ ok: boolean; output: string }>;
}

const defaultRunner: PackageRunner = {
  which: (name) => resolveExecutable(name),
  async run(command, args, env, timeoutMs) {
    const PATH = await getPathString();
    return new Promise((resolve) => {
      let out = '';
      const keep = (d: Buffer) => { out = (out + d.toString()).slice(-16_384); };
      let child: ReturnType<typeof spawnCommand>;
      try {
        child = spawnCommand(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...withPath(process.env, PATH), CI: '1', ...env } });
      } catch (e) { resolve({ ok: false, output: errMsg(e) }); return; }
      const timer = setTimeout(() => killTree(child, 'SIGTERM'), timeoutMs);
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
      child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: out || errMsg(e) }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: out.trim() }); });
    });
  },
};

/** A pinned package spec's name: `@scope/pkg@1.2.3` → `@scope/pkg`, `pkg==1.2` → `pkg`. */
export function packageName(spec: string): string {
  const at = spec.indexOf('@', 1);
  const name = at > 0 ? spec.slice(0, at) : spec;
  return name.split(/[=<>!~\[;\s]/)[0]!;
}

/** `uv tool install` takes `pkg==1.2.3`; the registry also writes uvx's `pkg@1.2.3`. */
export const uvSpec = (spec: string): string => (spec.startsWith('@') || spec.includes('==') ? spec : spec.replace('@', '=='));

/**
 * The command an npm package installed under `prefix` (`npm install --global --prefix`) puts on its PATH: its only
 * bin, else the one named like the package or the agent. Windows has `<prefix>\<bin>.cmd` shims, the others
 * `<prefix>/bin/<bin>`.
 */
export function npmBin(prefix: string, name: string, id: string, platform: string = process.platform): string | undefined {
  const modules = platform === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules');
  let bin: unknown;
  try { bin = (JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8')) as { bin?: unknown }).bin; } catch { return undefined; }
  const short = name.replace(/^@[^/]+\//, '');
  const keys = typeof bin === 'string' ? [short] : bin && typeof bin === 'object' ? Object.keys(bin) : [];
  const pick = keys.length === 1 ? keys[0] : [short, id, short.replace(/-acp$/, '')].find((k) => keys.includes(k)) ?? keys[0];
  if (!pick) return undefined;
  const file = platform === 'win32' ? join(prefix, `${pick}.cmd`) : join(prefix, 'bin', pick);
  return existsSync(file) ? file : undefined;
}

/** The command a Python package installed with `uv tool install` put in `binDir`: named like it (or the agent), else the only one. */
export function uvBin(binDir: string, name: string, id: string, platform: string = process.platform): string | undefined {
  const ext = platform === 'win32' ? '.exe' : '';
  for (const c of [name, name.replace(/-acp$/, ''), id]) if (existsSync(join(binDir, `${c}${ext}`))) return join(binDir, `${c}${ext}`);
  let files: string[] = [];
  try { files = readdirSync(binDir).filter((f) => !f.startsWith('.')); } catch { /* none */ }
  return files.length === 1 ? join(binDir, files[0]!) : undefined;
}

/** How to get `npx` or `uvx` on this platform, as a command for a terminal window (undefined: none known). */
export function runnerInstallHint(runner: 'npx' | 'uvx', platform: string = process.platform): string | undefined {
  if (platform === 'darwin') return runner === 'npx' ? 'brew install node' : 'brew install uv';
  if (platform === 'win32') return runner === 'npx' ? 'winget install -e --id OpenJS.NodeJS.LTS' : 'winget install -e --id astral-sh.uv';
  return runner === 'uvx' ? 'curl -LsSf https://astral.sh/uv/install.sh | sh' : undefined;
}
/** A monochrome SVG as the registry requires; anything else is dropped (it is only ever drawn as a CSS mask). */
const cleanSvg = (text: string): string | undefined => {
  const t = text.trim();
  return t.length <= MAX_ICON_BYTES && /^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(t) && /<\/svg>$/i.test(t) ? t : undefined;
};

export class AcpRegistryService {
  private cache: Cache | undefined;
  private loading: Promise<Cache> | undefined;
  /** installs under way, by registry id */
  private adding = new Map<string, Promise<Provider>>();

  constructor(private ctx: CoreCtx) {}

  private get file(): string { return join(this.ctx.paths.dataDir, 'acp-registry.json'); }
  private get fetchFn(): typeof fetch { return this.ctx.deps.fetch ?? fetch; }
  private get runner(): PackageRunner { return { ...defaultRunner, ...this.ctx.deps.packageRunner }; }

  private readCache(): Cache | undefined {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Cache>;
      const entries = (raw.entries ?? []).flatMap((e) => { const r = EntrySchema.safeParse(e); return r.success ? [r.data] : []; });
      this.cache = { fetchedAt: raw.fetchedAt ?? 0, entries, icons: raw.icons ?? {} };
    } catch { /* none yet */ }
    return this.cache;
  }

  /** Fetch the registry (and the icons not cached yet); entries that don't parse are skipped. */
  private async fetchRegistry(): Promise<Cache> {
    const res = await this.fetchFn(REGISTRY_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`The ACP registry answered ${res.status}`);
    const body = z.object({ agents: z.array(z.unknown()) }).parse(await res.json());
    const entries: Entry[] = [];
    for (const raw of body.agents) {
      const r = EntrySchema.safeParse(raw);
      if (r.success) entries.push(r.data);
      else this.ctx.log.debug(`acp registry: skipped an entry (${(raw as { id?: unknown })?.id ?? '?'})`);
    }
    const old = this.readCache()?.icons ?? {};
    const icons: Record<string, string> = {};
    await Promise.all(entries.map(async (e) => {
      if (!e.icon?.startsWith('https://')) return;
      if (old[e.icon]) { icons[e.icon] = old[e.icon]!; return; }
      try {
        const r = await this.fetchFn(e.icon, { signal: AbortSignal.timeout(10_000) });
        const svg = r.ok ? cleanSvg(await r.text()) : undefined;
        if (svg) icons[e.icon] = svg;
      } catch { /* drawn with initials */ }
    }));
    const cache: Cache = { fetchedAt: Date.now(), entries, icons };
    this.cache = cache;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(cache));
    } catch (e) {
      this.ctx.log.warn('acp registry: could not save the cache', errMsg(e));
    }
    return cache;
  }

  private async load(refresh: boolean): Promise<Cache> {
    const cached = this.readCache();
    if (!refresh && cached && Date.now() - cached.fetchedAt < FRESH_MS) return cached;
    this.loading ??= this.fetchRegistry().finally(() => { this.loading = undefined; });
    return this.loading;
  }

  /** The catalog: the registry's agents that can run here, each with what it is to this Mac (built in, added). */
  async list(refresh = false): Promise<{ agents: RegistryAgent[]; fetchedAt?: number; error?: string }> {
    let cache: Cache | undefined;
    let error: string | undefined;
    try {
      cache = await this.load(refresh);
    } catch (e) {
      error = `Could not reach the ACP registry: ${errMsg(e)}`;
      this.ctx.log.warn('acp registry: fetch failed', errMsg(e));
      cache = this.readCache();
    }
    const saved = this.ctx.store.providers.get();
    const agents = (cache?.entries ?? []).flatMap((e): RegistryAgent[] => {
      const how = chooseInstall(e);
      if (!how) return [];
      const added = saved.find((p) => p.registry?.id === e.id);
      const iconSvg = e.icon ? cache?.icons[e.icon] : undefined;
      return [{
        id: e.id, name: e.name, version: e.version, description: e.description ?? '',
        ...(e.website ? { website: e.website } : {}), ...(e.repository ? { repository: e.repository } : {}),
        ...(iconSvg ? { iconSvg } : {}),
        install: how.kind,
        ...(BUILTIN_OF[e.id] ? { builtinId: BUILTIN_OF[e.id] } : {}),
        ...(added ? { providerId: added.id, installedVersion: added.registry!.version } : {}),
      }];
    });
    return { agents, ...(cache?.fetchedAt ? { fetchedAt: cache.fetchedAt } : {}), ...(error ? { error } : {}) };
  }

  /** Each entry's version in the registry (the cached copy unless `refresh`); throws when there is no copy at all. */
  async latestVersions(refresh = false): Promise<Map<string, string>> {
    let cache: Cache | undefined;
    try {
      cache = await this.load(refresh);
    } catch (e) {
      cache = this.readCache();
      if (!cache) throw e;
    }
    return new Map(cache.entries.map((e) => [e.id, e.version]));
  }

  /**
   * Add a registry agent (or bring an added one to the registry's version): install it, save it as a custom agent
   * (keeping its on/off switch), then start it once in the background to learn its logins.
   */
  add(id: string): Promise<Provider> {
    let p = this.adding.get(id);
    if (!p) {
      p = this.doAdd(id).finally(() => this.adding.delete(id));
      this.adding.set(id, p);
    }
    return p;
  }

  private async doAdd(id: string): Promise<Provider> {
    const cache = await this.load(false).catch(() => this.readCache());
    const entry = cache?.entries.find((e) => e.id === id);
    if (!entry) throw notFound('Registry agent', id);
    if (BUILTIN_OF[id]) throw new RpcError('invalid_params', `${entry.name} is built into AppuBot: turn it on in Settings › Agents.`);
    const how = chooseInstall(entry);
    if (!how) throw new RpcError('invalid_params', `${entry.name} has no build for this ${machineName(process.platform)}.`);
    const saved = this.ctx.store.providers.get();
    const prev = saved.find((p) => p.id === entry.id);
    if (prev && prev.registry?.id !== entry.id) throw new RpcError('invalid_params', `You already have an agent with the id "${entry.id}".`);
    if (this.ctx.runtime.getProviders().some((s) => s.id === entry.id && s.builtin)) throw new RpcError('invalid_params', `${entry.name} is built into AppuBot.`);

    let launch: Pick<ProviderSpec, 'command' | 'args' | 'env' | 'installHint'>;
    if (how.kind === 'binary') {
      const command = await this.installBinary(entry, how.binary);
      launch = { command, args: how.binary.args ?? [], env: how.binary.env ?? {} };
    } else {
      const command = await this.installPackage(entry, how.kind, how.pkg.package);
      launch = { command, args: how.pkg.args ?? [], env: how.pkg.env ?? {} };
    }
    const iconSvg = entry.icon ? cache?.icons[entry.icon] : undefined;
    const spec: ProviderSpec = {
      id: entry.id, name: entry.name, description: entry.description ?? '', ...launch, icon: 'bot',
      enabled: prev?.enabled ?? true, registry: { id: entry.id, version: entry.version }, ...(iconSvg ? { iconSvg } : {}),
    };
    this.ctx.log.info(`acp registry: ${prev ? 'updated' : 'added'} ${entry.id} ${entry.version} (${how.kind})`);
    return this.ctx.s.providers.saveRegistryAgent(spec);
  }

  /** Download, check and unpack an agent's build; returns its command's absolute path. Older versions are removed. */
  private async installBinary(entry: Entry, b: z.infer<typeof Binary>): Promise<string> {
    const root = join(this.ctx.paths.dataDir, 'agents', entry.id);
    const dir = join(root, entry.version);
    const inside = (base: string) => {
      const p = resolve(base, b.cmd);
      if (!p.startsWith(base + sep)) throw new RpcError('invalid_params', `${entry.name}'s command is outside its folder.`);
      return p;
    };
    const command = inside(dir);
    if (!existsSync(command)) {
      const partial = `${dir}.partial`;
      rmSync(partial, { recursive: true, force: true });
      mkdirSync(partial, { recursive: true });
      try {
        const file = join(partial, '.download');
        await this.download(b.archive, file, b.sha256, entry.name);
        const cmd = inside(partial);
        if (isArchive(b.archive)) {
          await unpack(b.archive, file, partial, entry.name);
          rmSync(file, { force: true });
        } else {
          mkdirSync(dirname(cmd), { recursive: true });
          renameSync(file, cmd);
        }
        if (!existsSync(cmd)) throw new RpcError('internal', `${entry.name}'s download has no ${b.cmd}.`);
        chmodSync(cmd, 0o755);
        rmSync(dir, { recursive: true, force: true });
        renameSync(partial, dir);
      } catch (e) {
        rmSync(partial, { recursive: true, force: true });
        if (!readdirSync(root).length) rmSync(root, { recursive: true, force: true });
        throw e;
      }
    }
    this.dropOldVersions(entry);
    return command;
  }

  /**
   * Install an `npx` entry's npm package or a `uvx` entry's Python package at its pinned version into the agent's own
   * folder (`npm install --global --prefix …`, `uv tool install` with its tool and bin folders there), once; returns
   * the command it provides. Installed in place (a venv's scripts name their own absolute path), its folder removed
   * when the install fails, and reused only once it finished.
   */
  private async installPackage(entry: Entry, kind: 'npx' | 'uvx', spec: string): Promise<string> {
    const tool = kind === 'npx' ? 'npm' : 'uv';
    const dir = join(this.ctx.paths.dataDir, 'agents', entry.id, entry.version);
    const name = packageName(spec);
    const find = () => (kind === 'npx' ? npmBin(join(dir, 'npm'), name, entry.id) : uvBin(join(dir, 'uv', 'bin'), name, entry.id));
    const ready = existsSync(join(dir, INSTALLED_MARK)) ? find() : undefined;
    if (ready) {
      this.dropOldVersions(entry);
      return ready;
    }
    const exe = await this.runner.which(tool);
    if (!exe) {
      const hint = runnerInstallHint(kind);
      const what = kind === 'npx' ? 'npm, which comes with Node.js' : "uv, Python's package manager";
      throw new RpcError('invalid_params', `${entry.name} installs with ${what}. Install ${kind === 'npx' ? 'Node.js' : 'uv'}${hint ? ` (${hint})` : ''}, then add it again.`);
    }
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const res = kind === 'npx'
      ? await this.runner.run(exe, ['install', '--global', '--prefix', join(dir, 'npm'), '--no-audit', '--no-fund', '--loglevel=error', spec], { npm_config_update_notifier: 'false' }, PACKAGE_INSTALL_MS)
      : await this.runner.run(exe, ['tool', 'install', '--force', uvSpec(spec)], { UV_TOOL_DIR: join(dir, 'uv', 'tools'), UV_TOOL_BIN_DIR: join(dir, 'uv', 'bin'), UV_NO_PROGRESS: '1' }, PACKAGE_INSTALL_MS);
    const command = res.ok ? find() : undefined;
    if (!command) {
      rmSync(dir, { recursive: true, force: true });
      const root = dirname(dir);
      if (existsSync(root) && !readdirSync(root).length) rmSync(root, { recursive: true, force: true });
      const why = res.output.split('\n').filter((l) => l.trim()).slice(-3).join(' ').slice(0, 400);
      throw new RpcError('internal', res.ok ? `${entry.name}'s package has no command to run.` : `Could not install ${entry.name} with ${tool}${why ? `: ${why}` : '.'}`);
    }
    writeFileSync(join(dir, INSTALLED_MARK), `${spec}\n`);
    this.dropOldVersions(entry);
    return command;
  }

  /** Remove the agent's other versions (best effort: a running one may hold its files on Windows). */
  private dropOldVersions(entry: Entry): void {
    const root = join(this.ctx.paths.dataDir, 'agents', entry.id);
    let versions: string[] = [];
    try { versions = readdirSync(root); } catch { return; }
    for (const v of versions) {
      if (v === entry.version) continue;
      try { rmSync(join(root, v), { recursive: true, force: true }); } catch (e) { this.ctx.log.warn(`acp registry: could not remove ${entry.id} ${v}`, errMsg(e)); }
    }
  }

  private async download(url: string, file: string, sha256: string | undefined, name: string): Promise<void> {
    const res = await this.fetchFn(url, { signal: AbortSignal.timeout(DOWNLOAD_MS) });
    if (!res.ok || !res.body) throw new RpcError('internal', `Could not download ${name} (${res.status}).`);
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > MAX_DOWNLOAD_BYTES) return done(new Error('download too large'));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), meter, createWriteStream(file));
    const got = hash.digest('hex');
    if (sha256 && got.toLowerCase() !== sha256.toLowerCase()) {
      throw new RpcError('internal', `${name}'s download doesn't match the registry's checksum, so it was not installed.`);
    }
  }
}
