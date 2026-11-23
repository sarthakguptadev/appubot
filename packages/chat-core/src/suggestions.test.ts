import { describe, expect, it } from 'vitest';
import { eligibleSuggestions, pickSuggestions, SUGGESTIONS_MAX, type SuggestionFacts } from './suggestions';

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
});
