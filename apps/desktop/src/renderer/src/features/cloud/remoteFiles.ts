/**
 * A remote computer's files in this window (your AppuBot computer, a team's: whichever is on screen): thumbnails and
 * players from main's cache, Open (brought here, then opened in its own Mac app) and Download (into Downloads, shown
 * in Finder). The pure part is remoteFileCore.ts; main's cache is electron/remoteFiles.ts (`native().remoteFile`).
 *
 * The bytes come through the computer's end-to-end channel: the same `directSession` the cloud client runs on (one per
 * computer, so no second connection) with its device token, `GET /files/:id` (the phone's way).
 * A main older than this window (a dev reload) has no cache: the bytes stay here and Open/Download let the browser
 * engine save them.
 */
import { create } from 'zustand';
import { useEffect, useMemo } from 'react';
import { GatewayClient, cloudDirectUrl, directSession } from '@appubot/client';
import { fromBase64Url, type CloudConnection, type FileAttachment } from '@appubot/protocol';
import { cloudGateway, errorMessage, fileUrl } from '../../lib/gateway';
import { native } from '../../lib/native';
import { pushToast } from '../../lib/store';
import { cloudClientReady, cloudFileBlob, useCloudLink } from './cloudClient';
import { cloudConnection, useCloud } from './cloudAccount';
import { forgetLegacyPages } from './remotePages';
import { RemoteFileLoader, THUMB_EDGE, computerKey, lostComputers, previewable, refKey, remoteRef, type RemoteFileDeps, type RemoteProgress, type RemoteRef } from './remoteFileCore';
import { forgetShown } from '../../lib/imageCache';

export { progressLabel } from './remoteFileCore';

interface RemoteFilesState {
  /** files on their way, by `refKey` */
  progress: Record<string, RemoteProgress>;
  /** blob: URLs of pictures and clips shown, by `refKey` */
  srcs: Record<string, string>;
}
export const useRemoteFiles = create<RemoteFilesState>()(() => ({ progress: {}, srcs: {} }));

/** the team behind each cache name (`computerKey` folds a team id into a file-safe name) */
const teams = new Map<string, string | undefined>();
const teamOf = (ref: RemoteRef): string | undefined => teams.get(ref.computer);

/** The remote computer on screen as a cache name (null while this Mac is). */
export function remoteComputer(): string | null {
  const l = useCloudLink.getState();
  if (l.computer !== 'cloud') return null;
  const key = computerKey(l.team);
  teams.set(key, l.team);
  return key;
}
/** The same, as a hook (the cards' Reveal becomes Download on a remote computer). */
export function useRemoteComputer(): string | null {
  const computer = useCloudLink((s) => s.computer);
  const team = useCloudLink((s) => s.team);
  return useMemo(() => {
    if (computer !== 'cloud') return null;
    const key = computerKey(team);
    teams.set(key, team);
    return key;
  }, [computer, team]);
}

/** The dev mock's cloud is a stand-in client with no channel. */
const mock = (): boolean => import.meta.env.VITE_APPUBOT_MOCK === '1';

/** each computer's connection (token, address, key), read from this Mac's core at most once a minute */
const connections = new Map<string, { at: number; info: Promise<CloudConnection | null> }>();
function connectionOf(team: string | undefined): Promise<CloudConnection | null> {
  const k = team ?? '';
  const have = connections.get(k);
  if (have && Date.now() - have.at < 60_000) return have.info;
  const info = cloudConnection(team).catch(() => null);
  connections.set(k, { at: Date.now(), info });
  return info;
}

/** the client on screen is that computer's */
const onScreen = (ref: RemoteRef): boolean => {
  const l = useCloudLink.getState();
  return l.computer === 'cloud' && computerKey(l.team) === ref.computer;
};

const deps: Omit<RemoteFileDeps, 'disk'> = {
  connected: () => cloudGateway()?.state === 'connected',
  wake: async () => {
    const l = useCloudLink.getState();
    await cloudClientReady(l.team);
  },
  fetchBytes: async (ref, onProgress) => {
    const client = cloudGateway();
    if (mock() || (client && !(client instanceof GatewayClient))) {
      if (!client) throw new Error('Your AppuBot computer isn’t connected');
      return new Uint8Array(await (await cloudFileBlob(client, ref)).arrayBuffer());
    }
    const info = await connectionOf(teamOf(ref));
    const macKey = info ? fromBase64Url(info.key) : null;
    if (!info || !macKey || macKey.length !== 32) throw new Error('Your AppuBot computer isn’t ready to connect yet.');
    const session = directSession({ url: cloudDirectUrl(info.publicUrl), macKey, cloud: true });
    const res = await session.request(
      { method: 'GET', path: `/files/${encodeURIComponent(ref.id)}?download=1`, headers: { authorization: `Bearer ${info.token}` } },
      undefined, { onProgress },
    );
    if (res.status === 404) throw new Error('That file isn’t on the computer any more.');
    if (res.status !== 200) throw new Error(`The download failed (${res.status}).`);
    return res.body;
  },
  onProgress: (key, p) => useRemoteFiles.setState((s) => {
    const progress = { ...s.progress };
    if (p) progress[key] = p; else delete progress[key];
    return { progress };
  }),
};

/** main's cache, where this main has one (read on every use: absent until main is restarted after an update) */
function disk(): RemoteFileDeps['disk'] {
  const rf = native().remoteFile;
  if (typeof rf !== 'function') return null;
  return {
    cached: async (ref) => (await rf({ op: 'cached', ref })) as string | null,
    read: async (ref) => {
      const b = await rf({ op: 'read', ref });
      return b instanceof Uint8Array ? b : null;
    },
    save: async (ref, bytes) => (await rf({ op: 'save', ref, bytes })) as string,
  };
}
/**
 * A picture made at most THUMB_EDGE on its long edge (a JPEG stays a JPEG, anything else a WebP, keeping its alpha),
 * its shape noted for the chat's boxes; null when it is that small already (it is its own thumbnail).
 */
async function makeThumb(bytes: Uint8Array, mimeType: string): Promise<Uint8Array | null> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
  const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mimeType }));
  try {
    const long = Math.max(bmp.width, bmp.height);
    if (long <= THUMB_EDGE && bytes.length <= 600_000) return null;
    const scale = Math.min(1, THUMB_EDGE / long);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: /jpe?g/i.test(mimeType) ? 'image/jpeg' : 'image/webp', quality: 0.85 });
    const out = new Uint8Array(await blob.arrayBuffer());
    return out.length < bytes.length ? out : null;
  } finally {
    bmp.close();
  }
}

const loader = new RemoteFileLoader({ ...deps, makeThumb, get disk() { return disk(); } });

/* ---------- thumbnails and players ---------- */

const SRCS_MAX = 300;
/** previews asked for, and when one last failed (tried again after a while or when the computer connects) */
const previewing = new Set<string>();
const failedAt = new Map<string, number>();
const RETRY_MS = 30_000;

function showBytes(key: string, bytes: Uint8Array, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeType }));
  useRemoteFiles.setState((s) => {
    const srcs = { ...s.srcs, [key]: url };
    const keys = Object.keys(srcs);
    const dropped = new Set<string>();
    for (const k of keys.slice(0, Math.max(0, keys.length - SRCS_MAX))) {
      URL.revokeObjectURL(srcs[k]!);
      dropped.add(srcs[k]!);
      delete srcs[k];
    }
    if (dropped.size) forgetShown((src) => dropped.has(src));
    return { srcs };
  });
}

function loadPreview(ref: RemoteRef, mimeType: string): void {
  const key = refKey(ref);
  if (previewing.has(key) || useRemoteFiles.getState().srcs[key]) return;
  const failed = failedAt.get(key);
  if (failed && Date.now() - failed < RETRY_MS) return;
  previewing.add(key);
  void loader.show(ref, mimeType)
    .then((p) => { if (p) showBytes(key, p.bytes, p.mimeType); })
    .catch((e: unknown) => { failedAt.set(key, Date.now()); console.warn('[cloud] preview', ref.id, errorMessage(e)); })
    .finally(() => previewing.delete(key));
}

// a computer coming up (woken, reconnected) tries what couldn't be shown before
useCloudLink.subscribe((s, prev) => { if (s.conn === 'connected' && prev.conn !== 'connected') failedAt.clear(); });

/**
 * A file's picture or player source in the chat. This Mac's: its gateway URL as before. A remote computer's: from
 * main's cache, else fetched while the computer is up (never woken for it); '' until then.
 */
export function useFileSrc(file: Partial<Pick<FileAttachment, 'id' | 'name' | 'size'>> & Pick<FileAttachment, 'url' | 'mimeType'>): string {
  const computer = useRemoteComputer();
  const conn = useCloudLink((s) => s.conn);
  const ref = useMemo(() => (computer && !mock() ? remoteRef(computer, file) : null), [computer, file.id, file.url, file.name, file.size]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = ref ? refKey(ref) : null;
  const src = useRemoteFiles((s) => (key ? s.srcs[key] : undefined));
  const show = !!ref && previewable(file);
  useEffect(() => {
    if (ref && show && !src) loadPreview(ref, file.mimeType);
  }, [key, show, src, conn]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ref) return /^(data:|blob:|https?:)/.test(file.url) || computer === null || mock() ? fileUrl(file) : '';
  return src ?? '';
}

/** A file's progress while it comes over ("Waking…", "Downloading 45%"), for its card. */
export function useFileProgress(file: Partial<Pick<FileAttachment, 'id' | 'url'>>): RemoteProgress | null {
  const computer = useRemoteComputer();
  const ref = computer ? remoteRef(computer, { ...file, name: '' }) : null;
  return useRemoteFiles((s) => (ref ? s.progress[refKey(ref)] ?? null : null));
}

/* ---------- Open and Download ---------- */

/** The browser engine saves bytes where main can't (it asks where). */
function browserSave(bytes: Uint8Array, name: string, mimeType?: string): void {
  const href = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeType ?? '' }));
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

function refFor(file: Partial<Pick<FileAttachment, 'id' | 'url' | 'size'>> & { name: string }): RemoteRef | null {
  const computer = remoteComputer();
  return computer ? remoteRef(computer, file) : null;
}

async function bring(ref: RemoteRef): Promise<{ path?: string; bytes?: Uint8Array }> {
  // the person asked: a sleeping computer on screen is woken for it (another one's channel wakes it by itself)
  return loader.bring(ref, { wake: onScreen(ref) });
}

/** Open on a remote computer: brought to this Mac (progress on its card), then opened in its own app. */
export async function openRemoteFile(file: Partial<Pick<FileAttachment, 'id' | 'url' | 'size' | 'mimeType'>> & { name: string }): Promise<void> {
  const ref = refFor(file);
  if (!ref) return;
  try {
    const got = await bring(ref);
    const rf = native().remoteFile;
    if (got.path && typeof rf === 'function') await rf({ op: 'open', ref });
    else if (got.bytes) browserSave(got.bytes, ref.name, file.mimeType);
  } catch (e) {
    pushToast({ level: 'error', title: `Could not open ${file.name}`, body: errorMessage(e) });
  }
}

/** Download on a remote computer: brought to this Mac, put in Downloads and shown there in Finder. */
export async function downloadRemoteFile(file: Partial<Pick<FileAttachment, 'id' | 'url' | 'size' | 'mimeType'>> & { name: string }): Promise<void> {
  const ref = refFor(file);
  if (!ref) return;
  try {
    const got = await bring(ref);
    const rf = native().remoteFile;
    if (got.path && typeof rf === 'function') await rf({ op: 'download', ref });
    else if (got.bytes) browserSave(got.bytes, ref.name, file.mimeType);
  } catch (e) {
    pushToast({ level: 'error', title: `Could not download ${file.name}`, body: errorMessage(e) });
  }
}

/* ---------- forgetting ---------- */

// signed out, or off a team: that computer's copies leave this Mac (and the window's pictures of them)
useCloud.subscribe((s, prev) => {
  const lost = lostComputers(prev.view, s.view);
  if (lost !== 'all' && !lost.length) return;
  const rf = native().remoteFile;
  if (typeof rf === 'function') {
    for (const computer of lost === 'all' ? [undefined] : lost) void rf({ op: 'forget', ...(computer ? { computer } : {}) }).catch(() => undefined);
  }
  if (lost === 'all') connections.clear();
  for (const computer of lost === 'all' ? [undefined] : lost) forgetLegacyPages(computer);
  useRemoteFiles.setState((st) => {
    const srcs = { ...st.srcs };
    for (const k of Object.keys(srcs)) {
      if (lost === 'all' || lost.some((c) => k.startsWith(`${c}:`))) { URL.revokeObjectURL(srcs[k]!); const gone = srcs[k]!; forgetShown((src) => src === gone); delete srcs[k]; }
    }
    return { srcs };
  });
});
