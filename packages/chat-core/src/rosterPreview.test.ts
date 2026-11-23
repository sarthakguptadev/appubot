import { describe, expect, it } from 'vitest';
import { messagePreview, type Message } from '@appubot/protocol';
import { rosterPreview } from './roster';

const msg = (parts: Message['parts']): Message => ({ id: 'm', threadId: 't', role: 'agent', parts, status: 'complete', createdAt: 1, updatedAt: 1 } as Message);

describe('previews never name a tool', () => {
  it('a turn that only ran a tool has no line of its own', () => {
    expect(messagePreview(msg([{ type: 'tool_call', id: 'c', title: 'ToolSearch', kind: 'other', status: 'completed' } as never]))).toBe('');
    expect(messagePreview(msg([{ type: 'tool_call', id: 'c', title: 'ToolSearch', kind: 'other', status: 'completed' } as never, { type: 'text', text: 'Found it.' } as never]))).toBe('Found it.');
  });
  it('one saved by a computer from before reads as the bot’s job', () => {
    expect(rosterPreview({ job: 'Keeps my inbox tidy' }, { lastMessagePreview: '⚙ ToolSearch' }, null)).toBe('Keeps my inbox tidy');
    expect(rosterPreview({ job: '' }, { lastMessagePreview: '⚙ ToolSearch' }, 'working')).toBe('Working…');
    expect(rosterPreview({ job: '' }, { lastMessagePreview: 'Done ⚙' }, null)).toBe('Done ⚙');
  });
});
