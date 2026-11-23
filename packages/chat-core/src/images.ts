/**
 * Pictures for an agent's vision (after T3 Code's `imageCompression.ts`): what goes in as is, and the ladder an image
 * too big for it is re-encoded down until it fits. Pure: the renderer draws on a canvas, main uses its `ImageCodec`.
 */

/** What every agent's model takes as an image block. */
export const AGENT_IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/i;
/** The APIs refuse an image over 5 MB, and Anthropic counts its base64: kept a little under. */
export const IMAGE_MAX_BASE64 = 5_000_000;
/** The same budget in file bytes (3 bytes → 4 base64 characters): ~3.7 MB. */
export const IMAGE_MAX_BYTES = Math.floor(IMAGE_MAX_BASE64 / 4) * 3;
/** Wider or taller than this and the APIs refuse it outright. */
export const IMAGE_MAX_EDGE = 8000;
/** Long edge of a re-encoded image: a Retina screenshot stays legible. */
export const IMAGE_FIT_DIM = 2048;
/** Files past this aren't decoded at all (hundreds of megapixels could run the window out of memory). */
export const IMAGE_SOURCE_MAX = 50 * 1024 * 1024;
/** Tried in order at each size; past the last, the size drops instead (T3's ladder). */
export const IMAGE_QUALITY_STEPS = [0.92, 0.85, 0.78, 0.68] as const;
export const IMAGE_SCALE_STEPS = [1, 0.75, 0.55] as const;

export interface ImageSize { width: number; height: number }
export interface FitStep extends ImageSize { quality: number }

export const base64Length = (bytes: number): number => 4 * Math.ceil(bytes / 3);

/** An image the agent takes untouched: a type it reads, within budget, not too many pixels (unknown size passes). */
export function fitsAgent(mimeType: string, bytes: number, size?: ImageSize | null): boolean {
  if (!AGENT_IMAGE_TYPES.test(mimeType) || base64Length(bytes) > IMAGE_MAX_BASE64) return false;
  return !size || Math.max(size.width, size.height) <= IMAGE_MAX_EDGE;
}

/** HEIC/HEIF, by type or (Finder often leaves the type empty) by name. */
export function isHeic(name: string, type: string): boolean {
  if (/^image\/hei[cf](-sequence)?$/i.test(type)) return true;
  return (!type || type === 'application/octet-stream') && /\.(heic|heif)$/i.test(name);
}

/**
 * What a re-encode turns `sourceType` into: a JPEG stays JPEG (a photo, no alpha; the format every agent reads), the
 * rest (PNG screenshots, WebP, GIF, BMP…) WebP, which keeps transparency and comes out smaller than either.
 */
export const fitOutputType = (sourceType: string): 'image/jpeg' | 'image/webp' =>
  /^image\/(jpe?g|pjpeg)$/i.test(sourceType) ? 'image/jpeg' : 'image/webp';

/** The encodes to try, in order, for a `width`×`height` picture: each size (≤ `maxDim`, then smaller) down the quality ladder. */
export function fitPlan(width: number, height: number, maxDim = IMAGE_FIT_DIM): FitStep[] {
  const long = Math.max(width, height, 1);
  const base = Math.min(maxDim, long);
  const steps: FitStep[] = [];
  let last = '';
  for (const scale of IMAGE_SCALE_STEPS) {
    const k = (base * scale) / long;
    const w = Math.max(1, Math.round(width * k));
    const h = Math.max(1, Math.round(height * k));
    if (`${w}x${h}` === last) continue;
    last = `${w}x${h}`;
    for (const quality of IMAGE_QUALITY_STEPS) steps.push({ width: w, height: h, quality });
  }
  return steps;
}

/** Pixel size from a PNG, GIF, WebP or JPEG header, without decoding; null when it can't tell. */
export function imageSize(b: Uint8Array): ImageSize | null {
  const u16be = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const u16le = (i: number) => b[i]! | (b[i + 1]! << 8);
  const u24le = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
  const u32be = (i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  const ok = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null);
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === 'PNG') return ok(u32be(16), u32be(20));
  if (b.length >= 10 && ascii(0, 4) === 'GIF8') return ok(u16le(6), u16le(8));
  if (b.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8 ') return ok(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    if (chunk === 'VP8L') {
      const [b0, b1, b2, b3] = [b[21]!, b[22]!, b[23]!, b[24]!];
      return ok(1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
    }
    if (chunk === 'VP8X') return ok(1 + u24le(24), 1 + u24le(27));
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // walk the segments to the first start-of-frame (C0–CF but C4/C8/CC): height, then width
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1]!;
      if (m === 0xff) { i++; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return ok(u16be(i + 7), u16be(i + 5));
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      i += 2 + u16be(i + 2);
    }
  }
  return null;
}
