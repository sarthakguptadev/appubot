/**
 * The slice of Composio's platform API the apps directory is built from (scripts/composio-directory.ts, before a
 * release, with the maker's own key; the app itself never holds one). `@composio/core` is imported on first use (it
 * is large and ESM-only), with anonymous tracking and the npm version check off.
 */

export interface ComposioToolkitInfo {
  slug: string;
  name: string;
  logo?: string;
  description?: string;
  categories: { id: string; name: string }[];
  authSchemes: string[];
  /** schemes Composio has its own app/credentials for (OAuth works without setup) */
  managedSchemes: string[];
  noAuth: boolean;
}

export interface ComposioApi {
  /** one page of toolkits, most used first */
  toolkits(q: { search?: string; category?: string; cursor?: string; limit: number }): Promise<{ items: ComposioToolkitInfo[]; nextCursor?: string; total?: number }>;
}

/** Auth schemes whose values the user can type into a form, most common first. */
export const KEY_SCHEMES = ['API_KEY', 'BEARER_TOKEN', 'BASIC', 'BASIC_WITH_JWT'] as const;
export const OAUTH_SCHEMES = ['OAUTH2', 'OAUTH1', 'DCR_OAUTH', 'CIMD_OAUTH'] as const;

export function composioApi(apiKey: string): ComposioApi {
  // project keys (`ak_…`) and user keys (`uak_…`) both work; the SDK sends each under its own header
  const cred = /^uak_/.test(apiKey) ? { userApiKey: apiKey } : { apiKey };
  const sdk = import('@composio/core').then(({ Composio: C }) => new C({ ...cred, allowTracking: false, disableVersionCheck: true }));
  return {
    async toolkits(q) {
      // the raw client: the SDK's `toolkits.get()` drops `search` and the next-page cursor
      const res = await (await sdk).getClient().toolkits.list({ search: q.search, category: q.category, cursor: q.cursor, limit: q.limit, sort_by: 'usage' });
      return {
        items: res.items.map((t) => ({
          slug: t.slug,
          name: t.name,
          logo: t.meta?.logo || undefined,
          description: t.meta?.description || undefined,
          categories: t.meta?.categories ?? [],
          authSchemes: t.auth_schemes ?? [],
          managedSchemes: t.composio_managed_auth_schemes ?? [],
          noAuth: !!t.no_auth,
        })),
        nextCursor: res.next_cursor ?? undefined,
        total: res.total_items,
      };
    },
  };
}
