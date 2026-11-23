import { useEffect, useState, type FormEvent } from 'react';
import type { Routine } from '@appubot/protocol';
import { Button, CardRow, Dialog, FIELD_HINT, FIELD_LABEL, Field, Input, Select, SettingsCard, Switch, Textarea, TimePicker, cn } from '../../components/ui';
import { call } from '../../lib/actions';
import { SHORT_DAYS, cronToHuman, cronToSpec, parseTimeValue, specToCron, timeValue, type ScheduleSpec } from '@appubot/chat-core';
import { byId, getState, setState, upsertBy, useStore } from '../../lib/store';
import { useThisComputer } from '../cloud/thisComputer';

type Freq = ScheduleSpec['kind'];
const FREQS: { id: Freq; label: string }[] = [
  { id: 'hourly', label: 'Every hour' },
  { id: 'daily', label: 'Every day' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'days', label: 'On certain days' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'custom', label: 'Advanced (cron)' },
];

/** Loose shape check for a 5/6-field cron expression. */
function looksLikeCron(expr: string): boolean {
  const f = expr.trim().split(/\s+/);
  return (f.length === 5 || f.length === 6) && f.every((x) => /^[\d*/,\-A-Za-z?LW#]+$/.test(x));
}

/** The editor's schedule fields, all kept as the user switches between frequencies. */
interface SchedState { freq: Freq; time: string; minute: number; days: number[]; day: number; cron: string }
const DEFAULT_SCHED: SchedState = { freq: 'weekdays', time: '09:00', minute: 0, days: [1, 3, 5], day: 1, cron: '0 9 * * 1-5' };

function schedFrom(cron: string): SchedState {
  const s = cronToSpec(cron);
  const base = { ...DEFAULT_SCHED, cron: cron.trim() };
  switch (s.kind) {
    case 'hourly': return { ...base, freq: 'hourly', minute: s.minute };
    case 'daily': case 'weekdays': return { ...base, freq: s.kind, time: timeValue(s.hour, s.minute) };
    case 'days': return { ...base, freq: 'days', days: s.days, time: timeValue(s.hour, s.minute) };
    case 'monthly': return { ...base, freq: 'monthly', day: s.day, time: timeValue(s.hour, s.minute) };
    case 'custom': return { ...base, freq: 'custom' };
  }
}

/** The cron for what's picked, or null while it isn't complete (no time, no day chosen). */
function cronOf(st: SchedState): string | null {
  if (st.freq === 'custom') return looksLikeCron(st.cron) ? st.cron.trim() : null;
  if (st.freq === 'hourly') return specToCron({ kind: 'hourly', minute: st.minute });
  const t = parseTimeValue(st.time);
  if (!t) return null;
  if (st.freq === 'days') return st.days.length ? specToCron({ kind: 'days', days: st.days, ...t }) : null;
  if (st.freq === 'monthly') return specToCron({ kind: 'monthly', day: Math.min(31, Math.max(1, st.day)), ...t });
  return specToCron({ kind: st.freq, ...t });
}

/** Create or edit a routine for the selected bot. */
export function RoutineDialog({ open, onClose, routineId }: { open: boolean; onClose: () => void; routineId?: string }) {
  const computer = useThisComputer();
  const routine = useStore((s) => (routineId ? s.routines.find((r) => r.id === routineId) : undefined));
  const botName = useStore((s) => {
    const id = routine?.botId ?? s.selectedBotId;
    return s.bots.find((b) => b.id === id)?.name;
  });
  const isNew = !routineId;

  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [sched, setSched] = useState<SchedState>(DEFAULT_SCHED);
  const patchSched = (p: Partial<SchedState>) => setSched((s) => ({ ...s, ...p }));
  const [deliverTo, setDeliverTo] = useState<Routine['deliverTo']>('notify');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const r = routineId ? getState().routines.find((x) => x.id === routineId) : undefined;
    setName(r?.name ?? '');
    setPrompt(r?.prompt ?? '');
    setSched(r ? schedFrom(r.schedule) : DEFAULT_SCHED);
    setDeliverTo(r?.deliverTo ?? 'notify');
    setEnabled(r?.enabled ?? true);
    setSaving(false);
  }, [open, routineId]);

  const schedule = cronOf(sched) ?? '';
  const cronOk = !!schedule;
  const human = cronOk ? cronToHuman(schedule) : '';
  const valid = name.trim().length > 0 && prompt.trim().length > 0 && cronOk && (!isNew || !!getState().selectedBotId);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    const fields = { name: name.trim(), prompt: prompt.trim(), schedule, deliverTo, enabled };
    let res: Routine | undefined;
    if (isNew) {
      const botId = getState().selectedBotId;
      if (!botId) { setSaving(false); return; }
      res = await call('routines.create', { botId, ...fields }, { errorTitle: 'Could not create routine', success: 'Routine created' });
    } else {
      res = await call('routines.update', { id: routineId, patch: fields }, { errorTitle: 'Could not save routine', success: 'Routine saved' });
    }
    setSaving(false);
    if (!res) return;
    const saved = res;
    setState((s) => ({ routines: upsertBy(s.routines, saved, byId) }));
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={isNew ? 'New routine' : 'Edit routine'}
      description={botName ? `${botName} will run this prompt on schedule.` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={!valid} onClick={() => void submit()}>
            {isNew ? 'Create routine' : 'Save'}
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <Field label="Name">
          <Input autoFocus data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning inbox summary" maxLength={80} />
        </Field>
        <Field label="Prompt" hint="Written as if you were asking in chat.">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            minRows={4}
            maxHeight={220}
            placeholder="Summarise my unread email from the last day. Flag anything that needs a reply today."
          />
        </Field>

        <div className="flex flex-col gap-2.5">
          <span className={FIELD_LABEL}>Schedule</span>
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="How often" className="w-44" value={sched.freq} onChange={(e) => {
              const freq = e.target.value as Freq;
              // switching to Advanced starts from what was picked, so it's a small edit rather than a blank field
              patchSched(freq === 'custom' ? { freq, cron: schedule || sched.cron } : { freq });
            }}>
              {FREQS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </Select>
            {sched.freq === 'hourly' ? (
              <label className="flex items-center gap-2 text-copy text-fg-2">
                at minute
                <Select aria-label="Minute past the hour" className="w-24" value={String(sched.minute)} onChange={(e) => patchSched({ minute: Number(e.target.value) })}>
                  {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => <option key={m} value={m}>:{String(m).padStart(2, '0')}</option>)}
                </Select>
              </label>
            ) : sched.freq !== 'custom' ? (
              <label className="flex items-center gap-2 text-copy text-fg-2">
                at
                <TimePicker aria-label="Time" value={sched.time} onChange={(time) => patchSched({ time })} />
              </label>
            ) : null}
            {sched.freq === 'monthly' ? (
              <label className="flex items-center gap-2 text-copy text-fg-2">
                on day
                <Input type="number" min={1} max={31} aria-label="Day of the month" value={sched.day} onChange={(e) => patchSched({ day: Number(e.target.value) || 1 })} className="w-20 tabular-nums" />
              </label>
            ) : null}
          </div>
          {sched.freq === 'days' ? (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
              {/* Monday first, as a week reads */}
              {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                const on = sched.days.includes(d);
                return (
                  <Button
                    key={d}
                    type="button"
                    size="sm"
                    variant={on ? 'primary' : 'secondary'}
                    aria-pressed={on}
                    onClick={() => patchSched({ days: on ? sched.days.filter((x) => x !== d) : [...sched.days, d] })}
                    className="min-w-12"
                  >
                    {SHORT_DAYS[d]}
                  </Button>
                );
              })}
            </div>
          ) : null}
          {sched.freq === 'custom' ? (
            <Input
              value={sched.cron}
              onChange={(e) => patchSched({ cron: e.target.value })}
              placeholder="0 18 * * 5"
              spellCheck={false}
              aria-label="Cron expression"
              aria-invalid={!cronOk}
              className="font-mono text-copy"
            />
          ) : null}
          <span className={cn(FIELD_HINT, !cronOk && 'text-danger')}>
            {cronOk
              ? `${human}, in ${computer.of} time.`
              : sched.freq === 'days' ? 'Pick at least one day.'
                : sched.freq === 'custom' ? 'Five fields: minute hour day-of-month month day-of-week.'
                  : 'Pick a time.'}
          </span>
        </div>

        <SettingsCard>
          <CardRow title="Deliver results" description="Where its answer goes when it runs.">
            <Select fit aria-label="Deliver results" value={deliverTo} onChange={(e) => setDeliverTo(e.target.value === 'thread' ? 'thread' : 'notify')}>
              <option value="notify">Notify me with a summary</option>
              <option value="thread">Just keep it in the chat</option>
            </Select>
          </CardRow>
          <CardRow title="Enabled" description="Off keeps the routine without running it.">
            <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
          </CardRow>
        </SettingsCard>
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
