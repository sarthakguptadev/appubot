/**
 * A bot's Markdown reply → Telegram's HTML (`parse_mode: 'HTML'`), cut into messages that each hold whole tags.
 * Telegram's HTML knows <b> <i> <s> <u> <code> <pre> <a> <blockquote> and nothing else, so headings become bold lines,
 * lists get bullets, tables become a monospace block and anything else is escaped text.
 */

/** Telegram's limit is 4096 characters of visible text; the HTML is always longer, so this stays under it. */
export const TELEGRAM_CHUNK = 4000;

export const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string): string => escapeHtml(s).replace(/"/g, '&quot;');

const SAFE_URL = /^(https?:|tg:|mailto:)/i;

/** Inline Markdown on one line → Telegram HTML. */
export function telegramInline(src: string): string {
  const held: string[] = [];
  const hold = (html: string): string => `\u0000${held.push(html) - 1}\u0000`;
  let s = src
    // code spans first: nothing inside them is formatting
    .replace(/(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1(?!`)/g, (_, _t, code: string) => hold(`<code>${escapeHtml(code.trim() || code)}</code>`))
    // images and links (an image becomes a link to it)
    .replace(/!?\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (all, text: string, url: string) =>
      SAFE_URL.test(url) ? hold(`<a href="${escapeAttr(url)}">${telegramInline(text || url)}</a>`) : hold(escapeHtml(text || all)))
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, (_, url: string) => hold(`<a href="${escapeAttr(url)}">${escapeHtml(url)}</a>`));
  s = escapeHtml(s)
    .replace(/\*\*\*(?=\S)([^*\n]*?\S)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w])__(?=\S)([^\n]*?\S)__(?!\w)/g, '$1<b>$2</b>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, '<s>$1</s>')
    .replace(/\|\|(?=\S)([^\n]*?\S)\|\|/g, '<tg-spoiler>$1</tg-spoiler>');
  // placeholders can nest (a link's text holding code), so restore until none are left
  for (let i = 0; i < 4 && s.includes('\u0000'); i++) s = s.replace(/\u0000(\d+)\u0000/g, (_, n: string) => held[Number(n)] ?? '');
  return s;
}

/** Inline Markdown stripped to plain text (table cells, where no tags are allowed). */
export function stripInline(src: string): string {
  return src
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!?\[([^\]\n]*)\]\(([^)\s]+)[^)]*\)/g, (_, t: string, u: string) => t || u)
    .replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1')
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)\*(?![*\w])/g, '$1$2').replace(/(^|[^\w])_(?=\S)([^_\n]+?)_(?!\w)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1');
}

/** One piece of the message: a single line or a whole block, already HTML. `pre` pieces can be split by line. */
interface Piece { html: string; code?: { lang: string; lines: string[] } }

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w#+.-]*)/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (line: string): string[] => {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => stripInline(c.trim().replace(/\\\|/g, '|')));
};

/** A Markdown table as aligned monospace text. */
function tableText(rows: string[][]): string {
  const n = Math.max(...rows.map((r) => r.length));
  const width = Array.from({ length: n }, (_, i) => Math.min(40, Math.max(...rows.map((r) => [...(r[i] ?? '')].length))));
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - [...s].length));
  const line = (r: string[]) => width.map((w, i) => pad(r[i] ?? '', w)).join('  ').trimEnd();
  return [line(rows[0]!), width.map((w) => '─'.repeat(w)).join('  '), ...rows.slice(1).map(line)].join('\n');
}

const preHtml = (lang: string, code: string): string =>
  lang ? `<pre><code class="language-${escapeAttr(lang)}">${escapeHtml(code)}</code></pre>` : `<pre>${escapeHtml(code)}</pre>`;

function pieces(md: string): Piece[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: Piece[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      const close = fence[1]!;
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith(close.slice(0, 3)); i++) body.push(lines[i]!);
      out.push({ html: preHtml(fence[2] ?? '', body.join('\n')), code: { lang: fence[2] ?? '', lines: body } });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const rows = [cells(line)];
      for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim(); i++) rows.push(cells(lines[i]!));
      i--;
      const text = tableText(rows);
      out.push({ html: preHtml('', text), code: { lang: '', lines: text.split('\n') } });
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const quote: string[] = [];
      for (; i < lines.length && /^\s{0,3}>/.test(lines[i]!); i++) quote.push(lines[i]!.replace(/^\s{0,3}>\s?/, ''));
      i--;
      out.push({ html: `<blockquote>${quote.map(lineHtml).join('\n')}</blockquote>` });
      continue;
    }
    out.push({ html: lineHtml(line) });
  }
  // no runs of blank lines
  return out.filter((p, k) => p.html !== '' || (k > 0 && out[k - 1]!.html !== ''));
}

function lineHtml(line: string): string {
  const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (h) return `<b>${telegramInline(h[1]!)}</b>`;
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return '──────────';
  const li = /^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
  if (li) {
    const indent = '   '.repeat(Math.floor(li[1]!.replace(/\t/g, '  ').length / 2));
    const mark = li[2] === undefined ? '•' : li[2] === ' ' ? '☐' : '☑';
    return `${indent}${mark} ${telegramInline(li[3]!)}`;
  }
  const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
  if (ol) return `${'   '.repeat(Math.floor(ol[1]!.length / 2))}${ol[2]}. ${telegramInline(ol[3]!)}`;
  return telegramInline(line.trim() ? line.replace(/\s+$/, '') : '');
}

/** The whole reply as Telegram HTML (no length limit: see `telegramChunks`). */
export function telegramHtml(md: string): string {
  return pieces(md).map((p) => p.html).join('\n').trim();
}

/** Split a piece too long for one message: code by lines (each part its own <pre>), text by words. */
function split(p: Piece, max: number): string[] {
  if (p.code) {
    const out: string[] = [];
    let cur: string[] = [];
    const room = max - preHtml(p.code.lang, '').length;
    const flush = () => { if (cur.length) out.push(preHtml(p.code!.lang, cur.join('\n'))); cur = []; };
    for (const raw of p.code.lines) {
      // a single line longer than a message: hard-cut it
      for (let l = raw; ; ) {
        const esc = (s: string) => escapeHtml(s).length;
        let take = l;
        while (esc(take) > room) take = take.slice(0, Math.floor(take.length * 0.8));
        if (esc([...cur, take].join('\n')) > room) flush();
        cur.push(take);
        l = l.slice(take.length);
        if (!l) break;
      }
    }
    flush();
    return out;
  }
  const out: string[] = [];
  let cur = '';
  for (const word of p.html.replace(/<[^>]+>/g, '').split(/(?<=\s)/)) {
    if (cur && (cur + word).length > max) { out.push(cur.trimEnd()); cur = ''; }
    cur += word.length > max ? word.slice(0, max) : word;
  }
  if (cur.trim()) out.push(cur.trimEnd());
  return out;
}

/** The reply as Telegram HTML messages, each at most `max` characters and with every tag closed in it. */
export function telegramChunks(md: string, max = TELEGRAM_CHUNK): string[] {
  const out: string[] = [];
  let cur = '';
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const p of pieces(md)) {
    const parts = p.html.length > max ? split(p, max) : [p.html];
    for (const h of parts) {
      if (cur && cur.length + 1 + h.length > max) push();
      cur = cur ? `${cur}\n${h}` : h;
    }
  }
  push();
  return out;
}

/** Telegram HTML back to plain text (when Telegram refuses a message's HTML). */
export function htmlToPlain(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}
