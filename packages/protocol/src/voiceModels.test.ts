import { describe, expect, it } from 'vitest';
import { SettingsSchema } from './entities';
import {
  DEFAULT_VOICE_STT_MODEL, DEFAULT_VOICE_TTS_MODEL, KOKORO_VOICES, SPEECH_VOICES, VOICE_MODELS, VOICE_STT_MODEL_IDS, VOICE_TTS_MODEL_IDS,
  sttLanguageFor, tidyVoiceSettings, voiceFor, voiceModelInfo, wrongWords,
} from './voiceModels';

describe('the voice model catalog', () => {
  it('describes every model once, in each kind’s order, the first of each the default', () => {
    expect(VOICE_MODELS.filter((m) => m.kind === 'stt').map((m) => m.id)).toEqual([...VOICE_STT_MODEL_IDS]);
    expect(VOICE_MODELS.filter((m) => m.kind === 'tts').map((m) => m.id)).toEqual([...VOICE_TTS_MODEL_IDS]);
    expect(DEFAULT_VOICE_STT_MODEL).toBe('parakeet-unified-en');
    expect(DEFAULT_VOICE_TTS_MODEL).toBe('supertonic-3');
    expect(voiceModelInfo(DEFAULT_VOICE_STT_MODEL).tag).toBe('Recommended');
  });

  it('gives every voice model voices with ids of their own, and every model a credit', () => {
    for (const m of VOICE_MODELS) {
      expect(m.credit.by && m.credit.license && m.credit.url.startsWith('https://')).toBeTruthy();
      expect(m.about.length).toBeLessThan(140);
      if (m.kind !== 'tts') continue;
      expect(m.voices?.length).toBeGreaterThan(0);
      expect(new Set(m.voices!.map((v) => v.id)).size).toBe(m.voices!.length);
    }
    expect(voiceModelInfo('supertonic-3').voices!.map((v) => v.id)).toEqual([...SPEECH_VOICES]);
    // Kokoro's speaker ids are its voices.bin rows, each once
    expect(new Set(KOKORO_VOICES.map(([sid]) => sid)).size).toBe(KOKORO_VOICES.length);
  });

  it('says wrong words as one in so many', () => {
    expect(wrongWords(6.72)).toBe('1 in 15 words wrong');
    expect(wrongWords(10.85)).toBe('1 in 9 words wrong');
  });
});

describe('voiceFor', () => {
  it('keeps a voice the model has, else reads in its first', () => {
    expect(voiceFor('supertonic-3', 'M3')).toBe('M3');
    expect(voiceFor('kokoro-en', 'bm_george')).toBe('bm_george');
    expect(voiceFor('kokoro-en', 'M3')).toBe('af_heart');
    expect(voiceFor('supertonic-3', undefined)).toBe('F1');
  });
});

describe('sttLanguageFor', () => {
  it('tells a model only a language it takes', () => {
    // Whisper takes any language code
    expect(sttLanguageFor('whisper-turbo', 'auto')).toBe('auto');
    expect(sttLanguageFor('whisper-turbo', 'hi-IN')).toBe('hi');
    expect(sttLanguageFor('whisper-turbo', 'mr')).toBe('mr');
    // Cohere needs one: English unless it takes yours
    expect(sttLanguageFor('cohere-transcribe', 'auto')).toBe('en');
    expect(sttLanguageFor('cohere-transcribe', 'de')).toBe('de');
    expect(sttLanguageFor('cohere-transcribe', 'hi')).toBe('en');
    // SenseVoice finds it, or takes one of its five
    expect(sttLanguageFor('sensevoice-small', 'yue')).toBe('yue');
    expect(sttLanguageFor('sensevoice-small', 'fr')).toBe('auto');
    // Parakeet takes none
    expect(sttLanguageFor('parakeet-tdt-0.6b-v3', 'de')).toBe('auto');
  });
});

describe('settings from before voice models', () => {
  it('keeps the speech model and language someone had, and reads with Supertonic', () => {
    const old = SettingsSchema.parse({ voice: tidyVoiceSettings({ sttModel: 'indicconformer-hi', language: 'hi', voice: 'M2', telegramVoiceReplies: false }) });
    expect(old.voice).toEqual({ sttModel: 'indicconformer-hi', language: 'hi', ttsModel: 'supertonic-3', voice: 'M2', telegramVoiceReplies: false });
  });

  it('starts a new install on the first model of each kind', () => {
    expect(SettingsSchema.parse({}).voice).toEqual({ sttModel: 'parakeet-unified-en', language: 'auto', ttsModel: 'supertonic-3', voice: 'F1', telegramVoiceReplies: true });
  });

  it('takes models it doesn’t know (a newer version’s) as the defaults rather than failing', () => {
    const v = tidyVoiceSettings({ sttModel: 'some-future-model', language: 'auto', ttsModel: 'some-future-voice', voice: 'x1', telegramVoiceReplies: true });
    expect(SettingsSchema.parse({ voice: v }).voice).toMatchObject({ sttModel: 'parakeet-unified-en', ttsModel: 'supertonic-3', voice: 'F1' });
    // a voice the voice model hasn't got is its first
    expect(tidyVoiceSettings({ sttModel: 'whisper-turbo', ttsModel: 'kokoro-en', voice: 'F2' })).toMatchObject({ voice: 'af_heart' });
  });
});
