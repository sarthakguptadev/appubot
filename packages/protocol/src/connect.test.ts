import { createDecipheriv } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { jsChannelCipher, localChannelCipher, nodeChannelCipher, type ChannelCipher } from './channelCipher';
import {
  CHANNEL_CHUNK,
  CHANNEL_FRAME_MAX,
  CHANNEL_VERSION,
  HOST_CHALLENGE_CONTEXT,
  Msg,
  RELAY_HEADER,
  ROOM_ID_RE,
  SecureChannel,
  ackPayload,
  acceptHello,
  challengeMessage,
  channelNonce,
  chunks,
  createEphemeralKeypair,
  createIdentity,
  helloFrame,
  identityFromSecrets,
  jsonBytes,
  parseAck,
  parseHello,
  parseJsonBytes,
  phoneHandshake,
  roomIdForPublicKey,
  signChallenge,
  versionReply,
} from './connect';

/** A phone and its Mac through the whole handshake. */
function pair() {
  const mac = createIdentity();
  const hs = phoneHandshake(mac.xPublic);
  const accepted = acceptHello(mac, hs.hello)!;
  const phoneCh = hs.finish(accepted.reply)!;
  return { mac, hello: hs.hello, reply: accepted.reply, macCh: accepted.channel, phoneCh };
}

describe('handshake', () => {
  it('hello carries the phone key and the version', () => {
    const k = createEphemeralKeypair().public;
    expect(parseHello(helloFrame(k))).toEqual(k);
    expect(parseHello(new Uint8Array(32))).toBeNull();
    const wrongVersion = helloFrame(k);
    wrongVersion[0] = 9;
    expect(parseHello(wrongVersion)).toBeNull();
    // earlier versions' hellos (same layout: 1, and 2, ChaCha20-Poly1305) are refused, not misread
    for (const v of [1, 2]) {
      wrongVersion[0] = v;
      expect(parseHello(wrongVersion)).toBeNull();
      expect(acceptHello(createIdentity(), wrongVersion)).toBeNull();
    }
    expect([...versionReply()]).toEqual([CHANNEL_VERSION]);
  });

  it('the phone opens the Mac’s READY and both sides talk', () => {
    const { macCh, phoneCh, reply } = pair();
    expect(phoneCh).toBeInstanceOf(SecureChannel);
    expect(reply[0]).toBe(CHANNEL_VERSION);
    expect(reply.length).toBe(1 + 32 + 5 + 16);
    const req = macCh.open(phoneCh.seal(Msg.HTTP_REQ, 7, jsonBytes({ method: 'GET', path: '/files/x', headers: {} })));
    expect(req?.kind).toBe(Msg.HTTP_REQ);
    expect(req?.id).toBe(7);
    expect(parseJsonBytes(req!.payload)).toEqual({ method: 'GET', path: '/files/x', headers: {} });
    const res = phoneCh.open(macCh.seal(Msg.HTTP_RES_BODY, 0xfffffffe, new Uint8Array([1, 2, 3])));
    expect(res).toMatchObject({ kind: Msg.HTTP_RES_BODY, id: 0xfffffffe });
    expect([...res!.payload]).toEqual([1, 2, 3]);
  });

  it('every stream has its own keys, even for the same hello', () => {
    const mac = createIdentity();
    const hs = phoneHandshake(mac.xPublic);
    const a = acceptHello(mac, hs.hello)!;
    const b = acceptHello(mac, hs.hello)!;
    // a fresh Mac ephemeral each time
    expect(Buffer.from(a.reply.subarray(1, 33))).not.toEqual(Buffer.from(b.reply.subarray(1, 33)));
    expect(Buffer.from(a.channel.seal(Msg.WS_TEXT, 1))).not.toEqual(Buffer.from(b.channel.seal(Msg.WS_TEXT, 1)));
  });

  it('a recorded stream replayed on a new stream opens nothing', () => {
    const mac = createIdentity();
    // the stream as the relay saw it: the phone's hello and its sealed messages
    const hs = phoneHandshake(mac.xPublic);
    const first = acceptHello(mac, hs.hello)!;
    const phone = hs.finish(first.reply)!;
    const recorded = [
      phone.seal(Msg.HTTP_REQ, 1, jsonBytes({ method: 'POST', path: '/api/pair', headers: {} })),
      phone.seal(Msg.HTTP_REQ_BODY, 1, jsonBytes({ code: '123456' })),
      phone.seal(Msg.HTTP_REQ_END, 1),
    ];
    expect(recorded.map((m) => first.channel.open(m)?.kind)).toEqual([Msg.HTTP_REQ, Msg.HTTP_REQ_BODY, Msg.HTTP_REQ_END]);
    // replayed later: the hello is accepted again (it is only a public key), but the Mac's new ephemeral key gives new
    // session keys, so not one recorded message opens
    const replay = acceptHello(mac, hs.hello)!;
    for (const m of recorded) expect(replay.channel.open(m)).toBeNull();
    // and the recorded messages alone, without their hello, open nowhere either
    const other = acceptHello(mac, phoneHandshake(mac.xPublic).hello)!;
    expect(other.channel.open(recorded[0]!)).toBeNull();
  });

  it('a stranger without the Mac’s static secret cannot make a READY the phone accepts', () => {
    const mac = createIdentity();
    const hs = phoneHandshake(mac.xPublic);
    const impostor = acceptHello(createIdentity(), hs.hello)!; // the relay pretending to be the Mac
    expect(hs.finish(impostor.reply)).toBeNull();
  });

  it('a relay swapping in its own ephemeral key breaks the READY', () => {
    const mac = createIdentity();
    const hs = phoneHandshake(mac.xPublic);
    const { reply } = acceptHello(mac, hs.hello)!;
    const forged = reply.slice();
    forged.set(createEphemeralKeypair().public, 1);
    expect(hs.finish(forged)).toBeNull();
  });

  it('a reply in another version, cut short, or offered twice is refused', () => {
    const mac = createIdentity();
    const hs = phoneHandshake(mac.xPublic);
    const { reply } = acceptHello(mac, hs.hello)!;
    const other = reply.slice();
    other[0] = CHANNEL_VERSION + 1;
    expect(hs.finish(other)).toBeNull();
    expect(hs.finish(versionReply())).toBeNull();
    expect(hs.finish(reply.subarray(0, reply.length - 1))).toBeNull();
    expect(hs.finish(reply)).not.toBeNull();
    expect(hs.finish(reply)).toBeNull();
  });

  it('a handshake given up on opens nothing afterwards (its ephemeral secret is gone)', () => {
    const mac = createIdentity();
    const hs = phoneHandshake(mac.xPublic);
    const { reply } = acceptHello(mac, hs.hello)!;
    hs.abandon();
    expect(hs.finish(reply)).toBeNull();
  });

  it('a hello with a small-order key is refused without throwing', () => {
    const mac = createIdentity();
    const zero = helloFrame(new Uint8Array(32));
    const one = helloFrame(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0)));
    expect(() => acceptHello(mac, zero)).not.toThrow();
    expect(acceptHello(mac, zero)).toBeNull();
    expect(acceptHello(mac, one)).toBeNull();
  });

  it('when the second DH fails, the first one’s result is wiped (both ends)', () => {
    const real = x25519.getSharedSecret.bind(x25519);
    const made: Uint8Array[] = [];
    const spy = vi.spyOn(x25519, 'getSharedSecret');
    try {
      // the Mac: the static DH comes out, the ephemeral one throws
      spy.mockImplementationOnce((a, b) => { const r = real(a, b); made.push(r); return r; })
        .mockImplementationOnce(() => { throw new Error('invalid private or public key received'); });
      const mac = createIdentity();
      expect(acceptHello(mac, phoneHandshake(mac.xPublic).hello)).toBeNull();
      expect(made).toHaveLength(1);
      expect(made[0]!.some((b) => b !== 0)).toBe(false);

      // the phone: a reply whose ephemeral key is small-order (a relay swapping it in): the pinned key's DH goes too
      made.length = 0;
      spy.mockImplementation((a, b) => { const r = real(a, b); made.push(r); return r; });
      const hs = phoneHandshake(mac.xPublic);
      const { reply } = acceptHello(mac, hs.hello)!;
      made.length = 0;
      const forged = reply.slice();
      forged.fill(0, 1, 33);
      expect(hs.finish(forged)).toBeNull();
      expect(made).toHaveLength(1);
      expect(made[0]!.some((b) => b !== 0)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('headroom leaves room for the caller’s framing', () => {
    const mac = createIdentity();
    const hs = phoneHandshake(mac.xPublic);
    const { reply } = acceptHello(mac, hs.hello, RELAY_HEADER)!;
    expect([...reply.subarray(0, RELAY_HEADER)]).toEqual([0, 0, 0, 0, 0]);
    expect(hs.finish(reply.subarray(RELAY_HEADER))).not.toBeNull();
  });
});

describe('channel', () => {
  it('refuses a replayed message', () => {
    const { macCh, phoneCh } = pair();
    const m = phoneCh.seal(Msg.WS_TEXT, 1, new Uint8Array([1]));
    expect(macCh.open(m)).not.toBeNull();
    expect(macCh.open(m)).toBeNull();
  });

  it('refuses messages out of order', () => {
    const { macCh, phoneCh } = pair();
    const a = phoneCh.seal(Msg.WS_TEXT, 1, new Uint8Array([1]));
    const b = phoneCh.seal(Msg.WS_TEXT, 1, new Uint8Array([2]));
    expect(macCh.open(b)).toBeNull();
    expect(macCh.open(a)).toBeNull(); // and nothing opens after a failure
  });

  it('notices a dropped message: the next one does not open', () => {
    const { macCh, phoneCh } = pair();
    expect(macCh.open(phoneCh.seal(Msg.WS_TEXT, 1, new Uint8Array([1])))).not.toBeNull();
    phoneCh.seal(Msg.WS_TEXT, 1, new Uint8Array([2])); // lost on the way
    expect(macCh.open(phoneCh.seal(Msg.WS_TEXT, 1, new Uint8Array([3])))).toBeNull();
  });

  it('after a tampered message it opens nothing, not even the good ones', () => {
    const { macCh, phoneCh } = pair();
    const good = phoneCh.seal(Msg.WS_TEXT, 1, new Uint8Array([1, 2, 3]));
    const bad = good.slice();
    bad[bad.length - 1]! ^= 1;
    expect(macCh.open(bad)).toBeNull();
    expect(macCh.open(good)).toBeNull();
  });

  it('a message bounced back to its sender does not open', () => {
    const { macCh, phoneCh } = pair();
    const fromMac = macCh.seal(Msg.WS_TEXT, 3);
    expect(macCh.open(fromMac)).toBeNull();
    expect(phoneCh.open(fromMac)).not.toBeNull();
  });

  it('a full chunk fits one frame; more is refused on both ends', () => {
    const { macCh, phoneCh } = pair();
    const full = phoneCh.seal(Msg.HTTP_REQ_BODY, 1, new Uint8Array(CHANNEL_CHUNK).fill(7), RELAY_HEADER);
    expect(full.length).toBeLessThanOrEqual(CHANNEL_FRAME_MAX);
    expect(macCh.open(full.subarray(RELAY_HEADER))?.payload.length).toBe(CHANNEL_CHUNK);
    expect(() => phoneCh.seal(Msg.HTTP_REQ_BODY, 1, new Uint8Array(CHANNEL_CHUNK + 1))).toThrow(RangeError);
    expect(macCh.open(new Uint8Array(CHANNEL_FRAME_MAX + 1))).toBeNull();
    expect(macCh.open(new Uint8Array(3))).toBeNull(); // too short
  });

  it('closing wipes both keys, and a closed channel neither seals nor opens', () => {
    const { macCh, phoneCh } = pair();
    const pending = phoneCh.seal(Msg.WS_TEXT, 1, new Uint8Array([1]));
    const keys = (macCh as unknown as { keys: { send: Uint8Array; recv: Uint8Array } }).keys;
    macCh.close();
    expect(keys.send.every((b) => b === 0) && keys.recv.every((b) => b === 0)).toBe(true);
    expect((macCh as unknown as { keys: unknown }).keys).toBeNull();
    expect(macCh.isClosed).toBe(true);
    // never sealed under an all-zero key
    expect(() => macCh.seal(Msg.WS_TEXT, 1)).toThrow(/closed/);
    expect(macCh.open(pending)).toBeNull();
    macCh.close(); // twice is fine
  });

  it('two seals of the same message differ (each has its own number)', () => {
    const { phoneCh } = pair();
    expect(Buffer.from(phoneCh.seal(Msg.WS_TEXT, 1, new Uint8Array([1])))).not.toEqual(Buffer.from(phoneCh.seal(Msg.WS_TEXT, 1, new Uint8Array([1]))));
  });

  it('acks carry byte counts past 4 GB', () => {
    for (const n of [0, 1, CHANNEL_CHUNK, 2 ** 32 + 5, 2 ** 40 + 3]) expect(parseAck(ackPayload(n))).toBe(n);
    expect(parseAck(new Uint8Array(4))).toBeNull();
  });

  it('identity survives being saved and restored', () => {
    const id = createIdentity();
    const back = identityFromSecrets(id.edSecret, id.xSecret);
    expect(roomIdForPublicKey(back.edPublic)).toBe(roomIdForPublicKey(id.edPublic));
    expect(Buffer.from(back.xPublic)).toEqual(Buffer.from(id.xPublic));
  });

  it('bodies split into chunks of CHANNEL_CHUNK', () => {
    const body = new Uint8Array(CHANNEL_CHUNK * 2 + 10);
    const parts = chunks(body);
    expect(parts.map((p) => p.length)).toEqual([CHANNEL_CHUNK, CHANNEL_CHUNK, 10]);
    expect(chunks(new Uint8Array(0))).toEqual([]);
  });
});

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('cipher', () => {
  it('is AES-256-GCM: the spec’s own test vectors, the same from node:crypto and @noble', () => {
    expect(localChannelCipher()).toBe(nodeChannelCipher());
    for (const c of [nodeChannelCipher()!, jsChannelCipher]) {
      // McGrew & Viega's GCM test cases 13 and 14: a zero key and nonce
      expect(hex(c.seal(new Uint8Array(32), new Uint8Array(12), [new Uint8Array(0)], 0))).toBe('530f8afbc74536b9a963b4f1c4cb738b');
      expect(hex(c.seal(new Uint8Array(32), new Uint8Array(12), [new Uint8Array(16)], 0))).toBe('cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919');
    }
  });

  it('a message’s nonce is its number, 8 bytes big-endian, then 4 zero bytes', () => {
    expect([...channelNonce(1)]).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
    expect([...channelNonce(2 ** 32 + 258)]).toEqual([0, 0, 0, 1, 0, 0, 1, 2, 0, 0, 0, 0]);
    expect(channelNonce(1)).not.toBe(channelNonce(1)); // fresh each time: an asynchronous cipher may read it later
  });

  it('a sealed message is plain AES-256-GCM of [kind][id][payload] under its number, nothing else on the wire', () => {
    const { macCh, reply } = pair();
    const send = (macCh as unknown as { keys: { send: Uint8Array } }).keys.send.slice();
    // what any AES-GCM (CryptoKit, Android's, WebCrypto) opens with the key and the nonce alone
    const plainOf = (body: Uint8Array, n: number) => {
      const d = createDecipheriv('aes-256-gcm', send, channelNonce(n));
      d.setAuthTag(body.subarray(body.length - 16));
      return [...Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()])];
    };
    // the READY in the reply is the Mac's message 1
    expect(plainOf(reply.subarray(33), 1)).toEqual([Msg.READY, 0, 0, 0, 0]);
    const sealed = macCh.seal(Msg.HTTP_RES_BODY, 0x01020304, new Uint8Array([9, 8, 7]), RELAY_HEADER);
    expect(plainOf(sealed.subarray(RELAY_HEADER), 2)).toEqual([Msg.HTTP_RES_BODY, 1, 2, 3, 4, 9, 8, 7]);
  });

  it('node:crypto and @noble open each other’s messages, with headroom or without', () => {
    const node = nodeChannelCipher()!;
    const key = new Uint8Array(32).map((_, i) => i * 7);
    const nonce = channelNonce(5);
    const plain = [Uint8Array.of(3, 0, 0, 0, 1), new Uint8Array(70_000).map((_, i) => i & 0xff)];
    for (const [a, b] of [[node, jsChannelCipher], [jsChannelCipher, node]] as const) {
      const sealed = a.seal(key, nonce, plain, RELAY_HEADER);
      expect([...sealed.subarray(0, RELAY_HEADER)]).toEqual([0, 0, 0, 0, 0]);
      const opened = b.open(key, nonce, sealed.subarray(RELAY_HEADER))!;
      expect(opened.length).toBe(5 + 70_000);
      expect([...opened.subarray(0, 5)]).toEqual([3, 0, 0, 0, 1]);
      expect(opened[5 + 69_999]).toBe(69_999 & 0xff);
      expect(hex(b.seal(key, nonce, plain, 0))).toBe(hex(sealed.subarray(RELAY_HEADER)));
      // a flipped bit, a wrong nonce or a wrong key opens nothing
      const bad = sealed.slice(RELAY_HEADER);
      bad[100]! ^= 1;
      expect(b.open(key, nonce, bad)).toBeNull();
      expect(b.open(key, channelNonce(6), sealed.subarray(RELAY_HEADER))).toBeNull();
      expect(b.open(new Uint8Array(32), nonce, sealed.subarray(RELAY_HEADER))).toBeNull();
      expect(b.open(key, nonce, new Uint8Array(3))).toBeNull();
    }
  });

  it('a Mac on node:crypto and a phone on @noble (or the other way round) talk', () => {
    const mac = createIdentity();
    for (const [macCipher, phoneCipher] of [[jsChannelCipher, nodeChannelCipher()!], [nodeChannelCipher()!, jsChannelCipher]] as const) {
      const hs = phoneHandshake(mac.xPublic, phoneCipher);
      const accepted = acceptHello(mac, hs.hello, 0, macCipher)!;
      const phone = hs.finish(accepted.reply)!;
      expect(accepted.channel.open(phone.seal(Msg.WS_TEXT, 4, textOf('hi')))).toMatchObject({ kind: Msg.WS_TEXT, id: 4 });
      expect([...phone.open(accepted.channel.seal(Msg.WS_TEXT, 4, textOf('yo')))!.payload]).toEqual([...textOf('yo')]);
    }
  });
});

const textOf = (s: string) => new TextEncoder().encode(s);

/**
 * The local cipher made asynchronous, as the phone's native one is: each answer worked out at the call (a native cipher
 * copies its input then) and handed back after the next of `delays` (ms; 0 when none are left), so later calls can
 * finish first.
 */
function asyncCipher(delays: number[] = []): ChannelCipher<Uint8Array, false> & { delays: number[] } {
  const base = localChannelCipher();
  const later = <T>(v: T) => new Promise<T>((resolve) => setTimeout(() => resolve(v), c.delays.shift() ?? 0));
  const c = {
    delays,
    name: 'async (test)',
    importKey: (raw: Uint8Array) => later(base.importKey(raw)),
    seal: (key: Uint8Array, nonce: Uint8Array, plain: readonly Uint8Array[], headroom: number) => later(base.seal(key, nonce, plain, headroom)),
    open: (key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array) => later(base.open(key, nonce, sealed)),
    drop: (key: Uint8Array) => base.drop(key),
  };
  return c;
}

describe('channel on an asynchronous cipher (the phone’s native one)', () => {
  async function asyncPair(delays: number[] = []) {
    const mac = createIdentity();
    const cipher = asyncCipher(delays);
    const hs = phoneHandshake(mac.xPublic, cipher);
    const accepted = acceptHello(mac, hs.hello)!;
    const finishing = hs.finish(accepted.reply);
    expect(finishing).toBeInstanceOf(Promise);
    const phoneCh = (await finishing)!;
    expect(phoneCh).toBeInstanceOf(SecureChannel);
    return { cipher, macCh: accepted.channel, phoneCh };
  }

  it('numbers go by the order of the calls, whatever order the answers come back in', async () => {
    const { cipher, macCh, phoneCh } = await asyncPair();
    // the phone's seals: the first answers last
    cipher.delays.push(30, 15, 0);
    const sealed = [1, 2, 3].map((n) => phoneCh.seal(Msg.WS_TEXT, 1, Uint8Array.of(n)));
    const sealOrder: number[] = [];
    sealed.forEach((p, i) => void (p as Promise<Uint8Array>).then(() => sealOrder.push(i)));
    const out = await Promise.all(sealed);
    expect(sealOrder).toEqual([2, 1, 0]);
    expect(out.map((m) => macCh.open(m)?.payload[0])).toEqual([1, 2, 3]);
    // the Mac's, opened by the phone: again the later ones answer first
    cipher.delays.push(30, 15, 0);
    const opened = [4, 5, 6].map((n) => phoneCh.open(macCh.seal(Msg.WS_TEXT, 1, Uint8Array.of(n))));
    const openOrder: number[] = [];
    opened.forEach((p, i) => void (p as Promise<unknown>).then(() => openOrder.push(i)));
    expect((await Promise.all(opened)).map((m) => m?.payload[0])).toEqual([4, 5, 6]);
    expect(openOrder).toEqual([2, 1, 0]);
  });

  it('a message that fails stops the ones after it, never the ones before, whichever finishes first', async () => {
    const { cipher, macCh, phoneCh } = await asyncPair();
    const sealed = [1, 2, 3, 4].map((n) => macCh.seal(Msg.WS_TEXT, 1, Uint8Array.of(n)));
    sealed[2]![sealed[2]!.length - 1]! ^= 1; // the third tampered with
    // the tampered one answers first, then the fourth, then the second, the first last
    cipher.delays.push(30, 20, 0, 10);
    const got = await Promise.all(sealed.map((m) => phoneCh.open(m)));
    expect(got.map((m) => m?.payload[0] ?? null)).toEqual([1, 2, null, null]);
    expect(await phoneCh.open(macCh.seal(Msg.WS_TEXT, 1))).toBeNull();
  });

  it('closed while answers are on the way: nothing more is handed out, and the keys are let go of', async () => {
    const { cipher, macCh, phoneCh } = await asyncPair();
    cipher.delays.push(20);
    const pending = phoneCh.open(macCh.seal(Msg.WS_TEXT, 1, Uint8Array.of(1)));
    const keys = (phoneCh as unknown as { keys: { send: Uint8Array; recv: Uint8Array } }).keys;
    phoneCh.close();
    expect(await pending).toBeNull();
    expect(keys.send.every((b) => b === 0) && keys.recv.every((b) => b === 0)).toBe(true);
    expect(() => phoneCh.seal(Msg.WS_TEXT, 1)).toThrow(/closed/);
  });

  it('an impostor’s READY, or a cipher that won’t take the keys, finishes as null', async () => {
    const mac = createIdentity();
    const hs = phoneHandshake(mac.xPublic, asyncCipher());
    expect(await hs.finish(acceptHello(createIdentity(), hs.hello)!.reply)).toBeNull();
    const refusing: ChannelCipher<Uint8Array, false> = { ...asyncCipher(), importKey: async () => { throw new Error('no key'); } };
    const hs2 = phoneHandshake(mac.xPublic, refusing);
    expect(await hs2.finish(acceptHello(mac, hs2.hello)!.reply)).toBeNull();
  });
});

describe('room id', () => {
  it('is 26 base32 chars and stable for a key', () => {
    const id = createIdentity();
    const a = roomIdForPublicKey(id.edPublic);
    expect(a).toMatch(ROOM_ID_RE);
    expect(roomIdForPublicKey(id.edPublic)).toBe(a);
  });
  it('differs between computers', () => {
    expect(roomIdForPublicKey(createIdentity().edPublic)).not.toBe(roomIdForPublicKey(createIdentity().edPublic));
  });
});

describe('room ownership signature', () => {
  it('signs the context and the nonce, never the bare nonce', () => {
    const id = createIdentity();
    const nonce = new Uint8Array(32).fill(7);
    const sig = signChallenge(id.edSecret, nonce);
    const message = challengeMessage(nonce);
    expect(Buffer.from(message.subarray(0, HOST_CHALLENGE_CONTEXT.length)).toString('utf8')).toBe('appubot-connect-host-v1\n');
    expect([...message.subarray(HOST_CHALLENGE_CONTEXT.length)]).toEqual([...nonce]);
    expect(ed25519.verify(sig, message, id.edPublic)).toBe(true);
    expect(ed25519.verify(sig, nonce, id.edPublic)).toBe(false);
  });
  it('fails for a different key', () => {
    const id = createIdentity();
    const other = createIdentity();
    const nonce = new Uint8Array(32).fill(7);
    expect(ed25519.verify(signChallenge(id.edSecret, nonce), challengeMessage(nonce), other.edPublic)).toBe(false);
  });
});

import { buildPairUrl, parsePairUrl } from './wire';
import { fromBase64Url, toBase64Url } from './connect';

describe('QR and base64url', () => {
  it('base64url round-trips every length', () => {
    for (let n = 0; n < 40; n++) {
      const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 0xff);
      expect(fromBase64Url(toBase64Url(b))).toEqual(b);
      expect(toBase64Url(b)).toBe(Buffer.from(b).toString('base64url'));
    }
    expect(fromBase64Url('a*b')).toBeNull();
  });
  it('the pairing QR carries the room and key, and old QRs still parse', () => {
    const id = createIdentity();
    const room = roomIdForPublicKey(id.edPublic);
    const key = toBase64Url(id.xPublic);
    const url = buildPairUrl({ hosts: ['100.1.2.3'], port: 7890, code: '123456', hostName: 'Mac', connectId: room, connectKey: key });
    expect(parsePairUrl(url)).toEqual({ hosts: ['100.1.2.3'], port: 7890, code: '123456', hostName: 'Mac', connectId: room, connectKey: key });
    // Connect only (no direct address) is still a valid QR
    expect(parsePairUrl(buildPairUrl({ hosts: [], port: 7890, code: '123456', hostName: 'Mac', connectId: room, connectKey: key }))?.connectId).toBe(room);
    // a bad key is dropped, and then a QR with no hosts is refused
    expect(parsePairUrl(buildPairUrl({ hosts: [], port: 7890, code: '123456', hostName: 'Mac', connectId: room, connectKey: 'short' }))).toBeNull();
    expect(parsePairUrl(buildPairUrl({ hosts: ['1.2.3.4'], port: 7890, code: '123456', hostName: 'Mac' }))).toEqual({ hosts: ['1.2.3.4'], port: 7890, code: '123456', hostName: 'Mac' });
  });
  it('the key goes without the room (Connect off: the same Wi-Fi still pins it), never the room without the key', () => {
    const id = createIdentity();
    const room = roomIdForPublicKey(id.edPublic);
    const key = toBase64Url(id.xPublic);
    const keyOnly = buildPairUrl({ hosts: ['192.168.1.5'], port: 7890, code: '123456', hostName: 'Mac', connectKey: key });
    expect(keyOnly).toContain(`k=${key}`);
    expect(keyOnly).not.toContain('r=');
    expect(parsePairUrl(keyOnly)).toEqual({ hosts: ['192.168.1.5'], port: 7890, code: '123456', hostName: 'Mac', connectKey: key });
    // a room alone isn't written, nor read
    expect(buildPairUrl({ hosts: ['192.168.1.5'], port: 7890, code: '123456', hostName: 'Mac', connectId: room })).not.toContain('r=');
    expect(parsePairUrl(`appubot://pair?h=192.168.1.5&p=7890&c=123456&n=Mac&r=${room}`)).toEqual({ hosts: ['192.168.1.5'], port: 7890, code: '123456', hostName: 'Mac' });
    // a key alone, no address: nothing to reach
    expect(parsePairUrl(buildPairUrl({ hosts: [], port: 7890, code: '123456', hostName: 'Mac', connectKey: key }))).toBeNull();
  });
});

import { RelayFrame, decodeRelayFrame, encodeRelayFrame, writeRelayHeader } from './connect';
describe('relay framing', () => {
  it('round-trips and rejects junk', () => {
    const f = decodeRelayFrame(encodeRelayFrame(RelayFrame.DATA, 0xfffffffe, new Uint8Array([5, 6])));
    expect(f).toEqual({ type: RelayFrame.DATA, streamId: 0xfffffffe, payload: new Uint8Array([5, 6]) });
    // the header written in front of a sealed message made with headroom reads the same
    const buf = new Uint8Array(RELAY_HEADER + 2);
    buf.set([5, 6], RELAY_HEADER);
    expect(decodeRelayFrame(writeRelayHeader(buf, RelayFrame.DATA, 0x01020304))).toEqual({ type: RelayFrame.DATA, streamId: 0x01020304, payload: new Uint8Array([5, 6]) });
    expect(decodeRelayFrame(new Uint8Array([9, 0, 0, 0, 1]))).toBeNull();
    expect(decodeRelayFrame(new Uint8Array([1, 0]))).toBeNull();
  });
});
