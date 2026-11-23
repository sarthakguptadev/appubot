/**
 * Plan limits (`providers.limits`, protocol `limits.ts`): how much of each agent's subscription is left, per
 * window and model, read with the agent's own sign-in and kept up live. One snapshot per agent (profiles are agents
 * of their own) and login scope (a team member's own logins on a team's computer; the file keeps every scope).
 *
 * Where the numbers come from (`services/limits/probes.ts`, swapped by `deps.limitsFetch` in tests): Claude Code's
 * own `get_usage` request, Codex's app-server `account/rateLimits/read`, OpenCode Go's usage endpoint (with the
 * OpenCode Console connection's key first, as OpenCode sends it), Grok's `_x.ai/billing` extension method (a
 * handshake-only process of Grok's: `runtime.extMethod`), Cursor's and Kimi's own usage requests with the token
 * their CLIs keep, Google Antigravity's answer to `/usage` (a session of its own, 1.4.1+: older ones would run a
 * model turn on it), the AppuBot AI credit (`CreditService`). Live, for free: Claude Code's `rate_limit_event`s ride
 * every session's usage updates (`ChatService` → `noteRateLimit`), and Codex writes the bucket a turn used into its
 * rollout (`noteTurnEnd` reads the newest line). API-key logins, Bedrock and Vertex have no plan limits:
 * `unavailable`, and the pickers show nothing for them.
 *
 * When it reads (per agent, never two at once, never within `MIN_GAP_MS` of the last read unless forced): the picker
 * or Settings › Usage opening (`request {refresh: 'stale'}`: over `STALE_MS` old), `AFTER_TURN_MS` after a turn on
 * that agent ends, every `POLL_MS` while the app is in use (the window focused, or a bot ran within the quarter hour:
 * idle accounts aren't polled at night), `AFTER_RESET_MS` after a window's reset passes, and the Refresh button
 * (`force`). A failure keeps the last good numbers (marked `error`) and backs off `BACKOFF_MS`. Kept in
 * `<dataDir>/provider-limits.json` (0600; percentages, resets and plan names only), so the picker shows numbers at
 * launch before anything is read.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PROFILE_HOME_ENV, providerBase, type Provider, type ProviderLimits } from '@appubot/protocol';
import { adapterCli, applyLoginHome, getPathString, mergeEnv, withPath, type ClaudeRateLimitInfo, type ProviderSpec, type SessionInfo, type TurnOp } from '@appubot/agent-runtime';
import { applyClaudeRateLimit, applyCodexRateLimits, compareVersions, limitsFromAntigravity, limitsFromClaudeUsage, limitsFromCodex, limitsFromCredit, limitsFromCursor, limitsFromGrok, limitsFromKimi, limitsFromOpenCodeGo } from '@appubot/chat-core';
import type { CoreCtx } from '../context';
import { writeFileAtomic } from '../store';
import { errMsg } from '../util';
import { isAppubotAi } from './credit';
import type { LoginScope } from './logins';
import { defaultLimitsFetch, userHome, type LimitsFetch } from './limits/probes';
import { codexRateLimitsOf } from './usageLogs';

export const STALE_MS = 5 * 60_000;
export const MIN_GAP_MS = 60_000;
export const FORCE_GAP_MS = 10_000;
export const AFTER_TURN_MS = 2 * 60_000;
export const POLL_MS = 15 * 60_000;
export const AFTER_RESET_MS = 30_000;
export const BACKOFF_MS = 30 * 60_000;
/** the app counts as in use this long after a turn ended */
export const IN_USE_MS = 15 * 60_000;
const TICK_MS = 30_000;
/** how much of a Codex rollout's end is read for its newest rate limits */
const ROLLOUT_TAIL = 64 * 1024;
/** the Antigravity that first answers `/usage` by itself (OpenBot's finding); older ones would send it to the model */
const ANTIGRAVITY_USAGE_MIN = '1.4.1';
/** Antigravity's `/usage` read: its start (~6 s here) and the answer */
const ANTIGRAVITY_TIMEOUT_MS = 60_000;
/** Grok's process for one billing answer */
const GROK_TIMEOUT_MS = 20_000;

/** agents with plan limits, by their base or registry id (`kindOf`) */
const AGENTS = new Set(['claude-code', 'codex', 'opencode', 'grok', 'cursor', 'kimi', 'antigravity-acp']);
/** `antigravity-acp` for a registry agent added under another id too */
const kindOf = (p: { id: string; registry?: { id: string } }): string => (AGENTS.has(providerBase(p.id)) ? providerBase(p.id) : p.registry?.id ?? providerBase(p.id));

interface Entry {
  limits: ProviderLimits;
  /** when a read last started and ended (ms) */
  fetchedAt?: number;
  failedAt?: number;
}
interface Stored { v: 1; entries: Record<string, ProviderLimits> }

const keyOf = (scope: LoginScope, providerId: string): string => (scope ? `${scope}\u0000${providerId}` : providerId);
const splitKey = (key: string): { scope: LoginScope; providerId: string } => {
  const i = key.indexOf('\u0000');
  return i < 0 ? { scope: '', providerId: key } : { scope: key.slice(0, i), providerId: key.slice(i + 1) };
};

export class LimitsService {
  private entries = new Map<string, Entry>();
  private inflight = new Map<string, Promise<void>>();
  private afterTurn = new Map<string, ReturnType<typeof setTimeout>>();
  private lastTurnAt = 0;
  private lastPollAt = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private readonly fetch: LimitsFetch;
  private loaded = false;

  constructor(private ctx: CoreCtx) {
    this.fetch = { ...defaultLimitsFetch, ...(ctx.deps.limitsFetch ?? {}) };
  }

  private get file(): string { return join(this.ctx.paths.dataDir, 'provider-limits.json'); }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Stored;
      if (raw?.v !== 1 || !raw.entries || typeof raw.entries !== 'object') return;
      for (const [key, limits] of Object.entries(raw.entries)) if (limits && typeof limits === 'object' && Array.isArray(limits.windows)) this.entries.set(key, { limits });
    } catch (e) { this.ctx.log.warn('limits: could not read the saved plan limits', errMsg(e)); }
  }

  private save(): void {
    const entries: Record<string, ProviderLimits> = {};
    for (const [k, e] of this.entries) entries[k] = e.limits;
    try { writeFileAtomic(this.file, JSON.stringify({ v: 1, entries } satisfies Stored), 0o600); } catch (e) { this.ctx.log.warn('limits: could not save the plan limits', errMsg(e)); }
  }

  start(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    this.ticker.unref?.();
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    for (const t of this.afterTurn.values()) clearTimeout(t);
    this.afterTurn.clear();
  }

  /** what is known for a scope, without reading anything (the snapshot) */
  list(scope: LoginScope = ''): ProviderLimits[] {
    this.load();
    const out: ProviderLimits[] = [];
    const ids = new Set(this.candidates(scope).map((p) => p.id));
    for (const [k, e] of this.entries) {
      const { scope: s, providerId } = splitKey(k);
      if (s === scope && ids.has(providerId)) out.push(e.limits);
    }
    // the credit's numbers are always current (they come with every heartbeat)
    return out.map((l) => (isAppubotAi(l.providerId) ? this.creditLimits(l.providerId) ?? l : l));
  }

  /**
   * `providers.limits`: read again what's stale (or everything, forced), then answer. A `limited` phone gets the
   * windows without the plan's name.
   */
  async request(scope: LoginScope, ids?: string[], refresh?: 'stale' | 'force', limited = false): Promise<{ limits: ProviderLimits[] }> {
    this.load();
    if (refresh) {
      const wanted = this.candidates(scope).filter((p) => !ids || ids.includes(p.id));
      await Promise.allSettled(wanted.map((p) => this.refreshOne(scope, p.id, refresh === 'force')));
    }
    let limits = this.list(scope);
    if (ids) limits = limits.filter((l) => ids.includes(l.providerId));
    if (limited) limits = limits.map(({ plan: _plan, ...rest }) => rest);
    return { limits };
  }

  /** Claude Code's word on its limits, from a running session (the runtime's `rateLimit` op) */
  noteRateLimit(providerId: string, scope: LoginScope, info: ClaudeRateLimitInfo, modelId?: string): void {
    this.load();
    if (providerBase(providerId) !== 'claude-code' || isAppubotAi(providerId)) return;
    const key = keyOf(scope, providerId);
    const prev = this.entries.get(key);
    const next = applyClaudeRateLimit(prev?.limits.status === 'unavailable' ? undefined : prev?.limits, providerId, info, modelId);
    // an answer that said "no plan limits" stays: a live event from an API-key session would be odd, but the CLI knows better
    if (prev?.limits.status === 'unavailable' && !next.windows.length) return;
    this.put(key, { ...prev, limits: next });
  }

  /** a turn on this agent ended: Codex wrote the bucket it used; every agent is read again a little later */
  noteTurnEnd(providerId: string, scope: LoginScope): void {
    this.load();
    this.lastTurnAt = Date.now();
    const provider = this.candidates(scope).find((p) => p.id === providerId);
    if (!provider || isAppubotAi(providerId)) return;
    const key = keyOf(scope, providerId);
    if (providerBase(providerId) === 'codex') void this.readCodexRollout(scope, providerId).catch((e) => this.ctx.log.warn('limits: codex rollout', errMsg(e)));
    const t = this.afterTurn.get(key);
    if (t) clearTimeout(t);
    const timer = setTimeout(() => {
      this.afterTurn.delete(key);
      void this.refreshOne(scope, providerId, false).catch(() => undefined);
    }, AFTER_TURN_MS);
    timer.unref?.();
    this.afterTurn.set(key, timer);
  }

  /* ---------------------------------------------------------------- internals */

  /** the agents whose limits are worth reading: installed and on, of a kind that has plan limits, or AppuBot AI */
  private candidates(scope: LoginScope): Provider[] {
    let list: Provider[] = [];
    try { list = this.ctx.s.providers.list(scope); } catch (e) { this.ctx.log.warn('limits: providers', errMsg(e)); }
    return list.filter((p) => (p.installed && p.enabled !== false && (AGENTS.has(kindOf(p)) || isAppubotAi(p.id))));
  }

  /** the home the scope's agents read their files from (a member's own on a team's computer) */
  private homeFor(scope: LoginScope): string {
    return this.ctx.s.logins.homeOf(scope) ?? userHome(this.ctx.deps.homeDir);
  }

  private creditLimits(providerId: string): ProviderLimits | undefined {
    const status = this.ctx.s.credit?.status();
    return status ? limitsFromCredit(providerId, status) : undefined;
  }

  private put(key: string, entry: Entry): void {
    const before = JSON.stringify(this.entries.get(key)?.limits);
    this.entries.set(key, entry);
    if (JSON.stringify(entry.limits) === before) return;
    this.save();
    const { scope } = splitKey(key);
    if (!scope) this.ctx.bus.emit('providers.limits', this.list(''));
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const inUse = !!this.ctx.deps.isAppFocused?.() || now - this.lastTurnAt < IN_USE_MS;
    const poll = inUse && now - this.lastPollAt >= POLL_MS;
    if (poll) this.lastPollAt = now;
    for (const [key, e] of this.entries) {
      const { scope, providerId } = splitKey(key);
      if (isAppubotAi(providerId)) continue;
      // a window reset while nobody looked: its numbers refilled, so read them soon after
      const reset = e.limits.windows.some((w) => w.resetsAt && w.resetsAt + AFTER_RESET_MS <= now && w.resetsAt + AFTER_RESET_MS + TICK_MS > now);
      const stale = now - e.limits.updatedAt > STALE_MS;
      if ((reset && inUse) || (poll && stale)) void this.refreshOne(scope, providerId, false).catch(() => undefined);
    }
  }

  /** read one agent's limits unless read recently or backing off; never two reads of the same agent at once */
  private refreshOne(scope: LoginScope, providerId: string, force: boolean): Promise<void> {
    const key = keyOf(scope, providerId);
    const running = this.inflight.get(key);
    if (running) return running;
    const e = this.entries.get(key);
    const now = Date.now();
    if (isAppubotAi(providerId)) {
      const l = this.creditLimits(providerId);
      if (l) this.put(key, { limits: l, fetchedAt: now });
      return Promise.resolve();
    }
    if (!force) {
      if (e?.fetchedAt && now - e.fetchedAt < MIN_GAP_MS) return Promise.resolve();
      if (e?.failedAt && now - e.failedAt < BACKOFF_MS) return Promise.resolve();
      if (e && now - e.limits.updatedAt < STALE_MS && e.limits.status === 'ok') return Promise.resolve();
    } else if (e?.fetchedAt && now - e.fetchedAt < FORCE_GAP_MS) return Promise.resolve();
    const p = this.read(scope, providerId).finally(() => { if (this.inflight.get(key) === p) this.inflight.delete(key); });
    this.inflight.set(key, p);
    return p;
  }

  private async read(scope: LoginScope, providerId: string): Promise<void> {
    const key = keyOf(scope, providerId);
    const prev = this.entries.get(key);
    const startedAt = Date.now();
    const fail = (message: string) => {
      this.ctx.log.warn(`limits: ${providerId}: ${message}`);
      const kept = prev?.limits.windows.length ? prev.limits : undefined;
      this.put(key, { limits: { ...(kept ?? { providerId, windows: [], source: 'none' as const }), status: kept ? 'error' as const : 'error' as const, message, updatedAt: kept?.updatedAt ?? startedAt }, fetchedAt: startedAt, failedAt: Date.now() });
    };
    try {
      const provider = this.ctx.s.providers.list(scope).find((p) => p.id === providerId);
      if (provider?.auth?.state === 'logged_out') {
        this.put(key, { limits: { providerId, status: 'signed_out', windows: [], updatedAt: Date.now(), source: 'none' }, fetchedAt: startedAt });
        return;
      }
      const spec = this.ctx.runtime.getProviders().find((s) => s.id === providerId);
      if (!spec) return fail('the agent is not set up');
      const base = kindOf(spec);
      const env = await this.envFor(spec, scope);
      const cwd = join(this.ctx.paths.dataDir, 'agent-probe');
      const now = () => Date.now();
      const unavailable = (message: string, source: ProviderLimits['source']) => this.put(key, { limits: { providerId, status: 'unavailable', message, windows: [], updatedAt: now(), source }, fetchedAt: startedAt });
      const webFetch = this.ctx.deps.fetch ?? fetch;
      if (base === 'claude-code') {
        const cli = await adapterCli(spec, env);
        if (!cli) return fail('Claude Code is not installed');
        const res = await this.fetch.claude({ cli, env, cwd });
        let limits = limitsFromClaudeUsage(providerId, res, now());
        if (limits.status === 'unavailable') {
          // a long-lived token (`claude setup-token`) can't read the plan's numbers; what its sessions say still counts
          const live = prev?.limits.windows.length && prev.limits.source === 'live' ? prev.limits : undefined;
          limits = live
            ? { ...live, status: 'live', message: 'Read from its sessions: this sign-in can’t ask Claude for the plan’s numbers' }
            : { ...limits, message: provider?.auth?.plan === 'API key' ? 'Your own API key: pay as you go, no plan limits' : 'No plan limits for this sign-in' };
        } else if (!limits.plan && provider?.auth?.plan && provider.auth.plan !== 'API key') limits.plan = provider.auth.plan;
        this.put(key, { limits, fetchedAt: startedAt });
        return;
      }
      if (base === 'codex') {
        const cli = await adapterCli(spec, env);
        if (!cli) return fail('Codex is not installed');
        const res = await this.fetch.codex({ cli, env, cwd });
        const limits = limitsFromCodex(providerId, res, now());
        if (!limits.windows.length) return fail('Codex answered without usage numbers');
        this.put(key, { limits, fetchedAt: startedAt });
        return;
      }
      if (base === 'opencode') {
        const res = await this.fetch.opencodeGo({ env, homeDir: this.homeFor(scope), fetch: webFetch });
        if (!res || res.status === 403) return unavailable(res ? 'No OpenCode Go subscription' : 'Your own providers: no plan limits', 'opencode-go');
        if (res.status === 401) return fail('OpenCode Go sign-in expired');
        if (res.status < 200 || res.status >= 300) return fail(`OpenCode Go answered ${res.status}`);
        const limits = limitsFromOpenCodeGo(providerId, res.body, now());
        if (!limits.windows.length) return fail('OpenCode Go answered without usage numbers');
        this.put(key, { limits, fetchedAt: startedAt });
        return;
      }
      if (base === 'grok') {
        // an API key (`XAI_API_KEY`) pays as it goes: Grok's billing has no period for it
        if (provider?.auth?.plan === 'API key' || env.XAI_API_KEY?.trim()) return unavailable('Your own API key: pay as you go, no plan limits', 'grok');
        const res = await this.fetch.grok({ ext: (method, params) => this.ctx.runtime.extMethod(providerId, method, params, { timeoutMs: GROK_TIMEOUT_MS, login: this.ctx.s.logins.loginEnv(scope) }) });
        const limits = limitsFromGrok(providerId, res, now());
        if (!limits.windows.length) return unavailable('No plan limits for this sign-in', 'grok');
        this.put(key, { limits, fetchedAt: startedAt });
        return;
      }
      if (base === 'cursor') {
        const res = await this.fetch.cursor({ env, homeDir: this.homeFor(scope), fetch: webFetch, keychain: !scope });
        if (!res.ok) return res.reason === 'none' ? unavailable('Not signed in to Cursor here', 'cursor') : fail('Cursor refused its sign-in: log in to it again');
        const limits = limitsFromCursor(providerId, res.value.usage, res.value.planInfo, now());
        if (!limits.windows.length) return fail('Cursor answered without usage numbers');
        this.put(key, { limits, fetchedAt: startedAt });
        return;
      }
      if (base === 'kimi') {
        const res = await this.fetch.kimi({ env, homeDir: this.homeFor(scope), fetch: webFetch });
        if (!res.ok) return res.reason === 'none' ? unavailable('Not signed in to Kimi Code here', 'kimi') : unavailable('No Kimi Code plan for this sign-in', 'kimi');
        const limits = limitsFromKimi(providerId, res.value, now());
        if (!limits.windows.length) return fail('Kimi answered without usage numbers');
        this.put(key, { limits, fetchedAt: startedAt });
        return;
      }
      if (base === 'antigravity-acp') {
        const version = spec.registry?.version ?? provider?.version;
        if (!version) return unavailable('AppuBot can’t tell this Antigravity’s version, so it doesn’t ask its quota', 'antigravity');
        if (compareVersions(version, ANTIGRAVITY_USAGE_MIN) < 0) return unavailable(`Antigravity ${ANTIGRAVITY_USAGE_MIN} or newer tells its quota (this is ${version})`, 'antigravity');
        const answer = await this.fetch.antigravity({ prompt: (text) => this.sidePrompt(providerId, scope, text, ANTIGRAVITY_TIMEOUT_MS) });
        const limits = limitsFromAntigravity(providerId, answer, now());
        if (limits.status === 'error') return fail(limits.message ?? 'Antigravity answered without its quota');
        this.put(key, { limits, fetchedAt: startedAt });
        return;
      }
    } catch (e) {
      fail(errMsg(e));
    }
  }

  /**
   * One prompt in a session of the agent's own (in `agent-probe`, no chat, no bridge: `ChatService.listenSession`
   * gets its text, its permission requests are refused), closed after the answer: Antigravity's `/usage`.
   */
  private async sidePrompt(providerId: string, scope: LoginScope, text: string, timeoutMs: number): Promise<string> {
    const cwd = join(this.ctx.paths.dataDir, 'agent-probe');
    mkdirSync(cwd, { recursive: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('the agent took too long to answer')), timeoutMs); });
    late.catch(() => undefined);
    const opening = this.ctx.runtime.createSession({ providerId, cwd, ...this.ctx.s.logins.loginEnv(scope) });
    let info: SessionInfo | undefined;
    try {
      info = await Promise.race([opening, late]);
      let answer = '';
      let part = -1;
      const off = this.ctx.s.chat.listenSession(info.id, (op: TurnOp) => {
        if (op.op !== 'delta' || op.partType !== 'text') return;
        if (part !== op.partIndex && answer) answer += '\n';
        part = op.partIndex;
        answer += op.delta;
      });
      try {
        await Promise.race([this.ctx.runtime.prompt(info.id, [{ type: 'text', text }]), late]);
      } finally { off(); }
      return answer;
    } finally {
      clearTimeout(timer);
      // a session that opens after the wait gave up is closed all the same
      void opening.then((s) => this.ctx.runtime.closeSession(s.id).catch(() => undefined), () => undefined);
    }
  }

  /** the agent's environment as its sessions get it: its profile folder, its saved keys and the scope's home */
  private async envFor(spec: ProviderSpec, scope: LoginScope): Promise<NodeJS.ProcessEnv> {
    const base = this.ctx.deps.homeDir ? { PATH: process.env.PATH, HOME: this.ctx.deps.homeDir } : process.env;
    const env = mergeEnv([withPath(base, await getPathString()), spec.env, this.ctx.s.providers.secretEnv(spec.id, scope)]);
    const home = this.ctx.s.logins.homeOf(scope);
    return home ? applyLoginHome(env, home, Object.values(PROFILE_HOME_ENV), !!spec.profile) : env;
  }

  /** the folder of Codex rollouts for an agent in a scope (`<CODEX_HOME>/sessions`) */
  private codexSessionsDir(spec: ProviderSpec, scope: LoginScope): string {
    const home = this.ctx.s.logins.homeOf(scope) ?? userHome(this.ctx.deps.homeDir);
    const codexHome = spec.env[PROFILE_HOME_ENV.codex!] || (this.ctx.deps.homeDir ? undefined : process.env[PROFILE_HOME_ENV.codex!]) || join(home, '.codex');
    return join(codexHome, 'sessions');
  }

  /** Codex writes the limits of the bucket a turn used into its rollout: the newest file's last such line */
  private async readCodexRollout(scope: LoginScope, providerId: string): Promise<void> {
    const spec = this.ctx.runtime.getProviders().find((s) => s.id === providerId);
    if (!spec) return;
    const file = await newestRollout(this.codexSessionsDir(spec, scope));
    if (!file) return;
    const payload = await lastRateLimitsLine(file);
    if (!payload) return;
    const key = keyOf(scope, providerId);
    const prev = this.entries.get(key);
    this.put(key, { ...prev, limits: applyCodexRateLimits(prev?.limits, providerId, payload) });
  }
}

/** the rollout written last: `sessions/<year>/<month>/<day>/*.jsonl`, the newest day's newest file */
export async function newestRollout(sessionsDir: string): Promise<string | undefined> {
  const latestDir = async (dir: string): Promise<string | undefined> => {
    let names: string[];
    try { names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && /^\d+$/.test(e.name)).map((e) => e.name); } catch { return undefined; }
    return names.sort((a, b) => Number(b) - Number(a))[0];
  };
  // the newest day folder that has a rollout (today's may not exist yet)
  const year = await latestDir(sessionsDir);
  if (!year) return undefined;
  for (const y of [year]) {
    const month = await latestDir(join(sessionsDir, y));
    if (!month) continue;
    const day = await latestDir(join(sessionsDir, y, month));
    if (!day) continue;
    const dir = join(sessionsDir, y, month, day);
    let files: string[];
    try { files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    let best: { path: string; mtime: number } | undefined;
    for (const f of files) {
      const path = join(dir, f);
      try { const st = await stat(path); if (!best || st.mtimeMs > best.mtime) best = { path, mtime: st.mtimeMs }; } catch { /* gone */ }
    }
    if (best) return best.path;
  }
  return undefined;
}

/** the last `token_count` line of a rollout that carries `rate_limits`, read from its tail */
export async function lastRateLimitsLine(path: string): Promise<unknown> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - ROLLOUT_TAIL);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes('"rate_limits"')) continue;
      const payload = codexRateLimitsOf(line);
      if (payload) return payload;
    }
    return null;
  } finally {
    await fh.close();
  }
}
