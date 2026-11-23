import { z } from 'zod';
import { Timestamp } from './entities';

/**
 * Plan limits (`providers.limits`): how much of an agent's subscription is left, per window, read on the computer
 * from the agent's own sign-in (Claude Code's usage request, Codex's app-server, OpenCode Go's usage endpoint, Grok's
 * billing request, Cursor's and Kimi's usage endpoints, Google Antigravity's `/usage` answer, the AppuBot AI credit)
 * and kept up live from the agents' own sessions. Percentages, reset times and plan names only:
 * never a token, an account or what was said. An API-key login has no plan limits (`unavailable`).
 */

/**
 * Which models a window counts: `all` of the agent's, a `family` of Claude's (Opus, Sonnet, Fable… by name),
 * named `models` (Codex's per-model buckets, by slug; Cursor's own models), models named in words (`names`: Google
 * Antigravity's quota groups, "Gemini Pro", "Claude Opus": a model matches when every word of a name is in its id
 * or name), or the `rest` (Codex's plain bucket, Cursor's other models: every model no other window names).
 */
export const LimitScopeSchema = z.union([
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('family'), families: z.array(z.string()) }),
  z.object({ kind: z.literal('models'), slugs: z.array(z.string()) }),
  z.object({ kind: z.literal('names'), names: z.array(z.string()) }),
  z.object({ kind: z.literal('rest') }),
]);
export type LimitScope = z.infer<typeof LimitScopeSchema>;

export const LimitWindowSchema = z.object({
  /** stable within its agent: `five_hour`, `seven_day_opus`, `codex:primary`… */
  id: z.string(),
  /** "5-hour", "Week", "Week · Opus", "Month" */
  label: z.string(),
  /** the window's length, when known (300, 10080, 43200) */
  minutes: z.number().int().positive().optional(),
  /** 0..100 (over 100 when usage ran past the cap) */
  usedPercent: z.number(),
  /** when it resets (ms), when known */
  resetsAt: Timestamp.optional(),
  scope: LimitScopeSchema,
  /** the agent's own word on it, where it says: at its limit (`rejected`), or past a warning threshold */
  status: z.enum(['ok', 'warning', 'rejected']).optional(),
  /** which models it counts, for people ("Opus 5.5, Opus 4.8"), when the agent names them */
  models: z.string().optional(),
});
export type LimitWindow = z.infer<typeof LimitWindowSchema>;

export const LimitsStatus = z.enum([
  /** read in full */
  'ok',
  /** only what the agent's own sessions said so far (no snapshot could be read): updates with its next message */
  'live',
  /** the last read failed: what's shown is the last good read */
  'error',
  /** this login has no plan limits (an API key, Bedrock, Vertex, a local model) */
  'unavailable',
  /** the agent isn't signed in */
  'signed_out',
]);
export type LimitsStatus = z.infer<typeof LimitsStatus>;

export const ProviderLimitsSchema = z.object({
  providerId: z.string(),
  /** "Max", "Pro", "ChatGPT Plus", "Free"…, when the agent says */
  plan: z.string().optional(),
  status: LimitsStatus,
  /** why (`error`, `unavailable`, `live`), for people */
  message: z.string().optional(),
  windows: z.array(LimitWindowSchema),
  /** extra usage (Claude: pay-as-you-go once a limit is reached), when the account has it */
  extra: z.object({
    enabled: z.boolean(),
    usedUsd: z.number().optional(),
    limitUsd: z.number().optional(),
    currency: z.string().optional(),
    /** the agent is billing extra usage right now (a limit is reached and it carries on) */
    inUse: z.boolean().optional(),
  }).optional(),
  /** Codex: the account has credits that carry on past its limits */
  credits: z.boolean().optional(),
  /** a workspace's spend control is reached: the turn is refused whatever the windows say */
  spendLimitReached: z.boolean().optional(),
  /** when the numbers were last read or heard (ms) */
  updatedAt: Timestamp,
  /** where they came from last */
  source: z.enum(['claude', 'codex', 'opencode-go', 'credit', 'grok', 'cursor', 'kimi', 'antigravity', 'live', 'none']),
});
export type ProviderLimits = z.infer<typeof ProviderLimitsSchema>;

/** at or under this much left a model is "low" (MonoCode's threshold) */
export const LIMIT_LOW_LEFT = 20;
