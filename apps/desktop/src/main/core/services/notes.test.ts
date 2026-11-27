/** The limits on what a bot sends while it works (`send_message`): length, no repeat of its last one, and a ceiling per turn. */
import { describe, expect, it } from 'vitest';
import { NOTE_MAX_CHARS, NOTE_TURN_MAX, newNoteState, noteKey, takeNote } from './notes';

describe('a note sent mid-job', () => {
  it('goes out when it is short, and is turned down with its length when it is long', () => {
    const s = newNoteState();
    expect(takeNote(s, 'x'.repeat(NOTE_MAX_CHARS))).toEqual({ ok: true });
    const long = takeNote(s, 'y'.repeat(NOTE_MAX_CHARS + 1));
    expect(long.ok).toBe(false);
    expect(long.ok ? '' : long.reason).toContain(`${NOTE_MAX_CHARS + 1} characters`);
    // a long one that was turned down isn't counted
    expect(s.sent).toBe(1);
  });

  it('counts characters as people do: an emoji or a Devanagari letter is one', () => {
    const s = newNoteState();
    expect(takeNote(s, '🙂'.repeat(NOTE_MAX_CHARS)).ok).toBe(true);
    expect(takeNote(s, 'क'.repeat(NOTE_MAX_CHARS + 1)).ok).toBe(false);
  });

  it('is turned down when it says the last one again, whatever its case, spacing or punctuation', () => {
    const s = newNoteState();
    expect(takeNote(s, 'Still working on the report…').ok).toBe(true);
    const again = takeNote(s, '  still working  on the report! ');
    expect(again.ok).toBe(false);
    expect(again.ok ? '' : again.reason).toMatch(/already told the user/);
    expect(s.sent).toBe(1);
    // something new goes out, and the one before it may come again after that
    expect(takeNote(s, 'The report is built; checking the totals.').ok).toBe(true);
    expect(takeNote(s, 'Still working on the report…').ok).toBe(true);
    expect(noteKey('✅')).toBe('✅');
    expect(noteKey('On it!')).toBe(noteKey('on it'));
  });

  it('lets ten separate messages out in a row, as fast as the bot sends them', () => {
    const s = newNoteState();
    for (let i = 1; i <= 10; i++) expect(takeNote(s, `Message ${i}`)).toEqual({ ok: true });
    expect(s.sent).toBe(10);
  });

  it(`stops a turn that runs away at ${NOTE_TURN_MAX}, without a number the bot could repeat`, () => {
    const s = newNoteState();
    for (let i = 0; i < NOTE_TURN_MAX; i++) expect(takeNote(s, `step ${i}`).ok).toBe(true);
    const over = takeNote(s, 'one more');
    expect(over.ok).toBe(false);
    expect(over.ok ? '' : over.reason).toMatch(/far more messages than one reply needs/);
    expect(over.ok ? '' : over.reason).not.toMatch(/\d/);
  });

  it('lets the answer to a message the user wrote mid-job out whatever was sent before, once', () => {
    const s = newNoteState();
    for (let i = 0; i < NOTE_TURN_MAX; i++) takeNote(s, `step ${i}`);
    s.owed = true;
    expect(takeNote(s, 'It is 51.').ok).toBe(true);
    expect(s.owed).toBe(false);
    expect(takeNote(s, 'And one more thing').ok).toBe(false);
    // still short, still not its last one again
    s.owed = true;
    expect(takeNote(s, 'It is 51.').ok).toBe(false);
    expect(takeNote(s, 'z'.repeat(NOTE_MAX_CHARS + 1)).ok).toBe(false);
    expect(s.owed).toBe(true);
  });
});
