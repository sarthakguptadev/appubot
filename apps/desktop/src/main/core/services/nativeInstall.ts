/**
 * Installing an agent's own program by itself, on a person's computer, with nothing else needed there: no Node, no
 * npm, no Homebrew, no terminal. Codex, GitHub Copilot and OpenCode publish their native programs as one npm package
 * per platform (a tarball holding the program, no JavaScript to run), so AppuBot reads the right one's record from the npm registry, downloads
 * the tarball, checks it against the registry's sha512, unpacks it with the system's `tar` into
 * `<dir>/<version>/` and links it as `~/.local/bin/<command>`, one of the places the runtime looks for agents after
 * the person's own PATH. An agent the person installed themselves is found first and nothing here runs.
 *
 * Which package and where its program sits (`agentBuild`), for macOS, Linux and Windows on x64 and arm64:
 * - OpenCode 2: `@opencode/cli-<os>-<arch>`, `bin/opencode`; x64 gets the `-baseline` build (it runs on processors
 *   without AVX2 too).
 * - Codex: `@openai/codex` at its platform's dist-tag (`win32-x64`, `darwin-arm64`…: versions like
 *   `0.172.0-win32-x64`), `vendor/<target triple>/bin/codex` beside the resources it loads from there.
 * - GitHub Copilot: `@github/copilot-<os>-<arch>` (`linuxmusl` on a musl Linux), `copilot` at the package's root.
 *
 * On Windows the link is a `.cmd` shim naming the `.exe` by its full path (a symlink needs a privilege most accounts
 * don't have, and a hard link would move the program away from its resources); agent-runtime reads the shim back to
 * start the `.exe` itself (`parseCmdShim`). The archive is unpacked with Windows' own `tar.exe` from System32 by its
 * full path, since a Git for Windows `tar` earlier on PATH reads `C:\…` as a remote host.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, chmodSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, win32 } from 'node:path';
import { quietInstall } from './cloudInstall';

const REGISTRY = 'https://registry.npmjs.org';
/** nothing this big is a CLI: a wrong link or a hostile answer stops here */
const TARBALL_MAX = 600 * 1024 * 1024;
const META_TIMEOUT_MS = 30_000;
/** the whole download: a slow line still gets it, a dead one doesn't hang the service forever */
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
const INSTALLED_MARK = '.installed';

/** The agents AppuBot can download by themselves. */
export type NativeAgent = 'codex' | 'copilot' | 'opencode';
export const NATIVE_AGENTS: readonly NativeAgent[] = ['codex', 'copilot', 'opencode'];

/** What to download for an agent on one platform: the package, its version or dist-tag, and its program inside. */
export interface AgentBuild {
  agent: NativeAgent;
  /** shown in messages */
  name: string;
  pkg: string;
  tag: string;
  /** the program, relative to the unpacked package (`/`-separated) */
  bin: string;
  /** the name the runtime looks for on PATH */
  command: string;
}

const CODEX_TRIPLES: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
};

/** the npm package holding OpenCode for this platform, or undefined where OpenCode has none */
export function openCodePackage(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : platform === 'win32' ? 'windows' : undefined;
  if (!os) return undefined;
  if (arch === 'arm64') return `@opencode/cli-${os}-arm64`;
  if (arch === 'x64') return `@opencode/cli-${os}-x64-baseline`;
  return undefined;
}

/** This Linux runs on musl (Alpine and the like) rather than glibc: Node's report names no glibc then. */
export function muslLinux(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'linux') return false;
  try {
    const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
    return !!header && !header.glibcVersionRuntime;
  } catch {
    return false;
  }
}

/** The build of `agent` for this platform and processor, or undefined where its maker publishes none. */
export function agentBuild(agent: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch, musl = muslLinux(platform)): AgentBuild | undefined {
  const exe = (name: string) => (platform === 'win32' ? `${name}.exe` : name);
  const known = ['linux', 'darwin', 'win32'].includes(platform) && ['x64', 'arm64'].includes(arch);
  if (agent === 'opencode') {
    const pkg = openCodePackage(platform, arch);
    return pkg ? { agent, name: 'OpenCode', pkg, tag: 'latest', bin: `bin/${exe('opencode')}`, command: 'opencode' } : undefined;
  }
  if (agent === 'codex') {
    const target = `${platform}-${arch}`;
    const triple = CODEX_TRIPLES[target];
    return triple ? { agent, name: 'Codex', pkg: '@openai/codex', tag: target, bin: `vendor/${triple}/bin/${exe('codex')}`, command: 'codex' } : undefined;
  }
  if (agent === 'copilot') {
    return known ? { agent, name: 'GitHub Copilot', pkg: `@github/copilot-${musl ? 'linuxmusl' : platform}-${arch}`, tag: 'latest', bin: exe('copilot'), command: 'copilot' } : undefined;
  }
  return undefined;
}

/** where a package's record is read (a scoped name's slash escaped) */
export const packageUrl = (pkg: string, version = 'latest'): string => `${REGISTRY}/${pkg.replace('/', '%2f')}/${version}`;

export interface PackageRecord { version: string; tarball: string; integrity: string }

/** What the registry says of a package version: only an https tarball on the registry itself with a sha512 is taken. */
export function readPackageRecord(body: unknown): PackageRecord | undefined {
  const d = body as { version?: unknown; dist?: { tarball?: unknown; integrity?: unknown } } | null;
  const version = typeof d?.version === 'string' && /^\d+\.\d+\.\d+[\w.+-]*$/.test(d.version) ? d.version : undefined;
  const tarball = typeof d?.dist?.tarball === 'string' ? d.dist.tarball : '';
  const integrity = typeof d?.dist?.integrity === 'string' ? d.dist.integrity : '';
  if (!version || !tarball.startsWith(`${REGISTRY}/`) || !/^sha512-[A-Za-z0-9+/]+=*$/.test(integrity)) return undefined;
  return { version, tarball, integrity };
}

export interface NativeInstallOptions {
  /** the agent's own folder, `<dataDir>/agents/<agent>` (OpenCode's: `<dataDir>/free-agent`) */
  dir: string;
  /** the person's home (its `.local/bin` gets the link) */
  home: string;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  log?: (line: string) => void;
}

export interface NativeInstallResult { ok: boolean; output: string; version?: string; bin?: string }

/** the program inside an unpacked version folder */
export const programIn = (versionDir: string, build: Pick<AgentBuild, 'bin'>): string => join(versionDir, ...build.bin.split('/'));
/** the link the runtime finds */
export const linkFor = (home: string, command: string, platform: NodeJS.Platform = process.platform): string => join(home, '.local', 'bin', platform === 'win32' ? `${command}.cmd` : command);

/** The `.cmd` that runs `exe` with its arguments: its full path quoted (spaces), `%` doubled (cmd expands it). */
export function cmdShim(exe: string): string {
  return `@echo off\r\n"${exe.replace(/%/g, '%%')}" %*\r\n`;
}

/** Download, check, unpack and link `agent`. Never throws: a failure says why in `output`. */
export async function installNativeAgent(agent: NativeAgent, o: NativeInstallOptions): Promise<NativeInstallResult> {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const say = o.log ?? (() => undefined);
  const build = agentBuild(agent, platform, arch);
  if (!build) return { ok: false, output: `${agent} has no build for this computer (${platform} ${arch}).` };
  const fetchFn = o.fetch ?? fetch;
  try {
    const meta = await fetchFn(packageUrl(build.pkg, build.tag), { signal: AbortSignal.timeout(META_TIMEOUT_MS) });
    if (!meta.ok) return { ok: false, output: `Couldn’t read ${build.name}’s latest version (${meta.status}).` };
    const record = readPackageRecord(await meta.json());
    if (!record) return { ok: false, output: `${build.name}’s package record couldn’t be read.` };
    const versionDir = join(o.dir, record.version);
    const bin = programIn(versionDir, build);
    if (!(existsSync(join(versionDir, INSTALLED_MARK)) && existsSync(bin))) {
      mkdirSync(o.dir, { recursive: true });
      const archive = join(o.dir, `${record.version}.tgz.part`);
      say(`downloading ${build.pkg}@${record.version}`);
      const sum = await download(fetchFn, record.tarball, archive, build.name);
      if (`sha512-${sum}` !== record.integrity) {
        rmSync(archive, { force: true });
        return { ok: false, output: `The ${build.name} download didn’t match its checksum; nothing was installed.` };
      }
      const staging = `${versionDir}.part`;
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      const unpacked = await untar(archive, staging, platform);
      rmSync(archive, { force: true });
      if (!unpacked.ok || !existsSync(programIn(staging, build))) {
        rmSync(staging, { recursive: true, force: true });
        return { ok: false, output: unpacked.output || `The ${build.name} download couldn’t be unpacked.` };
      }
      if (platform !== 'win32') chmodSync(programIn(staging, build), 0o755);
      writeFileSync(join(staging, INSTALLED_MARK), `${record.version}\n`);
      rmSync(versionDir, { recursive: true, force: true });
      renameSync(staging, versionDir);
    }
    const linked = link(bin, linkFor(o.home, build.command, platform), o.dir, platform);
    if (!linked.ok) return { ok: false, output: `${build.name} was downloaded but couldn’t be linked: ${linked.output}`, version: record.version };
    // older versions go, best effort (a session still running one keeps its open file)
    for (const name of safeList(o.dir)) {
      if (name === record.version) continue;
      try { rmSync(join(o.dir, name), { recursive: true, force: true }); } catch { /* next time */ }
    }
    return { ok: true, output: `${build.name} ${record.version} is installed.`, version: record.version, bin };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/** stream the tarball to `file`, answering its sha512 in base64 */
async function download(fetchFn: typeof fetch, url: string, file: string, name: string): Promise<string> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`The ${name} download failed (${res.status}).`);
  const tooBig = `The ${name} download is larger than expected; nothing was installed.`;
  if (Number(res.headers.get('content-length') ?? 0) > TARBALL_MAX) throw new Error(tooBig);
  const hash = createHash('sha512');
  const out = createWriteStream(file);
  let size = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > TARBALL_MAX) throw new Error(tooBig);
      hash.update(value);
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
    }
  } catch (e) {
    out.destroy();
    rmSync(file, { force: true });
    throw e;
  }
  await new Promise<void>((resolve, reject) => { out.once('error', reject); out.end(() => resolve()); });
  return hash.digest('base64');
}

/** The `tar` to unpack with: Windows 10+'s bsdtar in System32, by its full path; the system's own elsewhere. */
export function tarCommand(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') return win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'tar.exe');
  return existsSync('/usr/bin/tar') ? '/usr/bin/tar' : 'tar';
}

/** `tar -xzf`, the package's own folder stripped */
function untar(archive: string, into: string, platform: NodeJS.Platform): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(tarCommand(platform), ['-xzf', archive, '-C', into, '--strip-components=1'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ ok: false, output: e instanceof Error ? e.message : String(e) });
      return;
    }
    child.stderr?.on('data', (d: Buffer) => { output = (output + d.toString()).slice(-2000); });
    child.once('error', (e) => resolve({ ok: false, output: e.message }));
    child.once('exit', (code) => resolve({ ok: code === 0, output: output.trim() }));
  });
}

/**
 * `at` → the unpacked program. A link of ours (into `dir`) from an earlier version is replaced; anything else already
 * there (the person's own agent) is left alone, and counts as done: that one is the one that runs.
 */
function link(bin: string, at: string, dir: string, platform: NodeJS.Platform): { ok: boolean; output: string } {
  try {
    mkdirSync(join(at, '..'), { recursive: true });
    if (platform === 'win32') {
      writeFileSync(at, cmdShim(bin));
      return { ok: true, output: '' };
    }
    let existing: ReturnType<typeof lstatSync> | undefined;
    try { existing = lstatSync(at); } catch { existing = undefined; }
    if (existing) {
      if (!existing.isSymbolicLink() || !readlinkSync(at).startsWith(dir)) return { ok: true, output: '' };
      rmSync(at, { force: true });
    }
    symlinkSync(bin, at);
    return { ok: true, output: '' };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * How a person's own computer gets an agent installed from its row's Install:
 * - `download`: AppuBot downloads its maker's native program itself (`installNativeAgent`): Codex, Copilot and
 *   OpenCode, on every platform their makers build for;
 * - `installer`: a built-in's maker's own native installer, run in the background with no window (Claude Code's,
 *   Cursor's and Grok's: `irm … | iex` on Windows, `curl … | bash` elsewhere, `quietInstall`);
 * - `terminal`: the line in a terminal window (Homebrew, an added agent's own install line, npm where Node is there);
 * - `needs-node`: an npm line on a computer without Node.js, which would only fail in a terminal;
 * - `none`: no way is known.
 */
export type InstallRoute =
  | { kind: 'download'; agent: NativeAgent }
  | { kind: 'installer'; command: string; args: string[] }
  | { kind: 'terminal'; line: string }
  | { kind: 'needs-node'; line: string }
  | { kind: 'none' };

export interface InstallRouteOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  home: string;
  /** npm is on this computer's PATH */
  npm: boolean;
  /** one of AppuBot's own agents (an added agent's install line is the person's, shown in a terminal) */
  builtin: boolean;
}

/** The way `installRoute`'s doc names for an agent (`agent`: its base id) and its install line. */
export function installRoute(agent: string, installHint: string | undefined, o: InstallRouteOptions): InstallRoute {
  const platform = o.platform ?? process.platform;
  const hint = installHint?.trim();
  const native = o.builtin ? NATIVE_AGENTS.find((a) => a === agent) : undefined;
  if (native && agentBuild(native, platform, o.arch ?? process.arch)) return { kind: 'download', agent: native };
  if (!hint) return { kind: 'none' };
  if (hint.startsWith('brew ')) return { kind: 'terminal', line: hint };
  if (/^(npm|npx) /.test(hint)) return o.npm ? { kind: 'terminal', line: hint } : { kind: 'needs-node', line: hint };
  const quiet = o.builtin ? quietInstall(hint, o.home, platform) : undefined;
  return quiet ? { kind: 'installer', ...quiet } : { kind: 'terminal', line: hint };
}
