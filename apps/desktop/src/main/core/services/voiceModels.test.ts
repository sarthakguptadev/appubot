import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VOICE_MODELS } from '@appubot/protocol';
import { VOICE_MODEL_SPECS, VoiceModelsStore, fileUrl, specBytes, type VoiceModelSpec } from './voiceModels';

const body = (n: number, seed: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const A = body(5000, 1);
const B = body(3000, 2);
const spec = (bHash = sha(B)): VoiceModelSpec => ({
  id: 'supertonic-3', dir: 'tts', base: 'https://example.test/m/',
  files: [{ name: 'a.onnx', bytes: A.length, sha256: sha(A) }, { name: 'b.bin', bytes: B.length, sha256: bHash }],
});

/** serves A and B in 1000-byte chunks; `hold` keeps b.bin's stream open after its first chunk until aborted */
function fakeFetch(o: { hold?: boolean; calls?: string[] } = {}): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    o.calls?.push(url);
    const data = url.endsWith('a.onnx') ? A : url.endsWith('b.bin') ? B : null;
    if (!data) return new Response('nope', { status: 404 });
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (o.hold && url.endsWith('b.bin') && i >= 1000) {
          await new Promise<void>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
        }
        if (i >= data.length) return c.close();
        c.enqueue(new Uint8Array(data.subarray(i, i + 1000)));
        i += 1000;
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
}

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'appubot-vm-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('voice model specs', () => {
  it('add up to the sizes the protocol shows', () => {
    for (const m of VOICE_MODELS) expect(specBytes(VOICE_MODEL_SPECS[m.id])).toBe(m.bytes);
  });

  it('pin every file to a revision, each in a folder of its own model, with a sha256', () => {
    const dirs = Object.values(VOICE_MODEL_SPECS).map((s) => s.dir);
    expect(new Set(dirs).size).toBe(dirs.length);
    for (const s of Object.values(VOICE_MODEL_SPECS)) {
      expect(s.base).toMatch(/^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\/$/);
      expect(new Set(s.files.map((f) => f.name)).size).toBe(s.files.length);
      for (const f of s.files) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.bytes).toBeGreaterThan(0);
      }
    }
    // Cohere's encoder keeps its weights beside it, under the name the graph names them by
    expect(VOICE_MODEL_SPECS['cohere-transcribe'].files.map((f) => f.name)).toContain('encoder.int8.onnx.data');
  });

  it('encode each part of a file’s path in its URL', () => {
    const s: VoiceModelSpec = { id: 'qwen3-asr-0.6b', dir: 'q', base: 'https://h.test/r/resolve/abc/', files: [] };
    expect(fileUrl(s, { name: 'tokenizer/vocab.json', bytes: 1, sha256: '' })).toBe('https://h.test/r/resolve/abc/tokenizer/vocab.json');
    expect(fileUrl(s, { name: 'x', from: 'voices/!v/Mr serious', bytes: 1, sha256: '' })).toBe('https://h.test/r/resolve/abc/voices/!v/Mr%20serious');
  });
});

describe('VoiceModelsStore', () => {
  it('downloads, checks and reports progress, then is ready after a restart', async () => {
    const changes: string[] = [];
    const store = new VoiceModelsStore({ root, fetch: () => fakeFetch(), specs: { 'supertonic-3': spec() }, onChange: () => changes.push(store.state('supertonic-3').phase) });
    expect(store.state('supertonic-3').phase).toBe('missing');
    const p = store.download('supertonic-3');
    expect(store.state('supertonic-3').phase).toBe('downloading');
    expect(store.download('supertonic-3')).toBe(p);
    await p;
    expect(store.state('supertonic-3')).toEqual({ phase: 'ready', progress: null, message: null });
    expect(changes[0]).toBe('downloading');
    expect(changes.at(-1)).toBe('ready');
    expect(readdirSync(join(root, 'tts')).sort()).toEqual(['.ok', 'a.onnx', 'b.bin']);

    const again = new VoiceModelsStore({ root, specs: { 'supertonic-3': spec() } });
    expect(again.state('supertonic-3').phase).toBe('ready');
    // other hashes pinned: the marker no longer matches
    expect(new VoiceModelsStore({ root, specs: { 'supertonic-3': spec('0'.repeat(64)) } }).state('supertonic-3').phase).toBe('missing');
  });

  it('a wrong hash is an error and leaves no unchecked file behind', async () => {
    const store = new VoiceModelsStore({ root, fetch: () => fakeFetch(), specs: { 'supertonic-3': spec('f'.repeat(64)) } });
    await expect(store.download('supertonic-3')).rejects.toThrow(/damaged/);
    const st = store.state('supertonic-3');
    expect(st.phase).toBe('error');
    expect(st.message).toMatch(/Supertonic/);
    // a.onnx checked out and stays; b.bin's part is gone; no marker
    expect(readdirSync(join(root, 'tts'))).toEqual(['a.onnx']);
    // the next try hashes a.onnx again instead of fetching it
    const calls: string[] = [];
    const fixed = new VoiceModelsStore({ root, fetch: () => fakeFetch({ calls }), specs: { 'supertonic-3': spec() } });
    await fixed.download('supertonic-3');
    expect(calls).toEqual(['https://example.test/m/b.bin']);
    expect(fixed.state('supertonic-3').phase).toBe('ready');
  });

  it('cancels mid-stream: back to missing, no part file', async () => {
    const store = new VoiceModelsStore({ root, fetch: () => fakeFetch({ hold: true }), specs: { 'supertonic-3': spec() } });
    const p = store.download('supertonic-3');
    for (let i = 0; i < 100 && !existsSync(join(root, 'tts', 'b.bin.part')); i++) await new Promise((r) => setTimeout(r, 5));
    expect(store.state('supertonic-3').progress).toBeGreaterThan(0.6);
    expect(() => store.remove('supertonic-3')).toThrow(/cancel/);
    store.cancel('supertonic-3');
    await p;
    expect(store.state('supertonic-3').phase).toBe('missing');
    expect(readdirSync(join(root, 'tts'))).toEqual(['a.onnx']);
    store.remove('supertonic-3');
    expect(existsSync(join(root, 'tts'))).toBe(false);
  });

  it('fetches a file from its own path in the repo and keeps it under its name', async () => {
    const calls: string[] = [];
    const nested: VoiceModelSpec = { ...spec(), files: [{ name: 'model.onnx', from: 'hi/a.onnx', bytes: A.length, sha256: sha(A) }] };
    const store = new VoiceModelsStore({ root, fetch: () => fakeFetch({ calls }), specs: { 'supertonic-3': nested } });
    await store.download('supertonic-3');
    expect(calls).toEqual(['https://example.test/m/hi/a.onnx']);
    expect(readdirSync(join(root, 'tts')).sort()).toEqual(['.ok', 'model.onnx']);
  });

  it('keeps files in subfolders of the model’s folder, and sweeps their leftovers', async () => {
    const calls: string[] = [];
    const nested: VoiceModelSpec = { ...spec(), files: [{ name: 'tokenizer/a.onnx', bytes: A.length, sha256: sha(A) }, { name: 'b.bin', bytes: B.length, sha256: sha(B) }] };
    const store = new VoiceModelsStore({ root, fetch: () => fakeFetch({ calls }), specs: { 'supertonic-3': nested } });
    await store.download('supertonic-3');
    expect(calls).toEqual(['https://example.test/m/tokenizer/a.onnx', 'https://example.test/m/b.bin']);
    expect(readdirSync(join(root, 'tts', 'tokenizer'))).toEqual(['a.onnx']);
    expect(store.onDisk('supertonic-3')).toBe(true);
    mkdirSync(join(root, 'tts', 'tokenizer'), { recursive: true });
    writeFileSync(join(root, 'tts', 'tokenizer', 'c.json.part'), 'x');
    new VoiceModelsStore({ root, specs: { 'supertonic-3': nested } }).sweep();
    expect(readdirSync(join(root, 'tts', 'tokenizer'))).toEqual(['a.onnx']);
  });

  it('a server error is an error with its status', async () => {
    const store = new VoiceModelsStore({ root, fetch: () => fakeFetch(), specs: { 'supertonic-3': { ...spec(), files: [{ name: 'gone.bin', bytes: 1, sha256: 'x' }] } } });
    await expect(store.download('supertonic-3')).rejects.toThrow(/404/);
    expect(store.state('supertonic-3').phase).toBe('error');
    store.remove('supertonic-3');
    expect(store.state('supertonic-3').phase).toBe('missing');
  });
});
