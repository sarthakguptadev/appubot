import { describe, expect, test } from 'vitest';
import { MEMORY_MAX, RemoteFileLoader, sniffImage, thumbRef, computerKey, lostComputers, fileIdOf, previewable, progressLabel, refKey, remoteRef, type RemoteFileDeps, type RemoteProgress, type RemoteRef } from './remoteFileCore';

function setup(opts: { connected?: boolean; disk?: boolean; size?: number; thumb?: (b: Uint8Array) => Uint8Array | null } = {}) {
  let connected = opts.connected ?? true;
  const files = new Map<string, Uint8Array>();
  const progress: [string, RemoteProgress | null][] = [];
  const fetched: string[] = [];
  let wakes = 0;
  let release: (() => void) | null = null;
  const deps: RemoteFileDeps = {
    connected: () => connected,
    wake: async () => { wakes++; connected = true; },
    fetchBytes: async (ref, onProgress) => {
      fetched.push(ref.id);
      const n = opts.size ?? 10;
      onProgress(n, n);
      if (ref.id.startsWith('slow')) await new Promise<void>((r) => { release = r; });
      if (ref.id.startsWith('bad')) throw new Error('HTTP 404');
      return new Uint8Array(n).fill(7);
    },
    disk: opts.disk === false ? null : {
      cached: async (r) => (files.has(refKey(r)) ? `/cache/${refKey(r)}` : null),
      read: async (r) => files.get(refKey(r)) ?? null,
      save: async (r, b) => { files.set(refKey(r), b); return `/cache/${refKey(r)}`; },
    },
    onProgress: (k, p) => progress.push([k, p]),
    ...(opts.thumb ? { makeThumb: async (b: Uint8Array) => opts.thumb!(b) } : {}),
  };
  return { loader: new RemoteFileLoader(deps), files, progress, fetched, wakes: () => wakes, release: () => release?.(), setConnected: (v: boolean) => { connected = v; } };
}
const ref = (id: string, size = 10): RemoteRef => ({ computer: 'own', id, name: `${id}.png`, size });

describe('remote file names', () => {
  test('computers, ids and refs', () => {
    expect(computerKey()).toBe('own');
    expect(computerKey('acme')).toBe('team-acme');
    expect(computerKey('a/b')).toBe('team-a_b');
    expect(fileIdOf({ id: 'f1', url: '/files/zz' })).toBe('f1');
    expect(fileIdOf({ url: '/files/f%201?x=1' })).toBe('f 1');
    expect(fileIdOf({ url: 'https://x/files/a' })).toBeNull();
    expect(remoteRef('own', { url: '/files/f2', name: 'a.png', size: 0 })).toEqual({ computer: 'own', id: 'f2', name: 'a.png' });
    expect(remoteRef('team-t', { id: 'f3', name: '', size: 5 })).toEqual({ computer: 'team-t', id: 'f3', name: 'f3', size: 5 });
  });

  test('what shows by itself, and the card’s words', () => {
    expect(previewable({ mimeType: 'image/png', size: 539_000 })).toBe(true);
    expect(previewable({ mimeType: 'video/mp4', size: 400 * 1024 * 1024 })).toBe(false);
    expect(previewable({ mimeType: 'application/pdf', size: 10 })).toBe(false);
    expect(progressLabel(null)).toBeNull();
    expect(progressLabel({ phase: 'waking' })).toBe('Waking…');
    expect(progressLabel({ phase: 'downloading', received: 45, total: 100 })).toBe('Downloading 45%');
    expect(progressLabel({ phase: 'downloading', received: 100, total: 100 })).toBe('Downloading 99%');
    expect(progressLabel({ phase: 'downloading' })).toBe('Downloading…');
    expect(progressLabel({ phase: 'saving' })).toBe('Saving…');
  });
});

describe('RemoteFileLoader', () => {
  test('a file is fetched once into the cache, then found there', async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.loader.bring(ref('f1'), { wake: true }), s.loader.bring(ref('f1'), { wake: true })]);
    expect(a.path).toBe('/cache/own:f1');
    expect(b).toBe(a);
    expect(s.fetched).toEqual(['f1']);
    expect(s.progress.map(([, p]) => p?.phase ?? null)).toEqual(['downloading', 'downloading', 'saving', null]);
    expect((await s.loader.bring(ref('f1'), { wake: true })).path).toBe('/cache/own:f1');
    expect(s.fetched).toEqual(['f1']);
    expect(s.wakes()).toBe(0);
  });

  test('Open wakes a sleeping computer; a preview waits for it', async () => {
    const s = setup({ connected: false });
    expect(await s.loader.preview(ref('p1'))).toBeNull();
    expect(s.fetched).toEqual([]);
    await expect(s.loader.bring(ref('p1'), { wake: false })).rejects.toThrow(/isn’t connected/);
    const got = await s.loader.bring(ref('p1'), { wake: true });
    expect(got.path).toBe('/cache/own:p1');
    expect(s.wakes()).toBe(1);
    expect(s.progress.find(([, p]) => p)).toEqual(['own:p1', { phase: 'waking' }]);
    // shown from the cache from now on
    expect(await s.loader.preview(ref('p1'))).toHaveLength(10);
    expect(s.fetched).toEqual(['p1']);
  });

  test('a preview joins a download in flight and gets its bytes', async () => {
    const s = setup();
    const open = s.loader.bring(ref('slow1'), { wake: true });
    await Promise.resolve();
    s.setConnected(false);
    const shown = s.loader.preview(ref('slow1'));
    await new Promise((r) => setTimeout(r, 0));
    s.release();
    expect(await shown).toHaveLength(10);
    await open;
    expect(s.fetched).toEqual(['slow1']);
  });

  test('a failure clears its progress and can be tried again', async () => {
    const s = setup();
    await expect(s.loader.bring(ref('bad1'), { wake: true })).rejects.toThrow('HTTP 404');
    expect(s.progress.at(-1)).toEqual(['own:bad1', null]);
    await expect(s.loader.bring(ref('bad1'), { wake: true })).rejects.toThrow('HTTP 404');
    expect(s.fetched).toEqual(['bad1', 'bad1']);
  });

  test('without main’s cache the bytes stay in the window, the newest first', async () => {
    const s = setup({ disk: false, size: Math.floor(MEMORY_MAX / 2) + 1 });
    const a = await s.loader.bring(ref('m1'), { wake: true });
    expect(a.bytes).toBeDefined();
    expect(a.path).toBeUndefined();
    await s.loader.bring(ref('m1'), { wake: true });
    expect(s.fetched).toEqual(['m1']);
    await s.loader.bring(ref('m2'), { wake: true });
    // two halves don't fit: the older one went
    await s.loader.bring(ref('m1'), { wake: true });
    expect(s.fetched).toEqual(['m1', 'm2', 'm1']);
  });
});

describe('lostComputers', () => {
  const view = (signedIn: boolean, teams?: string[]) => ({ signedIn, ...(teams ? { teams: teams.map((id) => ({ team: { id } })) } : {}) });
  test('signing out drops every copy, leaving a team drops its own', () => {
    expect(lostComputers(view(true, ['a']), view(false))).toBe('all');
    expect(lostComputers(view(true, ['a', 'b']), view(true, ['b']))).toEqual(['team-a']);
    expect(lostComputers(view(true, ['a']), view(true))).toEqual([]);
    expect(lostComputers(null, view(false))).toEqual([]);
    expect(lostComputers(view(false), view(false))).toEqual([]);
    expect(lostComputers(view(true), null)).toEqual([]);
  });
});

describe('thumbnails', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 1, 2]);
  test('the first show reads the whole picture and keeps a thumbnail; the next one reads only the thumbnail, asleep', async () => {
    const s = setup({ thumb: () => JPEG });
    const first = await s.loader.show(ref('p1'), 'image/png');
    expect(first).toMatchObject({ thumb: false, mimeType: 'image/png' });
    await new Promise((r) => setTimeout(r, 0));
    expect(s.files.get(refKey(thumbRef(ref('p1'))))).toEqual(JPEG);
    s.setConnected(false);
    const again = await s.loader.show(ref('p1'), 'image/png');
    expect(again).toMatchObject({ thumb: true, mimeType: 'image/jpeg' });
    expect(again!.bytes).toEqual(JPEG);
    expect(s.fetched).toEqual(['p1']);
  });

  test('a picture small already is its own thumbnail; GIFs and clips get none', async () => {
    const s = setup({ thumb: () => null });
    await s.loader.show(ref('small'), 'image/png');
    await new Promise((r) => setTimeout(r, 0));
    expect(s.files.has(refKey(thumbRef(ref('small'))))).toBe(false);
    const made: string[] = [];
    const t = setup({ thumb: (b) => { made.push(String(b.length)); return JPEG; } });
    await t.loader.show(ref('anim'), 'image/gif');
    await t.loader.show(ref('clip'), 'video/mp4');
    await new Promise((r) => setTimeout(r, 0));
    expect(made).toEqual([]);
  });

  test('nothing on disk and the computer asleep: nothing to show yet, nothing woken', async () => {
    const s = setup({ connected: false, thumb: () => JPEG });
    expect(await s.loader.show(ref('p2'), 'image/png')).toBeNull();
    expect(s.wakes()).toBe(0);
    expect(s.fetched).toEqual([]);
  });

  test('tells a thumbnail’s type from its bytes', () => {
    expect(sniffImage(JPEG)).toBe('image/jpeg');
    expect(sniffImage(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp');
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
    expect(thumbRef(ref('x'))).toEqual({ computer: 'own', id: 'x.thumb', name: 'thumb' });
  });
});
