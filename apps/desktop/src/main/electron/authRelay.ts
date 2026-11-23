/**
 * Signing an agent in on another computer (your AppuBot computer) from this one, after T3 Code's ChatGPT handoff
 * (`packages/shared/src/codexAuthCallback.ts`). The agent's sign-in, run there, sends the browser back to
 * `http://localhost:<port>/callback` on that computer, where the agent listens. This listens on the same port here,
 * opens the link in this computer's browser (where the person is already signed in to Google, Claude…), takes the one
 * return that belongs to this sign-in (its path and `state`, one code or error), and hands its address to the window,
 * which sends it to the other computer (`providers.deviceLogin.finish`) to be replayed into the agent's listener.
 * Nothing is exchanged here: the agent's PKCE secret never leaves that computer, and the code is one-time.
 * No Electron imports, so it's tested as it is; ipc.ts wires it to `appubot:authRelay`.
 */
import { createServer, type Server } from 'node:http';
import { checkReturn, loopbackReturn } from '../core/services/authReturn';

/** what the window asks for: the sign-in link, and where it comes back to (port and path, from `DeviceLogin.relay`) */
export interface AuthRelayRequest { url: string; port: number; path: string }

/** a sign-in not finished in this long stops listening */
export const AUTH_RELAY_TIMEOUT_MS = 10 * 60_000;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>AppuBot</title><style>body{font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0}main{max-width:380px;padding:32px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{line-height:1.6;opacity:.7;margin:0}</style></head><body><main><h1>Back to AppuBot</h1><p>Your sign-in reached AppuBot, which is finishing it on your AppuBot computer. You can close this tab.</p></main></body></html>`;

const live = new Map<number, AbortController>();

/** Stops waiting for the sign-in that returns to `port` (the window's Cancel). */
export function cancelAuthRelay(port: number): void {
  live.get(port)?.abort();
}

/**
 * Listens for the sign-in's return on `port` here, opens its link in the browser, and resolves with the address it
 * came back to. Throws when the request doesn't hold together, the port is taken (another sign-in or app), the
 * browser can't open, it's cancelled, or nobody signs in within `timeoutMs`.
 */
export async function catchAuthReturn(req: AuthRelayRequest, openBrowser: (url: string) => Promise<void>, timeoutMs = AUTH_RELAY_TIMEOUT_MS): Promise<string> {
  const back = loopbackReturn(String(req.url));
  if (!back || back.port !== req.port || back.path !== req.path) throw new Error('This sign-in doesn’t come back to a computer.');
  if (live.has(back.port)) throw new Error('This sign-in is already open in your browser.');
  const abort = new AbortController();
  live.set(back.port, abort);
  let resolve!: (url: string) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<string>((ok, no) => { resolve = ok; reject = no; });
  void promise.catch(() => undefined);
  const got = { promise, resolve, reject };
  const servers: Server[] = [];
  const handle: Parameters<typeof createServer>[1] = (incoming, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      if (incoming.method !== 'GET') throw new Error('method');
      // what the browser came back to, as the other computer's agent expects it (its own host name, this port)
      const host = new URL(new URL(String(req.url)).searchParams.get('redirect_uri') ?? '').host;
      const url = checkReturn(`http://${host}${incoming.url ?? '/'}`, back);
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
      got.resolve(url.toString());
    } catch {
      // a favicon, another tab, a stale return: not this sign-in
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not this sign-in.');
    }
  };
  const listen = (host: string) => new Promise<void>((resolve, reject) => {
    const server = createServer(handle);
    server.once('error', reject);
    server.listen(back.port, host, () => { servers.push(server); resolve(); });
  });
  const timer = setTimeout(() => got.reject(new Error('The sign-in took too long. Start it again.')), timeoutMs);
  timer.unref?.();
  abort.signal.addEventListener('abort', () => got.reject(new Error('Cancelled.')), { once: true });
  try {
    try { await listen('127.0.0.1'); } catch { throw new Error(`Port ${back.port} on this computer is busy (another sign-in or app), so the sign-in can’t come back here. Paste the address it ends on instead.`); }
    // `localhost` may be looked up as ::1 first; that one is a bonus where the system has it
    await listen('::1').catch(() => undefined);
    await openBrowser(String(req.url));
    return await got.promise;
  } finally {
    clearTimeout(timer);
    live.delete(back.port);
    for (const s of servers) { s.closeAllConnections(); s.close(); }
  }
}
