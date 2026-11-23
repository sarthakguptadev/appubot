/**
 * The bot roster (Akeru's model, shared by the desktop sidebar and the phone's Chats tab): one row per bot showing
 * its latest message (from whichever of its threads), an unread dot, and whether it is working or needs you.
 */
import { currentChat, shownPreview, stripMarkdown, type Bot, type Thread } from '@appubot/protocol';

export type BotPresence = 'working' | 'needs-you' | null;

/** Working while one of its threads runs; needs you while one waits on an answer or an approval. */
export function presenceOf(thread: Pick<Thread, 'status'> | readonly Pick<Thread, 'status'>[] | undefined, waiting: boolean): BotPresence {
  const list = thread === undefined ? [] : Array.isArray(thread) ? thread : [thread as Pick<Thread, 'status'>];
  if (waiting || list.some((t) => t.status === 'waiting')) return 'needs-you';
  if (list.some((t) => t.status === 'running')) return 'working';
  return null;
}

export interface RosterRow<B extends Bot = Bot, T extends Thread = Thread> {
  bot: B;
  /** the bot's current thread (where turns that name no thread go; absent until the first message) */
  chat: T | undefined;
  /** its thread with the latest message (a Telegram chat's too): the row's preview and time */
  latest: T | undefined;
  /** any of its threads has a reply the user hasn't seen */
  unread: boolean;
  presence: BotPresence;
}

/** Rows for `bots` (in order), filtered by `query` on name and job. `waiting` holds thread ids with a pending approval. */
export function buildRoster<B extends Bot, T extends Thread>(
  bots: readonly B[],
  threads: readonly T[],
  opts: { unread: Readonly<Record<string, unknown>>; waiting: ReadonlySet<string>; query?: string },
): RosterRow<B, T>[] {
  const needle = (opts.query ?? '').trim().toLowerCase();
  return bots
    .filter((b) => !needle || b.name.toLowerCase().includes(needle) || b.job.toLowerCase().includes(needle))
    .map((b) => {
      // its threads for groups belong to the rooms, not to its row
      const botThreads = threads.filter((t) => t.botId === b.id && t.source !== 'group');
      let latest: T | undefined;
      for (const t of botThreads) {
        if (!shownPreview(t.lastMessagePreview)) continue;
        if (!latest || t.updatedAt > latest.updatedAt) latest = t;
      }
      return {
        bot: b,
        chat: currentChat(threads, b.id),
        latest,
        unread: botThreads.some((t) => !!opts.unread[t.id]),
        presence: presenceOf(botThreads, botThreads.some((t) => opts.waiting.has(t.id))),
      };
    });
}

/** The row's second line: "Needs you…", "Working…", the last message (markdown stripped), the bot's job, or "Say hi". */
export function rosterPreview(bot: Pick<Bot, 'job'>, chat: Pick<Thread, 'lastMessagePreview'> | undefined, presence: BotPresence): string {
  if (presence === 'needs-you') return 'Needs you…';
  const last = shownPreview(chat?.lastMessagePreview);
  if (presence === 'working' && !last) return 'Working…';
  const preview = last ? stripMarkdown(last) : bot.job;
  return preview || 'Say hi';
}
