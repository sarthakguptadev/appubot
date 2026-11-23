/**
 * The typed client for AppuBot Cloud's backend (account.appubot.com; protocol `cloud.ts`),
 * used by the Mac's core (`services/cloudAccount.ts`) and the phone. Plain fetch, zod-checked answers, errors as
 * `CloudApiError` with the backend's own code (`CloudErrorCode`) so callers can branch (on hold, plan ended…).
 * It holds a session token; the PKCE helpers make the apps' browser sign-in (§6.5: the page signs in with Firebase).
 */
import { z } from 'zod';
import {
  CLOUD_API_PREFIX, CLOUD_API_URL, CLOUD_CATALOG_VERSION, TIME_ZONE_HEADER, knownCatalogPlans, CLOUD_SIGNED_IN_LINK, CloudAccessLogSchema, CloudBackupListSchema, CloudRepairResponseSchema, CloudAccountSchema, CloudAuthTokenResponseSchema, CloudCatalogSchema, CloudCheckoutResponseSchema, CloudCreditSettingsSchema, CloudPromoSchema, CloudComputerSchema, CloudDesktopLinkSchema, CloudErrorSchema,
  ConnectTicketResponseSchema, type ConnectTicketResponse,
  CloudNoticesSchema, CloudOverviewSchema, CloudPairResponseSchema, CloudPairedDevicesSchema, CloudPlanChangePreviewSchema, CloudPlanChangeResponseSchema, CloudPortalResponseSchema, CloudSessionSchema, CloudTeamSchema,
  type CloudCreditSettings, type CloudPromo, type CloudBackupList, type CloudRepairRequest, type CloudRepairResponse, type CloudTeam, type CloudTeamLogins, type CloudTeamRole, type CloudAccessLog, type CloudAccount, type CloudAuthTokenResponse, type CloudCatalog, type CloudCheckoutRequest, type CloudCheckoutResponse, type CloudComputer, type CloudDesktopLink, type CloudDevice, type CloudErrorCode, type CloudPairedDevices, type CloudNotices, type CloudOverview, type CloudPairResponse, type CloudPlanChangePreview, type CloudPlanChangeRequest, type CloudPlanChangeResponse, type CloudPortalResponse, type CloudSession,
} from '@appubot/protocol';

/** how long `pair` may take: the backend wakes the computer and waits for its gateway before it asks for the code */
export const CLOUD_PAIR_WAIT_MS = 240_000;

export class CloudApiError extends Error {
  constructor(public code: CloudErrorCode | 'network' | 'bad_answer', message: string, public status: number, public retryAfter?: number) {
    super(message);
    this.name = 'CloudApiError';
  }
  /** the backend refused because of the computer's state: the apps explain instead of retrying */
  get isState(): boolean { return ['on_hold', 'export_only', 'suspended', 'not_ready', 'no_subscription'].includes(this.code); }
}

export interface CloudApiOptions {
  /** the backend's origin; default `CLOUD_API_URL` (staging: https://account-staging.appubot.com) */
  baseUrl?: string;
  /** the session token, if signed in already */
  token?: string | null;
  fetch?: typeof fetch;
  /** per request; a wake is never waited on here (the backend never wakes the computer) */
  timeoutMs?: number;
  /** called when a request answers 401: the session is gone */
  onUnauthorized?: () => void;
}

export class CloudApi {
  readonly baseUrl: string;
  private token: string | null;
  private fetchFn: typeof fetch;
  private timeoutMs: number;
  private onUnauthorized?: () => void;
  /** the backend answered `/overview` with 404 (one from before it): read the parts instead, for this client's life */
  private noOverview = false;

  constructor(opts: CloudApiOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? CLOUD_API_URL).replace(/\/$/, '');
    this.token = opts.token ?? null;
    // a plain function, never the global itself: some runtimes refuse `fetch` called as a method
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.onUnauthorized = opts.onUnauthorized;
  }

  get signedIn(): boolean { return !!this.token; }
  setToken(token: string | null): void { this.token = token; }

  /** This device's IANA time zone ("Asia/Kolkata"), or null where the runtime can't say. */
  static deviceTimeZone(): string | null {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return tz && /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(tz) ? tz : null;
    } catch { return null; }
  }

  private async call<T>(method: 'GET' | 'POST', path: string, schema: z.ZodType<T>, body?: unknown, opts: { auth?: boolean; timeoutMs?: number } = {}): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? this.timeoutMs);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth !== false && this.token) headers.authorization = `Bearer ${this.token}`;
    // this device's time zone: the backend keeps the owner's and the cloud computer's routines and clock follow it
    const tz = CloudApi.deviceTimeZone();
    if (tz) headers[TIME_ZONE_HEADER] = tz;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${CLOUD_API_PREFIX}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      throw new CloudApiError('network', `Couldn’t reach AppuBot’s account service: ${(e as Error).message}`, 0);
    } finally { clearTimeout(timer); }
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const err = CloudErrorSchema.safeParse(json);
      if (res.status === 401) this.onUnauthorized?.();
      if (err.success) throw new CloudApiError(err.data.error.code, err.data.error.message, res.status, err.data.error.retryAfter);
      throw new CloudApiError(res.status === 401 ? 'unauthorized' : 'internal', `AppuBot’s account service answered ${res.status}`, res.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new CloudApiError('bad_answer', `AppuBot’s account service answered in a shape this app doesn’t know (update AppuBot?): ${parsed.error.issues[0]?.message ?? ''}`, res.status);
    return parsed.data;
  }

  // --- sign-in (§6.5) ---
  /** a Firebase ID token (Google, Apple, email + password) straight for a session: scripts and the dev fakes */
  async signInWithFirebase(idToken: string, device: CloudDevice): Promise<CloudAuthTokenResponse> {
    const r = await this.call('POST', '/auth/firebase', CloudAuthTokenResponseSchema, { idToken, device }, { auth: false });
    this.token = r.token;
    return r;
  }
  /** the apps: the browser page's grant code plus the PKCE verifier for a session */
  async redeemGrant(code: string, codeVerifier: string, device: CloudDevice): Promise<CloudAuthTokenResponse> {
    const r = await this.call('POST', '/auth/token', CloudAuthTokenResponseSchema, { code, codeVerifier, device }, { auth: false });
    this.token = r.token;
    return r;
  }
  session(): Promise<CloudSession> { return this.call('GET', '/auth/session', CloudSessionSchema); }
  async signOut(): Promise<void> { try { await this.call('POST', '/auth/signout', okSchema, {}); } finally { this.token = null; } }

  // --- the account and the computer ---
  // Every computer and billing call takes an optional `team`: absent, the person's own cloud computer; a team's id,
  // that team's shared computer (`/v1/teams/:id/...`, §6.11; the backend checks the person is on it, and an admin for
  // billing).
  account(): Promise<CloudAccount> { return this.call('GET', '/account', CloudAccountSchema); }
  /**
   * The account, the person's own computer and each team with its computer in one request (`GET /v1/overview`). A
   * backend from before it is read the old way (account and computer, then each team and its computer), so callers
   * use this alone; a team that fails to read is named in `failedTeams` either way.
   */
  async overview(): Promise<CloudOverview> {
    if (!this.noOverview) {
      try { return await this.call('GET', '/overview', CloudOverviewSchema); } catch (e) {
        if (!(e instanceof CloudApiError && e.status === 404)) throw e;
        this.noOverview = true;
      }
    }
    const [account, computer] = await Promise.all([this.account(), this.computer()]);
    const failedTeams: string[] = [];
    const teams = (await Promise.all((account.teams ?? []).map(async ({ id }) => {
      try {
        const [team, computer] = await Promise.all([this.team(id), this.computer(id).catch(() => undefined)]);
        return { team, ...(computer ? { computer } : {}) };
      } catch { failedTeams.push(id); return null; }
    }))).filter((t): t is NonNullable<typeof t> => !!t);
    return { account, computer, teams, ...(failedTeams.length ? { failedTeams } : {}) };
  }
  /** the computer's state, plan and awake time; never wakes it */
  computer(team?: string): Promise<CloudComputer> { return this.call('GET', `${scope(team)}/computer`, CloudComputerSchema); }
  start(team?: string): Promise<CloudComputer> { return this.call('POST', `${scope(team)}/computer/start`, CloudComputerSchema, {}); }
  /** a pairing on the cloud computer (wakes it); the client then pairs over `/secure` with the pinned key */
  /** a pairing wakes a sleeping computer and waits for it (the backend polls its health for up to `CLOUD_PAIR_WAIT_MS`), so the call waits longer than the rest */
  /** `identity`: the id this device pairs as, so a computer that is full knows it from a new device (which takes the place of the one unused longest) */
  pair(device: CloudDevice, role?: 'owner' | 'full', team?: string, identity?: string): Promise<CloudPairResponse> { return this.call('POST', `${scope(team)}/computer/pair`, CloudPairResponseSchema, { device, ...(role ? { role } : {}), ...(identity ? { identity } : {}) }, { timeoutMs: CLOUD_PAIR_WAIT_MS }); }
  /**
   * The devices paired with the cloud computer, and one of them removed: for a device the computer refused as one too
   * many, which can't reach its Settings › Devices. Both wake the computer and wait for it like a pairing. A backend
   * from before answers 404.
   */
  pairedDevices(team?: string): Promise<CloudPairedDevices> { return this.call('GET', `${scope(team)}/computer/devices`, CloudPairedDevicesSchema, undefined, { timeoutMs: CLOUD_PAIR_WAIT_MS }); }
  /** a relay pass for this computer's AppuBot Connect key (`publicKey`: base64url), protocol connectTicket.ts */
  connectTicket(publicKey: string): Promise<ConnectTicketResponse> { return this.call('POST', '/connect/ticket', ConnectTicketResponseSchema, { publicKey }); }
  removePairedDevice(id: string, team?: string): Promise<CloudPairedDevices> { return this.call('POST', `${scope(team)}/computer/devices/remove`, CloudPairedDevicesSchema, { id }, { timeoutMs: CLOUD_PAIR_WAIT_MS }); }
  /** a 60 s signed noVNC link (counts as awake time) */
  desktopLink(team?: string): Promise<CloudDesktopLink> { return this.call('POST', `${scope(team)}/computer/desktop`, CloudDesktopLinkSchema, {}); }
  notices(after: number, team?: string): Promise<CloudNotices> { return this.call('GET', `${scope(team)}/computer/notices?after=${after}`, CloudNoticesSchema); }
  accessLog(team?: string): Promise<CloudAccessLog> { return this.call('GET', `${scope(team)}/computer/access-log`, CloudAccessLogSchema); }
  /** wakes a live computer for "Download my bots" (refused on hold or after the plan ended) */
  exportStart(team?: string): Promise<CloudComputer> { return this.call('POST', `${scope(team)}/computer/export-start`, CloudComputerSchema, {}); }
  /** Fix your computer (owners; a team's admins): its saved copies, newest first (an Agent37 read: never wakes it) */
  backups(team?: string): Promise<CloudBackupList> { return this.call('GET', `${scope(team)}/computer/backups`, CloudBackupListSchema); }
  /** Update, Recover or Reset; it runs on the backend and its progress rides `computer().repair` (a retry with the same `requestId` is the same repair) */
  repair(req: CloudRepairRequest, team?: string): Promise<CloudRepairResponse> { return this.call('POST', `${scope(team)}/computer/repair`, CloudRepairResponseSchema, req, { timeoutMs: 40_000 }); }

  // --- the free Claude day ---
  /** whether a free Claude day is on (public: a signed-out app asks too) */
  promo(): Promise<CloudPromo> { return this.call('GET', '/promo', CloudPromoSchema, undefined, { auth: false }); }
  /** this account's place in the free day: the pass-through's address and the day's token (the same one however often it is asked) */
  startPromo(): Promise<CloudCreditSettings> { return this.call('POST', '/promo/start', CloudCreditSettingsSchema, {}); }

  // --- billing (§6.6) ---
  /** the plans on sale with Dodo's prices (the apps never carry a price of their own) */
  catalog(): Promise<CloudCatalog> { return this.call('GET', `/billing/catalog?v=${CLOUD_CATALOG_VERSION}`, z.preprocess(knownCatalogPlans, CloudCatalogSchema) as z.ZodType<CloudCatalog>); }
  /** a hosted checkout for a plan at an interval (a Work plan with `members`: the buyer becomes the team's first admin) */
  checkout(req: CloudCheckoutRequest): Promise<CloudCheckoutResponse> { return this.call('POST', '/billing/checkout', CloudCheckoutResponseSchema, req); }
  portal(team?: string): Promise<CloudPortalResponse> { return this.call('POST', `${scope(team)}/billing/portal`, CloudPortalResponseSchema, {}); }
  /** what a plan change would do: charged now (an upgrade, more seats) or when it applies (a downgrade, fewer seats), and the computer's new size */
  previewPlanChange(req: CloudPlanChangeRequest, team?: string): Promise<CloudPlanChangePreview> { return this.call('POST', `${scope(team)}/billing/change-plan/preview`, CloudPlanChangePreviewSchema, req); }
  /** change the plan: an upgrade now with proration, a downgrade at the period's end */
  changePlan(req: CloudPlanChangeRequest, team?: string): Promise<CloudPlanChangeResponse> { return this.call('POST', `${scope(team)}/billing/change-plan`, CloudPlanChangeResponseSchema, req); }
  /** call a scheduled downgrade off */
  cancelPlanChange(team?: string): Promise<{ ok: true }> { return this.call('POST', `${scope(team)}/billing/change-plan/cancel`, okSchema, {}); }

  // --- teams (§6.11) ---
  team(team: string): Promise<CloudTeam> { return this.call('GET', `/teams/${enc(team)}`, CloudTeamSchema); }
  renameTeam(team: string, name: string): Promise<CloudTeam> { return this.call('POST', `/teams/${enc(team)}/rename`, CloudTeamSchema, { name }); }
  /** admins: how the team's computer signs agents in: each person's own logins (`own`), or one shared set (`shared`), §6.11 */
  setTeamLogins(team: string, logins: CloudTeamLogins): Promise<CloudTeam> { return this.call('POST', `/teams/${enc(team)}/logins`, CloudTeamSchema, { logins }); }
  /** admins: invite by email (needs a free seat); the invitee gets a link and sees it in the apps once signed in */
  invite(team: string, email: string, role?: CloudTeamRole): Promise<CloudTeam> { return this.call('POST', `/teams/${enc(team)}/invites`, CloudTeamSchema, { email, ...(role ? { role } : {}) }); }
  resendInvite(team: string, inviteId: string): Promise<CloudTeam> { return this.call('POST', `/teams/${enc(team)}/invites/${enc(inviteId)}/resend`, CloudTeamSchema, {}); }
  /** `dropSeat`: also lower the seats by one at the next billing date (scheduled, cancellable) */
  revokeInvite(team: string, inviteId: string, opts: { dropSeat?: boolean } = {}): Promise<CloudTeam> { return this.call('POST', `/teams/${enc(team)}/invites/${enc(inviteId)}/revoke`, CloudTeamSchema, opts.dropSeat ? { dropSeat: true } : {}); }
  setMemberRole(team: string, memberId: string, role: CloudTeamRole): Promise<CloudTeam> { return this.call('POST', `/teams/${enc(team)}/members/${enc(memberId)}/role`, CloudTeamSchema, { role }); }
  /** admins: remove someone; their devices lose the team's computer at once */
  removeMember(team: string, memberId: string, opts: { dropSeat?: boolean } = {}): Promise<CloudTeam> { return this.call('POST', `/teams/${enc(team)}/members/${enc(memberId)}/remove`, CloudTeamSchema, opts.dropSeat ? { dropSeat: true } : {}); }
  leaveTeam(team: string): Promise<{ ok: true }> { return this.call('POST', `/teams/${enc(team)}/leave`, okSchema, {}); }
  /** accept an invite: by its id (listed in `account().invites`) or the link's token */
  acceptInvite(by: { inviteId?: string; token?: string }): Promise<CloudTeam> { return this.call('POST', '/invites/accept', CloudTeamSchema, by); }
  declineInvite(inviteId: string): Promise<{ ok: true }> { return this.call('POST', '/invites/decline', okSchema, { inviteId }); }
}

const enc = encodeURIComponent;
/** the path prefix for a team's computer and billing (none: the person's own) */
const scope = (team?: string): string => (team ? `/teams/${enc(team)}` : '');

const okSchema = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------------------------------------------------------
// PKCE for the apps' browser sign-in (§6.5): the app makes a verifier, opens `/sign-in?challenge&state&redirect`
// (the page signs in with Firebase: Google, Apple, email + password), and when `<redirect>?code&state` comes back,
// redeems the code with the verifier. The desktop returns to `appubot://cloud/signed-in`; the phone to its own link.

export interface PkceStart { verifier: string; challenge: string; state: string; url: string }

/** where a runtime without WebCrypto (React Native: expo-crypto) gets its randomness and SHA-256 */
export interface PkceCrypto {
  randomBytes(n: number): Uint8Array;
  sha256(data: Uint8Array): Promise<Uint8Array>;
}

const webCrypto: PkceCrypto = {
  randomBytes(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return b; },
  async sha256(data) { return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource)); },
};

function base64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** make the verifier, challenge and state, and the page URL to open (WebCrypto by default: Node 20+, browsers) */
export async function startPkce(baseUrl = CLOUD_API_URL, redirect = CLOUD_SIGNED_IN_LINK, c: PkceCrypto = webCrypto): Promise<PkceStart> {
  const verifier = base64Url(c.randomBytes(32));
  const challenge = base64Url(await c.sha256(new TextEncoder().encode(verifier)));
  const state = base64Url(c.randomBytes(16));
  const url = `${baseUrl.replace(/\/$/, '')}/sign-in?challenge=${encodeURIComponent(challenge)}&state=${encodeURIComponent(state)}&redirect=${encodeURIComponent(redirect)}`;
  return { verifier, challenge, state, url };
}

/** read `code` and `state` from the deep link; null when it isn't one (no `URL`: React Native's may lack searchParams) */
export function parseSignedInLink(link: string): { code: string; state: string } | null {
  const q = link.indexOf('?');
  if (q < 0) return null;
  const params = new Map<string, string>();
  for (const pair of link.slice(q + 1).split('#')[0]!.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    try { params.set(decodeURIComponent(pair.slice(0, eq)), decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '))); } catch { return null; }
  }
  const code = params.get('code'), state = params.get('state');
  if (!code || !state) return null;
  return { code, state };
}
