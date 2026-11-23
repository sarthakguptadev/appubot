/**
 * Provider updates: version order, how a CLI updates, and the check/update flow against a fake network (npm,
 * Homebrew, the ACP registry) and a fake Mac (`deps.updateIo`: which CLIs are on PATH, the update commands run).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { checkRole } from '../handlers';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { REGISTRY_URL } from './acpRegistry';
import { BREW_API, CLI_UPDATES, NPM_REGISTRY, compareVersions, installKind, isNewer, latestSource, updateCommand } from './providerUpdates';

describe('versions', () => {
  it('orders semver, any number of parts, and prereleases before their release', () => {
    expect(compareVersions('2.0.14', '2.0.9')).toBe(1);
    expect(compareVersions('2.0.9', '2.0.14')).toBe(-1);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('v1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBe(1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compareVersions('2026.09.18-9a7762b', '2026.10.02-1b2c3d4')).toBe(-1);
  });

  it('reads versions out of --version lines', () => {
    expect(compareVersions('2.0.14 (Claude Code)', '2.0.14')).toBe(0);
    expect(isNewer('0.47.0', 'codex-cli 0.46.0')).toBe(true);
  });

  it('isNewer is false when either side is missing or unreadable', () => {
    expect(isNewer('1.0.0', undefined)).toBe(false);
    expect(isNewer(undefined, '1.0.0')).toBe(false);
    expect(isNewer('latest', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', '1.0.1')).toBe(false);
  });
});

describe('how a CLI updates', () => {
  const claude = CLI_UPDATES['claude-code']!;
  const codex = CLI_UPDATES.codex!;
  it('tells Homebrew, npm and other installs apart by the real path', () => {
    expect(installKind('/opt/homebrew/Caskroom/claude-code/2.0.14/claude')).toBe('brew-cask');
    expect(installKind('/opt/homebrew/Cellar/codex/0.46.0/bin/codex')).toBe('brew-formula');
    expect(installKind('/Users/me/.nvm/versions/node/v22/lib/node_modules/@openai/codex/bin/codex.js')).toBe('npm');
    expect(installKind('/Users/me/.local/share/claude/versions/2.0.14')).toBe('other');
    // Linux's Homebrew, Windows' npm (the shim's target) and the native Windows install
    expect(installKind('/home/linuxbrew/.linuxbrew/Cellar/codex/0.46.0/bin/codex')).toBe('brew-formula');
    expect(installKind('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js')).toBe('npm');
    expect(installKind('C:\\Users\\me\\.local\\bin\\claude.exe')).toBe('other');
  });

  it('prefers Homebrew, then the CLI own updater, then npm', () => {
    expect(updateCommand(claude, 'brew-cask', '/opt/homebrew/bin/claude')?.label).toBe('brew upgrade claude-code');
    expect(updateCommand(claude, 'other', '/Users/me/.local/bin/claude')).toEqual({ command: '/Users/me/.local/bin/claude', args: ['update'], label: 'claude update' });
    expect(updateCommand(codex, 'npm', '/usr/local/bin/codex')).toEqual({ command: 'npm', args: ['i', '-g', '@openai/codex@latest'], label: 'npm i -g @openai/codex@latest' });
    expect(updateCommand(codex, 'other', '/somewhere/codex')).toBeUndefined();
  });

  it('compares a Homebrew install against Homebrew, the rest against npm', () => {
    expect(latestSource(codex, 'brew-cask').url).toBe(`${BREW_API}/cask/codex.json`);
    expect(latestSource(codex, 'brew-formula').pick({ versions: { stable: '0.47.0' } })).toBe('0.47.0');
    expect(latestSource(claude, 'other').url).toBe(`${NPM_REGISTRY}/@anthropic-ai/claude-code/latest`);
  });
});

describe('checking and updating', () => {
  let core: Core;
  let root: string;
  const served = new Map<string, () => Response>();
  const fetched: string[] = [];
  const ran: string[] = [];
  /** the CLIs on this fake Mac */
  const clis = new Map<string, { bin: string; realPath: string; version?: string }>();
  let runResult = { ok: true, output: 'updated' };

  const serveRegistry = (version: string) => served.set(REGISTRY_URL, () => Response.json({
    agents: [{ id: 'zapper', name: 'Zapper', version, distribution: { npx: { package: `zapper-acp@${version}`, args: ['acp'] } } }],
  }));
  const find = (list: Provider[], id: string) => list.find((p) => p.id === id)!;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'appubot-updates-'));
    const data = join(root, 'data');
    mkdirSync(data, { recursive: true });
    serveRegistry('1.0.0');
    served.set(`${NPM_REGISTRY}/@anthropic-ai/claude-code/latest`, () => Response.json({ name: '@anthropic-ai/claude-code', version: '2.0.20' }));
    served.set(`${BREW_API}/cask/codex.json`, () => Response.json({ token: 'codex', version: '0.50.0' }));
    clis.set('claude', { bin: '/Users/me/.local/bin/claude', realPath: '/Users/me/.local/share/claude/versions/2.0.14', version: '2.0.14' });
    clis.set('codex', { bin: '/opt/homebrew/bin/codex', realPath: '/opt/homebrew/Caskroom/codex/0.50.0/codex', version: '0.50.0' });
    core = createCore({
      paths: { dataDir: data, botsRoot: join(root, 'bots'), filesDir: join(data, 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
      runtime: (hooks) => new FakeRuntime(hooks),
      acpRegistry: true,
      fetch: (async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        fetched.push(url);
        return served.get(url)?.() ?? new Response('missing', { status: 404 });
      }) as typeof fetch,
      // npm as the registry's installs use it: a package with its command, laid out where `--prefix` says
      packageRunner: {
        which: async (name) => `/usr/local/bin/${name}`,
        run: async (_command, args) => {
          const prefix = args[args.indexOf('--prefix') + 1]!;
          const win = process.platform === 'win32';
          const pkg = join(prefix, ...(win ? ['node_modules'] : ['lib', 'node_modules']), 'zapper-acp');
          mkdirSync(pkg, { recursive: true });
          writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'zapper-acp', bin: 'cli.js' }));
          const bin = win ? join(prefix, 'zapper-acp.cmd') : join(prefix, 'bin', 'zapper-acp');
          mkdirSync(join(bin, '..'), { recursive: true });
          writeFileSync(bin, '');
          return { ok: true, output: '' };
        },
      },
      updateIo: {
        cli: async (name) => clis.get(name),
        run: async (command, args) => {
          ran.push([command, ...args].join(' '));
          if (runResult.ok && command.endsWith('claude')) clis.set('claude', { ...clis.get('claude')!, version: '2.0.20' });
          return runResult;
        },
      },
      openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
      version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, host: '127.0.0.1', quiet: true,
      computerBackends: () => [], helperTransport: () => null,
    });
    await core.start();
    await core.services.acpRegistry.add('zapper');
  });

  afterAll(async () => {
    await core.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('has nothing to say before the first check', () => {
    const p = find(core.services.providers.list(), 'claude-code');
    expect(p.updateAvailable).toBeFalsy();
    expect(p.latestVersion).toBeUndefined();
    expect(p.update).toBeUndefined();
  });

  it('compares the CLI with npm (or Homebrew for a Homebrew install) and the registry agent with the registry', async () => {
    serveRegistry('1.1.0');
    const list = await core.services.providerUpdates.check(undefined, true);
    expect(find(list, 'claude-code')).toMatchObject({ latestVersion: '2.0.20', updateAvailable: true, update: { current: '2.0.14', via: 'claude update', running: false } });
    expect(find(list, 'codex')).toMatchObject({ latestVersion: '0.50.0', updateAvailable: false, update: { current: '0.50.0', via: 'brew upgrade codex' } });
    expect(find(list, 'zapper')).toMatchObject({ latestVersion: '1.1.0', updateAvailable: true, update: { current: '1.0.0', via: 'the ACP registry' } });
  });

  it('reuses newest versions fetched a moment ago unless forced', async () => {
    const before = fetched.length;
    await core.services.providerUpdates.check();
    expect(fetched.slice(before).filter((u) => u.startsWith(NPM_REGISTRY) || u.startsWith(BREW_API))).toEqual([]);
    await core.services.providerUpdates.check(['claude-code'], true);
    expect(fetched.slice(before)).toContain(`${NPM_REGISTRY}/@anthropic-ai/claude-code/latest`);
  });

  it('keeps the last answer and says so when the check fails', async () => {
    served.set(`${NPM_REGISTRY}/@anthropic-ai/claude-code/latest`, () => new Response('down', { status: 503 }));
    const p = find(await core.services.providerUpdates.check(['claude-code'], true), 'claude-code');
    expect(p).toMatchObject({ latestVersion: '2.0.20', updateAvailable: true });
    expect(p.update?.error).toMatch(/503/);
    served.set(`${NPM_REGISTRY}/@anthropic-ai/claude-code/latest`, () => Response.json({ version: '2.0.20' }));
  });

  it('reports a failed update on the agent', async () => {
    runResult = { ok: false, output: 'npm ERR! EACCES: permission denied' };
    const r = await core.services.providerUpdates.update('claude-code');
    expect(r.ok).toBe(false);
    const p = find(core.services.providers.list(), 'claude-code');
    expect(p).toMatchObject({ updateAvailable: true, update: { running: false } });
    expect(p.update?.error).toMatch(/EACCES/);
    runResult = { ok: true, output: 'updated' };
  });

  it('runs the CLI update and re-reads its version', async () => {
    ran.length = 0;
    const events: Provider[] = [];
    const off = core.ctx.bus.on((e) => { if (e.event === 'provider.updated') events.push(e.payload as Provider); });
    const r = await core.services.providerUpdates.update('claude-code');
    off?.();
    expect(ran).toEqual(['/Users/me/.local/bin/claude update']);
    expect(r).toMatchObject({ ok: true, message: 'Claude Code (fake) updated from 2.0.14 to 2.0.20.' });
    expect(events.some((p) => p.id === 'claude-code' && p.update?.running)).toBe(true);
    const p = find(core.services.providers.list(), 'claude-code');
    expect(p).toMatchObject({ updateAvailable: false, update: { current: '2.0.20', running: false } });
    expect(p.update?.error).toBeUndefined();
  });

  it('updates a registry agent through the registry download path', async () => {
    const r = await core.services.providerUpdates.update('zapper');
    expect(r.ok).toBe(true);
    const p = find(core.services.providers.list(), 'zapper');
    expect(p.registry?.version).toBe('1.1.0');
    expect(p.command.startsWith(join(root, 'data', 'agents', 'zapper', '1.1.0'))).toBe(true);
    expect(p.args).toEqual(['acp']);
    expect(p).toMatchObject({ updateAvailable: false, update: { current: '1.1.0' } });
  });

  it('skips built-ins without their CLI on PATH (the bundled adapter comes with AppuBot)', async () => {
    clis.delete('codex');
    const p = find(await core.services.providerUpdates.check(['codex']), 'codex');
    expect(p.update).toBeUndefined();
    await expect(core.services.providerUpdates.update('codex')).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('a full-access phone may update an agent, a limited one may not; both may check', () => {
    const phone = { role: 'full' as const, deviceId: 'd1' };
    expect(() => checkRole('providers.update', { id: 'claude-code' }, phone)).not.toThrow();
    expect(() => checkRole('providers.update', { id: 'claude-code' }, { role: 'limited', deviceId: 'd1' })).toThrow(/not allowed/);
    expect(() => checkRole('providers.checkUpdates', {}, phone)).not.toThrow();
    expect(() => checkRole('providers.update', { id: 'claude-code' }, { role: 'owner', deviceId: 'mac' })).not.toThrow();
  });
});
