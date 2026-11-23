/**
 * The install screens' art, drawn around the app icon (resources/icon.svg, scripts/make-icon.mjs: the orange tile):
 * - macOS: the window the .dmg opens in, where AppuBot is dragged into Applications (`resources/background.tiff`,
 *   660×400 with its 2x inside). Finder draws the icons' labels black in light mode and white in dark mode, whatever
 *   the picture, so the row they sit on is a warm stone mid-tone both read on (about 4.4:1 for white, 4.8:1 for black),
 *   and the orange icon stands out on it.
 * - Windows: the assisted NSIS installer's left picture on its welcome and finish pages (`installerSidebar.bmp`,
 *   164×314, also the uninstaller's) and the one in its other pages' header (`installerHeader.bmp`, 150×57). NSIS
 *   takes 24-bit BMPs.
 * - Linux has no install screen: an AppImage runs as it is, and a .deb goes through the system's own installer.
 * Electron renders the pages (the app's own Instrument Sans), so run it with Electron:
 *   npx electron scripts/make-installer-art.mjs [--preview <dir>]
 * electron-builder.yml's `dmg` and `nsis` sections name the files; the icon positions there match the picture's.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';

const here = dirname(fileURLToPath(import.meta.url));
const resources = join(here, '..', 'resources');
const require = createRequire(import.meta.url);
const font = pathToFileURL(join(dirname(require.resolve('@fontsource-variable/instrument-sans/package.json')), 'files', 'instrument-sans-latin-wght-normal.woff2')).href;

/** icon.svg on macOS's grid (the tile 824px of 1024, as Finder draws app icons), and framed on the tile alone */
const iconSvg = readFileSync(join(resources, 'icon.svg'), 'utf8');
const ICON = `data:image/svg+xml;base64,${Buffer.from(iconSvg).toString('base64')}`;
const TILE = `data:image/svg+xml;base64,${Buffer.from(iconSvg.replace(/viewBox="[^"]*"/, 'viewBox="100 100 824 824"')).toString('base64')}`;

/** warm stone, light at the top, deepest under the labels: Finder's black and white labels both read on it */
const STONE = 'linear-gradient(180deg, #C9BFB7 0%, #A79B93 42%, #857971 70%, #6A5F59 100%)';
/** the visor's ink, for the Windows installer's sidebar */
const NIGHT = 'linear-gradient(180deg, #232020 0%, #151515 100%)';
const INK = '#1E1713';
const CREAM = '#FFF2E2';

const page = (w, h, body, zoom = 1) => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: 'Instrument Sans'; src: url('${font}') format('woff2'); font-weight: 400 700; }
html, body { margin: 0; }
body { width: ${w}px; height: ${h}px; overflow: hidden; zoom: ${zoom}; position: relative; font-family: 'Instrument Sans', -apple-system, 'Segoe UI', sans-serif; color: ${INK}; -webkit-font-smoothing: antialiased; }
.abs { position: absolute; }
</style></head><body>${body}</body></html>`;

/* ---------- macOS: the .dmg window (Finder draws the two icons at the `dmg.contents` points: 175,215 and 485,215) ---------- */
const DMG = { w: 660, h: 400, left: 175, right: 485, y: 215 };

/** A dotted arc from the app to Applications, its head turned along the arc's end and the dots stopping short of it. */
function dmgArrow() {
  // a gentle rise and a near-level landing, so the head reads as a clean ">"
  const a = [DMG.left + 78, DMG.y + 2];
  const c1 = [DMG.left + 124, DMG.y - 32];
  const c2 = [DMG.right - 116, DMG.y - 16];
  const tip = [DMG.right - 82, DMG.y - 7];
  const len = Math.hypot(tip[0] - c2[0], tip[1] - c2[1]);
  const d = [(tip[0] - c2[0]) / len, (tip[1] - c2[1]) / len];
  const end = [tip[0] - d[0] * 9, tip[1] - d[1] * 9];
  const arm = (deg) => {
    const r = (deg * Math.PI) / 180;
    const [bx, by] = [-d[0], -d[1]];
    return [tip[0] + 13 * (bx * Math.cos(r) - by * Math.sin(r)), tip[1] + 13 * (bx * Math.sin(r) + by * Math.cos(r))];
  };
  const p = (q) => `${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
  const stroke = `fill="none" stroke="${INK}" stroke-opacity=".6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"`;
  return `<svg class="abs" style="left:0; top:0" width="${DMG.w}" height="${DMG.h}" viewBox="0 0 ${DMG.w} ${DMG.h}">
  <path d="M${p(a)} C ${p(c1)}, ${p(c2)}, ${p(end)}" ${stroke} stroke-dasharray="0.1 9"/>
  <path d="M${p(arm(38))} L${p(tip)} L${p(arm(-38))}" ${stroke}/>
</svg>`;
}
const dmgBody = `
<div class="abs" style="inset:0; background:${STONE}"></div>
<div class="abs" style="inset:0; background:radial-gradient(90% 70% at 50% -12%, rgba(255,255,255,.28), transparent 62%)"></div>
<div class="abs" style="left:${DMG.left - 110}px; top:${DMG.y - 110}px; width:220px; height:200px; background:radial-gradient(closest-side, rgba(255,150,60,.22), transparent)"></div>
<div class="abs" style="left:0; right:0; top:46px; text-align:center; font-size:23px; font-weight:650; letter-spacing:-.2px">Drag AppuBot into Applications</div>
<div class="abs" style="left:0; right:0; top:80px; text-align:center; font-size:13.5px; color:rgba(30,23,19,.72)">Then open it from Applications, or with Spotlight.</div>
${dmgArrow()}
<div class="abs" style="left:0; right:0; bottom:20px; text-align:center; font-size:11.5px; font-weight:500; color:rgba(255,244,232,.82)">appubot.com</div>`;

/* ---------- Windows: the installer's sidebar (welcome and finish pages) and its pages' header ---------- */
const SIDEBAR = { w: 164, h: 314 };
const sidebarBody = `
<div class="abs" style="inset:0; background:${NIGHT}"></div>
<div class="abs" style="left:-20px; right:-20px; top:20px; height:170px; background:radial-gradient(closest-side, rgba(247,131,30,.22), transparent)"></div>
<img class="abs" src="${TILE}" style="left:${(SIDEBAR.w - 76) / 2}px; top:62px; width:76px; height:76px; filter:drop-shadow(0 6px 14px rgba(0,0,0,.45))">
<div class="abs" style="left:0; right:0; top:160px; text-align:center; font-size:21px; font-weight:650; letter-spacing:-.2px; color:${CREAM}">AppuBot</div>
<div class="abs" style="left:14px; right:14px; top:190px; text-align:center; font-size:11.5px; line-height:1.4; color:rgba(255,242,226,.66)">AI teammates that use your apps for you</div>
<div class="abs" style="left:0; right:0; bottom:16px; text-align:center; font-size:10.5px; font-weight:500; color:rgba(255,242,226,.5)">appubot.com</div>`;

const HEADER = { w: 150, h: 57 };
const headerBody = `
<div class="abs" style="inset:0; background:#FFFFFF"></div>
<img class="abs" src="${TILE}" style="right:11px; top:11px; width:35px; height:35px">
<div class="abs" style="right:54px; top:0; bottom:0; display:flex; align-items:center; font-size:15px; font-weight:650; letter-spacing:-.1px; color:#1B1B1F">AppuBot</div>`;

/* ---------- rendering ---------- */
const work = mkdtempSync(join(tmpdir(), 'appubot-installer-art-'));
let n = 0;

/** The page at `scale`× its size, as a NativeImage. */
async function render(w, h, body, scale = 1) {
  const file = join(work, `page-${n++}.html`);
  writeFileSync(file, page(w, h, body, scale));
  const win = new BrowserWindow({ show: false, width: w * scale, height: h * scale, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadFile(file);
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {})))).then(() => true)');
  await new Promise((r) => setTimeout(r, 200));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: w * scale, height: h * scale });
  win.destroy();
  const size = image.getSize();
  return size.width === w * scale ? image : image.resize({ width: w * scale, height: h * scale, quality: 'best' });
}

/** A 24-bit, bottom-up BMP (what NSIS's MUI pages take) of a NativeImage. */
function bmp(image) {
  const { width, height } = image.getSize();
  const bgra = image.toBitmap();
  const row = Math.ceil((width * 3) / 4) * 4;
  const out = Buffer.alloc(54 + row * height);
  out.write('BM', 0);
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(row * height, 34);
  out.writeInt32LE(2835, 38);
  out.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4;
    const dst = 54 + y * row;
    for (let x = 0; x < width; x++) {
      out[dst + x * 3] = bgra[src + x * 4];
      out[dst + x * 3 + 1] = bgra[src + x * 4 + 1];
      out[dst + x * 3 + 2] = bgra[src + x * 4 + 2];
    }
  }
  return out;
}

app.dock?.hide();
// each page's window closes before the next opens: that isn't the end
app.on('window-all-closed', () => {});
// not a top-level await: Electron only gets ready once the main module has finished evaluating
void app.whenReady().then(main).catch((e) => {
  console.error(e);
  process.exitCode = 1;
  app.quit();
});

async function main() {
try {
  const preview = process.argv.includes('--preview') ? process.argv[process.argv.indexOf('--preview') + 1] : undefined;
  const dmg1 = await render(DMG.w, DMG.h, dmgBody, 1);
  const dmg2 = await render(DMG.w, DMG.h, dmgBody, 2);
  const one = join(work, 'background.png');
  const two = join(work, 'background@2x.png');
  writeFileSync(one, dmg1.toPNG());
  writeFileSync(two, dmg2.toPNG());
  // one TIFF with both resolutions: Finder picks the 2x on Retina screens
  execFileSync('tiffutil', ['-cathidpicheck', one, two, '-out', join(resources, 'background.tiff')], { stdio: 'ignore' });
  const sidebar = await render(SIDEBAR.w, SIDEBAR.h, sidebarBody, 1);
  writeFileSync(join(resources, 'installerSidebar.bmp'), bmp(sidebar));
  const header = await render(HEADER.w, HEADER.h, headerBody, 1);
  writeFileSync(join(resources, 'installerHeader.bmp'), bmp(header));
  if (preview) {
    mkdirSync(preview, { recursive: true });
    writeFileSync(join(preview, 'dmg@2x.png'), dmg2.toPNG());
    // the window as Finder shows it: both icons, and their labels as light mode (black) and dark mode (white) draw them
    const folder = join(work, 'applications.png');
    execFileSync('sips', ['-s', 'format', 'png', '-z', '256', '256', '/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/ApplicationsFolderIcon.icns', '--out', folder], { stdio: 'ignore' });
    const folderUrl = `data:image/png;base64,${readFileSync(folder).toString('base64')}`;
    const bg = `data:image/png;base64,${dmg2.toPNG().toString('base64')}`;
    for (const [mode, ink] of [['light', '#000'], ['dark', '#fff']]) {
      const slot = (x, src, label) => `<img class="abs" src="${src}" style="left:${x - 52}px; top:${DMG.y - 52}px; width:104px; height:104px">`
        + `<div class="abs" style="left:${x - 70}px; width:140px; top:${DMG.y + 58}px; text-align:center; font-family:-apple-system, system-ui; font-size:13px; color:${ink}">${label}</div>`;
      const mock = `<img class="abs" src="${bg}" style="left:0; top:0; width:${DMG.w}px; height:${DMG.h}px">${slot(DMG.left, ICON, 'AppuBot')}${slot(DMG.right, folderUrl, 'Applications')}`;
      writeFileSync(join(preview, `dmg-finder-${mode}@2x.png`), (await render(DMG.w, DMG.h, mock, 2)).toPNG());
    }
    writeFileSync(join(preview, 'nsis-sidebar@3x.png'), (await render(SIDEBAR.w, SIDEBAR.h, sidebarBody, 3)).toPNG());
    writeFileSync(join(preview, 'nsis-header@3x.png'), (await render(HEADER.w, HEADER.h, headerBody, 3)).toPNG());
  }
  console.log('wrote resources/background.tiff, installerSidebar.bmp and installerHeader.bmp');
} finally {
  rmSync(work, { recursive: true, force: true });
  app.quit();
}
}
