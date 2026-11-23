/**
 * A bot's threads as the apps name them (the Mac titles a new one "New thread" until its first message does).
 * Shared by the Mac (auto titles), the desktop's thread switcher and the phone's threads sheet.
 */
import { currentChat, threadActiveAt, type Message, type Thread } from '@appubot/protocol';

/** What a thread is called before its first message names it. */
export const NEW_THREAD_TITLE = 'New thread';

/** A title that is still the default one (older versions said "New chat"), or none at all. */
export function isDefaultThreadTitle(title: string): boolean {
  const t = title.trim();
  return !t || t === NEW_THREAD_TITLE || t === 'New chat';
}

/** A thread's name in the apps: its title, or "New thread" while it has none of its own. */
export function threadTitle(t: Pick<Thread, 'title'> | undefined): string {
  return !t || isDefaultThreadTitle(t.title) ? NEW_THREAD_TITLE : t.title.trim();
}

/**
 * The question a bot is waiting on in a thread, if any: the newest unanswered `ask_user` question of a reply still
 * being written. While there is one, what the user types in the composer answers it (`chat.answer`) rather than
 * queueing a new message behind the waiting turn. `messages` in any order.
 */
export function openQuestion(messages: readonly Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'agent' || m.status !== 'streaming') continue;
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const p = m.parts[j]!;
      // a form card is answered on the card: words typed meanwhile are a message of their own
      if (p.type === 'question' && p.answer === undefined && !p.form) return p.questionId;
    }
  }
  return undefined;
}

/** The name a new bot starts with in the editors: "New Bot", or "New Bot 2"… when one is taken. It renames itself while it sets up. */
export function newBotName(names: Iterable<string>): string {
  const taken = new Set([...names].map((n) => n.trim().toLowerCase()));
  if (!taken.has('new bot')) return 'New Bot';
  for (let i = 2; ; i++) if (!taken.has(`new bot ${i}`)) return `New Bot ${i}`;
}

/** A bot still called what the editor named it ("New Bot", "New Bot 2"): its setup asks what to call it. */
export const hasPlaceholderName = (name: string): boolean => /^new bot(?: \d+)?$/i.test(name.trim());

/** How many chats the apps fetch ahead once connected, so opening a bot shows its chat at once. */
export const PREFETCH_CHATS = 8;

/**
 * The chats worth fetching ahead (the newest page of each, in the background, one at a time): each bot's current chat
 * (what opening it shows), the most recently active first, leaving out empty ones, ones made here that the computer
 * hasn't named yet (`local:` ids) and ones the app already has messages for (`have`).
 */
export function chatsToPrefetch<T extends Pick<Thread, 'id' | 'botId' | 'source' | 'createdAt' | 'lastActiveAt' | 'lastMessagePreview'>>(
  threads: readonly T[],
  have: (threadId: string) => boolean,
  n = PREFETCH_CHATS,
): string[] {
  const bots = [...new Set(threads.map((t) => t.botId))];
  return bots
    .map((b) => currentChat(threads, b))
    .filter((t): t is T => !!t && !!t.lastMessagePreview && !t.id.startsWith('local:') && !have(t.id))
    .sort((a, b) => threadActiveAt(b) - threadActiveAt(a))
    .slice(0, n)
    .map((t) => t.id);
}
