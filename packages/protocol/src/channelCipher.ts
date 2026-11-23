/**
 * The cipher of AppuBot Connect's channel (`connect.ts` `SecureChannel`): AES-256-GCM, done natively on both ends.
 *
 * Pluggable, since every runtime reaches its native AES differently and shared code can import none of them:
 *  - Node (the Mac's Electron main, and Node tests): node:crypto, looked up at run time (`process.getBuiltinModule`), so
 *    the phone's bundler never sees it. Synchronous.
 *  - The phone: expo-crypto's (CryptoKit on iOS), which the phone app registers at startup (`setChannelCipher`, in its
 *    `gateway.ts`), so this package and the client stay free of Expo. Asynchronous.
 *  - Anywhere with neither: @noble's, in plain JavaScript. Synchronous and slow (the pure-JS cipher ran at under 1 MB/s
 *    in the phone's Hermes, which is why the channel moved to native AES).
 *
 * The channel sends no nonce: each direction has its own key, and a message's nonce is its number in that direction
 * (`channelNonce`), so a nonce never repeats under one key.
 */
import { gcm } from '@noble/ciphers/aes';

/** The GCM tag's length: all 16 bytes go with every sealed message. */
export const CHANNEL_TAG = 16;
/** A nonce's length: the 96 bits GCM is made for. */
export const CHANNEL_NONCE = 12;

/** What a cipher answers: at once when it is synchronous (`Sync` true), else maybe a promise. */
export type CipherResult<T, Sync extends boolean> = Sync extends true ? T : T | Promise<T>;

/**
 * AES-256-GCM for one runtime. `K` is a direction's key as the cipher keeps it (the raw bytes, or a native key object).
 * A synchronous cipher (`Sync` true) answers every call at once; an asynchronous one may answer with promises, which
 * can settle in any order: the channel numbers a message when `seal` or `open` is called, so its user hands sealed and
 * opened messages on in the order it called (the client's `RelaySession` does).
 */
export interface ChannelCipher<K = any, Sync extends boolean = boolean> {
  /** for benchmarks and logs */
  readonly name: string;
  /**
   * One direction's 32-byte key, made ready once per channel (expo-crypto imports it into a native key). `raw` is the
   * cipher's from here: wiped as soon as a native copy holds it, else when the key is dropped.
   */
  importKey(raw: Uint8Array): CipherResult<K, Sync>;
  /**
   * The plaintext (its pieces, in order: the channel's 5-byte head, then the payload, which isn't copied just to go behind
   * the head) sealed under `key` and the 12-byte `nonce`: the ciphertext, then the 16-byte tag, after `headroom` free bytes
   * for the caller's framing.
   */
  seal(key: K, nonce: Uint8Array, plain: readonly Uint8Array[], headroom: number): CipherResult<Uint8Array, Sync>;
  /** `sealed` (ciphertext, then tag) opened under `key` and `nonce`: the plaintext, or null when it doesn't open. */
  open(key: K, nonce: Uint8Array, sealed: Uint8Array): CipherResult<Uint8Array | null, Sync>;
  /** The channel is over: let go of `key` (wiped where it can be; a native key object is only dropped). */
  drop(key: K): void;
}

export type SyncChannelCipher<K = any> = ChannelCipher<K, true>;

/** The pieces as one array (the payload alone when there is no head to put in front). */
function joined(pieces: readonly Uint8Array[]): Uint8Array {
  if (pieces.length === 1) return pieces[0]!;
  let n = 0;
  for (const p of pieces) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of pieces) { out.set(p, at); at += p.length; }
  return out;
}

/** `sealed` after `headroom` free bytes (a copy only when there is headroom to make). */
function withHeadroom(sealed: Uint8Array, headroom: number): Uint8Array {
  if (!headroom) return sealed;
  const out = new Uint8Array(headroom + sealed.length);
  out.set(sealed, headroom);
  return out;
}

/* ---------- node:crypto (the Mac, Node tests) ---------- */

interface NodeGcm { update(data: Uint8Array): Uint8Array; final(): Uint8Array }
interface NodeCrypto {
  createCipheriv(algorithm: 'aes-256-gcm', key: Uint8Array, iv: Uint8Array, options: { authTagLength: number }): NodeGcm & { getAuthTag(): Uint8Array };
  createDecipheriv(algorithm: 'aes-256-gcm', key: Uint8Array, iv: Uint8Array, options: { authTagLength: number }): NodeGcm & { setAuthTag(tag: Uint8Array): unknown };
}

/** node:crypto where this runtime has it (looked up, never imported: the phone's bundler must not see it), else null. */
function findNodeCrypto(): NodeCrypto | null {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  try {
    const c = proc?.getBuiltinModule?.('node:crypto') as NodeCrypto | undefined;
    return typeof c?.createCipheriv === 'function' ? c : null;
  } catch {
    return null;
  }
}

/** A Node Buffer as a plain Uint8Array over the same bytes (no copy), as the other ciphers answer. */
function plainBytes(b: Uint8Array): Uint8Array {
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

function nodeAesGcm(c: NodeCrypto): SyncChannelCipher<Uint8Array> {
  return {
    name: 'node:crypto AES-256-GCM',
    importKey: (raw) => raw,
    seal(key, nonce, plain, headroom) {
      const cipher = c.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: CHANNEL_TAG });
      let n = 0;
      for (const p of plain) n += p.length;
      const out = new Uint8Array(headroom + n + CHANNEL_TAG);
      let at = headroom;
      // each piece encrypted as it lies and put in place: the payload is read once and written once
      for (const p of plain) { const part = cipher.update(p); out.set(part, at); at += part.length; }
      const rest = cipher.final(); // nothing for GCM, a stream mode
      out.set(rest, at);
      out.set(cipher.getAuthTag(), at + rest.length);
      return out;
    },
    open(key, nonce, sealed) {
      if (sealed.length < CHANNEL_TAG) return null;
      const end = sealed.length - CHANNEL_TAG;
      try {
        const decipher = c.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: CHANNEL_TAG });
        decipher.setAuthTag(sealed.subarray(end));
        const plain = decipher.update(sealed.subarray(0, end));
        decipher.final(); // throws unless the tag matches: nothing of `plain` is handed out before
        return plainBytes(plain);
      } catch {
        return null;
      }
    },
    drop: (key) => key.fill(0),
  };
}

let nodeCipher: SyncChannelCipher<Uint8Array> | null | undefined;

/** node:crypto's AES-256-GCM, or null where this runtime has no node:crypto (the phone). */
export function nodeChannelCipher(): SyncChannelCipher<Uint8Array> | null {
  if (nodeCipher === undefined) {
    const c = findNodeCrypto();
    nodeCipher = c ? nodeAesGcm(c) : null;
  }
  return nodeCipher;
}

/* ---------- @noble (pure JavaScript: only where there's nothing native) ---------- */

export const jsChannelCipher: SyncChannelCipher<Uint8Array> = {
  name: '@noble AES-256-GCM (JavaScript)',
  importKey: (raw) => raw,
  seal: (key, nonce, plain, headroom) => withHeadroom(gcm(key, nonce).encrypt(joined(plain)), headroom),
  open(key, nonce, sealed) {
    try {
      return gcm(key, nonce).decrypt(sealed);
    } catch {
      return null;
    }
  },
  drop: (key) => key.fill(0),
};

/* ---------- WebCrypto (the desktop renderer talking to an AppuBot Cloud computer, any browser engine) ---------- */

/** The part of WebCrypto's SubtleCrypto the cipher uses (typed here so this file needs no DOM lib). */
export interface SubtleLike {
  importKey(format: 'raw', key: Uint8Array, algorithm: { name: 'AES-GCM' }, extractable: boolean, usages: ['encrypt', 'decrypt']): Promise<unknown>;
  encrypt(algorithm: { name: 'AES-GCM'; iv: Uint8Array; tagLength: number }, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(algorithm: { name: 'AES-GCM'; iv: Uint8Array; tagLength: number }, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}

/** `crypto.subtle` where this runtime has it (browsers, Electron's renderer, Node 20+), else null. */
export function findSubtle(): SubtleLike | null {
  const c = (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto;
  return c?.subtle && typeof c.subtle.encrypt === 'function' ? c.subtle : null;
}

/**
 * AES-256-GCM through WebCrypto: asynchronous (every call answers a promise), native speed, the key held as a
 * non-extractable CryptoKey (nothing of ours to wipe: `drop` only lets go of it). The renderer registers it with
 * `setChannelCipher` before opening a channel to an AppuBot Cloud computer; the Mac's main process keeps node:crypto's.
 */
export function webCryptoChannelCipher(subtle: SubtleLike | null = findSubtle()): ChannelCipher<unknown, false> | null {
  if (!subtle) return null;
  const s = subtle;
  return {
    name: 'WebCrypto AES-256-GCM',
    async importKey(raw) {
      // a copy goes in: WebCrypto may keep a reference, and the caller wipes `raw` once the key is made
      const key = await s.importKey('raw', raw.slice(), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      raw.fill(0);
      return key;
    },
    async seal(key, nonce, plain, headroom) {
      const sealed = new Uint8Array(await s.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: CHANNEL_TAG * 8 }, key, joined(plain)));
      return withHeadroom(sealed, headroom);
    },
    async open(key, nonce, sealed) {
      if (sealed.length < CHANNEL_TAG) return null;
      try {
        return new Uint8Array(await s.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: CHANNEL_TAG * 8 }, key, sealed));
      } catch {
        return null;
      }
    },
    drop: () => undefined,
  };
}

/* ---------- which one ---------- */

let registered: ChannelCipher | null = null;

/** AES-256-GCM that answers at once: node:crypto's where there is one, else @noble's. What the Mac's side uses. */
export function localChannelCipher(): SyncChannelCipher<Uint8Array> {
  return nodeChannelCipher() ?? jsChannelCipher;
}

/**
 * What a client's sessions use (the client's `RelaySession`): the cipher this app registered (the phone's expo-crypto,
 * the renderer's WebCrypto), else node:crypto's where there is one, else WebCrypto's where there is one (a browser
 * engine), else @noble's.
 */
export function channelCipher(): ChannelCipher {
  return registered ?? nodeChannelCipher() ?? webCryptoChannelCipher() ?? jsChannelCipher;
}

/** Register this runtime's native cipher (the phone: expo-crypto's, at startup); null goes back to the local one. */
export function setChannelCipher(cipher: ChannelCipher | null): void {
  registered = cipher;
}
