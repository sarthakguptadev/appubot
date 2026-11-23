/**
 * The relay pass (2026-11-23): what lets a computer use the hosted AppuBot Connect relay (connect.appubot.com). The
 * AppuBot account service (`POST /v1/connect/ticket`) signs one for a signed-in account's computer, naming
 * its room and when it runs out; the relay (which checks the same bytes without this package)
 * only needs the service's public key, so it never calls the service. The app's own sign-in check can be taken out of
 * a copy of the source; this can't.
 *
 * Text form: `v1.<payload>.<signature>`, both base64url; the payload is the JSON `{ r, a, e }` (room id, account id,
 * expiry in Unix seconds), the signature Ed25519 over CONNECT_TICKET_CONTEXT followed by the payload's bytes.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { fromBase64Url, ROOM_ID_RE, toBase64Url } from './connect';

export const CONNECT_TICKET_CONTEXT = 'appubot-connect-ticket-v1\n';
/** how long a pass lasts */
export const CONNECT_TICKET_TTL_MS = 7 * 24 * 3600_000;
/** a computer fetches a new pass once its own has less than this left */
export const CONNECT_TICKET_RENEW_MS = 24 * 3600_000;
/** the longest pass text either end accepts */
export const CONNECT_TICKET_MAX = 512;
/** the header a computer's push request carries its pass in */
export const CONNECT_TICKET_HEADER = 'x-connect-ticket';

export interface ConnectTicketClaims {
  /** the room (protocol `roomIdForPublicKey` of the computer's key) */
  room: string;
  /** the account it was given to */
  account: string;
  /** when it runs out, ms since the epoch */
  expiresAt: number;
}

const enc = new TextEncoder();
const CONTEXT = enc.encode(CONNECT_TICKET_CONTEXT);

function signed(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(CONTEXT.length + payload.length);
  out.set(CONTEXT, 0);
  out.set(payload, CONTEXT.length);
  return out;
}

/** The public key that checks passes signed with `secret` (what the relay is given). */
export function connectTicketPublicKey(secret: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(secret);
}

/** The account service signs a pass with its 32-byte Ed25519 secret. */
export function makeConnectTicket(secret: Uint8Array, c: ConnectTicketClaims): string {
  const payload = enc.encode(JSON.stringify({ r: c.room, a: c.account, e: Math.floor(c.expiresAt / 1000) }));
  return `v1.${toBase64Url(payload)}.${toBase64Url(ed25519.sign(signed(payload), secret))}`;
}

/** What a pass says, without checking its signature (a computer reads its own pass's expiry). Null when it isn't one. */
export function readConnectTicket(ticket: string): ConnectTicketClaims | null {
  if (ticket.length > CONNECT_TICKET_MAX) return null;
  const [v, p] = ticket.split('.');
  if (v !== 'v1' || !p) return null;
  const bytes = fromBase64Url(p);
  if (!bytes) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(bytes)) as { r?: unknown; a?: unknown; e?: unknown };
    if (typeof j.r !== 'string' || !ROOM_ID_RE.test(j.r) || typeof j.a !== 'string' || typeof j.e !== 'number') return null;
    return { room: j.r, account: j.a, expiresAt: j.e * 1000 };
  } catch {
    return null;
  }
}

/** Whether `ticket` is a pass signed by `publicKey` for `room` that hasn't run out at `now`. */
export function verifyConnectTicket(ticket: string, publicKey: Uint8Array, room: string, now: number): boolean {
  const claims = readConnectTicket(ticket);
  if (!claims || claims.room !== room || claims.expiresAt <= now) return false;
  const [, p, s] = ticket.split('.');
  const payload = fromBase64Url(p!);
  const sig = s ? fromBase64Url(s) : null;
  if (!payload || !sig || sig.length !== 64) return false;
  try {
    return ed25519.verify(sig, signed(payload), publicKey);
  } catch {
    return false;
  }
}
