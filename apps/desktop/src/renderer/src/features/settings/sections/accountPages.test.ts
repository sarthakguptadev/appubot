/**
 * Settings › Account, Billing and Team rendered over every mock account state (dev/mockCloud.ts): nothing throws, the
 * computer is never called "Cloud" by name, Free comes first among the plans with a paid plan highlighted, and what was
 * taken out of Settings (hours, wake history, Open desktop, Its bots, Refresh) stays out.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockCloudState } from '../../../dev/mockCloud';

// server rendering reads a zustand store's initial state, so the pages read this one instead
const cloudState: { view: unknown; supported: boolean; loading: boolean; busy: Record<string, true> } = { view: null, supported: true, loading: false, busy: {} };
vi.mock('../../cloud/cloudAccount', async (orig) => {
  const real = await orig<typeof import('../../cloud/cloudAccount')>();
  const useCloud = Object.assign(<T,>(sel: (s: typeof cloudState) => T): T => sel(cloudState), {
    getState: () => cloudState, setState: (p: Partial<typeof cloudState>) => Object.assign(cloudState, p), subscribe: () => () => {},
  });
  return { ...real, useCloud };
});

// this Mac's "Only in the cloud" (a zustand store too): read from here
const macChoice = { chosen: false };
vi.mock('../../cloud/cloudOnly', async (orig) => {
  const real = await orig<typeof import('../../cloud/cloudOnly')>();
  return { ...real, useCloudOnly: () => real.cloudOnlyOf(macChoice.chosen, cloudState.view as never, cloudState.supported) };
});

const STATES: MockCloudState[] = ['signed-out', 'no-plan', 'sold-out', 'provisioning', 'running', 'asleep', 'waking', 'on-hold', 'past-due', 'ending', 'scheduled', 'export-only', 'failed', 'suspended', 'team-admin', 'team-member', 'team-invite', 'personal-team'];
// "cloud computer" only as a name ("your cloud computer"): the plan cards say the site's "…on a cloud computer"
const GONE = /Awake this month|What woke it|Open desktop|Its bots|Show This|Refresh|AppuBot Cloud|(?:[Yy]our|[Tt]he|[Yy]our team’s) cloud computer|Cloud computer|Settings › Cloud/;
/** the page's words: no tags, no stylesheet (the plan cards carry the site's CSS) */
const words = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');

describe('account pages', async () => {
  beforeAll(() => { (globalThis as { window?: unknown }).window ??= { addEventListener() {}, removeEventListener() {} }; });
  const { mockCloudView } = await import('../../../dev/mockCloud');
  const { AccountSection } = await import('./Account');
  const { BillingSection } = await import('./Billing');
  const { TeamSection } = await import('./Team');
  const render = (state: MockCloudState, page: () => unknown): string => {
    Object.assign(cloudState, { view: mockCloudView(state), supported: true, busy: {} });
    return renderToStaticMarkup(createElement(page as never));
  };

  for (const state of STATES) {
    it(`renders ${state}`, () => {
      for (const page of [AccountSection, BillingSection, TeamSection]) {
        const html = words(render(state, page));
        expect(html, `${state} ${page.name}`).not.toMatch(GONE);
        if (page !== TeamSection) expect(html, `${state} ${page.name} rendered`).toMatch(/This (Mac|PC|computer)|Your plan/);
      }
    });
  }

  it('Billing: no plan shows the site-style cards, Pro highlighted, Free as a wide card under them', () => {
    // the mock keeps one team for the whole run: no plan and no team here
    Object.assign(cloudState, { view: { ...mockCloudView('no-plan'), teams: [] }, supported: true, busy: {} });
    const free = renderToStaticMarkup(createElement(BillingSection));
    const order = ['Starter plan', 'Pro plan', 'Max plan', 'Ultra plan', 'Free plan'].map((n) => free.indexOf(`aria-label="${n}"`));
    expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]!))).toBe(true);
    expect(free).toContain('Most popular');
    expect(free).toContain('Your AppuBot computer in the cloud');
    expect(free).toContain('Launch offer: higher Claude allowance');
    expect(free).toContain('2 months free');
    expect(free).toContain('Start a team');
    expect(free).not.toContain('Cancel plan');
  });

  it('Billing: each plan is a card with its tile, status, one action and its facts; no cards until asked', () => {
    const raw = render('personal-team', BillingSection);
    const paid = raw.replace(/<[^>]+>/g, ' ');
    expect(paid).toContain('Your plans');
    expect(paid).toMatch(/My Cloud Computer\s+Pro\s+Active/);
    expect(raw).not.toMatch(/alt="AppuBot"/); // a cloud tile on the person's own computer, not the app icon
    expect(paid).toContain('Acme');
    expect(paid).toContain('Change plan');
    expect(paid).toMatch(/\$49 \/ month/);
    expect(paid).toMatch(/\$49 \+ \d extra seats × \$20/);
    expect(paid).toMatch(/\d of \d used/);
    expect(paid).toMatch(/\$\d+ of \$\d+ used/);
    expect(paid).toContain('Payment method');
    expect(paid).toContain('Invoices and receipts');
    expect(paid).toContain('Acme’s payments');
    // already on a team, another can still be started (any number of Work plans)
    expect(paid).toContain('Start another team');
    // Cancel plan lives only in a plan card's ⋯ menu (closed here), no link at the bottom
    expect(paid).not.toContain('Cancel plan');
    expect(paid).not.toContain('Most popular');
    // a member sees the team without money actions
    const v = mockCloudView('team-admin');
    Object.assign(cloudState, { view: { ...v, teams: v.teams!.map((t) => ({ ...t, team: { ...t.team, role: 'member' as const, canManage: false } })) } });
    const member = renderToStaticMarkup(createElement(BillingSection)).replace(/<[^>]+>/g, ' ');
    expect(member).toContain('its admins handle the plan and billing');
    expect(member).toContain('Open Team');
    expect(member).not.toContain('Acme’s payments');
    expect(member).toContain('Your own AppuBot computer');
    expect(member).not.toContain('Most popular');
  });

  it('Billing: a failed payment, an ending plan and an invite each show their fix', () => {
    const due = render('past-due', BillingSection).replace(/<[^>]+>/g, ' ');
    expect(due).toContain('Payment failed');
    expect(due).toContain('Update card');
    expect(due).not.toContain('Save $');
    const ending = render('ending', BillingSection).replace(/<[^>]+>/g, ' ');
    expect(ending).toContain('Ending');
    expect(ending).toContain('Keep my plan');
    expect(ending).not.toContain('Cancel plan');
    const invite = render('team-invite', BillingSection).replace(/<[^>]+>/g, ' ');
    expect(invite).toMatch(/invited you to Acme/);
    expect(invite).toContain('Join Acme');
  });

  it('Account: the computers with their state, Manage only where it can be fixed', () => {
    const html = render('personal-team', AccountSection);
    expect(html).toContain('My Cloud Computer');
    expect(html).not.toContain('Download my bots');
    expect(html).toContain('Awake');
    expect(html).toContain('Acme');
    expect(html).toMatch(/This (Mac|PC|computer)/);
    // people can't delete their account themselves: no link, no row
    expect(html).not.toContain('Delete account');
    expect(html).not.toContain('Delete…');
  });

  it('Account: "Where your bots work" only for someone with a cloud computer that can work, or while it is on', async () => {
    macChoice.chosen = false;
    // the mock keeps one team for the whole run: the person's own computer alone here
    const alone = (state: MockCloudState) => {
      Object.assign(cloudState, { view: { ...mockCloudView(state), teams: [] }, supported: true, busy: {} });
      return renderToStaticMarkup(createElement(AccountSection));
    };
    for (const state of ['running', 'asleep', 'past-due', 'ending'] as const) expect(alone(state), state).toContain('Where your bots work');
    for (const state of ['signed-out', 'no-plan', 'provisioning', 'on-hold', 'export-only', 'suspended'] as const) expect(alone(state), state).not.toContain('Where your bots work');
    // a team's computer that can work counts too
    expect(render('team-member', AccountSection)).toContain('Where your bots work');
    const off = alone('running').replace(/<[^>]+>/g, ' ');
    expect(off).toMatch(/Only in the cloud/);
    expect(off).toMatch(/Free · bots here work while it’s awake/);
    // on: this computer's row says so; with the computer on hold the choice still shows, so it can be turned off
    macChoice.chosen = true;
    expect(alone('running').replace(/<[^>]+>/g, ' ')).toMatch(/Only in the cloud · its bots are paused here/);
    const held = alone('on-hold').replace(/<[^>]+>/g, ' ');
    expect(held).toContain('Where your bots work');
    expect(held).toMatch(/runs its bots as before/);
    macChoice.chosen = false;
  });

  it('Team: people, AI sign-ins for admins, the plan line', () => {
    const admin = render('team-admin', TeamSection);
    expect(admin).toContain('People');
    expect(admin).toContain('AI sign-ins');
    expect(admin).toContain('Invite people');
    expect(admin).toContain('Change seats');
    expect(admin).toContain('Danger zone');
    expect(admin).toContain('Cancel team plan');
    expect(admin).toContain('Pending');
    expect(admin).toContain('role="radiogroup"');
    // a member: the same team, read-only (the mock keeps one team for the whole run)
    const v = mockCloudView('team-admin');
    const asMember = { ...v, teams: v.teams!.map((t) => ({ ...t, team: { ...t.team, role: 'member' as const, canManage: false } })) };
    Object.assign(cloudState, { view: asMember });
    const member = renderToStaticMarkup(createElement(TeamSection));
    expect(member).not.toContain('Invite people');
    expect(member).not.toContain('Change seats');
    expect(member).not.toContain('Cancel team plan');
    expect(member).toContain('Leave team');
    expect(member).toContain('An admin chooses this for the team.');
  });
});
