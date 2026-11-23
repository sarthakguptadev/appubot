import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STOPPED_MESSAGE, compareVersions, parseVersionPolicy, phoneStoppedBy, stoppedBy, type VersionPolicy } from '@appubot/chat-core';
import type { AppUpdateStatus, DeviceIdentity } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { systemDirOf } from '../context';
import { RpcError, errMsg } from '../util';
import { INSTALL_GIVE_UP_MS, RESTART_CHECK_MS, inspectResumeFile, installTried, noteInstallAttempt, removeResumeFile, shouldRestart, writeResumeFile } from './updateRestart';

/** What the updater (electron-updater in the app) reports while it checks and downloads. */
export type AppUpdaterEvent =
  | { type: 'checking' }
  | { type: 'none' }
  | { type: 'available'; version: string }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string };

/**
 * AppuBot's own updates (electron-updater in the packaged app: `electron/appUpdater.ts`; absent in dev builds, test
 * instances and builds that can't update themselves). A newer release is downloaded as soon as it's found.
 */
export interface AppUpdaterHost {
  /** looks for a newer release (and starts downloading it); resolves once the check is done, rejects when it failed */
  check(): Promise<void>;
  /** quits AppuBot without asking, installs the downloaded update and opens AppuBot again */
  install(): void;
  /** returns an unsubscribe */
  onEvent(fn: (e: AppUpdaterEvent) => void): () => void;
}

/** the first background check, once launching has settled */
const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 4 * 3600_000;

/**
 * Which versions still work: version-policy.json in the public releases repo (`pnpm version-policy`,
 * scripts/version-policy.mjs, writes it; the rules and their reading are chat-core `versionPolicy.ts`, shared with the
 * phone). A version below `minVersion`, or one in `blocked`, is stopped: it shows `message` and refuses everything but
 * updating until it's updated. Its `phone` rules are applied to the phones that connect here (`phoneStopped`).
 */
export { STOPPED_MESSAGE, stoppedBy };
export type { VersionPolicy };
/** the first policy read, once launching has settled, then every half hour */
const POLICY_FIRST_MS = 5_000;
const POLICY_EVERY_MS = 30 * 60_000;

export { compareVersions };

/** electron-updater's messages carry HTTP bodies and stacks: the first line, kept short */
export function shortError(message: string): string {
  const line = message.split('\n').map((l) => l.trim()).find(Boolean) ?? 'Unknown error';
  if (/\b404\b|Unable to find latest version|No published versions/i.test(line)) return 'No release published yet.';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|net::ERR_/i.test(line)) return 'No connection to GitHub.';
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

export class AppUpdateService {
  private state: AppUpdateStatus = { state: 'idle' };
  private timer: NodeJS.Timeout | null = null;
  private offs: (() => void)[] = [];
  private checking: Promise<void> | null = null;
  /** the version a notification already went out for */
  private told = '';
  /** this version was stopped by the version policy */
  private required: { message: string } | undefined;
  /** the policy in force (the saved one at start, then each read) */
  private policy: VersionPolicy = {};
  private policyTimer: NodeJS.Timeout | null = null;
  /** a downloaded update looking for a moment to restart (`restartTick`) */
  private restartTimer: NodeJS.Timeout | null = null;
  private readySince = 0;
  /** the last call that means someone is using AppuBot (`noteActivity`) */
  private lastActivity = 0;
  /** the restart has begun (the notification is out, the quit follows) */
  private restarting = false;
  private resumeTimer: NodeJS.Timeout | null = null;

  constructor(private ctx: CoreCtx) {}

  private get host(): AppUpdaterHost | undefined { return this.ctx.deps.appUpdater; }

  status(): AppUpdateStatus {
    const status: AppUpdateStatus = this.host ? this.state : { state: 'unsupported' };
    return this.required ? { ...status, required: this.required } : status;
  }

  /** this version was stopped (the version policy): the message the window shows */
  get stopped(): { message: string } | undefined { return this.required; }

  /**
   * A phone app the policy stopped (its `phone` rules against the version the device says): what it must show, or null
   * while it may connect. Only phones; a device that names no version is let through.
   */
  phoneStopped(device: Pick<DeviceIdentity, 'platform' | 'appVersion'>): string | null {
    if (device.platform !== 'ios' && device.platform !== 'android') return null;
    return phoneStoppedBy(this.policy, device.appVersion, device.platform);
  }

  /** Throws `update_required` while this version is stopped. */
  assertWorking(): void {
    if (this.required) throw new RpcError('update_required', this.required.message);
  }

  start(): void {
    this.startPolicy();
    const host = this.host;
    if (!host) return;
    this.offs.push(host.onEvent((e) => this.onEvent(e)));
    this.schedule(FIRST_CHECK_MS);
  }

  stop(): void {
    this.schedule(null);
    if (this.restartTimer) clearInterval(this.restartTimer);
    this.restartTimer = null;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    if (this.policyTimer) clearTimeout(this.policyTimer);
    this.policyTimer = null;
    for (const off of this.offs.splice(0)) off();
  }

  /** Settings › About's "Check for updates" (and the background checks): a download or check in flight is waited on, not repeated. */
  async check(): Promise<AppUpdateStatus> {
    const host = this.host;
    if (!host) throw new RpcError('unsupported', 'This build of AppuBot doesn’t update itself. Install it from the download page to get updates.');
    if (this.state.state === 'downloading' || this.state.state === 'ready') return this.state;
    this.checking ??= host.check()
      .catch((e) => this.onEvent({ type: 'error', message: errMsg(e) }))
      .finally(() => { this.checking = null; });
    await this.checking;
    return this.state;
  }

  install(): { ok: true } {
    const host = this.host;
    if (!host) throw new RpcError('unsupported', 'This build of AppuBot doesn’t update itself.');
    if (this.state.state !== 'ready') throw new RpcError('unavailable', 'No update has been downloaded yet.');
    const version = this.state.version ?? '';
    this.ctx.log.info(`installing AppuBot ${version}`);
    try { noteInstallAttempt(this.ctx.paths.dataDir, version); } catch (e) { this.ctx.log.warn('noting the install failed', errMsg(e)); }
    this.saveResume(version);
    this.restarting = true;
    host.install();
    // still here a while later: the install failed (the host lets the quit prompt work again); the user may retry
    const t = setTimeout(() => {
      this.restarting = false;
      this.ctx.log.warn(`installing AppuBot ${version} didn't restart it`);
    }, INSTALL_GIVE_UP_MS);
    t.unref?.();
    return { ok: true };
  }

  /** Someone is using AppuBot (gateway: a call in `ACTIVITY_METHODS`): a downloaded update waits for them. */
  noteActivity(at = Date.now()): void { this.lastActivity = at; }

  /**
   * A downloaded update restarts AppuBot by itself once nothing is going on (`shouldRestart`), checked every 30 s;
   * the work the restart stops is written down first and picked up after it (`resumeAfterUpdate`).
   */
  restartTick(now = Date.now()): boolean {
    if (this.restarting || !this.canRestart(now)) return false;
    this.restarting = true;
    const version = this.state.version ?? '';
    const busy = this.ctx.s.chat.busyThreads();
    this.ctx.log.info(`restarting for AppuBot ${version}${busy ? ` with ${busy} busy thread(s)` : ''}`);
    this.ctx.s.notifications.notify({ title: `Updating AppuBot to ${version}`, body: 'Back in a moment.', level: 'info' });
    // a moment for the notice to show; whatever changed meanwhile (the user came back, a message went out) wins
    const t = setTimeout(() => {
      this.restarting = false;
      if (!this.canRestart(Date.now())) return;
      try { this.install(); } catch (e) { this.ctx.log.warn('restarting for the update failed', errMsg(e)); }
    }, 1500);
    t.unref?.();
    return true;
  }

  private canRestart(now: number): boolean {
    if (this.state.state !== 'ready' || !this.host) return false;
    return shouldRestart({
      now, readySince: this.readySince, lastActivity: this.lastActivity, busyThreads: this.ctx.s.chat.busyThreads(),
      voiceCall: !!this.ctx.deps.voiceCallOpen?.(), required: !!this.required,
      focused: !!this.ctx.deps.isAppFocused?.(), triedBefore: installTried(this.ctx.paths.dataDir, this.state.version ?? ''),
    });
  }

  /** What the restart stops, written down for the next start (and whether the window was out of sight). */
  private saveResume(to: string): void {
    try {
      writeResumeFile(this.ctx.paths.dataDir, {
        at: Date.now(), from: this.ctx.deps.version, to,
        hidden: !!this.ctx.deps.windowHidden?.(),
        threads: this.ctx.s.chat.workToResume(),
      });
    } catch (e) {
      this.ctx.log.warn('saving the work to resume failed', errMsg(e));
    }
  }

  /** Picks the stopped work up a few seconds after launch (once the agents' sign-ins have been looked at). */
  scheduleResume(inMs = 5000): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => { this.resumeTimer = null; this.resumeAfterUpdate(); }, inMs);
    this.resumeTimer.unref?.();
  }

  /**
   * After the restart: the work it stopped goes on (once; the file is removed). Still the old version (the install
   * didn't happen): the file stays for when it does; too old or unreadable: it goes.
   */
  resumeAfterUpdate(): void {
    const dir = this.ctx.paths.dataDir;
    const { verdict, file } = inspectResumeFile(dir, this.ctx.deps.version);
    if (verdict === 'pending' || verdict === 'none') return;
    removeResumeFile(dir);
    if (verdict !== 'use' || !file?.threads.length) return;
    this.ctx.log.info(`resuming ${file.threads.length} thread(s) after the update to ${this.ctx.deps.version}`);
    this.ctx.s.chat.resumeAfterUpdate(file.threads, this.ctx.deps.version);
  }

  private get policyFile(): string { return join(systemDirOf(this.ctx.paths), 'version-policy.json'); }

  /**
   * The policy read last applies at once (a stopped version stays stopped offline and across restarts), then a fresh
   * one is read shortly after launch and every half hour. Only the packaged app has a policy URL.
   */
  private startPolicy(): void {
    if (!this.ctx.deps.versionPolicyUrl) return;
    try {
      if (existsSync(this.policyFile)) this.applyPolicy(parseVersionPolicy(JSON.parse(readFileSync(this.policyFile, 'utf8'))), false);
    } catch (e) {
      this.ctx.log.warn('reading the saved version policy failed', errMsg(e));
    }
    const tick = (inMs: number): void => {
      this.policyTimer = setTimeout(() => {
        void this.refreshPolicy().finally(() => { if (this.policyTimer) tick(POLICY_EVERY_MS); });
      }, inMs);
      this.policyTimer.unref?.();
    };
    tick(POLICY_FIRST_MS);
  }

  /** Reads version-policy.json: none there (404) is an empty policy; a failed read keeps the one in force. */
  async refreshPolicy(): Promise<void> {
    const url = this.ctx.deps.versionPolicyUrl;
    if (!url) return;
    try {
      const res = await (this.ctx.deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
      if (res.status === 404) return this.applyPolicy({}, true);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.applyPolicy(parseVersionPolicy(await res.json()), true);
    } catch (e) {
      this.ctx.log.warn('reading the version policy failed', errMsg(e));
    }
  }

  private applyPolicy(policy: VersionPolicy, save: boolean): void {
    if (save) {
      try { writeFileSync(this.policyFile, JSON.stringify(policy)); } catch (e) { this.ctx.log.warn('saving the version policy failed', errMsg(e)); }
    }
    this.policy = policy;
    const message = stoppedBy(policy, this.ctx.deps.version);
    if (message === (this.required?.message ?? null)) return;
    const was = !!this.required;
    this.required = message ? { message } : undefined;
    if (this.required && !was) {
      this.ctx.log.warn(`AppuBot ${this.ctx.deps.version} was stopped: ${message}`);
      void this.onStopped(this.required.message);
    } else if (!this.required) {
      this.ctx.log.info(`AppuBot ${this.ctx.deps.version} works again`);
    }
    this.ctx.bus.emit('system.updated', this.ctx.s.system.info());
  }

  /** Stopped: running turns end, the user hears why, and the update is looked for at once. */
  private async onStopped(message: string): Promise<void> {
    this.ctx.s.notifications.notify({ title: 'AppuBot needs an update', body: message, level: 'warning' });
    this.ctx.s.analytics?.capture('version_stopped');
    await this.ctx.s.chat.cancelAll().catch((e) => this.ctx.log.warn('stopping running turns failed', errMsg(e)));
    if (this.host) void this.check().catch(() => undefined);
  }

  /** null: no more background checks */
  private schedule(inMs: number | null): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (inMs === null) return;
    this.timer = setTimeout(() => {
      void this.check().catch(() => { /* in the status */ }).finally(() => {
        if (this.timer) this.schedule(CHECK_EVERY_MS);
      });
    }, inMs);
    this.timer.unref?.();
  }

  private onEvent(e: AppUpdaterEvent): void {
    const prev = this.state;
    switch (e.type) {
      case 'checking':
        // a download in flight or done stays as it is
        if (prev.state === 'downloading' || prev.state === 'ready') return;
        this.state = { ...(prev.checkedAt ? { checkedAt: prev.checkedAt } : {}), state: 'checking' };
        break;
      case 'none':
        this.state = { state: 'up-to-date', checkedAt: Date.now() };
        break;
      case 'available':
        this.ctx.log.info(`AppuBot ${e.version} is available: downloading`);
        this.state = { state: 'downloading', version: e.version, percent: 0, checkedAt: Date.now() };
        break;
      case 'progress': {
        const percent = Math.max(0, Math.min(100, Math.floor(e.percent)));
        if (prev.state !== 'downloading' || prev.percent === percent) return;
        this.state = { ...prev, percent };
        break;
      }
      case 'downloaded':
        this.state = { state: 'ready', version: e.version, checkedAt: prev.checkedAt ?? Date.now() };
        this.ctx.log.info(`AppuBot ${e.version} downloaded`);
        if (!this.readySince) this.readySince = Date.now();
        if (this.told !== e.version) {
          this.told = e.version;
          this.ctx.s.notifications.notify({
            title: `AppuBot ${e.version} is ready`, level: 'success',
            body: 'AppuBot restarts by itself to install it once your bots are idle, and they carry on where they left off.',
          });
        }
        if (!this.restartTimer) {
          this.restartTimer = setInterval(() => this.restartTick(), RESTART_CHECK_MS);
          this.restartTimer.unref?.();
        }
        break;
      case 'error':
        // a finished download still installs on quit, whatever a later check says
        if (prev.state === 'ready') return;
        this.ctx.log.warn('app update failed', e.message);
        this.state = { state: 'error', error: shortError(e.message), ...(prev.version ? { version: prev.version } : {}), checkedAt: Date.now() };
        break;
    }
    this.ctx.bus.emit('system.updated', this.ctx.s.system.info());
  }
}
