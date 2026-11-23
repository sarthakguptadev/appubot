import { useEffect } from 'react';
import { Bell } from '../../../components/ui/icons';
import { Icon, cn } from '../../../components/ui';
import { COMPUTER_USE, IS_MAC, PLATFORM, THIS_MACHINE } from '../../../lib/platform';
import { macSettingsOf, useStore } from '../../../lib/store';
import { useCloudLacks } from '../../cloud/useCloudLacks';
import { CheckAgain, PermissionEnd, PermissionRows, refreshComputerStatus } from '../../computer/PermissionRows';
import { turnOnNotifications, useNotificationAccess } from '../../notifications/access';
import { PERMISSIONS_TITLE, settingAnchorId } from '../nav';
import { ROW_DIVIDERS, SETTINGS_CARD, SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SettingsGroup } from './shared';

/**
 * Everything AppuBot needs the system to allow, in Settings › About: computer use's grants (macOS) or what it reaches
 * apps through (Windows, Linux), and notifications. Always there, each with its state: Grant/Allow for what's missing,
 * Allowed for what's given. While something is missing, About's nav row carries a dot (`usePermissionsNeeded`).
 */

/** computer use can't run: macOS hasn't granted Accessibility or Screen Recording, or Windows/Linux can't reach apps */
function useComputerMissing(): boolean {
  return useStore((s) => COMPUTER_USE && !!s.computer?.available && (!s.computer.permissions.accessibility || !s.computer.permissions.screenRecording));
}

/** notifications are on in AppuBot but the OS hides them (or hasn't been asked) */
function useNotificationsMissing(): boolean {
  const access = useNotificationAccess();
  // this Mac's own switch: it is this Mac that shows them, also for an AppuBot computer's bots
  const wanted = useStore((s) => macSettingsOf(s)?.notifications.desktop ?? false);
  return wanted && (access === 'off' || access === 'not-asked');
}

/** Something `PermissionsGroup` lists is still missing (the Permissions nav row shows a dot). */
export function usePermissionsNeeded(): boolean {
  const computer = useComputerMissing();
  const notifications = useNotificationsMissing();
  // an AppuBot computer has no system permissions of its own to grant: there only this Mac's notifications count
  const lacks = useCloudLacks();
  return (computer && !lacks.permissions) || notifications;
}

const NOTIFY_WHY = 'Lets AppuBot tell you when a bot finishes, needs approval, or asks you something.';

function NotificationRow() {
  const access = useNotificationAccess();
  const wanted = useStore((s) => macSettingsOf(s)?.notifications.desktop ?? false);
  const ok = access === 'on';
  return (
    <div className={cn(SETTINGS_CARD, ROW_DIVIDERS)}>
      <div className={cn('flex items-center gap-3', SETTINGS_ROW)}>
        <Icon icon={Bell} size={17} className={cn('shrink-0', ok || access === 'unknown' || !wanted ? 'text-fg-2' : 'text-warning')} />
        <div className="min-w-0 flex-1">
          <div className="text-copy font-medium text-fg">Notifications</div>
          <div className={cn('mt-0.5', SETTINGS_ROW_DESCRIPTION)}>
            {!wanted ? 'Turned off in Settings › General.' : access === 'unknown' ? `${NOTIFY_WHY} ${THIS_MACHINE.replace(/^./, (c) => c.toUpperCase())} doesn’t say whether they show.` : NOTIFY_WHY}
          </div>
        </div>
        {ok ? <PermissionEnd state="ok" />
          : access === 'unknown' ? <PermissionEnd state="info" label="Can’t tell" />
            : PLATFORM === 'linux' ? <PermissionEnd state="missing" label="Off" />
              : <PermissionEnd state="missing" title="Notifications" action={access === 'not-asked' ? 'Allow' : 'Open'} onAction={() => void turnOnNotifications()} />}
      </div>
    </div>
  );
}

export function PermissionsGroup() {
  const computerMissing = useComputerMissing();
  const needed = usePermissionsNeeded();
  // with an AppuBot computer on screen the page is this Mac's notifications alone: it is this Mac that shows them
  // (the page used to be hidden there, so they couldn't be allowed without switching back)
  const lacks = useCloudLacks();
  useEffect(() => { void refreshComputerStatus(); }, []);

  const description = !needed ? 'Everything AppuBot needs is allowed.'
    : !COMPUTER_USE || lacks.permissions ? 'What AppuBot needs to tell you when bots finish or need you.'
      : IS_MAC ? 'Accessibility and Screen Recording let bots see and use your apps; notifications tell you when they finish or need you. Input Monitoring is only for Teach mode.'
        : PLATFORM === 'win32' ? 'Bots use your apps through Windows UI Automation and see them through screen capture (nothing to grant), and notifications tell you when they finish or need you.'
          : 'Bots use your apps through the accessibility bus (AT-SPI) and see them through X11 screen capture (nothing to grant), and notifications tell you when they finish or need you.';
  // two titled groups, like every other page: what bots reach the computer through, then notifications (the one
  // group, with the page's line, where computer use doesn't exist)
  if (!COMPUTER_USE || lacks.permissions) {
    return (
      <SettingsGroup title="Notifications" description={description} action={<CheckAgain />} bare>
        <NotificationRow />
      </SettingsGroup>
    );
  }
  return (
    <>
      <SettingsGroup title="Computer use" description={description} action={<CheckAgain />} bare>
        <PermissionRows settings />
        {computerMissing && IS_MAC ? (
          <p className="px-4 text-note leading-snug text-muted">Screen Recording takes effect after AppuBot restarts; macOS offers to do it.</p>
        ) : null}
      </SettingsGroup>
      <SettingsGroup title="Notifications" bare>
        <NotificationRow />
      </SettingsGroup>
    </>
  );
}

/** Settings › Permissions: the whole page (the search and the chat's notices land on its anchor). */
export function PermissionsSection() {
  return (
    <div id={settingAnchorId(PERMISSIONS_TITLE)} className="scroll-mt-24">
      <PermissionsGroup />
    </div>
  );
}
