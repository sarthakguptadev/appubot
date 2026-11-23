/**
 * Keeping this Mac on for the bots. `keepAwake` holds an idle-sleep blocker for as long as AppuBot runs (powerd drops
 * it if the app dies). `lidClosed` also switches system sleep off (`pmset -a disablesleep 1`, through a one-time
 * sudoers rule the Mac's password installs), so closing the lid doesn't sleep the Mac. That switch is system-wide and
 * survives a reboot, so it is undone on quit, at the next start after a crash (each run's marker file), by a watchdog
 * that outlives the app, by a LaunchAgent at the next login after a reboot, below 15% battery and while the Mac runs
 * hot. Sleep we didn't switch off (no marker) is never touched: the user may run Amphetamine. The Electron side lives
 * behind `PowerHost` (electron/power.ts; absent in tests, on other platforms and in dev-harness instances).
 */
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { machineName, type PowerStatus, type Settings } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { Mutex, RpcError, errMsg } from '../util';

export type ThermalState = 'unknown' | 'nominal' | 'fair' | 'serious' | 'critical';

export interface PowerHost {
  /** hold / drop the idle-sleep blocker (Electron powerSaveBlocker 'prevent-app-suspension') */
  preventSleep(): void;
  allowSleep(): void;
  onBattery(): boolean;
  /** undefined without a battery */
  batteryPct(): Promise<number | undefined>;
  thermalState(): ThermalState;
  /** the power source or the thermal state changed; returns an unsubscribe */
  onChange(fn: () => void): () => void;
  /** IOPMrootDomain SleepDisabled, whoever set it */
  sleepDisabled(): Promise<boolean>;
  /** when this boot started (ms since the epoch, `kern.boottime`) */
  bootTime(): Promise<number | undefined>;
  /** this user's rule only */
  lidRuleInstalled(): Promise<boolean>;
  /** asks for the Mac's password; rejects when the user cancels */
  installLidRule(): Promise<void>;
  /** asks for the Mac's password; with `restoreSleep` switches sleep back on first (as root) and keeps the rule if that fails */
  removeLidRule(o: { restoreSleep: boolean }): Promise<void>;
  /** `sudo -n pmset -a disablesleep 1|0` through the rule */
  setSleepDisabled(on: boolean): Promise<void>;
  /** a detached process that switches sleep back on once this one dies, if its marker is still there */
  startWatchdog(markerPath: string): void;
  stopWatchdog(): void;
  /** a LaunchAgent that switches sleep back on at the next login if a marker in `markerDir` predates that boot */
  installRecovery(markerDir: string): void;
  removeRecovery(): void;
  /** how the user can switch sleep back on by hand when that fails (default: macOS's pmset in Terminal) */
  restoreHint?: string;
}

export const LOW_BATTERY_PCT = 15;
export const RESUME_BATTERY_PCT = 20;
const BATTERY_POLL_MS = 60_000;
/** the single, Mac-wide rule file of earlier builds (it names one user) */
export const LEGACY_LID_RULE_PATH = '/etc/sudoers.d/appubot_pmset';
export const RECOVERY_LABEL = 'ai.appubot.desktop.power-recovery';
const PHONE_SETUP = 'Turn this on from the Mac the first time: it needs the Mac’s password once.';
/** `power-lid-<pid>.json`, one per run (and the single `power-lid.json` of earlier builds) */
const MARKER_RE = /^power-lid(?:-\d+)?\.json$/;

/** One rule file per user, so one user's install or removal never touches another's (no dot, or sudo skips it). */
export function lidRulePath(user: string): string {
  return `/etc/sudoers.d/appubot_pmset_${user.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** The sudoers rule: exactly these two commands, for this user only (no alias, which two users' files would both define). */
export function lidRuleLines(user: string): string[] {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(user)) throw new Error(`Can’t write a sleep rule for the user name “${user}”.`);
  return [`${user} ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0`];
}

/** `sysctl -n kern.boottime`: "{ sec = 1791952593, usec = 668016 } Wed Oct 14 …" → ms. */
export function parseBootTime(out: string): number | undefined {
  const m = /\bsec = (\d+)/.exec(out);
  return m ? Number(m[1]) * 1000 : undefined;
}

/** `pmset -g batt`: "-InternalBattery-0 (id=…)\t63%; charging; …"; a Mac without a battery has no such line. */
export function parseBatteryPct(out: string): number | undefined {
  const m = /(\d{1,3})%;/.exec(out);
  return m ? Math.min(100, Number(m[1])) : undefined;
}

/** `ioreg -rn IOPMrootDomain -d1`: `"SleepDisabled" = Yes|No`. */
export function parseSleepDisabled(out: string): boolean {
  return /"SleepDisabled"\s*=\s*Yes/.test(out);
}

/**
 * The watchdog, for `/bin/sh -c <script> name <pid> <marker>`: wait while the app lives, then run `restore` only if
 * the marker still names that pid (a quick relaunch that rewrote it keeps its lid mode).
 */
export function watchdogScript(restore: string): string {
  return [
    'while kill -0 "$1" 2>/dev/null; do /bin/sleep 5; done',
    '/usr/bin/grep -q "\\"pid\\":$1[,}]" "$2" 2>/dev/null || exit 0',
    `${restore} && /bin/rm -f "$2"`,
  ].join('\n');
}

/**
 * The login-time recovery, for `/bin/sh -c <script> name <markerDir> <plist>`: markers from before this boot (or
 * unreadable) mean a run never got to switch sleep back on, so `restore` runs if `sleepOff` says sleep is still off;
 * once it worked they go. With no marker left the agent removes its own plist; a marker from this boot is a live run's.
 */
export function recoveryScript(restore: string, sleepOff: string): string {
  return [
    `boot=$(/usr/sbin/sysctl -n kern.boottime 2>/dev/null | /usr/bin/sed -n 's/^{ sec = \\([0-9]*\\),.*/\\1/p')`,
    '[ -n "$boot" ] || exit 0',
    `old() { s=$(/usr/bin/sed -n 's/.*"since":\\([0-9]*\\).*/\\1/p' "$1" 2>/dev/null); [ -z "$s" ] || [ $((s / 1000)) -lt "$boot" ]; }`,
    'stale=0; live=0',
    'for m in "$1"/power-lid*.json; do [ -f "$m" ] || continue; if old "$m"; then stale=1; else live=1; fi; done',
    'if [ "$stale" = 1 ]; then',
    `  if ${sleepOff}; then ${restore} || exit 1; fi`,
    '  for m in "$1"/power-lid*.json; do [ -f "$m" ] && old "$m" && /bin/rm -f "$m"; done',
    'fi',
    '[ "$live" = 1 ] || /bin/rm -f "$2"',
  ].join('\n');
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The LaunchAgent: runs the script once at login (paths go in as arguments, never through a shell). Attributed to the
 * app's bundle id, so Login Items lists it as AppuBot rather than "sh" (a user switching "sh" off would lose recovery).
 */
export function recoveryPlist(o: { label: string; script: string; markerDir: string; plistPath: string; bundleId?: string }): string {
  const args = ['/bin/sh', '-c', o.script, o.label, o.markerDir, o.plistPath];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${xml(o.label)}</string>`,
    ...(o.bundleId ? ['  <key>AssociatedBundleIdentifiers</key>', '  <array>', `    <string>${xml(o.bundleId)}</string>`, '  </array>'] : []),
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((a) => `    <string>${xml(a)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** A pid that still runs (EPERM: it does, as someone else). */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

const wantsLid = (p: Settings['power']): boolean => p.keepAwake && p.lidClosed;

export class PowerService {
  private running = false;
  private held = false;
  /** this run switched sleep off, wrote the marker and started the watchdog */
  private active = false;
  private lid: PowerStatus['lidClosed'] = 'off';
  private rule = false;
  private error: string | undefined;
  private pausedBattery = false;
  private pausedHeat = false;
  private pct: number | undefined;
  private poll: NodeJS.Timeout | null = null;
  private offs: (() => void)[] = [];
  private lock = new Mutex();
  private published = '';
  /** when this boot started: a marker from before it is stale whatever its pid says */
  private boot: number | undefined;
  /** the password prompt in flight: a second click waits for it rather than asking again */
  private installing: Promise<void> | null = null;

  constructor(private ctx: CoreCtx) {}

  private get host(): PowerHost | undefined { return this.ctx.deps.power; }
  /** this run's marker; each run has its own, so an old run's watchdog never removes a newer run's */
  get markerPath(): string { return join(this.ctx.paths.dataDir, `power-lid-${process.pid}.json`); }

  /** undefined where nothing keeps the Mac awake (no host) */
  status(): PowerStatus | undefined {
    const host = this.host;
    if (!host) return undefined;
    let onBattery: boolean | undefined;
    try { onBattery = host.onBattery(); } catch { /* unknown */ }
    return {
      keepingAwake: this.held, lidClosed: this.lid, lidRule: this.rule,
      ...(onBattery !== undefined ? { onBattery } : {}),
      ...(this.pct !== undefined ? { batteryPct: this.pct } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  async start(): Promise<void> {
    const host = this.host;
    if (!host || this.running) return;
    this.running = true;
    this.boot = await host.bootTime().catch(() => undefined);
    this.rule = await host.lidRuleInstalled().catch(() => false);
    this.offs.push(host.onChange(() => void this.apply()));
    this.offs.push(this.ctx.s.settings.onChange((next, prev) => {
      if (next.power.keepAwake !== prev.power.keepAwake || next.power.lidClosed !== prev.power.lidClosed) void this.apply();
    }));
    // markers left by runs that crashed are undone here when lid mode is no longer wanted (or can't be kept)
    await this.apply();
  }

  /** First thing on quit: sleep comes back on before the slow shutdown steps. */
  async stop(): Promise<void> {
    const host = this.host;
    if (!host || !this.running) return;
    this.running = false;
    for (const off of this.offs.splice(0)) off();
    this.watchBattery(false);
    await this.lock.run(async () => {
      await this.restore(host);
      if (this.held) {
        try { host.allowSleep(); } catch { /* released when the app exits anyway */ }
        this.held = false;
      }
    });
  }

  /**
   * Stay awake with the lid closed. The first time asks for the Mac's password (only on the Mac itself: a phone can't
   * answer that prompt); a cancelled prompt leaves the setting as it was. `forgetRule` turns it off and removes the rule,
   * switching sleep back on as root first if it is still off because of us (or keeping the rule if that fails).
   */
  async setLidClosed(on: boolean, o: { forgetRule?: boolean; onMac: boolean }): Promise<PowerStatus> {
    const host = this.host;
    if (!host) throw new RpcError('unavailable', `This ${machineName(process.platform)} can’t be kept awake by AppuBot.`);
    const want = on && !o.forgetRule;
    if (want && !(await host.lidRuleInstalled().catch(() => false))) {
      if (!o.onMac) throw new RpcError('forbidden', PHONE_SETUP);
      this.installing ??= host.installLidRule().finally(() => { this.installing = null; });
      try { await this.installing; } catch (e) { throw new RpcError('power_setup', errMsg(e)); }
      this.rule = true;
    }
    const power = this.ctx.s.settings.get().power;
    // lid mode needs the blocker too
    this.ctx.s.settings.update({ power: { keepAwake: want || power.keepAwake, lidClosed: want } });
    await this.apply();
    if (o.forgetRule) {
      // without the rule nothing could switch sleep back on later (quit, the watchdog, the next start, the agent), so
      // the removal's own root script switches it on first when we left it off. The lock is not held across its
      // password prompt: a quit meanwhile must still get through stop() in time.
      const { stale, restoreSleep } = await this.lock.run(async () => {
        const stale = this.staleMarkers();
        return { stale, restoreSleep: this.active || stale.length > 0 };
      });
      try {
        await host.removeLidRule({ restoreSleep });
      } catch (e) {
        const msg = errMsg(e);
        throw new RpcError('power_setup', restoreSleep && !/^Cancelled/.test(msg)
          ? `Couldn’t switch sleep back on, so the permission stays: ${msg}` : msg);
      }
      if (restoreSleep) {
        await this.lock.run(async () => {
          this.cleared(host, stale);
          this.error = undefined;
        });
      }
      this.rule = await host.lidRuleInstalled().catch(() => false);
      await this.apply();
    }
    return this.status()!;
  }

  private apply(): Promise<void> {
    return this.lock.run(async () => {
      const host = this.host;
      if (!host || !this.running) return;
      const p = this.ctx.s.settings.get().power;
      if (p.keepAwake !== this.held) {
        try {
          if (p.keepAwake) host.preventSleep(); else host.allowSleep();
          this.held = p.keepAwake;
        } catch (e) { this.ctx.log.warn('power: sleep blocker failed', errMsg(e)); }
      }
      this.lid = await this.applyLid(host, p);
      this.publish();
    });
  }

  private async applyLid(host: PowerHost, p: Settings['power']): Promise<PowerStatus['lidClosed']> {
    this.error = undefined;
    if (!wantsLid(p)) {
      this.watchBattery(false);
      this.pct = undefined;
      return (await this.restore(host)) ? 'off' : 'error';
    }
    if (!this.rule) this.rule = await host.lidRuleInstalled().catch(() => false);
    if (!this.rule) {
      // never prompts from here: only setLidClosed (a click on the Mac) asks for the password
      this.watchBattery(false);
      return (await this.restore(host)) ? 'setup' : 'error';
    }
    this.watchBattery(true);
    await this.readConditions(host);
    if (this.pausedHeat || this.pausedBattery) {
      // a pause keeps the login item: removing and re-adding it on every pause would notify the user each time
      if (!(await this.restore(host, { keepRecovery: true }))) return 'error';
      return this.pausedHeat ? 'paused-heat' : 'paused-battery';
    }
    if (this.active) return 'on';
    try {
      // the marker goes first: a crash right after still gets undone at the next start (or login, by the agent)
      writeFileSync(this.markerPath, JSON.stringify({ pid: process.pid, since: Date.now() }));
      try { host.installRecovery(this.ctx.paths.dataDir); } catch (e) { this.ctx.log.warn('power: no login-time recovery', errMsg(e)); }
      await host.setSleepDisabled(true);
      host.startWatchdog(this.markerPath);
      // a crashed run's lid mode is ours now: our marker covers it
      for (const p of this.staleMarkers()) if (p !== this.markerPath) rmSync(p, { force: true });
      this.active = true;
      return 'on';
    } catch (e) {
      this.ctx.log.warn('power: could not switch sleep off', errMsg(e));
      await this.restore(host);
      // the rule may have been removed by hand
      this.rule = await host.lidRuleInstalled().catch(() => false);
      if (!this.rule) return 'setup';
      this.error = `Couldn’t switch sleep off: ${errMsg(e)}`;
      return 'error';
    }
  }

  /** Switch sleep back on if we switched it off (this run, or crashed ones per their markers). False if that failed. */
  private async restore(host: PowerHost, o: { keepRecovery?: boolean } = {}): Promise<boolean> {
    const stale = this.staleMarkers();
    if (!this.active && !stale.length) {
      // nothing to switch back on; a login item kept through a pause goes once lid mode is really off
      if (!o.keepRecovery) try { host.removeRecovery(); } catch { /* not there */ }
      return true;
    }
    try {
      // stale markers with sleep already back on (switched on by hand) need no sudo
      if (this.active || (await host.sleepDisabled().catch(() => true))) await host.setSleepDisabled(false);
    } catch (e) {
      // the markers, the watchdog and the agent stay, so the next start (or the watchdog, or the next login) tries again
      this.ctx.log.warn('power: could not switch sleep back on', errMsg(e));
      this.error = `Couldn’t switch sleep back on: ${errMsg(e)}. ${host.restoreHint ?? 'Run “sudo pmset -a disablesleep 0” in Terminal.'}`;
      return false;
    }
    this.cleared(host, stale, o.keepRecovery);
    return true;
  }

  /** Sleep is back on: nothing is left to undo (a paused lid mode keeps its login item; it removes itself at login). */
  private cleared(host: PowerHost, stale: string[], keepRecovery = false): void {
    for (const p of stale) rmSync(p, { force: true });
    rmSync(this.markerPath, { force: true });
    try { host.stopWatchdog(); } catch { /* already gone */ }
    if (!keepRecovery) {
      try { host.removeRecovery(); } catch (e) { this.ctx.log.warn('power: could not remove the login-time recovery', errMsg(e)); }
    }
    this.active = false;
  }

  /**
   * Markers this run has to undo: its own once it isn't active (a failed switch), and other runs' that are gone (a
   * dead pid, or written before this boot, whose pid may be reused). A live run's marker is that run's business.
   */
  private staleMarkers(): string[] {
    const dir = this.ctx.paths.dataDir;
    let names: string[];
    try { names = readdirSync(dir); } catch { return []; }
    return names.filter((n) => MARKER_RE.test(n)).map((n) => join(dir, n)).filter((p) => {
      if (p === this.markerPath) return !this.active;
      let m: { pid?: unknown; since?: unknown };
      try { m = JSON.parse(readFileSync(p, 'utf8')) as typeof m; } catch { return true; }
      if (typeof m.pid !== 'number' || typeof m.since !== 'number') return true;
      if (this.boot !== undefined && m.since < this.boot) return true;
      return !alive(m.pid);
    });
  }

  /** Pause below 15% on battery (resume on power or at 20%) and when serious/critical (resume at nominal/fair). */
  private async readConditions(host: PowerHost): Promise<void> {
    const t = host.thermalState();
    if (t === 'serious' || t === 'critical') this.pausedHeat = true;
    else if (t === 'nominal' || t === 'fair') this.pausedHeat = false;
    if (!host.onBattery()) {
      this.pausedBattery = false;
      this.pct = undefined;
      return;
    }
    this.pct = await host.batteryPct().catch(() => undefined);
    if (this.pct === undefined) return;
    if (this.pct < LOW_BATTERY_PCT) this.pausedBattery = true;
    else if (this.pct >= RESUME_BATTERY_PCT) this.pausedBattery = false;
  }

  private watchBattery(on: boolean): void {
    if (on && !this.poll) {
      this.poll = setInterval(() => void this.apply(), BATTERY_POLL_MS);
      this.poll.unref?.();
    } else if (!on && this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }

  private publish(): void {
    const key = JSON.stringify(this.status());
    if (key === this.published) return;
    this.published = key;
    this.ctx.bus.emit('system.updated', this.ctx.s.system.info());
  }
}
