/** Errors thrown by the agent runtime. */

export interface AuthMethodInfo {
  id: string;
  name: string;
  description?: string;
  /**
   * `terminal`: the agent's login runs in a terminal; `agent`: the agent signs in by itself (ACP `authenticate`),
   * after the keys in `vars` when it has some; `env_var`: only keys (`vars`) the agent reads from its environment
   */
  kind?: 'agent' | 'terminal' | 'env_var';
  vars?: { name: string; label?: string; secret: boolean; optional: boolean }[];
  /** where to get the key */
  link?: string;
}

/** The agent refused to create a session / run a turn because the user is not logged in. */
export class AgentAuthError extends Error {
  readonly code = 'needs_auth' as const;
  constructor(
    readonly providerId: string,
    readonly authMethods: AuthMethodInfo[],
    message?: string,
  ) {
    super(message ?? `Provider "${providerId}" requires authentication`);
    this.name = 'AgentAuthError';
  }
}

/** A prompt is already in flight for this session. The caller should queue and retry later. */
export class AgentBusyError extends Error {
  readonly code = 'busy' as const;
  constructor(readonly sessionId: string) {
    super(`busy: session ${sessionId} already has a prompt in flight`);
    this.name = 'AgentBusyError';
  }
}

/** Session id is not known to the runtime (never created or already closed). */
export class SessionNotFoundError extends Error {
  readonly code = 'session_not_found' as const;
  constructor(readonly sessionId: string) {
    super(`Unknown agent session: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

/** The provider's command could not be resolved / spawned. */
export class ProviderNotInstalledError extends Error {
  readonly code = 'not_installed' as const;
  constructor(readonly providerId: string, readonly command: string, readonly installHint?: string) {
    super(`Provider "${providerId}" is not installed: "${command}" was not found on PATH${installHint ? ` (install: ${installHint})` : ''}`);
    this.name = 'ProviderNotInstalledError';
  }
}

/** The agent process died or the connection closed. */
export class AgentProcessError extends Error {
  readonly code = 'process_error' as const;
  constructor(message: string, readonly exitCode?: number | null, readonly signal?: string | null) {
    super(message);
    this.name = 'AgentProcessError';
  }
}

/** JSON-RPC error code ACP uses for "auth required". */
export const AUTH_REQUIRED_CODE = -32000;

export function rpcErrorCode(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'number') {
    return (err as { code: number }).code;
  }
  return undefined;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}
