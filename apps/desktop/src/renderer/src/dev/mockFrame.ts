/**
 * Dev-only: canvas-generated placeholder screenshots (a fake macOS desktop with Numbers open)
 * and tiny SVG placeholders for gateway files. Everything is created lazily and cached.
 */

export const FRAME_W = 1280;
export const FRAME_H = 832;
/** Real screen is 1512x982 points; frames are scaled down to 1280 wide. */
export const FRAME_SCALE = FRAME_W / 1512;

const FALLBACK_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const FONT = '-apple-system, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif';

export interface FrameImage { mimeType: string; data: string }

/** Cursor position (in frame pixels) for each variant; variant 0 is the idle live view. */
const CURSORS: ReadonlyArray<{ x: number; y: number } | null> = [
  null,
  { x: 540, y: 790 },
  { x: 610, y: 54 },
  { x: Math.round(412 * FRAME_SCALE), y: Math.round(88 * FRAME_SCALE) },
  { x: 760, y: 330 },
];

const cache = new Map<number, FrameImage>();

/** Base64 (no data: prefix) JPEG of the fake desktop. Variants 1–4 highlight a different cell and show a cursor. */
export function frameImage(variant: number): FrameImage {
  const v = ((variant % CURSORS.length) + CURSORS.length) % CURSORS.length;
  const hit = cache.get(v);
  if (hit) return hit;
  const img = draw(v);
  cache.set(v, img);
  return img;
}

const CLIENTS = ['Acme Corp', 'Globex Ltd', 'Initech', 'Umbrella Co', 'Stark Industries', 'Wayne Enterprises', 'Hooli', 'Pied Piper', 'Soylent', 'Wonka Foods', 'Tyrell Corp', 'Cyberdyne'];
const COLS: ReadonlyArray<{ title: string; w: number; align: 'left' | 'right' }> = [
  { title: 'Client', w: 200, align: 'left' },
  { title: 'Invoice #', w: 110, align: 'left' },
  { title: 'Date', w: 120, align: 'left' },
  { title: 'Amount (₹)', w: 150, align: 'right' },
  { title: 'GST 18%', w: 130, align: 'right' },
  { title: 'Total (₹)', w: 150, align: 'right' },
];

function inr(n: number): string {
  return Math.round(n).toLocaleString('en-IN');
}

function draw(variant: number): FrameImage {
  if (typeof document === 'undefined') return { mimeType: 'image/png', data: FALLBACK_PNG };
  const canvas = document.createElement('canvas');
  canvas.width = FRAME_W;
  canvas.height = FRAME_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { mimeType: 'image/png', data: FALLBACK_PNG };

  drawWallpaper(ctx);
  drawMenuBar(ctx);
  drawWindow(ctx, variant);
  drawDock(ctx);
  const cursor = CURSORS[variant];
  if (cursor) drawCursor(ctx, cursor.x, cursor.y);

  const url = canvas.toDataURL('image/jpeg', 0.82);
  return { mimeType: 'image/jpeg', data: url.replace(/^data:image\/jpeg;base64,/, '') };
}

function drawWallpaper(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createLinearGradient(0, 0, FRAME_W, FRAME_H);
  g.addColorStop(0, '#1d2b64');
  g.addColorStop(0.55, '#6a3093');
  g.addColorStop(1, '#f8a170');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, FRAME_W, FRAME_H);
  const blobs: Array<[number, number, number, string]> = [
    [180, 700, 420, 'rgba(238,121,68,0.45)'],
    [1100, 160, 380, 'rgba(85,106,220,0.45)'],
    [900, 760, 300, 'rgba(255,214,140,0.35)'],
  ];
  for (const [x, y, r, c] of blobs) {
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, c);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, FRAME_W, FRAME_H);
  }
}

function drawMenuBar(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = 'rgba(246,246,248,0.78)';
  ctx.fillRect(0, 0, FRAME_W, 26);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#111';
  ctx.beginPath();
  ctx.arc(22, 13, 6, 0, Math.PI * 2);
  ctx.fill();
  let x = 42;
  const items = ['Numbers', 'File', 'Edit', 'Insert', 'Table', 'Format', 'Arrange', 'View', 'Window', 'Help'];
  items.forEach((label, i) => {
    ctx.font = `${i === 0 ? 700 : 400} 13px ${FONT}`;
    ctx.fillText(label, x, 13);
    x += ctx.measureText(label).width + 20;
  });
  ctx.font = `400 13px ${FONT}`;
  const clock = 'Mon 12 Oct  10:41';
  ctx.fillText(clock, FRAME_W - ctx.measureText(clock).width - 16, 13);
  ctx.fillRect(FRAME_W - 190, 8, 22, 10);
}

function drawWindow(ctx: CanvasRenderingContext2D, variant: number): void {
  const wx = 150, wy = 40, ww = 980, wh = 640;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 14;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(wx, wy, ww, wh, 12);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(wx, wy, ww, wh, 12);
  ctx.clip();
  // title bar
  ctx.fillStyle = '#ececec';
  ctx.fillRect(wx, wy, ww, 32);
  const lights = ['#ff5f57', '#febc2e', '#28c840'];
  lights.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(wx + 20 + i * 20, wy + 16, 6, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = '#333';
  ctx.font = `600 13px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('Invoices.numbers', wx + ww / 2, wy + 16);
  ctx.textAlign = 'left';

  // sheet tabs
  ctx.fillStyle = '#f5f5f5';
  ctx.fillRect(wx, wy + 32, ww, 30);
  const tabs = ['Clients', 'Invoices', 'Expenses', 'Summary'];
  let tx = wx + 20;
  tabs.forEach((t) => {
    ctx.font = `500 12px ${FONT}`;
    const w = ctx.measureText(t).width + 28;
    if (t === 'Invoices') {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.roundRect(tx, wy + 37, w, 22, 6);
      ctx.fill();
    }
    ctx.fillStyle = t === 'Invoices' ? '#111' : '#666';
    ctx.fillText(t, tx + 14, wy + 48);
    tx += w + 6;
  });

  drawGrid(ctx, wx + 24, wy + 82, variant);
  ctx.restore();
}

function drawGrid(ctx: CanvasRenderingContext2D, gx: number, gy: number, variant: number): void {
  const rowH = 30;
  const totalW = COLS.reduce((a, c) => a + c.w, 0);
  ctx.fillStyle = '#111';
  ctx.font = `700 20px ${FONT}`;
  ctx.fillText('Invoices - FY 2026-27', gx, gy - 4);
  const top = gy + 18;
  // header
  ctx.fillStyle = '#f0f3f8';
  ctx.fillRect(gx, top, totalW, rowH);
  const rows = CLIENTS.length;
  const highlightRow = variant === 0 ? -1 : (variant * 2) % rows;
  for (let r = 0; r < rows; r++) {
    const y = top + rowH * (r + 1);
    if (r % 2 === 1) {
      ctx.fillStyle = '#fafbfc';
      ctx.fillRect(gx, y, totalW, rowH);
    }
  }
  // highlight cell (Amount column)
  if (highlightRow >= 0) {
    const cx = gx + COLS[0]!.w + COLS[1]!.w + COLS[2]!.w;
    const cy = top + rowH * (highlightRow + 1);
    ctx.fillStyle = 'rgba(52,120,246,0.14)';
    ctx.fillRect(cx, cy, COLS[3]!.w, rowH);
    ctx.strokeStyle = '#3478f6';
    ctx.lineWidth = 2;
    ctx.strokeRect(cx + 1, cy + 1, COLS[3]!.w - 2, rowH - 2);
  }
  // lines
  ctx.strokeStyle = '#e1e4ea';
  ctx.lineWidth = 1;
  for (let r = 0; r <= rows + 2; r++) {
    const y = top + rowH * r + 0.5;
    ctx.beginPath(); ctx.moveTo(gx, y); ctx.lineTo(gx + totalW, y); ctx.stroke();
  }
  let x = gx;
  for (let c = 0; c <= COLS.length; c++) {
    ctx.beginPath(); ctx.moveTo(x + 0.5, top); ctx.lineTo(x + 0.5, top + rowH * (rows + 2)); ctx.stroke();
    x += COLS[c]?.w ?? 0;
  }
  // text
  const cell = (text: string, col: number, row: number, bold = false): void => {
    let cx = gx;
    for (let i = 0; i < col; i++) cx += COLS[i]!.w;
    const spec = COLS[col]!;
    ctx.font = `${bold ? 600 : 400} 13px ${FONT}`;
    ctx.fillStyle = bold ? '#111' : '#333';
    ctx.textAlign = spec.align;
    ctx.fillText(text, spec.align === 'right' ? cx + spec.w - 10 : cx + 10, top + rowH * row + rowH / 2);
    ctx.textAlign = 'left';
  };
  COLS.forEach((c, i) => cell(c.title, i, 0, true));
  let sum = 0;
  CLIENTS.forEach((name, r) => {
    const amount = 40_000 + ((r * 37_919) % 110_000);
    const gst = amount * 0.18;
    sum += amount + gst;
    cell(name, 0, r + 1);
    cell(`INV-${String(31 + r).padStart(4, '0')}`, 1, r + 1);
    cell(`${String(1 + ((r * 3) % 28)).padStart(2, '0')}/09/2026`, 2, r + 1);
    cell(inr(amount), 3, r + 1);
    cell(inr(gst), 4, r + 1);
    cell(inr(amount + gst), 5, r + 1);
  });
  cell('Total', 0, rows + 1, true);
  cell(inr(sum), 5, rows + 1, true);
}

function drawDock(ctx: CanvasRenderingContext2D): void {
  const icons = ['#3b82f6', '#22c55e', '#f97316', '#eab308', '#ef4444', '#a855f7', '#14b8a6', '#64748b', '#ee7944'];
  const size = 48, gap = 10, pad = 10;
  const w = icons.length * size + (icons.length - 1) * gap + pad * 2;
  const x0 = (FRAME_W - w) / 2, y0 = FRAME_H - size - pad * 2 - 8;
  ctx.fillStyle = 'rgba(255,255,255,0.32)';
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath();
  ctx.roundRect(x0, y0, w, size + pad * 2, 18);
  ctx.fill();
  ctx.stroke();
  icons.forEach((c, i) => {
    const ix = x0 + pad + i * (size + gap), iy = y0 + pad;
    const g = ctx.createLinearGradient(ix, iy, ix, iy + size);
    g.addColorStop(0, c);
    g.addColorStop(1, shade(c));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(ix, iy, size, size, 11);
    ctx.fill();
    if (i === 1) {
      // Numbers: little bar chart + running dot
      ctx.fillStyle = '#fff';
      [14, 24, 18].forEach((h, b) => ctx.fillRect(ix + 12 + b * 9, iy + size - 10 - h, 6, h));
      ctx.beginPath();
      ctx.arc(ix + size / 2, iy + size + 6, 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fill();
    }
  });
}

function shade(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number): number => Math.max(0, Math.round(v * 0.72));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function drawCursor(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save();
  ctx.fillStyle = 'rgba(238,121,68,0.28)';
  ctx.beginPath();
  ctx.arc(x, y, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(0, 20); ctx.lineTo(5, 15); ctx.lineTo(9, 23); ctx.lineTo(12, 22); ctx.lineTo(8, 14); ctx.lineTo(14, 14);
  ctx.closePath();
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/* ---------- file placeholders ---------- */

const fileCache = new Map<string, string>();

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c);
}

/** Small SVG data URL standing in for a gateway file (so <img>/<iframe> never 404 in mock mode). */
export function placeholderFileUrl(name: string, mimeType = ''): string {
  const key = `${name}|${mimeType}`;
  const hit = fileCache.get(key);
  if (hit) return hit;
  const isImage = mimeType.startsWith('image/');
  const label = escapeXml(name);
  const kind = escapeXml(mimeType.split('/')[1]?.toUpperCase() ?? 'FILE');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${isImage ? '#556adc' : '#fdf1ea'}"/><stop offset="1" stop-color="${isImage ? '#ee7944' : '#f6e1d4'}"/></linearGradient></defs>
<rect width="640" height="420" rx="18" fill="url(#g)"/>
<rect x="250" y="110" width="140" height="170" rx="12" fill="#fff" opacity="0.92"/>
<text x="320" y="210" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="700" fill="#ee7944">${kind}</text>
<text x="320" y="330" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="20" fill="${isImage ? '#fff' : '#5b3a29'}">${label}</text>
</svg>`;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  fileCache.set(key, url);
  return url;
}
