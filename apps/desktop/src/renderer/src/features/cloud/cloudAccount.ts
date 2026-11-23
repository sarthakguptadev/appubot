/**
 * The window's side of AppuBot Cloud's account: the Mac's `cloudAccount.*` methods (protocol cloud.ts
 * `CloudGatewayMethods`, always on this Mac's own gateway, never the cloud's), the view they answer kept in a small
 * store, and the actions Settings › Cloud and the switcher take (sign in, buy, billing, start, desktop, export,
 * delete). The browser does the paying and signing in; the app only opens the links the Mac's core hands it.
 */
import { create } from 'zustand';
import { computerDisplayName } from '@appubot/chat-core';
import type { CloudAccountView, CloudBackupList, CloudConnection, CloudRepairKind, CloudRepairResponse, CloudDesktopLink, CloudAccessLog, CloudGatewayMethods, CloudInterval, CloudPlanChangePreview, CloudPlanChangeResponse, CloudPlanId, CloudTeam, CloudTeamLogins, CloudTeamRole, MethodParams, MethodResult } from '@appubot/protocol';
import { GatewayError, errorMessage, localGateway, type CallOptions } from '../../lib/gateway';
import { native } from '../../lib/native';
import { pushToast, ui } from '../../lib/store';
import { hasPersonalPlan } from './cloudView';
import { madeRoomNotice } from './devicesFull';
import { YOUR_COMPUTER_CAP, teamComputerLong } from './names';
import { PAIRED_DEVICES_MAX, type CloudPairedDevice } from '@appubot/protocol';

export type CloudMethod = keyof typeof CloudGatewayMethods;

/** One of the Mac's `cloudAccount.*` calls: always this Mac's own gateway, whichever computer is on screen. */
export function cloudCall<K extends CloudMethod>(method: K, params: MethodParams<K>, opts?: CallOptions): Promise<MethodResult<K>> {
  return localGateway().call(method, params, opts);
}

/**
 * What the window needs to open the cloud computer's end-to-end channel as this Mac's owner device (its public
 * address, its pinned key, the device token the Mac's pairing got); null while this Mac isn't paired with it.
 */
export function cloudConnection(team?: string): Promise<CloudConnection | null> {
  return cloudCall('cloudAccount.connection', target(team));
}

/** a method's `team` param: absent for the person's own cloud computer */
const target = (team?: string): { team?: string } => (team ? { team } : {});
/** a busy key per computer, so one team's spinner doesn't spin another's */
export const busyKey = (key: string, team?: string): string => (team ? `${key}:${team}` : key);

export interface CloudStore {
  view: CloudAccountView | null;
  /** false: this Mac's AppuBot has no cloud account (`unknown_method`): nothing about the cloud shows */
  supported: boolean | null;
  loading: boolean;
  /** actions in flight, by name (their buttons spin) */
  busy: Partial<Record<string, true>>;
}

export const useCloud = create<CloudStore>()(() => ({ view: null, supported: null, loading: false, busy: {} }));

const setBusy = (k: string, on: boolean): void => useCloud.setState((s) => {
  const busy = { ...s.busy };
  if (on) busy[k] = true; else delete busy[k];
  return { busy };
});

/**
 * Reads the view. The Mac answers from what it read last and reads the backend only when that is older than a minute
 * (`refresh`: a few seconds, for a page watching something in progress); asks at once share one read. Reading never
 * wakes the computer.
 */
export async function loadCloud(refresh = false): Promise<CloudAccountView | null> {
  useCloud.setState({ loading: true });
  try {
    const view = await cloudCall('cloudAccount.status', { refresh }, { timeoutMs: 25_000 });
    useCloud.setState({ view, supported: true, loading: false });
    return view;
  } catch (e) {
    const unknown = e instanceof GatewayError && e.code === 'unknown_method';
    useCloud.setState({ loading: false, ...(unknown ? { supported: false, view: null } : {}) });
    return null;
  }
}

/**
 * The Mac's `cloudAccount.updated` events keep the view; a reconnect and the window coming to the front ask for it
 * again (the Mac reads the backend only when its view is over a minute old). Call once with the Mac's client.
 */
export function watchCloud(): () => void {
  const g = localGateway();
  const offEvents = g.onAny((event, payload) => {
    const name = event as string;
    if (name === 'cloudAccount.updated') useCloud.setState({ view: payload as CloudAccountView, supported: true });
    else if (name === 'hello') void loadCloud();
  });
  const onFocus = (): void => { if (useCloud.getState().view?.signedIn) void loadCloud(); };
  window.addEventListener('focus', onFocus);
  void loadCloud();
  return () => { offEvents(); window.removeEventListener('focus', onFocus); };
}

/** Runs one action with its button spinning; errors become a toast. */
async function act<T>(key: string, errorTitle: string, fn: () => Promise<T>): Promise<T | undefined> {
  setBusy(key, true);
  try {
    return await fn();
  } catch (e) {
    pushToast({ title: errorTitle, body: errorMessage(e), level: 'error' });
    return undefined;
  } finally {
    setBusy(key, false);
  }
}

const take = (view: CloudAccountView | undefined): void => { if (view) useCloud.setState({ view, supported: true }); };

/** The browser sign-in (PKCE): the Mac opens the page; main finishes it when the browser comes back (`appubot://cloud/signed-in`, electron/cloudLinks.ts). */
export function signInToCloud(): Promise<unknown> {
  return act('signIn', 'Couldn’t start signing in', () => cloudCall('cloudAccount.signIn', {}));
}

export async function signOutOfCloud(): Promise<void> {
  const ok = await act('signOut', 'Couldn’t sign out', () => cloudCall('cloudAccount.signOut', {}));
  if (ok) await loadCloud();
}

/**
 * Opens Dodo's checkout for a plan in the browser; the return link (`appubot://cloud/checkout-done`) reads the view
 * again. A Work plan takes the team's size (`members`): the buyer becomes the team's first admin.
 */
export async function buyCloud(plan: CloudPlanId, interval: CloudInterval, members?: number): Promise<void> {
  // signed out: sign in first, and the checkout opens once the sign-in lands (see `afterSignIn`)
  if (!useCloud.getState().view?.signedIn) {
    buyAfterSignIn = { plan, interval, members, until: Date.now() + BUY_AFTER_SIGN_IN_MS };
    await signInToCloud();
    return;
  }
  const r = await act('checkout', 'Couldn’t open the checkout', () => cloudCall('cloudAccount.checkout', { plan, interval, ...(members ? { members } : {}) }));
  if (r) await native().openExternal(r.checkoutUrl);
}

/** a plan picked while signed out waits this long for the browser sign-in to come back */
const BUY_AFTER_SIGN_IN_MS = 15 * 60_000;
let buyAfterSignIn: { plan: CloudPlanId; interval: CloudInterval; members?: number; until: number } | null = null;

// the sign-in a plan pick started came back: open that plan's checkout, unless the account already has a plan of its own
useCloud.subscribe((st, before) => {
  if (!buyAfterSignIn || !st.view?.signedIn || before.view?.signedIn) return;
  const pick = buyAfterSignIn;
  buyAfterSignIn = null;
  if (Date.now() > pick.until || hasPersonalPlan(st.view)) return;
  void buyCloud(pick.plan, pick.interval, pick.members);
});

/** The web account page (the plan picker, Change plan; a team's page for `team`) in the browser: plan changes are made there. */
export async function openAccountPage(team?: string): Promise<void> {
  const r = await act(busyKey('accountPage', team), 'Couldn’t open your account page', () => cloudCall('cloudAccount.accountPage', target(team)));
  if (r) await native().openExternal(r.url);
}

/** What a plan change would do (the charge now, when it applies, the computer's size; a team's seats). */
export function previewPlanChange(plan: CloudPlanId, interval: CloudInterval, team?: string, seats?: number): Promise<CloudPlanChangePreview | undefined> {
  return act(busyKey('previewPlanChange', team), 'Couldn’t read the plan change', () => cloudCall('cloudAccount.previewPlanChange', { plan, interval, ...target(team), ...(seats ? { seats } : {}) }));
}

/** Change the plan: an upgrade (or more seats) applies now, a downgrade (or fewer seats) at the period's end. */
export async function changePlan(plan: CloudPlanId, interval: CloudInterval, team?: string, seats?: number): Promise<CloudPlanChangeResponse | undefined> {
  const r = await act(busyKey('changePlan', team), team && seats ? 'Couldn’t change the seats' : 'Couldn’t change the plan', () => cloudCall('cloudAccount.changePlan', { plan, interval, ...target(team), ...(seats ? { seats } : {}) }, { timeoutMs: 60_000 }));
  if (r) await loadCloud();
  return r;
}

/** Call a scheduled downgrade off. */
export async function cancelPlanChange(team?: string): Promise<boolean> {
  const r = await act(busyKey('cancelPlanChange', team), 'Couldn’t keep the plan', () => cloudCall('cloudAccount.cancelPlanChange', target(team)));
  if (r) await loadCloud();
  return !!r;
}

/** Dodo's customer portal: card, invoices, cancel or keep the plan (a team's: admins only). */
export async function openBilling(team?: string): Promise<void> {
  const r = await act(busyKey('portal', team), 'Couldn’t open billing', () => cloudCall('cloudAccount.portal', target(team)));
  if (r) await native().openExternal(r.url);
}

/** puts a computer the backend answered into the view (the person's own, or a team's) */
function takeComputer(computer: CloudAccountView['computer'], team?: string): void {
  if (!computer) return;
  useCloud.setState((s) => {
    if (!s.view) return {};
    if (!team) return { view: { ...s.view, computer } };
    return { view: { ...s.view, teams: (s.view.teams ?? []).map((t) => (t.team.id === team ? { ...t, computer } : t)) } };
  });
}

/** Wakes the computer now (refused on hold or after the plan ended: the toast says why). */
export async function startCloud(team?: string): Promise<void> {
  takeComputer(await act(busyKey('start', team), 'Couldn’t start your AppuBot computer', () => cloudCall('cloudAccount.start', target(team))), team);
}

/** A 60 s signed link to the cloud's desktop (Open desktop). */
export function desktopLink(team?: string): Promise<CloudDesktopLink | undefined> {
  return act(busyKey('desktop', team), 'Couldn’t open its desktop', () => cloudCall('cloudAccount.desktopLink', target(team)));
}

export function accessLog(team?: string): Promise<CloudAccessLog | undefined> {
  return act(busyKey('accessLog', team), 'Couldn’t read the access log', () => cloudCall('cloudAccount.accessLog', target(team)));
}

/** Pairs this Mac with a cloud computer (the core does it through the backend; a team's as this person). */
/**
 * `'full'`: the cloud computer already keeps the most devices it allows and refused this one. The dialog that lists
 * them is open (one is removed there through the account, since this computer can't reach the cloud computer's own
 * Settings › Devices), so the caller says nothing more.
 */
export async function pairCloud(team?: string): Promise<boolean | 'full'> {
  const key = busyKey('pair', team);
  setBusy(key, true);
  let replaced: CloudPairedDevice[] = [];
  try {
    replaced = (await cloudCall('cloudAccount.pair', target(team), { timeoutMs: 200_000 })).replaced ?? [];
  } catch (e) {
    if (e instanceof GatewayError && e.code === 'device_limit') {
      const teamName = team ? useCloud.getState().view?.teams?.find((t) => t.team.id === team)?.team.name : undefined;
      ui.openModal({ kind: 'cloud-devices', message: errorMessage(e), ...(team ? { team } : {}), ...(teamName ? { teamName } : {}) });
      return 'full';
    }
    pushToast({ title: team ? 'Couldn’t connect to your team’s AppuBot computer' : 'Couldn’t connect to your AppuBot computer', body: errorMessage(e), level: 'error' });
    return false;
  } finally {
    setBusy(key, false);
  }
  // the computer was full and made room: the device unused longest went, and its owner is told which
  if (replaced.length) {
    const teamName = team ? useCloud.getState().view?.teams?.find((t) => t.team.id === team)?.team.name : undefined;
    pushToast({ ...madeRoomNotice(replaced, PAIRED_DEVICES_MAX, team ? teamComputerLong(teamName) : YOUR_COMPUTER_CAP, Date.now()), level: 'info' });
  }
  await loadCloud();
  return true;
}

/** Fix your computer: the saved copies Reset can go back to, newest first. */
export function loadBackups(team?: string): Promise<CloudBackupList | undefined> {
  return act(busyKey('backups', team), 'Couldn’t read the saved copies', () => cloudCall('cloudAccount.backups', target(team), { timeoutMs: 30_000 }));
}

/**
 * Fix your computer: Update, Recover or Reset. `requestId` is the dialog's own (a retry of the same press is the same
 * repair on the backend). A computer already on the newest version answers no repair and a line, shown as a toast;
 * otherwise the view is read again so the progress shows at once.
 */
export async function repairComputer(req: { kind: CloudRepairKind; backupId?: string; confirm?: 'reset'; requestId: string }, team?: string): Promise<CloudRepairResponse | undefined> {
  const r = await act(busyKey('repair', team), 'Couldn’t start fixing your computer', () => cloudCall('cloudAccount.repair', { ...req, ...target(team) }, { timeoutMs: 60_000 }));
  if (r && !r.repair && r.message) pushToast({ title: 'Nothing to update', body: r.message, level: 'info' });
  if (r?.repair) await loadCloud();
  return r;
}

/* ---------- teams (Work plans) ---------- */

/** puts a team the backend answered into the view */
function takeTeam(team: CloudTeam | undefined): void {
  if (!team) return;
  useCloud.setState((s) => {
    if (!s.view) return {};
    const teams = s.view.teams ?? [];
    const has = teams.some((t) => t.team.id === team.id);
    return { view: { ...s.view, teams: has ? teams.map((t) => (t.team.id === team.id ? { ...t, team } : t)) : [...teams, { team, paired: false }] } };
  });
}

/** A team, fresh from the backend. */
export async function loadTeam(team: string): Promise<CloudTeam | undefined> {
  const t = await act(busyKey('team', team), 'Couldn’t read the team', () => cloudCall('cloudAccount.team', { team }));
  takeTeam(t);
  return t;
}

/** Admins: invite someone by email (a free seat is needed). */
export async function inviteToTeam(team: string, email: string, role: CloudTeamRole = 'member'): Promise<boolean> {
  const t = await act(busyKey('invite', team), 'Couldn’t send the invite', () => cloudCall('cloudAccount.invite', { team, email, role }));
  takeTeam(t);
  if (t) pushToast({ title: 'Invite sent', body: `${email} gets an email with a link to join.`, level: 'success' });
  return !!t;
}

export async function resendInvite(team: string, inviteId: string): Promise<void> {
  const t = await act(busyKey(`resend-${inviteId}`, team), 'Couldn’t resend the invite', () => cloudCall('cloudAccount.resendInvite', { team, inviteId }));
  takeTeam(t);
  if (t) pushToast({ title: 'Invite sent again', level: 'success' });
}

/** Admins: take an invite back; `dropSeat` also lowers the seats by one at the renewal. */
export async function revokeInvite(team: string, inviteId: string, dropSeat = false): Promise<boolean> {
  const t = await act(busyKey(`revoke-${inviteId}`, team), 'Couldn’t take the invite back', () => cloudCall('cloudAccount.revokeInvite', { team, inviteId, ...(dropSeat ? { dropSeat: true } : {}) }));
  takeTeam(t);
  return !!t;
}

/** Admins: make someone an admin or a member (a team always keeps one admin). */
export async function setMemberRole(team: string, memberId: string, role: CloudTeamRole): Promise<void> {
  takeTeam(await act(busyKey(`role-${memberId}`, team), 'Couldn’t change the role', () => cloudCall('cloudAccount.setMemberRole', { team, memberId, role })));
}

/** Admins: remove someone; their devices lose the team's computer at once. `dropSeat`: their seat goes at the renewal. */
export async function removeMember(team: string, memberId: string, dropSeat = false): Promise<boolean> {
  const t = await act(busyKey(`remove-${memberId}`, team), 'Couldn’t remove them', () => cloudCall('cloudAccount.removeMember', { team, memberId, ...(dropSeat ? { dropSeat: true } : {}) }));
  takeTeam(t);
  return !!t;
}

/** Admins: how the team's computer signs agents in: each person's own logins, or one shared set (§6.11). */
export async function setTeamLogins(team: string, logins: CloudTeamLogins): Promise<boolean> {
  const t = await act(busyKey('logins', team), 'Couldn’t change the team’s logins', () => cloudCall('cloudAccount.setTeamLogins', { team, logins }));
  takeTeam(t);
  return !!t;
}

export async function renameTeam(team: string, name: string): Promise<boolean> {
  const t = await act(busyKey('rename', team), 'Couldn’t rename the team', () => cloudCall('cloudAccount.renameTeam', { team, name }));
  takeTeam(t);
  return !!t;
}

/** Leave a team (the last admin can't: the toast says so). */
export async function leaveTeam(team: string): Promise<boolean> {
  const r = await act(busyKey('leave', team), 'Couldn’t leave the team', () => cloudCall('cloudAccount.leaveTeam', { team }));
  if (r) await loadCloud();
  return !!r;
}

/** Accept an invite addressed to this person's email: the team's computer joins the switcher. */
export async function acceptInvite(inviteId: string): Promise<boolean> {
  const t = await act(busyKey(`accept-${inviteId}`), 'Couldn’t join the team', () => cloudCall('cloudAccount.acceptInvite', { inviteId }));
  if (t) { pushToast({ title: `You joined ${t.name}`, body: 'It’s in the sidebar’s computer menu.', level: 'success' }); await loadCloud(); }
  return !!t;
}

export async function declineInvite(inviteId: string): Promise<void> {
  const r = await act(busyKey(`decline-${inviteId}`), 'Couldn’t decline the invite', () => cloudCall('cloudAccount.declineInvite', { inviteId }));
  if (r) await loadCloud();
}

/** Which Fix your computer confirmation opens by itself (once); the dev mock sets it from the URL (`&fixdialog=reset`). */
export const fixStart: { kind?: CloudRepairKind } = {};

/** Where the paywall opens (Personal or Work, the interval, the team's size); the dev mock sets it from the URL. */
export const paywallStart: { kind?: 'personal' | 'work'; members?: number; interval?: CloudInterval } = {};
