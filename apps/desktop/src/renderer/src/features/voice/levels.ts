// How loud the microphone is, as a 0..1 level the turn detector and the waveform read: RMS in
// dB over an adaptive noise floor that drops at once to anything quieter and creeps up slowly, so a fan or a hum
// fades out while speech stands well above it. Pure, so it runs in tests.

/** how often the meters report (ms) */
export const LEVEL_INTERVAL_MS = 80;
/** dB a sound must stand above the noise floor before it counts at all */
const MARGIN_DB = 6;
/** dB above floor + margin that reads as full scale */
const RANGE_DB = 30;
/** how fast the floor may rise (dB per tick: about 1 dB a second), so a long sentence isn't taken for noise */
const FLOOR_RISE_DB = 0.08;
const FLOOR_MIN_DB = -90;
const FLOOR_MAX_DB = -25;

export interface LoudnessState { floor: number; level: number }

export const createLoudness = (): LoudnessState => ({ floor: -60, level: 0 });

/** RMS of a block of samples, in dBFS. */
export function rmsDb(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  return 20 * Math.log10(rms + 1e-10);
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** One meter tick: moves the noise floor and returns the smoothed loudness 0..1 (squared, so quiet stays quiet). */
export function stepLoudness(s: LoudnessState, db: number): number {
  if (db < s.floor) s.floor = Math.max(FLOOR_MIN_DB, db);
  else s.floor = Math.min(FLOOR_MAX_DB, s.floor + Math.min(db - s.floor, FLOOR_RISE_DB));
  const x = clamp01((db - s.floor - MARGIN_DB) / RANGE_DB);
  const target = x * x;
  // quick to rise, slower to fall: a word's onset shows at once, the bars settle between words
  s.level += (target - s.level) * (target > s.level ? 0.6 : 0.3);
  if (s.level < 0.001) s.level = 0;
  return s.level;
}

/** A playback level (the bot's voice has no noise to look past): -55 dBFS and below is silence, -10 full. */
export function playbackLevel(db: number): number {
  const x = clamp01((db + 55) / 45);
  return x * x;
}
