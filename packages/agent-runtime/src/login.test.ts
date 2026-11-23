import { describe, expect, it } from 'vitest';
import {
  codexCustomProvider, codexLoginFromAuthFile, copilotLoginFromConfig, grokLoginFromAuthFile, maskEmail, parseClaudeAuthStatus,
  parseCodexLoginStatus, parseCursorStatus, ghUserFromHosts, parseOpenCodeAuthList, claudeSoftLoggedOut, type CliResult,
} from './login';
import { BUILTIN_PROVIDERS, NODE_COMMAND, RETIRED_PROVIDER_IDS, emptyStatus, mergeBuiltin, withLogin } from './providers';

const out = (stdout: string, code: number | null = 0, stderr = ''): CliResult => ({ stdout, stderr, code });
const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

describe('maskEmail', () => {
  it('keeps the first letter and the domain', () => {
    expect(maskEmail('Sarthak@Example.COM')).toBe('S***@example.com');
    expect(maskEmail(' a@b.co ')).toBe('a***@b.co');
  });
  it('ignores what is not an email', () => {
    expect(maskEmail('octocat')).toBeUndefined();
    expect(maskEmail(42)).toBeUndefined();
    expect(maskEmail('a@b')).toBeUndefined();
  });
});

describe('claude auth status', () => {
  it('reads the JSON of current versions, masking the email', () => {
    const r = out(`{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "email": "someone@example.com",
  "orgName": "Example Team",
  "subscriptionType": "team"
}\n`);
    expect(parseClaudeAuthStatus(r)).toEqual({ state: 'logged_in', account: 's***@example.com', plan: 'Team' });
  });
  it('maps plans and API keys', () => {
    expect(parseClaudeAuthStatus(out('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}\n'))).toEqual({ state: 'logged_in', plan: 'Max' });
    expect(parseClaudeAuthStatus(out('{"loggedIn":true,"authMethod":"claude.ai"}\n'))).toEqual({ state: 'logged_in' });
    expect(parseClaudeAuthStatus(out('{"loggedIn":true,"authMethod":"api_key"}\n')).plan).toBe('API key');
  });
  it('logged out (Synara fixtures)', () => {
    expect(parseClaudeAuthStatus(out('{"loggedIn":false}\n', 1)).state).toBe('logged_out');
    expect(parseClaudeAuthStatus(out('Not logged in\n', 1)).state).toBe('logged_out');
    expect(parseClaudeAuthStatus(out('{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}\n', 0, 'Not logged in. Please run /login.\n')).state).toBe('logged_out');
  });
  it('asks again after a clean loggedIn:false without a login hint', () => {
    expect(claudeSoftLoggedOut(out('{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}\n'))).toBe(true);
    expect(claudeSoftLoggedOut(out('{"loggedIn":false}\n', 0, 'Not logged in. Please run /login.\n'))).toBe(false);
    expect(claudeSoftLoggedOut(out('{"loggedIn":true}\n'))).toBe(false);
  });
  it('unknown when it cannot tell', () => {
    expect(parseClaudeAuthStatus(out('', 2, "error: unknown command 'auth'")).state).toBe('unknown');
    expect(parseClaudeAuthStatus(out('{"ok":true}\n')).state).toBe('unknown');
    expect(parseClaudeAuthStatus(out('{"loggedIn":')).state).toBe('unknown');
    expect(parseClaudeAuthStatus({ stdout: '', stderr: '', code: null, timedOut: true }).state).toBe('unknown');
  });
  it('a clean exit with text is logged in (older versions)', () => {
    expect(parseClaudeAuthStatus(out('Authenticated\n')).state).toBe('logged_in');
  });
});

describe('codex login status', () => {
  it('logged in with ChatGPT or an API key', () => {
    expect(parseCodexLoginStatus(out('Logged in using ChatGPT\n'))).toEqual({ state: 'logged_in' });
    expect(parseCodexLoginStatus(out('', 0, 'Logged in using ChatGPT\n'))).toEqual({ state: 'logged_in' });
    expect(parseCodexLoginStatus(out('Logged in using an API key - sk-proj-***ABCDE\n'))).toEqual({ state: 'logged_in', plan: 'API key' });
    expect(parseCodexLoginStatus(out('{"authenticated":true}\n')).state).toBe('logged_in');
  });
  it('logged out', () => {
    expect(parseCodexLoginStatus(out('Not logged in\n', 1)).state).toBe('logged_out');
    expect(parseCodexLoginStatus(out('', 1, 'Not logged in. Run codex login.')).state).toBe('logged_out');
    expect(parseCodexLoginStatus(out('[{"authenticated":false}]\n')).state).toBe('logged_out');
  });
  it('unknown', () => {
    expect(parseCodexLoginStatus(out('', 2, "error: unknown command 'login'")).state).toBe('unknown');
    expect(parseCodexLoginStatus(out('[{"ok":true}]\n')).state).toBe('unknown');
    expect(parseCodexLoginStatus(out('Logged in using ChatGPT\n', 1)).state).toBe('unknown');
  });
  it('auth.json: email and plan from the id token, never the tokens', () => {
    const file = JSON.stringify({
      auth_mode: 'chatgpt', OPENAI_API_KEY: null,
      tokens: { id_token: jwt({ email: 'dev@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }), access_token: 'secret', refresh_token: 'secret', account_id: 'acc' },
    });
    const l = codexLoginFromAuthFile(file);
    expect(l).toEqual({ state: 'logged_in', account: 'd***@example.com', plan: 'ChatGPT Plus' });
    expect(JSON.stringify(l)).not.toContain('secret');
    expect(codexLoginFromAuthFile(JSON.stringify({ OPENAI_API_KEY: 'sk-x' }))).toEqual({ state: 'logged_in', plan: 'API key' });
    expect(codexLoginFromAuthFile(JSON.stringify({ OPENAI_API_KEY: null, tokens: null })).state).toBe('logged_out');
    expect(codexLoginFromAuthFile(undefined).state).toBe('logged_out');
    expect(codexLoginFromAuthFile('{nope').state).toBe('unknown');
  });
  it('a custom model provider is not OpenAI login', () => {
    expect(codexCustomProvider('model = "gpt-5"\nmodel_provider = "ollama"\n')).toBe('ollama');
    expect(codexCustomProvider('model_provider = "openai"\n')).toBeUndefined();
    expect(codexCustomProvider('model = "x"\n[profiles.local]\nmodel_provider = "ollama"\n')).toBeUndefined();
    expect(codexCustomProvider(undefined)).toBeUndefined();
  });
});

describe('cursor-agent status', () => {
  it('logged in, with the email masked', () => {
    expect(parseCursorStatus(out('✓ Logged in as dev@example.com\n'))).toEqual({ state: 'logged_in', account: 'd***@example.com' });
    expect(parseCursorStatus(out('\u001b[32m✓\u001b[0m Logged in as dev@example.com\n')).account).toBe('d***@example.com');
    expect(parseCursorStatus(out('Logged in (unable to fetch user details)\n'))).toEqual({ state: 'logged_in' });
  });
  it('the JSON format too', () => {
    const json = '{"status":"authenticated","isAuthenticated":true,"hasAccessToken":true,"userInfo":{"email":"dev@example.com","userId":1}}';
    expect(parseCursorStatus(out(json))).toEqual({ state: 'logged_in', account: 'd***@example.com' });
  });
  it('logged out (Synara fixtures)', () => {
    expect(parseCursorStatus(out('', 1, "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n")).state).toBe('logged_out');
    expect(parseCursorStatus(out('Not authenticated\n', 1)).state).toBe('logged_out');
    expect(parseCursorStatus(out('Not logged in\n', 1)).state).toBe('logged_out');
  });
  it('unknown', () => {
    expect(parseCursorStatus(out('', 1, "error: unknown command 'status'")).state).toBe('unknown');
    expect(parseCursorStatus(out('something else\n')).state).toBe('unknown');
  });
});

describe('grok auth.json', () => {
  const now = Date.parse('2026-10-13T00:00:00Z');
  it('a cached login (Synara fixture), the auth.x.ai scope first', () => {
    const file = JSON.stringify({
      'https://accounts.x.ai/sign-in': { key: 'legacy-token', email: 'old@x.ai' },
      'https://auth.x.ai::openid': { key: 'super-token', email: 'user@x.ai', auth_mode: 'oauth', expires_at: '2026-11-01T00:00:00Z', principal_type: 'User' },
    });
    expect(grokLoginFromAuthFile(file, now)).toEqual({ state: 'logged_in', account: 'u***@x.ai' });
  });
  it('expired without a refresh token is logged out; refreshable is still in', () => {
    const scope = 'https://auth.x.ai::b1a00492';
    expect(grokLoginFromAuthFile(JSON.stringify({ [scope]: { key: 'k', expires_at: '2026-01-01T00:00:00Z' } }), now).state).toBe('logged_out');
    expect(grokLoginFromAuthFile(JSON.stringify({ [scope]: { key: 'k', expires_at: '2026-01-01T00:00:00Z', refresh_token: 'r' } }), now).state).toBe('logged_in');
  });
  it('other shapes', () => {
    expect(grokLoginFromAuthFile(JSON.stringify({ 'https://grok.com': { key: 'work-token' } }), now)).toEqual({ state: 'logged_in' });
    expect(grokLoginFromAuthFile(JSON.stringify({}), now).state).toBe('logged_out');
    expect(grokLoginFromAuthFile(undefined, now).state).toBe('logged_out');
    expect(grokLoginFromAuthFile('not json', now).state).toBe('unknown');
  });
});

describe('copilot', () => {
  it('config.json with comment lines and a signed-in user', () => {
    const file = `// User settings belong in settings.json.
// This file is managed automatically.
{
  "firstLaunchAt": "2026-07-02T18:10:00.000Z",
  "last_logged_in_user": { "host": "https://github.com", "login": "octocat" },
  "logged_in_users": [{ "host": "https://github.com", "login": "octocat" }]
}`;
    expect(copilotLoginFromConfig(file)).toEqual({ state: 'logged_in', account: '@octocat' });
  });
  it('no user, no file, a broken file', () => {
    expect(copilotLoginFromConfig('// managed\n{ "firstLaunchAt": "x", "appTipShown": true }').state).toBe('logged_out');
    expect(copilotLoginFromConfig(undefined).state).toBe('logged_out');
    expect(copilotLoginFromConfig('{').state).toBe('unknown');
  });
  it("the GitHub CLI's user from hosts.yml (Copilot falls back to gh auth token)", () => {
    const hosts = 'github.com:\n    git_protocol: https\n    users:\n        octocat:\n    user: octocat\nghe.example.com:\n    user: someone-else\n';
    expect(ghUserFromHosts(hosts)).toBe('octocat');
    expect(ghUserFromHosts(hosts, 'ghe.example.com')).toBe('someone-else');
    expect(ghUserFromHosts('github.com:\n    git_protocol: https\n')).toBeUndefined();
    expect(ghUserFromHosts(undefined)).toBeUndefined();
  });
});

describe('opencode auth list', () => {
  it('v2 table: stored and environment credentials', () => {
    const v2 = 'AnyAPI          ANYAPI_API_KEY              environment\nGitHub Copilot  OAuth                       stored\nxAI             OAuth                       stored\n';
    expect(parseOpenCodeAuthList(out(v2))).toEqual({ state: 'logged_in', account: 'AnyAPI, GitHub Copilot, xAI' });
  });
  it('v1 clack list, more than three', () => {
    const v1 = '┌  Credentials ~/.local/share/opencode/auth.json\n│\n●  Anthropic oauth\n│\n●  OpenAI api\n│\n●  GitHub Copilot oauth\n│\n└  3 credentials\n\n┌  Environment\n│\n●  OpenRouter OPENROUTER_API_KEY\n│\n└  1 environment variable\n';
    expect(parseOpenCodeAuthList(out(v1))).toEqual({ state: 'logged_in', account: 'Anthropic, OpenAI, GitHub Copilot +1' });
  });
  it('nothing stored is logged out; a failure is unknown', () => {
    expect(parseOpenCodeAuthList(out('┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n')).state).toBe('logged_out');
    expect(parseOpenCodeAuthList(out('')).state).toBe('logged_out');
    expect(parseOpenCodeAuthList(out('', 1, 'boom')).state).toBe('unknown');
  });
});

describe('built-in providers', () => {
  it('ships exactly the six agents, in order', () => {
    expect(BUILTIN_PROVIDERS.map((p) => [p.id, p.name])).toEqual([
      ['claude-code', 'Claude Code'], ['codex', 'Codex'], ['cursor', 'Cursor'], ['grok', 'Grok'], ['copilot', 'GitHub Copilot'], ['opencode', 'OpenCode'],
    ]);
    const grok = BUILTIN_PROVIDERS.find((p) => p.id === 'grok')!;
    expect([grok.command, ...grok.args]).toEqual(['grok', '--permission-mode', 'default', 'agent', '--no-leader', 'stdio']);
    // xAI's installer is a shell script: no hint on Windows
    expect(grok.installHint).toBe(process.platform === 'win32' ? undefined : 'curl -fsSL https://x.ai/cli/install.sh | bash');
    for (const id of RETIRED_PROVIDER_IDS) expect(BUILTIN_PROVIDERS.some((p) => p.id === id)).toBe(false);
  });

  it('a saved built-in keeps only the switch, env and an own command', () => {
    const cursor = BUILTIN_PROVIDERS.find((p) => p.id === 'cursor')!;
    const old = { ...cursor, name: 'Cursor Agent', description: 'Cursor CLI agent.', enabled: true, env: { A: '1' } };
    expect(mergeBuiltin(cursor, old)).toEqual({ ...cursor, enabled: true, env: { A: '1' }, builtin: true });
    const own = mergeBuiltin(cursor, { ...cursor, command: '/opt/cursor/bin/agent', args: ['acp', '--x'] });
    expect([own.command, ...own.args]).toEqual(['/opt/cursor/bin/agent', 'acp', '--x']);
    const claude = BUILTIN_PROVIDERS[0]!;
    const stale = mergeBuiltin(claude, { ...claude, command: NODE_COMMAND, args: ['/Applications/Old.app/adapter/index.js'], enabled: false });
    expect([stale.command, ...stale.args]).toEqual([claude.command, ...claude.args]);
    expect(stale.enabled).toBe(false);
  });

  it('a login check sets auth and the ACP auth status it implies', () => {
    const base = { ...emptyStatus(BUILTIN_PROVIDERS[1]!), installed: true, authStatus: 'needs_auth' as const, lastError: 'Authentication required' };
    const st = withLogin(base, { state: 'logged_in', account: 'd***@example.com', plan: 'ChatGPT Pro' }, true, 5);
    expect(st).toMatchObject({ authStatus: 'authenticated', canLogOut: true, auth: { state: 'logged_in', account: 'd***@example.com', plan: 'ChatGPT Pro', checkedAt: 5 } });
    expect(st.lastError).toBeUndefined();
    expect(withLogin({ ...base, authStatus: 'unknown' }, { state: 'logged_out' }, false, 6)).toMatchObject({ authStatus: 'needs_auth', auth: { state: 'logged_out' } });
    expect(withLogin({ ...base, authStatus: 'authenticated' }, { state: 'unknown' }, false, 7).authStatus).toBe('authenticated');
    expect(withLogin(base, undefined, false)).toBe(base);
  });
});
