/**
 * Phone notifications that arrive with the app closed: each notice a phone should hear about goes to the AppuBot
 * Connect relay (`POST /push`), which sends it through Firebase Cloud Messaging. The relay only takes requests signed
 * with this computer's Connect identity (made on first use, Connect on or off: pushing needs no tunnel).
 *
 * Per phone (`pushTargets`): only those that registered (`devices.setPush`), aren't switched off here (Settings ›
 * Devices) and want this kind, all while the computer's own "Phone notifications" is on. Whether the person is at this
 * computer or has the phone open isn't weighed (2026-11-08: it dropped routines' notices for people who had just
 * walked away; a phone in front shows the push itself, hiding one about the chat on screen). Previews off sends only
 * "<bot> finished" and the like.
 *
 * Delivery: an in-memory queue, one request at a time (up to 10 messages), retried a few times within ~2 minutes
 * (`RETRY_MS`), then dropped; a notice goes to a phone once (`seen`), and a newer one for the same chat replaces one
 * still waiting. A token the relay says is dead is forgotten. A relay that refuses the computer (blocked, pushes off)
 * is left alone for the time it says.
 */
import {
  CONNECT_RELAY_URL, CONNECT_TICKET_HEADER, PUSH_LIMITS, pushUrl, signPush,
  type PushKind, type PushMessage, type PushRefusal, type PushResponse, type PushResult,
} from '@appubot/protocol';
import type { CoreCtx } from '../context';
import type { StoredDevice } from '../store';
import { errMsg } from '../util';

/** what a notice says, and about what */
export interface PushNotice {
  /** the notice's id (the desktop notification's): a phone hears about it once */
  nid: string;
  kind: PushKind;
  botName: string;
  botId?: string;
  threadId?: string;
  /** with previews on: the title (the bot's name, or what the bot titled it) and the line under it */
  title: string;
  text: string;
}

interface Job {
  deviceId: string;
  token: string;
  message: PushMessage;
  /** one per phone and chat: a newer notice replaces one still waiting */
  slot: string;
  tries: number;
  due: number;
  /** given up after this */
  until: number;
}

/** waits before the 2nd, 3rd and 4th try; with the first, all within ~2 minutes */
export const RETRY_MS = [5_000, 20_000, 60_000];
const GIVE_UP_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** how long a relay that refused the computer outright (blocked, pushes off) is left alone without saying */
const REFUSED_WAIT_MS = 60 * 60_000;
const SEEN_MAX = 2000;
const QUEUE_MAX = 200;
const TITLE_MAX = 100;
const TEXT_MAX = 240;

/** What a notice says on a phone: the bot's own words with previews on, else who and what only. */
export function pushText(n: Pick<PushNotice, 'kind' | 'botName' | 'title' | 'text'>, previews: boolean): { title?: string; body: string } {
  if (!previews) {
    const what = n.kind === 'needs-you' ? 'needs you' : n.kind === 'failed' ? 'couldn’t finish' : 'finished';
    return { body: cut(`${n.botName || 'AppuBot'} ${what}`, TEXT_MAX) };
  }
  return { title: cut(n.title || n.botName || 'AppuBot', TITLE_MAX), body: cut(n.text.trim() || (n.kind === 'failed' ? 'Couldn’t finish' : 'Done'), TEXT_MAX) };
}

/**
 * The phones a notice goes to, and what each gets: registered, on here, wanting this kind; none while the computer's
 * "Phone notifications" is off.
 */
export function pushTargets(n: PushNotice, devices: readonly StoredDevice[], o: { mobileOn: boolean }): Array<{ deviceId: string; token: string; message: PushMessage }> {
  if (!o.mobileOn) return [];
  const out: Array<{ deviceId: string; token: string; message: PushMessage }> = [];
  for (const d of devices) {
    const p = d.push;
    if (!p || d.pushOff || !p.kinds.includes(n.kind)) continue;
    const text = pushText(n, p.previews);
    out.push({
      deviceId: d.id,
      token: p.token,
      message: {
        token: p.token,
        platform: p.platform,
        ...(text.title ? { title: text.title } : {}),
        body: text.body,
        ...(n.threadId ? { collapse: collapseOf(n.threadId) } : {}),
        data: { nid: n.nid, kind: n.kind, deviceId: d.id, ...(n.threadId ? { threadId: n.threadId } : {}), ...(n.botId ? { botId: n.botId } : {}) },
      },
    });
  }
  return out;
}

export class PushService {
  private queue: Job[] = [];
  /** `nid:deviceId` already queued or sent */
  private seen = new Set<string>();
  private nonce: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  private stopped = false;
  /** the relay refused this computer (blocked, pushes off, no Firebase account): nothing is sent until then */
  private heldUntil = 0;
  private lastHeldLog = 0;
  /** counts since launch (Settings › Devices doesn't show them; tests and logs do) */
  readonly stats = { sent: 0, dropped: 0, failed: 0, retried: 0, givenUp: 0 };

  constructor(private ctx: CoreCtx) {}

  /** One notice: queued for every phone that should hear of it now. */
  notice(n: PushNotice): void {
    if (this.stopped) return;
    const targets = pushTargets(n, this.ctx.store.devices.get().devices, { mobileOn: this.ctx.s.settings.get().notifications.mobile });
    if (!targets.length) return;
    const now = this.now();
    if (now < this.heldUntil) {
      if (now - this.lastHeldLog > 10 * 60_000) { this.lastHeldLog = now; this.ctx.log.info('push: the relay isn’t taking this computer’s notifications for now'); }
      return;
    }
    for (const t of targets) {
      const key = `${n.nid}:${t.deviceId}`;
      if (this.seen.has(key)) continue;
      this.remember(key);
      const slot = `${t.deviceId}:${n.threadId ?? n.nid}`;
      const job: Job = { deviceId: t.deviceId, token: t.token, message: t.message, slot, tries: 0, due: now, until: now + GIVE_UP_MS };
      // a newer word on the same chat replaces one that hasn't gone out yet
      const i = this.queue.findIndex((j) => j.slot === slot);
      if (i >= 0) this.queue[i] = job;
      else if (this.queue.length < QUEUE_MAX) this.queue.push(job);
      else { this.stats.givenUp += 1; continue; }
    }
    this.schedule(0);
  }

  /** Waiting notices, and whether a request is out (tests). */
  get pending(): number { return this.queue.length + (this.sending ? 1 : 0); }
  get busy(): boolean { return this.sending; }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
  }

  private now(): number { return Date.now(); }

  private remember(key: string): void {
    this.seen.add(key);
    if (this.seen.size > SEEN_MAX) {
      // a Set keeps insertion order: the oldest go first
      for (const k of this.seen) { this.seen.delete(k); if (this.seen.size <= SEEN_MAX / 2) break; }
    }
  }

  private schedule(delay: number): void {
    if (this.stopped || this.sending) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, Math.max(0, delay));
    this.timer.unref?.();
  }

  /** Next wake-up: the earliest due job. */
  private reschedule(): void {
    if (!this.queue.length) return;
    const next = Math.min(...this.queue.map((j) => j.due));
    this.schedule(next - this.now());
  }

  private async flush(): Promise<void> {
    if (this.sending || this.stopped) return;
    const now = this.now();
    // ones past their time are given up, and ones for a phone revoked, switched off or registered anew since are dropped
    const devices = this.ctx.store.devices.get().devices;
    const live = (j: Job) => devices.some((d) => d.id === j.deviceId && !d.pushOff && d.push?.token === j.token);
    const late = this.queue.filter((j) => j.until <= now);
    if (late.length) this.stats.givenUp += late.length;
    this.queue = this.queue.filter((j) => j.until > now && live(j));
    const batch = this.queue.filter((j) => j.due <= now).slice(0, PUSH_LIMITS.messages);
    if (!batch.length) return this.reschedule();
    this.queue = this.queue.filter((j) => !batch.includes(j));
    this.sending = true;
    try {
      await this.send(batch);
    } catch (e) {
      this.ctx.log.warn('push: the relay couldn’t be reached', errMsg(e));
      this.again(batch);
    } finally {
      this.sending = false;
      this.reschedule();
    }
  }

  /** Put a batch back for another try, if it has one left. */
  private again(batch: Job[], afterMs?: number): void {
    const now = this.now();
    for (const j of batch) {
      j.tries += 1;
      const wait = Math.max(afterMs ?? 0, RETRY_MS[j.tries - 1] ?? Infinity);
      if (j.tries > RETRY_MS.length || now + wait > j.until) { this.stats.givenUp += 1; continue; }
      j.due = now + wait;
      this.stats.retried += 1;
      // a newer notice for the same chat may have come in meanwhile: it wins
      if (!this.queue.some((q) => q.slot === j.slot)) this.queue.push(j);
    }
  }

  private async send(batch: Job[]): Promise<void> {
    const body = JSON.stringify({ messages: batch.map((j) => j.message) });
    let r = await this.post(body);
    // a nonce gone stale (or the first one): the answer brings a fresh one, so once more at once
    if (r.status === 401) r = await this.post(body);
    if (r.status === 200) {
      const res = r.json as PushResponse;
      batch.forEach((j, i) => this.settle(j, res.results?.[i]));
      return;
    }
    const refusal = (r.json ?? {}) as PushRefusal;
    const retryAfterMs = Math.max(0, Number(refusal.retryAfter ?? r.retryAfter ?? 0)) * 1000;
    if (r.status === 429 || r.status === 401 || (r.status >= 500 && refusal.error !== 'push_disabled' && refusal.error !== 'push_unavailable')) {
      return this.again(batch, retryAfterMs);
    }
    if (r.status === 403 || refusal.error === 'push_disabled' || refusal.error === 'push_unavailable') {
      // the operator stopped this computer's pushes (or everyone's): left alone for the time it says
      this.heldUntil = this.now() + (retryAfterMs || REFUSED_WAIT_MS);
      this.ctx.log.warn(`push: the relay refused (${refusal.error ?? r.status}); holding notifications for ${Math.round((this.heldUntil - this.now()) / 60_000)} min`);
      this.stats.failed += batch.length;
      this.queue = [];
      return;
    }
    // 400/413: nothing to gain from repeating it
    this.ctx.log.warn(`push: the relay refused a request (${refusal.error ?? r.status})`);
    this.stats.failed += batch.length;
  }

  private settle(j: Job, res: PushResult | undefined): void {
    switch (res?.status) {
      case 'sent': this.stats.sent += 1; return;
      case 'drop':
        this.stats.dropped += 1;
        this.ctx.s.devices.dropPush(j.deviceId, j.token);
        return;
      case 'retry': return this.again([j], Math.max(0, res.retryAfter ?? 0) * 1000);
      default: this.stats.failed += 1;
    }
  }

  /** One signed request, with a nonce fetched first when there's none. */
  private async post(body: string): Promise<{ status: number; json: unknown; retryAfter?: number }> {
    const url = pushUrl(this.relayUrl());
    // the relay pass: the hosted relay sends pushes only for an AppuBot account's computers
    const ticket = await this.ctx.s.connect.relayPass().catch(() => null);
    if (!this.nonce) {
      const n = await this.fetch(url, { method: 'GET' });
      if (n.status !== 200 || typeof (n.json as { nonce?: unknown })?.nonce !== 'string') return n;
      this.nonce = (n.json as { nonce: string }).nonce;
    }
    const id = this.ctx.s.connect.identity();
    const headers = { 'content-type': 'application/json', ...signPush(id.edSecret, id.edPublic, this.nonce, new TextEncoder().encode(body)), ...(ticket ? { [CONNECT_TICKET_HEADER]: ticket } : {}) };
    // each nonce opens one request: the answer brings the next
    this.nonce = null;
    const r = await this.fetch(url, { method: 'POST', headers, body });
    const next = (r.json as { nonce?: unknown } | null)?.nonce;
    if (typeof next === 'string') this.nonce = next;
    return r;
  }

  private async fetch(url: string, init: RequestInit): Promise<{ status: number; json: unknown; retryAfter?: number }> {
    const f = this.ctx.deps.fetch ?? fetch;
    const res = await f(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    let json: unknown = null;
    try { json = await res.json(); } catch { /* not JSON: the status says enough */ }
    const ra = Number(res.headers.get('retry-after'));
    return { status: res.status, json, ...(Number.isFinite(ra) && ra > 0 ? { retryAfter: ra } : {}) };
  }

  private relayUrl(): string {
    return this.ctx.deps.connect?.relayUrl ?? process.env.APPUBOT_CONNECT_URL ?? CONNECT_RELAY_URL;
  }
}

/** APNs collapse ids are at most 64 bytes; thread ids are short ASCII anyway */
function collapseOf(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

function cut(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}
