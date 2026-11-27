import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CRUMB } from '../../features/chat/ChatHeader';

const SRC = join(__dirname, '../..');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8').replace(/\r\n/g, '\n');

describe('the hairline edge (Grok Bot\'s)', () => {
  it('is a 1px inset a step off the fill, in the components layer so a focus ring still wins', () => {
    const css = read('index.css');
    expect(css).toMatch(/:root \{ --ab-edge: color-mix\(in srgb, var\(--ab-fg\) 7%, transparent\); \}/);
    const layer = css.slice(css.indexOf('@layer components {\n  .ab-edge'));
    expect(layer).toMatch(/^@layer components \{\n {2}\.ab-edge \{ box-shadow: inset 0 0 0 1px var\(--ab-edge\); \}/);
  });

  it('edges the raised buttons, the name chip, secondary buttons and the composer\'s +, and no chat bubble', () => {
    expect(CRUMB.split(' ')).toContain('ab-edge');
    expect(read('components/layout/Sidebar.tsx')).toMatch(/const RAISED = 'ab-edge /);
    expect(read('components/ui/Button.tsx')).toMatch(/secondary: 'ab-edge /);
    expect(read('features/chat/Composer.tsx')).toMatch(/const ADD = 'chat-round ab-edge /);
    expect(read('index.css')).not.toMatch(/\.chat-(?:bubble|page)[^{]*\{[^}]*--ab-edge/);
  });
});
