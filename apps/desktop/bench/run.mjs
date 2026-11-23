// Runs every bench and saves one results file: bench/results/<label>.json (bundle, startup, renderer), then prints
// the comparison with `--against <label>` if given (bench/compare.mjs).
//
//   node bench/run.mjs <label> [--against before] [--startup-runs 6] [--renderer-runs 5] [--scroll-runs 3] [--idle 30] [--only bundle,startup,renderer,scroll]
//
// The startup bench runs the production build in out/, built here first.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const BENCH = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(BENCH, '..');
const args = process.argv.slice(2);
const label = args[0];
if (!label || label.startsWith('--')) { console.error('usage: node bench/run.mjs <label> [--against <label>] …'); process.exit(1); }
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const only = new Set(opt('--only', 'bundle,startup,renderer,scroll').split(','));
mkdirSync(join(BENCH, 'results'), { recursive: true });
const file = join(BENCH, 'results', `${label}.json`);
let out = {};
try { out = JSON.parse(readFileSync(file, 'utf8')); } catch { /* new */ }
out.label = label;
out.commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: DESKTOP, encoding: 'utf8' }).trim();
out.dirty = execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: DESKTOP, encoding: 'utf8' }).trim().length > 0;
out.machine = execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim();

const tmp = join(tmpdir(), `appubot-bench-${process.pid}.json`);
const step = (name, script, extra) => {
  if (!only.has(name)) return;
  console.log(`\n=== ${name} ===`);
  execFileSync('node', ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(BENCH, script), '--json', tmp, ...extra], { cwd: DESKTOP, stdio: 'inherit' });
  out[name] = JSON.parse(readFileSync(tmp, 'utf8'));
  rmSync(tmp, { force: true });
  writeFileSync(file, JSON.stringify(out, null, 2));
};

step('bundle', 'bundle.mjs', []);
if (only.has('startup')) execFileSync('npx', ['electron-vite', 'build', '--logLevel', 'warn'], { cwd: DESKTOP, stdio: 'inherit' });
step('startup', 'startup.mjs', ['--runs', opt('--startup-runs', '6'), '--idle', opt('--idle', '30')]);
step('renderer', 'renderer.mjs', ['--runs', opt('--renderer-runs', '5')]);
step('scroll', 'scroll.mjs', ['--runs', opt('--scroll-runs', '3')]);
console.log(`\nsaved ${file}`);
const against = opt('--against');
if (against) execFileSync('node', [join(BENCH, 'compare.mjs'), against, label], { cwd: DESKTOP, stdio: 'inherit' });
