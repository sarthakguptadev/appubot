import { describe, expect, it } from 'vitest';
import type { Part } from '@appubot/protocol';
import type { ToolCallPart } from './toolText';
import { liveStepLabel, stepLabel } from './liveStep';

let n = 0;
const tool = (kind: ToolCallPart['kind'], extra: Partial<ToolCallPart> = {}): ToolCallPart => ({
  type: 'tool_call', toolCallId: `t${++n}`, title: 'Tool', kind, status: 'in_progress', content: [], locations: [], ...extra,
});
const text = (t: string, said?: boolean): Part => ({ type: 'text', text: t, ...(said ? { said } : {}) });

describe('a step in plain words', () => {
  it('names files, sites and apps, never a command or a tool', () => {
    expect(stepLabel(tool('read', { title: 'Read /Users/s/docs/report.md', locations: [{ path: '/Users/s/docs/report.md' }] }))).toBe('Reading report.md');
    expect(stepLabel(tool('edit', { title: 'Edit a.ts', locations: [{ path: '/x/a.ts' }] }))).toBe('Editing a.ts');
    expect(stepLabel(tool('execute', { title: 'nohup google-chrome --no-first-run', rawInput: { command: 'nohup google-chrome --no-first-run &' } }))).toBe('Running a command');
    expect(stepLabel(tool('execute', { title: 'cat notes.txt', rawInput: { command: 'cat /tmp/notes.txt' } }))).toBe('Reading notes.txt');
    expect(stepLabel(tool('search', { title: 'grep', rawInput: { pattern: 'foo|bar\\(' } }))).toBe('Searching your files');
    expect(stepLabel(tool('fetch', { title: 'Fetch', rawInput: { url: 'https://www.news.ycombinator.com/item?id=1' } }))).toBe('Reading news.ycombinator.com');
    expect(stepLabel(tool('fetch', { title: 'WebSearch', rawInput: { query: 'Jammu weather' } }))).toBe('Searching the web for “Jammu weather”');
    expect(stepLabel(tool('other', { title: 'mcp__appubot__apps_execute', rawInput: { tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS' }] } }))).toBe('Using Gmail');
    expect(stepLabel(tool('other', { title: 'mcp__appubot__computer_click' }))).toBe('Using the computer');
    expect(stepLabel(tool('computer', { title: 'Click' }))).toBe('Using the computer');
  });

  it('has no words for a tool it cannot name plainly', () => {
    expect(stepLabel(tool('other', { title: 'mcp__appubot__some_new_tool' }))).toBeUndefined();
    expect(stepLabel(tool('other', { title: 'mcp__github__create_issue' }))).toBeUndefined();
  });

  it('cuts a long name short', () => {
    const path = `/x/${'quarterly-travel-spend-'.repeat(4)}.csv`;
    const label = stepLabel(tool('read', { title: 'Read', locations: [{ path }] }))!;
    expect(label.length).toBeLessThanOrEqual(48);
    expect(label.startsWith('Reading quarterly-travel-spend-')).toBe(true);
  });
});

describe('the live step of a turn', () => {
  it('follows the newest call, then says Typing… once the reply comes in', () => {
    const weather = tool('fetch', { title: 'WebSearch', rawInput: { query: 'Jammu weather' } });
    const hn = tool('fetch', { title: 'Fetch', rawInput: { url: 'https://news.ycombinator.com' } });
    expect(liveStepLabel([])).toBeUndefined();
    expect(liveStepLabel([weather])).toBe('Searching the web for “Jammu weather”');
    expect(liveStepLabel([weather, text('Checking both now.', true), hn])).toBe('Reading news.ycombinator.com');
    expect(liveStepLabel([weather, hn, text('Jammu is 14°C')])).toBe('Typing…');
  });

  it('passes over a message the bot sent along the way and empty text, and says Thinking over a thought', () => {
    const hn = tool('fetch', { title: 'Fetch', rawInput: { url: 'https://news.ycombinator.com' } });
    expect(liveStepLabel([hn, text('On it', true)])).toBe('Reading news.ycombinator.com');
    expect(liveStepLabel([hn, text('  ')])).toBe('Reading news.ycombinator.com');
    expect(liveStepLabel([{ type: 'thought', text: 'Let me see' }])).toBe('Thinking');
  });
});
