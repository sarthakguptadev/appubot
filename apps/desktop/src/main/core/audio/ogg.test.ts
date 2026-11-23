import { describe, expect, it } from 'vitest';
import { demuxOggOpus, muxOggOpus, oggCrc32 } from './ogg';
import { FFMPEG_TONE } from './tone.fixture';


const packet = (n: number, seed: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

describe('ogg', () => {
  it('computes Ogg\'s CRC (CRC-32, init 0, unreflected, no final xor)', () => {
    expect(oggCrc32(new TextEncoder().encode('123456789'))).toBe(0x89a1897f);
    expect(oggCrc32(new Uint8Array(0))).toBe(0);
  });

  it('reads a file ffmpeg wrote', () => {
    const s = demuxOggOpus(FFMPEG_TONE);
    expect(s).toMatchObject({ channels: 1, preSkip: 312, inputSampleRate: 48_000, granuleEnd: 14_712 });
    expect(s.packets.length).toBe(16);
  });

  it('finds a damaged page', () => {
    const bad = Uint8Array.from(FFMPEG_TONE);
    bad[bad.length - 3]! ^= 0xff;
    expect(() => demuxOggOpus(bad)).toThrow(/CRC mismatch/);
    expect(() => demuxOggOpus(new TextEncoder().encode('not audio at all'))).toThrow('Not an OGG/Opus file');
  });

  it('round-trips packets, with ones over 255 bytes and pages over 255 segments', () => {
    const packets = [packet(10, 1), packet(255, 2), packet(0, 3), packet(600, 4), packet(70_000, 5), ...Array.from({ length: 120 }, (_, i) => packet(1 + (i % 300), i))];
    const ogg = muxOggOpus(packets, { channels: 2, frameSamples: 960, inputSampleRate: 16_000 });
    const s = demuxOggOpus(ogg);
    expect(s.channels).toBe(2);
    expect(s.preSkip).toBe(312);
    expect(s.inputSampleRate).toBe(16_000);
    expect(s.granuleEnd).toBe(312 + packets.length * 960);
    expect(s.packets.length).toBe(packets.length);
    s.packets.forEach((p, i) => expect(Buffer.compare(p, packets[i]!)).toBe(0));
  });

  it('writes OpusHead and OpusTags pages, granules and EOS as RFC 7845 asks', () => {
    const ogg = muxOggOpus(Array.from({ length: 60 }, (_, i) => packet(40, i)), { channels: 1, frameSamples: 960, samples: 59 * 960 + 100 });
    const pages: { flags: number; granule: number; seq: number }[] = [];
    const v = new DataView(ogg.buffer, ogg.byteOffset);
    for (let o = 0; o < ogg.length;) {
      const n = ogg[o + 26]!;
      let body = 0;
      for (let i = 0; i < n; i++) body += ogg[o + 27 + i]!;
      pages.push({ flags: ogg[o + 5]!, granule: v.getUint32(o + 6, true), seq: v.getUint32(o + 18, true) });
      if (o === 0) expect(new TextDecoder().decode(ogg.subarray(o + 28, o + 36))).toBe('OpusHead');
      o += 27 + n + body;
    }
    expect(pages).toEqual([
      { flags: 2, granule: 0, seq: 0 },
      { flags: 0, granule: 0, seq: 1 },
      { flags: 0, granule: 312 + 50 * 960, seq: 2 },
      { flags: 4, granule: 312 + 59 * 960 + 100, seq: 3 },
    ]);
    expect(new TextDecoder().decode(demuxOggOpus(ogg).packets[0]!)).not.toContain('OpusTags');
  });
});
