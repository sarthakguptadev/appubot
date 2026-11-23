/**
 * An icon's strokes as few paths as its styles allow (`icons.tsx` draws them).
 *
 * Hugeicons draw an icon as several strokes that meet and cross (a globe's circle, meridian and equator; a copy icon's
 * two squares). In a see-through colour (muted text is 58% white, the work trail's icons 45%) every stroke paints its
 * share again where two overlap, so crossings and joints came out lighter or darker than the line. A browser strokes
 * one path as one shape, so the colour lands once: the parts are joined into one path wherever that draws the same.
 *
 * Two strokes can share a path when their line cap, line join, fill and opacity agree. A part that can't show a style
 * takes whatever its neighbours have: a closed outline has no ends, so no cap; a circle, an ellipse or a single
 * segment has no corners, so no join. That is what lets a globe's circle (no styles named) join its round-capped
 * equator, which the first version of this kept apart.
 */
export type IconPart = readonly [string, Readonly<Record<string, unknown>>];
export interface MergedPart { d: string; attrs: Record<string, unknown> }

/** A circle as path data (two arcs). */
const circleD = (a: Readonly<Record<string, unknown>>): string => {
  const cx = Number(a.cx), cy = Number(a.cy), r = Number(a.r);
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
};
/** An ellipse the same way. */
const ellipseD = (a: Readonly<Record<string, unknown>>): string => {
  const cx = Number(a.cx), cy = Number(a.cy), rx = Number(a.rx), ry = Number(a.ry);
  return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
};

/** the subpaths of a path's data, each from its own M */
const subpaths = (d: string): string[] => d.split(/(?=[Mm])/).map((s) => s.trim()).filter(Boolean);
/** every outline closed: nothing has an end for a cap to sit on */
const allClosed = (d: string): boolean => subpaths(d).every((s) => /[Zz]\s*$/.test(s));
/** how many numbers one segment of a command takes */
const ARGS: Record<string, number> = { L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 };
/** no two segments meet at a corner: each subpath is one open segment */
function noCorners(d: string): boolean {
  return subpaths(d).every((s) => {
    if (/[Zz]\s*$/.test(s)) return false;
    const commands = s.match(/[A-Za-z][^A-Za-z]*/g) ?? [];
    // the M (one point: more are implicit lines) and exactly one drawing command of one segment
    if (commands.length !== 2) return false;
    const [move, draw] = commands as [string, string];
    const count = (c: string) => (c.slice(1).match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).length;
    const args = ARGS[draw[0]!.toUpperCase()];
    return count(move) === 2 && args !== undefined && count(draw) === args;
  });
}

interface Group { d: string[]; cap: unknown; join: unknown; fill: unknown; opacity: unknown; attrs: Record<string, unknown> }
/** a style a part doesn't show: it fits any group's */
const ANY = Symbol('any');

export function mergeIconParts(icon: readonly IconPart[]): MergedPart[] {
  const groups: Group[] = [];
  for (const [tag, raw] of icon) {
    const { key: _key, d, cx: _cx, cy: _cy, r: _r, rx: _rx, ry: _ry, strokeWidth: _sw, ...attrs } = raw as Record<string, unknown>;
    const round = tag === 'circle' || tag === 'ellipse';
    const path = tag === 'circle' ? circleD(raw) : tag === 'ellipse' ? ellipseD(raw) : tag === 'path' ? String(d) : null;
    if (path === null) continue;
    const cap = round || allClosed(path) ? ANY : attrs.strokeLinecap;
    const join = round || noCorners(path) ? ANY : attrs.strokeLinejoin;
    const fits = (a: unknown, b: unknown) => a === ANY || b === ANY || a === b;
    const g = groups.find((x) => x.fill === attrs.fill && x.opacity === attrs.opacity && fits(x.cap, cap) && fits(x.join, join));
    if (!g) { groups.push({ d: [path], cap, join, fill: attrs.fill, opacity: attrs.opacity, attrs: { ...attrs } }); continue; }
    g.d.push(path);
    if (g.cap === ANY) g.cap = cap;
    if (g.join === ANY) g.join = join;
  }
  return groups.map((g) => {
    // the group's own cap and join, as the parts that show them asked (none named: the SVG defaults)
    const { strokeLinecap: _c, strokeLinejoin: _j, ...rest } = g.attrs;
    return {
      d: g.d.join(' '),
      attrs: { ...rest, ...(g.cap !== ANY && g.cap !== undefined ? { strokeLinecap: g.cap } : {}), ...(g.join !== ANY && g.join !== undefined ? { strokeLinejoin: g.join } : {}) },
    };
  });
}
