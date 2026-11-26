/**
 * Dev-only: seed data for the in-memory mock gateway.
 */
import { mockRosterMany, rosterExtras } from './mockRoster';
import {
  SettingsSchema,
  messagePreview,
  type Bot, type Channel, type ComputerStatus, type Device, type FileAttachment, type Message, type PermissionRequest,
  type Provider, type Routine, type Skill, type Snapshot, type SystemInfo, type Thread,
  type Group, type GroupMessage,
} from '@appubot/protocol';
import type { RightTab, SettingsSection } from '../lib/store';
import { buildMessages } from './mockMessages';
import { MOCK_REGISTRY } from './mockRegistry';
import { mockVoiceStatus } from './mockVoice';
import { mockCharacters, mockCharactersWorn } from './mockCharacters';
import { MOCK_LIMITS_STATES, mockLimits, type MockLimitsState } from './mockLimits';
import { stressSnapshot } from './mockStress';
import { APPU_WS, COMMANDS, DAY, EFFORTS, FILM_IDS, FILM_PIXEL_CHAT, HOST_NAME, HOUR, IDS, LAN_IP, LEDGER_WS, MIN, MODELS, MODES, PORT, T0, TS_DNS, TS_IP, ago } from './mockIds';

/* ---------- URL switches ---------- */
export interface MockOptions {
  onboarded: boolean;
  /** `?cloudonly=1`: this Mac's "Only in the cloud" is on (Settings › Account › Where your bots work) */
  cloudOnly?: boolean;
  theme?: 'light' | 'dark';
  panel?: RightTab;
  /** `?page=apps` opens the Connect apps popup, `?page=connected` on its connected apps */
  page?: 'apps' | 'connected';
  /** `?bot=bot_ledger` opens another bot than Appu */
  bot?: string;
  approval: boolean;
  /** `?working=1`: Appu is mid-turn in its main thread, on a tool step (the working row's status line) */
  working: boolean;
  /** `?forms=1`: Appu's main thread ends with a form card and a Vault card waiting to be filled in */
  forms: boolean;
  /** `?groups=1`: a group of Appu and Ledger with a conversation, open on screen */
  groups: boolean;
  /** `?groups=pinned`: the group pinned to the top of the roster */
  groupsPinned?: boolean;
  /** `?groups=film`: the launch film's group instead: five bots (Appu leading), a launch day's conversation with
   * @mentions, a group goal on, one member working */
  groupsFilm: boolean;
  /** signed in to Composio (`?apps=onboarding` starts signed out) */
  appsKey: boolean;
  /** `?apps=none`: nothing connected yet; `?apps=many`: fifteen apps connected */
  appsSeed?: 'none' | 'many';
  /** `?settings=providers` (any section) opens Settings there */
  settings?: SettingsSection;
  /** `?threads=1` opens the side panel on its Threads tab, with one thread unread */
  threads: boolean;
  /** `?editor=1` opens the side panel on Details (a bot's settings) for the bot on screen */
  editor: boolean;
  /** `?editor=new`: the New bot dialog open */
  newBot: boolean;
  /** `?update=required`: this version was stopped (the Update required screen) */
  updateRequired: boolean;
  /** `?update=downloading|ready`: the app's own update on its way or downloaded (the sidebar's update row) */
  updateState?: 'downloading' | 'ready';
  /** `?gift=1|signedout|on|over`: AppuBot's launch gift card (the free Claude day) */
  gift?: 'offer' | 'signedout' | 'on' | 'over';
  /**
   * `?computer=on-screen|background|waiting`: Appu is using the computer in its main thread, with its window in front,
   * in the background, or waiting for the user to pause (add `&approval=0`: an approval hides the line)
   */
  computer?: 'on-screen' | 'background' | 'waiting';
  /** `?thread=media` opens Appu's thread of media and odd cases (images, a page, voice, a failed turn); `?thread=routines`
   * its chat where a routine runs every 10 minutes (runs with nothing to say fold into one line); `?thread=work` a long
   * working turn and one still running (the work trail: add `&work=1`); `?thread=handoff` a chat with Appu where
   * tasks were handed to Ledger with @Ledger, its answers in its name */
  thread?: 'media' | 'routines' | 'work' | 'failed' | 'handoff';
  /** `?longname=1`: Appu has a very long name (truncation in the header, roster and composer) */
  longName: boolean;
  /**
   * `?profile=sarthakfour`: a Claude Code profile of that name is the agent for new bots and Appu's, on Sonnet 5
   * (Claude Code's own list, as a real session reports it): the model picker's trigger with a long account label
   */
  profile?: string;
  /**
   * `?limits=low|out|apikey|none`: the agents' plan limits (dev/mockLimits.ts): Claude Code running low, Codex used up,
   * an API-key sign-in with none, or a computer from before plan limits (no `limits` in its snapshot)
   */
  limits?: MockLimitsState;
  /**
   * `?agents=signin`: a fresh Windows PC's Agents page: Claude Code installed but signed out (its logins as the runtime
   * lists them, the subscription first), Codex not installed (AppuBot downloads it itself); `?agents=installing`: Codex
   * being installed
   */
  agents?: 'signin' | 'installing';
}

const PANELS: readonly RightTab[] = ['threads', 'bot', 'skills', 'memory', 'routines', 'files', 'computer'];
const SECTIONS: readonly SettingsSection[] = ['general', 'vault', 'apps', 'appearance', 'providers', 'devices', 'computer', 'channels', 'voice', 'usage', 'instructions', 'storage', 'about', 'whats-new', 'permissions', 'account', 'billing', 'team', 'transfer', 'import'];

export function readOptions(): MockOptions {
  const q = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const theme = q.get('theme');
  const panel = q.get('panel');
  return {
    onboarded: q.get('onboarding') !== '1',
    cloudOnly: q.get('cloudonly') === '1',
    theme: theme === 'dark' || theme === 'light' ? theme : undefined,
    panel: PANELS.find((p) => p === panel),
    page: q.get('page') === 'apps' ? 'apps' : q.get('page') === 'connected' ? 'connected' : undefined,
    bot: q.get('bot') ?? undefined,
    approval: q.get('approval') !== '0' && q.get('working') !== '1',
    working: q.get('working') === '1',
    forms: q.get('forms') === '1',
    groups: q.get('groups') === '1' || q.get('groups') === 'film' || q.get('groups') === 'pinned',
    groupsPinned: q.get('groups') === 'pinned',
    groupsFilm: q.get('groups') === 'film',
    appsKey: q.get('apps') !== 'onboarding',
    appsSeed: q.get('apps') === 'none' ? 'none' : q.get('apps') === 'many' ? 'many' : undefined,
    settings: SECTIONS.find((x) => x === q.get('settings')) ?? (q.get('settings') === 'cloud' ? 'billing' : undefined),
    threads: q.get('threads') === '1',
    editor: q.get('editor') === '1',
    newBot: q.get('editor') === 'new',
    updateRequired: q.get('update') === 'required',
    updateState: (['downloading', 'ready'] as const).find((x) => x === q.get('update')),
    gift: q.get('gift') === '1' ? 'offer' : (['signedout', 'on', 'over'] as const).find((x) => x === q.get('gift')),
    computer: (['on-screen', 'background', 'waiting'] as const).find((x) => x === q.get('computer')),
    thread: (['media', 'routines', 'work', 'failed', 'handoff'] as const).find((x) => x === q.get('thread')),
    longName: q.get('longname') === '1',
    profile: q.get('profile')?.trim() || undefined,
    limits: MOCK_LIMITS_STATES.find((x) => x === q.get('limits')),
    agents: (['signin', 'installing'] as const).find((x) => x === q.get('agents')),
  };
}

/* ---------- groups (?groups=1, ?groups=film) ---------- */
export const GROUP_ID = 'grp_mock_launch';
/** the film's three extra members (`?groups=film`) */
const FILM_BOTS: { id: string; name: string; color: string; shape: Bot['shape']; job: string }[] = [
  { id: FILM_IDS.scout, name: 'Scout', color: '#14B8A6', shape: 'hex', job: 'Research and lists' },
  { id: FILM_IDS.pixel, name: 'Pixel', color: '#EC4899', shape: 'cloud', job: 'Graphics and mockups' },
  { id: FILM_IDS.echo, name: 'Echo', color: '#6366F1', shape: 'drop', job: 'Posts and threads' },
];
export function mockGroup(film = false): Group {
  if (film) {
    const now = Date.now();
    return {
      id: GROUP_ID, name: 'Launch team', botIds: [IDS.appu, IDS.ledger, FILM_IDS.scout, FILM_IDS.pixel, FILM_IDS.echo], leadId: IDS.appu,
      lastMessagePreview: 'Appu: All set for Friday 9:00.', working: [FILM_IDS.echo], workingIn: { [FILM_IDS.echo]: GROUP_ID },
      chats: [{ id: GROUP_ID, title: 'We launch on Friday', lastMessagePreview: 'Appu: All set for Friday 9:00.', createdAt: ago(30 * MIN), lastActiveAt: ago(MIN),
        goal: { objective: 'Get the Friday launch ready: the thread, the graphic, the ad budget and the creators', status: 'active', turns: 9, maxTurns: 40, startedAt: now - 20 * MIN, updatedAt: now - MIN } }],
      createdAt: ago(3 * DAY), updatedAt: ago(MIN), lastActiveAt: ago(MIN),
    };
  }
  return { id: GROUP_ID, name: 'Launch team', botIds: [IDS.appu, IDS.ledger], lastMessagePreview: 'Appu: All set: the venue is booked and the budget sheet is updated.', working: [], workingIn: {}, chats: [], createdAt: ago(3 * DAY), updatedAt: ago(10 * MIN), lastActiveAt: ago(10 * MIN) };
}
export function mockGroupMessages(film = false): GroupMessage[] {
  const t0 = ago(film ? 24 * MIN : 42 * MIN);
  const m = (i: number, from: GroupMessage['from'], text: string, mentions: string[] = [], hop = 0): GroupMessage => ({ id: `gm_mock_${i}`, groupId: GROUP_ID, from, text, mentions, hop, createdAt: t0 + i * (film ? 150_000 : 90_000) });
  const appu = { kind: 'bot' as const, botId: IDS.appu, name: 'Appu' };
  const ledger = { kind: 'bot' as const, botId: IDS.ledger, name: 'Ledger' };
  if (film) {
    const scout = { kind: 'bot' as const, botId: FILM_IDS.scout, name: 'Scout' };
    const pixel = { kind: 'bot' as const, botId: FILM_IDS.pixel, name: 'Pixel' };
    const echo = { kind: 'bot' as const, botId: FILM_IDS.echo, name: 'Echo' };
    return [
      m(0, { kind: 'user' }, 'We launch on Friday. Get everything ready: the thread, the graphic, the ad budget and the creators.'),
      m(1, appu, 'On it. @Pixel make the launch graphic, @Echo draft the X thread, @Ledger check what’s left for ads, @Scout find creators who covered tools like ours.', [FILM_IDS.pixel, FILM_IDS.echo, IDS.ledger, FILM_IDS.scout], 1),
      m(2, ledger, '₹48,000 left for ads this month. I’d keep ₹10,000 back for Saturday.', [], 2),
      m(3, scout, 'Found 12 creators with 50k+ followers who reviewed AI tools this month. The list is in the shared sheet.', [], 3),
      m(4, pixel, 'Launch graphic is done, in three sizes: X, LinkedIn and Instagram.', [], 4),
      m(5, echo, 'Thread drafted: six posts, the video first. @Pixel can you put the graphic on the first one?', [FILM_IDS.pixel], 5),
      m(6, pixel, 'Done, it’s on post one.', [], 6),
      m(7, appu, 'All set for Friday 9:00: thread scheduled, graphic on, ₹38,000 on ads and 12 creators emailed. Shall I send it?', [], 7),
    ];
  }
  return [
    m(0, { kind: 'user' }, 'Get the Goa offsite sorted for the first week of December: venue, budget and the invite.'),
    m(1, appu, 'On it. @Ledger pull the travel budget we have left this quarter and what a 40-person venue cost last year.', [IDS.ledger], 1),
    m(2, ledger, '₹6.4L left in travel for the quarter. Last year’s venue (Alila Diwa, 38 people, 3 nights) came to ₹4.1L all in.', [], 2),
    m(3, appu, 'Thanks. Shortlisting three venues under ₹4.5L now and drafting the invite; I’ll book once you confirm the dates.', [], 3),
    m(4, { kind: 'user' }, 'Dec 4 to 7 works. Book the one closest to the airport.'),
    m(5, appu, 'All set: the venue is booked and the budget sheet is updated.', [], 1),
  ];
}

/* ---------- entities ---------- */
const bots: Bot[] = [
  {
    id: IDS.appu, slug: 'appu', name: 'Appu', emoji: '🪔', color: '#FF7A1F', shape: 'circle', job: 'Your teammate on this Mac',
    instructions: 'You are Appu, Sarthak\'s helpful teammate on his Mac. Be concise, ask before deleting anything, and keep invoices in ~/AppuBot/appu/invoices.',
    providerId: 'claude-code', modelId: 'sonnet', modeId: 'auto', effort: 'medium', fast: false, workspace: APPU_WS, computerUse: true, autoApprove: 'safe', appsOff: [], pinned: true, chief: true,
    createdAt: ago(40 * DAY), updatedAt: ago(2 * DAY),
  },
  {
    id: IDS.ledger, slug: 'ledger', name: 'Ledger', emoji: '🧾', color: '#2E8EFF', shape: 'squircle', job: 'Bookkeeping and invoices',
    instructions: 'You keep the books for AppGrowthKit. Categorise expenses, track GST and prepare monthly summaries.',
    // the bookkeeper has no business in the code
    providerId: 'codex', modelId: 'opus', modeId: 'auto', effort: 'high', fast: false, workspace: LEDGER_WS, computerUse: false, autoApprove: 'never', appsOff: ['github'], pinned: false, chief: false,
    createdAt: ago(21 * DAY), updatedAt: ago(5 * DAY),
  },
];

function thread(p: Pick<Thread, 'id' | 'botId' | 'title'> & Partial<Thread>): Thread {
  const bot = bots.find((b) => b.id === p.botId) ?? bots[0]!;
  return {
    providerId: bot.providerId, cwd: bot.workspace, status: 'idle', modeId: 'auto', modelId: bot.modelId ?? 'sonnet', effortId: bot.effort,
    modes: MODES, models: MODELS, efforts: EFFORTS, fastAvailable: bot.providerId === 'claude-code', fast: bot.fast, commands: COMMANDS, source: 'desktop', lastMessagePreview: '', createdAt: T0, updatedAt: T0,
    acpSessionId: `sess_${p.id}`,
    // how full the context is (the composer's ring)
    context: { used: 84_300, size: 200_000 },
    ...p,
  };
}

export function newThreadFor(bot: Bot, id: string, title: string, extra: Partial<Thread> = {}): Thread {
  const now = Date.now();
  return {
    id, botId: bot.id, title, providerId: bot.providerId, cwd: bot.workspace, status: 'idle', modeId: bot.modeId ?? 'auto',
    modelId: bot.modelId ?? 'sonnet', effortId: bot.effort, modes: MODES, models: MODELS, efforts: EFFORTS, fastAvailable: bot.providerId === 'claude-code', fast: bot.fast,
    commands: COMMANDS, source: 'desktop',
    lastMessagePreview: '', createdAt: now, updatedAt: now, ...extra,
  };
}

/** One of each state the Providers page draws: logged in (with and without a ⋯ menu), logged out, not installed,
 * login unknown, and switched off. */
const NO_CAPS = { loadSession: false, image: false, audio: false, embeddedContext: false };
const ACP_CAPS = { loadSession: true, image: true, audio: false, embeddedContext: true };
const ADAPTERS = '/Applications/AppuBot.app/Contents/Resources/app.asar.unpacked/node_modules/@agentclientprotocol';
const providers: Provider[] = [
  {
    id: 'claude-code', name: 'Claude Code', description: "Anthropic's coding agent. Uses your Claude subscription or API key.", command: '$node', args: [`${ADAPTERS}/claude-agent-acp/dist/index.js`], env: {},
    icon: 'sparkles', builtin: true, enabled: true, installHint: 'npm i -g @agentclientprotocol/claude-agent-acp', installed: true, authStatus: 'authenticated',
    authMethods: [{ id: 'claude-ai-login', name: 'Claude Subscription' }], capabilities: ACP_CAPS, version: '0.89.1',
    auth: { state: 'logged_in', account: 's***@appgrowthkit.com', plan: 'Max', checkedAt: T0 }, canLogOut: true, keysSaved: [],
    // its CLI is behind npm's latest
    latestVersion: '2.1.30', updateAvailable: true, update: { current: '2.1.24', checkedAt: T0, via: 'claude update', running: false },
  },
  {
    id: 'codex', name: 'Codex', description: "OpenAI's coding agent. Uses your ChatGPT plan or an API key.", command: '$node', args: [`${ADAPTERS}/codex-acp/dist/index.js`], env: {},
    icon: 'code', builtin: true, enabled: true, installHint: 'npm i -g @agentclientprotocol/codex-acp', installed: true, authStatus: 'needs_auth',
    authMethods: [{ id: 'chatgpt', name: 'Sign in with ChatGPT' }], capabilities: ACP_CAPS, version: '2.2.2',
    auth: { state: 'logged_out', checkedAt: T0 }, canLogOut: true, keysSaved: [],
    latestVersion: '0.62.0', updateAvailable: false, update: { current: '0.62.0', checkedAt: T0, via: 'brew upgrade codex', running: false },
  },
  {
    id: 'cursor', name: 'Cursor', description: "Cursor's agent CLI. Uses your Cursor account.", command: 'cursor-agent', args: ['acp'], env: {},
    icon: 'mouse-pointer', builtin: true, enabled: false, installHint: 'curl https://cursor.com/install -fsS | bash', installed: true, authStatus: 'authenticated',
    authMethods: [], capabilities: NO_CAPS, version: '2026.09.18-9a7762b',
    auth: { state: 'logged_in', account: 's***@gmail.com', checkedAt: T0 }, canLogOut: true, keysSaved: [],
  },
  {
    id: 'grok', name: 'Grok', description: "xAI's Grok Build agent. Uses your Grok account or XAI_API_KEY.", command: 'grok', args: ['--permission-mode', 'default', 'agent', '--no-leader', 'stdio'], env: {},
    icon: 'zap', builtin: true, enabled: false, installHint: 'curl -fsSL https://x.ai/cli/install.sh | bash', installed: false, authStatus: 'not_installed',
    authMethods: [], capabilities: NO_CAPS, canLogOut: false, keysSaved: [],
  },
  {
    id: 'copilot', name: 'GitHub Copilot', description: "GitHub's Copilot CLI. Uses your GitHub account's Copilot plan.", command: 'copilot', args: ['--acp'], env: {},
    icon: 'github', builtin: true, enabled: true, installHint: 'npm i -g @github/copilot', installed: true, authStatus: 'authenticated',
    authMethods: [], capabilities: NO_CAPS, version: '1.0.68',
    auth: { state: 'logged_in', account: '@sarthak', plan: 'GitHub CLI', checkedAt: T0 }, canLogOut: false, keysSaved: [],
    // installed some way AppuBot can't update
    latestVersion: '1.0.71', updateAvailable: true, update: { current: '1.0.68', checkedAt: T0, running: false },
  },
  {
    id: 'opencode', name: 'OpenCode', description: 'The open source agent, with the model providers you sign in to.', command: 'opencode', args: ['acp'], env: {},
    icon: 'terminal', builtin: true, enabled: false, installHint: 'npm i -g opencode-ai', installed: true, authStatus: 'unknown',
    authMethods: [], capabilities: NO_CAPS, version: '2.0.22',
    auth: { state: 'unknown', checkedAt: T0 }, canLogOut: false, keysSaved: [],
  },
  {
    // added from the ACP registry, one version behind it
    id: 'goose', name: 'goose', description: 'A local, extensible, open source AI agent that automates engineering tasks',
    command: '/Users/sarthak/Library/Application Support/AppuBot/agents/goose/1.11.2/goose', args: ['acp'], env: {},
    icon: 'bot', builtin: false, enabled: true, installed: true, authStatus: 'authenticated', authMethods: [{ id: 'oauth', name: 'Sign in', kind: 'agent' }],
    capabilities: ACP_CAPS, version: '1.11.2', canLogOut: false, keysSaved: [], registry: { id: 'goose', version: '1.11.2' },
    latestVersion: '1.12.0', updateAvailable: true, update: { current: '1.11.2', checkedAt: T0, via: 'the ACP registry', running: false },
    iconSvg: MOCK_REGISTRY.find((a) => a.id === 'goose')!.iconSvg,
  },
];

const devices: Device[] = [
  { id: 'dev_iphone', name: "Sarthak's iPhone", platform: 'ios', role: 'full', pairedAt: ago(18 * DAY), lastSeenAt: ago(MIN), lastIp: '100.101.12.44', tailscaleUser: 'sarthak@github', online: true, route: 'tailscale', appVersion: '2026.10.31', pushOn: true },
  { id: 'dev_pixel', name: 'Pixel 8', platform: 'android', role: 'limited', pairedAt: ago(9 * DAY), lastSeenAt: ago(2 * DAY), lastIp: '192.168.1.42', online: false, route: 'lan' },
];

/** Next occurrence of `hour`:00 on one of `days` (0 = Sunday). */
function nextAt(hour: number, days: number[]): number {
  const d = new Date(T0);
  d.setMinutes(0, 0, 0);
  for (let i = 0; i < 8; i++) {
    const c = new Date(d);
    c.setDate(d.getDate() + i);
    c.setHours(hour);
    if (c.getTime() > T0 && days.includes(c.getDay())) return c.getTime();
  }
  return T0 + DAY;
}

const routines: Routine[] = [
  {
    id: IDS.routineInbox, botId: IDS.appu, name: 'Morning inbox digest',
    prompt: 'Check my Mail inbox for anything unread since yesterday. Summarise what needs a reply today and draft short answers for the easy ones.',
    schedule: '0 9 * * 1-5', enabled: true, deliverTo: 'notify', lastRunAt: ago(3 * HOUR), nextRunAt: nextAt(9, [1, 2, 3, 4, 5]), lastThreadId: IDS.main,
    createdAt: ago(30 * DAY), updatedAt: ago(6 * DAY),
  },
  {
    id: IDS.routineInvoices, botId: IDS.ledger, name: 'Weekly invoice reminders',
    prompt: 'Find invoices that are overdue by more than 7 days and draft a polite reminder email for each client.',
    schedule: '0 10 * * 1', enabled: true, deliverTo: 'thread', lastRunAt: ago(7 * DAY), nextRunAt: nextAt(10, [1]), lastThreadId: IDS.ledgerChat,
    createdAt: ago(20 * DAY), updatedAt: ago(20 * DAY),
  },
];

const channels: Channel[] = [
  { id: 'telegram', enabled: true, botId: IDS.appu, status: 'running', allowedUsers: ['sarthak'], pairingCode: '481920', botUsername: 'appu_desk_bot' },
];

const skills: Skill[] = [
  {
    name: 'file-gst-invoice', description: 'Create a GST invoice in Numbers, export it as PDF and file it under invoices/.', source: 'taught', botId: IDS.appu,
    path: `${APPU_WS}/.claude/skills/file-gst-invoice/SKILL.md`, updatedAt: ago(4 * DAY),
    body: '# File a GST invoice\n\n1. Open **Numbers** → `Invoices.numbers`.\n2. Duplicate the last row and fill client, amount and date.\n3. GST is 18% of the amount; total = amount + GST.\n4. File → Export To → PDF, save as `Invoice-<Client>-<NNNN>.pdf` in `invoices/2026/`.\n5. Tell Sarthak the total and ask whether to email it.',
  },
  {
    name: 'summarise-inbox', description: 'Summarise unread Mail and draft quick replies.', source: 'user', botId: IDS.appu,
    path: `${APPU_WS}/.claude/skills/summarise-inbox/SKILL.md`, updatedAt: ago(12 * DAY),
    body: '# Summarise inbox\n\nGroup unread email by sender, flag anything with a deadline, and draft replies under 60 words.',
  },
  {
    name: 'pdf', description: 'Read, merge, split and fill PDF files.', source: 'bundled', botId: IDS.appu,
    path: `${APPU_WS}/.claude/skills/pdf/SKILL.md`, updatedAt: ago(40 * DAY),
    body: '# PDF toolkit\n\nUse `pypdf` for merging/splitting and `pdfplumber` for text extraction.',
  },
];

function mockPermissions(): ComputerStatus['permissions'] {
  const q = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const perms = q.get('perms');
  const fresh = q.get('onboarding') === '1' && perms !== 'granted';
  return { accessibility: !fresh, screenRecording: !fresh && perms !== 'missing', inputMonitoring: true };
}

export const computerStatus: ComputerStatus = {
  backend: 'cua-driver', available: true,
  // `?perms=missing`: Screen Recording not granted yet (the chat's setup notice); first-run setup (`?onboarding=1`)
  // starts with neither (`&perms=granted`: both)
  permissions: mockPermissions(),
  screen: { width: 1512, height: 982, scale: 2 }, busy: false, paused: false, liveView: true, background: false,
};

const system: SystemInfo = {
  groupPins: true,
  version: '0.1.0', hostName: HOST_NAME, platform: 'darwin', arch: 'arm64', homeDir: '/Users/sarthak',
  dataDir: '/Users/sarthak/Library/Application Support/AppuBot',
  tailscale: { installed: true, running: true, ips: [TS_IP], dnsName: TS_DNS, tailnet: 'tail1234.ts.net', loginName: 'sarthak@github' },
  gateway: {
    port: PORT, hosts: [TS_IP, TS_DNS, LAN_IP],
    candidates: [{ host: TS_IP, port: PORT, kind: 'tailscale' }, { host: TS_DNS, port: PORT, kind: 'magicdns' }, { host: LAN_IP, port: PORT, kind: 'lan' }],
  },
  uptimeSec: 3 * 3600 + 17 * 60,
  update: { state: 'up-to-date', checkedAt: Date.now() - 2 * 3600_000 },
};

export const seedFiles: FileAttachment[] = [
  { id: 'f_1', name: 'Invoice-Acme-0042.pdf', mimeType: 'application/pdf', size: 48213, url: '/files/f_1', path: `${APPU_WS}/Invoice-Acme-0042.pdf` },
  { id: 'f_2', name: 'numbers-invoices.png', mimeType: 'image/png', size: 412_877, url: '/files/f_2', path: `${APPU_WS}/screens/numbers-invoices.png`, caption: 'Invoices sheet after the update' },
  { id: 'f_3', name: 'expenses-oct.csv', mimeType: 'text/csv', size: 9_412, url: '/files/f_3', path: `${LEDGER_WS}/exports/expenses-oct.csv` },
  { id: 'f_4', name: 'goa-itinerary.md', mimeType: 'text/markdown', size: 3_108, url: '/files/f_4', path: `${APPU_WS}/trips/goa-itinerary.md` },
  { id: 'f_5', name: 'reply-2026-11-14T09-06-12.ogg', mimeType: 'audio/ogg', size: 44_120, url: '/files/f_5', path: `${APPU_WS}/inbox/reply-2026-11-14T09-06-12.ogg` },
  { id: 'f_6', name: 'voice.wav', mimeType: 'audio/wav', size: 110_400, url: '/files/f_6', path: `${APPU_WS}/inbox/voice.wav` },
];

export const seedMemory: Record<string, string> = {
  [IDS.appu]: '# Memory\n\n- Sarthak runs **AppGrowthKit** from Bengaluru.\n- Invoices are in INR with 18% GST; numbering continues from INV-0042.\n- Accountant: Priya (priya@ledgerworks.in) - CC her on invoices.\n- Prefers short answers and bullet points.\n',
  [IDS.ledger]: '# Memory\n\n- Financial year runs April → March.\n- GST returns (GSTR-1) are due on the 11th.\n',
};

export function permissionRequest(): PermissionRequest {
  const command = 'rm -rf build && npm run build';
  return {
    id: IDS.permission, threadId: IDS.main, botId: IDS.appu, toolCallId: IDS.permissionToolCall,
    title: `Run \`${command}\``, kind: 'execute',
    content: [{ type: 'text', text: 'Deletes the build/ folder and regenerates all invoice templates.' }],
    rawInput: { command },
    options: [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
    createdAt: ago(90_000),
  };
}

/* ---------- snapshot ---------- */
export interface Seed {
  snapshot: Snapshot;
  messages: Record<string, Message[]>;
}

/** Claude Code's model list as a session reports it (after `tidyModels`) */
const CLAUDE_MODELS = [
  { id: 'default', name: 'Default (recommended)' }, { id: 'fable', name: 'Fable 5.1' }, { id: 'opus', name: 'Opus 5.5' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5' }, { id: 'claude-haiku-4-5', name: 'Haiku 4.5' },
];

/** `?agents=`: Claude Code signed out with the runtime's logins, Codex missing (or being installed) */
function freshAgent(p: Provider, agents: 'signin' | 'installing'): Provider {
  if (p.id === 'claude-code') {
    return {
      ...p, authStatus: 'needs_auth', auth: { state: 'logged_out', checkedAt: T0 }, canLogOut: false, version: '2.1.331', latestVersion: undefined, updateAvailable: undefined, update: undefined,
      authMethods: [
        { id: 'claude-ai-login', name: 'Claude subscription', description: 'Sign in with your Claude Pro or Max plan in your browser.', kind: 'terminal' },
        { id: 'claude-token', name: 'Paste a token', description: 'Run `claude setup-token` on any computer and paste what it prints (a Claude subscription).', kind: 'env_var', vars: [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', label: 'Claude Code token', secret: true, optional: false }] },
        { id: 'anthropic-api-key', name: 'API key', description: 'An Anthropic Console key (API usage billing).', kind: 'env_var', vars: [{ name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', secret: true, optional: false }] },
      ],
    };
  }
  if (p.id === 'codex') {
    return {
      ...p, installed: false, authStatus: 'not_installed', auth: undefined, installHint: undefined, version: undefined, latestVersion: undefined, updateAvailable: undefined, update: undefined,
      authMethods: [{ id: 'chat-gpt', name: 'ChatGPT plan', description: 'Sign in with your ChatGPT account in your browser.', kind: 'terminal' }],
      ...(agents === 'installing' ? { installing: true } : {}),
    };
  }
  return { ...p };
}

/** `?profile=`: a Claude Code profile with its own account (`providers.profiles`' Add, signed in) */
function withProfile(name: string): { provider: Provider } {
  const base = providers.find((p) => p.id === 'claude-code')!;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'profile';
  return {
    provider: {
      ...base, id: `claude-code@${slug}`, name: `Claude Code · ${name}`, builtin: false, latestVersion: undefined, updateAvailable: undefined, update: undefined,
      auth: { state: 'logged_in', account: `${slug}@example.com`, plan: 'Pro', checkedAt: T0 },
      profile: { of: 'claude-code', name, home: `/Users/sarthak/.claude-${slug}`, source: 'appubot' },
    },
  };
}

export function buildSeed(opts: MockOptions): Seed {
  const messages = buildMessages(opts);
  // Appu has four threads (the current one last sent to), Ledger one, plus a Telegram chat of Ledger's (on its own)
  const threads: Thread[] = [
    thread({ id: IDS.main, botId: IDS.appu, title: 'Acme invoice and GST templates', status: opts.approval ? 'waiting' : opts.working ? 'running' : 'idle', createdAt: ago(3 * HOUR + MIN), lastActiveAt: ago(3 * MIN) }),
    thread({ id: IDS.appuScreens, botId: IDS.appu, title: 'Tidy the Desktop screenshots', createdAt: ago(DAY + 2 * HOUR + MIN), lastActiveAt: ago(DAY + 2 * HOUR) }),
    thread({ id: IDS.appuGoa, botId: IDS.appu, title: 'Goa trip in December', createdAt: ago(3 * DAY + HOUR + MIN), lastActiveAt: ago(3 * DAY + HOUR) }),
    thread({ id: IDS.appuDaily, botId: IDS.appu, title: 'Everyday errands', createdAt: ago(40 * DAY), lastActiveAt: ago(4 * DAY) }),
    thread({ id: IDS.appuRoutines, botId: IDS.appu, title: 'Asana check', status: 'running', lastMessagePreview: '2 new tasks for you: “Logo review” (due Friday) and a comment from Anna on “Budget 2027”.', createdAt: ago(4 * HOUR), lastActiveAt: ago(2 * MIN) }),
    // only where asked for: it is the newest thread, so it would be Appu's current one everywhere
    ...(opts.thread === 'work' ? [thread({ id: IDS.appuWork, botId: IDS.appu, title: 'October expense report', status: 'running', createdAt: ago(20 * MIN), lastActiveAt: ago(MIN) })] : []),
    // `?thread=failed`: a chat whose latest turn failed on its model (the failure card with its fixes)
    ...(opts.thread === 'failed' ? [thread({ id: IDS.appuFailed, botId: IDS.appu, title: 'Plan the offsite', status: 'error', createdAt: ago(6 * MIN), lastActiveAt: ago(MIN) })] : []),
    // `?thread=handoff`: a chat where Appu and the user handed Ledger tasks with @Ledger
    ...(opts.thread === 'handoff' ? [thread({ id: IDS.appuHandoff, botId: IDS.appu, title: 'Acme’s October invoice', createdAt: ago(20 * MIN), lastActiveAt: ago(MIN) })] : []),
    thread({ id: IDS.appuMedia, botId: IDS.appu, title: 'Photos, voice notes and a chart of this month’s spending, with a very long title that has to truncate', createdAt: ago(5 * DAY), lastActiveAt: ago(5 * DAY) }),
    thread({ id: IDS.ledgerChat, botId: IDS.ledger, title: 'New chat', createdAt: ago(7 * DAY), lastActiveAt: ago(5 * HOUR) }),
    thread({ id: IDS.expenses, botId: IDS.ledger, title: 'Telegram chat', source: 'channel', channel: 'telegram:4242', createdAt: ago(2 * DAY + 3 * HOUR) }),
    // the film's Pixel has its own chat, where Echo wrote to it directly
    ...(opts.groupsFilm ? [thread({ id: FILM_PIXEL_CHAT, botId: FILM_IDS.pixel, title: 'Launch graphic', createdAt: ago(40 * MIN), lastActiveAt: ago(2 * MIN) })] : []),
  ].map((t) => {
    const list = messages[t.id] ?? [];
    const last = list[list.length - 1];
    const lastText = [...list].reverse().map((m) => messagePreview(m)).find(Boolean) ?? '';
    return { ...t, lastMessagePreview: lastText, updatedAt: last ? last.updatedAt : t.createdAt };
  });
  const many = mockRosterMany() ? rosterExtras({ bot: bots[0]!, thread }) : null;
  if (many) threads.push(...many.threads);

  const characters = mockCharacters();
  const background = !!opts.computer && opts.computer !== 'on-screen';
  const prof = opts.profile ? withProfile(opts.profile) : null;
  if (prof) for (const t of threads) if (t.botId === IDS.appu) Object.assign(t, { providerId: prof.provider.id, modelId: 'claude-sonnet-5', models: CLAUDE_MODELS });
  const settings = SettingsSchema.parse({
    onboarded: opts.onboarded, theme: opts.theme ?? 'system', computer: { background }, cloudOnly: !!opts.cloudOnly,
    ...(prof ? { defaultProviderId: prof.provider.id, defaultModelId: 'claude-sonnet-5' } : {}),
  });
  const computer: ComputerStatus = !opts.computer ? { ...computerStatus } : {
    ...computerStatus, busy: true, activeThreadId: IDS.main, background,
    ...(opts.computer === 'waiting' ? { waiting: { threadId: IDS.main, app: 'Safari', since: Date.now() } } : {}),
  };

  return {
    snapshot: stressSnapshot({
      bots: [...bots, ...(opts.groupsFilm ? FILM_BOTS.map((f, i) => ({ ...bots[1]!, ...f, slug: f.name.toLowerCase(), chief: false, pinned: false, workspace: `/Users/sarthak/AppuBot/${f.name.toLowerCase()}`, createdAt: ago((10 - i) * DAY), updatedAt: ago(i * HOUR) })) : []), ...(many?.bots ?? [])].map((b) => (mockCharactersWorn() && b.id === IDS.ledger && characters?.[1] ? { ...b, characterId: characters[1].id }
        : opts.longName && b.id === IDS.appu ? { ...b, name: 'Appu the Extraordinarily Thorough Bookkeeping Assistant' }
        : prof && b.id === IDS.appu ? { ...b, providerId: prof.provider.id, modelId: 'claude-sonnet-5' } : { ...b })),
      threads,
      providers: [...providers.map((p) => (opts.agents ? freshAgent(p, opts.agents) : { ...p })), ...(prof ? [prof.provider] : [])],
      pendingPermissions: opts.approval ? [permissionRequest()] : [],
      computer,
      settings,
      system: { ...system, uptimeSec: system.uptimeSec, ...(opts.updateRequired ? { update: { state: 'up-to-date' as const, checkedAt: Date.now(), required: { message: 'This version of AppuBot has stopped working. Update to keep using it.' } } } : {}), ...(opts.updateState ? { update: { state: opts.updateState, version: '2026.1118.1', ...(opts.updateState === 'downloading' ? { percent: 42 } : {}) } } : {}), ...(opts.gift ? { promo: { id: 'free-claude-day', model: 'claude-haiku-5-5', endsAt: Date.now() + 21 * 3_600_000, state: opts.gift === 'on' ? 'on' as const : opts.gift === 'over' ? 'over' as const : 'offer' as const, signedIn: opts.gift !== 'signedout', ...(opts.gift === 'over' ? { why: 'ended' as const } : {}) } } : {}) },
      devices: devices.map((d) => ({ ...d })),
      routines: routines.map((r) => ({ ...r })),
      groups: opts.groups ? [{ ...mockGroup(opts.groupsFilm), ...(opts.groupsPinned ? { pinned: true } : {}) }] : [],
      channels: channels.map((c) => ({ ...c })),
      skills: skills.map((s) => ({ ...s })),
      voice: mockVoiceStatus(),
      ...(characters ? { characters } : {}),
      ...(opts.limits === 'none' ? {} : { limits: mockLimits(opts.limits, [...providers, ...(prof ? [prof.provider] : [])]) }),
    }),
    messages,
  };
}
