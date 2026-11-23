/**
 * Text as Kokoro can read it. sherpa-onnx 2 reads Kokoro through its lexicon alone (no espeak-ng), and a word the
 * lexicon lacks is skipped without a sound: every number, "API", "GitHub"… So before a reading, numbers become words
 * (times, money, percentages, years, ordinals, decimals), a short all-capitals word the lexicon lacks is read letter by
 * letter, and a joined name ("GitHub", "iPhone") is split into the words it's made of when the lexicon has them all.
 * Words it still lacks (most names) stay as they are and are skipped. Pure; part of the voice host (node only).
 */

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES: [number, string][] = [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
const ORDINAL: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };

function under1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} hundred`); n %= 100; }
  if (n >= 20) parts.push(TENS[Math.floor(n / 10)]! + (n % 10 ? ` ${ONES[n % 10]}` : ''));
  else if (n > 0 || !parts.length) parts.push(ONES[n]!);
  return parts.join(' ');
}

/** 1234 → "one thousand two hundred thirty four" (whole numbers; past a trillion, digit by digit) */
export function numberWords(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n >= 1e15 || !Number.isInteger(n)) return String(n).split('').map((d) => ONES[Number(d)] ?? '').filter(Boolean).join(' ');
  if (n < 1000) return under1000(n);
  const parts: string[] = [];
  for (const [size, name] of SCALES) {
    if (n >= size) { parts.push(`${under1000(Math.floor(n / size))} ${name}`); n %= size; }
  }
  if (n) parts.push(under1000(n));
  return parts.join(' ');
}

/** 1990 → "nineteen ninety", 2026 → "twenty twenty six", 2005 → "two thousand five" */
function yearWords(y: number): string {
  if (y >= 2000 && y < 2010) return numberWords(y);
  const hi = Math.floor(y / 100), lo = y % 100;
  return `${numberWords(hi)} ${lo === 0 ? 'hundred' : lo < 10 ? `oh ${ONES[lo]}` : numberWords(lo)}`;
}

function ordinalWords(n: number): string {
  const words = numberWords(n).split(' ');
  const last = words.pop()!;
  const o = ORDINAL[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return [...words, o].join(' ');
}

/** "3.5" → "three point five"; "1,250" → "one thousand two hundred fifty" */
function decimalWords(s: string): string {
  const [int, frac] = s.replace(/,/g, '').split('.');
  const whole = numberWords(Number(int));
  return frac ? `${whole} point ${frac.split('').map((d) => ONES[Number(d)]).join(' ')}` : whole;
}

const CURRENCY: Record<string, [string, string]> = { '$': ['dollar', 'dollars'], '€': ['euro', 'euros'], '£': ['pound', 'pounds'], '₹': ['rupee', 'rupees'], '¥': ['yen', 'yen'] };

/** Numbers, money, times and percentages as words. */
export function spellNumbers(text: string): string {
  return text
    // money: $45, $1,200.50, ₹500
    .replace(/([$€£₹¥])\s?(\d[\d,]*)(?:\.(\d{1,2}))?\b/g, (_, sym: string, int: string, cents?: string) => {
      const [one, many] = CURRENCY[sym]!;
      const n = Number(int.replace(/,/g, ''));
      const main = `${numberWords(n)} ${n === 1 ? one : many}`;
      return cents && Number(cents) ? `${main} ${numberWords(Number(cents.padEnd(2, '0')))}` : main;
    })
    // times: 3:30, 10:05 pm, 9:00 a.m.
    .replace(/\b(\d{1,2}):(\d{2})(?:\s?([AaPp])\.?[Mm]\b\.?)?/g, (_, h: string, m: string, x?: string) => {
      const mm = Number(m);
      return `${numberWords(Number(h))}${mm === 0 ? (x ? '' : " o'clock") : mm < 10 ? ` oh ${ONES[mm]}` : ` ${numberWords(mm)}`}${x ? ` ${x.toLowerCase()} m` : ''}`;
    })
    // 3 pm, 11 a.m.
    .replace(/\b(\d{1,2})\s?([AaPp])\.?[Mm]\b\.?/g, (_, h: string, x: string) => `${numberWords(Number(h))} ${x.toLowerCase()} m`)
    .replace(/(\d[\d,]*(?:\.\d+)?)\s?%/g, (_, n: string) => `${decimalWords(n)} percent`)
    .replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_, n: string) => ordinalWords(Number(n)))
    // a year on its own: 1990, 2026 (not 1,990 or 2026.5)
    .replace(/(?<![\d,.])\b(1[1-9]\d\d|20\d\d)\b(?![\d,.]\d)/g, (_, y: string) => yearWords(Number(y)))
    .replace(/\b\d[\d,]*(?:\.\d+)?\b/g, (s) => decimalWords(s));
}

/**
 * Kokoro's reading of `text`: numbers as words, then each word the lexicon (`known`, lower case) lacks read as letters
 * (a short all-capitals word) or as the words it joins ("GitHub" → "Git Hub").
 */
export function kokoroText(text: string, known: (word: string) => boolean): string {
  return spellNumbers(text).replace(/[A-Za-z][A-Za-z'’]*/g, (w) => {
    if (known(w.toLowerCase().replace(/’/g, "'"))) return w;
    const bare = w.replace(/['’]s$/i, '');
    if (bare !== w && known(bare.toLowerCase())) return w;
    // API, PDFs
    if (/^[A-Z]{2,6}s?$/.test(bare)) return bare.replace(/(?<=[A-Z])s$/, '').split('').join(' ');
    const parts = bare.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
    if (parts.length > 1 && parts.every((p) => known(p.toLowerCase()) || /^[A-Z]$/.test(p))) return parts.join(' ');
    return w;
  });
}
