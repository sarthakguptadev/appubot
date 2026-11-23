import { describe, expect, it } from 'vitest';
import type { Message } from '@appubot/protocol';
import { messageInfo } from './messageInfo';

const msg = (over: Partial<Message> = {}): Message =>
  ({ id: 'm', threadId: 't', role: 'user', parts: [{ type: 'text', text: 'hi' }], status: 'complete', via: 'desktop', createdAt: 0, updatedAt: 0, ...over }) as Message;
const file = { id: 'f', name: 'a.ogg', mimeType: 'audio/ogg', size: 1 } as never;

describe('messageInfo', () => {
  it('names where it came from', () => {
    expect(messageInfo(msg(), 'Mac').rows[0]).toMatchObject({ label: 'From', value: 'Your Mac' });
    expect(messageInfo(msg({ via: 'mobile' }), 'Mac')).toMatchObject({ source: 'phone', rows: [{ value: 'Your phone' }, { label: 'Sent' }] });
    expect(messageInfo(msg({ via: 'channel' }), 'PC').rows[0]).toMatchObject({ value: 'Telegram', note: 'Its reply went to Telegram too' });
    expect(messageInfo(msg({ via: 'routine' }), 'PC').source).toBe('routine');
  });

  it('adds a spoken length and what was attached', () => {
    const parts = [{ type: 'voice', file, durationMs: 64_000, kind: 'recording' }, { type: 'file', file }, { type: 'image', data: '', mimeType: 'image/png' }, { type: 'image', data: '', mimeType: 'image/png' }] as Message['parts'];
    const rows = messageInfo(msg({ parts }), 'Mac').rows;
    expect(rows.map((r) => r.label)).toEqual(['From', 'Sent', 'Spoken', 'Attached']);
    expect(rows[2]!.value).toBe('1m 4s');
    expect(rows[3]!.value).toBe('1 file, 2 pictures');
    expect(rows[3]!.text).toBe('Attached 1 file, 2 pictures');
  });

  it('words each row as the (i) menu shows it', () => {
    expect(messageInfo(msg(), 'Mac').rows[0]!.text).toBe('From your Mac');
    expect(messageInfo(msg({ via: 'routine' }), 'PC').rows[0]!.text).toBe('From a routine');
    expect(messageInfo(msg({ via: 'routine', routine: { id: 'r1', name: 'Asana check' } }), 'PC').rows[0]).toMatchObject({ value: 'Asana check', text: 'From the routine Asana check', note: 'Sent on its schedule' });
    expect(messageInfo(msg({ via: 'channel' }), 'PC').rows[1]!.text).toMatch(/^Sent /);
  });
});
