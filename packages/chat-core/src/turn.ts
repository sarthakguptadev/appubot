/**
 * How an agent turn reads (Synara's MessagesTimeline logic, MIT): everything before the final answer - tool
 * calls, narration, thoughts - folds behind "Worked for 20s"; runs of 2+ tool calls fold into one summary line
 * ("Read 2 files, ran 3 commands"). Questions, files, images, plans and notices never fold.
 */
import type { Message, Part } from '@appubot/protocol';
import { formatDuration } from './format';
import { commandReadTargets, diffStat, isSendFileTitle, rawCommand, thoughtLine, toolPaths, type ToolCallPart } from './toolText';

type P<T extends Part['type']> = Extract<Part, { type: T }>;
export interface Indexed<T extends Part = Part> { part: T; index: number }

export type WorkItem = Indexed<ToolCallPart> | Indexed<P<'thought'>> | Indexed<P<'text'>>;
export type Chunk = { kind: 'item'; item: Indexed } | { kind: 'group'; id: string; tools: Indexed<ToolCallPart>[] };

export interface TurnLayout {
  /** folds behind the "Worked for" disclosure */
  work: WorkItem[];
  /** never folded; shown between the disclosure and the answer */
  pinned: Indexed[];
  /** the final answer (and any files/images that came with it) */
  answer: Indexed[];
  /** whether anything folds (tool calls or thoughts); a plain reply settles without a header */
  hasWork: boolean;
}

/** Claude Code's internal tool lookups say nothing to the person reading the chat; empty thoughts neither. */
const hidden = (p: Part) => (p.type === 'tool_call' && p.title === 'ToolSearch') || (p.type === 'thought' && thoughtLine(p.text) === null);
/** The bot's working: tool calls, thoughts and its narration, but not a message it sent you on purpose (`said`). */
const isWork = (p: Part): p is ToolCallPart | P<'thought'> | P<'text'> => p.type === 'tool_call' || p.type === 'thought' || (p.type === 'text' && !p.said);
const hasText = (x: Indexed) => x.part.type === 'text' && x.part.text.trim().length > 0;

export function layoutTurn(parts: Part[]): TurnLayout {
  // Synara folds every work entry, reasoning included: the fold runs to the last tool call or thought
  let lastTool = -1;
  parts.forEach((p, i) => { if ((p.type === 'tool_call' || p.type === 'thought') && !hidden(p)) lastTool = i; });
  if (lastTool === -1) return { work: [], pinned: [], answer: parts.flatMap((part, index) => (hidden(part) ? [] : [{ part, index }])), hasWork: false };

  const work: WorkItem[] = [];
  const pinned: Indexed[] = [];
  const answer: Indexed[] = [];
  parts.forEach((part, index) => {
    if (hidden(part)) return;
    if (index <= lastTool) {
      if (isWork(part)) { if (part.type !== 'text' || part.text.trim()) work.push({ part, index } as WorkItem); }
      else pinned.push({ part, index });
    } else if (part.type === 'thought') work.push({ part, index });
    else answer.push({ part, index });
  });
  // a turn that ends on tool calls still answers with its last narration
  if (!answer.some(hasText)) {
    for (let k = work.length - 1; k >= 0; k--) {
      if (hasText(work[k]!)) { answer.unshift(work.splice(k, 1)[0]!); break; }
    }
  }
  return { work, pinned, answer, hasWork: true };
}

/** Not shown in the answers-only chat view: the bot's working (narration, thoughts, tool calls, its plan). */
const isStep = (p: Part) => isWork(p) || p.type === 'plan';

/**
 * A live turn in the answers-only chat view: what the bot asks or sends you (questions, files, images, notices),
 * without its narration, thoughts, tool calls or plan; its reply shows once the turn is done.
 */
export function liveAnswerParts(parts: Part[]): Indexed[] {
  return parts.flatMap((part, index) => (hidden(part) || isStep(part) ? [] : [{ part, index }]));
}

/** A settled turn in the answers-only chat view: its reply, and what it asked or sent along the way (no plan). */
export function answerOnly(L: TurnLayout): Indexed[] {
  return [...L.pinned, ...L.answer].filter((x) => x.part.type !== 'plan');
}

/** Runs of 2+ consecutive tool calls become one group; anything else (narration, thoughts, cards) breaks runs. */
export function chunkWork(all: Indexed[]): Chunk[] {
  const items = all.filter((x) => !hidden(x.part));
  const out: Chunk[] = [];
  let run: Indexed<ToolCallPart>[] = [];
  const flush = () => {
    if (run.length >= 2) out.push({ kind: 'group', id: run[0]!.part.toolCallId || `g${run[0]!.index}`, tools: run });
    else run.forEach((item) => out.push({ kind: 'item', item }));
    run = [];
  };
  for (const item of items) {
    if (item.part.type === 'tool_call') { run.push(item as Indexed<ToolCallPart>); continue; }
    flush();
    out.push({ kind: 'item', item });
  }
  flush();
  return out;
}

/** Tool calls, tool runs and thoughts: rows of the work log rather than the reply. */
export const isWorkChunk = (c: Chunk): boolean => c.kind === 'group' || c.item.part.type === 'tool_call' || c.item.part.type === 'thought';

/**
 * One Synara assistant row: the work that came before its words (`lead`), its text and cards (`content`), and, on the
 * last row only, the work that followed (`inline`). As in Synara's timeline rows, work between two stretches of text
 * leads the later one; only work with no text after it stays attached to the text before it.
 */
export interface Segment { lead: Chunk[]; content: Indexed[]; inline: Chunk[] }

export function segmentFlow(list: Chunk[]): Segment[] {
  const out: Segment[] = [];
  let pending: Chunk[] = [];
  for (const c of list) {
    if (isWorkChunk(c)) { pending.push(c); continue; }
    if (c.kind !== 'item') continue;
    const last = out[out.length - 1];
    if (last && !pending.length) last.content.push(c.item);
    else { out.push({ lead: pending, content: [c.item], inline: [] }); pending = []; }
  }
  if (pending.length) {
    const last = out[out.length - 1];
    if (last) last.inline.push(...pending);
    else out.push({ lead: pending, content: [], inline: [] });
  }
  return out;
}

export type Category = 'read' | 'edit' | 'search' | 'command' | 'fetch' | 'computer' | 'ask' | 'send' | 'tool' | 'other';

export function categoryOf(t: ToolCallPart): Category {
  switch (t.kind) {
    case 'read': return 'read';
    case 'edit': case 'delete': case 'move': return 'edit';
    case 'search': return 'search';
    case 'fetch': return 'fetch';
    case 'computer': return 'computer';
    case 'execute': {
      const cmd = rawCommand(t.rawInput) ?? t.title;
      if (commandReadTargets(cmd)) return 'read';
      return /^\s*(?:grep|rg|find|fd|ag)\s/.test(cmd) ? 'search' : 'command';
    }
    case 'think': case 'switch_mode': return 'other';
    default: return t.title === 'Ask you' ? 'ask' : isSendFileTitle(t.title) ? 'send' : 'tool';
  }
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

function phrase(c: Category, n: number, sole: boolean): string {
  switch (c) {
    case 'read': return `read ${plural(n, 'file')}`;
    case 'edit': return `edited ${plural(n, 'file')}`;
    case 'search': return `searched ${times(n)}`;
    case 'command': return `ran ${plural(n, 'command')}`;
    case 'fetch': return `fetched ${plural(n, 'page')}`;
    case 'computer': return `used the computer ${times(n)}`;
    case 'ask': return n === 1 ? 'asked you a question' : `asked you ${n} questions`;
    case 'send': return `sent you ${plural(n, 'file')}`;
    case 'tool': return `used ${plural(n, 'tool')}`;
    case 'other': return sole ? `ran ${n} tool call${n === 1 ? '' : 's'}` : `${n} other action${n === 1 ? '' : 's'}`;
  }
}

export interface GroupSummary { label: string; failed: number; running: boolean; icon: Category | 'mixed' }

/** "Read 2 files, ran 3 commands" (≤3 named kinds, then "N other actions"), in the order the work happened. */
export function summarizeGroup(tools: ToolCallPart[], settled: boolean): GroupSummary {
  const counts = new Map<Category, number>();
  const files = new Map<Category, Set<string>>();
  let failed = 0;
  let running = false;
  for (const t of tools) {
    if (t.status === 'failed') failed++;
    if (!settled && (t.status === 'pending' || t.status === 'in_progress')) running = true;
    const c = categoryOf(t);
    const paths = c === 'read' || c === 'edit' ? toolPaths(t) : [];
    if (!counts.has(c)) counts.set(c, 0);
    if (paths.length) { const s = files.get(c) ?? new Set<string>(); paths.forEach((p) => s.add(p)); files.set(c, s); }
    else counts.set(c, counts.get(c)! + 1);
  }
  for (const [c, s] of files) counts.set(c, counts.get(c)! + s.size);
  const parts = [...counts].filter(([, n]) => n > 0).sort(([a], [b]) => Number(a === 'other') - Number(b === 'other'));
  const named = parts.length > 3 ? parts.slice(0, 2) : parts;
  const overflow = parts.slice(named.length).reduce((n, [, k]) => n + k, 0);
  const phrases = named.map(([c, n]) => phrase(c, n, parts.length === 1));
  if (overflow) phrases.push(`${overflow} other action${overflow === 1 ? '' : 's'}`);
  const label = phrases.join(', ');
  return { label: label.charAt(0).toUpperCase() + label.slice(1), failed, running, icon: parts.length === 1 ? parts[0]![0] : 'mixed' };
}

export type TurnOutcome = 'completed' | 'stopped' | 'interrupted';
export interface TurnHeader { elapsed: string | null; outcome: TurnOutcome; reason: string | null }

/** A settled turn's header; `endAt` is when it stopped streaming (later `updatedAt` bumps don't stretch it). */
export function turnHeader(msg: Pick<Message, 'status' | 'error' | 'createdAt' | 'updatedAt'>, endAt = msg.updatedAt): TurnHeader {
  const ms = endAt - msg.createdAt;
  return {
    elapsed: Number.isFinite(ms) && ms >= 0 ? formatDuration(ms) : null,
    outcome: msg.status === 'cancelled' ? 'stopped' : msg.status === 'error' ? 'interrupted' : 'completed',
    reason: msg.status === 'error' ? msg.error?.trim() || null : null,
  };
}

/**
 * "Worked for 20s", "Stopped after 16s", "Interrupted after 9s · usage limit reached", "Details" (Synara). A stopped
 * turn never says who stopped it: an agent may end its own turn as cancelled, and the person who did stop one knows.
 */
export function formatTurnHeaderLabel(h: TurnHeader): string {
  switch (h.outcome) {
    case 'stopped': return h.elapsed ? `Stopped after ${h.elapsed}` : 'Stopped';
    case 'interrupted': {
      const base = h.elapsed ? `Interrupted after ${h.elapsed}` : 'Interrupted';
      return h.reason ? `${base} · ${h.reason}` : base;
    }
    case 'completed': return h.elapsed ? `Worked for ${h.elapsed}` : 'Details';
  }
}

/** Inline tool rows a live turn lists before the rest hide behind "+N more tool calls" (Synara). */
export const MAX_VISIBLE_INLINE_TOOLS = 4;
/** A "+N more" toggle costs a row of its own, so it only appears when it hides at least this many rows. */
export const MIN_HIDDEN_ROWS_TO_COLLAPSE = 3;

/** How many of `total` rows a list capped at `max` hides, or 0 when too few to be worth a toggle. */
export function collapsibleHiddenRowCount(total: number, max: number): number {
  const hiddenRows = Math.max(0, total - Math.max(0, max));
  return hiddenRows >= MIN_HIDDEN_ROWS_TO_COLLAPSE ? hiddenRows : 0;
}

/**
 * Bounds the open single tool rows of one work block (Synara's capOpenWorkEntryRenderChunks): folded groups and
 * thoughts stay; a live turn keeps its newest calls, a settled one its first. `hidden` is what the cap hides (or
 * would hide, when expanded), 0 when no toggle is warranted.
 */
export function capOpenTools(list: Chunk[], opts: { expanded: boolean; keep: 'first' | 'last'; max?: number }): { chunks: Chunk[]; hidden: number } {
  const max = opts.max ?? MAX_VISIBLE_INLINE_TOOLS;
  const isOpenTool = (c: Chunk) => c.kind === 'item' && c.item.part.type === 'tool_call';
  const open = list.filter(isOpenTool);
  const hiddenRows = collapsibleHiddenRowCount(open.length, max);
  if (!hiddenRows || opts.expanded) return { chunks: list, hidden: hiddenRows };
  const keep = new Set(opts.keep === 'last' ? open.slice(-max) : open.slice(0, max));
  return { chunks: list.filter((c) => !isOpenTool(c) || keep.has(c)), hidden: hiddenRows };
}

export interface FileChange { path: string; added: number; removed: number; created: boolean }

/** Files a turn edited, with summed +/- (for the turn summary card). */
export function turnFileChanges(parts: Part[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const p of parts) {
    if (p.type !== 'tool_call' || (p.kind !== 'edit' && p.kind !== 'delete' && p.kind !== 'move') || p.status === 'failed') continue;
    for (const c of p.content) {
      if (c.type !== 'diff') continue;
      const cur = byPath.get(c.path) ?? { path: c.path, added: 0, removed: 0, created: c.oldText === null };
      const s = diffStat(c);
      cur.added += s.added;
      cur.removed += s.removed;
      byPath.set(c.path, cur);
    }
  }
  return [...byPath.values()];
}
