/**
 * Picker choices (model, effort, fast, permission mode, agent, the defaults for new bots) that show at once and stay
 * put, however slowly or out of order the computer answers (a round trip to your AppuBot computer is ~0.65 s).
 *
 * Two parts, both UI-free:
 *  - `ChoiceQueue`: requests in one lane (a chat, a bot, the settings) go to the computer one at a time, in the order
 *    they were made, so an older request can never land after a newer one; with `coalesce`, a request still waiting
 *    for its turn is replaced by a newer one for the same slot (High → Low → Medium quickly sends High, then Medium).
 *  - `ChoiceSync`: the picked values, laid over what the computer reports (`view`) from the moment they're picked until
 *    their request settles, plus `holdMs` after a success, so an echo of an older state arriving meanwhile (an event
 *    sent before the computer got the change, an agent's late config update) can't flip the picker back. A newer pick
 *    of the same field supersedes an older one (last write wins, by sequence number); a failure puts back what the
 *    computer said, and only the latest pick's failure is reported (`latest`), for the caller's small error.
 */

export type ChoiceFields = Record<string, unknown>;

type Timer = unknown;
export interface ChoiceTimers {
  set: (fn: () => void, ms: number) => Timer;
  clear: (t: Timer) => void;
}
const realTimers: ChoiceTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

/* ---------- the queue ---------- */

export type QueueOutcome<R> = { ok: true; result: R; superseded?: false } | { ok: true; superseded: true } | { ok: false; error: unknown };

interface Job {
  slot: string;
  send: () => Promise<unknown>;
  done: (o: QueueOutcome<unknown>) => void;
}

/** One request at a time per lane, in order; `coalesce` replaces a waiting request of the same slot. */
export class ChoiceQueue {
  private lanes = new Map<string, { running: boolean; waiting: Job[] }>();

  run<R>(lane: string, slot: string, send: () => Promise<R>, opts: { coalesce?: boolean } = {}): Promise<QueueOutcome<R>> {
    return new Promise((resolve) => {
      let l = this.lanes.get(lane);
      if (!l) this.lanes.set(lane, (l = { running: false, waiting: [] }));
      const job: Job = { slot, send, done: resolve as (o: QueueOutcome<unknown>) => void };
      const at = opts.coalesce ? l.waiting.findIndex((j) => j.slot === slot) : -1;
      if (at >= 0) {
        // it keeps the replaced one's place in line (so a model picked before an effort still goes first)
        l.waiting[at]!.done({ ok: true, superseded: true });
        l.waiting[at] = job;
      } else l.waiting.push(job);
      this.pump(lane);
    });
  }

  /** `run` without coalescing, as a plain promise: the answer, or the request's own error. */
  async send<R>(lane: string, slot: string, send: () => Promise<R>): Promise<R> {
    const out = await this.run(lane, slot, send);
    if (!out.ok) throw out.error;
    if (out.superseded) throw new Error('superseded');
    return out.result;
  }

  /** Requests waiting or running in `lane`. */
  busy(lane: string): boolean {
    const l = this.lanes.get(lane);
    return !!l && (l.running || l.waiting.length > 0);
  }

  private pump(lane: string): void {
    const l = this.lanes.get(lane);
    if (!l || l.running) return;
    const job = l.waiting.shift();
    if (!job) {
      this.lanes.delete(lane);
      return;
    }
    l.running = true;
    const next = (o: QueueOutcome<unknown>) => {
      l.running = false;
      job.done(o);
      this.pump(lane);
    };
    let p: Promise<unknown>;
    try {
      p = job.send();
    } catch (error) {
      next({ ok: false, error });
      return;
    }
    p.then((result) => next({ ok: true, result }), (error: unknown) => next({ ok: false, error }));
  }
}

/**
 * The lane a gateway method's picker change goes in (null: not a picker change): a chat's model, effort, fast and
 * permission mode share their chat's lane, settings one of their own.
 */
export function choiceLane(method: string, params: unknown): string | null {
  if (method === 'threads.setModel' || method === 'threads.setEffort' || method === 'threads.setFast' || method === 'threads.setMode') {
    const id = (params as { id?: unknown } | undefined)?.id;
    return typeof id === 'string' ? `thread:${id}` : null;
  }
  if (method === 'settings.update') return 'settings';
  return null;
}

/* ---------- the overlay ---------- */

interface Pending {
  value: unknown;
  seq: number;
  settled: boolean;
  timer?: Timer;
}

export interface ChoiceChange<R> {
  /** requests in one lane go one at a time, in order (e.g. `thread:<id>`) */
  lane: string;
  /** what this request sets, for coalescing (e.g. `effort`): a waiting request of the same slot is replaced */
  slot: string;
  /** what shows at once: entity key → fields (e.g. `{ 'thread:t1': { effortId: 'low' }, 'bot:b1': { effort: 'low' } }`) */
  show: Record<string, ChoiceFields>;
  send: () => Promise<R>;
  /** the computer's word on what it set, from the answer (it may have adjusted the pick): entity key → fields */
  answered?: (result: R) => Record<string, object | undefined> | undefined;
}

export type ChoiceOutcome<R> =
  | { ok: true; result: R }
  /** a newer pick of the same slot replaced this one before it was sent */
  | { ok: true; superseded: true }
  /** `latest`: nothing newer was picked meanwhile, so the picker went back and the error is worth showing */
  | { ok: false; error: unknown; latest: boolean };

export interface ChoiceSyncOptions {
  /** how long a settled pick keeps standing over what the computer reports (late echoes of older states) */
  holdMs?: number;
  /** replace a waiting request of the same slot (default true) */
  coalesce?: boolean;
  timers?: ChoiceTimers;
}

export const CHOICE_HOLD_MS = 1500;

export class ChoiceSync {
  private seqNo = 0;
  private pending = new Map<string, Map<string, Pending>>();
  private queue = new ChoiceQueue();
  private listeners = new Set<() => void>();
  private version = 0;
  private readonly holdMs: number;
  private readonly coalesce: boolean;
  private readonly timers: ChoiceTimers;

  constructor(opts: ChoiceSyncOptions = {}) {
    this.holdMs = opts.holdMs ?? CHOICE_HOLD_MS;
    this.coalesce = opts.coalesce ?? true;
    this.timers = opts.timers ?? realTimers;
  }

  /** For `useSyncExternalStore`: called whenever what `view` returns may have changed. */
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = (): number => this.version;

  private emit(): void {
    this.version++;
    for (const fn of [...this.listeners]) fn();
  }

  /** Show the pick at once, then send it (in its lane's turn); resolves when it settles. */
  async change<R>(c: ChoiceChange<R>): Promise<ChoiceOutcome<R>> {
    const seq = ++this.seqNo;
    for (const [key, fields] of Object.entries(c.show)) {
      let m = this.pending.get(key);
      if (!m) this.pending.set(key, (m = new Map()));
      for (const [field, value] of Object.entries(fields)) {
        const prev = m.get(field);
        if (prev?.timer !== undefined) this.timers.clear(prev.timer);
        m.set(field, { value, seq, settled: false });
      }
    }
    this.emit();

    const out = await this.queue.run(c.lane, c.slot, c.send, { coalesce: this.coalesce });
    if (out.ok && out.superseded) return out;
    if (out.ok) {
      const said = c.answered?.(out.result);
      let touched = false;
      for (const [key, field, p] of this.entries(seq)) {
        const word = said?.[key] as ChoiceFields | undefined;
        if (word && field in word && word[field] !== undefined) p.value = word[field];
        p.settled = true;
        touched = true;
        p.timer = this.timers.set(() => this.drop(key, field, seq), this.holdMs);
      }
      if (touched) this.emit();
      return { ok: true, result: out.result };
    }
    let latest = false;
    for (const [key, field] of this.entries(seq)) {
      latest = true;
      this.drop(key, field, seq, false);
    }
    if (latest) this.emit();
    return { ok: false, error: out.error, latest };
  }

  /** The pending entries still owned by change `seq` (not superseded by a newer pick). */
  private entries(seq: number): [string, string, Pending][] {
    const out: [string, string, Pending][] = [];
    for (const [key, m] of this.pending) for (const [field, p] of m) if (p.seq === seq) out.push([key, field, p]);
    return out;
  }

  private drop(key: string, field: string, seq: number, notify = true): void {
    const m = this.pending.get(key);
    const p = m?.get(field);
    if (!m || !p || p.seq !== seq) return;
    if (p.timer !== undefined) this.timers.clear(p.timer);
    m.delete(field);
    if (!m.size) this.pending.delete(key);
    if (notify) this.emit();
  }

  /** `server` (what the computer reports for `key`) with the picks still standing laid over it. */
  view<T extends object>(key: string, server: T): T;
  view<T extends object>(key: string, server: T | undefined | null): T | undefined | null;
  view<T extends object>(key: string, server: T | undefined | null): T | undefined | null {
    const m = this.pending.get(key);
    if (!server || !m?.size) return server;
    const out = { ...server } as Record<string, unknown>;
    for (const [field, p] of m) out[field] = p.value;
    return out as T;
  }

  /** One field of `key`: the standing pick, else the computer's value. */
  value<V>(key: string, field: string, server: V): V {
    const p = this.pending.get(key)?.get(field);
    return p ? (p.value as V) : server;
  }

  /** Every pick of `key` still standing (settled within the hold or not), field → value. */
  standing(key: string): ChoiceFields {
    const m = this.pending.get(key);
    return m ? Object.fromEntries([...m].map(([f, p]) => [f, p.value])) : {};
  }

  /** A pick of `key` (one field, or any) hasn't settled yet. */
  isPending(key: string, field?: string): boolean {
    const m = this.pending.get(key);
    if (!m) return false;
    if (field) return !!m.get(field) && !m.get(field)!.settled;
    return [...m.values()].some((p) => !p.settled);
  }

  /** Requests waiting or running in `lane`. */
  busy(lane: string): boolean {
    return this.queue.busy(lane);
  }

  /** Forget every standing pick (another computer): requests already sent still settle, changing nothing shown. */
  clear(): void {
    for (const m of this.pending.values()) for (const p of m.values()) if (p.timer !== undefined) this.timers.clear(p.timer);
    this.pending.clear();
    this.emit();
  }
}
