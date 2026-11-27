import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');

describe("the palette's grey rows", () => {
  const src = read('QuickSwitcher.tsx');

  it('stand in only for a search that takes a moment, so a quick one never flashes them', () => {
    expect(src).toMatch(/const SKELETON_AFTER_MS = 120;/);
    expect(src).toContain('const searching = q !== query;');
    expect(src).toContain('setTimeout(() => setSlow(true), SKELETON_AFTER_MS)');
  });

  it("replace an earlier query's results, which can't be picked meanwhile, and give way to the one line", () => {
    expect(src).toContain('(slow ? [] : view).map(');
    expect(src).toContain('{slow ? <PaletteSkeleton /> : null}');
    expect(src).toContain('{!rows.length && !slow ? <div');
    expect(src).toMatch(/if \(!r \|\| slow\) return;/);
  });

  it('are five rows of the palette row size', () => {
    const row = read('PaletteRow.tsx');
    expect(row).toMatch(/\[72, 58, 64, 46, 52\]\.map/);
    expect(row).toContain('className={PALETTE_ROW}');
  });
});
