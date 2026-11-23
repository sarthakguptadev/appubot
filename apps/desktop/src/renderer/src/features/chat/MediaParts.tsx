// Images and files in the transcript (adapted from Akeru's BotMessageAttachments, MIT): image tiles in a
// two-column grid that open the message's image gallery on click (imageGallery.ts), and file tiles with Open / Reveal.
// On a remote computer (your AppuBot computer, a team's) the files are brought to this Mac (features/cloud/remoteFiles.ts):
// pictures and clips show from its cache, Open opens the copy, and Reveal is Download (into Downloads, shown in Finder).
// Shown at once on the way back: tiles are fixed shapes, pictures already shown this run paint in the first frame
// (CachedImg, lib/imageCache.ts), a cloud computer's pictures come from their thumbnails on disk, and a clip's box
// takes the shape it had last time (`mediaShapes`), so nothing below it jumps when it loads. A picture not shown yet
// this run arrives as a grid of cells that take its colours (RevealImg, Rare UI's GridReveal).
import type { FileAttachment, Part } from '@appubot/protocol';
import { Download, ExternalLink, File, FileText, FolderOpen, Image as ImageIcon, Music, Video } from '../../components/ui/icons';
import { Button, Icon, RevealImg, Spinner, cn } from '../../components/ui';
import { aspectOf, mediaShapes } from '../../lib/imageCache';
import { basename, bytes } from '@appubot/chat-core';
import { fileUrl } from '../../lib/gateway';
import { native } from '../../lib/native';
import { openInApp } from '../files/FileViewer';
import { useCloudFiles } from '../cloud/cloudClient';
import { downloadRemoteFile, progressLabel, useFileProgress, useFileSrc, useRemoteComputer } from '../cloud/remoteFiles';
import { galleryProps, openGalleryAt } from './imageGallery';

type ImagePart = Extract<Part, { type: 'image' }>;

export const imageSrc = (p: ImagePart): string => (p.data ? `data:${p.mimeType};base64,${p.data}` : p.url ? fileUrl(p.url) : '');

export function ImageTiles({ images }: { images: ImagePart[] }) {
  const shown = images.filter((p) => p.data || p.url);
  if (!shown.length) return null;
  return (
    <div className={cn('grid gap-2', shown.length === 1 ? 'max-w-[320px] grid-cols-1' : 'max-w-[420px] grid-cols-2')}>
      {shown.map((p, i) => <ImageTile key={i} part={p} />)}
    </div>
  );
}

/** One picture: inline bytes as they are, a stored one from its computer (a remote one's through this Mac's cache). */
function ImageTile({ part }: { part: ImagePart }) {
  // a cloud computer's files come through its channel: re-render once their bytes are here
  useCloudFiles((s) => s.rev);
  const fetched = useFileSrc({ url: part.url ?? '', mimeType: part.mimeType });
  const src = part.data ? `data:${part.mimeType};base64,${part.data}` : fetched;
  const cls = 'block aspect-[4/3] overflow-hidden rounded-control border border-border-subtle bg-surface-2';
  // still on its way from a remote computer: the grid waits in the tile
  if (!src) return <div className={cls}><RevealImg src="" /></div>;
  return (
    <button
      type="button"
      aria-label="Open image"
      {...galleryProps(src)}
      onClick={openGalleryAt}
      className={cn(cls, 'cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
    >
      <RevealImg src={src} />
    </button>
  );
}

function typeLabel(f: FileAttachment): string {
  if (f.mimeType === 'application/pdf') return 'PDF';
  if (f.mimeType === 'text/markdown') return 'Markdown';
  if (f.mimeType.startsWith('image/')) return f.mimeType.slice(6).toUpperCase();
  const ext = /\.([a-z0-9]{1,6})$/i.exec(f.name)?.[1];
  return ext ? ext.toUpperCase() : 'File';
}

/** Audio and video Chromium plays: they get a player under their tile. */
const playable = (f: FileAttachment): 'audio' | 'video' | null =>
  /^audio\/(mpeg|mp3|mp4|aac|wav|x-wav|ogg|opus|flac|webm)$/.test(f.mimeType) ? 'audio'
    : /^video\/(mp4|webm|ogg)$/.test(f.mimeType) ? 'video' : null;

/** A file the bot made or sent: icon (or thumbnail), name, size · type, Open / Reveal; songs and clips play inline. */
/** `sending`: a file still on its way with a message sent from here ("Uploading…"): no link yet, so no actions. */
export function FileTile({ file, sending }: { file: FileAttachment; sending?: string }) {
  // a cloud computer's files come through its channel: re-render once their bytes are here
  useCloudFiles((s) => s.rev);
  const isImage = file.mimeType.startsWith('image/');
  const url = useFileSrc(sending !== undefined ? { url: '', mimeType: file.mimeType } : file);
  const remote = useRemoteComputer();
  const progress = progressLabel(useFileProgress(sending !== undefined ? {} : file));
  const busy = sending !== undefined ? sending : progress;
  const media = playable(file);
  const tile = (
    <div className="flex max-w-[420px] items-center gap-3 rounded-control-lg border border-border-subtle bg-[color-mix(in_srgb,var(--ab-surface)_40%,transparent)] py-2 pr-2 pl-2.5">
      {isImage && url ? (
        <button type="button" {...galleryProps(url, file.name)} onClick={openGalleryAt} aria-label="Preview" className="size-10 shrink-0 cursor-zoom-in overflow-hidden rounded-control border border-border-subtle">
          <RevealImg src={url} cells={24} />
        </button>
      ) : (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-surface-2 text-muted">
          <Icon icon={file.mimeType === 'application/pdf' || file.mimeType.startsWith('text/') ? FileText : isImage ? ImageIcon : media === 'audio' ? Music : media === 'video' ? Video : File} size={18} />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-copy font-medium text-fg" title={file.name}>{file.name}</span>
        <span className="truncate text-note text-muted" title={file.caption}>{[bytes(file.size), typeLabel(file), file.caption].filter(Boolean).join(' · ')}</span>
      </span>
      {sending !== undefined ? (
        sending ? <span role="status" className="flex h-7 shrink-0 items-center gap-1.5 px-2 text-ui text-muted tabular-nums">{sending}</span> : null
      ) : busy ? (
        <span role="status" className="flex h-7 shrink-0 items-center gap-1.5 px-2 text-ui text-muted tabular-nums"><Spinner size={12} />{busy}</span>
      ) : (
        <>
          <Button size="xs" variant="ghost" icon={ExternalLink} onClick={() => openInApp(file)}>Open</Button>
          {remote ? (
            <Button size="xs" variant="ghost" icon={Download} title="Save to this Mac’s Downloads folder" onClick={() => void downloadRemoteFile(file)}>Download</Button>
          ) : file.path ? <Button size="xs" variant="ghost" icon={FolderOpen} onClick={() => void native().showInFolder(file.path!)}>Reveal</Button> : null}
        </>
      )}
    </div>
  );
  // a remote computer's song or clip plays once it's here (a big one only after Open)
  if (!media || !url) return tile;
  return (
    <div className="flex max-w-[420px] flex-col gap-1.5">
      {tile}
      {media === 'audio'
        ? <audio controls preload="metadata" src={url} className="h-9 w-full" />
        : <ClipPlayer src={url} shapeKey={`${remote ?? 'local'}:${file.id}`} />}
    </div>
  );
}

/** A clip's player, its box the clip's own shape from the first frame (remembered from the last time it loaded). */
function ClipPlayer({ src, shapeKey }: { src: string; shapeKey: string }) {
  const shape = mediaShapes.get(shapeKey);
  return (
    <video
      controls
      preload="metadata"
      src={src}
      onLoadedMetadata={(e) => {
        const v = e.currentTarget;
        if (v.videoWidth && v.videoHeight) mediaShapes.set(shapeKey, [v.videoWidth, v.videoHeight]);
      }}
      style={{ aspectRatio: aspectOf(shape, '16 / 9') }}
      className="max-h-[280px] w-full rounded-control border border-border-subtle bg-black object-contain"
    />
  );
}

/** An attached path in a user message ("Files: /path" lines the composer adds). */
export function PathChip({ path }: { path: string }) {
  // a path on a remote computer has nothing to show in this Mac's Finder
  const remote = useRemoteComputer();
  if (remote) {
    return (
      <span title={path} className="inline-flex h-7 max-w-[240px] items-center gap-1.5 ab-pill squircle rounded-control bg-[color-mix(in_srgb,var(--ab-fg)_6%,transparent)] px-2 text-ui text-fg-2">
        <Icon icon={File} size={14} className="text-muted" />
        <span className="truncate">{basename(path)}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      title={path}
      onClick={() => void native().showInFolder(path)}
      className="inline-flex h-7 max-w-[240px] items-center gap-1.5 ab-pill squircle rounded-control bg-[color-mix(in_srgb,var(--ab-fg)_6%,transparent)] px-2 text-ui text-fg-2 hover:text-fg"
    >
      <Icon icon={File} size={14} className="text-muted" />
      <span className="truncate">{basename(path)}</span>
    </button>
  );
}
