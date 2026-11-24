/**
 * Agents on demand on an AppuBot Cloud computer: the image ships no agent CLI, and
 * `providers.install` runs the agent's own installer there, non-interactively, into the home folder, instead of
 * opening a terminal as on a Mac. Driven through a fake runner (`deps.updateIo.run`) and a fake runtime whose agents
 * are missing until the "installer" ran.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { cloudInstallLine } from './cloudInstall';

describe('the install line on a cloud computer', () => {
  it('puts npm installs under ~/.local and runs the makers’ own installers as they are', () => {
    expect(cloudInstallLine('npm i -g @openai/codex', '/home/node')).toBe('npm install -g --prefix /home/node/.local --no-fund --no-audit @openai/codex');
    expect(cloudInstallLine('npm i -g opencode-ai', '/home/node')).toBe('npm install -g --prefix /home/node/.local --no-fund --no-audit opencode-ai');
    expect(cloudInstallLine('curl -fsSL https://claude.ai/install.sh | bash', '/home/node')).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(cloudInstallLine('curl https://cursor.com/install -fsS | bash', '/home/node')).toBe('curl https://cursor.com/install -fsS | bash');
  });

  it('refuses what has no meaning on Linux or could run more than an install', () => {
    expect(cloudInstallLine(undefined, '/home/node')).toBeUndefined();
    expect(cloudInstallLine('brew install --cask codex', '/home/node')).toBeUndefined();
    expect(cloudInstallLine('powershell -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"', '/home/node')).toBeUndefined();
    expect(cloudInstallLine('npm i -g x; rm -rf ~', '/home/node')).toBeUndefined();
    expect(cloudInstallLine('curl https://a.example | bash; rm -rf ~', '/home/node')).toBeUndefined();
    expect(cloudInstallLine('curl $(whoami).example | bash', '/home/node')).toBeUndefined();
  });

  it('quotes a home with spaces', () => {
    expect(cloudInstallLine('npm i -g @openai/codex', '/home/my user')).toBe("npm install -g --prefix '/home/my user/.local' --no-fund --no-audit @openai/codex");
  });
});

describe('providers.install on a cloud computer', () => {
  let core: Core;
  let runtime: FakeRuntime;
  let root: string;
  const ran: { command: string; args: string[] }[] = [];
  let release: (() => void) | null = null;
  let result = { ok: true, output: 'added 1 package' };
  const events: Provider[] = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'appubot-cloud-install-'));
    core = createCore({
      paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
      runtime: (hooks) => {
        runtime = new FakeRuntime(hooks);
        // the real built-ins' install hints (the fakes have none)
        const hints: Record<string, string> = { 'claude-code': 'curl -fsSL https://claude.ai/install.sh | bash', codex: 'npm i -g @openai/codex' };
        const get = runtime.getProviders.bind(runtime);
        runtime.getProviders = () => get().map((p) => (hints[p.id] ? { ...p, installHint: hints[p.id] } : p));
        runtime.notInstalled = new Set(['claude-code', 'codex']);
        return runtime;
      },
      openExternal: () => undefined,
      openTerminal: () => { throw new Error('a cloud computer never opens a terminal to install'); },
      nativeNotify: async () => ({ shown: false, error: 'headless' }),
      updateIo: {
        run: async (command, args) => {
          ran.push({ command, args });
          if (release === null) await new Promise<void>((r) => { release = r; });
          // the installer put the CLI in place
          if (result.ok) runtime.notInstalled.delete(args.join(' ').includes('codex') ? 'codex' : 'claude-code');
          return result;
        },
      },
      version: '2026.11.04', hostName: 'AppuBot Cloud', log: silentLogger, validate: true, port: 0, quiet: true,
      computerBackends: () => [], helperTransport: () => null,
      cloud: { publicUrl: '', controlToken: 'c', backendUrl: 'https://cloud.test', backendToken: 'b', maxLiveSessions: 3 },
    });
    await core.start();
    core.ctx.bus.on((e) => { if (e.event === 'provider.updated') events.push(e.payload as Provider); });
    await core.services.providers.refresh();
  });

  afterAll(async () => {
    await core.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const codex = () => core.services.providers.list().find((p) => p.id === 'codex')!;

  it('starts missing, installs into the home folder, shows `installing` meanwhile and joins a second click', async () => {
    expect(codex()).toMatchObject({ installed: false, authStatus: 'not_installed' });
    const first = core.services.providers.install('codex');
    const second = core.services.providers.install('codex');
    await new Promise((r) => setTimeout(r, 10));
    expect(ran).toHaveLength(1);
    // the line itself is pinned above; the home is this computer's (a Windows one where these tests run there)
    expect(ran[0]).toEqual({ command: 'bash', args: ['-lc', cloudInstallLine('npm i -g @openai/codex', homedir())] });
    expect(codex().installing).toBe(true);
    expect(events.some((p) => p.id === 'codex' && p.installing)).toBe(true);
    release!();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ ok: true, output: 'Codex (fake) is installed. Sign in to start using it.' });
    expect(b).toEqual(a);
    expect(codex()).toMatchObject({ installed: true });
    expect(codex().installing).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ id: 'codex', installed: true });
  });

  it('runs Claude Code’s own installer, and says what went wrong when an install fails', async () => {
    ran.length = 0;
    result = { ok: false, output: 'curl: (6) Could not resolve host: claude.ai' };
    const r = await core.services.providers.install('claude-code');
    expect(ran[0]).toEqual({ command: 'bash', args: ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash'] });
    expect(r).toEqual({ ok: false, output: 'curl: (6) Could not resolve host: claude.ai' });
    expect(core.services.providers.list().find((p) => p.id === 'claude-code')).toMatchObject({ installed: false });
  });
});
