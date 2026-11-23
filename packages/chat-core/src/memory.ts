/**
 * A bot's memory: `MEMORY.md` in its folder, what it keeps across its threads (each thread is its own agent session
 * and starts without the others' conversation). The bot adds to it with `remember` (one dated line each), changes or
 * drops entries with `update_memory` / `forget`, and the user edits it in the bot editor. A new session's first prompt
 * carries it (`memoryPreface`), capped to `MEMORY_LOAD_MAX` characters with the newest lines kept, so it works the same
 * for every agent (Claude Code, Codex, …) and editing it never restarts a running session.
 *
 * Pure text in, text out: the Mac does the file I/O (BotsService), the apps show the numbers.
 */
import { MEMORY_LOAD_MAX } from '@appubot/protocol';
import { bytes } from './format';

/** How much of the memory a new thread's first prompt carries (characters): the head and the newest lines (the protocol's). */
export { MEMORY_LOAD_MAX };
export const MEMORY_FILE = 'MEMORY.md';
/** The longest single entry `remember` / `update_memory` takes (characters): memories are short facts. */
export const MEMORY_ENTRY_MAX = 500;
/** Of `MEMORY_LOAD_MAX`, at most this much goes to the lines at the top (the title, notes the user pinned there). */
const HEAD_MAX = 2_000;

const INTRO = 'Durable facts and preferences learned while working with the user.';

/** A fresh memory file (a new bot's, or one cleared in the bot editor). */
export function memoryTemplate(botName: string): string {
  return `# Memory - ${botName}\n\n${INTRO}\n\n`;
}

/** Nothing in it but headings, blank lines and the template's intro line. */
export function memoryIsEmpty(memory: string): boolean {
  return memory.split('\n').every((l) => {
    const t = l.trim();
    return !t || t.startsWith('#') || t === INTRO;
  });
}

/** Lines that hold a fact (`- …`, `* …`, `1. …`), not headings or blank lines. */
const isEntry = (line: string): boolean => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line);
const isHeading = (line: string): boolean => /^\s*#/.test(line);

/** One line, collapsed whitespace, no leading bullet. */
export function cleanEntry(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/^(?:[-*+]|\d+[.)])\s+/, '').trim();
}

/** What a line says, for spotting repeats: no bullet, no `[date]`, case and punctuation at the ends ignored. */
export function entryKey(line: string): string {
  return cleanEntry(line).replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '').toLowerCase().replace(/[\s.!;,]+$/, '').trim();
}

/** A memory entry as `remember` writes it: `- [YYYY-MM-DD] text`. */
export function memoryEntry(text: string, day: string): string {
  return `- [${day}] ${cleanEntry(text)}`;
}

const withNewline = (s: string): string => (s && !s.endsWith('\n') ? `${s}\n` : s);

/** Adds an entry at the end (newest last), unless the memory already says the same thing. */
export function appendMemory(memory: string, text: string, day: string): { memory: string; added: boolean; entry: string } {
  const entry = memoryEntry(text, day);
  const key = entryKey(entry);
  if (memory.split('\n').some((l) => l.trim() && !isHeading(l) && entryKey(l) === key)) return { memory, added: false, entry };
  return { memory: `${withNewline(memory)}${entry}\n`, added: true, entry };
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** The lines (not headings) that contain `find`, ignoring case and runs of spaces. */
export function findInMemory(memory: string, find: string): { index: number; line: string }[] {
  const needle = norm(find);
  if (!needle) return [];
  return memory.split('\n').flatMap((line, index) => (line.trim() && !isHeading(line) && norm(line).includes(needle) ? [{ index, line }] : []));
}

export type MemoryEdit =
  | { ok: true; memory: string; removed: string[]; added?: string }
  | { ok: false; reason: 'none' | 'many'; matches: string[] };

/**
 * Replaces the one line that contains `find` with a new dated entry (`text`), or removes it when `text` is empty.
 * Fails when no line or more than one line matches (the caller says which, so the bot can be more precise).
 */
export function replaceInMemory(memory: string, find: string, text: string, day: string): MemoryEdit {
  const hits = findInMemory(memory, find);
  if (hits.length !== 1) return { ok: false, reason: hits.length ? 'many' : 'none', matches: hits.map((h) => h.line.trim()) };
  const lines = memory.split('\n');
  const hit = hits[0]!;
  const next = cleanEntry(text);
  if (!next) {
    lines.splice(hit.index, 1);
    return { ok: true, memory: lines.join('\n'), removed: [hit.line.trim()] };
  }
  // keep the line's own indent, so an entry nested under another stays there
  const indent = /^\s*/.exec(hit.line)?.[0] ?? '';
  const added = memoryEntry(next, day);
  lines[hit.index] = `${indent}${added}`;
  return { ok: true, memory: lines.join('\n'), removed: [hit.line.trim()], added };
}

/** Removes every line (not headings) that contains `text`. */
export function forgetInMemory(memory: string, text: string): { memory: string; removed: string[] } {
  const hits = findInMemory(memory, text);
  if (!hits.length) return { memory, removed: [] };
  const drop = new Set(hits.map((h) => h.index));
  return { memory: memory.split('\n').filter((_, i) => !drop.has(i)).join('\n'), removed: hits.map((h) => h.line.trim()) };
}

/**
 * The memory cut to `max` characters for a new session: the lines at the top until the first entry (its title and
 * anything the user pinned there, up to a sixth of it) and then as many of the last lines as fit, the newest
 * entries being at the end. `omitted` counts the lines left out in between.
 */
export function capMemory(memory: string, max = MEMORY_LOAD_MAX): { text: string; omitted: number } {
  const text = memory.trim();
  if (text.length <= max) return { text, omitted: 0 };
  const lines = text.split('\n');
  const headMax = Math.min(HEAD_MAX, Math.floor(max / 6));
  const head: string[] = [];
  let used = 0;
  let i = 0;
  for (; i < lines.length && !isEntry(lines[i]!); i++) {
    const cost = lines[i]!.length + 1;
    if (used + cost > headMax) break;
    head.push(lines[i]!);
    used += cost;
  }
  const marker = (n: number) => `[… ${n} older line${n === 1 ? '' : 's'} left out: read_memory shows all of it …]`;
  const room = max - used - marker(lines.length).length - 2;
  const tail: string[] = [];
  let tailUsed = 0;
  for (let j = lines.length - 1; j >= i; j--) {
    const line = lines[j]!.length > room ? `${lines[j]!.slice(0, Math.max(0, room - 2))}…` : lines[j]!;
    const cost = line.length + 1;
    if (tailUsed + cost > room) break;
    tail.unshift(line);
    tailUsed += cost;
  }
  const omitted = lines.length - head.length - tail.length;
  return { text: [...head, marker(omitted), ...tail].join('\n'), omitted };
}

/**
 * What a fresh agent session's first prompt opens with: the bot's memory (capped, see `capMemory`), so a new thread
 * knows what earlier ones learned. Null when the memory holds nothing yet.
 */
export function memoryPreface(memory: string, o: { botName: string; max?: number }): string | null {
  if (memoryIsEmpty(memory)) return null;
  const { text, omitted } = capMemory(memory, o.max);
  const cut = omitted ? ` It is long, so ${omitted} older line${omitted === 1 ? ' is' : 's are'} left out here (read_memory shows all of it).` : '';
  return [
    '<memory>',
    `This is ${o.botName}'s memory (MEMORY.md in your folder): what you learned about the user and their work in earlier threads. This thread starts fresh, without those conversations, so rely on it. Keep it current with remember, update_memory and forget.${cut}`,
    '',
    text,
    '</memory>',
  ].join('\n');
}

/**
 * Facts in a reply to AppuBot's "anything to remember?" turn (see the desktop's `renderMemorySavePrompt`): its
 * bulleted lines, cleaned, at most `max`; none when it said NONE or listed nothing.
 */
export function parseMemoryFacts(reply: string, max = 8): string[] {
  if (/^\s*none\.?\s*$/i.test(reply)) return [];
  return reply
    .split('\n')
    .filter(isEntry)
    .map(cleanEntry)
    .filter((t) => t && t.length <= MEMORY_ENTRY_MAX && !/^none\.?$/i.test(t))
    .slice(0, max);
}

/** What the bot editors and memory panels say about a bot's memory: its facts, its size, whether it all loads. */
export interface MemoryStats {
  empty: boolean;
  /** bullet lines (`- …`, `* …`, `1. …`): one fact each */
  entries: number;
  size: string;
  /** longer than a new thread's first prompt carries: only the newest part loads */
  overCap: boolean;
}

export function memoryStats(memory: string): MemoryStats {
  return {
    empty: memoryIsEmpty(memory),
    entries: memory.split('\n').filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l)).length,
    size: bytes(new TextEncoder().encode(memory).length),
    overCap: memory.trim().length > MEMORY_LOAD_MAX,
  };
}

/** "12 KB", for the cap note */
export const MEMORY_CAP_LABEL = `${Math.round(MEMORY_LOAD_MAX / 1000)} KB`;

/** "3 entries · 1.2 KB", with the cap note once only the newest part loads */
export function memoryStatsLine(st: MemoryStats): string {
  if (st.empty) return '';
  return `${st.entries} entr${st.entries === 1 ? 'y' : 'ies'} · ${st.size}${st.overCap ? ` · only the newest ${MEMORY_CAP_LABEL} load` : ''}`;
}
