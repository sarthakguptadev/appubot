import { describe, expect, it } from 'vitest';
import { VOICE_MODELS, type VoiceModelStatus, type VoiceStatus } from '@appubot/protocol';
import { clock, downloadProgress, modelSize, neededModelIds, readiness } from './models';

const status = (phase: (id: string) => Partial<VoiceModelStatus>): VoiceStatus => ({
  supported: true,
  busy: { stt: false, tts: false },
  models: VOICE_MODELS.map((m) => ({ id: m.id, kind: m.kind, name: m.name, bytes: m.bytes, phase: 'missing', progress: null, message: null, ...phase(m.id) })),
});
const settings = { voice: { sttModel: 'parakeet-tdt-0.6b-v3' as const, language: 'auto', ttsModel: 'supertonic-3' as const, voice: 'F1', telegramVoiceReplies: true } };

describe('voice models', () => {
  it('needs the chosen ear and the voice, dictation only the ear', () => {
    expect(neededModelIds(settings)).toEqual(['parakeet-tdt-0.6b-v3', 'supertonic-3']);
    expect(neededModelIds(settings, 'dictate')).toEqual(['parakeet-tdt-0.6b-v3']);
  });

  it('tells whether what a use needs is there', () => {
    expect(readiness(null, settings).state).toBe('unsupported');
    expect(readiness({ ...status(() => ({})), supported: false, reason: 'No' }, settings)).toEqual({ state: 'unsupported', message: 'No' });
    expect(readiness(status(() => ({})), settings).state).toBe('missing');
    expect(readiness(status((id) => (id === 'whisper-turbo' ? {} : { phase: 'ready' })), settings).state).toBe('ready');
    expect(readiness(status((id) => (id === 'supertonic-3' ? { phase: 'error', message: 'Offline' } : {})), settings)).toEqual({ state: 'error', message: 'Offline' });
    expect(readiness(status((id) => (id === 'supertonic-3' ? { phase: 'downloading', progress: 0.5 } : { phase: 'ready' })), settings, 'dictate').state).toBe('ready');
  });

  it('weighs progress by size, with what is ready counted as done', () => {
    const r = readiness(status((id) => (id === 'supertonic-3' ? { phase: 'ready' } : { phase: 'downloading', progress: 0.5 })), settings);
    expect(r.state).toBe('downloading');
    const p = (670_478_772 * 0.5 + 145_296_838) / (670_478_772 + 145_296_838);
    expect(r.state === 'downloading' && r.progress).toBeCloseTo(p, 6);
    expect(downloadProgress(status(() => ({})).models)).toBeNull();
  });

  it('formats sizes and lengths', () => {
    expect(modelSize(145_296_838)).toBe('145 MB');
    expect(modelSize(1_036_613_791)).toBe('1.0 GB');
    expect(clock(0)).toBe('0:00');
    expect(clock(72_400)).toBe('1:12');
  });
});
