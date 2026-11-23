import { describe, expect, it } from 'vitest';
import { safeName } from './files';

describe('safeName', () => {
  it('makes names every OS can save', () => {
    expect(safeName('What?.mp3')).toBe('What_.mp3');
    expect(safeName('AC"DC" <live>|*.m4a')).toBe('AC_DC_ _live___.m4a');
    expect(safeName('C:\\Users\\a\\song.mp3')).toBe('song.mp3');
    expect(safeName('notes. ')).toBe('notes');
    expect(safeName('con.txt')).toBe('_con.txt');
    expect(safeName('..')).toBe('file');
    expect(safeName(`${'a'.repeat(300)}.mp3`)).toMatch(/^a{176}\.mp3$/);
  });
});
