/**
 * The person's own computer's files, for the bots on this one (their AppuBot computer; protocol `carry.ts`, the
 * lending end is `macLink.ts`). The window that talks to both computers hands this one a link (`link`): the other
 * computer's room on AppuBot Connect, the key that pins it and a token. When a bot asks (`agent.mac.list/find/fetch`,
 * the bridge's `mac_files_*` tools), this computer dials the other through AppuBot Connect as a phone would
 * (end to end: the relay copies bytes it can't read), asks with the token, and hangs up when idle. Nothing is held
 * open, so the link never keeps this computer awake, and the other one is only reached when a bot needs a file.
 *
 * What may be read is the lending computer's call alone (its folders, its rules, its `revoke`); this end only asks.
 * A file a bot brings over lands in its inbox (`<bot folder>/inbox/mac/<name>`), where it reads it like any other.
 * A bot may save a file back (`agent.mac.put`: one from its own folder, or text) into a folder the person switched to
 * take changes there; whether it may is the other computer's call too, and one from before says it needs an update.
 *
 * The link (with its token) is kept in the system folder where there is one (`<systemDir>/mac-files.json`, 0600): on
 * an AppuBot computer that is out of the bots' reach, so a bot can't take the token and read the other computer
 * outside these tools. While a computer is linked the bots' instructions say so (`linkedName`).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, extname, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { GatewayError, relaySession, type RelayResponse, type RelayTransportCtor } from '@appubot/client';
import {
  LINK_FILE_PATH, LINK_FIND_PATH, LINK_LIST_PATH, LINK_PUT_PATH, LINK_ROOTS_PATH, LinkEntriesSchema, LinkPutSchema, LinkRootsSchema, MAC_FILE_MAX_BYTES, fromBase64Url,
  type MacFilesStatus, type MethodParams, type MethodResult,
} from '@appubot/protocol';
import { bytes } from '@appubot/chat-core';
import type { AgentContext } from '../auth';
import type { CoreCtx } from '../context';
import { systemDirOf } from '../context';
import { JsonFile } from '../store';
import { errMsg, RpcError } from '../util';
import { safeName } from './files';
import { inside } from './macLink';

interface StoredLink { linkId: string; name: string; connectId: string; connectKey: string; token: string; since: number }
interface LinkFile { link?: StoredLink }

const ws: RelayTransportCtor = WebSocket as unknown as RelayTransportCtor;
/** how long the other computer gets to answer a listing; a file may take as long as it keeps arriving */
const ASK_TIMEOUT_MS = 30_000;
const FILE_SILENCE_MS = 60_000;

export class MacFilesService {
  private file: JsonFile<LinkFile>;

  constructor(private ctx: CoreCtx) {
    this.file = new JsonFile<LinkFile>(join(systemDirOf(ctx.paths), 'mac-files.json'), () => ({}), 150, ctx.log, (raw) => {
      const l = (raw as LinkFile | undefined)?.link;
      return l && typeof l.token === 'string' && typeof l.connectId === 'string' && typeof l.connectKey === 'string' ? { link: l } : {};
    }, 0o600);
  }

  /** the linked computer's name, for the bots' instructions; undefined when none is linked */
  linkedName(): string | undefined { return this.file.get().link?.name; }

  status(): MacFilesStatus {
    const l = this.file.get().link;
    return l ? { linked: { linkId: l.linkId, name: l.name, since: l.since } } : {};
  }

  link(p: MethodParams<'macFiles.link'>): MacFilesStatus {
    if (fromBase64Url(p.connectKey)?.length !== 32) throw new RpcError('invalid_params', 'That link’s key can’t be read.');
    this.file.set({ link: { linkId: p.linkId, name: p.name, connectId: p.connectId, connectKey: p.connectKey, token: p.token, since: Date.now() } });
    this.file.flush();
    this.ctx.log.info(`mac files: linked to ${p.name}`);
    this.changed();
    return this.status();
  }

  unlink(): MacFilesStatus {
    if (!this.file.get().link) return {};
    this.file.set({});
    this.file.flush();
    this.changed();
    return {};
  }

  /** the bots' generated instructions name the linked computer: rewritten now, their agents restart at their next turn */
  private changed(): void {
    try { this.ctx.s.bots.rescaffold(); } catch (e) { this.ctx.log.warn('mac files: the bots’ instructions could not be rewritten', errMsg(e)); }
  }

  /** Asks the lending computer now: is it on, and which folders does it lend. */
  async check(): Promise<MethodResult<'macFiles.check'>> {
    const l = this.file.get().link;
    if (!l) return { ok: false, error: 'No computer is linked.' };
    try {
      const roots = LinkRootsSchema.parse(await this.ask(LINK_ROOTS_PATH, {}));
      return { ok: true, name: roots.hostName || l.name, folders: roots.folders };
    } catch (e) {
      return { ok: false, name: l.name, error: errMsg(e) };
    }
  }

  /* ---------- bots ---------- */

  async agentList(_a: AgentContext, path?: string): Promise<MethodResult<'agent.mac.list'>> {
    const mac = this.require().name;
    if (!path?.trim()) {
      const roots = LinkRootsSchema.parse(await this.ask(LINK_ROOTS_PATH, {}));
      return { mac, folders: roots.folders };
    }
    const r = LinkEntriesSchema.parse(await this.ask(LINK_LIST_PATH, { path }));
    return { mac, ...(r.path ? { path: r.path } : {}), entries: r.entries, ...(r.truncated ? { truncated: true } : {}) };
  }

  async agentFind(_a: AgentContext, query: string, path?: string): Promise<MethodResult<'agent.mac.find'>> {
    const mac = this.require().name;
    const r = LinkEntriesSchema.parse(await this.ask(LINK_FIND_PATH, { q: query, ...(path?.trim() ? { path } : {}) }, 45_000));
    return { mac, entries: r.entries, ...(r.truncated ? { truncated: true } : {}) };
  }

  /** Copies one file into the bot's inbox here. */
  async agentFetch(a: AgentContext, path: string): Promise<MethodResult<'agent.mac.fetch'>> {
    const link = this.require();
    const bot = this.ctx.s.bots.require(a.botId);
    const res = await this.request('GET', LINK_FILE_PATH, { path }, FILE_SILENCE_MS);
    if (res.status !== 200) throw this.refused(res, link);
    if (res.body.length > MAC_FILE_MAX_BYTES) throw new RpcError('too_large', `That file is larger than the ${bytes(MAC_FILE_MAX_BYTES)} a bot may bring over at once.`);
    const dir = join(bot.workspace, 'inbox', 'mac');
    const name = safeName(decodeName(res.headers['x-appubot-name']) || path.split(/[\\/]/).pop() || 'file');
    try {
      mkdirSync(dir, { recursive: true });
      const file = freeName(dir, name);
      writeFileSync(file, res.body, { flag: 'wx' });
      return { path: file, name, bytes: res.body.length };
    } catch (e) {
      throw new RpcError('internal', `Couldn’t save ${name} in your inbox: ${errMsg(e)}`);
    }
  }

  /** Saves a file on the other computer: `from` (a file in the bot's own folder here) or `text`, at `path` there. */
  async agentPut(a: AgentContext, p: MethodParams<'agent.mac.put'>): Promise<MethodResult<'agent.mac.put'>> {
    const link = this.require();
    const bot = this.ctx.s.bots.require(a.botId);
    let body: Uint8Array;
    if (p.text !== undefined) body = Buffer.from(p.text, 'utf8');
    else {
      // only what the bot itself may read: its own folder, by real path (never this computer's own data)
      const own = await realpath(bot.workspace).catch(() => bot.workspace);
      const typed = (p.from ?? '').trim();
      let real: string;
      try { real = await realpath(isAbsolute(typed) ? typed : resolve(own, typed)); } catch { throw new RpcError('not_found', `Nothing is at ${typed} here.`); }
      if (!inside(real, own)) throw new RpcError('forbidden', `Only a file in your own folder (${own}) can be saved there. Copy it in first.`);
      for (const d of [this.ctx.paths.dataDir, systemDirOf(this.ctx.paths)]) if (d && inside(real, d)) throw new RpcError('forbidden', 'That file can’t be sent.');
      const st = await stat(real);
      if (!st.isFile()) throw new RpcError('invalid_params', `${typed} isn’t a file.`);
      if (st.size > MAC_FILE_MAX_BYTES) throw new RpcError('too_large', `That file is ${bytes(st.size)}: larger than the ${bytes(MAC_FILE_MAX_BYTES)} a bot may save at once.`);
      body = await readFile(real);
    }
    // asked first: a computer from before, or a folder that is read-only, is said without sending the file; and an
    // answered request lets the channel stream stay, however long a big file then takes to arrive
    const tooOld = `AppuBot on ${link.name} is too old to take changes from bots. The user can update it there (Settings › About), then switch on “Bots can save changes here” for the folder in Settings › Transfer.`;
    const roots = LinkRootsSchema.parse(await this.ask(LINK_ROOTS_PATH, {}));
    if (!roots.saves) throw new RpcError('unavailable', tooOld);
    const typed = p.path.trim();
    const folder = roots.folders.find((f) => typed === f.path || typed.startsWith(f.path.endsWith('/') ? f.path : `${f.path}/`));
    if (folder && !folder.writable) throw new RpcError('forbidden', `${folder.name} is read-only: the user hasn’t let bots save changes there. They can switch it on in AppuBot → Settings › Transfer › Files on that computer.`);
    const res = await this.request('POST', LINK_PUT_PATH, { path: p.path }, FILE_SILENCE_MS, body);
    if (res.status !== 200) throw this.refused(res, link, tooOld);
    try {
      return { mac: link.name, ...LinkPutSchema.parse(JSON.parse(Buffer.from(res.body).toString('utf8'))) };
    } catch {
      throw new RpcError('unavailable', `${link.name} answered with something AppuBot couldn’t read. It may need an update.`);
    }
  }

  /* ---------- the other computer ---------- */

  private require(): StoredLink {
    const l = this.file.get().link;
    if (!l) throw new RpcError('unavailable', 'None of the user’s own computers is linked to this one. They can link one in AppuBot → Settings › Transfer › Files on your computer, from that computer.');
    return l;
  }

  private async request(method: 'GET' | 'POST', path: string, query: Record<string, string>, timeoutMs: number, body?: Uint8Array): Promise<RelayResponse> {
    const l = this.require();
    const key = fromBase64Url(l.connectKey);
    if (!key) throw new RpcError('unavailable', `The link to ${l.name} can’t be read. The user can link it again in Settings › Transfer.`);
    const relayUrl = this.ctx.deps.connect?.relayUrl ?? process.env.APPUBOT_CONNECT_URL;
    const qs = new URLSearchParams(query).toString();
    try {
      const session = relaySession({ connectId: l.connectId, macKey: key, WebSocketImpl: ws, idleMs: 20_000, ...(relayUrl ? { relayUrl } : {}) });
      const headers: Record<string, string> = { authorization: `Bearer ${l.token}`, ...(body ? { 'content-type': 'application/octet-stream' } : {}) };
      return await session.request({ method, path: `${path}${qs ? `?${qs}` : ''}`, headers }, body, { timeoutMs });
    } catch (e) {
      throw new RpcError('unavailable', unreachableText(l.name, e));
    }
  }

  /** a JSON answer; anything but 200 becomes the other computer's own words */
  private async ask(path: string, query: Record<string, string>, timeoutMs = ASK_TIMEOUT_MS): Promise<unknown> {
    const res = await this.request('GET', path, query, timeoutMs);
    if (res.status !== 200) throw this.refused(res, this.require());
    try { return JSON.parse(Buffer.from(res.body).toString('utf8')); } catch { throw new RpcError('unavailable', `${this.require().name} answered with something AppuBot couldn’t read. It may need an update.`); }
  }

  /** `tooOld`: what to say when the other computer has no such path (it answers 404 with no `code` of the link's) */
  private refused(res: RelayResponse, l: StoredLink, tooOld = `AppuBot on ${l.name} is too old to lend files. The user can update it there (Settings › About).`): RpcError {
    let said = '';
    let code = '';
    try {
      const b = JSON.parse(Buffer.from(res.body).toString('utf8')) as { error?: unknown; code?: unknown };
      said = String(b.error ?? '');
      code = typeof b.code === 'string' ? b.code : '';
    } catch { /* not JSON */ }
    if (res.status === 401) return new RpcError('forbidden', `${l.name} no longer lends its files to this computer. The user can link it again in AppuBot → Settings › Transfer, from that computer.`);
    if (res.status === 404 && !code) return new RpcError('unavailable', tooOld);
    return new RpcError(res.status === 403 ? 'forbidden' : res.status === 404 ? 'not_found' : res.status === 413 ? 'too_large' : 'unavailable', said || `${l.name} answered ${res.status}.`);
  }
}

/** Why the other computer couldn't be reached, for a bot to pass on. */
export function unreachableText(name: string, e: unknown): string {
  const code = e instanceof GatewayError ? e.code : '';
  if (code === 'busy') return `AppuBot Connect is busy right now, so ${name} couldn’t be reached. Try again in a minute.`;
  return `${name} isn’t reachable right now: it may be asleep, offline, or AppuBot isn’t open on it. Tell the user; its files can be read once it is on. (${errMsg(e)})`;
}

function decodeName(v: string | undefined): string {
  if (!v) return '';
  try { return decodeURIComponent(v); } catch { return ''; }
}

/** `dir/name`, or `dir/name (2).ext`… when that is taken */
function freeName(dir: string, name: string): string {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 1000; i++) {
    const file = join(dir, i === 1 ? name : `${stem} (${i})${ext}`);
    if (!existsSync(file)) return file;
  }
  return join(dir, `${Date.now()}-${name}`);
}
