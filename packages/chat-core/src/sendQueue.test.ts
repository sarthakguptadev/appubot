import { describe, expect, it } from 'vitest';
import type { Message } from '@appubot/protocol';
import { SENDING_QUIET_MS, absorbLocals, copyOfReply, dropReply, localMessages, localTime, replyIdOf, sendLook, settleLocal } from './sendQueue';

const real = (id: string, role: 'user' | 'agent', text = '', extra: Partial<Message> = {}): Message =>
  ({ id, threadId: 't1', role, parts: text ? [{ type: 'text', text }] : [], status: role === 'agent' ? 'streaming' : 'complete', via: 'desktop', createdAt: 200, updatedAt: 200, ...extra }) as Message;
const sending = (withReply = true) => localMessages({ localId: 'local:a', threadId: 't1', text: 'hello', images: [], at: 100, withReply });

describe('local copies', () => {
  it('shows the message with its clientId and the bot working under it', () => {
    const [user, reply] = sending();
    expect(user).toMatchObject({ id: 'local:a', clientId: 'local:a', role: 'user', createdAt: 100, parts: [{ type: 'text', text: 'hello' }] });
    expect(reply).toMatchObject({ id: replyIdOf('local:a'), role: 'agent', status: 'streaming', createdAt: 101 });
    expect(copyOfReply(reply!.id)).toBe('local:a');
    expect(copyOfReply('local:a')).toBeNull();
    expect(sending(false)).toHaveLength(1);
  });

  it('carries files as chips without links, and a spoken message its recording', () => {
    const [user] = localMessages({
      localId: 'local:b', threadId: 't1', text: 'see this', images: [], at: 1, withReply: false,
      files: [{ name: 'a.pdf', mimeType: 'application/pdf', size: 12 }], voice: { recordingId: 'f_rec', durationMs: 2300 },
    });
    expect(user!.parts.map((p) => p.type)).toEqual(['voice', 'file', 'text']);
    expect(user!.parts[0]).toMatchObject({ kind: 'recording', durationMs: 2300, file: { id: 'f_rec', url: '/files/f_rec' } });
    expect(user!.parts[1]).toMatchObject({ file: { name: 'a.pdf', url: '' } });
  });

  it('goes after everything already in its chat, whatever this clock says', () => {
    expect(localTime(100, 500)).toBe(501);
    expect(localTime(900, 500)).toBe(900);
  });
});

describe('the computer’s messages taking the copies’ places', () => {
  it('swaps the copy by clientId, then the working row for the reply, keeping their rows', () => {
    const before = sending();
    const step1 = absorbLocals(before, [...before, real('u1', 'user', 'hello', { clientId: 'local:a' })]);
    expect(step1.list.map((m) => m.id)).toEqual(['local:a:reply', 'u1']);
    expect(step1.aliases).toEqual([['u1', 'local:a']]);
    // the row stays under the confirmed message, whose time is the computer's
    expect(step1.list.find((m) => m.id === 'local:a:reply')!.createdAt).toBe(201);
    const step2 = absorbLocals(step1.list, [...step1.list, real('a1', 'agent')]);
    expect(step2.list.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(step2.aliases).toEqual([['a1', 'local:a:reply']]);
  });

  it('never gives the working row to a reply before its message is confirmed, or to a system notice', () => {
    const before = sending();
    expect(absorbLocals(before, [...before, real('a0', 'agent')]).aliases).toEqual([]);
    const confirmed = absorbLocals(before, [...before, real('u1', 'user', 'hello', { clientId: 'local:a' })]).list;
    expect(absorbLocals(confirmed, [...confirmed, real('n1', 'agent', 'updated', { via: 'system' })]).aliases).toEqual([]);
  });

  it('leaves copies alone for someone else’s message with the same words', () => {
    const before = sending(false);
    const r = absorbLocals(before, [...before, real('u9', 'user', 'hello', { via: 'mobile' })]);
    expect(r.aliases).toEqual([]);
    expect(r.list.map((m) => m.id)).toEqual(['local:a', 'u9']);
  });

  it('settles from chat.send’s answer: the copy replaced, the working row renamed to the reply’s id', () => {
    const r = settleLocal(sending(), 'local:a', real('u1', 'user', 'hello', { clientId: 'local:a' }), 'a1');
    expect(r.list.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(r.aliases).toEqual([['u1', 'local:a'], ['a1', 'local:a:reply']]);
  });

  it('settles once only: an event that brought both first leaves nothing to do', () => {
    const list = [real('u1', 'user', 'hello', { clientId: 'local:a' }), real('a1', 'agent')];
    const r = settleLocal(list, 'local:a', list[0]!, 'a1');
    expect(r.list).toEqual(list);
    expect(r.aliases).toEqual([]);
  });

  it('drops only the working row when a send fails', () => {
    expect(dropReply(sending(), 'local:a').map((m) => m.id)).toEqual(['local:a']);
  });
});

describe('how a message on its way looks', () => {
  it('is quiet for its first second, then pending, and failed says so', () => {
    expect(sendLook('sending', 1000, 1000 + SENDING_QUIET_MS - 1)).toBe('quiet');
    expect(sendLook('queued', 1000, 1000 + SENDING_QUIET_MS)).toBe('pending');
    expect(sendLook('uploading', 1000, 5000)).toBe('pending');
    expect(sendLook('failed', 1000, 1000)).toBe('failed');
  });
});
