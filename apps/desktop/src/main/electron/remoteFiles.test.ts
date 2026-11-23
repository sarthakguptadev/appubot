import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { RemoteFiles, uniqueIn } from './remoteFiles';

const fresh = () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'remote-files-'));
  return { dataDir, files: new RemoteFiles(dataDir) };
};
const bytes = (n: number) => new Uint8Array(n).map((_, i) => i % 251);

describe('RemoteFiles', () => {
  test('a file is kept per computer under its id and name, and found again while its size matches', () => {
    const { dataDir, files } = fresh();
    const ref = { computer: 'own', id: 'f1', name: 'edited-random.png', size: 539 };
    expect(files.cached(ref)).toBeNull();
    const p = files.save(ref, bytes(539));
    expect(p).toBe(join(dataDir, 'cloud-files', 'own', 'f1', 'edited-random.png'));
    expect(files.cached(ref)).toBe(p);
    expect(files.cached({ ...ref, size: 540 })).toBeNull();
    expect(files.cached({ ...ref, size: undefined })).toBe(p);
    // a team's computer is another folder
    expect(files.cached({ ...ref, computer: 'team-acme' })).toBeNull();
    if (process.platform !== 'win32') expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  test('refs that could leave the folder are refused, odd names made safe', () => {
    const { dataDir, files } = fresh();
    expect(() => files.pathOf({ computer: '../x', id: 'f1', name: 'a' })).toThrow();
    expect(() => files.pathOf({ computer: 'own', id: '..', name: 'a' })).toThrow();
    expect(() => files.pathOf({ computer: 'own', id: 'a/b', name: 'a' })).toThrow();
    expect(() => files.pathOf({ computer: 'team-', id: 'f', name: 'a' })).toThrow();
    expect(files.pathOf({ computer: 'own', id: 'f1', name: '../../etc/passwd' })).toBe(join(dataDir, 'cloud-files', 'own', 'f1', 'passwd'));
    expect(files.pathOf({ computer: 'own', id: 'f1', name: '..' })).toBe(join(dataDir, 'cloud-files', 'own', 'f1', 'file'));
  });

  test('copied to Downloads under a free name', () => {
    const { dataDir, files } = fresh();
    const downloads = join(dataDir, 'Downloads');
    const ref = { computer: 'team-acme', id: 'f2', name: 'report.pdf', size: 10 };
    expect(() => files.copyTo(ref, downloads)).toThrow(/isn’t on this computer/);
    files.save(ref, bytes(10));
    const a = files.copyTo(ref, downloads);
    const b = files.copyTo(ref, downloads);
    expect(a).toBe(join(downloads, 'report.pdf'));
    expect(b).toBe(join(downloads, 'report (2).pdf'));
    expect(readFileSync(b).length).toBe(10);
    expect(uniqueIn(downloads, 'noext')).toBe(join(downloads, 'noext'));
  });

  test('the sweep drops old copies, then the oldest past the size cap', () => {
    const { files } = fresh();
    const now = Date.now();
    const at = (ref: { computer: string; id: string; name: string }, ms: number) => { const t = new Date(ms); utimesSync(files.pathOf(ref), t, t); };
    const old = { computer: 'own', id: 'old', name: 'a.bin' };
    const mid = { computer: 'own', id: 'mid', name: 'b.bin' };
    const ne = { computer: 'team-t1', id: 'new', name: 'c.bin' };
    files.save(old, bytes(100)); at(old, now - 40 * 86_400_000);
    files.save(mid, bytes(100)); at(mid, now - 2 * 86_400_000);
    files.save(ne, bytes(100)); at(ne, now - 1000);
    // the cap is each computer's: own's mid and team-t1's new fit their own 150
    expect(files.sweep(now, 150).removed).toBe(1);
    expect(existsSync(files.pathOf(old))).toBe(false);
    expect(existsSync(files.pathOf(mid))).toBe(true);
    expect(existsSync(files.pathOf(ne))).toBe(true);
  });

  test('past a computer\'s cap its least recently used go first, other computers untouched', () => {
    const { files } = fresh();
    const now = Date.now();
    const at = (ref: { computer: string; id: string; name: string }, ms: number) => { const t = new Date(ms); utimesSync(files.pathOf(ref), t, t); };
    const a = { computer: 'own', id: 'a', name: 'a.bin' };
    const b = { computer: 'own', id: 'b', name: 'b.bin' };
    const c = { computer: 'own', id: 'c', name: 'c.bin' };
    const t = { computer: 'team-t1', id: 't', name: 't.bin' };
    files.save(a, bytes(100)); at(a, now - 3000);
    files.save(b, bytes(100)); at(b, now - 2000);
    files.save(c, bytes(100)); at(c, now - 1000);
    files.save(t, bytes(300)); at(t, now - 5000);
    // shown again: the newest use
    expect(files.cached(a)).toBeTruthy();
    expect(files.sweep(now + 10, 250, undefined, 'own').removed).toBe(1);
    expect(existsSync(files.pathOf(a))).toBe(true);
    expect(existsSync(files.pathOf(b))).toBe(false);
    expect(existsSync(files.pathOf(c))).toBe(true);
    expect(existsSync(files.pathOf(t))).toBe(true);
  });

  test('forgets one computer, or all', () => {
    const { files } = fresh();
    const a = { computer: 'own', id: 'f', name: 'a' };
    const b = { computer: 'team-x', id: 'f', name: 'b' };
    files.save(a, bytes(1));
    files.save(b, bytes(1));
    files.forget('team-x');
    expect(files.cached(b)).toBeNull();
    expect(files.cached(a)).not.toBeNull();
    files.forget();
    expect(files.cached(a)).toBeNull();
    writeFileSync(join(files.root, '..', 'stray'), 'x');
    expect(() => files.forget('../')).not.toThrow();
  });
});
