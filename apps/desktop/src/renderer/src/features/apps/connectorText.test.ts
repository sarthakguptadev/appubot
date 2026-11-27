import { describe, expect, it } from 'vitest';
import type { Connector } from '@appubot/protocol';
import { connectorSummary, joinArgs, splitArgs } from './connectorText';

describe('a local server’s arguments on one line', () => {
  it('splits at spaces and keeps quoted ones whole', () => {
    expect(splitArgs('-y @modelcontextprotocol/server-filesystem "/Users/me/My Files"  --flag')).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/Users/me/My Files', '--flag']);
    expect(splitArgs("--name 'it\"s' \"\"")).toEqual(['--name', 'it"s', '']);
    expect(splitArgs('   ')).toEqual([]);
  });
  it('joins them back so they split the same', () => {
    for (const args of [['-y', 'pkg'], ['a b', 'c'], ['say "hi"'], ['']]) expect(splitArgs(joinArgs(args))).toEqual(args);
  });
});

describe('a connector’s line in the list', () => {
  const base: Connector = { id: 'c', name: 'X', transport: 'http', args: [], headers: [], env: [], bots: 'all', status: 'connected', tools: [{ name: 'a', on: true }, { name: 'b', on: false }], createdAt: 1 };
  it('says how it is doing, its tools and its bots', () => {
    expect(connectorSummary(base, 3)).toBe('Connected · 1 of 2 tools on · All bots');
    expect(connectorSummary({ ...base, tools: [{ name: 'a', on: true }], bots: ['b1'] }, 3)).toBe('Connected · 1 tool · 1 of 3 bots');
    expect(connectorSummary({ ...base, bots: [] }, 3)).toContain('No bots');
    expect(connectorSummary({ ...base, status: 'error', error: 'Nothing answered at x.' }, 3)).toBe('Nothing answered at x.');
    expect(connectorSummary({ ...base, status: 'signIn' }, 3)).toBe('Sign in to use it');
  });
});
