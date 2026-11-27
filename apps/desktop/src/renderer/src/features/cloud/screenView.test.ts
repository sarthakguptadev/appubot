import { describe, expect, it } from 'vitest';
import { CONTROL_IDLE_MS } from '@appubot/protocol';
import { DEFAULT_SCREEN, VIEWER_MARGIN, VIEWER_PILL_H, botScreenLine, controlUntil, fitScreen, localControl, mayStream, screenCaption, screenCard, screenUrl, shortcutKeysym } from './screenView';

describe('a bot’s own screen', () => {
  it('asks the screen port for that screen, keeping the signed link’s own query', () => {
    const link = 'wss://ab12cd34ef-6080.agent37.app/websockify?a37_token=t0k';
    expect(screenUrl(link, undefined)).toBe(link);
    expect(screenUrl(link, 'bot_ada')).toBe('wss://ab12cd34ef-6080.agent37.app/websockify?a37_token=t0k&screen=bot_ada');
  });

  it('says what the screen is doing in a few words', () => {
    expect(botScreenLine(undefined)).toBe('Asleep');
    expect(botScreenLine({ botId: 'b', state: 'starting', busy: false })).toBe('Starting…');
    expect(botScreenLine({ botId: 'b', state: 'asleep', busy: false })).toBe('Asleep');
    expect(botScreenLine({ botId: 'b', state: 'on', busy: true })).toBe('Working');
    expect(botScreenLine({ botId: 'b', state: 'on', busy: false, activeThreadId: 't' })).toBe('Working');
    expect(botScreenLine({ botId: 'b', state: 'on', busy: false })).toBe('Idle');
    const control = { id: 'c', name: 'Sam', via: 'desktop' as const, since: 0, expiresAt: 1, left: 1 };
    expect(botScreenLine({ botId: 'b', state: 'on', busy: true, control })).toBe('Sam has control');
  });
});

describe('the Computer tab’s card', () => {
  it('is live while the screen is up, with the reconnecting and paused states over the last picture', () => {
    expect(screenCard({ cloud: 'running', conn: 'connected', phase: 'connected' }).kind).toBe('live');
    expect(screenCard({ cloud: 'running', conn: 'connected', phase: 'reconnecting' }).kind).toBe('reconnecting');
    expect(screenCard({ cloud: 'running', conn: 'connected', phase: 'paused' }).kind).toBe('paused');
  });

  it('says it is waking while the computer or the link to it is, or the socket is slow to open', () => {
    expect(screenCard({ cloud: 'waking', conn: 'connected', phase: 'idle' }).kind).toBe('waking');
    expect(screenCard({ cloud: 'running', conn: 'reconnecting', phase: 'idle' }).kind).toBe('waking');
    expect(screenCard({ cloud: 'running', conn: 'connected', phase: 'waking' })).toEqual({ kind: 'waking', title: 'Waking up…' });
  });

  it('is asleep (with Wake) only while nothing has asked for the screen yet', () => {
    expect(screenCard({ cloud: 'asleep', conn: 'idle', phase: 'idle' }).kind).toBe('asleep');
    expect(screenCard({ cloud: 'stopped', conn: 'idle', phase: 'idle' }).kind).toBe('asleep');
    expect(screenCard({ cloud: 'asleep', conn: 'idle', phase: 'linking' }).kind).toBe('connecting');
    // the app is connected to it: it's awake whatever the last read state said
    expect(screenCard({ cloud: 'asleep', conn: 'connected', phase: 'idle' }).kind).toBe('connecting');
  });

  it('can’t reach it when the app can’t, or the screen gave up, saying why', () => {
    expect(screenCard({ cloud: 'running', conn: 'closed', phase: 'idle' }).kind).toBe('unreachable');
    expect(screenCard({ cloud: 'running', conn: 'connected', linkError: 'Its key changed.', phase: 'connected' })).toMatchObject({ kind: 'unreachable', line: 'Its key changed.' });
    expect(screenCard({ cloud: 'running', conn: 'connected', phase: 'failed', why: 'It dropped.' })).toMatchObject({ kind: 'unreachable', line: 'It dropped.' });
  });

  it('never wakes a sleeping computer or dials one it can’t reach by itself', () => {
    expect(mayStream({ cloud: 'running', conn: 'connected' })).toBe(true);
    expect(mayStream({ cloud: 'asleep', conn: 'idle' })).toBe(false);
    expect(mayStream({ cloud: 'asleep', conn: 'connected' })).toBe(true);
    expect(mayStream({ cloud: 'running', conn: 'unauthorized' })).toBe(false);
  });

  it('names the bot using it, else the computer', () => {
    expect(screenCaption({ computer: 'Your AppuBot computer', botName: 'Ada' })).toBe('Ada is using it');
    expect(screenCaption({ computer: 'Your AppuBot computer' })).toBe('Your AppuBot computer');
  });
});

describe('control held here (a computer without the control channel)', () => {
  it('goes back after the idle time without input, counting from the last input', () => {
    expect(controlUntil(1000)).toBe(1000 + CONTROL_IDLE_MS);
    const c = localControl('me@x.com', 1000, controlUntil(5000), 6000);
    expect(c).toMatchObject({ id: 'local', name: 'me@x.com', via: 'desktop', since: 1000, left: CONTROL_IDLE_MS - 1000 });
  });
});

describe('the full viewer’s screen box', () => {
  const room = (w: number, h: number) => ({ w, h: h - VIEWER_PILL_H - VIEWER_MARGIN });

  it('scales a 16:10 screen up to the room it has, keeping its shape', () => {
    const r = room(1900, 1000);
    const b = fitScreen({ w: 1900, h: 1000 }, { w: 1440, h: 900 });
    expect(b.h).toBe(r.h); // height-limited: the full height
    expect(b.w).toBeLessThanOrEqual(r.w);
    expect(Math.abs(b.w / b.h - 1.6)).toBeLessThan(0.01);
    expect(b.w).toBeGreaterThan(1440); // larger than the screen itself
  });

  it('scales down in a small window and is width-limited in a tall one', () => {
    const small = fitScreen({ w: 700, h: 500 }, { w: 1440, h: 900 });
    expect(small.w).toBeLessThan(1440);
    expect(small.w).toBeLessThanOrEqual(room(700, 500).w);
    expect(small.h).toBeLessThanOrEqual(room(700, 500).h);
    const tall = fitScreen({ w: 800, h: 1400 }, { w: 1920, h: 1080 });
    expect(tall.w).toBe(room(800, 1400).w);
    expect(Math.abs(tall.w / tall.h - 16 / 9)).toBeLessThan(0.01);
  });

  it('fits other shapes (4:3, portrait) and never goes over the room', () => {
    for (const fb of [{ w: 1024, h: 768 }, { w: 900, h: 1600 }, { w: 2560, h: 1080 }]) {
      for (const [w, h] of [[640, 480], [1280, 800], [2560, 1440], [1003, 777]] as const) {
        const b = fitScreen({ w, h }, fb);
        const r = room(w, h);
        expect(b.w).toBeLessThanOrEqual(r.w);
        expect(b.h).toBeLessThanOrEqual(r.h);
        expect(b.w === r.w || b.h === r.h || Math.abs(b.w - r.w) <= 1 || Math.abs(b.h - r.h) <= 1).toBe(true);
        expect(Math.abs(b.w / b.h - fb.w / fb.h)).toBeLessThan(0.02);
      }
    }
  });

  it('uses the default shape before the size is known, and nothing without room', () => {
    const b = fitScreen({ w: 1000, h: 700 }, undefined);
    expect(Math.abs(b.w / b.h - DEFAULT_SCREEN.w / DEFAULT_SCREEN.h)).toBeLessThan(0.01);
    expect(fitScreen({ w: 10, h: 10 }, { w: 1440, h: 900 })).toEqual({ w: 0, h: 0 });
  });
});

describe('⌘ shortcuts on the computer', () => {
  it('turns the key into the keysym Ctrl goes with', () => {
    expect(shortcutKeysym('KeyV')).toBe(0x76);
    expect(shortcutKeysym('KeyC')).toBe(0x63);
    expect(shortcutKeysym('KeyZ')).toBe(0x7a);
    expect(shortcutKeysym('Digit1')).toBe(0x31);
    expect(shortcutKeysym('Slash')).toBe(0x2f);
    expect(shortcutKeysym('ArrowLeft')).toBeNull();
    expect(shortcutKeysym('MetaLeft')).toBeNull();
  });
});
