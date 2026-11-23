/**
 * Child processes on every platform. macOS and Linux run a command as it is, in a process group of its own
 * (`detached`) so its whole tree can be signalled. Windows has no process groups and no signals but a kill, and the
 * CLIs npm installs are `.cmd` shims that `spawn` won't start without a shell (Node refuses batch files since
 * CVE-2024-27980). So on Windows a tree is killed with taskkill, a cmd-shim runs its own target directly, and any
 * other batch file goes through cmd.exe with each argument escaped for it (cross-spawn's rules). No console windows.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

type Platform = NodeJS.Platform;
type EnvLayer = Record<string, string | undefined> | undefined;

/* ---------- env ---------- */

/** The env key that holds the PATH: `PATH`, or on Windows whichever casing the env has (`Path`, usually). */
export function pathKey(env: NodeJS.ProcessEnv, platform: Platform = process.platform): string {
  if (platform !== 'win32') return 'PATH';
  return Object.keys(env).reverse().find((k) => k.toUpperCase() === 'PATH') ?? 'Path';
}

/**
 * Layers of env merged, later ones winning. Windows env names are case-insensitive but a copied object's keys are
 * not, so a plain spread could hand the child both `Path` and `PATH` (and it reads either): there a later key drops
 * every other casing of itself.
 */
export function mergeEnv(layers: EnvLayer[], platform: Platform = process.platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  if (platform !== 'win32') {
    for (const l of layers) Object.assign(out, l);
    return out;
  }
  const names = new Map<string, string>();
  for (const l of layers) {
    for (const [k, v] of Object.entries(l ?? {})) {
      const prev = names.get(k.toUpperCase());
      if (prev !== undefined && prev !== k) delete out[prev];
      names.set(k.toUpperCase(), k);
      out[k] = v;
    }
  }
  return out;
}

/** A copy of `env` with its PATH set to `path` (under the key it already has, on Windows). */
/** `env` without `names` (case-insensitively on Windows): what a child must not inherit. */
export function withoutEnv(env: NodeJS.ProcessEnv, names: Iterable<string>, platform: Platform = process.platform): NodeJS.ProcessEnv {
  const drop = new Set([...names].map((n) => (platform === 'win32' ? n.toUpperCase() : n)));
  if (!drop.size) return { ...env };
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!drop.has(platform === 'win32' ? k.toUpperCase() : k)) out[k] = v;
  return out;
}

export function withPath(env: NodeJS.ProcessEnv, path: string, platform: Platform = process.platform): NodeJS.ProcessEnv {
  if (platform !== 'win32') return { ...env, PATH: path };
  return mergeEnv([env, { [pathKey(env, platform)]: path }], platform);
}

/** the variables a login home sets: the process's home and the XDG folders under it */
export function loginHomeEnv(home: string): Record<string, string> {
  const j = (...parts: string[]) => (process.platform === 'win32' ? win32 : posix).join(home, ...parts);
  return { HOME: home, XDG_CONFIG_HOME: j('.config'), XDG_DATA_HOME: j('.local', 'share'), XDG_STATE_HOME: j('.local', 'state'), XDG_CACHE_HOME: j('.cache') };
}

/**
 * Put an agent process under a login home (`LoginEnv.loginHome`): `HOME` and the XDG folders there, and every agent's
 * config-folder variable (`profileVars`: protocol `PROFILE_HOME_ENV`'s values) cleared so the agent's default under
 * that home applies, unless `keepProfileVar` (a profile of the agent's: its folder is the person's own).
 */
export function applyLoginHome(env: NodeJS.ProcessEnv, home: string, profileVars: Iterable<string>, keepProfileVar = false, platform: Platform = process.platform): NodeJS.ProcessEnv {
  const out = withoutEnv(env, keepProfileVar ? [] : profileVars, platform);
  Object.assign(out, loginHomeEnv(home));
  return out;
}

/** An env value by name, case-insensitively on Windows. */
function envGet(env: NodeJS.ProcessEnv, name: string, platform: Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/* ---------- finding executables ---------- */

/** What Windows can start without a host program; `PATHEXT` decides their order. */
const RUNNABLE = ['.com', '.exe', '.bat', '.cmd'];

/**
 * The file names `name` may have on disk: itself outside Windows. On Windows `name` plus each runnable `PATHEXT`
 * extension in `PATHEXT`'s order, or `name` alone when it already ends in one (an extensionless file next to a
 * `.cmd`, like the Unix script npm installs beside its shim, can't be run there).
 */
export function executableNames(name: string, platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform !== 'win32') return [name];
  const exts = (envGet(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => RUNNABLE.includes(e));
  const order = [...new Set([...exts, ...RUNNABLE])];
  if (order.includes(win32.extname(name).toLowerCase())) return [name];
  return order.map((e) => `${name}${e}`);
}

/** `name` contains a directory part (`./x`, `/usr/bin/x`, `C:\x`), so PATH is not searched. */
export function hasDir(name: string, platform: Platform = process.platform): boolean {
  return platform === 'win32' ? win32.isAbsolute(name) || /[\\/]/.test(name) : posix.isAbsolute(name) || name.includes('/');
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Synchronous `which` against `pathValue` (a PATH string): the first runnable file, or undefined. */
export function whichSync(name: string, pathValue: string, platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!name) return undefined;
  const names = executableNames(name, platform, env);
  const path = platform === 'win32' ? win32 : posix;
  if (hasDir(name, platform)) return names.find(isFile);
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const candidate = path.join(dir, n);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/* ---------- Windows batch files ---------- */

/**
 * A cmd-shim (the `.cmd` npm, pnpm and Yarn write for a package's bin): the program it runs, relative to the shim's
 * folder, and whether node runs it. Undefined for any other batch file, and for shims that pass node flags of their
 * own or run something other than node or an `.exe`.
 */
export function parseCmdShim(text: string): { target: string; node: boolean } | undefined {
  const nodeProg = /SET\s+"_prog=node"/i.test(text);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /"%~?dp0%?\\?([^"%]+)"\s+%\*$/.exec(line);
    if (!m) continue;
    // what runs it: after the last `& ` (the current shim's `endLocal & goto … & "%_prog%" …`), without `@`
    const prefix = line.slice(0, m.index).replace(/^.*&\s/, '').replace(/^@/, '').trim();
    const target = m[1]!;
    if (!prefix) return /\.(exe|com)$/i.test(target) ? { target, node: false } : undefined;
    if (prefix === '"%_prog%"') return nodeProg ? { target, node: true } : undefined;
    if (/^(node|"%~?dp0%?\\node\.exe")$/i.test(prefix)) return { target, node: true };
    return undefined;
  }
  return undefined;
}

/** A cmd-shim's own target on disk: an `.exe`, or a script and the node to run it with. Undefined otherwise. */
export function cmdShimTarget(file: string): { exe: string } | { script: string; node: string } | undefined {
  let text: string;
  try {
    if (statSync(file).size > 64 * 1024) return undefined;
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const shim = parseCmdShim(text);
  if (!shim) return undefined;
  const dir = win32.dirname(file);
  const target = win32.resolve(dir, shim.target);
  if (!existsSync(target)) return undefined;
  if (!shim.node) return { exe: target };
  const local = win32.join(dir, 'node.exe');
  return { script: target, node: existsSync(local) ? local : 'node' };
}

/**
 * A path a program can start directly, for env vars other programs spawn without a shell (`CLAUDE_CODE_EXECUTABLE`):
 * the path itself, except a Windows `.cmd`/`.bat`, which becomes its shim's target (an `.exe`, or the `.js` the
 * Claude Agent SDK runs with node), or undefined when it has none.
 */
export function directExecutable(file: string, platform: Platform = process.platform): string | undefined {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return file;
  const t = cmdShimTarget(file);
  if (!t) return undefined;
  return 'exe' in t ? t.exe : t.script;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** cmd.exe-escape the command itself (no quotes: every metacharacter, spaces included, gets a caret). */
export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, '^$1');
}

/**
 * cmd.exe-escape one argument for `cmd /d /s /c "…"` (cross-spawn's algorithm, after qntm.org/cmd): quoted for the
 * program's own command-line parser, then every metacharacter caret-escaped, twice for a node_modules/.bin shim
 * (it passes `%*` through cmd once more).
 */
export function escapeCmdArg(arg: string, doubleEscape = false): string {
  let a = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  a = a.replace(/(?=(\\+?)?)\1$/, '$1$1');
  a = `"${a}"`.replace(CMD_META, '^$1');
  return doubleEscape ? a.replace(CMD_META, '^$1') : a;
}

/** Windows' cmd.exe (`ComSpec`). */
export function comspec(env: NodeJS.ProcessEnv = process.env, platform: Platform = 'win32'): string {
  return envGet(env, 'ComSpec', platform) || win32.join(envGet(env, 'SystemRoot', platform) || 'C:\\Windows', 'System32', 'cmd.exe');
}

/** Run `command args…` through cmd.exe with every part escaped (for batch files and cmd's own commands). */
export function cmdLaunch(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Launch {
  const double = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(command);
  const line = [escapeCmdCommand(win32.normalize(command)), ...args.map((a) => escapeCmdArg(a, double))].join(' ');
  return { command: comspec(env), args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
}

/** One word of a command line typed into cmd.exe: bare when plain, else double-quoted (an inner `"` doubled). */
function cmdWord(s: string): string {
  return /^[\w\-.\\/:=@+,]+$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`;
}

/**
 * A command line for a cmd.exe console (a sign-in run in a terminal window on Windows): `set "K=V" && "C:\…" args`.
 * `%` is left as is: whoever writes it into a batch file escapes it.
 */
export function cmdLine(cmd: { command: string; args: string[]; env?: Record<string, string> }): string {
  const sets = Object.entries(cmd.env ?? {}).map(([k, v]) => `set "${k}=${v}" && `).join('');
  return `${sets}${[cmd.command, ...cmd.args].map(cmdWord).join(' ')}`;
}

/* ---------- spawning ---------- */

export interface Launch {
  command: string;
  args: string[];
  /** Windows: pass `args` as written (cmd.exe's own quoting) */
  windowsVerbatimArguments?: boolean;
}

/**
 * How to start `command` (a resolved path, or a bare name) with `args`: as is outside Windows. On Windows a cmd-shim
 * runs its own target, a `.js` runs through node, and any other `.cmd`/`.bat` through cmd.exe.
 */
export function launchSpec(command: string, args: string[], platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Launch {
  if (platform !== 'win32') return { command, args };
  const ext = win32.extname(command).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    const t = cmdShimTarget(command);
    if (!t) return cmdLaunch(command, args, env);
    return 'exe' in t ? { command: t.exe, args } : { command: t.node, args: [t.script, ...args] };
  }
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') return { command: 'node', args: [command, ...args] };
  return { command, args };
}

/** `spawn` through `launchSpec`, with no console window on Windows. */
export function spawnCommand(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  const l = launchSpec(command, args, process.platform, options.env ?? process.env);
  return spawn(l.command, l.args, { windowsHide: true, ...options, ...(l.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
}

/**
 * Whether a child gets a process group of its own (`detached`) so `killTree` reaches what it starts: yes on macOS and
 * Linux. Not on Windows, where `detached` means a console of its own and nothing for the tree (taskkill finds it).
 */
export function processGroup(platform: Platform = process.platform): boolean {
  return platform !== 'win32';
}

/** Windows: the taskkill that ends `pid` and everything under it. */
export function taskkillCommand(pid: number, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  return {
    command: win32.join(envGet(env, 'SystemRoot', 'win32') || 'C:\\Windows', 'System32', 'taskkill.exe'),
    args: ['/pid', String(pid), '/T', '/F'],
  };
}

/**
 * Stop a child and everything it started. macOS/Linux: `signal` to its process group (it must have been spawned with
 * `detached: processGroup()`), else to the child alone. Windows: `taskkill /T /F` (no signals there: every kill is
 * final), else the child alone.
 */
export function killTree(child: ChildProcess | undefined, signal: NodeJS.Signals = 'SIGTERM', platform: Platform = process.platform): void {
  const pid = child?.pid;
  if (!child || pid === undefined) return;
  const own = () => {
    try {
      child.kill(platform === 'win32' ? undefined : signal);
    } catch {
      /* already gone */
    }
  };
  if (platform === 'win32') {
    try {
      const t = taskkillCommand(pid);
      const k = spawn(t.command, t.args, { stdio: 'ignore', windowsHide: true });
      k.on('error', own);
      k.on('exit', (code) => { if (code !== 0) own(); });
    } catch {
      own();
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    own();
  }
}

/**
 * Signal a process group whose leader may already be gone (what an agent's adapter left behind). macOS/Linux only:
 * on Windows a dead parent's children can't be found, so this does nothing there.
 */
export function killGroup(pid: number | undefined, signal: NodeJS.Signals, platform: Platform = process.platform): void {
  if (pid === undefined || platform === 'win32') return;
  try {
    process.kill(-pid, signal);
  } catch {
    /* group already gone */
  }
}
