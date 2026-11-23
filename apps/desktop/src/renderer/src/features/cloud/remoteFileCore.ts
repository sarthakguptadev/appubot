/**
 * Files of the computer on screen when it isn't this Mac (your AppuBot computer, a team's): the pure part of bringing
 * them here (remoteFiles.ts wires it to the cloud client, the store and main). A file's bytes come through the
 * computer's end-to-end channel (`GET /files/:id`, as the phone does) into
 * main's per-computer cache (electron/remoteFiles.ts); thumbnails and players read them back from there, Open opens
 * the copy, Download puts it in Downloads.
 *
 * Previews never wake a sleeping computer (the chat shows its saved copy meanwhile): they wait for it to be connected.
 * Open and Download are the person asking, so they wake it (`Waking…` on the card) per the presence rules.
 */
import type { FileAttachment } from '@appubot/protocol';
import { cloudFilesDir } from '@appubot/chat-core';

export interface RemoteRef { computer: string; id: string; name: string; size?: number }

export type RemotePhase = 'waking' | 'downloading' | 'saving';
export interface RemoteProgress { phase: RemotePhase; received?: number; total?: number }

/** Pictures and clips at most this big are fetched to show in the chat by themselves; bigger ones wait for Open. */
export const PREVIEW_MAX = 25 * 1024 * 1024;
/** Bytes kept in the window when main can't keep them (a main older than the window): the newest first. */
export const MEMORY_MAX = 256 * 1024 * 1024;

/** The cache's name for a computer: `own`, or `team-<id>` (core services/cloudCache.ts names its copies alike). */
export const computerKey = (team?: string): string => cloudFilesDir(team);

/** A file's id on its computer: the attachment's own, else its `/files/<id>` URL's. */
export function fileIdOf(f: { id?: string; url?: string }): string | null {
  if (f.id) return f.id;
  const m = /^\/files\/([^/?#]+)/.exec(f.url ?? '');
  if (!m) return null;
  try { return decodeURIComponent(m[1]!); } catch { return null; }
}

export function remoteRef(computer: string, f: Partial<Pick<FileAttachment, 'id' | 'url' | 'name' | 'size'>>): RemoteRef | null {
  const id = fileIdOf(f);
  if (!id) return null;
  return { computer, id, name: f.name || id, ...(typeof f.size === 'number' && f.size > 0 ? { size: f.size } : {}) };
}

export const refKey = (r: RemoteRef): string => `${r.computer}:${r.id}`;

/** Shown in the chat by itself: a picture, or a song or clip the window plays, small enough to fetch unasked. */
export function previewable(f: { mimeType?: string; size?: number }): boolean {
  if (typeof f.size === 'number' && f.size > PREVIEW_MAX) return false;
  return /^(image|audio|video)\//.test(f.mimeType ?? '');
}

/**
 * A picture's thumbnail on this Mac: a copy of its own beside the file's (`<id>.thumb`, so the same size cap and
 * forgetting keep it), made once from the whole picture and read first ever after, so a chat's pictures show from a
 * few KB on disk at once rather than the whole file. GIFs (they move) and SVGs aren't made smaller.
 */
export const thumbRef = (r: RemoteRef): RemoteRef => ({ computer: r.computer, id: `${r.id}.thumb`, name: 'thumb' });
export const thumbable = (mimeType: string): boolean => /^image\/(png|jpeg|jpg|webp|bmp|heic|heif|tiff)$/i.test(mimeType);
/** a thumbnail's long edge: sharp in the chat's tiles and still fine in the gallery */
export const THUMB_EDGE = 1600;

/** A picture's type from its first bytes (a thumbnail is a JPEG or a WebP). */
export function sniffImage(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  return 'application/octet-stream';
}

/** The card's words while a file comes over: "Waking…", "Downloading 45%", "Downloading…", "Saving…". */
export function progressLabel(p: RemoteProgress | null | undefined): string | null {
  if (!p) return null;
  if (p.phase === 'waking') return 'Waking…';
  if (p.phase === 'saving') return 'Saving…';
  if (p.total && p.total > 0 && p.received !== undefined) return `Downloading ${Math.min(99, Math.floor((p.received / p.total) * 100))}%`;
  return 'Downloading…';
}

export interface RemoteFileDeps {
  /** the computer's client is up (a preview never wakes it) */
  connected(): boolean;
  /** wakes the computer if it sleeps and waits for its client */
  wake(): Promise<void>;
  /** the file's bytes through the channel */
  fetchBytes(ref: RemoteRef, onProgress: (received: number, total: number | null) => void): Promise<Uint8Array>;
  /** main's cache; null where main can't keep files (the window keeps the bytes itself) */
  disk: {
    cached(ref: RemoteRef): Promise<string | null>;
    read(ref: RemoteRef): Promise<Uint8Array | null>;
    save(ref: RemoteRef, bytes: Uint8Array): Promise<string>;
  } | null;
  /** a file's progress changed (null: done or failed) */
  onProgress(key: string, p: RemoteProgress | null): void;
  /** a smaller copy of a picture to keep as its thumbnail (null: it is small already, or can't be read) */
  makeThumb?(bytes: Uint8Array, mimeType: string): Promise<Uint8Array | null>;
}

/** A picture or clip to show: its thumbnail (kept on disk) or the file itself. */
export interface Preview { bytes: Uint8Array; mimeType: string; thumb: boolean }

/** What a brought file is: its copy on this Mac and/or (just fetched, or no cache in main) its bytes. */
export interface Brought { path?: string; bytes?: Uint8Array }

/** Brings files over once each however many ask (single flight per file), and keeps what main can't. */
export class RemoteFileLoader {
  private flights = new Map<string, Promise<Brought>>();
  private memory = new Map<string, Uint8Array>();

  constructor(private readonly deps: RemoteFileDeps) {}

  /** The file here, fetched when it isn't (waking the computer when `wake`, else failing while it sleeps). */
  bring(ref: RemoteRef, opts: { wake: boolean }): Promise<Brought> {
    const key = refKey(ref);
    const kept = this.memory.get(key);
    if (kept) return Promise.resolve({ bytes: kept });
    const going = this.flights.get(key);
    if (going) return going;
    const flight = this.fetch(ref, key, opts.wake).finally(() => {
      this.flights.delete(key);
      this.deps.onProgress(key, null);
    });
    this.flights.set(key, flight);
    return flight;
  }

  /** A picture's or clip's bytes to show: main's copy, else fetched now if the computer is up (never woken for it). */
  async preview(ref: RemoteRef): Promise<Uint8Array | null> {
    const key = refKey(ref);
    const kept = this.memory.get(key);
    if (kept) return kept;
    const disk = this.deps.disk;
    if (disk) {
      const have = await disk.read(ref).catch(() => null);
      if (have) return have;
    }
    if (!this.flights.has(key) && !this.deps.connected()) return null;
    const got = await this.bring(ref, { wake: false });
    if (got.bytes) return got.bytes;
    return disk && got.path ? disk.read(ref) : null;
  }

  /**
   * What a chat shows of a file, fastest first: a picture's thumbnail from disk, else the file (from disk, else fetched
   * if the computer is up: never woken for it), a thumbnail then made from it for next time. Null: not here yet.
   */
  async show(ref: RemoteRef, mimeType: string): Promise<Preview | null> {
    const disk = this.deps.disk;
    const small = thumbable(mimeType) && !!disk && !!this.deps.makeThumb;
    if (small) {
      const t = await disk!.read(thumbRef(ref)).catch(() => null);
      if (t?.length) return { bytes: t, mimeType: sniffImage(t), thumb: true };
    }
    const bytes = await this.preview(ref);
    if (!bytes) return null;
    if (small) {
      void this.deps.makeThumb!(bytes, mimeType)
        .then((t) => (t ? disk!.save(thumbRef(ref), t) : null))
        .catch(() => undefined);
    }
    return { bytes, mimeType, thumb: false };
  }

  private async fetch(ref: RemoteRef, key: string, wake: boolean): Promise<Brought> {
    const disk = this.deps.disk;
    const path = disk ? await disk.cached(ref).catch(() => null) : null;
    if (path) return { path };
    if (!this.deps.connected()) {
      if (!wake) throw new Error('Your AppuBot computer isn’t connected');
      this.deps.onProgress(key, { phase: 'waking' });
      await this.deps.wake();
    }
    this.deps.onProgress(key, { phase: 'downloading', received: 0, ...(ref.size ? { total: ref.size } : {}) });
    let last = 0;
    const bytes = await this.deps.fetchBytes(ref, (received, total) => {
      // a few updates a second at most for a big file: each one re-renders the card
      const now = Date.now();
      if (now - last < 150) return;
      last = now;
      const t = total ?? ref.size;
      this.deps.onProgress(key, { phase: 'downloading', received, ...(t ? { total: t } : {}) });
    });
    if (!disk) {
      this.keep(key, bytes);
      return { bytes };
    }
    this.deps.onProgress(key, { phase: 'saving' });
    // the bytes too, so a preview waiting on this shows them without reading them back
    return { path: await disk.save(ref, bytes), bytes };
  }

  private keep(key: string, bytes: Uint8Array): void {
    if (bytes.length > MEMORY_MAX) return;
    this.memory.delete(key);
    this.memory.set(key, bytes);
    let total = 0;
    for (const b of this.memory.values()) total += b.length;
    for (const [k, b] of this.memory) {
      if (total <= MEMORY_MAX) break;
      this.memory.delete(k);
      total -= b.length;
    }
  }
}

/**
 * Which computers' copies to drop as the account view changes: every one on signing out (`all`), else the teams this
 * person was on and isn't any more. Nothing while the view is unread or its teams unknown.
 */
export function lostComputers(
  prev: { signedIn: boolean; teams?: { team: { id: string } }[] } | null | undefined,
  next: { signedIn: boolean; teams?: { team: { id: string } }[] } | null | undefined,
): 'all' | string[] {
  if (!prev?.signedIn || !next) return [];
  if (!next.signedIn) return 'all';
  if (!prev.teams || !next.teams) return [];
  const still = new Set(next.teams.map((t) => t.team.id));
  return prev.teams.filter((t) => !still.has(t.team.id)).map((t) => computerKey(t.team.id));
}
