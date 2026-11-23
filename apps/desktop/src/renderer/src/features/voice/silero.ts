// Silero VAD v5 (MIT, snakers4/silero-vad; the .onnx as @ricky0123/vad-web ships it) on onnxruntime-web's wasm build,
// single-threaded (no SharedArrayBuffer), in this window. Model and wasm are bundled as the app's own files and read
// from there (no fetch leaves the computer), loaded once, the first time voice mode opens. Frames are 512 samples at
// 16 kHz with the previous frame's last 64 in front and the LSTM state carried, as silero-vad's own `OnnxWrapper` does.
// About 0.15 ms a frame.
import type { InferenceSession, Tensor } from 'onnxruntime-web';
import modelUrl from './silero_vad_v5.onnx?url';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { VAD_FRAME, type VadModel } from './vad';

const CONTEXT = 64;
const RATE = 16_000;

let loading: Promise<() => VadModel> | null = null;

/** A new Silero stream (each has its own state); the runtime and model load the first time. */
export async function loadVad(): Promise<VadModel> {
  loading ??= load().catch((e: unknown) => { loading = null; throw e; });
  return (await loading)();
}

/** Starts loading the runtime and model now (voice mode opening), so the mic has them when it opens. */
export function preloadVad(): void {
  loading ??= load().catch((e: unknown) => { loading = null; throw e; });
  loading.catch(() => undefined);
}

/** A file of the app's own (fetch, else XHR where a file:// page can't fetch). */
async function bytes(url: string): Promise<ArrayBuffer> {
  try {
    const res = await fetch(url);
    if (res.ok) return await res.arrayBuffer();
  } catch { /* try XHR */ }
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('GET', url);
    x.responseType = 'arraybuffer';
    x.onload = () => (x.response instanceof ArrayBuffer && x.response.byteLength ? resolve(x.response) : reject(new Error(`couldn’t read ${url}`)));
    x.onerror = () => reject(new Error(`couldn’t read ${url}`));
    x.send();
  });
}

async function load(): Promise<() => VadModel> {
  const [ort, wasm, model] = await Promise.all([import('onnxruntime-web/wasm'), bytes(wasmUrl), bytes(modelUrl)]);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmBinary = wasm;
  ort.env.logLevel = 'error';
  const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(RATE)]), []);
  const zero = () => new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
  // one session for every stream: runs never overlap (each stream runs its frames one at a time, one stream at a time)
  let queue: Promise<unknown> = Promise.resolve();
  const run = (feeds: InferenceSession.FeedsType) => {
    const p = queue.then(() => session.run(feeds));
    queue = p.catch(() => undefined);
    return p;
  };
  return () => {
    let state: Tensor = zero();
    let context = new Float32Array(CONTEXT);
    return {
      async prob(frame) {
        if (frame.length !== VAD_FRAME) throw new Error(`a VAD frame is ${VAD_FRAME} samples`);
        const input = new Float32Array(CONTEXT + VAD_FRAME);
        input.set(context);
        input.set(frame, CONTEXT);
        context = frame.slice(VAD_FRAME - CONTEXT);
        const out = await run({ input: new ort.Tensor('float32', input, [1, input.length]), state, sr });
        state = out.stateN!;
        const p = out.output?.data[0];
        if (typeof p !== 'number') throw new Error('no output from the VAD');
        return p;
      },
      reset() {
        state = zero();
        context = new Float32Array(CONTEXT);
      },
    };
  };
}
