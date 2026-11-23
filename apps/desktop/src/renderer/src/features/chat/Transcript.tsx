// The chat column (Synara's MessagesTimeline frame, MIT): one thread of a bot, its whole history in order. It
// follows the end while new content streams in until you scroll away yourself (only wheel, touch, drag and keys
// detach it; growing content never does), offers a round "scroll to bottom" arrow while detached, renders the newest
// messages and pages older ones in as you scroll up without moving what you are reading. Akeru's separators mark
// where a sitting resumes (the first message, a new day, a gap of 4 hours); times also live in each message's footer.
// A routine's prompt is one line, and its runs with nothing to say fold into one (chat-core `foldRoutineRuns`).
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Message } from '@appubot/protocol';
import { conversationSeparators, foldRoutineRuns, routineOf, type TranscriptItem } from '@appubot/chat-core';
import { ArrowDown } from '../../components/ui/icons';
import { Icon, Spinner, cn } from '../../components/ui';
import { rpc } from '../../lib/gateway';
import { connectionDropped } from '../../lib/actions';
import { getState, mergeConversation, pushToast, rowKeyOf, useStore } from '../../lib/store';
import { markOnce } from '../../lib/perfMarks';
import { useMessagesTheme } from '../../lib/appearance';
import { AgentTurn } from './AgentTurn';
import { UserMessage } from './UserMessage';
import { RoutineFoldLine, RoutinePromptLine } from './RoutineLines';

/** rows rendered at first (a few screens: opening a long chat draws only these); scrolling up draws more of what is
 * loaded, `GROW` at a time, then loads older pages */
const WINDOW = 30;

/** Chat search's requests to the transcript (window event `FIND_EVENT`). */
export interface FindRequest { threadId: string; all?: boolean; detach?: boolean }
export const FIND_EVENT = 'appubot:transcript-find';
const PAGE = 100;
/**
 * Older rows drawn per step while scrolling up: small enough that one step (its markdown parsed, its rows laid out)
 * fits a frame (100 at a time dropped 4-6 frames on the way up a 600-message chat; bench/scroll.mjs).
 */
const GROW = 30;
/** start loading older messages this far before the top comes into view */
const PRELOAD_PX = 800;
const EMPTY: string[] = [];

/** A message you just sent from this Mac; only those animate in (Synara's chat-message-send-enter). */
const isLocalSend = (m: Message | undefined) => m?.role === 'user' && m.via === 'desktop';

/** Where the conversation resumes: a quiet centred date and time, words alone (the hairlines either side went on 2026-11-17). */
export function Separator({ label }: { label: string }) {
  return (
    <div role="separator" aria-label={label} className="chat-separator mt-4 mb-3 flex items-center justify-center px-1 first:mt-0">
      <span className="shrink-0 text-xs text-muted tabular-nums">{label}</span>
    </div>
  );
}

const Row = memo(function Row({ threadId, id, botName, cwd, animate, separator }: {
  threadId: string; id: string; botName: string; cwd?: string; animate: boolean; separator: string | null;
}) {
  const msg = useStore((s) => s.convo[threadId]?.byId[id]);
  const [enter] = useState(() => animate && isLocalSend(msg));
  if (!msg) return null;
  // Synara's row: px-1 inside the 46rem column; a sent message pb-3.5, the same gap a settled reply leaves under itself
  // in the answers view, so the chat changes sides at one even step (bubbles of one side sit 4px apart)
  return (
    <>
      {separator ? <Separator label={separator} /> : null}
      <div data-message-id={id} className={cn('flex flex-col px-1', msg.role === 'user' && 'pb-3.5', enter && 'chat-message-send-enter')}>
        {msg.role === 'agent' ? <AgentTurn msg={msg} botName={botName} cwd={cwd} />
          : msg.via === 'routine' ? <RoutinePromptLine msg={msg} botName={botName} /> : <UserMessage msg={msg} botName={botName} />}
      </div>
    </>
  );
});

/**
 * The rows for the messages on screen: each as itself, a routine's runs with nothing to say folded into one. Read from
 * the store as a short signature (the rows' keys, a fold's size and name), so a reply streaming in re-renders the list
 * only when the folding changes; the folds themselves are worked out again from the store then.
 */
function foldItems(threadId: string, visible: readonly string[], separators: readonly (string | null)[]): TranscriptItem[] {
  const byId = getState().convo[threadId]?.byId ?? {};
  const list = visible.map((id) => byId[id]).filter((m): m is Message => !!m);
  // (a message not in the store yet: no folding this time round)
  if (list.length !== visible.length || !list.some((m) => routineOf(m))) return visible.map((id, index) => ({ kind: 'message', key: rowKeyOf(id), id, index }));
  return foldRoutineRuns(list, { keyOf: rowKeyOf, separators });
}
const foldSignature = (items: readonly TranscriptItem[]) => items.map((x) => (x.kind === 'message' ? x.key : `${x.key}#${x.ids.length}#${x.routine.name}`)).join('|');

/** Distance from the end that still counts as "at the end": Synara resumes following within a pixel. */
const AT_END_PX = 1;
/** The arrow appears once you've been away from the end this long (debounced, so a flick doesn't flash it). */
const SHOW_JUMP_DELAY_MS = 150;
/** Scroll events this soon after our own scrollTo are layout, not the reader. */
const PROGRAMMATIC_SCROLL_MS = 200;

const distanceFromEnd = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;
const nearEnd = (el: HTMLElement, px = AT_END_PX) => distanceFromEnd(el) <= px;
const SCROLL_KEYS = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];

export function Transcript({ threadId, botName, cwd, footer }: {
  threadId: string; botName: string; cwd?: string;
  /** a row of pills under the latest message (what the system still has to allow: ThreadView's `SetupPill`) */
  footer?: ReactNode;
}) {
  const ids = useStore((s) => s.convo[threadId]?.ids ?? EMPTY);
  const loaded = useStore((s) => !!s.convo[threadId]?.loaded);
  // a spinner only with nothing to show: what's kept (a saved copy, a chat read before) shows while the newest page
  // comes; with nothing kept it spins from the moment the chat opens, also while the computer is still connecting (a
  // cloud computer waking), not only once its page is asked for
  const waiting = useStore((s) => !!s.convo[threadId]?.loading || s.conn !== 'connected');
  const loading = waiting && !loaded && !ids.length;
  const hasMore = useStore((s) => !!s.convo[threadId]?.hasMore);
  const [limit, setLimit] = useState(WINDOW);
  const [paging, setPaging] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  /** stick to the end as content grows; only the reader's own gestures turn it off */
  const follow = useRef(true);
  /** the first scroll after you send glides; streaming re-sticks stay instant */
  const glideNext = useRef(false);
  const programmaticUntil = useRef(0);
  const jumpTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** where a wheel/key gesture started, checked once it has had a frame or two to move */
  const gesture = useRef<{ scrollTop: number; wasFollowing: boolean; keyboard?: boolean } | null>(null);
  const gestureFrame = useRef<number | null>(null);
  /**
   * The first row drawn when older rows were asked for, and its place in the content then: once they are drawn above
   * it, the scroll moves by however far it went down. Measured in the content, not the viewport, so scrolling done
   * between asking and drawing (a page awaited) is kept, not undone.
   */
  const anchor = useRef<{ firstId: string; pos: number } | null>(null);
  const rowPos = (id: string): number | null => {
    const row = content.current?.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
    return row && content.current ? row.getBoundingClientRect().top - content.current.getBoundingClientRect().top : null;
  };
  /** ids present when the chat first loaded (or paged in) don't animate; later arrivals do */
  const known = useRef<Set<string> | null>(null);
  if (!known.current && loaded) known.current = new Set(ids);

  const start = Math.max(0, ids.length - limit);
  const visible = useMemo(() => ids.slice(start), [ids, start]);
  const mayHaveOlder = start > 0 || hasMore;
  // a message's time never changes, so the labels only follow the rows on screen
  const separators = useMemo(() => {
    const byId = getState().convo[threadId]?.byId ?? {};
    return conversationSeparators(visible.map((id) => byId[id] ?? { createdAt: 0 }));
  }, [threadId, visible]);
  // only worked out when a routine's prompt is among the rows (most chats have none)
  const folding = useStore((s) => {
    const byId = s.convo[threadId]?.byId;
    return !!byId && visible.some((id) => byId[id]?.via === 'routine' && byId[id]?.role === 'user');
  });
  const foldSig = useStore((s) => (folding && s.convo[threadId] ? foldSignature(foldItems(threadId, visible, separators)) : ''));
  const items = useMemo(
    () => (foldSig ? foldItems(threadId, visible, separators) : visible.map((id, index): TranscriptItem => ({ kind: 'message', key: rowKeyOf(id), id, index }))),
    [foldSig, threadId, visible, separators],
  );

  const toBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    programmaticUntil.current = performance.now() + PROGRAMMATIC_SCROLL_MS;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  const hideJump = useCallback(() => {
    clearTimeout(jumpTimer.current);
    jumpTimer.current = undefined;
    setShowJump(false);
  }, []);
  const showJumpSoon = useCallback(() => {
    clearTimeout(jumpTimer.current);
    jumpTimer.current = setTimeout(() => setShowJump(true), SHOW_JUMP_DELAY_MS);
  }, []);
  useEffect(() => () => {
    clearTimeout(jumpTimer.current);
    if (gestureFrame.current !== null) cancelAnimationFrame(gestureFrame.current);
  }, []);

  const resume = useCallback((scroll: boolean) => {
    follow.current = true;
    hideJump();
    if (scroll) toBottom();
  }, [hideJump, toBottom]);

  /** A gesture takes the scroll from auto-follow (only when there is anything to scroll). */
  const detach = useCallback(() => {
    if (gestureFrame.current !== null) { cancelAnimationFrame(gestureFrame.current); gestureFrame.current = null; }
    glideNext.current = false;
    programmaticUntil.current = 0;
    const el = scroller.current;
    if (el && el.scrollHeight > el.clientHeight + 1) follow.current = false;
  }, []);

  /** After a gesture: back at the end resumes following, anywhere else shows the arrow. */
  const release = useCallback(() => {
    gesture.current = null;
    const el = scroller.current;
    if (!el) return;
    if (nearEnd(el)) resume(false);
    else { follow.current = false; showJumpSoon(); }
  }, [resume, showJumpSoon]);

  const onScrollGesture = useCallback((upward: boolean) => {
    const el = scroller.current;
    if (!el) return;
    if (!upward && follow.current && nearEnd(el)) return;
    // a gesture that starts more than a viewport above the end is reading, so it must not snap back
    const origin = gesture.current ?? {
      scrollTop: el.scrollTop,
      wasFollowing: follow.current && nearEnd(el, el.clientHeight) && (!upward || nearEnd(el)),
    };
    detach();
    gesture.current = origin;
    // native scrolling settles a frame or two later; judge the gesture by where it went
    gestureFrame.current = requestAnimationFrame(() => {
      gestureFrame.current = requestAnimationFrame(() => {
        gestureFrame.current = null;
        gesture.current = null;
        // a nested or no-op wheel must not strand follow
        if (origin.wasFollowing && el.scrollTop >= origin.scrollTop) resume(true);
        else release();
      });
    });
  }, [detach, release, resume]);

  // keyboard scrolling inside the transcript (not while typing)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const el = scroller.current;
      const t = e.target;
      if (!el || !(t instanceof Element) || !el.contains(t) || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (t.closest('input, textarea, [contenteditable]') || !SCROLL_KEYS.includes(e.key)) return;
      if (e.key === ' ' && t.closest('button, a, [role="button"]')) return;
      const upward = e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home' || (e.key === ' ' && e.shiftKey);
      if (!upward) { onScrollGesture(false); return; }
      if (el.scrollTop <= 0) return;
      const origin = gesture.current?.keyboard ? gesture.current : { scrollTop: el.scrollTop, wasFollowing: follow.current && nearEnd(el, el.clientHeight), keyboard: true };
      detach();
      gesture.current = origin;
      showJumpSoon();
    };
    const onKeyUp = () => {
      const origin = gesture.current;
      if (!origin?.keyboard) return;
      // key scrolling can start after keyup; give it a moment, then recover a no-op gesture
      const deadline = performance.now() + 150;
      const check = () => {
        gestureFrame.current = null;
        const el = scroller.current;
        if (!el || gesture.current !== origin) return;
        const movedUp = el.scrollTop < origin.scrollTop - 1;
        if (!movedUp && performance.now() < deadline) { gestureFrame.current = requestAnimationFrame(check); return; }
        gesture.current = null;
        if (origin.wasFollowing && !movedUp) resume(true);
        else release();
      };
      gestureFrame.current = requestAnimationFrame(check);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onKeyUp);
    };
  }, [detach, onScrollGesture, release, resume, showJumpSoon]);

  // a saved copy on screen first: its fresh page landing keeps a reader who scrolled up where they are
  useLayoutEffect(() => { if (follow.current) toBottom(); if (loaded) markOnce('appubot:transcript-painted', true); }, [loaded, toBottom]);

  // keep the reading position when older messages are prepended; a message you send re-arms following
  useLayoutEffect(() => {
    const k = known.current;
    if (k) {
      const byId = getState().convo[threadId]?.byId;
      // (the computer's copy taking a local one's row is the same message: no second re-arm)
      if (visible.some((id) => !k.has(id) && !k.has(rowKeyOf(id)) && isLocalSend(byId?.[id]))) {
        if (gestureFrame.current !== null) { cancelAnimationFrame(gestureFrame.current); gestureFrame.current = null; }
        gesture.current = null;
        glideNext.current = true;
        resume(false);
      }
      visible.forEach((id) => k.add(id));
    }
    const el = scroller.current;
    if (el && anchor.current && anchor.current.firstId !== visible[0]) {
      const pos = rowPos(anchor.current.firstId);
      if (pos !== null) el.scrollTop += pos - anchor.current.pos;
      anchor.current = null;
    }
  });

  // growth (deltas, new rows, images) keeps the end in view while following
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!follow.current) return;
      const glide = glideNext.current;
      glideNext.current = false;
      toBottom(glide);
    });
    ro.observe(el);
    // the viewport shrinks too, e.g. when an approval docks onto the composer
    if (scroller.current) ro.observe(scroller.current);
    return () => ro.disconnect();
  }, [toBottom]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    // edge fades only once there is something past that edge
    const top = el.scrollTop > 0;
    const bottom = distanceFromEnd(el) > AT_END_PX;
    setEdges((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }));
    // a detached reader who scrolls back down to the very end follows again; layout never detaches
    if (!follow.current && !gesture.current && nearEnd(el)) resume(false);
    if (el.scrollTop <= PRELOAD_PX) nearTop();
  };

  const onJump = () => {
    if (gestureFrame.current !== null) { cancelAnimationFrame(gestureFrame.current); gestureFrame.current = null; }
    gesture.current = null;
    follow.current = true;
    hideJump();
    toBottom(true);
  };

  /**
   * The computer's next older page into memory (not drawn yet), one request at a time: asked for ahead of the reader
   * (see `showEarlier`), so scrolling up rarely waits on the network. Resolves with how many messages came.
   */
  const fetching = useRef<Promise<number> | null>(null);
  const fetchOlder = useCallback((): Promise<number> => {
    if (fetching.current) return fetching.current;
    const c = getState().convo[threadId];
    const oldest = c?.byId[c.ids[0] ?? ''];
    if (!c?.hasMore || !oldest) return Promise.resolve(0);
    const run = (async () => {
      try {
        const page = await rpc('threads.history', { id: threadId, limit: PAGE, before: { id: oldest.id, createdAt: oldest.createdAt, role: oldest.role } });
        page.messages.forEach((m) => known.current?.add(m.id));
        // older than every row drawn: they wait to be drawn (anchored, by `showEarlier`). A window with room to spare
        // (a short chat, the last growth) would take them at once, above the reader and unanchored: it shrinks to
        // what is drawn first, in the same render
        const drawn = getState().convo[threadId]?.ids.length ?? 0;
        setLimit((l) => Math.min(l, drawn));
        mergeConversation(threadId, page.messages, { hasMore: page.hasMore });
        return page.messages.length;
      } catch (e) {
        // the connection dropping isn't worth a toast: scrolling up again once it's back asks again
        if (!connectionDropped(e)) pushToast({ title: 'Could not load earlier messages', body: e instanceof Error ? e.message : undefined, level: 'error' });
        return 0;
      } finally {
        fetching.current = null;
      }
    })();
    fetching.current = run;
    return run;
  }, [threadId]);

  /** a growth of the window asked for and not drawn yet (scroll events come faster than renders) */
  const growing = useRef(false);
  const limitRef = useRef(limit);
  limitRef.current = limit;
  /** the first row drawn, as of now: from the store, which may be ahead of the last render (a page just merged) */
  const startNow = () => Math.max(0, (getState().convo[threadId]?.ids.length ?? 0) - limitRef.current);
  /**
   * Older rows: first those loaded but not drawn yet, then the computer's next page (waited for only when nothing
   * loaded is left: the spinner); what you read stays put. Each growth also asks for the page after the rows still
   * undrawn, so it is in memory before the reader gets there.
   */
  const showEarlier = useCallback(async () => {
    const el = scroller.current;
    if (!el || growing.current) return;
    growing.current = true;
    try {
      const waited = startNow() <= 0;
      if (waited) {
        setPaging(true);
        const n = await fetchOlder();
        if (!n || !scroller.current) { setPaging(false); growing.current = false; return; }
      }
      const from = startNow();
      const first = getState().convo[threadId]?.ids[from];
      const pos = first ? rowPos(first) : null;
      anchor.current = first && pos !== null ? { firstId: first, pos } : null;
      // the spinner goes in the same render as the rows it waited for, so nothing shifts twice
      setLimit((l) => l + GROW);
      if (waited) setPaging(false);
      if (from - GROW < PAGE) void fetchOlder();
      // (drawn, it is cleared at once below; this only stops a growth that drew nothing from blocking the next)
      setTimeout(() => { growing.current = false; }, 500);
    } catch {
      growing.current = false;
    }
  }, [threadId, fetchOlder]);

  /** Near the top with older rows to come: bring them in (from scrolling, the observer, and after each growth). */
  const nearTop = useCallback(() => {
    const el = scroller.current;
    if (!el || growing.current || !getState().convo[threadId]?.loaded) return;
    if (el.scrollTop > PRELOAD_PX) return;
    if (startNow() <= 0 && !getState().convo[threadId]?.hasMore) return;
    void showEarlier();
  }, [threadId, showEarlier]);

  // scrolling near the top (or a short history that doesn't fill the view) brings in older messages
  const top = useRef<HTMLDivElement>(null);
  const [topInView, setTopInView] = useState(false);
  useEffect(() => {
    const el = top.current;
    const root = scroller.current;
    if (!el || !root) return;
    const io = new IntersectionObserver(([e]) => setTopInView(!!e?.isIntersecting), { root, rootMargin: `${PRELOAD_PX}px 0px 0px 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  // ⌘F (ThreadSearch): every loaded message is drawn so it can be found, and jumping to a match stops following the end
  useEffect(() => {
    const onFind = (e: Event) => {
      const d = (e as CustomEvent<FindRequest>).detail;
      if (d.threadId !== threadId) return;
      if (d.all) setLimit((l) => Math.max(l, getState().convo[threadId]?.ids.length ?? l));
      if (d.detach) detach();
    };
    window.addEventListener(FIND_EVENT, onFind);
    return () => window.removeEventListener(FIND_EVENT, onFind);
  }, [threadId, detach]);

  // a growth has been drawn (and anchored): the next one may go; still near the top (a short history, a reader
  // waiting there), it follows at once. The observer's word only counts with the position checked (`nearTop`): it
  // reports a frame late, and as an edge only, so the scroll handler checks too.
  useLayoutEffect(() => { growing.current = false; }, [limit]);
  useEffect(() => {
    if (topInView && loaded && mayHaveOlder && !paging) nearTop();
  }, [topInView, loaded, mayHaveOlder, paging, limit, nearTop]);

  // the edge fades: over the chat's own flat colour they are two gradients laid on top (cheap); only the Messages
  // theme, with its wallpaper behind the rows, masks the scroller itself, which made every scroll frame composite a
  // masked layer (~15% more main-thread time scrolling a long chat: bench/scroll.mjs)
  const wallpaper = useMessagesTheme();
  const mask = wallpaper ? `linear-gradient(to bottom, ${edges.top ? 'transparent 0, black 10px' : 'black 0'}, ${edges.bottom ? 'black calc(100% - 18px), transparent 100%' : 'black 100%'})` : undefined;
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        data-transcript={threadId}
        onScroll={onScroll}
        onWheel={(e) => { if (!e.ctrlKey && e.deltaY !== 0) onScrollGesture(e.deltaY < 0); }}
        onPointerDown={detach}
        onPointerUp={release}
        onPointerCancel={release}
        onTouchStart={detach}
        onTouchMove={detach}
        onTouchEnd={release}
        // Synara's list: the 20px gutter and the scrollbar's own 10px track sit outside the 46rem column
        className="h-full overflow-x-hidden overflow-y-auto px-5 [overflow-anchor:none] [scrollbar-gutter:stable]"
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      >
        <div ref={content} className="mx-auto flex w-full max-w-[46rem] flex-col pt-4">
          {loading ? <div className="flex justify-center py-10 text-muted"><Spinner size={18} /></div> : null}
          <div ref={top} aria-hidden className="h-px shrink-0" />
          {paging ? <div className="flex justify-center pb-3 text-muted"><Spinner size={14} /></div> : null}
          {items.map((item) => (item.kind === 'message' ? (
            <Row key={item.key} threadId={threadId} id={item.id} botName={botName} cwd={cwd} separator={separators[item.index] ?? null} animate={!!known.current && !known.current.has(item.id) && !known.current.has(rowKeyOf(item.id))} />
          ) : (
            <div key={item.key} data-message-id={item.ids[0]}>
              {separators[item.index] ? <Separator label={separators[item.index]!} /> : null}
              <RoutineFoldLine fold={item}>
                {() => item.ids.map((id) => <Row key={rowKeyOf(id)} threadId={threadId} id={id} botName={botName} cwd={cwd} separator={null} animate={false} />)}
              </RoutineFoldLine>
            </div>
          )))}
          {/* 8px under the last bubble: a turn leaves 14px under itself (`pb-3.5`), so the row is pulled up into it */}
          {footer ? <div className="-mt-1.5 px-1">{footer}</div> : null}
          {/* room under the last turn: Synara's resting gap (its list's bottom inset less the 20px the transcript
              tucks under the floating composer) */}
          <div aria-hidden className="h-11 shrink-0" />
        </div>
      </div>
      {wallpaper ? null : (
        <>
          <div aria-hidden className={cn('pointer-events-none absolute inset-x-0 top-0 h-2.5 bg-gradient-to-b from-[var(--ab-content)] to-transparent', !edges.top && 'opacity-0')} />
          <div aria-hidden className={cn('pointer-events-none absolute inset-x-0 bottom-0 h-[18px] bg-gradient-to-t from-[var(--ab-content)] to-transparent', !edges.bottom && 'opacity-0')} />
        </>
      )}
      <div
        className={cn(
          // Synara floats the arrow 8px above the composer's top edge (plus the wrapper's own 4px), centred on the
          // column (the scrollbar's 10px track sits to its right)
          'pointer-events-none absolute inset-x-0 bottom-2 z-30 flex justify-center py-1 pr-2.5 transition-[opacity,translate] duration-[220ms] ease-out motion-reduce:transition-none',
          showJump ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0',
        )}
      >
        <button
          type="button"
          onClick={onJump}
          aria-label="Scroll to bottom"
          aria-hidden={!showJump}
          tabIndex={showJump ? 0 : -1}
          className={cn(
            'chat-round ab-pill squircle flex size-8 items-center justify-center rounded-control border border-border bg-popover text-fg backdrop-blur-md',
            // the hover tint layers over the fill instead of replacing it, so the transcript never reads through
            'hover:bg-[image:linear-gradient(var(--ab-surface-2),var(--ab-surface-2))]',
            showJump ? 'pointer-events-auto' : 'pointer-events-none',
          )}
        >
          <Icon icon={ArrowDown} size={14} className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
