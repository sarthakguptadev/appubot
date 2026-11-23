import { VOICE_STT_MODEL_IDS } from '@appubot/protocol';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostRequest } from './voiceHostCore';
import { HostVoiceEngine, STT_ENGINES, STT_TIMEOUT_MS, VoiceEngineError, ttsVoice, type HostChild } from './voiceEngine';

class FakeChild extends EventEmitter implements HostChild {
  sent: HostRequest[] = [];
  connected = true;
  killed = false;
  constructor(private reply?: (req: HostRequest) => unknown) { super(); }
  send(msg: unknown): boolean {
    const req = msg as HostRequest;
    this.sent.push(req);
    const res = this.reply?.(req);
    if (res) queueMicrotask(() => this.emit('message', res));
    return true;
  }
  kill(): boolean { this.killed = true; this.connected = false; queueMicrotask(() => this.emit('exit', null, 'SIGTERM')); return true; }
}

afterEach(() => vi.useRealTimers());

function engine(reply?: (req: HostRequest) => unknown, idleMs?: number) {
  const children: FakeChild[] = [];
  const e = new HostVoiceEngine({ hostPath: '/x/voiceHost.js', addonPath: '/x/addon.node', idleMs, spawn: () => { const c = new FakeChild(reply); children.push(c); return c; } });
  return { e, children };
}

const echo = (req: HostRequest) => req.type === 'transcribe' ? { id: req.id, text: `heard ${req.pcm16.length}` }
  : req.type === 'speak' ? { id: req.id, pcm16: new Int16Array(3), sampleRate: 44_100 } : { id: req.id, ok: true };

describe('HostVoiceEngine', () => {
  it('hears and speaks in two hosts of their own, matching answers by id', async () => {
    const { e, children } = engine(echo);
    const [a, b, c] = await Promise.all([
      e.transcribe({ pcm16: new Int16Array(5), model: 'whisper-turbo', modelDir: '/m/w', language: 'hi' }),
      e.transcribe({ pcm16: new Int16Array(7), model: 'parakeet-tdt-0.6b-v3', modelDir: '/m/p', language: '' }),
      e.transcribe({ pcm16: new Int16Array(9), model: 'indicconformer-hi', modelDir: '/m/i', language: 'hi' }),
    ]);
    expect([a, b, c]).toEqual(['heard 5', 'heard 7', 'heard 9']);
    const spoken = await e.speak({ text: 'Hi', language: 'en', model: 'supertonic-3', voice: 'M2', modelDir: '/m/t' });
    expect(spoken.sampleRate).toBe(44_100);
    expect(children.length).toBe(2);
    const [stt, tts] = children;
    expect(stt!.sent.map((r) => r.type === 'transcribe' && r.engine)).toEqual(['whisper', 'nemo-transducer', 'nemo-ctc']);
    expect(tts!.sent[0]).toMatchObject({ type: 'speak', engine: 'supertonic', speakerId: 6, addonPath: '/x/addon.node', language: 'en' });
    await e.shutdown();
    expect(stt!.killed && tts!.killed).toBe(true);
  });

  it('passes the host’s errors on with their kind', async () => {
    const { e } = engine((req) => ({ id: req.id, error: 'model-load-failed', detail: 'bad file' }));
    const err = await e.transcribe({ pcm16: new Int16Array(1), model: 'whisper-turbo', modelDir: '/m', language: '' }).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(VoiceEngineError);
    expect(err).toMatchObject({ code: 'model-load-failed', message: 'bad file' });
  });

  it('a host that exits fails what it was asked; the next request starts a new one', async () => {
    const { e, children } = engine();
    const p = e.transcribe({ pcm16: new Int16Array(1), model: 'whisper-turbo', modelDir: '/m', language: '' });
    children[0]!.emit('exit', 1, null);
    await expect(p).rejects.toMatchObject({ code: 'host-exited' });
    const q = e.transcribe({ pcm16: new Int16Array(1), model: 'whisper-turbo', modelDir: '/m', language: '' });
    expect(children.length).toBe(2);
    children[1]!.emit('message', { id: children[1]!.sent[0]!.id, text: 'ok' });
    await expect(q).resolves.toBe('ok');
  });

  it('times out a stuck request and lets an idle host go', async () => {
    vi.useFakeTimers();
    const stuck = engine();
    const p = stuck.e.transcribe({ pcm16: new Int16Array(1), model: 'whisper-turbo', modelDir: '/m', language: '' });
    const caught = p.catch((x: unknown) => x);
    vi.advanceTimersByTime(STT_TIMEOUT_MS + 1);
    expect(await caught).toMatchObject({ code: 'timeout' });
    expect(stuck.children[0]!.killed).toBe(true);

    const idle = engine(echo, 1000);
    const r = idle.e.speak({ text: 'x', language: 'en', model: 'supertonic-3', voice: 'F1', modelDir: '/m' });
    await vi.advanceTimersByTimeAsync(0);
    await r;
    expect(idle.children[0]!.killed).toBe(false);
    vi.advanceTimersByTime(999);
    expect(idle.children[0]!.killed).toBe(false);
    vi.advanceTimersByTime(2);
    expect(idle.children[0]!.killed).toBe(true);
  });

  it('keeps a host up while a lease runs, then lets it go once idle', async () => {
    vi.useFakeTimers();
    const { e, children } = engine(echo, 1000);
    e.hold(5000);
    const w = e.warm({ kind: 'tts', model: 'supertonic-3', voice: 'F1', modelDir: '/m' });
    await vi.advanceTimersByTimeAsync(0);
    await w;
    expect(children.length).toBe(1);
    // idle past `idleMs`, but held
    vi.advanceTimersByTime(4000);
    expect(children[0]!.killed).toBe(false);
    // renewed before it ran out
    e.hold(5000);
    vi.advanceTimersByTime(4900);
    expect(children[0]!.killed).toBe(false);
    vi.advanceTimersByTime(200);
    expect(children[0]!.killed).toBe(true);
  });

  it('asks for fewer passes when told', async () => {
    const { e, children } = engine(echo);
    await e.speak({ text: 'Hi', language: 'en', model: 'supertonic-3', voice: 'F1', modelDir: '/m', steps: 5 });
    await e.speak({ text: 'Hi', language: 'en', model: 'supertonic-3', voice: 'F1', modelDir: '/m' });
    const sent = children[0]!.sent.map((r) => (r.type === 'speak' ? r.numSteps : null));
    expect(sent).toEqual([5, undefined]);
  });

  it('runs every speech model on its engine, Underdog Bark with silence before the words', async () => {
    const { e, children } = engine(echo);
    for (const model of VOICE_STT_MODEL_IDS) await e.transcribe({ pcm16: new Int16Array(3), model, modelDir: `/m/${model}`, language: '' });
    const sent = children[0]!.sent.filter((r) => r.type === 'transcribe');
    expect(sent.map((r) => r.type === 'transcribe' && r.engine)).toEqual(VOICE_STT_MODEL_IDS.map((m) => STT_ENGINES[m].engine));
    expect(sent.find((r) => r.modelDir === '/m/bark-3.0-plus')).toMatchObject({ leadMs: 250 });
    expect(sent.find((r) => r.modelDir === '/m/parakeet-unified-en')).not.toHaveProperty('leadMs');
    expect(sent.find((r) => r.modelDir === '/m/nemotron-3.5-asr')).toMatchObject({ engine: 'nemo-streaming' });
  });

  it('reads Kokoro’s voices with their own speaker ids, the British ones with the British lexicon', async () => {
    expect(ttsVoice('kokoro-en', 'af_heart')).toEqual({ engine: 'kokoro', variant: 'us', speakerId: 3 });
    expect(ttsVoice('kokoro-en', 'bm_george')).toEqual({ engine: 'kokoro', variant: 'gb', speakerId: 26 });
    // a Supertonic voice on Kokoro reads in its first voice
    expect(ttsVoice('kokoro-en', 'F1')).toEqual({ engine: 'kokoro', variant: 'us', speakerId: 3 });
    expect(ttsVoice('supertonic-3', 'af_heart')).toEqual({ engine: 'supertonic', speakerId: 0 });
    const { e, children } = engine(echo);
    await e.speak({ text: 'Hi', language: 'en', model: 'kokoro-en', voice: 'bf_emma', modelDir: '/m/k' });
    expect(children[0]!.sent[0]).toMatchObject({ type: 'speak', engine: 'kokoro', variant: 'gb', speakerId: 21 });
  });
});
