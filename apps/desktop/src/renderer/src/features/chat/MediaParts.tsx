// Images and files in the transcript (adapted from Akeru's BotMessageAttachments, MIT). A picture, sent as an image or
// as a file, shows as itself in a rounded box, the way ChatGPT shows one (the owner, 2026-11-27): its own shape up to
// 360 by 400, no name under it, the full view on click, Open and Download on hover; several side by side are one tight
// grid in one box. Other files are a tile with Open / Reveal.
// On a remote computer (your AppuBot computer, a team's) the files are brought to this Mac (features/cloud/remoteFiles.ts):
// pictures and clips show from its cache, Open opens the copy, and Reveal is Download (into Downloads, shown in Finder).
// Shown at once on the way back: tiles are fixed shapes, pictures already shown this run paint in the first frame
// (CachedImg, lib/imageCache.ts), a cloud computer's pictures come from their thumbnails on disk, and a clip's box
// takes the shape it had last time (`mediaShapes`), so nothing below it jumps when it loads. A picture not shown yet
// this run arrives as a grid of cells that take its colours (RevealImg, Rare UI's GridReveal).
import type { FileAttachment, Part } from '@appubot/protocol';
import { Download, ExternalLink, File, FileText, FolderOpen, Music, Video } from '../../components/ui/icons';
import { Button, Icon, RevealImg, Spinner, cn } from '../../components/ui';
import { aspectOf, mediaShapes } from '../../lib/imageCache';
import { basename, bytes } from '@appubot/chat-core';
import { fileUrl } from '../../lib/gateway';
import { native } from '../../lib/native';
import { openInApp } from '../files/FileViewer';
import { useEffect, useState } from 'react';
import { useCloudFiles } from '../cloud/cloudClient';
import { downloadRemoteFile, progressLabel, useFileProgress, useFileSrc, useRemoteComputer } from '../cloud/remoteFiles';
import { galleryProps, openGalleryAt } from './imageGallery';

type ImagePart = Extract<Part, { type: 'image' }>;

export const imageSrc = (p: ImagePart): string => (p.data ? `data:${p.mimeType};base64,${p.data}` : p.url ? fileUrl(p.url) : '');

/** A picture in a message: an image part, or a file that is a picture (`sending`: still on its way from here). */
export type Picture = { part: ImagePart } | { file: FileAttachment; sending?: string };

export const isPictureFile = (f: FileAttachment): boolean => f.mimeType.startsWith('image/');

/** the largest one picture shows, px */
const MAX_W = 360;
const MAX_H = 400;

/**
 * Pictures as themselves in one rounded box: one at its own shape (the shape it had last time, or 4:3, until it loads),
 * several as a tight two-column grid of squares, an odd first one across both columns.
 */
export function ImageBox({ pictures }: { pictures: Picture[] }) {
  if (pictures.length === 1) return <PictureCell picture={pictures[0]!} single />;
  return (
    <div className="grid w-[360px] max-w-full grid-cols-2 gap-0.5 overflow-hidden rounded-[16px] squircle">
      {pictures.map((p, i) => <PictureCell key={'file' in p ? p.file.id : i} picture={p} wide={i === 0 && pictures.length % 2 === 1} />)}
    </div>
  );
}

function PictureCell({ picture, single, wide }: { picture: Picture; single?: boolean; wide?: boolean }) {
  // a cloud computer's files come through its channel: re-render once their bytes are here
  useCloudFiles((s) => s.rev);
  const file = 'file' in picture ? picture.file : undefined;
  const part = 'part' in picture ? picture.part : undefined;
  const sending = 'file' in picture ? picture.sending : undefined;
  const fetched = useFileSrc(file ? (sending !== undefined ? { url: '', mimeType: file.mimeType } : file) : { url: part?.url ?? '', mimeType: part?.mimeType ?? '' });
  const src = part?.data ? `data:${part.mimeType};base64,${part.data}` : fetched;
  const remote = useRemoteComputer();
  const progress = progressLabel(useFileProgress(file && sending === undefined ? file : {}));
  const busy = sending !== undefined ? sending : progress;
  const shapeKey = file ? `${remote ?? 'local'}:${file.id}` : part?.url ? `${remote ?? 'local'}:${part.url}` : undefined;
  const [shape, setShape] = useState(() => (shapeKey ? mediaShapes.get(shapeKey) : undefined));
  useEffect(() => {
    if (!single || !src) return;
    const im = new Image();
    im.onload = () => {
      if (!im.naturalWidth || !im.naturalHeight) return;
      const next: [number, number] = [im.naturalWidth, im.naturalHeight];
      if (shapeKey) mediaShapes.set(shapeKey, next);
      setShape(next);
    };
    im.src = src;
    return () => { im.onload = null; };
  }, [single, src, shapeKey]);
  const [w, h] = shape ?? [4, 3];
  const box = single
    ? { style: { aspectRatio: `${w} / ${h}`, width: Math.round(Math.min(MAX_W, (MAX_H * w) / h)), maxWidth: '100%' }, className: 'rounded-[16px] squircle' }
    : { style: undefined, className: wide ? 'col-span-2 aspect-[2/1]' : 'aspect-square' };
  const action = 'flex size-7 items-center justify-center rounded-[8px] bg-black/55 text-white backdrop-blur-sm hover:bg-black/70';
  return (
    <div className={cn('group/pic relative overflow-hidden bg-surface-2', box.className)} style={box.style}>
      {src ? (
        <button type="button" aria-label="Open image" {...galleryProps(src, file?.name)} onClick={openGalleryAt} className="block size-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          <RevealImg src={src} alt={file?.name ?? ''} />
        </button>
      ) : null}
      {busy ? (
        <span role="status" className="absolute bottom-2 left-2 flex h-6 items-center gap-1.5 rounded-[8px] bg-black/55 px-2 text-note text-white tabular-nums backdrop-blur-sm">
          {sending === undefined ? <Spinner size={11} /> : null}{busy}
        </span>
      ) : file && sending === undefined ? (
        <span className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity duration-150 group-hover/pic:opacity-100 focus-within:opacity-100">
          <button type="button" aria-label="Open" title="Open" onClick={() => openInApp(file)} className={action}><Icon icon={ExternalLink} size={14} /></button>
          {remote ? (
            <button type="button" aria-label="Download" title="Save to this Mac’s Downloads folder" onClick={() => void downloadRemoteFile(file)} className={action}><Icon icon={Download} size={14} /></button>
          ) : file.path ? (
            <button type="button" aria-label="Show in Finder" title="Show in Finder" onClick={() => void native().showInFolder(file.path!)} className={action}><Icon icon={FolderOpen} size={14} /></button>
          ) : null}
        </span>
      ) : null}
    </div>
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

/** A file the bot made or sent: icon, name, size · type, Open / Reveal; songs and clips play inline, pictures show as themselves. */
/** `sending`: a file still on its way with a message sent from here ("Uploading…"): no link yet, so no actions. */
export function FileTile({ file, sending }: { file: FileAttachment; sending?: string }) {
  return isPictureFile(file) ? <ImageBox pictures={[{ file, sending }]} /> : <FileCard file={file} sending={sending} />;
}

function FileCard({ file, sending }: { file: FileAttachment; sending?: string }) {
  // a cloud computer's files come through its channel: re-render once their bytes are here
  useCloudFiles((s) => s.rev);
  const url = useFileSrc(sending !== undefined ? { url: '', mimeType: file.mimeType } : file);
  const remote = useRemoteComputer();
  const progress = progressLabel(useFileProgress(sending !== undefined ? {} : file));
  const busy = sending !== undefined ? sending : progress;
  const media = playable(file);
  const tile = (
    <div className="flex max-w-[420px] items-center gap-3 rounded-card border border-border-subtle bg-[color-mix(in_srgb,var(--ab-surface)_40%,transparent)] py-2 pr-2 pl-2.5">
      {/* a rounded square, like every row's thumbnail (two-line rows), not a circle */}
      <span className="squircle flex size-10 shrink-0 items-center justify-center rounded-control bg-surface-2 text-muted">
        <Icon icon={file.mimeType === 'application/pdf' || file.mimeType.startsWith('text/') ? FileText : media === 'audio' ? Music : media === 'video' ? Video : File} size={18} />
      </span>
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
      className="max-h-[280px] w-full rounded-card border border-border-subtle bg-black object-contain"
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
