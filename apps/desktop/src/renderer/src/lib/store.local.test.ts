import { beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '@appubot/protocol';
import { getState, mergeConversation, replaceLocal, rowKeyOf, setState } from './store';

const m = (id: string, at: number, extra: Partial<Message> = {}): Message =>
  ({ id, threadId: 't1', role: 'user', parts: [{ type: 'text', text: id }], status: 'complete', via: 'desktop', createdAt: at, updatedAt: at, ...extra }) as Message;

beforeEach(() => setState({ convo: {}, convoLru: [] }));

describe('local copies in a conversation', () => {
  it('keeps messages still on their way when an old saved copy is replaced by a newer page', () => {
    mergeConversation('t1', [m('old1', 10), m('old2', 20), m('local:x', 30)]);
    mergeConversation('t1', [m('new1', 100), m('new2', 110)], { newest: true, hasMore: true });
    expect(getState().convo.t1!.ids).toEqual(['local:x', 'new1', 'new2']);
    expect(getState().convo.t1!.loaded).toBe(true);
  });

  it('lets the computer’s message take a copy’s place and its transcript row', () => {
    mergeConversation('t1', [m('a', 10), m('local:x', 20)]);
    replaceLocal('t1', 'local:x', m('msg_real', 21, { clientId: 'local:x' }));
    expect(getState().convo.t1!.ids).toEqual(['a', 'msg_real']);
    expect(rowKeyOf('msg_real')).toBe('local:x');
    expect(rowKeyOf('a')).toBe('a');
  });

  it('takes a deleted copy out', () => {
    mergeConversation('t1', [m('a', 10), m('local:y', 20)]);
    replaceLocal('t1', 'local:y');
    expect(getState().convo.t1!.ids).toEqual(['a']);
  });

  it('lets a page that already has the computer’s copy replace the local one', () => {
    mergeConversation('t1', [m('a', 10), m('local:z', 20)]);
    mergeConversation('t1', [m('a', 10), m('msg_z', 21, { clientId: 'local:z' })], { newest: true, hasMore: false });
    expect(getState().convo.t1!.ids).toEqual(['a', 'msg_z']);
    expect(rowKeyOf('msg_z')).toBe('local:z');
  });
});
