/**
 * What a tool call says in the transcript: one sentence whose verb carries the tense ("Ran `npm test`" /
 * "Running `npm test`", "Read package.json", "Sent you invoice.pdf"), plus its output and failure
 * excerpt. Wording follows Synara's TimelineWorkEntryRow (MIT).
 */
import type { Part } from '@appubot/protocol';
import { basename, formatClockDuration, truncate } from './format';
import { actionSentence } from './computerSummary';
import { diffLines, diffStats } from './diff';

export type ToolCallPart = Extract<Part, { type: 'tool_call' }>;

const rec = (raw: unknown): Record<string, unknown> => (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

export function rawCommand(raw: unknown): string | undefined {
  const c = rec(raw).command ?? rec(raw).cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(String).join(' ');
  return undefined;
}

export function rawPath(raw: unknown): string | undefined {
  const r = rec(raw);
  return str(r.file_path) ?? str(r.path) ?? str(r.filePath) ?? str(r.notebook_path);
}

/** A tool still in flight; a settled message never shows running rows. */
export const isRunning = (t: ToolCallPart, settled: boolean): boolean => !settled && (t.status === 'pending' || t.status === 'in_progress');

/** Which glyph a tool row wears (each client maps these to its own icon set). */
export type ToolIconKey = 'command' | 'read' | 'edit' | 'search' | 'fetch' | 'think' | 'mode' | 'computer' | 'send' | 'ask' | 'tool';

/** The send_file tool's title (agent-runtime `friendlyToolTitle`), and the one older transcripts saved. */
export const isSendFileTitle = (title: string): boolean => title === 'Send file to you' || title === 'Send file to your phone';

export function toolIconKey(t: ToolCallPart): ToolIconKey {
  switch (t.kind) {
    case 'execute': return 'command';
    case 'read': return 'read';
    case 'edit': case 'delete': case 'move': return 'edit';
    case 'search': return 'search';
    case 'fetch': return 'fetch';
    case 'think': return 'think';
    case 'switch_mode': return 'mode';
    case 'computer': return 'computer';
    default:
      if (isSendFileTitle(t.title) || t.title === 'Notify you') return 'send';
      if (t.title === 'Ask you') return 'ask';
      if (t.title === 'Remember' || t.title === 'Update memory' || t.title === 'Forget' || t.title === 'Read memory') return 'think';
      return 'tool';
  }
}

/** Files this call touched, in order. */
export function toolPaths(t: ToolCallPart): string[] {
  const out = t.locations.map((l) => l.path);
  for (const c of t.content) if (c.type === 'diff') out.push(c.path);
  const p = rawPath(t.rawInput);
  if (p) out.push(p);
  return [...new Set(out)];
}

/** `cat a b` / `head -n 5 x` read files rather than "run a command" (Synara's deriveCommandReadTargets). */
export function commandReadTargets(cmd: string): string[] | null {
  const m = /^\s*(?:cat|head|tail|less|more|bat|nl)\s+([^|;&<>`$()]+)$/.exec(cmd);
  if (!m) return null;
  const files = m[1]!.split(/\s+/).filter((a) => a && !a.startsWith('-') && !/^\d+$/.test(a));
  return files.length ? files.map(basename) : null;
}

/* ---------- literal commands (Synara's lib/toolCallLabel deriveLiteralCommand, MIT) ---------- */

const SHELL_WRAPPER_PREFIXES = [
  '/usr/bin/bash -lc ', '/usr/bin/bash -c ', '/bin/bash -lc ', '/bin/bash -c ',
  '/usr/bin/zsh -lc ', '/usr/bin/zsh -c ', '/bin/zsh -lc ', '/bin/zsh -c ',
  '/bin/sh -lc ', '/bin/sh -c ', 'bash -lc ', 'bash -c ', 'zsh -lc ', 'zsh -c ', 'sh -lc ', 'sh -c ',
];
/** Windows' wrappers: PowerShell (`"C:\…\powershell.exe" -NoProfile -Command …`, pwsh) and cmd.exe (`cmd /c …`). */
const WINDOWS_SHELL_WRAPPER = /^(?:"[^"]*\\|[^"\s]*\\)?(?:(?:powershell|pwsh)(?:\.exe)?"?(?:\s+-(?:noprofile|nologo|noninteractive|executionpolicy\s+\w+))*\s+-c(?:ommand)?|cmd(?:\.exe)?"?(?:\s+\/[dsq])*\s+\/c)\s+/i;

/** The first unquoted `&&` or `;` in a command. */
function findShellChain(value: string): { operatorStart: number; commandStart: number } | null {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < value.length - 1; i++) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) { i++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '&' && value[i + 1] === '&') return { operatorStart: i, commandStart: i + 2 };
    if (ch === ';') return { operatorStart: i, commandStart: i + 1 };
  }
  return null;
}

/** `cd dir`, `source x`, `set -e`, `FOO=1`: setup that says nothing about what ran. */
function isShellSetupPreamble(value: string): boolean {
  const v = value.replace(/\s+/g, ' ').trim();
  if (!v) return false;
  return /^(?:builtin\s+)?cd\s+/.test(v)
    || /^(?:source|\.)\s+/.test(v)
    || /^set\s+[-+][A-Za-z]/.test(v)
    || /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=[^\s]+(?:\s+[A-Za-z_][A-Za-z0-9_]*=[^\s]+)*$/.test(v);
}

function stripLeadingShellPreambles(value: string): string {
  let cur = value.trim();
  for (let attempts = 0; attempts < 4; attempts++) {
    const chain = findShellChain(cur);
    if (!chain || !isShellSetupPreamble(cur.slice(0, chain.operatorStart).trim())) return cur;
    cur = cur.slice(chain.commandStart).trim();
  }
  return cur;
}

/**
 * The command a row shows: what actually ran, minus the shell wrapper (`/bin/zsh -lc "…"`) and leading
 * `cd <dir> &&` preambles. Pipes, chains and quoting stay verbatim; whitespace collapses to one line.
 */
export function deriveLiteralCommand(rawCommand: string): string {
  let value = rawCommand.trim();
  const win = WINDOWS_SHELL_WRAPPER.exec(value);
  if (win) value = `sh -c ${value.slice(win[0].length)}`;
  const lowered = value.toLowerCase();
  for (const prefix of SHELL_WRAPPER_PREFIXES) {
    if (!lowered.startsWith(prefix)) continue;
    value = value.slice(prefix.length).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1).trim();
    }
    break;
  }
  return stripLeadingShellPreambles(value).replace(/\s+/g, ' ').trim();
}

const VERBS: Record<string, [string, string]> = {
  send: ['Sent', 'Sending'], click: ['Clicked', 'Clicking'], open: ['Opened', 'Opening'], read: ['Read', 'Reading'],
  write: ['Wrote', 'Writing'], create: ['Created', 'Creating'], ask: ['Asked', 'Asking'], remember: ['Remembered', 'Remembering'],
  save: ['Saved', 'Saving'], take: ['Took', 'Taking'], look: ['Looked', 'Looking'], type: ['Typed', 'Typing'],
  press: ['Pressed', 'Pressing'], search: ['Searched', 'Searching'], run: ['Ran', 'Running'], find: ['Found', 'Finding'],
  list: ['Listed', 'Listing'], get: ['Got', 'Getting'], fetch: ['Fetched', 'Fetching'], show: ['Showed', 'Showing'],
  schedule: ['Scheduled', 'Scheduling'], update: ['Updated', 'Updating'], delete: ['Deleted', 'Deleting'], use: ['Used', 'Using'],
  check: ['Checked', 'Checking'], make: ['Made', 'Making'], add: ['Added', 'Adding'], move: ['Moved', 'Moving'],
  scroll: ['Scrolled', 'Scrolling'], drag: ['Dragged', 'Dragging'], wait: ['Waited', 'Waiting'], switch: ['Switched', 'Switching'],
  focus: ['Focused', 'Focusing'], copy: ['Copied', 'Copying'], paste: ['Pasted', 'Pasting'], notify: ['Notified', 'Notifying'],
  edit: ['Edited', 'Editing'], install: ['Installed', 'Installing'], download: ['Downloaded', 'Downloading'], set: ['Set', 'Setting'],
  'double-click': ['Double-clicked', 'Double-clicking'], 'right-click': ['Right-clicked', 'Right-clicking'],
};

/** "Send file to you" → "Sent file to you" / "Sending file to you". */
export function withTense(title: string, running: boolean): string {
  const m = /^(\S+)(.*)$/s.exec(title.trim());
  const forms = m ? VERBS[m[1]!.toLowerCase()] : undefined;
  return forms && m ? `${forms[running ? 1 : 0]}${m[2]}` : title;
}

export interface Sentence {
  verb: string;
  /** what the call acted on; shown as a mono chip when `chip` */
  object?: string;
  chip?: boolean;
}

const oneLine = (s: string) => truncate(s.replace(/\s*\n\s*/g, ' ⏎ ').trim(), 160);
/** The site a fetch went to ("example.com"); React Native's URL has no `hostname`, so a plain parse backs it up. */
const hostOf = (url: string) => {
  let host: string | undefined;
  try { host = new URL(url).hostname; } catch { /* not a URL, or no URL.hostname (React Native) */ }
  host ||= /^[a-z][\w+.-]*:\/\/(?:[^/?#@]*@)?([^/?#:]+)/i.exec(url)?.[1];
  return host ? host.replace(/^www\./, '') : url;
};
/** "Read /a/b/c.ts" (or "Read C:\a\c.ts") → "c.ts" when the title is just a verb + path. */
const titleObject = (title: string) => { const m = /^\S+\s+(\/\S+|[a-z]:[\\/]\S+)$/i.exec(title.trim()); return m ? basename(m[1]!) : undefined; };

/** What an update_bot call changed, in words ("job and instructions"). */
const BOT_FIELDS: [string, string][] = [['name', 'name'], ['emoji', 'look'], ['color', 'look'], ['shape', 'look'], ['job', 'job'], ['instructions', 'instructions'], ['model_id', 'model']];
const botFields = (r: Record<string, unknown>) => {
  const f = [...new Set(BOT_FIELDS.filter(([k]) => r[k] !== undefined).map(([, w]) => w))];
  return f.length > 1 ? `${f.slice(0, -1).join(', ')} and ${f[f.length - 1]}` : f[0] ?? 'profile';
};

/** Synara's compactPath: a read names its file by the last two path segments ("chat/MessagesTimeline.tsx"). */
const compactPath = (p: string) => { const parts = p.split(/[\\/]/).filter(Boolean); return parts.length <= 2 ? p : parts.slice(-2).join('/'); };

export function toolSentence(t: ToolCallPart, running: boolean): Sentence {
  const v = (done: string, doing: string) => (running ? doing : done);
  const r = rec(t.rawInput);
  const files = toolPaths(t).map(basename);
  switch (t.kind) {
    case 'execute': {
      const cmd = rawCommand(t.rawInput) ?? t.title;
      const reads = commandReadTargets(cmd);
      if (reads) return { verb: v('Read', 'Reading'), object: reads.join(', ') };
      return { verb: v('Ran', 'Running'), object: deriveLiteralCommand(cmd) || oneLine(cmd), chip: true };
    }
    case 'read':
      return { verb: v('Read', 'Reading'), object: toolPaths(t).map(compactPath).join(', ') || titleObject(t.title) || t.title.replace(/^Read\s+/i, '') };
    // Synara's edit rows always say "Edited", live or settled, new file or not
    case 'edit': return { verb: 'Edited', object: files.join(', ') || titleObject(t.title) };
    case 'delete': return { verb: v('Deleted', 'Deleting'), object: files.join(', ') || titleObject(t.title) };
    case 'move': return { verb: v('Moved', 'Moving'), object: files.join(' → ') || titleObject(t.title) };
    case 'search': {
      const pattern = str(r.pattern) ?? str(r.glob);
      if (pattern) return { verb: v('Searched for', 'Searching for'), object: oneLine(pattern), chip: true };
      const q = str(r.query);
      return q ? { verb: v('Searched for', 'Searching for'), object: `“${truncate(q, 80)}”` } : { verb: withTense(t.title, running) };
    }
    case 'fetch': {
      const url = str(r.url);
      if (url) return { verb: v('Fetched', 'Fetching'), object: hostOf(url) };
      const q = str(r.query);
      return q ? { verb: v('Searched the web for', 'Searching the web for'), object: `“${truncate(q, 80)}”` } : { verb: withTense(t.title, running) };
    }
    case 'computer':
      return { verb: t.computer?.action ? actionSentence(t.computer.action, running) : withTense(t.title, running) };
    case 'switch_mode': return { verb: v('Switched mode', 'Switching mode') };
    case 'think': return { verb: t.title || v('Thought', 'Thinking') };
    default: break;
  }
  if (isSendFileTitle(t.title)) {
    const p = rawPath(t.rawInput);
    return { verb: v('Sent you', 'Sending you'), object: p ? basename(p) : 'a file' };
  }
  switch (t.title) {
    case 'Ask you': return { verb: v('Asked you a question', 'Asking you a question') };
    case 'Notify you': return { verb: v('Notified you', 'Notifying you'), object: str(r.title) ? `“${truncate(str(r.title)!, 60)}”` : undefined };
    case 'Remember': return { verb: v('Saved to memory', 'Saving to memory') };
    case 'Update memory': return { verb: str(r.text) ? v('Updated its memory', 'Updating its memory') : v('Removed from its memory', 'Removing from its memory') };
    case 'Forget': return { verb: v('Removed from its memory', 'Removing from its memory') };
    case 'Read memory': return { verb: v('Read its memory', 'Reading its memory') };
    case 'Save skill': return { verb: v('Saved skill', 'Saving skill'), object: str(r.name) };
    // the bot tools: no bot_id is the bot itself
    case 'List bots': return { verb: v('Listed the bots', 'Listing the bots') };
    case 'Look at a bot': return { verb: str(r.bot_id) ? v('Looked at a bot', 'Looking at a bot') : v('Looked at its profile', 'Looking at its profile') };
    case 'Update a bot': return { verb: str(r.bot_id) ? v('Updated a bot’s', 'Updating a bot’s') : v('Updated its', 'Updating its'), object: botFields(r) };
    case 'Read a bot’s chat': return { verb: str(r.bot_id) ? v('Read a bot’s chat', 'Reading a bot’s chat') : v('Read its own chat', 'Reading its own chat') };
    case 'ToolSearch': return { verb: v('Loaded tools', 'Loading tools') };
    case 'TodoWrite': return { verb: v('Updated the plan', 'Updating the plan') };
    default: return { verb: withTense(t.title || 'Tool call', running) };
  }
}

/** Plain-text form of a sentence (group lines, tooltips, copy). */
export const sentenceText = (s: Sentence): string => (s.object ? `${s.verb} ${s.object}` : s.verb);

/** Output text of a call: terminal output, else its text content without the wrapping code fence. */
export function toolOutput(t: ToolCallPart): string | undefined {
  const term = t.content.find((c) => c.type === 'terminal');
  if (term?.type === 'terminal' && term.output) return term.output;
  const texts = t.content.filter((c) => c.type === 'text').map((c) => (c.type === 'text' ? c.text : ''));
  if (texts.length) return texts.map((x) => x.replace(/^```[\w-]*\n([\s\S]*?)\n?```\s*$/, '$1')).join('\n');
  return typeof t.rawOutput === 'string' ? t.rawOutput : undefined;
}

/** Exit code and the first line that explains a failed call (shown under the row without opening it). */
export function failureInfo(t: ToolCallPart): { exitCode?: number; excerpt?: string } {
  const out = toolOutput(t) ?? '';
  const code = /Exit code (\d+)/.exec(out)?.[1];
  const lines = out.split('\n').map((l) => l.trim()).filter((l) => l && !/^Exit code \d+$/.test(l) && !l.startsWith('```'));
  // the line that explains it: an error-looking line, else the last thing printed
  const excerpt = lines.find((l) => /error|no such|not found|denied|cannot|can't|fatal|failed|invalid|unknown/i.test(l)) ?? lines[lines.length - 1];
  return { exitCode: code !== undefined ? Number(code) : undefined, excerpt: excerpt ? truncate(excerpt, 200) : undefined };
}

const statsCache = new WeakMap<object, { added: number; removed: number }>();
/** +/- line counts of one diff block (memoized per content object). */
export function diffStat(c: { oldText: string | null; newText: string }): { added: number; removed: number } {
  let s = statsCache.get(c);
  if (!s) { s = diffStats(diffLines(c.oldText, c.newText)); statsCache.set(c, s); }
  return s;
}

/** Per-file rows of an edit call ("Edited a.ts +3 -1"), in the order the call touched them. */
export function editedFiles(t: ToolCallPart): { path: string; added: number; removed: number }[] {
  return toolPaths(t).map((path) => {
    let added = 0;
    let removed = 0;
    for (const c of t.content) {
      if (c.type !== 'diff' || c.path !== path) continue;
      const s = diffStat(c);
      added += s.added;
      removed += s.removed;
    }
    return { path, added, removed };
  });
}

/**
 * The tail after a row's sentence (Synara's formatLiveActivityMeta + workLog settling, MIT): only what the
 * sentence can't say. Running: " · 12s elapsed" (ticks live from `since`); failed: " · Failed · exit 1"; still
 * running when the turn was stopped: " · Cancelled · 4s elapsed". A call that simply finished has no tail.
 */
export type ToolMeta = { tone: 'running'; since: number } | { tone: 'failed' | 'cancelled'; text: string };

export function toolMeta(t: ToolCallPart, opts: { settled: boolean; interrupted?: boolean; endedAt?: number }): ToolMeta | null {
  if (t.status === 'failed') {
    const code = failureInfo(t).exitCode;
    return { tone: 'failed', text: code !== undefined ? `Failed · exit ${code}` : 'Failed' };
  }
  const open = t.status === 'pending' || t.status === 'in_progress';
  if (!open) return null;
  if (!opts.settled) return t.startedAt ? { tone: 'running', since: t.startedAt } : null;
  if (!opts.interrupted) return null;
  const end = t.endedAt ?? opts.endedAt;
  const elapsed = t.startedAt && end !== undefined && end >= t.startedAt ? formatClockDuration(end - t.startedAt) : null;
  return { tone: 'cancelled', text: elapsed ? `Cancelled · ${elapsed} elapsed` : 'Cancelled' };
}

/**
 * A thought as one work row (Synara's cleanReasoningProgressText, MIT): its last readable line, with comments and
 * lightweight markdown (heading marks, a wrapping **bold**, __bold__ or `code`) removed; null when nothing reads.
 */
export function thoughtLine(text: string): string | null {
  const lines = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('<!--'));
  const last = lines[lines.length - 1];
  if (!last) return null;
  const trimmed = last
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .replace(/^__(.+)__$/, '$1')
    .replace(/^`(.+)`$/, '$1')
    .trim();
  const withoutReasoning = trimmed.replace(/^reasoning(?:\s+(?:update|trace|summary))?\b[\s:.-]*/i, '').trim();
  const withoutRunning = withoutReasoning.replace(/^running\b[\s:.-]*/i, '').trim();
  return withoutRunning || withoutReasoning || null;
}
