/**
 * Plan limits: what each agent's subscription has left, mapped to models, and the words for it (the model picker's
 * meters, Settings › Usage's "Plan limits", the phone's). Pure functions over protocol `ProviderLimits`; the computer
 * fills them from the agents' own answers (core `services/limits.ts`), through the readers here:
 * - Claude Code: its `get_usage` control answer (`limitsFromClaudeUsage`) and its live `rate_limit_event`s
 *   (`applyClaudeRateLimit`: fractions and epoch seconds, as Claude Code 2.1.3xx sends them)
 * - Codex: app-server `account/rateLimits/read` (camelCase) and a rollout's `token_count.rate_limits` (snake_case),
 *   both through `limitsFromCodex`
 * - OpenCode Go: `GET opencode.ai/zen/go/v1/usage` (`limitsFromOpenCodeGo`)
 * - Grok: its ACP `_x.ai/billing` answer (`limitsFromGrok`: the billing period's credit use)
 * - Cursor: its dashboard's `GetCurrentPeriodUsage` + `GetPlanInfo` (`limitsFromCursor`: Cursor's own models and the
 *   other models over the billing cycle, one total on a merged plan)
 * - Kimi: the Kimi CLI's `/usages` answer, in both of its shapes (`limitsFromKimi`)
 * - Google Antigravity: the Markdown its ACP server answers `/usage` with (`parseAntigravityUsage`,
 *   `limitsFromAntigravity`: a weekly and a 5-hour window per quota group, named models)
 * - AppuBot AI: the included credit (`limitsFromCredit`)
 * The readers for Grok, Cursor, Kimi and Antigravity follow OpenBot's (nightly-labs/openbot, PolyForm Noncommercial:
 * the shapes and rules were read there and written anew here).
 *
 * `parseResetTimestamp`, `formatResetDuration` and the window classification by length are ported from MonoCode
 * (https://github.com/hardbeat920/monocode, MIT, Copyright (c) 2026 Nick), as is the "low" threshold.
 */
import { LIMIT_LOW_LEFT, type CloudCredit, type LimitScope, type LimitWindow, type ProviderLimits } from '@appubot/protocol';
import { clockHours, clockTime } from './format';

export const SESSION_WINDOW_MINUTES = 300;
export const DAILY_WINDOW_MINUTES = 1_440;
export const WEEKLY_WINDOW_MINUTES = 10_080;
export const MONTHLY_WINDOW_MINUTES = 43_200;
const WINDOW_TOLERANCE_MINUTES = 1;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);
const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
  return undefined;
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const clamp = (n: number): number => Math.max(0, Math.round(n * 10) / 10);

/* ---------- ported from MonoCode (MIT) ---------- */

/** A reset time as epoch ms: from seconds or ms (1e10 tells them apart), or an ISO string; undefined when unreadable. */
export function parseResetTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number') return epochMs(value);
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const n = Number(value);
  if (Number.isFinite(n)) return epochMs(n);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}
function epochMs(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value > 10_000_000_000 ? Math.round(value) : Math.round(value * 1000);
}

/** "47m", "3h 54m", "6d 7h" (floored), "now" once past. */
export function formatResetDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const h = hours % 24;
    return h > 0 ? `${days}d ${h}h` : `${days}d`;
  }
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

export type WindowKind = 'session' | 'daily' | 'weekly' | 'monthly';
/** what a window of this length is, within a minute (Codex's free plan has a single 30-day one) */
export function classifyWindowMinutes(minutes: number | undefined): WindowKind | undefined {
  if (minutes === undefined || !Number.isFinite(minutes)) return undefined;
  const near = (n: number) => Math.abs(minutes - n) <= WINDOW_TOLERANCE_MINUTES;
  return near(SESSION_WINDOW_MINUTES) ? 'session' : near(DAILY_WINDOW_MINUTES) ? 'daily' : near(WEEKLY_WINDOW_MINUTES) ? 'weekly' : near(MONTHLY_WINDOW_MINUTES) ? 'monthly' : undefined;
}

/* ---------- labels ---------- */

/** "5-hour", "Day", "Week", "Month", else "<n>-hour" / "<n>-day" */
export function windowLabel(minutes: number | undefined): string {
  switch (classifyWindowMinutes(minutes)) {
    case 'session': return '5-hour';
    case 'daily': return 'Day';
    case 'weekly': return 'Week';
    case 'monthly': return 'Month';
  }
  if (minutes === undefined) return 'Limit';
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-min`;
}

/** the plan line's short word: "5h", "Week", "Month", "Day" */
export function windowShortLabel(w: Pick<LimitWindow, 'minutes' | 'label'>): string {
  switch (classifyWindowMinutes(w.minutes)) {
    case 'session': return '5h';
    case 'daily': return 'Day';
    case 'weekly': return 'Week';
    case 'monthly': return 'Month';
  }
  return w.label.split(' · ')[0] ?? w.label;
}

const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'] as const;
const titled = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** a Claude model's family (fable, opus, sonnet, haiku) from its id, name or description ("Opus 5.5 · …") */
export function modelFamily(...texts: (string | undefined)[]): string | undefined {
  const hay = texts.filter(Boolean).join(' ').toLowerCase();
  return FAMILIES.find((f) => new RegExp(`(^|[^a-z])${f}([^a-z]|$)`).test(hay));
}

/* ---------- Claude Code ---------- */

interface ClaudeUsageWindow { utilization?: number | null; resets_at?: string | null }
/** the `get_usage` control answer's rate-limit part (the SDK's `SDKControlGetUsageResponse`, read loosely) */
export interface ClaudeUsageResponse {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: {
    five_hour?: ClaudeUsageWindow | null;
    seven_day?: ClaudeUsageWindow | null;
    seven_day_opus?: ClaudeUsageWindow | null;
    seven_day_sonnet?: ClaudeUsageWindow | null;
    /** per-model weekly windows: supersede the Opus/Sonnet keys when present */
    model_scoped?: { display_name: string; utilization?: number | null; resets_at?: string | null }[];
    extra_usage?: { is_enabled: boolean; monthly_limit?: number | null; used_credits?: number | null; utilization?: number | null; currency?: string | null } | null;
  } | null;
}

/** "max" → "Max", "team" → "Team" */
export function claudePlanName(subscription: string | null | undefined): string | undefined {
  const s = str(subscription ?? undefined)?.toLowerCase();
  if (!s) return undefined;
  return s === 'pro' ? 'Pro' : s === 'max' ? 'Max' : s === 'team' ? 'Team' : s === 'enterprise' ? 'Enterprise' : titled(s);
}

/** what Claude Code answered to `get_usage`: a snapshot (`unavailable` for an API key or a token without the profile scope) */
export function limitsFromClaudeUsage(providerId: string, res: ClaudeUsageResponse, now = Date.now()): ProviderLimits {
  const plan = claudePlanName(res.subscription_type);
  const rl = res.rate_limits;
  if (!res.rate_limits_available || !rl) {
    return { providerId, ...(plan ? { plan } : {}), status: 'unavailable', windows: [], updatedAt: now, source: 'claude' };
  }
  const windows: LimitWindow[] = [];
  const add = (id: string, label: string, minutes: number, scope: LimitScope, w: ClaudeUsageWindow | null | undefined, models?: string) => {
    const used = num(w?.utilization ?? undefined);
    if (w == null || used === undefined) return;
    const resetsAt = parseResetTimestamp(w.resets_at ?? undefined);
    windows.push({ id, label, minutes, usedPercent: clamp(used), ...(resetsAt ? { resetsAt } : {}), scope, ...(models ? { models } : {}) });
  };
  add('five_hour', '5-hour', SESSION_WINDOW_MINUTES, { kind: 'all' }, rl.five_hour);
  add('seven_day', 'Week', WEEKLY_WINDOW_MINUTES, { kind: 'all' }, rl.seven_day);
  const scoped = rl.model_scoped ?? [];
  if (scoped.length) {
    for (const m of scoped) {
      const family = str(m.display_name)?.toLowerCase();
      if (!family) continue;
      add(`model:${family}`, `Week · ${titled(family)}`, WEEKLY_WINDOW_MINUTES, { kind: 'family', families: [family] }, m);
    }
  } else {
    add('seven_day_opus', 'Week · Opus', WEEKLY_WINDOW_MINUTES, { kind: 'family', families: ['opus'] }, rl.seven_day_opus);
    add('seven_day_sonnet', 'Week · Sonnet', WEEKLY_WINDOW_MINUTES, { kind: 'family', families: ['sonnet'] }, rl.seven_day_sonnet);
  }
  const x = rl.extra_usage;
  const extra = x
    ? {
      enabled: !!x.is_enabled,
      ...(num(x.used_credits ?? undefined) !== undefined ? { usedUsd: num(x.used_credits ?? undefined)! / 100 } : {}),
      ...(num(x.monthly_limit ?? undefined) !== undefined ? { limitUsd: num(x.monthly_limit ?? undefined)! / 100 } : {}),
      ...(str(x.currency ?? undefined) ? { currency: str(x.currency ?? undefined)!.toUpperCase() } : {}),
    }
    : undefined;
  return { providerId, ...(plan ? { plan } : {}), status: 'ok', windows, ...(extra ? { extra } : {}), updatedAt: now, source: 'claude' };
}

/** Claude Code's `rate_limit_event` as the runtime forwards it (`ClaudeRateLimitInfo`), read loosely */
export interface ClaudeRateLimitLike {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  overageStatus?: string;
  isUsingOverage?: boolean;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number; status?: string } | undefined>;
}

/** a live utilization (a fraction, 0..1 and past) as a percentage */
const livePercent = (fraction: number | undefined): number | undefined => (fraction === undefined || !Number.isFinite(fraction) ? undefined : clamp(fraction * 100));
const liveStatus = (s: string | undefined): LimitWindow['status'] | undefined => (s === 'rejected' ? 'rejected' : s === 'allowed_warning' ? 'warning' : s === 'allowed' ? 'ok' : undefined);

/**
 * What a session's `rate_limit_event` says, laid over the last snapshot: each window it names replaces the one with
 * that id. `seven_day_overage_included` is the weekly bucket of the model the session runs (`modelId`), so it only
 * counts when that model's family is known. Without a snapshot the result is `live` (updates with the next message).
 */
export function applyClaudeRateLimit(prev: ProviderLimits | undefined, providerId: string, info: ClaudeRateLimitLike, modelId?: string, now = Date.now()): ProviderLimits {
  const windows = new Map<string, LimitWindow>((prev?.windows ?? []).map((w) => [w.id, w]));
  const family = modelFamily(modelId);
  const put = (id: string, label: string, minutes: number, scope: LimitScope, utilization: number | undefined, resetsAt: number | undefined, status: string | undefined) => {
    const used = livePercent(utilization);
    if (used === undefined) return;
    const was = windows.get(id);
    const reset = parseResetTimestamp(resetsAt) ?? was?.resetsAt;
    const st = liveStatus(status);
    windows.set(id, { ...(was ?? {}), id, label, minutes, usedPercent: st === 'rejected' ? Math.max(100, used) : used, ...(reset ? { resetsAt: reset } : {}), scope, ...(st ? { status: st } : {}) });
  };
  const perModel = (id: string, utilization: number | undefined, resetsAt: number | undefined, status: string | undefined) => {
    if (!family) return;
    put(id, `Week · ${titled(family)}`, WEEKLY_WINDOW_MINUTES, { kind: 'family', families: [family] }, utilization, resetsAt, status);
  };
  const unified = info.unifiedWindows;
  if (unified && typeof unified === 'object') {
    for (const [key, w] of Object.entries(unified)) {
      if (!w) continue;
      if (key === 'five_hour') put('five_hour', '5-hour', SESSION_WINDOW_MINUTES, { kind: 'all' }, w.utilization, w.resetsAt, w.status);
      else if (key === 'seven_day') put('seven_day', 'Week', WEEKLY_WINDOW_MINUTES, { kind: 'all' }, w.utilization, w.resetsAt, w.status);
      else if (key === 'seven_day_overage_included') perModel(`model:${family}`, w.utilization, w.resetsAt, w.status);
    }
  } else if (info.rateLimitType) {
    const t = info.rateLimitType;
    if (t === 'five_hour') put('five_hour', '5-hour', SESSION_WINDOW_MINUTES, { kind: 'all' }, info.utilization, info.resetsAt, info.status);
    else if (t === 'seven_day') put('seven_day', 'Week', WEEKLY_WINDOW_MINUTES, { kind: 'all' }, info.utilization, info.resetsAt, info.status);
    else if (t === 'seven_day_opus' || t === 'seven_day_sonnet') {
      const fam = t.slice('seven_day_'.length);
      put(fam === 'opus' ? 'seven_day_opus' : 'seven_day_sonnet', `Week · ${titled(fam)}`, WEEKLY_WINDOW_MINUTES, { kind: 'family', families: [fam] }, info.utilization, info.resetsAt, info.status);
    } else if (t === 'seven_day_overage_included') perModel(`model:${family}`, info.utilization, info.resetsAt, info.status);
  }
  // the binding window is refused: whatever the number said, it is used up until its reset
  if (info.status === 'rejected' && info.rateLimitType && info.rateLimitType !== 'overage') {
    const id = info.rateLimitType === 'seven_day_overage_included' ? `model:${family}` : info.rateLimitType;
    const w = windows.get(id);
    if (w) windows.set(id, { ...w, usedPercent: Math.max(100, w.usedPercent), status: 'rejected', ...(parseResetTimestamp(info.resetsAt) ? { resetsAt: parseResetTimestamp(info.resetsAt)! } : {}) });
  }
  const extraKnown = info.overageStatus !== undefined || info.isUsingOverage !== undefined;
  const extra = extraKnown
    ? { ...(prev?.extra ?? {}), enabled: info.overageStatus === 'allowed' || info.overageStatus === 'allowed_warning' || !!info.isUsingOverage, ...(info.isUsingOverage !== undefined ? { inUse: info.isUsingOverage } : {}) }
    : prev?.extra;
  const status: ProviderLimits['status'] = prev?.status === 'ok' ? 'ok' : 'live';
  return {
    providerId, ...(prev?.plan ? { plan: prev.plan } : {}), status, windows: [...windows.values()],
    ...(extra ? { extra } : {}), updatedAt: now, source: prev?.status === 'ok' ? prev.source : 'live',
  };
}

/* ---------- Codex ---------- */

/** "plus" → "ChatGPT Plus", "free" → "Free", "team" → "ChatGPT Team" */
export function codexPlanName(planType: string | null | undefined): string | undefined {
  const p = str(planType ?? undefined)?.toLowerCase();
  if (!p || p === 'unknown') return undefined;
  const names: Record<string, string> = {
    free: 'Free', go: 'ChatGPT Go', plus: 'ChatGPT Plus', pro: 'ChatGPT Pro', prolite: 'ChatGPT Pro', promax: 'ChatGPT Pro', team: 'ChatGPT Team', business: 'ChatGPT Business',
    enterprise: 'ChatGPT Enterprise', edu: 'ChatGPT Edu', edu_plus: 'ChatGPT Edu', edu_pro: 'ChatGPT Edu',
  };
  if (names[p]) return names[p];
  if (p.startsWith('enterprise') || p.startsWith('ent')) return 'ChatGPT Enterprise';
  if (p.startsWith('self_serve_business')) return 'ChatGPT Business';
  if (p.startsWith('sci')) return 'ChatGPT';
  return titled(p);
}

/** a key by either spelling (app-server's camelCase, a rollout's snake_case) */
const pick = (r: Rec | undefined, ...keys: string[]): unknown => { for (const k of keys) if (r && r[k] !== undefined && r[k] !== null) return r[k]; return undefined; };

/** a Codex model's name for people: "gpt-5.5-codex-spark" → "GPT-5.5-Codex-Spark" */
export function codexModelLabel(slug: string): string {
  return slug.split('-').map((part, i) => (i === 0 && /^gpt/i.test(part) ? part.toUpperCase() : titled(part))).join('-');
}

/**
 * Codex's rate limits as one agent's: `account/rateLimits/read` (its `rateLimitsByLimitId`, else the legacy
 * `rateLimits`) or a rollout line's `rate_limits` (one bucket). A bucket with a `normalModelSlug` counts that model;
 * the plain one (`codex`) the rest.
 */
export function limitsFromCodex(providerId: string, res: unknown, now = Date.now()): ProviderLimits {
  const top = rec(res);
  const byId = rec(pick(top, 'rateLimitsByLimitId', 'rate_limits_by_limit_id'));
  const legacy = rec(pick(top, 'rateLimits', 'rate_limits'));
  // a rollout's payload is the bucket itself
  const buckets: Rec[] = byId && Object.keys(byId).length ? Object.values(byId).map(rec).filter((b): b is Rec => !!b) : legacy ? [legacy] : top && (top.primary !== undefined || top.limit_id !== undefined || top.limitId !== undefined) ? [top] : [];
  const windows: LimitWindow[] = [];
  let plan: string | undefined;
  let credits = false;
  let spendLimitReached = false;
  for (const b of buckets) {
    const limitId = str(pick(b, 'limitId', 'limit_id')) ?? 'codex';
    const slug = str(pick(b, 'normalModelSlug', 'normal_model_slug'));
    const name = str(pick(b, 'limitName', 'limit_name'));
    const scope: LimitScope = slug ? { kind: 'models', slugs: [slug] } : { kind: 'rest' };
    const suffix = slug ? ` · ${name ?? codexModelLabel(slug)}` : '';
    plan ??= codexPlanName(str(pick(b, 'planType', 'plan_type')));
    const c = rec(pick(b, 'credits'));
    if (c && (pick(c, 'hasCredits', 'has_credits') === true || pick(c, 'unlimited') === true)) credits = true;
    const reached = str(pick(b, 'rateLimitReachedType', 'rate_limit_reached_type'));
    if (pick(b, 'spendControlReached', 'spend_control_reached') === true || (reached && reached.startsWith('workspace'))) spendLimitReached = true;
    for (const part of ['primary', 'secondary'] as const) {
      const w = rec(pick(b, part));
      const used = num(pick(w, 'usedPercent', 'used_percent', 'used_percentage'));
      if (!w || used === undefined) continue;
      const minutes = num(pick(w, 'windowDurationMins', 'window_duration_mins', 'window_minutes'));
      const resetsAt = parseResetTimestamp(pick(w, 'resetsAt', 'resets_at'));
      // without a length, Codex's first window is the 5-hour one and its second the week (MonoCode's fallback)
      const mins = minutes ?? (part === 'primary' ? SESSION_WINDOW_MINUTES : WEEKLY_WINDOW_MINUTES);
      windows.push({
        id: `${limitId}:${part}`, label: `${windowLabel(mins)}${suffix}`, minutes: mins, usedPercent: clamp(used), ...(resetsAt ? { resetsAt } : {}), scope,
        ...(slug ? { models: name ?? codexModelLabel(slug) } : {}),
      });
    }
  }
  return { providerId, ...(plan ? { plan } : {}), status: 'ok', windows, ...(credits ? { credits } : {}), ...(spendLimitReached ? { spendLimitReached } : {}), updatedAt: now, source: 'codex' };
}

/** a rollout's newest `rate_limits` laid over the last snapshot (only the bucket it names moves) */
export function applyCodexRateLimits(prev: ProviderLimits | undefined, providerId: string, payload: unknown, now = Date.now()): ProviderLimits {
  const fresh = limitsFromCodex(providerId, payload, now);
  if (!prev) return { ...fresh, status: 'live', source: 'live' };
  const windows = new Map<string, LimitWindow>(prev.windows.map((w) => [w.id, w]));
  for (const w of fresh.windows) windows.set(w.id, w);
  return {
    ...prev, windows: [...windows.values()], ...(fresh.plan ? { plan: fresh.plan } : {}), ...(fresh.credits !== undefined ? { credits: fresh.credits } : {}),
    ...(fresh.spendLimitReached !== undefined ? { spendLimitReached: fresh.spendLimitReached } : {}), updatedAt: now,
  };
}

/* ---------- OpenCode Go ---------- */

/** OpenCode Go's models (its `opencode-go` provider: ids `opencode-go/<model>`) */
export const OPENCODE_GO_SLUG = 'opencode-go';

/** `{usage: {rolling, weekly, monthly: {status, percent, resetsAt}}}` (MonoCode's reading of the official endpoint) */
export function limitsFromOpenCodeGo(providerId: string, res: unknown, now = Date.now()): ProviderLimits {
  const top = rec(res);
  const usage = rec(top?.usage) ?? top;
  const windows: LimitWindow[] = [];
  const add = (key: string, id: string, minutes: number) => {
    const w = rec(usage?.[key]);
    const status = w?.status;
    if (!w || (status !== 'ok' && status !== 'rate-limited')) return;
    const used = num(pick(w, 'percent', 'usedPercent', 'used_percent'));
    if (used === undefined) return;
    const resetsAt = parseResetTimestamp(pick(w, 'resetsAt', 'resets_at'));
    windows.push({ id, label: windowLabel(minutes), minutes, usedPercent: clamp(used), ...(resetsAt ? { resetsAt } : {}), scope: { kind: 'models', slugs: [OPENCODE_GO_SLUG] }, ...(status === 'rate-limited' ? { status: 'rejected' as const } : {}), models: 'OpenCode Go models' });
  };
  add('rolling', 'go:rolling', SESSION_WINDOW_MINUTES);
  add('weekly', 'go:weekly', WEEKLY_WINDOW_MINUTES);
  add('monthly', 'go:monthly', MONTHLY_WINDOW_MINUTES);
  return { providerId, plan: 'OpenCode Go', status: 'ok', windows, updatedAt: now, source: 'opencode-go' };
}

/* ---------- Grok ---------- */

/**
 * Grok's `_x.ai/billing` answer: `subscription_tier` ("SuperGrok"), `config.currentPeriod {start, end, type}` and the
 * period's credit use, as `config.creditUsagePercent`, else `used` over `monthlyLimit` (cents as `{val}`; proto3 JSON
 * leaves a zero out, so no percentage and no limit above $0 means nothing used yet). One window of every model.
 */
export function limitsFromGrok(providerId: string, res: unknown, now = Date.now()): ProviderLimits {
  const config = rec(rec(res)?.config);
  const period = rec(config?.currentPeriod);
  const windows: LimitWindow[] = [];
  const cent = (key: string): number | null | undefined => {
    if (!config || config[key] === undefined) return undefined;
    const c = rec(config[key]);
    if (!c) return null;
    if (c.val === undefined) return 0;
    return num(c.val) ?? null;
  };
  let used: number | undefined;
  if (config?.creditUsagePercent !== undefined) used = num(config.creditUsagePercent);
  else {
    const limit = cent('monthlyLimit');
    const spent = cent('used');
    if (limit === undefined || limit === 0) used = 0;
    else if (limit !== null && limit > 0 && spent !== null) used = ((spent ?? 0) / limit) * 100;
  }
  if (config && period && used !== undefined) {
    const start = parseResetTimestamp(period.start);
    const end = parseResetTimestamp(period.end);
    const type = str(period.type ?? period.periodType)?.toLowerCase();
    const span = start && end && end > start ? Math.round((end - start) / 60_000) : undefined;
    const minutes = span ?? (type?.includes('week') ? WEEKLY_WINDOW_MINUTES : type?.includes('month') ? MONTHLY_WINDOW_MINUTES : undefined);
    const label = type?.includes('week') ? 'Week' : type?.includes('month') ? 'Month' : windowLabel(minutes);
    windows.push({ id: 'grok:period', label, ...(minutes ? { minutes } : {}), usedPercent: clamp(used), ...(end ? { resetsAt: end } : {}), scope: { kind: 'all' } });
  }
  const plan = str(rec(res)?.subscription_tier ?? config?.planName ?? config?.plan ?? config?.tier);
  return { providerId, ...(plan ? { plan: titled(plan) } : {}), status: 'ok', windows, updatedAt: now, source: 'grok' };
}

/* ---------- Cursor ---------- */

/** the models Cursor's included usage counts (`autoPercentUsed`) when its answer doesn't list them (`autoBucketModels`) */
export const CURSOR_OWN_MODELS = ['auto', 'default', 'composer'];

/**
 * Cursor's dashboard: `GetCurrentPeriodUsage` (`billingCycleStart/End` in ms, Connect JSON's int64 as strings;
 * `planUsage.autoPercentUsed/apiPercentUsed/totalPercentUsed`; `autoBucketModels`, the ids the included usage
 * counts) and `GetPlanInfo` (`planInfo.planName`; `isMerged`: the included usage covers every model as one, so only
 * the total counts, as in Cursor's app). Split, the included models get the first window and every other model the
 * second; the window is the billing cycle (a week on today's plans).
 */
export function limitsFromCursor(providerId: string, usage: unknown, planInfo: unknown, now = Date.now()): ProviderLimits {
  const top = rec(usage);
  const plan = rec(top?.planUsage);
  const infoTop = rec(planInfo);
  const info = rec(infoTop?.planInfo) ?? infoTop;
  const windows: LimitWindow[] = [];
  if (top && plan) {
    const start = num(top.billingCycleStart);
    const end = num(top.billingCycleEnd);
    const minutes = start !== undefined && end !== undefined && end > start ? Math.round((end - start) / 60_000) : undefined;
    const resetsAt = end ? parseResetTimestamp(end) : undefined;
    const merged = infoTop?.isMerged === true;
    const auto = num(plan.autoPercentUsed);
    const api = num(plan.apiPercentUsed);
    const total = num(plan.totalPercentUsed);
    const listed = Array.isArray(top.autoBucketModels) ? top.autoBucketModels.filter((m): m is string => typeof m === 'string' && !!m.trim()) : [];
    const cycle = minutes ? windowLabel(minutes) : 'Billing cycle';
    const base = { ...(minutes ? { minutes } : {}), ...(resetsAt ? { resetsAt } : {}) };
    const split = !merged && (auto !== undefined || api !== undefined);
    if (split) {
      if (auto !== undefined) windows.push({ id: 'cursor:auto', label: `${cycle} · Included models`, ...base, usedPercent: clamp(auto), scope: { kind: 'models', slugs: listed.length ? listed : CURSOR_OWN_MODELS }, models: 'Auto, Composer and the other models the plan includes' });
      if (api !== undefined) windows.push({ id: 'cursor:api', label: `${cycle} · Other models`, ...base, usedPercent: clamp(api), scope: { kind: 'rest' } });
    } else if (total !== undefined) windows.push({ id: 'cursor:total', label: cycle, ...base, usedPercent: clamp(total), scope: { kind: 'all' } });
  }
  const planName = str(info?.planName ?? info?.membershipType ?? info?.plan);
  return { providerId, ...(planName ? { plan: titled(planName) } : {}), status: 'ok', windows, updatedAt: now, source: 'cursor' };
}

/* ---------- Kimi ---------- */

const KIMI_UNIT_MINUTES: Record<string, number> = { TIME_UNIT_MINUTE: 1, TIME_UNIT_HOUR: 60, TIME_UNIT_DAY: 1_440, TIME_UNIT_WEEK: 10_080 };

/**
 * The Kimi CLI's `/usages` answer, in both shapes: the older one has the weekly quota in `usage` and the rolling
 * windows in `limits[]` (`window {duration, timeUnit}` + `detail {limit, used | remaining, resetTime}`, counts as
 * strings), the newer one `usages.limit_5h` / `limit_7d` (`used_ratio` 0..1, `reset_time`). The shortest window of
 * `limits[]` is the rolling 5-hour one. Every window counts every model.
 */
export function limitsFromKimi(providerId: string, res: unknown, now = Date.now()): ProviderLimits {
  const top = rec(res);
  const windows: LimitWindow[] = [];
  const detail = (v: unknown): { used: number; resetsAt?: number } | undefined => {
    const d = rec(v);
    if (!d) return undefined;
    const limit = num(d.limit);
    const used = num(d.used);
    const remaining = num(d.remaining);
    const spent = used ?? (limit !== undefined && remaining !== undefined ? limit - remaining : undefined);
    if (!limit || limit <= 0 || spent === undefined) return undefined;
    const resetsAt = parseResetTimestamp(d.resetTime ?? d.reset_time);
    return { used: (spent / limit) * 100, ...(resetsAt ? { resetsAt } : {}) };
  };
  const ratio = (v: unknown): { used: number; resetsAt?: number } | undefined => {
    const d = rec(v);
    const r = num(d?.used_ratio);
    if (!d || r === undefined) return undefined;
    const resetsAt = parseResetTimestamp(d.reset_time ?? d.resetTime);
    return { used: r * 100, ...(resetsAt ? { resetsAt } : {}) };
  };
  let rolling: { used: number; resetsAt?: number; minutes?: number } | undefined;
  const limits = Array.isArray(top?.limits) ? top!.limits : [];
  for (const item of limits) {
    const it = rec(item);
    const w = rec(it?.window);
    const unit = w ? KIMI_UNIT_MINUTES[String(w.timeUnit)] : undefined;
    const duration = num(w?.duration);
    const minutes = unit && duration !== undefined ? duration * unit : undefined;
    const d = detail(it?.detail ?? it);
    if (d && (!rolling || (minutes ?? Infinity) < (rolling.minutes ?? Infinity))) rolling = { ...d, ...(minutes ? { minutes } : {}) };
  }
  const usages = rec(top?.usages);
  const primary: { used: number; resetsAt?: number; minutes?: number } | undefined = rolling ?? ratio(usages?.limit_5h);
  const secondary = detail(top?.usage) ?? ratio(usages?.limit_7d);
  if (primary) windows.push({ id: 'kimi:rolling', label: windowLabel(primary.minutes ?? SESSION_WINDOW_MINUTES), minutes: primary.minutes ?? SESSION_WINDOW_MINUTES, usedPercent: clamp(primary.used), ...(primary.resetsAt ? { resetsAt: primary.resetsAt } : {}), scope: { kind: 'all' } });
  if (secondary) windows.push({ id: 'kimi:weekly', label: 'Week', minutes: WEEKLY_WINDOW_MINUTES, usedPercent: clamp(secondary.used), ...(secondary.resetsAt ? { resetsAt: secondary.resetsAt } : {}), scope: { kind: 'all' } });
  return { providerId, plan: 'Kimi Code', status: 'ok', windows, updatedAt: now, source: 'kimi' };
}

/* ---------- Google Antigravity ---------- */

export interface AntigravityQuotaGroup {
  name: string;
  /** the models Google lists for it ("Gemini Flash", "Gemini Pro"), as written */
  models: string[];
  fiveHour?: { usedPercent: number; resetsAt?: number };
  weekly?: { usedPercent: number; resetsAt?: number };
}

const AGY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Oct 29, 2026, 10:12 UTC", as the server writes it; else whatever `Date.parse` reads */
function antigravityReset(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}),? (\d{1,2}):(\d{2}) UTC$/.exec(text.trim());
  if (m) {
    const month = AGY_MONTHS.indexOf(m[1]!);
    if (month >= 0) {
      const ms = Date.UTC(Number(m[3]), month, Number(m[2]), Number(m[4]), Number(m[5]));
      if (Number.isFinite(ms)) return ms;
    }
  }
  return parseResetTimestamp(text);
}

/**
 * The "Quota Limits" section of Antigravity's `/usage` answer (Markdown for people):
 *   ### Quota Limits
 *   - **Gemini Models**
 *     *(Models within this group: Gemini Flash, Gemini Pro)*
 *     - **Weekly Limit Remaining:** 96% remaining (resets Oct 29, 2026, 10:12 UTC)
 *     - **Five Hour Limit Remaining:** 100% remaining (resets Oct 23, 2026, 16:48 UTC)
 * (1.4.3 writes "Five Hour", older builds "5-Hour".) `null` when the answer has no such section; `[]` when it says
 * the quota doesn't apply (an API key).
 */
export function parseAntigravityUsage(answer: string): AntigravityQuotaGroup[] | null {
  const groups: AntigravityQuotaGroup[] = [];
  let inSection = false;
  let seen = false;
  for (const raw of answer.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (/^#/.test(line)) { inSection = /^#+\s*Quota Limits\s*$/i.test(line); if (inSection) seen = true; continue; }
    if (!inSection) continue;
    const group = /^-\s+\*\*(.+?)\*\*\s*$/.exec(line)?.[1];
    if (group) { groups.push({ name: group.trim(), models: [] }); continue; }
    const g = groups[groups.length - 1];
    if (!g) continue;
    const listed = /^\s+\*\(Models within this group:\s*(.+?)\)\*\s*$/i.exec(line)?.[1];
    if (listed) { g.models = listed.split(',').map((m) => m.trim()).filter(Boolean); continue; }
    const bucket = /^\s+-\s+\*\*(.+?):\*\*\s+(\d+(?:\.\d+)?)% remaining(?:\s+\(resets ([^)]+)\))?\s*$/i.exec(line);
    if (!bucket) continue;
    const name = bucket[1]!;
    const w = { usedPercent: clamp(100 - Number(bucket[2])), ...(antigravityReset(bucket[3]) ? { resetsAt: antigravityReset(bucket[3])! } : {}) };
    const tighter = (cur: typeof w | undefined) => (cur && cur.usedPercent >= w.usedPercent ? cur : w);
    if (/\b(?:5|five)\s*-?\s*h/i.test(name)) g.fiveHour = tighter(g.fiveHour);
    else g.weekly = tighter(g.weekly);
  }
  return seen ? groups : null;
}

const slugOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Antigravity's quota as windows: a weekly and a 5-hour window per group that reports one, counting the models the
 * group lists by name (the `names` scope); a group that lists none counts every model when it is the Gemini group
 * (as one group did before Google split them), else its own name. An answer without the section is an error; one
 * saying the quota doesn't apply (an API key) is `unavailable`.
 */
export function limitsFromAntigravity(providerId: string, answer: string, now = Date.now()): ProviderLimits {
  const groups = parseAntigravityUsage(answer);
  if (groups === null) return { providerId, status: 'error', message: 'Antigravity answered without its quota section', windows: [], updatedAt: now, source: 'antigravity' };
  const windows: LimitWindow[] = [];
  const listed = groups.some((g) => g.models.length > 0);
  for (const g of groups) {
    const gemini = /^gemini\b/i.test(g.name);
    const scope: LimitScope = g.models.length ? { kind: 'names', names: g.models } : gemini && !listed ? { kind: 'all' } : { kind: 'names', names: [g.name] };
    const models = g.models.length ? g.models.join(', ') : undefined;
    const id = slugOf(g.name);
    if (g.fiveHour) windows.push({ id: `agy:${id}:5h`, label: `5-hour · ${g.name}`, minutes: SESSION_WINDOW_MINUTES, usedPercent: g.fiveHour.usedPercent, ...(g.fiveHour.resetsAt ? { resetsAt: g.fiveHour.resetsAt } : {}), scope, ...(models ? { models } : {}) });
    if (g.weekly) windows.push({ id: `agy:${id}:week`, label: `Week · ${g.name}`, minutes: WEEKLY_WINDOW_MINUTES, usedPercent: g.weekly.usedPercent, ...(g.weekly.resetsAt ? { resetsAt: g.weekly.resetsAt } : {}), scope, ...(models ? { models } : {}) });
  }
  if (!windows.length) {
    const notApplicable = /not applicable/i.test(answer);
    return { providerId, status: 'unavailable', message: notApplicable ? 'An API key sign-in: no plan quota' : 'No plan quota for this sign-in', windows: [], updatedAt: now, source: 'antigravity' };
  }
  return { providerId, status: 'ok', windows, updatedAt: now, source: 'antigravity' };
}

/* ---------- AppuBot AI ---------- */

/** the included credit as a plan limit: one month window of every model (`CloudCredit` amounts, no cents shown) */
export function limitsFromCredit(providerId: string, credit: CloudCredit, now = Date.now()): ProviderLimits {
  const used = credit.budgetCents > 0 ? (credit.usedCents / credit.budgetCents) * 100 : 100;
  const w: LimitWindow = {
    id: 'credit:month', label: 'Month', minutes: MONTHLY_WINDOW_MINUTES, usedPercent: clamp(used), resetsAt: credit.resetsAt, scope: { kind: 'all' },
    ...(credit.exhausted ? { status: 'rejected' as const } : {}),
  };
  return {
    providerId, plan: 'Launch bonus', status: 'ok', windows: [w], updatedAt: now, source: 'credit',
    ...(credit.ended ? { message: 'The launch bonus has ended.' } : {}),
  };
}

/* ---------- mapping to models ---------- */

export interface ModelRef { id: string; name?: string; description?: string }

/** `id` is the slug, or starts with it and a separator ("gpt-5.5-codex" vs "gpt-5.5-codex-spark"; "opencode-go/…") */
export function slugMatches(slug: string, id: string): boolean {
  const s = slug.toLowerCase(), i = id.toLowerCase();
  return i === s || i.startsWith(`${s}-`) || i.startsWith(`${s}[`) || i.startsWith(`${s}/`);
}

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
/** a model named in words ("Gemini Pro", "GPT-OSS"): every word of the name is a word of the model's id or name */
export function nameMatches(name: string, model: ModelRef): boolean {
  const have = new Set([...words(model.id), ...words(model.name ?? '')]);
  const want = words(name);
  return want.length > 0 && want.every((w) => have.has(w));
}

/** whether a window counts this model (`rest` windows count every model: `limitsForModel` drops them where a named one applies) */
export function windowCovers(w: LimitWindow, model: ModelRef): boolean {
  switch (w.scope.kind) {
    case 'all':
    case 'rest':
      return true;
    case 'family': {
      // the Default row names the model it runs in its description ("Opus 5.5 · …")
      const fam = modelFamily(model.id, model.name, model.description);
      return !!fam && w.scope.families.includes(fam);
    }
    case 'models':
      return w.scope.slugs.some((s) => slugMatches(s, model.id) || (!!model.name && slugMatches(s, model.name)));
    case 'names':
      return w.scope.names.some((n) => nameMatches(n, model));
  }
}

/** what's left of a window: 100 once its reset has passed (it refilled while nobody looked) */
export function windowLeft(w: LimitWindow, now = Date.now()): number {
  if (w.resetsAt && w.resetsAt <= now) return 100;
  return Math.max(0, Math.min(100, Math.round(100 - w.usedPercent)));
}
/** used up: nothing left, or the agent said it is refused, and its reset hasn't come */
export function windowOut(w: LimitWindow, now = Date.now()): boolean {
  if (w.resetsAt && w.resetsAt <= now) return false;
  return w.usedPercent >= 100 || w.status === 'rejected';
}

export type LimitTone = 'ok' | 'low' | 'out' | 'extra';

export interface ModelLimits {
  /** the windows that count this model, as given */
  windows: LimitWindow[];
  /** the least left of them, 0..100 */
  left: number;
  /** the tightest window (least left, then the soonest reset) */
  binding: LimitWindow;
  tone: LimitTone;
  /** used up: when it comes back (the latest reset among the used-up windows), if known */
  backAt?: number;
}

const byTightness = (now: number) => (a: LimitWindow, b: LimitWindow): number => (windowLeft(a, now) - windowLeft(b, now)) || ((a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity));

/** the tone of what's left: used up past `extra` means the agent carries on billed */
export function limitTone(left: number, out: boolean, extra: boolean): LimitTone {
  if (out) return extra ? 'extra' : 'out';
  return left <= LIMIT_LOW_LEFT ? 'low' : 'ok';
}

/** whether the agent carries on once a window is used up (Claude's extra usage, Codex's credits) */
export const carriesOn = (l: Pick<ProviderLimits, 'extra' | 'credits'>): boolean => !!l.extra?.enabled || !!l.credits;

/** The limits that apply to one model of an agent, or undefined when nothing is known for it. */
export function limitsForModel(limits: ProviderLimits | undefined, model: ModelRef, now = Date.now()): ModelLimits | undefined {
  if (!limits || limits.status === 'unavailable' || limits.status === 'signed_out' || !limits.windows.length) return undefined;
  let windows = limits.windows.filter((w) => windowCovers(w, model));
  if (windows.some((w) => w.scope.kind === 'models' || w.scope.kind === 'names')) windows = windows.filter((w) => w.scope.kind !== 'rest');
  if (!windows.length) return undefined;
  const sorted = [...windows].sort(byTightness(now));
  const binding = sorted[0]!;
  const left = windowLeft(binding, now);
  const outs = windows.filter((w) => windowOut(w, now));
  const out = outs.length > 0 || !!limits.spendLimitReached;
  const backAt = outs.reduce<number | undefined>((m, w) => (w.resetsAt && (!m || w.resetsAt > m) ? w.resetsAt : m), undefined);
  return { windows, left: out ? 0 : left, binding, tone: limits.spendLimitReached ? 'out' : limitTone(left, out, carriesOn(limits)), ...(backAt ? { backAt } : {}) };
}

/** The agent as a whole (the tab's dot): its tightest window of all. */
export function agentLimits(limits: ProviderLimits | undefined, now = Date.now()): ModelLimits | undefined {
  if (!limits || limits.status === 'unavailable' || limits.status === 'signed_out' || !limits.windows.length) return undefined;
  const sorted = [...limits.windows].sort(byTightness(now));
  const binding = sorted[0]!;
  const outs = limits.windows.filter((w) => windowOut(w, now));
  const out = outs.length > 0 || !!limits.spendLimitReached;
  const backAt = outs.reduce<number | undefined>((m, w) => (w.resetsAt && (!m || w.resetsAt > m) ? w.resetsAt : m), undefined);
  const left = windowLeft(binding, now);
  return { windows: limits.windows, left: out ? 0 : left, binding, tone: limits.spendLimitReached ? 'out' : limitTone(left, out, carriesOn(limits)), ...(backAt ? { backAt } : {}) };
}

/* ---------- words ---------- */

export const limitLeftText = (left: number): string => `${Math.round(left)}% left`;

/** "Back in 47m", or "Used up" when the reset isn't known */
export function backInText(backAt: number | undefined, now = Date.now()): string {
  return backAt && backAt > now ? `Back in ${formatResetDuration(backAt - now)}` : 'Used up';
}

/** "3h 10m" within a day, else "Thu 09:00", "3 Dec" past a week */
export function shortReset(resetsAt: number | undefined, now = Date.now()): string {
  if (!resetsAt) return '';
  const diff = resetsAt - now;
  if (diff <= 0) return 'now';
  if (diff < 24 * 3_600_000) return formatResetDuration(diff);
  if (diff < 7 * 86_400_000) return new Date(resetsAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', ...clockHours() });
  return new Date(resetsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "Resets in 3h 10m · 16:40" within a day, "Resets Thu 09:00" within a week, "Resets 3 Dec" after; '' unknown */
export function resetText(resetsAt: number | undefined, now = Date.now()): string {
  if (!resetsAt) return '';
  const diff = resetsAt - now;
  if (diff <= 0) return 'Resets soon';
  if (diff < 24 * 3_600_000) return `Resets in ${formatResetDuration(diff)} · ${clockTime(resetsAt)}`;
  return `Resets ${shortReset(resetsAt, now)}`;
}

/** "updated just now" / "updated 2 min ago" / "updated 3 h ago" / "updated 2 d ago" */
export function updatedAgoText(updatedAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (s < 60) return 'updated just now';
  const m = Math.round(s / 60);
  if (m < 60) return `updated ${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `updated ${h} h ago`;
  return `updated ${Math.round(h / 24)} d ago`;
}

/** The row's words for a model: "62%" (its meter beside), or "Back in 1h 20m" / "Used up" in red, "Extra usage" in amber. */
export function modelLimitText(m: ModelLimits, now = Date.now()): string {
  if (m.tone === 'extra') return 'Extra usage';
  if (m.tone === 'out') return backInText(m.backAt, now);
  return `${m.left}%`;
}

/** the plan's short word for the picker's line: "ChatGPT Plus" → "Plus", "OpenCode Go" → "Go", "Launch bonus" stays */
export function shortPlanName(plan: string): string {
  return plan.replace(/^(ChatGPT|Claude|OpenCode)\s+/, '');
}

export interface PlanLineItem { label: string; left: number; tone: LimitTone; resetsAt?: number }
export interface PlanLine { plan?: string; items: PlanLineItem[]; /** the soonest reset among them, as "3h 10m" */ resetIn?: string }

/** The picker's line under the tabs: the windows every model shares (`all`, `rest`), and the time to the soonest reset. */
export function planLine(limits: ProviderLimits | undefined, now = Date.now()): PlanLine | undefined {
  if (!limits || limits.status === 'unavailable' || limits.status === 'signed_out') return undefined;
  const shared = limits.windows.filter((w) => w.scope.kind === 'all' || w.scope.kind === 'rest');
  const items: PlanLineItem[] = shared.map((w) => {
    const left = windowLeft(w, now);
    const out = windowOut(w, now);
    return { label: windowShortLabel(w), left: out ? 0 : left, tone: limitTone(left, out, carriesOn(limits)), ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}) };
  });
  const soonest = shared.map((w) => w.resetsAt).filter((t): t is number => !!t && t > now).sort((a, b) => a - b)[0];
  if (!items.length && !limits.plan) return undefined;
  return { ...(limits.plan ? { plan: limits.plan } : {}), items, ...(soonest ? { resetIn: formatResetDuration(soonest - now) } : {}) };
}

/**
 * The meter a model's row shows, or undefined when the plan line already says it: only a model counted by a window of
 * its own (Claude's "Week · Opus", a Codex model's bucket) whose value isn't one the plan line shows. When every row
 * would repeat the shared windows (the launch bonus's Month, a plan with only 5h/Week), the plan line says it once.
 */
export function modelRowLimits(limits: ProviderLimits | undefined, model: ModelLimits | undefined, now = Date.now()): ModelLimits | undefined {
  if (!limits || !model) return undefined;
  const isShared = (w: LimitWindow) => w.scope.kind === 'all' || w.scope.kind === 'rest';
  if (!model.windows.some((w) => !isShared(w))) return undefined;
  const items = planLine(limits, now)?.items ?? [];
  return items.some((it) => it.left === model.left && it.tone === model.tone) ? undefined : model;
}

/** Which of an agent's models a window counts, for people: "Opus 5.5, Opus 4.8", "Every model", "Other models". */
export function windowModelsText(w: LimitWindow, models: readonly ModelRef[] = []): string {
  if (w.scope.kind === 'all') return 'Every model';
  if (w.scope.kind === 'rest') return models.length ? 'Other models' : 'Every other model';
  if (w.models) return w.models;
  const named = models.filter((m) => windowCovers(w, m) && !(m.name ?? '').toLowerCase().startsWith('default')).map((m) => m.name ?? m.id);
  if (named.length) return named.join(', ');
  return w.scope.kind === 'family' ? w.scope.families.map(titled).join(', ') : w.scope.kind === 'names' ? w.scope.names.join(', ') : w.scope.slugs.map(codexModelLabel).join(', ');
}

/** "$12.40 of $50 this month", "$12.40 this month", "On", "Off" */
export function extraUsageText(extra: NonNullable<ProviderLimits['extra']>): string {
  const money = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
  if (extra.usedUsd !== undefined && extra.limitUsd !== undefined) return `${money(extra.usedUsd)} of ${money(extra.limitUsd)} this month`;
  if (extra.usedUsd !== undefined) return `${money(extra.usedUsd)} this month`;
  return extra.enabled ? 'On' : 'Off';
}

/** the Settings card's status line */
export function limitsStatusText(l: ProviderLimits, now = Date.now()): string {
  switch (l.status) {
    case 'ok': return titled(updatedAgoText(l.updatedAt, now));
    case 'live': return 'From its last message; updates as it works';
    case 'error': return l.message ? `Couldn’t read it: ${l.message}` : 'Couldn’t read it';
    case 'unavailable': return l.message ?? 'No plan limits';
    case 'signed_out': return 'Not signed in';
  }
}

/** "Read from Claude and ChatGPT with your own sign-in." from where the numbers came */
export function limitsSourcesText(limits: readonly ProviderLimits[]): string {
  const names: string[] = [];
  const add = (n: string) => { if (!names.includes(n)) names.push(n); };
  for (const l of limits) {
    if (l.status === 'unavailable' || l.status === 'signed_out') continue;
    if (l.source === 'claude' || l.source === 'live' && l.windows.length) add(l.providerId.startsWith('codex') ? 'ChatGPT' : 'Claude');
    else if (l.source === 'codex') add('ChatGPT');
    else if (l.source === 'opencode-go') add('OpenCode Go');
    else if (l.source === 'grok') add('Grok');
    else if (l.source === 'cursor') add('Cursor');
    else if (l.source === 'kimi') add('Kimi');
    else if (l.source === 'antigravity') add('Google');
    else if (l.source === 'credit') add('your plan');
  }
  if (!names.length) return 'Read from the agents with your own sign-in.';
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Read from ${list} with your own sign-in.`;
}
