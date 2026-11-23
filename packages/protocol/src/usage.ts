import { z } from 'zod';
import { Timestamp } from './entities';

/**
 * Settings › Usage (`usage.summary`): how much the agents on this computer were used, read from their own history
 * (Claude Code's and Codex's session logs, profiles included; Grok's, Pi's and Gemini CLI's session files; OpenCode's
 * and GitHub Copilot's databases), with an estimated cost at public API prices, or the cost an agent logged itself.
 * Nothing is sent anywhere; the estimate is not the user's subscription bill.
 */

/** Today (by the hour), the last 7 days or the last 30 days (by the day), today included. */
export const UsageRange = z.enum(['today', '7d', '30d']);
export type UsageRange = z.infer<typeof UsageRange>;

/** Everything the agents did on this computer, or only what AppuBot's bots did (requests run in a bot's folder). */
export const UsageScope = z.enum(['all', 'bots']);
export type UsageScope = z.infer<typeof UsageScope>;

/** Token counts and what they'd cost at API prices. `input` is the uncached part only. */
export const UsageTotalsSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  /** all four together */
  tokens: z.number().int().nonnegative(),
  /** estimated, USD */
  costUsd: z.number().nonnegative(),
  /** what reading from the cache saved against paying full input price for those tokens, USD */
  cacheSavingsUsd: z.number().nonnegative(),
  /** tokens of models with no known price and no cost logged by their agent (counted, never priced) */
  unpricedTokens: z.number().int().nonnegative(),
  /** model requests counted */
  requests: z.number().int().nonnegative(),
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

/** One bar of the chart: an hour (today) or a day, starting at `start` (local time). */
export const UsageBucketSchema = z.object({ start: Timestamp, tokens: z.number().int().nonnegative(), costUsd: z.number().nonnegative() });
export type UsageBucket = z.infer<typeof UsageBucketSchema>;

export const UsageModelRowSchema = UsageTotalsSchema.extend({
  /** the id as the agent logged it, date suffix dropped (`claude-opus-4-5`, `gpt-5.5`) */
  model: z.string(),
  /** for people ("Claude Opus 4.5", "GPT-5.5") */
  name: z.string(),
  /** whether the price table knows it, or its agent logged a cost for it */
  priced: z.boolean(),
});
export type UsageModelRow = z.infer<typeof UsageModelRowSchema>;

export const UsageAgentRowSchema = UsageTotalsSchema.extend({
  /** the provider id (`claude-code`, `codex`, a profile's `claude-code@work`, `grok`, `opencode`, `copilot`, `gemini`, `pi`) */
  id: z.string(),
  /** "Claude Code", or "Claude Code · Work" when it has profiles */
  name: z.string(),
});
export type UsageAgentRow = z.infer<typeof UsageAgentRowSchema>;

export const UsageSummarySchema = z.object({
  range: UsageRange,
  scope: UsageScope,
  from: Timestamp,
  to: Timestamp,
  totals: UsageTotalsSchema,
  /** the part of it that ran in a bot's folder (the rest is the agents used outside AppuBot) */
  byBots: z.object({ tokens: z.number().int().nonnegative(), costUsd: z.number().nonnegative() }),
  bucket: z.enum(['hour', 'day']),
  series: z.array(UsageBucketSchema),
  /** most expensive first */
  models: z.array(UsageModelRowSchema),
  agents: z.array(UsageAgentRowSchema),
  /** the agents whose history was found on this computer (none: the page says so) */
  sources: z.array(z.object({ id: z.string(), name: z.string() })),
  /** the day the price table was last checked (YYYY-MM-DD) */
  pricesAsOf: z.string(),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;
