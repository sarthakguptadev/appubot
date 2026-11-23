/** Reading the window in front on Linux (xprop's output) and Windows (the PowerShell reader's answers). */
import { describe, expect, it } from 'vitest';
import { PS_FOREGROUND_SCRIPT, parseActiveWindowId, parsePsLine, parseXpropWindow } from './foreground';

describe('xprop', () => {
  it('finds the active window', () => {
    expect(parseActiveWindowId('_NET_ACTIVE_WINDOW: window id # 0x3a00007\n')).toBe('0x3a00007');
    expect(parseActiveWindowId('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x4C00003\n')).toBe('0x4C00003');
    expect(parseActiveWindowId('_NET_ACTIVE_WINDOW: window id # 0x0\n')).toBeNull();
    expect(parseActiveWindowId('_NET_ACTIVE_WINDOW:  not found.\n')).toBeNull();
  });

  it('reads the app, title and pid of a window', () => {
    const out = [
      'WM_CLASS = "gnome-terminal-server", "Gnome-terminal"',
      '_NET_WM_NAME = "sarthak@box: ~/Invoices"',
      'WM_NAME = "old name"',
      '_NET_WM_PID = 4242',
      '',
    ].join('\n');
    expect(parseXpropWindow(out)).toEqual({ app: 'Gnome-terminal', title: 'sarthak@box: ~/Invoices', pid: 4242 });
  });

  it('copes with types shown, escapes, octal bytes and missing properties', () => {
    const out = [
      'WM_CLASS(STRING) = "Navigator", "firefox"',
      '_NET_WM_NAME(UTF8_STRING) = "Say \\"hi\\" \\\\ caf\\303\\251 — Mozilla Firefox"',
      '_NET_WM_PID:  not found.',
    ].join('\n');
    expect(parseXpropWindow(out)).toEqual({ app: 'firefox', title: 'Say "hi" \\ café — Mozilla Firefox' });
  });

  it('falls back to WM_NAME and the class instance', () => {
    expect(parseXpropWindow('WM_CLASS = "xterm"\nWM_NAME = "xterm"\n_NET_WM_NAME:  not found.\n')).toEqual({ app: 'xterm', title: 'xterm' });
    expect(parseXpropWindow('')).toEqual({});
  });
});

describe('the PowerShell reader', () => {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

  it('decodes an answer', () => {
    expect(parsePsLine(`7\t1234\t${b64('Google Chrome')}\t${b64('Inbox (3) — Gmail – Google Chrome')}\r`)).toEqual({
      id: 7, info: { pid: 1234, app: 'Google Chrome', title: 'Inbox (3) — Gmail – Google Chrome' },
    });
    expect(parsePsLine(`8\t99\t${b64('Notepad')}\t`)).toEqual({ id: 8, info: { pid: 99, app: 'Notepad' } });
  });

  it('reads nothing when no window is in front', () => {
    expect(parsePsLine(`9\t0\t${b64('Idle')}\t`)).toEqual({ id: 9, info: {} });
  });

  it('ignores lines that aren\'t answers', () => {
    expect(parsePsLine('ready')).toBeNull();
    expect(parsePsLine('x\t1\t\t')).toBeNull();
    expect(parsePsLine('')).toBeNull();
  });

  it('is a script that answers in that shape', () => {
    expect(PS_FOREGROUND_SCRIPT).toContain('GetForegroundWindow');
    expect(PS_FOREGROUND_SCRIPT).toContain("[Console]::Out.WriteLine('ready')");
    expect(PS_FOREGROUND_SCRIPT).toContain('$line + $tab + $fgPid + $tab + (ToB64 $name) + $tab + (ToB64 $sb.ToString())');
    // the here-string's closing "@ must start its line
    expect(PS_FOREGROUND_SCRIPT.split('\r\n')).toContain('"@');
    // $pid is read-only in PowerShell
    expect(PS_FOREGROUND_SCRIPT).not.toMatch(/\$pid\b/i);
  });
});
