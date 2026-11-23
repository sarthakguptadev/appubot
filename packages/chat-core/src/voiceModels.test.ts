import { describe, expect, it } from 'vitest';
import { VOICE_MODELS, voiceModelInfo, type Settings, type VoiceModelStatus } from '@appubot/protocol';
import { languageChoices, othersLabel, pickVoiceModel, pickedModel, voiceModelFacts, voiceModelRows, voiceModelSize } from './voiceModels';

const status = (phase: VoiceModelStatus['phase'] = 'missing'): VoiceModelStatus[] =>
  VOICE_MODELS.map((m) => ({ id: m.id, kind: m.kind, name: m.name, bytes: m.bytes, phase, progress: null, message: null }));
const v = (patch: Partial<Settings['voice']> = {}): Settings['voice'] => ({ sttModel: 'parakeet-unified-en', language: 'auto', ttsModel: 'supertonic-3', voice: 'F1', telegramVoiceReplies: true, ...patch });

describe('voice model rows', () => {
  it('lists a kind in the catalog’s order, the ones that don’t speak English folded', () => {
    const { rows, others } = voiceModelRows('stt', status(), v());
    expect(rows[0]!.info.id).toBe('parakeet-unified-en');
    expect(rows[0]!.picked).toBe(true);
    expect(rows.map((r) => r.info.id)).not.toContain('indicconformer-hi');
    expect(others.map((r) => r.info.id)).toEqual(['indicconformer-hi']);
    expect(othersLabel(1)).toBe('1 more that doesn’t speak English');
    expect(othersLabel(3)).toBe('3 more that don’t speak English');
    expect(voiceModelRows('tts', status(), v()).rows.map((r) => r.info.id)).toEqual(['supertonic-3', 'kokoro-en']);
    // nothing downloaded: nothing in use
    expect(voiceModelRows('stt', status(), v()).rows.some((r) => r.inUse)).toBe(false);
  });

  it('says In use of the model the computer uses: the picked one once here, else the first one here', () => {
    const models = status().map((m) => (m.id === 'supertonic-3' || m.id === 'parakeet-tdt-0.6b-v3' ? { ...m, phase: 'ready' as const } : m));
    const tts = voiceModelRows('tts', models, v({ ttsModel: 'kokoro-en' })).rows;
    expect(tts.map((r) => [r.info.id, r.picked, r.inUse])).toEqual([['supertonic-3', false, true], ['kokoro-en', true, false]]);
    const stt = voiceModelRows('stt', models, v()).rows.filter((r) => r.inUse).map((r) => r.info.id);
    expect(stt).toEqual(['parakeet-tdt-0.6b-v3']);
  });

  it('shows only what the computer offers, and describes a model this build doesn’t know by its status', () => {
    const older = status().filter((m) => ['parakeet-tdt-0.6b-v3', 'whisper-turbo', 'indicconformer-hi', 'supertonic-3'].includes(m.id));
    // an older computer: no ttsModel in its settings, Parakeet v3 picked
    const { rows } = voiceModelRows('stt', older, { sttModel: 'parakeet-tdt-0.6b-v3' });
    expect(rows.map((r) => [r.info.id, r.picked])).toEqual([['whisper-turbo', false], ['parakeet-tdt-0.6b-v3', true]]);
    expect(pickedModel('tts', { sttModel: 'whisper-turbo' })).toBe('supertonic-3');
    const newer = [...status(), { id: 'future-model', kind: 'stt', name: 'Future', bytes: 1e9, phase: 'missing', progress: null, message: null } as unknown as VoiceModelStatus];
    const last = voiceModelRows('stt', newer, v()).rows.at(-1)!;
    expect(last.info).toMatchObject({ name: 'Future', about: '' });
  });

  it('says each model’s facts in one line', () => {
    expect(voiceModelFacts(voiceModelInfo('cohere-transcribe'))).toBe('2 s · 1 in 15 words wrong · 14 languages · 2.9 GB');
    expect(voiceModelFacts(voiceModelInfo('bark-3.0-clean'))).toMatch(/^Under 1 s · English · \d+ MB$/);
    expect(voiceModelFacts(voiceModelInfo('kokoro-en'))).toMatch(/^English · 28 voices · \d+ MB$/);
    expect(voiceModelSize(145_296_838)).toBe('145 MB');
  });
});

describe('picking a model', () => {
  it('keeps the language when the new model takes it, else goes back to automatic', () => {
    expect(pickVoiceModel('stt', 'whisper-turbo', v({ sttModel: 'indicconformer-hi', language: 'hi' }))).toEqual({ sttModel: 'whisper-turbo', language: 'hi' });
    expect(pickVoiceModel('stt', 'cohere-transcribe', v({ sttModel: 'whisper-turbo', language: 'hi' }))).toEqual({ sttModel: 'cohere-transcribe', language: 'auto' });
    expect(pickVoiceModel('stt', 'cohere-transcribe', v({ sttModel: 'whisper-turbo', language: 'de' }))).toEqual({ sttModel: 'cohere-transcribe', language: 'de' });
    // a model that takes none keeps it for later
    expect(pickVoiceModel('stt', 'parakeet-tdt-0.6b-v3', v({ sttModel: 'whisper-turbo', language: 'ta' }))).toEqual({ sttModel: 'parakeet-tdt-0.6b-v3', language: 'ta' });
  });

  it('moves the voice to the new voice model’s first unless it has it', () => {
    expect(pickVoiceModel('tts', 'kokoro-en', v({ voice: 'M2' }))).toEqual({ ttsModel: 'kokoro-en', voice: 'af_heart' });
    expect(pickVoiceModel('tts', 'supertonic-3', v({ ttsModel: 'kokoro-en', voice: 'bm_lewis' }))).toEqual({ ttsModel: 'supertonic-3', voice: 'F1' });
  });

  it('asks which language only of models that take one', () => {
    expect(languageChoices('parakeet-unified-en')).toEqual([]);
    expect(languageChoices('cohere-transcribe')[0]).toBe('en');
    expect(languageChoices('whisper-turbo')[0]).toBe('auto');
    expect(languageChoices('sensevoice-small')).toEqual(['auto', 'zh', 'yue', 'en', 'ja', 'ko']);
  });
});
