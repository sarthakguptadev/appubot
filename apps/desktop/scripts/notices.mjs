// Third-party notices: every build writes THIRD_PARTY_NOTICES.txt (in node_modules/.cache/appubot-notices, so it stays
// out of app.asar), which electron-builder.yml puts in the app's
// resources folder as a plain file (the licenses we use ask for their notice to go with every copy; the build is
// minified, so the notices in the code itself don't survive). It holds the code we ported (CREDITS), the speech models
// AppuBot downloads (MODELS) and every package the app carries: the ones bundled into main, preload and the renderer
// (their module ids, collected by `noticesPlugin` on each build), the bridge's (packages/mcp-bridge/build.mjs writes
// dist/bridge.packages.json) and the dependencies that ship as is in node_modules.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(DESKTOP, 'node_modules', '.cache', 'appubot-notices');
const BRIDGE_PACKAGES = resolve(DESKTOP, '../../packages/mcp-bridge/dist/bridge.packages.json');
// electron-builder.yml leaves these out of the app
const NOT_SHIPPED = [/^@anthropic-ai\/claude-agent-sdk-/, /^@openai\/codex/, /^@appubot\//];

const mit = (holders) => `MIT License

${holders.map((h) => `Copyright (c) ${h}`).join('\n')}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** Code ported into AppuBot's own source (each file names where it came from) and files copied in as is. */
// The list itself is chat-core's `credits.json`, the one the apps show under Settings › About › Credits, so nothing is
// credited in one place and missed in the other. Here: the code and the faces and icons the app carries, each with its
// licence's text (an MIT one from its copyright lines, another from scripts/licenses).
const CREDITS = JSON.parse(readFileSync(join(DESKTOP, '..', '..', 'packages', 'chat-core', 'src', 'credits.json'), 'utf8'))
  .filter((c) => c.kind === 'code' || c.kind === 'asset')
  .map((c) => ({
    name: c.name,
    url: c.url,
    used: c.used,
    text: c.licenseFile
      ? readFileSync(join(DESKTOP, 'scripts', 'licenses', c.licenseFile), 'utf8').trim()
      : c.license === 'MIT' && c.holders?.length ? mit(c.holders) : undefined,
  }));


/** The speech models Settings › Voice downloads on first use (from Hugging Face; not part of the app). */
const MODELS = [
  { name: 'Parakeet Unified English 0.6B', by: 'NVIDIA', license: 'NVIDIA Open Model License', url: 'https://huggingface.co/nvidia/parakeet-unified-en-0.6b', note: 'Converted for sherpa-onnx by csukuangfj (int8). License: https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' },
  { name: 'Cohere Transcribe 03-2026', by: 'Cohere Labs', license: 'Apache 2.0', url: 'https://huggingface.co/CohereLabs/cohere-transcribe-03-2026', note: 'Converted for sherpa-onnx by csukuangfj (int8).' },
  { name: 'Whisper large-v3 turbo', by: 'OpenAI', license: 'MIT', url: 'https://huggingface.co/openai/whisper-large-v3-turbo', note: 'Converted for sherpa-onnx by csukuangfj (int8).' },
  { name: 'Parakeet TDT 0.6B v2', by: 'NVIDIA', license: 'CC BY 4.0', url: 'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2', note: 'Converted for sherpa-onnx by csukuangfj (int8).' },
  { name: 'Parakeet TDT 0.6B v3', by: 'NVIDIA', license: 'CC BY 4.0', url: 'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3', note: 'Converted for sherpa-onnx by csukuangfj (int8).' },
  { name: 'Qwen3-ASR 0.6B', by: 'Qwen (Alibaba Cloud)', license: 'Apache 2.0', url: 'https://huggingface.co/Qwen/Qwen3-ASR-0.6B', note: 'Exported to ONNX by Wasser1462 (int8), packaged for sherpa-onnx by csukuangfj.' },
  { name: 'SenseVoice Small', by: 'FunAudioLLM (Alibaba)', license: 'FunASR Model License', url: 'https://huggingface.co/FunAudioLLM/SenseVoiceSmall', note: 'Converted for sherpa-onnx by csukuangfj (int8). License: https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE' },
  { name: 'Underdog Bark 3.0 Plus', by: 'Conway Research', license: 'CC BY 4.0', url: 'https://huggingface.co/ConwayResearch/Underdog-Bark-3.0-Plus', note: 'Derived from NVIDIA Parakeet TDT 0.6B v3 and Moondream parakeet-ultra (CC BY 4.0). Converted for sherpa-onnx by velddev (int8): https://huggingface.co/velddev/Underdog-Bark-3.0-Plus-sherpa-onnx' },
  { name: 'Underdog Bark 3.0 Clean', by: 'Conway Research', license: 'CC BY 4.0', url: 'https://huggingface.co/ConwayResearch/Underdog-Bark-3.0-Clean', note: 'Derived from NVIDIA Parakeet TDT 0.6B v3 and Moondream parakeet-ultra (CC BY 4.0). Converted for sherpa-onnx by velddev (int8): https://huggingface.co/velddev/Underdog-Bark-3.0-Clean-sherpa-onnx' },
  { name: 'Nemotron 3.5 ASR streaming 0.6B', by: 'NVIDIA', license: 'OpenMDW 1.1', url: 'https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b', note: 'Converted for sherpa-onnx by csukuangfj (int8, 1.12 s chunks). License: https://openmdw.ai/license/1-1/' },
  { name: 'IndicConformer (Hindi)', by: 'AI4Bharat', license: 'MIT', url: 'https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual', note: 'Converted for sherpa-onnx by Parismita Global Solutions (Apache 2.0).' },
  { name: 'Supertonic 3', by: 'Supertone Inc.', license: 'OpenRAIL-M', url: 'https://huggingface.co/Supertone/supertonic-3', note: 'Its license limits how the model may be used: https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE' },
  { name: 'Kokoro 82M v1.0', by: 'hexgrad', license: 'Apache 2.0', url: 'https://huggingface.co/hexgrad/Kokoro-82M', note: 'Converted for sherpa-onnx by csukuangfj (int8), with its English lexicons.' },
];

/* ---------- collecting packages ---------- */

/** `/…/node_modules/@scope/name/dist/x.js` → `/…/node_modules/@scope/name` (null outside node_modules). */
export function packageDirOf(id) {
  const path = id.replace(/^\0/, '').split('?')[0];
  const at = path.lastIndexOf(`${sep}node_modules${sep}`);
  if (at < 0) return null;
  const rest = path.slice(at + 14).split(sep);
  const parts = rest[0].startsWith('@') ? 2 : 1;
  if (rest.length < parts) return null;
  return path.slice(0, at + 14) + rest.slice(0, parts).join(sep);
}

/** A Vite plugin: notes which packages a build bundled; the renderer's (built last) writes the notices. */
export function noticesPlugin(target, { write = false } = {}) {
  return {
    name: 'appubot-notices',
    apply: 'build',
    generateBundle() {
      const dirs = new Set();
      for (const id of this.getModuleIds()) {
        const dir = packageDirOf(id);
        if (dir && existsSync(join(dir, 'package.json'))) dirs.add(realpathSync(dir));
      }
      mkdirSync(CACHE, { recursive: true });
      writeFileSync(join(CACHE, `${target}.json`), JSON.stringify([...dirs]));
    },
    closeBundle() {
      if (write) writeNotices();
    },
  };
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Where Node would find `name` from `fromDir`. */
function findPackage(fromDir, name) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return null;
  }
}

/** A package's dependencies, all the way down (what ships in node_modules). */
function closure(dir, into) {
  const pkg = readJson(join(dir, 'package.json'));
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    if (NOT_SHIPPED.some((re) => re.test(name))) continue;
    const found = findPackage(dir, name);
    if (!found || into.has(found)) continue;
    into.add(found);
    closure(found, into);
  }
  return into;
}

/** Licenses whose text has to go along and some packages don't include (scripts/licenses, as published). */
const FULL_TEXTS = Object.fromEntries(
  ['Apache-2.0', 'MPL-2.0'].map((id) => [id, readFileSync(join(DESKTOP, 'scripts', 'licenses', `${id}.txt`), 'utf8').trim()]),
);

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.\-_].*)?$/i;

function describe(dir) {
  const pkg = readJson(join(dir, 'package.json'));
  const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort();
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? pkg.licenses?.map?.((l) => l.type).join(' OR ') ?? 'unknown';
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
  const texts = files.map((f) => readFileSync(join(dir, f), 'utf8').trim());
  // no license file: MIT's notice from package.json; Apache and MPL texts are in the appendix (FULL_TEXTS)
  if (!texts.length && license === 'MIT') texts.push(mit([author ?? `the ${pkg.name} authors`]));
  if (!texts.length) for (const id of Object.keys(FULL_TEXTS)) if (license.includes(id)) texts.push(`The ${id} license text is at the end of this file.`);
  return { name: pkg.name, version: pkg.version, license, url: pkg.homepage ?? repo, author, texts };
}

/* ---------- writing ---------- */

const RULE = '='.repeat(80);
const LINE = '-'.repeat(80);

export function writeNotices() {
  const dirs = new Set();
  for (const target of ['main', 'preload', 'renderer']) {
    const file = join(CACHE, `${target}.json`);
    if (existsSync(file)) for (const d of readJson(file)) if (existsSync(d)) dirs.add(d);
  }
  if (existsSync(BRIDGE_PACKAGES)) for (const d of readJson(BRIDGE_PACKAGES)) if (existsSync(d)) dirs.add(realpathSync(d));
  closure(DESKTOP, dirs);
  const electron = findPackage(DESKTOP, 'electron');
  if (electron) dirs.add(electron);

  const byId = new Map();
  for (const dir of dirs) {
    const p = describe(dir);
    if (!p.name || NOT_SHIPPED.some((re) => re.test(p.name))) continue;
    byId.set(`${p.name}@${p.version}`, p);
  }
  const packages = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

  const out = [
    'AppuBot: third-party notices',
    '',
    'AppuBot is made with the open-source software below. Thank you to everyone who wrote it.',
    'Each part keeps its own license, reproduced here.',
    '',
    RULE,
    'CODE PORTED INTO APPUBOT',
    RULE,
  ];
  for (const c of CREDITS) {
    out.push('', `${c.name} (${c.url})`, c.used);
    if (c.text) out.push('', c.text);
    out.push('', LINE);
  }
  out.push('', RULE, 'SPEECH MODELS (downloaded from Hugging Face when you first use voice; not part of the app)', RULE, '');
  for (const m of MODELS) out.push(`${m.name}, by ${m.by}. License: ${m.license}. ${m.url}`, `  ${m.note}`, '');
  out.push(
    RULE,
    'PACKAGES',
    RULE,
    '',
    'Electron includes Chromium, whose licenses are in LICENSES.chromium.html, which comes with the app.',
  );
  for (const p of packages) {
    out.push('', LINE, `${p.name} ${p.version}`, `License: ${p.license}`);
    if (p.author) out.push(`Author: ${p.author}`);
    if (p.url) out.push(`Source: ${p.url.replace(/^git\+/, '')}`);
    for (const t of p.texts) out.push('', t);
  }
  for (const [id, text] of Object.entries(FULL_TEXTS)) out.push('', RULE, `${id} LICENSE TEXT`, RULE, '', text);
  out.push('');
  const text = out.join('\n');

  const outDir = CACHE;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'THIRD_PARTY_NOTICES.txt'), text);
  // Windows and Linux installs already have it (electron-builder copies it from Electron); the Mac app doesn't. Only
  // the Mac's Electron keeps it in dist/ (the Linux build runners' has none there), and only the Mac build packs it.
  const chromium = electron ? join(electron, 'dist', 'LICENSES.chromium.html') : null;
  const target = join(outDir, 'LICENSES.chromium.html');
  if (chromium && existsSync(chromium)) copyFileSync(chromium, target);
  else if (electron && process.platform === 'darwin') writeFileSync(target, chromiumLicensesFromRelease(electron));
  return { packages: packages.length, bytes: text.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(writeNotices());

/**
 * Chromium's licenses out of Electron's own release zip (its downloader's cache, else GitHub), for an install whose
 * Electron has no dist/ (the release runners' pnpm install leaves it out).
 */
function chromiumLicensesFromRelease(electron) {
  const { version } = JSON.parse(readFileSync(join(electron, 'package.json'), 'utf8'));
  const get = createRequire(join(electron, 'package.json')).resolve('@electron/get');
  const script = `require(${JSON.stringify(get)}).downloadArtifact({ version: ${JSON.stringify(version)}, artifactName: 'electron', platform: 'darwin', arch: process.arch }).then((p) => process.stdout.write(p))`;
  // GitHub's release downloads answer 504 now and then: three tries, a short wait between
  let zip = '';
  for (let attempt = 1; ; attempt++) {
    try { zip = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); break; }
    catch (e) {
      if (attempt >= 3) throw e;
      console.warn(`[notices] Electron ${version} download failed (try ${attempt}); again in 30 s`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
    }
  }
  return execFileSync('/usr/bin/unzip', ['-p', zip, 'LICENSES.chromium.html'], { maxBuffer: 64 * 1024 * 1024 });
}
