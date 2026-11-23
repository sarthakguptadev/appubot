import { beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '@appubot/protocol';
import { KEPT_MESSAGES, MAX_CONVERSATIONS_IN_MEMORY, MAX_CONVERSATIONS_KEPT, getState, keepConversationLast, mergeConversation, setState, touchConversation } from './store';

const msgs = (threadId: string, n: number): Message[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${threadId}-${i}`, threadId, role: 'user', parts: [{ type: 'text', text: 'x' }], status: 'complete', via: 'desktop', createdAt: i + 1, updatedAt: i + 1 }) as Message);

/** open a chat and load its newest page, as opening it in the app does */
function open(id: string, n = 100): void {
  touchConversation(id);
  mergeConversation(id, msgs(id, n), { newest: true, hasMore: false });
}

beforeEach(() => setState({ convo: {}, convoLru: [], selectedThreadId: null }));

describe('chats kept in memory', () => {
  it('keeps the newest messages of a chat pushed past the whole ones, to be read again when opened', () => {
    for (let i = 0; i <= MAX_CONVERSATIONS_IN_MEMORY; i++) open(`t${i}`);
    const pushed = getState().convo.t0!;
    expect(pushed.ids).toHaveLength(KEPT_MESSAGES);
    expect(pushed.ids.at(-1)).toBe('t0-99');
    expect(pushed).toMatchObject({ loaded: false, hasMore: true });
    expect(getState().convo[`t${MAX_CONVERSATIONS_IN_MEMORY}`]!.loaded).toBe(true);
  });

  it('drops chats past the kept ones, never the one on screen', () => {
    open('screen');
    setState({ selectedThreadId: 'screen' });
    for (let i = 0; i < MAX_CONVERSATIONS_KEPT + 2; i++) open(`t${i}`);
    expect(getState().convoLru).toHaveLength(MAX_CONVERSATIONS_KEPT + 1);
    expect(getState().convo.t0).toBeUndefined();
    expect(getState().convo.screen!.loaded).toBe(true);
  });

  it('puts a chat fetched ahead at the end, behind the ones opened here', () => {
    open('a');
    open('b');
    keepConversationLast('ahead');
    expect(getState().convoLru).toEqual(['b', 'a', 'ahead']);
    keepConversationLast('a');
    expect(getState().convoLru).toEqual(['b', 'a', 'ahead']);
  });
});
