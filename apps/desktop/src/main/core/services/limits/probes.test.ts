import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSqlite } from '../usageSqlite';
import {
  CURSOR_API_ENDPOINT, KIMI_CODE_BASE_URL, OPENCODE_GO_USAGE_URL, cursorAuthFile, cursorUsage, kimiManagedProvider, kimiUsage, kimiUsageUrl, openCodeConsoleKey, openCodeGoUsage, openCodeKeys,
} from './probes';

/** a fetch that answers by URL and notes what it was asked, never the network */
function fakeFetch(answer: (url: string, init?: RequestInit) => { status: number; body?: unknown } | undefined) {
  const asked: { url: string; auth?: string; method?: string }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    asked.push({ url, auth: headers.get('authorization') ?? undefined, method: init?.method });
    const a = answer(url, init);
    if (!a) throw new Error(`unexpected request ${url}`);
    return new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: f, asked };
}

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'appubot-probes-')); });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const home = (name: string): string => { const h = join(root, name); mkdirSync(h, { recursive: true }); return h; };

describe('Cursor', () => {
  it('keeps its sign-in where the CLI does on each OS', () => {
    expect(cursorAuthFile({}, '/h', 'darwin')).toBe('/h/.cursor/auth.json');
    expect(cursorAuthFile({ XDG_CONFIG_HOME: '/x' }, '/h', 'linux')).toBe('/x/cursor/auth.json');
    expect(cursorAuthFile({}, '/h', 'linux')).toBe('/h/.config/cursor/auth.json');
    expect(cursorAuthFile({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a', 'win32')).toBe('C:\\Users\\a\\AppData\\Roaming\\Cursor\\auth.json');
  });

  it('asks the dashboard with the file’s token, says none without one and refused on a 401', async () => {
    const h = home('cursor');
    const usage = { billingCycleStart: '1', billingCycleEnd: '2', planUsage: { totalPercentUsed: 7 } };
    const plan = { planInfo: { planName: 'Premium' }, isMerged: true };
    const { fetch, asked } = fakeFetch((url) => (url.endsWith('/GetCurrentPeriodUsage') ? { status: 200, body: usage } : url.endsWith('/GetPlanInfo') ? { status: 200, body: plan } : undefined));
    const env = { XDG_CONFIG_HOME: join(h, 'config') };
    expect(await cursorUsage({ env, homeDir: h, fetch, platform: 'linux' })).toEqual({ ok: false, reason: 'none' });
    mkdirSync(join(h, 'config', 'cursor'), { recursive: true });
    writeFileSync(join(h, 'config', 'cursor', 'auth.json'), JSON.stringify({ accessToken: 'tok-1', refreshToken: 'r' }));
    expect(await cursorUsage({ env, homeDir: h, fetch, platform: 'linux' })).toEqual({ ok: true, value: { usage, planInfo: plan } });
    expect(asked.map((a) => [a.url, a.auth, a.method])).toEqual([
      [`${CURSOR_API_ENDPOINT}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, 'Bearer tok-1', 'POST'],
      [`${CURSOR_API_ENDPOINT}/aiserver.v1.DashboardService/GetPlanInfo`, 'Bearer tok-1', 'POST'],
    ]);
    // the CLI's own endpoint override moves the read too; a refused token is said, not thrown
    const refused = fakeFetch(() => ({ status: 401, body: { code: 'unauthenticated' } }));
    expect(await cursorUsage({ env: { ...env, CURSOR_API_ENDPOINT: 'https://api.example.test/' }, homeDir: h, fetch: refused.fetch, platform: 'linux' })).toEqual({ ok: false, reason: 'refused' });
    expect(refused.asked[0]!.url).toBe('https://api.example.test/aiserver.v1.DashboardService/GetCurrentPeriodUsage');
    // a plan info that fails keeps the usage (read as split)
    const noPlan = fakeFetch((url) => (url.endsWith('/GetCurrentPeriodUsage') ? { status: 200, body: usage } : { status: 500 }));
    expect(await cursorUsage({ env, homeDir: h, fetch: noPlan.fetch, platform: 'linux' })).toEqual({ ok: true, value: { usage, planInfo: null } });
  });
});

describe('Kimi', () => {
  it('reads the managed provider from config.toml in both spellings', () => {
    expect(kimiManagedProvider('[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.ai/coding/v1"\noauth = { key = "oauth/kimi-code" }\n')).toEqual({ baseUrl: 'https://api.kimi.ai/coding/v1', key: 'oauth/kimi-code' });
    expect(kimiManagedProvider("[providers.'managed:kimi-code']\nbase_url = 'https://api.kimi.com/coding/v1'\n[providers.'managed:kimi-code'.oauth]\nkey = 'oauth/kimi-code'\n")).toEqual({ baseUrl: 'https://api.kimi.com/coding/v1', key: 'oauth/kimi-code' });
    expect(kimiManagedProvider('[providers."other"]\nbase_url = "https://x"\n')).toEqual({});
  });

  it('asks only Kimi’s API over https', () => {
    expect(kimiUsageUrl(KIMI_CODE_BASE_URL)).toBe('https://api.kimi.com/coding/v1/usages');
    expect(kimiUsageUrl('https://api.kimi.ai/coding/v1/')).toBe('https://api.kimi.ai/coding/v1/usages');
    expect(kimiUsageUrl('http://api.kimi.com/coding/v1')).toBeUndefined();
    expect(kimiUsageUrl('https://u:p@api.kimi.com/coding/v1')).toBeUndefined();
    expect(kimiUsageUrl('not a url')).toBeUndefined();
  });

  it('sends the CLI’s token from either home, says none without a sign-in and refused on a 401', async () => {
    const h = home('kimi');
    const answer = { usages: { limit_5h: { used_ratio: 0.2 }, limit_7d: { used_ratio: 0.1 } } };
    const { fetch, asked } = fakeFetch((url) => (url === 'https://api.kimi.com/coding/v1/usages' ? { status: 200, body: answer } : undefined));
    expect(await kimiUsage({ env: {}, homeDir: h, fetch })).toEqual({ ok: false, reason: 'none' });
    // Kimi Code 2.x
    const code = join(h, '.kimi-code');
    mkdirSync(join(code, 'credentials'), { recursive: true });
    writeFileSync(join(code, 'config.toml'), '[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.com/coding/v1"\noauth = { key = "oauth/kimi-code" }\n');
    expect(await kimiUsage({ env: {}, homeDir: h, fetch })).toEqual({ ok: false, reason: 'none' });
    writeFileSync(join(code, 'credentials', 'kimi-code.json'), JSON.stringify({ access_token: 'tok-k', expires_at: Math.floor(Date.now() / 1000) + 600 }));
    expect(await kimiUsage({ env: {}, homeDir: h, fetch })).toEqual({ ok: true, value: answer });
    expect(asked).toEqual([{ url: 'https://api.kimi.com/coding/v1/usages', auth: 'Bearer tok-k', method: undefined }]);
    // an expired token fails the read (the service keeps the last numbers) rather than asking with it
    writeFileSync(join(code, 'credentials', 'kimi-code.json'), JSON.stringify({ access_token: 'tok-k', expires_at: 1 }));
    await expect(kimiUsage({ env: {}, homeDir: h, fetch })).rejects.toThrow(/expired/);
    // the Python CLI's home, with the key in its own section, and a key file name that stays under credentials/
    const py = join(h, 'py');
    mkdirSync(join(py, 'credentials'), { recursive: true });
    writeFileSync(join(py, 'config.toml'), '[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.com/coding/v1"\n[providers."managed:kimi-code".oauth]\nkey = "oauth/../etc"\n');
    expect(await kimiUsage({ env: { KIMI_CODE_HOME: join(h, 'none'), KIMI_SHARE_DIR: py }, homeDir: h, fetch })).toEqual({ ok: false, reason: 'none' });
    writeFileSync(join(py, 'config.toml'), '[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.com/coding/v1"\n[providers."managed:kimi-code".oauth]\nkey = "oauth/kimi-code"\n');
    writeFileSync(join(py, 'credentials', 'kimi-code.json'), JSON.stringify({ access_token: 'tok-py' }));
    const refused = fakeFetch(() => ({ status: 401 }));
    expect(await kimiUsage({ env: { KIMI_CODE_HOME: join(h, 'none'), KIMI_SHARE_DIR: py }, homeDir: h, fetch: refused.fetch })).toEqual({ ok: false, reason: 'refused' });
    expect(refused.asked[0]!.auth).toBe('Bearer tok-py');
  });
});

describe('OpenCode', () => {
  it('sends the Console connection’s key first, then the Go key, moving on when one is refused', async () => {
    const sqlite = loadSqlite();
    if (!sqlite) return;
    const h = home('opencode');
    const data = join(h, 'data');
    mkdirSync(data, { recursive: true });
    const db = new sqlite.DatabaseSync(join(data, 'opencode.db'));
    db.exec('CREATE TABLE credential (id text PRIMARY KEY, integration_id text, label text NOT NULL, value text NOT NULL, connector_id text, method_id text, active integer, time_created integer NOT NULL, time_updated integer NOT NULL)');
    const ins = db.prepare('INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)');
    ins.run('a', 'opencode', 'old', JSON.stringify({ type: 'key', key: 'console-old', metadata: { server: 'https://opencode.ai/console' } }), 0, 1, 1);
    ins.run('b', 'opencode', 'console', JSON.stringify({ type: 'key', key: 'console-key', metadata: { server: 'https://opencode.ai/console/' } }), 1, 2, 2);
    ins.run('c', 'github-copilot', 'gh', JSON.stringify({ type: 'oauth', access: 'x' }), 1, 3, 3);
    db.close();
    const env = { OPENCODE_DATA_DIR: data };
    expect(openCodeConsoleKey(env, h)).toBe('console-key');
    // a self-hosted console isn't opencode.ai's
    const db2 = new sqlite.DatabaseSync(join(data, 'opencode.db'));
    db2.prepare("UPDATE credential SET value = ? WHERE id = 'b'").run(JSON.stringify({ type: 'key', key: 'console-key', metadata: { server: 'https://console.example.test' } }));
    db2.close();
    expect(openCodeConsoleKey(env, h)).toBeUndefined();
    const db3 = new sqlite.DatabaseSync(join(data, 'opencode.db'));
    db3.prepare("UPDATE credential SET value = ? WHERE id = 'b'").run(JSON.stringify({ type: 'key', key: 'console-key' }));
    db3.close();
    writeFileSync(join(data, 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'go-key' } }));
    expect(await openCodeKeys(env, h)).toEqual(['console-key', 'go-key']);
    expect(await openCodeKeys({ ...env, OPENCODE_API_KEY: 'env-key' }, h)).toEqual(['console-key', 'go-key', 'env-key']);
    expect(openCodeConsoleKey({ ...env, OPENCODE_DB: ':memory:' }, h)).toBeUndefined();
    expect(openCodeConsoleKey({ ...env, OPENCODE_AUTH_CONTENT: '{}' }, h)).toBeUndefined();
    const { fetch, asked } = fakeFetch((_url, init) => (new Headers(init?.headers).get('authorization') === 'Bearer go-key' ? { status: 200, body: { used: 1 } } : { status: 401, body: { error: 'nope' } }));
    expect(await openCodeGoUsage({ env, homeDir: h, fetch })).toEqual({ status: 200, body: { used: 1 } });
    expect(asked.map((a) => [a.url, a.auth])).toEqual([[OPENCODE_GO_USAGE_URL, 'Bearer console-key'], [OPENCODE_GO_USAGE_URL, 'Bearer go-key']]);
    // no key anywhere: nothing asked
    expect(await openCodeGoUsage({ env: { OPENCODE_DATA_DIR: join(h, 'empty') }, homeDir: join(h, 'nohome'), fetch })).toBeNull();
  });
});
