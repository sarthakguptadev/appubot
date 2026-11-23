// Reading a reply while it streams: how much of the Markdown so far can be read without waiting for more. A cut falls
// at the end of a finished line (a paragraph, list item or heading) or after a sentence's end inside the line being
// written, never inside a code block (it is skipped when read anyway), a table row, or a list's number. A reply's
// first piece may also end at a clause break once it is long enough, so the voice starts before the sentence ends.
import { speechText } from '@appubot/chat-core';

const FENCE = /^\s*(```+|~~~+)/;
/** a sentence's end followed by space; closing quotes, brackets and emphasis go with it */
const SENTENCE_END = /[.!?…]+["'”’)\]*_`]*(?=\s)|[。！？]+/gu;
/** a clause's end followed by space: a comma, semicolon, colon or a spaced dash */
const CLAUSE_END = /[,;:]["'”’)\]*_`]*(?=\s)|[，；：、]|\s[—–](?=\s)/gu;
const LETTER = /\p{L}/u;
/** how long a reply's first piece must be before it may end at a clause break (characters) */
export const FIRST_CLAUSE_MIN = 30;
/**
 * The same for a voice that reads far away (a cloud computer's, or a computer reached through the relay): the rest of
 * the sentence has to be written, sent, read there and sent back while this piece plays, and a piece of 30 characters
 * lasts about two seconds, which a busy small computer doesn't always make (a pause in the middle of the sentence).
 */
export const FAR_CLAUSE_MIN = 60;
export const firstClauseMin = (far: boolean): number => (far ? FAR_CLAUSE_MIN : FIRST_CLAUSE_MIN);

/**
 * Where the readable part of `md` ends, from `from` on (`from` when nothing new can be read yet). `final`: the reply
 * is complete, so all of it can. `clauseMin` (the first piece): with no sentence end yet, the first clause break at
 * least that many characters on counts as one.
 */
export function speakableEnd(md: string, from: number, final: boolean, clauseMin?: number): number {
  if (final) return Math.max(from, md.length);
  let cut = from;
  let fence: string | null = null;
  let i = 0;
  while (i <= md.length) {
    const nl = md.indexOf('\n', i);
    const complete = nl !== -1;
    const end = complete ? nl : md.length;
    const line = md.slice(i, end);
    const f = FENCE.exec(line);
    if (fence) {
      // a closing fence: the same marker, at least as long, nothing after it
      if (complete && f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && !line.replace(FENCE, '').trim()) {
        fence = null;
        if (end + 1 > from) cut = end + 1;
      }
    } else if (f) {
      if (!complete) break;
      fence = f[1]!;
    } else if (complete) {
      if (end + 1 > from) cut = end + 1;
    } else if (!/^\s*\|/.test(line)) {
      // the line still being written: up to its last sentence end that has words before it
      for (const m of line.matchAll(SENTENCE_END)) {
        const at = i + m.index! + m[0].length;
        if (at > from && LETTER.test(md.slice(Math.max(i, cut), at))) cut = at;
      }
      if (clauseMin !== undefined && cut === from) {
        for (const m of line.matchAll(CLAUSE_END)) {
          const at = i + m.index! + m[0].length;
          if (at > from && md.slice(from, at).trim().length >= clauseMin && LETTER.test(md.slice(Math.max(i, from), at))) { cut = at; break; }
        }
      }
    }
    if (!complete) break;
    i = end + 1;
  }
  return cut;
}

/** The words of a piece of a reply: Markdown read as `speechText` does, with emphasis cut in half by a cut dropped. */
export function speakablePiece(md: string): string {
  return speechText(md).replace(/\*+|~~|`+/g, '').replace(/\s+/g, ' ').trim();
}
