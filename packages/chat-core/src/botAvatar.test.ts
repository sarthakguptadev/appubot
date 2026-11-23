import { describe, expect, it } from 'vitest';
import { BotShape } from '@appubot/protocol';
import { BOT_BODY, botAvatarLook, botAvatarSvg, botPointerInk, mixHex, orbTones } from './botAvatar';
import { botMood, motionSeed } from './botMotion';

describe('bot avatar', () => {
  it('has a plain path body for every shape', () => {
    for (const s of BotShape.options) expect(BOT_BODY[s]).toMatch(/^M[\d\s.LQCAHVZ-]+Z$/);
  });

  it('keeps the visor and its eyes inside the 100 box, eyes inside the visor', () => {
    for (const s of BotShape.options) {
      const { visor: v, eyes } = botAvatarLook(s, '#2E8EFF');
      expect(v.x).toBeGreaterThan(0);
      expect(v.x + v.w).toBeLessThan(100);
      for (const e of eyes) {
        expect(e.x).toBeGreaterThan(v.x);
        expect(e.x + e.w).toBeLessThan(v.x + v.w);
        expect(e.y).toBeGreaterThan(v.y);
        expect(e.y + e.h).toBeLessThan(v.y + v.h);
      }
    }
  });

  it('fills the body with the colour, flat, and tints the eyes toward white', () => {
    const look = botAvatarLook('circle', '#000000');
    // flat (BOT_FLAT): one colour top to bottom, no highlight, a one-tone visor
    expect(look.fill).toEqual(['#000000', '#000000', '#000000']);
    expect(look.gloss.opacity).toBe(0);
    expect(look.glass[0]).toBe(look.glass[1]);
    expect(botAvatarSvg('circle', '#2E8EFF')).not.toContain('<ellipse');
    expect(look.eye).toBe('#9e9e9e');
    expect(mixHex('#ff0000', '#0000ff', 0.5)).toBe('#800080');
    expect(botAvatarLook('circle', '#FFFFFF').outline).toBeDefined();
    expect(botAvatarLook('circle', '#2E8EFF').outline).toBeUndefined();
  });

  it("edges a very light bot's pointer dark so it shows on white windows", () => {
    expect(botPointerInk('#2E8EFF')).toEqual({ edge: '#ffffff', ripple: '#2E8EFF' });
    const light = botPointerInk('#F4F1E8');
    expect(light.edge).toBe('#5d5c58');
    expect(light.ripple).toBe('#7a7974');
  });

  it('takes its mood from the presence badge and seeds each avatar apart', () => {
    expect(botMood(null)).toBe('rest');
    expect(botMood('working')).toBe('working');
    expect(botMood('needs-you')).toBe('needs-you');
    const seeds = [':r1:', ':r2:', ':r3:', ':r4:'].map(motionSeed);
    for (const x of seeds) expect(x >= 0 && x < 1).toBe(true);
    expect(new Set(seeds).size).toBe(seeds.length);
    expect(motionSeed(':r1:')).toBe(seeds[0]);
  });
});

describe('orbTones', () => {
  it('draws every bot’s orb in ChatGPT’s style, in its own hue', () => {
    // a blue bot gets ChatGPT's own sky
    expect(orbTones('#2E8EFF')).toEqual(['#b8e2ff', '#1c7ef2']);
    const [light, deep] = orbTones('#FF7A1F');
    expect(light).toBe('#ffcbb8');
    expect(deep).toBe('#f2731c');
    // a grey bot stays grey
    expect(orbTones('#8E8E93')).toEqual(['#dadadd', '#82828d']);
  });
});
