// Renderer bundle size: builds the renderer the way electron-vite does (same plugins, minified) into a temp folder and
// reports what the window loads before it can draw (the entry chunk plus its static imports, the CSS), every lazy
// chunk, and the biggest packages/folders inside the entry chunk.
//
//   node bench/bundle.mjs [--json out.json] [--top 30]
//
// Numbers are bytes on disk (minified) and gzip -6 (only a guide: Electron reads them from disk uncompressed).
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(DESKTOP, 'src/renderer');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const TOP = Number(opt('--top', '25'));
/** how deep our own folders are told apart (`--depth 4`: src/renderer/src/features/<feature>) */
const DEPTH = Number(opt('--depth', '3'));

const out = mkdtempSync(join(tmpdir(), 'appubot-bundle-'));
const modules = new Map(); // chunk file -> [{id, bytes}]
const chunks = new Map(); // file -> {imports, dynamicImports, isEntry}
await build({
  root: ROOT,
  logLevel: 'warn',
  configFile: false,
  plugins: [react(), tailwindcss(), {
    name: 'bench-report',
    generateBundle(_o, bundle) {
      for (const [file, c] of Object.entries(bundle)) {
        if (c.type !== 'chunk') continue;
        chunks.set(file, { imports: c.imports, dynamicImports: c.dynamicImports, isEntry: c.isEntry, css: [...(c.viteMetadata?.importedCss ?? [])] });
        modules.set(file, Object.entries(c.modules).map(([id, m]) => ({ id, bytes: m.renderedLength })));
      }
    },
  }],
  resolve: { alias: { '@': join(ROOT, 'src') } },
  base: './',
  build: { outDir: out, emptyOutDir: true, minify: true, reportCompressedSize: false, chunkSizeWarningLimit: 1e9 },
});

const size = (file) => { const b = readFileSync(join(out, file)); return { bytes: b.length, gzip: gzipSync(b, { level: 6 }).length }; };
const entry = [...chunks].find(([, c]) => c.isEntry)?.[0];
const initial = new Set();
const walk = (f) => { if (initial.has(f)) return; initial.add(f); for (const i of chunks.get(f)?.imports ?? []) walk(i); };
walk(entry);
// the CSS the window loads before it can draw: what the initial chunks import (lazy chunks' CSS comes with them)
const css = [...new Set([...initial].flatMap((f) => chunks.get(f)?.css ?? []))];
// (a CSS-only chunk's empty JS stub is dropped by Vite after the bundle is generated)
const all = [...chunks.keys()].filter((f) => existsSync(join(out, f))).map((f) => ({ file: f, ...size(f), initial: initial.has(f) }));
const sum = (xs, k) => xs.reduce((n, x) => n + x[k], 0);
const initialJs = all.filter((c) => c.initial);
const cssSizes = css.map((f) => ({ file: f, ...size(f) }));

// what the entry chunk is made of: grouped by package (node_modules) or by source folder
const group = (id) => {
  const nm = id.lastIndexOf('node_modules/');
  if (nm >= 0) { const rest = id.slice(nm + 13).split('/'); return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]; }
  const rel = relative(join(DESKTOP, '../..'), id.replace(/^\0/, '').replace(/\?.*$/, ''));
  const parts = rel.split('/');
  if (parts[0] === 'packages') return `packages/${parts[1]}`;
  const src = parts.indexOf('src');
  return parts.slice(0, Math.min(parts.length - 1, src + DEPTH)).join('/');
};
const groups = new Map();
for (const f of initial) for (const m of modules.get(f) ?? []) groups.set(group(m.id), (groups.get(group(m.id)) ?? 0) + m.bytes);
const byGroup = [...groups].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([name, bytes]) => ({ name, bytes }));

const report = {
  at: new Date().toISOString(),
  initial: { js: sum(initialJs, 'bytes'), jsGzip: sum(initialJs, 'gzip'), css: sum(cssSizes, 'bytes'), cssGzip: sum(cssSizes, 'gzip'), chunks: initialJs.length },
  lazy: { js: sum(all.filter((c) => !c.initial), 'bytes'), chunks: all.length - initialJs.length },
  biggestChunks: all.sort((a, b) => b.bytes - a.bytes).slice(0, 15),
  entryComposition: byGroup,
};
rmSync(out, { recursive: true, force: true });

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`initial JS  ${kb(report.initial.js)} (gzip ${kb(report.initial.jsGzip)}) in ${report.initial.chunks} chunk(s)`);
console.log(`initial CSS ${kb(report.initial.css)} (gzip ${kb(report.initial.cssGzip)})`);
console.log(`lazy JS     ${kb(report.lazy.js)} in ${report.lazy.chunks} chunks`);
console.log('\nbiggest chunks:');
for (const c of report.biggestChunks) console.log(`  ${c.initial ? '*' : ' '} ${kb(c.bytes).padStart(10)}  ${c.file}`);
console.log('\ninitial JS by package/folder (rendered, before minify-wide savings):');
for (const g of byGroup) console.log(`  ${kb(g.bytes).padStart(10)}  ${g.name}`);
const json = opt('--json');
if (json) writeFileSync(json, JSON.stringify(report, null, 2));
