/**
 * Installing OpenCode by itself (the free agent, protocol `freeModels.ts`), on a person's own computer and on an
 * AppuBot Cloud one, with nothing else needed there: no Node, no npm, no Homebrew, no terminal.
 *
 * OpenCode 2 ships as one program per platform in npm packages (`@opencode/cli-<os>-<arch>`, a tarball holding
 * `package/bin/opencode`). OpenCode's own `install` script and the `opencode-ai` package only install OpenCode 1, and
 * `npm i -g @opencode/cli` needs npm, which most people's computers don't have. So this reads the package's record
 * from the npm registry, downloads its tarball (about 110 MB), checks it against the registry's sha512, unpacks it
 * with the system's `tar` into `<dataDir>/free-agent/<version>/` and links it as `~/.local/bin/opencode`, one of the
 * places the runtime looks for agents after the person's own PATH: an OpenCode they installed themselves is found
 * first and nothing here runs (`FreeAgentService` only installs where none is found).
 *
 * x64 gets the `-baseline` build (it runs on processors without AVX2 too). On Windows the link is a `.cmd` shim, since
 * a symlink needs a privilege most accounts don't have.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, chmodSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const REGISTRY = 'https://registry.npmjs.org';
/** nothing this big is a CLI: a wrong link or a hostile answer stops here */
const TARBALL_MAX = 600 * 1024 * 1024;
const META_TIMEOUT_MS = 30_000;
/** the whole download: a slow line still gets it, a dead one doesn't hang the service forever */
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
const INSTALLED_MARK = '.installed';

/** the npm package holding OpenCode for this platform, or undefined where OpenCode has none */
export function openCodePackage(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : platform === 'win32' ? 'windows' : undefined;
  if (!os) return undefined;
  if (arch === 'arm64') return `@opencode/cli-${os}-arm64`;
  if (arch === 'x64') return `@opencode/cli-${os}-x64-baseline`;
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

export interface FreeAgentInstallOptions {
  /** `<dataDir>/free-agent` */
  dir: string;
  /** the person's home (its `.local/bin` gets the link) */
  home: string;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  log?: (line: string) => void;
}

export interface FreeAgentInstallResult { ok: boolean; output: string; version?: string; bin?: string }

/** the program inside an unpacked version folder */
export const binaryIn = (versionDir: string, platform: NodeJS.Platform = process.platform): string => join(versionDir, 'bin', platform === 'win32' ? 'opencode.exe' : 'opencode');
/** the link the runtime finds */
export const linkPath = (home: string, platform: NodeJS.Platform = process.platform): string => join(home, '.local', 'bin', platform === 'win32' ? 'opencode.cmd' : 'opencode');

/** Download, check, unpack and link OpenCode. Never throws: a failure says why in `output`. */
export async function installFreeAgent(o: FreeAgentInstallOptions): Promise<FreeAgentInstallResult> {
  const platform = o.platform ?? process.platform;
  const say = o.log ?? (() => undefined);
  const pkg = openCodePackage(platform, o.arch ?? process.arch);
  if (!pkg) return { ok: false, output: `OpenCode has no build for this computer (${platform} ${o.arch ?? process.arch}).` };
  const fetchFn = o.fetch ?? fetch;
  try {
    const meta = await fetchFn(packageUrl(pkg), { signal: AbortSignal.timeout(META_TIMEOUT_MS) });
    if (!meta.ok) return { ok: false, output: `Couldn’t read OpenCode’s latest version (${meta.status}).` };
    const record = readPackageRecord(await meta.json());
    if (!record) return { ok: false, output: 'OpenCode’s package record couldn’t be read.' };
    const versionDir = join(o.dir, record.version);
    const bin = binaryIn(versionDir, platform);
    if (!(existsSync(join(versionDir, INSTALLED_MARK)) && existsSync(bin))) {
      mkdirSync(o.dir, { recursive: true });
      const archive = join(o.dir, `${record.version}.tgz.part`);
      say(`downloading ${pkg}@${record.version}`);
      const sum = await download(fetchFn, record.tarball, archive);
      if (`sha512-${sum}` !== record.integrity) {
        rmSync(archive, { force: true });
        return { ok: false, output: 'The OpenCode download didn’t match its checksum; nothing was installed.' };
      }
      const staging = `${versionDir}.part`;
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      const unpacked = await untar(archive, staging, platform);
      rmSync(archive, { force: true });
      if (!unpacked.ok || !existsSync(binaryIn(staging, platform))) {
        rmSync(staging, { recursive: true, force: true });
        return { ok: false, output: unpacked.output || 'The OpenCode download couldn’t be unpacked.' };
      }
      if (platform !== 'win32') chmodSync(binaryIn(staging, platform), 0o755);
      writeFileSync(join(staging, INSTALLED_MARK), `${record.version}\n`);
      rmSync(versionDir, { recursive: true, force: true });
      renameSync(staging, versionDir);
    }
    const linked = link(bin, o.home, platform);
    if (!linked.ok) return { ok: false, output: linked.output, version: record.version };
    // older versions go, best effort (a session still running one keeps its open file)
    for (const name of safeList(o.dir)) {
      if (name === record.version) continue;
      try { rmSync(join(o.dir, name), { recursive: true, force: true }); } catch { /* next time */ }
    }
    return { ok: true, output: `OpenCode ${record.version} is installed.`, version: record.version, bin };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/** stream the tarball to `file`, answering its sha512 in base64 */
async function download(fetchFn: typeof fetch, url: string, file: string): Promise<string> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`The OpenCode download failed (${res.status}).`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > TARBALL_MAX) throw new Error('The OpenCode download is larger than expected; nothing was installed.');
  const hash = createHash('sha512');
  const out = createWriteStream(file);
  let size = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > TARBALL_MAX) throw new Error('The OpenCode download is larger than expected; nothing was installed.');
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

/** `tar -xzf` (macOS and Linux have it; Windows 10+ ships bsdtar as `tar.exe`), the package's own folder stripped */
function untar(archive: string, into: string, platform: NodeJS.Platform): Promise<{ ok: boolean; output: string }> {
  const tar = platform === 'win32' ? 'tar.exe' : existsSync('/usr/bin/tar') ? '/usr/bin/tar' : 'tar';
  return new Promise((resolve) => {
    let output = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(tar, ['-xzf', archive, '-C', into, '--strip-components=1'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
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
 * `~/.local/bin/opencode` → the unpacked program. A link of ours from an earlier version is replaced; anything else
 * already there (the person's own OpenCode) is left alone, and counts as done: that one is the one that runs.
 */
function link(bin: string, home: string, platform: NodeJS.Platform): { ok: boolean; output: string } {
  const at = linkPath(home, platform);
  try {
    mkdirSync(join(at, '..'), { recursive: true });
    if (platform === 'win32') {
      writeFileSync(at, `@echo off\r\n"${bin}" %*\r\n`);
      return { ok: true, output: '' };
    }
    let existing: ReturnType<typeof lstatSync> | undefined;
    try { existing = lstatSync(at); } catch { existing = undefined; }
    if (existing) {
      if (!existing.isSymbolicLink() || !/[\\/]free-agent[\\/]/.test(readlinkSync(at))) return { ok: true, output: '' };
      rmSync(at, { force: true });
    }
    symlinkSync(bin, at);
    return { ok: true, output: '' };
  } catch (e) {
    return { ok: false, output: `OpenCode was downloaded but couldn’t be linked: ${e instanceof Error ? e.message : String(e)}` };
  }
}
