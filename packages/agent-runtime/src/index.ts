/**
 * @appubot/agent-runtime - ACP client that runs coding agents as child processes.
 */
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import type { AuthMethod, InitializeResponse } from '@agentclientprotocol/sdk';
import { AgentAuthError, ProviderNotInstalledError, SessionNotFoundError, errorMessage } from './errors';
import { getPathEntries, getPathString, resolveExecutable, setExtraPath } from './path';
import { AgentSession, authMethodInfos, type SpawnSpec } from './process';
import { applyLoginHome, mergeEnv, withPath, withoutEnv } from './spawn';
import { LOGOUT_ARGS, checkLogin, logoutCli } from './login';
import { PROFILE_HOME_ENV, providerBase } from '@appubot/protocol';
import { BUILTIN_PROVIDERS, DEFAULT_AUTH_COMMANDS, NODE_COMMAND, adapterCli, adapterCliName, emptyStatus, mergeBuiltin, nodeRunEnv, probeProvider, profileSpec, providerCli, providerRuntimeEnv, withBuiltinKeyLogins } from './providers';
import { captureBrowser, clearScratch, quirkCtx, quirksFor } from './quirks';
import type { AgentRuntime, CreateSessionOptions, LoginEnv, ProviderSpec, ProviderStatus, RuntimeOptions, SessionInfo } from './types';

export * from './types';
export * from './errors';
export { elicitationContent, elicitationFields, type ElicitationAnswer, type ElicitationAsk, type ElicitationField, type ElicitationOption, type ElicitationValue } from './elicitation';
export { APPROVAL_MODES, BUILTIN_PROVIDERS, NODE_COMMAND, RETIRED_PROVIDER_IDS, adapterCli, agentModeFor, builtinKeyLogins, isNoAskMode, mergeBuiltin, permissionChoice, profileSpec, probeVersion, providerModes, resolveAdapterBin, toOfferedMode, withBuiltinKeyLogins } from './providers';
export { maskEmail } from './login';
export { resolveExecutable, getPathEntries, getPathString, getLoginShellPath } from './path';
export { TurnAssembler, extractConfig, mapToolKind, friendlyToolTitle } from './normalize';
export { TerminalManager } from './terminals';
export {
  applyLoginHome, cmdLaunch, cmdLine, cmdShimTarget, directExecutable, escapeCmdArg, executableNames, killGroup, killTree, launchSpec, mergeEnv,
  pathKey, processGroup, spawnCommand, taskkillCommand, whichSync, withPath, withoutEnv, type Launch,
} from './spawn';

/** How long an agent's own sign-in (`login`) may take: the user finishes it in the browser. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const LOGOUT_TIMEOUT_MS = 60_000;

export function createAgentRuntime(opts: RuntimeOptions): AgentRuntime {
  const { hooks } = opts;
  setExtraPath(opts.extraPath);
  // Resolve the login-shell PATH eagerly (cached).
  void getPathEntries().catch(() => undefined);

  const nodeExecutable = opts.nodeExecutable ?? process.execPath;
  /** this process's environment as every agent, login and logout starts from: `hideEnv` left out */
  const hostEnv = (): NodeJS.ProcessEnv => withoutEnv(process.env, opts.hideEnv ?? []);
  /** where agents that need folders of their own get them (`quirks.ts`) */
  const dataDir = opts.dataDir ?? join(tmpdir(), 'appubot-runtime');
  /** agents whose throwaway folders were emptied in this run */
  const scratched = new Set<string>();
  let providers = new Map<string, ProviderSpec>(BUILTIN_PROVIDERS.map((p) => [p.id, structuredClone(p)]));
  const statuses = new Map<string, ProviderStatus>();
  /** raw auth methods from the last initialize, per provider (for authCommand) */
  const rawAuthMethods = new Map<string, AuthMethod[]>();
  const sessions = new Map<string, AgentSession>();

  function getSpec(id: string): ProviderSpec {
    const spec = providers.get(id);
    if (!spec) throw new Error(`Unknown provider: ${id}`);
    return spec;
  }

  function patchStatus(id: string, patch: Partial<ProviderStatus>): void {
    const spec = providers.get(id);
    if (!spec) return;
    const prev = statuses.get(id) ?? emptyStatus(spec);
    statuses.set(id, { ...prev, ...spec, ...patch });
  }

  const nodeEnv = nodeRunEnv;

  /** The ACP agent said it needs a login: so does the CLI check's answer (only for providers that have one). */
  function markLoggedOut(id: string): void {
    const prev = statuses.get(id)?.auth;
    patchStatus(id, { authStatus: 'needs_auth', ...(prev ? { auth: { state: 'logged_out', checkedAt: Date.now() } } : {}) });
  }

  /** the process env of an agent under a person's logins (`LoginEnv`): their home, and their saved keys */
  function withLogin(env: NodeJS.ProcessEnv, spec: ProviderSpec, login: LoginEnv | undefined): NodeJS.ProcessEnv {
    if (!login?.loginHome) return env;
    return applyLoginHome(env, login.loginHome, Object.values(PROFILE_HOME_ENV), !!spec.profile);
  }

  async function buildSpawnSpec(spec: ProviderSpec, extraEnv: Record<string, string> | undefined, login?: LoginEnv): Promise<SpawnSpec> {
    const PATH = await getPathString();
    const base: NodeJS.ProcessEnv = withPath(hostEnv(), PATH);
    const runtimeEnv = await providerRuntimeEnv(spec, base);
    const quirks = quirksFor(spec);
    const ctx = quirks && quirkCtx(spec, dataDir);
    if (quirks && ctx && !scratched.has(spec.id)) {
      scratched.add(spec.id);
      clearScratch(quirks, ctx);
    }
    const env: NodeJS.ProcessEnv = withLogin(mergeEnv([base, runtimeEnv, quirks && ctx ? quirks.env(ctx) : undefined, spec.env, hooks.secretEnv?.(spec.id, login?.loginScope), extraEnv]), spec, login);
    if (spec.command === NODE_COMMAND) {
      // Claude Code's and Codex's adapters drive the user's own CLI: without it the agent isn't installed
      if ((await adapterCli(spec, env)) === undefined) {
        patchStatus(spec.id, { installed: false, authStatus: 'not_installed' });
        throw new ProviderNotInstalledError(spec.id, adapterCliName(spec.id) ?? spec.command, spec.installHint);
      }
      Object.assign(env, nodeEnv());
      return { command: nodeExecutable, args: [...spec.args], env };
    }
    const resolved = await resolveExecutable(spec.command);
    if (!resolved) {
      patchStatus(spec.id, { installed: false, authStatus: 'not_installed' });
      throw new ProviderNotInstalledError(spec.id, spec.command, spec.installHint);
    }
    return { command: resolved, args: [...spec.args], env };
  }

  function onInitialized(providerId: string, init: InitializeResponse): void {
    rawAuthMethods.set(providerId, init.authMethods ?? []);
    const caps = init.agentCapabilities;
    patchStatus(providerId, {
      installed: true,
      authMethods: withBuiltinKeyLogins(providerId, authMethodInfos(init.authMethods)),
      // an agent without a logout command of its own can still be signed out through ACP when it offers that
      ...(!LOGOUT_ARGS[providerBase(providerId)] ? { canLogOut: !!caps?.auth?.logout } : {}),
      capabilities: {
        loadSession: !!caps?.loadSession,
        image: !!caps?.promptCapabilities?.image,
        audio: !!caps?.promptCapabilities?.audio,
        embeddedContext: !!caps?.promptCapabilities?.embeddedContext,
      },
    });
  }

  /** An agent process for a handshake only (`probe`, `login`): no session, nothing reported as a session. */
  async function handshakeSession(spec: ProviderSpec, login?: LoginEnv, extra?: { env?: Record<string, string>; openAuthUrl?: (url: string) => void }): Promise<AgentSession> {
    const spawnSpec = await buildSpawnSpec(spec, extra?.env, login);
    const own = extra?.openAuthUrl;
    return new AgentSession(spec, spawnSpec, { providerId: spec.id, cwd: homedir() }, { ...hooks, ...(own ? { openAuthUrl: (_id: string, url: string) => own(url), catchSignInLinks: true } : {}), onSessionState: () => {}, onTurnOp: () => {} }, {
      onInitialized: (init) => onInitialized(spec.id, init),
      onAuthRequired: () => {},
      onExit: () => {},
    });
  }

  const runtime: AgentRuntime = {
    setProviders(specs: ProviderSpec[]): void {
      const next = new Map<string, ProviderSpec>(BUILTIN_PROVIDERS.map((p) => [p.id, structuredClone(p)]));
      for (const s of specs) {
        if (s.profile) continue;
        const builtin = next.get(s.id);
        next.set(s.id, builtin ? mergeBuiltin(builtin, s) : { ...s, builtin: false });
      }
      // profiles run their agent as saved (a built-in with the user's own command for it, if any, or an agent added
      // from the ACP registry); one whose agent is gone is dropped
      for (const s of specs) {
        const of = s.profile ? next.get(s.profile.of) : undefined;
        if (s.profile && of && !of.profile && !next.has(s.id)) next.set(s.id, profileSpec(of, { ...s, profile: s.profile }));
      }
      for (const [id, spec] of next) {
        const old = providers.get(id);
        if (!old || old.command !== spec.command || JSON.stringify(old.args) !== JSON.stringify(spec.args) || JSON.stringify(old.env) !== JSON.stringify(spec.env)) statuses.delete(id);
      }
      for (const id of [...statuses.keys()]) if (!next.has(id)) statuses.delete(id);
      providers = next;
    },

    getProviders(): ProviderSpec[] {
      return [...providers.values()].map((p) => structuredClone(p));
    },

    async detectProviders(ids?: string[]): Promise<ProviderStatus[]> {
      const targets = ids ? ids.map(getSpec) : [...providers.values()];
      await Promise.all(
        targets.map(async (spec) => {
          // explicit ids => always re-probe; no ids => probe only those not cached yet
          if (!ids && statuses.has(spec.id)) return;
          try {
            statuses.set(spec.id, await probeProvider(spec, statuses.get(spec.id), nodeExecutable));
          } catch (err) {
            patchStatus(spec.id, { authStatus: 'error', lastError: errorMessage(err) });
          }
        }),
      );
      return targets.map((s) => structuredClone({ ...(statuses.get(s.id) ?? emptyStatus(s)), ...s }));
    },

    async createSession(o: CreateSessionOptions): Promise<SessionInfo> {
      const spec = getSpec(o.providerId);
      const cwd = isAbsolute(o.cwd) ? o.cwd : resolvePath(o.cwd);
      if (o.resumeSessionId) {
        const existing = sessions.get(o.resumeSessionId);
        if (existing && existing.alive && existing.info.state !== 'closed' && existing.info.state !== 'error') return existing.snapshot();
      }
      const spawnSpec = await buildSpawnSpec(spec, o.env, o);
      const session = new AgentSession(spec, spawnSpec, { ...o, cwd }, hooks, {
        onInitialized: (init) => onInitialized(spec.id, init),
        onAuthRequired: (methods, message) => {
          markLoggedOut(spec.id);
          patchStatus(spec.id, { authMethods: withBuiltinKeyLogins(spec.id, methods), lastError: message });
        },
        onExit: (s) => {
          if (s.info.state === 'closed' && s.info.id && sessions.get(s.info.id) === s) sessions.delete(s.info.id);
        },
      });
      hooks.log('info', `[${spec.id}] starting agent: ${spawnSpec.command} ${spawnSpec.args.join(' ')}`, { cwd });
      try {
        const info = await session.start();
        sessions.set(info.id, session);
        const auth = statuses.get(spec.id)?.auth;
        patchStatus(spec.id, {
          installed: true, authStatus: 'authenticated', lastError: undefined,
          // a session started, so a check that said logged out is stale (an unknown one stays: OpenCode starts without any login)
          ...(auth?.state === 'logged_out' ? { auth: { state: 'logged_in', checkedAt: Date.now() } } : {}),
        });
        hooks.onSessionState(session.snapshot());
        return info;
      } catch (err) {
        if (!(err instanceof AgentAuthError)) patchStatus(spec.id, { lastError: errorMessage(err) });
        hooks.log('error', `[${spec.id}] createSession failed: ${errorMessage(err)}`);
        throw err;
      }
    },

    getSession(id: string): SessionInfo | undefined {
      return sessions.get(id)?.snapshot();
    },

    listSessions(): SessionInfo[] {
      return [...sessions.values()].map((s) => s.snapshot());
    },

    async prompt(sessionId, blocks) {
      const s = sessions.get(sessionId);
      if (!s) throw new SessionNotFoundError(sessionId);
      try {
        return await s.prompt(blocks);
      } catch (err) {
        if (err instanceof AgentAuthError) markLoggedOut(s.spec.id);
        throw err;
      }
    },

    async cancel(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) throw new SessionNotFoundError(sessionId);
      await s.cancel();
    },

    async steer(sessionId, blocks) {
      const s = sessions.get(sessionId);
      if (!s) throw new SessionNotFoundError(sessionId);
      return s.steer(blocks);
    },

    async extMethod(providerId, method, params, opts) {
      const spec = getSpec(providerId);
      const session = await handshakeSession(spec, opts?.login);
      return session.extMethod(method, params, opts?.timeoutMs);
    },

    async setMode(sessionId, modeId) {
      const s = sessions.get(sessionId);
      if (!s) throw new SessionNotFoundError(sessionId);
      return s.setMode(modeId);
    },

    async setModel(sessionId, modelId) {
      const s = sessions.get(sessionId);
      if (!s) throw new SessionNotFoundError(sessionId);
      return s.setModel(modelId);
    },

    async setEffort(sessionId, effortId) {
      const s = sessions.get(sessionId);
      if (!s) throw new SessionNotFoundError(sessionId);
      return s.setEffort(effortId);
    },

    async setFast(sessionId, enabled) {
      const s = sessions.get(sessionId);
      if (!s) throw new SessionNotFoundError(sessionId);
      return s.setFast(enabled);
    },

    async closeSession(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return;
      sessions.delete(sessionId);
      await s.close();
    },

    async probe(providerId) {
      const spec = getSpec(providerId);
      const session = await handshakeSession(spec);
      try {
        await session.probe();
      } catch (err) {
        patchStatus(spec.id, { lastError: errorMessage(err) });
        throw err;
      }
      return structuredClone({ ...(statuses.get(spec.id) ?? emptyStatus(spec)), ...spec });
    },

    async login(providerId, methodId, timeoutMs = LOGIN_TIMEOUT_MS, login?: LoginEnv, onAuthUrl?: (url: string) => void) {
      const spec = getSpec(providerId);
      // a sign-in made for another device: its page is caught (`BROWSER`, else what the agent prints) and handed over,
      // never opened here
      const session = await handshakeSession(spec, login, onAuthUrl ? { env: { BROWSER: captureBrowser(dataDir) }, openAuthUrl: onAuthUrl } : undefined);
      hooks.log('info', `[${spec.id}] signing in with ${methodId}${login?.loginScope ? ` (${login.loginScope})` : ''}`);
      quirksFor(spec)?.beforeLogin?.(quirkCtx(spec, dataDir), methodId, hooks.secretEnv?.(spec.id, login?.loginScope) ?? {});
      await session.login(methodId, timeoutMs);
      patchStatus(spec.id, { installed: true, authStatus: 'authenticated', lastError: undefined });
    },

    async authCommand(providerId, methodId, login) {
      const spec = getSpec(providerId);
      const methods = rawAuthMethods.get(providerId) ?? [];
      const terminalMethods = methods.filter((m): m is Extract<AuthMethod, { type: 'terminal' }> => 'type' in m && m.type === 'terminal');
      let method = methodId ? terminalMethods.find((m) => m.id === methodId) : terminalMethods[0];

      // Claude adapter: the subscription login is always available on the adapter itself.
      if (!method && providerBase(providerId) === 'claude-code' && spec.command === NODE_COMMAND && (!methodId || methodId === 'claude-ai-login' || methodId === 'console-login')) {
        method =
          methodId === 'console-login'
            ? { type: 'terminal', id: 'console-login', name: 'Anthropic Console', args: ['--cli', 'auth', 'login', '--console'] }
            : { type: 'terminal', id: 'claude-ai-login', name: 'Claude Subscription', args: ['--cli', 'auth', 'login', '--claudeai'] };
      }

      const PATH = await getPathString();
      // a person's logins: their home rides along as plain variables (the terminal line sets them)
      const loginVars = (base: Record<string, string>): Record<string, string> => (login?.loginHome ? Object.fromEntries(Object.entries(withLogin({ ...base }, spec, login)).filter((kv): kv is [string, string] => typeof kv[1] === 'string')) : base);
      if (method) {
        const runtimeEnv = await providerRuntimeEnv(spec, withPath(hostEnv(), PATH));
        const env: Record<string, string> = loginVars({ ...runtimeEnv, ...spec.env, ...(method.env ?? {}) });
        if (spec.command === NODE_COMMAND) {
          return { command: nodeExecutable, args: [...spec.args, ...(method.args ?? [])], env: { ...env, ...nodeEnv() } };
        }
        const resolved = (await resolveExecutable(spec.command)) ?? spec.command;
        return { command: resolved, args: [...spec.args, ...(method.args ?? [])], env };
      }

      const fallback = DEFAULT_AUTH_COMMANDS[providerBase(providerId)];
      if (!fallback) return null;
      const resolved = await resolveExecutable(fallback.command);
      if (!resolved) return null;
      return { command: resolved, args: [...fallback.args], env: loginVars({ ...spec.env }) };
    },

    async loginState(providerId, login) {
      const spec = getSpec(providerId);
      const PATH = await getPathString();
      const cli = await providerCli(spec, nodeExecutable);
      const env = withLogin(mergeEnv([withPath(hostEnv(), PATH), spec.env, hooks.secretEnv?.(spec.id, login.loginScope)]), spec, login);
      const result = await checkLogin(providerBase(spec.id), cli, env).catch(() => undefined);
      return result ? { ...result, checkedAt: Date.now() } : undefined;
    },

    async logout(providerId, login) {
      const spec = getSpec(providerId);
      if (!LOGOUT_ARGS[providerBase(providerId)]) {
        if (!statuses.get(providerId)?.canLogOut) return { ok: false, message: `${spec.name} can't be logged out from AppuBot.` };
        const session = await handshakeSession(spec, login);
        try {
          if (!(await session.logout(LOGOUT_TIMEOUT_MS))) return { ok: false, message: `${spec.name} can't be logged out from AppuBot.` };
        } catch (err) {
          return { ok: false, message: errorMessage(err) };
        }
        markLoggedOut(providerId);
        return { ok: true };
      }
      const cli = await providerCli(spec, nodeExecutable);
      if (!cli) return { ok: false, message: `${spec.name} is not installed.` };
      const PATH = await getPathString();
      const res = await logoutCli(providerBase(providerId), cli, withLogin(mergeEnv([withPath(hostEnv(), PATH), spec.env]), spec, login));
      // a person's own logout leaves the computer's status alone
      if (res.ok && !login?.loginHome) markLoggedOut(providerId);
      return res;
    },

    async shutdown() {
      const all = [...sessions.values()];
      sessions.clear();
      await Promise.all(all.map((s) => s.close().catch(() => undefined)));
    },
  };
  return runtime;
}
