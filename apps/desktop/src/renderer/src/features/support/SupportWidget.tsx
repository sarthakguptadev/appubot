/**
 * The support chat widget, drawn like the website's Crisp widget: an orange bubble at the bottom right of the window
 * that expands into the chat panel above it and collapses back (its X, the bubble, Escape). The panel here is only a
 * frame: main lays Crisp's hosted page over it as a view of its own (electron/supportChat.ts), shown once the frame
 * has finished opening and hidden (kept loaded) when it closes. The bubble keeps clear of anything marked
 * `data-support-avoid` (the chat's composer): where that reaches into the corner, it sits just above it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Spinner, cn } from '../../components/ui';
import { AnimatedCounter } from '../../components/rare/AnimatedCounter';
import { native } from '../../lib/native';
import { setState, useStore } from '../../lib/store';
import { closeSupport, supportUser, toggleSupport } from './support';
// Crisp's own launcher icons, byte for byte as its widget draws them on appubot.com (a background image each)
import crispChatIcon from './crisp-chat.svg';
import crispCloseIcon from './crisp-close.svg';

/** Crisp's `deep_orange`, the website's bubble */
export const SUPPORT_ORANGE = '#e45300';
/** Crisp's launcher: a 54px circle 24px from the right and 20px from the bottom */
const SIZE = 54;
/** the bubble's bottom gap, and the window edge the panel keeps clear of */
const EDGE = 20;
const RIGHT = 24;
/** between the bubble and what it keeps clear of, and between the bubble and the panel */
const GAP = 14;
const PANEL_W = 380;
const PANEL_H = 600;
const PANEL_MIN_H = 260;
/** the window's top strip (traffic lights, headers) stays clear of the panel */
const TOP_ROOM = 56;
const RADIUS = 16;

function useViewport(): { w: number; h: number } {
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return vp;
}

/**
 * How far above the window's bottom the bubble sits: `EDGE`, or just above whatever marked `data-support-avoid`
 * reaches into its corner. Settings covers the chat, so nothing under it counts while it is open.
 */
function useBubbleBottom(vp: { w: number; h: number }): number {
  const settingsOpen = useStore((s) => !!s.settingsSection);
  const [bottom, setBottom] = useState(EDGE);
  useEffect(() => {
    if (settingsOpen) { setBottom(EDGE); return; }
    let frame = 0;
    const sizes = new ResizeObserver(() => schedule());
    // only elements not watched yet are observed: observe() always reports once, so re-observing every element on
    // each pass would schedule the next pass, a loop running every frame for as long as the chat shows
    let watched = new Set<HTMLElement>();
    const place = () => {
      frame = 0;
      const left = window.innerWidth - RIGHT - SIZE - GAP;
      let b = EDGE;
      const now = new Set(document.querySelectorAll<HTMLElement>('[data-support-avoid]'));
      for (const el of watched) if (!now.has(el)) sizes.unobserve(el);
      for (const el of now) if (!watched.has(el)) sizes.observe(el);
      watched = now;
      for (const el of now) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || r.right <= left) continue;
        // it reaches into the bubble's corner: sit above it
        if (r.bottom > window.innerHeight - b - SIZE - GAP) b = Math.max(b, window.innerHeight - r.top + GAP);
      }
      setBottom(b);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
    const added = new MutationObserver(schedule);
    added.observe(document.body, { childList: true, subtree: true });
    schedule();
    return () => { cancelAnimationFrame(frame); added.disconnect(); sizes.disconnect(); };
  }, [settingsOpen, vp.w, vp.h]);
  return bottom;
}

/** Crisp's icons where its launcher puts them: the speech bubble 35×30 at (9, 14), the X 22×22 at (16, 17) */
const ICON = {
  chat: { src: crispChatIcon, width: 35, height: 30, left: 9, top: 14 },
  close: { src: crispCloseIcon, width: 22, height: 22, left: 16, top: 17 },
} as const;

export function SupportWidget() {
  const open = useStore((s) => s.supportOpen);
  // voice mode has the window to itself: its round controls are the only ones at the bottom
  const voice = useStore((s) => !!s.voiceMode);
  const unread = useStore((s) => s.supportUnread);
  const reduce = useReducedMotion();
  const vp = useViewport();
  const bottom = useBubbleBottom(vp);
  /** the frame has finished opening: the chat may show over it */
  const [ready, setReady] = useState(false);
  const sentUser = useRef(false);

  const panelBottom = bottom + SIZE + GAP;
  const width = Math.min(PANEL_W, vp.w - RIGHT * 2);
  const height = Math.max(PANEL_MIN_H, Math.min(PANEL_H, vp.h - panelBottom - TOP_ROOM));

  // main opens and closes it too (Escape in the chat, the Help menu, the tray), and counts unread replies
  useEffect(() => native().onSupportToggle(({ open: o }) => setState({ supportOpen: o })), []);
  useEffect(() => native().onSupportUnread(({ count }) => setState({ supportUnread: count })), []);

  // closing hides the chat at once (before the frame animates away); also on mount, after a reload of this page
  useLayoutEffect(() => {
    if (!open) { setReady(false); native().supportPanel({ open: false }); }
  }, [open]);

  // open: the chat sits inside the frame's hairline, and follows it as the window or the bubble moves
  useEffect(() => {
    if (!open || !ready) return;
    const x = vp.w - RIGHT - width + 1;
    const y = vp.h - panelBottom - height + 1;
    native().supportPanel({
      open: true,
      bounds: { x, y, width: width - 2, height: height - 2 },
      radius: RADIUS - 1,
      ...(sentUser.current ? {} : { user: supportUser() }),
    });
    sentUser.current = true;
  }, [open, ready, vp.w, vp.h, width, height, panelBottom]);

  // Escape closes it while the window's page has the keys (in the chat itself main does it)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeSupport();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  if (voice && !open) return null;
  return (
    <>
      <AnimatePresence>
        {open ? (
          <motion.div
            key="support-panel"
            role="dialog"
            aria-label="Chat with Sarthak"
            className="fixed z-[55] flex items-center justify-center overflow-hidden rounded-card border border-[var(--ab-hairline)] bg-[var(--ab-content)] shadow-[0_24px_60px_-12px_rgba(0,0,0,.45),0_4px_16px_rgba(0,0,0,.18)]"
            style={{ right: RIGHT, bottom: panelBottom, width, height, transformOrigin: 'bottom right' }}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 12 }}
            transition={{ duration: reduce ? 0.1 : 0.2, ease: [0.25, 1, 0.5, 1] }}
            onAnimationComplete={() => { if (useStore.getState().supportOpen) setReady(true); }}
          >
            {/* under the chat until it has drawn */}
            <Spinner size={18} className="text-muted" />
          </motion.div>
        ) : null}
      </AnimatePresence>
      <button
        type="button"
        aria-label={open ? 'Close chat' : unread ? `Chat with Sarthak (${unread} new)` : 'Chat with Sarthak'}
        aria-expanded={open}
        onClick={toggleSupport}
        className={cn(
          'no-drag fixed z-[55] rounded-full transition-[transform,bottom] duration-200 ease-out hover:scale-[1.06] active:scale-95',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ab-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ab-bg)]',
        )}
        style={{ right: RIGHT, bottom, width: SIZE, height: SIZE, background: SUPPORT_ORANGE, boxShadow: '0 4px 10px rgba(0,0,0,.05)' }}
      >
        <AnimatePresence initial={false}>
          {(['chat', 'close'] as const).filter((k) => (k === 'close') === open).map((k) => (
            <motion.span
              key={k}
              aria-hidden
              className="absolute bg-contain bg-center bg-no-repeat"
              style={{ left: ICON[k].left, top: ICON[k].top, width: ICON[k].width, height: ICON[k].height, backgroundImage: `url("${ICON[k].src}")` }}
              initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.5, rotate: k === 'close' ? -90 : 0 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.5, rotate: k === 'close' ? 90 : 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            />
          ))}
        </AnimatePresence>
        {unread > 0 && !open ? (
          <span className="absolute -top-0.5 -right-0.5 flex h-5 min-w-5 animate-[pop-in_.3s_var(--ease-spring-bouncy)] items-center justify-center rounded-full bg-danger px-1 text-[11px] font-semibold text-white ring-2 ring-[var(--ab-bg)]">
            {/* Rare UI's counter: a new reply rolls the number up */}
            <AnimatedCounter value={Math.min(unread, 9)} suffix={unread > 9 ? '+' : undefined} duration={0.45} />
          </span>
        ) : null}
      </button>
    </>
  );
}
