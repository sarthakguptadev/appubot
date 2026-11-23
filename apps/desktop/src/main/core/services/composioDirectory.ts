/**
 * The apps directory (Composio's toolkits), built before a release with the maker's own Composio key
 * (`pnpm -C apps/desktop apps-directory`, scripts/composio-directory.mts) and shipped in the app as
 * composioDirectory.json: users sign in to their own account, which has no API to list the directory.
 */
import type { AppAuthKind, AppCategory, AppToolkit } from '@appubot/protocol';
import { KEY_SCHEMES, OAUTH_SCHEMES, type ComposioApi, type ComposioToolkitInfo } from './composioApi';

export interface AppsDirectory { generatedAt: string; categories: AppCategory[]; toolkits: AppToolkit[] }

/** The directory as the app uses it: what the Apps page lists, and the apps left off it (kept for their names and logos). */
export interface ListedDirectory {
  categories: AppCategory[];
  /** apps a person can connect, or use as they are */
  toolkits: AppToolkit[];
  /** apps that can't be connected from AppuBot: never listed or searched, still named when connected elsewhere */
  unlisted: AppToolkit[];
  unavailable: Readonly<Record<string, UnavailableReason>>;
}

/** Composio's own placeholder ("Test app", alone in categories tag1 and tag2) and its meta toolkit (search and run tools: what the apps tools are) */
export const HIDDEN_TOOLKITS: ReadonlySet<string> = new Set(['test_app', 'composio']);

/**
 * Why an app can't be connected through AppuBot ("Composio for You" only connects what Composio runs a sign-in for):
 * `needs-setup` wants an auth config of the developer's own at Composio, `not-offered` isn't in Composio for You,
 * `retired` is gone. Read off Composio's answer to starting a connection (scripts/composio-unavailable.mts keeps the
 * list in composioUnavailable.json; the app reads the same answers when someone presses Add).
 */
export type UnavailableReason = 'needs-setup' | 'not-offered' | 'retired';

export function unavailableReason(message: string): UnavailableReason | undefined {
  if (/does not have managed auth|set up their own auth config/i.test(message)) return 'needs-setup';
  if (/is retired|can no longer be connected/i.test(message)) return 'retired';
  if (/not available in Composio For You/i.test(message)) return 'not-offered';
  return undefined;
}

/** How a toolkit signs in, as the directory shows it. */
export function authKindOf(t: Pick<ComposioToolkitInfo, 'authSchemes' | 'managedSchemes' | 'noAuth'>): AppAuthKind {
  if (t.noAuth) return 'none';
  const oauth = (s: string) => (OAUTH_SCHEMES as readonly string[]).includes(s);
  // OAuth Composio runs its own app for signs in with a click; without one it needs setup in Composio first
  if (t.authSchemes.some((s) => oauth(s) && t.managedSchemes.includes(s))) return 'oauth';
  if (t.authSchemes.some((s) => (KEY_SCHEMES as readonly string[]).includes(s))) return 'api_key';
  if (t.authSchemes.some(oauth)) return 'oauth';
  return t.authSchemes.length ? 'other' : 'none';
}

export function toToolkit(t: ComposioToolkitInfo): AppToolkit {
  const description = t.description?.replace(/\s+/g, ' ').trim();
  return {
    slug: t.slug,
    name: t.name || t.slug,
    logo: t.logo,
    description: description ? (description.length > 200 ? `${description.slice(0, 199)}…` : description) : undefined,
    categories: [...new Set(t.categories.map((c) => c.id))],
    authKind: authKindOf(t),
  };
}

/** Words Composio's (lowercase) category names should keep in capitals. */
const ACRONYMS = new Set(['ai', 'api', 'apis', 'crm', 'erp', 'hr', 'it', 'iot', 'ml', 'seo', 'sms', 'saas', 'ui', 'ux', 'bi', 'cms', 'llm', 'llms']);
const SMALL_WORDS = new Set(['and', 'or', 'of', 'the', 'for', 'in', 'on', 'to', 'a', 'an', 'with']);

/** "developer tools & devops" → "Developer Tools & DevOps"; names that already have capitals stay as they are. */
export function categoryName(name: string): string {
  const s = name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || s !== s.toLowerCase()) return s || name;
  let first = true;
  return s.replace(/[a-z0-9]+/g, (w) => {
    const out = w === 'devops' ? 'DevOps'
      : ACRONYMS.has(w) ? w.toUpperCase()
      : !first && SMALL_WORDS.has(w) ? w
      : w[0]!.toUpperCase() + w.slice(1);
    first = false;
    return out;
  });
}

/** The whole directory, most used first, with its categories by size. */
export async function buildDirectory(api: Pick<ComposioApi, 'toolkits'>): Promise<AppsDirectory> {
  const items: AppToolkit[] = [];
  const seen = new Set<string>();
  const names = new Map<string, string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await api.toolkits({ cursor, limit: 1000 });
    for (const t of res.items) {
      if (HIDDEN_TOOLKITS.has(t.slug) || seen.has(t.slug)) continue;
      seen.add(t.slug);
      for (const c of t.categories) names.set(c.id, c.name);
      items.push(toToolkit(t));
    }
    if (!res.nextCursor || !res.items.length) break;
    cursor = res.nextCursor;
  }
  const counts = new Map<string, number>();
  for (const t of items) for (const c of t.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
  const categories = [...counts]
    .map(([id, count]) => ({ id, name: categoryName(names.get(id) ?? id), count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { generatedAt: new Date().toISOString(), categories, toolkits: items };
}

/**
 * Splits the shipped directory into the apps the Apps page lists and the ones it leaves out (`unavailable`: the apps
 * Composio for You can't connect, composioUnavailable.json), with each category's count taken from what is listed.
 */
export function listedDirectory(d: AppsDirectory, unavailable: Readonly<Record<string, UnavailableReason>>): ListedDirectory {
  const all = d.toolkits.filter((t) => !HIDDEN_TOOLKITS.has(t.slug));
  const toolkits = all.filter((t) => !(t.slug in unavailable));
  const unlisted = all.filter((t) => t.slug in unavailable);
  const counts = new Map<string, number>();
  for (const t of toolkits) for (const c of t.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
  const categories = d.categories
    .map((c) => ({ ...c, count: counts.get(c.id) ?? 0 }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { categories, toolkits, unlisted, unavailable };
}
