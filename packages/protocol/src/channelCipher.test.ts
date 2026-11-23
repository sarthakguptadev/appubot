import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { CHANNEL_TAG, channelNonce, jsChannelCipher, nodeChannelCipher, webCryptoChannelCipher, type ChannelCipher } from './index';

const key = () => new Uint8Array(randomBytes(32));
const text = (s: string) => new TextEncoder().encode(s);

/** seal with `a`, open with `b`: every cipher must read every other's output */
async function roundTrip(a: ChannelCipher, b: ChannelCipher, headroom = 0): Promise<void> {
  const raw = key();
  const ka = await a.importKey(raw.slice());
  const kb = await b.importKey(raw.slice());
  const nonce = channelNonce(7);
  const sealed = await a.seal(ka, nonce, [text('head:'), text('the payload')], headroom);
  expect(sealed.length).toBe(headroom + 'head:the payload'.length + CHANNEL_TAG);
  const opened = await b.open(kb, nonce, sealed.subarray(headroom));
  expect(opened && new TextDecoder().decode(opened)).toBe('head:the payload');
  // a flipped byte, or the wrong nonce, opens nothing
  const bad = sealed.slice(headroom);
  bad[0]! ^= 1;
  expect(await b.open(kb, nonce, bad)).toBeNull();
  expect(await b.open(kb, channelNonce(8), sealed.subarray(headroom))).toBeNull();
  a.drop(ka);
  b.drop(kb);
}

describe('channel ciphers', () => {
  const web = webCryptoChannelCipher();
  const node = nodeChannelCipher();

  it('WebCrypto exists in this Node and is asynchronous', () => {
    expect(web).not.toBeNull();
    expect(node).not.toBeNull();
  });

  it('WebCrypto seals and opens, with headroom', async () => {
    await roundTrip(web!, web!);
    await roundTrip(web!, web!, 5);
  });

  it('WebCrypto, node:crypto and @noble read each other', async () => {
    await roundTrip(web!, node!);
    await roundTrip(node!, web!, 5);
    await roundTrip(web!, jsChannelCipher);
    await roundTrip(jsChannelCipher, web!);
  });

  it('WebCrypto wipes the raw key it was given and refuses a short message', async () => {
    const raw = key();
    const k = await web!.importKey(raw);
    expect(raw.every((b) => b === 0)).toBe(true);
    expect(await web!.open(k, channelNonce(1), new Uint8Array(3))).toBeNull();
  });

  it('is null without crypto.subtle', () => {
    expect(webCryptoChannelCipher(null)).toBeNull();
  });
});
