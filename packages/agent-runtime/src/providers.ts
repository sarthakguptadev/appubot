/**
 * Builtin ACP provider specs + install detection.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { LOGOUT_ARGS, checkLogin, type CliInvocation, type Login } from './login';
import { getPathString, resolveExecutable } from './path';
import { cmdShimTarget, directExecutable, killTree, mergeEnv, processGroup, spawnCommand, withPath } from './spawn';
import { APPUBOT_AI_PROVIDER_ID, FREE_AGENT_DESCRIPTION, PROFILE_HOME_ENV, claudeSessionSettings, creditModelAllowed, providerBase, type SessionMode } from '@appubot/protocol';
import type { ProviderSpec, ProviderStatus } from './types';

export const NODE_COMMAND = '$node';

interface AdapterInfo {
  bin: string;
  version: string;
}

/** Resolve the absolute bin path of a bundled npm adapter package. */
export function resolveAdapterBin(pkg: string): AdapterInfo | undefined {
  try {
    const req = createRequire(import.meta.url);
    const pkgJsonPath = req.resolve(`${pkg}/package.json`);
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version?: string; bin?: string | Record<string, string> };
    let rel: string | undefined;
    if (typeof pkgJson.bin === 'string') rel = pkgJson.bin;
    else if (pkgJson.bin && typeof pkgJson.bin === 'object') rel = Object.values(pkgJson.bin)[0];
    if (!rel) return undefined;
    // the adapter runs from inside app.asar (Electron-as-Node reads it, and its dependencies are only there); the
    // program it drives is the user's own (`adapterCli`)
    const bin = join(dirname(pkgJsonPath), rel);
    if (!existsSync(bin)) return undefined;
    return { bin, version: pkgJson.version ?? '' };
  } catch {
    return undefined;
  }
}

const CLAUDE_PKG = '@agentclientprotocol/claude-agent-acp';
const CODEX_PKG = '@agentclientprotocol/codex-acp';

const claudeAdapter = resolveAdapterBin(CLAUDE_PKG);
const codexAdapter = resolveAdapterBin(CODEX_PKG);

/** Bundled adapter versions keyed by bin path (used by detect for `$node` providers). */
const ADAPTER_VERSIONS = new Map<string, string>();
if (claudeAdapter) ADAPTER_VERSIONS.set(claudeAdapter.bin, claudeAdapter.version);
if (codexAdapter) ADAPTER_VERSIONS.set(codexAdapter.bin, codexAdapter.version);

function adapterSpec(pkg: string, adapter: AdapterInfo | undefined): Pick<ProviderSpec, 'command' | 'args'> {
  return adapter ? { command: NODE_COMMAND, args: [adapter.bin] } : { command: 'npx', args: ['-y', pkg] };
}

const POWERSHELL = (script: string): string => `powershell -NoProfile -ExecutionPolicy Bypass -Command "${script}"`;

/**
 * The line that installs a built-in agent on `platform` by hand: its maker's own installer where there is one
 * (PowerShell on Windows, `curl … | bash` elsewhere), else its npm package. The desktop doesn't run npm for any of
 * them: Codex, Copilot and OpenCode publish their native programs per platform, which it downloads itself
 * (`nativeInstall.ts`), and Claude Code's, Cursor's and Grok's installers need no Node.
 */
export function builtinInstallHint(id: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const win = platform === 'win32';
  switch (id) {
    case 'claude-code': return win ? POWERSHELL('irm https://claude.ai/install.ps1 | iex') : 'curl -fsSL https://claude.ai/install.sh | bash';
    case 'codex': return 'npm i -g @openai/codex';
    case 'cursor': return win ? POWERSHELL("irm 'https://cursor.com/install?win32=true' | iex") : 'curl https://cursor.com/install -fsS | bash';
    case 'grok': return win ? POWERSHELL('irm https://x.ai/cli/install.ps1 | iex') : 'curl -fsSL https://x.ai/cli/install.sh | bash';
    case 'copilot': return 'npm i -g @github/copilot';
    // OpenCode 2's own package (`opencode-ai` is OpenCode 1)
    case 'opencode': return 'npm i -g @opencode/cli';
    default: return undefined;
  }
}

/**
 * The agents AppuBot knows: Claude Code and Codex through their bundled ACP adapters, which drive the user's own
 * `claude` / `codex` (`adapterCli`: AppuBot doesn't ship those, so they install like any agent's CLI), the others
 * through their own CLI's ACP mode (commands as Synara runs them). Order is the order the app lists them in.
 */
export const BUILTIN_PROVIDERS: ProviderSpec[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: "Anthropic's coding agent. Uses your Claude subscription or API key.",
    ...adapterSpec(CLAUDE_PKG, claudeAdapter),
    env: {},
    icon: 'sparkles',
    builtin: true,
    enabled: true,
    installHint: builtinInstallHint('claude-code'),
  },
  {
    id: 'codex',
    name: 'Codex',
    description: "OpenAI's coding agent. Uses your ChatGPT plan or an API key.",
    ...adapterSpec(CODEX_PKG, codexAdapter),
    env: {},
    icon: 'code',
    builtin: true,
    enabled: true,
    installHint: builtinInstallHint('codex'),
  },
  { id: 'cursor', name: 'Cursor', description: "Cursor's agent CLI. Uses your Cursor account.", command: 'cursor-agent', args: ['acp'], env: {}, icon: 'mouse-pointer', builtin: true, enabled: false, installHint: builtinInstallHint('cursor') },
  { id: 'grok', name: 'Grok', description: "xAI's Grok Build agent. Uses your Grok account or XAI_API_KEY.", command: 'grok', args: ['--permission-mode', 'default', 'agent', '--no-leader', 'stdio'], env: {}, icon: 'zap', builtin: true, enabled: false, installHint: builtinInstallHint('grok') },
  { id: 'copilot', name: 'GitHub Copilot', description: "GitHub's Copilot CLI. Uses your GitHub account's Copilot plan.", command: 'copilot', args: ['--acp'], env: {}, icon: 'github', builtin: true, enabled: false, installHint: builtinInstallHint('copilot') },
  // The free agent (protocol `freeModels.ts`): on by default, since its free models need no account. AppuBot installs
  // it itself (the desktop's `freeAgentInstall.ts`).
  { id: 'opencode', name: 'OpenCode', description: FREE_AGENT_DESCRIPTION, command: 'opencode', args: ['acp'], env: {}, icon: 'terminal', builtin: true, enabled: true, installHint: builtinInstallHint('opencode') },
];

/**
 * The permission modes AppuBot offers per agent, in picker order, with its own wording (Synara's): Auto as "Approve for
 * me" (the agent approves safe actions itself and asks about the rest) and Bypass as "Full access" (runs everything
 * without asking), nothing else. The app's pickers show these names and descriptions as they are. Claude Code's ask,
 * plan and accept-edits are hidden, as are Codex's read-only. Every other agent gets `APPROVAL_MODES`, which AppuBot
 * applies itself (`AgentSession`, ChatService's approvals). Saved chats and bots on a hidden mode move to Auto
 * (`toOfferedMode`).
 */
const FULL_ACCESS = 'Runs every action without asking, with full access to your computer';
/**
 * The two choices of an agent whose own modes aren't permission levels (Cursor's Agent / Plan / Ask, Gemini's
 * default / yolo…). Full access switches the agent to its own no-questions mode when it has one (`isNoAskMode`) and
 * AppuBot says yes to whatever it still asks; Approve for me keeps it on a mode that asks, and AppuBot lets reads,
 * searches and its own tools through and asks you about the rest. Stored as Claude Code's ids, like Settings' default.
 */
export const APPROVAL_MODES: readonly SessionMode[] = [
  { id: 'auto', name: 'Approve for me', description: 'Looks around on its own and asks you before it changes files or runs commands' },
  { id: 'bypassPermissions', name: 'Full access', description: FULL_ACCESS },
];
const PROVIDER_MODES: Record<string, SessionMode[]> = {
  'claude-code': [
    { id: 'auto', name: 'Approve for me', description: "Claude Code's auto mode: a classifier approves or blocks each action and asks you when unsure" },
    { id: 'bypassPermissions', name: 'Full access', description: FULL_ACCESS },
  ],
  // codex-acp's own modes: `agent` is its "Auto review" (asks only for actions it finds unsafe), `agent-full-access`
  // its "Full access"; read-only and workspace-write stay hidden
  codex: [
    { id: 'agent', name: 'Approve for me', description: 'Codex reviews each action and asks you only for ones it finds unsafe' },
    { id: 'agent-full-access', name: 'Full access', description: FULL_ACCESS },
  ],
};

/** Each agent's own ids for Auto and Bypass (Settings' default is stored as Claude Code's: `auto`, `bypassPermissions`). */
const AUTO_MODE: Record<string, string> = { 'claude-code': 'auto', codex: 'agent' };
const BYPASS_MODE: Record<string, string> = { 'claude-code': 'bypassPermissions', codex: 'agent-full-access' };

/**
 * A mode on an agent with an offered list: kept when offered, else that agent's Auto (an older Ask permissions, a
 * plan, or the generic `auto` of Settings' default on Codex, whose Auto is `agent`). On the other agents only `auto`
 * means Approve for me: anything else, none included (their own mode ids, or none, from before they had these
 * choices), is Full access, as they ran then.
 */
export function toOfferedMode(providerId: string, modeId: string | undefined): string | undefined {
  const base = providerBase(providerId);
  const allowed = PROVIDER_MODES[base];
  if (!allowed) return modeId === 'auto' ? 'auto' : 'bypassPermissions';
  if (!modeId || allowed.some((m) => m.id === modeId)) return modeId;
  if (modeId === 'bypassPermissions' || modeId === 'agent-full-access') return BYPASS_MODE[base] ?? modeId;
  return AUTO_MODE[base] ?? modeId;
}

/**
 * `modeId` of `providerId` as AppuBot's own choice, `auto` (Approve for me) or `bypassPermissions` (Full access): what
 * a bot keeps when it moves to another agent (`toOfferedMode` then makes it that agent's own).
 */
export function permissionChoice(providerId: string, modeId: string | undefined): 'auto' | 'bypassPermissions' | undefined {
  const offered = toOfferedMode(providerId, modeId);
  if (!offered) return undefined;
  return offered === BYPASS_MODE[providerBase(providerId)] || offered === 'bypassPermissions' ? 'bypassPermissions' : 'auto';
}

/** The modes to show for `providerId`: its allowlist (only those the agent reports), else AppuBot's `APPROVAL_MODES`. */
export function providerModes(providerId: string, modes: SessionMode[]): SessionMode[] {
  const allowed = PROVIDER_MODES[providerBase(providerId)];
  if (!allowed) return APPROVAL_MODES.map((m) => ({ ...m }));
  return allowed.filter((m) => modes.some((x) => x.id === m.id));
}

/** An agent's own mode that never asks: Gemini's and Antigravity's `yolo`, a "Bypass permissions", a "Full access"… */
export function isNoAskMode(m: SessionMode): boolean {
  return /\b(yolo|bypass|full[\s_-]?access|dangerous(ly)?|skip[\s_-]?permissions|allow[\s_-]?all|unrestricted)\b|^(yolo|bypassPermissions|agent-full-access|full-auto)$/i.test(`${m.id} ${m.name}`);
}

/** An agent's own mode that is a way of working rather than of asking (a plan, Cursor's Ask, read-only): never picked for it. */
function isSideMode(m: SessionMode): boolean {
  return /\b(plan|planning|architect|ask|read[\s_-]?only|chat)\b/i.test(`${m.id} ${m.name}`);
}

/**
 * The agent's own mode to put it on for AppuBot's choice (`APPROVAL_MODES`), or undefined to leave it where it is.
 * Full access: its no-questions mode, if it has one. Approve for me: off such a mode, back to the one it started on
 * (else its first plain one); any other mode stays (a mode that asks).
 */
export function agentModeFor(choice: string | undefined, modes: SessionMode[], currentId: string | undefined, startId: string | undefined): string | undefined {
  const current = modes.find((m) => m.id === currentId);
  if (choice === 'auto') {
    if (!current || !isNoAskMode(current)) return undefined;
    const start = modes.find((m) => m.id === startId);
    return (start && !isNoAskMode(start) ? start : modes.find((m) => !isNoAskMode(m) && !isSideMode(m)))?.id;
  }
  if (current && isNoAskMode(current)) return undefined;
  return modes.find(isNoAskMode)?.id;
}

/**
 * Built-ins AppuBot no longer ships (Gemini CLI, Qwen Code, Goose, Kimi). Their saved switches are dropped and bots on
 * them move to the default agent (the desktop's ProvidersService.migrateRetired).
 */
export const RETIRED_PROVIDER_IDS: readonly string[] = ['gemini', 'qwen', 'goose', 'kimi'];

/**
 * A saved spec for a built-in keeps only what is the user's: the switch, extra env and a command of their own. Name,
 * description and hints are always the app's (an older save must not freeze them), and a saved bundled-adapter
 * command is dropped because its path moves with every app version.
 */
export function mergeBuiltin(builtin: ProviderSpec, saved: ProviderSpec): ProviderSpec {
  const own = !!saved.command && saved.command !== builtin.command && saved.command !== NODE_COMMAND && saved.command !== 'npx';
  return {
    ...builtin,
    enabled: saved.enabled ?? builtin.enabled,
    env: { ...builtin.env, ...(saved.env ?? {}) },
    ...(own ? { command: saved.command, args: [...(saved.args ?? [])] } : {}),
    ...(saved.profileName ? { profileName: saved.profileName } : {}),
    builtin: true,
  };
}

/**
 * A saved profile as the runtime runs it: its agent's command (fresh, like `mergeBuiltin`: the bundled adapter's
 * path moves with every app version, a registry agent's with its version), its own name and switch, and its config
 * folder in the agent's `PROFILE_HOME_ENV` variable (which wins over any env of its own).
 */
export function profileSpec(builtin: ProviderSpec, saved: ProviderSpec & { profile: NonNullable<ProviderSpec['profile']> }): ProviderSpec {
  const homeVar = PROFILE_HOME_ENV[builtin.id];
  return {
    ...builtin,
    id: saved.id,
    name: saved.name || `${builtin.name} · ${saved.profile.name}`,
    enabled: saved.enabled ?? true,
    env: { ...builtin.env, ...(saved.env ?? {}), ...(homeVar ? { [homeVar]: saved.profile.home } : {}) },
    builtin: false,
    profile: { ...saved.profile, of: builtin.id },
    ...(saved.oneModel ? { oneModel: saved.oneModel } : {}),
  };
}

/** The CLI each bundled adapter drives (Claude Code's `claude`, Codex's `codex`) and the variable it reads its path from. */
const ADAPTER_CLI: Record<string, { name: string; env: string }> = {
  'claude-code': { name: 'claude', env: 'CLAUDE_CODE_EXECUTABLE' },
  codex: { name: 'codex', env: 'CODEX_PATH' },
};

/** The CLI an agent's bundled adapter drives (`claude`, `codex`), or undefined for an agent without one. */
export const adapterCliName = (providerId: string): string | undefined => ADAPTER_CLI[providerBase(providerId)]?.name;

/**
 * The user's own CLI for an agent run through a bundled adapter: one set in its env (`CLAUDE_CODE_EXECUTABLE`,
 * `CODEX_PATH`), else the one on PATH (the Claude Agent SDK spawns it without a shell: on Windows an npm install's
 * `claude.cmd` becomes its cli.js, which the SDK runs with node). AppuBot doesn't ship them, so without one the agent
 * isn't installed: undefined. Null for an agent without an adapter of AppuBot's.
 */
export async function adapterCli(spec: ProviderSpec, baseEnv: NodeJS.ProcessEnv = process.env): Promise<string | undefined | null> {
  const cli = ADAPTER_CLI[providerBase(spec.id)];
  if (!cli) return null;
  const set = spec.env[cli.env] || baseEnv[cli.env];
  if (set) return set;
  const found = await resolveExecutable(cli.name);
  if (!found) return undefined;
  if (cli.name === 'claude') return directExecutable(found) || found;
  // a shim that runs an `.exe` (the one AppuBot writes for a Codex it installed): the program itself
  const shim = /\.(cmd|bat)$/i.test(found) ? cmdShimTarget(found) : undefined;
  return shim && 'exe' in shim ? shim.exe : found;
}

/**
 * Provider-specific runtime env (computed at spawn time, PATH-dependent): the user's own CLI for an adapter to drive
 * (`adapterCli`: `CLAUDE_CODE_EXECUTABLE` for Claude Code, `CODEX_PATH` for Codex, like Synara: the CLI you install
 * and update is the one that runs). Values already present in the inherited/spec env win.
 */
export async function providerRuntimeEnv(spec: ProviderSpec, baseEnv: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  const cli = ADAPTER_CLI[providerBase(spec.id)];
  if (!cli || baseEnv[cli.env] || spec.env[cli.env]) return {};
  const path = await adapterCli(spec, baseEnv);
  return path ? { [cli.env]: path } : {};
}

/**
 * What a session of this agent starts with beyond plain ACP (`_meta` on session/new, load and resume): Claude Code
 * gets Synara's model catalog as extra picker rows (protocol `claudeSessionSettings`), so it lists the older versions
 * too, not only each family's newest (AppuBot AI: only the Sonnet and Haiku ones).
 */
export function providerSessionMeta(spec: ProviderSpec): Record<string, unknown> | undefined {
  if (providerBase(spec.id) !== 'claude-code') return undefined;
  // AppuBot AI (the launch bonus) pays for Sonnet and Haiku only: the older Fable and Opus rows aren't added
  const settings = spec.id === APPUBOT_AI_PROVIDER_ID ? claudeSessionSettings(creditModelAllowed) : claudeSessionSettings();
  return { claudeCode: { options: { settings } } };
}

/** Default interactive login command per provider (used when the agent did not advertise terminal auth). */
export const DEFAULT_AUTH_COMMANDS: Record<string, { command: string; args: string[] }> = {
  'claude-code': { command: 'claude', args: ['auth', 'login'] },
  codex: { command: 'codex', args: ['login'] },
  cursor: { command: 'cursor-agent', args: ['login'] },
  grok: { command: 'grok', args: ['login'] },
  copilot: { command: 'copilot', args: ['login'] },
  opencode: { command: 'opencode', args: ['auth', 'login'] },
};

const isElectron = (): boolean => typeof process.versions.electron === 'string';

/** Env that makes the Electron binary behave as plain Node (for `$node` commands). */
export function nodeRunEnv(): Record<string, string> {
  return isElectron() ? { ELECTRON_RUN_AS_NODE: '1' } : {};
}

/**
 * How to run a provider's own CLI for login checks and logout: the user's `claude` / `codex` for an agent AppuBot runs
 * through its adapter (`adapterCli`), the agent's command for the rest. Undefined when there is none.
 */
export async function providerCli(spec: ProviderSpec, _nodeExecutable: string): Promise<CliInvocation | undefined> {
  const own = await adapterCli(spec);
  if (own !== null) return own ? { command: own, args: [] } : undefined;
  if (spec.command === NODE_COMMAND || spec.command === 'npx') return undefined;
  const resolved = await resolveExecutable(spec.command);
  return resolved ? { command: resolved, args: [] } : undefined;
}

/** Ask the provider's CLI whether it is logged in (login.ts); undefined for agents without a check. */
export async function probeLogin(spec: ProviderSpec, nodeExecutable: string): Promise<Login | undefined> {
  const PATH = await getPathString();
  const cli = await providerCli(spec, nodeExecutable);
  return checkLogin(providerBase(spec.id), cli, mergeEnv([withPath(process.env, PATH), spec.env]));
}

/** Apply a login check to a status: `auth`, the ACP-level `authStatus` it implies, and whether logout is offered. */
export function withLogin(st: ProviderStatus, login: Login | undefined, canLogOut: boolean, now = Date.now()): ProviderStatus {
  if (!login) return st;
  const authStatus = login.state === 'logged_in' ? 'authenticated' : login.state === 'logged_out' ? 'needs_auth' : st.authStatus;
  // an error left by a failed login is stale once the CLI says it is logged in
  const { lastError, ...rest } = st;
  const keepError = lastError && !(login.state === 'logged_in' && st.authStatus === 'needs_auth');
  return { ...rest, ...(keepError ? { lastError } : {}), authStatus, auth: { ...login, checkedAt: now }, canLogOut };
}

/**
 * Key logins a built-in agent takes beyond what its adapter advertises, so a device with no terminal (a phone on an
 * AppuBot Cloud computer) can still sign it in: Claude Code reads `CLAUDE_CODE_OAUTH_TOKEN` (the token
 * `claude setup-token` prints on any computer) and `ANTHROPIC_API_KEY` from its environment, which AppuBot gives it at
 * every start (`RuntimeHooks.secretEnv`). Codex signs in with its device code (`codex login --device-auth`) instead.
 */
export function builtinKeyLogins(providerId: string): ProviderStatus['authMethods'] {
  if (providerBase(providerId) !== 'claude-code') return [];
  return [
    { id: 'claude-token', name: 'Paste a token', description: 'Run `claude setup-token` on any computer and paste what it prints (a Claude subscription).', kind: 'env_var', vars: [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', label: 'Claude Code token', secret: true, optional: false }], link: 'https://docs.claude.com/en/docs/claude-code/setup' },
    { id: 'anthropic-api-key', name: 'API key', description: 'An Anthropic Console key (API usage billing).', kind: 'env_var', vars: [{ name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', secret: true, optional: false }], link: 'https://console.anthropic.com/settings/keys' },
  ];
}

type LoginMethod = ProviderStatus['authMethods'][number];

/**
 * The account each built-in agent signs in with, its subscription or plan: always offered, first, whatever the
 * agent's ACP handshake advertised (Claude Code's adapter lists its own subscription login only to clients with
 * terminal auth, and a status from before the handshake has none). Its id is the agent's own where it has one, so
 * `authCommand` runs the same CLI login: `claude auth login --claudeai`, `codex login` (`--device-auth` where it
 * runs in the app), `copilot login`, `cursor-agent login`, `grok login`, `opencode auth login`.
 */
const ACCOUNT_LOGINS: Record<string, LoginMethod> = {
  'claude-code': { id: 'claude-ai-login', name: 'Claude subscription', description: 'Sign in with your Claude Pro or Max plan in your browser.', kind: 'terminal' },
  codex: { id: 'chat-gpt', name: 'ChatGPT plan', description: 'Sign in with your ChatGPT account in your browser.', kind: 'terminal' },
  copilot: { id: 'github-login', name: 'GitHub account', description: "Sign in with the GitHub account that has your Copilot plan.", kind: 'terminal' },
  cursor: { id: 'cursor-login', name: 'Cursor account', description: 'Sign in with your Cursor account in your browser.', kind: 'terminal' },
  grok: { id: 'grok-login', name: 'Grok account', description: 'Sign in with your Grok account in your browser.', kind: 'terminal' },
  opencode: { id: 'opencode-login', name: 'Model provider account', description: 'Sign in to a model provider of your own (OpenCode asks which).', kind: 'terminal' },
};

/** A built-in agent's account login (`ACCOUNT_LOGINS`), or undefined for one AppuBot doesn't build in. */
export function builtinAccountLogin(providerId: string): LoginMethod | undefined {
  return ACCOUNT_LOGINS[providerBase(providerId)];
}

/** Every login AppuBot gives a built-in agent by itself: its account first, then its key logins. */
export function builtinLogins(providerId: string): ProviderStatus['authMethods'] {
  const account = builtinAccountLogin(providerId);
  return [...(account ? [account] : []), ...builtinKeyLogins(providerId)];
}

/**
 * `methods` as the app lists them: the agent's account login first (in place of an advertised one with its id),
 * then what the agent advertised, then the built-in key logins it doesn't advertise itself (none twice).
 */
export function withBuiltinLogins(providerId: string, methods: ProviderStatus['authMethods']): ProviderStatus['authMethods'] {
  const account = builtinAccountLogin(providerId);
  const own = account ? methods.filter((m) => m.id !== account.id) : methods;
  const keys = builtinKeyLogins(providerId).filter((k) => !own.some((m) => m.id === k.id));
  return [...(account ? [account] : []), ...own, ...keys];
}

export function emptyStatus(spec: ProviderSpec): ProviderStatus {
  return {
    ...spec,
    installed: false,
    authStatus: 'unknown',
    authMethods: builtinLogins(spec.id),
    capabilities: { loadSession: false, image: false, audio: false, embeddedContext: false },
  };
}

/** Run `<cmd> --version` (5s timeout) and return the first meaningful line. */
export async function probeVersion(command: string, timeoutMs = 5000): Promise<string | undefined> {
  const PATH = await getPathString();
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child: ReturnType<typeof spawnCommand>;
    try {
      child = spawnCommand(command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], env: withPath(process.env, PATH), detached: processGroup() });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      killTree(child, 'SIGKILL');
      finish(undefined);
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => (out += d));
    child.stderr?.on('data', (d: string) => (out += d));
    child.on('error', () => finish(undefined));
    child.on('close', (code) => {
      if (code !== 0 && !out.trim()) return finish(undefined);
      const line = out
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (!line) return finish(undefined);
      const semver = line.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/);
      finish(semver ? semver[0] : line.slice(0, 80));
    });
  });
}

function adapterVersionFor(scriptPath: string | undefined): string | undefined {
  if (!scriptPath) return undefined;
  return ADAPTER_VERSIONS.get(scriptPath);
}

/**
 * Cheap install probe (no ACP handshake), then the CLI's own login check. Keeps the ACP-level auth fields from `prev`.
 */
export async function probeProvider(spec: ProviderSpec, prev: ProviderStatus | undefined, nodeExecutable: string): Promise<ProviderStatus> {
  const base: ProviderStatus = {
    ...emptyStatus(spec),
    ...(prev
      ? {
          authStatus: prev.authStatus === 'not_installed' ? 'unknown' : prev.authStatus,
          authMethods: withBuiltinLogins(spec.id, prev.authMethods),
          capabilities: prev.capabilities,
          ...(prev.lastError ? { lastError: prev.lastError } : {}),
          // ACP logout, learned at the handshake (an agent with a logout command of its own gets it from its login check)
          ...(prev.canLogOut && !LOGOUT_ARGS[providerBase(spec.id)] ? { canLogOut: true } : {}),
        }
      : {}),
  };
  const login = async (st: ProviderStatus): Promise<ProviderStatus> => {
    if (!st.installed) return st;
    const result = await probeLogin(spec, nodeExecutable).catch(() => ({ state: 'unknown' as const }));
    return withLogin(st, result, !!LOGOUT_ARGS[providerBase(spec.id)] && !!(await providerCli(spec, nodeExecutable)));
  };
  if (spec.command === NODE_COMMAND) {
    const script = spec.args[0];
    // an adapter is only half of it: the CLI it drives is the user's to install
    if ((await adapterCli(spec)) === undefined) return { ...base, installed: false, authStatus: 'not_installed' };
    const ok = !!script && (!isAbsolute(script) || existsSync(script));
    const version = adapterVersionFor(script);
    return login({
      ...base,
      installed: ok,
      resolvedCommand: nodeExecutable,
      ...(version ? { version } : {}),
      ...(ok ? {} : { authStatus: 'not_installed' as const, lastError: `Adapter script not found: ${script ?? '(none)'}` }),
    });
  }
  const resolved = await resolveExecutable(spec.command);
  if (!resolved) {
    return { ...base, installed: false, authStatus: 'not_installed' };
  }
  // npx/uvx agents: don't run `npx --version` as the agent version; a registry agent's version is the registry's
  const version = spec.registry?.version ?? (spec.command === 'npx' || spec.command === 'uvx' ? undefined : await probeVersion(resolved));
  return login({ ...base, installed: true, resolvedCommand: resolved, ...(version ? { version } : {}) });
}
