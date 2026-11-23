/**
 * Lid mode off macOS (the pure parts; electron/power.ts runs them). Windows: the active power plan's lid action
 * (`powercfg`, LIDACTION under SUB_BUTTONS, AC and battery) is set to "Do nothing" and its idle sleep timer (STANDBYIDLE
 * under SUB_SLEEP) to never, like macOS's `pmset disablesleep`: on a Modern Standby laptop a closed lid still sleeps
 * when that timer runs out, and Windows drops apps' keep-awake requests on battery 5 minutes after it. The old values
 * wait in a state file until they are put back: on quit, by a watchdog once the app dies, at the next start (stale
 * marker) or at the next login after a reboot (a Run-key script). Linux: systemd-logind's lid switch and sleep are
 * blocked by an inhibitor lock held by a child that ends with the app, so nothing outlives it.
 */

/**
 * What Windows' power plan (`scheme`, a GUID) had before lid mode, on AC and on battery: its lid action, and its idle
 * sleep timer in seconds (`sleep`; absent in state files from before it was kept, or when it couldn't be read).
 */
export interface WindowsLidState { scheme: string; ac: number; dc: number; sleep?: { ac: number; dc: number } }

/** Windows' own default lid action, "Sleep": what is put back when the plan's value can't be read. */
export const WINDOWS_DEFAULT_LID = 1;

/** `powercfg /getactivescheme`: "Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)" (localized label). */
export function parseActiveScheme(out: string): string | undefined {
  return /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(out)?.[1]?.toLowerCase();
}

/**
 * One setting's current values from `powercfg /qh <scheme> <subgroup> <setting>` (`/qh`: hidden settings too; many
 * laptops hide the lid action, and plain `/query` then prints nothing for it). Its labels are localized, but a choice
 * setting (the lid action) prints `0x` numbers only for its current AC value, then the DC (battery) one, while a range
 * setting (a timer) first prints its minimum, maximum and step. A desktop without a battery may list AC only.
 */
export function parseSettingValues(out: string): { ac: number; dc: number } | undefined {
  let hex = [...out.matchAll(/\b0x([0-9a-f]{1,8})\b/gi)].map((m) => parseInt(m[1]!, 16));
  if (hex.length >= 4) hex = hex.slice(3);
  if (!hex.length) return undefined;
  return { ac: hex[0]!, dc: hex[1] ?? hex[0]! };
}
/** the lid action's values (see parseSettingValues) */
export const parseLidAction = parseSettingValues;

/**
 * The powercfg calls that set a plan's lid action (0 = do nothing) and, when given, its idle sleep timer (seconds, 0 =
 * never), then make the change take effect.
 */
export function powercfgSetLid(scheme: string, ac: number, dc: number, sleep?: { ac: number; dc: number }): string[][] {
  return [
    ['/setacvalueindex', scheme, 'SUB_BUTTONS', 'LIDACTION', String(ac)],
    ['/setdcvalueindex', scheme, 'SUB_BUTTONS', 'LIDACTION', String(dc)],
    ...(sleep ? [
      ['/setacvalueindex', scheme, 'SUB_SLEEP', 'STANDBYIDLE', String(sleep.ac)],
      ['/setdcvalueindex', scheme, 'SUB_SLEEP', 'STANDBYIDLE', String(sleep.dc)],
    ] : []),
    ['/setactive', scheme],
  ];
}

/**
 * Where Group Policy keeps "Select the lid switch action" (under the lid action's GUID): when it is set, the policy
 * decides what closing the lid does and the plan's own value (what powercfg changes) doesn't count.
 */
export const LID_POLICY_KEY = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Power\\PowerSettings\\5ca83367-6e45-459f-a27b-476b1d01c936';

/**
 * Windows keep-awake (PowerShell): a "system required" request (SetThreadExecutionState, ES_CONTINUOUS |
 * ES_SYSTEM_REQUIRED) held while the app runs. Electron's own blocker is an "execution required" request, which keeps a
 * Modern Standby laptop's processes running but not the laptop out of sleep (only on S3 sleep does it imply this one).
 */
export function windowsKeepAwakeScript(pid: number): string {
  return [
    "$k = Add-Type -Name 'Awake' -Namespace 'AppuBot' -PassThru -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
    'if ($k::SetThreadExecutionState([uint32]2147483649) -eq 0) { exit 1 }',
    `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 5 }`,
  ].join('\n');
}

/** What Windows lid mode needs from the system: running its tools, and the state file that keeps the old values. */
export interface WindowsLidIo {
  /** runs a tool (absolute path) and gives its output; rejects with its message when it fails */
  run(file: string, args: string[]): Promise<string>;
  load(): WindowsLidState | undefined;
  save(s: WindowsLidState): void;
  clear(): void;
}

/**
 * Windows lid mode's switch (`on`: lid "Do nothing" and sleep timer never on the active plan; off: the old values back).
 * Switching on refuses a lid setting Group Policy manages, keeps the values from before lid mode once (a second
 * switch-on must not save its own "do nothing"; a lid action that can't be read at all is put back as Windows' default,
 * Sleep), and checks that Windows took the change, else puts everything back and says so.
 */
export function windowsLidSwitch(io: WindowsLidIo, tools: { powercfg: string; reg: string }): (on: boolean) => Promise<void> {
  const set = async (scheme: string, ac: number, dc: number, sleep?: { ac: number; dc: number }): Promise<void> => {
    for (const args of powercfgSetLid(scheme, ac, dc, sleep)) await io.run(tools.powercfg, args);
  };
  /** a setting's current values, hidden ones too (`/qh`; plain `/query` if this Windows has no `/qh`), else undefined */
  const read = async (scheme: string, sub: string, setting: string): Promise<{ ac: number; dc: number } | undefined> => {
    for (const q of ['/qh', '/query']) {
      try {
        const v = parseSettingValues(await io.run(tools.powercfg, [q, scheme, sub, setting]));
        if (v) return v;
      } catch { /* the next way */ }
    }
    return undefined;
  };
  const managed = (): Promise<boolean> => io.run(tools.reg, ['query', LID_POLICY_KEY]).then((out) => /SettingIndex/i.test(out), () => false);
  return async (on) => {
    if (!on) {
      const s = io.load();
      if (!s) return;
      await set(s.scheme, s.ac, s.dc, s.sleep);
      io.clear();
      return;
    }
    if (await managed()) throw new Error('Your organisation’s policy decides what closing the lid does on this PC, so AppuBot can’t change it.');
    if (!io.load()) {
      const scheme = parseActiveScheme(await io.run(tools.powercfg, ['/getactivescheme']));
      if (!scheme) throw new Error('Couldn’t find the active power plan.');
      const lid = (await read(scheme, 'SUB_BUTTONS', 'LIDACTION')) ?? { ac: WINDOWS_DEFAULT_LID, dc: WINDOWS_DEFAULT_LID };
      const sleep = await read(scheme, 'SUB_SLEEP', 'STANDBYIDLE');
      io.save({ scheme, ...lid, ...(sleep ? { sleep } : {}) });
    } else if (!io.load()!.sleep) {
      // kept by a version that left the sleep timer alone: it is still the user's own, so keep it now
      const old = io.load()!;
      const sleep = await read(old.scheme, 'SUB_SLEEP', 'STANDBYIDLE');
      if (sleep) io.save({ ...old, sleep });
    }
    const s = io.load()!;
    await set(s.scheme, 0, 0, s.sleep ? { ac: 0, dc: 0 } : undefined);
    // Windows may refuse the change quietly (a locked-down plan): check that it took
    const now = await read(s.scheme, 'SUB_BUTTONS', 'LIDACTION');
    if (now && (now.ac !== 0 || now.dc !== 0)) {
      await set(s.scheme, s.ac, s.dc, s.sleep).catch(() => undefined);
      io.clear();
      throw new Error('Windows didn’t take the new lid setting.');
    }
  };
}

const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** PowerShell that puts a saved lid action back (from the JSON state file) and removes the file. */
function psRestore(powercfg: string, stateFile: string): string {
  return [
    `$s = Get-Content -Raw -LiteralPath ${psQuote(stateFile)} -ErrorAction SilentlyContinue | ConvertFrom-Json`,
    'if ($s) {',
    `  & ${psQuote(powercfg)} /setacvalueindex $s.scheme SUB_BUTTONS LIDACTION $s.ac`,
    `  & ${psQuote(powercfg)} /setdcvalueindex $s.scheme SUB_BUTTONS LIDACTION $s.dc`,
    '  if ($s.sleep) {',
    `    & ${psQuote(powercfg)} /setacvalueindex $s.scheme SUB_SLEEP STANDBYIDLE $s.sleep.ac`,
    `    & ${psQuote(powercfg)} /setdcvalueindex $s.scheme SUB_SLEEP STANDBYIDLE $s.sleep.dc`,
    '  }',
    `  & ${psQuote(powercfg)} /setactive $s.scheme`,
    `  Remove-Item -LiteralPath ${psQuote(stateFile)} -Force -ErrorAction SilentlyContinue`,
    '}',
  ].join('\n');
}

/**
 * The Windows watchdog (PowerShell): waits while the app runs, then puts the lid action back only if the marker still
 * names that pid (a quick relaunch that rewrote it keeps its lid mode).
 */
export function windowsWatchdogScript(o: { pid: number; marker: string; stateFile: string; powercfg: string }): string {
  return [
    `while (Get-Process -Id ${o.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 5 }`,
    `$m = Get-Content -Raw -LiteralPath ${psQuote(o.marker)} -ErrorAction SilentlyContinue`,
    `if (-not $m -or $m -notmatch '"pid":${o.pid}[,}]') { exit 0 }`,
    psRestore(o.powercfg, o.stateFile),
    `Remove-Item -LiteralPath ${psQuote(o.marker)} -Force -ErrorAction SilentlyContinue`,
  ].join('\n');
}

/**
 * The Windows login-time recovery (a .ps1 the Run key starts): markers from before this boot mean a run never put the
 * lid action back, so it is restored and they go. With no marker from this boot left, the Run value removes itself.
 */
export function windowsRecoveryScript(o: { markerDir: string; stateFile: string; powercfg: string; runKey: string; runValue: string }): string {
  return [
    '$boot = [DateTimeOffset]::new((Get-CimInstance Win32_OperatingSystem).LastBootUpTime).ToUnixTimeMilliseconds()',
    '$stale = @(); $live = $false',
    `foreach ($f in Get-ChildItem -LiteralPath ${psQuote(o.markerDir)} -Filter 'power-lid*.json' -ErrorAction SilentlyContinue) {`,
    '  $since = 0; try { $since = [int64](Get-Content -Raw -LiteralPath $f.FullName | ConvertFrom-Json).since } catch { }',
    '  if ($since -lt $boot) { $stale += $f.FullName } else { $live = $true }',
    '}',
    'if ($stale.Count -gt 0) {',
    psRestore(o.powercfg, o.stateFile).split('\n').map((l) => `  ${l}`).join('\n'),
    '  foreach ($f in $stale) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }',
    '}',
    `if (-not $live) { Remove-ItemProperty -Path ${psQuote(o.runKey)} -Name ${psQuote(o.runValue)} -ErrorAction SilentlyContinue }`,
  ].join('\n');
}

/** PowerShell's -EncodedCommand: the script as UTF-16LE base64 (no quoting through any command line). */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Linux: `systemd-inhibit` holding a block lock on the lid switch and on sleep while its child runs; the child waits for
 * the app's pid to go, so a crash releases the lock within seconds.
 */
export function linuxInhibitArgs(pid: number): string[] {
  return [
    '--what=handle-lid-switch:sleep', '--who=AppuBot', '--why=Your bots keep working with the lid closed', '--mode=block',
    '/bin/sh', '-c', 'while kill -0 "$1" 2>/dev/null; do sleep 5; done', 'appubot-lid', String(pid),
  ];
}

/** Linux batteries (`/sys/class/power_supply/<name>/{type,capacity}`): their mean charge, undefined without one. */
export function linuxBatteryPct(supplies: { type: string; capacity?: string }[]): number | undefined {
  const pcts = supplies
    .filter((s) => s.type.trim() === 'Battery' && s.capacity !== undefined && /^\d+$/.test(s.capacity.trim()))
    .map((s) => Math.min(100, Number(s.capacity!.trim())));
  return pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : undefined;
}

/** Windows: `Win32_Battery`'s EstimatedChargeRemaining as PowerShell prints it ("" without a battery). */
export function parseWindowsBatteryPct(out: string): number | undefined {
  const m = /(\d{1,3})(?:[.,]\d+)?/.exec(out.trim());
  return m ? Math.min(100, Number(m[1])) : undefined;
}
