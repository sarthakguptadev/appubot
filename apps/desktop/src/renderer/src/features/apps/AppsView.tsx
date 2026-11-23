import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppConnection, AppToolkit } from '@appubot/protocol';
import {
  AlertCircle, ArrowLeft, ChevronLeft, ExternalLink, Search, X,
} from '../../components/ui/icons';
import { Button, Card, Icon, Spinner, Tooltip, cn, isDialogOpen } from '../../components/ui';
import { useHotkey } from '../../lib/hooks';
import { ui, useStore } from '../../lib/store';
import { AppAction, AppLogo, AppRow, AppRowSkeleton } from './AppRow';
import { BotAccess } from './BotAccess';
import {
  RECOMMENDED, clearCatalogCache, loadConnections, signIn, useAppsLive, useAppsUi, useCatalog, useConnectedApps, type CatalogList,
} from './appsData';

/*
 * The Apps page (a Cursor/Synara-style plugin directory), a page of its own like settings: it covers the chat and the
 * side panel, and Back, Escape or opening a chat leaves it. Connected apps come first, each with the bots that may use
 * it (an app is connected once, for every bot; any bot can have it turned off), then Recommended for you and a section
 * per category. Sections load as they scroll into view; "View all" pages through one category and a search shows a
 * flat grid. Signed out of Composio the directory still shows, under a sign-in banner; adding an app signs in first.
 */

const SECTION_SIZE = 6;
const PAGE = 60;
/** one column, two from 540px, three from 840px (the page is at most 1000px wide) */
const COLUMNS = 'grid grid-cols-1 @min-[540px]:grid-cols-2 @min-[840px]:grid-cols-3';

/** The scrolling element, so sections can start loading a little before they come into view. */
const ScrollRoot = createContext<HTMLElement | null>(null);

function useInView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const root = useContext(ScrollRoot);
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { root, rootMargin: '480px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [root, seen]);
  return [ref, seen];
}

/** Connections grouped by toolkit slug (a toolkit can have an active and an expired one). */
export function useConnectionsBySlug(): Map<string, AppConnection[]> {
  const conns = useAppsUi((s) => s.connections);
  return useMemo(() => {
    const m = new Map<string, AppConnection[]>();
    for (const c of conns ?? []) m.set(c.slug, [...(m.get(c.slug) ?? []), c]);
    return m;
  }, [conns]);
}

const NO_CONNS: AppConnection[] = [];

function Grid({ toolkits, skeletons = 0 }: { toolkits: AppToolkit[]; skeletons?: number }) {
  const bySlug = useConnectionsBySlug();
  return (
    <div className={cn(COLUMNS, 'gap-x-8')}>
      {toolkits.map((t) => <AppRow key={t.slug} toolkit={t} conns={bySlug.get(t.slug) ?? NO_CONNS} />)}
      {Array.from({ length: skeletons }, (_, i) => <AppRowSkeleton key={`s${i}`} />)}
    </div>
  );
}

function Section({ title, hint, action, children, sectionRef }: { title: ReactNode; hint?: ReactNode; action?: ReactNode; children: ReactNode; sectionRef?: React.Ref<HTMLElement> }) {
  return (
    <section ref={sectionRef} className="not-first:mt-10">
      <div className="mb-2 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-lead font-medium text-fg">{title}</h3>
          {hint ? <p className="mt-0.5 text-ui leading-snug text-muted">{hint}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function ViewAll({ onClick }: { onClick: () => void }) {
  return <button type="button" onClick={onClick} className="no-drag shrink-0 text-copy text-muted transition-colors hover:text-fg">View all</button>;
}

function Problem({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-2 py-2 text-copy leading-snug text-muted">
      <Icon icon={AlertCircle} size={15} className="mt-px shrink-0 text-danger" />
      <span className="selectable min-w-0 flex-1">{text}</span>
      {onRetry ? <button type="button" className="shrink-0 text-fg-2 hover:text-fg" onClick={onRetry}>Retry</button> : null}
    </div>
  );
}

/** Loads the next page when the end of a long list scrolls into view (and offers a button, too). Keyed per page. */
function MoreSentinel({ list }: { list: CatalogList }) {
  const [ref, seen] = useInView<HTMLDivElement>();
  const { loadMore } = list;
  useEffect(() => { if (seen) loadMore(); }, [seen, loadMore]);
  if (!list.hasMore) return null;
  return (
    <div ref={ref} className="flex justify-center py-3">
      {list.loading ? <Spinner size={16} className="text-muted" /> : <Button size="sm" variant="ghost" onClick={list.loadMore}>Show more</Button>}
    </div>
  );
}

/** A full list (search results or one category), page by page. */
function FullList({ list, empty }: { list: CatalogList; empty: ReactNode }) {
  if (list.error && !list.toolkits.length) return <Problem text={list.error} onRetry={list.reload} />;
  if (!list.loading && !list.toolkits.length) return <p className="py-8 text-center text-copy text-muted">{empty}</p>;
  return (
    <>
      <Grid toolkits={list.toolkits} skeletons={list.loading && !list.toolkits.length ? SECTION_SIZE : 0} />
      <MoreSentinel key={list.toolkits.length} list={list} />
    </>
  );
}

function CategorySection({ id, name, count, onViewAll }: { id: string; name: string; count?: number; onViewAll: () => void }) {
  const [ref, seen] = useInView<HTMLElement>();
  const list = useCatalog(seen ? { category: id, limit: SECTION_SIZE } : null);
  return (
    <Section sectionRef={ref} title={name} action={(count ?? 0) > SECTION_SIZE ? <ViewAll onClick={onViewAll} /> : null}>
      {list.error ? <Problem text={list.error} onRetry={list.reload} /> : <Grid toolkits={list.toolkits} skeletons={list.loading ? Math.min(count ?? SECTION_SIZE, SECTION_SIZE) : 0} />}
    </Section>
  );
}

/** A connected app: its connection (Added / Reconnect) and, below, the bots that may use it. */
export function ConnectedCard({ toolkit: t, conns }: { toolkit: AppToolkit; conns: AppConnection[] }) {
  const active = conns.some((c) => c.status === 'ACTIVE');
  return (
    <Card className="flex min-w-0 flex-col">
      <div className="flex min-w-0 items-center gap-3 px-3.5 pt-3 pb-2">
        <AppLogo toolkit={t} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-copy leading-5 font-medium text-fg">{t.name}</div>
          <div className={cn('truncate text-ui leading-[18px]', active ? 'text-muted' : 'text-warning')} title={active ? t.description : undefined}>
            {active ? t.description || t.slug : 'Signed out'}
          </div>
        </div>
        <AppAction toolkit={t} conns={conns} />
      </div>
      {/* signed out, no bot has it: the switches come back with the connection */}
      {active ? <div className="hairline-t p-1.5"><BotAccess toolkit={t} /></div> : null}
    </Card>
  );
}

export function ConnectedSkeleton() {
  return (
    <Card className="flex flex-col" aria-hidden>
      <div className="px-3.5 pt-1 pb-0"><AppRowSkeleton /></div>
      <div className="hairline-t flex items-center gap-2 px-3.5 py-3">
        <span className="size-[18px] rounded-full bg-surface-2" />
        <span className="h-2.5 w-20 rounded-full bg-surface-2" />
      </div>
    </Card>
  );
}

function Directory({ onCategory }: { onCategory: (c: { id: string; name: string }) => void }) {
  const conns = useAppsUi((s) => s.connections);
  const connsError = useAppsUi((s) => s.connectionsError);
  // signed in to Composio, or a computer that also connects apps on their own servers: there are connections to list
  const lists = useStore((s) => !!s.apps?.configured || !!s.apps?.direct);
  const bySlug = useConnectionsBySlug();
  const connected = useConnectedApps();
  const { slugs } = connected;
  // one call brings the popular picks and the category list (and warms the whole directory)
  const meta = useCatalog({ slugs: RECOMMENDED });
  // anything already connected (or needing a reconnect) is listed above instead
  const recommended = meta.toolkits.filter((t) => !slugs.includes(t.slug)).slice(0, SECTION_SIZE);
  // what's connected decides what's recommended
  const waiting = meta.loading || (lists && conns === null && !connsError);

  if (meta.error) return <Problem text={meta.error} onRetry={meta.reload} />;
  return (
    <>
      {connsError ? <Problem text={`Couldn't load your connections: ${connsError}`} onRetry={() => void loadConnections()} /> : null}
      {lists && slugs.length ? (
        <Section title="Connected" hint="Each app is connected once, for all your bots. Choose which bots use it.">
          <div className={cn(COLUMNS, 'ab-rise-list gap-3')}>
            {connected.loading
              ? slugs.map((s) => <ConnectedSkeleton key={s} />)
              : connected.toolkits.map((t) => <ConnectedCard key={t.slug} toolkit={t} conns={bySlug.get(t.slug) ?? NO_CONNS} />)}
          </div>
        </Section>
      ) : null}
      {waiting || recommended.length ? (
        <Section title="Recommended for you">
          <Grid toolkits={waiting ? [] : recommended} skeletons={waiting ? SECTION_SIZE : 0} />
        </Section>
      ) : null}
      {meta.categories.map((c) => <CategorySection key={c.id} id={c.id} name={c.name} count={c.count} onViewAll={() => onCategory(c)} />)}
    </>
  );
}

/** Composio's sign-in in the browser; while it waits, the button opens the page again. */
export function SignInButton({ size = 'md', again = false }: { size?: 'sm' | 'md'; again?: boolean }) {
  const waiting = useStore((s) => !!s.apps?.signingIn);
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); await signIn(); setBusy(false); };
  return (
    <Button size={size} variant="primary" iconRight={ExternalLink} loading={busy} onClick={() => void go()}>
      {waiting ? 'Open sign-in again' : again ? 'Sign in again' : 'Sign in with Composio'}
    </Button>
  );
}

function SearchField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="ab-pill squircle no-drag flex h-9 w-[260px] min-w-0 items-center gap-2 rounded-control bg-surface-2 px-3 transition-[box-shadow,background-color] duration-150 ease-rare hover:bg-surface-3 focus-within:shadow-[0_0_0_2px_var(--ab-ring)]">
      <Icon icon={Search} size={14} className="shrink-0 text-muted" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // a query clears first; then Escape lets go of the field, and the next one leaves Apps
        onKeyDown={(e) => { if (e.key === 'Escape' && value) { e.preventDefault(); e.stopPropagation(); onChange(''); } }}
        placeholder="Search apps"
        aria-label="Search apps"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-copy text-fg outline-none placeholder:text-muted"
      />
      {value ? (
        <Tooltip label="Clear">
          <button type="button" aria-label="Clear search" className="flex size-5 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg" onClick={() => onChange('')}>
            <Icon icon={X} size={12} />
          </button>
        </Tooltip>
      ) : null}
    </label>
  );
}

/** The Apps page, centred in the content card under its header (search on the right). */
export function AppsPage() {
  const apps = useStore((s) => s.apps);
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<{ id: string; name: string } | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  useAppsLive();

  // Escape leaves Apps, unless a dialog or menu owns it; inside a field it only lets go of the field
  useHotkey((e) => e.key === 'Escape' && !isDialogOpen(), () => {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.blur();
    else ui.closeApps();
  });
  // land keyboard focus on the page when it opens, so arrows / page keys scroll it
  useEffect(() => { scroller?.focus({ preventScroll: true }); }, [scroller]);

  // another account has other connections: start over at the top
  const account = useRef(apps?.account);
  useEffect(() => {
    if (account.current === apps?.account) return;
    account.current = apps?.account;
    clearCatalogCache();
    setCategory(null);
  }, [apps?.account]);
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);
  // a new search or category starts at the top
  useEffect(() => { scroller?.scrollTo({ top: 0 }); }, [q, category, scroller]);

  const results = useCatalog(apps && q ? { search: q, limit: PAGE } : null);
  const categoryList = useCatalog(apps && category && !q ? { category: category.id, limit: PAGE } : null);

  let body: ReactNode;
  if (!apps) body = <div className="flex justify-center py-16 text-muted"><Spinner size={18} /></div>;
  else if (q) {
    body = (
      <Section title={results.total !== undefined && !results.loading ? `${results.total} result${results.total === 1 ? '' : 's'}` : 'Results'}>
        <FullList list={results} empty={<>No apps match “{q}”</>} />
      </Section>
    );
  } else if (category) {
    body = (
      <>
        <button type="button" onClick={() => setCategory(null)} className="no-drag -ml-1 mb-2 ab-pill squircle inline-flex h-7 items-center gap-1 rounded-control-sm pr-2.5 pl-1 text-copy text-muted transition-colors hover:bg-surface-2 hover:text-fg">
          <Icon icon={ChevronLeft} size={15} />All apps
        </button>
        <Section title={category.name} action={categoryList.total !== undefined ? <span className="text-copy text-muted tabular-nums">{categoryList.total}</span> : null}>
          <FullList list={categoryList} empty="Nothing here yet" />
        </Section>
      </>
    );
  } else body = <Directory onCategory={setCategory} />;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* the window can still be dragged by the card's top edge */}
      <div className="drag absolute inset-x-0 top-0 z-10 h-12" />
      <div ref={setScroller} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
        <div className="@container mx-auto w-full max-w-[1000px] px-8 pt-14 pb-12">
          <header className="mb-8 flex flex-wrap items-start gap-x-6 gap-y-4">
            <div className="min-w-[280px] flex-1">
              <h1 className="flex items-center gap-1.5 text-xl font-medium tracking-tight text-fg">
                <Tooltip label="Back to chat (Esc)">
                  <Button size="icon-sm" variant="ghost" icon={ArrowLeft} aria-label="Back to chat" className="-ml-1.5" onClick={ui.closeApps} />
                </Tooltip>
                Apps
              </h1>
              <p className="mt-1.5 text-copy leading-relaxed text-muted">
                Connect an app once and your bots can use it. Choose which bots get each app here, or in a bot's settings.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {apps ? <SearchField value={query} onChange={setQuery} /> : null}
            </div>
          </header>
          {apps?.error ? (
            <div className="mb-8 flex max-w-xl flex-col gap-2 rounded-control-lg border border-[color-mix(in_srgb,var(--ab-danger)_30%,transparent)] bg-danger-soft px-3.5 py-3">
              <p className="selectable text-copy leading-snug text-danger">{apps.error}</p>
              {apps.configured ? null : <div><SignInButton size="sm" again /></div>}
            </div>
          ) : null}
          <ScrollRoot.Provider value={scroller}>{scroller ? body : null}</ScrollRoot.Provider>
        </div>
      </div>
    </div>
  );
}
