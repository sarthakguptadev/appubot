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

/** The words a query is made of: lowercase, single-spaced. */
const words = (s: string): string[] => s.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * The apps a search finds, best first: the very name, a name that starts with it, a slug that does, a word of the
 * name that does, anywhere in the name, then the description (from three letters on), then a category by its name; a query of several words
 * finds an app that has each of them somewhere ("send email"). Ties keep the list's own order (the popular first).
 * `categories` names the category ids.
 */
export function searchApps<T extends { slug: string; name: string; description?: string; categories: readonly string[] }>(
  items: readonly T[],
  query: string,
  categories: readonly { id: string; name: string }[] = [],
): T[] {
  const qs = words(query);
  const n = qs.join(' ');
  if (!n) return [...items];
  const named = new Map(categories.map((c) => [c.id, c.name.toLowerCase()]));
  const rank = (t: T): number => {
    const name = t.name.toLowerCase();
    if (name === n) return 0;
    if (name.startsWith(n)) return 1;
    if (t.slug.startsWith(n)) return 2;
    if (name.split(/\W+/).some((w) => w.startsWith(n))) return 3;
    if (name.includes(n)) return 4;
    const about = t.description?.toLowerCase() ?? '';
    // a letter or two is the start of a name, not anything in a sentence
    if (n.length >= 3 && about.includes(n)) return 5;
    const cats = t.categories.map((id) => named.get(id) ?? id.replace(/-/g, ' '));
    // a category by its name, or the start of it from three letters on ("dev" isn't every developer tool's)
    if (cats.some((c) => c === n || (n.length >= 3 && c.startsWith(n)))) return 6;
    const all = `${name} ${t.slug} ${about} ${cats.join(' ')}`;
    return qs.length > 1 && qs.every((w) => all.includes(w)) ? 7 : -1;
  };
  return items.map((t, i) => ({ t, i, r: rank(t) })).filter((x) => x.r >= 0).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.t);
}
