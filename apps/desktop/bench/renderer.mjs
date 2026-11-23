// Renderer bench: the renderer built for production in mock mode (VITE_APPUBOT_MOCK=1: the in-memory gateway of
// src/renderer/src/dev, no Electron), served on 127.0.0.1 and driven in headless Chrome over the DevTools protocol.
//
//   node bench/renderer.mjs [--runs 5] [--json out.json] [--port 5299] [--no-build]
//
// Scenarios (each on a fresh page; `?long=600` puts 600 messages with code blocks, tables and tool calls before
// Appu's main chat, `?bench=1` adds window.__appubotBench, dev/mockBench.ts):
//   bundle eval    navigation start → the bundle evaluated (appubot:bundle-evaluated)
//   load blocking  long tasks from the first script until the long chat has settled (its code blocks highlighted):
//                  total blocking time (each task's time past 50ms) and the longest task
//   open thread    switching to the long chat, its history already in memory → painted (the 80-row window)
//   render all     all 600 messages drawn at once (⌘F's "every loaded message") → painted
//   switch bots    Appu ⇄ Ledger, median of 10 switches → painted
//   settings       Settings opened, first time and again → painted
//   streaming      a 1200-token reply at 100 tokens/s into the long chat: frames, long animation frames, script time,
//                  React commits and component renders (render counter: a non-minified build), and the latency of
//                  keys typed into the composer meanwhile (keydown → the next frame)
//   heap           JS heap after the 600 messages are drawn (after a GC)
// "→ painted" is the second animation frame after the action (React has committed and the frame was drawn).
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, launchChrome, sleep, waitFor } from './lib/cdp.mjs';
import { median } from './lib/procs.mjs';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(DESKTOP, 'src/renderer');
const OUT = join(DESKTOP, 'bench/.out');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const RUNS = Number(opt('--runs', '5'));
const PORT = Number(opt('--port', '5299'));
const LONG = 600;

async function buildMock(dir, minify) {
  await build({
    root: ROOT, logLevel: 'error', configFile: false, base: './',
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': join(ROOT, 'src') } },
    define: { 'import.meta.env.VITE_APPUBOT_MOCK': JSON.stringify('1') },
    build: { outDir: dir, emptyOutDir: true, minify, reportCompressedSize: false, chunkSizeWarningLimit: 1e9 },
  });
}
if (!args.includes('--no-build')) {
  await buildMock(join(OUT, 'mock'), true);
  await buildMock(join(OUT, 'mock-names'), false);
}

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.jpg': 'image/jpeg' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = join(OUT, decodeURIComponent(url.pathname));
  if (!file.startsWith(OUT) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const counter = readFileSync(join(DESKTOP, 'bench/lib/renderCounter.js'), 'utf8');

const chrome = await launchChrome();
const browser = await Cdp.attach((await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json()).webSocketDebuggerUrl);

/** A fresh tab on the mock app; resolves once the chat on screen has painted. */
async function openPage(query, { names = false } = {}) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const list = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
  const page = await Cdp.attach(list.find((t) => t.id === targetId).webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  if (names) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: counter });
  // every long task from the first script on (the load's total blocking time)
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__longTasks = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longTasks.push(e.duration); }).observe({ type: 'longtask', buffered: true });` });
  await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/${names ? 'mock-names' : 'mock'}/index.html?theme=dark&bench=1&${query}` });
  await waitFor(() => page.eval(`!!window.__appubotBench && document.querySelectorAll('[data-message-id]').length > 0`), { what: 'the chat', timeout: 30_000 });
  await sleep(1200);
  page.closeTab = async () => { page.close(); await browser.send('Target.closeTarget', { targetId }); };
  return page;
}

/** Runs `action` (an expression) in the page and resolves with ms until the second frame after it. */
const PAINTED = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`;
const timed = (page, action) => page.eval(`(async () => { const B = window.__appubotBench; const t0 = performance.now(); ${action}; await ${PAINTED}; return performance.now() - t0; })()`);
const r1 = (x) => Math.round(x * 10) / 10;

const results = { loadTbtMs: [], loadLongestTaskMs: [], bundleEvalMs: [], openThreadMs: [], renderAllMs: [], switchBotMs: [], settingsFirstMs: [], settingsAgainMs: [], heapMB: [], domNodes: [] };
const streaming = [];

for (let run = 0; run < RUNS; run++) {
  // first-load, open the long chat, render all of it, heap
  {
    const page = await openPage(`long=${LONG}&bot=bot_ledger`);
    results.bundleEvalMs.push(r1(await page.eval(`performance.getEntriesByName('appubot:bundle-evaluated')[0]?.startTime ?? -1`)));
    // load Appu's long chat once (its history pages), then go back to Ledger: the measured open has it in memory
    await page.eval(`(async () => { const B = window.__appubotBench; B.openBot('bot_appu'); await new Promise((r) => setTimeout(r, 1500)); })()`);
    await page.eval(`(async () => { const B = window.__appubotBench; B.openBot('bot_ledger'); await new Promise((r) => setTimeout(r, 800)); })()`);
    results.openThreadMs.push(r1(await timed(page, `B.openBot('bot_appu')`)));
    await sleep(800);
    // every message of the long chat in memory, then all of it drawn
    await page.eval(`(async () => {
      const B = window.__appubotBench; const s = B.getState(); const id = s.selectedThreadId;
      const page = await B.rpc('threads.history', { id, limit: 1000 });
      B.mergeConversation(id, page.messages, { hasMore: false });
      await new Promise((r) => setTimeout(r, 500));
    })()`);
    results.renderAllMs.push(r1(await timed(page, `window.dispatchEvent(new CustomEvent('appubot:transcript-find', { detail: { threadId: B.getState().selectedThreadId, all: true } }))`)));
    await sleep(1000);
    results.domNodes.push(await page.eval(`document.getElementsByTagName('*').length`));
    await page.send('HeapProfiler.collectGarbage');
    results.heapMB.push(r1((await page.send('Runtime.getHeapUsage')).usedSize / 1048576));
    await page.closeTab();
  }
  // the load's blocking time (the long chat on screen, its code blocks highlighted), switching bots and Settings
  {
    const page = await openPage(`long=${LONG}`);
    await sleep(1500);
    const tasks = await page.eval(`window.__longTasks`);
    results.loadTbtMs.push(Math.round(tasks.reduce((n, d) => n + Math.max(0, d - 50), 0)));
    results.loadLongestTaskMs.push(Math.round(Math.max(0, ...tasks)));
    const sw = [];
    for (let i = 0; i < 10; i++) {
      sw.push(await timed(page, `B.openBot('${i % 2 ? 'bot_appu' : 'bot_ledger'}')`));
      await sleep(400);
    }
    results.switchBotMs.push(r1(median(sw)));
    results.settingsFirstMs.push(r1(await timed(page, `B.ui.openSettings('general'); await new Promise((r) => { const f = () => document.querySelector('[role=dialog]') ? r() : requestAnimationFrame(f); f(); })`)));
    await sleep(500);
    await page.eval(`window.__appubotBench.ui.closeSettings?.() ?? window.__appubotBench.setState({ settingsSection: null })`);
    await sleep(500);
    results.settingsAgainMs.push(r1(await timed(page, `B.ui.openSettings('general'); await new Promise((r) => { const f = () => document.querySelector('[role=dialog]') ? r() : requestAnimationFrame(f); f(); })`)));
    await page.closeTab();
  }
  // streaming into the long chat, with typing; render counts on the non-minified build
  {
    const page = await openPage(`long=${LONG}`, { names: true });
    await sleep(500);
    await page.eval(`(() => {
      const w = window; w.__lat = []; w.__frames = []; w.__loaf = [];
      new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__loaf.push({ d: e.duration, s: e.scripts.reduce((n, x) => n + x.duration, 0), b: e.blockingDuration }); }).observe({ type: 'long-animation-frame' });
      let last = 0; const frame = (t) => { if (w.__measure) { if (last) w.__frames.push(t - last); last = t; } else last = 0; requestAnimationFrame(frame); }; requestAnimationFrame(frame);
      addEventListener('keydown', (e) => { if (!w.__measure) return; const t0 = e.timeStamp; requestAnimationFrame(() => w.__lat.push(performance.now() - t0)); }, true);
      const ed = document.querySelector('[data-support-avoid] [contenteditable="true"], [data-support-avoid] textarea, [contenteditable="true"], textarea');
      ed.focus(); return !!ed;
    })()`);
    await page.eval(`window.__renderCounts.take(); window.__loaf.length = 0; window.__measure = true;`);
    const t0 = Date.now();
    const done = page.eval(`window.__appubotBench.stream({ tokens: 1200, tps: 100 })`);
    const keys = 'the quick brown fox jumps over the lazy dog '.repeat(4);
    let k = 0;
    await sleep(500);
    while (Date.now() - t0 < 11_000 && k < keys.length) {
      const ch = keys[k++];
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch, code: ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}` });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}` });
      await sleep(80);
    }
    const streamed = await done;
    const out = await page.eval(`(() => { window.__measure = false; const f = window.__frames, l = window.__lat, a = window.__loaf;
      return { frames: f.length, slowFrames: f.filter((d) => d > 34).length, worstFrameMs: Math.max(...f), lat: l, loaf: a.length, loafMs: a.reduce((n, x) => n + x.d, 0), loafScriptMs: a.reduce((n, x) => n + x.s, 0), loafBlockingMs: a.reduce((n, x) => n + x.b, 0), counts: window.__renderCounts.take() }; })()`);
    const lat = [...out.lat].sort((a, b) => a - b);
    const typed = await page.eval(`(document.querySelector('[contenteditable="true"]')?.textContent ?? document.querySelector('textarea')?.value ?? '').length`);
    streaming.push({
      streamMs: Math.round(streamed.ms), frames: out.frames, slowFrames: out.slowFrames, worstFrameMs: r1(out.worstFrameMs),
      longAnimationFrames: out.loaf, longAnimationFrameMs: Math.round(out.loafMs), loafScriptMs: Math.round(out.loafScriptMs), loafBlockingMs: Math.round(out.loafBlockingMs),
      keyLatencyP50: r1(lat[lat.length >> 1] ?? 0), keyLatencyP95: r1(lat[Math.floor(lat.length * 0.95)] ?? 0), keyLatencyMax: r1(lat.at(-1) ?? 0), keys: lat.length, typed,
      commits: out.counts.commits, renders: out.counts.renders, topRenders: out.counts.top.slice(0, 40), owners: out.counts.owners,
    });
    await page.closeTab();
  }
  console.log(`run ${run + 1}/${RUNS} done`);
}

browser.close();
await chrome.stop();
server.close();

const med = (k) => r1(median(results[k]) ?? 0);
const sm = (k) => r1(median(streaming.map((s) => s[k])) ?? 0);
const report = {
  at: new Date().toISOString(), runs: RUNS, long: LONG,
  median: {
    loadTbtMs: med('loadTbtMs'), loadLongestTaskMs: med('loadLongestTaskMs'), bundleEvalMs: med('bundleEvalMs'), openThreadMs: med('openThreadMs'), renderAllMs: med('renderAllMs'), switchBotMs: med('switchBotMs'),
    settingsFirstMs: med('settingsFirstMs'), settingsAgainMs: med('settingsAgainMs'), heapMB: med('heapMB'), domNodes: med('domNodes'),
    stream: Object.fromEntries(['frames', 'slowFrames', 'worstFrameMs', 'longAnimationFrames', 'longAnimationFrameMs', 'loafScriptMs', 'loafBlockingMs', 'keyLatencyP50', 'keyLatencyP95', 'keyLatencyMax', 'commits', 'renders'].map((k) => [k, sm(k)])),
  },
  all: results,
  streaming,
};
console.log(JSON.stringify(report.median, null, 2));
console.log('top renders while streaming (last run):', streaming.at(-1).topRenders.map(([n, c]) => `${n}×${c}`).join(', '));
console.log('drawn by (last run):', streaming.at(-1).owners.slice(0, 20).map(([n, c]) => `${n} ×${c}`).join(', '));
const json = opt('--json');
if (json) writeFileSync(json, JSON.stringify(report, null, 2));
if (!args.includes('--keep-build')) rmSync(OUT, { recursive: true, force: true });
process.exit(0);
