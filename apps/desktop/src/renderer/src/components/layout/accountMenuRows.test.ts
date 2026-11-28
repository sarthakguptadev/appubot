/**
 * The account menu (the sidebar foot's AccountButton) as it opens: no plan-and-usage row (the owner, 2026-11-28: "rm";
 * Settings › Usage shows it), and Upgrade plan where there is one.
 */
import { createElement, type ReactNode } from 'react';
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

type Row = { label: string; onSelect: () => void } | 'separator';
/** every menu's rows as drawn last, by the label of its trigger */
const menus = new Map<string, Row[]>();
vi.mock('../ui', async (orig) => {
  const real = await orig<typeof import('../ui')>();
  const { createElement: h } = await import('react');
  return {
    ...real,
    // drawn open, its rows as list items, so the test reads them as the menu would show them
    Menu: ({ items, trigger }: { items: Row[]; trigger: (p: Record<string, unknown>) => ReactNode }) => {
      const t = renderToStaticMarkup(h('div', null, trigger({ onClick() {}, 'aria-haspopup': 'menu' })));
      menus.set(/aria-label="([^"]*)"/.exec(t)?.[1] ?? '', items);
      return h('ul', null, items.map((i, n) => (i === 'separator' ? h('hr', { key: n }) : h('li', { key: n }, i.label))));
    },
  };
});

describe('the account menu', async () => {
  beforeAll(() => { (globalThis as { window?: unknown }).window ??= { addEventListener() {}, removeEventListener() {}, open() {} }; });
  const { mockCloudView } = await import('../../dev/mockCloud');
  const { Sidebar } = await import('./Sidebar');
  const account = (state: Parameters<typeof mockCloudView>[0]) => {
    const view = mockCloudView(state);
    Object.assign(cloudState, { view, supported: true });
    renderToStaticMarkup(createElement(Sidebar));
    const who = view.account?.name ?? view.account?.email;
    const rows = menus.get(`${who}, Settings`) ?? menus.get('Settings');
    expect(rows).toBeTruthy();
    return rows!;
  };
  const labels = (rows: Row[]) => rows.map((r) => (r === 'separator' ? '—' : r.label));

  it('has no row for the plan and how much of it is used', () => {
    const rows = labels(account('running'));
    expect(rows).not.toContain('Pro');
    expect(rows.join(' ')).not.toMatch(/% used|Starter|Free\b/);
    expect(rows[0]).toBe('Upgrade plan');
    expect(rows).toContain('Get AppuBot for mobile');
  });

  it('opens on the phone app where there is nothing to upgrade, with no line above it', () => {
    const rows = labels(account('team-member'));
    expect(rows[0]).toBe('Get AppuBot for mobile');
  });
});
