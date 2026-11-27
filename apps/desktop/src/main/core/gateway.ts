/**
 * Gateway: Hono HTTP app + node http server + ws WebSocketServer at /ws.
 *   connect → hello(snapshot) ; req → res ; events broadcast with seq ; replay on resume (lastSeq).
 * Remote-address policy (`peerPolicy`): loopback always; Tailscale CGNAT/ULA peers (checked with `tailscale whois`
 * when requireTailscalePeer); private local-network peers when allowLan (so a paired phone on the same Wi-Fi works
 * with Tailscale off); anything when bind='all'. Every route still needs a token (or the pairing code) past /api/health,
 * and the owner's and the bots' tokens count only from this computer (`local`): elsewhere only a paired device's does.
 * The local network (route `lan`) gets nothing in the clear but /api/health and SECURE_PATH: a phone there opens the
 * end-to-end channel (protocol connect.ts) at SECURE_PATH, ConnectService replays what it asks for on loopback with
 * SECURE_PEER_HEADER, and only that reaches /ws, pairing, files, uploads and pages (Wi-Fi is the one route nothing
 * else encrypts: loopback is this computer, Tailscale is WireGuard, AppuBot Connect is the same channel).
 * `bind: loopback` admits this computer alone: no Tailscale, no Wi-Fi, no channel (SECURE_PATH, AppuBot Connect).
 * SECURE_PATH costs a few key exchanges per hello, so each address gets a few such sockets at once and a few new ones a
 * minute; `/api/pair` takes small bodies only, and its tries count per address (an IPv6 /64 as one).
 * Every request and upgrade must name the gateway by an address, `localhost`, a Tailscale (`.ts.net`) or mDNS (`.local`)
 * name in its Host header (`hostAllowed`): a web page in the user's browser can't reach it through a name of its own
 * (DNS rebinding), and only the app's own pages get CORS answers.
 * Batching (`BATCH_FEATURE`): every gateway frame to a phone on AppuBot Connect is a sealed channel message and a relay
 * message, and the relay's work per message is what limits how many phones it carries. So a connection on a route in
 * BATCH_WINDOW_MS whose client reads batches gets its events packed (`Outbox`): at most one frame per window (what comes
 * after a quiet spell goes at the end of the tick), a message's deltas merged within it, answers and URGENT_EVENTS sent
 * with what waits at the end of the tick; live pictures and video never wait. Order and seqs are as they were.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isIP } from 'node:net';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { Duplex } from 'node:stream';
import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { getRequestListener, type HttpBindings } from '@hono/node-server';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { BATCH_FEATURE, BATCH_ITEMS_MAX, ConnectFrameSchema, GATEWAY_FEATURES, MIN_PROTOCOL_VERSION, Methods, PRESENCE_TTL_MS, PROTOCOL_VERSION, ReqFrameSchema, protocolMatch, SnapshotSchema, leanThread, type ConnectFrame, type EventPayload, type MethodName, type Thread } from '@appubot/protocol';
import type { CoreCtx } from './context';
import type { AgentContext, Role } from './auth';
import { ACTIVITY_METHODS } from './services/updateRestart';
import { buildHandlers, buildSnapshot, checkHiddenTurn, checkRole, checkWorking, type CallCtx, type Handlers } from './handlers';
import type { BusEvent } from './events';
import { errMsg, RpcError } from './util';
import { CHANNEL_FRAME_MAX, UPLOAD_MAX, CONNECT_PEER_HEADER, LINK_FILE_PATH, LINK_FIND_PATH, LINK_LIST_PATH, LINK_PUT_PATH, LINK_ROOTS_PATH, SECURE_PATH, SECURE_PEER_HEADER, addressKey, isPrivateLanAddress, type NetRoute, type Settings } from '@appubot/protocol';
import { isLoopback, isTailscaleIp, normalizeIp } from './services/tailscale';
import { FRAME_TIERS, addRtt, newLink, nextTier, type LinkState } from './liveFrames';
import { controlKey, liveModeFor, type Watcher } from './services/liveView';
import { STREAM_TAG_HEADER } from './services/connect';
import { PAGE_HEADERS, pageDocument } from './pageDocument';
import { UploadError, readUploadForm, type UploadedForm } from './uploadForm';

interface Conn {
  ws: WebSocket;
  ip: string;
  /** how this peer reached the gateway: Tailscale, the local network, or this Mac */
  route: NetRoute;
  tailscaleUser?: string;
  authed: boolean;
  role: Role;
  deviceId: string;
  isPairedDevice: boolean;
  /** a team's cloud computer: the team member this paired device belongs to (§6.11) */
  member?: string;
  agent?: AgentContext;
  alive: boolean;
  /** the Host header of the upgrade request: where this device reaches the gateway */
  host?: string;
  /** live-view quality for this link (liveFrames.ts), and when the last ping went out */
  link: LinkState;
  /** this connection as a live-view watcher (services/liveView.ts) */
  watcher: Watcher;
  pingAt?: number;
  /** the channel stream it came through (STREAM_TAG_HEADER): vouched for once it signs in */
  stream?: string;
  /** a phone's word that its app is in front (`devices.presence`), and when it said so */
  foreground?: boolean;
  presenceAt?: number;
  /** a desktop app's connection (`devices.presence {desk}`): `foreground` then means its person is at that Mac */
  desk?: boolean;
  /** its events and answers packed into fewer frames (a client that reads batches, on a route in BATCH_WINDOW_MS) */
  outbox?: Outbox;
}

type Delta = EventPayload<'message.delta'>;

/**
 * What waits to go to a batching connection, in order (each a whole frame as JSON), and how much of it there is. `tail`:
 * the last frame when it is a message delta, which the next delta for the same part extends in place.
 */
interface Outbox {
  windowMs: number;
  items: string[];
  bytes: number;
  tail?: { key: string; payload: Delta };
  /** the window's flush, and the one at the end of this tick (an answer, an urgent event) */
  timer?: ReturnType<typeof setTimeout>;
  soon?: ReturnType<typeof setImmediate>;
  /** when the last frame went out (`performance.now()`: the wall clock's jumps don't move it); the next waits a window */
  sentAt: number;
}

/**
 * Routes whose connections get batches, and their window: AppuBot Connect, where each frame costs the relay (a streaming
 * reply's deltas, 30 ms apart off the bus, become one frame per window). Every other route (this Mac, the same Wi-Fi,
 * Tailscale) gets each frame as it comes.
 */
export const BATCH_WINDOW_MS: Partial<Record<NetRoute, number>> = { connect: 120 };
/** a batch is sent once it holds this much (a frame within one channel chunk stays one relay message) */
const BATCH_MAX_BYTES = 128 * 1024;
/** how long a hello waits for computer use to finish starting at launch (ComputerService.whenReady) */
const HELLO_COMPUTER_WAIT_MS = 3000;
/** events that never wait for the window: the user is asked something, or a screenshot of what a bot just did */
const URGENT_EVENTS: ReadonlySet<string> = new Set(['permission.requested', 'question.asked', 'computer.frame']);

/**
 * `stream`: the channel stream a request came through; `authed`: a handler took its token (or code, or page key);
 * `pairKey`: what its pairing tries count against
 */
type Env = { Bindings: HttpBindings; Variables: { ip: string; tsUser?: string; route: NetRoute; stream?: string; authed?: boolean; pairKey: string } };

export type PeerVerdict =
  | { ok: true; route: NetRoute; verify?: 'whois' }
  | { ok: false; reason: string };

/**
 * Whether the gateway admits a peer at `ip`, and by which route. `verify: 'whois'` means the caller must still
 * confirm with `tailscale whois` that a Tailscale-range address is a real tailnet node (100.64/10 is also used by
 * carrier-grade NAT). Pure, for tests.
 */
export function peerPolicy(rawIp: string | undefined, g: Settings['gateway'], cloud = false): PeerVerdict {
  const ip = normalizeIp(rawIp);
  if (isLoopback(ip)) return { ok: true, route: 'local' };
  // an AppuBot Cloud computer: everyone else comes from the internet through its public port (route `cloud`), and
  // gets nothing but the end-to-end channel, Telegram's webhook and the health line (`plainCloud`), whatever the settings
  if (cloud) return { ok: true, route: 'cloud' };
  if (g.bind === 'loopback') return { ok: false, reason: 'gateway is loopback-only' };
  if (isTailscaleIp(ip)) return g.requireTailscalePeer ? { ok: true, route: 'tailscale', verify: 'whois' } : { ok: true, route: 'tailscale' };
  if (g.bind === 'all') return { ok: true, route: 'lan' };
  if (g.allowLan && isPrivateLanAddress(ip)) return { ok: true, route: 'lan' };
  return { ok: false, reason: g.allowLan ? 'only Tailscale and local-network peers are allowed' : 'only Tailscale peers are allowed' };
}

/** What a local-network peer that skipped the channel is told (an AppuBot from before it, or someone else on the Wi-Fi). */
const SECURE_REQUIRED = 'On the same Wi-Fi AppuBot only talks over its encrypted connection. Update the AppuBot app on your phone, or connect over Tailscale.';

/** A peer on the local network that didn't come through the channel: it may reach /api/health and SECURE_PATH only. */
export function plainLan(peer: { route?: NetRoute; secure?: boolean }): boolean {
  return peer.route === 'lan' && !peer.secure;
}

/**
 * A peer of an AppuBot Cloud computer's public port that didn't come through the channel: it may reach /api/health,
 * SECURE_PATH and Telegram's webhook (`TELEGRAM_PATH`) only, like `plainLan`.
 */
export function plainCloud(peer: { route?: NetRoute; secure?: boolean }): boolean {
  return peer.route === 'cloud' && !peer.secure;
}

/** Where Telegram delivers a cloud computer's updates: `/telegram/<channel id>` (checked by its secret token). */
export const TELEGRAM_PATH = '/telegram/';

/**
 * The role a signed-in connection gets. A device paired as `owner` (only an AppuBot Cloud computer pairs one, through
 * its control server: `DevicesService.startPairing`) is the owner there, with everything the computer's own window
 * has (agent keys, Vault secrets, model servers' keys, the gateway's settings, files to devices), since on the cloud
 * there is no window and the phone is the only hand the user has. Anywhere else such a row (a devices.json copied
 * from a cloud export, or edited by hand) is heard as `full`: a Mac's owner is its window alone.
 */
export function connectionRole(a: { kind: 'owner' | 'agent' | 'device'; role: Role }, cloud: boolean): Role {
  return a.kind === 'device' && a.role === 'owner' && !cloud ? 'full' : a.role;
}

/** What a cloud peer that skipped the channel is told. */
const CLOUD_SECURE_REQUIRED = 'AppuBot Cloud only talks over its encrypted connection. Update the AppuBot app.';

/** The paths a plain cloud peer may reach besides /api/health. */
function cloudOpenPath(path: string): boolean {
  return path === '/api/health' || path.startsWith(TELEGRAM_PATH);
}

/**
 * The address a request really came from on an AppuBot Cloud computer: the platform's edge terminates TLS and forwards
 * to the container, so the socket's address is the edge's, and a header has to tell the phones apart for the
 * per-address limits (pairing tries, channel sockets). The edge is Cloudflare's (`server: cloudflare` on every
 * `*.agent37.app` answer, checked 2026-11-13), which writes the address it saw into `CF-Connecting-IP` itself and
 * overwrites one a client sent, so that is taken first. `X-Forwarded-For` is only what is left without it: Cloudflare
 * appends to whatever the client put there, so its first entry is the client's own word, and anyone could take a
 * fresh "address" per request and walk past every per-address limit. Never read on a Mac.
 */
export function forwardedAddress(headers: Record<string, string | string[] | undefined>, fallback: string | undefined): string {
  const one = (name: string): string => { const raw = headers[name]; return (Array.isArray(raw) ? raw[0] : raw) ?? ''; };
  const edge = normalizeIp(one('cf-connecting-ip').trim());
  if (isIP(edge)) return edge;
  const ip = normalizeIp(one('x-forwarded-for').split(',')[0]?.trim() ?? '');
  return isIP(ip) ? ip : normalizeIp(fallback);
}

/**
 * `pairKey`: what its pairing tries count against when that isn't its address (a phone AppuBot Connect brought with no
 * address: its own stream)
 */
export interface PeerCheck { ok: boolean; route?: NetRoute; ip?: string; tailscaleUser?: string; reason?: string; secure?: boolean; stream?: string; pairKey?: string }

const PAIR_TRIES = 20;
const PAIR_WINDOW_MS = 10 * 60_000;
/** a pairing request is a code and a device's name: nothing bigger is read */
const PAIR_BODY_MAX = 16 * 1024;
/** channel sockets (SECURE_PATH) from one address at once, and new ones per address per window */
const SECURE_PER_ADDRESS = 8;
const SECURE_TRIES = 30;
const SECURE_WINDOW_MS = 60_000;

/** A `host` or `host:port` (IPv4, a name, or a bracketed IPv6), as sent in a Host header. */
const HOST_RE = /^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i;

/** a socket's frames before it has said who it is (the connect frame is a few hundred bytes) */
const PRE_AUTH_MAX_PAYLOAD = 64 * 1024;
/** after: a message with pictures inline */
const MAX_PAYLOAD = 64 * 1024 * 1024;
/** a socket that hasn't sent its connect frame by then is closed */
const CONNECT_TIMEOUT_MS = 5_000;
/** a live picture isn't queued behind this much unsent data (the next one comes soon) */
const LIVE_DROP_BYTES = 2 * 1024 * 1024;
/** a socket this far behind is closed: the device reconnects and resumes (`lastSeq`) rather than queueing forever */
const HOPELESS_BYTES = 32 * 1024 * 1024;

/**
 * Whether a Host header names this gateway the way a real client does: an IP address (v4 or bracketed v6),
 * `localhost`, a Tailscale MagicDNS name (`*.ts.net`), or a name only the local network resolves (one label, `.local`,
 * `.lan`, `.home.arpa`, `.internal`). Any other name is a page that got the browser to resolve its own domain to this
 * computer (DNS rebinding). Pure, for tests.
 */
export function hostAllowed(host: string | undefined, cloud = false): boolean {
  if (!host || !HOST_RE.test(host)) return false;
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.replace(/:\d+$/, '').replace(/\.$/, '').toLowerCase();
  if (host.startsWith('[')) return isIP(name) === 6;
  // an AppuBot Cloud computer is named by its public port's address, `<slug>.agent37.app`
  if (cloud && /\.agent37\.app$/.test(name)) return true;
  return isIP(name) === 4 || !name.includes('.') || /\.(ts\.net|local|lan|home\.arpa|internal)$/.test(name);
}

/**
 * Pages that may call the gateway from a browser engine: the app's own window (a `file://` page, `null` to Chromium,
 * or the dev server on localhost). Everything else gets no CORS answer, so another site can't read what it sends.
 */
export function corsOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  if (origin === 'null' || origin === 'file://') return origin;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i.test(origin) ? origin : null;
}

/** ws has no public way to change a socket's frame limit after the upgrade: its receiver keeps it here. */
function setMaxPayload(ws: WebSocket, bytes: number): void {
  const r = (ws as unknown as { _receiver?: { _maxPayload?: number } })._receiver;
  if (r && typeof r._maxPayload === 'number') r._maxPayload = bytes;
}

/** Where an app sign-in lands when it ran in a browser (the Mac's in-app window closes before reaching it). */
/** `app`: an app's own sign-in came back (its name, from AppuBot's own list); else Composio's. */
const SIGNED_IN_PAGE = (ok: boolean, app?: string) => `<!doctype html><meta charset="utf-8"><title>AppuBot</title><meta name="color-scheme" content="light dark">
<meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0"><div style="text-align:center;padding:0 24px">
<h2 style="font-weight:500">${ok ? (app ? `${app.replace(/[<>&"]/g, '')} is connected` : 'Signed in to Composio') : app ? `${app.replace(/[<>&"]/g, '')} isn’t connected` : 'Not signed in'}</h2><p style="opacity:.65">${ok ? (app ? 'You can close this tab and go back to AppuBot.' : 'You can close this tab and go back to AppuBot to connect your apps.') : 'The sign-in did not finish. Try again from Apps in AppuBot.'}</p></div>`;

export class Gateway {
  readonly app: Hono<Env>;
  private server: Server | null = null;
  private wss: WebSocketServer;
  private conns = new Set<Conn>();
  /** numbers each connection (live view knows its watchers by it) */
  private connSeq = 0;
  private handlers: Handlers;
  /** the channel's own sockets (SECURE_PATH): one phone stream each, run by ConnectService; their peer and liveness */
  private secureWss: WebSocketServer;
  private secure = new Map<WebSocket, { ip: string; alive: boolean }>();
  /** channel sockets per address (`addressKey`), from the upgrade on, and the new ones each address opened lately */
  private secureByAddress = new Map<string, number>();
  private secureTries = new Map<string, { n: number; until: number }>();
  private unsubBus: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  port = 0;

  constructor(private ctx: CoreCtx) {
    this.handlers = buildHandlers(ctx);
    // small until the socket has authenticated (`onConnect` raises it): nobody can make it buffer 64 MB unasked
    this.wss = new WebSocketServer({ noServer: true, maxPayload: PRE_AUTH_MAX_PAYLOAD });
    // a sealed channel message is never bigger than this (bodies and long frames cross in pieces)
    this.secureWss = new WebSocketServer({ noServer: true, maxPayload: CHANNEL_FRAME_MAX, perMessageDeflate: false });
    this.app = this.buildApp();
  }

  /* ----------------------------------------------------------- peer policy */

  /**
   * Who may talk to the gateway. `headers` tells the channel's traffic apart (services/connect.ts replays a phone's
   * requests on loopback): `CONNECT_PEER_HEADER` (the phone's address as the relay saw it) is admitted as route
   * `connect` while Connect is meant to run; `SECURE_PEER_HEADER` (the phone's address on its own channel socket, the
   * same Wi-Fi or Tailscale) is judged by that address as if the phone had come straight in. Both are `secure`, and
   * carry their stream's `STREAM_TAG_HEADER` (`stream`), which the gateway vouches for once that phone signs in. A
   * loopback peer that sets a header itself only gives up its own `local` route for a stricter one; with `bind:
   * loopback` neither is admitted (this computer alone).
   */
  async checkPeer(rawIp: string | undefined, headers: Record<string, string | string[] | undefined> = {}): Promise<PeerCheck> {
    const ip = normalizeIp(rawIp);
    const via = headers[CONNECT_PEER_HEADER];
    const direct = headers[SECURE_PEER_HEADER];
    const replay = isLoopback(ip) && ((typeof via === 'string' && !!via) || (typeof direct === 'string' && !!direct));
    // `bind: loopback` is this computer alone: not the phones the channel would replay for
    if (replay && !this.cloud && this.ctx.s.settings.get().gateway.bind === 'loopback') return { ok: false, reason: 'gateway is loopback-only' };
    const tag = headers[STREAM_TAG_HEADER];
    const stream = replay && typeof tag === 'string' && tag ? { stream: tag } : {};
    // the cloud computer: a channel stream's replays are its phone's (route `cloud`, whatever address the edge showed);
    // the relay's header is never admitted (Connect is off there)
    if (this.cloud && typeof direct === 'string' && direct && isLoopback(ip)) {
      const phoneIp = normalizeIp(direct);
      return { ok: true, route: 'cloud', ip: isIP(phoneIp) ? phoneIp : 'cloud', secure: true, ...(isIP(phoneIp) ? {} : { pairKey: stream.stream ? `cloud/${stream.stream}` : 'cloud' }), ...stream };
    }
    if (this.cloud && typeof via === 'string' && via && isLoopback(ip)) return { ok: false, reason: 'AppuBot Connect is off on AppuBot Cloud' };
    if (typeof via === 'string' && via && isLoopback(ip)) {
      if (!this.ctx.s.settings.get().connect.enabled || !this.ctx.s.connect.active()) return { ok: false, reason: 'AppuBot Connect is off' };
      // the phone's address counts pairing tries; a missing or loopback-looking one never passes for this computer
      const phoneIp = normalizeIp(via);
      if (isIP(phoneIp) && !isLoopback(phoneIp)) return { ok: true, route: 'connect', ip: phoneIp, secure: true, ...stream };
      // no address from the relay: its tries count per stream (never against phones whose address is known, nor other
      // such phones); one with no stream either (only a local process could send that) shares a bucket of its own
      return { ok: true, route: 'connect', ip: 'connect', secure: true, pairKey: stream.stream ? `connect/${stream.stream}` : 'connect', ...stream };
    }
    if (typeof direct === 'string' && direct && isLoopback(ip)) {
      const phoneIp = normalizeIp(direct);
      const r = await this.admit(phoneIp);
      return r.ok ? { ...r, ip: phoneIp, secure: true, ...stream } : r;
    }
    return this.admit(ip);
  }

  /** This gateway runs on an AppuBot Cloud computer (`CoreDeps.cloud`). */
  private get cloud(): boolean { return !!this.ctx.deps.cloud; }
  /** the app's own face for a page, for the app that asks for it (`?font=app`: the desktop window) */
  private pageFont(asked: string | undefined): { family: string; woff2: string } | null {
    if (asked !== 'app') return null;
    try { return this.ctx.deps.pageFont?.() ?? null; } catch { return null; }
  }

  /** `peerPolicy` for an address, with `tailscale whois` where it asks for it. */
  private async admit(ip: string): Promise<PeerCheck> {
    const v = peerPolicy(ip, this.ctx.s.settings.get().gateway, this.cloud);
    if (!v.ok) return v;
    if (v.verify === 'whois') {
      const user = await this.ctx.s.tailscale.whois(ip);
      if (!user) return { ok: false, reason: 'peer is not a verified Tailscale node' };
      return { ok: true, route: v.route, ip, tailscaleUser: user };
    }
    return { ok: true, route: v.route, ip };
  }

  /**
   * Pairing attempts per address (an IPv6 /64 as one: one phone or home can take any address in it), or per the key a
   * peer check gave instead (`PeerCheck.pairKey`): `PAIR_TRIES` in `PAIR_WINDOW_MS`, then 429 (the code itself allows
   * five wrong tries per address).
   */
  private pairTries = new Map<string, { n: number; until: number }>();
  pairAllowed(ipOrKey: string, now = Date.now()): boolean {
    return countTry(this.pairTries, addressKey(ipOrKey) || ipOrKey, PAIR_TRIES, PAIR_WINDOW_MS, now);
  }

  /**
   * Local-network peers lose the connection at once when the owner turns allowLan off (their channel sockets too), and
   * Connect peers when AppuBot Connect goes off.
   */
  private dropDisallowed(): void {
    const g = this.ctx.s.settings.get().gateway;
    const connectOn = this.ctx.s.settings.get().connect.enabled && this.ctx.s.connect.active();
    for (const c of this.conns) {
      if (c.route === 'local' || c.route === 'cloud' || (c.route === 'connect' ? connectOn && g.bind !== 'loopback' : peerPolicy(c.ip, g).ok)) continue;
      this.conns.delete(c);
      if (c.isPairedDevice) this.ctx.s.devices.setOnline(c.deviceId, false);
      try { c.ws.close(1008, 'not allowed from this network'); } catch { /* ignore */ }
    }
    if (this.cloud) return;
    for (const [ws, s] of this.secure) if (g.bind === 'loopback' || !peerPolicy(s.ip, g).ok) ws.terminate();
  }

  /* ------------------------------------------------------------------ HTTP */

  private buildApp(): Hono<Env> {
    const app = new Hono<Env>();
    app.use('*', async (c, next) => {
      if (!hostAllowed(c.req.header('host'), this.cloud)) return c.json({ error: 'Forbidden: unknown host' }, 403);
      const headers = c.env?.incoming?.headers ?? {};
      const r = await this.checkPeer(c.env?.incoming?.socket?.remoteAddress, headers);
      if (!r.ok) return c.json({ error: `Forbidden: ${r.reason}` }, 403);
      // on the Wi-Fi a token, a pairing code or a file never goes in the clear: only through the channel
      if (plainLan(r) && c.req.path !== '/api/health') return c.json({ error: SECURE_REQUIRED, code: 'secure_required' }, 403);
      // the cloud's public port likewise, plus Telegram's webhook (checked by its own secret)
      if (plainCloud(r) && !cloudOpenPath(c.req.path)) return c.json({ error: CLOUD_SECURE_REQUIRED, code: 'secure_required' }, 403);
      const ip = r.ip ?? (this.cloud && r.route === 'cloud' ? forwardedAddress(headers, c.env?.incoming?.socket?.remoteAddress) : normalizeIp(c.env?.incoming?.socket?.remoteAddress));
      c.set('ip', ip);
      c.set('pairKey', r.pairKey ?? (addressKey(ip) || ip));
      c.set('route', r.route ?? 'lan');
      if (r.tailscaleUser) c.set('tsUser', r.tailscaleUser);
      if (r.stream) c.set('stream', r.stream);
      await next();
      // a channel stream whose request carried a real credential and was answered: a paired phone, it may stay
      if (r.stream && c.get('authed') && c.res.status < 400) this.ctx.s.connect.vouch(r.stream);
    });
    // health answers without CORS: no web page reads this computer's name or version
    app.use('*', async (c, next) => {
      if (c.req.path === '/api/health') return next();
      return cors({ origin: (o) => corsOrigin(o), allowHeaders: ['authorization', 'content-type', 'range'], allowMethods: ['GET', 'POST', 'OPTIONS'] })(c, next);
    });

    const tokenOf = (c: { req: { header(n: string): string | undefined; query(n: string): string | undefined } }) => {
      const h = c.req.header('authorization');
      if (h?.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
      return c.req.query('token');
    };

    app.get('/api/health', (c) => c.json({ ok: true, version: this.ctx.deps.version, hostName: this.ctx.deps.hostName }));

    // an AppuBot Cloud computer's Telegram bots get their updates here (webhooks wake the computer; `X-Telegram-Bot-Api-
    // Secret-Token` proves them); a Mac's Telegram polls instead, and has no such route
    if (this.cloud) {
      app.post(`${TELEGRAM_PATH}:id`, async (c) => {
        c.set('authed', true);
        return this.ctx.s.channels.webhook(c.req.param('id'), c);
      });
    }

    // the browser back from Composio's sign-in (OAuth with PKCE; the state ties it to the sign-in AppuBot started)
    app.get('/apps/signed-in', async (c) => {
      const { ok, app } = await this.ctx.s.composio.returned({ code: c.req.query('code'), state: c.req.query('state'), error: c.req.query('error') });
      return c.html(SIGNED_IN_PAGE(ok, app));
    });
    // the browser back from a custom connector's own sign-in
    app.get('/connectors/signed-in', async (c) => {
      const name = this.ctx.s.connectors.signingIn(c.req.query('state'));
      const ok = await this.ctx.s.connectors.finish({ code: c.req.query('code'), state: c.req.query('state'), error: c.req.query('error') });
      return c.html(SIGNED_IN_PAGE(!!ok, name ?? 'The connector'));
    });

    // no token yet here: a few KB at most (a longer one is refused by its declared length, or as soon as it passes it)
    app.post('/api/pair', bodyLimit({ maxSize: PAIR_BODY_MAX, onError: (c) => c.json({ error: 'Pairing request too large' }, 413) }), async (c) => {
      // AppuBot Connect puts this route on the internet: a few tries per address, on top of the code's own five
      if (!this.pairAllowed(c.get('pairKey'))) return c.json({ error: 'Too many pairing attempts from this address. Try again in a few minutes.' }, 429);
      const body = await c.req.json().catch(() => null);
      const [status, out] = await this.ctx.s.devices.pair(body, c.get('ip'), c.get('tsUser'), c.get('route'), c.get('pairKey'));
      if (status === 200) c.set('authed', true);
      return c.json(out, status as 200 | 400 | 403 | 409);
    });

    // the token first: nobody without one may make this computer read (and write to disk) a body
    const uploadAuth: MiddlewareHandler<Env> = async (c, next) => {
      const a = this.ctx.auth.verify(tokenOf(c), c.get('route'));
      if (a.kind === 'invalid' || a.kind === 'revoked') return c.json({ error: 'Unauthorized' }, 401);
      c.set('authed', true);
      await next();
    };
    // read as it comes (`uploadForm.ts`): the file goes straight to disk, so a bundle of hundreds of MB never sits in memory
    app.post('/api/files', uploadAuth, async (c) => {
      const a = this.ctx.auth.verify(tokenOf(c), c.get('route'));
      if (a.kind === 'invalid' || a.kind === 'revoked') return c.json({ error: 'Unauthorized' }, 401);
      const declared = Number(c.req.header('content-length') ?? NaN);
      if (declared > UPLOAD_MAX) return c.json({ error: 'File too large' }, 413);
      const files = this.ctx.s.files;
      const filePath = files.incomingPath();
      let form: UploadedForm;
      try {
        form = await readUploadForm(c.req.raw.body, c.req.header('content-type'), { filePath, maxSize: UPLOAD_MAX });
      } catch (e) {
        if (e instanceof UploadError) return c.json({ error: e.status === 413 ? 'File too large' : e.message }, e.status);
        throw e;
      }
      const drop = () => rm(filePath, { force: true }).catch(() => undefined);
      if (!form.file) { void drop(); return c.json({ error: 'Expected multipart field "file"' }, 400); }
      const threadId = a.kind === 'agent' ? a.agent.threadId : form.fields.threadId || undefined;
      if (threadId && !this.ctx.s.threads.get(threadId)) { void drop(); return c.json({ error: 'Unknown thread' }, 404); }
      try {
        return c.json(files.adopt(filePath, form.file.name || 'upload', form.file.type, threadId));
      } catch (e) {
        void drop();
        return c.json({ error: errMsg(e) }, 500);
      }
    });

    // a bot's visual reply, for the chat's sandboxed frame: its own viewing key (`files.pageView`), never the app's token
    app.get('/pages/:id', (c) => {
      const id = c.req.param('id');
      const files = this.ctx.s.files;
      const want = Buffer.from(files.pageViewKey(id));
      const got = Buffer.from(c.req.query('v') ?? '');
      if (got.length !== want.length || !timingSafeEqual(got, want)) return c.text('Not found', 404);
      c.set('authed', true);
      const rec = files.getRecord(id);
      if (!rec || rec.mimeType !== 'text/html' || !existsSync(rec.storedPath)) return c.text('Not found', 404);
      const theme = c.req.query('theme') === 'light' ? 'light' : 'dark';
      return new Response(pageDocument(readFileSync(rec.storedPath, 'utf8'), { id, theme, font: this.pageFont(c.req.query('font')), still: c.req.query('still') === '1' }), { headers: PAGE_HEADERS });
    });

    // a cloud computer's page as this Mac keeps it (services/cloudPages.ts), framed like a page of this Mac's own
    app.get('/cloud-pages/:computer/:id', (c) => {
      const computer = c.req.param('computer');
      const id = c.req.param('id');
      const pages = this.ctx.s.cloudAccount.pages;
      let want: Buffer;
      try { want = Buffer.from(pages.viewKey(computer, id)); } catch { return c.text('Not found', 404); }
      const got = Buffer.from(c.req.query('v') ?? '');
      if (got.length !== want.length || !timingSafeEqual(got, want)) return c.text('Not found', 404);
      c.set('authed', true);
      const html = pages.serve(computer, id);
      if (html === null) return c.text('Not found', 404);
      const theme = c.req.query('theme') === 'light' ? 'light' : 'dark';
      return new Response(pageDocument(html, { id, theme, font: this.pageFont(c.req.query('font')), still: c.req.query('still') === '1' }), { headers: PAGE_HEADERS });
    });

    app.get('/files/:id', (c) => {
      const a = this.ctx.auth.verify(tokenOf(c), c.get('route'));
      if (a.kind === 'invalid' || a.kind === 'revoked') return c.json({ error: 'Unauthorized' }, 401);
      // the app's window and paired devices only: a bot reads files on disk, never other chats' through here
      if (a.kind === 'agent') return c.json({ error: 'Forbidden' }, 403);
      c.set('authed', true);
      const rec = this.ctx.s.files.getRecord(c.req.param('id'));
      if (!rec || !existsSync(rec.storedPath)) return c.json({ error: 'Not found' }, 404);
      const size = statSync(rec.storedPath).size;
      const ascii = rec.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      const disp = c.req.query('download') ? 'attachment' : 'inline';
      const headers: Record<string, string> = {
        'content-type': rec.mimeType || 'application/octet-stream',
        'content-disposition': `${disp}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(rec.name)}`,
        // a file id is one file for good (a new upload is a new id): the window never asks again for what it holds
        'cache-control': 'private, max-age=604800, immutable',
        'accept-ranges': 'bytes',
      };
      // a part of the file (the chat's audio and video players seek with these)
      const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '');
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
        const part = Readable.toWeb(createReadStream(rec.storedPath, { start, end })) as unknown as ReadableStream;
        return new Response(part, { status: 206, headers: { ...headers, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}` } });
      }
      const stream = Readable.toWeb(createReadStream(rec.storedPath)) as unknown as ReadableStream;
      return new Response(stream, { headers: { ...headers, 'content-length': String(size) } });
    });

    // another of the person's computers reading the folders lent to it (`services/macLink.ts`): its own token, on
    // these five paths only; every path is checked against the lent folders there (and a save against their switches)
    const linked = (c: { req: { header(n: string): string | undefined; query(n: string): string | undefined }; set(k: 'authed', v: boolean): void }) => {
      // the token as a Bearer only: never in an address
      const h = c.req.header('authorization');
      const link = this.ctx.s.macLink.verify(h?.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : undefined);
      if (link) c.set('authed', true);
      return link;
    };
    const linkError = (c: { json(body: unknown, status: number): Response }, e: unknown) => {
      const code = e instanceof RpcError ? e.code : 'internal';
      const status = code === 'forbidden' ? 403 : code === 'not_found' ? 404 : code === 'invalid_params' ? 400 : code === 'too_large' ? 413 : code === 'unavailable' ? 503 : 500;
      if (status >= 500) this.ctx.log.warn('mac link: a request failed', errMsg(e));
      return c.json({ error: e instanceof RpcError ? e.message : 'That couldn’t be read.', code }, status);
    };
    app.get(LINK_ROOTS_PATH, (c) => {
      if (!linked(c)) return c.json({ error: 'Unauthorized' }, 401);
      return c.json(this.ctx.s.macLink.roots());
    });
    app.get(LINK_LIST_PATH, async (c) => {
      if (!linked(c)) return c.json({ error: 'Unauthorized' }, 401);
      try { return c.json(await this.ctx.s.macLink.list(c.req.query('path') ?? '')); } catch (e) { return linkError(c, e); }
    });
    app.get(LINK_FIND_PATH, async (c) => {
      if (!linked(c)) return c.json({ error: 'Unauthorized' }, 401);
      try { return c.json(await this.ctx.s.macLink.find(c.req.query('q') ?? '', c.req.query('path') || undefined)); } catch (e) { return linkError(c, e); }
    });
    app.get(LINK_FILE_PATH, async (c) => {
      if (!linked(c)) return c.json({ error: 'Unauthorized' }, 401);
      try {
        const f = await this.ctx.s.macLink.fileAt(c.req.query('path') ?? '');
        const stream = Readable.toWeb(createReadStream(f.path)) as unknown as ReadableStream;
        return new Response(stream, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(f.size), 'x-appubot-name': encodeURIComponent(f.name), 'cache-control': 'no-store' } });
      } catch (e) { return linkError(c, e); }
    });
    // a bot there saving a file here: the token before any byte of the body is read
    app.post(LINK_PUT_PATH, async (c) => {
      const link = linked(c);
      if (!link) return c.json({ error: 'Unauthorized' }, 401);
      const declared = Number(c.req.header('content-length'));
      try {
        const body = c.req.raw.body as unknown as AsyncIterable<Uint8Array> | null;
        return c.json(await this.ctx.s.macLink.put(c.req.query('path') ?? '', body, link.id, Number.isFinite(declared) && declared >= 0 && c.req.header('content-length') ? declared : undefined));
      } catch (e) { return linkError(c, e); }
    });

    app.notFound((c) => c.json({ error: 'Not found' }, 404));
    app.onError((e, c) => {
      this.ctx.log.error('http error', errMsg(e));
      return c.json({ error: 'Internal error' }, 500);
    });
    return app;
  }

  /* ------------------------------------------------------------- listening */

  async listen(preferredPort: number, opts: { tryNext?: number; host?: string } = {}): Promise<number> {
    const listener = getRequestListener(this.app.fetch);
    const tries = preferredPort === 0 ? 1 : (opts.tryNext ?? 10) + 1;
    let lastErr: unknown;
    for (let i = 0; i < tries; i++) {
      const port = preferredPort === 0 ? 0 : preferredPort + i;
      const server = createServer((req, res) => { void listener(req, res); });
      server.on('upgrade', (req, socket, head) => { void this.onUpgrade(req, socket, head); });
      try {
        const bound = await this.tryListen(server, port, opts.host);
        this.server = server;
        this.port = bound;
        const offBus = this.ctx.bus.on((e) => this.broadcast(e));
        const offSettings = this.ctx.s.settings.onChange((next, prev) => {
          const a = next.gateway; const b = prev.gateway;
          if (a.bind !== b.bind || a.allowLan !== b.allowLan || a.requireTailscalePeer !== b.requireTailscalePeer) this.dropDisallowed();
        });
        this.unsubBus = () => { offBus(); offSettings(); };
        this.heartbeat = setInterval(() => this.ping(), 30_000);
        this.heartbeat.unref?.();
        return bound;
      } catch (e) {
        lastErr = e;
        server.close();
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') break;
        this.ctx.log.warn(`port ${port} busy; trying the next one`);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`Could not start the gateway: ${errMsg(lastErr)}`);
  }

  private tryListen(server: Server, port: number, host?: string): Promise<number> {
    const attempt = (h: string) => new Promise<number>((resolve, reject) => {
      const onErr = (e: Error) => { server.off('listening', onOk); reject(e); };
      const onOk = () => {
        server.off('error', onErr);
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(port, h);
    });
    if (host) return attempt(host);
    return attempt('::').catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') throw e;
      return attempt('0.0.0.0');
    });
  }

  /* -------------------------------------------------------------- websocket */

  private async onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { socket.destroy(); return; }
    if (url.pathname === SECURE_PATH) return this.onSecureUpgrade(req, socket, head);
    if (url.pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!hostAllowed(req.headers.host, this.cloud)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const peer = await this.checkPeer(req.socket.remoteAddress, req.headers).catch(() => ({ ok: false as const, route: undefined, ip: undefined, tailscaleUser: undefined }));
    const ip = peer.ip ?? normalizeIp(req.socket.remoteAddress);
    // the local network (and the cloud's internet) reaches /ws only through the channel: the connect frame carries the token
    if (!peer.ok || plainLan(peer) || plainCloud(peer)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const host = req.headers.host;
    const route = peer.route ?? 'lan';
    const stream = peer.ok ? peer.stream : undefined;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ip, route, peer.tailscaleUser, url.searchParams.get('token') ?? undefined, host, stream));
  }

  /**
   * A phone's end-to-end channel off this computer (SECURE_PATH: the same Wi-Fi, and Tailscale for a phone that has the
   * key): admitted by the address it really comes from (no header counts here; `tailscale whois` as for any Tailscale
   * peer), then handed to ConnectService as one phone stream, whose replayed requests carry that address. Every hello
   * costs this computer a few key exchanges, so an address gets SECURE_PER_ADDRESS sockets at once and SECURE_TRIES new
   * ones a minute (429), counted before anything else is done for it. Pinged with the other sockets, so a phone gone
   * from the network doesn't hold its stream open. None with `bind: loopback`.
   */
  private async onSecureUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (!hostAllowed(req.headers.host, this.cloud) || (!this.cloud && this.ctx.s.settings.get().gateway.bind === 'loopback')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    // on the cloud every socket comes from the platform's edge: the phones are told apart by what it forwards
    const peerAddress = this.cloud ? forwardedAddress(req.headers, req.socket.remoteAddress) : normalizeIp(req.socket.remoteAddress);
    const key = addressKey(peerAddress);
    if ((this.secureByAddress.get(key) ?? 0) >= SECURE_PER_ADDRESS || !countTry(this.secureTries, key, SECURE_TRIES, SECURE_WINDOW_MS)) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      return;
    }
    // counted from now until its connection closes, however it ends (refused below, a bad upgrade, the stream over)
    this.secureByAddress.set(key, (this.secureByAddress.get(key) ?? 0) + 1);
    let counted = true;
    const release = () => {
      if (!counted) return;
      counted = false;
      const n = (this.secureByAddress.get(key) ?? 1) - 1;
      if (n > 0) this.secureByAddress.set(key, n);
      else this.secureByAddress.delete(key);
    };
    socket.once('close', release);
    if (socket.destroyed) { release(); return; }
    const peer = await this.checkPeer(req.socket.remoteAddress).catch((): PeerCheck => ({ ok: false }));
    if (!peer.ok) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const ip = this.cloud ? peerAddress : peer.ip ?? normalizeIp(req.socket.remoteAddress);
    this.secureWss.handleUpgrade(req, socket, head, (ws) => {
      const entry = { ip, alive: true };
      this.secure.set(ws, entry);
      ws.on('pong', () => { entry.alive = true; });
      ws.on('close', () => { this.secure.delete(ws); release(); });
      this.ctx.s.connect.acceptDirect(ws, ip);
    });
  }

  private onConnection(ws: WebSocket, ip: string, route: NetRoute, tailscaleUser: string | undefined, queryToken: string | undefined, host?: string, stream?: string): void {
    const watcher: Watcher = {
      id: ++this.connSeq,
      route,
      // a live picture is dropped rather than queued behind a slow link (the view asks for the next one); a video
      // frame that couldn't go says so (the device then waits for a keyframe)
      send: (event, payload) => {
        if (conn.ws.bufferedAmount >= LIVE_DROP_BYTES || conn.ws.readyState !== WebSocket.OPEN) return false;
        // never behind a batch: these carry no seq, so going ahead of the events waiting changes nothing
        this.sendEvent(conn, JSON.stringify({ type: 'event', event, payload }));
        return true;
      },
      backlog: () => conn.ws.bufferedAmount,
    };
    const conn: Conn = { ws, ip, route, tailscaleUser, authed: false, role: 'limited', deviceId: '', isPairedDevice: false, alive: true, host, link: newLink(isLoopback(ip)), watcher, stream };
    const connectTimer = setTimeout(() => { if (!conn.authed) ws.terminate(); }, CONNECT_TIMEOUT_MS);
    ws.on('pong', () => {
      conn.alive = true;
      if (conn.pingAt) { addRtt(conn.link, Date.now() - conn.pingAt); conn.pingAt = undefined; }
    });
    ws.on('message', (raw: RawData) => {
      let frame: unknown;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      if (!conn.authed) { clearTimeout(connectTimer); this.onConnect(conn, frame, queryToken); return; }
      // a client's requests made together (it reads batches, so it was told this server does): each as if alone
      const items = (frame as { type?: unknown; items?: unknown } | null)?.type === 'batch' ? (frame as { items?: unknown }).items : undefined;
      if (Array.isArray(items)) { for (const item of items.slice(0, BATCH_ITEMS_MAX)) void this.onReq(conn, item); return; }
      void this.onReq(conn, frame);
    });
    ws.on('close', () => {
      clearTimeout(connectTimer);
      this.dropOutbox(conn);
      this.ctx.s.liveView.drop(watcher.id);
      // its live view closed: control (if it had it) goes back to the bots
      this.ctx.s.computer.releaseControl(controlKey(watcher.id));
      if (this.conns.delete(conn) && conn.isPairedDevice) this.ctx.s.devices.setOnline(conn.deviceId, false);
    });
    ws.on('error', (e) => this.ctx.log.debug('ws error', errMsg(e)));
  }

  private helloError(conn: Conn, code: 'unauthorized' | 'protocol_mismatch' | 'revoked' | 'bad_connect', error: string, extra?: Record<string, unknown>): void {
    this.send(conn, { type: 'hello', ok: false, error, code, ...extra });
    setTimeout(() => conn.ws.close(1008, code), 50);
  }

  private onConnect(conn: Conn, frame: unknown, queryToken?: string): void {
    const p = ConnectFrameSchema.safeParse(frame);
    if (!p.success) return this.helloError(conn, 'bad_connect', 'Expected a connect frame');
    const f = p.data;
    // each side must speak at least the other's oldest; a client that predates the range speaks only its own
    const match = protocolMatch({ version: f.protocolVersion, min: f.minProtocolVersion ?? f.protocolVersion }, { version: PROTOCOL_VERSION, min: MIN_PROTOCOL_VERSION });
    if (!match.ok) {
      return this.helloError(conn, 'protocol_mismatch', match.update === 'client' ? 'This app is too old for AppuBot on this computer. Update the app.' : 'AppuBot on this computer is too old for this app. Update AppuBot.', {
        update: match.update, protocolVersion: PROTOCOL_VERSION, minProtocolVersion: MIN_PROTOCOL_VERSION, serverVersion: this.ctx.deps.version,
      });
    }
    // a phone app the version policy stopped: refused as too old, which every phone already reads as "update this app"
    const stoppedPhone = this.ctx.s.appUpdate.phoneStopped(f.device);
    if (stoppedPhone) {
      return this.helloError(conn, 'protocol_mismatch', stoppedPhone, {
        update: 'client', protocolVersion: PROTOCOL_VERSION, minProtocolVersion: MIN_PROTOCOL_VERSION, serverVersion: this.ctx.deps.version,
      });
    }
    const a = this.ctx.auth.verify(f.token || queryToken, conn.route);
    if (a.kind === 'revoked') return this.helloError(conn, 'revoked', 'This device was removed from AppuBot. Pair again.');
    if (a.kind === 'invalid') return this.helloError(conn, 'unauthorized', 'Invalid or expired token');
    conn.authed = true;
    setMaxPayload(conn.ws, MAX_PAYLOAD);
    conn.role = connectionRole(a, this.cloud);
    conn.deviceId = a.deviceId;
    if (a.kind === 'agent') conn.agent = a.agent;
    conn.isPairedDevice = a.kind === 'device';
    if (a.kind === 'device' && a.device.memberId && this.cloud) conn.member = a.device.memberId;
    const windowMs = f.features?.includes(BATCH_FEATURE) ? BATCH_WINDOW_MS[conn.route] ?? 0 : 0;
    if (windowMs > 0) conn.outbox = { windowMs, items: [], bytes: 0, sentAt: -Infinity };
    // signed in through a channel stream: that stream is a paired phone's, it keeps its place
    this.ctx.s.connect.vouch(conn.stream);
    // at launch computer use is still starting (it no longer holds up the window): a phone's or a bot's snapshot waits
    // for it, briefly, so the first one says what computer use can do, as it did before. This computer's own window
    // doesn't wait (it was ~50 ms of every launch's first paint of the chat): its snapshot says computer use isn't up
    // yet (nothing there shows for that: the permission notices need it up), and `computer.status` follows once it is
    const computerReady = a.kind === 'owner' ? null : this.ctx.s.computer.whenReady(HELLO_COMPUTER_WAIT_MS);
    if (computerReady) {
      void computerReady.then(() => { if (conn.ws.readyState === WebSocket.OPEN) this.sendHello(conn, f, a, match.version); });
      return;
    }
    this.sendHello(conn, f, a, match.version);
  }

  private sendHello(conn: Conn, f: ConnectFrame, a: ReturnType<CoreCtx['auth']['verify']>, agreed: number): void {
    this.ctx.bus.flush();
    let snapshot;
    try {
      snapshot = buildSnapshot(this.ctx, conn.role);
      if (this.ctx.deps.validate) snapshot = SnapshotSchema.parse(snapshot);
      // a paired device gets threads without their slash commands (`threads.commands` when it needs them)
      if (a.kind === 'device') snapshot = { ...snapshot, threads: snapshot.threads.map(leanThread) };
    } catch (e) {
      this.ctx.log.error('snapshot failed', errMsg(e));
      return this.helloError(conn, 'bad_connect', `Server error building snapshot: ${errMsg(e)}`);
    }
    this.conns.add(conn);
    const bus = this.ctx.bus;
    // a resume replays what was missed, when this run still has all of it; else the hello says so (`gap`) and the
    // client takes what it kept from before as possibly stale
    const resuming = f.lastSeq !== undefined && conn.role !== 'agent';
    const missed = resuming && (!f.bootId || f.bootId === bus.bootId) ? bus.since(f.lastSeq!) : null;
    this.send(conn, {
      type: 'hello', ok: true, serverVersion: this.ctx.deps.version, protocolVersion: PROTOCOL_VERSION, minProtocolVersion: MIN_PROTOCOL_VERSION, agreedProtocolVersion: agreed,
      deviceId: conn.deviceId, role: conn.role, seq: bus.seq, bootId: bus.bootId, ...(resuming && !missed ? { gap: true } : {}), features: GATEWAY_FEATURES, snapshot,
    });
    if (missed) {
      // missed screenshots are stale: only the newest goes out, at this link's tier
      const lastFrame = missed.filter((e) => e.event === 'computer.frame').at(-1);
      for (const e of missed) {
        if (e.event !== 'computer.frame') this.deliver(conn, JSON.stringify({ type: 'event', event: e.event, payload: this.forConn(conn, e.event, e.payload), seq: e.seq }), e);
        else if (e === lastFrame) this.broadcastFrame(e, conn);
      }
      // what it missed is what it waits for: packed, and on its way at once
      this.soon(conn);
    }
    // a first round trip right away, so a phone's live view adapts before the next heartbeat
    conn.pingAt = Date.now();
    try { conn.ws.ping(); } catch { /* ignore */ }
    if (conn.isPairedDevice) this.ctx.s.devices.setOnline(conn.deviceId, true, conn.ip, conn.tailscaleUser, conn.route, f.device.appVersion);
  }

  private async onReq(conn: Conn, frame: unknown): Promise<void> {
    const p = ReqFrameSchema.safeParse(frame);
    if (!p.success) return;
    // deltas still held for coalescing go out first: an answer read from the current state (`threads.history`) must
    // never reach the device before the events of the changes it already holds, or they'd be applied twice
    this.ctx.bus.flush();
    const { id, method } = p.data;
    const fail = (code: string, message: string, data?: unknown) => this.send(conn, { type: 'res', id, ok: false, error: { code, message, ...(data !== undefined ? { data } : {}) } });
    if (!Object.prototype.hasOwnProperty.call(Methods, method)) return fail('unknown_method', `Unknown method ${method}`);
    const m = method as MethodName;
    const cx: CallCtx = {
      role: conn.role, deviceId: conn.deviceId, agent: conn.agent, host: conn.host, conn: conn.watcher,
      ...(conn.member ? { member: conn.member } : {}),
      ...(conn.isPairedDevice ? { presence: (foreground: boolean, desk?: boolean) => { conn.foreground = foreground; conn.desk = !!desk; conn.presenceAt = Date.now(); } } : {}),
    };
    try {
      checkRole(m, p.data.params, cx);
      checkHiddenTurn(m, cx, (threadId) => this.ctx.s.chat.isHiddenTurn(threadId));
      checkWorking(m, this.ctx.s.appUpdate.stopped);
      // someone is using AppuBot: a downloaded update holds its restart for a while
      if (cx.role !== 'agent' && ACTIVITY_METHODS.has(m)) this.ctx.s.appUpdate.noteActivity();
      const parsed = Methods[m].params.safeParse(p.data.params ?? {});
      if (!parsed.success) return fail('invalid_params', parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; '), parsed.error.issues);
      const handler = this.handlers[m] as (params: unknown, cx: CallCtx) => unknown;
      let result = await handler(parsed.data, cx);
      if (this.ctx.deps.validate) {
        const r = Methods[m].result.safeParse(result);
        if (!r.success) {
          this.ctx.log.error(`result of ${m} failed validation`, r.error.issues.slice(0, 5));
          return fail('internal', `Result of ${m} failed schema validation: ${r.error.message}`);
        }
        result = r.data;
      }
      // thread lists to a paired device leave each thread's slash commands out (`threads.commands`)
      if (m === 'threads.list' && conn.isPairedDevice && Array.isArray(result)) result = (result as Thread[]).map(leanThread);
      this.send(conn, { type: 'res', id, ok: true, result });
    } catch (e) {
      if (e instanceof RpcError) return fail(e.code, e.message, e.data);
      this.ctx.log.warn(`method ${m} failed`, errMsg(e));
      fail((e as { code?: string })?.code && typeof (e as { code?: string }).code === 'string' ? String((e as { code: string }).code) : 'internal', errMsg(e));
    }
  }

  private send(conn: Conn, obj: unknown): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    // an answer goes with the events before it, at the end of this tick (answers ready together share a frame)
    if (conn.outbox && (obj as { type?: string }).type === 'res') { this.deliver(conn, JSON.stringify(obj), undefined, true); return; }
    // a hello (or its refusal) never waits, and never overtakes what was queued before it
    if (conn.outbox) this.flushOutbox(conn);
    try { conn.ws.send(JSON.stringify(obj)); } catch (e) { this.ctx.log.debug('ws send failed', errMsg(e)); }
  }

  /**
   * An event (or answer) for `conn`, as JSON: straight out, or into its outbox (a batching connection). There a delta
   * that continues the delta last queued for the same part extends it (the later seq and rev: the bus's own coalescing
   * over a longer window), so nothing passes anything else. What comes after a quiet window goes at the end of this
   * tick (with whatever else is ready by then), the rest when the window ends, `urgent` ones (answers, URGENT_EVENTS)
   * at the end of this tick whatever the window.
   */
  private deliver(conn: Conn, raw: string, e?: Pick<BusEvent, 'event' | 'payload' | 'seq'>, urgent = !!e && URGENT_EVENTS.has(e.event)): void {
    const box = conn.outbox;
    if (!box) { this.sendEvent(conn, raw); return; }
    const d = e?.event === 'message.delta' ? (e.payload as Delta) : undefined;
    const key = d && `${d.messageId}:${d.partIndex}:${d.partType}`;
    if (d && key && box.tail?.key === key) {
      const payload: Delta = { ...box.tail.payload, delta: box.tail.payload.delta + d.delta, ...(d.rev !== undefined ? { rev: d.rev } : {}) };
      const merged = JSON.stringify({ type: 'event', event: 'message.delta', payload, seq: e!.seq });
      box.bytes += merged.length - box.items[box.items.length - 1]!.length;
      box.items[box.items.length - 1] = merged;
      box.tail = { key, payload };
    } else {
      if (box.items.length && box.bytes + raw.length > BATCH_MAX_BYTES) this.flushOutbox(conn);
      box.items.push(raw);
      box.bytes += raw.length;
      box.tail = d && key ? { key, payload: d } : undefined;
    }
    if (box.bytes >= BATCH_MAX_BYTES) { this.flushOutbox(conn); return; }
    if (box.soon || (box.timer && !urgent)) return;
    const wait = box.sentAt + box.windowMs - performance.now();
    if (urgent || wait <= 0) this.soon(conn);
    else box.timer = setTimeout(() => { box.timer = undefined; this.flushOutbox(conn); }, Math.min(wait, box.windowMs));
  }

  /** `conn`'s outbox goes once this tick's work is done (what else is ready by then goes with it). */
  private soon(conn: Conn): void {
    const box = conn.outbox;
    if (!box || box.soon || !box.items.length) return;
    box.soon = setImmediate(() => { box.soon = undefined; this.flushOutbox(conn); });
  }

  /** What waits for `conn`, now: one frame as itself, several as one batch. */
  private flushOutbox(conn: Conn): void {
    const box = conn.outbox;
    if (!box) return;
    if (box.timer) { clearTimeout(box.timer); box.timer = undefined; }
    if (box.soon) { clearImmediate(box.soon); box.soon = undefined; }
    if (!box.items.length) return;
    const items = box.items;
    box.items = [];
    box.bytes = 0;
    box.tail = undefined;
    box.sentAt = performance.now();
    this.sendEvent(conn, items.length === 1 ? items[0]! : `{"type":"batch","items":[${items.join(',')}]}`);
  }

  private dropOutbox(conn: Conn): void {
    const box = conn.outbox;
    if (!box) return;
    if (box.timer) clearTimeout(box.timer);
    if (box.soon) clearImmediate(box.soon);
    box.timer = box.soon = undefined;
    box.items = [];
    box.bytes = 0;
    box.tail = undefined;
  }

  private sendEvent(conn: Conn, raw: string): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    // hopelessly behind (a stalled link): closed, so the device reconnects and resumes from its `lastSeq` instead of
    // this computer queueing every event for it in memory
    if (conn.ws.bufferedAmount > HOPELESS_BYTES) {
      this.ctx.log.warn(`dropping a connection ${Math.round(conn.ws.bufferedAmount / 1e6)} MB behind`);
      conn.ws.terminate();
      return;
    }
    try { conn.ws.send(raw); } catch { /* ignore */ }
  }

  private broadcast(e: BusEvent): void {
    // encoding frames for watchers waits until the bot has its answer (the emit happens inside its action)
    // (the payload is held now: the bus drops an older frame's pixels once a newer one comes)
    if (e.event === 'computer.frame') { const f = { ...e }; setImmediate(() => this.broadcastFrame(f)); return; }
    let raw: string | null = null;
    let lean: string | null = null;
    for (const c of this.conns) {
      if (!c.authed || c.role === 'agent') continue;
      if (c.isPairedDevice && e.event === 'thread.updated') {
        lean ??= JSON.stringify({ type: 'event', event: e.event, payload: leanThread(e.payload as Thread), seq: e.seq });
        this.deliver(c, lean, e);
        continue;
      }
      raw ??= JSON.stringify({ type: 'event', event: e.event, payload: e.payload, seq: e.seq });
      this.deliver(c, raw, e);
    }
  }

  /** An event's payload as `conn` gets it: a paired device's threads come without their slash commands. */
  private forConn(conn: Conn, event: string, payload: unknown): unknown {
    return conn.isPairedDevice && event === 'thread.updated' ? leanThread(payload as Thread) : payload;
  }

  /**
   * A screenshot goes to each watcher at its own tier: the bot's full-quality frame re-encoded (smaller, JPEG) for
   * that device's link, each tier encoded once per frame. This Mac's own window at the best tier gets the frame as
   * it is (no encode). A link too far behind skips the frame.
   */
  private broadcastFrame(e: BusEvent, only?: Conn): void {
    const frame = e.payload as { data: string; mimeType: string; width: number; height: number };
    const byTier = new Map<number, string>();
    const rawFor = (tier: number): string => {
      let raw = byTier.get(tier);
      if (raw === undefined) {
        const enc = tier < 0 ? undefined : this.ctx.deps.imageCodec?.encode(frame.data, FRAME_TIERS[tier]!);
        raw = JSON.stringify({ type: 'event', event: e.event, payload: enc ? { ...frame, ...enc } : frame, seq: e.seq });
        byTier.set(tier, raw);
      }
      return raw;
    };
    for (const c of only ? [only] : this.conns) {
      if (!c.authed || c.role === 'agent' || c.ws.readyState !== WebSocket.OPEN) continue;
      const tier = nextTier(c.link, c.ws.bufferedAmount, liveModeFor(c.route));
      if (tier !== null) this.deliver(c, rawFor(tier === 0 && c.link.local ? -1 : tier), e);
    }
  }

  private ping(): void {
    for (const c of this.conns) {
      if (!c.alive) {
        // a phone's socket the channel stopped reading while the phone's link catches up (so this side sees the backlog)
        // can't answer until it is read again: that isn't dead. The phone's own channel socket, or the relay, says
        // when the phone is gone; a socket hopelessly behind is closed by `sendEvent`.
        if (c.stream && this.ctx.s.connect.backedUp(c.stream)) continue;
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.pingAt = Date.now();
      try { c.ws.ping(); } catch { /* ignore */ }
    }
    // the gateway sockets the channel replays answer pings themselves: the phone's own channel socket is what says it's gone
    for (const [ws, s] of this.secure) {
      if (!s.alive) { ws.terminate(); continue; }
      s.alive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }

  /**
   * Close a device's sockets without revoking it (its role changed, §6.11): the client reconnects and signs in with
   * the role it has now.
   */
  reconnectDevice(deviceId: string, reason = 'Reconnect'): void {
    for (const c of this.conns) {
      // the close handler drops it from `conns` and marks the device offline
      if (c.deviceId === deviceId) try { c.ws.close(1012, reason.slice(0, 100)); } catch { /* gone */ }
    }
  }

  disconnectDevice(deviceId: string): void {
    for (const c of this.conns) if (c.deviceId === deviceId) { this.helloError(c, 'revoked', 'This device was removed from AppuBot.'); this.dropOutbox(c); this.conns.delete(c); }
  }

  /**
   * Whether a paired phone has its app in front on a live connection now: it said so (`devices.presence`) within
   * PRESENCE_TTL_MS, so a phone suspended without a word counts as away soon after. Pushes skip such a phone.
   */
  inFront(deviceId: string, now = Date.now()): boolean {
    for (const c of this.conns) {
      if (c.deviceId === deviceId && c.foreground && c.presenceAt && now - c.presenceAt < PRESENCE_TTL_MS && c.ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  /**
   * Whether a person is at a desktop app showing this computer (an AppuBot computer seen from their Mac): it said so
   * (`devices.presence {desk}`) within PRESENCE_TTL_MS on a live connection. `member` is whose (a team's computer);
   * absent, anyone's on a personal one. Their phones get no pushes then: the Mac in front of them shows it.
   */
  atDesk(member: string | undefined, now = Date.now()): boolean {
    for (const c of this.conns) {
      if (c.desk && c.foreground && c.member === member && c.presenceAt && now - c.presenceAt < PRESENCE_TTL_MS && c.ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  onlineDevices(): Set<string> {
    return new Set([...this.conns].filter((c) => c.isPairedDevice).map((c) => c.deviceId));
  }

  async close(): Promise<void> {
    this.unsubBus?.();
    this.unsubBus = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.conns) { this.dropOutbox(c); c.ws.terminate(); }
    this.conns.clear();
    for (const ws of this.secure.keys()) ws.terminate();
    this.secure.clear();
    this.secureByAddress.clear();
    this.wss.close();
    this.secureWss.close();
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections?.(); });
  }
}

/** when each try table was last swept, and the most keys one holds before it is emptied (every key is one address in one window) */
const sweptAt = new WeakMap<object, number>();
const TRY_KEYS_MAX = 50_000;

/**
 * One more try for `key` within `limit` per `windowMs` (a fixed window per key, from its first try; expired keys are
 * swept on the way, so the table only holds recent addresses). False once over.
 */
function countTry(tries: Map<string, { n: number; until: number }>, key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  // sweeping the whole table on every try made a flood of fresh keys cost the square of its size: once a second is
  // as good (`sweptAt`), and a table that has grown past any real use is emptied rather than walked
  if (now - (sweptAt.get(tries) ?? 0) >= 1000) {
    sweptAt.set(tries, now);
    if (tries.size > TRY_KEYS_MAX) tries.clear();
    else for (const [k, v] of tries) if (v.until <= now) tries.delete(k);
  }
  const stale = tries.get(key);
  if (stale && stale.until <= now) tries.delete(key);
  const cur = tries.get(key) ?? { n: 0, until: now + windowMs };
  cur.n += 1;
  tries.set(key, cur);
  return cur.n <= limit;
}
