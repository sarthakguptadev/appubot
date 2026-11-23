import { cloneElement, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { appearanceNow } from '../../lib/appearance';

type TriggerProps = { onMouseEnter?: (e: React.MouseEvent) => void; onMouseLeave?: (e: React.MouseEvent) => void; onFocus?: (e: React.FocusEvent) => void; onBlur?: (e: React.FocusEvent) => void };
type Side = 'top' | 'bottom';

const DELAY = 380;
const GAP = 6;
const EDGE = 8;

/**
 * The tooltip itself: the menus' popover look (so it reads in light and dark), kept inside the window: shifted off
 * an edge, and flipped to the other side of the trigger when there is no room on its own.
 */
function TooltipBubble({ label, anchor, side }: { label: ReactNode; anchor: DOMRect; side: Side }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let s = side;
    if (s === 'bottom' && anchor.bottom + GAP + h > vh - EDGE && anchor.top - GAP - h >= EDGE) s = 'top';
    else if (s === 'top' && anchor.top - GAP - h < EDGE && anchor.bottom + GAP + h <= vh - EDGE) s = 'bottom';
    const left = Math.min(Math.max(anchor.left + anchor.width / 2 - w / 2, EDGE), Math.max(EDGE, vw - EDGE - w));
    const top = s === 'bottom' ? anchor.bottom + GAP : anchor.top - GAP - h;
    setAt({ left, top: Math.min(Math.max(top, EDGE), Math.max(EDGE, vh - EDGE - h)) });
  }, [anchor, side, label]);

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      style={at ? { left: at.left, top: at.top } : { left: 0, top: 0, visibility: 'hidden' }}
      className="glass-popover pointer-events-none fixed z-[80] max-w-[min(320px,calc(100vw-16px))] animate-[pop-in_.22s_var(--ease-spring-soft)] rounded-control-sm px-2.5 py-1.5 text-note leading-snug font-medium break-words text-fg"
    >
      {label}
    </div>,
    document.body,
  );
}

/** A control whose menu or popover is open: its tooltip would sit on top of what it opened. */
const isOpen = (el: Element) => el.closest('[aria-expanded]')?.getAttribute('aria-expanded') === 'true';

/**
 * A tip that only repeats what its control already shows (a bot's name under its picture, a tab's label, a row's own
 * title) says nothing and gets in the way, so it stays away, unless that text is cut off somewhere, when the tip is the
 * only way to read it whole.
 */
function saysNothingNew(el: HTMLElement, label: string): boolean {
  const norm = (x: string) => x.replace(/\s+/g, ' ').trim().toLowerCase();
  const tip = norm(label);
  if (!tip || !norm(el.textContent ?? '').includes(tip)) return false;
  const cut = (n: Element) => {
    if (!(n instanceof HTMLElement) || !n.clientWidth) return false;
    const st = getComputedStyle(n);
    return (st.overflowX !== 'visible' && n.scrollWidth > n.clientWidth + 1) || (st.overflowY !== 'visible' && n.scrollHeight > n.clientHeight + 1);
  };
  return !cut(el) && ![...el.querySelectorAll('*')].some(cut);
}

/** A tooltip around one control: hover/focus after a short delay, below (or above) the trigger. No `label`, no tooltip. */
export function Tooltip({ label, children, side = 'bottom' }: { label: ReactNode; children: ReactElement<TriggerProps>; side?: Side }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = (el: Element) => {
    if (timer.current) clearTimeout(timer.current);
    // off unless the person turned tooltips on (Settings › Appearance)
    if (label === null || label === undefined || label === '' || !appearanceNow().tooltips) return;
    timer.current = setTimeout(() => { if (!isOpen(el)) setAnchor(el.getBoundingClientRect()); }, DELAY);
  };
  const hide = () => { if (timer.current) clearTimeout(timer.current); setAnchor(null); };
  useEffect(() => hide, []);

  const child = cloneElement(children, {
    onMouseEnter: (e: React.MouseEvent) => { children.props.onMouseEnter?.(e); show(e.currentTarget); },
    onMouseLeave: (e: React.MouseEvent) => { children.props.onMouseLeave?.(e); hide(); },
    onFocus: (e: React.FocusEvent) => { children.props.onFocus?.(e); show(e.currentTarget); },
    onBlur: (e: React.FocusEvent) => { children.props.onBlur?.(e); hide(); },
  });

  return (
    <>
      {child}
      {anchor ? <TooltipBubble label={label} anchor={anchor} side={side} /> : null}
    </>
  );
}

/**
 * Every plain `title` in the app shows as this tooltip too, rather than macOS's own (other colours, slower, and it
 * can't be styled): on hover the title moves to `data-tip` so the native one never appears, and an icon-only
 * control keeps it as its accessible name. One that repeats what's on screen isn't shown (`saysNothingNew`), and none
 * shows unless tooltips are turned on (Settings › Appearance, off by default: `appearance.tooltips`). Mounted once, at
 * the root.
 */
export function TooltipHost() {
  const [tip, setTip] = useState<{ label: string; anchor: DOMRect } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let current: HTMLElement | null = null;
    // the control just pressed: its tooltip stays away until the pointer leaves it (the press often opened a menu)
    let pressed: HTMLElement | null = null;
    const clear = () => { if (timer) clearTimeout(timer); timer = null; current = null; setTip(null); };
    const target = (e: Event) => {
      const t = e.target instanceof Element ? e.target : null;
      const el = t?.closest<HTMLElement>('[title], [data-tip]');
      return el instanceof HTMLElement ? el : null;
    };
    const take = (el: HTMLElement) => {
      const title = el.getAttribute('title');
      if (title !== null) {
        el.removeAttribute('title');
        if (title) el.dataset.tip = title;
        if (title && !el.getAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', title);
      }
      return el.dataset.tip ?? '';
    };
    const over = (e: Event) => {
      const el = target(e);
      if (el === current) return;
      clear();
      if (!el || el === pressed) return;
      // the title is taken either way, so macOS's own tooltip never shows while ours are off (Settings › Appearance)
      const label = take(el);
      if (!label || !appearanceNow().tooltips) return;
      current = el;
      timer = setTimeout(() => { if (current === el && el.isConnected && !isOpen(el) && !saysNothingNew(el, label)) setTip({ label, anchor: el.getBoundingClientRect() }); }, DELAY);
    };
    const out = (e: MouseEvent) => {
      const to = e.relatedTarget instanceof Node ? e.relatedTarget : null;
      if (pressed && (!to || !pressed.contains(to))) pressed = null;
      if (!current) return;
      if (!to || !current.contains(to)) clear();
    };
    const down = (e: Event) => { clear(); pressed = target(e); };
    document.addEventListener('mouseover', over, true);
    document.addEventListener('mouseout', out, true);
    document.addEventListener('focusin', over, true);
    document.addEventListener('focusout', clear, true);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('wheel', clear, { capture: true, passive: true });
    window.addEventListener('blur', clear);
    return () => {
      clear();
      document.removeEventListener('mouseover', over, true);
      document.removeEventListener('mouseout', out, true);
      document.removeEventListener('focusin', over, true);
      document.removeEventListener('focusout', clear, true);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('wheel', clear, true);
      window.removeEventListener('blur', clear);
    };
  }, []);

  return tip ? <TooltipBubble label={tip.label} anchor={tip.anchor} side="bottom" /> : null;
}
