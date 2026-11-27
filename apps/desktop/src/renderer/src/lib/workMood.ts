/**
 * What a working bot is doing, for its avatar (chat-core botWorkMood over the newest message of its running chat):
 * `listening` until its turn holds anything, then `thinking`, `tool` or `typing`. Undefined while none of its chats
 * runs. `threadId` reads that chat; else the bot's running one.
 */
import { botWorkMood, type BotMood } from '@appubot/chat-core';
import { useStore } from './store';

export function useWorkMood(botId: string | undefined, threadId?: string): BotMood | undefined {
  return useStore((s) => {
    const t = threadId ? s.threads.find((x) => x.id === threadId) : s.threads.find((x) => x.botId === botId && x.status === 'running');
    if (!t || t.status !== 'running') return undefined;
    const c = s.convo[t.id];
    const last = c?.ids.length ? c.byId[c.ids[c.ids.length - 1]!] : undefined;
    return last?.role === 'agent' && last.status === 'streaming' ? botWorkMood(last.parts) : 'listening';
  });
}
