/**
 * This Mac's own app state, whichever computer is on screen. The store's `settings` and `system` are the screen
 * computer's, so with an AppuBot computer on screen everything that belongs to this app (its own update, the stopped
 * version screen, its colour scheme, its notifications, opening at login) used to read the wrong computer or was
 * hidden: the app must update, notify and start at login whether its bots work here or in the cloud.
 *
 * `watchThisMac` follows this Mac's hello, `settings.updated` and `system.updated` from its own gateway (they come
 * whether or not this Mac is on screen) into the store's `macSettings` / `macSystem`; `useMacSetting` / `useMacSystem`
 * read them; `updateMacSettings` and `macCall` write and call there.
 */
import type { MethodName, MethodParams, MethodResult, Settings, Snapshot, SystemInfo } from '@appubot/protocol';
import { toastCallError } from './actions';
import { updateSettings } from './choices';
import { activeComputer, localGateway, onActiveComputer, type GatewayLike } from './gateway';
import { getState, macSettingsOf, macSystemOf, setState, useStore } from './store';

/** Follows this Mac's own settings and system info. Mount once, after the gateway is up. */
export function watchThisMac(): () => void {
  let mac: GatewayLike;
  try { mac = localGateway(); } catch { return () => undefined; }
  const take = (snap: Pick<Snapshot, 'settings' | 'system'> | null | undefined) => {
    if (snap) setState({ ...(snap.settings ? { macSettings: snap.settings } : {}), ...(snap.system ? { macSystem: snap.system } : {}) });
  };
  take(mac.snapshot);
  const offEvents = mac.onAny((event, payload) => {
    if (event === 'settings.updated') setState({ macSettings: payload as Settings });
    else if (event === 'system.updated') setState({ macSystem: payload as SystemInfo });
    else if ((event as string) === 'hello') take(payload as Snapshot | null);
  });
  // which computer is on screen decides where `macSettingsOf` reads: selectors look again on a switch
  const offSwitch = onActiveComputer(() => setState((s) => ({ macSettings: s.macSettings ? { ...s.macSettings } : s.macSettings })));
  if (!getState().macSettings) void mac.call('settings.get').then((s) => setState({ macSettings: s })).catch(() => undefined);
  if (!getState().macSystem) void mac.call('system.info').then((s) => setState({ macSystem: s })).catch(() => undefined);
  return () => { offEvents(); offSwitch(); };
}

/** One of this Mac's own settings (pick a plain value, not an object: a new object every read never settles). */
export function useMacSetting<T>(pick: (s: Settings) => T, fallback: T): T {
  return useStore((s) => { const m = macSettingsOf(s); return m ? pick(m) : fallback; });
}

/** A plain value from this Mac's own system info. */
export function useMacSystem<T>(pick: (s: SystemInfo) => T, fallback: T): T {
  return useStore((s) => { const m = macSystemOf(s); return m ? pick(m) : fallback; });
}

/** This app's own update status (this Mac's, also with an AppuBot computer on screen). */
export function useAppUpdate(): SystemInfo['update'] {
  return useStore((s) => macSystemOf(s)?.update);
}

/**
 * Saves one of this Mac's own settings. With this Mac on screen it is the ordinary, ordered save; with another
 * computer on screen it goes to this Mac's own gateway, shown at once and put back with a toast if refused. Nested
 * objects (notifications…) must be sent whole, built from this Mac's settings.
 */
export async function updateMacSettings(patch: Partial<Settings>): Promise<Settings | undefined> {
  if (activeComputer() === 'local') return updateSettings(patch);
  const was = getState().macSettings;
  if (was) setState({ macSettings: { ...was, ...patch } });
  try {
    const next = await localGateway().call('settings.update', patch);
    setState({ macSettings: next });
    return next;
  } catch (e) {
    setState({ macSettings: was });
    toastCallError(e, 'Could not save settings', 'local');
    return undefined;
  }
}

/** A call to this Mac's own gateway with an error toast (`call` goes to the computer on screen). */
export async function macCall<M extends MethodName>(method: M, params?: MethodParams<M>, opts: { errorTitle?: string; timeoutMs?: number } = {}): Promise<MethodResult<M> | undefined> {
  try {
    return await localGateway().call(method, params, opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : undefined);
  } catch (e) {
    toastCallError(e, opts.errorTitle, 'local');
    return undefined;
  }
}

/** Reads this Mac's system info afresh (after asking it to check for an update). */
export async function refreshMacSystem(): Promise<void> {
  const info = await macCall('system.info', {}, { errorTitle: 'Could not load system info' });
  if (!info) return;
  setState({ macSystem: info, ...(activeComputer() === 'local' ? { system: info } : {}) });
}
