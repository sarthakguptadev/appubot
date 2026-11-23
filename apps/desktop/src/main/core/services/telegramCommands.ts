/**
 * Telegram's command menu (the "/" list next to the message field) and the words and choices behind it, as Telegram
 * HTML (`parse_mode: 'HTML'`; anything of the user's goes through `escapeHtml`). Pure: the runner in channels.ts does
 * the calls and keeps the menus it sent (their buttons only carry an index, `k:<n>`).
 */
import { type Bot, type Provider, type Routine, type Thread, offeredModels, offersFastMode } from '@appubot/protocol';
import { cronToHuman, escapeHtml as esc, providerLogin, timeAgo } from '@appubot/chat-core';

/** What the "/" menu lists, in order (Telegram: a-z, 0-9 and _, 32 at most; descriptions 3-256 characters). */
export const TELEGRAM_COMMANDS: readonly { command: string; description: string; group: 'Chats' | 'Settings' | 'More' }[] = [
  { command: 'new', description: 'Start a new chat', group: 'Chats' },
  { command: 'chats', description: 'Go back to an earlier chat', group: 'Chats' },
  { command: 'stop', description: 'Stop what it is doing', group: 'Chats' },
  { command: 'rename', description: 'Rename this chat: /rename <name>', group: 'Chats' },
  { command: 'status', description: 'Its agent, model and settings now', group: 'Settings' },
  { command: 'model', description: 'Pick the model', group: 'Settings' },
  { command: 'effort', description: 'Pick how hard it thinks', group: 'Settings' },
  { command: 'fast', description: 'Turn fast mode on or off', group: 'Settings' },
  { command: 'mode', description: 'Pick its permissions', group: 'Settings' },
  { command: 'agent', description: 'Pick the AI agent it runs on', group: 'Settings' },
  { command: 'voice', description: 'Answer voice messages with a voice note: on or off', group: 'Settings' },
  { command: 'memory', description: 'What it remembers', group: 'More' },
  { command: 'routines', description: 'Its routines: run, pause or resume one', group: 'More' },
  { command: 'help', description: 'Everything you can do here', group: 'More' },
];

/** What a menu's buttons choose. */
export type MenuKind = 'chat' | 'model' | 'effort' | 'fast' | 'mode' | 'agent' | 'routine' | 'voice';

/** A menu to send: its text (Telegram HTML) and one button per choice (`value` stays with us, the button carries its index). */
export interface MenuSpec {
  kind: MenuKind;
  text: string;
  options: { label: string; value: string }[];
  /** buttons per row */
  perRow: number;
}

const tick = (on: boolean, label: string): string => (on ? `✓ ${label}` : label);
const cut = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
/** "just now", "5m ago", "on Oct 3" */
const ago = (ts: number, now: number): string => {
  const t = timeAgo(ts, now);
  return t === 'now' ? 'just now' : /\d[mhd]$/.test(t) ? `${t} ago` : `on ${t}`;
};
/** a bold heading and what follows it */
const card = (title: string, ...lines: string[]): string => [`<b>${title}</b>`, ...lines].join('\n');

/** The name a thread's model goes by ("Agent's default" when it has none of its own). */
export function modelName(t: Pick<Thread, 'modelId' | 'models'>): string {
  if (!t.modelId) return "Agent's default";
  return t.models.find((m) => m.id === t.modelId)?.name ?? t.modelId;
}

/** "Claude Code · Work" for a profile (as the app's pickers say it), else the agent's name. */
export function agentName(id: string, providers: readonly Provider[]): string {
  const p = providers.find((x) => x.id === id);
  if (!p) return id;
  if (!p.profile) return p.name;
  const base = providers.find((x) => x.id === p.profile!.of)?.name ?? p.name.split(' · ')[0];
  return `${base} · ${p.profile.name}`;
}

export function helpText(bot: Pick<Bot, 'name'>): string {
  const group = (g: string) => TELEGRAM_COMMANDS.filter((c) => c.group === g).map((c) => `/${c.command} · ${esc(c.description.replace(/: \/\w+ <name>$/, ''))}`);
  return [
    card(`👋 ${esc(bot.name)} is here`, 'Send a message, a photo, a voice note or any file and it gets to work.'),
    card('💬 Chats', ...group('Chats')),
    card('🎛 Settings', ...group('Settings')),
    card('✨ More', ...group('More')),
    '<i>When it asks something or needs your OK, tap a button (or reply /allow or /deny).</i>',
  ].join('\n\n');
}

export function statusText(bot: Bot, thread: Thread, providers: readonly Provider[], now = Date.now()): string {
  const effort = thread.efforts.find((e) => e.id === thread.effortId)?.name ?? thread.effortId;
  const mode = thread.modes.find((m) => m.id === thread.modeId)?.name;
  const state = thread.status === 'running' ? '🟢 working on it' : thread.status === 'waiting' ? '🟡 waiting for you' : thread.status === 'error' ? '🔴 last turn failed' : '⚪️ idle';
  const row = (label: string, value: string) => `${label} <b>${esc(value)}</b>`;
  return [
    card(`🤖 ${esc(bot.name)}`, ...(bot.job ? [`<i>${esc(cut(bot.job, 160))}</i>`] : [])),
    [
      `💬 Chat: <b>${esc(thread.title)}</b>`,
      `${state} · active ${ago(thread.lastActiveAt ?? thread.createdAt, now)}`,
    ].join('\n'),
    [
      row('🧠 Agent:', agentName(thread.providerId, providers)),
      row('🎛 Model:', modelName(thread)),
      ...(effort ? [row('💭 Effort:', effort)] : []),
      ...(thread.fastAvailable ? [row('⚡ Fast mode:', thread.fast ? 'On' : 'Off')] : []),
      ...(mode ? [row('🔐 Permissions:', mode)] : []),
    ].join('\n'),
  ].join('\n\n');
}

/** The bot's chats to go back to: the current one first, then the latest others. */
export function chatsMenu(current: Thread, threads: readonly Thread[], now = Date.now()): MenuSpec {
  const others = threads.filter((t) => t.id !== current.id && t.source !== 'channel' && t.source !== 'group')
    .sort((a, b) => (b.lastActiveAt ?? b.createdAt) - (a.lastActiveAt ?? a.createdAt)).slice(0, 9);
  const label = (t: Thread): string => `${cut(t.title, 40)} · ${timeAgo(t.lastActiveAt ?? t.createdAt, now)}`;
  return {
    kind: 'chat',
    text: others.length
      ? card('💬 Your chats', `You're in <b>${esc(current.title)}</b>. Tap one to go back to it.`)
      : card('💬 Your chats', `<b>${esc(current.title)}</b> is the only one so far. /new starts another.`),
    options: [{ label: tick(true, label(current)), value: current.id }, ...others.map((t) => ({ label: label(t), value: t.id }))],
    perRow: 1,
  };
}

export function modelMenu(thread: Thread, all: Thread['models']): MenuSpec {
  // AppuBot AI (the launch bonus): Sonnet and Haiku only
  const models = offeredModels(thread.providerId, all);
  return {
    kind: 'model',
    text: models.length
      ? card('🎛 Model', `Now: <b>${esc(modelName({ modelId: thread.modelId, models }))}</b>`)
      : card('🎛 Model', "This agent hasn't listed its models yet. Send it a message, then try /model again."),
    options: models.slice(0, 30).map((m) => ({ label: tick(m.id === thread.modelId, cut(m.name, 48)), value: m.id })),
    perRow: 1,
  };
}

export function effortMenu(thread: Thread, efforts: Thread['efforts']): MenuSpec {
  const now = efforts.find((e) => e.id === thread.effortId)?.name ?? thread.effortId;
  return {
    kind: 'effort',
    text: efforts.length
      ? card('💭 Effort', 'How hard it thinks before it answers: more is slower, and better at hard problems.', ...(now ? [`Now: <b>${esc(now)}</b>`] : []))
      : card('💭 Effort', "This model doesn't offer a choice of effort."),
    options: efforts.map((e) => ({ label: tick(e.id === thread.effortId, e.name), value: e.id })),
    perRow: 3,
  };
}

/** null: fast mode isn't on offer for this agent */
export function fastMenu(thread: Thread): MenuSpec | null {
  if (!offersFastMode(thread.providerId)) return null;
  return {
    kind: 'fast',
    text: card('⚡ Fast mode', `Now: <b>${thread.fast ? 'On' : 'Off'}</b>`, ...(thread.fastAvailable ? [] : ["<i>This model doesn't offer it: it applies once you pick one that does.</i>"])),
    options: [{ label: tick(thread.fast, 'On'), value: 'on' }, { label: tick(!thread.fast, 'Off'), value: 'off' }],
    perRow: 2,
  };
}

export function modeMenu(thread: Thread, modes: Thread['modes']): MenuSpec {
  return {
    kind: 'mode',
    text: modes.length
      ? card('🔐 Permissions', ...modes.map((m) => `${m.id === thread.modeId ? '✓ ' : '• '}<b>${esc(m.name)}</b>${m.description ? `: ${esc(m.description)}` : ''}`))
      : card('🔐 Permissions', "This agent hasn't listed its permission modes yet. Send it a message, then try /mode again."),
    options: modes.map((m) => ({ label: tick(m.id === thread.modeId, m.name), value: m.id })),
    perRow: 2,
  };
}

/**
 * Whether a voice message is answered with a voice note too (`settings.voice.telegramVoiceReplies`; the text always
 * comes), and what this computer still needs for it: the speech model to hear, the voice model to answer aloud.
 */
export function voiceMenu(on: boolean, ready: { stt: boolean; tts: boolean }, machine: string): MenuSpec {
  const missing = !ready.stt && !ready.tts ? 'speech and voice models' : !ready.stt ? 'speech model' : !ready.tts ? 'voice model' : '';
  return {
    kind: 'voice',
    text: card('🎙 Voice replies', 'When you send a voice message, the answer comes as a voice note too, with the text under it.', `Now: <b>${on ? 'On' : 'Off'}</b>`,
      ...(missing ? [`<i>To use it, open AppuBot on your ${machine} → Settings → Voice and download the ${missing}.</i>`] : [])),
    options: [{ label: tick(on, 'On'), value: 'on' }, { label: tick(!on, 'Off'), value: 'off' }],
    perRow: 2,
  };
}

/** The agents it can run on: installed, switched on and not logged out, plus the current one. */
export function agentMenu(bot: Bot, providers: readonly Provider[]): MenuSpec {
  const usable = providers.filter((p) => p.id === bot.providerId || (p.installed && p.enabled && providerLogin(p).kind !== 'logged_out'));
  return {
    kind: 'agent',
    text: card('🧠 Agent', `${esc(bot.name)} runs on <b>${esc(agentName(bot.providerId, providers))}</b>.`, '<i>Switching keeps its memory, and the chat goes on with the new agent.</i>'),
    options: usable.map((p) => ({ label: tick(p.id === bot.providerId, agentName(p.id, providers)), value: p.id })),
    perRow: 1,
  };
}

/** Its routines, two buttons each: run now, and pause or resume. */
export function routinesMenu(bot: Bot, routines: readonly Routine[]): MenuSpec {
  const mine = routines.filter((r) => r.botId === bot.id).slice(0, 15);
  return {
    kind: 'routine',
    text: mine.length
      ? card(`⏰ ${esc(bot.name)}'s routines`, ...mine.map((r) => `${r.enabled ? '🟢' : '⏸'} <b>${esc(r.name)}</b> · ${esc(cronToHuman(r.schedule))}`))
      : card('⏰ Routines', `${esc(bot.name)} has none yet. Ask it for one, like "every weekday at 9, send me the news".`),
    options: mine.flatMap((r) => [
      { label: `▶ ${cut(r.name, 24)}`, value: `run:${r.id}` },
      { label: r.enabled ? '⏸ Pause' : '🟢 Resume', value: `${r.enabled ? 'off' : 'on'}:${r.id}` },
    ]),
    perRow: 2,
  };
}
