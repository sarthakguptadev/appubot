/**
 * How the plan limits are read from each agent, with the agent's own sign-in and never a token of ours (`LimitsFetch`;
 * `deps.limitsFetch` swaps them in tests):
 * - Claude Code: the user's own `claude` run as the SDK runs it (`-p --input-format stream-json --output-format
 *   stream-json`) and asked the `get_usage` control request its `/usage` dialog uses, with no prompt and no model
 *   call; `CLAUDE_CONFIG_DIR` picks the profile. Its answer is the SDK's `SDKControlGetUsageResponse`. Measured at
 *   ~200 ms on this Mac. The CLI handles its login and refresh; a token without the profile scope (`claude
 *   setup-token`) or an API key answers `rate_limits_available: false`.
 * - Codex: `codex app-server` over stdio (its documented, versioned protocol): `initialize`, `initialized`, then
 *   `account/rateLimits/read`; `CODEX_HOME` picks the profile. ~1 s. One at a time (MonoCode's rule).
 * - OpenCode Go: `GET https://opencode.ai/zen/go/v1/usage` with the keys OpenCode itself would send, in its order
 *   (OpenBot's reading of OpenCode 2): the OpenCode Console connection in its database's `credential` table, then the
 *   Go key (MonoCode's lookup: `OPENCODE_AUTH_CONTENT`, its config's `provider.opencode-go.options.apiKey`, then
 *   `auth.json`, then `OPENCODE_API_KEY`); a key the console refuses moves the read to the next. A key is read for
 *   the one request and never kept or logged. A 403 means no Go subscription.
 * - Grok: its ACP extension method `_x.ai/billing`, asked of a short session of Grok's own (`AgentRuntime.extMethod`):
 *   the billing period and its credit use, as the Grok CLI shows them. No token of its leaves the CLI.
 * - Cursor: the two dashboard calls the Cursor CLI makes itself (`DashboardService/GetCurrentPeriodUsage` and
 *   `GetPlanInfo`, Connect JSON) with the CLI's own access token: on macOS the login Keychain item it writes with
 *   `/usr/bin/security` (`cursor-access-token`, read the same way, so nothing asks), else its `auth.json`.
 *   `CURSOR_API_ENDPOINT` moves the CLI, so it moves this too. 401/403 means the sign-in is refused.
 * - Kimi: the request the Kimi CLI's `/usage` sends, `GET <base_url>/usages`, with the token of its sign-in: Kimi
 *   Code 2.x keeps it under `KIMI_CODE_HOME` (`~/.kimi-code`), the Python CLI 1.x under `KIMI_SHARE_DIR` (`~/.kimi`);
 *   `config.toml`'s `[providers."managed:kimi-code"]` names the API and the token's key, `credentials/<key>.json`
 *   holds it. The token lasts 15 min and the CLI only renews it during a turn, so an expired one keeps the last read.
 * - Google Antigravity (1.4.1+): its ACP server answers a prompt of `/usage` by itself, with no model turn, in a
 *   session of its own (`antigravityUsage` gets the answer text through the session the service opens).
 * The Grok, Cursor, Kimi and Antigravity reads follow OpenBot's (nightly-labs/openbot, PolyForm Noncommercial: the
 * requests and rules were read there and written anew here).
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchSpec, killTree } from '@appubot/agent-runtime';
import type { ClaudeUsageResponse } from '@appubot/chat-core';
import { loadSqlite } from '../usageSqlite';

export interface ProbeOptions {
  /** the agent's own executable (`adapterCli`) */
  cli: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs?: number;
}

export interface GoProbeResult { status: number; body: unknown }
/** a read with a CLI's own token: its answer, no sign-in here (`none`), or a sign-in the service refused (`refused`) */
export type TokenProbe<T> = { ok: true; value: T } | { ok: false; reason: 'none' | 'refused' };
export interface CursorUsage { usage: unknown; planInfo: unknown }
export interface KeyProbeOptions { env: NodeJS.ProcessEnv; homeDir: string; fetch: typeof fetch; timeoutMs?: number }

export interface LimitsFetch {
  claude(o: ProbeOptions): Promise<ClaudeUsageResponse>;
  /** the `account/rateLimits/read` result */
  codex(o: ProbeOptions): Promise<unknown>;
  /** null: no key here */
  opencodeGo(o: KeyProbeOptions): Promise<GoProbeResult | null>;
  /** Grok's `_x.ai/billing` answer, through `ext` (a session of Grok's own) */
  grok(o: { ext: (method: string, params: Record<string, unknown>) => Promise<unknown> }): Promise<unknown>;
  /** `keychain: false`: only its file (a team member's own home on a cloud computer, never the login Keychain) */
  cursor(o: KeyProbeOptions & { platform?: NodeJS.Platform; keychain?: boolean }): Promise<TokenProbe<CursorUsage>>;
  kimi(o: KeyProbeOptions): Promise<TokenProbe<unknown>>;
  /** Antigravity's `/usage` answer text, through `prompt` (a session of its own) */
  antigravity(o: { prompt: (text: string) => Promise<string> }): Promise<string>;
}

const CLAUDE_TIMEOUT_MS = 20_000;
const CODEX_TIMEOUT_MS = 15_000;
const GO_TIMEOUT_MS = 15_000;
const CURSOR_TIMEOUT_MS = 10_000;
const KIMI_TIMEOUT_MS = 10_000;
const KEYCHAIN_TIMEOUT_MS = 3_000;

/** lines of a child's stdout, one at a time */
function onLines(child: ChildProcess, fn: (line: string) => void): void {
  let buf = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) fn(line);
    }
  });
}

function spawnProbe(o: ProbeOptions, args: string[]): ChildProcess {
  const l = launchSpec(o.cli, args, process.platform, o.env);
  return spawn(l.command, l.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(l.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
}

/** a child's stderr, for the error message when it answers nothing */
function tail(child: ChildProcess): () => string {
  let err = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (d: string) => { err = (err + d).slice(-2000); });
  return () => err.trim().split('\n').filter((l) => l.trim()).slice(-3).join(' ').slice(0, 300);
}

export async function claudeUsage(o: ProbeOptions): Promise<ClaudeUsageResponse> {
  const child = spawnProbe(o, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
  const errors = tail(child);
  const requestId = `appubot-usage-${Date.now()}`;
  return new Promise<ClaudeUsageResponse>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); fn(); killTree(child); };
    const timer = setTimeout(() => finish(() => reject(new Error('Claude Code did not answer in time'))), o.timeoutMs ?? CLAUDE_TIMEOUT_MS);
    child.on('error', (e) => finish(() => reject(e)));
    child.on('exit', (code) => finish(() => reject(new Error(errors() || `Claude Code exited (${code ?? 'signal'}) before answering`))));
    onLines(child, (line) => {
      let m: { type?: string; response?: { request_id?: string; subtype?: string; error?: string; response?: unknown } };
      try { m = JSON.parse(line) as typeof m; } catch { return; }
      if (m.type !== 'control_response' || m.response?.request_id !== requestId) return;
      if (m.response.subtype === 'error' || m.response.error) return finish(() => reject(new Error(m.response?.error || 'Claude Code refused the usage request')));
      const r = m.response.response;
      if (!r || typeof r !== 'object') return finish(() => reject(new Error('Claude Code answered the usage request with nothing')));
      finish(() => resolve(r as ClaudeUsageResponse));
    });
    child.stdin?.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'get_usage', skip_behaviors: true } })}\n`);
  });
}

/** one Codex app-server at a time: every probe would otherwise start its own and race the others' auth refresh */
let codexQueue: Promise<unknown> = Promise.resolve();

export function codexRateLimits(o: ProbeOptions): Promise<unknown> {
  const run = codexQueue.then(() => codexRateLimitsNow(o));
  codexQueue = run.catch(() => undefined);
  return run;
}

async function codexRateLimitsNow(o: ProbeOptions): Promise<unknown> {
  const child = spawnProbe(o, ['app-server']);
  const errors = tail(child);
  return new Promise<unknown>((resolve, reject) => {
    let done = false;
    let id = 0;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); fn(); killTree(child); };
    const timer = setTimeout(() => finish(() => reject(new Error('Codex did not answer in time'))), o.timeoutMs ?? CODEX_TIMEOUT_MS);
    const request = (method: string, params: unknown): Promise<unknown> => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { resolve: res, reject: rej });
      child.stdin?.write(`${JSON.stringify({ id: i, method, params })}\n`);
    });
    child.on('error', (e) => finish(() => reject(e)));
    child.on('exit', (code) => finish(() => reject(new Error(errors() || `Codex exited (${code ?? 'signal'}) before answering`))));
    onLines(child, (line) => {
      let m: { id?: number; result?: unknown; error?: { message?: string }; method?: string };
      try { m = JSON.parse(line) as typeof m; } catch { return; }
      if (typeof m.id === 'number' && pending.has(m.id)) {
        const p = pending.get(m.id)!;
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message || 'Codex refused the request'));
        else p.resolve(m.result);
      } else if (typeof m.id === 'number' && m.method) {
        // a request from the server (an approval it would need): nothing is running here
        child.stdin?.write(`${JSON.stringify({ id: m.id, result: {} })}\n`);
      }
    });
    void (async () => {
      try {
        await request('initialize', { clientInfo: { name: 'appubot', title: 'AppuBot', version: '0.0.0' }, capabilities: { experimentalApi: true } });
        child.stdin?.write(`${JSON.stringify({ method: 'initialized' })}\n`);
        const result = await request('account/rateLimits/read', {});
        finish(() => resolve(result));
      } catch (e) {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    })();
  });
}

/** the OpenCode Go key, OpenCode's own way (MonoCode's lookup); undefined when there is none */
export async function openCodeGoKey(env: NodeJS.ProcessEnv, homeDir: string): Promise<string | undefined> {
  const v = (name: string): string | undefined => env[name]?.trim() || undefined;
  const fromAuth = (raw: string): string | undefined => {
    try {
      const o = JSON.parse(raw) as Record<string, { key?: unknown } | undefined>;
      const k = o?.['opencode-go']?.key;
      return typeof k === 'string' && k.trim() ? k.trim() : undefined;
    } catch { return undefined; }
  };
  const content = v('OPENCODE_AUTH_CONTENT');
  if (content) return fromAuth(content);
  const fromConfig = (raw: string): string | undefined => {
    let o: { provider?: Record<string, { options?: { apiKey?: unknown } }> } | undefined;
    try { o = JSON.parse(raw) as typeof o; } catch { o = undefined; }
    for (const id of ['opencode-go', 'opencode']) {
      const key = o?.provider?.[id]?.options?.apiKey;
      if (typeof key !== 'string' || !key.trim()) continue;
      const m = /^\{env:([^}]+)\}$/.exec(key.trim());
      if (m) { const resolved = v(m[1]!); if (resolved) return resolved; continue; }
      return key.trim();
    }
    return undefined;
  };
  const configContent = v('OPENCODE_CONFIG_CONTENT');
  if (configContent) { const k = fromConfig(configContent); if (k) return k; }
  const configDir = v('XDG_CONFIG_HOME') ?? join(homeDir, '.config');
  for (const p of [v('OPENCODE_CONFIG'), join(configDir, 'opencode', 'opencode.json')].filter((x): x is string => !!x)) {
    try { const k = fromConfig(await readFile(p, 'utf8')); if (k) return k; } catch { /* none */ }
  }
  const dataDir = v('OPENCODE_DATA_DIR')?.split(',')[0]?.trim() || join(v('XDG_DATA_HOME') ?? join(homeDir, '.local', 'share'), 'opencode');
  for (const p of [join(dataDir, 'auth.json'), join(homeDir, 'Library', 'Application Support', 'opencode', 'auth.json')]) {
    try { return fromAuth(await readFile(p, 'utf8')); } catch { /* next */ }
  }
  return undefined;
}

export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const OPENCODE_CONSOLE_URL = 'https://opencode.ai/console';

/**
 * The OpenCode Console connection OpenCode 2 keeps in its database (`credential`, `integration_id = 'opencode'`, the
 * active row first), which the CLI sends before any other key (OpenBot's reading). Only a key of opencode.ai's own
 * console counts (a self-hosted `metadata.server` doesn't). No database, a locked one or an older schema: none.
 */
export function openCodeConsoleKey(env: NodeJS.ProcessEnv, homeDir: string): string | undefined {
  if (env.OPENCODE_AUTH_CONTENT?.trim()) return undefined;
  const file = env.OPENCODE_DB?.trim() || 'opencode.db';
  if (file === ':memory:') return undefined;
  const dataDir = env.OPENCODE_DATA_DIR?.split(',')[0]?.trim() || join(env.XDG_DATA_HOME?.trim() || join(homeDir, '.local', 'share'), 'opencode');
  const sqlite = loadSqlite();
  if (!sqlite) return undefined;
  let db: InstanceType<typeof sqlite.DatabaseSync> | undefined;
  try {
    db = new sqlite.DatabaseSync(resolve(dataDir, file), { readOnly: true, timeout: 100 });
    const row = db.prepare("SELECT value FROM credential WHERE integration_id = 'opencode' AND active IS NOT 0 ORDER BY active DESC, time_created DESC, id DESC LIMIT 1").get();
    if (!row || typeof row.value !== 'string') return undefined;
    const v = JSON.parse(row.value) as { type?: unknown; key?: unknown; metadata?: { server?: unknown } | null };
    if (v?.type !== 'key' || typeof v.key !== 'string') return undefined;
    const server = v.metadata?.server;
    if (typeof server === 'string') {
      const u = new URL(server);
      if (`${u.origin}${u.pathname.replace(/\/+$/, '')}` !== OPENCODE_CONSOLE_URL) return undefined;
    }
    return v.key.trim() || undefined;
  } catch {
    return undefined;
  } finally {
    try { db?.close(); } catch { /* closed */ }
  }
}

/** the keys OpenCode would send, in its order: the Console connection, then the Go key, then `OPENCODE_API_KEY` */
export async function openCodeKeys(env: NodeJS.ProcessEnv, homeDir: string): Promise<string[]> {
  const keys = [openCodeConsoleKey(env, homeDir), await openCodeGoKey(env, homeDir), env.OPENCODE_API_KEY?.trim()];
  return [...new Set(keys.filter((k): k is string => !!k))];
}

export async function openCodeGoUsage(o: KeyProbeOptions): Promise<GoProbeResult | null> {
  const keys = await openCodeKeys(o.env, o.homeDir);
  if (!keys.length) return null;
  let last: GoProbeResult | null = null;
  for (const key of keys) {
    const res = await o.fetch(OPENCODE_GO_USAGE_URL, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(o.timeoutMs ?? GO_TIMEOUT_MS) });
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    last = { status: res.status, body };
    // a key the console refuses: the next one may be the Go key
    if (res.status !== 401 && res.status !== 403) break;
  }
  return last;
}

/* ---------- Grok ---------- */

export const GROK_BILLING_METHOD = '_x.ai/billing';

export async function grokBilling(o: { ext: (method: string, params: Record<string, unknown>) => Promise<unknown> }): Promise<unknown> {
  return o.ext(GROK_BILLING_METHOD, {});
}

/* ---------- Cursor ---------- */

export const CURSOR_API_ENDPOINT = 'https://api2.cursor.sh';
const CURSOR_USAGE_PATH = '/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const CURSOR_PLAN_PATH = '/aiserver.v1.DashboardService/GetPlanInfo';

/** where the Cursor CLI keeps its sign-in off the Keychain */
export function cursorAuthFile(env: NodeJS.ProcessEnv, homeDir: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return join(env.APPDATA?.trim() || join(homeDir, 'AppData', 'Roaming'), 'Cursor', 'auth.json');
  if (platform === 'darwin') return join(homeDir, '.cursor', 'auth.json');
  return join(env.XDG_CONFIG_HOME?.trim() || join(homeDir, '.config'), 'cursor', 'auth.json');
}

/** the Cursor CLI's access token: the login Keychain on macOS (read with the tool the CLI writes it with), else its file */
async function cursorToken(env: NodeJS.ProcessEnv, homeDir: string, platform: NodeJS.Platform, keychain: boolean): Promise<string | undefined> {
  if (platform === 'darwin' && keychain) {
    const fromKeychain = await new Promise<string>((res) => {
      execFile('/usr/bin/security', ['find-generic-password', '-a', 'cursor-user', '-s', 'cursor-access-token', '-w'], { timeout: KEYCHAIN_TIMEOUT_MS }, (err, stdout) => res(err ? '' : String(stdout).trim()));
    });
    if (fromKeychain) return fromKeychain;
  }
  try {
    const v = JSON.parse(await readFile(cursorAuthFile(env, homeDir, platform), 'utf8')) as { accessToken?: unknown };
    return typeof v?.accessToken === 'string' && v.accessToken.trim() ? v.accessToken.trim() : undefined;
  } catch { return undefined; }
}

export async function cursorUsage(o: KeyProbeOptions & { platform?: NodeJS.Platform; keychain?: boolean }): Promise<TokenProbe<CursorUsage>> {
  const token = await cursorToken(o.env, o.homeDir, o.platform ?? process.platform, o.keychain ?? true);
  if (!token) return { ok: false, reason: 'none' };
  const endpoint = (o.env.CURSOR_API_ENDPOINT?.trim() || CURSOR_API_ENDPOINT).replace(/\/+$/, '');
  const post = async (path: string): Promise<{ status: number; body: unknown }> => {
    const res = await o.fetch(`${endpoint}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(o.timeoutMs ?? CURSOR_TIMEOUT_MS) });
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  };
  const [usage, plan] = await Promise.all([post(CURSOR_USAGE_PATH), post(CURSOR_PLAN_PATH).catch(() => ({ status: 0, body: null }))]);
  if (usage.status === 401 || usage.status === 403) return { ok: false, reason: 'refused' };
  if (usage.status < 200 || usage.status >= 300) throw new Error(`Cursor answered ${usage.status}`);
  // a plan info that fails to read keeps the split reading
  return { ok: true, value: { usage: usage.body, planInfo: plan.status >= 200 && plan.status < 300 ? plan.body : null } };
}

/* ---------- Kimi ---------- */

export const KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';

/** the API address and the token's key from `config.toml`'s managed Kimi Code provider (a tiny TOML read: those two lines) */
export function kimiManagedProvider(config: string): { baseUrl?: string; key?: string } {
  let section: 'provider' | 'oauth' | null = null;
  let baseUrl: string | undefined;
  let key: string | undefined;
  const quoted = (name: string, line: string): string | undefined => {
    const m = new RegExp(`^${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(line);
    return m ? (m[1] ?? m[2]) : undefined;
  };
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      section = /^\[\s*providers\.(?:"managed:kimi-code"|'managed:kimi-code')\s*\]/.test(line) ? 'provider' : /^\[\s*providers\.(?:"managed:kimi-code"|'managed:kimi-code')\.oauth\s*\]/.test(line) ? 'oauth' : null;
      continue;
    }
    if (section === 'provider') {
      baseUrl ??= quoted('base_url', line);
      key ??= /^oauth\s*=\s*\{.*\bkey\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line)?.slice(1).find(Boolean);
    } else if (section === 'oauth') key ??= quoted('key', line);
  }
  return { ...(baseUrl ? { baseUrl } : {}), ...(key ? { key } : {}) };
}

/** `<base>/usages`, only over https to Kimi's API (no user, query or fragment) */
export function kimiUsageUrl(baseUrl: string): string | undefined {
  let u: URL;
  try { u = new URL(baseUrl); } catch { return undefined; }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return undefined;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}/usages`;
}

export async function kimiUsage(o: KeyProbeOptions): Promise<TokenProbe<unknown>> {
  const homes = [o.env.KIMI_CODE_HOME?.trim() || join(o.homeDir, '.kimi-code'), o.env.KIMI_SHARE_DIR?.trim() || join(o.homeDir, '.kimi')];
  for (const home of homes) {
    let config: string;
    try { config = await readFile(join(home, 'config.toml'), 'utf8'); } catch { continue; }
    const provider = kimiManagedProvider(config);
    const key = provider.key ?? 'oauth/kimi-code';
    const name = key.startsWith('oauth/') ? key.slice('oauth/'.length) : key;
    if (!name || /[/\\]/.test(name) || name.startsWith('.')) return { ok: false, reason: 'none' };
    const url = kimiUsageUrl(o.env.KIMI_CODE_BASE_URL?.trim() || provider.baseUrl || KIMI_CODE_BASE_URL);
    if (!url) return { ok: false, reason: 'none' };
    let token: { access_token?: unknown; expires_at?: unknown };
    try { token = JSON.parse(await readFile(join(home, 'credentials', `${name}.json`), 'utf8')) as typeof token; } catch { return { ok: false, reason: 'none' }; }
    if (typeof token?.access_token !== 'string' || !token.access_token) return { ok: false, reason: 'none' };
    if (typeof token.expires_at === 'number' && token.expires_at * 1000 <= Date.now()) throw new Error('The Kimi sign-in token has expired (it renews with its next message)');
    const res = await o.fetch(url, { headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(o.timeoutMs ?? KIMI_TIMEOUT_MS) });
    if (res.status === 401 || res.status === 403 || res.status === 404) return { ok: false, reason: 'refused' };
    if (!res.ok) throw new Error(`Kimi answered ${res.status}`);
    return { ok: true, value: await res.json() };
  }
  return { ok: false, reason: 'none' };
}

/* ---------- Google Antigravity ---------- */

export const ANTIGRAVITY_USAGE_PROMPT = '/usage';

export async function antigravityUsage(o: { prompt: (text: string) => Promise<string> }): Promise<string> {
  return o.prompt(ANTIGRAVITY_USAGE_PROMPT);
}

export const defaultLimitsFetch: LimitsFetch = { claude: claudeUsage, codex: codexRateLimits, opencodeGo: openCodeGoUsage, grok: grokBilling, cursor: cursorUsage, kimi: kimiUsage, antigravity: antigravityUsage };

/** where an agent's history lives for this computer's own user (tests point `homeDir` elsewhere) */
export const userHome = (homeDir?: string): string => homeDir ?? homedir();
