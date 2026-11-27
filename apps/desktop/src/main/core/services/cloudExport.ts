/**
 * "Download my bots" on an AppuBot Cloud computer: one zip of the bots' folder (`~/AppuBot`) and AppuBot's store
 * (threads, bots, routines, settings, the chats' files), made here and handed to the owner over the end-to-end channel
 * as an ordinary file (`/files/:id?download=1`), so neither AppuBot's backend nor Agent37's files API ever carries it.
 * Secrets stay out: the agents' keys, the Vault, the bots' key files, Composio's tokens, this computer's identity,
 * paired devices, and Telegram tokens (channels.json goes in with its tokens blanked). The zip is written as a stream
 * (deflate per file, data descriptors), so a 10 GB folder never sits in memory; the previous export is replaced.
 */
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, type Stats } from 'node:fs';
import { createDeflateRaw, deflateRawSync } from 'node:zlib';
import { basename, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import { newId, type FileAttachment } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import type { FileRecord } from '../store';
import { errMsg, RpcError, todayStamp } from '../util';

/** files of the data folder that never go in an export: secrets, this computer's own identity and pairings, scratch */
export const EXCLUDED_DATA_FILES: ReadonlySet<string> = new Set([
  'agent-keys.json', 'vault.json', 'connect.json', 'apps.json', 'connectors.json', 'devices.json', 'sent-ids.json', 'model-endpoints.json',
  'cloud-state.json', 'cloud-wake.json', 'cloud.json', 'login-item.json', 'analytics-id', 'analytics-version', 'update-attempt.json',
  'version-policy.json', 'provider-choices.json', 'provider-updates.json', 'acp-registry.json', 'agent-auth.json',
]);
/** folders of the data folder left out: what AppuBot can download or make again, and what is secret */
export const EXCLUDED_DATA_DIRS: ReadonlySet<string> = new Set([
  'vault-keys', 'logs', 'agents', 'agent-tmp', 'agent-homes', 'agent-probe', 'character-studio', 'profiles', 'voice-models', 'npm', 'uv', 'electron',
]);
/** folders inside the bots' folder that are made again by tools, never the user's work: left out (they can run to thousands of files) */
export const EXCLUDED_BOT_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.cache', '.pnpm-store']);
/** the export's own name: the previous one is removed before a new one is made */
const EXPORT_PREFIX = 'appubot-export-';
/** one file this big or bigger doesn't fit a zip entry without ZIP64 sizes (only offsets and counts get ZIP64 here): left out and listed */
const ENTRY_MAX = 0xffff_ffff;
/** files smaller than this are stored as they are (deflate wouldn't help) */
const STORE_UNDER = 64;

export interface ExportResult extends FileAttachment { entries: number; skipped: string[] }

export class CloudExportService {
  private running: Promise<ExportResult> | null = null;

  constructor(private ctx: CoreCtx) {}

  /**
   * Make the export (one at a time: a second call while one runs gets the same result) and register it as a file of
   * this computer, downloadable by the owner. Available everywhere, meant for the cloud (the Mac has its folders).
   */
  export(): Promise<ExportResult> {
    if (this.running) return this.running;
    const p = this.build().finally(() => { if (this.running === p) this.running = null; });
    this.running = p;
    return p;
  }

  private async build(): Promise<ExportResult> {
    const { paths } = this.ctx;
    // the previous export goes: it is this computer's biggest file, and the new one replaces it
    for (const rec of this.ctx.store.files.get()) {
      if (rec.name.startsWith(EXPORT_PREFIX) && !rec.threadId) {
        try { rmSync(join(paths.filesDir, rec.id), { recursive: true, force: true }); } catch { /* gone */ }
        this.ctx.store.files.update((l) => l.filter((f) => f.id !== rec.id));
      }
    }
    const id = newId('file');
    const name = `${EXPORT_PREFIX}${todayStamp()}.zip`;
    const dir = join(paths.filesDir, id);
    mkdirSync(dir, { recursive: true });
    const storedPath = join(dir, name);
    const skipped: string[] = [];
    const zip = new ZipWriter(createWriteStream(storedPath));
    let entries = 0;
    try {
      const add = async (abs: string, rel: string, st: Stats) => {
        if (st.size >= ENTRY_MAX) { skipped.push(`${rel} (too large)`); return; }
        await zip.file(rel, abs, st);
        entries++;
      };
      // the bots' folder: everything in it (their files, memory, skills, inboxes), except an export left there
      if (existsSync(paths.botsRoot)) {
        for (const f of walk(paths.botsRoot, (abs, _rel, isDir) => !isDir || !EXCLUDED_BOT_DIRS.has(basename(abs)) || abs.startsWith(EXPORT_PREFIX))) await add(f.abs, `AppuBot/${f.rel}`, f.st);
      }
      // the store: AppuBot's own files, minus the secrets and what it makes again
      const dataRoot = paths.dataDir;
      const filesDir = paths.filesDir;
      const keep = (abs: string, rel: string, isDir: boolean): boolean => {
        const top = rel.split('/')[0]!;
        if (isDir) return !EXCLUDED_DATA_DIRS.has(top);
        if (rel.split('/').length === 1 && EXCLUDED_DATA_FILES.has(top)) return false;
        // the chats' files come, the exports in them (this one included) don't
        if ((abs.startsWith(filesDir + sep) || abs === filesDir) && basename(abs).startsWith(EXPORT_PREFIX)) return false;
        if (/\.tmp$/.test(rel)) return false;
        return true;
      };
      for (const f of walk(dataRoot, keep)) {
        if (f.rel === 'channels.json') { await zip.bytes(`appubot-data/${f.rel}`, Buffer.from(redactChannels(readFileSync(f.abs, 'utf8')))); entries++; continue; }
        if (f.rel === 'providers.json') { await zip.bytes(`appubot-data/${f.rel}`, Buffer.from(redactEnv(readFileSync(f.abs, 'utf8')))); entries++; continue; }
        await add(f.abs, `appubot-data/${f.rel}`, f.st);
      }
      const notes = [
        `AppuBot Cloud export, ${new Date().toISOString()}`,
        '',
        'AppuBot/        your bots: their folders, files, memory (MEMORY.md), skills and inboxes',
        'appubot-data/   AppuBot’s own records: bots, threads (chats), routines, settings, the chats’ files',
        '',
        'Left out on purpose: your agents’ keys and logins, the Vault, Composio’s tokens, Telegram tokens, paired devices and this computer’s own keys.',
        ...(skipped.length ? ['', 'Too large for this zip:', ...skipped.map((s) => `  ${s}`)] : []),
        '',
      ].join('\n');
      await zip.bytes('README.txt', Buffer.from(notes));
      entries++;
      await zip.finish();
    } catch (e) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new RpcError('internal', `Making the export failed: ${errMsg(e)}`);
    }
    const rec: FileRecord = { id, name, mimeType: 'application/zip', size: statSync(storedPath).size, url: `/files/${id}`, storedPath, createdAt: Date.now() };
    this.ctx.store.files.update((l) => [...l, rec]);
    this.ctx.store.files.flush();
    const att = this.ctx.s.files.toAttachment(rec);
    this.ctx.bus.emit('file.created', att);
    this.ctx.log.info(`cloud: export made, ${entries} entries, ${rec.size} bytes`);
    return { ...att, entries, skipped };
  }
}

/* -------------------------------------------------------------- walking */

interface Found { abs: string; rel: string; st: Stats }

/** Every regular file under `root` (symlinks skipped), relative paths with `/`, in a stable order. */
export function* walk(root: string, keep: (abs: string, rel: string, isDir: boolean) => boolean): Generator<Found> {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { continue; }
    // deepest-first stack: push in reverse so the sorted order comes out
    for (const n of names.reverse()) {
      const abs = join(dir, n);
      const rel = relative(root, abs).split(sep).join('/');
      let st: Stats;
      try { st = lstatSync(abs); } catch { continue; }
      // symlinks are skipped: a bot's `.agents/skills` link points inside its folder, which comes anyway
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (keep(abs, rel, true)) stack.push(abs); continue; }
      if (st.isFile() && keep(abs, rel, false)) yield { abs, rel, st };
    }
  }
}

/** channels.json with its Telegram tokens blanked (the rest, the bot each one answers as and its allowed users, kept). */
export function redactChannels(json: string): string {
  try {
    const list = JSON.parse(json) as unknown;
    if (!Array.isArray(list)) return json;
    return JSON.stringify(list.map((c) => (c && typeof c === 'object' && 'token' in c ? { ...(c as Record<string, unknown>), token: undefined } : c)), null, 2);
  } catch {
    return json;
  }
}

/** providers.json with every `env` value blanked (a custom agent's variables may hold keys). */
export function redactEnv(json: string): string {
  const scrub = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        out[k] = k === 'env' && x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x as object).map((n) => [n, ''])) : scrub(x);
      }
      return out;
    }
    return v;
  };
  try { return JSON.stringify(scrub(JSON.parse(json)), null, 2); } catch { return json; }
}

/* ----------------------------------------------------------- zip writing */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

interface Entry { name: Buffer; offset: number; crc: number; size: number; csize: number; method: 0 | 8; time: number; date: number }

/** MS-DOS time and date of a moment (what a zip records, to 2 seconds). */
function dosTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * A minimal zip writer onto a stream: each entry a local header with a data descriptor (flag bit 3, so sizes and the
 * CRC go after the data, which lets a file stream through deflate without being read twice), then the central
 * directory. Plain zip (no ZIP64): entries and the whole stay under 4 GB, which the caller checks.
 */
export class ZipWriter {
  private entries: Entry[] = [];
  private offset = 0;

  constructor(private out: Writable) {}

  private write(buf: Buffer): Promise<void> {
    this.offset += buf.length;
    return new Promise((resolve, reject) => {
      const ok = this.out.write(buf, (e) => (e ? reject(e) : undefined));
      if (ok) resolve();
      else this.out.once('drain', resolve);
    });
  }

  private header(name: Buffer, method: 0 | 8, time: number, date: number): Buffer {
    const h = Buffer.alloc(30 + name.length);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4); // version needed
    h.writeUInt16LE(0x0808, 6); // flags: data descriptor, UTF-8 names
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    // crc, sizes in the descriptor
    h.writeUInt16LE(name.length, 26);
    h.writeUInt16LE(0, 28);
    name.copy(h, 30);
    return h;
  }

  private descriptor(crc: number, csize: number, size: number): Buffer {
    const d = Buffer.alloc(16);
    d.writeUInt32LE(0x08074b50, 0);
    d.writeUInt32LE(crc >>> 0, 4);
    d.writeUInt32LE(csize, 8);
    d.writeUInt32LE(size, 12);
    return d;
  }

  /** A file from disk, deflated (stored when tiny). */
  async file(name: string, path: string, st: Stats): Promise<void> {
    const method: 0 | 8 = st.size < STORE_UNDER ? 0 : 8;
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosTime(st.mtime);
    const offset = this.offset;
    await this.write(this.header(nameBuf, method, time, date));
    let crc = 0;
    let size = 0;
    let csize = 0;
    const counter = new Transform({
      transform: (chunk: Buffer, _enc, cb) => { crc = crc32(chunk, crc); size += chunk.length; cb(null, chunk); },
    });
    // the sink writes into the archive's stream itself (its callback waits for the write), so the stream gets no
    // listeners per entry and backpressure still holds
    const sink = new Writable({
      write: (chunk: Buffer, _enc, cb) => { csize += chunk.length; this.offset += chunk.length; this.out.write(chunk, cb); },
    });
    const src = createReadStream(path);
    if (method === 8) await pipeline(src, counter, createDeflateRaw({ level: 6 }), sink);
    else await pipeline(src, counter, sink);
    await this.write(this.descriptor(crc, csize, size));
    this.entries.push({ name: nameBuf, offset, crc, size, csize, method, time, date });
  }

  /** Bytes made here (a README, a redacted file), deflated unless tiny. */
  async bytes(name: string, data: Buffer, mtime = new Date()): Promise<void> {
    const method: 0 | 8 = data.length < STORE_UNDER ? 0 : 8;
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosTime(mtime);
    const offset = this.offset;
    await this.write(this.header(nameBuf, method, time, date));
    const body = method === 8 ? deflateRawSync(data, { level: 6 }) : data;
    await this.write(body);
    const crc = crc32(data);
    await this.write(this.descriptor(crc, body.length, data.length));
    this.entries.push({ name: nameBuf, offset, crc, size: data.length, csize: body.length, method, time, date });
  }

  /**
   * The central directory and the end record; the stream is ended. An entry past 4 GB into the archive carries its
   * offset in a ZIP64 extra field, and an archive with more than 65,535 entries (or a directory past 4 GB) gets the
   * ZIP64 end records, so a big export still opens everywhere ZIP64 is read (every current unzip).
   */
  async finish(): Promise<void> {
    const start = this.offset;
    const MAX32 = 0xffff_ffff;
    for (const e of this.entries) {
      const zip64 = e.offset >= MAX32;
      const extra = zip64 ? Buffer.alloc(12) : Buffer.alloc(0);
      if (zip64) { extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(8, 2); extra.writeBigUInt64LE(BigInt(e.offset), 4); }
      const c = Buffer.alloc(46 + e.name.length + extra.length);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(zip64 ? 45 : 20, 4); // made by
      c.writeUInt16LE(zip64 ? 45 : 20, 6); // needed
      c.writeUInt16LE(0x0808, 8);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(e.time, 12);
      c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc >>> 0, 16);
      c.writeUInt32LE(e.csize, 20);
      c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.name.length, 28);
      c.writeUInt16LE(extra.length, 30);
      c.writeUInt16LE(0, 32); // comment
      c.writeUInt16LE(0, 34); // disk
      c.writeUInt16LE(0, 36); // internal attrs
      c.writeUInt32LE(0, 38); // external attrs
      c.writeUInt32LE(zip64 ? MAX32 : e.offset, 42);
      e.name.copy(c, 46);
      extra.copy(c, 46 + e.name.length);
      await this.write(c);
    }
    const size = this.offset - start;
    const n = this.entries.length;
    const big = n > 0xffff || size >= MAX32 || start >= MAX32;
    if (big) {
      const at = this.offset;
      const z = Buffer.alloc(56);
      z.writeUInt32LE(0x06064b50, 0);
      z.writeBigUInt64LE(BigInt(44), 4); // size of the rest of this record
      z.writeUInt16LE(45, 12);
      z.writeUInt16LE(45, 14);
      z.writeUInt32LE(0, 16);
      z.writeUInt32LE(0, 20);
      z.writeBigUInt64LE(BigInt(n), 24);
      z.writeBigUInt64LE(BigInt(n), 32);
      z.writeBigUInt64LE(BigInt(size), 40);
      z.writeBigUInt64LE(BigInt(start), 48);
      await this.write(z);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(at), 8);
      loc.writeUInt32LE(1, 16);
      await this.write(loc);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(Math.min(n, 0xffff), 8);
    end.writeUInt16LE(Math.min(n, 0xffff), 10);
    end.writeUInt32LE(Math.min(size, MAX32), 12);
    end.writeUInt32LE(Math.min(start, MAX32), 16);
    end.writeUInt16LE(0, 20);
    await this.write(end);
    await new Promise<void>((resolve, reject) => this.out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  }
}
