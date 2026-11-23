// The work trail's rules, after MonoCode's transcriptActivity.test.ts (MIT, Copyright (c) 2026 Nick), on AppuBot's parts.
import { describe, expect, it } from 'vitest';
import type { Part } from '@appubot/protocol';
import type { ToolCallPart } from './toolText';
import {
  bridgeTool, failedCount, foldableWork, initialThinkingIndex, isHiddenTool, isWeakToolTitle, proseSummary, toolState, trailItems,
  trailSentence, trailSteps, workCategory, workKind, workSummaryLine, type TrailItem, type TrailStep,
} from './workTrail';

let n = 0;
const tool = (kind: ToolCallPart['kind'], extra: Partial<ToolCallPart> = {}): ToolCallPart => ({
  type: 'tool_call', toolCallId: `t${++n}`, title: 'Tool', kind, status: 'completed', content: [], locations: [], ...extra,
});
const read = (path: string, extra: Partial<ToolCallPart> = {}) => tool('read', { title: `Read ${path}`, locations: [{ path }], ...extra });
const edit = (path: string, extra: Partial<ToolCallPart> = {}) => tool('edit', { title: `Edit ${path}`, locations: [{ path }], ...extra });
const search = (pattern = 'theme') => tool('search', { title: 'grep', rawInput: { pattern } });
const shell = (command = 'npm test', extra: Partial<ToolCallPart> = {}) => tool('execute', { title: command, rawInput: { command }, ...extra });
const text = (t: string, said?: boolean): Part => ({ type: 'text', text: t, ...(said ? { said } : {}) });
const thought = (t = 'Let me look around.'): Part => ({ type: 'thought', text: t });
const steps = (parts: Part[]): TrailStep[] => parts.map((part, index) => ({ part, index }) as TrailStep);
const live = { settled: false };
const settled = { settled: true };
const kinds = (items: TrailItem[]) => items.map((i) => i.type);

describe('tool state', () => {
  it('reads pending, accepted and rejected', () => {
    expect(toolState(shell('a', { status: 'in_progress' }), live)).toBe('pending');
    expect(toolState(shell('a'), live)).toBe('accepted');
    expect(toolState(shell('a', { status: 'failed' }), live)).toBe('rejected');
  });

  it('keeps a call waiting on you pending, and settles an open one by how the turn ended', () => {
    const t = shell('a', { status: 'pending' });
    expect(toolState(shell('a', { status: 'completed' }), { settled: false, awaiting: new Set(['x']) })).toBe('accepted');
    expect(toolState(t, { settled: false, awaiting: new Set([t.toolCallId]) })).toBe('pending');
    expect(toolState(t, { settled: true })).toBe('accepted');
    expect(toolState(t, { settled: true, interrupted: true })).toBe('rejected');
  });
});

describe('hidden calls', () => {
  it('leaves out tool lookups and a call that says nothing yet', () => {
    expect(isHiddenTool(tool('other', { title: 'ToolSearch' }), live)).toBe(true);
    expect(isHiddenTool(tool('other', { title: 'Tool', status: 'pending' }), live)).toBe(true);
    expect(isHiddenTool(tool('other', { title: 'Tool', status: 'pending', rawInput: { path: '/a.ts' } }), live)).toBe(false);
    expect(isHiddenTool(tool('other', { title: 'Look up the weather', status: 'pending' }), live)).toBe(false);
    expect(isHiddenTool(tool('read', { title: 'Read', status: 'pending' }), live)).toBe(false);
  });

  it('hides the todo call only where the plan shows', () => {
    const todo = tool('other', { title: 'TodoWrite' });
    expect(isHiddenTool(todo, { ...live, hasPlan: true })).toBe(true);
    expect(isHiddenTool(todo, live)).toBe(false);
  });

  it('knows a weak title', () => {
    expect(isWeakToolTitle('Read')).toBe(true);
    expect(isWeakToolTitle(' working ')).toBe(true);
    expect(isWeakToolTitle('Read invoice.pdf')).toBe(false);
  });
});

describe('trail items', () => {
  it('keeps consecutive calls in one run of work', () => {
    const items = trailItems([read('/w/a.ts'), shell(), edit('/w/a.ts')], live);
    expect(kinds(items)).toEqual(['activity']);
    const first = items[0]!;
    expect(first.type === 'activity' && first.steps).toHaveLength(3);
  });

  it('lets the bot’s narration break runs, and keeps thinking in the run as a step', () => {
    const items = trailItems([thought(), search(), text('Found it. Now the edit.'), edit('/w/a.ts')], live);
    expect(kinds(items)).toEqual(['activity', 'note', 'activity']);
    const first = items[0]!;
    expect(first.type === 'activity' && first.steps.map((s) => s.part.type)).toEqual(['thought', 'tool_call']);
  });

  it('drops reasoning the first words superseded, and keeps it when a call came first', () => {
    expect(kinds(trailItems([thought(), text('Hi! Here you go.')], live))).toEqual(['note']);
    expect(kinds(trailItems([thought(), shell(), text('Done.')], live))).toEqual(['activity', 'note']);
  });

  it('leaves out what the chat shows as the reply: a settled answer, a message sent on purpose, a question', () => {
    const parts: Part[] = [text('Looking.'), read('/w/a.ts'), text('Sent early', true), shell(), text('All done: here it is.')];
    const items = trailItems(parts, settled);
    expect(kinds(items)).toEqual(['note', 'activity', 'activity']);
    expect(items.some((i) => i.type === 'note' && i.item.part.text.startsWith('All done'))).toBe(false);
  });

  it('has no trail for a plain reply', () => {
    expect(trailItems([text('Hi!')], settled)).toEqual([]);
  });

  it('shows a turn that is only thinking so far as thinking', () => {
    const items = trailItems([thought('Hmm.')], live);
    expect(initialThinkingIndex(items)).toBe(0);
    expect(initialThinkingIndex(trailItems([thought(), shell()], live))).toBe(-1);
  });

  it('keeps a run’s key as it grows', () => {
    const a = trailItems([thought(), shell()], live);
    const b = trailItems([thought(), shell(), shell('ls')], live);
    expect(a[0]!.key).toBe(b[0]!.key);
  });
});

describe('summary line', () => {
  it('says what the calls add up to, in the tense of the moment', () => {
    expect(workSummaryLine(steps([read('/w/a.ts'), read('/w/b.ts')]), true)).toBe('Reading 2 files');
    expect(workSummaryLine(steps([read('/w/a.ts'), read('/w/b.ts')]))).toBe('Read 2 files');
    expect(workSummaryLine(steps([read('/w/src/index.css')]))).toBe('Read index.css');
    expect(workSummaryLine(steps([read('/w/a.ts'), read('/w/a.ts')]))).toBe('Read a.ts');
    // a read whose file isn't named yet (its input still on the way) is "a file", never its call's id
    expect(workSummaryLine(steps([tool('read', { toolCallId: 'toolu_014p5WDytv5cLtWjHhkZKVpc' })]), true)).toBe('Reading a file');
    expect(workSummaryLine(steps([tool('read', { toolCallId: 'toolu_a' }), tool('read', { toolCallId: 'toolu_b' })]))).toBe('Read 2 files');
    expect(workSummaryLine(steps([search(), search('b')]))).toBe('Searched files');
    expect(workSummaryLine(steps([search(), read('/w/a.ts')]))).toBe('Explored files');
    expect(workSummaryLine(steps([edit('/w/a.ts'), edit('/w/b.ts')]))).toBe('Edited 2 files');
    expect(workSummaryLine(steps([shell('a'), shell('b')]))).toBe('Ran 2 commands');
    expect(workSummaryLine(steps([shell('a')]), true)).toBe('Running a command');
  });

  it('adds up mixed work, one clause per kind in the order it happened', () => {
    expect(workSummaryLine(steps([shell('a'), shell('b'), shell('c'), search(), edit('/w/a.ts'), edit('/w/report.md')]))).toBe('Ran 3 commands · Searched files · Edited 2 files');
    expect(workSummaryLine(steps([read('/w/a.ts'), read('/w/b.ts'), shell(), edit('/w/report.md')]))).toBe('Read 2 files · Ran a command · Edited report.md');
  });

  it('puts only the call in flight in the present tense', () => {
    expect(workSummaryLine(steps([edit('/w/a.ts'), edit('/w/b.ts'), shell('a', { status: 'in_progress' })]), true)).toBe('Edited 2 files · Running a command');
  });

  it('reads a cat as a read and a grep as a search', () => {
    expect(workSummaryLine(steps([shell('cat notes.md')]))).toBe('Read notes.md');
    expect(workSummaryLine(steps([shell('rg -n theme src')]))).toBe('Searched files');
  });

  it('names AppuBot’s own kinds of work', () => {
    const click = tool('computer', { title: 'Click', computer: { action: { type: 'click', app: 'Numbers', pid: 1 } } });
    const open = tool('computer', { title: 'Open app', computer: { action: { type: 'open_app', app: 'Numbers' } } });
    expect(workSummaryLine(steps([open, click]))).toBe('Used Numbers');
    expect(workSummaryLine(steps([open, click]), true)).toBe('Using Numbers');
    expect(workSummaryLine(steps([tool('computer', { title: 'Look at the screen', computer: { action: { type: 'screenshot' } } })]))).toBe('Used the computer');
    const gmail = tool('other', { title: 'mcp__appubot__apps_execute', rawInput: { tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS' }] } });
    expect(workSummaryLine(steps([gmail]))).toBe('Used Gmail');
    const cal = tool('other', { title: 'appubot.apps_execute', rawInput: { tools: [{ tool_slug: 'GOOGLECALENDAR_CREATE_EVENT' }] } });
    expect(workSummaryLine(steps([gmail, cal]))).toBe('Used Gmail and Google Calendar');
    expect(workSummaryLine(steps([tool('fetch', { title: 'Fetch', rawInput: { url: 'https://example.com' } })]))).toBe('Fetched a page');
    expect(workSummaryLine(steps([tool('fetch', { title: 'Search', rawInput: { query: 'gst rate' } })]))).toBe('Searched the web');
    expect(workSummaryLine(steps([tool('other', { title: 'Ask you' })]))).toBe('Asked you a question');
    expect(workSummaryLine(steps([tool('other', { title: 'Send file to you', rawInput: { path: '/w/a.pdf' } })]))).toBe('Sent you a file');
    expect(workSummaryLine(steps([tool('other', { title: 'mcp__appubot__send_message' })]))).toBe('Sent you a message');
    expect(workSummaryLine(steps([tool('other', { title: 'Remember' })]))).toBe('Saved to memory');
    expect(workSummaryLine(steps([tool('other', { title: 'Read memory' })]))).toBe('Used its memory');
    expect(workSummaryLine(steps([tool('think', { title: 'Explore the auth module', rawInput: { description: 'Explore', prompt: 'Look', subagent_type: 'Explore' } })]))).toBe('Ran a subagent');
    expect(workSummaryLine(steps([tool('other', { title: 'Look up the weather' }), tool('other', { title: 'Convert units' })]))).toBe('Used 2 tools');
  });

  it('calls a run of thoughts alone thinking', () => {
    expect(workSummaryLine(steps([thought()]), true)).toBe('Thinking');
    expect(workSummaryLine(steps([thought()]))).toBe('Thought');
  });

  it('counts what didn’t work, and picks the icon by what the run did most', () => {
    const s = steps([read('/w/a.ts'), shell('a', { status: 'failed' }), shell('b'), shell('c')]);
    expect(failedCount(s, settled)).toBe(1);
    expect(workKind(s)).toBe('run');
    expect(workKind(steps([read('/w/a.ts'), edit('/w/a.ts')]))).toBe('edit');
    expect(workKind(steps([thought()]))).toBe('think');
  });
});

describe('fold', () => {
  it('folds the work the bot has already written past', () => {
    const items = trailItems([shell('a'), text('Checking the other half now.'), shell('b'), text('All set.')], live);
    expect(foldableWork(items, live)).toEqual({ start: 0, end: 2 });
  });

  it('leaves work it hasn’t written past alone, and keeps the live run open', () => {
    expect(foldableWork(trailItems([shell('a')], live), live)).toBeUndefined();
    expect(foldableWork(trailItems([text('On it.'), shell('a')], live), live)).toBeUndefined();
    const items = trailItems([shell('a'), text('That worked. Running the tests.'), shell('b', { status: 'in_progress' })], live);
    expect(foldableWork(items, live)).toEqual({ start: 0, end: 0 });
  });

  it('never folds a run waiting on your approval, or a plan while live', () => {
    const waiting = shell('rm', { status: 'pending' });
    expect(foldableWork(trailItems([waiting, text('I need permission for that.')], live), { ...live, awaiting: new Set([waiting.toolCallId]) })).toBeUndefined();
    const plan: Part = { type: 'plan', entries: [{ content: 'Do it', priority: 'high', status: 'pending' }] };
    const items = trailItems([shell('a'), plan, shell('b'), text('Built it.'), shell('c')], live);
    expect(foldableWork(items, live)).toEqual({ start: 2, end: 2 });
  });

  it('folds a settled trail whole', () => {
    const plan: Part = { type: 'plan', entries: [{ content: 'Do it', priority: 'high', status: 'completed' }] };
    const items = trailItems([shell('a'), plan, text('Now the report.'), edit('/w/r.md'), text('Done.')], settled);
    expect(foldableWork(items, settled)).toEqual({ start: 0, end: items.length - 1 });
    expect(trailSteps(items)).toHaveLength(2);
    expect(foldableWork([], settled)).toBeUndefined();
  });
});

describe('words', () => {
  it('reduces a paragraph to one plain line', () => {
    expect(proseSummary('**Found it**: the tokens live in `globals.css`.\n\nMore here.')).toBe('Found it: the tokens live in globals.css.');
    expect(proseSummary('```ts\ncode\n```\n\n- the list item')).toBe('the list item');
  });

  it('names AppuBot’s own tools in words', () => {
    expect(bridgeTool('mcp__appubot__apps_execute')).toBe('apps_execute');
    expect(bridgeTool('Read a.ts')).toBeUndefined();
    const gmail = tool('other', { title: 'mcp__appubot__apps_execute', rawInput: { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL' }] } });
    expect(trailSentence(gmail, false).verb).toBe('Used Gmail');
    expect(trailSentence(gmail, true).verb).toBe('Using Gmail');
    expect(trailSentence(tool('other', { title: 'mcp__appubot__vault_list' }), false).verb).toBe('Looked in your Vault');
    expect(trailSentence(tool('other', { title: 'mcp__appubot__something_new' }), false).verb).toBe('Used something new');
    expect(trailSentence(shell('npm test'), false)).toMatchObject({ verb: 'Ran', object: 'npm test' });
    expect(workCategory(tool('other', { title: 'mcp__appubot__mac_files_find' }))).toBe('research');
  });
});
