/**
 * Files of a computer that isn't this one (your AppuBot computer, a team's), brought to this Mac so they can be shown,
 * opened in their own app and saved to Downloads. The window fetches the bytes through the computer's end-to-end
 * channel (renderer `features/cloud/remoteFiles.ts`) and hands them here; nothing here talks to the computer.
 *
 * One folder per computer beside the window's saved copies of them (`<dataDir>/cloud-cache/<own|team-<id>>.json`,
 * core `services/cloudCache.ts`, keyed the same way): `<dataDir>/cloud-files/<own|team-<id>>/<file id>/<name>`
 * (folders 0700, files 0600). A file id is the computer's own (one file, one id), so a copy is good while its size
 * matches. Copies untouched for `MAX_AGE_MS` go, and each computer's least recently used go once its copies pass
 * `settings.storage.cloudCopyMb` (services/cloudFiles.ts, shared with the pages core keeps beside them). A picture's
 * thumbnail is a copy of its own (`<id>.thumb`, made by the window), so it shows without reading the whole file.
 *
 * No `electron` import: the IPC wiring is in ipc.ts, so this is tested with plain fs.
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { safeName } from '../core/services/files';
import { CLOUD_FILES_DIR, DEFAULT_COPY_MB, MAX_AGE_MS, copyBytes, forgetCloudFiles, sweepCloudFiles } from '../core/services/cloudFiles';

export const REMOTE_FILES_DIR = CLOUD_FILES_DIR;
/** each computer's share (settings.storage.cloudCopyMb, 500 MB unless changed) */
export const MAX_BYTES = copyBytes(DEFAULT_COPY_MB);
export { MAX_AGE_MS };

/** What the window names a file by: which computer (`own`, `team-<id>`), the computer's file id, its name and size. */
export interface RemoteFileRef { computer: string; id: string; name: string; size?: number }

const COMPUTER = /^(own|team-[A-Za-z0-9_-]{1,80})$/;
const FILE_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;

export class RemoteFiles {
  constructor(private readonly dataDir: string) {}

  get root(): string { return join(this.dataDir, REMOTE_FILES_DIR); }

  /** Where that file's copy lives (whether or not it's there yet); throws on a ref that could leave the folder. */
  pathOf(ref: RemoteFileRef): string {
    const computer = String(ref?.computer ?? '');
    const id = String(ref?.id ?? '');
    if (!COMPUTER.test(computer)) throw new Error('Unknown computer');
    if (!FILE_ID.test(id) || id === '.' || id === '..') throw new Error('Unknown file');
    const p = join(this.root, computer, id, safeName(String(ref.name ?? '')));
    if (!resolve(p).startsWith(resolve(this.root) + sep)) throw new Error('Unknown file');
    return p;
  }

  /** The copy's path when it's here whole (its size matches, when the window knows it), else null. */
  cached(ref: RemoteFileRef): string | null {
    const p = this.pathOf(ref);
    try {
      const st = statSync(p);
      if (!st.isFile()) return null;
      if (typeof ref.size === 'number' && ref.size > 0 && st.size !== ref.size) return null;
      // used now: the age sweep keeps it
      const now = new Date();
      try { utimesSync(p, now, now); } catch { /* read-only: fine */ }
      return p;
    } catch {
      return null;
    }
  }

  /** Writes a fetched file (atomically: never half a file under its name) and answers its path. */
  save(ref: RemoteFileRef, bytes: Uint8Array): string {
    const p = this.pathOf(ref);
    const dir = join(p, '..');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.part-${randomBytes(6).toString('hex')}`);
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, p);
    return p;
  }

  /** The copy put in `dir` (Downloads) under its own name, " (2)" and on when that's taken. */
  copyTo(ref: RemoteFileRef, dir: string): string {
    const from = this.cached(ref);
    if (!from) throw new Error('That file isn’t on this computer yet');
    mkdirSync(dir, { recursive: true });
    const to = uniqueIn(dir, safeName(ref.name));
    copyFileSync(from, to);
    return to;
  }

  /**
   * Drops copies untouched for `maxAgeMs`, then each computer's least recently used until its copies (files and the
   * pages core keeps beside them: services/cloudFiles.ts) are under `maxBytes`; only `computer`'s when named.
   */
  sweep(now = Date.now(), maxBytes = MAX_BYTES, maxAgeMs = MAX_AGE_MS, computer?: string): { removed: number } {
    return { removed: sweepCloudFiles(this.root, { maxBytes, maxAgeMs, now, ...(computer ? { computer } : {}) }).removed };
  }

  /** Everything of one computer (it isn't the person's any more) or of all of them (`computer` absent: signed out). */
  forget(computer?: string): void {
    forgetCloudFiles(this.root, computer);
  }
}

/** `dir/name`, or `dir/stem (2).ext` and on when that's taken. */
export function uniqueIn(dir: string, name: string): string {
  let p = join(dir, name);
  if (!existsSync(p)) return p;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    p = join(dir, `${stem} (${i})${ext}`);
    if (!existsSync(p)) return p;
  }
}
