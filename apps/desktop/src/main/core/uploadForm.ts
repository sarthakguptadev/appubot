/**
 * `POST /api/files`'s multipart form, read as it arrives: the file's bytes go straight to a file on disk and the few
 * text fields (`threadId`) are kept, so an upload of hundreds of megabytes (a bot's bundle in a transfer) never sits
 * whole in this computer's memory. Before (2026-11-15) the route read the body three times over in memory (Hono's
 * `bodyLimit` buffering a chunked body to measure it, then `parseBody`, then `arrayBuffer`): a 500 MB bundle would
 * have taken some 2 GB on a cloud computer with 4.
 *
 * Only what the apps send: one file part (the first named `file` is kept, others are read past) and short text fields,
 * as browsers' FormData, undici's, React Native's and `@appubot/client`'s `multipartBody`/`uploadStream` write them.
 */
import { open, rm, type FileHandle } from 'node:fs/promises';

export class UploadError extends Error {
  constructor(public status: 400 | 413, message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

export interface UploadedFile { path: string; name: string; type: string; size: number }
export interface UploadedForm { file?: UploadedFile; fields: Record<string, string> }

/** a part's head (its Content-Disposition and Content-Type lines) can't be longer than this */
const HEAD_MAX = 16 * 1024;
/** a text field's value */
const FIELD_MAX = 64 * 1024;
const FIELDS_MAX = 20;

/** The boundary a multipart Content-Type names, or null. */
export function boundaryOf(contentType: string | null | undefined): string | null {
  if (!contentType || !/^multipart\/form-data/i.test(contentType.trim())) return null;
  const m = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const b = m?.[1] ?? m?.[2];
  return b && b.length <= 200 ? b : null;
}

/** a header's parameter (`name`, `filename`): quoted (with `%22` and `\"` for quotes, as browsers write them) or bare */
function param(header: string, key: string): string | undefined {
  const m = new RegExp(`;\\s*${key}=(?:"((?:[^"\\\\]|\\\\.)*)"|([^;]*))`, 'i').exec(header);
  if (!m) return undefined;
  const v = m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? '').trim();
  return v.replace(/%22/g, '"').replace(/%0D/gi, '\r').replace(/%0A/gi, '\n');
}

interface PartHead { name: string; filename?: string; type: string }
function readHead(raw: string): PartHead {
  let disposition = '';
  let type = '';
  for (const line of raw.split('\r\n')) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (key === 'content-disposition') disposition = value;
    else if (key === 'content-type') type = value;
  }
  if (!/^form-data/i.test(disposition)) throw new UploadError(400, 'Not a form part');
  const filename = param(disposition, 'filename');
  return { name: param(disposition, 'name') ?? '', ...(filename !== undefined ? { filename } : {}), type };
}

/**
 * Reads the form from `body`, writing the file part to `filePath` (made only when one comes). `maxSize`: the whole body
 * at most (413 past it, as soon as it passes). Whatever goes wrong, a half-written file is removed and an `UploadError`
 * (or the body's own error) is thrown.
 */
export async function readUploadForm(body: ReadableStream<Uint8Array> | null, contentType: string | null | undefined, o: { filePath: string; maxSize: number }): Promise<UploadedForm> {
  const boundary = boundaryOf(contentType);
  if (!boundary || !body) throw new UploadError(400, 'Expected a multipart form');
  // the stream is read as if it began with CRLF, so the first boundary looks like every other one
  const delim = Buffer.from(`\r\n--${boundary}`);
  let buf: Buffer = Buffer.from('\r\n');
  let state: 'preamble' | 'after' | 'head' | 'body' | 'end' = 'preamble';
  let total = 0;
  const fields: Record<string, string> = {};
  let nFields = 0;
  // what was written (held in an object: the reads below change it from inside `step`)
  const out: { file?: UploadedFile; fh: FileHandle | null; made: boolean } = { fh: null, made: false };
  // the part being read: the file (to disk), a field (kept), or one we read past
  let part: { kind: 'file' } | { kind: 'field'; name: string; chunks: Buffer[]; size: number } | { kind: 'skip' } = { kind: 'skip' };

  const take = async (bytes: Buffer): Promise<void> => {
    if (!bytes.length) return;
    if (part.kind === 'file') {
      await out.fh!.write(bytes);
      out.file!.size += bytes.length;
    } else if (part.kind === 'field') {
      part.size += bytes.length;
      if (part.size > FIELD_MAX) throw new UploadError(400, 'A form field is too long');
      part.chunks.push(bytes);
    }
  };
  const endPart = async (): Promise<void> => {
    if (part.kind === 'field') fields[part.name] = Buffer.concat(part.chunks).toString('utf8');
    part = { kind: 'skip' };
  };

  /** works through `buf` as far as it can; false: it needs more bytes */
  const step = async (): Promise<boolean> => {
    if (state === 'preamble') {
      const at = buf.indexOf(delim);
      if (at < 0) { buf = buf.subarray(Math.max(0, buf.length - delim.length)); return false; }
      buf = buf.subarray(at + delim.length);
      state = 'after';
      return true;
    }
    if (state === 'after') {
      // after a boundary: `--` ends the form, else CRLF (maybe after spaces) starts a part
      if (buf.length < 2) return false;
      if (buf[0] === 0x2d && buf[1] === 0x2d) { state = 'end'; return true; }
      const nl = buf.indexOf('\r\n');
      if (nl < 0) { if (buf.length > 256) throw new UploadError(400, 'A broken form'); return false; }
      buf = buf.subarray(nl + 2);
      state = 'head';
      return true;
    }
    if (state === 'head') {
      const at = buf.indexOf('\r\n\r\n');
      if (at < 0) { if (buf.length > HEAD_MAX) throw new UploadError(400, 'A form part’s head is too long'); return false; }
      const head = readHead(buf.subarray(0, at).toString('utf8'));
      buf = buf.subarray(at + 4);
      state = 'body';
      if (head.filename !== undefined && head.name === 'file' && !out.file) {
        out.fh = await open(o.filePath, 'w', 0o600);
        out.made = true;
        out.file = { path: o.filePath, name: head.filename, type: head.type, size: 0 };
        part = { kind: 'file' };
      } else if (head.filename === undefined && head.name && ++nFields <= FIELDS_MAX) {
        part = { kind: 'field', name: head.name, chunks: [], size: 0 };
      } else part = { kind: 'skip' };
      return true;
    }
    if (state === 'body') {
      const at = buf.indexOf(delim);
      if (at < 0) {
        // everything but what could be the start of the boundary
        const safe = Math.max(0, buf.length - delim.length + 1);
        if (!safe) return false;
        await take(buf.subarray(0, safe));
        buf = buf.subarray(safe);
        return false;
      }
      await take(buf.subarray(0, at));
      buf = buf.subarray(at + delim.length);
      await endPart();
      state = 'after';
      return true;
    }
    // the epilogue is read past
    buf = Buffer.alloc(0);
    return false;
  };

  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > o.maxSize) throw new UploadError(413, 'File too large');
      buf = buf.length ? Buffer.concat([buf, Buffer.from(value.buffer, value.byteOffset, value.byteLength)]) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      while (await step()) { /* on through the buffer */ }
    }
    if ((state as string) !== 'end') throw new UploadError(400, 'The form ended early');
    await out.fh?.close();
    out.fh = null;
    return { ...(out.file ? { file: out.file } : {}), fields };
  } catch (e) {
    reader.cancel().catch(() => undefined);
    await out.fh?.close().catch(() => undefined);
    if (out.made) await rm(o.filePath, { force: true }).catch(() => undefined);
    throw e;
  }
}
