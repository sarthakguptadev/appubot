/**
 * The user's AppuBot account on their own computer (never on the cloud computer): the session (sealed with the
 * OS keychain where there is one, `<dataDir>/cloud-account.json` 0600), what the apps ask the backend for through this
 * core (`cloudAccount.*`, owner only: the account and the computer as last read, the catalog, checkout, portal and
 * account-page links, plan changes, pairing
 * this Mac to the cloud computer as its owner, desktop links, start, notices, the access log, export, delete), and the
 * cloud's notice counter every CLOUD_NOTICES_POLL_MS, raised as OS notifications ("Ada finished", "Ada needs you")
 * with no content while the window is hidden. Everything goes through `CloudApi` (packages/client), which checks the
 * backend's answers against protocol `cloud.ts`.
 *
 * Teams (Work plans): the account lists the teams this person is in; each team's shared
 * computer is one more target (`team` on every computer and billing method), paired as this person (an admin's
 * device is an owner there, a member's full), with its own connection and notice mark kept beside the personal one.
 *
 * Nothing needs this service: a phone talks to the backend itself with the same client and pairs as the owner of a
 * cloud computer bought on the web. `APPUBOT_CLOUD_FAKE` (dev) puts an in-process fake
 * backend behind it (`cloudFake.ts`).
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import {
  CLOUD_NOTICES_POLL_MS, CLOUD_SIGNED_IN_LINK, ConnectTicketResponseSchema, fromBase64Url, newId, toBase64Url, type ConnectTicketResponse,
  type CloudCreditSettings, type CloudPromo, type CloudAccountView, type CloudBackupList, type CloudRepairRequest, type CloudRepairResponse, type CloudTeam, type CloudTeamLogins, type CloudTeamRole, type CloudTeamView, type CloudCheckoutRequest, type CloudComputer, type CloudConnection, type CloudDevice, type CloudNotice, type CloudPairedDevice, type CloudPairedDevices, type CloudPlanChangePreview, type CloudPlanChangeRequest, type CloudPlanChangeResponse, type PairResponse,
} from '@appubot/protocol';
import { CloudApi, CloudApiError, cloudDirectUrl, directSession, relayFetch, startPkce, type RelayTransportCtor } from '@appubot/client';
import { cloudNoticeTitle, cloudOnlyInEffect, computerDisplayName, repairActive, workingClouds } from '@appubot/chat-core';
import type { CoreCtx } from '../context';
import { writeFileAtomic } from '../store';
import { CloudFakeBackend } from './cloudFake';
import { CloudCache } from './cloudCache';
import { CloudPages, type KeptPage } from './cloudPages';
import { errMsg, RpcError } from '../util';

/** where the backend lives unless `CoreDeps.cloudBackendUrl` says otherwise */
export const CLOUD_BACKEND_URL = 'https://account.appubot.com';
/** a sign-in started but not finished is forgotten after this long */
const SIGN_IN_TTL_MS = 15 * 60_000;
/**
 * How the view is kept fresh (every read is one backend request, `GET /v1/overview`, and Workers bill per request):
 * - `status()` (the window opening a page, coming to the front, reconnecting) answers from a view younger than
 *   VIEW_FRESH_MS, joins a read already running, and only otherwise reads;
 * - `status(true)` (a page watching something in progress, every few seconds) reads when the view is older than
 *   QUICK_FRESH_MS, so pages and triggers asking at once share one read;
 * - a change this core made (a plan change, a team change…) reads again at once (`refresh`);
 * - the timer reads every POLL_VISIBLE_MS while the window shows, every POLL_HIDDEN_MS while it is hidden and only
 *   when there is a computer whose notices to raise, never for an account with nothing to watch (`nothingToWatch`: no
 *   plan, team or invite), every POLL_BUSY_MS while something is in progress (setting up,
 *   waking, a repair, a checkout just made), and never while signed out (a refused session signs out);
 * - a failed read waits ERROR_BACKOFF_MS, doubling up to ERROR_BACKOFF_MAX_MS, before the next one.
 */
const VIEW_FRESH_MS = 60_000;
const QUICK_FRESH_MS = 3_000;
const POLL_VISIBLE_MS = CLOUD_NOTICES_POLL_MS;
const POLL_HIDDEN_MS = 5 * 60_000;
const POLL_BUSY_MS = 15_000;
const ERROR_BACKOFF_MS = 30_000;
const ERROR_BACKOFF_MAX_MS = 5 * 60_000;
/** after a checkout comes back, the plan and computer usually appear within this long: the timer reads quickly meanwhile */
const AFTER_CHECKOUT_MS = 3 * 60_000;
/** the catalog is read with the view at most this often */
const CATALOG_EVERY_MS = 60 * 60_000;
/** how long pairing over the channel may take: a sleeping cloud computer is woken by the connection (up to 3 min) */
const PAIR_TIMEOUT_MS = 200_000;

/** this Mac paired to a cloud computer: its device token (sealed when `sealed`) and what the window needs */
type StoredCloud = Omit<CloudConnection, 'token'> & { token: string; sealed: boolean };

/** The session file: the token sealed (`secretBox`) or plain where there is no keychain, the pairing, the notice mark. */
interface StoredAccount {
  token: string; sealed: boolean; email?: string; signedInAt: number;
  /** this Mac paired to the person's own cloud computer */
  cloud?: StoredCloud;
  /** each team's shared computer this Mac is paired to, and its notice mark (by team id; absent in files from before teams) */
  teams?: Record<string, { cloud?: StoredCloud; noticeSeq?: number }>;
  /** the id this Mac pairs as (made once, so a re-pair replaces the same device) */
  deviceId?: string;
  /** the last cloud notice raised here */
  noticeSeq?: number;
}

const ws: RelayTransportCtor = WebSocket as unknown as RelayTransportCtor;

export class CloudAccountService {
  private account: StoredAccount | null = null;
  private signIn: { state: string; verifier: string; at: number } | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  /** consecutive failed reads, and when the next may go */
  private failures = 0;
  private retryAt = 0;
  private lastTry = 0;
  /** a checkout came back: read quickly until then */
  private expectUntil = 0;
  /** backend requests made by reads (tests and the dev log count them) */
  readonly counts = { reads: 0 };
  private api: CloudApi;
  private fake: CloudFakeBackend | null = null;
  private pairIdentity: string | null = null;
  private view: CloudAccountView;
  private lastSent = '';
  private reading: Promise<CloudAccountView> | null = null;
  private again: Promise<CloudAccountView> | null = null;
  private catalogAt = 0;
  private catalogReading: Promise<Partial<CloudAccountView>> | null = null;
  /** the window's saved copies of the cloud computers' chats (`cacheGet`/`cacheSet`), bound to this account */
  readonly cache: CloudCache;
  /** pages bots showed on those computers, kept beside their file copies (`pageGet`/`pageSet`) */
  readonly pages: CloudPages;

  constructor(private ctx: CoreCtx) {
    this.account = this.read();
    // an install from before the id had a file of its own: written now, so it survives the next sign-out
    if (this.account?.deviceId && !ctx.deps.cloud) this.pairId();
    const deps = ctx.deps;
    if (deps.cloudFake && !deps.cloud) {
      this.fake = new CloudFakeBackend({
        state: deps.cloudFake.state, file: deps.cloudFake.file ?? join(ctx.paths.dataDir, 'cloud-fake.json'),
        pairing: async () => {
          const info = await ctx.s.devices.startPairing(300, { role: 'full' });
          return { code: info.code, key: info.connectKey ?? ctx.s.connect.key(), hosts: ['127.0.0.1'], port: ctx.gateway.port, hostName: `${deps.hostName} (cloud stand-in)`, publicUrl: `http://127.0.0.1:${ctx.gateway.port}`, expiresAt: info.expiresAt };
        },
        publicUrl: () => `http://127.0.0.1:${ctx.gateway.port}`,
        onChange: () => { void this.refresh().catch(() => undefined); },
        log: (m) => ctx.log.info(m),
      });
      ctx.log.info(`cloud: FAKE backend (state ${this.fake.state}); change it in ${deps.cloudFake.file ?? join(ctx.paths.dataDir, 'cloud-fake.json')}`);
    }
    this.api = new CloudApi({
      baseUrl: this.backendUrl, token: this.token(), fetch: this.fake?.fetch ?? deps.cloudFetch ?? deps.fetch,
      onUnauthorized: () => this.sessionRefused(),
    });
    this.view = { signedIn: !!this.account, paired: !!this.account?.cloud };
    // the last run's view, so the window's Account and Billing pages show at once while the first read runs
    const last = this.readLastView();
    if (last) { this.view = { ...last, signedIn: true, paired: !!this.account?.cloud }; this.restored = true; }
    // "Only in the cloud" follows both the setting and the account (a plan ending brings this computer back by itself)
    this.cloudOnlyWas = this.cloudOnly();
    ctx.s.settings?.onChange((next, prev) => { if (next.cloudOnly !== prev.cloudOnly) this.noteCloudOnly(); });
    const owner = () => (this.account ? { ...(this.account.email ? { email: this.account.email } : {}), ...(this.view.account?.id ? { id: this.view.account.id } : {}) } : null);
    this.cache = new CloudCache(ctx, owner);
    this.pages = new CloudPages({
      dataDir: ctx.paths.dataDir, owner, secretBox: deps.secretBox,
      viewKey: (id) => ctx.s.files.pageViewKey(id),
      capMb: () => ctx.s.settings.get().storage.cloudCopyMb,
      warn: (m, d) => ctx.log.warn(m, d),
    });
  }

  private get idFile(): string { return join(this.ctx.paths.dataDir, 'cloud-device.json'); }

  /**
   * The id this computer pairs as, made once per install and kept apart from the session: a cloud computer keeps a few
   * devices only (`PAIRED_DEVICES_MAX`) and gives a device pairing again its old place by this id, so it has to outlive
   * a sign-out and a session that ended. Kept with the session alone (as it was), every new sign-in was a new device
   * to the cloud computer, took another place there, and the third locked this computer out of it.
   */
  private pairId(): string {
    if (this.pairIdentity) return this.pairIdentity;
    let id = this.account?.deviceId;
    if (!id) {
      try {
        const raw = JSON.parse(readFileSync(this.idFile, 'utf8')) as { id?: unknown };
        if (typeof raw.id === 'string' && /^[\w-]{6,80}$/.test(raw.id)) id = raw.id;
      } catch { /* none yet */ }
    }
    id ??= newId('dev');
    try { writeFileAtomic(this.idFile, JSON.stringify({ id }), 0o600); } catch (e) { this.ctx.log.warn('saving this computer’s pairing id failed', errMsg(e)); }
    this.pairIdentity = id;
    return id;
  }

  /** the stored pairing of a target: the person's own computer, or a team's */
  private cloudOf(team?: string): StoredCloud | undefined {
    return team ? this.account?.teams?.[team]?.cloud : this.account?.cloud;
  }

  /** remember (or forget, `undefined`) a target's pairing */
  private setCloud(team: string | undefined, cloud: StoredCloud | undefined): void {
    if (!this.account) return;
    if (!team) { this.save({ ...this.account, cloud }); return; }
    const teams = { ...(this.account.teams ?? {}) };
    teams[team] = { ...(teams[team] ?? {}), cloud };
    if (!cloud) delete teams[team]!.cloud;
    this.save({ ...this.account, teams });
  }

  /* -------------------------------------------------------------- files */

  private get file(): string { return join(this.ctx.paths.dataDir, 'cloud-account.json'); }
  /** the last view read, sealed, so a launch shows it before its first read (never the session or any token) */
  private get viewFile(): string { return join(this.ctx.paths.dataDir, 'cloud-view.json'); }
  /** `view` is the last run's copy, not read yet this run */
  private restored = false;
  private savedView = '';

  private readLastView(): CloudAccountView | null {
    if (!this.account) return null;
    try {
      if (!existsSync(this.viewFile)) return null;
      const f = JSON.parse(readFileSync(this.viewFile, 'utf8')) as { v: number; email?: string; sealed: boolean; data: string };
      const json = f.v === 1 && typeof f.data === 'string' ? this.open(f.data, !!f.sealed) : null;
      const view = json ? (JSON.parse(json) as CloudAccountView) : null;
      // another account's (a sign-in since), or unreadable: dropped
      const email = this.account.email?.toLowerCase();
      if (!view?.account || (email && f.email && f.email.toLowerCase() !== email)) { rmSync(this.viewFile, { force: true }); return null; }
      const { signingIn: _s, error: _e, ...rest } = view;
      return rest;
    } catch {
      try { rmSync(this.viewFile, { force: true }); } catch { /* fine */ }
      return null;
    }
  }

  private saveLastView(): void {
    const v = this.view;
    if (!this.account || !v.account || !v.readAt || v.error) return;
    const { signingIn: _s, error: _e, ...rest } = v;
    const json = JSON.stringify(rest);
    if (json === this.savedView) return;
    this.savedView = json;
    const sealed = this.seal(json);
    try {
      writeFileAtomic(this.viewFile, JSON.stringify({ v: 1, ...(this.account.email ? { email: this.account.email } : {}), sealed: sealed.sealed, data: sealed.value }), 0o600);
    } catch (e) { this.ctx.log.warn('cloud: keeping the account view failed', errMsg(e)); }
  }

  private read(): StoredAccount | null {
    try {
      if (!existsSync(this.file)) return null;
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as StoredAccount;
      if (typeof raw.token !== 'string' || !raw.token) return null;
      return raw;
    } catch (e) {
      this.ctx.log.warn('reading the cloud account failed', errMsg(e));
      return null;
    }
  }

  private save(a: StoredAccount | null): void {
    const was = !!this.account;
    this.account = a;
    if (was !== !!a) {
      // pairing and AppuBot Connect follow the sign-in (ConnectService.wanted)
      queueMicrotask(() => { this.ctx.s.connect?.accountChanged(!!a); this.ctx.s.promo?.accountChanged(); });
    }
    try {
      if (!a) { if (existsSync(this.file)) rmSync(this.file); return; }
      writeFileAtomic(this.file, JSON.stringify(a), 0o600);
    } catch (e) { this.ctx.log.warn('saving the cloud account failed', errMsg(e)); }
  }

  private seal(plain: string): { value: string; sealed: boolean } {
    const box = this.ctx.deps.secretBox;
    if (!box) return { value: plain, sealed: false };
    try { return { value: box.encrypt(plain), sealed: true }; } catch (e) { this.ctx.log.warn('sealing a cloud token failed; kept as is', errMsg(e)); return { value: plain, sealed: false }; }
  }

  private open(value: string, sealed: boolean): string | null {
    if (!sealed) return value;
    try { return this.ctx.deps.secretBox?.decrypt(value) ?? null; } catch (e) { this.ctx.log.warn('opening a cloud token failed', errMsg(e)); return null; }
  }

  /** The session token in the clear, for a request; null when signed out (or the keychain can't open it). */
  private token(): string | null {
    const a = this.account;
    return a ? this.open(a.token, a.sealed) : null;
  }

  get backendUrl(): string { return (this.fake ? 'https://cloud.fake' : this.ctx.deps.cloudBackendUrl ?? CLOUD_BACKEND_URL).replace(/\/+$/, ''); }

  /** what this computer is called on the backend and on the cloud computer */
  private device(): CloudDevice {
    const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
    return { name: this.ctx.deps.hostName.slice(0, 80) || 'My computer', platform };
  }

  /**
   * A relay pass for this computer's AppuBot Connect key (protocol connectTicket.ts): what lets it use the hosted relay.
   * The Mac asks with its session; a cloud computer with its backend token. Null signed out, or when none can be had.
   */
  async connectTicket(edPublic: Uint8Array): Promise<ConnectTicketResponse | null> {
    const publicKey = toBase64Url(edPublic);
    const cloud = this.ctx.deps.cloud;
    try {
      if (cloud) {
        const f = this.ctx.deps.fetch ?? fetch;
        const res = await f(`${cloud.backendUrl.replace(/\/+$/, '')}/v1/connect/ticket`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cloud.backendToken}` },
          body: JSON.stringify({ publicKey }), signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) { this.ctx.log.warn(`connect: no relay pass (the backend answered ${res.status})`); return null; }
        const p = ConnectTicketResponseSchema.safeParse(await res.json());
        return p.success ? p.data : null;
      }
      if (!this.account) return null;
      return await this.api.connectTicket(publicKey);
    } catch (e) {
      this.ctx.log.warn('connect: no relay pass', errMsg(e));
      return null;
    }
  }

  /** Signed in to AppuBot here (an AppuBot Cloud computer is the account's own: always). Pairing and AppuBot Connect need it. */
  isSignedIn(): boolean { return !!this.ctx.deps.cloud || !!this.account; }

  /* ---------------------------------------------------- the free Claude day */

  /** whether a free Claude day is on (public: asked signed out too; `PromoService`) */
  promo(): Promise<CloudPromo> { return this.api.promo(); }
  /** this account's place in it: the pass-through's address and the day's token */
  startPromo(): Promise<CloudCreditSettings> {
    if (!this.account) throw new RpcError('sign_in_required', 'Sign in to AppuBot first.');
    return this.api.startPromo();
  }

  /* --------------------------------------------------------------- view */

  private notCloud(): void {
    if (this.ctx.deps.cloud) throw new RpcError('unsupported', 'Manage your AppuBot account from AppuBot on your phone or computer.');
  }

  private publish(next: Partial<CloudAccountView>): CloudAccountView {
    const merged = { ...this.view, ...next };
    const teams = merged.teams?.map((t) => ({ ...t, paired: !!this.cloudOf(t.team.id) }));
    this.view = { ...merged, ...(teams ? { teams } : {}), signedIn: !!this.account, paired: !!this.account?.cloud, ...(this.signingIn() ? { signingIn: true } : { signingIn: undefined }) };
    const json = JSON.stringify(this.view);
    if (json !== this.lastSent) { this.lastSent = json; this.ctx.bus.emit('cloudAccount.updated', this.view); }
    // a fresh read (or a sign-out) may say a computer isn't the person's any more: its saved chats go with it
    if ('readAt' in next || !this.view.signedIn) this.cache.prune(this.view);
    if (next.readAt) { this.restored = false; this.saveLastView(); }
    this.noteCloudOnly();
    return this.view;
  }

  /* ------------------------------------------------------- only in the cloud */

  private cloudOnlyWas = false;
  private cloudOnlyListeners = new Set<(on: boolean) => void>();

  /**
   * "Only in the cloud" holds on this computer (`settings.cloudOnly`, chat-core `cloudOnlyInEffect`): chosen here, and
   * the account as last read has an AppuBot computer that can work. The last run's view counts at launch, and a read
   * that fails keeps the last one, so a backend out of reach changes nothing; signed out, a plan ended or on hold, a
   * team left: false, and this computer's routines and Telegram bots run again. Never on an AppuBot computer.
   */
  cloudOnly(): boolean {
    if (this.ctx.deps.cloud) return false;
    return cloudOnlyInEffect({ chosen: !!this.ctx.s.settings?.get().cloudOnly, usable: workingClouds(this.view) });
  }

  /** Told when `cloudOnly()` changes (ChannelsService stops or starts this computer's Telegram bots). */
  onCloudOnlyChange(fn: (on: boolean) => void): () => void {
    this.cloudOnlyListeners.add(fn);
    return () => this.cloudOnlyListeners.delete(fn);
  }

  private noteCloudOnly(): void {
    const on = this.cloudOnly();
    if (on === this.cloudOnlyWas) return;
    this.cloudOnlyWas = on;
    this.ctx.log.info(on ? 'only in the cloud: this computer\'s routines and Telegram bots are paused' : 'only in the cloud no longer holds: this computer\'s routines and Telegram bots run again');
    for (const l of this.cloudOnlyListeners) {
      try { l(on); } catch (e) { this.ctx.log.warn('cloud-only listener failed', errMsg(e)); }
    }
  }

  private signingIn(): boolean { return !!this.signIn && Date.now() - this.signIn.at < SIGN_IN_TTL_MS; }

  /**
   * The view as last read, read again only when it is older than VIEW_FRESH_MS (`refresh`: QUICK_FRESH_MS); a read
   * already running is joined, and a backend that failed lately isn't asked again before its backoff. Never wakes the
   * computer.
   */
  async status(refresh = false): Promise<CloudAccountView> {
    this.notCloud();
    // signed out: the plans still show (the catalog is public), read at most hourly
    if (!this.account) return this.publish(await this.catalogIfStale());
    // the first ask of a launch gets the last run's view at once; the read it starts lands as `cloudAccount.updated`
    if (this.restored && !refresh) {
      void this.readIfOlder(VIEW_FRESH_MS).catch(() => undefined);
      return this.publish({});
    }
    return this.readIfOlder(refresh ? QUICK_FRESH_MS : VIEW_FRESH_MS);
  }

  /** a read unless the view is younger than `maxAge` (or one is running, or the backend is in its error backoff) */
  private readIfOlder(maxAge: number): Promise<CloudAccountView> {
    // a read already asked for: the one queued after the running one (it sees a change made meanwhile), else that one
    if (this.reading) return this.again ?? this.reading;
    const now = Date.now();
    if (this.view.readAt && now - this.view.readAt < maxAge) return Promise.resolve(this.publish({}));
    // after a failure: a quick ask may go after ERROR_BACKOFF_MS at most, anything else waits the whole backoff
    if (this.failures && now < Math.min(this.retryAt, maxAge <= QUICK_FRESH_MS ? this.lastTry + ERROR_BACKOFF_MS : Infinity)) return Promise.resolve(this.publish({}));
    return this.refresh();
  }

  /** Dodo's checkout came back (`appubot://cloud/checkout-done`): read now, and quickly for a while (the webhook may land after). */
  afterCheckout(): Promise<CloudAccountView> {
    this.expectUntil = Date.now() + AFTER_CHECKOUT_MS;
    this.schedule();
    return this.refresh();
  }

  /**
   * Reads the account, the computer, the teams and (now and then) the catalog; one read at a time, and a refresh asked
   * for while one runs gets one more read after it (a change made meanwhile isn't missed); an error keeps the last view.
   */
  refresh(): Promise<CloudAccountView> {
    if (this.reading) {
      const running = this.reading;
      this.again ??= running.catch(() => undefined).then(() => { this.again = null; return this.refresh(); });
      return this.again;
    }
    const p = this.doRefresh().finally(() => { if (this.reading === p) this.reading = null; });
    this.reading = p;
    return p;
  }

  /** the catalog when the last one is over CATALOG_EVERY_MS old (one read at a time; a failure waits 5 minutes) */
  private catalogIfStale(): Promise<Partial<CloudAccountView>> {
    if (Date.now() - this.catalogAt <= CATALOG_EVERY_MS) return Promise.resolve({});
    // a failed catalog read is tried again with a read 5 minutes on, not with every one
    this.catalogAt = Date.now() - CATALOG_EVERY_MS + 5 * 60_000;
    return this.catalogReading ??= this.api.catalog()
      .then((catalog) => { this.catalogAt = Date.now(); return { catalog }; })
      .catch((e: unknown) => { this.ctx.log.debug('cloud: reading the catalog failed', errMsg(e)); return {}; })
      .finally(() => { this.catalogReading = null; });
  }

  private async doRefresh(): Promise<CloudAccountView> {
    if (!this.account) return this.publish({ account: undefined, computer: undefined, teams: undefined, ...(await this.catalogIfStale()) });
    this.lastTry = Date.now();
    this.counts.reads += 1;
    try {
      // one request for the account, the computer and every team (an older backend: the client reads the parts)
      const o = await this.api.overview();
      const { account, computer } = o;
      const teams = this.takeTeams(account.teams?.map((t) => t.id) ?? [], o.teams, o.failedTeams ?? []);
      const next: Partial<CloudAccountView> = { account, computer, teams, error: undefined, readAt: Date.now() };
      Object.assign(next, await this.catalogIfStale());
      if (this.account?.email !== account.email) this.save({ ...this.account, email: account.email });
      this.failures = 0;
      const out = this.publish(next);
      await this.noticesFrom(computer);
      for (const t of teams) if (t.computer) await this.noticesFrom(t.computer, t.team);
      return out;
    } catch (e) {
      // a refused session already signed out (`sessionRefused`), with its own word on why
      if (!this.account) return this.publish({});
      this.failures += 1;
      this.retryAt = Date.now() + Math.min(ERROR_BACKOFF_MS * 2 ** (this.failures - 1), ERROR_BACKOFF_MAX_MS);
      return this.publish({ error: errMsg(e) });
    } finally {
      this.schedule();
    }
  }

  /**
   * The teams as the overview read them (a team that failed to read keeps what was read before, so one hiccup doesn't
   * empty the switcher); pairings of teams this person left are forgotten.
   */
  private takeTeams(ids: string[], read: { team: CloudTeam; computer?: CloudComputer }[], failed: string[]): CloudTeamView[] {
    const before = new Map((this.view.teams ?? []).map((t) => [t.team.id, t]));
    const got = new Map(read.map((t) => [t.team.id, t]));
    if (failed.length) this.ctx.log.debug(`cloud: reading team(s) ${failed.join(', ')} failed`);
    const out = ids.map((id): CloudTeamView | null => {
      const t = got.get(id);
      if (t) return { team: t.team, ...(t.computer ? { computer: t.computer } : {}), paired: !!this.cloudOf(id) };
      return before.get(id) ?? null;
    });
    const stale = Object.keys(this.account?.teams ?? {}).filter((id) => !ids.includes(id));
    if (stale.length && this.account) {
      const teams = { ...(this.account.teams ?? {}) };
      for (const id of stale) delete teams[id];
      this.save({ ...this.account, teams });
    }
    return out.filter((t): t is CloudTeamView => !!t);
  }

  /* ------------------------------------------------------------ sign-in */

  /**
   * Starts the browser sign-in: the backend's page (Firebase: Google, Apple, email + password) returns to
   * `appubot://cloud/signed-in?code&state`, which main hands to `finishSignIn` (electron/cloudLinks.ts); PKCE binds the
   * code to this computer.
   */
  async startSignIn(): Promise<{ url: string; state: string }> {
    this.notCloud();
    const pk = await startPkce(this.backendUrl, CLOUD_SIGNED_IN_LINK);
    this.signIn = { state: pk.state, verifier: pk.verifier, at: Date.now() };
    this.publish({});
    if (this.fake) {
      // no page to open: the fake signs in by itself a moment later
      const state = pk.state;
      setTimeout(() => { void this.finishSignIn({ code: 'fake', state }).catch((e) => this.ctx.log.warn('cloud fake: sign-in failed', errMsg(e))); }, 1200).unref?.();
    } else {
      await Promise.resolve(this.ctx.deps.openExternal(pk.url)).catch((e: unknown) => this.ctx.log.warn('cloud: could not open the sign-in page', errMsg(e)));
    }
    return { url: pk.url, state: pk.state };
  }

  /** The browser came back with a code: it is swapped for a session (the token never shows in a URL). */
  async finishSignIn(p: { code?: string; state?: string; error?: string }): Promise<CloudAccountView> {
    this.notCloud();
    const s = this.signIn;
    if (p.error) { this.signIn = null; this.publish({}); throw new RpcError('sign_in_failed', `Signing in to AppuBot didn’t finish: ${p.error}`); }
    if (!s || Date.now() - s.at > SIGN_IN_TTL_MS) throw new RpcError('sign_in_expired', 'The sign-in took too long. Start it again from Settings › Account.');
    if (!p.code || p.state !== s.state) throw new RpcError('sign_in_failed', 'That sign-in isn’t the one this computer started.');
    let r;
    try { r = await this.api.redeemGrant(p.code, s.verifier, this.device()); } catch (e) { throw this.wrap(e); }
    this.signIn = null;
    this.api.setToken(r.token);
    const sealed = this.seal(r.token);
    this.save({ token: sealed.value, sealed: sealed.sealed, email: r.session.account.email, signedInAt: Date.now(), deviceId: this.pairId(), noticeSeq: 0 });
    this.ctx.log.info(`cloud: signed in as ${r.session.account.email}`);
    this.publish({ account: r.session.account, error: undefined });
    this.startPolling();
    // startPolling's read is running: joined, not doubled
    return this.readIfOlder(0);
  }

  async signOut(): Promise<{ ok: true }> {
    this.notCloud();
    if (this.account) await this.api.signOut().catch((e) => this.ctx.log.info('cloud: sign-out call failed; forgetting the session anyway', errMsg(e)));
    this.forget();
    return { ok: true };
  }

  /** the backend answered 401: the session is gone (expired, revoked) */
  private sessionRefused(): void {
    if (!this.account) return;
    this.ctx.log.info('cloud: the session was refused; signed out');
    this.forget('Your AppuBot session ended. Sign in again from Settings › Account.');
  }

  private forget(error?: string): void {
    this.save(null);
    this.cache.clear();
    this.restored = false;
    this.savedView = '';
    try { rmSync(this.viewFile, { force: true }); } catch { /* gone next time */ }
    this.api.setToken(null);
    this.stopPolling();
    this.failures = 0;
    this.expectUntil = 0;
    this.publish({ account: undefined, computer: undefined, teams: undefined, readAt: undefined, error });
  }

  /* ------------------------------------------------------------ the API */

  private wrap(e: unknown): RpcError {
    if (e instanceof RpcError) return e;
    if (e instanceof CloudApiError) return new RpcError(e.code === 'network' ? 'cloud_unreachable' : e.code, e.message, e.retryAfter ? { retryAfter: e.retryAfter } : undefined);
    return new RpcError('cloud_error', errMsg(e));
  }

  private signedIn(): void {
    this.notCloud();
    if (!this.account || !this.api.signedIn) throw new RpcError('signed_out', 'Sign in to AppuBot first (Settings › Account).');
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    this.signedIn();
    try { return await fn(); } catch (e) { throw this.wrap(e); }
  }

  /** A hosted checkout for a plan at an interval, opened in the browser (the fake's isn't: there is no page). */
  async checkout(req: CloudCheckoutRequest): Promise<{ checkoutUrl: string; sessionId: string }> {
    const r = await this.call(() => this.api.checkout(req));
    if (!this.fake) await Promise.resolve(this.ctx.deps.openExternal(r.checkoutUrl)).catch(() => undefined);
    return r;
  }

  /** The web account page (the plan picker, Change plan, billing; a team's: its members, seats and plan), opened in the browser; the user signs in there with the same account. */
  async accountPage(team?: string): Promise<{ url: string }> {
    this.signedIn();
    const url = team ? `${this.backendUrl}/account/teams/${encodeURIComponent(team)}` : `${this.backendUrl}/account`;
    if (!this.fake) await Promise.resolve(this.ctx.deps.openExternal(url)).catch(() => undefined);
    return { url };
  }

  /** What a plan change would do (charged now, or when it applies). */
  previewPlanChange(req: CloudPlanChangeRequest & { team?: string }): Promise<CloudPlanChangePreview> {
    const { team, ...body } = req;
    return this.call(() => this.api.previewPlanChange(body, team));
  }

  /** Change the plan: an upgrade now with proration, a downgrade at the period's end; the view follows. */
  async changePlan(req: CloudPlanChangeRequest & { team?: string }): Promise<CloudPlanChangeResponse> {
    const { team, ...body } = req;
    const r = await this.call(() => this.api.changePlan(body, team));
    void this.refresh().catch(() => undefined);
    return r;
  }

  /** Call a scheduled downgrade off; the view follows. */
  async cancelPlanChange(team?: string): Promise<{ ok: true }> {
    await this.call(() => this.api.cancelPlanChange(team));
    void this.refresh().catch(() => undefined);
    return { ok: true };
  }

  /** The customer portal (invoices, card, cancel at period end), opened in the browser. */
  async portal(team?: string): Promise<{ url: string; expiresAt: number }> {
    const r = await this.call(() => this.api.portal(team));
    if (!this.fake) await Promise.resolve(this.ctx.deps.openExternal(r.url)).catch(() => undefined);
    return r;
  }

  /** A short-lived signed link to the computer's VNC socket for the window's own viewer (no page; nothing is opened in a browser). */
  desktopLink(team?: string): Promise<{ websocketUrl: string; expiresAt: number }> { return this.call(() => this.api.desktopLink(team)); }

  /** a target's computer as read just now goes into the view */
  private publishComputer(team: string | undefined, c: CloudComputer): void {
    if (!team) { this.publish({ computer: c, readAt: Date.now() }); return; }
    this.publish({ teams: (this.view.teams ?? []).map((t) => (t.team.id === team ? { ...t, computer: c } : t)) });
  }

  /** Wake the computer now (refused on hold / after the plan ended); the view follows. */
  async start(team?: string): Promise<CloudComputer> {
    const c = await this.call(() => this.api.start(team));
    this.publishComputer(team, c);
    return c;
  }

  notices(after: number, team?: string): Promise<{ seq: number; items: CloudNotice[] }> { return this.call(() => this.api.notices(after, team)); }
  accessLog(team?: string): Promise<{ items: { at: number; action: string; actor: 'system' | 'user' | 'support'; reason?: string }[] }> { return this.call(() => this.api.accessLog(team)); }

  /** Fix your computer: the saved copies Reset can go back to (owners; a team's admins). */
  backups(team?: string): Promise<CloudBackupList> { return this.call(() => this.api.backups(team)); }

  /**
   * Fix your computer: Update, Recover or Reset (the backend runs it; the window follows `computer.repair`). The
   * computer is read again at once so the view shows it queued.
   */
  async repair(req: CloudRepairRequest & { team?: string }): Promise<CloudRepairResponse> {
    const { team, ...body } = req;
    const r = await this.call(() => this.api.repair(body, team));
    try { this.publishComputer(team, await this.api.computer(team)); } catch { /* the next poll reads it */ }
    return r;
  }

  /** Wakes a live computer for "Download my bots" (the backend refuses one on hold or whose plan ended). */
  async exportStart(team?: string): Promise<CloudComputer> {
    const c = await this.call(() => this.api.exportStart(team));
    this.publishComputer(team, c);
    return c;
  }

  /* -------------------------------------------------------------- teams */

  /** a team change answered with the team: the view takes it at once, then reads everything again */
  private async teamCall(fn: () => Promise<CloudTeam>): Promise<CloudTeam> {
    const team = await this.call(fn);
    const known = (this.view.teams ?? []).some((t) => t.team.id === team.id);
    this.publish({ teams: known ? (this.view.teams ?? []).map((t) => (t.team.id === team.id ? { ...t, team } : t)) : [...(this.view.teams ?? []), { team, paired: !!this.cloudOf(team.id) }] });
    void this.refresh().catch(() => undefined);
    return team;
  }

  /** a team, fresh from the backend (members, seats, plan) */
  team(team: string): Promise<CloudTeam> { return this.teamCall(() => this.api.team(team)); }
  invite(team: string, email: string, role?: CloudTeamRole): Promise<CloudTeam> { return this.teamCall(() => this.api.invite(team, email, role)); }
  resendInvite(team: string, inviteId: string): Promise<CloudTeam> { return this.teamCall(() => this.api.resendInvite(team, inviteId)); }
  /** `dropSeat`: their seat goes too, at the next billing date */
  revokeInvite(team: string, inviteId: string, opts: { dropSeat?: boolean } = {}): Promise<CloudTeam> { return this.teamCall(() => this.api.revokeInvite(team, inviteId, opts)); }
  setMemberRole(team: string, memberId: string, role: CloudTeamRole): Promise<CloudTeam> { return this.teamCall(() => this.api.setMemberRole(team, memberId, role)); }
  removeMember(team: string, memberId: string, opts: { dropSeat?: boolean } = {}): Promise<CloudTeam> { return this.teamCall(() => this.api.removeMember(team, memberId, opts)); }
  renameTeam(team: string, name: string): Promise<CloudTeam> { return this.teamCall(() => this.api.renameTeam(team, name)); }
  /** admins: each person's own logins on the team's computer, or one shared set (§6.11); the backend tells the computer */
  setTeamLogins(team: string, logins: CloudTeamLogins): Promise<CloudTeam> { return this.teamCall(() => this.api.setTeamLogins(team, logins)); }
  acceptInvite(by: { inviteId?: string; token?: string }): Promise<CloudTeam> { return this.teamCall(() => this.api.acceptInvite(by)); }

  async declineInvite(inviteId: string): Promise<{ ok: true }> {
    await this.call(() => this.api.declineInvite(inviteId));
    await this.refresh();
    return { ok: true };
  }

  /** Leave a team (the last admin can't: the backend says so); this Mac's pairing to its computer is forgotten. */
  async leaveTeam(team: string): Promise<{ ok: true }> {
    await this.call(() => this.api.leaveTeam(team));
    if (this.account?.teams?.[team]) {
      const teams = { ...this.account.teams };
      delete teams[team];
      this.save({ ...this.account, teams });
    }
    this.publish({ teams: (this.view.teams ?? []).filter((t) => t.team.id !== team) });
    void this.refresh().catch(() => undefined);
    return { ok: true };
  }

  /**
   * Pair this computer to the cloud computer as its owner: the backend asks the cloud computer's control API for a
   * pairing and answers with the code, the pinned key and the public address; then, over the end-to-end channel at
   * `wss://<slug>.agent37.app/secure` (which wakes it), `POST /api/pair` as on the Wi-Fi. The device token stays here
   * (`cloudAccount.connection` hands it to the window, never to an event).
   */
  async pair(team?: string): Promise<{ paired: true; deviceId: string; replaced?: CloudPairedDevice[] }> {
    this.signedIn();
    const deviceId = this.pairId();
    // the person's own computer: this Mac as its owner; a team's: the backend decides by the person's role there
    // (the id it pairs as goes along: a cloud computer that is full makes room for a new device, never for one coming back)
    const p = await this.call(() => this.api.pair(this.device(), team ? undefined : 'owner', team, deviceId));
    const key = fromBase64Url(p.key);
    if (!key) throw new RpcError('cloud_error', 'AppuBot answered with a key this app can’t read.');
    const known = team ? this.view.teams?.find((t) => t.team.id === team)?.computer : this.view.computer;
    const publicUrl = known?.computer?.publicUrl ?? `https://${p.hosts[0] ?? ''}`;
    const session = directSession({ url: cloudDirectUrl(publicUrl), macKey: key, WebSocketImpl: ws, idleMs: 1000, requestTimeoutMs: PAIR_TIMEOUT_MS, log: (...a) => this.ctx.log.debug('cloud pair', a.map(String).join(' ')) });
    let res: PairResponse;
    try {
      const r = await relayFetch(session)(`${publicUrl}/api/pair`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: p.code, device: { id: deviceId, name: this.device().name, platform: 'desktop', appVersion: this.ctx.deps.version } }),
      });
      const body = (await res_json(r)) as PairResponse | { error?: string };
      // 409: it already keeps the most devices it allows. The window then offers to remove one through the account
      // (`devices`, `removeDevice`), since this computer can't reach the cloud computer's own Settings › Devices
      if (!r.ok || !('token' in body)) throw new RpcError(r.status === 409 ? 'device_limit' : 'pair_failed', ('error' in body && body.error) || `${team ? 'The team’s' : 'Your'} AppuBot computer answered ${r.status}.`);
      res = body;
    } catch (e) {
      if (e instanceof RpcError) throw e;
      throw new RpcError('cloud_unreachable', `Couldn’t reach ${team ? 'the team’s' : 'your'} AppuBot computer: ${errMsg(e)}`);
    } finally {
      session.close();
    }
    const sealed = this.seal(res.token);
    if (this.account) this.save({ ...this.account, deviceId });
    this.setCloud(team, { publicUrl, key: p.key, token: sealed.value, sealed: sealed.sealed, deviceId: res.deviceId, hostName: res.hostName || p.hostName, role: res.role === 'owner' ? 'owner' : 'full', pairedAt: Date.now(), ...(team ? { team } : {}) });
    this.ctx.log.info(`cloud: paired with ${res.hostName || p.hostName}${team ? ' (a team’s)' : ''} as ${res.role}`);
    this.publish({});
    // `replaced`: the devices the backend removed from a full computer to let this one in (the window says which)
    return { paired: true, deviceId: res.deviceId, ...(p.replaced?.length ? { replaced: p.replaced } : {}) };
  }

  /**
   * The devices paired with a cloud computer, read through the account (the backend asks the computer; it wakes), and
   * one of them removed: for when `pair` is refused with `device_limit`. On a team's computer, this person's own.
   */
  devices(team?: string): Promise<CloudPairedDevices> {
    this.notCloud();
    return this.call(() => this.api.pairedDevices(team));
  }

  removeDevice(id: string, team?: string): Promise<CloudPairedDevices> {
    this.notCloud();
    return this.call(() => this.api.removePairedDevice(id, team));
  }

  /** The window's saved copy of a cloud computer's chats (a file on this Mac: never the backend or the computer). */
  cacheGet(team?: string): { data: string; savedAt: number } | null {
    this.notCloud();
    return this.cache.get(team);
  }

  /** Keep the window's copy of a cloud computer's chats (`''` drops it); refused while signed out. */
  cacheSet(team: string | undefined, data: string): { ok: true } {
    this.notCloud();
    if (!this.account && data) throw new RpcError('not_signed_in', 'Sign in to your AppuBot account first.');
    this.cache.set(team, data);
    return { ok: true };
  }

  /** This Mac's copy of a page a bot showed on a cloud computer (never the backend or the computer). */
  pageGet(team: string | undefined, id: string): KeptPage | null {
    this.notCloud();
    return this.pages.get(team, id);
  }

  /** Keep a cloud computer's page as the window brought it; refused while signed out. */
  pageSet(team: string | undefined, id: string, html: string): KeptPage & { changed: boolean } {
    this.notCloud();
    if (!this.account) throw new RpcError('not_signed_in', 'Sign in to your AppuBot account first.');
    return this.pages.set(team, id, html);
  }

  /** How the window reaches the cloud computer's channel (null until paired). Owner only; never in an event. */
  connection(team?: string): CloudConnection | null {
    this.notCloud();
    const c = this.cloudOf(team);
    if (!c) return null;
    const token = this.open(c.token, c.sealed);
    if (!token) return null;
    return { publicUrl: c.publicUrl, key: c.key, token, deviceId: c.deviceId, hostName: c.hostName, role: c.role, pairedAt: c.pairedAt, ...(team ? { team } : {}) };
  }

  /* ----------------------------------------------------- notices, polling */

  /**
   * While signed in, the view is read on a timer (a backend read never wakes the computer): the meter and state stay
   * fresh, and new notices reach the user as OS notifications while the window is hidden (opening it shows the real
   * content). How often: see VIEW_FRESH_MS's note. Only on the user's own computer, only with an account.
   */
  startPolling(): void {
    if (this.polling || this.ctx.deps.cloud || !this.account) return;
    this.polling = true;
    void this.readIfOlder(QUICK_FRESH_MS).catch(() => undefined);
    this.schedule();
  }

  stopPolling(): void {
    this.polling = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /** something is under way whose end the person waits for: setting up, waking, a repair, a checkout just made */
  private inProgress(): boolean {
    if (Date.now() < this.expectUntil) return true;
    const moving = (c: CloudComputer | undefined) => !!c && (c.state === 'provisioning' || c.state === 'waking' || repairActive(c.repair));
    return moving(this.view.computer) || (this.view.teams ?? []).some((t) => moving(t.computer));
  }

  /**
   * Nothing on the account to keep an eye on: no computer or plan of their own, no team, no invite waiting, nothing in
   * progress (a free user on their Mac). The timer then reads nothing; opening Settings › Account or Billing, the
   * window's focus and a checkout's return still read (2026-11-07: before, every such user read every 2 minutes with
   * the window open, 240 requests a day for an answer that never changes).
   */
  private nothingToWatch(): boolean {
    if (this.inProgress() || this.hearsNotices()) return false;
    const v = this.view;
    return !v.computer?.plan && !v.account?.plan && !v.teams?.length && !v.account?.invites?.length && (v.computer?.state ?? 'none') === 'none';
  }

  /** a computer whose notices this Mac raises while hidden: the person's own, or a team's this Mac is paired to */
  private hearsNotices(): boolean {
    return !!this.view.computer?.computer || !!this.account?.cloud || Object.values(this.account?.teams ?? {}).some((t) => !!t.cloud);
  }

  private windowHidden(): boolean {
    const d = this.ctx.deps;
    return d.windowHidden ? d.windowHidden() : d.isAppFocused ? !d.isAppFocused() : false;
  }

  /**
   * The timer's next look (re-planned after every read): quick while something is in progress, every couple of minutes
   * while the window shows, seldom while it is hidden and only with notices to raise; it reads only when the view is
   * old by then (a read the window asked for meanwhile counts).
   */
  private schedule(): void {
    if (!this.polling) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const every = this.inProgress() ? POLL_BUSY_MS : this.windowHidden() ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (!this.polling || !this.account) return;
      const hidden = this.windowHidden();
      const maxAge = this.inProgress() ? POLL_BUSY_MS - 2_000 : hidden ? (this.hearsNotices() || this.cloudOnly() ? POLL_HIDDEN_MS - 5_000 : Infinity) : this.nothingToWatch() ? Infinity : POLL_VISIBLE_MS - 5_000;
      // hidden with no notices to raise, or nothing on the account to watch: nothing is read (the window asks for itself)
      if (maxAge === Infinity) { this.schedule(); return; }
      // a read reschedules when it ends; nothing to read: look again later
      if (this.reading || (this.view.readAt && Date.now() - this.view.readAt < maxAge)) { this.schedule(); return; }
      void this.readIfOlder(maxAge).catch(() => undefined).finally(() => { if (!this.pollTimer) this.schedule(); });
    }, every);
    this.pollTimer.unref?.();
  }

  shutdown(): void {
    this.stopPolling();
    this.fake?.close();
  }

  /** One look at the notices (the timer's, through `refresh`, or a test's). */
  async poll(): Promise<void> { await this.refresh(); }

  /** a target's notice mark: the person's own computer's, or a team's */
  private noticeMark(team?: string): number { return (team ? this.account?.teams?.[team]?.noticeSeq : this.account?.noticeSeq) ?? 0; }
  private setNoticeMark(team: string | undefined, seq: number): void {
    if (!this.account) return;
    if (!team) { this.save({ ...this.account, noticeSeq: seq }); return; }
    const teams = { ...(this.account.teams ?? {}) };
    teams[team] = { ...(teams[team] ?? {}), noticeSeq: seq };
    this.save({ ...this.account, teams });
  }

  private async noticesFrom(computer: CloudComputer, team?: CloudTeam): Promise<void> {
    if (!this.account) return;
    // a team's notices only once this Mac is paired to its computer (the person uses it from here)
    if (team && !this.cloudOf(team.id)) return;
    const id = team?.id;
    const last = this.noticeMark(id);
    // a counter that went backwards is a replaced computer: start from its new count
    if (computer.noticeSeq < last) this.setNoticeMark(id, 0);
    const from = this.noticeMark(id);
    if (computer.noticeSeq <= from) return;
    let r: { seq: number; items: CloudNotice[] };
    try { r = await this.api.notices(from, id); } catch (e) { this.ctx.log.debug('cloud: reading notices failed', errMsg(e)); return; }
    const hidden = this.ctx.deps.windowHidden?.() ?? !this.ctx.deps.isAppFocused?.();
    let seq = from;
    for (const n of r.items) {
      if (n.seq <= seq) continue;
      seq = n.seq;
      this.ctx.bus.emit('cloudAccount.notice', n);
      // only the bot's name and the kind, like a phone push with previews off; the window shows the rest
      // a team's computer is named: "Ada finished · Acme Cloud Computer"; the body says where: "On Sarthak’s Cloud Computer"
      const where = computerDisplayName(team ? { team: team.name } : { person: this.view.account?.name });
      const title = team ? `${cloudNoticeTitle(n.kind, n.bot)} · ${where}` : cloudNoticeTitle(n.kind, n.bot);
      if (hidden) this.ctx.s.notifications.notify({ title, body: `On ${where}`, level: n.kind === 'failed' ? 'error' : n.kind === 'needs-you' ? 'warning' : 'success' });
    }
    if (r.seq > seq) seq = r.seq;
    if (this.account && seq !== from) this.setNoticeMark(id, seq);
  }
}

async function res_json(r: Response): Promise<unknown> {
  const text = await r.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { error: text.slice(0, 200) }; }
}
