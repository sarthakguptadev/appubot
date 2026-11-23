import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AccessibilityPerson, ArrowRight, Bell, Check, Mic, MonitorUp, ShieldCheck } from '../../components/ui/icons';
import { Badge, Button, Card, Icon, cn, type ButtonVariant } from '../../components/ui';
import { call } from '../../lib/actions';
import { native } from '../../lib/native';
import { COMPUTER_PERMISSIONS, PLATFORM } from '../../lib/platform';
import { setState, useStore } from '../../lib/store';
import { PermissionRows, refreshComputerStatus } from '../computer/PermissionRows';
import { turnOnNotifications, useNotificationAccess } from '../notifications/access';
import { MicPromptMock, NotificationPromptMock, SettingsPaneMock } from './MacMocks';
import { StepShell } from './StepShell';
import { TaskCheck } from '../../components/rare/TaskCheck';

type Nav = { onNext: () => void; onBack: () => void };
type Key = 'accessibility' | 'screenRecording' | 'notifications' | 'microphone';
type MicAccess = 'granted' | 'denied' | 'not-asked' | 'unknown';

/** while something is missing, how often to look again (System Settings is answered in another app) */
const POLL_MS = 2000;

const ITEMS: { key: Key; title: string; why: string; icon: typeof Bell; tint: string; optional?: boolean }[] = [
  { key: 'accessibility', title: 'Accessibility', why: 'To click and type in your apps', icon: AccessibilityPerson, tint: '#0a84ff' },
  { key: 'screenRecording', title: 'Screen Recording', why: 'To see what’s on the screen', icon: MonitorUp, tint: '#7d5cf5' },
  { key: 'notifications', title: 'Notifications', why: 'To tell you when a bot is done', icon: Bell, tint: '#ff3b30', optional: true },
  { key: 'microphone', title: 'Microphone', why: 'To hear you when you talk to a bot', icon: Mic, tint: '#ff9500', optional: true },
];

/** The microphone's state from macOS without asking, again on focus and every few seconds until it's allowed. */
function useMicAccess(): [MicAccess, (a: MicAccess) => void] {
  const [access, setAccess] = useState<MicAccess>('unknown');
  const read = useCallback(() => {
    // a window from before this method existed (dev, until it restarts) can't tell
    const ask = native().microphoneAccess;
    if (ask) void ask().then(setAccess, () => setAccess('unknown'));
  }, []);
  useEffect(() => {
    read();
    window.addEventListener('focus', read);
    return () => window.removeEventListener('focus', read);
  }, [read]);
  useEffect(() => {
    if (access === 'granted') return;
    const t = setInterval(read, POLL_MS);
    return () => clearInterval(t);
  }, [access, read]);
  return [access, setAccess];
}

/**
 * macOS: Accessibility and Screen Recording (computer use), notifications and the microphone, each with a picture of
 * what macOS shows and what to press there, the action that brings it up, and a check once it's given (read again on
 * focus and every couple of seconds). Accessibility and Screen Recording are what Continue waits for; Skip goes on
 * without. Windows and Linux have nothing to grant: what computer use reaches apps through, and notifications.
 */
export function PermissionsStep(nav: Nav) {
  return COMPUTER_PERMISSIONS ? <MacPermissions {...nav} /> : <OtherPermissions {...nav} />;
}

function MacPermissions({ onNext, onBack }: Nav) {
  const perms = useStore((s) => s.computer?.permissions);
  const notify = useNotificationAccess();
  const [mic, setMic] = useMicAccess();
  const granted: Record<Key, boolean> = {
    accessibility: !!perms?.accessibility,
    screenRecording: !!perms?.screenRecording,
    notifications: notify === 'on' || notify === 'unknown',
    microphone: mic === 'granted',
  };
  const required = granted.accessibility && granted.screenRecording;
  const firstMissing = ITEMS.find((it) => !granted[it.key])?.key;
  const [current, setCurrent] = useState<Key>(firstMissing ?? 'accessibility');
  const [busy, setBusy] = useState(false);

  // look again while Accessibility or Screen Recording is missing: the switch is flipped in System Settings
  useEffect(() => {
    void refreshComputerStatus();
    if (required) return;
    const t = setInterval(() => void refreshComputerStatus(), POLL_MS);
    return () => clearInterval(t);
  }, [required]);

  // once the one on show is given, the next missing one comes up (a moment later, so its check is seen)
  const latest = useRef(granted);
  latest.current = granted;
  const doneNow = granted[current];
  const seen = useRef({ key: current, done: doneNow });
  useEffect(() => {
    const before = seen.current;
    seen.current = { key: current, done: doneNow };
    if (before.key !== current || before.done || !doneNow) return;
    const t = setTimeout(() => {
      const next = ITEMS.find((it) => !latest.current[it.key])?.key;
      if (next) setCurrent(next);
    }, 1100);
    return () => clearTimeout(t);
  }, [current, doneNow]);

  const act = async (key: Key) => {
    setBusy(true);
    try {
      if (key === 'notifications') await turnOnNotifications();
      else if (key === 'microphone') {
        if (mic === 'denied') await native().openSystemSettings('microphone').catch(() => undefined);
        else setMic(await native().requestMicrophone().catch(() => 'unknown' as const));
      } else {
        const pane = key === 'accessibility' ? 'accessibility' : 'screen_recording';
        const s = await call('computer.requestPermissions', {}, { errorTitle: 'Could not ask macOS' });
        if (s) setState({ computer: s });
        if (!s || !s.permissions[key]) await call('computer.openSettings', { pane });
      }
    } finally {
      setBusy(false);
    }
  };

  const item = ITEMS.find((it) => it.key === current)!;
  const done = granted[current];
  const allDone = ITEMS.every((it) => granted[it.key]);
  return (
    <StepShell
      title="Let your bots help"
      body="Allow a few things so bots can see and use your apps. macOS asks once; you can change them any time."
      width="lg"
      onBack={onBack}
      actions={
        <>
          {!required ? <Button size="lg" variant="ghost" onClick={onNext}>Skip for now</Button> : null}
          <Button size="lg" variant="primary" iconRight={ArrowRight} disabled={!required} onClick={onNext}>Continue</Button>
        </>
      }
    >
      <div className="grid grid-cols-1 items-start gap-5 min-[880px]:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Card className="!rounded-[18px] overflow-hidden p-1.5">
            {ITEMS.map((it) => (
              <button
                key={it.key} type="button" onClick={() => setCurrent(it.key)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-[13px] px-3 py-2.5 text-left transition-colors duration-150 [@media(max-height:720px)]:py-1.5',
                  current === it.key ? 'bg-surface-2' : 'hover:bg-surface-2/60',
                )}
              >
                <span className="flex size-[32px] shrink-0 items-center justify-center rounded-[9px] text-white shadow-[inset_0_-1px_0_rgba(0,0,0,.12)]" style={{ background: it.tint }}>
                  <Icon icon={it.icon} size={17} strokeWidth={2} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-copy font-medium text-fg">
                    {it.title}
                    {it.optional && !granted[it.key] ? <span className="text-note font-normal text-muted">Optional</span> : null}
                  </span>
                  <span className="mt-px block truncate text-note text-muted">{it.why}</span>
                </span>
                <StatusMark on={granted[it.key]} />
              </button>
            ))}
          </Card>
          <p className="flex items-start gap-2 px-2 text-note leading-snug text-muted [@media(max-height:720px)]:hidden">
            <Icon icon={ShieldCheck} size={15} className="mt-px shrink-0 text-success" />
            <span>You stay in charge: bots ask before anything risky, and you can pause them any time.</span>
          </p>
        </div>

        <Card className="!rounded-[18px] overflow-hidden p-2">
          <div className="relative h-[256px] [@media(max-height:720px)]:h-[196px]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={current} className="absolute inset-0"
                initial={{ opacity: 0, scale: 0.985 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                transition={{ duration: 0.25, ease: [0.25, 1, 0.5, 1] }}
              >
                {current === 'accessibility' ? <SettingsPaneMock pane="accessibility" on={done} />
                  : current === 'screenRecording' ? <SettingsPaneMock pane="screen_recording" on={done} />
                    : current === 'notifications' ? <NotificationPromptMock on={done} />
                      : <MicPromptMock on={done} />}
              </motion.div>
            </AnimatePresence>
          </div>
          <div className="flex min-h-[64px] items-center gap-3 px-3 pt-2 pb-1 [@media(max-height:720px)]:min-h-[52px] [@media(max-height:720px)]:pt-1.5">
            <p className="min-w-0 flex-1 text-ui leading-snug text-fg-2">
              {done ? <Granted>{allDone ? 'Everything is allowed. You’re good to go.' : `${item.title} is on.`}</Granted> : HOW[current](mic)}
            </p>
            {!done ? (
              <Button size="md" variant={(required ? 'secondary' : 'primary') satisfies ButtonVariant} loading={busy} onClick={() => void act(current)}>
                {ACTION[current](mic, notify === 'not-asked')}
              </Button>
            ) : null}
          </div>
        </Card>
      </div>
    </StepShell>
  );
}

const HOW: Record<Key, (mic: MicAccess) => ReactNode> = {
  accessibility: () => <>In System Settings, turn on <b className="font-medium text-fg">AppuBot</b>.</>,
  screenRecording: () => <>Turn on <b className="font-medium text-fg">AppuBot</b>. If macOS asks to reopen it, say yes: you’ll be back right here.</>,
  notifications: () => <>macOS asks at the top right. Choose <b className="font-medium text-fg">Allow</b>.</>,
  microphone: (mic) => (mic === 'denied'
    ? <>Turned off before. Turn on <b className="font-medium text-fg">AppuBot</b> under Microphone.</>
    : <>macOS asks once. Choose <b className="font-medium text-fg">Allow</b>.</>),
};
const ACTION: Record<Key, (mic: MicAccess, notAsked: boolean) => string> = {
  accessibility: () => 'Open System Settings',
  screenRecording: () => 'Open System Settings',
  notifications: (_m, notAsked) => (notAsked ? 'Allow notifications' : 'Open System Settings'),
  microphone: (mic) => (mic === 'denied' ? 'Open System Settings' : 'Allow microphone'),
};

function Granted({ children }: { children: ReactNode }) {
  return <span className="flex items-center gap-1.5 font-medium text-success"><Icon icon={Check} size={15} strokeWidth={2.4} />{children}</span>;
}

/** a green check once given, an empty ring until then */
function StatusMark({ on }: { on: boolean }) {
  return (
    <TaskCheck checked={on} accent="var(--ab-success)" />
  );
}

/** Windows and Linux: nothing to grant; whether computer use reaches apps there, and notifications. */
function OtherPermissions({ onNext, onBack }: Nav) {
  const notify = useNotificationAccess();
  return (
    <StepShell
      title="Let your bots help"
      body={PLATFORM === 'win32' ? 'Windows needs no extra permissions. Here’s what bots use.' : 'Nothing to grant here. Here’s what bots use.'}
      onBack={onBack}
      actions={<Button size="lg" variant="primary" iconRight={ArrowRight} onClick={onNext}>Continue</Button>}
    >
      <div className="mx-auto flex max-w-[560px] flex-col gap-2.5">
        <PermissionRows />
        <Card className="!rounded-[14px] flex items-center gap-3 px-4 py-3">
          <span className={cn('squircle flex size-8 shrink-0 items-center justify-center rounded-control', notify === 'on' ? 'bg-success-soft text-success' : 'bg-surface-2 text-fg-2')}>
            <Icon icon={notify === 'on' ? Check : Bell} size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-copy font-medium text-fg">Notifications</span>
            <span className="mt-0.5 block text-note leading-snug text-muted">Lets AppuBot tell you when a bot is done or needs you.</span>
          </span>
          {notify === 'on' ? <Badge tone="success">Allowed</Badge>
            : notify === 'unknown' || notify === null || PLATFORM === 'linux' ? <Badge tone="neutral">Can’t tell</Badge>
              : <Button size="sm" variant="primary" onClick={() => void turnOnNotifications()}>{notify === 'not-asked' ? 'Allow' : 'Open Settings'}</Button>}
        </Card>
      </div>
    </StepShell>
  );
}
