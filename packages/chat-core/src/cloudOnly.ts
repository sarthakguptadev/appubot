/**
 * "Only in the cloud" (2026-11-15, the owner's ask: "User should be able to disable laptop use and use only cloud"):
 * someone with an AppuBot computer they can work on, and this Mac or PC, may stop using this one for bots. The truth is
 * this computer's `settings.cloudOnly`; these pure rules say when it shows, when it holds and what follows from it, for
 * the Mac's core (its routines and Telegram bots stop) and its window (the switchers, where a launch lands) alike.
 *
 * The one rule against locking anyone out: the choice is in effect only while a cloud computer can work. Signed out, a
 * plan ended, on hold, kept-until, suspended, a team left or sold out, and this computer is a place bots work again by
 * itself, with nothing to undo; the choice stays saved and holds again once a cloud computer can work. Settings ›
 * Account always shows it while it is on, so it can be turned off from either computer.
 *
 * The account's phase (`cloudPhase`, `hasComputer`, `canWork`, `teamAsView`) lives here too, so the core reads a
 * computer as the window does; the desktop's `features/cloud/cloudView.ts` re-exports it.
 */
import type { CloudAccountView, CloudTeamView } from '@appubot/protocol';

export type CloudPhase =
  /** this Mac's AppuBot predates the cloud (`unknown_method`), or its status hasn't been read yet */
  | 'unknown'
  | 'signed-out'
  /** signed in, no subscription yet: what you get + a plan to pick */
  | 'no-plan'
  /** signed in, no plan, and sign-ups are closed */
  | 'sold-out'
  | 'provisioning' | 'running' | 'asleep' | 'waking' | 'stopped'
  /** the renewal failed: past due (still running, grace) */
  | 'past-due'
  /** the grace ended: stopped, data kept */
  | 'on-hold'
  /** the user asked to end it at the period's end: still running until then */
  | 'ending'
  | 'export-only' | 'suspended' | 'failed' | 'deleted';

/** One phase for the whole account: the computer's state first where it says more than the subscription. */
export function cloudPhase(v: CloudAccountView | null | undefined, now = Date.now()): CloudPhase {
  if (!v) return 'unknown';
  if (!v.signedIn) return 'signed-out';
  const a = v.account;
  const c = v.computer;
  const state = c?.state ?? 'none';
  if (state === 'none' || !a?.subscription) {
    if (state === 'provisioning') return 'provisioning';
    if (a?.status === 'ended' || a?.status === 'deleted') return a.exportUntil && a.exportUntil > now ? 'export-only' : 'no-plan';
    return a && !a.signupsOpen ? 'sold-out' : 'no-plan';
  }
  switch (state) {
    case 'on-hold': case 'export-only': case 'suspended': case 'failed': case 'deleted': case 'provisioning':
      return state;
    default: break;
  }
  if (a.subscription.status === 'past_due') return 'past-due';
  if (a.subscription.status === 'on_hold') return 'on-hold';
  if (a.subscription.cancelAtPeriodEnd) return 'ending';
  return state; // running / asleep / waking / stopped
}

/** The computer exists (paid for and set up, in any state but gone): the switcher shows. */
export function hasComputer(v: CloudAccountView | null | undefined): boolean {
  const p = cloudPhase(v);
  return !!v?.computer?.computer && !['unknown', 'signed-out', 'no-plan', 'sold-out', 'provisioning', 'deleted', 'failed'].includes(p);
}

/** Chats on the cloud can run (it may be asleep: a message wakes it). */
export function canWork(p: CloudPhase): boolean {
  return p === 'running' || p === 'asleep' || p === 'waking' || p === 'stopped' || p === 'past-due' || p === 'ending';
}

/** A team as an account view, so `cloudPhase` and the rest read its computer and plan as they read the person's own. */
export function teamAsView(v: CloudAccountView, t: CloudTeamView): CloudAccountView {
  const team = t.team;
  return {
    signedIn: true, paired: t.paired,
    account: {
      id: team.id, email: v.account?.email ?? 'team@appubot.com', createdAt: 0, signupsOpen: true,
      ...(team.status ? { status: team.status } : {}), ...(team.plan ? { plan: team.plan } : {}), ...(team.interval ? { interval: team.interval } : {}),
      ...(team.subscription ? { subscription: team.subscription } : {}),
    },
    ...(t.computer ? { computer: t.computer } : {}),
    ...(v.catalog ? { catalog: v.catalog } : {}),
  };
}

/* ------------------------------------------------------------------ the choice */

/** An AppuBot computer: the person's own (no team) or a team's. */
export interface CloudSpot { team?: string }

/** The AppuBot computers the person can work on now (set up, and not on hold, ended or suspended), their own first. */
export function workingClouds(v: CloudAccountView | null | undefined): CloudSpot[] {
  if (!v?.signedIn) return [];
  const out: CloudSpot[] = [];
  if (hasComputer(v) && canWork(cloudPhase(v))) out.push({});
  for (const t of v.teams ?? []) {
    const tv = teamAsView(v, t);
    if (hasComputer(tv) && canWork(cloudPhase(tv))) out.push({ team: t.team.id });
  }
  return out;
}

export interface CloudOnlyState {
  /** this computer's `settings.cloudOnly` */
  chosen: boolean;
  /** this computer is an AppuBot computer itself: the choice is a Mac's or PC's, never the cloud's */
  cloud?: boolean;
  /** the cloud computers the person can work on now (`workingClouds`) */
  usable: readonly CloudSpot[];
}

/** Settings shows the choice: there is a cloud computer to work on, or the choice is on (so it can always be turned off). */
export function cloudOnlyOffered(s: CloudOnlyState): boolean {
  return !s.cloud && (s.usable.length > 0 || s.chosen);
}

/** The choice holds: chosen here, and a cloud computer can work. Otherwise this computer works as before. */
export function cloudOnlyInEffect(s: CloudOnlyState): boolean {
  return !s.cloud && s.chosen && s.usable.length > 0;
}

/**
 * Whether the computer switchers list this computer. Always while it is on screen or the choice doesn't hold; hidden
 * while it holds, unless the cloud computer on screen has been out of reach for a while (`late`: the same 30 s the app
 * keeps quiet about a connection), so this computer is never a dead end.
 */
export function listsThisComputer(o: { inEffect: boolean; onThis: boolean; late: boolean }): boolean {
  return !o.inEffect || o.onThis || o.late;
}

/** The computer kept as the one used last (`local`, `cloud`, `cloud:<team>`, desktop `appubot:lastComputer`): a cloud one, else null. */
export function savedCloudComputer(saved: string | null | undefined): CloudSpot | null {
  if (saved === 'cloud') return {};
  if (saved?.startsWith('cloud:') && saved.length > 6) return { team: saved.slice(6) };
  return null;
}

const sameSpot = (a: CloudSpot, b: CloudSpot) => (a.team ?? '') === (b.team ?? '');

/**
 * Where the window opens at launch: on a cloud computer whenever the person has one that can work, whichever computer
 * was on screen last (the owner's call, 2026-11-17: "ensure cloud opens always first if user has"). The cloud computer
 * used last if it still can; else the first that can (the person's own before a team's). Null, with none: this
 * computer. "Only in the cloud" no longer changes this; it still takes this computer out of the switcher.
 */
export function launchComputer(saved: string | null | undefined, s: CloudOnlyState): CloudSpot | null {
  const last = savedCloudComputer(saved);
  if (last && s.usable.some((u) => sameSpot(u, last))) return last;
  return s.usable[0] ?? null;
}
