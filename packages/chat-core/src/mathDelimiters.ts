/**
 * LaTeX the way models write it, made what remark-math reads with `singleDollarTextMath: false` (so a price never
 * turns into maths): `\(…\)` and Pandoc-style `$…$` → inline `$$…$$`; `\[…\]` and a `$$…$$` alone on its line →
 * a `$$` block. Pandoc's rule tells maths from money: no space just inside either `$`, and no digit right after the
 * closing one ("$5 and $10" stays text). Code (fenced blocks and inline spans) is left alone. Used only when
 * "Render math" is on.
 */
export function normalizeMathDelimiters(text: string): string {
  if (!/\\[([]|\$/.test(text)) return text;
  // split into code and prose: fenced blocks, then inline code spans
  const parts = text.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/);
  return parts.map((p, i) => (i % 2 ? p : prose(p))).join('');
}

function prose(s: string): string {
  return s
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m: string) => `\n$$\n${m.trim()}\n$$\n`)
    .replace(/^([ \t]*)\$\$([^\n$]+?)\$\$[ \t]*$/gm, (_, indent: string, m: string) => `${indent}$$\n${indent}${m.trim()}\n${indent}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m: string) => `$$${m.trim()}$$`)
    .replace(/(?<![\\$])\$(?![\s$])([^$\n]*?[^\s\\$])\$(?![\d$])/g, (_, m: string) => `$$${m}$$`);
}
