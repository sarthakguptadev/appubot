import { z } from 'zod';

/*
 * The speech models AppuBot offers (Settings › Voice): which ones hear you (speech-to-text) and which ones read replies
 * aloud (text-to-speech), in the order the lists show them. The first of each kind is the default for a new install.
 * They run on the computer with sherpa-onnx (CPU only), downloaded once on first use into `<dataDir>/voice-models`;
 * the files of each are the desktop's `VOICE_MODEL_SPECS` (`voiceModels.ts`).
 */

export const VOICE_STT_MODEL_IDS = [
  'parakeet-unified-en', 'cohere-transcribe', 'whisper-turbo', 'parakeet-tdt-0.6b-v2', 'parakeet-tdt-0.6b-v3',
  'qwen3-asr-0.6b', 'sensevoice-small', 'bark-3.0-plus', 'bark-3.0-clean', 'nemotron-3.5-asr', 'indicconformer-hi',
] as const;
export const VOICE_TTS_MODEL_IDS = ['supertonic-3', 'kokoro-en'] as const;
export const VoiceSttModelId = z.enum(VOICE_STT_MODEL_IDS);
export type VoiceSttModelId = z.infer<typeof VoiceSttModelId>;
export const VoiceTtsModelId = z.enum(VOICE_TTS_MODEL_IDS);
export type VoiceTtsModelId = z.infer<typeof VoiceTtsModelId>;
export const VoiceModelId = z.enum([...VOICE_STT_MODEL_IDS, ...VOICE_TTS_MODEL_IDS]);
export type VoiceModelId = z.infer<typeof VoiceModelId>;
export const DEFAULT_VOICE_STT_MODEL: VoiceSttModelId = VOICE_STT_MODEL_IDS[0];
export const DEFAULT_VOICE_TTS_MODEL: VoiceTtsModelId = VOICE_TTS_MODEL_IDS[0];
export const isSttModel = (id: string): id is VoiceSttModelId => (VOICE_STT_MODEL_IDS as readonly string[]).includes(id);
export const isTtsModel = (id: string): id is VoiceTtsModelId => (VOICE_TTS_MODEL_IDS as readonly string[]).includes(id);

/** The languages Supertonic 3 reads (ISO 639-1); what `voice.speak` takes as a reading's language. */
export const SPEECH_LANGUAGES = ['ar', 'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'hi', 'hr', 'hu', 'id', 'it', 'ja', 'ko', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi'] as const;
export const SpeechLanguage = z.enum(SPEECH_LANGUAGES);
export type SpeechLanguage = z.infer<typeof SpeechLanguage>;
/** The languages Parakeet TDT v3 hears (ISO 639-1) */
export const PARAKEET_LANGUAGES = ['bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk'] as const;
/** What Whisper may be told to expect, beyond the languages the default voice reads: Bengali, Tamil, Urdu (it hears about 100) */
export const WHISPER_PICKS = [...SPEECH_LANGUAGES, 'bn', 'ta', 'ur'] as const;

/** Supertonic 3's voices: five female, five male (its speaker ids in this order). */
export const SPEECH_VOICES = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'] as const;
/**
 * A voice of the voice model in use (`VoiceModelInfo.voices[].id`); one the model doesn't have reads in its first voice.
 * A plain string on the wire: each model has voices of its own.
 */
export const SpeechVoice = z.string().min(1).max(40);
export type SpeechVoice = z.infer<typeof SpeechVoice>;

export interface SpeechVoiceInfo {
  /** what `settings.voice.voice` saves */
  id: string;
  /** for people: "Heart", "Female 1" */
  name: string;
  /** a few words after the name: "American, female" */
  about?: string;
}

/**
 * Word error rates are the Open ASR Leaderboard's English average (its own sets: meetings, earnings calls, podcasts,
 * noisy and read speech), on the date below; models not on it show none.
 */
export const ASR_LEADERBOARD = { asOf: '2026-11-02', url: 'https://huggingface.co/spaces/hf-audio/open_asr_leaderboard' } as const;

export interface VoiceModelInfo {
  id: VoiceModelId;
  kind: 'stt' | 'tts';
  /** the product name, not translated */
  name: string;
  /** a short label beside the name: "Recommended" */
  tag?: string;
  /** the download size of all its files */
  bytes: number;
  /** one line for the user: what it's for */
  about: string;
  /** which languages, for people: "English", "14 languages" */
  speaks: string;
  /** it hears (reads) English; the list folds the others under "N more that don't speak English" */
  english: boolean;
  /**
   * STT: the languages you may tell it to expect (Settings › Voice › Which language?), ISO 639-1 (SenseVoice's `yue`).
   * Absent: it takes no language (it finds it itself, or hears just one).
   */
  languages?: readonly string[];
  /** STT with `languages`: "Automatic" lets it find the language itself */
  autoLanguage?: boolean;
  /** STT: it hears any language it's told (Whisper), not only the ones offered in `languages` */
  anyLanguage?: boolean;
  /** STT: how long the text takes after you stop, measured on an Apple silicon Mac with a 6 s sentence */
  wait?: string;
  /** STT: average word error rate, % (`ASR_LEADERBOARD`) */
  wer?: number;
  /** STT: a turn is heard whole once it ends (its pieces only caption): slower per piece, or better with the whole sentence */
  hearsWhole?: boolean;
  /** STT: give it more quiet before a turn ends, since its pieces take longer to hear */
  slow?: boolean;
  /** TTS: its voices, the first the default */
  voices?: readonly SpeechVoiceInfo[];
  /** TTS: the languages it reads; others are read as English */
  reads?: readonly SpeechLanguage[];
  /** who made it and its license, credited under it in Settings › Voice (CC BY asks for it); `url`: its model card */
  credit: { by: string; license: string; url: string; note?: string };
}

const supertonicVoices: SpeechVoiceInfo[] = SPEECH_VOICES.map((v) => ({ id: v, name: `${v.startsWith('F') ? 'Female' : 'Male'} ${v.slice(1)}` }));

/** Kokoro 1.0's English voices: [speaker id in its voices.bin, id, accent and voice] */
export const KOKORO_VOICES: readonly (readonly [number, string, string])[] = [
  [3, 'af_heart', 'American, female'], [2, 'af_bella', 'American, female'], [6, 'af_nicole', 'American, female'],
  [0, 'af_alloy', 'American, female'], [1, 'af_aoede', 'American, female'], [4, 'af_jessica', 'American, female'],
  [5, 'af_kore', 'American, female'], [7, 'af_nova', 'American, female'], [8, 'af_river', 'American, female'],
  [9, 'af_sarah', 'American, female'], [10, 'af_sky', 'American, female'],
  [16, 'am_michael', 'American, male'], [13, 'am_eric', 'American, male'], [11, 'am_adam', 'American, male'],
  [12, 'am_echo', 'American, male'], [14, 'am_fenrir', 'American, male'], [15, 'am_liam', 'American, male'],
  [17, 'am_onyx', 'American, male'], [18, 'am_puck', 'American, male'], [19, 'am_santa', 'American, male'],
  [21, 'bf_emma', 'British, female'], [20, 'bf_alice', 'British, female'], [22, 'bf_isabella', 'British, female'], [23, 'bf_lily', 'British, female'],
  [26, 'bm_george', 'British, male'], [24, 'bm_daniel', 'British, male'], [25, 'bm_fable', 'British, male'], [27, 'bm_lewis', 'British, male'],
];
const kokoroVoices: SpeechVoiceInfo[] = KOKORO_VOICES.map(([, id, about]) => ({ id, name: id.slice(3, 4).toUpperCase() + id.slice(4), about }));

const COHERE_LANGUAGES = ['en', 'ar', 'de', 'el', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'vi', 'zh'] as const;
const SENSEVOICE_LANGUAGES = ['zh', 'yue', 'en', 'ja', 'ko'] as const;
/** Nemotron 3.5 ASR's transcription-ready and broad-coverage languages (its model card) */
const NEMOTRON_LANGUAGES = ['en', 'ar', 'bg', 'cs', 'da', 'de', 'es', 'et', 'fi', 'fr', 'hi', 'hr', 'hu', 'it', 'ja', 'ko', 'nb', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sv', 'tr', 'uk', 'vi', 'zh'] as const;

const NVIDIA_OPEN = 'NVIDIA Open Model License';

/** Hearing first, then the voices; each kind in the order Settings › Voice lists it. */
export const VOICE_MODELS: readonly VoiceModelInfo[] = [
  { id: 'parakeet-unified-en', kind: 'stt', name: 'Parakeet Unified English', tag: 'Recommended', bytes: 663_043_117, about: 'NVIDIA’s newest English model: fast and accurate, with punctuation.', speaks: 'English', english: true, wait: 'Under 1 s', credit: { by: 'NVIDIA', license: NVIDIA_OPEN, url: 'https://huggingface.co/nvidia/parakeet-unified-en-0.6b' } },
  { id: 'cohere-transcribe', kind: 'stt', name: 'Cohere Transcribe', tag: 'Fewest wrong words', bytes: 2_888_052_036, about: 'The fewest wrong words of these, in 14 languages. A big download.', speaks: '14 languages', english: true, languages: COHERE_LANGUAGES, wait: '2 s', wer: 6.72, credit: { by: 'Cohere Labs', license: 'Apache 2.0', url: 'https://huggingface.co/CohereLabs/cohere-transcribe-03-2026' } },
  { id: 'whisper-turbo', kind: 'stt', name: 'Whisper large-v3 turbo', bytes: 1_036_613_791, about: 'About 100 languages, Bengali, Tamil and Urdu among them. Slower than the others.', speaks: 'About 100 languages', english: true, languages: WHISPER_PICKS, autoLanguage: true, anyLanguage: true, wait: '2 s', wer: 8.68, hearsWhole: true, slow: true, credit: { by: 'OpenAI', license: 'MIT', url: 'https://huggingface.co/openai/whisper-large-v3-turbo' } },
  { id: 'parakeet-tdt-0.6b-v2', kind: 'stt', name: 'Parakeet v2', bytes: 661_190_513, about: 'The English model before Parakeet Unified.', speaks: 'English', english: true, wait: 'Under 1 s', wer: 6.91, credit: { by: 'NVIDIA', license: 'CC BY 4.0', url: 'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2' } },
  { id: 'parakeet-tdt-0.6b-v3', kind: 'stt', name: 'Parakeet v3', bytes: 670_478_772, about: '25 European languages. It finds which one you speak by itself.', speaks: '25 languages', english: true, wait: 'Under 1 s', wer: 7.03, credit: { by: 'NVIDIA', license: 'CC BY 4.0', url: 'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3' } },
  { id: 'qwen3-asr-0.6b', kind: 'stt', name: 'Qwen3-ASR 0.6B', bytes: 987_015_347, about: 'Chinese and 29 more languages. It finds which one you speak by itself.', speaks: '30 languages', english: true, wait: '2 s', wer: 6.99, slow: true, credit: { by: 'Qwen (Alibaba)', license: 'Apache 2.0', url: 'https://huggingface.co/Qwen/Qwen3-ASR-0.6B' } },
  { id: 'sensevoice-small', kind: 'stt', name: 'SenseVoice Small', bytes: 237_431_441, about: 'Chinese, Cantonese, Japanese and Korean, in a small download. Its English is weaker.', speaks: '5 languages', english: true, languages: SENSEVOICE_LANGUAGES, autoLanguage: true, wait: 'Under 1 s', credit: { by: 'FunAudioLLM (Alibaba)', license: 'FunASR Model License', url: 'https://huggingface.co/FunAudioLLM/SenseVoiceSmall' } },
  { id: 'bark-3.0-plus', kind: 'stt', name: 'Underdog Bark 3.0 Plus', bytes: 684_643_537, about: 'Parakeet, tuned for fewer wrong words in English.', speaks: 'English', english: true, wait: 'Under 1 s', credit: { by: 'Conway Research', license: 'CC BY 4.0', url: 'https://huggingface.co/ConwayResearch/Underdog-Bark-3.0-Plus', note: 'Converted for sherpa-onnx by velddev' } },
  { id: 'bark-3.0-clean', kind: 'stt', name: 'Underdog Bark 3.0 Clean', bytes: 684_643_542, about: 'English with the ums, uhs and false starts taken out.', speaks: 'English', english: true, wait: 'Under 1 s', credit: { by: 'Conway Research', license: 'CC BY 4.0', url: 'https://huggingface.co/ConwayResearch/Underdog-Bark-3.0-Clean', note: 'Converted for sherpa-onnx by velddev' } },
  { id: 'nemotron-3.5-asr', kind: 'stt', name: 'Nemotron 3.5 ASR', bytes: 682_215_474, about: 'NVIDIA’s streaming model, in 28 languages.', speaks: '28 languages', english: true, languages: NEMOTRON_LANGUAGES, autoLanguage: true, wait: 'Under 1 s', wer: 10.85, credit: { by: 'NVIDIA', license: 'OpenMDW 1.1', url: 'https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b' } },
  { id: 'indicconformer-hi', kind: 'stt', name: 'IndicConformer Hindi', bytes: 197_663_198, about: 'Hindi and Hinglish, fast and accurate (English words come out in Devanagari). Made for Indian speech by AI4Bharat.', speaks: 'Hindi', english: false, wait: 'Under 1 s', hearsWhole: true, credit: { by: 'AI4Bharat', license: 'MIT', url: 'https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual' } },

  { id: 'supertonic-3', kind: 'tts', name: 'Supertonic 3', tag: 'Recommended', bytes: 145_296_838, about: 'Reads replies in 31 languages, English and Hindi among them.', speaks: '31 languages', english: true, voices: supertonicVoices, reads: SPEECH_LANGUAGES, credit: { by: 'Supertone', license: 'OpenRAIL-M', url: 'https://huggingface.co/Supertone/supertonic-3' } },
  { id: 'kokoro-en', kind: 'tts', name: 'Kokoro', bytes: 154_739_518, about: 'Natural English voices, American and British. It may skip a name it has never seen.', speaks: 'English', english: true, voices: kokoroVoices, reads: ['en'], credit: { by: 'hexgrad', license: 'Apache 2.0', url: 'https://huggingface.co/hexgrad/Kokoro-82M' } },
];
export const voiceModelInfo = (id: VoiceModelId): VoiceModelInfo => VOICE_MODELS.find((m) => m.id === id)!;
/** a model this build knows, or undefined (a newer computer's) */
export const findVoiceModel = (id: string): VoiceModelInfo | undefined => VOICE_MODELS.find((m) => m.id === id);

/** "1 in 15 words wrong" from a word error rate in % */
export const wrongWords = (wer: number): string => `1 in ${Math.max(1, Math.round(100 / wer))} words wrong`;

/** The voice a model reads in: the one saved, if it has it, else its first. */
export function voiceFor(model: VoiceModelId | string, voice: string | undefined): string {
  const voices = findVoiceModel(model)?.voices ?? [];
  return voices.find((v) => v.id === voice)?.id ?? voices[0]?.id ?? 'F1';
}

/** The language a speech model is told to expect: one it takes, else automatic ('auto'). */
export function sttLanguageFor(model: VoiceModelId | string, language: string | undefined): string {
  const m = findVoiceModel(model);
  const raw = (language ?? 'auto').trim().toLowerCase();
  if (!m?.languages || !raw || raw === 'auto') return m?.languages && !m.autoLanguage ? m.languages[0]! : 'auto';
  const code = m.languages.includes(raw) ? raw : raw.split(/[-_]/)[0]!;
  if (m.languages.includes(code) || (m.anyLanguage && /^[a-z]{2,3}$/.test(code))) return code;
  return m.autoLanguage ? 'auto' : m.languages[0]!;
}

/**
 * Settings saved by an older AppuBot, or by one that knew models this one doesn't: a speech model it doesn't know is
 * the default one, a voice model it doesn't know the default voice model, a voice that model hasn't got its first.
 * Old `language` values stay as they were (they only apply to models that take a language).
 */
export function tidyVoiceSettings(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const v = { ...(raw as Record<string, unknown>) };
  if (typeof v.sttModel === 'string' && !isSttModel(v.sttModel)) delete v.sttModel;
  if (typeof v.ttsModel === 'string' && !isTtsModel(v.ttsModel)) delete v.ttsModel;
  const tts = typeof v.ttsModel === 'string' ? v.ttsModel : DEFAULT_VOICE_TTS_MODEL;
  if (typeof v.voice !== 'string' || voiceFor(tts, v.voice) !== v.voice) v.voice = voiceFor(tts, undefined);
  return v;
}
