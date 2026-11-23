import { describe, expect, it } from 'vitest';
import { IMAGE_MAX_BYTES, IMAGE_QUALITY_STEPS, base64Length, fitOutputType, fitPlan, fitsAgent, imageSize, isHeic } from './images';

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? Array.from(p, (c) => c.charCodeAt(0)) : p)));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, n >> 8];
const le24 = (n: number) => [n & 255, (n >> 8) & 255, n >> 16];
const zeros = (n: number) => new Array<number>(n).fill(0);

describe('images', () => {
  it('keeps the budget at 5 MB of base64', () => {
    expect(base64Length(IMAGE_MAX_BYTES)).toBeLessThanOrEqual(5_000_000);
    expect(base64Length(IMAGE_MAX_BYTES + 3)).toBeGreaterThan(5_000_000);
  });

  it('passes supported images within budget', () => {
    expect(fitsAgent('image/png', 1_000_000)).toBe(true);
    expect(fitsAgent('image/gif', 1_000_000, { width: 500, height: 400 })).toBe(true);
    expect(fitsAgent('image/png', 4_000_000)).toBe(false);
    expect(fitsAgent('image/png', 1_000_000, { width: 1440, height: 20_000 })).toBe(false);
    expect(fitsAgent('image/tiff', 1000)).toBe(false);
    expect(fitsAgent('image/svg+xml', 1000)).toBe(false);
  });

  it('tells HEIC by type or name', () => {
    expect(isHeic('IMG_1.HEIC', '')).toBe(true);
    expect(isHeic('a.heif', 'application/octet-stream')).toBe(true);
    expect(isHeic('x', 'image/heic')).toBe(true);
    expect(isHeic('a.heic.png', 'image/png')).toBe(false);
    expect(isHeic('a.jpg', 'image/jpeg')).toBe(false);
  });

  it('keeps photos JPEG and the rest WebP', () => {
    expect(fitOutputType('image/jpeg')).toBe('image/jpeg');
    expect(fitOutputType('image/png')).toBe('image/webp');
    expect(fitOutputType('image/bmp')).toBe('image/webp');
  });

  it('plans the long edge at 2048, down the quality ladder, then smaller', () => {
    const plan = fitPlan(6000, 4000);
    expect(plan[0]).toEqual({ width: 2048, height: 1365, quality: IMAGE_QUALITY_STEPS[0] });
    expect(plan.slice(0, 4).map((s) => s.quality)).toEqual([...IMAGE_QUALITY_STEPS]);
    expect(plan[4]).toMatchObject({ width: 1536, height: 1024 });
    expect(plan.at(-1)).toMatchObject({ width: 1126, height: 751, quality: 0.68 });
    expect(plan).toHaveLength(12);
    // a small picture keeps its size first, never grows; a tall one is held by its height
    expect(fitPlan(800, 600)[0]).toMatchObject({ width: 800, height: 600 });
    expect(fitPlan(1440, 20_000)[0]).toMatchObject({ width: 147, height: 2048 });
    // a 1px picture can't shrink: one size only
    expect(fitPlan(1, 1)).toHaveLength(4);
  });

  it('reads sizes from headers', () => {
    const png = bytes([0x89], 'PNG', [13, 10, 26, 10], be32(13), 'IHDR', be32(3000), be32(2000), zeros(5));
    expect(imageSize(png)).toEqual({ width: 3000, height: 2000 });
    expect(imageSize(bytes('GIF89a', le16(320), le16(240), zeros(4)))).toEqual({ width: 320, height: 240 });
    const riff = (chunk: string, body: number[]) => bytes('RIFF', zeros(4), 'WEBP', chunk, zeros(4), body, zeros(8));
    expect(imageSize(riff('VP8 ', [...zeros(6), ...le16(640), ...le16(480)]))).toEqual({ width: 640, height: 480 });
    expect(imageSize(riff('VP8X', [...zeros(4), ...le24(9999), ...le24(4999)]))).toEqual({ width: 10000, height: 5000 });
    // VP8L: 14-bit width-1 and height-1 packed after the 0x2f signature
    const w = 1023, h = 767;
    const bits = w | (h << 14);
    expect(imageSize(riff('VP8L', [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255]))).toEqual({ width: 1024, height: 768 });
    // JPEG: an APP1 segment, then SOF2 (progressive)
    const jpeg = bytes([0xff, 0xd8, 0xff, 0xe1, 0, 6], zeros(4), [0xff, 0xc2, 0, 17, 8, 0x0b, 0xb8, 0x0f, 0xa0], zeros(12));
    expect(imageSize(jpeg)).toEqual({ width: 4000, height: 3000 });
    // DHT (C4) isn't a frame
    expect(imageSize(bytes([0xff, 0xd8, 0xff, 0xc4, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, 10, 0, 20], zeros(12)))).toEqual({ width: 20, height: 10 });
    expect(imageSize(bytes('not an image at all'))).toBeNull();
    expect(imageSize(new Uint8Array())).toBeNull();
  });
});
