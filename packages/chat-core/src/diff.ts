export type DiffLine = { kind: 'ctx' | 'add' | 'del'; text: string; oldNo?: number; newNo?: number };
export type DiffRow = DiffLine | { kind: 'gap'; count: number };

const MAX_CELLS = 400_000;

/** Line diff via LCS (falls back to whole-file replace for very large inputs). */
export function diffLines(oldText: string | null, newText: string): DiffLine[] {
  // a final newline ends the last line rather than starting an empty one
  const split = (t: string) => (t.endsWith('\n') ? t.slice(0, -1) : t).split('\n');
  const a = oldText ? split(oldText) : [];
  const b = newText ? split(newText) : [];
  if (!oldText) return b.map((text, i) => ({ kind: 'add', text, newNo: i + 1 }));
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text, i): DiffLine => ({ kind: 'del', text, oldNo: i + 1 })), ...b.map((text, i): DiffLine => ({ kind: 'add', text, newNo: i + 1 }))];
  }
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'ctx', text: a[i]!, oldNo: i + 1, newNo: j + 1 }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ kind: 'del', text: a[i]!, oldNo: i + 1 }); i++; }
    else { out.push({ kind: 'add', text: b[j]!, newNo: j + 1 }); j++; }
  }
  while (i < n) { out.push({ kind: 'del', text: a[i]!, oldNo: i + 1 }); i++; }
  while (j < m) { out.push({ kind: 'add', text: b[j]!, newNo: j + 1 }); j++; }
  return out;
}

/** Collapse long unchanged runs, keeping `context` lines around changes. */
export function collapse(lines: DiffLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.kind !== 'ctx') for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true;
  });
  const rows: DiffRow[] = [];
  let gap = 0;
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      if (gap) { rows.push({ kind: 'gap', count: gap }); gap = 0; }
      rows.push(l);
    } else gap++;
  });
  if (gap) rows.push({ kind: 'gap', count: gap });
  return rows;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) { if (l.kind === 'add') added++; else if (l.kind === 'del') removed++; }
  return { added, removed };
}
