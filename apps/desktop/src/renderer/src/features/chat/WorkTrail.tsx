// The work trail (Settings › Appearance › Chat shows: Everything): a turn's processing as a quiet trail above its
// reply, never as chat bubbles. One status line carries the turn ("Working for 12s" shimmering, then "Worked for 1m 3s"),
// the work it has already written past folds behind it, the run it is on now stays open as a short window pinned to
// its newest step, and once the turn is done the whole trail folds away, one click from opening again. Each run of
// work is one line that adds it up ("Read 2 files · Ran a command · Edited report.md"), its steps one dim line each on
// a thin rail. The rules are chat-core's (workTrail.ts); the reply under it is the answers view's, untouched.
//
// Ported from MonoCode (https://github.com/hardbeat920/monocode, MIT, Copyright (c) 2026 Nick):
// src/features/sessions/ui/AgentTranscript.tsx (`WorkFoldLine`, `TurnRow`, `ActivityPhases` and `sameActivity`,
// `ActivityPhaseGroup`, `useLivePhaseScroll`, `markScrollEdges`, `useStepQueue`, `PhaseStep`, `ActivityPhaseIcon`,
// `ActivityRow`, `ActivityThinkingRow`, `ActivityNoteRow`, `ActivityToolRow`, `ToolCallSummary`, `ToolCallStatusIcon`,
// `InitialThinking`, `LiveFoldTitle`) and src/features/sessions/model/transcriptActivity.ts (`nestedScrollAbsorbsWheel`).
//
// Changed for AppuBot: the status line wears the bot's own avatar (MonoCode: the agent's logo) and says "Waiting for
// you" while an approval waits (they stay docked above the composer); a run's header counts its failures in red; any
// row with something to show opens onto it (a command's output, a diff, the screen after a computer step: the chat's
// own ToolDetails), not only a failed one, and a failure's explaining line shows under its row unopened; edits open
// their diff inline rather than in a hover popover; there are no subagent rows or background tasks; the tab-visibility
// context is left out (AppuBot keeps one transcript); Reduce motion turns every move off (workTrail.css).
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Message } from '@appubot/protocol';
import {
  activityStillRunning, editedFiles, failedCount, failureInfo, foldableWork, formatTurnHeaderLabel, hasMoreThanSummary,
  initialThinkingIndex, needsApproval, proseSummary, toolMeta, toolState, trailItems, trailSentence, turnHeader, workKind,
  workSummaryLine, type ToolCallPart, type TrailItem, type TrailOptions, type TrailStep, type WorkGroupKind,
} from '@appubot/chat-core';
import { BotAvatar, Icon, cn } from '../../components/ui';
import {
  Bot, ChevronRight, ComputerUse, File, GlobeSimple, Hammer, MessageSquare, Minus, PenLine, Plug, Search, Send, SquareTerminal, Brain, X,
  type IconComponent,
} from '../../components/ui/icons';
import { syncAnimationsToTimelineOrigin } from '../../lib/animationTimelineSync';
import { useStore } from '../../lib/store';
import { DisclosureRegion } from './Disclosure';
import { LiveElapsed } from './LiveTimer';
import { ChatMarkdown } from './Markdown';
import { PlanChecklist } from './Notices';
import { DiffStat, ToolDetails, hasToolDetails } from './ToolDetails';
import './workTrail.css';

/*
 * Calls often land in a burst. Each arrival waits for the one before it to finish its whole entrance (rail, branch,
 * row) before starting its own. The first few play at STEP_ENTRANCE_MS; a queue running past STEP_QUEUE_CALM_MS plays
 * the rest faster, down to STEP_ENTRANCE_MIN_MS by STEP_QUEUE_MS, so a long burst still catches up (MonoCode's numbers).
 */
const STEP_ENTRANCE_MS = 480;
const STEP_ENTRANCE_MIN_MS = 160;
const STEP_QUEUE_CALM_MS = 960;
const STEP_QUEUE_MS = 2000;
/** A fold that hasn't fired animationend by now (a hidden window, Reduce motion) settles anyway. */
const FOLD_SETTLE_MS = 350;

const KIND_ICON: Record<WorkGroupKind, IconComponent | null> = {
  edit: PenLine, research: Search, run: SquareTerminal, computer: ComputerUse, apps: Plug, web: GlobeSimple, agent: Bot,
  ask: MessageSquare, send: Send, memory: Brain, other: Hammer, think: null,
};

/** What a run was for, at a glance: look, change, run, use. A run of thinking has none (MonoCode's `ActivityPhaseIcon`). */
function KindIcon({ kind, className }: { kind: WorkGroupKind; className?: string }) {
  const icon = KIND_ICON[kind];
  if (!icon) return null;
  return <Icon icon={icon} size={14} className={cn('wt-icon size-3.5 shrink-0', className)} />;
}

function Chevron({ open, className }: { open?: boolean; className?: string }) {
  return <Icon icon={ChevronRight} size={14} className={cn('wt-icon size-3.5 shrink-0 transition-transform duration-200 motion-reduce:transition-none', open && 'rotate-90', className)} />;
}

/* ---------- the fold ---------- */

type FoldState = 'open' | 'opening' | 'closing' | 'closed';

/**
 * Animate one fold, then release its contents: closed work keeps no component or DOM tree for every step, only
 * opening builds those rows (MonoCode's `TurnRow`). `startOpen`: it mounts open and folds shut at once (a turn that
 * just ended, whose live work is putting itself away).
 */
function FoldRegion({ folded, startOpen = false, children }: { folded: boolean; startOpen?: boolean; children: () => ReactNode }) {
  const [state, setState] = useState<FoldState>(folded && !startOpen ? 'closed' : 'open');
  useLayoutEffect(() => {
    setState((current) => {
      if (folded) return current === 'closed' ? current : 'closing';
      return current === 'open' ? current : 'opening';
    });
  }, [folded]);
  useEffect(() => {
    if (state !== 'opening' && state !== 'closing') return;
    const t = window.setTimeout(() => setState(folded ? 'closed' : 'open'), FOLD_SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [state, folded]);
  if (folded && state === 'closed') return null;
  return (
    // `inert` keeps folded work out of the tab order and away from screen readers
    <div
      className="wt-fold-item"
      data-fold-state={state}
      inert={folded}
      onAnimationEnd={(e) => { if (e.target === e.currentTarget) setState(folded ? 'closed' : 'open'); }}
    >
      {/* padding stays off the grid item itself, or it survives a 0fr track and every folded trail leaves a gap */}
      <div><div className="pb-1">{children()}</div></div>
    </div>
  );
}

/* ---------- the status line ---------- */

const STATUS_ROW = 'group flex w-full min-w-0 items-center gap-1.5 py-1 text-left';

/**
 * The line a turn's work folds behind (MonoCode's `WorkFoldLine`): the bot, and the clock, ticking while it works,
 * how long it took once it is done. Hovered, an avatar it can open turns into the chevron; open, the chevron stays.
 */
function StatusLine({ msg, live, waiting, endAt, expandable, open, drop, onToggle, botId }: {
  msg: Message; live: boolean; waiting: boolean; endAt: number; expandable: boolean; open: boolean;
  /** the fold opens right under the line: a rail drops out of the chevron into it */
  drop: boolean;
  onToggle: () => void; botId?: string;
}) {
  const bot = useStore((s) => (botId ? s.bots.find((b) => b.id === botId) : undefined));
  const icon = (
    <span className="relative flex size-4 shrink-0 items-center justify-center">
      {open ? <Chevron open /> : (
        <>
          <span className={cn('flex', expandable && 'group-hover:opacity-0')}>
            <BotAvatar bot={bot} size={16} mood={live ? (waiting ? 'needs-you' : 'working') : undefined} still={!live} />
          </span>
          {expandable ? <Chevron className="absolute opacity-0 group-hover:opacity-100" /> : null}
        </>
      )}
    </span>
  );
  // while the bot works the clock shimmers; settled, the line sits with the icons and brightens on hover
  const label = live ? (
    <span ref={syncAnimationsToTimelineOrigin} className="shimmer min-w-0 truncate text-copy text-muted" role="status" aria-live="polite">
      {waiting ? 'Waiting for you' : <>Working for <span className="tabular-nums"><LiveElapsed since={msg.createdAt} /></span></>}
    </span>
  ) : (
    <span className="wt-dim wt-hover-up min-w-0 flex-1 truncate text-copy">{formatTurnHeaderLabel(turnHeader(msg, endAt))}</span>
  );
  const row = cn(STATUS_ROW, open && drop && 'wt-fold-drop');
  if (!expandable) return <div className={row}>{icon}{label}</div>;
  return (
    <button type="button" aria-expanded={open} aria-label={open ? 'Hide the work' : 'Show the work'} onClick={onToggle} className={row}>
      {icon}{label}
    </button>
  );
}

/* ---------- the live window ---------- */

/** True when a nested scroller should take this wheel rather than the chat (MonoCode's `nestedScrollAbsorbsWheel`). */
function absorbsWheel(el: HTMLElement, deltaY: number): boolean {
  if (el.scrollHeight <= el.clientHeight + 1) return false;
  const atTop = el.scrollTop <= 0;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
  return (deltaY < 0 && !atTop) || (deltaY > 0 && !atBottom);
}

/** Flags the edges with more to scroll to, so only those fade. */
function markScrollEdges(el: HTMLElement) {
  el.dataset.fadeTop = String(el.scrollTop > 1);
  el.dataset.fadeBottom = String(el.scrollHeight - el.clientHeight - el.scrollTop > 1);
}

/**
 * Keep a live run's window on its newest step: pinned in layout, before paint, so it follows without a hitch; only a
 * real wheel up and away from the bottom pauses that, and scrolling back down to it picks it up again.
 */
function useLivePhaseScroll(el: HTMLDivElement | null, enabled: boolean, steps: unknown) {
  const stick = useRef(true);
  const lastTop = useRef(0);
  const wasEnabled = useRef(false);
  const follows = useCallback((node: HTMLElement) => {
    const nearBottom = node.scrollHeight - node.clientHeight - node.scrollTop <= 16;
    // a scroll that moved down to the bottom picks the window up again; anything else keeps what it was
    if (nearBottom && node.scrollTop >= lastTop.current) return true;
    return stick.current && nearBottom;
  }, []);
  const pin = useCallback(() => {
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
    markScrollEdges(el);
  }, [el]);
  useLayoutEffect(() => {
    if (!enabled) { wasEnabled.current = false; return; }
    if (!wasEnabled.current) { stick.current = true; wasEnabled.current = true; }
    pin();
  }, [enabled, pin, steps]);
  useEffect(() => {
    if (!el || !enabled) return;
    const onScroll = () => {
      stick.current = follows(el);
      lastTop.current = el.scrollTop;
      markScrollEdges(el);
    };
    const onWheel = (e: WheelEvent) => {
      if (!absorbsWheel(el, e.deltaY)) return;
      if (e.deltaY < 0) stick.current = false;
      e.stopPropagation();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    const inner = el.firstElementChild;
    const observer = new ResizeObserver(pin);
    if (inner) observer.observe(inner);
    pin();
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      observer.disconnect();
    };
  }, [el, enabled, pin, follows]);
}

/* ---------- steps arriving ---------- */

type StepTurn = { wait: number; pace: number };

/** A run's queue of arriving steps: how long each waits for the one before it, and how long its own entrance takes. */
function useStepQueue() {
  const queue = useRef({ next: 0, turns: new Map<number, StepTurn>() });
  return (id: number): StepTurn => {
    const { turns } = queue.current;
    let turn = turns.get(id);
    if (!turn) {
      const now = performance.now();
      const start = Math.max(now, queue.current.next);
      const wait = start - now;
      const backlog = (STEP_QUEUE_MS - wait) / (STEP_QUEUE_MS - STEP_QUEUE_CALM_MS);
      const pace = Math.max(STEP_ENTRANCE_MIN_MS, STEP_ENTRANCE_MS * Math.min(1, backlog));
      queue.current.next = start + pace;
      turn = { wait, pace };
      turns.set(id, turn);
    }
    return turn;
  };
}

/**
 * One step on a run's rail. One that lands while you watch makes room first (what is below glides down, the rail runs
 * into the gap and branches off) and only then fades in; one landing behind others stays out of the layout until its
 * turn. The clipping that does it comes off once the row has settled (MonoCode's `PhaseStep`).
 */
function PhaseStep({ live, turn: arrival, children }: { live: boolean; turn?: StepTurn; children: ReactNode }) {
  const [turn] = useState(arrival);
  const [stage, setStage] = useState<'waiting' | 'entering' | 'settled'>(() => (!turn ? 'settled' : turn.wait > 0 ? 'waiting' : 'entering'));
  useEffect(() => {
    if (stage !== 'waiting' || !turn) return;
    const t = window.setTimeout(() => setStage('entering'), turn.wait);
    return () => window.clearTimeout(t);
  }, [stage, turn]);
  useEffect(() => {
    // Reduce motion fires no animationend: settle after the entrance would have played
    if (stage !== 'entering' || !turn) return;
    const t = window.setTimeout(() => setStage('settled'), turn.pace + 50);
    return () => window.clearTimeout(t);
  }, [stage, turn]);
  return (
    <div
      className="wt-step"
      style={turn ? ({ '--step-ms': `${Math.round(turn.pace)}ms` } as CSSProperties) : undefined}
      data-live={live || undefined}
      data-waiting={stage === 'waiting' || undefined}
      data-entering={stage === 'entering' || undefined}
      onAnimationEnd={(e) => {
        // the row's own fade is the last beat; nested animations bubble theirs
        if (e.animationName === 'wt-step-in' && (e.target as Element).parentElement === e.currentTarget) setStage('settled');
      }}
    >
      {children}
    </div>
  );
}

/* ---------- rows ---------- */

const ROW = 'flex min-w-0 items-center gap-1.5 py-1';

/** Reasoning as one dim line; it opens only on purpose, onto the whole thought (MonoCode's `ActivityThinkingRow`). */
function ThoughtStep({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const line = proseSummary(text) || 'Thinking';
  const pulse = streaming ? 'wt-thinking-pulse' : '';
  if (!hasMoreThanSummary(text)) return <div className={ROW}><span className={cn('wt-dim min-w-0 flex-1 truncate text-copy', pulse)}>{line}</span></div>;
  return (
    <div className="flex min-w-0 flex-col">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={cn('group', ROW, 'text-left')}>
        <span className={cn('wt-dim wt-hover-up min-w-0 flex-1 truncate text-copy', pulse)}>{open ? 'Thinking' : line}</span>
      </button>
      <DisclosureRegion open={open} className="min-w-0 pb-2"><ChatMarkdown text={text} variant="muted" className="wt-reasoning text-copy" /></DisclosureRegion>
    </div>
  );
}

/** A line the bot wrote while working, kept to one line; it opens onto the whole of it (MonoCode's `ActivityNoteRow`). */
function NoteStep({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const line = proseSummary(text);
  if (!hasMoreThanSummary(text)) return <div className={ROW}><span className="wt-target min-w-0 flex-1 truncate text-copy">{line}</span></div>;
  return (
    <div className="flex min-w-0 flex-col">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={cn('group', ROW, 'text-left')}>
        <span className="wt-target min-w-0 flex-1 truncate text-copy group-hover:text-fg">{line}</span>
      </button>
      <DisclosureRegion open={open} className="min-w-0 pb-2"><ChatMarkdown text={text} variant="muted" className="text-copy" /></DisclosureRegion>
    </div>
  );
}

const FILE_KINDS = new Set<ToolCallPart['kind']>(['read', 'edit', 'delete', 'move']);

/**
 * A call as one row (MonoCode's `ActivityToolRow` + `ToolCallSummary`): the verb, dim; what it acted on, a file as a
 * chip, a command in mono; a red ✕ only for one that didn't work, never a mark for running or done. Any row with
 * something to show opens onto it.
 */
const ToolStep = memo(function ToolStep({ part, opts, running }: { part: ToolCallPart; opts: TrailOptions; running: boolean }) {
  const [open, setOpen] = useState(false);
  const state = toolState(part, opts);
  const failed = state === 'rejected';
  const awaiting = !!opts.awaiting?.has(part.toolCallId);
  const s = trailSentence(part, running);
  const files = part.kind === 'edit' ? editedFiles(part) : [];
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const meta = toolMeta(part, { settled: opts.settled, interrupted: opts.interrupted });
  const excerpt = part.status === 'failed' ? failureInfo(part).excerpt : undefined;
  const expandable = hasToolDetails(part);
  const fileTarget = FILE_KINDS.has(part.kind) && s.object;
  const summary = (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className={cn('shrink-0 text-copy', failed ? 'wt-fail' : 'wt-dim')}>{s.verb}</span>
      {s.object ? (
        fileTarget ? (
          <span className={cn('wt-chip flex min-w-0 items-center gap-1 rounded-[5px] px-1 py-px font-mono text-ui', failed ? 'wt-fail' : 'wt-target')} title={s.object}>
            <Icon icon={File} size={12} className="size-3 shrink-0 opacity-70" />
            <span className="min-w-0 truncate">{s.object}</span>
          </span>
        ) : (
          <span className={cn('min-w-0 truncate text-ui', s.chip && 'font-mono', failed ? 'wt-fail' : s.chip ? 'wt-label' : 'wt-target')} title={s.object}>{s.object}</span>
        )
      ) : null}
      {added || removed ? <span className="shrink-0 text-note"><DiffStat added={added} removed={removed} /></span> : null}
      {awaiting ? <span className="shrink-0 text-note text-warning">needs your approval</span> : null}
      {meta?.tone === 'cancelled' ? <span className="wt-dim shrink-0 text-note">{meta.text}</span> : null}
      {failed ? <Icon icon={X} size={14} className="wt-fail size-3.5 shrink-0" /> : null}
    </span>
  );
  return (
    <div className="flex min-w-0 flex-col" title={part.title}>
      {expandable ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={cn('group', ROW, 'w-full text-left')}>
          {summary}
          <Chevron open={open} className={cn('opacity-0 transition-[opacity,transform] group-hover:opacity-100 group-focus-visible:opacity-100', open && 'opacity-100', failed && 'wt-fail')} />
        </button>
      ) : <div className={ROW}>{summary}</div>}
      {/* the line that explains a failure reads without opening the row */}
      {excerpt && !open ? <p className="wt-fail truncate pb-1 font-mono text-note leading-5 opacity-80" title={excerpt}>{excerpt}</p> : null}
      {expandable ? <DisclosureRegion open={open} className="min-w-0 pt-0.5 pb-2"><ToolDetails part={part} /></DisclosureRegion> : null}
    </div>
  );
});

function StepRow({ step, opts, streaming }: { step: TrailStep; opts: TrailOptions; streaming: boolean }) {
  const { part } = step;
  if (part.type === 'thought') return <ThoughtStep text={part.text} streaming={streaming} />;
  return <ToolStep part={part} opts={opts} running={!opts.settled && toolState(part, opts) === 'pending'} />;
}

/* ---------- a run of work ---------- */

/**
 * One run: a header the run hangs off, and its steps under it on a rail. It opens while it is the live one and
 * closes when the bot moves on, until you click, after which it stays where you put it; a step waiting on you keeps it
 * open. While live the open body is a short window pinned to the newest step (MonoCode's `ActivityPhaseGroup`).
 */
function ActivityGroup({ steps, opts, active, lastIndex }: { steps: TrailStep[]; opts: TrailOptions; active: boolean; lastIndex: number }) {
  const [override, setOverride] = useState<boolean | null>(null);
  const waiting = needsApproval(steps, opts.awaiting);
  const open = waiting || (override ?? active);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  useLivePhaseScroll(scroller, active && open, steps);
  // steps already here when the run mounted, or that landed while it was closed, are history: only a step you watch
  // arrive gets the entrance
  const seen = useRef<Set<number> | null>(null);
  seen.current ??= new Set(steps.map((s) => s.index));
  useEffect(() => { for (const s of steps) seen.current?.add(s.index); }, [steps]);
  const turnFor = useStepQueue();
  const kind = workKind(steps);
  const title = workSummaryLine(steps, active);
  const failed = failedCount(steps, opts);
  const streamingIndex = opts.settled ? -1 : lastIndex;

  // a lone call is not a group: a header repeating the one row under it says nothing twice
  if (steps.length === 1) {
    return (
      <div className="flex min-w-0 items-start gap-1.5">
        {/* a 16px slot like the status line's avatar, so every label in the trail starts on one edge */}
        {kind === 'think' ? null : <span className="flex h-7 w-4 shrink-0 items-center justify-center"><KindIcon kind={kind} /></span>}
        <div className="min-w-0 flex-1"><StepRow step={steps[0]!} opts={opts} streaming={steps[0]!.index === streamingIndex} /></div>
      </div>
    );
  }

  const label = active ? (
    <span ref={syncAnimationsToTimelineOrigin} className="shimmer min-w-0 truncate text-copy text-muted">{title}</span>
  ) : (
    // dimmed to sit with the icons: the work is chrome around the reply, and only the reply reads at full strength
    <span className="wt-dim wt-hover-up min-w-0 truncate text-copy">{title}</span>
  );
  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? `Hide the steps for ${title}` : `Show the steps for ${title}`}
        onClick={() => setOverride(!open)}
        className={cn('group', ROW, 'w-full text-left')}
      >
        {/* the two icons share one box, so the swap is instant: a fade between them leaves both half drawn. The box is
            the status line's 16px (its avatar), so this label starts where "Working" does and the rail drops from its middle */}
        <span className="relative flex size-4 shrink-0 items-center justify-center">
          {kind === 'think' ? <Icon icon={Minus} size={14} className="wt-icon size-3.5 group-hover:opacity-0" /> : <KindIcon kind={kind} className="group-hover:opacity-0" />}
          <Chevron open={open} className="absolute opacity-0 group-hover:opacity-100" />
        </span>
        {label}
        {failed ? <span className="wt-fail shrink-0 text-copy">· {failed} failed</span> : null}
      </button>
      <div className="wt-phase-body" data-open={open}>
        {open ? (
          <div ref={setScroller} className={active ? 'wt-phase-live' : undefined}>
            <div className="flex min-w-0 flex-col">
              {steps.map((step) => (
                <PhaseStep key={step.index} live={active} turn={active && !seen.current!.has(step.index) ? turnFor(step.index) : undefined}>
                  <StepRow step={step} opts={opts} streaming={step.index === streamingIndex} />
                </PhaseStep>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Thinking before the bot has said or done anything else (MonoCode's `InitialThinking`). */
function InitialThinking({ live }: { live: boolean }) {
  return (
    <div className={ROW}>
      <span ref={syncAnimationsToTimelineOrigin} className={cn('text-copy text-muted', live && 'shimmer')}>Thinking…</span>
    </div>
  );
}

function ItemView({ item, opts, active, lastIndex, initialThinking }: { item: TrailItem; opts: TrailOptions; active: boolean; lastIndex: number; initialThinking: boolean }) {
  switch (item.type) {
    case 'activity':
      if (initialThinking) return <InitialThinking live={!opts.settled} />;
      return <ActivityGroup steps={item.steps} opts={opts} active={active} lastIndex={lastIndex} />;
    case 'note': return <NoteStep text={item.item.part.text} />;
    case 'plan': return <div className="py-1"><PlanChecklist part={item.item.part} live={!opts.settled} /></div>;
  }
}

/* ---------- the trail ---------- */

const NO_AWAITING: ReadonlySet<string> = new Set();

/**
 * The trail of one agent message: its status line, then its work in order, the part it has written past folded
 * behind the line. A memo on the message: a finished turn's trail never draws again while another streams.
 */
export const WorkTrail = memo(function WorkTrail({ msg, endAt }: { msg: Message; endAt: number }) {
  const settled = msg.status !== 'streaming';
  const interrupted = msg.status === 'cancelled' || msg.status === 'error';
  const thread = useStore((s) => s.threads.find((t) => t.id === msg.threadId));
  // the calls of this turn waiting on your approval, as one string so an unrelated change doesn't draw the trail again
  const awaitingKey = useStore((s) => (settled ? '' : s.pendingPermissions.filter((p) => p.threadId === msg.threadId && p.toolCallId).map((p) => p.toolCallId).join('\n')));
  const awaiting = useMemo(() => (awaitingKey ? new Set(awaitingKey.split('\n')) : NO_AWAITING), [awaitingKey]);
  const opts = useMemo<TrailOptions>(() => ({ settled, interrupted, awaiting }), [settled, interrupted, awaiting]);
  const items = useMemo(() => trailItems(msg.parts, opts), [msg.parts, opts]);
  const fold = useMemo(() => foldableWork(items, opts), [items, opts]);
  const [open, setOpen] = useState(false);
  // a turn watched while it ran puts its live work away as it settles, rather than dropping it in one frame
  const wasLive = useRef(!settled);
  const settleFromLive = settled && wasLive.current;
  useEffect(() => { if (!settled) wasLive.current = true; }, [settled]);
  // the fold of a live turn and of a settled one are two regions: the settled one starts open and closes (above)
  const foldKey = settled ? 'settled' : 'live';
  useEffect(() => { setOpen(false); }, [foldKey]);

  if (settled && !items.length) return null;
  const waiting = !settled && (thread?.status === 'waiting' || awaiting.size > 0);
  const lastActivity = items.reduce((last, item, i) => (item.type === 'activity' ? i : last), -1);
  const thinkingAt = settled ? -1 : initialThinkingIndex(items);
  const lastIndex = msg.parts.length - 1;
  const isActive = (i: number) => {
    if (settled || i !== lastActivity) return false;
    const item = items[i]!;
    const answering = items.slice(i + 1).some((x) => x.type === 'note');
    return !(answering && item.type === 'activity' && !activityStillRunning(item.steps, opts));
  };
  const row = (item: TrailItem, i: number) => (
    <ItemView item={item} opts={opts} active={isActive(i)} lastIndex={lastIndex} initialThinking={i === thinkingAt} />
  );

  const out: ReactNode[] = [];
  items.forEach((item, i) => {
    if (fold && i >= fold.start && i <= fold.end) {
      if (i !== fold.start) return;
      const span = items.slice(fold.start, fold.end + 1);
      out.push(
        <FoldRegion key={`fold-${foldKey}`} folded={!open} startOpen={settleFromLive && !open}>
          {() => span.map((entry, k) => (
            <div key={entry.key} className={cn('wt-fold-rail flow-root pl-5', k === span.length - 1 && 'wt-fold-tail')}>
              {row(entry, fold.start + k)}
            </div>
          ))}
        </FoldRegion>,
      );
      return;
    }
    out.push(<div key={item.key} className="flow-root">{row(item, i)}</div>);
  });

  return (
    <div className="wt mb-1.5 flex min-w-0 flex-col" data-live={settled ? undefined : true}>
      <StatusLine
        msg={msg} live={!settled} waiting={waiting} endAt={endAt} botId={thread?.botId}
        expandable={!!fold} open={open && !!fold} drop={fold?.start === 0} onToggle={() => setOpen((o) => !o)}
      />
      {out}
    </div>
  );
}, (a, b) => a.msg === b.msg && a.endAt === b.endAt);
