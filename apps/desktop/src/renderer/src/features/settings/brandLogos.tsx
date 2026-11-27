/** Brand tiles for the services in Settings (Tailscale, Telegram), sized and framed like the agents' ProviderMark. */
import { cn } from '../../components/ui';

const TILE = 'ab-pill inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[10px] shadow-[inset_0_0_0_.5px_var(--ab-hairline),0_.5px_1px_color-mix(in_srgb,#000_6%,transparent)]';

/** Tailscale's nine dots (simple-icons), in the text colour so they flip with the theme. */
const TAILSCALE = 'M24 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm-9 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm0-9a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm6-6a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 24a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zm18 .5a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm9-9a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm-3 2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6 3a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM3 5.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z';

export function TailscaleMark({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <span className={cn(TILE, 'bg-surface text-fg', className)} style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width={Math.round(size * 0.5)} height={Math.round(size * 0.5)} aria-hidden>
        <path d={TAILSCALE} fill="currentColor" />
      </svg>
    </span>
  );
}

/** Telegram's blue disc with its paper plane (simple-icons; the plane is a cut-out, filled white underneath). */
const TELEGRAM = 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z';

export function TelegramMark({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <span className={cn(TILE, 'bg-surface', className)} style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width={Math.round(size * 0.62)} height={Math.round(size * 0.62)} aria-hidden>
        <circle cx="12" cy="12" r="10" fill="#fff" />
        <path d={TELEGRAM} fill="#26A5E4" />
      </svg>
    </span>
  );
}
