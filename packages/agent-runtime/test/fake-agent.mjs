#!/usr/bin/env node
// Minimal ACP agent over stdio for tests. Uses the SDK's AgentSideConnection.
import { AgentSideConnection, PROTOCOL_VERSION, RequestError, ndJsonStream } from '@agentclientprotocol/sdk';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

const SIGN_IN = 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2F';

/** Open a page the way Python's webbrowser does with $BROWSER: its command with the URL for %s (POSIX tests only). */
function openBrowser(url) {
  const cmd = process.env.BROWSER;
  if (!cmd) return;
  spawn('/bin/sh', ['-c', cmd.replace('%s', `'${url}'`)], { stdio: ['ignore', 'inherit', 'inherit'] });
}

const MODELS = process.env.FAKE_CLAUDE
  // Claude Code's own rows and two of the catalog's, with its fast mode (for AppuBot AI's narrowing)
  ? [{ value: 'default', name: 'Default' }, { value: 'opus', name: 'Opus 5.5' }, { value: 'sonnet', name: 'Sonnet 5.5' }, { value: 'haiku', name: 'Haiku 5.5' }, { value: 'claude-fable-5-1', name: 'Fable 5.1' }, { value: 'claude-sonnet-4-6', name: 'Sonnet 4.6' }]
  : [
    { value: 'fast', name: 'Fast model' },
    { value: 'smart', name: 'Smart model', description: 'slower' },
  ];
const FAST = { id: 'fast', name: 'Fast mode', category: 'model_config', type: 'select', currentValue: 'off', options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] };

const EFFORTS = [
  { value: 'low', name: 'Low' },
  { value: 'medium', name: 'Medium' },
  { value: 'high', name: 'High' },
];

/** Only the smart model has a reasoning effort. */
function configOptions(currentModel, effort = 'high') {
  const model = { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: currentModel, options: MODELS };
  if (process.env.FAKE_CLAUDE) return [model, FAST];
  if (currentModel !== 'smart') return [model];
  return [model, { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: effort, options: EFFORTS }];
}

class FakeAgent {
  constructor(conn) {
    this.conn = conn;
    this.sessions = new Map();
    this.nextId = 1;
  }

  async initialize(params) {
    this.clientCaps = params?.clientCapabilities ?? {};
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: !process.env.FAKE_RESUME_ONLY,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: !!process.env.FAKE_MCP_HTTP, sse: false },
        ...(process.env.FAKE_RESUME_ONLY ? { sessionCapabilities: { resume: {} } } : {}),
        ...(process.env.FAKE_LOGOUT ? { auth: { logout: {} } } : {}),
      },
      authMethods: process.env.FAKE_AUTH_METHODS ? JSON.parse(process.env.FAKE_AUTH_METHODS) : process.env.FAKE_AUTH_REQUIRED ? [{ id: 'fake-login', name: 'Fake login' }] : [],
      agentInfo: { name: 'fake-agent', version: '0.0.1' },
    };
  }

  /** an extension method of the agent's own (like Grok's `_x.ai/billing`): one answered, the rest refused */
  async extMethod(method, _params) {
    if (method === '_fake/billing') return { config: { creditUsagePercent: 6 }, subscription_tier: 'Fake Plus' };
    // never answers: silently, or after saying why on stderr
    if (method === '_fake/hang') return new Promise(() => {});
    if (method === '_fake/stuck') {
      process.stderr.write('connect ETIMEDOUT 203.0.113.7:443\n');
      return new Promise(() => {});
    }
    throw RequestError.methodNotFound(method);
  }

  async newSession(params) {
    if (process.env.FAKE_AUTH_REQUIRED) throw RequestError.authRequired();
    // a login gone stale: the agent starts its browser sign-in and waits for it
    if (process.env.FAKE_NEEDS_LOGIN) {
      openBrowser(SIGN_IN);
      process.stdout.write(`Open the following link to authenticate the ACP server: ${SIGN_IN}\n`);
      return new Promise(() => {});
    }
    const sessionId = `fake-${this.nextId++}`;
    this.sessions.set(sessionId, { cwd: params.cwd, cancel: null, model: 'fast', mode: 'default', mcpServers: params.mcpServers });
    setTimeout(() => {
      void this.update(sessionId, {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'compact', description: 'Compact context' }],
      });
    }, 10);
    return {
      sessionId,
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan', description: 'Plan only' },
          { id: 'yolo', name: 'YOLO', description: 'Approve everything' },
        ],
      },
      configOptions: configOptions('fast'),
    };
  }

  async loadSession(params) {
    this.sessions.set(params.sessionId, { cwd: params.cwd, cancel: null, model: 'fast', mode: 'default' });
    await this.update(params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } });
    await this.update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' } });
    return { modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] }, configOptions: configOptions('fast') };
  }

  async unstable_resumeSession(params) {
    return this.resumeSession(params);
  }

  async resumeSession(params) {
    this.sessions.set(params.sessionId, { cwd: params.cwd, cancel: null, model: 'fast', mode: 'default', resumed: true });
    return { modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] }, configOptions: configOptions('fast') };
  }

  async logout() {
    process.stderr.write('fake: logged out\n');
    return {};
  }

  async authenticate(params) {
    // an agent with no browser to open: it prints its sign-in link (Gemini's way) and waits a moment
    if (process.env.FAKE_PRINT_LOGIN && params.methodId === 'oauth-personal') {
      process.stderr.write(`Please visit the following URL to authorize the application: ${process.env.FAKE_PRINT_LOGIN}\n`);
      await new Promise((r) => setTimeout(r, 300));
      return {};
    }
    if (process.env.FAKE_BROWSER_LOGIN && params.methodId === 'oauth-personal') {
      openBrowser(SIGN_IN);
      await new Promise((r) => setTimeout(r, 300));
      return {};
    }
    if (params.methodId !== 'fake-login') throw RequestError.invalidParams({ methodId: params.methodId });
    return {};
  }

  async setSessionMode(params) {
    const s = this.sessions.get(params.sessionId);
    s.mode = params.modeId;
    await this.update(params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: params.modeId });
    return {};
  }

  async setSessionConfigOption(params) {
    const s = this.sessions.get(params.sessionId);
    if (params.configId === 'model') s.model = params.value;
    if (params.configId === 'effort') s.effort = params.value;
    return { configOptions: configOptions(s.model, s.effort) };
  }

  update(sessionId, update) {
    return this.conn.sessionUpdate({ sessionId, update });
  }

  async cancel(params) {
    const s = this.sessions.get(params.sessionId);
    s?.cancel?.();
  }

  async prompt(params) {
    const sid = params.sessionId;
    const s = this.sessions.get(sid);
    const text = params.prompt.filter((b) => b.type === 'text').map((b) => b.text).join('');

    if (text.startsWith('env:')) {
      await this.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${process.env[text.slice(4)] ?? '(unset)'}${s.resumed ? ' resumed' : ''}` } });
      return { stopReason: 'end_turn' };
    }

    if (text === 'question') {
      const res = await this.conn.requestPermission({
        sessionId: sid,
        toolCall: { toolCallId: 'interaction_1', title: 'Which one?' },
        options: [{ optionId: '1', name: 'Red', kind: 'allow_once' }, { optionId: '2', name: 'Blue', kind: 'allow_once' }],
      });
      await this.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: res.outcome.outcome === 'selected' ? res.outcome.optionId : 'none' } });
      return { stopReason: 'end_turn' };
    }

    // a question of the agent's own, as OpenCode's `question` tool asks it: a form where the client takes forms,
    // else dismissed at once with the turn ended `cancelled`
    if (text === 'form' || text === 'form-two') {
      await this.update(sid, { sessionUpdate: 'tool_call', toolCallId: 'q1', title: 'question', kind: 'other', status: 'in_progress' });
      if (!this.clientCaps?.elicitation?.form) {
        await this.update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'q1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'The user dismissed this question' } }] });
        return { stopReason: 'cancelled' };
      }
      const fruit = { type: 'string', title: 'Fruit', description: 'Which fruit do you like best?', oneOf: [{ const: 'apple', title: 'Apple', description: 'Crisp' }, { const: 'banana', title: 'Banana' }] };
      const res = await this.conn.createElicitation({
        mode: 'form', sessionId: sid, toolCallId: 'q1', message: 'Questions',
        requestedSchema: {
          type: 'object',
          properties: {
            q0: fruit,
            q0_custom: { type: 'string', title: 'Fruit (other)', description: 'Type your own answer' },
            ...(text === 'form-two' ? { q1: { type: 'array', title: 'Days', items: { anyOf: [{ const: 'mon', title: 'Monday' }, { const: 'tue', title: 'Tuesday' }] } }, q2: { type: 'integer', title: 'How many?' }, q3: { type: 'boolean', title: 'Daily?' } } : {}),
          },
          required: [],
        },
      });
      await this.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(res) } });
      return { stopReason: res.action === 'accept' ? 'end_turn' : 'cancelled' };
    }

    if (text === 'which-mode') {
      await this.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: s.mode } });
      return { stopReason: 'end_turn' };
    }

    if (text === 'cancel-me') {
      await this.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'waiting...' } });
      await new Promise((resolve) => (s.cancel = resolve));
      s.cancel = null;
      return { stopReason: 'cancelled' };
    }

    if (text === 'cancel-permission') {
      await this.update(sid, { sessionUpdate: 'tool_call', toolCallId: 'p1', title: 'Dangerous', kind: 'delete', status: 'pending' });
      const res = await this.conn.requestPermission({
        sessionId: sid,
        toolCall: { toolCallId: 'p1' },
        options: [
          { optionId: 'ok', name: 'Allow', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      });
      return { stopReason: res.outcome.outcome === 'cancelled' ? 'cancelled' : 'end_turn' };
    }

    if (text === 'terminal') {
      const term = await this.conn.createTerminal({ sessionId: sid, command: 'echo hi', args: [], cwd: s.cwd });
      await this.update(sid, {
        sessionUpdate: 'tool_call',
        toolCallId: 'sh1',
        title: 'echo hi',
        kind: 'execute',
        status: 'in_progress',
        content: [{ type: 'terminal', terminalId: term.id }],
      });
      const exit = await term.waitForExit();
      const out = await term.currentOutput();
      await term.release();
      await this.update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'sh1', status: 'completed', rawOutput: { exit, output: out.output } });
      await this.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `exit=${exit.exitCode} out=${out.output.trim()}` } });
      return { stopReason: 'end_turn' };
    }

    if (text === 'mcp') {
      // echo the MCP servers this session was given
      await this.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(s.mcpServers ?? []) } });
      return { stopReason: 'end_turn' };
    }

    if (text === 'crash') {
      setTimeout(() => process.exit(3), 20);
      await new Promise(() => {});
    }

    if (text === 'fs') {
      const path = `${s.cwd}/note.txt`;
      await this.conn.writeTextFile({ sessionId: sid, path, content: 'line1\nline2\nline3' });
      const r = await this.conn.readTextFile({ sessionId: sid, path, line: 2, limit: 1 });
      await this.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `read:${r.content}` } });
      return { stopReason: 'end_turn' };
    }

    // default: full turn with permission
    await this.update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking' } });
    await this.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } });
    await this.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ', world' } });
    await this.update(sid, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      title: 'Write file',
      kind: 'edit',
      status: 'pending',
      locations: [{ path: `${s.cwd}/a.txt` }],
      rawInput: { path: `${s.cwd}/a.txt` },
    });
    const perm = await this.conn.requestPermission({
      sessionId: sid,
      toolCall: {
        toolCallId: 'call_1',
        content: [{ type: 'diff', path: `${s.cwd}/a.txt`, oldText: null, newText: 'hello' }],
      },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const allowed = perm.outcome.outcome === 'selected' && perm.outcome.optionId === 'allow';
    await this.update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: allowed ? 'completed' : 'failed' });
    await this.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? 'Done.' : 'Rejected.' } });
    await this.update(sid, { sessionUpdate: 'plan', entries: [{ content: 'step 1', priority: 'high', status: 'completed' }] });
    return { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
  }
}

if (!process.env.FAKE_QUIET) process.stderr.write('fake-agent: started\n');
const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new AgentSideConnection((conn) => new FakeAgent(conn), stream);
