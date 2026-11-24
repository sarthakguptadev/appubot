import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { APPUBOT_AI_PROVIDER_ID } from '@appubot/protocol';
import { AgentAuthError, AgentBusyError, createAgentRuntime, type AgentRuntime, type ElicitationAnswer, type ElicitationAsk, type McpServer, type PermissionAsk, type SessionInfo, type TurnOp } from './index';

const FAKE = resolve(fileURLToPath(new URL('.', import.meta.url)), '../test/fake-agent.mjs');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('runtime against fake ACP agent', () => {
  let dir: string;
  let runtime: AgentRuntime;
  let ops: { sessionId: string; op: TurnOp }[];
  let states: SessionInfo[];
  let asks: PermissionAsk[];
  let permissionAnswer: (ask: PermissionAsk) => Promise<string | null>;
  const logs: string[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'appubot-fake-'));
  });
  // retried: Windows may hold the folder of a process that just ended for a moment longer
  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  function makeRuntime(env: Record<string, string> = {}, secrets?: Record<string, string>): AgentRuntime {
    ops = [];
    states = [];
    asks = [];
    permissionAnswer = async () => 'allow';
    const rt = createAgentRuntime({
      hooks: {
        requestPermission: (ask) => {
          asks.push(ask);
          return permissionAnswer(ask);
        },
        onTurnOp: (sessionId, op) => ops.push({ sessionId, op }),
        onSessionState: (info) => states.push(info),
        log: (_level, msg) => logs.push(msg),
        ...(secrets ? { secretEnv: (id: string) => (id === 'fake' ? secrets : undefined) } : {}),
      },
    });
    rt.setProviders([{ id: 'fake', name: 'Fake', command: '$node', args: [FAKE], env }]);
    return rt;
  }

  afterEach(async () => {
    await runtime?.shutdown();
  });

  it('detects the fake provider and builtins', async () => {
    runtime = makeRuntime();
    const [fake] = await runtime.detectProviders(['fake']);
    expect(fake).toMatchObject({ id: 'fake', installed: true, authStatus: 'unknown', resolvedCommand: process.execPath });
    const all = runtime.getProviders();
    const claude = all.find((p) => p.id === 'claude-code');
    expect(claude?.builtin).toBe(true);
    expect(claude?.enabled).toBe(true);
    expect(all.find((p) => p.id === 'grok')?.enabled).toBe(false);
    expect(all.some((p) => p.id === 'gemini')).toBe(false);
    // a custom agent has no login check
    expect(fake?.auth).toBeUndefined();
  }, 30000);

  it('keeps AppuBot AI (the launch bonus) to Sonnet and Haiku, with no fast mode; the same agent elsewhere lists everything', async () => {
    runtime = makeRuntime();
    runtime.setProviders([
      { id: 'fake', name: 'Fake', command: '$node', args: [FAKE], env: { FAKE_CLAUDE: '1' } },
      // the user's own claude CLI the adapter drives, so the test needs no Claude Code installed
      { id: APPUBOT_AI_PROVIDER_ID, name: 'AppuBot AI', command: '$node', args: [FAKE], env: { FAKE_CLAUDE: '1', CLAUDE_CODE_EXECUTABLE: process.execPath } },
    ]);
    const plain = await runtime.createSession({ providerId: 'fake', cwd: dir });
    expect(plain.models.map((m) => m.id).sort()).toEqual(['claude-fable-5-1', 'claude-sonnet-4-6', 'default', 'haiku', 'opus', 'sonnet']);
    expect(plain.fastAvailable).toBe(true);
    const credit = await runtime.createSession({ providerId: APPUBOT_AI_PROVIDER_ID, cwd: dir, modelId: 'claude-fable-5-1', fast: true });
    expect(credit.models.map((m) => m.id).sort()).toEqual(['claude-sonnet-4-6', 'haiku', 'sonnet']);
    expect(credit.fastAvailable).toBe(false);
    expect(credit.fastEnabled).toBe(false);
    expect(credit.currentModelId).not.toBe('claude-fable-5-1');
    await expect(runtime.setModel(credit.id, 'opus')).rejects.toThrow(/Sonnet and Haiku only/);
    await expect(runtime.setFast(credit.id, true)).rejects.toThrow(/no fast mode/);
    expect((await runtime.setModel(credit.id, 'haiku')).currentModelId).toBe('haiku');
    expect(ops.some((o) => o.sessionId === credit.id && o.op.op === 'fast')).toBe(false);
  }, 30000);

  it('offers one model under the agent’s own name where the spec says so (the launch gift’s "Claude"), sets nothing on the agent, and takes no other', async () => {
    runtime = makeRuntime();
    runtime.setProviders([{ id: APPUBOT_AI_PROVIDER_ID, name: 'Claude', command: '$node', args: [FAKE], env: { FAKE_CLAUDE: '1', CLAUDE_CODE_EXECUTABLE: process.execPath }, oneModel: { id: 'claude-haiku-5-5', name: 'Claude' } }]);
    const gift = await runtime.createSession({ providerId: APPUBOT_AI_PROVIDER_ID, cwd: dir, modelId: 'claude-haiku-5-5' });
    expect(gift.models).toEqual([{ id: 'claude-haiku-5-5', name: 'Claude' }]);
    expect(gift.currentModelId).toBe('claude-haiku-5-5');
    expect(gift.fastAvailable).toBe(false);
    expect((await runtime.setModel(gift.id, 'claude-haiku-5-5')).currentModelId).toBe('claude-haiku-5-5');
    await expect(runtime.setModel(gift.id, 'sonnet')).rejects.toThrow(/runs one model/);
    expect(runtime.listSessions().find((x) => x.id === gift.id)!.models).toEqual([{ id: 'claude-haiku-5-5', name: 'Claude' }]);
  }, 30000);

  it('asks an agent one of its own extension methods in a process of its own, no session', async () => {
    runtime = makeRuntime();
    expect(await runtime.extMethod('fake', '_fake/billing', {})).toEqual({ config: { creditUsagePercent: 6 }, subscription_tier: 'Fake Plus' });
    expect(states).toEqual([]);
    expect(runtime.listSessions()).toEqual([]);
    await expect(runtime.extMethod('fake', '_fake/nothing', {})).rejects.toThrow(/not found/i);
    await expect(runtime.extMethod('nope', '_fake/billing', {})).rejects.toThrow();
  });

  it('says what a silent agent printed when a request times out, or that it printed nothing', async () => {
    runtime = makeRuntime({ FAKE_QUIET: '1' });
    await expect(runtime.extMethod('fake', '_fake/stuck', {}, { timeoutMs: 1500 })).rejects.toThrow(/^_fake\/stuck timed out after 2s\nconnect ETIMEDOUT 203\.0\.113\.7:443$/);
    await expect(runtime.extMethod('fake', '_fake/hang', {}, { timeoutMs: 1500 })).rejects.toThrow(/^_fake\/hang timed out after 2s \(Fake is running but printed no error\)$/);
  }, 30000);

  it('creates a session, streams a turn with permission, and closes the child', async () => {
    runtime = makeRuntime();
    const info = await runtime.createSession({ providerId: 'fake', cwd: dir });
    expect(info.id).toMatch(/^fake-/);
    expect(info.state).toBe('ready');
    // an agent without permission levels of its own is on AppuBot's two choices: none saved is Full access
    expect(info.modes.map((m) => m.id)).toEqual(['auto', 'bypassPermissions']);
    expect(info.currentModeId).toBe('bypassPermissions');
    expect(info.models).toEqual([{ id: 'fast', name: 'Fast model' }, { id: 'smart', name: 'Smart model', description: 'slower' }]);
    expect(info.currentModelId).toBe('fast');
    expect(info.pid).toBeTypeOf('number');

    await waitFor(() => runtime.getSession(info.id)!.commands.length > 0);
    expect(runtime.getSession(info.id)!.commands).toEqual([{ name: 'compact', description: 'Compact context' }]);

    const status = (await runtime.detectProviders(['fake']))[0]!;
    expect(status.authStatus).toBe('authenticated');
    expect(status.capabilities).toEqual({ loadSession: true, image: true, audio: false, embeddedContext: true });

    ops = [];
    const res = await runtime.prompt(info.id, [{ type: 'text', text: 'hello' }]);
    expect(res).toEqual({ stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });

    const turn = ops.filter((o) => o.sessionId === info.id).map((o) => o.op);
    expect(turn[0]).toEqual({ op: 'delta', partIndex: 0, partType: 'thought', delta: 'Thinking' });
    expect(turn[1]).toEqual({ op: 'delta', partIndex: 1, partType: 'text', delta: 'Hello' });
    expect(turn[2]).toEqual({ op: 'delta', partIndex: 1, partType: 'text', delta: ', world' });
    expect(turn[3]).toMatchObject({ op: 'part', partIndex: 2, part: { type: 'tool_call', toolCallId: 'call_1', status: 'pending', kind: 'edit' } });
    // permission request merged the diff content into the part
    expect(turn[4]).toMatchObject({ op: 'part', partIndex: 2, part: { content: [{ type: 'diff', newText: 'hello', oldText: null }] } });
    expect(turn[5]).toMatchObject({ op: 'part', partIndex: 2, part: { status: 'completed' } });
    expect(turn[6]).toEqual({ op: 'delta', partIndex: 3, partType: 'text', delta: 'Done.' });
    expect(turn[7]).toMatchObject({ op: 'part', partIndex: 4, part: { type: 'plan' } });

    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      sessionId: info.id,
      toolCallId: 'call_1',
      title: 'Write file',
      kind: 'edit',
      content: [{ type: 'diff', path: `${dir}/a.txt`, oldText: null, newText: 'hello' }],
      rawInput: { path: `${dir}/a.txt` },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });

    const stateSeq = states.filter((s) => s.id === info.id).map((s) => s.state);
    expect(stateSeq).toContain('prompting');
    expect(stateSeq.at(-1)).toBe('ready');

    // reject path
    permissionAnswer = async () => 'reject';
    ops = [];
    await runtime.prompt(info.id, [{ type: 'text', text: 'hello' }]);
    expect(ops.some((o) => o.op.op === 'delta' && o.op.delta === 'Rejected.')).toBe(true);

    const pid = info.pid!;
    expect(isAlive(pid)).toBe(true);
    await runtime.closeSession(info.id);
    expect(isAlive(pid)).toBe(false);
    expect(runtime.getSession(info.id)).toBeUndefined();
    expect(states.at(-1)).toMatchObject({ id: info.id, state: 'closed' });
  }, 30000);

  it('hands a form the agent itself asks for to the host, and without a host for it the agent dismisses its own question', async () => {
    // nobody to show a form: the client doesn't say it takes them, and the agent ends its turn `cancelled` by itself
    runtime = makeRuntime();
    const plain = await runtime.createSession({ providerId: 'fake', cwd: dir });
    expect(await runtime.prompt(plain.id, [{ type: 'text', text: 'form' }])).toMatchObject({ stopReason: 'cancelled' });
    await runtime.shutdown();

    const asked: ElicitationAsk[] = [];
    let answer: ElicitationAnswer = { action: 'accept', content: { q0: 'banana' } };
    const said: string[] = [];
    runtime = createAgentRuntime({
      hooks: {
        requestPermission: async () => 'allow',
        requestInput: async (ask) => { asked.push(ask); return answer; },
        onTurnOp: (_sid, op) => { if (op.op === 'delta') said.push(op.delta); },
        onSessionState: () => {},
        log: () => {},
      },
    });
    runtime.setProviders([{ id: 'fake', name: 'Fake', command: '$node', args: [FAKE], env: {} }]);
    const s = await runtime.createSession({ providerId: 'fake', cwd: dir });
    expect(await runtime.prompt(s.id, [{ type: 'text', text: 'form' }])).toMatchObject({ stopReason: 'end_turn' });
    expect(asked[0]).toMatchObject({ sessionId: s.id, toolCallId: 'q1', message: 'Questions' });
    expect(asked[0]!.fields).toEqual([
      { id: 'q0', title: 'Fruit', description: 'Which fruit do you like best?', required: false, kind: 'choice', options: [{ value: 'apple', title: 'Apple', description: 'Crisp' }, { value: 'banana', title: 'Banana' }] },
      { id: 'q0_custom', title: 'Fruit (other)', description: 'Type your own answer', required: false, kind: 'text', options: [] },
    ]);
    expect(JSON.parse(said.join(''))).toEqual({ action: 'accept', content: { q0: 'banana' } });

    // turned down: the agent hears so
    said.length = 0;
    answer = { action: 'decline' };
    await runtime.prompt(s.id, [{ type: 'text', text: 'form-two' }]);
    expect(asked[1]!.fields.map((f) => [f.id, f.kind])).toEqual([['q0', 'choice'], ['q0_custom', 'text'], ['q1', 'multichoice'], ['q2', 'number'], ['q3', 'toggle']]);
    expect(JSON.parse(said.join(''))).toEqual({ action: 'decline' });
  }, 30000);

  it('runs client terminals and fs methods', async () => {
    runtime = makeRuntime();
    const info = await runtime.createSession({ providerId: 'fake', cwd: dir });
    ops = [];
    const res = await runtime.prompt(info.id, [{ type: 'text', text: 'terminal' }]);
    expect(res.stopReason).toBe('end_turn');
    const termOps = ops.map((o) => o.op).filter((o) => o.op === 'terminal_output');
    expect(termOps.length).toBeGreaterThan(0);
    // Windows' echo ends the line with \r\n
    expect(termOps.map((o) => (o as { chunk: string }).chunk).join('')).toMatch(/^hi\r?\n$/);
    expect(ops.some((o) => o.op.op === 'delta' && o.op.delta === 'exit=0 out=hi')).toBe(true);
    const completed = ops.map((o) => o.op).find((o) => o.op === 'part' && o.part.type === 'tool_call' && o.part.status === 'completed');
    expect(completed).toMatchObject({ part: { content: [{ type: 'terminal', output: expect.stringMatching(/^hi\r?\n$/), exitCode: 0 }] } });

    ops = [];
    await runtime.prompt(info.id, [{ type: 'text', text: 'fs' }]);
    expect(readFileSync(join(dir, 'note.txt'), 'utf8')).toBe('line1\nline2\nline3');
    expect(ops.some((o) => o.op.op === 'delta' && o.op.delta === 'read:line2')).toBe(true);
  }, 30000);

  it('cancels an in-flight prompt and rejects concurrent prompts as busy', async () => {
    runtime = makeRuntime();
    const info = await runtime.createSession({ providerId: 'fake', cwd: dir });
    const p = runtime.prompt(info.id, [{ type: 'text', text: 'cancel-me' }]);
    await waitFor(() => ops.some((o) => o.op.op === 'delta' && o.op.delta === 'waiting...'));
    expect(runtime.getSession(info.id)!.state).toBe('prompting');
    await expect(runtime.prompt(info.id, [{ type: 'text', text: 'x' }])).rejects.toBeInstanceOf(AgentBusyError);
    await runtime.cancel(info.id);
    expect(await p).toEqual({ stopReason: 'cancelled' });
    expect(runtime.getSession(info.id)!.state).toBe('ready');

    // pending permission is answered `cancelled` on cancel
    permissionAnswer = () => new Promise(() => {}); // never resolves
    const p2 = runtime.prompt(info.id, [{ type: 'text', text: 'cancel-permission' }]);
    await waitFor(() => asks.length === 1);
    await runtime.cancel(info.id);
    expect((await p2).stopReason).toBe('cancelled');
  }, 30000);

  it('sets mode and model', async () => {
    runtime = makeRuntime();
    const info = await runtime.createSession({ providerId: 'fake', cwd: dir, modelId: 'smart', effortId: 'medium' });
    expect(info.currentModelId).toBe('smart');
    expect(info.efforts.map((e) => e.id)).toEqual(['low', 'medium', 'high']);
    expect(info.currentEffortId).toBe('medium');
    const after = await runtime.setMode(info.id, 'auto');
    expect(after.currentModeId).toBe('auto');
    await expect(runtime.setMode(info.id, 'plan')).rejects.toThrow();
    const e = await runtime.setEffort(info.id, 'low');
    expect(e.currentEffortId).toBe('low');
    const m = await runtime.setModel(info.id, 'fast');
    expect(m.currentModelId).toBe('fast');
    expect(m.efforts).toEqual([]);
    expect(m.currentEffortId).toBeUndefined();
  }, 30000);

  it("puts an agent on AppuBot's approvals on its own no-questions mode for Full access, and back for Approve for me", async () => {
    runtime = makeRuntime();
    const said = async (id: string) => {
      ops = [];
      await runtime.prompt(id, [{ type: 'text', text: 'which-mode' }]);
      return ops.filter((o) => o.op.op === 'delta').map((o) => (o.op as { delta: string }).delta).join('');
    };
    const full = await runtime.createSession({ providerId: 'fake', cwd: dir });
    expect(await said(full.id)).toBe('yolo');
    // its own mode changes never reach the chat: the user's choice stays what it shows
    expect(ops.some((o) => o.op.op === 'mode_changed' || o.op.op === 'modes')).toBe(false);
    await runtime.setMode(full.id, 'auto');
    expect(await said(full.id)).toBe('default');
    expect(runtime.getSession(full.id)!.currentModeId).toBe('auto');

    const asks = await runtime.createSession({ providerId: 'fake', cwd: dir, modeId: 'auto' });
    expect(asks.currentModeId).toBe('auto');
    expect(await said(asks.id)).toBe('default');
  }, 30000);

  const answer = async (rt: AgentRuntime, id: string, text: string) => {
    ops = [];
    await rt.prompt(id, [{ type: 'text', text }]);
    return ops.filter((o) => o.op.op === 'delta').map((o) => (o.op as { delta: string }).delta).join('');
  };

  it('starts the agent with the keys saved for it, kept out of its spec and status', async () => {
    runtime = makeRuntime({}, { FAKE_KEY: 'sekret' });
    const info = await runtime.createSession({ providerId: 'fake', cwd: dir });
    expect(await answer(runtime, info.id, 'env:FAKE_KEY')).toBe('sekret');
    expect(JSON.stringify(runtime.getProviders())).not.toContain('sekret');
    expect(JSON.stringify(await runtime.detectProviders(['fake']))).not.toContain('sekret');
  }, 30000);

  it('tells key logins from browser and terminal ones', async () => {
    runtime = makeRuntime({
      FAKE_AUTH_METHODS: JSON.stringify([
        { id: 'oauth', name: 'Google' },
        { id: 'gemini-api-key', name: 'Gemini API key' },
        { id: 'key', name: 'API key', type: 'env_var', vars: [{ name: 'MY_KEY', label: 'Key' }, { name: 'bad name' }], link: 'https://example.com/keys' },
        { id: 'old', name: 'Old key', type: 'env_var', varName: 'OLD_KEY' },
        { id: 'tui', name: 'Terminal', type: 'terminal', args: ['login'] },
      ]),
    });
    const st = await runtime.probe('fake');
    expect(st.authMethods).toEqual([
      { id: 'oauth', name: 'Google', kind: 'agent' },
      { id: 'gemini-api-key', name: 'Gemini API key', kind: 'agent', vars: [{ name: 'GEMINI_API_KEY', label: 'Gemini API key', secret: true, optional: false }], link: 'https://aistudio.google.com/apikey' },
      { id: 'key', name: 'API key', kind: 'env_var', vars: [{ name: 'MY_KEY', label: 'Key', secret: true, optional: false }], link: 'https://example.com/keys' },
      { id: 'old', name: 'Old key', kind: 'env_var', vars: [{ name: 'OLD_KEY', secret: true, optional: false }] },
      { id: 'tui', name: 'Terminal', kind: 'terminal' },
    ]);
  }, 30000);

  it('signs an agent out through ACP when it offers that, and remembers it can after a re-check', async () => {
    runtime = makeRuntime({ FAKE_LOGOUT: '1' });
    expect((await runtime.probe('fake')).canLogOut).toBe(true);
    expect((await runtime.detectProviders(['fake']))[0]!.canLogOut).toBe(true);
    expect(await runtime.logout('fake')).toEqual({ ok: true });
    expect((await runtime.detectProviders(['fake']))[0]!.authStatus).toBe('needs_auth');

    const plain = makeRuntime();
    expect((await plain.probe('fake')).canLogOut).toBe(false);
    expect((await plain.logout('fake')).ok).toBe(false);
    await plain.shutdown();
  }, 30000);

  it('resumes a session through session/resume when the agent can resume but not load', async () => {
    runtime = makeRuntime({ FAKE_RESUME_ONLY: '1' });
    const info = await runtime.createSession({ providerId: 'fake', cwd: dir, resumeSessionId: 'old-session' });
    expect(info.id).toBe('old-session');
    expect(await answer(runtime, info.id, 'env:NOPE')).toBe('(unset) resumed');
  }, 30000);

  it('leaves an effort the model lacks to the agent', async () => {
    runtime = makeRuntime();
    const info = await runtime.createSession({ providerId: 'fake', cwd: dir, effortId: 'medium' });
    expect(info.currentModelId).toBe('fast');
    expect(info.efforts).toEqual([]);
    expect(info.currentEffortId).toBeUndefined();
  }, 30000);

  it('replays history on resume', async () => {
    runtime = makeRuntime();
    const info = await runtime.createSession({ providerId: 'fake', cwd: dir, resumeSessionId: 'old-session' });
    expect(info.id).toBe('old-session');
    const replay = ops.filter((o) => o.sessionId === 'old-session').map((o) => o.op);
    expect(replay).toEqual([
      { op: 'user_echo', part: { type: 'text', text: 'old question' } },
      { op: 'delta', partIndex: 0, partType: 'text', delta: 'old answer' },
    ]);
  }, 30000);

  it('marks the session as error when the agent crashes', async () => {
    runtime = makeRuntime();
    const info = await runtime.createSession({ providerId: 'fake', cwd: dir });
    await expect(runtime.prompt(info.id, [{ type: 'text', text: 'crash' }])).rejects.toThrow(/exited unexpectedly/);
    const s = runtime.getSession(info.id)!;
    expect(s.state).toBe('error');
    expect(s.error).toMatch(/code 3/);
    expect(states.at(-1)).toMatchObject({ id: info.id, state: 'error' });
  }, 30000);

  it('throws AgentAuthError and flags needs_auth when the agent requires auth', async () => {
    runtime = makeRuntime({ FAKE_AUTH_REQUIRED: '1' });
    const err = await runtime.createSession({ providerId: 'fake', cwd: dir }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentAuthError);
    expect((err as AgentAuthError).authMethods).toEqual([{ id: 'fake-login', name: 'Fake login', kind: 'agent' }]);
    const [status] = await runtime.detectProviders(['fake']);
    expect(status!.authStatus).toBe('needs_auth');
    expect(runtime.listSessions()).toEqual([]);
  }, 30000);

  it('probes an agent for its logins and signs it in through ACP authenticate, with no session', async () => {
    runtime = makeRuntime({ FAKE_AUTH_REQUIRED: '1' });
    const status = await runtime.probe('fake');
    expect(status.installed).toBe(true);
    expect(status.authMethods).toEqual([{ id: 'fake-login', name: 'Fake login', kind: 'agent' }]);
    expect(status.capabilities.loadSession).toBe(true);
    await expect(runtime.login('fake', 'nope')).rejects.toThrow();
    await runtime.login('fake', 'fake-login');
    expect((await runtime.detectProviders(['fake']))[0]).toMatchObject({ authStatus: 'authenticated' });
    expect(runtime.listSessions()).toEqual([]);
    expect(states).toEqual([]);
  }, 30000);

  it('catches a sign-in link an agent prints, for a sign-in made for another device', async () => {
    const link = 'https://accounts.example.test/auth?response_type=code&state=s1&redirect_uri=http%3A%2F%2F127.0.0.1%3A6123%2Foauth2callback';
    runtime = makeRuntime({ FAKE_PRINT_LOGIN: link });
    const caught: string[] = [];
    await runtime.login('fake', 'oauth-personal', undefined, undefined, (url) => caught.push(url));
    expect(caught).toEqual([link]);
  }, 30000);

  it('hands HTTP MCP servers only to agents that support them', async () => {
    const servers: McpServer[] = [
      { name: 'appubot', command: 'node', args: ['bridge.mjs'], env: { A: '1' } },
      { type: 'http', name: 'composio', url: 'https://mcp.example/s/1', headers: { 'x-api-key': 'k' } },
    ];
    const echoed = async (rt: AgentRuntime): Promise<unknown> => {
      const info = await rt.createSession({ providerId: 'fake', cwd: dir, mcpServers: servers });
      ops = [];
      await rt.prompt(info.id, [{ type: 'text', text: 'mcp' }]);
      const text = ops.map((o) => o.op).filter((o) => o.op === 'delta').map((o) => (o as { delta: string }).delta).join('');
      return JSON.parse(text);
    };

    runtime = makeRuntime({ FAKE_MCP_HTTP: '1' });
    expect(await echoed(runtime)).toEqual([
      { name: 'appubot', command: 'node', args: ['bridge.mjs'], env: [{ name: 'A', value: '1' }] },
      { type: 'http', name: 'composio', url: 'https://mcp.example/s/1', headers: [{ name: 'x-api-key', value: 'k' }] },
    ]);
    await runtime.shutdown();

    logs.length = 0;
    runtime = makeRuntime();
    expect(await echoed(runtime)).toEqual([{ name: 'appubot', command: 'node', args: ['bridge.mjs'], env: [{ name: 'A', value: '1' }] }]);
    expect(logs.some((l) => l.includes('skipping "composio"'))).toBe(true);
  }, 30000);

  it('authCommand returns the claude adapter login command', async () => {
    runtime = makeRuntime();
    const cmd = await runtime.authCommand('claude-code', 'claude-ai-login');
    expect(cmd).not.toBeNull();
    expect(cmd!.args.slice(-4)).toEqual(['--cli', 'auth', 'login', '--claudeai']);
  });
});

describe.skipIf(process.platform === 'win32')('Google Antigravity (quirks.ts) against the fake agent', () => {
  const SIGN_IN = 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2F';
  let dir: string;
  let rt: AgentRuntime | undefined;
  let opened: string[];
  let asked: PermissionAsk[];

  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'appubot-agy-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  afterEach(async () => { await rt?.shutdown(); rt = undefined; });

  function agy(env: Record<string, string> = {}, answer = '1'): AgentRuntime {
    opened = [];
    asked = [];
    const out = createAgentRuntime({
      dataDir: join(dir, 'data'),
      hooks: {
        requestPermission: async (ask) => { asked.push(ask); return answer; },
        onTurnOp: (sessionId, op) => { if (op.op === 'delta') said.push(op.delta); },
        onSessionState: () => {},
        log: () => {},
        openAuthUrl: (_id, url) => opened.push(url),
      },
    });
    out.setProviders([{ id: 'antigravity-acp', name: 'Google Antigravity', command: '$node', args: [FAKE], env, registry: { id: 'antigravity-acp', version: '1.4.1' } }]);
    rt = out;
    return out;
  }
  let said: string[] = [];
  const reply = async (r: AgentRuntime, id: string, text: string) => {
    said = [];
    await r.prompt(id, [{ type: 'text', text }]);
    return said.join('');
  };

  it('starts it with a home, settings and temp folder of its own and its login in a file', async () => {
    const r = agy();
    const s = await r.createSession({ providerId: 'antigravity-acp', cwd: dir });
    expect(await reply(r, s.id, 'env:GEMINI_HOME')).toBe(join(dir, 'data', 'agent-homes', 'antigravity-acp'));
    expect(await reply(r, s.id, 'env:AGY_ACP_FORCE_FILE_STORAGE')).toBe('1');
    expect(await reply(r, s.id, 'env:TMPDIR')).toBe(join(dir, 'data', 'agent-tmp', 'antigravity-acp'));
    expect(await reply(r, s.id, 'env:BROWSER')).toContain('__APPUBOT_AUTH_URL__');
  }, 30000);

  it('opens the sign-in page it catches while the user signs in, and makes that login the one it uses', async () => {
    const r = agy({ FAKE_BROWSER_LOGIN: '1' });
    await r.login('antigravity-acp', 'oauth-personal');
    expect(opened).toEqual([SIGN_IN]);
    const settings = JSON.parse(readFileSync(join(dir, 'data', 'agent-homes', 'antigravity-acp', 'antigravity-acp', 'settings.json'), 'utf8'));
    expect(settings).toEqual({ auth: { type: 'oauth-personal' } });
  }, 30000);

  it('hands a sign-in made for another device its page, caught or printed, and opens nothing here', async () => {
    const r = agy({ FAKE_BROWSER_LOGIN: '1' });
    const caught: string[] = [];
    await r.login('antigravity-acp', 'oauth-personal', undefined, undefined, (url) => caught.push(url));
    expect(caught).toEqual([SIGN_IN]);
    expect(opened).toEqual([]);
  }, 30000);

  it('ends a session that wants a login instead of opening its page behind the user’s back', async () => {
    const r = agy({ FAKE_NEEDS_LOGIN: '1' });
    const t0 = Date.now();
    const err = await r.createSession({ providerId: 'antigravity-acp', cwd: dir }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentAuthError);
    expect((err as Error).message).toMatch(/sign in again/);
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(opened).toEqual([]);
    expect((await r.detectProviders(['antigravity-acp']))[0]!.authStatus).toBe('needs_auth');
  }, 30000);

  it('marks its multiple-choice questions as questions', async () => {
    const r = agy({}, '2');
    const s = await r.createSession({ providerId: 'antigravity-acp', cwd: dir });
    expect(await reply(r, s.id, 'question')).toBe('2');
    expect(asked[0]).toMatchObject({ question: true, title: 'Which one?' });
  }, 30000);
});
