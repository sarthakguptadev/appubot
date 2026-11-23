/**
 * The app's own face (Geist, as the window is set in it) for a bot's visual page: a page is a sandboxed frame with no
 * network, so the font travels inside its document (`core/pageDocument.ts`, `CoreDeps.pageFont`). The Latin variable
 * WOFF2 (about 29 KB), read once: from the renderer's built assets, else the package itself (a dev run). Null where
 * neither is found: the page falls back to the system's face.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

const FILE = 'geist-latin-wght-normal';
let font: { family: string; woff2: string } | null | undefined;

export function pageFont(): { family: string; woff2: string } | null {
  if (font !== undefined) return font;
  const root = app.getAppPath();
  const tries: (() => string | undefined)[] = [
    () => { const dir = join(root, 'out', 'renderer', 'assets'); const f = readdirSync(dir).find((n) => n.startsWith(FILE) && n.endsWith('.woff2')); return f && join(dir, f); },
    () => join(root, 'node_modules', '@fontsource-variable', 'geist', 'files', `${FILE}.woff2`),
  ];
  font = null;
  for (const find of tries) {
    try {
      const path = find();
      if (!path) continue;
      font = { family: 'Geist Variable', woff2: readFileSync(path).toString('base64') };
      break;
    } catch { /* not there: the next place */ }
  }
  return font;
}
