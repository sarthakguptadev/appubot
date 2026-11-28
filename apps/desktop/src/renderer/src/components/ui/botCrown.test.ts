/**
 * The chief's crown on the avatar (chat-core botCrown.ts): a chief wears it wherever its avatar shows, drawn twice (the
 * part behind the head under the body, the part in front over the face), and no other bot does. It is CSS 3D only: no
 * motion of its own, so a still avatar costs nothing and reduced motion stills it with the head.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BOT_CROWN } from '@appubot/chat-core';
import { BotAvatar, CROWN_CSS } from './BotAvatar';

const draw = (props: Parameters<typeof BotAvatar>[0]) => renderToStaticMarkup(createElement(BotAvatar, props));
const crowns = (html: string) => html.match(/class="ab-crown ab-crown-(back|front)"/g) ?? [];

describe("the chief's crown", () => {
  it('is worn by a chief, behind the head and in front of it', () => {
    const html = draw({ bot: { shape: 'circle', color: '#FF7A1F', chief: true }, size: 48 });
    expect(crowns(html)).toEqual(['class="ab-crown ab-crown-back"', 'class="ab-crown ab-crown-front"']);
    expect(html.indexOf('ab-crown-back')).toBeLessThan(html.indexOf('ab-bot-clip'));
    expect(html.indexOf('ab-crown-front')).toBeGreaterThan(html.indexOf('ab-bot-clip'));
    expect(html).toContain(`fill="${BOT_CROWN.gold}"`);
    expect(html.match(/class="ab-crown-plane"/g)).toHaveLength(2 * 2 * BOT_CROWN.panels);
  });

  it('is not worn by any other bot', () => {
    expect(crowns(draw({ bot: { shape: 'circle', color: '#FF7A1F', chief: false }, size: 48 }))).toEqual([]);
    expect(crowns(draw({ bot: { shape: 'hex', color: '#4C8DFF' }, size: 20 }))).toEqual([]);
    expect(crowns(draw({ shape: 'circle', color: '#4C8DFF', size: 96 }))).toEqual([]);
    expect(crowns(draw({ bot: { shape: 'circle', color: '#FF7A1F', chief: true }, chief: false, size: 48 }))).toEqual([]);
  });

  it('sits on every shape and on a still avatar too, at any size', () => {
    for (const shape of ['square', 'triangle', 'heart', 'bear'] as const) {
      for (const size of [20, 48, 200]) expect(crowns(draw({ bot: { shape, color: '#34C759', chief: true }, size, still: true })), `${shape} ${size}`).toHaveLength(2);
    }
  });

  it('turns with the head through the same --ab-yaw and --ab-pitch, and has no motion of its own', () => {
    const rules = CROWN_CSS.split('\n').filter((l) => l.includes('ab-crown'));
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.join('')).toMatch(/var\(--ab-yaw,0\)/);
    expect(rules.join('')).toMatch(/var\(--ab-pitch,0\)/);
    expect(rules.join('')).not.toMatch(/animation|transition/);
  });
});
