/**
 * Settings › Storage (`storage.summary` / `storage.clean`): how much room AppuBot takes, and clearing out what's old
 * (after T3 Code's Storage settings). Every file a chat shows lives in `<filesDir>/<id>/` (FilesService); one older
 * than `settings.storage.filesDays` is deleted with its record (0 keeps them), and so is a folder no record names any
 * more (the registry keeps the newest 5000, so the gateway can't serve an older one anyway). AppuBot's own daily log
 * files (`appubot-YYYY-MM-DD.log`) go after `logsDays`. Runs a few minutes after launch, twice a day, and when the
 * settings change; voice models and downloaded agents are only measured (Settings › Voice and Agents remove them).
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Settings, StorageItem, StorageSummary } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { errMsg } from '../util';
import { CLOUD_FILES_DIR, cloudFilesSize, copyBytes, sweepCloudFiles } from './cloudFiles';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_SWEEP_MS = 3 * 60 * 1000;
const SWEEP_EVERY_MS = 12 * 60 * 60 * 1000;
/** a folder without a record is left this long: a file being stored writes its folder before its record */
const ORPHAN_GRACE_MS = DAY_MS;
const LOG_FILE = /^appubot-\d{4}-\d{2}-\d{2}\.log$/;

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** bytes and files under `dir` (symlinks not followed), yielding now and then so a big folder never blocks */
export async function folderSize(dir: string): Promise<{ bytes: number; count: number }> {
  let bytes = 0, count = 0, seen = 0;
  const walk = async (d: string): Promise<void> => {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        try { bytes += (await stat(p)).size; count++; } catch { /* gone meanwhile */ }
      }
      if (++seen % 500 === 0) await tick();
    }
  };
  await walk(dir);
  return { bytes, count };
}

export class StorageService {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<StorageSummary>;
  private cleanedAt?: number;
  private freedBytes?: number;

  constructor(private ctx: CoreCtx) {
    ctx.s.settings.onChange((next, prev) => {
      const a = next.storage, b = prev.storage;
      // a shorter keep takes effect now, not at the next sweep
      if ((a.filesDays && a.filesDays !== b.filesDays) || a.logsDays !== b.logsDays || (a.cloudCopyMb ?? 0) < (b.cloudCopyMb ?? 0)) void this.clean().catch(() => undefined);
    });
  }

  start(): void {
    const run = (ms: number) => {
      this.timer = setTimeout(() => { void this.clean().catch(() => undefined).finally(() => run(SWEEP_EVERY_MS)); }, ms);
      this.timer.unref?.();
    };
    run(FIRST_SWEEP_MS);
  }

  stop(): void { clearTimeout(this.timer); }

  async summary(): Promise<StorageSummary> {
    const { dataDir, filesDir, logsDir } = this.ctx.paths;
    const measure = async (id: StorageItem['id'], path: string, withCount = false): Promise<StorageItem> => {
      const { bytes, count } = await folderSize(path);
      return withCount ? { id, bytes, count, path } : { id, bytes, path };
    };
    const items = [
      await measure('files', filesDir, true),
      await measure('logs', logsDir, true),
      await measure('voice', join(dataDir, 'voice-models')),
      await measure('agents', join(dataDir, 'agents')),
    ];
    // the files item counts what chats show, not the files inside their folders
    items[0] = { ...items[0]!, count: this.ctx.store.files.get().length };
    // the pages and files kept of AppuBot computers (only where there are some: a cloud computer keeps none)
    const cloudRoot = join(dataDir, CLOUD_FILES_DIR);
    const cloud = cloudFilesSize(cloudRoot);
    return { items, ...(cloud.count ? { cloudCopies: { ...cloud, path: cloudRoot } } : {}), cleanedAt: this.cleanedAt, freedBytes: this.freedBytes };
  }

  /** One clean-up at a time; a call while one runs gets its result. */
  clean(): Promise<StorageSummary> {
    this.running ??= this.sweep().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async sweep(): Promise<StorageSummary> {
    const settings: Settings['storage'] = this.ctx.s.settings.get().storage;
    const now = Date.now();
    let freed = 0;
    freed += await this.sweepFiles(settings.filesDays, now);
    freed += await this.sweepLogs(settings.logsDays, now);
    freed += sweepCloudFiles(join(this.ctx.paths.dataDir, CLOUD_FILES_DIR), { maxBytes: copyBytes(settings.cloudCopyMb), now }).freed;
    this.cleanedAt = now;
    this.freedBytes = freed;
    if (freed) this.ctx.log.info(`storage: freed ${Math.round(freed / 1024)} KB`);
    return this.summary();
  }

  private async sweepFiles(days: number, now: number): Promise<number> {
    const dir = this.ctx.paths.filesDir;
    const records = this.ctx.store.files.get();
    const cutoff = days > 0 ? now - days * DAY_MS : -Infinity;
    const old = new Set(records.filter((r) => r.createdAt < cutoff).map((r) => r.id));
    const kept = new Set(records.filter((r) => !old.has(r.id)).map((r) => r.id));
    let names: string[];
    try { names = await readdir(dir); } catch { return 0; }
    let freed = 0;
    for (const name of names) {
      if (kept.has(name)) continue;
      const p = join(dir, name);
      try {
        const st = await stat(p);
        if (!st.isDirectory()) continue;
        if (!old.has(name) && now - st.mtimeMs < ORPHAN_GRACE_MS) continue;
        const { bytes } = await folderSize(p);
        await rm(p, { recursive: true, force: true });
        freed += bytes;
      } catch (e) { this.ctx.log.warn(`storage: couldn't remove ${p}`, errMsg(e)); }
    }
    if (old.size) this.ctx.store.files.update((l) => l.filter((r) => !old.has(r.id)));
    return freed;
  }

  private async sweepLogs(days: number, now: number): Promise<number> {
    const dir = this.ctx.paths.logsDir;
    const cutoff = now - days * DAY_MS;
    let names: string[];
    try { names = await readdir(dir); } catch { return 0; }
    let freed = 0;
    for (const name of names) {
      if (!LOG_FILE.test(name)) continue;
      const p = join(dir, name);
      try {
        const st = await stat(p);
        if (st.mtimeMs >= cutoff) continue;
        await rm(p, { force: true });
        freed += st.size;
      } catch (e) { this.ctx.log.warn(`storage: couldn't remove ${p}`, errMsg(e)); }
    }
    return freed;
  }
}
