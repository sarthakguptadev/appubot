/**
 * The chief's badge on the avatar (chat-core chiefBadge.ts): a chief wears it wherever its avatar is big enough to read
 * it, over the face and outside the moving head, ringed in the surface behind it; no other bot does.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CHIEF_BADGE } from '@appubot/chat-core';
import { BotAvatar } from './BotAvatar';

const draw = (props: Parameters<typeof BotAvatar>[0]) => renderToStaticMarkup(createElement(BotAvatar, props));
const badges = (html: string) => html.match(/class="ab-bot-badge[^"]*"/g) ?? [];

describe("the chief's badge", () => {
  it('is worn by a chief, over the face and outside the head that turns', () => {
    const html = draw({ bot: { shape: 'circle', color: '#FF7A1F', chief: true }, size: 48 });
    expect(badges(html)).toHaveLength(1);
    expect(html.indexOf('ab-bot-badge')).toBeGreaterThan(html.lastIndexOf('ab-bot-stage'));
    expect(html.indexOf('ab-bot-badge')).toBeGreaterThan(html.lastIndexOf('ab-bot-dots'));
    expect(html).toContain(`fill="${CHIEF_BADGE.gold}"`);
    expect(html).toMatch(/color:var\(--ab-coat-solid,var\(--ab-bg\)\)/);
    expect(html).not.toMatch(/crown/i);
  });

  it('is not worn by any other bot', () => {
    expect(badges(draw({ bot: { shape: 'circle', color: '#FF7A1F', chief: false }, size: 48 }))).toEqual([]);
    expect(badges(draw({ bot: { shape: 'hex', color: '#4C8DFF' }, size: 20 }))).toEqual([]);
    expect(badges(draw({ shape: 'circle', color: '#4C8DFF', size: 96 }))).toEqual([]);
    expect(badges(draw({ bot: { shape: 'circle', color: '#FF7A1F', chief: true }, chief: false, size: 48 }))).toEqual([]);
    expect(badges(draw({ shape: 'circle', color: '#FF7A1F', chief: true, size: 48 }))).toHaveLength(1);
  });

  it('sits on every shape and on a still avatar too, from CHIEF_BADGE.min px up', () => {
    for (const shape of ['square', 'triangle', 'heart', 'bear'] as const) {
      for (const size of [CHIEF_BADGE.min, 20, 48, 200]) expect(badges(draw({ bot: { shape, color: '#34C759', chief: true }, size, still: true })), `${shape} ${size}`).toHaveLength(1);
      expect(badges(draw({ bot: { shape, color: '#34C759', chief: true }, size: CHIEF_BADGE.min - 2 }))).toEqual([]);
    }
  });

  it('keeps its corner while the presence dot shows: the dot moves to the top-right', () => {
    const chief = draw({ bot: { shape: 'circle', color: '#FF7A1F', chief: true }, size: 36, presence: 'needs-you' });
    expect(badges(chief)).toHaveLength(1);
    expect(chief).toMatch(/class="absolute -right-px rounded-full -top-px ring-2[^"]*bg-attention/);
    expect(draw({ bot: { shape: 'circle', color: '#FF7A1F' }, size: 36, presence: 'needs-you' })).toMatch(/class="absolute -right-px rounded-full -bottom-px[^"]*bg-attention/);
  });
});
