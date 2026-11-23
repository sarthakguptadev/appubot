import { describe, expect, it } from 'vitest';
import {
  MEMORY_LOAD_MAX, appendMemory, capMemory, entryKey, forgetInMemory, memoryIsEmpty, memoryPreface, memoryTemplate,
  parseMemoryFacts, replaceInMemory,
} from './memory';

const DAY = '2026-10-15';

describe('memory', () => {
  it('starts empty from its template', () => {
    expect(memoryIsEmpty(memoryTemplate('Appu'))).toBe(true);
    expect(memoryIsEmpty('')).toBe(true);
    expect(memoryIsEmpty(`${memoryTemplate('Appu')}- [2026-10-01] Likes tea\n`)).toBe(false);
    expect(memoryPreface(memoryTemplate('Appu'), { botName: 'Appu' })).toBeNull();
  });

  it('appends dated one-line entries, newest last, and skips what it already says', () => {
    let m = memoryTemplate('Appu');
    const a = appendMemory(m, '  Invoices are in INR\n with 18% GST ', DAY);
    expect(a.added).toBe(true);
    expect(a.entry).toBe('- [2026-10-15] Invoices are in INR with 18% GST');
    m = a.memory;
    m = appendMemory(m, 'Accountant: Priya', '2026-10-16').memory;
    expect(m.trimEnd().split('\n').slice(-2)).toEqual(['- [2026-10-15] Invoices are in INR with 18% GST', '- [2026-10-16] Accountant: Priya']);
    // the same fact again (another day, other case, a full stop) is not added twice
    const again = appendMemory(m, '- invoices are in INR with 18% GST.', '2026-10-20');
    expect(again.added).toBe(false);
    expect(again.memory).toBe(m);
    // a file the user edited without a trailing newline still gets its own line
    expect(appendMemory('# Memory\n- one', 'two', DAY).memory).toBe('# Memory\n- one\n- [2026-10-15] two\n');
    expect(entryKey('- [2026-01-02] Likes Tea!')).toBe('likes tea');
  });

  it('replaces the one matching line, or explains why it could not', () => {
    const m = '# Memory\n\n- [2026-10-01] Accountant: Priya\n  - [2026-10-01] CC her on invoices\n- [2026-10-02] Prefers short answers\n';
    const r = replaceInMemory(m, 'accountant:  PRIYA', 'Accountant: Ravi (ravi@ledger.in)', DAY);
    expect(r).toMatchObject({ ok: true, removed: ['- [2026-10-01] Accountant: Priya'], added: '- [2026-10-15] Accountant: Ravi (ravi@ledger.in)' });
    expect(r.ok && r.memory).toBe('# Memory\n\n- [2026-10-15] Accountant: Ravi (ravi@ledger.in)\n  - [2026-10-01] CC her on invoices\n- [2026-10-02] Prefers short answers\n');
    // a nested entry keeps its indent
    const nested = replaceInMemory(m, 'CC her', 'CC Ravi on invoices', DAY);
    expect(nested.ok && nested.memory).toContain('\n  - [2026-10-15] CC Ravi on invoices\n');
    // an empty text removes the line
    const removed = replaceInMemory(m, 'short answers', '', DAY);
    expect(removed.ok && removed.memory).toBe('# Memory\n\n- [2026-10-01] Accountant: Priya\n  - [2026-10-01] CC her on invoices\n');
    expect(replaceInMemory(m, 'nothing like this', 'x', DAY)).toEqual({ ok: false, reason: 'none', matches: [] });
    expect(replaceInMemory(m, '2026-10-01', 'x', DAY)).toMatchObject({ ok: false, reason: 'many', matches: ['- [2026-10-01] Accountant: Priya', '- [2026-10-01] CC her on invoices'] });
    // headings are never matched
    expect(replaceInMemory(m, 'Memory', 'x', DAY)).toMatchObject({ ok: false, reason: 'none' });
  });

  it('forgets every matching line', () => {
    const m = '# Memory\n- [2026-10-01] Goa trip in December\n- [2026-10-02] Goa: book the villa\n- [2026-10-03] Likes tea\n';
    const f = forgetInMemory(m, 'goa');
    expect(f.removed).toEqual(['- [2026-10-01] Goa trip in December', '- [2026-10-02] Goa: book the villa']);
    expect(f.memory).toBe('# Memory\n- [2026-10-03] Likes tea\n');
    expect(forgetInMemory(m, 'coffee')).toEqual({ memory: m, removed: [] });
  });

  it('caps what a new session gets: the title, a marker, then the newest lines', () => {
    const short = '# Memory\n- one\n';
    expect(capMemory(short)).toEqual({ text: '# Memory\n- one', omitted: 0 });
    const lines = Array.from({ length: 400 }, (_, i) => `- [2026-01-01] fact number ${i} ${'x'.repeat(40)}`);
    const big = `# Memory - Appu\n\nPinned: the user is Sarthak.\n\n${lines.join('\n')}\n`;
    const { text, omitted } = capMemory(big, 4000);
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text.startsWith('# Memory - Appu\n\nPinned: the user is Sarthak.\n')).toBe(true);
    expect(text.endsWith('fact number 399 ' + 'x'.repeat(40))).toBe(true);
    expect(text).not.toContain('fact number 0 ');
    expect(text).toContain(`[… ${omitted} older lines left out: read_memory shows all of it …]`);
    expect(omitted).toBeGreaterThan(300);
    // the default cap
    expect(capMemory(big).text.length).toBeLessThanOrEqual(MEMORY_LOAD_MAX);
    // a single huge line is cut, not dropped
    const huge = capMemory(`- ${'y'.repeat(9000)}`, 1000);
    expect(huge.text.length).toBeLessThanOrEqual(1000);
    expect(huge.text).toContain('yyy');
  });

  it('wraps the memory for a new session, saying when it was cut', () => {
    const m = `${memoryTemplate('Appu')}- [2026-10-01] Likes tea\n`;
    const p = memoryPreface(m, { botName: 'Appu' })!;
    expect(p.startsWith('<memory>\n')).toBe(true);
    expect(p.endsWith('\n</memory>')).toBe(true);
    expect(p).toContain("This is Appu's memory (MEMORY.md in your folder)");
    expect(p).toContain('- [2026-10-01] Likes tea');
    expect(p).not.toContain('left out');
    const long = memoryPreface(`# M\n${Array.from({ length: 50 }, (_, i) => `- fact ${i}`).join('\n')}`, { botName: 'Appu', max: 200 })!;
    expect(long).toContain('older lines are left out here (read_memory shows all of it)');
  });

  it('reads the facts out of a reply to "anything to remember?"', () => {
    expect(parseMemoryFacts('NONE')).toEqual([]);
    expect(parseMemoryFacts(' none. ')).toEqual([]);
    expect(parseMemoryFacts('Here you go:\n- Works from Bengaluru\n* Prefers INR\n\n1. Ships on Fridays\nnot a fact')).toEqual(['Works from Bengaluru', 'Prefers INR', 'Ships on Fridays']);
    expect(parseMemoryFacts(Array.from({ length: 12 }, (_, i) => `- f${i}`).join('\n'))).toHaveLength(8);
    expect(parseMemoryFacts(`- ${'z'.repeat(600)}\n- ok`)).toEqual(['ok']);
  });
});
