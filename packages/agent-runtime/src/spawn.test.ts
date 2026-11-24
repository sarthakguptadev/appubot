import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  cmdLaunch, cmdLine, directExecutable, escapeCmdArg, executableNames, hasDir, killTree, launchSpec, mergeEnv, parseCmdShim,
  pathKey, processGroup, taskkillCommand, whichSync, withPath, withoutEnv,
} from './spawn';
import { commonDirs } from './path';
import { ghConfigDir } from './login';
import { resolveAdapterBin } from './providers';
import { terminalLaunch } from './terminals';

const tmp = mkdtempSync(join(tmpdir(), 'appubot-spawn-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('env merging', () => {
  it('drops the variables an agent must not inherit (a cloud computer’s tokens), case-insensitively on Windows', () => {
    expect(withoutEnv({ APPUBOT_CONTROL_TOKEN: 'x', APPUBOT_BACKEND_TOKEN: 'y', PATH: '/a' }, ['APPUBOT_CONTROL_TOKEN', 'APPUBOT_BACKEND_TOKEN'], 'linux')).toEqual({ PATH: '/a' });
    expect(withoutEnv({ appubot_control_token: 'x', PATH: '/a' }, ['APPUBOT_CONTROL_TOKEN'], 'linux')).toEqual({ appubot_control_token: 'x', PATH: '/a' });
    expect(withoutEnv({ appubot_control_token: 'x', Path: 'C:\\a' }, ['APPUBOT_CONTROL_TOKEN'], 'win32')).toEqual({ Path: 'C:\\a' });
    expect(withoutEnv({ A: '1' }, [], 'linux')).toEqual({ A: '1' });
  });
  it('keeps POSIX env as a plain spread', () => {
    expect(withPath({ PATH: '/a', X: '1' }, '/b', 'darwin')).toEqual({ PATH: '/b', X: '1' });
    expect(mergeEnv([{ A: '1', path: 'x' }, undefined, { A: '2' }], 'linux')).toEqual({ A: '2', path: 'x' });
    expect(pathKey({ Path: 'x' }, 'linux')).toBe('PATH');
  });
  it('on Windows sets the PATH under the casing the env has and drops the others', () => {
    expect(pathKey({ Path: 'C:\\a', X: '1' }, 'win32')).toBe('Path');
    expect(pathKey({ X: '1' }, 'win32')).toBe('Path');
    expect(withPath({ Path: 'C:\\a', X: '1' }, 'C:\\b', 'win32')).toEqual({ Path: 'C:\\b', X: '1' });
    expect(mergeEnv([{ Path: 'C:\\a', SystemRoot: 'C:\\Windows' }, { PATH: 'C:\\b', SYSTEMROOT: 'D:\\W' }], 'win32')).toEqual({ PATH: 'C:\\b', SYSTEMROOT: 'D:\\W' });
  });
});

describe('executable names', () => {
  it('is the name itself outside Windows', () => {
    expect(executableNames('claude', 'darwin')).toEqual(['claude']);
  });
  it('follows PATHEXT on Windows, runnable extensions only', () => {
    expect(executableNames('claude', 'win32', { PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS' })).toEqual(['claude.com', 'claude.exe', 'claude.bat', 'claude.cmd']);
    expect(executableNames('npx', 'win32', { PathExt: '.CMD;.EXE' })).toEqual(['npx.cmd', 'npx.exe', 'npx.com', 'npx.bat']);
    expect(executableNames('npx', 'win32', {})).toEqual(['npx.com', 'npx.exe', 'npx.bat', 'npx.cmd']);
    expect(executableNames('C:\\x\\codex.CMD', 'win32', {})).toEqual(['C:\\x\\codex.CMD']);
  });
  it('knows a name with a folder in it', () => {
    expect(hasDir('claude', 'darwin')).toBe(false);
    expect(hasDir('./bin/x', 'linux')).toBe(true);
    expect(hasDir('C:\\x\\y.exe', 'win32')).toBe(true);
    expect(hasDir('bin\\y', 'win32')).toBe(true);
    expect(hasDir('y', 'win32')).toBe(false);
  });
  it('finds a file on a PATH string', () => {
    const a = join(tmp, 'a');
    const b = join(tmp, 'b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    // this machine's own paths and PATH syntax (a Windows path has a drive letter's colon in it)
    if (process.platform === 'win32') {
      writeFileSync(join(b, 'tool.cmd'), '');
      expect(whichSync('tool', `${a};${b}`, 'win32', { PATHEXT: '.EXE;.CMD' })).toBe(join(b, 'tool.cmd'));
      expect(whichSync('nope', `${a};${b}`, 'win32', { PATHEXT: '.EXE;.CMD' })).toBeUndefined();
    } else {
      writeFileSync(join(b, 'tool'), '');
      expect(whichSync('tool', `${a}:${b}`, 'darwin')).toBe(join(b, 'tool'));
      expect(whichSync('nope', `${a}:${b}`, 'darwin')).toBeUndefined();
    }
  });
});

describe('cmd-shims', () => {
  it("reads npm's current shim (node script)", () => {
    const text = [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
    ].join('\r\n');
    expect(parseCmdShim(text)).toEqual({ target: 'node_modules\\@anthropic-ai\\claude-code\\cli.js', node: true });
  });
  it('reads a shim for an .exe', () => {
    const text = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\x\\bin\\x.exe"   %*\r\n';
    expect(parseCmdShim(text)).toEqual({ target: 'node_modules\\x\\bin\\x.exe', node: false });
  });
  it("reads older npm's and pnpm's shims", () => {
    const old = '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n) ELSE (\r\n  @SETLOCAL\r\n  node  "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n)';
    expect(parseCmdShim(old)).toEqual({ target: 'node_modules\\npm\\bin\\npm-cli.js', node: true });
    const pnpm = '@SETLOCAL\r\n@IF NOT DEFINED NODE_PATH (\r\n  @SET "NODE_PATH=C:\\x"\r\n)\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\@openai\\codex\\bin\\codex.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\..\\@openai\\codex\\bin\\codex.js" %*\r\n)';
    expect(parseCmdShim(pnpm)).toEqual({ target: '..\\@openai\\codex\\bin\\codex.js', node: true });
  });
  it('reads the shim AppuBot writes for an agent it installed: the .exe by its full path, spaces and a doubled % included', () => {
    expect(parseCmdShim('@echo off\r\n"C:\\Users\\RISEIM~1\\AppData\\Roaming\\AppuBot\\agents\\codex\\0.172.0-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe" %*\r\n'))
      .toEqual({ target: 'C:\\Users\\RISEIM~1\\AppData\\Roaming\\AppuBot\\agents\\codex\\0.172.0-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe', node: false });
    expect(parseCmdShim('@echo off\r\n"C:\\Users\\Ana Lima\\100%%\\copilot.exe" %*\r\n')).toEqual({ target: 'C:\\Users\\Ana Lima\\100%\\copilot.exe', node: false });
    expect(parseCmdShim('@echo off\r\n"C:\\tools\\run.js" %*\r\n')).toBeUndefined();
  });
  it('refuses other batch files and shims it cannot run directly', () => {
    expect(parseCmdShim('@echo off\r\n"%NODE_EXE%" "%NPM_CLI_JS%" %*')).toBeUndefined();
    const sh = 'IF EXIST "%dp0%\\/bin/sh.exe" (\r\n  SET "_prog=%dp0%\\/bin/sh.exe"\r\n) ELSE (\r\n  SET "_prog=/bin/sh"\r\n)\r\nendLocal & "%_prog%"  "%dp0%\\x\\run.sh" %*';
    expect(parseCmdShim(sh)).toBeUndefined();
    expect(parseCmdShim('SET "_prog=node"\r\nendLocal & "%_prog%" --no-warnings "%dp0%\\x.js" %*')).toBeUndefined();
    expect(parseCmdShim('"%dp0%\\x\\script.sh" %*')).toBeUndefined();
  });
});

describe('cmd.exe quoting', () => {
  it('quotes and caret-escapes each argument (cross-spawn)', () => {
    expect(escapeCmdArg('plain')).toBe('^"plain^"');
    expect(escapeCmdArg('a b&c')).toBe('^"a^ b^&c^"');
    expect(escapeCmdArg('say "hi"')).toBe('^"say^ \\^"hi\\^"^"');
    expect(escapeCmdArg('C:\\dir\\')).toBe('^"C:\\dir\\\\^"');
    expect(escapeCmdArg('100%')).toBe('^"100^%^"');
    expect(escapeCmdArg('a|b', true)).toBe('^^^"a^^^|b^^^"');
  });
  it('runs a batch file through cmd.exe with verbatim arguments', () => {
    const l = cmdLaunch('C:\\Program Files\\nodejs\\npx.cmd', ['-y', '@scope/pkg@1.0.0'], { ComSpec: 'C:\\Windows\\system32\\cmd.exe' });
    expect(l).toEqual({
      command: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\Program^ Files\\nodejs\\npx.cmd ^"-y^" ^"@scope/pkg@1.0.0^""'],
      windowsVerbatimArguments: true,
    });
    expect(cmdLaunch('x.bat', [], { SystemRoot: 'D:\\Win' }).command).toBe('D:\\Win\\System32\\cmd.exe');
  });
  it('writes a line for a cmd.exe console', () => {
    expect(cmdLine({ command: 'C:\\Program Files\\AppuBot\\AppuBot.exe', args: ['C:\\a b\\index.js', '--cli', 'auth', 'login'], env: { ELECTRON_RUN_AS_NODE: '1' } }))
      .toBe('set "ELECTRON_RUN_AS_NODE=1" && "C:\\Program Files\\AppuBot\\AppuBot.exe" "C:\\a b\\index.js" --cli auth login');
    expect(cmdLine({ command: 'C:\\x\\claude.cmd', args: ['say "hi"'] })).toBe('C:\\x\\claude.cmd "say ""hi"""');
  });
});

describe('launching', () => {
  it('runs commands as they are outside Windows', () => {
    expect(launchSpec('/usr/local/bin/npx', ['-y', 'x'], 'darwin')).toEqual({ command: '/usr/local/bin/npx', args: ['-y', 'x'] });
    expect(launchSpec('/x/cli.js', [], 'linux')).toEqual({ command: '/x/cli.js', args: [] });
    expect(directExecutable('/usr/local/bin/claude', 'darwin')).toBe('/usr/local/bin/claude');
  });
  it('on Windows runs an .exe as is, a .js with node, an unknown batch file through cmd.exe', () => {
    expect(launchSpec('C:\\x\\claude.exe', ['a b'], 'win32')).toEqual({ command: 'C:\\x\\claude.exe', args: ['a b'] });
    expect(launchSpec('C:\\x\\cli.js', ['--version'], 'win32')).toEqual({ command: 'node', args: ['C:\\x\\cli.js', '--version'] });
    expect(launchSpec('C:\\none\\npx.cmd', ['-y'], 'win32', { ComSpec: 'cmd.exe' })).toMatchObject({ command: 'cmd.exe', windowsVerbatimArguments: true });
    expect(directExecutable('C:\\none\\claude.cmd', 'win32')).toBeUndefined();
  });
  it('runs ACP terminal command lines through the platform shell', () => {
    expect(terminalLaunch('npm test', [], {}, 'darwin').args).toEqual(['-lc', 'npm test']);
    expect(terminalLaunch('git', ['status'], {}, 'linux')).toEqual({ command: 'git', args: ['status'] });
    expect(terminalLaunch('npm test', [], { ComSpec: 'cmd.exe' }, 'win32')).toEqual({ command: 'cmd.exe', args: ['/d', '/s', '/c', '"npm test"'], windowsVerbatimArguments: true });
    // not a file on PATH: cmd's own command
    expect(terminalLaunch('dir', ['/b'], { ComSpec: 'cmd.exe', Path: '' }, 'win32')).toEqual({ command: 'cmd.exe', args: ['/d', '/s', '/c', '"dir ^"/b^""'], windowsVerbatimArguments: true });
  });
});

describe('killing a tree', () => {
  it('uses process groups outside Windows and taskkill on it', () => {
    expect(processGroup('darwin')).toBe(true);
    expect(processGroup('linux')).toBe(true);
    expect(processGroup('win32')).toBe(false);
    expect(taskkillCommand(42, { SystemRoot: 'C:\\Windows' })).toEqual({ command: 'C:\\Windows\\System32\\taskkill.exe', args: ['/pid', '42', '/T', '/F'] });
    expect(taskkillCommand(7, {}).command).toBe('C:\\Windows\\System32\\taskkill.exe');
  });
  it.skipIf(process.platform === 'win32')('kills a child and what it started', async () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 30 & sleep 30; wait'], { detached: processGroup(), stdio: 'ignore' });
    const exited = new Promise<NodeJS.Signals | null>((r) => child.on('exit', (_c, s) => r(s)));
    await new Promise((r) => setTimeout(r, 100));
    killTree(child, 'SIGTERM');
    expect(await exited).toBe('SIGTERM');
    // the group is gone: signalling it again fails (its other members may take a moment to be reaped)
    await vi.waitFor(() => expect(() => process.kill(-child.pid!, 0)).toThrow(), { timeout: 3000, interval: 50 });
  });
});

describe('platform paths', () => {
  it("keeps macOS's install folders and adds Linux and Windows ones", () => {
    expect(commonDirs('darwin', '/Users/me')).toEqual([
      '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/Users/me/.local/bin', '/Users/me/.npm-global/bin', '/Users/me/.bun/bin',
      '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    ]);
    const linux = commonDirs('linux', '/home/me');
    expect(linux).toEqual(expect.arrayContaining(['/home/me/.local/bin', '/home/me/.cargo/bin', '/home/linuxbrew/.linuxbrew/bin', '/snap/bin', '/usr/bin']));
    expect(linux).not.toContain('/opt/homebrew/bin');
    expect(commonDirs('win32', 'C:\\Users\\John Smith', { APPDATA: 'C:\\Users\\John Smith\\AppData\\Roaming' })).toEqual([
      'C:\\Users\\John Smith\\AppData\\Roaming\\npm', 'C:\\Users\\John Smith\\.local\\bin', 'C:\\Users\\John Smith\\.bun\\bin',
      'C:\\Users\\John Smith\\.cargo\\bin', 'C:\\Users\\John Smith\\scoop\\shims',
    ]);
  });
  it("finds the GitHub CLI's config folder the way gh does", () => {
    expect(ghConfigDir({ GH_CONFIG_DIR: '/x' }, 'darwin')).toBe('/x');
    expect(ghConfigDir({ HOME: '/Users/me' }, 'darwin')).toBe(join('/Users/me', '.config', 'gh'));
    expect(ghConfigDir({ XDG_CONFIG_HOME: '/cfg', APPDATA: 'C:\\A' }, 'win32')).toBe(join('/cfg', 'gh'));
    expect(ghConfigDir({ APPDATA: 'C:\\A' }, 'win32')).toBe(join('C:\\A', 'GitHub CLI'));
  });
  // a packaged adapter's own dependencies are only inside app.asar: it must not be started from the unpacked copy
  it('starts the bundled adapters where they are installed', () => {
    expect(resolveAdapterBin('@agentclientprotocol/claude-agent-acp')?.bin).toMatch(/claude-agent-acp[\\/]dist[\\/]index\.js$/);
    expect(resolveAdapterBin('@agentclientprotocol/codex-acp')?.bin).toMatch(/codex-acp[\\/]/);
  });
});
