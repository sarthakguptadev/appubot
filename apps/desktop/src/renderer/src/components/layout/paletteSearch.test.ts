import { describe, expect, it } from 'vitest';
import { fold, foldQuery, matchClass, matchFields, messageMatcher, pickedFor, rankGroups, splitByRanges, withinOneEdit, type SearchField } from './paletteSearch';

const name = (value: string, extra: SearchField[] = [], midWord = false): SearchField[] => [{ value, weight: 1, midWord }, ...extra];
const hl = (text: string, q: string, extra: SearchField[] = []) => {
  const m = matchFields(foldQuery(q), name(text, extra));
  return m ? splitByRanges(text, m.ranges).filter((p) => p.hit).map((p) => p.text) : null;
};

describe('fold and foldQuery', () => {
  it('folds case and accents unit for unit', () => {
    expect(fold('Café NAÏVE')).toBe('cafe naive');
    expect(fold('Café').length).toBe('Café'.length);
  });
  it('drops wrapping quotes and extra spaces', () => {
    expect(foldQuery('  "GST   Templates" ')).toBe('gst templates');
    expect(foldQuery('   ')).toBe('');
  });
});

describe('matchFields', () => {
  it('matches the start of a word, and marks it', () => {
    expect(hl('Acme invoice and GST templates', 'gst')).toEqual(['GST']);
    expect(hl('Settings', 'set')).toEqual(['Set']);
    expect(hl('Tidy the Desktop screenshots', 'desk shot')).toBeNull();
    expect(hl('Tidy the Desktop screenshots', 'desk scr')).toEqual(['Desk', 'scr']);
  });
  it('counts camelCase and digit boundaries as word starts', () => {
    expect(hl('openBotDetails', 'det')).toEqual(['Det']);
    expect(hl('GSTR1 return', '1')).toEqual(['1']);
  });
  it('matches inside a word only in chat names, and only from four letters', () => {
    expect(hl('Ledger', 'dger')).toBeNull();
    expect(matchFields('dger', name('Ledger', [], true))?.ranges).toEqual([{ start: 2, end: 6 }]);
    expect(matchFields('ger', name('Ledger', [], true))).toBeNull();
  });
  it('no longer finds a two-letter query inside a hidden word', () => {
    // the old palette listed Ledger for "se" because its last message said "September"
    expect(matchFields('se', name('Ledger', [{ value: 'September GSTR-1 is ready', weight: 0.4, keyword: true }]))).toBeNull();
  });
  it('finds a short keyword only when typed whole, and a longer one by its start', () => {
    const pair = name('Pair a phone', [{ value: 'phone iphone android mobile qr devices', weight: 0.6, keyword: true }]);
    expect(matchFields('qr', pair)).not.toBeNull();
    expect(matchFields('mo', pair)).toBeNull();
    expect(matchFields('mobi', pair)).not.toBeNull();
    // found by a keyword alone, its group never ranks above a name match of the same class
    expect(matchFields('mobi', pair)!.groupQuality).toBeLessThan(0.7);
    expect(matchFields('mobi', pair)!.ranges).toEqual([]);
  });
  it('ranks the whole name above a word of it, a word above a prefix', () => {
    const whole = matchFields('settings', name('Settings'))!.quality;
    const word = matchFields('settings', name('Open settings page'))!.quality;
    const prefix = matchFields('sett', name('Settings'))!.quality;
    expect(whole).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(prefix);
    expect(matchClass(whole)).toBe(3);
    expect(matchClass(prefix)).toBe(2);
  });
  it('lets filler words be left out of a phrase', () => {
    expect(hl('Goa trip December', 'the goa trip in december')).toEqual(['Goa', 'trip', 'December']);
    expect(matchFields('the', name('Goa trip'))).toBeNull();
  });
  it('forgives one typo only when asked', () => {
    expect(matchFields('setings', name('Settings'))).toBeNull();
    const m = matchFields('setings', name('Settings'), { typos: true })!;
    expect(m.strong).toBe(false);
    expect(matchClass(m.quality)).toBe(1);
    expect(matchFields('ledgre', name('Ledger'), { typos: true })).not.toBeNull();
    // a three-letter word forgives a swap, not any letter changed
    expect(matchFields('cno', name('Connect apps'), { typos: true })).not.toBeNull();
    expect(matchFields('cxn', name('Connect apps'), { typos: true })).toBeNull();
    // never a typo in a keyword
    expect(matchFields('androd', name('Pair a phone', [{ value: 'android', weight: 0.6, keyword: true }]), { typos: true })).toBeNull();
  });
});

describe('withinOneEdit', () => {
  it('allows one change, addition, removal or swap', () => {
    expect(withinOneEdit('setings', 'settings')).toBe(true);
    expect(withinOneEdit('settigns', 'settings')).toBe(true);
    expect(withinOneEdit('sittings', 'settings')).toBe(true);
    expect(withinOneEdit('stetigns', 'settings')).toBe(false);
    expect(withinOneEdit('cno', 'con', true)).toBe(true);
    expect(withinOneEdit('cxn', 'con', true)).toBe(false);
  });
});

describe('rankGroups', () => {
  type Item = { label: string; at?: number; picked?: number };
  const score = (q: string) => (it: Item, typos: boolean) => matchFields(foldQuery(q), name(it.label), { typos });
  const labels = (r: ReturnType<typeof rankGroups<string, Item>>) => r.map((g) => [g.group, g.ranked.map((x) => x.item.label)]);

  it('keeps the groups in order unless a later one matches clearly better', () => {
    const groups = [
      { group: 'bots', items: [{ label: 'Newsletter bot' }] },
      { group: 'actions', items: [{ label: 'New' }, { label: 'New thread' }] },
    ];
    // "New" is a whole name in actions: that group comes first
    expect(labels(rankGroups(groups, score('new')))).toEqual([['actions', ['New', 'New thread']], ['bots', ['Newsletter bot']]]);
    // "ne" is a prefix everywhere: the order given stands
    expect(labels(rankGroups(groups, score('ne')))[0]![0]).toBe('bots');
  });
  it('puts a row picked for this query first among equal matches, then the more recent', () => {
    const items = [{ label: 'Ledger notes', at: 3 }, { label: 'Ledger', at: 1 }, { label: 'Ledger GST', at: 2, picked: 10 }];
    const use = (it: Item) => ({ pickedAt: it.picked, usedAt: it.at });
    const r = rankGroups([{ group: 'g', items }], score('ledg'), use);
    expect(r[0]!.ranked.map((x) => x.item.label)).toEqual(['Ledger GST', 'Ledger notes', 'Ledger']);
    // a closer match still leads a more recent one: the whole word beats a prefix
    expect(rankGroups([{ group: 'g', items }], score('ledger'), use)[0]!.ranked.map((x) => x.item.label)).toEqual(['Ledger', 'Ledger GST', 'Ledger notes']);
  });
  it('tries typos only when nothing matched at a word start', () => {
    const items = [{ label: 'Settings' }, { label: 'Setup a phone' }];
    expect(labels(rankGroups([{ group: 'g', items }], score('setings')))).toEqual([['g', ['Settings']]]);
    expect(labels(rankGroups([{ group: 'g', items: [...items, { label: 'Setings typo row' }] }], score('setings')))).toEqual([['g', ['Setings typo row']]]);
  });
});

describe('splitByRanges', () => {
  it('cuts text into plain and matched parts', () => {
    expect(splitByRanges('New thread', [{ start: 0, end: 3 }])).toEqual([{ text: 'New', hit: true }, { text: ' thread', hit: false }]);
    expect(splitByRanges('abc', [])).toEqual([{ text: 'abc', hit: false }]);
  });
});

describe('messageMatcher', () => {
  it('needs a word of three letters or more', () => {
    expect(messageMatcher('to')).toBeNull();
    expect(messageMatcher('to be')).toBeNull();
  });
  it('finds every word, a short one only at a word start', () => {
    const m = messageMatcher('gst rate')!;
    expect(m('The GST rate is 18%')?.quality).toBe(1);
    expect(m('angsty rate')).toBeNull();
    expect(messageMatcher('voice')!('Three invoices sent')?.quality).toBe(0.3);
    expect(messageMatcher('templ')!('the templates live here')?.quality).toBe(0.8);
  });
  it('cuts a one-line snippet around the match, with the words marked', () => {
    const text = 'Lots of words before this point and then some more words.\nThe quarterly GST filing is due on the 20th.';
    const hit = messageMatcher('gst filing', 60)!(text)!;
    expect(hit.snippet.startsWith('…')).toBe(true);
    expect(hit.snippet).not.toContain('\n');
    expect(hit.ranges.map((r) => hit.snippet.slice(r.start, r.end))).toEqual(['GST', 'filing']);
  });
});

describe('pickedFor', () => {
  const picks = [
    { key: 'bot:ledger', query: 'ledger', at: 5 },
    { key: 'bot:ledger', query: '', at: 9 },
    { key: 'thread:1', query: 'le', at: 7 },
  ];
  it('remembers a pick for the same query, or a longer one this query starts', () => {
    expect(pickedFor(picks, 'bot:ledger', 'ledger')).toBe(5);
    expect(pickedFor(picks, 'bot:ledger', 'led')).toBe(5);
    expect(pickedFor(picks, 'bot:ledger', 'le')).toBeUndefined();
    expect(pickedFor(picks, 'thread:1', 'le')).toBe(7);
    expect(pickedFor(picks, 'thread:1', 'led')).toBeUndefined();
  });
});
