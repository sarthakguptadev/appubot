/**
 * Pictures the window has already shown, kept decoded for the run, so a chat opened again (or a message scrolled back
 * into the list) paints them in its first frame instead of loading and decoding them afresh: each one shown is held
 * by an off-DOM `Image` (Chromium keeps a referenced picture in its memory cache, decoded data with it), and an
 * `<img>` of a picture held here asks for a synchronous decode, which is then a cache hit. The newest `MAX` are held.
 *
 * Shapes are kept too, across launches (lib/lruStore.ts: a width and height per picture or clip, never content), so
 * a video's box (or anything sized by its picture) has its size before the bytes arrive.
 */
import { LruStore, MemoryLru } from './lruStore';

const MAX = 160;

const held = new MemoryLru<HTMLImageElement>(MAX);

/** The picture was shown this run: an `<img>` of it can decode in step and paint at once. */
export const isDecoded = (src: string): boolean => !!src && held.has(src);

/** Hold a picture that just loaded (its `<img>`'s onLoad). */
export function noteShown(src: string): void {
  if (!src || typeof Image === 'undefined') return;
  if (held.get(src)) return;
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  held.set(src, img);
}

/** Forget pictures (their blob: URLs were revoked, or a computer's copies were dropped). */
export function forgetShown(match: (src: string) => boolean): void {
  for (const src of held.keys()) if (match(src)) held.delete(src);
}

export type Shape = [number, number];
const isShape = (v: unknown): v is Shape => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && n > 0 && n < 100_000);

/** each picture's or clip's width and height, by `<computer|local>:<file id>` */
export const mediaShapes = new LruStore<Shape>('appubot.mediaShapes', 1500, isShape);

/** A shape as a CSS aspect-ratio ('16 / 9'), or the fallback. */
export const aspectOf = (shape: Shape | undefined, fallback: string): string => (shape ? `${shape[0]} / ${shape[1]}` : fallback);
