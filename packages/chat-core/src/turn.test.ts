import { describe, expect, it } from 'vitest';
import type { Message, Part } from '@appubot/protocol';
import { capOpenTools, chunkWork, formatTurnHeaderLabel, answerOnly, layoutTurn, liveAnswerParts, segmentFlow, turnHeader, type Chunk } from './turn';
import { deriveLiteralCommand, thoughtLine, toolMeta, toolSentence, type ToolCallPart } from './toolText';

const tool = (id: string, extra: Partial<ToolCallPart> = {}): ToolCallPart => ({
  type: 'tool_call', toolCallId: id, title: 'Run', kind: 'execute', status: 'completed', content: [], locations: [], rawInput: { command: 'ls' }, ...extra,
});
const text = (t: string): Part => ({ type: 'text', text: t });
const thought = (t: string): Part => ({ type: 'thought', text: t });
const indexed = (parts: Part[]) => parts.map((part, index) => ({ part, index }));
const msg = (status: Message['status'], ms: number, error?: string) => ({ status, error, createdAt: 1_000, updatedAt: 1_000 + ms });

describe('turn header', () => {
  it('labels each outcome like Synara', () => {
    expect(formatTurnHeaderLabel(turnHeader(msg('complete', 20_000)))).toBe('Worked for 20s');
    expect(formatTurnHeaderLabel(turnHeader(msg('complete', 4_240)))).toBe('Worked for 4.2s');
    expect(formatTurnHeaderLabel(turnHeader(msg('cancelled', 16_000)))).toBe('Stopped after 16s');
    expect(formatTurnHeaderLabel(turnHeader(msg('error', 12_000, ' usage limit reached ')))).toBe('Interrupted after 12s · usage limit reached');
    expect(formatTurnHeaderLabel(turnHeader(msg('error', 9_000)))).toBe('Interrupted after 9.0s');
  });

  it('measures to the frozen end, and says "Details" without one', () => {
    expect(formatTurnHeaderLabel(turnHeader(msg('complete', 90_000), 1_000 + 64_000))).toBe('Worked for 1m 4s');
    expect(formatTurnHeaderLabel(turnHeader(msg('complete', 0), 0))).toBe('Details');
    expect(formatTurnHeaderLabel(turnHeader(msg('cancelled', 0), 0))).toBe('Stopped');
  });
});

describe('layoutTurn', () => {
  it('folds thoughts as work even without tool calls', () => {
    const L = layoutTurn([thought('**Planning**'), text('Done.')]);
    expect(L.hasWork).toBe(true);
    expect(L.work.map((w) => w.part.type)).toEqual(['thought']);
    expect(L.answer.map((a) => a.part.type)).toEqual(['text']);
  });

  it('settles a plain reply without a fold', () => {
    expect(layoutTurn([text('Hi')]).hasWork).toBe(false);
    expect(layoutTurn([thought('  '), text('Hi')]).hasWork).toBe(false);
  });
});

describe('capOpenTools', () => {
  // single tool rows separated by thoughts, so none of them group
  const parts: Part[] = [];
  for (let i = 0; i < 7; i++) parts.push(tool(`t${i}`), thought(`step ${i}`));
  const list = chunkWork(indexed(parts));
  const toolIds = (l: Chunk[]) => l.flatMap((c) => (c.kind === 'item' && c.item.part.type === 'tool_call' ? [c.item.part.toolCallId] : []));

  it('keeps the newest four while live and the first four when settled', () => {
    const live = capOpenTools(list, { expanded: false, keep: 'last' });
    expect(live.hidden).toBe(3);
    expect(toolIds(live.chunks)).toEqual(['t3', 't4', 't5', 't6']);
    expect(toolIds(capOpenTools(list, { expanded: false, keep: 'first' }).chunks)).toEqual(['t0', 't1', 't2', 't3']);
  });

  it('only collapses when it hides at least three rows', () => {
    const six = chunkWork(indexed(parts.slice(0, 12)));
    expect(capOpenTools(six, { expanded: false, keep: 'last' })).toEqual({ chunks: six, hidden: 0 });
  });

  it('shows everything when expanded but still reports the overflow', () => {
    const open = capOpenTools(list, { expanded: true, keep: 'last' });
    expect(open.hidden).toBe(3);
    expect(toolIds(open.chunks)).toHaveLength(7);
  });
});

describe('segmentFlow', () => {
  it('splits a turn into Synara rows: work leads the text after it, trailing work stays inline', () => {
    const list = chunkWork(indexed([tool('a'), tool('b'), text('Looking'), tool('c'), text('Found it'), thought('x')]));
    const segs = segmentFlow(list);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.lead.map((c) => c.kind)).toEqual(['group']);
    expect(segs[0]!.content.map((c) => c.index)).toEqual([2]);
    expect(segs[0]!.inline).toHaveLength(0);
    expect(segs[1]!.lead).toHaveLength(1);
    expect(segs[1]!.content.map((c) => c.index)).toEqual([4]);
    expect(segs[1]!.inline).toHaveLength(1);
  });

  it('keeps consecutive content in one row and work-only turns as one lead', () => {
    expect(segmentFlow(chunkWork(indexed([text('a'), text('b')])))).toHaveLength(1);
    const work = segmentFlow(chunkWork(indexed([tool('a')])));
    expect(work).toHaveLength(1);
    expect(work[0]!.lead).toHaveLength(1);
  });
});

describe('tool row text', () => {
  it('ticks while running, then says nothing once it simply finished', () => {
    expect(toolMeta(tool('a', { status: 'in_progress', startedAt: 5 }), { settled: false })).toEqual({ tone: 'running', since: 5 });
    expect(toolMeta(tool('a'), { settled: true })).toBeNull();
  });

  it('marks failures with the exit code', () => {
    const failed = tool('a', { status: 'failed', content: [{ type: 'text', text: 'npm ERR! missing script\nExit code 1' }] });
    expect(toolMeta(failed, { settled: true })).toEqual({ tone: 'failed', text: 'Failed · exit 1' });
    expect(toolMeta(tool('b', { status: 'failed', rawOutput: 'boom' }), { settled: true })).toEqual({ tone: 'failed', text: 'Failed' });
  });

  it('calls a run still open when the turn stopped cancelled, with how long it ran', () => {
    const open = tool('a', { status: 'in_progress', startedAt: 1_000 });
    expect(toolMeta(open, { settled: true, interrupted: true, endedAt: 5_500 })).toEqual({ tone: 'cancelled', text: 'Cancelled · 4s elapsed' });
    expect(toolMeta(tool('b', { status: 'pending' }), { settled: true, interrupted: true, endedAt: 5_500 })).toEqual({ tone: 'cancelled', text: 'Cancelled' });
  });

  it('always says "Edited" for edits', () => {
    const edit = tool('e', { kind: 'edit', title: 'Edit', rawInput: { file_path: '/repo/src/a.ts' } });
    expect(toolSentence(edit, true).verb).toBe('Edited');
    expect(toolSentence(edit, false)).toEqual({ verb: 'Edited', object: 'a.ts' });
  });

  it('shows the literal command without its shell wrapper or cd preamble', () => {
    expect(deriveLiteralCommand(`/bin/zsh -lc 'cd /repo && rg -n "a b" src | head -5'`)).toBe('rg -n "a b" src | head -5');
    expect(deriveLiteralCommand('find . -name "*.md" -not -path "./.git/*"')).toBe('find . -name "*.md" -not -path "./.git/*"');
    expect(deriveLiteralCommand('export A=1 && npm   test\n  -- --watch')).toBe('npm test -- --watch');
    expect(toolSentence(tool('r', { rawInput: { command: 'bash -c "cd x; pnpm test"' } }), false)).toEqual({ verb: 'Ran', object: 'pnpm test', chip: true });
  });

  it('reads a thought as its last readable line', () => {
    expect(thoughtLine('**Planning the implementation**\n\n<!-- -->')).toBe('Planning the implementation');
    expect(thoughtLine('First I will look.\n\n## Checking the tests')).toBe('Checking the tests');
    expect(thoughtLine('Reasoning: compare `a` and b')).toBe('compare `a` and b');
    expect(thoughtLine('  \n<!-- x -->')).toBeNull();
  });
});

describe('answers-only live turn', () => {
  it('keeps what the bot asks or sends, drops narration, thoughts and tool calls', () => {
    const plan: Part = { type: 'plan', entries: [{ content: 'Do it', status: 'pending', priority: 'medium' }] };
    const q: Part = { type: 'question', questionId: 'q1', question: 'Which one?', options: [] };
    const parts = [thought('Let me look'), text('Checking files'), tool('t1'), plan, q, text('Done')];
    expect(liveAnswerParts(parts)).toEqual([{ part: q, index: 4 }]);
    // settled: the question stays, the plan and the work go, the reply reads
    expect(answerOnly(layoutTurn(parts)).map((x) => x.index)).toEqual([4, 5]);
  });
});

describe('messages the bot sent on its own (send_message)', () => {
  const parts: Part[] = [
    { type: 'text', text: 'Let me check.' },
    { type: 'text', text: 'hi', said: true },
    tool('t1'),
    { type: 'text', text: 'hello' },
  ];
  it('show in the answers view as messages of their own, while the narration stays folded', () => {
    const L = layoutTurn(parts);
    expect(answerOnly(L).map((x) => x.part.type === 'text' && x.part.text)).toEqual(['hi', 'hello']);
    // while it works, a message it sent shows at once (its reply comes when the turn settles)
    expect(liveAnswerParts(parts).map((x) => x.part.type === 'text' && x.part.text)).toEqual(['hi']);
  });
});

describe('voice parts', () => {
  const voice: Part = { type: 'voice', kind: 'reply', durationMs: 1200, file: { id: 'f1', name: 'reply.ogg', mimeType: 'audio/ogg', size: 10, url: '/files/f1' } };
  it('is never work: it stays in the answer views and out of the fold', () => {
    const parts: Part[] = [thought('hm'), tool('a'), voice, text('done'), voice];
    expect(liveAnswerParts(parts).map((x) => x.part.type)).toEqual(['voice', 'voice']);
    const L = layoutTurn(parts);
    expect(L.work.some((w) => w.part.type === ('voice' as string))).toBe(false);
    expect(answerOnly(L).filter((x) => x.part.type === 'voice')).toHaveLength(2);
    expect(answerOnly(layoutTurn([voice])).map((x) => x.part.type)).toEqual(['voice']);
  });
});
