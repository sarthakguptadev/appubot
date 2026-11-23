import { AGENT_IMAGE_TYPES, IMAGE_MAX_BASE64, IMAGE_SOURCE_MAX, base64Length, fitOutputType, fitPlan, fitsAgent, imageSize, isHeic } from '@appubot/chat-core';
import { native } from '../../lib/native';
import { readImage, type PendingImage } from './attachments';

/** A dropped or pasted file the composer takes as a picture (a HEIC often comes with no type). */
export const isImageFile = (f: File): boolean => f.type.startsWith('image/') || isHeic(f.name, f.type);

/**
 * A picture as the agent can take it (after T3 Code's `imageCompression.ts`): a supported one within budget as is
 * (a GIF keeps its animation), anything else decoded and re-encoded down chat-core's `fitPlan` until it fits; what
 * the window can't decode (HEIC, TIFF…) main turns into a JPEG first. Null when it can't go in as an image.
 */
export async function fitImage(file: File): Promise<PendingImage | null> {
  // decoding hundreds of megapixels could run the window out of memory
  if (file.size > IMAGE_SOURCE_MAX) return null;
  if (!isHeic(file.name, file.type)) {
    if (AGENT_IMAGE_TYPES.test(file.type) && base64Length(file.size) <= IMAGE_MAX_BASE64) {
      const size = imageSize(new Uint8Array(await file.arrayBuffer()));
      if (fitsAgent(file.type, file.size, size)) return readImage(file);
    }
    const fitted = await reencode(file, file.type);
    if (fitted) return fitted;
  }
  const path = native().pathForFile(file);
  const jpeg = path ? await native().imageToJpeg(path).catch(() => null) : null;
  if (!jpeg) return null;
  if (jpeg.data.length <= IMAGE_MAX_BASE64) return readImage(fromBase64(jpeg.data, jpeg.mimeType));
  return reencode(fromBase64(jpeg.data, jpeg.mimeType), jpeg.mimeType);
}

function fromBase64(data: string, type: string): Blob {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Chromium encodes WebP; should it not, JPEG (on white) it is. */
let webp: Promise<boolean> | undefined;
function canWebp(): Promise<boolean> {
  // an OffscreenCanvas with no context refuses to encode at all
  const c = new OffscreenCanvas(1, 1);
  c.getContext('2d');
  return (webp ??= c.convertToBlob({ type: 'image/webp' }).then((b) => b.type === 'image/webp', () => false));
}

async function reencode(src: Blob, sourceType: string): Promise<PendingImage | null> {
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(src); } catch { return null; }
  try {
    let type = fitOutputType(sourceType);
    if (type === 'image/webp' && !(await canWebp())) type = 'image/jpeg';
    let canvas: OffscreenCanvas | null = null;
    for (const step of fitPlan(bmp.width, bmp.height)) {
      try {
        if (!canvas || canvas.width !== step.width || canvas.height !== step.height) {
          canvas = new OffscreenCanvas(step.width, step.height);
          const g = canvas.getContext('2d');
          if (!g) return null;
          if (type === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, step.width, step.height); }
          g.imageSmoothingQuality = 'high';
          g.drawImage(bmp, 0, 0, step.width, step.height);
        }
        const out = await canvas.convertToBlob({ type, quality: step.quality });
        if (base64Length(out.size) <= IMAGE_MAX_BASE64) return await readImage(out);
      } catch { canvas = null; /* too big to draw or encode: the next, smaller step may go */ }
    }
    return null;
  } finally { bmp.close(); }
}
