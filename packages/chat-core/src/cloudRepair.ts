/**
 * Fix your computer (plan §6.9, D34): the words both apps use for Update, Recover and Reset: what each one keeps, its
 * one note, the confirmations, the steps as they run, the result, and the saved copies to pick from. Pure functions over
 * the protocol's `CloudRepair` / `CloudBackup`. The computer is "your AppuBot computer" here, never a product name.
 */
import type { CloudBackup, CloudComputer, CloudRepair, CloudRepairKind, CloudRepairState } from '@appubot/protocol';
import { clockTime } from './format';
import { shortDate } from './cloud';

/** how the repair copy names the computer */
export const FIX_COMPUTER_NAME = 'your AppuBot computer';
export const FIX_TITLE = 'Fix your computer';
export const FIX_DESCRIPTION = 'If your AppuBot computer is slow, stuck or won’t answer. Each one pauses your bots first and brings everything back paired, so nothing needs setting up again.';
/** the word Reset's confirmation asks to be typed */
export const RESET_CONFIRM_WORD = 'reset';
export const FIX_SUPPORT_NOTE = 'If it still won’t work, write to sarthak@appubot.com.';
/** the unreachable state's suggestion */
export const UNREACHABLE_FIX_HINT = 'Still not answering? Update it, or Recover it if that doesn’t help.';

export interface RepairOption {
  kind: CloudRepairKind;
  /** the button and the dialog's title */
  title: string;
  /** one line under the title */
  summary: string;
  /** when to use it */
  when: string;
  /** what it keeps (the home folder, the instance's own disk, is never replaced: tools installed there stay) */
  keeps: readonly string[];
  /** the one caveat under the list (Reset's loss is its own warning, `resetWarning`) */
  note: string;
  /** the confirm button */
  confirm: string;
  /** a destructive action (red) */
  danger: boolean;
}

export const REPAIR_OPTIONS: Readonly<Record<CloudRepairKind, RepairOption>> = {
  update: {
    kind: 'update', title: 'Update', confirm: 'Update now', danger: false,
    summary: 'Moves your AppuBot computer to the newest version.',
    when: 'Try this first.',
    keeps: ['Your bots, chats, files, memory and sign-ins', 'Apps and tools you installed in your home folder', 'Every paired phone, Mac and team member'],
    note: 'Running work restarts in about a minute.',
  },
  recover: {
    kind: 'recover', title: 'Recover', confirm: 'Recover now', danger: false,
    summary: 'Saves what it can, rebuilds your AppuBot computer on the newest version, then puts your files back.',
    when: 'For a computer that is stuck or won’t answer.',
    keeps: ['Your bots, chats, files, memory and sign-ins, as saved at the start', 'Apps and tools you installed in your home folder', 'Every paired phone, Mac and team member'],
    note: 'Running work restarts in about a minute. If a fresh copy can’t be saved, it uses the newest saved one.',
  },
  reset: {
    kind: 'reset', title: 'Reset', confirm: 'Reset', danger: true,
    summary: 'Puts your AppuBot computer back to a saved copy, on the newest version.',
    when: 'When something went wrong you can’t undo.',
    keeps: ['Your bots, chats, files, memory and tools as they were in that copy', 'Every paired phone, Mac and team member'],
    note: 'Running work stops.',
  },
};
export const REPAIR_KINDS: readonly CloudRepairKind[] = ['update', 'recover', 'reset'];

const STATE_WORDS: Record<CloudRepairState, string> = {
  queued: 'Getting ready',
  'backing-up': 'Pausing your bots and saving a copy',
  rebuilding: 'Rebuilding on the newest version',
  restoring: 'Putting your files back',
  starting: 'Starting AppuBot',
  done: 'Done',
  failed: 'Didn’t finish',
};
/** the step's words ("Putting your files back") */
export function repairStateText(state: CloudRepairState): string { return STATE_WORDS[state]; }

/** the steps a kind goes through, in order */
export function repairSteps(kind: CloudRepairKind): CloudRepairState[] {
  return kind === 'update' ? ['backing-up', 'rebuilding', 'starting'] : ['backing-up', 'rebuilding', 'restoring', 'starting'];
}

/** still running (queued or on a step) */
export function repairActive(r: Pick<CloudRepair, 'state'> | null | undefined): boolean {
  return !!r && r.state !== 'done' && r.state !== 'failed';
}

/** "Step 2 of 4" for a running repair; '' when queued or over */
export function repairStepText(r: Pick<CloudRepair, 'kind' | 'state'>): string {
  const steps = repairSteps(r.kind);
  const i = steps.indexOf(r.state);
  return i < 0 ? '' : `Step ${i + 1} of ${steps.length}`;
}

/** how far it is, 0…1, for a progress bar */
export function repairFraction(r: Pick<CloudRepair, 'kind' | 'state'>): number {
  if (r.state === 'done') return 1;
  const steps = repairSteps(r.kind);
  const i = steps.indexOf(r.state);
  return i < 0 ? 0.05 : (i + 0.5) / steps.length;
}

/** "Recovering your AppuBot computer" / "Updated" / "Reset didn’t finish": the title of the progress card */
export function repairHeadline(r: Pick<CloudRepair, 'kind' | 'state'>): string {
  const ing: Record<CloudRepairKind, string> = { update: 'Updating', recover: 'Recovering', reset: 'Resetting' };
  const ed: Record<CloudRepairKind, string> = { update: 'Updated', recover: 'Recovered', reset: 'Reset' };
  if (r.state === 'done') return `${ed[r.kind]} ${FIX_COMPUTER_NAME}`;
  if (r.state === 'failed') return `${REPAIR_OPTIONS[r.kind].title} didn’t finish`;
  return `${ing[r.kind]} ${FIX_COMPUTER_NAME}`;
}

/** a saved copy's date and time ("4 Nov, 02:10"), with "Last night" / "Today" where it fits */
export function backupWhen(createdAt: number, now = Date.now()): string {
  const d = new Date(createdAt), n = new Date(now);
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const yesterday = new Date(now - 86_400_000);
  const time = clockTime(createdAt);
  // a nightly copy taken in the small hours is "last night" once the morning has come; yesterday evening's too
  if (day(d) === day(n)) return `${d.getHours() < 5 && n.getHours() >= 5 ? 'Last night' : 'Today'}, ${time}`;
  if (day(d) === day(yesterday)) return `${d.getHours() >= 18 ? 'Last night' : 'Yesterday'}, ${time}`;
  return `${shortDate(createdAt, now)}, ${time}`;
}

/** a saved copy in a list: "Last night, 02:10" and what kind it is */
export function backupLabel(b: Pick<CloudBackup, 'kind' | 'createdAt'>, now = Date.now()): { title: string; detail: string } {
  return { title: backupWhen(b.createdAt, now), detail: b.kind === 'nightly' ? 'Nightly copy' : 'Saved on demand' };
}

/** the copy Reset starts on: the newest nightly, else the newest of any */
export function defaultResetBackup<B extends Pick<CloudBackup, 'kind' | 'createdAt'>>(backups: readonly B[]): B | undefined {
  const newest = (xs: readonly B[]) => [...xs].sort((a, b) => b.createdAt - a.createdAt)[0];
  return newest(backups.filter((b) => b.kind === 'nightly')) ?? newest(backups);
}

/** Reset's warning, naming the copy: everything after it is lost */
export function resetWarning(b: Pick<CloudBackup, 'createdAt'>, now = Date.now()): string {
  return `Anything after ${backupWhen(b.createdAt, now).replace(/^Today/, 'today').replace(/^Last night/, 'last night').replace(/^Yesterday/, 'yesterday')} is lost: new chats, files, bots, memory, and agents or sign-ins added since.`;
}

/** the line under a finished or failed repair */
export function repairResultText(r: Pick<CloudRepair, 'kind' | 'state' | 'message' | 'backup' | 'toVersion'>, now = Date.now()): string {
  if (r.state === 'failed') return `${r.message ? `${r.message.replace(/\.$/, '')}. ` : ''}Your saved copies are all still there, so you can try again. ${FIX_SUPPORT_NOTE}`;
  if (r.state !== 'done') return '';
  if (r.message) return r.message;
  if (r.kind === 'update') return r.toVersion ? `It’s on version ${r.toVersion}, with everything as it was.` : 'It’s on the newest version, with everything as it was.';
  const when = r.backup ? backupWhen(r.backup.createdAt, now) : '';
  return r.kind === 'reset' ? `It’s back to the copy from ${when}, on the newest version.` : `It’s rebuilt on the newest version${when ? `, with your files from ${when}` : ''}.`;
}

/** what is still to do after a repair: only a Reset leaves something (what came after its copy) */
export function repairAfterNote(r: Pick<CloudRepair, 'kind' | 'state'>): string {
  if (r.state !== 'done' || r.kind !== 'reset') return '';
  return 'Agents installed or signed in after that copy need installing or signing in again (Settings › Agents).';
}

// ---------------------------------------------------------------------------------------------------------------
// The section as both apps show it: whether it shows and for whom, the progress card, the unreachable pane's offer

/** computer states where a repair can't run (nothing set up yet, or stopped on purpose by billing) */
const NOT_FIXABLE: ReadonlySet<CloudComputer['state']> = new Set(['none', 'provisioning', 'on-hold', 'export-only', 'suspended', 'deleted']);

export interface FixOffer {
  /** the section shows */
  show: boolean;
  /** this person may press the buttons (the owner; a team's admins) */
  canFix: boolean;
  /** a repair is running: the buttons wait */
  running: boolean;
  repair?: CloudRepair;
  /** Update has nothing to do */
  upToDate: boolean;
  latestVersion?: number;
  /** why the buttons are off, in a line */
  note?: string;
}

/**
 * The section's state for a computer. `admin`: the person's own computer (always) or a team's they manage. A backend
 * from before repairs sends no `fix`: nothing shows. A member of a team sees a running repair but no buttons.
 */
export function fixOffer(c: CloudComputer | undefined | null, admin: boolean): FixOffer {
  if (!c?.fix || !c.computer || NOT_FIXABLE.has(c.state)) return { show: false, canFix: false, running: false, upToDate: false };
  const running = repairActive(c.repair);
  const out: FixOffer = { show: admin || running, canFix: admin, running, upToDate: c.fix.upToDate, ...(c.fix.latestVersion !== undefined ? { latestVersion: c.fix.latestVersion } : {}), ...(c.repair ? { repair: c.repair } : {}) };
  if (running) out.note = 'One fix at a time: wait for this one to finish.';
  else if (!admin) out.note = 'Only the team’s admins can fix its computer.';
  return out;
}

/** what the Update row shows in its button's place when there's nothing to do: "Up to date · version 14" */
export function upToDateText(version?: number): string {
  return version !== undefined ? `Up to date · version ${version}` : 'Up to date';
}

/** the Update row's line: the version it moves to, or (up to date, `upToDateText` beside it) what Update does */
export function updateLine(o: Pick<FixOffer, 'upToDate' | 'latestVersion'>, version?: number): string {
  if (o.upToDate) return REPAIR_OPTIONS.update.summary;
  return o.latestVersion !== undefined && version !== undefined && version !== o.latestVersion
    ? `Version ${version} → ${o.latestVersion}. ${REPAIR_OPTIONS.update.when}`
    : `${REPAIR_OPTIONS.update.summary} ${REPAIR_OPTIONS.update.when}`;
}

export interface RepairCard {
  headline: string;
  /** "Putting your files back · Step 3 of 4" while it runs */
  step: string;
  fraction: number;
  tone: 'running' | 'done' | 'failed';
  /** the saved copy it uses ("Files from Last night, 02:10") */
  backupLine: string;
  notes: string[];
  /** the result (done or failed) */
  result: string;
  /** what's left for the user after a rebuild */
  after: string;
}

export function repairCard(r: CloudRepair, now = Date.now()): RepairCard {
  const tone = r.state === 'done' ? 'done' : r.state === 'failed' ? 'failed' : 'running';
  const step = tone === 'running' ? [repairStateText(r.state), repairStepText(r)].filter(Boolean).join(' · ') : '';
  return {
    headline: repairHeadline(r), step, fraction: repairFraction(r), tone,
    backupLine: r.backup && r.kind !== 'update' ? `Files from the copy saved ${backupWhen(r.backup.createdAt, now).replace(/^(Today|Last night|Yesterday)/, (m) => m.toLowerCase())}` : '',
    notes: r.notes, result: repairResultText(r, now), after: repairAfterNote(r),
  };
}

/**
 * The "couldn't reach your cloud computer" pane: Update, then Recover, when this person may fix it and nothing is
 * running; nothing for a member or an older backend.
 */
export function unreachableFixes(c: CloudComputer | undefined | null, admin: boolean): CloudRepairKind[] {
  const o = fixOffer(c, admin);
  if (!o.show || !o.canFix || o.running) return [];
  return o.upToDate ? ['recover'] : ['update', 'recover'];
}
