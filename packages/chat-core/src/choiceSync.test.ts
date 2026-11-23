import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChoiceQueue, ChoiceSync, CHOICE_HOLD_MS, choiceLane } from './choiceSync';

/** A request the test answers by hand, in whatever order it likes. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((r) => setImmediate(r));

interface Thread { id: string; effortId: string; modelId: string; title: string }

/** A computer that answers when told, keeping what it last set (like ChatService), and the store the events land in. */
function world() {
  const server: Thread = { id: 't1', effortId: 'high', modelId: 'opus', title: 'Chat' };
  let store: Thread = { ...server };
  const sent: { field: 'effortId' | 'modelId'; value: string; answer: ReturnType<typeof deferred<Thread>> }[] = [];
  const sync = new ChoiceSync();
  const set = (field: 'effortId' | 'modelId', value: string) =>
    sync.change<Thread>({
      lane: 'thread:t1',
      slot: field,
      show: { 'thread:t1': { [field]: value } },
      send: () => {
        const answer = deferred<Thread>();
        sent.push({ field, value, answer });
        return answer.promise;
      },
      answered: (t) => ({ 'thread:t1': t }),
    });
  /** the computer applies request `i` and answers (the event lands in the store first, as on the wire) */
  const answer = (i: number, adjust?: string) => {
    const r = sent[i]!;
    server[r.field] = adjust ?? r.value;
    store = { ...server };
    r.answer.resolve({ ...server });
  };
  const event = (t: Partial<Thread>) => { store = { ...store, ...t }; };
  const shown = () => sync.view('thread:t1', store);
  return { sync, set, sent, answer, event, shown, server, get store() { return store; } };
}

describe('ChoiceSync', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('a pick shows at once and stays through the round trip', async () => {
    const w = world();
    const done = w.set('effortId', 'low');
    expect(w.shown().effortId).toBe('low');
    // an event from before the computer got the change
    w.event({ effortId: 'high', title: 'Renamed' });
    expect(w.shown().effortId).toBe('low');
    expect(w.shown().title).toBe('Renamed');
    await flush();
    w.answer(0);
    expect(await done).toEqual({ ok: true, result: expect.objectContaining({ effortId: 'low' }) });
    expect(w.shown().effortId).toBe('low');
  });

  it('High → Low → Medium quickly: shows each at once, sends only Low then Medium, never flips back', async () => {
    const w = world();
    const seen: string[] = [];
    w.sync.subscribe(() => seen.push(w.shown().effortId));
    const low = w.set('effortId', 'low');
    const mid1 = w.set('effortId', 'max');
    const mid = w.set('effortId', 'medium');
    expect(w.shown().effortId).toBe('medium');
    await flush();
    // one in flight; max was replaced by medium while waiting its turn
    expect(w.sent.map((s) => s.value)).toEqual(['low']);
    expect(await mid1).toEqual({ ok: true, superseded: true });
    // low's answer (and its event) arrives: medium still shows
    w.answer(0);
    await flush();
    expect(w.shown().effortId).toBe('medium');
    expect(await low).toMatchObject({ ok: true });
    expect(w.sent.map((s) => s.value)).toEqual(['low', 'medium']);
    // a late echo of low (an agent's config update) before medium's answer
    w.event({ effortId: 'low' });
    expect(w.shown().effortId).toBe('medium');
    w.answer(1);
    expect(await mid).toMatchObject({ ok: true });
    // and once more after the answer, within the hold
    w.event({ effortId: 'low' });
    expect(w.shown().effortId).toBe('medium');
    expect(seen.every((v) => v !== 'high')).toBe(true);
    expect(seen.slice(seen.indexOf('medium'))).not.toContain('low');
    // the computer's own word afterwards is the truth again
    w.event({ effortId: 'medium' });
    vi.advanceTimersByTime(CHOICE_HOLD_MS);
    expect(w.shown().effortId).toBe('medium');
    expect(w.sync.isPending('thread:t1')).toBe(false);
  });

  it("settles on the computer's adjusted value", async () => {
    const w = world();
    const done = w.set('effortId', 'max');
    await flush();
    w.answer(0, 'high');
    await done;
    expect(w.shown().effortId).toBe('high');
  });

  it('a failure puts back what the computer said and is reported', async () => {
    const w = world();
    const done = w.set('effortId', 'low');
    await flush();
    w.sent[0]!.answer.reject(new Error('nope'));
    const out = await done;
    expect(out).toMatchObject({ ok: false, latest: true });
    expect(w.shown().effortId).toBe('high');
  });

  it("an older pick's failure doesn't undo a newer one, and isn't reported", async () => {
    const w = world();
    const first = w.set('effortId', 'low');
    await flush();
    const second = w.set('effortId', 'medium');
    w.sent[0]!.answer.reject(new Error('nope'));
    expect(await first).toMatchObject({ ok: false, latest: false });
    expect(w.shown().effortId).toBe('medium');
    await flush();
    w.answer(1);
    await second;
    expect(w.shown().effortId).toBe('medium');
  });

  it('different fields of one chat go one at a time, in the order picked', async () => {
    const w = world();
    void w.set('modelId', 'sonnet');
    void w.set('effortId', 'low');
    await flush();
    expect(w.sent.map((s) => s.field)).toEqual(['modelId']);
    w.answer(0);
    await flush();
    expect(w.sent.map((s) => s.field)).toEqual(['modelId', 'effortId']);
    expect(w.shown()).toMatchObject({ modelId: 'sonnet', effortId: 'low' });
  });

  it('several keys at once (the chat and its bot)', async () => {
    const sync = new ChoiceSync();
    const answer = deferred<void>();
    void sync.change({ lane: 'thread:t1', slot: 'effort', show: { 'thread:t1': { effortId: 'low' }, 'bot:b1': { effort: 'low' } }, send: () => answer.promise });
    expect(sync.view('bot:b1', { id: 'b1', effort: 'high' }).effort).toBe('low');
    expect(sync.value('thread:t1', 'effortId', 'high')).toBe('low');
    expect(sync.view('bot:b2', null)).toBeNull();
  });
});

describe('ChoiceQueue', () => {
  it('runs a lane one at a time in order, even when answers would come back out of order', async () => {
    const q = new ChoiceQueue();
    const order: string[] = [];
    const a = deferred<string>();
    const b = deferred<string>();
    const pa = q.run('l', 'x', () => { order.push('a sent'); return a.promise; });
    const pb = q.run('l', 'x', () => { order.push('b sent'); return b.promise; });
    await flush();
    expect(order).toEqual(['a sent']);
    b.resolve('b'); // nothing sent yet, so nothing happens
    a.resolve('a');
    expect(await pa).toEqual({ ok: true, result: 'a' });
    expect(await pb).toEqual({ ok: true, result: 'b' });
    expect(order).toEqual(['a sent', 'b sent']);
    expect(q.busy('l')).toBe(false);
  });

  it('other lanes run alongside', async () => {
    const q = new ChoiceQueue();
    const sent: string[] = [];
    void q.run('a', 'x', () => { sent.push('a'); return new Promise(() => {}); });
    void q.run('b', 'x', () => { sent.push('b'); return new Promise(() => {}); });
    await flush();
    expect(sent).toEqual(['a', 'b']);
  });

  it('a send that throws fails only itself', async () => {
    const q = new ChoiceQueue();
    const bad = q.run('l', 'x', () => { throw new Error('boom'); });
    const good = q.run('l', 'y', async () => 1);
    expect(await bad).toMatchObject({ ok: false });
    expect(await good).toEqual({ ok: true, result: 1 });
  });
});

describe('choiceLane', () => {
  it("puts a chat's picker changes in its lane, settings in theirs, and nothing else anywhere", () => {
    expect(choiceLane('threads.setEffort', { id: 't1', effortId: 'low' })).toBe('thread:t1');
    expect(choiceLane('threads.setModel', { id: 't1', modelId: 'x' })).toBe('thread:t1');
    expect(choiceLane('threads.setMode', { id: 't2', modeId: 'auto' })).toBe('thread:t2');
    expect(choiceLane('settings.update', { theme: 'dark' })).toBe('settings');
    expect(choiceLane('chat.send', { text: 'hi' })).toBeNull();
  });

  it('send() runs in order and rejects with the error', async () => {
    const q = new ChoiceQueue();
    const a = deferred<number>();
    const pa = q.send('l', 'x', () => a.promise);
    const pb = q.send('l', 'x', async () => { throw new Error('no'); });
    a.resolve(1);
    expect(await pa).toBe(1);
    await expect(pb).rejects.toThrow('no');
  });
});
