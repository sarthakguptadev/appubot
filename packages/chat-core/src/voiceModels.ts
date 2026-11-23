/**
 * Settings › Voice's model lists ("All speech models", "All voices"), shared by both apps: the rows in the catalog's
 * order (the models the computer offers, `VoiceStatus.models`, described by this build's `VOICE_MODELS`), the ones
 * that don't speak English folded under one row at the end, each row's line of facts, and what picking one saves.
 */
import {
  DEFAULT_VOICE_STT_MODEL, DEFAULT_VOICE_TTS_MODEL, VOICE_MODELS, findVoiceModel, sttLanguageFor, voiceFor, wrongWords,
  type Settings, type VoiceModelInfo, type VoiceModelStatus,
} from '@appubot/protocol';

type VoiceSettings = Settings['voice'];
export type VoiceKind = 'stt' | 'tts';

export interface VoiceModelRow {
  info: VoiceModelInfo;
  status: VoiceModelStatus;
  /** the one Settings picks for this kind */
  picked: boolean;
  /**
   * the one the computer uses now: the picked one once downloaded, else (while it downloads, or before) the first
   * downloaded one in the list, as the computer falls back to
   */
  inUse: boolean;
}

/** A size for people: 145 MB, 1.0 GB. */
export function voiceModelSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/** The model this kind uses with these settings (a computer from before voice models: Supertonic). */
export function pickedModel(kind: VoiceKind, v: Pick<VoiceSettings, 'sttModel'> & { ttsModel?: string } | undefined): string {
  return kind === 'stt' ? (v?.sttModel ?? DEFAULT_VOICE_STT_MODEL) : (v?.ttsModel ?? DEFAULT_VOICE_TTS_MODEL);
}

/** A model this build doesn't describe (a newer computer's): what its status says. */
function describe(s: VoiceModelStatus): VoiceModelInfo {
  return findVoiceModel(s.id) ?? { id: s.id, kind: s.kind, name: s.name, bytes: s.bytes, about: '', speaks: '', english: true, credit: { by: '', license: '', url: '' } };
}

/**
 * The rows of one kind: the English-speaking ones (`rows`, the catalog's order, the first one the default) and the
 * others (`others`, behind "N more that don't speak English").
 */
export function voiceModelRows(kind: VoiceKind, models: readonly VoiceModelStatus[], v: Parameters<typeof pickedModel>[1]): { rows: VoiceModelRow[]; others: VoiceModelRow[] } {
  const order = VOICE_MODELS.map((m) => m.id as string);
  const rank = (id: string) => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
  const picked = pickedModel(kind, v);
  const all = models
    .filter((m) => m.kind === kind)
    .slice()
    .sort((a, b) => rank(a.id) - rank(b.id))
    .map((status): VoiceModelRow => ({ info: describe(status), status, picked: status.id === picked, inUse: false }));
  const used = all.find((r) => r.picked && r.status.phase === 'ready') ?? all.find((r) => r.status.phase === 'ready');
  if (used) used.inUse = true;
  return { rows: all.filter((r) => r.info.english), others: all.filter((r) => !r.info.english) };
}

/** "1 more that doesn't speak English", "3 more that don't speak English" */
export const othersLabel = (n: number): string => `${n} more that ${n === 1 ? 'doesn’t' : 'don’t'} speak English`;

/** The muted line under a row: "Under 1 s · 1 in 15 words wrong · 14 languages · 2.9 GB" (a voice: its voices). */
export function voiceModelFacts(info: VoiceModelInfo, bytes = info.bytes): string {
  const parts: string[] = [];
  if (info.kind === 'stt') {
    if (info.wait) parts.push(info.wait);
    if (info.wer) parts.push(wrongWords(info.wer));
  }
  if (info.speaks) parts.push(info.speaks);
  if (info.kind === 'tts' && info.voices?.length) parts.push(info.voices.length === 1 ? '1 voice' : `${info.voices.length} voices`);
  parts.push(voiceModelSize(bytes));
  return parts.join(' · ');
}

/** Whether Settings › Voice asks which language to expect, and the codes it offers ('auto' first where it finds it). */
export function languageChoices(model: string): string[] {
  const m = findVoiceModel(model);
  if (!m?.languages) return [];
  return [...(m.autoLanguage ? ['auto'] : []), ...m.languages];
}

/**
 * What picking a model saves. A speech model keeps the language you set when it takes that one (else it goes back to
 * automatic; a model that takes none keeps it for later); a voice model keeps your voice when it has it, else its first.
 */
export function pickVoiceModel(kind: VoiceKind, id: string, v: VoiceSettings): Partial<VoiceSettings> {
  if (kind === 'tts') return { ttsModel: id as VoiceSettings['ttsModel'], voice: voiceFor(id, v.voice) };
  const m = findVoiceModel(id);
  const language = m?.languages && v.language !== 'auto' && sttLanguageFor(id, v.language) !== v.language.split(/[-_]/)[0] ? 'auto' : v.language;
  return { sttModel: id as VoiceSettings['sttModel'], language };
}

/** The language a speech model will be told, as Settings shows it ('auto' where it finds it). */
export const shownLanguage = (v: Pick<VoiceSettings, 'sttModel' | 'language'>): string => sttLanguageFor(v.sttModel, v.language);
