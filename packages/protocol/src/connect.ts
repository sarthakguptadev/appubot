/**
 * AppuBot Connect — the shared contract for the relay that lets a paired phone reach its computer from anywhere.
 *
 * Both the Mac and the phone dial out to one relay (connect.appubot.com); the relay pairs them by a *room* and copies
 * bytes it cannot read. This module is the part both ends (and the relay) must agree on: the relay address, how a room
 * id is derived from the Mac's key, and the end-to-end encryption that keeps the relay (which terminates TLS) from
 * reading the gateway traffic — including the device token.
 *
 * The key exchange and signatures are `@noble/*` (pure JS, and small) so the exact same code runs in Electron's Node main
 * and in the phone's React Native runtime, neither of which has WebCrypto X25519/Ed25519 everywhere. The bulk cipher,
 * AES-256-GCM, is each runtime's native one (`channelCipher.ts`): node:crypto on the Mac, expo-crypto on the phone.
 *
 * Keys:
 *  - The Mac holds one Ed25519 identity keypair (kept in connect.json). The *room id* is a fingerprint of its public
 *    key, so it is stable across restarts, and the Mac proves it owns the room by signing the relay's challenge — no
 *    one can serve another computer's room without its private key.
 *  - End-to-end encryption uses X25519, Noise NK style. The pairing QR carries the Mac's static X25519 public key
 *    (shown on the Mac's own screen, so the phone pins it and the relay cannot impersonate the Mac). Per connection
 *    both sides make a fresh ephemeral key, and the session keys come from both DH(phone ephemeral, Mac static) and
 *    DH(phone ephemeral, Mac ephemeral) over the handshake's transcript: only the real Mac can derive them, a recorded
 *    connection replayed later meets a new Mac ephemeral and opens nothing, and a stolen Mac key doesn't open past
 *    traffic. Every gateway frame is then sealed with AES-256-GCM before it touches the relay.
 */

import { ed25519, x25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { expand, extract } from '@noble/hashes/hkdf';
import { CHANNEL_NONCE, CHANNEL_TAG, localChannelCipher, type ChannelCipher, type CipherResult, type SyncChannelCipher } from './channelCipher';

/** The one relay everyone dials. Override in dev with a wss:// URL. */
export const CONNECT_RELAY_URL = 'wss://connect.appubot.com';

/** Base32 (RFC 4648 lowercase, no padding) — matches the relay's own `base32`, so a room id reads the same everywhere. */
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
export function base32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export const ROOM_ID_RE = /^[a-z2-7]{26}$/;

/** base64url without padding, in plain JS (no Buffer/btoa needed: React Native has neither everywhere). */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]!;
  }
  return out;
}
export function fromBase64Url(s: string): Uint8Array | null {
  const clean = s.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (!/^[A-Za-z0-9_-]*$/.test(clean) || clean.length % 4 === 1) return null;
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = (value << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** A room id is the first 26 base32 chars (130 bits) of SHA-256 of the Mac's Ed25519 public key. */
export function roomIdForPublicKey(ed25519PublicKey: Uint8Array): string {
  return base32(sha256(ed25519PublicKey)).slice(0, 26);
}

/* ---------- the Mac's identity (room ownership) ---------- */

export interface Identity {
  /** 32-byte Ed25519 secret key (seed) */
  edSecret: Uint8Array;
  /** 32-byte Ed25519 public key */
  edPublic: Uint8Array;
  /** 32-byte X25519 secret key (for end-to-end encryption) */
  xSecret: Uint8Array;
  /** 32-byte X25519 public key */
  xPublic: Uint8Array;
}

/** Make a fresh identity (the Mac does this once and keeps the secrets in connect.json, 0600). */
export function createIdentity(): Identity {
  const edSecret = ed25519.utils.randomPrivateKey();
  const xSecret = x25519.utils.randomPrivateKey();
  return {
    edSecret,
    edPublic: ed25519.getPublicKey(edSecret),
    xSecret,
    xPublic: x25519.getPublicKey(xSecret),
  };
}

/** The identity again from the two saved secrets (connect.json). */
export function identityFromSecrets(edSecret: Uint8Array, xSecret: Uint8Array): Identity {
  return { edSecret, edPublic: ed25519.getPublicKey(edSecret), xSecret, xPublic: x25519.getPublicKey(xSecret) };
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const EMPTY = new Uint8Array(0);

/**
 * What the Mac signs to claim its room: this context, then the relay's nonce. The context keeps the signature from
 * meaning anything anywhere else (the relay verifies exactly these bytes).
 */
export const HOST_CHALLENGE_CONTEXT = 'appubot-connect-host-v1\n';
const CHALLENGE_PREFIX = enc.encode(HOST_CHALLENGE_CONTEXT);

/** The bytes signed for a relay challenge: HOST_CHALLENGE_CONTEXT (UTF-8) followed by the nonce. */
export function challengeMessage(nonce: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(CHALLENGE_PREFIX.length + nonce.length);
  out.set(CHALLENGE_PREFIX, 0);
  out.set(nonce, CHALLENGE_PREFIX.length);
  return out;
}

/** The Mac signs the relay's challenge nonce with its Ed25519 key to claim its room. */
export function signChallenge(edSecret: Uint8Array, nonce: Uint8Array): Uint8Array {
  return ed25519.sign(challengeMessage(nonce), edSecret);
}

/** An X25519 keypair, fresh per connection on both sides. */
export function createEphemeralKeypair(): { secret: Uint8Array; public: Uint8Array } {
  const secret = x25519.utils.randomPrivateKey();
  return { secret, public: x25519.getPublicKey(secret) };
}

/* ---------- the channel: what a phone and its Mac say inside one relay stream ----------
 *
 * The same channel runs on the same Wi-Fi without the relay: a WebSocket straight to the gateway's SECURE_PATH is one
 * stream, its binary messages exactly what DATA frames carry on the relay (no RELAY_HEADER), so the device token never
 * crosses the local network in the clear either.
 *
 * 1. The phone's first binary message on the stream is its hello, in the clear: [CHANNEL_VERSION][its fresh 32-byte
 *    X25519 public key] (`helloFrame`).
 * 2. The Mac makes a fresh X25519 key of its own for this stream and answers [CHANNEL_VERSION][its ephemeral public
 *    key][sealed READY] (`acceptHello`). Both derive two keys, one per direction, from DH(phone eph, Mac static) and
 *    DH(phone eph, Mac eph), salted with a hash of the transcript (the Mac's static key, the hello, the Mac's
 *    ephemeral key). Only the Mac can make a READY that opens (it needs the static secret matching the key the phone
 *    pinned from the QR), so the phone sends nothing else until it does (`phoneHandshake`). A Mac that doesn't speak
 *    the hello's version answers its own version byte alone and closes the stream.
 * 3. Every sealed message after that is AES-256-GCM (a 16-byte tag) with its nonce the message's number (1, 2, 3… per
 *    direction, never sent: 8 bytes big-endian, then 4 zero bytes): a message the relay drops, repeats, reorders or
 *    bounces back fails to open, and any failure ends the stream (the client reconnects; the gateway's resume replays
 *    its events). The READY is sealed the same way, as message 1 from the Mac.
 *
 * Inside: the gateway WebSocket (WS_OPEN / WS_TEXT / WS_CLOSE, by id; a text frame longer than CHANNEL_CHUNK goes as
 * WS_MORE pieces ending with a WS_TEXT, at most CHANNEL_MESSAGE_MAX in all) and HTTP requests (HTTP_REQ head + body
 * chunks + end, answered by HTTP_RES head + body chunks + end, or HTTP_ERR), so files, pictures, pages and uploads
 * cross the relay end to end too. Bodies go in chunks of at most CHANNEL_CHUNK bytes, at most CHANNEL_WINDOW of them
 * unacknowledged (HTTP_ACK), so neither end nor the relay holds more than that per request; HTTP_CANCEL stops one.
 */

/** 3: AES-256-GCM (2 was ChaCha20-Poly1305, in plain JavaScript); either end refuses another version. */
export const CHANNEL_VERSION = 3;
/** The biggest sealed message either side sends or accepts (the relay refuses single messages near 1 MB). */
export const CHANNEL_FRAME_MAX = 256 * 1024;
/** The most one sealed message carries: bodies and long WebSocket frames go in pieces of this. */
export const CHANNEL_CHUNK = CHANNEL_FRAME_MAX - 64;
/** The longest WebSocket text frame either side reassembles; longer ends the stream. */
export const CHANNEL_MESSAGE_MAX = 64 * 1024 * 1024;
/** Body bytes a sender may have out before the receiver acknowledges them (HTTP_ACK). */
export const CHANNEL_WINDOW = 4 * 1024 * 1024;
/** The receiver acknowledges a body after this many more bytes. */
export const CHANNEL_ACK_EVERY = CHANNEL_WINDOW / 4;

export const Msg = {
  /** Mac → phone, first, inside its hello reply: the Mac holds the key the phone pinned */
  READY: 1,
  /** phone → Mac: open the gateway WebSocket (JSON head {path}); Mac → phone: it is open (same id) */
  WS_OPEN: 2,
  /** a text frame of that WebSocket (or the last piece of one), either way */
  WS_TEXT: 3,
  /** that WebSocket closed (JSON {code, reason}), either way */
  WS_CLOSE: 4,
  /** phone → Mac: an HTTP request's head (JSON {method, path, headers}) */
  HTTP_REQ: 5,
  HTTP_REQ_BODY: 6,
  HTTP_REQ_END: 7,
  /** Mac → phone: the response head (JSON {status, headers}) */
  HTTP_RES: 8,
  HTTP_RES_BODY: 9,
  HTTP_RES_END: 10,
  /** Mac → phone: the request failed before a response (JSON {message}) */
  HTTP_ERR: 11,
  /** a piece of a WebSocket text frame too long for one message, either way; the frame ends with a WS_TEXT */
  WS_MORE: 12,
  /** the receiver of a body has taken this many bytes of it (`ackPayload`): Mac → phone for a request body, phone → Mac for a response body */
  HTTP_ACK: 13,
  /** phone → Mac: stop that request (aborted, timed out, too big); nothing more comes for it */
  HTTP_CANCEL: 14,
} as const;
export type MsgKind = (typeof Msg)[keyof typeof Msg];

export interface ChannelMessage { kind: MsgKind; id: number; payload: Uint8Array }

export interface SessionKeys { send: Uint8Array; recv: Uint8Array }

const PROTOCOL = enc.encode('appubot-connect-v3');
const P2M = enc.encode('appubot-connect-v3 phone-to-mac');
const M2P = enc.encode('appubot-connect-v3 mac-to-phone');
/** a sealed message's own bytes: kind, id, the GCM tag */
const HEAD = 5;
const TAG = CHANNEL_TAG;
const HELLO_LENGTH = 1 + 32;
/** the Mac's reply: [CHANNEL_VERSION][its ephemeral key][sealed READY] */
const REPLY_LENGTH = 1 + 32 + HEAD + TAG;

/**
 * Both directions' keys from the two DH results, salted with the transcript hash, so they are bound to this Mac, this
 * hello and this Mac ephemeral. Wipes the DH results.
 */
function sessionKeys(dhStatic: Uint8Array, dhEphemeral: Uint8Array, macStatic: Uint8Array, hello: Uint8Array, macEphemeral: Uint8Array, role: 'phone' | 'mac'): SessionKeys {
  const ikm = new Uint8Array(64);
  ikm.set(dhStatic, 0);
  ikm.set(dhEphemeral, 32);
  const transcript = sha256.create().update(PROTOCOL).update(macStatic).update(hello).update(macEphemeral).digest();
  const prk = extract(sha256, ikm, transcript);
  const p2m = expand(sha256, prk, P2M, 32);
  const m2p = expand(sha256, prk, M2P, 32);
  ikm.fill(0);
  prk.fill(0);
  dhStatic.fill(0);
  dhEphemeral.fill(0);
  return role === 'phone' ? { send: p2m, recv: m2p } : { send: m2p, recv: p2m };
}

/** The phone's hello: [CHANNEL_VERSION][its 32-byte X25519 public key]. */
export function helloFrame(phonePublic: Uint8Array): Uint8Array {
  const out = new Uint8Array(HELLO_LENGTH);
  out[0] = CHANNEL_VERSION;
  out.set(phonePublic, 1);
  return out;
}

/** The phone's public key from its hello, or null when it isn't one this version understands. */
export function parseHello(buf: Uint8Array): Uint8Array | null {
  return buf.length === HELLO_LENGTH && buf[0] === CHANNEL_VERSION ? buf.slice(1) : null;
}

/**
 * The Mac's side of the handshake: a fresh ephemeral key for this stream, the session keys, and its reply
 * [CHANNEL_VERSION][ephemeral public key][sealed READY], with `headroom` bytes left free in front for the caller's own
 * framing. Null for a hello it can't use (another version, a key with no shared secret). The cipher answers at once
 * (node:crypto on the Mac), so the reply goes out in the same tick.
 */
export function acceptHello(mac: { xSecret: Uint8Array; xPublic: Uint8Array }, hello: Uint8Array, headroom = 0, cipher: SyncChannelCipher = localChannelCipher()): { channel: SecureChannel; reply: Uint8Array } | null {
  const phone = parseHello(hello);
  if (!phone) return null;
  const eph = createEphemeralKeypair();
  let keys: SessionKeys;
  let dhStatic: Uint8Array | undefined;
  let dhEphemeral: Uint8Array | undefined;
  try {
    dhStatic = x25519.getSharedSecret(mac.xSecret, phone);
    dhEphemeral = x25519.getSharedSecret(eph.secret, phone);
    keys = sessionKeys(dhStatic, dhEphemeral, mac.xPublic, hello, eph.public, 'mac');
  } catch {
    // a small-order key: noble refuses the all-zero shared secret; whichever DH did come out goes too
    dhStatic?.fill(0);
    dhEphemeral?.fill(0);
    return null;
  } finally {
    eph.secret.fill(0);
  }
  const channel = SecureChannel.from(keys, cipher);
  const reply = channel.seal(Msg.READY, 0, EMPTY, headroom + 1 + 32);
  reply[headroom] = CHANNEL_VERSION;
  reply.set(eph.public, headroom + 1);
  return { channel, reply };
}

/** What a Mac that doesn't speak a hello's version answers before it closes the stream: its own version byte. */
export function versionReply(): Uint8Array {
  return Uint8Array.of(CHANNEL_VERSION);
}

/** The phone's side of a handshake. With an asynchronous cipher (`Sync` false: the phone's native one) `finish` answers with a promise. */
export interface PhoneHandshake<Sync extends boolean = true> {
  /** sent first, in the clear */
  readonly hello: Uint8Array;
  /** The Mac's reply: the channel when its READY opens (it holds the pinned key), else null. Once only. */
  finish(reply: Uint8Array): CipherResult<SecureChannel<Sync> | null, Sync>;
  /** Given up before a reply (timed out, closed, another version): the ephemeral secret is wiped; `finish` then opens nothing. */
  abandon(): void;
}

/**
 * The phone's side of the handshake with the Mac whose static X25519 key it pinned at pairing, its channel on `cipher`
 * (default: this runtime's own, which answers at once; the client passes `channelCipher()`, the phone's native one).
 */
export function phoneHandshake(macPublic: Uint8Array): PhoneHandshake;
export function phoneHandshake<S extends boolean>(macPublic: Uint8Array, cipher: ChannelCipher<any, S>): PhoneHandshake<S>;
export function phoneHandshake(macPublic: Uint8Array, cipher: ChannelCipher = localChannelCipher()): PhoneHandshake<boolean> {
  const eph = createEphemeralKeypair();
  const hello = helloFrame(eph.public);
  let used = false;
  return {
    hello,
    abandon() {
      used = true;
      eph.secret.fill(0);
    },
    finish(reply) {
      if (used || reply.length !== REPLY_LENGTH || reply[0] !== CHANNEL_VERSION) return null;
      used = true;
      const macEphemeral = reply.subarray(1, 33);
      let keys: SessionKeys;
      let dhStatic: Uint8Array | undefined;
      let dhEphemeral: Uint8Array | undefined;
      try {
        dhStatic = x25519.getSharedSecret(eph.secret, macPublic);
        dhEphemeral = x25519.getSharedSecret(eph.secret, macEphemeral);
        keys = sessionKeys(dhStatic, dhEphemeral, macPublic, hello, macEphemeral, 'phone');
      } catch {
        // a small-order key in the reply (a relay's doing): the DH with the pinned key is wiped too
        dhStatic?.fill(0);
        dhEphemeral?.fill(0);
        return null;
      } finally {
        eph.secret.fill(0);
      }
      // the READY must open: only the Mac holding the pinned key's secret could have sealed it under these keys
      const opened = after(SecureChannel.from(keys, cipher), (ch) => after(ch.open(reply.subarray(33)), (ready) => {
        if (ready?.kind === Msg.READY && ready.id === 0) return ch;
        ch.close();
        return null;
      }));
      // a native cipher that fails (a key it won't take) is a channel that didn't come up
      return isPromise(opened) ? opened.catch(() => null) : opened;
    },
  };
}

function isPromise<T>(v: T | Promise<T>): v is Promise<T> {
  return typeof (v as { then?: unknown } | null)?.then === 'function';
}

/** `f` of `v`: at once for a value, once it settles for a promise (so a synchronous cipher stays synchronous throughout). */
function after<T, U>(v: T | Promise<T>, f: (v: T) => U | Promise<U>): U | Promise<U> {
  return isPromise(v) ? v.then(f) : f(v);
}

/** `n` (below 2^53) as 8 bytes big-endian at `at`. */
function putU64(buf: Uint8Array, at: number, n: number): void {
  const hi = Math.floor(n / 2 ** 32);
  buf[at] = hi >>> 24; buf[at + 1] = (hi >>> 16) & 255; buf[at + 2] = (hi >>> 8) & 255; buf[at + 3] = hi & 255;
  buf[at + 4] = n >>> 24; buf[at + 5] = (n >>> 16) & 255; buf[at + 6] = (n >>> 8) & 255; buf[at + 7] = n & 255;
}

function u32(buf: Uint8Array, at: number): number {
  return ((buf[at]! << 24) | (buf[at + 1]! << 16) | (buf[at + 2]! << 8) | buf[at + 3]!) >>> 0;
}

/**
 * The nonce of message `n` in its direction (1, 2, 3…): `n` as 8 bytes big-endian, then 4 zero bytes. Each direction
 * has its own key, so a nonce never repeats under one key. Fresh each time: an asynchronous cipher may read it later.
 */
export function channelNonce(n: number): Uint8Array {
  const out = new Uint8Array(CHANNEL_NONCE);
  putU64(out, 0, n);
  return out;
}

/**
 * One side of a connection's sealed channel. A sealed message is AES-256-GCM of [1-byte kind][4-byte id][payload]
 * under that direction's key, its nonce the message's number (`channelNonce`). `open` takes only the next number, so a
 * dropped, repeated, reordered or reflected message fails, and after any failure it opens nothing more: the caller ends
 * the stream. `close` lets go of both keys (wiped, where the cipher holds the bytes) when the stream ends.
 *
 * Numbers are taken when `seal` and `open` are called. With an asynchronous cipher (`Sync` false: the phone's native
 * one) their answers are promises that may settle in any order, so the caller sends sealed messages, and hands opened
 * ones on, in the order it called (the client's `RelaySession` queues them); the Mac's cipher answers at once.
 */
export class SecureChannel<Sync extends boolean = true> {
  private sent = 0;
  private received = 0;
  /** the first message number that didn't open: nothing from there on is handed out */
  private failedAt = Infinity;
  private closed = false;
  private keys: { send: unknown; recv: unknown } | null;

  private constructor(private readonly cipher: ChannelCipher<unknown, Sync>, keys: { send: unknown; recv: unknown }) {
    this.keys = keys;
  }

  /** A channel on a handshake's two keys, made ready for `cipher` once each (the raw bytes are the cipher's from here). */
  static from<S extends boolean>(keys: SessionKeys, cipher: ChannelCipher<any, S>): CipherResult<SecureChannel<S>, S> {
    const send = cipher.importKey(keys.send);
    const recv = cipher.importKey(keys.recv);
    const made = isPromise(send) || isPromise(recv)
      ? Promise.all([send, recv]).then(([s, r]) => new SecureChannel<S>(cipher, { send: s, recv: r }))
      : new SecureChannel<S>(cipher, { send, recv });
    return made as CipherResult<SecureChannel<S>, S>;
  }

  /** The stream is over: both keys are let go of (wiped where they're bytes), and nothing is sealed or opened with this channel again. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const keys = this.keys;
    this.keys = null;
    if (keys) {
      this.cipher.drop(keys.send);
      this.cipher.drop(keys.recv);
    }
  }

  get isClosed(): boolean { return this.closed; }

  /**
   * Seal one message (payload at most CHANNEL_CHUNK), with `headroom` bytes left free in front for the caller's framing.
   * It takes the next number now: with an asynchronous cipher, send the answers in the order `seal` was called.
   */
  seal(kind: MsgKind, id: number, payload: Uint8Array = EMPTY, headroom = 0): CipherResult<Uint8Array, Sync> {
    // never with a key let go of (a wiped one is all zeros)
    if (this.closed || !this.keys) throw new Error('This channel is closed');
    if (payload.length > CHANNEL_CHUNK) throw new RangeError(`A channel message carries at most ${CHANNEL_CHUNK} bytes`);
    const head = new Uint8Array(HEAD);
    head[0] = kind;
    head[1] = id >>> 24;
    head[2] = (id >>> 16) & 255;
    head[3] = (id >>> 8) & 255;
    head[4] = id & 255;
    // the payload is sealed where it lies, behind its head (not copied first)
    return this.cipher.seal(this.keys.send, channelNonce(++this.sent), payload.length ? [head, payload] : [head], headroom);
  }

  /**
   * The next message from the other side, or null when it doesn't open (and from then on nothing does). It takes the next
   * number now: with an asynchronous cipher, call it in the order messages came and use the answers in that order.
   */
  open(sealed: Uint8Array): CipherResult<ChannelMessage | null, Sync> {
    const n = ++this.received;
    if (this.closed || !this.keys || n > this.failedAt) return null as CipherResult<ChannelMessage | null, Sync>;
    if (sealed.length < HEAD + TAG || sealed.length > CHANNEL_FRAME_MAX) return this.opened(n, null) as CipherResult<ChannelMessage | null, Sync>;
    let plain: Uint8Array | null | Promise<Uint8Array | null>;
    try {
      plain = this.cipher.open(this.keys.recv, channelNonce(n), sealed);
    } catch {
      plain = null;
    }
    const msg = isPromise(plain) ? plain.then((p) => this.opened(n, p), () => this.opened(n, null)) : this.opened(n, plain);
    return msg as CipherResult<ChannelMessage | null, Sync>;
  }

  /** Message `n`'s plaintext as a message, unless it didn't open, an earlier one didn't, or the channel closed meanwhile. */
  private opened(n: number, plain: Uint8Array | null): ChannelMessage | null {
    if (!plain) {
      if (n < this.failedAt) this.failedAt = n;
      return null;
    }
    if (this.closed || n > this.failedAt) return null;
    return { kind: plain[0] as MsgKind, id: u32(plain, 1), payload: plain.subarray(HEAD) };
  }
}

/** HTTP_ACK's payload: the count of body bytes taken so far, 8 bytes big-endian. */
export function ackPayload(taken: number): Uint8Array {
  const out = new Uint8Array(8);
  putU64(out, 0, taken);
  return out;
}

/** The count in an HTTP_ACK, or null when it isn't one. */
export function parseAck(payload: Uint8Array): number | null {
  return payload.length === 8 ? u32(payload, 0) * 2 ** 32 + u32(payload, 4) : null;
}

export function jsonBytes(v: unknown): Uint8Array {
  return enc.encode(JSON.stringify(v));
}

export function parseJsonBytes<T>(b: Uint8Array): T | null {
  try {
    return JSON.parse(dec.decode(b)) as T;
  } catch {
    return null;
  }
}

export function textBytes(s: string): Uint8Array {
  return enc.encode(s);
}

export function bytesText(b: Uint8Array): string {
  return dec.decode(b);
}

/** Split a body into CHANNEL_CHUNK pieces (at least one, possibly empty, is never sent: callers skip empty bodies). */
export function chunks(body: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < body.length; i += CHANNEL_CHUNK) out.push(body.subarray(i, i + CHANNEL_CHUNK));
  return out;
}

/** HTTP heads as they cross the channel. */
export interface HttpRequestHead { method: string; path: string; headers: Record<string, string> }
export interface HttpResponseHead { status: number; headers: Record<string, string> }
export interface WsOpenHead { path: string }
export interface WsCloseInfo { code: number; reason: string }

/* ---------- relay ↔ Mac framing ----------
 * The Mac's one /host socket carries every phone stream. Each binary message is [1-byte type][4-byte stream id,
 * big-endian][payload]: OPEN (a phone joined; payload = its address as the relay saw it), DATA (bytes for/from that
 * phone), CLOSE (that phone left, or the Mac drops it), PING (the Mac's keepalive, stream 0, an 8-byte timestamp: the
 * relay echoes it back unchanged, so a Mac that hears nothing for a while knows its socket is dead). The relay never
 * looks inside DATA. The relay implements the same layout on its side. */

export const RelayFrame = { OPEN: 1, DATA: 2, CLOSE: 3, PING: 4 } as const;
export type RelayFrameType = (typeof RelayFrame)[keyof typeof RelayFrame];
export const RELAY_HEADER = 5;

/** Write a frame's header into its first RELAY_HEADER bytes (a sealed message made with that much headroom). */
export function writeRelayHeader(buf: Uint8Array, type: RelayFrameType, streamId: number): Uint8Array {
  buf[0] = type;
  buf[1] = streamId >>> 24;
  buf[2] = (streamId >>> 16) & 255;
  buf[3] = (streamId >>> 8) & 255;
  buf[4] = streamId & 255;
  return buf;
}

export function encodeRelayFrame(type: RelayFrameType, streamId: number, payload: Uint8Array = EMPTY): Uint8Array {
  const out = new Uint8Array(RELAY_HEADER + payload.length);
  out.set(payload, RELAY_HEADER);
  return writeRelayHeader(out, type, streamId);
}

export function decodeRelayFrame(buf: Uint8Array): { type: RelayFrameType; streamId: number; payload: Uint8Array } | null {
  if (buf.length < RELAY_HEADER) return null;
  const type = buf[0] as RelayFrameType;
  if (type !== RelayFrame.OPEN && type !== RelayFrame.DATA && type !== RelayFrame.CLOSE && type !== RelayFrame.PING) return null;
  return { type, streamId: u32(buf, 1), payload: buf.subarray(RELAY_HEADER) };
}

/**
 * The header the Mac's bridge sets on every request and WebSocket it makes to its own gateway for a phone on AppuBot
 * Connect (value: the phone's address as the relay saw it). It only ever demotes a loopback peer from route `local` to
 * the stricter `connect`, so a local process that sets it gains nothing.
 */
export const CONNECT_PEER_HEADER = 'x-appubot-connect';

/**
 * The gateway's WebSocket for the channel without the relay (the same Wi-Fi): each socket is one phone stream, the
 * phone's hello first, then sealed messages, as on a relay stream.
 */
export const SECURE_PATH = '/secure';

/**
 * The header the Mac sets on every request and WebSocket it replays to its own gateway for a phone on SECURE_PATH
 * (value: the phone's address as that socket saw it). The gateway then judges that address (the local network,
 * Tailscale) as if the phone had come straight in, and knows it came through the channel. Like CONNECT_PEER_HEADER it is
 * taken from loopback peers only and only ever demotes them, so a local process that sets it gains nothing.
 */
export const SECURE_PEER_HEADER = 'x-appubot-secure';
