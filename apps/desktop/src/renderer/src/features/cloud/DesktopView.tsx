import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { WATCHING_KEEPS_AWAKE, controlNote, controlPill, computerDisplayName } from '@appubot/chat-core';
import { Eye, Hand, Maximize2, Minimize2, RotateCw, X } from '../../components/ui/icons';
import { Button, Icon, Spinner, Tooltip } from '../../components/ui';
import { cn } from '../../components/ui/cn';
import { useNow } from '../../lib/hooks';
import { useStore } from '../../lib/store';
import { useCloud } from './cloudAccount';
import { cloudClientIfAny } from './cloudClient';
import {
  giveBack, keepControl, noteInput, placeSurface, refitScreen, releaseScreen, retryScreen, screenCanvas, takeControl, useCloudDesktop, useScreen, wantScreen,
} from './screenSession';
import { VIEWER_FULL, VIEWER_HEADER_H, VIEWER_MARGIN, VIEWER_PILL_H, botScreenLine, fitScreen, popupSize } from './screenView';

/*
 * Open desktop (plan §4.4): your AppuBot computer's own screen (or a team's) in a dark panel centred in the app window,
 * a margin of the dimmed app around it (the traffic lights' row stays clear, so the window still drags by its top), after
 * the reference's computer view: the computer's name and ✕ at the panel's top, the screen centred as large as it fits in its
 * own shape (`fitScreen`: a box of the screen's shape that noVNC's canvas fills, rounded, on the panel's own
 * background, so no letterbox shows), and right under it, centred, the Watching /
 * Take control pill (chat-core `controlPill`: "👁 Watching" + a white "Take control"; "You’re in control" + Give back,
 * counting down with Keep control near the end of the two idle minutes). Nothing else: the quality follows the link
 * by itself and a dropped connection comes back by itself ("Reconnecting…" over the last picture). The connection is
 * the shared screen session (`screenSession.ts`), which the side panel's Computer tab previews: expanding the preview
 * opens this with the picture already live. Watching keeps the computer awake while it's open (the title's tooltip
 * says so). Esc closes it, except while you're in control (the key is the computer's then; ✕ still closes).
 * Teach mode (`teach`) takes control as soon as the screen is up, and what the user does is mirrored to the
 * computer's gateway (`teach.input`), which is how the bot learns the steps.
 * Where bots have screens of their own (the computer's status lists `screens`), the top row switches between the
 * computer's main screen and each bot's (`ScreenSwitcher`); Take control is that screen's alone.
 */

export { useCloudDesktop } from './screenSession';

/**
 * `team`: a team's shared computer (absent: the person's own); `screen`: a bot's own screen there (its id; absent: the
 * main one); `control`: take control as soon as it's up (a bot's Computer tab's Take control); `teach`: mirror the
 * input to its teach session;
 * `signIn`: an agent's sign-in runs on its screen (the agent's name): control is taken at once, so its terminal or
 * browser takes your keys straight away; `from`: the preview it grows out of
 */
export function openCloudDesktop(team?: string, o: { screen?: string; control?: boolean; teach?: boolean; signIn?: string; from?: DOMRect } = {}): void {
  useCloudDesktop.setState({ open: true, team, screen: o.screen, takeOver: !!o.control, teach: !!o.teach, signIn: o.signIn, from: o.from });
}
export function closeCloudDesktop(): void { useCloudDesktop.setState({ open: false, screen: undefined, takeOver: false, teach: false, signIn: undefined }); }

/** what the viewer mirrors to a teach session on the computer: a click, a key, a wheel turn, at 0..1 of the screen */
export type ViewerInput =
  | { kind: 'click'; x: number; y: number; button: 'left' | 'right'; count: number }
  | { kind: 'key'; key: string; modifiers: string[] }
  | { kind: 'type'; text: string }
  | { kind: 'scroll'; x: number; y: number; dx: number; dy: number };

/** dev: `?desktop=1` opens the viewer, `?desktop=teach` in teach mode (the browser mock: no desktop answers, so it shows its waking and reconnecting states) */
const PREVIEW = import.meta.env.DEV && typeof location !== 'undefined' ? new URLSearchParams(location.search).get('desktop') : null;

/**
 * The screen session's picture, in this place while it's the best one up (the full viewer's wins over the preview's).
 * `active: false` gives it up while still drawn (the full viewer fading out: the preview has it back at once).
 */
export function ScreenSurface({ slot, className, active = true }: { slot: 'preview' | 'full'; className?: string; active?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    placeSurface(slot, ref.current);
    return () => placeSurface(slot, null);
  }, [slot, active]);
  return <div ref={ref} className={cn('relative', className)} />;
}

/** The computer's name: "Sarthak’s Cloud Computer", or the team's "Acme Cloud Computer". */
export function useScreenTitle(team: string | undefined): string {
  return useCloud((s) => {
    const t = team ? s.view?.teams?.find((x) => x.team.id === team) : undefined;
    return t ? computerDisplayName({ team: t.team.name }) : computerDisplayName({ person: s.view?.account?.name });
  });
}

export function DesktopView() {
  const open = useCloudDesktop((s) => s.open);
  useEffect(() => { if (PREVIEW) openCloudDesktop(undefined, { teach: PREVIEW === 'teach' }); }, []);
  const team = useCloudDesktop((s) => s.team);
  const screen = useCloudDesktop((s) => s.screen);
  const teach = useCloudDesktop((s) => s.teach);
  const signIn = useCloudDesktop((s) => s.signIn);
  const takeOver = useCloudDesktop((s) => s.takeOver);
  const from = useCloudDesktop((s) => s.from);
  const reduce = useReducedMotion();
  const title = useScreenTitle(team);

  // the full viewer wants the screen while it's open (closing it lets the preview, if any, carry on paced)
  useEffect(() => {
    if (!open) return;
    wantScreen('viewer', { full: true, team, screen, takeControl: teach || !!signIn || takeOver });
    return () => releaseScreen('viewer');
  }, [open, team, screen, teach, signIn, takeOver]);

  // a popup centred over the dimmed app, or the whole window at full size (the title row's button; it opens small)
  const [full, setFull] = useState(false);
  useEffect(() => { if (!open) setFull(false); }, [open]);
  const fb = useScreen((s) => s.fb);
  const [win, setWin] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setWin({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const popup = popupSize(win, fb);

  // grows out of the preview it was opened from: a clip opening from the preview's place, never a transform (noVNC
  // measures its place with getBoundingClientRect, which a scale would shrink, and keeps the canvas that small)
  const reveal = !reduce && from
    ? `inset(${Math.max(0, from.top)}px ${Math.max(0, window.innerWidth - from.right)}px ${Math.max(0, window.innerHeight - from.bottom)}px ${Math.max(0, from.left)}px round 16px)`
    : null;

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="desktop"
          role="dialog"
          aria-modal="true"
          aria-label={teach ? `Show it on ${title === 'Your AppuBot computer' ? 'your AppuBot computer' : title}` : title}
          initial={reveal ? { opacity: 0.6, clipPath: reveal } : { opacity: 0 }}
          animate={reveal ? { opacity: 1, clipPath: 'inset(0px 0px 0px 0px round 0px)' } : { opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0.12 : 0.28, ease: [0.25, 1, 0.5, 1] }}
          className="fixed inset-0 z-[70] flex items-center justify-center"
        >
          {/* the app around the popup, dimmed almost away so none of its controls read beside the popup's own: a press
              there closes it (not while you're in control); its top row still drags the window */}
          <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--ab-content)_88%,transparent)]" onMouseDown={() => { if (!useScreen.getState().mine) closeCloudDesktop(); }} />
          <div className="drag absolute inset-x-0 top-0" style={{ height: VIEWER_HEADER_H }} />
          {/* the popup, or at full size the whole window: one dark surface edge to edge, no card around it */}
          <div
            className={cn(
              'no-drag relative flex min-h-0 min-w-0 flex-col overflow-hidden text-white',
              full ? 'size-full bg-[#161616]' : 'squircle shrink-0 rounded-sheet bg-[#0a0a0a] shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_25px_50px_-12px_rgba(0,0,0,.6)]',
            )}
            style={full ? undefined : { width: popup.w, height: popup.h }}
          >
            <Viewer teach={teach} signIn={signIn} title={title} full={full} onFull={() => setFull((f) => !f)} />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function Viewer({ teach, signIn, title, full, onFull }: { teach: boolean; signIn?: string; title: string; full: boolean; onFull: () => void }) {
  // false while it fades out after closing: the picture goes back to the preview at once
  const open = useCloudDesktop((s) => s.open);
  const phase = useScreen((s) => s.phase);
  const why = useScreen((s) => s.why);
  const control = useScreen((s) => s.control);
  const mine = useScreen((s) => s.mine);
  const deadline = useScreen((s) => s.deadline);
  const fb = useScreen((s) => s.fb);
  const lastFrame = useScreen((s) => s.lastFrame);
  const now = useNow(mine ? 500 : 30_000);
  const close = () => closeCloudDesktop();

  // Esc closes the popup and collapses full size back to it, unless you're in control: then the key is the computer's
  // (noVNC takes it on its canvas; ✕ or the collapse button still work)
  const fullNow = useRef(full);
  fullNow.current = full;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || useScreen.getState().mine) return;
      e.preventDefault();
      e.stopPropagation();
      if (fullNow.current) onFull();
      else close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // teach mode: what the user does on the screen, mirrored to the computer's gateway (it records the steps)
  const mirror = (i: ViewerInput) => {
    const c = cloudClientIfAny();
    if (!c || c.state !== 'connected') return;
    void c.call('teach.input', i).catch(() => undefined);
  };
  const fraction = (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const r = screenCanvas()?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return null;
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  // the room for the screen and the pill (inside the margins), measured as it changes: window resizes, full screen,
  // the side panel; the screen's box follows it and the screen's own size (`fb`), and noVNC refits to the box
  const roomRef = useRef<HTMLDivElement | null>(null);
  // the edges around the screen and the pill: the popup's margin, or full size's wider sides and its foot
  const side = full ? VIEWER_FULL.side : VIEWER_MARGIN;
  const foot = full ? VIEWER_FULL.bottom : VIEWER_MARGIN;
  // first guess: the popup less its top row and margins (measured before the first paint anyway), so the picture lands at its size
  const [room, setRoom] = useState(() => {
    const p = popupSize({ w: window.innerWidth, h: window.innerHeight }, useScreen.getState().fb);
    return { w: p.w - 2 * VIEWER_MARGIN, h: p.h - VIEWER_HEADER_H - VIEWER_MARGIN };
  });
  useLayoutEffect(() => {
    const el = roomRef.current;
    if (!el) return;
    const read = () => {
      const w = el.clientWidth - 2 * side;
      const h = el.clientHeight - foot;
      setRoom((r) => (r.w === w && r.h === h ? r : { w, h }));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [side, foot]);
  const box = fitScreen(room, fb);
  // noVNC would refit a frame later on its own: fit it before this paints
  useLayoutEffect(() => { refitScreen(); }, [box.w, box.h]);

  const recording = teach && mine;
  // (capture: noVNC stops the events on its canvas)
  const onPointerDown = (e: React.PointerEvent) => {
    noteInput();
    if (!recording) return;
    const p = fraction(e);
    if (p && (e.button === 0 || e.button === 2)) mirror({ kind: 'click', ...p, button: e.button === 2 ? 'right' : 'left', count: Math.min(3, Math.max(1, e.detail || 1)) });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    noteInput();
    if (!recording) return;
    const modifiers = [e.metaKey ? 'cmd' : '', e.ctrlKey ? 'ctrl' : '', e.altKey ? 'alt' : '', e.shiftKey ? 'shift' : ''].filter(Boolean);
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) mirror({ kind: 'type', text: e.key });
    else mirror({ kind: 'key', key: e.key.toLowerCase(), modifiers });
  };
  const onWheel = (e: React.WheelEvent) => {
    noteInput();
    if (!recording) return;
    const p = fraction(e);
    if (p) mirror({ kind: 'scroll', ...p, dx: e.deltaX, dy: e.deltaY });
  };

  const live = phase === 'connected';
  const pill = controlPill({ control, mine, canControl: live, deadline, now });
  const onPill = () => {
    const kind = pill.action?.kind;
    if (kind === 'take') takeControl();
    else if (kind === 'keep') keepControl();
    else if (kind === 'give') giveBack();
  };
  const busy = phase === 'idle' || phase === 'linking' || phase === 'connecting' || phase === 'waking';
  const note = [
    controlNote(pill) ?? (live ? 'Take control to sign in somewhere or solve a check for a bot; your bots wait meanwhile.' : undefined),
    teach
      ? 'Take control and do the task once; the bot watches and writes the skill when you stop.'
      : signIn
        ? `Finish signing in to ${signIn} here: it waits for you on the screen (press Enter in its window, or sign in in the browser it opens). Give control back when you’re done.`
        : `${WATCHING_KEEPS_AWAKE} while this is open; it sleeps again once you leave.`,
  ].filter(Boolean).join(' ');

  return (
    <>
      {full ? (
        // full size's top: the traffic lights' row, which drags the window; the screens where bots have their own in
        // its middle, and only the collapse button at the right (left of Windows' and Linux's window buttons)
        <header className="drag relative flex shrink-0 items-center justify-end pr-[calc(8px+var(--wco-right))]" style={{ height: VIEWER_HEADER_H }}>
          {!teach && !signIn ? (
            <div className="no-drag absolute top-1/2 left-1/2 flex max-w-[calc(100%-240px)] -translate-x-1/2 -translate-y-1/2 justify-center">
              <ScreenSwitcher />
            </div>
          ) : null}
          <Tooltip label="Smaller (Esc)">
            <button
              type="button"
              aria-label="Smaller"
              onClick={onFull}
              className="no-drag flex size-7 shrink-0 items-center justify-center rounded-full text-white/70 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              <Icon icon={Minimize2} size={14} />
            </button>
          </Tooltip>
        </header>
      ) : (
        <header className="flex shrink-0 items-center gap-1.5 pr-2 pl-4" style={{ height: VIEWER_HEADER_H }}>
          {/* the popup's top: the computer's name, the screens where bots have their own, full size and ✕ */}
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="min-w-0 shrink truncate text-note text-white/60">{title}</span>
            {!teach && !signIn ? <ScreenSwitcher /> : null}
          </div>
          <Tooltip label="Full size">
            <button
              type="button"
              aria-label="Full size"
              onClick={onFull}
              className="flex size-7 shrink-0 items-center justify-center rounded-full text-white/70 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              <Icon icon={Maximize2} size={14} />
            </button>
          </Tooltip>
          <Tooltip label="Close (Esc)">
            <button
              type="button"
              aria-label="Close"
              onClick={close}
              className="no-drag flex size-7 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-white/80 hover:bg-white/[0.14] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              <Icon icon={X} size={15} />
            </button>
          </Tooltip>
        </header>
      )}

      {/* the screen and, right under it, the pill: one group centred in the room, an edge around it */}
      <div
        ref={roomRef}
        className="flex min-h-0 flex-1 flex-col items-center justify-center"
        style={{ padding: `0 ${side}px ${foot}px` }}
        onPointerMoveCapture={() => noteInput()}
        onPointerDownCapture={onPointerDown}
        onKeyDownCapture={onKeyDown}
        onWheelCapture={onWheel}
      >
        <div
          className={cn(
            'relative shrink-0 overflow-hidden rounded-[10px] shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_16px_48px_rgba(0,0,0,0.5)]',
            !live && !lastFrame && 'bg-white/[0.04]',
          )}
          style={{ width: box.w, height: box.h }}
        >
          <ScreenSurface slot="full" active={open} className="absolute inset-0" />
          {phase === 'reconnecting' ? (
            <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
              <span className="ab-pill squircle flex items-center gap-2 rounded-control border border-white/10 bg-black/70 px-3 py-1.5 text-note text-white/80 backdrop-blur" role="status">
                <Spinner size={12} /> Reconnecting…
              </span>
            </div>
          ) : null}
          {!live && phase !== 'reconnecting' ? (
            <div className={cn('absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-copy text-white/70', lastFrame && 'bg-black/55')} role="status">
              {busy ? <Spinner size={18} /> : null}
              <span className="max-w-[420px]">
                {phase === 'waking' ? 'Waking up…'
                  : busy ? 'Connecting…'
                    : phase === 'paused' ? 'Paused after a while without you, so it can sleep.'
                      : why || 'Its screen didn’t open.'}
              </span>
              {!busy ? <Button size="sm" variant="secondary" icon={RotateCw} onClick={retryScreen}>{phase === 'paused' ? 'Keep watching' : 'Try again'}</Button> : null}
            </div>
          ) : null}
        </div>

        {/* Watching / Take control; its height is kept while it's away */}
        <div className="flex shrink-0 items-center justify-center" style={{ height: VIEWER_PILL_H, marginTop: VIEWER_MARGIN }}>
          {live || phase === 'reconnecting' ? (
            <div
              role="group"
              aria-label="Watching or in control"
              title={note}
              className="ab-pill squircle flex h-10 max-w-full items-center gap-1 rounded-pop border border-white/[0.08] bg-[#1f1f1f] py-1 pr-1 pl-3.5 shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
            >
              <span className={cn('flex min-w-0 items-center gap-2 pr-2 text-copy', pill.mode === 'mine' ? 'text-white' : 'text-white/55')}>
                <Icon icon={pill.mode === 'mine' ? Hand : Eye} size={16} className="shrink-0" />
                <span className="truncate tabular-nums">{pill.label}</span>
              </span>
              {pill.action ? (
                <button
                  type="button"
                  disabled={pill.action.disabled || !live}
                  onClick={onPill}
                  className="ab-pill squircle h-8 shrink-0 rounded-control bg-[#f4f4f4] px-3.5 text-copy font-medium text-[#111] hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:bg-white/10 disabled:text-white/40"
                >
                  {pill.action.label}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

/**
 * Every bot's own screen and the computer's main one, side by side at the top of the viewer: one chip each (the bot's
 * colour, a dot while it works), the one on show filled; a sleeping one starts when picked. Only where bots have
 * screens of their own; a bot's Computer tab opens the viewer on its screen, so this is the way to the others.
 */
function ScreenSwitcher() {
  const screens = useStore((s) => s.computer?.screens);
  const bots = useStore((s) => s.bots);
  const current = useCloudDesktop((s) => s.screen);
  if (!screens) return null;
  const chips = [
    { id: undefined as string | undefined, name: 'Computer', color: undefined as string | undefined, line: 'The computer’s main screen', busy: false },
    ...bots.filter((b) => b.computerUse || screens.some((x) => x.botId === b.id)).map((bot) => {
      const x = screens.find((y) => y.botId === bot.id);
      return { id: bot.id as string | undefined, name: bot.name, color: bot.color as string | undefined, line: botScreenLine(x), busy: !!x && (x.busy || !!x.activeThreadId) };
    }),
  ];
  return (
    <nav aria-label="Screens" className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {chips.map((c) => {
        const on = c.id === current;
        return (
          <Tooltip key={c.id ?? 'main'} label={c.line}>
            <button
              type="button"
              aria-pressed={on}
              onClick={() => useCloudDesktop.setState({ screen: c.id, takeOver: false })}
              className={cn(
                'ab-pill squircle flex h-7 shrink-0 items-center gap-1.5 rounded-control-sm px-2.5 text-note transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40',
                on ? 'bg-white/[0.16] text-white' : 'text-white/60 hover:bg-white/[0.08] hover:text-white/90',
              )}
            >
              {c.color ? <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: c.color }} /> : null}
              <span className="max-w-[140px] truncate">{c.name}</span>
              {c.busy ? <span className="sr-only">(working)</span> : null}
              {c.busy ? <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-[#4ade80]" /> : null}
            </button>
          </Tooltip>
        );
      })}
    </nav>
  );
}
