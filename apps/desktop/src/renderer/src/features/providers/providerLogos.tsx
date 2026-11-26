/**
 * Coding agents' brand marks (path data in chat-core's PROVIDER_MARKS): Claude's starburst in its clay, the others in
 * the text colour so they flip with the theme. Custom agents get their initials.
 */
import type { Provider } from '@appubot/protocol';
import { providerInitials, providerMark } from '@appubot/chat-core';
import { cn } from '../../components/ui';

/** The bare mark, `size` px square (nothing for agents without one). */
export function ProviderLogo({ id, size = 16, className }: { id: string; size?: number; className?: string }) {
  const mark = providerMark(id);
  if (!mark) return null;
  return (
    <svg viewBox={mark.viewBox} width={size} height={size} className={cn('shrink-0', className)} aria-hidden preserveAspectRatio="xMidYMid meet">
      {mark.paths.map((p, i) => (
        <path key={i} d={p.d} fill={mark.color ?? 'currentColor'} fillOpacity={p.opacity} fillRule={p.evenOdd ? 'evenodd' : undefined} />
      ))}
    </svg>
  );
}

/**
 * An ACP registry icon (a monochrome SVG in `currentColor`), drawn as a mask in the text colour so it follows the
 * theme; as a mask it is only ever a shape, never a document.
 */
export function RegistryIcon({ svg, size = 16, className }: { svg: string; size?: number; className?: string }) {
  const url = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  return (
    <span
      aria-hidden
      className={cn('inline-block shrink-0 bg-current', className)}
      style={{ width: size, height: size, maskImage: url, WebkitMaskImage: url, maskSize: 'contain', WebkitMaskSize: 'contain', maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat', maskPosition: 'center', WebkitMaskPosition: 'center' }}
    />
  );
}

/** The mark on a tile (rows, onboarding); a registry agent's own icon, else initials for custom agents. */
export function ProviderMark({ provider, size = 36, className }: { provider: Pick<Provider, 'id' | 'name'> & { iconSvg?: string }; size?: number; className?: string }) {
  const mark = providerMark(provider.id);
  return (
    <span
      className={cn('ab-pill inline-flex shrink-0 items-center justify-center rounded-[10px] bg-surface text-fg shadow-[inset_0_0_0_.5px_var(--ab-hairline),0_.5px_1px_color-mix(in_srgb,#000_6%,transparent)]', className)}
      style={{ width: size, height: size }}
    >
      {mark ? (
        <ProviderLogo id={provider.id} size={Math.round(size * 0.54)} />
      ) : provider.iconSvg ? (
        <RegistryIcon svg={provider.iconSvg} size={Math.round(size * 0.5)} className="text-fg" />
      ) : (
        <span className="font-display font-medium text-fg-2" style={{ fontSize: size * 0.36 }}>{providerInitials(provider.name)}</span>
      )}
    </span>
  );
}
