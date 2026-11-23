import { describe, expect, it } from 'vitest';
import { CHARACTER_BODY_CHARS, CHARACTER_BODY_MAX, type Character } from '@appubot/protocol';
import {
  CHARACTER_STORED_LIMITS, FACE_MIN, botFigure, characterBox, characterKey, characterPrompt, cleanCharacterName, cleanCharacterPrompt,
  findFace, importSvg, normalizeCharacter, parseCharacterReply, parsePathData, parseTransform, pathBounds,
} from './characters';
import { BOT_BODY, botAvatarLook, botAvatarSvg } from './botAvatar';

const CIRCLE = 'M10 50A40 40 0 1 1 90 50A40 40 0 1 1 10 50Z';
const near = (a: number, b: number, d = 0.05) => expect(Math.abs(a - b)).toBeLessThan(d);

function boundsOf(d: string) {
  const r = parsePathData(d, CHARACTER_STORED_LIMITS);
  if (!r.ok) throw new Error(r.error);
  return pathBounds(r.segs)!;
}

describe('parsePathData', () => {
  it('reads every command into absolute M/L/C/Q/Z', () => {
    const r = parsePathData('m10 10 h20 v20 H10 V15 l5-5 c1 1 2 2 3 3 s4 4 5 5 q1 1 2 2 t3 3 a5 5 0 0 1 10 0 z');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(new Set(r.segs.map((s) => s.k))).toEqual(new Set(['M', 'L', 'C', 'Q', 'Z']));
    expect(r.segs[1]).toEqual({ k: 'L', p: [30, 10] });
    expect(r.segs[2]).toEqual({ k: 'L', p: [30, 30] });
  });

  it('reflects S and T control points', () => {
    const r = parsePathData('M0 0C0 10 10 10 10 0S20 -10 20 0Q25 10 30 0T40 0');
    if (!r.ok) throw new Error(r.error);
    expect(r.segs[2]).toEqual({ k: 'C', c1: [10, -10], c2: [20, -10], p: [20, 0] });
    expect(r.segs[4]).toEqual({ k: 'Q', c: [35, -10], p: [40, 0] });
  });

  it('reads arcs, compact flags too, as cubics that keep to the circle', () => {
    const b = boundsOf(CIRCLE);
    near(b.x0, 10); near(b.x1, 90); near(b.y0, 10, 0.2); near(b.y1, 90, 0.2);
    const compact = parsePathData('M0 0a10 10 0 1110 0z');
    expect(compact.ok).toBe(true);
  });

  it('refuses anything but path data', () => {
    for (const bad of ['M0 0L10 10"/><script>alert(1)</script>', 'M0 0 L10 10 url(#x)', 'M0 0;L1 1', 'M0 0\u0000L1 1', '<path d="M0 0"/>']) {
      expect(parsePathData(bad).ok).toBe(false);
    }
  });

  it('refuses broken or oversized paths', () => {
    expect(parsePathData('').ok).toBe(false);
    expect(parsePathData('L10 10').ok).toBe(false);
    expect(parsePathData('M10').ok).toBe(false);
    expect(parsePathData('M0 0 Z 5 5').ok).toBe(false);
    expect(parsePathData('M0 0 L1e9 0').ok).toBe(false);
    expect(parsePathData('M0 0 A10 10 0 2 1 5 5').ok).toBe(false);
    expect(parsePathData(`M0 0${' L1 1'.repeat(1300)}`).ok).toBe(false); // over 6000 chars
    const many = parsePathData(`M0 0${'L1 1'.repeat(401)}`);
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.error).toMatch(/too detailed/);
  });
});

describe('normalizeCharacter', () => {
  it('fits a body into 6..94, keeps proportions and writes only our own path data', () => {
    const r = normalizeCharacter({ body: 'M200 100H400V200H200Z' }); // 2:1
    if (!r.ok) throw new Error(r.error);
    expect(r.body).toMatch(CHARACTER_BODY_CHARS);
    near(r.box.x0, 6); near(r.box.x1, 94); near(r.box.y0, 28); near(r.box.y1, 72);
    const again = boundsOf(r.body);
    near(again.x0, 6); near(again.y1, 72);
  });

  it('closes every outline', () => {
    const r = normalizeCharacter({ body: 'M10 10L90 10L90 90L10 90' });
    if (!r.ok) throw new Error(r.error);
    expect(r.body.endsWith('Z')).toBe(true);
  });

  it('finds the roomiest place for the face, the round bot’s size on a circle', () => {
    const r = normalizeCharacter({ body: CIRCLE });
    if (!r.ok) throw new Error(r.error);
    expect(r.face.s).toBe(1);
    near(r.face.x, 50, 0.5);
    expect(r.face.y).toBeGreaterThan(40);
    expect(r.face.y).toBeLessThan(56);
  });

  it('puts the face low in a triangle, where it is wide', () => {
    const r = normalizeCharacter({ body: BOT_BODY.triangle });
    if (!r.ok) throw new Error(r.error);
    expect(r.face.y).toBeGreaterThan(55);
    expect(r.face.s).toBeLessThanOrEqual(1);
    expect(r.face.s).toBeGreaterThanOrEqual(FACE_MIN);
    // a narrow spire has room for a small face only
    const spire = normalizeCharacter({ body: 'M50 6L60 94L40 94Z' });
    if (!spire.ok) throw new Error(spire.error);
    expect(spire.face.s).toBeLessThan(0.5);
  });

  it('keeps a given face inside the body, moved and shrunk with it', () => {
    const r = normalizeCharacter({ body: CIRCLE, face: { x: 50, y: 50, s: 0.6 } });
    if (!r.ok) throw new Error(r.error);
    near(r.face.y, 50, 0.1);
    near(r.face.s, 0.6 * (88 / 80), 0.02);
    // off the body: clamped into its box and shrunk to what fits there
    const off = normalizeCharacter({ body: CIRCLE, face: { x: 200, y: -50, s: 1.2 } });
    if (!off.ok) throw new Error(off.error);
    expect(off.face.x + 28 * off.face.s).toBeLessThanOrEqual(94.01);
    expect(off.face.y - 13 * off.face.s).toBeGreaterThanOrEqual(5.99);
  });

  it('refuses empty, flat and hairline drawings', () => {
    expect(normalizeCharacter({ body: 'M10 10Z' }).ok).toBe(false);
    expect(normalizeCharacter({ body: 'M10 10L90 10Z' }).ok).toBe(false);
    const thin = normalizeCharacter({ body: 'M10 10L90 90L90.5 90L10.5 10Z' });
    expect(thin.ok).toBe(false);
    if (!thin.ok) expect(thin.error).toMatch(/thin/);
  });

  it('turns a generated silhouette’s outlines one way, so overlaps never cut holes', () => {
    // a big circle and a smaller one inside it drawn the other way: a ring as drawn, a solid disc once oriented
    const ring = `${CIRCLE}M30 50A20 20 0 1 0 70 50A20 20 0 1 0 30 50Z`;
    const kept = normalizeCharacter({ body: ring });
    const solid = normalizeCharacter({ body: ring }, { orient: true });
    if (!kept.ok || !solid.ok) throw new Error('unreadable');
    const keptPath = parsePathData(kept.body, CHARACTER_STORED_LIMITS);
    if (!keptPath.ok) throw new Error(keptPath.error);
    const holeFit = findFace(keptPath.segs);
    expect(solid.face.s).toBe(1);
    // the ring has no room in the middle: its face goes to the rim, smaller
    expect(holeFit.s).toBeLessThan(solid.face.s);
  });

  it('stays within the stored size', () => {
    const r = normalizeCharacter({ body: CIRCLE });
    if (!r.ok) throw new Error(r.error);
    expect(r.body.length).toBeLessThan(CHARACTER_BODY_MAX);
    expect(parsePathData(r.body, CHARACTER_STORED_LIMITS).ok).toBe(true);
  });
});

describe('importSvg', () => {
  it('merges circles, rects and paths with their transforms into one body', () => {
    const svg = `<?xml version="1.0"?><!-- made by hand --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
      <g transform="translate(100 100)">
        <circle r="60" fill="#f80"/>
        <rect x="-80" y="-90" width="40" height="60" rx="10" transform="rotate(-15)"/>
        <path d="M40 -90 L80 -30 L40 -30 Z" style="fill:#f80"/>
      </g>
    </svg>`;
    const r = importSvg(svg);
    if (!r.ok) throw new Error(r.error);
    expect(r.shapes).toBe(3);
    expect(r.body).toMatch(CHARACTER_BODY_CHARS);
    expect(r.notes).toEqual([]);
    const b = boundsOf(r.body);
    expect(Math.max(b.x1 - b.x0, b.y1 - b.y0)).toBeCloseTo(88, 0);
  });

  it('only reads geometry: scripts, styles, pictures, text, <use> and outlines are left out', () => {
    const svg = `<svg><style>path{fill:red}</style><script>alert("x")</script>
      <defs><circle id="c" r="40"/></defs><use href="#c"/>
      <image href="https://example.com/x.png" width="10" height="10"/><text>hi</text>
      <circle cx="50" cy="50" r="10" fill="none" stroke="#000"/>
      <ellipse cx="50" cy="50" rx="40" ry="30"/></svg>`;
    const r = importSvg(svg);
    if (!r.ok) throw new Error(r.error);
    expect(r.shapes).toBe(1);
    expect(r.notes.join(' ')).toMatch(/Scripts/);
    expect(r.notes.join(' ')).toMatch(/Pictures/);
    expect(r.notes.join(' ')).toMatch(/Outline-only/);
    expect(r.notes.join(' ')).toMatch(/<use>/);
  });

  it('keeps a mirrored shape solid', () => {
    const r = importSvg('<svg><g transform="scale(-1 1)"><polygon points="-90,10 -10,10 -10,90 -90,90"/></g><circle cx="50" cy="50" r="30"/></svg>');
    if (!r.ok) throw new Error(r.error);
    expect(r.face.s).toBe(1);
  });

  it('says what is wrong with a file that has no character in it', () => {
    expect(importSvg('').ok).toBe(false);
    expect(importSvg('<html><body>hi</body></html>').ok).toBe(false);
    const none = importSvg('<svg><line x1="0" y1="0" x2="10" y2="10"/></svg>');
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toMatch(/No filled shapes/);
    expect(importSvg(`<svg>${' '.repeat(600_000)}</svg>`).ok).toBe(false);
  });

  it('stays fast on a broken file', () => {
    const t0 = Date.now();
    importSvg(`<svg>${'<a "'.repeat(100_000)}`);
    importSvg(`<svg>${'<!--<!'.repeat(80_000)}`);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('reads transform lists', () => {
    expect(parseTransform('translate(10, 20) scale(2)')).toEqual([2, 0, 0, 2, 10, 20]);
    expect(parseTransform('matrix(1 0 0 1 5 6)')).toEqual([1, 0, 0, 1, 5, 6]);
    expect(parseTransform('bogus(1)')).toBeNull();
  });
});

describe('the generator', () => {
  it('asks for JSON with the description on one line', () => {
    const p = characterPrompt('a fluffy "cat"\nwith wings', 3);
    expect(p).toContain('Draw 3 different takes on: "a fluffy \'cat\' with wings"');
    expect(p).toMatch(/JSON only/);
    expect(cleanCharacterPrompt('x'.repeat(500)).length).toBe(300);
  });

  it('reads the reply from a code fence, prose or a bare list, and drops what is unusable', () => {
    const body = 'M20 30C20 10 80 10 80 30L85 80C85 95 15 95 15 80Z';
    const fenced = `Here you go!\n\`\`\`json\n${JSON.stringify({ characters: [
      { name: '  Puffy <b>Cat</b>\n', body, face: { x: 50, y: 50, s: 0.8 } },
      { name: 'Bad', body: 'M0 0 L10 10 <script>' },
      { name: 'Dupe', body },
      { name: 'Line', body: 'M10 10L90 90' },
    ] })}\n\`\`\``;
    const r = parseCharacterReply(fenced);
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]!.name).toBe('Puffy b Cat /b');
    expect(r.drafts[0]!.body).toMatch(CHARACTER_BODY_CHARS);
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
    expect(parseCharacterReply(`[{"name":"A","body":"${body}"}]`).drafts).toHaveLength(1);
    expect(parseCharacterReply('Sure! {"name":"A","d":"' + body + '"} hope you like it').drafts).toHaveLength(1);
    expect(parseCharacterReply('no json here').drafts).toHaveLength(0);
  });
});

describe('wearing a character', () => {
  const made = normalizeCharacter({ body: 'M20 40C20 10 80 10 80 40L80 85L20 85Z', face: { x: 50, y: 50, s: 0.9 } });
  if (!made.ok) throw new Error(made.error);
  const ch: Character = { id: 'chr_1', name: 'Tofu', body: made.body, face: made.face, source: 'generated', createdAt: 1 };

  it('draws AppuBot’s visor and eyes on it, centred on its face', () => {
    const look = botAvatarLook(ch, '#2E8EFF');
    expect(look.body).toBe(ch.body);
    near(look.visor.x + look.visor.w / 2, ch.face.x, 0.01);
    near(look.visor.y + look.visor.h / 2, ch.face.y, 0.01);
    near(look.base, characterBox(ch.body)!.y1, 0.01);
    for (const e of look.eyes) {
      expect(e.x).toBeGreaterThan(look.visor.x);
      expect(e.x + e.w).toBeLessThan(look.visor.x + look.visor.w);
    }
    expect(botAvatarSvg(ch, '#2E8EFF')).toContain(`d="${ch.body}"`);
  });

  it('falls back to the round bot for a body that isn’t ours, and to the shape for a character that is gone', () => {
    const hostile = botAvatarLook({ body: 'M0 0"/><script>', face: { x: 50, y: 50, s: 1 } }, '#2E8EFF');
    expect(hostile.body).toBe(BOT_BODY.circle);
    expect(botFigure({ shape: 'hex', characterId: 'chr_1' }, [ch])).toBe(ch);
    expect(botFigure({ shape: 'hex', characterId: 'chr_gone' }, [ch])).toBe('hex');
    expect(botFigure({ shape: 'pill' }, undefined)).toBe('pill');
    expect(botAvatarLook('triangle', '#000').base).toBe(88);
  });

  it('keys the drawing by body and face', () => {
    const renamed: Character = { ...ch, name: 'Other' };
    expect(characterKey(ch)).toBe(characterKey(renamed));
    expect(characterKey(ch)).not.toBe(characterKey({ ...ch, face: { ...ch.face, s: 0.5 } }));
  });

  it('cleans names', () => {
    expect(cleanCharacterName('  "Mr.\n Whiskers"  ')).toBe('Mr. Whiskers');
    expect(cleanCharacterName('')).toBe('Character');
    expect(cleanCharacterName('x'.repeat(80))).toHaveLength(40);
  });
});
