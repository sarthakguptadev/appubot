import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { nativeImage } from 'electron';
import { IMAGE_FIT_DIM, IMAGE_SOURCE_MAX } from '@appubot/chat-core';

const run = promisify(execFile);
const SIPS = '/usr/bin/sips';

/**
 * A picture the window can't decode (HEIC, TIFF…) as a JPEG at most `IMAGE_FIT_DIM` on its long edge, for the
 * composer: macOS's `sips` reads HEIC, Electron's nativeImage (PNG/JPEG, Windows' BMP/ICO) elsewhere. Null when it can't.
 */
export async function imageToJpeg(path: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    if (!isAbsolute(path)) return null;
    const st = statSync(path);
    if (!st.isFile() || st.size > IMAGE_SOURCE_MAX) return null;
  } catch { return null; }
  if (process.platform === 'darwin') return sipsJpeg(path);
  let img = nativeImage.createFromPath(path);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  if (Math.max(width, height) > IMAGE_FIT_DIM) {
    img = img.resize(width >= height ? { width: IMAGE_FIT_DIM, quality: 'good' } : { height: IMAGE_FIT_DIM, quality: 'good' });
  }
  return { data: img.toJPEG(85).toString('base64'), mimeType: 'image/jpeg' };
}

async function sipsJpeg(path: string): Promise<{ data: string; mimeType: string } | null> {
  const dir = mkdtempSync(join(tmpdir(), 'appubot-img-'));
  try {
    // sips -Z also enlarges, so only past the limit
    const { stdout } = await run(SIPS, ['-g', 'pixelWidth', '-g', 'pixelHeight', path], { timeout: 15_000 });
    const dim = (k: string) => Number(new RegExp(`${k}: (\\d+)`).exec(stdout)?.[1] ?? 0);
    const long = Math.max(dim('pixelWidth'), dim('pixelHeight'));
    if (!long) return null;
    const out = join(dir, 'image.jpg');
    const resize = long > IMAGE_FIT_DIM ? ['-Z', String(IMAGE_FIT_DIM)] : [];
    await run(SIPS, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', ...resize, path, '--out', out], { timeout: 30_000 });
    return { data: readFileSync(out).toString('base64'), mimeType: 'image/jpeg' };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
