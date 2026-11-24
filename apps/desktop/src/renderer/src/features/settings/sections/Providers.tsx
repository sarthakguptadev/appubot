import { Fragment, useState } from 'react';
import { ArrowUp, ChevronRight, Download, Globe, HardDrive, Pencil, Plus, RefreshCw, Trash2 } from '../../../components/ui/icons';
import type { ModelEndpoint, Provider, RegistryAgent } from '@appubot/protocol';
import { providerLogin } from '@appubot/chat-core';
import { Badge, Button, Icon, Input, Switch, cn } from '../../../components/ui';
import { call, confirm, toastCallError } from '../../../lib/actions';
import { updateAgent, updateFailureText, type AgentUpdateResult } from '../../providers/agentUpdates';
import { optimisticCall } from '../../../lib/optimistic';
import { THIS_MACHINE } from '../../../lib/platform';
import { native } from '../../../lib/native';
import { byId, pushToast, setState, upsertBy, useStore } from '../../../lib/store';
import { ProviderActions, ProviderMark, ProviderStatusBadge, refreshProviders } from '../../providers/ProviderRow';
import { AddCustomDialog, type AddCustomStep } from '../../providers/AddCustomDialog';
import { DeleteButton } from '../../../components/rare/DeleteButton';
import { reloadEndpoints, useEndpoints } from '../../providers/endpoints';
import { RegistryCatalog, useRegistry, type Registry } from '../../providers/RegistryCatalog';
import { AddProfileRow, FoundProfileRow, PROFILE_ROW, shortPath, useFoundProfiles } from '../../providers/ProfilesGroup';
import { ACP_REGISTRY, PROFILE_HOME_ENV } from '@appubot/protocol';
import { TailscaleSettingRow } from '../TailscaleSettingRow';
import { settingAnchorId } from '../nav';
import { CLOUD_AGENTS_NOTE } from '../../cloud/CloudAgentLogin';
import { SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE, SettingsCard, SettingsEmptyState, SettingsGroup } from './shared';

/** where an agent that only installs with npm sends someone without Node.js */
const NODE_DOWNLOAD = 'https://nodejs.org/en/download';

function upsertParams(p: Provider, patch: Partial<Provider> = {}) {
  const next = { ...p, ...patch };
  return {
    id: next.id, name: next.name, description: next.description, command: next.command, args: next.args,
    env: next.env, icon: next.icon, enabled: next.enabled, installHint: next.installHint,
  };
}

async function setEnabled(p: Provider, enabled: boolean): Promise<void> {
  await optimisticCall('providers.upsert', upsertParams(p, { enabled }), [{ kind: 'patch', coll: 'providers', id: p.id, fields: { enabled } }], {
    errorTitle: `Could not update ${p.name}`, answered: (x) => ({ coll: 'providers', entity: x }),
  });
}

function removeProvider(p: Provider, baseName?: string): void {
  confirm({
    title: `Remove ${p.name}?`,
    body: p.profile
      ? `Bots on this profile go back to ${baseName ?? 'the agent'}'s usual account. Its folder and login stay on ${THIS_MACHINE}, so you can add it again.`
      : 'Bots using this agent will need a different provider before they can run again.',
    confirmLabel: 'Remove',
    danger: true,
    onConfirm: async () => {
      const res = await call('providers.delete', { id: p.id }, { errorTitle: `Could not remove ${p.name}`, success: `Removed ${p.name}` });
      if (res) setState((s) => ({ providers: s.providers.filter((x) => x.id !== p.id) }));
    },
  });
}

/** Look for newer versions of every agent (npm, Homebrew, the ACP registry); says what it found. */
async function checkUpdates(): Promise<void> {
  const list = await call('providers.checkUpdates', {}, { errorTitle: 'Could not check for updates' });
  if (!list) return;
  setState({ providers: list });
  const out = list.filter((p) => p.updateAvailable);
  const failed = list.find((p) => p.update?.error);
  pushToast(out.length
    ? { title: out.length === 1 ? `An update for ${out[0]!.name} is available` : `${out.length} agent updates are available`, level: 'info' }
    : failed
      ? { title: 'Could not check every agent', body: `${failed.name}: ${failed.update!.error}`, level: 'warning' }
      : { title: 'Your agents are up to date', level: 'success' });
}

/** Update an agent to its newest version (`providers.update` waits for the install, which can take minutes). */
async function updateProvider(p: Provider): Promise<void> {
  let r: AgentUpdateResult;
  try { r = await updateAgent(p); } catch (e) { toastCallError(e, `Could not update ${p.name}`); return; }
  // the agent's own update notice, when it's up, already tells the outcome
  if (useStore.getState().toasts.some((t) => t.id === `agent-update:${p.id}`)) return;
  pushToast(r.ok
    ? { title: `Updated ${p.name}`, body: r.message, level: 'success' }
    : { title: `Could not update ${p.name}`, body: updateFailureText(r), level: r.message && !r.output ? 'warning' : 'error' });
}

/**
 * The newer version to offer, if any: the gateway's check (`updateAvailable`), else, for an agent from the ACP
 * registry, the catalog's newer entry (seen before the first check runs).
 */
function newerVersion(p: Provider, registry: Registry): { from?: string; to: string } | undefined {
  if (p.updateAvailable && p.latestVersion) return { from: p.update?.current, to: p.latestVersion };
  const entry: RegistryAgent | undefined = p.registry ? registry.byProvider.get(p.id) : undefined;
  return entry && entry.version !== p.registry?.version ? { from: p.registry?.version, to: entry.version } : undefined;
}

/** "Update available v2.0.14 → v2.0.20" under the description, with how it updates (or why it can't from here). */
function UpdateLine({ provider: p, newer }: { provider: Provider; newer: { from?: string; to: string } }) {
  const running = !!p.update?.running;
  const manual = !p.registry && !p.update?.via;
  return (
    <div className="mt-1.5 flex min-w-0 items-center gap-2">
      <Badge tone="accent" dot className="shrink-0">{running ? 'Updating…' : 'Update available'}</Badge>
      <span className="shrink-0 font-mono text-note text-fg-2">{newer.from ? `v${newer.from} → ` : ''}v{newer.to}</span>
      <span className="min-w-0 truncate text-note text-muted" title={p.update?.via}>
        {manual ? 'Update it the way you installed it' : p.registry ? 'from the ACP registry' : <>with <span className="font-mono text-note">{p.update?.via}</span></>}
      </span>
    </div>
  );
}

/** A profile's name, edited in place (Enter saves, Escape cancels). */
function RenameProfile({ provider: p, onDone }: { provider: Provider; onDone: () => void }) {
  const current = p.profile?.name ?? p.profileName ?? 'Main';
  const [name, setName] = useState(current);
  const save = async () => {
    const n = name.trim();
    if (n && n !== current) {
      const res = await call('providers.renameProfile', { id: p.id, name: n }, { errorTitle: 'Could not rename the profile' });
      if (res) setState((s) => ({ providers: upsertBy(s.providers, res, byId) }));
    }
    onDone();
  };
  return (
    <Input
      value={name} autoFocus maxLength={40} aria-label="Profile name" className="h-7 w-48 text-copy"
      onChange={(e) => setName(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') onDone(); }}
    />
  );
}

function ProviderItem({ provider: p, registry }: { provider: Provider; registry: Registry }) {
  const home = useStore((s) => s.system?.homeDir);
  const baseName = useStore((s) => (p.profile ? s.providers.find((x) => x.id === p.profile!.of)?.name : undefined));
  const [renaming, setRenaming] = useState(false);
  const newer = p.profile ? undefined : newerVersion(p, registry);
  // an agent with profiles names its own, default one too ("Claude Code · Default")
  const hasProfiles = !p.profile && !!PROFILE_HOME_ENV[p.id];
  const [updating, setUpdating] = useState(false);
  const canUpdate = !!newer && (!!p.registry || !!p.update?.via);
  const [showCommand, setShowCommand] = useState(false);
  // the CLI's own version when the update check read it (a built-in's `version` is its bundled ACP adapter's)
  const shownVersion = p.update?.current ?? p.version;
  const versionTitle = p.update?.current && p.version && p.version !== p.update.current && !p.registry
    ? `${p.name} v${p.update.current} · ACP adapter v${p.version}` : shownVersion ? `v${shownVersion}` : undefined;
  const missing = providerLogin(p).kind === 'not_installed';
  const command = [p.command, ...p.args].join(' ');
  return (
    <div className={cn(p.profile ? PROFILE_ROW : SETTINGS_ROW, 'flex items-start gap-3')}>
      <ProviderMark provider={p} size={p.profile ? 28 : 34} />
      <div className="min-w-0 flex-1">
        {/* wraps rather than truncating: in a narrow window the version and badges go under the name */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {renaming ? <RenameProfile provider={p} onDone={() => setRenaming(false)} /> : <span className={cn('max-w-full min-w-0 truncate', SETTINGS_ROW_TITLE)} title={p.name}>
            {p.profile ? p.profile.name : p.name}
            {hasProfiles ? <span className="font-normal text-fg-2"> · {p.profileName ?? 'Main'}</span> : null}
          </span>}
          {shownVersion && !p.profile ? <span className="max-w-[9rem] shrink-0 truncate font-mono text-note text-muted" title={versionTitle}>v{shownVersion}</span> : null}
          {p.profile ? <Badge tone="neutral" className="shrink-0">{p.profile.source === 'synara' ? 'Synara' : 'Profile'}</Badge> : p.registry ? <Badge tone="neutral">ACP registry</Badge> : !p.builtin ? <Badge tone="neutral">Custom</Badge> : null}
          <ProviderStatusBadge provider={p} />
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-0.5">
          {p.profile ? (
            <p className={cn('selectable min-w-0 truncate font-mono text-note', SETTINGS_ROW_DESCRIPTION)} title={p.profile.home}>{shortPath(p.profile.home, home)}</p>
          ) : (
          <p className={cn('min-w-0 truncate', SETTINGS_ROW_DESCRIPTION)} title={p.description || undefined}>{p.description || command}</p>
          )}
          {p.profile ? null : <button
            type="button"
            onClick={() => setShowCommand((v) => !v)}
            aria-expanded={showCommand}
            aria-label={showCommand ? 'Hide command' : 'Show command'}
            title={showCommand ? 'Hide command' : 'Show command'}
            className="ab-pill inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]"
          >
            <Icon icon={ChevronRight} size={12} className={cn('transition-transform duration-150', showCommand && 'rotate-90')} />
          </button>}
        </div>
        {showCommand ? (
          <p className="selectable mt-1 truncate font-mono text-note text-muted" title={command}>{command}</p>
        ) : null}
        {missing && p.installHint ? (
          <p className="selectable squircle mt-1.5 truncate rounded-control-sm bg-surface-2 px-2.5 py-1.5 font-mono text-note text-fg-2" title={p.installHint}>{p.installHint}</p>
        ) : null}
        {missing && p.installNeeds === 'node' ? (
          <p className="mt-1.5 text-ui leading-snug text-warning">
            Needs Node.js, which isn’t on {THIS_MACHINE}.{' '}
            <button type="button" className="text-fg-2 underline underline-offset-2 hover:text-fg" onClick={() => void native().openExternal(NODE_DOWNLOAD)}>Get Node.js</button>
          </p>
        ) : null}
        {newer ? <UpdateLine provider={p} newer={newer} /> : null}
        {p.lastError ? <p className="selectable mt-1.5 line-clamp-2 text-ui leading-snug text-danger">{p.lastError}</p> : null}
        {p.update?.error ? <p className="selectable mt-1.5 line-clamp-2 text-ui leading-snug text-warning" title={p.update.error}>{p.update.error}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-1">
        {canUpdate ? (
          <Button
            size="xs" variant="outline" icon={Download}
            loading={updating || !!p.update?.running || (!!p.registry && registry.adding.has(p.registry.id))}
            title={`${newer!.from ? `v${newer!.from} → ` : ''}v${newer!.to}`}
            onClick={async () => { setUpdating(true); await updateProvider(p); setUpdating(false); }}
          >
            Update
          </Button>
        ) : null}
        <ProviderActions provider={p} />
        {p.profile || hasProfiles ? (
          <Button size="icon-sm" variant="ghost" icon={Pencil} aria-label={`Rename ${p.name}${hasProfiles ? ' profile' : ''}`} title="Rename" onClick={() => setRenaming(true)} />
        ) : null}
        {!p.builtin ? (
          <Button size="icon-sm" variant="danger" icon={Trash2} aria-label={`Remove ${p.name}`} title="Remove" onClick={() => removeProvider(p, baseName)} />
        ) : null}
        <Switch label={`Enable ${p.name}`} checked={p.enabled} onChange={(v) => void setEnabled(p, v)} />
      </div>
    </div>
  );
}

/** Asked in place by the row's own bin (Rare UI's delete button). Bots on one of its models go back to OpenCode's default. */
async function removeEndpoint(e: ModelEndpoint): Promise<void> {
  const res = await call('endpoints.delete', { id: e.id }, { errorTitle: `Could not remove ${e.name}`, success: `Removed ${e.name}` });
  if (res) await Promise.all([reloadEndpoints(), refreshProviders()]);
}

/** A custom model server: name, address and models, with Edit and Remove. */
function EndpointItem({ endpoint: e, onEdit }: { endpoint: ModelEndpoint; onEdit: () => void }) {
  const models = e.models.length === 1 ? e.models[0]! : `${e.models.length} models`;
  return (
    <div className={cn(SETTINGS_ROW, 'flex items-center gap-3')}>
      <span className="flex size-[34px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-fg-2">
        <Icon icon={e.kind === 'openai' ? Globe : HardDrive} size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('truncate', SETTINGS_ROW_TITLE)}>{e.name}</span>
          <Badge tone="neutral" className="shrink-0">OpenCode</Badge>
        </div>
        <p className={cn('mt-0.5 truncate', SETTINGS_ROW_DESCRIPTION)} title={e.models.join(', ')}>
          <span className="font-mono text-note">{e.baseUrl}</span> · {models}
        </p>
      </div>
      <Button size="icon-sm" variant="ghost" icon={Pencil} aria-label={`Edit ${e.name}`} title="Edit" onClick={onEdit} />
      <DeleteButton label={`Remove ${e.name}`} onConfirm={() => void removeEndpoint(e)} />
    </div>
  );
}

export function ProvidersSection() {
  const providers = useStore((s) => s.providers);
  const [refreshing, setRefreshing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [dialog, setDialog] = useState<'menu' | AddCustomStep | null>(null);
  const endpoints = useEndpoints();
  const lastCheck = Math.max(0, ...providers.map((p) => p.update?.checkedAt ?? 0));
  const registry = useRegistry();
  const found = useFoundProfiles();
  // the cloud computer's agents: their own logins there, and no Tailscale of its own to set up
  const onCloud = useStore((s) => !!s.system?.cloud);

  // built-ins in the app's order, each followed by its profiles (by name), then custom agents by name
  const others = providers.filter((p) => !p.profile);
  const tops = [...others].sort((a, b) => Number(b.builtin) - Number(a.builtin) || (a.builtin ? 0 : a.name.localeCompare(b.name)));
  const profilesOf = (id: string) => providers.filter((p) => p.profile?.of === id).sort((a, b) => a.name.localeCompare(b.name));
  // profiles whose agent isn't listed (kept, so they can still be removed)
  const orphans = providers.filter((p) => p.profile && !others.some((o) => o.id === p.profile!.of));
  const sorted = [...tops, ...orphans];

  return (
    <div className="space-y-6">
      <SettingsGroup
        bare
        title="Agents"
        description={onCloud ? CLOUD_AGENTS_NOTE : `The coding agents your bots run on. Each one uses its own login on ${THIS_MACHINE}.`}
        action={
          <div className="flex items-center gap-2">
            <Button id={settingAnchorId('Add custom')} size="xs" variant="outline" icon={Plus} className="scroll-mt-24" onClick={() => setDialog('menu')}>
              Add custom
            </Button>
            <Button
              size="xs" variant="outline" icon={ArrowUp} loading={checking}
              title={lastCheck ? `Last checked ${new Date(lastCheck).toLocaleString()}` : undefined}
              onClick={async () => { setChecking(true); await checkUpdates(); setChecking(false); }}
            >
              Check for updates
            </Button>
            <Button
              size="xs" variant="outline" icon={RefreshCw} loading={refreshing}
              onClick={async () => { setRefreshing(true); await refreshProviders(); setRefreshing(false); }}
            >
              Refresh all
            </Button>
          </div>
        }
      >
        {sorted.length ? (
          <SettingsCard>
            {[...tops, ...orphans].map((p) => (
              <Fragment key={p.id}>
                <ProviderItem provider={p} registry={registry} />
                {/* under an agent that has profiles: its profiles, the ones found on this Mac, then a new one */}
                {profilesOf(p.id).map((x) => <ProviderItem key={x.id} provider={x} registry={registry} />)}
                {!p.profile && PROFILE_HOME_ENV[p.id] ? (
                  <>
                    {found.filter((f) => f.of === p.id).map((f) => <FoundProfileRow key={f.home} found={f} base={p} />)}
                    <AddProfileRow base={p} />
                  </>
                ) : null}
              </Fragment>
            ))}
          </SettingsCard>
        ) : (
          <SettingsEmptyState>Refresh to detect installed agents.</SettingsEmptyState>
        )}
      </SettingsGroup>

      {ACP_REGISTRY ? <RegistryCatalog registry={registry} /> : null}

      {endpoints.length ? (
        <SettingsGroup
          bare
          title="Custom models"
          description="Model servers OpenCode runs your bots on. Their models are in OpenCode's model list."
        >
          <SettingsCard>
            {endpoints.map((e) => <EndpointItem key={e.id} endpoint={e} onEdit={() => setDialog({ kind: 'endpoint', type: e.kind, edit: e })} />)}
          </SettingsCard>
        </SettingsGroup>
      ) : null}

      {onCloud ? null : (
        <SettingsGroup title="Services" description={`Tailscale lets your phone reach ${THIS_MACHINE} from anywhere.`}>
          <TailscaleSettingRow />
        </SettingsGroup>
      )}

      {dialog ? <AddCustomDialog start={dialog === 'menu' ? undefined : dialog} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
