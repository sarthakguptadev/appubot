/**
 * The bot avatar's motion as CSS, from chat-core's state machine (botMotion.ts): every mood's pose, eased with the
 * measured first-order curve (BOT_MOTION.snap/settle, BOT_EASE_CSS); the collapse into the three dots and the growing
 * back (BOT_MORPH, BOT_DOTS, BOT_DOT_LOOP), or in small places (`data-compact`) the dots in the visor instead; the moods'
 * loops (BOT_LOOPS); the happy cheer (BOT_CHEER); and looking at the pointer (BotAvatar.tsx sets `data-look` and the
 * turned head's drawing from botHead: --ab-hx/--ab-hy the outline, --ab-fx/--ab-fy/--ab-fs/--ab-fsy the face,
 * --ab-dlx/--ab-dls and --ab-drx/--ab-drs each eye; --ab-gx/--ab-gy/--ab-lr from botGaze). botAvatar.css holds the rest
 * (layers' origins, the press, still and reduced motion). Used by the app's BotAvatar.tsx (injected once into the
 * document) and by the agent cursor's overlay page in the main process (as text), so both bots move alike. Pure TS on
 * purpose: tsconfig.node.json includes it.
 */
import {
  BOT_CHEER, BOT_DOT_LOOP, BOT_DOTS, BOT_EASE_CSS, BOT_LOOPS, BOT_LOOPS_FROM_START, BOT_MORPH, BOT_MOTION as M, BOT_POSES, botHead, type BotMood, type BotTrack,
  type MotionEase,
  type MotionValue,
} from '@appubot/chat-core';

/** The custom properties botAvatar.css and the overlay page use (the overlay puts them on :root). */
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
const ms = (v: number) => `${n(v)}ms`;

function decl(t: BotTrack, v: MotionValue): string {
  switch (t.prop) {
    case 'translate': { const [x, y] = pair(v); return `translate:${n(x)}px ${n(y)}px`; }
    case 'scale': { const [x, y] = pair(v); return `scale:${n(x)} ${n(y)}`; }
    case 'rotate': return `rotate:${n(one(v))}deg`;
    case 'opacity': return `opacity:${n(one(v))}`;
  }
}

function keyframes(name: string, t: BotTrack): string {
  const body = t.keys.map(([at, v, e]) => `${n((at / t.ms) * 100)}%{${decl(t, v)};animation-timing-function:${EASE[e ?? t.ease ?? 'inOut']}}`);
  return `@keyframes ${name}{${body.join('')}}`;
}

/** Loops start at the avatar's own point in each (`--ab-seed` × the track's length) or, from the start, from their
 *  beginning; one-shots run once. */
const run = (name: string, t: BotTrack, loop: boolean, fromStart = false) =>
  !loop ? `${name} ${t.ms}ms linear both`
    : fromStart ? `${name} ${t.ms}ms linear infinite` : `${name} ${t.ms}ms linear calc(var(--ab-seed,0) * -${t.ms}ms) infinite`;

const SNAP = `${ms(4 * M.snap)} ${BOT_EASE_CSS}`;
const SETTLE = `${ms(4 * M.settle)} ${BOT_EASE_CSS}`;
const is = (moods: readonly BotMood[]) => `.ab-bot:is(${moods.map((m) => `[data-mood='${m}']`).join(',')})`;
const DOTS = (Object.keys(BOT_POSES) as BotMood[]).filter((m) => BOT_POSES[m].form === 'dots');

/** The turned head's drawing (botHead) on its layers: the outline, the face, each eye. */
function head(at: string, h: ReturnType<typeof botHead>): string[] {
  return [
    `${at} .ab-bot-head{scale:${n(h.body[0])} ${n(h.body[1])}}`,
    `${at} .ab-bot-face{translate:${n(h.face.x)}px ${n(h.face.y)}px;scale:${n(h.face.sx)} ${n(h.face.sy)}}`,
    ...h.eyes.map((e, i) => `${at} .ab-bot-deep${i ? 'R' : 'L'}{translate:${n(e.x)}px 0px;scale:${n(e.s)} 1}`),
  ];
}

/** Each mood's pose, eased to: the head's lean, its turn and nod, where the eyes look, each eye's shape, round eyes. */
function poses(): string[] {
  const rules = [
    `.ab-bot .ab-bot-tilt{transition:rotate ${SNAP}}`,
    `.ab-bot :is(.ab-bot-head,.ab-bot-face,.ab-bot-deep){transition:translate ${SETTLE},scale ${SETTLE}}`,
    `.ab-bot .ab-bot-look{transition:translate ${SETTLE}}`,
    `.ab-bot .ab-bot-eye{transition:scale ${SNAP}}`,
    `.ab-bot .ab-bot-pill{ry:calc(var(--ab-rx,0) * 1px)}`,
  ];
  for (const [mood, p] of Object.entries(BOT_POSES)) {
    const at = `.ab-bot[data-mood='${mood}']`;
    rules.push(`${at} .ab-bot-tilt{rotate:${n(p.rotate)}deg}`);
    rules.push(...head(at, botHead(p.turn, p.pitch)));
    rules.push(`${at} .ab-bot-look{translate:${n(p.gaze[0])}px ${n(p.gaze[1])}px}`);
    rules.push(`${at} .ab-bot-eye{scale:${n(p.eye[0])} ${n(p.eye[1])}}`);
    if (p.face === 'round') rules.push(`${at} .ab-bot-pill{ry:calc(var(--ab-ry,0) * 1px)}`);
  }
  // the pointer near a resting avatar: the head turns and nods toward it, the eyes follow it, the body leans a little
  const look = ".ab-bot[data-mood='rest'][data-look]";
  const px = (v: string) => `calc(var(--ab-${v},0) * 1px)`;
  rules.push(`${look} .ab-bot-tilt{rotate:calc(var(--ab-lr,0) * 1deg)}`);
  rules.push(`${look} .ab-bot-head{scale:var(--ab-hx,1) var(--ab-hy,1)}`);
  rules.push(`${look} .ab-bot-face{translate:${px('fx')} ${px('fy')};scale:var(--ab-fs,1) var(--ab-fsy,1)}`);
  rules.push(`${look} .ab-bot-deepL{translate:${px('dlx')} 0px;scale:var(--ab-dls,1) 1}`);
  rules.push(`${look} .ab-bot-deepR{translate:${px('drx')} 0px;scale:var(--ab-drs,1) 1}`);
  rules.push(`${look} .ab-bot-look{translate:calc(var(--ab-gx,0) * 1px) calc(var(--ab-gy,0) * 1px)}`);
  // happy eyes: the pill flattens away and the ^ unfolds in its place, and back (each half 2τ: Grok Bot's swap took 190 ms)
  const happy = `.ab-bot[data-mood='happy']`;
  const half = ms(2 * M.snap);
  const HALF = `${half} ${BOT_EASE_CSS}`;
  rules.push(`.ab-bot .ab-bot-arc{scale:1 .2;opacity:0;transition:scale ${HALF},opacity 0s ${half}}`);
  rules.push(`.ab-bot .ab-bot-pill{transition:ry ${SNAP},scale ${HALF} ${half},opacity 0s ${half}}`);
  rules.push(`${happy} .ab-bot-pill{scale:1 .2;opacity:0;transition:ry ${SNAP},scale ${HALF},opacity 0s ${half}}`);
  rules.push(`${happy} .ab-bot-arc{scale:1;opacity:1;transition:scale ${HALF} ${half},opacity 0s ${half}}`);
  return rules;
}

/**
 * Thinking: the face turns away, the body shrinks into the middle dot and gives way to a plain dot, the side dots grow
 * in, then they light up left to right. Growing back (`data-grow`, set for the handoff by BotAvatar.tsx): the side
 * dots go, the dot grows into the body and gives way to it. In small places (`data-compact`) the bot stays, facing you,
 * and the three dots light up in its visor in place of its eyes.
 */
function morph(frames: string[]): string[] {
  const at = is(DOTS).replace('.ab-bot:is', '.ab-bot:not([data-compact]):is');
  const compact = is(DOTS).replace('.ab-bot:is', '.ab-bot[data-compact]:is');
  const [sideAt, sideFor] = BOT_MORPH.sides;
  const [backAt, backFor] = BOT_MORPH.fadeBack;
  const lit = BOT_MORPH.lit;
  // the plain dot: shown from the collapse until the dots light up, and while the body grows back out of it
  frames.push(`@keyframes ab-bot-core-in{0%{opacity:0}${n((BOT_MORPH.collapse / lit) * 100)}%{opacity:0;animation-timing-function:linear}${n(((BOT_MORPH.collapse + BOT_MORPH.fade) / lit) * 100)}%{opacity:1}99.9%{opacity:1}100%{opacity:0}}`);
  frames.push(`@keyframes ab-bot-core-out{0%{opacity:1}${n((backAt / (backAt + backFor)) * 100)}%{opacity:1;animation-timing-function:linear}100%{opacity:0}}`);
  const rules = [
    `.ab-bot .ab-bot-morph{scale:1;transition:scale ${SETTLE}}`,
    `.ab-bot .ab-bot-shape{opacity:1;transition:opacity ${ms(backFor)} linear ${ms(backAt)}}`,
    `.ab-bot .ab-bot-core{opacity:0}`,
    `.ab-bot .ab-bot-dots,.ab-bot .ab-bot-mid{opacity:0;transition:opacity 0s}`,
    `.ab-bot .ab-bot-side{scale:0;transition:scale ${ms(BOT_MORPH.sidesBack)} ${BOT_EASE_CSS}}`,
    `.ab-bot .ab-bot-dot{opacity:${BOT_DOTS.dim}}`,
    // the face turns away quickly before it goes (Grok Bot: 33px in 70 ms)
    `${at} :is(.ab-bot-head,.ab-bot-face,.ab-bot-deep){transition:translate ${SNAP},scale ${SNAP}}`,
    `${at} .ab-bot-morph{scale:${BOT_DOTS.scale};transition:scale ${SETTLE} ${ms(BOT_MORPH.collapse)}}`,
    `${at} .ab-bot-shape{opacity:0;transition:opacity ${ms(BOT_MORPH.fade)} linear ${ms(BOT_MORPH.collapse)}}`,
    `${at} .ab-bot-core{animation:ab-bot-core-in ${ms(lit)} linear both}`,
    `${at} .ab-bot-dots{opacity:1;transition:opacity 0s ${ms(sideAt)}}`,
    `${at} .ab-bot-mid{opacity:1;transition:opacity 0s ${ms(lit)}}`,
    `${at} .ab-bot-side{scale:1;transition:scale ${ms(sideFor)} ${BOT_EASE_CSS} ${ms(sideAt)}}`,
    `.ab-bot:not([data-compact])[data-grow] .ab-bot-core{animation:ab-bot-core-out ${ms(backAt + backFor)} linear both}`,
  ];
  // in the dots, each dot lights up in turn once they're all there (left first)
  BOT_DOT_LOOP.tracks.forEach((t, i) => frames.push(keyframes(`ab-bot-k-dot-${i}`, t)));
  BOT_DOT_LOOP.offsets.forEach((offset, d) => {
    const list = BOT_DOT_LOOP.tracks.map((t, i) => `ab-bot-k-dot-${i} ${t.ms}ms linear ${ms(lit - offset)} infinite`);
    rules.push(`${at} .ab-bot-dot-${d}{animation:${list.join(',')}}`);
  });
  // small places: facing you, the eyes give way to the visor's dots at once, lighting up from the start
  rules.push(
    `.ab-bot .ab-bot-vdots{opacity:0}`,
    `.ab-bot .ab-bot-vdot{opacity:${BOT_DOTS.dim}}`,
    `${compact} :is(.ab-bot-head,.ab-bot-face,.ab-bot-deep){translate:0px 0px;scale:1 1}`,
    `${compact} .ab-bot-look{opacity:0}`,
    `${compact} .ab-bot-vdots{opacity:1}`,
  );
  BOT_DOT_LOOP.offsets.forEach((offset, d) => {
    const list = BOT_DOT_LOOP.tracks.map((t, i) => `ab-bot-k-dot-${i} ${t.ms}ms linear ${ms(-offset)} infinite`);
    rules.push(`${compact} .ab-bot-vdot-${d}{animation:${list.join(',')}}`);
  });
  return rules;
}

function build(): string {
  const frames: string[] = [];
  const rules: string[] = [...poses(), ...morph(frames)];
  for (const [mood, tracks] of Object.entries(BOT_LOOPS) as [BotMood, readonly BotTrack[]][]) {
    const byLayer = new Map<string, string[]>();
    for (const t of tracks) {
      const name = `ab-bot-k-${mood}-${t.layer}-${t.prop}`;
      frames.push(keyframes(name, t));
      byLayer.set(t.layer, [...(byLayer.get(t.layer) ?? []), run(name, t, true, BOT_LOOPS_FROM_START.includes(mood))]);
    }
    for (const [layer, list] of byLayer) rules.push(`.ab-bot[data-mood='${mood}'] .ab-bot-${layer}{animation:${list.join(',')}}`);
  }
  const cheer = new Map<string, string[]>();
  for (const t of BOT_CHEER) {
    const name = `ab-bot-k-cheer-${t.layer}-${t.prop}`;
    frames.push(keyframes(name, t));
    cheer.set(t.layer, [...(cheer.get(t.layer) ?? []), run(name, t, false)]);
  }
  for (const [layer, list] of cheer) rules.push(`.ab-bot[data-cheer] .ab-bot-${layer}{animation:${list.join(',')}}`);
  return [...frames, ...rules].join('\n');
}

/** Keyframes and rules for every pose and track; `.ab-bot[data-still]` and reduced motion (botAvatar.css) override them. */
export const BOT_MOTION_CSS = build();
