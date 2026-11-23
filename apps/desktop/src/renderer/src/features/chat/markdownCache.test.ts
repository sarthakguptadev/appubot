/** Finished messages' markdown is parsed once a run (Markdown.tsx `markdownTree`): a hit is the same tree. */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadMath, markdownTree } from './Markdown';

describe('markdownTree', () => {
  it('parses a text once and answers the same tree after, by content', () => {
    const text = '# Q3\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```';
    const first = markdownTree(text, false);
    expect(markdownTree(`${text}`, false)).toBe(first);
    expect(markdownTree(`${text}!`, false)).not.toBe(first);
    // no `$$`, no maths: the maths setting makes no difference, so the tree is shared
    expect(markdownTree(text, true)).toBe(first);
  });

  it('typesets maths once KaTeX (a chunk of its own) is here, and keeps only that tree', async () => {
    const text = 'Energy: $$E = mc^2$$';
    // before KaTeX: read as written, and not kept
    const early = markdownTree(text, true);
    expect(renderToStaticMarkup(early)).not.toContain('katex');
    expect(markdownTree(text, true)).not.toBe(early);
    await loadMath();
    const typeset = markdownTree(text, true);
    expect(renderToStaticMarkup(typeset)).toContain('katex');
    expect(markdownTree(text, true)).toBe(typeset);
    // maths off: the plain tree
    expect(renderToStaticMarkup(markdownTree(text, false))).not.toContain('katex');
  });
});
