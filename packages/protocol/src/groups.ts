/**
 * Groups: a few bots that talk with each other in a room of their own to get work done together. The room keeps its
 * own messages (`GroupMessage`: the user's, each bot's, AppuBot's notes), not a thread. Who answers a message:
 * the bots it names with @Name; a message with no names from the user goes to the group's lead (a chief bot; every
 * member when there is none), one from the lead to every other member, and one from a member back to the lead. A
 * bot's reply to a group message is posted to the room as its message (it answers in its own group thread,
 * `Thread.source: 'group'`), and bots may talk among themselves for `GROUP_HOPS_MAX` messages after the user's last
 * before AppuBot pauses them.
 */
import { z } from 'zod';
import { GoalSchema, Id, Timestamp } from './entities';

/**
 * One of a group's threads: the room starts a new conversation (`groups.newChat`) the way a bot starts a new thread,
 * each member answering it in a brand-new thread of its own. A group from before threads has none listed: its one
 * thread is the group itself (`id` = the group's id, its messages without `chatId`); `groupChats` gives it.
 */
export const GroupChatSchema = z.object({
  id: Id,
  /** its first message from the user, shortened; '' until then */
  title: z.string().default(''),
  lastMessagePreview: z.string().default(''),
  createdAt: Timestamp,
  lastActiveAt: Timestamp.optional(),
  /**
   * A goal the group works toward on its own in this thread (the lead's \`start_goal\`): while it is on, the bots' exchange
   * isn't paused after \`GROUP_HOPS_MAX\`; its budget counts the bots' messages (\`turns\` of \`maxTurns\`), and a room
   * gone quiet before it is done sends the lead on.
   */
  goal: GoalSchema.optional(),
});
export type GroupChat = z.infer<typeof GroupChatSchema>;

export const GroupSchema = z.object({
  id: Id,
  name: z.string(),
  /** its members, in the order they were added */
  botIds: z.array(Id).default([]),
  /** the member that leads it (a chief bot); absent: the first chief among the members, else no lead */
  leadId: Id.optional(),
  /** pinned to the top of the roster as a tile, like a pinned bot (`Bot.pinned`); any device sees it. Absent: not pinned */
  pinned: z.boolean().optional(),
  lastMessagePreview: z.string().default(''),
  /** bots taking a turn on the room's latest messages right now */
  working: z.array(Id).default([]),
  /** which thread each working bot is answering (bot id → `GroupChat.id`) */
  workingIn: z.record(z.string(), Id).default({}),
  /** its threads, oldest first (empty: only the group's first thread, see `groupChats`) */
  chats: z.array(GroupChatSchema).default([]),
  /** the thread on screen and the one a bot's `post_to_group` goes to; absent: the newest */
  currentChatId: Id.optional(),
  /**
   * The agent, model and effort every member answers the group on (each in its own group thread), over its bot's own;
   * absent: each bot runs on its own. `modelId` '' / absent: that agent's default; `effort` absent: each bot's own.
   */
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  effort: z.string().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** when the room was last posted to */
  lastActiveAt: Timestamp.optional(),
});
export type Group = z.infer<typeof GroupSchema>;

/** Who posted a room message: the user (from an app), a member bot, or AppuBot itself (a note: paused, stopped). */
export const GroupAuthorSchema = z.object({
  kind: z.enum(['user', 'bot', 'system']),
  botId: Id.optional(),
  /** the bot's name when it posted (kept, so a renamed or deleted bot still reads) */
  name: z.string().optional(),
});
export type GroupAuthor = z.infer<typeof GroupAuthorSchema>;

export const GroupMessageSchema = z.object({
  id: Id,
  groupId: Id,
  from: GroupAuthorSchema,
  text: z.string(),
  /** its thread in the group (absent: the group's first thread, whose id is the group's) */
  chatId: Id.optional(),
  /** the members it names (@Name), who answer it */
  mentions: z.array(Id).default([]),
  /** how many bot messages since the user last posted (the user's own are 0) */
  hop: z.number().int().nonnegative().default(0),
  /** a user message's id on the device that sent it (`groups.send clientId`) */
  clientId: z.string().max(100).optional(),
  createdAt: Timestamp,
});
export type GroupMessage = z.infer<typeof GroupMessageSchema>;

/**
 * One of a group's threads as another computer had it (`groups.restore`, a transfer): its messages with the bots
 * already given this computer's ids (a member that didn't come keeps only its name), new ids made here.
 */
export const GroupRestoreChatSchema = z.object({
  /** its id on the computer it came from (the group's own id there for its first thread): its members' threads follow it */
  fromId: Id.optional(),
  title: z.string().max(200).default(''),
  createdAt: Timestamp,
  messages: z.array(GroupMessageSchema.pick({ from: true, text: true, mentions: true, hop: true, createdAt: true })).max(2000),
});
export type GroupRestoreChat = z.infer<typeof GroupRestoreChatSchema>;
/** threads a `groups.restore` takes at once */
export const GROUP_RESTORE_CHATS_MAX = 100;
/** characters of messages a `groups.restore` takes at once (a transfer leaves the oldest out past it) */
export const GROUP_RESTORE_CHARS_MAX = 8_000_000;

/** a group goal's messages when the lead doesn't say */
export const GROUP_GOAL_MESSAGES_DEFAULT = 40;
/** how many members of a group take a turn at the same time (the rest wait their turn, like people in a chat: one agent process at a time per room) */
export const GROUP_TURNS_AT_ONCE = 1;
/** how many messages bots may send each other in a group after the user's last one before AppuBot pauses the room */
export const GROUP_HOPS_MAX = 12;
/** how many room messages a group keeps */
export const GROUP_MESSAGES_MAX = 2000;
/** how long a bot waits for another bot's reply (`message_bot wait`) */
export const BOT_MESSAGE_WAIT_MS = 15 * 60_000;
/** how many times two bots may answer each other in one exchange before the caller is told to stop */
export const BOT_MESSAGE_HOPS_MAX = 6;

/** A group's threads, oldest first: its own list, else its first thread (the group's id) as from before threads. */
export function groupChats(g: Pick<Group, 'id' | 'chats' | 'createdAt' | 'lastActiveAt' | 'lastMessagePreview'>): GroupChat[] {
  if (g.chats?.length) return g.chats;
  return [{ id: g.id, title: '', lastMessagePreview: g.lastMessagePreview ?? '', createdAt: g.createdAt, ...(g.lastActiveAt ? { lastActiveAt: g.lastActiveAt } : {}) }];
}

/** The group's thread on screen: the one it names, else its newest. */
export function currentGroupChat(g: Pick<Group, 'id' | 'chats' | 'createdAt' | 'lastActiveAt' | 'lastMessagePreview' | 'currentChatId'>): GroupChat {
  const chats = groupChats(g);
  return chats.find((c) => c.id === g.currentChatId) ?? chats[chats.length - 1]!;
}

/** Which of its group's threads a room message is in. */
export function groupChatOf(m: Pick<GroupMessage, 'chatId' | 'groupId'>): string { return m.chatId ?? m.groupId; }
