/**
 * AppuBot Connect for clients: the gateway reached through the relay (connect.appubot.com) instead of over the
 * network, end to end encrypted with the Mac (protocol `connect.ts`). The same channel runs straight to the Mac on the
 * same Wi-Fi (`directSession`: a WebSocket to the gateway's SECURE_PATH instead of the relay's join), so the local
 * network never sees the device token or anything else in the clear.
 *
 * A `RelaySession` is one join socket to the Mac's room (or one direct socket): the phone says hello with a fresh X25519 key, and sends
 * nothing else until the Mac's reply (its own fresh key and a sealed READY) opens with keys that need the Mac key
 * pinned at pairing (only the real Mac can make one; protocol `phoneHandshake`). Everything for that Mac then goes
 * over it, multiplexed by id: HTTP requests (`request`, bodies in chunks both ways, at most CHANNEL_WINDOW of them in
 * flight) and gateway WebSockets (`openSocket`, a `RelaySocket` that GatewayClient drives like a browser WebSocket;
 * long frames cross in pieces). A message that doesn't open (cut, replayed, tampered) ends the session, and the next
 * `relaySession` makes a new one. `relaySession` keeps one live session per room and makes a new one after it drops;
 * `relayFetch` turns a session into a fetch for pairing, health checks and uploads.
 *
 * The cipher is `channelCipher()`: the one the app registered (the phone: expo-crypto's native AES-GCM, whose answers
 * are promises that may settle in any order), else this runtime's own. Each message's number is taken when it is sealed
 * or opened, in call or arrival order, and `InOrder` hands the answers on in that same order: sealed messages go out,
 * and opened ones are handled, strictly one after another, never a later one first.
 */
import { CONNECT_RELAY_URL, SECURE_PATH, bytesText, hostRoute, hostUrl, textBytes, type FileAttachment } from '@appubot/protocol';
import { GatewayError } from './errors';
import { type BodySource, NULL_BODY, type RelayResponse, RelaySession, type RelaySessionOptions, concat, toBytes } from './relaySession';
export { type WebSocketLike, type RelayTransport, type RelayTransportCtor, NO_HOST_MESSAGE, RELAY_BUSY_MESSAGE, setRelayAllowed, type RelaySessionOptions, type RelayRequest, type RelayResponse, type BodySource, CLOUD_READY_TIMEOUT_MS, RelaySession, RelaySocket } from './relaySession';

/* ---------- one session per room ---------- */

const sessions = new Map<string, RelaySession>();
/** rooms whose last session failed before READY: the same failure is answered until `until`, so retries don't flood the relay */
const cooldowns = new Map<string, { until: number; fails: number; session: RelaySession }>();
const COOLDOWN_BASE_MS = 5000;
const COOLDOWN_MAX_MS = 60_000;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * The live session for a room, made when there is none (or the last one dropped). A room whose last session failed
 * before the Mac answered (not on Connect, refused, timed out) gets that failed session back for a while (5 s, then
 * up to a minute as failures repeat), since the relay limits how often a phone may join.
 */
export function relaySession(opts: Omit<RelaySessionOptions, 'direct'> & { connectId: string }): RelaySession {
  const key = opts.connectId;
  const live = sessions.get(key);
  if (live && live.state !== 'closed') {
    if (sameBytes(live.macKey, opts.macKey) && live.relayUrl === (opts.relayUrl ?? CONNECT_RELAY_URL).replace(/\/+$/, '')) return live;
    live.close();
  }
  const cool = cooldowns.get(key);
  if (cool && Date.now() < cool.until && sameBytes(cool.session.macKey, opts.macKey)) return cool.session;
  const s = new RelaySession(opts);
  sessions.set(key, s);
  const settle = (closed: RelaySession) => {
    if (sessions.get(key) === closed) sessions.delete(key);
    if (closed.everReady || !closed.error) { cooldowns.delete(key); return; }
    const fails = (cooldowns.get(key)?.fails ?? 0) + 1;
    // ±20%: phones that lost the relay together (it restarted) don't come back in step
    const wait = Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (fails - 1)) * (0.8 + Math.random() * 0.4);
    cooldowns.set(key, { fails, session: closed, until: Date.now() + wait });
  };
  if (s.state === 'closed') settle(s);
  else s.onClose(settle);
  return s;
}

/** Forget a room's failures so the next `relaySession` dials at once (the user asked to try again). */
export function retryRelaySoon(connectId: string): void {
  cooldowns.delete(connectId);
}

/* ---------- one direct session per address (the same Wi-Fi, or Tailscale) ---------- */

const directs = new Map<string, RelaySession>();

/** The Mac's channel socket at `host:port` (the Wi-Fi, Tailscale): `ws://<host>:<port>/secure` (an IPv6 address in brackets). */
export function directUrl(host: string, port: number): string {
  return `${hostUrl(host, port).replace(/^http/, 'ws')}${SECURE_PATH}`;
}

/**
 * An AppuBot Cloud computer's channel socket from its public address (`https://<slug>.agent37.app`, as the backend gives
 * it): `wss://<slug>.agent37.app/secure`. A `ws(s)://` base is kept as it is; a path on it is dropped.
 */
export function cloudDirectUrl(publicUrl: string): string {
  const u = new URL(publicUrl.trim());
  const scheme = u.protocol === 'http:' || u.protocol === 'ws:' ? 'ws:' : 'wss:';
  return `${scheme}//${u.host}${SECURE_PATH}`;
}

/** An address of an AppuBot Cloud computer: its public port on agent37.app (never a LAN, Tailscale or loopback address). */
export function isCloudUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return (u.protocol === 'https:' || u.protocol === 'wss:') && /\.agent37\.app$/i.test(u.hostname);
  } catch {
    return false;
  }
}

export interface DirectSessionOptions extends Omit<RelaySessionOptions, 'connectId' | 'direct' | 'relayUrl'> {
  /** the Mac's address on the Wi-Fi or Tailscale (with `port`) */
  host?: string;
  port?: number;
  /**
   * instead: the channel socket's whole URL (`wss://<slug>.agent37.app/secure`, `cloudDirectUrl`), for an AppuBot
   * Cloud computer; `cloud` is taken from it (`isCloudUrl`) unless given
   */
  url?: string;
}

/**
 * The live end-to-end session with the Mac at `host:port` on the same Wi-Fi or over Tailscale, made when there is none
 * (or the last one dropped). One per address carries the gateway socket and every request (files, uploads, pages), so
 * a handshake is made once, not per request. No cooldown: nothing in between limits how often the phone may try.
 */
export function directSession(opts: DirectSessionOptions): RelaySession {
  if (!opts.url && (opts.host === undefined || opts.port === undefined)) throw new Error('directSession needs a url, or a host and port');
  const url = opts.url ?? directUrl(opts.host!, opts.port!);
  const live = directs.get(url);
  if (live && live.state !== 'closed') {
    if (sameBytes(live.macKey, opts.macKey)) return live;
    live.close();
  }
  const { host: _h, port: _p, url: _u, ...rest } = opts;
  const cloud = opts.cloud ?? isCloudUrl(url);
  const s = new RelaySession({ ...rest, direct: url, cloud, overTailscale: !cloud && opts.host !== undefined && hostRoute(opts.host) === 'tailscale' });
  directs.set(url, s);
  const forget = (closed: RelaySession) => { if (directs.get(url) === closed) directs.delete(url); };
  if (s.state === 'closed') forget(s);
  else s.onClose(forget);
  return s;
}

/** Close every session, through the relay and direct (switching computers, tests). */
export function closeRelaySessions(): void {
  for (const s of [...sessions.values(), ...directs.values()]) s.close();
  sessions.clear();
  directs.clear();
  cooldowns.clear();
}

/* ---------- fetch through a session ---------- */

/** `path?query` of a URL, any scheme (`connect://room/api/pair?x=1` → `/api/pair?x=1`). */
export function pathOfUrl(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^#]*)/i.exec(url.trim());
  const rest = m ? m[1]! : url.replace(/#.*$/, '');
  if (!rest) return '/';
  return rest.startsWith('/') ? rest : rest.startsWith('?') ? `/${rest}` : `/${rest}`;
}

function headerRecord(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (typeof (h as { forEach?: unknown }).forEach === 'function' && !Array.isArray(h)) {
    (h as { forEach(fn: (v: string, k: string) => void): void }).forEach((v, k) => { out[k.toLowerCase()] = String(v); });
    return out;
  }
  const entries = Array.isArray(h) ? (h as [string, string][]) : Object.entries(h as Record<string, string>);
  for (const [k, v] of entries) out[k.toLowerCase()] = String(v);
  return out;
}

async function bodyBytes(body: unknown, headers: Record<string, string>): Promise<Uint8Array | undefined> {
  if (body == null) return undefined;
  if (typeof body === 'string') {
    headers['content-type'] ??= 'text/plain;charset=UTF-8';
    return textBytes(body);
  }
  const bytes = toBytes(body);
  if (bytes) return bytes;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    headers['content-type'] ??= 'application/x-www-form-urlencoded;charset=UTF-8';
    return textBytes(body.toString());
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    throw new GatewayError('unsupported', 'Form data can’t go through AppuBot Connect: send the bytes with uploadBytes');
  }
  const blob = body as { arrayBuffer?: () => Promise<ArrayBuffer>; type?: string };
  if (typeof blob.arrayBuffer === 'function') {
    if (blob.type) headers['content-type'] ??= blob.type;
    return new Uint8Array(await blob.arrayBuffer());
  }
  throw new GatewayError('unsupported', 'This kind of request body can’t go through AppuBot Connect');
}

/** A fetch Response for a relay answer: the global Response where there is one, else a small stand-in. */
export function relayResponse(r: RelayResponse): Response {
  // Always this stand-in, never the global Response: React Native's fetch polyfill reads a byte body's text() one
  // byte per character (Latin-1), which garbled every non-ASCII letter (a Mac named "Sarthak’s" came out
  // "Sarthakâ€™s"). bytesText decodes UTF-8 the same on every runtime.
  const body = NULL_BODY.has(r.status) ? new Uint8Array(0) : r.body;
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    statusText: '',
    url: '',
    redirected: false,
    headers: { get: (n: string) => r.headers[n.toLowerCase()] ?? null, has: (n: string) => n.toLowerCase() in r.headers },
    text: async () => bytesText(body),
    json: async () => JSON.parse(bytesText(body)) as unknown,
    arrayBuffer: async () => new Uint8Array(body).buffer,
    // the window's cloud files (thumbnails, players) are blob: URLs of these; React Native can't make a Blob of bytes,
    // and never asks
    blob: async () => new Blob([new Uint8Array(body)], { type: r.headers['content-type'] ?? '' }),
  } as unknown as Response;
}

/**
 * A fetch that goes through AppuBot Connect: the URL's path and query (its scheme and host are ignored; use
 * `connect://<room>`), with string, bytes, URLSearchParams or Blob bodies (not FormData: see `uploadBytes`). `session`
 * may be a function, so each call gets the room's live session.
 */
export function relayFetch(session: RelaySession | (() => RelaySession)): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : 'href' in input ? input.href : input.url;
    const s = typeof session === 'function' ? session() : session;
    const headers = headerRecord(init.headers);
    const body = await bodyBytes(init.body, headers);
    const res = await s.request({ method: init.method ?? 'GET', path: pathOfUrl(url), headers }, body, { signal: init.signal ?? undefined });
    return relayResponse(res);
  }) as typeof fetch;
}

/* ---------- multipart bodies ---------- */

export interface MultipartFile { name: string; type: string; data: Uint8Array }

function quoteField(s: string): string {
  return s.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function newBoundary(): string {
  let b = '----AppuBotFormBoundary';
  for (let i = 0; i < 24; i++) b += 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)];
  return b;
}

const textField = (b: string, name: string, value: string) => textBytes(`--${b}\r\nContent-Disposition: form-data; name="${quoteField(name)}"\r\n\r\n${value}\r\n`);
const fileHead = (b: string, name: string, file: { name: string; type: string }) =>
  textBytes(`--${b}\r\nContent-Disposition: form-data; name="${quoteField(name)}"; filename="${quoteField(file.name)}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`);

/** A multipart/form-data body built by hand (what FormData sends), for transports that need the bytes. */
export function multipartBody(fields: ReadonlyArray<readonly [string, string | MultipartFile]>, boundary?: string): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const b = boundary || newBoundary();
  const parts: Uint8Array[] = [];
  for (const [name, value] of fields) {
    if (typeof value === 'string') {
      parts.push(textField(b, name, value));
    } else {
      parts.push(fileHead(b, name, value));
      parts.push(value.data);
      parts.push(textBytes('\r\n'));
    }
  }
  parts.push(textBytes(`--${b}--\r\n`));
  return { body: concat(parts), contentType: `multipart/form-data; boundary=${b}` };
}

/**
 * `POST /api/files` through a session with the file read piece by piece (`pieces`, e.g. from disk): the same multipart
 * form as `uploadBytes`, its bytes going out as they're read and at most CHANNEL_WINDOW ahead of the Mac, so a big
 * video never sits whole in the phone's memory. `pieces` is closed however it ends.
 */
export async function uploadStream(
  session: RelaySession, token: string, file: { name: string; type: string; pieces: BodySource }, threadId?: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<FileAttachment> {
  const b = newBoundary();
  const tail = concat([textBytes('\r\n'), ...(threadId ? [textField(b, 'threadId', threadId)] : []), textBytes(`--${b}--\r\n`)]);
  // the form's head, the file's pieces, then its tail
  let stage: 'head' | 'file' | 'tail' | 'done' = 'head';
  const body: BodySource = {
    read: async () => {
      if (stage === 'head') { stage = 'file'; return fileHead(b, 'file', file); }
      if (stage === 'file') {
        const piece = await file.pieces.read();
        if (piece) return piece;
        stage = 'tail';
      }
      if (stage === 'tail') { stage = 'done'; return tail; }
      return null;
    },
    close: () => file.pieces.close?.(),
  };
  const res = await session.request({ method: 'POST', path: '/api/files', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${b}` } }, body, opts);
  if (res.status < 200 || res.status >= 300) throw new GatewayError('upload_failed', `Upload failed (${res.status})`);
  return JSON.parse(bytesText(res.body)) as FileAttachment;
}
