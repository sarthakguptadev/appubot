/**
 * Fix your computer on the desktop (plan §6.9): when the section shows and for whom, the progress card's lines as a
 * repair runs and ends, what the unreachable pane offers, and the section rendered as Settings shows it.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudComputer, CloudRepair } from '@appubot/protocol';
import { fixOffer, repairCard, unreachableFixes, updateLine } from './repairView';
import { FixComputerGroup, RepairProgress } from './FixComputer';

const NOW = Date.parse('2026-11-05T15:00:00');
const machine = { id: 'cmp_1', region: 'us' as const, version: 13, publicUrl: 'https://abc.agent37.app', hostName: 'AppuBot Cloud', recentWakes: [] };
const computer = (o: Partial<CloudComputer> = {}): CloudComputer => ({ state: 'asleep', noticeSeq: 0, computer: machine, fix: { latestVersion: 14, upToDate: false }, ...o });
const repair = (o: Partial<CloudRepair> = {}): CloudRepair => ({ id: 'rep_1', kind: 'recover', state: 'restoring', startedAt: NOW - 120_000, updatedAt: NOW, notes: [], backup: { id: 'bk', kind: 'manual', createdAt: Date.parse('2026-11-05T14:58:00') }, ...o });

describe('fixOffer', () => {
  it('shows for the owner with the version to move to', () => {
    const o = fixOffer(computer(), true);
    expect(o).toMatchObject({ show: true, canFix: true, running: false, upToDate: false, latestVersion: 14 });
    expect(updateLine(o, 13)).toBe('Version 13 → 14. Try this first.');
    expect(updateLine({ upToDate: true }, 14)).toBe('Moves your AppuBot computer to the newest version.');
  });

  it('hides from an older backend (no `fix`), before set-up and while billing stops the computer', () => {
    expect(fixOffer(computer({ fix: undefined }), true).show).toBe(false);
    for (const state of ['provisioning', 'on-hold', 'export-only', 'suspended', 'none'] as const) expect(fixOffer(computer({ state }), true).show, state).toBe(false);
    // a computer whose instance failed is exactly what Recover is for
    expect(fixOffer(computer({ state: 'failed' }), true).show).toBe(true);
    expect(fixOffer(undefined, true).show).toBe(false);
  });

  it('a team member sees a running fix but no buttons; an admin gets them', () => {
    expect(fixOffer(computer(), false).show).toBe(false);
    const running = fixOffer(computer({ repair: repair() }), false);
    expect(running).toMatchObject({ show: true, canFix: false, running: true });
    expect(running.note).toMatch(/One fix at a time/);
    expect(fixOffer(computer({ repair: repair({ state: 'done' }) }), true)).toMatchObject({ running: false, canFix: true });
  });
});

describe('repairCard', () => {
  it('a running recover: its step, how far, the copy it uses', () => {
    const c = repairCard(repair(), NOW);
    expect(c.headline).toBe('Recovering your AppuBot computer');
    expect(c.step).toBe('Putting your files back · Step 3 of 4');
    expect(c.fraction).toBeCloseTo(0.625);
    expect(c.tone).toBe('running');
    expect(c.backupLine).toMatch(/^Files from the copy saved today, /);
    expect(c.result).toBe('');
  });

  it('a finished update: on the version, everything as it was, nothing left to do', () => {
    const c = repairCard(repair({ kind: 'update', state: 'done', toVersion: 14, backup: undefined }), NOW);
    expect(c.headline).toBe('Updated your AppuBot computer');
    expect(c.result).toBe('It’s on version 14, with everything as it was.');
    expect(c.after).toBe('');
    expect(c.step).toBe('');
  });

  it('a failed reset: the reason, the copies still there, support', () => {
    const c = repairCard(repair({ kind: 'reset', state: 'failed', message: 'The copy you picked is no longer kept, so your files weren’t touched' }), NOW);
    expect(c.headline).toBe('Reset didn’t finish');
    expect(c.tone).toBe('failed');
    expect(c.result).toBe('The copy you picked is no longer kept, so your files weren’t touched. Your saved copies are all still there, so you can try again. If it still won’t work, write to sarthak@appubot.com.');
  });

  it('notes from the backend come through as they are', () => {
    const c = repairCard(repair({ notes: ['A fresh copy couldn’t be saved (the copy failed), so your files come back from the newest saved copy instead; anything after it is lost.'] }), NOW);
    expect(c.notes).toHaveLength(1);
  });
});

describe('unreachableFixes', () => {
  it('Update then Recover for whoever may fix it; Recover alone when up to date; nothing while one runs or for a member', () => {
    expect(unreachableFixes(computer(), true)).toEqual(['update', 'recover']);
    expect(unreachableFixes(computer({ fix: { latestVersion: 14, upToDate: true } }), true)).toEqual(['recover']);
    expect(unreachableFixes(computer({ repair: repair() }), true)).toEqual([]);
    expect(unreachableFixes(computer(), false)).toEqual([]);
    expect(unreachableFixes(computer({ fix: undefined }), true)).toEqual([]);
  });
});

describe('the section, rendered', () => {
  // the components read the clock (`useNow`): pin it to NOW, so "Today" is today whenever the suite runs
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it('three actions, each saying what it does; never "Cloud" as a name', () => {
    const html = renderToStaticMarkup(createElement(FixComputerGroup, { computer: computer() }));
    expect(html).toContain('Fix your computer');
    for (const t of ['Update…', 'Recover…', 'Reset…']) expect(html).toContain(t);
    expect(html).toContain('Version 13 → 14');
    expect(html).toContain('stuck or won’t answer');
    expect(html).not.toMatch(/AppuBot Cloud|\bCloud\b/);
  });

  it('while one runs, its progress and the buttons waiting', () => {
    const html = renderToStaticMarkup(createElement(FixComputerGroup, { computer: computer({ repair: repair() }) }));
    expect(html).toContain('Recovering your AppuBot computer');
    expect(html).toContain('Step 3 of 4');
    expect(html).toContain('role="progressbar"');
    expect((html.match(/disabled=""/g) ?? []).length).toBe(3);
  });

  it('a member of the team sees nothing to press', () => {
    expect(renderToStaticMarkup(createElement(FixComputerGroup, { computer: computer(), admin: false }))).toBe('');
  });

  it('the result card after it ended', () => {
    const html = renderToStaticMarkup(createElement(RepairProgress, { repair: repair({ state: 'done' }) }));
    expect(html).toContain('Recovered your AppuBot computer');
    expect(html).toContain('It’s rebuilt on the newest version, with your files from Today');
  });
});
