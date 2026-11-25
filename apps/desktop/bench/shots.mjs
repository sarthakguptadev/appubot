// Screenshots of the real renderer for films and posts: the renderer built in mock mode (VITE_APPUBOT_MOCK=1, the
// in-memory gateway of src/renderer/src/dev, no Electron, as renderer.mjs builds it), served on 127.0.0.1 and shot in
// headless Chrome at 2x.
//
//   node bench/shots.mjs <out dir> <name>=<query>[@<lang>][|<js>] … [--size 1440x900] [--no-build] [--wait 1800]
//
// `--keep-dialogs` leaves a first-run screen (the cloud computer's welcome) up instead of putting it away.
//
// `query` is the mocks' own (`theme=dark&settings=usage`, `forms=1`, `cloud=running&on=cloud&panel=computer`…),
// `@ja` sets the interface language first (localStorage `appubot:language`). Writes <out dir>/<name>.png.
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, launchChrome, sleep } from './lib/cdp.mjs';
import { serveDir } from './lib/serve.mjs';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(DESKTOP, 'src/renderer');
const OUT = join(DESKTOP, 'bench/.out');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const flags = new Set(['--size', '--wait', '--port']);
const pos = args.filter((a, i) => !a.startsWith('--') && !flags.has(args[i - 1]));
const [outDir, ...specs] = pos;
if (!outDir || specs.length === 0) throw new Error('usage: node bench/shots.mjs <out dir> <name>=<query>[@lang] …');
const [W, H] = opt('--size', '1440x900').split('x').map(Number);
const WAIT = Number(opt('--wait', '1800'));
const PORT = Number(opt('--port', '5298'));
mkdirSync(outDir, { recursive: true });

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

const chrome = await launchChrome({ width: W, height: H });
const browser = await Cdp.attach((await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json()).webSocketDebuggerUrl);

for (const spec of specs) {
  const eq = spec.indexOf('=');
  const name = spec.slice(0, eq);
  let query = spec.slice(eq + 1);
  // `|<js>` after the query runs in the page before the shot (typing into a field, opening a menu)
  let js = null;
  const bar = query.indexOf('|');
  if (bar >= 0) { js = query.slice(bar + 1); query = query.slice(0, bar); }
  let lang = null;
  const at = query.lastIndexOf('@');
  if (at >= 0) { lang = query.slice(at + 1); query = query.slice(0, at); }
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const list = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
  const page = await Cdp.attach(list.find((t) => t.id === targetId).webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  // a clean frame: this shot's language (English unless named), no support bubble
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('appubot:language', ${JSON.stringify(lang ?? 'en')}); } catch {}
    document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '[aria-label^="Chat with Sarthak"], [aria-label="Close chat"] { display: none !important; }'; document.head.appendChild(s); });` });
  await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/mock/index.html?${query}` });
  await sleep(WAIT);
  // first-run screens (the cloud computer's welcome) put away as a person would
  const dismissed = !args.includes('--keep-dialogs') && await page.eval(`(() => { const b = document.querySelector('[aria-label="Your cloud computer"] button[aria-label="Close"]') ?? [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Got it'); if (b) { b.click(); return true; } return false; })()`);
  if (dismissed) await sleep(700);
  if (js) { await page.eval(`(async () => { ${js} })()`); await sleep(900); }
  const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(shot.data, 'base64'));
  console.log(`${name.padEnd(14)} ${query}${lang ? ` @${lang}` : ''}`);
  page.close();
  await browser.send('Target.closeTarget', { targetId });
}
browser.close();
await chrome.stop();
server.close();
