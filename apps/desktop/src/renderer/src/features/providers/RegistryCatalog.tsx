// Settings › Agents › "More agents": the ACP registry's agents that run on this Mac (agentclientprotocol.com/registry).
// Add makes one an agent of its own, signed in with the user's own account for it; built-in ones are left out (they
// are in the list above), and an added one moves up there with an Update button when the registry has a newer version.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ACP_REGISTRY, type RegistryAgent } from '@appubot/protocol';
import { ExternalLink, Plus, RefreshCw, Search } from '../../components/ui/icons';
import { Badge, Button, Icon, Input, cn } from '../../components/ui';
import { call } from '../../lib/actions';
import { native } from '../../lib/native';
import { THIS_MACHINE } from '../../lib/platform';
import { byId, setState, upsertBy } from '../../lib/store';
import { SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE, SettingsCard, SettingsEmptyState, SettingsGroup } from '../settings/sections/shared';
import { ProviderMark } from './providerLogos';

const INSTALL_LABEL: Record<RegistryAgent['install'], { label: string; title: string }> = {
  binary: { label: 'Download', title: 'AppuBot downloads its build and checks it against the registry' },
  npx: { label: 'Node.js', title: `AppuBot installs its npm package: needs Node.js on ${THIS_MACHINE}` },
  uvx: { label: 'Python', title: `AppuBot installs its Python package with uv: needs uv on ${THIS_MACHINE}` },
};

export interface Registry {
  agents: RegistryAgent[];
  error?: string;
  loading: boolean;
  /** the registry entry an added agent came from, by provider id */
  byProvider: Map<string, RegistryAgent>;
  refresh: () => Promise<void>;
  /** add (or update) one; resolves once it is saved */
  add: (id: string) => Promise<void>;
  adding: ReadonlySet<string>;
}

/** The catalog, fetched when Settings › Agents opens (the Mac caches it). */
export function useRegistry(): Registry {
  const [agents, setAgents] = useState<RegistryAgent[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    const res = await call('providers.registry', { refresh }, { errorTitle: 'Could not load the ACP registry' });
    setLoading(false);
    if (!res) return;
    setAgents(res.agents);
    setError(res.error);
  }, []);
  useEffect(() => { if (ACP_REGISTRY) void load(false); }, [load]);

  const add = useCallback(async (id: string) => {
    const agent = agents.find((a) => a.id === id);
    setAdding((s) => new Set(s).add(id));
    const updating = !!agent?.providerId;
    const res = await call('providers.addFromRegistry', { id }, {
      errorTitle: `Could not ${updating ? 'update' : 'add'} ${agent?.name ?? id}`,
      success: agent ? `${updating ? `Updated ${agent.name} to v${agent.version}` : `Added ${agent.name}`}` : undefined,
    });
    setAdding((s) => { const n = new Set(s); n.delete(id); return n; });
    if (!res) return;
    setState((s) => ({ providers: upsertBy(s.providers, res, byId) }));
    setAgents((list) => list.map((a) => (a.id === id ? { ...a, providerId: res.id, installedVersion: a.version } : a)));
  }, [agents]);

  const byProvider = useMemo(() => new Map(agents.filter((a) => a.providerId).map((a) => [a.providerId!, a])), [agents]);
  return { agents, error, loading, byProvider, refresh: () => load(true), add, adding };
}

function CatalogRow({ agent: a, registry }: { agent: RegistryAgent; registry: Registry }) {
  const how = INSTALL_LABEL[a.install];
  const site = a.website || a.repository;
  return (
    <div className={cn(SETTINGS_ROW, 'flex items-center gap-3')}>
      <ProviderMark provider={a} size={34} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('min-w-0 truncate', SETTINGS_ROW_TITLE)}>{a.name}</span>
          <span className="max-w-[9rem] shrink-0 truncate font-mono text-note text-muted" title={`v${a.version}`}>v{a.version}</span>
          <span title={how.title}><Badge tone="neutral">{how.label}</Badge></span>
        </div>
        {a.description ? <p className={cn('mt-0.5 line-clamp-2', SETTINGS_ROW_DESCRIPTION)} title={a.description}>{a.description}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {site ? (
          <Button size="icon-sm" variant="ghost" icon={ExternalLink} aria-label={`${a.name}'s website`} title={site} onClick={() => void native().openExternal(site)} />
        ) : null}
        {a.providerId ? (
          <Badge tone="success">Added</Badge>
        ) : (
          <Button size="xs" variant="outline" icon={Plus} loading={registry.adding.has(a.id)} onClick={() => void registry.add(a.id)}>Add</Button>
        )}
      </div>
    </div>
  );
}

export function RegistryCatalog({ registry }: { registry: Registry }) {
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const q = query.trim().toLowerCase();
  const shown = registry.agents
    .filter((a) => !a.builtinId)
    .filter((a) => !q || `${a.name} ${a.id} ${a.description}`.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <SettingsGroup
      bare
      title="More agents"
      description="Agents from the ACP registry. Add one and sign in with your own account for it, then pick it for any bot."
      action={
        <Button
          size="xs" variant="outline" icon={RefreshCw} loading={refreshing}
          onClick={async () => { setRefreshing(true); await registry.refresh(); setRefreshing(false); }}
        >
          Check for updates
        </Button>
      }
    >
      <div className="relative">
        <Icon icon={Search} size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search agents" aria-label="Search agents" className="w-full ps-8" spellCheck={false} />
      </div>
      {registry.error ? <p className="px-2 text-ui text-warning">{registry.error}</p> : null}
      {shown.length ? (
        <SettingsCard>{shown.map((a) => <CatalogRow key={a.id} agent={a} registry={registry} />)}</SettingsCard>
      ) : (
        <SettingsEmptyState>
          {registry.loading ? 'Loading the ACP registry…' : q ? `No agent matches "${query.trim()}".` : `The ACP registry has no agents for ${THIS_MACHINE} right now.`}
        </SettingsEmptyState>
      )}
    </SettingsGroup>
  );
}
