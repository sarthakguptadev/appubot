/**
 * The side panel belongs to the chat on screen (the owner, 2026-11-28): open on one bot, it is closed on the next one,
 * and closed again on coming back. Opening a thread of the same bot keeps it open.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Bot, Snapshot, Thread } from '@appubot/protocol';
import { getState, hydrate, setState, ui } from './store';
import { applyEvent } from './events';

const bot = (id: string) => ({ id, name: id, pinned: false }) as unknown as Bot;
const thread = (id: string, botId: string): Thread => ({
  id, botId, title: id, providerId: 'claude-code', cwd: '/x', status: 'idle', modes: [], models: [], efforts: [], fastAvailable: false, fast: false,
  commands: [], source: 'desktop', lastMessagePreview: '', createdAt: 1, updatedAt: 1,
});

beforeEach(() => {
  setState({
    bots: [bot('a'), bot('b')], threads: [thread('ta', 'a'), thread('ta2', 'a'), thread('tb', 'b')], threadPick: {},
    selectedBotId: 'a', selectedThreadId: 'ta', selectedGroupId: null, rightOpen: false, rightTab: 'threads', settingsSection: null,
  });
});
const open = () => getState().rightOpen;

describe('the side panel', () => {
  it('closes when another bot is shown, and stays closed on coming back', () => {
    ui.openRight('computer');
    expect(open()).toBe(true);
    ui.selectBot('b');
    expect(open()).toBe(false);
    ui.selectBot('a');
    expect(open()).toBe(false);
  });

  it('opens only for the bot on screen, by hand', () => {
    ui.selectBot('b');
    ui.openRight('threads');
    ui.selectBot('a');
    expect(open()).toBe(false);
    ui.selectBot('b');
    expect(open()).toBe(false);
  });

  it('stays open for the same bot: picking it again, or opening another of its threads', () => {
    ui.openRight('threads');
    ui.selectBot('a');
    expect(open()).toBe(true);
    ui.openThread('ta2');
    expect(open()).toBe(true);
    expect(getState().rightTab).toBe('threads');
  });

  it('closes when a thread of another bot opens (a notification, the switcher)', () => {
    ui.openRight('threads');
    ui.openThread('tb');
    expect(getState().selectedBotId).toBe('b');
    expect(open()).toBe(false);
  });

  it("closes going into a group's room and coming back out", () => {
    ui.openRight('threads');
    ui.selectGroup('g1');
    expect(open()).toBe(false);
    ui.openRight('computer');
    ui.selectBot('a');
    expect(open()).toBe(false);
  });

  it('closes when the bot on screen is deleted, or another computer shows other bots', () => {
    ui.openRight('threads');
    applyEvent('bot.deleted', { id: 'a' });
    expect(getState().selectedBotId).toBe('b');
    expect(open()).toBe(false);

    ui.openRight('threads');
    hydrate({ bots: [bot('c')], threads: [], providers: [], devices: [], settings: null, computer: null, skills: [], routines: [], channels: [], system: null, pendingPermissions: [] } as unknown as Snapshot);
    expect(getState().selectedBotId).toBe('c');
    expect(open()).toBe(false);
  });

  it('keeps open over a reconnect that shows the same bot', () => {
    ui.openRight('threads');
    hydrate({ bots: [bot('a'), bot('b')], threads: [thread('ta', 'a')], providers: [], devices: [], settings: null, computer: null, skills: [], routines: [], channels: [], system: null, pendingPermissions: [] } as unknown as Snapshot);
    expect(getState().selectedBotId).toBe('a');
    expect(open()).toBe(true);
  });
});
