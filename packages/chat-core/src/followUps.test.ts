import { describe, expect, it } from 'vitest';
import { cleanFollowUps, FOLLOW_UP_MAX_CHARS, FOLLOW_UPS_MAX, FollowUpsStream, splitFollowUps } from './followUps';

/** A reply fed in pieces of `size` characters: what was shown as it came, and how it ended. */
function stream(text: string, size: number): { shown: string; text: string; followUps: string[] } {
  const s = new FollowUpsStream();
  let shown = '';
  for (let i = 0; i < text.length; i += size) shown += s.push(text.slice(i, i + size));
  const end = s.end();
  return { shown, text: shown + end.text, followUps: end.followUps };
}

const REPLY = 'The summary is in summary.md.\n\n<followups>\nEmail it to the team\nMake it shorter\n</followups>\n';

describe('cleanFollowUps', () => {
  it('keeps short lines as they were written', () => {
    expect(cleanFollowUps(['Email it to the team', 'Make it shorter'])).toEqual(['Email it to the team', 'Make it shorter']);
  });

  it('takes bullets, numbers, quotes and emphasis off', () => {
    expect(cleanFollowUps(['- Email it', '2. Make it shorter', '* "Schedule this every Monday"', '**Translate it**', '• 日本語にして']))
      .toEqual(['Email it', 'Make it shorter', 'Schedule this every Monday', 'Translate it']);
  });

  it('drops empty lines, lines said twice and lines too long for a pill', () => {
    const long = 'x'.repeat(FOLLOW_UP_MAX_CHARS + 1);
    expect(cleanFollowUps(['', '   ', 'Email it', 'email  it', long, 'x'.repeat(FOLLOW_UP_MAX_CHARS)])).toEqual(['Email it', 'x'.repeat(FOLLOW_UP_MAX_CHARS)]);
  });

  it('counts characters, not bytes', () => {
    expect(cleanFollowUps(['é'.repeat(FOLLOW_UP_MAX_CHARS), '🙂'.repeat(FOLLOW_UP_MAX_CHARS)])).toHaveLength(2);
  });

  it('keeps no more than four, and nothing that is not text', () => {
    expect(cleanFollowUps(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual(['a', 'b', 'c', 'd']);
    expect(cleanFollowUps(['a', 'b', 'c', 'd', 'e'])).toHaveLength(FOLLOW_UPS_MAX);
    expect(cleanFollowUps([1, null, { a: 1 }, 'ok'])).toEqual(['ok']);
  });
});

describe('FollowUpsStream', () => {
  it('takes the block off the end of a reply, however the text is cut into pieces', () => {
    for (const size of [1, 2, 3, 5, 7, 11, 16, 64, 1000]) {
      const got = stream(REPLY, size);
      expect(got.shown).toBe('The summary is in summary.md.');
      expect(got.text).toBe('The summary is in summary.md.');
      expect(got.followUps).toEqual(['Email it to the team', 'Make it shorter']);
    }
  });

  it('shows a reply without a block exactly as it came', () => {
    for (const text of ['Done.', 'Done.\n', 'a < b and <b>bold</b> and <follow me>\n\n', 'if (a <f) {}', 'ends with <follow', '  \n']) {
      for (const size of [1, 3, 1000]) {
        const got = stream(text, size);
        expect(got.text).toBe(text);
        expect(got.followUps).toEqual([]);
      }
    }
  });

  it('never shows a letter of the tag while it is still arriving', () => {
    const s = new FollowUpsStream();
    let shown = '';
    for (const ch of 'Sent.\n<followups>\nSend it again') { shown += s.push(ch); expect(shown).not.toMatch(/</); }
    expect(shown).toBe('Sent.');
  });

  it('reads a block cut short, and other spellings of the tag', () => {
    expect(splitFollowUps('Done.\n<followups>\nMake it shorter\nEmail it</follow')).toEqual({ text: 'Done.', followUps: ['Make it shorter', 'Email it'] });
    expect(splitFollowUps('Done. <Follow-Ups>- Make it shorter\n- Email it</Follow-Ups>')).toEqual({ text: 'Done.', followUps: ['Make it shorter', 'Email it'] });
    expect(splitFollowUps('Done.\n<follow_ups>\n<followup>Make it shorter</followup>\n<followup>Email it</followup>\n</follow_ups>').followUps).toEqual(['Make it shorter', 'Email it']);
  });

  it('gives no follow-ups for an empty block, and still hides it', () => {
    expect(splitFollowUps('Hello!\n\n<followups>\n</followups>')).toEqual({ text: 'Hello!', followUps: [] });
  });

  it('drops a block the bot wrote on after: it was not the end of the reply', () => {
    for (const size of [1, 4, 1000]) {
      const got = stream('First part.\n\n<followups>\nEmail it\n</followups>\n\nOne more thing.', size);
      expect(got.text).toBe('First part.\n\nOne more thing.');
      expect(got.followUps).toEqual([]);
    }
  });

  it('takes the last block when a reply has two', () => {
    const got = stream('A.\n<followups>\nOld\n</followups>\nB.\n<followups>\nNew\n</followups>', 3);
    expect(got.text).toBe('A.\nB.');
    expect(got.followUps).toEqual(['New']);
  });

  it('holds a reply that is only a block back whole', () => {
    const s = new FollowUpsStream();
    expect(s.push('\n<followups>\nEmail it\n</followups>')).toBe('');
    expect(s.end()).toEqual({ text: '', followUps: ['Email it'] });
  });

  it('applies the limits to a block', () => {
    const got = splitFollowUps(`Done.\n<followups>\none\ntwo\n\nTWO\n${'y'.repeat(FOLLOW_UP_MAX_CHARS + 5)}\nthree\nfour\nfive\n</followups>`);
    expect(got.followUps).toEqual(['one', 'two', 'three', 'four']);
  });
});
