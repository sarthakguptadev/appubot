// The microphone's samples on the audio thread (voice mode's 16 kHz audio context, `capture.ts`): mixed down to mono,
// made 16-bit and handed to the window every 50 ms. Bundled on its own (`?worker&url`), so it imports nothing.
declare class AudioWorkletProcessor { readonly port: MessagePort }
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

/** 50 ms at 16 kHz */
const BLOCK = 800;

class PcmTap extends AudioWorkletProcessor {
  private buf = new Int16Array(BLOCK);
  private n = 0;

  process(inputs: Float32Array[][]): boolean {
    const chans = inputs[0];
    if (!chans?.length) return true;
    const len = chans[0]!.length;
    for (let i = 0; i < len; i++) {
      let v = 0;
      for (const c of chans) v += c[i]!;
      v /= chans.length;
      this.buf[this.n++] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v < 0 ? v * 32768 : v * 32767);
      if (this.n === BLOCK) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Int16Array(BLOCK);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('appubot-pcm-tap', PcmTap);

// a module of its own: the declarations above stay here
export {};
