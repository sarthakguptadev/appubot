import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { multipartBody } from '@appubot/client';
import { UploadError, boundaryOf, readUploadForm } from './uploadForm';

const dir = mkdtempSync(join(tmpdir(), 'upload-form-'));
let n = 0;
const target = () => join(dir, `f${n++}.part`);

/** a body handed over in pieces of `size` bytes (so boundaries fall across them) */
function pieces(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.length) { c.close(); return; }
      c.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

async function formOf(fd: FormData): Promise<{ body: Uint8Array; type: string }> {
  const req = new Request('http://x/api/files', { method: 'POST', body: fd });
  return { body: new Uint8Array(await req.arrayBuffer()), type: req.headers.get('content-type')! };
}

describe('readUploadForm', () => {
  it('reads FormData as undici writes it: the file to disk, the fields kept, whatever the pieces', async () => {
    const data = new Uint8Array(70_000).map((_, i) => (i * 7) % 251);
    const fd = new FormData();
    fd.append('file', new Blob([data], { type: 'application/zip' }), 'ada "bot".appubot-bot.zip');
    fd.append('threadId', 'th_1');
    const { body, type } = await formOf(fd);
    for (const size of [1, 7, 64, 4096, body.length]) {
      const path = target();
      const form = await readUploadForm(pieces(body, size), type, { filePath: path, maxSize: 1e9 });
      expect(form.fields).toEqual({ threadId: 'th_1' });
      expect(form.file).toMatchObject({ path, name: 'ada "bot".appubot-bot.zip', type: 'application/zip', size: data.length });
      expect(new Uint8Array(readFileSync(path))).toEqual(data);
    }
  });

  it('reads the client’s own multipart form, and a file whose bytes look like a boundary’s start', async () => {
    const data = new TextEncoder().encode('line\r\n--not-it\r\n--also\r\n');
    const { body, contentType } = multipartBody([['file', { name: 'a.txt', type: 'text/plain', data }]]);
    const path = target();
    const form = await readUploadForm(pieces(body, 3), contentType, { filePath: path, maxSize: 1e9 });
    expect(readFileSync(path, 'utf8')).toBe('line\r\n--not-it\r\n--also\r\n');
    expect(form.file?.name).toBe('a.txt');
  });

  it('refuses a body over the limit as it passes, and leaves no file behind', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(50_000)]), 'big.bin');
    const { body, type } = await formOf(fd);
    const path = target();
    await expect(readUploadForm(pieces(body, 1000), type, { filePath: path, maxSize: 20_000 })).rejects.toMatchObject({ status: 413 });
    expect(existsSync(path)).toBe(false);
  });

  it('refuses what isn’t a whole form', async () => {
    const fd = new FormData();
    fd.append('file', new Blob(['hello']), 'a.txt');
    const { body, type } = await formOf(fd);
    const path = target();
    await expect(readUploadForm(pieces(body.slice(0, body.length - 10), 5), type, { filePath: path, maxSize: 1e9 })).rejects.toBeInstanceOf(UploadError);
    expect(existsSync(path)).toBe(false);
    await expect(readUploadForm(pieces(body, 5), 'text/plain', { filePath: target(), maxSize: 1e9 })).rejects.toMatchObject({ status: 400 });
  });

  it('a form with no file part has none', async () => {
    const fd = new FormData();
    fd.append('threadId', 'x');
    const { body, type } = await formOf(fd);
    const form = await readUploadForm(pieces(body, 9), type, { filePath: target(), maxSize: 1e9 });
    expect(form.file).toBeUndefined();
    expect(form.fields.threadId).toBe('x');
  });

  it('reads a boundary quoted or bare', () => {
    expect(boundaryOf('multipart/form-data; boundary=abc')).toBe('abc');
    expect(boundaryOf('multipart/form-data; boundary="a b"')).toBe('a b');
    expect(boundaryOf('application/json')).toBeNull();
  });
});
