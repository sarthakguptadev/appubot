/**
 * Bot avatar: a glossy body in the bot's colour wearing a dark glass visor with two glowing eyes. The geometry and
 * colours are chat-core's (botAvatarLook), the motion too (botMotion.ts, shared with the phone, as CSS from
 * botAvatarMotion.ts plus botAvatar.css; the agent cursor's overlay uses them as well): resting it breathes, tilts its
 * head, blinks, glances and now and then hops; working it bobs with a squash at each landing, scans the visor with its
 * eyes and stops to think; needing you it hops for attention, wobbles and swells its eyes. When its mood goes from
 * working back to rest (a reply is done) it cheers once: a happy double hop with squinting eyes. Hovered (or its
 * row) it jiggles like jelly; pressed it squishes and springs back. `happy` draws the app icon's face
 * (scripts/make-icon.mjs): both eyes closed in a smile, for AppuBot itself. A bot wearing a custom character
 * (`Bot.characterId`, chat-core characters.ts) is drawn as that character, looked up in the store's library; a gone one
 * draws its shape.
 */
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import type { Bot, BotShape } from '@appubot/protocol';
import { BOT_MOTION, botAvatarLook, botMood, cheersAt, motionSeed, type BotFigure, type BotMood, type RoundRect } from '@appubot/chat-core';
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
const Smile = ({ e, ink }: { e: RoundRect; ink: string }) => {
  const cx = e.x + e.w / 2, cy = e.y + e.h / 2 + e.w * 0.54, r = e.w * 0.87;
  return <path d={`M${cx - r} ${cy}A${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke={ink} strokeWidth={e.w * 0.54} strokeLinecap="round" className="ab-bot-eye" />;
};

const Rr = ({ r, fill, className }: { r: RoundRect; fill: string; className?: string }) => (
  <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={r.r} fill={fill} className={className} />
);


/** True for BOT_MOTION.cheer ms after the mood goes from working back to rest, or `cheerKey` changes. */
function useCheer(mood: BotMood, on: boolean, cheerKey?: number): boolean {
  const prev = useRef(mood);
  const [cheering, setCheering] = useState(false);
  useEffect(() => {
    const from = prev.current;
    prev.current = mood;
    if (!on || !cheersAt(from, mood)) return;
    setCheering(true);
    const t = setTimeout(() => setCheering(false), BOT_MOTION.cheer);
    return () => { clearTimeout(t); setCheering(false); };
  }, [mood, on]);
  useEffect(() => {
    if (!on || !cheerKey) return;
    setCheering(true);
    const t = setTimeout(() => setCheering(false), BOT_MOTION.cheer);
    return () => { clearTimeout(t); setCheering(false); };
  }, [cheerKey, on]);
  return cheering && mood === 'rest';
}

export type BotPresence = 'working' | 'needs-you' | null;

export function BotAvatar({ bot, shape: shapeProp, figure: figureProp, color: colorProp, size = 32, presence, mood: moodProp, still, cheer = true, cheerKey, happy, className }: {
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
  mood?: BotMood;
  /** no motion at all */
  still?: boolean;
  /** the happy bounce when the mood goes from working back to rest (default on) */
  cheer?: boolean;
  /** cheer once now, and again whenever this changes (the character picker's Happy) */
  cheerKey?: number;
  className?: string;
}) {
  const uid = useId();
  const id = `bot-${uid.replace(/[^\w-]/g, '')}`;
  const worn = useStore((s) => (bot?.characterId && !figureProp && !shapeProp ? s.characters.find((c) => c.id === bot.characterId) : undefined));
  const look = botAvatarLook(figureProp ?? shapeProp ?? worn ?? bot?.shape ?? 'circle', colorProp ?? bot?.color ?? '#8E8E93');
  const mood = moodProp ?? botMood(presence);
  const cheering = useCheer(mood, cheer && !still, cheerKey);
  const g = look.gloss;
  const v = look.visor;
  const dot = Math.max(7, Math.round(size * 0.24));
  const style = { width: size, height: size, ...BOT_MOTION_VARS, '--ab-seed': motionSeed(uid) } as CSSProperties;
  return (
    <span className={cn('ab-bot relative inline-block shrink-0 select-none', className)} data-mood={mood} data-still={still || undefined} data-cheer={cheering || undefined} style={style}>
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
          <clipPath id={`${id}-visor`}><rect x={v.x} y={v.y} width={v.w} height={v.h} rx={v.r} /></clipPath>
        </defs>
        <g className="ab-bot-joy"><g className="ab-bot-body"><g className="ab-bot-tilt">
          {look.outline ? <path d={look.body} fill="none" stroke={look.outline} strokeWidth="3" /> : null}
          <path d={look.body} fill={`url(#${id}-body)`} />
          {g.opacity > 0 ? (
            <g clipPath={`url(#${id}-clip)`}>
              <ellipse cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry} transform={`rotate(${g.rotate} ${g.cx} ${g.cy})`} fill="#fff" opacity={g.opacity} />
            </g>
          ) : null}
          <Rr r={v} fill={`url(#${id}-glass)`} />
          <g className="ab-bot-look">
            {look.eyes.map((e, i) => (happy ? <Smile key={i} e={e} ink={look.eye} /> : <Rr key={i} r={e} fill={look.eye} className="ab-bot-eye" />))}
          </g>
          {mood === 'working' && !still ? (
            <g clipPath={`url(#${id}-visor)`}>
              <rect className="ab-bot-sweep" x={50 - v.h * 0.25} y={v.y - 2} width={v.h * 0.5} height={v.h + 4} fill="#fff" opacity="0.16" />
            </g>
          ) : null}
        </g></g></g>
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
