import { describe, expect, it } from 'vitest';
import { BACKGROUNDS, DEFAULT_BACKGROUND, backgroundOf, dark, isBackgroundId, light, withBackground } from '@appubot/theme';

const channel = (v: number): number => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const luminance = ([r, g, b]: [number, number, number]): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a: [number, number, number], b: [number, number, number]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** an ink at an alpha over a solid tone */
const over = (ink: [number, number, number], alpha: number, tone: [number, number, number]): [number, number, number] =>
  ink.map((v, i) => v * alpha + tone[i]! * (1 - alpha)) as [number, number, number];
/** `rgba(r,g,b,a)` → its colour and alpha */
const rgba = (value: string): { ink: [number, number, number]; alpha: number } => {
  const n = value.match(/[\d.]+/g)!.map(Number);
  return { ink: [n[0]!, n[1]!, n[2]!], alpha: n[3] ?? 1 };
};

describe('backgrounds', () => {
  it('names each one once, the neutral one first, in plain hex', () => {
    expect(BACKGROUNDS[0]!.id).toBe(DEFAULT_BACKGROUND);
    expect(new Set(BACKGROUNDS.map((b) => b.id)).size).toBe(BACKGROUNDS.length);
    for (const b of BACKGROUNDS) for (const tones of [b.light, b.dark]) for (const tone of Object.values(tones)) expect(tone).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('keeps the neutral one as the shared light and dark colours', () => {
    const neutral = backgroundOf('neutral');
    expect(light.bg).toBe(neutral.light.page);
    expect(light.surface).toBe(neutral.light.raised);
    expect(dark.bg).toBe(neutral.dark.page);
    expect(dark.surface).toBe(neutral.dark.raised);
  });

  it('steps the same way in every one: the sidebar under the page, raised above it', () => {
    for (const b of BACKGROUNDS) {
      expect(luminance(rgb(b.dark.side)), b.id).toBeLessThan(luminance(rgb(b.dark.page)));
      expect(luminance(rgb(b.dark.page)), b.id).toBeLessThan(luminance(rgb(b.dark.raised)));
      expect(luminance(rgb(b.light.side)), b.id).toBeLessThan(luminance(rgb(b.light.page)));
      expect(luminance(rgb(b.light.page)), b.id).toBeLessThanOrEqual(luminance(rgb(b.light.raised)));
    }
  });

  it('keeps text readable on every tone of every one', () => {
    for (const b of BACKGROUNDS) {
      for (const [scheme, colors] of [['light', light], ['dark', dark]] as const) {
        const fg = rgb(colors.fg);
        const muted = rgba(colors.muted);
        for (const tone of Object.values(b[scheme])) {
          const on = rgb(tone);
          expect(contrast(fg, on), `${b.id} ${scheme} text on ${tone}`).toBeGreaterThan(12);
          expect(contrast(over(muted.ink, muted.alpha, on), on), `${b.id} ${scheme} muted on ${tone}`).toBeGreaterThan(4);
        }
      }
    }
  });

  it('falls back to the neutral one for an id it does not know', () => {
    expect(backgroundOf('nope').id).toBe('neutral');
    expect(backgroundOf(null).id).toBe('neutral');
    expect(isBackgroundId('plum')).toBe(true);
    expect(isBackgroundId('black')).toBe(false);
  });

  it('lays a background over a scheme for the phone', () => {
    const plum = backgroundOf('plum');
    const colors = withBackground(dark, plum.dark);
    expect(colors.bg).toBe(plum.dark.page);
    expect(colors.surface).toBe(plum.dark.raised);
    expect(colors.fg).toBe(dark.fg);
  });
});
