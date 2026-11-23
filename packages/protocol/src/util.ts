import type { Bot, Message, Part, Thread } from './entities';
import { offeredModels } from './cloud';

/**
 * How much of a bot's memory (MEMORY.md) a new agent session's first prompt carries, in characters: its top lines and
 * the newest ones when it is longer (chat-core `capMemory`). The bot's tools warn it past this; the editors show it.
 */
export const MEMORY_LOAD_MAX = 12_000;

type ActiveFields = Pick<Thread, 'createdAt' | 'lastActiveAt'>;
/** When a thread was started or last sent a message (threads from older versions: when they were made). */
export const threadActiveAt = (t: ActiveFields): number => t.lastActiveAt ?? t.createdAt;

/**
 * A bot's current thread: of its threads that aren't Telegram chats, the one started or sent to last
 * (`threadActiveAt`). Turns that name no thread go there (routines, teach mode, a send without `threadId`), and the
 * apps open a bot on it. Starting a thread (`threads.start`) or sending in an older one makes it current. Shared by
 * the desktop core (`threads.chatFor`), the desktop UI and mobile.
 */
export function currentChat<T extends Pick<Thread, 'botId' | 'source' | 'createdAt' | 'id' | 'lastActiveAt'>>(threads: readonly T[], botId: string): T | undefined {
  let best: T | undefined;
  for (const t of threads) {
    if (t.botId !== botId || t.source === 'channel' || t.source === 'group') continue;
    if (!best) { best = t; continue; }
    const a = threadActiveAt(t);
    const b = threadActiveAt(best);
    if (a > b || (a === b && (t.createdAt > best.createdAt || (t.createdAt === best.createdAt && t.id > best.id)))) best = t;
  }
  return best;
}

/**
 * A bot's threads for its thread list, its Telegram chats included: the latest activity first (`updatedAt`: its last
 * message, a reply finishing). Shared by the desktop's sidebar and thread switcher and the phone's threads sheet.
 */
export function botThreads<T extends Pick<Thread, 'botId' | 'source' | 'updatedAt' | 'createdAt' | 'id'>>(threads: readonly T[], botId: string): T[] {
  // a bot's thread for a group belongs to the room, never to its own list
  return threads
    .filter((t) => t.botId === botId && t.source !== 'group')
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/**
 * Apps (Composio) a bot may use: every connected app is on for every bot unless the bot turned it off, so a new
 * connection starts on for all of them. Shared by the desktop core (it limits each bot's Composio session to these)
 * and the per-bot switches on desktop and mobile. `appsOff` may be missing on bots saved by older versions.
 */
export function appOn(bot: Pick<Bot, 'appsOff'>, slug: string): boolean {
  return !(bot.appsOff ?? []).includes(slug);
}

/** The connected app slugs (`connected`, any order, repeats allowed) this bot may use, sorted and unique. */
export function appsOn(bot: Pick<Bot, 'appsOff'>, connected: Iterable<string>): string[] {
  return [...new Set(connected)].filter((s) => appOn(bot, s)).sort();
}

/**
 * Apps that connect on their own server with the person's own account (no Composio sign-in): their slugs end in
 * `_direct`, so every client can tell one by its slug alone.
 */
export const DIRECT_APP_SUFFIX = '_direct';
export function isDirectApp(slug: string): boolean {
  return slug.endsWith(DIRECT_APP_SUFFIX) && slug.length > DIRECT_APP_SUFFIX.length;
}

/** The bot's `appsOff` after switching one app on or off (the patch for `bots.update`). */
export function withAppOn(bot: Pick<Bot, 'appsOff'>, slug: string, on: boolean): string[] {
  const off = (bot.appsOff ?? []).filter((s) => s !== slug);
  return on ? off : [...off, slug];
}

/** Apply a streaming delta to a message (shared by desktop + mobile stores). Mutates and returns the message. */
export function applyDelta(msg: Message, partIndex: number, partType: 'text' | 'thought', delta: string): Message {
  while (msg.parts.length <= partIndex) msg.parts.push({ type: partType, text: '' } as Part);
  const part = msg.parts[partIndex]!;
  if (part.type === 'text' || part.type === 'thought') part.text += delta;
  else msg.parts[partIndex] = { type: partType, text: delta } as Part;
  msg.updatedAt = Date.now();
  return msg;
}

export function setPart(msg: Message, partIndex: number, part: Part): Message {
  while (msg.parts.length < partIndex) msg.parts.push({ type: 'text', text: '' });
  msg.parts[partIndex] = part;
  msg.updatedAt = Date.now();
  return msg;
}

/** Markdown → plain text for previews and notifications (links keep their label, code keeps its content). */
/** A Markdown table row (`| a | b |`) as its cells' text, `a · b`; empty cells dropped. */
function tableRowText(line: string): string {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).filter(Boolean).join(' · ');
}

export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1')
    // tables: the separator row goes, every other row (one that starts with a pipe) keeps its cells' text
    .replace(/^(?=[^\n]*\|)(?=[^\n]*--)[ \t|:-]+$\n?/gm, '')
    .replace(/^[ \t]*\|.*\|.*$/gm, tableRowText)
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^ {0,3}#{1,6}\s+/gm, '')
    .replace(/^ {0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1');
}

/**
 * A thread's saved preview as people read it: one a computer from before saved for a turn that only ran a tool
 * ("⚙ ToolSearch") reads as none, so a list shows the reply before it or the bot's job, never a tool's name.
 */
export const shownPreview = (preview: string | undefined): string => (preview && !preview.startsWith('⚙ ') ? preview : '');

/** A message's line in lists: its words, else a file, page or voice note it carries; a tool call alone has none. */
export function messagePreview(msg: Message, max = 120): string {
  const t = stripMarkdown(msg.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join(' ')).replace(/\s+/g, ' ').trim();
  if (t) return t.length > max ? t.slice(0, max - 1) + '…' : t;
  const file = msg.parts.find((p) => p.type === 'file') as Extract<Part, { type: 'file' }> | undefined;
  if (file) return `📎 ${file.file.name}`;
  const page = msg.parts.find((p) => p.type === 'page') as Extract<Part, { type: 'page' }> | undefined;
  if (page) return `▦ ${page.title}`;
  if (msg.parts.some((p) => p.type === 'voice')) return '🎙 Voice message';
  return '';
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'bot';
}

let counter = 0;
export function newId(prefix = ''): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  counter = (counter + 1) % 1296;
  return `${prefix}${prefix ? '_' : ''}${t}${r}${counter.toString(36).padStart(2, '0')}`;
}

/**
 * Agents that can have profiles (other accounts of the same agent, `Provider.profile`), with the env var that points
 * the CLI at a profile's own config folder: Claude Code, Codex, and Google Antigravity once added from the ACP registry.
 */
export const PROFILE_HOME_ENV: Readonly<Record<string, string>> = { 'claude-code': 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', 'antigravity-acp': 'GEMINI_HOME' };

/** A profile's provider id: `<of>@<slug>`. */
export function profileId(of: string, slug: string): string {
  return `${of}@${slug}`;
}

/**
 * The agent a provider id runs: the built-in for a profile (`claude-code@work` -> `claude-code`), else the id itself.
 * Whatever is keyed by agent (its logo, modes, login check) looks it up through this.
 */
export function providerBase(id: string): string {
  const at = id.indexOf('@');
  return at > 0 ? id.slice(0, at) : id;
}

/** Reasoning efforts offered before an agent's session has said which (Claude Code's and Codex's usual ones). */
export const DEFAULT_EFFORTS: readonly { id: string; name: string }[] = [
  { id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' },
];

/**
 * The models, reasoning efforts and permission modes an agent offers, as its latest session reported them (agents only list them in a
 * session): what the bot editors and Settings pick from. No session yet: no models (the agent's own default) and the
 * usual efforts.
 */
export function agentChoices(threads: readonly Pick<Thread, 'providerId' | 'models' | 'efforts' | 'modes' | 'updatedAt'>[], providerId: string): { models: Thread['models']; efforts: Thread['efforts']; modes: Thread['modes'] } {
  let best: (typeof threads)[number] | undefined;
  for (const t of threads) if (t.providerId === providerId && t.models.length && (!best || t.updatedAt > best.updatedAt)) best = t;
  return { models: offeredModels(providerId, best?.models ?? []), efforts: best?.efforts.length ? best.efforts : [...DEFAULT_EFFORTS], modes: best?.modes ?? [] };
}

/**
 * The ACP registry (Settings › Agents › More agents): any agent in it can be added and run like a built-in. Off, only
 * the built-in agents are offered, and agents added from it stay saved but aren't run.
 */
export const ACP_REGISTRY = true;

/**
 * PostHog, US cloud: the app's anonymous usage analytics (main's AnalyticsService). The project's key isn't in the
 * source: the Release workflow builds it in (`MAIN_VITE_POSTHOG_KEY`), so builds made from a clone send nothing.
 */
export const POSTHOG = { host: 'https://us.i.posthog.com' } as const;

/**
 * Crisp: the support chat ("Chat with Sarthak") everywhere: the website's widget, the desktop's chat window
 * (electron/supportChat.ts) and the phone's support page. The website id is public (it is in every page's widget).
 */
export const CRISP = {
  websiteId: 'b64a1400-d30b-4de3-b7c1-89b542162d68',
  /** the widget's loader, for web pages */
  script: 'https://client.crisp.chat/l.js',
  /** Crisp's hosted chat page: the apps open this rather than running Crisp's script themselves */
  chatPage: 'https://go.crisp.chat/chat/embed/',
} as const;

/** Who is writing, when the app knows: filled in on Crisp's side, so they aren't asked again. */
export interface SupportUser {
  email?: string;
  name?: string;
}

/** Crisp's hosted chat page for AppuBot, with what's known about the user (Crisp's `user_email` / `user_nickname`). */
export function crispChatUrl(user: SupportUser = {}): string {
  const q = new URLSearchParams({ website_id: CRISP.websiteId });
  const email = user.email?.trim();
  const name = user.name?.trim();
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) q.set('user_email', email);
  if (name) q.set('user_nickname', name.slice(0, 80));
  return `${CRISP.chatPage}?${q.toString()}`;
}

/** Pages the support chat may show in its own window or view: Crisp's hosted chat and Crisp's own pages. */
export function isCrispPage(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'crisp.chat' || u.hostname.endsWith('.crisp.chat'));
  } catch {
    return false;
  }
}

/**
 * Agents whose session modes are permission levels (Claude Code: Auto / Bypass permissions; Codex: read-only / auto /
 * full access): AppuBot offers their own Auto and Bypass. Other agents' modes are ways of working (Cursor's Agent /
 * Plan / Ask) or their own levels (Gemini's yolo): they get AppuBot's two choices instead, which AppuBot applies itself
 * (agent-runtime `APPROVAL_MODES`). Every agent has a "Permissions" picker either way.
 */
export const PERMISSION_MODE_AGENTS: ReadonlySet<string> = new Set(['claude-code', 'codex']);
export const hasPermissionModes = (providerId: string): boolean => PERMISSION_MODE_AGENTS.has(providerBase(providerId));

/**
 * The computer AppuBot runs on, as people call it (`platform` is Node's `process.platform`): "Mac", "PC" on Windows,
 * else "computer". Words shown to the user and to the bots ("this Mac") go through it.
 */
export function machineName(platform: string): string {
  return platform === 'darwin' ? 'Mac' : platform === 'win32' ? 'PC' : 'computer';
}

/** The app that shows files in their folder: Finder, File Explorer, else the file manager. */
export function fileManagerName(platform: string): string {
  return platform === 'darwin' ? 'Finder' : platform === 'win32' ? 'File Explorer' : 'the file manager';
}

/**
 * Computer use (bots seeing and driving the user's apps) runs on macOS, Windows and Linux: Cua Driver reads each
 * system's accessibility tree (macOS AX, Windows UI Automation, Linux AT-SPI) and sends input to app windows. macOS
 * adds the native helper (quicker window focus, launches and frames). Anywhere else bots run without it.
 */
export function computerUseSupported(platform: string): boolean {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux';
}
