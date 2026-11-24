/*
 * How the ⌘K palette (QuickSwitcher) matches and ranks what you type, ported in spirit from T3 Code's palette search
 * (MIT; packages/shared/src/paletteSearch.ts), cut down to what AppuBot's palette lists.
 *
 * A query is split into words, each of which must be found in a row: at the start of a word in its name ("set" in
 * "Settings", "gst" in "Acme invoice and GST templates"; camelCase and digit boundaries count), inside a word only for
 * four or more letters ("voice" in "Invoices"), or, when nothing matches at a word start anywhere, with one typo
 * ("setings"). The old palette matched any substring of the name, the job or the latest message, so "se" listed a bot
 * because its last message said "September" (2026-11-24). Case and accents are ignored; the ranges matched in a row's
 * name come back for highlighting.
 *
 * Rows rank by how well they match (the whole name, a whole word, a word's start, inside a word, a typo), then by
 * whether you picked them for this query before (`pickedFor`), then by how recently they were used. Groups (Bots,
 * Threads, Actions…) keep their order unless one holds a clearly better match, so the list doesn't jump while typing.
 */

const ALNUM = /[\p{L}\p{N}]/u;
const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;
const DIGIT = /\p{N}/u;
const LETTER = /\p{L}/u;
const MARKS = /\p{M}/gu;
const APOSTROPHE = /['’]/;

export interface SearchRange {
  start: number;
  end: number;
}

interface Field {
  /** case and accents folded, one UTF-16 unit for each of the source's, so ranges index the source as it is */
  text: string;
  /** 1 where a word starts */
  starts: Uint8Array;
}

/** `text` with case and accents folded unit for unit ("Café" → "cafe"); a letter that folds to more stays as it is. */
export function fold(text: string): string {
  return text
    .replace(/[\u0080-\uffff]/g, (c) => {
      const f = c.normalize('NFKD').replace(MARKS, '').toLowerCase().replace(/[‘’]/, "'");
      return f.length === 1 ? f : c;
    })
    .toLowerCase();
}

/** The query as it is matched: folded, without wrapping quotes, words separated by one space ('' for nothing). */
export function foldQuery(query: string): string {
  return fold(query.replace(/^\s*["'“”‘’]+|["'“”‘’]+\s*$/g, '').normalize('NFC')).split(/\s+/).filter(Boolean).join(' ');
}

// Chinese and Japanese have no spaces: each ideograph or kana starts a word
function isCjk(c: string): boolean {
  const code = c.charCodeAt(0);
  return (code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff);
}

function startsWord(before: string, prev: string, c: string, next: string): boolean {
  if (!ALNUM.test(c)) return false;
  // "Sarthak’s": a possessive doesn't start a word
  if (APOSTROPHE.test(prev) && ALNUM.test(before)) return false;
  return prev === '' || !ALNUM.test(prev) || (LOWER.test(prev) && UPPER.test(c))
    // the last capital of an acronym starts the next word: "GSTReturn"
    || (UPPER.test(prev) && UPPER.test(c) && LOWER.test(next))
    || DIGIT.test(prev) !== DIGIT.test(c) || isCjk(c);
}

// names repeat on every keystroke: folded once
const fields = new Map<string, Field>();
const FIELD_CACHE = 5000;

function field(source: string): Field {
  const hit = fields.get(source);
  if (hit) return hit;
  if (fields.size >= FIELD_CACHE) fields.delete(fields.keys().next().value!);
  const starts = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i++) {
    if (startsWord(source[i - 2] ?? '', source[i - 1] ?? '', source[i]!, source[i + 1] ?? '')) starts[i] = 1;
  }
  const f = { text: fold(source), starts };
  fields.set(source, f);
  return f;
}

/** a word typed whole */
const WHOLE = 1;
/** the whole name typed: above any word of it */
const WHOLE_NAME = 1.5;
const MID_WORD = 0.3;
const TYPO = 0.45;

interface TokenMatch extends SearchRange {
  score: number;
}

/** One edit apart: a letter changed, added or left out, or two neighbours swapped (`swapOnly`: only that). */
export function withinOneEdit(a: string, b: string, swapOnly = false): boolean {
  if (Math.abs(a.length - b.length) > (swapOnly ? 0 : 1)) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const x = a.slice(i);
  const y = b.slice(i);
  const swapped = x.length > 1 && x[0] === y[1] && x[1] === y[0] && x.slice(2) === y.slice(2);
  if (swapOnly) return swapped;
  return swapped || x === y || x.slice(1) === y.slice(1) || x.slice(1) === y || x === y.slice(1);
}

function matchToken(f: Field, token: string, typos: boolean, midWord: boolean): TokenMatch | null {
  const len = f.text.length;
  let best: TokenMatch | null = null;
  // a token that opens with punctuation (".pdf") brings its own boundary
  const ownBoundary = !ALNUM.test(token[0]!);
  for (let i = f.text.indexOf(token); i !== -1; i = f.text.indexOf(token, i + 1)) {
    if (f.starts[i] || ownBoundary) {
      const end = i + token.length;
      const whole = end >= len || f.starts[end] === 1 || !ALNUM.test(f.text[end]!);
      let run = end;
      while (run < len && ALNUM.test(f.text[run]!)) run++;
      // a prefix counts more the more of its word it covers
      const score = whole ? WHOLE : 0.7 + (0.2 * token.length) / (run - i);
      if (!best || score > best.score) best = { score, start: i, end };
      if (score === WHOLE) return best;
    } else if (midWord && token.length >= 4 && !best) {
      best = { score: MID_WORD, start: i, end: i + token.length };
    }
  }
  if ((best && best.score > MID_WORD) || !typos || token.length < 3 || !LETTER.test(token)) return best;
  for (let i = 0; i < len; i++) {
    if (!f.starts[i]) continue;
    // people rarely get the first letter wrong, unless they swap the first two of a longer word
    const first = f.text[i];
    if (first !== token[0] && !(token.length > 3 && first === token[1] && f.text[i + 1] === token[0])) continue;
    let run = i + 1;
    while (run < len && ALNUM.test(f.text[run]!)) run++;
    const word = f.text.slice(i, run);
    // a three- or four-letter word forgives only a swap or one letter more ("cron" would find every "con…")
    const short = token.length <= 4;
    for (const n of short ? [token.length, token.length + 1] : [token.length, token.length - 1, token.length + 1]) {
      if (n > word.length) continue;
      if (withinOneEdit(token, word.slice(0, n), short && n === token.length)) return { score: TYPO, start: i, end: i + n };
    }
  }
  return best;
}

/** a field of a row: its name first, then what else it can be found by */
export interface SearchField {
  value: string;
  weight: number;
  /** only a match at a word's start counts, and no typo: words you can't see on the row must not match loosely */
  keyword?: boolean;
  /** a word of four or more letters may match inside a word (chats' names only: "arch" in "Search" reads as junk) */
  midWord?: boolean;
}

export interface SearchMatch {
  /** about 0.3 (inside a word) to 1.5 (the whole name) */
  quality: number;
  /** what the row's group ranks by: lower than `quality` when only words the row doesn't show matched */
  groupQuality: number;
  /** every word matched at a word's start, without a typo */
  strong: boolean;
  /** what matched in the name, for highlighting */
  ranges: SearchRange[];
}

// words a phrase carries that a name may leave out ("the gst templates")
const FILLER = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to', 'with']);
/** below this a query matches only a keyword it equals: "co" would find most of them */
const KEYWORD_MIN = 4;
const KEYWORD_QUALITY = 0.65;

function mergeRanges(ranges: readonly SearchRange[]): SearchRange[] {
  const out: SearchRange[] = [];
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/**
 * How well a folded query (`foldQuery`) matches a row's fields, or null when a word of it is in none of them. A
 * keyword counts less than the name, and for a short query only when typed whole ("pr", "qr").
 */
export function matchFields(query: string, fieldsOf: readonly SearchField[], opts: { typos?: boolean } = {}): SearchMatch | null {
  const tokens = query.split(' ').filter(Boolean);
  if (!tokens.length || !fieldsOf.length) return null;
  const fillerOptional = tokens.some((t) => !FILLER.has(t));
  const meaningful = tokens.filter((t) => !FILLER.has(t)).join(' ') || query;
  const short = meaningful.length < KEYWORD_MIN;
  const name = fieldsOf[0]!.value ? field(fieldsOf[0]!.value) : null;
  const ranges: SearchRange[] = [];
  let total = 0;
  let counted = 0;
  let strong = true;
  for (const token of tokens) {
    let best = 0;
    let atStart = false;
    for (const [n, f] of fieldsOf.entries()) {
      if (!f.value) continue;
      const m = matchToken(field(f.value), token, !!opts.typos && !f.keyword, !!f.midWord);
      if (!m) continue;
      if (f.keyword && m.score < (short ? WHOLE : 0.7)) continue;
      if (n === 0) ranges.push(m);
      if (m.score >= 0.7) atStart = true;
      // a short keyword typed whole is deliberate: above a mere prefix of a name
      const weight = f.keyword && short ? Math.max(f.weight, 0.8) : f.weight;
      best = Math.max(best, m.score * weight);
    }
    if (!best) {
      if (fillerOptional && FILLER.has(token)) continue;
      return null;
    }
    strong &&= atStart;
    total += best;
    counted++;
  }
  if (!counted) return null;
  let quality = total / counted;
  if (name?.text === query) quality += WHOLE_NAME - WHOLE;
  else if (tokens.length > 1 && name?.text.includes(query)) quality += 0.25;
  const merged = mergeRanges(ranges);
  // found only by what the row doesn't show: never puts its group above one whose names match
  return { quality, groupQuality: merged.length ? quality : Math.min(quality, KEYWORD_QUALITY), strong, ranges: merged };
}

/** whole words and prefixes share a class, so a long name's prefix isn't pushed under a short one's whole word */
export function matchClass(quality: number): number {
  return quality >= WHOLE_NAME ? 3 : quality >= 0.7 ? 2 : quality >= 0.4 ? 1 : 0;
}

export interface Ranked<T> {
  item: T;
  match: SearchMatch;
}

/**
 * Every group's matching rows, best first, and the groups in the order given unless one holds a better class of
 * match. Typos are tried only when nothing matched at a word start: beside real matches they're noise.
 *
 * `pickedAt` is when the row was last picked for a query like this one (`pickedFor`), `usedAt` when it was last used
 * (its latest message): within a class of match a pick comes first, then a whole word, then the closer match, then the
 * more recent.
 */
export function rankGroups<G, T>(
  groups: readonly { group: G; items: readonly T[] }[],
  score: (item: T, typos: boolean) => SearchMatch | null,
  use: (item: T) => { pickedAt?: number; usedAt?: number } = () => ({}),
): { group: G; ranked: Ranked<T>[] }[] {
  const run = (typos: boolean) => groups.map(({ group, items }) => ({
    group,
    ranked: items.flatMap((item) => { const match = score(item, typos); return match ? [{ item, match }] : []; }),
  }));
  let all = run(false);
  if (!all.some((g) => g.ranked.some((r) => r.match.strong))) all = run(true);
  return all
    .flatMap(({ group, ranked }, order) => {
      if (!ranked.length) return [];
      const sorted = ranked
        .map((r) => ({ ...r, use: use(r.item) }))
        .sort((a, b) =>
          matchClass(b.match.quality) - matchClass(a.match.quality)
          || (b.use.pickedAt ?? 0) - (a.use.pickedAt ?? 0)
          || Number(b.match.quality >= WHOLE) - Number(a.match.quality >= WHOLE)
          || b.match.quality - a.match.quality
          || (b.use.usedAt ?? 0) - (a.use.usedAt ?? 0))
        .map(({ item, match }) => ({ item, match }));
      const best = Math.max(...ranked.map((r) => matchClass(r.match.groupQuality)));
      return [{ group, ranked: sorted, best, order }];
    })
    .sort((a, b) => b.best - a.best || a.order - b.order)
    .map(({ group, ranked }) => ({ group, ranked }));
}

export interface TextPart {
  text: string;
  hit: boolean;
}

/** `text` cut at sorted, separate `ranges` into plain and matched parts, for highlighting. */
export function splitByRanges(text: string, ranges: readonly SearchRange[]): TextPart[] {
  const out: TextPart[] = [];
  let at = 0;
  for (const r of ranges) {
    if (r.start > at) out.push({ text: text.slice(at, r.start), hit: false });
    if (r.end > Math.max(r.start, at)) out.push({ text: text.slice(Math.max(r.start, at), r.end), hit: true });
    at = Math.max(at, r.end);
  }
  if (at < text.length || !out.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/** a word shorter than this must start a word in a message: "gst" is no match in "angsty" */
const MESSAGE_WORD_START = 4;
/** what a one- or two-letter word would find in messages is noise */
const MESSAGE_TOKEN_MIN = 3;

export interface MessageHit {
  /** 1 when every word is whole there, less for a word's start (0.8) or inside one (0.3) */
  quality: number;
  /** a line of the message around the match, and the matched words in it */
  snippet: string;
  ranges: SearchRange[];
}

/**
 * Finds a query's words in messages (every word of three or more letters must be in one; shorter words are left
 * out), or null when the query has no such word. Messages are long and many, so they skip the field cache.
 */
export function messageMatcher(query: string, width = 90): ((text: string) => MessageHit | null) | null {
  const tokens = foldQuery(query).split(' ').filter((t) => t.length >= MESSAGE_TOKEN_MIN);
  if (!tokens.length) return null;
  return (text) => {
    const folded = fold(text);
    let quality = 1;
    const hits: SearchRange[] = [];
    for (const token of tokens) {
      let best = 0;
      let at = -1;
      for (let i = folded.indexOf(token); i !== -1; i = folded.indexOf(token, i + 1)) {
        const start = !ALNUM.test(token[0]!) || startsWord(text[i - 2] ?? '', text[i - 1] ?? '', text[i]!, text[i + 1] ?? '');
        const end = i + token.length;
        const whole = end >= text.length || !ALNUM.test(text[end]!) || startsWord(text[end - 2] ?? '', text[end - 1] ?? '', text[end]!, text[end + 1] ?? '');
        const q = start ? (whole ? 1 : 0.8) : token.length >= MESSAGE_WORD_START ? MID_WORD : 0;
        if (q > best) { best = q; at = i; }
        if (best === 1) break;
      }
      if (!best) return null;
      quality = Math.min(quality, best);
      hits.push({ start: at, end: at + token.length });
    }
    // the line starts a little before the first word found, at a word's start
    const first = Math.min(...hits.map((h) => h.start));
    let from = Math.max(0, first - Math.floor(width / 4));
    while (from > 0 && from < first && ALNUM.test(text[from - 1]!)) from++;
    const lead = from > 0 ? '…' : '';
    // one line: every whitespace (newlines too) a space, so each match stays where it was
    const snippet = lead + text.slice(from, from + width).replace(/\s/g, ' ');
    const shift = lead.length - from;
    const ranges = mergeRanges(hits.filter((h) => h.end <= from + width).map((h) => ({ start: h.start + shift, end: h.end + shift })));
    return { quality, snippet, ranges };
  };
}

/** a pick of a row for a query: the palette remembers a few (paletteRecent.ts) */
export interface PalettePick {
  key: string;
  at: number;
  /** the query (folded) it was picked for; '' from the list without one */
  query: string;
}

/**
 * When `key` was last picked for this folded query: for the same query, or for a longer one this query starts (from
 * three letters: "le" is too little to go on), so a row picked for "ledger" leads again as you type "led".
 */
export function pickedFor(picks: readonly PalettePick[], key: string, query: string): number | undefined {
  let at: number | undefined;
  for (const p of picks) {
    if (p.key !== key || !p.query) continue;
    if (p.query === query || (query.length >= 3 && p.query.startsWith(query))) at = Math.max(at ?? 0, p.at);
  }
  return at;
}
