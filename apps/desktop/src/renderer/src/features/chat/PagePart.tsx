// A visual reply (the bot's `show_page`, T3 Code's visual replies): its page drawn in the chat in a sandboxed frame
// loaded from the gateway's `/pages/:id` with that page's own viewing key (`files.pageView`), never the app's token.
// The frame runs the page's scripts with no access to the app, its storage or the network (the response's policy);
// it reports its height and its links by postMessage, and links open in the browser.
// One card, the chat's own (2026-11-17, the owner's "a card inside another card, I don't want that … no heading, not
// even the click to expand button, just it inside, like a native look"): the reply bubble's fill and corners with the
// page filling it, no title bar and no Expand; the page's document lays flat a card it draws round itself and is set
// in the app's own face (`core/pageDocument.ts`, `&font=app`). Its title is the frame's label only.
// A remote computer's page (your AppuBot computer, a team's) is framed from this Mac's copy of it
// (features/cloud/remotePages.ts), brought through the computer's channel once it is connected and shown from then on
// even while the computer sleeps.
// Instant on the way back: where a page loads from is kept for the run (`usePageSrcs`), its height across launches
// (`pageHeights`, so the card opens at its size), and a frame leaving the chat is parked warm (framePool.ts), so a
// chat opened again shows its pages as they were, with no spinner, reload or jump.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { Part } from '@appubot/protocol';
import { Dialog, Spinner } from '../../components/ui';
import { localGatewayUrl, rpc } from '../../lib/gateway';
import { LruStore } from '../../lib/lruStore';
import { native } from '../../lib/native';
import { useIsDark } from '../../lib/theme';
import { useCloud } from '../cloud/cloudAccount';
import { useCloudLink } from '../cloud/cloudClient';
import { lostComputers } from '../cloud/remoteFileCore';
import { useRemoteComputer } from '../cloud/remoteFiles';
import { remotePagePath, type PageCopy } from '../cloud/remotePages';
import { FramePool } from './framePool';

type PagePart = Extract<Part, { type: 'page' }>;

/** the shortest a page's card gets (a line or two) */
const MIN_H = 56;
/** a page not measured yet opens this tall */
const FIRST_H = 240;
/** a page shows whole up to this tall (only a very long one scrolls inside its card) */
const MAX_H = 1600;
/** a page may ask to open a link at most this often (it can't open anything by itself) */
const OPEN_GAP_MS = 1000;
/** frames kept warm off screen for cards coming back */
const POOL_MAX = 8;

/** Where each page loads from this run (`<computer|local>:<file id>`), so a card coming back shows it at once. */
const usePageSrcs = create<Record<string, { path: string; tag: string }>>()(() => ({}));

/** each page's own height as it last reported it, kept across launches (a measurement only, never content) */
const pageHeights = new LruStore<number>('appubot.pageHeights', 600, (v): v is number => typeof v === 'number' && v > 0 && v < 1_000_000);

const fitHeight = (natural: number): number => Math.max(MIN_H, Math.min(MAX_H, natural));

/** Where the page loads from this run (its viewing key changes when the app restarts), and the id it reports under. */
export function usePageSrc(file: { id: string; name: string }, dark: boolean): { src: string | null | 'error'; tag: string; key: string } {
  const remote = useRemoteComputer();
  const team = useCloudLink((s) => s.team);
  // a remote page is fetched only while its computer is connected (never waking it); a copy already here shows at once
  const fetchable = useCloudLink((s) => s.conn === 'connected');
  const key = `${remote ?? 'local'}:${file.id}`;
  const got = usePageSrcs((s) => s[key]);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const done = (r: PageCopy | null) => { if (r) usePageSrcs.setState({ [key]: { path: r.path, tag: r.id } }); };
    const fail = () => { if (alive && !usePageSrcs.getState()[key]) setFailed(key); };
    // a remote page is asked again each time (the core answers from disk; a background check may find a newer copy)
    if (remote) remotePagePath(remote, team, file, { fetch: fetchable, onChanged: done }).then(done, fail);
    else if (!usePageSrcs.getState()[key]) rpc('files.pageView', { id: file.id }).then((r) => done({ path: r.path, id: file.id }), fail);
    return () => { alive = false; };
  }, [key, file.name, team, fetchable]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!got) return { src: failed === key ? 'error' : null, tag: file.id, key };
  // a remote computer's page loads from this Mac's own gateway (its copy), a local one from the computer on screen
  const url = localGatewayUrl(got.path);
  // `font=app`: the page is set in the window's own face (sent inside its document: a page has no network)
  return { src: url ? `${url}&theme=${dark ? 'dark' : 'light'}&font=app` : 'error', tag: got.tag, key };
}

/* ---------- warm frames ---------- */

let lot: HTMLDivElement | null = null;
/** off screen, hidden, still attached: where a parked frame waits (moving it keeps it loaded) */
function parkingLot(): HTMLDivElement {
  if (lot?.isConnected) return lot;
  lot = document.createElement('div');
  lot.setAttribute('aria-hidden', 'true');
  lot.style.cssText = 'position:fixed;left:-20000px;top:0;width:1px;height:1px;overflow:hidden;visibility:hidden;pointer-events:none;contain:strict';
  document.body.appendChild(lot);
  return lot;
}
type Movable = Element & { moveBefore?: (node: Node, child: Node | null) => void };
const canMove = (): boolean => typeof (Element.prototype as Movable).moveBefore === 'function';
const framePool = new FramePool<HTMLIFrameElement>(POOL_MAX, {
  canMove,
  park: (f) => { (parkingLot() as Movable).moveBefore!(f, null); },
  destroy: (f) => f.remove(),
});

// signed out, or off a team: that computer's pages leave the window too (core drops its copies on disk)
useCloud.subscribe((s, prev) => {
  const lost = lostComputers(prev.view, s.view);
  if (lost !== 'all' && !lost.length) return;
  framePool.clear();
  usePageSrcs.setState((st) => Object.fromEntries(Object.entries(st).filter(([k]) => k.startsWith('local:') || (lost !== 'all' && !lost.some((c) => k.startsWith(`${c}:`))))), true);
});

function newFrame(src: string, title: string): HTMLIFrameElement {
  const f = document.createElement('iframe');
  // aria-label, not title: an iframe's title shows as a hover tooltip over the page
  f.setAttribute('aria-label', title);
  // scripts only: no same-origin (so not the app's), no forms, popups or navigation of the app
  f.setAttribute('sandbox', 'allow-scripts');
  f.referrerPolicy = 'no-referrer';
  f.loading = 'lazy';
  f.className = 'block w-full border-0 bg-transparent';
  f.src = src;
  return f;
}

function PageFrame({ src, title, fileId, heightKey }: { src: string; title: string; fileId: string; heightKey: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  /** the page's own height, as it reported it; remembered, so the card opens at its size */
  const [natural, setNatural] = useState(() => pageHeights.peek(heightKey) ?? 0);
  const height = natural ? fitHeight(natural) : FIRST_H;
  /** taller than the card allows: only then may the frame scroll (otherwise no scrollbar, ever) */
  const tall = natural > MAX_H;

  // the frame: a warm one of this page when one is parked, else a new one; parked again when the card goes
  useLayoutEffect(() => {
    const h = host.current;
    if (!h) return;
    const warm = framePool.take(src);
    const el = warm ?? newFrame(src, title);
    el.style.width = '';
    if (warm && canMove()) {
      try { (h as Movable).moveBefore!(el, null); } catch { h.appendChild(el); }
    } else {
      h.appendChild(el);
    }
    setFrame(el);
    return () => {
      // parked at the width it had, so its page doesn't reflow (or re-measure) while it waits
      const w = el.getBoundingClientRect().width;
      if (w > 0) el.style.width = `${w}px`;
      framePool.release(src, el);
    };
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!frame) return;
    frame.style.height = `${height}px`;
    frame.setAttribute('scrolling', tall ? 'auto' : 'no');
  }, [frame, height, tall]);

  const lastOpen = useRef(0);
  useEffect(() => {
    if (!frame) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return;
      const d = e.data as { appubotPage?: string; height?: number; open?: string } | null;
      if (!d || d.appubotPage !== fileId) return;
      // +2: the page's own measure rounds down a fraction, which would leave a scrollbar for nothing
      if (typeof d.height === 'number' && d.height > 0) {
        const n = Math.ceil(d.height) + 2;
        setNatural(n);
        pageHeights.set(heightKey, n);
      }
      if (typeof d.open === 'string' && /^https?:\/\//i.test(d.open) && Date.now() - lastOpen.current > OPEN_GAP_MS) {
        lastOpen.current = Date.now();
        void native().openExternal(d.open);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frame, fileId, heightKey]);

  // the box holds the page's size from the first frame (its remembered height), so nothing below it jumps
  return <div ref={host} style={{ minHeight: height }} />;
}

/** The card a page sits in: the reply bubble's own fill, sheen and corners, as wide as the chat's column. */
const PAGE_CARD = 'chat-page my-1.5 w-full overflow-hidden rounded-[18px] bg-agent-bubble';

export function PagePart({ part }: { part: PagePart }) {
  const dark = useIsDark();
  const { src, tag, key } = usePageSrc(part.file, dark);
  const remembered = pageHeights.peek(key);
  return (
    <div className={PAGE_CARD}>
      {src === null ? (
        // waiting for its copy (a cloud computer's page seen for the first time): at the size it will have, if known
        <div className="flex items-center justify-center text-muted" style={{ height: remembered ? fitHeight(remembered) : 160 }}><Spinner size={16} /></div>
      ) : src === 'error' ? (
        <p className="px-3 py-6 text-center text-ui text-muted">This page can’t be shown here.</p>
      ) : (
        <PageFrame src={src} title={part.title} fileId={tag} heightKey={key} />
      )}
    </div>
  );
}

/**
 * A page opened by itself (the Files tab, where a visual is a tile): the same frame, live, in a dialog under its
 * title. The chat's own card has no such thing: there the page is already whole.
 */
export function PageViewer({ file, title, onClose }: { file: { id: string; name: string } | null; title: string; onClose: () => void }) {
  return (
    <Dialog open={!!file} onClose={onClose} size="xl" title={title} bodyClassName="p-0!">
      {file ? <PageViewerBody file={file} title={title} /> : null}
    </Dialog>
  );
}

/** A page by itself, live, on the reply bubble's fill (the file viewer shows a bot's visual with it). */
export function PageViewerBody({ file, title }: { file: { id: string; name: string }; title: string }) {
  const dark = useIsDark();
  const { src, tag, key } = usePageSrc(file, dark);
  return (
    <div className="chat-page max-h-[calc(100vh-11rem)] overflow-y-auto bg-agent-bubble">
      {src === null ? (
        <div className="flex h-60 items-center justify-center text-muted"><Spinner size={16} /></div>
      ) : src === 'error' ? (
        <p className="px-3 py-10 text-center text-ui text-muted">This page can’t be shown here.</p>
      ) : (
        <PageFrame src={src} title={title} fileId={tag} heightKey={key} />
      )}
    </div>
  );
}
