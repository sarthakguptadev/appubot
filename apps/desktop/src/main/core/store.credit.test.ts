import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPUBOT_AI_PROVIDER_ID, BotSchema, ThreadSchema } from '@appubot/protocol';
import { Store } from './store';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'appubot-store-credit-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const now = Date.now();
const bot = (over: Record<string, unknown>) => BotSchema.parse({ id: 'bot_a', slug: 'a', name: 'A', color: 'blue', shape: 'circle', workspace: '/tmp/a', createdAt: now, updatedAt: now, providerId: APPUBOT_AI_PROVIDER_ID, ...over });
const thread = (over: Record<string, unknown>) => ThreadSchema.parse({ id: 'thr_a', botId: 'bot_a', title: 'Chat', providerId: APPUBOT_AI_PROVIDER_ID, cwd: '/tmp/a', createdAt: now, updatedAt: now, ...over });
const MODELS = [{ id: 'default', name: 'Default' }, { id: 'opus', name: 'Opus 5.5' }, { id: 'sonnet', name: 'Sonnet 5.5' }, { id: 'haiku', name: 'Haiku 5.5' }];

describe('AppuBot AI picks saved before the launch bonus was Sonnet and Haiku only', () => {
  it('drops the other models and fast mode from its bots, threads and the model for new bots; other agents keep theirs', () => {
    writeFileSync(join(dir, 'bots.json'), JSON.stringify([bot({ modelId: 'claude-opus-5-5', fast: true }), bot({ id: 'bot_b', slug: 'b', providerId: 'claude-code', modelId: 'claude-opus-5-5', fast: true })]));
    writeFileSync(join(dir, 'threads.json'), JSON.stringify([thread({ models: MODELS, modelId: 'opus', fast: true, fastAvailable: true }), thread({ id: 'thr_b', botId: 'bot_b', providerId: 'claude-code', models: MODELS, modelId: 'opus', fast: true, fastAvailable: true })]));
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ defaultProviderId: APPUBOT_AI_PROVIDER_ID, defaultModelId: 'claude-fable-5-1' }));
    const store = new Store(dir);
    const [a, b] = store.bots.get();
    expect(a).toMatchObject({ fast: false });
    expect(a!.modelId).toBeUndefined();
    expect(b).toMatchObject({ modelId: 'claude-opus-5-5', fast: true });
    const ta = store.threads.get('thr_a')!, tb = store.threads.get('thr_b')!;
    expect(ta.models.map((m) => m.id)).toEqual(['sonnet', 'haiku']);
    expect(ta).toMatchObject({ fast: false, fastAvailable: false });
    expect(ta.modelId).toBeUndefined();
    expect(tb.models).toHaveLength(4);
    expect(tb).toMatchObject({ modelId: 'opus', fast: true });
    expect(store.settings.get().defaultModelId).toBe('');
  });
});
