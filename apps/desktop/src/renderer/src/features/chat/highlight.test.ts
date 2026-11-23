import { describe, expect, it } from 'vitest';
import { cachedHighlight, highlight } from './highlight';

describe('highlighting code blocks', () => {
  it('works through them newest first, skips ones nobody waits for, and keeps the rest', async () => {
    const done: string[] = [];
    const gone = new AbortController();
    const a = highlight('const a = 1;', 'typescript').then((h) => { done.push('a'); return h; });
    const b = highlight('const b = 2;', 'typescript', gone.signal).then((h) => { done.push('b'); return h; });
    const c = highlight('const c = 3;', 'typescript').then((h) => { done.push('c'); return h; });
    gone.abort();
    const [ha, hb, hc] = await Promise.all([a, b, c]);
    expect(hb).toBeNull();
    expect(ha).toContain('shiki');
    expect(hc).toContain('shiki');
    expect(done.filter((x) => x !== 'b')).toEqual(['c', 'a']);
    expect(cachedHighlight('const a = 1;', 'typescript')).toBe(ha);
    expect(cachedHighlight('const b = 2;', 'typescript')).toBeUndefined();
    // the same block asked for twice shares one job, and a cached one answers at once
    const [x, y] = await Promise.all([highlight('let x;', 'typescript'), highlight('let x;', 'typescript')]);
    expect(x).toBe(y);
    expect(await highlight('const a = 1;', 'typescript')).toBe(ha);
  });
});
