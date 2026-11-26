import { describe, expect, it } from 'vitest';
import { eligibleSuggestions, pickPills, pickSuggestions, suggestionCount, SUGGESTIONS_BESIDE_FOLLOW_UPS, SUGGESTIONS_MAX, SUGGESTIONS_MIN, type SuggestionFacts } from './suggestions';

const NEW: SuggestionFacts = {
  botName: 'Appu', bots: 1, routines: 0, groups: 0, phonePaired: false, telegram: false, appsSignedIn: false,
  apps: [], computerUse: true, voice: true, teach: true, cloudOffer: true, memory: false,
};
const DONE: SuggestionFacts = {
  botName: 'Appu', bots: 5, routines: 2, groups: 1, phonePaired: true, telegram: true, appsSignedIn: true,
  apps: ['gmail', 'googlecalendar'], computerUse: false, voice: false, teach: false, cloudOffer: false, memory: true,
};
const ids = (f: SuggestionFacts) => eligibleSuggestions(f).map((s) => s.id);

describe('suggestions', () => {
  it('offers what a new person hasn’t done', () => {
    expect(ids(NEW)).toEqual(expect.arrayContaining(['morning', 'apps', 'phone', 'telegram', 'voice', 'teach', 'import', 'cloud']));
    expect(ids(NEW)).not.toContain('inbox');
    expect(ids(NEW)).not.toContain('group');
  });

  it('drops what is done, and asks about the apps that are there', () => {
    const got = ids(DONE);
    for (const done of ['morning', 'apps', 'phone', 'telegram', 'import', 'cloud', 'group', 'inbox-bot']) expect(got).not.toContain(done);
    expect(got).toEqual(expect.arrayContaining(['inbox', 'calendar', 'remember']));
  });

  it('says nothing about a fact it doesn’t know', () => {
    const got = ids({ botName: 'Appu', bots: 3, routines: 1 });
    for (const unknown of ['apps', 'phone', 'telegram', 'voice', 'teach', 'group', 'cloud']) expect(got).not.toContain(unknown);
  });

  it('is the same for one reply and asks come first', () => {
    const a = pickSuggestions(NEW, 'msg-1');
    expect(pickSuggestions(NEW, 'msg-1')).toEqual(a);
    expect(a.length).toBe(SUGGESTIONS_MAX);
    const kinds = a.map((s) => s.kind);
    expect(kinds.indexOf('setup')).toBeGreaterThan(kinds.lastIndexOf('ask'));
    expect(kinds.filter((k) => k === 'ask').length).toBeGreaterThanOrEqual(2);
  });

  it('changes between replies', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) seen.add(pickSuggestions(NEW, `msg-${i}`).map((s) => s.id).join());
    expect(seen.size).toBeGreaterThan(5);
  });

  it('keeps room, hides what was put away and never picks one idea twice', () => {
    expect(pickSuggestions(NEW, 'x', 2)).toHaveLength(2);
    expect(pickSuggestions(NEW, 'x', 0)).toEqual([]);
    const hide = new Set(eligibleSuggestions(NEW).map((s) => s.id).filter((id) => id !== 'phone'));
    expect(pickSuggestions(NEW, 'x', 5, hide).map((s) => s.id)).toEqual(['phone']);
    const twoBots = { ...NEW, bots: 2 };
    for (let i = 0; i < 40; i++) {
      const got = pickSuggestions(twoBots, `s${i}`, 8).map((s) => s.id);
      expect(got.includes('group') && got.includes('team-ask')).toBe(false);
    }
  });

  it('offers "Connect email & calendar" only while neither is connected, whichever bot they are on for', () => {
    const signedIn = { ...NEW, appsSignedIn: true };
    expect(ids({ ...signedIn, apps: [], connected: [] })).toContain('apps');
    expect(ids({ ...signedIn, apps: ['slack'], connected: ['slack'] })).toContain('apps');
    // connected, but switched off for this bot
    expect(ids({ ...signedIn, apps: [], connected: ['gmail'] })).not.toContain('apps');
    expect(ids({ ...signedIn, apps: [], connected: ['googlecalendar'] })).not.toContain('apps');
    // where only this bot's apps are known, they stand in
    expect(ids({ ...signedIn, apps: ['outlook'] })).not.toContain('apps');
    expect(ids({ ...signedIn, apps: undefined })).not.toContain('apps');
  });

  it('offers a group only with bots to put in one', () => {
    expect(ids({ ...NEW, bots: 1 })).not.toContain('team-ask');
    expect(ids({ ...NEW, bots: 1 })).not.toContain('group');
    expect(ids({ ...NEW, bots: 2 })).toEqual(expect.arrayContaining(['team-ask', 'group']));
    expect(ids({ ...NEW, bots: 2, groups: 1 })).not.toContain('team-ask');
  });
});

describe('how many', () => {
  const seeds = Array.from({ length: 400 }, (_, i) => `bot_1:msg_${i}`);

  it('is two to five, each of them for some reply, and the same for one reply', () => {
    const seen = new Map<number, number>();
    for (const seed of seeds) {
      const n = suggestionCount(seed);
      expect(n).toBe(suggestionCount(seed));
      expect(n).toBeGreaterThanOrEqual(SUGGESTIONS_MIN);
      expect(n).toBeLessThanOrEqual(SUGGESTIONS_MAX);
      seen.set(n, (seen.get(n) ?? 0) + 1);
    }
    expect([...seen.keys()].sort()).toEqual([2, 3, 4, 5]);
    // none of them rare: each takes its share of 400 replies
    for (const times of seen.values()) expect(times).toBeGreaterThan(60);
  });

  it('is how many pills a reply gets, and the same pills every time', () => {
    for (const seed of seeds.slice(0, 60)) {
      const a = pickPills({ facts: NEW, seed });
      expect(a.followUps).toEqual([]);
      expect(a.suggestions).toHaveLength(suggestionCount(seed));
      expect(pickPills({ facts: NEW, seed })).toEqual(a);
      expect(pickPills({ facts: { ...NEW }, seed, hide: new Set(), sent: [] })).toEqual(a);
    }
  });

  it('leaves room for what the system shows before them', () => {
    const seed = seeds.find((x) => suggestionCount(x) === 5)!;
    expect(pickPills({ facts: NEW, seed, room: 3 }).suggestions).toHaveLength(3);
    expect(pickPills({ facts: NEW, seed, room: 0 }).suggestions).toEqual([]);
  });

  it('is fewer when fewer still make sense', () => {
    const seed = seeds.find((x) => suggestionCount(x) === 5)!;
    const hide = new Set(eligibleSuggestions(DONE).map((s) => s.id).slice(2));
    expect(pickPills({ facts: DONE, seed, hide }).suggestions).toHaveLength(2);
  });
});

describe('the pick holds still', () => {
  it('keeps the other pills when one more thing becomes known', () => {
    // the apps' list arrives a moment after the chat: what it adds or takes away is at most one pill's worth each
    const before: SuggestionFacts = { ...NEW, appsSignedIn: undefined, apps: undefined };
    const after: SuggestionFacts = { ...NEW, appsSignedIn: true, apps: ['gmail'], connected: ['gmail'] };
    let moved = 0;
    for (let i = 0; i < 100; i++) {
      const a = pickSuggestions(before, `m${i}`, 4).map((s) => s.id);
      const b = pickSuggestions(after, `m${i}`, 4).map((s) => s.id);
      const kept = a.filter((id) => b.includes(id));
      // 'inbox' is new and its twin 'inbox-bot' may give way to it: never more than those two places change
      expect(kept.length).toBeGreaterThanOrEqual(2);
      if (kept.length < a.length) moved++;
    }
    // and most replies' rows don't change at all
    expect(moved).toBeLessThan(60);
  });

  it('puts the next one in when a pill is put away, the rest unmoved', () => {
    for (let i = 0; i < 40; i++) {
      const a = pickSuggestions(NEW, `m${i}`, 4);
      const gone = a[0]!;
      const b = pickSuggestions(NEW, `m${i}`, 4, new Set([gone.id]));
      expect(b.map((s) => s.id)).not.toContain(gone.id);
      for (const s of a.slice(1)) if (s.kind === gone.kind) expect(b.map((x) => x.id)).toContain(s.id);
    }
  });
});

describe('with the bot’s own follow-ups', () => {
  const seedOf = (n: number) => Array.from({ length: 200 }, (_, i) => `bot_1:msg_${i}`).find((x) => suggestionCount(x) === n)!;

  it('puts them first, cleaned, and fills up after them', () => {
    const got = pickPills({ facts: NEW, seed: seedOf(5), followUps: ['- Email it to the team', 'Make it shorter', 'make it  shorter', ''] });
    expect(got.followUps).toEqual(['Email it to the team', 'Make it shorter']);
    expect(got.suggestions).toHaveLength(SUGGESTIONS_BESIDE_FOLLOW_UPS);
  });

  it('steps aside when the bot gave enough', () => {
    const four = ['Email it', 'Make it shorter', 'Translate it', 'Schedule this every Monday'];
    for (const n of [2, 3, 4, 5]) {
      const got = pickPills({ facts: NEW, seed: seedOf(n), followUps: four });
      expect(got.followUps).toEqual(four);
      expect(got.suggestions).toHaveLength(n === 5 ? 1 : 0);
    }
    expect(pickPills({ facts: NEW, seed: seedOf(2), followUps: ['Email it', 'Make it shorter'] }).suggestions).toEqual([]);
    expect(pickPills({ facts: NEW, seed: seedOf(3), followUps: ['Email it', 'Make it shorter'] }).suggestions).toHaveLength(1);
  });

  it('never shows more than the row holds', () => {
    const got = pickPills({ facts: NEW, seed: seedOf(5), room: 3, followUps: ['a', 'b', 'c', 'd'] });
    expect(got.followUps).toEqual(['a', 'b', 'c']);
    expect(got.suggestions).toEqual([]);
  });

  it('offers nothing the bot already offers, nor what the person already asked in this chat', () => {
    for (let i = 0; i < 60; i++) {
      const seed = `m${i}`;
      const withBot = pickPills({ facts: NEW, seed, followUps: ['help me plan my week'] });
      expect(withBot.suggestions.map((s) => s.id)).not.toContain('plan-week');
      const asked = pickPills({ facts: NEW, seed, sent: ['What can you do for me?', ' Help me  plan my week '] });
      expect(asked.suggestions.map((s) => s.id)).not.toContain('what-can-you-do');
      expect(asked.suggestions.map((s) => s.id)).not.toContain('plan-week');
      expect(asked.suggestions).toHaveLength(suggestionCount(seed));
    }
  });
});
