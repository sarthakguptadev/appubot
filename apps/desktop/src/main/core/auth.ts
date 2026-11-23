/**
 * Tokens & pairing codes.
 *  - owner token: random, regenerated every launch, handed to the renderer over IPC. It (and an agent token) counts
 *    only from this computer itself (route `local`): never over Tailscale, AppuBot Connect, the channel or the Wi-Fi.
 *  - device tokens: random, only the sha256 hash is persisted (devices.json).
 *  - agent tokens: per ACP session, in-memory only, role 'agent'.
 *  - pairing codes: 6 digits, TTL, single use; 5 wrong tries per address (IPv4, IPv6 /64), 50 in all before the code
 *    is used up (anyone with the QR, over AppuBot Connect too, could otherwise end the owner's pairing with five).
 */
import { randomInt } from 'node:crypto';
import type { NetRoute } from '@appubot/protocol';
import type { Store, StoredDevice } from './store';
import { randomToken, sha256 } from './util';

export type Role = 'owner' | 'full' | 'limited' | 'agent';
export interface AgentContext { threadId: string; botId: string }

export type AuthResult =
  | { kind: 'owner'; role: 'owner'; deviceId: string }
  | { kind: 'device'; role: 'owner' | 'full' | 'limited'; deviceId: string; device: StoredDevice }
  | { kind: 'agent'; role: 'agent'; deviceId: string; agent: AgentContext }
  | { kind: 'revoked' }
  | { kind: 'invalid' };

export interface PairingCode {
  code: string;
  expiresAt: number;
  /** wrong tries from everywhere, and per address (the caller's `addressKey`: at most MAX_PAIR_FAILURES_TOTAL entries) */
  failures: number;
  bySource: Map<string, number>;
}

/** wrong codes one address may try before this code stops answering it */
export const MAX_PAIR_FAILURES = 5;
/** wrong codes from everywhere before the code is used up */
export const MAX_PAIR_FAILURES_TOTAL = 50;

export class Auth {
  readonly ownerToken = randomToken(32);
  private agentTokens = new Map<string, AgentContext>();
  pairing: PairingCode | null = null;

  constructor(private store: Store) {}

  /**
   * Who `token` is, for a caller that reached the gateway by `route`. The owner token (this computer's window and dev
   * scripts) and the bots' tokens are this computer's own: from anywhere else (Tailscale, AppuBot Connect, the channel,
   * the Wi-Fi) they are no token at all, so one that got out (a URL in a browser's history, a bot's output) opens
   * nothing from another device. Paired devices' tokens count from every route the gateway admits.
   */
  verify(token: string | undefined | null, route: NetRoute): AuthResult {
    if (!token) return { kind: 'invalid' };
    if (token === this.ownerToken) return route === 'local' ? { kind: 'owner', role: 'owner', deviceId: 'desktop' } : { kind: 'invalid' };
    const agent = this.agentTokens.get(token);
    if (agent) return route === 'local' ? { kind: 'agent', role: 'agent', deviceId: `agent-${agent.threadId}`, agent } : { kind: 'invalid' };
    const h = sha256(token);
    const dev = this.store.devices.get().devices.find((d) => d.tokenHash === h);
    if (dev) return { kind: 'device', role: dev.role, deviceId: dev.id, device: dev };
    if (this.store.devices.get().revoked.includes(h)) return { kind: 'revoked' };
    return { kind: 'invalid' };
  }

  issueAgentToken(ctx: AgentContext): string {
    const t = randomToken(24);
    this.agentTokens.set(t, ctx);
    return t;
  }

  revokeAgentToken(token: string): void { this.agentTokens.delete(token); }

  newDeviceToken(): { token: string; hash: string } {
    const token = randomToken(32);
    return { token, hash: sha256(token) };
  }

  startPairing(ttlSec: number): PairingCode {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.pairing = { code, expiresAt: Date.now() + Math.max(30, Math.min(ttlSec, 3600)) * 1000, failures: 0, bySource: new Map() };
    return this.pairing;
  }

  cancelPairing(): void { this.pairing = null; }

  /**
   * Validate + consume a pairing code tried from `source` (an address key). `blocked`: that address got it wrong
   * MAX_PAIR_FAILURES times and isn't heard for this code any more (right or wrong); others still are, until
   * MAX_PAIR_FAILURES_TOTAL wrong tries in all use the code up.
   */
  consumeCode(code: string, source = ''): 'ok' | 'bad' | 'blocked' | 'expired' | 'none' {
    const p = this.pairing;
    if (!p) return 'none';
    if (Date.now() > p.expiresAt) { this.pairing = null; return 'expired'; }
    const mine = p.bySource.get(source) ?? 0;
    if (mine >= MAX_PAIR_FAILURES) return 'blocked';
    if (code !== p.code) {
      p.failures++;
      p.bySource.set(source, mine + 1);
      if (p.failures >= MAX_PAIR_FAILURES_TOTAL) this.pairing = null;
      return 'bad';
    }
    this.pairing = null;
    return 'ok';
  }
}
