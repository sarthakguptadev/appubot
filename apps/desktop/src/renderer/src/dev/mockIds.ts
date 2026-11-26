/** Dev-only: shared ids and constants for the mock gateway. */
import type { SessionMode, SessionModel, SlashCommand } from '@appubot/protocol';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** Fixed "now" for seed data so relative times are stable during a session. */
export const T0 = Date.now();
export const ago = (ms: number): number => T0 - ms;

export const IDS = {
  appu: 'bot_appu',
  ledger: 'bot_ledger',
  /** Appu's current thread: the morning digest, the rich invoice turn and the pending approval at the end */
  main: 'th_appu',
  /** Appu's older threads: weeks of everyday errands (hundreds of messages), a Goa trip, a Desktop clean-up */
  appuDaily: 'th_appu_daily',
  appuGoa: 'th_appu_goa',
  appuScreens: 'th_appu_screens',
  /** `?thread=media`: images, a page, voice notes, a diagram, reactions, a failed turn and very long text */
  appuMedia: 'th_appu_media',
  /** `?thread=routines`: an Asana check every 10 minutes, mostly "✓" (folded), a run with news, one that failed, one running */
  appuRoutines: 'th_appu_routines',
  routineAsana: 'rt_asana',
  /** `?thread=work` (with `&work=1`): a long working turn for the work trail, then one still running */
  appuWork: 'th_appu_work',
  appuFailed: 'th_appu_failed',
  /** `?thread=note|question|waits`: a job in hand with the bot's notes on the way, a question asked mid-job and answered, a message waiting for the job to end */
  appuMidJob: 'th_appu_midjob',
  /** `?thread=handoff`: tasks handed to Ledger with @Ledger in a chat with Appu (by the user, then by Appu), Ledger's answers in its name */
  appuHandoff: 'th_appu_handoff',
  /** Ledger's one thread */
  ledgerChat: 'th_ledger',
  /** a Telegram chat with Ledger (stays a conversation of its own) */
  expenses: 'th_expenses',
  permission: 'perm_build',
  permissionToolCall: 'tc_build',
  question: 'q_send_invoice',
  /** frame referenced by the main thread's computer tool_call */
  computerFrame: 'frame_a3',
  liveFrame: 'frame_live',
  routineInbox: 'rt_inbox',
  routineInvoices: 'rt_invoices',
} as const;

export const APPU_WS = '/Users/sarthak/AppuBot/appu';
export const LEDGER_WS = '/Users/sarthak/AppuBot/ledger';
export const HOST_NAME = "Sarthak's MacBook Pro";
export const TS_IP = '100.91.133.6';
export const TS_DNS = 'sarthaks-mbp.tail1234.ts.net';
export const LAN_IP = '192.168.1.24';
export const PORT = 7890;

/** Claude Code's modes as the Mac sends them (agent-runtime `providerModes`: Auto and Bypass only, with AppuBot's wording) */
export const MODES: SessionMode[] = [
  { id: 'auto', name: 'Approve for me', description: "Claude Code's auto mode: a classifier approves or blocks each action and asks you when unsure" },
  { id: 'bypassPermissions', name: 'Full access', description: 'Runs every action without asking, with full access to your computer' },
];
export const MODELS: SessionModel[] = [{ id: 'sonnet', name: 'Sonnet' }, { id: 'opus', name: 'Opus' }];
export const EFFORTS: SessionModel[] = [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }, { id: 'xhigh', name: 'Xhigh' }, { id: 'max', name: 'Max' }];
export const COMMANDS: SlashCommand[] = [
  { name: 'review', description: 'Review changes' },
  { name: 'init', description: 'Create CLAUDE.md' },
  { name: 'compact', description: 'Compact the conversation' },
];

/** `?groups=film`: the launch film's three extra members, and Pixel's own chat (Echo's direct message to it) */
export const FILM_IDS = { scout: 'bot_scout', pixel: 'bot_pixel', echo: 'bot_echo' } as const;
export const FILM_PIXEL_CHAT = 'th_pixel';
