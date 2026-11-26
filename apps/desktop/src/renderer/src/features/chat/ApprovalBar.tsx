// Approval request docked on top of the composer (adapted from Akeru's BotApprovalPrompt, MIT): its rounded top
// continues the prompt pill. ⌘↵ allows once, Esc rejects.
import { motion } from 'motion/react';
import type { PermissionRequest } from '@appubot/protocol';
import { argumentRows, rawCommand, rawPath, wantsTo } from '@appubot/chat-core';
import { ShieldQuestion } from '../../components/ui/icons';
import { Button, Icon, Kbd, cn, isDialogOpen } from '../../components/ui';
import { optimisticCall } from '../../lib/optimistic';
import { useHotkey } from '../../lib/hooks';
import { IS_MAC, shortcut } from '../../lib/platform';
import { DiffBlock } from './ToolDetails';

const MONO = 'selectable max-h-32 overflow-auto rounded-card bg-code-bg px-3 py-2 font-mono text-note leading-[1.55] break-words whitespace-pre-wrap text-fg-2';

function Preview({ req }: { req: PermissionRequest }) {
  const command = rawCommand(req.rawInput);
  const diff = req.content.find((c) => c.type === 'diff');
  if (diff?.type === 'diff') return <DiffBlock path={diff.path} oldText={diff.oldText} newText={diff.newText} maxHeight={180} />;
  if (command) return <pre className={MONO}><span className="text-muted select-none">$ </span>{command}</pre>;
  const path = rawPath(req.rawInput);
  if (path) return <div className={MONO}>{path}</div>;
  const fields = argumentRows(req.rawInput);
  if (!fields.length) return null;
  // tool arguments as "name: value" lines rather than raw JSON
  return (
    <div className={cn(MONO, 'font-sans text-ui')}>
      {fields.map((f) => (
        <div key={f.name} className="flex gap-2">
          <span className="shrink-0 text-muted">{f.name}</span>
          <span className="min-w-0 text-fg-2">{f.value}</span>
        </div>
      ))}
    </div>
  );
}

export function ApprovalBar({ requests, botName }: { requests: PermissionRequest[]; botName: string }) {
  const req = requests[0]!;
  const allowOnce = req.options.find((o) => o.kind === 'allow_once') ?? req.options.find((o) => o.kind.startsWith('allow'));
  const allowAlways = req.options.find((o) => o.kind === 'allow_always');
  const reject = req.options.find((o) => o.kind === 'reject_once') ?? req.options.find((o) => o.kind.startsWith('reject'));

  // the bar moves on the moment you answer (the next request, or away); a refused answer brings it back with an error
  const respond = (optionId: string) => {
    void optimisticCall('permissions.respond', { id: req.id, optionId }, [{ kind: 'remove', coll: 'pendingPermissions', id: req.id }], { errorTitle: 'Could not send your answer' });
  };

  useHotkey((e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && !isDialogOpen(), () => { if (allowOnce) void respond(allowOnce.optionId); }, !!allowOnce);
  useHotkey((e) => e.key === 'Escape' && !isDialogOpen(), () => { if (reject) void respond(reject.optionId); }, !!reject);

  return (
    <motion.section
      key={req.id}
      role="alertdialog"
      aria-label="Approval needed"
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      className="chat-approval squircle mb-1 w-full rounded-t-card rounded-b-md border border-b-transparent border-[color:var(--ab-surface-border)] bg-[var(--ab-composer)] px-4 pt-3 pb-2.5"
    >
      <div className="flex min-w-0 items-center gap-2 text-ui">
        <Icon icon={ShieldQuestion} size={15} className="text-muted" />
        <p className="min-w-0 flex-1 truncate text-fg-2"><span className="font-medium text-fg">{botName}</span> wants to {wantsTo(req)}</p>
        {requests.length > 1 ? <span className="shrink-0 text-muted tabular-nums">1 of {requests.length}</span> : null}
      </div>
      <div className="mt-2"><Preview req={req} /></div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {allowOnce ? (
          <Button size="sm" variant="primary" onClick={() => void respond(allowOnce.optionId)}>
            Allow once<Kbd className="ml-0.5 h-4 bg-[color-mix(in_srgb,var(--ab-primary-fg)_16%,transparent)] text-[11px] text-primary-fg/80">{shortcut(IS_MAC ? '↵' : 'Enter')}</Kbd>
          </Button>
        ) : null}
        {allowAlways ? (
          <Button size="sm" variant="secondary" onClick={() => void respond(allowAlways.optionId)}>Always allow</Button>
        ) : null}
        {reject ? (
          <Button size="sm" variant="danger" onClick={() => void respond(reject.optionId)}>
            Reject<Kbd className="ml-0.5 h-4 bg-transparent text-[11px] text-danger/80">Esc</Kbd>
          </Button>
        ) : null}
      </div>
    </motion.section>
  );
}
