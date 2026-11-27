/**
 * The support chat: a panel at the bottom left of the window, over the sidebar's foot, opened from the account menu's
 * Support › Chat with us (and the quick switcher, Settings › About, the Help menu and the tray). There is no floating
 * bubble (the owner's call, 2026-11-27). The panel here is only a frame: main lays Crisp's hosted page over it as a view
 * of its own (electron/supportChat.ts), shown once the frame has finished opening and hidden (kept loaded) when it
 * closes. Escape or a press anywhere else in the window closes it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Spinner } from '../../components/ui';
import { native } from '../../lib/native';
import { setState, useStore } from '../../lib/store';
import { closeSupport, supportUser } from './support';

/** the panel's place: the sidebar's own inset from the left, and just above its foot (the account row) */
const LEFT = 8;
const BOTTOM = 62;
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

export function SupportWidget() {
  const open = useStore((s) => s.supportOpen);
  const reduce = useReducedMotion();
  const vp = useViewport();
  /** the frame has finished opening: the chat may show over it */
  const [ready, setReady] = useState(false);
  const sentUser = useRef(false);

  const width = Math.min(PANEL_W, vp.w - LEFT * 2);
  const height = Math.max(PANEL_MIN_H, Math.min(PANEL_H, vp.h - BOTTOM - TOP_ROOM));

  // main opens and closes it too (Escape in the chat, the Help menu, the tray), and counts unread replies
  useEffect(() => native().onSupportToggle(({ open: o }) => setState({ supportOpen: o })), []);
  useEffect(() => native().onSupportUnread(({ count }) => setState({ supportUnread: count })), []);

  // closing hides the chat at once (before the frame animates away); also on mount, after a reload of this page
  useLayoutEffect(() => {
    if (!open) { setReady(false); native().supportPanel({ open: false }); }
  }, [open]);

  // open: the chat sits inside the frame's hairline, and follows it as the window changes size
  useEffect(() => {
    if (!open || !ready) return;
    native().supportPanel({
      open: true,
      bounds: { x: LEFT + 1, y: vp.h - BOTTOM - height + 1, width: width - 2, height: height - 2 },
      radius: RADIUS - 1,
      ...(sentUser.current ? {} : { user: supportUser() }),
    });
    sentUser.current = true;
  }, [open, ready, vp.h, width, height]);

  // Escape closes it while the window's page has the keys (in the chat itself main does it), and so does a press on
  // the page: the chat is main's own view, so a press inside it never reaches here
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeSupport();
    };
    const onPress = () => closeSupport();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPress, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onPress, true); };
  }, [open]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="support-panel"
          role="dialog"
          aria-label="Chat with Sarthak"
          className="fixed z-[55] flex items-center justify-center overflow-hidden rounded-card border border-[var(--ab-hairline)] bg-[var(--ab-content)] shadow-[0_24px_60px_-12px_rgba(0,0,0,.45),0_4px_16px_rgba(0,0,0,.18)]"
          style={{ left: LEFT, bottom: BOTTOM, width, height, transformOrigin: 'bottom left' }}
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
  );
}
