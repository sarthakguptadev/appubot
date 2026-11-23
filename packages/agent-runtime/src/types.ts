/**
 * Public contract of @appubot/agent-runtime.
 * The desktop gateway depends ONLY on these types + `createAgentRuntime()`.
 */
import type { Part, ProviderAuth, SessionMode, SessionModel, SlashCommand, PermissionOptionSchema, ToolContent } from '@appubot/protocol';
import type { z } from 'zod';
import type { AuthMethodInfo } from './errors';
import type { ElicitationAnswer, ElicitationAsk } from './elicitation';

export type PermissionOption = z.infer<typeof PermissionOptionSchema>;

/** How to launch an ACP agent. `command` may be "$node" (resolved to the current Node/Electron-as-node executable). */
export interface ProviderSpec {
  id: string;
  name: string;
  description?: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  icon?: string;
  builtin?: boolean;
  enabled?: boolean;
  installHint?: string;
  /** added from the ACP registry: its entry and version (AppuBot's bookkeeping; the runtime ignores it) */
  registry?: { id: string; version: string };
  /** the registry's monochrome SVG icon */
  iconSvg?: string;
  /**
   * A profile of a built-in (protocol ProviderProfileSchema): it runs `of`'s command with `home` as its config folder
   * (`PROFILE_HOME_ENV`); its id is `<of>@<slug>`.
   */
  profile?: { of: string; name: string; home: string; source?: 'appubot' | 'synara' | 'folder' | 'credit' };
  /** a built-in that has profiles: the name of its default one (the user's; absent = "Default") */
  profileName?: string;
  /**
   * The agent offers exactly this model, under this name (AppuBot's launch gift: "Claude"): its own list is replaced by
   * the one row, nothing is set on the agent (its environment picks the model) and no other can be picked.
   */
  oneModel?: { id: string; name: string };
}

export interface ProviderStatus extends ProviderSpec {
  installed: boolean;
  version?: string;
  authStatus: 'unknown' | 'authenticated' | 'needs_auth' | 'not_installed' | 'error';
  authMethods: AuthMethodInfo[];
  capabilities: { loadSession: boolean; image: boolean; audio: boolean; embeddedContext: boolean };
  lastError?: string;
  resolvedCommand?: string;
  /** the CLI's own login, checked by `detectProviders` (absent for agents without a check, or not installed) */
  auth?: ProviderAuth;
  /** `logout()` can sign this CLI out */
  canLogOut?: boolean;
}

export interface McpServerStdio { type?: 'stdio'; name: string; command: string; args: string[]; env: Record<string, string> }
/** Remote MCP server over streamable HTTP. Only handed to agents that advertise `mcpCapabilities.http` (skipped otherwise). */
export interface McpServerHttp { type: 'http'; name: string; url: string; headers: Record<string, string> }
export type McpServer = McpServerStdio | McpServerHttp;

/**
 * Whose logins an agent process runs with (a team's AppuBot Cloud computer on "each person uses their own"): a home
 * folder of that person's, which becomes `HOME` and the XDG folders of the process (every CLI keeps its login under its
 * home: `~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.gemini`…), with the agent's own config-folder variable
 * (`PROFILE_HOME_ENV`) cleared so its default under that home applies (a profile keeps its own folder); and a `loginScope`
 * the host's `secretEnv` hook keys its saved API keys by. Absent: the computer's own logins, as on a Mac.
 */
export interface LoginEnv { loginHome?: string; loginScope?: string }

export interface CreateSessionOptions extends LoginEnv {
  providerId: string;
  cwd: string;                       // absolute
  mcpServers?: McpServer[];
  env?: Record<string, string>;      // extra env for the agent process
  /** resume an existing ACP session id if the provider supports loadSession */
  resumeSessionId?: string;
  modeId?: string;
  modelId?: string;
  /** reasoning effort (the agent's `thought_level` option), applied when the model offers it */
  effortId?: string;
  /** fast mode (Claude Code's `fast` option), applied after the model when that model offers it */
  fast?: boolean;
}

export interface SessionInfo {
  id: string;                        // runtime session id (== ACP sessionId when known)
  providerId: string;
  cwd: string;
  modes: SessionMode[];
  currentModeId?: string;
  models: SessionModel[];
  currentModelId?: string;
  /** the current model's reasoning efforts (none when it has no such choice) */
  efforts: SessionModel[];
  currentEffortId?: string;
  /** the current model offers fast mode (Claude Code's `fast` option) */
  fastAvailable: boolean;
  fastEnabled: boolean;
  commands: SlashCommand[];
  state: 'starting' | 'ready' | 'prompting' | 'closed' | 'error';
  error?: string;
  pid?: number;
}

/** Prompt content the gateway sends. */
export type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string; size?: number }
  | { type: 'resource'; uri: string; mimeType: string; text: string };

export interface PromptResult { stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }

/**
 * Normalized turn operations. The runtime converts raw ACP `session/update`s into these so the
 * gateway/UI never sees ACP shapes. `partIndex` addresses `Part[]` of the *current agent message*.
 */
export type TurnOp =
  | { op: 'delta'; partIndex: number; partType: 'text' | 'thought'; delta: string }
  | { op: 'part'; partIndex: number; part: Part }         // upsert whole part (tool_call, image, plan, system)
  | { op: 'user_echo'; part: Part }                       // replayed user content (session/load)
  | { op: 'modes'; modes: SessionMode[]; currentModeId?: string }
  | { op: 'models'; models: SessionModel[]; currentModelId?: string }
  | { op: 'efforts'; efforts: SessionModel[]; currentEffortId?: string }
  | { op: 'fast'; available: boolean; enabled: boolean }
  | { op: 'commands'; commands: SlashCommand[] }
  | { op: 'mode_changed'; modeId: string }
  | { op: 'title'; title: string }
  | { op: 'terminal_output'; terminalId: string; chunk: string }
  | { op: 'usage'; used: number; size: number }
  /** Claude Code's word on the plan's rate limits, as its adapter forwards it (`usage_update._meta["_claude/rateLimit"]`) */
  | { op: 'rateLimit'; info: ClaudeRateLimitInfo };

/**
 * Claude Code's `rate_limit_event` (the Claude Agent SDK's `SDKRateLimitInfo`, read loosely: an older or newer CLI may
 * send more or less). The top-level fields describe the window that binds now; `unifiedWindows` (Claude Code 2.1.3xx)
 * every window it tracks, read from the API's `anthropic-ratelimit-unified-*` headers. Utilizations here are
 * fractions (0..1, over 1 past a cap), reset times epoch seconds.
 */
export interface ClaudeRateLimitInfo {
  status?: 'allowed' | 'allowed_warning' | 'rejected' | string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  overageStatus?: string;
  isUsingOverage?: boolean;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number; status?: string } | undefined>;
}

export interface PermissionAsk {
  sessionId: string;
  toolCallId?: string;
  title: string;
  /** the AppuBot bridge tool it is for (`ask_user`, `remember`…): `title` is its friendly label */
  bridgeTool?: string;
  /** a question in a permission request's clothes (Antigravity's): `title` asks it, the options' names answer it */
  question?: boolean;
  kind: Part extends { type: 'tool_call'; kind: infer K } ? K : string;
  content: ToolContent[];
  rawInput?: unknown;
  options: PermissionOption[];
}

export interface RuntimeHooks {
  /** Must resolve with the chosen optionId, or null if cancelled. Blocks the agent turn until resolved. */
  requestPermission(ask: PermissionAsk): Promise<string | null>;
  /**
   * A form the agent itself asks the user to fill in (ACP `elicitation/create`: OpenCode's own `question` tool). Only
   * a runtime given this says it takes forms; without it such a question is dismissed by the agent at once. Blocks the
   * turn until answered: `cancel` when nobody answers.
   */
  requestInput?(ask: ElicitationAsk): Promise<ElicitationAnswer>;
  onTurnOp(sessionId: string, op: TurnOp): void;
  onSessionState(info: SessionInfo): void;
  /** stderr lines / diagnostics */
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>): void;
  /**
   * Keys the user saved for an agent (API keys for its login): added to its environment whenever it starts, and kept
   * out of specs, statuses and the line a terminal login runs.
   */
  secretEnv?(providerId: string, loginScope?: string): Record<string, string> | undefined;
  /** An agent's sign-in page, caught while the user signs in to it (`login`): open it in their browser. */
  openAuthUrl?(providerId: string, url: string): void;
  /**
   * While signing in, any OAuth link the agent prints (https, with a `redirect_uri`) counts as its sign-in page, not
   * only its quirks' known pages: set for a sign-in made for another device (`login`'s `onAuthUrl`), where the agent
   * can't open a browser anyone sees.
   */
  catchSignInLinks?: boolean;
}

export interface AgentRuntime {
  /**
   * Register/replace provider specs (builtins are pre-registered). For a built-in id only the user's parts of the
   * spec apply (enabled, env, a command of their own): see `mergeBuiltin`.
   */
  setProviders(specs: ProviderSpec[]): void;
  getProviders(): ProviderSpec[];
  /**
   * Probe install status, version and the CLI's own login for all (or some) providers. Cheap checks only (command
   * resolvable, `--version`, the login check in login.ts); the ACP handshake waits for a session. Explicit ids are
   * always re-probed; without ids only providers not probed yet are.
   */
  detectProviders(ids?: string[]): Promise<ProviderStatus[]>;
  createSession(opts: CreateSessionOptions): Promise<SessionInfo>;
  getSession(id: string): SessionInfo | undefined;
  listSessions(): SessionInfo[];
  prompt(sessionId: string, blocks: PromptBlock[]): Promise<PromptResult>;
  cancel(sessionId: string): Promise<void>;
  /**
   * Put a message into the turn that is running (ACP steering, `_session/steering`, where the agent advertises
   * `_meta.steering.supported` at initialize: Claude Code's adapter), the way a message typed into Claude Code mid-task
   * reaches it. The turn's own `prompt()` goes on and settles once the steered message is answered; the reply to it
   * starts a new part. False when it can't (no steering, no turn running, an error): send it as the next prompt.
   */
  steer(sessionId: string, blocks: PromptBlock[]): Promise<boolean>;
  /**
   * Ask the agent one of its own ACP extension methods (`_x.ai/billing`: what Grok's plan has left) in a process
   * started for that alone: the handshake, the call, exit; no session is made or reported. Throws when the agent
   * refuses it or doesn't answer within `timeoutMs` (default 20 s).
   */
  extMethod(providerId: string, method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number; login?: LoginEnv }): Promise<unknown>;
  setMode(sessionId: string, modeId: string): Promise<SessionInfo>;
  setModel(sessionId: string, modelId: string): Promise<SessionInfo>;
  setEffort(sessionId: string, effortId: string): Promise<SessionInfo>;
  /** Turn fast mode on/off; throws when the current model doesn't offer it. */
  setFast(sessionId: string, enabled: boolean): Promise<SessionInfo>;
  closeSession(sessionId: string): Promise<void>;
  /**
   * Start the agent for the ACP handshake only, so its logins and capabilities are known before any session (they
   * land in its status, which is returned). Throws if it can't start.
   */
  probe(providerId: string): Promise<ProviderStatus>;
  /**
   * An `agent`-kind login: the agent signs in by itself (usually in the browser) through ACP `authenticate`. Resolves
   * once it has, or throws (refused, the agent exited, or `timeoutMs`, default 10 min). `onAuthUrl`: the sign-in is
   * for another device, so its page goes there (caught through `BROWSER` or what the agent prints) instead of
   * `RuntimeHooks.openAuthUrl`.
   */
  login(providerId: string, methodId: string, timeoutMs?: number, login?: LoginEnv, onAuthUrl?: (url: string) => void): Promise<void>;
  /** For terminal-type auth methods: returns a shell command the user can run (we open Terminal.app with it). */
  authCommand(providerId: string, methodId?: string, login?: LoginEnv): Promise<{ command: string; args: string[]; env: Record<string, string> } | null>;
  /** the CLI's own login as seen with these logins (a team member's home), without touching the provider's status */
  loginState(providerId: string, login: LoginEnv): Promise<ProviderAuth | undefined>;
  /**
   * Sign the agent out on this machine (only when its status has `canLogOut`): its CLI's logout command, else ACP
   * `logout` for an agent that offers it.
   */
  logout(providerId: string, login?: LoginEnv): Promise<{ ok: boolean; message?: string }>;
  shutdown(): Promise<void>;
}

export interface RuntimeOptions {
  hooks: RuntimeHooks;
  /** absolute path of the node executable to use for "$node" providers; default: process.execPath (with ELECTRON_RUN_AS_NODE=1 when running under Electron) */
  nodeExecutable?: string;
  /** extra PATH entries (login-shell PATH is auto-detected on macOS) */
  extraPath?: string[];
  dataDir?: string;
  /**
   * Variables of this process's environment that no agent (nor a login or logout it runs) may inherit: an AppuBot
   * Cloud computer's control and backend tokens. Dropped from the base environment of every spawn.
   */
  hideEnv?: readonly string[];
}
