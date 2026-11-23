// Process tree helpers for the benches (macOS / Linux `ps`): a root pid's descendants with their CPU time and RSS,
// grouped by kind (main, renderer, gpu, network/utility, the native helper, anything else by name).
import { execFileSync } from 'node:child_process';

export const median = (xs) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** `[[h:]mm:]ss.cc` → seconds */
const cpuTime = (t) => t.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);

export function processTree(root) {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time=,rss=,args='], { encoding: 'utf8' });
  const all = out.trim().split('\n').map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    return m && { pid: +m[1], ppid: +m[2], cpu: cpuTime(m[3]), rssKB: +m[4], comm: m[5] };
  }).filter(Boolean);
  const keep = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of all) if (!keep.has(p.pid) && keep.has(p.ppid)) { keep.add(p.pid); grew = true; }
  }
  return all.filter((p) => keep.has(p.pid));
}

export function kindOf(p, root) {
  if (p.pid === root) return 'main';
  const a = p.comm;
  if (a.includes('--type=renderer')) return 'renderer';
  if (a.includes('--type=gpu-process')) return 'gpu';
  if (a.includes('--type=utility')) return 'utility';
  if (a.includes('appubot-helper')) return 'helper';
  if (a.includes('Electron Helper') || a.includes('--type=')) return 'other-electron';
  return a.split(' ')[0].split('/').pop();
}

export function treeCpuSeconds(root) {
  return Object.fromEntries(processTree(root).map((p) => [p.pid, { cpu: p.cpu, kind: kindOf(p, root) }]));
}

/** RSS (MB) per kind now, and CPU % per kind between two `treeCpuSeconds` samples. */
export function summarizeTree(root, start, end) {
  const rssMB = {};
  for (const p of processTree(root)) { const k = kindOf(p, root); rssMB[k] = +((rssMB[k] ?? 0) + p.rssKB / 1024).toFixed(1); }
  rssMB.total = +Object.values(rssMB).reduce((a, b) => a + b, 0).toFixed(1);
  if (!start || !end) return { rssMB };
  const secs = (end.at - start.at) / 1000;
  const cpuPct = {};
  for (const [pid, e] of Object.entries(end.cpu)) {
    const before = start.cpu[pid]?.cpu ?? 0;
    cpuPct[e.kind] = (cpuPct[e.kind] ?? 0) + ((e.cpu - before) / secs) * 100;
  }
  for (const k of Object.keys(cpuPct)) cpuPct[k] = +cpuPct[k].toFixed(2);
  cpuPct.total = +Object.values(cpuPct).reduce((a, b) => a + b, 0).toFixed(2);
  return { rssMB, cpuPct };
}
