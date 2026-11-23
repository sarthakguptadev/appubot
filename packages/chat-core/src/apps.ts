/**
 * Apps per bot, as both clients word it: apps are connected once for the whole Mac and each bot can have any of them
 * turned off (`Bot.appsOff`, see `appOn` in the protocol). The Apps page and the bot editors show who has what.
 */
import { appOn, type Bot } from '@appubot/protocol';

export interface AppBotsSummary<B extends Pick<Bot, 'id' | 'name' | 'appsOff'>> {
  /** the bots this app is on for, in roster order */
  on: B[];
  total: number;
  /** "All bots", "No bots", the one bot's name, or "2 of 3 bots" ('' without bots) */
  label: string;
}

/** Which bots may use the app `slug`, and how the per-bot control labels that. */
export function appBots<B extends Pick<Bot, 'id' | 'name' | 'appsOff'>>(bots: readonly B[], slug: string): AppBotsSummary<B> {
  const on = bots.filter((b) => appOn(b, slug));
  const total = bots.length;
  let label: string;
  if (!total) label = '';
  else if (on.length === total) label = total === 1 ? on[0]!.name : 'All bots';
  else if (!on.length) label = 'No bots';
  else if (on.length === 1) label = on[0]!.name;
  else label = `${on.length} of ${total} bots`;
  return { on, total, label };
}

/** The toolkits with a connection that works (an ACTIVE account): the ones bots can use. A signed-out one isn't. */
export function activeSlugs(connections: readonly { slug: string; status: string }[] | null | undefined): string[] {
  return [...new Set((connections ?? []).filter((c) => c.status === 'ACTIVE').map((c) => c.slug))];
}

/** The unique toolkit slugs of the user's connections (any status), in the order they come. */
export function connectedSlugs(connections: readonly { slug: string }[] | null | undefined): string[] {
  return [...new Set((connections ?? []).map((c) => c.slug))];
}
