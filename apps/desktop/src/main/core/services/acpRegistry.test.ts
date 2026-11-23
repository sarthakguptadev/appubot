/**
 * The ACP registry catalog: which entries can run on this Mac, adding one as an agent (a checked download, or its npm /
 * Python package installed into its own folder), updating it, its sign-in and removing it. The registry and the
 * downloads come from a fake fetch, npm and uv from a fake runner that lays out what they would.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../app';
import { checkRole } from '../handlers';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { REGISTRY_URL, npmBin, packageName, platformTarget, runnerInstallHint, unpackCommands, uvSpec, type PackageRunner } from './acpRegistry';

let core: Core;
let runtime: FakeRuntime;
let root: string;
let data: string;
const here = platformTarget();
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="currentColor" d="M0 0h16v16H0z"/></svg>';

/** The package installs asked for, and which tools are on the Mac (npm and uv by default). */
const installs: { command: string; args: string[]; env: Record<string, string> }[] = [];
const tools = new Set(['npm', 'uv']);
/** A fake npm / uv: lays out what `npm install --global --prefix` and `uv tool install` would, with a command in it. */
const packageRunner: PackageRunner = {
  which: async (name) => (tools.has(name) ? `/usr/local/bin/${name}` : undefined),
  async run(command, args, env) {
    installs.push({ command, args, env });
    const win = process.platform === 'win32';
    if (command.endsWith('npm')) {
      const prefix = args[args.indexOf('--prefix') + 1]!;
      const spec = args.at(-1)!;
      if (spec.includes('broken')) return { ok: false, output: 'npm error 404 Not Found - GET https://registry.npmjs.org/broken' };
      const name = packageName(spec);
      const pkg = join(prefix, ...(win ? ['node_modules'] : ['lib', 'node_modules']), name);
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, bin: { gemini: 'dist/index.js' } }));
      const bin = win ? join(prefix, 'gemini.cmd') : join(prefix, 'bin', 'gemini');
      mkdirSync(join(bin, '..'), { recursive: true });
      writeFileSync(bin, '#!/bin/sh\necho gemini\n');
      return { ok: true, output: 'added 1 package' };
    }
    const binDir = env.UV_TOOL_BIN_DIR!;
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, `fast-agent-acp${win ? '.exe' : ''}`), '');
    return { ok: true, output: 'Installed 1 executable: fast-agent-acp' };
  },
};

/** What the fake network serves, by URL. */
const served = new Map<string, () => Response>();
const fetched: string[] = [];

/** The system tar that builds the fixture: macOS/Linux `/usr/bin/tar`, Windows' own bsdtar. */
const TAR = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
/** The fixture is a `#!/bin/sh` script: Windows has no exec bit and can't run it, so only its unpacking is checked there. */
const POSIX = process.platform !== 'win32';

/** A release archive holding `./zapper`, as a registry entry's binary build would. */
function makeArchive(version: string): { url: string; sha256: string } {
  const dir = mkdtempSync(join(root, 'build-'));
  writeFileSync(join(dir, 'zapper'), `#!/bin/sh\necho zapper ${version}\n`);
  const file = join(root, `zapper-${version}.tar.gz`);
  execFileSync(TAR, ['-czf', file, '-C', dir, 'zapper']);
  const buf = readFileSync(file);
  const url = `https://example.test/zapper-${version}.tar.gz`;
  served.set(url, () => new Response(buf));
  return { url, sha256: createHash('sha256').update(buf).digest('hex') };
}

function serveRegistry(zapper: { version: string; url: string; sha256: string }): void {
  const agents = [
    {
      id: 'zapper', name: 'Zapper', version: zapper.version, description: 'Zaps code', icon: 'https://example.test/zapper.svg',
      distribution: { binary: { [here]: { archive: zapper.url, cmd: './zapper', args: ['acp'], sha256: zapper.sha256 } } },
    },
    { id: 'gemini', name: 'Gemini CLI', version: '0.64.0', icon: 'https://example.test/bad.svg', distribution: { npx: { package: '@google/gemini-cli@0.64.0', args: ['--acp'] } } },
    { id: 'fast-agent', name: 'fast-agent', version: '0.10.1', distribution: { uvx: { package: 'fast-agent-acp==0.10.1', args: ['--stdio'] } } },
    { id: 'npmbroken', name: 'Broken npm', version: '1.0.0', distribution: { npx: { package: 'broken@1.0.0' } } },
    { id: 'claude-acp', name: 'Claude Agent', version: '0.90.0', distribution: { npx: { package: '@agentclientprotocol/claude-agent-acp@0.90.0' } } },
    { id: 'elsewhere', name: 'Elsewhere', version: '1.0.0', distribution: { binary: { 'plan9-mips': { archive: 'https://example.test/x.zip', cmd: './x' } } } },
    { id: 'broken', name: 'Broken' },
    {
      id: 'tampered', name: 'Tampered', version: '1.0.0',
      distribution: { binary: { [here]: { archive: zapper.url, cmd: './zapper', sha256: '0'.repeat(64) } } },
    },
  ];
  served.set(REGISTRY_URL, () => Response.json({ version: '1.0.0', agents, extensions: [] }));
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-registry-'));
  data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  served.set('https://example.test/zapper.svg', () => new Response(SVG));
  served.set('https://example.test/bad.svg', () => new Response('<html><script>alert(1)</script></html>'));
  serveRegistry({ version: '1.0.0', ...makeArchive('1.0.0') });
  core = createCore({
    paths: { dataDir: data, botsRoot: join(root, 'bots'), filesDir: join(data, 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    acpRegistry: true,
    packageRunner,
    fetch: (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push(url);
      return served.get(url)?.() ?? new Response('missing', { status: 404 });
    }) as typeof fetch,
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, host: '127.0.0.1', quiet: true,
    computerBackends: () => [], helperTransport: () => null,
  });
  await core.start();
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

const registry = () => core.services.acpRegistry;
const providers = () => core.services.providers;

describe('ACP registry', () => {
  it('lists the agents that can run here, marks built-ins and keeps only clean icons', async () => {
    const { agents, fetchedAt, error } = await registry().list();
    expect(error).toBeUndefined();
    expect(fetchedAt).toBeGreaterThan(0);
    expect(agents.map((a) => [a.id, a.install])).toEqual([['zapper', 'binary'], ['gemini', 'npx'], ['fast-agent', 'uvx'], ['npmbroken', 'npx'], ['claude-acp', 'npx'], ['tampered', 'binary']]);
    expect(agents.find((a) => a.id === 'claude-acp')!.builtinId).toBe('claude-code');
    expect(agents.find((a) => a.id === 'zapper')!.iconSvg).toBe(SVG);
    expect(agents.find((a) => a.id === 'gemini')!.iconSvg).toBeUndefined();
    // cached: a second look doesn't fetch again
    const n = fetched.length;
    await registry().list();
    expect(fetched.length).toBe(n);
    expect(existsSync(join(data, 'acp-registry.json'))).toBe(true);
  });

  it('adds an agent with its own build: downloaded, checked, unpacked, then started once for its logins', async () => {
    const p = await registry().add('zapper');
    const command = join(data, 'agents', 'zapper', '1.0.0', 'zapper');
    expect(p).toMatchObject({ id: 'zapper', name: 'Zapper', command, args: ['acp'], builtin: false, enabled: true, registry: { id: 'zapper', version: '1.0.0' }, iconSvg: SVG });
    expect(existsSync(command)).toBe(true);
    if (POSIX) {
      expect(statSync(command).mode & 0o111).toBeTruthy();
      expect(execFileSync(command).toString()).toBe('zapper 1.0.0\n');
    }
    await vi.waitFor(() => expect(providers().list().find((x) => x.id === 'zapper')!.authMethods).toEqual([{ id: 'oauth', name: 'Sign in', kind: 'agent' }]));
    expect(runtime.probes).toContain('zapper');
    expect((await registry().list()).agents.find((a) => a.id === 'zapper')).toMatchObject({ providerId: 'zapper', installedVersion: '1.0.0' });
  });

  it('installs an npx entry with npm into its own folder, once, and runs its command from there', async () => {
    const p = await registry().add('gemini');
    const prefix = join(data, 'agents', 'gemini', '0.64.0', 'npm');
    expect(installs.at(-1)).toMatchObject({ command: '/usr/local/bin/npm', args: ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', '--loglevel=error', '@google/gemini-cli@0.64.0'] });
    expect(p).toMatchObject({ command: npmBin(prefix, '@google/gemini-cli', 'gemini'), args: ['--acp'], registry: { id: 'gemini', version: '0.64.0' } });
    expect(p.command.startsWith(prefix)).toBe(true);
    // added again (an update to the same version): the install is reused
    const n = installs.length;
    await registry().add('gemini');
    expect(installs.length).toBe(n);
  });

  it('installs a uvx entry with uv tool install, in its own tool and bin folders', async () => {
    const p = await registry().add('fast-agent');
    const dir = join(data, 'agents', 'fast-agent', '0.10.1', 'uv');
    expect(installs.at(-1)).toMatchObject({ args: ['tool', 'install', '--force', 'fast-agent-acp==0.10.1'], env: { UV_TOOL_DIR: join(dir, 'tools'), UV_TOOL_BIN_DIR: join(dir, 'bin') } });
    expect(p.command.startsWith(join(dir, 'bin', 'fast-agent-acp'))).toBe(true);
    expect(p.args).toEqual(['--stdio']);
  });

  it("says what to install when npm or uv is missing, and cleans up a failed install", async () => {
    await expect(registry().add('npmbroken')).rejects.toThrow(/Could not install Broken npm with npm: npm error 404/);
    expect(existsSync(join(data, 'agents', 'npmbroken'))).toBe(false);
    tools.delete('npm');
    try {
      await expect(registry().add('npmbroken')).rejects.toThrow(/installs with npm, which comes with Node\.js/);
    } finally {
      tools.add('npm');
    }
    expect(packageName('@scope/pkg@1.2.3')).toBe('@scope/pkg');
    expect(packageName('fast-agent-acp==0.10.1')).toBe('fast-agent-acp');
    expect(uvSpec('minion-code@0.1.44')).toBe('minion-code==0.1.44');
    expect(uvSpec('fast-agent-acp==0.10.1')).toBe('fast-agent-acp==0.10.1');
  });

  it('refuses built-ins and a download that fails its checksum', async () => {
    await expect(registry().add('claude-acp')).rejects.toThrow(/built into AppuBot/);
    await expect(registry().add('tampered')).rejects.toThrow(/checksum/);
    expect(existsSync(join(data, 'agents', 'tampered'))).toBe(false);
    expect(providers().list().some((x) => x.id === 'tampered')).toBe(false);
  });

  it('signs an added agent in through the agent itself', async () => {
    const res = await providers().authenticate('zapper');
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/browser/);
    await vi.waitFor(() => expect(runtime.agentLogins).toEqual([{ id: 'zapper', methodId: 'oauth' }]));
  });

  it('keeps it a registry agent when it is switched off, and updates it to a newer version', async () => {
    const before = providers().list().find((x) => x.id === 'zapper')!;
    await providers().upsert({ id: before.id, name: before.name, command: before.command, args: before.args, env: before.env, enabled: false });
    expect(providers().list().find((x) => x.id === 'zapper')).toMatchObject({ enabled: false, registry: { version: '1.0.0' }, iconSvg: SVG });

    serveRegistry({ version: '1.1.0', ...makeArchive('1.1.0') });
    expect((await registry().list(true)).agents.find((a) => a.id === 'zapper')).toMatchObject({ version: '1.1.0', installedVersion: '1.0.0' });
    const p = await registry().add('zapper');
    expect(p).toMatchObject({ enabled: false, registry: { version: '1.1.0' }, command: join(data, 'agents', 'zapper', '1.1.0', 'zapper') });
    if (POSIX) expect(execFileSync(p.command).toString()).toBe('zapper 1.1.0\n');
    expect(existsSync(join(data, 'agents', 'zapper', '1.0.0'))).toBe(false);
  });

  it('removes its download with it; a full-access phone may add one, a limited one may not', async () => {
    await providers().delete('zapper');
    expect(existsSync(join(data, 'agents', 'zapper'))).toBe(false);
    expect((await registry().list()).agents.find((a) => a.id === 'zapper')!.providerId).toBeUndefined();
    expect(() => checkRole('providers.addFromRegistry', { id: 'gemini' }, { role: 'full', deviceId: 'phone' })).not.toThrow();
    expect(() => checkRole('providers.addFromRegistry', { id: 'gemini' }, { role: 'limited', deviceId: 'phone' })).toThrow(/not allowed/);
    expect(() => checkRole('providers.registry', {}, { role: 'full', deviceId: 'phone' })).not.toThrow();
  });
});

describe('platforms', () => {
  it("names this machine the registry's way", () => {
    expect(platformTarget('darwin', 'arm64')).toBe('darwin-aarch64');
    expect(platformTarget('darwin', 'x64')).toBe('darwin-x86_64');
    expect(platformTarget('linux', 'x64')).toBe('linux-x86_64');
    expect(platformTarget('linux', 'arm64')).toBe('linux-aarch64');
    expect(platformTarget('win32', 'x64')).toBe('windows-x86_64');
    expect(platformTarget('win32', 'arm64')).toBe('windows-aarch64');
  });

  it("unpacks with macOS's and Windows' bsdtar, GNU tar or a zip tool on Linux", () => {
    const tgz = 'https://x.test/a.tar.gz';
    const zip = 'https://x.test/a.zip';
    expect(unpackCommands(zip, '/d/f', '/d/out', 'darwin')).toEqual([{ command: '/usr/bin/tar', args: ['-xf', '/d/f', '-C', '/d/out'] }]);
    expect(unpackCommands(zip, 'C:\\d\\f', 'C:\\d\\out', 'win32', { SystemRoot: 'C:\\Windows' }))
      .toEqual([{ command: 'C:\\Windows\\System32\\tar.exe', args: ['-xf', 'C:\\d\\f', '-C', 'C:\\d\\out'] }]);
    expect(unpackCommands(zip, '/d/f', '/d/out', 'linux').map((c) => c.command)).toEqual(['unzip', 'bsdtar', 'python3']);
    expect(unpackCommands(tgz, '/d/f', '/d/out', 'linux').map((c) => c.command).at(-1)).toBe('tar');
  });

  it('suggests how to get npx and uvx where it knows', () => {
    expect(runnerInstallHint('npx', 'darwin')).toBe('brew install node');
    expect(runnerInstallHint('uvx', 'darwin')).toBe('brew install uv');
    expect(runnerInstallHint('npx', 'win32')).toMatch(/^winget install/);
    expect(runnerInstallHint('npx', 'linux')).toBeUndefined();
  });
});
