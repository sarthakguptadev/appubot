/**
 * How a phone reaches the Mac: classifying addresses (Tailscale, local network, loopback), and keeping the list of
 * candidate hosts a phone saves fresh. Shared by the desktop gateway (peer policy, the QR) and the phone (reconnects).
 */
import { type HostCandidate, type HostKind, type NetRoute } from './entities';

/** `::ffff:1.2.3.4` → `1.2.3.4`; drops brackets and an IPv6 zone (`%en0`); lower-cases. */
export function plainIp(ip: string | undefined | null): string {
  if (!ip) return '';
  const s = ip.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  return m ? m[1]! : s;
}

function v4(ip: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
  return parts.every((n) => n <= 255) ? parts : null;
}

/** First 16 bits of an IPv6 address, or null when it isn't one. */
function v6Head(ip: string): number | null {
  if (!ip.includes(':')) return null;
  const head = ip.split(':')[0]!;
  if (!head) return 0; // "::1", "::"
  return /^[0-9a-f]{1,4}$/.test(head) ? parseInt(head, 16) : null;
}

/**
 * This computer itself: an IPv4 literal in 127.0.0.0/8, the IPv6 loopback (`::1`, however written, an IPv4-mapped
 * 127.x too) or `localhost`. Only a real literal: a name that merely starts with `127.` (`127.0.0.1.example.com`) is a
 * host on the network like any other (a plain socket and tokened URLs go only to this computer).
 */
export function isLoopbackAddress(raw: string | undefined | null): boolean {
  const ip = plainIp(raw);
  if (ip === 'localhost') return true;
  const a = v4(ip);
  if (a) return a[0] === 127;
  const g = ip.includes(':') ? v6Groups(ip) : null;
  return !!g && g[7] === '1' && g.slice(0, 7).every((x) => x === '0');
}

/** Tailscale's address ranges: 100.64.0.0/10 (shared with carrier-grade NAT, so whois still checks) and fd7a:115c:a1e0::/48. */
export function isTailscaleAddress(raw: string | undefined | null): boolean {
  const ip = plainIp(raw);
  const a = v4(ip);
  if (a) return a[0] === 100 && a[1] >= 64 && a[1] <= 127;
  const parts = ip.split(':');
  return parts[0] === 'fd7a' && parts[1] === '115c' && parts[2] === 'a1e0';
}

/**
 * A private local-network address: 10/8, 172.16/12, 192.168/16, link-local 169.254/16, IPv6 link-local fe80::/10 and
 * unique-local fc00::/7 (Tailscale's own fd7a:115c:a1e0::/48 excluded). Never routed on the internet.
 */
export function isPrivateLanAddress(raw: string | undefined | null): boolean {
  const ip = plainIp(raw);
  const a = v4(ip);
  if (a) return a[0] === 10 || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && a[1] === 168) || (a[0] === 169 && a[1] === 254);
  const h = v6Head(ip);
  if (h === null || isTailscaleAddress(ip)) return false;
  return (h & 0xffc0) === 0xfe80 || (h & 0xfe00) === 0xfc00;
}

/** The 8 groups of an IPv6 address (hex, no leading zeros), or null when it isn't one. */
function v6Groups(ip: string): string[] | null {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const part = (h: string): string[] | null => {
    if (h === '') return [];
    const out: string[] = [];
    const bits = h.split(':');
    for (let i = 0; i < bits.length; i++) {
      const b = bits[i]!;
      if (i === bits.length - 1 && b.includes('.')) {
        const q = v4(b);
        if (!q) return null;
        out.push(((q[0] << 8) | q[1]).toString(16), ((q[2] << 8) | q[3]).toString(16));
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(b)) return null;
        out.push(parseInt(b, 16).toString(16));
      }
    }
    return out;
  };
  const head = part(halves[0]!);
  const tail = halves.length === 2 ? part(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array<string>(fill).fill('0'), ...tail];
}

/**
 * The address a per-address limit counts against: an IPv4 address as it is (an IPv4-mapped one unwrapped), an IPv6
 * address by its /64 (one home or phone usually gets a whole /64, and could otherwise take a fresh address per try);
 * anything else as it is, bounded. The relay counts the same way.
 */
export function addressKey(raw: string | undefined | null): string {
  const ip = plainIp(raw);
  if (!ip.includes(':')) return ip.slice(0, 64);
  const g = v6Groups(ip);
  return g ? `${g.slice(0, 4).join(':')}::/64` : ip.slice(0, 64);
}

/**
 * A gateway path a client may put its token on (`/files/<id>`, `/pages/<id>?v=…`), or null. Exactly one leading `/`, and
 * no backslash, whitespace or control character in it, nor in what it decodes to (`%2F`, `%5C`, `%09`…): `//host`,
 * `/\host`, a tab or newline the URL parser drops, or any scheme (`someapp://x`, `javascript:`) would point the URL, and
 * the token on it, at another host or app. No `.` or `..` segment either (`%2e` too): `/..//evil.com` resolves to
 * `//evil.com`, which a later parse takes for another host. A bot's tool output names links like these (`resource_link`).
 */
export function safeGatewayPath(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 4096 || /[\\\s\u0000-\u001f\u007f]/.test(url)) return null;
  let s = url;
  // decoded until it stops changing (a few rounds at most: more is someone hiding something)
  for (let round = 0; round < 4; round++) {
    if (s[0] !== '/' || s[1] === '/' || /[\\\u0000-\u001f\u007f]/.test(s)) return null;
    if (s.replace(/[?#].*$/, '').split('/').some((seg) => /^(?:\.|%2e){1,2}$/i.test(seg))) return null;
    let next: string;
    try { next = decodeURIComponent(s); } catch { return null; }
    if (next === s) return url;
    s = next;
  }
  return null;
}

/** What a direct host (an address or a name, as saved by the phone) is: MagicDNS names end in `.ts.net`; other names count as local. AppuBot Connect is tracked as a room id, not a host, so it never appears here. */
export function hostKind(host: string): HostKind {
  const h = plainIp(host);
  if (isLoopbackAddress(h)) return 'loopback';
  if (isTailscaleAddress(h)) return 'tailscale';
  if (/\.ts\.net\.?$/.test(h)) return 'magicdns';
  return 'lan';
}

export function routeOfKind(kind: HostKind): NetRoute {
  return kind === 'tailscale' || kind === 'magicdns' ? 'tailscale' : kind === 'loopback' ? 'local' : 'lan';
}

/** The route a direct connection to `host` takes (never `connect`: that route is the relay, not a host). */
export function hostRoute(host: string): NetRoute {
  return routeOfKind(hostKind(host));
}

/** `http://host:port` (an IPv6 address in brackets). */
export function hostUrl(host: string, port: number): string {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

/** The host part of a base URL (`http://[fd7a::1]:7890` → `fd7a::1`; a `connect://` URL's room), or '' when it doesn't parse. */
export function hostOfUrl(baseUrl: string): string {
  const m = /^[a-z]+:\/\/(\[[^\]]+\]|[^/:?#]+)/i.exec(baseUrl.trim());
  return m ? m[1]!.replace(/^\[|\]$/g, '') : '';
}

/**
 * AppuBot Connect as a base URL: `connect://<room>` (the room id from the QR). The phone saves it like any address,
 * and its client sends what would go to that URL through the relay, end to end encrypted, instead of over the network.
 */
export const CONNECT_URL_SCHEME = 'connect:';

export function connectUrl(connectId: string): string {
  return `connect://${connectId}`;
}

export function isConnectUrl(baseUrl: string): boolean {
  return /^connect:\/\//i.test(baseUrl.trim());
}

/** The room of a `connect://<room>[/path]` URL, or null when it isn't one. */
export function connectIdOfUrl(baseUrl: string): string | null {
  const m = /^connect:\/\/([^/?#]+)/i.exec(baseUrl.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** The route a base URL takes: `connect` for AppuBot Connect, else that of its host. */
export function urlRoute(baseUrl: string): NetRoute {
  return isConnectUrl(baseUrl) ? 'connect' : hostRoute(hostOfUrl(baseUrl));
}

/** `prefer` first (when it is one of them), then the others in their order; duplicates dropped. */
export function orderHosts(hosts: readonly string[], prefer?: string): string[] {
  const list = [...new Set(hosts.filter(Boolean))];
  if (prefer && list.includes(prefer)) return [prefer, ...list.filter((h) => h !== prefer)];
  return list;
}

/**
 * How good a route is, lower first: this computer, the same Wi-Fi, Tailscale, then AppuBot Connect (the relay, only
 * when no direct address answers).
 */
export function routeRank(route: NetRoute): number {
  return route === 'local' ? 0 : route === 'lan' ? 1 : route === 'tailscale' ? 2 : 3;
}

/** `hosts` best route first (the same Wi-Fi before Tailscale), `prefer` first among those of its route; duplicates dropped. */
export function orderByRoute(hosts: readonly string[], prefer?: string): string[] {
  return orderHosts(hosts, prefer)
    .map((h, i) => ({ h, i, r: routeRank(hostRoute(h)) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.h);
}

/** Most hosts a phone keeps for one Mac, and most local-network addresses kept once the Mac stops reporting them. */
export const MAX_SAVED_HOSTS = 12;
export const MAX_STALE_LAN_HOSTS = 2;

/**
 * The phone's new host list for a Mac, from what it had saved and what the Mac reports now (`SystemInfo.gateway
 * .candidates`): the Mac's current hosts first, in its order; then saved Tailscale hosts it didn't list (they never
 * change, and Tailscale may only be off for now); then up to MAX_STALE_LAN_HOSTS older local addresses (the Mac
 * may go back to that network), newest first. An empty report leaves the list as it was.
 */
export function mergeHosts(saved: readonly string[], fresh: readonly Pick<HostCandidate, 'host' | 'kind'>[]): string[] {
  const now = [...new Set(fresh.filter((c) => c.kind !== 'loopback' && c.host).map((c) => c.host))];
  if (!now.length) return [...saved];
  const old = saved.filter((h) => !now.includes(h) && hostKind(h) !== 'loopback');
  // Tailscale names don't change: kept until the computer stops reporting them for good
  const tailnet = old.filter((h) => hostRoute(h) === 'tailscale');
  const lan = old.filter((h) => hostRoute(h) === 'lan').slice(0, MAX_STALE_LAN_HOSTS);
  return [...new Set([...now, ...tailnet, ...lan])].slice(0, MAX_SAVED_HOSTS);
}

export function sameHosts(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((h, i) => h === b[i]);
}
