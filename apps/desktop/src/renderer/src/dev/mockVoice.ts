/**
 * Dev-only: speech for the mock gateway. Models start missing (`?voice=ready` has the default ones and Parakeet v3
 * downloaded, `?voice=off` makes
 * this computer unable to run them); a download moves to ready in about three seconds. Transcribing always hears the
 * same sentence; speaking returns no audio, only how long it would take (the renderer's speaker waits that long).
 */
import { DEFAULT_VOICE_STT_MODEL, DEFAULT_VOICE_TTS_MODEL, VOICE_MODELS, newId, type FileAttachment, type VoiceModelId, type VoiceModelStatus, type VoiceStatus } from '@appubot/protocol';
import { GatewayError } from '../lib/gateway';
import type { Handlers } from './mockHandlers';
import type { MockGateway } from './MockGateway';

type VoiceHandlers = Pick<Handlers, 'voice.status' | 'voice.models.download' | 'voice.models.cancel' | 'voice.models.remove' | 'voice.prepare' | 'voice.warm' | 'voice.transcribe' | 'voice.speak'>;

const option = (): string | null => (typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('voice'));

const READY: string[] = [DEFAULT_VOICE_STT_MODEL, 'parakeet-tdt-0.6b-v3', DEFAULT_VOICE_TTS_MODEL];

export function mockVoiceStatus(): VoiceStatus {
  const ready = option() === 'ready';
  return {
    supported: option() !== 'off',
    ...(option() === 'off' ? { reason: 'Speech needs a 64-bit Mac or PC.' } : {}),
    models: VOICE_MODELS.map((m): VoiceModelStatus => ({
      id: m.id, kind: m.kind, name: m.name, bytes: m.bytes,
      phase: ready && READY.includes(m.id) ? 'ready' : 'missing', progress: null, message: null,
    })),
    busy: { stt: false, tts: false },
  };
}

export function createVoiceHandlers(g: MockGateway): VoiceHandlers {
  const timers = new Map<VoiceModelId, ReturnType<typeof setInterval>>();
  const status = (): VoiceStatus => g.db.voice ?? (g.db.voice = mockVoiceStatus());
  const put = (id: VoiceModelId, patch: Partial<VoiceModelStatus>): VoiceStatus => {
    const cur = status();
    g.db.voice = { ...cur, models: cur.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) };
    g.emit('voice.status', g.db.voice);
    return g.db.voice;
  };
  const stop = (id: VoiceModelId) => { clearInterval(timers.get(id)); timers.delete(id); };
  const download = (id: VoiceModelId): VoiceStatus => {
    const m = status().models.find((x) => x.id === id);
    if (!status().supported) throw new GatewayError('voice_unsupported', status().reason ?? 'Not supported');
    if (!m || m.phase === 'ready' || m.phase === 'downloading') return status();
    let progress = 0;
    const t = setInterval(() => {
      progress = Math.min(1, progress + 0.04 + Math.random() * 0.05);
      if (progress >= 1) { stop(id); put(id, { phase: 'ready', progress: null, message: null }); } else put(id, { progress });
    }, 150);
    timers.set(id, t);
    return put(id, { phase: 'downloading', progress: 0, message: null });
  };
  const tts = (): VoiceModelId => g.db.settings.voice.ttsModel ?? DEFAULT_VOICE_TTS_MODEL;
  const ready = (id: VoiceModelId) => status().models.find((m) => m.id === id)?.phase === 'ready';
  return {
    'voice.status': () => status(),
    'voice.models.download': (p) => download(p.id),
    'voice.models.cancel': (p) => { stop(p.id); return put(p.id, { phase: 'missing', progress: null }); },
    'voice.models.remove': (p) => { stop(p.id); return put(p.id, { phase: 'missing', progress: null }); },
    'voice.prepare': () => {
      download(g.db.settings.voice.sttModel);
      return download(tts());
    },
    'voice.warm': () => ({ stt: ready(g.db.settings.voice.sttModel), tts: ready(tts()) }),
    'voice.transcribe': (p) => {
      if (!ready(g.db.settings.voice.sttModel)) throw new GatewayError('voice_not_ready', 'The speech model is not downloaded yet.');
      // pcm16 is 2 bytes a sample at 16 kHz; base64 is 4 characters for 3 bytes
      const durationMs = p.format === 'pcm16' ? Math.round((p.audio.length * 3) / 4 / 2 / 16) : 3000;
      let recording: FileAttachment | undefined;
      if (p.keep) {
        const id = newId('f');
        recording = { id, name: `Recording ${new Date().toLocaleTimeString()}.webm`, mimeType: 'audio/webm', size: p.audio.length, url: `/files/${id}` };
        g.files = [recording, ...g.files];
      }
      return { text: 'This is what you said in the mock.', durationMs, ...(recording ? { recording } : {}) };
    },
    'voice.speak': (p) => {
      if (!ready(tts())) throw new GatewayError('voice_not_ready', 'The voice model is not downloaded yet.');
      // about 15 characters a second, like a voice reading
      return { audio: '', mimeType: p.format === 'wav' ? 'audio/wav' as const : 'audio/ogg' as const, durationMs: Math.max(800, Math.round((p.text.length / 15) * 1000)), language: p.language ?? 'en' };
    },
  };
}
