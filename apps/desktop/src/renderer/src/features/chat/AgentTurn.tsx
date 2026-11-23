// One agent reply, laid out like Synara's MessagesTimeline turn (MIT): flat (no bubble, no avatar); while it runs,
// a live "Working for 12s" header over live rows and a shimmering "Thinking" line; once settled, the work folds
// behind "Worked for 20s ˅" and the final answer reads below it, followed by the edited-files card and a footer
// (copy, time). A turn you watched holds its live layout for a beat, then folds its work away with the disclosure
// motion. In the answers-only chat view (settings.chatView, the default) none of the work shows: "Working for 12s"
// and what the bot asks or sends while it runs, then just its reply, set in a text-message bubble (`ReplyBubble`).
// The desktop always shows the answers view now; with Settings › Appearance › Chat shows: Everything, the bot's work
// reads as a trail above it (WorkTrail.tsx, after MonoCode's), and the reply under the trail stays exactly the same.
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Message, Part } from '@appubot/protocol';
import { BotAvatar, cn } from '../../components/ui';
import { AiStatus } from '../../components/rare/AiStatus';
import { syncAnimationsToTimelineOrigin } from '../../lib/animationTimelineSync';
import { ChangesCard } from './ChangesCard';
import { PagePart } from './PagePart';
import { DISCLOSURE_CLEANUP_MS, DISCLOSURE_MS, DisclosureChevron, DisclosureRegion } from './Disclosure';
import { LiveElapsed } from './LiveTimer';
import { ChatMarkdown } from './Markdown';
import { FileTile, ImageTiles } from './MediaParts';
import { VoiceNote } from '../voice/VoiceNote';
import { Notice, PlanChecklist } from './Notices';
import { FailureCard } from './FailureCard';
import { QuestionCard } from './QuestionCard';
import { FormCard } from './FormCard';
import { ReactionChip } from './Reactions';
import { MessageActions } from './MessageActions';
import { ThinkingRow, ThoughtRow, ToolGroupRow, ToolRow } from './ToolRow';
import {
  capOpenTools, chunkWork, answerOnly, formatTurnHeaderLabel, layoutTurn, liveAnswerParts, segmentFlow, turnFileChanges, turnHeader, type Chunk, type Indexed,
  reactionBy, trailItems,
} from '@appubot/chat-core';
import { useStore } from '../../lib/store';
import { useMessagesTheme, useWorkTrail } from '../../lib/appearance';
import { WorkTrail } from './WorkTrail';
import { Bubble, type BubbleSpot } from './Bubble';

type ImagePart = Extract<Part, { type: 'image' }>;

/** How long a turn that just ended keeps its live layout before folding (Synara's ACTIVE_TURN_LAYOUT_SETTLE_DELAY_MS). */
export const SETTLE_HOLD_MS = 180;

interface Ctx {
  settled: boolean;
  interrupted: boolean;
  /** when the turn stopped streaming; a call still running then shows how long it ran */
  endedAt?: number;
  /** the live layout (streaming, or holding it for a beat after): open tool rows keep the newest */
  live: boolean;
  lastIndex: number;
  botName: string;
  /** the turn's bot (a form card switching its apps) */
  botId?: string;
  /** its colour (a voice note lights up in it while it plays) */
  botColor?: string;
  /** rows inside the folded "Worked for" region: spaced further apart, never capped */
  folded?: boolean;
  /** the answers-only chat view: reply text sits in a bubble */
  bubble?: boolean;
  /** a settled reply's hover actions for one of its bubbles (by part index, with that bubble's text) */
  bubbleActions?: (index: number, text: string) => ReactNode;
  /** where each reply bubble sits in its run of bubbles (by part index), for its corners */
  bubbleRun?: Map<number, BubbleSpot>;
  /** the Messages theme: when the reply ended, shown inside each of its bubbles (none while it streams) */
  stampAt?: number;
}

/** A text message's corners: round all over; the last bubble of a bot's run ends it on a small tail, its bottom corner on the bot's side tightened. */
export const BUBBLE_CORNERS: Record<BubbleSpot, string> = {
  only: 'squircle rounded-[18px] rounded-bl-[6px]',
  first: 'squircle rounded-[18px]',
  middle: 'squircle rounded-[18px]',
  last: 'squircle rounded-[18px] rounded-bl-[6px]',
};

/** The reply's text bubbles in order, each with its place in the run (the corners of a chat's grouped messages). */
function bubbleRun(list: Chunk[]): Map<number, BubbleSpot> {
  const texts = list.flatMap((c) => (c.kind === 'item' && c.item.part.type === 'text' && c.item.part.text.trim() ? [c.item.index] : []));
  return new Map(texts.map((i, k) => [i, texts.length === 1 ? 'only' : k === 0 ? 'first' : k === texts.length - 1 ? 'last' : 'middle']));
}

/**
 * The bot's bubble: an ink wash under a faint sheen at its top (index.css `.chat-bubble-reply`), no outline or shadow in
 * either scheme, a text message's padding (12 by 7 around 15px text) and width (a group room's bots wear the same:
 * features/groups/GroupView.tsx).
 */
export const REPLY_BUBBLE = 'chat-bubble-reply w-fit max-w-[88%] min-w-9 bg-agent-bubble px-3 py-[7px]';

/**
 * The bot's reply as a text message (answers-only view): a left-aligned bubble sized to its text, the user bubble's
 * shape and type on the bot's own fill. Wide code and tables take the bubble's full width and scroll inside it.
 */
function ReplyBubble({ children, actions, spot = 'only', at }: { children: ReactNode; actions?: ReactNode; spot?: BubbleSpot; at?: number }) {
  const themed = useMessagesTheme();
  // each bubble with its own hover actions on its right, centred on it
  return (
    <div className="group/msg flex min-w-0 items-center justify-start gap-1.5">
      {themed ? (
        // the theme's bubble: the run's last one carries the tail, a settled one its time
        <Bubble side="in" spot={spot} at={at} className="w-fit max-w-[88%]">{children}</Bubble>
      ) : (
        <div className={cn(REPLY_BUBBLE, BUBBLE_CORNERS[spot])}>
          {children}
        </div>
      )}
      {actions}
    </div>
  );
}

function Block({ item, ctx }: { item: Indexed; ctx: Ctx }): ReactNode {
  const { part, index } = item;
  const isLast = !ctx.settled && index === ctx.lastIndex;
  switch (part.type) {
    case 'text':
      if (!part.text.trim()) return null;
      return ctx.bubble
        ? <ReplyBubble spot={ctx.bubbleRun?.get(index)} at={ctx.stampAt} actions={ctx.bubbleActions?.(index, part.text)}><ChatMarkdown text={part.text} streaming={isLast} /></ReplyBubble>
        : <ChatMarkdown text={part.text} streaming={isLast} />;
    case 'thought': return <ThoughtRow text={part.text} />;
    case 'tool_call': return <ToolRow part={part} settled={ctx.settled} interrupted={ctx.interrupted} endedAt={ctx.endedAt} />;
    case 'file': return <FileTile file={part.file} />;
    case 'page': return <PagePart part={part} />;
    // a bubble as wide as its player, like the user's own voice messages (not stretched across the turn)
    case 'voice': return <VoiceNote part={part} color={ctx.botColor} className="self-start" />;
    case 'plan': return <PlanChecklist part={part} live={!ctx.settled} />;
    case 'question': return part.form ? <FormCard part={part} botName={ctx.botName} botId={ctx.botId} botColor={ctx.botColor} expired={ctx.settled} /> : <QuestionCard part={part} botName={ctx.botName} botColor={ctx.botColor} expired={ctx.settled} />;
    case 'system': return <Notice part={part} />;
    default: return null;
  }
}

/** Parts in order; consecutive images share one tile grid. */
function blocks(items: Indexed[], ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  for (let k = 0; k < items.length; k++) {
    const item = items[k]!;
    if (item.part.type === 'image') {
      const run: ImagePart[] = [item.part];
      while (items[k + 1]?.part.type === 'image') run.push(items[++k]!.part as ImagePart);
      out.push(<ImageTiles key={`img${item.index}`} images={run} />);
    } else {
      out.push(<Block key={item.index} item={item} ctx={ctx} />);
    }
  }
  return out;
}

/**
 * A reply read aloud (the bot's `send_voice`, or the reply spoken for a voice message) leads its turn, the way a voice
 * note comes before the words under it; it may be all the turn says.
 */
export function voiceFirst(list: Indexed[]): Indexed[] {
  const voice = list.filter((x) => x.part.type === 'voice' && x.part.kind === 'reply');
  return voice.length ? [...voice, ...list.filter((x) => !voice.includes(x))] : list;
}

const chunkKey = (c: Chunk) => (c.kind === 'group' ? `g${c.id}` : `i${c.item.index}`);

function chunkRow(c: Chunk, ctx: Ctx, liveTail: boolean): ReactNode {
  if (c.kind === 'item') return <Block key={chunkKey(c)} item={c.item} ctx={ctx} />;
  return (
    <ToolGroupRow
      key={chunkKey(c)}
      tools={c.tools.map((t) => t.part)}
      settled={ctx.settled}
      liveTail={liveTail}
      interrupted={ctx.interrupted}
      endedAt={ctx.endedAt}
      folded={ctx.folded}
    />
  );
}

/** The folded work of a settled turn, in order (Synara's collapsed turn items). */
function foldedRows(list: Chunk[], ctx: Ctx): ReactNode[] {
  return list.map((c) => chunkRow(c, ctx, false));
}

/** Work rows under (or above) a stretch of text; past four open calls the rest hide behind "+N more tool calls". */
function WorkBlock({ list, ctx, tail, className }: { list: Chunk[]; ctx: Ctx; tail: boolean; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const cap = capOpenTools(list, { expanded, keep: ctx.live ? 'last' : 'first' });
  const last = list[list.length - 1];
  return (
    <div className={className}>
      {/* a live turn's work is its own Synara work row (space-y-0.5); a settled answer's inline tools sit tighter */}
      <div className={ctx.live ? 'space-y-0.5' : 'space-y-px'}>{cap.chunks.map((c) => chunkRow(c, ctx, tail && c === last))}</div>
      {cap.hidden ? (
        <div className="py-0.5">
          <button type="button" onClick={() => setExpanded((e) => !e)} className="text-copy text-muted transition-colors duration-150 hover:text-fg">
            {expanded ? 'Show less' : `+${cap.hidden} more tool calls`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Text and cards with their work between them, one Synara assistant row per segment. */
function Flow({ list, ctx }: { list: Chunk[]; ctx: Ctx }) {
  const segs = useMemo(() => segmentFlow(list), [list]);
  return (
    <>
      {segs.map((s, k) => {
        const last = k === segs.length - 1;
        // segments only ever append, so position is a stable key (a run turning into a group must not remount text)
        return (
          // bubbles (the answers view) sit close together, like a chat's messages from one side
          <div key={k} className={cn('min-w-0', ctx.bubble ? 'py-0' : 'py-0.5', !last && (ctx.bubble ? 'mb-1' : ctx.live ? 'mb-1' : 'mb-2'))}>
            {s.lead.length ? <WorkBlock list={s.lead} ctx={ctx} tail={last && !s.content.length} className="mb-1.5" /> : null}
            {s.content.length ? <div className={cn('flex flex-col', ctx.bubble ? 'gap-1' : 'gap-2')}>{blocks(s.content, ctx)}</div> : null}
            {s.inline.length ? <WorkBlock list={s.inline} ctx={ctx} tail={last} className="mt-1.5" /> : null}
          </div>
        );
      })}
    </>
  );
}

/** "Working for 12s" over a hairline: the counting-up twin of a settled turn's header. */
function WorkingHeader({ since }: { since: number }) {
  return (
    <div className="mb-2">
      <div className="-ml-0.5 pb-2 text-copy leading-normal text-muted">
        Working for <span className="tabular-nums"><LiveElapsed since={since} /></span>
      </div>
      <div aria-hidden className="h-px w-full bg-border" />
    </div>
  );
}

/**
 * The answers-only view's live turn: the bot itself at work (its avatar's working motion, or hopping when it needs
 * you) and how long it has been at it, like a messaging app's typing indicator. A memo: the reply streaming in above
 * it doesn't draw it again.
 */
const WORKING_STATES = {
  working: { label: 'Working', active: true },
  'needs-you': { label: 'Waiting for you', active: false },
} as const;

/**
 * The working row of the answers view, on Rare UI's status line: the bot's avatar, "Working" shimmering and how long.
 * Nothing about what it is doing (the owner's call, 2026-11-15, on seeing "Running nohup google-chrome --no-…" beside
 * it: the answers view names no tool and shows no command).
 */
const BotWorkingRow = memo(function BotWorkingRow({ threadId, since }: { threadId: string; since: number }) {
  const thread = useStore((s) => s.threads.find((t) => t.id === threadId));
  const bot = useStore((s) => (thread ? s.bots.find((b) => b.id === thread.botId) : undefined));
  const needsYou = thread?.status === 'waiting';
  return (
    <AiStatus
      ref={syncAnimationsToTimelineOrigin}
      className="py-1"
      state={needsYou ? 'needs-you' : 'working'}
      states={WORKING_STATES}
      icon={<BotAvatar bot={bot} size={26} mood={needsYou ? 'needs-you' : 'working'} />}
      iconSize={26}
      time={<LiveElapsed since={since} />}
    />
  );
});

function LiveTurn({ msg, ctx, ended, answers, trail }: { msg: Message; ctx: Ctx; ended: boolean; answers: boolean; trail: boolean }) {
  const list = useMemo(() => chunkWork(answers ? voiceFirst(liveAnswerParts(msg.parts)) : msg.parts.map((part, index) => ({ part, index }))), [msg.parts, answers]);
  // the Messages theme: the bubbles so far are one run, its newest carrying the tail
  const themed = useMessagesTheme();
  const run = useMemo(() => (themed && answers ? bubbleRun(list) : undefined), [themed, answers, list]);
  return (
    <div className="flex flex-col">
      {ended || answers ? null : <WorkingHeader since={msg.createdAt} />}
      {list.length ? <div className="pb-1"><Flow list={list} ctx={run ? { ...ctx, bubbleRun: run } : ctx} /></div> : null}
      {/* with the work trail on, its status line above says the bot is working */}
      {ended || (answers && trail) ? null : answers ? <BotWorkingRow threadId={msg.threadId} since={msg.createdAt} /> : <ThinkingRow />}
    </div>
  );
}

type FoldPhase = 'none' | 'open' | 'closing';

function SettledTurn({ msg, ctx, cwd, endAt, fold, answers, trail }: { msg: Message; ctx: Ctx; cwd?: string; endAt: number; fold: FoldPhase; answers: boolean; trail: boolean }) {
  const L = useMemo(() => layoutTurn(msg.parts), [msg.parts]);
  const work = useMemo(() => chunkWork(L.work), [L.work]);
  // a failed turn's own error note isn't a red line in the reply: the failure card under it says it, with its fixes
  const failed = msg.status === 'error';
  const answer = useMemo(() => chunkWork(voiceFirst((answers ? answerOnly(L) : [...L.pinned, ...L.answer]).filter((x) => !(failed && x.part.type === 'system' && x.part.level === 'error')))), [L, answers, failed]);
  const changes = useMemo(() => turnFileChanges(msg.parts), [msg.parts]);
  const [open, setOpen] = useState(false);
  const themed = useMessagesTheme();
  const header = turnHeader(msg, endAt);
  const label = formatTurnHeaderLabel(header);
  const answerText = L.answer.map((x) => (x.part.type === 'text' ? x.part.text : '')).filter((t) => t.trim()).join('\n\n');
  // a voice reply (or any card) is a reply too: only a turn with nothing at all to show "did not reply"
  const silent = !L.hasWork && !answerText && !L.answer.some((x) => x.part.type !== 'text') && !L.pinned.length;
  // failed before doing or saying anything: one line says so, with why ("Interrupted after 2s · …" above it repeated it)
  const failedSilently = msg.status === 'error' && silent;
  const folded = { ...ctx, folded: true };
  // the work trail's status line says how the turn ended (Stopped, Interrupted …): no second line for it
  const trailShown = useMemo(() => trail && trailItems(msg.parts, { settled: true }).length > 0, [trail, msg.parts]);

  return (
    <div className={cn('group/turn flex flex-col', answers ? 'pb-3.5' : 'pb-2')}>
      {fold !== 'none' && L.hasWork && !open ? (
        // the work as it read live, closing above the new header so the turn doesn't jump shut in one frame
        <div aria-hidden inert className="pointer-events-none mb-3 select-none">
          <DisclosureRegion open={fold === 'open'} className="space-y-1.5 pb-2.5">{foldedRows(work, folded)}</DisclosureRegion>
        </div>
      ) : null}
      {L.hasWork && !answers ? (
        <div className="mb-3">
          <div className="-ml-0.5 pb-2 text-copy leading-normal text-muted">
            <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="inline-flex min-w-0 items-center text-left transition-colors duration-200 hover:text-fg">
              <span className="inline-flex min-w-0 items-center gap-1">
                <span>{label}</span>
                <DisclosureChevron open={open} className="text-muted/70" />
              </span>
            </button>
          </div>
          <DisclosureRegion open={open} className="mb-2.5 space-y-1.5">{foldedRows(work, folded)}</DisclosureRegion>
          <div aria-hidden className="h-px w-full bg-border" />
        </div>
      ) : null}
      {answer.length && answers ? (
        // its bubbles, each with its own actions on its right (copy copies that bubble; react reacts to the reply)
        <Flow
          list={answer}
          ctx={{ ...ctx, stampAt: endAt, bubbleRun: bubbleRun(answer), bubbleActions: (_i, text) => <MessageActions text={text} msg={msg} at={endAt} side="right" sentLabel="Replied" /> }}
        />
      ) : answer.length ? <Flow list={answer} ctx={ctx} /> : null}
      {/* what went wrong and what fixes it, as a card (never a red line): FailureCard.tsx */}
      {failed ? <div className={answer.length ? 'mt-1.5' : undefined}><FailureCard msg={msg} botName={ctx.botName} /></div> : null}
      {changes.length && !answers ? <ChangesCard files={changes} cwd={cwd} /> : null}
      {/* your reaction stays visible under the reply; click it to take it back */}
      {reactionBy(msg, 'user') ? <div className={themed && answers ? 'chat-reaction-row chat-reaction-row--in' : 'mt-1'}><ReactionChip msg={msg} by="user" /></div> : null}
      {answerText && !answers ? (
        // the full view: the same actions under the turn, shown while it is hovered; the first pulls left by its own
        // inset so its glyph lines up with the text
        <div className="group/msg mt-0.5 flex h-6 items-center [&>div>*:first-child]:-ml-[0.4375em]">
          <MessageActions text={answerText} msg={msg} at={endAt} side="right" sentLabel="Replied" className="group-hover/turn:opacity-100" />
        </div>
      ) : null}
    </div>
  );
}

type Phase = 'live' | 'hold' | FoldPhase;

/**
 * live → (ends) hold: the live layout stays for SETTLE_HOLD_MS without its header and Thinking line → open: the
 * settled turn mounts with a copy of its work still open → closing (next frame): the copy folds away → none.
 * A turn that was never seen streaming starts settled.
 */
function useSettlePhase(streaming: boolean): Phase {
  const [phase, setPhase] = useState<Phase>(streaming ? 'live' : 'none');
  if (streaming && phase !== 'live') setPhase('live');
  else if (!streaming && phase === 'live') setPhase('hold');
  useEffect(() => {
    if (phase === 'hold') {
      const t = setTimeout(() => setPhase('open'), SETTLE_HOLD_MS);
      return () => clearTimeout(t);
    }
    if (phase === 'open') {
      const raf = requestAnimationFrame(() => setPhase('closing'));
      return () => cancelAnimationFrame(raf);
    }
    if (phase === 'closing') {
      const t = setTimeout(() => setPhase('none'), DISCLOSURE_MS + DISCLOSURE_CLEANUP_MS);
      return () => clearTimeout(t);
    }
  }, [phase]);
  return phase;
}

export const AgentTurn = memo(function AgentTurn({ msg, botName, cwd }: { msg: Message; botName: string; cwd?: string }) {
  const streaming = msg.status === 'streaming';
  // the answers view, always: `settings.chatView`'s Synara "everything" layout is no longer the desktop's (its switch was
  // hidden and the store moves it back to answers); the bot's work shows as the trail above the reply instead
  const answers = true;
  const trail = useWorkTrail();
  const settle = useSettlePhase(streaming);
  // answers only: nothing folds away, so the reply shows the moment the turn ends
  const phase: Phase = answers ? (streaming ? 'live' : 'none') : settle;
  // the end is when streaming stopped; later updatedAt bumps (a part touched after the fact) don't stretch it
  const endRef = useRef<number | null>(null);
  if (streaming) endRef.current = null;
  else endRef.current ??= msg.updatedAt;
  const endAt = endRef.current ?? msg.updatedAt;
  const live = phase === 'live' || phase === 'hold';
  const botId = useStore.getState().threads.find((t) => t.id === msg.threadId)?.botId;
  const ctx: Ctx = {
    settled: !streaming,
    interrupted: msg.status === 'cancelled' || msg.status === 'error',
    endedAt: streaming ? undefined : endAt,
    live,
    lastIndex: msg.parts.length - 1,
    botName,
    botId,
    botColor: useStore.getState().bots.find((b) => b.id === botId)?.color,
    bubble: answers,
  };
  // `data-quotable`: text selected in a reply can be quoted into the next message (QuoteSelection);
  // `data-image-gallery`: opening one of its images shows them all (imageGallery.ts)
  return (
    <div data-quotable data-image-gallery className="contents">
      {/* one trail across the turn's live and settled layouts, so it folds its work away as the turn ends */}
      {trail ? <WorkTrail msg={msg} endAt={endAt} /> : null}
      {live
        ? <LiveTurn msg={msg} ctx={ctx} ended={phase === 'hold'} answers={answers} trail={trail} />
        : <SettledTurn msg={msg} ctx={ctx} cwd={cwd} endAt={endAt} fold={answers ? 'none' : phase as FoldPhase} answers={answers} trail={trail} />}
    </div>
  );
});
