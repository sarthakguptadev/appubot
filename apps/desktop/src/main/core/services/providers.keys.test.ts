/**
 * Logins that are keys (an API key the agent reads from its environment) and the sign-in state of agents that can't
 * be asked for it (the ACP registry's): keys stay in a file only this user reads, reach the agent through the runtime's
 * `secretEnv` and never the wire; the last state seen survives a restart.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

let root: string;
const cores: Core[] = [];

async function start(setup?: (rt: FakeRuntime) => void): Promise<{ core: Core; runtime: FakeRuntime }> {
  let runtime!: FakeRuntime;
  const core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => { runtime = new FakeRuntime(hooks); setup?.(runtime); return runtime; },
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, quiet: true,
  });
  await core.start();
  cores.push(core);
  return { core, runtime };
}

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'appubot-keys-')); });
afterAll(async () => {
  for (const c of cores) await c.stop().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe('agent keys', () => {
  it('saves a key login only for this user, hands it to the agent and never shows it again', async () => {
    const { core, runtime } = await start();
    await core.services.providers.upsert({ id: 'gem', name: 'Gem', command: 'fake-gem', args: [], env: {} });
    runtime.probeAuthMethods = [
      { id: 'oauth', name: 'Google', kind: 'agent' },
      { id: 'gemini-api-key', name: 'Gemini API key', kind: 'agent', vars: [{ name: 'GEMINI_API_KEY', label: 'Gemini API key', secret: true, optional: false }] },
    ];
    await core.services.providers.probe('gem');

    await expect(core.services.providers.setKeys('gem', 'oauth', { X: 'y' })).rejects.toThrow(/no login/);
    await expect(core.services.providers.setKeys('gem', 'gemini-api-key', {})).rejects.toThrow(/Enter Gemini API key/);

    const r = await core.services.providers.setKeys('gem', 'gemini-api-key', { GEMINI_API_KEY: ' sk-123 ', EXTRA: 'dropped' });
    expect(r.ok).toBe(true);
    // the agent login selects the key (Gemini's `authenticate` with that method)
    expect(runtime.agentLogins).toContainEqual({ id: 'gem', methodId: 'gemini-api-key' });
    expect(runtime.hooks.secretEnv?.('gem')).toEqual({ GEMINI_API_KEY: 'sk-123' });

    const file = join(root, 'data', 'agent-keys.json');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ gem: { GEMINI_API_KEY: 'sk-123' } });
    const listed = core.services.providers.list().find((p) => p.id === 'gem')!;
    expect(listed.keysSaved).toEqual(['GEMINI_API_KEY']);
    expect(JSON.stringify(core.services.providers.list())).not.toContain('sk-123');

    await core.services.providers.clearKeys('gem');
    expect(runtime.hooks.secretEnv?.('gem')).toBeUndefined();
    expect(core.services.providers.list().find((p) => p.id === 'gem')!.keysSaved).toEqual([]);
    await core.stop();
  });

  it("remembers an agent's last sign-in when it can't be asked", async () => {
    const first = await start((rt) => rt.authStatuses.set('reg', 'needs_auth'));
    await first.core.services.providers.upsert({ id: 'reg', name: 'Reg', command: 'fake-reg', args: [], env: {} });
    expect(first.core.services.providers.list().find((p) => p.id === 'reg')!.authStatus).toBe('needs_auth');
    await first.core.stop();

    // after a restart its handshake knows nothing yet: the last state seen stands in
    const second = await start((rt) => rt.authStatuses.set('reg', 'unknown'));
    await second.core.services.providers.refresh(['reg']);
    expect(second.core.services.providers.list().find((p) => p.id === 'reg')!.authStatus).toBe('needs_auth');
    // a check that tells wins, and is remembered in turn
    second.runtime.authStatuses.set('reg', 'authenticated');
    await second.core.services.providers.refresh(['reg']);
    expect(second.core.services.providers.list().find((p) => p.id === 'reg')!.authStatus).toBe('authenticated');
    expect(JSON.parse(readFileSync(join(root, 'data', 'agent-auth.json'), 'utf8')).reg).toBe('authenticated');
  });
});

describe('profiles of an agent added from the registry', () => {
  it('gives Google Antigravity more accounts, each in a folder of its own, signed in through its own login', async () => {
    const { core, runtime } = await start();
    await core.services.providers.upsert({ id: 'antigravity-acp', name: 'Google Antigravity', command: '/agents/antigravity-acp/1.4.1/agy_acp_server.par', args: [], env: {} });
    const p = await core.services.providers.addProfile({ of: 'antigravity-acp', name: 'Work' });
    expect(p).toMatchObject({ id: 'antigravity-acp@work', name: 'Google Antigravity · Work', profile: { of: 'antigravity-acp', name: 'Work', source: 'appubot' } });
    const spec = runtime.getProviders().find((x) => x.id === 'antigravity-acp@work')!;
    expect(spec.env.GEMINI_HOME).toBe(join(root, 'data', 'profiles', 'antigravity-acp', 'work'));
    expect(spec.command).toBe('/agents/antigravity-acp/1.4.1/agy_acp_server.par');
    expect(runtime.probes).toContain('antigravity-acp@work');
    // its login is the agent's own (the browser), not a terminal command
    await core.services.providers.authenticate('antigravity-acp@work');
    expect(runtime.agentLogins).toContainEqual({ id: 'antigravity-acp@work', methodId: 'oauth' });
    // the agent's own account gets a name too
    expect((await core.services.providers.renameProfile('antigravity-acp', 'Personal')).profileName).toBe('Personal');
    await expect(core.services.providers.addProfile({ of: 'gemini', name: 'x' })).rejects.toThrow(/can have profiles/);
    await core.stop();
  });
});
