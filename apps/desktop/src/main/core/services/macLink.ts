/**
 * This computer's folders, lent to the bots on another of the person's computers (protocol `carry.ts`; the reading
 * end is `macFiles.ts`). The person picks the folders (`setFolders`) and links a computer (`create`: a token for it,
 * and where this computer is on AppuBot Connect). That computer then asks through the same end-to-end channel a
 * phone uses, with its token as the credential, on five paths of the gateway (`/api/link/…`): the lent folders, a
 * folder's listing, a search by name, one file, and saving one file (`put`).
 *
 * Everything is decided here, on the computer the files are on:
 *  - read-only unless the person switched that folder to take changes (`setWritable`, off by default): then a file
 *    may be created there (missing folders too) or replaced, never deleted, renamed or moved; a replaced file's old
 *    version goes to the Trash first (`deps.trashItem`), else into `<dataDir>/mac-link-replaced/` (the newest
 *    `REPLACED_KEEP` kept), and the new one is written beside it and renamed into place, so nothing is half written;
 *    hidden files and folders (`.git`, `.env`…) are never written, so nothing that runs by itself can be planted;
 *  - only inside a lent folder, by real path (a link pointing out of one leads nowhere; a file is saved only where
 *    its folder's real path is in a folder switched on);
 *  - never what holds credentials (`NEVER_LENT`: `~/.ssh`, the Keychains, cloud and package-manager sign-ins,
 *    AppuBot's own data), whatever was lent; and nothing under `~/Library` or a dot-folder of the home folder unless
 *    the lent folder itself is in there (lending `~` gives Documents and Desktop, not the browser's profile);
 *  - a file up to `MAC_FILE_MAX_BYTES`.
 *
 * The token is kept as its hash (`<dataDir>/mac-link.json`, 0600); a link is taken back with `revoke`. A linked
 * computer keeps AppuBot Connect up for this one (`ConnectService.wanted`).
 */
import { randomBytes } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  MAC_FILE_MAX_BYTES, MAC_FIND_MAX, MAC_LINK_FOLDERS_MAX, MAC_LIST_MAX, newId,
  type LinkPut, type MacEntry, type MacFolder, type MacLinkGrant, type MacLinkStatus,
} from '@appubot/protocol';
import { bytes } from '@appubot/chat-core';
import type { CoreCtx } from '../context';
import { JsonFile } from '../store';
import { errMsg, randomToken, RpcError, sha256 } from '../util';

interface StoredLink { id: string; name: string; tokenHash: string; createdAt: number; lastUsedAt?: number; lastSavedAt?: number; lastSavedName?: string }
/** `writable`: the lent folders switched to take the bots' changes (absent in files from before: none) */
interface LinkFile { folders: string[]; writable?: string[]; links: StoredLink[] }

/** computers that may be linked at once */
const LINKS_MAX = 5;
/** how long a search may look, and how many entries it may pass, before it answers with what it has */
const FIND_BUDGET_MS = 8000;
const FIND_VISIT_MAX = 60_000;
/** folders a search never goes into (dependencies, version control: never what a person means) */
const FIND_SKIP = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', '.Trash']);
/** replaced files kept in AppuBot's own folder where the Trash can't take them (the newest) */
const REPLACED_KEEP = 30;
export const REPLACED_DIR = 'mac-link-replaced';

/** under the home folder: never lent, whatever folder was picked */
export const NEVER_LENT = [
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config/gh', '.config/gcloud', '.netrc', '.git-credentials', '.npmrc', '.pypirc',
  '.codex/auth.json', '.claude/.credentials.json', 'Library/Keychains', 'Library/Cookies',
];

/** `child` is `parent` or inside it (both real, absolute paths) */
export function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export interface LendRules {
  home: string;
  /** real paths lent */
  folders: string[];
  /** more real paths never lent (AppuBot's own data) */
  never: string[];
}

/** Why a real path isn't lent, or null when it is. */
export function refusal(real: string, r: LendRules): string | null {
  const root = r.folders.find((f) => inside(real, f));
  if (!root) return 'That is outside the folders lent to this computer.';
  for (const n of [...NEVER_LENT.map((p) => join(r.home, p)), ...r.never]) if (inside(real, n)) return 'That holds sign-ins or keys, which are never lent.';
  // the home folder's own Library and dot-folders: only when the lent folder itself is in there
  const rel = relative(r.home, real);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    const top = rel.split(sep)[0]!;
    if ((top === 'Library' || top.startsWith('.')) && !inside(root, join(r.home, top))) return 'That part of the home folder isn’t lent.';
  }
  return null;
}

export class MacLinkService {
  private file: JsonFile<LinkFile>;

  constructor(private ctx: CoreCtx) {
    this.file = new JsonFile<LinkFile>(join(ctx.paths.dataDir, 'mac-link.json'), () => ({ folders: [], links: [] }), 150, ctx.log, (raw) => {
      const r = raw as Partial<LinkFile>;
      return {
        folders: Array.isArray(r.folders) ? r.folders.filter((f): f is string => typeof f === 'string') : [],
        writable: Array.isArray(r.writable) ? r.writable.filter((f): f is string => typeof f === 'string') : [],
        links: Array.isArray(r.links) ? r.links.filter((l) => l && typeof l.id === 'string' && typeof l.tokenHash === 'string') : [],
      };
    }, 0o600);
  }

  private get home(): string {
    const h = this.ctx.deps.homeDir ?? homedir();
    try { return realpathSync.native(h); } catch { return h; }
  }

  private rules(): LendRules {
    const never: string[] = [];
    for (const p of [this.ctx.paths.dataDir, this.ctx.paths.systemDir]) {
      if (!p) continue;
      try { never.push(realpathSync.native(p)); } catch { never.push(p); }
    }
    return { home: this.home, folders: this.file.get().folders, never };
  }

  hasLinks(): boolean { return this.file.get().links.length > 0; }

  /** why the other computer can't reach this one now, or undefined when it can */
  private blocked(): string | undefined {
    if (this.ctx.deps.cloud) return 'An AppuBot computer doesn’t lend its files this way.';
    const s = this.ctx.s.settings.get();
    if (s.gateway.bind === 'loopback') return 'This computer is set to answer only itself (Settings › Devices), so nothing else can reach its files.';
    if (!s.connect.enabled) return 'AppuBot Connect is off on this computer (Settings › Devices). Turn it on so your AppuBot computer can reach these files.';
    if (this.ctx.deps.accountRequired && !this.ctx.s.cloudAccount.isSignedIn()) return 'Sign in to AppuBot on this computer first.';
    return undefined;
  }

  status(): MacLinkStatus {
    const f = this.file.get();
    const blocked = this.blocked();
    return {
      folders: f.folders,
      writable: this.writable(),
      links: f.links.map((l) => ({
        id: l.id, name: l.name, createdAt: l.createdAt, ...(l.lastUsedAt ? { lastUsedAt: l.lastUsedAt } : {}),
        ...(l.lastSavedAt ? { lastSavedAt: l.lastSavedAt, ...(l.lastSavedName ? { lastSavedName: l.lastSavedName } : {}) } : {}),
      })),
      ...(blocked && f.links.length ? { blocked } : {}),
    };
  }

  /** The folders lent, as the person picked them: real directories, none that holds sign-ins, none inside another. */
  setFolders(list: string[]): MacLinkStatus {
    const home = this.home;
    const real: string[] = [];
    for (const raw of list) {
      const typed = raw.trim().replace(/^~(?=$|[\\/])/, home);
      if (!isAbsolute(typed)) throw new RpcError('invalid_params', `“${raw}” isn’t a full path.`);
      let p: string;
      try { p = realpathSync.native(resolve(typed)); } catch { throw new RpcError('invalid_params', `“${raw}” isn’t there any more.`); }
      let dir = false;
      try { dir = statSync(p).isDirectory(); } catch { /* gone */ }
      if (!dir) throw new RpcError('invalid_params', `“${raw}” isn’t a folder.`);
      if (resolve(p, '..') === p) throw new RpcError('invalid_params', 'The whole disk can’t be lent: pick the folders your bots need.');
      const why = refusal(p, { ...this.rules(), folders: [p] });
      if (why && why !== 'That part of the home folder isn’t lent.') throw new RpcError('invalid_params', `“${raw}” can’t be lent: it holds sign-ins or keys.`);
      if (!real.includes(p)) real.push(p);
    }
    // a folder inside another lent one adds nothing
    const folders = real.filter((p) => !real.some((o) => o !== p && inside(p, o))).sort((a, b) => a.localeCompare(b));
    if (folders.length > MAC_LINK_FOLDERS_MAX) throw new RpcError('invalid_params', `At most ${MAC_LINK_FOLDERS_MAX} folders can be lent.`);
    // a folder that stays keeps its switch; one taken off loses it (lent again later, it starts read-only)
    this.file.update((f) => ({ ...f, folders, writable: (f.writable ?? []).filter((w) => folders.includes(w)) }));
    this.file.flush();
    return this.status();
  }

  /** the lent folders the bots may change */
  private writable(): string[] {
    const f = this.file.get();
    return (f.writable ?? []).filter((w) => f.folders.includes(w));
  }

  /** A lent folder switched to take the bots' changes (create or replace a file), or back to read-only. */
  setWritable(folder: string, on: boolean): MacLinkStatus {
    const f = this.file.get();
    if (!f.folders.includes(folder)) throw new RpcError('invalid_params', `“${folder}” isn’t one of the folders lent.`);
    const rest = this.writable().filter((w) => w !== folder);
    this.file.update((x) => ({ ...x, writable: on ? [...rest, folder].sort((a, b) => a.localeCompare(b)) : rest }));
    this.file.flush();
    this.ctx.log.info(`mac link: ${basename(folder)} ${on ? 'takes the bots’ changes' : 'is read-only again'}`);
    return this.status();
  }

  /** A token for another computer, and where it finds this one. The token is answered this once; only its hash is kept. */
  async create(name: string): Promise<MacLinkGrant> {
    const blocked = this.blocked();
    if (blocked) throw new RpcError('unavailable', blocked);
    if (this.file.get().links.length >= LINKS_MAX) throw new RpcError('invalid_params', `At most ${LINKS_MAX} computers can be linked. Remove one first.`);
    const token = randomToken(32);
    const link: StoredLink = { id: newId('lnk'), name: name.trim(), tokenHash: sha256(token), createdAt: Date.now() };
    this.file.update((f) => ({ ...f, links: [...f.links, link] }));
    this.file.flush();
    this.ctx.s.connect.linksChanged();
    const info = this.ctx.s.connect.connectInfo();
    if (!info) {
      this.drop(link.id);
      throw new RpcError('unavailable', 'AppuBot Connect couldn’t start on this computer, so your AppuBot computer has no way to reach it. Check Settings › Devices.');
    }
    this.ctx.log.info(`mac link: ${link.name} may read ${this.file.get().folders.length} lent folder(s)`);
    return { id: link.id, token, connectId: info.connectId, connectKey: info.connectKey, hostName: this.ctx.deps.hostName };
  }

  private drop(id: string): void {
    this.file.update((f) => ({ ...f, links: f.links.filter((l) => l.id !== id) }));
    this.file.flush();
    this.ctx.s.connect.linksChanged();
  }

  revoke(id: string): MacLinkStatus {
    this.drop(id);
    return this.status();
  }

  /** The link a token belongs to (its last use noted, at most once a minute). */
  verify(token: string | undefined | null): StoredLink | undefined {
    if (!token || token.length < 16) return undefined;
    const hash = sha256(token);
    const link = this.file.get().links.find((l) => l.tokenHash === hash);
    if (!link) return undefined;
    const now = Date.now();
    if (!link.lastUsedAt || now - link.lastUsedAt > 60_000) {
      this.file.update((f) => ({ ...f, links: f.links.map((l) => (l.id === link.id ? { ...l, lastUsedAt: now } : l)) }));
    }
    return link;
  }

  /* ---------- what a linked computer may ask (the gateway's `/api/link/…`) ---------- */

  roots(): { hostName: string; folders: MacFolder[]; saves: true } {
    const writable = this.writable();
    return { hostName: this.ctx.deps.hostName, saves: true, folders: this.file.get().folders.map((path) => ({ name: basename(path) || path, path, ...(writable.includes(path) ? { writable: true } : {}) })) };
  }

  /** The real path of something lent; throws `forbidden` / `not_found` with words for the bot. */
  private async lent(path: string): Promise<string> {
    const rules = this.rules();
    if (!rules.folders.length) throw new RpcError('forbidden', 'No folders are lent to this computer yet.');
    const typed = path.trim().replace(/^~(?=$|[\\/])/, rules.home);
    if (!isAbsolute(typed)) throw new RpcError('invalid_params', 'Give the full path, as a listing shows it.');
    let real: string;
    try { real = await realpath(resolve(typed)); } catch { throw new RpcError('not_found', `Nothing is at ${typed}.`); }
    const why = refusal(real, rules);
    if (why) throw new RpcError('forbidden', why);
    return real;
  }

  private async entry(dir: string, name: string, rules: LendRules): Promise<MacEntry | undefined> {
    const path = join(dir, name);
    try {
      const l = await lstat(path);
      // a link is what it points at, and only when that is lent too
      const real = l.isSymbolicLink() ? await realpath(path) : path;
      if (refusal(real, rules)) return undefined;
      const st = l.isSymbolicLink() ? await stat(real) : l;
      if (!st.isDirectory() && !st.isFile()) return undefined;
      return { name, path, dir: st.isDirectory(), ...(st.isFile() ? { size: st.size } : {}), modified: Math.round(st.mtimeMs) };
    } catch {
      return undefined;
    }
  }

  async list(path: string): Promise<{ path: string; entries: MacEntry[]; truncated?: boolean }> {
    const dir = await this.lent(path);
    let names: string[];
    try { names = await readdir(dir); } catch (e) {
      throw new RpcError((e as NodeJS.ErrnoException).code === 'ENOTDIR' ? 'invalid_params' : 'unavailable', (e as NodeJS.ErrnoException).code === 'ENOTDIR' ? `${dir} is a file, not a folder.` : `Couldn’t read ${dir}: ${errMsg(e)}`);
    }
    const rules = this.rules();
    const entries: MacEntry[] = [];
    for (const name of names.filter((n) => n !== '.DS_Store').sort((a, b) => a.localeCompare(b))) {
      const e = await this.entry(dir, name, rules);
      if (e) entries.push(e);
      if (entries.length > MAC_LIST_MAX) break;
    }
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    const truncated = entries.length > MAC_LIST_MAX;
    return { path: dir, entries: entries.slice(0, MAC_LIST_MAX), ...(truncated ? { truncated } : {}) };
  }

  /** Files and folders whose name has `query` in it, under `path` or every lent folder. */
  async find(query: string, path?: string): Promise<{ entries: MacEntry[]; truncated?: boolean }> {
    const q = query.trim().toLowerCase();
    if (!q) throw new RpcError('invalid_params', 'Say what to look for.');
    const rules = this.rules();
    const queue = path ? [await this.lent(path)] : [...rules.folders];
    if (!queue.length) throw new RpcError('forbidden', 'No folders are lent to this computer yet.');
    const out: MacEntry[] = [];
    const until = Date.now() + FIND_BUDGET_MS;
    let visited = 0;
    let truncated = false;
    while (queue.length) {
      const dir = queue.shift()!;
      let names: string[];
      try { names = await readdir(dir); } catch { continue; }
      for (const name of names) {
        if (++visited > FIND_VISIT_MAX || Date.now() > until) { truncated = true; queue.length = 0; break; }
        if (name === '.DS_Store') continue;
        const hit = name.toLowerCase().includes(q);
        const walk = !FIND_SKIP.has(name) && !name.startsWith('.');
        if (!hit && !walk) continue;
        const e = await this.entry(dir, name, rules);
        if (!e) continue;
        if (hit) {
          out.push(e);
          if (out.length >= MAC_FIND_MAX) { truncated = true; queue.length = 0; break; }
        }
        if (e.dir && walk) queue.push(e.path);
      }
    }
    return { entries: out, ...(truncated ? { truncated } : {}) };
  }

  /** One lent file, to stream: its real path, size and name. */
  async fileAt(path: string): Promise<{ path: string; size: number; name: string }> {
    const real = await this.lent(path);
    const st = await stat(real).catch(() => undefined);
    if (!st) throw new RpcError('not_found', `Nothing is at ${path}.`);
    if (st.isDirectory()) throw new RpcError('invalid_params', `${path} is a folder: list it, then bring the files you need.`);
    if (!st.isFile()) throw new RpcError('invalid_params', `${path} isn’t a file that can be read.`);
    if (st.size > MAC_FILE_MAX_BYTES) throw new RpcError('too_large', `${basename(real)} is ${bytes(st.size)}: larger than the ${bytes(MAC_FILE_MAX_BYTES)} a bot may bring over at once.`);
    return { path: real, size: st.size, name: basename(real) };
  }

  /**
   * Saves one file a bot sent (`body`, at most `MAC_FILE_MAX_BYTES`) at `path`, inside a lent folder switched to take
   * changes: created (with any missing folders inside the lent one) or replacing a file, whose old version goes to the
   * Trash (else AppuBot's own folder) first. Throws `forbidden` / `not_found` / `too_large` / `invalid_params` with
   * words for the bot.
   */
  async put(path: string, body: AsyncIterable<Uint8Array> | null, linkId: string, declared?: number): Promise<LinkPut> {
    const rules = this.rules();
    if (!rules.folders.length) throw new RpcError('forbidden', 'No folders are lent to this computer yet.');
    if (declared !== undefined && declared > MAC_FILE_MAX_BYTES) throw new RpcError('too_large', `That is ${bytes(declared)}: larger than the ${bytes(MAC_FILE_MAX_BYTES)} a bot may save at once.`);
    const typed = path.trim().replace(/^~(?=$|[\\/])/, rules.home);
    if (!isAbsolute(typed)) throw new RpcError('invalid_params', 'Give the full path, inside a folder a listing shows.');
    const want = resolve(typed);
    const name = basename(want);
    if (!name || name === '.' || name === '..' || resolve(want, '..') === want) throw new RpcError('invalid_params', 'Give the path of a file, with its name.');

    // the nearest folder that is there, by real path, plus what is missing under it
    const missing: string[] = [];
    let at = dirname(want);
    let real: string | undefined;
    for (;;) {
      try { real = await realpath(at); break; } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(at) === at) throw new RpcError('invalid_params', `${at} can’t be used: ${errMsg(e)}`);
        missing.unshift(basename(at));
        at = dirname(at);
      }
    }
    let parent = join(real!, ...missing);
    let target = join(parent, name);
    // what is at the path now: a link is where it points, judged the same way
    let old: { mode: number } | undefined;
    const now = await lstat(target).catch(() => undefined);
    if (now?.isSymbolicLink()) {
      try { target = await realpath(target); } catch { throw new RpcError('forbidden', `${want} is a shortcut to something that isn’t there.`); }
      parent = dirname(target);
    }
    this.mayWrite(target, rules);
    const st = now ? await stat(target).catch(() => undefined) : undefined;
    if (st) {
      if (st.isDirectory()) throw new RpcError('invalid_params', `${want} is a folder: give the path of a file in it.`);
      if (!st.isFile()) throw new RpcError('invalid_params', `${want} isn’t a file that can be replaced.`);
      old = { mode: st.mode & 0o777 };
    }
    if (missing.length && !now) {
      await mkdir(parent, { recursive: true }).catch((e: unknown) => { throw new RpcError('unavailable', `Couldn’t make the folder ${parent}: ${errMsg(e)}`); });
      // made where it was meant to be: nothing turned a part of it into a link meanwhile
      if ((await realpath(parent).catch(() => '')) !== parent) throw new RpcError('forbidden', 'That folder changed while it was being made. Try again.');
    }

    // written beside it, then renamed into place: a half-written file is never what the person finds
    const temp = join(parent, `.${name}.appubot-${randomBytes(4).toString('hex')}.part`);
    let size = 0;
    const out = await open(temp, 'wx', 0o666).catch((e: unknown) => { throw new RpcError('unavailable', `Couldn’t write in ${parent}: ${errMsg(e)}`); });
    try {
      try {
        if (body) for await (const chunk of body) {
          size += chunk.length;
          if (size > MAC_FILE_MAX_BYTES) throw new RpcError('too_large', `That is larger than the ${bytes(MAC_FILE_MAX_BYTES)} a bot may save at once.`);
          await out.write(chunk);
        }
        await out.sync();
      } finally {
        await out.close();
      }
      if (old) await chmod(temp, old.mode).catch(() => undefined);
      let oldVersion: LinkPut['oldVersion'];
      if (old) oldVersion = await this.putAside(target);
      await rename(temp, target).catch((e: unknown) => {
        throw new RpcError('unavailable', `Couldn’t save ${name}: ${errMsg(e)}${oldVersion ? ` (its old version is ${oldVersion === 'trash' ? 'in the Trash' : 'kept by AppuBot'})` : ''}`);
      });
      this.saved(linkId, name);
      this.ctx.log.info(`mac link: a bot saved ${name} (${bytes(size)})${old ? `, the old one ${oldVersion === 'trash' ? 'in the Trash' : 'kept by AppuBot'}` : ''}`);
      return { path: target, bytes: size, replaced: !!old, ...(oldVersion ? { oldVersion } : {}) };
    } catch (e) {
      await unlink(temp).catch(() => undefined);
      if (e instanceof RpcError) throw e;
      throw new RpcError('unavailable', `Couldn’t save ${name}: ${errMsg(e)}`);
    }
  }

  /** Throws unless a bot may write `real` (a real path): lent, in a folder switched to take changes, nothing hidden. */
  private mayWrite(real: string, rules: LendRules): void {
    const why = refusal(real, rules);
    if (why) throw new RpcError('forbidden', why);
    const root = rules.folders.find((f) => inside(real, f))!;
    if (!this.writable().includes(root)) throw new RpcError('forbidden', `${basename(root) || root} is read-only: the user hasn’t let bots save changes there. They can switch it on in AppuBot → Settings › Transfer › Files on that computer.`);
    if (real === root) throw new RpcError('invalid_params', 'Give the path of a file inside the folder.');
    // hidden files and folders (.git, .env, .vscode…): config that tools run by themselves, never a bot's to change
    if (relative(root, real).split(sep).some((p) => p.startsWith('.'))) throw new RpcError('forbidden', 'Hidden files and folders (like .git or .env) can’t be changed from another computer.');
  }

  /** The file about to be replaced: to the Trash, else a copy in AppuBot's own folder. */
  private async putAside(target: string): Promise<'trash' | 'kept'> {
    const trash = this.ctx.deps.trashItem;
    if (trash) {
      try { await trash(target); return 'trash'; } catch (e) { this.ctx.log.warn('mac link: the Trash didn’t take the old version', errMsg(e)); }
    }
    const dir = join(this.ctx.paths.dataDir, REPLACED_DIR);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
      await copyFile(target, join(dir, `${stamp}-${randomBytes(3).toString('hex')}-${basename(target)}`));
      const kept = (await readdir(dir)).sort();
      for (const f of kept.slice(0, Math.max(0, kept.length - REPLACED_KEEP))) await unlink(join(dir, f)).catch(() => undefined);
    } catch (e) {
      // the old version can't be kept anywhere: nothing is replaced
      throw new RpcError('unavailable', `Couldn’t keep the old version of ${basename(target)} first, so it wasn’t replaced: ${errMsg(e)}`);
    }
    return 'kept';
  }

  private saved(linkId: string, name: string): void {
    const now = Date.now();
    this.file.update((f) => ({ ...f, links: f.links.map((l) => (l.id === linkId ? { ...l, lastSavedAt: now, lastSavedName: name } : l)) }));
  }
}
