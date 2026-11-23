// The banner over a release's notes: a soft, heavily blurred scene (warm sun, sky, a figure's glow, drawn with
// gradients, no photo) and the app icon in white in the middle.
import { useId } from 'react';
import { cn } from '../../components/ui';

// the logo's geometry in tile units (scripts/make-icon.mjs, electron/trayGlyph.ts: 1024 = the tile edge to edge): the
// tile is solid, the visor cut out of it, the happy eyes drawn in the visor
const TILE = { c: 512, half: 512, n: 5 };
const VISOR = { cx: 512, cy: 519, w: 733, h: 326, rot: -5 };
const EYES = [{ x: -149, y: 37, r: 72 }, { x: 149, y: 37, r: 72 }];
const EYE_W = 64;

/** macOS's tile (a superellipse) as path data, once */
const TILE_PATH = (() => {
  const sp = (c: number) => Math.sign(c) * Math.abs(c) ** (2 / TILE.n);
  const pts: string[] = [];
  for (let i = 0; i < 180; i++) {
    const t = (i / 180) * 2 * Math.PI;
    pts.push(`${i ? 'L' : 'M'}${(TILE.c + TILE.half * sp(Math.cos(t))).toFixed(1)} ${(TILE.c + TILE.half * sp(Math.sin(t))).toFixed(1)}`);
  }
  return `${pts.join('')}Z`;
})();

/** The app icon as a one-colour glyph (`currentColor`), the menu bar icon's drawing. */
export function LogoGlyph({ size = 28, className }: { size?: number; className?: string }) {
  const mask = `ab-glyph-${useId().replace(/:/g, '')}`;
  const visor = `translate(${VISOR.cx} ${VISOR.cy}) rotate(${VISOR.rot})`;
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} className={className} aria-hidden>
      <defs>
        <mask id={mask}>
          <path d={TILE_PATH} fill="#fff" />
          <rect transform={visor} x={-VISOR.w / 2} y={-VISOR.h / 2} width={VISOR.w} height={VISOR.h} rx={VISOR.h / 2} fill="#000" />
        </mask>
      </defs>
      <path d={TILE_PATH} fill="currentColor" mask={`url(#${mask})`} />
      <g transform={visor} fill="none" stroke="currentColor" strokeWidth={EYE_W} strokeLinecap="round">
        {EYES.map((e) => <path key={e.x} d={`M ${e.x - e.r} ${e.y} A ${e.r} ${e.r} 0 0 1 ${e.x + e.r} ${e.y}`} />)}
      </g>
    </svg>
  );
}

/** film grain over the blur, so it reads like a photo rather than a gradient */
const GRAIN = `url("data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" stitchTiles="stitch"/></filter><rect width="100%" height="100%" filter="url(#n)" opacity=".55"/></svg>')}")`;

/** the scene before the blur, bottom layer last: sky, a warm ground, a sunlit wall at the left and a glowing figure;
 *  radial ones are `[rx, ry, cx, cy]` in fractions of the scene and their stops */
type Stop = [number, string];
const GLOWS: { at: [number, number, number, number]; stops: Stop[] }[] = [
  { at: [0.38, 0.55, 0.44, 0.62], stops: [[0, '#f3e2c7'], [0.38, '#e9c79a'], [0.7, '#e9c79a00']] },
  { at: [0.18, 0.26, 0.47, 0.3], stops: [[0, '#7a3f22'], [0.45, '#5a2c18'], [0.75, '#5a2c1800']] },
  { at: [0.3, 0.4, 0.12, 0.4], stops: [[0, '#a9c3a2'], [0.45, '#6f8f6c'], [0.75, '#6f8f6c00']] },
  { at: [0.26, 0.3, 0.78, 0.52], stops: [[0, '#6b3a1f'], [0.7, '#6b3a1f00']] },
  { at: [0.6, 0.45, 0.75, 0.18], stops: [[0, '#cfe3f5'], [0.6, '#cfe3f500']] },
];
const SKY: Stop[] = [[0, '#3f78b4'], [0.38, '#6a9ccd'], [0.62, '#c98a3e'], [1, '#8a4a1c']];

const css = (stops: Stop[]) => stops.map(([at, c]) => `${c} ${at * 100}%`).join(', ');
const SCENE = [
  ...GLOWS.map(({ at: [rx, ry, cx, cy], stops }) => `radial-gradient(${rx * 100}% ${ry * 100}% at ${cx * 100}% ${cy * 100}%, ${css(stops)})`),
  `linear-gradient(180deg, ${css(SKY)})`,
].join(', ');

// the banner's size the blur is drawn for (2.35:1), and the scene around it: 18% bigger on every side, stretched 1.15x sideways
const W = 720;
const H = Math.round(W / 2.35);
const BLUR = 26;

let painted: string | null | undefined;

/** The blurred scene as a picture, drawn once. A CSS `filter: blur()` inside the dialog's glass (`backdrop-filter`)
 *  only blurs what is scrolled into view, so the banner turned into hard bands as the notes scrolled. */
function blurredScene(): string | null {
  if (painted !== undefined) return painted;
  painted = null;
  try {
    const sw = W * 1.36;
    const sh = H * 1.36;
    const scene = document.createElement('canvas');
    scene.width = Math.round(sw);
    scene.height = Math.round(sh);
    const s = scene.getContext('2d');
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const o = out.getContext('2d');
    if (!s || !o || !('filter' in o)) return null;
    const sky = s.createLinearGradient(0, 0, 0, sh);
    for (const [at, c] of SKY) sky.addColorStop(at, c);
    s.fillStyle = sky;
    s.fillRect(0, 0, sw, sh);
    for (const { at: [rx, ry, cx, cy], stops } of [...GLOWS].reverse()) {
      s.setTransform(rx * sw, 0, 0, ry * sh, cx * sw, cy * sh);
      const g = s.createRadialGradient(0, 0, 0, 0, 0, 1);
      for (const [at, c] of stops) g.addColorStop(at, c);
      s.fillStyle = g;
      s.fillRect(-cx / rx, -cy / ry, 1 / rx, 1 / ry);
    }
    o.fillStyle = '#3f78b4';
    o.fillRect(0, 0, W, H);
    o.filter = `blur(${BLUR}px) saturate(1.15)`;
    o.translate(W / 2, H / 2);
    o.scale(1.15, 1);
    o.drawImage(scene, -sw / 2, -sh / 2);
    painted = out.toDataURL('image/png');
  } catch {
    painted = null;
  }
  return painted;
}

export function WhatsNewHero() {
  const picture = blurredScene();
  return (
    // the sky colour only behind the live-blurred fallback: under the picture it showed as a blue fringe along the
    // rounded edges, where the clipped picture's antialiased edge lets it through. `isolate` keeps the grain's blend
    // inside the banner: without it Chromium isolates the whole modal, and the backdrop behind it lost its blur
    <div className={cn('isolate relative mb-5 aspect-[4/1] w-full overflow-hidden rounded-card', !picture && 'bg-[#3f78b4]')} aria-hidden>
      {picture ? (
        <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${picture})` }} />
      ) : (
        // no canvas filters: the same scene blurred live, oversized so the blur's soft edge stays outside the frame
        <div className="absolute -inset-[18%] scale-x-[1.15] blur-[26px] saturate-[1.15]" style={{ background: SCENE }} />
      )}
      <div className="absolute inset-0 opacity-[0.18] mix-blend-overlay" style={{ backgroundImage: GRAIN }} />
      <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_45%,transparent_55%,rgba(0,0,0,.28))]" />
      <div className="absolute inset-0 flex items-center justify-center">
        <LogoGlyph size={56} className="text-white drop-shadow-[0_6px_24px_rgba(0,0,0,.35)]" />
      </div>
    </div>
  );
}

/** The banner's blurred scene as a backdrop filling its parent (the cloud intro's picture sits on it). */
export function HeroBackdrop() {
  const picture = blurredScene();
  return (
    <div className={cn('pointer-events-none absolute inset-0 isolate overflow-hidden', !picture && 'bg-[#3f78b4]')} aria-hidden>
      {picture ? (
        <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${picture})` }} />
      ) : (
        <div className="absolute -inset-[18%] scale-x-[1.15] blur-[26px] saturate-[1.15]" style={{ background: SCENE }} />
      )}
      <div className="absolute inset-0 opacity-[0.18] mix-blend-overlay" style={{ backgroundImage: GRAIN }} />
      <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_45%,transparent_55%,rgba(0,0,0,.28))]" />
    </div>
  );
}
