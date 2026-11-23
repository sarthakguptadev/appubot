// What a file is, for both apps' Files lists and viewers (2026-11-17, the owner's "show visuals as visuals, not as
// HTML; the same for other stuff too"): a bot's page is a visual, a picture a picture, a clip a clip, a song something
// to play; only a document is a row with a file's name. Pure: the kind, its words, and the list as runs (tiles side by
// side, then rows).
import type { FileAttachment } from '@appubot/protocol';

export type FileKind = 'page' | 'image' | 'video' | 'audio' | 'file';
type Named = Pick<FileAttachment, 'name' | 'mimeType' | 'caption'>;

const ext = (name: string): string => /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? '';

/** A page a bot showed (`show_page` keeps it as an HTML file), a picture, a clip or sound Chromium plays, else a document. */
export function fileKind(f: Pick<FileAttachment, 'name' | 'mimeType'>): FileKind {
  const type = f.mimeType.toLowerCase();
  if (type === 'text/html') return 'page';
  if (type.startsWith('image/')) return 'image';
  if (/^video\/(mp4|webm|ogg)$/.test(type)) return 'video';
  if (/^audio\/(mpeg|mp3|mp4|aac|wav|x-wav|ogg|opus|flac|webm|x-m4a)$/.test(type)) return 'audio';
  return 'file';
}

/** Shown as a tile with its picture (a page's preview, the picture, the clip's first frame): the rest are rows. */
export const isVisualKind = (k: FileKind): boolean => k === 'page' || k === 'image' || k === 'video';

const words = (stem: string): string => {
  const s = stem.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
};

/**
 * What a file is called on its tile: a page by its title (its caption; else its file name read as words, never
 * "weekly-activity.html"), anything else by its own name.
 */
export function fileTitle(f: Named): string {
  if (fileKind(f) !== 'page') return f.name;
  return f.caption?.trim() || words(f.name.replace(/\.html?$/i, '')) || 'Visual';
}

const DOCS: Record<string, string> = {
  pdf: 'PDF', md: 'Markdown', txt: 'Text', csv: 'Spreadsheet', tsv: 'Spreadsheet', xlsx: 'Spreadsheet', xls: 'Spreadsheet', numbers: 'Spreadsheet',
  doc: 'Document', docx: 'Document', pages: 'Document', rtf: 'Document', ppt: 'Slides', pptx: 'Slides', key: 'Slides',
  zip: 'Archive', gz: 'Archive', tar: 'Archive', tgz: 'Archive', '7z': 'Archive', rar: 'Archive', json: 'JSON', ics: 'Calendar', vcf: 'Contact',
};

/** The kind in a word, for the line under a name ("Visual", "Picture", "Video", "Audio", "PDF", "Spreadsheet", "ZIP"). */
export function fileKindLabel(f: Pick<FileAttachment, 'name' | 'mimeType'>): string {
  const kind = fileKind(f);
  if (kind === 'page') return 'Visual';
  if (kind === 'image') return 'Picture';
  if (kind === 'video') return 'Video';
  if (kind === 'audio') return 'Audio';
  if (f.mimeType === 'application/pdf') return 'PDF';
  const e = ext(f.name);
  return DOCS[e] ?? (e ? e.toUpperCase() : 'File');
}

export type FileRun<T> = { tiles: true; items: T[] } | { tiles: false; items: T[] };

/** The list in order, as runs: visuals next to each other share a grid of tiles, documents and sound are rows. */
export function fileRuns<T extends Pick<FileAttachment, 'name' | 'mimeType'>>(files: readonly T[]): FileRun<T>[] {
  const out: FileRun<T>[] = [];
  for (const f of files) {
    const tiles = isVisualKind(fileKind(f));
    const last = out[out.length - 1];
    if (last && last.tiles === tiles) last.items.push(f);
    else out.push({ tiles, items: [f] });
  }
  return out;
}

/** How a file is shown inside the app (the viewer), or null where only its own app can open it (a Word file, a zip). */
export type ViewKind = 'page' | 'image' | 'video' | 'audio' | 'markdown' | 'table' | 'text';

/** text read into the viewer at most this big: past it the file opens in its own app */
export const VIEW_TEXT_MAX = 2 * 1024 * 1024;
const TEXT_EXT = new Set(['txt', 'log', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env', 'conf', 'sh', 'zsh', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'sql', 'swift', 'go', 'rs', 'rb', 'java', 'kt', 'c', 'h', 'cpp', 'ics', 'vcf', 'srt', 'vtt', 'tex']);

export function viewKind(f: Pick<FileAttachment, 'name' | 'mimeType' | 'size'>): ViewKind | null {
  const kind = fileKind(f);
  if (kind !== 'file') return kind;
  if (f.size > VIEW_TEXT_MAX) return null;
  const e = ext(f.name);
  const type = f.mimeType.toLowerCase();
  if (e === 'md' || e === 'markdown' || type === 'text/markdown') return 'markdown';
  if (e === 'csv' || e === 'tsv' || type === 'text/csv' || type === 'text/tab-separated-values') return 'table';
  if (TEXT_EXT.has(e) || type.startsWith('text/') || type === 'application/json') return 'text';
  return null;
}
