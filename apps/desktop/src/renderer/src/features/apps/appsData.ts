import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { isDirectApp, withAppOn, type AppCategory, type AppConnection, type AppToolkit, type Bot, type MethodResult } from '@appubot/protocol';
import { connectedSlugs } from '@appubot/chat-core';
import { call, confirm, updateBot } from '../../lib/actions';
import { errorMessage, rpc } from '../../lib/gateway';
import { setState, useStore } from '../../lib/store';
import { useCloudLink } from '../cloud/cloudClient';
import { listenForAppsSignIn, onCloud, startCloudConnect, startCloudSignIn } from './cloudApps';

/* Data for the Apps directory: a catalog cache (the gateway has the whole directory, shipped with the app; a query
   asked before shows at once when sections remount, and is asked again behind it after a few minutes), the Composio sign-in, the user's connections, the
   connect / disconnect flows and which bots may use each app. On the cloud computer (features/cloud) the sign-in and
   the link pages open in this computer's browser instead (`cloudApps.ts`). */

/** Popular toolkits "Recommended for you" draws from: the first few that exist and aren't connected yet. */
export const RECOMMENDED = ['gmail', 'googlecalendar', 'slack', 'notion', 'github', 'googledrive', 'linear', 'googlesheets', 'outlook', 'hubspot', 'jira', 'discord'];

export interface CatalogQuery { search?: string; category?: string; slugs?: string[]; limit?: number }
type Page = MethodResult<'apps.catalog'>;

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; page: Page }>();

export function clearCatalogCache(): void { cache.clear(); }

async function fetchPage(q: CatalogQuery, cursor?: string): Promise<Page> {
  const k = JSON.stringify([q, cursor]);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.page;
  const page = await rpc('apps.catalog', { ...q, cursor });
  cache.set(k, { at: Date.now(), page });
  return page;
}

export interface CatalogList {
  toolkits: AppToolkit[];
  categories: AppCategory[];
  total?: number;
  loading: boolean;
  error?: string;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
}

interface Shown { key: string; toolkits: AppToolkit[]; categories: AppCategory[]; total?: number; next?: string; loading: boolean; error?: string }

const shownPage = (key: string, p: Page): Shown => ({ key, toolkits: p.toolkits, categories: p.categories, total: p.total, next: p.nextCursor, loading: false });

/**
 * One catalog query, page by page (`loadMore` appends the next one). `null` waits, and so does a gateway that isn't
 * connected yet: the sidebar's Connect apps button asks at launch, before it is, and its logos came up empty for good.
 */
export function useCatalog(q: CatalogQuery | null): CatalogList {
  const connected = useStore((s) => s.conn === 'connected');
  const key = q ? JSON.stringify(q) : '';
  const [st, setSt] = useState<Shown>(() => {
    const hit = q && cache.get(JSON.stringify([q, undefined]));
    return hit ? shownPage(key, hit.page) : { key: '', toolkits: [], categories: [], loading: !!q };
  });
  const [nonce, setNonce] = useState(0);
  const busy = useRef(false);
  const shown = useRef(st);
  shown.current = st;
  /** the query and reload last asked for: a reconnect asks again only for one that failed or never ran */
  const ran = useRef({ key: '', nonce: -1 });

  useEffect(() => {
    if (!q) return;
    // asked before: shown at once (even before the gateway is up), and asked again behind it once it's old
    const hit = cache.get(JSON.stringify([q, undefined]));
    if (hit && shown.current.key !== key) setSt(shownPage(key, hit.page));
    if (!connected) return;
    const s = shown.current;
    if (ran.current.key === key && ran.current.nonce === nonce && s.key === key && !s.error) return;
    ran.current = { key, nonce };
    let live = true;
    if (!hit) setSt({ key, toolkits: [], categories: [], loading: true });
    fetchPage(q).then(
      (p) => { if (live && p !== hit?.page) setSt(shownPage(key, p)); },
      (e: unknown) => { if (live && !hit) setSt({ key, toolkits: [], categories: [], loading: false, error: errorMessage(e) }); },
    );
    return () => { live = false; };
    // `key` stands for `q`
  }, [key, nonce, connected]);

  const loadMore = useCallback(() => {
    if (!q || !st.next || busy.current) return;
    busy.current = true;
    const at = key;
    setSt((s) => ({ ...s, loading: true }));
    fetchPage(q, st.next).then(
      (p) => setSt((s) => (s.key !== at ? s : {
        ...s, loading: false, next: p.nextCursor, total: p.total ?? s.total,
        toolkits: [...s.toolkits, ...p.toolkits.filter((t) => !s.toolkits.some((x) => x.slug === t.slug))],
      })),
      (e: unknown) => setSt((s) => (s.key !== at ? s : { ...s, loading: false, error: errorMessage(e) })),
    ).finally(() => { busy.current = false; });
  }, [q, key, st.next]);

  const fresh = st.key === key;
  return {
    toolkits: fresh ? st.toolkits : [],
    categories: fresh ? st.categories : [],
    total: fresh ? st.total : undefined,
    loading: !fresh || st.loading,
    error: fresh ? st.error : undefined,
    hasMore: fresh && !!st.next,
    loadMore,
    reload: () => { clearCatalogCache(); setNonce((n) => n + 1); },
  };
}

/* ---------- connections & sign-ins ---------- */

interface AppsUi {
  connections: AppConnection[] | null;
  connectionsError?: string;
  /** clicked, waiting for the gateway (its `pending` takes over once the sign-in window is open) */
  starting: Record<string, true>;
  /** the app Add was clicked on while signed out: connected once the Composio sign-in is done */
  afterSignIn: AppToolkit | null;
}

export const useAppsUi = create<AppsUi>()(() => ({ connections: null, starting: {}, afterSignIn: null }));

// another computer on screen: its apps are its own (one computer's connections never show as another's, and an Add
// pressed on one isn't carried out on the other)
useCloudLink.subscribe((now, before) => {
  if (now.computer !== before.computer || now.team !== before.team) useAppsUi.setState({ connections: null, connectionsError: undefined, starting: {}, afterSignIn: null });
});

const setStarting = (slug: string, on: boolean): void => useAppsUi.setState((s) => {
  const starting = { ...s.starting };
  if (on) starting[slug] = true; else delete starting[slug];
  return { starting };
});

export async function loadAppsStatus(): Promise<void> {
  const s = await call('apps.status', undefined, { errorTitle: 'Could not load Apps' });
  if (s) setState({ apps: s });
}

export async function loadConnections(): Promise<void> {
  try {
    useAppsUi.setState({ connections: await rpc('apps.connections'), connectionsError: undefined });
  } catch (e) {
    useAppsUi.setState({ connectionsError: errorMessage(e) });
  }
}

/** Keeps the Composio status and the connections current while a view that shows them is up. */
export function useAppsLive(): void {
  const apps = useStore((s) => s.apps);
  const conn = useStore((s) => s.conn);
  // a cloud sign-in started before a reload still comes back here
  useEffect(() => { listenForAppsSignIn(); }, []);
  useEffect(() => { if (conn === 'connected') void loadAppsStatus(); }, [conn]);
  // a status change (connection made, signed in or out) means the connections may have too; signed out by any route
  // (the button, the sign-in ending, another device) nothing is connected here any more
  useEffect(() => {
    // the apps on their own servers are there with or without a Composio sign-in
    if (apps?.configured || apps?.direct) void loadConnections();
    else if (apps) useAppsUi.setState({ connections: null, connectionsError: undefined });
  }, [apps]);
  // a sign-in given up or refused: the app Add was pressed on isn't connected by surprise at some later sign-in
  useEffect(() => {
    if (apps && !apps.configured && !apps.signingIn) useAppsUi.setState({ afterSignIn: null });
  }, [apps?.configured, apps?.signingIn]);
  // signed in after clicking Add on an app: carry on connecting it
  useEffect(() => {
    const t = useAppsUi.getState().afterSignIn;
    if (!apps?.configured || !t) return;
    useAppsUi.setState({ afterSignIn: null });
    void startConnect(t);
  }, [apps?.configured]);
}

/** The connected apps, one per toolkit, with their directory entries (a custom toolkit the directory lacks shows by slug). */
export function useConnectedApps(): { slugs: string[]; toolkits: AppToolkit[]; loading: boolean } {
  const conns = useAppsUi((s) => s.connections);
  const slugs = useMemo(() => connectedSlugs(conns).slice(0, 50), [conns]);
  const list = useCatalog(slugs.length ? { slugs } : null);
  const toolkits = useMemo(() => {
    const known = new Map(list.toolkits.map((t) => [t.slug, t]));
    return list.loading ? [] : slugs.map((s): AppToolkit => known.get(s) ?? { slug: s, name: s, categories: [], authKind: 'other' });
  }, [list.toolkits, list.loading, slugs]);
  return { slugs, toolkits, loading: list.loading };
}

/**
 * Turn one connected app on or off for a bot (its `appsOff`; the connection itself stays, for every other bot).
 * Shown at once; put back if the gateway refuses.
 */
export async function setAppOn(bot: Bot, slug: string, on: boolean): Promise<void> {
  await updateBot(bot, { appsOff: withAppOn(bot, slug, on) }, { errorTitle: `Couldn't change ${bot.name}'s apps` });
}

/** Start connecting an app: Composio's page for it (sign-in, or the key it needs) in the browser. */
export async function startConnect(t: AppToolkit): Promise<boolean> {
  // signed out: sign in first, then this app (`useAppsLive`); an app on its own server needs no Composio sign-in
  if (!isDirectApp(t.slug) && !useStore.getState().apps?.configured) {
    useAppsUi.setState({ afterSignIn: t });
    await signIn();
    return false;
  }
  setStarting(t.slug, true);
  // the cloud's link page opens here, in this computer's browser; this Mac's in its own (the gateway opens it)
  const res = onCloud()
    ? await startCloudConnect(t)
    : await call('apps.connect', { slug: t.slug }, { errorTitle: `Couldn't connect ${t.name}` });
  setStarting(t.slug, false);
  if (res) void loadConnections();
  return !!res;
}

export function disconnect(t: Pick<AppToolkit, 'name'>, conns: AppConnection[]): void {
  confirm({
    title: `Disconnect ${t.name}?`,
    body: conns.every((c) => isDirectApp(c.slug))
      ? `Your bots lose access to ${t.name}. You can add it again any time.`
      : `Your bots lose access to ${t.name}, and so does anything else using your Composio account. You can add it again any time.`,
    confirmLabel: 'Disconnect',
    danger: true,
    onConfirm: async () => {
      for (const c of conns) {
        if (!(await call('apps.disconnect', { connectedAccountId: c.connectedAccountId, slug: c.slug }, { errorTitle: `Couldn't disconnect ${t.name}` }))) break;
      }
      await loadConnections();
    },
  });
}

/** Opens Composio's sign-in in the browser; `apps.updated` says when it's done. */
export async function signIn(): Promise<void> {
  // the cloud computer's sign-in comes back to this app's own link (`appubot://apps/signed-in`)
  if (onCloud()) return startCloudSignIn();
  const s = await call('apps.signIn', undefined, { errorTitle: "Couldn't start the Composio sign-in" });
  if (s) setState({ apps: s });
}

/** Signs out of Composio on this computer, after a confirm (the connections stay in the account). */
export function signOut(): void {
  confirm({
    title: 'Sign out of Composio?',
    body: 'Your bots lose access to your connected apps until you sign in again. The connections stay in your Composio account.',
    confirmLabel: 'Sign out',
    danger: true,
    onConfirm: async () => {
      const s = await call('apps.signOut', undefined, { errorTitle: "Couldn't sign out" });
      if (!s) return;
      setState({ apps: s });
      useAppsUi.setState({ connections: null, connectionsError: undefined });
    },
  });
}
