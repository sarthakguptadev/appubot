/** The gateway's plain HTTP calls: pairing with a code, the health check, finding which address answers, uploading a file. */
import type { PairRequest, PairResponse, FileAttachment } from '@appubot/protocol';
import { hostRoute, hostUrl, orderByRoute, routeRank } from '@appubot/protocol';
import { GatewayError } from './errors';
import { multipartBody, type MultipartFile } from './connect';

/* ---------- pairing & health over HTTP ---------- */
export async function pairWithCode(baseUrl: string, req: PairRequest, fetchImpl: typeof fetch = fetch, timeoutMs = 8000): Promise<PairResponse> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(baseUrl.replace(/\/$/, '') + '/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req), signal: ctl.signal });
    const body = (await res.json().catch(() => ({}))) as { error?: string } & PairResponse;
    if (!res.ok) throw new GatewayError(res.status === 403 ? 'bad_code' : 'pair_failed', body.error ?? `Pairing failed (${res.status})`);
    return body;
  } finally { clearTimeout(t); }
}

export async function checkHealth(baseUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 4000): Promise<{ ok: boolean; version?: string; hostName?: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(baseUrl.replace(/\/$/, '') + '/api/health', { signal: ctl.signal });
    if (!res.ok) return { ok: false };
    return (await res.json()) as { ok: boolean; version?: string; hostName?: string };
  } catch { return { ok: false }; } finally { clearTimeout(t); }
}

export interface ProbeOptions {
  /** tried first among the addresses of its route, with a head start (the address that worked last time) */
  prefer?: string;
  /** each host's health check gives up after this long */
  timeoutMs?: number;
  /** "happy eyeballs": the next host starts this long after the previous one, or as soon as it fails */
  staggerMs?: number;
  /**
   * an answer over a worse route (Tailscale) waits this long for a better one still being tried (the same Wi-Fi) before
   * it is taken
   */
  betterWaitMs?: number;
  /** whether a healthy answer is the right Mac (e.g. its `hostName`); a rejected one counts as a failure */
  accept?: (health: { ok: boolean; version?: string; hostName?: string }) => boolean;
  fetchImpl?: typeof fetch;
  /**
   * the fetch to check one address with (the same Wi-Fi through its end-to-end session, `directSession`), or null to
   * leave that address out (it counts as failed at once); default `fetchImpl` for all
   */
  fetchFor?: (host: string, baseUrl: string) => typeof fetch | null;
}

/**
 * Find which of a Mac's addresses (Tailscale IPs, MagicDNS name, local-network IPs) answers right now, by the best
 * route: the same Wi-Fi before Tailscale (`orderByRoute`, `prefer` first among its route). Each starts `staggerMs`
 * after the one before or as soon as it fails; the first healthy answer wins, unless an address of a better route is
 * still being tried: then that one gets up to `betterWaitMs` more. Null when none answers.
 */
export function probeHosts(hosts: readonly string[], port: number, o: ProbeOptions = {}): Promise<{ host: string; baseUrl: string } | null> {
  const list = orderByRoute(hosts, o.prefer);
  const ranks = list.map((h) => routeRank(hostRoute(h)));
  const timeoutMs = o.timeoutMs ?? 3000;
  const staggerMs = o.staggerMs ?? 250;
  const betterWaitMs = o.betterWaitMs ?? 400;
  const fetchImpl = o.fetchImpl ?? fetch;
  if (!list.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    let started = 0;
    let finished = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let grace: ReturnType<typeof setTimeout> | null = null;
    /** the best healthy answer so far, and the addresses that failed */
    let best: { i: number; host: string; baseUrl: string } | null = null;
    const failed = new Set<number>();
    const finish = (r: { host: string; baseUrl: string } | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      resolve(r && { host: r.host, baseUrl: r.baseUrl });
    };
    /** an address of a better route than `rank` may still answer (they come first, so they have started) */
    const betterPending = (rank: number) => ranks.some((r, i) => r < rank && !failed.has(i));
    const startNext = () => {
      if (done || started >= list.length) return;
      if (timer) clearTimeout(timer);
      const i = started++;
      const host = list[i]!;
      const baseUrl = hostUrl(host, port);
      timer = started < list.length ? setTimeout(startNext, staggerMs) : null;
      const f = o.fetchFor ? o.fetchFor(host, baseUrl) : fetchImpl;
      void (f ? checkHealth(baseUrl, f, timeoutMs) : Promise.resolve({ ok: false })).then((h: { ok: boolean; version?: string; hostName?: string }) => {
        finished++;
        if (h.ok && (!o.accept || o.accept(h))) {
          if (!best || ranks[i]! < ranks[best.i]!) best = { i, host, baseUrl };
          if (!betterPending(ranks[best.i]!)) return finish(best);
          grace ??= setTimeout(() => finish(best), betterWaitMs);
          return;
        }
        failed.add(i);
        if (best && !betterPending(ranks[best.i]!)) return finish(best);
        if (started < list.length) startNext();
        else if (finished >= list.length) finish(best);
      });
    };
    startNext();
  });
}

/** Try several candidate hosts (Tailscale IP, MagicDNS, LAN) and return the base URL of the first that answers. */
export async function pickReachableHost(hosts: string[], port: number, fetchImpl: typeof fetch = fetch, prefer?: string): Promise<string | null> {
  return (await probeHosts(hosts, port, { fetchImpl, prefer }))?.baseUrl ?? null;
}

export function uploadFile(baseUrl: string, token: string, file: Blob | { uri: string; name: string; type: string }, name: string, threadId?: string, fetchImpl: typeof fetch = fetch): Promise<FileAttachment> {
  const fd = new FormData();
  // RN FormData accepts {uri,name,type}; browsers accept Blob
  fd.append('file', file as Blob, name);
  if (threadId) fd.append('threadId', threadId);
  return fetchImpl(baseUrl.replace(/\/$/, '') + '/api/files', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd }).then(async (r) => {
    if (!r.ok) throw new GatewayError('upload_failed', `Upload failed (${r.status})`);
    return (await r.json()) as FileAttachment;
  });
}

/**
 * Upload bytes the caller already holds (`POST /api/files`, the same multipart form as `uploadFile`), for transports
 * that can't stream a file by its URI: AppuBot Connect's `relayFetch` sends the body through the relay.
 */
export async function uploadBytes(baseUrl: string, token: string, file: MultipartFile, threadId?: string, fetchImpl: typeof fetch = fetch): Promise<FileAttachment> {
  const { body, contentType } = multipartBody([['file', file], ...(threadId ? [['threadId', threadId] as [string, string]] : [])]);
  const r = await fetchImpl(baseUrl.replace(/\/$/, '') + '/api/files', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': contentType }, body });
  if (!r.ok) throw new GatewayError('upload_failed', `Upload failed (${r.status})`);
  return (await r.json()) as FileAttachment;
}
