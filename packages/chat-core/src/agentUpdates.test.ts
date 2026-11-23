import { describe, expect, it } from 'vitest';
import { ProviderSchema } from '@appubot/protocol';
import { AGENT_UPDATE_SNOOZE_MS, agentUpdateNotice, agentUpdateOffers, agentUpdatesToAnnounce, agentUpdateVersions, liveSnoozes } from './agentUpdates';

const prov = (x: Record<string, unknown>) => ProviderSchema.parse({ name: String(x.id), command: 'x', installed: true, ...x });
const claude = prov({ id: 'claude-code', name: 'Claude Code', builtin: true, latestVersion: '2.1.5', updateAvailable: true, update: { running: false, current: '2.1.3', via: 'claude update' } });

describe('agent update notices', () => {
  it('offers only agents that are on, used here and updatable from here', () => {
    const codex = prov({ id: 'codex', name: 'Codex', latestVersion: '0.9', updateAvailable: true, update: { running: false, current: '0.8', via: 'npm' } });
    const manual = prov({ id: 'copilot', latestVersion: '2', updateAvailable: true, update: { running: false, current: '1' } });
    const reg = prov({ id: 'reg', registry: { id: 'gemini', version: '1.0' }, latestVersion: '1.1', updateAvailable: true });
    const off = prov({ id: 'opencode', enabled: false, latestVersion: '2', updateAvailable: true, update: { running: false, current: '1', via: 'opencode upgrade' } });
    const bots = [{ providerId: 'claude-code@work' }, { providerId: 'copilot' }, { providerId: 'reg' }, { providerId: 'opencode' }];
    const offers = agentUpdateOffers([claude, codex, manual, reg, off], bots, { defaultProviderId: '' });
    // a profile's bot counts for its agent; codex isn't used; copilot has no way to update here; opencode is off
    expect(offers).toEqual([{ id: 'claude-code', name: 'Claude Code', from: '2.1.3', to: '2.1.5' }, { id: 'reg', name: 'reg', from: '1.0', to: '1.1' }]);
    expect(agentUpdateOffers([codex], [], { defaultProviderId: 'codex' })).toHaveLength(1);
    expect(agentUpdateOffers([{ ...claude, update: { ...claude.update!, running: true } }], bots, null)).toEqual([]);
  });

  it('raises each version once a run, and not while put off', () => {
    const offer = { id: 'claude-code', name: 'Claude Code', from: '2.1.3', to: '2.1.5' };
    const now = 1_000;
    expect(agentUpdatesToAnnounce([offer], new Map(), {}, now)).toEqual([offer]);
    expect(agentUpdatesToAnnounce([offer], new Map([['claude-code', '2.1.5']]), {}, now)).toEqual([]);
    expect(agentUpdatesToAnnounce([{ ...offer, to: '2.1.6' }], new Map([['claude-code', '2.1.5']]), {}, now)).toHaveLength(1);
    const snoozes = { 'claude-code': { version: '2.1.5', until: now + AGENT_UPDATE_SNOOZE_MS } };
    expect(agentUpdatesToAnnounce([offer], new Map(), snoozes, now)).toEqual([]);
    expect(agentUpdatesToAnnounce([{ ...offer, to: '2.1.6' }], new Map(), snoozes, now)).toHaveLength(1);
    expect(agentUpdatesToAnnounce([offer], new Map(), snoozes, now + AGENT_UPDATE_SNOOZE_MS + 1)).toHaveLength(1);
    expect(liveSnoozes(snoozes, now + AGENT_UPDATE_SNOOZE_MS + 1)).toEqual({});
  });

  it('words each step', () => {
    const offer = { id: 'claude-code', name: 'Claude Code', from: '2.1.3', to: 'v2.1.5' };
    expect(agentUpdateVersions(offer)).toBe('v2.1.3 → v2.1.5');
    expect(agentUpdateNotice(offer, 'offer')).toEqual({ title: 'Claude Code has an update', body: 'v2.1.3 → v2.1.5' });
    expect(agentUpdateNotice(offer, 'failed', '  ').body).toMatch(/Try again/);
  });
});
