/**
 * Client-side implementation of the ACP `terminal/*` methods.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cmdLaunch, comspec, killTree, launchSpec, mergeEnv, pathKey, processGroup, whichSync, type Launch } from './spawn';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputResponse,
  WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk';

export const DEFAULT_OUTPUT_BYTE_LIMIT = 1024 * 1024;

interface ExitStatus {
  exitCode: number | null;
  signal: string | null;
}

interface TerminalEntry {
  id: string;
  child?: ChildProcess;
  output: string;
  truncated: boolean;
  limit: number;
  exit?: ExitStatus;
  exited: Promise<ExitStatus>;
}

export interface TerminalManagerOptions {
  /** default cwd (session cwd) */
  cwd: string;
  /** base env for spawned commands (already includes the login PATH) */
  env: NodeJS.ProcessEnv;
  onOutput(terminalId: string, chunk: string): void;
  onExit?(terminalId: string, status: ExitStatus): void;
}

function shellPath(): string {
  if (existsSync('/bin/zsh')) return '/bin/zsh';
  return process.env.SHELL || '/bin/sh';
}

function trimToByteLimit(s: string, limit: number): { text: string; trimmed: boolean } {
  const bytes = Buffer.byteLength(s, 'utf8');
  if (bytes <= limit) return { text: s, trimmed: false };
  const buf = Buffer.from(s, 'utf8');
  let text = buf.subarray(buf.length - limit).toString('utf8');
  // drop a partially-cut leading multibyte character
  while (text.startsWith('�')) text = text.slice(1);
  return { text, trimmed: true };
}

/**
 * How a terminal's command runs. A lone command line (no args, with spaces) goes to a shell: the login shell on
 * macOS/Linux, cmd.exe on Windows. Otherwise the program itself; on Windows found by PATHEXT (`npm` is `npm.cmd`)
 * and started through `launchSpec`, or through cmd.exe when it isn't a file on PATH (`dir`, `echo`: cmd's own).
 */
export function terminalLaunch(command: string, args: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Launch {
  const line = args.length === 0 && /\s/.test(command.trim());
  if (platform !== 'win32') return line ? { command: shellPath(), args: ['-lc', command] } : { command, args };
  if (line) return { command: comspec(env), args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true };
  const exe = whichSync(command, env[pathKey(env, platform)] ?? '', platform, env);
  return exe ? launchSpec(exe, args, platform, env) : cmdLaunch(command, args, env);
}

export class TerminalManager {
  private terminals = new Map<string, TerminalEntry>();

  constructor(private readonly opts: TerminalManagerOptions) {}

  create(req: CreateTerminalRequest): CreateTerminalResponse {
    const id = `term_${randomUUID()}`;
    const limit = req.outputByteLimit && req.outputByteLimit > 0 ? req.outputByteLimit : DEFAULT_OUTPUT_BYTE_LIMIT;
    const env = mergeEnv([this.opts.env, Object.fromEntries((req.env ?? []).map((v) => [v.name, v.value]))]);
    const run = terminalLaunch(req.command, req.args ?? [], env);

    let resolveExit!: (s: ExitStatus) => void;
    const exited = new Promise<ExitStatus>((r) => (resolveExit = r));
    const entry: TerminalEntry = { id, output: '', truncated: false, limit, exited };
    this.terminals.set(id, entry);

    const finish = (status: ExitStatus) => {
      if (entry.exit) return;
      entry.exit = status;
      resolveExit(status);
      this.opts.onExit?.(id, status);
    };

    let child: ChildProcess;
    try {
      child = spawn(run.command, run.args, {
        cwd: req.cwd || this.opts.cwd,
        env,
        shell: false,
        detached: processGroup(),
        windowsHide: true,
        ...(run.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.append(entry, `${(err as Error).message}\n`);
      finish({ exitCode: 127, signal: null });
      return { terminalId: id };
    }
    entry.child = child;
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    child.stdout?.on('data', (b: Buffer) => this.append(entry, outDec.write(b)));
    child.stderr?.on('data', (b: Buffer) => this.append(entry, errDec.write(b)));
    child.on('error', (err) => {
      this.append(entry, `${err.message}\n`);
      finish({ exitCode: 127, signal: null });
    });
    child.on('close', (code, signal) => {
      this.append(entry, outDec.end() + errDec.end());
      finish({ exitCode: code, signal: signal ?? null });
    });
    return { terminalId: id };
  }

  private append(entry: TerminalEntry, chunk: string): void {
    if (!chunk) return;
    const { text, trimmed } = trimToByteLimit(entry.output + chunk, entry.limit);
    entry.output = text;
    if (trimmed) entry.truncated = true;
    this.opts.onOutput(entry.id, chunk);
  }

  private get(id: string): TerminalEntry {
    const t = this.terminals.get(id);
    if (!t) throw new Error(`Unknown terminal: ${id}`);
    return t;
  }

  output(id: string): TerminalOutputResponse {
    const t = this.get(id);
    return {
      output: t.output,
      truncated: t.truncated,
      ...(t.exit ? { exitStatus: { exitCode: t.exit.exitCode, signal: t.exit.signal } } : {}),
    };
  }

  async waitForExit(id: string): Promise<WaitForTerminalExitResponse> {
    const s = await this.get(id).exited;
    return { exitCode: s.exitCode, signal: s.signal };
  }

  kill(id: string): void {
    const t = this.get(id);
    if (t.child && !t.exit) {
      killTree(t.child, 'SIGTERM');
      const child = t.child;
      setTimeout(() => {
        if (!t.exit) killTree(child, 'SIGKILL');
      }, 2000).unref();
    }
  }

  release(id: string): void {
    const t = this.terminals.get(id);
    if (!t) return;
    if (t.child && !t.exit) this.kill(id);
    this.terminals.delete(id);
  }

  releaseAll(): void {
    for (const id of [...this.terminals.keys()]) this.release(id);
  }

  get size(): number {
    return this.terminals.size;
  }
}
