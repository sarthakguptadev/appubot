/**
 * One ACP agent process per session: spawn, ndjson wiring, ClientSideConnection,
 * Client implementation (permissions, fs, terminals) and lifecycle.
 */
import type { ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { Readable, Transform, Writable } from 'node:stream';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type AuthMethod,
  type Client,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type InitializeResponse,
  type KillTerminalRequest,
  type McpCapabilities,
  type McpServer as AcpMcpServer,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import {
  AUTH_REQUIRED_CODE,
  AgentAuthError,
  AgentBusyError,
  AgentProcessError,
  errorMessage,
  rpcErrorCode,
  type AuthMethodInfo,
} from './errors';
import { TurnAssembler, bridgeToolFromInput, bridgeToolName, extractConfig } from './normalize';
import type { ExtractedConfig } from './normalize';
import { APPROVAL_MODES, agentModeFor, providerModes, providerSessionMeta } from './providers';
import { APPUBOT_AI_PROVIDER_ID, CREDIT_MODELS_TEXT, creditModelAllowed, hasPermissionModes, type SessionMode, type SessionModel } from '@appubot/protocol';
import { TerminalManager } from './terminals';
import { killGroup, killTree, processGroup, spawnCommand } from './spawn';
import { capturedUrl, quirksFor } from './quirks';
import { elicitationFields } from './elicitation';
import type {
  CreateSessionOptions,
  McpServer,
  PermissionAsk,
  PromptBlock,
  PromptResult,
  ProviderSpec,
  RuntimeHooks,
  SessionInfo,
  TurnOp,
} from './types';

export const CLIENT_VERSION = '0.1.0';
/** ACP steering's request (an extension): a message into the running turn (`steer`) */
const STEER_METHOD = '_session/steering';
const INIT_TIMEOUT_MS = 60_000;
const SESSION_TIMEOUT_MS = 180_000;
const STDERR_TAIL = 30;
/** how long an agent's own extension method may take to answer */
const EXT_METHOD_TIMEOUT_MS = 20_000;

export interface SpawnSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface AgentSessionEvents {
  /** handshake learned capabilities / auth methods */
  onInitialized(init: InitializeResponse): void;
  /** the agent refused for auth reasons */
  onAuthRequired(methods: AuthMethodInfo[], message: string): void;
  /** process exited (expected or not) */
  onExit(session: AgentSession): void;
}

/** `detail` is read when the time runs out: what the process had printed by then (`AgentSession.silentSuffix`). */
function withTimeout<T>(p: Promise<T>, ms: number, what: string, detail?: () => string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new AgentProcessError(`${what} timed out after ${Math.round(ms / 1000)}s${detail?.() ?? ''}`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function toAcpBlocks(blocks: PromptBlock[]): ContentBlock[] {
  return blocks.map((b): ContentBlock => {
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text };
      case 'image':
        return { type: 'image', mimeType: b.mimeType, data: b.data };
      case 'resource_link':
        return {
          type: 'resource_link',
          uri: b.uri,
          name: b.name,
          ...(b.mimeType ? { mimeType: b.mimeType } : {}),
          ...(typeof b.size === 'number' ? { size: b.size } : {}),
        };
      case 'resource':
        return { type: 'resource', resource: { uri: b.uri, mimeType: b.mimeType, text: b.text } };
    }
  });
}

/**
 * Our MCP server specs → ACP's. HTTP servers go only to agents advertising `mcpCapabilities.http`;
 * the rest are dropped with a warning (the turn still runs, just without those tools).
 */
export function toAcpMcpServers(servers: McpServer[], caps: McpCapabilities | undefined, warn: (msg: string) => void): AcpMcpServer[] {
  const out: AcpMcpServer[] = [];
  for (const s of servers) {
    if (s.type === 'http') {
      if (!caps?.http) { warn(`agent does not support HTTP MCP servers; skipping "${s.name}"`); continue; }
      out.push({ type: 'http', name: s.name, url: s.url, headers: Object.entries(s.headers).map(([name, value]) => ({ name, value })) });
      continue;
    }
    out.push({ name: s.name, command: s.command, args: s.args, env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })) });
  }
  return out;
}

/**
 * Logins that take keys before `authenticate` (agents advertise them as plain `agent` logins): an API key from the
 * environment (Gemini CLI's and Antigravity's `gemini-api-key`), Antigravity's Gemini Enterprise sign-in with its
 * Google Cloud project and location, and its Agent Platform login with an API key or a project and location (with
 * the Mac's Application Default Credentials). The project and location also go in its settings (quirks.ts).
 */
const GCP_PROJECT = { name: 'GOOGLE_CLOUD_PROJECT', label: 'Google Cloud project', secret: false };
const GCP_LOCATION = { name: 'GOOGLE_CLOUD_LOCATION', label: 'Location (e.g. us-central1)', secret: false };
const KEY_LOGINS: Record<string, { vars: NonNullable<AuthMethodInfo['vars']>; link: string }> = {
  'gemini-api-key': { vars: [{ name: 'GEMINI_API_KEY', label: 'Gemini API key', secret: true, optional: false }], link: 'https://aistudio.google.com/apikey' },
  'oauth-business': { vars: [{ ...GCP_PROJECT, optional: false }, { ...GCP_LOCATION, optional: false }], link: 'https://console.cloud.google.com/' },
  'agent-platform': {
    vars: [{ name: 'GOOGLE_API_KEY', label: 'API key', secret: true, optional: true }, { ...GCP_PROJECT, optional: true }, { ...GCP_LOCATION, optional: true }],
    link: 'https://console.cloud.google.com/apis/credentials',
  },
};

/** An `env_var` login's keys: the spec's `vars` (`{ name, label?, secret?, optional? }`), or the older single `varName`. */
function envVarsOf(m: Record<string, unknown>): NonNullable<AuthMethodInfo['vars']> {
  const list = Array.isArray(m.vars) ? m.vars : typeof m.varName === 'string' ? [{ name: m.varName }] : [];
  return list.flatMap((v) => {
    const x = v as Record<string, unknown>;
    if (typeof x.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(x.name)) return [];
    return [{ name: x.name, ...(typeof x.label === 'string' && x.label ? { label: x.label } : {}), secret: x.secret !== false, optional: x.optional === true }];
  });
}

export function authMethodInfos(methods: AuthMethod[] | undefined): AuthMethodInfo[] {
  return (methods ?? []).map((m) => {
    const raw = m as AuthMethod & Record<string, unknown>;
    const type = typeof raw.type === 'string' ? raw.type : 'agent';
    const base = { id: m.id, name: m.name, ...(m.description ? { description: m.description } : {}) };
    if (type === 'terminal') return { ...base, kind: 'terminal' as const };
    if (type === 'env_var') {
      const link = typeof raw.link === 'string' && /^https?:\/\//.test(raw.link) ? raw.link : undefined;
      return { ...base, kind: 'env_var' as const, vars: envVarsOf(raw), ...(link ? { link } : {}) };
    }
    const key = KEY_LOGINS[m.id];
    return { ...base, kind: 'agent' as const, ...(key ? { vars: key.vars, link: key.link } : {}) };
  });
}

export class AgentSession {
  readonly info: SessionInfo;
  readonly assembler = new TurnAssembler();
  private child?: ChildProcess;
  private conn?: ClientSideConnection;
  private terminals: TerminalManager;
  private replaying = false;
  private closing = false;
  private exited = false;
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private resolveExit!: (v: { code: number | null; signal: NodeJS.Signals | null }) => void;
  private stderrTail: string[] = [];
  private pendingPermissionCancels = new Set<() => void>();
  private promptCancelled = false;
  /** races a call against the agent failing to spawn or exiting (set by `connect`) */
  private guard!: <T>(p: Promise<T>, ms: number, what: string) => Promise<T>;
  private modelConfigId?: string;
  private effortConfigId?: string;
  private fastConfigId?: string;
  private fastKind?: 'boolean' | 'select';
  private modeConfigId?: string;
  /** modes came from `modes` (session/set_mode) rather than config options */
  private nativeModes = false;
  /**
   * The agent's own modes aren't permission levels (all but Claude Code and Codex): `info.modes` are AppuBot's
   * `APPROVAL_MODES` and `info.currentModeId` the user's choice, which `applyApproval` turns into one of the agent's own
   * modes, kept here.
   */
  private readonly approvals: boolean;
  private agentModes: SessionMode[] = [];
  private agentModeId?: string;
  /** the mode the agent came up on (Approve for me goes back to it from a no-questions one) */
  private agentStartModeId?: string;
  /** `login` is running: a sign-in page the agent opens (`quirks.ts`) goes to the user's browser */
  private signingIn = false;
  /** the sign-in page the agent opened; outside `login` it means this session needs a login */
  private authUrl?: string;
  init?: InitializeResponse;

  constructor(
    readonly spec: ProviderSpec,
    private readonly spawnSpec: SpawnSpec,
    private readonly opts: CreateSessionOptions,
    private readonly hooks: RuntimeHooks,
    private readonly events: AgentSessionEvents,
  ) {
    this.approvals = !hasPermissionModes(spec.id);
    this.info = {
      id: '',
      providerId: spec.id,
      cwd: opts.cwd,
      modes: this.approvals ? APPROVAL_MODES.map((m) => ({ ...m })) : [],
      ...(this.approvals ? { currentModeId: opts.modeId === 'auto' ? 'auto' : 'bypassPermissions' } : {}),
      models: [],
      efforts: [],
      fastAvailable: false,
      fastEnabled: false,
      commands: [],
      state: 'starting',
    };
    this.exitPromise = new Promise((r) => (this.resolveExit = r));
    this.terminals = new TerminalManager({
      cwd: opts.cwd,
      env: spawnSpec.env,
      onOutput: (terminalId, chunk) => {
        this.assembler.appendTerminalOutput(terminalId, chunk);
        this.emitOp({ op: 'terminal_output', terminalId, chunk });
      },
      onExit: (terminalId, status) => this.assembler.setTerminalExit(terminalId, status.exitCode),
    });
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get alive(): boolean {
    return !!this.child && !this.exited;
  }

  /* ---------------- startup ---------------- */

  /** Spawn the agent and run the ACP handshake (no session yet). The caller closes it on failure. */
  private async connect(): Promise<InitializeResponse> {
    const child = spawnCommand(this.spawnSpec.command, this.spawnSpec.args, {
      cwd: this.opts.cwd,
      env: this.spawnSpec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: processGroup(),
    });
    this.child = child;
    if (child.pid !== undefined) this.info.pid = child.pid;

    const spawnError = new Promise<never>((_, reject) => {
      child.once('error', (err) => reject(new AgentProcessError(`Failed to start ${this.spec.name} (${this.spawnSpec.command}): ${err.message}`)));
    });
    spawnError.catch(() => undefined);

    child.on('exit', (code, signal) => this.handleExit(code, signal));
    child.stdin?.on('error', (err) => this.hooks.log('debug', `[${this.spec.id}] stdin error: ${err.message}`));

    if (child.stderr) {
      const rl = createInterface({ input: child.stderr });
      rl.on('line', (line) => {
        // while signing in for another device, an OAuth link the agent prints counts as its sign-in page too
        const url = capturedUrl(line) ?? (this.signingIn && this.hooks.catchSignInLinks ? authorizeLink(line) : undefined);
        if (url) return this.onAuthUrl(url);
        this.stderrTail.push(line);
        if (this.stderrTail.length > STDERR_TAIL) this.stderrTail.shift();
        this.hooks.log('debug', `[${this.spec.id}] ${line}`, { sessionId: this.info.id || undefined, pid: child.pid });
      });
    }

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!.pipe(this.jsonLinesOnly())) as unknown as ReadableStream<Uint8Array>,
    );
    this.conn = new ClientSideConnection(() => this.makeClient(), stream);

    const exitedEarly = this.exitPromise.then(({ code, signal }) => {
      throw new AgentProcessError(
        `${this.spec.name} exited during startup (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})${this.stderrSuffix()}`,
        code,
        signal,
      );
    });
    exitedEarly.catch(() => undefined);
    this.guard = <T>(p: Promise<T>, ms: number, what: string) => Promise.race([withTimeout(p, ms, what, () => this.silentSuffix()), spawnError, exitedEarly]);

    const init = await this.guard(
      this.conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
          auth: { terminal: true },
          // forms the agent asks the user to fill in (OpenCode's own `question` tool dismisses itself without this)
          ...(this.hooks.requestInput ? { elicitation: { form: {} } } : {}),
        },
        clientInfo: { name: 'appubot', title: 'AppuBot', version: CLIENT_VERSION },
      }),
      INIT_TIMEOUT_MS,
      'initialize',
    );
    this.init = init;
    this.events.onInitialized(init);
    return init;
  }

  /**
   * The agent's stdout as JSON-RPC lines only: anything else it prints there (a banner, Antigravity's "Open the
   * following link to authenticate…") is logged and dropped rather than answered as a parse error. A sign-in page
   * among it is caught like one from `BROWSER`.
   */
  private jsonLinesOnly(): Transform {
    let rest = '';
    // a character split across two chunks stays whole
    const decoder = new StringDecoder('utf8');
    const keep = (line: string): boolean => {
      const t = line.trim();
      if (!t || t.startsWith('{') || t.startsWith('[')) return true;
      const url = capturedUrl(t) ?? t.match(/https:\/\/\S+/)?.[0];
      if (url) this.onAuthUrl(url);
      this.hooks.log('debug', `[${this.spec.id}] (stdout) ${t.slice(0, 300)}`);
      return false;
    };
    return new Transform({
      transform(chunk: Buffer, _enc, done) {
        const lines = (rest + decoder.write(chunk)).split('\n');
        rest = lines.pop() ?? '';
        const out = lines.filter(keep);
        done(null, out.length ? `${out.join('\n')}\n` : undefined);
      },
      flush(done) {
        rest += decoder.end();
        done(null, rest && keep(rest) ? rest : undefined);
      },
    });
  }

  /**
   * A sign-in page the agent opened (`quirks.ts`: only its known sign-in pages count). While the user signs in it goes
   * to their browser; anywhere else the agent needs a login, which never pops up behind the user's back: the session
   * ends asking for one.
   */
  private onAuthUrl(url: string): void {
    // an agent's known sign-in pages; while signing in for another device, any OAuth link it opens or prints
    const known = !!quirksFor(this.spec)?.authUrl.test(url) || (this.signingIn && !!this.hooks.catchSignInLinks && !!authorizeLink(url));
    if (!known || this.authUrl === url) return;
    this.authUrl = url;
    if (this.signingIn) {
      this.hooks.openAuthUrl?.(this.spec.id, url);
      return;
    }
    this.hooks.log('warn', `[${this.spec.id}] wants a login outside a sign-in; ending the session`);
    this.events.onAuthRequired(authMethodInfos(this.init?.authMethods), `${this.spec.name} needs you to sign in again`);
    void this.close();
  }

  /** The error for a session that ended wanting a login (`onAuthUrl`), else `err` as it was. */
  private loginNeeded(err: unknown): unknown {
    if (!this.authUrl || this.signingIn) return err;
    return new AgentAuthError(this.spec.id, authMethodInfos(this.init?.authMethods), `${this.spec.name} needs you to sign in again: log in to it in Settings › Agents`);
  }

  async start(): Promise<SessionInfo> {
    try {
      const init = await this.connect();

      const mcpServers = toAcpMcpServers(this.opts.mcpServers ?? [], init.agentCapabilities?.mcpCapabilities, (msg) => this.hooks.log('warn', `[${this.spec.id}] ${msg}`));

      // what this agent's sessions start with beyond plain ACP (Claude Code: its model catalog)
      const sessionMeta = providerSessionMeta(this.spec);
      const meta = sessionMeta ? { _meta: sessionMeta } : {};
      let modes: SessionModeState | null | undefined;
      let configOptions: SessionConfigOption[] | null | undefined;
      try {
        if (this.opts.resumeSessionId && init.agentCapabilities?.loadSession) {
          this.info.id = this.opts.resumeSessionId;
          this.replaying = true;
          try {
            const res = await this.guard(
              this.conn!.loadSession({ sessionId: this.opts.resumeSessionId, cwd: this.opts.cwd, mcpServers, ...meta }),
              SESSION_TIMEOUT_MS,
              'session/load',
            );
            modes = res?.modes;
            configOptions = res?.configOptions;
          } finally {
            this.replaying = false;
            this.assembler.reset();
          }
        } else if (this.opts.resumeSessionId && init.agentCapabilities?.sessionCapabilities?.resume) {
          // an agent that can pick a session up but not replay it: it goes on where it was, without its history
          this.info.id = this.opts.resumeSessionId;
          const res = await this.guard(
            this.conn!.resumeSession({ sessionId: this.opts.resumeSessionId, cwd: this.opts.cwd, mcpServers, ...meta }),
            SESSION_TIMEOUT_MS,
            'session/resume',
          );
          modes = res?.modes;
          configOptions = res?.configOptions;
        } else {
          const res = await this.guard(this.conn!.newSession({ cwd: this.opts.cwd, mcpServers, ...meta }), SESSION_TIMEOUT_MS, 'session/new');
          this.info.id = res.sessionId;
          modes = res.modes;
          configOptions = res.configOptions;
        }
      } catch (err) {
        if (rpcErrorCode(err) === AUTH_REQUIRED_CODE) {
          const methods = authMethodInfos(init.authMethods);
          const msg = errorMessage(err) || 'Authentication required';
          this.events.onAuthRequired(methods, msg);
          throw new AgentAuthError(this.spec.id, methods, `${this.spec.name}: ${msg}`);
        }
        throw err;
      }

      this.applyModes(modes);
      this.applyConfigOptions(configOptions);
      this.info.state = 'ready';

      if (this.approvals) {
        await this.applyApproval().catch((e) => this.hooks.log('warn', `[${this.spec.id}] switching its own mode for ${this.info.currentModeId} failed: ${errorMessage(e)}`));
      } else if (this.opts.modeId && this.opts.modeId !== this.info.currentModeId && (!this.info.modes.length || this.info.modes.some((m) => m.id === this.opts.modeId))) {
        // a mode AppuBot no longer offers (e.g. an older bot's "plan") is left to the agent's default
        await this.setMode(this.opts.modeId).catch((e) => this.hooks.log('warn', `[${this.spec.id}] setMode(${this.opts.modeId}) failed: ${errorMessage(e)}`));
      }
      if (this.opts.modelId && this.opts.modelId !== this.info.currentModelId) {
        await this.setModel(this.opts.modelId).catch((e) => this.hooks.log('warn', `[${this.spec.id}] setModel(${this.opts.modelId}) failed: ${errorMessage(e)}`));
      }
      // after the model: its efforts are the ones on offer; an effort the model lacks is left to the agent
      if (this.opts.effortId && this.opts.effortId !== this.info.currentEffortId && this.info.efforts.some((x) => x.id === this.opts.effortId)) {
        await this.setEffort(this.opts.effortId).catch((e) => this.hooks.log('warn', `[${this.spec.id}] setEffort(${this.opts.effortId}) failed: ${errorMessage(e)}`));
      }
      // fast mode likewise, only where the model offers it
      if (this.opts.fast !== undefined && this.info.fastAvailable && this.opts.fast !== this.info.fastEnabled) {
        await this.setFast(this.opts.fast).catch((e) => this.hooks.log('warn', `[${this.spec.id}] setFast(${this.opts.fast}) failed: ${errorMessage(e)}`));
      }
      return this.snapshot();
    } catch (err) {
      await this.close(false);
      throw this.loginNeeded(err);
    }
  }

  private stderrSuffix(): string {
    const tail = this.stderrTail.slice(-8).join('\n').trim();
    return tail ? `\n${tail}` : '';
  }

  /**
   * For a request the agent never answered: its last error lines, or that it is running and has printed none. Its
   * stderr is otherwise only in the debug log, so a timeout would say nothing of why (a Windows report, 2026-11-13:
   * every agent "timed out after 60s" and the log held no word from any of them).
   */
  private silentSuffix(): string {
    return this.stderrSuffix() || ` (${this.spec.name} is running but printed no error)`;
  }

  /* ---------------- state helpers ---------------- */

  snapshot(): SessionInfo {
    return structuredClone(this.info);
  }

  private emitState(): void {
    if (!this.info.id) return;
    this.hooks.onSessionState(this.snapshot());
  }

  private emitOp(op: TurnOp): void {
    const sid = this.info.id;
    if (!sid) return;
    try {
      this.hooks.onTurnOp(sid, op);
    } catch (err) {
      this.hooks.log('error', `onTurnOp hook threw: ${errorMessage(err)}`);
    }
  }

  private applyModes(modes: SessionModeState | null | undefined): void {
    if (!modes) return;
    this.nativeModes = true;
    const list = (modes.availableModes ?? []).map((m) => ({ id: m.id, name: m.name, ...(m.description ? { description: m.description } : {}) }));
    if (this.approvals) return this.setAgentModes(list, modes.currentModeId);
    this.info.modes = providerModes(this.spec.id, list);
    this.info.currentModeId = modes.currentModeId;
  }

  /** The agent's own modes, for an agent on AppuBot's approvals (its `info.modes` stay `APPROVAL_MODES`). */
  private setAgentModes(modes: SessionMode[] | undefined, currentId: string | undefined): void {
    if (modes) this.agentModes = modes;
    if (currentId) {
      this.agentModeId = currentId;
      this.agentStartModeId ??= currentId;
    }
  }

  private applyConfigOptions(configOptions: SessionConfigOption[] | null | undefined): void {
    if (!configOptions) return;
    const cfg = extractConfig(configOptions);
    if (cfg.models) {
      this.info.models = this.offeredModels(cfg.models);
      this.modelConfigId = cfg.modelConfigId;
      if (cfg.currentModelId && !this.spec.oneModel) this.info.currentModelId = cfg.currentModelId;
    }
    // config options come as a full set: without an effort option the current model has no effort choice
    this.info.efforts = cfg.efforts ?? [];
    this.effortConfigId = cfg.effortConfigId;
    this.info.currentEffortId = cfg.currentEffortId;
    this.applyFast(cfg);
    if (cfg.modes && this.approvals) {
      this.modeConfigId = cfg.modeConfigId;
      this.setAgentModes(!this.nativeModes || this.agentModes.length === 0 ? cfg.modes : undefined, cfg.currentModeId);
    } else if (cfg.modes) {
      this.modeConfigId = cfg.modeConfigId;
      if (!this.nativeModes || this.info.modes.length === 0) {
        this.info.modes = providerModes(this.spec.id, cfg.modes);
        if (cfg.currentModeId) this.info.currentModeId = cfg.currentModeId;
      } else if (cfg.currentModeId && this.info.modes.some((m) => m.id === cfg.currentModeId)) {
        this.info.currentModeId = cfg.currentModeId;
      }
    }
  }

  private applyFast(cfg: ExtractedConfig): void {
    if (this.creditOnly) { this.fastConfigId = undefined; this.info.fastAvailable = false; this.info.fastEnabled = false; return; }
    this.fastConfigId = cfg.fastConfigId;
    this.fastKind = cfg.fastKind;
    this.info.fastAvailable = !!cfg.fastConfigId;
    this.info.fastEnabled = !!cfg.fastEnabled;
  }

  /** AppuBot AI (the launch bonus): it pays for Sonnet and Haiku at the standard speed only, so nothing else is offered or set */
  private get creditOnly(): boolean { return this.spec.id === APPUBOT_AI_PROVIDER_ID; }
  private offeredModels(models: SessionModel[]): SessionModel[] {
    // one model under a name of the agent's own (`ProviderSpec.oneModel`): the only row, and the current one
    const one = this.spec.oneModel;
    if (one) { this.info.currentModelId = one.id; return [{ id: one.id, name: one.name }]; }
    return this.creditOnly ? models.filter((m) => creditModelAllowed(m.id)) : models;
  }

  /* ---------------- ACP Client implementation ---------------- */

  private makeClient(): Client {
    return {
      sessionUpdate: (params: SessionNotification) => this.onSessionUpdate(params),
      requestPermission: (params) => this.onRequestPermission(params),
      createElicitation: (params) => this.onElicitation(params),
      readTextFile: (params) => this.readTextFile(params),
      writeTextFile: (params) => this.writeTextFile(params),
      createTerminal: (params: CreateTerminalRequest): CreateTerminalResponse => this.terminals.create(params),
      terminalOutput: (params: TerminalOutputRequest): TerminalOutputResponse => this.terminals.output(params.terminalId),
      waitForTerminalExit: (params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> => this.terminals.waitForExit(params.terminalId),
      killTerminal: (params: KillTerminalRequest) => {
        this.terminals.kill(params.terminalId);
        return {};
      },
      releaseTerminal: (params: ReleaseTerminalRequest) => {
        this.terminals.release(params.terminalId);
        return {};
      },
      extNotification: (method: string, params: Record<string, unknown>) => {
        this.hooks.log('debug', `[${this.spec.id}] ext notification ${method}`, params);
      },
    };
  }

  private onSessionUpdate(params: SessionNotification): void {
    if (!this.info.id) this.info.id = params.sessionId;
    const update = params.update;
    const ops = this.assembler.handle(update, this.replaying);
    if (ops.length === 0 && !['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'].includes(update.sessionUpdate)) {
      this.hooks.log('debug', `[${this.spec.id}] ignored session/update ${update.sessionUpdate}`);
    }
    let stateChanged = false;
    for (const raw of ops) {
      // on AppuBot's approvals the agent's own modes are its business: the chat keeps showing the user's choice
      if (this.approvals && raw.op === 'modes') {
        this.setAgentModes(!this.nativeModes || this.agentModes.length === 0 ? raw.modes : undefined, raw.currentModeId);
        continue;
      }
      if (this.approvals && raw.op === 'mode_changed') {
        this.agentModeId = raw.modeId;
        continue;
      }
      if (this.creditOnly && raw.op === 'fast') continue;
      const op = raw.op === 'modes' ? { ...raw, modes: providerModes(this.spec.id, raw.modes) }
        : raw.op === 'models' ? { ...raw, models: this.offeredModels(raw.models) }
        : raw;
      switch (op.op) {
        case 'commands':
          this.info.commands = op.commands;
          stateChanged = true;
          break;
        case 'mode_changed':
          this.info.currentModeId = op.modeId;
          stateChanged = true;
          break;
        case 'models':
          this.info.models = op.models;
          if (op.currentModelId && !this.spec.oneModel) this.info.currentModelId = op.currentModelId;
          stateChanged = true;
          break;
        case 'efforts':
          this.info.efforts = op.efforts;
          this.info.currentEffortId = op.currentEffortId;
          stateChanged = true;
          break;
        case 'fast':
          this.info.fastAvailable = op.available;
          this.info.fastEnabled = op.enabled;
          stateChanged = true;
          break;
        case 'modes':
          if (!this.nativeModes || this.info.modes.length === 0) {
            this.info.modes = op.modes;
            if (op.currentModeId) this.info.currentModeId = op.currentModeId;
            stateChanged = true;
          }
          break;
        default:
          break;
      }
      this.emitOp(op);
    }
    if (update.sessionUpdate === 'config_option_update') {
      const cfg = extractConfig(update.configOptions);
      if (cfg.modelConfigId) this.modelConfigId = cfg.modelConfigId;
      if (cfg.modeConfigId) this.modeConfigId = cfg.modeConfigId;
      this.effortConfigId = cfg.effortConfigId;
      if (Array.isArray(update.configOptions) && !this.creditOnly) {
        this.fastConfigId = cfg.fastConfigId;
        this.fastKind = cfg.fastKind;
      }
    }
    if (stateChanged && this.info.state !== 'starting') this.emitState();
  }

  private async onRequestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };
    if (this.promptCancelled || this.closing || this.exited) return cancelled;

    // Surface/merge the tool call so the UI shows what is awaiting approval.
    for (const op of this.assembler.applyToolCallUpdate(params.toolCall)) this.emitOp(op);
    const part = this.assembler.getToolCall(params.toolCall.toolCallId);

    const ask: PermissionAsk = {
      sessionId: this.info.id || params.sessionId,
      toolCallId: params.toolCall.toolCallId,
      title: part?.title || params.toolCall.title || 'Permission requested',
      ...((): { bridgeTool?: string } => {
        const b = bridgeToolName(params.toolCall.title) ?? this.assembler.getBridgeTool(params.toolCall.toolCallId)
          ?? bridgeToolFromInput(part?.rawInput ?? params.toolCall.rawInput);
        return b ? { bridgeTool: b } : {};
      })(),
      ...(quirksFor(this.spec)?.isQuestion?.(params.toolCall.toolCallId) ? { question: true } : {}),
      kind: part?.kind ?? 'other',
      content: part?.content ?? [],
      ...(part?.rawInput !== undefined ? { rawInput: part.rawInput } : params.toolCall.rawInput != null ? { rawInput: params.toolCall.rawInput } : {}),
      options: params.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    };

    let cancelHook!: () => void;
    const cancelPromise = new Promise<null>((resolve) => {
      cancelHook = () => resolve(null);
    });
    this.pendingPermissionCancels.add(cancelHook);
    try {
      const choice = await Promise.race([Promise.resolve().then(() => this.hooks.requestPermission(ask)), cancelPromise]);
      if (choice == null || this.promptCancelled) return cancelled;
      if (!params.options.some((o) => o.optionId === choice)) {
        this.hooks.log('warn', `[${this.spec.id}] permission hook returned unknown optionId "${choice}"; treating as cancelled`);
        return cancelled;
      }
      return { outcome: { outcome: 'selected', optionId: choice } };
    } catch (err) {
      this.hooks.log('error', `requestPermission hook threw: ${errorMessage(err)}`);
      return cancelled;
    } finally {
      this.pendingPermissionCancels.delete(cancelHook);
    }
  }

  /**
   * A form the agent asks the user to fill in (`elicitation/create`, form mode): handed to the host, which shows it
   * and answers. Anything else (a URL to visit, a mode not known, no fields, nobody to ask) is answered `cancel`.
   */
  private async onElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const cancel: CreateElicitationResponse = { action: 'cancel' };
    const ask = this.hooks.requestInput;
    if (!ask || params.mode !== 'form' || this.promptCancelled || this.closing || this.exited) return cancel;
    const fields = elicitationFields((params as { requestedSchema?: unknown }).requestedSchema);
    if (!fields.length) return cancel;
    const scope = params as { sessionId?: string; toolCallId?: string | null };
    let cancelHook!: () => void;
    const cancelPromise = new Promise<null>((resolve) => { cancelHook = () => resolve(null); });
    this.pendingPermissionCancels.add(cancelHook);
    try {
      const answer = await Promise.race([
        Promise.resolve().then(() => ask({ sessionId: this.info.id || scope.sessionId || '', ...(scope.toolCallId ? { toolCallId: scope.toolCallId } : {}), message: params.message ?? '', fields })),
        cancelPromise,
      ]);
      if (!answer || this.promptCancelled) return cancel;
      return answer.action === 'accept' ? { action: 'accept', content: answer.content } : { action: answer.action };
    } catch (err) {
      this.hooks.log('error', `requestInput hook threw: ${errorMessage(err)}`);
      return cancel;
    } finally {
      this.pendingPermissionCancels.delete(cancelHook);
    }
  }

  private async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const text = await readFile(params.path, 'utf8');
    if (params.line == null && params.limit == null) return { content: text };
    const lines = text.split('\n');
    const start = Math.max(0, (params.line ?? 1) - 1);
    const end = params.limit != null ? start + Math.max(0, params.limit) : lines.length;
    return { content: lines.slice(start, end).join('\n') };
  }

  private async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    await mkdir(dirname(params.path), { recursive: true });
    await writeFile(params.path, params.content, 'utf8');
    return {};
  }

  /* ---------------- operations ---------------- */

  private ensureUsable(): void {
    if (this.info.state === 'closed') throw new AgentProcessError(`Session ${this.info.id} is closed`);
    if (this.info.state === 'error') throw new AgentProcessError(`Session ${this.info.id} is in error state: ${this.info.error ?? 'unknown error'}`);
    if (!this.conn) throw new AgentProcessError(`Session ${this.info.id} is not started`);
  }

  async prompt(blocks: PromptBlock[]): Promise<PromptResult> {
    if (this.info.state === 'prompting') throw new AgentBusyError(this.info.id);
    this.ensureUsable();
    this.info.state = 'prompting';
    this.promptCancelled = false;
    this.assembler.reset();
    this.emitState();
    const exited = this.exitPromise.then(({ code, signal }) => {
      throw new AgentProcessError(
        this.closing ? 'Session closed' : `${this.spec.name} exited unexpectedly (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`,
        code,
        signal,
      );
    });
    exited.catch(() => undefined);
    try {
      const res = await Promise.race([this.conn!.prompt({ sessionId: this.info.id, prompt: toAcpBlocks(blocks) }), exited]);
      const result: PromptResult = { stopReason: res.stopReason };
      if (res.usage) {
        result.usage = { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, totalTokens: res.usage.totalTokens };
      }
      return result;
    } catch (err) {
      if (rpcErrorCode(err) === AUTH_REQUIRED_CODE) {
        const methods = authMethodInfos(this.init?.authMethods);
        const msg = errorMessage(err) || 'Authentication required';
        this.events.onAuthRequired(methods, msg);
        throw new AgentAuthError(this.spec.id, methods, `${this.spec.name}: ${msg}`);
      }
      if (!(err instanceof AgentProcessError) && (this.conn?.signal.aborted || this.exited)) {
        // The connection closed (stdout EOF) - usually the process is exiting; report that instead.
        await Promise.race([this.exitPromise, new Promise((r) => setTimeout(r, 1500))]);
        if (this.exited && !this.closing) throw new AgentProcessError(this.info.error ?? `${this.spec.name} exited unexpectedly`);
        if (this.closing) throw new AgentProcessError('Session closed');
      }
      if (this.authUrl) throw this.loginNeeded(err);
      if (this.promptCancelled && !(err instanceof AgentProcessError)) {
        // Some agents reject the prompt instead of resolving with `cancelled`.
        this.hooks.log('debug', `[${this.spec.id}] prompt rejected after cancel: ${errorMessage(err)}`);
        return { stopReason: 'cancelled' };
      }
      throw err;
    } finally {
      if (this.info.state === 'prompting') {
        this.info.state = 'ready';
        this.emitState();
      }
    }
  }

  /** Handshake, one of the agent's own extension methods, then exit (`AgentRuntime.extMethod`). */
  async extMethod(method: string, params: Record<string, unknown>, timeoutMs = EXT_METHOD_TIMEOUT_MS): Promise<unknown> {
    try {
      await this.connect();
      return await this.guard(this.conn!.extMethod(method, params), timeoutMs, method);
    } finally {
      await this.close(false);
    }
  }

  /** See `AgentRuntime.steer`. */
  async steer(blocks: PromptBlock[]): Promise<boolean> {
    const steering = (this.init?._meta as { steering?: { supported?: unknown } } | undefined)?.steering;
    if (steering?.supported !== true || this.info.state !== 'prompting' || !this.conn || this.exited) return false;
    try {
      const res = (await this.conn.extMethod(STEER_METHOD, {
        sessionId: this.info.id,
        prompt: toAcpBlocks(blocks),
        // an idle agent hands the message back instead of starting a turn of its own nobody would wait for
        _meta: { steering: { idleBehavior: 'promptRequired' } },
      })) as { outcome?: string } | undefined;
      if (res?.outcome !== 'injected') return false;
      // what it says from here answers the new message: never more of the text before it
      this.assembler.cut();
      return true;
    } catch (err) {
      this.hooks.log('warn', `[${this.spec.id}] steering failed: ${errorMessage(err)}`);
      return false;
    }
  }

  async cancel(): Promise<void> {
    if (!this.conn || this.exited) return;
    if (this.info.state !== 'prompting') return;
    this.promptCancelled = true;
    for (const c of [...this.pendingPermissionCancels]) c();
    try {
      await this.conn.cancel({ sessionId: this.info.id });
    } catch (err) {
      this.hooks.log('warn', `[${this.spec.id}] cancel failed: ${errorMessage(err)}`);
    }
  }

  async setMode(modeId: string): Promise<SessionInfo> {
    this.ensureUsable();
    if (this.approvals) {
      if (!APPROVAL_MODES.some((m) => m.id === modeId)) throw new Error(`${this.spec.name} has no permission mode "${modeId}"`);
      this.info.currentModeId = modeId;
      await this.applyApproval();
    } else {
      await this.switchMode(modeId, this.info.modes);
      this.info.currentModeId = modeId;
    }
    this.emitState();
    return this.snapshot();
  }

  /** Put the agent on one of its own modes (`modes`: the ones it reported). */
  private async switchMode(modeId: string, modes: SessionMode[]): Promise<void> {
    if (this.nativeModes && modes.some((m) => m.id === modeId)) {
      await this.conn!.setSessionMode({ sessionId: this.info.id, modeId });
    } else if (this.modeConfigId) {
      const res = await this.conn!.setSessionConfigOption({ sessionId: this.info.id, configId: this.modeConfigId, value: modeId });
      this.applyConfigOptions(res.configOptions);
    } else if (this.nativeModes) {
      await this.conn!.setSessionMode({ sessionId: this.info.id, modeId });
    } else {
      throw new Error(`${this.spec.name} does not support session modes`);
    }
  }

  /** The agent's own mode for the user's choice (`agentModeFor`): its no-questions mode for Full access, and back. */
  private async applyApproval(): Promise<void> {
    const target = agentModeFor(this.info.currentModeId, this.agentModes, this.agentModeId, this.agentStartModeId);
    if (!target || target === this.agentModeId) return;
    await this.switchMode(target, this.agentModes);
    this.agentModeId = target;
  }

  async setModel(modelId: string): Promise<SessionInfo> {
    this.ensureUsable();
    if (this.spec.oneModel) {
      // its environment picks the model: nothing to set on the agent
      if (modelId !== this.spec.oneModel.id) throw new Error(`${this.spec.name} runs one model`);
      this.info.currentModelId = modelId;
      return this.snapshot();
    }
    if (this.creditOnly && !creditModelAllowed(modelId)) throw new Error(`AppuBot AI runs ${CREDIT_MODELS_TEXT} only`);
    if (!this.modelConfigId) throw new Error(`${this.spec.name} does not expose model selection`);
    const res = await this.conn!.setSessionConfigOption({ sessionId: this.info.id, configId: this.modelConfigId, value: modelId });
    this.applyConfigOptions(res?.configOptions);
    this.info.currentModelId = modelId;
    this.emitState();
    return this.snapshot();
  }

  /** Handshake only (what the agent offers, e.g. its logins), then exit. */
  async probe(): Promise<InitializeResponse> {
    try {
      return await this.connect();
    } finally {
      await this.close(false);
    }
  }

  /** Handshake, then the agent's own login (ACP `authenticate`: it signs in by itself, e.g. in the browser), then exit. */
  async login(methodId: string, timeoutMs: number): Promise<void> {
    this.signingIn = true;
    try {
      await this.connect();
      await this.guard(this.conn!.authenticate({ methodId }), timeoutMs, 'authenticate');
    } finally {
      await this.close(false);
    }
  }

  /** Handshake, then ACP `logout` when the agent offers it (false when it doesn't), then exit. */
  async logout(timeoutMs: number): Promise<boolean> {
    try {
      const init = await this.connect();
      if (!init.agentCapabilities?.auth?.logout) return false;
      await this.guard(this.conn!.logout({}), timeoutMs, 'logout');
      return true;
    } finally {
      await this.close(false);
    }
  }

  async setEffort(effortId: string): Promise<SessionInfo> {
    this.ensureUsable();
    if (!this.effortConfigId) throw new Error(`${this.spec.name} offers no reasoning effort for this model`);
    const res = await this.conn!.setSessionConfigOption({ sessionId: this.info.id, configId: this.effortConfigId, value: effortId });
    this.applyConfigOptions(res?.configOptions);
    this.info.currentEffortId = effortId;
    this.emitState();
    return this.snapshot();
  }

  async setFast(enabled: boolean): Promise<SessionInfo> {
    this.ensureUsable();
    if (this.creditOnly && enabled) throw new Error('AppuBot AI has no fast mode');
    if (!this.fastConfigId) throw new Error(`${this.spec.name} offers no fast mode for this model`);
    const res = await this.conn!.setSessionConfigOption(
      this.fastKind === 'boolean'
        ? { sessionId: this.info.id, configId: this.fastConfigId, type: 'boolean', value: enabled }
        : { sessionId: this.info.id, configId: this.fastConfigId, value: enabled ? 'on' : 'off' },
    );
    this.applyConfigOptions(res?.configOptions);
    if (this.info.fastAvailable) this.info.fastEnabled = enabled;
    this.emitState();
    return this.snapshot();
  }

  /** Kill the agent process tree (SIGTERM, then SIGKILL after 2s). */
  async close(emit = true): Promise<void> {
    if (this.info.state === 'closed') return;
    this.closing = true;
    this.promptCancelled = true;
    for (const c of [...this.pendingPermissionCancels]) c();
    this.terminals.releaseAll();
    const child = this.child;
    if (child && !this.exited) {
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
      this.killTree('SIGTERM');
      const timer = setTimeout(() => this.killTree('SIGKILL'), 2000);
      await Promise.race([this.exitPromise, new Promise((r) => setTimeout(r, 4000))]);
      clearTimeout(timer);
    }
    this.info.state = 'closed';
    if (emit) this.emitState();
  }

  private killTree(signal: NodeJS.Signals): void {
    if (this.exited) return;
    killTree(this.child, signal);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.resolveExit({ code, signal });
    this.terminals.releaseAll();
    for (const c of [...this.pendingPermissionCancels]) c();
    if (!this.closing && this.info.state !== 'closed') {
      this.info.state = 'error';
      this.info.error = `${this.spec.name} exited unexpectedly (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})${this.stderrSuffix()}`;
      this.hooks.log('error', `[${this.spec.id}] ${this.info.error}`, { sessionId: this.info.id });
      this.emitState();
    } else {
      // Ensure the process group is gone (adapters spawn their own CLI children).
      killGroup(this.child?.pid, 'SIGKILL');
    }
    this.events.onExit(this);
  }
}

/** An OAuth sign-in link in a line of an agent's output (https, with a `redirect_uri`), else undefined. */
export function authorizeLink(line: string): string | undefined {
  for (const m of line.matchAll(/https:\/\/[^\s'"<>]+/g)) {
    const url = m[0].replace(/[.,;)\]]+$/, '');
    try { if (new URL(url).searchParams.has('redirect_uri')) return url; } catch { /* not a link */ }
  }
  return undefined;
}
