import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOT_DOTS, BOT_EASE_CSS, BOT_MORPH, BOT_MOTION, BOT_POSES, botHead, type BotMood } from '@appubot/chat-core';
import { BOT_MOTION_CSS } from './botAvatarMotion';

const rule = (selector: string) => {
  const at = BOT_MOTION_CSS.indexOf(`${selector}{`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return BOT_MOTION_CSS.slice(at + selector.length + 1, BOT_MOTION_CSS.indexOf('}', at));
};

describe('bot avatar motion CSS', () => {
  it('eases every mood to its pose with the measured curve', () => {
    for (const [mood, p] of Object.entries(BOT_POSES) as [BotMood, (typeof BOT_POSES)[BotMood]][]) {
      const h = botHead(p.turn, p.pitch);
      expect(rule(`.ab-bot[data-mood='${mood}'] .ab-bot-tilt`)).toBe(`rotate:${p.rotate}deg`);
      expect(rule(`.ab-bot[data-mood='${mood}'] .ab-bot-head`)).toBe(`scale:${h.body[0]} ${h.body[1]}`);
      expect(rule(`.ab-bot[data-mood='${mood}'] .ab-bot-face`)).toBe(`translate:${h.face.x}px ${h.face.y}px;scale:${h.face.sx} ${h.face.sy}`);
      expect(rule(`.ab-bot[data-mood='${mood}'] .ab-bot-deepL`)).toBe(`translate:${h.eyes[0].x}px 0px;scale:${h.eyes[0].s} 1`);
      expect(rule(`.ab-bot[data-mood='${mood}'] .ab-bot-deepR`)).toBe(`translate:${h.eyes[1].x}px 0px;scale:${h.eyes[1].s} 1`);
      expect(rule(`.ab-bot[data-mood='${mood}'] .ab-bot-look`)).toBe(`translate:${p.gaze[0]}px ${p.gaze[1]}px`);
      expect(rule(`.ab-bot[data-mood='${mood}'] .ab-bot-eye`)).toBe(`scale:${p.eye[0]} ${p.eye[1]}`);
      // the solid head turns and nods to the pose
      expect(rule(`.ab-bot[data-mood='${mood}'] .ab-bot-turn`)).toBe(`--ab-yaw:${p.turn};--ab-pitch:${p.pitch}`);
    }
    expect(rule('.ab-bot .ab-bot-turn')).toBe(`transition:--ab-yaw ${4 * BOT_MOTION.settle}ms ${BOT_EASE_CSS},--ab-pitch ${4 * BOT_MOTION.settle}ms ${BOT_EASE_CSS}`);
    expect(rule('.ab-bot .ab-bot-tilt')).toBe(`transition:rotate ${4 * BOT_MOTION.snap}ms ${BOT_EASE_CSS}`);
    expect(rule('.ab-bot :is(.ab-bot-head,.ab-bot-face,.ab-bot-deep)')).toBe(`transition:translate ${4 * BOT_MOTION.settle}ms ${BOT_EASE_CSS},scale ${4 * BOT_MOTION.settle}ms ${BOT_EASE_CSS}`);
    expect(rule('.ab-bot .ab-bot-look')).toBe(`transition:translate ${4 * BOT_MOTION.settle}ms ${BOT_EASE_CSS}`);
  });

  it('turns and scales every whole-body motion round the middle of the avatar, so it stays centred where it sits', () => {
    const css = readFileSync(new URL('./botAvatar.css', import.meta.url), 'utf8');
    expect(css).toContain('.ab-bot :is(.ab-bot-joy, .ab-bot-body, .ab-bot-tilt, .ab-bot-head) { transform-box: view-box; transform-origin: 50px calc(var(--ab-cy, 50) * 1px); }');
    expect(css).not.toMatch(/\.ab-bot-(joy|body|tilt|head)[^{]*\{[^}]*50% 100%/);
  });

  it('rests upright, facing you, eyes in the middle', () => {
    expect(rule(".ab-bot[data-mood='rest'] .ab-bot-tilt")).toBe('rotate:0deg');
    expect(rule(".ab-bot[data-mood='rest'] .ab-bot-face")).toBe('translate:0px 0px;scale:1 1');
    expect(rule(".ab-bot[data-mood='rest'] .ab-bot-look")).toBe('translate:0px 0px');
  });

  it('collapses into the dots on the measured timeline, turning away first, and lights them left to right', () => {
    const dots = ".ab-bot:not([data-compact]):is([data-mood='thinking'],[data-mood='working'])";
    expect(rule(`${dots} :is(.ab-bot-head,.ab-bot-face,.ab-bot-deep)`)).toBe(`transition:translate ${4 * BOT_MOTION.snap}ms ${BOT_EASE_CSS},scale ${4 * BOT_MOTION.snap}ms ${BOT_EASE_CSS}`);
    expect(rule(`${dots} .ab-bot-morph`)).toBe(`scale:${BOT_DOTS.scale};transition:scale ${4 * BOT_MOTION.settle}ms ${BOT_EASE_CSS} ${BOT_MORPH.collapse}ms`);
    expect(rule(`${dots} .ab-bot-dots`)).toBe(`opacity:1;transition:opacity 0s ${BOT_MORPH.sides[0]}ms`);
    expect(rule(`${dots} .ab-bot-mid`)).toBe(`opacity:1;transition:opacity 0s ${BOT_MORPH.lit}ms`);
    const delays = [0, 1, 2].map((d) => Number(/ab-bot-k-dot-0 1380ms linear (-?\d+)ms/.exec(rule(`${dots} .ab-bot-dot-${d}`))![1]));
    expect(delays).toEqual([BOT_MORPH.lit - 920, BOT_MORPH.lit - 460, BOT_MORPH.lit]);
  });

  it('never turns into dots in a small place: it stays itself, its eyes as at rest, and ponders, turning its head', () => {
    const compact = ".ab-bot[data-compact]:is([data-mood='thinking'],[data-mood='working'])";
    expect(BOT_MOTION_CSS).not.toContain(`${compact} .ab-bot-morph`);
    expect(BOT_MOTION_CSS).not.toContain(`${compact} .ab-bot-shape`);
    expect(BOT_MOTION_CSS).not.toContain(`${compact} .ab-bot-dots`);
    expect(BOT_MOTION_CSS).not.toMatch(/\.ab-bot\[data-grow\] \.ab-bot-core/);
    expect(BOT_MOTION_CSS).toContain('.ab-bot:not([data-compact])[data-grow] .ab-bot-core{');
    expect(rule(`${compact} :is(.ab-bot-head,.ab-bot-face,.ab-bot-deep)`)).toBe('translate:0px 0px;scale:1 1');
    // the eyes stay: nothing hides, dims or recolours them, and no dots stand in for them
    expect(BOT_MOTION_CSS).not.toContain('vdot');
    expect(BOT_MOTION_CSS).not.toMatch(new RegExp(`\\[data-compact\\][^{]*\\.ab-bot-(look|eye|pill)\\{[^}]*(opacity|fill|filter)`));
    // the head turns about, from each avatar's own point in the loop
    for (const layer of ['head', 'face', 'deepL', 'deepR', 'look']) expect(rule(`${compact} .ab-bot-${layer}`)).toMatch(/^animation:ab-bot-k-ponder-.*--ab-seed/);
  });

  it('turns toward the pointer only at rest, starts the tool routine from its beginning, and never blinks at rest', () => {
    const look = ".ab-bot[data-mood='rest'][data-look]";
    expect(rule(`${look} .ab-bot-head`)).toBe('scale:var(--ab-hx,1) var(--ab-hy,1)');
    expect(rule(`${look} .ab-bot-face`)).toBe('translate:calc(var(--ab-fx,0) * 1px) calc(var(--ab-fy,0) * 1px);scale:var(--ab-fs,1) var(--ab-fsy,1)');
    expect(rule(`${look} .ab-bot-deepL`)).toBe('translate:calc(var(--ab-dlx,0) * 1px) 0px;scale:var(--ab-dls,1) 1');
    expect(rule(`${look} .ab-bot-look`)).toBe('translate:calc(var(--ab-gx,0) * 1px) calc(var(--ab-gy,0) * 1px)');
    expect(rule(".ab-bot[data-mood='tool'] .ab-bot-body")).not.toContain('--ab-seed');
    expect(BOT_MOTION_CSS).toContain(".ab-bot[data-mood='tool'] .ab-bot-face{animation:ab-bot-k-tool-face-translate");
    // each eye its own size in the routine (the near one bigger), linear between the measured frames
    for (const eye of ['eyeL', 'eyeR']) expect(rule(`.ab-bot[data-mood='tool'] .ab-bot-${eye}`)).toBe(`animation:ab-bot-k-tool-${eye}-scale 30500ms linear infinite`);
    expect(BOT_MOTION_CSS).toMatch(/@keyframes ab-bot-k-tool-body-scale\{[^}]*\}[^@]*scale:1 -0\.91;animation-timing-function:linear/);
    expect(rule(".ab-bot[data-mood='needs-you'] .ab-bot-body")).toContain('--ab-seed');
    expect(BOT_MOTION_CSS).not.toContain('blink');
    expect(rule('.ab-bot[data-cheer] .ab-bot-joy')).toContain(`${BOT_MOTION.cheer}ms linear both`);
  });

  it('turns the solid head with animatable angles, and runs the routine without the flat flip and spin narrowing', () => {
    const css = readFileSync(new URL('./botAvatar.css', import.meta.url), 'utf8');
    expect(css).toContain("@property --ab-yaw { syntax: '<number>'; inherits: true; initial-value: 0; }");
    expect(css).toContain("@property --ab-pitch { syntax: '<number>'; inherits: true; initial-value: 0; }");
    expect(rule(".ab-bot[data-mood='rest'][data-look] .ab-bot-turn")).toBe('--ab-yaw:var(--ab-lyaw,0);--ab-pitch:var(--ab-lpitch,0)');
    expect(BOT_MOTION_CSS).toContain(".ab-bot[data-mood='tool'] .ab-bot-turn{animation:ab-bot-k-tool-turn-yaw 30500ms linear infinite,ab-bot-k-tool-turn-pitch 30500ms linear infinite}");
    expect(BOT_MOTION_CSS).toMatch(/@keyframes ab-bot-k-tool-turn-yaw\{0%\{--ab-yaw:0;/);
    const solid = rule(".ab-bot[data-solid][data-mood='tool'] .ab-bot-body");
    expect(solid).toContain('ab-bot-k-tool-body-scale-solid');
    expect(solid).toContain('ab-bot-k-tool-body-rotate ');
    expect(rule(".ab-bot[data-mood='tool'] .ab-bot-body")).not.toContain('-solid');
  });
});
