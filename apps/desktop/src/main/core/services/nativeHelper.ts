/** JSON-lines transport to the Swift `appubot-helper` binary ({id,cmd,params} → {id,ok,result|error}). */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Logger } from '../util';

export interface HelperTransport {
  request<T = Record<string, unknown>>(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  /** unsolicited `{event:'input',...}` lines */
  onEvent(fn: (ev: Record<string, unknown>) => void): () => void;
  close(): void;
}

export class HelperError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'HelperError'; }
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class ProcessHelperTransport implements HelperTransport {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(ev: Record<string, unknown>) => void>();
  private closed = false;

  constructor(private binPath: string, private log: Logger) {}

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return this.proc;
    if (this.closed) throw new HelperError('closed', 'helper closed');
    const p = spawn(this.binPath, ['--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    this.buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk: string) => this.onData(chunk));
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d: string) => this.log.debug(`[helper] ${d.trim()}`));
    p.on('error', (e) => { this.log.warn('helper process error', String(e)); this.failAll(e); });
    p.on('exit', (code) => {
      if (this.proc === p) this.proc = null;
      this.failAll(new HelperError('exited', `helper exited (${code})`));
    });
    return p;
  }

  private failAll(e: Error): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(e); }
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (typeof msg.event === 'string') {
        for (const l of this.listeners) { try { l(msg); } catch { /* ignore */ } }
        continue;
      }
      const id = typeof msg.id === 'number' ? msg.id : Number(msg.id);
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else {
        const err = (msg.error ?? {}) as { code?: string; message?: string };
        p.reject(new HelperError(err.code ?? 'error', err.message ?? 'helper error'));
      }
    }
  }

  request<T>(cmd: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let p: ChildProcessWithoutNullStreams;
      try { p = this.ensure(); } catch (e) { reject(e as Error); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new HelperError('timeout', `helper ${cmd} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      p.stdin.write(JSON.stringify({ id, cmd, params }) + '\n', (err) => {
        if (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
      });
    });
  }

  onEvent(fn: (ev: Record<string, unknown>) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): void {
    this.closed = true;
    const p = this.proc;
    this.proc = null;
    if (p && p.exitCode === null) {
      try { p.stdin.write(JSON.stringify({ id: 0, cmd: 'quit', params: {} }) + '\n'); } catch { /* ignore */ }
      setTimeout(() => { if (p.exitCode === null) p.kill('SIGTERM'); }, 500).unref?.();
    }
    this.failAll(new HelperError('closed', 'helper closed'));
  }
}

export function createHelperTransport(binPath: string | undefined, log: Logger): HelperTransport | null {
  if (!binPath || !existsSync(binPath)) return null;
  return new ProcessHelperTransport(binPath, log);
}
