/**
 * Teach mode on Windows and Linux: with no native helper, `deps.inputWatch` records (InputRecorder); the steps it saw
 * reach the bot as a prompt with the pictures attached. Where it can't record, teach says why and goes manual.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PromptBlock } from '@appubot/agent-runtime';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import type { Foreground, InputWatchHost, Mods, Point, RawInput } from './inputRecorder';

const M = (o: Partial<Mods> = {}): Mods => ({ ctrl: false, alt: false, shift: false, meta: false, ...o });

class FakeWatch implements InputWatchHost {
  onInput: ((e: RawInput) => void) | null = null;
  ok = true;
  starts = 0;
  stops = 0;
  async available() { return this.ok ? { ok: true } : { ok: false, reason: 'Recording needs an X11 (Xorg) session' }; }
  async start(fn: (e: RawInput) => void) { this.starts++; this.onInput = fn; }
  async stop() { this.stops++; this.onInput = null; }
  cursor() { return { x: 1, y: 2 }; }
  async foreground(at?: Point): Promise<Foreground> {
    // AppuBot's own window sits at the right of the screen
    return at && at.x > 1000 ? { app: 'AppuBot', title: 'AppuBot', self: true } : { app: 'Notepad', title: 'Untitled - Notepad', self: false };
  }
  async screenshot() { return 'AAAA'; }
}

let core: Core;
let runtime: FakeRuntime;
let root: string;
const watch = new FakeWatch();
const textOf = (blocks: PromptBlock[]) => blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-teach-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-pc', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null, inputWatch: watch,
  });
  await core.start();
  await core.services.providers.refresh();
  // the bot just answers (no tool, no permission to wait on)
  runtime.reply = () => 'Saved the skill.';
});

afterAll(async () => {
  await core?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('teach mode with the hooks recorder', () => {
  it('records clicks and typing, leaves out AppuBot\'s own window and hands the steps to the bot', async () => {
    const teach = core.services.teach;
    expect(await teach.support()).toEqual({ recording: true, how: 'input' });
    const bot = core.services.bots.list()[0]!;
    const s = await teach.start(bot.id, 'Write a note', 'A note saying hi');
    expect(s.status).toBe('recording');
    expect(watch.starts).toBe(1);
    const send = watch.onInput!;
    send({ type: 'mousedown', button: 1, x: 200, y: 300, mods: M() });
    send({ type: 'mouseup', button: 1, x: 200, y: 300, mods: M() });
    send({ type: 'keydown', keycode: 0x0023, mods: M({ shift: true }) });
    send({ type: 'keyup', keycode: 0x0023, mods: M({ shift: true }) });
    send({ type: 'keydown', keycode: 0x0017, mods: M() });
    send({ type: 'keyup', keycode: 0x0017, mods: M() });
    send({ type: 'keydown', keycode: 0x001f, mods: M({ ctrl: true }) });
    send({ type: 'keyup', keycode: 0x001f, mods: M({ ctrl: true }) });
    // the click on Stop & learn, in AppuBot's window
    send({ type: 'mousedown', button: 1, x: 1200, y: 40, mods: M() });
    send({ type: 'mouseup', button: 1, x: 1200, y: 40, mods: M() });
    await vi.waitFor(() => expect(teach.status()?.stepCount).toBe(3), { timeout: 3000 });

    const before = runtime.prompts.length;
    const stopped = await teach.stop(s.id, false);
    expect(stopped.status).toBe('summarizing');
    expect(watch.stops).toBe(1);
    await vi.waitFor(() => expect(runtime.prompts.slice(before).some((p) => textOf(p.blocks).includes('Recorded steps'))).toBe(true), { timeout: 8000 });
    const prompt = runtime.prompts.slice(before).find((p) => textOf(p.blocks).includes('Recorded steps'))!;
    const text = textOf(prompt.blocks);
    expect(text).toContain('I just showed you how to do a task on this');
    expect(text).toContain('Recorded steps (3):');
    expect(text).toContain('1. Clicked in Notepad ("Untitled - Notepad") at (200,300)');
    expect(text).toContain("2. Typed 'Hi' in Notepad");
    expect(text).toContain('3. Pressed ctrl+s in Notepad');
    expect(text).not.toContain('AppuBot');
    expect(text).toContain('1 screenshot(s) taken at key clicks are attached in order.');
    expect(prompt.blocks.filter((b) => b.type === 'image')).toHaveLength(1);
    await vi.waitFor(() => expect(teach.status()?.status).toBe('done'), { timeout: 8000 });
  });

  it('goes manual where recording can\'t run, and says why', async () => {
    watch.ok = false;
    const teach = core.services.teach;
    expect(await teach.support()).toEqual({ recording: false, reason: 'Recording needs an X11 (Xorg) session' });
    const bot = core.services.bots.list()[0]!;
    const starts = watch.starts;
    const s = await teach.start(bot.id, 'File invoices', 'Save each PDF invoice in Documents/Invoices');
    expect(s.status).toBe('summarizing');
    expect(watch.starts).toBe(starts);
    await vi.waitFor(() => expect(teach.status()?.status).toBe('done'), { timeout: 8000 });
    watch.ok = true;
  });

  it('cancels a recording and stops the hooks', async () => {
    const teach = core.services.teach;
    const bot = core.services.bots.list()[0]!;
    const stops = watch.stops;
    const s = await teach.start(bot.id, 'Nothing', '');
    const c = await teach.stop(s.id, true);
    expect(c.status).toBe('cancelled');
    expect(watch.stops).toBe(stops + 1);
    expect(watch.onInput).toBeNull();
  });
});
