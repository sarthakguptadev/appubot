import { describe, expect, it } from 'vitest';
import { BOT_DOTS, BOT_EASE_CSS, BOT_MORPH, BOT_MOTION, BOT_POSES, type BotMood } from '@appubot/chat-core';
import { BOT_MOTION_CSS } from './botAvatarMotion';

const rule = (selector: string) => {
  const at = BOT_MOTION_CSS.indexOf(`${selector}{`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return BOT_MOTION_CSS.slice(at + selector.length + 1, BOT_MOTION_CSS.indexOf('}', at));
};

describe('bot avatar motion CSS', () => {
  it('eases every mood to its pose with the measured curve', () => {
    for (const [mood, p] of Object.entries(BOT_POSES) as [BotMood, (typeof BOT_POSES)[BotMood]][]) {
      expect(rule(`.ab-bot[data-mood='${mood}'] .ab-bot-tilt`)).toBe(`rotate:${p.rotate}deg`);
      expect(rule(`.ab-bot[data-mood='${mood}'] .ab-bot-look`)).toBe(`translate:${p.gaze[0]}px ${p.gaze[1]}px`);
      expect(rule(`.ab-bot[data-mood='${mood}'] .ab-bot-eye`)).toBe(`scale:${p.eye[0]} ${p.eye[1]};rotate:${p.eyeRotate}deg`);
    }
    expect(rule('.ab-bot .ab-bot-tilt')).toBe(`transition:rotate ${4 * BOT_MOTION.snap}ms ${BOT_EASE_CSS}`);
    expect(rule('.ab-bot .ab-bot-look')).toBe(`transition:translate ${4 * BOT_MOTION.settle}ms ${BOT_EASE_CSS}`);
    expect(rule(".ab-bot[data-mood='tool'] .ab-bot-pill")).toContain('--ab-ry');
  });

  it('collapses into the dots on the measured timeline, and lights them left to right', () => {
    const dots = ".ab-bot:is([data-mood='thinking'],[data-mood='working'])";
    expect(rule(`${dots} .ab-bot-morph`)).toBe(`scale:${BOT_DOTS.scale};transition:scale ${4 * BOT_MOTION.settle}ms ${BOT_EASE_CSS} ${BOT_MORPH.collapse}ms`);
    expect(rule(`${dots} .ab-bot-dots`)).toBe(`opacity:1;transition:opacity 0s ${BOT_MORPH.sides[0]}ms`);
    expect(rule(`${dots} .ab-bot-mid`)).toBe(`opacity:1;transition:opacity 0s ${BOT_MORPH.lit}ms`);
    const delays = [0, 1, 2].map((d) => Number(/ab-bot-k-dot-0 1380ms linear (-?\d+)ms/.exec(rule(`${dots} .ab-bot-dot-${d}`))![1]));
    expect(delays).toEqual([BOT_MORPH.lit - 920, BOT_MORPH.lit - 460, BOT_MORPH.lit]);
  });

  it('follows the pointer only at rest, starts the tool wander from its beginning, and never blinks', () => {
    expect(rule(".ab-bot[data-mood='rest'][data-look] .ab-bot-look")).toBe('translate:calc(var(--ab-gx,0) * 1px) calc(var(--ab-gy,0) * 1px)');
    expect(rule(".ab-bot[data-mood='tool'] .ab-bot-body")).not.toContain('--ab-seed');
    expect(rule(".ab-bot[data-mood='needs-you'] .ab-bot-body")).toContain('--ab-seed');
    expect(BOT_MOTION_CSS).not.toContain('blink');
    expect(rule('.ab-bot[data-cheer] .ab-bot-joy')).toContain(`${BOT_MOTION.cheer}ms linear both`);
  });
});
