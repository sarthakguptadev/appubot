/**
 * Custom models (Settings › Agents › Add custom › Models): model servers handed to OpenCode as providers of its own.
 * Ollama, LM Studio and any other server with the OpenAI chat API, all through OpenCode's `@ai-sdk/openai-compatible`
 * provider, in an inline config (`OPENCODE_CONFIG_CONTENT`, which OpenCode merges over the user's own config) given
 * to every OpenCode start with the saved keys (`ProvidersService.secretEnv`). Endpoints and their keys live in
 * `<dataDir>/model-endpoints.json` (0600); the wire only says whether a key is saved.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId, providerBase, slugify, type MethodParams, type MethodResult, type ModelEndpoint } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { errMsg, notFound, RpcError } from '../util';

interface StoredEndpoint extends Omit<ModelEndpoint, 'keySaved'> {
  apiKey?: string;
}

const FILE = 'model-endpoints.json';
const PROBE_TIMEOUT_MS = 6000;
/** OpenCode's own provider ids, which a custom endpoint must not replace */
const OPENCODE_PROVIDERS = new Set([
  'openai', 'anthropic', 'google', 'google-vertex', 'openrouter', 'groq', 'xai', 'mistral', 'deepseek', 'github-copilot',
  'opencode', 'amazon-bedrock', 'azure', 'vercel', 'togetherai', 'fireworks-ai', 'cerebras', 'huggingface', 'zai',
]);

/** `http(s)://host[:port]/path` without a trailing slash, else an error worded for people. */
export function cleanBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new RpcError('invalid_params', 'Enter the server’s address, like http://127.0.0.1:11434/v1.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RpcError('invalid_params', 'The address should start with http:// or https://.');
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

/** The chat models in an OpenAI `/models` answer (`data[].id`), embedding models left out, sorted. */
export function modelIds(body: unknown): string[] {
  const data = (body as { data?: unknown })?.data ?? (body as { models?: unknown })?.models;
  if (!Array.isArray(data)) return [];
  const ids = data
    .map((m) => (typeof m === 'string' ? m : typeof m?.id === 'string' ? m.id : typeof m?.name === 'string' ? m.name : ''))
    .filter((id) => id && !/embed/i.test(id));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** What OpenCode calls an endpoint: `ollama`, `lmstudio`, else its name as a slug, kept clear of OpenCode's own and the others. */
export function providerKeyFor(e: Pick<ModelEndpoint, 'kind' | 'name'>, taken: Set<string>): string {
  const base = e.kind === 'openai' ? (slugify(e.name) || 'custom') : e.kind;
  let key = OPENCODE_PROVIDERS.has(base) ? `${base}-custom` : base;
  for (let n = 2; taken.has(key); n++) key = `${OPENCODE_PROVIDERS.has(base) ? `${base}-custom` : base}-${n}`;
  return key;
}

/** OpenCode's config for these endpoints (`provider` entries), as `OPENCODE_CONFIG_CONTENT` carries it. */
export function openCodeConfig(endpoints: StoredEndpoint[]): string | undefined {
  if (!endpoints.length) return undefined;
  const provider = Object.fromEntries(endpoints.map((e) => [e.providerKey, {
    npm: '@ai-sdk/openai-compatible',
    name: e.name,
    options: { baseURL: e.baseUrl, ...(e.apiKey ? { apiKey: e.apiKey } : {}) },
    models: Object.fromEntries(e.models.map((m) => [m, { name: m }])),
  }]));
  return JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider });
}

export class ModelEndpointsService {
  private items: StoredEndpoint[] | null = null;

  constructor(private ctx: CoreCtx) {}

  list(): ModelEndpoint[] {
    return this.read().map(({ apiKey, ...e }) => ({ ...e, keySaved: !!apiKey }));
  }

  /** The environment OpenCode starts with: its inline config for the endpoints (none: nothing). */
  openCodeEnv(): Record<string, string> | undefined {
    const config = openCodeConfig(this.read());
    return config ? { OPENCODE_CONFIG_CONTENT: config } : undefined;
  }

  /** Ask the server for its models; an address without `/v1` that fails is tried again with it. */
  async probe(p: MethodParams<'endpoints.probe'>): Promise<MethodResult<'endpoints.probe'>> {
    const baseUrl = cleanBaseUrl(p.baseUrl);
    const apiKey = p.apiKey?.trim() || (p.id ? this.read().find((e) => e.id === p.id)?.apiKey : undefined);
    const first = await this.fetchModels(baseUrl, apiKey);
    if (!first.ok && !/\/v1$/.test(baseUrl)) {
      const again = await this.fetchModels(`${baseUrl}/v1`, apiKey);
      if (again.ok) return { ...again, baseUrl: `${baseUrl}/v1` };
    }
    return { ...first, baseUrl };
  }

  private async fetchModels(baseUrl: string, apiKey?: string): Promise<Omit<MethodResult<'endpoints.probe'>, 'baseUrl'>> {
    const f = this.ctx.deps.fetch ?? fetch;
    try {
      const res = await f(`${baseUrl}/models`, {
        headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) return { ok: false, models: [], error: 'The server refused: check the API key.' };
      if (!res.ok) return { ok: false, models: [], error: `The server answered ${res.status}. Check the address.` };
      const models = modelIds(await res.json());
      return models.length ? { ok: true, models } : { ok: false, models: [], error: 'The server lists no chat models yet.' };
    } catch (e) {
      const msg = errMsg(e);
      return { ok: false, models: [], error: /abort|timeout/i.test(msg) ? 'The server didn’t answer. Is it running?' : /ECONNREFUSED|fetch failed/i.test(msg) ? 'Nothing answers at that address. Is the server running?' : msg };
    }
  }

  async save(p: MethodParams<'endpoints.save'>): Promise<ModelEndpoint> {
    const all = this.read();
    const prev = p.id ? all.find((e) => e.id === p.id) : undefined;
    if (p.id && !prev) throw notFound('Endpoint', p.id);
    const baseUrl = cleanBaseUrl(p.baseUrl);
    const models = [...new Set(p.models.map((m) => m.trim()).filter(Boolean))];
    const apiKey = p.apiKey === undefined ? prev?.apiKey : p.apiKey.trim() || undefined;
    const others = all.filter((e) => e.id !== prev?.id);
    // the key OpenCode knows it by stays as it was (chats on its models keep them), unless the kind changed
    const providerKey = prev && prev.kind === p.kind ? prev.providerKey : providerKeyFor({ kind: p.kind, name: p.name }, new Set(others.map((e) => e.providerKey)));
    const next: StoredEndpoint = {
      id: prev?.id ?? newId('ep'), kind: p.kind, name: p.name.trim(), baseUrl, models, providerKey,
      createdAt: prev?.createdAt ?? Date.now(), ...(apiKey ? { apiKey } : {}),
    };
    this.write(prev ? all.map((e) => (e.id === prev.id ? next : e)) : [...all, next]);
    await this.changed();
    return this.list().find((e) => e.id === next.id)!;
  }

  async delete(id: string): Promise<{ ok: true }> {
    const all = this.read();
    if (!all.some((e) => e.id === id)) throw notFound('Endpoint', id);
    this.write(all.filter((e) => e.id !== id));
    await this.changed();
    return { ok: true };
  }

  /** OpenCode starts again with the new config: its chats at their next turn, its model list read again. */
  private async changed(): Promise<void> {
    const isOpenCode = (id: string) => providerBase(id) === 'opencode';
    this.ctx.s.chat.restartAgents(isOpenCode);
    for (const p of this.ctx.s.providers.list().filter((x) => isOpenCode(x.id))) this.ctx.s.providers.forgetChoices(p.id);
    await this.ctx.s.providers.refresh(this.ctx.s.providers.list().filter((x) => isOpenCode(x.id)).map((x) => x.id)).catch(() => undefined);
  }

  private read(): StoredEndpoint[] {
    if (this.items) return this.items;
    try {
      const raw = JSON.parse(readFileSync(join(this.ctx.paths.dataDir, FILE), 'utf8')) as unknown;
      this.items = Array.isArray(raw) ? (raw as StoredEndpoint[]) : [];
    } catch {
      this.items = [];
    }
    return this.items;
  }

  /** Written for this user only (0600): it holds API keys. */
  private write(items: StoredEndpoint[]): void {
    this.items = items;
    const file = join(this.ctx.paths.dataDir, FILE);
    try {
      mkdirSync(this.ctx.paths.dataDir, { recursive: true });
      writeFileSync(file, JSON.stringify(items, null, 2), { mode: 0o600 });
      chmodSync(file, 0o600);
    } catch (e) {
      throw new RpcError('internal', `Could not save the endpoint: ${errMsg(e)}`);
    }
  }
}
