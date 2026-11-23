/**
 * Speech: what a reply sounds like when read aloud (voice mode, Telegram voice notes), shared by every client.
 * `speechText` keeps the words a listener needs from Markdown; `speechChunks` cuts them into parts a voice model
 * reads one after the other (the first short, so the voice starts soon); `speechLanguage` guesses which of the
 * voice's languages a text is in.
 */
import type { SpeechLanguage } from '@appubot/protocol';

/** The first part is short, so the first words play soon; later parts may grow, each at most `PART_MAX`. */
export const SPEECH_FIRST_PART_MIN = 40;
export const SPEECH_FIRST_PART_MAX = 80;
export const SPEECH_PART_MAX = 400;
export const SPEECH_PART_GROWTH = 3;

/** One line of Markdown as the words a listener needs ('' when it carries none). */
function speechLine(raw: string): string {
  if (/^\s*\|/.test(raw)) return '';
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) return '';
  let s = raw
    .replace(/<\/?[a-zA-Z][^>]*>|<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s)>\]]+/g, ' ')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*(>\s*)+/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(^|[\s(])@(?=[\p{L}\p{N}_])/gu, '$1')
    .replace(/(?<![\w*])(\*\*|~~)(?=\S)(.+?)(?<=\S)\1(?![\w*])/gu, '$2')
    .replace(/(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)/gu, '$1')
    .replace(/(?<![\w*])\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*(?![\w*])/gu, '$1')
    .replace(/(?<![\w_])_(?=[^\s_])([^_]+?)(?<=[^\s_])_(?![\w_])/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  // a bullet left alone on its line or a stray marker says nothing
  if (!/[\p{L}\p{N}]/u.test(s)) return '';
  if (!/[.!?…。！？:;,]$/.test(s)) s += '.';
  return s;
}

/** The words of a Markdown reply that a listener needs: no code, tables, images or addresses; a link reads as its text. */
export function speechText(markdown: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && !line.replace(/^\s*(```+|~~~+)/, '').trim()) fence = null;
      continue;
    }
    if (f) { fence = f[1]!; continue; }
    const s = speechLine(line);
    if (s) out.push(s);
  }
  return out.join(' ');
}

/** Sentences of a text, by the locale's own rules where the runtime has them. */
function sentences(text: string, locale: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  let segmenter: Intl.Segmenter | undefined;
  try { segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(locale, { granularity: 'sentence' }) : undefined; } catch { segmenter = undefined; }
  const raw = segmenter
    ? Array.from(segmenter.segment(clean), (x) => x.segment)
    : clean.match(/[^.!?…。！？]+(?:[.!?…。！？]+["')\]]*\s*|$)/gu) ?? [clean];
  return raw.map((s) => s.trim()).filter(Boolean);
}

/** the end of a clause inside a sentence: a comma, semicolon or colon before a space (the mark stays with what came before) */
const CLAUSE_END = /[,;:](?= )|[、，；：]/g;
/** a cut never leaves less than this after it: a few words read as a part of their own sound like an afterthought */
const CUT_TAIL_MIN = 12;

/**
 * Cut a sentence that is over `limit`. The voice reads every part as a line of its own, so a cut is only made where a
 * speaker pauses anyway, at the end of a clause: the last one that fits `limit` (past half of it), else the first one
 * after it. A sentence with no such place is read whole (`rest` empty), and only one over `SPEECH_PART_MAX` is cut
 * at a space, or hard. Before 2026-11-14 it was cut at any space past half of `limit`, and "…the largest city in the
 * whole" was read as a finished line, a pause, then "world." as the next.
 */
function cutAt(s: string, limit: number): [string, string] {
  const ends = Array.from(s.matchAll(CLAUSE_END), (m) => m.index! + m[0].length).filter((e) => e <= SPEECH_PART_MAX && s.length - e >= CUT_TAIL_MIN);
  let at = -1;
  for (const e of ends) if (e > limit / 2 && e <= limit) at = e;
  if (at < 0) at = ends.find((e) => e > limit) ?? -1;
  if (at < 0) {
    if (s.length <= SPEECH_PART_MAX) return [s, ''];
    const sp = s.lastIndexOf(' ', SPEECH_PART_MAX);
    at = sp > SPEECH_PART_MAX / 2 ? sp : SPEECH_PART_MAX;
  }
  return [s.slice(0, at).trim(), s.slice(at).trim()];
}

/**
 * The words as parts a voice reads one after the other. `after`: the length of the part read before these (a reply
 * read as it streams: what is queued already); without it these are a reading's first words, so the first part is
 * short and the voice starts soon. A part may be `SPEECH_PART_GROWTH` times the one before it (it is made while that
 * one plays), up to `SPEECH_PART_MAX`. A computer that reads all the parts into one recording has nothing waiting on
 * the first one: `after: Infinity` gives parts of whole sentences, as large as they may be.
 */
export function speechChunks(text: string, locale = 'en', o: { after?: number } = {}): string[] {
  const parts: string[] = [];
  let cur = '';
  let prev = o.after;
  const limit = () => (prev === undefined ? SPEECH_FIRST_PART_MAX : Math.min(SPEECH_PART_MAX, Math.max(SPEECH_FIRST_PART_MAX, prev * SPEECH_PART_GROWTH)));
  const flush = () => { if (cur) { parts.push(cur); prev = cur.length; } cur = ''; };
  for (let s of sentences(text, locale)) {
    while (s) {
      const lim = limit();
      if (!cur) {
        if (s.length <= lim) { cur = s; s = ''; } else { const [head, rest] = cutAt(s, lim); cur = head; flush(); s = rest; }
      } else if (cur.length + 1 + s.length <= lim) { cur += ` ${s}`; s = ''; }
      else flush();
    }
    if (prev === undefined && cur.length >= SPEECH_FIRST_PART_MIN) flush();
  }
  flush();
  return parts.filter(Boolean);
}

const words = (s: string) => new Set(s.split(/\s+/));

/** Frequent short words per Latin-script language (all lowercase). */
const WORDS: Record<string, Set<string>> = {
  en: words('the and is are you to of in it that this for with was have not what your can will i be on'),
  es: words('el la los las de que y en un una es por con para no se qué está están del al lo como pero más muy'),
  fr: words('le la les des et est un une que qui dans pour pas vous je nous il elle sont avec ce cette du au ne'),
  de: words('der die das und ist nicht ich sie es ein eine mit für auf den dem zu von wir du auch sind'),
  it: words('il lo la gli le di che è un una per non con sono come ma più anche questo del della nel ho'),
  pt: words('o a os as de que e em um uma é para com não se por mais como mas está estão do da no na foi'),
  nl: words('de het een en van is dat niet ik je we zijn voor met op te ook maar dit wat er aan'),
  id: words('yang dan di ini itu dengan untuk tidak dari ke ada akan saya kamu adalah pada juga atau sudah'),
  tr: words('ve bir bu için ile değil ben sen çok da de ne var daha gibi ama mi çünkü olarak'),
  pl: words('i w nie na to się z że jest do jak ale co tak po dla czy jestem są jego tylko'),
  cs: words('a je se na to že v s z do ne jsem jsou ale jak pro tak už který by být'),
  ro: words('și de la în cu un o este nu că pe pentru care mai sunt dar ce sau am acest foarte'),
  sv: words('och att det som en är på för med inte jag du har av den till om var ett men'),
  da: words('og at det som en er på for med ikke jeg du har af den til om var et men der'),
  fi: words('ja on ei että se oli ovat minä sinä mutta tai kun jos niin olen kuin vain tämä'),
  hu: words('a az és hogy nem van egy is meg de ez volt mint csak már vagy még én te'),
  vi: words('và là của có không một những các được trong cho này với tôi bạn đã ở như'),
  et: words('ja on ei et see oli ma sa aga või kui siis olen kuid ka veel mis kõik'),
  lt: words('ir yra kad ne tai aš tu bet su kaip kas jis ji buvo ar tik dar labai'),
  lv: words('un ir ka nav tas es tu bet ar kā kas viņš viņa bija vai tikai vēl ļoti'),
  sk: words('a je sa na to že v s z do nie som sú ale ako pre tak už ktorý by byť'),
  sl: words('in je se na to da v s z do ne sem so ampak kot za tako že ki bi biti'),
  hr: words('i je se na to da u s z do ne sam su ali kao za tako već koji bi biti'),
};

/** Letters only some languages use: each occurrence counts as two matched words (one, where it is common to several). */
const LETTERS: [string, string[], number][] = [
  ['ãõ', ['pt'], 2], ['õ', ['et'], 1],
  ['ñ¿¡', ['es'], 2],
  ['ß', ['de'], 2], ['äöü', ['de'], 1], ['ä', ['sv', 'fi', 'et'], 1], ['ö', ['sv', 'fi', 'et', 'hu'], 1], ['ü', ['et', 'tr', 'hu'], 1],
  ['ıİğş', ['tr'], 2],
  ['łąęśżź', ['pl'], 2],
  ['řěů', ['cs'], 2],
  ['ățșâî', ['ro'], 2],
  ['å', ['sv', 'da'], 2],
  ['őű', ['hu'], 2],
  ['đơưẠ-ỹ', ['vi'], 2],
  ['ėųį', ['lt'], 2],
  ['āēīūķļņ', ['lv'], 2],
];

const LETTER_SCORES = (() => {
  const m = new Map<string, [string, number][]>();
  for (const [chars, langs, w] of LETTERS) {
    const list = chars.replace(/(.)-(.)/gu, (_a, from: string, to: string) => {
      let r = '';
      for (let c = from.codePointAt(0)!; c <= to.codePointAt(0)!; c++) r += String.fromCodePoint(c);
      return r;
    });
    for (const ch of list) m.set(ch, [...(m.get(ch) ?? []), ...langs.map((l) => [l, w] as [string, number])]);
  }
  return m;
})();

/** Which of the voice's languages a text is in, by script and frequent short words; `fallback` when it can't tell. */
export function speechLanguage(text: string, fallback: SpeechLanguage = 'en'): SpeechLanguage {
  const count = (re: RegExp) => text.match(re)?.length ?? 0;
  const n = {
    latin: count(/\p{Script=Latin}/gu), cyrillic: count(/\p{Script=Cyrillic}/gu), devanagari: count(/\p{Script=Devanagari}/gu),
    arabic: count(/\p{Script=Arabic}/gu), greek: count(/\p{Script=Greek}/gu), kana: count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu),
    hangul: count(/\p{Script=Hangul}/gu), other: count(/[\p{Script=Han}\p{Script=Thai}\p{Script=Hebrew}\p{Script=Armenian}\p{Script=Georgian}\p{Script=Bengali}\p{Script=Tamil}]/gu),
  };
  // Japanese is mostly Han with some kana: any kana at all means Japanese
  const cjk = n.kana ? n.kana + n.other : n.other;
  const top = Math.max(n.latin, n.cyrillic, n.devanagari, n.arabic, n.greek, cjk, n.hangul);
  if (top === 0) return fallback;
  if (n.kana && cjk === top) return 'ja';
  if (n.hangul === top) return 'ko';
  if (n.devanagari === top) return 'hi';
  if (n.arabic === top) return 'ar';
  if (n.greek === top) return 'el';
  if (n.cyrillic === top) {
    if (/[іїєґ]/iu.test(text)) return 'uk';
    if (/ъ/iu.test(text) && !/[ыэ]/iu.test(text)) return 'bg';
    return 'ru';
  }
  if (cjk === top) return fallback;

  const score: Record<string, number> = {};
  const add = (l: string, v: number) => { score[l] = (score[l] ?? 0) + v; };
  const lower = text.toLowerCase();
  for (const w of lower.match(/\p{L}+/gu) ?? []) for (const l in WORDS) if (WORDS[l]!.has(w)) add(l, 1);
  for (const ch of lower) for (const [l, w] of LETTER_SCORES.get(ch) ?? []) add(l, w);
  let best = '';
  let bestScore = 0;
  let tie = false;
  for (const l in score) {
    if (score[l]! > bestScore) { best = l; bestScore = score[l]!; tie = false; } else if (score[l] === bestScore) tie = true;
  }
  return !best || tie ? fallback : (best as SpeechLanguage);
}
