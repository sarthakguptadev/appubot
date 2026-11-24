/**
 * The installs AppuBot runs itself (`nativeInstall.ts`): which build of Codex, Copilot and OpenCode each platform and
 * processor gets, the way every built-in agent installs on Windows, macOS and Linux with no Node, and Codex's own
 * download against a stand-in registry: checked, unpacked and linked where the runtime looks, in a folder with a space
 * in its name. On Windows, a real `.exe` goes through the `.cmd` shim the runtime reads back.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { BUILTIN_PROVIDERS, builtinAccountLogin, builtinInstallHint, cmdShimTarget, launchSpec } from '@appubot/agent-runtime';
import { agentBuild, cmdShim, installNativeAgent, installRoute, linkFor, packageUrl, programIn, tarCommand } from './nativeInstall';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const PLATFORMS = ['win32', 'darwin', 'linux'] as const;

describe('which build', () => {
  it('takes Codex’s build for each platform and processor from its dist-tag, the program under its target triple', () => {
    expect(agentBuild('codex', 'win32', 'x64')).toMatchObject({ pkg: '@openai/codex', tag: 'win32-x64', bin: 'vendor/x86_64-pc-windows-msvc/bin/codex.exe', command: 'codex' });
    expect(agentBuild('codex', 'win32', 'arm64')).toMatchObject({ tag: 'win32-arm64', bin: 'vendor/aarch64-pc-windows-msvc/bin/codex.exe' });
    expect(agentBuild('codex', 'darwin', 'arm64')).toMatchObject({ tag: 'darwin-arm64', bin: 'vendor/aarch64-apple-darwin/bin/codex' });
    expect(agentBuild('codex', 'darwin', 'x64')).toMatchObject({ tag: 'darwin-x64', bin: 'vendor/x86_64-apple-darwin/bin/codex' });
    expect(agentBuild('codex', 'linux', 'x64')).toMatchObject({ tag: 'linux-x64', bin: 'vendor/x86_64-unknown-linux-musl/bin/codex' });
    expect(agentBuild('codex', 'linux', 'arm64')).toMatchObject({ tag: 'linux-arm64', bin: 'vendor/aarch64-unknown-linux-musl/bin/codex' });
    expect(agentBuild('codex', 'win32', 'ia32')).toBeUndefined();
    expect(agentBuild('codex', 'freebsd', 'x64')).toBeUndefined();
    expect(packageUrl('@openai/codex', 'win32-x64')).toBe('https://registry.npmjs.org/@openai%2fcodex/win32-x64');
  });

  it('takes Copilot’s and OpenCode’s platform packages', () => {
    expect(agentBuild('copilot', 'win32', 'arm64', false)).toMatchObject({ pkg: '@github/copilot-win32-arm64', tag: 'latest', bin: 'copilot.exe' });
    expect(agentBuild('copilot', 'linux', 'x64', false)).toMatchObject({ pkg: '@github/copilot-linux-x64', bin: 'copilot' });
    expect(agentBuild('copilot', 'linux', 'x64', true)).toMatchObject({ pkg: '@github/copilot-linuxmusl-x64' });
    expect(agentBuild('opencode', 'win32', 'x64')).toMatchObject({ pkg: '@opencode/cli-windows-x64-baseline', bin: 'bin/opencode.exe' });
    expect(agentBuild('cursor', 'win32', 'x64')).toBeUndefined();
  });

  it('runs a Windows program through a shim with its full path quoted, and unpacks with System32’s tar', () => {
    const exe = 'C:\\Users\\RISEIM~1\\AppData\\Roaming\\AppuBot\\agents\\codex\\0.172.0-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
    expect(cmdShim(exe)).toBe(`@echo off\r\n"${exe}" %*\r\n`);
    expect(cmdShim('C:\\Users\\Ana Lima\\100%\\codex.exe')).toBe('@echo off\r\n"C:\\Users\\Ana Lima\\100%%\\codex.exe" %*\r\n');
    expect(tarCommand('win32', { SystemRoot: 'C:\\Windows' })).toBe(win32.join('C:\\Windows', 'System32', 'tar.exe'));
  });
});

describe('every built-in agent installs and signs in without Node', () => {
  for (const platform of PLATFORMS) {
    for (const arch of ['x64', 'arm64']) {
      it(`on ${platform} ${arch}`, () => {
        for (const spec of BUILTIN_PROVIDERS) {
          const route = installRoute(spec.id, builtinInstallHint(spec.id, platform), { platform, arch, home: '/home/a', npm: false, builtin: true });
          // the app downloads it, or runs its maker's installer: never npm, never a terminal
          expect([spec.id, route.kind]).toEqual([spec.id, expect.stringMatching(/^(download|installer)$/)]);
          if (route.kind === 'installer') expect(route.command).toBe(platform === 'win32' ? 'powershell' : 'bash');
          expect(builtinAccountLogin(spec.id), spec.id).toMatchObject({ kind: 'terminal' });
        }
        expect(installRoute('codex', builtinInstallHint('codex', platform), { platform, arch, home: '/h', npm: true, builtin: true })).toEqual({ kind: 'download', agent: 'codex' });
      });
    }
  }

  it('says an added agent that only installs with npm needs Node.js where npm isn’t there', () => {
    const o = { platform: 'win32' as const, home: 'C:\\Users\\a', builtin: false };
    expect(installRoute('my-agent', 'npm i -g my-agent', { ...o, npm: false })).toEqual({ kind: 'needs-node', line: 'npm i -g my-agent' });
    expect(installRoute('my-agent', 'npm i -g my-agent', { ...o, npm: true })).toEqual({ kind: 'terminal', line: 'npm i -g my-agent' });
    expect(installRoute('my-agent', 'curl -fsSL https://example.test/i.sh | bash', { ...o, platform: 'linux', npm: false })).toMatchObject({ kind: 'terminal' });
    expect(installRoute('my-agent', undefined, { ...o, npm: false })).toEqual({ kind: 'none' });
  });
});

/** a registry with Codex's build for one platform: `program` copied in as the codex binary */
function registry(tag: string, triple: string, program: { file?: string; script?: string }, version = '0.172.0'): { fetch: typeof fetch; hits: string[] } {
  const src = mkdtempSync(join(tmpdir(), 'appubot-codex-src-'));
  roots.push(src);
  const binDir = join(src, 'package', 'vendor', triple, 'bin');
  mkdirSync(binDir, { recursive: true });
  const name = tag.startsWith('win32') ? 'codex.exe' : 'codex';
  if (program.file) copyFileSync(program.file, join(binDir, name));
  else { writeFileSync(join(binDir, name), program.script!); chmodSync(join(binDir, name), 0o755); }
  mkdirSync(join(src, 'package', 'vendor', triple, 'codex-path'), { recursive: true });
  writeFileSync(join(src, 'package', 'package.json'), '{}');
  execFileSync(tarCommand(), ['-czf', join(src, 'p.tgz'), '-C', src, 'package']);
  const bytes = readFileSync(join(src, 'p.tgz'));
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const full = `${version}-${tag}`;
  const tarball = `https://registry.npmjs.org/@openai/codex/-/codex-${full}.tgz`;
  const hits: string[] = [];
  const fake = (async (input: RequestInfo | URL) => {
    const url = String(input);
    hits.push(url);
    if (url === packageUrl('@openai/codex', tag)) return new Response(JSON.stringify({ version: full, dist: { tarball, integrity } }), { status: 200 });
    if (url === tarball) return new Response(bytes, { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetch: fake, hits };
}

const place = () => {
  // a space in the path, as in "C:\Users\Ana Lima\…"
  const root = mkdtempSync(join(tmpdir(), 'appubot agent '));
  roots.push(root);
  return { dir: join(root, 'App Data', 'agents', 'codex'), home: join(root, 'home dir') };
};

describe.skipIf(process.platform === 'win32')('installing Codex on macOS and Linux', () => {
  it('downloads its platform’s build, checks, unpacks and links it; a second run downloads nothing', async () => {
    const at = place();
    const reg = registry('linux-x64', 'x86_64-unknown-linux-musl', { script: '#!/bin/sh\necho "codex-cli 0.172.0"\n' });
    const r = await installNativeAgent('codex', { ...at, platform: 'linux', arch: 'x64', fetch: reg.fetch });
    expect(r).toMatchObject({ ok: true, version: '0.172.0-linux-x64' });
    expect(reg.hits[0]).toBe('https://registry.npmjs.org/@openai%2fcodex/linux-x64');
    const link = linkFor(at.home, 'codex', 'linux');
    expect(readlinkSync(link)).toBe(programIn(join(at.dir, '0.172.0-linux-x64'), agentBuild('codex', 'linux', 'x64')!));
    expect(execFileSync(link).toString().trim()).toBe('codex-cli 0.172.0');
    expect((await installNativeAgent('codex', { ...at, platform: 'linux', arch: 'x64', fetch: reg.fetch })).ok).toBe(true);
    expect(reg.hits.filter((u) => u.endsWith('.tgz'))).toHaveLength(1);
  });

  it('installs nothing from a download that doesn’t match its checksum, or a build the platform hasn’t', async () => {
    const at = place();
    const reg = registry('linux-x64', 'x86_64-unknown-linux-musl', { script: '#!/bin/sh\n' });
    const tampered = (async (input: RequestInfo | URL) => {
      const res = await reg.fetch(input);
      return String(input).endsWith('.tgz') ? new Response(Buffer.concat([Buffer.from(await res.arrayBuffer()), Buffer.from('x')]), { status: 200 }) : res;
    }) as typeof fetch;
    const r = await installNativeAgent('codex', { ...at, platform: 'linux', arch: 'x64', fetch: tampered });
    expect(r).toMatchObject({ ok: false, output: expect.stringMatching(/checksum/) });
    expect(existsSync(linkFor(at.home, 'codex', 'linux'))).toBe(false);
    expect(await installNativeAgent('codex', { ...at, platform: 'linux', arch: 'ia32', fetch: reg.fetch })).toMatchObject({ ok: false });
  });
});

describe.runIf(process.platform === 'win32')('installing Codex on Windows', () => {
  it('unpacks the .exe with System32’s tar and links it as a .cmd the runtime starts directly', async () => {
    const at = place();
    const arch = process.arch;
    const build = agentBuild('codex', 'win32', arch)!;
    const triple = build.bin.split('/')[1]!;
    // a small real Windows program stands in for codex.exe
    const stand = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe');
    const reg = registry(`win32-${arch}`, triple, { file: stand });
    const r = await installNativeAgent('codex', { ...at, fetch: reg.fetch });
    expect(r).toMatchObject({ ok: true, version: `0.172.0-win32-${arch}` });
    const link = linkFor(at.home, 'codex', 'win32');
    expect(link.endsWith('codex.cmd')).toBe(true);
    const exe = programIn(join(at.dir, `0.172.0-win32-${arch}`), build);
    expect(cmdShimTarget(link)).toEqual({ exe });
    expect(launchSpec(link, ['--version'])).toEqual({ command: exe, args: ['--version'] });
    expect(execFileSync(exe).toString().trim().toLowerCase()).toBe(hostname().toLowerCase());
  });
});
