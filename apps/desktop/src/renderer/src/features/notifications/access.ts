import { useEffect } from 'react';
import { getState, macSettingsOf, setState, useStore } from '../../lib/store';
import { localGateway } from '../../lib/gateway';
import { macCall } from '../../lib/thisMac';

/**
 * Reads afresh whether the OS shows AppuBot's notifications (the user may have just changed it in System Settings).
 * It is this Mac that shows them, also for an AppuBot computer's bots, so this Mac's own gateway is asked whichever
 * computer is on screen (the cloud computer's answer is always "can't tell").
 */
export async function refreshNotificationAccess(): Promise<void> {
  let r;
  try { r = await localGateway().call('system.notificationAccess', {}); } catch { return; }
  if (r) setState({ notificationAccess: r.access });
}

/** while macOS hasn't been answered, how often to look again: its prompt is answered without the window losing focus */
const RECHECK_MS = 3000;

/** The OS's answer, read on mount, whenever the window comes back to the front, and every few seconds while not asked yet. */
export function useNotificationAccess() {
  const access = useStore((s) => s.notificationAccess);
  useEffect(() => {
    void refreshNotificationAccess();
    const f = () => void refreshNotificationAccess();
    window.addEventListener('focus', f);
    return () => window.removeEventListener('focus', f);
  }, []);
  const waiting = access === 'not-asked';
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void refreshNotificationAccess(), RECHECK_MS);
    return () => clearInterval(t);
  }, [waiting]);
  return access;
}

/** The OS hides them although AppuBot's own switch is on (`unknown`, e.g. Linux, never counts). */
export function useNotificationsBlocked(): boolean {
  const access = useNotificationAccess();
  const wanted = useStore((s) => macSettingsOf(s)?.notifications.desktop ?? false);
  return wanted && (access === 'off' || access === 'not-asked');
}

/**
 * Turn them on: while macOS hasn't asked yet, its own prompt; once the user said no (or on Windows), System Settings ›
 * Notifications › AppuBot, where they flip it themselves.
 */
export async function turnOnNotifications(): Promise<void> {
  const access = getState().notificationAccess;
  if (access === 'not-asked') {
    const r = await macCall('system.requestNotifications', {}, { errorTitle: 'Could not ask for notifications' });
    if (r) setState({ notificationAccess: r.access });
    if (r?.access === 'on') return;
  }
  await macCall('system.openNotificationSettings', {}, { errorTitle: 'Could not open notification settings' });
}
