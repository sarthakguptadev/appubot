import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, ListChecks, MousePointerClick, PenLine, Sparkles } from '../../components/ui/icons';
import { Button, Dialog, Field, Icon, Input, SETTINGS_CARD, Select, Textarea, cn } from '../../components/ui';
import { call } from '../../lib/actions';
import { rpc } from '../../lib/gateway';
import { IS_MAC } from '../../lib/platform';
import { activeComputer } from '../../lib/gateway';
import { openCloudDesktop } from '../cloud/DesktopView';
import { useCloudLink } from '../cloud/cloudClient';
import { setState, ui, useStore } from '../../lib/store';
import { PERMISSIONS_TITLE, settingAnchorId } from '../settings/nav';

/** the three steps, worded for the bot being taught (`Who`: its name at the start of a sentence) */
const steps = (who: string, Who: string) => [
  { icon: PenLine, title: 'Name the task', body: 'Say what you are about to show.' },
  { icon: MousePointerClick, title: 'Do it once', body: `Work normally while ${who} watches.` },
  { icon: Sparkles, title: `${Who} writes a skill`, body: 'Next time, just ask.' },
];

/** your AppuBot computer: it records what you do on its screen, shown here */
const screenSteps = (who: string, Who: string) => [
  { icon: PenLine, title: 'Name the task', body: 'Say what you are about to show.' },
  { icon: MousePointerClick, title: 'Do it on its screen', body: `Its screen opens here; ${who} watches what you do on it.` },
  steps(who, Who)[2]!,
];

/** where nothing can record (a Wayland session, the hooks missing): the skill comes from the description alone */
const manualSteps = (who: string, Who: string) => [
  { icon: PenLine, title: 'Name the task', body: 'Say what the skill is for.' },
  { icon: ListChecks, title: 'Describe it', body: 'Write the steps, in order.' },
  steps(who, Who)[2]!,
];

/**
 * Start a teach-by-demonstration session. macOS records with the helper (and needs its permissions); Windows and Linux
 * ask the core first (`teach.support`): where it can't record, the dialog asks for the steps in writing instead.
 */
export function TeachDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const bots = useStore((s) => s.bots);
  const selectedBotId = useStore((s) => s.selectedBotId);
  const perms = useStore((s) => s.computer?.permissions);
  const [botId, setBotId] = useState('');
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  /** Windows/Linux: why recording can't run here (null: it can, or not asked yet) */
  const [noRecording, setNoRecording] = useState<string | null>(null);
  /** your AppuBot computer: it records through its screen (the desktop view opens in teach mode) */
  const [throughScreen, setThroughScreen] = useState(false);
  const onCloud = activeComputer() === 'cloud';

  useEffect(() => {
    if (!open) return;
    setBotId(selectedBotId ?? bots[0]?.id ?? '');
    setName('');
    setGoal('');
    setBusy(false);
    // Only reset on open; bot list changes shouldn't wipe what the user typed.
  }, [open]);

  useEffect(() => {
    // a Mac records with its helper; any other computer (a PC, your AppuBot computer) says how it records
    if (!open || (IS_MAC && !onCloud)) { setThroughScreen(false); return; }
    let live = true;
    rpc('teach.support').then(
      (s) => { if (live) { setNoRecording(s.recording ? null : (s.reason ?? 'Recording isn\'t available on this computer.')); setThroughScreen(s.recording && s.how === 'live'); } },
      () => { if (live) setNoRecording(null); },
    );
    return () => { live = false; };
  }, [open, onCloud]);

  const manual = noRecording !== null;
  // the bot picked below: the dialog speaks of it, not of the default bot
  const picked = bots.find((b) => b.id === botId)?.name;
  const who = picked ?? 'the bot';
  const Who = picked ?? 'The bot';
  const missingPerms = IS_MAC && !onCloud && (!perms || !perms.accessibility || !perms.screenRecording);
  const valid = botId.length > 0 && name.trim().length > 0 && (!manual || goal.trim().length > 0);

  const start = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    const session = await call('teach.start', { botId, name: name.trim(), goal: goal.trim() }, { errorTitle: manual ? 'Could not start' : 'Could not start recording' });
    setBusy(false);
    if (!session) return;
    setState({ teach: session });
    onClose();
    // the demo is given on your AppuBot computer's screen: it opens here, taken over, mirroring what you do
    if (throughScreen) openCloudDesktop(useCloudLink.getState().team, { teach: true });
  };

  const openPermissions = () => {
    onClose();
    ui.openSettings('permissions', settingAnchorId(PERMISSIONS_TITLE));
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title="Teach a task"
      description={manual ? `Tell ${who} the steps once: it saves them as a skill.` : throughScreen ? `Show ${who} once on your AppuBot computer’s screen: it learns the steps and repeats them.` : `Show ${who} once: it learns the steps and repeats them.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void start()}>{manual ? 'Write skill' : 'Start recording'}</Button>
        </>
      }
    >
      <form onSubmit={(e) => void start(e)} className="flex flex-col gap-4">
        <ol className="grid grid-cols-3 gap-2">
          {(manual ? manualSteps(who, Who) : throughScreen ? screenSteps(who, Who) : steps(who, Who)).map((s, i) => (
            <li key={s.title} className={cn(SETTINGS_CARD, 'flex flex-col gap-2 px-3 py-2.5')}>
              <div className="flex items-center gap-2">
                <span className={cn('flex size-6 items-center justify-center rounded-full', i === 2 ? 'bg-accent-soft text-accent-strong' : 'bg-surface-2 text-fg-2')}>
                  <Icon icon={s.icon} size={14} />
                </span>
                <span className="text-[11px] font-medium text-muted">Step {i + 1}</span>
              </div>
              <div>
                <div className="text-copy font-medium leading-tight text-fg">{s.title}</div>
                <div className="mt-0.5 text-note leading-snug text-muted">{s.body}</div>
              </div>
            </li>
          ))}
        </ol>

        {missingPerms ? (
          <div className="flex items-center gap-3 rounded-control-lg bg-warning-soft py-2 pr-2 pl-3.5 text-warning">
            <Icon icon={AlertTriangle} size={16} className="shrink-0" />
            <div className="min-w-0 flex-1 text-note leading-snug">
              {Who} needs Accessibility and Screen Recording access to watch what you do.
            </div>
            <Button size="sm" variant="secondary" onClick={openPermissions}>Set up</Button>
          </div>
        ) : null}

        {manual ? (
          <div className="flex items-start gap-3 rounded-control-lg bg-warning-soft py-2 pr-3 pl-3.5 text-warning">
            <Icon icon={AlertTriangle} size={16} className="mt-px shrink-0" />
            <div className="min-w-0 flex-1 text-note leading-snug">
              {noRecording} Write the steps below and {who} turns them into a skill.
            </div>
          </div>
        ) : null}

        <Field label="Bot">
          <Select value={botId} onChange={(e) => setBotId(e.target.value)}>
            {bots.length === 0 ? <option value="">No bots yet</option> : null}
            {bots.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Task name" hint="Short and specific works best.">
          <Input autoFocus data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="File this month's invoices" maxLength={80} />
        </Field>
        <Field label={manual ? 'Steps' : 'Goal'} hint={manual ? 'What to do, in order, and what done looks like.' : 'Optional. What does done look like?'}>
          <Textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            minRows={manual ? 4 : 2}
            maxHeight={manual ? 220 : 140}
            placeholder={manual
              ? 'Open Gmail and search for "invoice". Download each PDF, rename it by vendor and save it in Documents/Invoices/<month>.'
              : 'Every PDF invoice from Gmail ends up in Documents/Invoices/<month>, renamed by vendor.'}
          />
        </Field>
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
