// Settings' pages and the settings on them as rows a search finds, matched and ranked the way the ⌘K palette ranks
// (components/layout/paletteSearch.ts): the palette's Settings group and Settings' own search use these same rows.
import type { LucideIcon } from '../../components/ui/icons';
import { foldQuery, matchFields, rankGroups, type SearchField, type SearchRange } from '../../components/layout/paletteSearch';
import type { SettingsSection } from '../../lib/store';
import { SETTINGS_PAGES, SETTINGS_SEARCH_ENTRIES, settingAnchorId, settingsNavItem, settingsTrail } from './nav';

export interface SettingRow {
  /** `tab:<page>` or `setting:<page>:<title>` */
  key: string;
  icon: LucideIcon;
  label: string;
  section: SettingsSection;
  /** where it is: its row and tab (`Agents › Usage`); '' for a page that is its own row */
  trail: string;
  /** the setting's place on its page, scrolled to when picked */
  anchor?: string;
  /** what else finds it, weaker than the name */
  find: SearchField[];
}

const keywords = (value: string, weight = 0.6): SearchField => ({ value, weight, keyword: true });

/** Every page (found by its name and line) and every setting on one (by its title, its words and where it is). */
export function settingRows(): SettingRow[] {
  // a setting named as its own page (Permissions) is that page's row, found by its words too
  const pageEntry = (e: (typeof SETTINGS_SEARCH_ENTRIES)[number]) => SETTINGS_PAGES.some((p) => p.id === e.section && p.label === e.title);
  const tabs: SettingRow[] = SETTINGS_PAGES.map((p) => {
    const nav = settingsNavItem(p.id).label;
    const own = SETTINGS_SEARCH_ENTRIES.filter((e) => pageEntry(e) && e.section === p.id && e.keywords).map((e) => keywords(e.keywords!));
    return { key: `tab:${p.id}`, icon: p.icon, label: p.label, section: p.id, trail: nav === p.label ? '' : nav, find: [keywords(p.description, 0.4), ...own] };
  });
  const rows: SettingRow[] = SETTINGS_SEARCH_ENTRIES.filter((e) => !pageEntry(e)).map((e) => ({
    key: `setting:${e.section}:${e.title}`, icon: settingsNavItem(e.section).icon, label: e.title, section: e.section, trail: settingsTrail(e.section),
    anchor: settingAnchorId(e.title), find: [...(e.keywords ? [keywords(e.keywords)] : []), keywords(settingsTrail(e.section), 0.25)],
  }));
  return [...tabs, ...rows];
}

/** The rows a query finds, best first, with the name's matched words (nothing for a blank query). */
export function searchSettings<R extends Pick<SettingRow, 'label' | 'find'>>(rows: readonly R[], query: string): (R & { ranges: SearchRange[] })[] {
  const n = foldQuery(query);
  if (!n) return [];
  return rankGroups([{ group: 'settings', items: rows }], (r, typos) => matchFields(n, [{ value: r.label, weight: 1 }, ...r.find], { typos }))
    .flatMap(({ ranked }) => ranked.map(({ item, match }) => ({ ...item, ranges: match.ranges })));
}
