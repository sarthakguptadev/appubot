#!/usr/bin/env node
/**
 * The app icon, "Orange tile": the whole tile is the bot's head. An orange tile (lighter at the top), a dark rounded
 * visor bar across it tilted a touch, and two cream happy eyes in it (both closed in a smile). On the Mac it is Liquid
 * Glass (the owner's call, 2026-11-11, after seeing it flat beside the Dock's other icons): the Icon Composer bundle
 * (`resources/AppuBot.icon`: the tile is the fill; the visor is a group of its own, dark glass with a lit rim, a
 * shadow and a little of the orange showing through it; the eyes sit on it as a second glass group), which macOS 26+
 * draws in every appearance (Default, Dark, Clear light/dark, Tinted light/dark). The flat `resources/icon.svg` (the
 * site, the installers' art) keeps the plain drawing. Run it again after changing the drawing:
 * `node scripts/make-icon.mjs` (`--preview <dir>` renders each appearance with ictool). Needs Xcode 26+ (Icon
 * Composer). The menu bar glyph (src/main/electron/trayGlyph.ts), the What's new banner's `LogoGlyph` and the phone's
 * icons share this geometry: change them together.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// /usr/bin/ictool is only actool's shim; the renderer is Icon Composer's own
const ICTOOL = ['/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool'].find(existsSync) ?? 'ictool';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'resources');
const S = 1024;
const f = (n) => Math.round(n * 10) / 10;
// ictool writes Display P3 PNGs; Windows, Linux and the web may ignore the profile, so the PNGs we ship are sRGB
const SRGB = '/System/Library/ColorSync/Profiles/sRGB Profile.icc';
const toSrgb = (file) => execFileSync('sips', ['--matchTo', SRGB, file, '--out', file], { stdio: 'ignore' });

// Geometry in tile units: 1024 = the tile edge to edge (Icon Composer's canvas; the flat SVG puts it on macOS's 824px
// grid). The visor is a full pill, tilted a touch (the bot leans its head).
const VISOR = { cx: 512, cy: 519, w: 733, h: 326, rot: -5 };
// happy eyes, in the visor's own (untilted) frame: the upper half of a circle, stroked with round caps
const EYES = [{ x: -149, y: 37, r: 72 }, { x: 149, y: 37, r: 72 }];
const EYE_W = 52;
const ORANGE = ['#F98C2A', '#EE7414']; // top, bottom (the flat drawing)
// the glass icon's tile: a wider run of the same orange, so the tile has depth under the system's own rim light
const GLASS_ORANGE = { light: ['#FFA245', '#EA680A'], dark: ['#F58A2A', '#CC5708'] };
// the glass visor: graphite, lighter at its top edge
const VISOR_GLASS = ['#34363E', '#0B0C0E'];
const VISOR_INK = '#151515';
const CREAM = '#FFF2E2';

const svg = (body, defs = '', box = `0 0 ${S} ${S}`) => `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="${box}">${defs ? `<defs>${defs}</defs>` : ''}${body}</svg>\n`;
const visorEl = (fill) => `<rect x="${VISOR.cx - VISOR.w / 2}" y="${VISOR.cy - VISOR.h / 2}" width="${VISOR.w}" height="${VISOR.h}" rx="${VISOR.h / 2}" fill="${fill}" transform="rotate(${VISOR.rot} ${VISOR.cx} ${VISOR.cy})"/>`;
const eyesEl = (ink, w = EYE_W) => `<g transform="translate(${VISOR.cx} ${VISOR.cy}) rotate(${VISOR.rot})">`
  + EYES.map((e) => `<path d="M${e.x - e.r} ${e.y}A${e.r} ${e.r} 0 0 1 ${e.x + e.r} ${e.y}" fill="none" stroke="${ink}" stroke-width="${w}" stroke-linecap="round"/>`).join('') + '</g>';
const tileGrad = `<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${ORANGE[0]}"/><stop offset="1" stop-color="${ORANGE[1]}"/></linearGradient>`;
const srgb = (hex) => `srgb:${[1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(5)).join(',')},1.00000`;

/** macOS's tile on its 1024 grid: a superellipse (n = 5) 824px across, centred */
function tilePath() {
  const sp = (c) => Math.sign(c) * Math.abs(c) ** (2 / 5);
  const pts = [];
  for (let i = 0; i < 360; i++) {
    const t = (i / 360) * 2 * Math.PI;
    pts.push(`${i ? 'L' : 'M'}${f(512 + 412 * sp(Math.cos(t)))} ${f(512 + 412 * sp(Math.sin(t)))}`);
  }
  return `${pts.join('')}Z`;
}

/* ---------- Icon Composer bundle ---------- */
const bundle = join(root, 'AppuBot.icon');
rmSync(bundle, { recursive: true, force: true });
mkdirSync(join(bundle, 'Assets'), { recursive: true });
writeFileSync(join(bundle, 'Assets', 'visor.svg'), svg(visorEl('url(#visor)'), `<linearGradient id="visor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${VISOR_GLASS[0]}"/><stop offset="1" stop-color="${VISOR_GLASS[1]}"/></linearGradient>`));
writeFileSync(join(bundle, 'Assets', 'eyes.svg'), svg(eyesEl(CREAM)));
const fillOf = ([top, bottom]) => ({ 'linear-gradient': [srgb(top), srgb(bottom)], orientation: { start: { x: 0.5, y: 0 }, stop: { x: 0.5, y: 1 } } });
const icon = {
  // the tile is the head: the orange, lighter at the top. Dark keeps it orange (the icon is the colour), a shade
  // deeper so it doesn't glare among dark icons; Tinted/Clear take the fill away and keep the face.
  'fill-specializations': [
    { value: fillOf(GLASS_ORANGE.light) },
    { appearance: 'dark', value: fillOf(GLASS_ORANGE.dark) },
  ],
  // front to back: the eyes, raised a little on the visor; the visor, dark glass on the tile
  groups: [
    {
      name: 'Eyes',
      layers: [{ name: 'eyes', 'image-name': 'eyes.svg', glass: true }],
      shadow: { kind: 'neutral', opacity: 0.5 },
      translucency: { enabled: false, value: 0.5 },
      specular: true,
    },
    {
      name: 'Visor',
      layers: [{ name: 'visor', 'image-name': 'visor.svg', glass: true }],
      shadow: { kind: 'neutral', opacity: 0.8 },
      translucency: { enabled: true, value: 0.3 },
      'blur-material': 0.6,
      specular: true,
    },
  ],
  'supported-platforms': { squares: ['macOS'] },
};
writeFileSync(join(bundle, 'icon.json'), `${JSON.stringify(icon, null, 2)}\n`);

/* ---------- flat SVG (older macOS, Windows/Linux, docs): the same drawing on the 824px macOS tile ---------- */
const k = 824 / S;
writeFileSync(join(root, 'icon.svg'), svg(
  `<path d="${tilePath()}" fill="url(#tile)"/>`
  + `<g transform="translate(100 100) scale(${k})">${visorEl(VISOR_INK)}${eyesEl(CREAM)}</g>`,
  tileGrad,
));

/* ---------- previews: every appearance, through Icon Composer's renderer ---------- */
const at = process.argv.indexOf('--preview');
if (at > 0) {
  const out = process.argv[at + 1];
  mkdirSync(out, { recursive: true });
  for (const r of ['Default', 'Dark', 'ClearLight', 'ClearDark', 'TintedLight', 'TintedDark']) {
    execFileSync(ICTOOL, [bundle, '--export-image', '--output-file', join(out, `${r}.png`), '--platform', 'macOS', '--rendition', r, '--width', '512', '--height', '512', '--scale', '1', ...(r.startsWith('Tinted') ? ['--tint-color', '0.08', '--tint-strength', '0.8'] : [])], { stdio: 'inherit' });
    toSrgb(join(out, `${r}.png`));
  }
}
// icon.png: the Default rendition at full size, edge to edge (Windows/Linux window icon, the fallback icns)
execFileSync(ICTOOL, [bundle, '--export-image', '--output-file', join(root, 'icon.png'), '--platform', 'macOS', '--rendition', 'Default', '--width', '1024', '--height', '1024', '--scale', '1']);
toSrgb(join(root, 'icon.png'));
// the app's own copy (About, onboarding, the connection screen): small, at 2x for a 128px mark
const appCopy = join(root, '..', 'src', 'renderer', 'src', 'assets', 'app-icon.png');
mkdirSync(dirname(appCopy), { recursive: true });
execFileSync(ICTOOL, [bundle, '--export-image', '--output-file', appCopy, '--platform', 'macOS', '--rendition', 'Default', '--width', '128', '--height', '128', '--scale', '2']);
toSrgb(appCopy);
// The Mac app's icon, compiled as electron-builder would (its macosIconComposer), so packaging needs no actool: the
// asset catalog (Assets.car, app icon "Icon") and the icns older macOS shows. actool needs Xcode 26+ on macOS 26+.
const compiled = join(root, 'compiled-icon');
const work = join(tmpdir(), `appubot-icon-${process.pid}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, 'out'), { recursive: true });
cpSync(bundle, join(work, 'Icon.icon'), { recursive: true });
execFileSync('xcrun', [
  'actool', join(work, 'Icon.icon'), '--compile', join(work, 'out'), '--output-format', 'human-readable-text', '--notices', '--warnings',
  '--output-partial-info-plist', join(work, 'out', 'info.plist'), '--app-icon', 'Icon', '--include-all-app-icons',
  '--accent-color', 'AccentColor', '--enable-on-demand-resources', 'NO', '--development-region', 'en', '--target-device', 'mac',
  '--minimum-deployment-target', '26.0', '--platform', 'macosx',
], { stdio: 'ignore' });
mkdirSync(compiled, { recursive: true });
for (const f of ['Assets.car', 'Icon.icns']) cpSync(join(work, 'out', f), join(compiled, f));
rmSync(work, { recursive: true, force: true });
// dock-icon.png: the dev build's Dock icon, icon.png's glass rendition on macOS's icon grid (the 824px tile centred in
// 1024px with a transparent margin, like every app in the Dock; icon.png fills the whole canvas).
execFileSync('swift', [join(here, 'pad-icon.swift'), join(root, 'icon.png'), join(root, 'dock-icon.png')], { stdio: 'inherit' });
console.log('wrote', bundle, 'icon.svg, icon.png, dock-icon.png, the app copy and compiled-icon/');
