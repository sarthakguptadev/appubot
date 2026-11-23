/**
 * Profile rows in Settings › Providers' agent list: more than one account of Claude Code, Codex or Google Antigravity.
 * Each profile is the same agent with a config folder of its own (its own login, settings and sessions), like Synara's
 * Claude profiles. Under an agent that has them come its profiles (ProviderItem), then the folders found on this Mac
 * (Synara's, `~/.claude-*`, `~/.codex-*`) with Add, which keeps them as they are, already signed in; then "Add
 * profile", which makes an empty folder and opens its login (in Terminal, or Antigravity's own in the browser).
 */
import { useEffect, useState } from 'react';
import { Plus, X } from '../../components/ui/icons';
import type { FoundProfile, Provider } from '@appubot/protocol';
import { Badge, Button, Icon, Input, cn } from '../../components/ui';
import { call } from '../../lib/actions';
import { TERMINAL } from '../../lib/platform';
import { byId, pushToast, setState, upsertBy, useStore } from '../../lib/store';
import { ProviderMark } from './ProviderRow';
import { useCloudLink } from '../cloud/cloudClient';
import { CloudSignInDialog } from '../cloud/CloudAgentLogin';
import { deviceSignIn } from '@appubot/chat-core';
import { SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE } from '../settings/sections/shared';

const SOURCE_LABEL: Record<FoundProfile['source'], string> = { synara: 'Synara', folder: 'Folder' };
/** a profile row: indented under its agent */
export const PROFILE_ROW = cn(SETTINGS_ROW, 'pl-9');

/** `~` for the home folder in a path shown to the user. */
export function shortPath(path: string, home?: string): string {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

function added(p: Provider): void {
  setState((s) => ({ providers: upsertBy(s.providers, p, byId) }));
}

/** Profile folders on this Mac not added yet, looked for again whenever a profile comes or goes. */
export function useFoundProfiles(): FoundProfile[] {
  const profileCount = useStore((s) => s.providers.filter((p) => p.profile).length);
  const [found, setFound] = useState<FoundProfile[]>([]);
  useEffect(() => {
    let live = true;
    void call('providers.profiles', {}, { errorTitle: 'Could not look for profiles' }).then((r) => { if (live && r) setFound(r.found); });
    return () => { live = false; };
  }, [profileCount]);
  return found;
}

/** A profile folder found on this Mac: Add keeps it as it is (already signed in). */
export function FoundProfileRow({ found: f, base }: { found: FoundProfile; base: Provider }) {
  const home = useStore((s) => s.system?.homeDir);
  const [busy, setBusy] = useState(false);
  return (
    <div className={cn(PROFILE_ROW, 'flex items-center gap-3')}>
      <ProviderMark provider={{ id: f.of, name: f.name }} size={28} className="opacity-60" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('max-w-[55%] shrink-0 truncate text-fg-2', SETTINGS_ROW_TITLE)} title={f.name}>{f.name}</span>
          <Badge tone="neutral" className="shrink-0">{SOURCE_LABEL[f.source]}</Badge>
          <span className="min-w-0 truncate text-note text-muted">Not added</span>
        </div>
        <p className={cn('selectable mt-0.5 truncate font-mono text-note', SETTINGS_ROW_DESCRIPTION)} title={f.home}>{shortPath(f.home, home)}</p>
      </div>
      <Button
        size="xs" variant="outline" icon={Plus} loading={busy}
        onClick={async () => {
          setBusy(true);
          const p = await call('providers.addProfile', { of: f.of, name: f.name, home: f.home }, { errorTitle: `Could not add ${f.name}`, success: `Added ${base.name} · ${f.name}` });
          setBusy(false);
          if (p) added(p);
        }}
      >
        Add
      </Button>
    </div>
  );
}

/** "Add profile" under an agent: a name, then a new empty profile whose login opens (in Terminal, or the agent's own in the browser). */
export function AddProfileRow({ base }: { base: Provider }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // on the cloud computer its login runs there for this Mac (CloudAgentLogin), never on the cloud's own screen
  const onCloud = useCloudLink((s) => s.computer === 'cloud');
  const [signIn, setSignIn] = useState<Provider | null>(null);
  const submit = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    const p = await call('providers.addProfile', { of: base.id, name: n }, { errorTitle: 'Could not add the profile' });
    if (p) {
      added(p);
      if (onCloud && deviceSignIn(p)) setSignIn(p);
      else {
        const r = await call('providers.authenticate', { id: p.id }, { errorTitle: `Could not log in to ${p.name}` });
        if (r) pushToast({ title: r.ok ? `Log in to ${p.name}` : 'Finish logging in', body: r.message, level: 'info' });
      }
      setName('');
      setOpen(false);
    }
    setBusy(false);
  };

  const dialog = signIn ? <CloudSignInDialog provider={signIn} onClose={() => setSignIn(null)} /> : null;
  if (!open) {
    return (
      <>
      {dialog}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(PROFILE_ROW, 'flex w-full items-center gap-3 text-left text-copy text-muted transition-colors hover:bg-fg/2 hover:text-fg')}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-[10px] border border-dashed border-[color-mix(in_srgb,var(--ab-fg)_22%,transparent)]">
          <Icon icon={Plus} size={14} />
        </span>
        <span className="shrink-0">Add {base.name} profile</span>
        <span className="min-w-0 truncate text-note text-muted/70">another account, with its own login</span>
      </button>
      </>
    );
  }
  return (
    <form className={cn(PROFILE_ROW, 'flex items-center gap-2')} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <ProviderMark provider={base} size={28} />
      <Input
        value={name} autoFocus maxLength={40} placeholder="Profile name, e.g. Work" aria-label="Profile name" className="min-w-0 flex-1"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); setName(''); } }}
      />
      <Button type="submit" size="xs" variant="secondary" icon={Plus} disabled={!name.trim()} loading={busy} title={base.builtin ? `Adds the profile, then opens its login in ${TERMINAL}` : 'Adds the profile, then opens its login'}>
        Add and log in
      </Button>
      <Button size="icon-sm" variant="ghost" icon={X} aria-label="Cancel" onClick={() => { setOpen(false); setName(''); }} />
    </form>
  );
}
