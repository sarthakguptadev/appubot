import { describe, expect, it } from 'vitest';
import { END_OPEN_CAREFUL_MS, END_OPEN_MS, END_SENTENCE_CAREFUL_MS, END_SENTENCE_MS, carefulHearing, endQuietMs, endsSentence, junkHeard, pcmPeakDb, silenceHallucination, tooQuiet } from './endpoint';
import { speechWords } from './bargeIn';

const tone = (amp: number, ms = 500) => Int16Array.from({ length: ms * 16 }, (_, i) => Math.round(amp * Math.sin(i / 3)));

describe('endpoint', () => {
  it('knows a finished sentence, in Hindi too', () => {
    expect(endsSentence('What is the time?')).toBe(true);
    expect(endsSentence('मुझे बताओ।')).toBe(true);
    expect(endsSentence('He said “go.”')).toBe(true);
    expect(endsSentence('Well…')).toBe(true);
    expect(endsSentence('अच्छा मुझे पताओ इंडिया की क')).toBe(false);
    expect(endsSentence('I want to')).toBe(false);
  });

  it('waits longer mid-sentence, and longer still for Whisper or another language', () => {
    expect(endQuietMs('Done.', false)).toBe(END_SENTENCE_MS);
    expect(endQuietMs('and then', false)).toBe(END_OPEN_MS);
    expect(endQuietMs(null, false)).toBe(END_OPEN_MS);
    expect(endQuietMs('हो गया।', true)).toBe(END_SENTENCE_CAREFUL_MS);
    expect(endQuietMs('आपका नाम के आपका', true)).toBe(END_OPEN_CAREFUL_MS);
    expect([END_SENTENCE_MS, END_OPEN_MS, END_SENTENCE_CAREFUL_MS, END_OPEN_CAREFUL_MS]).toEqual([700, 1500, 900, 1800]);
    expect(carefulHearing({ sttModel: 'whisper-turbo', language: 'auto' })).toBe(true);
    expect(carefulHearing({ sttModel: 'parakeet-tdt-0.6b-v3', language: 'de' })).toBe(true);
    expect(carefulHearing({ sttModel: 'parakeet-tdt-0.6b-v3', language: 'en' })).toBe(false);
    expect(carefulHearing({ sttModel: 'parakeet-tdt-0.6b-v3', language: 'auto' })).toBe(false);
    expect(carefulHearing({ sttModel: 'qwen3-asr-0.6b', language: 'auto' })).toBe(true);
    expect(carefulHearing({ sttModel: 'parakeet-unified-en', language: 'auto' })).toBe(false);
    expect(carefulHearing({ sttModel: 'qwen3-asr-0.6b', language: 'auto' })).toBe(true);
    expect(carefulHearing({ sttModel: 'parakeet-unified-en', language: 'auto' })).toBe(false);
  });

  it('measures a peak and calls far-below-your-voice quiet', () => {
    expect(pcmPeakDb(tone(16000))).toBeGreaterThan(-10);
    expect(pcmPeakDb(tone(30))).toBeLessThan(-55);
    expect(pcmPeakDb(new Int16Array(0))).toBe(-100);
    expect(tooQuiet(-59, null)).toBe(true);
    expect(tooQuiet(-30, null)).toBe(false);
    expect(tooQuiet(-46, -20)).toBe(true);
    expect(tooQuiet(-40, -20)).toBe(false);
  });

  it('knows what Whisper writes for silence', () => {
    for (const t of ['you', 'Thank you.', 'Thanks for watching!', 'Bye.', '.', 'जो जो जो जो जो', 'thank you thank you thank you']) expect(silenceHallucination(t)).toBe(true);
    for (const t of ['', 'जो', 'Thank you, that’s enough', 'what is the time', 'no no']) expect(silenceHallucination(t)).toBe(false);
    expect(junkHeard('you', -57, -20)).toBe(true);
    expect(junkHeard('you', -15, -20)).toBe(false);
    expect(junkHeard('जो जो जो जो जो', -59, null)).toBe(true);
    expect(junkHeard('मुझे बताओ', -59, null)).toBe(false);
  });

  it('keeps Devanagari words whole', () => {
    expect(speechWords('नमस्ते, आप कैसे हैं?')).toEqual(['नमस्ते', 'आप', 'कैसे', 'हैं']);
  });
});
