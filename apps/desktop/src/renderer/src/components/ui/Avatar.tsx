import { cn } from './cn';

const sizes = { xs: 'size-6 text-ui', sm: 'size-8 text-title', md: 'size-10 text-[20px]', lg: 'size-14 text-[28px]', xl: 'size-20 text-[40px]' } as const;

/** Bot emoji on a soft tinted circle (tint derived from the bot colour). */
export function Avatar({ emoji, color = '#ee7944', size = 'sm', glow, className }: {
  emoji: string; color?: string; size?: keyof typeof sizes; glow?: boolean; className?: string;
}) {
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      {glow ? <span className="hero-glow -inset-3 !opacity-40 !blur-xl" /> : null}
      <span
        className={cn('relative inline-flex items-center justify-center rounded-full leading-none select-none', sizes[size])}
        style={{ background: `color-mix(in srgb, ${color} 16%, var(--ab-surface))`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 22%, transparent)` }}
      >
        {emoji}
      </span>
    </span>
  );
}
