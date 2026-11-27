import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'dev' ? [] : sources(p);
    return /\.tsx?$/.test(e.name) && !e.name.includes('.test.') ? [p] : [];
  });
}

/** Lines (file:line) whose text matches every pattern. */
function linesWith(...patterns: RegExp[]): string[] {
  return sources(SRC).flatMap((f) =>
    readFileSync(f, 'utf8').split('\n').flatMap((line, i) => (patterns.every((p) => p.test(line)) ? [`${relative(SRC, f)}:${i + 1}`] : [])),
  );
}

describe('instant surfaces', () => {
  it('changes a colour under the pointer in the frame it arrives, with no fade', () => {
    expect(linesWith(/hover:/, /\btransition-colors\b/)).toEqual([]);
    expect(readFileSync(join(SRC, 'index.css'), 'utf8')).toMatch(/\.ab-press \{ transition: transform 150ms var\(--ease-t3\); \}/);
  });

  it('opens dialogs, the palette, popovers, menus and tooltips with no fade, scale or blur', () => {
    const files = ['components/ui/Dialog.tsx', 'components/ui/Popover.tsx', 'components/ui/Menu.tsx', 'components/ui/Tooltip.tsx', 'components/layout/QuickSwitcher.tsx', 'features/chat/MentionMenu.tsx', 'features/chat/SlashMenu.tsx', 'features/apps/BotAccess.tsx'];
    for (const f of files) {
      const text = readFileSync(join(SRC, f), 'utf8');
      expect(text, f).not.toMatch(/animate-\[pop-in|backdrop-blur|from 'motion\/react'|AnimatePresence/);
    }
  });
});
