/**
 * What's new: the release notes the app shows once after an update (after Synara's `whatsNew/logic.ts`).
 * Versions are dates, stamped when a release is built: year.MMDD.n since 2026-11-07 (2026.1107.1, 2026.1107.2: the
 * day's releases counted from 1), year.month.day before (2026.10.27, one a day). Every new version is above every old
 * one both to semver (electron-updater) and to `compareVersions` (apps already installed), since a month and day as
 * one number (1107) is above any month (≤12). A release's notes may be written under an earlier version than the one
 * it ships as: an installed version shows the newest notes at or below it.
 */

export interface ReleaseFeature {
  /** unique within its release */
  id: string;
  title: string;
  /** one plain sentence or two */
  description: string;
}

export interface ReleaseNotes {
  /** like the app's own versions: year.MMDD.n (2026.1107.1), or year.month.day for releases before 2026-11-07 */
  version: string;
  features: readonly ReleaseFeature[];
}

/**
 * -1, 0 or 1 for dotted numeric versions (2026.10.17 < 2026.10.18 < 2026.1107.1 < 2026.1107.2); anything after a `-`
 * or `+` is ignored. Plain numbers part by part, as in every app already out: don't make it read the two forms
 * differently, or old and new apps would disagree (on a version policy, for one).
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => v.split(/[-+]/)[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function releasesNewestFirst(notes: readonly ReleaseNotes[]): ReleaseNotes[] {
  return [...notes].sort((a, b) => compareVersions(b.version, a.version));
}

/** The notes that describe `version`: the newest at or below it. */
export function notesFor(notes: readonly ReleaseNotes[], version: string): ReleaseNotes | undefined {
  return releasesNewestFirst(notes).find((n) => compareVersions(n.version, version) <= 0);
}

/**
 * The notes to announce, if any: those of the installed version, unless the version seen last already had them.
 * `seen` is null when nothing was recorded (someone who used AppuBot before What's new existed; a new install
 * records its version during onboarding, so it never gets one).
 */
export function whatsNewToShow(notes: readonly ReleaseNotes[], installed: string, seen: string | null): ReleaseNotes | undefined {
  const current = notesFor(notes, installed);
  if (!current) return undefined;
  return seen === null || compareVersions(current.version, seen) > 0 ? current : undefined;
}

/** How long the app must sit loaded, in front and uncovered before What's new opens by itself (no flash at startup). */
export const WHATS_NEW_OPEN_DELAY_MS = 1200;

/** What the app looks like right now, for `whatsNewOpensNow`. */
export interface WhatsNewOpenState {
  /** `whatsNewToShow` found notes for this version that aren't seen yet (the sidebar card is up) */
  pending: boolean;
  /** first-run setup is over (onboarding marks the version it starts on as seen, so a new install never has notes) */
  onboarded: boolean;
  /** hydrated and connected to AppuBot */
  loaded: boolean;
  /** the window is shown and focused (not a hidden relaunch after an update, nor a login start) */
  inFront: boolean;
  /** something else is up: a dialog (What's new itself too), Settings, the quit prompt, the update-required or
   *  connection screen, voice mode */
  covered: boolean;
}

/**
 * Whether What's new opens by itself now, after an update: the dialog the sidebar card opens, once, as soon as the
 * app is loaded, in front and free of other screens. Opening counts nothing; closing it marks the version seen, which
 * clears `pending`. The caller waits `WHATS_NEW_OPEN_DELAY_MS` of this holding before it opens.
 */
export function whatsNewOpensNow(s: WhatsNewOpenState): boolean {
  return s.pending && s.onboarded && s.loaded && s.inFront && !s.covered;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The day a version was released, as year, month and day: 2026.10.27 and 2026.1107.2 are dates; other versions aren't. */
export function versionDay(version: string): { year: number; month: number; day: number } | undefined {
  const old = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(version);
  const cur = /^(\d{4})\.(\d{3,4})\.\d+$/.exec(version);
  const year = Number((old ?? cur)?.[1]);
  const month = old ? Number(old[2]) : cur ? Math.floor(Number(cur[2]) / 100) : 0;
  const day = old ? Number(old[3]) : cur ? Number(cur[2]) % 100 : 0;
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? { year, month, day } : undefined;
}

/** "2026.10.27" and "2026.1027.2" → "Oct 27, 2026"; other versions as they are */
export function releaseDate(version: string): string {
  const d = versionDay(version);
  return d ? `${MONTHS[d.month - 1]} ${d.day}, ${d.year}` : version;
}
