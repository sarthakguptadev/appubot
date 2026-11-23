/**
 * THE paywall (the landing page's PlanCards): what every surface draws from `paywallView` says what the site says.
 */
import { describe, expect, it } from 'vitest';
import type { CloudCatalog, CloudShape } from '@appubot/protocol';
import { CREDIT_BONUS_NOTE, FREE_CARD, CUSTOM_CARD, PAYWALL_BREAKPOINTS, paywallCss, paywallView, stepPeople, trialBadge, trialCtaYour, trialDaysOf, trialNote, trialPriceOf, trialThen, trialTry } from './paywall';

const price = (cents: number, interval: 'month' | 'year') => ({ amount: cents, currency: 'USD', display: `$${(cents / 100).toLocaleString('en-US')}`, interval, taxInclusive: false });
const shape = (cpu: number, memory: number, disk: number): CloudShape => ({ cpu, memory, disk });
const work = (id: 'team' | 'business' | 'scale', name: string, base: number, s: CloudShape, maxMembers: number) => ({
  id, name, blurb: `${name} blurb`, shape: s, minMembers: 2, maxMembers,
  base: { monthly: price(base * 100, 'month'), yearly: price(base * 1000, 'year') },
  perMember: { monthly: price(2000, 'month'), yearly: price(20000, 'year') },
});
const CATALOG: CloudCatalog = {
  plans: [
    { id: 'starter', name: 'Starter', blurb: 'Starter blurb', shape: shape(2, 4, 12), monthly: price(1900, 'month'), yearly: price(19000, 'year') },
    { id: 'pro', name: 'Pro', blurb: 'Pro blurb', shape: shape(4, 8, 20), monthly: price(4900, 'month'), yearly: price(49000, 'year') },
    { id: 'max', name: 'Max', blurb: 'Max blurb', shape: shape(4, 16, 40), monthly: price(7900, 'month'), yearly: price(79000, 'year') },
    { id: 'ultra', name: 'Ultra', blurb: 'Ultra blurb', shape: shape(4, 32, 80), monthly: price(10900, 'month'), yearly: price(109000, 'year') },
  ],
  work: {
    plans: [work('team', 'Team', 49, shape(4, 8, 20), 5), work('business', 'Business', 79, shape(4, 16, 40), 15), work('scale', 'Scale', 109, shape(4, 32, 80), 30)],
    members: { min: 2, max: 30, default: 5 },
  },
  asOf: 0,
};
const buy = (o: Partial<Parameters<typeof paywallView>[1]> = {}) => paywallView(CATALOG, { mode: 'buy', kind: 'personal', interval: 'monthly', members: 2, ...o });

describe('the paywall', () => {
  it('Personal: Starter, Pro (most popular), Max and Ultra, four in a row, specs RAM first; Free as a wide card under them', () => {
    const v = buy();
    expect(v).toMatchObject({ kind: 'personal', free: true, custom: false, columns: 4, showKinds: true, showStepper: true, people: 1, intervals: ['monthly', 'yearly'] });
    expect(v.cells.map((c) => c.name)).toEqual(['Starter', 'Pro', 'Max', 'Ultra']);
    const pro = v.cells[1]!;
    expect(pro).toMatchObject({ price: '$49', per: '/ month', struck: '', sub: 'Billed monthly', highlight: true, badge: { text: 'Most popular', tone: 'accent' } });
    expect(pro.button).toEqual({ label: 'Choose Pro', aria: 'Choose Pro', primary: true, disabled: false });
    expect(v.cells[0]!.button.primary).toBe(false);
    expect(pro.rows.map((r) => r.text)).toEqual([
      '8 GB memory · 4 vCPU', '20 GB storage', 'Sleeps when idle, wakes in seconds', 'No hour limits',
      'Launch offer: higher Claude allowance', 'Unlimited bots, about 8 working at once', 'Phone and desktop apps',
    ]);
    expect(FREE_CARD).toMatchObject({ price: '$0', per: '/ forever', sub: 'On your own computer' });
  });

  it('a first plan’s free trial: every button starts it, the line under the price says what follows, a plan change says nothing of it', () => {
    const v = buy({ trialDays: 3 });
    expect(v.trialDays).toBe(3);
    expect(v.cells.map((c) => c.button.label)).toEqual(Array(4).fill('Start 3-day free trial'));
    expect(v.cells[1]).toMatchObject({ price: '$49', sub: '3 days free, then billed monthly' });
    expect(v.cells[1]!.button).toMatchObject({ aria: 'Start 3-day free trial of Pro', primary: true });
    expect(buy({ trialDays: 3, interval: 'yearly' }).cells[1]!.sub).toBe('3 days free, then billed yearly');
    const team = buy({ trialDays: 3, kind: 'work', members: 8 });
    expect(team.cells.map((c) => c.button.label)).toEqual(['Up to 5 members', 'Start 3-day free trial', 'Start 3-day free trial']);
    expect(team.cells[1]!.button.aria).toBe('Start 3-day free trial of Business for 8 members');
    const change = paywallView(CATALOG, { mode: 'personal', kind: 'personal', interval: 'monthly', members: 2, current: { plan: 'pro', interval: 'monthly' }, trialDays: 3 });
    expect(change.trialDays).toBe(0);
    expect(change.cells.map((c) => c.button.label)).toEqual(['Downgrade to Starter', 'Your plan', 'Upgrade to Max', 'Upgrade to Ultra']);
    expect(change.cells[1]!.sub).toBe('Billed monthly');
    expect(buy({ trialDays: 0 }).cells[1]!.button.label).toBe('Choose Pro');
  });

  it('who is offered the trial: a signed-in person by their account, anyone else by the catalog', () => {
    expect(trialDaysOf({ trialDays: 3 })).toBe(3);
    expect(trialDaysOf({ trialDays: 3 }, { trialDays: 0 })).toBe(0);
    expect(trialDaysOf({ trialDays: 3 }, {})).toBe(0);
    expect(trialDaysOf({}, { trialDays: 3 })).toBe(3);
    expect(trialDaysOf(null)).toBe(0);
    expect(trialCtaYour(3)).toBe('Start your 3-day free trial');
    expect(trialTry(3)).toBe('Try free for 3 days');
    expect(trialThen(3, '$49', '/ month')).toBe('3 days free, then $49 / month');
    expect(trialNote(3)).toContain('cancelling before then costs nothing');
  });

  // 2026-11-19: the backend may charge for the trial's days ($1). Nothing says "free" then
  it('a trial that costs something says what, on every wording', () => {
    expect(trialPriceOf({ trialPrice: { amount: 100, currency: 'USD', display: '$1', interval: 'once', taxInclusive: false } })).toBe('$1');
    expect(trialPriceOf({})).toBeUndefined();
    expect(trialPriceOf(null)).toBeUndefined();
    expect(trialCtaYour(3, '$1')).toBe('Start your 3-day trial for $1');
    expect(trialTry(3, '$1')).toBe('Try 3 days for $1');
    expect(trialThen(3, '$49', '/ month', '$1')).toBe('3 days for $1, then $49 / month');
    expect(trialNote(3, '$1')).toContain('The $1 is charged when you start');
    expect(trialNote(3, '$1')).not.toContain('free');
    expect(trialBadge('$1')).toBe('Trial');
    expect(trialBadge()).toBe('Free trial');
    const v = paywallView(CATALOG, { mode: 'buy', kind: 'personal', interval: 'monthly', members: 2, trialDays: 3, trialPrice: '$1' });
    expect(v.trialPrice).toBe('$1');
    expect(v.cells[1]!.button.label).toBe('Start 3-day trial for $1');
    expect(v.cells[1]!.sub).toBe('3 days for $1, then billed monthly');
    // someone changing a plan is offered no trial, so no price of one either
    expect(paywallView(CATALOG, { mode: 'personal', kind: 'personal', interval: 'monthly', members: 2, current: { plan: 'pro', interval: 'monthly' }, trialDays: 3, trialPrice: '$1' }).trialPrice).toBeUndefined();
  });

  it('Yearly: the year’s price, twelve months struck through, the month it comes to', () => {
    const pro = buy({ interval: 'yearly' }).cells[1]!;
    expect(pro).toMatchObject({ price: '$490', per: '/ year', struck: '$588', sub: '$40.83 a month, billed yearly' });
  });

  it('Work: Team, Business, Scale (best value) and Custom; "Up to N members" on the button only when the team is bigger', () => {
    const at5 = buy({ kind: 'work', members: 5 });
    expect(at5).toMatchObject({ kind: 'work', free: false, custom: true, columns: 4, people: 5 });
    expect(at5.cells.map((c) => [c.name, c.price, c.off, c.button.label])).toEqual([
      ['Team', '$129', false, 'Choose Team'], ['Business', '$159', false, 'Choose Business'], ['Scale', '$189', false, 'Choose Scale'],
    ]);
    expect(at5.cells[2]).toMatchObject({ highlight: true, badge: { text: 'Best value' } });
    expect(at5.cells[0]!.button.aria).toBe('Choose Team for 5 members');
    expect(at5.cells[0]!.rows.map((r) => r.text)).toContain('Up to 5 members');
    expect(at5.cells[0]!.rows.map((r) => r.text)).toContain('$49 + $20 per extra member');
    const at12 = buy({ kind: 'work', members: 12 });
    expect(at12.cells[0]).toMatchObject({ off: true, button: { label: 'Up to 5 members', disabled: true, primary: false } });
    expect(at12.cells[1]).toMatchObject({ off: false, price: '$299', button: { label: 'Choose Business', disabled: false } });
    expect(CUSTOM_CARD).toMatchObject({ price: 'Let\'s talk', sub: 'Priced for your team', talk: 'Talk to us', email: 'Email us' });
  });

  it('the stepper: past 1 person it moves to Work at 2, below 2 back to Personal; a team stays a team', () => {
    expect(stepPeople('buy', 'personal', 2)).toEqual({ kind: 'work', members: 2 });
    expect(stepPeople('buy', 'work', 1)).toEqual({ kind: 'personal' });
    expect(stepPeople('buy', 'work', 31)).toEqual({ kind: 'work', members: 30 });
    expect(stepPeople('team', 'work', 1)).toEqual({ kind: 'work', members: 2 });
  });

  it('someone on a plan: theirs marked, the rest Upgrade / Downgrade / Switch to yearly; no Free, no switch', () => {
    const v = paywallView(CATALOG, { mode: 'personal', kind: 'personal', interval: 'monthly', members: 2, current: { plan: 'pro', interval: 'monthly' } });
    expect(v).toMatchObject({ free: false, showKinds: false, showStepper: false, columns: 4 });
    expect(v.cells.map((c) => c.button.label)).toEqual(['Downgrade to Starter', 'Your plan', 'Upgrade to Max', 'Upgrade to Ultra']);
    expect(v.cells[1]).toMatchObject({ current: true, highlight: true, badge: { text: 'Current plan' }, button: { disabled: true } });
    expect(v.cells[2]!.button.primary).toBe(true);
    const yearly = paywallView(CATALOG, { mode: 'personal', kind: 'personal', interval: 'yearly', members: 2, current: { plan: 'pro', interval: 'monthly' } });
    expect(yearly.cells[1]!.button).toMatchObject({ label: 'Switch to yearly', primary: true, disabled: false });
  });

  it('sold out: nothing can be chosen', () => {
    expect(buy({ soldOut: true }).cells.every((c) => c.button.disabled)).toBe(true);
  });

  it('the CSS: one row down to a 900px window, a sideways row on tablets, one column on phones, never 2×2', () => {
    const css = paywallCss({ light: '.light', dark: '.dark' });
    const b = PAYWALL_BREAKPOINTS;
    expect(b.row).toBe(868); // a 900px window less the site's 16px a side
    // the site's and account pages' row from the tablet edge up (the scroll rules below override it until `row`)
    expect(css).toContain(`@container (min-width:${b.stack}px){\n.pw:not([data-row]) .pw-cols[data-cols="4"]{grid-template-columns:repeat(4,minmax(0,1fr))}`);
    expect(css).toContain(`@container (min-width:${b.stack}px) and (max-width:${b.row - 0.02}px){\n.pw:not([data-row]) .pw-grid{overflow-x:auto`);
    expect(css).toMatch(/scroll-snap-type:x mandatory/);
    // the desktop's one-row mode: four across at every width
    expect(css).toMatch(/\n\.pw\[data-row\] \.pw-cols\[data-cols="4"\]\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)\}/);
    // nothing anywhere steps down to two columns of four cards
    expect(css).not.toMatch(/\.pw-cols\[data-cols="4"\]\{grid-template-columns:repeat\(2/);
    // shrinking, not wrapping, between `row` and `full`
    expect(css).toContain(`@container (min-width:${b.stack}px) and (max-width:${b.full - 0.02}px){\n.pw:not([data-row]) .pw-seg`);
    expect(css).toContain(`@container (min-width:${b.row}px) and (max-width:${b.tight - 0.02}px){\n.pw:not([data-row]) .pw-cell{padding:16px 12px}`);
    expect(CREDIT_BONUS_NOTE).toMatch(/launch offer for a limited time/);
    expect(buy().cells.map((c) => c.rows[4]!.text)).toEqual(['Launch offer: generous Claude allowance', 'Launch offer: higher Claude allowance', 'Launch offer: much higher Claude allowance', 'Launch offer: highest Claude allowance']);
    expect(buy({ kind: 'work', members: 5 }).cells.map((c) => c.rows[4]!.text)).toEqual(['Launch offer: generous Claude allowance, shared', 'Launch offer: higher Claude allowance, shared', 'Launch offer: highest Claude allowance, shared']);
  });
});
