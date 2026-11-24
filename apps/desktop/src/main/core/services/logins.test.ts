/**
 * Whose logins a bot runs on, on a team's AppuBot Cloud computer (§6.11, review S7): on "each person uses their own"
 * every member's bots run their agents with that member's own home (`loginHome`), keys, Vault and apps; nobody reads
 * another's; switching to shared moves every bot onto the computer's own set with its conversation resumed, and back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import type { CoreDeps } from '../context';
import { buildHandlers, checkRole, type CallCtx } from '../handlers';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { memberScope } from './logins';

let core: Core;
let runtime: FakeRuntime;
let root: string;
const CLOUD: CoreDeps['cloud'] = { publicUrl: 'https://ab12cd34ef.agent37.app', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 6 };
const until = async (test: () => boolean, ms = 4000) => { const end = Date.now() + ms; while (!test()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };

/** pair a device for a team member through the control server's path, as the backend does */
async function pairMember(id: string, email: string, role: 'owner' | 'full', deviceId: string): Promise<CallCtx> {
  const info = await core.services.devices.startPairing(120, { role, member: { id, email } });
  const [status] = await core.services.devices.pair({ code: info.code, device: { id: deviceId, name: deviceId, platform: 'ios' } }, '203.0.113.9');
  expect(status).toBe(200);
  return { role, deviceId, member: id };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-logins-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: async () => ({ shown: false, error: 'headless' }),
    version: '2026.11.05', hostName: 'Acme', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    cloud: CLOUD,
  });
  await core.start();
  runtime.reply = () => 'ok';
  core.services.system.setCloudState({ state: 'ok', logins: 'own' });
});
afterAll(async () => { await core.stop(); rmSync(root, { recursive: true, force: true }); });

describe('each person uses their own logins', () => {
  it('a bot belongs to the person whose device made it and runs its agent in their own home, keys, Vault and apps', async () => {
    const s = core.services;
    const handlers = buildHandlers(core.ctx);
    const ada = await pairMember('acc_ada', 'ada@acme.test', 'owner', 'ada-mac');
    const bo = await pairMember('acc_bo', 'bo@acme.test', 'full', 'bo-phone');
    expect(s.logins.members()).toEqual([{ id: 'acc_ada', email: 'ada@acme.test' }, { id: 'acc_bo', email: 'bo@acme.test' }]);
    const adaBot = await handlers['bots.create']({ name: 'Ada bot', providerId: 'claude-code' } as never, ada) as Bot;
    const boBot = await handlers['bots.create']({ name: 'Bo bot', providerId: 'claude-code' } as never, bo) as Bot;
    expect(adaBot.memberId).toBe('acc_ada');
    expect(boBot.memberId).toBe('acc_bo');
    expect(s.logins.botLoginsLine(adaBot)).toBe('Uses ada@acme.test’s logins');
    // each person's keys live in their own folder and reach only their agents
    const dataDir = core.ctx.paths.dataDir;
    writeFileSync(join(s.logins.dirOf(memberScope('acc_ada')), 'agent-keys.json'), JSON.stringify({ 'claude-code': { ANTHROPIC_API_KEY: 'ada-key' } }), { mode: 0o600 });
    writeFileSync(join(dataDir, 'agent-keys.json'), JSON.stringify({ 'claude-code': { ANTHROPIC_API_KEY: 'team-key' } }), { mode: 0o600 });
    expect(s.providers.secretEnv('claude-code', memberScope('acc_ada'))).toEqual({ ANTHROPIC_API_KEY: 'ada-key' });
    expect(s.providers.secretEnv('claude-code', memberScope('acc_bo'))).toBeUndefined();
    expect(s.providers.secretEnv('claude-code')).toEqual({ ANTHROPIC_API_KEY: 'team-key' });
    expect(s.providers.list(memberScope('acc_ada')).find((p) => p.id === 'claude-code')!.keysSaved).toEqual(['ANTHROPIC_API_KEY']);
    expect(s.providers.list(memberScope('acc_bo')).find((p) => p.id === 'claude-code')!.keysSaved).toEqual([]);
    if (process.platform !== 'win32') expect((statSync(s.logins.dirOf(memberScope('acc_ada'))).mode & 0o777)).toBe(0o700);
    // a turn: the agent starts with the person's home and scope, and their keys
    const r = s.chat.send({ botId: adaBot.id, text: 'hi', attachments: [], images: [] });
    await until(() => runtime.created.some((c) => c.env?.APPUBOT_BOT_ID === adaBot.id));
    const opened = runtime.created.find((c) => c.env?.APPUBOT_BOT_ID === adaBot.id)!;
    expect(opened.loginHome).toBe(join(dataDir, 'members', 'acc_ada', 'home'));
    expect(opened.loginScope).toBe('member:acc_ada');
    expect(existsSync(opened.loginHome!)).toBe(true);
    expect(core.services.chat.hooks.secretEnv?.('claude-code', opened.loginScope)).toEqual({ ANTHROPIC_API_KEY: 'ada-key' });
    await until(() => s.threads.messages(r.userMessage.threadId).some((m) => m.id === r.agentMessageId && m.status === 'complete'));
    // Vaults are per person: Bo's phone lists Bo's, Ada's bot sees Ada's, and neither sees the other's
    s.vault.save({ kind: 'login', name: 'Ada’s bank', username: 'ada', secrets: { password: 'ada-pw' } }, memberScope('acc_ada'));
    s.vault.save({ kind: 'login', name: 'Bo’s bank', username: 'bo', secrets: { password: 'bo-pw' } }, memberScope('acc_bo'));
    expect((await handlers['vault.list']({}, bo) as { items: { name: string }[] }).items.map((i) => i.name)).toEqual(['Bo’s bank']);
    expect((await handlers['vault.list']({}, ada) as { items: { name: string }[] }).items.map((i) => i.name)).toEqual(['Ada’s bank']);
    expect(s.vault.agentList({ botId: adaBot.id, threadId: 't' } as never).items.map((i) => i.name)).toEqual(['Ada’s bank']);
    expect(s.vault.list().items).toEqual([]);
    expect(readFileSync(join(s.logins.dirOf(memberScope('acc_bo')), 'vault.json'), 'utf8')).toContain('Bo’s bank');
    // a member can't read secrets at all (the role), nor hand a bot to someone else (admins only); an admin can
    expect(() => checkRole('vault.reveal', { id: 'x', field: 'password' }, bo)).toThrow(/forbidden|not allowed/);
    expect(() => checkRole('bots.update', { id: boBot.id, patch: { memberId: 'acc_ada' } }, bo)).toThrow(/not allowed/);
    expect(() => checkRole('bots.update', { id: boBot.id, patch: { memberId: 'acc_ada' } }, ada)).not.toThrow();
    const moved = s.bots.update(boBot.id, { memberId: 'acc_ada' });
    expect(moved.memberId).toBe('acc_ada');
    expect(() => s.bots.update(boBot.id, { memberId: 'acc_nobody' })).toThrow(/no device/);
    expect(s.bots.update(boBot.id, { memberId: '' }).memberId).toBeUndefined();
    expect(s.logins.botLoginsLine(s.bots.require(boBot.id))).toBe('Uses no one’s logins yet');
    // connected apps are per person too
    expect(s.composioFor(memberScope('acc_ada'))).not.toBe(s.composio);
    expect(s.composioFor(memberScope('acc_ada'))).toBe(s.composioFor(memberScope('acc_ada')));
    expect(s.composioFor('')).toBe(s.composio);
    // a member removes only their own devices
    expect(() => handlers['devices.revoke']({ id: 'ada-mac' }, bo)).toThrow(/admin/);
  });

  it('switching to shared moves every bot onto the team’s logins with its conversation resumed, and back loses nothing', async () => {
    const s = core.services;
    const adaBot = s.bots.list().find((b) => b.name === 'Ada bot')!;
    const before = runtime.created.filter((c) => c.env?.APPUBOT_BOT_ID === adaBot.id).length;
    s.system.setCloudState({ state: 'ok', logins: 'shared' });
    expect(s.logins.own()).toBe(false);
    expect(s.logins.botLoginsLine(adaBot)).toBe('Uses the team’s logins');
    expect(s.logins.scopeOfBot(adaBot)).toBe('');
    const r = s.chat.send({ botId: adaBot.id, text: 'again', attachments: [], images: [] });
    await until(() => runtime.created.filter((c) => c.env?.APPUBOT_BOT_ID === adaBot.id).length > before);
    const reopened = runtime.created.filter((c) => c.env?.APPUBOT_BOT_ID === adaBot.id).at(-1)!;
    expect(reopened.loginHome).toBeUndefined();
    expect(reopened.loginScope).toBeUndefined();
    expect(reopened.resumeSessionId).toBeTruthy();
    await until(() => s.threads.messages(r.userMessage.threadId).some((m) => m.id === r.agentMessageId && m.status === 'complete'));
    // the team's own Vault and keys apply now; Ada's stay where they were
    expect(s.vault.agentList({ botId: adaBot.id, threadId: 't' } as never).items).toEqual([]);
    expect(s.providers.secretEnv('claude-code')).toEqual({ ANTHROPIC_API_KEY: 'team-key' });
    expect(s.vault.list(memberScope('acc_ada')).items.map((i) => i.name)).toEqual(['Ada’s bank']);
    // and back: her own again
    s.system.setCloudState({ state: 'ok', logins: 'own' });
    expect(s.logins.scopeOfBot(adaBot)).toBe('member:acc_ada');
    expect(s.vault.agentList({ botId: adaBot.id, threadId: 't' } as never).items.map((i) => i.name)).toEqual(['Ada’s bank']);
    expect(s.system.cloudInfo()).toMatchObject({ logins: 'own' });
    // the setting survives a restart of the core (the state file)
    expect(JSON.parse(readFileSync(join(core.ctx.paths.dataDir, 'cloud-state.json'), 'utf8'))).toMatchObject({ logins: 'own' });
  });
});
