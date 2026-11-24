/**
 * Hand-offs in a bot's chat (2026-11-24): the user writes "@Ledger check this invoice" in their chat with another bot,
 * and the bot named takes it as a turn of its own (in its own chat, on its own agent, model, permissions and apps); its
 * answer is posted back into the chat it came from as its message (`Message.from`: its avatar and name), and the
 * chat's own bot reads it with its next prompt. A bot's reply that names another bot hands off the same way, until
 * `HANDOFF_HOPS_MAX` bot messages follow the user's last. The pure parts: who a message names, who takes it next, the
 * words the bot named gets, and what the chat's own bot is told of what it wasn't part of. The computer runs it
 * (`HandoffService`), the same way it runs a group's turns; the apps draw it.
 */
import { HANDOFF_HOPS_MAX, type Message } from '@appubot/protocol';
import { mentionedBots, type GroupBot } from './groups';

export { HANDOFF_HOPS_MAX };

type Said = Pick<Message, 'role' | 'parts' | 'from'>;

/**
 * Where a name is no address: code (fenced and inline), quoted lines ("> …", words quoted from a reply), links and
 * handles (youtube.com/@Ledger, @ada@mastodon.social), and @everyone / @all (every one of them, `@all@all` too), which
 * a chat with one bot doesn't hand to every bot there is.
 */
function addressable(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g, ' ')
    .split('\n').filter((line) => !/^\s*>/.test(line)).join('\n')
    .replace(/\S*\/@\S*|@[\w.-]+@\S*/g, ' ')
    .replace(/@(?:everyone|all)\b/gi, ' ');
}

/** The bots a message in a bot's chat names (`@Name`, as in a group), each once, in the order named. */
export function handoffTargets<B extends GroupBot>(text: string, bots: readonly B[]): B[] {
  if (!text.includes('@')) return [];
  return mentionedBots(addressable(text), bots);
}

/** Who takes a message in a bot's chat next: other bots (`to`), the chat's own bot, or nobody (`paused` past the cap). */
export interface HandoffStep<B extends GroupBot> { to: B[]; chatBot: boolean; paused: boolean }

/**
 * Who takes a message in a bot's chat:
 * - the user's: the other bots it names, and the chat's own bot only when it is named too; naming no other bot, the
 *   chat's own bot as always.
 * - the chat's own bot's reply: the other bots it names.
 * - another bot's answer to a hand-off: the bots it names (the chat's own bot among them); naming none, back to the
 *   chat's own bot when that bot handed it the work (it asked, so it carries on, as a group member reports to its
 *   lead), else nobody (the user asked, and reads it).
 * Never the author. `hop`: how many bot messages since the user's last, this one included (the user's own are 0); a
 * bot's message at `HANDOFF_HOPS_MAX` goes to nobody, `paused`.
 */
export function handoffNext<B extends GroupBot>(o: { text: string; from: 'user' | string; chatBotId: string; bots: readonly B[]; hop: number; askedByChatBot?: boolean }): HandoffStep<B> {
  const named = handoffTargets(o.text, o.bots).filter((b) => b.id !== o.from);
  const to = named.filter((b) => b.id !== o.chatBotId);
  const chatBotNamed = named.some((b) => b.id === o.chatBotId);
  if (o.from === 'user') return { to, chatBot: !to.length || chatBotNamed, paused: false };
  const chatBot = o.from !== o.chatBotId && (chatBotNamed || (!named.length && !!o.askedByChatBot));
  if (!to.length && !chatBot) return { to: [], chatBot: false, paused: false };
  if (o.hop >= HANDOFF_HOPS_MAX) return { to: [], chatBot: false, paused: true };
  return { to, chatBot, paused: false };
}

/** A message's words, for another bot to read: its text parts, on one line, cut at `max`. */
function wordsOf(m: Pick<Message, 'parts'>, max: number): string {
  const text = m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Who said a message in a bot's chat: the user, the chat's own bot, or the bot whose hand-off answer it is. */
function speaker(m: Said, chatBot: string): string {
  if (m.role === 'user') return m.from ? m.from.name : 'The user';
  return m.from?.name ?? chatBot;
}

/** how many of the chat's latest messages the bot handed a task reads with it */
export const HANDOFF_RECENT = 8;

/**
 * What the bot handed a task is told with it (never stored: its chat keeps the message itself): where it comes from,
 * the chat's latest messages (`recent`, oldest first, `HANDOFF_RECENT` of them at most) and the rules (do it yourself;
 * your whole reply is shown in that chat as yours; @Name hands on; no loops).
 */
export function renderHandoffPrompt(o: { you: GroupBot; chatBot: GroupBot; from: 'user' | GroupBot; recent: readonly Said[] }): string {
  const asker = o.from === 'user' ? 'The user' : o.from.name;
  const where = o.from === 'user'
    ? `The user named you (@${o.you.name}) in their chat with ${o.chatBot.name} to hand you this.`
    : `${o.from.name} named you (@${o.you.name}) in its chat with the user to hand you this; the user reads it too.`;
  const lines = o.recent.slice(-HANDOFF_RECENT).flatMap((m) => {
    const words = wordsOf(m, 300);
    return words ? [`- ${speaker(m, o.chatBot.name)}: ${words}`] : [];
  });
  return [
    `[A hand-off: ${where} Do it yourself, with your own tools and apps, and answer as you would in your own chat: your whole reply is shown in ${o.chatBot.name}'s chat under your name, and ${o.chatBot.name} reads it. Name another bot with @Name only to hand it a part; don't hand things back and forth: after ${HANDOFF_HOPS_MAX} messages between bots AppuBot stops passing them on until the user writes.]`,
    ...(lines.length ? ['Earlier in that chat:', ...lines] : []),
    `${asker} wrote:`,
  ].join('\n');
}

/**
 * What the chat's own bot didn't see of its chat, for its next prompt: the hand-offs since its last reply of its own
 * (the user's words to another bot, that bot's answer), oldest first. Null when another bot answered nothing since.
 * `messages`: the chat before the new prompt, oldest first. An answer still being worked on waits for the next time.
 */
export function handoffContext(messages: readonly Pick<Message, 'role' | 'parts' | 'from' | 'status'>[], o: { botName: string }): string | null {
  const unseen: Said[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    // a note of AppuBot's own in the chat (stopped passing them on, a question card) says nothing of the hand-offs
    if (m.role === 'agent' && !m.from && m.parts.every((p) => p.type === 'system' || p.type === 'question')) continue;
    // its own reply: what came before it, it saw
    if (m.role === 'agent' && !m.from) break;
    if (m.role === 'agent' && m.status === 'streaming') continue;
    unseen.unshift(m);
  }
  if (!unseen.some((m) => m.role === 'agent' && m.from)) return null;
  const lines = unseen.slice(-HANDOFF_RECENT).flatMap((m) => {
    const words = wordsOf(m, 4000);
    return words ? [`- ${speaker(m, o.botName)}: ${words}`] : [];
  });
  return [
    `[In this chat since your last reply, handed to other bots with @Name (you weren't asked, but the user saw it all), oldest first:`,
    ...lines,
    'Carry on from it where it matters; don\'t do again what they did.]',
  ].join('\n');
}

/** The chat's own bot's turn after another bot answered it (it handed the work over, or was named): what it is told. */
export function renderHandoffBack(o: { from: GroupBot }): string {
  return `[${o.from.name} answered in this chat (above). Carry on from it: finish what you were doing for the user, or tell them where things stand. Don't hand it back to ${o.from.name} unless something is still missing.]`;
}

/**
 * The `@` being typed in a composer, for its menu of bots: where it starts and the letters after it so far, when the
 * caret sits right after them (`@` at the start or after a space or bracket, no space typed since); null otherwise.
 */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|[\s(])@([^\s@]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: m.index + m[1]!.length, query: m[2]! };
}

/** The bots a composer's `@` menu offers for what was typed after it: names that start with it first, then ones that hold it. */
export function mentionChoices<B extends GroupBot>(bots: readonly B[], query: string, max = 8): B[] {
  const q = query.toLowerCase();
  const starts = bots.filter((b) => b.name.toLowerCase().startsWith(q));
  const holds = q ? bots.filter((b) => !starts.includes(b) && b.name.toLowerCase().includes(q)) : [];
  return [...starts, ...holds].slice(0, max);
}

/** AppuBot's note in a bot's chat when bots have handed each other `HANDOFF_HOPS_MAX` messages since the user's last. */
export const HANDOFF_PAUSED_NOTE = `Paused: the bots have handed this to each other ${HANDOFF_HOPS_MAX} times since you last wrote. Send a message to carry on.`;
