/**
 * Emoji reactions, as both apps offer them: five quick ones under a reply, and more behind "+". Reactions live on the
 * message (protocol `Message.reactions`, one per side); `chat.react` sets the user's, the bot's `react` tool its own.
 */
import type { Message, Reaction } from '@appubot/protocol';

export const QUICK_REACTIONS = ['👍', '👎', '❤️', '😂', '🎉'] as const;

export const MORE_REACTIONS = [
  '🙏', '🔥', '👏', '😮', '😢', '😡', '🤔', '👀',
  '✅', '❌', '💯', '🙌', '😍', '🥳', '😅', '🤝',
  '💪', '🚀', '⭐', '☕', '🍕', '🛒', '📦', '💸',
] as const;

/** One side's reaction on a message, if any. */
export function reactionBy(msg: Pick<Message, 'reactions'>, by: Reaction['by']): string | undefined {
  return msg.reactions?.find((r) => r.by === by)?.emoji;
}
