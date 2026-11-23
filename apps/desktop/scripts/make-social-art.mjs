/**
 * The X (Twitter) account's pictures, drawn from the app icon ("Orange tile", resources/icon.svg) and chat-core's avatars:
 * - `x-avatar-v2.png`, 1000×1000 (X shows it as a circle, 400×400 at most): the icon's face on its orange, edge to edge.
 *   (`x-avatar.png` is the round bot from before the Orange tile; nothing writes it any more.)
 * - `x-banner.png`, 3000×1000 (X's 1500×500 at 2x): "Meet [icon] AppuBot" on the site's #0a0a0a, the crew (flat, as
 *   chat-core draws bots now) peeking up from the bottom right. X lays the profile picture over the banner's bottom left and crops its top and bottom a
 *   little on wide screens, so the words sit in the middle and nothing important is down at the left.
 * Electron renders the pages (the app's own Instrument Sans), so run it with Electron:
 *   npx electron scripts/make-social-art.mjs [--out <dir>]   (default: design/social at the repo root)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const resources = join(here, '..', 'resources');
const require = createRequire(import.meta.url);
const font = pathToFileURL(join(dirname(require.resolve('@fontsource-variable/instrument-sans/package.json')), 'files', 'instrument-sans-latin-wght-normal.woff2')).href;

const svgUrl = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
const ICON = readFileSync(join(resources, 'icon.svg'), 'utf8');

/** the app icon as it is, cut to its tile (824px on the 1024 grid, from 100,100) */
const tileSvg = () => svgUrl(ICON.replace('viewBox="0 0 1024 1024"', 'viewBox="100 100 824 824"'));

/** the icon's face on its orange with no tile outline: the face in tile units, the tile being the whole picture */
function faceSvg() {
  const defs = ICON.match(/<defs>[^]*<\/defs>/)?.[0] ?? '';
  const face = ICON.match(/<g transform="translate\(100 100\) scale\([\d.]+\)">([^]*)<\/g><\/svg>/)?.[1];
  if (!face) throw new Error('icon.svg has no face group: run scripts/make-icon.mjs first');
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${defs}<rect width="1024" height="1024" fill="url(#tile)"/>${face}</svg>`);
}

/** chat-core's avatars for the crew, without their tinted square (botAvatarSvg is TypeScript: tsx reads it) */
function crew(list) {
  const code = `import { botAvatarSvg } from './packages/chat-core/src/botAvatar.ts';
console.log(JSON.stringify(${JSON.stringify(list)}.map(([s, c]) => botAvatarSvg(s, c, 600).replace('<rect width="100" height="100" fill="url(#bg)"/>', '').replace('translate(15 15) scale(0.7)', 'translate(2 2) scale(0.96)'))));`;
  const out = execFileSync('npx', ['tsx', '-e', code], { cwd: root, encoding: 'utf8' });
  return JSON.parse(out).map(svgUrl);
}

const page = (w, h, body, zoom = 1) => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: 'Instrument Sans'; src: url('${font}') format('woff2'); font-weight: 400 700; }
html, body { margin: 0; }
body { width: ${w}px; height: ${h}px; overflow: hidden; zoom: ${zoom}; position: relative; background: #0a0a0a; font-family: 'Instrument Sans', -apple-system, sans-serif; color: #fff; -webkit-font-smoothing: antialiased; }
.abs { position: absolute; }
</style></head><body>${body}</body></html>`;

/* ---------- profile picture: the icon's orange edge to edge, its face inside the circle X cuts ---------- */
const AVATAR = { w: 400, h: 400 };
const avatarBody = `<img class="abs" src="${faceSvg()}" style="inset:0; width:400px; height:400px">`;

/* ---------- banner ---------- */
const BANNER = { w: 1500, h: 500 };
const GRAIN = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .5 0"/></filter><rect width="240" height="240" filter="url(#n)"/></svg>').toString('base64')}`;

/** [shape, colour, left, size, how far it rises, tilt]: the palette's bots along the bottom, clear of the avatar */
const CREW = [
  ['square', '#2E8EFF', 455, 118, 96, -8],
  ['drop', '#16C47A', 600, 104, 92, 5],
  ['pill', '#9A68FF', 735, 128, 100, -4],
  ['hex', '#FFA826', 895, 110, 94, 7],
  ['cloud', '#1FBFAE', 1035, 124, 98, -5],
  ['triangle', '#FF4FA8', 1190, 112, 92, 6],
  ['squircle', '#FF4A5A', 1330, 120, 98, -6],
];

function bannerBody(pictures) {
  const bots = CREW.map(([, , left, size, rise, tilt], i) =>
    `<img class="abs" src="${pictures[i]}" style="left:${left}px; top:${BANNER.h - rise}px; width:${size}px; height:${size}px; transform:rotate(${tilt}deg); filter:drop-shadow(0 -6px 18px rgba(0,0,0,.5))">`).join('');
  return `
<div class="abs" style="inset:0; background:radial-gradient(55% 75% at 50% 38%, rgba(247,131,30,.13), transparent 70%)"></div>
<div class="abs" style="inset:0; background:url('${GRAIN}'); opacity:.05"></div>
<div class="abs" style="left:0; right:0; top:118px; display:flex; justify-content:center; align-items:center; gap:22px; font-size:92px; font-weight:600; letter-spacing:-2.2px; line-height:1">
  <span>Meet</span><img src="${tileSvg()}" style="width:98px; height:98px; transform:translateY(4px); filter:drop-shadow(0 10px 24px rgba(0,0,0,.5))"><span>AppuBot</span>
</div>
<div class="abs" style="left:0; right:0; top:240px; text-align:center; font-size:29px; font-weight:450; letter-spacing:-.2px; color:#a3a7ad">AI teammates that use your apps for you.</div>
<div class="abs" style="left:0; right:0; top:296px; text-align:center; font-size:19px; font-weight:550; letter-spacing:.2px; color:#F7831E">appubot.com</div>
<div class="abs" style="left:0; right:0; bottom:0; height:80px; background:linear-gradient(180deg, transparent, rgba(10,10,10,.35))"></div>
${bots}`;
}

/* ---------- rendering ---------- */
const work = mkdtempSync(join(tmpdir(), 'appubot-social-art-'));
let n = 0;

async function render(w, h, body, scale = 1) {
  const file = join(work, `page-${n++}.html`);
  writeFileSync(file, page(w, h, body, scale));
  const win = new BrowserWindow({ show: false, width: w * scale, height: h * scale, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadFile(file);
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {})))).then(() => true)');
  await new Promise((r) => setTimeout(r, 200));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: w * scale, height: h * scale });
  win.destroy();
  return image.getSize().width === w * scale ? image : image.resize({ width: w * scale, height: h * scale, quality: 'best' });
}

app.dock?.hide();
app.on('window-all-closed', () => {});
void app.whenReady().then(main).catch((e) => {
  console.error(e);
  process.exitCode = 1;
  app.quit();
});

async function main() {
try {
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : join(root, 'design', 'social');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'x-avatar-v2.png'), (await render(AVATAR.w, AVATAR.h, avatarBody, 2.5)).toPNG());
  const banner = bannerBody(crew(CREW.map(([s, c]) => [s, c])));
  writeFileSync(join(out, 'x-banner.png'), (await render(BANNER.w, BANNER.h, banner, 2)).toPNG());
  // how X shows them: the avatar cut round and laid over the banner's bottom left
  const avatarUrl = `data:image/png;base64,${readFileSync(join(out, 'x-avatar-v2.png')).toString('base64')}`;
  const bannerUrl = `data:image/png;base64,${readFileSync(join(out, 'x-banner.png')).toString('base64')}`;
  const mock = `<div class="abs" style="inset:0; background:#000"></div>
<img class="abs" src="${bannerUrl}" style="left:0; top:0; width:600px; height:200px">
<img class="abs" src="${avatarUrl}" style="left:16px; top:134px; width:134px; height:134px; border-radius:50%; border:4px solid #000">
<div class="abs" style="left:16px; top:282px; font-size:20px; font-weight:700">AppuBot</div>
<div class="abs" style="left:16px; top:308px; font-size:15px; color:#71767b">@AppuBot_</div>`;
  writeFileSync(join(out, 'x-profile-preview.png'), (await render(600, 340, mock, 2)).toPNG());
  console.log(`wrote x-avatar-v2.png, x-banner.png and x-profile-preview.png in ${out}`);
} finally {
  rmSync(work, { recursive: true, force: true });
  app.quit();
}
}
