import { describe, expect, it, vi } from 'vitest';
import { TurnClock, formatTiming, useVoiceTimings } from './timing';

describe('voice timing', () => {
  it('says each stage once, and the whole wait since you stopped', () => {
    expect(formatTiming({ id: 1, at: 0, quietMs: 700, marks: { heard: 12, sent: 20, firstText: 1300, firstPiece: 1500, firstAudio: 1900 }, segments: 2 }))
      .toBe('quiet 700 · heard 12 · sent 20 · first words 1300 · first piece 1500 · first sound 1900 ms (2600 ms after you stopped) · 2 parts');
    expect(formatTiming({ id: 2, at: 0, quietMs: 700, marks: { heard: 30 }, note: 'nothing heard' })).toBe('quiet 700 · heard 30 ms · nothing heard');
  });

  it('keeps the last turns, marking each stage only the first time', () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    useVoiceTimings.setState({ turns: [] });
    for (let i = 0; i < 25; i++) {
      const c = new TurnClock(700);
      c.mark('heard');
      const first = c.record.marks.heard;
      c.mark('heard');
      expect(c.record.marks.heard).toBe(first);
      c.mark('firstAudio');
      // closed: nothing more
      c.mark('sent');
      expect(c.record.marks.sent).toBeUndefined();
    }
    const turns = useVoiceTimings.getState().turns;
    expect(turns).toHaveLength(20);
    expect(turns.every((t) => t.marks.firstAudio !== undefined)).toBe(true);
  });
});
