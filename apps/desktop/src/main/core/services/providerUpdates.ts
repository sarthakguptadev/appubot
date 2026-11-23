/**
 * Provider updates: is a newer version of an agent out, and installing it (like Synara's and T3 Code's "update
 * available"). What is compared:
 * - built-ins with a CLI of their own on PATH (Claude Code, Codex, Copilot, OpenCode): that CLI's `--version` against
 *   npm's `latest` for its package, or Homebrew's version when Homebrew installed it. The ACP adapters that drive
 *   Claude Code's and Codex's CLIs come with AppuBot; the CLIs don't, so one not on PATH isn't installed yet.
 * - agents added from the ACP registry: the version they run against the registry's (updated through its download path).
 * Results (the newest versions) are cached in `<dataDir>/provider-updates.json` for most of an hour; the check runs
 * shortly after launch, every hour, and on demand (`providers.checkUpdates`, which always fetches again).
 */
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { directExecutable, getPathString, killTree, probeVersion, resolveExecutable, spawnCommand, withPath, type ProviderSpec } from '@appubot/agent-runtime';
import type { Provider, ProviderUpdate } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { errMsg, notFound, RpcError } from '../util';

export const NPM_REGISTRY = 'https://registry.npmjs.org';
export const BREW_API = 'https://formulae.brew.sh/api';
/**
 * A newest version fetched this recently is used as is (a forced check fetches again). Just under the check's period,
 * so every hourly check asks npm / Homebrew / the registry once: a new CLI version reaches the app's notice within the
 * hour (the notice: renderer `features/providers/agentUpdates.ts`).
 */
const FRESH_MS = 55 * 60_000;
const CHECK_EVERY_MS = 60 * 60_000;
/** The first check waits for the launch's own provider refresh. */
const FIRST_CHECK_MS = 30_000;
const UPDATE_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT = 4000;

/** A built-in's own CLI: its command, npm package, Homebrew name and its own updater (if it has one). */
export interface CliUpdate { cli: string; pkg: string; brew?: string; self?: string[] }
export const CLI_UPDATES: Record<string, CliUpdate> = {
  'claude-code': { cli: 'claude', pkg: '@anthropic-ai/claude-code', brew: 'claude-code', self: ['update'] },
  codex: { cli: 'codex', pkg: '@openai/codex', brew: 'codex' },
  copilot: { cli: 'copilot', pkg: '@github/copilot', brew: 'copilot-cli' },
  // `opencode upgrade` knows every way it is installed (curl, npm, brew…)
  opencode: { cli: 'opencode', pkg: 'opencode-ai', self: ['upgrade'] },
};

/* ---------- versions ---------- */

/** "v2.0.14 (Claude Code)" → { nums: [2, 0, 14], pre: [] }; undefined when there is no number to compare. */
function parseVersion(v: string): { nums: number[]; pre: string[] } | undefined {
  const m = v.trim().match(/(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return undefined;
  return { nums: m[1]!.split('.').map(Number), pre: m[2] ? m[2].split('.') : [] };
}

/** Semver-ish order (any number of numeric parts, prereleases before their release): <0, 0 or >0. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (!x.pre.length || !y.pre.length) return x.pre.length ? -1 : y.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) { const d = Number(p) - Number(q); if (d) return Math.sign(d); continue; }
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** `latest` is a newer version than `current` (false when either can't be read). */
export function isNewer(latest: string | undefined, current: string | undefined): boolean {
  if (!latest || !current || !parseVersion(latest) || !parseVersion(current)) return false;
  return compareVersions(latest, current) > 0;
}

/* ---------- how a CLI updates ---------- */

export type InstallKind = 'brew-cask' | 'brew-formula' | 'npm' | 'other';

/** How the CLI at `realPath` (symlinks resolved; a Windows npm shim's target) was installed. */
export function installKind(realPath: string): InstallKind {
  const p = realPath.replace(/\\/g, '/');
  if (p.includes('/Caskroom/')) return 'brew-cask';
  if (p.includes('/Cellar/')) return 'brew-formula';
  if (p.includes('/node_modules/')) return 'npm';
  return 'other';
}

/** The command that updates it: Homebrew for Homebrew installs, else its own updater, else npm for npm installs. */
export function updateCommand(u: CliUpdate, kind: InstallKind, bin: string): { command: string; args: string[]; label: string } | undefined {
  if ((kind === 'brew-cask' || kind === 'brew-formula') && u.brew) return { command: 'brew', args: ['upgrade', u.brew], label: `brew upgrade ${u.brew}` };
  if (u.self) return { command: bin, args: u.self, label: [u.cli, ...u.self].join(' ') };
  if (kind === 'npm') return { command: 'npm', args: ['i', '-g', `${u.pkg}@latest`], label: `npm i -g ${u.pkg}@latest` };
  return undefined;
}

/** Where the newest version of a CLI installed this way is published. */
export function latestSource(u: CliUpdate, kind: InstallKind): { url: string; pick: (body: unknown) => unknown } {
  if (kind === 'brew-cask' && u.brew) return { url: `${BREW_API}/cask/${u.brew}.json`, pick: (b) => (b as { version?: unknown })?.version };
  if (kind === 'brew-formula' && u.brew) return { url: `${BREW_API}/formula/${u.brew}.json`, pick: (b) => (b as { versions?: { stable?: unknown } })?.versions?.stable };
  return { url: `${NPM_REGISTRY}/${u.pkg}/latest`, pick: (b) => (b as { version?: unknown })?.version };
}

/* ---------- the service ---------- */

/** What the service does to the computer (swapped in tests through `deps.updateIo`). */
export interface UpdateIo {
  /** the CLI on PATH: where it is (`bin`), its real path (symlinks resolved) and its `--version`; undefined when absent */
  cli(name: string): Promise<{ bin: string; realPath: string; version?: string } | undefined>;
  /** run an update command to the end (login-shell PATH, no stdin) */
  run(command: string, args: string[]): Promise<{ ok: boolean; output: string }>;
}

const tail = (s: string) => (s.length > MAX_OUTPUT ? `…${s.slice(-MAX_OUTPUT)}` : s).trim();

export const defaultUpdateIo: UpdateIo = {
  async cli(name) {
    const bin = await resolveExecutable(name);
    if (!bin) return undefined;
    // Windows: npm's `claude.cmd` is a shim; what it runs (…\node_modules\…\cli.js) tells how it was installed
    let realPath = directExecutable(bin) ?? bin;
    try { realPath = realpathSync(realPath); } catch { /* keep the link */ }
    const version = await probeVersion(bin, 10_000);
    return { bin, realPath, ...(version ? { version } : {}) };
  },
  async run(command, args) {
    const PATH = await getPathString();
    const exe = command.includes('/') || isAbsolute(command) ? command : (await resolveExecutable(command)) ?? command;
    // detached, its output to a file rather than a pipe: an app restart midway (or a dev reload) would otherwise
    // kill the install (brew writing to a closed pipe dies), leaving it half done. The install finishes on its own
    // and the next check reads the new version.
    const dir = mkdtempSync(join(tmpdir(), 'appubot-update-'));
    const log = join(dir, 'output.log');
    const fd = openSync(log, 'w');
    const read = () => { try { return tail(readFileSync(log, 'utf8')); } catch { return ''; } };
    const done = (r: { ok: boolean; output: string }) => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } return r; };
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawnCommand>;
      try {
        // detached on Windows too (with no console window): the install outlives the app there as well
        child = spawnCommand(exe, args, {
          detached: true, stdio: ['ignore', fd, fd],
          env: { ...withPath(process.env, PATH), CI: '1', HOMEBREW_NO_ENV_HINTS: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1' },
        });
      } catch (e) { closeSync(fd); resolve(done({ ok: false, output: errMsg(e) })); return; }
      closeSync(fd);
      const timer = setTimeout(() => killTree(child, 'SIGTERM'), UPDATE_TIMEOUT_MS);
      child.on('error', (e) => { clearTimeout(timer); resolve(done({ ok: false, output: read() || errMsg(e) })); });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        const out = read();
        resolve(done({ ok: code === 0, output: out || (code === 0 ? '' : signal ? `Stopped (${signal})` : `Exited with code ${code}`) }));
      });
    });
  },
};

interface Entry {
  /** the CLI's own version (registry agents: their spec's `registry.version` is read live instead) */
  current?: string;
  latest?: string;
  checkedAt?: number;
  via?: string;
  run?: { command: string; args: string[] };
  error?: string;
}
interface LatestCache { [url: string]: { version: string; fetchedAt: number } }

export class ProviderUpdatesService {
  private entries = new Map<string, Entry>();
  private running = new Map<string, Promise<{ ok: boolean; output: string; message?: string }>>();
  private latest: LatestCache | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** Homebrew runs one at a time: two `brew upgrade`s at once wait on (or fail at) its lock. */
  private brew: Promise<unknown> = Promise.resolve();
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(private ctx: CoreCtx) {}

  private get io(): UpdateIo { return { ...defaultUpdateIo, ...this.ctx.deps.updateIo }; }
  private get fetchFn(): typeof fetch { return this.ctx.deps.fetch ?? fetch; }
  private get file(): string { return join(this.ctx.paths.dataDir, 'provider-updates.json'); }

  /** Check shortly after launch, then every hour. */
  start(): void {
    const tick = () => void this.check().catch((e) => this.ctx.log.warn('provider update check failed', errMsg(e)));
    const first = setTimeout(tick, FIRST_CHECK_MS);
    const every = setInterval(tick, CHECK_EVERY_MS);
    first.unref?.();
    every.unref?.();
    this.timers.push(first, every as unknown as ReturnType<typeof setTimeout>);
  }

  stop(): void {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t as unknown as ReturnType<typeof setInterval>); }
    this.timers = [];
  }

  /** The update fields of a provider (merged in by ProvidersService.list). */
  fields(spec: ProviderSpec): Pick<Provider, 'latestVersion' | 'updateAvailable' | 'update'> | Record<string, never> {
    const e = this.entries.get(spec.id);
    if (!e) return {};
    const current = spec.registry?.version ?? e.current;
    const running = this.running.has(spec.id);
    const update: ProviderUpdate = {
      running,
      ...(current ? { current } : {}), ...(e.checkedAt ? { checkedAt: e.checkedAt } : {}),
      ...(e.via ? { via: e.via } : {}), ...(e.error ? { error: e.error } : {}),
    };
    return { ...(e.latest ? { latestVersion: e.latest } : {}), updateAvailable: isNewer(e.latest, current), update };
  }

  /**
   * Look for newer versions of all (or some) agents and push the list. `force` fetches the newest versions again;
   * otherwise ones fetched in the last few hours are reused (the installed versions are always read again).
   */
  check(ids?: string[], force = false): Promise<Provider[]> {
    const run = this.queue.then(() => this.doCheck(ids, force));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doCheck(ids: string[] | undefined, force: boolean): Promise<Provider[]> {
    let specs: ProviderSpec[] = [];
    try { specs = this.ctx.runtime.getProviders(); } catch { /* none */ }
    if (ids) specs = specs.filter((s) => ids.includes(s.id));
    let registry: Map<string, string> | undefined;
    let registryError: string | undefined;
    if (specs.some((s) => s.registry)) {
      try { registry = await this.ctx.s.acpRegistry.latestVersions(force); } catch (e) { registryError = errMsg(e); }
    }
    await Promise.all(specs.map(async (spec) => {
      try {
        if (spec.registry) this.checkRegistry(spec, registry, registryError);
        else await this.checkCli(spec, force);
      } catch (e) {
        this.ctx.log.warn(`update check for ${spec.id} failed`, errMsg(e));
        const prev = this.entries.get(spec.id);
        if (prev) this.entries.set(spec.id, { ...prev, checkedAt: Date.now(), error: `Couldn't check for updates: ${errMsg(e)}` });
      }
    }));
    // agents no longer around
    const known = new Set(this.ctx.runtime.getProviders().map((s) => s.id));
    for (const id of this.entries.keys()) if (!known.has(id)) this.entries.delete(id);
    const list = this.ctx.s.providers.list();
    this.ctx.bus.emit('providers.updated', list);
    return list;
  }

  private checkRegistry(spec: ProviderSpec, registry: Map<string, string> | undefined, error: string | undefined): void {
    const prev = this.entries.get(spec.id);
    const latest = registry?.get(spec.registry!.id);
    this.entries.set(spec.id, {
      latest: latest ?? prev?.latest, checkedAt: Date.now(), via: 'the ACP registry',
      ...(error ? { error: `Couldn't reach the ACP registry: ${error}` } : {}),
    });
  }

  private async checkCli(spec: ProviderSpec, force: boolean): Promise<void> {
    const u = CLI_UPDATES[spec.id];
    if (!u || !spec.builtin) return;
    const cli = await this.io.cli(u.cli);
    // not on PATH: not installed
    if (!cli) { this.entries.delete(spec.id); return; }
    const kind = installKind(cli.realPath);
    const how = updateCommand(u, kind, cli.bin);
    const prev = this.entries.get(spec.id);
    const base: Entry = {
      checkedAt: Date.now(),
      ...(cli.version ? { current: cli.version } : {}),
      ...(how ? { via: how.label, run: { command: how.command, args: how.args } } : {}),
    };
    try {
      const latest = await this.fetchLatest(latestSource(u, kind), force);
      this.entries.set(spec.id, { ...base, latest });
    } catch (e) {
      this.entries.set(spec.id, { ...base, ...(prev?.latest ? { latest: prev.latest } : {}), error: `Couldn't check for updates: ${errMsg(e)}` });
    }
  }

  private readLatest(): LatestCache {
    if (this.latest) return this.latest;
    try { this.latest = JSON.parse(readFileSync(this.file, 'utf8')) as LatestCache; } catch { this.latest = {}; }
    return this.latest;
  }

  private async fetchLatest(src: { url: string; pick: (body: unknown) => unknown }, force: boolean): Promise<string> {
    const cache = this.readLatest();
    const hit = cache[src.url];
    if (!force && hit && Date.now() - hit.fetchedAt < FRESH_MS) return hit.version;
    const res = await this.fetchFn(src.url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${new URL(src.url).host} answered ${res.status}`);
    const version = src.pick(await res.json());
    if (typeof version !== 'string' || !/^[\w.+-]{1,64}$/.test(version)) throw new Error(`${new URL(src.url).host} gave no version`);
    cache[src.url] = { version, fetchedAt: Date.now() };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(cache));
    } catch (e) {
      this.ctx.log.warn('provider updates: could not save the cache', errMsg(e));
    }
    return version;
  }

  /** Update an agent to its newest version, then re-check it. One at a time per agent (a second call joins the first). */
  update(id: string): Promise<{ ok: boolean; output: string; message?: string }> {
    let p = this.running.get(id);
    if (!p) {
      p = this.doUpdate(id).finally(() => {
        this.running.delete(id);
        const out = this.ctx.s.providers.list().find((x) => x.id === id);
        if (out) this.ctx.bus.emit('provider.updated', out);
      });
      this.running.set(id, p);
      const now = this.ctx.s.providers.list().find((x) => x.id === id);
      if (now) this.ctx.bus.emit('provider.updated', now);
    }
    return p;
  }

  private async doUpdate(id: string): Promise<{ ok: boolean; output: string; message?: string }> {
    const spec = this.ctx.runtime.getProviders().find((s) => s.id === id);
    if (!spec) throw notFound('Provider', id);
    if (!this.entries.has(id)) await this.doCheck([id], false);
    const e = this.entries.get(id);
    if (!e) throw new RpcError('invalid_params', `AppuBot can't update ${spec.name}.`);
    const from = spec.registry?.version ?? e.current;
    let ok: boolean;
    let output: string;
    if (spec.registry) {
      try {
        // the registry's newest build, through the same path as adding it (download, checksum, unpack, re-probe)
        await this.ctx.s.acpRegistry.add(spec.registry.id);
        ok = true;
        output = '';
      } catch (err) {
        ok = false;
        output = errMsg(err);
      }
    } else if (e.run) {
      this.ctx.log.info(`provider update: ${id}: ${e.via}`);
      const run = e.run;
      const go = () => this.io.run(run.command, run.args);
      const job = run.command === 'brew' ? this.brew.then(go) : go();
      if (run.command === 'brew') this.brew = job.catch(() => undefined);
      ({ ok, output } = await job);
    } else {
      return { ok: false, output: '', message: `AppuBot can't tell how ${spec.name} was installed. Update it the way you installed it, then check again.` };
    }
    if (!ok) this.ctx.log.warn(`provider update of ${id} failed`, output.slice(-500));
    // read the installed version again (and the login: a new CLI can ask for one)
    if (!spec.registry) await this.ctx.s.providers.refresh([id]).catch(() => undefined);
    await this.doCheck([id], false).catch(() => undefined);
    const after = this.entries.get(id);
    const now = this.ctx.runtime.getProviders().find((s) => s.id === id)?.registry?.version ?? after?.current;
    if (after) {
      const { error: _drop, ...rest } = after;
      this.entries.set(id, ok ? rest : { ...rest, error: `Update failed: ${(output.split('\n').filter(Boolean).pop() ?? 'no output').slice(0, 300)}` });
    }
    if (!ok) return { ok, output, message: `Could not update ${spec.name}.` };
    if (after && isNewer(after.latest, now)) {
      return { ok: true, output, message: `${spec.name} is at ${now ?? 'an unknown version'} after the update; ${after.latest} may not have reached ${after.via ?? 'its installer'} yet.` };
    }
    return { ok: true, output, message: from && now && from !== now ? `${spec.name} updated from ${from} to ${now}.` : `${spec.name} is up to date${now ? ` (${now})` : ''}.` };
  }
}
