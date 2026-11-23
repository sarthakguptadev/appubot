// A before/after table of two results files (bench/results/<label>.json), as Markdown.
//
//   node bench/compare.mjs before after
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = dirname(fileURLToPath(import.meta.url));
const [a, b] = process.argv.slice(2).map((l) => JSON.parse(readFileSync(join(BENCH, 'results', `${l}.json`), 'utf8')));
const get = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const kb = (n) => (n == null ? '-' : `${(n / 1024).toFixed(0)} KB`);
const num = (n, unit = '') => (n == null ? '-' : `${n}${unit}`);

const ROWS = [
  ['Bundle', 'initial JS (minified)', 'bundle.initial.js', kb],
  ['Bundle', 'initial JS (gzip)', 'bundle.initial.jsGzip', kb],
  ['Bundle', 'initial CSS', 'bundle.initial.css', kb],
  ['Startup (cold, median)', 'window created', 'startup.first.main:window-created', (n) => num(n, ' ms')],
  ['Startup (cold, median)', 'first paint', 'startup.first.first-paint', (n) => num(n, ' ms')],
  ['Startup (cold, median)', 'chat painted (interactive)', 'startup.first.appubot:transcript-painted', (n) => num(n, ' ms')],
  ['Startup (warm, median)', 'main module loaded', 'startup.warmMedian.main:module', (n) => num(n, ' ms')],
  ['Startup (warm, median)', 'core started', 'startup.warmMedian.core:started', (n) => num(n, ' ms')],
  ['Startup (warm, median)', 'window created', 'startup.warmMedian.main:window-created', (n) => num(n, ' ms')],
  ['Startup (warm, median)', 'bundle evaluated', 'startup.warmMedian.appubot:bundle-evaluated', (n) => num(n, ' ms')],
  ['Startup (warm, median)', 'first paint', 'startup.warmMedian.first-paint', (n) => num(n, ' ms')],
  ['Startup (warm, median)', 'snapshot in (hydrated)', 'startup.warmMedian.appubot:hydrated', (n) => num(n, ' ms')],
  ['Startup (warm, median)', 'main layout painted', 'startup.warmMedian.appubot:main-painted', (n) => num(n, ' ms')],
  ['Startup (warm, median)', 'chat painted (interactive)', 'startup.warmMedian.appubot:transcript-painted', (n) => num(n, ' ms')],
  ['Idle', 'CPU, all processes', 'startup.idle.cpuPct.total', (n) => num(n, '%')],
  ['Idle', 'CPU, renderer', 'startup.idle.cpuPct.renderer', (n) => num(n, '%')],
  ['Idle', 'CPU, GPU process', 'startup.idle.cpuPct.gpu', (n) => num(n, '%')],
  ['Idle', 'CPU, main', 'startup.idle.cpuPct.main', (n) => num(n, '%')],
  ['Idle, Reduce motion', 'CPU, all processes', 'startup.idleReducedMotion.cpuPct.total', (n) => num(n, '%')],
  ['Idle, Reduce motion', 'CPU, renderer', 'startup.idleReducedMotion.cpuPct.renderer', (n) => num(n, '%')],
  ['Memory', 'RSS total, idle', 'startup.idle.rssMB.total', (n) => num(n, ' MB')],
  ['Memory', 'RSS main, idle', 'startup.idle.rssMB.main', (n) => num(n, ' MB')],
  ['Memory', 'RSS renderer, idle', 'startup.idle.rssMB.renderer', (n) => num(n, ' MB')],
  ['Memory', 'RSS renderer, 600 messages drawn', 'startup.longThread.rssMB.renderer', (n) => num(n, ' MB')],
  ['Memory', 'JS heap, 600 messages drawn', 'startup.longThread.rendererHeapMB', (n) => num(n, ' MB')],
  ['Renderer (mock, median)', 'load: total blocking time', 'renderer.median.loadTbtMs', (n) => num(n, ' ms')],
  ['Renderer (mock, median)', 'load: longest task', 'renderer.median.loadLongestTaskMs', (n) => num(n, ' ms')],
  ['Renderer (mock, median)', 'bundle evaluated', 'renderer.median.bundleEvalMs', (n) => num(n, ' ms')],
  ['Renderer (mock, median)', 'open long chat', 'renderer.median.openThreadMs', (n) => num(n, ' ms')],
  ['Renderer (mock, median)', 'draw all 600 messages', 'renderer.median.renderAllMs', (n) => num(n, ' ms')],
  ['Renderer (mock, median)', 'switch bots', 'renderer.median.switchBotMs', (n) => num(n, ' ms')],
  ['Renderer (mock, median)', 'open Settings (first)', 'renderer.median.settingsFirstMs', (n) => num(n, ' ms')],
  ['Renderer (mock, median)', 'open Settings (again)', 'renderer.median.settingsAgainMs', (n) => num(n, ' ms')],
  ['Renderer (mock, median)', 'JS heap, 600 messages drawn', 'renderer.median.heapMB', (n) => num(n, ' MB')],
  ['Streaming 1200 tokens', 'React commits', 'renderer.median.stream.commits', num],
  ['Streaming 1200 tokens', 'component renders', 'renderer.median.stream.renders', num],
  ['Streaming 1200 tokens', 'frames over 34 ms', 'renderer.median.stream.slowFrames', num],
  ['Streaming 1200 tokens', 'long animation frames', 'renderer.median.stream.longAnimationFrames', num],
  ['Streaming 1200 tokens', 'key → frame p50', 'renderer.median.stream.keyLatencyP50', (n) => num(n, ' ms')],
  ['Streaming 1200 tokens', 'key → frame p95', 'renderer.median.stream.keyLatencyP95', (n) => num(n, ' ms')],
  ['Scroll up a 600-message chat (mock)', 'runs that reached its start', 'scroll.median.up.reachedTop', (n) => n ?? '-'],
  ['Scroll up a 600-message chat (mock)', 'time stuck at the top waiting', 'scroll.median.up.stalledMs', (n) => num(n, ' ms')],
  ['Scroll up a 600-message chat (mock)', 'view jumps (back / skipped rows)', 'scroll.median.up', (u) => (u ? `${u.backJumps} / ${u.skips}` : '-')],
  ['Scroll up a 600-message chat (mock)', 'frames over 34 ms', 'scroll.median.up.slowFrames', num],
  ['Scroll up a 600-message chat (mock)', 'worst frame', 'scroll.median.up.worstFrameMs', (n) => num(n, ' ms')],
  ['Scroll up a 600-message chat (mock)', 'main-thread time', 'scroll.median.up.taskMs', (n) => num(n, ' ms')],
  ['Scroll down, all drawn (mock)', 'frames over 34 ms', 'scroll.median.down.slowFrames', num],
  ['Scroll down, all drawn (mock)', 'main-thread time', 'scroll.median.down.taskMs', (n) => num(n, ' ms')],
  ['Scroll (mock)', 'main thread at rest', 'scroll.median.restTaskMsPerS', (n) => num(n, ' ms/s')],
];

console.log(`| Area | Metric | ${a.label} (${a.commit}) | ${b.label} (${b.commit}) |`);
console.log('| --- | --- | ---: | ---: |');
for (const [area, metric, path, fmt] of ROWS) console.log(`| ${area} | ${metric} | ${fmt(get(a, path))} | ${fmt(get(b, path))} |`);
