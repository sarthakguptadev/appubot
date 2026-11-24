/**
 * Settings › Usage, the pure part: reading token counts out of the agents' own logs (Claude Code, Codex, Grok, Pi and
 * Gemini CLI's session files; OpenCode's and GitHub Copilot's rows, read from their SQLite databases by usageSqlite.ts),
 * the price table, and adding it all up by hour/day, model and agent. `UsageService` (usage.ts) does the file reading.
 *
 * Ported in spirit from T3 Code's usage readers (MIT; apps/server/src/provider/Drivers/claudeUsage.ts and
 * codexUsage.ts, packages/provider-grok, provider-opencode and provider-pi's src/server/usage.ts,
 * apps/server/src/usage/usagePricing.ts): Claude Code logs one line per content block, each repeating the message's
 * whole `usage`, so lines are deduplicated by message id + request id; Codex's `token_count` events carry no model
 * (it comes from the latest `turn_context`) and its `input_tokens` include the cached ones; Grok's `turn_completed`
 * updates carry a turn's usage per model with xAI's own cost; OpenCode's assistant messages and Pi's entries may carry
 * a cost of their own (zero means unknown). Gemini CLI's and Copilot's readers are AppuBot's own.
 */
import type { UsageAgentRow, UsageBucket, UsageModelRow, UsageRange, UsageScope, UsageSummary, UsageTotals } from '@appubot/protocol';

/** One model request, as read from a log. */
export interface UsageRecord {
  /** dedupe key across every file (absent: never a duplicate) */
  key?: string;
  ts: number;
  model: string;
  /** uncached input */
  input: number;
  output: number;
  cacheRead: number;
  /** all cache writes; `cacheWrite1h` of them at the 1-hour price */
  cacheWrite: number;
  cacheWrite1h: number;
  /** it ran in a bot's folder */
  bot: boolean;
  /** what the agent itself says it cost, USD (taken over the price table) */
  costUsd?: number;
  /** model calls it stands for (Grok logs a whole turn at once); 1 when absent */
  requests?: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const tsOf = (v: unknown): number | undefined => {
  const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(t) ? t : undefined;
};

/**
 * Whether `cwd` is inside the bots' folder. On Windows a folder is the same whatever its case, and agents log it their
 * own way (`C:\Users\…` or `c:/Users/…`), so both are compared as Windows does.
 */
export function inBotsRoot(cwd: unknown, botsRoot: string | undefined, platform: NodeJS.Platform = process.platform): boolean {
  if (!botsRoot || typeof cwd !== 'string') return false;
  const norm = (p: string) => {
    const s = platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p;
    return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
  };
  const root = norm(botsRoot);
  const dir = norm(cwd);
  return dir === root || dir.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/* ---------------- Claude Code ---------------- */

/** Claude Code's model for local placeholders that never reached the API */
const CLAUDE_SYNTHETIC = '<synthetic>';

/** A line of a Claude Code transcript (`<config>/projects/**\/*.jsonl`): its assistant message's usage, else null. */
export function parseClaudeLine(line: string, botsRoot?: string): UsageRecord | null {
  let o: unknown;
  try { o = JSON.parse(line); } catch { return null; }
  const rec = obj(o);
  if (!rec || rec.type !== 'assistant') return null;
  const msg = obj(rec.message);
  const usage = obj(msg?.usage);
  if (!msg || !usage) return null;
  const model = typeof msg.model === 'string' ? msg.model : '';
  if (!model || model === CLAUDE_SYNTHETIC) return null;
  const ts = tsOf(rec.timestamp);
  if (ts === undefined) return null;
  const id = typeof msg.id === 'string' ? msg.id : undefined;
  const req = typeof rec.requestId === 'string' ? rec.requestId : undefined;
  const cacheWrite = num(usage.cache_creation_input_tokens);
  const split = obj(usage.cache_creation);
  const r: UsageRecord = {
    ts, model,
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite,
    cacheWrite1h: Math.min(cacheWrite, num(split?.ephemeral_1h_input_tokens)),
    bot: inBotsRoot(rec.cwd, botsRoot),
  };
  if (id || req) r.key = `claude:${id ?? ''}:${req ?? ''}`;
  return r.input + r.output + r.cacheRead + r.cacheWrite > 0 ? r : null;
}

/* ---------------- Codex ---------------- */

/** What a Codex rollout carries from line to line. */
export interface CodexState {
  model: string;
  bot: boolean;
  sawMeta: boolean;
  /** the last request's counts (an older event without totals repeated as is is a re-emission) */
  lastSig?: string;
}
export const codexState = (): CodexState => ({ model: '', bot: false, sawMeta: false });

interface CodexCounts { input: number; cached: number; cacheWrite: number; output: number; total: number }
function codexCounts(v: unknown): CodexCounts | undefined {
  const u = obj(v);
  if (!u || typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') return undefined;
  const c = { input: num(u.input_tokens), cached: num(u.cached_input_tokens), cacheWrite: num(u.cache_write_input_tokens), output: num(u.output_tokens), total: num(u.total_tokens) };
  return c.cached + c.cacheWrite <= c.input ? c : undefined;
}

/**
 * A line of a Codex rollout (`<CODEX_HOME>/sessions/**\/*.jsonl`): a request's usage from a `token_count` event, else
 * null (`session_meta` and `turn_context` only update `state`). The key is the session's running total plus this
 * request, so the same event re-emitted, or copied into a forked session, counts once.
 */
export function parseCodexLine(line: string, state: CodexState, botsRoot?: string): UsageRecord | null {
  let o: unknown;
  try { o = JSON.parse(line); } catch { return null; }
  const rec = obj(o);
  const p = obj(rec?.payload);
  if (!rec || !p) return null;
  if (rec.type === 'session_meta') {
    // only the first: a forked session copies its parent's meta after its own
    if (!state.sawMeta) { state.sawMeta = true; state.bot = inBotsRoot(p.cwd, botsRoot); }
    return null;
  }
  if (rec.type === 'turn_context') {
    if (typeof p.model === 'string' && p.model) state.model = p.model;
    return null;
  }
  if (p.type !== 'token_count') return null;
  const info = obj(p.info);
  const ts = tsOf(rec.timestamp);
  if (!info || ts === undefined || !state.model) return null;
  const last = codexCounts(info.last_token_usage);
  if (!last || last.input + last.output === 0) return null; // a context-size report, not a request
  const total = codexCounts(info.total_token_usage);
  const sig = `${last.input},${last.cached},${last.cacheWrite},${last.output}`;
  if (!total) {
    if (sig === state.lastSig) return null;
    state.lastSig = sig;
  }
  return {
    key: total ? `codex:${total.input},${total.cached},${total.cacheWrite},${total.output}|${sig}` : undefined,
    ts, model: state.model,
    input: last.input - last.cached - last.cacheWrite,
    output: last.output,
    cacheRead: last.cached,
    cacheWrite: last.cacheWrite,
    cacheWrite1h: 0,
    bot: state.bot,
  };
}

/** A rollout line's `rate_limits` (a `token_count` event carries the limits of the bucket that answered), else null. */
export function codexRateLimitsOf(line: string): unknown {
  let o: unknown;
  try { o = JSON.parse(line); } catch { return null; }
  const p = obj(obj(o)?.payload);
  if (!p || p.type !== 'token_count') return null;
  const rl = obj(p.rate_limits);
  return rl && (rl.primary !== undefined || rl.limit_id !== undefined) ? rl : null;
}

/* ---------------- Grok ---------------- */

/** xAI's cost unit in Grok's logs: ticks per US dollar */
export const GROK_TICKS_PER_USD = 10_000_000_000;

interface GrokCounts { input: number; output: number; cached: number; cacheWrite: number; calls: number; ticks?: number }
function grokCounts(v: unknown): GrokCounts | undefined {
  const u = obj(v);
  if (!u) return undefined;
  const t = u.costUsdTicks;
  return {
    input: num(u.inputTokens), output: num(u.outputTokens), cached: num(u.cachedReadTokens), cacheWrite: num(u.cacheCreationTokens), calls: num(u.modelCalls),
    // zero is no cost known, like OpenCode's and Pi's
    ticks: typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : undefined,
  };
}

/**
 * A line of a Grok session's `updates.jsonl` (`<GROK_HOME>/sessions/<cwd>/<session>/`): a `turn_completed` update's
 * usage, one record per model (`usage.modelUsage`; without it the turn as model `grok`), else []. `inputTokens`
 * include the cached ones, as Codex's do. The cost is xAI's own (`costUsdTicks`); a model without its own gets a share
 * of what the turn's total leaves, by tokens. A turn may span several model calls (`modelCalls`).
 */
export function parseGrokLine(line: string, bot = false): UsageRecord[] {
  let o: unknown;
  try { o = JSON.parse(line); } catch { return []; }
  const rec = obj(o);
  const params = obj(rec?.params);
  const update = obj(params?.update);
  if (!rec || !params || !update || update.sessionUpdate !== 'turn_completed') return [];
  const usage = obj(update.usage);
  const top = grokCounts(usage);
  if (!usage || !top) return [];
  const at = obj(params._meta)?.agentTimestampMs;
  let ts = typeof at === 'number' && Number.isFinite(at) ? at : undefined;
  // the line's own stamp is in seconds
  if (ts === undefined && typeof rec.timestamp === 'number' && Number.isFinite(rec.timestamp)) ts = rec.timestamp > 1e12 ? rec.timestamp : rec.timestamp * 1000;
  if (ts === undefined) return [];
  const session = typeof params.sessionId === 'string' ? params.sessionId : '';
  // without a prompt id two turns can't be told apart, so no key
  const prompt = typeof update.prompt_id === 'string' && update.prompt_id ? update.prompt_id : undefined;
  const entries: { model: string; c: GrokCounts }[] = [];
  for (const [model, raw] of Object.entries(obj(usage.modelUsage) ?? {})) {
    const c = grokCounts(raw);
    if (model && c) entries.push({ model, c });
  }
  if (!entries.length) entries.push({ model: 'grok', c: top });
  const split = (c: GrokCounts) => {
    const input = Math.max(0, c.input - c.cached - c.cacheWrite);
    return { input, tokens: input + c.cached + c.cacheWrite + c.output };
  };
  let ticked = 0;
  let unticked = 0;
  for (const e of entries) {
    const { tokens } = split(e.c);
    if (!tokens) continue;
    if (e.c.ticks !== undefined) ticked += e.c.ticks;
    else unticked += tokens;
  }
  const left = top.ticks === undefined ? undefined : Math.max(0, top.ticks - ticked);
  const out: UsageRecord[] = [];
  for (const e of entries) {
    const { input, tokens } = split(e.c);
    if (!tokens) continue;
    const ticks = e.c.ticks ?? (left !== undefined && unticked > 0 ? (left * tokens) / unticked : undefined);
    const r: UsageRecord = {
      ts, model: e.model, input, output: e.c.output, cacheRead: e.c.cached, cacheWrite: e.c.cacheWrite, cacheWrite1h: 0, bot,
      requests: Math.max(1, e.c.calls),
    };
    if (prompt) r.key = `grok:${session}:${prompt}:${e.model}`;
    if (ticks !== undefined) r.costUsd = ticks / GROK_TICKS_PER_USD;
    out.push(r);
  }
  return out;
}

/* ---------------- OpenCode ---------------- */

/**
 * An OpenCode assistant message: the JSON of a `message` / `session_message` row in its `opencode.db`, or a legacy
 * `storage/message/**\/<id>.json` file, else null. `row` has what the row says beside it (id, `time_created`, the
 * session's folder). Reasoning tokens are billed as output, so they're added to it. A positive `cost` is OpenCode's
 * own figure (it writes zero for unknown rates and subscriptions).
 */
export function parseOpenCodeMessage(source: string, botsRoot?: string, row: { id?: string; created?: number; cwd?: string } = {}): UsageRecord | null {
  let o: unknown;
  try { o = JSON.parse(source); } catch { return null; }
  const m = obj(o);
  if (!m || (m.role !== undefined && m.role !== 'assistant')) return null;
  const tokens = obj(m.tokens);
  const cache = obj(tokens?.cache);
  const ref = obj(m.model);
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  const model = text(ref?.id) || text(ref?.modelID) || text(m.modelID);
  const created = obj(m.time)?.created ?? row.created;
  if (!tokens || !model || typeof created !== 'number' || !Number.isFinite(created)) return null;
  const r: UsageRecord = {
    ts: created, model,
    input: num(tokens.input),
    output: num(tokens.output) + num(tokens.reasoning),
    cacheRead: num(cache?.read),
    cacheWrite: num(cache?.write),
    cacheWrite1h: 0,
    bot: inBotsRoot(text(obj(m.path)?.cwd) || row.cwd, botsRoot),
  };
  if (r.input + r.output + r.cacheRead + r.cacheWrite === 0) return null;
  const id = row.id || text(m.id);
  if (id) r.key = `opencode:${id}`;
  if (typeof m.cost === 'number' && Number.isFinite(m.cost) && m.cost > 0) r.costUsd = m.cost;
  return r;
}

/* ---------------- Pi ---------------- */

/** What a Pi session file carries from line to line. */
export interface PiState { sessionId: string; bot: boolean }
export const piState = (): PiState => ({ sessionId: '', bot: false });

/** Pi's usage that belongs to no model (tool results, compactions, branch summaries) */
export const PI_OTHER_MODEL = 'Tools and summaries';

/**
 * A line of a Pi session (`<PI_CODING_AGENT_DIR>/sessions/**\/*.jsonl`): the usage of an assistant message, a tool
 * result, a `usage` entry, a compaction or a branch summary, else null (the `session` header only updates `state`).
 * Pi's input and cache counts are already apart. A positive `usage.cost.total` is Pi's own figure. Forks keep entry ids
 * and times, so the key is id + time + model.
 */
export function parsePiLine(line: string, state: PiState, botsRoot?: string): UsageRecord | null {
  let o: unknown;
  try { o = JSON.parse(line); } catch { return null; }
  const e = obj(o);
  if (!e) return null;
  if (e.type === 'session') {
    if (typeof e.id === 'string') state.sessionId = e.id;
    state.bot = inBotsRoot(e.cwd, botsRoot);
    return null;
  }
  if (typeof e.id !== 'string' || !e.id || typeof e.timestamp !== 'string') return null;
  let src: Record<string, unknown> | undefined;
  if (e.type === 'message') {
    src = obj(e.message);
    if (src?.role !== 'assistant' && src?.role !== 'toolResult') return null;
  } else if (e.type === 'usage' || e.type === 'compaction' || e.type === 'branch_summary') {
    src = e;
  }
  const usage = obj(src?.usage);
  const ts = tsOf(e.timestamp);
  if (!src || !usage || ts === undefined) return null;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  // only assistant messages and `usage` entries name their model
  const named = src.role !== 'toolResult' && e.type !== 'compaction' && e.type !== 'branch_summary';
  const id = str(src.responseModel) || str(src.model);
  const model = named && str(src.provider) && id ? `${str(src.provider)}/${id}` : PI_OTHER_MODEL;
  const cost = obj(usage.cost)?.total;
  const r: UsageRecord = {
    key: JSON.stringify(['pi', e.id, e.timestamp, model]),
    ts, model,
    input: num(usage.input),
    output: num(usage.output),
    cacheRead: num(usage.cacheRead),
    cacheWrite: num(usage.cacheWrite),
    cacheWrite1h: 0,
    bot: state.bot,
  };
  if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) r.costUsd = cost;
  return r.input + r.output + r.cacheRead + r.cacheWrite > 0 || r.costUsd ? r : null;
}

/* ---------------- Gemini CLI ---------------- */

/**
 * A Gemini CLI chat message (`~/.gemini/tmp/<project>/chats/`: a `session-*.json` file's `messages`, or a line of a
 * `session-*.jsonl` file, which appends a message again whole when it changes): a `gemini` reply's `tokens`, else
 * null. They are Gemini's usage metadata as is: `input` (the prompt) includes `cached`, `thoughts` are billed as output
 * and `tool` (tool-use prompt) as input. Message ids are random UUIDs, so a copied message counts once.
 */
export function parseGeminiMessage(v: unknown, bot = false): UsageRecord | null {
  const m = obj(v);
  if (!m || m.type !== 'gemini') return null;
  const t = obj(m.tokens);
  const ts = tsOf(m.timestamp);
  if (!t || typeof m.model !== 'string' || !m.model || ts === undefined) return null;
  const prompt = num(t.input);
  const cached = Math.min(num(t.cached), prompt);
  const r: UsageRecord = {
    ts, model: m.model,
    input: prompt - cached + num(t.tool),
    output: num(t.output) + num(t.thoughts),
    cacheRead: cached,
    cacheWrite: 0,
    cacheWrite1h: 0,
    bot,
  };
  if (typeof m.id === 'string' && m.id) r.key = `gemini:${m.id}`;
  return r.input + r.output + r.cacheRead > 0 ? r : null;
}

/** a Gemini CLI `.jsonl` chat line (patches, rewinds and metadata lines are never usage) */
export function parseGeminiLine(line: string, bot = false): UsageRecord | null {
  try { return parseGeminiMessage(JSON.parse(line), bot); } catch { return null; }
}

/** a whole Gemini CLI `.json` chat file */
export function parseGeminiFile(text: string, bot = false): UsageRecord[] {
  let o: unknown;
  try { o = JSON.parse(text); } catch { return []; }
  const messages = obj(o)?.messages;
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => parseGeminiMessage(m, bot)).filter((r): r is UsageRecord => !!r);
}

/* ---------------- GitHub Copilot ---------------- */

/** A row of Copilot CLI's `assistant_usage_events` table (`~/.copilot/session-store.db`), with its session's folder. */
export interface CopilotUsageRow {
  id: unknown;
  model: unknown;
  input_tokens: unknown;
  output_tokens: unknown;
  cache_read_tokens: unknown;
  cache_write_tokens: unknown;
  token_details_json?: unknown;
  created_at: unknown;
  cwd?: unknown;
}

/**
 * One Copilot model request, else null. `input_tokens` include the cache's, as OpenAI's do; the uncached part is the
 * row's own `token_details_json` "input" count when it has one. Copilot bills premium requests, not tokens, so the
 * cost is an estimate at the model's API price like every other.
 */
export function parseCopilotRow(row: CopilotUsageRow, botsRoot?: string): UsageRecord | null {
  // the column's default is SQLite's datetime('now'): UTC without a zone
  const at = row.created_at;
  const ts = tsOf(typeof at === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(at) ? `${at.replace(' ', 'T')}Z` : at);
  if (typeof row.model !== 'string' || !row.model || ts === undefined) return null;
  const cacheRead = num(row.cache_read_tokens);
  const cacheWrite = num(row.cache_write_tokens);
  let input = Math.max(0, num(row.input_tokens) - cacheRead - cacheWrite);
  if (typeof row.token_details_json === 'string') {
    try {
      const details: unknown = JSON.parse(row.token_details_json);
      const own = Array.isArray(details) ? details.map(obj).find((d) => d?.tokenType === 'input') : undefined;
      if (own && typeof own.tokenCount === 'number') input = num(own.tokenCount);
    } catch { /* keep the subtraction */ }
  }
  const r: UsageRecord = {
    ts, model: row.model, input, output: num(row.output_tokens), cacheRead, cacheWrite, cacheWrite1h: 0,
    bot: inBotsRoot(row.cwd, botsRoot),
  };
  if (typeof row.id === 'string' || typeof row.id === 'number') r.key = `copilot:${row.id}`;
  return r.input + r.output + r.cacheRead + r.cacheWrite > 0 ? r : null;
}

/* ---------------- prices ---------------- */

/** USD per million tokens. `cacheWrite`: a 5-minute cache write (Claude's 1-hour ones cost twice the input price). */
export interface ModelPrice { input: number; output: number; cacheRead: number; cacheWrite: number }

/** the day the prices below were last checked */
export const PRICES_AS_OF = '2026-10-28';

const claude = (input: number, output: number, cacheRead = input / 10): ModelPrice => ({ input, output, cacheRead, cacheWrite: input * 1.25 });
const openai = (input: number, cacheRead: number, output: number): ModelPrice => ({ input, output, cacheRead, cacheWrite: input });
/** Google's and xAI's have the same shape: no separate cache-write price (none of their agents logs cache writes) */
const google = openai;
const xai = openai;

/**
 * Estimates only: public pay-as-you-go API prices (standard tier, short context; no batch, fast or priority rates,
 * no long-context surcharges), checked on 2026-10-28. Anthropic's from its model docs (cache reads 0.1x input unless
 * noted, 5-minute cache writes 1.25x, 1-hour 2x); OpenAI's from developers.openai.com/api/docs/pricing (its cache
 * writes cost the input price); Google's from ai.google.dev/gemini-api/docs/pricing (paid tier, prompts up to 200K);
 * xAI's from docs.x.ai/docs/models (prompts under 200K; Grok Build's own models aren't listed there, Grok logs their
 * cost itself). Someone on a plan pays the plan, not this. A model missing here counts its tokens with no cost, unless
 * its agent logged a cost of its own (`UsageRecord.costUsd`, taken over this table); add it when a new one ships.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': claude(10, 50, 0.25),
  'claude-mythos-5-1': claude(10, 50, 0.25),
  'claude-fable-5': claude(10, 50),
  'claude-opus-5-5': claude(4, 20, 0.2),
  'claude-opus-5': claude(5, 25),
  'claude-opus-4-8': claude(5, 25),
  'claude-opus-4-7': claude(5, 25),
  'claude-opus-4-6': claude(5, 25),
  'claude-opus-4-5': claude(5, 25),
  'claude-opus-4-1': claude(15, 75),
  'claude-opus-4': claude(15, 75),
  'claude-sonnet-5-5': claude(2, 10),
  'claude-sonnet-5': claude(2, 10),
  'claude-sonnet-4-6': claude(3, 15),
  'claude-sonnet-4-5': claude(3, 15),
  'claude-sonnet-4': claude(3, 15),
  // its prompts over 100K tokens cost 5x; not told apart here
  'claude-haiku-5-5': claude(0.1, 0.5),
  'claude-haiku-4-5': claude(1, 5),
  'gpt-6-astra': openai(10, 1, 50),
  'gpt-6.1-sol': openai(2, 0.1, 10),
  'gpt-6.1-terra': openai(1, 0.05, 5),
  'gpt-6-sol': openai(2, 0.2, 10),
  'gpt-6-luna': openai(0.1, 0.01, 0.5),
  'gpt-5.6-sol': openai(4, 0.4, 20),
  'gpt-5.6-terra': openai(2, 0.2, 12),
  'gpt-5.6-luna': openai(0.2, 0.02, 1.2),
  'gpt-5.5': openai(5, 0.5, 30),
  'gpt-5.4': openai(2.5, 0.25, 15),
  'gpt-5.4-mini': openai(0.75, 0.075, 4.5),
  'gpt-5.4-nano': openai(0.2, 0.02, 1.25),
  'gpt-5.3-codex': openai(1.75, 0.175, 14),
  'gpt-5.2': openai(1.75, 0.175, 14),
  'gpt-5.1': openai(1.25, 0.125, 10),
  'gpt-5': openai(1.25, 0.125, 10),
  'gpt-5-mini': openai(0.25, 0.025, 2),
  'gpt-5-nano': openai(0.05, 0.005, 0.4),
  'gemini-3.1-pro-preview': google(2, 0.2, 12),
  'gemini-3-flash-preview': google(0.5, 0.05, 3),
  'gemini-3.1-flash-lite': google(0.25, 0.025, 1.5),
  'gemini-2.5-pro': google(1.25, 0.125, 10),
  'gemini-2.5-flash': google(0.3, 0.03, 2.5),
  'grok-4.7': xai(2, 0.5, 6),
  'grok-4.6': xai(2, 0.5, 6),
  'grok-4.5': xai(2, 0.3, 6),
  'grok-4.3': xai(1.25, 0.2, 2.5),
};

/** Amazon Bedrock's ids, as OpenCode logs them: `[region.]vendor.model[-v1[:0]]` */
const BEDROCK_ID = /^(?:(?:us|eu|au|apac|jp|global)\.)?(?:anthropic|openai|xai|google|meta|mistral|moonshotai|zai|deepseek|qwen|amazon)\.(.+)$/;

/**
 * A logged model id as the table keys it: lower case, no `provider/` prefix, `[1m]` variant, Bedrock region/vendor
 * prefix and version, or date suffix.
 */
export function normalizeModel(model: string): string {
  let m = model.trim().toLowerCase();
  const slash = m.lastIndexOf('/');
  if (slash >= 0) m = m.slice(slash + 1);
  const bracket = m.indexOf('[');
  if (bracket >= 0) m = m.slice(0, bracket);
  const bedrock = BEDROCK_ID.exec(m);
  if (bedrock) m = bedrock[1]!.replace(/-v\d+(?::\d+)?$|-\d+:\d+$/, '');
  return m.replace(/-20\d{6}$/, '');
}

export function priceOf(model: string, table: Readonly<Record<string, ModelPrice>> = MODEL_PRICES): ModelPrice | undefined {
  return table[normalizeModel(model)];
}

/** a request's cost in USD: the agent's own figure, else estimated from the table (0 for a model with no price) */
export function costOf(r: Pick<UsageRecord, 'model' | 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cacheWrite1h' | 'costUsd'>, table = MODEL_PRICES): number {
  if (r.costUsd !== undefined) return r.costUsd;
  const p = priceOf(r.model, table);
  if (!p) return 0;
  const write5m = r.cacheWrite - r.cacheWrite1h;
  return (r.input * p.input + r.output * p.output + r.cacheRead * p.cacheRead + write5m * p.cacheWrite + r.cacheWrite1h * p.input * 2) / 1e6;
}

/** what its cache reads saved against the full input price, USD */
export function cacheSavingsOf(r: Pick<UsageRecord, 'model' | 'cacheRead'>, table = MODEL_PRICES): number {
  const p = priceOf(r.model, table);
  return p ? (r.cacheRead * Math.max(0, p.input - p.cacheRead)) / 1e6 : 0;
}

const words = (rest: string): string => rest.split('-').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/** "Claude Opus 4.5", "GPT-5.6 Luna", "Gemini 3.1 Pro Preview", "Grok 4.7 Build", or the id without its provider */
export function modelName(model: string): string {
  const m = normalizeModel(model);
  const c = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/.exec(m);
  if (c) return `Claude ${c[1]!.charAt(0).toUpperCase()}${c[1]!.slice(1)} ${c[2]}${c[3] ? `.${c[3]}` : ''}`;
  const g = /^gpt-([\d.]+)((?:-[a-z0-9]+)*)$/.exec(m);
  if (g) {
    const rest = words(g[2]!);
    return `GPT-${g[1]}${rest ? ` ${rest}` : ''}`;
  }
  const f = /^(gemini|grok)-([\d.]+)((?:-[a-z0-9]+)*)$/.exec(m);
  if (f) {
    const rest = words(f[3]!);
    return `${words(f[1]!)} ${f[2]}${rest ? ` ${rest}` : ''}`;
  }
  // an id in lower case as the table keys it; one with capitals (Pi's "Tools and summaries") as it was written
  const bare = model.slice(model.lastIndexOf('/') + 1);
  return bare === bare.toLowerCase() ? m : bare;
}

/* ---------------- adding up ---------------- */

const DAY_MS = 86_400_000;

/** local midnight `daysBack` days before the day of `now` (DST-safe: built from the calendar, not by subtracting ms) */
function localMidnight(now: number, daysBack = 0): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysBack).getTime();
}

/** where a range starts: today's local midnight, or that of 6 / 29 days before */
export function rangeStart(range: UsageRange, now: number): number {
  return localMidnight(now, range === 'today' ? 0 : range === '7d' ? 6 : 29);
}

/** the starts of the range's hours (today) or days, oldest first */
export function bucketStarts(range: UsageRange, now: number): number[] {
  const from = rangeStart(range, now);
  const out: number[] = [];
  if (range === 'today') {
    const d = new Date(from);
    for (let h = 0; h < 24; h++) out.push(new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).getTime());
  } else {
    const days = range === '7d' ? 7 : 30;
    for (let i = days - 1; i >= 0; i--) out.push(localMidnight(now, i));
  }
  return out;
}

const zero = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, costUsd: 0, cacheSavingsUsd: 0, unpricedTokens: 0, requests: 0 });

function add(t: UsageTotals, r: UsageRecord, cost: number, savings: number, priced: boolean): void {
  const tokens = r.input + r.output + r.cacheRead + r.cacheWrite;
  t.input += r.input; t.output += r.output; t.cacheRead += r.cacheRead; t.cacheWrite += r.cacheWrite; t.tokens += tokens;
  t.costUsd += cost; t.cacheSavingsUsd += savings; t.requests += r.requests ?? 1;
  if (!priced) t.unpricedTokens += tokens;
}

const byCost = (a: UsageTotals, b: UsageTotals): number => b.costUsd - a.costUsd || b.tokens - a.tokens;

/** One agent's records (a provider id and its name for people). */
export interface AgentRecords { id: string; name: string; records: Iterable<UsageRecord> }

/** Adds up the records inside the range; each dedupe key counts once over all agents. */
export function summarize(agents: AgentRecords[], range: UsageRange, now: number, table = MODEL_PRICES, scope: UsageScope = 'all'): UsageSummary {
  const from = rangeStart(range, now);
  const starts = bucketStarts(range, now);
  const series: UsageBucket[] = starts.map((start) => ({ start, tokens: 0, costUsd: 0 }));
  const totals = zero();
  const byBots = { tokens: 0, costUsd: 0 };
  const models = new Map<string, UsageModelRow>();
  const agentRows: UsageAgentRow[] = [];
  const seen = new Set<string>();
  for (const a of agents) {
    const row: UsageAgentRow = { id: a.id, name: a.name, ...zero() };
    for (const r of a.records) {
      if (r.ts < from || r.ts > now) continue;
      if (r.key) {
        if (seen.has(r.key)) continue;
        seen.add(r.key);
      }
      // after the key, so a copy logged twice counts as the first one did, as with everything
      if (scope === 'bots' && !r.bot) continue;
      const priced = r.costUsd !== undefined || priceOf(r.model, table) !== undefined;
      const cost = costOf(r, table);
      const savings = cacheSavingsOf(r, table);
      const tokens = r.input + r.output + r.cacheRead + r.cacheWrite;
      add(totals, r, cost, savings, priced);
      add(row, r, cost, savings, priced);
      const id = normalizeModel(r.model);
      let m = models.get(id);
      if (!m) models.set(id, (m = { model: id, name: modelName(r.model), priced, ...zero() }));
      // some of a model's requests may carry their agent's cost and others not
      else if (priced) m.priced = true;
      add(m, r, cost, savings, priced);
      if (r.bot) { byBots.tokens += tokens; byBots.costUsd += cost; }
      // the last bucket that starts at or before it
      let i = starts.length - 1;
      while (i > 0 && starts[i]! > r.ts) i--;
      const b = series[i]!;
      b.tokens += tokens; b.costUsd += cost;
    }
    if (row.requests) agentRows.push(row);
  }
  return {
    range, scope, from, to: now, totals, byBots,
    bucket: range === 'today' ? 'hour' : 'day',
    series,
    models: [...models.values()].sort(byCost),
    agents: agentRows.sort(byCost),
    sources: agents.map((a) => ({ id: a.id, name: a.name })),
    pricesAsOf: PRICES_AS_OF,
  };
}

/** how far back a log is worth reading: the longest range plus a day's slack */
export const KEEP_MS = 31 * DAY_MS;
