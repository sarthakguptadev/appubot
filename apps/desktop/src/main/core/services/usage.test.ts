import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageSummarySchema, type Provider } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { checkRole } from '../handlers';
import { silentLogger } from '../util';
import { UsageService, readJsonLines } from './usage';
import {
  GROK_TICKS_PER_USD, PI_OTHER_MODEL, bucketStarts, codexState, costOf, inBotsRoot, cacheSavingsOf, modelName, normalizeModel, parseClaudeLine, parseCodexLine,
  parseCopilotRow, parseGeminiFile, parseGeminiLine, parseGrokLine, parseOpenCodeMessage, parsePiLine, piState, priceOf, rangeStart, summarize,
  type UsageRecord,
} from './usageLogs';
import { DatabaseSync } from 'node:sqlite';
import { readCopilotDb, readOpenCodeDb, readOpenCodeLegacy } from './usageSqlite';

/* Fixtures are made-up lines in the agents' log shapes (never real logs); only the fields usage reads carry values. */

const NOW = new Date(2026, 9, 28, 15, 30).getTime(); // 28 Oct 2026, 15:30 local
const at = (daysAgo: number, hour = 12): string => new Date(2026, 9, 28 - daysAgo, hour).toISOString();

const claudeLine = (o: { id?: string; req?: string; model?: string; ts?: string; cwd?: string; input?: number; output?: number; read?: number; write?: number; write1h?: number }): string => JSON.stringify({
  type: 'assistant', timestamp: o.ts ?? at(0), requestId: o.req ?? 'req_1', cwd: o.cwd ?? '/Users/me/code',
  message: {
    id: o.id ?? 'msg_1', model: o.model ?? 'claude-opus-4-5-20251101', content: [{ type: 'text', text: '…' }],
    usage: {
      input_tokens: o.input ?? 10, output_tokens: o.output ?? 100, cache_read_input_tokens: o.read ?? 1000, cache_creation_input_tokens: o.write ?? 200,
      ...(o.write1h !== undefined ? { cache_creation: { ephemeral_5m_input_tokens: (o.write ?? 200) - o.write1h, ephemeral_1h_input_tokens: o.write1h } } : {}),
    },
  },
});

const codexUsage = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
const codexLines = (cwd: string, ts = at(0)): string[] => [
  JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id: 's1', cwd, model_provider: 'openai' } }),
  JSON.stringify({ timestamp: ts, type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-5.5' } }),
  JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: codexUsage(1000, 800, 50), total_token_usage: codexUsage(1000, 800, 50) } } }),
  // the same event again (Codex re-emits it): counts once
  JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: codexUsage(1000, 800, 50), total_token_usage: codexUsage(1000, 800, 50) } } }),
  JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: codexUsage(2000, 1500, 70), total_token_usage: codexUsage(3000, 2300, 120) } } }),
  // a context-size report, not a request
  JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: codexUsage(0, 0, 0), total_token_usage: codexUsage(3000, 2300, 120) } } }),
];

describe('parseClaudeLine', () => {
  it('reads an assistant message’s usage, model, time and key', () => {
    const r = parseClaudeLine(claudeLine({ write1h: 50 }), '/Users/me/AppuBot');
    expect(r).toMatchObject({ key: 'claude:msg_1:req_1', model: 'claude-opus-4-5-20251101', input: 10, output: 100, cacheRead: 1000, cacheWrite: 200, cacheWrite1h: 50, bot: false });
  });
  it('marks a request made in a bot’s folder', () => {
    expect(parseClaudeLine(claudeLine({ cwd: '/Users/me/AppuBot/appu' }), '/Users/me/AppuBot')?.bot).toBe(true);
    expect(parseClaudeLine(claudeLine({ cwd: '/Users/me/AppuBotOther' }), '/Users/me/AppuBot')?.bot).toBe(false);
  });
  it('knows a bot’s folder on Windows whatever its slashes and case', () => {
    expect(inBotsRoot('c:/users/me/appubot/appu', 'C:\\Users\\me\\AppuBot', 'win32')).toBe(true);
    expect(inBotsRoot('C:\\Users\\me\\AppuBot\\', 'C:\\Users\\me\\AppuBot', 'win32')).toBe(true);
    expect(inBotsRoot('C:\\Users\\me\\AppuBotOther', 'C:\\Users\\me\\AppuBot', 'win32')).toBe(false);
    expect(inBotsRoot('/Users/me/appubot/appu', '/Users/me/AppuBot', 'darwin')).toBe(false);
  });
  it('skips user lines, placeholders and broken lines', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'user', message: { usage: { input_tokens: 5 } } }))).toBeNull();
    expect(parseClaudeLine(claudeLine({ model: '<synthetic>' }))).toBeNull();
    expect(parseClaudeLine('{"type":"assistant","message":')).toBeNull();
  });
});

describe('parseCodexLine', () => {
  it('takes the model from turn_context, splits cached input out and counts a re-emitted event once', () => {
    const state = codexState();
    const recs = codexLines('/Users/me/AppuBot/appu').map((l) => parseCodexLine(l, state, '/Users/me/AppuBot')).filter((r): r is UsageRecord => !!r);
    expect(recs).toHaveLength(3);
    expect(recs[0]).toMatchObject({ model: 'gpt-5.5', input: 200, cacheRead: 800, output: 50, bot: true });
    // the re-emitted one has the same key, so the summary drops it
    expect(recs[1]!.key).toBe(recs[0]!.key);
    expect(recs[2]).toMatchObject({ input: 500, cacheRead: 1500, output: 70 });
    const s = summarize([{ id: 'codex', name: 'Codex', records: recs }], 'today', NOW);
    expect(s.totals).toMatchObject({ requests: 2, input: 700, cacheRead: 2300, output: 120 });
  });
  it('waits for a model before counting', () => {
    const state = codexState();
    expect(parseCodexLine(codexLines('/x')[2]!, state)).toBeNull();
  });
});

describe('prices', () => {
  it('finds a model under its dated or variant id', () => {
    expect(normalizeModel('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(normalizeModel('claude-opus-4-6[1m]')).toBe('claude-opus-4-6');
    expect(priceOf('claude-opus-5-5')).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
    expect(priceOf('gpt-5')).toBeDefined();
    expect(priceOf('codex-auto-review')).toBeUndefined();
  });
  it('prices each kind of token at its own rate', () => {
    // Opus 4.5: $5 in, $25 out, $0.50 cache read, $6.25 5-minute write, $10 1-hour write
    const r = { model: 'claude-opus-4-5-20251101', input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 2_000_000, cacheWrite1h: 1_000_000 };
    expect(costOf(r)).toBeCloseTo(5 + 25 + 0.5 + 6.25 + 10, 6);
    expect(cacheSavingsOf(r)).toBeCloseTo(4.5, 6);
    // Codex: cache writes at the input price
    expect(costOf({ model: 'gpt-5.5', input: 2_000_000, output: 0, cacheRead: 10_000_000, cacheWrite: 0, cacheWrite1h: 0 })).toBeCloseTo(10 + 5, 6);
    expect(costOf({ model: 'mystery-1', input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 })).toBe(0);
  });
  it('names models for people', () => {
    expect(modelName('claude-opus-4-5-20251101')).toBe('Claude Opus 4.5');
    expect(modelName('claude-fable-5')).toBe('Claude Fable 5');
    expect(modelName('gpt-5.6-luna')).toBe('GPT-5.6 Luna');
    expect(modelName('gpt-5.3-codex')).toBe('GPT-5.3 Codex');
    expect(modelName('codex-auto-review')).toBe('codex-auto-review');
  });
});

describe('summarize', () => {
  const rec = (o: Partial<UsageRecord>): UsageRecord => ({ ts: NOW - 1000, model: 'claude-sonnet-4-6', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, bot: false, ...o });

  it('buckets by hour today and by day otherwise, in local time', () => {
    expect(bucketStarts('today', NOW)).toHaveLength(24);
    expect(bucketStarts('7d', NOW)).toHaveLength(7);
    expect(bucketStarts('30d', NOW)).toHaveLength(30);
    expect(rangeStart('7d', NOW)).toBe(new Date(2026, 9, 22).getTime());
  });

  it('adds up totals, days, models and agents, counts a key once and leaves out what’s outside the range', () => {
    const claude = [
      rec({ key: 'a', ts: new Date(2026, 9, 28, 9).getTime(), input: 1_000_000, bot: true }),
      rec({ key: 'a', ts: new Date(2026, 9, 28, 9).getTime(), input: 1_000_000 }), // the same message logged twice
      rec({ key: 'b', ts: new Date(2026, 9, 26, 9).getTime(), output: 1_000_000 }),
      rec({ key: 'c', ts: new Date(2026, 9, 1).getTime(), output: 5 }), // before the last 7 days
      rec({ key: 'd', model: 'mystery-1', output: 300 }),
    ];
    const profile = [rec({ key: 'e', model: 'claude-haiku-4-5', ts: new Date(2026, 9, 27, 9).getTime(), input: 1_000_000 })];
    const s = summarize([{ id: 'claude-code', name: 'Claude Code · Main', records: claude }, { id: 'claude-code@work', name: 'Claude Code · Work', records: profile }, { id: 'codex', name: 'Codex', records: [] }], '7d', NOW);
    expect(UsageSummarySchema.parse(s)).toBeTruthy();
    expect(s.totals.requests).toBe(4);
    expect(s.totals.tokens).toBe(3_000_300);
    expect(s.totals.costUsd).toBeCloseTo(3 + 15 + 1, 6);
    expect(s.totals.unpricedTokens).toBe(300);
    expect(s.byBots).toEqual({ tokens: 1_000_000, costUsd: 3 });
    expect(s.series.map((d) => Math.round(d.costUsd))).toEqual([0, 0, 0, 0, 15, 1, 3]);
    expect(s.models.map((m) => [m.name, m.priced])).toEqual([['Claude Sonnet 4.6', true], ['Claude Haiku 4.5', true], ['mystery-1', false]]);
    expect(s.agents.map((a) => a.id)).toEqual(['claude-code', 'claude-code@work']);
    expect(s.sources).toHaveLength(3);
  });

  it('counts only the bots’ requests for the bots scope', () => {
    const recs = [
      rec({ key: 'a', input: 1_000_000, bot: true }),
      rec({ key: 'b', input: 2_000_000 }),
      rec({ key: 'b', input: 2_000_000, bot: true }), // a copy of an outside request
    ];
    const s = summarize([{ id: 'claude-code', name: 'Claude Code', records: recs }], 'today', NOW, undefined, 'bots');
    expect(s.scope).toBe('bots');
    expect(s.totals.tokens).toBe(1_000_000);
    expect(s.byBots.tokens).toBe(1_000_000);
    expect(s.agents.map((a) => a.requests)).toEqual([1]);
  });

  it('says nothing was used when there are no records', () => {
    const s = summarize([], 'today', NOW);
    expect(s.totals.requests).toBe(0);
    expect(s.series.every((b) => b.tokens === 0)).toBe(true);
    expect(s.sources).toEqual([]);
  });
});

describe('readJsonLines', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'appubot-usage-lines-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('hands over marked lines, leaves a half-written last line for later and reads on from an offset', async () => {
    const f = join(dir, 'a.jsonl');
    writeFileSync(f, '{"usage":1}\n{"other":2}\n{"usage":3');
    const got: string[] = [];
    const off = await readJsonLines(f, 0, ['"usage"'], (l) => got.push(l));
    expect(got).toEqual(['{"usage":1}']);
    appendFileSync(f, '}\n{"usage":4}\n');
    const off2 = await readJsonLines(f, off, ['"usage"'], (l) => got.push(l));
    expect(got).toEqual(['{"usage":1}', '{"usage":3}', '{"usage":4}']);
    expect(off2).toBeGreaterThan(off);
  });

  it('reads lines longer than a chunk', async () => {
    const f = join(dir, 'big.jsonl');
    const long = JSON.stringify({ usage: 1, pad: 'x'.repeat(3 << 20) });
    writeFileSync(f, `${long}\n{"usage":2}\n`);
    const got: string[] = [];
    await readJsonLines(f, 0, ['"usage"'], (l) => got.push(l));
    expect(got.map((l) => (JSON.parse(l) as { usage: number }).usage)).toEqual([1, 2]);
  });
});

describe('UsageService', () => {
  let root: string;
  let home: string;
  let service: UsageService;
  const providers: Partial<Provider>[] = [
    { id: 'claude-code', name: 'Claude Code', profileName: 'Main' },
    { id: 'claude-code@work', name: 'Claude Code · Work', profile: { of: 'claude-code', name: 'Work', home: '', source: 'folder' } },
    { id: 'codex', name: 'Codex' },
  ];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'appubot-usage-'));
    home = join(root, 'home');
    const bots = join(home, 'AppuBot');
    const claudeDir = join(home, '.claude', 'projects', '-Users-me-code');
    const workDir = join(home, '.claude-work', 'projects', '-Users-me-AppuBot-appu', 'session-1', 'subagents');
    const codexDir = join(home, '.codex', 'sessions', '2026', '10', '28');
    for (const d of [claudeDir, workDir, codexDir]) mkdirSync(d, { recursive: true });
    providers[1]!.profile!.home = join(home, '.claude-work');
    // one message over two content-block lines, and a second message
    writeFileSync(join(claudeDir, 's1.jsonl'), [claudeLine({}), claudeLine({}), claudeLine({ id: 'msg_2', req: 'req_2', model: 'claude-sonnet-4-6' }), '{"type":"user","message":{"content":"hi"}}'].join('\n') + '\n');
    writeFileSync(join(workDir, 'agent-1.jsonl'), claudeLine({ id: 'msg_3', req: 'req_3', cwd: bots, model: 'claude-haiku-4-5' }) + '\n');
    writeFileSync(join(codexDir, 'rollout-1.jsonl'), codexLines(join(bots, 'appu')).join('\n') + '\n');
    // a file untouched for months is never read
    const old = join(claudeDir, 'old.jsonl');
    writeFileSync(old, claudeLine({ id: 'msg_old', req: 'r', ts: at(90) }) + '\n');
    utimesSync(old, new Date(2026, 6, 1), new Date(2026, 6, 1));
    const ctx = {
      deps: { homeDir: home }, paths: { botsRoot: bots }, log: silentLogger,
      s: { providers: { list: () => providers } },
    } as unknown as CoreCtx;
    service = new UsageService(ctx);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reads every agent’s and profile’s logs into one summary', async () => {
    // the fixtures are stamped relative to NOW (files' own mtimes are the real clock's, never older than NOW's 31 days)
    const s = await service.summary('30d', 'all', NOW);
    expect(s.sources.map((x) => x.name)).toEqual(['Claude Code · Main', 'Claude Code · Work', 'Codex']);
    const byAgent = Object.fromEntries(s.agents.map((a) => [a.id, a.requests]));
    expect(byAgent).toEqual({ 'claude-code': 2, 'claude-code@work': 1, codex: 2 });
    expect(s.byBots.tokens).toBeGreaterThan(0);
  });

  it('picks up lines appended since the last look', async () => {
    const f = join(home, '.claude', 'projects', '-Users-me-code', 's1.jsonl');
    appendFileSync(f, claudeLine({ id: 'msg_9', req: 'req_9' }) + '\n');
    const s = await service.summary('30d', 'all', NOW);
    expect(s.agents.find((a) => a.id === 'claude-code')?.requests).toBe(3);
  });

  it('is the owner’s alone', () => {
    expect(() => checkRole('usage.summary', {}, { role: 'agent', deviceId: 'x' })).toThrow();
    expect(() => checkRole('usage.summary', {}, { role: 'owner', deviceId: 'x' })).not.toThrow();
  });
});

/* ---------------- the other agents (made-up lines in each agent's shape) ---------------- */

const grokLine = (o: { prompt?: string | null; ms?: number; secs?: number; usage?: Record<string, unknown>; models?: Record<string, Record<string, unknown>> | null } = {}): string => JSON.stringify({
  timestamp: o.secs ?? Math.floor(NOW / 1000) - 60, method: '_x.ai/session/update',
  params: {
    sessionId: 'sess-1',
    update: {
      sessionUpdate: 'turn_completed', ...(o.prompt === null ? {} : { prompt_id: o.prompt ?? 'p1' }), stop_reason: 'end_turn',
      usage: {
        inputTokens: 2000, outputTokens: 100, cachedReadTokens: 1500, cacheCreationTokens: 0, reasoningTokens: 40, modelCalls: 3, costUsdTicks: 50_000_000,
        ...(o.models === null ? {} : { modelUsage: o.models ?? { 'grok-4.7-build': { inputTokens: 2000, outputTokens: 100, cachedReadTokens: 1500, modelCalls: 3, costUsdTicks: 50_000_000 } } }),
        ...o.usage,
      },
    },
    ...(o.ms === undefined ? {} : { _meta: { agentTimestampMs: o.ms } }),
  },
});

describe('parseGrokLine', () => {
  it('reads a turn’s usage per model with xAI’s own cost', () => {
    const [r, ...rest] = parseGrokLine(grokLine({ ms: NOW - 5000 }), true);
    expect(rest).toEqual([]);
    expect(r).toMatchObject({ key: 'grok:sess-1:p1:grok-4.7-build', ts: NOW - 5000, model: 'grok-4.7-build', input: 500, cacheRead: 1500, output: 100, requests: 3, bot: true });
    expect(r!.costUsd).toBeCloseTo(0.005, 12);
  });
  it('shares the turn’s cost left over among models without their own, by tokens', () => {
    const recs = parseGrokLine(grokLine({
      usage: { costUsdTicks: GROK_TICKS_PER_USD },
      models: { a: { inputTokens: 300, costUsdTicks: 0.4 * GROK_TICKS_PER_USD }, b: { inputTokens: 300 }, c: { inputTokens: 100 } },
    }));
    const cost = Object.fromEntries(recs.map((r) => [r.model, r.costUsd]));
    expect(cost.a).toBeCloseTo(0.4, 12);
    expect(cost.b).toBeCloseTo(0.45, 12);
    expect(cost.c).toBeCloseTo(0.15, 12);
  });
  it('falls back to the turn as `grok`, the line’s seconds, and no key without a prompt id', () => {
    const [r] = parseGrokLine(grokLine({ models: null, prompt: null, secs: 1_790_000_000 }));
    expect(r).toMatchObject({ model: 'grok', ts: 1_790_000_000_000 });
    expect(r!.key).toBeUndefined();
  });
  it('skips other updates and empty turns', () => {
    expect(parseGrokLine(JSON.stringify({ params: { update: { sessionUpdate: 'agent_message_chunk' } } }))).toEqual([]);
    expect(parseGrokLine(grokLine({ models: { x: { inputTokens: 0, outputTokens: 0 } } }))).toEqual([]);
    expect(parseGrokLine('{"params":')).toEqual([]);
  });
});

const openCodeMessage = (o: Record<string, unknown> = {}): string => JSON.stringify({
  id: 'msg_a', sessionID: 'ses_1', role: 'assistant', modelID: 'claude-sonnet-4-5', providerID: 'anthropic', time: { created: NOW - 1000 },
  cost: 0, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 300, write: 10 } }, ...o,
});

describe('parseOpenCodeMessage', () => {
  it('reads an assistant message, reasoning as output, and a positive cost as its own', () => {
    expect(parseOpenCodeMessage(openCodeMessage(), '/bots', { cwd: '/bots/appu' })).toMatchObject({
      key: 'opencode:msg_a', model: 'claude-sonnet-4-5', input: 100, output: 25, cacheRead: 300, cacheWrite: 10, bot: true,
    });
    expect(parseOpenCodeMessage(openCodeMessage())?.costUsd).toBeUndefined();
    expect(parseOpenCodeMessage(openCodeMessage({ cost: 0.25, path: { cwd: '/elsewhere' } }), '/bots', { cwd: '/bots/appu' })).toMatchObject({ costUsd: 0.25, bot: false });
  });
  it('reads v2 messages (`model.id`) with the row’s id and time', () => {
    const v2 = JSON.stringify({ model: { id: 'gpt-5.5', providerID: 'openai' }, time: {}, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } });
    expect(parseOpenCodeMessage(v2, undefined, { id: 'msg_v2', created: NOW })).toMatchObject({ key: 'opencode:msg_v2', model: 'gpt-5.5', ts: NOW });
  });
  it('skips user messages, empty usage and broken JSON', () => {
    expect(parseOpenCodeMessage(openCodeMessage({ role: 'user' }))).toBeNull();
    expect(parseOpenCodeMessage(openCodeMessage({ tokens: { input: 0, output: 0, cache: {} } }))).toBeNull();
    expect(parseOpenCodeMessage('{nope')).toBeNull();
  });
});

describe('parsePiLine', () => {
  const at0 = at(0);
  const lines = [
    JSON.stringify({ type: 'session', id: 'pi-s1', cwd: '/bots/appu', timestamp: at0 }),
    JSON.stringify({ type: 'message', id: 'e1', timestamp: at0, message: { role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-4-5', usage: { input: 10, output: 20, cacheRead: 300, cacheWrite: 40, cost: { total: 0.01 } } } }),
    JSON.stringify({ type: 'message', id: 'e2', timestamp: at0, message: { role: 'toolResult', usage: { input: 5, output: 0, cost: { total: 0 } } } }),
    JSON.stringify({ type: 'message', id: 'e3', timestamp: at0, message: { role: 'user', usage: { input: 5 } } }),
    JSON.stringify({ type: 'usage', id: 'e4', timestamp: at0, provider: 'openai', model: 'gpt-5.5', usage: { input: 1, output: 1 } }),
  ];
  it('reads assistant, tool and usage entries with Pi’s own cost, and the bot from the header', () => {
    const state = piState();
    const recs = lines.map((l) => parsePiLine(l, state, '/bots')).filter((r): r is UsageRecord => !!r);
    expect(state.sessionId).toBe('pi-s1');
    expect(recs.map((r) => [r.model, r.costUsd, r.bot])).toEqual([
      ['anthropic/claude-sonnet-4-5', 0.01, true], [PI_OTHER_MODEL, undefined, true], ['openai/gpt-5.5', undefined, true],
    ]);
    expect(recs[0]).toMatchObject({ input: 10, output: 20, cacheRead: 300, cacheWrite: 40 });
    expect(recs[0]!.key).toBe(JSON.stringify(['pi', 'e1', at0, 'anthropic/claude-sonnet-4-5']));
    expect(modelName(PI_OTHER_MODEL)).toBe(PI_OTHER_MODEL);
  });
});

describe('Gemini CLI', () => {
  const reply = (id: string, o: Record<string, unknown> = {}) => ({
    id, timestamp: at(0), type: 'gemini', content: '…', model: 'gemini-3.1-pro-preview',
    tokens: { input: 1000, output: 50, cached: 800, thoughts: 30, tool: 5, total: 1085 }, ...o,
  });
  it('reads a reply’s tokens: cached out of the prompt, thoughts as output, tool prompts as input', () => {
    expect(parseGeminiLine(JSON.stringify(reply('m1')), true)).toMatchObject({ key: 'gemini:m1', input: 205, cacheRead: 800, output: 80, cacheWrite: 0, bot: true });
  });
  it('reads a whole .json chat and skips user messages and replies without tokens', () => {
    const file = JSON.stringify({ sessionId: 's', messages: [{ id: 'u1', type: 'user', timestamp: at(0), content: [] }, reply('m1'), reply('m2', { tokens: undefined })] });
    expect(parseGeminiFile(file).map((r) => r.key)).toEqual(['gemini:m1']);
    expect(parseGeminiLine(JSON.stringify({ $set: { lastUpdated: at(0) } }))).toBeNull();
  });
});

describe('parseCopilotRow', () => {
  const row = { id: 7, model: 'gpt-5.3-codex', input_tokens: 2000, output_tokens: 60, cache_read_tokens: 1500, cache_write_tokens: 0, created_at: at(0), cwd: '/bots/appu' };
  it('takes the cached tokens out of the input, preferring the row’s own split', () => {
    expect(parseCopilotRow(row, '/bots')).toMatchObject({ key: 'copilot:7', input: 500, cacheRead: 1500, output: 60, bot: true });
    const details = JSON.stringify([{ tokenType: 'input', tokenCount: 480 }, { tokenType: 'cache_read', tokenCount: 1500 }]);
    expect(parseCopilotRow({ ...row, token_details_json: details })?.input).toBe(480);
  });
  it('reads SQLite’s own UTC times', () => {
    expect(parseCopilotRow({ ...row, created_at: '2026-10-28 09:00:00' })?.ts).toBe(Date.UTC(2026, 9, 28, 9));
  });
});

describe('models of the other agents', () => {
  it('finds Bedrock ids under the model’s own', () => {
    expect(normalizeModel('anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('claude-sonnet-4-5');
    expect(normalizeModel('us.anthropic.claude-opus-4-6-v1')).toBe('claude-opus-4-6');
    expect(normalizeModel('openai.gpt-oss-120b-1:0')).toBe('gpt-oss-120b');
    expect(normalizeModel('deepseek-v4')).toBe('deepseek-v4');
    expect(priceOf('amazon-bedrock/openai.gpt-5.5')).toBeDefined();
  });
  it('names Gemini and Grok models', () => {
    expect(modelName('gemini-3.1-pro-preview')).toBe('Gemini 3.1 Pro Preview');
    expect(modelName('grok-4.7-build-fast')).toBe('Grok 4.7 Build Fast');
    expect(modelName('z-ai/glm-5.1')).toBe('glm-5.1');
  });
  it('takes an agent’s own cost over the table, and counts its model calls', () => {
    const r: UsageRecord = { ts: NOW - 1000, model: 'grok-4.7-build', input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, bot: false, costUsd: 0.5, requests: 3 };
    expect(costOf(r)).toBe(0.5);
    expect(costOf({ ...r, model: 'gemini-2.5-pro', costUsd: undefined })).toBeCloseTo(0.00125, 9);
    const s = summarize([{ id: 'grok', name: 'Grok', records: [r] }], 'today', NOW);
    expect(s.totals).toMatchObject({ requests: 3, costUsd: 0.5, unpricedTokens: 0 });
    expect(s.models[0]).toMatchObject({ name: 'Grok 4.7 Build', priced: true });
  });
});

describe('SQLite readers', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'appubot-usage-db-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads OpenCode’s both tables once per message while it writes (WAL), and its older JSON files', async () => {
    const root = join(dir, 'opencode');
    mkdirSync(root);
    const path = join(root, 'opencode.db');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
    db.exec('CREATE TABLE session_v2 (id TEXT, directory TEXT)');
    db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');
    db.exec('CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, time_created INTEGER, data TEXT)');
    db.prepare('INSERT INTO session_v2 VALUES (?, ?)').run('ses_1', '/bots/appu');
    const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 130; i++) insert.run(`msg_${i}`, 'ses_1', NOW - 1000, openCodeMessage({ id: `msg_${i}` }));
    insert.run('old', 'ses_1', NOW - 40 * 86_400_000, openCodeMessage({ id: 'old', time: { created: NOW - 40 * 86_400_000 } }));
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)').run('msg_0', 'ses_1', 'assistant', NOW - 1000, openCodeMessage({ id: 'msg_0' }));
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)').run('u1', 'ses_1', 'user', NOW - 1000, '{"role":"user"}');
    // the writer stays open, its rows only in the WAL
    const recs = await readOpenCodeDb(path, NOW - 86_400_000, '/bots');
    db.close();
    expect(recs).toHaveLength(131);
    const s = summarize([{ id: 'opencode', name: 'OpenCode', records: recs }], 'today', NOW);
    expect(s.totals.requests).toBe(130);
    expect(recs.every((r) => r.bot)).toBe(true);

    const legacy = join(root, 'storage', 'message', 'ses_1');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'msg_old_store.json'), openCodeMessage({ id: undefined }));
    expect((await readOpenCodeLegacy(root, NOW - 86_400_000)).map((r) => r.key)).toEqual(['opencode:msg_old_store']);
  });

  it('reads Copilot’s model requests with their session’s folder', async () => {
    const path = join(dir, 'session-store.db');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT)');
    db.exec('CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, created_at TEXT)');
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run('c1', '/bots/appu');
    const insert = db.prepare('INSERT INTO assistant_usage_events (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run('c1', 'gpt-5.3-codex', 2000, 60, 1500, 0, at(0));
    insert.run('c2', 'gpt-5.4-mini', 100, 10, 0, 0, at(40));
    db.close();
    const recs = await readCopilotDb(path, NOW - 31 * 86_400_000, '/bots');
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ key: 'copilot:1', model: 'gpt-5.3-codex', input: 500, bot: true });
  });
});

describe('UsageService with every agent', () => {
  let root: string;
  let service: UsageService;
  const bots = '/Users/me/AppuBot';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'appubot-usage-all-'));
    const home = join(root, 'home');
    const grokDir = join(home, '.grok', 'sessions', encodeURIComponent(`${bots}/appu`), 'sess-1');
    const geminiChats = join(home, '.gemini', 'tmp', 'appu', 'chats');
    const piDir = join(home, '.pi', 'agent', 'sessions', '--Users-me-code--');
    const openCodeDir = join(home, '.local', 'share', 'opencode');
    const copilotDir = join(home, '.copilot');
    for (const d of [grokDir, geminiChats, piDir, openCodeDir, copilotDir]) mkdirSync(d, { recursive: true });
    writeFileSync(join(grokDir, 'updates.jsonl'), `${grokLine({ ms: NOW - 1000 })}\n`);
    // other files of a Grok session are never read
    writeFileSync(join(grokDir, 'events.jsonl'), `${grokLine({ prompt: 'p2', ms: NOW - 1000 })}\n`);
    writeFileSync(join(home, '.gemini', 'tmp', 'appu', '.project_root'), `${bots}/appu\n`);
    const gem = { id: 'g1', timestamp: at(0), type: 'gemini', model: 'gemini-3-flash-preview', tokens: { input: 100, output: 10, cached: 0, thoughts: 0, tool: 0, total: 110 } };
    writeFileSync(join(geminiChats, 'session-a.json'), JSON.stringify({ sessionId: 'a', messages: [gem] }, null, 2));
    writeFileSync(join(geminiChats, 'session-b.jsonl'), [JSON.stringify({ sessionId: 'b', kind: 'main' }), JSON.stringify({ ...gem, id: 'g2', tokens: undefined }), JSON.stringify({ ...gem, id: 'g2' })].join('\n') + '\n');
    writeFileSync(join(piDir, 's.jsonl'), [
      JSON.stringify({ type: 'session', id: 'pi1', cwd: '/Users/me/code', timestamp: at(0) }),
      JSON.stringify({ type: 'message', id: 'e1', timestamp: at(0), message: { role: 'assistant', provider: 'openai', model: 'gpt-5.5', usage: { input: 10, output: 5 } } }),
    ].join('\n') + '\n');
    const oc = new DatabaseSync(join(openCodeDir, 'opencode.db'));
    oc.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');
    oc.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('msg_a', 's', NOW - 1000, openCodeMessage());
    oc.close();
    const cp = new DatabaseSync(join(copilotDir, 'session-store.db'));
    cp.exec('CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, created_at TEXT)');
    cp.prepare('INSERT INTO assistant_usage_events VALUES (1, ?, ?, ?, ?, ?, ?, ?)').run('s', 'gpt-5.3-codex', 100, 10, 0, 0, at(0));
    cp.close();
    const ctx = {
      deps: { homeDir: home }, paths: { botsRoot: bots }, log: silentLogger,
      s: { providers: { list: () => [{ id: 'copilot', name: 'GitHub Copilot' }] } },
    } as unknown as CoreCtx;
    service = new UsageService(ctx);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reads Grok, OpenCode, Copilot, Gemini CLI and Pi into one summary', async () => {
    const s = await service.summary('30d', 'all', NOW);
    expect(s.sources.map((x) => x.name)).toEqual(['Grok', 'OpenCode', 'GitHub Copilot', 'Gemini CLI', 'Pi']);
    expect(Object.fromEntries(s.agents.map((a) => [a.id, a.requests]))).toEqual({ grok: 3, opencode: 1, copilot: 1, gemini: 2, pi: 1 });
    // Grok's session folder and Gemini's project are in the bots' folder
    expect(s.byBots.tokens).toBe(2100 + 220);
    // read again unchanged: the same
    expect((await service.summary('30d', 'all', NOW)).totals).toEqual(s.totals);
  });
});
