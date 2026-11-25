// The README's download buttons and the badges under them, drawn in headless Chrome on a Mac (the system's type) in a
// light and a dark version each: the buttons with each store's own logo in colour (assets/readme/logos), the badges with
// the version and the downloads from the GitHub API, the licence and the X accounts. The Readme badges workflow runs it
// daily and after every release and keeps the images on the readme-assets branch, where the README loads them from.
//
//   node scripts/readme-badges.mjs <out dir>        GH_TOKEN optional (higher API limits)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, launchChrome, sleep } from '../apps/desktop/bench/lib/cdp.mjs';

const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/readme-badges.mjs <out dir>');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.GITHUB_REPOSITORY ?? 'sarthakguptadev/AppuBot';
const headers = { accept: 'application/vnd.github+json', ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) };
const api = async (path) => {
  const res = await fetch(`https://api.github.com/${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${path}: ${res.status}`);
  return res.json();
};

const version = (await api(`repos/${REPO}/releases/latest`)).tag_name.replace(/^v/, '');
let downloads = 0;
for (let page = 1; ; page++) {
  const releases = await api(`repos/${REPO}/releases?per_page=100&page=${page}`);
  for (const r of releases) for (const a of r.assets) downloads += a.download_count;
  if (releases.length < 100) break;
}
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(downloads).toLowerCase();

const file = (path, type) => `data:${type};base64,${readFileSync(join(ROOT, path)).toString('base64')}`;
const logo = (name) => file(`assets/readme/logos/${name}.svg`, 'image/svg+xml');
const APPUBOT = file('assets/icon.png', 'image/png');
const GITHUB = 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12';
const X = 'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z';
const ARROW = 'M12 3v12m0 0-5-5m5 5 5-5M4 20h16';
const SCALES = 'M12 4v16M7 20h10M5 7h14M5 7 2.5 14a2.7 2.7 0 0 0 5 0zM19 7l-2.5 7a2.7 2.7 0 0 0 5 0z';

// [id, logo, small line, big line]; the Apple logo takes the button's text colour, the others keep their own
const BUTTONS = [
  ['mac', 'apple', 'Download for', 'macOS'],
  ['windows', 'windows', 'Download for', 'Windows'],
  ['linux', 'tux', 'Download for', 'Linux'],
  ['appstore', 'app-store', 'Download on the', 'App Store'],
  ['googleplay', 'google-play', 'Get it on', 'Google Play'],
];
// [id, icon, accent (light, dark), label, value]
const BADGES = [
  ['version', { img: APPUBOT }, ['#e8590c', '#ee7944'], 'Version', version],
  ['downloads', { stroke: ARROW }, ['#1a7f37', '#3fb950'], 'Downloads', compact],
  ['license', { stroke: SCALES }, ['#8250df', '#a371f7'], 'Licence', 'Apache 2.0'],
  ['x-appubot', { fill: X }, null, '', '@AppuBot_'],
  ['x-sarthakguptadev', { fill: X }, null, '', '@sarthakguptadev'],
];
// the README's own page colours: dark buttons on the light page, light ones on the dark page
const THEMES = {
  dark: { i: 1, button: '#ffffff', buttonText: '#0d1117', invertApple: false, edge: '#30363d', bg: '#161b22', label: '#8b949e', value: '#f0f6fc' },
  light: { i: 0, button: '#0d1117', buttonText: '#ffffff', invertApple: true, edge: '#d1d9e0', bg: '#ffffff', label: '#59636e', value: '#1f2328' },
};

const icon = ({ img, fill, stroke }, c) => img
  ? `<img src="${img}" style="width:17px;height:17px;border-radius:4px">`
  : fill
    ? `<svg viewBox="0 0 24 24"><path fill="${c}" d="${fill}"/></svg>`
    : `<svg viewBox="0 0 24 24"><path fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="${stroke}"/></svg>`;
const page = (t) => `<html><head><style>
  html,body{margin:0;background:transparent;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif}
  .btn{display:inline-flex;align-items:center;gap:10px;height:48px;padding:0 18px 0 14px;margin:8px;border-radius:12px;background:${t.button};color:${t.buttonText}}
  .btn img{width:26px;height:26px;object-fit:contain;flex:none}.btn .apple{${t.invertApple ? 'filter:invert(1)' : ''}}
  .t{display:flex;flex-direction:column;line-height:1.05}.s{font-size:10.5px;font-weight:500;opacity:.75}.l{font-size:17px;font-weight:600;letter-spacing:-.01em;margin-top:2px}
  .b{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 12px 0 10px;margin:6px;border-radius:9px;font-size:13px;white-space:nowrap}
  .b svg{width:15px;height:15px;flex:none}.lab{color:${t.label};font-weight:500}.v{color:${t.value};font-weight:600}
</style></head><body>
${BUTTONS.map(([id, name, s, l]) => `<div class="btn" id="${id}"><img class="${name}" src="${logo(name)}"><div class="t"><span class="s">${s}</span><span class="l">${l}</span></div></div>`).join('')}
<br>
${BADGES.map(([id, ic, accent, label, value]) => {
  const a = accent?.[t.i];
  const style = a ? `background:color-mix(in srgb, ${a} 10%, ${t.bg});box-shadow:inset 0 0 0 1px color-mix(in srgb, ${a} 45%, ${t.bg})` : `background:${t.bg};box-shadow:inset 0 0 0 1px ${t.edge}`;
  return `<span class="b" id="${id}" style="${style}">${icon(ic, a ?? t.value)}${label ? `<span class="lab">${label}</span>` : ''}<span class="v">${value}</span></span>`;
}).join('')}
</body></html>`;

mkdirSync(out, { recursive: true });
const chrome = await launchChrome({ width: 1400, height: 300 });
const browser = await Cdp.attach((await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json()).webSocketDebuggerUrl);
for (const [theme, t] of Object.entries(THEMES)) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const list = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
  const tab = await Cdp.attach(list.find((x) => x.id === targetId).webSocketDebuggerUrl);
  await tab.send('Page.enable');
  await tab.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 300, deviceScaleFactor: 3, mobile: false });
  await tab.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const { frameTree } = await tab.send('Page.getFrameTree');
  await tab.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html: page(t) });
  await sleep(500);
  for (const id of [...BUTTONS, ...BADGES].map(([id]) => id)) {
    const r = JSON.parse(await tab.eval(`JSON.stringify(document.getElementById('${id}').getBoundingClientRect())`));
    const shot = await tab.send('Page.captureScreenshot', { format: 'png', clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 } });
    writeFileSync(join(out, `${id}-${theme}.png`), Buffer.from(shot.data, 'base64'));
  }
  tab.close();
  await browser.send('Target.closeTarget', { targetId });
}
browser.close();
await chrome.stop();
console.log(`version ${version}, ${compact} downloads: ${(BUTTONS.length + BADGES.length) * 2} images in ${out}`);
process.exit(0);
