import { describe, expect, it } from 'vitest';
import type { VoiceModelStatus } from '@appubot/protocol';
import { storedLabel, storedModels } from './voiceChoices';

const model = (id: VoiceModelStatus['id'], phase: VoiceModelStatus['phase'], bytes: number): VoiceModelStatus =>
  ({ id, kind: id === 'supertonic-3' || id === 'kokoro-en' ? 'tts' : 'stt', name: id, bytes, phase, progress: null, message: null });

describe('storage', () => {
  it('lists only downloaded models, hearing first, with their total', () => {
    const { models, bytes } = storedModels([
      model('kokoro-en', 'ready', 50),
      model('supertonic-3', 'ready', 100),
      model('whisper-turbo', 'downloading', 1000),
      model('indicconformer-hi', 'ready', 20),
      model('parakeet-tdt-0.6b-v3', 'missing', 600),
    ]);
    expect(models.map(storedLabel)).toEqual(['Speech · IndicConformer Hindi', 'Voice · Supertonic 3', 'Voice · Kokoro']);
    expect(bytes).toBe(170);
  });
});
