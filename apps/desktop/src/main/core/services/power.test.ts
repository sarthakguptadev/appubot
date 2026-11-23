import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchema, type Settings } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { deepMerge, silentLogger } from '../util';
import {
  LOW_BATTERY_PCT, PowerService, lidRuleLines, lidRulePath, parseBatteryPct, parseBootTime, parseSleepDisabled, recoveryPlist,
  recoveryScript, watchdogScript, type PowerHost, type ThermalState,
} from './power';

class FakeHost implements PowerHost {
  blocking = false;
  sleepOff = false;
  rule = false;
  battery = false;
  pct: number | undefined = 80;
  thermal: ThermalState = 'nominal';
  watching: string | null = null;
  recovery: string | null = null;
  boot: number | undefined = Date.now() - 3_600_000;
  calls: string[] = [];
  cancelInstall = false;
  /** the password prompt stays up until this resolves */
  installGate: Promise<void> | null = null;
  /** root's `pmset -a disablesleep 0` in the removal script fails */
  rootRestoreFails = false;
  private listeners = new Set<() => void>();

  preventSleep() { this.blocking = true; }
  allowSleep() { this.blocking = false; }
  onBattery() { return this.battery; }
  async batteryPct() { return this.pct; }
  thermalState() { return this.thermal; }
  onChange(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  changed() { for (const l of this.listeners) l(); }
  async sleepDisabled() { return this.sleepOff; }
  async bootTime() { return this.boot; }
  async lidRuleInstalled() { return this.rule; }
  async installLidRule() {
    this.calls.push('install');
    if (this.installGate) await this.installGate;
    if (this.cancelInstall) throw new Error('Cancelled: the Mac’s password wasn’t entered.');
    this.rule = true;
  }
  async removeLidRule({ restoreSleep }: { restoreSleep: boolean }) {
    if (restoreSleep) {
      if (this.rootRestoreFails) throw new Error('Sleep could not be switched back on.');
      this.calls.push('root pmset 0');
      this.sleepOff = false;
    }
    this.calls.push('remove');
    this.rule = false;
  }
  async setSleepDisabled(on: boolean) {
    if (!this.rule) throw new Error('sudo: a password is required');
    this.calls.push(`pmset ${on ? 1 : 0}`);
    this.sleepOff = on;
  }
  startWatchdog(markerPath: string) { this.watching = markerPath; }
  stopWatchdog() { this.watching = null; }
  installRecovery(markerDir: string) { this.recovery = markerDir; }
  removeRecovery() { this.recovery = null; }
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'appubot-power-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function setup(o: { host?: FakeHost | null; power?: Partial<Settings['power']> } = {}) {
  const host = o.host === undefined ? new FakeHost() : (o.host ?? undefined);
  let settings = SettingsSchema.parse({ power: o.power ?? {} });
  const listeners = new Set<(n: Settings, p: Settings) => void>();
  const events: string[] = [];
  const ctx = {
    deps: { power: host },
    paths: { dataDir: dir },
    log: silentLogger,
    bus: { emit: (e: string) => { events.push(e); } },
    s: {
      settings: {
        get: () => settings,
        update: (patch: Partial<Settings>) => {
          const prev = settings;
          settings = SettingsSchema.parse(deepMerge(prev, patch));
          for (const l of listeners) l(settings, prev);
          return settings;
        },
        onChange: (fn: (n: Settings, p: Settings) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
      },
      system: { info: () => ({ power: svc.status() }) },
    },
  } as unknown as CoreCtx;
  const svc = new PowerService(ctx);
  const marker = () => (existsSync(svc.markerPath) ? JSON.parse(readFileSync(svc.markerPath, 'utf8')) as { pid: number } : null);
  return { svc, host: host as FakeHost, ctx, events, marker, settings: () => settings };
}
const settle = () => new Promise((r) => setTimeout(r, 5));
const markers = () => readdirSync(dir).filter((n) => n.startsWith('power-lid')).sort();
/** another run's marker */
function leftBy(pid: number, since: number, name = `power-lid-${pid}.json`): string {
  writeFileSync(join(dir, name), JSON.stringify({ pid, since }));
  return name;
}
/** The pid of a process that has already exited (`/usr/bin/true` doesn't exist on Windows, where spawn gives pid 0). */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;

describe('power service', () => {
  it('has no status and does nothing without a host', async () => {
    const { svc, events } = setup({ host: null });
    await svc.start();
    expect(svc.status()).toBeUndefined();
    expect(events).toEqual([]);
    await expect(svc.setLidClosed(true, { onMac: true })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('holds the sleep blocker while keepAwake is on and lets go when it is turned off', async () => {
    const { svc, host, ctx, events, settings } = setup();
    await svc.start();
    expect(host.blocking).toBe(true);
    expect(svc.status()).toMatchObject({ keepingAwake: true, lidClosed: 'off', lidRule: false });
    expect(events).toContain('system.updated');
    ctx.s.settings.update({ power: { ...settings().power, keepAwake: false } });
    await settle();
    expect(host.blocking).toBe(false);
    expect(svc.status()?.keepingAwake).toBe(false);
  });

  it('switches sleep off with the rule installed, writes the marker and starts the watchdog and the login agent', async () => {
    const host = new FakeHost();
    host.rule = true;
    const { svc, marker } = setup({ host, power: { lidClosed: true } });
    await svc.start();
    expect(host.sleepOff).toBe(true);
    expect(marker()?.pid).toBe(process.pid);
    expect(svc.markerPath).toBe(join(dir, `power-lid-${process.pid}.json`));
    expect(host.watching).toBe(svc.markerPath);
    expect(host.recovery).toBe(dir);
    expect(svc.status()).toMatchObject({ lidClosed: 'on', lidRule: true });
  });

  it('waits for setup (never prompting) when lid mode is switched on without the rule', async () => {
    const { svc, host, ctx, marker, settings } = setup();
    await svc.start();
    ctx.s.settings.update({ power: { ...settings().power, lidClosed: true } });
    await settle();
    expect(svc.status()?.lidClosed).toBe('setup');
    expect(host.calls).toEqual([]);
    expect(host.sleepOff).toBe(false);
    expect(marker()).toBeNull();
  });

  it("refuses a phone's first enable, and installs the rule from the Mac", async () => {
    const { svc, host, settings } = setup();
    await svc.start();
    await expect(svc.setLidClosed(true, { onMac: false })).rejects.toMatchObject({ code: 'forbidden' });
    expect(settings().power.lidClosed).toBe(false);
    expect(host.calls).toEqual([]);

    const st = await svc.setLidClosed(true, { onMac: true });
    expect(host.calls).toEqual(['install', 'pmset 1']);
    expect(st).toMatchObject({ lidClosed: 'on', lidRule: true });
    expect(settings().power).toEqual({ keepAwake: true, lidClosed: true });

    // once the rule is there a phone may switch it
    await svc.setLidClosed(false, { onMac: false });
    expect(host.sleepOff).toBe(false);
    await svc.setLidClosed(true, { onMac: false });
    expect(host.sleepOff).toBe(true);
  });

  it('leaves the setting as it was when the password prompt is cancelled', async () => {
    const host = new FakeHost();
    host.cancelInstall = true;
    const { svc, settings } = setup({ host });
    await svc.start();
    await expect(svc.setLidClosed(true, { onMac: true })).rejects.toThrow(/Cancelled/);
    expect(settings().power.lidClosed).toBe(false);
    expect(svc.status()?.lidClosed).toBe('off');
  });

  it('pauses on low battery and resumes on power or at 20%', async () => {
    const host = new FakeHost();
    host.rule = true;
    host.battery = true;
    host.pct = 30;
    const { svc, marker } = setup({ host, power: { lidClosed: true } });
    await svc.start();
    expect(svc.status()).toMatchObject({ lidClosed: 'on', onBattery: true, batteryPct: 30 });

    host.pct = LOW_BATTERY_PCT - 1;
    host.changed();
    await settle();
    expect(svc.status()?.lidClosed).toBe('paused-battery');
    expect(host.sleepOff).toBe(false);
    expect(marker()).toBeNull();
    expect(host.watching).toBeNull();

    host.pct = 17;
    host.changed();
    await settle();
    expect(svc.status()?.lidClosed).toBe('paused-battery');

    host.pct = 20;
    host.changed();
    await settle();
    expect(svc.status()?.lidClosed).toBe('on');
    expect(host.sleepOff).toBe(true);

    host.pct = 5;
    host.changed();
    await settle();
    host.battery = false;
    host.changed();
    await settle();
    expect(svc.status()?.lidClosed).toBe('on');
  });

  it('keeps the login item through a pause, and removes it once lid mode is off', async () => {
    const host = new FakeHost();
    host.rule = true;
    host.battery = true;
    host.pct = 30;
    const { svc } = setup({ host, power: { lidClosed: true } });
    await svc.start();
    expect(host.recovery).toBe(dir);
    host.pct = LOW_BATTERY_PCT - 1;
    host.changed();
    await settle();
    expect(svc.status()?.lidClosed).toBe('paused-battery');
    expect(host.recovery).toBe(dir);
    await svc.setLidClosed(false, { onMac: true });
    expect(svc.status()?.lidClosed).toBe('off');
    expect(host.recovery).toBeNull();
  });

  it('pauses while the Mac is hot and resumes once it cools down', async () => {
    const host = new FakeHost();
    host.rule = true;
    const { svc } = setup({ host, power: { lidClosed: true } });
    await svc.start();
    host.thermal = 'serious';
    host.changed();
    await settle();
    expect(svc.status()?.lidClosed).toBe('paused-heat');
    expect(host.sleepOff).toBe(false);
    host.thermal = 'fair';
    host.changed();
    await settle();
    expect(svc.status()?.lidClosed).toBe('on');
    expect(host.sleepOff).toBe(true);
  });

  it('puts everything back on stop', async () => {
    const host = new FakeHost();
    host.rule = true;
    const { svc, marker } = setup({ host, power: { lidClosed: true } });
    await svc.start();
    await svc.stop();
    expect(host.sleepOff).toBe(false);
    expect(host.blocking).toBe(false);
    expect(host.watching).toBeNull();
    expect(host.recovery).toBeNull();
    expect(marker()).toBeNull();
    // events after stop change nothing
    host.changed();
    await settle();
    expect(host.sleepOff).toBe(false);
  });

  it('undoes lid mode a crashed run left on, at the next start', async () => {
    const host = new FakeHost();
    host.rule = true;
    host.sleepOff = true;
    host.recovery = dir;
    const { svc } = setup({ host });
    leftBy(deadPid(), Date.now());
    await svc.start();
    expect(host.calls).toEqual(['pmset 0']);
    expect(host.sleepOff).toBe(false);
    expect(markers()).toEqual([]);
    expect(host.recovery).toBeNull();
  });

  it('recovers every stale marker: dead runs, runs from before this boot, the old single file', async () => {
    const host = new FakeHost();
    host.rule = true;
    host.sleepOff = true;
    const { svc } = setup({ host });
    leftBy(deadPid(), Date.now());
    leftBy(process.ppid, 1); // alive, but its pid is from an earlier boot
    leftBy(deadPid(), 1, 'power-lid.json');
    writeFileSync(join(dir, `power-lid-${deadPid()}.json`), '{not json');
    await svc.start();
    expect(host.calls).toEqual(['pmset 0']);
    expect(markers()).toEqual([]);
  });

  it("leaves a live run's marker alone (and never touches sleep for it)", async () => {
    const host = new FakeHost();
    host.rule = true;
    host.sleepOff = true;
    const { svc } = setup({ host });
    const live = leftBy(process.ppid, Date.now());
    await svc.start();
    await svc.stop();
    expect(host.calls).toEqual([]);
    expect(markers()).toEqual([live]);
  });

  it("an old run's watchdog finishing late never removes this run's marker", async () => {
    const host = new FakeHost();
    host.rule = true;
    host.sleepOff = true;
    const { svc, marker } = setup({ host, power: { lidClosed: true } });
    const old = leftBy(deadPid(), Date.now());
    await svc.start();
    // the old watchdog only knows its own file
    rmSync(join(dir, old), { force: true });
    expect(marker()?.pid).toBe(process.pid);
    expect(markers()).toEqual([`power-lid-${process.pid}.json`]);
  });

  it('takes over a crashed run’s lid mode when it is still wanted', async () => {
    const host = new FakeHost();
    host.rule = true;
    host.sleepOff = true;
    const { svc, marker } = setup({ host, power: { lidClosed: true } });
    leftBy(deadPid(), 1);
    await svc.start();
    expect(marker()?.pid).toBe(process.pid);
    expect(markers()).toEqual([`power-lid-${process.pid}.json`]);
    expect(host.watching).toBe(svc.markerPath);
    expect(svc.status()?.lidClosed).toBe('on');
  });

  it("never touches sleep it didn't switch off (no marker)", async () => {
    const host = new FakeHost();
    host.rule = true;
    host.sleepOff = true; // Amphetamine, say
    const { svc } = setup({ host });
    await svc.start();
    await svc.stop();
    expect(host.calls).toEqual([]);
    expect(host.sleepOff).toBe(true);
  });

  it('keeps the marker (and reports it) when sleep cannot be switched back on', async () => {
    const host = new FakeHost();
    host.sleepOff = true;
    host.recovery = dir;
    const { svc } = setup({ host });
    const left = leftBy(deadPid(), 1);
    await svc.start();
    expect(svc.status()).toMatchObject({ lidClosed: 'error' });
    expect(svc.status()?.error).toMatch(/disablesleep 0/);
    expect(markers()).toEqual([left]);
    expect(host.recovery).toBe(dir);
  });

  it('falls back to setup when the rule was removed behind its back', async () => {
    const host = new FakeHost();
    host.rule = true;
    const { svc, ctx, settings, marker } = setup({ host });
    await svc.start();
    host.rule = false;
    ctx.s.settings.update({ power: { ...settings().power, lidClosed: true } });
    await settle();
    expect(svc.status()).toMatchObject({ lidClosed: 'setup', lidRule: false });
    expect(marker()).toBeNull();
  });

  it('forgetRule turns lid mode off, then removes the rule', async () => {
    const host = new FakeHost();
    host.rule = true;
    const { svc, settings } = setup({ host, power: { lidClosed: true } });
    await svc.start();
    const st = await svc.setLidClosed(true, { onMac: true, forgetRule: true });
    expect(host.calls).toEqual(['pmset 1', 'pmset 0', 'remove']);
    expect(settings().power.lidClosed).toBe(false);
    expect(st).toMatchObject({ lidClosed: 'off', lidRule: false });
  });

  it('forgetRule switches sleep back on as root first when it is still off because of us', async () => {
    const host = new FakeHost();
    host.sleepOff = true;
    host.recovery = dir;
    const { svc } = setup({ host });
    leftBy(deadPid(), 1);
    host.rule = true;
    // `sudo -n pmset -a disablesleep 0` keeps failing, so restoring did too
    host.setSleepDisabled = async () => { throw new Error('timed out'); };
    await svc.start();
    expect(svc.status()?.lidClosed).toBe('error');

    const st = await svc.setLidClosed(false, { onMac: true, forgetRule: true });
    expect(host.calls).toEqual(['root pmset 0', 'remove']);
    expect(host.sleepOff).toBe(false);
    expect(markers()).toEqual([]);
    expect(host.recovery).toBeNull();
    expect(st).toMatchObject({ lidClosed: 'off', lidRule: false });
    expect(st.error).toBeUndefined();
  });

  it('forgetRule keeps the rule when sleep cannot be switched back on', async () => {
    const host = new FakeHost();
    host.rule = true;
    host.sleepOff = true;
    host.rootRestoreFails = true;
    host.setSleepDisabled = async () => { throw new Error('timed out'); };
    const { svc } = setup({ host });
    const left = leftBy(deadPid(), 1);
    await svc.start();
    await expect(svc.setLidClosed(false, { onMac: true, forgetRule: true }))
      .rejects.toMatchObject({ code: 'power_setup', message: expect.stringMatching(/permission stays/) });
    expect(host.rule).toBe(true);
    expect(host.sleepOff).toBe(true);
    expect(markers()).toEqual([left]);
  });

  it('a second click while the password prompt is up waits for it instead of asking again', async () => {
    const host = new FakeHost();
    let enter!: () => void;
    host.installGate = new Promise((r) => { enter = r; });
    const { svc, settings } = setup({ host });
    await svc.start();
    const first = svc.setLidClosed(true, { onMac: true });
    await settle();
    const second = svc.setLidClosed(true, { onMac: true });
    await settle();
    enter();
    await Promise.all([first, second]);
    expect(host.calls.filter((c) => c === 'install')).toEqual(['install']);
    expect(settings().power.lidClosed).toBe(true);
    expect(svc.status()?.lidClosed).toBe('on');
  });
});

describe('power helpers', () => {
  it('reads the battery and SleepDisabled from pmset and ioreg', () => {
    expect(parseBatteryPct("Now drawing from 'AC Power'\n -InternalBattery-0 (id=24182883)\t63%; charging; 2:22 remaining present: true\n")).toBe(63);
    expect(parseBatteryPct("Now drawing from 'AC Power'\n")).toBeUndefined();
    expect(parseSleepDisabled('      "AppleClamshellState" = No\n      "SleepDisabled" = Yes\n')).toBe(true);
    expect(parseSleepDisabled('      "SleepDisabled" = No\n')).toBe(false);
  });

  it('writes a rule for exactly the two pmset commands and refuses odd user names', () => {
    expect(lidRuleLines('sarthak')).toEqual([
      'sarthak ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0',
    ]);
    expect(() => lidRuleLines('ALL ALL=(ALL) NOPASSWD: ALL #')).toThrow();
    expect(() => lidRuleLines('%admin')).toThrow();
  });

  it('keeps one rule file per user, with no dot in its name', () => {
    expect(lidRulePath('sarthak')).toBe('/etc/sudoers.d/appubot_pmset_sarthak');
    expect(lidRulePath('jane.doe')).toBe('/etc/sudoers.d/appubot_pmset_jane_doe');
    expect(lidRulePath('a-b_c')).toBe('/etc/sudoers.d/appubot_pmset_a-b_c');
    expect(lidRulePath('../x y')).toBe('/etc/sudoers.d/appubot_pmset____x_y');
  });

  it('reads the boot time from sysctl (not usec)', () => {
    expect(parseBootTime('{ sec = 1791952593, usec = 668016 } Wed Oct 14 10:06:33 2026\n')).toBe(1_791_952_593_000);
    expect(parseBootTime('')).toBeUndefined();
  });

  it('writes a LaunchAgent that runs the recovery once at login, paths as plain arguments', () => {
    const plist = recoveryPlist({
      label: 'ai.appubot.desktop.power-recovery', script: 'echo "a" && b < c',
      markerDir: '/Users/x/Library/Application Support/AppuBot', plistPath: '/Users/x/Library/LaunchAgents/ai.appubot.desktop.power-recovery.plist',
    });
    expect(plist).toContain('<key>Label</key><string>ai.appubot.desktop.power-recovery</string>');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain([
      '    <string>/bin/sh</string>',
      '    <string>-c</string>',
      '    <string>echo &quot;a&quot; &amp;&amp; b &lt; c</string>',
      '    <string>ai.appubot.desktop.power-recovery</string>',
      '    <string>/Users/x/Library/Application Support/AppuBot</string>',
      '    <string>/Users/x/Library/LaunchAgents/ai.appubot.desktop.power-recovery.plist</string>',
    ].join('\n'));
    expect(plist).not.toContain('KeepAlive');
  });

  it.skipIf(process.platform !== 'darwin')('the login agent restores only for markers from before this boot, then removes itself', () => {
    const markerDir = join(dir, 'Application Support');
    rmSync(markerDir, { recursive: true, force: true });
    spawnSync('/bin/mkdir', ['-p', markerDir]);
    const plist = join(dir, 'agent.plist');
    const done = join(dir, 'restored');
    const run = (sleepOff = '/usr/bin/true', restore = `/usr/bin/touch '${done}'`) =>
      spawnSync('/bin/sh', ['-c', recoveryScript(restore, sleepOff), 'agent', markerDir, plist], { timeout: 5000 });
    const reset = () => { rmSync(done, { force: true }); writeFileSync(plist, 'plist'); };
    const files = () => readdirSync(markerDir).sort();

    // a marker from this boot: a live run's, so nothing happens and the agent stays
    reset();
    writeFileSync(join(markerDir, 'power-lid-1.json'), JSON.stringify({ pid: 1, since: Date.now() }));
    expect(run().status).toBe(0);
    expect(existsSync(done)).toBe(false);
    expect(existsSync(plist)).toBe(true);

    // plus one from before this boot: restored and removed; the live one keeps the agent
    writeFileSync(join(markerDir, 'power-lid-2.json'), JSON.stringify({ pid: 2, since: 1 }));
    expect(run().status).toBe(0);
    expect(existsSync(done)).toBe(true);
    expect(files()).toEqual(['power-lid-1.json']);
    expect(existsSync(plist)).toBe(true);

    // only old markers: restored, removed, and the agent removes itself
    reset();
    rmSync(join(markerDir, 'power-lid-1.json'));
    writeFileSync(join(markerDir, 'power-lid.json'), JSON.stringify({ pid: 3, since: 1 }));
    writeFileSync(join(markerDir, 'power-lid-4.json'), 'garbage');
    expect(run().status).toBe(0);
    expect(existsSync(done)).toBe(true);
    expect(files()).toEqual([]);
    expect(existsSync(plist)).toBe(false);

    // sleep already back on: no restore, just the clean-up
    reset();
    writeFileSync(join(markerDir, 'power-lid-5.json'), JSON.stringify({ pid: 5, since: 1 }));
    expect(run('/usr/bin/false').status).toBe(0);
    expect(existsSync(done)).toBe(false);
    expect(files()).toEqual([]);
    expect(existsSync(plist)).toBe(false);

    // restoring fails: everything stays for the next login
    reset();
    writeFileSync(join(markerDir, 'power-lid-6.json'), JSON.stringify({ pid: 6, since: 1 }));
    expect(run('/usr/bin/true', '/usr/bin/false').status).not.toBe(0);
    expect(files()).toEqual(['power-lid-6.json']);
    expect(existsSync(plist)).toBe(true);

    // no marker at all: the agent just removes itself
    reset();
    rmSync(join(markerDir, 'power-lid-6.json'));
    expect(run().status).toBe(0);
    expect(existsSync(done)).toBe(false);
    expect(existsSync(plist)).toBe(false);
  });

  // the watchdog is a /bin/sh script for macOS's pmset; Windows has its own (windowsWatchdogScript)
  it.skipIf(process.platform === 'win32')('the watchdog restores only while the marker still names the dead app', () => {
    const dead = deadPid();
    const marker = join(dir, 'power lid.json');
    const done = join(dir, 'restored');
    const script = watchdogScript(`/usr/bin/touch '${done}'`);
    const run = () => spawnSync('/bin/sh', ['-c', script, 'watchdog', String(dead), marker], { timeout: 5000 });

    writeFileSync(marker, JSON.stringify({ pid: dead + 1, since: 1 }));
    run();
    expect(existsSync(done)).toBe(false);
    expect(existsSync(marker)).toBe(true);

    writeFileSync(marker, JSON.stringify({ pid: dead, since: 1 }));
    run();
    expect(existsSync(done)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});
