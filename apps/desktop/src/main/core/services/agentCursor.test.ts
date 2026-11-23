import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComputerAction, EventPayload } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { EventBus } from '../events';
import { AgentCursorController, glideMs, THINK_MS, type AgentCursorHost } from './agentCursor';

function setup(o: { enabled?: boolean } = {}) {
  const calls: string[] = [];
  const host: AgentCursorHost = {
    show: ({ figure, color, seed }) => { calls.push(`show ${typeof figure === 'object' ? 'character' : figure} ${color}`); expect(seed).toBeGreaterThanOrEqual(0); },
    moveTo: async (x, y, ms) => { calls.push(`move ${Math.round(x)},${Math.round(y)} ${ms}ms`); },
    react: (k) => { calls.push(`react ${k}`); },
    activity: (k) => { calls.push(`activity ${k}`); },
    mood: (m) => { calls.push(`mood ${m}`); },
    hide: () => { calls.push('hide'); },
    dispose: () => undefined,
  };
  const bots: Record<string, { id: string; name: string; shape: string; color: string }> = {
    b1: { id: 'b1', name: 'Appu', shape: 'circle', color: '#FF7A1F' },
    b2: { id: 'b2', name: 'Tiny', shape: 'hex', color: '#3B82F6' },
  };
  const bus = new EventBus();
  const ctx = {
    deps: { agentCursor: host },
    bus,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    s: {
      settings: { get: () => ({ computer: { agentCursor: o.enabled ?? true } }) },
      threads: { get: (id: string) => ({ t1: { id: 't1', botId: 'b1' }, t2: { id: 't2', botId: 'b2' } } as Record<string, unknown>)[id] },
      bots: { get: (id: string) => bots[id] },
    },
  } as unknown as CoreCtx;
  const c = new AgentCursorController(ctx);
  const ask = (id: string, threadId: string) => bus.emit('permission.requested', { id, threadId } as EventPayload<'permission.requested'>);
  const answer = (id: string) => bus.emit('permission.resolved', { id, optionId: 'allow' });
  return { c, calls, ask, answer };
}
const click = (x: number, y: number): ComputerAction => ({ type: 'click', x, y });
const at = { x: 735, y: 478 };

describe('agent cursor', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('glides longer for longer moves, within bounds', () => {
    expect(glideMs(0, 0)).toBe(140);
    expect(glideMs(300, 400)).toBeGreaterThan(glideMs(30, 40));
    expect(glideMs(5000, 5000)).toBe(380);
  });

  it("shows the bot's avatar (its shape and colour, no label), glides to the target before the click, then reacts", async () => {
    const { c, calls } = setup();
    await c.before(click(640, 416), 't1', at);
    c.after(click(640, 416), 't1');
    expect(calls).toEqual(['show circle #FF7A1F', 'move 735,478 240ms', 'react click']);
    // the same bot is not redrawn on its next action
    await c.before(click(10, 10), 't1', { x: 735, y: 478 });
    expect(calls.filter((x) => x.startsWith('show'))).toHaveLength(1);
  });

  it('reacts to each kind of action', async () => {
    const { c, calls } = setup();
    const run = async (a: ComputerAction) => { await c.before(a, 't1', at); c.after(a, 't1'); };
    await run({ type: 'double_click', x: 1, y: 1 });
    await run({ type: 'right_click', x: 1, y: 1 });
    await run({ type: 'scroll', x: 1, y: 1, detail: JSON.stringify({ direction: 'up', amount: 3 }) });
    await run({ type: 'scroll', x: 1, y: 1 });
    await run({ type: 'key', key: 'Return' });
    await run({ type: 'hotkey', key: 'cmd+s' });
    await run({ type: 'move', x: 1, y: 1 });
    expect(calls.filter((x) => x.startsWith('react'))).toEqual(['react double', 'react right', 'react scroll-up', 'react scroll-down', 'react key', 'react key']);
  });

  it('grabs for a drag, follows it, and lets go after', async () => {
    const { c, calls } = setup();
    const drag: ComputerAction = { type: 'drag', x: 1, y: 1, toX: 9, toY: 9 };
    await c.before(drag, 't1', at);
    c.follow({ x: 800, y: 500 }, 500);
    c.after(drag, 't1');
    expect(calls.slice(1)).toEqual(['move 735,478 240ms', 'react grab', 'move 800,500 500ms', 'react release']);
  });

  it('types in a loop that stops when typing is done, and also when it failed', async () => {
    const { c, calls } = setup();
    const type: ComputerAction = { type: 'type', text: 'hello' };
    await c.before(type, 't1', null);
    expect(calls).toEqual(['show circle #FF7A1F', 'activity typing']);
    c.after(type, 't1');
    expect(calls.at(-1)).toBe('activity null');
    await c.before(type, 't1', null);
    c.after(type, 't1', false);
    expect(calls.slice(-2)).toEqual(['activity typing', 'activity null']);
    // a failed click gets no click feedback
    await c.before(click(1, 1), 't1', at);
    c.after(click(1, 1), 't1', false);
    expect(calls.at(-1)).toBe('move 735,478 240ms');
  });

  it('looks (snapshots, screenshots, opening apps) only on a cursor already out for that thread', async () => {
    const { c, calls } = setup();
    c.look({ type: 'window', pid: 1, windowId: 2 }, 't1');
    await c.before({ type: 'open_app', app: 'Notes' }, 't1', null);
    expect(calls).toEqual([]);
    await c.before(click(1, 1), 't1', at);
    c.look({ type: 'screenshot' }, 't1');
    c.look({ type: 'window', pid: 1, windowId: 2 }, 't2');
    await c.before({ type: 'focus_window', pid: 1, windowId: 2 }, 't1', null);
    expect(calls.filter((x) => x.startsWith('react'))).toEqual(['react look', 'react look']);
  });

  it('thinks after a while without actions, and an action brings it back', async () => {
    const { c, calls } = setup();
    await c.before(click(1, 1), 't1', at);
    c.after(click(1, 1), 't1');
    vi.advanceTimersByTime(THINK_MS - 1);
    expect(calls).not.toContain('mood working');
    vi.advanceTimersByTime(1);
    expect(calls.at(-1)).toBe('mood working');
    await c.before({ type: 'key', key: 'Tab' }, 't1', null);
    expect(calls.at(-1)).toBe('mood rest');
    // typing is an action for as long as it lasts
    await c.before({ type: 'type', text: 'a long text' }, 't1', null);
    vi.advanceTimersByTime(THINK_MS * 3);
    expect(calls.at(-1)).toBe('activity typing');
  });

  it("asks for you while its own thread waits for a permission, then thinks again", async () => {
    const { c, calls, ask, answer } = setup();
    await c.before(click(1, 1), 't1', at);
    c.after(click(1, 1), 't1');
    ask('p2', 't2');
    expect(calls).not.toContain('mood needs-you');
    ask('p1', 't1');
    expect(calls.at(-1)).toBe('mood needs-you');
    vi.advanceTimersByTime(THINK_MS * 2); // the thinking timer doesn't override the question
    expect(calls.at(-1)).toBe('mood needs-you');
    answer('p2');
    expect(calls.at(-1)).toBe('mood needs-you');
    answer('p1');
    expect(calls.at(-1)).toBe('mood working');
  });

  it('ignores actions without a bot turn (take-over from a phone) and respects the setting', async () => {
    const a = setup();
    await a.c.before(click(10, 10), undefined, { x: 10, y: 10 });
    a.c.after(click(10, 10), undefined);
    expect(a.calls).toEqual([]);
    // the user's own click doesn't make a bot's cursor react
    await a.c.before(click(10, 10), 't1', at);
    a.c.after(click(10, 10), undefined);
    expect(a.calls.filter((x) => x.startsWith('react'))).toEqual([]);
    const b = setup({ enabled: false });
    await b.c.before(click(10, 10), 't1', { x: 10, y: 10 });
    expect(b.calls).toEqual([]);
  });

  it("hides when that bot's turn ends, not when another one does, and drops its timers and listener", async () => {
    const { c, calls, ask } = setup();
    await c.before({ type: 'key', key: 'a' }, 't1', null);
    c.after({ type: 'key', key: 'a' }, 't1');
    c.turnEnded('other');
    expect(calls).toEqual(['show circle #FF7A1F', 'react key']);
    c.turnEnded('t1');
    expect(calls.at(-1)).toBe('hide');
    vi.advanceTimersByTime(THINK_MS * 3);
    ask('p1', 't1');
    expect(calls.at(-1)).toBe('hide');
    // the next turn pops it in again
    await c.before(click(1, 1), 't1', at);
    expect(calls.slice(-2)).toEqual(['show circle #FF7A1F', 'move 735,478 240ms']);
  });

  it("switches to another bot's look when another thread acts", async () => {
    const { c, calls } = setup();
    await c.before(click(1, 1), 't1', at);
    await c.before(click(1, 1), 't2', at);
    expect(calls.filter((x) => x.startsWith('show'))).toEqual(['show circle #FF7A1F', 'show hex #3B82F6']);
    c.turnEnded('t1');
    expect(calls.at(-1)).not.toBe('hide');
  });

  it('steps away while its bot works behind the user\'s windows (background mode), and comes back where they can see', async () => {
    const { c, calls } = setup();
    await c.before(click(1, 1), 't1', at);
    c.away('t2'); // another bot's window: this cursor stays
    expect(calls.at(-1)).not.toBe('hide');
    c.away('t1');
    expect(calls.at(-1)).toBe('hide');
    c.after(click(1, 1), 't1'); // nothing to react with while it is away
    expect(calls.at(-1)).toBe('hide');
    await c.before(click(1, 1), 't1', at);
    expect(calls.slice(-2)).toEqual(['show circle #FF7A1F', 'move 735,478 240ms']);
  });
});
