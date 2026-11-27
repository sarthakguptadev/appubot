/**
 * Dev-only: the Apps directory (Composio) for the mock gateway. A seeded catalog across a few categories (logos are
 * SVG marks as data URIs; some have none, to show the initial), two connections and an expired one, and sign-ins
 * that finish by themselves after a moment. Which bot may use what is the bots' own `appsOff` (Ledger has GitHub off;
 * `bots.update` changes it). `?page=apps` opens the popup, `?apps=onboarding` starts signed out of Composio (signing in
 * "finishes" by itself a moment later), `?apps=none` with nothing connected, `?apps=one` with one Gmail, `?apps=many` with fifteen and
 * `?apps=accounts` with two Gmail accounts and three Google Calendars (adding an app that is connected adds an account).
 */
import { isDirectApp, newId, type AppCategory, type AppConnection, type AppToolkit, type AppsStatus } from '@appubot/protocol';
import { searchApps } from '@appubot/chat-core';
import { GatewayError } from '../lib/gateway';
import type { Handlers } from './mockHandlers';
import type { MockGateway } from './MockGateway';

function mark(color: string, text: string, fg = '#fff'): string {
  const size = text.length > 1 ? 24 : 32;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="${color}"/>`
    + `<text x="32" y="${32 + size * 0.36}" font-family="-apple-system,Helvetica,Arial,sans-serif" font-size="${size}" font-weight="700" text-anchor="middle" fill="${fg}">${text}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const CATEGORY_NAMES: Record<string, string> = {
  productivity: 'Productivity', communication: 'Communication', 'developer-tools': 'Developer Tools', crm: 'CRM',
  'password-managers': 'Password Managers', finance: 'Finance & Accounting', marketing: 'Marketing', storage: 'File Storage', ai: 'AI & Search',
};

type Seed = [slug: string, name: string, description: string, categories: string[], auth: AppToolkit['authKind'], logo?: [string, string, string?]];
const SEED: Seed[] = [
  ['gmail', 'Gmail', 'Read, search, draft and send email from your inbox', ['productivity', 'communication'], 'oauth', ['#EA4335', 'M']],
  ['googlecalendar', 'Google Calendar', 'Find free time, create events and send invites', ['productivity'], 'oauth', ['#4285F4', '31']],
  ['slack', 'Slack', 'Post messages, read channels and search conversations', ['communication'], 'oauth', ['#4A154B', '#']],
  ['notion', 'Notion', 'Pages, databases and docs in your workspace', ['productivity'], 'oauth', ['#111111', 'N']],
  ['github', 'GitHub', 'Issues, pull requests, repositories and reviews', ['developer-tools'], 'oauth', ['#181717', 'GH']],
  ['googledrive', 'Google Drive', 'Find, upload and share files and folders', ['productivity', 'storage'], 'oauth', ['#1FA463', 'D']],
  ['linear', 'Linear', 'Create and triage issues, projects and cycles', ['developer-tools', 'productivity'], 'oauth', ['#5E6AD2', 'L']],
  ['googlesheets', 'Google Sheets', 'Read and update rows in your spreadsheets', ['productivity'], 'oauth', ['#0F9D58', 'S']],
  ['googledocs', 'Google Docs', 'Write and edit documents', ['productivity'], 'oauth', ['#2684FC', 'D']],
  ['outlook', 'Outlook', 'Microsoft 365 mail, calendar and contacts', ['productivity', 'communication'], 'oauth', ['#0078D4', 'O']],
  ['todoist', 'Todoist', 'Tasks, projects and due dates', ['productivity'], 'oauth', ['#E44332', 'T']],
  ['asana', 'Asana', 'Tasks, projects and team workloads', ['productivity'], 'oauth', ['#F06A6A', 'A']],
  ['trello', 'Trello', 'Boards, lists and cards', ['productivity'], 'oauth', ['#0079BF', 'T']],
  ['airtable', 'Airtable', 'Bases, tables and records', ['productivity'], 'api_key', ['#FCB400', 'A', '#1d1d1f']],
  ['clickup', 'ClickUp', 'Tasks, docs and goals in one place', ['productivity'], 'oauth', ['#7B68EE', 'C']],
  ['calendly', 'Calendly', 'Scheduling links and booked meetings', ['productivity'], 'oauth', ['#006BFF', 'C']],
  ['discord', 'Discord', 'Messages and channels in your servers', ['communication'], 'oauth', ['#5865F2', 'D']],
  ['microsoftteams', 'Microsoft Teams', 'Chats, channels and meetings', ['communication'], 'oauth', ['#4B53BC', 'T']],
  ['twilio', 'Twilio', 'Send SMS and WhatsApp messages', ['communication'], 'api_key', ['#F22F46', 'Tw']],
  ['intercom', 'Intercom', 'Customer conversations and help articles', ['communication', 'crm'], 'oauth', ['#1F8DED', 'I']],
  ['zoom', 'Zoom', 'Meetings, recordings and transcripts', ['communication'], 'oauth', ['#0B5CFF', 'Z']],
  ['gitlab', 'GitLab', 'Merge requests, issues and pipelines', ['developer-tools'], 'oauth', ['#FC6D26', 'GL']],
  ['jira', 'Jira', 'Issues, sprints and boards', ['developer-tools', 'productivity'], 'oauth', ['#0052CC', 'J']],
  ['sentry', 'Sentry', 'Errors, issues and releases', ['developer-tools'], 'oauth', ['#362D59', 'S']],
  ['vercel', 'Vercel', 'Deployments, domains and logs', ['developer-tools'], 'api_key', ['#000000', '▲']],
  ['supabase', 'Supabase', 'Databases, auth and storage for your projects', ['developer-tools'], 'api_key', ['#3ECF8E', 'S']],
  ['posthog', 'PostHog', 'Product analytics, flags and session replays', ['developer-tools', 'marketing'], 'api_key'],
  ['figma', 'Figma', 'Files, comments and design components', ['developer-tools'], 'oauth', ['#A259FF', 'F']],
  ['hubspot', 'HubSpot', 'Contacts, deals and marketing emails', ['crm', 'marketing'], 'oauth', ['#FF7A59', 'H']],
  ['salesforce', 'Salesforce', 'Leads, accounts and opportunities', ['crm'], 'oauth', ['#00A1E0', 'SF']],
  ['pipedrive', 'Pipedrive', 'Deals, pipelines and activities', ['crm'], 'api_key', ['#1A1A1A', 'P']],
  ['attio', 'Attio', 'Records, lists and notes in your CRM', ['crm'], 'oauth'],
  ['zohocrm', 'Zoho CRM', 'Leads, contacts and deals', ['crm'], 'oauth', ['#E42527', 'Z']],
  // on their own servers (no Composio sign-in): one that signs in on the app's own page, one that needs no sign-in
  ['paypal_direct', 'PayPal', 'Invoices, orders, payments, refunds and disputes in your PayPal account.', ['finance'], 'oauth', ['#003087', 'P']],
  ['zapier_direct', 'Zapier', 'The actions you have set up in Zapier, across the apps Zapier connects.', ['productivity'], 'oauth', ['#FF4F00', 'Z']],
  ['microsoftlearn_direct', 'Microsoft Learn', "Search Microsoft's official documentation and code samples.", ['developer-tools'], 'none', ['#0067B8', 'M']],
  ['1password', '1Password', 'Look up items in vaults your service account can read', ['password-managers'], 'api_key', ['#0572EC', '1']],
  ['bitwarden', 'Bitwarden', 'Secrets and collections for your organisation', ['password-managers'], 'api_key', ['#175DDC', 'B']],
  ['dashlane', 'Dashlane', 'Team members, groups and audit logs', ['password-managers'], 'api_key'],
  ['stripe', 'Stripe', 'Payments, customers, invoices and subscriptions', ['finance'], 'api_key', ['#635BFF', 'S']],
  ['quickbooks', 'QuickBooks', 'Invoices, bills and reports', ['finance'], 'oauth', ['#2CA01C', 'qb']],
  ['xero', 'Xero', 'Accounting, invoices and bank feeds', ['finance'], 'oauth', ['#13B5EA', 'X']],
  ['mailchimp', 'Mailchimp', 'Audiences, campaigns and reports', ['marketing'], 'oauth', ['#FFE01B', 'M', '#1d1d1f']],
  ['typeform', 'Typeform', 'Forms and their responses', ['marketing'], 'oauth', ['#262627', 'T']],
  ['dropbox', 'Dropbox', 'Files and shared folders', ['storage'], 'oauth', ['#0061FF', 'D']],
  ['box', 'Box', 'Files, folders and collaborations', ['storage'], 'oauth', ['#0061D5', 'box']],
  ['tavily', 'Tavily', 'Web search built for AI agents', ['ai'], 'api_key', ['#3B5BDB', 'T']],
  ['perplexityai', 'Perplexity', 'Answers from the web with sources', ['ai'], 'api_key', ['#20808D', 'P']],
  ['hackernews', 'Hacker News', 'Top stories, comments and users', ['ai'], 'none', ['#FF6600', 'Y']],
];

const TOOLKITS: AppToolkit[] = SEED.map(([slug, name, description, categories, authKind, logo]) => ({
  slug, name, description, categories, authKind, logo: logo ? mark(logo[0], logo[1], logo[2]) : undefined,
}));

const CATEGORIES: AppCategory[] = Object.entries(CATEGORY_NAMES)
  .map(([id, name]) => ({ id, name, count: TOOLKITS.filter((t) => t.categories.includes(id)).length }))
  .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

export function createAppsHandlers(g: MockGateway): Pick<Handlers, 'apps.status' | 'apps.signIn' | 'apps.finishSignIn' | 'apps.signOut' | 'apps.catalog' | 'apps.connections' | 'apps.connect' | 'apps.disconnect' | 'apps.setDefault'> {
  let signedIn = !!g.opts.appsKey;
  let signingIn = false;
  const pending = new Set<string>();
  const MANY = ['gmail', 'github', 'googlecalendar', 'slack', 'linear', 'googledrive', 'figma', 'stripe', 'hubspot', 'posthog', 'zoom', 'jira', 'dropbox', 'attio'];
  const account = (slug: string, n: number, label: string, status = 'ACTIVE'): AppConnection => ({ slug, connectedAccountId: `ca_${slug}_${n}`, status, label });
  let connections: AppConnection[] = g.opts.appsSeed === 'none' ? [] : g.opts.appsSeed === 'one' ? [account('gmail', 1, 'sarthak@example.com')] : g.opts.appsSeed === 'accounts' ? [
    account('gmail', 1, 'sarthak@appubot.com'), account('gmail', 2, 'sarthak.personal@gmail.com'),
    { slug: 'github', connectedAccountId: 'ca_github', status: 'ACTIVE', label: 'sarthakguptadev' },
    account('googlecalendar', 1, 'sarthak@appubot.com'), account('googlecalendar', 2, 'sarthak.personal@gmail.com'), account('googlecalendar', 3, 'family@gmail.com', 'EXPIRED'),
    { slug: 'slack', connectedAccountId: 'ca_slack', status: 'ACTIVE', label: 'AppuBot' },
  ] : [
    ...(g.opts.appsSeed === 'many' ? MANY : ['gmail', 'github']).map((slug) => ({ slug, connectedAccountId: `ca_${slug}`, status: 'ACTIVE' })),
    { slug: 'notion', connectedAccountId: 'ca_notion', status: 'EXPIRED' },
  ];
  /** of an app with several accounts, the one the bots use: the user's pick, else the first that works */
  const defaults = new Map<string, string>();
  const listed = (): AppConnection[] => connections.map((c) => {
    const working = connections.filter((x) => x.slug === c.slug && x.status === 'ACTIVE');
    const first = working.find((x) => x.connectedAccountId === defaults.get(c.slug)) ?? working[0];
    return first === c ? { ...c, isDefault: true } : c;
  });

  const status = (): AppsStatus => ({ configured: signedIn, account: signedIn ? 'sarthak@appubot.com' : undefined, signingIn, pending: [...pending], direct: true });
  const emit = () => g.emit('apps.updated', status());
  const need = () => { if (!signedIn) throw new GatewayError('apps_not_configured', 'Sign in once in Apps to connect apps'); };
  const toolkit = (slug: string) => TOOLKITS.find((t) => t.slug === slug);
  const activate = (slug: string) => {
    // a signed-out account is replaced; one that works stays, and the new one is another account beside it
    const kept = connections.filter((c) => c.slug === slug && c.status === 'ACTIVE');
    const name = toolkit(slug)?.name ?? slug;
    connections = [...connections.filter((c) => c.slug !== slug || c.status === 'ACTIVE'), { slug, connectedAccountId: newId('ca'), status: 'ACTIVE', ...(kept.length ? { label: `another.${kept.length}@example.com` } : {}) }];
    g.emit('notification', kept.length
      ? { id: newId('ntf'), title: `Another ${name} account connected`, body: `Your bots keep using ${kept[0]!.label ?? 'the first one'} unless they are told to use the new one. Change the default in Apps.`, level: 'success', ts: Date.now() }
      : { id: newId('ntf'), title: `${name} connected`, body: 'Your bots can use it now.', level: 'success', ts: Date.now() });
    emit();
  };

  return {
    'apps.status': () => status(),
    'apps.signIn': () => {
      signingIn = true;
      emit();
      // the browser sign-in "finishes" a moment later
      g.later(() => { if (signingIn) { signingIn = false; signedIn = true; emit(); } }, 2600);
      return status();
    },
    // (only a device signing in itself sends this)
    'apps.finishSignIn': () => {
      signingIn = false;
      signedIn = true;
      emit();
      return { ok: true, status: status() };
    },
    'apps.signOut': () => {
      signedIn = false;
      signingIn = false;
      pending.clear();
      emit();
      return status();
    },
    'apps.catalog': (p) => {
      const limit = p?.limit ?? 60;
      if (p?.slugs?.length) return { categories: CATEGORIES, toolkits: p.slugs.flatMap((s) => toolkit(s) ?? []) };
      let list = p?.category ? TOOLKITS.filter((t) => t.categories.includes(p.category!)) : TOOLKITS;
      // the gateway's own search, over the seeded catalog
      if (p?.search?.trim()) list = searchApps(list, p.search, CATEGORIES);
      const offset = Number(p?.cursor ?? 0) || 0;
      return { categories: CATEGORIES, toolkits: list.slice(offset, offset + limit), nextCursor: offset + limit < list.length ? String(offset + limit) : undefined, total: list.length };
    },
    // signed out of Composio, the apps on their own servers are still listed
    'apps.connections': () => (signedIn ? listed() : listed().filter((c) => isDirectApp(c.slug))),
    'apps.connect': (p) => {
      if (!isDirectApp(p.slug)) need();
      const t = toolkit(p.slug);
      if (t && isDirectApp(t.slug) && t.authKind === 'none') { activate(p.slug); return {}; }
      if (!t || t.authKind === 'none') return {};
      pending.add(p.slug);
      emit();
      // the sign-in "finishes" a moment later
      g.later(() => { if (pending.delete(p.slug)) activate(p.slug); }, 2600);
      return { redirectUrl: `https://connect.composio.dev/link/lk_mock_${p.slug}` };
    },
    'apps.disconnect': (p) => {
      if (!isDirectApp(p.slug)) need();
      if (!connections.some((c) => c.connectedAccountId === p.connectedAccountId)) throw new GatewayError('not_found', 'Connection not found');
      connections = connections.filter((c) => c.connectedAccountId !== p.connectedAccountId);
      emit();
      return { ok: true };
    },
    'apps.setDefault': (p) => {
      if (!connections.some((c) => c.connectedAccountId === p.connectedAccountId && c.status === 'ACTIVE')) throw new GatewayError('not_found', 'Connection not found');
      defaults.set(p.slug, p.connectedAccountId);
      emit();
      return { ok: true };
    },
  };
}
