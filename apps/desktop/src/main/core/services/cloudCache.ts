/**
 * The window's saved copies of the person's cloud computers (`cloudAccount.cacheGet` / `cacheSet`): the renderer's own
 * JSON of a computer's bots, threads, recent messages and status (features/cloud/cloudCacheData.ts), so switching to
 * the person's own computer or a team's shows them at once while the computer wakes. Never a secret: no tokens, keys or pairing codes
 * go in (the renderer only keeps what a paired device's hello carries).
 *
 * One file per computer, `<dataDir>/cloud-cache/<own|team-<id>>.json` (the folder 0700, files 0600, written atomically),
 * its content sealed with the OS keychain (`deps.secretBox`, Electron's safeStorage) where there is one, else kept as
 * the Mac's own chats are (plain, user-only). Each file names the account it was written for and is dropped when read
 * by another one. Dropped too when the computer stops being the person's (`prune`, chat-core `lostCloudCaches`: signed
 * out, off the team, the plan over); reading or writing never calls the backend or the computer.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CLOUD_CACHE_MAX_CHARS, type CloudAccountView } from '@appubot/protocol';
import { cacheKeyOfFilesDir, cloudCacheKey, cloudFilesDir, lostCloudCaches, teamOfCacheKey } from '@appubot/chat-core';
import type { CoreCtx } from '../context';
import { writeFileAtomic } from '../store';
import { errMsg } from '../util';
import { CLOUD_FILES_DIR, cloudFilesComputers, forgetCloudFiles } from './cloudFiles';

const VERSION = 1;

/** who the copy belongs to: what was known of the account when it was written */
export interface CacheOwner { id?: string; email?: string }

interface CacheFile { v: number; key: string; owner: CacheOwner; savedAt: number; sealed: boolean; data: string }

/** A file name for a key (`own`, `team:<id>`): letters, digits, `_` and `-` only. */
const fileName = (key: string): string => `${key.replace(/:/g, '-').replace(/[^\w-]/g, '_')}.json`;

/** Two owners are different people when a field both know differs. */
export function sameOwner(a: CacheOwner, b: CacheOwner): boolean {
  if (a.id && b.id && a.id !== b.id) return false;
  if (a.email && b.email && a.email.toLowerCase() !== b.email.toLowerCase()) return false;
  return true;
}

export class CloudCache {
  constructor(private ctx: CoreCtx, private owner: () => CacheOwner | null) {}

  private get dir(): string { return join(this.ctx.paths.dataDir, 'cloud-cache'); }

  private fileOf(key: string): string { return join(this.dir, fileName(key)); }

  /** The copy of a computer (`team` absent: the person's own), or null: none, unreadable, or another account's. */
  get(team?: string): { data: string; savedAt: number } | null {
    const owner = this.owner();
    if (!owner) return null;
    const key = cloudCacheKey(team);
    const file = this.fileOf(key);
    try {
      if (!existsSync(file)) return null;
      const f = JSON.parse(readFileSync(file, 'utf8')) as CacheFile;
      if (f.v !== VERSION || f.key !== key || typeof f.data !== 'string' || !sameOwner(f.owner ?? {}, owner)) { this.remove(key); return null; }
      const data = f.sealed ? this.open(f.data) : f.data;
      if (data === null) { this.remove(key); return null; }
      return { data, savedAt: f.savedAt };
    } catch (e) {
      this.ctx.log.warn('cloud cache: reading a copy failed; dropped', errMsg(e));
      this.remove(key);
      return null;
    }
  }

  /** Keep a computer's copy (`data: ''` drops it). Nothing is kept while signed out. */
  set(team: string | undefined, data: string): void {
    const key = cloudCacheKey(team);
    const owner = this.owner();
    if (!owner || !data) { this.remove(key); return; }
    if (data.length > CLOUD_CACHE_MAX_CHARS) return;
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      else chmodSync(this.dir, 0o700);
      const sealed = this.seal(data);
      const f: CacheFile = { v: VERSION, key, owner, savedAt: Date.now(), sealed: sealed !== null, data: sealed ?? data };
      writeFileAtomic(this.fileOf(key), JSON.stringify(f), 0o600);
    } catch (e) {
      this.ctx.log.warn('cloud cache: saving a copy failed', errMsg(e));
    }
  }

  /** The keys of the copies kept now. */
  keys(): string[] {
    try {
      if (!existsSync(this.dir)) return [];
      const out: string[] = [];
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const f = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as Partial<CacheFile>;
          if (typeof f.key === 'string' && fileName(f.key) === name) out.push(f.key);
          else rmSync(join(this.dir, name), { force: true });
        } catch {
          rmSync(join(this.dir, name), { force: true });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** where the window's file and page copies of each computer live (services/cloudFiles.ts) */
  private get filesRoot(): string { return join(this.ctx.paths.dataDir, CLOUD_FILES_DIR); }

  /**
   * Drop the copies of computers that aren't the person's any more, as the account view says: the saved chats and
   * the pages and files kept of them alike.
   */
  prune(view: CloudAccountView): string[] {
    const files = cloudFilesComputers(this.filesRoot).map(cacheKeyOfFilesDir).filter((k): k is string => !!k);
    const keys = [...new Set([...this.keys(), ...files])];
    if (!keys.length) return [];
    const gone = lostCloudCaches({
      signedIn: view.signedIn,
      read: !!view.readAt && !view.error,
      accountStatus: view.account?.status ?? null,
      ownState: view.computer?.state ?? null,
      teams: view.teams ? view.teams.map((t) => ({ id: t.team.id, state: t.computer?.state ?? null })) : null,
    }, keys);
    for (const key of gone) {
      this.remove(key);
      forgetCloudFiles(this.filesRoot, cloudFilesDir(teamOfCacheKey(key)));
    }
    if (gone.length) this.ctx.log.info(`cloud cache: dropped ${gone.join(', ')} (no longer this person's)`);
    return gone;
  }

  /** Drop every copy (signed out), with the pages and files kept of the computers. */
  clear(): void {
    try { if (existsSync(this.dir)) rmSync(this.dir, { recursive: true, force: true }); } catch (e) { this.ctx.log.warn('cloud cache: clearing failed', errMsg(e)); }
    forgetCloudFiles(this.filesRoot);
  }

  private remove(key: string): void {
    try { rmSync(this.fileOf(key), { force: true }); } catch { /* gone next time */ }
  }

  private seal(plain: string): string | null {
    const box = this.ctx.deps.secretBox;
    if (!box) return null;
    try { return box.encrypt(plain); } catch (e) { this.ctx.log.warn('cloud cache: sealing failed; kept as is', errMsg(e)); return null; }
  }

  private open(sealed: string): string | null {
    try { return this.ctx.deps.secretBox?.decrypt(sealed) ?? null; } catch { return null; }
  }
}
