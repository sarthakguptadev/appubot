import { useEffect, useMemo, useState } from 'react';
import type { Routine } from '@appubot/protocol';
import { Bell, CalendarClock, MessageSquare, MoreHorizontal, Pencil, Play, Plus, Trash2 } from '../../components/ui/icons';
import { Button, EmptyState, Icon, Menu, Spinner, Switch, cn } from '../../components/ui';
import { PanelHeader, ROW_HOVER } from '../../components/layout/PanelChrome';
import { call, confirm, openThread } from '../../lib/actions';
import { optimisticCall } from '../../lib/optimistic';
import { cronToHuman, timeAgo, timeUntil } from '@appubot/chat-core';
import { useNow } from '../../lib/hooks';
import { byId, pushToast, selectSelectedBot, setState, ui, upsertBy, useStore } from '../../lib/store';
import { activeComputer } from '../../lib/gateway';
import { remember } from '../../lib/remembered';

const EXAMPLES = [
  'Every weekday at 9:00: summarise unread email',
  'Every Monday: reconcile last week’s receipts',
  'Every hour: check the build and notify me if it fails',
];

export async function runRoutineNow(r: Routine): Promise<void> {
  const thread = await call('routines.runNow', { id: r.id }, { errorTitle: 'Could not run routine' });
  if (!thread) return;
  setState((s) => ({ threads: upsertBy(s.threads, thread, byId) }));
  pushToast({ title: `Running “${r.name}”`, level: 'info', threadId: thread.id });
  await openThread(thread.id);
}

function RoutineRow({ r, now }: { r: Routine; now: number }) {
  const toggle = (enabled: boolean) => {
    void optimisticCall('routines.update', { id: r.id, patch: { enabled } }, [{ kind: 'patch', coll: 'routines', id: r.id, fields: { enabled } }], {
      errorTitle: 'Could not update routine', answered: (x) => ({ coll: 'routines', entity: x }),
    });
  };

  const remove = () =>
    confirm({
      title: `Delete “${r.name}”?`,
      body: 'It will stop running. Past chats it started are kept.',
      confirmLabel: 'Delete routine',
      danger: true,
      onConfirm: () => {
        void optimisticCall('routines.delete', { id: r.id }, [{ kind: 'remove', coll: 'routines', id: r.id }], { errorTitle: 'Could not delete routine' });
      },
    });

  const last = timeAgo(r.lastRunAt, now);
  const lastLabel = last ? (last === 'now' ? 'just now' : /^\d+[mhd]$/.test(last) ? `${last} ago` : last) : 'never';

  return (
    <div className={cn('group/row flex items-start gap-2.5 rounded-[10px] px-2 py-2', ROW_HOVER)}>
      <button
        type="button"
        onClick={() => ui.openModal({ kind: 'routine', routineId: r.id })}
        className="flex min-w-0 flex-1 items-start gap-2.5 rounded-[8px] text-left outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]"
      >
        <span className={cn('mt-px flex size-7 shrink-0 items-center justify-center rounded-[8px]', r.enabled ? 'bg-surface-2 text-fg-2' : 'bg-surface-2 text-muted')}>
          <Icon icon={r.deliverTo === 'notify' ? Bell : CalendarClock} size={15} />
        </span>
        <span className={cn('min-w-0 flex-1', !r.enabled && 'opacity-60')}>
          <span className="block truncate text-copy font-medium text-fg">{r.name}</span>
          <span className="block truncate text-note text-fg-2">{cronToHuman(r.schedule)}</span>
          <span className="mt-0.5 block truncate text-note text-muted">
            {r.enabled ? <>Next {timeUntil(r.nextRunAt, now)}</> : 'Paused'} · Last {lastLabel} · {r.deliverTo === 'notify' ? 'Notifies you' : 'Stays in chat'}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
        <Switch checked={r.enabled} onChange={(v) => toggle(v)} label={`${r.enabled ? 'Pause' : 'Resume'} ${r.name}`} />
        <Menu
          trigger={(p) => (
            <Button
              variant="ghost" size="icon-xs" icon={MoreHorizontal} aria-label={`${r.name} options`} aria-haspopup="menu"
              aria-expanded={p['aria-expanded']} onClick={p.onClick} className="ml-1"
            />
          )}
          items={[
            { label: 'Run now', icon: Play, onSelect: () => void runRoutineNow(r) },
            { label: 'Edit', icon: Pencil, onSelect: () => ui.openModal({ kind: 'routine', routineId: r.id }) },
            ...(r.lastThreadId ? [{ label: 'Open in chat', icon: MessageSquare, onSelect: () => void openThread(r.lastThreadId!) }] : []),
            'separator',
            { label: 'Delete', icon: Trash2, danger: true, onSelect: remove },
          ]}
        />
      </div>
    </div>
  );
}

/** Scheduled prompts for the selected bot. */
export function RoutinesPanel() {
  const bot = useStore(selectSelectedBot);
  const all = useStore((s) => s.routines);
  const [loading, setLoading] = useState(false);
  const now = useNow(30_000);
  // read on this computer before: the kept list shows at once, and an empty one says so rather than spinning
  const readBefore = useStore((s) => !!s.remembered['loaded:routines']);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const from = activeComputer();
    void call('routines.list', {}, { errorTitle: 'Could not load routines' }).then((list) => {
      if (!alive) return;
      setLoading(false);
      if (list) { setState({ routines: list }); remember('loaded:routines', true, from); }
    });
    return () => { alive = false; };
  }, []);

  const routines = useMemo(
    () => all.filter((r) => r.botId === bot?.id).sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity)),
    [all, bot?.id],
  );

  if (!bot) {
    return (
      <div className="flex h-full flex-col">
        <EmptyState icon={CalendarClock} title="No bot selected" body="Pick a bot to see its routines." className="flex-1" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        actions={routines.length > 0 ? <Button variant="secondary" size="sm" icon={Plus} onClick={() => ui.openModal({ kind: 'routine' })}>New</Button> : null}
      />
      <div className="flex-1 overflow-y-auto px-2.5 pb-4">
        {routines.length === 0 ? (
          loading && !readBefore ? (
            <div className="flex justify-center py-10 text-muted"><Spinner size={18} /></div>
          ) : (
            <EmptyState
              icon={CalendarClock}
              title="No routines yet"
              body={
                <div className="flex flex-col gap-3">
                  <span>Routines run a prompt on a schedule, even when you’re away. For example:</span>
                  <ul className="flex flex-col gap-1 text-left">
                    {EXAMPLES.map((ex) => (
                      <li key={ex} className="rounded-[10px] px-3 py-2 text-note text-fg-2 shadow-[inset_0_0_0_.5px_var(--ab-hairline)]">{ex}</li>
                    ))}
                  </ul>
                </div>
              }
              action={<Button size="sm" variant="primary" icon={Plus} onClick={() => ui.openModal({ kind: 'routine' })}>New routine</Button>}
            />
          )
        ) : (
          <ul className="ab-rise-list flex flex-col gap-px">
            {routines.map((r) => (
              <li key={r.id}><RoutineRow r={r} now={now} /></li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
