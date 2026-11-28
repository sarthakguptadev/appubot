/**
 * Bot avatar: a body in the bot's colour wearing a dark visor with two eyes. The geometry and colours are chat-core's
 * (botAvatarLook), the motion too (botMotion.ts, shared with the phone: its state machine, poses and tracks, as CSS
 * from botAvatarMotion.ts plus botAvatar.css; the agent cursor's overlay uses them as well), measured from a
 * reference recording, drawn as a solid (solidFace below: the round bot a shaded ball, other shapes a shaded volume, the visor and eyes
 * on its surface in CSS 3D, turned and nodded by the motion's yaw and pitch, going right round the back on a spin and
 * over the top on a flip): resting it sits still, upright and facing you, and when the pointer comes near it turns its head toward it and follows it with its eyes; a turn that starts makes its eyes big; thinking, it turns away and collapses into three
 * dots that light up in turn (in small places, `compact`, it stays itself, its eyes as at rest, and turns its head to
 * look up to one side, then the other); on a tool it runs
 * the reference's working routine (glances, blinks, flips, looks about, rolls, spins and wobbles, each eye its own size);
 * typing, it turns toward the text with big eyes; done, it grows back with happy eyes, wobbles like jelly and dances,
 * and stays happy a while. Every motion turns round the avatar's middle, so it stays centred. Needing you it hops for
 * attention. Pressed it squishes and springs back. `happy` draws the app icon's face (scripts/make-icon.mjs): both eyes closed in a smile, for
 * AppuBot itself. A bot wearing a custom character (`Bot.characterId`, chat-core characters.ts) is drawn as that
 * character, looked up in the store's library; a gone one draws its shape. A chief (`Bot.chief`) wears a gold star
 * badge on its bottom-right edge (chat-core chiefBadge.ts), still while the head moves, ringed in the surface behind it
 * (BADGE below).
 */
import { useEffect, useId, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { Bot, BotShape } from '@appubot/protocol';
import {
  BOT_DOTS, BOT_MIDDLE, BOT_MOTION, CHIEF_BADGE, botAvatarLook, botGaze, botHandoff, botHead, botMood, botShown, chiefBadgeSvg, motionSeed, type BotFigure, type BotMood, type RoundRect,
} from '@appubot/chat-core';
import { useStore } from '../../lib/store';
import { BOT_MOTION_CSS, BOT_MOTION_VARS } from './botAvatarMotion';
import { cn } from './cn';

// the motion's keyframes, once per document
if (typeof document !== 'undefined' && !document.getElementById('ab-bot-motion')) {
  const el = document.createElement('style');
  el.id = 'ab-bot-motion';
  el.textContent = BOT_MOTION_CSS;
  document.head.append(el);
}

/** A closed, smiling eye in place of the open one `e`, sized like the app icon's (make-icon.mjs `EYES`). */
const Smile = ({ e, ink, className }: { e: RoundRect; ink: string; className: string }) => {
  const cx = e.x + e.w / 2, cy = e.y + e.h / 2 + e.w * 0.54, r = e.w * 0.87;
  return <path d={`M${cx - r} ${cy}A${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke={ink} strokeWidth={e.w * 0.54} strokeLinecap="round" className={className} />;
};

/* Looking at the pointer: one listener for every resting avatar that can see it. Each frame the pointer moved, every
   one reads where it is (all reads, then all writes) and looks (botGaze) or stops looking. */
const lookers = new Set<HTMLElement>();
let pointer: { x: number; y: number } | null = null;
let frame = 0;
const calm = typeof matchMedia === 'undefined' ? null : matchMedia('(prefers-reduced-motion: reduce)');

function look(): void {
  frame = 0;
  const els = [...lookers];
  const gazes = els.map((el) => {
    if (!pointer || calm?.matches) return null;
    const r = el.getBoundingClientRect();
    return botGaze(pointer.x - (r.left + r.width / 2), pointer.y - (r.top + r.height / 2), r.width);
  });
  els.forEach((el, i) => {
    const g = gazes[i];
    if (!g) { delete el.dataset.look; return; }
    const h = botHead(g.turn, g.pitch);
    const vars: Record<string, number> = {
      '--ab-lyaw': g.turn, '--ab-lpitch': g.pitch,
      '--ab-hx': h.body[0], '--ab-hy': h.body[1], '--ab-fx': h.face.x, '--ab-fy': h.face.y, '--ab-fs': h.face.sx, '--ab-fsy': h.face.sy,
      '--ab-dlx': h.eyes[0].x, '--ab-dls': h.eyes[0].s, '--ab-drx': h.eyes[1].x, '--ab-drs': h.eyes[1].s,
    };
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, String(v));
    el.style.setProperty('--ab-gx', String(g.x));
    el.style.setProperty('--ab-gy', String(g.y));
    el.style.setProperty('--ab-lr', String(g.rotate));
    el.dataset.look = '';
  });
}
const soon = () => { if (!frame) frame = requestAnimationFrame(look); };
const onMove = (e: PointerEvent) => { pointer = { x: e.clientX, y: e.clientY }; soon(); };
const onLeave = () => { pointer = null; soon(); };

function useLookAt(ref: RefObject<HTMLSpanElement | null>, on: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    if (!lookers.size) {
      window.addEventListener('pointermove', onMove, { passive: true });
      document.documentElement.addEventListener('pointerleave', onLeave);
    }
    lookers.add(el);
    soon();
    return () => {
      lookers.delete(el);
      delete el.dataset.look;
      if (lookers.size) return;
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
  }, [ref, on]);
}

/**
 * The mood an avatar shows for the one it's asked for (chat-core botShown): work ending shows `happy` for
 * BOT_MOTION.happy ms (the cheer plays at its start, `cheering`), `cheerKey` cheers on demand, and growing back out of
 * the dots is flagged (`growing`) while the dot gives way to the body. Without `live` it shows the mood as asked.
 */
function useShownMood(mood: BotMood, live: boolean, cheerKey?: number): { shown: BotMood; cheering: boolean; growing: boolean } {
  const [state, setState] = useState(() => ({ shown: botShown(undefined, mood), cheers: 0, grows: 0 }));
  const asked = useRef(mood);
  const [cheering, setCheering] = useState(false);
  const [growing, setGrowing] = useState(false);
  useEffect(() => {
    if (asked.current === mood) return;
    asked.current = mood;
    setState((s) => {
      const shown = live ? botShown(s.shown, mood) : botShown(undefined, mood);
      if (shown === s.shown) return s;
      return { shown, cheers: s.cheers + (shown === 'happy' ? 1 : 0), grows: s.grows + (botHandoff(s.shown, shown) === 'grow' ? 1 : 0) };
    });
  }, [mood, live]);
  useEffect(() => {
    if (!live || !cheerKey) return;
    setState((s) => ({ shown: 'happy', cheers: s.cheers + 1, grows: s.grows + (botHandoff(s.shown, 'happy') === 'grow' ? 1 : 0) }));
  }, [cheerKey, live]);
  useEffect(() => {
    if (!state.cheers) return;
    setCheering(true);
    const done = setTimeout(() => setCheering(false), BOT_MOTION.cheer);
    const rest = setTimeout(() => setState((s) => (s.shown === 'happy' && asked.current === 'rest' ? { ...s, shown: 'rest' } : s)), BOT_MOTION.happy);
    return () => { clearTimeout(done); clearTimeout(rest); setCheering(false); };
  }, [state.cheers]);
  useEffect(() => {
    if (!state.grows) return;
    setGrowing(true);
    const t = setTimeout(() => setGrowing(false), 4 * BOT_MOTION.settle);
    return () => { clearTimeout(t); setGrowing(false); };
  }, [state.grows]);
  return { shown: state.shown, cheering: cheering && state.shown === 'happy', growing };
}

/* The face as a solid: the visor and eyes on the surface of a ball as big as the round bot (SOLID.r, its middle the
   body's), drawn with CSS 3D (one composited plane per piece, no canvas or WebGL, so any number of avatars cost the
   same as their pictures and nothing while still). The visor is SOLID.strips slices of itself, each on its own plane
   tangent to the ball where it sits, so it wraps round; the eyes ride just above it. Turned (--ab-yaw, --ab-pitch: the
   motion's `turn` tracks and poses), a slice facing away is hidden, so the face goes round the back. Seen through a
   lens SOLID.lens away, scaled so the face facing you is exactly its flat drawing. */
const SOLID = { r: 44, lens: 600, strips: 10, overlap: 1.2 } as const;
/** the head turned and nodded, the face facing you as big as drawn flat (the lens magnifies the ball's front) */
const LENS = +((SOLID.lens - SOLID.r) / SOLID.lens).toFixed(4);
const TURN = `scale3d(${LENS}, ${LENS}, 1) rotateX(calc(var(--ab-pitch) * 1deg)) rotateY(calc(var(--ab-yaw) * 1deg))`;
/** the box an eye is drawn in, on its plane (room for the look and the round eyes) */
const EYE_BOX = 28;
/** the light over the body (and face): stops of [offset, ink, opacity] */
const SHADE: readonly (readonly [number, string, number])[] = [[0, '#fff', 0.3], [0.4, '#fff', 0.07], [0.62, '#fff', 0], [0.86, '#000', 0.07], [1, '#000', 0.22]];

function solidFace(look: ReturnType<typeof botAvatarLook>, middle: number): { cx: number; strips: { w: number; from: number; at: string }[]; eyes: string[] } {
  const { r, strips: n, overlap } = SOLID;
  const v = look.visor;
  const cx = v.x + v.w / 2;
  const deg = (rad: number) => +((rad * 180) / Math.PI).toFixed(3);
  const lat = Math.asin(Math.max(-0.9, Math.min(0.9, (middle - (v.y + v.h / 2)) / r)));
  const ring = r * Math.cos(lat);
  const on = (x: number, z: number) => `rotateY(${deg(x / ring)}deg) rotateX(${deg(lat)}deg) translateZ(${z}px)`;
  const step = v.w / n;
  return {
    cx,
    strips: Array.from({ length: n }, (_, i) => {
      const from = -v.w / 2 + i * step;
      return { w: step + overlap, from: -(from + v.w / 2) + overlap / 2, at: on(from + step / 2, r) };
    }),
    eyes: look.eyes.map((e) => on(e.x + e.w / 2 - cx, r + 0.5)),
  };
}

/** the chief's badge, over everything and never moving with the head; its ring the surface behind the avatar (as the presence dot's) */
const BADGE_RING = 'var(--ab-coat-solid,var(--ab-bg))';
const BADGE = chiefBadgeSvg('currentColor');

export type BotPresence = 'working' | 'needs-you' | null;

export function BotAvatar({ bot, shape: shapeProp, figure: figureProp, color: colorProp, size = 32, presence, mood: moodProp, still, compact, cheer = true, cheerKey, happy, chief: chiefProp, className }: {
  bot?: (Pick<Bot, 'shape' | 'color' | 'characterId'> & { chief?: boolean }) | null;
  shape?: BotShape;
  /** what to draw, over the bot's own: a shape or a character (the character picker's previews) */
  figure?: BotFigure;
  color?: string;
  /** the app icon's happy eyes: both closed in a smile (AppuBot itself, not a bot) */
  happy?: boolean;
  /** px */
  size?: number;
  /** the corner badge; also sets the mood unless `mood` is given */
  presence?: BotPresence;
  /** what it is doing (chat-core BotMood; a live turn's: botWorkMood) */
  mood?: BotMood;
  /** no motion at all */
  still?: boolean;
  /** a small place (a sidebar row, the chat header, a pinned tile): thinking, it stays itself, eyes as at rest, and ponders */
  compact?: boolean;
  /** the happy face and cheer when work ends (default on) */
  cheer?: boolean;
  /** cheer once now, and again whenever this changes (the character picker's Happy) */
  cheerKey?: number;
  /** wear the chief's badge (default: the bot's own `chief`); none under CHIEF_BADGE.min px. With it, `presence` sits top-right */
  chief?: boolean;
  className?: string;
}) {
  const uid = useId();
  const id = `bot-${uid.replace(/[^\w-]/g, '')}`;
  const ref = useRef<HTMLSpanElement>(null);
  const worn = useStore((s) => (bot?.characterId && !figureProp && !shapeProp ? s.characters.find((c) => c.id === bot.characterId) : undefined));
  const figure = figureProp ?? shapeProp ?? worn ?? bot?.shape ?? 'circle';
  const look = botAvatarLook(figure, colorProp ?? bot?.color ?? '#8E8E93');
  const middle = typeof figure === 'string' ? BOT_MIDDLE[figure] ?? 50 : 50;
  const { shown, cheering, growing } = useShownMood(moodProp ?? botMood(presence), cheer && !still, cheerKey);
  const calmed = !!className?.split(/\s+/).includes('ab-bot-calm');
  useLookAt(ref, !still && !calmed && shown === 'rest' && size >= 16);
  const g = look.gloss;
  const v = look.visor;
  const sphere = figure === 'circle';
  const ball = solidFace(look, middle);
  const badge = (chiefProp ?? !!bot?.chief) && size >= CHIEF_BADGE.min;
  const at = (x: number, y: number): CSSProperties => ({ transformBox: 'view-box', transformOrigin: `${x}px ${y}px` });
  const dot = Math.max(7, Math.round(size * 0.24));
  const style = { width: size, height: size, ...BOT_MOTION_VARS, '--ab-seed': motionSeed(uid), '--ab-cy': middle } as CSSProperties;
  const eyeBox = (e: RoundRect) => `${e.x + e.w / 2 - EYE_BOX / 2} ${e.y + e.h / 2 - EYE_BOX / 2} ${EYE_BOX} ${EYE_BOX}`;
  const surface = (
    <span className="ab-bot-shape">
      <svg viewBox="0 0 100 100" overflow="visible" className="ab-bot-layer" aria-hidden>
        <defs><clipPath id={`${id}-clip`}><path d={look.body} /></clipPath></defs>
        {look.outline ? <path d={look.body} fill="none" stroke={look.outline} strokeWidth="3" /> : null}
        <path d={look.body} fill={look.fill[1]} />
        {g.opacity > 0 ? (
          <g clipPath={`url(#${id}-clip)`}>
            <ellipse cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry} transform={`rotate(${g.rotate} ${g.cx} ${g.cy})`} fill="#fff" opacity={g.opacity} />
          </g>
        ) : null}
      </svg>
      <span className="ab-bot-clip" style={{ clipPath: `path('${look.body}')` }}>
        <span className="ab-bot-solid" style={{ perspective: SOLID.lens, perspectiveOrigin: `${ball.cx}px ${middle}px` }}>
          <span className="ab-bot-ball" style={{ transformOrigin: `${ball.cx}px ${middle}px`, transform: TURN }}>
            {ball.strips.map((s, i) => (
              <span key={i} className="ab-bot-plane" style={{ left: ball.cx - s.w / 2, top: middle - v.h / 2, width: s.w, height: v.h, transform: s.at }}>
                <span className="ab-bot-visor" style={{ left: s.from, width: v.w, height: v.h, borderRadius: v.r, background: `linear-gradient(${look.glass[0]}, ${look.glass[1]})` }} />
              </span>
            ))}
            {look.eyes.map((e, i) => (
              <span key={i} className="ab-bot-plane" style={{ left: ball.cx - EYE_BOX / 2, top: middle - EYE_BOX / 2, width: EYE_BOX, height: EYE_BOX, transform: ball.eyes[i] }}>
                <svg viewBox={eyeBox(e)} width={EYE_BOX} height={EYE_BOX} overflow="visible" className="block" aria-hidden>
                  <g className="ab-bot-look">
                    {happy ? <Smile e={e} ink={look.eye} className="ab-bot-smile" /> : (
                      <g className={`ab-bot-eye ab-bot-eye${i ? 'R' : 'L'}`}>
                        <rect
                          x={e.x} y={e.y} width={e.w} height={e.h} rx={e.r} fill={look.eye} className="ab-bot-pill"
                          style={{ '--ab-rx': e.r, '--ab-ry': e.h / 2 } as CSSProperties}
                        />
                        <Smile e={e} ink={look.eye} className="ab-bot-arc" />
                      </g>
                    )}
                  </g>
                </svg>
              </span>
            ))}
          </span>
        </span>
      </span>
      {/* the light: brighter up to the left, a little darker round the edge, a soft rim low on the right */}
      <svg viewBox="0 0 100 100" overflow="visible" className="ab-bot-layer" aria-hidden>
        <defs>
          <radialGradient id={`${id}-light`} cx="0.5" cy="0.5" r="0.5" fx="0.36" fy="0.3">
            {SHADE.map(([at, ink, a]) => <stop key={at} offset={at} stopColor={ink} stopOpacity={a} />)}
          </radialGradient>
          <linearGradient id={`${id}-rim`} x1="0.2" y1="0.1" x2="0.85" y2="0.95">
            <stop offset="0.6" stopColor="#fff" stopOpacity="0" />
            <stop offset="1" stopColor="#fff" stopOpacity="0.32" />
          </linearGradient>
        </defs>
        <path d={look.body} fill={`url(#${id}-light)`} />
        <path d={look.body} fill="none" stroke={`url(#${id}-rim)`} strokeWidth="3" clipPath={`url(#${id}-clip)`} />
      </svg>
    </span>
  );
  return (
    <span
      ref={ref}
      className={cn('ab-bot relative inline-block shrink-0 select-none', className)}
      data-mood={shown}
      data-still={still || undefined}
      data-compact={compact || undefined}
      data-cheer={cheering || undefined}
      data-grow={growing || undefined}
      data-solid
      style={style}
    >
      <span className="ab-bot-stage" style={{ zoom: size / 100 }} aria-hidden>
        <span className="ab-bot-fill" style={{ translate: `0 ${50 - middle}px` }}><span className="ab-bot-joy"><span className="ab-bot-body"><span className="ab-bot-tilt">
          <span className="ab-bot-morph" style={{ transformOrigin: `50px ${middle}px` }}>
            <span className="ab-bot-turn">{sphere ? surface : <span className="ab-bot-head">{surface}</span>}</span>
            <svg viewBox="0 0 100 100" overflow="visible" className="ab-bot-layer">
              <circle className="ab-bot-core" cx={50} cy={middle} r={BOT_DOTS.r / BOT_DOTS.scale} fill={look.fill[1]} />
            </svg>
          </span>
          <svg viewBox="0 0 100 100" overflow="visible" className="ab-bot-layer">
            <g className="ab-bot-dots">
              {[-1, 0, 1].map((k) => (
                <g key={k} className={k ? 'ab-bot-side' : 'ab-bot-mid'} style={at(50 + k * BOT_DOTS.gap, middle)}>
                  <circle className={`ab-bot-dot ab-bot-dot-${k + 1}`} cx={50 + k * BOT_DOTS.gap} cy={middle} r={BOT_DOTS.r} fill={look.fill[1]} />
                </g>
              ))}
            </g>
          </svg>
        </span></span></span></span>
      </span>
      {badge ? (
        <svg viewBox="0 0 100 100" overflow="visible" width={size} height={size} className="ab-bot-badge pointer-events-none absolute top-0 left-0" style={{ color: BADGE_RING }} aria-hidden dangerouslySetInnerHTML={{ __html: BADGE }} />
      ) : null}
      {presence ? (
        <span
          className={cn('absolute -right-px rounded-full', badge ? '-top-px' : '-bottom-px', 'ring-2 ring-[var(--ab-coat-solid,var(--ab-bg))]', presence === 'working' ? 'bg-accent' : 'bg-attention')}
          style={{ width: dot, height: dot }}
        />
      ) : null}
    </span>
  );
}
