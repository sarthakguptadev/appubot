/**
 * Settings › Usage's Plan limits rendered over every mock state (dev/mockLimits.ts): a card per agent with limits,
 * the right words for low and used-up windows, a quiet line for sign-ins without limits, and nothing at all on a
 * computer from before plan limits.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// server rendering reads a zustand store's initial state, so the page reads this one instead
const state: Record<string, unknown> = {};
vi.mock('../../../lib/store', async (orig) => {
  const real = await orig<typeof import('../../../lib/store')>();
  const useStore = Object.assign(<T,>(sel: (s: typeof state) => T): T => sel({ ...real.getState(), ...state }), {
    getState: () => ({ ...real.getState(), ...state }), setState: (p: Record<string, unknown>) => Object.assign(state, p), subscribe: () => () => {},
  });
  return { ...real, useStore, getState: useStore.getState, setState: useStore.setState };
});

describe('Settings › Usage › Plan limits', async () => {
  beforeAll(() => { (globalThis as { window?: unknown }).window ??= { addEventListener() {}, removeEventListener() {}, innerHeight: 900 }; });
  const { buildSeed, readOptions } = await import('../../../dev/mockData');
  const { mockLimits } = await import('../../../dev/mockLimits');
  const { setState } = await import('../../../lib/store');
  const { UsageSection } = await import('./Usage');
  const seed = buildSeed(readOptions());
  const providers = seed.snapshot.providers;
  const render = (state: Parameters<typeof mockLimits>[0] | 'none'): string => {
    setState({ providers, threads: seed.snapshot.threads, bots: seed.snapshot.bots, limits: state === 'none' ? [] : mockLimits(state, providers), limitsSupported: state !== 'none' });
    return renderToStaticMarkup(createElement(UsageSection)).replace(/<[^>]+>/g, ' ');
  };

  it('shows a card per agent with limits, each window with what is left and when it resets', () => {
    const html = render(undefined);
    expect(html).toContain('Plan limits');
    expect(html).toContain('Read from Claude and ChatGPT with your own sign-in.');
    expect(html).toMatch(/Claude Code\s+Max/);
    expect(html).toContain('62% left');
    expect(html).toMatch(/Resets in 3h (9|10)m/);
    expect(html).toContain('Week · Fable');
    expect(html).toContain('12% left');
    expect(html).toContain('$12.40 of $50 this month');
    expect(html).toMatch(/Codex\s+ChatGPT Plus/);
    expect(html).toContain('Back in 1h 1');
  });

  it('says low and used up where it is', () => {
    expect(render('low')).toContain('Running low');
    const out = render('out');
    expect(out).toContain('Used up');
    expect(out).toContain('Back in 3h');
  });

  it('an API-key sign-in gets a quiet line, and a computer from before shows no group', () => {
    const html = render('apikey');
    expect(html).toContain('Claude Code: Your own API key: pay as you go, no plan limits');
    expect(html).not.toMatch(/Claude Code\s+Max/);
    const none = render('none');
    expect(none).not.toContain('Plan limits');
    expect(none).toContain('What the bots used');
  });
});
