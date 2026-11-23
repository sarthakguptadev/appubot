import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  encodePowerShell, linuxBatteryPct, linuxInhibitArgs, parseActiveScheme, parseLidAction, parseSettingValues, parseWindowsBatteryPct,
  powercfgSetLid, windowsKeepAwakeScript, windowsLidSwitch, windowsRecoveryScript, windowsWatchdogScript, type WindowsLidState,
} from './powerPlatforms';

const QUERY = `Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)
  Subgroup GUID: 4f971e89-eebd-4455-a8de-9e59040e7347  (Power buttons and lid)
    GUID Alias: SUB_BUTTONS
    Power Setting GUID: 5ca83367-6e45-459f-a27b-476b1d01c936  (Lid close action)
      GUID Alias: LIDACTION
      Possible Setting Index: 000
      Possible Setting Friendly Name: Do nothing
      Possible Setting Index: 001
      Possible Setting Friendly Name: Sleep
    Current AC Power Setting Index: 0x00000001
    Current DC Power Setting Index: 0x00000002
`;

/** `powercfg /qh <scheme> SUB_SLEEP STANDBYIDLE`: a range setting prints its minimum, maximum and step before the values */
const SLEEP_QUERY = `Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)
  Subgroup GUID: 238c9fa8-0aad-41ed-83f4-97be242c8f20  (Sleep)
    GUID Alias: SUB_SLEEP
    Power Setting GUID: 29f6c1db-86da-48c5-9fdb-f2b67b1f44da  (Sleep after)
      GUID Alias: STANDBYIDLE
      Minimum Possible Setting: 0x00000000
      Maximum Possible Setting: 0xffffffff
      Possible Settings increment: 0x00000001
      Possible Settings units: Seconds
    Current AC Power Setting Index: 0x00000708
    Current DC Power Setting Index: 0x0000012c
`;

/**
 * A Windows PC for windowsLidSwitch: powercfg keeps each setting's AC/DC values per plan (`hidden` ones only answer
 * /qh, `refuse` ones ignore what is set), reg answers the lid policy key when `policy` is set.
 */
function windowsPc(o: { hidden?: boolean; noQh?: boolean; unreadable?: boolean; refuse?: boolean; policy?: boolean; state?: WindowsLidState } = {}) {
  const plan: Record<string, { ac: number; dc: number }> = { LIDACTION: { ac: 1, dc: 1 }, STANDBYIDLE: { ac: 1800, dc: 300 } };
  const calls: string[] = [];
  let state: WindowsLidState | undefined = o.state;
  const run = async (file: string, args: string[]): Promise<string> => {
    calls.push(`${file} ${args.join(' ')}`);
    if (file === 'reg') {
      if (o.policy) return 'HKEY_LOCAL_MACHINE\\...\\5ca83367\n    ACSettingIndex    REG_DWORD    0x1\n';
      throw new Error('ERROR: The system was unable to find the specified registry key or value.');
    }
    const [cmd, , , setting] = args;
    if (cmd === '/getactivescheme') return 'Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)';
    if (cmd === '/qh' || cmd === '/query') {
      if (cmd === '/qh' && o.noQh) throw new Error('Invalid Parameters -- try "/?" for help');
      if (o.unreadable && setting === 'LIDACTION') return 'Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)';
      if (setting === 'LIDACTION' && o.hidden && cmd === '/query') return 'Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)';
      const v = plan[setting!]!;
      const range = setting === 'STANDBYIDLE' ? 'Minimum Possible Setting: 0x00000000\nMaximum Possible Setting: 0xffffffff\nPossible Settings increment: 0x00000001\n' : '';
      return `${range}Current AC Power Setting Index: 0x${v.ac.toString(16)}\nCurrent DC Power Setting Index: 0x${v.dc.toString(16)}\n`;
    }
    if ((cmd === '/setacvalueindex' || cmd === '/setdcvalueindex') && !o.refuse) {
      plan[args[3]!]![cmd === '/setacvalueindex' ? 'ac' : 'dc'] = Number(args[4]);
    }
    return '';
  };
  const lid = windowsLidSwitch({ run, load: () => state, save: (st) => { state = st; }, clear: () => { state = undefined; } }, { powercfg: 'powercfg', reg: 'reg' });
  return { lid, plan, calls, state: () => state };
}

describe('Windows lid mode on a PC', () => {
  it('finds a hidden lid setting, turns the lid and sleep off, and puts both back', async () => {
    const pc = windowsPc({ hidden: true });
    await pc.lid(true);
    expect(pc.plan).toEqual({ LIDACTION: { ac: 0, dc: 0 }, STANDBYIDLE: { ac: 0, dc: 0 } });
    expect(pc.state()).toEqual({ scheme: '381b4222-f694-41f0-9685-ff5bb260df2e', ac: 1, dc: 1, sleep: { ac: 1800, dc: 300 } });
    // switched on again (a relaunch with lid mode on): the values from before lid mode stay the ones kept
    await pc.lid(true);
    expect(pc.state()).toMatchObject({ ac: 1, dc: 1, sleep: { ac: 1800, dc: 300 } });
    await pc.lid(false);
    expect(pc.plan).toEqual({ LIDACTION: { ac: 1, dc: 1 }, STANDBYIDLE: { ac: 1800, dc: 300 } });
    expect(pc.state()).toBeUndefined();
  });

  it('keeps the sleep timer of a lid mode an older version switched on, which left it alone', async () => {
    const pc = windowsPc({ state: { scheme: '381b4222-f694-41f0-9685-ff5bb260df2e', ac: 2, dc: 1 } });
    pc.plan.LIDACTION = { ac: 0, dc: 0 };
    await pc.lid(true); // the next start, lid mode still on
    expect(pc.state()).toEqual({ scheme: '381b4222-f694-41f0-9685-ff5bb260df2e', ac: 2, dc: 1, sleep: { ac: 1800, dc: 300 } });
    expect(pc.plan.STANDBYIDLE).toEqual({ ac: 0, dc: 0 });
    await pc.lid(false);
    expect(pc.plan).toEqual({ LIDACTION: { ac: 2, dc: 1 }, STANDBYIDLE: { ac: 1800, dc: 300 } });
  });

  it('reads with plain /query where there is no /qh, and puts back Sleep when the lid action reads as nothing', async () => {
    const old = windowsPc({ noQh: true });
    await old.lid(true);
    expect(old.state()).toMatchObject({ ac: 1, dc: 1 });
    const blind = windowsPc({ unreadable: true });
    await blind.lid(true);
    expect(blind.plan.LIDACTION).toEqual({ ac: 0, dc: 0 });
    expect(blind.state()).toMatchObject({ ac: 1, dc: 1 });
  });

  it("says so when the organisation's policy decides the lid, changing nothing", async () => {
    const pc = windowsPc({ policy: true });
    await expect(pc.lid(true)).rejects.toThrow(/policy/);
    expect(pc.calls.some((c) => c.includes('/set'))).toBe(false);
    expect(pc.state()).toBeUndefined();
  });

  it("puts everything back and says so when Windows doesn't take the change", async () => {
    const pc = windowsPc({ refuse: true });
    await expect(pc.lid(true)).rejects.toThrow(/didn’t take/);
    expect(pc.state()).toBeUndefined();
    expect(pc.calls.filter((c) => c.includes('/setacvalueindex 381b4222-f694-41f0-9685-ff5bb260df2e SUB_BUTTONS LIDACTION')).map((c) => c.split(' ').at(-1))).toEqual(['0', '1']);
  });
});

describe('Windows lid action', () => {
  it('reads the active plan and its AC/DC lid values, whatever the language', () => {
    expect(parseActiveScheme('Power Scheme GUID: 381B4222-F694-41F0-9685-FF5BB260DF2E  (Balanced)')).toBe('381b4222-f694-41f0-9685-ff5bb260df2e');
    expect(parseActiveScheme('nothing here')).toBeUndefined();
    expect(parseLidAction(QUERY)).toEqual({ ac: 1, dc: 2 });
    expect(parseLidAction(QUERY.replace('Current AC Power Setting Index', 'Index actuel du paramètre d’alimentation secteur'))).toEqual({ ac: 1, dc: 2 });
    expect(parseLidAction('Current AC Power Setting Index: 0x00000003')).toEqual({ ac: 3, dc: 3 });
    expect(parseLidAction('Invalid Parameters')).toBeUndefined();
  });

  it("reads a timer's values after its minimum, maximum and step, AC only on a desktop", () => {
    expect(parseSettingValues(SLEEP_QUERY)).toEqual({ ac: 1800, dc: 300 });
    expect(parseSettingValues(SLEEP_QUERY.replace(/\s+Current DC.*\n/, '\n'))).toEqual({ ac: 1800, dc: 1800 });
    // a hidden lid action that plain /query leaves out: just the plan and its subgroup
    expect(parseSettingValues('Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)\n  Subgroup GUID: 4f971e89-eebd-4455-a8de-9e59040e7347')).toBeUndefined();
  });

  it('sets both values (and the sleep timer when kept), then makes the plan active again', () => {
    expect(powercfgSetLid('g', 0, 0)).toEqual([
      ['/setacvalueindex', 'g', 'SUB_BUTTONS', 'LIDACTION', '0'],
      ['/setdcvalueindex', 'g', 'SUB_BUTTONS', 'LIDACTION', '0'],
      ['/setactive', 'g'],
    ]);
    expect(powercfgSetLid('g', 1, 1, { ac: 1800, dc: 300 })).toEqual([
      ['/setacvalueindex', 'g', 'SUB_BUTTONS', 'LIDACTION', '1'],
      ['/setdcvalueindex', 'g', 'SUB_BUTTONS', 'LIDACTION', '1'],
      ['/setacvalueindex', 'g', 'SUB_SLEEP', 'STANDBYIDLE', '1800'],
      ['/setdcvalueindex', 'g', 'SUB_SLEEP', 'STANDBYIDLE', '300'],
      ['/setactive', 'g'],
    ]);
  });

  it('holds a system-required request for as long as the app lives', () => {
    const k = windowsKeepAwakeScript(42);
    expect(k).toContain('SetThreadExecutionState([uint32]2147483649)'); // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    expect(k).toContain('Get-Process -Id 42');
  });

  it('builds the watchdog and recovery scripts with single-quoted paths', () => {
    const w = windowsWatchdogScript({ pid: 42, marker: "C:\\Users\\O'Neil\\m.json", stateFile: 'C:\\s.json', powercfg: 'C:\\Windows\\System32\\powercfg.exe' });
    expect(w).toContain('Get-Process -Id 42');
    expect(w).toContain("'C:\\Users\\O''Neil\\m.json'");
    expect(w).toContain(`-notmatch '"pid":42[,}]'`);
    expect(w).toContain('/setacvalueindex $s.scheme SUB_BUTTONS LIDACTION $s.ac');
    // the sleep timer too, when the state file kept it (older ones didn't)
    expect(w).toContain('if ($s.sleep) {');
    expect(w).toContain('/setdcvalueindex $s.scheme SUB_SLEEP STANDBYIDLE $s.sleep.dc');
    const r = windowsRecoveryScript({ markerDir: 'C:\\d', stateFile: 'C:\\d\\s.json', powercfg: 'p.exe', runKey: 'HKCU:\\Run', runValue: 'V' });
    expect(r).toContain("Remove-ItemProperty -Path 'HKCU:\\Run' -Name 'V'");
    expect(r).toContain('LastBootUpTime');
  });

  it('encodes PowerShell as UTF-16LE base64', () => {
    expect(Buffer.from(encodePowerShell('Write-Host é'), 'base64').toString('utf16le')).toBe('Write-Host é');
  });

  it('reads the battery charge PowerShell prints', () => {
    expect(parseWindowsBatteryPct('63\r\n')).toBe(63);
    expect(parseWindowsBatteryPct('87,5')).toBe(87);
    expect(parseWindowsBatteryPct('')).toBeUndefined();
  });
});

describe('Linux lid lock', () => {
  it('blocks the lid switch and sleep for as long as the app lives', () => {
    const args = linuxInhibitArgs(1234);
    expect(args.slice(0, 4)).toEqual(['--what=handle-lid-switch:sleep', '--who=AppuBot', '--why=Your bots keep working with the lid closed', '--mode=block']);
    expect(args.slice(-2)).toEqual(['appubot-lid', '1234']);
  });

  // the child is a /bin/sh script that only the Linux host spawns
  it.skipIf(process.platform === 'win32')("its child ends once the app's pid is gone", () => {
    const [, , , , sh, c, script, name] = linuxInhibitArgs(999_999);
    const r = spawnSync(sh!, [c!, script!, name!, '999999'], { timeout: 3000 });
    expect(r.status).toBe(0);
  });

  it('averages the batteries in /sys/class/power_supply', () => {
    expect(linuxBatteryPct([{ type: 'Mains\n', capacity: undefined }, { type: 'Battery\n', capacity: '40\n' }, { type: 'Battery', capacity: '61' }])).toBe(51);
    expect(linuxBatteryPct([{ type: 'Mains', capacity: undefined }])).toBeUndefined();
    expect(linuxBatteryPct([{ type: 'Battery', capacity: 'bogus' }])).toBeUndefined();
  });
});
