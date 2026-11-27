/**
 * The sidebar's foot (2026-11-27): who is signed in at the left, their picture and name, with Settings
 * and Account in its menu; the computer picker and a round Connect apps button at the right. The top strip keeps only
 * search and +.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const cloudState: { view: unknown; supported: boolean; loading: boolean; busy: Record<string, true> } = { view: null, supported: true, loading: false, busy: {} };
vi.mock('../../features/cloud/cloudAccount', async (orig) => {
  const real = await orig<typeof import('../../features/cloud/cloudAccount')>();
  const useCloud = Object.assign(<T,>(sel: (s: typeof cloudState) => T): T => sel(cloudState), {
    getState: () => cloudState, setState: (p: Partial<typeof cloudState>) => Object.assign(cloudState, p), subscribe: () => () => {},
  });
  return { ...real, useCloud };
});

describe('sidebar foot', async () => {
  beforeAll(() => { (globalThis as { window?: unknown }).window ??= { addEventListener() {}, removeEventListener() {} }; });
  const { mockCloudView } = await import('../../dev/mockCloud');
  const { Sidebar } = await import('./Sidebar');
  const render = () => renderToStaticMarkup(createElement(Sidebar));

  it('shows the signed-in person, a round Connect apps button and no gear of its own', () => {
    const view = mockCloudView('running');
    Object.assign(cloudState, { view, supported: true });
    const html = render();
    const who = view.account?.name ?? view.account?.email;
    expect(who).toBeTruthy();
    expect(html).toContain(`aria-label="${who}, Settings"`);
    expect(html).toContain('aria-label="Connect apps"');
    expect(html).not.toMatch(/<span class="truncate">Connect apps<\/span>/);
  });

  it('says Settings where nobody is signed in', () => {
    Object.assign(cloudState, { view: mockCloudView('signed-out'), supported: true });
    expect(render()).toContain('aria-label="Settings"');
  });

  it('keeps only search and + in the top strip', () => {
    Object.assign(cloudState, { view: mockCloudView('running'), supported: true });
    const strip = render().split('<nav')[0]!;
    expect(strip.match(/<button/g)?.length).toBe(2);
    expect(strip).not.toContain('Computer:');
  });
});
