/**
 * PowerHost for the core's PowerService: Electron's sleep blocker and power events, plus the one privileged switch,
 * `pmset -a disablesleep`, run through a narrow sudoers rule (`sudo -n`, never a password prompt). Installing or
 * removing that rule is the only thing that asks for the Mac's password (osascript, administrator privileges).
 * Absolute paths everywhere: an app opened from Finder has a minimal PATH. Windows and Linux have hosts of their own
 * below (createWindowsPowerHost: powercfg's lid action; createLinuxPowerHost: a systemd-logind inhibitor lock).
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, uptime, userInfo } from 'node:os';
import { join } from 'node:path';
import { powerMonitor, powerSaveBlocker } from 'electron';
import {
  LEGACY_LID_RULE_PATH, RECOVERY_LABEL, lidRuleLines, lidRulePath, parseBatteryPct, parseBootTime, parseSleepDisabled,
  recoveryPlist, recoveryScript, watchdogScript, type PowerHost,
} from '../core/services/power';
import {
  encodePowerShell, linuxBatteryPct, linuxInhibitArgs, parseWindowsBatteryPct, windowsKeepAwakeScript, windowsLidSwitch, windowsRecoveryScript,
  windowsWatchdogScript, type WindowsLidState,
} from '../core/services/powerPlatforms';
import { asString } from './ipc';

const PMSET_OFF = '/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0';
const SLEEP_IS_OFF = `/usr/sbin/ioreg -rn IOPMrootDomain -d1 | /usr/bin/grep -q '"SleepDisabled" = Yes'`;
/** launchd loads it at the next login; nothing loads it now (the watchdog covers this session) */
const RECOVERY_PLIST = join(homedir(), 'Library', 'LaunchAgents', `${RECOVERY_LABEL}.plist`);
/** electron-builder.yml appId: the login item is listed under it */
const APP_ID = 'ai.appubot.desktop';

function run(file: string, args: string[], timeout = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

/** Runs a fixed shell script as root after the Mac's password (or Touch ID); a cancelled prompt rejects clearly. */
async function asAdmin(script: string, prompt: string): Promise<void> {
  try {
    await run('/usr/bin/osascript', ['-e', `do shell script ${asString(script)} with prompt ${asString(prompt)} with administrator privileges`], 0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/-128|cancel/i.test(msg)) throw new Error('Cancelled: the Mac’s password wasn’t entered.');
    throw new Error(msg);
  }
}

const sh = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/** what an earlier build's single rule file granted this user */
const lidRuleLegacyLine = (user: string): string => `${user} ALL=(root) NOPASSWD: APPUBOT_PMSET`;

export function createPowerHost(): PowerHost {
  let blocker: number | null = null;
  let watchdog: ChildProcess | null = null;
  const stopWatchdog = (): void => {
    // its own process group (detached): the loop's `sleep` goes too
    if (watchdog?.pid && watchdog.exitCode === null) try { process.kill(-watchdog.pid); } catch { watchdog.kill(); }
    watchdog = null;
  };

  const user = userInfo().username;
  const rulePath = lidRulePath(user);

  return {
    preventSleep() {
      if (blocker === null || !powerSaveBlocker.isStarted(blocker)) blocker = powerSaveBlocker.start('prevent-app-suspension');
    },
    allowSleep() {
      if (blocker !== null && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
      blocker = null;
    },
    onBattery: () => powerMonitor.isOnBatteryPower(),
    batteryPct: async () => parseBatteryPct(await run('/usr/bin/pmset', ['-g', 'batt'])),
    thermalState: () => powerMonitor.getCurrentThermalState(),
    onChange(fn) {
      powerMonitor.on('on-ac', fn).on('on-battery', fn).on('thermal-state-change', fn);
      return () => { powerMonitor.off('on-ac', fn).off('on-battery', fn).off('thermal-state-change', fn); };
    },
    sleepDisabled: async () => parseSleepDisabled(await run('/usr/sbin/ioreg', ['-rn', 'IOPMrootDomain', '-d1'])),
    bootTime: async () => parseBootTime(await run('/usr/sbin/sysctl', ['-n', 'kern.boottime'])),
    async lidRuleInstalled() {
      // this user's rule: sudo says so, or this user's own file is there (another user's rule never counts)
      try {
        await run('/usr/bin/sudo', ['-n', '-l', '/usr/bin/pmset', '-a', 'disablesleep', '1'], 5000);
        return true;
      } catch {
        return existsSync(rulePath);
      }
    },
    async installLidRule() {
      // written by root straight into /etc/sudoers.d (no user-writable temp file to swap); the staging name has a dot,
      // so sudo ignores it if it is ever left behind
      const staged = sh(`${rulePath}.new`);
      const lines = lidRuleLines(user).map(sh).join(' ');
      await asAdmin(
        `umask 077; /usr/bin/printf '%s\\n' ${lines} > ${staged} && /usr/sbin/visudo -cf ${staged} && /usr/sbin/chown root:wheel ${staged} && /bin/chmod 0440 ${staged} && /bin/mv -f ${staged} ${sh(rulePath)} || { /bin/rm -f ${staged}; exit 1; }`,
        'AppuBot wants to switch sleep off and on by itself, so your Mac stays awake with the lid closed.',
      );
    },
    async removeLidRule({ restoreSleep }) {
      // as root, so it works without the rule; if sleep can't come back on the rule stays (the only way back later)
      const restore = restoreSleep ? `/usr/bin/pmset -a disablesleep 0 || { echo 'Sleep could not be switched back on.' >&2; exit 1; }; ` : '';
      // an earlier build's Mac-wide file goes too, but only when it is this user's
      const legacy = `/usr/bin/grep -qxF ${sh(lidRuleLegacyLine(user))} ${LEGACY_LID_RULE_PATH} 2>/dev/null && /bin/rm -f ${LEGACY_LID_RULE_PATH}`;
      await asAdmin(`${restore}/bin/rm -f ${sh(rulePath)}; ${legacy}; exit 0`, 'AppuBot wants to remove its permission to switch sleep off.');
    },
    async setSleepDisabled(on) {
      await run('/usr/bin/sudo', ['-n', '/usr/bin/pmset', '-a', 'disablesleep', on ? '1' : '0']);
    },
    startWatchdog(markerPath) {
      stopWatchdog();
      const child = spawn('/bin/sh', ['-c', watchdogScript(PMSET_OFF), 'appubot-power-watchdog', String(process.pid), markerPath], {
        detached: true, stdio: 'ignore',
      });
      child.on('error', () => undefined);
      child.unref();
      watchdog = child;
    },
    stopWatchdog,
    installRecovery(markerDir) {
      mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
      const script = recoveryScript(PMSET_OFF, SLEEP_IS_OFF);
      const plist = recoveryPlist({ label: RECOVERY_LABEL, script, markerDir, plistPath: RECOVERY_PLIST, bundleId: APP_ID });
      // an unchanged item isn't rewritten (macOS may announce a rewritten one as a new background item)
      if (existsSync(RECOVERY_PLIST) && readFileSync(RECOVERY_PLIST, 'utf8') === plist) return;
      writeFileSync(RECOVERY_PLIST, plist, { mode: 0o644 });
    },
    removeRecovery() {
      rmSync(RECOVERY_PLIST, { force: true });
    },
  };
}

/** The idle-sleep blocker and power events, the same on Windows and Linux. */
function sleepBlocker(): Pick<PowerHost, 'preventSleep' | 'allowSleep' | 'onBattery' | 'thermalState' | 'onChange' | 'bootTime'> {
  let blocker: number | null = null;
  return {
    preventSleep() {
      if (blocker === null || !powerSaveBlocker.isStarted(blocker)) blocker = powerSaveBlocker.start('prevent-app-suspension');
    },
    allowSleep() {
      if (blocker !== null && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
      blocker = null;
    },
    onBattery: () => powerMonitor.isOnBatteryPower(),
    // only macOS reports a thermal state: no heat pause elsewhere
    thermalState: () => 'unknown',
    onChange(fn) {
      powerMonitor.on('on-ac', fn).on('on-battery', fn);
      return () => { powerMonitor.off('on-ac', fn).off('on-battery', fn); };
    },
    bootTime: async () => Date.now() - Math.round(uptime() * 1000),
  };
}

/**
 * Windows: lid mode sets the active power plan's lid action to "Do nothing" and its idle sleep timer to never with
 * powercfg (a user's own power plan settings need no administrator), like macOS's `pmset disablesleep`. The old values
 * wait in `power-lid-windows.json` until they are put back (quit, the watchdog, the next start, or the Run-key script
 * at the next login), so nothing else is needed to set it up. Keeping awake holds a "system required" request too
 * (windowsKeepAwakeScript): Electron's own only keeps an S3 laptop awake, not a Modern Standby one.
 */
export function createWindowsPowerHost(dataDir: string): PowerHost {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const powercfg = join(root, 'System32', 'powercfg.exe');
  const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const stateFile = join(dataDir, 'power-lid-windows.json');
  const recoveryFile = join(dataDir, 'power-recovery.ps1');
  const runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const runValue = 'AppuBotPowerRecovery';
  const reg = join(root, 'System32', 'reg.exe');
  const win = (file: string, args: string[], timeout = 10_000): Promise<string> => new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve(stdout);
    });
  });
  const ps = (script: string, timeout = 15_000): Promise<string> =>
    win(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)], timeout);
  const saved = (): WindowsLidState | undefined => {
    try { return JSON.parse(readFileSync(stateFile, 'utf8')) as WindowsLidState; } catch { return undefined; }
  };
  const setSleepDisabled = windowsLidSwitch({
    run: (file, args) => win(file, args),
    load: saved,
    save: (st) => writeFileSync(stateFile, JSON.stringify(st)),
    clear: () => rmSync(stateFile, { force: true }),
  }, { powercfg, reg });
  // keeping awake: Electron's request plus a "system required" one held by a PowerShell child that ends with the app
  const blocker = sleepBlocker();
  let awake: ChildProcess | null = null;
  const stopAwake = (): void => {
    if (awake?.pid && awake.exitCode === null) try { awake.kill(); } catch { /* gone */ }
    awake = null;
  };
  let watchdog: ChildProcess | null = null;
  const stopWatchdog = (): void => {
    if (watchdog?.pid && watchdog.exitCode === null) try { watchdog.kill(); } catch { /* gone */ }
    watchdog = null;
  };

  return {
    ...blocker,
    preventSleep() {
      blocker.preventSleep();
      if (awake && awake.exitCode === null) return;
      const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(windowsKeepAwakeScript(process.pid))], {
        stdio: 'ignore', windowsHide: true,
      });
      child.on('error', () => undefined);
      child.unref();
      awake = child;
    },
    allowSleep() {
      stopAwake();
      blocker.allowSleep();
    },
    batteryPct: async () => parseWindowsBatteryPct(await ps('(Get-CimInstance Win32_Battery | Measure-Object -Property EstimatedChargeRemaining -Average).Average')),
    sleepDisabled: async () => existsSync(stateFile),
    lidRuleInstalled: async () => true,
    installLidRule: async () => undefined,
    async removeLidRule({ restoreSleep }) {
      if (restoreSleep) await setSleepDisabled(false);
    },
    setSleepDisabled,
    restoreHint: 'Set “When I close the lid” and “Put the computer to sleep” back in Control Panel › Power Options.',
    startWatchdog(markerPath) {
      stopWatchdog();
      const script = windowsWatchdogScript({ pid: process.pid, marker: markerPath, stateFile, powercfg });
      const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.on('error', () => undefined);
      child.unref();
      watchdog = child;
    },
    stopWatchdog,
    installRecovery(markerDir) {
      const script = windowsRecoveryScript({ markerDir, stateFile, powercfg, runKey, runValue });
      if (!existsSync(recoveryFile) || readFileSync(recoveryFile, 'utf8') !== script) writeFileSync(recoveryFile, script);
      // a Run value is limited to 260 characters: it only names the script
      const command = `"${powershell}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${recoveryFile}"`;
      execFile(reg, ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', runValue, '/t', 'REG_SZ', '/d', command, '/f'], { windowsHide: true }, () => undefined);
    },
    removeRecovery() {
      execFile(reg, ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', runValue, '/f'], { windowsHide: true }, () => undefined);
      rmSync(recoveryFile, { force: true });
    },
  };
}

/**
 * Linux: lid mode is a systemd-logind inhibitor lock (block the lid switch and sleep), allowed for the active session
 * without a password, held by `systemd-inhibit` whose child waits for this app to end: it can't outlive AppuBot, so
 * there is no watchdog or login-time recovery. Without systemd-logind there is no lid mode.
 */
export function createLinuxPowerHost(): PowerHost {
  const inhibit = ['/usr/bin/systemd-inhibit', '/bin/systemd-inhibit'].find((p) => existsSync(p));
  let lock: ChildProcess | null = null;
  const holding = (): boolean => !!lock && lock.exitCode === null && lock.signalCode === null;
  const release = (): void => {
    if (lock?.pid && holding()) try { process.kill(-lock.pid, 'SIGTERM'); } catch { lock.kill('SIGTERM'); }
    lock = null;
  };
  return {
    ...sleepBlocker(),
    async batteryPct() {
      const dir = '/sys/class/power_supply';
      let names: string[];
      try { names = readdirSync(dir); } catch { return undefined; }
      const read = (n: string, f: string): string | undefined => { try { return readFileSync(join(dir, n, f), 'utf8'); } catch { return undefined; } };
      return linuxBatteryPct(names.map((n) => ({ type: read(n, 'type') ?? '', capacity: read(n, 'capacity') })));
    },
    sleepDisabled: async () => holding(),
    lidRuleInstalled: async () => !!inhibit,
    async installLidRule() {
      throw new Error('Staying awake with the lid closed needs systemd-logind (systemd-inhibit), which this system doesn’t have.');
    },
    async removeLidRule({ restoreSleep }) {
      if (restoreSleep) release();
    },
    async setSleepDisabled(on) {
      if (!on) { release(); return; }
      if (holding()) return;
      if (!inhibit) throw new Error('systemd-inhibit is missing.');
      const child = spawn(inhibit, linuxInhibitArgs(process.pid), { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
      // a refused lock (polkit, no logind) ends at once: wait a moment to tell that from a lock being held
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => { child.off('exit', onExit); resolve(); }, 700);
        function onExit(code: number | null): void {
          clearTimeout(t);
          reject(new Error(stderr.trim() || `systemd-inhibit ended (${code})`));
        }
        child.once('exit', onExit);
        child.once('error', (e) => { clearTimeout(t); reject(e); });
      });
      child.unref();
      lock = child;
    },
    restoreHint: 'Quit AppuBot: its lock ends with it.',
    startWatchdog: () => undefined,
    stopWatchdog: () => undefined,
    installRecovery: () => undefined,
    removeRecovery: () => undefined,
  };
}
