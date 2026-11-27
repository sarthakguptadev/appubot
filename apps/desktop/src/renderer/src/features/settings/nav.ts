import { AppsAdd, type LucideIcon } from '../../components/ui/icons';
import {
  SettingsBlocks, SettingsCard, SettingsChart, SettingsDevices, SettingsDownload, SettingsDrive, SettingsFileText, SettingsGear, SettingsInfo,
  SettingsMic, SettingsMonitor, SettingsSend, SettingsShield, SettingsSparkles, SettingsSun, SettingsUpload, SettingsUser, SettingsUsers, SettingsVault,
} from './settingsIcons';
import type { SettingsSection } from '../../lib/store';
import { ACP_REGISTRY } from '@appubot/protocol';
import { COMPUTER_USE, IS_MAC } from '../../lib/platform';
import { machineParams, t } from '../../lib/i18n';

/*
 * Settings taxonomy shared by the sidebar nav, the page header and the settings search (Synara's settingsNavigation).
 *
 * Pages (`SETTINGS_PAGES`, one per `SettingsSection`) are what deep links, `ui.openSettings` and the search name; the
 * sidebar (`SETTINGS_NAV_ITEMS`) is shorter: four groups of rows, a row holding one page or a few as tabs along the
 * top of its page (Agents › Usage › Instructions, Apps › Vault, Computer use › Permissions, About › What’s new). Every
 * page id still opens (its row, its tab), so old links and the search keep working.
 *
 * The groups are named for what is in them (the owner's ask 2026-11-14, after You / AppuBot / Bots / This Mac read
 * as arbitrary): Account (the person, the money, the team), AI (what bots think and speak with), Connections (what
 * they reach and what reaches them: apps, Telegram, phones, another computer's bots), Computer (how the computer
 * picked in Settings' switcher behaves) and App (how AppuBot looks and which version it is).
 */

export type SettingsGroupId = 'account' | 'ai' | 'connections' | 'computer' | 'app';

export interface SettingsPage {
  id: SettingsSection;
  /** the page's tab label (and its name in the search) */
  label: string;
  /** the line under the page's title */
  description: string;
  icon: LucideIcon;
}

export interface SettingsNavItem extends SettingsPage {
  group: SettingsGroupId;
  /** the pages it holds, as tabs when more than one shows; the first is the row's own */
  pages: SettingsSection[];
}

/*
 * Labels and descriptions are read in the interface's language as they are used (getters over chat-core `t`), so
 * these constants stay constants while a component that re-renders on a language change sees the new words.
 */
/** a word as a heading: its first letter a capital ("computer" → "Computer", in whatever language) */
const heading = (word: string): string => word.charAt(0).toLocaleUpperCase() + word.slice(1);

export const SETTINGS_NAV_GROUPS: { id: SettingsGroupId; label: string }[] = [
  { id: 'account', get label() { return t('settings.page.account'); } },
  { id: 'ai', get label() { return t('settings.group.ai'); } },
  { id: 'connections', get label() { return t('settings.group.connections'); } },
  { id: 'computer', get label() { return heading(t('machine.computer')); } },
  { id: 'app', get label() { return t('settings.group.app'); } },
];

/**
 * The Computer use tab: allowing it, background mode, the bot's cursor, and while the system still has to allow
 * something, a way to the Permissions tab (where Teach mode's "Set up" goes too).
 */
export const SHOW_COMPUTER_SETTINGS = COMPUTER_USE;

/** Settings › Vault's section: the search finds it by this title. */
export const VAULT_TITLE = 'Saved items';
/** Settings › Apps' own MCP servers */
export const CONNECTORS_TITLE = 'Custom connectors';

/** A page whose label and line are read in the current language (`settings.page.<id>`, `.desc`). */
const page = (id: SettingsSection, icon: LucideIcon): SettingsPage => ({
  id,
  icon,
  get label() { return t(`settings.page.${id}`); },
  get description() { return t(`settings.page.${id}.desc`, machineParams()); },
});

export const SETTINGS_PAGES: SettingsPage[] = [
  page('account', SettingsUser),
  page('billing', SettingsCard),
  page('team', SettingsUsers),
  page('providers', SettingsBlocks),
  page('usage', SettingsChart),
  page('instructions', SettingsFileText),
  page('apps', AppsAdd),
  page('vault', SettingsVault),
  page('voice', SettingsMic),
  page('channels', SettingsSend),
  page('transfer', SettingsUpload),
  page('import', SettingsDownload),
  page('general', SettingsGear),
  page('appearance', SettingsSun),
  page('computer', SettingsMonitor),
  page('permissions', SettingsShield),
  page('devices', SettingsDevices),
  page('about', SettingsInfo),
  page('whats-new', SettingsSparkles),
  page('storage', SettingsDrive),
];

export function settingsPage(id: SettingsSection): SettingsPage {
  return SETTINGS_PAGES.find((s) => s.id === id) ?? SETTINGS_PAGES[0]!;
}

const row = (group: SettingsGroupId, pages: SettingsSection[], label?: string): SettingsNavItem => {
  const first = settingsPage(pages[0]!);
  return {
    id: first.id,
    icon: first.icon,
    get label() { return label ?? first.label; },
    get description() { return first.description; },
    group,
    pages,
  };
};

export const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  // the account, the money and the team first: where people look for them (Team only while on one: SettingsView)
  row('account', ['account']),
  row('account', ['billing']),
  row('account', ['team']),
  // what bots think and speak with: Agents › Usage › Instructions (the instructions every bot gets, beside the agents)
  row('ai', ['providers', 'usage', 'instructions']),
  row('ai', ['voice']),
  // what bots reach and what reaches them
  row('connections', ['apps', 'vault']),
  row('connections', ['channels']),
  row('connections', ['devices']),
  // only while an AppuBot computer is on screen (SettingsView): one way, from this Mac to it
  row('connections', ['transfer']),
  // bots from another assistant (Grok Bot, dots, Muse…): a prompt to send it, then the file it answers with
  row('connections', ['import']),
  // how the computer behaves; where computer use doesn't exist, the row is Permissions alone
  row('computer', ['general']),
  ...(SHOW_COMPUTER_SETTINGS ? [row('computer', ['computer', 'permissions'])] : [row('computer', ['permissions'])]),
  row('computer', ['storage']),
  // the app itself
  row('app', ['appearance']),
  row('app', ['about', 'whats-new']),
];

/** The sidebar row a page sits in (its own, or the one it is a tab of). */
export function settingsNavItem(id: SettingsSection): SettingsNavItem {
  return SETTINGS_NAV_ITEMS.find((s) => s.pages.includes(id)) ?? SETTINGS_NAV_ITEMS.find((s) => s.id === 'general')!;
}

/** where a page is, for the search's second line: "Agents › Usage", or the row alone ("Billing") */
export function settingsTrail(id: SettingsSection): string {
  const nav = settingsNavItem(id);
  const page = settingsPage(id);
  return nav.label === page.label ? nav.label : `${nav.label} › ${page.label}`;
}

/** Stable DOM id for a setting row or group, so search results can scroll to it. */
export function settingAnchorId(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  // a title in another script slugs to little or nothing: a short hash of the whole title keeps anchors apart
  const latin = title.replace(/[^\x20-\x7e]/g, '').length;
  if (slug.length >= 3 && latin * 2 >= title.length) return `setting-${slug}`;
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return `setting-${slug ? `${slug}-` : ''}${h.toString(36)}`;
}

/** titles that name the machine ("Keep this PC awake"), shared with the rows they find; in the current language */
export const keepAwakeTitle = (): string => t('general.keepAwake', machineParams());
export const openAtLoginTitle = (): string => t('general.openAtLogin');
export const WHATS_NEW_TITLE = 'What’s new';
/** Settings › Apps' last row (what was Sign out of the apps account) */
export const DISCONNECT_APPS_TITLE = 'Disconnect all apps';
/** Settings › Appearance's rows */
export const colorSchemeTitle = (): string => t('appearance.colorScheme');
export const backgroundTitle = (): string => t('appearance.background');
export const glassOpacityTitle = (): string => t('appearance.glassOpacity');
export const mathTitle = (): string => t('appearance.math');
export const sendShortcutTitle = (): string => t('appearance.sendShortcut');
export const clockTitle = (): string => t('appearance.clock');
export const animatedBackgroundTitle = (): string => t('appearance.animatedBackground');
export const tooltipsTitle = (): string => t('appearance.tooltips');
export const shapeTitle = (): string => t('appearance.shape');
/** "Chat shows": the bot's replies alone, or its work too (Appearance › Chats; the words General's hidden row had) */
export const chatShowsTitle = (): string => t('general.chatShows');
/** Settings › About's links: the support chat, the site, X, email */
export const LINKS_TITLE = 'Links';
export const CREDITS_TITLE = 'Credits';
export const WORK_IN_BACKGROUND_TITLE = 'Work in the background';
/** Settings › Voice's rows (the search finds them by these titles) */
export const SPEECH_MODEL_TITLE = 'Speech model';
export const ALL_SPEECH_MODELS_TITLE = 'All speech models';
export const WHICH_LANGUAGE_TITLE = 'Which language?';
export const VOICE_MODEL_TITLE = 'Voice model';
export const ALL_VOICE_MODELS_TITLE = 'All voice models';
export const SPEECH_VOICE_TITLE = 'Voice';
export const TELEGRAM_VOICE_TITLE = 'Answer voice messages with voice';
export const VOICE_STORAGE_TITLE = 'Storage';
/** Settings › Permissions: what AppuBot needs the system to allow (the chat's notices open it) */
export const PERMISSIONS_TITLE = 'Permissions';
/** Settings › Usage's groups */
export const USAGE_LIMITS_TITLE = 'Plan limits';
export const USAGE_TITLE = 'What the bots used';
export const USAGE_ACTIVITY_TITLE = 'Activity';
export const USAGE_BY_MODEL_TITLE = 'By model';
export const USAGE_BY_AGENT_TITLE = 'By agent';
/** Settings › Account's groups */
export const ACCOUNT_YOU_TITLE = 'Signed in';
export const ACCOUNT_COMPUTERS_TITLE = 'Your computers';
/** the "Only in the cloud" / "Cloud and this Mac" choice (shown to people with a cloud computer that can work) */
export const ACCOUNT_WHERE_TITLE = 'Where your bots work';
/** the Fix your computer rows under a computer's Manage (Account) */
export const FIX_COMPUTER_TITLE = 'Fix your computer';
/** Settings › Billing's groups */
export const BILLING_PLAN_TITLE = 'Your plan';
export const BILLING_PLANS_TITLE = 'Plans';
export const BILLING_TEAMS_TITLE = 'Teams';
/** Settings › Team's groups */
export const TEAM_PEOPLE_TITLE = 'People';
export const TEAM_LOGINS_TITLE = 'AI sign-ins';
export const TEAM_PLAN_TITLE = 'Plan and seats';
/** Settings › Transfer: its page's title names the Mac the bots come from ("Transfer from Sarthak’s MacBook Pro") */
export const transferTitle = (macName: string): string => `Transfer from ${macName}`;
export const TRANSFER_BOTS_TITLE = 'Bots to bring';
export const TRANSFER_SKILLS_TITLE = 'Shared skills';
export const TRANSFER_GROUPS_TITLE = 'Groups to bring';
export const TRANSFER_VAULT_TITLE = 'Vault';
export const TRANSFER_GIT_TITLE = 'Git and GitHub';
export const TRANSFER_FILES_TITLE = 'Files on your Mac';
export const TRANSFER_SECRETS_TITLE = 'What stays on your Mac';
/** Settings › Storage's rows */
export const STORAGE_TITLE = 'Space used';
export const KEEP_FILES_TITLE = 'Keep files in chats';
export const KEEP_LOGS_TITLE = 'Keep logs';

export interface SettingsSearchEntry {
  section: SettingsSection;
  /** the row or group title exactly as rendered (its anchor is derived from it) */
  title: string;
  keywords?: string;
}

/** Every searchable setting. Titles must match the rendered SettingRow / SettingsGroup titles. */
/** a searchable row whose title is read in the current language (it must match the rendered row's) */
const tr = (section: SettingsSection, key: string, keywords: string, params?: () => Record<string, string>): SettingsSearchEntry => ({
  section,
  get title() { return t(key, params?.()); },
  keywords,
});

export const SETTINGS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  tr('appearance', 'appearance.colorScheme', 'theme appearance dark light mode system'),
  tr('appearance', 'appearance.background', 'background colour color tint theme skin look neutral slate ocean moss cocoa rose plum indigo'),
  ...(IS_MAC ? [
    tr('appearance', 'appearance.translucency', 'glass opacity transparency vibrancy'),
    tr('appearance', 'appearance.reduceTransparency', 'glass solid background'),
  ] : []),
  tr('appearance', 'appearance.glassOpacity', 'solid menus popovers composer transparency glass'),
  tr('appearance', 'general.chatShows', 'everything answers work steps tool calls commands thinking reasoning processing trail activity show hide verbose'),
  tr('appearance', 'appearance.math', 'latex katex math formula equation'),
  tr('appearance', 'appearance.sendShortcut', 'enter cmd ctrl send newline keyboard'),
  tr('appearance', 'appearance.clock', 'time format 12 24 hour clock am pm'),
  tr('appearance', 'appearance.animatedBackground', 'dither dots pixels animation motion empty chat background field'),
  tr('appearance', 'appearance.tooltips', 'tooltips tooltip hints hover labels titles help'),
  tr('appearance', 'appearance.shape', 'buttons shape round pill pills circle circles squircle corners rounded square'),
  tr('general', 'general.language.title', 'language locale translation interface idioma langue sprache lingua'),
  tr('general', 'general.model', 'default provider agent claude codex model'),
  tr('general', 'general.permissions', 'default permissions full access approve mode'),
  tr('general', 'general.keepAwake', 'power sleep awake caffeinate idle battery', machineParams),
  tr('general', 'general.lid', 'power sleep lid clamshell closed laptop pmset powercfg battery'),
  tr('general', 'general.desktopNotifications', 'alerts notify banners permission'),
  tr('general', 'general.phoneNotifications', 'alerts push mobile'),
  tr('general', 'general.openAtLogin', 'startup login launch boot autostart start automatically'),
  { section: 'providers', title: 'Agents', keywords: 'providers acp refresh install' },
  tr('instructions', 'instructions.title', 'global custom instructions every bot all agents shared rules system prompt preferences behaviour behavior'),
  ...(ACP_REGISTRY ? [{ section: 'providers' as const, title: 'More agents', keywords: 'acp registry add install gemini goose amp cline qwen kimi droid junie agents subscription' }] : []),
  { section: 'providers', title: 'Tailscale', keywords: 'tailnet network ip dns phone integrations' },
  { section: 'apps', title: DISCONNECT_APPS_TITLE, keywords: 'apps account sign out log out disconnect remove access integrations' },
  { section: 'apps', title: 'Connected apps', keywords: 'apps gmail slack github notion bots access reconnect disconnect' },
  { section: 'devices', title: 'Paired devices', keywords: 'phone pair revoke rename qr push' },
  { section: 'devices', title: 'AppuBot Connect', keywords: 'tunnel cloudflare remote anywhere internet address reach phone' },
  { section: 'devices', title: 'Same Wi-Fi without Tailscale', keywords: 'wifi wi-fi local network lan home connection offline vpn' },
  { section: 'devices', title: 'How to set up Tailscale', keywords: 'guide help install phone anywhere remote connect troubleshoot' },
  ...(SHOW_COMPUTER_SETTINGS ? [
    { section: 'computer' as const, title: 'Allow computer use', keywords: 'control mouse keyboard screen' },
    { section: 'computer' as const, title: 'Live view', keywords: 'stream frames phone' },
    { section: 'computer' as const, title: WORK_IN_BACKGROUND_TITLE, keywords: 'background behind front focus window watch busy keep working interrupt steal' },
    { section: 'computer' as const, title: "Show the bot's cursor", keywords: 'pointer agent cursor' },
    { section: 'computer' as const, title: 'Live view quality', keywords: 'frames screenshot quality network auto data saver jpeg width' },
  ] : []),
  // "cloud" stays a keyword (people search for it), never a name
  { section: 'account', title: ACCOUNT_YOU_TITLE, keywords: 'account sign in sign out log out email google apple profile' },
  { section: 'account', title: ACCOUNT_COMPUTERS_TITLE, keywords: 'appubot computer cloud server always on 24/7 remote awake asleep team this mac pc' },
  { section: 'account', title: ACCOUNT_WHERE_TITLE, keywords: 'only in the cloud cloud only both this mac pc laptop stop turn off disable local computer use bots run routines' },
  { section: 'account', title: FIX_COMPUTER_TITLE, keywords: 'update recover reset restore backup repair stuck broken not working unreachable rebuild manage computer cloud' },
  { section: 'billing', title: BILLING_PLAN_TITLE, keywords: 'billing subscription plan cancel renew change upgrade downgrade yearly monthly cloud payment card invoice receipt portal dodo manage claude credit launch bonus appubot ai included' },
  { section: 'billing', title: BILLING_PLANS_TITLE, keywords: 'plans price pricing buy subscribe free starter pro max work team business scale custom cloud add' },
  { section: 'team', title: TEAM_PEOPLE_TITLE, keywords: 'team members invite people roles admin remove seats leave' },
  { section: 'team', title: TEAM_LOGINS_TITLE, keywords: 'team logins sign-ins shared own accounts claude codex' },
  { section: 'team', title: TEAM_PLAN_TITLE, keywords: 'team seats plan billing' },
  // after Team's own rows, so "invite" finds People first
  { section: 'billing', title: BILLING_TEAMS_TITLE, keywords: 'start a team join team invite invitation accept decline work' },
  { section: 'import', title: 'Where are your bots now?', keywords: 'import migrate move switch from grok bot grokbot dots openai muse meta openbot mausbot openclaw hermes manus chatgpt claude gemini another assistant json file prompt export' },
  { section: 'transfer', title: TRANSFER_BOTS_TITLE, keywords: 'transfer import copy move bots from mac to appubot computer memory skills chats routines' },
  { section: 'transfer', title: TRANSFER_SKILLS_TITLE, keywords: 'transfer import copy skills claude agents codex shared global' },
  { section: 'transfer', title: TRANSFER_GROUPS_TITLE, keywords: 'transfer import copy move groups group chat room team bots together lead' },
  { section: 'transfer', title: TRANSFER_VAULT_TITLE, keywords: 'transfer vault passwords logins api keys contact bring copy carry from mac' },
  { section: 'transfer', title: TRANSFER_GIT_TITLE, keywords: 'transfer git github token sign in ssh key commit name email gh' },
  { section: 'transfer', title: TRANSFER_FILES_TITLE, keywords: 'transfer files folders mac read write save changes access documents desktop link lend' },
  { section: 'channels', title: 'Telegram bot', keywords: 'channel messaging enable' },
  { section: 'channels', title: 'Bot token', keywords: 'telegram botfather' },
  { section: 'channels', title: 'Allowed users', keywords: 'telegram username pair' },
  { section: 'vault', title: VAULT_TITLE, keywords: 'vault passwords logins cards credit debit contact address phone email api keys secrets saved' },
  { section: 'apps', title: CONNECTORS_TITLE, keywords: 'mcp server servers custom connector connectors integrations add remote local stdio sse http url command npx tools json config claude cursor' },
  { section: 'usage', title: USAGE_LIMITS_TITLE, keywords: 'usage limit limits quota remaining left reset resets 5-hour weekly plan subscription max pro plus rate limit claude chatgpt codex opencode go extra usage' },
  { section: 'usage', title: USAGE_TITLE, keywords: 'usage tokens cost spend price money billing api claude codex grok opencode copilot gemini pi cache savings statistics' },
  { section: 'usage', title: USAGE_ACTIVITY_TITLE, keywords: 'usage activity days year calendar grid heatmap streak history tokens most used' },
  { section: 'usage', title: USAGE_BY_MODEL_TITLE, keywords: 'usage models opus sonnet haiku fable gpt gemini grok tokens cost' },
  { section: 'usage', title: USAGE_BY_AGENT_TITLE, keywords: 'usage agents profiles accounts claude code codex grok opencode copilot gemini pi tokens cost' },
  { section: 'about', title: 'Version', keywords: 'update check restart' },
  { section: 'about', title: LINKS_TITLE, keywords: 'website site x twitter sarthak contact email follow support help chat feedback bug question' },
  { section: 'about', title: CREDITS_TITLE, keywords: 'credits thanks acknowledgements rare ui rareui synara t3 code akeru monocode shadcn silero open source packages fonts icons models components design licence license licenses attribution third party notices' },
  { section: 'whats-new', title: WHATS_NEW_TITLE, keywords: 'whats new release notes changelog updates history features' },
  { section: 'permissions', title: PERMISSIONS_TITLE, keywords: 'accessibility screen recording input monitoring notifications allow grant access ui automation at-spi x11 wayland' },
  // last, so Channels' own rows rank first for "telegram"
  { section: 'voice', title: SPEECH_MODEL_TITLE, keywords: 'voice speech hear recognition transcribe dictation stt language hindi hinglish english european chinese parakeet nemotron cohere qwen sensevoice bark underdog indicconformer whisper model' },
  { section: 'voice', title: WHICH_LANGUAGE_TITLE, keywords: 'voice speech other languages whisper automatic' },
  { section: 'voice', title: VOICE_MODEL_TITLE, keywords: 'speak read aloud tts text to speech supertonic kokoro model' },
  { section: 'voice', title: SPEECH_VOICE_TITLE, keywords: 'speak read aloud tts female male sound american british' },
  { section: 'voice', title: TELEGRAM_VOICE_TITLE, keywords: 'telegram voice replies notes audio' },
  { section: 'storage', title: STORAGE_TITLE, keywords: 'storage disk space size files logs clean up delete free room' },
  { section: 'storage', title: KEEP_FILES_TITLE, keywords: 'storage files attachments pictures images voice messages pages delete old days retention clean' },
  { section: 'storage', title: KEEP_LOGS_TITLE, keywords: 'storage logs delete old days retention clean' },
  { section: 'voice', title: VOICE_STORAGE_TITLE, keywords: 'voice files speech models download remove delete disk space size parakeet whisper indicconformer supertonic kokoro' },
];
