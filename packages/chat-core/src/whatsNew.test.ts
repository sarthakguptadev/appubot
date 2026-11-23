import { describe, expect, it } from 'vitest';
import { RELEASES } from './releases';
import { compareVersions, notesFor, releaseDate, versionDay, releasesNewestFirst, whatsNewOpensNow, whatsNewToShow, type ReleaseNotes, type WhatsNewOpenState } from './whatsNew';

const notes = (version: string): ReleaseNotes => ({ version, features: [{ id: 'x', title: version, description: '' }] });
const ALL = [notes('2026.10.21'), notes('2026.10.27'), notes('2026.9.30')];

describe('whatsNew', () => {
  it('compares date versions', () => {
    expect(compareVersions('2026.9.30', '2026.10.1')).toBe(-1);
    expect(compareVersions('2026.10.27', '2026.10.27')).toBe(0);
    expect(compareVersions('2026.10.28', '2026.10.27-beta')).toBe(1);
    expect(releasesNewestFirst(ALL).map((n) => n.version)).toEqual(['2026.10.27', '2026.10.21', '2026.9.30']);
  });

  it('puts several releases a day (year.MMDD.n) above every one-a-day version, as installed apps compare them', () => {
    expect(compareVersions('2026.1107.1', '2026.11.7')).toBe(1);
    expect(compareVersions('2026.1107.1', '2026.12.31')).toBe(1);
    expect(compareVersions('2026.1107.2', '2026.1107.1')).toBe(1);
    expect(compareVersions('2026.1107.10', '2026.1107.9')).toBe(1);
    expect(compareVersions('2026.1108.1', '2026.1107.12')).toBe(1);
    expect(compareVersions('2026.1201.1', '2026.1130.3')).toBe(1);
    expect(compareVersions('2027.101.1', '2026.1231.4')).toBe(1);
    // notes written for the first release of a day still show on the second
    expect(notesFor([notes('2026.11.07'), notes('2026.1107.1')], '2026.1107.2')?.version).toBe('2026.1107.1');
    expect(notesFor([notes('2026.11.07'), notes('2026.1108.1')], '2026.1107.2')?.version).toBe('2026.11.07');
  });

  it('keeps RELEASES newest first, each above the next', () => {
    for (let i = 1; i < RELEASES.length; i++) expect(compareVersions(RELEASES[i - 1]!.version, RELEASES[i]!.version)).toBe(1);
  });

  it('takes the newest notes at or below the installed version', () => {
    expect(notesFor(ALL, '2026.10.27')?.version).toBe('2026.10.27');
    // notes written on the 27th, released on the 29th
    expect(notesFor(ALL, '2026.10.29')?.version).toBe('2026.10.27');
    expect(notesFor(ALL, '2026.10.25')?.version).toBe('2026.10.21');
    expect(notesFor(ALL, '0.1.0')).toBeUndefined();
  });

  it('announces a release once', () => {
    expect(whatsNewToShow(ALL, '2026.10.29', '2026.10.21')?.version).toBe('2026.10.27');
    // used AppuBot before What's new existed
    expect(whatsNewToShow(ALL, '2026.10.29', null)?.version).toBe('2026.10.27');
    // already seen: on this version, or on an earlier one that shipped the same notes
    expect(whatsNewToShow(ALL, '2026.10.29', '2026.10.29')).toBeUndefined();
    expect(whatsNewToShow(ALL, '2026.10.29', '2026.10.28')).toBeUndefined();
    // a downgrade
    expect(whatsNewToShow(ALL, '2026.10.21', '2026.10.27')).toBeUndefined();
    // dev builds
    expect(whatsNewToShow(ALL, '0.1.0', null)).toBeUndefined();
  });

  describe('opens by itself', () => {
    const ready: WhatsNewOpenState = { pending: true, onboarded: true, loaded: true, inFront: true, covered: false };

    it('opens after an update once the app is loaded, in front and uncovered', () => {
      expect(whatsNewOpensNow(ready)).toBe(true);
    });

    it('never without unseen notes: a new install (onboarding marked it), already seen or closed, a dev build', () => {
      expect(whatsNewOpensNow({ ...ready, pending: false })).toBe(false);
      // closing the dialog marks the version seen, so it doesn't open again this launch or the next
      const seen = whatsNewToShow(ALL, '2026.10.29', '2026.10.29');
      expect(whatsNewOpensNow({ ...ready, pending: !!seen })).toBe(false);
      expect(whatsNewOpensNow({ ...ready, pending: !!whatsNewToShow(ALL, '2026.10.29', '2026.10.21') })).toBe(true);
    });

    it('waits through onboarding and loading', () => {
      expect(whatsNewOpensNow({ ...ready, onboarded: false })).toBe(false);
      expect(whatsNewOpensNow({ ...ready, loaded: false })).toBe(false);
    });

    it('waits for the window to be shown and focused (hidden relaunch after an update, login start)', () => {
      expect(whatsNewOpensNow({ ...ready, inFront: false })).toBe(false);
    });

    it('never stacks over another dialog or screen', () => {
      expect(whatsNewOpensNow({ ...ready, covered: true })).toBe(false);
    });
  });

  it('dates a version', () => {
    expect(releaseDate('2026.10.27')).toBe('Oct 27, 2026');
    expect(releaseDate('2026.1.5')).toBe('Jan 5, 2026');
    expect(releaseDate('0.1.0')).toBe('0.1.0');
    expect(releaseDate('2026.1107.2')).toBe('Nov 7, 2026');
    expect(releaseDate('2027.105.1')).toBe('Jan 5, 2027');
    expect(releaseDate('2026.1307.1')).toBe('2026.1307.1');
    expect(versionDay('2026.1231.3')).toEqual({ year: 2026, month: 12, day: 31 });
    expect(versionDay('2026.11.07')).toEqual({ year: 2026, month: 11, day: 7 });
  });
});
