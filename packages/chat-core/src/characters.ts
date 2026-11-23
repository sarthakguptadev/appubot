/**
 * Custom characters (protocol `characters.ts`): a silhouette of the user's own that a bot wears instead of a built-in
 * shape, with AppuBot's glossy body, dark visor and eyes on it (botAvatar.ts draws it). Everything a character's
 * drawing goes through lives here, pure and shared by the computer, the desktop app and the phone:
 *
 * - `parsePathData`: a strict reader of SVG path data (commands and numbers only, length and segment limits), every
 *   command turned into absolute M/L/C/Q/Z (arcs into cubics), so what is drawn anywhere is our own serialization;
 * - `normalizeCharacter`: fits it into about 6..94 of the 100 box, closes every outline, rejects empty or hairline
 *   drawings, and places the visor (the one given, kept inside the body, else the roomiest spot, `findFace`);
 * - `importSvg`: geometry out of an SVG file (path, circle, ellipse, rect, polygon, polyline, with their transforms)
 *   merged into one path; nothing of the file is ever rendered;
 * - the generator's prompt and the reading of its reply (`characterPrompt`, `parseCharacterReply`).
 */
import {
  CHARACTER_BODY_CHARS, CHARACTER_BODY_MAX, CHARACTER_NAME_MAX, CHARACTER_PROMPT_MAX,
  type BotShape, type Character, type CharacterDraft, type CharacterFace,
} from '@appubot/protocol';

export type Pt = readonly [number, number];
/** A path in absolute commands only. */
export type PathSeg =
  | { k: 'M'; p: Pt }
  | { k: 'L'; p: Pt }
  | { k: 'C'; c1: Pt; c2: Pt; p: Pt }
  | { k: 'Q'; c: Pt; p: Pt }
  | { k: 'Z' };
export interface Box { x0: number; y0: number; x1: number; y1: number }

/** A generated or pasted path: at most this many characters and segments. */
export const CHARACTER_PATH_MAX = 6000;
export const CHARACTER_SEGMENTS_MAX = 400;
/** What a stored body may hold (our own serialization, arcs already cubics). */
export const CHARACTER_STORED_LIMITS: PathLimits = { maxChars: CHARACTER_BODY_MAX, maxSegments: 4000 };
/** An imported SVG: the file and all its shapes together. */
export const SVG_IMPORT_MAX = 500_000;
const IMPORT = { maxChars: 60_000, maxSegments: 2000 };

/** The box a body is fitted into (the built-in circle's). */
const FIT_LO = 6;
const FIT_HI = 94;
/** The visor's size at s = 1 (botAvatarLook) and the smallest and largest it gets on a character. */
const VISOR_W = 56;
const VISOR_H = 26;
export const FACE_MIN = 0.35;
export const FACE_MAX = 1;
/** Room left round the visor inside the body. */
const FACE_MARGIN = 2;
/** Less filled area than this (in the 100 box) is a line, not a character. */
const MIN_AREA = 0.04 * 88 * 88;
/** No coordinate beyond this (before fitting). */
const COORD_MAX = 100_000;

export interface PathLimits { maxChars: number; maxSegments: number }
export type PathResult = { ok: true; segs: PathSeg[] } | { ok: false; error: string };

class PathError extends Error {}

const ALLOWED = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]*$/;
const NUM = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const isSep = (c: string) => c === ' ' || c === ',' || c === '\n' || c === '\r' || c === '\t' || c === '\f';

/* ------------------------------------------------------------------ arcs */

/** One SVG arc as cubic Béziers (≤ 90° each), after the SVG spec's endpoint-to-centre conversion (F.6.5). */
function arcToCubics(x1: number, y1: number, rxIn: number, ryIn: number, deg: number, large: number, sweep: number, x2: number, y2: number): PathSeg[] {
  if (x1 === x2 && y1 === y2) return [];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (!rx || !ry) return [{ k: 'L', p: [x2, y2] }];
  const phi = (deg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy;
  const yp = -sin * dx + cos * dy;
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const den = rx2 * yp * yp + ry2 * xp * xp;
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, rx2 * ry2 - den) / (den || 1));
  const cxp = (coef * rx * yp) / ry;
  const cyp = (-coef * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (xp - cxp) / rx;
  const uy = (yp - cyp) / ry;
  const t1 = angle(1, 0, ux, uy);
  let dt = angle(ux, uy, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const step = dt / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const at = (a: number): Pt => [cx + rx * Math.cos(a) * cos - ry * Math.sin(a) * sin, cy + rx * Math.cos(a) * sin + ry * Math.sin(a) * cos];
  const tangent = (a: number): Pt => [-rx * Math.sin(a) * cos - ry * Math.cos(a) * sin, -rx * Math.sin(a) * sin + ry * Math.cos(a) * cos];
  const out: PathSeg[] = [];
  for (let j = 0; j < n; j++) {
    const a = t1 + j * step;
    const b = a + step;
    const pa = at(a);
    const pb: Pt = j === n - 1 ? [x2, y2] : at(b);
    const ta = tangent(a);
    const tb = tangent(b);
    out.push({ k: 'C', c1: [pa[0] + k * ta[0], pa[1] + k * ta[1]], c2: [pb[0] - k * tb[0], pb[1] - k * tb[1]], p: pb });
  }
  return out;
}

/* ------------------------------------------------------------------ reading path data */

/**
 * SVG path data as absolute M/L/C/Q/Z segments: only path commands, numbers and separators are accepted (anything
 * else, a missing number, a number past ±100000, too long or too many segments: an error saying so). H/V become L,
 * S/T their C/Q with the reflected control point, arcs cubics; a path starts with M.
 */
export function parsePathData(d: string, lim: PathLimits = { maxChars: CHARACTER_PATH_MAX, maxSegments: CHARACTER_SEGMENTS_MAX }): PathResult {
  if (typeof d !== 'string' || !d.trim()) return { ok: false, error: 'There is no drawing.' };
  if (d.length > lim.maxChars) return { ok: false, error: `The drawing is too detailed (over ${lim.maxChars} characters).` };
  if (!ALLOWED.test(d)) return { ok: false, error: 'The drawing has something other than path commands and numbers.' };
  try {
    return { ok: true, segs: readPath(d, lim.maxSegments) };
  } catch (e) {
    return { ok: false, error: e instanceof PathError ? e.message : 'The drawing could not be read.' };
  }
}

function readPath(d: string, maxSegments: number): PathSeg[] {
  const n = d.length;
  let i = 0;
  const ws = () => { while (i < n && isSep(d[i]!)) i++; };
  const num = (): number => {
    ws();
    NUM.lastIndex = i;
    const m = NUM.exec(d);
    if (!m) throw new PathError('A number is missing in the drawing.');
    i = NUM.lastIndex;
    const v = Number(m[0]);
    if (!Number.isFinite(v) || Math.abs(v) > COORD_MAX) throw new PathError('The drawing has a number out of range.');
    return v;
  };
  const flag = (): number => {
    ws();
    const c = d[i];
    if (c !== '0' && c !== '1') throw new PathError('An arc in the drawing has a bad flag.');
    i++;
    return c === '1' ? 1 : 0;
  };
  const segs: PathSeg[] = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let lastC: Pt | null = null;
  let lastQ: Pt | null = null;
  let cmd = '';
  let count = 0;
  const push = (s: PathSeg) => {
    // a drawing command right after Z starts a new outline where the last one began
    if (s.k !== 'M' && (!segs.length || segs[segs.length - 1]!.k === 'Z')) segs.push({ k: 'M', p: [cx, cy] });
    segs.push(s);
  };
  ws();
  if (i < n && d[i] !== 'M' && d[i] !== 'm') throw new PathError('The drawing must start with M.');
  for (;;) {
    ws();
    if (i >= n) break;
    const ch = d[i]!;
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
      if (ch === 'e' || ch === 'E') throw new PathError('The drawing has a stray letter.');
      cmd = ch;
      i++;
    } else if (!cmd || cmd === 'Z' || cmd === 'z') {
      throw new PathError('The drawing has numbers without a command.');
    }
    if (++count > maxSegments) throw new PathError(`The drawing is too detailed (over ${maxSegments} segments).`);
    const rel = cmd >= 'a';
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    const C = cmd.toUpperCase();
    let nextC: Pt | null = null;
    let nextQ: Pt | null = null;
    switch (C) {
      case 'Z':
        segs.push({ k: 'Z' });
        cx = sx; cy = sy;
        break;
      case 'M': {
        const x = ox + num(), y = oy + num();
        segs.push({ k: 'M', p: [x, y] });
        cx = sx = x; cy = sy = y;
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L': { const x = ox + num(), y = oy + num(); push({ k: 'L', p: [x, y] }); cx = x; cy = y; break; }
      case 'H': { const x = ox + num(); push({ k: 'L', p: [x, cy] }); cx = x; break; }
      case 'V': { const y = oy + num(); push({ k: 'L', p: [cx, y] }); cy = y; break; }
      case 'C': {
        const c1: Pt = [ox + num(), oy + num()], c2: Pt = [ox + num(), oy + num()], p: Pt = [ox + num(), oy + num()];
        push({ k: 'C', c1, c2, p });
        nextC = c2; cx = p[0]; cy = p[1];
        break;
      }
      case 'S': {
        const c1: Pt = lastC ? [2 * cx - lastC[0], 2 * cy - lastC[1]] : [cx, cy];
        const c2: Pt = [ox + num(), oy + num()], p: Pt = [ox + num(), oy + num()];
        push({ k: 'C', c1, c2, p });
        nextC = c2; cx = p[0]; cy = p[1];
        break;
      }
      case 'Q': {
        const c: Pt = [ox + num(), oy + num()], p: Pt = [ox + num(), oy + num()];
        push({ k: 'Q', c, p });
        nextQ = c; cx = p[0]; cy = p[1];
        break;
      }
      case 'T': {
        const c: Pt = lastQ ? [2 * cx - lastQ[0], 2 * cy - lastQ[1]] : [cx, cy];
        const p: Pt = [ox + num(), oy + num()];
        push({ k: 'Q', c, p });
        nextQ = c; cx = p[0]; cy = p[1];
        break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), large = flag(), sweep = flag();
        const x = ox + num(), y = oy + num();
        const arc = arcToCubics(cx, cy, rx, ry, rot, large, sweep, x, y);
        for (const s of arc) push(s);
        cx = x; cy = y;
        break;
      }
      default:
        throw new PathError(`The drawing has an unknown command "${cmd}".`);
    }
    lastC = nextC;
    lastQ = nextQ;
  }
  if (!segs.some((s) => s.k !== 'M' && s.k !== 'Z')) throw new PathError('There is no drawing.');
  return segs;
}

/* ------------------------------------------------------------------ geometry */

/** The exact box round the segments (curve extrema included). */
export function pathBounds(segs: readonly PathSeg[]): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  let cur: Pt = [0, 0];
  let start: Pt = [0, 0];
  const roots = (a: number, b: number, c: number): number[] => {
    if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? [] : [-c / b];
    const disc = b * b - 4 * a * c;
    if (disc < 0) return [];
    const q = Math.sqrt(disc);
    return [(-b + q) / (2 * a), (-b - q) / (2 * a)];
  };
  for (const s of segs) {
    if (s.k === 'Z') { cur = start; continue; }
    if (s.k === 'M') { start = cur = s.p; add(s.p[0], s.p[1]); continue; }
    add(s.p[0], s.p[1]);
    if (s.k === 'C') {
      for (const ax of [0, 1] as const) {
        const p0 = cur[ax], p1 = s.c1[ax], p2 = s.c2[ax], p3 = s.p[ax];
        for (const t of roots(-p0 + 3 * p1 - 3 * p2 + p3, 2 * (p0 - 2 * p1 + p2), p1 - p0)) {
          if (t > 0 && t < 1) {
            const v = cubicAt(cur, s.c1, s.c2, s.p, t);
            add(v[0], v[1]);
          }
        }
      }
    } else if (s.k === 'Q') {
      for (const ax of [0, 1] as const) {
        const den = cur[ax] - 2 * s.c[ax] + s.p[ax];
        if (Math.abs(den) < 1e-12) continue;
        const t = (cur[ax] - s.c[ax]) / den;
        if (t > 0 && t < 1) {
          const v = quadAt(cur, s.c, s.p, t);
          add(v[0], v[1]);
        }
      }
    }
    cur = s.p;
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

function cubicAt(a: Pt, b: Pt, c: Pt, d: Pt, t: number): Pt {
  const u = 1 - t;
  return [
    u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
    u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1],
  ];
}
function quadAt(a: Pt, b: Pt, c: Pt, t: number): Pt {
  const u = 1 - t;
  return [u * u * a[0] + 2 * u * t * b[0] + t * t * c[0], u * u * a[1] + 2 * u * t * b[1] + t * t * c[1]];
}

/** Every point of the segments through `f` (an affine map keeps Béziers exact). */
export function mapPath(segs: readonly PathSeg[], f: (p: Pt) => Pt): PathSeg[] {
  return segs.map((s): PathSeg => {
    switch (s.k) {
      case 'Z': return s;
      case 'M': case 'L': return { k: s.k, p: f(s.p) };
      case 'C': return { k: 'C', c1: f(s.c1), c2: f(s.c2), p: f(s.p) };
      case 'Q': return { k: 'Q', c: f(s.c), p: f(s.p) };
    }
  });
}

/** The segments split into outlines, each starting with M. */
function subpaths(segs: readonly PathSeg[]): PathSeg[][] {
  const out: PathSeg[][] = [];
  for (const s of segs) {
    if (s.k === 'M') out.push([s]);
    else if (out.length) out[out.length - 1]!.push(s);
  }
  return out.filter((sp) => sp.some((s) => s.k !== 'M' && s.k !== 'Z'));
}

/** Each outline closed (a filled outline is closed anyway), the last point back on the first. */
function closeAll(segs: readonly PathSeg[]): PathSeg[] {
  const out: PathSeg[] = [];
  for (const sp of subpaths(segs)) {
    const body = sp.filter((s) => s.k !== 'Z');
    const start = (body[0] as { p: Pt }).p;
    const end = (body[body.length - 1] as { p: Pt }).p;
    if (Math.abs(start[0] - end[0]) > 1e-9 || Math.abs(start[1] - end[1]) > 1e-9) body.push({ k: 'L', p: start });
    out.push(...body, { k: 'Z' });
  }
  return out;
}

/** An outline as a polygon (curves in short straight steps); outlines are taken as closed. */
function flatten(segs: readonly PathSeg[]): Pt[][] {
  const polys: Pt[][] = [];
  let cur: Pt = [0, 0];
  let poly: Pt[] | null = null;
  for (const s of segs) {
    if (s.k === 'M') { poly = [s.p]; polys.push(poly); cur = s.p; continue; }
    if (s.k === 'Z' || !poly) continue;
    if (s.k === 'L') poly.push(s.p);
    else if (s.k === 'C') for (let j = 1; j <= 12; j++) poly.push(cubicAt(cur, s.c1, s.c2, s.p, j / 12));
    else for (let j = 1; j <= 8; j++) poly.push(quadAt(cur, s.c, s.p, j / 8));
    cur = s.p;
  }
  return polys.filter((p) => p.length > 2);
}

function signedArea(poly: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** One outline drawn the other way round (same shape, opposite winding). */
function reverseSubpath(sp: readonly PathSeg[]): PathSeg[] {
  const closed = closeAll(sp).filter((s) => s.k !== 'Z');
  const pts = closed.map((s) => (s as { p: Pt }).p);
  const out: PathSeg[] = [{ k: 'M', p: pts[pts.length - 1]! }];
  for (let j = closed.length - 1; j >= 1; j--) {
    const s = closed[j]!;
    const to = pts[j - 1]!;
    if (s.k === 'C') out.push({ k: 'C', c1: s.c2, c2: s.c1, p: to });
    else if (s.k === 'Q') out.push({ k: 'Q', c: s.c, p: to });
    else out.push({ k: 'L', p: to });
  }
  out.push({ k: 'Z' });
  return out;
}

/**
 * Outlines turned the same way round, so overlapping parts add up under nonzero fill instead of cutting holes:
 * `each` outline on its own (a generated silhouette, which has no holes), or a whole group (an imported shape) by its
 * biggest outline, so holes it cut itself stay holes.
 */
export function orientPath(segs: readonly PathSeg[], each: boolean): PathSeg[] {
  const sps = subpaths(segs);
  if (each) return sps.flatMap((sp) => (signedArea(flatten(sp)[0] ?? []) < 0 ? reverseSubpath(sp) : closeAll(sp)));
  let big = 0;
  for (const sp of sps) {
    const a = signedArea(flatten(sp)[0] ?? []);
    if (Math.abs(a) > Math.abs(big)) big = a;
  }
  return big < 0 ? sps.flatMap(reverseSubpath) : sps.flatMap((sp) => closeAll(sp));
}

/** Where row `y` is inside the outlines (nonzero winding), as [from, to] spans left to right. */
function rowSpans(polys: readonly Pt[][], y: number): [number, number][] {
  const hits: { x: number; w: number }[] = [];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        hits.push({ x: a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), w: b[1] > a[1] ? 1 : -1 });
      }
    }
  }
  hits.sort((p, q) => p.x - q.x);
  const spans: [number, number][] = [];
  let wind = 0;
  let from = 0;
  for (const h of hits) {
    const was = wind;
    wind += h.w;
    if (!was && wind) from = h.x;
    else if (was && !wind) {
      const last = spans[spans.length - 1];
      if (last && h.x - last[1] < 1e-6 && from - last[1] < 1e-6) last[1] = h.x;
      else spans.push([from, h.x]);
    }
  }
  return spans;
}

/** The outlines' rows, one per unit of height (at the half), for the face and the area. */
interface Rows { y0: number; rows: [number, number][][] }
function scanRows(polys: readonly Pt[][]): Rows {
  const rows: [number, number][][] = [];
  for (let r = 0; r < 100; r++) rows.push(rowSpans(polys, r + 0.5));
  return { y0: 0.5, rows };
}

function filledArea(rows: Rows): number {
  let a = 0;
  for (const spans of rows.rows) for (const [l, r] of spans) a += r - l;
  return a;
}

/** How big the visor may be centred at (x, y) and stay inside the body, up to `max`. */
function fitAt(rows: Rows, x: number, y: number, max = FACE_MAX + 0.2): number {
  const fits = (s: number) => {
    const half = (VISOR_H * s) / 2 + FACE_MARGIN;
    const reach = (VISOR_W * s) / 2 + FACE_MARGIN;
    const top = Math.max(0, Math.floor(y - half));
    const bottom = Math.min(99, Math.ceil(y + half) - 1);
    if (y - half < 0 || y + half > 100) return false;
    for (let r = top; r <= bottom; r++) {
      const span = rows.rows[r]!.find(([l, rr]) => l <= x && rr >= x);
      if (!span || span[0] > x - reach || span[1] < x + reach) return false;
    }
    return true;
  };
  if (!fits(0.05)) return 0;
  let lo = 0.05, hi = max;
  if (fits(hi)) return hi;
  for (let k = 0; k < 14; k++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The roomiest place for the visor: as big as fits (up to the round bot's own size), in the widest part, a little
 * above the middle when several places fit as well. Never smaller than FACE_MIN (it then overhangs where it fits best).
 */
export function findFace(segs: readonly PathSeg[]): CharacterFace {
  const box = pathBounds(segs);
  if (!box) return { x: 50, y: 50, s: 1 };
  const rows = scanRows(flatten(segs));
  const pref = box.y0 + 0.47 * (box.y1 - box.y0);
  let best = { x: 50, y: (box.y0 + box.y1) / 2, s: 0, score: -Infinity };
  for (let y = Math.ceil(box.y0) + 4; y <= Math.floor(box.y1) - 4; y++) {
    const spans = rows.rows[Math.min(99, Math.max(0, y))] ?? [];
    const xs = new Set<number>();
    if (spans.some(([l, r]) => l <= 50 && r >= 50)) xs.add(50);
    const wide = [...spans].sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0];
    if (wide) xs.add(r2((wide[0] + wide[1]) / 2));
    for (const x of xs) {
      const s = Math.min(FACE_MAX, fitAt(rows, x, y));
      const score = Math.round(s * 50) / 50 - 0.004 * Math.abs(y - pref) - 0.002 * Math.abs(x - 50);
      if (score > best.score) best = { x, y, s, score };
    }
  }
  return { x: r2(best.x), y: r2(best.y), s: r2(Math.max(FACE_MIN, best.s)) };
}

/* ------------------------------------------------------------------ writing */

function fmt(n: number, places: number): string {
  const v = Number(n.toFixed(places));
  return String(Object.is(v, -0) ? 0 : v);
}

/** Our own path data (only M, L, C, Q, Z and plain decimals: `CHARACTER_BODY_CHARS`). */
export function serializePath(segs: readonly PathSeg[], places = 2): string {
  const p = (q: Pt) => `${fmt(q[0], places)} ${fmt(q[1], places)}`;
  return segs.map((s) => {
    switch (s.k) {
      case 'Z': return 'Z';
      case 'M': return `M${p(s.p)}`;
      case 'L': return `L${p(s.p)}`;
      case 'C': return `C${p(s.c1)} ${p(s.c2)} ${p(s.p)}`;
      case 'Q': return `Q${p(s.c)} ${p(s.p)}`;
    }
  }).join('');
}

export type CharacterShape = { ok: true; body: string; face: CharacterFace; box: Box } | { ok: false; error: string };

/**
 * A body ready to wear: read strictly (`parsePathData`; `limits` default to a pasted or generated path's), outlines
 * turned one way (`orient`: a generated silhouette's), fitted into 6..94 keeping its proportions, every outline
 * closed, and the visor placed: the given face (in the drawing's own coordinates; `x` unsent is the middle) moved with
 * it, kept inside the body's box and shrunk to fit inside the body, else the roomiest place (`findFace`). An empty,
 * dot-sized or hairline drawing is refused, and so is one too detailed to keep.
 */
export function normalizeCharacter(
  input: { body: string; face?: Partial<CharacterFace> | null },
  o: { limits?: PathLimits; orient?: boolean } = {},
): CharacterShape {
  const parsed = parsePathData(input.body, o.limits);
  if (!parsed.ok) return parsed;
  return normalizeSegments(parsed.segs, input.face, o.orient ?? false);
}

function normalizeSegments(segsIn: readonly PathSeg[], faceIn: Partial<CharacterFace> | null | undefined, orient: boolean): CharacterShape {
  const segs = orient ? orientPath(segsIn, true) : closeAll(segsIn);
  const box = pathBounds(segs);
  if (!box) return { ok: false, error: 'There is no drawing.' };
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  if (w < 0.5 || h < 0.5) return { ok: false, error: 'The drawing is too small or flat to wear.' };
  const k = (FIT_HI - FIT_LO) / Math.max(w, h);
  const dx = 50 - ((box.x0 + box.x1) / 2) * k;
  const dy = 50 - ((box.y0 + box.y1) / 2) * k;
  const fitted = mapPath(segs, (p) => [p[0] * k + dx, p[1] * k + dy]);
  const fbox = { x0: box.x0 * k + dx, y0: box.y0 * k + dy, x1: box.x1 * k + dx, y1: box.y1 * k + dy };
  const rows = scanRows(flatten(fitted));
  if (filledArea(rows) < MIN_AREA) return { ok: false, error: 'The drawing is too thin to wear: it needs a solid body.' };

  let face: CharacterFace | null = null;
  if (faceIn && Number.isFinite(faceIn.y) && faceIn.y !== undefined) {
    const s0 = Number.isFinite(faceIn.s) && faceIn.s ? faceIn.s * k : 1;
    let s = Math.min(FACE_MAX, Math.max(FACE_MIN, s0));
    const x = Number.isFinite(faceIn.x) && faceIn.x !== undefined ? faceIn.x * k + dx : (fbox.x0 + fbox.x1) / 2;
    const y = faceIn.y * k + dy;
    // kept inside the body's box (the visor whole), then as big as fits inside the body there
    const cx = Math.min(fbox.x1 - (VISOR_W * s) / 2, Math.max(fbox.x0 + (VISOR_W * s) / 2, x));
    const cy = Math.min(fbox.y1 - (VISOR_H * s) / 2, Math.max(fbox.y0 + (VISOR_H * s) / 2, y));
    const fit = fitAt(rows, cx, cy);
    if (fit >= FACE_MIN) {
      s = Math.min(s, fit);
      face = { x: r2(cx), y: r2(cy), s: r2(s) };
    }
  }
  face ??= findFace(fitted);

  for (const places of [2, 1]) {
    const body = serializePath(fitted, places);
    if (body.length <= CHARACTER_BODY_MAX) return { ok: true, body, face, box: fbox };
  }
  return { ok: false, error: 'The drawing is too detailed to keep.' };
}

/* ------------------------------------------------------------------ what the apps draw */

/** What a character's look needs: its body (our serialization) and where its visor goes. */
export type CharacterFigure = Pick<Character, 'body' | 'face'>;

const geometryCache = new Map<string, Box | null>();

/**
 * A stored body's box, read again strictly (anything that isn't our own serialization: null, and the app draws the
 * round bot instead). Kept for the bodies seen lately.
 */
export function characterBox(body: string): Box | null {
  const hit = geometryCache.get(body);
  if (hit !== undefined) return hit;
  let box: Box | null = null;
  if (typeof body === 'string' && body.length <= CHARACTER_BODY_MAX && CHARACTER_BODY_CHARS.test(body)) {
    const r = parsePathData(body, CHARACTER_STORED_LIMITS);
    if (r.ok) box = pathBounds(r.segs);
  }
  if (geometryCache.size > 200) geometryCache.delete(geometryCache.keys().next().value!);
  geometryCache.set(body, box);
  return box;
}

/** What a bot wears: its character when it has one in `characters`, else its shape. */
export function botFigure(bot: { shape: BotShape; characterId?: string } | null | undefined, characters: readonly Character[] | null | undefined): BotShape | CharacterFigure {
  if (!bot) return 'circle';
  const c = bot.characterId ? characters?.find((x) => x.id === bot.characterId) : undefined;
  return c ?? bot.shape;
}

/** Changes whenever the drawing would (body and face): the Telegram photo's key, the agent cursor's. */
export function characterKey(c: CharacterFigure): string {
  const text = `${c.body}|${c.face.x ?? 50},${c.face.y},${c.face.s}`;
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** A character's name on one line, without markup, at most CHARACTER_NAME_MAX characters. */
export function cleanCharacterName(name: string | null | undefined, fallback = 'Character'): string {
  const s = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f<>`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim();
  return (s.slice(0, CHARACTER_NAME_MAX).trim() || fallback).slice(0, CHARACTER_NAME_MAX);
}

/* ------------------------------------------------------------------ SVG import */

export type SvgImport =
  | { ok: true; body: string; face: CharacterFace; shapes: number; notes: string[] }
  | { ok: false; error: string; notes: string[] };

type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix) => (p: Pt): Pt => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

/** An SVG `transform` list as one matrix; null when it can't be read. */
export function parseTransform(t: string): Matrix | null {
  let m: Matrix = IDENTITY;
  const re = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)\s*,?/gy;
  let pos = 0;
  const src = t.trim();
  while (pos < src.length) {
    re.lastIndex = pos;
    const hit = re.exec(src);
    if (!hit) return null;
    pos = re.lastIndex;
    const a = (hit[2]!.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []).map(Number);
    if (a.some((v) => !Number.isFinite(v))) return null;
    const rad = (deg: number) => (deg * Math.PI) / 180;
    let n: Matrix;
    switch (hit[1]) {
      case 'matrix': if (a.length !== 6) return null; n = a as unknown as Matrix; break;
      case 'translate': n = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]; break;
      case 'scale': n = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const c = Math.cos(rad(a[0] ?? 0)), s = Math.sin(rad(a[0] ?? 0));
        const [px, py] = [a[1] ?? 0, a[2] ?? 0];
        n = mul(mul([1, 0, 0, 1, px, py], [c, s, -s, c, 0, 0]), [1, 0, 0, 1, -px, -py]);
        break;
      }
      case 'skewX': n = [1, 0, Math.tan(rad(a[0] ?? 0)), 1, 0, 0]; break;
      default: n = [1, Math.tan(rad(a[0] ?? 0)), 0, 1, 0, 0]; break;
    }
    m = mul(m, n);
  }
  return m;
}

/** Elements whose insides never draw by themselves (or aren't geometry). */
const SKIP_INSIDE = new Set(['defs', 'clippath', 'mask', 'symbol', 'pattern', 'marker', 'lineargradient', 'radialgradient', 'filter', 'style', 'script', 'title', 'desc', 'metadata', 'foreignobject', 'text', 'switch']);
const SHAPES = new Set(['path', 'circle', 'ellipse', 'rect', 'polygon', 'polyline']);

function attrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? '';
  return out;
}

/** A length attribute in user units (px or none); null for %, em or anything else. */
function len(v: string | undefined, dflt: number | null = 0): number | null {
  if (v === undefined || v.trim() === '') return dflt;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px)?\s*$/.exec(v);
  return m ? Number(m[1]) : null;
}

/** `fill: none` / hidden in the attribute or its inline style. */
function styleOf(a: Record<string, string>, name: string): string | undefined {
  const inStyle = a.style ? new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i').exec(a.style)?.[1] : undefined;
  return (inStyle ?? a[name])?.trim().toLowerCase();
}

/** One shape element as path data in its own coordinates; null with a note when it can't be. */
function shapeData(tag: string, a: Record<string, string>): string | null {
  const n = (v: number) => String(+v.toFixed(4));
  switch (tag) {
    case 'path': return a.d ?? null;
    case 'circle': {
      const cx = len(a.cx), cy = len(a.cy), r = len(a.r, null);
      if (cx === null || cy === null || r === null || r <= 0) return null;
      return `M${n(cx - r)} ${n(cy)}A${n(r)} ${n(r)} 0 1 0 ${n(cx + r)} ${n(cy)}A${n(r)} ${n(r)} 0 1 0 ${n(cx - r)} ${n(cy)}Z`;
    }
    case 'ellipse': {
      const cx = len(a.cx), cy = len(a.cy), rx = len(a.rx, null), ry = len(a.ry, null);
      if (cx === null || cy === null || rx === null || ry === null || rx <= 0 || ry <= 0) return null;
      return `M${n(cx - rx)} ${n(cy)}A${n(rx)} ${n(ry)} 0 1 0 ${n(cx + rx)} ${n(cy)}A${n(rx)} ${n(ry)} 0 1 0 ${n(cx - rx)} ${n(cy)}Z`;
    }
    case 'rect': {
      const x = len(a.x), y = len(a.y), w = len(a.width, null), h = len(a.height, null);
      if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) return null;
      let rx = len(a.rx, null);
      let ry = len(a.ry, null);
      if (rx === null && ry !== null) rx = ry;
      if (ry === null && rx !== null) ry = rx;
      rx = Math.min(Math.max(0, rx ?? 0), w / 2);
      ry = Math.min(Math.max(0, ry ?? 0), h / 2);
      if (!rx || !ry) return `M${n(x)} ${n(y)}H${n(x + w)}V${n(y + h)}H${n(x)}Z`;
      return `M${n(x + rx)} ${n(y)}H${n(x + w - rx)}A${n(rx)} ${n(ry)} 0 0 1 ${n(x + w)} ${n(y + ry)}V${n(y + h - ry)}`
        + `A${n(rx)} ${n(ry)} 0 0 1 ${n(x + w - rx)} ${n(y + h)}H${n(x + rx)}A${n(rx)} ${n(ry)} 0 0 1 ${n(x)} ${n(y + h - ry)}`
        + `V${n(y + ry)}A${n(rx)} ${n(ry)} 0 0 1 ${n(x + rx)} ${n(y)}Z`;
    }
    case 'polygon':
    case 'polyline': {
      const v = (a.points ?? '').match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g)?.map(Number) ?? [];
      if (v.length < 6) return null;
      let d = '';
      for (let j = 0; j + 1 < v.length; j += 2) d += `${j ? 'L' : 'M'}${n(v[j]!)} ${n(v[j + 1]!)}`;
      return `${d}Z`;
    }
  }
  return null;
}

/** `src` without everything from each `open` to its `close` (to the end when unclosed), in one pass. */
function cut(src: string, open: string, close: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const i = src.indexOf(open, at);
    if (i < 0) return out + src.slice(at);
    out += src.slice(at, i);
    const j = src.indexOf(close, i + open.length);
    if (j < 0) return out;
    at = j + close.length;
  }
}

/**
 * A character out of an SVG file: the filled geometry of its paths, circles, ellipses, rects, polygons and polylines
 * (with their own and their groups' transforms), merged into one path and fitted like any body. Only geometry is read
 * (never rendered): scripts, styles, images, text, `<use>`, gradients and the like are left out; outline-only
 * (`fill="none"`) and hidden shapes too. `notes` says what was left out.
 */
export function importSvg(text: string): SvgImport {
  const notes = new Set<string>();
  const fail = (error: string): SvgImport => ({ ok: false, error, notes: [...notes] });
  if (typeof text !== 'string' || !text.trim()) return fail('The file is empty.');
  if (text.length > SVG_IMPORT_MAX) return fail('The file is too big (over 500 KB).');
  // comments, CDATA, doctype and processing instructions say nothing about the shape
  let src = cut(cut(cut(text, '<!--', '-->'), '<![CDATA[', ']]>'), '<?', '?>');
  src = cut(src, '<!', '>');
  if (!/<(?:svg:)?svg[\s>]/i.test(src)) return fail('That isn’t an SVG file.');

  const stack: { tag: string; m: Matrix; skip: boolean }[] = [];
  const all: PathSeg[] = [];
  let shapes = 0;
  let total = 0;
  let segCount = 0;
  // attribute text stops at the next "<" (also inside quotes), so a broken file can't make this scan quadratic
  const tagRe = /<\s*(\/)?\s*([a-zA-Z][\w:.-]*)((?:[^>"'<]|"[^"<]*"|'[^'<]*')*?)(\/)?\s*>/g;
  for (let t = tagRe.exec(src); t; t = tagRe.exec(src)) {
    const tag = t[2]!.toLowerCase().replace(/^svg:/, '');
    if (t[1]) {
      // back out to the matching element (sloppy nesting tolerated)
      const at = stack.map((x) => x.tag).lastIndexOf(tag);
      if (at >= 0) stack.length = at;
      continue;
    }
    const selfClosing = !!t[4];
    const top = stack[stack.length - 1];
    const a = attrs(t[3] ?? '');
    if (tag === 'script' || tag === 'style') notes.add('Scripts and styles are ignored.');
    else if (tag === 'image') notes.add('Pictures inside the file are left out.');
    else if (tag === 'use') notes.add('Reused parts (<use>) are left out.');
    else if (tag === 'text') notes.add('Text is left out.');
    let m = top?.m ?? IDENTITY;
    if (a.transform) {
      const tm = parseTransform(a.transform);
      if (tm) m = mul(m, tm);
      else notes.add('A transform could not be read and was ignored.');
    }
    const hidden = styleOf(a, 'display') === 'none' || styleOf(a, 'visibility') === 'hidden' || styleOf(a, 'opacity') === '0';
    const node = { tag, m, skip: (top?.skip ?? false) || SKIP_INSIDE.has(tag) || hidden };
    if (!selfClosing) stack.push(node);
    if (!SHAPES.has(tag) || node.skip) continue;
    if (styleOf(a, 'fill') === 'none' || styleOf(a, 'fill-opacity') === '0') { notes.add('Outline-only shapes are left out (only filled areas count).'); continue; }
    const d = shapeData(tag, a);
    if (d === null) { notes.add('A shape with sizes AppuBot can’t read (like percentages) was left out.'); continue; }
    total += d.length;
    if (total > IMPORT.maxChars || segCount >= IMPORT.maxSegments) return fail('The drawing is too detailed to import.');
    const parsed = parsePathData(d, { maxChars: IMPORT.maxChars, maxSegments: IMPORT.maxSegments - segCount });
    if (!parsed.ok) {
      if (/too detailed/.test(parsed.error)) return fail('The drawing is too detailed to import.');
      notes.add('A shape that couldn’t be read was left out.');
      continue;
    }
    segCount += parsed.segs.length;
    // its outlines turned one way as a whole (holes it cuts stay holes), then put where its transforms say; a
    // mirroring transform turns them over, so they are turned back
    let segs = mapPath(orientPath(parsed.segs, false), apply(m));
    if (m[0] * m[3] - m[1] * m[2] < 0) segs = subpaths(segs).flatMap(reverseSubpath);
    all.push(...segs);
    shapes++;
    if (styleOf(a, 'fill-rule') === 'evenodd') notes.add('Holes drawn with the even-odd rule may fill in.');
  }
  if (!shapes) return fail('No filled shapes were found in the file.');
  const r = normalizeSegments(all, null, false);
  if (!r.ok) return fail(r.error);
  return { ok: true, body: r.body, face: r.face, shapes, notes: [...notes] };
}

/* ------------------------------------------------------------------ the generator */

/** How many candidates one generation asks for. */
export const CHARACTER_CANDIDATES = 3;

/** The user's description, one line, at most CHARACTER_PROMPT_MAX characters, quotes evened out. */
export function cleanCharacterPrompt(prompt: string): string {
  return prompt.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').replace(/"/g, '\'').trim().slice(0, CHARACTER_PROMPT_MAX);
}

/** What the user's agent is asked (a hidden one-off session, no tools): JSON with `n` characters. */
export function characterPrompt(description: string, n = CHARACTER_CANDIDATES): string {
  return [
    'You design avatar characters for AppuBot. Reply with JSON only: no prose, no code fence. Use no tools and make no files.',
    '',
    `Draw ${n} different takes on: "${cleanCharacterPrompt(description)}"`,
    '',
    'Each one is a cute, simple, bold silhouette in a 100×100 box (y grows downwards), drawn as ONE SVG path "d" filled with fill-rule nonzero:',
    '- one closed solid shape, or a few overlapping closed shapes (body, ears, horns, tail, feet…) in the same path, each closed with Z and all drawn clockwise',
    '- no eyes, mouth, face details, holes or outlines: AppuBot puts its own dark visor with glowing eyes on top',
    '- it must read at 24 px: chunky parts, no thin lines or tiny details, and one big rounded area for the face',
    '- fill most of the box (about 8 to 92), commands M L H V C S Q T A Z only, at most 1500 characters',
    '- face: where the visor\'s centre goes and its size (s 1 = 56 wide and 26 tall; 0.6 to 1), inside the body in its widest part',
    '',
    `{"characters":[{"name":"1 to 3 words","body":"M…Z","face":{"x":50,"y":56,"s":0.9}}${n > 1 ? ', …' : ''}]}`,
  ].join('\n');
}

/** The follow-up when the reply had nothing usable. */
export function characterRetryPrompt(error: string, n = CHARACTER_CANDIDATES): string {
  return `That couldn't be used: ${error.replace(/\s+/g, ' ').slice(0, 300)}\nReply again with JSON only, in the same form: {"characters":[{"name":"…","body":"M…Z","face":{"x":50,"y":56,"s":0.9}}]} with ${n} characters, each body one closed, solid path of M L H V C S Q T A Z commands and numbers.`;
}

/** The JSON in a reply: as is, inside a code fence, or the outermost {…} / […] in prose. */
function jsonIn(text: string): unknown {
  const tries: string[] = [text.trim()];
  for (const m of text.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)) tries.push(m[1]!.trim());
  const o = text.indexOf('{');
  const oc = text.lastIndexOf('}');
  if (o >= 0 && oc > o) tries.push(text.slice(o, oc + 1));
  const a = text.indexOf('[');
  const ac = text.lastIndexOf(']');
  if (a >= 0 && ac > a) tries.push(text.slice(a, ac + 1));
  for (const t of tries) {
    try { return JSON.parse(t); } catch { /* the next */ }
  }
  return undefined;
}

/**
 * The usable characters in the generator's reply (`{"characters": […]}`, a bare list or one object; code fences and
 * prose round it tolerated), each read and fitted like any body, its name cleaned; `errors` say why the others weren't.
 */
export function parseCharacterReply(text: string, n = CHARACTER_CANDIDATES): { drafts: CharacterDraft[]; errors: string[] } {
  const errors: string[] = [];
  const data = jsonIn(String(text ?? ''));
  if (data === undefined) return { drafts: [], errors: ['the reply was not JSON'] };
  const list: unknown[] = Array.isArray(data) ? data
    : data && typeof data === 'object' && Array.isArray((data as { characters?: unknown }).characters) ? (data as { characters: unknown[] }).characters
      : [data];
  const drafts: CharacterDraft[] = [];
  const seen = new Set<string>();
  for (const item of list.slice(0, n * 2)) {
    if (!item || typeof item !== 'object') { errors.push('a character was not an object'); continue; }
    const it = item as { name?: unknown; body?: unknown; d?: unknown; path?: unknown; face?: unknown };
    const body = [it.body, it.d, it.path].find((v): v is string => typeof v === 'string');
    if (!body) { errors.push('a character had no body path'); continue; }
    const f = it.face && typeof it.face === 'object' ? it.face as Record<string, unknown> : null;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
    const face = f && num(f.y) !== undefined ? { x: num(f.x), y: num(f.y)!, s: num(f.s) } : null;
    const r = normalizeCharacter({ body, face: face as Partial<CharacterFace> | null }, { orient: true });
    if (!r.ok) { errors.push(r.error); continue; }
    if (seen.has(r.body)) continue;
    seen.add(r.body);
    drafts.push({ name: cleanCharacterName(typeof it.name === 'string' ? it.name : ''), body: r.body, face: r.face });
    if (drafts.length >= n) break;
  }
  if (!list.length) errors.push('the reply listed no characters');
  return { drafts, errors };
}
