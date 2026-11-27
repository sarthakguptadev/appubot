// Files open inside the app (2026-11-17, the owner's "inside the chat too, if it's an image and stuff then preview and
// open it inside only, no need to go outside, and for more stuff too"): one viewer for what the app can show by itself
// (fileKinds.ts `viewKind`): a picture, a clip, a sound, a bot's visual, Markdown as it reads, a CSV as a table, text
// and code as they are. `openInApp(file)` is what an Open button calls: the viewer for those, the file's own app only
// for what the app can't show (a Word file, a PDF, a zip). The viewer's head still offers the file's own app and
// where it is kept.
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { FileAttachment } from '@appubot/protocol';
import { parseCsv, fileTitle, viewKind, type ViewKind } from '@appubot/chat-core';
import { Download, ExternalLink, FolderSearch } from '../../components/ui/icons';
import { Button, Dialog, Spinner } from '../../components/ui';
import { native } from '../../lib/native';
import { openFile } from '../../lib/openFile';
import { SHOW_IN_FOLDER } from '../../lib/platform';
import { ChatMarkdown } from '../chat/Markdown';
import { VoiceNote as RareVoiceNote } from '../../components/rare/VoiceNote';
import { seedOf } from '../voice/VoiceNote';
import { PageViewerBody } from '../chat/PagePart';
import { ClipPlayer } from './ClipPlayer';
import { downloadRemoteFile, useFileSrc, useRemoteComputer } from '../cloud/remoteFiles';

export const useFileViewer = create<{ file: FileAttachment | null }>(() => ({ file: null }));
export const closeFileViewer = (): void => useFileViewer.setState({ file: null });

/** Open a file: in the app where the app can show it, else in its own app. */
export function openInApp(f: FileAttachment): void {
  if (viewKind(f)) useFileViewer.setState({ file: f });
  else openFile(f);
}

/** the most rows of a table drawn (the rest are in the file) */
const ROWS_MAX = 500;

/** A text file's words, read from where its picture would come from ('' while a remote computer's is on its way). */
function useText(src: string, on: boolean): { text: string | null; failed: boolean } {
  const [state, setState] = useState<{ text: string | null; failed: boolean }>({ text: null, failed: false });
  useEffect(() => {
    if (!on || !src) return;
    let alive = true;
    setState({ text: null, failed: false });
    fetch(src).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status))))).then(
      (text) => { if (alive) setState({ text, failed: false }); },
      () => { if (alive) setState({ text: null, failed: true }); },
    );
    return () => { alive = false; };
  }, [src, on]);
  return state;
}

function Table({ text, tab }: { text: string; tab: boolean }) {
  const rows = parseCsv(text, tab ? '\t' : undefined).filter((r) => r.some((c) => c.trim()));
  const [head, ...body] = rows;
  if (!head) return <p className="px-5 py-10 text-center text-ui text-muted">This file is empty.</p>;
  return (
    <div className="overflow-auto px-5 py-4">
      <table className="w-full border-collapse text-ui tabular-nums">
        <thead>
          <tr>{head.map((c, i) => <th key={i} className="border-b border-border px-2.5 py-1.5 text-left text-note font-medium whitespace-nowrap text-muted">{c}</th>)}</tr>
        </thead>
        <tbody>
          {body.slice(0, ROWS_MAX).map((r, i) => (
            <tr key={i}>{head.map((_, j) => <td key={j} className="selectable border-b border-border-subtle px-2.5 py-1.5 align-top text-fg">{r[j] ?? ''}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {body.length > ROWS_MAX ? <p className="pt-3 text-note text-muted">The first {ROWS_MAX} of {body.length} rows. Open it in its app for the rest.</p> : null}
    </div>
  );
}

function Body({ f, kind }: { f: FileAttachment; kind: ViewKind }) {
  const src = useFileSrc(f);
  const words = kind === 'markdown' || kind === 'table' || kind === 'text';
  const { text, failed } = useText(src, words);
  if (kind === 'page') return <PageViewerBody file={f} title={fileTitle(f)} />;
  // a remote computer's file that isn't here yet (a big one comes only when asked for)
  if (!src || (words && text === null && !failed)) {
    return <div className="flex h-60 items-center justify-center text-muted"><Spinner size={16} /></div>;
  }
  if (failed) return <p className="px-5 py-10 text-center text-ui text-muted">This file couldn’t be read here. Open it in its app instead.</p>;
  if (kind === 'image') return <div className="flex max-h-[calc(100vh-11rem)] items-center justify-center overflow-auto bg-[color-mix(in_srgb,var(--ab-fg)_4%,transparent)] p-4"><img src={src} alt={f.name} className="max-h-[calc(100vh-14rem)] max-w-full rounded-control object-contain" /></div>;
  if (kind === 'video') return <ClipPlayer src={src} shapeKey={f.id} autoPlay className="max-h-[calc(100vh-11rem)] rounded-none" />;
  if (kind === 'audio') return <div className="px-5 py-8"><RareVoiceNote src={src} duration={1} seed={seedOf(f.id)} bars={48} aria-label={`Play ${f.name}`} className="w-full" /></div>;
  if (kind === 'markdown') return <div className="max-h-[calc(100vh-11rem)] overflow-y-auto px-6 py-5"><ChatMarkdown text={text ?? ''} /></div>;
  if (kind === 'table') return <div className="max-h-[calc(100vh-11rem)] overflow-auto"><Table text={text ?? ''} tab={/\.tsv$/i.test(f.name)} /></div>;
  return <pre className="selectable max-h-[calc(100vh-11rem)] overflow-auto px-5 py-4 font-mono text-[12.5px] leading-[1.55] break-words whitespace-pre-wrap text-fg">{text}</pre>;
}

/** The app's one file viewer (mounted once, in ModalHost). */
export function FileViewer() {
  const file = useFileViewer((s) => s.file);
  const remote = useRemoteComputer();
  const kind = file ? viewKind(file) : null;
  return (
    <Dialog
      open={!!file && !!kind}
      onClose={closeFileViewer}
      size="xl"
      title={file ? fileTitle(file) : ''}
      bodyClassName="p-0!"
      footer={file ? (
        <>
          {remote
            ? <Button size="sm" variant="ghost" icon={Download} onClick={() => void downloadRemoteFile(file)}>Download</Button>
            : file.path ? <Button size="sm" variant="ghost" icon={FolderSearch} onClick={() => void native().showInFolder(file.path!)}>{SHOW_IN_FOLDER}</Button> : null}
          <Button size="sm" variant="secondary" icon={ExternalLink} onClick={() => openFile(file)}>Open in its app</Button>
        </>
      ) : null}
    >
      {file && kind ? <Body key={file.id} f={file} kind={kind} /> : null}
    </Dialog>
  );
}
