import { describe, expect, it } from 'vitest';
import { APPUBOT_AI_PROVIDER_ID, CLAUDE_MODEL_CATALOG, profileId, providerBase } from '@appubot/protocol';
import { createAgentRuntime } from './index';
import { APPROVAL_MODES, BUILTIN_PROVIDERS, builtinInstallHint, emptyStatus, withBuiltinLogins, adapterCli, agentModeFor, providerSessionMeta, isNoAskMode, permissionChoice, profileSpec, providerModes, toOfferedMode } from './providers';

const CLAUDE = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'].map((id) => ({ id, name: id }));

describe('providerModes', () => {
  it('offers Claude Code only Auto and Bypass, in that order and with our names', () => {
    expect(providerModes('claude-code', CLAUDE).map((m) => [m.id, m.name])).toEqual([
      ['auto', 'Approve for me'],
      ['bypassPermissions', 'Full access'],
    ]);
  });

  it('drops a mode the agent does not report (bypass as root)', () => {
    expect(providerModes('claude-code', CLAUDE.filter((m) => m.id !== 'bypassPermissions')).map((m) => m.id)).toEqual(['auto']);
  });

  it("offers Codex its Auto review (as Approve for me) and Full access, and other agents AppuBot's two", () => {
    const codex = ['read-only', 'workspace-write', 'agent', 'agent-full-access'].map((id) => ({ id, name: id }));
    expect(providerModes('codex', codex).map((m) => [m.id, m.name])).toEqual([['agent', 'Approve for me'], ['agent-full-access', 'Full access']]);
    const cursor = [{ id: 'agent', name: 'Agent' }, { id: 'plan', name: 'Plan' }];
    expect(providerModes('cursor', cursor).map((m) => [m.id, m.name])).toEqual([['auto', 'Approve for me'], ['bypassPermissions', 'Full access']]);
    expect(providerModes('antigravity-acp', [])).toEqual(APPROVAL_MODES);
  });

  it('moves a saved mode AppuBot no longer offers to Auto', () => {
    expect(toOfferedMode('claude-code', 'default')).toBe('auto');
    expect(toOfferedMode('claude-code@work', 'bypassPermissions')).toBe('bypassPermissions');
    expect(toOfferedMode('claude-code', undefined)).toBeUndefined();
    // the other agents: their own ids (or none) from before they had the two choices ran as Full access
    expect(toOfferedMode('cursor', 'plan')).toBe('bypassPermissions');
    expect(toOfferedMode('cursor', undefined)).toBe('bypassPermissions');
    expect(toOfferedMode('cursor', 'auto')).toBe('auto');
    // Settings' default is Claude Code's ids: on Codex it becomes Codex's own
    expect(toOfferedMode('codex', 'auto')).toBe('agent');
    expect(toOfferedMode('codex', 'bypassPermissions')).toBe('agent-full-access');
    expect(toOfferedMode('claude-code', 'agent-full-access')).toBe('bypassPermissions');
  });

  it('keeps the same choice on another agent', () => {
    expect(toOfferedMode('cursor', permissionChoice('codex', 'agent'))).toBe('auto');
    expect(toOfferedMode('codex', permissionChoice('gemini', 'auto'))).toBe('agent');
    expect(toOfferedMode('claude-code', permissionChoice('codex', 'agent-full-access'))).toBe('bypassPermissions');
    expect(permissionChoice('claude-code', undefined)).toBeUndefined();
  });

  it("finds the agent's own mode for each choice", () => {
    const gemini = ['default', 'autoEdit', 'yolo', 'plan'].map((id) => ({ id, name: id }));
    expect(agentModeFor('bypassPermissions', gemini, 'default', 'default')).toBe('yolo');
    expect(agentModeFor('bypassPermissions', gemini, 'yolo', 'default')).toBeUndefined();
    expect(agentModeFor('auto', gemini, 'yolo', 'default')).toBe('default');
    expect(agentModeFor('auto', gemini, 'autoEdit', 'default')).toBeUndefined();
    // started on its no-questions mode: Approve for me takes its first plain one
    expect(agentModeFor('auto', gemini, 'yolo', 'yolo')).toBe('default');
    const cursor = [{ id: 'agent', name: 'Agent' }, { id: 'plan', name: 'Plan' }, { id: 'ask', name: 'Ask' }];
    expect(agentModeFor('bypassPermissions', cursor, 'agent', 'agent')).toBeUndefined();
    expect(isNoAskMode({ id: 'bypass', name: 'Bypass Permissions' })).toBe(true);
    expect(isNoAskMode({ id: 'auto_edit', name: 'Auto edit' })).toBe(false);
  });
});

describe('profiles', () => {
  const hooks = { requestPermission: async () => 'allow', onTurnOp: () => {}, onSessionState: () => {}, log: () => {} };
  const work = { id: 'claude-code@work', name: '', command: 'stale', args: ['old'], env: { FOO: '1', CLAUDE_CONFIG_DIR: '/elsewhere' }, profile: { of: 'claude-code', name: 'Work', home: '/p/work' } };

  it('runs its built-in with its folder as CLAUDE_CONFIG_DIR / CODEX_HOME', () => {
    const claude = BUILTIN_PROVIDERS.find((p) => p.id === 'claude-code')!;
    const spec = profileSpec(claude, work);
    expect(spec).toMatchObject({ id: 'claude-code@work', name: 'Claude Code · Work', command: claude.command, args: claude.args, builtin: false });
    expect(spec.env).toEqual({ FOO: '1', CLAUDE_CONFIG_DIR: '/p/work' });
    const codex = BUILTIN_PROVIDERS.find((p) => p.id === 'codex')!;
    expect(profileSpec(codex, { ...work, id: 'codex@work', env: {}, profile: { ...work.profile, of: 'codex' } }).env).toEqual({ CODEX_HOME: '/p/work' });
  });

  it('gets its agent’s modes', () => {
    expect(providerModes('claude-code@work', CLAUDE).map((m) => m.id)).toEqual(['auto', 'bypassPermissions']);
  });

  it('is listed by the runtime next to the built-ins, and dropped when its built-in is unknown', () => {
    const rt = createAgentRuntime({ hooks: hooks as never });
    rt.setProviders([work, { ...work, id: 'gone@x', profile: { of: 'gone', name: 'x', home: '/p/x' } }]);
    const ids = rt.getProviders().map((p) => p.id);
    expect(ids).toContain('claude-code@work');
    expect(ids).not.toContain('gone@x');
    expect(rt.getProviders().find((p) => p.id === 'claude-code@work')?.env.CLAUDE_CONFIG_DIR).toBe('/p/work');
  });

  it('is turned into the protocol’s base id for agent-keyed lookups', () => {
    expect(providerBase('claude-code@work')).toBe('claude-code');
    expect(providerBase('codex')).toBe('codex');
    expect(profileId('codex', 'two')).toBe('codex@two');
  });
});

describe('the CLIs Claude Code and Codex drive', () => {
  const spec = (id: string, env: Record<string, string> = {}) => ({ id, name: id, command: '$node', args: [], env });
  it("are the user's own (AppuBot ships neither): one set in the env wins", async () => {
    expect(await adapterCli(spec('codex@work', { CODEX_PATH: '/opt/codex' }), {})).toBe('/opt/codex');
    expect(await adapterCli(spec('claude-code'), { CLAUDE_CODE_EXECUTABLE: '/opt/claude' })).toBe('/opt/claude');
    expect(await adapterCli(spec('cursor'), {})).toBeNull();
  });
  it('install with their makers’ own installers', () => {
    const hint = (id: string) => BUILTIN_PROVIDERS.find((p) => p.id === id)!.installHint ?? '';
    expect(hint('claude-code')).toMatch(/claude\.ai\/install\.(sh|ps1)/);
    expect(hint('codex')).toMatch(/brew install --cask codex|npm i -g @openai\/codex/);
  });
});

describe('providerSessionMeta: Claude Code model catalog', () => {
  const claude = BUILTIN_PROVIDERS.find((p) => p.id === 'claude-code')!;
  const codex = BUILTIN_PROVIDERS.find((p) => p.id === 'codex')!;

  it("starts Claude Code (and its profiles) with Synara's catalog as extra picker rows", () => {
    const want = { claudeCode: { options: { settings: { modelPicker: { options: CLAUDE_MODEL_CATALOG.map((r) => ({ ...r })) } } } } };
    expect(providerSessionMeta(claude)).toEqual(want);
    expect(providerSessionMeta({ ...claude, id: profileId('claude-code', 'work') })).toEqual(want);
    expect(CLAUDE_MODEL_CATALOG.map((r) => r.label)).toContain('Fable 5');
  });

  it('gives AppuBot AI (the launch bonus) only the Sonnet and Haiku rows', () => {
    const rows = (providerSessionMeta({ ...claude, id: APPUBOT_AI_PROVIDER_ID }) as { claudeCode: { options: { settings: { modelPicker: { options: { model: string }[] } } } } }).claudeCode.options.settings.modelPicker.options;
    expect(rows.map((r) => r.model)).toEqual(['claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5']);
  });

  it('gives other agents nothing extra', () => {
    expect(providerSessionMeta(codex)).toBeUndefined();
  });
});

describe('logins every built-in agent offers', () => {
  const ids = (methods: { id: string }[]) => methods.map((m) => m.id);

  it('always lists Claude Code’s subscription login first, whatever its handshake advertised', () => {
    // what the user saw: no handshake logins, only the key logins
    expect(withBuiltinLogins('claude-code', []).map((m) => [m.id, m.name])).toEqual([
      ['claude-ai-login', 'Claude subscription'], ['claude-token', 'Paste a token'], ['anthropic-api-key', 'API key'],
    ]);
    // advertised by the adapter (with its own name): one entry, ours, first; the adapter's others kept after it
    const advertised = [
      { id: 'console-login', name: 'Anthropic Console', kind: 'terminal' as const },
      { id: 'claude-ai-login', name: 'Claude Subscription', kind: 'terminal' as const },
    ];
    expect(ids(withBuiltinLogins('claude-code', advertised))).toEqual(['claude-ai-login', 'console-login', 'claude-token', 'anthropic-api-key']);
    expect(ids(withBuiltinLogins('claude-code@work', []))[0]).toBe('claude-ai-login');
    expect(ids(emptyStatus(BUILTIN_PROVIDERS[0]!).authMethods)[0]).toBe('claude-ai-login');
  });

  it('gives every built-in its account login first, and an added agent only its own', () => {
    expect(ids(withBuiltinLogins('codex', [{ id: 'api-key', name: 'API Key', kind: 'agent' }, { id: 'chat-gpt', name: 'ChatGPT', kind: 'agent' }]))).toEqual(['chat-gpt', 'api-key']);
    for (const spec of BUILTIN_PROVIDERS) {
      const first = withBuiltinLogins(spec.id, [])[0];
      expect(first, spec.id).toMatchObject({ kind: 'terminal' });
      expect(first?.vars, spec.id).toBeUndefined();
    }
    expect(withBuiltinLogins('antigravity-acp', [{ id: 'oauth', name: 'Sign in', kind: 'agent' }])).toEqual([{ id: 'oauth', name: 'Sign in', kind: 'agent' }]);
  });

  it('knows how each built-in installs on each platform, Grok on Windows included', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const spec of BUILTIN_PROVIDERS) expect(builtinInstallHint(spec.id, platform), `${spec.id} on ${platform}`).toBeTruthy();
    }
    expect(builtinInstallHint('grok', 'win32')).toBe('powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://x.ai/cli/install.ps1 | iex"');
    expect(builtinInstallHint('grok', 'linux')).toBe('curl -fsSL https://x.ai/cli/install.sh | bash');
  });
});

