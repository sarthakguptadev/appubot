/**
 * Live view's Watching / Take control, the same on every computer (a Mac watched from a phone, your AppuBot computer,
 * a team's): everyone watching sees the screen, nobody's input reaches it until they take control, and one person at
 * a time has it. While someone does, every bot's computer step waits (ComputerService.gate); control goes back when
 * they choose Watching, close the view (their connection or VNC socket goes), or give no input for CONTROL_IDLE_MS.
 *
 * A holder is known by a `key` of the caller's (a gateway connection `conn:<n>`, a noVNC socket `vnc:<n>`); the
 * protocol's `ScreenControl` carries an `id` of its own per hold, never the key.
 */
import { CONTROL_IDLE_MS, newId, type ScreenControl } from '@appubot/protocol';
import { RpcError } from '../util';

export interface ControlHolder {
  key: string;
  name: string;
  via: ScreenControl['via'];
}

export class ScreenControlHolder {
  private held: (Omit<ScreenControl, 'left'> & { key: string }) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(c: ScreenControl | null) => void>();

  constructor(private o: { idleMs?: number; now?: () => number } = {}) {}

  private get idle(): number { return this.o.idleMs ?? CONTROL_IDLE_MS; }
  private now(): number { return this.o.now?.() ?? Date.now(); }

  /** who has control now (null: nobody) */
  current(): ScreenControl | null {
    if (!this.held) return null;
    const { key: _key, ...c } = this.held;
    return { ...c, left: Math.max(0, c.expiresAt - this.now()) };
  }

  holds(key: string): boolean { return this.held?.key === key; }

  /** Hears every change of hands (and renewal); returns the unsubscribe. */
  onChange(fn: (c: ScreenControl | null) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /**
   * Takes control for this holder, or renews it when it has it already. Refused while someone else has it: they give
   * it back, close their view, or it times out.
   */
  take(h: ControlHolder): ScreenControl {
    if (this.held && this.held.key !== h.key) throw new RpcError('in_control', `${this.held.name} is in control of the screen right now. Watch until they give it back.`);
    const now = this.now();
    this.held = this.held
      ? { ...this.held, name: h.name || this.held.name, expiresAt: now + this.idle }
      : { key: h.key, id: newId('ctl'), name: h.name || 'Someone', via: h.via, since: now, expiresAt: now + this.idle };
    this.arm();
    this.emit();
    return this.current()!;
  }

  /** The holder's input (or word that they are still at it): the idle time starts again. Nothing for anyone else. */
  touch(key: string): boolean {
    if (!this.held || this.held.key !== key) return false;
    const next = this.now() + this.idle;
    // a renewal moves the deadline every views count down to: tell them only when it moved noticeably (input comes often)
    const tell = next - this.held.expiresAt > 1000;
    this.held = { ...this.held, expiresAt: next };
    this.arm();
    if (tell) this.emit();
    return true;
  }

  /** Gives control back (the holder chose Watching, or its view closed). Nothing when someone else has it. */
  release(key: string): boolean {
    if (!this.held || this.held.key !== key) return false;
    this.clear();
    return true;
  }

  private clear(): void {
    this.held = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.emit();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    const left = Math.max(0, (this.held?.expiresAt ?? 0) - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      // input may have come meanwhile
      if (this.held && this.held.expiresAt <= this.now()) this.clear();
      else if (this.held) this.arm();
    }, left);
    this.timer.unref?.();
  }

  private emit(): void {
    const c = this.current();
    for (const fn of this.listeners) { try { fn(c); } catch { /* a listener's own trouble */ } }
  }

  shutdown(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.held = null;
    this.listeners.clear();
  }
}
