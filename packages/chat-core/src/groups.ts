/**
 * Groups (bots talking with each other in a room of their own) and bot-to-bot messages, the pure parts: who a room
 * message names (@Name), who answers it, the words a bot gets with a message from another bot or a group, and how
 * a bot's reply is read back. The computer (`GroupsService`, `AgentBridgeService`) and both apps use these.
 */
import { GROUP_HOPS_MAX, type Group, type GroupAuthor, type GroupMessage, type Message } from '@appubot/protocol';

export { GROUP_HOPS_MAX };

/** What a bot answers to stay quiet in a group (a room message that needs nothing from it). */
export const NO_REPLY = 'NO_REPLY';
/**
 * The word as a model writes it: NO_REPLY or no-reply in any case, or NO REPLY in capitals. Never the plain words
 * "no reply", which a sentence may well say ("the bank sent no reply").
 */
const WORD = '(?:[Nn][Oo][_-][Rr][Ee][Pp][Ll][Yy]|NO ?REPLY)';
/** the word alone on a line, however it is dressed: `NO_REPLY`, **NO_REPLY**, "NO_REPLY.", (NO REPLY) */
const NO_REPLY_ALONE = new RegExp(`^\\W*${WORD}\\W*$`);
const NO_REPLY_LEADS = new RegExp(`^\\W*${WORD}\\b[\\s.:;,!\`*_"')\\]-]*`);
const NO_REPLY_ENDS = new RegExp(`[\\s\`*_"'(\\[-]*\\b${WORD}\\W*$`);
/**
 * A reply without the word: a line that is only it goes, and so does one that leads or ends the text. Nothing a
 * person reads may ever carry it (a model asked for it once keeps saying it, and dresses it differently each time).
 */
export function withoutNoReply(text: string): string {
  return text.split('\n').filter((line) => !NO_REPLY_ALONE.test(line)).join('\n')
    .replace(NO_REPLY_LEADS, '')
    .replace(NO_REPLY_ENDS, '')
    .trim();
}
/** The whole reply is the word, or nothing. */
export const isNoReply = (text: string): boolean => withoutNoReply(text) === '';

/** Reactions that say something went wrong: answered with thanks for telling, never mirrored back. */
const UNHAPPY_REACTIONS = new Set(['👎', '😕', '🙁', '☹️', '😞', '😢', '😭', '😡', '😠', '🤔', '😬', '💔']);
/** What the bot puts on the user's message when it answered their reaction with nothing at all: their own, or 🙏. */
export const reactionBack = (emoji: string): string => (UNHAPPY_REACTIONS.has(emoji) ? '🙏' : emoji);

export interface GroupBot { id: string; name: string; chief?: boolean }

/** The group's lead: the one picked, else the first chief among its members; undefined when no member is a chief. */
export function groupLead<B extends GroupBot>(group: Pick<Group, 'botIds' | 'leadId'>, bots: readonly B[]): B | undefined {
  const members = group.botIds.map((id) => bots.find((b) => b.id === id)).filter((b): b is B => !!b);
  return (group.leadId ? members.find((b) => b.id === group.leadId) : undefined) ?? members.find((b) => b.chief);
}

/**
 * The members a message names: `@Name` (a name with spaces too: "@Lead Scout"), the longest name that fits at each
 * `@`, case-insensitive; `@everyone` / `@all` names them all. Each once, in the order named.
 */
export function mentionedBots<B extends GroupBot>(text: string, members: readonly B[]): B[] {
  const out: B[] = [];
  const byLength = [...members].sort((a, b) => b.name.length - a.name.length);
  const re = /(^|[^\w@])@/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const at = m.index + (m[1]?.length ?? 0) + 1;
    const rest = text.slice(at);
    if (/^(everyone|all)\b/i.test(rest)) return [...members];
    const hit = byLength.find((b) => b.name && rest.toLowerCase().startsWith(b.name.toLowerCase()) && !/\w/.test(rest.charAt(b.name.length)));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** the link a mention becomes in a room message's Markdown (a fragment, so Markdown keeps it); `everyone` for @everyone */
export const MENTION_HREF = '#appubot-mention:';

/**
 * A room message's @Name mentions of its members (and @everyone / @all) as Markdown links to `MENTION_HREF` + the
 * bot's id, which the apps draw as the bot's chip; the same matching as `mentionedBots`, never inside code.
 */
export function linkMentions(text: string, members: readonly GroupBot[]): string {
  if (!text.includes('@') || !members.length) return text;
  const byLength = [...members].filter((b) => b.name).sort((a, b) => b.name.length - a.name.length);
  // code (fenced blocks and inline spans) stays as written: the odd pieces of this split
  return text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/).map((piece, i) => {
    if (i % 2) return piece;
    let out = '';
    let last = 0;
    const re = /(^|[^\w@\]\[])@/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(piece))) {
      const at = m.index + (m[1]?.length ?? 0);
      const rest = piece.slice(at + 1);
      const all = /^(everyone|all)\b/i.exec(rest);
      const hit = all ? undefined : byLength.find((b) => rest.toLowerCase().startsWith(b.name.toLowerCase()) && !/\w/.test(rest.charAt(b.name.length)));
      const word = all ? all[0] : hit ? rest.slice(0, hit.name.length) : '';
      if (!word) continue;
      out += piece.slice(last, at) + `[@${word.replace(/[[\]\\]/g, '\\$&')}](${MENTION_HREF}${all ? 'everyone' : hit!.id})`;
      last = at + 1 + word.length;
      re.lastIndex = last;
    }
    return out + piece.slice(last);
  }).join('');
}

/**
 * Who answers a room message: the bots it names (@Name, @everyone); else from the user, the lead (every member
 * without one); from a member, the lead (it reports up); from the lead, nobody (it reports to the user). Never the
 * author. AppuBot's own notes are answered by nobody.
 */
export function groupRecipients<B extends GroupBot>(o: { from: GroupAuthor; mentions: readonly B[]; members: readonly B[]; lead?: B }): B[] {
  const { from, mentions, members, lead } = o;
  const notSelf = (b: B) => !(from.kind === 'bot' && b.id === from.botId);
  if (from.kind === 'system') return [];
  if (mentions.length) return mentions.filter(notSelf);
  if (from.kind === 'user') return lead ? [lead] : [...members];
  if (lead && from.botId === lead.id) return [];
  return lead ? [lead].filter(notSelf) : [];
}

/** The room is paused: bots have sent each other `GROUP_HOPS_MAX` messages since the user's last. */
export const groupPaused = (hop: number): boolean => hop >= GROUP_HOPS_MAX;

/** How a room message's author is named ("You", the bot's name, "AppuBot"). */
export function groupAuthorName(from: GroupAuthor, you = 'You'): string {
  if (from.kind === 'user') return you;
  if (from.kind === 'system') return 'AppuBot';
  return from.name ?? 'A bot';
}

/** The room's last line for lists ("Ada: On it."). */
export function groupPreview(msg: Pick<GroupMessage, 'from' | 'text'>): string {
  const who = msg.from.kind === 'user' ? 'You' : groupAuthorName(msg.from);
  return `${who}: ${msg.text.replace(/\s+/g, ' ').trim()}`.slice(0, 200);
}

/**
 * What a member bot is told with a group message (never stored: the bot's group thread keeps the message itself):
 * where it is, who is in the room, who speaks and the rules (its reply is posted; @Name to address; NO_REPLY to keep
 * quiet; keep it short; no loops).
 */
export function renderGroupPrompt(o: { group: Pick<Group, 'name'>; you: GroupBot; members: readonly GroupBot[]; lead?: GroupBot; message: Pick<GroupMessage, 'from' | 'text' | 'hop'>; /** more room messages for the same bot, taken in one turn (two members reporting back) */ also?: readonly Pick<GroupMessage, 'from' | 'text' | 'hop'>[]; recent?: readonly Pick<GroupMessage, 'from' | 'text'>[]; /** the goal the group works toward on its own, when one is on */ goal?: { objective: string; turns: number; maxTurns: number } }): string {
  const others = o.members.filter((b) => b.id !== o.you.id).map((b) => `${b.name}${o.lead?.id === b.id ? ' (lead)' : ''}`);
  const role = o.lead?.id === o.you.id ? 'You lead this group: the user\'s messages come to you first; hand each part to the one member it needs with @Name (members answer one at a time, so name only who is needed; @everyone is for the rare notice all must hear), then report to the user in plain words when it is done (a message of yours with no @Name goes to the user alone).'
    : o.lead ? `${o.lead.name} leads this group: a message of yours with no @Name goes to ${o.lead.name}.` : 'Nobody leads this group: a message of yours with no @Name goes to the user only.';
  const who = (m: Pick<GroupMessage, 'from'>) => (m.from.kind === 'user' ? 'The user' : m.from.kind === 'system' ? 'AppuBot' : `The bot ${m.from.name ?? ''}`.trim());
  const recent = o.recent?.length ? `\nEarlier in the room:\n${o.recent.map((m) => `- ${groupAuthorName(m.from, 'The user')}: ${m.text.replace(/\s+/g, ' ').trim().slice(0, 300)}`).join('\n')}\n` : '';
  const all = [o.message, ...(o.also ?? [])];
  return [
    `[Group "${o.group.name}": you (${o.you.name}) work here with ${others.length ? others.join(', ') : 'nobody else yet'}; the user reads everything. ${role}`,
    o.goal
      ? `Your whole reply is posted to the room as your message, so write it as one: short, to the point, no greetings. Name a bot with @Name to hand it something or ask it; reply exactly NO_REPLY if this needs nothing from you. Do the work asked of you yourself (your tools, your files) and post the result, not a promise.]\n[The group has a goal it works toward on its own, without the user: ${o.goal.objective} (${o.goal.turns} of ${o.goal.maxTurns} messages used). Keep the work moving: whoever leads hands out the next part as soon as one is done. When the goal is achieved, ${o.lead ? o.lead.name : 'whoever sees it'} calls finish_goal with status "done" and a short note; if the group can't go on without the user, call finish_goal with status "blocked" and say exactly what is needed.]`
      : `Your whole reply is posted to the room as your message, so write it as one: short, to the point, no greetings. Name a bot with @Name to hand it something or ask it; reply exactly NO_REPLY if this needs nothing from you. Do the work asked of you yourself (your tools, your files) and post the result, not a promise. Don't ask a bot to ask you back: after ${GROUP_HOPS_MAX} messages between bots AppuBot pauses the room until the user writes.]`,
    recent,
    ...(all.length > 1 ? [`${all.length} messages came for you; answer them in one reply:`] : []),
    ...all.map((m) => `${who(m)} wrote:\n${m.text}`),
  ].join('\n');
}

/** Several room messages taken in one turn, as the bot's own group thread stores them: each with its author. */
export function joinGroupMessages(msgs: readonly Pick<GroupMessage, 'from' | 'text'>[]): string {
  if (msgs.length === 1) return msgs[0]!.text;
  return msgs.map((m) => `${groupAuthorName(m.from, 'You')}: ${m.text}`).join('\n\n');
}

/** What a bot is told with a direct message from another bot (`message_bot`), before the message itself. */
export function renderBotMessagePreface(o: { from: GroupBot; you: GroupBot; waits: boolean }): string {
  return `[A message from the bot ${o.from.name}, not from the user (the user sees it in both chats). Answer it as a colleague's: do what it asks within your job, with your own tools, and keep the answer short and useful. ${o.waits ? `${o.from.name} is waiting for your reply: it gets your whole answer.` : `${o.from.name} isn't waiting: your answer stays in this chat for the user.`} Don't message ${o.from.name} back with message_bot unless you need something from it.]`;
}

/** A bot's answer to a bot or a group, read off its reply message: its text parts (what it said aloud as bubbles included), never its tools. */
export function replyTextOf(m: Pick<Message, 'parts' | 'status' | 'error'>): string {
  const text = m.parts.filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text').map((p) => p.text.trim()).filter(Boolean).join('\n\n');
  if (text) return text;
  if (m.error) return `(couldn't answer: ${m.error})`;
  return '';
}

/** how many members a group's tile draws (the shape's corners) */
export const GROUP_TILE_MAX = 8;
/** one turn of a group's tile, in seconds */
export const GROUP_TILE_TURN_S = 36;

/**
 * Where a group's members sit in its tile of `size`: on the corners of a regular shape (two side by side, three a
 * triangle, four a square, five a pentagon…), each avatar as large as fits without touching, the first at the top.
 * `points` are the avatars' centres.
 */
export function groupTileLayout(n: number, size: number): { avatar: number; points: { x: number; y: number }[] } {
  if (n <= 1) return { avatar: Math.round(size * 0.84), points: [{ x: size / 2, y: size / 2 }] };
  const s = Math.sin(Math.PI / n);
  const r = size / 2 / (1 + 0.92 * s);
  const avatar = Math.floor(0.92 * 2 * r * s);
  const start = n === 2 ? 0 : -Math.PI / 2;
  return { avatar, points: Array.from({ length: n }, (_, i) => ({ x: size / 2 + r * Math.cos(start + (2 * Math.PI * i) / n), y: size / 2 + r * Math.sin(start + (2 * Math.PI * i) / n) })) };
}

