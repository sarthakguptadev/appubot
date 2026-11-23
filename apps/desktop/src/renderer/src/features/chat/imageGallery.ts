// A message's image gallery (after T3 Code's markdownImageGallery, MIT): every image that opens larger carries
// `data-gallery-src` (its full-size src) and `data-gallery-title`, the message's root carries `data-image-gallery`
// (AgentTurn, UserMessage). Opening one collects them all from there, in document order (tiles, file previews,
// markdown images), and `ImageGallery` (GalleryDialog.tsx, in ModalHost) shows them.
import type { MouseEvent } from 'react';
import { create } from 'zustand';

export interface GalleryImage { src: string; title?: string }
export interface Gallery { images: GalleryImage[]; index: number }

export const useGallery = create<{ gallery: Gallery | null }>(() => ({ gallery: null }));

export const closeGallery = () => useGallery.setState({ gallery: null });

/** Wraps the index both ways (←/→ go round). */
export const wrapIndex = (i: number, n: number): number => (n > 0 ? ((i % n) + n) % n : 0);

export function stepGallery(by: -1 | 1): void {
  const g = useGallery.getState().gallery;
  if (g && g.images.length > 1) useGallery.setState({ gallery: { ...g, index: wrapIndex(g.index + by, g.images.length) } });
}

/** The attributes that put an image in its message's gallery. */
export const galleryProps = (src: string, title?: string) => ({ 'data-gallery-src': src, 'data-gallery-title': title || undefined });

/** What `collectGallery` needs of a DOM element (an Element is one). */
export interface GalleryNode {
  getAttribute(name: string): string | null;
  closest(selector: string): GalleryNode | null;
  querySelectorAll(selector: string): Iterable<GalleryNode>;
}

const itemOf = (n: GalleryNode): GalleryImage => {
  const title = n.getAttribute('data-gallery-title');
  return { src: n.getAttribute('data-gallery-src') ?? '', ...(title ? { title } : {}) };
};

/**
 * Every image in `el`'s message with `el`'s place among them. Left out: images in an inert (folded or closing) region
 * and ones inside a link (those open the link).
 */
export function collectGallery(el: GalleryNode): Gallery {
  const scope = el.closest('[data-image-gallery]') ?? el.closest('.chat-markdown');
  const images: GalleryImage[] = [];
  let index = -1;
  for (const n of scope?.querySelectorAll('[data-gallery-src]') ?? []) {
    if (n === el) index = images.length;
    else if (n.closest('[inert], a')) continue;
    if (n.getAttribute('data-gallery-src')) images.push(itemOf(n));
  }
  return index < 0 ? { images: [itemOf(el)], index: 0 } : { images, index };
}

/** Click handler for a zoomable image (or its button): opens its message's gallery at it. */
export function openGalleryAt(e: MouseEvent<Element>): void {
  const el = e.currentTarget.closest('[data-gallery-src]');
  if (!el || el.closest('a')) return;
  e.preventDefault();
  useGallery.setState({ gallery: collectGallery(el) });
}
