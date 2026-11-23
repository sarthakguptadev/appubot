// Launch bench of the production build (out/, `electron-vite build`) run as `electron .`, the way the dev harness runs
// it: a data folder of its own (two bots, one with a 600-message thread), its own gateway port, an invisible
// click-through window (APPUBOT_DEV_CAPTURE), and the startup trace (APPUBOT_STARTUP_TRACE). Never touches the user's
// own app (its data, port 7890 or its window).
//
//   node bench/startup.mjs [--cold 3] [--runs 6] [--build] [--settle 10] [--idle 30] [--json out.json] [--port 7991]
//
// Per launch: main's trace marks (module loaded, app ready, core steps, window created, ready-to-show, page loaded)
// and the renderer's (first paint, hydrated, main layout painted, transcript painted), from the spawn. `--cold`
// launches run without Chromium's code cache (as after an install or update), the rest with it; medians of each. After the last
// launch: idle CPU and memory per process kind over `--idle` seconds from `--settle` seconds after its spawn, idle
// CPU again with Reduce motion emulated (the avatars still) over half as long, then memory once the whole long thread is drawn.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, pageTarget, sleep, waitFor } from './lib/cdp.mjs';
import { kindOf, median, processTree, treeCpuSeconds, summarizeTree } from './lib/procs.mjs';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const RUNS = Number(opt('--runs', '6'));
/** launches without Chromium's caches (as after an install or an update), before the warm ones */
const COLD = Number(opt('--cold', '3'));
const IDLE_S = Number(opt('--idle', '30'));
const SETTLE_S = Number(opt('--settle', '10'));
const PORT = Number(opt('--port', '7991'));
const DEBUG_PORT = PORT + 1000;
const ELECTRON = execFileSync('node', ['-p', 'require("electron")'], { cwd: DESKTOP, encoding: 'utf8' }).trim();

if (args.includes('--build')) execFileSync('npx', ['electron-vite', 'build', '--logLevel', 'warn'], { cwd: DESKTOP, stdio: 'inherit' });
if (!existsSync(join(DESKTOP, 'out/main/index.js'))) throw new Error('no build in out/: run with --build');

/* ---------- a data folder: two bots, the first with a long thread ---------- */
const { benchMessages } = await import('../src/renderer/src/dev/benchThread.ts');
const data = mkdtempSync(join(tmpdir(), 'appubot-bench-data-'));
const now = Date.now();
const bot = (id, slug, name, color) => ({
  id, slug, name, emoji: '🪔', color, shape: 'circle', job: 'General assistant on this Mac', instructions: '', providerId: 'claude-code',
  modeId: 'bypassPermissions', effort: 'medium', fast: false, workspace: join(data, 'bots', slug), computerUse: true, autoApprove: 'safe',
  appsOff: [], pinned: false, createdAt: now - 86_400_000, updatedAt: now - 86_400_000,
});
const bots = [bot('bot_bench_appu', 'appu', 'Appu', '#FF7A1F'), bot('bot_bench_ledger', 'ledger', 'Ledger', '#2E8EFF')];
const LONG = 600;
const threadId = 'th_bench_long';
const messages = benchMessages(threadId, LONG, now - 120_000);
const thread = {
  id: threadId, botId: bots[0].id, title: 'Invoices and expenses', providerId: 'claude-code', cwd: bots[0].workspace, status: 'idle',
  modes: [{ id: 'auto', name: 'Approve for me' }, { id: 'bypassPermissions', name: 'Full access' }], modeId: 'bypassPermissions',
  models: [{ id: 'default', name: 'Default' }], modelId: 'default', efforts: [], fastAvailable: false, fast: false, commands: [], source: 'desktop', lastMessagePreview: 'Priya still needs…',
  createdAt: messages[0].createdAt, updatedAt: messages.at(-1).updatedAt, lastActiveAt: messages.at(-1).updatedAt,
};
for (const b of bots) mkdirSync(b.workspace, { recursive: true });
mkdirSync(join(data, 'threads'), { recursive: true });
writeFileSync(join(data, 'settings.json'), JSON.stringify({ onboarded: true }));
writeFileSync(join(data, 'bots.json'), JSON.stringify(bots));
writeFileSync(join(data, 'threads.json'), JSON.stringify([thread]));
writeFileSync(join(data, 'threads', `${threadId}.json`), JSON.stringify({ thread, messages, archive: [] }));
// the thread's lists (models, modes) as its last session reported them, and every built-in agent's model lists as read
// a moment ago: a returning user's launch starts no agent (the chat's warm-up, warmChoices, the pickers), so the idle
// numbers are the app's own
const lists = { at: now, v: 2, models: [{ id: 'default', name: 'Default' }], efforts: [], modes: [] };
writeFileSync(join(data, 'provider-choices.json'), JSON.stringify(Object.fromEntries(['claude-code', 'codex', 'cursor', 'grok', 'copilot', 'opencode'].map((id) => [id, lists]))));

/* ---------- one launch ---------- */
const MARKS = ['win:nav-start', 'win:script-loaded', 'appubot:bundle-evaluated', 'first-paint', 'first-contentful-paint', 'appubot:hydrated', 'appubot:main-painted', 'appubot:transcript-painted'];

async function launch() {
  const trace = join(data, `trace-${Date.now()}.json`);
  const env = {
    ...process.env, APPUBOT_DATA_DIR: data, APPUBOT_BOTS_ROOT: join(data, 'bots'), APPUBOT_PORT: String(PORT),
    APPUBOT_DEV_CAPTURE: join(data, 'capture.png'), APPUBOT_STARTUP_TRACE: trace,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const t0 = Date.now();
  const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT}`], { cwd: DESKTOP, env, stdio: ['ignore', 'ignore', 'pipe'] });
  // a bench that fails midway still leaves no app behind (its helpers end with it)
  process.on('exit', () => { try { process.kill(proc.pid, 'SIGKILL'); } catch { /* gone */ } rmSync(data, { recursive: true, force: true }); });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  const target = await pageTarget(DEBUG_PORT, (u) => u.includes('renderer/index.html'), 60_000);
  const cdp = await Cdp.attach(target.webSocketDebuggerUrl);
  const read = () => cdp.eval(`(() => { const o = {}; const t = performance.timeOrigin;
    for (const e of performance.getEntriesByType('paint')) o[e.name] = t + e.startTime;
    for (const e of performance.getEntriesByType('mark')) if (e.name.startsWith('appubot:')) o[e.name] = t + e.startTime;
    // the renderer's page starting to load, and its entry script read (the bundle, before it is compiled and run)
    o['win:nav-start'] = t;
    const js = performance.getEntriesByType('resource').find((e) => e.name.includes('/assets/index-') && e.name.endsWith('.js'));
    if (js) o['win:script-loaded'] = t + js.responseEnd;
    return o; })()`);
  const renderer = await waitFor(async () => { const o = await read(); return o['appubot:transcript-painted'] ? o : null; }, { timeout: 60_000, what: 'the transcript', every: 25 });
  await sleep(300);
  const main = JSON.parse(readFileSync(trace, 'utf8'));
  const times = {};
  for (const m of main.marks) times[m.name] = Math.round(m.at - t0);
  for (const k of MARKS) if (renderer[k]) times[k] = Math.round(renderer[k] - t0);
  return { proc, cdp, pid: main.pid, t0, times, stderr: () => stderr };
}

async function quit(run) {
  run.cdp.close();
  const pids = processTree(run.pid).map((p) => p.pid);
  try { process.kill(run.pid, 'SIGTERM'); } catch { /* gone */ }
  await waitFor(async () => run.proc.exitCode !== null || run.proc.signalCode !== null, { timeout: 12_000, what: 'quit' }).catch(() => undefined);
  for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  await sleep(500);
}

/* ---------- the launches ---------- */
const launches = [];
let last = null;
const cold = [];
for (let i = 0; i < COLD + RUNS; i++) {
  // the cold launches go without Chromium's caches (the first one after an install or an update)
  if (i < COLD) for (const d of ['Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache']) rmSync(join(data, 'electron', d), { recursive: true, force: true });
  const run = await launch();
  (i < COLD ? cold : launches).push(run.times);
  console.log(`launch ${i + 1}${i < COLD ? ' (cold)' : ''}: ${Object.entries(run.times).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (i < COLD + RUNS - 1) await quit(run); else last = run;
}

/* ---------- idle and memory (the last launch) ---------- */
await sleep(Math.max(0, last.t0 + SETTLE_S * 1000 - Date.now()));
const idleStart = { at: Date.now(), cpu: treeCpuSeconds(last.pid) };
await sleep(IDLE_S * 1000);
const idleEnd = { at: Date.now(), cpu: treeCpuSeconds(last.pid) };
const idle = summarizeTree(last.pid, idleStart, idleEnd);
const heapIdle = await last.cdp.send('Runtime.getHeapUsage');
// the same with macOS's Reduce motion (the bots' avatars hold still): what the app does by itself at rest
await last.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await sleep(2000);
const stillStart = { at: Date.now(), cpu: treeCpuSeconds(last.pid) };
await sleep(Math.round(IDLE_S / 2) * 1000);
const idleReducedMotion = summarizeTree(last.pid, stillStart, { at: Date.now(), cpu: treeCpuSeconds(last.pid) });
await last.cdp.send('Emulation.setEmulatedMedia', { features: [] });

// the whole long thread: page every older message in, then draw all of it (⌘F's "every loaded message")
await last.cdp.eval(`(async () => {
  const el = document.querySelector('[data-transcript]');
  const rows = () => document.querySelectorAll('[data-message-id]').length;
  // the top coming into view pages older messages in: leave it and come back each time
  for (let i = 0, same = 0, last = 0; i < 60 && same < 4; i++) {
    el.scrollTop = 3000; await new Promise((r) => setTimeout(r, 150));
    el.scrollTop = 0; await new Promise((r) => setTimeout(r, 450));
    same = rows() === last ? same + 1 : 0; last = rows();
  }
  window.dispatchEvent(new CustomEvent('appubot:transcript-find', { detail: { threadId: el.dataset.transcript, all: true } }));
  await new Promise((r) => setTimeout(r, 1500));
})()`);
const rows = await last.cdp.eval(`document.querySelectorAll('[data-message-id]').length`);
await sleep(2000);
const longThread = summarizeTree(last.pid);
await last.cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
const heapLong = await last.cdp.send('Runtime.getHeapUsage');
const spawned = processTree(last.pid).map((p) => kindOf(p, last.pid));
await quit(last);
rmSync(data, { recursive: true, force: true });

const keys = [...new Set([...cold, ...launches].flatMap((l) => Object.keys(l)))];
const medianOf = (list) => Object.fromEntries(keys.map((k) => [k, median(list.map((l) => l[k]).filter((v) => v !== undefined))]));
// the first warm launch follows a cold one (its caches were only just written): left out of the median
const report = {
  at: new Date().toISOString(),
  runs: RUNS,
  first: medianOf(cold),
  warmMedian: medianOf(launches.slice(1)),
  cold,
  launches,
  idle: { seconds: IDLE_S, ...idle, rendererHeapMB: +(heapIdle.usedSize / 1048576).toFixed(1) },
  idleReducedMotion: { seconds: Math.round(IDLE_S / 2), cpuPct: idleReducedMotion.cpuPct },
  longThread: { rows, ...longThread, rendererHeapMB: +(heapLong.usedSize / 1048576).toFixed(1) },
  processes: spawned,
};
console.log('\ncold launches, median (no code cache):', report.first);
console.log('warm median:', report.warmMedian);
console.log('idle:', JSON.stringify(report.idle));
console.log('idle, Reduce motion:', JSON.stringify(report.idleReducedMotion));
console.log('long thread:', JSON.stringify(report.longThread));
const json = opt('--json');
if (json) writeFileSync(json, JSON.stringify(report, null, 2));
process.exit(0);
