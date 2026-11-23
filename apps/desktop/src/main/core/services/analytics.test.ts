import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchema, type Settings } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { deepMerge, silentLogger } from '../util';
import { AnalyticsService, agentKind } from './analytics';

interface Sent { url: string; body: { api_key: string; batch: { event: string; properties: Record<string, unknown>; timestamp: string }[] } }

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

function setup(o: { version?: string; saved?: Record<string, unknown>; config?: boolean; fail?: () => boolean } = {}) {
  dir ||= mkdtempSync(join(tmpdir(), 'appubot-analytics-'));
  let settings = SettingsSchema.parse(o.saved ?? {});
  const listeners = new Set<(n: Settings, p: Settings) => void>();
  const sent: Sent[] = [];
  const ctx = {
    deps: {
      version: o.version ?? '2026.10.17',
      ...(o.config === false ? {} : { analytics: { key: 'phc_test', host: 'https://ph.example' } }),
      fetch: async (url: string, init: { body: string }) => {
        if (o.fail?.()) throw new Error('offline');
        sent.push({ url, body: JSON.parse(init.body) as Sent['body'] });
        return new Response('{}', { status: 200 });
      },
    },
    paths: { dataDir: dir },
    log: silentLogger,
    s: {
      settings: {
        get: () => settings,
        update: (patch: Partial<Settings>) => {
          const prev = settings;
          settings = SettingsSchema.parse(deepMerge(prev, patch));
          for (const l of listeners) l(settings, prev);
          return settings;
        },
        onChange: (fn: (n: Settings, p: Settings) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
      },
    },
  } as unknown as CoreCtx;
  return { svc: new AnalyticsService(ctx), ctx, sent };
}
const events = (sent: Sent[]) => sent.flatMap((s) => s.body.batch.map((b) => b.event));

describe('analytics', () => {
  it('sends anonymous events in PostHog batches, tagged as the desktop app', async () => {
    const { svc, sent } = setup();
    svc.start();
    svc.capture('bot_created', { agent: 'claude-code', computer_use: true, skipped: undefined });
    await svc.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://ph.example/batch/');
    expect(sent[0]!.body.api_key).toBe('phc_test');
    const [opened, created] = sent[0]!.body.batch;
    expect(opened).toMatchObject({ event: 'app_opened', properties: { app: 'desktop', app_version: '2026.10.17', first_open: true } });
    expect(created!.properties).toMatchObject({ agent: 'claude-code', computer_use: true, distinct_id: opened!.properties.distinct_id });
    expect(created!.properties).not.toHaveProperty('skipped');
    await svc.stop();
  });

  it('keeps one id per install and notices an update', async () => {
    const first = setup({ version: '2026.10.17' });
    first.svc.start();
    await first.svc.stop();
    const again = setup({ version: '2026.10.18' });
    again.svc.start();
    await again.svc.flush();
    const batch = again.sent[0]!.body.batch;
    expect(batch.map((b) => b.event)).toEqual(['app_opened', 'app_updated']);
    expect(batch[0]!.properties).toMatchObject({ first_open: false, distinct_id: first.sent[0]!.body.batch[0]!.properties.distinct_id });
    expect(batch[1]!.properties).toMatchObject({ from: '2026.10.17', to: '2026.10.18' });
    await again.svc.stop();
  });

  it('is always on: a switch saved off by an older version is ignored', async () => {
    const { svc, sent } = setup({ saved: { analytics: false } });
    svc.start();
    svc.capture('message_sent');
    await svc.stop();
    expect(events(sent)).toEqual(['app_opened', 'message_sent']);
  });

  it('does nothing without a config (dev builds, tests)', async () => {
    const { svc, sent } = setup({ config: false });
    svc.start();
    svc.capture('bot_created');
    await svc.stop();
    expect(sent).toEqual([]);
  });

  it('keeps events through a failed send and delivers them next time', async () => {
    let down = true;
    const { svc, sent } = setup({ fail: () => down });
    svc.start();
    svc.capture('routine_created');
    await svc.flush();
    expect(sent).toEqual([]);
    down = false;
    await svc.flush();
    expect(events(sent)).toEqual(['app_opened', 'routine_created']);
    await svc.stop();
  });

  it('names agents without anything a user typed', () => {
    expect(agentKind('claude-code')).toBe('claude-code');
    expect(agentKind('claude-code@work-account')).toBe('claude-code');
    expect(agentKind('my-own-agent')).toBe('other');
  });
});
