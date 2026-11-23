// The README's badges under the download buttons, drawn in the buttons' style: the version and the downloads from the
// GitHub API, the licence and the X accounts, each light (for GitHub's light theme) and dark. Headless Chrome on a Mac,
// so the type is the system's, as on the buttons. The Readme badges workflow runs it daily and after every release and
// keeps the images on the readme-assets branch, where the README loads them from.
//
//   node scripts/readme-badges.mjs <out dir>        GH_TOKEN optional (higher API limits)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Cdp, launchChrome, sleep } from '../apps/desktop/bench/lib/cdp.mjs';

const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/readme-badges.mjs <out dir>');
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

const GITHUB = 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12';
const X = 'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z';
const ARROW = 'M12 3v12m0 0-5-5m5 5 5-5M4 20h16';
const SHIELD = 'M12 3 5 6v5c0 4.4 3 8.3 7 10 4-1.7 7-5.6 7-10V6z';
const BADGES = [
  ['version', { fill: GITHUB }, 'Version', version],
  ['downloads', { stroke: ARROW }, 'Downloads', compact],
  ['license', { stroke: SHIELD }, 'Licence', 'PolyForm Shield'],
  ['x-appubot', { fill: X }, '', '@AppuBot_'],
  ['x-sarthakguptadev', { fill: X }, '', '@sarthakguptadev'],
];
const THEMES = {
  dark: { edge: '#30363d', bg: '#161b22', label: '#8b949e', value: '#f0f6fc' },
  light: { edge: '#d1d9e0', bg: '#ffffff', label: '#59636e', value: '#1f2328' },
};

const icon = ({ fill, stroke }, c) => fill
  ? `<svg viewBox="0 0 24 24"><path fill="${c}" d="${fill}"/></svg>`
  : `<svg viewBox="0 0 24 24"><path fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="${stroke}"/></svg>`;
const page = (t) => `<html><head><style>
  html,body{margin:0;background:transparent;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif}
  .b{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 12px 0 10px;margin:6px;border-radius:9px;
     background:${t.bg};box-shadow:inset 0 0 0 1px ${t.edge};font-size:13px;white-space:nowrap}
  .b svg{width:15px;height:15px;flex:none}.l{color:${t.label};font-weight:500}.v{color:${t.value};font-weight:600}
</style></head><body>${BADGES.map(([id, ic, label, value]) =>
  `<span class="b" id="${id}">${icon(ic, t.value)}${label ? `<span class="l">${label}</span>` : ''}<span class="v">${value}</span></span>`).join('')}</body></html>`;

mkdirSync(out, { recursive: true });
const chrome = await launchChrome({ width: 1200, height: 200 });
const browser = await Cdp.attach((await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json()).webSocketDebuggerUrl);
for (const [theme, t] of Object.entries(THEMES)) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const list = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
  const tab = await Cdp.attach(list.find((x) => x.id === targetId).webSocketDebuggerUrl);
  await tab.send('Page.enable');
  await tab.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 200, deviceScaleFactor: 3, mobile: false });
  await tab.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const { frameTree } = await tab.send('Page.getFrameTree');
  await tab.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html: page(t) });
  await sleep(300);
  for (const [id] of BADGES) {
    const r = JSON.parse(await tab.eval(`JSON.stringify(document.getElementById('${id}').getBoundingClientRect())`));
    const shot = await tab.send('Page.captureScreenshot', { format: 'png', clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 } });
    writeFileSync(join(out, `${id}-${theme}.png`), Buffer.from(shot.data, 'base64'));
  }
  tab.close();
  await browser.send('Target.closeTarget', { targetId });
}
browser.close();
await chrome.stop();
console.log(`version ${version}, ${compact} downloads: ${BADGES.length * 2} badges in ${out}`);
process.exit(0);
