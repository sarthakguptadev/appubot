import { describe, expect, it } from 'vitest';
import type { CoreCtx, NotifyResult } from '../context';
import { NotificationsService } from './notifications';

function setup(o: { focused: boolean; desktop?: boolean; result?: NotifyResult; access?: 'on' | 'off' }) {
  const inApp: string[] = [];
  const native: string[] = [];
  const ctx = {
    deps: {
      isAppFocused: () => o.focused,
      nativeNotify: async (title: string) => { native.push(title); return o.result ?? { shown: true }; },
      notificationAccess: async () => o.access ?? 'on',
    },
    bus: { emit: (_: string, p: { title: string }) => { inApp.push(p.title); } },
    s: { settings: { get: () => ({ notifications: { desktop: o.desktop ?? true } }) } },
    log: { warn: () => undefined, info: () => undefined },
  } as unknown as CoreCtx;
  return { svc: new NotificationsService(ctx), inApp, native };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('NotificationsService.notify', () => {
  it('is a toast in the app only while the app is in front', async () => {
    const { svc, inApp, native } = setup({ focused: true });
    svc.notify({ title: 'Done' });
    await settle();
    expect(inApp).toEqual(['Done']);
    expect(native).toEqual([]);
  });

  it('is an OS notification only while the app is not in front', async () => {
    const { svc, inApp, native } = setup({ focused: false });
    svc.notify({ title: 'Done' });
    await settle();
    expect(native).toEqual(['Done']);
    expect(inApp).toEqual([]);
  });

  it('falls back to the toast when no OS notification can go out', async () => {
    for (const o of [{ desktop: false }, { result: { shown: false, error: 'denied' } }]) {
      const { svc, inApp, native } = setup({ focused: false, ...o });
      svc.notify({ title: 'Done' });
      await settle();
      expect(inApp).toEqual(['Done']);
      expect(native.length).toBeLessThanOrEqual(1);
    }
    const off = setup({ focused: false, access: 'off' });
    await off.svc.access();
    off.svc.notify({ title: 'Done' });
    await settle();
    expect(off.native).toEqual([]);
    expect(off.inApp).toEqual(['Done']);
    const quiet = setup({ focused: false });
    quiet.svc.notify({ title: 'Connected', native: false });
    expect(quiet.inApp).toEqual(['Connected']);
  });
});

describe('the cloud notice counter', () => {
  it('counts each pushed notice on a cloud computer (name and kind, no text), nowhere else', () => {
    const push = { kind: 'done' as const, botId: 'b1', botName: 'Ada', text: 'Finished the report' };
    const mac = setup({ focused: false });
    mac.svc.notify({ title: 'Ada', body: 'Finished', push });
    expect(mac.svc.noticeSeq()).toBe(0);
    const inApp: string[] = [];
    const pushed: unknown[] = [];
    const ctx = {
      deps: { cloud: { publicUrl: '', controlToken: '', backendUrl: '', backendToken: '', maxLiveSessions: 3 }, nativeNotify: async () => ({ shown: false, error: 'headless' }) },
      bus: { emit: (_: string, p: { title: string }) => { inApp.push(p.title); } },
      s: { settings: { get: () => ({ notifications: { desktop: true } }) }, push: { notice: (n: unknown) => pushed.push(n) } },
      log: { warn: () => undefined, info: () => undefined },
    } as unknown as CoreCtx;
    const cloud = new NotificationsService(ctx);
    cloud.notify({ title: 'Ada', body: 'Finished the report', threadId: 't1', push });
    cloud.notify({ title: 'Ada', body: 'Which one?', threadId: 't1', push: { ...push, kind: 'needs-you' } });
    cloud.notify({ title: 'Plain', body: 'no push' });
    expect(cloud.noticeSeq()).toBe(2);
    expect(pushed).toHaveLength(2);
    const since = cloud.noticesSince(0);
    expect(since.map((n) => [n.seq, n.kind, n.botName, n.threadId])).toEqual([[1, 'done', 'Ada', 't1'], [2, 'needs-you', 'Ada', 't1']]);
    expect(JSON.stringify(since)).not.toContain('Finished the report');
    expect(cloud.noticesSince(1)).toHaveLength(1);
    expect(cloud.noticesSince(2)).toEqual([]);
  });
});
