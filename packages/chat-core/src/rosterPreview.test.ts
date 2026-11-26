import { describe, expect, it } from 'vitest';
import { messagePreview, type Message } from '@appubot/protocol';
import { rosterPreview } from './roster';

const msg = (parts: Message['parts']): Message => ({ id: 'm', threadId: 't', role: 'agent', parts, status: 'complete', createdAt: 1, updatedAt: 1 } as Message);

describe('previews never name a tool', () => {
  it('a turn that only ran a tool has no line of its own', () => {
    expect(messagePreview(msg([{ type: 'tool_call', id: 'c', title: 'ToolSearch', kind: 'other', status: 'completed' } as never]))).toBe('');
    expect(messagePreview(msg([{ type: 'tool_call', id: 'c', title: 'ToolSearch', kind: 'other', status: 'completed' } as never, { type: 'text', text: 'Found it.' } as never]))).toBe('Found it.');
  });
  it('a reply that used tools is read by what it ended on, not by what it wrote or sent while working', () => {
    const tool = { type: 'tool_call', id: 'c', title: 'Run the report', kind: 'execute', status: 'completed' } as never;
    const note = { type: 'text', text: 'On it: pulling the three reports.', said: true } as never;
    const text = (t: string) => ({ type: 'text', text: t }) as never;
    expect(messagePreview(msg([text('Let me look.'), note, tool, text('October came to ₹70,550.')]))).toBe('October came to ₹70,550.');
    // still working, or ended on a tool call: the last thing it wrote, else what it sent
    expect(messagePreview(msg([text('Let me look.'), note, tool, text('Building the PDF now.'), tool]))).toBe('Building the PDF now.');
    expect(messagePreview(msg([note, tool]))).toBe('On it: pulling the three reports.');
    // no tools: its words as before, without what it sent along the way
    expect(messagePreview(msg([text('Sent to Priya.'), { type: 'text', text: 'One more thing.', said: true } as never]))).toBe('Sent to Priya.');
    expect(messagePreview(msg([text('Part one.'), text('Part two.')]))).toBe('Part one. Part two.');
    // your own message is read whole
    expect(messagePreview({ ...msg([text('first'), text('second')]), role: 'user' } as Message)).toBe('first second');
  });
  it('one saved by a computer from before reads as the bot’s job', () => {
    expect(rosterPreview({ job: 'Keeps my inbox tidy' }, { lastMessagePreview: '⚙ ToolSearch' }, null)).toBe('Keeps my inbox tidy');
    expect(rosterPreview({ job: '' }, { lastMessagePreview: '⚙ ToolSearch' }, 'working')).toBe('Working…');
    expect(rosterPreview({ job: '' }, { lastMessagePreview: 'Done ⚙' }, null)).toBe('Done ⚙');
  });
});
