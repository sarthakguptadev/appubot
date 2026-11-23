import { APPUBOT_AI_PROVIDER_ID, SettingsSchema, creditModelAllowed, type Settings } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { deepMerge } from '../util';
import { checkCreditPick } from './credit';

type Listener = (next: Settings, prev: Settings) => void;

export class SettingsService {
  private listeners = new Set<Listener>();
  constructor(private ctx: CoreCtx) {}

  get(): Settings { return this.ctx.store.settings.get(); }

  update(patch: Partial<Settings>): Settings {
    const prev = this.get();
    const next = SettingsSchema.parse(deepMerge(prev, patch));
    // AppuBot AI (the launch bonus) as the agent for new bots: Sonnet or Haiku, no fast mode
    checkCreditPick(next.defaultProviderId, { modelId: patch.defaultModelId });
    if (next.defaultProviderId === APPUBOT_AI_PROVIDER_ID && next.defaultModelId && !creditModelAllowed(next.defaultModelId)) next.defaultModelId = '';
    this.ctx.store.settings.set(next);
    this.ctx.bus.emit('settings.updated', next);
    for (const l of this.listeners) {
      try { l(next, prev); } catch (e) { this.ctx.log.error('settings listener failed', String(e)); }
    }
    return next;
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
