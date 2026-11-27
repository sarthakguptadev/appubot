import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { sentBubble } from '@appubot/chat-core';
import { MicSolid, VoiceWave } from '../../components/ui/icons';

const composer = readFileSync(join(__dirname, 'Composer.tsx'), 'utf8');

describe('the composer\'s round button', () => {
  it('takes the bot\'s colour on send, voice mode and stop, with white ink', () => {
    expect(composer).toMatch(/const tone = bot \? sentBubble\(bot\.color\) : null;/);
    expect(composer).toMatch(/const roundStyle = tone \? \{ backgroundColor: tone\.fill, color: tone\.ink \} : undefined;/);
    expect(composer.match(/className=\{(?:ROUND|cn\(ROUND, 'chat-round'\))\}\s*style=\{roundStyle\}/g)).toHaveLength(5);
    expect(sentBubble('#ff7a1a').ink).toBe('#ffffff');
  });

  it('draws voice mode as five bars, the 2nd and 4th tallest, the middle half as tall, the outer two short', () => {
    const bars = [...renderToStaticMarkup(createElement(VoiceWave)).matchAll(/y1="([\d.]+)" y2="([\d.]+)"/g)].map((m) => Number(m[2]) - Number(m[1]));
    expect(bars).toHaveLength(5);
    const [a = 0, b = 0, c = 0, d = 0, e = 0] = bars;
    expect(b).toBe(d);
    expect(a).toBe(e);
    expect(b).toBeGreaterThan(c * 2 - 0.5);
    expect(c).toBeGreaterThan(a);
  });

  it('draws the mic as a filled capsule', () => {
    expect(renderToStaticMarkup(createElement(MicSolid))).toMatch(/<rect [^>]*rx="3.75" fill="currentColor"/);
  });
});
