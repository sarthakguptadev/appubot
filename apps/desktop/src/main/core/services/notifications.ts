import { newId, type NotificationAccess, type PushKind } from '@appubot/protocol';
import type { CoreCtx, NotifyResult } from '../context';
import { RpcError } from '../util';

/** electron-builder.yml's appId: System Settings finds the app's notification pane by it */
const BUNDLE_ID = 'ai.appubot.desktop';

/** How recently the keyboard or mouse was used for the user to count as at this computer (see `atComputer`). */
export const AT_COMPUTER_MS = 2 * 60_000;

export interface NotifyOptions {
  title: string; body?: string; threadId?: string; groupId?: string; level?: 'info' | 'success' | 'warning' | 'error'; native?: boolean; kind?: 'question' | 'approval';
  /** paired phones hear of it too, through the relay (services/push.ts): what about, whose, and its line with previews on */
  push?: { kind: PushKind; botId: string; botName: string; title?: string; text: string };
}

/**
 * A notice an AppuBot Cloud computer counts for the user's Mac (`CloudNotice`): only the bot's name and the kind, no
 * text, like a phone push with previews off. The heartbeat carries them to the backend, the Mac's `cloudAccount`
 * service reads them there while its window is hidden and raises OS notifications ("Ada finished", "Ada needs you").
 */
export interface CloudNotice { seq: number; kind: PushKind; botId: string; botName: string; threadId?: string; at: number }
/** how many notices the counter keeps for the heartbeat to read back */
const CLOUD_NOTICES_KEPT = 50;

export class NotificationsService {
  /** what the OS said last time anyone asked (`access`, read again whenever the window gains focus) */
  private lastAccess: NotificationAccess = 'unknown';
  /** the cloud computer's notice counter (`noticeSeq` in its heartbeat) and the latest notices */
  private cloudSeq = 0;
  private cloudNotices: CloudNotice[] = [];

  constructor(private ctx: CoreCtx) {}

  /* ------------------------------------------------------- AppuBot Cloud */

  /** How many notices this computer has counted since it started (the heartbeat's `noticeSeq`). */
  noticeSeq(): number { return this.cloudSeq; }

  /** The notices after `seq` (the newest CLOUD_NOTICES_KEPT are kept), oldest first. */
  noticesSince(seq: number): CloudNotice[] {
    return this.cloudNotices.filter((n) => n.seq > seq);
  }

  private countCloudNotice(n: Omit<CloudNotice, 'seq' | 'at'>): void {
    this.cloudSeq += 1;
    this.cloudNotices.push({ ...n, seq: this.cloudSeq, at: Date.now() });
    if (this.cloudNotices.length > CLOUD_NOTICES_KEPT) this.cloudNotices.splice(0, this.cloudNotices.length - CLOUD_NOTICES_KEPT);
  }

  /**
   * One place for each notice, on every OS: while the app is in front of the user it is a toast in the app only;
   * otherwise an OS notification only. The toast still shows when no OS notification can go out (the app's switch is
   * off, the OS hides them, or it failed), so nothing is lost. A question's or approval's toast is the renderer's own
   * (`kind`), which follows the same rule (`lib/store.ts` `toastHere`).
   */
  notify(o: NotifyOptions): void {
    const payload = { id: newId('ntf'), title: o.title, body: o.body ?? '', threadId: o.threadId, ...(o.groupId ? { groupId: o.groupId } : {}), level: o.level ?? 'info', ...(o.kind ? { kind: o.kind } : {}), ts: Date.now() };
    // phones get it pushed whatever the user is doing here (services/push.ts decides per phone): a Mac notification
    // is easy to miss, and judging whether someone is at the computer dropped routines' notices for people who weren't
    if (o.push) {
      const p = o.push;
      // on an AppuBot Cloud computer every such notice is counted for the user's Mac too (no text goes with it)
      if (this.ctx.deps.cloud) this.countCloudNotice({ kind: p.kind, botId: p.botId, botName: p.botName, threadId: o.threadId });
      try {
        this.ctx.s.push?.notice({ nid: payload.id, kind: p.kind, botName: p.botName, botId: p.botId, threadId: o.threadId, title: p.title ?? p.botName, text: p.text });
      } catch (e) { this.ctx.log.warn('push failed', String(e)); }
    }
    const inApp = () => this.ctx.bus.emit('notification', payload);
    const s = this.ctx.s.settings.get();
    if (this.ctx.deps.isAppFocused?.() || o.native === false || !s.notifications.desktop || this.lastAccess === 'off') return inApp();
    try {
      void Promise.resolve(this.ctx.deps.nativeNotify(payload.title, payload.body, () => this.ctx.deps.showApp?.(o.threadId)))
        .then((r) => {
          if (r && !r.shown) { this.ctx.log.warn('native notification not shown', r.error ?? ''); inApp(); }
        }, (e) => { this.ctx.log.warn('native notification failed', String(e)); inApp(); });
    } catch (e) {
      this.ctx.log.warn('native notification failed', String(e));
      inApp();
    }
  }

  /**
   * Whether the user is at this computer: AppuBot's window in front, or the keyboard or mouse used in the last
   * `AT_COMPUTER_MS` with the screen unlocked. Where neither can be read (Linux without X11), they're taken as away.
   * The window asks (`appubot:atComputer`) to tell an AppuBot computer it shows (`devices.presence {desk}`); pushes no
   * longer depend on it (a phone hears of every notice).
   */
  atComputer(): boolean {
    const d = this.ctx.deps;
    if (d.isAppFocused?.()) return true;
    if (d.screenLocked?.()) return false;
    const idle = d.systemIdleMs?.();
    return idle !== undefined && idle < AT_COMPUTER_MS;
  }

  /** Settings' "Send test": shown whatever the desktop switch says, so the user can see whether the OS lets it through. */
  async test(): Promise<NotifyResult> {
    try {
      const r = await this.ctx.deps.nativeNotify('AppuBot', 'Notifications are working.');
      if (r && !r.shown) this.ctx.log.warn('test notification not shown', r.error ?? '');
      return r ?? { shown: true };
    } catch (e) {
      return { shown: false, error: String(e) };
    }
  }

  /** whether the OS shows them, read afresh (the user may have changed it in System Settings meanwhile) */
  async access(): Promise<{ access: NotificationAccess }> {
    this.lastAccess = (await this.ctx.deps.notificationAccess?.().catch(() => 'unknown' as const)) ?? 'unknown';
    return { access: this.lastAccess };
  }

  async request(): Promise<{ access: NotificationAccess }> {
    if (!this.ctx.deps.requestNotifications) return this.access();
    this.lastAccess = await this.ctx.deps.requestNotifications().catch(() => 'unknown' as const);
    return { access: this.lastAccess };
  }

  /**
   * First launch (or any launch while macOS hasn't asked yet): ask now, so the user decides with AppuBot in front of
   * them rather than when the first bot finishes. Not when they switched notifications off in AppuBot itself.
   */
  async askIfNotAsked(): Promise<void> {
    if (!this.ctx.s.settings.get().notifications.desktop) return;
    if ((await this.access()).access !== 'not-asked') return;
    const { access } = await this.request();
    this.ctx.log.info(`notifications: ${access}`);
  }

  async openSettings(): Promise<{ ok: true }> {
    if (process.platform === 'darwin') {
      await this.ctx.deps.openExternal(`x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${BUNDLE_ID}`);
    } else if (process.platform === 'win32') {
      await this.ctx.deps.openExternal('ms-settings:notifications');
    } else {
      throw new RpcError('unsupported', 'Open your desktop’s notification settings to allow AppuBot.');
    }
    return { ok: true };
  }
}
