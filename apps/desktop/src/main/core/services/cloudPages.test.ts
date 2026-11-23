/**
 * Pages kept of AppuBot computers (services/cloudPages.ts) and the size rule they share with the file copies
 * (services/cloudFiles.ts): a hit, a miss, a check that finds the same page, a changed page, another account's copy,
 * and the least recently shown going first past a computer's cap.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudPages, pageHash } from './cloudPages';
import { cloudEntries, cloudFilesSize, sweepCloudFiles } from './cloudFiles';

const secretBox = {
  encrypt: (s: string) => `sealed:${Buffer.from(s, 'utf8').toString('base64')}`,
  decrypt: (s: string) => Buffer.from(s.slice('sealed:'.length), 'base64').toString('utf8'),
};

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fresh(opts: { capMb?: number; box?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'appubot-cloud-pages-'));
  dirs.push(dataDir);
  let owner: { email?: string; id?: string } | null = { email: 'sam@example.com' };
  const pages = new CloudPages({
    dataDir, owner: () => owner, ...(opts.box === false ? {} : { secretBox }),
    viewKey: (id) => `k-${Buffer.from(id).toString('base64url')}`, capMb: () => opts.capMb, warn: () => undefined,
  });
  return { dataDir, pages, setOwner: (o: typeof owner) => { owner = o; } };
}

describe('CloudPages', () => {
  it('misses, keeps a page sealed and user-only, then hits with its path', () => {
    const { dataDir, pages } = fresh();
    expect(pages.get(undefined, 'p1')).toBeNull();
    const kept = pages.set(undefined, 'p1', '<h1>Revenue</h1>');
    expect(kept.changed).toBe(true);
    expect(kept.hash).toBe(pageHash('<h1>Revenue</h1>'));
    expect(kept.path).toMatch(/^\/cloud-pages\/own\/p1\?v=k-[\w-]+&h=[0-9a-f]{16}$/);
    const file = join(dataDir, 'cloud-files', 'own', 'p1', '.page.json');
    expect(readFileSync(file, 'utf8')).not.toContain('Revenue');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, 'cloud-files')).mode & 0o777).toBe(0o700);
    expect(pages.get(undefined, 'p1')).toMatchObject({ path: kept.path, hash: kept.hash });
    expect(pages.serve('own', 'p1')).toBe('<h1>Revenue</h1>');
    expect(pages.serve('team-x', 'p1')).toBeNull();
  });

  it('a check that brings the same page only notes when; a changed one gets a new path', () => {
    const { pages } = fresh();
    const first = pages.set('acme', 'p1', '<p>a</p>');
    const again = pages.set('acme', 'p1', '<p>a</p>');
    expect(again.changed).toBe(false);
    expect(again.path).toBe(first.path);
    expect(again.savedAt).toBe(first.savedAt);
    expect(again.checkedAt).toBeGreaterThanOrEqual(first.checkedAt);
    const changed = pages.set('acme', 'p1', '<p>b</p>');
    expect(changed.changed).toBe(true);
    expect(changed.path).not.toBe(first.path);
    expect(pages.serve('team-acme', 'p1')).toBe('<p>b</p>');
  });

  it('keeps it as is without a keychain, drops another account’s copy, keeps nothing signed out', () => {
    const { dataDir, pages, setOwner } = fresh({ box: false });
    pages.set(undefined, 'p1', '<p>plain</p>');
    expect(pages.serve('own', 'p1')).toBe('<p>plain</p>');
    setOwner({ email: 'other@example.com' });
    expect(pages.get(undefined, 'p1')).toBeNull();
    expect(existsSync(join(dataDir, 'cloud-files', 'own', 'p1', '.page.json'))).toBe(false);
    setOwner(null);
    expect(() => pages.set(undefined, 'p1', '<p>x</p>')).toThrow();
  });

  it('refuses ids and computers that could leave the folder', () => {
    const { pages } = fresh();
    expect(() => pages.set(undefined, '../x', '<p>x</p>')).toThrow();
    expect(() => pages.set(undefined, '..', '<p>x</p>')).toThrow();
    expect(pages.serve('../own', 'p1')).toBeNull();
  });
});

describe('sweepCloudFiles', () => {
  it('drops the least recently shown of a computer past its cap, and old ones, never another computer’s', () => {
    const { dataDir, pages } = fresh();
    const root = join(dataDir, 'cloud-files');
    const now = Date.now();
    const big = 'x'.repeat(4000);
    for (const id of ['a', 'b', 'c']) pages.set(undefined, id, `<p>${id}</p>${big}`);
    pages.set('acme', 't', `<p>t</p>${big}`);
    pages.set(undefined, 'old', '<p>old</p>');
    const at = (computer: string, id: string, ms: number) => { const t = new Date(ms); utimesSync(join(root, computer, id, '.page.json'), t, t); };
    at('own', 'a', now - 3000); at('own', 'b', now - 2000); at('own', 'c', now - 1000); at('team-acme', 't', now - 9000);
    at('own', 'old', now - 40 * 86_400_000);
    // shown again: the newest
    pages.get(undefined, 'a');
    const size = cloudEntries(root, 'own').find((e) => e.dir.endsWith('/c'))!.size;
    const r = sweepCloudFiles(root, { maxBytes: size * 2 + 10, now: now + 10 });
    expect(r.removed).toBe(2);
    expect(pages.get(undefined, 'old')).toBeNull();
    expect(pages.get(undefined, 'b')).toBeNull();
    expect(pages.get(undefined, 'a')).not.toBeNull();
    expect(pages.get(undefined, 'c')).not.toBeNull();
    expect(pages.get('acme', 't')).not.toBeNull();
    expect(cloudFilesSize(root).count).toBe(3);
  });
});
