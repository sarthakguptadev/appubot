import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppCategory, AppConnection, AppToolkit } from '@appubot/protocol';
import { activeSlugs } from '@appubot/chat-core';
import { AlertCircle, Check, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, MoreHorizontal, Search, Trash2, X } from '../../components/ui/icons';
import { Badge, Button, Dialog, Icon, Menu, Spinner, Tooltip, cn } from '../../components/ui';
import { SEGMENT, SEGMENT_SIZE, SegmentChip } from '../../components/ui/Tabs';
import { ui, useStore } from '../../lib/store';
import { AppAction, AppLogo, AppLogoStack, AppRow, AppRowSkeleton } from './AppRow';
import { BotAccess } from './BotAccess';
import { chipsThatFit } from './chips';
import {
  RECOMMENDED, accountName, clearCatalogCache, loadConnections, makeDefault, removeAccount, signIn, useAppsLive, useAppsUi, useCatalog, useConnectedApps,
  type CatalogList,
} from './appsData';

/*
 * Connect apps: a dialog over whatever is on screen (a Cursor/Synara-style plugin directory). It opens on the
 * directory: a search, the categories as chips, then Recommended for you and a section per category. Sections load as
 * they scroll into view; a chip or "View all" pages through one category and a search shows a flat list. The apps
 * already connected are a view of their own, behind the header's "3 connected": each with the bots that may use it (an
 * app is connected once, for every bot; any bot can have it turned off), and an app with several accounts (two Gmails)
 * with each of them and the one the bots use by default. Signed out of Composio the directory still shows; adding an
 * app signs in first.
 */

const SECTION_SIZE = 6;
const PAGE = 60;
/** connected apps listed before "Show all" */
const CONNECTED_SHOWN = 12;
/** one column, two from 560px (the dialog is at most 880px wide) */
const COLUMNS = 'grid grid-cols-1 gap-x-8 @min-[560px]:grid-cols-2';
const BACK =
  'no-drag ab-pill squircle -ml-1 inline-flex h-7 items-center gap-1 rounded-control-sm pr-2.5 pl-1 text-copy text-muted transition-colors hover:bg-surface-2 hover:text-fg ' +
  'focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--ab-fg)_35%,transparent)]';

/**
 * The dialog's body scrolls as one (a short list is as wide as a long one), under a top that stays put: the search and
 * the categories, or the way back. Below it the sections, a step apart.
 */
const SCROLLER = 'min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]';
const TOP = 'sticky top-0 z-10 bg-[var(--ab-content)] px-6';
const LIST = '@container flex flex-col gap-8 px-6 pb-6';

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
    <div className={COLUMNS}>
      {toolkits.map((t) => <AppRow key={t.slug} toolkit={t} conns={bySlug.get(t.slug) ?? NO_CONNS} />)}
      {Array.from({ length: skeletons }, (_, i) => <AppRowSkeleton key={`s${i}`} />)}
    </div>
  );
}

function Section({ title, hint, action, children, sectionRef }: { title: ReactNode; hint?: ReactNode; action?: ReactNode; children: ReactNode; sectionRef?: React.Ref<HTMLElement> }) {
  return (
    <section ref={sectionRef}>
      <div className="mb-1.5 flex items-end justify-between gap-3">
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
  if (!list.loading && !list.toolkits.length) return <p className="py-12 text-center text-copy text-muted">{empty}</p>;
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

function Directory({ meta, onCategory }: { meta: CatalogList; onCategory: (id: string) => void }) {
  const conns = useAppsUi((s) => s.connections);
  const connsError = useAppsUi((s) => s.connectionsError);
  // signed in to Composio, or a computer that also connects apps on their own servers: there are connections to list
  const lists = useStore((s) => !!s.apps?.configured || !!s.apps?.direct);
  const { slugs } = useConnectedApps();
  // anything already connected (or needing a reconnect) is in the connected view instead
  const recommended = meta.toolkits.filter((t) => !slugs.includes(t.slug)).slice(0, SECTION_SIZE);
  // what's connected decides what's recommended
  const waiting = meta.loading || (lists && conns === null && !connsError);

  if (meta.error) return <Problem text={meta.error} onRetry={meta.reload} />;
  return (
    <>
      {connsError ? <Problem text={`Couldn't load your connections: ${connsError}`} onRetry={() => void loadConnections()} /> : null}
      {waiting || recommended.length ? (
        <Section title="Recommended for you">
          <Grid toolkits={waiting ? [] : recommended} skeletons={waiting ? SECTION_SIZE : 0} />
        </Section>
      ) : null}
      {meta.categories.map((c) => <CategorySection key={c.id} id={c.id} name={c.name} count={c.count} onViewAll={() => onCategory(c.id)} />)}
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

function SearchField({ value, onChange, inputRef }: { value: string; onChange: (v: string) => void; inputRef: React.Ref<HTMLInputElement> }) {
  return (
    <label className="ab-pill squircle no-drag flex h-9 min-w-0 items-center gap-2 rounded-control bg-surface-2 px-3 transition-[box-shadow,background-color] duration-150 ease-rare hover:bg-surface-3 focus-within:shadow-[0_0_0_2px_var(--ab-ring)]">
      <Icon icon={Search} size={14} className="shrink-0 text-muted" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // a query clears first; the next Escape closes the dialog
        onKeyDown={(e) => { if (e.key === 'Escape' && value) { e.preventDefault(); e.stopPropagation(); onChange(''); } }}
        placeholder="Search apps"
        aria-label="Search apps"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-copy text-fg outline-none placeholder:text-muted"
      />
      {value ? (
        <Tooltip label="Clear">
          <button type="button" aria-label="Clear search" className="ab-pill flex size-5 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg" onClick={() => onChange('')}>
            <Icon icon={X} size={12} />
          </button>
        </Tooltip>
      ) : null}
    </label>
  );
}

const CHIP_GAP = 4;
/** the More button and the gap before it */
const MORE_ROOM = 80;

/**
 * How many of a row's chips fit on one line beside a More button, and how wide those are: every chip is laid out (the
 * ones past the line wrap out of sight), so each has its width whatever the row's is.
 */
function useChipFit(chips: unknown): [React.RefObject<HTMLDivElement | null>, { count: number; width?: number }] {
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ count: number; width?: number }>({ count: Number.POSITIVE_INFINITY });
  useLayoutEffect(() => {
    const row = ref.current;
    const list = row?.firstElementChild;
    if (!row || !list) return;
    const measure = () => {
      const { count, width } = chipsThatFit(Array.from(list.children, (k) => (k as HTMLElement).offsetWidth), row.clientWidth, CHIP_GAP, MORE_ROOM);
      setFit((was) => (was.count === count && was.width === width ? was : { count, width }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    // the interface font arriving changes every chip's width
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, [chips]);
  return [ref, fit];
}

/**
 * The directory's categories as a row of chips, "All" first: as many as fit on one line, the rest under More. One
 * picked from More (or from a section's "View all") moves to the front of the row, where it shows.
 */
function Categories({ categories, value, onPick }: { categories: AppCategory[]; value: string | null; onPick: (id: string | null) => void }) {
  const [front, setFront] = useState<string | null>(null);
  const ordered = useMemo(() => {
    const first = categories.find((c) => c.id === front);
    return first ? [first, ...categories.filter((c) => c !== first)] : categories;
  }, [categories, front]);
  const [ref, fit] = useChipFit(ordered);
  // "All" is the row's first chip
  const shown = Math.max(0, fit.count - 1);
  useEffect(() => {
    if (value && ordered.findIndex((c) => c.id === value) >= shown) setFront(value);
    // only a new pick moves a chip
  }, [value]);
  const chip = (id: string | null, label: string, visible: boolean) => {
    const active = id === value;
    return (
      <button
        key={id ?? ''}
        type="button"
        role="tab"
        aria-selected={active}
        aria-hidden={visible ? undefined : true}
        tabIndex={visible ? undefined : -1}
        onClick={() => onPick(id)}
        className={cn(SEGMENT, SEGMENT_SIZE.md, 'shrink-0', active ? 'text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg')}
      >
        {active ? <SegmentChip raised={false} /> : null}
        <span className="relative">{label}</span>
      </button>
    );
  };
  const more = ordered.slice(shown);
  return (
    <div ref={ref} className="flex min-h-7 items-start gap-1">
      <div role="tablist" aria-label="Categories" style={{ maxWidth: fit.width }} className="no-drag flex h-7 min-w-0 flex-wrap gap-1 overflow-hidden">
        {chip(null, 'All', true)}
        {ordered.map((c, i) => chip(c.id, c.name, i < shown))}
      </div>
      {more.length ? (
        <Menu
          scrollAfter={9}
          items={more.map((c) => ({ label: c.name, current: c.id === value, onSelect: () => onPick(c.id) }))}
          trigger={(p) => (
            <button {...p} type="button" className={cn(SEGMENT, SEGMENT_SIZE.md, 'no-drag shrink-0 text-muted hover:bg-surface-2 hover:text-fg')}>
              More<Icon icon={ChevronDown} size={13} />
            </button>
          )}
        />
      ) : null}
    </div>
  );
}

/** Composio can't be reached, or its sign-in ended: said above whatever the dialog shows. */
function Trouble() {
  const apps = useStore((s) => s.apps);
  if (!apps?.error) return null;
  return (
    <div className="flex flex-col gap-2 rounded-card border border-[color-mix(in_srgb,var(--ab-danger)_30%,transparent)] bg-danger-soft px-3.5 py-3">
      <p className="selectable text-copy leading-snug text-danger">{apps.error}</p>
      {apps.configured ? null : <div><SignInButton size="sm" again /></div>}
    </div>
  );
}

/** The directory: search and categories stay put above the list. */
function Browse() {
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const field = useRef<HTMLInputElement>(null);
  // typing searches at once, from the dialog opening and from coming back to this view
  useEffect(() => { field.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);
  // a new search or category starts at the top
  useEffect(() => { scroller?.scrollTo({ top: 0 }); }, [q, category, scroller]);

  // one call brings the popular picks and the category list (and warms the whole directory)
  const meta = useCatalog({ slugs: RECOMMENDED });
  const results = useCatalog(q ? { search: q, limit: PAGE } : null);
  const categoryList = useCatalog(category && !q ? { category, limit: PAGE } : null);
  const picked = meta.categories.find((c) => c.id === category);

  let body: ReactNode;
  if (q) {
    body = (
      <Section title={results.total !== undefined && !results.loading ? `${results.total} result${results.total === 1 ? '' : 's'}` : 'Results'}>
        <FullList list={results} empty={<>No apps match “{q}”</>} />
      </Section>
    );
  } else if (category) {
    body = (
      <Section title={picked?.name ?? category} action={categoryList.total !== undefined ? <span className="text-copy text-muted tabular-nums">{categoryList.total}</span> : null}>
        <FullList list={categoryList} empty="Nothing here yet" />
      </Section>
    );
  } else body = <Directory meta={meta} onCategory={setCategory} />;

  return (
    <div ref={setScroller} className={SCROLLER}>
      <div className={cn(TOP, 'flex flex-col gap-3 pt-2 pb-4')}>
        {/* a search looks through every app, so it leaves the category */}
        <SearchField inputRef={field} value={query} onChange={(v) => { setQuery(v); if (v.trim()) setCategory(null); }} />
        <Categories categories={meta.categories} value={category} onPick={(id) => { setCategory(id); setQuery(''); setQ(''); }} />
      </div>
      <div className={LIST}>
        <Trouble />
        <ScrollRoot.Provider value={scroller}>{scroller ? body : null}</ScrollRoot.Provider>
      </div>
    </div>
  );
}

/**
 * The accounts of an app that has several (two Gmails): who each is, the one the bots use when they aren't told
 * which, and each one's own menu. They line up under the app's name.
 */
function Accounts({ toolkit: t, conns }: { toolkit: AppToolkit; conns: AppConnection[] }) {
  return (
    <ul aria-label={`${t.name} accounts`} className="mt-0.5 ml-[52px] flex flex-col">
      {conns.map((c, i) => {
        const name = accountName(c, i);
        const working = c.status === 'ACTIVE';
        return (
          <li key={c.connectedAccountId} className="flex h-7 min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-copy text-fg-2" title={name}>{name}</span>
            {c.isDefault ? (
              <Tooltip label="Your bots use this account unless they are told to use another"><span className="flex shrink-0"><Badge>Default</Badge></span></Tooltip>
            ) : working ? null : <span className="shrink-0 text-ui text-warning">Signed out</span>}
            <span className="flex-1" />
            <Menu
              className="min-w-[170px]"
              items={[
                ...(working && !c.isDefault ? [{ label: 'Make default', icon: Check, onSelect: () => void makeDefault(t, c) }] : []),
                { label: 'Remove', icon: Trash2, danger: true, onSelect: () => removeAccount(t, c, name) },
              ]}
              trigger={(p) => <Button {...p} size="icon-xs" variant="ghost" icon={MoreHorizontal} aria-label={`More for ${name}`} className="-mr-1.5" />}
            />
          </li>
        );
      })}
    </ul>
  );
}

/** A connected app: the bots that may use it under its name, and its connection (Connected / Reconnect) on the right. */
function ConnectedRow({ toolkit: t, conns }: { toolkit: AppToolkit; conns: AppConnection[] }) {
  const active = conns.some((c) => c.status === 'ACTIVE');
  return (
    // a row with accounts is taller than its neighbour: each starts at the top of its cell
    <div className="min-w-0 self-start py-2">
      <div className="flex min-w-0 items-center gap-3">
        <AppLogo toolkit={t} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-copy leading-5 font-medium text-fg">{t.name}</div>
          {/* signed out, no bot has it: the switches come back with the connection */}
          {active ? <BotAccess toolkit={t} /> : <div className="truncate text-copy leading-[22px] text-warning">Signed out</div>}
        </div>
        <AppAction toolkit={t} conns={conns} listed />
      </div>
      {conns.length > 1 ? <Accounts toolkit={t} conns={conns} /> : null}
    </div>
  );
}

/** The apps already connected, with the way back to the directory. */
function Connected() {
  const bySlug = useConnectionsBySlug();
  const connected = useConnectedApps();
  const connsError = useAppsUi((s) => s.connectionsError);
  const [all, setAll] = useState(false);
  const back = useRef<HTMLButtonElement>(null);
  // the header's link that led here is gone: the keyboard carries on from the way back
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, []);
  const total = connected.slugs.length;
  const shown = all ? total : Math.min(total, CONNECTED_SHOWN);
  return (
    <div className={SCROLLER}>
      <div className={cn(TOP, 'pt-1 pb-3')}>
        <button ref={back} type="button" onClick={() => ui.openApps('browse')} className={BACK}>
          <Icon icon={ChevronLeft} size={15} />All apps
        </button>
      </div>
      <div className={LIST}>
        <Trouble />
        {connsError ? <Problem text={`Couldn't load your connections: ${connsError}`} onRetry={() => void loadConnections()} /> : null}
        <Section title="Connected" hint="Each app is connected once, for all your bots. Choose which bots use it.">
          <div className={COLUMNS}>
            {connected.loading
              ? Array.from({ length: shown }, (_, i) => <AppRowSkeleton key={i} />)
              : connected.toolkits.slice(0, shown).map((t) => <ConnectedRow key={t.slug} toolkit={t} conns={bySlug.get(t.slug) ?? NO_CONNS} />)}
          </div>
          {shown < total ? <button type="button" onClick={() => setAll(true)} className="no-drag mt-2 text-copy text-muted transition-colors hover:text-fg">Show all {total} apps</button> : null}
        </Section>
      </div>
    </div>
  );
}

/** Whether the dialog is on its connected view: asked for, and something is connected (or may still turn out to be). */
function useConnectedView(): boolean {
  const asked = useStore((s) => s.appsView === 'connected');
  const lists = useStore((s) => !!s.apps?.configured || !!s.apps?.direct);
  const conns = useAppsUi((s) => s.connections);
  return asked && (conns ? conns.length > 0 : lists);
}

/** The header's way to the connected apps: a few of their logos and how many there are. */
function ConnectedLink() {
  const conns = useAppsUi((s) => s.connections);
  const { toolkits } = useConnectedApps();
  const here = useConnectedView();
  if (here || !conns?.length) return null;
  const working = activeSlugs(conns);
  return (
    <button
      type="button"
      onClick={() => ui.openApps('connected')}
      className="no-drag ab-pill squircle -mt-0.5 inline-flex h-7 shrink-0 items-center gap-2 rounded-control-sm pr-1.5 pl-2 text-ui text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--ab-fg)_35%,transparent)]"
    >
      {/* the logos of the apps it counts: a signed-out one shows only when nothing else is connected */}
      <AppLogoStack toolkits={working.length ? toolkits.filter((t) => working.includes(t.slug)) : toolkits} ring="var(--ab-content)" />
      <span className="tabular-nums">{working.length ? `${working.length} connected` : 'Signed out'}</span>
      <Icon icon={ChevronRight} size={14} />
    </button>
  );
}

function Body() {
  const apps = useStore((s) => s.apps);
  const connected = useConnectedView();
  useAppsLive();
  // another account has other connections: the directory is asked for again
  const account = useRef(apps?.account);
  useEffect(() => {
    if (account.current === apps?.account) return;
    account.current = apps?.account;
    clearCatalogCache();
  }, [apps?.account]);

  if (!apps) return <div className="flex flex-1 items-center justify-center text-muted"><Spinner size={18} /></div>;
  return connected ? <Connected /> : <Browse />;
}

/** The Connect apps popup, opened from the sidebar, a bot's panel, Settings and the command palette (`ui.openApps`). */
export function AppsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connect apps"
      headerAction={<ConnectedLink />}
      className="h-[min(720px,calc(100vh-48px))] w-[min(880px,calc(100vw-48px))]"
      bodyClassName="flex flex-col overflow-hidden p-0"
    >
      <Body />
    </Dialog>
  );
}
