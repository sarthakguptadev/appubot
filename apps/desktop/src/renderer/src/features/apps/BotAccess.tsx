import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { appOn, type AppToolkit } from '@appubot/protocol';
import { appBots } from '@appubot/chat-core';
import { ChevronDown } from '../../components/ui/icons';
import { BotAvatar, Icon, Switch, cn } from '../../components/ui';
import { useStore } from '../../lib/store';
import { setAppOn } from './appsData';

const SHOWN = 4;

/** Who may use one connected app: a switch per bot (the app stays connected once, for all of them). */
function BotsPopover({ anchor, toolkit: t, onClose }: { anchor: HTMLElement; toolkit: AppToolkit; onClose: () => void }) {
  const bots = useStore((s) => s.bots);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = ref.current?.offsetWidth ?? 280;
    const h = ref.current?.offsetHeight ?? 0;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    setPos({ top, left: Math.min(Math.max(8, r.left), window.innerWidth - w - 8) });
  }, [anchor, bots.length]);

  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose(); };
    // its own Escape, before the dialog's (which would close Connect apps)
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key, true); };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={`Bots that can use ${t.name}`}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      className="glass-popover no-drag fixed z-[60] w-[280px] animate-[pop-in_.3s_var(--ease-spring-soft)] rounded-pop p-1.5"
    >
      <div className="px-2.5 pt-1.5 pb-1 text-note font-medium text-muted">Bots that can use {t.name}</div>
      <ul className="flex max-h-[320px] flex-col overflow-y-auto">
        {bots.map((b) => {
          const on = appOn(b, t.slug);
          return (
            <li key={b.id}>
              <label className="ab-pill squircle flex h-9 cursor-default items-center gap-2.5 rounded-control-sm px-2.5 transition-colors hover:bg-[color-mix(in_srgb,var(--ab-fg)_8%,transparent)]">
                <BotAvatar bot={b} size={20} />
                <span className="min-w-0 flex-1 truncate text-copy text-fg">{b.name}</span>
                <Switch checked={on} onChange={(v) => void setAppOn(b, t.slug, v)} label={`${b.name} can use ${t.name}`} />
              </label>
            </li>
          );
        })}
      </ul>
      <p className="hairline-t mt-1 px-2.5 pt-2 pb-1.5 text-note leading-snug text-muted">New bots start with every connected app on.</p>
    </div>,
    document.body,
  );
}

/** Under a connected app's name: the bots it's on for (avatars, "All bots" / "2 of 3 bots"), opening a switch per bot. */
export function BotAccess({ toolkit: t }: { toolkit: AppToolkit }) {
  const bots = useStore((s) => s.bots);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const { on, label } = appBots(bots, t.slug);
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        aria-label={`Bots that can use ${t.name}: ${label}`}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        className={cn(
          'no-drag ab-pill -ml-1.5 flex h-[22px] max-w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-copy transition-colors hover:bg-surface-2',
          'focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ab-ring)]',
          anchor && 'bg-surface-2',
        )}
      >
        {on.length ? (
          <span className="flex shrink-0 items-center -space-x-1">
            {on.slice(0, SHOWN).map((b) => <BotAvatar key={b.id} bot={b} size={16} />)}
          </span>
        ) : (
          <span className="size-4 shrink-0 rounded-full border border-dashed border-[color-mix(in_srgb,var(--ab-fg)_28%,transparent)]" />
        )}
        <span className="min-w-0 truncate text-muted">{label}</span>
        <Icon icon={ChevronDown} size={13} className="shrink-0 text-muted" />
      </button>
      {anchor ? <BotsPopover anchor={anchor} toolkit={t} onClose={() => setAnchor(null)} /> : null}
    </>
  );
}
