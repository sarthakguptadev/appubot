/**
 * Login-shell PATH resolution. GUI apps on macOS start with a minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), so tools installed via Homebrew/npm/bun are
 * invisible unless we ask the user's login shell for its PATH. Linux desktop
 * launchers are often the same; Windows apps get the user's full PATH (no
 * login shell to ask), with PATHEXT deciding what a bare name resolves to.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, constants, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, posix, win32 } from 'node:path';
import { executableNames, hasDir, killTree, processGroup } from './spawn';

const MARKER = '__PATH__';
let loginPathPromise: Promise<string[]> | undefined;
let extraPathEntries: string[] = [];

/** Extra PATH entries configured by the runtime (RuntimeOptions.extraPath). */
export function setExtraPath(entries: string[] | undefined): void {
  extraPathEntries = entries ? [...entries] : [];
}

/** Where CLIs are usually installed on `platform`, after the login shell's and the process's own PATH. */
export function commonDirs(platform: NodeJS.Platform = process.platform, home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'win32') {
    const dirs: (string | undefined)[] = [
      env.APPDATA && win32.join(env.APPDATA, 'npm'),
      env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'pnpm'),
      env.ProgramFiles && win32.join(env.ProgramFiles, 'nodejs'),
      win32.join(home, '.local', 'bin'),
      win32.join(home, '.bun', 'bin'),
      win32.join(home, '.cargo', 'bin'),
      win32.join(home, 'scoop', 'shims'),
      env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
    ];
    return dirs.filter((d): d is string => !!d);
  }
  if (platform !== 'darwin') {
    return [
      posix.join(home, '.local/bin'),
      posix.join(home, '.npm-global/bin'),
      posix.join(home, '.bun/bin'),
      posix.join(home, '.cargo/bin'),
      '/home/linuxbrew/.linuxbrew/bin',
      posix.join(home, '.linuxbrew/bin'),
      '/usr/local/bin',
      '/snap/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ];
  }
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    posix.join(home, '.local/bin'),
    posix.join(home, '.npm-global/bin'),
    posix.join(home, '.bun/bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
}

/** Runs `$SHELL -ilc 'echo __PATH__$PATH'` once (3s timeout) and caches the result. */
export function getLoginShellPath(): Promise<string[]> {
  if (!loginPathPromise) loginPathPromise = probeLoginShellPath();
  return loginPathPromise;
}

/** The user's login shell: `$SHELL`, else macOS's zsh, else bash or sh. */
function loginShell(): string {
  if (process.env.SHELL) return process.env.SHELL;
  if (process.platform === 'darwin') return '/bin/zsh';
  return existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

function probeLoginShellPath(): Promise<string[]> {
  if (process.platform === 'win32') return Promise.resolve([]);
  const shell = loginShell();
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (entries: string[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(entries);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ['-ilc', `echo ${MARKER}$PATH`], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, TERM: 'dumb' },
        detached: processGroup(),
      });
    } catch {
      resolve([]);
      return;
    }
    const timer = setTimeout(() => {
      killTree(child, 'SIGKILL');
      finish(parse(out));
    }, 3000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      out += d;
    });
    child.on('error', () => finish([]));
    child.on('close', () => finish(parse(out)));
  });
}

function parse(out: string): string[] {
  const idx = out.lastIndexOf(MARKER);
  if (idx < 0) return [];
  const line = out.slice(idx + MARKER.length).split('\n')[0]?.trim() ?? '';
  return line.split(':').filter(Boolean);
}

function dedupe(entries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const e of entries) {
    // Windows paths are case-insensitive
    const key = process.platform === 'win32' ? e.toLowerCase() : e;
    if (!e || seen.has(key)) continue;
    seen.add(key);
    result.push(e);
  }
  return result;
}

/** Full PATH entries: login shell PATH + process PATH + extraPath + common install dirs. */
export async function getPathEntries(): Promise<string[]> {
  const login = await getLoginShellPath();
  const proc = (process.env.PATH ?? '').split(delimiter);
  return dedupe([...extraPathEntries, ...login, ...proc, ...commonDirs()]);
}

export async function getPathString(): Promise<string> {
  return (await getPathEntries()).join(delimiter);
}

async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    if (!s.isFile()) return false;
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `which`-style resolution against the merged login PATH (on Windows: `claude` finds `claude.exe` or `claude.cmd`, by PATHEXT). */
export async function resolveExecutable(name: string): Promise<string | undefined> {
  if (!name) return undefined;
  const names = executableNames(name);
  if (hasDir(name)) {
    for (const n of names) if (await isExecutableFile(n)) return n;
    return undefined;
  }
  for (const dir of await getPathEntries()) {
    for (const n of names) {
      const candidate = join(dir, n);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}
