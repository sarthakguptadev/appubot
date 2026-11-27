/** Small framework-agnostic helpers shared by the core services. */
import { randomBytes, createHash } from 'node:crypto';

export class RpcError extends Error {
  constructor(public code: string, message: string, public data?: unknown) {
    super(message);
    this.name = 'RpcError';
  }
}

export const notFound = (what: string, id: string): RpcError => new RpcError('not_found', `${what} not found: ${id}`);

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export const consoleLogger: Logger = {
  debug: () => undefined,
  info: (m, meta) => console.log(`[core] ${m}`, meta ?? ''),
  warn: (m, meta) => console.warn(`[core] ${m}`, meta ?? ''),
  error: (m, meta) => console.error(`[core] ${m}`, meta ?? ''),
};

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

/** Simple promise mutex (FIFO). */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private count = 0;
  get locked(): boolean { return this.count > 0; }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.count++;
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    try {
      await prev;
      return await fn();
    } finally {
      this.count--;
      release();
    }
  }
}

/** Deep-merge plain objects (arrays and primitives replace). */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : (patch as T));
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function todayStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', htm: 'text/html',
  xml: 'application/xml', zip: 'application/zip', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', webm: 'video/webm', mp4: 'video/mp4', mov: 'video/quicktime',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  numbers: 'application/vnd.apple.numbers', pages: 'application/vnd.apple.pages', key: 'application/vnd.apple.keynote',
};
export function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return MIME[ext] ?? 'application/octet-stream';
}

/** Shell-quote one argument for /bin/sh. */
export function shq(s: string): string {
  if (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
