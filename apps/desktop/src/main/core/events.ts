/**
 * EventBus: assigns a monotonically increasing `seq` to every event, keeps the last N in a ring
 * buffer (for `lastSeq` replay on reconnect) and fans out to listeners (the gateway).
 * `message.delta` events are coalesced per (message, partIndex) for COALESCE_MS; any other
 * event flushes pending deltas first so ordering is preserved.
 * Seqs count from 0 in every run: `bootId` (random per run) tells a client whose `lastSeq` is from another one.
 * Message events carry the message's new `rev` (`trackRevisions`), bumped on the stored message as it changes.
 */
import { randomUUID } from 'node:crypto';
import { Events, type EventName, type EventPayload, type Message } from '@appubot/protocol';
import type { Logger } from './util';
import { silentLogger } from './util';

export interface BusEvent { seq: number; event: EventName; payload: unknown }
type Listener = (e: BusEvent) => void;
type Delta = EventPayload<'message.delta'>;

const COALESCE_MS = 30;

/** the events that change one message (each carries its `rev`) */
const MESSAGE_EVENTS: ReadonlySet<string> = new Set(['message.created', 'message.delta', 'message.part', 'message.reactions', 'message.completed']);

export class EventBus {
  seq = 0;
  /** this run: a `lastSeq` from another one (the app restarted) can't be replayed */
  readonly bootId = randomUUID();
  private findMessage: ((threadId: string, messageId: string) => Message | undefined) | null = null;
  private ring: BusEvent[] = [];
  private lastFrame: BusEvent | undefined;
  private listeners = new Set<Listener>();
  private pending = new Map<string, Delta>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: { capacity?: number; validate?: boolean; log?: Logger } = {}) {}

  private get log(): Logger { return this.opts.log ?? silentLogger; }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Stamp message events with the message's revision: `find` gives the stored message (its `rev` goes up by one with
   * every event about it, so a `threads.history` read and the events around it agree on which change is in it).
   */
  trackRevisions(find: (threadId: string, messageId: string) => Message | undefined): void {
    this.findMessage = find;
  }

  private stamp<E extends EventName>(event: E, payload: EventPayload<E>): EventPayload<E> {
    if (!this.findMessage || !MESSAGE_EVENTS.has(event)) return payload;
    const p = payload as { threadId: string; messageId?: string; id?: string };
    const msg = this.findMessage(p.threadId, event === 'message.created' ? p.id! : p.messageId!);
    if (!msg) return payload;
    msg.rev = (msg.rev ?? 0) + 1;
    return { ...payload, rev: msg.rev };
  }

  emit<E extends EventName>(event: E, payload: EventPayload<E>): void {
    payload = this.stamp(event, payload);
    if (event === 'message.delta') {
      const d = payload as Delta;
      const key = `${d.messageId}:${d.partIndex}`;
      // a delta for another part of the same message must not overtake the buffered one
      for (const [k, v] of this.pending) if (v.messageId === d.messageId && k !== key) { this.flush(); break; }
      const prev = this.pending.get(key);
      if (prev && prev.partType === d.partType) { prev.delta += d.delta; prev.rev = d.rev; }
      else {
        if (prev) this.flush();
        this.pending.set(key, { ...d });
      }
      if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, COALESCE_MS);
      return;
    }
    this.flush();
    this.dispatch(event, payload);
  }

  /** Flush coalesced deltas now. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.pending.size) return;
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const d of all) this.dispatch('message.delta', d);
  }

  private dispatch(event: EventName, payload: unknown): void {
    if (this.opts.validate) {
      const r = Events[event].safeParse(payload);
      if (!r.success) {
        this.log.error(`event ${event} failed schema validation`, r.error.issues.slice(0, 3));
        throw new Error(`Invalid payload for event ${event}: ${r.error.message}`);
      }
    }
    const e: BusEvent = { seq: ++this.seq, event, payload };
    // a reconnect only replays the newest frame: older ones keep their place in the ring but not their pixels (MBs each)
    if (event === 'computer.frame') {
      if (this.lastFrame) this.lastFrame.payload = { ...(this.lastFrame.payload as object), data: '' };
      this.lastFrame = e;
    }
    this.ring.push(e);
    // trimmed in batches: one splice per `cap / 4` events, not one per event (a streaming reply's every token)
    const cap = this.opts.capacity ?? 1000;
    if (this.ring.length > cap + Math.max(1, cap >> 2)) this.ring.splice(0, this.ring.length - cap);
    for (const l of this.listeners) {
      try { l(e); } catch (err) { this.log.error('event listener failed', String(err)); }
    }
  }

  /**
   * Events with seq > lastSeq, or null when the ring no longer covers that range, or `lastSeq` is past this run's
   * (a count from an earlier run of the app).
   */
  since(lastSeq: number): BusEvent[] | null {
    if (lastSeq > this.seq) return null;
    if (lastSeq === this.seq) return [];
    const first = this.ring[0];
    if (!first || first.seq > lastSeq + 1) return null;
    return this.ring.filter((e) => e.seq > lastSeq);
  }

  dispose(): void {
    this.flush();
    this.listeners.clear();
  }
}
