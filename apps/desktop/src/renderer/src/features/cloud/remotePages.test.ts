/**
 * A cloud computer's pages in the chat, stale-while-revalidate: a kept copy shows without the computer, a missing one
 * waits for it to be connected, a stale one is checked once in the background and swapped in only when it changed,
 * and an older core falls back to keeping the page as a chat file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { method: string; params: Record<string, unknown> }[] = [];
const kept = new Map<string, { path: string; checkedAt: number; savedAt: number; hash: string; html: string }>();
let unknownMethod = false;
const fetched: string[] = [];
let remoteHtml = '<p>v1</p>';

vi.mock('@appubot/client', () => {
  class GatewayError extends Error { constructor(public code: string, msg: string) { super(msg); } }
  class GatewayClient {}
  return { GatewayError, GatewayClient, uploadFile: vi.fn() };
});
vi.mock('../../lib/gateway', async () => {
  const { GatewayError } = await import('@appubot/client');
  return {
    cloudGateway: () => ({ state: 'connected' }),
    localGateway: () => ({
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (unknownMethod && method.startsWith('cloudAccount.page')) throw new (GatewayError as unknown as new (c: string, m: string) => Error)('unknown_method', 'no');
        const key = `${params.team ?? ''}:${params.id}`;
        if (method === 'cloudAccount.pageGet') { const k = kept.get(key); return k ? { path: k.path, checkedAt: k.checkedAt, savedAt: k.savedAt, hash: k.hash } : null; }
        if (method === 'cloudAccount.pageSet') {
          const html = String(params.html);
          const before = kept.get(key);
          const changed = before?.html !== html;
          const rec = { path: `/cloud-pages/own/${params.id}?v=k&h=${html.length}${html.slice(3, 5)}`, checkedAt: Date.now(), savedAt: Date.now(), hash: html, html };
          kept.set(key, rec);
          return { ...rec, changed };
        }
        if (method === 'files.pageView') return { path: `/pages/${params.id}?v=x` };
        throw new Error(`unexpected ${method}`);
      },
    }),
  };
});
vi.mock('./cloudClient', () => ({
  cloudFileBlob: async (_c: unknown, f: { id: string }) => { fetched.push(f.id); return new Blob([remoteHtml]); },
}));

async function load() {
  vi.resetModules();
  return import('./remotePages');
}

beforeEach(() => {
  calls.length = 0; kept.clear(); fetched.length = 0; unknownMethod = false; remoteHtml = '<p>v1</p>';
});

const file = { id: 'file_1', name: 'Chart.html' };

describe('remotePagePath', () => {
  it('a miss while the computer sleeps waits (nothing fetched, nothing woken)', async () => {
    const { remotePagePath } = await load();
    expect(await remotePagePath('own', undefined, file, { fetch: false })).toBeNull();
    expect(fetched).toEqual([]);
  });

  it('a miss while connected brings it once and keeps it; then it shows from the copy, asleep or not', async () => {
    const { remotePagePath } = await load();
    const [a, b] = await Promise.all([remotePagePath('own', undefined, file, { fetch: true }), remotePagePath('own', undefined, file, { fetch: true })]);
    expect(fetched).toEqual(['file_1']);
    expect(a?.path).toContain('/cloud-pages/own/file_1');
    expect(b?.path).toBe(a?.path);
    const again = await remotePagePath('own', undefined, file, { fetch: false });
    expect(again?.path).toBe(a?.path);
    expect(fetched).toEqual(['file_1']);
  });

  it('a fresh copy isn’t fetched again; a stale one is checked once a run, and kept when the same', async () => {
    const { remotePagePath, RECHECK_MS } = await load();
    await remotePagePath('own', undefined, file, { fetch: true });
    fetched.length = 0;
    await remotePagePath('own', undefined, file, { fetch: true });
    expect(fetched).toEqual([]);
    // the next launch, the copy stale: checked in the background, the copy shown meanwhile
    kept.get(':file_1')!.checkedAt = Date.now() - RECHECK_MS - 1;
    const next = await load();
    const onChanged = vi.fn();
    const shown = await next.remotePagePath('own', undefined, file, { fetch: true, onChanged });
    expect(shown?.path).toContain('h=9v1');
    await vi.waitFor(() => expect(fetched).toEqual(['file_1']));
    await new Promise((r) => setTimeout(r, 0));
    expect(onChanged).not.toHaveBeenCalled();
    // once a run: a second stale look doesn't fetch again
    kept.get(':file_1')!.checkedAt = Date.now() - RECHECK_MS - 1;
    await next.remotePagePath('own', undefined, file, { fetch: true, onChanged });
    expect(fetched).toEqual(['file_1']);
  });

  it('a changed page found by the check reaches the card', async () => {
    const { remotePagePath, RECHECK_MS } = await load();
    await remotePagePath('own', undefined, file, { fetch: true });
    kept.get(':file_1')!.checkedAt = Date.now() - RECHECK_MS - 1;
    remoteHtml = '<p>v2</p>';
    const next = await load();
    const onChanged = vi.fn();
    await next.remotePagePath('own', undefined, file, { fetch: true, onChanged });
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith({ path: expect.stringContaining('h=9v2'), id: 'file_1' }));
  });

  it('a team’s page is asked for by its team', async () => {
    const { remotePagePath } = await load();
    await remotePagePath('team-acme', 'acme', file, { fetch: true });
    expect(calls.find((c) => c.method === 'cloudAccount.pageSet')?.params.team).toBe('acme');
  });
});

describe('an older core', () => {
  it('falls back to the old way (a chat file of this Mac) and stops asking for kept pages', async () => {
    unknownMethod = true;
    const { remotePagePath } = await load();
    // the old way needs this Mac's GatewayClient, which the stand-in isn't: it fails cleanly
    await expect(remotePagePath('own', undefined, file, { fetch: true })).rejects.toThrow('No gateway');
    await expect(remotePagePath('own', undefined, file, { fetch: true })).rejects.toThrow('No gateway');
    expect(calls.filter((c) => c.method === 'cloudAccount.pageGet')).toHaveLength(1);
  });
});
