/** Tailscale CLI integration: status (IPs, MagicDNS name) and whois for peer verification. */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { delimiter, join } from 'node:path';
import { isPrivateLanAddress, type HostKind } from '@appubot/protocol';

export interface TailscaleStatus { installed: boolean; running: boolean; ips: string[]; dnsName?: string; tailnet?: string; loginName?: string }
export interface HostEntry { host: string; kind: HostKind }

const CANDIDATES = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];

function run(cmd: string, args: string[], timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, TERM: 'dumb' } }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

export class TailscaleService {
  private cli: string | null | undefined;
  private cache: { at: number; value: TailscaleStatus } | null = null;
  private whoisCache = new Map<string, { at: number; user: string | null }>();

  findCli(): string | null {
    if (this.cli !== undefined) return this.cli;
    const fromPath = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((d) => join(d, 'tailscale'));
    this.cli = [...CANDIDATES, ...fromPath].find((p) => existsSync(p)) ?? null;
    return this.cli;
  }

  async status(force = false): Promise<TailscaleStatus> {
    if (!force && this.cache && Date.now() - this.cache.at < 30_000) return this.cache.value;
    const value = await this.readStatus();
    this.cache = { at: Date.now(), value };
    return value;
  }

  /** Last known status without blocking (for snapshots). */
  cached(): TailscaleStatus {
    return this.cache?.value ?? { installed: this.findCli() !== null, running: false, ips: [] };
  }

  private async readStatus(): Promise<TailscaleStatus> {
    const cli = this.findCli();
    if (!cli) return { installed: false, running: false, ips: [] };
    try {
      const raw = JSON.parse(await run(cli, ['status', '--json'])) as {
        BackendState?: string; Self?: { TailscaleIPs?: string[]; DNSName?: string; UserID?: number };
        MagicDNSSuffix?: string; User?: Record<string, { LoginName?: string }>;
      };
      const self = raw.Self ?? {};
      const loginName = self.UserID !== undefined ? raw.User?.[String(self.UserID)]?.LoginName : undefined;
      return {
        installed: true,
        running: raw.BackendState === 'Running',
        ips: self.TailscaleIPs ?? [],
        dnsName: self.DNSName ? self.DNSName.replace(/\.$/, '') : undefined,
        tailnet: raw.MagicDNSSuffix || undefined,
        loginName,
      };
    } catch {
      return { installed: true, running: false, ips: [] };
    }
  }

  /** Returns the peer's login name, or null when the IP is not a known tailnet peer (cached 10 min). */
  async whois(ip: string): Promise<string | null> {
    const c = this.whoisCache.get(ip);
    if (c && Date.now() - c.at < 10 * 60_000) return c.user;
    const cli = this.findCli();
    let user: string | null = null;
    if (cli) {
      try {
        const raw = JSON.parse(await run(cli, ['whois', '--json', ip])) as { UserProfile?: { LoginName?: string }; Node?: { Name?: string } };
        user = raw.UserProfile?.LoginName ?? raw.Node?.Name ?? 'tailnet-peer';
      } catch { user = null; }
    }
    this.whoisCache.set(ip, { at: Date.now(), user });
    return user;
  }

  /** This Mac's private IPv4 addresses on the local network (Wi-Fi/Ethernet first), as a phone on the same network dials them. */
  lanIps(): string[] {
    return lanAddresses(networkInterfaces());
  }

  /**
   * Every address a paired phone may dial (the QR, `SystemInfo.gateway.candidates`): Tailscale's and the local
   * network's (when the gateway admits local peers, `lan`). From the cached status unless `fresh`.
   */
  async hosts(o: { lan?: boolean; fresh?: boolean } = {}): Promise<HostEntry[]> {
    const st = await this.status(o.fresh).catch(() => this.cached());
    return hostCandidates(st, o.lan ?? true ? this.lanIps() : []);
  }

  /** `hosts()` from the last known status, without waiting on the CLI. */
  hostsNow(lan = true): HostEntry[] {
    return hostCandidates(this.cached(), lan ? this.lanIps() : []);
  }
}

/** The local-network IPv4 addresses among `os.networkInterfaces()`: private ranges only, Wi-Fi/Ethernet (`en*`) first. */
export function lanAddresses(ifaces: ReturnType<typeof networkInterfaces>): string[] {
  const out: { ip: string; rank: number }[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (isTailscaleIp(a.address) || !isPrivateLanAddress(a.address) || a.address.startsWith('169.254.')) continue;
      // en0/en1: Wi-Fi and Ethernet; bridges (Internet Sharing, VMs) and other VPNs' tunnels after
      out.push({ ip: a.address, rank: /^en\d/.test(name) ? 0 : /^(bridge|utun|vmnet|vnic)/.test(name) ? 2 : 1 });
    }
  }
  return [...new Set(out.sort((a, b) => a.rank - b.rank).map((o) => o.ip))];
}

/**
 * The hosts a phone should know, in the order to try them. Tailscale's are included even while Tailscale is off on
 * this Mac (they never change and work again once it's back on, `tailscale status` still reports them), but go after
 * the local network's then; IPv6 Tailscale addresses go last (phones rarely need them).
 */
export function hostCandidates(st: TailscaleStatus, lanIps: readonly string[]): HostEntry[] {
  const v4 = st.ips.filter((ip) => !ip.includes(':')).map((host): HostEntry => ({ host, kind: 'tailscale' }));
  const v6 = st.ips.filter((ip) => ip.includes(':')).map((host): HostEntry => ({ host, kind: 'tailscale' }));
  const dns: HostEntry[] = st.dnsName ? [{ host: st.dnsName, kind: 'magicdns' }] : [];
  const lan = lanIps.map((host): HostEntry => ({ host, kind: 'lan' }));
  const list = st.running ? [...v4, ...dns, ...lan, ...v6] : [...lan, ...v4, ...dns, ...v6];
  const seen = new Set<string>();
  return list.filter((h) => !seen.has(h.host) && seen.add(h.host));
}

/* ---------- address helpers ---------- */
export function normalizeIp(ip: string | undefined): string {
  if (!ip) return '';
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip.replace(/%.*$/, '');
}

export function isLoopback(ipRaw: string | undefined): boolean {
  const ip = normalizeIp(ipRaw);
  return ip === '::1' || ip.startsWith('127.');
}

export function isTailscaleIp(ipRaw: string | undefined): boolean {
  const ip = normalizeIp(ipRaw).toLowerCase();
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (v4) {
    const a = Number(v4[1]); const b = Number(v4[2]);
    return a === 100 && b >= 64 && b <= 127; // 100.64.0.0/10
  }
  // fd7a:115c:a1e0::/48
  const parts = ip.split(':');
  return parts[0] === 'fd7a' && parts[1] === '115c' && parts[2] === 'a1e0';
}
