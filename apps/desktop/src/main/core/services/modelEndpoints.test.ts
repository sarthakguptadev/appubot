/**
 * Custom models: model servers handed to OpenCode as providers of its own. The server is asked for its models, the
 * endpoint (and its key) is kept in a file only this user reads, and OpenCode gets them in its inline config.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { cleanBaseUrl, modelIds, openCodeConfig, providerKeyFor } from './modelEndpoints';

let root: string;
const cores: Core[] = [];
const asked: { url: string; auth?: string }[] = [];

/** Ollama on :11434 (OpenAI API under /v1 only), a hosted server that wants a key */
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
  asked.push({ url, auth });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url === 'http://127.0.0.1:11434/v1/models') return json({ data: [{ id: 'qwen3-coder:30b' }, { id: 'nomic-embed-text' }, { id: 'gemma3:12b' }] });
  if (url.startsWith('http://127.0.0.1:11434')) return json({ error: 'not found' }, 404);
  if (url === 'https://api.example.com/v1/models') return auth === 'Bearer sk-good' ? json({ data: [{ id: 'big-model' }] }) : json({ error: 'no' }, 401);
  throw new TypeError('fetch failed');
}) as typeof fetch;

async function start(): Promise<{ core: Core; runtime: FakeRuntime }> {
  let runtime!: FakeRuntime;
  const core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => { runtime = new FakeRuntime(hooks); return runtime; },
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined, fetch: fakeFetch,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, quiet: true,
  });
  await core.start();
  cores.push(core);
  return { core, runtime };
}

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'appubot-endpoints-')); });
afterAll(async () => {
  for (const c of cores) await c.stop().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe('model endpoint helpers', () => {
  it('cleans addresses and refuses what is not one', () => {
    expect(cleanBaseUrl(' http://127.0.0.1:11434/v1/ ')).toBe('http://127.0.0.1:11434/v1');
    expect(() => cleanBaseUrl('localhost')).toThrow(/address/);
    expect(() => cleanBaseUrl('ftp://x/v1')).toThrow(/http/);
  });

  it('reads chat models from a /models answer', () => {
    expect(modelIds({ data: [{ id: 'b' }, { id: 'a' }, { id: 'text-embedding-3' }, { id: 'a' }] })).toEqual(['a', 'b']);
    expect(modelIds({ nope: 1 })).toEqual([]);
  });

  it('names endpoints for OpenCode clear of its own providers and each other', () => {
    expect(providerKeyFor({ kind: 'ollama', name: 'Ollama' }, new Set())).toBe('ollama');
    expect(providerKeyFor({ kind: 'ollama', name: 'Ollama' }, new Set(['ollama']))).toBe('ollama-2');
    expect(providerKeyFor({ kind: 'openai', name: 'OpenAI' }, new Set())).toBe('openai-custom');
    expect(providerKeyFor({ kind: 'openai', name: 'My Box' }, new Set())).toBe('my-box');
  });

  it("writes OpenCode's provider config", () => {
    expect(openCodeConfig([])).toBeUndefined();
    const config = JSON.parse(openCodeConfig([{ id: 'e', kind: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['m1'], providerKey: 'ollama', createdAt: 1, apiKey: 'k' }])!);
    expect(config.provider.ollama).toEqual({
      npm: '@ai-sdk/openai-compatible', name: 'Ollama', options: { baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'k' }, models: { m1: { name: 'm1' } },
    });
  });
});

describe('model endpoints', () => {
  it('finds models, saves endpoints for this user only and hands them to OpenCode', async () => {
    const { core, runtime } = await start();
    const s = core.services;
    await s.providers.upsert({ id: 'opencode', name: 'OpenCode', command: 'fake-opencode', args: ['acp'], env: {} });
    runtime.logins.set('opencode', 'logged_out');
    await s.providers.refresh(['opencode']);
    // with nothing signed in OpenCode is ready all the same: its free models need no account (`freeModels.ts`)
    expect(s.providers.list().find((p) => p.id === 'opencode')!.auth).toMatchObject({ state: 'logged_in', account: 'Free models' });

    // an address without /v1 is tried again with it
    const found = await s.endpoints.probe({ baseUrl: 'http://127.0.0.1:11434' });
    expect(found).toEqual({ ok: true, models: ['gemma3:12b', 'qwen3-coder:30b'], baseUrl: 'http://127.0.0.1:11434/v1' });
    expect((await s.endpoints.probe({ baseUrl: 'http://127.0.0.1:9/v1' })).error).toMatch(/running/);
    expect((await s.endpoints.probe({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-bad' })).error).toMatch(/API key/);

    const ollama = await s.endpoints.save({ kind: 'ollama', name: 'Ollama', baseUrl: found.baseUrl, models: found.models });
    const hosted = await s.endpoints.save({ kind: 'openai', name: 'Example', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-good', models: ['big-model'] });
    expect(hosted.keySaved).toBe(true);
    expect(JSON.stringify(s.endpoints.list())).not.toContain('sk-good');

    // a saved endpoint's key is used when none is given
    expect((await s.endpoints.probe({ id: hosted.id, baseUrl: hosted.baseUrl })).ok).toBe(true);

    const file = join(root, 'data', 'model-endpoints.json');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain('sk-good');

    const env = runtime.hooks.secretEnv?.('opencode');
    const config = JSON.parse(env!.OPENCODE_CONFIG_CONTENT!);
    expect(Object.keys(config.provider)).toEqual(['ollama', 'example']);
    expect(config.provider.example.options.apiKey).toBe('sk-good');
    // other agents never get them
    expect(runtime.hooks.secretEnv?.('claude-code')?.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    // signed out of every hosted provider, OpenCode can still run on them
    const oc = s.providers.list().find((p) => p.id === 'opencode')!;
    expect(oc.authStatus).toBe('authenticated');
    expect(oc.auth?.account).toBe('Ollama, Example, Free models');

    // editing keeps its OpenCode name and key; '' forgets the key
    const renamed = await s.endpoints.save({ id: hosted.id, kind: 'openai', name: 'Renamed', baseUrl: hosted.baseUrl, models: ['big-model'] });
    expect(renamed).toMatchObject({ providerKey: 'example', keySaved: true });
    expect((await s.endpoints.save({ id: hosted.id, kind: 'openai', name: 'Renamed', baseUrl: hosted.baseUrl, models: ['big-model'], apiKey: '' })).keySaved).toBe(false);

    await s.endpoints.delete(ollama.id);
    await s.endpoints.delete(hosted.id);
    expect(runtime.hooks.secretEnv?.('opencode')).toBeUndefined();
    expect(s.providers.list().find((p) => p.id === 'opencode')!.auth?.account).toBe('Free models');
    await expect(s.endpoints.delete('nope')).rejects.toThrow(/not found/);
  });
});
