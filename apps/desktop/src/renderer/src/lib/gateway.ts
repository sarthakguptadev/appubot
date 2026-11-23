import { GatewayClient, GatewayError, uploadFile, type CallOptions, type ConnectionState } from '@appubot/client';
import { safeGatewayPath, type EventName, type FileAttachment, type MethodName, type MethodParams, type MethodResult, type Snapshot } from '@appubot/protocol';
import { native } from './native';
import { MACHINE } from './platform';

export type { CallOptions, ConnectionState };
export { GatewayError };

/** The subset of GatewayClient the renderer relies on (lets the dev mock stand in). */
export interface GatewayLike {
  state: ConnectionState;
  snapshot: Snapshot | null;
  connect(): void;
  close(): void;
  call<M extends MethodName>(method: M, params?: MethodParams<M>, opts?: CallOptions): Promise<MethodResult<M>>;
  onAny(fn: (event: EventName, payload: unknown, seq: number) => void): () => void;
  onState(fn: (s: ConnectionState, err?: string) => void): () => void;
  fileUrl(file: Pick<FileAttachment, 'url'> | string): string;
  /** stores a file in AppuBot (the dev mock's own; the real client goes through `POST /api/files`) */
  upload?(file: Blob, name: string): Promise<FileAttachment>;
}

let client: GatewayLike | null = null;
let pending: Promise<GatewayLike> | null = null;

/* ---------- which computer the window shows (features/cloud) ---------- */

/**
 * The computer whose bots the window shows: this Mac (`local`, the window's own gateway) or the user's AppuBot Cloud
 * computer (`cloud`, a second client over the end-to-end channel, features/cloud/cloudClient.ts). Everything that goes
 * through `gateway()` / `rpc()` talks to the one on screen; the cloud account itself (`cloudAccount.*`) is always the
 * Mac's (`localGateway()`).
 */
export type ComputerId = 'local' | 'cloud';
let cloud: GatewayLike | null = null;
let active: ComputerId = 'local';
const activeListeners = new Set<(id: ComputerId) => void>();

/** The Mac's own gateway (the cloud account, its sign-in and billing live there). */
export function localGateway(): GatewayLike {
  if (!client) throw new GatewayError('not_connected', 'Gateway not initialised');
  return client;
}
/** The cloud computer's client while there is one (made on first use, closed when not looked at). */
export function cloudGateway(): GatewayLike | null { return cloud; }
export function setCloudGateway(c: GatewayLike | null): void {
  cloud = c;
  if (!c && active === 'cloud') setActiveComputer('local');
}
export function activeComputer(): ComputerId { return active === 'cloud' && cloud ? 'cloud' : 'local'; }
export function setActiveComputer(id: ComputerId): void {
  const next: ComputerId = id === 'cloud' && cloud ? 'cloud' : 'local';
  if (next === active) return;
  active = next;
  for (const fn of activeListeners) { try { fn(next); } catch (e) { console.warn('[gateway] computer listener', e); } }
}
export function onActiveComputer(fn: (id: ComputerId) => void): () => void {
  activeListeners.add(fn);
  return () => { activeListeners.delete(fn); };
}

/** Create (once) the singleton gateway client. */
export function initGateway(): Promise<GatewayLike> {
  if (client) return Promise.resolve(client);
  if (pending) return pending;
  pending = (async () => {
    if (import.meta.env.VITE_APPUBOT_MOCK === '1') {
      const { createMockGateway } = await import('../dev/MockGateway');
      client = createMockGateway();
    } else {
      const api = native();
      const g = await api.getGateway();
      client = new GatewayClient({
        baseUrl: g.url,
        token: g.token,
        device: { id: g.deviceId, name: `This ${MACHINE}`, platform: 'desktop', appVersion: api.version },
        log: (...args: unknown[]) => console.warn('[gateway]', ...args),
      });
    }
    return client;
  })();
  return pending;
}

/** The gateway of the computer on screen (this Mac, or the cloud while the switcher is on Cloud). */
export function gateway(): GatewayLike {
  if (active === 'cloud' && cloud) return cloud;
  if (!client) throw new GatewayError('not_connected', 'Gateway not initialised');
  return client;
}

/** Typed RPC call. */
export function rpc<M extends MethodName>(method: M, params?: MethodParams<M>, opts?: CallOptions): Promise<MethodResult<M>> {
  return gateway().call(method, params, opts);
}

/** Stores a file in AppuBot (`POST /api/files`, not copied into any bot's inbox): a spoken message's recording. */
export function upload(file: Blob, name: string): Promise<FileAttachment> {
  return uploadTo(gateway(), file, name);
}

/** Stores a file on one computer (`POST /api/files`): the one a queued message goes to (lib/outbox.ts). */
export function uploadTo(g: GatewayLike, file: Blob, name: string): Promise<FileAttachment> {
  // the cloud's client brings its own (through the end-to-end channel: no token on any URL)
  if (g.upload) return g.upload(file, name);
  if (g instanceof GatewayClient) return uploadFile(g.baseUrl, g.token, file, name);
  return Promise.reject(new GatewayError('unsupported', 'Uploads are not available here'));
}

/**
 * A path on this Mac's own gateway as a URL, whichever computer is on screen: a remote computer's page is shown from
 * this Mac's copy of it (features/cloud/remotePages.ts). Null off the real gateway (the dev mock).
 */
export function localGatewayUrl(path: string): string | null {
  return client instanceof GatewayClient ? new URL(path, client.baseUrl + '/').toString() : null;
}

/**
 * Authenticated URL for a gateway file (or a passthrough for data:/http URLs). The owner token goes only on one of the
 * gateway's own paths (`safeGatewayPath`); anything else (another app's scheme, `//host`…, as a bot's tool output may
 * name) gets '' rather than the token.
 */
export function fileUrl(file: Pick<FileAttachment, 'url'> | string): string {
  const raw = typeof file === 'string' ? file : file.url;
  if (/^(data:|blob:|https?:)/.test(raw)) return raw;
  if (!safeGatewayPath(raw)) return '';
  const g = active === 'cloud' && cloud ? cloud : client;
  return g ? g.fileUrl(file) : raw;
}

/**
 * Where a link in a tool's output (`resource_link`) opens: a web address as it is (`url`, in the browser); one of
 * AppuBot's own files or pages (a gateway `/files/<id>` or `/pages/<id>` path) by its id (`fileId`: `files.open`, in its
 * own Mac app); anything else nowhere (null). A gateway URL never leaves the app: with the owner token on it, it would
 * land in the browser's history, sync and extensions.
 */
export function linkTarget(uri: string): { url: string } | { fileId: string } | null {
  if (/^https?:\/\//i.test(uri)) return { url: uri };
  const path = safeGatewayPath(uri);
  const m = path ? /^\/(?:files|pages)\/([^/?#]+)(?:[?#]|$)/.exec(path) : null;
  if (!m) return null;
  let id: string;
  try { id = decodeURIComponent(m[1]!); } catch { return null; }
  return /^[\w.-]+$/.test(id) ? { fileId: id } : null;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : 'Something went wrong';
}
