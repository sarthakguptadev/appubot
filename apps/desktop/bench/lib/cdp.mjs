// A minimal Chrome DevTools Protocol client (Node's own WebSocket and fetch), enough for the benches: attach to a page
// target of a Chrome or Electron started with --remote-debugging-port, send commands, wait for events.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 30_000, every = 50, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

/** The first page target on `port` (optionally one whose url matches), once the browser is listening. */
export async function pageTarget(port, match = () => true, timeout = 30_000) {
  return waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.find((t) => t.type === 'page' && match(t.url));
  }, { timeout, what: `a page on :${port}` });
}

export class Cdp {
  static async attach(wsUrl) {
    const c = new Cdp(new WebSocket(wsUrl));
    await new Promise((resolve, reject) => { c.ws.addEventListener('open', resolve); c.ws.addEventListener('error', reject); });
    return c;
  }

  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(`${m.error.message} ${m.error.data ?? ''}`)); else resolve(m.result);
      } else if (m.method) {
        for (const fn of this.listeners.get(m.method) ?? []) fn(m.params);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method).delete(fn);
  }

  /** Evaluate an expression (awaiting promises) and return its value. */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  close() { try { this.ws.close(); } catch { /* gone */ } }
}

export const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Headless Chrome on its own profile and debugging port; `stop()` ends it and removes the profile. */
export async function launchChrome({ port = 9520 + Math.floor(Math.random() * 300), width = 1440, height = 900 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'appubot-bench-chrome-'));
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, `--window-size=${width},${height}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required', 'about:blank',
  ], { stdio: 'ignore' });
  const stop = async () => { proc.kill('SIGTERM'); await sleep(300); try { proc.kill('SIGKILL'); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); };
  // a bench that fails midway still leaves no browser behind
  process.on('exit', () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); });
  try {
    const t = await pageTarget(port);
    return { port, proc, target: t, stop };
  } catch (e) { await stop(); throw e; }
}
