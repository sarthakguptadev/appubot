import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@appubot/protocol';

vi.mock('./native', () => ({ native: () => ({ version: '1' }) }));
vi.mock('./platform', () => ({ MACHINE: 'Mac' }));

/** Requests the test answers by hand, in its own time. */
const sent: { method: string; params: Record<string, unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
vi.mock('./gateway', async (orig) => ({
  ...(await orig<typeof import('./gateway')>()),
  rpc: (method: string, params: Record<string, unknown>) => new Promise((resolve, reject) => sent.push({ method, params, resolve, reject })),
}));
const flush = () => new Promise<void>((r) => setImmediate(r));

const base = { theme: 'system', defaultEffort: 'high', defaultModelId: '', launchAtLogin: true } as unknown as Settings;

afterEach(() => { sent.length = 0; });

/*
 * Settings' "Model for new bots" picker: High → Low → Medium quickly over a slow link used to show Low again when the
 * first answer (and its settings.updated) came back, then Medium. Each pick now shows at once and stays.
 */
describe('settings picks', () => {
  it('stay put through older answers and events, and only the last waiting one is sent', async () => {
    const { getState } = await import('./store');
    const { applyEvent } = await import('./events');
    const { updateSettings } = await import('./choices');
    applyEvent('settings.updated', base);
    const effort = () => getState().settings!.defaultEffort;

    const low = updateSettings({ defaultEffort: 'low' });
    expect(effort()).toBe('low');
    void updateSettings({ defaultEffort: 'max' });
    const medium = updateSettings({ defaultEffort: 'medium' });
    expect(effort()).toBe('medium');
    await flush();
    expect(sent.map((r) => r.params.defaultEffort)).toEqual(['low']);

    // the computer applies low: its event, then its answer
    applyEvent('settings.updated', { ...base, defaultEffort: 'low' });
    expect(effort()).toBe('medium');
    sent[0]!.resolve({ ...base, defaultEffort: 'low' });
    await low;
    expect(effort()).toBe('medium');
    await flush();
    expect(sent.map((r) => r.params.defaultEffort)).toEqual(['low', 'medium']);

    // something else changing meanwhile still comes through
    applyEvent('settings.updated', { ...base, defaultEffort: 'low', theme: 'dark' });
    expect(getState().settings).toMatchObject({ defaultEffort: 'medium', theme: 'dark' });

    sent[1]!.resolve({ ...base, defaultEffort: 'medium', theme: 'dark' });
    await medium;
    expect(effort()).toBe('medium');
  });

  it('a refusal puts back what the computer last said, leaving other fields alone', async () => {
    const { getState } = await import('./store');
    const { applyEvent } = await import('./events');
    const { updateSettings } = await import('./choices');
    applyEvent('settings.updated', base);
    const p = updateSettings({ defaultEffort: 'low' });
    expect(getState().settings!.defaultEffort).toBe('low');
    applyEvent('settings.updated', { ...base, theme: 'light' });
    await flush();
    sent[0]!.reject(new Error('nope'));
    expect(await p).toBeUndefined();
    expect(getState().settings).toMatchObject({ defaultEffort: 'high', theme: 'light' });
  });
});
