/**
 * Restarting for a downloaded update by itself: when (`shouldRestart`, `AppUpdateService.restartTick`), what is written
 * down first and read back after the restart (the resume file), and how the stopped work goes on (`ChatService`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId, SettingsSchema, type Bot, type Message, type Thread } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import type { CoreCtx } from '../context';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { AppUpdateService, type AppUpdaterEvent, type AppUpdaterHost } from './appUpdate';
import {
  FORCE_AFTER_MS, INSTALL_GIVE_UP_MS, RESUME_MAX_AGE_MS, RESUME_PROMPT, USER_QUIET_MS, inspectResumeFile, installTried, readResumeFile, relaunchHidden,
  removeResumeFile, resumeFilePath, shouldRestart, writeResumeFile, type ResumeThread,
} from './updateRestart';

const T0 = 1_800_000_000_000;
const base = { now: T0, readySince: T0, lastActivity: 0, busyThreads: 0, voiceCall: false, required: false, focused: false, triedBefore: false };

describe('when a downloaded update restarts AppuBot', () => {
  it('restarts once nothing is going on', () => {
    expect(shouldRestart(base)).toBe(true);
  });

  it('waits while bots work, while someone uses AppuBot and during a call', () => {
    expect(shouldRestart({ ...base, busyThreads: 1 })).toBe(false);
    expect(shouldRestart({ ...base, lastActivity: T0 - USER_QUIET_MS + 1000 })).toBe(false);
    expect(shouldRestart({ ...base, lastActivity: T0 - USER_QUIET_MS })).toBe(true);
    expect(shouldRestart({ ...base, voiceCall: true })).toBe(false);
  });

  it('stops waiting for busy bots after 6 hours, but never cuts into a call or someone using AppuBot', () => {
    const late = { ...base, now: T0 + FORCE_AFTER_MS, busyThreads: 2 };
    expect(shouldRestart({ ...late, now: T0 + FORCE_AFTER_MS - 1 })).toBe(false);
    expect(shouldRestart(late)).toBe(true);
    expect(shouldRestart({ ...late, voiceCall: true })).toBe(false);
    expect(shouldRestart({ ...late, lastActivity: late.now - 1000 })).toBe(false);
  });

  it('restarts a stopped version as soon as nothing runs, someone in the app or not', () => {
    expect(shouldRestart({ ...base, required: true, lastActivity: T0, focused: true })).toBe(true);
    expect(shouldRestart({ ...base, required: true, busyThreads: 1 })).toBe(false);
  });

  it('never restarts while the window is in use, not even after 6 hours (drafts live only there)', () => {
    expect(shouldRestart({ ...base, focused: true })).toBe(false);
    expect(shouldRestart({ ...base, focused: true, now: T0 + FORCE_AFTER_MS, busyThreads: 1 })).toBe(false);
  });

  it('never restarts by itself for a version whose install was already tried (no loop when installing fails)', () => {
    expect(shouldRestart({ ...base, triedBefore: true })).toBe(false);
    expect(shouldRestart({ ...base, triedBefore: true, required: true })).toBe(false);
    expect(shouldRestart({ ...base, triedBefore: true, now: T0 + FORCE_AFTER_MS })).toBe(false);
  });
});

describe('the resume file', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'appubot-resume-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => removeResumeFile(dir));

  const work: ResumeThread[] = [{ threadId: 'thr_a', interrupted: 'msg_a', via: 'desktop', queued: ['msg_q'] }, { threadId: 'thr_b', queued: ['msg_b'] }];

  it('reads back what was written, on the version it updated to', () => {
    writeResumeFile(dir, { at: Date.now(), from: '2026.10.27', to: '2026.10.28', hidden: true, threads: work });
    expect(readResumeFile(dir, '2026.10.28')).toMatchObject({ from: '2026.10.27', to: '2026.10.28', hidden: true, threads: work });
    expect(relaunchHidden(dir, '2026.10.28')).toBe(true);
  });

  it('is ignored when the update did not happen, when it is stale or unreadable', () => {
    writeResumeFile(dir, { at: Date.now(), from: '2026.10.27', to: '2026.10.28', hidden: true, threads: work });
    // still the old version: the install never happened, and the file is kept for when it does
    expect(inspectResumeFile(dir, '2026.10.27').verdict).toBe('pending');
    expect(readResumeFile(dir, '2026.10.27')).toBeNull();
    expect(relaunchHidden(dir, '2026.10.27')).toBe(false);
    expect(existsSync(resumeFilePath(dir))).toBe(true);
    // compared as versions, not as text
    expect(readResumeFile(dir, '2026.11.1')).not.toBeNull();
    expect(readResumeFile(dir, '2026.9.30')).toBeNull();
    // a newer version than the one it left is fine (a later update got there first)
    expect(readResumeFile(dir, '2026.10.29')).not.toBeNull();
    writeResumeFile(dir, { at: Date.now() - RESUME_MAX_AGE_MS - 1, from: '2026.10.27', to: '2026.10.28', hidden: false, threads: work });
    expect(readResumeFile(dir, '2026.10.28')).toBeNull();
    // a stale one goes as soon as the window would read it
    expect(relaunchHidden(dir, '2026.10.28')).toBe(false);
    expect(existsSync(resumeFilePath(dir))).toBe(false);
    writeFileSync(resumeFilePath(dir), '{not json');
    expect(readResumeFile(dir, '2026.10.28')).toBeNull();
    removeResumeFile(dir);
    expect(readResumeFile(dir, '2026.10.28')).toBeNull();
  });
});

class FakeUpdater implements AppUpdaterHost {
  installs = 0;
  private listeners = new Set<(e: AppUpdaterEvent) => void>();
  async check() { /* nothing */ }
  install() { this.installs++; }
  onEvent(fn: (e: AppUpdaterEvent) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  emit(e: AppUpdaterEvent) { for (const l of this.listeners) l(e); }
}

describe('AppUpdateService restarting by itself', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'appubot-restart-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => { vi.useRealTimers(); removeResumeFile(dir); rmSync(join(dir, 'update-attempt.json'), { force: true }); });

  function setup(o: { busy?: number; work?: ResumeThread[]; call?: boolean; hidden?: boolean; version?: string; focused?: { now: boolean } } = {}) {
    const host = new FakeUpdater();
    const notices: string[] = [];
    const resumed: { work: ResumeThread[]; version: string }[] = [];
    const chat = {
      busy: o.busy ?? 0,
      busyThreads: () => chat.busy,
      workToResume: () => o.work ?? [],
      resumeAfterUpdate: (work: ResumeThread[], version: string) => { resumed.push({ work, version }); },
      cancelAll: async () => undefined,
    };
    const ctx = {
      deps: { appUpdater: host, version: o.version ?? '2026.10.27', voiceCallOpen: () => !!o.call, windowHidden: () => !!o.hidden, isAppFocused: () => !!o.focused?.now },
      paths: { dataDir: dir },
      log: silentLogger,
      bus: { emit: () => undefined },
      s: {
        settings: { get: () => SettingsSchema.parse({}) },
        notifications: { notify: (n: { title: string }) => { notices.push(n.title); } },
        chat,
        system: { info: () => ({}) },
      },
    } as unknown as CoreCtx;
    const svc = new AppUpdateService(ctx);
    svc.start();
    return { svc, host, chat, notices, resumed };
  }

  it('does nothing until an update is downloaded', () => {
    const { svc, host } = setup();
    expect(svc.restartTick()).toBe(false);
    expect(host.installs).toBe(0);
    svc.stop();
  });

  it('restarts when idle: tells the user, writes down the work, then installs', () => {
    vi.useFakeTimers();
    const work: ResumeThread[] = [{ threadId: 'thr_x', queued: ['msg_1'] }];
    const { svc, host, notices } = setup({ work, hidden: true });
    host.emit({ type: 'downloaded', version: '2026.10.28' });
    expect(svc.restartTick()).toBe(true);
    expect(notices.at(-1)).toBe('Updating AppuBot to 2026.10.28');
    expect(host.installs).toBe(0);
    vi.advanceTimersByTime(1500);
    expect(host.installs).toBe(1);
    expect(readResumeFile(dir, '2026.10.28')).toMatchObject({ from: '2026.10.27', to: '2026.10.28', hidden: true, threads: work });
    // once begun, it doesn't start over
    expect(svc.restartTick()).toBe(false);
    svc.stop();
  });

  it('checks every 30 seconds, waits for busy bots, a call and the user, and gives up waiting for bots after 6 hours', () => {
    vi.useFakeTimers();
    const { svc, host, chat } = setup({ busy: 1 });
    host.emit({ type: 'downloaded', version: '2026.10.28' });
    vi.advanceTimersByTime(30_000 * 4);
    expect(host.installs).toBe(0);
    chat.busy = 0;
    svc.noteActivity(Date.now());
    vi.advanceTimersByTime(60_000);
    expect(host.installs).toBe(0);
    vi.advanceTimersByTime(USER_QUIET_MS + 30_000 + 1500);
    expect(host.installs).toBe(1);
    svc.stop();
    // a fresh start: that install was never tried here
    rmSync(join(dir, 'update-attempt.json'), { force: true });

    const busy = setup({ busy: 3 });
    busy.host.emit({ type: 'downloaded', version: '2026.10.28' });
    vi.advanceTimersByTime(FORCE_AFTER_MS - 60_000);
    expect(busy.host.installs).toBe(0);
    vi.advanceTimersByTime(60_000 + 30_000 + 1500);
    expect(busy.host.installs).toBe(1);
    busy.svc.stop();
    rmSync(join(dir, 'update-attempt.json'), { force: true });

    const call = setup({ call: true });
    call.host.emit({ type: 'downloaded', version: '2026.10.28' });
    vi.advanceTimersByTime(FORCE_AFTER_MS + 60_000);
    expect(call.host.installs).toBe(0);
    call.svc.stop();
  });

  it('does not restart while the window is in use, and lets the user coming back in the last moment stop it', () => {
    vi.useFakeTimers();
    const focused = { now: true };
    const { svc, host, notices } = setup({ focused });
    host.emit({ type: 'downloaded', version: '2026.10.28' });
    expect(svc.restartTick()).toBe(false);
    focused.now = false;
    expect(svc.restartTick()).toBe(true);
    // the user clicks into AppuBot while the notice shows: no install, and it tries again later
    focused.now = true;
    vi.advanceTimersByTime(1500);
    expect(host.installs).toBe(0);
    expect(notices.at(-1)).toBe('Updating AppuBot to 2026.10.28');
    focused.now = false;
    vi.advanceTimersByTime(30_000 + 1500);
    expect(host.installs).toBe(1);
    svc.stop();
  });

  it('tries a version\'s install by itself only once: an old version back after a failed install waits for the user', () => {
    vi.useFakeTimers();
    const first = setup();
    first.host.emit({ type: 'downloaded', version: '2026.10.28' });
    first.svc.restartTick();
    vi.advanceTimersByTime(1500);
    expect(first.host.installs).toBe(1);
    expect(installTried(dir, '2026.10.28')).toBe(true);
    // the install failed and AppuBot carried on: after a while it can be tried again by hand
    expect(first.svc.restartTick()).toBe(false);
    vi.advanceTimersByTime(INSTALL_GIVE_UP_MS);
    expect(first.svc.restartTick()).toBe(false);
    first.svc.install();
    expect(first.host.installs).toBe(2);
    first.svc.stop();

    // relaunched on the old version: the cached download is ready again at once, and nothing restarts by itself
    const again = setup();
    again.host.emit({ type: 'downloaded', version: '2026.10.28' });
    vi.advanceTimersByTime(30_000 * 10);
    expect(again.host.installs).toBe(0);
    // a newer version is tried by itself again
    again.host.emit({ type: 'downloaded', version: '2026.10.29' });
    vi.advanceTimersByTime(30_000 + 1500);
    expect(again.host.installs).toBe(1);
    again.svc.stop();
  });

  it('keeps the work for later when the install did not happen yet, and drops a stale file', () => {
    const work: ResumeThread[] = [{ threadId: 'thr_k', queued: ['msg_k'] }];
    writeResumeFile(dir, { at: Date.now(), from: '2026.10.27', to: '2026.10.28', hidden: false, threads: work });
    const old = setup({ version: '2026.10.27' });
    old.svc.resumeAfterUpdate();
    expect(old.resumed).toEqual([]);
    expect(existsSync(resumeFilePath(dir))).toBe(true);
    old.svc.stop();
    writeResumeFile(dir, { at: Date.now() - RESUME_MAX_AGE_MS - 1, from: '2026.10.27', to: '2026.10.28', hidden: false, threads: work });
    const late = setup({ version: '2026.10.28' });
    late.svc.resumeAfterUpdate();
    expect(late.resumed).toEqual([]);
    expect(existsSync(resumeFilePath(dir))).toBe(false);
    late.svc.stop();
  });

  it('writes the work down for a restart the user asked for, too', () => {
    const work: ResumeThread[] = [{ threadId: 'thr_y', interrupted: 'msg_y', via: 'desktop', queued: [] }];
    const { svc, host } = setup({ work });
    host.emit({ type: 'downloaded', version: '2026.10.28' });
    svc.install();
    expect(host.installs).toBe(1);
    expect(readResumeFile(dir, '2026.10.28')?.threads).toEqual(work);
    svc.stop();
  });

  it('after the restart, hands the work to the chats once and removes the file', () => {
    const work: ResumeThread[] = [{ threadId: 'thr_z', queued: ['msg_z'] }];
    writeResumeFile(dir, { at: Date.now(), from: '2026.10.27', to: '2026.10.28', hidden: false, threads: work });
    const { svc, resumed } = setup({ version: '2026.10.28' });
    svc.resumeAfterUpdate();
    expect(resumed).toEqual([{ work, version: '2026.10.28' }]);
    expect(existsSync(resumeFilePath(dir))).toBe(false);
    svc.resumeAfterUpdate();
    expect(resumed).toHaveLength(1);
    svc.stop();
  });
});

describe('the chats after a restart for an update', () => {
  let core: Core;
  let runtime: FakeRuntime;
  let root: string;
  let bot: Bot;
  let thread: Thread;
  const text = (m: Message | undefined): string => (m?.parts ?? []).flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
  const promptText = (i: number): string => runtime.prompts[i]!.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
  const idle = () => vi.waitFor(() => {
    expect(core.services.chat.busyThreads()).toBe(0);
    expect(core.services.threads.require(thread.id).status).toBe('idle');
  });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'appubot-resume-chat-'));
    core = createCore({
      paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
      runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
      openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
      version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, quiet: true,
    });
    await core.start();
    bot = core.services.bots.create({ name: 'Carry', providerId: 'claude-code' } as Parameters<typeof core.services.bots.create>[0]);
    thread = core.services.threads.chatFor(bot.id);
    runtime.reply = (t) => (t.includes('restarted to install an update') ? 'Picking the report back up.' : `ok: ${t.split('\n').at(-1)}`);
  });

  afterAll(async () => {
    await core.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('lists the turn running and the messages waiting behind it, not AppuBot\'s own turns', async () => {
    runtime.steering = false;
    const before = runtime.prompts.length;
    core.services.chat.send({ threadId: thread.id, text: 'write the slow report', attachments: [], images: [] });
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(before + 1));
    const queued = core.services.chat.send({ threadId: thread.id, text: 'then email it', attachments: [], images: [] });
    const work = core.services.chat.workToResume();
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ threadId: thread.id, via: 'desktop', queued: [queued.userMessage.id] });
    expect(work[0]!.interrupted).toBeTruthy();
    expect(core.services.chat.busyThreads()).toBe(1);
    await core.services.chat.cancel(thread.id);
    await idle();
    expect(core.services.chat.workToResume()).toEqual([]);
  });

  it('closes the cut-off reply, says so, tells the bot to carry on and sends what was waiting', async () => {
    // a reply cut off by the restart (still "streaming" in the saved thread) and a message that hadn't reached the bot
    // saved before the restart: older than anything resuming adds
    const now = Date.now() - 50;
    const cut: Message = { id: newId('msg'), threadId: thread.id, role: 'agent', parts: [{ type: 'text', text: 'Half a rep' }], status: 'streaming', via: 'desktop', createdAt: now, updatedAt: now };
    const waiting: Message = { id: newId('msg'), threadId: thread.id, role: 'user', parts: [{ type: 'text', text: 'and add the totals' }], status: 'complete', via: 'desktop', createdAt: now + 1, updatedAt: now + 1 };
    core.services.threads.addMessage(cut);
    core.services.threads.addMessage(waiting);
    const before = runtime.prompts.length;
    const users = core.services.threads.messages(thread.id, { limit: 50 }).filter((m) => m.role === 'user').length;

    core.services.chat.resumeAfterUpdate([{ threadId: thread.id, interrupted: cut.id, via: 'desktop', queued: [waiting.id] }], '2026.10.28');
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(before + 2));
    await idle();

    expect(core.services.threads.findMessage(thread.id, cut.id)).toMatchObject({ status: 'cancelled', stopReason: 'restarted' });
    expect(promptText(before)).toContain(RESUME_PROMPT);
    expect(promptText(before + 1)).toContain('and add the totals');
    const all = core.services.threads.messages(thread.id, { limit: 50 });
    const after = all.slice(all.findIndex((m) => m.id === cut.id) + 1);
    // the notice, then the bot carrying on, then the answer to the message that was waiting; no new user message
    const notice = after.findIndex((m) => m.parts.some((p) => p.type === 'system' && p.text === 'AppuBot updated to 2026.10.28 and picked up where it left off.'));
    const carryOn = after.findIndex((m) => m.role === 'agent' && text(m) === 'Picking the report back up.');
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(carryOn).toBeGreaterThan(notice);
    expect(after.some((m) => m.role === 'agent' && text(m) === 'ok: and add the totals')).toBe(true);
    expect(all.filter((m) => m.role === 'user')).toHaveLength(users);
  });

  it('skips threads that are gone', () => {
    expect(() => core.services.chat.resumeAfterUpdate([{ threadId: 'thr_gone', interrupted: 'msg_gone', queued: ['msg_gone2'] }], '2026.10.28')).not.toThrow();
  });

  // last: the chats stay shut down
  it('starts nothing queued while AppuBot shuts down (it is picked up after the restart instead)', async () => {
    const before = runtime.prompts.length;
    core.services.chat.send({ threadId: thread.id, text: 'one more slow thing', attachments: [], images: [] });
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(before + 1));
    core.services.chat.send({ threadId: thread.id, text: 'and after that', attachments: [], images: [] });
    const work = core.services.chat.workToResume();
    await core.services.chat.shutdown();
    await runtime.cancel(runtime.prompts[before]!.sessionId);
    await new Promise((r) => setTimeout(r, 50));
    expect(runtime.prompts.length).toBe(before + 1);
    expect(work[0]?.queued).toHaveLength(1);
  });
});
