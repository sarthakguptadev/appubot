/**
 * The work trail: how a turn's processing reads when the chat shows it (desktop Settings › Appearance › Chat shows:
 * Everything). The bot's tool calls, thoughts and narration between your message and its reply read as a quiet trail
 * of one-line rows that group and fold, never as chat bubbles; the reply itself stays as the answers view shows it.
 *
 * Ported from MonoCode (https://github.com/hardbeat920/monocode, MIT, Copyright (c) 2026 Nick):
 * src/features/sessions/model/transcriptActivity.ts (`toolCallState`, `isIncompleteTool`, `isHiddenTool`,
 * `isActivityBlock`, `proseSummary`, `groupTurnItems`, `withoutSupersededInitialThinking`, `initialThinkingIndex`,
 * `activityStillRunning`, `toolCategory`, `tallySteps`, `fileLabel`, `workSummary`, `currentWorkKind`,
 * `workSummaryLine`, `dominantWorkKind`, `workKind`, `foldableWork`, `isFoldableItem`) and
 * src/integrations/harness/core/preview.ts (`isWeakToolTitle`).
 *
 * Changed for AppuBot: it reads protocol parts of one agent message (thoughts, tool calls, text, plans) rather than
 * MonoCode's session blocks; a settled turn's reply (chat-core `layoutTurn`'s answer) is left out of the trail, since
 * the chat shows it as it always does, so a settled trail folds whole; a plan is a trail item (it never folds while the
 * turn is live, as MonoCode's tasks block never does); there are no subagent stacks or background tasks (AppuBot's
 * parts don't carry a delegated run's own steps), so a delegated call is one row of kind `agent`; AppuBot's own kinds of
 * work have categories and words of their own (the computer, apps through Composio, the web, asking you, sending you
 * something, memory); a tool's state also knows an approval waiting in AppuBot (`awaiting`) and a turn stopped
 * mid-call; "the project" reads "files", since a bot's folder is no project.
 */
import type { Part } from '@appubot/protocol';
import { basename, truncate } from './format';
import { layoutTurn, type Indexed } from './turn';
import { commandReadTargets, rawCommand, rawPath, toolPaths, toolSentence, type Sentence, type ToolCallPart } from './toolText';

type P<T extends Part['type']> = Extract<Part, { type: T }>;

/** A call in flight (or waiting on you), one that worked, or one that didn't (failed, refused, cut off). */
export type ToolState = 'pending' | 'accepted' | 'rejected';

export interface TrailOptions {
  /** the turn has ended */
  settled: boolean;
  /** it ended stopped or failed: a call still open then didn't finish */
  interrupted?: boolean;
  /** tool calls waiting on the user's approval (by `toolCallId`) */
  awaiting?: ReadonlySet<string>;
}

export function toolState(t: ToolCallPart, opts: TrailOptions): ToolState {
  if (t.status === 'failed') return 'rejected';
  if (opts.awaiting?.has(t.toolCallId)) return 'pending';
  if (t.status === 'completed') return 'accepted';
  if (opts.settled) return opts.interrupted ? 'rejected' : 'accepted';
  return 'pending';
}

/** A title that names no action of its own ("Tool", "Read", "Working"): MonoCode's `isWeakToolTitle`. */
export function isWeakToolTitle(value: string): boolean {
  return /^(tool|shell|bash|execute|command|skill|read|edit|search|find|grep|glob|fetch|other|write|delete|move|think|run|list|working|reading|editing|searching|writing|running|listing|fetching|thinking|deleting|moving|mcp:\s*tool|read file|edit file|write file|run command|ran command|unnamed|tool call)$/i.test(value.trim());
}

/** AppuBot's own bridge tool behind a raw title (`mcp__appubot__apps_execute`, `appubot.send_message`), if any. */
export function bridgeTool(title: string): string | undefined {
  return /^(?:mcp__appubot__|appubot[./:-]|appubot__)([a-z_]+)(?::\s*[a-z_]+)?$/.exec(title.trim())?.[1];
}

/**
 * A call still starting that says nothing yet: no kind, no file, no input worth a word, a weak title. It shows once it
 * has something to say (MonoCode's `isIncompleteTool`).
 */
export function isIncompleteTool(t: ToolCallPart, state: ToolState): boolean {
  if (state !== 'pending' || t.kind !== 'other') return false;
  if (t.locations.length || t.content.length || rawPath(t.rawInput) || rawCommand(t.rawInput)) return false;
  return !t.title.trim() || isWeakToolTitle(t.title);
}

/**
 * Calls the trail leaves out: Claude Code's tool lookups, a todo update when the turn's plan shows the plan itself
 * (MonoCode hides the provider's todo call behind its tasks block), and a call that says nothing yet.
 */
export function isHiddenTool(t: ToolCallPart, opts: TrailOptions & { hasPlan?: boolean }): boolean {
  if (t.title === 'ToolSearch') return true;
  if (opts.hasPlan && t.title === 'TodoWrite') return true;
  return isIncompleteTool(t, toolState(t, opts));
}

/** A thought with something in it (a blank or comment-only thought is no step). */
const isThought = (p: Part): p is P<'thought'> => p.type === 'thought' && /[^\s\p{P}]/u.test(p.text.replace(/<!--[\s\S]*?-->/g, ''));
/** The bot's narration: text it wrote while working, not a message it sent you on purpose (`said`). */
const isProse = (p: Part): p is P<'text'> => p.type === 'text' && !p.said && !!p.text.trim();

/** First paragraph of a block of text as one plain line (MonoCode's `proseSummary`). */
export function proseSummary(text: string): string {
  const body = text.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const paragraph = body.split(/\n\s*\n/).map((part) => part.trim()).find(Boolean) ?? '';
  return paragraph
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether a block of text has more than its one-line summary shows (a row then opens onto the whole of it). */
export function hasMoreThanSummary(text: string): boolean {
  return proseSummary(text) !== text.replace(/\s+/g, ' ').trim();
}

export type TrailStep = Indexed<ToolCallPart> | Indexed<P<'thought'>>;

/**
 * One item of the trail: a run of work (calls and thoughts), a line the bot wrote while working, or its plan.
 * `key` stays the same as a run grows (its first step's place in the message).
 */
export type TrailItem =
  | { type: 'activity'; key: string; steps: TrailStep[] }
  | { type: 'note'; key: string; item: Indexed<P<'text'>> }
  | { type: 'plan'; key: string; item: Indexed<P<'plan'>> };

/**
 * Some agents stream private reasoning before their first words. It stays only while those words haven't come: when
 * text arrives before any call, the leading thoughts go (MonoCode's `withoutSupersededInitialThinking`); when a call
 * comes first, they belong to its group.
 */
function withoutSupersededInitialThinking(list: Indexed[]): Indexed[] {
  let start = 0;
  while (start < list.length && list[start]!.part.type === 'system') start += 1;
  let end = start;
  while (end < list.length && isThought(list[end]!.part)) end += 1;
  if (end === start) return list;
  const following = list.slice(end);
  const prose = following.findIndex((x) => x.part.type === 'text' && !!x.part.text.trim());
  if (prose < 0) return list;
  const tool = following.findIndex((x) => x.part.type === 'tool_call');
  if (tool >= 0 && tool < prose) return list;
  return [...list.slice(0, start), ...list.slice(end)];
}

/**
 * The trail of one agent message (MonoCode's `groupTurnItems`): runs of calls and thoughts become one `activity`;
 * the bot's narration and its plan stand on their own and break a run, and so does anything the chat shows as the
 * reply (a question, a file, a message it sent you), so the trail keeps the order things happened in. A settled
 * turn's reply (its answer text) isn't in the trail at all.
 */
export function trailItems(parts: Part[], opts: TrailOptions): TrailItem[] {
  const hasPlan = parts.some((p) => p.type === 'plan');
  const reply = opts.settled ? new Set(layoutTurn(parts).answer.map((x) => x.index)) : new Set<number>();
  const visible = withoutSupersededInitialThinking(
    parts.flatMap((part, index) => {
      if (part.type === 'tool_call' && isHiddenTool(part, { ...opts, hasPlan })) return [];
      if (part.type === 'thought' && !isThought(part)) return [];
      if (part.type === 'text' && !part.text.trim()) return [];
      return [{ part, index }];
    }),
  );
  const items: TrailItem[] = [];
  let run: TrailStep[] = [];
  const flush = () => {
    if (run.length) items.push({ type: 'activity', key: `a${run[0]!.index}`, steps: run });
    run = [];
  };
  for (const x of visible) {
    if (reply.has(x.index)) { flush(); continue; }
    const p = x.part;
    if (p.type === 'tool_call' || isThought(p)) { run.push(x as TrailStep); continue; }
    flush();
    if (isProse(p)) items.push({ type: 'note', key: `n${x.index}`, item: x as Indexed<P<'text'>> });
    else if (p.type === 'plan') items.push({ type: 'plan', key: `p${x.index}`, item: x as Indexed<P<'plan'>> });
  }
  flush();
  return items;
}

/** Steps of a run, without the reply's parts (MonoCode's `foldedBlocks`, for the status line's summary). */
export function trailSteps(items: TrailItem[]): TrailStep[] {
  return items.flatMap((item) => (item.type === 'activity' ? item.steps : []));
}

/** A run of work that is only thinking so far: the trail shows "Thinking…" for it (MonoCode's `initialThinkingIndex`). */
export function initialThinkingIndex(items: TrailItem[]): number {
  const first = items[0];
  return first?.type === 'activity' && first.steps.every((s) => s.part.type === 'thought') ? 0 : -1;
}

/** Whether a call in these steps is still running or waiting on you (MonoCode's `activityStillRunning`). */
export function activityStillRunning(steps: TrailStep[], opts: TrailOptions): boolean {
  return steps.some((s) => s.part.type === 'tool_call' && toolState(s.part, opts) === 'pending');
}

/** Whether a call in these steps waits on the user's approval. */
export function needsApproval(steps: TrailStep[], awaiting?: ReadonlySet<string>): boolean {
  return !!awaiting?.size && steps.some((s) => s.part.type === 'tool_call' && awaiting.has(s.part.toolCallId));
}

/**
 * What a call was for. Reads and searches are one thing, looking around, so a search followed by the file it turned
 * up stays one clause (MonoCode's `ActivityWorkKind`, with AppuBot's own kinds added).
 */
export type WorkKind = 'research' | 'edit' | 'run' | 'computer' | 'apps' | 'web' | 'agent' | 'ask' | 'send' | 'memory' | 'other';
/** A kind of work, or a run that was only thinking. */
export type WorkGroupKind = WorkKind | 'think';

/** Ties break towards the kind that changed the most: an edit outranks a read. */
const WORK_KIND_ORDER: WorkKind[] = ['edit', 'run', 'computer', 'apps', 'agent', 'web', 'research', 'send', 'ask', 'memory', 'other'];

const MEMORY_TITLES = new Set(['Remember', 'Update memory', 'Forget', 'Read memory']);
const SEND_BRIDGE = new Set(['send_message', 'notify_user', 'send_file', 'show_page', 'send_voice', 'message_bot', 'message_bots', 'post_to_group']);

/** A call that handed work to a subagent (MonoCode's `isAgentTool`): by its name, or a Task call's brief. */
function isDelegation(t: ToolCallPart): boolean {
  if (/^(?:task|agent|subagent)\b/i.test(t.title.trim())) return true;
  const r = t.rawInput && typeof t.rawInput === 'object' ? (t.rawInput as Record<string, unknown>) : {};
  return typeof r.subagent_type === 'string' || (typeof r.prompt === 'string' && typeof r.description === 'string');
}

/** The kind of a call (MonoCode's `toolCategory`, over AppuBot's tool kinds and its own bridge tools). */
export function workCategory(t: ToolCallPart): WorkKind {
  const bridge = bridgeTool(t.title);
  if (bridge) {
    if (bridge.startsWith('apps_')) return 'apps';
    if (bridge.startsWith('mac_files_')) return 'research';
    if (bridge === 'ask_user' || bridge === 'ask_form') return 'ask';
    if (SEND_BRIDGE.has(bridge)) return 'send';
    if (bridge === 'remember' || bridge === 'update_memory' || bridge === 'forget' || bridge === 'read_memory') return 'memory';
    if (bridge.startsWith('computer_')) return 'computer';
    return 'other';
  }
  switch (t.kind) {
    case 'read': case 'search': return 'research';
    case 'edit': case 'delete': case 'move': return 'edit';
    case 'fetch': return 'web';
    case 'computer': return 'computer';
    case 'execute': {
      const cmd = rawCommand(t.rawInput) ?? t.title;
      return commandReadTargets(cmd) || /^\s*(?:grep|rg|find|fd|ag)\s/.test(cmd) ? 'research' : 'run';
    }
    // Claude Code reports a delegated run (its Task tool) as a `think` call named by the task, with the brief as input
    case 'think': return isDelegation(t) ? 'agent' : 'other';
    default: break;
  }
  if (t.title === 'Ask you') return 'ask';
  if (t.title === 'Send file to you' || t.title === 'Send file to your phone' || t.title === 'Notify you' || t.title === 'Show you a page') return 'send';
  if (MEMORY_TITLES.has(t.title)) return 'memory';
  if (isDelegation(t)) return 'agent';
  return 'other';
}

/** "GMAIL_FETCH_EMAILS" → "Gmail" (the app a Composio tool belongs to). */
const APP_NAMES: Record<string, string> = {
  GOOGLECALENDAR: 'Google Calendar', GOOGLEDRIVE: 'Google Drive', GOOGLESHEETS: 'Google Sheets', GOOGLEDOCS: 'Google Docs',
  GOOGLEMEET: 'Google Meet', GITHUB: 'GitHub', GITLAB: 'GitLab', LINKEDIN: 'LinkedIn', YOUTUBE: 'YouTube', HUBSPOT: 'HubSpot',
  CLICKUP: 'ClickUp', ONEDRIVE: 'OneDrive', OUTLOOK: 'Outlook', WHATSAPP: 'WhatsApp', TIKTOK: 'TikTok', HACKERNEWS: 'Hacker News',
};
export function appOfSlug(slug: string): string {
  const head = slug.split('_')[0]?.toUpperCase() ?? '';
  return APP_NAMES[head] ?? (head ? head.charAt(0) + head.slice(1).toLowerCase() : 'an app');
}

/** The apps a call through Composio used (`apps_execute`'s tool slugs). */
export function appsOfCall(t: ToolCallPart): string[] {
  const tools = (t.rawInput && typeof t.rawInput === 'object' ? (t.rawInput as { tools?: unknown }).tools : undefined);
  if (!Array.isArray(tools)) return [];
  const slugs = tools.flatMap((x) => (x && typeof x === 'object' && typeof (x as { tool_slug?: unknown }).tool_slug === 'string' ? [(x as { tool_slug: string }).tool_slug] : []));
  return [...new Set(slugs.map(appOfSlug))];
}

/** The app a computer step acted in, if it says. */
function computerApp(t: ToolCallPart): string | undefined {
  const a = t.computer?.action?.app;
  if (a) return a;
  const r = t.rawInput && typeof t.rawInput === 'object' ? (t.rawInput as Record<string, unknown>) : {};
  return typeof r.app === 'string' && r.app.trim() ? r.app.trim() : undefined;
}

type Tally = {
  /** the kinds of work in the run, in the order the bot first did them */
  order: WorkKind[];
  reads: Set<string>;
  searches: number;
  edits: Set<string>;
  runs: number;
  computer: { steps: number; apps: Set<string> };
  apps: Set<string>;
  web: { pages: number; searches: number };
  agents: number;
  asks: number;
  send: { files: number; messages: number; notices: number; pages: number; bots: number };
  memory: { saves: number; other: number };
  others: number;
};

function tallySteps(steps: TrailStep[]): Tally {
  const tally: Tally = {
    order: [], reads: new Set(), searches: 0, edits: new Set(), runs: 0, computer: { steps: 0, apps: new Set() }, apps: new Set(),
    web: { pages: 0, searches: 0 }, agents: 0, asks: 0, send: { files: 0, messages: 0, notices: 0, pages: 0, bots: 0 }, memory: { saves: 0, other: 0 }, others: 0,
  };
  for (const { part: t } of steps) {
    if (t.type !== 'tool_call') continue;
    const kind = workCategory(t);
    if (!tally.order.includes(kind)) tally.order.push(kind);
    const r = t.rawInput && typeof t.rawInput === 'object' ? (t.rawInput as Record<string, unknown>) : {};
    const bridge = bridgeTool(t.title);
    // one file counts once however often it was read or edited (MonoCode keys by path, else by the call)
    const target = () => {
      const paths = toolPaths(t);
      if (paths.length) return paths;
      const reads = commandReadTargets(rawCommand(t.rawInput) ?? '');
      // a call that names no file yet (its input still streaming) counts as one of its own, never by its id
      return reads ?? [`${UNNAMED}${t.toolCallId}`];
    };
    switch (kind) {
      case 'edit': target().forEach((p) => tally.edits.add(p)); break;
      case 'research': {
        const search = t.kind === 'search' || bridge === 'mac_files_find' || bridge === 'mac_files_list' || (t.kind === 'execute' && !commandReadTargets(rawCommand(t.rawInput) ?? t.title));
        if (search) tally.searches += 1;
        else target().forEach((p) => tally.reads.add(p));
        break;
      }
      case 'run': tally.runs += 1; break;
      case 'computer': { tally.computer.steps += 1; const app = computerApp(t); if (app) tally.computer.apps.add(app); break; }
      case 'apps': appsOfCall(t).forEach((a) => tally.apps.add(a)); break;
      case 'web': if (typeof r.url === 'string') tally.web.pages += 1; else tally.web.searches += 1; break;
      case 'agent': tally.agents += 1; break;
      case 'ask': tally.asks += 1; break;
      case 'send':
        if (bridge === 'message_bot' || bridge === 'message_bots' || bridge === 'post_to_group') tally.send.bots += 1;
        else if (bridge === 'send_message') tally.send.messages += 1;
        else if (bridge === 'notify_user' || t.title === 'Notify you') tally.send.notices += 1;
        else if (bridge === 'show_page' || t.title === 'Show you a page') tally.send.pages += 1;
        else tally.send.files += 1;
        break;
      case 'memory': if (bridge === 'remember' || t.title === 'Remember') tally.memory.saves += 1; else tally.memory.other += 1; break;
      default: tally.others += 1;
    }
  }
  return tally;
}

/** marks a tally key that stands for a call with no file to name (never part of a path) */
const UNNAMED = '\0';

function fileLabel(paths: Set<string>): string {
  const [first] = paths;
  if (paths.size === 1 && first?.startsWith(UNNAMED)) return 'a file';
  if (paths.size === 1 && first) return basename(first) || first;
  return `${paths.size} files`;
}

const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);
const listNames = (names: Set<string>, many: string) => {
  const list = [...names];
  if (list.length === 1) return list[0]!;
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.length} ${many}`;
};

/** What the calls of one kind add up to: "Edited 2 files", "Ran 3 commands", "Used Numbers" (MonoCode's `workSummary`). */
function workSummary(kind: WorkKind, tally: Tally, live: boolean): string {
  const v = (doing: string, done: string) => (live ? doing : done);
  switch (kind) {
    case 'edit': return `${v('Editing', 'Edited')} ${fileLabel(tally.edits)}`;
    case 'research':
      if (tally.reads.size > 0 && tally.searches === 0) return `${v('Reading', 'Read')} ${fileLabel(tally.reads)}`;
      if (tally.reads.size === 0) return v('Searching files', 'Searched files');
      return v('Exploring files', 'Explored files');
    case 'run': return tally.runs === 1 ? v('Running a command', 'Ran a command') : `${v('Running', 'Ran')} ${tally.runs} commands`;
    case 'computer': return tally.computer.apps.size === 1 ? `${v('Using', 'Used')} ${[...tally.computer.apps][0]}` : v('Using the computer', 'Used the computer');
    case 'apps': return `${v('Using', 'Used')} ${tally.apps.size ? listNames(tally.apps, 'apps') : 'your apps'}`;
    case 'web':
      if (tally.web.searches > 0) return v('Searching the web', 'Searched the web');
      return `${v('Fetching', 'Fetched')} ${count(tally.web.pages, 'a page', 'pages')}`;
    case 'agent': return `${v('Running', 'Ran')} ${count(tally.agents, 'a subagent', 'subagents')}`;
    case 'ask': return `${v('Asking', 'Asked')} you ${count(tally.asks, 'a question', 'questions')}`;
    case 'send': {
      const s = tally.send;
      const kinds = [s.files, s.messages, s.notices, s.pages, s.bots].filter(Boolean).length;
      if (kinds > 1) return `${v('Sending', 'Sent')} you ${s.files + s.messages + s.notices + s.pages} things`;
      if (s.bots) return `${v('Messaging', 'Messaged')} ${count(s.bots, 'a bot', 'bots')}`;
      if (s.messages) return `${v('Sending', 'Sent')} you ${count(s.messages, 'a message', 'messages')}`;
      if (s.notices) return v('Notifying you', 'Notified you');
      if (s.pages) return `${v('Showing', 'Showed')} you ${count(s.pages, 'a page', 'pages')}`;
      return `${v('Sending', 'Sent')} you ${count(s.files, 'a file', 'files')}`;
    }
    case 'memory': return tally.memory.other === 0 ? v('Saving to memory', 'Saved to memory') : v('Using its memory', 'Used its memory');
    case 'other': return `${v('Using', 'Used')} ${count(tally.others, 'a tool', 'tools')}`;
  }
}

/** The kind of work a run is in the middle of: its most recent call (MonoCode's `currentWorkKind`). */
function currentWorkKind(steps: TrailStep[]): WorkKind | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const p = steps[i]!.part;
    if (p.type === 'tool_call') return workCategory(p);
  }
  return undefined;
}

/**
 * What a run of work adds up to, one clause per kind in the order the bot first did them: "Read 2 files · Ran a
 * command · Edited report.md". While live, only the clause of the call in flight is in the present tense, so
 * "Running 2 commands" settles to "Ran 2 commands" (MonoCode's `workSummaryLine`). A run of thoughts alone is
 * "Thinking" / "Thought".
 */
export function workSummaryLine(steps: TrailStep[], live = false): string {
  const tally = tallySteps(steps);
  if (tally.order.length === 0) return live ? 'Thinking' : 'Thought';
  const running = live ? currentWorkKind(steps) : undefined;
  return tally.order.map((kind) => workSummary(kind, tally, kind === running)).join(' · ');
}

/** Calls in these steps that didn't work (failed, refused, cut off). */
export function failedCount(steps: TrailStep[], opts: TrailOptions): number {
  return steps.filter((s) => s.part.type === 'tool_call' && toolState(s.part, opts) === 'rejected').length;
}

/** The icon a run answers to: whatever it did most of, else thinking (MonoCode's `workKind`). */
export function workKind(steps: TrailStep[]): WorkGroupKind {
  const counts = new Map<WorkKind, number>();
  for (const { part } of steps) if (part.type === 'tool_call') counts.set(workCategory(part), (counts.get(workCategory(part)) ?? 0) + 1);
  let best: WorkKind | undefined;
  for (const kind of WORK_KIND_ORDER) {
    const n = counts.get(kind) ?? 0;
    if (n > 0 && (!best || n > (counts.get(best) ?? 0))) best = kind;
  }
  return best ?? 'think';
}

/** The span of a trail that folds behind the turn's status line. */
export interface WorkFold { start: number; end: number }

/**
 * The work a turn can put away (MonoCode's `foldableWork`): from the first thing the bot did up to the last run of
 * work it has already written past, so as it streams each new line it writes folds the work and narration before it,
 * and only the work it is doing now stays open. A run waiting on your approval stays out of the fold, and so does a
 * plan while the turn is live. A settled turn has answered for all of its work: its whole trail folds.
 */
export function foldableWork(items: TrailItem[], opts: TrailOptions): WorkFold | undefined {
  if (!items.length) return undefined;
  const foldable = (item: TrailItem) =>
    item.type === 'note' || (item.type === 'plan' ? opts.settled : !needsApproval(item.steps, opts.awaiting));
  let end = -1;
  if (opts.settled) end = items.length - 1;
  else {
    let answered = false;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      if (item.type === 'activity') {
        if (answered && foldable(item)) { end = i; break; }
        continue;
      }
      if (item.type === 'note') answered = true;
    }
  }
  if (end < 0 || !foldable(items[end]!)) return undefined;
  let start = end;
  while (start > 0 && foldable(items[start - 1]!)) start -= 1;
  return { start, end };
}

/**
 * A call as a row of the trail: the verb, dim, then what it acted on. AppuBot's own tools that `toolSentence` names
 * only by their raw title read as words here ("Used Gmail", "Sent you a message").
 */
export function trailSentence(t: ToolCallPart, running: boolean): Sentence {
  const v = (done: string, doing: string) => (running ? doing : done);
  const bridge = bridgeTool(t.title);
  const r = t.rawInput && typeof t.rawInput === 'object' ? (t.rawInput as Record<string, unknown>) : {};
  const str = (k: string) => (typeof r[k] === 'string' && (r[k] as string).trim() ? (r[k] as string).trim() : undefined);
  switch (bridge) {
    case undefined: return toolSentence(t, running);
    case 'apps_execute': {
      const apps = appsOfCall(t);
      return { verb: `${v('Used', 'Using')} ${apps.length ? apps.join(', ') : 'an app'}` };
    }
    case 'apps_search': return { verb: v('Looked for the right app tool', 'Looking for the right app tool') };
    case 'apps_tool_schemas': return { verb: v('Read how an app tool works', 'Reading how an app tool works') };
    case 'apps_request': return { verb: v('Asked you to connect', 'Asking you to connect'), object: str('slug') };
    case 'send_message': return { verb: v('Sent you a message', 'Sending you a message') };
    case 'send_voice': return { verb: v('Sent you a voice message', 'Sending you a voice message') };
    case 'message_bot': return { verb: v('Messaged', 'Messaging'), object: str('bot') ?? 'a bot' };
    case 'message_bots': return { verb: v('Messaged every bot', 'Messaging every bot') };
    case 'post_to_group': return { verb: v('Posted to', 'Posting to'), object: str('group') ?? 'a group' };
    case 'mac_files_list': return { verb: v('Looked in your Mac’s folders', 'Looking in your Mac’s folders') };
    case 'mac_files_find': return { verb: v('Searched your Mac for', 'Searching your Mac for'), object: str('query') ? `“${truncate(str('query')!, 60)}”` : undefined };
    case 'mac_files_get': return { verb: v('Read from your Mac', 'Reading from your Mac'), object: str('path') ? basename(str('path')!) : undefined };
    case 'mac_files_put': return { verb: v('Saved to your Mac', 'Saving to your Mac'), object: str('path') ? basename(str('path')!) : undefined };
    case 'list_routines': return { verb: v('Listed its routines', 'Listing its routines') };
    case 'create_routine': return { verb: v('Proposed a routine', 'Proposing a routine') };
    case 'update_routine': return { verb: v('Changed a routine', 'Changing a routine') };
    case 'delete_routine': return { verb: v('Deleted a routine', 'Deleting a routine') };
    case 'vault_list': return { verb: v('Looked in your Vault', 'Looking in your Vault') };
    case 'vault_fill': return { verb: v('Filled in from your Vault', 'Filling in from your Vault') };
    case 'vault_key': return { verb: v('Used a key from your Vault', 'Using a key from your Vault') };
    case 'vault_request': return { verb: v('Asked you for a Vault item', 'Asking you for a Vault item') };
    case 'ask_form': return { verb: v('Asked you to fill in a card', 'Asking you to fill in a card') };
    case 'start_goal': return { verb: v('Proposed a goal', 'Proposing a goal') };
    case 'finish_goal': return { verb: v('Finished its goal', 'Finishing its goal') };
    default: return { verb: `${v('Used', 'Using')} ${bridge.replace(/_/g, ' ')}` };
  }
}
