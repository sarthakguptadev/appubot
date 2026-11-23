import { describe, expect, it } from 'vitest';
import { htmlToPlain, telegramChunks, telegramHtml, telegramInline } from './telegram';

describe('telegram html', () => {
  it('formats inline markdown', () => {
    expect(telegramInline('**bold** and *it* and _it2_ and ~~gone~~ and `a<b>`')).toBe('<b>bold</b> and <i>it</i> and <i>it2</i> and <s>gone</s> and <code>a&lt;b&gt;</code>');
    expect(telegramInline('snake_case_name stays, 2 * 3 * 4 too')).toBe('snake_case_name stays, 2 * 3 * 4 too');
    expect(telegramInline('see [the docs](https://x.dev/a_b?q=1&r=2) & <b>')).toBe('see <a href="https://x.dev/a_b?q=1&amp;r=2">the docs</a> &amp; &lt;b&gt;');
    expect(telegramInline('[bad](javascript:void)')).toBe('bad');
    expect(telegramInline('**see `x`**')).toBe('<b>see <code>x</code></b>');
  });

  it('formats blocks', () => {
    const md = '# Title\n\nSome text.\n\n\n\n- one\n  - two\n- [x] done\n1. first\n> quoted **here**\n\n```ts\nconst a = 1 < 2;\n```\n---';
    expect(telegramHtml(md)).toBe([
      '<b>Title</b>', '', 'Some text.', '', '• one', '   • two', '☑ done', '1. first', '<blockquote>quoted <b>here</b></blockquote>', '',
      '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>', '──────────',
    ].join('\n'));
  });

  it('turns tables into monospace', () => {
    expect(telegramHtml('| Name | Qty |\n|---|--:|\n| **Apple** | 3 |\n| Kiwi | 12 |')).toBe('<pre>Name   Qty\n─────  ───\nApple  3\nKiwi   12</pre>');
  });

  it('cuts long replies into whole messages', () => {
    const md = Array.from({ length: 300 }, (_, i) => `Line **${i}** of the reply.`).join('\n');
    const chunks = telegramChunks(md, 1000);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(1000);
      expect((c.match(/<b>/g) ?? []).length).toBe((c.match(/<\/b>/g) ?? []).length);
    }
    expect(chunks.map(htmlToPlain).join('\n')).toBe(md.replace(/\*\*/g, ''));
  });

  it('splits a long code block into code blocks', () => {
    const code = Array.from({ length: 200 }, (_, i) => `x${i} = ${i} < 5`).join('\n');
    const chunks = telegramChunks('```py\n' + code + '\n```', 500);
    for (const c of chunks) { expect(c.length).toBeLessThanOrEqual(500); expect(c).toMatch(/^<pre><code class="language-py">[\s\S]*<\/code><\/pre>$/); }
    expect(chunks.map(htmlToPlain).join('\n')).toBe(code);
  });
});
