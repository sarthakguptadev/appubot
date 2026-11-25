import type { Part } from '@appubot/protocol';
import { AlertCircle, AlertTriangle, Info } from '../../components/ui/icons';
import { Icon, cn } from '../../components/ui';
import { TaskCheck, TaskLabel } from '../../components/rare/TaskCheck';

type P<T extends Part['type']> = Extract<Part, { type: T }>;

/** The agent's plan as a quiet checklist (Synara-like muted rows). */
export function PlanChecklist({ part, live }: { part: P<'plan'>; live: boolean }) {
  const done = part.entries.filter((e) => e.status === 'completed').length;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="pb-0.5 text-ui text-muted tabular-nums">Plan · {done} of {part.entries.length} done</div>
      {part.entries.map((e, i) => (
        <div key={i} className="flex items-start gap-2 py-0.5 text-copy leading-5">
          {/* Rare UI's task row: the ring fills and draws its tick, then the words strike through; the step in hand turns its ring */}
          <span className="flex size-5 shrink-0 items-center justify-center">
            <TaskCheck checked={e.status === 'completed'} size={16} accent="var(--ab-success)" dashed busy={e.status === 'in_progress' && live} className={e.status === 'in_progress' ? 'text-fg-2' : undefined} />
          </span>
          <span className="min-w-0 flex-1 pt-px">
            <TaskLabel struck={e.status === 'completed'} className={e.status === 'completed' ? 'text-muted' : e.status === 'in_progress' ? 'text-fg' : 'text-fg-2'}>{e.content}</TaskLabel>
          </span>
        </div>
      ))}
    </div>
  );
}

/** A one-line system notice; warnings and errors carry a tinted icon. */
export function Notice({ part }: { part: P<'system'> }) {
  const tone = { info: { icon: Info, cls: 'text-muted' }, warning: { icon: AlertTriangle, cls: 'text-warning' }, error: { icon: AlertCircle, cls: 'text-danger' } }[part.level];
  return (
    <p className="flex items-start gap-2 text-ui leading-5 text-muted">
      <Icon icon={tone.icon} size={14} className={cn('mt-[3px]', tone.cls)} />
      <span className="selectable min-w-0 break-words">{part.text}</span>
    </p>
  );
}
