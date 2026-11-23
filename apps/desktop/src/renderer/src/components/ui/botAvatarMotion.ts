/**
 * The bot avatar's motion as CSS, from chat-core's tracks (BOT_LOOPS, BOT_BLINK, BOT_CHEER) and timings (BOT_MOTION):
 * one `@keyframes` per track and the `.ab-bot` rules that run them per mood, the blink, and the cheer
 * (`[data-cheer]`). botAvatar.css holds the rest (layers' origins, hover and press, the visor's sweep, still and
 * reduced motion). Used by the app's BotAvatar.tsx (injected once into the document) and by the agent cursor's overlay
 * page in the main process (as text), so both bots move alike. Pure TS on purpose: tsconfig.node.json includes it.
 */
import { BOT_BLINK, BOT_CHEER, BOT_LOOPS, BOT_MOTION as M, type BotMood, type BotTrack, type MotionEase, type MotionValue } from '@appubot/chat-core';

/** The custom properties botAvatar.css still uses (the overlay page puts them on :root). */
export const BOT_MOTION_VARS: Readonly<Record<`--ab-${string}`, string | number>> = {
  '--ab-sweep': `${M.sweep}ms`, '--ab-boing': `${M.boing}ms`,
};

/** CSS curves matching chat-core's motionEase. */
const EASE: Record<MotionEase, string> = {
  inOut: 'cubic-bezier(.37,0,.63,1)', in: 'cubic-bezier(.32,0,.67,0)', out: 'cubic-bezier(.33,1,.68,1)', linear: 'linear',
};

const n = (v: number) => String(+v.toFixed(3));
const pair = (v: MotionValue): readonly [number, number] => (typeof v === 'number' ? [v, v] : v);
const one = (v: MotionValue): number => (typeof v === 'number' ? v : v[0]);

function decl(t: BotTrack, v: MotionValue): string {
  switch (t.prop) {
    case 'translate': { const [x, y] = pair(v); return `translate:${n(x)}px ${n(y)}px`; }
    case 'scale': { const [x, y] = pair(v); return `scale:${n(x)} ${n(y)}`; }
    case 'rotate': return `rotate:${n(one(v))}deg`;
    case 'opacity': return `opacity:${n(one(v))}`;
    case 'blink': return `transform:scaleY(${n(one(v))})`;
  }
}

function keyframes(name: string, t: BotTrack): string {
  const body = t.keys.map(([at, v, e]) => `${n((at / t.ms) * 100)}%{${decl(t, v)};animation-timing-function:${EASE[e ?? t.ease ?? 'inOut']}}`);
  return `@keyframes ${name}{${body.join('')}}`;
}

/** Loops start at the avatar's own point in each (`--ab-seed` × the track's length); one-shots run once. */
const run = (name: string, t: BotTrack, loop: boolean) =>
  loop ? `${name} ${t.ms}ms linear calc(var(--ab-seed,0) * -${t.ms}ms) infinite` : `${name} ${t.ms}ms linear both`;

function build(): string {
  const frames: string[] = [];
  const rules: string[] = [];
  const blink = 'ab-bot-k-blink';
  frames.push(keyframes(blink, BOT_BLINK));
  rules.push(`.ab-bot .ab-bot-eye{animation:${run(blink, BOT_BLINK, true)}}`);
  for (const [mood, tracks] of Object.entries(BOT_LOOPS) as [BotMood, readonly BotTrack[]][]) {
    const byLayer = new Map<string, string[]>();
    for (const t of tracks) {
      const name = `ab-bot-k-${mood}-${t.layer}-${t.prop}`;
      frames.push(keyframes(name, t));
      byLayer.set(t.layer, [...(byLayer.get(t.layer) ?? []), run(name, t, true)]);
    }
    for (const [layer, list] of byLayer) rules.push(`.ab-bot[data-mood='${mood}'] .ab-bot-${layer}{animation:${list.join(',')}}`);
  }
  const cheer = new Map<string, string[]>([['eye', [run(blink, BOT_BLINK, true)]]]);
  for (const t of BOT_CHEER) {
    const name = `ab-bot-k-cheer-${t.layer}-${t.prop}`;
    frames.push(keyframes(name, t));
    cheer.set(t.layer, [...(cheer.get(t.layer) ?? []), run(name, t, false)]);
  }
  for (const [layer, list] of cheer) rules.push(`.ab-bot.ab-bot[data-cheer] .ab-bot-${layer}{animation:${list.join(',')}}`);
  return [...frames, ...rules].join('\n');
}

/** Keyframes and rules for every track; `.ab-bot[data-still]` and reduced motion (botAvatar.css) override them. */
export const BOT_MOTION_CSS = build();
