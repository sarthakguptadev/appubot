/**
 * A thread's conversation (Akeru's bot chat, a messaging bot): what the Mac and both clients must agree on about it:
 * the order of its messages, the pages its history is read in, the separators that mark where a sitting resumes, and
 * the recent stretch a thread's replacement agent session is primed with when its own can't be resumed (Akeru's
 * RecentConversation, MIT). A bot has many threads; what carries over between them is its memory (`memory.ts`).
 */
import type { Message, Part } from '@appubot/protocol';
import { basename, clockTime, truncate } from './format';
import { splitFileLines } from './message';
import { sentenceText, toolSentence, type ToolCallPart } from './toolText';

/* ------------------------------------------------------------------ order */

type Ordered = Pick<Message, 'createdAt' | 'role' | 'id'>;
const rank = (m: Pick<Message, 'role'>) => (m.role === 'user' ? 0 : 1);

/**
 * Conversation order: by time; a prompt goes before a reply stamped the same millisecond (older data), then by id
 * (code points, so every platform agrees).
 */
export function compareMessages(a: Ordered, b: Ordered): number {
  return a.createdAt - b.createdAt || rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Where a page of history ends: the oldest message the reader already has (`bots.history` `before`). */
export type HistoryCursor = Ordered;

export interface HistoryPageOptions {
  /** only messages that sort before this one */
  before?: HistoryCursor;
  /** how many of the newest matching messages */
  limit: number;
  /** also everything at or after this time (up to `max`), e.g. to reach an older chat a link points at */
  since?: number;
  /** cap on what `since` may pull in */
  max?: number;
}

/**
 * One page of a conversation from any number of message lists (a bot's threads, in any order): the newest `limit`
 * messages before `before`, oldest first, and whether older ones remain.
 */
export function historyPage(messages: Iterable<Message>, o: HistoryPageOptions): { messages: Message[]; hasMore: boolean } {
  const all: Message[] = [];
  for (const m of messages) if (!o.before || compareMessages(m, o.before) < 0) all.push(m);
  all.sort(compareMessages);
  let take = Math.max(0, o.limit);
  if (o.since !== undefined) {
    const max = Math.max(take, o.max ?? 1000);
    let from = all.length;
    while (from > 0 && all[from - 1]!.createdAt >= o.since) from--;
    take = Math.min(max, Math.max(take, all.length - from));
  }
  const start = Math.max(0, all.length - take);
  return { messages: all.slice(start), hasMore: start > 0 };
}

/* ------------------------------------------------------------- separators */

/** A gap this long starts a new sitting (Akeru's SESSION_GAP_MS). */
export const SESSION_GAP_MS = 4 * 60 * 60 * 1000;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** the time as every other clock in the app shows it (Settings › Appearance › Time format, `setClockStyle`) */
const clock = (d: Date): string => clockTime(d.getTime());

/**
 * The label of the separator above a message ("Sun, Aug 16 1:54 PM", "Today 9:02 AM"; another year adds it), or
 * null when the message continues the sitting before it. A separator goes above the first message, where the day
 * changes, and after a gap of `SESSION_GAP_MS` or more (Akeru's conversationSeparatorLabel).
 */
export function separatorLabel(createdAt: number, previousCreatedAt: number | null, now: number = Date.now()): string | null {
  const cur = new Date(createdAt);
  if (Number.isNaN(cur.getTime())) return null;
  if (previousCreatedAt !== null) {
    const prev = new Date(previousCreatedAt);
    if (!Number.isNaN(prev.getTime()) && sameDay(prev, cur) && createdAt - previousCreatedAt < SESSION_GAP_MS) return null;
  }
  const today = new Date(now);
  if (sameDay(cur, today)) return `Today ${clock(cur)}`;
  const year = cur.getFullYear() === today.getFullYear() ? '' : `, ${cur.getFullYear()}`;
  return `${WEEKDAYS[cur.getDay()]}, ${MONTHS[cur.getMonth()]} ${cur.getDate()}${year} ${clock(cur)}`;
}

/** Separator labels for messages in conversation order (one per message, null where none goes). */
export function conversationSeparators(messages: readonly Pick<Message, 'createdAt'>[], now: number = Date.now()): (string | null)[] {
  return messages.map((m, i) => separatorLabel(m.createdAt, i === 0 ? null : messages[i - 1]!.createdAt, now));
}

/* ---------------------------------------------- priming a fresh agent session */

/** At most this many whole turns go into a fresh session's preface (Akeru's AKERU_RECENT_TURN_LIMIT). */
export const RECENT_TURN_LIMIT = 30;
/** ... within this many tokens, estimated as characters / 4 (Akeru's AKERU_RECENT_TOKEN_LIMIT). */
export const RECENT_TOKEN_LIMIT = 64_000;
/** One message never takes more than this many characters of the preface (the start and end are kept). */
const MESSAGE_MAX_CHARS = 6_000;
/** Tool calls listed per reply before the rest are counted. */
const TOOL_LINES_MAX = 12;

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** Keep the start and the end of a long text (an answer ends with its result). */
function clip(text: string, max = MESSAGE_MAX_CHARS): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head).trimEnd()}\n[… ${text.length - head - tail} characters left out …]\n${text.slice(text.length - tail).trimStart()}`;
}

const isHiddenTool = (p: ToolCallPart) => p.title === 'ToolSearch';

/**
 * A message as transcript text: what was said, each tool call as one line, a question with its answer, and only
 * the names of images and files (never their bytes). Empty when nothing worth repeating is left.
 */
export function transcriptText(m: Pick<Message, 'role' | 'parts' | 'status' | 'error'>): string {
  const out: string[] = [];
  let tools = 0;
  let moreTools = 0;
  const flushMore = () => { if (moreTools) { out.push(`  · …and ${moreTools} more tool call${moreTools === 1 ? '' : 's'}`); moreTools = 0; } };
  for (const p of m.parts as Part[]) {
    switch (p.type) {
      case 'text': {
        flushMore();
        const { body, paths } = m.role === 'user' ? splitFileLines(p.text) : { body: p.text.trim(), paths: [] as string[] };
        if (body) out.push(body);
        if (paths.length) out.push(`[attached: ${paths.map(basename).join(', ')}]`);
        break;
      }
      case 'tool_call':
        if (isHiddenTool(p)) break;
        if (tools++ >= TOOL_LINES_MAX) { moreTools++; break; }
        out.push(`  · ${truncate(sentenceText(toolSentence(p, false)), 160)}${p.status === 'failed' ? ' (failed)' : ''}`);
        break;
      case 'image':
        flushMore();
        out.push(m.role === 'user' ? '[attached an image]' : '[showed an image]');
        break;
      case 'file':
        flushMore();
        out.push(m.role === 'user' ? `[attached: ${p.file.name}]` : `[sent file: ${p.file.name}]`);
        break;
      case 'page':
        flushMore();
        out.push(`[showed a page: ${truncate(p.title, 120)}]`);
        break;
      case 'question':
        flushMore();
        out.push(`[asked: ${truncate(p.question, 300)}${p.declined ? ' → the user declined' : p.answer ? ` → the user answered: ${truncate(p.answer, 300)}` : ''}]`);
        break;
      case 'voice':
        // the transcript is the message's text part; without one, say what it was
        if (!(m.parts as Part[]).some((q) => q.type === 'text' && q.text.trim())) { flushMore(); out.push(m.role === 'user' ? '[a voice message]' : '[read aloud]'); }
        break;
      case 'system':
        flushMore();
        if (p.level === 'error') out.push(`[error: ${truncate(p.text, 300)}]`);
        break;
      default:
        // thoughts and plans are the agent's own scratch work
        break;
    }
  }
  flushMore();
  if (m.role === 'agent' && m.status === 'cancelled') out.push('[stopped by the user]');
  return clip(out.join('\n').replace(/^\s*\n/, '').trimEnd());
}

/** Whole turns (a prompt and everything that answered it), oldest first. Anything before the first prompt is a turn of its own. */
export function conversationTurns<M extends Pick<Message, 'role'>>(messages: readonly M[]): M[][] {
  const turns: M[][] = [];
  for (const m of messages) {
    if (m.role === 'user' || !turns.length) turns.push([]);
    turns[turns.length - 1]!.push(m);
  }
  return turns;
}

export interface RecentOptions {
  turnLimit?: number;
  tokenLimit?: number;
}

/**
 * The recent stretch of a conversation a fresh session is primed with (Akeru's selectRecentConversation): whole
 * turns that got an answer, taken newest first while they fit `turnLimit` turns and `tokenLimit` tokens (the newest
 * one always), then put back in conversation order. `messages` must already be in conversation order.
 */
export function selectRecentTurns<M extends Pick<Message, 'role' | 'parts' | 'status' | 'error'>>(messages: readonly M[], o: RecentOptions = {}): M[][] {
  const turnLimit = o.turnLimit ?? RECENT_TURN_LIMIT;
  const tokenLimit = o.tokenLimit ?? RECENT_TOKEN_LIMIT;
  const turns = conversationTurns(messages).filter((t) => t.some((m) => m.role === 'agent' && transcriptText(m)));
  const picked: M[][] = [];
  let tokens = 0;
  for (let i = turns.length - 1; i >= 0 && picked.length < turnLimit; i--) {
    const cost = turns[i]!.reduce((n, m) => n + estimateTokens(transcriptText(m)), 0);
    if (picked.length && tokens + cost > tokenLimit) break;
    picked.push(turns[i]!);
    tokens += cost;
  }
  return picked.reverse();
}

const pad = (n: number) => String(n).padStart(2, '0');
/** "Sun 2026-10-11 09:02" in the Mac's local time: unambiguous for the agent. */
function stamp(ts: number): string {
  const d = new Date(ts);
  return `${WEEKDAYS[d.getDay()]} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface PrefaceOptions extends RecentOptions {
  /** the bot's name, used for its own lines */
  botName: string;
}

/**
 * The text a fresh agent session's first prompt starts with, so a thread that lost its session (resume failed,
 * another provider, a crash) still picks up where it was: its recent turns as a compact transcript (see
 * `selectRecentTurns`, `transcriptText`). Null when there is nothing to recall (a new thread). `messages` is the
 * thread's conversation before the new prompt, in conversation order.
 */
export function conversationPreface(messages: readonly Message[], o: PrefaceOptions): string | null {
  const turns = selectRecentTurns(messages, o);
  if (!turns.length) return null;
  const lines: string[] = [];
  for (const turn of turns) {
    const first = turn[0]!;
    const head = `[${stamp(first.createdAt)}]`;
    turn.forEach((m, i) => {
      const text = transcriptText(m);
      if (!text) return;
      const who = m.role === 'user' ? 'User' : o.botName;
      // a reply that opens with tool lines starts them on their own line
      lines.push(`${i === 0 ? `${head} ` : ''}${who}:${text.startsWith('  ·') ? '\n' : ' '}${text}`);
    });
    lines.push('');
  }
  const total = conversationTurns(messages).length;
  const older = total > turns.length ? ' Older turns are left out.' : '';
  return [
    '<conversation-so-far>',
    `You are ${o.botName}, continuing this thread with the user. Your previous agent session ended, so here are the last ${turns.length === 1 ? 'turn' : `${turns.length} turns`} of it, oldest first, to pick up where you left off.${older} Tool calls are summarised in one line each; images and file contents are left out. Don't answer these again: they are already done.`,
    '',
    lines.join('\n').trimEnd(),
    '</conversation-so-far>',
    '',
    'The user’s new message:',
  ].join('\n');
}
