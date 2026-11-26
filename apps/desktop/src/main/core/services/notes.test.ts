/** The limits on what a bot sends while it works (`send_message`): length, how often, and no repeat of its last one. */
import { describe, expect, it } from 'vitest';
import { NOTE_BURST, NOTE_EVERY_MS, NOTE_MAX_CHARS, newNoteState, noteKey, takeNote } from './notes';

const T0 = 1_000_000;

describe('a note sent mid-job', () => {
  it('goes out when it is short, and is turned down with its length when it is long', () => {
    const s = newNoteState(T0);
    expect(takeNote(s, 'x'.repeat(NOTE_MAX_CHARS), T0)).toEqual({ ok: true });
    const long = takeNote(s, 'y'.repeat(NOTE_MAX_CHARS + 1), T0);
    expect(long.ok).toBe(false);
    expect(long.ok ? '' : long.reason).toContain(`${NOTE_MAX_CHARS + 1} characters`);
    // a long one that was turned down costs nothing
    expect(s.credit).toBe((NOTE_BURST - 1) * NOTE_EVERY_MS);
  });

  it('counts characters as people do: an emoji or a Devanagari letter is one', () => {
    const s = newNoteState(T0);
    expect(takeNote(s, '🙂'.repeat(NOTE_MAX_CHARS), T0).ok).toBe(true);
    expect(takeNote(s, 'क'.repeat(NOTE_MAX_CHARS + 1), T0).ok).toBe(false);
  });

  it('is turned down when it says the last one again, whatever its case, spacing or punctuation', () => {
    const s = newNoteState(T0);
    expect(takeNote(s, 'Still working on the report…', T0).ok).toBe(true);
    const again = takeNote(s, '  still working  on the report! ', T0 + 5_000);
    expect(again.ok).toBe(false);
    expect(again.ok ? '' : again.reason).toMatch(/already told the user/);
    expect(s.credit).toBe((NOTE_BURST - 1) * NOTE_EVERY_MS);
    // something new goes out, and the one before it may come again after that
    expect(takeNote(s, 'The report is built; checking the totals.', T0 + 6_000).ok).toBe(true);
    expect(takeNote(s, 'Still working on the report…', T0 + 7_000).ok).toBe(true);
    expect(noteKey('✅')).toBe('✅');
    expect(noteKey('On it!')).toBe(noteKey('on it'));
  });

  it(`lets ${NOTE_BURST} out in a row, then one a minute`, () => {
    const s = newNoteState(T0);
    for (let i = 0; i < NOTE_BURST; i++) expect(takeNote(s, `step ${i}`, T0).ok).toBe(true);
    const soon = takeNote(s, 'one more', T0 + 10_000);
    expect(soon.ok).toBe(false);
    expect(soon.ok ? '' : soon.reason).toMatch(/too many messages in a row/);
    // no countdown to wait out
    expect(soon.ok ? '' : soon.reason).not.toMatch(/seconds/);
    // a refusal doesn't push the next one further away
    expect(takeNote(s, 'one more', T0 + NOTE_EVERY_MS - 1).ok).toBe(false);
    expect(takeNote(s, 'one more', T0 + NOTE_EVERY_MS).ok).toBe(true);
    expect(takeNote(s, 'and another', T0 + NOTE_EVERY_MS + 1_000).ok).toBe(false);
    expect(takeNote(s, 'and another', T0 + 2 * NOTE_EVERY_MS).ok).toBe(true);
    // a long quiet stretch gives the whole row back, never more
    const later = T0 + 60 * NOTE_EVERY_MS;
    for (let i = 0; i < NOTE_BURST; i++) expect(takeNote(s, `later ${i}`, later).ok).toBe(true);
    expect(takeNote(s, 'later, one too many', later + 100).ok).toBe(false);
  });

  it('lets the answer to a message the user wrote mid-job out whatever was sent before, once', () => {
    const s = newNoteState(T0);
    for (let i = 0; i < NOTE_BURST; i++) takeNote(s, `step ${i}`, T0);
    s.owed = true;
    expect(takeNote(s, 'It is 51.', T0 + 1_000).ok).toBe(true);
    expect(s.owed).toBe(false);
    expect(takeNote(s, 'And one more thing', T0 + 2_000).ok).toBe(false);
    // still short, still not its last one again
    s.owed = true;
    expect(takeNote(s, 'It is 51.', T0 + 3_000).ok).toBe(false);
    expect(takeNote(s, 'z'.repeat(NOTE_MAX_CHARS + 1), T0 + 3_000).ok).toBe(false);
    expect(s.owed).toBe(true);
  });
});
