/**
 * SVG → JPEG in a hidden offscreen window (nativeImage can't read SVG): the Telegram bot's profile photo
 * (`CoreDeps.svgToJpeg`). One short-lived window per call; it never shows and loads nothing but the image.
 */
import { BrowserWindow, type NativeImage } from 'electron';

export async function svgToJpeg(svg: string, size: number, quality = 92): Promise<Buffer> {
  const win = new BrowserWindow({
    width: size, height: size, show: false, frame: false, useContentSize: true,
    webPreferences: { offscreen: true, javascript: false, sandbox: true, images: true },
  });
  try {
    win.webContents.setZoomFactor(1);
    const html = `<!doctype html><html><body style="margin:0;overflow:hidden;background:#fff"><img style="display:block;width:${size}px;height:${size}px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`;
    // the first frame painted after the page loads is the picture
    const painted = new Promise<NativeImage>((resolve) => {
      win.webContents.on('paint', (_e, _dirty, image) => { if (!image.isEmpty()) resolve(image); });
    });
    await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
    const image = await Promise.race([
      painted,
      new Promise<NativeImage>((resolve) => setTimeout(() => { void win.webContents.capturePage().then(resolve); }, 1500)),
    ]);
    const { width } = image.getSize();
    const out = width && width !== size ? image.resize({ width: size, height: size, quality: 'best' }) : image;
    return out.toJPEG(quality);
  } finally {
    win.destroy();
  }
}
