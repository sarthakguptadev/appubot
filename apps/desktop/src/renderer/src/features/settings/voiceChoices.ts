// Settings › Voice's downloaded files: the stored models in the page's order (hearing first, then the voices), named
// by what they are. The model lists themselves are chat-core's `voiceModelRows`. Pure, so it's tested without the window.
import { VOICE_MODELS, findVoiceModel, type VoiceModelId, type VoiceModelStatus } from '@appubot/protocol';

/** "Speech · Parakeet v3", "Voice · Kokoro" */
export const storedLabel = (m: Pick<VoiceModelStatus, 'id' | 'kind' | 'name'>): string => `${m.kind === 'stt' ? 'Speech' : 'Voice'} · ${findVoiceModel(m.id)?.name ?? m.name}`;

/** the downloaded models, in the page's order, and their total size */
export function storedModels(models: readonly VoiceModelStatus[]): { models: VoiceModelStatus[]; bytes: number } {
  const order: string[] = VOICE_MODELS.map((m) => m.id);
  const rank = (id: VoiceModelId) => (order.includes(id) ? order.indexOf(id) : order.length);
  const ready = models.filter((m) => m.phase === 'ready').sort((a, b) => rank(a.id) - rank(b.id));
  return { models: ready, bytes: ready.reduce((n, m) => n + m.bytes, 0) };
}
