import { useState, type CSSProperties } from 'react';
import { isDirectApp, type AppConnection, type AppToolkit } from '@appubot/protocol';
import { Check, ChevronDown, Plus, Trash2 } from '../../components/ui/icons';
import { Icon, Menu, Spinner, Tooltip, cn } from '../../components/ui';
import { useStore } from '../../lib/store';
import { disconnect, startConnect, useAppsUi } from './appsData';

/** A logo tile (40px in a row): brand marks sit on white (they're drawn for light backgrounds); no logo, the initial. */
export function AppLogo({ toolkit, size = 40 }: { toolkit: Pick<AppToolkit, 'name' | 'logo'>; size?: number }) {
  const [broken, setBroken] = useState(false);
  const logo = toolkit.logo && !broken ? toolkit.logo : null;
  return (
    <span
      style={{ width: size, height: size, '--tile-r': `${size / 4}px` } as CSSProperties}
      className={cn(
        'ab-pill flex shrink-0 items-center justify-center overflow-hidden rounded-(--tile-r) border border-[var(--ab-hairline)]',
        logo ? 'bg-white' : 'bg-surface-2 text-lead font-medium text-fg-2',
      )}
    >
      {logo ? (
        <img src={logo} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken(true)} className="size-[66%] object-contain" />
      ) : (
        toolkit.name.trim().charAt(0).toUpperCase() || '?'
      )}
    </span>
  );
}

/** A few apps' logos as a row of small tiles, each lying over the one before it; `ring` is the colour they sit on. */
export function AppLogoStack({ toolkits, ring, max = 4 }: { toolkits: Pick<AppToolkit, 'slug' | 'name' | 'logo'>[]; ring: string; max?: number }) {
  return (
    <span aria-hidden className="flex shrink-0 items-center -space-x-1.5">
      {toolkits.slice(0, max).map((t) => (
        <span key={t.slug} className="ab-pill flex rounded-[5px]" style={{ boxShadow: `0 0 0 2px ${ring}` }}><AppLogo toolkit={t} size={20} /></span>
      ))}
    </span>
  );
}

const PILL =
  'ab-press ab-pill squircle no-drag inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[9px] bg-surface-2 px-3.5 text-ui font-semibold tracking-ui text-fg ' +
  'transition-colors duration-100 hover:bg-surface-3 focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-bg),0_0_0_4px_var(--ab-ring)]';

/**
 * The row's right side: Add / Connect, a spinner while signing in, or "Added" (with Add another account and Disconnect
 * in its menu). In the list of connected apps (`listed`) a working one says "Connected", in green.
 */
export function AppAction({ toolkit: t, conns, listed = false }: { toolkit: AppToolkit; conns: AppConnection[]; listed?: boolean }) {
  const pending = useStore((s) => !!s.apps?.pending.includes(t.slug));
  const starting = useAppsUi((s) => !!s.starting[t.slug]);
  // Add was pressed while signed out of Composio: its sign-in is open in the browser, and this app follows it
  const forThis = useAppsUi((s) => s.afterSignIn?.slug === t.slug);
  const signingIn = useStore((s) => !!s.apps?.signingIn) && forThis;
  const active = conns.filter((c) => c.status === 'ACTIVE');

  if (pending || starting || signingIn) {
    return (
      <Tooltip label={pending || signingIn ? 'Finish signing in, or click to start over' : 'Connecting…'}>
        <button type="button" aria-label={`Connecting ${t.name}`} className={cn(PILL, 'min-w-[60px]')} onClick={() => { if (pending || signingIn) void startConnect(t); }}>
          <Spinner size={13} />
        </button>
      </Tooltip>
    );
  }
  if (active.length) {
    return (
      <Menu
        items={[
          // a second Gmail, a work calendar: Composio's page again, and the account in use stays the default
          ...(isDirectApp(t.slug) || t.authKind === 'none' ? [] : [{ label: 'Add another account', icon: Plus, onSelect: () => void startConnect(t) }]),
          { label: 'Disconnect', icon: Trash2, danger: true, onSelect: () => disconnect(t, conns) },
        ]}
        className="min-w-[160px]"
        trigger={(p) => (
          <button
            {...p}
            type="button"
            className={cn(
              'ab-pill squircle no-drag group/added inline-flex h-8 shrink-0 items-center gap-1 rounded-[9px] px-2 text-ui transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]',
              // the word ends at the row's edge, like the pills above and below it
              listed ? '-mr-2 font-medium text-success' : 'text-muted hover:text-fg',
            )}
          >
            {listed ? null : <Icon icon={Check} size={14} />}
            {listed ? 'Connected' : 'Added'}
            {listed ? null : <Icon icon={ChevronDown} size={12} className="opacity-0 transition-opacity group-hover/added:opacity-100 group-aria-expanded/added:opacity-100" />}
          </button>
        )}
      />
    );
  }
  // Composio's no-sign-in apps are every bot's as they are; one on its own server is added first (it is the person's pick)
  if (t.authKind === 'none' && !isDirectApp(t.slug)) {
    return (
      <Tooltip label="Works without signing in">
        <span className="inline-flex h-7 shrink-0 items-center gap-1 px-2 text-ui text-muted"><Icon icon={Check} size={14} />Ready</span>
      </Tooltip>
    );
  }
  // an expired or failed connection: sign in again
  const label = conns.length ? 'Reconnect' : t.authKind === 'oauth' || isDirectApp(t.slug) ? 'Add' : 'Connect';
  return <button type="button" className={PILL} onClick={() => void startConnect(t)}>{label}</button>;
}

export function AppRow({ toolkit: t, conns }: { toolkit: AppToolkit; conns: AppConnection[] }) {
  return (
    <div className="flex min-w-0 items-center gap-3 py-2">
      <AppLogo toolkit={t} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-copy leading-5 font-medium text-fg">{t.name}</div>
        <div className="truncate text-copy leading-[18px] text-muted" title={t.description}>{t.description || t.slug}</div>
      </div>
      <AppAction toolkit={t} conns={conns} />
    </div>
  );
}

/** Placeholder rows while a section loads. */
export function AppRowSkeleton() {
  return (
    <div className="flex items-center gap-3 py-2" aria-hidden>
      <span className="ab-pill size-10 shrink-0 rounded-[10px] bg-surface-2" />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="h-3 w-24 rounded-full bg-surface-2" />
        <span className="h-2.5 w-40 max-w-full rounded-full bg-surface-2 opacity-70" />
      </span>
      <span className="h-7 w-14 rounded-full bg-surface-2 opacity-70" />
    </div>
  );
}
