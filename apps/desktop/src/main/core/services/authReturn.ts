/**
 * A sign-in that comes back to this computer: the agent (its CLI, or its ACP login) listens on a loopback port and the
 * provider's page sends the browser there (`http://localhost:<port>/callback?code=…&state=…`). When the person signs in
 * on another device, that return reaches us instead (the desktop app catches it on the same port on its own machine, a
 * phone pastes the address its browser ended on), and is replayed here into the agent's own listener, which then
 * finishes the sign-in itself: its PKCE secret never leaves this computer, and the code is one-time. After T3 Code's
 * remote sign-in (its ChatGPT handoff and Antigravity's pasted return).
 */
import { request } from 'node:http';

/** Where a sign-in link sends the browser back to, when that's this computer's loopback (else null). */
export interface LoopbackReturn {
  port: number;
  /** the listener's path (`/callback`) */
  path: string;
  /** the `state` the sign-in carries, which its return must carry back */
  state?: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The loopback address `authUrl` (an OAuth authorize link) returns to, or null when it returns anywhere else. */
export function loopbackReturn(authUrl: string): LoopbackReturn | null {
  let url: URL;
  try { url = new URL(authUrl); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const redirect = url.searchParams.get('redirect_uri');
  if (!redirect) return null;
  let back: URL;
  try { back = new URL(redirect); } catch { return null; }
  if (back.protocol !== 'http:' || !LOOPBACK.has(back.hostname) || !back.port || back.username || back.password) return null;
  const port = Number(back.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const state = url.searchParams.get('state') ?? undefined;
  return { port, path: back.pathname || '/', ...(state ? { state } : {}) };
}

/**
 * The address a person's browser came back to, checked against the sign-in it answers: loopback, the same port and
 * path, the same `state`, and exactly one `code` or one `error`. Browsers may hide `http://`, so it's added back.
 * Throws with words for the person when it doesn't belong.
 */
export function checkReturn(pasted: string, expect: LoopbackReturn): URL {
  const text = pasted.trim();
  if (!text || text.length > 16_384) throw new Error('Paste the whole address the sign-in page ended on.');
  let url: URL;
  try { url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `http://${text}`); } catch { throw new Error('That isn’t an address. Paste the whole address the sign-in page ended on.'); }
  const states = url.searchParams.getAll('state');
  const codes = url.searchParams.getAll('code');
  const errors = url.searchParams.getAll('error');
  const ok = url.protocol === 'http:' && LOOPBACK.has(url.hostname) && Number(url.port) === expect.port && url.pathname === expect.path
    && !url.username && !url.password && !url.hash
    && (expect.state === undefined || (states.length === 1 && states[0] === expect.state))
    && ((codes.length === 1 && !!codes[0] && errors.length === 0) || (errors.length === 1 && !!errors[0] && codes.length === 0));
  if (!ok) throw new Error('That address doesn’t belong to this sign-in. Start it again and paste the address its last page ended on.');
  return url;
}

/**
 * Hands a checked return to the agent's listener on this computer (`127.0.0.1`, then `::1`), as the browser would
 * have. Resolves once it answered (anything but a 4xx/5xx counts: listeners usually redirect to a "signed in" page).
 */
export async function deliverReturn(url: URL, timeoutMs = 15_000): Promise<void> {
  const path = `${url.pathname}${url.search}`;
  let last: unknown;
  for (const host of ['127.0.0.1', '::1']) {
    try {
      const status = await get(host, Number(url.port), path, url.host, timeoutMs);
      if (status >= 400) throw new Error(`The agent didn’t accept this sign-in (${status}). Start it again.`);
      return;
    } catch (e) {
      last = e;
      // the agent answered and refused: asking again at another address won't change that
      if (e instanceof Error && /didn’t accept/.test(e.message)) throw e;
    }
  }
  throw last instanceof Error && /didn’t accept/.test(last.message) ? last : new Error('The sign-in had already ended here. Start it again.');
}

function get(host: string, port: number, path: string, hostHeader: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    // no proxy, no redirects followed, nothing logged: a one-shot loopback call
    const req = request({ host, port, path, method: 'GET', agent: false, headers: { host: hostHeader } }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode ?? 0));
      res.once('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.once('error', reject);
    req.end();
  });
}
