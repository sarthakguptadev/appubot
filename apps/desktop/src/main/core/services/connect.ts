/**
 * AppuBot Connect: this computer reachable from anywhere through one relay (connect.appubot.com), so a
 * paired phone needs neither the same Wi-Fi nor Tailscale, and nothing on this computer listens on the internet.
 *
 * The computer dials out: one WebSocket to the relay's `/host`, where it claims its room by signing the relay's
 * challenge with its Ed25519 key (the room id is a fingerprint of that key, protocol `roomIdForPublicKey`). A phone
 * joins the room; the relay multiplexes each phone over this socket (protocol `RelayFrame`) and copies bytes it cannot
 * read. Per phone, `PhoneStream` runs the end-to-end channel (protocol `acceptHello`, `SecureChannel`): the phone's
 * hello, our reply (a fresh key of our own and a sealed READY), then the gateway WebSocket and HTTP requests, which it
 * replays against this computer's own gateway on loopback with `CONNECT_PEER_HEADER` set, so the gateway admits them as
 * route `connect` (never `local`) and still asks for a paired device's token. Request bodies stream into the gateway as
 * they come (at most CHANNEL_WINDOW ahead of what it read, and a byte budget per phone and overall, so a stranger who
 * knows the room can't make this computer hold much before the gateway checks a token); answers stream back the same
 * way. Anything that fails to open, or throws, ends that phone's stream only. The keys live in
 * `<dataDir>/connect.json` (0600): the identity is made once and kept, so the room and the key the phones pinned from
 * the QR survive restarts; `reset` makes new ones.
 *
 * The same channel runs without the relay on the same Wi-Fi, and over Tailscale for a phone that has the key
 * (`acceptDirect`): the gateway hands over each WebSocket a phone opens at SECURE_PATH, and a `PhoneStream` runs it
 * exactly as a relay stream (its bytes go to that socket instead of into relay frames), replaying with
 * `SECURE_PEER_HEADER` (the phone's real address, so the gateway's peer policy still applies, whois included). That needs only the key, never the relay: the identity exists whether Connect is on or not.
 *
 * A stream has to prove it is a paired phone soon (`STREAM_TAG_HEADER`: the gateway vouches for it once it signs in on
 * its WebSocket or a request with its token succeeds), so someone who only knows the room, or is on the Wi-Fi, can't hold
 * streams open with hellos of their own: when the places are taken, a new stream takes the place of one that hasn't
 * signed in yet (`evictee`); one with nothing open and nothing said for a while is let go, and so is a request whose body
 * stops coming. When the phone's side backs up (the relay, or its own socket), its gateway sockets are paused, so the
 * gateway's own guards (dropping live pictures, closing a socket hopelessly behind) see the backlog. Answer bodies
 * (downloads) take turns on that socket (`BulkLane`) and only fill it while it is nearly empty, so they never keep a
 * phone's chat paused, and one phone's download over the relay never holds up another phone.
 *
 * The relay echoes every PING we send: a socket that hears nothing for PING_TIMEOUT_MS is dead (the relay dropped the
 * room, the network went) and is dialled again; after a sleep (timers stood still) or `nudge` (a wake or network change
 * seen elsewhere) the relay must answer a ping within PROBE_MS.
 *
 * The relay only runs while `settings.connect.enabled` and a phone is paired (or a pairing is open), so computers that
 * never pair a phone never dial it. Status rides `SystemInfo.connect` and `connect.status` (the key always, the room
 * while the relay runs); the key joins every pairing QR, the room while Connect is on.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { WebSocket, type RawData } from 'ws';
import {
  CHANNEL_ACK_EVERY,
  CHANNEL_CHUNK,
  CHANNEL_MESSAGE_MAX,
  CHANNEL_VERSION,
  CHANNEL_WINDOW,
  CONNECT_PEER_HEADER,
  CONNECT_RELAY_URL,
  CONNECT_TICKET_RENEW_MS,
  Msg,
  RELAY_HEADER,
  RelayFrame,
  SECURE_PEER_HEADER,
  acceptHello,
  ackPayload,
  addressKey,
  createIdentity,
  decodeRelayFrame,
  encodeRelayFrame,
  fromBase64Url,
  identityFromSecrets,
  jsonBytes,
  parseAck,
  parseJsonBytes,
  roomIdForPublicKey,
  signChallenge,
  toBase64Url,
  UPLOAD_MAX,
  versionReply,
  writeRelayHeader,
  type ChannelMessage,
  type ConnectStatus,
  type HttpRequestHead,
  type Identity,
  type MsgKind,
  type SecureChannel,
  type WsOpenHead,
} from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { systemDirOf } from '../context';
import { JsonFile } from '../store';
import { errMsg, RpcError } from '../util';
import { isTailscaleIp } from './tailscale';

/** What `connect.json` keeps: this computer's identity (base64url secrets). */
interface ConnectFile { identity?: { ed: string; x: string; createdAt: number } }

/** Test hooks (`CoreDeps.connect`). */
export interface ConnectDeps {
  /** the relay (default wss://connect.appubot.com, or APPUBOT_CONNECT_URL) */
  relayUrl?: string;
  /** heartbeat timings (default PING_MS, PING_TIMEOUT_MS, PROBE_MS) */
  pingMs?: number;
  pingTimeoutMs?: number;
  probeMs?: number;
  /** byte limits (default MAX_REQUEST_BODY, STREAM_HOLD_MAX, TOTAL_HOLD_MAX) */
  limits?: { requestBody?: number; streamHold?: number; totalHold?: number };
  /** how long the relay's refusals keep this computer away (default REFUSED_WAIT_MS, LONG_WAIT_MS) */
  waits?: { refused?: number; long?: number };
  /** the most a first dial after losing a relay that was up waits on top of the backoff (default SPREAD_MS) */
  spreadMs?: number;
  /** a phone stream's deadlines (default HELLO_WAIT_MS, SIGN_IN_WAIT_MS, STREAM_IDLE_MS, BODY_WAIT_MS) */
  stream?: { helloMs?: number; signInMs?: number; idleMs?: number; bodyMs?: number };
}

/** a PING to the relay this often; it echoes each one */
const PING_MS = 20_000;
/** no word from the relay this long after a ping: the socket is dead */
const PING_TIMEOUT_MS = 45_000;
/**
 * after a sleep or a `nudge`, the relay must answer a ping this soon: more than the 10 s the relay may hold this
 * computer's socket still for a phone that is slow to take its data (its `stallMs`)
 */
const PROBE_MS = 12_000;
/** how often the heartbeat looks; a look this much later than due means timers stood still (the computer slept) */
const TICK_MS = 5_000;
const SLEPT_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;
/**
 * after a relay socket that was up drops, the first dial waits up to this much longer, at random: when the relay
 * restarts every computer loses it at the same moment, and this spreads their return over a few seconds instead of
 * one burst of handshakes (a wake or a network change still dials at once: `nudge`)
 */
const SPREAD_MS = 5_000;
/**
 * a relay stopping for a deploy closes hosts with 1012 and `restart <seconds>`: the return is spread over that long
 * instead (how long depends on how many computers it held), at most this
 */
const CLOSE_RESTART = 1012;
const RESTART_SPREAD_MAX_MS = 120_000;
/** the relay's close codes for a host socket */
const CLOSE_RELAY_FULL = 4004;
const CLOSE_TOO_MANY_HOSTS = 4008;
/** no good relay pass (the relay's RELAY_TICKETS=require) */
const CLOSE_TICKET_REQUIRED = 4011;
/** how long the challenge's answer waits for a relay pass being fetched (the relay gives 10 s to answer) */
const PASS_WAIT_MS = 4000;
const CLOSE_REPLACED = 4009;
const CLOSE_RATE_LIMITED = 4029;
/** refused before the upgrade (a 429) or asked to slow down: no dial for at least this long (or the relay's Retry-After) */
const REFUSED_WAIT_MS = 30_000;
/** another computer took this room with the same key, or too many computers from this address: this long */
const LONG_WAIT_MS = 5 * 60_000;
const MAX_HOLD_MS = 10 * 60_000;
/**
 * an answer body's next piece goes out only while less than this waits on the phones' socket: with one more piece
 * (CHANNEL_FRAME_MAX) it stays under PHONE_HIGH_WATER, so a download alone never pauses a phone's chat
 */
const BULK_HIGH_WATER = 512 * 1024;
/** how often a waiting answer body looks at its socket again (short: on a fast link it empties in a few ms) */
const BULK_POLL_MS = 5;
/** biggest request body a phone (or the desktop app carrying a transfer) may send: as much as the gateway's `/api/files` takes */
const MAX_REQUEST_BODY = UPLOAD_MAX;
/** bytes held for the gateway (request bodies it hasn't read yet, pieces of a long WebSocket frame): per phone, and all */
const STREAM_HOLD_MAX = 64 * 1024 * 1024;
const TOTAL_HOLD_MAX = 256 * 1024 * 1024;
/** phones on the relay at once (the relay holds a room to fewer) */
const MAX_STREAMS = 64;
/**
 * phones on the channel's own sockets at once, the local network's and Tailscale's apart: someone on the Wi-Fi (with a
 * few addresses of their own) can't take a phone's place over Tailscale
 */
const MAX_DIRECT_STREAMS = 32;
/** a stream that hasn't said hello by then is dropped (it would hold one of the MAX_STREAMS places) */
const HELLO_WAIT_MS = 10_000;
/**
 * after READY a stream has this long to prove it's a paired phone (signed in on its gateway WebSocket, or a request
 * with its token answered 2xx/3xx): a hello costs nothing to make, so anyone who knows the room (or is on the Wi-Fi)
 * could otherwise hold every stream place and keep the real phone out
 */
const SIGN_IN_WAIT_MS = 15_000;
/** a stream with no gateway socket or request open, and not a message either way, for this long is let go */
const STREAM_IDLE_MS = 3 * 60_000;
/** a request whose body neither comes nor is taken for this long frees its place (one of MAX_REQUESTS_PER_PHONE) */
const BODY_WAIT_MS = 60_000;
/**
 * the phone's side this far behind (its own socket, or the relay's) stops reading its gateway sockets, so the backlog
 * shows where the gateway measures it (live pictures dropped, tiers skipped, a socket hopelessly behind closed); read
 * again below PHONE_LOW_WATER. Answer bodies wait meanwhile (`BulkLane.hold`), so only chat's own volume gets here.
 */
const PHONE_HIGH_WATER = 1024 * 1024;
const PHONE_LOW_WATER = 256 * 1024;
const BACKLOG_POLL_MS = 20;
const MAX_SOCKETS_PER_PHONE = 4;
const MAX_REQUESTS_PER_PHONE = 24;
/** a phone that takes none of an answer (no HTTP_ACK) for this long loses that request */
const ACK_WAIT_MS = 60_000;
/** at most one "dropping a phone" line this often (a stranger who knows the room can open streams of junk) */
const DROP_LOG_MS = 10_000;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/** headers that describe one hop, not the request: never copied across */
/**
 * Set by a phone stream on everything it replays to the gateway (never taken from the phone): which stream it is, so
 * the gateway can vouch for it (`ConnectService.vouch`) once it signs in. Only read from loopback peers that also carry a
 * channel header; a local process setting it could only keep a stream it can't read open.
 */
export const STREAM_TAG_HEADER = 'x-appubot-stream';
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate', CONNECT_PEER_HEADER, SECURE_PEER_HEADER, STREAM_TAG_HEADER]);
const EMPTY = new Uint8Array(0);

const RELAY_ERRORS: Record<string, string> = {
  relay_full: 'AppuBot Connect is full right now. It will keep trying.',
  relay_busy: 'AppuBot Connect is busy right now. It will keep trying.',
  rate_limited: 'AppuBot Connect asked this computer to slow down. It will try again shortly.',
  challenge_timeout: 'AppuBot Connect didn’t hear back from this computer in time. It will keep trying.',
  bad_signature: 'AppuBot Connect did not accept this computer’s key. Try a new key in Settings › Devices.',
  bad_pubkey: 'AppuBot Connect did not accept this computer’s key. Try a new key in Settings › Devices.',
  ticket_required: 'AppuBot Connect needs this computer signed in to AppuBot. Sign in again; it will keep trying.',
};
const REPLACED_ERROR = 'Another computer is using this AppuBot Connect identity, so phones reach that one instead. If you copied AppuBot’s data to another computer, make a new key on one of them in Settings › Devices. Trying again in 5 minutes.';
const TOO_MANY_HOSTS_ERROR = 'Too many computers on this network are using AppuBot Connect right now. Trying again in a few minutes.';
const REFUSED_ERROR = 'AppuBot Connect isn’t taking more computers from this network right now. It will try again shortly.';

export class ConnectService {
  /** the relay pass (protocol connectTicket.ts) for the key it was given for, and the one being fetched */
  private pass: { key: string; ticket: string; expiresAt: number } | null = null;
  private passing: Promise<string | null> | null = null;
  private file: JsonFile<ConnectFile>;
  private st: ConnectStatus = { state: 'off', since: Date.now() };
  private id: Identity | null = null;
  private running = false;
  private sock: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private probe: ReturnType<typeof setTimeout> | null = null;
  /** when the oldest ping the relay hasn't answered went (0: it has answered everything; any message counts) */
  private awaiting = 0;
  /** the time in the last ping sent: each one's is later than the one before, so an echo says which ping it answers */
  private pingStamp = 0;
  /** the ping whose echo a probe (`check`) waits for (0: none) */
  private probing = 0;
  /** this socket's relay echoes pings (one that never has isn't held to it) */
  private echoes = false;
  private attempt = 0;
  private lastError: string | undefined;
  private dropLoggedAt = 0;
  private dropsUnlogged = 0;
  /** a pairing is open: the relay is wanted even before the first phone is paired */
  private pairingOpen = false;
  /** the relay told this computer to stay away until then (a 429, another computer holding our room): no dial before it, nudge or not */
  private heldUntil = 0;
  /** the phones on the relay right now, by stream id */
  readonly streams = new Map<number, PhoneStream>();
  /** answer bodies for the phones on the relay take turns on its one socket */
  private readonly relayLane = new BulkLane(() => this.sock?.bufferedAmount ?? 0);
  /** the phones on the channel's own sockets (the same Wi-Fi, Tailscale), whether the relay runs or not */
  readonly direct = new Set<PhoneStream>();
  /** every phone stream, by the tag its replays carry (STREAM_TAG_HEADER) */
  private tagged = new Map<string, PhoneStream>();
  /** bytes the phones' streams hold for the gateway, all together */
  held = 0;
  readonly limits: { requestBody: number; streamHold: number; totalHold: number };

  constructor(private ctx: CoreCtx) {
    this.file = new JsonFile<ConnectFile>(join(systemDirOf(ctx.paths), 'connect.json'), () => ({}), 150, ctx.log, undefined, 0o600);
    const l = ctx.deps.connect?.limits;
    this.limits = { requestBody: l?.requestBody ?? MAX_REQUEST_BODY, streamHold: l?.streamHold ?? STREAM_HOLD_MAX, totalHold: l?.totalHold ?? TOTAL_HOLD_MAX };
    ctx.s.settings.onChange((next, prev) => {
      if (next.connect.enabled !== prev.connect.enabled) void (next.connect.enabled ? this.start('switched on') : this.stop('switched off'));
      // the gateway for this computer only: nothing reaches it through the relay
      else if ((next.gateway.bind === 'loopback') !== (prev.gateway.bind === 'loopback')) void (this.wanted() ? this.start('the gateway admits phones again') : this.stop('the gateway is for this computer only'));
    });
  }

  private get relayUrl(): string {
    return (this.ctx.deps.connect?.relayUrl ?? process.env.APPUBOT_CONNECT_URL ?? CONNECT_RELAY_URL).replace(/\/$/, '');
  }

  /**
   * This computer's identity, made on first use and kept. Connect on or off: its X25519 key also secures the same
   * Wi-Fi's channel, and every pairing QR carries it.
   */
  identity(): Identity {
    if (this.id) return this.id;
    const saved = this.file.get().identity;
    const ed = saved && fromBase64Url(saved.ed);
    const x = saved && fromBase64Url(saved.x);
    if (ed?.length === 32 && x?.length === 32) {
      this.id = identityFromSecrets(ed, x);
    } else {
      this.id = createIdentity();
      this.file.update((f) => ({ ...f, identity: { ed: toBase64Url(this.id!.edSecret), x: toBase64Url(this.id!.xSecret), createdAt: Date.now() } }));
      this.file.flush();
    }
    return this.id;
  }

  /** This computer's X25519 public key (base64url): what phones pin, for the relay and the same Wi-Fi alike. */
  key(): string {
    return toBase64Url(this.identity().xPublic);
  }

  /** The room and key a phone needs (the QR, SystemInfo), while Connect is wanted; else undefined. */
  connectInfo(): { connectId: string; connectKey: string } | undefined {
    if (!this.wanted()) return undefined;
    const id = this.identity();
    return { connectId: roomIdForPublicKey(id.edPublic), connectKey: toBase64Url(id.xPublic) };
  }

  /** The key always (a phone paired over Tailscale learns it here); the room while the relay runs. */
  info(): ConnectStatus {
    const extra = this.st.state !== 'off' ? this.connectInfo() : undefined;
    return { ...this.st, connectKey: this.key(), ...(extra ?? {}) };
  }

  /** The gateway admits Connect traffic only while the relay connection is meant to run. */
  active(): boolean { return this.running; }

  /** Enabled, and there is someone to reach this computer: a paired phone, a pairing in progress, or a linked computer. */
  wanted(): boolean {
    // tests never reach the real relay: only a test that points it elsewhere (`deps.connect`) runs it
    if (process.env.VITEST && !this.ctx.deps.connect) return false;
    // an AppuBot Cloud computer has a public door of its own: phones reach it there, never through the relay (which
    // couldn't wake it: its traffic is outbound). Its identity is still made and used, for the channel and for pushes.
    if (this.ctx.deps.cloud) return false;
    const s = this.ctx.s.settings.get();
    // `bind: loopback` admits only this computer: no phone through the relay either
    if (!s.connect.enabled || s.gateway.bind === 'loopback') return false;
    // AppuBot Connect is for people signed in to AppuBot
    if (this.ctx.deps.accountRequired && !this.ctx.s.cloudAccount.isSignedIn()) return false;
    // a phone to reach it, a pairing under way, or another of the person's computers linked to read its folders
    return this.pairingOpen || this.ctx.s.devices.list().length > 0 || !!this.ctx.s.macLink?.hasLinks();
  }

  /** A computer was linked to read this one's folders, or the last one was unlinked (`MacLinkService`). */
  linksChanged(): void {
    if (this.wanted()) void this.start('a linked computer');
    else if (this.running) void this.stop('nothing paired');
  }

  /** Signing in or out of AppuBot on this computer starts or stops the relay (`wanted`). */
  accountChanged(signedIn: boolean): void {
    this.pass = null;
    if (signedIn) void this.start('signed in');
    else if (this.running && !this.wanted()) void this.stop('signed out');
  }

  /**
   * The relay pass to show the relay (with the challenge's answer, and with each push): the one kept while it has more
   * than CONNECT_TICKET_RENEW_MS left, else a fresh one from the account service (one fetch at a time). Null signed out
   * or when none can be had (an older backend, no network): the relay decides what that means.
   */
  relayPass(): Promise<string | null> {
    const id = this.identity();
    const key = toBase64Url(id.edPublic);
    const kept = this.pass?.key === key ? this.pass : null;
    if (kept && kept.expiresAt - Date.now() > CONNECT_TICKET_RENEW_MS) return Promise.resolve(kept.ticket);
    this.passing ??= (this.ctx.s.cloudAccount?.connectTicket(id.edPublic) ?? Promise.resolve(null))
      .then((r) => {
        if (r) this.pass = { key, ticket: r.ticket, expiresAt: r.expiresAt };
        return r?.ticket ?? (kept && kept.expiresAt > Date.now() ? kept.ticket : null);
      })
      .finally(() => { this.passing = null; });
    return this.passing;
  }

  /** Called while a pairing code is live (so the QR can carry the room) and when it ends. */
  setPairingOpen(open: boolean): void {
    this.pairingOpen = open;
    if (open) void this.start('pairing');
    else if (!this.wanted()) void this.stop('nothing paired');
  }

  private setState(state: ConnectStatus['state'], error?: string): void {
    if (state === this.st.state && error === this.st.error) return;
    this.st = { state, since: Date.now(), ...(error ? { error } : {}) };
    this.ctx.bus.emit('connect.status', this.info());
    this.ctx.bus.emit('system.updated', this.ctx.s.system.info());
  }

  /** Start dialing the relay if Connect is wanted. Safe to call any time. */
  async start(reason: string): Promise<void> {
    if (!this.wanted() || this.running) return;
    this.running = true;
    this.attempt = 0;
    const id = this.identity();
    this.ctx.log.info(`connect: starting (${reason}), room ${roomIdForPublicKey(id.edPublic)}`);
    // the relay asked this computer to stay away a while: switching Connect off and on again doesn't hurry it
    if (Date.now() < this.heldUntil) {
      this.setState('error', this.lastError);
      this.scheduleRetry();
      return;
    }
    this.lastError = undefined;
    this.setState('starting');
    this.dial();
  }

  /** Start (if wanted) and hand back the room and key for the pairing QR. They don't wait for the relay. */
  async ensure(): Promise<{ connectId: string; connectKey: string } | undefined> {
    if (!this.wanted()) return undefined;
    await this.start('ensure');
    return this.connectInfo();
  }

  /** What a pairing QR carries: always the key (the same Wi-Fi pins it too), the room while Connect is wanted. */
  async pairInfo(): Promise<{ connectKey: string; connectId?: string }> {
    const room = await this.ensure().catch(() => undefined);
    return { connectKey: this.key(), ...(room ? { connectId: room.connectId } : {}) };
  }

  async set(enabled: boolean): Promise<ConnectStatus> {
    const cur = this.ctx.s.settings.get();
    if (cur.connect.enabled !== enabled) this.ctx.s.settings.update({ connect: { ...cur.connect, enabled } });
    return this.info();
  }

  /**
   * A new identity: a new room and key. Phones that knew the old ones lose Connect until they connect once over
   * Tailscale or an existing Connect session (which tells them the new key) or pair again.
   */
  async reset(): Promise<ConnectStatus> {
    if (!this.ctx.s.settings.get().connect.enabled) throw new RpcError('invalid_params', 'AppuBot Connect is off');
    await this.stop('reset');
    // a new room: whatever held the old one (another computer with this key) no longer applies
    this.heldUntil = 0;
    this.id = null;
    this.file.update((f) => ({ ...f, identity: undefined }));
    this.file.flush();
    this.identity();
    await this.start('reset');
    return this.info();
  }

  async stop(reason = 'stop'): Promise<void> {
    if (this.running) this.ctx.log.info(`connect: stopping (${reason})`);
    this.running = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.stopHeartbeat();
    for (const s of [...this.streams.values()]) s.close(false);
    const ws = this.sock;
    this.sock = null;
    try { ws?.close(1000, 'stop'); } catch { /* ignore */ }
    this.file.flush();
    this.setState('off');
  }

  /**
   * The computer woke up or its network changed: a relay socket that still looks open may be long dead (the relay
   * dropped the room meanwhile). Waiting to dial again: dial now. Up: the relay must answer a ping within PROBE_MS, or
   * the socket is dropped and dialled again.
   */
  nudge(reason: string): void {
    if (!this.running) return;
    // the relay asked us to stay away for a while: a wake doesn't change that
    if (this.retry && Date.now() < this.heldUntil) return;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
      this.ctx.log.info(`connect: dialling now (${reason})`);
      this.dial();
      return;
    }
    const ws = this.sock;
    if (ws && ws.readyState === WebSocket.OPEN && this.st.state === 'up') this.check(ws, reason);
  }

  /* ------------------------------------------------------------ the relay */

  private dial(): void {
    if (!this.running) return;
    const id = this.identity();
    // fetched now, so it is there by the challenge
    void this.relayPass().catch(() => null);
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${this.relayUrl}/host`, {
        headers: { 'x-connect-pubkey': Buffer.from(id.edPublic).toString('base64'), 'user-agent': `AppuBot/${this.ctx.deps.version}` },
        handshakeTimeout: 15_000,
      });
    } catch (e) {
      this.lastError = errMsg(e);
      this.scheduleRetry();
      return;
    }
    this.sock = ws;
    let refused = false;
    // refused before the upgrade (a 429: too many computers from this address): back off, never straight back
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      if (this.sock === ws) {
        refused = true;
        const after = Number(res.headers['retry-after']) * 1000;
        if (res.statusCode === 429) this.hold(Number.isFinite(after) ? after : 0, this.ctx.deps.connect?.waits?.refused ?? REFUSED_WAIT_MS, REFUSED_ERROR);
        else this.lastError = `AppuBot Connect answered ${res.statusCode}`;
        this.ctx.log.warn(`connect: the relay answered ${res.statusCode}`);
      }
      ws.terminate();
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (this.sock !== ws) return;
      this.awaiting = 0; // the relay is there
      try {
        if (isBinary) this.onFrame(toU8(data));
        else this.onControl(ws, toU8(data).toString());
      } catch (e) {
        // a message must never take the app down: the stream it was for ends (PhoneStream), this one is skipped
        this.ctx.log.warn('connect: a relay message failed', errMsg(e));
      }
    });
    ws.on('error', (e) => { if (!refused) this.lastError = errMsg(e); });
    ws.on('close', (code: number, reason: Buffer) => this.onDrop(ws, code, reason.toString()));
  }

  /** No dial for `ms` (at least `min`, at most MAX_HOLD_MS), and the status says why. */
  private hold(ms: number, min: number, why: string): void {
    this.heldUntil = Date.now() + Math.min(MAX_HOLD_MS, Math.max(min, ms));
    this.lastError = why;
  }

  private onControl(ws: WebSocket, text: string): void {
    let msg: { t?: string; nonce?: string; room?: string; reason?: string };
    try { msg = JSON.parse(text) as typeof msg; } catch { return; }
    if (msg.t === 'challenge' && msg.nonce) {
      void this.answer(ws, msg.nonce);
    } else if (msg.t === 'ready') {
      this.attempt = 0;
      this.lastError = undefined;
      this.startHeartbeat(ws);
      this.ctx.log.info(`connect: up, room ${msg.room ?? '?'}`);
      this.setState('up');
    } else if (msg.t === 'error') {
      this.lastError = RELAY_ERRORS[msg.reason ?? ''] ?? `AppuBot Connect refused this computer (${msg.reason ?? 'unknown'})`;
      this.ctx.log.warn('connect: relay refused', msg.reason);
    }
  }

  /** The challenge's answer: the signature, and the relay pass when there is one (waited for a moment at most). */
  private async answer(ws: WebSocket, nonce: string): Promise<void> {
    const sig = signChallenge(this.identity().edSecret, new Uint8Array(Buffer.from(nonce, 'base64')));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ticket = await Promise.race([
      this.relayPass().catch(() => null),
      new Promise<null>((r) => { timer = setTimeout(() => r(null), PASS_WAIT_MS); }),
    ]).finally(() => clearTimeout(timer));
    if (this.sock !== ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ t: 'auth', sig: Buffer.from(sig).toString('base64'), ...(ticket ? { ticket } : {}) }));
  }

  private onFrame(buf: Uint8Array): void {
    const f = decodeRelayFrame(buf);
    if (!f) return;
    if (f.type === RelayFrame.DATA) {
      this.streams.get(f.streamId)?.onData(f.payload);
    } else if (f.type === RelayFrame.OPEN) {
      this.streams.get(f.streamId)?.close(false);
      // full: a phone that hasn't signed in yet makes room; one that has never does
      if (this.streams.size >= MAX_STREAMS && !this.makeRoom(this.streams.values())) {
        this.noteDrop('too many phones on AppuBot Connect');
        this.sendFrame(encodeRelayFrame(RelayFrame.CLOSE, f.streamId));
        return;
      }
      const ip = new TextDecoder().decode(f.payload) || 'connect';
      this.streams.set(f.streamId, this.relayStream(f.streamId, ip));
    } else if (f.type === RelayFrame.CLOSE) {
      this.streams.get(f.streamId)?.close(false);
    } else if (f.type === RelayFrame.PING) {
      this.echoes = true;
      const stamp = parseAck(f.payload);
      if (this.probing && stamp !== null && stamp >= this.probing) this.probing = 0;
    }
  }

  private onDrop(ws: WebSocket, code = 0, reason = ''): void {
    if (this.sock !== ws) return;
    this.sock = null;
    this.stopHeartbeat();
    for (const s of [...this.streams.values()]) s.close(false);
    if (!this.running) return;
    const waits = this.ctx.deps.connect?.waits;
    // the relay's own refusals: some mean "not now, and not for a while" (never a tight loop of dials)
    if (code === CLOSE_REPLACED) {
      // another socket proved this key and took the room: another computer with a copy of this identity (our own
      // half-open socket is never the current one by then: it is closed before we dial again)
      this.hold(0, waits?.long ?? LONG_WAIT_MS, REPLACED_ERROR);
      this.ctx.log.warn('connect: another computer took this room with the same key; waiting before trying again');
    } else if (code === CLOSE_TOO_MANY_HOSTS) {
      this.hold(0, waits?.long ?? LONG_WAIT_MS, TOO_MANY_HOSTS_ERROR);
    } else if (code === CLOSE_TICKET_REQUIRED) {
      // its pass wasn't good (signed out elsewhere, run out): a fresh one is asked for on the next try
      this.pass = null;
      this.hold(0, waits?.refused ?? REFUSED_WAIT_MS, RELAY_ERRORS.ticket_required!);
    } else if (code === CLOSE_RATE_LIMITED || code === CLOSE_RELAY_FULL) {
      this.hold(0, waits?.refused ?? REFUSED_WAIT_MS, this.lastError ?? RELAY_ERRORS.relay_full!);
    }
    const held = Date.now() < this.heldUntil;
    const wasUp = this.st.state === 'up';
    if (wasUp) this.ctx.log.warn(held ? 'connect: the relay refused this computer for now' : 'connect: lost the relay, reconnecting');
    if (held) this.setState('error', this.lastError);
    else this.setState(wasUp ? 'down' : this.lastError && this.attempt >= 2 ? 'error' : this.st.state === 'down' ? 'down' : 'starting', this.attempt >= 2 ? this.lastError : undefined);
    const restart = code === CLOSE_RESTART ? /^restart (\d{1,4})$/.exec(reason) : null;
    const spread = restart ? Math.min(RESTART_SPREAD_MAX_MS, Number(restart[1]) * 1000) : wasUp ? (this.ctx.deps.connect?.spreadMs ?? SPREAD_MS) : 0;
    this.scheduleRetry(spread);
  }

  /**
   * `spread`: wait up to this much more, at random. A socket that was up may have lost the relay at the same moment as
   * every other computer (it restarted), so their return is spread out.
   */
  private scheduleRetry(spread = 0): void {
    if (!this.running) return;
    const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.attempt++, 6)) * (0.5 + Math.random());
    const extra = Math.random() * spread;
    const delay = Math.max(backoff + extra, this.heldUntil - Date.now());
    this.retry = setTimeout(() => { this.retry = null; this.dial(); }, delay);
    this.retry.unref?.();
  }

  /** Ping the relay every PING_MS; drop the socket when it stops answering, and look again after a sleep. */
  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.awaiting = 0;
    this.probing = 0;
    this.echoes = false;
    const pingMs = this.ctx.deps.connect?.pingMs ?? PING_MS;
    const timeoutMs = this.ctx.deps.connect?.pingTimeoutMs ?? PING_TIMEOUT_MS;
    let last = Date.now();
    let pinged = last;
    this.ping(); // at once, so we soon know whether this relay echoes
    this.heartbeat = setInterval(() => {
      if (this.sock !== ws) return;
      const now = Date.now();
      const slept = now - last > SLEPT_MS;
      last = now;
      if (slept) {
        this.awaiting = 0; // a ping from before the sleep says nothing
        this.check(ws, 'woke from sleep');
      } else if (this.echoes && this.awaiting && now - this.awaiting > timeoutMs) {
        this.lost(ws, 'the relay stopped answering');
      } else if (now - pinged >= pingMs) {
        pinged = now;
        this.ping();
      }
    }, Math.min(TICK_MS, Math.max(10, pingMs / 4)));
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.probe) clearTimeout(this.probe);
    this.heartbeat = this.probe = null;
  }

  /** A PING with the time in it (8 bytes): the relay sends it back as is. Returns that time. */
  private ping(): number {
    const now = Date.now();
    if (!this.awaiting) this.awaiting = now;
    this.pingStamp = Math.max(now, this.pingStamp + 1);
    this.sendFrame(encodeRelayFrame(RelayFrame.PING, 0, ackPayload(this.pingStamp)));
    return this.pingStamp;
  }

  /** The relay must answer a ping within PROBE_MS, or the socket is dropped and dialled again. */
  private check(ws: WebSocket, why: string): void {
    if (this.probe) return;
    // a relay that has never echoed can't be asked: start over
    if (!this.echoes) { this.lost(ws, why); return; }
    // only the echo of this ping (or of a later one) answers. Anything that was already on its way when the computer
    // woke or the network changed, an earlier ping's echo included, says nothing about the socket now
    const asked = this.ping();
    this.probing = asked;
    this.probe = setTimeout(() => {
      this.probe = null;
      if (this.sock === ws && this.probing === asked) this.lost(ws, `${why}; the relay didn’t answer`);
    }, this.ctx.deps.connect?.probeMs ?? PROBE_MS);
    this.probe.unref?.();
  }

  /** Give up on this socket: `close` follows, and onDrop dials again with the usual backoff. */
  private lost(ws: WebSocket, why: string): void {
    if (this.sock !== ws) return;
    this.ctx.log.warn(`connect: ${why}, reconnecting`);
    ws.terminate();
  }

  /** A phone on the relay: its messages go out as DATA frames of its stream, in place behind the relay header. */
  private relayStream(streamId: number, ip: string): PhoneStream {
    const stream: PhoneStream = new PhoneStream(this, this.ctx, {
      headroom: RELAY_HEADER,
      send: (msg) => this.sendFrame(writeRelayHeader(msg, RelayFrame.DATA, streamId)),
      // every phone shares the relay socket: their downloads take turns on it, and when it backs up anyway (the relay
      // stopped reading it for a slow phone, or the uplink is slow) each phone's gateway sockets wait
      bulk: this.relayLane,
      backlog: () => this.sock?.bufferedAmount ?? 0,
      end: (tell) => {
        if (tell) this.sendFrame(encodeRelayFrame(RelayFrame.CLOSE, streamId));
        if (this.streams.get(streamId) === stream) this.streams.delete(streamId);
      },
    }, ip, CONNECT_PEER_HEADER);
    return stream;
  }

  /**
   * A phone on the same Wi-Fi or over Tailscale opened the channel's own socket (the gateway's SECURE_PATH, already
   * admitted by its peer policy): one phone stream, the same handshake and limits as on the relay, its messages straight on the socket.
   * `ip` is the socket's real remote address: the gateway judges every replayed request by it. The local network's and
   * Tailscale's phones have MAX_DIRECT_STREAMS places each; when they're taken, one that hasn't signed in yet makes room.
   */
  acceptDirect(ws: WebSocket, ip: string): void {
    const tailscale = isTailscaleIp(ip);
    const pool = [...this.direct].filter((s) => isTailscaleIp(s.ip) === tailscale);
    if (pool.length >= MAX_DIRECT_STREAMS && !this.makeRoom(pool)) {
      this.noteDrop(`too many phones on the ${tailscale ? 'Tailscale' : 'Wi-Fi'} channel`);
      try { ws.close(1013, 'busy'); } catch { /* ignore */ }
      return;
    }
    const stream: PhoneStream = new PhoneStream(this, this.ctx, {
      headroom: 0,
      send: (msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); },
      bulk: new BulkLane(() => ws.bufferedAmount),
      backlog: () => ws.bufferedAmount,
      end: (tell) => {
        this.direct.delete(stream);
        if (tell) { try { ws.close(1008, 'channel ended'); } catch { /* ignore */ } }
      },
    }, ip, SECURE_PEER_HEADER);
    this.direct.add(stream);
    ws.on('message', (data: RawData, isBinary: boolean) => {
      // the channel is binary only: anything else isn't a phone speaking it
      if (!isBinary) { stream.reject('text on the channel'); return; }
      stream.onData(toU8(data));
    });
    ws.on('error', () => undefined);
    ws.on('close', () => stream.close(false));
  }

  /** Send one frame to the relay (dropped when the relay isn't there: the phones are closed then anyway). */
  sendFrame(frame: Uint8Array): void {
    const ws = this.sock;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(frame);
  }

  /** A full pool: the stream `evictee` picks (one not signed in yet) goes, so a new one can come in. False when none may. */
  private makeRoom(pool: Iterable<PhoneStream>): boolean {
    const victim = evictee(pool);
    victim?.evict();
    return !!victim;
  }

  /** This computer's X25519 keys, for the phones' handshakes. */
  get keys(): Identity { return this.identity(); }

  /** A phone stream's deadlines (ConnectDeps.stream over the defaults). */
  get streamTimes(): { helloMs: number; signInMs: number; idleMs: number; bodyMs: number } {
    const t = this.ctx.deps.connect?.stream;
    return { helloMs: t?.helloMs ?? HELLO_WAIT_MS, signInMs: t?.signInMs ?? SIGN_IN_WAIT_MS, idleMs: t?.idleMs ?? STREAM_IDLE_MS, bodyMs: t?.bodyMs ?? BODY_WAIT_MS };
  }

  /** @internal a phone stream's tag, while it lives */
  track(tag: string, stream: PhoneStream | null): void {
    if (stream) this.tagged.set(tag, stream);
    else this.tagged.delete(tag);
  }

  /**
   * The gateway saw the stream tagged `tag` prove itself: its WebSocket signed in, or a request with a valid token (or
   * the pairing code, or a page's key) was answered 2xx/3xx. It keeps its place from then on (until it goes idle).
   */
  vouch(tag: string | undefined): void {
    if (tag) this.tagged.get(tag)?.vouched();
  }

  /**
   * Whether the stream tagged `tag` has its gateway sockets paused while the phone's side catches up: they can't answer
   * the gateway's pings meanwhile, which doesn't make them dead (the phone's own socket, or the relay, says when it is).
   */
  backedUp(tag: string | undefined): boolean {
    return !!tag && !!this.tagged.get(tag)?.backedUp;
  }

  /** Log a dropped phone, at most one line every DROP_LOG_MS. */
  noteDrop(why: string): void {
    const now = Date.now();
    if (now - this.dropLoggedAt < DROP_LOG_MS) { this.dropsUnlogged += 1; return; }
    this.ctx.log.warn(`connect: dropping a phone (${why})${this.dropsUnlogged ? `, and ${this.dropsUnlogged} more since` : ''}`);
    this.dropLoggedAt = now;
    this.dropsUnlogged = 0;
  }
}

/* ------------------------------------------------------------ one phone */

/** Where a phone stream's messages go: a stream inside the relay's host socket, or a WebSocket of its own (the same Wi-Fi). */
interface StreamSink {
  /** bytes left free in front of every message for the transport's own framing (RELAY_HEADER on the relay) */
  readonly headroom: number;
  /** one message for the phone; its first `headroom` bytes are the transport's */
  send(msg: Uint8Array): void;
  /** where answer bodies wait their turn on the socket (the relay's is shared by every phone on it) */
  readonly bulk: BulkLane;
  /** bytes queued for the phone and not yet out (the socket the stream rides on) */
  backlog(): number;
  /** the stream is over: `tell` the far end too (the relay's CLOSE, or closing the socket); forgotten either way */
  end(tell: boolean): void;
}

/**
 * A gateway WebSocket for a phone, and the pieces of a long frame from the phone so far. `greeted`: the gateway's first
 * frame (the sign-in's answer) has gone to the phone, so it may be paused (`paused`) while the phone's side catches up.
 */
interface PhoneSocket { ws: WebSocket; parts: Uint8Array[] | null; size: number; greeted: boolean; paused: boolean }

/** One answer-body piece waiting its turn: `run` seals and sends it; what it throws goes to its own sender (`fail`). */
interface BulkJob { run: () => void; done: (sent: boolean) => void; fail: (e: unknown) => void }

/**
 * Answer bodies (downloads: files, pictures, pages) on one socket to the phones: the relay's, shared by every phone on
 * it, or a phone's own channel socket. A piece goes out only while the socket has less than BULK_HIGH_WATER queued and no
 * phone on it has its gateway sockets paused for the backlog (`hold`): chat and control messages, sent at once, never
 * wait behind more than a piece or two of a download, and a download never keeps chat paused. Phones take turns, one
 * piece each, so one phone's downloads don't hold up another's. Pure apart from its poll timer, for tests.
 */
export class BulkLane {
  /** each phone's pieces in order, phones in turn order (one that sent goes to the back) */
  private turns = new Map<object, BulkJob[]>();
  private holds = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private backlog: () => number, private highWater = BULK_HIGH_WATER) {}

  /** Pieces waiting, all phones together. */
  get waiting(): number {
    let n = 0;
    for (const q of this.turns.values()) n += q.length;
    return n;
  }

  /**
   * `run` (which sends one piece) runs when it is `owner`'s turn and the socket has room; true then, false when `owner`
   * was dropped (`drop`) before its turn came; rejected with what `run` threw (never thrown into the lane's timer).
   */
  send(owner: object, run: () => void): Promise<boolean> {
    return new Promise<boolean>((done, fail) => {
      const q = this.turns.get(owner);
      if (q) q.push({ run, done, fail });
      else this.turns.set(owner, [{ run, done, fail }]);
      this.pump();
    });
  }

  /** A phone's gateway sockets were paused for the backlog (`on`), or read again: no piece goes out while any is. */
  hold(on: boolean): void {
    this.holds = Math.max(0, this.holds + (on ? 1 : -1));
    if (!this.holds) this.pump();
  }

  /** The phone is gone: its pieces never go. */
  drop(owner: object): void {
    const q = this.turns.get(owner);
    if (!q) return;
    this.turns.delete(owner);
    for (const job of q) job.done(false);
  }

  private pump(): void {
    while (this.turns.size && !this.holds && this.backlog() < this.highWater) {
      const [owner, q] = this.turns.entries().next().value as [object, BulkJob[]];
      const job = q.shift()!;
      this.turns.delete(owner);
      if (q.length) this.turns.set(owner, q);
      try { job.run(); job.done(true); } catch (e) { job.fail(e); }
    }
    // a hold ends with a pump of its own; otherwise look again once the socket has had a moment to drain
    if (this.turns.size && !this.holds && !this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.pump(); }, BULK_POLL_MS);
      this.timer.unref?.();
    }
  }
}

/**
 * The stream a new one takes the place of when its pool is full: one that hasn't signed in yet (not vouched for), from
 * the address holding the most such streams (an IPv6 /64 as one), its oldest. Someone who fills the places with hellos
 * of their own loses those first, never a phone that has signed in. Null when every stream has.
 */
export function evictee<T extends { readonly proven: boolean; readonly since: number; readonly key: string }>(streams: Iterable<T>): T | null {
  const by = new Map<string, { n: number; oldest: T }>();
  for (const s of streams) {
    if (s.proven) continue;
    const e = by.get(s.key);
    if (!e) by.set(s.key, { n: 1, oldest: s });
    else {
      e.n += 1;
      if (s.since < e.oldest.since) e.oldest = s;
    }
  }
  let pick: { n: number; oldest: T } | null = null;
  // the most streams; between equals, the one whose oldest came first
  for (const e of by.values()) if (!pick || e.n > pick.n || (e.n === pick.n && e.oldest.since < pick.oldest.since)) pick = e;
  return pick?.oldest ?? null;
}

/** One HTTP request from a phone. */
interface PhoneRequest {
  head: HttpRequestHead;
  abort: AbortController;
  started: boolean;
  /** the body is complete (the phone's HTTP_REQ_END came) or no longer read (the gateway let it go) */
  ended: boolean;
  /** answered, failed or cancelled: whatever else comes for it is ignored */
  done: boolean;
  /** body bytes from the phone so far; read by the gateway; of those, told to the phone (HTTP_ACK) */
  size: number;
  taken: number;
  acked: number;
  /** body pieces the gateway hasn't read yet (a queue from `first`) and their bytes */
  queue: Uint8Array[];
  first: number;
  held: number;
  /** the gateway waits for the next piece */
  wake: (() => void) | null;
  /** answer bytes sent, and how many the phone says it has (HTTP_ACK) */
  sent: number;
  peerTaken: number;
  /** the answer waits for the phone's ack */
  roomWake: (() => void) | null;
  /** when its body last came or was taken (or the head came): a body that stops for BODY_WAIT_MS lets the request go */
  bodyAt: number;
}

/**
 * One phone on the channel, through the relay or straight on the Wi-Fi (its `sink`): its end-to-end channel and what
 * it asked for. It replays the phone's gateway WebSocket and HTTP requests against this computer's gateway on loopback,
 * marked with `peerHeader` (`CONNECT_PEER_HEADER` on the relay, `SECURE_PEER_HEADER` on the Wi-Fi) set to the phone's
 * address, and sends the answers back sealed. Anything that fails to open (cut, tampered, replayed, out of order),
 * throws, or holds too much ends the stream; so does no hello within HELLO_WAIT_MS, not proving it's a paired phone
 * within SIGN_IN_WAIT_MS of READY (the gateway vouches for it: `vouched`), or nothing at all for STREAM_IDLE_MS.
 */
class PhoneStream {
  private ch: SecureChannel | null = null;
  private closed = false;
  private sockets = new Map<number, PhoneSocket>();
  private requests = new Map<number, PhoneRequest>();
  /** bytes held for the gateway by this phone */
  private held = 0;
  private helloTimer: ReturnType<typeof setTimeout> | null;
  /** what its replays carry (STREAM_TAG_HEADER), so the gateway can vouch for it */
  private readonly tag = randomBytes(16).toString('hex');
  /** the gateway saw it sign in (or a request with its token succeed): it keeps its place */
  private signedIn = false;
  /** when it came, and its address as limits count it: what `evictee` weighs */
  readonly since = Date.now();
  readonly key: string;
  private signInTimer: ReturnType<typeof setTimeout> | null = null;
  /** the idle and stalled-body check, from READY on */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** the last message either way */
  private activeAt = Date.now();
  /** its gateway sockets aren't read while the phone's side is backed up (the poll that reads them again) */
  private backlogTimer: ReturnType<typeof setInterval> | null = null;
  private readonly times: { helloMs: number; signInMs: number; idleMs: number; bodyMs: number };

  constructor(private svc: ConnectService, private ctx: CoreCtx, private sink: StreamSink, readonly ip: string, private peerHeader: string) {
    this.key = addressKey(ip) || ip;
    this.times = svc.streamTimes;
    svc.track(this.tag, this);
    this.helloTimer = setTimeout(() => { this.helloTimer = null; if (!this.ch) this.drop('no hello'); }, this.times.helloMs);
    this.helloTimer.unref?.();
  }

  /** Signed in (the gateway vouched for it): it keeps its place. */
  get proven(): boolean { return this.signedIn; }

  /** Its gateway sockets are paused until the phone's side catches up. */
  get backedUp(): boolean { return !!this.backlogTimer; }

  /** The gateway vouched for this stream (`ConnectService.vouch`). */
  vouched(): void {
    if (this.closed || this.signedIn) return;
    this.signedIn = true;
    if (this.signInTimer) clearTimeout(this.signInTimer);
    this.signInTimer = null;
  }

  /** Its pool is full and it hadn't signed in yet: it makes room for a new one. */
  evict(): void {
    if (!this.closed) this.drop('made room for a new phone');
  }

  /** From READY: prove itself in time, and be let go when idle or when a request's body stalls. */
  private armDeadlines(): void {
    this.signInTimer = setTimeout(() => { this.signInTimer = null; if (!this.signedIn) this.drop('did not sign in'); }, this.times.signInMs);
    this.signInTimer.unref?.();
    const every = Math.max(10, Math.min(5_000, Math.min(this.times.idleMs, this.times.bodyMs) / 4));
    this.sweepTimer = setInterval(() => this.sweep(), every);
    this.sweepTimer.unref?.();
  }

  private sweep(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const [id, r] of this.requests) {
      if (!r.done && !r.ended && now - r.bodyAt >= this.times.bodyMs) this.fail(id, r, 'the request body stopped coming');
    }
    if (!this.sockets.size && !this.requests.size && now - this.activeAt >= this.times.idleMs) this.drop('idle');
  }

  private get base(): string { return `127.0.0.1:${this.ctx.gateway.port}`; }

  onData(payload: Uint8Array): void {
    if (this.closed) return;
    this.activeAt = Date.now();
    try {
      if (!this.ch) { this.hello(payload); return; }
      const m = this.ch.open(payload);
      if (!m) { this.drop('a message did not open'); return; }
      this.handle(m);
    } catch (e) {
      this.drop(`a message failed: ${errMsg(e)}`);
    }
  }

  /** The phone's hello: our reply carries our fresh key and the sealed READY, framed in place. */
  private hello(payload: Uint8Array): void {
    const accepted = acceptHello(this.svc.keys, payload, this.sink.headroom);
    if (accepted) {
      this.ch = accepted.channel;
      this.clearHelloTimer();
      this.sink.send(accepted.reply);
      this.armDeadlines();
      return;
    }
    if (payload.length > 0 && payload[0] !== CHANNEL_VERSION) {
      // a phone on another version: tell it ours (from which it tells which side must update), then end the stream
      const v = versionReply();
      const out = new Uint8Array(this.sink.headroom + v.length);
      out.set(v, this.sink.headroom);
      this.sink.send(out);
      this.drop(`a phone on channel version ${payload[0]} (ours ${CHANNEL_VERSION}: ${payload[0]! < CHANNEL_VERSION ? 'the phone' : 'this computer'} must update)`);
      return;
    }
    this.drop('not a hello');
  }

  private clearHelloTimer(): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
  }

  private handle(m: ChannelMessage): void {
    switch (m.kind) {
      case Msg.WS_OPEN: return this.openSocket(m.id, parseJsonBytes<WsOpenHead>(m.payload));
      case Msg.WS_MORE: return this.socketText(m.id, m.payload, false);
      case Msg.WS_TEXT: return this.socketText(m.id, m.payload, true);
      case Msg.WS_CLOSE: {
        const s = this.sockets.get(m.id);
        if (!s) return;
        this.sockets.delete(m.id);
        this.forgetParts(s);
        try { s.ws.close(1000); } catch { /* ignore */ }
        return;
      }
      case Msg.HTTP_REQ: return this.startRequest(m.id, parseJsonBytes<HttpRequestHead>(m.payload));
      case Msg.HTTP_REQ_BODY: return this.requestBody(m.id, m.payload);
      case Msg.HTTP_REQ_END: {
        const r = this.requests.get(m.id);
        if (!r || r.done || r.ended) return;
        r.ended = true;
        wake(r);
        if (!r.started) this.run(m.id, r, false);
        return;
      }
      case Msg.HTTP_ACK: {
        const r = this.requests.get(m.id);
        const n = parseAck(m.payload);
        if (!r || n === null || n <= r.peerTaken) return;
        r.peerTaken = n;
        r.roomWake?.();
        return;
      }
      case Msg.HTTP_CANCEL: {
        const r = this.requests.get(m.id);
        if (r) this.finish(m.id, r);
        return;
      }
      default: return; // nothing else comes from a phone
    }
  }

  private send(kind: MsgKind, id: number, payload?: Uint8Array): void {
    if (this.closed || !this.ch) return;
    this.activeAt = Date.now();
    // sealed and sent in the same tick, so the numbers reach the phone in order; the transport's framing goes in front in place
    this.sink.send(this.ch.seal(kind, id, payload, this.sink.headroom));
  }

  /** Room for `n` more held bytes on this phone and overall (counted when there is). */
  private hold(n: number): boolean {
    const lim = this.svc.limits;
    if (this.held + n > lim.streamHold || this.svc.held + n > lim.totalHold) return false;
    this.held += n;
    this.svc.held += n;
    return true;
  }

  private unhold(n: number): void {
    this.held -= n;
    this.svc.held -= n;
  }

  /* ---------- the gateway WebSocket ---------- */

  private openSocket(id: number, head: WsOpenHead | null): void {
    if (!head || typeof head.path !== 'string' || !/^\/ws(\?|$)/.test(head.path) || this.sockets.has(id) || this.sockets.size >= MAX_SOCKETS_PER_PHONE) {
      this.send(Msg.WS_CLOSE, id, jsonBytes({ code: 1008, reason: 'not allowed' }));
      return;
    }
    const ws = new WebSocket(`ws://${this.base}${head.path}`, { headers: { [this.peerHeader]: this.ip, [STREAM_TAG_HEADER]: this.tag } });
    const s: PhoneSocket = { ws, parts: null, size: 0, greeted: false, paused: false };
    this.sockets.set(id, s);
    // read from the start, backlog or not: the answer to its sign-in must reach the phone (paused only after it)
    ws.on('open', () => this.guard(() => this.send(Msg.WS_OPEN, id)));
    ws.on('message', (data: RawData) => this.guard(() => this.gatewayText(id, s, toU8(data))));
    ws.on('error', () => undefined);
    ws.on('close', (code: number, reason: Buffer) => this.guard(() => {
      if (this.sockets.get(id) !== s) return;
      this.sockets.delete(id);
      this.forgetParts(s);
      this.send(Msg.WS_CLOSE, id, jsonBytes({ code, reason: reason.toString('utf8') }));
    }));
  }

  /** Run a gateway socket's event: whatever it throws ends this phone, never the app. */
  private guard(fn: () => void): void {
    if (this.closed) return;
    try { fn(); } catch (e) { this.drop(`a gateway message failed: ${errMsg(e)}`); }
  }

  /** A frame (or a piece of one) for the gateway; a long frame is put together first, within the byte budget. */
  private socketText(id: number, piece: Uint8Array, last: boolean): void {
    const s = this.sockets.get(id);
    if (!s) return;
    if (last && !s.parts) {
      if (s.ws.readyState === WebSocket.OPEN) s.ws.send(piece, { binary: false });
      return;
    }
    if (s.size + piece.length > CHANNEL_MESSAGE_MAX || !this.hold(piece.length)) { this.drop('a WebSocket message too large'); return; }
    s.size += piece.length;
    (s.parts ??= []).push(piece);
    if (!last) return;
    const whole = Buffer.concat(s.parts, s.size);
    this.forgetParts(s);
    if (s.ws.readyState === WebSocket.OPEN) s.ws.send(whole, { binary: false });
  }

  private forgetParts(s: PhoneSocket): void {
    if (s.size) this.unhold(s.size);
    s.parts = null;
    s.size = 0;
  }

  /** A frame from the gateway for the phone: in pieces (WS_MORE…, then WS_TEXT) when longer than one message. */
  private gatewayText(id: number, s: PhoneSocket, bytes: Uint8Array): void {
    if (this.sockets.get(id) !== s) return;
    if (bytes.length > CHANNEL_MESSAGE_MAX) { try { s.ws.close(1009, 'message too big'); } catch { /* ignore */ } return; }
    let at = 0;
    for (; bytes.length - at > CHANNEL_CHUNK; at += CHANNEL_CHUNK) this.send(Msg.WS_MORE, id, bytes.subarray(at, at + CHANNEL_CHUNK));
    this.send(Msg.WS_TEXT, id, at ? bytes.subarray(at) : bytes);
    s.greeted = true;
    this.watchBacklog();
  }

  /**
   * The phone's side is PHONE_HIGH_WATER behind: its gateway sockets aren't read until it is under PHONE_LOW_WATER. What
   * the gateway sends them then waits in the loopback socket and the gateway's own buffer, which is what its guards look
   * at (a live picture dropped, a tier skipped, a socket hopelessly behind closed), rather than piling up here unseen.
   * Downloads on the same socket wait too (`BulkLane.hold`), so the backlog drains rather than refilling. A socket whose
   * sign-in hasn't been answered yet keeps being read: it is paused only once its answer has gone out.
   */
  private watchBacklog(): void {
    if (this.closed) return;
    if (!this.backlogTimer) {
      if (this.sink.backlog() <= PHONE_HIGH_WATER) return;
      this.sink.bulk.hold(true);
      this.backlogTimer = setInterval(() => {
        if (this.closed) { this.stopBacklogWatch(); return; }
        if (this.sink.backlog() <= PHONE_LOW_WATER) this.stopBacklogWatch();
      }, BACKLOG_POLL_MS);
      this.backlogTimer.unref?.();
    }
    for (const s of this.sockets.values()) {
      if (s.greeted && !s.paused) { s.paused = true; s.ws.pause(); }
    }
  }

  /** Caught up (or over): its gateway sockets are read again, and downloads may go on. */
  private stopBacklogWatch(): void {
    if (!this.backlogTimer) return;
    clearInterval(this.backlogTimer);
    this.backlogTimer = null;
    for (const s of this.sockets.values()) {
      if (s.paused) { s.paused = false; s.ws.resume(); }
    }
    this.sink.bulk.hold(false);
  }


  /* ---------- HTTP ---------- */

  private startRequest(id: number, head: HttpRequestHead | null): void {
    const method = head?.method?.toUpperCase() ?? '';
    if (!head || !METHODS.has(method) || typeof head.path !== 'string' || !head.path.startsWith('/') || head.path.startsWith('//') || this.requests.has(id)) {
      this.send(Msg.HTTP_ERR, id, jsonBytes({ message: 'bad request' }));
      return;
    }
    if (this.requests.size >= MAX_REQUESTS_PER_PHONE) {
      this.send(Msg.HTTP_ERR, id, jsonBytes({ message: 'too many requests at once' }));
      return;
    }
    this.requests.set(id, {
      head: { ...head, method }, abort: new AbortController(), started: false, ended: false, done: false,
      size: 0, taken: 0, acked: 0, queue: [], first: 0, held: 0, wake: null, sent: 0, peerTaken: 0, roomWake: null, bodyAt: Date.now(),
    });
  }

  /** A piece of a request body: queued for the gateway, which starts reading at the first one. */
  private requestBody(id: number, piece: Uint8Array): void {
    const r = this.requests.get(id);
    if (!r || r.done || r.ended || r.head.method === 'GET' || r.head.method === 'HEAD') return;
    r.size += piece.length;
    r.bodyAt = Date.now();
    if (r.size > this.svc.limits.requestBody) { this.fail(id, r, 'request too large'); return; }
    if (!this.hold(piece.length)) { this.fail(id, r, 'too much at once: wait for the computer to take it'); return; }
    r.held += piece.length;
    // the payload is a view into its own decrypted message, kept as is
    r.queue.push(piece);
    wake(r);
    if (!r.started) this.run(id, r, true);
  }

  private run(id: number, r: PhoneRequest, withBody: boolean): void {
    r.started = true;
    void this.runRequest(id, r, withBody);
  }

  /** The body as the gateway reads it: one piece per pull, waiting for the phone when the queue is empty. */
  private bodyStream(id: number, r: PhoneRequest): ReadableStream<Uint8Array> {
    const pull = (c: ReadableStreamDefaultController<Uint8Array>): Promise<void> | void => {
      if (r.done) { try { c.close(); } catch { /* cancelled */ } return; }
      if (r.first < r.queue.length) {
        const piece = r.queue[r.first]!;
        r.queue[r.first++] = EMPTY;
        if (r.first === r.queue.length) { r.queue.length = 0; r.first = 0; }
        r.held -= piece.length;
        this.unhold(piece.length);
        r.taken += piece.length;
        r.bodyAt = Date.now();
        // the phone sends at most CHANNEL_WINDOW past what it was told was taken
        if (r.taken - r.acked >= CHANNEL_ACK_EVERY) { r.acked = r.taken; this.send(Msg.HTTP_ACK, id, ackPayload(r.taken)); }
        c.enqueue(piece);
        return;
      }
      if (r.ended) { c.close(); return; }
      return new Promise<void>((resolve) => { r.wake = resolve; }).then(() => pull(c));
    };
    // the gateway letting the body go: what is queued, and whatever more comes, is dropped
    return new ReadableStream<Uint8Array>({ pull, cancel: () => { r.ended = true; this.dropQueue(r); } }, { highWaterMark: 0 });
  }

  /**
   * Wait until the phone has room for `n` more bytes of this answer (it may be CHANNEL_WINDOW behind); false when the
   * request ended meanwhile or the phone took nothing for ACK_WAIT_MS.
   */
  private room(r: PhoneRequest, n: number): boolean | Promise<boolean> {
    if (r.sent + n - r.peerTaken <= CHANNEL_WINDOW) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { r.roomWake = null; resolve(false); }, ACK_WAIT_MS);
      r.roomWake = () => {
        if (!r.done && r.sent + n - r.peerTaken > CHANNEL_WINDOW) return;
        clearTimeout(timer);
        r.roomWake = null;
        resolve(!r.done);
      };
    });
  }

  private async runRequest(id: number, r: PhoneRequest, withBody: boolean): Promise<void> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let whole = false;
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(r.head.headers ?? {})) if (typeof v === 'string' && !HOP.has(k.toLowerCase())) headers.set(k, v);
      headers.set(this.peerHeader, this.ip);
      headers.set(STREAM_TAG_HEADER, this.tag);
      const init: RequestInit & { duplex?: 'half' } = { method: r.head.method, headers, redirect: 'manual', signal: r.abort.signal };
      if (withBody) { init.body = this.bodyStream(id, r); init.duplex = 'half'; }
      const res = await fetch(`http://${this.base}${r.head.path}`, init);
      if (r.done) { await res.body?.cancel().catch(() => undefined); return; }
      // fetch hands over a decoded body: with a content-encoding neither it nor the length describes what we send on
      const decoded = res.headers.has('content-encoding');
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => { if (!HOP.has(k) && !(decoded && k === 'content-encoding')) out[k] = v; });
      const length = res.headers.get('content-length');
      if (length !== null && !decoded) out['content-length'] = length; // lets the phone tell a cut-short answer
      this.send(Msg.HTTP_RES, id, jsonBytes({ status: res.status, headers: out }));
      if (res.body) {
        reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (let at = 0; at < value.length; at += CHANNEL_CHUNK) {
            const piece = value.subarray(at, at + CHANNEL_CHUNK);
            if (!r.done && !(await this.room(r, piece.length))) this.fail(id, r, 'the phone stopped taking the answer');
            if (r.done || this.closed) return;
            // its turn on the socket, after the other phones' and once chat has room (sealed only then, so in order)
            await this.sink.bulk.send(this, () => {
              if (r.done || this.closed) return;
              this.send(Msg.HTTP_RES_BODY, id, piece);
              r.sent += piece.length;
            });
            if (r.done || this.closed) return;
          }
        }
      }
      whole = true;
      if (!r.done) this.send(Msg.HTTP_RES_END, id);
    } catch (e) {
      if (!r.done && !this.closed) this.send(Msg.HTTP_ERR, id, jsonBytes({ message: errMsg(e) }));
    } finally {
      if (reader && !whole) await reader.cancel().catch(() => undefined);
      // answered whole with the body all read: nothing to stop; otherwise the fetch, or a body still coming, goes
      this.finish(id, r, !whole || !r.ended);
    }
  }

  /** Tell the phone a request failed, and stop it. */
  private fail(id: number, r: PhoneRequest, message: string): void {
    if (r.done) return;
    this.send(Msg.HTTP_ERR, id, jsonBytes({ message }));
    this.finish(id, r);
  }

  /** A request is over (answered, failed or cancelled): let go of its body and (`stop`) of the fetch still running for it. */
  private finish(id: number, r: PhoneRequest, stop = true): void {
    if (this.requests.get(id) === r) this.requests.delete(id);
    if (r.done) return;
    r.done = true;
    this.dropQueue(r);
    if (stop) r.abort.abort();
    wake(r);
    r.roomWake?.();
  }

  private dropQueue(r: PhoneRequest): void {
    if (r.held) this.unhold(r.held);
    r.held = 0;
    r.queue = [];
    r.first = 0;
  }

  private drop(why: string): void {
    this.svc.noteDrop(why);
    this.close(true);
  }

  /** The transport saw something no phone speaking the channel sends: end it. */
  reject(why: string): void {
    if (!this.closed) this.drop(why);
  }

  /** End this phone: its sockets and requests stop; `tell` also closes it at the far end (the relay, or its socket). */
  close(tell: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.clearHelloTimer();
    if (this.signInTimer) clearTimeout(this.signInTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.signInTimer = this.sweepTimer = null;
    this.stopBacklogWatch();
    this.sink.bulk.drop(this);
    this.svc.track(this.tag, null);
    // its keys go with it
    this.ch?.close();
    for (const s of this.sockets.values()) {
      s.parts = null;
      s.size = 0;
      try { s.ws.close(1001); } catch { /* ignore */ }
    }
    this.sockets.clear();
    for (const r of this.requests.values()) {
      r.done = true;
      r.abort.abort();
      r.queue = [];
      r.held = 0;
      wake(r);
      r.roomWake?.();
    }
    this.requests.clear();
    // everything this phone held, its sockets' pieces included
    this.svc.held -= this.held;
    this.held = 0;
    this.sink.end(tell);
  }
}

function wake(r: PhoneRequest): void {
  const w = r.wake;
  r.wake = null;
  w?.();
}

function toU8(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
