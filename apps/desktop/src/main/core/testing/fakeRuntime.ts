/** In-memory AgentRuntime used by tests: streams a scripted turn incl. a permission request. */
import { APPROVAL_MODES, mergeBuiltin, profileSpec } from '@appubot/agent-runtime';
import { hasPermissionModes } from '@appubot/protocol';
import type { AgentRuntime, CreateSessionOptions, PromptBlock, PromptResult, ProviderSpec, ProviderStatus, RuntimeHooks, SessionInfo } from '@appubot/agent-runtime';

export const FAKE_PROVIDERS: ProviderSpec[] = [
  { id: 'claude-code', name: 'Claude Code (fake)', command: 'fake-claude', args: [], env: {}, builtin: true, enabled: true },
  { id: 'codex', name: 'Codex (fake)', command: 'fake-codex', args: [], env: {}, builtin: true, enabled: true },
];

/** session ids are unique across runtimes: a new core's runtime can't resume another one's sessions */
let sessionSeq = 0;

export class FakeRuntime implements AgentRuntime {
  sessions = new Map<string, SessionInfo>();
  /** sessions the agent kept on disk (ACP session/load can bring them back after closeSession) */
  saved = new Set<string>();
  created: CreateSessionOptions[] = [];
  prompts: { sessionId: string; blocks: PromptBlock[] }[] = [];
  private cancels = new Map<string, () => void>();
  /** a "slow" turn's own end: a steered message answered ends it */
  private ends = new Map<string, () => void>();
  /** the agent takes messages into its running turn (Claude Code's ACP steering) */
  steering = false;
  steered: { sessionId: string; blocks: PromptBlock[] }[] = [];
  /** holds createSession until it resolves (a session that takes a while to start) */
  gate: Promise<void> | null = null;
  /** a model a starting session reports while it loads (an old setting replayed by session/load) */
  replayModel: string | null = null;
  /** setModel fails (an agent that exited, or refuses the switch) */
  failSet = false;
  /** the model offers fast mode (Claude Code's `fast` option) */
  fastOffered = true;
  /** the kind of tool the scripted turn asks permission for */
  askKind: 'execute' | 'read' | 'edit' | 'question' = 'execute';
  /** what the last permission request was answered with */
  lastChoice: string | null | undefined;
  /** a scripted reply: when it returns text for a prompt, the agent answers just that (no tool, no permission) */
  reply: ((text: string, sessionId: string) => string | undefined | Promise<string | undefined>) | null = null;
  /** how a scripted reply's turn ends (`cancelled`: an agent that ends its own turn so, as OpenCode does when a question of its own goes unanswered) */
  replyEnds: PromptResult['stopReason'] = 'end_turn';
  private custom: ProviderSpec[] = [];

  constructor(public hooks: RuntimeHooks) {}

  /** like the real runtime: a profile runs its agent (a built-in or an added one) with its folder in the env (one without its agent is dropped) */
  setProviders(specs: ProviderSpec[]): void {
    const plain = specs.filter((s) => !s.profile).map((s) => {
      const builtin = FAKE_PROVIDERS.find((p) => p.id === s.id);
      return builtin ? mergeBuiltin(builtin, s) : s;
    });
    const agents = [...FAKE_PROVIDERS.filter((p) => !plain.some((x) => x.id === p.id)), ...plain];
    this.custom = [...plain, ...specs.flatMap((s) => {
      const of = s.profile && agents.find((p) => p.id === s.profile!.of);
      return s.profile && of ? [profileSpec(of, { ...s, profile: s.profile })] : [];
    })];
  }
  getProviders(): ProviderSpec[] {
    const ids = new Set(this.custom.map((c) => c.id));
    return [...FAKE_PROVIDERS.filter((p) => !ids.has(p.id)), ...this.custom];
  }
  /** what each CLI's login check reports (the built-in fakes start logged in) */
  logins = new Map<string, 'logged_in' | 'logged_out' | 'unknown'>(FAKE_PROVIDERS.map((p) => [p.id, 'logged_in']));
  logouts: string[] = [];
  detections = 0;
  /** what the handshake knows of an agent's sign-in, for agents without a login check (set: overrides the fakes' `authenticated`) */
  authStatuses = new Map<string, ProviderStatus['authStatus']>();
  /** agents whose CLI isn't on this fake computer (an AppuBot Cloud computer before `providers.install`) */
  notInstalled = new Set<string>();
  /** what a probe says about session/load (a real probe can't tell before a session ran) */
  loadSessionCap = true;
  /** the version each agent reports ('0.0.0' unless set) */
  versions = new Map<string, string>();
  async detectProviders(ids?: string[]): Promise<ProviderStatus[]> {
    this.detections++;
    return this.getProviders().filter((p) => !ids || ids.includes(p.id)).map((p) => {
      const state = this.logins.get(p.id);
      if (this.notInstalled.has(p.id)) {
        return { ...p, installed: false, authStatus: 'not_installed' as const, authMethods: [], capabilities: { loadSession: false, image: false, audio: false, embeddedContext: false } };
      }
      return {
        ...p, installed: true, authStatus: this.authStatuses.get(p.id) ?? (state === 'logged_out' ? 'needs_auth' : 'authenticated'), authMethods: [],
        capabilities: { loadSession: this.loadSessionCap, image: true, audio: false, embeddedContext: true }, version: this.versions.get(p.id) ?? '0.0.0',
        ...(state ? { auth: { state, ...(state === 'logged_in' ? { account: 'f***@example.com' } : {}), checkedAt: Date.now() }, canLogOut: true } : {}),
      };
    });
  }

  async createSession(opts: CreateSessionOptions): Promise<SessionInfo> {
    this.created.push(opts);
    // like the real runtime: a session still running is picked up as it is (its own model and all), a failed one is loaded again
    const live = opts.resumeSessionId ? this.sessions.get(opts.resumeSessionId) : undefined;
    if (live && live.state !== 'closed' && live.state !== 'error') return live;
    const resumed = opts.resumeSessionId && this.saved.has(opts.resumeSessionId) ? opts.resumeSessionId : undefined;
    const id = resumed ?? `fs_${++sessionSeq}`;
    this.saved.add(id);
    // ops emitted before createSession resolves (the core must buffer them)
    this.hooks.onTurnOp(id, { op: 'commands', commands: [{ name: 'compact', description: 'Compact the conversation' }] });
    if (this.replayModel) this.hooks.onTurnOp(id, { op: 'models', models: [{ id: 'm1', name: 'Model 1' }], currentModelId: this.replayModel });
    if (this.gate) await this.gate;
    const info: SessionInfo = {
      id, providerId: opts.providerId, cwd: opts.cwd, state: 'ready',
      // like the real runtime: an agent without permission levels of its own is on AppuBot's two choices
      ...(hasPermissionModes(opts.providerId)
        ? { modes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }], currentModeId: 'default' }
        : { modes: APPROVAL_MODES.map((m) => ({ ...m })), currentModeId: opts.modeId === 'auto' ? 'auto' : 'bypassPermissions' }),
      models: [{ id: 'm1', name: 'Model 1' }], currentModelId: opts.modelId ?? 'm1', commands: [],
      efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }],
      currentEffortId: opts.effortId ?? 'high',
      fastAvailable: this.fastOffered, fastEnabled: this.fastOffered && !!opts.fast,
    };
    this.sessions.set(id, info);
    return info;
  }
  getSession(id: string): SessionInfo | undefined { return this.sessions.get(id); }
  listSessions(): SessionInfo[] { return [...this.sessions.values()]; }

  async prompt(sessionId: string, blocks: PromptBlock[]): Promise<PromptResult> {
    this.prompts.push({ sessionId, blocks });
    const text = blocks.filter((b): b is Extract<PromptBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n');
    const op = this.hooks.onTurnOp.bind(this.hooks, sessionId);
    if (text.includes('slow')) {
      op({ op: 'delta', partIndex: 0, partType: 'thought', delta: 'Thinking slowly…' });
      return new Promise<PromptResult>((resolve) => {
        this.cancels.set(sessionId, () => resolve({ stopReason: 'cancelled' }));
        this.ends.set(sessionId, () => resolve({ stopReason: 'end_turn' }));
      });
    }
    if (text.includes('fail')) throw new Error('Agent crashed (fake)');
    const scripted = this.reply ? await this.reply(text, sessionId) : undefined;
    if (scripted !== undefined) {
      op({ op: 'title', title: 'Fake title' });
      op({ op: 'delta', partIndex: 0, partType: 'text', delta: scripted });
      return { stopReason: this.replyEnds };
    }
    op({ op: 'delta', partIndex: 0, partType: 'text', delta: 'Hello ' });
    op({ op: 'delta', partIndex: 0, partType: 'text', delta: 'world' });
    op({ op: 'title', title: 'Fake title' });
    const tool = { type: 'tool_call' as const, toolCallId: 't1', title: 'Run ls', kind: 'execute' as const, status: 'pending' as const, content: [{ type: 'terminal' as const, terminalId: 'term1' }], locations: [] };
    op({ op: 'part', partIndex: 1, part: tool });
    const choice = await this.hooks.requestPermission(this.askKind === 'question'
      // Antigravity's way of asking: a permission request whose options are the answers
      ? { sessionId, toolCallId: 'interaction_1', title: 'Which colour?', kind: 'other', content: [], question: true, options: [{ optionId: '1', name: 'Red', kind: 'allow_once' }, { optionId: '2', name: 'Blue', kind: 'allow_once' }] }
      : {
          sessionId, toolCallId: 't1', title: 'Run ls', kind: this.askKind, content: [], rawInput: { command: 'ls' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
        });
    this.lastChoice = choice;
    if (choice === 'allow') {
      op({ op: 'terminal_output', terminalId: 'term1', chunk: 'file1\nfile2\n' });
      op({ op: 'part', partIndex: 1, part: { ...tool, status: 'completed' } });
    } else {
      op({ op: 'part', partIndex: 1, part: { ...tool, status: 'failed' } });
    }
    op({ op: 'delta', partIndex: 2, partType: 'text', delta: 'Done.' });
    return { stopReason: 'end_turn' };
  }

  /** what the agents' own extension methods answer (`_x.ai/billing`…), by `<providerId> <method>`; the rest are refused */
  extAnswers = new Map<string, unknown>();
  extCalls: { providerId: string; method: string; params: Record<string, unknown> }[] = [];
  async extMethod(providerId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.getProviders().some((p) => p.id === providerId)) throw new Error(`Unknown provider ${providerId}`);
    this.extCalls.push({ providerId, method, params });
    const key = `${providerId} ${method}`;
    if (!this.extAnswers.has(key)) throw new Error(`Method not found: ${method}`);
    const answer = this.extAnswers.get(key);
    if (answer instanceof Error) throw answer;
    return answer;
  }

  /** Like Claude Code's adapter: a running "slow" turn takes the message, answers it in a new part, then ends. */
  async steer(sessionId: string, blocks: PromptBlock[]): Promise<boolean> {
    const end = this.ends.get(sessionId);
    if (!this.steering || !end) return false;
    this.steered.push({ sessionId, blocks });
    const text = blocks.filter((b): b is Extract<PromptBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n');
    setTimeout(() => {
      this.ends.delete(sessionId);
      this.cancels.delete(sessionId);
      this.hooks.onTurnOp(sessionId, { op: 'delta', partIndex: 1, partType: 'text', delta: `On it: ${text}` });
      end();
    }, 5);
    return true;
  }

  async cancel(sessionId: string): Promise<void> {
    const c = this.cancels.get(sessionId);
    this.cancels.delete(sessionId);
    c?.();
  }
  async setMode(sessionId: string, modeId: string): Promise<SessionInfo> {
    const s = this.sessions.get(sessionId)!;
    s.currentModeId = modeId;
    return s;
  }
  async setModel(sessionId: string, modelId: string): Promise<SessionInfo> {
    if (this.failSet) throw new Error('session closed (fake)');
    const s = this.sessions.get(sessionId)!;
    s.currentModelId = modelId;
    return s;
  }
  async setEffort(sessionId: string, effortId: string): Promise<SessionInfo> {
    const s = this.sessions.get(sessionId)!;
    s.currentEffortId = effortId;
    return s;
  }
  async setFast(sessionId: string, enabled: boolean): Promise<SessionInfo> {
    const s = this.sessions.get(sessionId)!;
    if (!s.fastAvailable) throw new Error('no fast mode for this model (fake)');
    s.fastEnabled = enabled;
    return s;
  }
  async closeSession(sessionId: string): Promise<void> { this.sessions.delete(sessionId); }
  /** handshakes (`probe`) and agent sign-ins (`login`) asked for, by provider id */
  probes: string[] = [];
  agentLogins: { id: string; methodId: string }[] = [];
  /** what a probe of an added agent reports for its logins */
  probeAuthMethods: ProviderStatus['authMethods'] = [{ id: 'oauth', name: 'Sign in', kind: 'agent' }];
  async probe(id: string): Promise<ProviderStatus> {
    this.probes.push(id);
    const [st] = await this.detectProviders([id]);
    return { ...st!, authMethods: this.probeAuthMethods };
  }
  async login(id: string, methodId: string): Promise<void> {
    this.agentLogins.push({ id, methodId });
    this.logins.set(id, 'logged_in');
  }
  async authCommand(_id?: string, _m?: string, login?: { loginHome?: string }): Promise<{ command: string; args: string[]; env: Record<string, string> }> { return { command: '/usr/bin/true', args: ['login'], env: login?.loginHome ? { HOME: login.loginHome } : {} }; }
  /** a scope's own login check: what a test set with `scopedLogins` (keyed by login home), else nothing */
  scopedLogins = new Map<string, { state: 'logged_in' | 'logged_out' | 'unknown'; account?: string }>();
  async loginState(_id: string, login: { loginHome?: string }): Promise<{ state: 'logged_in' | 'logged_out' | 'unknown'; account?: string; checkedAt: number } | undefined> { const l = login.loginHome ? this.scopedLogins.get(login.loginHome) : undefined; return l ? { ...l, checkedAt: Date.now() } : undefined; }
  async logout(id: string): Promise<{ ok: boolean; message?: string }> {
    this.logouts.push(id);
    this.logins.set(id, 'logged_out');
    return { ok: true };
  }
  async shutdown(): Promise<void> { this.sessions.clear(); }
}
