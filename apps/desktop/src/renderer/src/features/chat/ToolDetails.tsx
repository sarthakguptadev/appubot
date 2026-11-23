// Inline details under an expanded tool row (adapted from Synara's ToolCallDetailsContent, MIT):
// terminal output, diffs, text output, images, and the screen after a computer action.
import { memo, useMemo } from 'react';
import { FileText } from '../../components/ui/icons';
import type { ToolContent } from '@appubot/protocol';
import { Icon, cn } from '../../components/ui';
import { linkTarget } from '../../lib/gateway';
import { native } from '../../lib/native';
import { openFileById } from '../../lib/openFile';
import { useStore } from '../../lib/store';
import { ChatMarkdown, CopyButton } from './Markdown';
import { basename, collapse, diffLines, diffStats, rawCommand, toolOutput, type ToolCallPart } from '@appubot/chat-core';

export function DiffStat({ added, removed, className }: { added: number; removed: number; className?: string }) {
  if (!added && !removed) return null;
  return (
    <span className={cn('inline-flex items-baseline gap-1.5 tabular-nums', className)}>
      <span className="text-[color:var(--ab-diff-add)]">+{added}</span>
      <span className="text-[color:var(--ab-diff-del)]">-{removed}</span>
    </span>
  );
}

const BLOCK = 'selectable max-h-[22rem] overflow-auto rounded-control bg-code-bg font-mono text-note leading-[1.6]';

/** Shell transcript: `$ command` then its output. */
export function TerminalBlock({ command, output, maxHeight }: { command?: string; output?: string; maxHeight?: number }) {
  const text = output?.replace(/\n+$/, '') ?? '';
  return (
    <div className="group/block relative">
      <pre className={cn(BLOCK, 'px-3 py-2.5 break-words whitespace-pre-wrap text-fg-2')} style={maxHeight ? { maxHeight } : undefined}>
        {command ? <><span className="text-muted select-none">$ </span><span className="text-fg">{command}</span>{text ? '\n' : ''}</> : null}
        {text || (command ? null : <span className="text-muted">No output</span>)}
      </pre>
      {text || command ? <CopyButton text={command ? `$ ${command}\n${text}` : text} iconOnly className="absolute top-1.5 right-1.5 bg-[color:var(--ab-popover)] opacity-0 transition-opacity group-hover/block:opacity-100" /> : null}
    </div>
  );
}

/** File text as read by the agent; `cat -n` style numbers render as a muted gutter. */
function CodeLines({ text }: { text: string }) {
  const lines = text.replace(/\n+$/, '').split('\n');
  const numbered = lines.length > 0 && lines.every((l) => /^\s*\d+\t/.test(l) || l === '');
  if (!numbered) return <pre className={cn(BLOCK, 'px-3 py-2.5 break-words whitespace-pre-wrap text-fg-2')}>{text}</pre>;
  return (
    <pre className={cn(BLOCK, 'py-2 text-fg-2')}>
      {lines.map((l, i) => {
        const m = /^\s*(\d+)\t(.*)$/.exec(l);
        return (
          <span key={i} className="flex min-w-max px-3">
            <span className="w-8 shrink-0 pr-3 text-right text-muted/70 select-none">{m?.[1] ?? ''}</span>
            <span className="whitespace-pre">{m ? m[2] || ' ' : l || ' '}</span>
          </span>
        );
      })}
    </pre>
  );
}

export const DiffBlock = memo(function DiffBlock({ path, oldText, newText, maxHeight }: { path: string; oldText: string | null; newText: string; maxHeight?: number }) {
  const lines = useMemo(() => diffLines(oldText, newText), [oldText, newText]);
  const rows = useMemo(() => collapse(lines), [lines]);
  const stats = useMemo(() => diffStats(lines), [lines]);
  return (
    <div className="overflow-hidden rounded-control bg-code-bg">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1 text-note">
        <span className="min-w-0 truncate font-mono text-fg-2" title={path}>{basename(path)}</span>
        {oldText === null ? <span className="text-muted">new file</span> : null}
        <DiffStat added={stats.added} removed={stats.removed} className="ml-auto" />
      </div>
      <pre className="selectable overflow-auto pb-2 font-mono text-note leading-[1.6]" style={{ maxHeight: maxHeight ?? 352 }}>
        {rows.map((r, i) =>
          r.kind === 'gap' ? (
            <span key={i} className="block px-3 text-[11px] text-muted select-none">⋯ {r.count} unchanged line{r.count === 1 ? '' : 's'}</span>
          ) : (
            <span
              key={i}
              className={cn(
                'flex min-w-max px-3',
                r.kind === 'add' && 'bg-[color-mix(in_srgb,var(--ab-diff-add)_10%,transparent)]',
                r.kind === 'del' && 'bg-[color-mix(in_srgb,var(--ab-diff-del)_10%,transparent)]',
              )}
            >
              <span className={cn('w-4 shrink-0 select-none', r.kind === 'add' ? 'text-[color:var(--ab-diff-add)]' : r.kind === 'del' ? 'text-[color:var(--ab-diff-del)]' : 'text-muted/60')}>
                {r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}
              </span>
              <span className="whitespace-pre text-fg-2">{r.text || ' '}</span>
            </span>
          ),
        )}
      </pre>
    </div>
  );
});

function FrameThumb({ frameId }: { frameId: string }) {
  const frame = useStore((s) => s.actionFrames.find((f) => f.id === frameId) ?? (s.frame?.id === frameId ? s.frame : undefined));
  if (!frame) return null;
  return (
    <img src={`data:${frame.mimeType};base64,${frame.data}`} alt="Screen after this action" className="block h-[110px] w-auto rounded-control border border-border-subtle" />
  );
}

function ContentBlock({ content, part }: { content: ToolContent; part: ToolCallPart }) {
  switch (content.type) {
    case 'diff': return <DiffBlock path={content.path} oldText={content.oldText} newText={content.newText} />;
    case 'image': return <img src={`data:${content.mimeType};base64,${content.data}`} alt="" className="max-h-60 rounded-control border border-border-subtle" />;
    case 'resource_link':
      return (
        <button
          type="button"
          onClick={() => {
            // a web address in the browser; AppuBot's own file in its own app, never as a (tokened) gateway URL
            const to = linkTarget(content.uri);
            if (to && 'url' in to) void native().openExternal(to.url);
            else if (to) openFileById(to.fileId, content.title ?? content.name);
          }}
          className="flex items-center gap-2 text-copy text-fg-2 hover:text-fg"
        >
          <Icon icon={FileText} size={15} className="text-muted" />
          <span className="truncate underline-offset-2 hover:underline">{content.title ?? content.name}</span>
        </button>
      );
    case 'text': {
      const text = content.text.replace(/^```[\w-]*\n([\s\S]*?)\n?```\s*$/, '$1');
      if (part.kind === 'read' || text !== content.text) return <CodeLines text={text} />;
      return <ChatMarkdown text={content.text} variant="muted" className="text-copy" />;
    }
    default: return null;
  }
}

export function hasToolDetails(t: ToolCallPart): boolean {
  return t.content.length > 0 || (t.kind === 'execute' && !!rawCommand(t.rawInput)) || !!t.computer?.frameId || (t.status === 'failed' && t.rawOutput !== undefined);
}

export function ToolDetails({ part }: { part: ToolCallPart }) {
  const command = part.kind === 'execute' ? rawCommand(part.rawInput) ?? part.title : undefined;
  const blocks = command ? part.content.filter((c) => c.type !== 'text' && c.type !== 'terminal') : part.content;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {command ? <TerminalBlock command={command} output={toolOutput(part)} /> : null}
      {blocks.map((c, i) => <ContentBlock key={i} content={c} part={part} />)}
      {!command && !blocks.length && part.status === 'failed' && part.rawOutput !== undefined ? (
        <TerminalBlock output={typeof part.rawOutput === 'string' ? part.rawOutput : JSON.stringify(part.rawOutput, null, 2)} />
      ) : null}
      {part.computer?.frameId ? <FrameThumb frameId={part.computer.frameId} /> : null}
    </div>
  );
}
