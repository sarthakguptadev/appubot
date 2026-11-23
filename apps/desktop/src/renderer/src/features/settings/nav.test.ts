import { describe, expect, it } from 'vitest';
import { SETTINGS_NAV_GROUPS, SETTINGS_NAV_ITEMS, SETTINGS_PAGES, SETTINGS_SEARCH_ENTRIES, rankSettingsSearch, settingAnchorId, settingsNavItem, settingsTrail } from './nav';

describe('settings nav', () => {
  it('puts every section in a known group', () => {
    const groups = new Set(SETTINGS_NAV_GROUPS.map((g) => g.id));
    expect(SETTINGS_NAV_ITEMS.every((s) => groups.has(s.group))).toBe(true);
    expect(new Set(SETTINGS_NAV_ITEMS.map((s) => s.id)).size).toBe(SETTINGS_NAV_ITEMS.length);
  });

  it('is short: fifteen rows at most, every page in exactly one of them', () => {
    expect(SETTINGS_NAV_ITEMS.length).toBeLessThanOrEqual(15);
    const held = SETTINGS_NAV_ITEMS.flatMap((s) => s.pages);
    expect(new Set(held).size).toBe(held.length);
    for (const p of SETTINGS_PAGES) if (p.id !== 'computer' || held.includes('computer')) expect(held, p.id).toContain(p.id);
  });

  it('keeps every old page id working as a tab of its row', () => {
    expect(settingsNavItem('usage').id).toBe('providers');
    expect(settingsNavItem('vault').id).toBe('apps');
    expect(settingsNavItem('appearance').id).toBe('appearance');
    expect(settingsNavItem('storage').id).toBe('storage');
    expect(settingsNavItem('whats-new').id).toBe('about');
    expect(settingsTrail('usage')).toBe('Agents › Usage');
    expect(settingsTrail('billing')).toBe('Billing');
    // every search entry lands on a page some row holds
    for (const e of SETTINGS_SEARCH_ENTRIES) expect(settingsNavItem(e.section).pages, e.title).toContain(e.section);
  });

  it('slugs titles into stable anchors', () => {
    expect(settingAnchorId("Show the bot's cursor")).toBe('setting-show-the-bot-s-cursor');
    expect(settingAnchorId('macOS permissions')).toBe('setting-macos-permissions');
    expect(new Set(SETTINGS_SEARCH_ENTRIES.map((e) => settingAnchorId(e.title))).size).toBe(SETTINGS_SEARCH_ENTRIES.length);
  });
});

describe('rankSettingsSearch', () => {
  it('returns nothing for a blank query', () => {
    expect(rankSettingsSearch('  ', 10)).toEqual([]);
  });

  it('ranks title prefixes over word matches over keywords', () => {
    expect(rankSettingsSearch('color', 10).map((e) => e.title)[0]).toBe('Color scheme');
    // a keyword still finds it
    expect(rankSettingsSearch('theme', 10).map((e) => e.title)).toContain('Color scheme');
    expect(rankSettingsSearch('notif', 10).map((e) => e.title)).toEqual(['Desktop notifications', 'Phone notifications', 'Permissions']);
    expect(rankSettingsSearch('botfather', 10).map((e) => e.title)).toEqual(['Bot token']);
    expect(rankSettingsSearch('tailnet', 10).map((e) => e.title)).toEqual(['Tailscale']);
  });

  it('falls back to the section name and honours the limit', () => {
    expect(rankSettingsSearch('telegram', 3).every((e) => e.section === 'channels')).toBe(true);
    expect(rankSettingsSearch('telegram', 3)).toHaveLength(3);
  });
});

describe('the groups', () => {
  it('are named for what is in them, the account first and the app last', () => {
    expect(SETTINGS_NAV_GROUPS.map((g) => [g.id, g.label])).toEqual([['account', 'Account'], ['ai', 'AI'], ['connections', 'Connections'], ['computer', 'Computer'], ['app', 'App']]);
    const group = (id: string) => settingsNavItem(id as never).group;
    expect(['providers', 'usage', 'instructions', 'voice'].map(group)).toEqual(['ai', 'ai', 'ai', 'ai']);
    expect(['apps', 'vault', 'channels', 'devices', 'transfer', 'import'].map(group)).toEqual(Array(6).fill('connections'));
    expect(['general', 'permissions', 'storage'].map(group)).toEqual(Array(3).fill('computer'));
    expect(['appearance', 'about', 'whats-new'].map(group)).toEqual(Array(3).fill('app'));
  });
});

describe('voice settings', () => {
  it('has its own row under AI', () => {
    expect(SETTINGS_NAV_ITEMS.find((s) => s.id === 'voice')?.group).toBe('ai');
  });

  it('finds its rows', () => {
    expect(rankSettingsSearch('whisper', 10).map((e) => e.title)).toEqual(['Speech model', 'Which language?', 'Storage']);
    expect(rankSettingsSearch('hindi', 1)[0]).toMatchObject({ section: 'voice', title: 'Speech model' });
    expect(rankSettingsSearch('kokoro', 1)[0]).toMatchObject({ section: 'voice', title: 'Voice model' });
    expect(rankSettingsSearch('remove', 10).map((e) => e.title)).toContain('Storage');
    expect(rankSettingsSearch('voice', 2).map((e) => [e.section, e.title])).toEqual([['voice', 'Voice model'], ['voice', 'Voice']]);
    expect(rankSettingsSearch('telegram voice', 10).map((e) => e.title)).toEqual(['Answer voice messages with voice']);
    expect(rankSettingsSearch('voice replies', 10).map((e) => e.title)).toEqual(['Answer voice messages with voice']);
  });
});

describe('account, billing and team', () => {
  it('lead the sidebar as You, and Cloud is gone as a tab', () => {
    expect(SETTINGS_NAV_ITEMS.filter((s) => s.group === 'account').map((s) => [s.id, s.label])).toEqual([['account', 'Account'], ['billing', 'Billing'], ['team', 'Team']]);
    expect(SETTINGS_NAV_ITEMS.some((s) => (s.id as string) === 'cloud' || /cloud/i.test(s.label) || /AppuBot Cloud/.test(s.description))).toBe(false);
  });

  it('finds them, "cloud" still a keyword', () => {
    expect(rankSettingsSearch('invoice', 3).map((e) => e.section)).toContain('billing');
    expect(rankSettingsSearch('sign out', 1)[0]?.section).toBe('account');
    expect(rankSettingsSearch('invite', 1)[0]?.section).toBe('team');
    expect(rankSettingsSearch('cloud', 12).map((e) => e.section).filter((x) => x !== 'devices').every((x) => x === 'account' || x === 'billing')).toBe(true);
    expect(rankSettingsSearch('reset', 10).map((e) => [e.section, e.title])).toContainEqual(['account', 'Fix your computer']);
    // "Only in the cloud" / "Cloud and this Mac"
    expect(rankSettingsSearch('where your bots', 1)[0]).toMatchObject({ section: 'account', title: 'Where your bots work' });
    expect(rankSettingsSearch('only in the cloud', 1)[0]?.title).toBe('Where your bots work');
    expect(rankSettingsSearch('laptop', 3).map((e) => e.title)).toContain('Where your bots work');
  });
});
