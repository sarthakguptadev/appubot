import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('../../lib/gateway', () => ({
  rpc: (...a: unknown[]) => rpc(...a),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock('../../lib/store', () => ({ getState: () => ({ settings: { voice: { voice: 'F1', language: 'auto' } } }) }));
vi.mock('./audio', () => ({ analyserLevel: () => 0.5, fromBase64: () => new ArrayBuffer(0) }));

const { DUCK_GAIN } = await import('./bargeIn');
const { STALL_MS, Speaker, useReading } = await import('./speech');

/** A Web Audio stand-in: buffers are their length, sources end after it (unless `stall`). */
let stall = false;
const gains: { value: number }[] = [];
class Node { connect() {} disconnect() {} }
class FakeContext {
  state = 'running';
  currentTime = 0;
  sampleRate = 1000;
  destination = new Node();
  createBuffer(_channels: number, length: number, rate: number) { return { duration: length / rate }; }
  createGain() {
    const gain = { value: 1, cancelScheduledValues() {}, setTargetAtTime(v: number) { gain.value = v; } };
    gains.push(gain);
    return Object.assign(new Node(), { gain });
  }
  createAnalyser() { return Object.assign(new Node(), { fftSize: 512 }); }
  createBufferSource() {
    const src = Object.assign(new Node(), {
      buffer: null as { duration: number } | null,
      onended: null as (() => void) | null,
      start() { if (!stall) setTimeout(() => src.onended?.(), src.buffer!.duration * 1000); },
      stop() {},
    });
    return src;
  }
  resume() { return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
}

/** what voice.speak answers: the dev mock's silence, 50 ms a part */
const spoken = () => Promise.resolve({ audio: '', durationMs: 50 });

function listen(s: InstanceType<typeof Speaker>) {
  const log: string[] = [];
  s.on({
    start: (o, text) => log.push(`start ${o} ${text}`),
    idle: (o) => log.push(`idle ${o}`),
    error: (o, m) => log.push(`error ${o} ${m}`),
  });
  return log;
}

describe('Speaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('AudioContext', FakeContext);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    rpc.mockReset();
    stall = false;
    gains.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useReading.setState({ owner: null, text: '', paused: false, level: 0, startedAt: 0 });
  });

  it('asks again once when a part fails, and plays it', async () => {
    rpc.mockRejectedValueOnce(new Error('host exited')).mockImplementation(spoken);
    const s = new Speaker();
    const log = listen(s);
    s.enqueue('m1', 'Hello there.', 'en', { live: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1]![1]).toMatchObject({ text: 'Hello there.', live: true, format: 'wav' });
    expect(log).toEqual(['start m1 Hello there.', 'idle m1']);
  });

  it('skips a part that fails twice, says so, and reads on', async () => {
    rpc.mockImplementation((_m: string, p: { text: string }) => (p.text.startsWith('Broken') ? Promise.reject(new Error('voice_failed')) : spoken()));
    const s = new Speaker();
    const log = listen(s);
    s.enqueue('m1', 'Broken part.', 'en');
    s.enqueue('m1', 'Fine part.', 'en');
    await vi.advanceTimersByTimeAsync(500);
    expect(rpc.mock.calls.filter(([, p]) => (p as { text: string }).text === 'Broken part.')).toHaveLength(2);
    expect(log).toEqual(['error m1 voice_failed', 'start m1 Fine part.', 'idle m1']);
    expect(s.busy()).toBe(false);
  });

  it('doesn’t ask again for a part stopped meanwhile', async () => {
    rpc.mockImplementation(() => Promise.reject(new Error('host exited')));
    const s = new Speaker();
    const log = listen(s);
    s.enqueue('m1', 'Never mind.', 'en');
    s.stop('m1');
    await vi.advanceTimersByTimeAsync(500);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['idle m1']);
  });

  it('lets go of a part that never finishes playing', async () => {
    stall = true;
    rpc.mockImplementation(spoken);
    const s = new Speaker();
    const log = listen(s);
    s.enqueue('m1', 'Stuck.', 'en');
    await vi.advanceTimersByTimeAsync(STALL_MS - 500);
    expect(log).toEqual(['start m1 Stuck.']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(log).toEqual(['start m1 Stuck.', 'error m1 The voice stopped playing.', 'idle m1']);
    expect(useReading.getState().owner).toBeNull();
  });

  it('ducks the voice and brings it back, and a stop brings it back too', async () => {
    rpc.mockImplementation(spoken);
    const s = new Speaker();
    s.duck(true);
    s.enqueue('m1', 'Quietly.', 'en');
    await vi.advanceTimersByTimeAsync(10);
    // the chain is made ducked
    expect(gains[0]!.value).toBe(DUCK_GAIN);
    s.duck(false);
    expect(gains[0]!.value).toBe(1);
    s.duck(true);
    expect(gains[0]!.value).toBe(DUCK_GAIN);
    s.stop('m1');
    expect(gains[0]!.value).toBe(1);
  });
});
