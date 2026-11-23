import { describe, expect, it } from 'vitest';
import { markdownTokens } from './markdownTokens';

const kinds = (line: string) => markdownTokens(line).map((t) => `${t.kind}:${t.text}`);

describe('markdownTokens', () => {
  it('always adds up to the line it was given', () => {
    for (const line of [
      '# Memory - Appu', '', '   ', '- [2026-10-13] Sarthak lives in Jammu, India (wrote it as "jmu"). Timezone IST.',
      '  * nested **bold** and `code` and https://appubot.com/x.', '1. first', '> a quote', '<!-- note -->', 'plain words', '“curly” and "straight"',
      '- unclosed `tick and "quote', '**', '[2026-1-1] not a date',
    ]) expect(markdownTokens(line).map((t) => t.text).join('')).toBe(line);
  });

  it('marks a heading, an entry, code, quotes and links', () => {
    expect(kinds('# Memory - Appu')).toEqual(['heading:# Memory - Appu']);
    expect(kinds('- [2026-10-13] Lives in "jmu".')).toEqual(['marker:- ', 'date:[2026-10-13]', 'plain: Lives in ', 'string:"jmu"', 'plain:.']);
    expect(kinds('  1. run `npm test` at https://x.dev')).toEqual(['plain:  ', 'marker:1. ', 'plain:run ', 'code:`npm test`', 'plain: at ', 'link:https://x.dev']);
    expect(kinds('> said once')).toEqual(['comment:> said once']);
  });

  it('leaves ordinary prose alone', () => {
    expect(kinds("It's Sarthak's - not a list")).toEqual(["plain:It's Sarthak's - not a list"]);
    expect(kinds('#hashtag')).toEqual(['plain:#hashtag']);
  });
});
