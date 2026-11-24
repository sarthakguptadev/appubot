/**
 * An agent's own login run on this computer for a device that isn't at it: a phone, or the desktop app on another
 * computer (an AppuBot Cloud computer's agents signed in from the Mac or phone). Nobody needs
 * this computer's screen: what the login shows comes back as `DeviceLogin` (`provider.login` events follow it).
 *
 * Three kinds of login:
 * - `cli`: the agent's CLI login as a child process. What it prints is read: a link to open on any device, a one-time
 *   code to enter there (Codex's `codex login --device-auth`, Copilot's `--device-code`), or a prompt to paste a code
 *   back into (`providers.deviceLogin.code`, written to its stdin). Claude Code runs its full `claude auth login`,
 *   which prints a link whose page shows a code to paste, and also opens a second link through `BROWSER` that returns
 *   to its own listener here (with `BROWSER` set it needs no terminal: macOS's `script` refuses Node's pipes, which
 *   are sockets there, so a pseudo-terminal only works on Linux).
 * - `token`: Claude Code's `claude setup-token` (methodId `setup-token`), which saves nothing itself and prints a
 *   long-lived token, kept as the `claude-token` key login (`ProvidersService.setKeys`).
 * - `agent`: an ACP agent's own login (`authenticate`: Google Antigravity, Gemini…), through `runtime.login` with its
 *   sign-in page handed here instead of opened in this computer's browser.
 *
 * Every page a login opens is caught, never shown on this computer: a CLI's `BROWSER` is a script that writes the link
 * to a file of the run's (`APPUBOT_LOGIN_URLS`), an ACP agent's goes through the runtime's `onAuthUrl`. A link that
 * returns to a loopback port here (`authReturn.ts` `loopbackReturn`) becomes `DeviceLogin.relay`: the desktop app
 * catches that return on the same port of its own computer, a phone pastes the address its browser ended on, and
 * `providers.deviceLogin.finish` checks it and replays it into the agent's own listener, which finishes the sign-in.
 * One login at a time per agent, ended by `cancel`, a timeout or its end.
 *
 * Verified on a Mac with Codex 0.166 (link + code) and Claude Code 2.1.319 (`auth login` with `BROWSER` set and plain
 * pipes: the localhost link through `BROWSER`, listening on 127.0.0.1, plus the paste-a-code link and prompt printed).
 */
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeviceLogin } from '@appubot/protocol';
import { providerBase } from '@appubot/protocol';
import { spawnCommand } from '@appubot/agent-runtime';
import type { CoreCtx } from '../context';
import { errMsg, RpcError } from '../util';
import { checkReturn, deliverReturn, loopbackReturn, type LoopbackReturn } from './authReturn';

/** a login the user hasn't finished in this long is given up on (Codex's code lasts 15 min) */
export const DEVICE_LOGIN_TIMEOUT_MS = 20 * 60_000;
/** how often a run's caught links are read */
const URLS_POLL_MS = 300;
/** what the runner needs to run: the command, its args and env, whether it must see a terminal, and whether it prints a token instead of saving a login */
export interface DeviceLoginCommand { command: string; args: string[]; env: Record<string, string>; pty?: boolean; token?: boolean }

interface Run {
  login: DeviceLogin;
  kind: 'cli' | 'token' | 'agent';
  child: ChildProcess | null;
  output: string;
  timer: ReturnType<typeof setTimeout> | null;
  cancelled: boolean;
  scope: string;
  /** for this computer's own window: links aren't caught, and none becomes a relay (the agent's listener is right here) */
  here: boolean;
  /** where the sign-in comes back to on this computer, once a link that does was caught */
  relay?: LoopbackReturn;
  /** the file the run's `BROWSER` writes links to, and how much of it was read */
  urlsFile?: string;
  urlsRead: number;
  urlsTimer: ReturnType<typeof setInterval> | null;
}

/** the long-lived token `claude setup-token` prints at the end (never logged or sent: it goes straight to the key store) */
const CLAUDE_TOKEN_RE = /\bsk-ant-oat[A-Za-z0-9]*-[A-Za-z0-9_-]{20,}/;
export function readClaudeToken(raw: string): string | null {
  return raw.replace(ANSI, '').match(CLAUDE_TOKEN_RE)?.[0] ?? null;
}

/** colours and the like, and OSC sequences (terminal hyperlinks) whether they end in BEL or ESC \ */
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const URL_RE = /https?:\/\/[^\s'"<>)\]]+/;
/** a device code on a line of its own: XXXX-XXXXX, or after "code:" */
const CODE_RE = /(?:^|\s)([A-Z0-9]{4,8}-[A-Z0-9]{4,8})(?=\s|$)|code[:\s]+([A-Z0-9-]{6,20})(?=\s|$)/m;
const PASTE_RE = /^.*\b(paste|enter)\b.*\b(code|token)\b.*[>:]\s*$/im;
const EXPIRES_RE = /expires? in (\d+) (minute|min|second|sec|hour)s?/i;

/** The link, code, paste prompt and expiry a CLI's output shows so far. */
export function readLoginOutput(raw: string, startedAt: number): Pick<DeviceLogin, 'url' | 'code' | 'prompt' | 'expiresAt'> {
  const text = raw.replace(ANSI, '').replace(/\r/g, '\n');
  const out: Pick<DeviceLogin, 'url' | 'code' | 'prompt' | 'expiresAt'> = {};
  const url = text.match(URL_RE)?.[0]?.replace(/[.,;]+$/, '');
  if (url) out.url = url;
  const code = text.match(CODE_RE);
  const c = code?.[1] ?? code?.[2];
  if (c) out.code = c;
  const prompt = text.match(PASTE_RE)?.[0]?.trim();
  if (prompt) out.prompt = prompt;
  const exp = text.match(EXPIRES_RE);
  if (exp) {
    const n = Number(exp[1]);
    const unit = exp[2]!.toLowerCase();
    out.expiresAt = startedAt + n * (unit.startsWith('hour') ? 3_600_000 : unit.startsWith('min') ? 60_000 : 1000);
  }
  return out;
}

/** The CLI login that shows a link and code (or asks for one back) for `providerId`, from the runtime's terminal login. */
export async function deviceLoginCommand(ctx: CoreCtx, id: string, methodId?: string, scope = ''): Promise<DeviceLoginCommand | null> {
  const base = providerBase(id);
  const login = ctx.s.logins.loginEnv(scope);
  if (base === 'codex') {
    const cmd = await ctx.runtime.authCommand(id, methodId, login);
    if (!cmd) return null;
    const args = cmd.args.includes('--device-auth') ? cmd.args : [...cmd.args, '--device-auth'];
    return { command: cmd.command, args, env: cmd.env };
  }
  if (base === 'claude-code') {
    // the adapter's login runs the user's own `claude` (CLAUDE_CODE_EXECUTABLE): its full `auth login` (a link to paste
    // a code from, and through BROWSER a link that returns here; no terminal needed once BROWSER is set), or
    // `setup-token` (a token printed; it prints nothing without a pseudo-terminal)
    const cmd = await ctx.runtime.authCommand(id, 'claude-ai-login', login);
    if (!cmd) return null;
    const claude = cmd.env.CLAUDE_CODE_EXECUTABLE;
    if (!claude) return null;
    if (methodId === 'setup-token') return { command: claude, args: ['setup-token'], env: cmd.env, pty: true, token: true };
    return { command: claude, args: ['auth', 'login', methodId === 'console-login' ? '--console' : '--claudeai'], env: cmd.env };
  }
  const cmd = await ctx.runtime.authCommand(id, methodId, login);
  if (!cmd) return null;
  // Copilot picks a browser sign-in that returns to it on a desktop: a code works from anywhere
  if (base === 'copilot' && !cmd.args.includes('--device-code')) return { command: cmd.command, args: [...cmd.args, '--device-code'], env: cmd.env };
  return { command: cmd.command, args: cmd.args, env: cmd.env };
}

/** `cmd` under a pseudo-terminal where the OS offers `script` (Linux: util-linux, macOS: BSD); as it is elsewhere. */
export function withPty(cmd: DeviceLoginCommand, platform = process.platform): DeviceLoginCommand {
  if (!cmd.pty || platform === 'win32') return cmd;
  const line = [cmd.command, ...cmd.args].map((a) => (/^[A-Za-z0-9_./=:-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ');
  return platform === 'linux'
    ? { command: 'script', args: ['-qfec', line, '/dev/null'], env: cmd.env }
    : { command: 'script', args: ['-q', '/dev/null', cmd.command, ...cmd.args], env: cmd.env };
}

/** The `BROWSER` a CLI login runs with: a script that writes the link it was given to the run's file, opening nothing. */
const BROWSER_SCRIPT = `#!/bin/sh
# AppuBot: a sign-in link an agent opened while signing in for another device. It goes there, not to this screen.
[ -n "$APPUBOT_LOGIN_URLS" ] && printf '%s\\n' "$1" >> "$APPUBOT_LOGIN_URLS"
exit 0
`;

export class DeviceLoginService {
  private runs = new Map<string, Run>();

  constructor(private ctx: CoreCtx) {}

  status(id: string): DeviceLogin | null { return this.runs.get(id)?.login ?? null; }

  /**
   * `scope`: a team member signs in with their own logins (their home) on a team's computer set to each person's own.
   * `here`: for this computer's own window, with no terminal (Settings › Agents on Windows, macOS and Linux alike): the
   * agent's links aren't caught, so it opens its page in this computer's browser itself and its own listener on this
   * computer takes the return (no relay); the link, code and paste prompt it prints still come to the window.
   */
  async start(id: string, methodId?: string, scope = '', here = false): Promise<DeviceLogin> {
    const spec = this.ctx.runtime.getProviders().find((s) => s.id === id);
    if (!spec) throw new RpcError('not_found', `Provider not found: ${id}`);
    const live = this.runs.get(id);
    if (live && (live.login.state === 'starting' || live.login.state === 'waiting')) return live.login;
    const startedAt = Date.now();
    const blank = (kind: Run['kind']): Run => ({ login: { id, ...(methodId ? { methodId } : {}), state: 'starting', startedAt }, kind, child: null, output: '', timer: null, cancelled: false, scope, here, urlsRead: 0, urlsTimer: null });

    // an ACP agent that signs in by itself (in the browser it opens): its page is handed here
    const agentMethod = this.ctx.deps.deviceLoginCommand ? undefined : this.agentLoginOf(id, methodId, scope);
    if (agentMethod) {
      const run = blank('agent');
      this.runs.set(id, run);
      this.armTimeout(run);
      this.ctx.log.info(`device login: ${id} started (its own login, ${agentMethod})`);
      void this.ctx.runtime.login(id, agentMethod, DEVICE_LOGIN_TIMEOUT_MS, this.ctx.s.logins.loginEnv(scope), (url) => this.caught(run, url)).then(
        () => { if (!run.cancelled) this.settle(run, 'done', `${spec.name} is signed in.`); },
        (e: unknown) => { if (!run.cancelled) this.settle(run, 'failed', errMsg(e)); },
      );
      return run.login;
    }

    const cmd = await (this.ctx.deps.deviceLoginCommand ? this.ctx.deps.deviceLoginCommand(id, methodId) : deviceLoginCommand(this.ctx, id, methodId, scope));
    if (!cmd) throw new RpcError('unsupported', `${spec.name} has no login that works from here. Paste a key or token instead, or sign in from its desktop.`);
    const run = blank(cmd.token ? 'token' : 'cli');
    this.runs.set(id, run);
    const real = withPty(cmd);
    const browser = here ? {} : this.catchLinks(run);
    try {
      run.child = spawnCommand(real.command, real.args, { env: { ...process.env, ...real.env, ...browser, NO_COLOR: '1', TERM: 'dumb' }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.end(run, 'failed', `Couldn’t start the login: ${errMsg(e)}`);
      return run.login;
    }
    const child = run.child;
    const onData = (d: Buffer | string) => {
      run.output = (run.output + String(d)).slice(-20_000);
      const read = readLoginOutput(run.output, startedAt);
      // a printed link that returns here counts as much as one caught through BROWSER (an agent that prints it)
      const relay = read.url ? this.noteReturn(run, read.url) : undefined;
      const next: DeviceLogin = { ...run.login, ...read, ...relay, state: read.url || read.prompt || run.login.relay || relay ? 'waiting' : run.login.state };
      this.update(run, next);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (e) => this.settle(run, 'failed', `The login couldn’t run: ${errMsg(e)}`));
    child.on('exit', (code) => {
      if (run.cancelled) return;
      if (code !== 0) { this.settle(run, 'failed', lastLines(run.output) || `The login ended with code ${code ?? '?'}.`); return; }
      if (run.kind === 'token') { void this.keepClaudeToken(run, spec.name); return; }
      this.settle(run, 'done', `${spec.name} is signed in.`);
    });
    this.armTimeout(run);
    this.ctx.log.info(`device login: ${id} started (${real.command})`);
    return run.login;
  }

  /** The code the CLI asked to have pasted (a running login only). */
  async code(id: string, code: string): Promise<DeviceLogin> {
    const run = this.runs.get(id);
    if (!run || !run.child || (run.login.state !== 'waiting' && run.login.state !== 'starting')) throw new RpcError('invalid_state', 'No login is waiting for a code. Start it again.');
    try { run.child.stdin?.write(`${code.trim()}\n`); } catch (e) { throw new RpcError('internal', `Couldn’t pass the code on: ${errMsg(e)}`); }
    run.login = { ...run.login, prompt: undefined };
    this.emit(run);
    return run.login;
  }

  /**
   * The address a sign-in came back to on another device: checked against this run's (port, path, `state`), then
   * handed to the agent's own listener here, which finishes the sign-in (the run ends as the agent says).
   */
  async finish(id: string, url: string): Promise<DeviceLogin> {
    const run = this.runs.get(id);
    if (!run || (run.login.state !== 'waiting' && run.login.state !== 'starting')) throw new RpcError('invalid_state', 'No sign-in is waiting here any more. Start it again.');
    if (!run.relay) throw new RpcError('invalid_state', 'This sign-in doesn’t come back to the computer. Use its link and code instead.');
    let back: URL;
    try { back = checkReturn(url, run.relay); } catch (e) { throw new RpcError('invalid_params', errMsg(e)); }
    try { await deliverReturn(back); } catch (e) { throw new RpcError('internal', errMsg(e)); }
    this.ctx.log.info(`device login: ${id} came back, handed to the agent`);
    this.update(run, { ...run.login, prompt: undefined, message: 'Finishing the sign-in…' });
    return run.login;
  }

  cancel(id: string): { ok: true } {
    const run = this.runs.get(id);
    if (run) this.end(run, 'failed', 'Cancelled.', true);
    return { ok: true };
  }

  stopAll(): void {
    for (const run of this.runs.values()) this.end(run, 'failed', 'AppuBot stopped.', true);
  }

  /** The `agent`-kind login (ACP `authenticate`) of an agent AppuBot doesn't build in: the one asked for, else its first. */
  private agentLoginOf(id: string, methodId: string | undefined, scope: string): string | undefined {
    const builtin = this.ctx.runtime.getProviders().some((s) => s.id === providerBase(id) && s.builtin);
    if (builtin) return undefined;
    const methods = (this.ctx.s.providers.list(scope).find((p) => p.id === id)?.authMethods ?? []).filter((m) => m.kind === 'agent' && !m.vars?.length);
    return (methodId ? methods.find((m) => m.id === methodId) : methods[0])?.id;
  }

  /**
   * The env that makes a CLI login hand its page here: `BROWSER` is a script writing the link to the run's own file,
   * read every `URLS_POLL_MS`. Windows has no such script: its agents print their links, which are read instead.
   */
  private catchLinks(run: Run): Record<string, string> {
    if (process.platform === 'win32') return { BROWSER: 'rundll32' };
    try {
      const dir = join(this.ctx.paths.dataDir, 'login-links');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const script = join(dir, 'browser.sh');
      if (!existsSync(script) || readFileSync(script, 'utf8') !== BROWSER_SCRIPT) writeFileSync(script, BROWSER_SCRIPT, { mode: 0o700 });
      chmodSync(script, 0o700);
      run.urlsFile = join(dir, `${randomUUID()}.txt`);
      writeFileSync(run.urlsFile, '', { mode: 0o600 });
      run.urlsTimer = setInterval(() => this.readLinks(run), URLS_POLL_MS);
      run.urlsTimer.unref?.();
      return { BROWSER: script, APPUBOT_LOGIN_URLS: run.urlsFile };
    } catch (e) {
      this.ctx.log.warn('device login: no link catcher', errMsg(e));
      return { BROWSER: '/bin/true' };
    }
  }

  private readLinks(run: Run): void {
    if (!run.urlsFile) return;
    let text: string;
    try { text = readFileSync(run.urlsFile, 'utf8'); } catch { return; }
    if (text.length <= run.urlsRead) return;
    const fresh = text.slice(run.urlsRead);
    run.urlsRead = text.length;
    for (const line of fresh.split('\n')) { const url = line.trim(); if (/^https:\/\/\S+$/.test(url)) this.caught(run, url); }
  }

  /** A page the login opened: it goes to the device (its link, and its way back when it returns here). */
  private caught(run: Run, url: string): void {
    if (run.login.state === 'done' || run.login.state === 'failed') return;
    const relay = this.noteReturn(run, url);
    this.update(run, { ...run.login, ...relay, ...(run.login.url ? {} : { url }), state: 'waiting' });
  }

  /** `url` returns to a loopback port here: that's the run's way back (`DeviceLogin.relay`), the first one caught. */
  private noteReturn(run: Run, url: string): Pick<DeviceLogin, 'relay'> | undefined {
    if (run.relay || run.here) return undefined;
    const back = loopbackReturn(url);
    if (!back) return undefined;
    run.relay = back;
    return { relay: { url, port: back.port, path: back.path } };
  }

  private update(run: Run, next: DeviceLogin): void {
    if (JSON.stringify(next) === JSON.stringify(run.login)) return;
    run.login = next;
    this.emit(run);
  }

  private armTimeout(run: Run): void {
    run.timer = setTimeout(() => { if (run.login.state === 'starting' || run.login.state === 'waiting') this.end(run, 'failed', 'The login took too long; start it again.'); }, DEVICE_LOGIN_TIMEOUT_MS);
    run.timer.unref?.();
  }

  private end(run: Run, state: 'done' | 'failed', message: string, cancelled = false): void {
    run.cancelled = run.cancelled || cancelled;
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    if (run.urlsTimer) clearInterval(run.urlsTimer);
    run.urlsTimer = null;
    if (run.urlsFile) { try { rmSync(run.urlsFile, { force: true }); } catch { /* best effort */ } run.urlsFile = undefined; }
    const child = run.child;
    run.child = null;
    if (child && child.exitCode === null) { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    if (run.login.state === 'done' || run.login.state === 'failed') return;
    run.login = { ...run.login, state, message };
    this.emit(run);
  }

  /** `claude setup-token` ended: its token becomes the key login, since the command itself saves nothing. */
  private async keepClaudeToken(run: Run, name: string): Promise<void> {
    const token = readClaudeToken(run.output);
    run.output = '';
    if (!token) { this.settle(run, 'failed', `${name} printed no token. Start the login again.`); return; }
    try {
      const r = await this.ctx.s.providers.setKeys(run.login.id, 'claude-token', { CLAUDE_CODE_OAUTH_TOKEN: token }, run.scope);
      if (r.ok) this.settle(run, 'done', `${name} is signed in.`);
      else this.settle(run, 'failed', r.message ?? `${name} didn't accept the token.`);
    } catch (e) {
      this.settle(run, 'failed', `Couldn’t keep the token: ${errMsg(e)}`);
    }
  }

  private settle(run: Run, state: 'done' | 'failed', message: string): void {
    this.end(run, state, message);
    if (state === 'done') void this.ctx.s.providers.refreshQuiet(run.login.id);
    this.ctx.log.info(`device login: ${run.login.id} ${state}`);
  }

  private emit(run: Run): void {
    this.ctx.bus.emit('provider.login', run.login);
  }
}

function lastLines(output: string): string {
  return output.replace(ANSI, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join(' ').slice(0, 300);
}
