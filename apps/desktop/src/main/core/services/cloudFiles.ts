/**
 * What the desktop keeps of its AppuBot computers' files and pages, so a chat shows them at once (even while the
 * computer sleeps): `<dataDir>/cloud-files/<own|team-<id>>/<file id>/…` (chat-core `cloudFilesDir`; folders 0700,
 * files 0600). The window's file copies (main's electron/remoteFiles.ts: `<name>`, a thumbnail beside it as its own
 * `<id>.thumb` entry) and the pages (services/cloudPages.ts: `.page.json`, sealed) share each computer's folder, so
 * one rule keeps both: an entry (one file id's folder) used last goes first once the computer's entries pass
 * `settings.storage.cloudCopyMb`, and anything untouched for `MAX_AGE_MS` goes. A computer stops being the person's
 * (chat-core `lostCloudCaches`, the same rule as the saved chats: services/cloudCache.ts `prune`), or they sign out:
 * its folder goes with its saved copy.
 *
 * Pure fs, no `electron`: core's StorageService sweeps on its schedule, the writers after each save.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const CLOUD_FILES_DIR = 'cloud-files';
export const DEFAULT_COPY_MB = 500;
export const MAX_AGE_MS = 30 * 86_400_000;
const MB = 1024 * 1024;

export interface CloudEntry { computer: string; dir: string; size: number; at: number }

/** Every kept entry (one file id's folder) with its size and when it was last used (its newest mtime). */
export function cloudEntries(root: string, computer?: string): CloudEntry[] {
  const out: CloudEntry[] = [];
  let computers: string[];
  try { computers = computer ? [computer] : readdirSync(root); } catch { return out; }
  for (const c of computers) {
    const cdir = join(root, c);
    let ids: string[] = [];
    try { ids = readdirSync(cdir); } catch { continue; }
    for (const id of ids) {
      const fdir = join(cdir, id);
      let size = 0;
      let at = 0;
      try {
        if (!statSync(fdir).isDirectory()) continue;
        for (const name of readdirSync(fdir)) {
          const st = statSync(join(fdir, name));
          size += st.size;
          at = Math.max(at, st.mtimeMs);
        }
      } catch { continue; }
      out.push({ computer: c, dir: fdir, size, at });
    }
  }
  return out;
}

/**
 * Drops entries untouched for `maxAgeMs` (and empty ones), then each computer's least recently used until its entries
 * are under `maxBytes`. Only `computer`'s when named. Never throws.
 */
export function sweepCloudFiles(root: string, opts: { maxBytes: number; maxAgeMs?: number; now?: number; computer?: string }): { removed: number; freed: number } {
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? MAX_AGE_MS;
  let removed = 0;
  let freed = 0;
  const drop = (e: CloudEntry) => {
    try { rmSync(e.dir, { recursive: true, force: true }); removed++; freed += e.size; } catch { /* in use: next time */ }
  };
  const byComputer = new Map<string, CloudEntry[]>();
  for (const e of cloudEntries(root, opts.computer)) {
    if (now - e.at > maxAge || e.size === 0) { drop(e); continue; }
    const list = byComputer.get(e.computer) ?? [];
    list.push(e);
    byComputer.set(e.computer, list);
  }
  for (const list of byComputer.values()) {
    let total = list.reduce((n, e) => n + e.size, 0);
    for (const e of list.sort((a, b) => a.at - b.at)) {
      if (total <= opts.maxBytes) break;
      drop(e);
      total -= e.size;
    }
  }
  return { removed, freed };
}

/** The setting as bytes (a computer's share). */
export const copyBytes = (mb: number | undefined): number => Math.max(50, mb ?? DEFAULT_COPY_MB) * MB;

/** What's kept, for Settings › Storage. */
export function cloudFilesSize(root: string): { bytes: number; count: number } {
  const all = cloudEntries(root);
  return { bytes: all.reduce((n, e) => n + e.size, 0), count: all.length };
}

/** The computers that have a folder here (`own`, `team-<id>`). */
export function cloudFilesComputers(root: string): string[] {
  try { return existsSync(root) ? readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory()) : []; } catch { return []; }
}

/** A computer's folder, or every one (`computer` absent). Never throws. */
export function forgetCloudFiles(root: string, computer?: string): void {
  try {
    const dir = computer === undefined ? root : /^(own|team-[A-Za-z0-9_-]{1,80})$/.test(computer) ? join(root, computer) : null;
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch { /* gone next time */ }
}
