import { describe, expect, it } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { TurnAssembler, bridgeToolName, extractConfig, friendlyToolTitle, mapToolKind } from './normalize';
import type { TurnOp } from './types';

const text = (t: string): SessionUpdate => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
const thought = (t: string): SessionUpdate => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: t } });

function feed(a: TurnAssembler, updates: SessionUpdate[], replaying = false): TurnOp[] {
  return updates.flatMap((u) => a.handle(u, replaying));
}

describe('TurnAssembler', () => {
  it('streams text into a single part', () => {
    const a = new TurnAssembler();
    const ops = feed(a, [text('Hel'), text('lo'), text(' world')]);
    expect(ops).toEqual([
      { op: 'delta', partIndex: 0, partType: 'text', delta: 'Hel' },
      { op: 'delta', partIndex: 0, partType: 'text', delta: 'lo' },
      { op: 'delta', partIndex: 0, partType: 'text', delta: ' world' },
    ]);
    expect(a.getParts()).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('starts a new part after a message was steered into the turn', () => {
    const a = new TurnAssembler();
    feed(a, [text('Working on it')]);
    a.cut();
    expect(feed(a, [text('Sure, '), text('also that')])).toEqual([
      { op: 'delta', partIndex: 1, partType: 'text', delta: 'Sure, ' },
      { op: 'delta', partIndex: 1, partType: 'text', delta: 'also that' },
    ]);
  });

  it('merges consecutive thoughts and separates thought/text parts', () => {
    const a = new TurnAssembler();
    const ops = feed(a, [thought('think '), thought('more'), text('answer'), thought('again')]);
    expect(ops.map((o) => (o.op === 'delta' ? [o.partIndex, o.partType] : null))).toEqual([
      [0, 'thought'],
      [0, 'thought'],
      [1, 'text'],
      [2, 'thought'],
    ]);
    expect(a.getParts()).toEqual([
      { type: 'thought', text: 'think more' },
      { type: 'text', text: 'answer' },
      { type: 'thought', text: 'again' },
    ]);
  });

  it('creates tool_call parts and merges tool_call_update', () => {
    const a = new TurnAssembler();
    const [create] = feed(a, [
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Read file',
        kind: 'read',
        locations: [{ path: '/tmp/a.txt', line: 3 }],
        rawInput: { path: '/tmp/a.txt' },
      },
    ]);
    expect(create).toMatchObject({
      op: 'part',
      partIndex: 0,
      part: { type: 'tool_call', toolCallId: 't1', title: 'Read file', kind: 'read', status: 'pending', content: [], locations: [{ path: '/tmp/a.txt', line: 3 }] },
    });
    expect((create as { part: { startedAt?: number } }).part.startedAt).toBeTypeOf('number');

    const [upd1] = feed(a, [{ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress', title: null }]);
    expect(upd1).toMatchObject({ op: 'part', partIndex: 0, part: { title: 'Read file', status: 'in_progress', kind: 'read' } });
    expect((upd1 as { part: { endedAt?: number } }).part.endedAt).toBeUndefined();

    const [upd2] = feed(a, [
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'file body' } },
          { type: 'diff', path: '/tmp/a.txt', oldText: null, newText: 'new' },
          { type: 'terminal', terminalId: 'term1' },
        ],
        rawOutput: { ok: true },
      },
    ]);
    expect(upd2).toMatchObject({
      op: 'part',
      partIndex: 0,
      part: {
        status: 'completed',
        rawInput: { path: '/tmp/a.txt' },
        rawOutput: { ok: true },
        content: [
          { type: 'text', text: 'file body' },
          { type: 'diff', path: '/tmp/a.txt', oldText: null, newText: 'new' },
          { type: 'terminal', terminalId: 'term1', output: '' },
        ],
      },
    });
    expect((upd2 as { part: { endedAt?: number } }).part.endedAt).toBeTypeOf('number');
    expect(a.terminalPartIndex('term1')).toBe(0);
    expect(a.terminalPartIndex('nope')).toBeUndefined();
  });

  it('creates a part for an update with an unknown toolCallId', () => {
    const a = new TurnAssembler();
    const ops = feed(a, [{ sessionUpdate: 'tool_call_update', toolCallId: 'x', title: 'Late', status: 'failed' }]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'part', partIndex: 0, part: { toolCallId: 'x', title: 'Late', status: 'failed', kind: 'other' } });
  });

  it('starts a new text part after a tool call', () => {
    const a = new TurnAssembler();
    const ops = feed(a, [
      text('before'),
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run', kind: 'execute' },
      text('after'),
      text(' more'),
    ]);
    expect(ops.filter((o) => o.op === 'delta').map((o) => (o as { partIndex: number }).partIndex)).toEqual([0, 2, 2]);
    expect(a.getParts().map((p) => p.type)).toEqual(['text', 'tool_call', 'text']);
    expect(a.getParts()[2]).toEqual({ type: 'text', text: 'after more' });
  });

  it('upserts a single plan part', () => {
    const a = new TurnAssembler();
    const ops = feed(a, [
      { sessionUpdate: 'plan', entries: [{ content: 'a', priority: 'high', status: 'pending' }] },
      text('x'),
      {
        sessionUpdate: 'plan',
        entries: [
          { content: 'a', priority: 'high', status: 'completed' },
          { content: 'b', priority: 'low', status: 'in_progress' },
        ],
      },
    ]);
    const planOps = ops.filter((o) => o.op === 'part');
    expect(planOps.map((o) => (o as { partIndex: number }).partIndex)).toEqual([0, 0]);
    expect(a.getParts()[0]).toEqual({
      type: 'plan',
      entries: [
        { content: 'a', priority: 'high', status: 'completed' },
        { content: 'b', priority: 'low', status: 'in_progress' },
      ],
    });
    expect(a.getParts()).toHaveLength(2);
  });

  it('maps commands, mode changes, title and usage', () => {
    const a = new TurnAssembler();
    const ops = feed(a, [
      {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'compact', description: 'Compact the conversation' },
          { name: 'review', description: 'Review', input: { hint: 'path' } },
        ],
      },
      { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
      { sessionUpdate: 'session_info_update', title: 'My chat' },
      { sessionUpdate: 'usage_update', used: 100, size: 2000 },
    ]);
    expect(ops).toEqual([
      {
        op: 'commands',
        commands: [
          { name: 'compact', description: 'Compact the conversation' },
          { name: 'review', description: 'Review', hint: 'path' },
        ],
      },
      { op: 'mode_changed', modeId: 'plan' },
      { op: 'title', title: 'My chat' },
      { op: 'usage', used: 100, size: 2000 },
    ]);
  });

  it('maps config options to models and modes (flattening groups)', () => {
    const a = new TurnAssembler();
    const ops = feed(a, [
      {
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'opus',
            options: [
              { group: 'anthropic', name: 'Anthropic', options: [{ value: 'opus', name: 'Opus', description: 'Big' }, { value: 'sonnet', name: 'Sonnet' }] },
              { group: 'other', name: 'Other', options: [{ value: 'haiku', name: 'Haiku' }] },
            ],
          },
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'default',
            options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }],
          },
          {
            id: 'effort',
            name: 'Effort',
            category: 'thought_level',
            type: 'select',
            currentValue: 'high',
            options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }],
          },
          { id: 'fast', name: 'Fast', type: 'boolean', currentValue: true },
        ],
      } as SessionUpdate,
    ]);
    expect(ops).toEqual([
      {
        op: 'models',
        models: [{ id: 'opus', name: 'Opus', description: 'Big' }, { id: 'sonnet', name: 'Sonnet' }, { id: 'haiku', name: 'Haiku' }],
        currentModelId: 'opus',
      },
      { op: 'modes', modes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }], currentModeId: 'default' },
      { op: 'efforts', efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], currentEffortId: 'high' },
      { op: 'fast', available: true, enabled: true },
    ]);
    // a full set without an effort or fast option: the model has neither
    expect(a.handle({ sessionUpdate: 'config_option_update', configOptions: [] } as SessionUpdate, false)).toEqual([
      { op: 'efforts', efforts: [] },
      { op: 'fast', available: false, enabled: false },
    ]);
    expect(extractConfig(null)).toEqual({});
  });

  it('reads the fast mode option as a boolean or as an on/off select', () => {
    const base = { id: 'fast', name: 'Fast mode', category: 'model_config', description: 'Faster responses on supported models' };
    expect(extractConfig([{ ...base, type: 'boolean', currentValue: false }] as never)).toEqual({ fastConfigId: 'fast', fastKind: 'boolean', fastEnabled: false });
    expect(extractConfig([{ ...base, type: 'boolean', currentValue: true }] as never)).toEqual({ fastConfigId: 'fast', fastKind: 'boolean', fastEnabled: true });
    const select = (v: string) => ({ ...base, type: 'select', currentValue: v, options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] });
    expect(extractConfig([select('on')] as never)).toEqual({ fastConfigId: 'fast', fastKind: 'select', fastEnabled: true });
    expect(extractConfig([select('off')] as never)).toEqual({ fastConfigId: 'fast', fastKind: 'select', fastEnabled: false });
    // found by category + name under another id
    expect(extractConfig([{ ...select('on'), id: 'speed' }] as never)).toMatchObject({ fastConfigId: 'speed', fastKind: 'select' });
    // a model_config option that isn't fast mode is ignored
    expect(extractConfig([{ ...select('on'), id: 'other', name: 'Other' }] as never)).toEqual({});
  });

  it('emits user_echo only when replaying, and resets per replayed user message', () => {
    const a = new TurnAssembler();
    const user: SessionUpdate = { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } };
    expect(a.handle(user, false)).toEqual([]);
    feed(a, [text('first answer')], true);
    expect(a.handle(user, true)).toEqual([{ op: 'user_echo', part: { type: 'text', text: 'hi' } }]);
    const ops = feed(a, [text('second')], true);
    expect(ops).toEqual([{ op: 'delta', partIndex: 0, partType: 'text', delta: 'second' }]);
  });

  it('images in message chunks become image parts', () => {
    const a = new TurnAssembler();
    const ops = feed(a, [text('look'), { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'AAAA' } }, text('done')]);
    expect(ops[1]).toEqual({ op: 'part', partIndex: 1, part: { type: 'image', mimeType: 'image/png', data: 'AAAA' } });
    expect(ops[2]).toMatchObject({ op: 'delta', partIndex: 2 });
  });

  it('detects computer tools and keeps terminal output across content replacement', () => {
    expect(mapToolKind('other', 'computer_click')).toBe('computer');
    expect(mapToolKind(undefined, undefined, 'mcp__appubot__computer_screenshot')).toBe('computer');
    expect(mapToolKind('weird')).toBe('other');
    expect(mapToolKind('edit', undefined, 'Edit file')).toBe('edit');

    const a = new TurnAssembler();
    feed(a, [{ sessionUpdate: 'tool_call', toolCallId: 't', title: 'Use computer', kind: 'other' }]);
    expect(a.getToolCall('t')?.kind).toBe('computer');

    a.appendTerminalOutput('term9', 'early ');
    feed(a, [{ sessionUpdate: 'tool_call', toolCallId: 'sh', title: 'ls', kind: 'execute', content: [{ type: 'terminal', terminalId: 'term9' }] }]);
    a.appendTerminalOutput('term9', 'output');
    a.setTerminalExit('term9', 0);
    const [op] = feed(a, [{ sessionUpdate: 'tool_call_update', toolCallId: 'sh', status: 'completed', content: [{ type: 'terminal', terminalId: 'term9' }] }]);
    expect(op).toMatchObject({ part: { content: [{ type: 'terminal', terminalId: 'term9', output: 'early output', exitCode: 0 }] } });
  });

  it('ignores unknown variants', () => {
    const a = new TurnAssembler();
    expect(a.handle({ sessionUpdate: 'something_new' } as unknown as SessionUpdate, false)).toEqual([]);
  });
});

describe('friendlyToolTitle', () => {
  it('labels AppuBot bridge tools and leaves others alone', () => {
    expect(friendlyToolTitle('mcp__appubot__send_file')).toBe('Send file to you');
    expect(friendlyToolTitle('appubot.computer_click')).toBe('Click');
    expect(friendlyToolTitle('mcp__appubot__unknown_tool')).toBe('mcp__appubot__unknown_tool');
    expect(friendlyToolTitle('mcp__appubot__update_bot')).toBe('Update a bot');
    expect(friendlyToolTitle('mcp__appubot__read_bot_history')).toBe('Read a bot’s chat');
    expect(friendlyToolTitle('Write /tmp/x.md')).toBe('Write /tmp/x.md');
  });

  it('keeps computer kind detection on the raw name', () => {
    const a = new TurnAssembler();
    const ops = a.handle({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'mcp__appubot__computer_click', status: 'pending' } as SessionUpdate, false);
    const part = ops.find((o) => o.op === 'part');
    expect(part && part.op === 'part' && part.part.type === 'tool_call' && part.part.kind).toBe('computer');
    expect(part && part.op === 'part' && part.part.type === 'tool_call' && part.part.title).toBe('Click');
  });

  it('never takes the bot tools for computer use', () => {
    const a = new TurnAssembler();
    for (const name of ['list_bots', 'get_bot', 'update_bot', 'read_bot_history']) {
      const ops = a.handle({ sessionUpdate: 'tool_call', toolCallId: name, title: `mcp__appubot__${name}`, kind: 'other', status: 'pending', rawInput: { bot_id: 'bot_1' } } as SessionUpdate, false);
      const part = ops.find((o) => o.op === 'part');
      expect(part && part.op === 'part' && part.part.type === 'tool_call' && part.part.kind).toBe('other');
    }
  });
});

describe('bridge tools behind friendly titles', () => {
  it('keeps which AppuBot tool a call is', () => {
    const a = new TurnAssembler();
    a.applyToolCallUpdate({ toolCallId: 't1', title: 'mcp__appubot__ask_user' });
    expect(a.getToolCall('t1')?.title).toBe('Ask you');
    expect(a.getBridgeTool('t1')).toBe('ask_user');
    a.applyToolCallUpdate({ toolCallId: 't2', title: 'Bash' });
    expect(a.getBridgeTool('t2')).toBeUndefined();
    expect(bridgeToolName('appubot.remember')).toBe('remember');
  });

  it("reads OpenCode's names for them", () => {
    const a = new TurnAssembler();
    a.applyToolCallUpdate({ toolCallId: 't1', title: 'appubot_send_file' });
    expect(a.getToolCall('t1')?.title).toBe('Send file to you');
    expect(a.getBridgeTool('t1')).toBe('send_file');
    expect(bridgeToolName('appubot_ask_user')).toBe('ask_user');
    expect(bridgeToolName('appubot__ask_user')).toBe('ask_user');
    expect(bridgeToolName('other_ask_user')).toBeUndefined();
  });
});

describe("bridge tools in Cursor's requests", () => {
  it('reads the tool from the title and from the input', async () => {
    const { bridgeToolName, bridgeToolFromInput } = await import('./normalize');
    expect(bridgeToolName('appubot-ask_user: ask_user')).toBe('ask_user');
    expect(bridgeToolFromInput({ providerIdentifier: 'appubot', toolName: 'ask_user', args: {} })).toBe('ask_user');
    expect(bridgeToolFromInput({ providerIdentifier: 'other', toolName: 'ask_user' })).toBeUndefined();
  });
});

describe('rate limits on usage updates', () => {
  it('forwards Claude Code’s rate_limit_event riding a usage update, and nothing for a plain one', () => {
    const a = new TurnAssembler();
    // the shape claude-agent-acp 0.89 sends (recorded from Claude Code 2.1.318: fractions, epoch seconds)
    const info = {
      status: 'allowed', resetsAt: 1793959800, rateLimitType: 'five_hour', overageStatus: 'rejected', isUsingOverage: false,
      unifiedWindows: { five_hour: { utilization: 0, resetsAt: 1793959800, status: 'allowed' }, seven_day: { utilization: 0.04, resetsAt: 1794016800, status: 'allowed' } },
    };
    const ops = feed(a, [{ sessionUpdate: 'usage_update', used: 10, size: 200, _meta: { '_claude/rateLimit': info } } as SessionUpdate]);
    expect(ops).toEqual([{ op: 'usage', used: 10, size: 200 }, { op: 'rateLimit', info }]);
    expect(feed(a, [{ sessionUpdate: 'usage_update', used: 10, size: 200, _meta: { other: 1 } } as SessionUpdate])).toEqual([{ op: 'usage', used: 10, size: 200 }]);
  });
});
