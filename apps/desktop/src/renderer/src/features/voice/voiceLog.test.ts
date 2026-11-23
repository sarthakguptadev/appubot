import { describe, expect, it, vi } from 'vitest';
import { VOICE_LOG_KEEP, formatVoiceEvent, voiceEvents, voiceLog } from './voiceLog';

describe('voiceLog', () => {
  it('prints every event as one line and keeps the last ones', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    for (let i = 0; i < VOICE_LOG_KEEP + 5; i++) voiceLog('heard', { n: i });
    voiceLog('cut-in rejected', { text: 'How can I help', why: 'the bot’s own words', mic: 0.6789, skip: undefined });
    expect(info).toHaveBeenCalledTimes(VOICE_LOG_KEEP + 6);
    const line = info.mock.calls.at(-1)!;
    expect(line[0]).toBe('[voice]');
    expect(line[1]).toMatch(/^\d\d:\d\d:\d\d\.\d{3} cut-in rejected text="How can I help" why="the bot’s own words" mic=0.68$/);
    const kept = voiceEvents();
    expect(kept).toHaveLength(VOICE_LOG_KEEP);
    expect(kept[0]!.data).toEqual({ n: 6 });
    expect(kept.at(-1)!.event).toBe('cut-in rejected');
    expect(formatVoiceEvent({ at: 0, event: 'voice mode ended' })).toMatch(/^\d\d:\d\d:\d\d\.000 voice mode ended$/);
    info.mockRestore();
  });
});
