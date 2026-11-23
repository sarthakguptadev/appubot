/**
 * For tests: the local cipher (node:crypto) made asynchronous, as the phone's native one is. Each answer is worked out at
 * the call, as a native cipher copies its input then, and handed back after `delay()` ms, so with random delays later
 * calls often finish first: what the client's in-order queues must cope with.
 */
import { localChannelCipher, type ChannelCipher } from '@appubot/protocol';

export function asyncCipher(delay: () => number = () => Math.random() * 3): ChannelCipher<Uint8Array, false> {
  const base = localChannelCipher();
  const later = <T>(v: T) => new Promise<T>((resolve) => setTimeout(() => resolve(v), delay()));
  return {
    name: 'async (test)',
    importKey: (raw) => later(base.importKey(raw)),
    seal: (key, nonce, plain, headroom) => later(base.seal(key, nonce, plain, headroom)),
    open: (key, nonce, sealed) => later(base.open(key, nonce, sealed)),
    drop: (key) => base.drop(key),
  };
}
