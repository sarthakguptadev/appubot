// What voice needs downloaded with the current settings (the speech-to-text model picked in Settings › Voice and the
// voice), and how far their downloads are. Pure, shared by the voice panel, dictation, the chat's notice and Settings.
import { DEFAULT_VOICE_STT_MODEL, DEFAULT_VOICE_TTS_MODEL, type Settings, type VoiceModelId, type VoiceModelStatus, type VoiceStatus } from '@appubot/protocol';

export type VoiceUse = 'converse' | 'dictate';

/** The models a use needs: dictation only hears, a conversation also speaks (the voice model Settings picks). */
export function neededModelIds(settings: Pick<Settings, 'voice'> | null, use: VoiceUse = 'converse'): VoiceModelId[] {
  const stt = settings?.voice.sttModel ?? DEFAULT_VOICE_STT_MODEL;
  // a computer from before voice models had no `ttsModel`: Supertonic
  return use === 'dictate' ? [stt] : [stt, settings?.voice.ttsModel ?? DEFAULT_VOICE_TTS_MODEL];
}

export function neededModels(status: VoiceStatus | null, settings: Pick<Settings, 'voice'> | null, use: VoiceUse = 'converse'): VoiceModelStatus[] {
  if (!status) return [];
  const ids = neededModelIds(settings, use);
  return status.models.filter((m) => ids.includes(m.id));
}

/** Byte-weighted progress (0..1) of models being downloaded; null when none is. */
export function downloadProgress(models: VoiceModelStatus[]): number | null {
  const down = models.filter((m) => m.phase === 'downloading');
  if (!down.length) return null;
  const total = down.reduce((n, m) => n + m.bytes, 0) || 1;
  return down.reduce((n, m) => n + m.bytes * (m.progress ?? 0), 0) / total;
}

export type Readiness = { state: 'ready' } | { state: 'downloading'; progress: number } | { state: 'missing' } | { state: 'error'; message: string } | { state: 'unsupported'; message: string };

/** Whether what a use needs is there. */
export function readiness(status: VoiceStatus | null, settings: Pick<Settings, 'voice'> | null, use: VoiceUse = 'converse'): Readiness {
  if (!status) return { state: 'unsupported', message: 'Voice needs a newer AppuBot.' };
  if (!status.supported) return { state: 'unsupported', message: status.reason ?? 'Voice doesn’t run on this computer.' };
  const models = neededModels(status, settings, use);
  const failed = models.find((m) => m.phase === 'error');
  if (failed) return { state: 'error', message: failed.message ?? `${failed.name} couldn’t be downloaded.` };
  if (models.every((m) => m.phase === 'ready')) return { state: 'ready' };
  return models.some((m) => m.phase === 'downloading') ? { state: 'downloading', progress: weighted(models) } : { state: 'missing' };
}

/**
 * A computer's voice (the one its Settings › Voice picks) is downloaded: what one that only reads aloud needs before
 * it reads (your AppuBot computer, `VoiceStatus.speaks`; voiceRoute.ts).
 */
export function voiceModelReady(status: VoiceStatus | null | undefined, settings: Pick<Settings, 'voice'> | null | undefined): boolean {
  const id = settings?.voice.ttsModel ?? DEFAULT_VOICE_TTS_MODEL;
  return status?.models.find((m) => m.id === id)?.phase === 'ready';
}

/** Progress over everything a use needs (ready models count as done), so the bar never jumps back. */
function weighted(models: VoiceModelStatus[]): number {
  const total = models.reduce((n, m) => n + m.bytes, 0) || 1;
  return models.reduce((n, m) => n + m.bytes * (m.phase === 'ready' ? 1 : m.phase === 'downloading' ? (m.progress ?? 0) : 0), 0) / total;
}

export const percent = (x: number): string => `${Math.floor(x * 100)}%`;

/** A size for people: 145 MB, 1.0 GB. */
export function modelSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/** m:ss */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
