import { describe, expect, test } from 'vitest';
import { probeHosts } from './index';

/** A fetch that answers /api/health per host: ok after `ms`, a refusal, or never (until aborted). */
function fakeFetch(plan: Record<string, { ok: boolean; ms: number; hostName?: string } | 'hang'>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    seen.push(host);
    const p = plan[host] ?? { ok: false, ms: 1 };
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      if (p === 'hang') return;
      setTimeout(() => resolve(new Response(JSON.stringify({ ok: p.ok, hostName: p.hostName }), { status: p.ok ? 200 : 403 })), p.ms);
    });
  }) as typeof fetch;
}

describe('probeHosts', () => {
  test('the preferred host wins when it answers', async () => {
    const r = await probeHosts(['100.1.1.1', '192.168.1.5'], 7890, { prefer: '192.168.1.5', staggerMs: 50, fetchImpl: fakeFetch({ '100.1.1.1': { ok: true, ms: 1 }, '192.168.1.5': { ok: true, ms: 20 } }) });
    expect(r).toEqual({ host: '192.168.1.5', baseUrl: 'http://192.168.1.5:7890' });
  });

  test('falls back to the local network when Tailscale is down, without waiting for the dead host', async () => {
    const t0 = Date.now();
    const r = await probeHosts(['100.1.1.1', 'mac.tail.ts.net', '192.168.1.5'], 7890, {
      timeoutMs: 2000, staggerMs: 40,
      fetchImpl: fakeFetch({ '100.1.1.1': 'hang', 'mac.tail.ts.net': 'hang', '192.168.1.5': { ok: true, ms: 5 } }),
    });
    expect(r?.host).toBe('192.168.1.5');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('a refused host hands over at once', async () => {
    const seen: string[] = [];
    const r = await probeHosts(['10.0.0.9', '100.1.1.1'], 7890, { staggerMs: 5000, fetchImpl: fakeFetch({ '10.0.0.9': { ok: false, ms: 1 }, '100.1.1.1': { ok: true, ms: 1 } }, seen) });
    expect(r?.host).toBe('100.1.1.1');
    expect(seen).toEqual(['10.0.0.9', '100.1.1.1']);
  });

  test('null when nothing answers', async () => {
    expect(await probeHosts(['100.1.1.1', '10.0.0.9'], 7890, { timeoutMs: 50, staggerMs: 10, fetchImpl: fakeFetch({ '100.1.1.1': 'hang', '10.0.0.9': { ok: false, ms: 1 } }) })).toBeNull();
    expect(await probeHosts([], 7890)).toBeNull();
  });

  test('IPv6 hosts are bracketed', async () => {
    const r = await probeHosts(['fd7a:115c:a1e0::1'], 7890, { fetchImpl: fakeFetch({ 'fd7a:115c:a1e0::1': { ok: true, ms: 1 } }) });
    expect(r?.baseUrl).toBe('http://[fd7a:115c:a1e0::1]:7890');
  });

  test('the same Wi-Fi beats Tailscale, even when Tailscale answers first', async () => {
    const seen: string[] = [];
    const r = await probeHosts(['100.101.1.1', 'mac.tail.ts.net', '192.168.1.5'], 7890, {
      staggerMs: 10, fetchImpl: fakeFetch({ '100.101.1.1': { ok: true, ms: 1 }, '192.168.1.5': { ok: true, ms: 60 } }, seen),
    });
    expect(r?.host).toBe('192.168.1.5');
    // Wi-Fi is tried first
    expect(seen[0]).toBe('192.168.1.5');
  });

  test('Tailscale is taken once the Wi-Fi address fails, or takes too long', async () => {
    const refused = await probeHosts(['100.101.1.1', '192.168.1.5'], 7890, { staggerMs: 10, fetchImpl: fakeFetch({ '100.101.1.1': { ok: true, ms: 1 }, '192.168.1.5': { ok: false, ms: 30 } }) });
    expect(refused?.host).toBe('100.101.1.1');
    const t0 = Date.now();
    const slow = await probeHosts(['100.101.1.1', '192.168.1.5'], 7890, { staggerMs: 10, betterWaitMs: 100, timeoutMs: 3000, fetchImpl: fakeFetch({ '100.101.1.1': { ok: true, ms: 1 }, '192.168.1.5': 'hang' }) });
    expect(slow?.host).toBe('100.101.1.1');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('accept skips another Mac at a stale address', async () => {
    const r = await probeHosts(['192.168.1.5', '100.1.1.1'], 7890, {
      staggerMs: 5000, accept: (h) => h.hostName === 'Mac',
      fetchImpl: fakeFetch({ '192.168.1.5': { ok: true, ms: 1, hostName: 'Other' }, '100.1.1.1': { ok: true, ms: 1, hostName: 'Mac' } }),
    });
    expect(r?.host).toBe('100.1.1.1');
  });
});
