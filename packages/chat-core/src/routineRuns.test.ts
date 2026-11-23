import { describe, expect, it } from 'vitest';
import type { Message, Part } from '@appubot/protocol';
import { endsNothingNewRun, foldRoutineRuns, isNothingNewReply, isNothingNewRun, isNothingNewText, routineFoldText, routineOf, routinePromptText, type RoutineFold } from './routineRuns';

const PROMPT = 'Check my Asana notifications. If nothing is new, answer only ✓.';
let seq = 0;
const at = (min: number) => Date.UTC(2026, 10, 15, 9, min);
const prompt = (min: number, over: Partial<Message> = {}): Message => ({
  id: `p${++seq}`, threadId: 't', role: 'user', parts: [{ type: 'text', text: PROMPT }], status: 'complete', via: 'routine',
  routine: { id: 'r1', name: 'Asana check' }, createdAt: at(min), updatedAt: at(min), ...over,
});
const reply = (min: number, text: string | Part[], over: Partial<Message> = {}): Message => ({
  id: `a${++seq}`, threadId: 't', role: 'agent', parts: typeof text === 'string' ? [{ type: 'text', text }] : text, status: 'complete', via: 'routine',
  createdAt: at(min) + 1, updatedAt: at(min) + 30_000, ...over,
});
const mine = (min: number, text = 'thanks'): Message => ({ id: `u${++seq}`, threadId: 't', role: 'user', parts: [{ type: 'text', text }], status: 'complete', via: 'desktop', createdAt: at(min), updatedAt: at(min) });
const tool = (over: Record<string, unknown> = {}): Part => ({ type: 'tool_call', toolCallId: `c${++seq}`, title: 'get_notifications', kind: 'fetch', status: 'completed', content: [], locations: [], ...over }) as Part;
const run = (min: number, text: string | Part[], over: Partial<Message> = {}) => [prompt(min), reply(min, text, over)];
const kinds = (items: ReturnType<typeof foldRoutineRuns>) => items.map((x) => (x.kind === 'message' ? x.id[0] : `fold${(x as RoutineFold).runs.length}`)).join(' ');

describe('isNothingNewText', () => {
  it('takes nothing, marks and a short "nothing new"', () => {
    for (const t of ['', '✓', '✅', ' 👍 ', '—', '...', '✓.', '**✓**', 'OK', 'Okay.', 'Done', 'Nothing new.', 'No new items', 'No new Asana notifications.', 'All clear 👍', 'NO_REPLY', 'Nincs újdonság.', 'Nichts Neues', 'Rien de nouveau', 'Nada de novo']) {
      expect(isNothingNewText(t), t).toBe(true);
    }
  });
  it('keeps anything that may be news', () => {
    for (const t of [
      '3 new tasks assigned to you', 'No new tasks, but Anna asked about the logo', 'Nothing new except a comment from Bo',
      'Meeting moved to Friday', 'Yes', 'See https://app.asana.com/0/1', 'No new items\nBut one overdue', 'Anna mentioned you',
      'No new tasks in any of the projects you follow this week at all', '@anna replied',
    ]) {
      expect(isNothingNewText(t), t).toBe(false);
    }
  });
});

describe('isNothingNewReply', () => {
  it('reads what the answers view shows: narration before tool calls doesn’t count', () => {
    expect(isNothingNewReply(reply(0, [{ type: 'text', text: 'Let me check your notifications.' }, tool(), { type: 'thought', text: 'nothing' }, { type: 'text', text: '✓' }]))).toBe(true);
  });
  it('is never one that failed, is still going, was stopped or reacted to', () => {
    expect(isNothingNewReply(reply(0, '✓', { status: 'streaming' }))).toBe(false);
    expect(isNothingNewReply(reply(0, '✓', { status: 'cancelled' }))).toBe(false);
    expect(isNothingNewReply(reply(0, '✓', { status: 'error', error: 'boom' }))).toBe(false);
    expect(isNothingNewReply(reply(0, '✓', { error: 'boom' }))).toBe(false);
    expect(isNothingNewReply(reply(0, '✓', { reactions: [{ emoji: '👍', by: 'user', at: 1 }] }))).toBe(false);
  });
  it('is never one that asks, sends, shows or changes something', () => {
    const file = { id: 'f', name: 'a.txt', mimeType: 'text/plain', size: 1 } as never;
    for (const extra of [
      { type: 'question', questionId: 'q', question: 'Which?', options: [] },
      { type: 'file', file },
      { type: 'image', mimeType: 'image/png', data: '' },
      { type: 'page', title: 'Chart', file },
      { type: 'plan', entries: [] },
      { type: 'system', text: 'Stopped', level: 'warning' },
      tool({ content: [{ type: 'diff', path: '/a/seen.json', oldText: null, newText: '[]' }] }),
    ] as Part[]) {
      expect(isNothingNewReply(reply(0, [extra, { type: 'text', text: '✓' }])), extra.type).toBe(false);
    }
  });
  it('is never two bubbles, or a run with two replies', () => {
    expect(isNothingNewReply(reply(0, [{ type: 'text', text: '✓', said: true }, tool(), { type: 'text', text: '✓' }]))).toBe(false);
    expect(isNothingNewRun(prompt(0), [reply(0, '✓'), reply(0, '✓')])).toBe(false);
    expect(isNothingNewRun(prompt(0), [])).toBe(false);
  });
  it('is only a routine’s run', () => {
    expect(isNothingNewRun(mine(0), [reply(0, '✓')])).toBe(false);
    expect(isNothingNewRun(prompt(0), [reply(0, '✓')])).toBe(true);
  });
});

describe('foldRoutineRuns', () => {
  it('folds runs in a row with nothing to say into one line', () => {
    const list = [mine(0, 'hello'), reply(0, 'Hi!'), ...run(10, '✓'), ...run(20, '✓'), ...run(30, '✓')];
    const items = foldRoutineRuns(list);
    expect(kinds(items)).toBe('u a fold3');
    const fold = items[2] as RoutineFold;
    expect(fold.ids).toEqual(list.slice(2).map((m) => m.id));
    expect(fold.index).toBe(2);
    expect(fold.runs.map((r) => r.reply)).toEqual(['✓', '✓', '✓']);
    expect(routineFoldText(fold).label).toMatch(/^Asana check ran 3 times · last /);
    expect(routineFoldText(fold).reply).toBe('✓');
  });

  it('shows a run with news, a failure or one still going as it is, and it breaks the fold', () => {
    const list = [...run(0, '✓'), ...run(10, '✓'), ...run(20, '2 new tasks: Logo review, Budget'), ...run(30, '✓'), ...run(40, '✓', { status: 'error', error: 'Asana is down' }), ...run(50, '✓'), ...run(60, '', { status: 'streaming' })];
    expect(kinds(foldRoutineRuns(list))).toBe('fold2 p a fold1 p a fold1 p a');
  });

  it('a run waiting on its reply (queued) shows as it is', () => {
    const list = [...run(0, '✓'), prompt(10)];
    expect(kinds(foldRoutineRuns(list))).toBe('fold1 p');
  });

  it('a live run that turns out to have nothing to say joins the fold, whose key stays the same', () => {
    const before = [...run(0, '✓'), ...run(10, '✓'), prompt(20), reply(20, [tool({ status: 'in_progress' })], { status: 'streaming' })];
    const live = foldRoutineRuns(before);
    expect(kinds(live)).toBe('fold2 p a');
    const done = before.map((m, i) => (i === 5 ? { ...m, status: 'complete' as const, parts: [...m.parts, { type: 'text' as const, text: '✓' }] } : m));
    const after = foldRoutineRuns(done);
    expect(kinds(after)).toBe('fold3');
    expect(after[0]!.key).toBe(live[0]!.key);
    expect(after[0]!.key).toBe(`routine-fold:${before[0]!.id}`);
  });

  it('your message, another routine or another turn between runs breaks the fold', () => {
    const other = (min: number) => [prompt(min, { routine: { id: 'r2', name: 'Inbox' } }), reply(min, '✓')];
    expect(kinds(foldRoutineRuns([...run(0, '✓'), mine(5), ...run(10, '✓')]))).toBe('fold1 u fold1');
    expect(kinds(foldRoutineRuns([...run(0, '✓'), ...other(5), ...run(10, '✓')]))).toBe('fold1 fold1 fold1');
    // a turn of AppuBot's own after a run (a goal, a reaction's answer) is a second reply: that run shows as it is
    expect(kinds(foldRoutineRuns([...run(0, '✓'), reply(1, 'Thanks for the 👍'), ...run(10, '✓')]))).toBe('p a a fold1');
  });

  it('a separator (a new day, a sitting) starts a new fold, and one inside a run keeps it out', () => {
    const list = [...run(0, '✓'), ...run(10, '✓'), ...run(20, '✓')];
    expect(kinds(foldRoutineRuns(list, { separators: [null, null, 'Today', null, null, null] }))).toBe('fold1 fold2');
    expect(kinds(foldRoutineRuns(list, { separators: [null, null, null, 'Today', null, null] }))).toBe('fold1 p a fold1');
  });

  it('prompts from before routines were named on them fold by their words and read "Routine"', () => {
    const old = (min: number, text = PROMPT) => [prompt(min, { routine: undefined, parts: [{ type: 'text', text }] }), reply(min, '✓')];
    const items = foldRoutineRuns([...old(0), ...old(10), ...old(20, 'Another prompt'), ...old(30, 'Another prompt')]);
    expect(kinds(items)).toBe('fold2 fold2');
    expect((items[0] as RoutineFold).routine).toEqual({ key: `prompt:${PROMPT}`, name: 'Routine' });
    expect(routineFoldText(items[0] as RoutineFold).label).toMatch(/^Routine ran 2 times/);
  });

  it('uses the apps’ row keys', () => {
    const list = [mine(0), ...run(10, '✓')];
    const items = foldRoutineRuns(list, { keyOf: (id) => `row:${id}` });
    expect(items.map((x) => x.key)).toEqual([`row:${list[0]!.id}`, `routine-fold:row:${list[1]!.id}`]);
  });
});

describe('endsNothingNewRun', () => {
  it('finds the run a finished reply ends', () => {
    const list = [mine(0), reply(0, 'Hi'), ...run(10, '✓'), ...run(20, 'Anna asked about the logo')];
    expect(endsNothingNewRun(list, list[3]!.id)).toBe(true);
    expect(endsNothingNewRun(list, list[5]!.id)).toBe(false);
    expect(endsNothingNewRun(list, list[1]!.id)).toBe(false);
    expect(endsNothingNewRun(list, 'missing')).toBe(false);
  });
});

describe('routine lines', () => {
  it('names the routine, or "Routine" for one from before', () => {
    expect(routineOf(prompt(0))).toEqual({ key: 'id:r1', name: 'Asana check', id: 'r1' });
    expect(routineOf(mine(0))).toBeNull();
    expect(routinePromptText(prompt(0, { routine: undefined }))).toMatchObject({ name: 'Routine', prompt: PROMPT });
    expect(routineFoldText({ routine: { key: 'k', name: 'Asana check' }, runs: [{ promptId: 'p', replyId: 'a', at: 0, reply: '' }], lastAt: 0 }).label).toMatch(/^Asana check ran at /);
  });
});
