import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_PROVIDERS } from '@appubot/agent-runtime';
import { providerBase } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { errMsg } from '../util';

/** Where usage analytics go (PostHog's project key is a public, write-only one). */
export interface AnalyticsConfig { key: string; host: string }

type Value = string | number | boolean;
interface Captured { event: string; properties: Record<string, Value>; timestamp: string }

const FLUSH_EVERY_MS = 30_000;
const FLUSH_AT = 20;
/** what waits while PostHog can't be reached (the oldest go first) */
const MAX_QUEUE = 500;
const BUILTIN = new Set(BUILTIN_PROVIDERS.map((p) => p.id));

/** An agent as analytics names it: a built-in's id (a profile counts as its built-in), anything else "other". */
export const agentKind = (providerId: string): string => (BUILTIN.has(providerBase(providerId)) ? providerBase(providerId) : 'other');

/**
 * Anonymous usage analytics (PostHog): which features get used, under a random id made for this install
 * (`<dataDir>/analytics-id`), never messages, files, names or this computer's name. Only the packaged real app has a
 * config (`deps.analytics`); there it is always on (no switch).
 * Events go out in batches every 30s (or 20 at a time) and once more on quit.
 */
export class AnalyticsService {
  private queue: Captured[] = [];
  private timer: NodeJS.Timeout | null = null;
  private sending: Promise<void> | null = null;
  private id = '';
  private off: (() => void) | null = null;

  constructor(private ctx: CoreCtx) {}

  private get cfg(): AnalyticsConfig | undefined { return this.ctx.deps.analytics; }
  private get on(): boolean { return !!this.cfg && !!this.id; }

  start(): void {
    if (!this.cfg) return;
    this.id = this.installId();
    const versionFile = join(this.ctx.paths.dataDir, 'analytics-version');
    let last: string | undefined;
    try { if (existsSync(versionFile)) last = readFileSync(versionFile, 'utf8').trim() || undefined; } catch { /* first run */ }
    this.capture('app_opened', { first_open: !last });
    if (last && last !== this.ctx.deps.version) this.capture('app_updated', { from: last, to: this.ctx.deps.version });
    try { writeFileSync(versionFile, this.ctx.deps.version); } catch (e) { this.ctx.log.warn('saving the analytics version failed', errMsg(e)); }
    this.off = this.ctx.s.settings.onChange((next, prev) => {
      if (next.onboarded && !prev.onboarded) this.capture('onboarding_completed');
    });
    this.timer = setInterval(() => { void this.flush(); }, FLUSH_EVERY_MS);
    this.timer.unref?.();
  }

  /** One event, with this install's version, OS and chip; dropped without a config. */
  capture(event: string, props: Record<string, Value | undefined> = {}): void {
    if (!this.on) return;
    const properties: Record<string, Value> = {
      distinct_id: this.id, app: 'desktop', app_version: this.ctx.deps.version, os: platform(), os_version: release(), arch: arch(), $lib: 'appubot-desktop',
    };
    for (const [k, v] of Object.entries(props)) if (v !== undefined) properties[k] = v;
    this.queue.push({ event, properties, timestamp: new Date().toISOString() });
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    if (this.queue.length >= FLUSH_AT) void this.flush();
  }

  /** Sends what waits; on failure it waits for the next try. */
  flush(): Promise<void> {
    const cfg = this.cfg;
    if (!cfg || !this.queue.length || !this.on) return Promise.resolve();
    this.sending ??= (async () => {
      const batch = this.queue.splice(0);
      try {
        const res = await (this.ctx.deps.fetch ?? fetch)(`${cfg.host}/batch/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ api_key: cfg.key, batch }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        const room = MAX_QUEUE - this.queue.length;
        if (room > 0) this.queue.unshift(...batch.slice(-room));
        this.ctx.log.debug('sending analytics failed', errMsg(e));
      }
    })().finally(() => { this.sending = null; });
    return this.sending;
  }

  /** On quit: the last events, but never holding the quit up for more than 2s. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.off?.();
    this.off = null;
    await Promise.race([this.flush(), new Promise((r) => setTimeout(r, 2000))]);
  }

  private installId(): string {
    const file = join(this.ctx.paths.dataDir, 'analytics-id');
    try {
      const saved = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
      if (saved) return saved;
    } catch { /* made below */ }
    const id = randomUUID();
    try { writeFileSync(file, id); } catch (e) { this.ctx.log.warn('saving the analytics id failed', errMsg(e)); }
    return id;
  }
}
