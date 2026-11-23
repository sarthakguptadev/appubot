/**
 * Settings › Transfer, beside the bots: what else this Mac hands the AppuBot computer on screen (protocol `carry.ts`).
 *
 *  - `VaultCarryGroup`: this Mac's Vault items, saved there (`vaultCarryPlan.ts`). This Mac opens each picked secret
 *    (`vault.reveal`, its own window only) and the other computer seals it with its own key; a computer whose Vault
 *    can't seal yet gets nothing.
 *  - `GitCarryGroup`: the name and email git signs commits with and the GitHub sign-in (`github.*`); the other
 *    computer makes an SSH key of its own rather than getting this Mac's.
 *  - `MacFilesGroup`: the folders on this Mac that the bots there may read while it is on (`macLink.*` here,
 *    `macFiles.*` there), and, per folder, a switch letting them save changes there (`macLink.setWritable`, off by
 *    default). A person's own AppuBot computer only, never a team's.
 *
 * Each group reads both computers itself: this Mac through `localGateway()`, the other through its own client.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { VAULT_SECRETS, type GitLocal, type GitSetup, type MacFilesStatus, type MacLinkStatus, type MethodResult, type VaultItem, type VaultSecretField } from '@appubot/protocol';
import { AlertTriangle, CircleCheck, Copy, FolderOpen, X } from '../../components/ui/icons';
import { Button, Checkbox, Icon, Spinner, Switch, cn } from '../../components/ui';
import { errorMessage, localGateway, type GatewayLike } from '../../lib/gateway';
import { useMacName } from '../../lib/macName';
import { native } from '../../lib/native';
import { pushToast } from '../../lib/store';
import { cloudClientReady, useCloudLink } from '../cloud/cloudClient';
import { useCloudUpToDate, useThisComputer } from '../cloud/thisComputer';
import { useCloudLacks } from '../cloud/useCloudLacks';
import { unsealedVaultText } from '../vault/unsealedText';
import { saveVaultItems } from '../vault/vaultCarry';
import { TRANSFER_FILES_TITLE, TRANSFER_GIT_TITLE, TRANSFER_VAULT_TITLE } from '../settings/nav';
import { SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE, SettingRow, SettingsGroup } from '../settings/sections/shared';
import { carryLine, carrySave, defaultCarryPicks, itemsCount, planVaultCarry } from './vaultCarryPlan';

const isOld = (e: unknown): boolean => /unknown[_ ]method/i.test(errorMessage(e));
const NEEDS_UPDATE_HERE = 'AppuBot on this Mac needs a restart to do this (Settings › About).';

function Note({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'warn' | 'ok' }) {
  return (
    <div className={cn(SETTINGS_ROW, 'flex gap-2 text-copy leading-snug', tone === 'warn' ? 'text-fg' : 'text-muted')}>
      {tone === 'warn' ? <Icon icon={AlertTriangle} size={14} className="mt-0.5 shrink-0 text-attention" /> : null}
      {tone === 'ok' ? <Icon icon={CircleCheck} size={14} className="mt-0.5 shrink-0 text-success" /> : null}
      <span>{children}</span>
    </div>
  );
}

/** the other computer's client (the one on screen), by the team it belongs to */
function useThere(): () => Promise<GatewayLike> {
  const team = useCloudLink((s) => s.team);
  return useCallback(() => cloudClientReady(team ?? undefined), [team]);
}

/* ------------------------------------------------------------------ Vault */

export function VaultCarryGroup() {
  const macName = useMacName();
  const target = useThisComputer();
  const upToDate = useCloudUpToDate();
  const there = useThere();
  const cards = !useCloudLacks().vaultCards;
  const [mac, setMac] = useState<VaultItem[] | null>(null);
  const [dst, setDst] = useState<MethodResult<'vault.list'> | null>(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [brought, setBrought] = useState(0);

  const load = useCallback(async () => {
    setError('');
    try {
      const [m, d] = await Promise.all([localGateway().call('vault.list', {}), there().then((g) => g.call('vault.list', {}))]);
      setMac(m.items);
      setDst(d);
    } catch (e) {
      setError(`Couldn’t read the Vaults: ${errorMessage(e)}`);
    }
  }, [there]);
  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => (mac && dst ? planVaultCarry(mac, dst.items, { cards }) : []), [mac, dst, cards]);
  const ticks = picked ?? defaultCarryPicks(rows);
  const going = rows.filter((r) => !r.blocked && ticks.has(r.item.id));
  const toggle = (id: string) => setPicked(() => { const n = new Set(ticks); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const run = async () => {
    if (!going.length) return;
    setError('');
    setBusy({ done: 0, total: going.length });
    try {
      const src = localGateway();
      const saves = [];
      for (const row of going) {
        const secrets: Partial<Record<VaultSecretField, string>> = {};
        for (const f of VAULT_SECRETS[row.item.kind]) {
          if (row.item.secrets.includes(f)) secrets[f] = (await src.call('vault.reveal', { id: row.item.id, field: f })).value;
        }
        saves.push(carrySave(row, secrets));
      }
      await saveVaultItems(await there(), saves, (done, total) => setBusy({ done, total }));
      setBrought(going.length);
      setPicked(null);
      await load();
    } catch (e) {
      setError(isOld(e) ? NEEDS_UPDATE_HERE : `Couldn’t bring them over: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsGroup
      title={TRANSFER_VAULT_TITLE}
      description={`The logins, API keys and contact info saved in ${macName}’s Vault, saved on ${target.name} too. They go straight from this window to it, encrypted all the way, and it locks them with a key of its own that its bots can’t reach. ${macName} keeps its own.`}
    >
      {error ? <Note tone="warn">{error}</Note> : null}
      {!mac || !dst ? (error ? null : <div className={cn(SETTINGS_ROW, 'flex items-center gap-2 text-copy text-muted')}><Spinner size={13} />Reading both Vaults…</div>) : !dst.encrypted ? (
        <Note tone="warn">{unsealedVaultText(target.cap, upToDate, 'carry')}</Note>
      ) : !rows.length ? (
        <Note>Nothing is saved in {macName}’s Vault yet. To bring your browser’s saved passwords, use Import passwords in Settings › Vault.</Note>
      ) : (
        <>
          <div className="max-h-[300px] overflow-y-auto">
            {rows.map((r) => {
              const locked = !!r.blocked || !!busy;
              return (
                <label key={r.item.id} className={cn(SETTINGS_ROW, 'flex items-center gap-3', locked ? 'cursor-default' : 'cursor-pointer')}>
                  <Checkbox disabled={locked} checked={!r.blocked && ticks.has(r.item.id)} onChange={() => toggle(r.item.id)} aria-label={`Bring ${r.item.name}`} />
                  <div className={cn('min-w-0 flex-1', r.blocked && 'opacity-55')}>
                    <div className={cn(SETTINGS_ROW_TITLE, 'truncate')}>{r.item.name}</div>
                    <p className={cn(SETTINGS_ROW_DESCRIPTION, 'truncate')}>{carryLine(r.item)}</p>
                  </div>
                  <span className="shrink-0 text-note text-muted">
                    {r.blocked ?? (r.existing ? (ticks.has(r.item.id) ? `Replaces “${r.existing.name}” there` : 'Already there') : '')}
                  </span>
                </label>
              );
            })}
          </div>
          <div className={cn(SETTINGS_ROW, 'flex items-center justify-between gap-3')}>
            <span className="text-ui text-muted">
              {busy ? <span className="flex items-center gap-2"><Spinner size={13} />Sealing {busy.done} of {busy.total} there…</span>
                : brought ? <span className="flex items-center gap-2 text-fg"><Icon icon={CircleCheck} size={14} className="text-success" />{itemsCount(brought)} in {target.of} Vault now.</span>
                : `${itemsCount(going.length)} picked`}
            </span>
            <Button size="sm" variant="primary" loading={!!busy} disabled={!going.length} onClick={() => void run()}>Bring {itemsCount(going.length)}</Button>
          </div>
        </>
      )}
    </SettingsGroup>
  );
}

/* ------------------------------------------------------------------ git and GitHub */

export function GitCarryGroup() {
  const macName = useMacName();
  const target = useThisComputer();
  const there = useThere();
  const [mac, setMac] = useState<GitLocal | null>(null);
  const [dst, setDst] = useState<GitSetup | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'carry' | 'key' | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const m = await localGateway().call('github.local', {}).catch((e: unknown) => { throw new Error(isOld(e) ? NEEDS_UPDATE_HERE : errorMessage(e)); });
      const d = await there().then((g) => g.call('github.status', {})).catch((e: unknown) => { throw new Error(isOld(e) ? 'It needs an update first (Settings › Account › Manage › Update).' : errorMessage(e)); });
      setMac(m);
      setDst(d);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [there]);
  useEffect(() => { void load(); }, [load]);

  const carry = async () => {
    if (!mac) return;
    setBusy('carry');
    setError('');
    try {
      const token = mac.hasToken ? (await localGateway().call('github.localToken', {})).token : undefined;
      const g = await there();
      setDst(await g.call('github.setup', { ...(mac.name ? { name: mac.name } : {}), ...(mac.email ? { email: mac.email } : {}), ...(token ? { token } : {}) }, { timeoutMs: 60_000 }));
      pushToast({ title: token ? 'git and GitHub are set up there' : 'git is set up there', level: 'success' });
    } catch (e) {
      setError(`Couldn’t set it up there: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };
  const makeKey = async () => {
    setBusy('key');
    setError('');
    try {
      setDst(await (await there()).call('github.setup', { sshKey: true }, { timeoutMs: 60_000 }));
    } catch (e) {
      setError(`Couldn’t make a key there: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };
  const copyKey = async () => {
    if (!dst?.sshKey) return;
    try { await navigator.clipboard.writeText(dst.sshKey); pushToast({ title: 'Copied the public key', level: 'success' }); } catch { /* the key is on screen to copy by hand */ }
  };

  const who = (g: { name?: string; email?: string } | null) => (g?.name || g?.email ? [g.name, g.email && `<${g.email}>`].filter(Boolean).join(' ') : 'Not set');
  const nothing = mac && !mac.name && !mac.email && !mac.hasToken;

  return (
    <SettingsGroup
      title={TRANSFER_GIT_TITLE}
      description={`So the bots on ${target.name} can clone, commit and push as you do on ${macName}. The sign-in goes straight from this window to it; git there keeps it where its bots use it, so only bring one you’d let them use.`}
    >
      {error ? <Note tone="warn">{error}</Note> : null}
      {!mac || !dst ? (error ? null : <div className={cn(SETTINGS_ROW, 'flex items-center gap-2 text-copy text-muted')}><Spinner size={13} />Looking at git on both…</div>) : !dst.git ? (
        <Note tone="warn">git isn’t installed on {target.name}.</Note>
      ) : (
        <>
          <SettingRow title="Name and email for commits" description={`On ${macName}: ${mac.git ? who(mac) : 'git isn’t installed'}. On ${target.name}: ${who(dst)}.`} />
          <SettingRow
            title="GitHub sign-in"
            description={`On ${macName}: ${mac.hasToken ? `found (${mac.via === 'gh' ? 'the GitHub CLI' : 'git’s saved sign-in'})` : 'none found (sign in with gh auth login, then come back)'}. On ${target.name}: ${dst.login ? `signed in as ${dst.login}` : 'not signed in'}.`}
          >
            <Button size="sm" variant="primary" loading={busy === 'carry'} disabled={!!busy || !!nothing} onClick={() => void carry()}>
              {dst.login || dst.name ? 'Bring again' : 'Bring over'}
            </Button>
          </SettingRow>
          <SettingRow
            title="An SSH key of its own"
            description={dst.sshKey
              ? 'Its public half, to add wherever it should be trusted. GitHub itself already works through the sign-in above.'
              : `Your private SSH key stays on ${macName}. For servers and other git hosts, ${target.name} can make a key of its own that you add there.`}
          >
            {dst.sshKey ? <Button size="sm" variant="ghost" icon={Copy} onClick={() => void copyKey()}>Copy</Button> : <Button size="sm" variant="ghost" loading={busy === 'key'} disabled={!!busy} onClick={() => void makeKey()}>Make a key</Button>}
          </SettingRow>
          {dst.sshKey ? <div className={cn(SETTINGS_ROW, 'selectable break-all font-mono text-note leading-snug text-muted')}>{dst.sshKey}</div> : null}
        </>
      )}
    </SettingsGroup>
  );
}

/* ------------------------------------------------------------------ files on this Mac */

const tilde = (path: string): string => path.replace(/^\/Users\/[^/]+(?=\/|$)/, '~').replace(/^\/home\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~');

export function MacFilesGroup() {
  const macName = useMacName();
  const target = useThisComputer();
  const there = useThere();
  const team = useCloudLink((s) => s.team);
  const [mac, setMac] = useState<MacLinkStatus | null>(null);
  const [dst, setDst] = useState<MacFilesStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const m = await localGateway().call('macLink.status', {}).catch((e: unknown) => { throw new Error(isOld(e) ? NEEDS_UPDATE_HERE : errorMessage(e)); });
      const d = await there().then((g) => g.call('macFiles.status', {})).catch((e: unknown) => { throw new Error(isOld(e) ? 'It needs an update first (Settings › Account › Manage › Update).' : errorMessage(e)); });
      setMac(m);
      setDst(d);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [there]);
  useEffect(() => { if (!team) void load(); }, [load, team]);

  // one person's files for a whole team's bots is nobody's intent
  if (team) return null;

  const link = mac && dst?.linked ? mac.links.find((l) => l.id === dst.linked!.linkId) : undefined;
  const on = !!link;
  // links this Mac gave that the computer on screen doesn't hold (given before, or to another computer)
  const others = mac?.links.filter((l) => l.id !== link?.id) ?? [];

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setChecked(null);
    try { await fn(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); void load(); }
  };
  const turnOn = () => act(async () => {
    const src = localGateway();
    const grant = await src.call('macLink.create', { name: target.cap });
    try {
      await (await there()).call('macFiles.link', { linkId: grant.id, token: grant.token, connectId: grant.connectId, connectKey: grant.connectKey, name: macName });
    } catch (e) {
      // the other computer didn't take it: nothing is left holding a token here
      await src.call('macLink.revoke', { id: grant.id }).catch(() => undefined);
      throw new Error(`${target.cap} couldn’t be linked: ${errorMessage(e)}`);
    }
  });
  const turnOff = () => act(async () => {
    await (await there()).call('macFiles.unlink', {}).catch(() => undefined);
    if (link) await localGateway().call('macLink.revoke', { id: link.id });
  });
  const setFolders = (folders: string[]) => act(async () => { setMac(await localGateway().call('macLink.setFolders', { folders })); });
  const setWritable = (folder: string, v: boolean) => act(async () => { setMac(await localGateway().call('macLink.setWritable', { folder, on: v })); });
  const addFolders = async () => {
    const picked = await native().pickFiles({ directories: true, multiple: true }).catch(() => [] as string[]);
    if (picked.length && mac) await setFolders([...mac.folders, ...picked]);
  };
  const check = async () => {
    setBusy(true);
    setChecked(null);
    try {
      const r = await (await there()).call('macFiles.check', {}, { timeoutMs: 45_000 });
      const saves = r.folders?.filter((f) => f.writable).length ?? 0;
      setChecked(r.ok ? { ok: true, text: `${target.cap} reached ${macName} and sees ${r.folders?.length ?? 0} folder${r.folders?.length === 1 ? '' : 's'}${saves ? `, ${saves} taking its bots’ changes` : ''}.` } : { ok: false, text: r.error ?? 'It couldn’t reach this Mac.' });
    } catch (e) {
      setChecked({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup
      title={TRANSFER_FILES_TITLE}
      description={`Let the bots on ${target.name} use the folders you pick on ${macName}, so your files don’t have to move. They can always look and copy a file over to work on. They can save changes only in a folder you switch on, and a file they replace goes to the Trash first. Nothing here is ever deleted, and they reach it only while ${macName} is on with AppuBot open.`}
    >
      {error ? <Note tone="warn">{error}</Note> : null}
      {!mac || !dst ? (error ? null : <div className={cn(SETTINGS_ROW, 'flex items-center gap-2 text-copy text-muted')}><Spinner size={13} />Checking…</div>) : (
        <>
          <SettingRow title={`Let its bots read files on ${macName}`} description={on ? `On. ${link?.lastUsedAt ? `Last read ${new Date(link.lastUsedAt).toLocaleString()}.` : 'Nothing read yet.'}${link?.lastSavedAt ? ` Last saved ${link.lastSavedName ?? 'a file'} ${new Date(link.lastSavedAt).toLocaleString()}.` : ''}` : 'Off: its bots can’t see anything on this Mac.'}>
            <Switch checked={on} disabled={busy} onChange={(v) => void (v ? turnOn() : turnOff())} label={`Let its bots read files on ${macName}`} />
          </SettingRow>
          {mac.folders.length ? mac.folders.map((f) => (
            <div key={f} className={cn(SETTINGS_ROW, 'flex items-center gap-3')}>
              <Icon icon={FolderOpen} size={15} className="shrink-0 text-muted" />
              <span className="selectable min-w-0 flex-1 truncate text-copy text-fg" title={f}>{tilde(f)}</span>
              {mac.writable ? (
                <span className="flex shrink-0 items-center gap-2 text-ui text-muted">
                  Bots can save changes here
                  <Switch checked={mac.writable.includes(f)} disabled={busy} onChange={(v) => void setWritable(f, v)} label={`Bots can save changes in ${tilde(f)}`} />
                </span>
              ) : null}
              <Button size="icon-sm" variant="ghost" icon={X} aria-label={`Stop lending ${tilde(f)}`} disabled={busy} onClick={() => void setFolders(mac.folders.filter((x) => x !== f))} />
            </div>
          )) : <Note>No folders picked yet{on ? ': its bots see nothing until you add one' : ''}.</Note>}
          <div className={cn(SETTINGS_ROW, 'flex flex-wrap items-center justify-between gap-3')}>
            <span className="text-note leading-snug text-muted">Folders that hold sign-ins or keys (like ~/.ssh and the Keychains) are never lent, whatever you pick.</span>
            <span className="flex shrink-0 gap-2">
              {on ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void check()}>Check now</Button> : null}
              <Button size="sm" variant="ghost" icon={FolderOpen} disabled={busy} onClick={() => void addFolders()}>Add folder…</Button>
            </span>
          </div>
          {on && mac.blocked ? <Note tone="warn">{mac.blocked}</Note> : null}
          {checked ? <Note tone={checked.ok ? 'ok' : 'warn'}>{checked.text}</Note> : null}
          {others.map((l) => (
            <div key={l.id} className={cn(SETTINGS_ROW, 'flex items-center justify-between gap-3')}>
              <span className="min-w-0 text-ui text-muted">Also lent to “{l.name}” since {new Date(l.createdAt).toLocaleDateString()}.</span>
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => void act(async () => { await localGateway().call('macLink.revoke', { id: l.id }); })}>Remove</Button>
            </div>
          ))}
        </>
      )}
    </SettingsGroup>
  );
}
