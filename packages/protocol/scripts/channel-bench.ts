/**
 * How fast the channel seals and opens on this computer, per cipher: the Mac's (node:crypto AES-256-GCM), the pure-JS
 * fallback (@noble AES-256-GCM) and, for comparison, version 2's ChaCha20-Poly1305 (@noble, in JS). Not a test.
 *
 *   npx tsx packages/protocol/scripts/channel-bench.ts [kb per message, default 200] [messages, default 200]
 *
 * The phone's own cipher (expo-crypto) only runs on a phone: time it there.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { CHANNEL_CHUNK, Msg, RELAY_HEADER, acceptHello, createIdentity, jsChannelCipher, nodeChannelCipher, phoneHandshake, type SyncChannelCipher } from '../src/index';

const kb = Number(process.argv[2] ?? 200);
const rounds = Number(process.argv[3] ?? 200);
const size = Math.min(kb * 1024, CHANNEL_CHUNK);
const payload = new Uint8Array(size).map((_, i) => i & 0xff);
const mb = (size * rounds) / 1e6;

function line(name: string, sealMs: number, openMs: number) {
  const rate = (ms: number) => `${(mb / (ms / 1000)).toFixed(0).padStart(6)} MB/s (${((ms * 1000) / rounds).toFixed(0).padStart(5)} µs each)`;
  console.log(`${name.padEnd(36)} seal ${rate(sealMs)}   open ${rate(openMs)}`);
}

/** A whole channel, as the Mac seals (with the relay's headroom) and the phone opens. */
function channel(cipher: SyncChannelCipher) {
  const mac = createIdentity();
  const hs = phoneHandshake(mac.xPublic, cipher);
  const accepted = acceptHello(mac, hs.hello, 0, cipher)!;
  const phone = hs.finish(accepted.reply)!;
  for (let i = 0; i < 20; i++) phone.open(accepted.channel.seal(Msg.WS_TEXT, 1, payload, RELAY_HEADER).subarray(RELAY_HEADER)); // warm up
  const sealed: Uint8Array[] = [];
  let t = performance.now();
  for (let i = 0; i < rounds; i++) sealed.push(accepted.channel.seal(Msg.WS_TEXT, 1, payload, RELAY_HEADER));
  const sealMs = performance.now() - t;
  t = performance.now();
  for (const s of sealed) if (!phone.open(s.subarray(RELAY_HEADER))) throw new Error('did not open');
  line(`channel, ${cipher.name}`, sealMs, performance.now() - t);
}

/** Version 2's cipher, the way it sealed (in place behind the headroom) and opened. */
function chacha() {
  const key = new Uint8Array(32).fill(7);
  const nonce = (n: number) => { const b = new Uint8Array(12); b[11] = n & 255; b[10] = (n >>> 8) & 255; return b; };
  const sealed: Uint8Array[] = [];
  let t = performance.now();
  for (let i = 0; i < rounds; i++) {
    const out = new Uint8Array(RELAY_HEADER + 5 + size + 16);
    out.set(payload, RELAY_HEADER + 5);
    chacha20poly1305(key, nonce(i)).encrypt(out.subarray(RELAY_HEADER, RELAY_HEADER + 5 + size), out.subarray(RELAY_HEADER));
    sealed.push(out);
  }
  const sealMs = performance.now() - t;
  t = performance.now();
  sealed.forEach((s, i) => chacha20poly1305(key, nonce(i)).decrypt(s.subarray(RELAY_HEADER)));
  line('v2: @noble ChaCha20-Poly1305 (JS)', sealMs, performance.now() - t);
}

console.log(`${rounds} messages of ${(size / 1024).toFixed(0)} KB (${mb.toFixed(1)} MB each way), Node ${process.versions.node}`);
const node = nodeChannelCipher();
if (node) channel(node);
channel(jsChannelCipher);
chacha();
