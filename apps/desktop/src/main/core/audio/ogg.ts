/**
 * Ogg (RFC 3533) carrying Opus (RFC 7845): pages in and out, no codec. A Telegram voice note is one of these, and so
 * is every spoken reply. Pure, no Electron.
 *
 * A page: `OggS`, version 0, flags (1 continued packet, 2 first page, 4 last page), granule position (int64 LE: for
 * Opus, 48 kHz samples up to the last packet that ends on the page, pre-skip included; -1 when none ends there),
 * serial, sequence number, CRC, segment count and lacing values (a packet is its segments up to the first one under
 * 255 bytes, so one of exactly 255·k bytes ends with a 0), then the segments.
 */
import { randomInt } from 'node:crypto';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

/** Ogg's CRC-32: polynomial 0x04c11db7, not reflected, starting at 0, no final xor (a page's own CRC field zeroed). */
export function oggCrc32(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]!) & 0xff]!) >>> 0;
  return crc;
}

const OGGS = [0x4f, 0x67, 0x67, 0x53];
const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const startsWith = (b: Uint8Array, s: string): boolean => b.length >= s.length && [...s].every((c, i) => b[i] === c.charCodeAt(0));
const isOggS = (b: Uint8Array, o: number): boolean => OGGS.every((x, i) => b[o + i] === x);

const FLAG_CONTINUED = 1;
const FLAG_BOS = 2;
const FLAG_EOS = 4;
const NO_GRANULE = -1;

export interface OggOpusStream {
  /** the audio packets, in order (the OpusHead and OpusTags headers left out) */
  packets: Uint8Array[];
  channels: number;
  /** 48 kHz samples the decoder drops at the start */
  preSkip: number;
  /** what the audio was before encoding (informative only: Opus always decodes at 48 kHz) */
  inputSampleRate: number;
  /** the last page's granule position (48 kHz samples, pre-skip included); 0 when there is none */
  granuleEnd: number;
}

/**
 * The first Opus stream in an Ogg file: its header fields and audio packets (packets that span pages are joined).
 * Every page's CRC is checked; a page cut off at the end of the file ends the stream there.
 */
export function demuxOggOpus(input: Uint8Array): OggOpusStream {
  // a plain view: a Buffer's slice() shares memory, and the CRC check zeroes a copy's field
  const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let serial: number | null = null;
  const packets: Uint8Array[] = [];
  let partial: Uint8Array[] | null = null;
  let granuleEnd = 0;
  let o = 0;
  while (o + 27 <= bytes.length) {
    if (!isOggS(bytes, o)) {
      // lost sync: look for the next page
      const next = bytes.indexOf(0x4f, o + 1);
      if (next < 0) break;
      o = next;
      continue;
    }
    if (bytes[o + 4] !== 0) throw new Error(`Unsupported Ogg version ${bytes[o + 4]}`);
    const flags = bytes[o + 5]!;
    const lo = v.getUint32(o + 6, true);
    const hi = v.getUint32(o + 10, true);
    const granule = lo === 0xffffffff && hi === 0xffffffff ? NO_GRANULE : hi * 2 ** 32 + lo;
    const pageSerial = v.getUint32(o + 14, true);
    const crc = v.getUint32(o + 22, true);
    const nSegs = bytes[o + 26]!;
    const headerLen = 27 + nSegs;
    if (o + headerLen > bytes.length) break;
    const lacing = bytes.subarray(o + 27, o + headerLen);
    let bodyLen = 0;
    for (const l of lacing) bodyLen += l;
    if (o + headerLen + bodyLen > bytes.length) break;
    const page = bytes.subarray(o, o + headerLen + bodyLen);
    const check = new Uint8Array(page);
    check.fill(0, 22, 26);
    if (oggCrc32(check) !== crc) throw new Error(`Ogg page ${v.getUint32(o + 18, true)} is damaged (CRC mismatch)`);
    o += page.length;

    const body = page.subarray(headerLen);
    // the stream we read: the first one that opens with an OpusHead
    if (serial === null) {
      if (flags & FLAG_BOS && startsWith(body, 'OpusHead')) serial = pageSerial;
      else continue;
    }
    if (pageSerial !== serial) continue;
    // a page that doesn't say it continues a packet: anything half-read before it is lost
    if (!(flags & FLAG_CONTINUED)) partial = null;
    let at = 0;
    let skipping = !!(flags & FLAG_CONTINUED) && partial === null;
    for (const l of lacing) {
      const seg = body.subarray(at, at + l);
      at += l;
      if (!skipping) (partial ??= []).push(seg);
      if (l < 255) {
        if (!skipping) packets.push(join(partial!));
        partial = null;
        skipping = false;
      }
    }
    if (granule !== NO_GRANULE) granuleEnd = granule;
    if (flags & FLAG_EOS) break;
  }
  const head = packets[0];
  if (serial === null || !head || !startsWith(head, 'OpusHead') || head.length < 19) throw new Error('Not an OGG/Opus file');
  if (head[8]! >> 4 !== 0) throw new Error(`Unsupported Opus header version ${head[8]}`);
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const audio = packets.slice(1);
  if (audio[0] && startsWith(audio[0], 'OpusTags')) audio.shift();
  return { packets: audio, channels: head[9]!, preSkip: hv.getUint16(10, true), inputSampleRate: hv.getUint32(12, true), granuleEnd };
}

function join(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return new Uint8Array(parts[0]!);
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  n = 0;
  for (const p of parts) { out.set(p, n); n += p.length; }
  return out;
}

export interface MuxOptions {
  channels: number;
  /** 48 kHz samples the decoder should drop at the start (the encoder's look-ahead; libopus: 312) */
  preSkip?: number;
  inputSampleRate?: number;
  /** 48 kHz samples per packet (960 for 20 ms) */
  frameSamples: number;
  /** the audio's real length in 48 kHz samples when the last packet is padded: the last page's granule trims to it */
  samples?: number;
}

/** Most packets on one page (20 ms each: a second of audio a page, like opusenc). */
const PACKETS_PER_PAGE = 50;

/**
 * Opus packets as an Ogg file: the OpusHead page, the OpusTags page (vendor "AppuBot", no comments), then the audio
 * on pages of up to 50 packets (or 255 segments), each granule the samples so far plus pre-skip, the last one EOS.
 */
export function muxOggOpus(packets: Uint8Array[], o: MuxOptions): Uint8Array {
  const preSkip = o.preSkip ?? 312;
  const serial = randomInt(0, 2 ** 32 - 1);
  const pages: Uint8Array[] = [];
  let seq = 0;
  const page = (flags: number, granule: number, lacing: number[], body: Uint8Array[]): void => {
    const headerLen = 27 + lacing.length;
    let bodyLen = 0;
    for (const b of body) bodyLen += b.length;
    const p = new Uint8Array(headerLen + bodyLen);
    const v = new DataView(p.buffer);
    p.set(OGGS, 0);
    p[4] = 0;
    p[5] = flags;
    if (granule === NO_GRANULE) { v.setUint32(6, 0xffffffff, true); v.setUint32(10, 0xffffffff, true); }
    else { v.setUint32(6, granule % 2 ** 32, true); v.setUint32(10, Math.floor(granule / 2 ** 32), true); }
    v.setUint32(14, serial, true);
    v.setUint32(18, seq++, true);
    p[26] = lacing.length;
    p.set(lacing, 27);
    let at = headerLen;
    for (const b of body) { p.set(b, at); at += b.length; }
    v.setUint32(22, oggCrc32(p), true);
    pages.push(p);
  };

  const head = new Uint8Array(19);
  const hv = new DataView(head.buffer);
  head.set(ascii('OpusHead'), 0);
  head[8] = 1;
  head[9] = o.channels;
  hv.setUint16(10, preSkip, true);
  hv.setUint32(12, o.inputSampleRate ?? 48_000, true);
  hv.setUint16(16, 0, true); // output gain
  head[18] = 0; // channel mapping family 0: mono or stereo
  page(FLAG_BOS, 0, [head.length], [head]);

  const vendor = ascii('AppuBot');
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(ascii('OpusTags'), 0);
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  page(0, 0, lacingOf(tags.length), [tags]);

  const total = preSkip + packets.length * o.frameSamples;
  const end = o.samples !== undefined ? Math.min(total, preSkip + o.samples) : total;
  let lacing: number[] = [];
  let body: Uint8Array[] = [];
  let ended = 0; // packets ending on this page
  let granule = NO_GRANULE;
  let continued = false; // this page opens with the rest of a packet
  const flush = (last: boolean) => {
    page((continued ? FLAG_CONTINUED : 0) | (last ? FLAG_EOS : 0), last ? end : granule, lacing, body);
    lacing = []; body = []; ended = 0; granule = NO_GRANULE; continued = false;
  };
  if (!packets.length) flush(true);
  packets.forEach((pkt, i) => {
    const laces = lacingOf(pkt.length);
    let at = 0;
    laces.forEach((l, k) => {
      if (lacing.length === 255) { flush(false); continued = k > 0; }
      lacing.push(l);
      body.push(pkt.subarray(at, at + l));
      at += l;
    });
    ended++;
    granule = preSkip + (i + 1) * o.frameSamples;
    const last = i === packets.length - 1;
    if (last || ended === PACKETS_PER_PAGE) flush(last);
  });
  return join(pages);
}

/** A packet's lacing values: 255 per full segment, then the rest (0 for a packet of exactly 255·k bytes). */
function lacingOf(len: number): number[] {
  const out = new Array<number>(Math.floor(len / 255)).fill(255);
  out.push(len % 255);
  return out;
}
