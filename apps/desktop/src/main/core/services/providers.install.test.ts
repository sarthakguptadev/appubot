/**
 * Settings › Agents › Install on a person's own computer (Windows, macOS and Linux alike): Codex comes as AppuBot's own
 * download of its native build (no npm, no terminal), Claude Code through Anthropic's installer run in the background,
 * with `installing` on the row meanwhile and the row re-checked after, so it reads "Not logged in". Driven through a
 * fake download (`deps.nativeInstall`), a fake runner (`deps.updateIo.run`) and a fake runtime whose agents are missing
 * until installed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from '@appubot/protocol';
import { builtinInstallHint } from '@appubot/agent-runtime';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import type { NativeInstallOptions } from './nativeInstall';

describe('providers.install on a person’s own computer', () => {
  let core: Core;
  let runtime: FakeRuntime;
  let root: string;
  const downloads: { agent: string; o: NativeInstallOptions }[] = [];
  const ran: { command: string; args: string[] }[] = [];
  let release: (() => void) | null = null;
  const events: Provider[] = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'appubot-install-'));
    core = createCore({
      paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
      runtime: (hooks) => {
        runtime = new FakeRuntime(hooks);
        const get = runtime.getProviders.bind(runtime);
        // the real built-ins' install lines for this platform (the fakes have none)
        runtime.getProviders = () => get().map((p) => ({ ...p, installHint: builtinInstallHint(p.id) }));
        runtime.notInstalled = new Set(['claude-code', 'codex']);
        return runtime;
      },
      openExternal: () => undefined,
      openTerminal: () => { throw new Error('nothing here needs a terminal to install'); },
      nativeNotify: async () => ({ shown: false, error: 'headless' }),
      nativeInstall: async (agent, o) => {
        downloads.push({ agent, o });
        if (release === null) await new Promise<void>((r) => { release = r; });
        runtime.notInstalled.delete(agent);
        return { ok: true, output: `${agent} is installed.` };
      },
      updateIo: {
        run: async (command, args) => {
          ran.push({ command, args });
          runtime.notInstalled.delete('claude-code');
          return { ok: true, output: '' };
        },
      },
      homeDir: join(root, 'home'),
      version: '0.0.0-test', hostName: 'test', log: silentLogger, validate: true, port: 0, quiet: true,
      computerBackends: () => [], helperTransport: () => null,
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

  it('downloads Codex’s own build into AppuBot’s folder, shows installing meanwhile, and finds it after', async () => {
    // no npm line to show: AppuBot installs it itself
    expect(codex()).toMatchObject({ installed: false, authStatus: 'not_installed' });
    expect(codex().installHint).toBeUndefined();
    const first = core.services.providers.install('codex');
    const second = core.services.providers.install('codex');
    await new Promise((r) => setTimeout(r, 10));
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatchObject({ agent: 'codex', o: { dir: join(root, 'data', 'agents', 'codex'), home: join(root, 'home') } });
    expect(codex().installing).toBe(true);
    expect(events.some((p) => p.id === 'codex' && p.installing)).toBe(true);
    release!();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ ok: true, output: 'Codex (fake) is installed. Sign in to start using it.' });
    expect(b).toEqual(a);
    expect(codex()).toMatchObject({ installed: true });
    expect(codex().installing).toBeUndefined();
  });

  it('runs Anthropic’s own installer for Claude Code in the background: PowerShell on Windows, bash elsewhere', async () => {
    const r = await core.services.providers.install('claude-code');
    expect(r).toEqual({ ok: true, output: 'Claude Code (fake) is installed. Sign in to start using it.' });
    expect(ran).toHaveLength(1);
    if (process.platform === 'win32') expect(ran[0]).toEqual({ command: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'] });
    else expect(ran[0]).toEqual({ command: 'bash', args: ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash'] });
  });
});
