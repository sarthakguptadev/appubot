/**
 * Moving a bot: one computer packs a bot (its setup, memory, a skill, a file in its folder, a chat with a file, a
 * routine, the character it wears) into a bundle with no secret in it; another computer unpacks it into a new bot of
 * its own with the chat's file under a new id, the routine made again, the agent mapped to what it has, and notes on
 * what to set up by hand. The bundle refuses paths outside the bot's folder.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId, type Message } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { ZipReader, fileIdsIn, safeRelative } from './botBundle';

let a: Core;
let b: Core;
let root: string;

function makeCore(dir: string, hostName: string, cloud: boolean): Core {
  const dataDir = join(dir, 'data');
  return createCore({
    paths: { dataDir, botsRoot: join(dir, 'bots'), filesDir: join(dataDir, 'files'), logsDir: join(dataDir, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName, log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    ...(cloud ? { cloud: { publicUrl: 'https://ab12cd34ef.agent37.app', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 3 } } : {}),
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-bundle-'));
  a = makeCore(join(root, 'a'), 'My Mac', false);
  b = makeCore(join(root, 'b'), 'AppuBot Cloud', true);
  await a.start();
  await b.start();
});

afterAll(async () => {
  await a.stop();
  await b.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('a bot’s bundle', () => {
  it('carries the bot, its memory, skills, files, chats and routines, and nothing secret', async () => {
    const s = a.services;
    const bot = s.bots.create({ name: 'Ada', job: 'Books', instructions: 'Be brief.', providerId: 'claude-code', computerUse: true, color: '#123456', shape: 'squircle' });
    writeFileSync(join(bot.workspace, 'MEMORY.md'), '# Memory\n- likes short answers\n');
    s.skills.save(bot.id, 'file-invoice', 'Files an invoice', '1. Open the folder\n2. Drop it in');
    mkdirSync(join(bot.workspace, 'outbox'), { recursive: true });
    writeFileSync(join(bot.workspace, 'outbox', 'report.txt'), 'the report');
    mkdirSync(join(bot.workspace, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(bot.workspace, 'node_modules', 'x', 'index.js'), '1');
    // a chat with a user message that carries a file, and a reply
    const thread = s.threads.chatFor(bot.id);
    const att = s.files.upload(new TextEncoder().encode('an invoice'), 'invoice.pdf', 'application/pdf', thread.id);
    const now = Date.now();
    const messages: Message[] = [
      { id: newId('msg'), threadId: thread.id, role: 'user', parts: [{ type: 'text', text: 'file this' }, { type: 'file', file: att }], status: 'complete', via: 'desktop', rev: 1, createdAt: now, updatedAt: now },
      { id: newId('msg'), threadId: thread.id, role: 'agent', parts: [{ type: 'text', text: 'Filed.' }], status: 'complete', via: 'desktop', rev: 1, createdAt: now + 1, updatedAt: now + 1 },
    ];
    a.ctx.store.threads.setMessages(thread.id, messages);
    s.routines.create({ botId: bot.id, name: 'Morning', prompt: 'Check the inbox', schedule: '0 9 * * *', enabled: true, deliverTo: 'notify' });
    // secrets around it that must stay out
    writeFileSync(join(a.ctx.paths.dataDir, 'agent-keys.json'), '{"claude-code":{"CLAUDE_CODE_OAUTH_TOKEN":"sk-secret"}}');
    a.ctx.store.flush();

    const { file, manifest } = await s.botBundle.export(bot.id);
    expect(file.name).toBe('ada.appubot-bot.zip');
    expect(manifest.bot).toMatchObject({ name: 'Ada', providerId: 'claude-code', computerUse: true });
    expect(manifest.counts).toMatchObject({ threads: 1, messages: 2, routines: 1, skills: 1, files: 1 });
    expect(manifest.from).toMatchObject({ hostName: 'My Mac', cloud: false });
    const rec = s.files.getRecord(file.id)!;
    const zip = new ZipReader(readFileSync(rec.storedPath));
    const names = zip.entries().map((e) => e.name);
    expect(names).toContain('bot.json');
    expect(names).toContain('workspace/MEMORY.md');
    expect(names).toContain('workspace/.claude/skills/file-invoice/SKILL.md');
    expect(names).toContain('workspace/outbox/report.txt');
    expect(names.some((n) => n.includes('node_modules'))).toBe(false);
    // the generated instructions are remade on the other side
    expect(names).not.toContain('workspace/CLAUDE.md');
    expect(names.filter((n) => n.startsWith('threads/'))).toHaveLength(1);
    expect(names.filter((n) => n.startsWith('files/'))).toHaveLength(1);
    const all = Buffer.concat(names.map((n) => zip.read(n)!)).toString('utf8');
    expect(all).not.toContain('sk-secret');
    expect(zip.read('workspace/MEMORY.md')!.toString()).toContain('likes short answers');

    // a second export replaces the first
    const again = await s.botBundle.export(bot.id);
    expect(s.files.getRecord(file.id)).toBeUndefined();
    expect(s.files.getRecord(again.file.id)).toBeDefined();
  });

  it('unpacks on another computer: a bot of its own, the chat with its file under a new id, the routine, the notes', async () => {
    const sa = a.services, sb = b.services;
    const bot = sa.bots.list().find((x) => x.name === 'Ada')!;
    const { file } = await sa.botBundle.export(bot.id);
    const bytes = readFileSync(sa.files.getRecord(file.id)!.storedPath);
    // carried over by the device: uploaded to the other computer
    const up = sb.files.upload(bytes, file.name, 'application/zip');
    const r = await sb.botBundle.import({ fileId: up.id });
    expect(r.bot.name).toBe('Ada');
    expect(r.bot.id).not.toBe(bot.id);
    expect(r.bot.workspace).toBe(join(b.ctx.paths.botsRoot, 'ada'));
    expect(r.bot.job).toBe('Books');
    expect(r.bot.instructions).toBe('Be brief.');
    expect(r.bot.color).toBe('#123456');
    expect(r.counts).toEqual({ threads: 1, messages: 2, routines: 1, skills: 1, files: 1 });
    expect(readFileSync(join(r.bot.workspace, 'MEMORY.md'), 'utf8')).toContain('likes short answers');
    expect(existsSync(join(r.bot.workspace, 'outbox', 'report.txt'))).toBe(true);
    expect(sb.skills.list(r.bot.id).map((k) => k.name)).toEqual(['file-invoice']);
    // the generated instructions here say where it runs (the cloud computer's own)
    expect(readFileSync(join(r.bot.workspace, 'CLAUDE.md'), 'utf8')).toContain('<!-- Generated by AppuBot.');
    const threads = sb.threads.list({ limit: 100 }).filter((t) => t.botId === r.bot.id);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.acpSessionId).toBeUndefined();
    expect(threads[0]!.cwd).toBe(r.bot.workspace);
    const msgs = sb.threads.messages(threads[0]!.id);
    expect(msgs).toHaveLength(2);
    const filePart = msgs[0]!.parts.find((p) => p.type === 'file') as { file: { id: string; url: string } };
    expect(filePart.file.id).not.toBe(fileIdsIn(sa.threads.messages(sa.threads.list({ limit: 100 }).find((t) => t.botId === bot.id)!.id)[0]!)[0]);
    const moved = sb.files.getRecord(filePart.file.id)!;
    expect(readFileSync(moved.storedPath, 'utf8')).toBe('an invoice');
    expect(filePart.file.url).toBe(`/files/${moved.id}`);
    expect(sb.routines.list().filter((x) => x.botId === r.bot.id).map((x) => x.name)).toEqual(['Morning']);
    // the uploaded bundle is scratch once read
    expect(sb.files.getRecord(up.id)).toBeUndefined();
    // what to set up by hand: logins never travel
    expect(r.notes.join('\n')).toMatch(/Claude Code|logins|keys/);
    // moved: the source lets it go with its folder
    await sa.bots.delete(bot.id, true);
    expect(sa.bots.get(bot.id)).toBeUndefined();
    expect(existsSync(bot.workspace)).toBe(false);
  });

  it('refuses what isn’t a bundle, and paths that would leave the bot’s folder', async () => {
    const sb = b.services;
    const up = sb.files.upload(new TextEncoder().encode('not a zip'), 'x.zip', 'application/zip');
    await expect(sb.botBundle.import({ fileId: up.id })).rejects.toThrow(/bot bundle/);
    expect(safeRelative('../../etc/passwd')).toBe('');
    expect(safeRelative('/etc/passwd')).toBe('');
    expect(safeRelative('a/../../b')).toBe('');
    expect(safeRelative('inbox/a.txt')).toBe('inbox/a.txt');
    expect(safeRelative('a/./b.txt')).toBe('a/b.txt');
  });
});
