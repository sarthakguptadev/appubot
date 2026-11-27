/**
 * One look to pick, drawn as the bot would wear it: a shape or a saved character in the chosen colour, on a tile whose
 * light fill shows it under the pointer and marks it once chosen (a rounded rect, concentric with the tile; no ring
 * round the figure, which would stay put while the figure moves). Used wherever a look is picked: the New bot dialog
 * and the look picker under a bot's avatar.
 */
import type { ButtonHTMLAttributes } from 'react';
import type { BotFigure } from '@appubot/chat-core';
import { BotAvatar, cn } from '../../components/ui';

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
      className={cn(
        'ab-press relative inline-flex shrink-0 items-center justify-center rounded-[14px] outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ab-ring)]',
        selected ? 'bg-[color-mix(in_srgb,var(--ab-fg)_9%,transparent)]' : 'hover:bg-[color-mix(in_srgb,var(--ab-fg)_5%,transparent)]',
        className,
      )}
    >
      <BotAvatar figure={figure} color={color} size={size} still />
    </button>
  );
}
