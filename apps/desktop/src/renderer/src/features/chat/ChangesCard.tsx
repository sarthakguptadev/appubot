// End-of-turn summary of edited files (adapted from Synara's changes card + EditedFileRow, MIT).
import { useState } from 'react';
import { FileEdit, FileText, FolderOpen } from '../../components/ui/icons';
import { Icon, Tooltip } from '../../components/ui';
import { call } from '../../lib/actions';
import { native } from '../../lib/native';
import { SHOW_IN_FOLDER } from '../../lib/platform';
import { useRemoteComputer } from '../cloud/remoteFiles';
import { DisclosureChevron, DisclosureRegion } from './Disclosure';
import { DiffStat } from './ToolDetails';
import { basename, type FileChange } from '@appubot/chat-core';

const MAX_FILES = 5;

/**
 * Path shown relative to the bot's workspace (macOS reports /tmp as /private/tmp), with `/` between folders. A Windows
 * path (`C:\…`) is shown with `/` too and matched case-insensitively, as Windows does.
 */
function relative(path: string, cwd: string | undefined): string {
  if (!cwd) return path;
  if (/^[a-z]:[\\/]/i.test(cwd)) {
    const p = path.replace(/\\/g, '/');
    const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    return p.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? p.slice(root.length + 1) : path;
  }
  for (const root of [cwd, `/private${cwd}`]) if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path;
}

export function ChangesCard({ files, cwd }: { files: FileChange[]; cwd?: string }) {
  const remote = useRemoteComputer();
  const [open, setOpen] = useState(false);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const shown = files.slice(0, MAX_FILES);
  return (
    // Synara's turn changes card: the label over its diff stat, a quiet icon and chevron, a lighter border in dark
    <div className="mt-2 mb-1 overflow-hidden rounded-[0.65rem] border border-border-subtle dark:border-[color-mix(in_srgb,var(--ab-border-subtle)_55%,transparent)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 bg-[color-mix(in_srgb,var(--ab-user-bubble)_40%,transparent)] px-3 py-1.5 text-left text-copy"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <Icon icon={FileEdit} size={14} className="text-muted/70" />
          <span className="min-w-0">
            <span className="block truncate text-fg/92">Edited {files.length} file{files.length === 1 ? '' : 's'}</span>
            {added || removed ? <span className="block tabular-nums"><DiffStat added={added} removed={removed} /></span> : null}
          </span>
        </span>
        <span className="inline-flex shrink-0 items-center justify-center rounded-md p-1 text-muted/70 dark:text-muted/50">
          <DisclosureChevron open={open} className="text-inherit" />
        </span>
      </button>
      <DisclosureRegion open={open}>
        {shown.map((f) => {
          const rel = relative(f.path, cwd);
          const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
          return (
            <div key={f.path} className="group/file-row flex items-center gap-2 border-t border-border-subtle py-1.5 pr-2 pl-3 text-copy">
              <button type="button" title={f.path} onClick={() => void call('system.openPath', { path: f.path }, { errorTitle: 'Could not open the file' })} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <Icon icon={FileText} size={15} className="text-muted" />
                <span className="shrink-0 text-fg underline-offset-2 group-hover/file-row:underline">{basename(f.path)}</span>
                {dir ? <span className="min-w-0 truncate text-muted">{dir}</span> : null}
                {f.created ? <span className="shrink-0 text-muted">new</span> : null}
                <DiffStat added={f.added} removed={f.removed} className="ml-auto shrink-0" />
              </button>
              {remote ? null : <Tooltip label={SHOW_IN_FOLDER} side="top">
                <button type="button" aria-label={SHOW_IN_FOLDER} onClick={() => void native().showInFolder(f.path)} className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-opacity group-hover/file-row:opacity-100 hover:text-fg focus-visible:opacity-100">
                  <Icon icon={FolderOpen} size={14} />
                </button>
              </Tooltip>}
            </div>
          );
        })}
        {files.length > MAX_FILES ? <div className="border-t border-border-subtle px-3 py-1.5 text-ui text-muted">and {files.length - MAX_FILES} more</div> : null}
      </DisclosureRegion>
    </div>
  );
}
