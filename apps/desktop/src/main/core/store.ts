/**
 * JSON persistence. Every collection is a small JSON file written atomically (tmp + rename),
 * debounced so bursts of updates coalesce into one write. Threads keep an index (threads.json)
 * plus one file per thread (threads/<id>.json = {thread, messages, archive}) loaded lazily.
 *
 * A thread can run for a long time (older versions kept one per bot for good). To keep each save small, a thread file only
 * holds its recent messages: once it passes `hotMax` messages or `hotMaxBytes`, the oldest settled ones move into an
 * immutable chunk (threads/<id>.archive/<n>.json, listed in `archive` with its time range), read back lazily and
 * only for the pages that need it (`page`). Files from older versions simply have no archive yet.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Bot, Channel, FileAttachment, Group, Message, Routine, Settings, Thread, Device, PushRegistration } from '@appubot/protocol';
import { APPUBOT_AI_PROVIDER_ID, BotSchema, GroupSchema, SettingsSchema, ThreadSchema, MessageSchema, creditModelAllowed, tidyVoiceSettings } from '@appubot/protocol';
import { providerModes, toOfferedMode } from '@appubot/agent-runtime';
import { compareMessages, historyPage, type HistoryPageOptions } from '@appubot/chat-core';
import type { ProviderSpec } from '@appubot/agent-runtime';
import type { Logger } from './util';
import { silentLogger } from './util';

let tmpCounter = 0;
/**
 * Windows: replacing a file fails for a moment while another program has it open (an antivirus scan, the indexer, an
 * editor): try again shortly before giving up.
 */
function renameRetrying(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(from, to); return; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || attempt >= 8 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        try { rmSync(from, { force: true }); } catch { /* left behind */ }
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (attempt + 1));
    }
  }
}

/**
 * Folders whose files are written only while `check()` says the folder is the right one (AppuBot Cloud's system
 * folder, `CorePaths.systemDir`: made by root at boot, so a write never makes it again, and never writes into
 * something else put in its place). A write there while `check()` is false throws (a `JsonFile` tries again later).
 */
const writeGuards: { dir: string; check: () => boolean }[] = [];
export function guardWrites(dir: string, check: () => boolean): () => void {
  const g = { dir: dir.replace(/\/+$/, ''), check };
  writeGuards.push(g);
  return () => { const i = writeGuards.indexOf(g); if (i >= 0) writeGuards.splice(i, 1); };
}
function guardOf(path: string): { dir: string; check: () => boolean } | undefined {
  return writeGuards.find((g) => path.startsWith(`${g.dir}/`));
}

/** `mode` applies to the new file (0o600 keeps secrets readable by the user only). */
export function writeFileAtomic(path: string, data: string, mode?: number): void {
  const guard = guardOf(path);
  if (guard) {
    if (!guard.check()) throw new Error(`${guard.dir} is not available for writing`);
  } else mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${++tmpCounter}.tmp`;
  writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
  renameRetrying(tmp, path);
}

export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** a write that failed (a full disk, a folder gone) is tried again this much later, until it lands */
const WRITE_RETRY_MS = 5_000;

export class JsonFile<T> {
  private value: T;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failing = false;
  constructor(
    public readonly path: string, defaults: () => T, private debounceMs = 150, private log: Logger = silentLogger,
    normalize?: (raw: unknown) => T, private mode?: number,
  ) {
    let v: T | undefined;
    try {
      const raw = readJson<unknown>(path);
      if (raw !== undefined) v = normalize ? normalize(raw) : (raw as T);
    } catch (e) {
      log.warn(`store: could not read ${path}; starting fresh`, String(e));
      try { renameSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* ignore */ }
    }
    this.value = v ?? defaults();
  }
  get(): T { return this.value; }
  set(v: T): void { this.value = v; this.schedule(); }
  update(fn: (v: T) => T | void): T {
    const r = fn(this.value);
    if (r !== undefined) this.value = r as T;
    this.schedule();
    return this.value;
  }
  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.writeNow(); }, this.debounceMs);
  }
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; this.writeNow(); }
  }
  private writeNow(): void {
    try {
      writeFileAtomic(this.path, JSON.stringify(this.value, null, 2), this.mode);
      if (this.failing) this.log.info(`store: ${this.path} written again`);
      this.failing = false;
    } catch (e) {
      // logged once per run of failures; the value stays in memory and is written once it can be
      if (!this.failing) this.log.error(`store: write failed ${this.path}; trying again every ${WRITE_RETRY_MS / 1000} s`, String(e));
      this.failing = true;
      if (!this.timer) {
        this.timer = setTimeout(() => { this.timer = null; this.writeNow(); }, WRITE_RETRY_MS);
        this.timer.unref?.();
      }
    }
  }
}

/** a phone's registration for notifications (`devices.setPush`): its FCM token stays here, never on the wire */
export interface StoredPush extends PushRegistration { at: number }
/**
 * `memberId`/`memberEmail`: on a team's AppuBot Cloud computer, the team member (the backend's account id and email)
 * this device was paired for, so removing them revokes every device of theirs. Never sent
 * on the wire.
 */
/** `identity`: the id the device pairs with (`DeviceIdentity.id`, the phone's own), so pairing again takes its old place */
export interface StoredDevice extends Device { tokenHash: string; push?: StoredPush; memberId?: string; memberEmail?: string; identity?: string }
/** `removedMembers`: team members removed from this computer (their devices revoked; a new pairing for them clears it) */
export interface DevicesFile { devices: StoredDevice[]; revoked: string[]; removedMembers?: string[] }
/**
 * What was last pushed to the Telegram bot's own profile (`tgId`: which Telegram bot; a new token starts over):
 * its name, its description and a key of the avatar its photo was drawn from.
 */
export interface TelegramProfileSync { tgId: number; name?: string; about?: string; photo?: string }
export interface StoredChannel extends Channel { token?: string; profile?: TelegramProfileSync }
/** The Composio sign-in: the OAuth client it was made with and its tokens (owner-only file; never sent anywhere). */
export interface StoredComposioAuth { clientId: string; accessToken: string; refreshToken?: string; expiresAt: number; account?: string }
/**
 * apps.json: the OAuth client AppuBot registered with Composio (per redirect URI: the gateway's port), the sign-in,
 * the apps with an ACTIVE connection as last seen (what the bots follow), the apps listed each refresh, and when the
 * whole directory was last looked through for connections made elsewhere.
 */
export interface StoredApps {
  client?: { clientId: string; redirectUri: string };
  /** the clients registered for devices signing in themselves, by their return address */
  deviceClients?: Record<string, string>;
  auth?: StoredComposioAuth;
  connected?: string[];
  watched?: string[];
  sweptAt?: number;
  /** apps Composio refused to connect here (no sign-in of its own, not offered, retired): off the Apps page from then on */
  unavailable?: Record<string, 'needs-setup' | 'not-offered' | 'retired'>;
  /** apps connected on their own servers (`directApps.ts`), by slug */
  direct?: Record<string, StoredDirectApp>;
}

/** One app on its own server: added (it needs no sign-in) or signed in with the person's own account. */
export interface StoredDirectApp {
  addedAt: number;
  /** AppuBot as that server's sign-in knows it, registered once per return address */
  client?: { clientId: string; clientSecret?: string; authMethod: string; redirectUri: string };
  /** where to sign in and renew, as the server said when the client was registered */
  at?: { resource: string; authorizeUrl: string; tokenUrl: string; registerUrl?: string; scopes: string[] };
  tokens?: { accessToken: string; refreshToken?: string; expiresAt?: number };
  account?: string;
  /** it needs no sign-in: added once its server answered */
  open?: boolean;
  /** the app no longer takes the sign-in: connect it again */
  expired?: boolean;
}
export interface FileRecord extends FileAttachment { storedPath: string; threadId?: string; createdAt: number }

/** An archived chunk of a thread's older messages: `<n>.json` in its archive folder, with their time range. */
export interface ArchiveRef { n: number; count: number; first: number; last: number }
interface ThreadFile { thread: Thread; messages: Message[]; archive?: ArchiveRef[] }

export interface ThreadStoreOptions {
  debounceMs?: number;
  /** messages a thread file keeps before the oldest go to the archive */
  hotMax?: number;
  /** ... how many stay when they do */
  hotKeep?: number;
  /** a thread file bigger than this (JSON characters) archives its older half */
  hotMaxBytes?: number;
  /** archived chunks kept in memory */
  chunkCache?: number;
}

/**
 * A thread's modes cut to the ones AppuBot offers for its agent (lists saved before a change keep the old ones), and
 * its mode moved onto one of them (Auto for an older Ask permissions).
 */
function withOfferedModes(t: Thread): Thread {
  const modes = providerModes(t.providerId, t.modes);
  const modeId = toOfferedMode(t.providerId, t.modeId);
  const out = modeId === t.modeId && modes.length === t.modes.length && modes.every((m, i) => m === t.modes[i]) ? t : { ...t, modes, modeId };
  return creditTidyThread(out);
}

/**
 * AppuBot AI (the launch bonus) runs Sonnet and Haiku at the standard speed only: a thread or bot saved before that
 * keeps none of the other models in its lists or pick, and no fast mode (the session would refuse them anyway).
 */
function creditTidyThread(t: Thread): Thread {
  if (t.providerId !== APPUBOT_AI_PROVIDER_ID) return t;
  const models = t.models.filter((m) => creditModelAllowed(m.id));
  const keepModel = !t.modelId || creditModelAllowed(t.modelId);
  if (models.length === t.models.length && keepModel && !t.fast && !t.fastAvailable) return t;
  const next: Thread = { ...t, models, fast: false, fastAvailable: false };
  if (!keepModel) delete next.modelId;
  return next;
}
function creditTidyBot(b: Bot): Bot {
  if (b.providerId !== APPUBOT_AI_PROVIDER_ID || (!b.fast && (!b.modelId || creditModelAllowed(b.modelId)))) return b;
  const next: Bot = { ...b, fast: false };
  if (next.modelId && !creditModelAllowed(next.modelId)) delete next.modelId;
  return next;
}

export class ThreadStore {
  private index: JsonFile<Thread[]>;
  private byId = new Map<string, Thread>();
  /** each thread's recent messages (the rest are archived) */
  private messages = new Map<string, Message[]>();
  private refs = new Map<string, ArchiveRef[]>();
  /** loaded archive chunks by `<threadId>#<n>`, least recently used first */
  private chunks = new Map<string, Message[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private dir: string;
  private debounceMs: number;
  private o: Required<Omit<ThreadStoreOptions, 'debounceMs'>>;

  constructor(dataDir: string, private log: Logger = silentLogger, opts: ThreadStoreOptions = {}) {
    this.debounceMs = opts.debounceMs ?? 500;
    this.o = { hotMax: opts.hotMax ?? 600, hotKeep: opts.hotKeep ?? 200, hotMaxBytes: opts.hotMaxBytes ?? 8_000_000, chunkCache: opts.chunkCache ?? 24 };
    this.dir = join(dataDir, 'threads');
    mkdirSync(this.dir, { recursive: true });
    const indexPath = join(dataDir, 'threads.json');
    const hadIndex = existsSync(indexPath);
    this.index = new JsonFile<Thread[]>(indexPath, () => [], 150, log);
    for (const t of this.index.get()) {
      const p = ThreadSchema.safeParse(t);
      if (p.success) this.byId.set(p.data.id, withOfferedModes(p.data));
    }
    if (!hadIndex) this.rebuildIndex();
  }

  private rebuildIndex(): void {
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const tf = readJson<ThreadFile>(join(this.dir, f));
        const p = ThreadSchema.safeParse(tf?.thread);
        if (p.success) this.byId.set(p.data.id, withOfferedModes(p.data));
      } catch { /* ignore */ }
    }
    this.persistIndex();
  }

  private persistIndex(): void { this.index.set([...this.byId.values()]); }

  list(): Thread[] { return [...this.byId.values()]; }
  get(id: string): Thread | undefined { return this.byId.get(id); }

  put(thread: Thread): void {
    thread = withOfferedModes(thread);
    this.byId.set(thread.id, thread);
    if (!this.messages.has(thread.id)) this.messages.set(thread.id, this.loadMessages(thread.id));
    this.persistIndex();
    this.scheduleSave(thread.id);
  }

  getMessages(id: string): Message[] {
    let m = this.messages.get(id);
    if (!m) { m = this.loadMessages(id); this.messages.set(id, m); }
    return m;
  }

  private loadMessages(id: string): Message[] {
    try {
      const tf = readJson<ThreadFile>(join(this.dir, `${id}.json`));
      if (!tf) return [];
      const refs = Array.isArray(tf.archive) ? tf.archive.filter((r) => Number.isInteger(r?.n) && Number.isFinite(r.first) && Number.isFinite(r.last)) : [];
      if (refs.length) this.refs.set(id, refs);
      return parseMessages(tf.messages);
    } catch (e) {
      this.log.warn(`store: could not read thread ${id}`, String(e));
      return [];
    }
  }

  private archiveDir(id: string): string { return join(this.dir, `${id}.archive`); }

  /** The archived chunks of a thread, oldest first. */
  archiveRefs(id: string): ArchiveRef[] {
    this.getMessages(id);
    return this.refs.get(id) ?? [];
  }

  private loadChunk(id: string, n: number): Message[] {
    const key = `${id}#${n}`;
    let list = this.chunks.get(key);
    if (list) {
      this.chunks.delete(key);
    } else {
      try { list = parseMessages(readJson<{ messages: unknown }>(join(this.archiveDir(id), `${n}.json`))?.messages); }
      catch (e) { this.log.warn(`store: could not read archive ${n} of thread ${id}`, String(e)); list = []; }
    }
    this.chunks.set(key, list);
    while (this.chunks.size > this.o.chunkCache) this.chunks.delete(this.chunks.keys().next().value!);
    return list;
  }

  /**
   * A page of the conversation made of `threadIds` (`historyPage` semantics), reading archived chunks only when the
   * page reaches back into their time range.
   */
  page(threadIds: readonly string[], o: HistoryPageOptions): { messages: Message[]; hasMore: boolean } {
    interface Seg { first: number; last: number; load: () => Message[] }
    const segs: Seg[] = [];
    for (const id of threadIds) {
      const hot = this.getMessages(id);
      if (hot.length) {
        let first = Infinity, last = -Infinity;
        for (const m of hot) { first = Math.min(first, m.createdAt); last = Math.max(last, m.createdAt); }
        segs.push({ first, last, load: () => hot });
      }
      for (const r of this.refs.get(id) ?? []) segs.push({ first: r.first, last: r.last, load: () => this.loadChunk(id, r.n) });
    }
    const bound = o.before?.createdAt ?? Infinity;
    // newest first; a segment that starts after the cursor holds nothing before it
    const todo = segs.filter((g) => g.first <= bound).sort((a, b) => b.last - a.last);
    const got: Message[] = [];
    let i = 0;
    for (; i < todo.length; i++) {
      const next = todo[i]!;
      if (o.since === undefined || next.last < o.since) {
        const cands = got.filter((m) => !o.before || compareMessages(m, o.before) < 0).sort(compareMessages);
        // enough newer messages already: this segment and the rest only hold older ones
        if (cands.length >= o.limit && next.last < cands[cands.length - o.limit]!.createdAt) break;
      }
      got.push(...next.load());
    }
    const page = historyPage(got, o);
    return { messages: page.messages, hasMore: page.hasMore || i < todo.length };
  }

  /** Mark a thread's messages dirty (debounced ≤1 write / debounceMs). */
  scheduleSave(id: string): void {
    if (this.timers.has(id)) return;
    this.timers.set(id, setTimeout(() => { this.timers.delete(id); this.writeThread(id); }, this.debounceMs));
  }

  flushThread(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    this.writeThread(id);
  }

  private writeThread(id: string): void {
    const thread = this.byId.get(id);
    if (!thread) return;
    try {
      const messages = this.getMessages(id);
      let json = JSON.stringify({ thread, messages, archive: this.refs.get(id) ?? [] });
      if ((messages.length > this.o.hotMax || json.length > this.o.hotMaxBytes) && this.archiveOldest(id, messages, json.length > this.o.hotMaxBytes)) {
        json = JSON.stringify({ thread, messages, archive: this.refs.get(id) ?? [] });
      }
      writeFileAtomic(join(this.dir, `${id}.json`), json);
    } catch (e) { this.log.error(`store: write thread ${id} failed`, String(e)); }
  }

  /**
   * Move the oldest settled messages of a long thread into a new archive chunk (written before the thread file that
   * lists it, so a crash in between leaves at most an unlisted chunk, overwritten next time). Mutates `messages`.
   */
  private archiveOldest(id: string, messages: Message[], tooBig: boolean): boolean {
    const keep = tooBig ? Math.max(20, Math.floor(messages.length / 2)) : this.o.hotKeep;
    let k = 0;
    while (k < messages.length - keep && messages[k]!.status !== 'streaming') k++;
    if (!k) return false;
    const moved = messages.slice(0, k);
    const refs = this.refs.get(id) ?? [];
    const n = (refs[refs.length - 1]?.n ?? 0) + 1;
    let first = Infinity, last = -Infinity;
    for (const m of moved) { first = Math.min(first, m.createdAt); last = Math.max(last, m.createdAt); }
    writeFileAtomic(join(this.archiveDir(id), `${n}.json`), JSON.stringify({ threadId: id, messages: moved }));
    this.refs.set(id, [...refs, { n, count: moved.length, first, last }]);
    messages.splice(0, k);
    this.chunks.set(`${id}#${n}`, moved);
    while (this.chunks.size > this.o.chunkCache) this.chunks.delete(this.chunks.keys().next().value!);
    this.log.info(`store: archived ${moved.length} older messages of thread ${id} (chunk ${n})`);
    return true;
  }

  delete(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    this.byId.delete(id);
    this.messages.delete(id);
    this.refs.delete(id);
    for (const key of [...this.chunks.keys()]) if (key.startsWith(`${id}#`)) this.chunks.delete(key);
    this.persistIndex();
    rmSync(join(this.dir, `${id}.json`), { force: true });
    rmSync(this.archiveDir(id), { recursive: true, force: true });
  }

  /** How much room a thread's messages take on disk (its file and archive), for Settings › Transfer's sizes. */
  diskBytes(id: string): number {
    let total = 0;
    try { total += statSync(join(this.dir, `${id}.json`)).size; } catch { /* not written yet */ }
    try { for (const f of readdirSync(this.archiveDir(id))) { try { total += statSync(join(this.archiveDir(id), f)).size; } catch { /* gone */ } } } catch { /* no archive */ }
    return total;
  }

  /** Every message of a thread, archived ones first (a bot's bundle carries whole chats). */
  allMessages(id: string): Message[] {
    const refs = this.archiveRefs(id);
    return [...refs.flatMap((r) => this.loadChunk(id, r.n)), ...this.getMessages(id)];
  }

  /** A thread's messages set whole (a bot imported with its chats): all hot, archived as it grows. */
  setMessages(id: string, messages: Message[]): void {
    this.messages.set(id, messages);
    this.refs.delete(id);
    this.scheduleSave(id);
  }

  /** Drop cached messages for threads not touched recently (keeps memory bounded). */
  evict(keep: Set<string>): void {
    for (const id of [...this.messages.keys()]) if (!keep.has(id) && !this.timers.has(id)) this.messages.delete(id);
  }

  flush(): void {
    for (const id of [...this.timers.keys()]) this.flushThread(id);
    this.index.flush();
  }
}

function parseMessages(raw: unknown): Message[] {
  return (Array.isArray(raw) ? raw : []).flatMap((m) => {
    const p = MessageSchema.safeParse(m);
    return p.success ? [p.data] : [];
  });
}

export class Store {
  settings: JsonFile<Settings>;
  bots: JsonFile<Bot[]>;
  devices: JsonFile<DevicesFile>;
  routines: JsonFile<Routine[]>;
  groups: JsonFile<Group[]>;
  providers: JsonFile<ProviderSpec[]>;
  channels: JsonFile<StoredChannel[]>;
  apps: JsonFile<StoredApps>;
  files: JsonFile<FileRecord[]>;
  threads: ThreadStore;

  /** `systemDir`: where the computer's own state goes (AppuBot Cloud: `CorePaths.systemDir`); default `dataDir` */
  constructor(public readonly dataDir: string, log: Logger = silentLogger, systemDir = dataDir) {
    mkdirSync(dataDir, { recursive: true });
    const f = (n: string) => join(dataDir, n);
    this.settings = new JsonFile<Settings>(f('settings.json'), () => SettingsSchema.parse({}), 150, log, (raw) => {
      // a speech model or voice this version doesn't know (saved by a newer one) is the default, not a reset of everything
      const r = raw as { voice?: unknown } | null;
      const p = SettingsSchema.safeParse(r && typeof r === 'object' && r.voice ? { ...r, voice: tidyVoiceSettings(r.voice) } : raw);
      // the chat shows answers only for now (the switch is hidden in both apps): a saved "everything" goes back
      // permissions are Auto or Bypass only: an older default of Ask permissions (or anything else) becomes Auto
      return p.success
        ? {
          ...p.data, chatView: 'answers', defaultModeId: toOfferedMode(p.data.defaultProviderId, p.data.defaultModeId) || 'bypassPermissions',
          // AppuBot AI (the launch bonus) as the default agent: Sonnet or Haiku only
          ...(p.data.defaultProviderId === APPUBOT_AI_PROVIDER_ID && p.data.defaultModelId && !creditModelAllowed(p.data.defaultModelId) ? { defaultModelId: '' } : {}),
        }
        : SettingsSchema.parse({});
    });
    // bots saved by older versions get the fields added since (each as its default)
    this.bots = new JsonFile<Bot[]>(f('bots.json'), () => [], 150, log, (raw) => (Array.isArray(raw) ? raw : []).map((b: unknown) => {
      const p = BotSchema.safeParse(b);
      // a bot on a mode AppuBot no longer offers (Ask permissions…) moves to Auto
      return p.success ? creditTidyBot({ ...p.data, modeId: toOfferedMode(p.data.providerId, p.data.modeId) }) : (b as Bot);
    }));
    // owner-only: token hashes and phones' push tokens
    this.devices = new JsonFile<DevicesFile>(join(systemDir, 'devices.json'), () => ({ devices: [], revoked: [] }), 150, log, undefined, 0o600);
    this.routines = new JsonFile<Routine[]>(f('routines.json'), () => [], 150, log);
    // groups of bots; nobody is working on a room when the app starts
    this.groups = new JsonFile<Group[]>(f('groups.json'), () => [], 150, log, (raw) => (Array.isArray(raw) ? raw : []).flatMap((g: unknown) => {
      const p = GroupSchema.safeParse(g);
      return p.success ? [{ ...p.data, working: [] }] : [];
    }));
    this.providers = new JsonFile<ProviderSpec[]>(f('providers.json'), () => [], 150, log);
    this.channels = new JsonFile<StoredChannel[]>(f('channels.json'), () => [], 150, log);
    this.apps = new JsonFile<StoredApps>(f('apps.json'), () => ({}), 150, log, undefined, 0o600);
    this.files = new JsonFile<FileRecord[]>(f('files.json'), () => [], 150, log);
    this.threads = new ThreadStore(dataDir, log);
  }

  flush(): void {
    for (const j of [this.settings, this.bots, this.devices, this.routines, this.groups, this.providers, this.channels, this.apps, this.files]) (j as JsonFile<unknown>).flush();
    this.threads.flush();
  }
}
