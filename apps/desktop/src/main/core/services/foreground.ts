/**
 * Reading the window in front on Windows and Linux for teach mode's recording (its app and title; the host,
 * `electron/inputWatch.ts`, runs the commands). Linux (X11): `xprop` on the root window's `_NET_ACTIVE_WINDOW`, then on
 * that window. Windows: one PowerShell process for the whole recording, asked a line at a time (user32
 * GetForegroundWindow / GetWindowText / GetWindowThreadProcessId; the app is the exe's description, else its name).
 * Pure: parsing and the script only.
 */

/** what was read about the window in front (the pid tells AppuBot's own windows apart) */
export interface ForegroundInfo { pid?: number; app?: string; title?: string }

/** `_NET_ACTIVE_WINDOW: window id # 0x3a00007` → `0x3a00007` (none, or 0x0: nothing in front) */
export function parseActiveWindowId(out: string): string | null {
  const m = /window id # (0x[0-9a-f]+)/i.exec(out);
  if (!m || /^0x0+$/i.test(m[1]!)) return null;
  return m[1]!;
}

/** xprop's quoted string: `\"`, `\\` and octal `\ooo` bytes (non-ASCII in a non-UTF-8 locale) decoded as UTF-8 */
function unquote(s: string): string {
  const bytes: number[] = [];
  const text = new TextEncoder();
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length) {
      const oct = /^[0-7]{3}/.exec(s.slice(i + 1));
      if (oct) {
        bytes.push(parseInt(oct[0], 8) & 0xff);
        i += 3;
        continue;
      }
      i++;
      bytes.push(...text.encode(s[i]!));
      continue;
    }
    bytes.push(...text.encode(c));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** the quoted strings of a property value: `"a", "b"` → ['a', 'b'] */
function strings(value: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  for (let m = re.exec(value); m; m = re.exec(value)) out.push(unquote(m[1]!));
  return out;
}

/**
 * `xprop -id <id> -notype WM_CLASS _NET_WM_NAME WM_NAME _NET_WM_PID`'s output → the app (WM_CLASS's class, e.g.
 * "firefox", "Gnome-terminal"), the title (`_NET_WM_NAME`, else `WM_NAME`) and the pid. Missing properties read
 * `NAME:  not found.` and are skipped.
 */
export function parseXpropWindow(out: string): ForegroundInfo {
  const props = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = /^([A-Z_]+)(?:\([^)]*\))?\s*=\s*(.*)$/.exec(line.trim());
    if (m) props.set(m[1]!, m[2]!);
  }
  const info: ForegroundInfo = {};
  const cls = strings(props.get('WM_CLASS') ?? '');
  const app = cls[1] || cls[0];
  if (app) info.app = app;
  const title = strings(props.get('_NET_WM_NAME') ?? '')[0] || strings(props.get('WM_NAME') ?? '')[0];
  if (title) info.title = title;
  const pid = Number.parseInt(props.get('_NET_WM_PID') ?? '', 10);
  if (Number.isInteger(pid) && pid > 0) info.pid = pid;
  return info;
}

/**
 * The PowerShell side (Windows PowerShell 5.1, in every Windows 10/11): reads a request id per line and answers
 * `<id>\t<pid>\t<base64 UTF-8 app>\t<base64 UTF-8 title>`, base64 so the console's code page never garbles a title.
 * Process names are cached by pid. Run with `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File`.
 */
export const PS_FOREGROUND_SCRIPT = [
  '$ErrorActionPreference = \'Stop\'',
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public static class AppuBotForeground {',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);',
  '}',
  '"@',
  '$ErrorActionPreference = \'SilentlyContinue\'',
  '$utf8 = New-Object System.Text.UTF8Encoding $false',
  '$tab = [string][char]9',
  '$names = @{}',
  'function ToB64([string]$s) { if (-not $s) { return \'\' }; return [Convert]::ToBase64String($utf8.GetBytes($s)) }',
  '[Console]::Out.WriteLine(\'ready\')',
  '[Console]::Out.Flush()',
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($null -eq $line) { break }',
  '  $h = [AppuBotForeground]::GetForegroundWindow()',
  '  $sb = New-Object System.Text.StringBuilder 512',
  '  [void][AppuBotForeground]::GetWindowTextW($h, $sb, 512)',
  '  [uint32]$fgPid = 0',
  '  [void][AppuBotForeground]::GetWindowThreadProcessId($h, [ref]$fgPid)',
  '  $name = $names[$fgPid]',
  '  if ($null -eq $name) {',
  '    $name = \'\'',
  '    try {',
  '      $p = Get-Process -Id $fgPid',
  '      $name = $p.ProcessName',
  '      $d = $p.MainModule.FileVersionInfo.FileDescription',
  '      if ($d) { $name = $d.Trim() }',
  '    } catch {}',
  '    $names[$fgPid] = $name',
  '  }',
  '  [Console]::Out.WriteLine($line + $tab + $fgPid + $tab + (ToB64 $name) + $tab + (ToB64 $sb.ToString()))',
  '  [Console]::Out.Flush()',
  '}',
].join('\r\n');

/** one answer line of the PowerShell script → its request id and what it read (null: not an answer) */
export function parsePsLine(line: string): { id: number; info: ForegroundInfo } | null {
  const parts = line.replace(/\r$/, '').split('\t');
  if (parts.length !== 4) return null;
  const id = Number.parseInt(parts[0]!, 10);
  if (!Number.isInteger(id)) return null;
  const b64 = (s: string): string => (s ? Buffer.from(s, 'base64').toString('utf8') : '');
  const info: ForegroundInfo = {};
  const pid = Number.parseInt(parts[1]!, 10);
  // no window in front (the desktop's lock screen, a secure desktop): pid 0, the "Idle" process
  if (!Number.isInteger(pid) || pid <= 0) return { id, info };
  info.pid = pid;
  const app = b64(parts[2]!).trim();
  if (app) info.app = app;
  const title = b64(parts[3]!).trim();
  if (title) info.title = title;
  return { id, info };
}
