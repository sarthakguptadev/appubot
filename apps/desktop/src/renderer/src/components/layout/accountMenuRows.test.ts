/**
 * The account menu (the sidebar foot's AccountButton) as it opens: no plan-and-usage row (the owner, 2026-11-28: "rm";
 * Settings › Usage shows it), Upgrade plan where there is one, and Get AppuBot for mobile opening a code to scan with
 * the App Store's and Google Play's badges.
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
    Dialog: ({ open, title, description, children }: { open: boolean; title?: ReactNode; description?: ReactNode; children?: ReactNode }) =>
      (open ? h('div', { role: 'dialog' }, h('h2', null, title), h('p', null, description), children) : null),
  };
});

describe('the account menu', async () => {
  beforeAll(() => { (globalThis as { window?: unknown }).window ??= { addEventListener() {}, removeEventListener() {}, open() {} }; });
  const { mockCloudView } = await import('../../dev/mockCloud');
  const { Sidebar } = await import('./Sidebar');
  const { getState, setState } = await import('../../lib/store');
  const { PhoneAppDialog } = await import('../../features/settings/PhoneApps');
  const { ANDROID_APP_URL, IOS_APP_URL, PHONE_DOWNLOAD_URL } = await import('../../lib/links');
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

  it('opens a code to scan and both stores from Get AppuBot for mobile', () => {
    const row = account('running').find((r): r is Exclude<Row, 'separator'> => r !== 'separator' && r.label === 'Get AppuBot for mobile')!;
    setState({ modal: null });
    row.onSelect();
    expect(getState().modal).toEqual({ kind: 'phone-app' });

    const html = renderToStaticMarkup(createElement(PhoneAppDialog, { open: true, onClose() {} }));
    expect(html).toContain('Scan with your phone’s camera');
    expect(html).toContain(`href="${IOS_APP_URL}"`);
    expect(html).toContain('aria-label="Download on the App Store"');
    expect(html).toContain(`href="${ANDROID_APP_URL.replace(/&/g, '&amp;')}"`);
    expect(html).toContain('aria-label="Get it on Google Play"');
    expect(html).toMatch(/app-store\.svg/);
    expect(html).toMatch(/google-play\.png/);
    expect(PHONE_DOWNLOAD_URL).toBe('https://appubot.com/download#phone');
  });
});
