/**
 * Git and GitHub carried between a person's computers (`github.ts`): what the lending computer finds without asking
 * anything, and what the taking one sets up, against a real git in a home folder of the test's own. GitHub itself and
 * the GitHub CLI are stand-ins.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExecutable } from '@appubot/agent-runtime';
import { createCore, type Core } from '../app';
import type { CoreDeps } from '../context';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { renderAgentInstructions } from './bots';
import { githubLoginIn, looksLikeToken, parseCredential, runProgram, withGithubCredential, type GitIo } from './github';

const TOKEN = 'gho_abcdefghijklmnopqrstuvwxyz0123456789';
const cores: Core[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.stop();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

interface Made { core: Core; home: string; asked: { url: string; auth: string }[] }

async function make(io: Partial<GitIo> = {}, github: (auth: string) => Response = () => Response.json({ login: 'ada-l' }), extra: Partial<CoreDeps> = {}): Promise<Made> {
  const root = mkdtempSync(join(tmpdir(), 'appubot-git-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home);
  const asked: Made['asked'] = [];
  const core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'Ada’s Cloud Computer', log: silentLogger, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    homeDir: home, gitIo: io,
    ...extra,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const auth = String(new Headers(init?.headers).get('authorization') ?? '');
      asked.push({ url: String(url), auth });
      return github(auth);
    }) as CoreDeps['fetch'],
  });
  cores.push(core);
  await core.start();
  return { core, home, asked };
}

/** git reading only the test's own home: never this machine's system config (whose keychain helper holds real sign-ins) */
const sealedRun: GitIo['run'] = (cmd, args, o) => runProgram(cmd, args, { ...o, env: { ...(o?.env ?? process.env), GIT_CONFIG_NOSYSTEM: '1' } });
/** no GitHub CLI, whatever this machine has */
const noGh: Partial<GitIo> = { which: async (n) => (n === 'gh' ? undefined : resolveExecutable(n)), run: sealedRun };

describe('the pure parts', () => {
  it('reads a credential, tells a token, and keeps other hosts’ lines', () => {
    expect(parseCredential('protocol=https\nhost=github.com\nusername=ada\npassword=gho_x\n')).toEqual({ username: 'ada', password: 'gho_x' });
    expect(parseCredential('protocol=https\nhost=github.com\n')).toEqual({});
    expect(looksLikeToken(TOKEN)).toBe(true);
    expect(looksLikeToken('github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz')).toBe(true);
    expect(looksLikeToken('two words')).toBe(false);
    expect(looksLikeToken('short')).toBe(false);
    const file = withGithubCredential('https://me:old@github.com\nhttps://u:p@gitlab.com\n\nnot a url\n', 'ada-l', TOKEN);
    expect(file).toBe(`https://u:p@gitlab.com\nnot a url\nhttps://ada-l:${TOKEN}@github.com\n`);
    expect(githubLoginIn(file)).toBe('ada-l');
    expect(githubLoginIn('https://u:p@gitlab.com\n')).toBeUndefined();
  });
});

describe('what a computer has to carry', () => {
  it('finds the name, the email and the GitHub CLI’s sign-in, and hands the token only when asked', async () => {
    const calls: string[] = [];
    const { core, home } = await make({
      which: async (n) => (n === 'gh' ? '/fake/gh' : resolveExecutable(n)),
      run: async (cmd, args, o) => {
        if (cmd === '/fake/gh') { calls.push(args.join(' ')); return { code: 0, stdout: `${TOKEN}\n`, stderr: '' }; }
        return sealedRun(cmd, args, o);
      },
    });
    writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n');
    const local = await core.services.github.local();
    expect(local).toEqual({ git: true, name: 'Ada Lovelace', email: 'ada@example.com', hasToken: true, via: 'gh' });
    expect(JSON.stringify(local)).not.toContain(TOKEN);
    expect(calls[0]).toBe('auth token --hostname github.com');
    expect(await core.services.github.localToken()).toEqual({ token: TOKEN });
  });

  it('falls back to git’s own saved sign-in, and says so when there is none', async () => {
    const { core, home } = await make(noGh);
    expect(await core.services.github.local()).toMatchObject({ git: true, hasToken: false });
    await expect(core.services.github.localToken()).rejects.toThrow(/No GitHub sign-in/);
    // a sign-in git itself keeps (the store helper here; the keychain's on a Mac)
    writeFileSync(join(home, '.git-credentials'), `https://ada-l:${TOKEN}@github.com\n`);
    writeFileSync(join(home, '.gitconfig'), '[credential]\n\thelper = store\n');
    expect(await core.services.github.local()).toMatchObject({ hasToken: true, via: 'git' });
    expect(await core.services.github.localToken()).toEqual({ token: TOKEN });
  });
});

describe('setting a computer up', () => {
  it('sets git’s name and email, checks the token with GitHub and saves it where git reads it', async () => {
    const { core, home, asked } = await make(noGh);
    writeFileSync(join(home, '.git-credentials'), 'https://u:p@gitlab.com\n');
    const out = await core.services.github.setup({ name: 'Ada Lovelace', email: 'ada@example.com', token: TOKEN });
    expect(out).toEqual({ git: true, name: 'Ada Lovelace', email: 'ada@example.com', login: 'ada-l' });
    expect(asked).toEqual([{ url: 'https://api.github.com/user', auth: `Bearer ${TOKEN}` }]);

    const creds = join(home, '.git-credentials');
    expect(readFileSync(creds, 'utf8')).toBe(`https://u:p@gitlab.com\nhttps://ada-l:${TOKEN}@github.com\n`);
    expect(statSync(creds).mode & 0o777).toBe(0o600);
    const config = readFileSync(join(home, '.gitconfig'), 'utf8');
    expect(config).toMatch(/\[credential "https:\/\/github\.com"\]\s+helper = store/);
    expect(config).toMatch(/insteadOf = git@github\.com:/);
    expect(config).toMatch(/insteadOf = ssh:\/\/git@github\.com\//);
    const hosts = readFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'utf8');
    expect(hosts).toContain(`oauth_token: ${TOKEN}`);
    expect(hosts).toContain('user: ada-l');
    // git itself now answers with it, and the other end sees it as a sign-in to carry on
    expect(await core.services.github.local()).toMatchObject({ hasToken: true, via: 'git' });

    // again: nothing doubles
    await core.services.github.setup({ token: TOKEN });
    expect(readFileSync(join(home, '.gitconfig'), 'utf8').match(/insteadOf/g)).toHaveLength(2);
    expect(readFileSync(creds, 'utf8').match(/github\.com/g)).toHaveLength(1);
  });

  it('tells a cloud computer’s bots that git is signed in, so they don’t ask for a token; a person’s own computer says nothing', async () => {
    const CLOUD = { publicUrl: 'https://ab12cd34ef.agent37.app', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 3 };
    const cloud = await make(noGh, undefined, { cloud: CLOUD });
    const bot = cloud.core.services.bots.list()[0] ?? (await cloud.core.services.bots.create({ name: 'Ada', providerId: 'claude-code' }));
    const text = () => renderAgentInstructions(cloud.core.services.bots.require(bot.id), cloud.core.services.bots.instructionsOptions(bot));
    expect(text()).not.toContain('## GitHub');
    await cloud.core.services.github.setup({ token: TOKEN });
    expect(cloud.core.services.bots.instructionsOptions(bot).github).toBe('ada-l');
    expect(text()).toContain('## GitHub\ngit on this computer is already signed in to GitHub as ada-l');
    // the file its agent reads was written again
    const folder = cloud.core.services.bots.require(bot.id).workspace;
    expect(readFileSync(join(folder, 'CLAUDE.md'), 'utf8')).toContain('signed in to GitHub as ada-l');

    const mac = await make(noGh);
    await mac.core.services.github.setup({ token: TOKEN });
    expect(mac.core.services.bots.instructionsOptions().github).toBeUndefined();
  });

  it('refuses a token GitHub doesn’t accept, and leaves a person’s own GitHub CLI sign-in alone', async () => {
    const bad = await make(noGh, () => new Response('{"message":"Bad credentials"}', { status: 401 }));
    await expect(bad.core.services.github.setup({ token: TOKEN })).rejects.toThrow(/didn’t accept that sign-in/);
    expect(existsSync(join(bad.home, '.git-credentials'))).toBe(false);
    await expect(bad.core.services.github.setup({ token: 'not a token' })).rejects.toThrow();

    const { core, home } = await make(noGh);
    mkdirSync(join(home, '.config', 'gh'), { recursive: true });
    writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'github.com:\n    oauth_token: mine\n');
    await core.services.github.setup({ token: TOKEN });
    expect(readFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'utf8')).toBe('github.com:\n    oauth_token: mine\n');
  });

  it('makes the computer an SSH key of its own, once', async () => {
    const { core, home } = await make(noGh);
    const out = await core.services.github.setup({ email: 'ada@example.com', sshKey: true });
    expect(out.sshKey).toMatch(/^ssh-ed25519 \S+ ada@example\.com/);
    const key = join(home, '.ssh', 'id_ed25519');
    expect(statSync(key).mode & 0o777).toBe(0o600);
    const before = readFileSync(key, 'utf8');
    await core.services.github.setup({ sshKey: true });
    expect(readFileSync(key, 'utf8')).toBe(before);
  });
});
