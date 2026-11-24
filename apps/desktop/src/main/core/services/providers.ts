/**
 * Providers: builtin ACP agents (from the runtime) + custom ones (providers.json) with install, version and login
 * status. The runtime checks each CLI's own login (agent-runtime login.ts) on every refresh; after "Log in" opens
 * Terminal, the provider is re-checked every few seconds until the login lands (or a few minutes pass).
 */
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { ACP_REGISTRY, APPUBOT_AI_PROVIDER_ID, DEFAULT_EFFORTS, FREE_MODELS_ACCOUNT, FREE_MODELS_NOTE, creditModelAllowed, isFreeAgent, withoutRetired, PROFILE_HOME_ENV, ProviderSchema, agentChoices, profileId, providerBase, type FoundProfile, type MethodParams, type MethodResult, type Provider, type ProviderAuth } from '@appubot/protocol';
import { RETIRED_PROVIDER_IDS, cmdLine, providerModes, resolveExecutable, type ProviderSpec, type ProviderStatus, type SessionInfo, withBuiltinLogins } from '@appubot/agent-runtime';
import type { CoreCtx } from '../context';
import { findProfiles, profileSlug } from './providerProfiles';
import { quietInstall } from './cloudInstall';
import { installFreeAgent } from './freeAgentInstall';
import { installNativeAgent, installRoute, type InstallRoute } from './nativeInstall';
import { defaultUpdateIo } from './providerUpdates';
import { errMsg, notFound, RpcError, shq } from '../util';

/** What `deps.openTerminal` opens, as the user knows it. */
const terminalName = (): string => (process.platform === 'darwin' ? 'Terminal' : 'a terminal window');

const NO_CAPS = { loadSession: false, image: false, audio: false, embeddedContext: false };
/** How often, and how long, a login started from AppuBot is watched for. */
const LOGIN_POLL_MS = 3000;
const LOGIN_WATCH_MS = 5 * 60_000;
/** how long models read from a session of the agent's own are reused */
const CHOICES_TTL_MS = 6 * 60 * 60_000;
/** what a kept list was read with: lists from before (Claude Code without the older versions) are read again */
const CHOICES_VERSION = 3;
const CHOICES_TIMEOUT_MS = 45_000;
/** how long OpenCode's full model list may take after its session starts */
const OPENCODE_MODELS_WAIT_MS = 6000;

const real = (p: string): string => {
  try { return realpathSync(p); } catch { return resolve(p); }
};
const isDirectory = (p: string): boolean => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};

const authKey = (st: ProviderStatus | undefined) => JSON.stringify([st?.auth?.state, st?.auth?.account, st?.auth?.plan, st?.authStatus]);

export class ProvidersService {
  private statuses = new Map<string, ProviderStatus>();
  private detecting: Promise<void> | null = null;
  /** logins being watched, by provider id: stop() */
  private watches = new Map<string, () => void>();
  /** models and efforts read from a short session of the agent's own, by provider id */
  private choicesCache = new Map<string, { at: number; value: Promise<MethodResult<'providers.choices'>> }>();
  /** the last lists read per agent, kept on disk (`provider-choices.json`) so the pickers have them at once, even after a restart */
  private saved: Record<string, { at: number; v?: number } & MethodResult<'providers.choices'>> | null = null;
  private warmTimer: ReturnType<typeof setTimeout> | null = null;
  /** keys saved for agents' logins (API keys), by login scope (`LoginsService`: `''` the computer's own `agent-keys.json`, a team member's their own), provider id and variable */
  private keys = new Map<string, Record<string, Record<string, string>>>();
  /** the CLI's own login as seen with a team member's logins (`own` mode), by scope and provider id; the computer's own is the runtime's status */
  private scopedAuth = new Map<string, Map<string, ProviderAuth>>();
  /**
   * the last sign-in state seen for each agent with no login check of its own (the ACP registry's), which its
   * handshake can't tell: `agent-auth.json`, so a restart doesn't forget it
   */
  private seenAuth: Record<string, 'authenticated' | 'needs_auth'> | null = null;
  /** agents being installed right now (`installHere`), by provider id */
  private installs = new Map<string, Promise<{ ok: boolean; output: string }>>();
  /** npm is on this computer's PATH (read at each refresh): an npm-only install line can run */
  private npm = true;

  constructor(private ctx: CoreCtx) {}

  /** Push custom specs into the runtime (and, on an AppuBot Cloud computer with included credit, the AppuBot AI agent: `CreditService.spec`). */
  applyCustom(): void {
    try {
      const credit = this.ctx.s.credit?.spec();
      this.ctx.runtime.setProviders([...this.ctx.store.providers.get().filter((p) => ((this.ctx.deps.acpRegistry ?? ACP_REGISTRY) || !p.registry) && p.id !== APPUBOT_AI_PROVIDER_ID), ...(credit ? [credit] : [])]);
    } catch (e) { this.ctx.log.error('runtime.setProviders failed', errMsg(e)); }
  }

  /**
   * Built-ins AppuBot dropped (Gemini CLI, Qwen Code, Goose, Kimi): forget their saved switches, and move the default
   * agent, the bots and their chats off them (to the default agent, else Claude Code) so nothing points at an agent
   * that no longer exists. A chat moved over starts a fresh session on the new agent; its transcript stays. A custom
   * agent the user added under one of those ids is theirs and stays. Runs at startup, after `applyCustom`.
   */
  migrateRetired(): void {
    const retired = new Set(RETIRED_PROVIDER_IDS);
    const saved = this.ctx.store.providers.get();
    const dropped = saved.filter((p) => p.builtin && retired.has(p.id));
    if (dropped.length) {
      this.ctx.store.providers.update((l) => l.filter((p) => !(p.builtin && retired.has(p.id))));
      this.applyCustom();
      this.ctx.log.info(`providers: dropped retired built-ins ${dropped.map((p) => p.id).join(', ')}`);
    }
    let known: Set<string>;
    try { known = new Set(this.ctx.runtime.getProviders().map((p) => p.id)); } catch { return; }
    const gone = (id: string) => retired.has(id) && !known.has(id);

    const s = this.ctx.s;
    if (gone(s.settings.get().defaultProviderId)) {
      this.ctx.log.warn(`providers: default agent ${s.settings.get().defaultProviderId} is no longer built in; using claude-code`);
      s.settings.update({ defaultProviderId: 'claude-code' });
    }
    this.moveOff(gone, s.settings.get().defaultProviderId);
  }

  /**
   * Move the bots on agents `gone` picks to `fallback`, and their chats to their bot's agent: a chat moved over starts
   * a fresh session on the new agent (its transcript stays).
   */
  private moveOff(gone: (id: string) => boolean, fallback: string): void {
    const s = this.ctx.s;
    for (const bot of s.bots.list()) {
      if (!gone(bot.providerId)) continue;
      this.ctx.log.warn(`providers: bot ${bot.name} used ${bot.providerId}, which is gone; moved to ${fallback}`);
      s.bots.update(bot.id, { providerId: fallback });
    }
    for (const t of s.threads.list({ limit: 100_000 })) {
      if (!gone(t.providerId)) continue;
      const providerId = s.bots.get(t.botId)?.providerId ?? fallback;
      s.threads.update(t.id, { providerId, acpSessionId: undefined, modes: [], models: [], commands: [], modeId: undefined, modelId: undefined }, false);
    }
  }

  private toProvider(spec: ProviderSpec, scope = ''): Provider {
    const own = this.statuses.get(spec.id);
    // a team member's view: the install and capabilities are the computer's, the sign-in theirs (checked with their home)
    const scoped = scope ? this.scopedAuth.get(scope)?.get(spec.id) : undefined;
    const st: ProviderStatus | undefined = own && scope ? { ...own, ...(scoped ? { auth: scoped, authStatus: scoped.state === 'logged_in' ? 'authenticated' : scoped.state === 'logged_out' ? 'needs_auth' : 'unknown' } : own.auth ? { auth: undefined, authStatus: 'unknown' } : {}), lastError: undefined } : own;
    return ProviderSchema.parse({
      ...spec,
      description: spec.description ?? '',
      ...(st ?? {}),
      // spec fields win over stale status fields
      id: spec.id, name: spec.name, command: spec.command, args: spec.args, env: spec.env,
      icon: spec.icon ?? 'bot', builtin: !!spec.builtin, enabled: spec.enabled !== false, profile: spec.profile, profileName: spec.profileName,
      ...this.installFields(spec),
      capabilities: st?.capabilities ?? NO_CAPS,
      version: st?.version ?? spec.registry?.version,
      // an agent that can't be asked whether it is signed in, not checked yet since the app started: as it was last seen
      ...(st && !st.auth && st.authStatus === 'unknown' && this.readSeenAuth()[spec.id] ? { authStatus: this.readSeenAuth()[spec.id] } : {}),
      ...this.freeLogin(spec.id, st),
      ...this.endpointsLogin(spec.id, st),
      ...this.keysLogin(spec.id, st, scope),
      keysSaved: Object.keys(this.readKeys(scope)[spec.id] ?? {}),
      ...(this.ctx.s.providerUpdates?.fields(spec) ?? {}),
      ...(this.installs.has(spec.id) ? { installing: true } : {}),
    });
  }

  /** The install line to show (none for an agent AppuBot downloads itself), and Node.js when only npm installs it and npm isn't here. */
  private installFields(spec: ProviderSpec): Pick<Provider, 'installHint' | 'installNeeds'> {
    const route = this.installRouteOf(spec);
    return {
      installHint: route.kind === 'download' ? undefined : spec.installHint,
      ...(route.kind === 'needs-node' ? { installNeeds: 'node' as const } : {}),
    };
  }

  /**
   * How `install` gets `spec` onto this computer (`nativeInstall.ts` `installRoute`). An AppuBot Cloud computer runs
   * the agent's own installer there (`cloudInstall.ts`: npm into the home folder, the makers' scripts), OpenCode's
   * download aside.
   */
  private installRouteOf(spec: ProviderSpec): InstallRoute {
    if (this.ctx.deps.cloud) {
      if (isFreeAgent(spec.id)) return { kind: 'download', agent: 'opencode' };
      const how = quietInstall(spec.installHint, homedir(), 'linux');
      return how ? { kind: 'installer', ...how } : { kind: 'none' };
    }
    return installRoute(providerBase(spec.id), spec.installHint, { home: this.ctx.deps.homeDir ?? homedir(), npm: this.npm, builtin: this.isBuiltinAgent(spec.id) });
  }

  /**
   * OpenCode needs no login at all: with nothing signed in it runs its free models (protocol `freeModels.ts`), so
   * signed out (or not checked) it reads as ready, "Free models · No account needed". Someone signed in to their own
   * providers there keeps those names; the free models are still listed beside them.
   */
  private freeLogin(id: string, st: ProviderStatus | undefined): Partial<Provider> {
    if (!isFreeAgent(id) || !st || !st.installed || st.authStatus === 'not_installed' || st.auth?.state === 'logged_in') return {};
    return { authStatus: 'authenticated', auth: { state: 'logged_in', account: FREE_MODELS_ACCOUNT, plan: FREE_MODELS_NOTE, checkedAt: st.auth?.checkedAt ?? Date.now() } };
  }

  /**
   * OpenCode with custom model endpoints needs no login of its own: signed out (or unknown) it counts as signed in to
   * them ("Ollama, LM Studio"), so bots can run on local models alone.
   */
  private endpointsLogin(id: string, st: ProviderStatus | undefined): Partial<Provider> {
    if (providerBase(id) !== 'opencode' || !st || st.authStatus === 'not_installed') return {};
    const names = this.ctx.s.endpoints?.list().map((e) => e.name) ?? [];
    if (!names.length || st.auth?.state === 'logged_in') return {};
    return { authStatus: 'authenticated', auth: { state: 'logged_in', account: [...names, FREE_MODELS_ACCOUNT].join(', '), checkedAt: st.auth?.checkedAt ?? Date.now() } };
  }

  /**
   * Claude Code with a pasted token or an API key (`builtinKeyLogins`: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`,
   * given to it at every start) needs no login of its own on this computer: its CLI's check says signed out, the key
   * says signed in. How a phone signs it in on an AppuBot Cloud computer, where nobody can type into a terminal.
   */
  private keysLogin(id: string, st: ProviderStatus | undefined, scope = ''): Partial<Provider> {
    if (providerBase(id) !== 'claude-code' || !st || st.authStatus === 'not_installed') return {};
    // AppuBot AI needs no login: the included credit is its sign-in; a plan on hold (or ended) pauses it
    if (id === APPUBOT_AI_PROVIDER_ID && this.ctx.s.credit?.offered()) {
      const on = this.ctx.s.credit.active();
      const account = this.ctx.s.credit.promo() ? (on ? 'AppuBot Launch Gift' : 'Launch gift ended') : !on ? 'Launch bonus paused' : this.ctx.s.credit.ended() ? 'Launch bonus ended' : 'Claude launch bonus';
      return { authStatus: on ? 'authenticated' : 'needs_auth', auth: { state: on ? 'logged_in' : 'logged_out', account, checkedAt: st.auth?.checkedAt ?? Date.now() } };
    }
    const keys = this.readKeys(scope)[id] ?? {};
    const by = keys.CLAUDE_CODE_OAUTH_TOKEN ? 'Claude Code token' : keys.ANTHROPIC_API_KEY ? 'API key' : null;
    if (!by || st.auth?.state === 'logged_in') return {};
    return { authStatus: 'authenticated', auth: { state: 'logged_in', account: by, checkedAt: st.auth?.checkedAt ?? Date.now() } };
  }

  /** Drop an agent's kept model lists (its models changed: custom endpoints); the next picker reads them again. */
  forgetChoices(id: string): void {
    this.choicesCache.delete(id);
    const saved = this.savedChoices();
    if (!saved[id]) return;
    const { [id]: _gone, ...rest } = saved;
    this.saved = rest;
    try { writeFileSync(this.choicesFile(), JSON.stringify(rest)); } catch (e) { this.ctx.log.warn('providers: could not save model lists', errMsg(e)); }
  }

  /**
   * What the model and effort pickers offer for an agent: its latest chat's lists, else a session of its own opened in
   * an empty folder just to read them, then closed (agents only list models in a session). Reused for a while; on
   * failure, no models (the agent's own default) and the usual efforts.
   */
  async choices(id: string): Promise<MethodResult<'providers.choices'>> {
    const lists = await this.readKnownChoices(id);
    // the permission choices as AppuBot offers them now (a list read before an agent had AppuBot's approvals has its own);
    // AppuBot AI (the launch bonus) lists Sonnet and Haiku only, also from a list kept from before
    // and a free model OpenCode's server has retired is gone from a list kept from before it was learnt (freeModels.ts)
    const models = id === APPUBOT_AI_PROVIDER_ID ? lists.models.filter((m) => creditModelAllowed(m.id)) : withoutRetired(lists.models);
    return { ...lists, models, modes: providerModes(id, lists.modes) };
  }

  private readKnownChoices(id: string): Promise<MethodResult<'providers.choices'>> {
    const known = agentChoices(this.ctx.s.threads.list({ limit: 10_000 }), id);
    if (known.models.length) return Promise.resolve(known);
    const hit = this.choicesCache.get(id);
    if (hit && Date.now() - hit.at < CHOICES_TTL_MS) return hit.value;
    // what was read before (this run or an earlier one) answers at once; an old list is read again behind it
    const kept = this.savedChoices()[id];
    if (kept?.models.length) {
      if (Date.now() - kept.at >= CHOICES_TTL_MS && !hit) void this.refreshChoices(id);
      const { at: _at, v: _v, ...lists } = kept;
      return Promise.resolve(lists);
    }
    return this.refreshChoices(id);
  }

  /** Read an agent's lists from a session of its own, and keep them (in memory and on disk). */
  private refreshChoices(id: string): Promise<MethodResult<'providers.choices'>> {
    const value = this.readChoices(id).then((v) => {
      if (v.models.length) this.saveChoices(id, v);
      return v;
    }).catch((e) => {
      this.ctx.log.warn(`providers: could not read ${id}'s models`, errMsg(e));
      this.choicesCache.delete(id);
      return { models: [], efforts: [...DEFAULT_EFFORTS], modes: [] };
    });
    this.choicesCache.set(id, { at: Date.now(), value });
    return value;
  }

  private choicesFile(): string { return join(this.ctx.paths.dataDir, 'provider-choices.json'); }

  private savedChoices(): NonNullable<ProvidersService['saved']> {
    if (!this.saved) {
      try { this.saved = JSON.parse(readFileSync(this.choicesFile(), 'utf8')) as NonNullable<ProvidersService['saved']>; } catch { this.saved = {}; }
      this.saved = Object.fromEntries(Object.entries(this.saved!).filter(([, e]) => e.v === CHOICES_VERSION));
    }
    return this.saved!;
  }

  private saveChoices(id: string, v: MethodResult<'providers.choices'>): void {
    const all = { ...this.savedChoices(), [id]: { at: Date.now(), v: CHOICES_VERSION, ...v } };
    this.saved = all;
    try { writeFileSync(this.choicesFile(), JSON.stringify(all)); } catch (e) { this.ctx.log.warn('providers: could not save model lists', errMsg(e)); }
  }

  /**
   * A little after launch, read the lists of every installed agent that has none yet (or only old ones), one at a
   * time, so the pickers show them at once rather than "Loading models…".
   */
  warmChoices(delayMs = 20_000): void {
    if (this.warmTimer) return;
    this.warmTimer = setTimeout(() => {
      this.warmTimer = null;
      void (async () => {
        const threads = this.ctx.s.threads.list({ limit: 10_000 });
        for (const p of this.list().filter((x) => x.installed && x.enabled)) {
          if (agentChoices(threads, p.id).models.length) continue;
          const kept = this.savedChoices()[p.id];
          if (kept?.models.length && Date.now() - kept.at < CHOICES_TTL_MS) continue;
          await this.refreshChoices(p.id).catch(() => undefined);
        }
      })();
    }, delayMs);
    this.warmTimer.unref?.();
  }

  stopWarm(): void {
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = null;
  }

  private async readChoices(id: string): Promise<MethodResult<'providers.choices'>> {
    const cwd = join(this.ctx.paths.dataDir, 'agent-probe');
    mkdirSync(cwd, { recursive: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const info = await Promise.race([
      this.ctx.runtime.createSession({ providerId: id, cwd }),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('the agent took too long to start')), CHOICES_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    const read = providerBase(id) === 'opencode' ? await this.fullModelList(info) : info;
    void this.ctx.runtime.closeSession(info.id).catch(() => undefined);
    return { models: read.models, efforts: read.efforts.length ? read.efforts : [...DEFAULT_EFFORTS], modes: providerModes(id, read.modes) };
  }

  /**
   * OpenCode answers a new session with the models it knows at once and sends the rest (custom model endpoints,
   * Ollama and LM Studio it found) moments later as a config update: wait for that list, briefly.
   */
  private async fullModelList(info: SessionInfo): Promise<SessionInfo> {
    const until = Date.now() + OPENCODE_MODELS_WAIT_MS;
    const first = JSON.stringify(info.models.map((m) => m.id));
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 200));
      const now = this.ctx.runtime.getSession(info.id);
      if (!now) break;
      if (JSON.stringify(now.models.map((m) => m.id)) !== first) return now;
    }
    return this.ctx.runtime.getSession(info.id) ?? info;
  }

  /** `scope`: a team member's own view (their keys and sign-ins) on a team's computer set to each person's own logins */
  list(scope = ''): Provider[] {
    let specs: ProviderSpec[] = [];
    try { specs = this.ctx.runtime.getProviders(); } catch (e) { this.ctx.log.error('runtime.getProviders failed', errMsg(e)); }
    return specs.map((s) => this.toProvider(s, scope));
  }

  /**
   * A team member's sign-ins (`own` mode): each agent's own login check run with their home, kept per scope; the
   * computer's own list is the runtime's status (`refresh`). Keys saved in the scope count as signed in for agents
   * whose check can't tell.
   */
  async refreshSignIn(ids: string[] | undefined, scope: string): Promise<Provider[]>;
  async refreshSignIn(ids?: string[]): Promise<Provider[]>;
  async refreshSignIn(ids?: string[], scope = ''): Promise<Provider[]> {
    if (!scope) return this.refreshSignInHere(ids);
    const targets = ids ?? this.ctx.runtime.getProviders().map((s) => s.id);
    const map = this.scopedAuth.get(scope) ?? new Map<string, ProviderAuth>();
    this.scopedAuth.set(scope, map);
    await Promise.all(targets.map(async (id) => {
      try {
        const auth = await this.ctx.runtime.loginState(id, this.ctx.s.logins.loginEnv(scope));
        if (auth) map.set(id, auth); else map.delete(id);
      } catch (e) { this.ctx.log.warn(`providers: ${id} login check for ${scope} failed`, errMsg(e)); }
    }));
    return this.list(scope);
  }

  capabilities(id: string): Provider['capabilities'] {
    return this.statuses.get(id)?.capabilities ?? NO_CAPS;
  }

  /** Re-probe install, version and login of all (or some) providers; emits `providers.updated`. */
  async refresh(ids?: string[]): Promise<Provider[]> {
    this.npm = !!(await resolveExecutable('npm').catch(() => undefined));
    try {
      const known = this.ctx.runtime.getProviders().map((s) => s.id);
      const targets = ids ? ids.filter((id) => known.includes(id)) : known;
      const all = await this.ctx.runtime.detectProviders(targets);
      for (const st of all) this.setStatus(st);
    } catch (e) {
      this.ctx.log.warn('detectProviders failed', errMsg(e));
    }
    const list = this.list();
    this.ctx.bus.emit('providers.updated', list);
    return list;
  }

  /**
   * `refresh`, and each agent among `ids` that can't be asked whether it is signed in (no login check of its own: the
   * ACP registry's) is started once in a session of its own, which tells (and brings its models along).
   */
  private async refreshSignInHere(ids?: string[]): Promise<Provider[]> {
    await this.refresh(ids);
    const unchecked = (ids ?? []).filter((id) => {
      const st = this.statuses.get(id);
      return st?.installed && !st.auth;
    });
    for (const id of unchecked) await this.checkSignIn(id);
    return unchecked.length ? this.refresh(ids) : this.list();
  }

  /** A short session of the agent's own (see `readChoices`): the runtime marks it signed in when it starts, out when it asks for a login. A scope's check is its own login state instead. */
  private async checkSignIn(id: string, scope = ''): Promise<boolean> {
    if (scope) { const a = await this.ctx.runtime.loginState(id, this.ctx.s.logins.loginEnv(scope)).catch(() => undefined); return a?.state === 'logged_in'; }
    this.choicesCache.delete(id);
    try {
      const lists = await this.readChoices(id);
      if (lists.models.length) this.saveChoices(id, lists);
      return true;
    } catch (e) {
      this.ctx.log.info(`providers: ${id} did not start a session`, errMsg(e));
      return false;
    }
  }

  private setStatus(st: ProviderStatus): void {
    this.statuses.set(st.id, st);
    if (st.auth || (st.authStatus !== 'authenticated' && st.authStatus !== 'needs_auth')) return;
    const seen = this.readSeenAuth();
    if (seen[st.id] === st.authStatus) return;
    this.seenAuth = { ...seen, [st.id]: st.authStatus };
    this.writeJson('agent-auth.json', this.seenAuth);
  }

  private readSeenAuth(): Record<string, 'authenticated' | 'needs_auth'> {
    return (this.seenAuth ??= this.readJson<Record<string, 'authenticated' | 'needs_auth'>>('agent-auth.json'));
  }

  private readKeys(scope = ''): Record<string, Record<string, string>> {
    let k = this.keys.get(scope);
    if (!k) { k = this.readJson<Record<string, Record<string, string>>>('agent-keys.json', scope); this.keys.set(scope, k); }
    return k;
  }

  /** the file of a login scope: the data folder's, or a team member's own folder's */
  private fileOf(name: string, scope = ''): string { return scope ? this.ctx.s.logins.fileOf(scope, name) : join(this.ctx.paths.dataDir, name); }

  private readJson<T>(name: string, scope = ''): T {
    try { return JSON.parse(readFileSync(this.fileOf(name, scope), 'utf8')) as T; } catch { return {} as T; }
  }

  /** Written for this user only (0600): `agent-keys.json` holds API keys. */
  private writeJson(name: string, value: object, scope = ''): void {
    const file = this.fileOf(name, scope);
    try {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
      chmodSync(file, 0o600);
    } catch (e) {
      this.ctx.log.warn(`providers: could not save ${name}`, errMsg(e));
    }
  }

  /** The keys saved for an agent's login in a scope, for its environment (the runtime's `secretEnv`): never on the wire. */
  secretEnv(id: string, scope = ''): Record<string, string> | undefined {
    // AppuBot AI (§6.13): the pass-through's address and the credit token, nothing of the user's keys
    const credit = this.ctx.s.credit?.env(id);
    if (credit) return credit;
    const keys = this.readKeys(scope)[id];
    // OpenCode also gets the custom model endpoints (ModelEndpointsService), keys included
    const endpoints = providerBase(id) === 'opencode' ? this.ctx.s.endpoints?.openCodeEnv() : undefined;
    return endpoints ? { ...keys, ...endpoints } : keys;
  }

  /**
   * Save the keys `methodId` asks for (its `vars`), then sign in with them: an `agent` login (Gemini's API key) is
   * selected with `authenticate`, an `env_var` one is tried in a short session. Values only ever go to the agent.
   */
  async setKeys(id: string, methodId: string, values: Record<string, string>, scope = ''): Promise<{ ok: boolean; message?: string }> {
    const spec = this.ctx.runtime.getProviders().find((s) => s.id === id);
    if (!spec) throw notFound('Provider', id);
    if (!this.statuses.get(id)?.authMethods.length) await this.probe(id);
    // the built-in key logins count even for a runtime whose status doesn't list them (a device login keeping Claude's token)
    const method = withBuiltinLogins(id, this.statuses.get(id)?.authMethods ?? []).find((m) => m.id === methodId);
    if (!method?.vars?.length) throw new RpcError('invalid_params', `${spec.name} has no login "${methodId}" that takes a key.`);
    const keep: Record<string, string> = {};
    for (const v of method.vars) {
      const value = values[v.name]?.trim();
      if (value) keep[v.name] = value;
      else if (!v.optional) throw new RpcError('invalid_params', `Enter ${v.label ?? v.name}.`);
    }
    if (!Object.keys(keep).length) throw new RpcError('invalid_params', `Enter ${method.vars.map((v) => v.label ?? v.name).join(' or ')}.`);
    // this login's keys as given now (one left empty is dropped: an Agent Platform key gives way to a project), others kept
    const own = new Set(method.vars.map((v) => v.name));
    const others = Object.fromEntries(Object.entries(this.readKeys(scope)[id] ?? {}).filter(([k]) => !own.has(k)));
    const next = { ...this.readKeys(scope), [id]: { ...others, ...keep } };
    this.keys.set(scope, next);
    this.writeJson('agent-keys.json', next, scope);
    if (method.kind === 'agent') return this.agentLogin(spec, method.id, scope);
    const ok = await this.checkSignIn(id, scope);
    await this.refreshScope(id, scope);
    return ok ? { ok: true, message: `${spec.name} is signed in with your key.` } : { ok: false, message: `${spec.name} didn't start with that key. Check it and try again.` };
  }

  async clearKeys(id: string, scope = ''): Promise<{ ok: true }> {
    const { [id]: _gone, ...rest } = this.readKeys(scope);
    this.keys.set(scope, rest);
    this.writeJson('agent-keys.json', rest, scope);
    await this.refreshScope(id, scope);
    return { ok: true };
  }

  /** the computer's own status, or a scope's own login check */
  private async refreshScope(id: string, scope: string): Promise<void> {
    if (!scope) { await this.refresh([id]); return; }
    await this.refreshSignIn([id], scope);
  }

  /** Background refresh that never throws (used after errors and at startup). */
  refreshQuiet(id?: string): Promise<void> {
    if (this.detecting) return this.detecting;
    this.detecting = this.refresh(id ? [id] : undefined).then(() => undefined, () => undefined).finally(() => { this.detecting = null; });
    return this.detecting;
  }

  async upsert(p: MethodParams<'providers.upsert'>): Promise<Provider> {
    const isProfile = this.ctx.store.providers.get().some((x) => x.id === p.id && x.profile);
    if (!isProfile && !/^[a-z0-9][a-z0-9._-]{0,40}$/i.test(p.id)) throw new RpcError('invalid_params', 'Provider id must be alphanumeric (dashes allowed)');
    if (!p.command?.trim()) throw new RpcError('invalid_params', 'Command is required');
    const builtin = this.ctx.runtime.getProviders().find((s) => s.id === p.id && s.builtin);
    // an agent added from the ACP registry stays one (its switch is saved through here too)
    const fromRegistry = this.ctx.store.providers.get().find((x) => x.id === p.id && x.registry);
    // so does a profile (its switch, name and env come through here; it keeps running its agent from its folder)
    const profile = this.ctx.store.providers.get().find((x) => x.id === p.id && x.profile)?.profile;
    const profileName = this.ctx.store.providers.get().find((x) => x.id === p.id)?.profileName;
    const spec: ProviderSpec = {
      id: p.id, name: p.name, description: p.description ?? '', command: p.command.trim(), args: p.args ?? [], env: p.env ?? {},
      icon: p.icon ?? 'bot', enabled: p.enabled ?? true, installHint: p.installHint, builtin: !!builtin,
      ...(fromRegistry ? { registry: fromRegistry.registry, ...(fromRegistry.iconSvg ? { iconSvg: fromRegistry.iconSvg } : {}) } : {}),
      ...(profile ? { profile } : {}),
      ...(profileName ? { profileName } : {}),
    };
    this.ctx.store.providers.update((l) => [...l.filter((x) => x.id !== p.id), spec]);
    this.applyCustom();
    // the switch alone doesn't change what runs: keep the last check (a full re-probe would re-run the login check)
    const runs = (s: ProviderSpec | undefined) => JSON.stringify([s?.command, s?.args, s?.env]);
    const after = this.ctx.runtime.getProviders().find((s) => s.id === p.id);
    const prev = this.statuses.get(p.id);
    if (!prev || runs(prev) !== runs(after)) {
      this.statuses.delete(p.id);
      await this.refresh([p.id]);
    } else {
      this.ctx.bus.emit('providers.updated', this.list());
    }
    const out = this.list().find((x) => x.id === p.id);
    if (!out) throw notFound('Provider', p.id);
    return out;
  }

  /**
   * Save an agent from the ACP registry (AcpRegistryService.add) and re-check it; then, in the background, start it
   * once for its logins and capabilities (an npx/uvx agent fetches its package on that first start).
   */
  async saveRegistryAgent(spec: ProviderSpec): Promise<Provider> {
    this.ctx.store.providers.update((l) => [...l.filter((x) => x.id !== spec.id), spec]);
    this.applyCustom();
    this.statuses.delete(spec.id);
    await this.refresh([spec.id]);
    void this.probe(spec.id);
    const out = this.list().find((x) => x.id === spec.id);
    if (!out) throw notFound('Provider', spec.id);
    return out;
  }

  /** Start an agent for the ACP handshake only (its logins, capabilities), then push the list. Never throws. */
  async probe(id: string): Promise<void> {
    try {
      const st = await this.ctx.runtime.probe(id);
      this.setStatus(st);
    } catch (e) {
      this.ctx.log.warn(`could not start ${id} to check it`, errMsg(e));
      await this.refresh([id]).catch(() => undefined);
      return;
    }
    this.ctx.bus.emit('providers.updated', this.list());
  }

  async delete(id: string): Promise<{ ok: true }> {
    const custom = this.ctx.store.providers.get().find((x) => x.id === id);
    if (!custom) {
      if (this.ctx.runtime.getProviders().some((s) => s.id === id)) throw new RpcError('forbidden', 'Built-in providers cannot be deleted');
      throw notFound('Provider', id);
    }
    this.ctx.store.providers.update((l) => l.filter((x) => x.id !== id));
    this.applyCustom();
    this.statuses.delete(id);
    // its saved keys and last sign-in go with it
    if (this.readKeys()[id]) {
      const { [id]: _k, ...keys } = this.readKeys();
      this.keys.set('', keys);
      this.writeJson('agent-keys.json', keys);
    }
    if (this.readSeenAuth()[id]) {
      const { [id]: _a, ...seen } = this.readSeenAuth();
      this.seenAuth = seen;
      this.writeJson('agent-auth.json', seen);
    }
    // a registry agent's own download goes with it
    if (custom.registry && custom.command.startsWith(join(this.ctx.paths.dataDir, 'agents', custom.registry.id))) {
      rmSync(join(this.ctx.paths.dataDir, 'agents', custom.registry.id), { recursive: true, force: true });
    }
    this.stopWatch(id);
    // a profile's bots and chats go back to its agent's default account; its folder (and login) stays on the Mac
    if (custom.profile) {
      const s = this.ctx.s;
      if (s.settings.get().defaultProviderId === id) s.settings.update({ defaultProviderId: custom.profile.of });
      this.moveOff((x) => x === id, custom.profile.of);
    }
    this.ctx.bus.emit('providers.updated', this.list());
    return { ok: true };
  }

  /* ---------- profiles (another account of Claude Code or Codex, in a config folder of its own) ---------- */

  private homeDir(): string {
    return this.ctx.deps.homeDir ?? homedir();
  }

  /** Profile folders on this Mac (Synara's, `~/.claude-*`, `~/.codex-*`) that aren't agents here yet. */
  profiles(): { found: FoundProfile[] } {
    const added = new Set(this.ctx.store.providers.get().flatMap((p) => (p.profile ? [real(p.profile.home)] : [])));
    return { found: findProfiles(this.homeDir()).filter((f) => !added.has(real(f.home))) };
  }

  /**
   * Add a profile of `of` as an agent of its own (`<of>@<slug>`): `home` is a config folder that already exists (a
   * found one keeps its source); without one AppuBot makes `<dataDir>/profiles/<of>/<slug>`, to log in to.
   */
  async addProfile(p: MethodParams<'providers.addProfile'>): Promise<Provider> {
    // a built-in, or an agent added from the ACP registry (Antigravity)
    const builtin = this.ctx.runtime.getProviders().find((x) => x.id === p.of && !x.profile);
    if (!builtin || !PROFILE_HOME_ENV[p.of]) throw new RpcError('invalid_params', 'Only Claude Code, Codex and Google Antigravity can have profiles');
    const saved = this.ctx.store.providers.get();
    const taken = new Set([...saved.map((x) => x.id), ...this.ctx.runtime.getProviders().map((x) => x.id)]);
    const slug0 = profileSlug(p.name);
    let slug = slug0;
    for (let i = 2; taken.has(profileId(p.of, slug)); i++) slug = `${slug0}-${i}`;
    const id = profileId(p.of, slug);

    let home: string;
    let source: 'appubot' | 'synara' | 'folder';
    if (p.home) {
      home = resolve(p.home.replace(process.platform === 'win32' ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/, this.homeDir()));
      if (!isAbsolute(home) || !isDirectory(home)) throw new RpcError('invalid_params', `No such folder: ${p.home}`);
      const dupe = saved.find((x) => x.profile && real(x.profile.home) === real(home));
      if (dupe) throw new RpcError('invalid_params', `That folder is already the profile “${dupe.profile!.name}”`);
      source = findProfiles(this.homeDir()).find((f) => real(f.home) === real(home))?.source ?? 'folder';
    } else {
      home = join(this.ctx.paths.dataDir, 'profiles', p.of, slug);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      source = 'appubot';
    }
    const name = p.name.trim();
    const spec: ProviderSpec = {
      id, name: `${builtin.name} · ${name}`, description: builtin.description ?? '', command: builtin.command, args: [], env: {},
      icon: builtin.icon ?? 'bot', enabled: true, profile: { of: p.of, name, home, source },
    };
    this.ctx.store.providers.update((l) => [...l.filter((x) => x.id !== id), spec]);
    this.applyCustom();
    this.statuses.delete(id);
    await this.refresh([id]);
    // an agent whose logins come from its handshake (a registry one) is started once to learn them
    if (!builtin.builtin) await this.probe(id);
    const out = this.list().find((x) => x.id === id);
    if (!out) throw notFound('Provider', id);
    return out;
  }

  /** Rename a profile (its id, folder and login stay), or with its agent's id that agent's default profile. */
  async renameProfile(id: string, name: string): Promise<Provider> {
    const builtin = this.ctx.runtime.getProviders().find((x) => x.id === id && !x.profile);
    if (builtin && PROFILE_HOME_ENV[id]) {
      const n = name.trim();
      const prev = this.ctx.store.providers.get().find((x) => x.id === id);
      const spec: ProviderSpec = prev ? { ...prev, profileName: n } : { id, name: builtin.name, command: '', args: [], env: {}, builtin: true, enabled: builtin.enabled !== false, profileName: n };
      this.ctx.store.providers.update((l) => [...l.filter((x) => x.id !== id), spec]);
      this.applyCustom();
      const list = this.list();
      this.ctx.bus.emit('providers.updated', list);
      return list.find((x) => x.id === id)!;
    }
    const saved = this.ctx.store.providers.get().find((x) => x.id === id);
    if (!saved?.profile) throw notFound('Profile', id);
    const of = this.ctx.runtime.getProviders().find((x) => x.id === saved.profile!.of);
    const n = name.trim();
    this.ctx.store.providers.update((l) => l.map((x) => (x.id === id ? { ...x, name: `${of?.name ?? saved.profile!.of} · ${n}`, profile: { ...x.profile!, name: n } } : x)));
    this.applyCustom();
    const list = this.list();
    this.ctx.bus.emit('providers.updated', list);
    const out = list.find((x) => x.id === id);
    if (!out) throw notFound('Provider', id);
    return out;
  }

  /** `scope`: a team member signs in with their own logins (their home) on a team's computer set to each person's own */
  async authenticate(id: string, methodId?: string, scope = ''): Promise<{ ok: boolean; message?: string }> {
    const spec = this.ctx.runtime.getProviders().find((s) => s.id === id);
    if (!spec) throw notFound('Provider', id);
    if (!this.isBuiltinAgent(id)) {
      // an added agent's logins (and its profiles') come from its ACP handshake: start it once if it hasn't been yet
      if (!this.statuses.get(id)?.authMethods.length) await this.probe(id);
      const methods = this.statuses.get(id)?.authMethods ?? [];
      const method = methods.find((m) => m.id === methodId) ?? methods[0];
      if (method?.kind === 'agent') return this.agentLogin(spec, method.id, scope);
    }
    const cmd = await this.ctx.runtime.authCommand(id, methodId, this.ctx.s.logins.loginEnv(scope));
    if (!cmd) return { ok: false, message: 'This agent has no terminal login command. Log in with its own CLI, then press Refresh.' };
    // the terminal runs the line in the platform's own shell: cmd.exe on Windows, sh syntax elsewhere
    const env = Object.entries(cmd.env).map(([k, v]) => `${k}=${shq(v)}`).join(' ');
    const line = process.platform === 'win32' ? cmdLine(cmd) : `${env ? `env ${env} ` : ''}${[cmd.command, ...cmd.args].map(shq).join(' ')}`;
    await this.ctx.deps.openTerminal(line);
    if (scope) return { ok: true, message: `Opened ${terminalName()}. Finish logging in there as yourself, then press Check again.` };
    // an agent with a login check of its own is watched until the login lands; another one is checked when asked
    if (!this.statuses.get(id)?.auth && !this.isBuiltinAgent(id)) {
      return { ok: true, message: `Opened ${terminalName()}. Finish logging in there, then press Check again.` };
    }
    this.watchLogin(id);
    return { ok: true, message: `Opened ${terminalName()}. Finish logging in there; AppuBot notices when you are done.` };
  }

  /** `id` runs one of AppuBot's built-in agents (a profile of one included): its logins are its CLI's, not its handshake's. */
  private isBuiltinAgent(id: string): boolean {
    return this.ctx.runtime.getProviders().some((s) => s.id === providerBase(id) && s.builtin);
  }

  /** A session of `id` just started: an agent that can't be asked whether it is signed in is, so it says so now. */
  sessionStarted(id: string): void {
    const st = this.statuses.get(id);
    if (st && !st.auth && st.authStatus !== 'authenticated') void this.refreshQuiet(id);
  }

  /**
   * An agent that signs in by itself (ACP `authenticate`, usually in the browser it opens): started in the background,
   * since the user may take minutes; the list is pushed when it lands or fails (with the error on the agent).
   */
  private agentLogin(spec: ProviderSpec, methodId: string, scope = ''): { ok: boolean; message?: string } {
    void this.ctx.runtime.login(spec.id, methodId, undefined, this.ctx.s.logins.loginEnv(scope)).then(
      () => this.refreshScope(spec.id, scope),
      async (e) => {
        this.ctx.log.warn(`sign-in to ${spec.id} failed`, errMsg(e));
        await this.refreshScope(spec.id, scope).catch(() => undefined);
        const st = this.statuses.get(spec.id);
        if (st) this.setStatus({ ...st, lastError: `Sign-in did not finish: ${errMsg(e)}` });
        this.ctx.bus.emit('providers.updated', this.list());
      },
    );
    return { ok: true, message: `${spec.name} is opening its sign-in. Finish it in your browser; AppuBot notices when you are done.` };
  }

  /** Sign the CLI out (the runtime runs its logout command), then re-check it. */
  async logout(id: string, scope = ''): Promise<{ ok: boolean; message?: string }> {
    const spec = this.ctx.runtime.getProviders().find((s) => s.id === id);
    if (!spec) throw notFound('Provider', id);
    if (!this.statuses.get(id)?.canLogOut) return { ok: false, message: `${spec.name} can't be logged out from AppuBot. Use its own CLI.` };
    if (!scope) this.stopWatch(id);
    const res = await this.ctx.runtime.logout(id, this.ctx.s.logins.loginEnv(scope));
    if (!res.ok) this.ctx.log.warn(`logout of ${id} failed`, res.message ?? '');
    await this.refreshScope(id, scope);
    return res;
  }

  /**
   * Install an agent. AppuBot does it here, in the background, wherever it can (`installRouteOf`): the maker's native
   * program downloaded, or the maker's installer run with no window; the call ends when it is done and `installing`
   * rides on the provider meanwhile. Otherwise the install line opens in a terminal (`terminal: true`); an npm line
   * where Node.js isn't installed says so instead. `quiet` (the free Claude day's setup: `PromoService`) never opens a
   * terminal.
   */
  async install(id: string, opts: { quiet?: boolean } = {}): Promise<{ ok: boolean; output: string; terminal?: boolean }> {
    const spec = this.ctx.runtime.getProviders().find((s) => s.id === id);
    if (!spec) throw notFound('Provider', id);
    const route = this.installRouteOf(spec);
    if (route.kind === 'download' || route.kind === 'installer') return this.installHere(spec, route);
    if (this.ctx.deps.cloud) return { ok: false, output: `${spec.name} can't be installed on AppuBot Cloud from here yet.` };
    if (opts.quiet) return { ok: false, output: `${spec.name} can't be installed from here. Install it from Settings › Agents.` };
    if (route.kind === 'needs-node') {
      return { ok: false, output: `${spec.name} installs with npm, which comes with Node.js, and Node.js isn't on this computer. Install Node.js from nodejs.org, then press Install again.` };
    }
    if (route.kind === 'none') {
      return { ok: false, output: process.platform === 'win32' ? `Install ${spec.name} from its website, then press Refresh.` : 'No install command is known for this agent.' };
    }
    await this.ctx.deps.openTerminal(route.line);
    return { ok: true, output: `Opened ${terminalName()} running: ${route.line}`, terminal: true };
  }

  /**
   * The install AppuBot runs itself, awaited (the apps give the call 15 minutes) and once per agent at a time (a second
   * click joins the first). `installing` rides on the provider meanwhile (`provider.updated` at the start and the end),
   * so every connected app shows it; the refresh after it finds the program, and the agent is ready for its sign-in.
   */
  private installHere(spec: ProviderSpec, route: Extract<InstallRoute, { kind: 'download' | 'installer' }>): Promise<{ ok: boolean; output: string }> {
    const running = this.installs.get(spec.id);
    if (running) return running;
    const emit = () => { const p = this.list().find((x) => x.id === spec.id); if (p) this.ctx.bus.emit('provider.updated', p); };
    const free = route.kind === 'download' && route.agent === 'opencode';
    const job = (async () => {
      this.ctx.log.info(`providers: installing ${spec.id} here: ${route.kind === 'installer' ? `${route.command} ${route.args.join(' ')}` : `its own download (${route.agent})`}`);
      const log = (line: string) => this.ctx.log.info(`providers: ${spec.id}: ${line}`);
      const fetchOpt = this.ctx.deps.fetch ? { fetch: this.ctx.deps.fetch } : {};
      const failed = (e: unknown) => ({ ok: false, output: errMsg(e) });
      const r = route.kind === 'installer'
        ? await ({ ...defaultUpdateIo, ...this.ctx.deps.updateIo }).run(route.command, route.args).catch(failed)
        : free
          ? await (this.ctx.deps.freeAgentInstall ?? installFreeAgent)({ ...this.ctx.s.freeAgent.installPaths(), ...fetchOpt, log }).catch(failed)
          : await (this.ctx.deps.nativeInstall ?? installNativeAgent)(route.agent, { dir: this.nativeDir(route.agent), home: this.ctx.deps.homeDir ?? homedir(), ...fetchOpt, log }).catch(failed);
      await this.refresh([spec.id]).catch((e) => this.ctx.log.warn(`providers: re-checking ${spec.id} failed`, errMsg(e)));
      const installed = !!this.statuses.get(spec.id)?.installed;
      if (!installed) this.ctx.log.warn(`providers: installing ${spec.id} failed`, r.output.slice(-500));
      return installed
        ? { ok: true, output: free ? `${spec.name} is installed and ready: its free models need no account.` : `${spec.name} is installed. Sign in to start using it.` }
        : { ok: false, output: r.output.trim() || `${spec.name} didn't install.` };
    })().finally(() => { this.installs.delete(spec.id); emit(); });
    this.installs.set(spec.id, job);
    emit();
    return job;
  }

  /** where AppuBot keeps the programs it downloads for an agent (OpenCode's: `FreeAgentService.installPaths`) */
  nativeDir(agent: string): string {
    return join(this.ctx.paths.dataDir, 'agents', agent);
  }

  /**
   * Re-check `id` every few seconds after a login was started (Terminal gives no signal when it is done). Each change
   * is pushed as `provider.updated`; it stops once the CLI is logged in as someone new, or after LOGIN_WATCH_MS.
   */
  private watchLogin(id: string): void {
    this.stopWatch(id);
    const before = this.statuses.get(id)?.auth;
    const started = Date.now();
    let last = authKey(this.statuses.get(id));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (this.watches.get(id) === stop) this.watches.delete(id);
    };
    const tick = async () => {
      if (stopped) return;
      try {
        const [st] = await this.ctx.runtime.detectProviders([id]);
        if (stopped) return;
        if (st) this.setStatus(st);
      } catch (e) {
        this.ctx.log.warn(`login check for ${id} failed`, errMsg(e));
      }
      const st = this.statuses.get(id);
      const key = authKey(st);
      if (key !== last) {
        last = key;
        const p = this.list().find((x) => x.id === id);
        if (p) this.ctx.bus.emit('provider.updated', p);
      }
      const auth = st?.auth;
      const landed = auth?.state === 'logged_in' && (before?.state !== 'logged_in' || auth.account !== before.account);
      if (landed || Date.now() - started >= LOGIN_WATCH_MS) return stop();
      timer = setTimeout(() => void tick(), LOGIN_POLL_MS);
      timer.unref?.();
    };
    timer = setTimeout(() => void tick(), LOGIN_POLL_MS);
    timer.unref?.();
    this.watches.set(id, stop);
  }

  private stopWatch(id: string): void {
    this.watches.get(id)?.();
  }

  shutdown(): void {
    for (const stop of [...this.watches.values()]) stop();
  }
}
