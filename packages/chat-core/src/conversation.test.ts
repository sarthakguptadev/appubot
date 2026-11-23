import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message, Part } from '@appubot/protocol';
import {
  SESSION_GAP_MS, compareMessages, conversationPreface, conversationSeparators, conversationTurns, historyPage,
  selectRecentTurns, separatorLabel, transcriptText,
} from './conversation';
import { setClockStyle } from './format';

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
let n = 0;
const msg = (role: Message['role'], createdAt: number, parts: Part[], extra: Partial<Message> = {}): Message => ({
  id: `m${String(++n).padStart(3, '0')}`, threadId: 't', role, parts, status: 'complete', via: 'desktop', createdAt, updatedAt: createdAt, ...extra,
});
const text = (t: string): Part => ({ type: 'text', text: t });

describe('compareMessages / historyPage', () => {
  it('orders by time, a prompt before a same-millisecond reply, then by id', () => {
    const a = msg('agent', 5, [], { id: 'a' });
    const u = msg('user', 5, [], { id: 'z' });
    const b = msg('agent', 5, [], { id: 'b' });
    const early = msg('agent', 1, [], { id: 'y' });
    expect([b, a, u, early].sort(compareMessages).map((m) => m.id)).toEqual(['y', 'z', 'a', 'b']);
  });

  it('merges lists from several threads and pages back from the newest', () => {
    const t1 = [msg('user', 10, [], { threadId: 'old' }), msg('agent', 11, [], { threadId: 'old' })];
    const t2 = [msg('user', 20, [], { threadId: 'cur' }), msg('agent', 21, [], { threadId: 'cur' }), msg('user', 30, [], { threadId: 'cur' })];
    const all = [...t2, ...t1];
    const first = historyPage(all, { limit: 2 });
    expect(first.messages.map((m) => m.createdAt)).toEqual([21, 30]);
    expect(first.hasMore).toBe(true);
    const second = historyPage(all, { limit: 2, before: first.messages[0]! });
    expect(second.messages.map((m) => m.createdAt)).toEqual([11, 20]);
    const last = historyPage(all, { limit: 2, before: second.messages[0]! });
    expect(last.messages.map((m) => m.createdAt)).toEqual([10]);
    expect(last.hasMore).toBe(false);
  });

  it('never splits same-millisecond messages across pages', () => {
    const list = [msg('user', 7, [], { id: 'u' }), msg('agent', 7, [], { id: 'a' }), msg('agent', 7, [], { id: 'b' })];
    const p1 = historyPage(list, { limit: 1 });
    const p2 = historyPage(list, { limit: 1, before: p1.messages[0]! });
    const p3 = historyPage(list, { limit: 1, before: p2.messages[0]! });
    expect([...p3.messages, ...p2.messages, ...p1.messages].map((m) => m.id)).toEqual(['u', 'a', 'b']);
  });

  it('reaches back to `since` (capped) so a link to an older chat can show it', () => {
    const list = Array.from({ length: 50 }, (_, i) => msg(i % 2 ? 'agent' : 'user', i, []));
    expect(historyPage(list, { limit: 5, since: 10 }).messages.length).toBe(40);
    expect(historyPage(list, { limit: 5, since: 10, max: 20 }).messages.length).toBe(20);
    expect(historyPage(list, { limit: 5, since: 48 }).messages.length).toBe(5);
  });
});

describe('separatorLabel (Akeru)', () => {
  const now = at(2026, 10, 13, 15, 0);
  beforeEach(() => setClockStyle('12h'));
  afterEach(() => setClockStyle('auto'));

  it('marks the first message, a new day and a gap of 4 hours or more', () => {
    expect(separatorLabel(at(2026, 8, 16, 13, 54), null, now)).toBe('Sun, Aug 16 1:54 PM');
    expect(separatorLabel(at(2026, 8, 16, 14, 0), at(2026, 8, 16, 13, 54), now)).toBeNull();
    expect(separatorLabel(at(2026, 8, 16, 18, 0), at(2026, 8, 16, 14, 0), now)).toBe('Sun, Aug 16 6:00 PM');
    expect(separatorLabel(at(2026, 8, 16, 14, 0) + SESSION_GAP_MS - 1, at(2026, 8, 16, 14, 0), now)).toBeNull();
    expect(separatorLabel(at(2026, 8, 17, 0, 5), at(2026, 8, 16, 23, 50), now)).toBe('Mon, Aug 17 12:05 AM');
  });

  it('says Today for today and adds the year for another one', () => {
    expect(separatorLabel(at(2026, 10, 13, 9, 2), null, now)).toBe('Today 9:02 AM');
    expect(separatorLabel(at(2025, 12, 31, 12, 30), null, now)).toBe('Wed, Dec 31, 2025 12:30 PM');
  });

  it('tells the time as Settings says (Time format), like every other clock', () => {
    setClockStyle('24h');
    expect(separatorLabel(at(2026, 10, 13, 19, 28), null, now)).toBe('Today 19:28');
    expect(separatorLabel(at(2026, 8, 17, 0, 5), null, now)).toBe('Mon, Aug 17 00:05');
  });

  it('labels a whole list', () => {
    const list = [at(2026, 10, 12, 9), at(2026, 10, 12, 9, 5), at(2026, 10, 13, 9)].map((t) => ({ createdAt: t }));
    expect(conversationSeparators(list, now)).toEqual(['Mon, Oct 12 9:00 AM', null, 'Today 9:00 AM']);
  });
});

describe('priming a fresh session', () => {
  const tool = (title: string, extra: Partial<Extract<Part, { type: 'tool_call' }>> = {}): Part => ({
    type: 'tool_call', toolCallId: title, title, kind: 'execute', status: 'completed', content: [], locations: [], rawInput: { command: title }, ...extra,
  });

  it('writes a message as text with one line per tool call and no blobs', () => {
    const agent = msg('agent', 1, [
      { type: 'thought', text: 'secret reasoning' },
      tool('ls -la'),
      tool('npm test', { status: 'failed' }),
      { type: 'tool_call', toolCallId: 'x', title: 'ToolSearch', kind: 'other', status: 'completed', content: [], locations: [] },
      text('All done.'),
      { type: 'image', mimeType: 'image/png', data: 'AAAA'.repeat(1000) },
      { type: 'file', file: { id: 'f', name: 'report.pdf', mimeType: 'application/pdf', size: 1, url: '/files/f' } },
      { type: 'question', questionId: 'q', question: 'Email it?', options: ['Yes', 'No'], answer: 'Yes' },
    ]);
    const t = transcriptText(agent);
    expect(t).toBe('  · Ran ls -la\n  · Ran npm test (failed)\nAll done.\n[showed an image]\n[sent file: report.pdf]\n[asked: Email it? → the user answered: Yes]');
    expect(t).not.toContain('AAAA');
    expect(t).not.toContain('secret');
    const user = msg('user', 2, [text('Look at this\nFiles: /Users/me/a/b.png'), { type: 'image', mimeType: 'image/png', data: 'BBBB' }]);
    expect(transcriptText(user)).toBe('Look at this\n[attached: b.png]\n[attached an image]');
  });

  it('clips one huge message, keeping its start and end', () => {
    const long = `${'a'.repeat(5000)}${'z'.repeat(5000)}`;
    const t = transcriptText(msg('agent', 1, [text(long)]));
    expect(t.length).toBeLessThan(6_200);
    expect(t.startsWith('aaa')).toBe(true);
    expect(t.endsWith('zzz')).toBe(true);
    expect(t).toContain('characters left out');
  });

  it('groups whole turns and keeps the newest that fit, in order', () => {
    const list: Message[] = [];
    for (let i = 0; i < 40; i++) {
      list.push(msg('user', i * 10, [text(`question ${i}`)]));
      list.push(msg('agent', i * 10 + 1, [text(`answer ${i}`)]));
    }
    expect(conversationTurns(list)).toHaveLength(40);
    const turns = selectRecentTurns(list);
    expect(turns).toHaveLength(30);
    expect(turns[0]![0]!.parts[0]).toEqual(text('question 10'));
    expect(turns[29]![1]!.parts[0]).toEqual(text('answer 39'));
    // a tight budget keeps fewer turns, but always the newest
    expect(selectRecentTurns(list, { tokenLimit: 12 })).toHaveLength(2);
    expect(selectRecentTurns(list, { tokenLimit: 1 })).toHaveLength(1);
  });

  it('skips turns nobody answered', () => {
    const list = [msg('user', 1, [text('hello?')]), msg('user', 2, [text('hi')]), msg('agent', 3, [text('hey')])];
    expect(selectRecentTurns(list).map((t) => t.length)).toEqual([2]);
  });

  it('formats the preface with stamps, the bot name and the old turns', () => {
    const list = [
      msg('user', at(2026, 10, 11, 9, 2), [text('Make an invoice for Acme')]),
      msg('agent', at(2026, 10, 11, 9, 3), [tool('python3 make_invoice.py'), text('Done: INV-0042.')]),
      msg('user', at(2026, 10, 12, 18, 30), [text('Thanks!')]),
      msg('agent', at(2026, 10, 12, 18, 31), [], { status: 'cancelled' }),
    ];
    const p = conversationPreface(list, { botName: 'Appu' })!;
    expect(p).toContain('<conversation-so-far>');
    expect(p).toContain('last 2 turns');
    expect(p).toContain('[Sun 2026-10-11 09:02] User: Make an invoice for Acme\nAppu:\n  · Ran python3 make_invoice.py\nDone: INV-0042.');
    expect(p).toContain('[Mon 2026-10-12 18:30] User: Thanks!\nAppu: [stopped by the user]');
    expect(p.endsWith('The user’s new message:')).toBe(true);
    expect(conversationPreface([], { botName: 'Appu' })).toBeNull();
  });
});

describe('transcriptText voice parts', () => {
  const voice: Part = { type: 'voice', kind: 'recording', durationMs: 900, file: { id: 'f', name: 'v.ogg', mimeType: 'audio/ogg', size: 1, url: '/files/f' } };
  it('adds nothing next to a transcript, else says what it was', () => {
    expect(transcriptText(msg('user', 1, [voice, text('hello there')]))).toBe('hello there');
    expect(transcriptText(msg('user', 1, [voice]))).toBe('[a voice message]');
    expect(transcriptText(msg('agent', 1, [voice]))).toBe('[read aloud]');
    expect(transcriptText(msg('agent', 1, [text('Sure.'), voice]))).toBe('Sure.');
  });
});
