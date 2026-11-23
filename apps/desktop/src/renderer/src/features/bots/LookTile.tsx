/**
 * One look to pick, drawn as the bot would wear it: a shape or a saved character in the chosen colour, with a thin
 * ring that follows its own outline a few pixels out (faint under the pointer, darker once chosen) instead of a box
 * behind it. Used wherever a look is picked: the New bot dialog and the look picker under a bot's avatar.
 */
import { useId, type ButtonHTMLAttributes } from 'react';
import { botAvatarLook, type BotFigure } from '@appubot/chat-core';
import { BotAvatar, cn } from '../../components/ui';

/** how far out of the body the ring sits, and how thick it is (px) */
const RING_GAP = 3;
const RING_LINE = 1.25;

/** The ring round a figure: its body's outline, pushed out and drawn as a line (a mask, so it sits on any surface). Also the highlight round a bot's avatar in its side panel (BotHero). */
export function OutlineRing({ figure, size, className, gap = RING_GAP, line = RING_LINE }: {
  figure: BotFigure; size: number; className?: string;
  /** how far out of the body, and how thick (px) */
  gap?: number; line?: number;
}) {
  const id = `ring-${useId().replace(/[^\w-]/g, '')}`;
  const body = botAvatarLook(figure, '#000000').body;
  // the avatar's box is 100 units across
  const unit = 100 / size;
  return (
    <svg aria-hidden viewBox="0 0 100 100" width={size} height={size} fill="none" className={cn('pointer-events-none absolute overflow-visible', className)}>
      <mask id={id} maskUnits="userSpaceOnUse" x={-30} y={-30} width={160} height={160}>
        <path d={body} stroke="#fff" strokeWidth={2 * (gap + line) * unit} strokeLinejoin="round" />
        <path d={body} fill="#000" stroke="#000" strokeWidth={2 * gap * unit} strokeLinejoin="round" />
      </mask>
      <rect x={-30} y={-30} width={160} height={160} fill="currentColor" mask={`url(#${id})`} />
    </svg>
  );
}

export function LookTile({ figure, color, selected, size = 36, label, className, ...rest }: {
  figure: BotFigure;
  color: string;
  selected: boolean;
  /** the avatar's size; the tile is a third larger */
  size?: number;
  label: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'color'>) {
  const tile = Math.round(size * 4 / 3);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      {...rest}
      style={{ width: tile, height: tile }}
      className={cn('group/look ab-press relative inline-flex shrink-0 items-center justify-center rounded-[14px] outline-none [--press:.94]', className)}
    >
      <OutlineRing
        figure={figure}
        size={size}
        className={cn(
          'text-fg transition-opacity duration-150',
          selected ? 'opacity-45' : 'opacity-0 group-hover/look:opacity-20 group-focus-visible/look:opacity-45',
        )}
      />
      <BotAvatar figure={figure} color={color} size={size} still />
    </button>
  );
}
