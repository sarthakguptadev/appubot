/**
 * Pure normalization of ACP `session/update` payloads into AppuBot `TurnOp`s.
 * No I/O; unit-tested in normalize.test.ts.
 */
import type { ContentBlock, SessionConfigOption, SessionUpdate, ToolCallContent, ToolCallUpdate } from '@agentclientprotocol/sdk';
import { tidyModels, type Part, type SessionMode, type SessionModel, type SlashCommand, type ToolContent } from '@appubot/protocol';
import type { ClaudeRateLimitInfo, TurnOp } from './types';

export type ToolCallPart = Extract<Part, { type: 'tool_call' }>;
export type ToolKindValue = ToolCallPart['kind'];
export type ToolStatusValue = ToolCallPart['status'];
type PlanPart = Extract<Part, { type: 'plan' }>;

const TOOL_KINDS: ReadonlySet<string> = new Set([
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'computer', 'other',
]);
const TOOL_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed', 'failed']);
const MAX_TERMINAL_OUTPUT = 1024 * 1024;

/* ---------------- helpers (exported for reuse by the runtime) ---------------- */

function looksLikeComputerTool(name: unknown, title: unknown, rawInput: unknown): boolean {
  const isComputerName = (s: unknown) =>
    typeof s === 'string' && (/^computer_/i.test(s) || /(^|__|[./:])computer_/i.test(s));
  if (isComputerName(name)) return true;
  if (typeof title === 'string' && (isComputerName(title) || /computer/i.test(title))) return true;
  if (rawInput && typeof rawInput === 'object') {
    const r = rawInput as Record<string, unknown>;
    if (isComputerName(r.tool) || isComputerName(r.name) || isComputerName(r.tool_name)) return true;
  }
  return false;
}

/** Human labels for AppuBot's own MCP bridge tools (agents report them as e.g. `mcp__appubot__send_file`). */
const APPUBOT_TOOL_TITLES: Record<string, string> = {
  send_file: 'Send file to you',
  show_page: 'Show you a page',
  notify_user: 'Notify you',
  ask_user: 'Ask you',
  remember: 'Remember',
  update_memory: 'Update memory',
  forget: 'Forget',
  read_memory: 'Read memory',
  save_skill: 'Save skill',
  list_bots: 'List bots',
  get_bot: 'Look at a bot',
  update_bot: 'Update a bot',
  read_bot_history: 'Read a bot’s chat',
  computer_batch: 'Use the app',
  computer_screenshot: 'Look at the screen',
  computer_window: 'Look at a window',
  computer_click: 'Click',
  computer_double_click: 'Double-click',
  computer_right_click: 'Right-click',
  computer_move: 'Move the pointer',
  computer_drag: 'Drag',
  computer_type: 'Type',
  computer_key: 'Press key',
  computer_hotkey: 'Press shortcut',
  computer_scroll: 'Scroll',
  computer_open_app: 'Open app',
  computer_list_apps: 'List apps',
  computer_list_windows: 'List windows',
  computer_focus_window: 'Focus window',
  computer_accessibility_tree: 'Read the app UI',
  computer_clipboard_read: 'Read clipboard',
  computer_clipboard_write: 'Write clipboard',
  computer_wait: 'Wait',
  create_bot: 'Make a bot',
  react: 'React',
};

/**
 * The AppuBot bridge tool a raw tool title names (`mcp__appubot__ask_user`, `appubot.ask_user`, Cursor's
 * `appubot-ask_user: ask_user` → `ask_user`), if any.
 */
export function bridgeToolName(title: string | null | undefined): string | undefined {
  return /^(?:mcp__appubot__|appubot[./:-]|appubot__)([a-z_]+)(?::\s*[a-z_]+)?$/.exec((title ?? '').trim())?.[1];
}

/** The same from a tool call's input, where an agent names the server and tool (Cursor: `providerIdentifier`, `toolName`). */
export function bridgeToolFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  const server = o.providerIdentifier ?? o.server ?? o.serverName;
  const tool = o.toolName ?? o.tool;
  return server === 'appubot' && typeof tool === 'string' && /^[a-z_]+$/.test(tool) ? tool : undefined;
}

/** `mcp__appubot__send_file` / `appubot.send_file` / `appubot/send_file` → "Send file to you"; other titles unchanged. */
export function friendlyToolTitle(title: string): string {
  const name = bridgeToolName(title);
  return (name && APPUBOT_TOOL_TITLES[name]) || title;
}

export function mapToolKind(kind: unknown, name?: unknown, title?: unknown, rawInput?: unknown): ToolKindValue {
  if (looksLikeComputerTool(name, title, rawInput)) return 'computer';
  if (typeof kind === 'string' && TOOL_KINDS.has(kind)) return kind as ToolKindValue;
  return 'other';
}

function mapStatus(status: unknown): ToolStatusValue | undefined {
  return typeof status === 'string' && TOOL_STATUSES.has(status) ? (status as ToolStatusValue) : undefined;
}

/** ACP ContentBlock -> ToolContent (undefined for unsupported blocks such as audio). */
export function contentBlockToToolContent(block: ContentBlock): ToolContent | undefined {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'image':
      return { type: 'image', mimeType: block.mimeType, data: block.data, ...(block.uri ? { uri: block.uri } : {}) };
    case 'resource_link':
      return {
        type: 'resource_link',
        uri: block.uri,
        name: block.name,
        ...(block.mimeType ? { mimeType: block.mimeType } : {}),
        ...(block.title ? { title: block.title } : {}),
        ...(typeof block.size === 'number' ? { size: block.size } : {}),
      };
    case 'resource': {
      const res = block.resource as { uri: string; text?: string };
      if (typeof res.text === 'string') return { type: 'text', text: res.text };
      return { type: 'resource_link', uri: res.uri, name: res.uri.split('/').pop() || res.uri };
    }
    default:
      return undefined;
  }
}

export function toolCallContentToToolContent(c: ToolCallContent): ToolContent | undefined {
  switch (c.type) {
    case 'content':
      return contentBlockToToolContent(c.content);
    case 'diff':
      return { type: 'diff', path: c.path, oldText: c.oldText ?? null, newText: c.newText };
    case 'terminal':
      return { type: 'terminal', terminalId: c.terminalId, output: '' };
    default:
      return undefined;
  }
}

/** Flatten (possibly grouped) select options. */
function flattenSelectOptions(options: unknown): { value: string; name: string; description?: string }[] {
  const out: { value: string; name: string; description?: string }[] = [];
  if (!Array.isArray(options)) return out;
  for (const o of options) {
    if (!o || typeof o !== 'object') continue;
    const rec = o as Record<string, unknown>;
    if (Array.isArray(rec.options)) {
      out.push(...flattenSelectOptions(rec.options));
    } else if (typeof rec.value === 'string') {
      out.push({
        value: rec.value,
        name: typeof rec.name === 'string' ? rec.name : rec.value,
        ...(typeof rec.description === 'string' && rec.description ? { description: rec.description } : {}),
      });
    }
  }
  return out;
}

export interface ExtractedConfig {
  models?: SessionModel[];
  currentModelId?: string;
  modelConfigId?: string;
  efforts?: SessionModel[];
  currentEffortId?: string;
  effortConfigId?: string;
  modes?: SessionMode[];
  currentModeId?: string;
  modeConfigId?: string;
  /** Claude Code's "Fast mode" toggle (only while the current model supports it) */
  fastConfigId?: string;
  /** `boolean` when the agent sent a boolean option, `select` for its on/off fallback */
  fastKind?: 'boolean' | 'select';
  fastEnabled?: boolean;
}

/** A "Fast mode" option: id `fast`, or a `model_config` option named so; a boolean, or an on/off select. */
function fastOption(o: Record<string, unknown>): { kind: 'boolean' | 'select'; enabled: boolean } | undefined {
  const isFast = o.id === 'fast' || (o.category === 'model_config' && typeof o.name === 'string' && o.name.trim().toLowerCase() === 'fast mode');
  if (!isFast) return undefined;
  if (o.type === 'boolean') return { kind: 'boolean', enabled: o.currentValue === true };
  if (o.type !== 'select') return undefined;
  const values = flattenSelectOptions(o.options).map((x) => x.value);
  if (!values.includes('on') || !values.includes('off')) return undefined;
  return { kind: 'select', enabled: o.currentValue === 'on' };
}

/** Pulls model / mode / reasoning effort (`thought_level`) select options and the fast mode toggle out of ACP session config options. */
export function extractConfig(configOptions: SessionConfigOption[] | null | undefined): ExtractedConfig {
  const result: ExtractedConfig = {};
  if (!Array.isArray(configOptions)) return result;
  for (const opt of configOptions) {
    const o = opt as unknown as Record<string, unknown>;
    const fast = result.fastConfigId ? undefined : fastOption(o);
    if (fast) {
      result.fastConfigId = String(o.id);
      result.fastKind = fast.kind;
      result.fastEnabled = fast.enabled;
      continue;
    }
    if (o.type !== 'select') continue;
    const category = typeof o.category === 'string' ? o.category : undefined;
    const id = String(o.id);
    const isModel = category === 'model' || (!category && id === 'model');
    const isMode = category === 'mode' || (!category && id === 'mode');
    const isEffort = category === 'thought_level';
    if (!isModel && !isMode && !isEffort) continue;
    const items = flattenSelectOptions(o.options).map((x) => ({
      id: x.value,
      name: x.name,
      ...(x.description ? { description: x.description } : {}),
    }));
    const current = typeof o.currentValue === 'string' ? o.currentValue : undefined;
    if (isModel && !result.models) {
      // rows the agent couldn't name (Claude Code's older versions from AppuBot's lineup) get a readable one
      result.models = tidyModels(items);
      result.modelConfigId = id;
      if (current) result.currentModelId = current;
    } else if (isEffort && !result.efforts) {
      result.efforts = items;
      result.effortConfigId = id;
      if (current) result.currentEffortId = current;
    } else if (isMode && !result.modes) {
      result.modes = items;
      result.modeConfigId = id;
      if (current) result.currentModeId = current;
    }
  }
  return result;
}

export function mapCommands(cmds: { name: string; description?: string | null; input?: unknown }[]): SlashCommand[] {
  return cmds.map((c) => {
    const input = c.input as { hint?: unknown } | null | undefined;
    const hint = input && typeof input.hint === 'string' ? input.hint : undefined;
    return { name: c.name, description: c.description ?? '', ...(hint ? { hint } : {}) };
  });
}

/* ---------------- TurnAssembler ---------------- */

/**
 * Assembles one agent message (`Part[]`) from streaming ACP updates.
 * Call `reset()` at the start of each prompt. During `session/load` replay each
 * replayed user message resets the assembler, i.e. agent content following a
 * `user_echo` op belongs to a new agent message starting at partIndex 0.
 */
export class TurnAssembler {
  private parts: Part[] = [];
  private toolIndex = new Map<string, number>();
  private planIndex: number | undefined;
  private terminalOutput = new Map<string, string>();
  private terminalExit = new Map<string, number | null>();
  /** the AppuBot bridge tool behind a tool call (its part only keeps the friendly title) */
  private bridgeTools = new Map<string, string>();

  /** the next text or thought starts a part of its own (a message was steered into the turn) */
  private split = false;

  /** What the agent says next starts a new part, whatever came last. */
  cut(): void {
    this.split = true;
  }

  reset(): void {
    this.split = false;
    this.bridgeTools.clear();
    this.parts = [];
    this.toolIndex.clear();
    this.planIndex = undefined;
    this.terminalOutput.clear();
    this.terminalExit.clear();
  }

  /** Snapshot of the current message parts. */
  getParts(): Part[] {
    return this.parts.map((p) => structuredClone(p));
  }

  /** The AppuBot bridge tool a tool call is (`ask_user`…), if it is one. */
  getBridgeTool(toolCallId: string): string | undefined {
    return this.bridgeTools.get(toolCallId);
  }

  getToolCall(toolCallId: string): ToolCallPart | undefined {
    const idx = this.toolIndex.get(toolCallId);
    if (idx === undefined) return undefined;
    const p = this.parts[idx];
    return p && p.type === 'tool_call' ? p : undefined;
  }

  /** partIndex of the tool_call part whose content references `terminalId`. */
  terminalPartIndex(terminalId: string): number | undefined {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      if (p?.type === 'tool_call' && p.content.some((c) => c.type === 'terminal' && c.terminalId === terminalId)) return i;
    }
    return undefined;
  }

  /**
   * Record terminal output so it survives later content replacement. Does not emit ops:
   * the runtime emits `terminal_output` itself.
   */
  appendTerminalOutput(terminalId: string, chunk: string): void {
    let out = (this.terminalOutput.get(terminalId) ?? '') + chunk;
    if (out.length > MAX_TERMINAL_OUTPUT) out = out.slice(out.length - MAX_TERMINAL_OUTPUT);
    this.terminalOutput.set(terminalId, out);
    const idx = this.terminalPartIndex(terminalId);
    if (idx !== undefined) this.fillTerminals(this.parts[idx] as ToolCallPart);
  }

  setTerminalExit(terminalId: string, exitCode: number | null): void {
    this.terminalExit.set(terminalId, exitCode);
    const idx = this.terminalPartIndex(terminalId);
    if (idx !== undefined) this.fillTerminals(this.parts[idx] as ToolCallPart);
  }

  handle(update: SessionUpdate, replaying: boolean): TurnOp[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return this.chunk('text', update.content);
      case 'agent_thought_chunk':
        return this.chunk('thought', update.content);
      case 'user_message_chunk': {
        if (!replaying) return [];
        const part = this.userPart(update.content);
        if (!part) return [];
        this.reset();
        return [{ op: 'user_echo', part }];
      }
      case 'tool_call':
        return this.toolCall(update);
      case 'tool_call_update':
        return this.applyToolCallUpdate(update);
      case 'plan': {
        const part: PlanPart = {
          type: 'plan',
          entries: (update.entries ?? []).map((e) => ({
            content: e.content,
            priority: (['high', 'medium', 'low'].includes(e.priority) ? e.priority : 'medium') as PlanPart['entries'][number]['priority'],
            status: (['pending', 'in_progress', 'completed'].includes(e.status) ? e.status : 'pending') as PlanPart['entries'][number]['status'],
          })),
        };
        if (this.planIndex === undefined) {
          this.planIndex = this.parts.length;
          this.parts.push(part);
        } else {
          this.parts[this.planIndex] = part;
        }
        return [{ op: 'part', partIndex: this.planIndex, part: structuredClone(part) }];
      }
      case 'available_commands_update':
        return [{ op: 'commands', commands: mapCommands(update.availableCommands ?? []) }];
      case 'current_mode_update':
        return [{ op: 'mode_changed', modeId: update.currentModeId }];
      case 'config_option_update': {
        const cfg = extractConfig(update.configOptions);
        const ops: TurnOp[] = [];
        if (cfg.models) ops.push({ op: 'models', models: cfg.models, ...(cfg.currentModelId ? { currentModelId: cfg.currentModelId } : {}) });
        if (cfg.modes) ops.push({ op: 'modes', modes: cfg.modes, ...(cfg.currentModeId ? { currentModeId: cfg.currentModeId } : {}) });
        // the update carries every option, so no effort option means the current model has no effort choice
        if (Array.isArray(update.configOptions)) {
          ops.push({ op: 'efforts', efforts: cfg.efforts ?? [], ...(cfg.currentEffortId ? { currentEffortId: cfg.currentEffortId } : {}) });
          // likewise fast mode: only offered while the current model supports it
          ops.push({ op: 'fast', available: !!cfg.fastConfigId, enabled: !!cfg.fastEnabled });
        }
        return ops;
      }
      case 'session_info_update':
        return typeof update.title === 'string' && update.title ? [{ op: 'title', title: update.title }] : [];
      case 'usage_update': {
        const ops: TurnOp[] = [{ op: 'usage', used: update.used, size: update.size }];
        // Claude Code's adapter rides its rate_limit_event on the usage update (plan limits, for the model picker)
        const info = (update as { _meta?: Record<string, unknown> })._meta?.['_claude/rateLimit'];
        if (info && typeof info === 'object') ops.push({ op: 'rateLimit', info: info as ClaudeRateLimitInfo });
        return ops;
      }
      default:
        return [];
    }
  }

  /* ---- internals ---- */

  private userPart(block: ContentBlock): Part | undefined {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'image') return { type: 'image', mimeType: block.mimeType, data: block.data };
    if (block.type === 'resource_link') return { type: 'text', text: `[${block.name}](${block.uri})` };
    if (block.type === 'resource') {
      const res = block.resource as { uri: string; text?: string };
      return { type: 'text', text: typeof res.text === 'string' ? res.text : res.uri };
    }
    return undefined;
  }

  private chunk(kind: 'text' | 'thought', block: ContentBlock): TurnOp[] {
    let text: string | undefined;
    if (block.type === 'text') text = block.text;
    else if (block.type === 'resource_link') text = `[${block.name}](${block.uri})`;
    else if (block.type === 'resource') {
      const res = block.resource as { text?: string };
      if (typeof res.text === 'string') text = res.text;
    } else if (block.type === 'image') {
      const part: Part = { type: 'image', mimeType: block.mimeType, data: block.data };
      const partIndex = this.parts.length;
      this.parts.push(part);
      return [{ op: 'part', partIndex, part: structuredClone(part) }];
    }
    if (text === undefined || text === '') return [];
    const lastIndex = this.parts.length - 1;
    const last = this.parts[lastIndex];
    const split = this.split;
    this.split = false;
    if (last && last.type === kind && !split) {
      last.text += text;
      return [{ op: 'delta', partIndex: lastIndex, partType: kind, delta: text }];
    }
    const partIndex = this.parts.length;
    this.parts.push({ type: kind, text });
    return [{ op: 'delta', partIndex, partType: kind, delta: text }];
  }

  private convertContent(content: ToolCallContent[] | null | undefined): ToolContent[] {
    if (!Array.isArray(content)) return [];
    const out: ToolContent[] = [];
    for (const c of content) {
      const tc = toolCallContentToToolContent(c);
      if (tc) out.push(tc);
    }
    return out;
  }

  private fillTerminals(part: ToolCallPart): void {
    for (const c of part.content) {
      if (c.type !== 'terminal') continue;
      const out = this.terminalOutput.get(c.terminalId);
      if (out !== undefined) c.output = out;
      if (this.terminalExit.has(c.terminalId)) c.exitCode = this.terminalExit.get(c.terminalId) ?? null;
    }
  }

  private toolCall(update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>): TurnOp[] {
    if (this.toolIndex.has(update.toolCallId)) {
      // Some agents re-announce a tool call; treat it as an update.
      return this.applyToolCallUpdate(update);
    }
    const status = mapStatus(update.status) ?? 'pending';
    const now = Date.now();
    const part: ToolCallPart = {
      type: 'tool_call',
      toolCallId: update.toolCallId,
      title: friendlyToolTitle(update.title ?? ''),
      kind: mapToolKind(update.kind, update.name, update.title, update.rawInput),
      status,
      content: this.convertContent(update.content),
      locations: (update.locations ?? []).map((l) => ({ path: l.path, ...(typeof l.line === 'number' ? { line: l.line } : {}) })),
      ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
      ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
      startedAt: now,
      ...(status === 'completed' || status === 'failed' ? { endedAt: now } : {}),
    };
    this.fillTerminals(part);
    const partIndex = this.parts.length;
    this.parts.push(part);
    this.toolIndex.set(update.toolCallId, partIndex);
    const bridge = bridgeToolName(update.title);
    if (bridge) this.bridgeTools.set(update.toolCallId, bridge);
    return [{ op: 'part', partIndex, part: structuredClone(part) }];
  }

  /** Merge a (partial) tool call update. Creates the part if the toolCallId is unknown. */
  applyToolCallUpdate(update: ToolCallUpdate & { name?: string | null }): TurnOp[] {
    const idx = this.toolIndex.get(update.toolCallId);
    const existing = idx === undefined ? undefined : this.parts[idx];
    if (idx === undefined || !existing || existing.type !== 'tool_call') {
      return this.toolCall({
        sessionUpdate: 'tool_call',
        toolCallId: update.toolCallId,
        title: update.title ?? '',
        ...(update.name != null ? { name: update.name } : {}),
        ...(update.kind != null ? { kind: update.kind } : {}),
        ...(update.status != null ? { status: update.status } : {}),
        ...(update.content != null ? { content: update.content } : {}),
        ...(update.locations != null ? { locations: update.locations } : {}),
        ...(update.rawInput !== undefined && update.rawInput !== null ? { rawInput: update.rawInput } : {}),
        ...(update.rawOutput !== undefined && update.rawOutput !== null ? { rawOutput: update.rawOutput } : {}),
      });
    }
    const part = existing;
    if (update.title != null) part.title = friendlyToolTitle(update.title);
    const bridge = bridgeToolName(update.title);
    if (bridge) this.bridgeTools.set(update.toolCallId, bridge);
    if (update.rawInput !== undefined && update.rawInput !== null) part.rawInput = update.rawInput;
    if (update.rawOutput !== undefined && update.rawOutput !== null) part.rawOutput = update.rawOutput;
    if (update.kind != null || update.title != null || update.name != null || update.rawInput != null) {
      const kind = mapToolKind(update.kind ?? (part.kind === 'computer' ? 'other' : part.kind), update.name, update.title ?? part.title, part.rawInput);
      // Never downgrade an already-detected computer tool / known kind to 'other' because the update omits kind.
      if (update.kind != null || kind === 'computer') part.kind = kind;
    }
    const status = mapStatus(update.status);
    if (status) {
      part.status = status;
      if ((status === 'completed' || status === 'failed') && part.endedAt === undefined) part.endedAt = Date.now();
    }
    if (update.content != null) part.content = this.convertContent(update.content);
    if (update.locations != null) {
      part.locations = update.locations.map((l) => ({ path: l.path, ...(typeof l.line === 'number' ? { line: l.line } : {}) }));
    }
    this.fillTerminals(part);
    return [{ op: 'part', partIndex: idx, part: structuredClone(part) }];
  }
}
