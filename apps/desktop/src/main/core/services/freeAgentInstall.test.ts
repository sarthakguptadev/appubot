/**
 * OpenCode's own installer (`freeAgentInstall.ts`): the right package per platform, only a registry tarball with a
 * sha512 is taken, the download is checked before anything is unpacked, and the program ends up linked where the
 * runtime looks. Against a stand-in registry (a tarball made here with the system's tar).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binaryIn, installFreeAgent, linkPath, openCodePackage, packageUrl, readPackageRecord } from './freeAgentInstall';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('which package', () => {
  it('names OpenCode 2’s build for the platform; x64 takes the baseline one', () => {
    expect(openCodePackage('darwin', 'arm64')).toBe('@opencode/cli-darwin-arm64');
    expect(openCodePackage('darwin', 'x64')).toBe('@opencode/cli-darwin-x64-baseline');
    expect(openCodePackage('linux', 'x64')).toBe('@opencode/cli-linux-x64-baseline');
    expect(openCodePackage('win32', 'arm64')).toBe('@opencode/cli-windows-arm64');
    expect(openCodePackage('freebsd', 'x64')).toBeUndefined();
    expect(openCodePackage('linux', 'ia32')).toBeUndefined();
    expect(packageUrl('@opencode/cli-darwin-arm64')).toBe('https://registry.npmjs.org/@opencode%2fcli-darwin-arm64/latest');
  });

  it('takes only a registry tarball with a sha512', () => {
    const good = { version: '2.3.0', dist: { tarball: 'https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-2.3.0.tgz', integrity: 'sha512-abc+/=' } };
    expect(readPackageRecord(good)).toEqual({ version: '2.3.0', tarball: good.dist.tarball, integrity: 'sha512-abc+/=' });
    expect(readPackageRecord({ ...good, dist: { ...good.dist, tarball: 'https://evil.example/x.tgz' } })).toBeUndefined();
    expect(readPackageRecord({ ...good, dist: { ...good.dist, integrity: 'sha1-abc' } })).toBeUndefined();
    expect(readPackageRecord({ ...good, version: '../../etc' })).toBeUndefined();
    expect(readPackageRecord(null)).toBeUndefined();
  });
});

/** a registry with one package whose program is a shell script that says its version */
function registry(version = '2.3.0', tamper = false): { fetch: typeof fetch; hits: string[] } {
  const src = mkdtempSync(join(tmpdir(), 'appubot-oc-src-'));
  roots.push(src);
  mkdirSync(join(src, 'package', 'bin'), { recursive: true });
  writeFileSync(join(src, 'package', 'bin', 'opencode'), `#!/bin/sh\necho "opencode v${version}"\n`);
  chmodSync(join(src, 'package', 'bin', 'opencode'), 0o755);
  writeFileSync(join(src, 'package', 'package.json'), '{}');
  execFileSync('tar', ['-czf', join(src, 'p.tgz'), '-C', src, 'package']);
  const bytes = readFileSync(join(src, 'p.tgz'));
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const tarball = `https://registry.npmjs.org/@opencode/cli-test/-/cli-test-${version}.tgz`;
  const hits: string[] = [];
  const fake = (async (input: RequestInfo | URL) => {
    const url = String(input);
    hits.push(url);
    if (url.endsWith('/latest')) return new Response(JSON.stringify({ version, dist: { tarball, integrity } }), { status: 200 });
    if (url === tarball) return new Response(tamper ? Buffer.concat([bytes, Buffer.from('x')]) : bytes, { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetch: fake, hits };
}

describe.skipIf(process.platform === 'win32')('installing', () => {
  const place = () => {
    const root = mkdtempSync(join(tmpdir(), 'appubot-oc-'));
    roots.push(root);
    return { dir: join(root, 'data', 'free-agent'), home: join(root, 'home') };
  };

  it('downloads, checks, unpacks and links it; a second run downloads nothing', async () => {
    const at = place();
    const reg = registry();
    const r = await installFreeAgent({ ...at, fetch: reg.fetch });
    expect(r).toMatchObject({ ok: true, version: '2.3.0' });
    expect(existsSync(binaryIn(join(at.dir, '2.3.0')))).toBe(true);
    expect(lstatSync(linkPath(at.home)).isSymbolicLink()).toBe(true);
    expect(execFileSync(linkPath(at.home)).toString().trim()).toBe('opencode v2.3.0');
    const again = await installFreeAgent({ ...at, fetch: reg.fetch });
    expect(again.ok).toBe(true);
    expect(reg.hits.filter((u) => u.endsWith('.tgz')).length).toBe(1);
  });

  it('a newer version replaces the old one and its link', async () => {
    const at = place();
    await installFreeAgent({ ...at, fetch: registry('2.3.0').fetch });
    const r = await installFreeAgent({ ...at, fetch: registry('2.4.0').fetch });
    expect(r).toMatchObject({ ok: true, version: '2.4.0' });
    expect(readdirSync(at.dir)).toEqual(['2.4.0']);
    expect(execFileSync(linkPath(at.home)).toString().trim()).toBe('opencode v2.4.0');
  });

  it('a download that doesn’t match its checksum installs nothing', async () => {
    const at = place();
    const r = await installFreeAgent({ ...at, fetch: registry('2.3.0', true).fetch });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/checksum/);
    expect(existsSync(join(at.dir, '2.3.0'))).toBe(false);
    expect(existsSync(linkPath(at.home))).toBe(false);
  });

  it('leaves the person’s own OpenCode in ~/.local/bin alone', async () => {
    const at = place();
    mkdirSync(join(at.home, '.local', 'bin'), { recursive: true });
    writeFileSync(linkPath(at.home), '#!/bin/sh\necho mine\n', { mode: 0o755 });
    const r = await installFreeAgent({ ...at, fetch: registry().fetch });
    expect(r.ok).toBe(true);
    expect(execFileSync(linkPath(at.home)).toString().trim()).toBe('mine');
  });

  it('says so where OpenCode has no build, or the registry can’t be read', async () => {
    const at = place();
    expect((await installFreeAgent({ ...at, platform: 'freebsd', fetch: registry().fetch })).ok).toBe(false);
    const down = (async () => new Response('', { status: 503 })) as typeof fetch;
    expect(await installFreeAgent({ ...at, fetch: down })).toMatchObject({ ok: false });
  });
});
