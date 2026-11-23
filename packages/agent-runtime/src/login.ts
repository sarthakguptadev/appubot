/**
 * Is each agent's own CLI signed in on this computer? Cheap, non-interactive checks, ported from Synara's ProviderHealth
 * where it has one: a status command with a timeout, or the CLI's own credential/config file read only for whether a
 * login is there and the account's email or plan. Tokens never leave this module and emails are masked, so nothing
 * secret reaches the wire.
 *
 * - Claude Code: `claude auth status` (JSON: loggedIn, email, subscriptionType), one at a time (it may rotate a
 *   refresh token), re-asked once after a clean `loggedIn: false` (Claude reports that transiently).
 * - Codex: `codex -c mcp_servers={} login status`, then the id token's claims in `$CODEX_HOME/auth.json` for the
 *   email and ChatGPT plan; just that file when there is no codex to ask. A custom model provider: unknown.
 * - Cursor: `cursor-agent status` ("Logged in as …" / "Not logged in").
 * - Grok: XAI_API_KEY in the agent's env, else `$GROK_HOME/auth.json` (a cached login with a key, not expired or
 *   refreshable). Grok has no status command.
 * - GitHub Copilot: COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN, else the users in `$COPILOT_HOME/config.json`, else the
 *   GitHub CLI's user in its hosts.yml (Copilot falls back to `gh auth token`).
 * - OpenCode: `opencode auth list` (any stored or environment credential counts).
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAuth } from '@appubot/protocol';
import { killTree, processGroup, spawnCommand } from './spawn';

/** A login check's answer (the runtime stamps `checkedAt`). */
export type Login = Omit<ProviderAuth, 'checkedAt'>;

/** How to run a provider's own CLI: subcommand args go after `args` (e.g. the Claude adapter's `--cli`). */
export interface CliInvocation {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  error?: string;
}

const UNKNOWN: Login = { state: 'unknown' };
const LOGGED_OUT: Login = { state: 'logged_out' };
const MAX_OUTPUT = 64 * 1024;

/** Logout per CLI, where it is a plain non-interactive command (Copilot has none, OpenCode's asks which account). */
export const LOGOUT_ARGS: Record<string, string[]> = {
  'claude-code': ['auth', 'logout'],
  codex: ['logout'],
  cursor: ['logout'],
  grok: ['logout'],
};

/* ------------------------------------------------------------------ helpers */

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
}

/** "sarthak@example.com" -> "s***@example.com"; anything that isn't an email -> undefined. */
export function maskEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = value.trim().match(/^([^@\s]+)@([^@\s]+\.[^@\s]+)$/);
  if (!m) return undefined;
  return `${m[1]!.charAt(0)}***@${m[2]!.toLowerCase()}`;
}

function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** JSON output, if the CLI printed some (`{…}` or `[{…}]`, the first element then). */
function parseJsonOutput(text: string): Record<string, unknown> | undefined {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try {
    const v: unknown = JSON.parse(t);
    if (Array.isArray(v)) return isRecord(v[0]) ? v[0] : {};
    return isRecord(v) ? v : {};
  } catch {
    return {};
  }
}

/** Synara's auth marker walk: the first boolean login flag at the top level or under auth/status/session/account. */
function authBoolean(o: Record<string, unknown>, depth = 0): boolean | undefined {
  for (const k of ['authenticated', 'isAuthenticated', 'loggedIn', 'isLoggedIn']) if (typeof o[k] === 'boolean') return o[k] as boolean;
  if (depth > 2) return undefined;
  for (const k of ['auth', 'status', 'session', 'account']) {
    const v = o[k];
    if (isRecord(v)) {
      const b = authBoolean(v, depth + 1);
      if (b !== undefined) return b;
    }
  }
  return undefined;
}

/** The payload of a JWT (no signature check: only read for the account's email and plan, never trusted). */
export function jwtClaims(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== 'string') return undefined;
  const part = token.split('.')[1];
  if (!part) return undefined;
  try {
    const v: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return isRecord(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

const UNSUPPORTED = /unknown command|unrecognized command|unexpected argument|unknown option/;

function lowerOutput(r: CliResult): string {
  return stripAnsi(`${r.stdout}\n${r.stderr}`).toLowerCase();
}

/* ------------------------------------------------------------------ parsers */

const CLAUDE_LOGIN_REQUIRED = /not logged in|login required|authentication required|run `?claude (auth )?login`?|please run \/login/;

function claudePlan(o: Record<string, unknown>): string | undefined {
  const sub = str(o.subscriptionType) ?? str(o.subscription_type) ?? str(o.plan);
  if (sub) {
    const s = sub.toLowerCase();
    for (const [re, label] of [[/^max/, 'Max'], [/^pro/, 'Pro'], [/^team/, 'Team'], [/^enterprise/, 'Enterprise'], [/^free/, 'Free']] as const) if (re.test(s)) return label;
    return titleCase(sub);
  }
  const method = (str(o.authMethod) ?? str(o.auth_method) ?? '').toLowerCase();
  if (/api.?key|console/.test(method)) return 'API key';
  const api = (str(o.apiProvider) ?? '').toLowerCase();
  if (api === 'bedrock') return 'Amazon Bedrock';
  if (api === 'vertex') return 'Google Vertex';
  return undefined;
}

/** `claude auth status` (JSON in current versions, text in older ones). */
export function parseClaudeAuthStatus(r: CliResult): Login {
  const text = lowerOutput(r);
  if (r.timedOut || r.error || UNSUPPORTED.test(text)) return UNKNOWN;
  const json = parseJsonOutput(r.stdout);
  if (json) {
    const loggedIn = authBoolean(json);
    if (loggedIn === true) return compact({ state: 'logged_in', account: maskEmail(json.email) ?? maskEmail(json.emailAddress), plan: claudePlan(json) });
    if (loggedIn === false) return LOGGED_OUT;
    return UNKNOWN;
  }
  if (CLAUDE_LOGIN_REQUIRED.test(text)) return LOGGED_OUT;
  if (r.code === 0 && text.trim()) return { state: 'logged_in' };
  return UNKNOWN;
}

/** A clean `loggedIn: false` without the CLI saying to log in: Claude reports that while it refreshes, ask again. */
export function claudeSoftLoggedOut(r: CliResult): boolean {
  return r.code === 0 && !CLAUDE_LOGIN_REQUIRED.test(lowerOutput(r)) && parseClaudeAuthStatus(r).state === 'logged_out';
}

const CODEX_LOGIN_REQUIRED = /not logged in|login required|authentication required|run `?codex login`?/;

/** `codex login status`: "Logged in using ChatGPT", "Logged in using an API key - sk-…", "Not logged in". */
export function parseCodexLoginStatus(r: CliResult): Login {
  const text = lowerOutput(r);
  if (r.timedOut || r.error || UNSUPPORTED.test(text)) return UNKNOWN;
  if (CODEX_LOGIN_REQUIRED.test(text)) return LOGGED_OUT;
  const json = parseJsonOutput(r.stdout);
  if (json) {
    const loggedIn = authBoolean(json);
    return loggedIn === true ? { state: 'logged_in' } : loggedIn === false ? LOGGED_OUT : UNKNOWN;
  }
  if (r.code !== 0) return UNKNOWN;
  if (/logged in using an api key/.test(text)) return { state: 'logged_in', plan: 'API key' };
  return { state: 'logged_in' };
}

function chatgptPlan(raw: unknown): string | undefined {
  const p = str(raw);
  if (!p) return undefined;
  return `ChatGPT ${titleCase(p)}`;
}

/**
 * `$CODEX_HOME/auth.json`: whether a login is there (ChatGPT tokens or an API key) and, from the id token's claims,
 * the email and ChatGPT plan. Nothing else is read.
 */
export function codexLoginFromAuthFile(text: string | undefined): Login {
  if (text === undefined) return LOGGED_OUT;
  let o: unknown;
  try { o = JSON.parse(text); } catch { return UNKNOWN; }
  if (!isRecord(o)) return UNKNOWN;
  const tokens = isRecord(o.tokens) ? o.tokens : undefined;
  const claims = jwtClaims(tokens?.id_token);
  const auth = claims && isRecord(claims['https://api.openai.com/auth']) ? claims['https://api.openai.com/auth'] : undefined;
  const profile = claims && isRecord(claims['https://api.openai.com/profile']) ? claims['https://api.openai.com/profile'] : undefined;
  if (tokens && (str(tokens.access_token) || str(tokens.id_token) || str(tokens.refresh_token))) {
    return compact({ state: 'logged_in', account: maskEmail(claims?.email) ?? maskEmail(profile?.email), plan: chatgptPlan(auth?.chatgpt_plan_type) });
  }
  if (str(o.OPENAI_API_KEY)) return { state: 'logged_in', plan: 'API key' };
  return LOGGED_OUT;
}

/** A `model_provider` other than OpenAI in Codex's config.toml (its login status says nothing about that one). */
export function codexCustomProvider(configToml: string | undefined): string | undefined {
  if (!configToml) return undefined;
  for (const line of configToml.split('\n')) {
    const l = line.trim();
    if (l.startsWith('[')) break; // only top-level keys
    const m = l.match(/^model_provider\s*=\s*["']([^"']+)["']/);
    if (m) return m[1]!.toLowerCase() === 'openai' ? undefined : m[1];
  }
  return undefined;
}

const CURSOR_LOGIN_REQUIRED = /authentication required|not logged in|not authenticated|unauthenticated|login required|run [`']?(cursor-)?agent login/;

/** `cursor-agent status`: "✓ Logged in as you@example.com", "Not logged in", "Error: Authentication required…". */
export function parseCursorStatus(r: CliResult): Login {
  const raw = stripAnsi(`${r.stdout}\n${r.stderr}`);
  const text = raw.toLowerCase();
  if (r.timedOut || r.error || UNSUPPORTED.test(text)) return UNKNOWN;
  if (CURSOR_LOGIN_REQUIRED.test(text)) return LOGGED_OUT;
  const json = parseJsonOutput(r.stdout);
  if (json) {
    const loggedIn = authBoolean(json);
    const user = isRecord(json.userInfo) ? json.userInfo : undefined;
    return loggedIn === true ? compact({ state: 'logged_in', account: maskEmail(user?.email) }) : loggedIn === false ? LOGGED_OUT : UNKNOWN;
  }
  const email = raw.match(/logged in as\s+(\S+@\S+)/i)?.[1];
  if (/logged in|login successful|authenticated/.test(text)) return compact({ state: 'logged_in', account: maskEmail(email?.replace(/[.,;)]+$/, '')) });
  return UNKNOWN;
}

/**
 * `$GROK_HOME/auth.json`: `{ "<issuer>::<scope>": { key, email, expires_at, refresh_token, … } }`. Logged in with a
 * key that has not expired, or can be refreshed (Synara's readGrokCachedLogin).
 */
export function grokLoginFromAuthFile(text: string | undefined, now = Date.now()): Login {
  if (text === undefined) return LOGGED_OUT;
  let o: unknown;
  try { o = JSON.parse(text); } catch { return UNKNOWN; }
  if (!isRecord(o)) return UNKNOWN;
  const entries = Object.entries(o).filter((e): e is [string, Record<string, unknown>] => isRecord(e[1]));
  const pick =
    entries.find(([k, v]) => k.startsWith('https://auth.x.ai') && str(v.key)) ??
    entries.find(([k, v]) => k === 'https://accounts.x.ai/sign-in' && str(v.key)) ??
    entries.find(([, v]) => str(v.key));
  if (!pick) return LOGGED_OUT;
  const rec = pick[1];
  const expires = typeof rec.expires_at === 'string' ? Date.parse(rec.expires_at) : NaN;
  if (Number.isFinite(expires) && expires <= now && !str(rec.refresh_token)) return LOGGED_OUT;
  return compact({ state: 'logged_in', account: maskEmail(rec.email) });
}

/** Copilot's config.json (comment lines allowed): the signed-in GitHub user, if any. */
export function copilotLoginFromConfig(text: string | undefined): Login {
  if (text === undefined) return LOGGED_OUT;
  let o: unknown;
  try {
    o = JSON.parse(text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'));
  } catch {
    return UNKNOWN;
  }
  if (!isRecord(o)) return UNKNOWN;
  const users = Array.isArray(o.logged_in_users) ? o.logged_in_users.filter(isRecord) : [];
  const last = isRecord(o.last_logged_in_user) ? o.last_logged_in_user : users[0];
  const login = str(last?.login);
  if (!last && !users.length) return LOGGED_OUT;
  return compact({ state: 'logged_in', account: login ? `@${login}` : undefined });
}

/**
 * The GitHub CLI's signed-in user from its hosts.yml (`github.com:` … `user: octocat`). Only the user name is read:
 * Copilot falls back to `gh auth token` when it has no login of its own.
 */
export function ghUserFromHosts(text: string | undefined, host = 'github.com'): string | undefined {
  if (!text) return undefined;
  let inHost = false;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) inHost = line.trim().replace(/^["']|["']?:$/g, '') === host;
    else if (inHost) {
      const m = line.match(/^\s+user:\s*["']?([A-Za-z0-9-]+)["']?\s*$/);
      if (m) return m[1];
    }
  }
  return undefined;
}

/** Up to three names, then "+N". */
function nameList(names: string[]): string | undefined {
  const uniq = [...new Set(names)];
  if (!uniq.length) return undefined;
  return uniq.length > 3 ? `${uniq.slice(0, 3).join(', ')} +${uniq.length - 3}` : uniq.join(', ');
}

/**
 * `opencode auth list`. v2 prints a table ("GitHub Copilot  OAuth  stored", "AnyAPI  ANYAPI_API_KEY  environment"),
 * v1 a clack list ("●  Anthropic oauth" … "└  2 credentials"). Any credential counts as logged in; the account
 * shows which model providers it has.
 */
export function parseOpenCodeAuthList(r: CliResult): Login {
  if (r.timedOut || r.error) return UNKNOWN;
  const lines = stripAnsi(`${r.stdout}\n${r.stderr}`).split('\n').map((l) => l.trim()).filter(Boolean);
  if (UNSUPPORTED.test(lines.join('\n').toLowerCase())) return UNKNOWN;
  const names: string[] = [];
  for (const l of lines) {
    const bullet = l.match(/^[●◆•◇]\s+(.+)$/);
    if (bullet) {
      const rest = bullet[1]!.trim();
      names.push(rest.includes(' ') ? rest.replace(/\s+\S+$/, '') : rest);
      continue;
    }
    const cols = l.split(/\s{2,}/);
    if (cols.length >= 3 && /^(stored|environment|env|config|file)$/i.test(cols[cols.length - 1]!)) names.push(cols[0]!);
  }
  if (names.length) return compact({ state: 'logged_in', account: nameList(names) });
  if (r.code === 0) return LOGGED_OUT;
  return UNKNOWN;
}

function compact(l: Login): Login {
  return { state: l.state, ...(l.account ? { account: l.account } : {}), ...(l.plan ? { plan: l.plan } : {}) };
}

/* ------------------------------------------------------------------ running */

/** Run a CLI with no stdin, capped output and a hard timeout (the whole process group is killed). */
export function runCli(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CliResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r: Omit<CliResult, 'stdout' | 'stderr'>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...r, stdout, stderr });
    };
    let child: ReturnType<typeof spawnCommand>;
    try {
      child = spawnCommand(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env, detached: processGroup() });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const timer = setTimeout(() => {
      killTree(child, 'SIGKILL');
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => { if (stdout.length < MAX_OUTPUT) stdout += d; });
    child.stderr?.on('data', (d: string) => { if (stderr.length < MAX_OUTPUT) stderr += d; });
    child.on('error', (e) => finish({ code: null, error: e.message }));
    child.on('close', (code) => finish({ code }));
  });
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `claude auth status` may redeem a single-use refresh token: never run two at once. */
let claudeQueue: Promise<unknown> = Promise.resolve();
export function serialClaude<T>(fn: () => Promise<T>): Promise<T> {
  const next = claudeQueue.then(fn, fn);
  claudeQueue = next.catch(() => undefined);
  return next;
}

function home(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  // Windows CLIs keep their config under the user profile, not a Unix-style HOME a shell (Git Bash, MSYS) may set
  return platform === 'win32' ? homedir() : env.HOME || homedir();
}

/** The GitHub CLI's config folder (its own order: GH_CONFIG_DIR, XDG_CONFIG_HOME, Windows' AppData, ~/.config). */
export function ghConfigDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'gh');
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'GitHub CLI');
  return join(home(env, platform), '.config', 'gh');
}

function run(cli: CliInvocation, sub: string[], env: NodeJS.ProcessEnv, timeoutMs: number, extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return runCli(cli.command, [...cli.args, ...sub], { ...env, ...cli.env, ...extraEnv }, timeoutMs);
}

const TIMEOUT = { claude: 15_000, codex: 8_000, cursor: 10_000, opencode: 10_000 } as const;

/**
 * Check one provider's login. `cli` runs its CLI (undefined when there is none to run); `env` is the agent's env
 * (inherited + PATH + the provider's own). Undefined for providers AppuBot has no check for (custom agents).
 */
export async function checkLogin(providerId: string, cli: CliInvocation | undefined, env: NodeJS.ProcessEnv): Promise<Login | undefined> {
  switch (providerId) {
    case 'claude-code': {
      if (!cli) return UNKNOWN;
      return serialClaude(async () => {
        let r = await run(cli, ['auth', 'status'], env, TIMEOUT.claude);
        if (claudeSoftLoggedOut(r)) {
          await sleep(1000);
          r = await run(cli, ['auth', 'status'], env, TIMEOUT.claude);
        }
        return parseClaudeAuthStatus(r);
      });
    }
    case 'codex': {
      const dir = env.CODEX_HOME || join(home(env), '.codex');
      if (codexCustomProvider(await readText(join(dir, 'config.toml')))) return UNKNOWN;
      const file = codexLoginFromAuthFile(await readText(join(dir, 'auth.json')));
      if (!cli) return file;
      const status = parseCodexLoginStatus(await run(cli, ['-c', 'mcp_servers={}', 'login', 'status'], env, TIMEOUT.codex));
      if (status.state !== 'logged_in') return status.state === 'unknown' ? file : status;
      return compact({ state: 'logged_in', account: file.state === 'logged_in' ? file.account : undefined, plan: status.plan ?? (file.state === 'logged_in' ? file.plan : undefined) });
    }
    case 'cursor': {
      if (!cli) return UNKNOWN;
      return parseCursorStatus(await run(cli, ['status'], env, TIMEOUT.cursor, { NO_OPEN_BROWSER: '1', NO_BROWSER: 'true' }));
    }
    case 'grok': {
      if (str(env.XAI_API_KEY) || str(env.GROK_CODE_XAI_API_KEY)) return { state: 'logged_in', plan: 'API key' };
      const path = env.GROK_AUTH_PATH || join(env.GROK_HOME || join(home(env), '.grok'), 'auth.json');
      return grokLoginFromAuthFile(await readText(path));
    }
    case 'copilot': {
      if (str(env.COPILOT_GITHUB_TOKEN) || str(env.GH_TOKEN) || str(env.GITHUB_TOKEN)) return { state: 'logged_in', plan: 'Token' };
      const own = copilotLoginFromConfig(await readText(join(env.COPILOT_HOME || join(home(env), '.copilot'), 'config.json')));
      if (own.state !== 'logged_out') return own;
      const ghUser = ghUserFromHosts(await readText(join(ghConfigDir(env), 'hosts.yml')), env.GH_HOST || 'github.com');
      return ghUser ? { state: 'logged_in', account: `@${ghUser}`, plan: 'GitHub CLI' } : own;
    }
    case 'opencode': {
      if (!cli) return UNKNOWN;
      // v2's CLI otherwise starts its background service (`opencode serve --service`) and leaves it running;
      // v1 has no --standalone, so a refusal is asked again without it.
      const r = await run(cli, ['auth', 'list', '--standalone'], env, TIMEOUT.opencode);
      const refused = r.code !== 0 && /standalone|unknown|unrecognized|unexpected/i.test(`${r.stdout}\n${r.stderr}`);
      return parseOpenCodeAuthList(refused ? await run(cli, ['auth', 'list'], env, TIMEOUT.opencode) : r);
    }
    default:
      return undefined;
  }
}

/** Sign the CLI out (LOGOUT_ARGS). */
export async function logoutCli(providerId: string, cli: CliInvocation, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; message?: string }> {
  const args = LOGOUT_ARGS[providerId];
  if (!args) return { ok: false, message: 'This agent has no logout command.' };
  const go = () => run(cli, args, env, 20_000, { NO_OPEN_BROWSER: '1', NO_BROWSER: 'true' });
  const r = providerId === 'claude-code' ? await serialClaude(go) : await go();
  const last = stripAnsi(`${r.stdout}\n${r.stderr}`).split('\n').map((l) => l.trim()).filter(Boolean).pop();
  if (r.timedOut) return { ok: false, message: 'Logging out took too long.' };
  if (r.error) return { ok: false, message: r.error };
  return { ok: r.code === 0, ...(last ? { message: last.slice(0, 200) } : {}) };
}
