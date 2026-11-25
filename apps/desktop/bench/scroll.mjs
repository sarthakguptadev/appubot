// Scroll bench: reading back through a long chat, on the renderer built for production in mock mode (the same build and
// mock gateway as renderer.mjs: `?long=600`, every call ~150-400 ms like a computer over the network), in headless
// Chrome at 2x, driven with real wheel events over the DevTools protocol.
//
//   node bench/scroll.mjs [--runs 3] [--json out.json] [--port 5298] [--no-build] [--speed 60]
//
// Scenarios (each run on a fresh page, Appu's 600-message chat open at its end, its first page loaded):
//   up      wheel up from the end until the chat's very first message is on screen, `--speed` px a wheel event (150; the
//           DevTools round trip paces them at ~55 ms, so ~2.7k px/s: skimming): the time it takes, the time spent stuck at the top while older messages are fetched or
//           drawn ("stalled"), how often that happened, and the frames meanwhile (over 34 ms = at least one dropped
//           frame at 60 Hz, the worst one, long animation frames and their script time)
//   down    the same chat, now all drawn, wheeled back down to the end: frames only (what scrolling itself costs)
//           "backJumps": frames where the view moved the wrong way (rows drawn above it not compensated)
//   cost    main-thread time in each phase (Performance.getMetrics: all tasks, script, style recalc, layout)
//   rows    the rows drawn when the top was reached, and the DOM's size
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, launchChrome, sleep, waitFor } from './lib/cdp.mjs';
import { serveDir } from './lib/serve.mjs';
import { median } from './lib/procs.mjs';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(DESKTOP, 'src/renderer');
const OUT = join(DESKTOP, 'bench/.out-scroll');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const RUNS = Number(opt('--runs', '3'));
const PORT = Number(opt('--port', '5298'));
const SPEED = Number(opt('--speed', '150'));
const LONG = 600;

if (!args.includes('--no-build')) {
  await build({
    root: ROOT, logLevel: 'error', configFile: false, base: './',
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': join(ROOT, 'src') } },
    define: { 'import.meta.env.VITE_APPUBOT_MOCK': JSON.stringify('1') },
    build: { outDir: join(OUT, 'mock'), emptyOutDir: true, minify: true, reportCompressedSize: false, chunkSizeWarningLimit: 1e9 },
  });
}

const server = await serveDir(OUT, PORT);

const chrome = await launchChrome();
const browser = await Cdp.attach((await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json()).webSocketDebuggerUrl);
const r1 = (x) => Math.round(x * 10) / 10;

async function openPage() {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const list = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
  const page = await Cdp.attach(list.find((t) => t.id === targetId).webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/mock/index.html?theme=dark&bench=1&long=${LONG}` });
  await waitFor(() => page.eval(`!!window.__appubotBench && document.querySelectorAll('[data-transcript] [data-message-id]').length > 0 && !!window.__appubotBench.getState().convo[window.__appubotBench.getState().selectedThreadId]?.loaded`), { what: 'the chat', timeout: 30_000 });
  // the launch's own work (highlighting, the idle prefetches, Settings' chunk) out of the way
  await sleep(4000);
  page.closeTab = async () => { page.close(); await browser.send('Target.closeTarget', { targetId }); };
  return page;
}

/** Page-side recorder: frames, long animation frames, and time spent at the top with older messages still to come. */
const RECORDER = `(() => {
  const w = window; const B = w.__appubotBench;
  const el = document.querySelector('[data-transcript]');
  const tid = el.getAttribute('data-transcript');
  const more = () => { const c = B.getState().convo[tid]; const rows = el.querySelectorAll('[data-message-id]').length; return !!c && (c.hasMore || rows < c.ids.length); };
  w.__rec = { frames: [], loaf: [], stalled: 0, stalls: 0, atTop: false, done: false, topAt: 0, t0: performance.now(), on: true, backJumps: 0, skips: 0, dir: 0 };
  // what is at the top of the view, as a place in the conversation: reading up it only ever goes back in time, so a
  // step the other way (a row newer than the last one, or the same row moving up the screen) is the view jumping
  const box = el.getBoundingClientRect();
  let lastId = null, lastTop = 0;
  const watch = () => {
    const r = w.__rec; if (!r.dir) return;
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 24)?.closest('[data-message-id]');
    if (!hit) return;
    const id = hit.getAttribute('data-message-id'); const top = hit.getBoundingClientRect().top;
    if (lastId) {
      const ids = B.getState().convo[tid]?.ids ?? [];
      const a = ids.indexOf(lastId), b = ids.indexOf(id);
      const back = id === lastId ? (top - lastTop) * r.dir > 40 : a >= 0 && b >= 0 && (b - a) * r.dir < 0;
      if (back) r.backJumps++;
      // more than a few rows past in one frame: rows went by unseen (drawn without the view kept in place)
      if (a >= 0 && b >= 0 && (b - a) * r.dir > 8) r.skips++;
    }
    lastId = id; lastTop = top;
  };
  new PerformanceObserver((l) => { if (w.__rec.on) for (const e of l.getEntries()) w.__rec.loaf.push({ d: e.duration, s: e.scripts.reduce((n, x) => n + x.duration, 0) }); }).observe({ type: 'long-animation-frame' });
  let last = 0;
  const frame = (t) => {
    const r = w.__rec;
    if (!r.on) return;
    if (last) r.frames.push(t - last);
    const dt = last ? t - last : 0; last = t;
    const top = el.scrollTop <= 2;
    if (top && more()) { if (!r.atTop) r.stalls++; r.atTop = true; r.stalled += dt; }
    else r.atTop = false;
    if (top && !more() && !r.done) { r.done = true; r.topAt = t - r.t0; }
    watch();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  w.__recInfo = () => ({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, rows: el.querySelectorAll('[data-message-id]').length, ids: B.getState().convo[tid]?.ids.length ?? 0, nodes: document.getElementsByTagName('*').length });
  return true;
})()`;
const TAKE = `(() => { const r = window.__rec; r.on = false; const backJumps = r.backJumps, skips = r.skips; const f = r.frames, a = r.loaf; const s = [...f].sort((x, y) => x - y);
  return { ms: performance.now() - r.t0, topAt: r.topAt, done: r.done, stalledMs: r.stalled, stalls: r.stalls, frames: f.length,
    slowFrames: f.filter((d) => d > 34).length, worstFrameMs: Math.max(0, ...f), p95FrameMs: s[Math.floor(s.length * 0.95)] ?? 0,
    loaf: a.length, loafMs: a.reduce((n, x) => n + x.d, 0), loafScriptMs: a.reduce((n, x) => n + x.s, 0), backJumps, skips, info: window.__recInfo() }; })()`;

async function wheel(page, dy, until, maxMs) {
  const t0 = Date.now();
  let next = Date.now();
  for (let n = 1; Date.now() - t0 < maxMs; n++) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 760, y: 420, deltaX: 0, deltaY: dy });
    next += 16;
    const wait = next - Date.now();
    if (wait > 0) await sleep(wait);
    // checked every few events (an eval is a round trip of its own)
    if (n % 4 === 0 && (await page.eval(until))) return true;
  }
  return false;
}

/** The renderer's main-thread time so far (Chrome's own counters, seconds → ms). */
async function cost(page) {
  const { metrics } = await page.send('Performance.getMetrics');
  const v = (n) => (metrics.find((x) => x.name === n)?.value ?? 0) * 1000;
  return { task: v('TaskDuration'), script: v('ScriptDuration'), style: v('RecalcStyleDuration'), layout: v('LayoutDuration') };
}
const since = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, Math.round(b[k] - a[k])]));

const up = [], down = [];
for (let run = 0; run < RUNS; run++) {
  const page = await openPage();
  await page.send('Performance.enable');
  // the page at rest for 10 s first: the main thread's time per second with nothing to do (the rest is scrolling's)
  const r0 = await cost(page); await sleep(10_000); const rest = since(r0, await cost(page));
  await page.eval(RECORDER);
  let c0 = await cost(page);
  await page.eval(`window.__rec.dir = -1`);
  const ok = await wheel(page, -SPEED, `window.__rec.done`, 120_000);
  await sleep(300);
  const u = await page.eval(TAKE);
  u.cost = since(c0, await cost(page));
  u.restPerS = rest.task / 10;
  if (!ok) console.warn(`run ${run + 1}: never reached the top`, u.info);
  up.push(u);
  await page.eval(RECORDER);
  await page.eval(`window.__rec.dir = 1`);
  c0 = await cost(page);
  await wheel(page, SPEED, `(() => { const i = window.__recInfo(); return i.scrollHeight - i.scrollTop - i.clientHeight < 4; })()`, 60_000);
  await sleep(300);
  down.push({ ...(await page.eval(TAKE)), cost: since(c0, await cost(page)) });
  console.log(`run ${run + 1}/${RUNS}: up ${Math.round(u.topAt)} ms (stalled ${Math.round(u.stalledMs)} ms in ${u.stalls}, ${u.backJumps} jumps back, ${u.skips} skips), ${u.slowFrames} slow frames, worst ${r1(u.worstFrameMs)} ms; down ${down.at(-1).slowFrames} slow frames, worst ${r1(down.at(-1).worstFrameMs)} ms; ${u.info.rows} rows, ${u.info.nodes} nodes; at rest ${Math.round(u.restPerS)} ms/s, main thread up ${u.cost.task} ms (script ${u.cost.script}, style ${u.cost.style}, layout ${u.cost.layout}), down ${down.at(-1).cost.task} ms`);
  await page.closeTab();
}

browser.close();
await chrome.stop();
server.close();

const m = (xs, k) => r1(median(xs.map((x) => (typeof k === 'function' ? k(x) : x[k]))) ?? 0);
const report = {
  at: new Date().toISOString(), runs: RUNS, long: LONG, speedPxPer16ms: SPEED,
  median: {
    up: { reachedTop: `${up.filter((x) => x.done).length}/${up.length}`, toTopMs: m(up.filter((x) => x.done), 'topAt'), stalledMs: m(up, 'stalledMs'), stalls: m(up, 'stalls'), backJumps: m(up, 'backJumps'), skips: m(up, 'skips'), slowFrames: m(up, 'slowFrames'), worstFrameMs: m(up, 'worstFrameMs'), p95FrameMs: m(up, 'p95FrameMs'), longAnimationFrames: m(up, 'loaf'), longAnimationFrameMs: m(up, 'loafMs'), loafScriptMs: m(up, 'loafScriptMs'), taskMs: m(up, (x) => x.cost.task), scriptMs: m(up, (x) => x.cost.script), styleMs: m(up, (x) => x.cost.style), layoutMs: m(up, (x) => x.cost.layout) },
    down: { ms: m(down, 'ms'), backJumps: m(down, 'backJumps'), slowFrames: m(down, 'slowFrames'), worstFrameMs: m(down, 'worstFrameMs'), p95FrameMs: m(down, 'p95FrameMs'), longAnimationFrames: m(down, 'loaf'), longAnimationFrameMs: m(down, 'loafMs'), loafScriptMs: m(down, 'loafScriptMs'), taskMs: m(down, (x) => x.cost.task), scriptMs: m(down, (x) => x.cost.script), styleMs: m(down, (x) => x.cost.style), layoutMs: m(down, (x) => x.cost.layout) },
    restTaskMsPerS: m(up, 'restPerS'), rows: m(up, (x) => x.info.rows), domNodes: m(up, (x) => x.info.nodes),
  },
  up, down,
};
console.log(JSON.stringify(report.median, null, 2));
const json = opt('--json');
if (json) writeFileSync(json, JSON.stringify(report, null, 2));
if (!args.includes('--keep-build')) rmSync(OUT, { recursive: true, force: true });
process.exit(0);
