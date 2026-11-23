import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchema, type Settings } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import type { FileRecord } from '../store';
import { deepMerge, silentLogger } from '../util';
import { StorageService } from './storage';

const DAY = 24 * 60 * 60 * 1000;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup(saved: Record<string, unknown> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'appubot-storage-'));
  dirs.push(dataDir);
  const filesDir = join(dataDir, 'files'), logsDir = join(dataDir, 'logs');
  mkdirSync(filesDir); mkdirSync(logsDir);
  let settings = SettingsSchema.parse(saved);
  let records: FileRecord[] = [];
  const listeners = new Set<(n: Settings, p: Settings) => void>();
  const ctx = {
    paths: { dataDir, filesDir, logsDir },
    log: silentLogger,
    store: { files: { get: () => records, update: (fn: (l: FileRecord[]) => FileRecord[]) => { records = fn(records); } } },
    s: {
      settings: {
        get: () => settings,
        update: (patch: Partial<Settings>) => { const prev = settings; settings = SettingsSchema.parse(deepMerge(prev, patch)); for (const l of listeners) l(settings, prev); },
        onChange: (fn: (n: Settings, p: Settings) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
      },
    },
  } as unknown as CoreCtx;
  const file = (id: string, ageDays: number, recorded = true) => {
    const dir = join(filesDir, id);
    mkdirSync(dir);
    const p = join(dir, 'a.bin');
    writeFileSync(p, Buffer.alloc(1000));
    const t = (Date.now() - ageDays * DAY) / 1000;
    utimesSync(dir, t, t);
    if (recorded) records.push({ id, name: 'a.bin', mimeType: 'application/octet-stream', size: 1000, url: `/files/${id}`, storedPath: p, createdAt: Date.now() - ageDays * DAY });
    return dir;
  };
  const log = (day: string, ageDays: number) => {
    const p = join(logsDir, `appubot-${day}.log`);
    writeFileSync(p, 'x'.repeat(100));
    const t = (Date.now() - ageDays * DAY) / 1000;
    utimesSync(p, t, t);
    return p;
  };
  return { ctx, svc: new StorageService(ctx), file, log, records: () => records, settings: ctx.s.settings };
}

describe('StorageService', () => {
  it('keeps chat files by default, but removes folders no record names once they are a day old', async () => {
    const t = setup();
    const old = t.file('file_old', 400);
    const orphan = t.file('file_orphan', 3, false);
    const fresh = t.file('file_fresh_orphan', 0, false);
    const s = await t.svc.clean();
    expect(existsSync(old)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(s.freedBytes).toBe(1000);
    expect(s.items.find((i) => i.id === 'files')).toMatchObject({ count: 1 });
  });

  it('deletes chat files older than filesDays with their records', async () => {
    const t = setup({ storage: { filesDays: 30 } });
    const old = t.file('file_old', 40);
    const recent = t.file('file_recent', 10);
    await t.svc.clean();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(t.records().map((r) => r.id)).toEqual(['file_recent']);
  });

  it("deletes only AppuBot's own logs older than logsDays", async () => {
    const t = setup({ storage: { logsDays: 7 } });
    const old = t.log('2026-01-01', 10);
    const recent = t.log('2026-01-05', 2);
    const other = join(t.ctx.paths.logsDir, 'main.log');
    writeFileSync(other, 'x');
    utimesSync(other, 0, 0);
    await t.svc.clean();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it('cleans up at once when a setting gets shorter', async () => {
    const t = setup();
    const old = t.file('file_old', 40);
    t.settings.update({ storage: { filesDays: 30, logsDays: 14, cloudCopyMb: 500 } });
    await t.svc.clean();
    expect(existsSync(old)).toBe(false);
  });
});
