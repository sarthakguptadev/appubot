import { useT } from '../../lib/i18n';
import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent, type RefObject } from 'react';
import { X } from '../../components/ui/icons';
import { SettingsSearch, SettingsX } from './settingsIcons';
import './settings.css';
import { Button, Icon, Kbd, MODAL_BACKDROP, MODAL_SURFACE, cn, isDialogOpen } from '../../components/ui';
import { useHotkey } from '../../lib/hooks';
import { ui, useStore, type SettingsSection } from '../../lib/store';
import { SETTINGS_NAV_ITEMS, transferTitle, settingsNavItem, settingsPage, type SettingsNavItem } from './nav';
import { searchSettings, settingRows, type SettingRow } from './settingsSearch';
import { Marked, PALETTE_ROW, PALETTE_ROW_ON, PaletteFooter } from '../../components/layout/PaletteRow';
import { shortcut } from '../../lib/platform';

type SettingResult = ReturnType<typeof searchSettings<SettingRow>>[number];
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
 * Settings is a centred overlay over the dimmed app, about 898×700, drawn as Grok Bot's Settings is (the owner's call
 * 2026-11-27, measured from his screenshot: settings.css holds its colours): Esc, ✕ or a click outside closes it, and
 * it opens and closes in one frame. A 197px nav down its left (search with "/", 32px rows, 15px labels, Lucide's
 * icons) and the section's page beside it: a 20px title, then small grey labels over rounded cards of 48px rows; ✕ at
 * the top right.
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
 * The nav's rows, Grok Bot's: 32px, 2px apart, a 16px icon and a 15px label in the text colour, 10px corners; a light
 * fill under the pointer, and the chosen or pressed one the darker fill, in place.
 */
const NAV_ROW =
  'no-drag relative flex h-8 w-full min-w-0 items-center gap-2 rounded-[10px] px-[9px] text-left text-[15px] leading-5 text-fg select-none outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-[var(--ab-ring)] focus-visible:ring-inset';
const NAV_ROW_IDLE = 'hover:bg-[var(--st-hover)] active:bg-[var(--st-selected)]';
const NAV_ROW_ACTIVE = 'bg-[var(--st-selected)]';

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

/** The left column: the search field on top, the computer switcher, then the pages. */
function SettingsNav({ query, setQuery, input, onSearchKey }: {
  query: string; setQuery: (q: string) => void;
  input: RefObject<HTMLInputElement | null>;
  onSearchKey: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const t = useT();
  const active = useStore((s) => s.settingsSection) ?? 'general';
  // its row carries a dot while a permission is missing
  const permissionsNeeded = usePermissionsNeeded();
  const shown = useShownPages();
  const searching = query.trim().length > 0;

  // one flat list, no headings (the owner's call 2026-11-14, "rm grouping in settings"); the rows keep the order
  // nav.ts lists them in: account, AI, connections, the computer, the app
  const rows = (
    <ul className="flex flex-col gap-0.5">
      {SETTINGS_NAV_ITEMS.map((r) => shownRow(r, shown)).filter((r) => r !== null).map(({ item: r, pages }) => {
        const on = !searching && pages.includes(active);
        return (
          <li key={r.id}>
            <button
              type="button"
              aria-current={on ? 'page' : undefined}
              className={cn(NAV_ROW, on ? NAV_ROW_ACTIVE : NAV_ROW_IDLE)}
              onClick={() => { setQuery(''); ui.openSettings(r.id); }}
            >
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
    <nav aria-label={t('settings.nav.aria')} className="flex w-[197px] shrink-0 flex-col border-e border-[var(--st-divider)]">
      {/* the top: the search field, always there (the owner's call 2026-11-27: "like command K but for it"), a nav
          row's size and shape with a hairline round it */}
      <div className="shrink-0 px-3 pt-[17px] pb-2">
        <label className="no-drag flex h-8 w-full items-center gap-2 rounded-[10px] px-[9px] text-[15px] text-muted shadow-[inset_0_0_0_1px_var(--st-field-edge)] hover:bg-[var(--st-hover)] focus-within:bg-[var(--st-hover)]">
          <Icon icon={SettingsSearch} size={16} className="shrink-0" />
          <input
            ref={input}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            placeholder={t('common.search')}
            aria-label={t('settings.search.aria')}
            role="combobox"
            aria-expanded={searching}
            aria-controls={RESULTS_ID}
            aria-autocomplete="list"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
          />
          {searching ? (
            <button type="button" aria-label={t('settings.search.clear')} onMouseDown={(e) => e.preventDefault()} onClick={() => { setQuery(''); input.current?.focus(); }} className="ab-pill flex size-5 shrink-0 items-center justify-center rounded text-muted hover:text-fg">
              <Icon icon={X} size={12} />
            </button>
          ) : <Kbd>{shortcut('F')}</Kbd>}
        </label>
      </div>
      <div className="no-drag min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 pb-3">
        {/* whose settings these are: this Mac, the person's cloud computer or a team's (nothing where there is only this one) */}
        <div className="pb-2 empty:hidden"><ComputerMenu inSettings /></div>
        {rows}
      </div>
    </nav>
  );
}

const RESULTS_ID = 'settings-search-results';

/**
 * Settings' search, the ⌘K palette's list over every setting on every page (features/settings/settingsSearch.ts):
 * each row its page's icon, its name with the matched words in semibold and where it is, the highlight moved by the
 * arrows and the pointer; Enter or a click opens it (SettingsModal `pick`).
 */
function SettingsResults({ results, at, setAt, onPick }: {
  results: SettingResult[]; at: number; setAt: (i: number) => void; onPick: (r: SettingResult) => void;
}) {
  const t = useT();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.scrollIntoView({ block: 'nearest' }); }, [at]);
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col pt-14">
      <div ref={list} id={RESULTS_ID} role="listbox" aria-label={t('settings.search.results')} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-2">
        {results.map((r, i) => (
          <button
            key={r.key}
            type="button"
            id={`${RESULTS_ID}-${i}`}
            role="option"
            aria-selected={i === at}
            tabIndex={-1}
            data-index={i}
            onMouseMove={() => { if (i !== at) setAt(i); }}
            // the field keeps the focus (and its caret)
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(r)}
            className={cn(PALETTE_ROW, 'rounded-control-lg', i === at && PALETTE_ROW_ON)}
          >
            <span className="flex size-5 shrink-0 items-center justify-center text-fg-2"><Icon icon={r.icon} size={16} /></span>
            <span className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="max-w-[65%] shrink-0 truncate text-copy text-fg"><Marked text={r.label} ranges={r.ranges} /></span>
              {r.trail ? <span className="min-w-0 truncate text-note text-muted">{r.trail}</span> : null}
            </span>
          </button>
        ))}
        {!results.length ? <p role="status" className="px-3 py-10 text-center text-copy text-muted">{t('settings.search.none')}</p> : null}
      </div>
      <PaletteFooter verb={results.length ? 'Open' : undefined} escKeys={['esc']} escLabel="Clear" />
    </div>
  );
}

/** The section's page: its title and line (✕ sits at the overlay's top right), then its settings scrolling below them. */
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
  // search results scroll their row into view once the section has rendered, and it lights up for a moment
  useEffect(() => {
    if (!target) return;
    const frame = requestAnimationFrame(() => {
      const el = document.getElementById(target);
      if (!el) return;
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      el.classList.remove('settings-found');
      void el.offsetWidth;
      el.classList.add('settings-found');
      el.addEventListener('animationend', () => el.classList.remove('settings-found'), { once: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [section, target]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* a header row above the scroller, so ✕ never sits on the scrollbar or a card: the page's title and line on the
          content's left edge (the same gutter as the scroller below, so they line up), ✕ level with the title */}
      <div className="relative mr-1.5 shrink-0 overflow-hidden pt-8 [scrollbar-gutter:stable]">
        <header className="mx-auto flex w-full max-w-4xl flex-col pr-14 pl-[45px]">
          {/* the title alone, as Grok Bot's pages have it (each page's line stays its tooltip and the search's) */}
          <h1 title={section === 'general' && onCloud ? t('settings.page.general.desc.cloud') : page.description} className="text-[20px] leading-6 font-medium text-fg">{title}</h1>
          {/* a row holding several pages: one tab each (Agents | Usage, About | What’s new | Storage) */}
          {tabs.length ? (
            <div role="tablist" aria-label={nav?.item.label} className="mt-4 -ml-2.5 flex gap-1 border-b border-[var(--st-divider)]">
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
                      'relative -mb-px flex h-9 items-center gap-1.5 px-2.5 text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ab-ring)] focus-visible:ring-inset',
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
        <div className="settings-page mx-auto flex w-full max-w-4xl flex-col gap-7 pt-[27px] pr-4 pb-9 pl-8">
          <Page key={section} />
        </div>
      </div>
    </div>
  );
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Settings over the dimmed app (the owner's call 2026-11-27, after Grok Bot's; from 2026-11-14 it filled the window):
 * an ≈898×700 panel, smaller windows keep a 24px margin. It opens and closes in one frame. Escape (once a field has
 * let go), ✕ or a click on the dimmed app closes it, and Tab stays inside it.
 */
export function SettingsModal() {
  const t = useT();
  const open = useStore((s) => s.settingsSection !== null);
  const popup = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const shown = useShownPages();
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const results = searchSettings(settingRows().filter((r) => shown(r.section)), query);
  const searching = query.trim().length > 0;
  const current = results[Math.min(at, results.length - 1)];
  useEffect(() => { setAt(0); }, [query]);

  // Escape closes, unless a dialog or menu owns it; inside a field it only lets go of the field (the search field's
  // own Escape clears it, then closes: `onSearchKey`)
  useHotkey((e) => e.key === 'Escape' && !isDialogOpen(), () => {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) el.blur();
    else ui.closeSettings();
  }, open);
  // the search field takes the keyboard as Settings opens, and on ⌘F or "/" (as in T3 Code) while it is open
  useEffect(() => { if (open) input.current?.focus({ preventScroll: true }); else setQuery(''); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const find = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f';
      const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
      if (!(find || (e.key === '/' && !typing)) || isDialogOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const pick = (r: SettingResult) => {
    setQuery('');
    ui.openSettings(r.section, r.anchor);
  };
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && searching) {
      e.preventDefault();
      // round the ends, as the palette's list does
      if (results.length) setAt((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
    } else if (e.key === 'Enter' && searching) {
      e.preventDefault();
      if (current) pick(current);
    } else if (e.key === 'Escape') {
      // a query clears first; an empty field closes Settings
      e.preventDefault();
      e.stopPropagation();
      if (query) setQuery('');
      else ui.closeSettings();
    }
  };

  // Tab goes round the panel's own controls, never to the app behind it
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || e.defaultPrevented || !popup.current) return;
    const items = Array.from(popup.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null && x.tabIndex >= 0);
    if (!items.length) return;
    const first = items[0]!, last = items[items.length - 1]!;
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === popup.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-6">
      <div aria-hidden className={cn('absolute inset-0', MODAL_BACKDROP)} onMouseDown={ui.closeSettings} />
      <div
        ref={popup}
        role="dialog"
        aria-modal="true"
        aria-label={t('common.settings')}
        tabIndex={-1}
        onKeyDown={onKey}
        className={cn(MODAL_SURFACE, 'settings-sheet no-drag relative flex h-[min(700px,calc(100vh-48px))] w-[min(898px,calc(100vw-48px))] min-h-0 min-w-0 overflow-hidden rounded-[16px] outline-none')}
      >
        <SettingsNav query={query} setQuery={setQuery} input={input} onSearchKey={onSearchKey} />
        {searching ? <SettingsResults results={results} at={Math.min(at, Math.max(0, results.length - 1))} setAt={setAt} onPick={pick} /> : <SettingsContent />}
        <Button variant="ghost" size="icon-sm" icon={SettingsX} aria-label={t('common.close')} onClick={ui.closeSettings} className="absolute top-2.5 right-2.5" />
      </div>
    </div>
  );
}
