import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { WATCHING_KEEPS_AWAKE, controlNote, controlPill, computerDisplayName } from '@appubot/chat-core';
import { Eye, Hand, RotateCw, X } from '../../components/ui/icons';
import { Button, Icon, Spinner, Tooltip } from '../../components/ui';
import { cn } from '../../components/ui/cn';
import { useNow } from '../../lib/hooks';
import { useCloud } from './cloudAccount';
import { cloudClientIfAny } from './cloudClient';
import {
  giveBack, keepControl, noteInput, placeSurface, refitScreen, releaseScreen, retryScreen, screenCanvas, takeControl, useCloudDesktop, useScreen, wantScreen,
} from './screenSession';
import { VIEWER_FULL, VIEWER_HEADER_H, VIEWER_MARGIN, VIEWER_PILL_H, fitScreen, fullRoom } from './screenView';

/*
 * Open desktop (plan §4.4): your AppuBot computer's screen (a bot's own, where bots have one; or a team's computer's)
 * filling the app window, on one dark surface: only ✕ at the top right (the traffic lights' row stays clear, so the
 * window still drags by its top), the screen centred as large as it fits in its own shape (`fitScreen`: a box of the
 * screen's shape that noVNC's canvas fills, rounded, so no letterbox shows), and right under it, centred, the Watching /
 * Take control pill (chat-core `controlPill`: "👁 Watching" + a white "Take control"; "You’re in control" + Give back,
 * counting down with Keep control near the end of the two idle minutes). Nothing else: the quality follows the link
 * by itself and a dropped connection comes back by itself ("Reconnecting…" over the last picture). The connection is
 * the shared screen session (`screenSession.ts`), which the side panel's Computer tab previews: expanding the preview
 * opens this with the picture already live. Watching keeps the computer awake while it's open (the title's tooltip
 * says so). Esc closes it, except while you're in control (the key is the computer's then; ✕ still closes).
 * Teach mode (`teach`) takes control as soon as the screen is up, and what the user does is mirrored to the
 * computer's gateway (`teach.input`), which is how the bot learns the steps.
 * A bot's screen is reached from that bot (its Computer tab, its chat's Watch), so the viewer shows that one screen
 * and nothing to switch; Take control is that screen's alone.
 */

export { useCloudDesktop } from './screenSession';

/**
 * `team`: a team's shared computer (absent: the person's own); `screen`: a bot's own screen there (its id; absent: the
 * computer's own, where bots have none); `teach`: mirror the input to its teach session;
 * `signIn`: an agent's sign-in runs on its screen (the agent's name): control is taken at once, so its terminal or
 * browser takes your keys straight away; `from`: the preview it grows out of
 */
export function openCloudDesktop(team?: string, o: { screen?: string; teach?: boolean; signIn?: string; from?: DOMRect } = {}): void {
  useCloudDesktop.setState({ open: true, team, screen: o.screen, teach: !!o.teach, signIn: o.signIn, from: o.from });
}
export function closeCloudDesktop(): void { useCloudDesktop.setState({ open: false, screen: undefined, teach: false, signIn: undefined }); }

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
  const from = useCloudDesktop((s) => s.from);
  const reduce = useReducedMotion();
  const title = useScreenTitle(team);

  // the full viewer wants the screen while it's open (closing it lets the preview, if any, carry on paced)
  useEffect(() => {
    if (!open) return;
    wantScreen('viewer', { full: true, team, screen, takeControl: teach || !!signIn });
    return () => releaseScreen('viewer');
  }, [open, team, screen, teach, signIn]);

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
          {/* the whole window: one dark surface edge to edge, no card around it */}
          <div className="no-drag relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#161616] text-white">
            <Viewer teach={teach} signIn={signIn} />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function Viewer({ teach, signIn }: { teach: boolean; signIn?: string }) {
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

  // Esc closes it, unless you're in control: then the key is the computer's (noVNC takes it on its canvas; ✕ still works)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || useScreen.getState().mine) return;
      e.preventDefault();
      e.stopPropagation();
      close();
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
  // the room for the screen and the pill (inside the edges), measured as it changes: window resizes, full screen;
  // the screen's box follows it and the screen's own size (`fb`), and noVNC refits to the box
  const roomRef = useRef<HTMLDivElement | null>(null);
  const side = VIEWER_FULL.side;
  const foot = VIEWER_FULL.bottom;
  // first guess: the window less the top row and the edges (measured before the first paint anyway), so the picture lands at its size
  const [room, setRoom] = useState(() => fullRoom({ w: window.innerWidth, h: window.innerHeight }));
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
      {/* the top: the traffic lights' row, which drags the window, and only ✕ at the right (left of Windows' and
          Linux's window buttons) */}
      <header className="drag relative flex shrink-0 items-center justify-end pr-[calc(8px+var(--wco-right))]" style={{ height: VIEWER_HEADER_H }}>
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
