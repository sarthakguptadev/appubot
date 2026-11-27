/**
 * Bot avatar: a body in the bot's colour wearing a dark visor with two eyes. The geometry and colours are chat-core's
 * (botAvatarLook), the motion too (botMotion.ts, shared with the phone: its state machine, poses and tracks, as CSS
 * from botAvatarMotion.ts plus botAvatar.css; the agent cursor's overlay uses them as well), copied from Grok Bot's
 * mascot: resting it sits still, upright and facing you, and when the pointer comes near it turns its face toward it
 * and follows it with its eyes; a turn that starts makes its eyes big; thinking, it turns away and collapses into three
 * dots that light up in turn (in small places, `compact`, the dots light up in its visor instead); on a tool its eyes
 * go round and it wanders; typing, it turns toward the text with big eyes; done, it grows back with happy eyes, wobbles
 * like jelly and dances, and stays happy a while. Every motion turns round the avatar's middle, so it stays centred. Needing you it hops for attention. Pressed it
 * squishes and springs back. `happy` draws the app icon's face (scripts/make-icon.mjs): both eyes closed in a smile, for
 * AppuBot itself. A bot wearing a custom character (`Bot.characterId`, chat-core characters.ts) is drawn as that
 * character, looked up in the store's library; a gone one draws its shape.
 */
import { useEffect, useId, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { Bot, BotShape } from '@appubot/protocol';
import {
  BOT_DOTS, BOT_MIDDLE, BOT_MOTION, botAvatarLook, botGaze, botHandoff, botMood, botShown, botTurn, motionSeed, type BotFigure, type BotMood, type RoundRect,
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
    const t = botTurn(g.turn);
    el.style.setProperty('--ab-fx', String(t.x));
    el.style.setProperty('--ab-fs', String(t.sx));
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

export type BotPresence = 'working' | 'needs-you' | null;

export function BotAvatar({ bot, shape: shapeProp, figure: figureProp, color: colorProp, size = 32, presence, mood: moodProp, still, compact, cheer = true, cheerKey, happy, className }: {
  bot?: Pick<Bot, 'shape' | 'color' | 'characterId'> | null;
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
  /** a small place (a sidebar row, the chat header, a pinned tile): thinking, it stays itself with the dots in its visor */
  compact?: boolean;
  /** the happy face and cheer when work ends (default on) */
  cheer?: boolean;
  /** cheer once now, and again whenever this changes (the character picker's Happy) */
  cheerKey?: number;
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
  const cy = v.y + v.h / 2;
  const at = (x: number, y: number): CSSProperties => ({ transformBox: 'view-box', transformOrigin: `${x}px ${y}px` });
  const dot = Math.max(7, Math.round(size * 0.24));
  const style = { width: size, height: size, ...BOT_MOTION_VARS, '--ab-seed': motionSeed(uid), '--ab-cy': middle } as CSSProperties;
  return (
    <span
      ref={ref}
      className={cn('ab-bot relative inline-block shrink-0 select-none', className)}
      data-mood={shown}
      data-still={still || undefined}
      data-compact={compact || undefined}
      data-cheer={cheering || undefined}
      data-grow={growing || undefined}
      style={style}
    >
      <svg viewBox="0 0 100 100" overflow="visible" className="ab-bot-svg block size-full" aria-hidden>
        <defs>
          <linearGradient id={`${id}-body`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={look.fill[0]} />
            <stop offset="0.55" stopColor={look.fill[1]} />
            <stop offset="1" stopColor={look.fill[2]} />
          </linearGradient>
          <linearGradient id={`${id}-glass`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={look.glass[0]} />
            <stop offset="1" stopColor={look.glass[1]} />
          </linearGradient>
          <clipPath id={`${id}-clip`}><path d={look.body} /></clipPath>
        </defs>
        <g transform={`translate(0 ${50 - middle})`}><g className="ab-bot-joy"><g className="ab-bot-body"><g className="ab-bot-tilt">
          <g className="ab-bot-morph" style={at(50, middle)}>
            <g className="ab-bot-shape">
              {look.outline ? <path d={look.body} fill="none" stroke={look.outline} strokeWidth="3" /> : null}
              <path d={look.body} fill={`url(#${id}-body)`} />
              {g.opacity > 0 ? (
                <g clipPath={`url(#${id}-clip)`}>
                  <ellipse cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry} transform={`rotate(${g.rotate} ${g.cx} ${g.cy})`} fill="#fff" opacity={g.opacity} />
                </g>
              ) : null}
              <g clipPath={`url(#${id}-clip)`}>
                <g className="ab-bot-face" style={at(50, cy)}>
                  <rect x={v.x} y={v.y} width={v.w} height={v.h} rx={v.r} fill={`url(#${id}-glass)`} />
                  <g className="ab-bot-look">
                    {look.eyes.map((e, i) => (happy ? <Smile key={i} e={e} ink={look.eye} className="ab-bot-smile" /> : (
                      <g key={i} className="ab-bot-eye" style={at(e.x + e.w / 2, e.y + e.h / 2)}>
                        <rect
                          x={e.x} y={e.y} width={e.w} height={e.h} rx={e.r} fill={look.eye} className="ab-bot-pill"
                          style={{ '--ab-rx': e.r, '--ab-ry': e.h / 2, ...at(e.x + e.w / 2, e.y + e.h / 2) } as CSSProperties}
                        />
                        <Smile e={e} ink={look.eye} className="ab-bot-arc" />
                      </g>
                    )))}
                  </g>
                  {compact ? (
                    <g className="ab-bot-vdots">
                      {[-1, 0, 1].map((k) => (
                        <circle key={k} className={`ab-bot-vdot ab-bot-vdot-${k + 1}`} cx={50 + k * v.w * 0.22} cy={cy} r={v.h * 0.16} fill={look.eye} />
                      ))}
                    </g>
                  ) : null}
                </g>
              </g>
            </g>
            <circle className="ab-bot-core" cx={50} cy={middle} r={BOT_DOTS.r / BOT_DOTS.scale} fill={look.fill[1]} />
          </g>
          <g className="ab-bot-dots">
            {[-1, 0, 1].map((k) => (
              <g key={k} className={k ? 'ab-bot-side' : 'ab-bot-mid'} style={at(50 + k * BOT_DOTS.gap, middle)}>
                <circle className={`ab-bot-dot ab-bot-dot-${k + 1}`} cx={50 + k * BOT_DOTS.gap} cy={middle} r={BOT_DOTS.r} fill={look.fill[1]} />
              </g>
            ))}
          </g>
        </g></g></g></g>
      </svg>
      {presence ? (
        <span
          className={cn('absolute -right-px -bottom-px rounded-full ring-2 ring-[var(--ab-coat-solid,var(--ab-bg))]', presence === 'working' ? 'bg-accent' : 'bg-attention')}
          style={{ width: dot, height: dot }}
        />
      ) : null}
    </span>
  );
}
