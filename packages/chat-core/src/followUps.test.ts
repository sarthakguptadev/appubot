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
    for (const text of ['Done.', 'Done.\n', 'a < b and <b>bold</b> and <follow me>\n\n', 'if (a <f) {}', 'ends with <', '  \n']) {
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

  it('leaves out a last line that was still being written when the reply was cut off', () => {
    expect(splitFollowUps('Done.\n<followups>\nMake it shorter\nEmail it to the te')).toEqual({ text: 'Done.', followUps: ['Make it shorter'] });
    expect(splitFollowUps('Done.\n<followups>\nMake it sh')).toEqual({ text: 'Done.', followUps: [] });
    expect(splitFollowUps('Done.\n<followups>')).toEqual({ text: 'Done.', followUps: [] });
    // a line break, or a tag begun after it, says the line was whole
    expect(splitFollowUps('Done.\n<followups>\nMake it shorter\nEmail it\n').followUps).toEqual(['Make it shorter', 'Email it']);
    expect(splitFollowUps('Done.\n<followups>\nMake it shorter\nEmail it\n</').followUps).toEqual(['Make it shorter', 'Email it']);
    expect(splitFollowUps('Done.\n<followups><followup>Make it shorter</followup><followup>Email it</followup>').followUps).toEqual(['Make it shorter', 'Email it']);
    expect(splitFollowUps('Done.\n<followups><followup>Make it shorter</followup><followup>Email i').followUps).toEqual(['Make it shorter']);
  });

  it('leaves nothing of a tag the reply was cut off in', () => {
    for (let cut = 2; cut < '<followups>'.length; cut++) {
      const tag = '<followups>'.slice(0, cut);
      expect(splitFollowUps(`Done.\n\n${tag}`)).toEqual({ text: 'Done.', followUps: [] });
      expect(splitFollowUps(`Done.\n\n\`\`\`xml\n${tag}`)).toEqual({ text: 'Done.', followUps: [] });
    }
    for (const size of [1, 4, 1000]) expect(stream('Done.\n\n<follow-u', size)).toEqual({ shown: 'Done.', text: 'Done.', followUps: [] });
    // a lone "<" is the reply's own
    expect(splitFollowUps('Is a <')).toEqual({ text: 'Is a <', followUps: [] });
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

  it('takes a block wrapped in a code fence with its fence, at every cut of the stream', () => {
    const wrapped = 'Saved it.\n\n```xml\n<followups>\nEmail it\nMake it shorter\n</followups>\n```\n';
    for (const size of [1, 2, 3, 4, 7, 13, 1000]) {
      const got = stream(wrapped, size);
      expect(got.shown).toBe('Saved it.');
      expect(got.text).toBe('Saved it.');
      expect(got.followUps).toEqual(['Email it', 'Make it shorter']);
    }
    // a bare fence and a tilde one, a blank line inside, and a fence that never closes
    expect(splitFollowUps('Done.\n```\n\n<followups>\nEmail it\n</followups>\n\n```')).toEqual({ text: 'Done.', followUps: ['Email it'] });
    expect(splitFollowUps('Done.\n~~~\n<followups>\nEmail it\n</followups>\n~~~')).toEqual({ text: 'Done.', followUps: ['Email it'] });
    expect(splitFollowUps('Done.\n```\n<followups>\nEmail it\n</followups>')).toEqual({ text: 'Done.', followUps: ['Email it'] });
    expect(splitFollowUps('```\n<followups>\nEmail it\n</followups>\n```')).toEqual({ text: '', followUps: ['Email it'] });
  });

  it('keeps the fence that closes the bot’s own code before a block', () => {
    const text = 'Here:\n\n```js\nconst a = 1;\n```\n<followups>\nRun it\n</followups>';
    for (const size of [1, 3, 5, 1000]) {
      const got = stream(text, size);
      expect(got.text).toBe('Here:\n\n```js\nconst a = 1;\n```');
      expect(got.followUps).toEqual(['Run it']);
    }
  });

  it('shows code as it was written, fences and all, when no block comes', () => {
    for (const text of ['Here:\n```js\nconst a = 1;\n```\nDone.', 'Ends on an open fence:\n```', '```\ncode\n```\n', 'a\n```\n<b>\n```']) {
      for (const size of [1, 2, 5, 1000]) expect(stream(text, size)).toEqual({ shown: expect.any(String), text, followUps: [] });
    }
  });

  it('never shows the tags, whatever the block sits in', () => {
    const cases = [
      // in the middle of a reply
      'First.\n<followups>\nEmail it\n</followups>\nThen more.',
      // inside the bot's own code, with code after it
      'Look:\n```xml\n<config>\n<followups>\nEmail it\n</followups>\n</config>\n```\nThat is all.',
      // a fence of its own, and the bot wrote on after it
      'Done.\n```\n<followups>\nEmail it\n</followups>\n```\n\nAnything else?',
      // a fence with words of its own before the block
      'Done.\n```\nNext steps:\n<followups>\nEmail it\n</followups>\n```',
      // twice, cut short, on one line
      'A.\n<followups>\nOld\n</followups>\nB.\n<followups>\nNew',
      'Done. <followups>Email it</followups> Bye.',
    ];
    for (const text of cases) {
      for (const size of [1, 3, 8, 1000]) {
        const s = new FollowUpsStream();
        let shown = '';
        for (let i = 0; i < text.length; i += size) { shown += s.push(text.slice(i, i + size)); expect(shown).not.toMatch(/follow/i); }
        const end = s.end();
        expect(shown + end.text).not.toMatch(/follow/i);
        expect(shown + end.text).not.toMatch(/Email it|Old|New/);
      }
    }
    expect(splitFollowUps(cases[2]!)).toEqual({ text: 'Done.\n\nAnything else?', followUps: [] });
    expect(splitFollowUps(cases[1]!)).toEqual({ text: 'Look:\n```xml\n<config>\n</config>\n```\nThat is all.', followUps: [] });
    expect(splitFollowUps(cases[3]!)).toEqual({ text: 'Done.\n```\nNext steps:\n```', followUps: [] });
  });

  it('applies the limits to a block', () => {
    const got = splitFollowUps(`Done.\n<followups>\none\ntwo\n\nTWO\n${'y'.repeat(FOLLOW_UP_MAX_CHARS + 5)}\nthree\nfour\nfive\n</followups>`);
    expect(got.followUps).toEqual(['one', 'two', 'three', 'four']);
  });
});
