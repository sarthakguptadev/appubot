import { describe, expect, it } from 'vitest';
import { CONTROL_IDLE_MS, CONTROL_WARN_MS, type ScreenControl } from '@appubot/protocol';
import { controlDeadline, controlNote, controlPill, screenWaitText, threadScreen, threadScreenBot } from './screenControl';

const ctl = (o: Partial<ScreenControl> = {}): ScreenControl => ({ id: 'ctl_1', name: 'Sam’s iPhone', via: 'live', since: 0, expiresAt: CONTROL_IDLE_MS, left: CONTROL_IDLE_MS, ...o });

describe('the Watching / Take control pill', () => {
  it('watches by default, with Take control for a device that may use the screen', () => {
    expect(controlPill({ control: null, mine: false, canControl: true, now: 0 })).toEqual({ mode: 'watching', label: 'Watching', action: { kind: 'take', label: 'Take control' } });
    expect(controlPill({ control: undefined, mine: false, canControl: false, now: 0 }).action).toBeNull();
  });

  it('says who has control and keeps Take control off meanwhile', () => {
    const p = controlPill({ control: ctl(), mine: false, canControl: true, now: 0 });
    expect(p).toEqual({ mode: 'other', label: 'Sam’s iPhone has control', action: { kind: 'take', label: 'Take control', disabled: true } });
    expect(controlNote(p)).toMatch(/wait until they give it back/);
  });

  it('is yours with Give back, then counts down near the end with Keep control', () => {
    const heard = 1_000;
    const c = ctl();
    const deadline = controlDeadline(c, heard);
    expect(deadline).toBe(heard + CONTROL_IDLE_MS);
    const mine = controlPill({ control: c, mine: true, canControl: true, deadline, now: heard + 1_000 });
    expect(mine).toEqual({ mode: 'mine', label: 'You’re in control', action: { kind: 'give', label: 'Give back' } });
    expect(controlNote(mine)).toBe('Your bots wait until you give control back.');
    const late = controlPill({ control: c, mine: true, canControl: true, deadline, now: deadline - CONTROL_WARN_MS + 7_500 });
    expect(late).toMatchObject({ mode: 'mine', label: 'Giving back in 13 s', action: { kind: 'keep', label: 'Keep control' }, countdown: 13 });
    expect(controlPill({ control: c, mine: true, canControl: true, deadline, now: deadline + 5 }).countdown).toBe(0);
    // with no deadline of its own, what the computer said was left
    expect(controlPill({ control: ctl({ left: 3_000 }), mine: true, canControl: true, now: 0 }).countdown).toBe(3);
  });
});

describe('a chat’s wait line', () => {
  it('names who has control, or the bot using the screen', () => {
    expect(screenWaitText({ wait: { for: 'control' }, control: ctl(), mine: true })).toBe('Paused while you’re in control');
    expect(screenWaitText({ wait: { for: 'control' }, control: ctl(), mine: false })).toBe('Paused while Sam’s iPhone has control');
    expect(screenWaitText({ wait: { for: 'control' }, control: null, mine: false })).toBe('Paused while someone has control');
    expect(screenWaitText({ wait: { for: 'screen' }, mine: false, holderBot: 'Ada' })).toBe('Waiting for the screen: Ada is using it');
    expect(screenWaitText({ wait: { for: 'screen' }, mine: false })).toBe('Waiting for the screen');
  });
});

describe('the screen a chat’s bot works on', () => {
  it('is the bot’s own while it works or waits there, else the computer’s main one', () => {
    const main = { backend: 'cua-driver' as const, available: true, permissions: { accessibility: true, screenRecording: true }, busy: false, paused: false, liveView: true, background: false, activeThreadId: 'thr_main', control: ctl({ name: 'Ada’s Mac' }) };
    const st = { ...main, screens: [
      { botId: 'bot_a', state: 'on' as const, busy: true, activeThreadId: 'thr_a' },
      { botId: 'bot_b', state: 'on' as const, busy: false, waits: [{ threadId: 'thr_b', for: 'control' as const, since: 0 }], control: ctl() },
    ] };
    expect(threadScreen(st, 'thr_a')).toMatchObject({ activeThreadId: 'thr_a' });
    expect(threadScreen(st, 'thr_b')?.control?.name).toBe('Sam’s iPhone');
    expect(threadScreen(st, 'thr_main')).toBe(st);
    expect(threadScreen(main, 'thr_a')).toBe(main);
    expect(threadScreen(null, 'thr_a')).toBeUndefined();
    // a chat's Watch opens the screen its bot works or waits on
    expect(threadScreenBot(st, 'thr_a')).toBe(st.screens![0]!.botId);
    expect(threadScreenBot(st, 'thr_b')).toBe(st.screens![1]!.botId);
    expect(threadScreenBot(st, 'thr_main')).toBeUndefined();
    expect(threadScreenBot(main, 'thr_a')).toBeUndefined();
    expect(threadScreenBot(null, 'thr_a')).toBeUndefined();
  });
});
