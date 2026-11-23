/**
 * Settings › Transfer, the Mac's side: `bots.exportable` lists every bot part by part with sizes and the person's
 * shared skills (`~/.claude/skills`, `~/.agents/skills`; a linked skill followed); `bots.export` with `include` packs
 * only the picked parts plus the picked shared skills (the bot's own skill wins a clash) and says what it packed; the
 * cloud's `bots.import` (unchanged, as old images have it) unpacks exactly that. `skills.getShared` reads one; a phone
 * can't read or pack them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId, type Message } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { checkRole, type CallCtx } from '../handlers';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { ZipReader, resolveInclude, workspacePart } from './botBundle';

let mac: Core;
let cloud: Core;
let root: string;
let home: string;

function makeCore(dir: string, hostName: string, isCloud: boolean, homeDir?: string): Core {
  const dataDir = join(dir, 'data');
  return createCore({
    paths: { dataDir, botsRoot: join(dir, 'bots'), filesDir: join(dataDir, 'files'), logsDir: join(dataDir, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName, log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    ...(homeDir ? { homeDir } : {}),
    ...(isCloud ? { cloud: { publicUrl: 'https://ab12cd34ef.agent37.app', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 3 } } : {}),
  });
}

function skill(dir: string, name: string, description: string, body: string, extra?: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`);
  for (const [f, text] of Object.entries(extra ?? {})) writeFileSync(join(dir, f), text);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-transfer-'));
  home = join(root, 'home');
  // the person's shared skills: one in Claude Code's folder (a link to where its maker keeps it), one in the shared
  // agents folder, one clashing with a bot's own, one with no SKILL.md (not a skill)
  skill(join(root, 'elsewhere', 'tidy-desk'), 'tidy-desk', 'Tidies the desktop', 'Move loose files into folders.', { 'tidy.sh': 'echo tidy' });
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  symlinkSync(join(root, 'elsewhere', 'tidy-desk'), join(home, '.claude', 'skills', 'tidy-desk'));
  skill(join(home, '.agents', 'skills', 'write-mail'), 'write-mail', 'Writes a mail', 'Short and kind.');
  skill(join(home, '.agents', 'skills', 'file-invoice'), 'file-invoice', 'A shared one', 'The shared version.');
  mkdirSync(join(home, '.claude', 'skills', 'not-a-skill'), { recursive: true });
  mac = makeCore(join(root, 'mac'), 'Sarthak’s MacBook Pro', false, home);
  cloud = makeCore(join(root, 'cloud'), 'Sarthak’s Cloud Computer', true);
  await mac.start();
  await cloud.start();

  const s = mac.services;
  const bot = s.bots.create({ name: 'Ada', job: 'Books', instructions: 'Be brief.', providerId: 'claude-code', color: '#123456', shape: 'squircle', modeId: 'auto' });
  writeFileSync(join(bot.workspace, 'MEMORY.md'), '# Memory\n- likes short answers\n');
  s.skills.save(bot.id, 'file-invoice', 'Files an invoice', '1. Open the folder\n2. Drop it in');
  mkdirSync(join(bot.workspace, 'outbox'), { recursive: true });
  writeFileSync(join(bot.workspace, 'outbox', 'report.txt'), 'the report');
  const thread = s.threads.chatFor(bot.id);
  const att = s.files.upload(new TextEncoder().encode('an invoice'), 'invoice.pdf', 'application/pdf', thread.id);
  const now = Date.now();
  const messages: Message[] = [
    { id: newId('msg'), threadId: thread.id, role: 'user', parts: [{ type: 'text', text: 'file this' }, { type: 'file', file: att }], status: 'complete', via: 'desktop', rev: 1, createdAt: now, updatedAt: now },
    { id: newId('msg'), threadId: thread.id, role: 'agent', parts: [{ type: 'text', text: 'Filed.' }], status: 'complete', via: 'desktop', rev: 1, createdAt: now + 1, updatedAt: now + 1 },
  ];
  mac.ctx.store.threads.setMessages(thread.id, messages);
  s.routines.create({ botId: bot.id, name: 'Morning', prompt: 'Check the inbox', schedule: '0 9 * * *', enabled: true, deliverTo: 'notify' });
  mac.ctx.store.flush();
});

afterAll(async () => {
  await mac.stop();
  await cloud.stop();
  rmSync(root, { recursive: true, force: true });
});

const ada = () => mac.services.bots.list().find((b) => b.name === 'Ada')!;

describe('what a transfer could carry', () => {
  it('lists each bot part by part with sizes', () => {
    const ex = mac.services.botBundle.exportable();
    expect(ex.hostName).toBe('Sarthak’s MacBook Pro');
    const item = ex.bots.find((b) => b.bot.id === ada().id)!;
    expect(item.memory.bytes).toBeGreaterThan(10);
    expect(item.skills.names).toEqual(['file-invoice']);
    expect(item.skills.bytes).toBeGreaterThan(0);
    // outbox/report.txt and the chat's file's inbox copy (the generated CLAUDE.md is never counted: it is remade there)
    expect(item.files).toEqual({ count: 2, bytes: 'the report'.length + 'an invoice'.length });
    expect(item.routines.count).toBe(1);
    expect(item.chats.threads).toBe(1);
    expect(item.chats.messages).toBe(2);
    // the chat's file counts towards its chats
    expect(item.chats.bytes).toBeGreaterThanOrEqual('an invoice'.length);
  });

  it('lists the shared skills, following a linked one, first of a name winning', () => {
    const shared = mac.services.botBundle.exportable().sharedSkills;
    expect(shared.map((x) => [x.name, x.from])).toEqual([['tidy-desk', 'claude'], ['file-invoice', 'agents'], ['write-mail', 'agents']]);
    expect(shared.find((x) => x.name === 'tidy-desk')).toMatchObject({ description: 'Tidies the desktop', files: 2 });
    expect(mac.services.botBundle.sharedSkill('write-mail')).toMatchObject({ name: 'write-mail', description: 'Writes a mail', body: 'Short and kind.', files: 1 });
    expect(() => mac.services.botBundle.sharedSkill('not-a-skill')).toThrow(/no shared skill/);
    expect(() => mac.services.botBundle.sharedSkill('../../etc')).toThrow(/no shared skill/);
  });

  it('sorts a bot’s folder into its parts', () => {
    expect(workspacePart('MEMORY.md')).toBe('memory');
    expect(workspacePart('.claude/skills/x/SKILL.md')).toBe('skills');
    expect(workspacePart('outbox/report.txt')).toBe('files');
    expect(workspacePart('notes/MEMORY.md')).toBe('files');
    expect(resolveInclude(undefined)).toEqual({ memory: true, skills: true, files: true, routines: true, chats: true });
    expect(resolveInclude({ chats: false })).toMatchObject({ chats: false, memory: true });
  });
});

describe('a picked transfer', () => {
  it('packs only the picked parts and shared skills, and an old cloud import unpacks exactly that', async () => {
    const { file, included, manifest } = await mac.services.botBundle.export(ada().id, undefined, {
      include: { memory: true, skills: true, files: false, routines: false, chats: false },
      sharedSkills: ['tidy-desk', 'file-invoice', 'nonexistent'],
    });
    // the bot's own file-invoice wins; a name not on the list is ignored
    expect(included).toEqual({ memory: true, skills: true, files: false, routines: false, chats: false, sharedSkills: ['tidy-desk'] });
    expect(manifest.counts).toMatchObject({ threads: 0, messages: 0, routines: 0, files: 0, skills: 2 });
    const zip = new ZipReader(readFileSync(mac.services.files.getRecord(file.id)!.storedPath));
    const names = zip.entries().map((e) => e.name);
    expect(names).toContain('workspace/MEMORY.md');
    expect(names).toContain('workspace/.claude/skills/file-invoice/SKILL.md');
    expect(names).toContain('workspace/.claude/skills/tidy-desk/SKILL.md');
    expect(names).toContain('workspace/.claude/skills/tidy-desk/tidy.sh');
    expect(names.some((n) => n.startsWith('workspace/outbox'))).toBe(false);
    expect(names.some((n) => n.startsWith('threads/') || n.startsWith('files/'))).toBe(false);
    expect(zip.read('workspace/.claude/skills/file-invoice/SKILL.md')!.toString()).toContain('Open the folder');
    expect(JSON.parse(zip.read('routines.json')!.toString())).toEqual([]);

    const up = cloud.services.files.upload(readFileSync(mac.services.files.getRecord(file.id)!.storedPath), file.name, 'application/zip');
    const r = await cloud.services.botBundle.import({ fileId: up.id, routines: false });
    expect(r.bot).toMatchObject({ name: 'Ada', job: 'Books', instructions: 'Be brief.', color: '#123456' });
    expect(r.counts).toEqual({ threads: 0, messages: 0, routines: 0, skills: 2, files: 0 });
    expect(readFileSync(join(r.bot.workspace, 'MEMORY.md'), 'utf8')).toContain('likes short answers');
    expect(cloud.services.skills.list(r.bot.id).map((k) => k.name).sort()).toEqual(['file-invoice', 'tidy-desk']);
    expect(existsSync(join(r.bot.workspace, '.claude', 'skills', 'tidy-desk', 'tidy.sh'))).toBe(true);
    expect(existsSync(join(r.bot.workspace, 'outbox', 'report.txt'))).toBe(false);
    expect(cloud.services.threads.list({ limit: 100 }).filter((t) => t.botId === r.bot.id).every((t) => cloud.services.threads.messages(t.id).length === 0)).toBe(true);
    // one way: the Mac keeps its bot, chat and routine
    expect(mac.services.bots.get(ada().id)).toBeDefined();
    expect(mac.services.routines.list().filter((x) => x.botId === ada().id)).toHaveLength(1);
  });

  it('packs the whole bot when nothing is picked (the Move dialog)', async () => {
    const { included, manifest } = await mac.services.botBundle.export(ada().id);
    expect(included).toEqual({ memory: true, skills: true, files: true, routines: true, chats: true, sharedSkills: [] });
    expect(manifest.counts).toMatchObject({ threads: 1, messages: 2, routines: 1, files: 1, skills: 1, workspaceFiles: 4 });
  });

  it('keeps shared skills to the computer’s own window', () => {
    const phone: CallCtx = { role: 'full', deviceId: 'phone' };
    expect(() => checkRole('skills.getShared', { name: 'tidy-desk' }, phone)).toThrow(/not allowed/);
    expect(() => checkRole('bots.export', { id: 'b', sharedSkills: ['tidy-desk'] }, phone)).toThrow(/not allowed/);
    expect(() => checkRole('bots.export', { id: 'b', include: { chats: false } }, phone)).not.toThrow();
    expect(() => checkRole('bots.exportable', {}, phone)).not.toThrow();
    expect(() => checkRole('skills.getShared', { name: 'tidy-desk' }, { role: 'owner', deviceId: 'mac' })).not.toThrow();
  });
});
