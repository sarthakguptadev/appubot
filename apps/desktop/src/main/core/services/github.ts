/**
 * Git and GitHub, carried from one of the person's computers to another (Settings › Transfer; protocol `carry.ts`).
 *
 * On the computer that has them (`local`, `localToken`: its own window only, `checkRole`): the name and email git
 * signs commits with, and the GitHub sign-in already on it, found in the GitHub CLI (`gh auth token`) or in git's own
 * saved credentials (`git credential fill`, never prompting). The token leaves only when the window asks for it, to
 * hand to the other computer over that computer's end-to-end channel.
 *
 * On the computer that takes them (`setup`): `git config --global user.name/email`; the token checked with GitHub
 * (`GET /user`, which also names the account), then kept where git reads it for `https://github.com`
 * (`~/.git-credentials`, 0600, with `credential.https://github.com.helper store`), and SSH-style GitHub remotes
 * (`git@github.com:…`) pointed at https so they use it too; the GitHub CLI's `hosts.yml` gets it where AppuBot wrote
 * that file or none is there. The bots there run git as the same user, so the token is theirs to use: that is the
 * point, and why the person's private SSH key is never carried. `sshKey` makes the computer a key of its own
 * (`~/.ssh/id_ed25519`, no passphrase) whose public half the person adds wherever they want it trusted.
 *
 * On a team's computer sorted by person, all of it is that person's own home (`LoginsService.homeOf`).
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getPathString, resolveExecutable } from '@appubot/agent-runtime';
import type { GitLocal, GitSetup, MethodParams } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { errMsg, RpcError } from '../util';

export interface GitRunResult { code: number; stdout: string; stderr: string }

/** how the service reaches programs (tests swap it: `deps.gitIo`) */
export interface GitIo {
  /** the program's full path, or undefined when it isn't installed */
  which(name: string): Promise<string | undefined>;
  /** runs it to the end; never throws (`code` -1: it couldn't start, or ran past `timeoutMs`) */
  run(command: string, args: string[], o?: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number }): Promise<GitRunResult>;
}

const GITHUB_HOST = 'github.com';
const GITHUB_API = 'https://api.github.com';
const GH_HOSTS_MARK = '# Written by AppuBot (Settings › Transfer). Sign in with `gh auth login` to replace it.';
/** SSH-style GitHub remotes that go over https instead, so they use the saved sign-in */
const SSH_PREFIXES = ['git@github.com:', 'ssh://git@github.com/'];

export function runProgram(command: string, args: string[], o: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {}): Promise<GitRunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code: number) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout, stderr }); };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { env: o.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: errMsg(e) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(-1); }, o.timeoutMs ?? 10_000);
    child.stdout?.on('data', (d: Buffer) => { if (stdout.length < 1_000_000) stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 100_000) stderr += d.toString('utf8'); });
    child.on('error', (e) => { stderr += errMsg(e); finish(-1); });
    child.on('close', (code) => finish(code ?? -1));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(o.input ?? '');
  });
}

const defaultIo: GitIo = { which: resolveExecutable, run: runProgram };

/** a token as GitHub makes them (classic, fine-grained, an app's): no spaces, nothing a config file would misread */
export const looksLikeToken = (t: string): boolean => /^[A-Za-z0-9_\-.=]{20,400}$/.test(t);

/** `key=value` lines of `git credential fill`'s answer */
export function parseCredential(out: string): { username?: string; password?: string } {
  const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(out)?.[1]?.trim() || undefined;
  return { username: get('username'), password: get('password') };
}

/** `~/.git-credentials` with the line for GitHub replaced (or added); every other host's line kept as it is */
export function withGithubCredential(file: string, login: string, token: string): string {
  const kept = file.split('\n').filter((l) => {
    const t = l.trim();
    if (!t) return false;
    try { return new URL(t).hostname.toLowerCase() !== GITHUB_HOST; } catch { return true; }
  });
  return [...kept, `https://${encodeURIComponent(login)}:${encodeURIComponent(token)}@${GITHUB_HOST}`].join('\n') + '\n';
}

/** the GitHub account a credentials file signs in as */
export function githubLoginIn(file: string): string | undefined {
  for (const l of file.split('\n')) {
    try {
      const u = new URL(l.trim());
      if (u.hostname.toLowerCase() === GITHUB_HOST && u.username) return decodeURIComponent(u.username);
    } catch { /* not a credential line */ }
  }
  return undefined;
}

export class GitHubService {
  constructor(private ctx: CoreCtx) {}

  private get io(): GitIo { return { ...defaultIo, ...(this.ctx.deps.gitIo ?? {}) }; }

  /** the home git and ssh read here: a team member's own on a team's computer sorted by person, else this user's */
  private home(scope: string): string {
    return this.ctx.s.logins.homeOf(scope) ?? this.ctx.deps.homeDir ?? homedir();
  }

  private async env(scope: string): Promise<NodeJS.ProcessEnv> {
    const scoped = this.ctx.s.logins.homeOf(scope);
    const home = this.home(scope);
    return {
      ...process.env,
      PATH: await getPathString().catch(() => process.env.PATH ?? ''),
      // a team member's own home (what their agents run with: agent-runtime `loginHomeEnv`)
      ...(scoped ? { HOME: scoped, USERPROFILE: scoped, XDG_CONFIG_HOME: join(scoped, '.config'), XDG_DATA_HOME: join(scoped, '.local', 'share'), XDG_STATE_HOME: join(scoped, '.local', 'state'), XDG_CACHE_HOME: join(scoped, '.cache') } : { HOME: home }),
      // never a prompt: a terminal's, an askpass window's, a credential manager's
      GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', SSH_ASKPASS: 'true', GCM_INTERACTIVE: 'never', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1',
    };
  }

  /**
   * git's path, or undefined when it isn't installed. On a Mac `/usr/bin/git` is a stand-in that opens Apple's
   * "install the command line developer tools" window when they aren't there: it only counts once they are.
   */
  private async git(): Promise<string | undefined> {
    const path = await this.io.which('git');
    if (!path) return undefined;
    if (process.platform === 'darwin' && path === '/usr/bin/git') {
      const tools = await this.io.run('/usr/bin/xcode-select', ['-p'], { timeoutMs: 5000 });
      if (tools.code !== 0) return undefined;
    }
    return path;
  }

  private async config(git: string, env: NodeJS.ProcessEnv, key: string): Promise<string | undefined> {
    const r = await this.io.run(git, ['config', '--global', '--get', key], { env, timeoutMs: 5000 });
    return r.code === 0 ? r.stdout.trim() || undefined : undefined;
  }

  /** The GitHub sign-in on this computer: the GitHub CLI's, else git's saved one. Nothing asks the person anything. */
  private async findToken(git: string | undefined, env: NodeJS.ProcessEnv): Promise<{ token: string; via: 'gh' | 'git' } | undefined> {
    const gh = await this.io.which('gh');
    if (gh) {
      const r = await this.io.run(gh, ['auth', 'token', '--hostname', GITHUB_HOST], { env, timeoutMs: 8000 });
      const token = r.stdout.trim();
      if (r.code === 0 && looksLikeToken(token)) return { token, via: 'gh' };
    }
    if (git) {
      const r = await this.io.run(git, ['credential', 'fill'], { env, input: `protocol=https\nhost=${GITHUB_HOST}\n\n`, timeoutMs: 8000 });
      const token = r.code === 0 ? parseCredential(r.stdout).password : undefined;
      if (token && looksLikeToken(token)) return { token, via: 'git' };
    }
    return undefined;
  }

  /** What this computer has to carry (never the token). */
  async local(scope = ''): Promise<GitLocal> {
    const env = await this.env(scope);
    const git = await this.git();
    const [name, email, found] = await Promise.all([
      git ? this.config(git, env, 'user.name') : undefined,
      git ? this.config(git, env, 'user.email') : undefined,
      this.findToken(git, env),
    ]);
    return { git: !!git, ...(name ? { name } : {}), ...(email ? { email } : {}), hasToken: !!found, ...(found ? { via: found.via } : {}) };
  }

  /** That sign-in's token, for this computer's own window to hand on. */
  async localToken(scope = ''): Promise<{ token: string }> {
    const env = await this.env(scope);
    const found = await this.findToken(await this.git(), env);
    if (!found) throw new RpcError('not_found', 'No GitHub sign-in was found on this computer. Sign in with the GitHub CLI (gh auth login), then try again.');
    return { token: found.token };
  }

  /**
   * Who git signs in to GitHub as here, by the sign-in AppuBot saved (`setup`): what the bots are told on a cloud
   * computer (`BotsService.instructionsOptions`), so they use it instead of asking the user for a token. No process runs.
   */
  signedInAs(scope = ''): string | undefined {
    try { return githubLoginIn(readFileSync(join(this.home(scope), '.git-credentials'), 'utf8')); } catch { return undefined; }
  }

  async status(scope = ''): Promise<GitSetup> {
    const env = await this.env(scope);
    const home = this.home(scope);
    const git = await this.git();
    const [name, email] = await Promise.all([git ? this.config(git, env, 'user.name') : undefined, git ? this.config(git, env, 'user.email') : undefined]);
    let login: string | undefined;
    try { login = githubLoginIn(readFileSync(join(home, '.git-credentials'), 'utf8')); } catch { /* none saved */ }
    let sshKey: string | undefined;
    try { sshKey = readFileSync(join(home, '.ssh', 'id_ed25519.pub'), 'utf8').trim() || undefined; } catch { /* none made */ }
    return { git: !!git, ...(name ? { name } : {}), ...(email ? { email } : {}), ...(login ? { login } : {}), ...(sshKey ? { sshKey } : {}) };
  }

  async setup(p: MethodParams<'github.setup'>, scope = ''): Promise<GitSetup> {
    const env = await this.env(scope);
    const home = this.home(scope);
    const git = await this.git();
    if (!git) throw new RpcError('unavailable', 'git isn’t installed on this computer, so there is nothing to set up.');
    const set = async (args: string[], what: string) => {
      const r = await this.io.run(git, ['config', '--global', ...args], { env, timeoutMs: 8000 });
      if (r.code !== 0) throw new RpcError('internal', `Couldn’t set ${what}: ${r.stderr.trim() || `git answered ${r.code}`}`);
    };
    if (p.name) await set(['user.name', p.name], 'the name for commits');
    if (p.email) await set(['user.email', p.email], 'the email for commits');

    if (p.token) {
      if (!looksLikeToken(p.token)) throw new RpcError('invalid_params', 'That isn’t a GitHub sign-in AppuBot can read.');
      const login = await this.githubLogin(p.token);
      const file = join(home, '.git-credentials');
      let cur = '';
      try { cur = readFileSync(file, 'utf8'); } catch { /* a new file */ }
      try {
        writeFileSync(file, withGithubCredential(cur, login, p.token), { mode: 0o600 });
        chmodSync(file, 0o600);
      } catch (e) {
        throw new RpcError('internal', `Couldn’t save the GitHub sign-in: ${errMsg(e)}`);
      }
      await set(['--replace-all', `credential.https://${GITHUB_HOST}.helper`, 'store'], 'git’s sign-in for GitHub');
      // git@github.com:… remotes go over https, so they use the sign-in too (no SSH key needed for GitHub)
      const key = `url.https://${GITHUB_HOST}/.insteadOf`;
      const have = (await this.io.run(git, ['config', '--global', '--get-all', key], { env, timeoutMs: 5000 })).stdout.split('\n').map((l) => l.trim());
      for (const prefix of SSH_PREFIXES) if (!have.includes(prefix)) await set(['--add', key, prefix], 'GitHub’s addresses');
      this.writeGhHosts(home, env, login, p.token);
      this.ctx.log.info(`github: git signs in to GitHub as ${login} here now`);
      // the bots' instructions name the account (cloud computers): written again, so each agent hears at its next turn
      try { this.ctx.s.bots.rescaffold(); } catch (e) { this.ctx.log.warn('github: the bots’ instructions could not be rewritten', errMsg(e)); }
    }

    if (p.sshKey) await this.makeSshKey(home, env, p.email ?? (await this.config(git, env, 'user.email')));
    return this.status(scope);
  }

  /** Who the token is, by GitHub's word; refuses one GitHub doesn't accept. */
  private async githubLogin(token: string): Promise<string> {
    const f = this.ctx.deps.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`${GITHUB_API}/user`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'AppuBot', 'x-github-api-version': '2022-11-28' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new RpcError('unavailable', `Couldn’t reach GitHub to check the sign-in: ${errMsg(e)}`);
    }
    if (res.status === 401 || res.status === 403) throw new RpcError('invalid_params', 'GitHub didn’t accept that sign-in (it may have expired). Sign in to GitHub again on the computer it comes from, then bring it over once more.');
    if (!res.ok) throw new RpcError('unavailable', `GitHub answered ${res.status} when asked about the sign-in. Try again in a moment.`);
    const login = ((await res.json().catch(() => ({}))) as { login?: unknown }).login;
    if (typeof login !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) throw new RpcError('unavailable', 'GitHub’s answer didn’t name the account.');
    return login;
  }

  /** The GitHub CLI's sign-in file, where there is none or it is one AppuBot wrote: a person's own `gh auth login` is never replaced. */
  private writeGhHosts(home: string, env: NodeJS.ProcessEnv, login: string, token: string): void {
    const dir = env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'gh') : join(home, '.config', 'gh');
    const file = join(dir, 'hosts.yml');
    try {
      if (existsSync(file) && !readFileSync(file, 'utf8').startsWith(GH_HOSTS_MARK)) return;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(file, `${GH_HOSTS_MARK}\n${GITHUB_HOST}:\n    oauth_token: ${token}\n    user: ${login}\n    git_protocol: https\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
    } catch (e) {
      this.ctx.log.warn('github: the GitHub CLI’s sign-in file could not be written', errMsg(e));
    }
  }

  /** An SSH key of this computer's own, when it has none (never replaces one). */
  private async makeSshKey(home: string, env: NodeJS.ProcessEnv, email: string | undefined): Promise<void> {
    const dir = join(home, '.ssh');
    const file = join(dir, 'id_ed25519');
    if (existsSync(file)) return;
    const keygen = await this.io.which('ssh-keygen');
    if (!keygen) throw new RpcError('unavailable', 'ssh-keygen isn’t installed on this computer, so it can’t make an SSH key.');
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); } catch (e) { throw new RpcError('internal', `Couldn’t make ~/.ssh: ${errMsg(e)}`); }
    const comment = `${(email || 'appubot').replace(/[^\w.@+-]/g, '')} (${this.ctx.deps.hostName.replace(/[^\w .’'-]/g, '').slice(0, 60)})`;
    const r = await this.io.run(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file], { env, timeoutMs: 20_000 });
    if (r.code !== 0 || !existsSync(`${file}.pub`)) throw new RpcError('internal', `Couldn’t make an SSH key: ${r.stderr.trim() || `ssh-keygen answered ${r.code}`}`);
  }
}
