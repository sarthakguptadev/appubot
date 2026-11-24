import { describe, expect, it } from 'vitest';
import { PICK_WINDOW_MS, PICKS_KEPT, addPick, recentKeys } from './paletteRecent';

describe('palette picks', () => {
  it('puts the newest pick first, once per row and query', () => {
    let p = addPick([], 'bot:a', '', 1);
    p = addPick(p, 'thread:b', 'goa', 2);
    p = addPick(p, 'bot:a', '', 3);
    expect(p).toEqual([{ key: 'bot:a', query: '', at: 3 }, { key: 'thread:b', query: 'goa', at: 2 }]);
    expect(recentKeys(addPick(p, 'thread:b', 'trip', 4), 4)).toEqual(['thread:b', 'bot:a']);
  });
  it('forgets old picks and keeps a few dozen', () => {
    const old = addPick([], 'bot:a', '', 0);
    expect(addPick(old, 'bot:b', '', PICK_WINDOW_MS + 1).map((x) => x.key)).toEqual(['bot:b']);
    expect(recentKeys(old, PICK_WINDOW_MS + 1)).toEqual([]);
    let many: ReturnType<typeof addPick> = [];
    for (let i = 0; i < PICKS_KEPT + 10; i++) many = addPick(many, `thread:${i}`, '', i);
    expect(many).toHaveLength(PICKS_KEPT);
  });
});
