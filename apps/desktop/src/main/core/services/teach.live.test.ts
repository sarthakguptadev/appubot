/**
 * Teach mode on your AppuBot computer: no helper, no hooks, but a screen source (live view). What a device does on the
 * screen through AppuBot (live view's input, the desktop viewer's mirrored input) is the recording: clicks with a
 * picture, typed text joined up, keys, scrolls, drags; the source is held up while recording and let go after; the
 * steps reach the bot as on a Mac. `LiveRecorder` is checked on its own too.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PromptBlock } from '@appubot/agent-runtime';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { LiveRecorder, type InputEvent } from './teach';
import { controlKey } from './liveView';

let core: Core;
let runtime: FakeRuntime;
let root: string;
const textOf = (blocks: PromptBlock[]) => blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
/** a screen that changes on every look, 1440×900 */
let frames = 0;
const screen = {
  frame: vi.fn(async (o: { maxDim: number; after: number }) => { frames += 1; return { seq: frames, image_base64: `pic${frames}`, width: Math.min(o.maxDim, 1440), height: 900, bounds: { x: 0, y: 0, width: 1440, height: 900 } }; }),
  stop: vi.fn(),
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-teach-live-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'AppuBot Cloud', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    liveScreen: () => screen,
    cloud: { publicUrl: 'https://ab12cd34ef.agent37.app', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 3 },
  });
  await core.start();
  await core.services.providers.refresh();
  runtime.reply = () => 'Saved the skill.';
});

afterAll(async () => {
  await core?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('teach mode through the screen', () => {
  it('records what a device does on the screen through AppuBot and hands the steps to the bot', async () => {
    const teach = core.services.teach;
    expect(await teach.support()).toEqual({ recording: true, how: 'live' });
    const bot = core.services.bots.list()[0]!;
    const s = await teach.start(bot.id, 'Open the report', 'The report is open');
    expect(s.status).toBe('recording');
    // live view's input (the phone, in control: teach mode is Take control while recording): heard by the recorder
    // even where the computer can't carry it out (no backend here)
    core.services.computer.takeControl({ key: controlKey(1), name: 'Phone', via: 'live' });
    await core.services.liveView.input({ kind: 'click', x: 0.5, y: 0.5, button: 'left', count: 1 }, 1).catch(() => undefined);
    core.services.computer.releaseControl(controlKey(1));
    // the desktop viewer's mirrored input
    teach.viewerInput({ kind: 'type', text: 'rep' });
    teach.viewerInput({ kind: 'type', text: 'ort' });
    teach.viewerInput({ kind: 'key', key: 'enter', modifiers: [] });
    teach.viewerInput({ kind: 'scroll', x: 0.5, y: 0.6, dx: 0, dy: 240 });
    await vi.waitFor(() => expect(teach.status()?.stepCount).toBe(4), { timeout: 3000 });
    // the source stayed up for the pictures
    expect(screen.stop).not.toHaveBeenCalled();
    const before = runtime.prompts.length;
    const stopped = await teach.stop(s.id, false);
    expect(stopped.status).toBe('summarizing');
    expect(screen.stop).toHaveBeenCalled();
    await vi.waitFor(() => expect(runtime.prompts.slice(before).some((p) => textOf(p.blocks).includes('Recorded steps'))).toBe(true), { timeout: 8000 });
    const prompt = runtime.prompts.slice(before).find((p) => textOf(p.blocks).includes('Recorded steps'))!;
    const text = textOf(prompt.blocks);
    expect(text).toContain('my AppuBot computer, through its screen');
    expect(text).toContain('Recorded steps (4):');
    expect(text).toContain('1. Clicked at (720,450)');
    expect(text).toContain("2. Typed 'report'");
    expect(text).toContain('3. Pressed enter');
    expect(text).toContain('4. Scrolled down at (720,540)');
    expect(text).toContain('1 screenshot(s) taken at key clicks are attached in order.');
    expect(prompt.blocks.filter((b) => b.type === 'image')).toHaveLength(1);
    await vi.waitFor(() => expect(teach.status()?.status).toBe('done'), { timeout: 8000 });
  });
});

describe('the live recorder', () => {
  it('joins typed text, tells a drag from a click, names the window and takes a picture at each click', async () => {
    const got: InputEvent[] = [];
    let now = 1000;
    const rec = new LiveRecorder({
      emit: (e) => got.push(e),
      shot: async () => 'PIC',
      where: async (pt) => (pt.x < 720 ? { app: 'Chromium', title: 'Gmail' } : undefined),
    }, () => now);
    const b = { x: 0, y: 0, width: 1440, height: 900 };
    rec.take({ kind: 'click', x: 0.25, y: 0.5, button: 'left', count: 2 }, b);
    rec.take({ kind: 'type', text: 'hel' }, b);
    now += 500;
    rec.take({ kind: 'type', text: 'lo' }, b);
    now += 3000;
    rec.take({ kind: 'paste', text: ' world' }, b);
    rec.take({ kind: 'down', x: 0.1, y: 0.1 }, b);
    rec.take({ kind: 'up', x: 0.1, y: 0.1 }, b);
    rec.take({ kind: 'down', x: 0.1, y: 0.1 }, b);
    rec.take({ kind: 'up', x: 0.8, y: 0.8 }, b);
    rec.take({ kind: 'move', x: 0.5, y: 0.5 }, b);
    rec.take({ kind: 'copy' }, b);
    await rec.flush();
    expect(got.map((e) => e.kind)).toEqual(['click', 'typed', 'typed', 'click', 'drag_end']);
    expect(got[0]).toMatchObject({ x: 360, y: 450, count: 2, app: 'Chromium', window_title: 'Gmail', screenshot_base64: 'PIC' });
    expect(got[1]).toMatchObject({ text: 'hello' });
    expect(got[2]).toMatchObject({ text: ' world' });
    expect(got[3]).toMatchObject({ x: 144, y: 90, count: 1 });
    expect(got[4]).toMatchObject({ from: { x: 144, y: 90 }, x: 1152, y: 720 });
    expect(got[4]!.app).toBeUndefined();
  });
});
