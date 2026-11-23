import { describe, expect, it } from 'vitest';
import { collectGallery, wrapIndex, type GalleryNode } from './imageGallery';

/** A tiny DOM stand-in: `closest` matches the attribute/class selectors collectGallery uses. */
class Node implements GalleryNode {
  parent: Node | null = null;
  children: Node[] = [];
  constructor(public tag: string, public attrs: Record<string, string> = {}, kids: Node[] = []) {
    for (const k of kids) { k.parent = this; this.children.push(k); }
  }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  private matches(sel: string): boolean {
    return sel.split(',').map((s) => s.trim()).some((s) =>
      s.startsWith('[') ? s.slice(1, -1) in this.attrs : s.startsWith('.') ? (this.attrs.class ?? '').split(' ').includes(s.slice(1)) : this.tag === s);
  }
  closest(sel: string): Node | null {
    for (let n: Node | null = this; n; n = n.parent) if (n.matches(sel)) return n;
    return null;
  }
  *querySelectorAll(sel: string): Iterable<Node> {
    for (const c of this.children) { if (c.matches(sel)) yield c; yield* c.querySelectorAll(sel); }
  }
}

const img = (src: string, title?: string) => new Node('img', { 'data-gallery-src': src, ...(title ? { 'data-gallery-title': title } : {}) });

describe('collectGallery', () => {
  it('collects every image of the message in document order, at the one opened', () => {
    const a = img('a.png');
    const b = img('b.png', 'b.png');
    const md = img('https://x/c.png', 'chart');
    new Node('div', { 'data-image-gallery': '' }, [new Node('div', {}, [a]), b, new Node('div', { class: 'chat-markdown' }, [md])]);
    expect(collectGallery(b)).toEqual({ images: [{ src: 'a.png' }, { src: 'b.png', title: 'b.png' }, { src: 'https://x/c.png', title: 'chart' }], index: 1 });
  });

  it('leaves out images in folded (inert) regions and links', () => {
    const a = img('a.png');
    const hidden = img('hidden.png');
    const linked = img('linked.png');
    new Node('div', { 'data-image-gallery': '' }, [new Node('div', { inert: '' }, [hidden]), new Node('a', {}, [linked]), a]);
    expect(collectGallery(a)).toEqual({ images: [{ src: 'a.png' }], index: 0 });
  });

  it('falls back to the markdown block, then to the image alone', () => {
    const a = img('a.png');
    const b = img('b.png');
    new Node('div', { class: 'chat-markdown' }, [a, b]);
    expect(collectGallery(b)).toEqual({ images: [{ src: 'a.png' }, { src: 'b.png' }], index: 1 });
    expect(collectGallery(img('lone.png'))).toEqual({ images: [{ src: 'lone.png' }], index: 0 });
  });
});

describe('wrapIndex', () => {
  it('goes round both ways', () => {
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(7, 3)).toBe(1);
    expect(wrapIndex(0, 0)).toBe(0);
  });
});
