import { describe, expect, it } from 'vitest';
import { LAUNCH_GIFT, LAUNCH_POSTS, LAUNCH_POST_TEXT, LAUNCH_URL, giftCardOpensNow, giftEndsText, giftProgressText, launchPostText, launchPostUrl, nextGiftStep, randomLaunchPost } from './launchGift';
import { agentDisplayName, agentProfileLabel, giftModelName, isLaunchGift } from './providers';

const H = 3_600_000;

describe('the launch gift card', () => {
  it('never names the model, and the X post never asks for a vote', () => {
    expect(JSON.stringify(LAUNCH_GIFT) + LAUNCH_POSTS.join(' ')).not.toMatch(/haiku|sonnet|opus|fable/i);
    expect(LAUNCH_POSTS.join(' ')).not.toMatch(/upvot|vote/i);
    // the first step's ask is the owner's wording
    expect(LAUNCH_GIFT.launch.body).toMatch(/support the launch by upvoting and replying/);
  });

  it('has twenty posts of its own, each a whole post that says the launch, the gift and who', () => {
    expect(LAUNCH_POSTS).toHaveLength(20);
    expect(new Set(LAUNCH_POSTS).size).toBe(20);
    for (const post of LAUNCH_POSTS) {
      expect(post).toMatch(/Product Hunt/);
      expect(post).toMatch(/@AppuBot_/);
      expect(post).toMatch(/unlimited Claude/i);
      expect(post).toMatch(/24 hours/);
      // what X counts: the words, a space and a 23-character link (an emoji counts two)
      const length = [...post].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
      expect(length + 24).toBeLessThanOrEqual(280);
    }
  });

  it('picks one at random for a person, and the backend’s own words win', () => {
    expect(randomLaunchPost(() => 0)).toBe(0);
    expect(randomLaunchPost(() => 0.5)).toBe(10);
    expect(randomLaunchPost(() => 0.9999)).toBe(19);
    expect(randomLaunchPost(() => 1)).toBe(19);
    expect(launchPostText(undefined, 7)).toBe(LAUNCH_POSTS[7]);
    expect(launchPostText('  ', 27)).toBe(LAUNCH_POSTS[7]);
    expect(launchPostText(undefined, Number.NaN)).toBe(LAUNCH_POSTS[0]);
    expect(launchPostText(' Our own words ', 3)).toBe('Our own words');
  });

  it('writes the X post with the launch link, the backend’s words when it sends any', () => {
    const own = new URL(launchPostUrl(undefined, undefined));
    expect(own.origin + own.pathname).toBe('https://x.com/intent/post');
    expect(own.searchParams.get('text')).toBe(LAUNCH_POST_TEXT);
    expect(own.searchParams.get('url')).toBe(LAUNCH_URL);
    const sent = new URL(launchPostUrl('We are live & free!', 'https://www.producthunt.com/posts/appubot'));
    expect(sent.searchParams.get('text')).toBe('We are live & free!');
    expect(sent.searchParams.get('url')).toBe('https://www.producthunt.com/posts/appubot');
  });

  it('says when it ends, and what Start is doing', () => {
    const now = 1_000_000;
    expect(giftEndsText(undefined, now)).toBe('');
    expect(giftEndsText(now + 21 * H + 5, now)).toBe('Ends in 21 hours');
    expect(giftEndsText(now + H, now)).toBe('Ends in 1 hour');
    expect(giftEndsText(now + 40 * 60_000, now)).toBe('Ends in 40 minutes');
    expect(giftEndsText(now + 30_000, now)).toBe('Ends soon');
    expect(giftProgressText('install')).toMatch(/Setting up Claude/);
    expect(giftProgressText(undefined)).toMatch(/Getting your gift/);
  });

  it('goes launch, post, gift', () => {
    expect(nextGiftStep('launch')).toBe('post');
    expect(nextGiftStep('post')).toBe('gift');
    expect(nextGiftStep('gift')).toBe('gift');
  });

  it('opens by itself only on this computer, set up, in front, uncovered and not put away', () => {
    const ok = { state: 'offer' as const, onboarded: true, loaded: true, inFront: true, covered: false, thisComputer: true, putAway: false };
    expect(giftCardOpensNow(ok)).toBe(true);
    expect(giftCardOpensNow({ ...ok, state: 'over' })).toBe(true);
    for (const off of [{ state: undefined }, { onboarded: false }, { loaded: false }, { inFront: false }, { covered: true }, { thisComputer: false }, { putAway: true }, { state: 'on' as const }]) {
      expect(giftCardOpensNow({ ...ok, ...off })).toBe(false);
    }
    // Start running keeps it up whatever covers the window
    expect(giftCardOpensNow({ ...ok, state: 'starting', covered: true, inFront: false, putAway: true })).toBe(true);
  });
});

describe('the gift’s agent in the pickers', () => {
  const claude = { id: 'claude-code', name: 'Claude Code' };
  const gift = { id: 'claude-code@appubot-ai', name: 'Claude', profile: { of: 'claude-code', name: 'AppuBot Launch Gift', home: '/x', source: 'credit' as const } };
  const bonus = { id: 'claude-code@appubot-ai', name: 'AppuBot AI', profile: { of: 'claude-code', name: 'AppuBot AI', home: '/x', source: 'credit' as const } };

  it('is "Claude" under the profile "AppuBot Launch Gift", its model "Claude"', () => {
    expect(isLaunchGift(gift)).toBe(true);
    expect(agentProfileLabel(gift, [claude, gift])).toBe('AppuBot Launch Gift');
    expect(agentDisplayName(gift, [claude, gift])).toBe('Claude · AppuBot Launch Gift');
    expect(giftModelName(gift)).toBe('Claude');
  });

  it('leaves a plan’s AppuBot AI and every other agent as they were', () => {
    expect(isLaunchGift(bonus)).toBe(false);
    expect(agentProfileLabel(bonus, [claude, bonus])).toBe('');
    expect(agentDisplayName(bonus, [claude, bonus])).toBe('AppuBot AI');
    expect(giftModelName(bonus)).toBeUndefined();
    expect(giftModelName(claude)).toBeUndefined();
    expect(agentDisplayName(claude, [claude, bonus])).toBe('Claude Code');
  });
});
