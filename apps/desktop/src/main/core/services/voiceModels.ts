/**
 * The speech models' files: where they come from (pinned Hugging Face revisions, sha256 each), where they go
 * (`<dataDir>/voice-models/<dir>/`) and whether they're there. A model is ready once every file has its size and the
 * `.ok` marker, written after every file's hash checked out, names the same hashes. Downloads stream to `<file>.part`,
 * hashing as they go, and are renamed only once the hash matches, so a file under its own name was checked; a failed
 * or cancelled download keeps the files already checked (the next try skips them after hashing them again) and drops
 * the rest. One download per model at a time: a second call joins the first.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { voiceModelInfo, type VoiceModelId, type VoiceModelPhase } from '@appubot/protocol';
import { errMsg, silentLogger, type Logger } from '../util';

export interface VoiceModelFile {
  /** its name in the model's folder (may be in a subfolder: `tokenizer/vocab.json`) */
  name: string;
  bytes: number;
  sha256: string;
  /** its path under `base` when that isn't `name` (a file in a subfolder of the repo) */
  from?: string;
}
export interface VoiceModelSpec {
  id: VoiceModelId;
  /** the folder under `voice-models` */
  dir: string;
  /** a pinned revision's `resolve/<sha>/` URL, ending in `/` */
  base: string;
  files: VoiceModelFile[];
}

export const VOICE_MODEL_SPECS: Record<VoiceModelId, VoiceModelSpec> = {
  'parakeet-tdt-0.6b-v3': {
    id: 'parakeet-tdt-0.6b-v3',
    dir: 'parakeet-tdt-0.6b-v3-int8',
    base: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/',
    files: [
      { name: 'encoder.int8.onnx', bytes: 652_184_281, sha256: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247' },
      { name: 'decoder.int8.onnx', bytes: 11_845_275, sha256: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e' },
      { name: 'joiner.int8.onnx', bytes: 6_355_277, sha256: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3' },
      { name: 'tokens.txt', bytes: 93_939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
    ],
  },
  'whisper-turbo': {
    id: 'whisper-turbo',
    dir: 'whisper-turbo-int8',
    base: 'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-turbo/resolve/2ca6ff69fc878651b770880507669577ac41c2ff/',
    files: [
      { name: 'turbo-encoder.int8.onnx', bytes: 674_716_297, sha256: 'b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b' },
      { name: 'turbo-decoder.int8.onnx', bytes: 361_080_764, sha256: '20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547' },
      { name: 'turbo-tokens.txt', bytes: 816_730, sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126' },
    ],
  },
  // AI4Bharat's IndicConformer Hindi (indicconformer_stt_hi_hybrid_ctc_rnnt_large, MIT), its CTC head as a NeMo CTC
  // model for sherpa-onnx, int8; tokens.txt is shared by the repo's 22 Indian languages
  'indicconformer-hi': {
    id: 'indicconformer-hi',
    dir: 'indicconformer-hi-int8',
    base: 'https://huggingface.co/parismitaglobalsolutions/indicconformer-sherpa-onnx/resolve/9721eb71eea141fae0982cfcdb9dd2e3d4953c4a/',
    files: [
      { name: 'model.int8.onnx', from: 'hi/model.int8.onnx', bytes: 197_595_593, sha256: '915c71e04dd7e5378a4057fdebb252b3a587188e4e99db6d7ce0909ad5ad05fa' },
      { name: 'tokens.txt', bytes: 67_605, sha256: 'ee60967630213f31951817ac8b402b92ec18cce80718a24a49b388e56672dfb2' },
    ],
  },
  // NVIDIA's Parakeet Unified English 0.6B (NVIDIA Open Model License), its offline (non-streaming) export, int8
  'parakeet-unified-en': {
    id: 'parakeet-unified-en',
    dir: 'parakeet-unified-en-0.6b-int8',
    base: 'https://huggingface.co/csukuangfj2/sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-non-streaming/resolve/8c3a10fb13408c7a7054f6898958bf1c64a8d6c7/',
    files: [
      { name: 'encoder.int8.onnx', bytes: 654_040_552, sha256: '6716910b7a0833997fec7a410494c995d70124001a0e9b66d6370d6aced577e0' },
      { name: 'decoder.int8.onnx', bytes: 7_257_753, sha256: 'a5e223392c90e75f8144cdb5eb95af7625db389e39edef2bd1a9c872b3298fe6' },
      { name: 'joiner.int8.onnx', bytes: 1_735_860, sha256: '869f43f7d24595c55581ad3bf249a935fb8a71389fbdaa7504b9f46f93140f8a' },
      { name: 'tokens.txt', bytes: 8_952, sha256: 'dc0b4584ab2e4ddbf888425c076c61b736e7356a015250db7d307e6f1a8188ff' },
    ],
  },
  // Cohere Transcribe 03-2026 (Apache 2.0), 14 languages, int8; the encoder's weights are in encoder.int8.onnx.data
  'cohere-transcribe': {
    id: 'cohere-transcribe',
    dir: 'cohere-transcribe-14-lang-int8',
    base: 'https://huggingface.co/csukuangfj2/sherpa-onnx-cohere-transcribe-14-lang-int8-2026-04-01/resolve/156a470cf08eefe706a0004f3c52d9ee567ca7a0/',
    files: [
      { name: 'encoder.int8.onnx', bytes: 3_090_822, sha256: 'cf704f8cfa90e3f0a76f9ffc05998bdf00ba9ae983192c14a85a3a5eb008b367' },
      { name: 'encoder.int8.onnx.data', bytes: 2_731_503_072, sha256: 'bcf1b7148c8518ae52df1ad2d2fc2b4e89261ea23e6c874eef1d9f55bcbaa4a3' },
      { name: 'decoder.int8.onnx', bytes: 153_250_705, sha256: '8372ca6c8ff4db8b916ca3592f5c757a715e691b9edec751ba19b29fc854baf9' },
      { name: 'tokens.txt', bytes: 207_437, sha256: '013ede043ae2480e3a9205cc34550d9686100cc682bacc90f702facdfbb93035' },
    ],
  },
  // NVIDIA's Parakeet TDT 0.6B v2 (CC BY 4.0), English, int8
  'parakeet-tdt-0.6b-v2': {
    id: 'parakeet-tdt-0.6b-v2',
    dir: 'parakeet-tdt-0.6b-v2-int8',
    base: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/resolve/1ab9323565ddb038682214b292f588070a538ce2/',
    files: [
      { name: 'encoder.int8.onnx', bytes: 652_184_296, sha256: 'a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab' },
      { name: 'decoder.int8.onnx', bytes: 7_257_753, sha256: 'b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e' },
      { name: 'joiner.int8.onnx', bytes: 1_739_080, sha256: '7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2' },
      { name: 'tokens.txt', bytes: 9_384, sha256: 'ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d' },
    ],
  },
  // Qwen3-ASR 0.6B (Apache 2.0), exported by Wasser1462, int8; its tokenizer in a folder of its own
  'qwen3-asr-0.6b': {
    id: 'qwen3-asr-0.6b',
    dir: 'qwen3-asr-0.6b-int8',
    base: 'https://huggingface.co/csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/68818b2313fe77bd06f6a7c5068ff3ef59d02b8a/',
    files: [
      { name: 'conv_frontend.onnx', bytes: 44_148_281, sha256: 'd22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e' },
      { name: 'encoder.int8.onnx', bytes: 182_491_662, sha256: '60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9' },
      { name: 'decoder.int8.onnx', bytes: 755_914_231, sha256: '4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771' },
      { name: 'tokenizer/merges.txt', bytes: 1_671_853, sha256: '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5' },
      { name: 'tokenizer/tokenizer_config.json', bytes: 12_487, sha256: '4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c' },
      { name: 'tokenizer/vocab.json', bytes: 2_776_833, sha256: 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910' },
    ],
  },
  // FunAudioLLM's SenseVoice Small (FunASR model license), Chinese, Cantonese, English, Japanese, Korean, int8
  'sensevoice-small': {
    id: 'sensevoice-small',
    dir: 'sensevoice-small-int8',
    base: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/355f4d4884d8afd08aef04b9007a8556d7b463b2/',
    files: [
      { name: 'model.int8.onnx', bytes: 237_115_547, sha256: '12ca1a2ae7ecf3e0019ef2822307ee0b5cadc9196569e379b4c4026f8205276d' },
      { name: 'tokens.txt', bytes: 315_894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' },
    ],
  },
  // Conway Research's Underdog Bark 3.0 Plus (CC BY 4.0, from Parakeet TDT 0.6B v3), converted for sherpa-onnx by
  // velddev (weights unchanged but int8); its LICENSE and NOTICE come along, as CC BY asks
  'bark-3.0-plus': {
    id: 'bark-3.0-plus',
    dir: 'underdog-bark-3.0-plus-int8',
    base: 'https://huggingface.co/velddev/Underdog-Bark-3.0-Plus-sherpa-onnx/resolve/5f95a80a9da9d392a38df8e9a6609e25be643d07/',
    files: [
      { name: 'encoder.int8.onnx', bytes: 630_748_318, sha256: 'c32c6964e13877500701f1699d2fa92a7f6bc3cd700370ba884c09901c183a16' },
      { name: 'decoder.int8.onnx', bytes: 47_658_545, sha256: '89a081f0cf1500ec64e8a45f24f0bc10d1224aa334191e7f7e6f3226365b06b8' },
      { name: 'joiner.int8.onnx', bytes: 6_123_465, sha256: 'b8fe34824c5d2ec077489e4b4f66907cb47a971e1d34fe96915e9e5427df3c89' },
      { name: 'tokens.txt', bytes: 93_939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
      { name: 'NOTICE', bytes: 613, sha256: '0d4bc9bcb50fc5b239e573a7ec5765534636c13b7d312866a9b423ad0b8621cf' },
      { name: 'LICENSE', bytes: 18_657, sha256: '9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411' },
    ],
  },
  // Conway Research's Underdog Bark 3.0 Clean (CC BY 4.0, Bark 3.0 Plus that drops fillers), converted as Plus is
  'bark-3.0-clean': {
    id: 'bark-3.0-clean',
    dir: 'underdog-bark-3.0-clean-int8',
    base: 'https://huggingface.co/velddev/Underdog-Bark-3.0-Clean-sherpa-onnx/resolve/bdcbdca05592e01e075a7a0179fe57ef0ccb50d5/',
    files: [
      { name: 'encoder.int8.onnx', bytes: 630_748_321, sha256: 'dd8b0275d775ea664f0306764f80a6d9b357ed7d7a1fc15e8269b08b14e89c47' },
      { name: 'decoder.int8.onnx', bytes: 47_658_545, sha256: '8fb0c48ed66cbc43855912e2e1b75c50037e9d8d628eef11bcb5712b7eab7681' },
      { name: 'joiner.int8.onnx', bytes: 6_123_465, sha256: '2d9a8a895f38a2e132c5c4edf9de4af638c121664329f7a86c473190700c6378' },
      { name: 'tokens.txt', bytes: 93_939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
      { name: 'NOTICE', bytes: 615, sha256: '4e627d41fa10efedd84a7dbb915711b0b73c904af1fee8bacdd4a2387bcc5a10' },
      { name: 'LICENSE', bytes: 18_657, sha256: '9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411' },
    ],
  },
  // NVIDIA's Nemotron 3.5 ASR streaming 0.6B (OpenMDW 1.1), exported with 1.12 s chunks (its most accurate), int8
  'nemotron-3.5-asr': {
    id: 'nemotron-3.5-asr',
    dir: 'nemotron-3.5-asr-1120ms-int8',
    base: 'https://huggingface.co/csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-1120ms-int8-2026-06-11/resolve/cba1c96ca5ef0e8393b50584ae153a79145dc492/',
    files: [
      { name: 'encoder.int8.onnx', bytes: 657_601_521, sha256: '2fff2166acaa535bd969fb223c1f0783d71029f143cb298bc54c2afe85abf772' },
      { name: 'decoder.int8.onnx', bytes: 14_978_075, sha256: '19f9c98fc6d0a2c33a65a43b36fdb2e914c26c0aa9764be3aebc502a1e982fb0' },
      { name: 'joiner.int8.onnx', bytes: 9_504_438, sha256: '4101c7c679a0bc30483794b27a059e34e79232aa2068d78d51231a22c8b0d7ce' },
      { name: 'tokens.txt', bytes: 131_440, sha256: '729cc103155bafa785f9cd45746cd41cabe97eab7182fc04d594129587958f8a' },
    ],
  },
  // hexgrad's Kokoro 82M v1.0 (Apache 2.0), int8: its English voices and lexicons (sherpa-onnx 2 reads Kokoro through
  // a lexicon only, no espeak-ng)
  'kokoro-en': {
    id: 'kokoro-en',
    dir: 'kokoro-1.0-en-int8',
    base: 'https://huggingface.co/csukuangfj/kokoro-int8-multi-lang-v1_0/resolve/57adb37fc0e8d4bd430cfc1b8f8c2294945b9af2/',
    files: [
      { name: 'model.int8.onnx', bytes: 114_202_993, sha256: '75635ea3b85a32d00094dcdd61a258aba87c160f7c264c304a7b3ae9d734195e' },
      { name: 'voices.bin', bytes: 28_200_960, sha256: '1c5a5b983d3d50d8586d437a51f3faa2da7919ce76a013c081e65671a3447c29' },
      { name: 'tokens.txt', bytes: 687, sha256: '6ebb6bb288f20f3ae8d004d3c2ca27697da27c037d75e81a60e2a6a663f95425' },
      { name: 'lexicon-us-en.txt', bytes: 5_956_885, sha256: '7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14' },
      { name: 'lexicon-gb-en.txt', bytes: 6_366_635, sha256: 'c4cbb37316f62210dff52718a7afcaae24f50c032cc75ab47ae67b831d1049e7' },
      { name: 'LICENSE', bytes: 11_358, sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' },
    ],
  },
  'supertonic-3': {
    id: 'supertonic-3',
    dir: 'supertonic-3-int8',
    base: 'https://huggingface.co/csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11/resolve/cca5a0e6c96e1d2c720986bf7e75fcc81dee3ae4/',
    files: [
      { name: 'duration_predictor.int8.onnx', bytes: 3_700_147, sha256: 'c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db' },
      { name: 'text_encoder.int8.onnx', bytes: 36_416_150, sha256: 'c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff' },
      { name: 'vector_estimator.int8.onnx', bytes: 78_400_833, sha256: '20cd86fa5c6effedfda0e7cffe5b0569ca401c440a0c3a1d72bf39286c0db3fd' },
      { name: 'vocoder.int8.onnx', bytes: 25_991_073, sha256: 'e923d60f53f95eb1ce235f1dc33ec56d9c057823c96fa6f8acf98f32b0da6152' },
      { name: 'unicode_indexer.bin', bytes: 262_144, sha256: '8402ca48e5189a8950138580b0fff64db6f072f24ac07cd54ba8b2fbb9883b30' },
      { name: 'voice.bin', bytes: 517_168, sha256: '67d5209b0ee8ce6c74105ffbe12fe6a7628aea3b4ba2fcb308a4a67938a93ce8' },
      { name: 'tts.json', bytes: 8_253, sha256: '42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09' },
      { name: 'LICENSE', bytes: 1_070, sha256: '0dfe0d0ba84416fe3879d9a34f4909d8d0137c78d1e95834177b0414ac096fa2' },
    ],
  },
};

export const specBytes = (spec: VoiceModelSpec): number => spec.files.reduce((n, f) => n + f.bytes, 0);

export interface ModelState { phase: VoiceModelPhase; progress: number | null; message: string | null }

/** no bytes for this long and the download gives up */
const STALL_MS = 60_000;
/** progress reaches `onChange` at most this often */
const PROGRESS_MS = 250;
const MARKER = '.ok';

interface Running { promise: Promise<void>; abort: AbortController; done: number; total: number; cancelled: boolean }

export interface VoiceModelsOptions {
  /** `<dataDir>/voice-models` */
  root: string;
  /** read at each download, so tests can swap it */
  fetch?: () => typeof fetch;
  log?: Logger;
  /** a model's state moved (progress throttled) */
  onChange?: (id: VoiceModelId) => void;
  /** override the specs (tests: small files) */
  specs?: Partial<Record<VoiceModelId, VoiceModelSpec>>;
}

export class VoiceModelsStore {
  private running = new Map<VoiceModelId, Running>();
  private errors = new Map<VoiceModelId, string>();
  private log: Logger;

  constructor(private o: VoiceModelsOptions) {
    this.log = o.log ?? silentLogger;
  }

  spec(id: VoiceModelId): VoiceModelSpec { return this.o.specs?.[id] ?? VOICE_MODEL_SPECS[id]; }
  dir(id: VoiceModelId): string { return join(this.o.root, this.spec(id).dir); }

  /** every file is there at its size and the marker names their hashes (stats only, no hashing) */
  onDisk(id: VoiceModelId): boolean {
    const spec = this.spec(id);
    const dir = this.dir(id);
    try {
      if (readFileSync(join(dir, MARKER), 'utf8') !== markerOf(spec)) return false;
      return spec.files.every((f) => statSync(join(dir, f.name)).size === f.bytes);
    } catch { return false; }
  }

  state(id: VoiceModelId): ModelState {
    const r = this.running.get(id);
    // cancelled: missing at once, though it takes a moment to wind down
    if (r?.cancelled) return { phase: 'missing', progress: null, message: null };
    if (r) return { phase: 'downloading', progress: r.total ? Math.min(1, r.done / r.total) : 0, message: null };
    const error = this.errors.get(id);
    if (error) return { phase: 'error', progress: null, message: error };
    return this.onDisk(id) ? { phase: 'ready', progress: null, message: null } : { phase: 'missing', progress: null, message: null };
  }

  downloading(id: VoiceModelId): boolean { const r = this.running.get(id); return !!r && !r.cancelled; }

  /** drops the `.part` files a crash left behind */
  sweep(): void {
    for (const id of Object.keys(VOICE_MODEL_SPECS) as VoiceModelId[]) {
      if (this.running.has(id)) continue;
      const dir = this.dir(id);
      try {
        for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) if (f.endsWith('.part')) rmSync(join(dir, f), { force: true });
      } catch { /* no folder yet */ }
    }
  }

  /** downloads what is missing (joins a download already running); rejects with why it failed, resolves on cancel */
  download(id: VoiceModelId): Promise<void> {
    const running = this.running.get(id);
    if (running?.cancelled) return running.promise.then(() => this.download(id));
    if (running) return running.promise;
    if (this.onDisk(id)) return Promise.resolve();
    const spec = this.spec(id);
    const r: Running = { promise: Promise.resolve(), abort: new AbortController(), done: 0, total: specBytes(spec), cancelled: false };
    this.errors.delete(id);
    this.running.set(id, r);
    r.promise = this.run(spec, r).then(
      () => { this.running.delete(id); this.changed(id); },
      (e: unknown) => {
        this.running.delete(id);
        if (!r.cancelled) {
          const msg = downloadError(voiceModelInfo(id).name, e);
          this.errors.set(id, msg);
          this.log.warn(`voice: ${id} download failed`, errMsg(e));
          this.changed(id);
          throw new Error(msg);
        }
        this.changed(id);
      },
    );
    this.changed(id);
    return r.promise;
  }

  cancel(id: VoiceModelId): void {
    const r = this.running.get(id);
    if (!r || r.cancelled) return;
    r.cancelled = true;
    r.abort.abort();
    this.changed(id);
  }

  cancelAll(): void { for (const id of this.running.keys()) this.cancel(id); }

  /** resolves once nothing runs for this model (a cancelled download wound down) */
  settled(id: VoiceModelId): Promise<void> { return this.running.get(id)?.promise.catch(() => undefined) ?? Promise.resolve(); }

  /** deletes the model's folder; refuses while it downloads */
  remove(id: VoiceModelId): void {
    if (this.running.has(id)) throw new Error('It is downloading: cancel the download first.');
    rmSync(this.dir(id), { recursive: true, force: true });
    this.errors.delete(id);
    this.changed(id);
  }

  private lastProgress = new Map<VoiceModelId, number>();
  private changed(id: VoiceModelId, progress = false): void {
    if (progress) {
      const now = Date.now();
      if (now - (this.lastProgress.get(id) ?? 0) < PROGRESS_MS) return;
      this.lastProgress.set(id, now);
    }
    try { this.o.onChange?.(id); } catch (e) { this.log.warn('voice: change listener failed', errMsg(e)); }
  }

  private async run(spec: VoiceModelSpec, r: Running): Promise<void> {
    const dir = this.dir(spec.id);
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, MARKER), { force: true });
    for (const f of spec.files) {
      if (r.abort.signal.aborted) throw new Error('cancelled');
      const file = join(dir, f.name);
      mkdirSync(dirname(file), { recursive: true });
      // checked before (a download that stopped later on): hash it again rather than fetch it again
      if (existsSync(file) && statSync(file).size === f.bytes && (await hashFile(file, r.abort.signal)) === f.sha256) {
        r.done += f.bytes;
        this.changed(spec.id, true);
        continue;
      }
      rmSync(file, { force: true });
      await this.fetchFile(spec, f, file, r);
    }
    writeFileSync(join(dir, MARKER), markerOf(spec));
  }

  private async fetchFile(spec: VoiceModelSpec, f: VoiceModelFile, file: string, r: Running): Promise<void> {
    const part = `${file}.part`;
    const start = r.done;
    const stall = new AbortController();
    const signal = AbortSignal.any([r.abort.signal, stall.signal]);
    let timer: NodeJS.Timeout | undefined;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => stall.abort(new Error('the download stalled')), STALL_MS); timer.unref?.(); };
    try {
      arm();
      const fetchFn = this.o.fetch?.() ?? fetch;
      const res = await fetchFn(fileUrl(spec, f), { signal, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`the server answered ${res.status}`);
      const hash = createHash('sha256');
      let size = 0;
      const meter = new Transform({
        transform: (chunk: Buffer, _enc, done) => {
          size += chunk.length;
          if (size > f.bytes) return done(new Error(`${f.name} is larger than expected`));
          hash.update(chunk);
          r.done = start + size;
          arm();
          this.changed(spec.id, true);
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), meter, createWriteStream(part), { signal });
      if (size !== f.bytes) throw new Error(`${f.name} came incomplete (${size} of ${f.bytes} bytes)`);
      if (hash.digest('hex') !== f.sha256) throw new ChecksumError(f.name);
      renameSync(part, file);
      r.done = start + f.bytes;
    } catch (e) {
      rmSync(part, { force: true });
      if (stall.signal.aborted && !r.abort.signal.aborted) throw stall.signal.reason;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** where a file is fetched: the pinned revision's URL of its path, each segment encoded */
export const fileUrl = (spec: VoiceModelSpec, f: VoiceModelFile): string => spec.base + (f.from ?? f.name).split('/').map(encodeURIComponent).join('/');

class ChecksumError extends Error {
  constructor(name: string) { super(`${name} doesn't match its checksum`); this.name = 'ChecksumError'; }
}

/** what `.ok` holds once every file checked out */
export const markerOf = (spec: VoiceModelSpec): string => JSON.stringify(spec.files.map((f) => [f.name, f.sha256]));

async function hashFile(file: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** what the user reads when a download fails */
function downloadError(name: string, e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  if (code === 'ENOSPC') return `There isn't enough free space on this computer for ${name}.`;
  if (e instanceof ChecksumError) return `${name}'s download was damaged on the way. Try again.`;
  const msg = errMsg(e);
  if (/fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|socket/i.test(msg)) return `Could not download ${name}: check the internet connection and try again.`;
  return `Could not download ${name}: ${msg}.`;
}
