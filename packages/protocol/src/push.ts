/**
 * Phone notifications: the computer asks the AppuBot Connect relay (`POST /push` on connect.appubot.com) to send them
 * through Firebase Cloud Messaging, so they reach a phone whose app is closed. The relay takes a request only from the
 * room's owner: the computer signs PUSH_CONTEXT, the relay's single-use nonce and SHA-256 of the body with the Ed25519
 * key its Connect room is named after (Connect on or off: only the identity is needed). `GET /push` hands out a nonce
 * (`{ nonce }`), and every answer to a push brings the next one, so a computer that keeps pushing signs each request
 * without an extra round trip; a nonce lives 5 minutes and opens one request. The relay has no dependencies, so it keeps its own copy of these names; its tests sign with them.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { CONNECT_RELAY_URL, fromBase64Url, toBase64Url } from './connect';
import type { PushKind } from './entities';

/** the first protocol with `devices.setPush` / `devices.presence`: a phone skips them on an older computer */
export const PUSH_SINCE_PROTOCOL = 2;
/** a phone in front says so this often… */
export const PRESENCE_EVERY_MS = 20_000;
/** …and a word older than this counts as gone (it was suspended without saying) */
export const PRESENCE_TTL_MS = 45_000;

/** What the computer signs for the relay: this context (UTF-8), the nonce's bytes, then SHA-256 of the body. */
export const PUSH_CONTEXT = 'appubot-push-v1\n';
/** the request's proof, base64url each: the Ed25519 public key, the relay's nonce, the signature */
export const PUSH_HEADER = { key: 'x-push-key', nonce: 'x-push-nonce', sig: 'x-push-sig' } as const;
/** what the relay takes in one request (bigger is refused, longer texts are cut) */
export const PUSH_LIMITS = { messages: 10, bodyBytes: 32 * 1024, title: 120, text: 400, token: 4096, id: 64 } as const;

/** What a tap needs: the notice, its kind, the phone's own id on that computer (names the pairing), the chat. */
export interface PushData { nid: string; kind: PushKind; deviceId: string; threadId?: string; botId?: string }

export interface PushMessage {
  token: string;
  platform: 'ios' | 'android';
  /** absent with previews off: the body alone says who and what */
  title?: string;
  body: string;
  /** one banner per chat: a newer one replaces it (APNs collapse id, Android tag) */
  collapse?: string;
  data: PushData;
}
export interface PushRequest { messages: PushMessage[] }

/**
 * Per message: `sent`; `drop` (the token is dead or not this app's: forget it); `retry` (Firebase was busy: try again,
 * after `retryAfter` seconds when given); `limited` (too many to that phone lately: dropped); `failed` (refused for
 * another reason, not worth repeating).
 */
export type PushStatus = 'sent' | 'drop' | 'retry' | 'limited' | 'failed';
export interface PushResult { status: PushStatus; retryAfter?: number }
/** 200: one result per message, in order, and the nonce for the next request */
export interface PushResponse { results: PushResult[]; nonce?: string }
/**
 * Anything else: `auth` (401: no nonce, a used or stale one, or a bad signature: `nonce` is a fresh one), `bad_request`
 * (400), `too_big` (413), `blocked` (403: this computer may not push), `rate_limited` (429), `push_disabled` (503: the
 * operator turned pushes off), `push_unavailable` (503: the relay has no Firebase account).
 */
export interface PushRefusal {
  error: 'auth' | 'bad_request' | 'too_big' | 'blocked' | 'rate_limited' | 'push_disabled' | 'push_unavailable';
  nonce?: string;
  retryAfter?: number;
}

const CONTEXT = new TextEncoder().encode(PUSH_CONTEXT);

/** The bytes signed for one request: PUSH_CONTEXT, the nonce, SHA-256 of the body. */
export function pushSignedBytes(nonce: Uint8Array, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(CONTEXT.length + nonce.length + 32);
  out.set(CONTEXT, 0);
  out.set(nonce, CONTEXT.length);
  out.set(sha256(body), CONTEXT.length + nonce.length);
  return out;
}

/** The three headers that prove a request comes from the room's owner. `nonce` as the relay sent it (base64url). */
export function signPush(edSecret: Uint8Array, edPublic: Uint8Array, nonce: string, body: Uint8Array): Record<string, string> {
  const raw = fromBase64Url(nonce);
  if (!raw || !raw.length) throw new Error('bad push nonce');
  return {
    [PUSH_HEADER.key]: toBase64Url(edPublic),
    [PUSH_HEADER.nonce]: nonce,
    [PUSH_HEADER.sig]: toBase64Url(ed25519.sign(pushSignedBytes(raw, body), edSecret)),
  };
}

/** The relay's push endpoint for a Connect relay URL (wss:// → https://, ws:// → http://). */
export function pushUrl(relayUrl: string = CONNECT_RELAY_URL): string {
  return `${relayUrl.replace(/\/$/, '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')}/push`;
}
