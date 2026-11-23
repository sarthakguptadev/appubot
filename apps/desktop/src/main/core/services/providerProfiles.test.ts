import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotSchema } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { checkRole } from '../handlers';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { findProfiles, profileSlug } from './providerProfiles';

let core: Core;
let root: string;
let home: string;
let data: string;
const hex = (s: string) => Buffer.from(s).toString('hex');

/** a home folder with two Synara Claude profiles (one without a settings entry), a `~/.claude-work`, a `~/.codex-two` and decoys */
function makeHome(dir: string): void {
  const synara = join(dir, '.synara', 'userdata');
  const instance = (id: string) => {
    const p = join(synara, 'provider-homes', 'claude', `instance-${hex(id)}`, '.claude');
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, '.claude.json'), '{}');
    return p;
  };
  instance('claude_sarthakfour');
  instance('sarthaktoo');
  mkdirSync(join(synara, 'provider-homes', 'claude', `instance-${hex('empty')}`, '.claude'), { recursive: true }); // never ran
  writeFileSync(join(synara, 'settings.json'), JSON.stringify({ settings: { providerInstances: {
    claude_sarthakfour: { driver: 'claudeAgent', displayName: 'sarthakfour', enabled: true },
    codex: { driver: 'codex', displayName: 'Codex' },
  } } }));
  mkdirSync(join(dir, '.claude-work', 'projects'), { recursive: true });
  mkdirSync(join(dir, '.codex-two'), { recursive: true });
  writeFileSync(join(dir, '.codex-two', 'auth.json'), '{}');
  mkdirSync(join(dir, '.claude-empty'), { recursive: true }); // no config in it
  mkdirSync(join(dir, '.claude'), { recursive: true }); // the default one
  writeFileSync(join(dir, '.claude.json'), '{}');
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-profiles-'));
  home = join(root, 'home');
  data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  makeHome(home);
  writeFileSync(join(data, 'bots.json'), JSON.stringify([]));
  core = createCore({
    paths: { dataDir: data, botsRoot: join(root, 'bots'), filesDir: join(data, 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined,
    openTerminal: () => undefined,
    nativeNotify: () => undefined,
    homeDir: home,
    version: '0.0.0-test',
    hostName: 'test-mac',
    log: silentLogger,
    validate: true,
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    computerBackends: () => [],
    helperTransport: () => null,
  });
  await core.start();
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('findProfiles', () => {
  it('finds Synara’s Claude profiles (named from its settings or the folder) and ~/.claude-* / ~/.codex-* folders with a config', () => {
    const found = findProfiles(home);
    expect(found.map((f) => [f.of, f.name, f.source])).toEqual([
      ['claude-code', 'sarthakfour', 'synara'],
      ['claude-code', 'sarthaktoo', 'synara'],
      ['claude-code', 'work', 'folder'],
      ['codex', 'two', 'folder'],
    ]);
    expect(found[0]!.home).toBe(join(home, '.synara', 'userdata', 'provider-homes', 'claude', `instance-${hex('claude_sarthakfour')}`, '.claude'));
  });

  it('turns names into id slugs', () => {
    expect(profileSlug('Work account!')).toBe('work-account');
    expect(profileSlug('  ')).toBe('profile');
  });
});

describe('profiles as agents', () => {
  it('adds a found Synara profile as is: its folder is its CLAUDE_CONFIG_DIR', async () => {
    const [synara] = core.services.providers.profiles().found;
    const p = await core.services.providers.addProfile({ of: 'claude-code', name: synara!.name, home: synara!.home });
    expect(p).toMatchObject({ id: 'claude-code@sarthakfour', name: 'Claude Code (fake) · sarthakfour', builtin: false, profile: { of: 'claude-code', name: 'sarthakfour', source: 'synara', home: synara!.home } });
    expect(p.env.CLAUDE_CONFIG_DIR).toBe(synara!.home);
    // it isn't offered again
    expect(core.services.providers.profiles().found.map((f) => f.home)).not.toContain(synara!.home);
    await expect(core.services.providers.addProfile({ of: 'claude-code', name: 'again', home: synara!.home })).rejects.toThrow(/already/);
  });

  it('makes a new folder for a fresh profile, and a unique id for a repeated name', async () => {
    const a = await core.services.providers.addProfile({ of: 'codex', name: 'Second' });
    expect(a.id).toBe('codex@second');
    expect(a.profile).toMatchObject({ source: 'appubot', home: join(data, 'profiles', 'codex', 'second') });
    expect(existsSync(a.profile!.home)).toBe(true);
    expect(a.env.CODEX_HOME).toBe(a.profile!.home);
    const b = await core.services.providers.addProfile({ of: 'codex', name: 'second' });
    expect(b.id).toBe('codex@second-2');
  });

  it('only for agents that have profiles, and only real folders', async () => {
    await expect(core.services.providers.addProfile({ of: 'cursor', name: 'x' })).rejects.toThrow(/Claude Code, Codex and Google Antigravity/);
    await expect(core.services.providers.addProfile({ of: 'claude-code', name: 'x', home: join(root, 'nope') })).rejects.toThrow(/No such folder/);
  });

  it('keeps being a profile through the switch (providers.upsert) and a rename', async () => {
    const p = core.services.providers.list().find((x) => x.id === 'codex@second-2')!;
    const off = await core.services.providers.upsert({ id: p.id, name: p.name, command: p.command, args: p.args, env: p.env, enabled: false });
    expect(off).toMatchObject({ enabled: false, profile: { of: 'codex', name: 'second' } });
    const r = await core.services.providers.renameProfile(p.id, 'Personal');
    expect(r).toMatchObject({ id: 'codex@second-2', name: 'Codex (fake) · Personal', enabled: false, profile: { name: 'Personal' } });
  });

  it('names the agent’s default profile, through its switch too', async () => {
    const s = core.services;
    expect(s.providers.list().find((x) => x.id === 'claude-code')?.profileName).toBeUndefined();
    const r = await s.providers.renameProfile('claude-code', 'Personal');
    expect(r).toMatchObject({ id: 'claude-code', builtin: true, enabled: true, profileName: 'Personal' });
    const off = await s.providers.upsert({ id: r.id, name: r.name, command: r.command, args: r.args, env: r.env, enabled: false });
    expect(off).toMatchObject({ enabled: false, profileName: 'Personal' });
    await s.providers.upsert({ id: r.id, name: r.name, command: r.command, args: r.args, env: r.env, enabled: true });
  });

  it('removing one moves its bots and chats back to the agent’s default account, and keeps its folder', async () => {
    const s = core.services;
    const bot = s.bots.create({ name: 'Worker', providerId: 'claude-code@sarthakfour' } as Parameters<typeof s.bots.create>[0]);
    const t = s.threads.update(s.threads.create({ botId: bot.id }).id, { acpSessionId: 'sess' });
    expect(t.providerId).toBe('claude-code@sarthakfour');
    s.settings.update({ defaultProviderId: 'claude-code@sarthakfour' });
    const home = s.providers.list().find((x) => x.id === 'claude-code@sarthakfour')!.profile!.home;
    await s.providers.delete('claude-code@sarthakfour');
    expect(s.providers.list().some((x) => x.id === 'claude-code@sarthakfour')).toBe(false);
    expect(BotSchema.parse(s.bots.get(bot.id)).providerId).toBe('claude-code');
    expect(s.threads.get(t.id)).toMatchObject({ providerId: 'claude-code', acpSessionId: undefined });
    expect(s.settings.get().defaultProviderId).toBe('claude-code');
    expect(existsSync(home)).toBe(true);
  });

  it('a full-access phone may add and rename profiles, a limited one may not', () => {
    const phone = { role: 'full' as const, deviceId: 'phone' };
    expect(() => checkRole('providers.addProfile', { of: 'claude-code', name: 'x' }, phone)).not.toThrow();
    expect(() => checkRole('providers.renameProfile', { id: 'x', name: 'y' }, phone)).not.toThrow();
    expect(() => checkRole('providers.addProfile', { of: 'claude-code', name: 'x' }, { role: 'limited' as const, deviceId: 'phone' })).toThrow(/not allowed/);
    expect(() => checkRole('providers.profiles', {}, phone)).not.toThrow();
  });

  it('a team member on a shared cloud computer signs in only agent profiles of their own, never the team’s logins', () => {
    const member = { role: 'full' as const, deviceId: 'phone', member: 'acc_bob' };
    // their own profile: add it, sign it in, its keys, rename it, remove it
    expect(() => checkRole('providers.addProfile', { of: 'claude-code', name: 'Bob' }, member)).not.toThrow();
    for (const m of ['providers.deviceLogin.start', 'providers.deviceLogin.code', 'providers.deviceLogin.cancel', 'providers.authenticate', 'providers.logout', 'providers.renameProfile', 'providers.delete'] as const) {
      expect(() => checkRole(m, { id: 'claude-code@bob', code: 'x', name: 'y' }, member)).not.toThrow();
      // the shared login is the admins'
      expect(() => checkRole(m, { id: 'claude-code', code: 'x', name: 'y' }, member)).toThrow(/not allowed/);
    }
    expect(() => checkRole('providers.setKeys', { id: 'claude-code@bob', methodId: 'claude-token', values: { CLAUDE_CODE_OAUTH_TOKEN: 't' } }, member)).not.toThrow();
    expect(() => checkRole('providers.clearKeys', { id: 'claude-code@bob' }, member)).not.toThrow();
    expect(() => checkRole('providers.setKeys', { id: 'claude-code', methodId: 'claude-token', values: { CLAUDE_CODE_OAUTH_TOKEN: 't' } }, member)).toThrow(/not allowed/);
    expect(() => checkRole('providers.clearKeys', { id: 'codex' }, member)).toThrow(/not allowed/);
    // the rest is a full device's as before (no Vault secrets, no gateway settings)
    expect(() => checkRole('vault.reveal', { id: 'v', field: 'password' }, member)).toThrow(/not allowed/);
    expect(() => checkRole('chat.send', { botId: 'b', text: 'hi' }, member)).not.toThrow();
    // a full device that isn't a team member keeps its rules: no keys anywhere, sign-ins as before
    const phone = { role: 'full' as const, deviceId: 'phone' };
    expect(() => checkRole('providers.setKeys', { id: 'claude-code@bob', methodId: 'm', values: {} }, phone)).toThrow(/not allowed/);
    expect(() => checkRole('providers.deviceLogin.start', { id: 'claude-code' }, phone)).not.toThrow();
    // an admin's (owner) device sets the shared logins
    expect(() => checkRole('providers.setKeys', { id: 'claude-code', methodId: 'm', values: {} }, { role: 'owner' as const, deviceId: 'mac', member: 'acc_ann' })).not.toThrow();
  });
});
