import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'appubot-store-voice-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const load = (voice: unknown) => {
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', voice }));
  return new Store(dir).settings.get();
};

describe('voice settings saved by another version', () => {
  it('keeps the speech model and language from before voice models, reading with Supertonic', () => {
    const s = load({ sttModel: 'whisper-turbo', language: 'ta', voice: 'M4', telegramVoiceReplies: false });
    expect(s.theme).toBe('dark');
    expect(s.voice).toEqual({ sttModel: 'whisper-turbo', language: 'ta', ttsModel: 'supertonic-3', voice: 'M4', telegramVoiceReplies: false });
  });

  it('takes a model it doesn’t know as the default instead of resetting every setting', () => {
    const s = load({ sttModel: 'a-newer-model', language: 'auto', ttsModel: 'a-newer-voice', voice: 'nova', telegramVoiceReplies: true });
    expect(s.theme).toBe('dark');
    expect(s.voice).toMatchObject({ sttModel: 'parakeet-unified-en', ttsModel: 'supertonic-3', voice: 'F1' });
  });
});
