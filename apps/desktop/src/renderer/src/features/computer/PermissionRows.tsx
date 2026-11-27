import { useEffect, useState } from 'react';
import { Accessibility, AlertCircle, Check, ChevronRight, Keyboard, MonitorUp, RefreshCw } from '../../components/ui/icons';
import { Button, Card, Icon, Spinner, cn } from '../../components/ui';
import { call } from '../../lib/actions';
import { IS_MAC, PLATFORM } from '../../lib/platform';
import { setState, useStore } from '../../lib/store';
import { refreshNotificationAccess } from '../notifications/access';
import { ROW_DIVIDERS, SETTINGS_CARD, SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION } from '../settings/sections/shared';

type Pane = 'accessibility' | 'screen_recording' | 'input_monitoring';
type Key = 'accessibility' | 'screenRecording' | 'inputMonitoring';
const ROWS: { key: Key; pane: Pane; title: string; why: string; icon: typeof Accessibility; optional?: boolean }[] = [
  { key: 'accessibility', pane: 'accessibility', title: 'Accessibility', why: 'Lets Appu click, type and read buttons in your apps, the same way you would.', icon: Accessibility },
  { key: 'screenRecording', pane: 'screen_recording', title: 'Screen Recording', why: 'Lets Appu see the screen so it knows where things are. Frames stay on this Mac unless you open Live view.', icon: MonitorUp },
  { key: 'inputMonitoring', pane: 'input_monitoring', title: 'Input Monitoring', why: 'Lets Teach mode follow your keystrokes while you show Appu a task.', icon: Keyboard, optional: true },
];

/**
 * Windows and Linux have nothing to grant: these rows say whether what computer use reaches apps through works there
 * (the status's `accessibility` and `screenRecording`, from Cua's health check), and what to do when it doesn't.
 */
const REACH_ROWS: { key: 'accessibility' | 'screenRecording'; title: string; why: string; fix: string; icon: typeof Accessibility }[] = PLATFORM === 'win32' ? [
  { key: 'accessibility', title: 'UI Automation', why: 'Lets Appu click, type and read buttons in your apps, the same way you would.', fix: 'Windows UI Automation isn’t answering. Apps running as administrator can’t be used by AppuBot.', icon: Accessibility },
  { key: 'screenRecording', title: 'Screen capture', why: 'Lets Appu see the screen so it knows where things are.', fix: 'Windows screen capture isn’t working right now.', icon: MonitorUp },
] : [
  { key: 'accessibility', title: 'Accessibility bus (AT-SPI)', why: 'Lets Appu click, type and read buttons in your apps, the same way you would.', fix: 'The accessibility bus isn’t answering: make sure at-spi2-core is installed and accessibility support is on in your desktop’s settings, then sign out and back in.', icon: Accessibility },
  { key: 'screenRecording', title: 'Screen capture', why: 'Lets Appu see the screen so it knows where things are.', fix: 'AppuBot sees windows through X11: sign in to an X11 session (on Wayland only apps running through XWayland can be seen).', icon: MonitorUp },
];

/** Re-checks the grants (the core asks macOS again), so a permission given in System Settings shows at once. */
export async function refreshComputerStatus(): Promise<void> {
  const s = await call('computer.status');
  if (s) setState({ computer: s });
}

/** Re-check whenever the window comes back, i.e. after granting in System Settings. */
export function useRecheckOnFocus(on = true): void {
  useEffect(() => {
    if (!on) return;
    const f = () => void refreshComputerStatus();
    window.addEventListener('focus', f);
    return () => window.removeEventListener('focus', f);
  }, [on]);
}

/** macOS: computer use can run (a backend is up) but Accessibility or Screen Recording isn't granted yet. */
export function useComputerAccessMissing(): boolean {
  return useStore((s) => IS_MAC && !!s.computer?.available && (!s.computer.permissions.accessibility || !s.computer.permissions.screenRecording));
}

/**
 * The end of a permission row, in the side panel's manner (its "Mac access" row; the owner's call, 2026-11-17: no
 * badges, no white Grant, no second Open Settings): what is given reads "✓ Allowed" quietly; what is missing is
 * "Allow ›", in the warning colour unless it's optional. Also Settings › Permissions' notifications row.
 */
export function PermissionEnd({ state, label = 'Allowed', action, onAction, busy, optional, title }: {
  state: 'ok' | 'missing' | 'info';
  /** what an `ok` or `info` row says */
  label?: string;
  /** a missing row's button */
  action?: string; onAction?: () => void; busy?: boolean; optional?: boolean;
  /** what it is, for the button's spoken name */
  title?: string;
}) {
  if (state === 'ok') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-ui text-muted">
        <Icon icon={Check} size={14} strokeWidth={2.25} className="text-success" />
        {label}
      </span>
    );
  }
  if (state === 'info' || !onAction) return <span className={cn('shrink-0 text-ui', state === 'missing' && !optional ? 'text-warning' : 'text-muted')}>{label}</span>;
  return (
    <button
      type="button"
      onClick={onAction}
      disabled={busy}
      aria-label={title ? `${title}: ${action ?? 'Allow'}` : undefined}
      className={cn(
        'ab-pill squircle -mr-2 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control-sm px-2 text-ui outline-none hover:bg-fg/5 focus-visible:shadow-[0_0_0_2px_var(--ab-ring)] disabled:opacity-60',
        optional ? 'text-fg-2' : 'text-warning',
      )}
    >
      {busy ? <Spinner size={13} /> : !optional ? <Icon icon={AlertCircle} size={14} className="shrink-0" /> : null}
      {action ?? 'Allow'}
      <Icon icon={ChevronRight} size={13} className="shrink-0 opacity-70" />
    </button>
  );
}

/** Asks the system again (a permission given in System Settings, notifications turned on there). */
export function CheckAgain() {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="xs" variant="ghost" icon={RefreshCw} loading={busy}
      onClick={async () => { setBusy(true); await Promise.all([refreshComputerStatus(), refreshNotificationAccess()]); setBusy(false); }}
    >
      Check again
    </Button>
  );
}

/** a row's icon: plain, no tile (the panel's rows have none), in the warning colour while a needed one is missing */
function RowIcon({ icon, tone }: { icon: typeof Accessibility; tone: 'ok' | 'missing' | 'quiet' }) {
  return <Icon icon={icon} size={17} className={cn('shrink-0', tone === 'missing' ? 'text-warning' : 'text-fg-2')} />;
}

/**
 * Accessibility / Screen Recording / Input Monitoring rows with their state at the end (macOS). Windows and Linux:
 * what computer use reaches apps through, working or not, with what to do.
 */
export function PermissionRows({ className, dense, settings }: {
  className?: string; dense?: boolean;
  /** drawn as a settings card (Settings › Permissions, whose group carries Check again) instead of a glass card */
  settings?: boolean;
}) {
  const perms = useStore((s) => s.computer?.permissions);
  const [busy, setBusy] = useState<Pane | null>(null);
  useRecheckOnFocus(IS_MAC);
  // a plain div in settings: the glass card's own fill and border would win over the settings card's
  const Shell = settings ? 'div' : Card;
  const shell = settings ? cn(SETTINGS_CARD, ROW_DIVIDERS) : '!rounded-[14px] overflow-hidden [&>*+*]:shadow-[inset_0_.5px_0_var(--ab-hairline)]';
  const row = cn('flex items-center gap-3', dense || settings ? SETTINGS_ROW : 'px-4 py-3');
  const recheck = settings ? null : <div className="flex justify-end"><CheckAgain /></div>;
  const why = settings ? cn('mt-0.5', SETTINGS_ROW_DESCRIPTION) : 'mt-0.5 text-note leading-snug text-muted';

  if (!IS_MAC) {
    return (
      <div className={cn('flex flex-col gap-1.5', className)}>
        <Shell className={shell}>
          {REACH_ROWS.map((r) => {
            const ok = perms?.[r.key] !== false;
            return (
              <div key={r.key} className={row}>
                <RowIcon icon={r.icon} tone={ok ? 'ok' : 'missing'} />
                <div className="min-w-0 flex-1">
                  <div className="text-copy font-medium text-fg">{r.title}</div>
                  {!dense ? <div className={why}>{ok ? r.why : r.fix}</div> : null}
                </div>
                <PermissionEnd state={ok ? 'ok' : 'missing'} label={ok ? 'Working' : 'Not working'} />
              </div>
            );
          })}
        </Shell>
        {recheck}
      </div>
    );
  }

  const grant = async (pane: Pane, key: Key) => {
    setBusy(pane);
    if (pane === 'input_monitoring') {
      await call('computer.openSettings', { pane });
    } else {
      const s = await call('computer.requestPermissions', {}, { errorTitle: 'Could not request permission' });
      if (s) setState({ computer: s });
      if (!s || !s.permissions[key]) await call('computer.openSettings', { pane });
    }
    setBusy(null);
  };

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Shell className={shell}>
        {ROWS.map((r) => {
          const state = perms?.[r.key];
          const ok = state === true;
          // the gateway may not report Input Monitoring; then it is just a shortcut to System Settings
          const unknown = state === undefined && r.optional;
          return (
            <div key={r.key} className={row}>
              <RowIcon icon={r.icon} tone={ok ? 'ok' : r.optional ? 'quiet' : 'missing'} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-copy font-medium text-fg">
                  {r.title}
                  {r.optional && !ok ? <span className="text-note font-normal text-muted">Optional</span> : null}
                </div>
                {!dense ? <div className={why}>{r.why}</div> : null}
              </div>
              <PermissionEnd
                state={ok ? 'ok' : 'missing'} optional={r.optional} title={r.title}
                action={unknown ? 'Open' : 'Allow'} busy={busy === r.pane} onAction={() => void grant(r.pane, r.key)}
              />
            </div>
          );
        })}
      </Shell>
      {recheck}
    </div>
  );
}
