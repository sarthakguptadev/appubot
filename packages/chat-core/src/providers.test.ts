import { describe, expect, it } from 'vitest';
import type { Provider } from '@appubot/protocol';
import { PROVIDER_MARKS, agentDisplayName, deviceSignIn, signsInHere, agentProfileLabel, genericModeId, permissionModeKind, providerInitials, providerLogin, providerLoginLine, providerMark, shownMode } from './providers';

type P = Pick<Provider, 'installed' | 'authStatus' | 'auth'>;
const p = (x: Partial<P>): P => ({ installed: true, authStatus: 'unknown', ...x });

describe('provider marks', () => {
  it('has a mark for each built-in; only Claude keeps a brand colour', () => {
    expect(Object.keys(PROVIDER_MARKS).sort()).toEqual(['claude-code', 'codex', 'copilot', 'cursor', 'grok', 'opencode']);
    expect(providerMark('claude-code')?.color).toBe('#D97757');
    for (const id of ['codex', 'cursor', 'grok', 'copilot', 'opencode']) expect(providerMark(id)?.color).toBeUndefined();
    for (const m of Object.values(PROVIDER_MARKS)) for (const path of m.paths) expect(path.d).toMatch(/^[Mm][\d\s.,a-zA-Z-]+$/);
    expect(providerMark('my-agent')).toBeUndefined();
  });
  it('initials for the rest', () => {
    expect(providerInitials('My Agent')).toBe('MA');
    expect(providerInitials('ollama')).toBe('O');
    expect(providerInitials('!!')).toBe('?');
  });
});

describe('providerLogin', () => {
  it('not installed wins', () => {
    expect(providerLogin(p({ installed: false, auth: { state: 'logged_in', checkedAt: 1 } })).kind).toBe('not_installed');
    expect(providerLogin(p({ authStatus: 'not_installed' })).label).toBe('Not installed');
  });
  it('logged in, with who and the plan', () => {
    const v = providerLogin(p({ auth: { state: 'logged_in', account: 's***@example.com', plan: 'Max', checkedAt: 1 } }));
    expect(v).toEqual({ kind: 'logged_in', label: 'Logged in', tone: 'success', detail: 's***@example.com · Max' });
    expect(providerLoginLine(p({ auth: { state: 'logged_in', plan: 'API key', checkedAt: 1 } }))).toBe('Logged in · API key');
    expect(providerLoginLine(p({ auth: { state: 'logged_in', checkedAt: 1 } }))).toBe('Logged in');
  });
  it('the CLI check beats a stale ACP verdict; without a check the ACP verdict stands in', () => {
    expect(providerLogin(p({ authStatus: 'authenticated', auth: { state: 'logged_out', checkedAt: 1 } })).kind).toBe('logged_out');
    expect(providerLogin(p({ authStatus: 'needs_auth' }))).toMatchObject({ kind: 'logged_out', label: 'Not logged in', login: 'primary' });
    expect(providerLogin(p({ authStatus: 'authenticated' })).kind).toBe('logged_in');
  });
  it('unknown is neutral with Log in on the side', () => {
    expect(providerLogin(p({}))).toEqual({ kind: 'unknown', label: 'Installed', tone: 'neutral', login: 'secondary' });
    expect(providerLogin(p({ auth: { state: 'unknown', checkedAt: 1 } })).detail).toBe("Couldn't check the login");
    expect(providerLogin(p({ authStatus: 'error' })).kind).toBe('error');
  });
});

describe('profiles', () => {
  it('draw their agent’s mark', () => {
    expect(providerMark('claude-code@work')).toBe(providerMark('claude-code'));
    expect(providerMark('codex@two')).toBe(providerMark('codex'));
  });
});

describe('agent profiles and permission modes', () => {
  const all = [
    { id: 'claude-code', name: 'Claude Code' },
    { id: 'claude-code@work', name: 'Claude Code · work', profile: { of: 'claude-code', name: 'work', home: '/h', source: 'appubot' as const } },
    { id: 'codex', name: 'Codex' },
  ];

  it('names agents with profiles "<agent> · <profile>", the built-in "Main" until renamed', () => {
    expect(agentProfileLabel(all[0]!, all)).toBe('Main');
    expect(agentDisplayName(all[0]!, all)).toBe('Claude Code · Main');
    expect(agentDisplayName({ ...all[0]!, profileName: 'home' }, all)).toBe('Claude Code · home');
    expect(agentDisplayName(all[1]!, all)).toBe('Claude Code · work');
    expect(agentProfileLabel(all[2]!, all)).toBe('');
    expect(agentDisplayName(all[2]!, all)).toBe('Codex');
  });

  it('shows a saved mode as the agent\'s own mode of the same kind', () => {
    const codex = [{ id: 'agent' }, { id: 'agent-full-access' }];
    expect(shownMode(codex, 'auto')).toBe('agent');
    expect(shownMode(codex, 'bypassPermissions')).toBe('agent-full-access');
    expect(shownMode(codex, 'agent')).toBe('agent');
    expect(shownMode([], 'auto')).toBe('auto');
    expect(shownMode(codex, 'plan')).toBe('plan');
  });

  it('stores modes as Claude Code ids', () => {
    expect(genericModeId('agent')).toBe('auto');
    expect(genericModeId('agent-full-access')).toBe('bypassPermissions');
    expect(genericModeId('bypassPermissions')).toBe('bypassPermissions');
    expect(genericModeId('plan')).toBe('plan');
    expect(permissionModeKind('agent-full-access')).toBe('bypass');
    expect(permissionModeKind('plan')).toBeUndefined();
  });
});

describe('deviceSignIn', () => {
  it('runs the built-ins’ own logins for another device, Codex with a code', () => {
    expect(deviceSignIn({ id: 'codex' })).toBe('code');
    expect(deviceSignIn({ id: 'claude-code' })).toBe('browser');
    expect(deviceSignIn({ id: 'claude-code@work' })).toBe('browser');
    expect(deviceSignIn({ id: 'copilot', builtin: true })).toBe('browser');
    // OpenCode's login is a menu of its own: on its desktop
    expect(deviceSignIn({ id: 'opencode', builtin: true })).toBeNull();
  });
  it('an added agent with a browser login of its own; one that takes keys is typed instead', () => {
    expect(deviceSignIn({ id: 'antigravity-acp', authMethods: [{ kind: 'agent' }] })).toBe('browser');
    expect(deviceSignIn({ id: 'gemini', authMethods: [{ kind: 'agent', vars: [{}] }, { kind: 'env_var', vars: [{}] }] })).toBeNull();
    expect(deviceSignIn({ id: 'custom', authMethods: [] })).toBeNull();
    // a terminal login runs on the computer, its link or code shown on the device
    expect(deviceSignIn({ id: 'kimi-acp', authMethods: [{ kind: 'terminal' }] })).toBe('browser');
  });
});

describe('signsInHere', () => {
  it('signs a built-in agent in to its account in the app, on every OS, and leaves keys and tokens to their dialogs', () => {
    const claude = { id: 'claude-code', builtin: true };
    expect(signsInHere(claude, { id: 'claude-ai-login' })).toBe(true);
    expect(signsInHere(claude, undefined)).toBe(true);
    expect(signsInHere({ id: 'codex', builtin: true }, { id: 'chat-gpt' })).toBe(true);
    expect(signsInHere({ id: 'copilot', builtin: true }, { id: 'github-login' })).toBe(true);
    expect(signsInHere({ id: 'claude-code@work', profile: { of: 'claude-code' } }, { id: 'claude-ai-login' })).toBe(true);
    expect(signsInHere(claude, { id: 'claude-token', vars: [{}] })).toBe(false);
    expect(signsInHere(claude, { id: 'anthropic-api-key', vars: [{}] })).toBe(false);
    // OpenCode asks which provider in a menu of its own; an added agent keeps its own login
    expect(signsInHere({ id: 'opencode', builtin: true }, { id: 'opencode-login' })).toBe(false);
    expect(signsInHere({ id: 'antigravity-acp' }, { id: 'oauth' })).toBe(false);
  });
});
