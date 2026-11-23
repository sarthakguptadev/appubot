import { describe, expect, it } from 'vitest';
import type { CloudBackup, CloudRepair } from '@appubot/protocol';
import {
  FIX_DESCRIPTION, REPAIR_KINDS, REPAIR_OPTIONS, backupLabel, backupWhen, defaultResetBackup, repairActive, repairAfterNote, repairFraction, repairHeadline, repairResultText,
  repairStateText, repairStepText, repairSteps, resetWarning, upToDateText,
} from './cloudRepair';

const NOW = Date.parse('2026-11-05T15:00:00');
const at = (iso: string) => Date.parse(iso);
const r = (o: Partial<CloudRepair>): CloudRepair => ({ id: 'rep', kind: 'update', state: 'queued', startedAt: NOW, updatedAt: NOW, notes: [], ...o });

describe('Fix your computer words', () => {
  it('each action says what it keeps and one note, calls the computer "your AppuBot computer", never "Cloud"', () => {
    for (const k of REPAIR_KINDS) {
      const o = REPAIR_OPTIONS[k];
      expect(o.keeps.length).toBeGreaterThan(0);
      expect(o.note).toMatch(/^Running work /);
      expect(JSON.stringify(o)).not.toMatch(/\bCloud\b|system itself/);
    }
    expect(FIX_DESCRIPTION).toMatch(/your AppuBot computer/);
    expect(REPAIR_OPTIONS.reset.danger).toBe(true);
    // the home folder is the instance's own disk: Update and Recover keep what was installed in it
    for (const k of ['update', 'recover'] as const) expect(REPAIR_OPTIONS[k].keeps).toContain('Apps and tools you installed in your home folder');
    expect(upToDateText(14)).toBe('Up to date · version 14');
    expect(upToDateText()).toBe('Up to date');
    expect(repairAfterNote(r({ kind: 'update', state: 'done' }))).toBe('');
    expect(repairAfterNote(r({ kind: 'reset', state: 'done' }))).toMatch(/^Agents installed or signed in after that copy/);
  });

  it('steps, how far, the headline', () => {
    expect(repairSteps('update')).toEqual(['backing-up', 'rebuilding', 'starting']);
    expect(repairSteps('reset')).toEqual(['backing-up', 'rebuilding', 'restoring', 'starting']);
    expect(repairStepText(r({ kind: 'reset', state: 'restoring' }))).toBe('Step 3 of 4');
    expect(repairStepText(r({ state: 'queued' }))).toBe('');
    expect(repairFraction(r({ state: 'done' }))).toBe(1);
    expect(repairFraction(r({ state: 'queued' }))).toBeGreaterThan(0);
    expect(repairStateText('backing-up')).toBe('Pausing your bots and saving a copy');
    expect(repairHeadline(r({ kind: 'recover', state: 'rebuilding' }))).toBe('Recovering your AppuBot computer');
    expect(repairHeadline(r({ kind: 'reset', state: 'failed' }))).toBe('Reset didn’t finish');
    expect(repairActive(r({ state: 'starting' }))).toBe(true);
    expect(repairActive(r({ state: 'done' }))).toBe(false);
    expect(repairActive(null)).toBe(false);
  });

  it('saved copies: when, what kind, which one Reset starts on, and the warning', () => {
    expect(backupWhen(at('2026-11-05T02:10:00'), NOW)).toMatch(/^Last night, /);
    expect(backupWhen(at('2026-11-05T02:10:00'), at('2026-11-05T03:00:00'))).toMatch(/^Today, /);
    expect(backupWhen(at('2026-11-05T14:10:00'), NOW)).toMatch(/^Today, /);
    expect(backupWhen(at('2026-11-04T22:40:00'), NOW)).toMatch(/^Last night, /);
    expect(backupWhen(at('2026-11-04T02:10:00'), NOW)).toMatch(/^Yesterday, /);
    expect(backupWhen(at('2026-11-01T02:10:00'), NOW)).toMatch(/^1 Nov|^Nov 1/);
    expect(backupLabel({ kind: 'nightly', createdAt: at('2026-11-04T02:10:00') }, NOW).detail).toBe('Nightly copy');
    expect(backupLabel({ kind: 'manual', createdAt: at('2026-11-04T02:10:00') }, NOW).detail).toBe('Saved on demand');
    const list: CloudBackup[] = [
      { id: 'm', kind: 'manual', createdAt: at('2026-11-05T14:00:00') },
      { id: 'n2', kind: 'nightly', createdAt: at('2026-11-05T02:10:00') },
      { id: 'n1', kind: 'nightly', createdAt: at('2026-11-04T02:10:00') },
    ];
    expect(defaultResetBackup(list)?.id).toBe('n2');
    expect(defaultResetBackup([list[0]!])?.id).toBe('m');
    expect(defaultResetBackup([])).toBeUndefined();
    expect(resetWarning(list[1]!, NOW)).toMatch(/^Anything after last night, .* is lost: new chats, files, bots, memory, and agents or sign-ins added since\.$/);
  });

  it('results', () => {
    expect(repairResultText(r({ kind: 'update', state: 'done', toVersion: 14 }), NOW)).toBe('It’s on version 14, with everything as it was.');
    expect(repairResultText(r({ kind: 'reset', state: 'done', backup: { id: 'n', kind: 'nightly', createdAt: at('2026-11-04T02:10:00') } }), NOW)).toMatch(/^It’s back to the copy from Yesterday, .*, on the newest version\.$/);
    expect(repairResultText(r({ kind: 'recover', state: 'failed', message: 'Your files couldn’t be put back.' }), NOW)).toBe('Your files couldn’t be put back. Your saved copies are all still there, so you can try again. If it still won’t work, write to sarthak@appubot.com.');
    expect(repairResultText(r({ state: 'rebuilding' }), NOW)).toBe('');
  });
});
