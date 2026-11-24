import { describe, expect, it } from 'vitest';
import { agentDisplayName, agentProfileLabel } from './providers';
import {
  botLoginsText, cloudNoticeTitle, cloudStateText, cloudStateTitle, formatHours, intervalText, moneyText, planTitle, priceText, scheduledChangeText, shapeShort, shapeText, shortDate, skippedRoutinesText, seatDropOffer, teamLoginsText, TEAM_LOGINS_OPTIONS, creditAmount, creditFraction, creditLine, creditNotice, isAppubotAi, teamTint, TEAM_TINTS, computerDisplayName, possessive, firstName, macDisplayName, ADD_COMPUTER_LABEL, computerNameSteps } from './cloud';
import { APP_MARK, appMarkEyeWidth } from './appMark';

const H = 3600;
const now = Date.UTC(2026, 10, 10, 12);
const dec3 = Date.UTC(2026, 11, 3, 0, 30);

describe('plans', () => {
  it('words a shape and a price', () => {
    expect(shapeText({ cpu: 4, memory: 8, disk: 20 })).toBe('8 GB RAM · 4 vCPU · 20 GB disk');
    expect(shapeShort({ cpu: 2, memory: 4 })).toBe('4 GB / 2 vCPU');
    expect(priceText({ amount: 4900, currency: 'USD', display: '$49', interval: 'month', taxInclusive: false })).toBe('$49 a month');
    expect(priceText({ amount: 49000, currency: 'USD', display: '$490', interval: 'year', taxInclusive: false })).toBe('$490 a year');
    expect(intervalText({ interval: 'once' })).toBe('');
    expect(planTitle('Pro', 'yearly')).toBe('Pro · Yearly');
  });
  it('groups thousands in money, keeping cents and the currency', () => {
    expect(moneyText(7900, 'USD')).toBe('$79');
    expect(moneyText(1250, 'USD')).toBe('$12.50');
    expect(moneyText(304000, 'USD')).toBe('$3,040');
    expect(moneyText(123456789, 'USD')).toBe('$1,234,567.89');
    expect(moneyText(12345600, 'INR')).toBe('₹123,456');
    expect(moneyText(1500, 'JPY')).toBe('¥1,500');
    expect(moneyText(250000, 'CHF')).toBe('2,500 CHF');
  });
  it('says when a scheduled change lands', () => {
    expect(scheduledChangeText('Starter', 'monthly', dec3, now)).toBe(`Changes to Starter · Monthly on ${shortDate(dec3, now)}`);
  });
});

describe('the awake line', () => {
  it('formats hours with one decimal at most', () => {
    expect(formatHours(37.5 * H)).toBe('37.5');
    expect(formatHours(100 * H)).toBe('100');
    expect(formatHours(0.26 * H)).toBe('0.3');
    expect(formatHours(-5)).toBe('0');
  });
  it('dates read as a day and month, with the year only when it differs', () => {
    expect(shortDate(dec3, now, 'en-GB')).toBe('3 Dec');
    expect(shortDate(Date.UTC(2027, 0, 3, 12), now, 'en-GB')).toBe('3 Jan 2027');
  });
});

describe('the computer’s state', () => {
  it('explains each state, and nothing while ok', () => {
    expect(cloudStateText('ok')).toBe('');
    expect(cloudStateText('on-hold')).toMatch(/payment/);
    expect(cloudStateText('export-only')).toMatch(/one day, then deleted/);
    expect(cloudStateText('export-only')).not.toMatch(/download/i);
    expect(cloudStateTitle('on-hold')).toBe('Payment on hold');
    expect(cloudStateTitle('export-only')).toBe('Plan ended');
    expect(cloudStateTitle('ok')).toBe('');
  });

  it('lists skipped routines once', () => {
    expect(skippedRoutinesText([])).toBe('');
    expect(skippedRoutinesText(['Morning brief'])).toBe('A routine didn’t run while your AppuBot computer was paused: “Morning brief”. It runs again on schedule from now.');
    expect(skippedRoutinesText(['A', 'B', 'A'])).toMatch(/^2 routines didn’t run .*“A”, “B”\. They run again/);
    expect(skippedRoutinesText(['1', '2', '3', '4', '5', '6', '7', '8'])).toMatch(/and 2 more/);
  });

  it('titles a cloud bot’s notice by kind', () => {
    expect(cloudNoticeTitle('done', 'Ada')).toBe('Ada finished');
    expect(cloudNoticeTitle('needs-you', 'Ada')).toBe('Ada needs you');
    expect(cloudNoticeTitle('failed', 'Ada')).toBe('Ada couldn’t finish');
  });
});

describe('seatDropOffer (removing someone also drops their seat)', () => {
  const work = [{ id: 'team' as const, base: { monthly: { amount: 2900, currency: 'USD', display: '$29', interval: 'month' as const, taxInclusive: false } }, perMember: { monthly: { amount: 2000, currency: 'USD', display: '$20', interval: 'month' as const, taxInclusive: false } } }];
  const at = Date.UTC(2026, 10, 13, 12);
  const now = Date.UTC(2026, 10, 4, 12);
  const sub = { status: 'active' as const, plan: 'team' as const, interval: 'monthly' as const, periodStart: now - 10 * 86_400_000, periodEnd: at, cancelAtPeriodEnd: false, seats: 5 };
  it('offers one seat fewer at the renewal with the new price', () => {
    const o = seatDropOffer({ seats: 5, used: 4, minMembers: 2, subscription: sub }, work, now);
    expect(o).toMatchObject({ offer: true, from: 5, to: 4, at, text: `5 → 4 seats: $89 a month from ${shortDate(at, now)}` });
  });
  it('says the seats without a price where none is shown (the phone)', () => {
    expect(seatDropOffer({ seats: 5, used: 4, minMembers: 2, subscription: sub }, null, now).text).toBe(`5 → 4 seats from ${shortDate(at, now)}`);
  });
  it('builds on a change already waiting', () => {
    const o = seatDropOffer({ seats: 5, scheduledSeats: 4, used: 3, minMembers: 2, subscription: { ...sub, scheduledChange: { plan: 'team', interval: 'monthly', at, seats: 4 } } }, work, now);
    expect(o).toMatchObject({ offer: true, from: 4, to: 3, text: `4 → 3 seats: $69 a month from ${shortDate(at, now)}` });
  });
  it('is not offered at the minimum, below the people and invites left, or while the plan can’t change', () => {
    expect(seatDropOffer({ seats: 2, used: 2, minMembers: 2, subscription: { ...sub, seats: 2 } }, work, now)).toMatchObject({ offer: false, reason: 'A team keeps at least 2 seats.' });
    expect(seatDropOffer({ seats: 5, used: 6, minMembers: 2, subscription: sub }, work, now)).toMatchObject({ offer: false, reason: 'The other 5 seats are in use (people and open invites).' });
    expect(seatDropOffer({ seats: 5, used: 4, minMembers: 2, subscription: { ...sub, status: 'past_due' } }, work, now).offer).toBe(false);
    expect(seatDropOffer({ seats: 5, used: 4, minMembers: 2, subscription: { ...sub, cancelAtPeriodEnd: true } }, work, now).offer).toBe(false);
    expect(seatDropOffer({ seats: 5, used: 4, minMembers: 2 }, work, now).offer).toBe(false);
  });
});

describe('team logins (§6.11)', () => {
  it('names the setting and whose logins a bot uses', () => {
    expect(TEAM_LOGINS_OPTIONS.map((o) => o.id)).toEqual(['own', 'shared']);
    expect(teamLoginsText('own')).toBe('Each person uses their own');
    expect(teamLoginsText('shared')).toBe('Shared for the whole team');
    expect(botLoginsText('own', { email: 'ada@acme.com' })).toBe('Uses ada@acme.com’s logins');
    expect(botLoginsText('own')).toBe('Uses no one’s logins yet');
    expect(botLoginsText('shared', { email: 'ada@acme.com' })).toBe('Uses the team’s logins');
  });
});

describe('included Claude credit (§6.13)', () => {
  const now = Date.parse('2026-11-05T10:00:00Z');
  const credit = { budgetCents: 1200, usedCents: 735, currency: 'USD', resetsAt: Date.parse('2026-12-05T10:00:00Z'), exhausted: false };
  it('says the month in whole dollars, as a launch bonus', () => {
    expect(creditLine(credit, now, 'en-US')).toBe('Claude launch bonus: $7 of $12 used, resets on Dec 5');
    expect(creditAmount(credit)).toBe('$7 of $12 used');
    // never a cent, and never "$12 of $12" before it is really spent
    expect(creditAmount({ ...credit, usedCents: 1199 })).toBe('$11 of $12 used');
    expect(creditAmount({ ...credit, budgetCents: 2725 })).toBe('$7 of $27 used');
    expect(creditFraction(credit)).toBeCloseTo(0.6125, 3);
  });
  it('used up: says so, caps the amount, the fraction is full, the notice is short', () => {
    const out = { ...credit, usedCents: 1231, exhausted: true };
    expect(creditLine(out, now, 'en-US')).toBe('Claude launch bonus: $12 used up, resets on Dec 5');
    expect(creditFraction(out)).toBe(1);
    expect(creditNotice(out, now, 'en-US')).toEqual({ title: 'This month’s launch bonus is used up', detail: 'Sign in with your own account to keep going, or wait until Dec 5.' });
  });
  it('ended: the bonus is over for everyone', () => {
    const ended = { ...credit, exhausted: true, ended: true };
    expect(creditLine(ended, now, 'en-US')).toBe('Claude launch bonus: ended');
    expect(creditAmount(ended)).toBe('Ended');
    expect(creditFraction(ended)).toBe(1);
    expect(creditNotice(ended, now, 'en-US').title).toBe('The launch bonus has ended');
  });
  it('names the AppuBot AI agent as its own, not a Claude Code profile', () => {
    expect(isAppubotAi('claude-code@appubot-ai')).toBe(true);
    expect(isAppubotAi('claude-code')).toBe(false);
    const ai = { id: 'claude-code@appubot-ai', name: 'AppuBot AI', profile: { of: 'claude-code', name: 'AppuBot AI', home: '/x', source: 'credit' as const } };
    const claude = { id: 'claude-code', name: 'Claude Code' };
    expect(agentDisplayName(ai, [ai, claude])).toBe('AppuBot AI');
    expect(agentProfileLabel(ai, [ai, claude])).toBe('');
    // the built-in isn't "Claude Code · Main" because of it
    expect(agentDisplayName(claude, [ai, claude])).toBe('Claude Code');
  });
});

describe('team tiles', () => {
  it('gives a team one colour wherever its name is written, never the app’s orange', () => {
    expect(teamTint('Acme')).toBe(teamTint(' acme '));
    expect(teamTint('Acme')).toBe(teamTint(computerDisplayName({ team: 'Acme' })));
    expect(teamTint('Bots')).toBe(teamTint(computerDisplayName({ team: 'Bots' })));
    expect(teamTint('Acme')).toBe(teamTint('Acme Cloud'));
    expect(teamTint('Acme')).toBe(teamTint('Acme’s Computer'));
    expect(TEAM_TINTS).toContain(teamTint('Northwind'));
    // no hue near the app icon's orange (~28°): reds through ambers would read as the person's own orange tile
    const hue = (hex: string) => {
      const n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
      const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
      if (!d) return -1;
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    for (const t of TEAM_TINTS) { const h = hue(t); expect(h < 0 || (h > 60 && h < 340)).toBe(true); }
  });
  it('draws the mark’s eyes bolder on small tiles', () => {
    expect(appMarkEyeWidth(16)).toBe(APP_MARK.eyeWidthSmall);
    expect(appMarkEyeWidth(40)).toBe(APP_MARK.eyeWidth);
  });
});

describe('computerDisplayName', () => {
  it('names a person’s own computer from their first name, a cloud computer', () => {
    expect(computerDisplayName({ person: 'Sarthak Gupta' })).toBe('Sarthak’s Cloud Computer');
    expect(computerDisplayName({ person: '  Ada ' })).toBe('Ada’s Cloud Computer');
    expect(computerDisplayName({ person: 'James' })).toBe('James’ Cloud Computer');
    expect(computerDisplayName({ person: '' })).toBe('My Cloud Computer');
    expect(computerDisplayName({ person: undefined })).toBe('My Cloud Computer');
    expect(computerDisplayName({ person: null })).toBe('My Cloud Computer');
  });
  it('names a team’s computer from the team’s name, without a possessive or a doubled Cloud', () => {
    expect(computerDisplayName({ team: 'Acme' })).toBe('Acme Cloud Computer');
    expect(computerDisplayName({ team: ' Acme Corp ' })).toBe('Acme Corp Cloud Computer');
    expect(computerDisplayName({ team: 'Bots' })).toBe('Bots Cloud Computer');
    expect(computerDisplayName({ team: 'Acme Cloud' })).toBe('Acme Cloud Computer');
    expect(computerDisplayName({ team: '' })).toBe('Team Cloud Computer');
    expect(computerDisplayName({ team: undefined })).toBe('Team Cloud Computer');
  });
  it('writes possessives and first names', () => {
    expect(possessive('Sarthak')).toBe('Sarthak’s');
    expect(possessive('Chris')).toBe('Chris’');
    expect(firstName('Sarthak Gupta')).toBe('Sarthak');
    expect(firstName(undefined)).toBe('');
  });
  it('offers a cloud computer to someone without one', () => {
    expect(ADD_COMPUTER_LABEL).toBe('Add a cloud computer');
  });
});

describe('macDisplayName', () => {
  it('keeps a Mac’s own name as Finder shows it', () => {
    expect(macDisplayName('Sarthak’s MacBook Pro', 'This Mac')).toBe('Sarthak’s MacBook Pro');
    expect(macDisplayName('  Studio  ', 'This Mac')).toBe('Studio');
  });
  it('makes a bare host name readable, and nothing the fallback', () => {
    expect(macDisplayName('Sarthaks-MacBook-Pro.local', 'This Mac')).toBe('Sarthaks MacBook Pro');
    expect(macDisplayName('DESKTOP-4F2K9', 'This PC')).toBe('DESKTOP 4F2K9');
    expect(macDisplayName('build-box.lan', 'This computer')).toBe('build box');
    expect(macDisplayName('', 'This Mac')).toBe('This Mac');
    expect(macDisplayName(undefined, 'This Mac')).toBe('This Mac');
    expect(macDisplayName('.local', 'This Mac')).toBe('This Mac');
  });
});

describe('computerNameSteps', () => {
  it('drops "Computer" from a cloud computer, then the name: "Cloud" alone before anything is cut off', () => {
    expect(computerNameSteps('Sarthak’s Cloud Computer')).toEqual(['Sarthak’s Cloud Computer', 'Sarthak’s Cloud', 'Cloud']);
    expect(computerNameSteps('Acme Cloud Computer')).toEqual(['Acme Cloud Computer', 'Acme Cloud', 'Cloud']);
    expect(computerNameSteps('My Cloud Computer')).toEqual(['My Cloud Computer', 'My Cloud', 'Cloud']);
  });
  it('drops the owner from a Mac or PC named for them', () => {
    expect(computerNameSteps('Sarthak’s MacBook Pro')).toEqual(['Sarthak’s MacBook Pro', 'MacBook Pro', 'MacBook', 'Mac']);
    expect(computerNameSteps("James' PC")).toEqual(["James' PC", 'PC']);
    expect(computerNameSteps('James’ Mac mini')).toEqual(['James’ Mac mini', 'Mac mini', 'Mac']);
    expect(computerNameSteps('Sarthaks MacBook Pro')).toEqual(['Sarthaks MacBook Pro', 'MacBook Pro', 'MacBook', 'Mac']);
    expect(computerNameSteps('MacBook Air')).toEqual(['MacBook Air', 'MacBook', 'Mac']);
  });
  it('leaves other names as they are', () => {
    expect(computerNameSteps('Studio')).toEqual(['Studio']);
    expect(computerNameSteps('Atlas MacBook')).toEqual(['Atlas MacBook']);
    expect(computerNameSteps('Bills Desk')).toEqual(['Bills Desk']);
    expect(computerNameSteps('This Mac')).toEqual(['This Mac']);
  });
});
