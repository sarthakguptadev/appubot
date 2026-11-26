/**
 * In-app notices: a deck at the top right (T3 Code's), the newest in front and up to two peeking behind it; hovering
 * fans them out into a list and holds their timers. Each card is Rare UI's toast (components/rare/Toast.tsx: a
 * squircle card, a coloured tile whose glyph draws itself, its title, line and buttons): the tile is the bot's avatar
 * (with a badge for a warning or an error) or an agent's logo where the notice is about one; one about a thread opens
 * it on click. ✕ sits on the corner on hover, and a swipe to the right dismisses.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, ChevronRight, Info, XCircle } from '../../components/ui/icons';
import { BotAvatar, Icon, cn } from '../../components/ui';
import { TOAST_ACTION, TOAST_ACTION_PRIMARY, TOAST_DESCRIPTION, TOAST_PADDING, TOAST_TILE, TOAST_TILE_RADIUS, TOAST_TITLE, ToastClose, ToastIcon, ToastSurface } from '../../components/rare/Toast';
import { ProviderMark } from '../providers/providerLogos';
import { openThread } from '../../lib/actions';
import { dismissToast, pushToast, ui, useStore, type Toast } from '../../lib/store';
import { openGroupChat } from '../groups/groups';
import { EASE_OUT } from '../../lib/motion';

const LEVEL = {
  info: { icon: Info, color: 'var(--ab-fg-2)' },
  success: { icon: CheckCircle2, color: 'var(--ab-success)' },
  warning: { icon: AlertTriangle, color: 'var(--ab-warning)' },
  error: { icon: XCircle, color: 'var(--ab-danger)' },
} as const;

/** how long a notice stays, while nobody hovers the deck */
const LIFE_MS = { info: 5000, success: 4000, warning: 7000, error: 8000 } as const;
const GAP = 8;
const PEEK = 8;
/** cards drawn in the collapsed deck (the rest wait behind, invisible) */
const SHOWN = 3;

function Lead({ t }: { t: Toast }) {
  const l = LEVEL[t.level];
  const agent = useStore((s) => (t.agentId ? s.providers.find((p) => p.id === t.agentId) : undefined));
  const bot = useStore((s) => {
    const th = t.threadId ? s.threads.find((x) => x.id === t.threadId) : undefined;
    return th ? s.bots.find((b) => b.id === th.botId) : undefined;
  });
  // as big as the card's own tile, so the words start on the same edge whatever leads
  const box = { width: TOAST_TILE, height: TOAST_TILE };
  if (agent) return <span className="flex shrink-0 items-center justify-center" style={box}><ProviderMark provider={agent} size={28} /></span>;
  if (bot) {
    return (
      <span className="relative flex shrink-0 items-center justify-center" style={box}>
        <BotAvatar bot={bot} size={32} />
        {t.level !== 'info' ? (
          <span className="absolute -right-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full bg-white shadow-[0_0_0_1.5px_#fff] dark:bg-[#1C1C1E] dark:shadow-[0_0_0_1.5px_#1C1C1E]">
            <span style={{ color: l.color }} className="flex"><Icon icon={l.icon} size={12} /></span>
          </span>
        ) : null}
      </span>
    );
  }
  // something running for it (no agent's logo to lead): the tile spins until it settles
  return <ToastIcon type={t.busy ? 'loading' : t.level} />;
}

interface CardProps {
  t: Toast;
  index: number;
  y: number;
  expanded: boolean;
  frontHeight: number;
  paused: boolean;
  onHeight: (id: string, h: number) => void;
}

function ToastCard({ t, index, y, expanded, frontHeight, paused, onHeight }: CardProps) {
  // the timer runs only while the deck isn't hovered, and goes on from where it stopped
  const left = useRef<number>(LIFE_MS[t.level]);
  useEffect(() => {
    if (paused || t.sticky) return;
    const start = Date.now();
    const timer = setTimeout(() => dismissToast(t.id), left.current);
    return () => { clearTimeout(timer); left.current = Math.max(1200, left.current - (Date.now() - start)); };
  }, [paused, t.id, t.sticky]);
  const close = () => { t.onClose?.(); dismissToast(t.id); };

  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    // the card's own height: its content plus the surface's padding (a card behind is cut to the front one's height)
    const report = () => onHeight(t.id, el.offsetHeight + TOAST_PADDING * 2);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [t.id, onHeight]);

  const dragged = useRef(false);
  const clickable = !!t.threadId || !!t.groupId;
  const behind = !expanded && index > 0;
  const open = () => {
    if ((!t.threadId && !t.groupId) || dragged.current) return;
    // a group's room (and the thread in it that asked or answered)
    if (t.groupId) { ui.selectGroup(t.groupId); if (t.groupChatId) void openGroupChat(t.groupId, t.groupChatId); }
    else if (t.threadId) void openThread(t.threadId);
    dismissToast(t.id);
  };

  return (
    <motion.div
      // T3 Code's toast: in from the window's right edge, out the same way, fading
      initial={{ x: 'calc(100% + 16px)' }}
      animate={{
        opacity: index >= SHOWN && !expanded ? 0 : 1,
        x: 0,
        y,
        scale: expanded ? 1 : 1 - Math.min(index, SHOWN - 1) * 0.05,
      }}
      exit={{ opacity: 0, x: 'calc(100% + 16px)' }}
      transition={{ duration: 0.5, ease: EASE_OUT }}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={{ left: 0.05, right: 0.9 }}
      dragSnapToOrigin
      onDragStart={() => { dragged.current = true; }}
      onDragEnd={(_, info) => {
        if (info.offset.x > 90 || info.velocity.x > 600) close();
        setTimeout(() => { dragged.current = false; }, 0);
      }}
      // the deck is the live region (aria-live); a card that opens its thread takes focus and Enter like a button
      aria-hidden={behind || undefined}
      tabIndex={clickable && !behind ? 0 : undefined}
      onClick={open}
      onKeyDown={(e) => { if (clickable && (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); open(); } }}
      style={{ zIndex: 50 - index, height: behind ? frontHeight : undefined, transformOrigin: 'top center' }}
      className={cn(
        'group/toast no-drag absolute inset-x-0 top-0 select-none rounded-[21px] outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]',
        clickable && 'cursor-pointer',
        behind ? 'pointer-events-none overflow-hidden' : 'pointer-events-auto',
      )}
    >
      <ToastSurface type={t.level}>
        <div ref={inner} className={cn('flex min-w-0 flex-1 gap-3 transition-opacity duration-300 motion-reduce:transition-none', t.body || t.actions?.length || t.busy ? 'items-start' : 'items-center', behind && 'opacity-0')}>
          <Lead t={t} />
          <div className="flex min-h-9 min-w-0 flex-1 flex-col justify-center">
            <p data-slot="toast-title" className={cn(TOAST_TITLE, '[overflow-wrap:anywhere]')}>{t.title}</p>
            {t.body ? (
              <p data-slot="toast-description" className={cn(TOAST_DESCRIPTION, '[overflow-wrap:anywhere]', t.level === 'error' ? 'line-clamp-4' : 'line-clamp-2')}>{t.body}</p>
            ) : null}
            {!t.busy && t.actions?.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5" onPointerDownCapture={(e) => e.stopPropagation()}>
                {t.actions.map((a) => (
                  <button
                    key={a.label} type="button" data-slot="toast-action"
                    onClick={(e) => { e.stopPropagation(); a.onClick(); }}
                    style={{ '--tile-r': `${TOAST_TILE_RADIUS}px` } as CSSProperties}
                    className={cn('ab-pill rounded-(--tile-r)', a.primary ? TOAST_ACTION_PRIMARY : TOAST_ACTION)}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {clickable ? (
            <Icon icon={ChevronRight} size={14} className="shrink-0 self-center text-[#868593] opacity-0 transition-opacity group-hover/toast:opacity-100" />
          ) : null}
        </div>
      </ToastSurface>
      {behind ? null : (
        <ToastClose
          onClick={(e) => { e.stopPropagation(); close(); }}
          onPointerDownCapture={(e) => e.stopPropagation()}
          className="group-focus-visible/toast:opacity-100"
        />
      )}
    </motion.div>
  );
}

/** the mock shows a deck of examples: `?toasts=1` */
// in the dev app and in a mock build (bench/shots.mjs shoots it)
const PREVIEW = (import.meta.env.DEV || import.meta.env.VITE_APPUBOT_MOCK === '1') && typeof location !== 'undefined' && new URLSearchParams(location.search).get('toasts') === '1';

/** The in-app notices (notification events, errors, confirmations), top right under the header. */
export function Toaster() {
  const toasts = useStore((s) => s.toasts);
  const [hover, setHover] = useState(false);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const onHeight = useRef((id: string, h: number) => setHeights((m) => (m[id] === h ? m : { ...m, [id]: h }))).current;

  useEffect(() => { if (!toasts.length) setHover(false); }, [toasts.length]);
  usePreview();

  const order = [...toasts].reverse();
  const hOf = (id: string) => heights[id] ?? 60;
  const frontHeight = order[0] ? hOf(order[0].id) : 0;
  let acc = 0;
  const placed = order.map((t, i) => {
    // collapsed, a card behind is scaled from its top: lower it so its bottom edge peeks PEEK below the one in front
    const y = hover ? acc : i * PEEK + Math.min(i, SHOWN - 1) * 0.05 * frontHeight;
    acc += hOf(t.id) + GAP;
    return { t, i, y };
  });
  const height = !order.length ? 0 : hover ? acc - GAP : frontHeight + Math.min(order.length - 1, SHOWN - 1) * PEEK;

  return (
    <div
      aria-live="polite"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      // past the cards' own height so moving between them doesn't fold the deck
      style={{ height: height + (hover ? 12 : 0) }}
      className="fixed top-16 right-4 z-[90] w-[360px]"
    >
      <AnimatePresence initial={false}>
        {placed.map(({ t, i, y }) => (
          <ToastCard key={t.id} t={t} index={i} y={y} expanded={hover} frontHeight={frontHeight} paused={hover} onHeight={onHeight} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function usePreview(): void {
  const thread = useStore((s) => (PREVIEW ? s.threads[0]?.id : undefined));
  useEffect(() => {
    if (!PREVIEW || !thread) return;
    const life = 1e9;
    Object.assign(LIFE_MS, { info: life, success: life, warning: life, error: life });
    pushToast({ title: 'Saved Codex’s key', level: 'success' });
    pushToast({ title: 'Could not load earlier messages', body: 'The gateway closed the connection before the page arrived.', level: 'error' });
    pushToast({ title: 'Appu has a question', body: 'Should I send the invoice to the whole team or only to Priya?', level: 'info', threadId: thread });
  }, [thread]);
}
