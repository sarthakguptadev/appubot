import { useT } from '../../lib/i18n';
import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, Search, X } from '../../components/ui/icons';
import { Icon, Kbd, cn, isDialogOpen } from '../../components/ui';
import { useHotkey } from '../../lib/hooks';
import { IS_MAC } from '../../lib/platform';
import { EASE_T3_OUT } from '../../lib/motion';
import { ui, useStore, type SettingsSection } from '../../lib/store';
import { SETTINGS_NAV_ITEMS, rankSettingsSearch, transferTitle, settingAnchorId, settingsNavItem, settingsPage, settingsTrail, type SettingsNavItem, type SettingsSearchEntry } from './nav';
import { AboutSection } from './sections/About';
import { AppearanceSection } from './sections/Appearance';
import { PermissionsSection } from './sections/Permissions';
import { WhatsNewSection } from '../whatsNew/WhatsNew';
import { AppsSection } from './sections/Apps';
import { ChannelsSection } from './sections/Channels';
import { ComputerUseSection } from './sections/ComputerUse';
import { DevicesSection } from './sections/Devices';
import { GeneralSection } from './sections/General';
import { InstructionsSection } from './sections/Instructions';
import { usePermissionsNeeded } from './sections/Permissions';
import { ProvidersSection } from './sections/Providers';
import { VoiceSection } from './sections/Voice';
import { UsageSection } from './sections/Usage';
import { VaultSection } from './sections/Vault';
import { StorageSection } from './sections/Storage';
import { AccountSection } from './sections/Account';
import { BillingSection } from './sections/Billing';
import { TeamSection } from './sections/Team';
import { TransferSection } from './sections/Transfer';
import { ImportSection } from './sections/Import';
import { ComputerMenu } from '../cloud/ComputerMenu';
import { useCloudLink } from '../cloud/cloudClient';
import { useMacName } from '../../lib/macName';
import { useCloudLacks } from '../cloud/useCloudLacks';
import { useCloud } from '../cloud/cloudAccount';

/*
 * Settings is T3 Code's settings window: a large modal over the app (Esc, ✕ or a click outside closes it) with the
 * section nav at its left (search with "/", small group headings, 32px rows) and, beside it, the section's page: its
 * title and one line, then titled cards, all on one left edge; ✕ floats at the top right.
 */

const PAGES: Record<SettingsSection, ComponentType> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  providers: ProvidersSection,
  instructions: InstructionsSection,
  apps: AppsSection,
  devices: DevicesSection,
  computer: ComputerUseSection,
  channels: ChannelsSection,
  voice: VoiceSection,
  usage: UsageSection,
  vault: VaultSection,
  storage: StorageSection,
  about: AboutSection,
  'whats-new': WhatsNewSection,
  permissions: PermissionsSection,
  account: AccountSection,
  billing: BillingSection,
  team: TeamSection,
  transfer: TransferSection,
  import: ImportSection,
};

/*
 * The nav's rows: 36px, 14px, pills in the Round look (`ab-pill`) and squircles in the Squircle one; the chosen one gets a wash and a semibold label, in place (T3 Code's: nothing
 * slides between rows).
 */
const NAV_ROW =
  'ab-pill squircle no-drag relative isolate flex h-9 w-full min-w-0 items-center gap-2.5 rounded-control-sm px-2.5 text-left text-copy select-none outline-none ' +
  'transition-colors duration-150 ease-rare focus-visible:ring-2 focus-visible:ring-[var(--ab-ring)] focus-visible:ring-inset [&>svg]:text-muted';
const NAV_ROW_IDLE = 'text-fg-2 hover:bg-[color-mix(in_srgb,var(--ab-fg)_5%,transparent)] hover:text-fg';
const NAV_ROW_ACTIVE = 'font-semibold tracking-ui text-fg [&>svg]:text-fg';
const NAV_WASH = 'ab-pill squircle absolute inset-0 -z-10 rounded-control-sm bg-[color-mix(in_srgb,var(--ab-fg)_8%,transparent)]';

/** The chosen row's wash. */
function NavWash() {
  return <span aria-hidden className={NAV_WASH} />;
}

// Cap the result list so a broad query stays a quick scan rather than a wall of rows.
const SEARCH_LIMIT = 12;

/** Which pages show here: Voice on a cloud computer only once it reads aloud, no Account/Billing without the account service, Team only on a team. */
function useShownPages(): (id: SettingsSection) => boolean {
  // the cloud computer hears nothing, but one that reads aloud (`VoiceStatus.speaks`) has its voice to pick; Permissions
  // stays there too, as this Mac's notifications alone (it is this Mac that shows them: sections/Permissions.tsx)
  const lacks = useCloudLacks();
  const speaks = useStore((s) => !!s.voice?.speaks);
  // Account and Billing need this Mac's AppuBot account service; Team shows only to people on a team
  const accountOff = useCloud((s) => s.supported === false);
  const onTeam = useCloud((s) => !!s.view?.signedIn && !!s.view.teams?.length);
  // Transfer brings bots from this Mac to the AppuBot computer on screen: only there (one way)
  const onCloud = useCloudLink((s) => s.computer === 'cloud');
  return (id) => !(id === 'voice' && lacks.voice && !speaks)
    && !((id === 'account' || id === 'billing') && accountOff) && !(id === 'team' && !onTeam) && !(id === 'transfer' && !onCloud);
}

/** A row as it shows: its visible pages, named after the first of them when its own page is hidden (Permissions alone on a cloud computer → nothing). */
function shownRow(item: SettingsNavItem, shown: (id: SettingsSection) => boolean): { item: SettingsNavItem; pages: SettingsSection[] } | null {
  const pages = item.pages.filter(shown);
  if (!pages.length) return null;
  if (pages[0] === item.pages[0]) return { item, pages };
  const first = settingsPage(pages[0]!);
  return { item: { ...item, id: first.id, label: first.label, icon: first.icon, description: first.description }, pages };
}

/** The left column: Back and the search button on top, the computer switcher, then the pages (or, searching, the results). */
function SettingsNav() {
  const t = useT();
  const active = useStore((s) => s.settingsSection) ?? 'general';
  // its row carries a dot while a permission is missing
  const permissionsNeeded = usePermissionsNeeded();
  const shown = useShownPages();
  const [query, setQuery] = useState('');
  const [pick, setPick] = useState(0);
  // the search field is out of sight until asked for: the strip's search button, or "/" (the owner's call 2026-11-14)
  const [searchOpen, setSearchOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const results = rankSettingsSearch(query, SEARCH_LIMIT * 2).filter((e) => shown(e.section)).slice(0, SEARCH_LIMIT);
  const searching = query.trim().length > 0;

  // "/" searches, as in T3 Code
  useHotkey((e) => e.key === '/' && !isDialogOpen() && !(document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement), () => setSearchOpen(true));
  // the field takes the keyboard as it appears
  useEffect(() => { if (searchOpen) input.current?.focus(); }, [searchOpen]);
  const closeSearch = () => { setQuery(''); setSearchOpen(false); };

  const select = (e: SettingsSearchEntry) => {
    ui.openSettings(e.section, settingAnchorId(e.title));
    closeSearch();
  };
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && results.length) { e.preventDefault(); setPick((i) => (i + 1) % results.length); }
    else if (e.key === 'ArrowUp' && results.length) { e.preventDefault(); setPick((i) => (i - 1 + results.length) % results.length); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[pick] ?? results[0];
      if (r) select(r);
    } else if (e.key === 'Escape' && query) {
      // clear the query first; later Escapes let go of the field, then close settings
      e.preventDefault();
      e.stopPropagation();
      setQuery('');
    }
  };

  // one flat list, no headings (the owner's call 2026-11-14, "rm grouping in settings"); the rows keep the order
  // nav.ts lists them in: account, AI, connections, the computer, the app
  const rows = (
    <ul className="mt-1 flex flex-col gap-0.5">
      {SETTINGS_NAV_ITEMS.map((r) => shownRow(r, shown)).filter((r) => r !== null).map(({ item: r, pages }) => {
        const on = pages.includes(active);
        return (
          <li key={r.id}>
            <button
              type="button"
              aria-current={on ? 'page' : undefined}
              className={cn(NAV_ROW, on ? NAV_ROW_ACTIVE : NAV_ROW_IDLE)}
              onClick={() => ui.openSettings(r.id)}
            >
              {on ? <NavWash /> : null}
              <Icon icon={r.icon} size={16} className="shrink-0" />
              <span className="truncate">{r.label}</span>
              {pages.includes('permissions') && permissionsNeeded ? <span aria-label={t('settings.needsAttention')} className="ml-auto size-1.5 shrink-0 rounded-full bg-attention" /> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <nav aria-label={t('settings.nav.aria')} className="flex w-[272px] shrink-0 flex-col border-e border-[var(--ab-hairline)] bg-[var(--ab-settings-nav)]">
      {/* the top strip, as tall as the chat's header: only the search button, at its right (the Back that sat right of
          the Mac's traffic lights went on 2026-11-17: "Back to app" at the nav's foot and Esc are the ways out). The
          strip itself drags the window, like the sidebar's; nothing may lie over it */}
      <div className={cn('drag flex h-16 shrink-0 items-center', IS_MAC ? 'pl-[92px]' : 'pl-2.5')}>
        <span className="min-w-0 flex-1" />
        <button
          type="button"
          aria-label={t('settings.search.aria')}
          aria-pressed={searchOpen}
          title={`${t('common.search')} /`}
          // mousedown would blur the field first (closing it), and the click would open it again
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          className={cn(
            'ab-press ab-pill squircle no-drag mr-2.5 grid size-9 shrink-0 place-items-center rounded-control text-fg-2 outline-none hover:bg-surface-3 hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]',
            searchOpen ? 'bg-surface-3 text-fg' : 'bg-surface-2',
          )}
        >
          <Icon icon={Search} size={15} />
        </button>
      </div>
      <div className="no-drag min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-2.5">
        {/* whose settings these are: this Mac, the person's cloud computer or a team's (nothing where there is only this one) */}
        <div className="pb-2 empty:hidden"><ComputerMenu inSettings /></div>
        {searchOpen || searching ? (
        <label className="ab-pill squircle flex h-9 items-center gap-2.5 rounded-control-sm bg-surface-2 px-2.5 text-copy font-medium text-muted hover:bg-surface-3 focus-within:shadow-[0_0_0_2px_var(--ab-ring)]">
          <Icon icon={Search} size={16} className="shrink-0 text-muted/80" />
          <input
            ref={input}
            type="search"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPick(0); }}
            onKeyDown={onSearchKey}
            // left empty, it goes away again
            onBlur={() => { if (!query.trim()) setSearchOpen(false); }}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            placeholder={t('common.search')}
            aria-label={t('settings.search.aria')}
            className="min-w-0 flex-1 bg-transparent text-copy font-normal text-fg outline-none placeholder:font-medium placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
          />
          {searching ? (
            <button type="button" aria-label={t('settings.search.clear')} onMouseDown={(e) => e.preventDefault()} onClick={() => { setQuery(''); input.current?.focus(); }} className="ab-pill flex size-5 shrink-0 items-center justify-center rounded text-muted hover:text-fg">
              <Icon icon={X} size={12} />
            </button>
          ) : <Kbd>/</Kbd>}
        </label>
        ) : null}

        {searching ? (
          results.length ? (
            <ul aria-label={t('settings.search.results')} className="mt-2 flex flex-col gap-0.5">
              {results.map((e, i) => {
                const section = settingsNavItem(e.section);
                const trail = settingsTrail(e.section);
                return (
                  <li key={`${e.section}:${e.title}`}>
                    <button
                      type="button"
                      className={cn(NAV_ROW, 'h-auto min-h-10 items-start py-1.5', i === pick ? 'bg-[color-mix(in_srgb,var(--ab-fg)_8%,transparent)] text-fg' : NAV_ROW_IDLE)}
                      onMouseMove={() => setPick(i)}
                      onClick={() => select(e)}
                    >
                      <Icon icon={section.icon} size={16} className="mt-0.5 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-copy font-medium text-fg">{e.title}</span>
                        <span className="block truncate text-[11px] text-muted/75">{trail}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p role="status" className="px-2 py-6 text-center text-note text-muted">{t('settings.search.none')}</p>
          )
        ) : (
          rows
        )}
      </div>
      {/* a second way out where the eye ends up after the list: the bottom-left corner (the top's Back stays) */}
      <div className="shrink-0 px-2.5 pt-1 pb-2.5">
        <button
          type="button"
          onClick={ui.closeSettings}
          className="ab-press ab-pill squircle no-drag flex h-9 w-full items-center gap-2 rounded-control px-2.5 text-ui font-medium tracking-ui text-muted outline-none hover:bg-[color-mix(in_srgb,var(--ab-fg)_6%,transparent)] hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]"
        >
          <Icon icon={ChevronLeft} size={15} className="shrink-0" />
          {t('settings.backToApp')}
        </button>
      </div>
    </nav>
  );
}

/** The section's page: its title and line with ✕ at the top right, then its settings scrolling below them. */
function SettingsContent() {
  const t = useT();
  const section = useStore((s) => s.settingsSection) ?? 'general';
  const target = useStore((s) => s.settingsTarget);
  const shown = useShownPages();
  const onCloud = useCloudLink((c) => c.computer === 'cloud');
  const permissionsNeeded = usePermissionsNeeded();
  const nav = shownRow(settingsNavItem(section), shown);
  const page = settingsPage(section);
  const tabs = nav && nav.pages.length > 1 ? nav.pages : [];
  const Page = PAGES[section];
  const scroller = useRef<HTMLDivElement>(null);
  const macName = useMacName();
  // a row of several pages shows the open tab's own title over its line (Usage over "How much of your plans is left",
  // not Agents), so the title and the line always speak of the same page
  const title = section === 'transfer' ? transferTitle(macName) : tabs.length ? page.label : (nav?.item.label ?? page.label);

  // each section starts at the top
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 0; }, [section]);
  // search results scroll their row into view once the section has rendered
  useEffect(() => {
    if (!target) return;
    const frame = requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    return () => cancelAnimationFrame(frame);
  }, [section, target]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* a header row above the scroller, so ✕ never sits on the scrollbar or a card: the page's title and line on the
          content's left edge (the same gutter as the scroller below, so they line up), ✕ level with the title */}
      <div className="relative mr-1.5 shrink-0 overflow-hidden [scrollbar-gutter:stable]">
        {/* the page's empty top edge drags the window too (its title starts below it) */}
        <div aria-hidden className="drag h-6" />
        <header className="mx-auto flex w-full max-w-4xl flex-col gap-1 px-6 pb-4">
          <h1 className="text-heading leading-7 font-semibold tracking-[-0.02em] text-fg">{title}</h1>
          {/* a cloud computer has no lid, sleep or startup to speak of */}
          <p className="text-copy leading-normal text-muted">{section === 'general' && onCloud ? t('settings.page.general.desc.cloud') : page.description}</p>
          {/* a row holding several pages: one tab each (Agents | Usage, About | What’s new | Storage) */}
          {tabs.length ? (
            <div role="tablist" aria-label={nav?.item.label} className="mt-3 flex gap-1 border-b border-[var(--ab-hairline)]">
              {tabs.map((id) => {
                const on = id === section;
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => ui.openSettings(id)}
                    className={cn(
                      'relative -mb-px flex h-9 items-center gap-1.5 px-2.5 text-copy font-semibold tracking-ui transition-colors duration-150 ease-rare outline-none focus-visible:ring-2 focus-visible:ring-[var(--ab-ring)] focus-visible:ring-inset',
                      on ? 'text-fg' : 'text-muted hover:text-fg',
                    )}
                  >
                    {/* the open tab's line */}
                    {on ? <span aria-hidden className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-fg" /> : null}
                    {settingsPage(id).label}
                    {id === 'permissions' && permissionsNeeded ? <span aria-label={t('settings.needsAttention')} className="size-1.5 rounded-full bg-attention" /> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </header>
      </div>
      {/* inset from the window's bottom edge and rounded corners: the scrollbar floats inside, like the chat's */}
      <div ref={scroller} tabIndex={-1} className="mr-1.5 mb-3 min-h-0 flex-1 overflow-y-auto outline-none [scrollbar-gutter:stable]">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 pt-4 pb-9">
          <Page key={section} />
        </div>
      </div>
    </div>
  );
}

/**
 * Settings fills the window (the owner's call 2026-11-14; before, T3 Code's large dialog over a dimmed app): its nav
 * down the left (Back at its top, right of the Mac's traffic lights) and the page beside it. Back or Escape closes it.
 */
export function SettingsModal() {
  const open = useStore((s) => s.settingsSection !== null);
  const popup = useRef<HTMLDivElement>(null);

  // Escape closes, unless a dialog or menu owns it; inside a field it only lets go of the field
  useHotkey((e) => e.key === 'Escape' && !isDialogOpen(), () => {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) el.blur();
    else ui.closeSettings();
  }, open);
  // focus the window, not its first control: arrows and page keys scroll it, no stray focus ring
  useEffect(() => { if (open) popup.current?.focus({ preventScroll: true }); }, [open]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="settings"
          ref={popup}
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          tabIndex={-1}
          className="fixed inset-0 z-40 flex min-h-0 min-w-0 overflow-hidden bg-[var(--ab-content)] text-fg outline-none"
          initial={{ opacity: 0, scale: 0.985 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.985 }} transition={{ duration: 0.15, ease: EASE_T3_OUT }}
        >
          <SettingsNav />
          <SettingsContent />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
