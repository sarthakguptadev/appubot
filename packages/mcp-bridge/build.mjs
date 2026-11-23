import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
const result = await build({
  entryPoints: ['src/bridge.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: 'dist/bridge.mjs',
  // it ships inside the app (electron-builder.yml extraResources): minified, like the app's own code
  minify: true,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
  metafile: true,
});
// the packages it bundled, for the app's third-party notices (apps/desktop/scripts/notices.mjs)
const dirs = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const at = input.lastIndexOf('node_modules/');
  if (at < 0) continue;
  const parts = input.slice(at + 13).split('/');
  dirs.add(resolve(input.slice(0, at + 13) + parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join('/')));
}
writeFileSync('dist/bridge.packages.json', JSON.stringify([...dirs]));
