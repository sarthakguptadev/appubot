// Transcript work rows (Synara's TimelineWorkEntryRow / ToolCallGroupSummaryRow, MIT): one compact muted sentence
// per tool call whose icon and text brighten together on hover and expand inline; runs of calls fold into one
// summary line; edits read "Edited <file> +3 -1", one row per file; thoughts read as their last line.
import { memo, useState, type ReactNode } from 'react';
import {
  Brain, ComputerUse, File, Globe, Hammer, MessageSquare, PenLine, Search, Send, SquareTerminal, ToggleLeft,
  type IconComponent,
} from '../../components/ui/icons';
import { Icon, cn } from '../../components/ui';
import { syncAnimationsToTimelineOrigin } from '../../lib/animationTimelineSync';
import { useStore } from '../../lib/store';
import { DisclosureChevron, DisclosureRegion } from './Disclosure';
import { LiveElapsed } from './LiveTimer';
import { ChatMarkdown } from './Markdown';
import { DiffStat, ToolDetails, hasToolDetails } from './ToolDetails';
import {
  basename, editedFiles, failureInfo, isRunning, summarizeGroup, thoughtLine, toolIconKey, toolMeta, toolSentence,
  type Category, type ToolCallPart, type ToolIconKey, type ToolMeta,
} from '@appubot/chat-core';

/** The row itself; the icon and sentence carry the tone so they brighten as one unit. */
const ROW = 'group/tool-row flex w-full items-center gap-1.5 text-left transition-[opacity,translate] duration-200 focus-visible:outline-none';
const FILE_ROW = 'group/file-row flex w-full max-w-full items-center gap-1.5 text-left transition-colors duration-150 focus-visible:outline-none';
const TONE = 'text-muted transition-colors group-hover/tool-row:text-fg group-focus-visible/tool-row:text-fg';
const FILE_TONE = 'text-muted transition-colors group-hover/file-row:text-fg group-focus-visible/file-row:text-fg';
const CHEVRON = 'text-muted/70 group-hover/tool-row:text-fg group-hover/file-row:text-fg group-focus-visible/tool-row:text-fg group-focus-visible/file-row:text-fg';
/** A command quoted inside a sentence ("Ran `ls`"), matching inline code in chat markdown. */
const CHIP = 'rounded-[0.4rem] bg-user-bubble px-[0.35rem] py-[0.05rem] font-mono text-note text-fg/80';

const TOOL_ICON: Record<ToolIconKey, IconComponent> = {
  command: SquareTerminal, read: File, edit: PenLine, search: Search, fetch: Globe, think: Brain, mode: ToggleLeft,
  computer: ComputerUse, send: Send, ask: MessageSquare, tool: Hammer,
};

export function toolIcon(t: ToolCallPart): IconComponent {
  return TOOL_ICON[toolIconKey(t)];
}

const CATEGORY_ICON: Record<Category | 'mixed', IconComponent> = {
  read: File, edit: PenLine, search: Search, command: SquareTerminal, fetch: Globe, computer: ComputerUse, ask: MessageSquare, send: Send, tool: Hammer, other: Hammer, mixed: Hammer,
};

function IconBox({ icon, className }: { icon: IconComponent; className?: string }) {
  return <span aria-hidden className={cn('flex size-4 shrink-0 items-center justify-center', className)}><Icon icon={icon} size={14} className="size-3.5" /></span>;
}

/** The sentence of a call: the verb carries the tense, commands sit in a mono chip. */
function Sentence({ part, running }: { part: ToolCallPart; running: boolean }) {
  const s = toolSentence(part, running);
  return (
    <>
      {s.verb}
      {s.object ? ' ' : null}
      {s.object ? (s.chip ? <code className={CHIP}>{s.object}</code> : s.object) : null}
    </>
  );
}

/** " · 12s elapsed" (live), " · Failed · exit 1", " · Cancelled · 4s elapsed". */
function MetaTail({ meta }: { meta: ToolMeta | null }) {
  if (!meta) return null;
  if (meta.tone === 'running') return <span> · <LiveElapsed since={meta.since} /> elapsed</span>;
  return <span className={meta.tone === 'failed' ? 'text-danger' : undefined}> · {meta.text}</span>;
}

/** A row that opens its details inline (Synara's ToolDetailsDisclosure): chevron after the text, details indented under it. */
function DetailsDisclosure({ summary, after, children, rowClassName = ROW, detailsClassName = 'ml-5 min-w-0 pt-2', title }: {
  summary: ReactNode; after?: ReactNode; children: ReactNode; rowClassName?: string; detailsClassName?: string; title?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="group/tool-details min-w-0">
      <button type="button" aria-expanded={open} title={title} onClick={() => setOpen((o) => !o)} className={rowClassName}>
        {summary}
        <DisclosureChevron open={open} className={CHEVRON} />
      </button>
      {after}
      <DisclosureRegion open={open} className={detailsClassName}>{children}</DisclosureRegion>
    </div>
  );
}

interface RowProps { part: ToolCallPart; settled: boolean; interrupted?: boolean; endedAt?: number }

/** "Edited a.ts +3 -1", one row per file the call changed. */
function EditRows({ part, files, meta }: { part: ToolCallPart; files: ReturnType<typeof editedFiles>; meta: ToolMeta | null }) {
  return (
    <div className="space-y-0.5">
      {files.map((f, i) => {
        const own = files.length > 1 ? { ...part, content: part.content.filter((c) => c.type !== 'diff' || c.path === f.path) } : part;
        const content = (
          <>
            <IconBox icon={PenLine} className={FILE_TONE} />
            <span className={cn('shrink-0 text-copy', FILE_TONE)}>Edited</span>
            <span className={cn('max-w-[28rem] truncate text-copy underline-offset-2 group-hover/file-row:underline group-focus-visible/file-row:underline', FILE_TONE)}>{basename(f.path)}</span>
            {f.added || f.removed ? <span className="shrink-0 text-copy whitespace-nowrap tabular-nums"><DiffStat added={f.added} removed={f.removed} /></span> : null}
            {i === files.length - 1 && meta ? <span className={cn('shrink-0 text-copy', FILE_TONE)}><MetaTail meta={meta} /></span> : null}
          </>
        );
        return hasToolDetails(own) ? (
          <DetailsDisclosure key={f.path} rowClassName={FILE_ROW} summary={content} title={f.path}><ToolDetails part={own} /></DetailsDisclosure>
        ) : (
          <div key={f.path} className={FILE_ROW} title={f.path}>{content}</div>
        );
      })}
    </div>
  );
}

export const ToolRow = memo(function ToolRow({ part, settled, interrupted, endedAt }: RowProps) {
  const running = isRunning(part, settled);
  const meta = toolMeta(part, { settled, interrupted, endedAt });
  const awaiting = useStore((s) => running && s.pendingPermissions.some((p) => p.toolCallId === part.toolCallId));
  const files = part.kind === 'edit' ? editedFiles(part) : [];
  if (files.length) return <div className="py-0.5"><EditRows part={part} files={files} meta={meta} /></div>;

  const failure = part.status === 'failed' ? failureInfo(part) : null;
  const content = (
    <>
      <IconBox icon={toolIcon(part)} className={TONE} />
      <div className="min-w-0 overflow-hidden">
        <p className={cn('truncate text-copy leading-5', TONE)}>
          <span><Sentence part={part} running={running} /></span>
          <MetaTail meta={meta} />
          {awaiting ? <span className="text-warning"> · needs your approval</span> : null}
        </p>
      </div>
    </>
  );
  // the line that explains a failure sits under the row, aligned with its text
  const excerpt = failure?.excerpt ? (
    <p className="truncate pl-[1.375rem] font-mono text-note leading-5 text-danger/85" title={failure.excerpt}>{failure.excerpt}</p>
  ) : null;
  return (
    <div className="py-0.5">
      {hasToolDetails(part) ? (
        <DetailsDisclosure summary={content} after={excerpt}><ToolDetails part={part} /></DetailsDisclosure>
      ) : (
        <><div className={ROW}>{content}</div>{excerpt}</>
      )}
    </div>
  );
});

/**
 * A run of 2+ calls as one line. Settled: "Read 2 files, ran 3 commands, 1 failed". Live (the run is the turn's
 * tail or still running): the newest call's own sentence, revealing the earlier calls when opened.
 */
export function ToolGroupRow({ tools, settled, liveTail, interrupted, endedAt, folded }: {
  tools: ToolCallPart[]; settled: boolean; liveTail: boolean; interrupted?: boolean; endedAt?: number; folded?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const summary = summarizeGroup(tools, settled);
  const newest = !settled && (liveTail || summary.running) ? tools[tools.length - 1]! : null;
  const newestFiles = newest?.kind === 'edit' ? editedFiles(newest).length : 0;
  // a multi-file edit wears a count, so its own file rows still belong behind the line
  const children = newest && newestFiles <= 1 ? tools.slice(0, -1) : tools;
  let label: ReactNode;
  if (newest) label = newestFiles > 1 ? `Edited ${newestFiles} files` : <Sentence part={newest} running={isRunning(newest, settled)} />;
  else label = <>{summary.label}{summary.failed ? <>, <span className="text-danger">{summary.failed} failed</span></> : null}</>;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex max-w-full items-center gap-1.5 py-0.5 text-left text-copy leading-normal text-muted hover:text-fg"
      >
        <IconBox icon={newest ? toolIcon(newest) : CATEGORY_ICON[summary.icon]} />
        <span className="min-w-0 truncate">{label}</span>
        <DisclosureChevron open={open} className="text-muted/70" />
      </button>
      <DisclosureRegion open={open} className={folded ? 'space-y-0.5 pt-0.5' : 'space-y-px pt-0.5'}>
        {children.map((t) => <ToolRow key={t.toolCallId} part={t} settled={settled} interrupted={interrupted} endedAt={endedAt} />)}
      </DisclosureRegion>
    </div>
  );
}

/** Reasoning as a work row (Synara's reasoning entry): no icon, its last readable line, the whole text when opened. */
export const ThoughtRow = memo(function ThoughtRow({ text }: { text: string }) {
  const line = thoughtLine(text);
  if (!line) return null;
  const content = (
    <div className="min-w-0 overflow-hidden">
      <p className={cn('text-copy leading-5 break-words whitespace-pre-wrap', TONE)}>{line}</p>
    </div>
  );
  return (
    <div className="py-0.5">
      {text.trim() !== line ? (
        <DetailsDisclosure summary={content} detailsClassName="min-w-0 pt-2"><ChatMarkdown text={text} variant="muted" /></DetailsDisclosure>
      ) : (
        <div className={ROW}>{content}</div>
      )}
    </div>
  );
});

/** The live turn's last line while it runs: a stepped shimmer over the icon and label together. */
export function ThinkingRow() {
  return (
    <div className="pb-1">
      <div ref={syncAnimationsToTimelineOrigin} role="status" className="shimmer-group flex w-fit items-center gap-1.5 pt-0.5 text-copy leading-normal text-muted">
        <span aria-hidden className="flex shrink-0"><Icon icon={Brain} size={14} className="size-[1.125em] opacity-100" /></span>
        <span>Thinking</span>
      </div>
    </div>
  );
}
