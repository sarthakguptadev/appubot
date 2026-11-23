/** File attachments: registry (files.json), uploads into bot inboxes, and delivery of agent files to the user. */
import { createHmac, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { machineName, newId, type Bot, type FileAttachment } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import type { FileRecord } from '../store';
import { mimeFromName, RpcError } from '../util';

/** A name every OS can save: no characters Windows refuses (a Telegram song "What?.mp3"), no trailing dots or spaces. */
export function safeName(name: string): string {
  let b = basename((name || 'file').replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim().replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(b)) b = `_${b}`;
  if (!b || b === '.' || b === '..') return 'file';
  if (b.length <= 180) return b;
  // keep the extension when cutting a long name
  const ext = extname(b).slice(0, 12);
  return b.slice(0, 180 - ext.length) + ext;
}

function uniquePath(dir: string, name: string): string {
  let p = join(dir, name);
  if (!existsSync(p)) return p;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    p = join(dir, `${stem} (${i})${ext}`);
    if (!existsSync(p)) return p;
  }
}

function real(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

function isUnder(p: string, root: string): boolean {
  let r = real(root);
  // Windows paths compare case-insensitively (C:\Users\Ann is c:\users\ann)
  if (process.platform === 'win32') { p = p.toLowerCase(); r = r.toLowerCase(); }
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

export class FilesService {
  /** this run's key for visual replies' view links (`/pages/:id?v=`): a link opens that one page, never anything else */
  private pageKey = randomBytes(32);

  constructor(private ctx: CoreCtx) {}

  private get filesDir(): string { return this.ctx.paths.filesDir; }

  getRecord(id: string): FileRecord | undefined { return this.ctx.store.files.get().find((f) => f.id === id); }
  /** A stored file's record by id (its inbox copy's `path` when a bot has one, its `storedPath` always). */
  record(id: string): FileRecord | undefined { return this.getRecord(id); }

  /**
   * Open one of AppuBot's own files in its default Mac app (Preview, QuickTime…). Only files it stored itself, by id:
   * a path from the caller is never opened (`system.openPath` only shows a file in Finder).
   */
  async open(id: string): Promise<{ ok: true }> {
    const rec = this.getRecord(id);
    if (!rec || !existsSync(rec.storedPath)) throw new RpcError('not_found', `That file is no longer on this ${machineName(process.platform)}`);
    const open = this.ctx.deps.openFile;
    if (open) await open(rec.storedPath);
    else await this.ctx.deps.openExternal(pathToFileURL(rec.storedPath).href);
    return { ok: true };
  }

  toAttachment(r: FileRecord): FileAttachment {
    return { id: r.id, name: r.name, mimeType: r.mimeType, size: r.size, url: r.url, path: r.path, caption: r.caption };
  }

  list(o: { threadId?: string; limit?: number } = {}): FileAttachment[] {
    return this.ctx.store.files.get()
      .filter((f) => !o.threadId || f.threadId === o.threadId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, o.limit ?? 50)
      .map((f) => this.toAttachment(f));
  }

  private register(rec: FileRecord): FileRecord {
    this.ctx.store.files.update((l) => {
      const next = [...l, rec];
      return next.length > 5000 ? next.slice(next.length - 5000) : next;
    });
    return rec;
  }

  /** Path policy for files the agent wants to deliver: must exist, be a file, and live under $HOME or a temp dir. */
  checkDeliverablePath(p: string): string {
    if (!p || !isAbsolute(p)) throw new RpcError('invalid_params', 'Path must be absolute');
    if (!existsSync(p)) throw new RpcError('not_found', `File not found: ${p}`);
    const rp = real(p);
    const roots = process.platform === 'win32' ? [homedir(), tmpdir()] : [homedir(), '/tmp', '/private/tmp', tmpdir()];
    if (!roots.some((r) => isUnder(rp, r))) throw new RpcError('forbidden', `Refusing to send files outside your home folder or ${process.platform === 'win32' ? 'the temp folder' : '/tmp'}: ${p}`);
    const st = statSync(rp);
    if (!st.isFile()) throw new RpcError('invalid_params', `Not a file: ${p}`);
    if (st.size > 2 * 1024 * 1024 * 1024) throw new RpcError('invalid_params', 'File is larger than 2 GB');
    return rp;
  }

  /** Agent → user: copy the file into the files store, attach it to the chat, notify devices. */
  sendToDevices(path: string, caption: string | undefined, threadId: string | undefined): FileAttachment {
    const rp = this.checkDeliverablePath(path);
    const id = newId('file');
    const name = safeName(basename(rp));
    const dir = join(this.filesDir, id);
    mkdirSync(dir, { recursive: true });
    const storedPath = join(dir, name);
    copyFileSync(rp, storedPath);
    const rec = this.register({
      id, name, mimeType: mimeFromName(name), size: statSync(storedPath).size, url: `/files/${id}`, path: rp, caption,
      storedPath, threadId, createdAt: Date.now(),
    });
    const att = this.toAttachment(rec);
    this.ctx.bus.emit('file.created', att);
    let botName = 'AppuBot';
    if (threadId && this.ctx.s.threads.get(threadId)) {
      const { messageId } = this.ctx.s.chat.appendPart(threadId, { type: 'file', file: att });
      // a turn Telegram started gets the file there at once
      this.ctx.s.channels.fileSent(messageId, att);
      botName = this.ctx.s.bots.get(this.ctx.s.threads.get(threadId)!.botId)?.name ?? botName;
    }
    this.ctx.s.notifications.notify({ title: `${botName} sent a file`, body: caption ? `${name} - ${caption}` : name, threadId, level: 'success' });
    return att;
  }

  /* ---------------------------------------------------------- visual replies */

  /** A bot's page (`show_page`), kept as an HTML file of its thread (it shows in Files too). */
  storePage(title: string, html: string, threadId: string): FileAttachment {
    const id = newId('file');
    const stem = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    const name = safeName(`${stem || 'page'}.html`);
    const dir = join(this.filesDir, id);
    mkdirSync(dir, { recursive: true });
    const storedPath = join(dir, name);
    writeFileSync(storedPath, html, 'utf8');
    const rec = this.register({
      id, name, mimeType: 'text/html', size: Buffer.byteLength(html), url: `/files/${id}`, caption: title, storedPath, threadId, createdAt: Date.now(),
    });
    const att = this.toAttachment(rec);
    this.ctx.bus.emit('file.created', att);
    return att;
  }

  pageViewKey(id: string): string {
    return createHmac('sha256', this.pageKey).update(id).digest('base64url');
  }

  /** The gateway path a page loads from (`files.pageView`): only HTML pages AppuBot stored. */
  pageView(id: string): { path: string } {
    const rec = this.getRecord(id);
    if (!rec || rec.mimeType !== 'text/html' || !existsSync(rec.storedPath)) throw new RpcError('not_found', 'Page not found');
    return { path: `/pages/${id}?v=${this.pageViewKey(id)}` };
  }

  /** Upload into AppuBot (the window's attachments). With a thread, the file also lands in the bot's inbox. */
  upload(data: Uint8Array, name: string, mimeType: string | undefined, threadId?: string): FileAttachment {
    const id = newId('file');
    const clean = safeName(name);
    const dir = join(this.filesDir, id);
    mkdirSync(dir, { recursive: true });
    const storedPath = join(dir, clean);
    writeFileSync(storedPath, data);
    let rec: FileRecord = {
      id, name: clean, mimeType: mimeType && mimeType !== 'application/octet-stream' ? mimeType : mimeFromName(clean), size: data.byteLength,
      url: `/files/${id}`, storedPath, threadId, createdAt: Date.now(),
    };
    const thread = threadId ? this.ctx.s.threads.get(threadId) : undefined;
    const bot = thread ? this.ctx.s.bots.get(thread.botId) : undefined;
    if (bot) rec = this.copyToInbox(rec, bot);
    this.register(rec);
    return this.toAttachment(rec);
  }

  /** Where an upload is written while it arrives (`adopt` moves it into place): a fresh path on the same disk. */
  incomingPath(): string {
    const dir = join(this.filesDir, '.incoming');
    mkdirSync(dir, { recursive: true });
    return join(dir, `${newId('up')}.part`);
  }

  /** `upload`, for a file already written to disk (`incomingPath`): moved into place, never read into memory. */
  adopt(tempPath: string, name: string, mimeType: string | undefined, threadId?: string): FileAttachment {
    const id = newId('file');
    const clean = safeName(name);
    const dir = join(this.filesDir, id);
    mkdirSync(dir, { recursive: true });
    const storedPath = join(dir, clean);
    renameSync(tempPath, storedPath);
    let rec: FileRecord = {
      id, name: clean, mimeType: mimeType && mimeType !== 'application/octet-stream' ? mimeType : mimeFromName(clean), size: statSync(storedPath).size,
      url: `/files/${id}`, storedPath, threadId, createdAt: Date.now(),
    };
    const thread = threadId ? this.ctx.s.threads.get(threadId) : undefined;
    const bot = thread ? this.ctx.s.bots.get(thread.botId) : undefined;
    if (bot) rec = this.copyToInbox(rec, bot);
    this.register(rec);
    return this.toAttachment(rec);
  }

  private copyToInbox(rec: FileRecord, bot: Bot): FileRecord {
    const inbox = join(bot.workspace, 'inbox');
    mkdirSync(inbox, { recursive: true });
    const dest = uniquePath(inbox, rec.name);
    copyFileSync(rec.storedPath, dest);
    return { ...rec, path: dest };
  }

  /** Make sure an attachment the user sends to a bot is inside that bot's inbox. */
  ensureInInbox(rec: FileRecord, bot: Bot, threadId: string): FileRecord {
    if (rec.path && existsSync(rec.path) && isUnder(real(rec.path), bot.workspace)) return rec;
    const next = { ...this.copyToInbox(rec, bot), threadId: rec.threadId ?? threadId };
    this.ctx.store.files.update((l) => l.map((f) => (f.id === rec.id ? next : f)));
    return next;
  }
}
