// The side panel's Files tab: what the bots sent and what you attached, each shown as what it is (2026-11-17, the
// owner's "show visuals as visuals, not as HTML; the same for other stuff too"; rules in fileKinds.ts). A bot's page
// is a tile with the page itself in it, small and held still (`&still=1`), under its title, and opens in the app; a
// picture is its picture (the gallery), a clip its first frame (it plays in its tile), a song or recording the app's
// voice note player right in the list; only a document is a row with a file's name, its kind and size.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FileAttachment } from '@appubot/protocol';
import { bytes } from '@appubot/chat-core';
import { BarChart3, ChevronRight, Download, ExternalLink, File, FileText, FolderSearch, Image, Music, Paperclip, Play, Video, type IconComponent } from '../../components/ui/icons';
import { Button, EmptyState, Icon, RevealImg, Spinner, Tooltip, cn } from '../../components/ui';
import { PanelHeader, ROW_HOVER } from '../../components/layout/PanelChrome';
import { call } from '../../lib/actions';
import { native } from '../../lib/native';
import { openFile } from '../../lib/openFile';
import { SHOW_IN_FOLDER } from '../../lib/platform';
import { useIsDark } from '../../lib/theme';
import { selectSelectedBot, setState, useStore } from '../../lib/store';
import { VoiceNote as RareVoiceNote } from '../../components/rare/VoiceNote';
import { seedOf } from '../voice/VoiceNote';
import { galleryProps, openGalleryAt } from '../chat/imageGallery';
import { usePageSrc } from '../chat/PagePart';
import { useCloudFiles } from '../cloud/cloudClient';
import { downloadRemoteFile, progressLabel, useFileProgress, useFileSrc, useRemoteComputer } from '../cloud/remoteFiles';
import { fileKind, fileKindLabel, fileTitle, type FileKind } from './fileKinds';
import { openInApp } from './FileViewer';
import { activeComputer } from '../../lib/gateway';
import { remember } from '../../lib/remembered';

/** a tile's picture: the reply bubble's fill behind it, the panel's own corner; 4:3 two to a row, 2:1 where it takes
 * the whole row (a page, or a picture or clip alone), so it is a short card, never a poster */
const TILE_BOX = 'chat-page relative block aspect-[4/3] w-full overflow-hidden rounded-[14px] bg-agent-bubble';
const WIDE_BOX = 'chat-page relative block aspect-[2/1] w-full overflow-hidden rounded-[14px] bg-agent-bubble';
const TILE = 'group/tile flex w-full min-w-0 flex-col gap-1.5 rounded-[14px] text-left outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]';
const TILE_NAME = 'block truncate px-0.5 text-ui font-medium text-fg';

/** Where the file is kept, from a tile's corner (under the pointer): Finder, or a download from a remote computer. */
function TileActions({ f }: { f: FileAttachment }) {
  const remote = useRemoteComputer();
  if (!remote && !f.path) return null;
  const label = remote ? 'Download' : SHOW_IN_FOLDER;
  return (
    <span className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-focus-within/tile:opacity-100 group-hover/tile:opacity-100">
      <Tooltip label={label}>
        <span
          role="button"
          tabIndex={0}
          aria-label={`${label}: ${fileTitle(f)}`}
          onClick={(e) => { e.stopPropagation(); e.preventDefault(); if (remote) void downloadRemoteFile(f); else if (f.path) void native().showInFolder(f.path); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); if (remote) void downloadRemoteFile(f); else if (f.path) void native().showInFolder(f.path); } }}
          className="ab-pill grid size-7 place-items-center rounded-control bg-[color-mix(in_srgb,var(--ab-content)_78%,transparent)] text-fg-2 backdrop-blur-sm outline-none hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]"
        >
          <Icon icon={remote ? Download : FolderSearch} size={14} />
        </span>
      </Tooltip>
    </span>
  );
}

/** the page as it is laid out for its preview, then scaled to the tile (a page's tile takes the panel's whole width,
 * so this is about half size there: small enough to show the page, big enough to read its headings) */
const PAGE_W = 640;
const PAGE_H = 320;

/** A visual: the page itself in the tile, small and held still, under its title. */
function PageTile({ f }: { f: FileAttachment }) {
  const dark = useIsDark();
  const { src } = usePageSrc(f, dark);
  const box = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const title = fileTitle(f);
  return (
    <button type="button" onClick={() => openInApp(f)} className={TILE} aria-label={`Open ${title}`}>
      <span ref={box} className={WIDE_BOX}>
        {typeof src === 'string' && src !== 'error' && width > 0 ? (
          <iframe
            // a picture of the page, not the page: it takes no pointer or keyboard, and its document stops itself
            src={`${src}&still=1`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            loading="lazy"
            tabIndex={-1}
            aria-hidden
            scrolling="no"
            className="pointer-events-none absolute top-0 left-0 origin-top-left border-0 bg-transparent"
            style={{ width: PAGE_W, height: PAGE_H, transform: `scale(${width / PAGE_W})` }}
          />
        ) : src === 'error' ? (
          <span className="absolute inset-0 grid place-items-center text-muted"><Icon icon={FileText} size={20} /></span>
        ) : null}
        <TileActions f={f} />
      </span>
      <span className={TILE_NAME}>{title}</span>
    </button>
  );
}

/** A picture: itself, opening the gallery of every picture in the tab. */
function ImageTile({ f, wide }: { f: FileAttachment; wide?: boolean }) {
  const [broken, setBroken] = useState(false);
  // '' while a cloud computer's picture is still on its way (an empty src would count as broken)
  const src = useFileSrc(f);
  const title = f.caption?.trim() || f.name;
  if (broken) return <FileRow f={f} />;
  return (
    <button type="button" {...(src ? galleryProps(src, title) : {})} onClick={src ? openGalleryAt : undefined} className={cn(TILE, src && 'cursor-zoom-in')} aria-label={`Preview ${title}`}>
      <span className={wide ? WIDE_BOX : TILE_BOX}>
        <RevealImg src={src} cells={24} onError={() => setBroken(true)} className="absolute inset-0 size-full" imgClassName="size-full object-cover" />
        <TileActions f={f} />
      </span>
      <span className={TILE_NAME}>{title}</span>
    </button>
  );
}

/** A clip: its first frame with a play mark; a press plays it in its tile. */
function VideoTile({ f, wide }: { f: FileAttachment; wide?: boolean }) {
  const src = useFileSrc(f);
  const busy = progressLabel(useFileProgress(f));
  const [playing, setPlaying] = useState(false);
  const title = f.caption?.trim() || f.name;
  if (playing && src) {
    return (
      <div className={TILE}>
        <span className={cn(wide ? WIDE_BOX : TILE_BOX, 'bg-black')}>
          <video controls autoPlay src={src} className="absolute inset-0 size-full object-contain" />
        </span>
        <span className={TILE_NAME}>{title}</span>
      </div>
    );
  }
  return (
    // a remote computer's big clip isn't here until it is opened: then it opens in its own app
    <button type="button" onClick={() => (src ? setPlaying(true) : openFile(f))} className={TILE} aria-label={`Play ${title}`}>
      <span className={wide ? WIDE_BOX : TILE_BOX}>
        {src ? <video muted playsInline preload="metadata" src={src} className="absolute inset-0 size-full object-cover" /> : null}
        <span className="absolute inset-0 grid place-items-center">
          <span className="grid size-9 place-items-center rounded-full bg-[color-mix(in_srgb,var(--ab-content)_70%,transparent)] text-fg backdrop-blur-sm">
            {busy ? <Spinner size={14} /> : <Icon icon={Play} size={15} />}
          </span>
        </span>
        <TileActions f={f} />
      </span>
      <span className={TILE_NAME}>{title}</span>
    </button>
  );
}

/**
 * A song or recording: a row like any file's, and a press opens the app's own voice note player (Rare UI's, as voice
 * messages in the chat) right under it, playing, here in the panel: never a window of its own. A second press folds it
 * away. One plays at a time in the whole window; the bot's colour lights it.
 */
function AudioRow({ f }: { f: FileAttachment }) {
  const src = useFileSrc(f);
  const color = useStore((s) => selectSelectedBot(s)?.color);
  const remote = useRemoteComputer();
  const busy = progressLabel(useFileProgress(f));
  const seed = useMemo(() => seedOf(f.id), [f.id]);
  const [open, setOpen] = useState(false);
  return (
    <div className={cn('group rounded-[10px] px-2 py-1.5 transition-colors', !open && ROW_HOVER)}>
      <div className="flex items-center gap-2">
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[8px] text-left outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]" title={f.name}>
          <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-surface-2', open ? 'text-fg' : 'text-fg-2')}>
            <Icon icon={Music} size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-copy font-medium text-fg">{f.name}</span>
            <span className="block truncate text-note text-muted">
              {busy ? <span className="tabular-nums">{busy}</span> : <>{fileKindLabel(f)} · <span className="tabular-nums">{bytes(f.size)}</span></>}{f.caption ? ` · ${f.caption}` : ''}
            </span>
          </span>
        </button>
        <div className="hidden shrink-0 items-center gap-0.5 group-focus-within:flex group-hover:flex">
          {remote ? (
            <Tooltip label="Download">
              <Button variant="ghost" size="icon-sm" icon={Download} aria-label={`Download ${f.name}`} onClick={() => void downloadRemoteFile(f)} />
            </Tooltip>
          ) : f.path ? (
            <Tooltip label={SHOW_IN_FOLDER}>
              <Button variant="ghost" size="icon-sm" icon={FolderSearch} aria-label={`${SHOW_IN_FOLDER}: ${f.name}`} onClick={() => void native().showInFolder(f.path!)} />
            </Tooltip>
          ) : null}
        </div>
      </div>
      {open ? (
        <RareVoiceNote
          // a new file is a new player (its audio element and place start over)
          key={src || 'pending'}
          src={src || undefined}
          pending={!src}
          defaultPlaying
          // its length is read from the file; a recording that doesn't say one counts as a second
          duration={1}
          preload="metadata"
          seed={seed}
          bars={40}
          size="sm"
          accent={color}
          aria-label={`Play ${f.name}`}
          className="mt-2 w-full"
        />
      ) : null}
    </div>
  );
}

/** A document or a sound: its name, kind and size, with Open and where it is kept under the pointer. */
function FileRow({ f }: { f: FileAttachment }) {
  // in the app where it can be shown (text, Markdown, a table), else in its own app
  const open = () => openInApp(f);
  // a remote computer's file: Download (into this Mac's Downloads) instead of showing it in Finder
  const remote = useRemoteComputer();
  const busy = progressLabel(useFileProgress(f));
  const pdf = f.mimeType === 'application/pdf' || f.mimeType.startsWith('text/');
  return (
    <div className={cn('group flex items-center gap-2 rounded-[10px] px-2 py-1.5 transition-colors', ROW_HOVER)}>
      <button type="button" onClick={open} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[8px] text-left outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]" title={f.name}>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-surface-2 text-fg-2">
          <Icon icon={pdf ? FileText : File} size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-copy font-medium text-fg">{f.name}</span>
          <span className="block truncate text-note text-muted">
            {busy ? <span className="tabular-nums">{busy}</span> : <>{fileKindLabel(f)} · <span className="tabular-nums">{bytes(f.size)}</span></>}{f.caption ? ` · ${f.caption}` : ''}
          </span>
        </span>
      </button>
      {/* under the pointer only, and taking no room until then: the row runs to the panel's edge */}
      <div className="hidden shrink-0 items-center gap-0.5 group-focus-within:flex group-hover:flex">
        <Tooltip label="Open">
          <Button variant="ghost" size="icon-sm" icon={ExternalLink} aria-label={`Open ${f.name}`} onClick={open} />
        </Tooltip>
        {remote ? (
          <Tooltip label="Download">
            <Button variant="ghost" size="icon-sm" icon={Download} aria-label={`Download ${f.name}`} onClick={() => void downloadRemoteFile(f)} />
          </Tooltip>
        ) : f.path ? (
          <Tooltip label={SHOW_IN_FOLDER}>
            <Button variant="ghost" size="icon-sm" icon={FolderSearch} aria-label={`${SHOW_IN_FOLDER}: ${f.name}`} onClick={() => void native().showInFolder(f.path!)} />
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}

/** The Files tab's kinds, in this order, each a row that opens to show its files (the owner's call, 2026-11-18). */
const SECTIONS: readonly { kind: FileKind; label: string; icon: IconComponent }[] = [
  { kind: 'page', label: 'Visuals', icon: BarChart3 },
  { kind: 'image', label: 'Images', icon: Image },
  { kind: 'video', label: 'Videos', icon: Video },
  { kind: 'audio', label: 'Audio', icon: Music },
  { kind: 'file', label: 'Documents', icon: FileText },
];
/** which kinds are open, for the run (a tab switch or another bot keeps them as they were) */
const openKinds = new Set<FileKind>();

/** A kind's row: its icon, name and count, opening to its files under it. */
function Section({ sec, count, children }: { sec: (typeof SECTIONS)[number]; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(() => openKinds.has(sec.kind));
  const toggle = () => { const next = !open; if (next) openKinds.add(sec.kind); else openKinds.delete(sec.kind); setOpen(next); };
  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className={cn('flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]', ROW_HOVER)}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-surface-2 text-fg-2"><Icon icon={sec.icon} size={16} /></span>
        <span className="min-w-0 flex-1 truncate text-copy font-medium text-fg">{sec.label}</span>
        <span className="shrink-0 text-ui text-muted tabular-nums">{count}</span>
        <Icon icon={ChevronRight} size={15} className={cn('shrink-0 text-muted transition-transform duration-200 ease-rare', open && 'rotate-90')} />
      </button>
      {open ? <div className="pt-1 pl-1">{children}</div> : null}
    </section>
  );
}

/** Recent files sent or received by bots (live-updated via file.created). */
export function FilesPanel() {
  const files = useStore((s) => s.files);
  const [loading, setLoading] = useState(false);
  // read on this computer before: the kept list shows at once, and an empty one says so rather than spinning
  const readBefore = useStore((s) => !!s.remembered['loaded:files']);
  // a cloud computer's pictures and clips come through its channel: draw again once their bytes are here
  useCloudFiles((s) => s.rev);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const from = activeComputer();
    void call('files.list', { limit: 50 }, { errorTitle: 'Could not load files' }).then((list) => {
      if (!alive) return;
      setLoading(false);
      if (!list) return;
      remember('loaded:files', true, from);
      setState((s) => {
        const seen = new Set<string>();
        const merged: FileAttachment[] = [];
        // Live arrivals first (newest), then the listed page; dedupe by id.
        for (const f of [...s.files, ...list]) {
          if (seen.has(f.id)) continue;
          seen.add(f.id);
          merged.push(f);
        }
        return { files: merged.slice(0, 100) };
      });
    });
    return () => { alive = false; };
  }, []);

  const tile = (f: FileAttachment, wide: boolean): ReactNode => {
    const kind = fileKind(f);
    return kind === 'page' ? <PageTile f={f} /> : kind === 'video' ? <VideoTile f={f} wide={wide} /> : <ImageTile f={f} wide={wide} />;
  };

  return (
    <div className="flex h-full flex-col">
      <PanelHeader />
      <div className="flex-1 overflow-y-auto px-2.5 pb-4">
        {files.length === 0 ? (
          loading && !readBefore ? (
            <div className="flex justify-center py-10 text-muted"><Spinner size={18} /></div>
          ) : (
            <EmptyState
              icon={Paperclip}
              title="No files yet"
              body="Files your bots send you, and files you attach in a chat, show up here."
            />
          )
        ) : (
          // one gallery for every picture in the tab; the files by kind, each a row that opens to show them
          <div data-image-gallery className="ab-rise-list flex flex-col gap-1">
            {SECTIONS.map((sec) => {
              const items = files.filter((f) => fileKind(f) === sec.kind);
              if (!items.length) return null;
              return (
                <Section key={sec.kind} sec={sec} count={items.length}>
                  {sec.kind === 'audio' || sec.kind === 'file' ? (
                    <ul className="flex flex-col gap-px">
                      {items.map((f) => <li key={f.id}>{sec.kind === 'audio' ? <AudioRow f={f} /> : <FileRow f={f} />}</li>)}
                    </ul>
                  ) : (
                    // pictures and clips two to a row (a lone one across both); a visual across the whole row, where it reads
                    <ul className="grid grid-cols-2 gap-x-2.5 gap-y-3 px-1.5 pt-1 pb-2">
                      {items.map((f) => {
                        const wide = sec.kind === 'page' || items.length === 1;
                        return <li key={f.id} className={cn('min-w-0', wide && 'col-span-2')}>{tile(f, wide)}</li>;
                      })}
                    </ul>
                  )}
                </Section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
