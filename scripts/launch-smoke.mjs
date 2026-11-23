#!/usr/bin/env -S npx tsx
/**
 * Launch smoke for CI on macOS, Windows and Linux: starts the built desktop app (`npx electron .` in apps/desktop, an
 * isolated dev-harness instance), then through its gateway checks the platform it reports, makes a bot and its
 * workspace (CLAUDE.md, AGENTS.md, MEMORY.md, `.agents/skills` → `.claude/skills`), and runs a whole agent turn with
 * the fake ACP agent (packages/agent-runtime/test/fake-agent.mjs, started by AppuBot like any agent: `node` found on
 * PATH, a process tree to stop). Needs `pnpm -C packages/mcp-bridge build` and `pnpm -C apps/desktop build` first;
 * on Linux run it under `xvfb-run -a`.
 * Usage: npx tsx scripts/launch-smoke.mjs [--timeout 120]
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { GatewayClient, checkHealth } from '@appubot/client';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const desktop = join(root, 'apps', 'desktop');
const fakeAgent = join(root, 'packages', 'agent-runtime', 'test', 'fake-agent.mjs');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : [])).filter((x) => x.length));
const timeoutMs = Number(args.timeout ?? 120) * 1000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fail = (msg) => { throw new Error(msg); };

const tmp = mkdtempSync(join(tmpdir(), 'appubot-smoke-'));
const devInfo = join(tmp, 'devinfo.json');
const botsRoot = join(tmp, 'bots');
// `require('electron')` from the desktop app is the path of its Electron binary
const electron = createRequire(join(desktop, 'package.json'))('electron');
const app = spawn(electron, ['.', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], {
  cwd: desktop,
  env: { ...process.env, APPUBOT_DATA_DIR: join(tmp, 'data'), APPUBOT_BOTS_ROOT: botsRoot, APPUBOT_PORT: '7999', APPUBOT_DEV_INFO: devInfo, ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'inherit', 'inherit'],
  detached: process.platform !== 'win32',
});

function stopApp() {
  if (app.exitCode !== null || !app.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(-app.pid, 'SIGKILL'); } catch { app.kill('SIGKILL'); }
}

async function waitFor(what, test, ms = timeoutMs) {
  const end = Date.now() + ms;
  for (;;) {
    if (app.exitCode !== null) fail(`the app exited (${app.exitCode}) while waiting for ${what}`);
    const v = await test();
    if (v) return v;
    if (Date.now() > end) fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

let client;
try {
  const info = await waitFor('the dev-info file', () => existsSync(devInfo) && JSON.parse(readFileSync(devInfo, 'utf8')));
  await waitFor('the gateway', async () => (await checkHealth(info.url).catch(() => ({ ok: false }))).ok);
  client = new GatewayClient({
    baseUrl: info.url, token: info.token, WebSocketImpl: WebSocket, callTimeoutMs: 60_000,
    device: { id: 'launch-smoke', name: 'launch smoke', platform: 'cli', appVersion: '0.1.0' },
  });
  await new Promise((res, rej) => { client.onState((s, e) => { if (s === 'connected') res(); if (s === 'unauthorized') rej(new Error(`unauthorized ${e}`)); }); client.connect(); });
  log('connected');

  const sys = await client.call('system.info', {});
  log('system', sys.platform, sys.arch, sys.hostName);
  if (sys.platform !== process.platform) fail(`the app says ${sys.platform}, this is ${process.platform}`);

  // the fake ACP agent, run with the `node` on PATH (on Windows: found through PATHEXT, started without a shell)
  await client.call('providers.upsert', { id: 'smoke', name: 'Smoke agent', command: 'node', args: [fakeAgent], enabled: true });
  const providers = await waitFor('the smoke agent to be installed', async () => {
    const list = await client.call('providers.list', {});
    return list.find((p) => p.id === 'smoke' && p.installed) ? list : null;
  }, 30_000);
  log('agents:', providers.filter((p) => p.installed).map((p) => p.id).join(', '));

  const bot = await client.call('bots.create', { name: 'Smoke', providerId: 'smoke' });
  log('bot', bot.id, bot.workspace);
  for (const f of ['CLAUDE.md', 'AGENTS.md', 'MEMORY.md']) if (!existsSync(join(bot.workspace, f))) fail(`${f} is missing from the workspace`);
  const skills = join(bot.workspace, '.agents', 'skills');
  if (!statSync(skills).isDirectory()) fail('.agents/skills is not a folder');
  if (readdirSync(skills).join() !== readdirSync(join(bot.workspace, '.claude', 'skills')).join()) fail('.agents/skills does not show .claude/skills');
  const claude = readFileSync(join(bot.workspace, 'CLAUDE.md'), 'utf8');
  const machine = process.platform === 'darwin' ? 'Mac' : process.platform === 'win32' ? 'PC' : 'computer';
  if (!claude.includes(`the user's own ${machine} through AppuBot`)) fail(`CLAUDE.md doesn't name this ${machine}`);

  client.on('permission.requested', (req) => {
    const opt = req.options.find((o) => o.kind === 'allow_once') ?? req.options[0];
    void client.call('permissions.respond', { id: req.id, optionId: opt.optionId });
  });
  const completed = new Map();
  client.on('message.completed', (p) => completed.set(p.messageId, p));
  const { agentMessageId } = await client.call('chat.send', { botId: bot.id, text: 'Say hello' });
  const done = await waitFor('the agent turn', () => completed.get(agentMessageId), 60_000);
  const { messages } = await client.call('bots.history', { id: bot.id, limit: 10 });
  const text = (messages.find((m) => m.id === agentMessageId)?.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('');
  log('turn', done.status, JSON.stringify(text));
  if (done.status !== 'complete' || !text.includes('Hello, world')) fail('the agent turn did not complete with its reply');

  log('LAUNCH SMOKE OK');
} catch (e) {
  console.error('LAUNCH SMOKE FAILED:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  client?.close();
  stopApp();
  await new Promise((r) => setTimeout(r, 500));
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* still in use on Windows */ }
}
