/**
 * "Download my bots": the export is a real zip (checked with the system's unzip where there is one) of the bots'
 * folder and the store, with the secrets left out, the Telegram tokens blanked, and the previous export replaced.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { crc32, redactChannels, redactEnv } from './cloudExport';

let core: Core;
let root: string;
const hasUnzip = (() => { try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-export-'));
  const dataDir = join(root, 'data');
  const botsRoot = join(root, 'bots');
  core = createCore({
    paths: { dataDir, botsRoot, filesDir: join(dataDir, 'files'), logsDir: join(dataDir, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'AppuBot Cloud', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    cloud: { publicUrl: 'https://ab12cd34ef.agent37.app', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 3 },
  });
  await core.start();
  const bot = core.services.bots.list()[0]!;
  writeFileSync(join(bot.workspace, 'MEMORY.md'), '# Memory\n- the user likes short answers\n');
  mkdirSync(join(bot.workspace, 'outbox'), { recursive: true });
  writeFileSync(join(bot.workspace, 'outbox', 'report.txt'), 'x'.repeat(5000));
  mkdirSync(join(bot.workspace, 'node_modules', 'left-out'), { recursive: true });
  writeFileSync(join(bot.workspace, 'node_modules', 'left-out', 'index.js'), 'module.exports = 1');
  try { symlinkSync(join(bot.workspace, 'outbox'), join(bot.workspace, 'outbox-link')); } catch { /* no symlinks here */ }
  // secrets and scratch that must stay out
  writeFileSync(join(dataDir, 'agent-keys.json'), '{"claude-code":{"CLAUDE_CODE_OAUTH_TOKEN":"sk-secret"}}');
  writeFileSync(join(dataDir, 'vault.json'), '{"items":[{"secret":"hunter2"}]}');
  mkdirSync(join(dataDir, 'vault-keys'), { recursive: true });
  writeFileSync(join(dataDir, 'vault-keys', 'bot.env'), 'KEY=secret');
  writeFileSync(join(dataDir, 'apps.json'), '{"auth":{"accessToken":"tok"}}');
  writeFileSync(join(dataDir, 'connectors.json'), '{"connectors":[{"headers":{"Authorization":{"v":"Bearer sk-connector"}}}]}');
  writeFileSync(join(dataDir, 'channels.json'), JSON.stringify([{ id: 'telegram', enabled: true, token: '123:abc', allowedUsers: [], status: 'stopped' }]));
  writeFileSync(join(dataDir, 'providers.json'), JSON.stringify({ custom: [{ id: 'x', env: { API_KEY: 'k' } }] }));
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  writeFileSync(join(dataDir, 'logs', 'appubot-2026-11-03.log'), 'log');
  core.services.files.upload(new TextEncoder().encode('an upload'), 'note.txt', 'text/plain');
  core.ctx.store.flush();
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

const listing = (path: string): string[] => execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).trim().split('\n');

describe('the cloud export', () => {
  it('makes a zip of the bots and the store without the secrets, and replaces the previous one', async () => {
    const r = await core.services.cloudExport.export();
    expect(r.name).toMatch(/^appubot-export-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(r.mimeType).toBe('application/zip');
    expect(r.skipped).toEqual([]);
    const rec = core.services.files.getRecord(r.id)!;
    expect(existsSync(rec.storedPath)).toBe(true);
    expect(readFileSync(rec.storedPath).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    if (hasUnzip) {
      // the system's unzip reads every entry back (CRCs and sizes from the data descriptors)
      execFileSync('unzip', ['-tqq', rec.storedPath]);
      const names = listing(rec.storedPath);
      expect(names).toContain('README.txt');
      expect(names.some((n) => /^AppuBot\/[^/]+\/MEMORY\.md$/.test(n))).toBe(true);
      expect(names.some((n) => /^AppuBot\/[^/]+\/outbox\/report\.txt$/.test(n))).toBe(true);
      expect(names.some((n) => n.includes('node_modules'))).toBe(false);
      expect(names.some((n) => n.includes('outbox-link'))).toBe(false);
      expect(names).toContain('appubot-data/channels.json');
      expect(names).toContain('appubot-data/providers.json');
      expect(names).toContain('appubot-data/bots.json');
      expect(names.some((n) => /^appubot-data\/files\/[^/]+\/note\.txt$/.test(n))).toBe(true);
      for (const secret of ['agent-keys.json', 'vault.json', 'vault-keys/bot.env', 'apps.json', 'connectors.json', 'devices.json', 'connect.json', 'logs/appubot-2026-11-03.log', 'cloud-state.json']) {
        expect(names).not.toContain(`appubot-data/${secret}`);
      }
      expect(names.some((n) => n.includes('appubot-export-'))).toBe(false);
      const channels = execFileSync('unzip', ['-p', rec.storedPath, 'appubot-data/channels.json'], { encoding: 'utf8' });
      expect(channels).not.toContain('123:abc');
      expect(JSON.parse(channels)[0]).toMatchObject({ id: 'telegram', enabled: true });
      const providers = execFileSync('unzip', ['-p', rec.storedPath, 'appubot-data/providers.json'], { encoding: 'utf8' });
      expect(providers).not.toContain('"k"');
      const memory = execFileSync('unzip', ['-p', rec.storedPath, names.find((n) => n.endsWith('/MEMORY.md'))!], { encoding: 'utf8' });
      expect(memory).toContain('short answers');
    }
    // a second export replaces the first: one export file registered, the old folder gone
    const r2 = await core.services.cloudExport.export();
    expect(r2.id).not.toBe(r.id);
    expect(existsSync(rec.storedPath)).toBe(false);
    expect(core.ctx.store.files.get().filter((f) => f.name.startsWith('appubot-export-'))).toHaveLength(1);
    // the download path the channel serves
    const res = await fetch(`http://127.0.0.1:${core.gateway.port}/files/${r2.id}?download=1`, { headers: { authorization: `Bearer ${core.ownerToken}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(Number(res.headers.get('content-length'))).toBe(r2.size);
  });

  it('computes CRC-32 and blanks tokens and env values', () => {
    expect(crc32(new TextEncoder().encode('hello')).toString(16)).toBe('3610a686');
    expect(crc32(new Uint8Array(0))).toBe(0);
    // chunked gives the same as whole
    const a = new TextEncoder().encode('the quick brown fox');
    expect(crc32(a.subarray(5), crc32(a.subarray(0, 5)))).toBe(crc32(a));
    expect(JSON.parse(redactChannels('[{"id":"telegram","token":"t"}]'))).toEqual([{ id: 'telegram' }]);
    expect(redactChannels('not json')).toBe('not json');
    expect(JSON.parse(redactEnv('{"custom":[{"id":"x","env":{"A":"1","B":"2"}}],"profile":{"env":{"C":"3"}}}'))).toEqual({ custom: [{ id: 'x', env: { A: '', B: '' } }], profile: { env: { C: '' } } });
  });
});
