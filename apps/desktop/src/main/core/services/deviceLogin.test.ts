/**
 * An agent's CLI login run for a phone: what Codex's and Claude Code's output reads as (link, code, expiry, paste
 * prompt), the pseudo-terminal wrapper per OS, and the runner over a stand-in CLI (a node script that prints a link
 * and a code, waits for the code pasted back, then exits): its `provider.login` events, `code`, `cancel`, failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceLogin } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { readLoginOutput, withPty } from './deviceLogin';

const CODEX = `
Welcome to Codex [v\u001b[90m0.166.0\u001b[0m]

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m

2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m
   \u001b[94mXXIR-AYQYT\u001b[0m
`;
const CLAUDE = `Browser didn't open? Use the url below to sign in:\n\nhttps://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz\n\nPaste code here if prompted > `;

describe('readLoginOutput', () => {
  it('reads Codex’s link, code and expiry', () => {
    const r = readLoginOutput(CODEX, 1_000_000);
    expect(r).toEqual({ url: 'https://auth.openai.com/codex/device', code: 'XXIR-AYQYT', expiresAt: 1_000_000 + 15 * 60_000 });
  });
  it('reads Claude Code’s link and paste prompt', () => {
    const r = readLoginOutput(CLAUDE, 0);
    expect(r).toEqual({ url: 'https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz', prompt: 'Paste code here if prompted >' });
  });
  it('wraps a tty login in script where there is one', () => {
    const cmd = { command: '/usr/bin/claude', args: ['setup-token'], env: {}, pty: true };
    expect(withPty(cmd, 'linux')).toMatchObject({ command: 'script', args: ['-qfec', '/usr/bin/claude setup-token', '/dev/null'] });
    expect(withPty(cmd, 'darwin')).toMatchObject({ command: 'script', args: ['-q', '/dev/null', '/usr/bin/claude', 'setup-token'] });
    expect(withPty(cmd, 'win32')).toBe(cmd);
    expect(withPty({ ...cmd, pty: false }, 'linux')).toMatchObject({ command: '/usr/bin/claude' });
  });
});

describe('DeviceLoginService', () => {
  let core: Core;
  let root: string;
  let script: string;
  const events: DeviceLogin[] = [];
  const until = async (test: () => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (!test()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'appubot-device-login-'));
    script = join(root, 'login.cjs');
    writeFileSync(script, `
      const mode = process.argv[2];
      if (mode === 'fail') { console.error('login failed: no network'); process.exit(3); }
      if (mode === 'token') { console.log('Open this link: https://auth.example.test/oauth'); console.log('Long-lived authentication token:'); console.log('sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE'); process.exit(0); }
      if (mode === 'notoken') { console.log('Something else happened.'); process.exit(0); }
      if (mode === 'relay') {
        // a CLI whose sign-in comes back to its own listener here, its page opened through BROWSER
        const server = require('node:http').createServer((req, res) => {
          const u = new URL(req.url, 'http://localhost');
          if (u.pathname !== '/callback' || u.searchParams.get('state') !== 's123') { res.writeHead(400).end(); return; }
          res.writeHead(302, { location: 'https://auth.example.test/done' }).end();
          console.log('Login successful for code ' + u.searchParams.get('code'));
          server.close(() => process.exit(0));
        });
        server.listen(0, '127.0.0.1', () => {
          const back = encodeURIComponent('http://localhost:' + server.address().port + '/callback');
          const page = 'https://auth.example.test/authorize?response_type=code&state=s123&redirect_uri=' + back;
          // Windows has no BROWSER that catches a page: its agents print the link, which is read instead
          if (process.platform === 'win32') console.log('Open this page to sign in: ' + page);
          else require('node:child_process').execFileSync(process.env.BROWSER, [page]);
          console.log('Waiting for the browser...');
        });
        setTimeout(() => process.exit(4), 20000);
        return;
      }
      if (mode === 'here') {
        // for this computer's own window: its BROWSER is the person's own, and a link back here is no relay
        if (!String(process.env.BROWSER ?? '').includes('login-links')) console.log('   HERE-BRWSR1');
        console.log('Opening browser to sign in: https://auth.example.test/authorize?redirect_uri=' + encodeURIComponent('http://localhost:4321/callback'));
        process.stdout.write('Paste code here if prompted > ');
        process.stdin.on('data', () => { console.log('Signed in.'); process.exit(0); });
        setTimeout(() => process.exit(4), 20000);
        return;
      }
      console.log('Open this link in your browser: https://auth.example.test/device');
      console.log('Enter this one-time code (expires in 15 minutes)');
      console.log('   ABCD-EFGHI');
      process.stdout.write('Paste code here if prompted > ');
      let buf = '';
      process.stdin.on('data', (d) => { buf += d; if (buf.includes('\\n')) { if (buf.trim() === 'good') { console.log('Signed in.'); console.log('Long-lived authentication token: sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE'); process.exit(0); } console.log('Bad code'); process.exit(2); } });
      setTimeout(() => process.exit(4), 20000);
    `);
    core = createCore({
      paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
      runtime: (hooks) => new FakeRuntime(hooks),
      openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
      version: '0.0.0-test', hostName: 'test', log: silentLogger, validate: true, port: 0, quiet: true,
      computerBackends: () => [], helperTransport: () => null,
      // no method: Claude Code's `setup-token` stand-in (a token printed); a method: a CLI that saves its own login
      deviceLoginCommand: async (id, methodId) => (id === 'nope' ? null : { command: process.execPath, args: [script, methodId ?? ''], env: {}, token: !methodId }),
    });
    await core.start();
    core.ctx.bus.on((e) => { if (e.event === 'provider.login') events.push(e.payload as DeviceLogin); });
  });

  afterAll(async () => {
    await core.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const providerId = () => core.services.providers.list()[0]!.id;

  it('runs the login, shows the link and code, takes the pasted code and finishes', async () => {
    const id = providerId();
    const svc = core.services.deviceLogin;
    expect(svc.status(id)).toBeNull();
    const first = await svc.start(id);
    expect(first).toMatchObject({ id, state: 'starting' });
    await until(() => svc.status(id)?.state === 'waiting' && !!svc.status(id)?.prompt);
    expect(svc.status(id)).toMatchObject({ url: 'https://auth.example.test/device', code: 'ABCD-EFGHI', prompt: 'Paste code here if prompted >', expiresAt: expect.any(Number) });
    // starting again while it runs returns the same login
    expect((await svc.start(id)).startedAt).toBe(first.startedAt);
    const after = await svc.code(id, 'good');
    expect(after.prompt).toBeUndefined();
    await until(() => svc.status(id)?.state === 'done' || svc.status(id)?.state === 'failed');
    expect(svc.status(id)).toMatchObject({ state: 'done', message: expect.stringMatching(/signed in/) });
    // Claude Code's `setup-token` saves nothing itself: the token it printed is now its key login
    expect(core.services.providers.list().find((p) => p.id === id)?.keysSaved).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(events.map((e) => e.state)).toEqual(expect.arrayContaining(['waiting', 'done']));
    await expect(svc.code(id, 'late')).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('catches the page a CLI opens, and finishes a sign-in that comes back to it here', async () => {
    const id = providerId();
    const svc = core.services.deviceLogin;
    await svc.start(id, 'relay');
    await until(() => !!svc.status(id)?.relay);
    const login = svc.status(id)!;
    expect(login).toMatchObject({ state: 'waiting', url: expect.stringContaining('https://auth.example.test/authorize'), relay: { path: '/callback', port: expect.any(Number) } });
    const port = login.relay!.port;
    // another sign-in's return, or another port, is refused; the agent never hears of it
    await expect(svc.finish(id, `http://localhost:${port}/callback?code=abc&state=other`)).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(svc.finish(id, `http://localhost:${port + 1}/callback?code=abc&state=s123`)).rejects.toMatchObject({ code: 'invalid_params' });
    // the address as a browser shows it (no http://) is handed to the CLI's listener, which finishes
    await svc.finish(id, `localhost:${port}/callback?code=abc&state=s123`);
    await until(() => svc.status(id)?.state === 'done' || svc.status(id)?.state === 'failed');
    expect(svc.status(id)).toMatchObject({ state: 'done' });
    await expect(svc.finish(id, `http://localhost:${port}/callback?code=abc&state=s123`)).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('runs a login for this computer’s own window in the app: the agent opens its own page, nothing is relayed', async () => {
    const id = providerId();
    const svc = core.services.deviceLogin;
    await svc.start(id, 'here', '', true);
    await until(() => !!svc.status(id)?.prompt);
    const login = svc.status(id)!;
    expect(login).toMatchObject({ state: 'waiting', url: expect.stringContaining('https://auth.example.test/authorize'), code: 'HERE-BRWSR1', prompt: 'Paste code here if prompted >' });
    expect(login.relay).toBeUndefined();
    await expect(svc.finish(id, 'http://localhost:4321/callback?code=abc')).rejects.toMatchObject({ code: 'invalid_state' });
    await svc.code(id, 'the-code-from-the-page');
    await until(() => svc.status(id)?.state === 'done' || svc.status(id)?.state === 'failed');
    expect(svc.status(id)).toMatchObject({ state: 'done' });
  });

  it('reports a failed login with the CLI’s last words, and a cancel ends a running one', async () => {
    const id = providerId();
    const svc = core.services.deviceLogin;
    await svc.start(id, 'fail');
    await until(() => svc.status(id)?.state === 'failed');
    expect(svc.status(id)!.message).toMatch(/no network/);
    await svc.start(id);
    await until(() => svc.status(id)?.state === 'waiting');
    expect(svc.cancel(id)).toEqual({ ok: true });
    expect(svc.status(id)).toMatchObject({ state: 'failed', message: 'Cancelled.' });
    await expect(svc.start('nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});
