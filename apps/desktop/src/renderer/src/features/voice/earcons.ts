/**
 * Voice mode's sound cues, ChatGPT-style: a soft chime when the conversation is ready, a tick down on mute and up on
 * unmute, and a falling chime when it ends. Made here with Web Audio (no files): sine notes with a quick attack and an
 * exponential fade, quiet and short (≤0.4 s, under the turn detector's 250 ms of speech per note), so the mic's echo
 * cancellation and the VAD never take them for the user talking.
 */
export type Earcon = 'start' | 'end' | 'mute' | 'unmute';

/** [frequency Hz, start s, length s] per note */
const NOTES: Record<Earcon, readonly (readonly [number, number, number])[]> = {
  // E5 → B5, rising: ready
  start: [[659.25, 0, 0.16], [987.77, 0.09, 0.22]],
  // B5 → E5, falling: done
  end: [[987.77, 0, 0.14], [659.25, 0.08, 0.22]],
  // one short low note (A4), one short high (E5)
  mute: [[440, 0, 0.12]],
  unmute: [[659.25, 0, 0.12]],
};
const GAIN = 0.09;

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  try {
    ctx ??= new AudioContext({ latencyHint: 'interactive' });
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

export function playEarcon(kind: Earcon): void {
  const ac = context();
  if (!ac) return;
  const t0 = ac.currentTime + 0.01;
  for (const [freq, at, len] of NOTES[kind]) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const start = t0 + at;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(GAIN, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + len);
    osc.connect(gain).connect(ac.destination);
    osc.start(start);
    osc.stop(start + len + 0.02);
  }
}
