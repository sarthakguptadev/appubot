// The group room, taken apart for films: the real renderer in mock mode (`?groups=film`, the build shots.mjs made in
// bench/.out/mock) shot as an empty window (frame.png: the conversation and the goal card hidden), as it is
// (full.png) and on a tall page (tall.png: every message at once), with each piece's place in parts.json, so a film can
// put the real messages back one by one.
//
//   node bench/room-parts.mjs <out dir> [--theme light|dark] [--size 1080x680] [--query <extra mock query>]
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, launchChrome, sleep } from './lib/cdp.mjs';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(DESKTOP, 'bench/.out');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const outDir = args[0];
if (!outDir || outDir.startsWith('--')) throw new Error('usage: node bench/room-parts.mjs <out dir> [--theme light] [--size 1080x680]');
if (!existsSync(join(OUT, 'mock/index.html'))) throw new Error('no mock build yet: run bench/shots.mjs once');
const theme = opt('--theme', 'light');
const extra = opt('--query', '');
const [W, H] = opt('--size', '1080x680').split('x').map(Number);
const TALL = 1900;
const PORT = 5297;
mkdirSync(outDir, { recursive: true });

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.json': 'application/json' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = join(OUT, decodeURIComponent(url.pathname));
  if (!file.startsWith(OUT) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const chrome = await launchChrome({ width: W, height: TALL });
const browser = await Cdp.attach((await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json()).webSocketDebuggerUrl);

async function open(height) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const list = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
  const page = await Cdp.attach(list.find((t) => t.id === targetId).webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: W, height, deviceScaleFactor: 2, mobile: false });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('appubot:language', 'en'); } catch {}
    document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '[aria-label^="Chat with Sarthak"], [aria-label="Close chat"] { display: none !important; } ::-webkit-scrollbar { display: none !important; }'; document.head.appendChild(s); });` });
  await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/mock/index.html?theme=${theme}&groups=film${extra ? `&${extra}` : ''}` });
  await sleep(2200);
  return { page, targetId };
}
const shot = async (page, name) => writeFileSync(join(outDir, name), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
// the room's own pieces, found by what they are: the 46rem column of messages, the composer's column with the goal card
const FIND = `
  const rect = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const col = [...document.querySelectorAll('div')].find((d) => typeof d.className === 'string' && d.className.includes('max-w-[46rem]') && d.className.includes('pt-4'));
  const dock = document.querySelector('[data-support-avoid]');
  const goal = dock && dock.children.length > 1 ? dock.children[0] : null;
`;

// the window as it is, then with the conversation and the goal taken out
const a = await open(H);
const frame = JSON.parse(await a.page.eval(`(() => { ${FIND}
  return JSON.stringify({ area: rect(col.parentElement), column: rect(col), goal: goal ? rect(goal) : null, dock: rect(dock) }); })()`));
await shot(a.page, 'full.png');
await a.page.eval(`(() => { ${FIND} col.style.visibility = 'hidden'; if (goal) goal.style.visibility = 'hidden'; })()`);
await sleep(300);
await shot(a.page, 'frame.png');
await browser.send('Target.closeTarget', { targetId: a.targetId });

// every message at once
const b = await open(TALL);
const tall = JSON.parse(await b.page.eval(`(() => { ${FIND}
  return JSON.stringify({ column: rect(col), rows: [...col.children].map((c) => ({ ...rect(c), text: c.textContent.trim().slice(0, 60) })) }); })()`));
await shot(b.page, 'tall.png');
await browser.send('Target.closeTarget', { targetId: b.targetId });

writeFileSync(join(outDir, 'parts.json'), JSON.stringify({ theme, size: [W, H], tallSize: [W, TALL], ...frame, tall }, null, 2) + '\n');
console.log(`${outDir}: ${tall.rows.length} rows`);
for (const r of tall.rows) console.log(`  ${String(Math.round(r.y)).padStart(5)} ${String(Math.round(r.h)).padStart(4)}  ${r.text}`);
browser.close();
await chrome.stop();
server.close();
