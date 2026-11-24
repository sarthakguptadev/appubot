import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from './icons';
import { cn } from './cn';
import { Icon } from './Icon';
import { menuTarget } from './menuKeys';

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  /** drawn where the icon goes, for things that aren't icons (a provider's logo) */
  leading?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
  /** the picker's current choice: a long list opens scrolled to it */
  current?: boolean;
}

/**
 * A menu row (Rare UI's menu shell: `p-1.5`, rows of 36px with squircle corners, 14px, the icon muted); hover and
 * keyboard focus fill it with an ink tint. Shared by the app's other lists that read as menus.
 */
export const MENU_ITEM =
  'squircle flex h-9 w-full items-center gap-2.5 rounded-control-sm px-2.5 text-left text-copy transition-colors duration-100 outline-none disabled:opacity-40';
export const MENU_ITEM_IDLE = 'text-fg hover:bg-[color-mix(in_srgb,var(--ab-fg)_8%,transparent)] focus-visible:bg-[color-mix(in_srgb,var(--ab-fg)_8%,transparent)]';
export const MENU_ITEM_DANGER = 'text-danger hover:bg-danger-soft focus-visible:bg-danger-soft';
/** A separator between groups of a menu: the Settings cards' row hairline. */
export const MENU_SEPARATOR = 'mx-2 my-1 h-px bg-[color-mix(in_srgb,var(--ab-fg)_7%,transparent)]';

/** A menu's items that can take focus, in order. */
function menuItems(root: HTMLElement | null): HTMLElement[] {
  return root ? Array.from(root.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')) : [];
}

/** Item height (h-9) and the menu's padding (p-1.5, both sides), in px. */
const ITEM_H = 36;
const MENU_PAD = 12;

/**
 * Dropdown menu anchored to its trigger (rendered in a portal, closes on outside click / Esc). Past `scrollAfter`
 * items it stops growing and scrolls, showing half of the next item so the list reads as longer. Opening it moves
 * focus to its current (else first) item; ↑↓, Home and End move between items, Tab closes it, and closing it with
 * Esc or a pick hands focus back to where it was.
 */
export function Menu({ trigger, items, align = 'end', className, anchorClassName, scrollAfter = 8 }: {
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode;
  items: (MenuItem | 'separator')[];
  align?: 'start' | 'end';
  className?: string;
  /** classes for the trigger's wrapper (e.g. flex-1 so a trigger can fill a row) */
  anchorClassName?: string;
  /** how many items show before the list scrolls */
  scrollAfter?: number;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  /** what had focus when the menu opened (its trigger, usually), given it back when the menu closes from the keyboard */
  const returnTo = useRef<HTMLElement | null>(null);
  const count = items.filter((it) => it !== 'separator').length;
  const maxHeight = count > scrollAfter ? `min(${(scrollAfter + 0.5) * ITEM_H + MENU_PAD}px, calc(100vh - 16px))` : undefined;

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const w = menu.current?.offsetWidth ?? 200;
    const h = menu.current?.offsetHeight ?? 0;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    const left = align === 'end' ? Math.max(8, r.right - w) : Math.min(r.left, window.innerWidth - w - 8);
    setPos({ top, left });
  }, [open, align]);

  // a long list opens on the item that is checked (a picker's current choice), if there is one
  useLayoutEffect(() => {
    if (!open || !maxHeight) return;
    menu.current?.querySelector<HTMLElement>('[data-current]')?.scrollIntoView({ block: 'nearest' });
  }, [open, maxHeight]);

  // focus goes into the menu as it opens (a mouse open draws no ring: focus-visible follows the last input)
  useLayoutEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = menu.current?.querySelector<HTMLElement>('[role="menuitem"][data-current]:not(:disabled)') ?? menuItems(menu.current)[0];
    el?.focus({ preventScroll: true });
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus && returnTo.current?.isConnected) returnTo.current.focus({ preventScroll: true });
  };

  const onMenuKey = (e: ReactKeyboardEvent) => {
    const list = menuItems(menu.current);
    if (!list.length) return;
    if (e.key === 'Tab') { e.preventDefault(); close(true); return; }
    const to = menuTarget(e.key, list.indexOf(document.activeElement as HTMLElement), list.length);
    if (to === null) return;
    e.preventDefault();
    list[to]?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !anchor.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true); };
  }, [open]);

  return (
    <>
      <span ref={anchor} className={cn('inline-flex', anchorClassName)}>{trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'menu' })}</span>
      {open
        ? createPortal(
            <div
              ref={menu}
              role="menu"
              onKeyDown={onMenuKey}
              style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, maxHeight }}
              className={cn('glass-popover no-drag fixed z-[60] max-h-[min(420px,calc(100vh-16px))] min-w-[200px] overflow-y-auto overscroll-contain rounded-pop p-1.5', className)}
            >
              {items.map((it, i) =>
                it === 'separator' ? (
                  <div key={`s${i}`} role="separator" className={MENU_SEPARATOR} />
                ) : (
                  <button
                    key={it.label}
                    type="button"
                    role="menuitem"
                    disabled={it.disabled}
                    data-current={it.current || undefined}
                    onClick={() => { close(true); it.onSelect(); }}
                    className={cn(MENU_ITEM, it.danger ? MENU_ITEM_DANGER : MENU_ITEM_IDLE)}
                  >
                    {it.leading ?? (it.icon ? <Icon icon={it.icon} size={16} className={it.danger ? '' : 'text-muted'} /> : null)}
                    <span className="flex-1">{it.label}</span>
                    {it.hint}
                  </button>
                ),
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
