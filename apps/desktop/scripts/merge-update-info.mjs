#!/usr/bin/env node
/**
 * One update file per OS from the builds of each architecture (the Release workflow in the public releases repo). electron-updater reads a
 * single latest-mac.yml / latest.yml whose `files` lists every architecture's download: on a Mac it keeps the arm64 ones
 * on Apple silicon and the others on Intel, on Windows it takes the .exe whose name has `process.arch` in it (else the
 * first one, so x64 goes first). Linux has a file per architecture (latest-linux.yml, latest-linux-arm64.yml): no merge.
 * Everything but `files` comes from the first input. Inputs that don't exist are skipped (a build that was optional).
 * Usage: node merge-update-info.mjs <out.yml> <in.yml>...
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/** electron-builder writes `files:` followed by its indented `- url:` entries, then the top-level keys again */
function split(text, name) {
  const lines = text.replace(/\r\n/g, '\n').trimEnd().split('\n');
  const start = lines.indexOf('files:');
  if (start < 0) throw new Error(`${name}: no "files:" list`);
  let end = start + 1;
  while (end < lines.length && /^\s/.test(lines[end])) end++;
  const version = lines.find((l) => l.startsWith('version: '));
  return { lines, start, end, version };
}

const [out, ...inputs] = process.argv.slice(2);
const found = inputs.filter((f) => existsSync(f));
if (!out || !found.length) {
  console.error('usage: merge-update-info.mjs <out.yml> <in.yml>... (at least one input must exist)');
  process.exit(1);
}
for (const f of inputs) if (!existsSync(f)) console.warn(`skipped (missing): ${f}`);

const parts = found.map((f) => ({ f, ...split(readFileSync(f, 'utf8'), f) }));
const first = parts[0];
for (const p of parts) {
  if (p.version !== first.version) throw new Error(`${p.f} is ${p.version}, ${first.f} is ${first.version}`);
}
const entries = parts.flatMap((p) => p.lines.slice(p.start + 1, p.end));
const merged = [...first.lines.slice(0, first.start + 1), ...entries, ...first.lines.slice(first.end)];
writeFileSync(out, `${merged.join('\n')}\n`);
console.log(`${out}: ${parts.length} build(s), ${entries.filter((l) => l.trimStart().startsWith('- url:')).length} file(s)`);
