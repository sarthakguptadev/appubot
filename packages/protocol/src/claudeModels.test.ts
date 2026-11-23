import { describe, expect, it, test } from 'vitest';
import assert from 'node:assert/strict';
import { CLAUDE_MODEL_CATALOG, creditModelAllowed, modelDisplayName, tidyModels } from './index';

test("Claude Code's list comes out in Synara's order: Default, then Fable, Opus, Sonnet, Haiku, newest first", () => {
  // as Claude Code reports it with the catalog: its own rows first, the catalog's after
  const reported = [
    ['default', 'Default (recommended)'], ['sonnet', 'Sonnet 5.5'], ['fable', 'Fable 5.1'], ['opus', 'Opus 5.5'], ['haiku', 'Haiku 5.5'],
    ['claude-fable-5', 'Fable 5'], ['claude-opus-5', 'Opus 5'], ['claude-opus-4-8', 'Opus 4.8'], ['claude-opus-4-7', 'Opus 4.7'],
    ['claude-opus-4-6', 'Opus 4.6'], ['claude-opus-4-5', 'Opus 4.5'], ['claude-sonnet-5', 'Sonnet 5'], ['claude-sonnet-4-6', 'Sonnet 4.6'],
    ['claude-haiku-4-5', 'Haiku 4.5'],
  ].map(([id, name]) => ({ id: id!, name: name! }));
  assert.deepEqual(tidyModels(reported).map((m) => m.name), [
    'Default (recommended)', 'Fable 5.1', 'Fable 5', 'Opus 5.5', 'Opus 5', 'Opus 4.8', 'Opus 4.7', 'Opus 4.6', 'Opus 4.5',
    'Sonnet 5.5', 'Sonnet 5', 'Sonnet 4.6', 'Haiku 5.5', 'Haiku 4.5',
  ]);
});

test('a row left unnamed gets a name; other agents are untouched', () => {
  assert.deepEqual(tidyModels([{ id: 'claude-opus-4-6', name: 'claude-opus-4-6' }]).map((m) => m.name), ['Opus 4.6']);
  const codex = [{ id: 'gpt-5.2', name: 'gpt-5.2' }, { id: 'gpt-5.5', name: 'GPT-5.5' }];
  assert.deepEqual(tidyModels(codex), codex);
});

test("the catalog is Synara's: Fable 5.1 down to Haiku 4.5", () => {
  assert.deepEqual(CLAUDE_MODEL_CATALOG.map((r) => r.model), [
    'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7',
    'claude-opus-4-6', 'claude-opus-4-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5',
  ]);
});

describe('modelDisplayName', () => {
  it('names catalog ids, raw Claude ids and aliases', () => {
    expect(modelDisplayName('claude-sonnet-5')).toBe('Sonnet 5');
    expect(modelDisplayName('claude-haiku-5-5')).toBe('Haiku 5.5');
    expect(modelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelDisplayName('claude-opus-4-6[1m]')).toBe('Opus 4.6 (1M)');
    expect(modelDisplayName('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('Sonnet 4.5');
    expect(modelDisplayName('claude-opus-4-1@20250805')).toBe('Opus 4.1');
    expect(modelDisplayName('sonnet')).toBe('Sonnet');
    expect(modelDisplayName('opus[1m]')).toBe('Opus (1M)');
    expect(modelDisplayName('default')).toBe('Default');
  });
  it('leaves other agents\' ids alone', () => {
    expect(modelDisplayName('gpt-5.5')).toBe('gpt-5.5');
    expect(modelDisplayName('qwen2.5-coder:32b')).toBe('qwen2.5-coder:32b');
    expect(modelDisplayName('claude-nova-1')).toBe('claude-nova-1');
  });
});

describe('creditModelAllowed (the launch bonus: Sonnet and Haiku only)', () => {
  it('takes Sonnet and Haiku by id, alias, date, context suffix or prefix', () => {
    for (const m of ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-sonnet-5-5[1m]', 'sonnet', 'haiku', 'sonnet[1m]', 'SONNET', 'us.anthropic.claude-sonnet-5-5-v1:0', 'claude-haiku-4-5@20251001']) {
      expect(creditModelAllowed(m), m).toBe(true);
    }
  });
  it('refuses Fable, Opus, Claude Code’s other aliases and anything else', () => {
    for (const m of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-4-8[1m]', 'opus', 'fable', 'opusplan', 'default', '', null, undefined, 'gpt-5', 'claude-sonnetx', 'sonnet-pretend', 'claude-opus-5-5-sonnet']) {
      expect(creditModelAllowed(m as string), String(m)).toBe(false);
    }
  });
});
