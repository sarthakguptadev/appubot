import { arch, homedir, platform } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BotShape, UPLOAD_MAX, type CloudCreditSettings, type CloudInfo, type CloudState, type CloudTeamLogins, type PromoStatus, type SystemInfo } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { systemDirOf } from '../context';
import { RpcError, errMsg } from '../util';
import { writeFileAtomic } from '../store';
import { lanAdmitted } from './devices';

/** How often the Mac's addresses are checked for changes (a new Wi-Fi address, Tailscale turned on or off). */
const NETWORK_WATCH_MS = 15_000;

/** What the cloud computer's state file holds (`<dataDir>/cloud-state.json`): the backend's last word, kept across restarts; `logins` on a team's computer (§6.11). */
interface CloudStateFile { state: CloudState; resetsAt?: number; logins?: CloudTeamLogins; at: number }

export class SystemService {
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private offSettings: (() => void) | null = null;
  private lastHostsKey = '';
  /** an AppuBot Cloud computer's state (`SystemInfo.cloud`), as the backend set it last; absent elsewhere */
  private cloud: CloudStateFile | null = null;
  private cloudListeners = new Set<(info: CloudInfo, prev: CloudInfo | undefined) => void>();

  constructor(private ctx: CoreCtx) {
    if (ctx.deps.cloud) this.cloud = this.readCloudState();
  }

  /* ------------------------------------------------------- AppuBot Cloud */

  private cloudStatePath(): string { return join(systemDirOf(this.ctx.paths), 'cloud-state.json'); }

  /** The saved state, else `ok` (a fresh computer works until the backend says otherwise). */
  private readCloudState(): CloudStateFile {
    try {
      const raw = JSON.parse(readFileSync(this.cloudStatePath(), 'utf8')) as Partial<CloudStateFile>;
      // a file from the hour-limit days ('out-of-hours') is read as `ok`: plans have no limit any more
      if (raw.state === 'ok' || raw.state === 'on-hold' || raw.state === 'export-only') {
        return { state: raw.state, ...(typeof raw.resetsAt === 'number' ? { resetsAt: raw.resetsAt } : {}), ...(raw.logins === 'own' || raw.logins === 'shared' ? { logins: raw.logins } : {}), at: typeof raw.at === 'number' ? raw.at : Date.now() };
      }
    } catch { /* none yet */ }
    return { state: 'ok', at: Date.now() };
  }

  /** `SystemInfo.cloud`: on an AppuBot Cloud computer its state and public address; undefined elsewhere. */
  cloudInfo(): CloudInfo | undefined {
    const c = this.ctx.deps.cloud;
    if (!c || !this.cloud) return undefined;
    const logins = this.cloud.logins;
    const credit = this.ctx.s.credit?.status();
    const setup = this.ctx.s.agentSetup?.status();
    return {
      state: this.cloud.state, ...(this.cloud.resetsAt !== undefined ? { resetsAt: this.cloud.resetsAt } : {}), ...(c.publicUrl ? { publicUrl: c.publicUrl } : {}),
      // a team's computer (the backend said which logins it is on): the setting and the people whose devices are paired
      ...(logins ? { logins, members: this.ctx.s.devices.members() } : {}),
      // the included Claude credit (§6.13), while the plan has it
      ...(credit ? { credit } : {}),
      // Claude Code being set up at the first start (agentSetup.ts), until it's there
      ...(setup ? { agentSetup: setup } : {}),
    };
  }

  /** A team's computer: the logins setting (`CloudInfo.logins`), else none (a personal computer, a Mac). */
  cloudLogins(): CloudTeamLogins | undefined { return this.cloud?.logins; }

  /** Only a team's cloud computer sorts logins by person (`own`); everything else keeps one set (`shared` behaviour). */
  teamLoginsOwn(): boolean { return this.cloud?.logins === 'own'; }

  /** The cloud computer's state: `ok` everywhere but on a cloud computer the backend paused. */
  cloudState(): CloudState { return this.cloud?.state ?? 'ok'; }

  /** Whether turns and routines may run: always on a Mac; on the cloud only while the backend says `ok`. */
  cloudWorking(): boolean { return this.cloudState() === 'ok'; }

  /**
   * The backend's word (`POST /control/state`): saved, so a restart keeps it, and told to everyone (`system.updated`)
   * and to the services that pause on it (`onCloudState`: chat, routines, channels). Only on a cloud computer.
   */
  setCloudState(next: { state: CloudState; resetsAt?: number; logins?: CloudTeamLogins; credit?: CloudCreditSettings }): CloudInfo {
    if (!this.ctx.deps.cloud) throw new RpcError('unsupported', 'Not an AppuBot Cloud computer');
    const prev = this.cloudInfo();
    // the included credit rides along (§6.13): kept by its own service, which offers or takes away the AppuBot AI agent
    if (next.credit) this.ctx.s.credit?.apply(next.credit);
    const logins = next.logins ?? this.cloud?.logins;
    this.cloud = { state: next.state, ...(next.resetsAt !== undefined ? { resetsAt: next.resetsAt } : {}), ...(logins ? { logins } : {}), at: Date.now() };
    try { writeFileAtomic(this.cloudStatePath(), JSON.stringify(this.cloud), 0o600); } catch (e) { this.ctx.log.warn('saving the cloud state failed', errMsg(e)); }
    const info = this.cloudInfo()!;
    this.ctx.log.info(`cloud: state ${info.state}${info.resetsAt ? ` until ${new Date(info.resetsAt).toISOString()}` : ''}${info.logins ? `, logins ${info.logins}` : ''}`);
    for (const l of this.cloudListeners) {
      try { l(info, prev); } catch (e) { this.ctx.log.warn('cloud state listener failed', errMsg(e)); }
    }
    this.ctx.bus.emit('system.updated', this.info());
    return info;
  }

  /** The public address came (the backend's bootstrap): everyone hears the new `SystemInfo`. */
  cloudAddressChanged(): void {
    this.ctx.bus.emit('system.updated', this.info());
  }
  /** The credit changed (a heartbeat answer): everyone hears the new `SystemInfo.cloud.credit`. */
  cloudChanged(): void {
    if (this.ctx.deps.cloud) this.ctx.bus.emit('system.updated', this.info());
  }

  onCloudState(fn: (info: CloudInfo, prev: CloudInfo | undefined) => void): () => void {
    this.cloudListeners.add(fn);
    return () => this.cloudListeners.delete(fn);
  }

  /** Where paired phones can reach this Mac now (SystemInfo.gateway.candidates): none when the gateway is loopback-only. */
  candidates(): NonNullable<SystemInfo['gateway']['candidates']> {
    const g = this.ctx.s.settings.get().gateway;
    if (g.bind === 'loopback') return [];
    // AppuBot Connect isn't an address: its room and key ride SystemInfo.connect
    return this.ctx.s.tailscale.hostsNow(lanAdmitted(g)).map((h) => ({ ...h, port: this.ctx.gateway.port }));
  }

  /**
   * Re-sends `system.updated` whenever this Mac's reachable addresses change (DHCP gave it a new Wi-Fi address,
   * Tailscale went on or off, local-network access was switched), so connected phones save the new list. A change also
   * nudges AppuBot Connect: a relay socket that still looks open may have died with the old network.
   */
  watchNetwork(): void {
    if (this.watchTimer) return;
    this.lastHostsKey = JSON.stringify(this.candidates());
    const check = async () => {
      await this.ctx.s.tailscale.status().catch(() => undefined);
      const key = JSON.stringify(this.candidates());
      if (key === this.lastHostsKey) return;
      this.lastHostsKey = key;
      this.ctx.s.connect?.nudge('network changed');
      this.ctx.bus.emit('system.updated', this.info());
    };
    this.watchTimer = setInterval(() => { void check(); }, NETWORK_WATCH_MS);
    this.watchTimer.unref?.();
    this.offSettings = this.ctx.s.settings.onChange((next, prev) => {
      if (JSON.stringify(next.gateway) !== JSON.stringify(prev.gateway)) void check();
    });
  }

  stopWatching(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.offSettings?.();
    this.offSettings = null;
  }

  info(): SystemInfo {
    const power = this.ctx.s.power.status();
    const ts = this.ctx.s.tailscale.cached();
    const hosts = ['127.0.0.1', ...(ts.running ? [...ts.ips, ...(ts.dnsName ? [ts.dnsName] : [])] : []), ...this.ctx.s.tailscale.lanIps()];
    const candidates = this.candidates();
    return {
      version: this.ctx.deps.version,
      hostName: this.ctx.deps.hostName,
      platform: platform(),
      arch: arch(),
      homeDir: homedir(),
      dataDir: this.ctx.paths.dataDir,
      tailscale: { installed: ts.installed, running: ts.running, ips: ts.ips, dnsName: ts.dnsName, tailnet: ts.tailnet, loginName: ts.loginName },
      gateway: { port: this.ctx.gateway.port, hosts, candidates },
      uptimeSec: Math.round((Date.now() - this.ctx.startedAt) / 1000),
      ...(power ? { power } : {}),
      connect: this.ctx.s.connect?.info(),
      update: this.ctx.s.appUpdate.status(),
      ...(this.ctx.deps.cloud ? { cloud: this.cloudInfo() } : {}),
      ...(this.promoInfo()),
      // what a transfer may send here: the gateway's uploads and the channel's request bodies, the smaller
      transfer: { uploadMax: Math.min(UPLOAD_MAX, this.ctx.s.connect?.limits.requestBody ?? UPLOAD_MAX), groupRooms: true },
      groupPins: true,
      botShapes: [...BotShape.options],
    };
  }

  /** `SystemInfo.promo`: the free Claude day, while there is something to show (a person's own computer only) */
  private promoInfo(): { promo?: PromoStatus } {
    const promo = this.ctx.s.promo?.status();
    return promo ? { promo } : {};
  }

  async openPath(p: string): Promise<{ ok: true }> {
    if (!existsSync(p)) throw new RpcError('not_found', `Path does not exist: ${p}`);
    if (this.ctx.deps.openPath) await this.ctx.deps.openPath(p);
    else await this.ctx.deps.openExternal(isAbsolute(p) ? pathToFileURL(p).href : p);
    return { ok: true };
  }

  ping(): { pong: true; ts: number } { return { pong: true, ts: Date.now() }; }

  /**
   * Opening at login (`settings.launchAtLogin`, on by default). The first launch registers it; after that only the
   * Settings switch changes it, and a launch reads the OS's own state into the setting, so turning it off in System
   * Settings (or Windows' Startup apps) isn't overruled. `<dataDir>/login-item.json` marks that the first launch is done.
   */
  startLoginItem(): void {
    const item = this.ctx.deps.loginItem;
    if (!item) return;
    const marker = join(this.ctx.paths.dataDir, 'login-item.json');
    const apply = (on: boolean): void => {
      try {
        item.set(on);
        writeFileSync(marker, JSON.stringify({ on, at: Date.now() }));
        this.ctx.log.info(`open at login: ${on ? 'on' : 'off'}`);
      } catch (e) {
        this.ctx.log.warn('setting the login item failed', errMsg(e));
      }
    };
    const settings = this.ctx.s.settings;
    if (!existsSync(marker)) apply(settings.get().launchAtLogin);
    else {
      try {
        const on = item.get();
        if (on !== settings.get().launchAtLogin) settings.update({ launchAtLogin: on });
      } catch (e) { this.ctx.log.warn('reading the login item failed', errMsg(e)); }
    }
    settings.onChange((next, prev) => { if (next.launchAtLogin !== prev.launchAtLogin) apply(next.launchAtLogin); });
  }
}
