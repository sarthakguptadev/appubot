/**
 * Pages a bot showed on an AppuBot computer (`show_page`), kept on this Mac so its chat shows them at once, the
 * computer asleep or not (`cloudAccount.pageGet` / `pageSet`). The window brings a page's HTML through the computer's
 * channel once (features/cloud/remotePages.ts) and checks it again now and then while connected; this keeps it and
 * this Mac's gateway frames it (`/cloud-pages/<computer>/<id>?v=…`) like a page of its own (core/pageDocument.ts:
 * themed, bootstrapped, under PAGE_HEADERS), with a viewing key of its own (never the app's token).
 *
 * One file per page beside the window's file copies (services/cloudFiles.ts: `<dataDir>/cloud-files/<computer>/<id>/
 * .page.json`, so the same size cap and least-recently-shown eviction keep both), its HTML sealed with the OS keychain
 * (`deps.secretBox`) where there is one, named for the account that kept it (another account's is dropped on read),
 * and gone with the computer's saved copy (services/cloudCache.ts). Never calls the backend or the computer.
 * A page's pictures are built into its HTML (`show_page` makes them data: URLs) and it can't fetch anything, so the
 * HTML is all there is to keep.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { cloudFilesDir } from '@appubot/chat-core';
import { CLOUD_PAGE_MAX_CHARS } from '@appubot/protocol';
import { writeFileAtomic } from '../store';
import { errMsg } from '../util';
import { sameOwner, type CacheOwner } from './cloudCache';
import { CLOUD_FILES_DIR, copyBytes, sweepCloudFiles } from './cloudFiles';

const VERSION = 1;
const PAGE_FILE = '.page.json';
const ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
const COMPUTER = /^(own|team-[A-Za-z0-9_-]{1,80})$/;
/** a computer's folder is swept at most this often after a save */
const SWEEP_GAP_MS = 30_000;

interface PageFile { v: number; owner: CacheOwner; savedAt: number; checkedAt: number; hash: string; sealed: boolean; data: string }
export interface KeptPage { path: string; savedAt: number; checkedAt: number; hash: string }

export interface CloudPagesDeps {
  dataDir: string;
  owner(): CacheOwner | null;
  secretBox?: { encrypt(plain: string): string; decrypt(sealed: string): string };
  /** this run's viewing key for a page id (FilesService.pageViewKey) */
  viewKey(id: string): string;
  /** settings.storage.cloudCopyMb */
  capMb(): number | undefined;
  warn(msg: string, detail?: string): void;
}

export const pageHash = (html: string): string => createHash('sha256').update(html).digest('hex').slice(0, 16);

export class CloudPages {
  private swept = new Map<string, number>();

  constructor(private deps: CloudPagesDeps) {}

  get root(): string { return join(this.deps.dataDir, CLOUD_FILES_DIR); }

  private fileOf(computer: string, id: string): string {
    if (!COMPUTER.test(computer)) throw new Error('Unknown computer');
    if (!ID.test(id) || id === '.' || id === '..') throw new Error('Unknown page');
    return join(this.root, computer, id, PAGE_FILE);
  }

  /** The key a `/cloud-pages/` link carries: one page, this run. */
  viewKey(computer: string, id: string): string { return this.deps.viewKey(`cloud-page:${computer}/${id}`); }

  private pathOf(computer: string, id: string, hash: string): string {
    return `/cloud-pages/${computer}/${encodeURIComponent(id)}?v=${this.viewKey(computer, id)}&h=${hash}`;
  }

  private readFile(computer: string, id: string): PageFile | null {
    const owner = this.deps.owner();
    const file = this.fileOf(computer, id);
    if (!owner || !existsSync(file)) return null;
    try {
      const f = JSON.parse(readFileSync(file, 'utf8')) as PageFile;
      if (f.v !== VERSION || typeof f.data !== 'string' || typeof f.hash !== 'string' || !sameOwner(f.owner ?? {}, owner)) { this.drop(computer, id); return null; }
      return f;
    } catch {
      this.drop(computer, id);
      return null;
    }
  }

  /** The kept page (`team` absent: the person's own computer), or null: none, unreadable or another account's. */
  get(team: string | undefined, id: string): KeptPage | null {
    const computer = cloudFilesDir(team);
    const f = this.readFile(computer, id);
    if (!f) return null;
    this.touch(computer, id);
    return { path: this.pathOf(computer, id, f.hash), savedAt: f.savedAt, checkedAt: f.checkedAt, hash: f.hash };
  }

  /** Keeps a page's HTML (checked again: the same HTML only notes when). Nothing is kept while signed out. */
  set(team: string | undefined, id: string, html: string): KeptPage & { changed: boolean } {
    const owner = this.deps.owner();
    if (!owner) throw new Error('Sign in to your AppuBot account first.');
    if (!html || html.length > CLOUD_PAGE_MAX_CHARS) throw new Error('That page is too big to keep.');
    const computer = cloudFilesDir(team);
    const file = this.fileOf(computer, id);
    const hash = pageHash(html);
    const before = this.readFile(computer, id);
    const now = Date.now();
    const same = before?.hash === hash;
    let data: string;
    let sealed: boolean;
    if (same) {
      ({ data, sealed } = before!);
    } else {
      const s = this.seal(html);
      data = s ?? html;
      sealed = s !== null;
    }
    const f: PageFile = { v: VERSION, owner, savedAt: same ? before!.savedAt : now, checkedAt: now, hash, sealed, data };
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    writeFileAtomic(file, JSON.stringify(f), 0o600);
    if (!same) this.sweepSoon(computer);
    return { path: this.pathOf(computer, id, hash), savedAt: f.savedAt, checkedAt: now, hash, changed: !same };
  }

  /** The HTML for the gateway (null: none, unreadable or another account's); the gateway checks the link's key. */
  serve(computer: string, id: string): string | null {
    let f: PageFile | null;
    try { f = this.readFile(computer, id); } catch { return null; }
    if (!f) return null;
    if (!f.sealed) return f.data;
    try { return this.deps.secretBox?.decrypt(f.data) ?? null; } catch { return null; }
  }

  private touch(computer: string, id: string): void {
    const now = new Date();
    try { utimesSync(this.fileOf(computer, id), now, now); } catch { /* read-only: fine */ }
  }

  private drop(computer: string, id: string): void {
    try { rmSync(this.fileOf(computer, id), { force: true }); } catch { /* gone next time */ }
  }

  private sweepSoon(computer: string): void {
    const last = this.swept.get(computer) ?? 0;
    if (Date.now() - last < SWEEP_GAP_MS) return;
    this.swept.set(computer, Date.now());
    try { sweepCloudFiles(this.root, { maxBytes: copyBytes(this.deps.capMb()), computer }); } catch { /* next time */ }
  }

  private seal(plain: string): string | null {
    const box = this.deps.secretBox;
    if (!box) return null;
    try { return box.encrypt(plain); } catch (e) { this.deps.warn('cloud pages: sealing failed; kept as is', errMsg(e)); return null; }
  }
}
