/**
 * The menu bar glyph: the app icon ("Orange tile", scripts/make-icon.mjs) as a one-colour template image. The tile is
 * solid, the visor is cut out of it and the happy eyes are drawn back in the visor, so it reads like the logo in black
 * or white. Pure (no electron import): BGRA pixels, black with alpha, antialiased by supersampling.
 */

type Pt = readonly [number, number];

// the logo's geometry in tile units (make-icon.mjs: 1024 = the tile edge to edge); the eyes are bolder so they
// survive 18px
const TILE = { c: 512, half: 512, n: 5 };
const VISOR = { cx: 512, cy: 519, w: 733, h: 326, rot: -5 };
// in the visor's untilted frame: both eyes closed in a smile (the upper half of a circle)
const EYES = [{ x: -149, y: 37, r: 72 }, { x: 149, y: 37, r: 72 }];
const EYE_W = 64;

/** A point in the visor's own frame: the tilt undone, relative to its centre. */
function visorFrame(x: number, y: number): Pt {
  const a = (-VISOR.rot * Math.PI) / 180;
  const dx = x - VISOR.cx, dy = y - VISOR.cy;
  return [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
}

/** Inside the tile: macOS's superellipse. */
function inTile(x: number, y: number): boolean {
  const u = Math.abs(x - TILE.c) / TILE.half, v = Math.abs(y - TILE.c) / TILE.half;
  return u ** TILE.n + v ** TILE.n <= 1;
}

/** Inside the visor: a pill (a rounded rectangle whose radius is half its height). */
function inVisor(x: number, y: number): boolean {
  const [vx, vy] = visorFrame(x, y);
  const r = VISOR.h / 2;
  const qx = Math.max(Math.abs(vx) - (VISOR.w / 2 - r), 0);
  return Math.hypot(qx, vy) <= r;
}

/** On a happy eye: the upper half of a circle, stroked with round caps. */
function onEye(x: number, y: number): boolean {
  const [vx, vy] = visorFrame(x, y);
  return EYES.some(({ x: cx, y: cy, r }) => {
    if (vy <= cy && Math.abs(Math.hypot(vx - cx, vy - cy) - r) <= EYE_W / 2) return true;
    return Math.hypot(vx - (cx - r), vy - cy) <= EYE_W / 2 || Math.hypot(vx - (cx + r), vy - cy) <= EYE_W / 2;
  });
}

function filled(x: number, y: number): boolean {
  if (!inTile(x, y)) return false;
  return !inVisor(x, y) || onEye(x, y);
}

/** The glyph at `size`×`size` pixels (BGRA, black with alpha): the tile fills it but for a one-pixel margin (a whole
 *  pixel, so its edges stay crisp at 1x), centred. */
export function drawGlyph(size: number): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const pad = Math.max(1, Math.round(size / 36));
  const k = (size - 2 * pad) / (2 * TILE.half); // pixels per tile unit
  const SS = 4;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let hits = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const x = TILE.c + (px + (sx + 0.5) / SS - size / 2) / k;
      const y = TILE.c + (py + (sy + 0.5) / SS - size / 2) / k;
      if (filled(x, y)) hits++;
    }
    buf[(py * size + px) * 4 + 3] = Math.round((hits / (SS * SS)) * 255);
  }
  return buf;
}
