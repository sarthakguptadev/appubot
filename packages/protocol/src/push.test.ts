import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2';
import { createIdentity, fromBase64Url, toBase64Url } from './connect';
import { DeviceSchema, Methods, PROTOCOL_VERSION, MIN_PROTOCOL_VERSION, PushRegistrationSchema } from './index';
import { PUSH_CONTEXT, PUSH_HEADER, PUSH_SINCE_PROTOCOL, pushSignedBytes, pushUrl, signPush } from './push';

describe('push signing', () => {
  it('signs the context, the nonce and the body hash with the room key (verified by WebCrypto, as the relay does)', async () => {
    const id = createIdentity();
    const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(38)));
    const body = new TextEncoder().encode('{"messages":[]}');
    const h = signPush(id.edSecret, id.edPublic, nonce, body);
    expect(h[PUSH_HEADER.key]).toBe(toBase64Url(id.edPublic));
    expect(h[PUSH_HEADER.nonce]).toBe(nonce);
    const signed = new Uint8Array([...new TextEncoder().encode(PUSH_CONTEXT), ...fromBase64Url(nonce)!, ...sha256(body)]);
    expect(pushSignedBytes(fromBase64Url(nonce)!, body)).toEqual(signed);
    // WebCrypto wants ArrayBuffer-backed views
    const ab = (u: Uint8Array) => new Uint8Array(u);
    const key = await crypto.subtle.importKey('raw', ab(id.edPublic), { name: 'Ed25519' }, false, ['verify']);
    const sig = ab(fromBase64Url(h[PUSH_HEADER.sig]!)!);
    expect(await crypto.subtle.verify('Ed25519', key, sig, signed)).toBe(true);
    // another body doesn't verify
    expect(await crypto.subtle.verify('Ed25519', key, sig, ab(pushSignedBytes(fromBase64Url(nonce)!, new Uint8Array([1]))))).toBe(false);
  });

  it('refuses a nonce that is not base64url', () => {
    const id = createIdentity();
    expect(() => signPush(id.edSecret, id.edPublic, 'not base64!', new Uint8Array())).toThrow();
  });

  it('finds the push endpoint from the relay URL', () => {
    expect(pushUrl()).toBe('https://connect.appubot.com/push');
    expect(pushUrl('ws://127.0.0.1:9/')).toBe('http://127.0.0.1:9/push');
  });
});

describe('push contract', () => {
  it('came with a protocol bump, MIN unchanged', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(PUSH_SINCE_PROTOCOL);
    expect(MIN_PROTOCOL_VERSION).toBe(1);
  });

  it('fills a registration’s defaults and keeps the token off the device record', () => {
    expect(PushRegistrationSchema.parse({ token: 't', platform: 'ios' })).toEqual({ token: 't', platform: 'ios', previews: true, kinds: ['done', 'needs-you', 'failed'] });
    expect(Methods['devices.setPush'].params.parse({ push: null })).toEqual({ push: null });
    const d = DeviceSchema.parse({ id: 'd', name: 'n', platform: 'ios', pairedAt: 1, pushOn: true, token: 'secret' });
    expect(d).not.toHaveProperty('token');
    expect(d.pushOn).toBe(true);
  });
});
