/**
 * Colours for one line of Markdown in the code view's text field (MarkdownEditor: a bot's MEMORY.md, instructions,
 * a skill): which stretches are a heading, a list
 * marker, an entry's date, code, a quote, a link. Done here, in step with typing, rather than by the chat's
 * highlighter (which answers later, so text typed into the editor would wait for its colours); the pieces always add
 * up to the line exactly, since the editor lays a text field over them.
 */
export type MarkdownTokenKind = 'plain' | 'heading' | 'marker' | 'date' | 'code' | 'string' | 'strong' | 'link' | 'comment';
export interface MarkdownToken { text: string; kind: MarkdownTokenKind }

/** inside a line: `code`, **bold**, "quoted" (straight or curly), a link, an entry's [2026-10-13] */
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|("[^"\n]+"|“[^”\n]+”)|(https?:\/\/[^\s)>\]]+)|(\[\d{4}-\d{2}-\d{2}\])/g;
const KINDS: MarkdownTokenKind[] = ['code', 'strong', 'string', 'link', 'date'];

function inline(text: string, out: MarkdownToken[]): void {
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > at) out.push({ text: text.slice(at, i), kind: 'plain' });
    const which = KINDS.find((_, k) => m[k + 1] !== undefined) ?? 'plain';
    out.push({ text: m[0], kind: which });
    at = i + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), kind: 'plain' });
}

export function markdownTokens(line: string): MarkdownToken[] {
  if (!line) return [];
  if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) return [{ text: line, kind: 'heading' }];
  if (/^\s*>/.test(line) || /^\s*<!--.*-->\s*$/.test(line)) return [{ text: line, kind: 'comment' }];
  const out: MarkdownToken[] = [];
  const list = /^(\s*)([-*+]|\d+[.)])(\s+)/.exec(line);
  let rest = line;
  if (list) {
    if (list[1]) out.push({ text: list[1], kind: 'plain' });
    out.push({ text: `${list[2] ?? ''}${list[3] ?? ''}`, kind: 'marker' });
    rest = line.slice(list[0].length);
  }
  inline(rest, out);
  return out;
}
