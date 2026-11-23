// The empty chat's animated dithered field (Settings › Appearance › Animated background): blotches of 1-bit dots in the
// page's own ink shading in and out as noise drifts, cycling through three looks, with a ripple where you click empty
// space that rings out as a denser band of dots (in the bot's colour, or a random member's in a group; the accent
// elsewhere).
// The field, its looks, speeds, ripples and lifecycle are ported from Synara's AsciiWaveBackground
// (apps/web/src/components/chat/AsciiWaveBackground.tsx, https://github.com/emanuele-web04/synara, MIT, (c) 2026 T3
// Tools Inc. and Emanuele Di Pietro), where they were drawn as letters. AppuBot's changes: drawn as an ordered (8×8
// Bayer) dither on a grid of `DOT_PX` squares, one byte-sized pixel per dot scaled up with no smoothing, so the dots
// stay crisp at any device pixel ratio; the ink and accent are the theme's `--ab-fg`/`--ab-accent`; built on the next
// frame and shown at once; drawing also stops while the window isn't focused; still under Reduce motion, where only a
// click ripples. Pure parts in ditherField.ts.
import { useEffect, useRef } from 'react';
import { useReducedMotion } from 'motion/react';
import { useIsDark } from '../../lib/theme';
import {
  BAYER8, FIELD_PATTERNS, RIPPLE_LIFETIME_MS, RIPPLE_SHOWS, RIPPLE_WOBBLE_PX, dotDensity, inkLevel, lerp, rippleAt,
  rippleDensity, sampleField, smoothstep, valueNoise3,
} from './ditherField';

/** a dot's side in CSS px (rounded to whole device pixels, so every dot is the same crisp square) */
const DOT_PX = 3;
/** how strong a lit dot is: the theme's ink at this alpha (the field never lights more than DOT_DENSITY_MAX of them) */
const DOT_ALPHA = 0.2;
/** a lit dot of a ripple: the accent at this alpha */
const ACCENT_ALPHA = 0.7;
/** bounds the canvas even on large Retina windows */
const MAX_BACKING_PIXELS = 4_000_000;
/** the idle field drifts slowly: 15 fps on a plain timer; only click ripples run on animation frames */
const IDLE_FRAME_MS = 1000 / 15;
const RIPPLE_FRAME_MS = 1000 / 40;
const MAX_RIPPLES = 6;
/** the field cycles through its looks, cross-fading from one to the next */
const PATTERN_MS = 20_000;
const CROSSFADE_MS = 4_000;
/** the field is sampled every ~this many CSS px and interpolated between (blotches and rings are far larger) */
const LATTICE_PX = 15;
/** shown at once: built on the next frame, then a short fade in (the dots fill in, as a dither fades) */
const REVEAL_MS = 180;
/** clicks on controls and text keep their own meaning and don't ripple */
const INTERACTIVE =
  "a,button,input,textarea,select,label,[contenteditable='true'],[role='button'],[role='combobox'],[role='menuitem'],[role='option'],[role='textbox'],[role='dialog'],[role='menu'],[role='listbox']";
/** a press that travels farther than this is a drag (selecting text), not a click */
const CLICK_SLOP_PX = 4;

interface Ripple { x: number; y: number; startMs: number; phaseA: number; phaseB: number; colour?: string }

/** One pixel per dot, written as whole RGBA words, scaled up onto the canvas with no smoothing. */
interface Field {
  cols: number;
  rows: number;
  /** a dot's side in device pixels */
  cell: number;
  grid: HTMLCanvasElement;
  gridCtx: CanvasRenderingContext2D;
  image: ImageData;
  pixels: Uint32Array;
  /** the lattice: one sample every `step` dots each way */
  step: number;
  latticeCols: number;
  level: Float32Array;
  patch: Float32Array;
  ripple: Float32Array;
}

/** a CSS colour as one little-endian RGBA word at `alpha` (what a Uint32Array over ImageData bytes holds) */
function packColour(css: string, alpha: number): number {
  const probe = document.createElement('canvas');
  probe.width = probe.height = 1;
  const c = probe.getContext('2d');
  if (!c) return 0;
  c.fillStyle = '#888';
  c.fillStyle = css;
  c.fillRect(0, 0, 1, 1);
  const [r = 136, g = 136, b = 136] = c.getImageData(0, 0, 1, 1).data;
  return ((Math.round(alpha * 255) << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** the theme's ink and accent as the page has them now (after `.dark` moved) */
function themeColours(): { ink: string; accent: string } {
  const css = getComputedStyle(document.documentElement);
  return {
    ink: css.getPropertyValue('--ab-fg').trim() || '#888',
    accent: css.getPropertyValue('--ab-accent').trim() || '#f58056',
  };
}

/**
 * `colours`: what a click's ripple is drawn in, one picked at random per click (a chat: its bot's colour; a group:
 * its members'); none, the theme's accent. The newest ripple's colour colours every ripple still showing.
 */
export function DitherBackground({ colours }: { colours?: readonly string[] } = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const palette = useRef(colours);
  palette.current = colours;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduce = !!useReducedMotion();
  // the colours are read when the field is built; a scheme change rebuilds it
  const dark = useIsDark();

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!container || !canvas || !ctx) return;

    let width = 0;
    let height = 0;
    let inkWord = 0;
    let accent = '#f58056';
    const accentWords = new Map<string, number>();
    const accentWord = (css: string) => {
      let word = accentWords.get(css);
      if (word === undefined) accentWords.set(css, (word = packColour(css, ACCENT_ALPHA)));
      return word;
    };
    let field: Field | null = null;
    let ripples: Ripple[] = [];
    let frameId = 0;
    let timerId = 0;
    let lastFrameMs = 0;
    const startMs = performance.now();
    let revealStartMs: number | null = null;
    // each mount starts somewhere new in the noise and on a random look
    const seed = Math.random() * 1000;
    const firstPattern = Math.floor(Math.random() * FIELD_PATTERNS.length);

    const build = () => {
      const rect = container.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_BACKING_PIXELS / Math.max(1, width * height)));
      revealStartMs = null;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      field = null;
      // hidden or not laid out yet: the ResizeObserver builds it once there's room
      if (width < 1 || height < 1) return;
      const cell = Math.max(1, Math.round(DOT_PX * dpr));
      const cols = Math.ceil(canvas.width / cell);
      const rows = Math.ceil(canvas.height / cell);
      const grid = document.createElement('canvas');
      grid.width = cols;
      grid.height = rows;
      const gridCtx = grid.getContext('2d');
      if (!gridCtx) return;
      const colours = themeColours();
      inkWord = packColour(colours.ink, DOT_ALPHA);
      accent = colours.accent;
      accentWords.clear();
      const image = gridCtx.createImageData(cols, rows);
      const step = Math.max(1, Math.round(LATTICE_PX / (cell / dpr)));
      const latticeCols = Math.ceil(cols / step) + 1;
      const latticeSize = latticeCols * (Math.ceil(rows / step) + 1);
      field = {
        cols, rows, cell, grid, gridCtx, image, pixels: new Uint32Array(image.data.buffer), step, latticeCols,
        level: new Float32Array(latticeSize), patch: new Float32Array(latticeSize), ripple: new Float32Array(latticeSize),
      };
    };

    const draw = (nowMs: number) => {
      const f = field;
      if (!f) return;
      if (revealStartMs === null) revealStartMs = nowMs;
      const reveal = reduce ? 1 : smoothstep(0, REVEAL_MS, nowMs - revealStartMs);
      const { cols, rows, cell, step, latticeCols, pixels } = f;
      const cssCell = (cell * width) / canvas.width;
      const fieldMs = reduce ? startMs : nowMs;
      const t = fieldMs / 1000 + seed;
      const elapsed = fieldMs - startMs;
      const cycle = Math.floor(elapsed / PATTERN_MS);
      const pattern = FIELD_PATTERNS[(firstPattern + cycle) % FIELD_PATTERNS.length]!;
      const mix = smoothstep(PATTERN_MS - CROSSFADE_MS, PATTERN_MS, elapsed % PATTERN_MS);
      const next = mix > 0 ? FIELD_PATTERNS[(firstPattern + cycle + 1) % FIELD_PATTERNS.length]! : null;
      const cx = width / 2;
      const cy = height / 2;
      ripples = ripples.filter((r) => nowMs - r.startMs < RIPPLE_LIFETIME_MS);
      const rippling = ripples.length > 0;
      const shapes = ripples.map((r) => ({ ageMs: nowMs - r.startMs, phaseA: r.phaseA, phaseB: r.phaseB, x: r.x, y: r.y }));

      // the field (and the rings) on the lattice, in CSS px
      const latticeRows = f.level.length / latticeCols;
      for (let ly = 0; ly < latticeRows; ly++) {
        const y = ly * step * cssCell;
        for (let lx = 0; lx < latticeCols; lx++) {
          const x = lx * step * cssCell;
          let { patch, wave } = sampleField(pattern, x, y, cx, cy, t);
          if (next) {
            const n = sampleField(next, x, y, cx, cy, t);
            patch += (n.patch - patch) * mix;
            wave += (n.wave - wave) * mix;
          }
          const i = ly * latticeCols + lx;
          f.level[i] = inkLevel(patch, wave, x, y, width, height) * reveal;
          f.patch[i] = patch;
          if (rippling) {
            // shared per spot: bends every ripple's ring the same organic way
            const warp = (valueNoise3(x / 60, y / 60, t * 0.6) - 0.5) * RIPPLE_WOBBLE_PX;
            let ripple = 0;
            for (const r of shapes) ripple += rippleAt(r, x - r.x, y - r.y, warp, t);
            f.ripple[i] = Math.min(1, ripple);
          }
        }
      }

      // each dot: its level against the matrix (thresholds as 0..63 counts, so the compare stays in integers' terms)
      const ink = inkWord;
      const ringWord = rippling ? accentWord(ripples[ripples.length - 1]?.colour ?? accent) : 0;
      for (let row = 0; row < rows; row++) {
        const ly = (row / step) | 0;
        const fy = (row - ly * step) / step;
        const bayerRow = (row & 7) << 3;
        const rowStart = row * cols;
        for (let col = 0; col < cols; col++) {
          const lx = (col / step) | 0;
          const fx = (col - lx * step) / step;
          const top = ly * latticeCols + lx;
          const bottom = top + latticeCols;
          const threshold = BAYER8[bayerRow | (col & 7)]! + 0.5;
          const level = lerp(lerp(f.level[top]!, f.level[top + 1]!, fx), lerp(f.level[bottom]!, f.level[bottom + 1]!, fx), fy);
          let word = 0;
          if (rippling) {
            const ripple = lerp(lerp(f.ripple[top]!, f.ripple[top + 1]!, fx), lerp(f.ripple[bottom]!, f.ripple[bottom + 1]!, fx), fy);
            if (ripple >= RIPPLE_SHOWS) {
              const patch = lerp(lerp(f.patch[top]!, f.patch[top + 1]!, fx), lerp(f.patch[bottom]!, f.patch[bottom + 1]!, fx), fy);
              if (rippleDensity(ripple, level, patch) * 64 > threshold) word = ringWord;
              pixels[rowStart + col] = word;
              continue;
            }
          }
          if (dotDensity(level) * 64 > threshold) word = ink;
          pixels[rowStart + col] = word;
        }
      }

      f.gridCtx.putImageData(f.image, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(f.grid, 0, 0, cols, rows, 0, 0, cols * cell, rows * cell);
    };

    // hidden, or not focused (the user is elsewhere) once it has faded in: no drawing at all
    const paused = (nowMs: number) =>
      document.hidden || (!document.hasFocus() && revealStartMs !== null && nowMs - revealStartMs >= REVEAL_MS);

    const schedule = (delayMs: number) => {
      if (ripples.length) frameId = requestAnimationFrame(tick);
      else timerId = window.setTimeout(() => { timerId = 0; tick(performance.now()); }, delayMs);
    };

    function tick(nowMs: number) {
      frameId = 0;
      // not built yet (the build wakes it) or paused (focus and visibility wake it)
      if (!field || paused(nowMs)) return;
      // a view kept under an invisible parent: no canvas work there; a slow retry notices it coming back
      if (typeof container!.checkVisibility === 'function' && !container!.checkVisibility({ visibilityProperty: true, opacityProperty: true })) {
        timerId = window.setTimeout(() => { timerId = 0; tick(performance.now()); }, 1000);
        return;
      }
      const interval = ripples.length ? RIPPLE_FRAME_MS : IDLE_FRAME_MS;
      if (nowMs - lastFrameMs >= interval) {
        lastFrameMs = nowMs;
        draw(nowMs);
      }
      // Reduce motion keeps a still field and only animates while it fades in or a ripple lives
      const revealing = revealStartMs === null || nowMs - revealStartMs < REVEAL_MS;
      if (!reduce || revealing || ripples.length) schedule(Math.max(0, lastFrameMs + IDLE_FRAME_MS - nowMs));
    }

    // draw soon; a waiting idle timer is kept unless a new ripple needs frame-rate updates
    const wake = () => {
      if (frameId !== 0) return;
      if (timerId !== 0) {
        if (!ripples.length) return;
        window.clearTimeout(timerId);
        timerId = 0;
      }
      schedule(0);
    };

    // listen on the empty chat itself: its heading, suggestions and composer sit above the canvas.
    // A plain click on empty space ripples, after the press ends; drags, selections and controls are left alone.
    const host = container.parentElement ?? container;
    let press: { id: number; x: number; y: number } | null = null;
    const onPointerDown = (e: PointerEvent) => {
      press = null;
      if (e.button !== 0 || !e.isPrimary) return;
      if (e.target instanceof Element && e.target.closest(INTERACTIVE)) return;
      press = { id: e.pointerId, x: e.clientX, y: e.clientY };
    };
    const onPointerUp = (e: PointerEvent) => {
      const start = press;
      press = null;
      if (!start || start.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_SLOP_PX) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const rect = container.getBoundingClientRect();
      ripples.push({
        x: e.clientX - rect.left, y: e.clientY - rect.top, startMs: performance.now(),
        phaseA: Math.random() * Math.PI * 2, phaseB: Math.random() * Math.PI * 2,
        ...(palette.current?.length ? { colour: palette.current[Math.floor(Math.random() * palette.current.length)] } : {}),
      });
      if (ripples.length > MAX_RIPPLES) ripples.shift();
      wake();
    };
    host.addEventListener('pointerdown', onPointerDown, { passive: true });
    host.addEventListener('pointerup', onPointerUp, { passive: true });

    // building (the canvases, the lattice) runs on the next frame, so the field is there as the chat shows
    let buildFrame = 0;
    const rebuild = () => {
      cancelAnimationFrame(buildFrame);
      buildFrame = requestAnimationFrame(() => {
        buildFrame = 0;
        build();
        lastFrameMs = 0;
        wake();
      });
    };
    rebuild();
    // the first observation is the size it already has; later ones are resizes
    const resizeObserver = new ResizeObserver(() => rebuild());
    resizeObserver.observe(container);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);

    return () => {
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointerup', onPointerUp);
      cancelAnimationFrame(buildFrame);
      resizeObserver.disconnect();
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
      if (frameId !== 0) cancelAnimationFrame(frameId);
      window.clearTimeout(timerId);
    };
  }, [reduce, dark]);

  return (
    <div
      ref={containerRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <canvas ref={canvasRef} className="block size-full" />
    </div>
  );
}
