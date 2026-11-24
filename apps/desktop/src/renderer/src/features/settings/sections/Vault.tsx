import { useCallback, useEffect, useState } from 'react';
import { VAULT_SECRETS, cardBrand, type MethodParams, type VaultContact, type VaultItem, type VaultKind, type VaultSecretField } from '@appubot/protocol';
import { ChevronDown, Contact, CreditCard, Eye, EyeOff, KeyRound, LockKeyhole, type LucideIcon } from '../../../components/ui/icons';
import { Button, Dialog, Field, Icon, Input, Menu, Textarea, cn } from '../../../components/ui';
import { SEGMENT, SEGMENT_SIZE, SEGMENT_TRACK, SegmentChip } from '../../../components/ui/Tabs';
import { call } from '../../../lib/actions';
import { useCloudUpToDate, useThisComputer } from '../../cloud/thisComputer';
import { VAULT_TITLE } from '../nav';
import { useCloudLacks } from '../../cloud/useCloudLacks';
import { ImportPasswordsDialog } from '../../vault/ImportPasswordsDialog';
import { unsealedVaultText } from '../../vault/unsealedText';
import { DeleteButton } from '../../../components/rare/DeleteButton';
import { SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE, SettingsCard, SettingsEmptyState, SettingsGroup, SectionLoading } from './shared';

/*
 * Settings › Vault: logins, cards, contact info and API keys every bot can use without seeing the secrets (core
 * `VaultService`: AppuBot types passwords and card details into the window itself, API keys go to a private file the
 * bot reads). The list filters by kind; an item opens in its editor, where a saved secret only shows on request.
 */

const KINDS: { kind: VaultKind; label: string; one: string; icon: LucideIcon }[] = [
  { kind: 'login', label: 'Logins', one: 'Login', icon: LockKeyhole },
  { kind: 'card', label: 'Cards', one: 'Card', icon: CreditCard },
  { kind: 'contact', label: 'Contact info', one: 'Contact info', icon: Contact },
  { kind: 'apiKey', label: 'API keys', one: 'API key', icon: KeyRound },
];
const kindOf = (k: VaultKind) => KINDS.find((x) => x.kind === k)!;

/** The line under an item's name: what it's for, never a secret. */
function itemLine(i: VaultItem): string {
  const c = i.contact;
  const parts = i.kind === 'login' ? [i.site, i.username]
    : i.kind === 'card' ? [i.brand, i.hint && `ending ${i.hint}`, i.expiry && `expires ${i.expiry}`]
    : i.kind === 'apiKey' ? [i.envName, i.hint && `…${i.hint}`]
    : [c?.email, c?.phone, [c?.city, c?.country].filter(Boolean).join(', ')];
  return parts.filter(Boolean).join(' · ') || kindOf(i.kind).one;
}

function ItemRow({ item, onOpen, onRemove }: { item: VaultItem; onOpen: () => void; onRemove: () => void }) {
  return (
    <div className={cn(SETTINGS_ROW, 'group flex items-center gap-3')}>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none">
        <span className="squircle flex size-[34px] shrink-0 items-center justify-center rounded-control bg-surface-2 text-fg-2">
          <Icon icon={kindOf(item.kind).icon} size={16} />
        </span>
        <span className="min-w-0">
          <span className={cn('block truncate', SETTINGS_ROW_TITLE)}>{item.name}</span>
          <span className={cn('mt-0.5 block truncate', SETTINGS_ROW_DESCRIPTION)}>{itemLine(item)}</span>
        </span>
      </button>
      <Button size="xs" variant="ghost" onClick={onOpen}>Edit</Button>
      <DeleteButton label={`Remove ${item.name}`} onConfirm={onRemove} />
    </div>
  );
}

type Filter = VaultKind | 'all';

export function VaultSection() {
  const [items, setItems] = useState<VaultItem[] | null>(null);
  const [encrypted, setEncrypted] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState<{ kind: VaultKind; item?: VaultItem } | null>(null);
  const [importing, setImporting] = useState(false);
  // payment cards stay off the cloud computer (plan §4.2, D10): its Vault has the other kinds
  const kinds = useCloudLacks().vaultCards ? KINDS.filter((k) => k.kind !== 'card') : KINDS;
  const computer = useThisComputer();
  const upToDate = useCloudUpToDate();
  // an AppuBot computer from before it had a key of its own (cloud-gateway `secretBox.ts`)
  const unsealedRemote = computer.remote && !encrypted;

  const load = useCallback(async () => {
    const r = await call('vault.list', {}, { errorTitle: 'Could not read the Vault' });
    if (r) { setItems(r.items); setEncrypted(r.encrypted); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // asked in place by the row's own bin (Rare UI's delete button): no dialog
  const remove = async (i: VaultItem) => {
    if (await call('vault.delete', { id: i.id }, { errorTitle: `Could not remove ${i.name}`, success: `Removed ${i.name}` })) await load();
  };

  const count = (k: Filter) => (items ?? []).filter((i) => k === 'all' || i.kind === k).length;
  const shown = (items ?? []).filter((i) => filter === 'all' || i.kind === filter).sort((a, b) => a.name.localeCompare(b.name));
  const tabs: { id: Filter; label: string }[] = [{ id: 'all', label: 'All' }, ...kinds.map((k) => ({ id: k.kind, label: k.label }))];

  return (
    <div>
      <SettingsGroup
        bare
        title={VAULT_TITLE}
        description="Every bot can use these items. AppuBot types passwords, card numbers and security codes into the app itself, so bots never see them. Bots read API keys from a private file, not from the chat. Each item asks for your Allow the first time a chat uses it."
        action={(
          <span className="flex items-center gap-2">
            {/* on a remote computer whose Vault can't seal yet, a file of passwords stays out (one typed in is the person's call) */}
            {items && !unsealedRemote ? <Button size="sm" variant="ghost" onClick={() => setImporting(true)}>Import passwords</Button> : null}
            <Menu
              align="end"
              trigger={(t) => <Button size="sm" variant="accent" iconRight={ChevronDown} {...t}>New item</Button>}
              items={kinds.map((k) => ({ label: k.one, icon: k.icon, onSelect: () => setEditing({ kind: k.kind }) }))}
            />
          </span>
        )}
      >
        <div className="flex flex-col gap-3">
          <div role="tablist" aria-label="Show" className={cn(SEGMENT_TRACK, 'w-fit flex-wrap')}>
            {tabs.map((t) => (
              <button
                key={t.id} type="button" role="tab" aria-selected={filter === t.id} onClick={() => setFilter(t.id)}
                className={cn(SEGMENT, SEGMENT_SIZE.md, filter === t.id ? 'text-fg' : 'text-muted hover:text-fg')}
              >
                {filter === t.id ? <SegmentChip /> : null}
                <span className="relative inline-flex items-center gap-2">{t.label}<span className="font-medium tabular-nums text-muted">{count(t.id)}</span></span>
              </button>
            ))}
          </div>
          {!items ? <SectionLoading /> : shown.length ? (
            <SettingsCard>{shown.map((i) => <ItemRow key={i.id} item={i} onOpen={() => setEditing({ kind: i.kind, item: i })} onRemove={() => void remove(i)} />)}</SettingsCard>
          ) : (
            <SettingsEmptyState>
              {items.length ? `No ${kindOf(filter as VaultKind).label.toLowerCase()} saved yet.` : 'Nothing saved yet. Add a login, card, contact info or API key with New item.'}
            </SettingsEmptyState>
          )}
          {!encrypted ? (
            <p className="px-1 text-note leading-normal text-muted">
              {unsealedRemote
                ? unsealedVaultText(computer.cap, upToDate, 'page')
                : `${computer.cap} has no keychain AppuBot can use, so secrets are kept in a file only your account can read rather than encrypted.`}
            </p>
          ) : null}
        </div>
      </SettingsGroup>
      {editing ? <ItemDialog kind={editing.kind} item={editing.item} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} /> : null}
      {importing && items ? <ImportPasswordsDialog items={items} where={computer.name} onClose={() => setImporting(false)} onDone={() => { setImporting(false); void load(); }} /> : null}
    </div>
  );
}

/** A secret field: empty means "keep what's saved"; Show fetches the saved one into it. */
function SecretInput({ item, field, value, onChange, placeholder, mono = true }: {
  item?: VaultItem; field: VaultSecretField; value: string | undefined; onChange: (v: string) => void; placeholder?: string; mono?: boolean;
}) {
  const [shown, setShown] = useState(false);
  const saved = !!item?.secrets.includes(field);
  const toggle = async () => {
    if (!shown && value === undefined && saved && item) {
      const r = await call('vault.reveal', { id: item.id, field }, { errorTitle: 'Could not show it' });
      if (!r) return;
      onChange(r.value);
    }
    setShown((v) => !v);
  };
  return (
    <div className="relative">
      <Input
        type={shown ? 'text' : 'password'} autoComplete="off" spellCheck={false}
        value={value ?? ''} onChange={(e) => onChange(e.target.value)}
        placeholder={saved && value === undefined ? 'Saved: type a new one to replace it' : placeholder}
        className={cn('pr-9', mono && 'font-mono text-copy')}
      />
      {saved || value ? (
        <button type="button" onClick={() => void toggle()} aria-label={shown ? 'Hide' : 'Show'} title={shown ? 'Hide' : 'Show'} className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg">
          <Icon icon={shown ? EyeOff : Eye} size={14} />
        </button>
      ) : null}
    </div>
  );
}

const CONTACT_FIELDS: { key: keyof VaultContact; label: string; half?: boolean; type?: string }[] = [
  { key: 'fullName', label: 'Full name' },
  { key: 'email', label: 'Email', half: true, type: 'email' },
  { key: 'phone', label: 'Phone', half: true, type: 'tel' },
  { key: 'company', label: 'Company' },
  { key: 'address1', label: 'Address' },
  { key: 'address2', label: 'Address line 2' },
  { key: 'city', label: 'City', half: true },
  { key: 'region', label: 'State or region', half: true },
  { key: 'postalCode', label: 'Postal code', half: true },
  { key: 'country', label: 'Country', half: true },
];

const EMPTY_CONTACT: VaultContact = { fullName: '', email: '', phone: '', company: '', address1: '', address2: '', city: '', region: '', postalCode: '', country: '' };

function ItemDialog({ kind, item, onClose, onSaved }: { kind: VaultKind; item?: VaultItem; onClose: () => void; onSaved: () => void }) {
  const k = kindOf(kind);
  const [name, setName] = useState(item?.name ?? '');
  const [site, setSite] = useState(item?.site ?? '');
  const [username, setUsername] = useState(item?.username ?? '');
  const [cardholder, setCardholder] = useState(item?.cardholder ?? '');
  const [expiry, setExpiry] = useState(item?.expiry ?? '');
  const [envName, setEnvName] = useState(item?.envName ?? '');
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [contact, setContact] = useState<VaultContact>({ ...EMPTY_CONTACT, ...item?.contact });
  // undefined: keep what's saved
  const [secrets, setSecrets] = useState<Partial<Record<VaultSecretField, string>>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const setSecret = (f: VaultSecretField) => (v: string) => setSecrets((s) => ({ ...s, [f]: v }));
  const brand = secrets.number ? cardBrand(secrets.number) : item?.brand;

  const save = async () => {
    if (!name.trim()) return setError('Give it a name.');
    const missing = VAULT_SECRETS[kind].filter((f) => f !== 'cvc' && !item?.secrets.includes(f) && !secrets[f]?.trim());
    if (missing.length) return setError(kind === 'login' ? 'Enter the password.' : kind === 'card' ? 'Enter the card number.' : 'Enter the key.');
    setBusy(true);
    setError(undefined);
    const params: MethodParams<'vault.save'> = {
      id: item?.id, kind, name: name.trim(), notes: notes.trim() || undefined,
      ...(kind === 'login' ? { site: site.trim() || undefined, username: username.trim() || undefined } : {}),
      ...(kind === 'card' ? { cardholder: cardholder.trim() || undefined, expiry: expiry.trim() || undefined } : {}),
      ...(kind === 'contact' ? { contact } : {}),
      ...(kind === 'apiKey' ? { envName: envName.trim() } : {}),
      secrets: Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== undefined)),
    };
    const r = await call('vault.save', params, { errorTitle: `Could not save ${name.trim()}`, success: item ? `Saved ${name.trim()}` : `Added ${name.trim()}` });
    setBusy(false);
    if (r) onSaved();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={
        <span className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-control-lg bg-accent-soft text-accent-strong"><Icon icon={k.icon} size={18} /></span>
          {item ? item.name : `New ${k.one.toLowerCase()}`}
        </span>
      }
      description={kind === 'contact' ? 'Bots may read contact info to fill in forms and write addresses.' : kind === 'apiKey' ? 'Bots get it in a private file they load from, never in the chat.' : 'Bots never see it: AppuBot types it into the app for them.'}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>{item ? 'Save' : 'Add'}</Button>
        </>
      )}
    >
      <form className="flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Name" hint="How you and your bots tell it apart.">
          <Input
            value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus
            placeholder={kind === 'login' ? 'GitHub' : kind === 'card' ? 'Work card' : kind === 'contact' ? 'Home' : 'OpenAI'}
          />
        </Field>
        {kind === 'login' ? (
          <>
            <Field label="Website or app"><Input value={site} onChange={(e) => setSite(e.target.value)} placeholder="github.com" spellCheck={false} /></Field>
            <Field label="Username or email"><Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} /></Field>
            <Field label="Password"><SecretInput item={item} field="password" value={secrets.password} onChange={setSecret('password')} /></Field>
          </>
        ) : null}
        {kind === 'card' ? (
          <>
            <Field label="Card number" hint={brand ? brand : undefined}>
              <SecretInput item={item} field="number" value={secrets.number} onChange={setSecret('number')} placeholder="1234 5678 9012 3456" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Expiry"><Input value={expiry} onChange={(e) => setExpiry(e.target.value)} placeholder="MM/YY" maxLength={5} className="font-mono text-copy" /></Field>
              <Field label="Security code"><SecretInput item={item} field="cvc" value={secrets.cvc} onChange={setSecret('cvc')} placeholder="CVC" /></Field>
            </div>
            <Field label="Name on card"><Input value={cardholder} onChange={(e) => setCardholder(e.target.value)} /></Field>
          </>
        ) : null}
        {kind === 'contact' ? (
          <div className="grid grid-cols-2 gap-3">
            {CONTACT_FIELDS.map((f) => (
              <Field key={f.key} label={f.label} className={f.half ? undefined : 'col-span-2'}>
                <Input type={f.type} value={contact[f.key]} onChange={(e) => setContact((c) => ({ ...c, [f.key]: e.target.value }))} />
              </Field>
            ))}
          </div>
        ) : null}
        {kind === 'apiKey' ? (
          <>
            <Field label="Variable name" hint="The environment variable programs read it from.">
              <Input value={envName} onChange={(e) => setEnvName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))} placeholder="OPENAI_API_KEY" spellCheck={false} className="font-mono text-copy" />
            </Field>
            <Field label="Key"><SecretInput item={item} field="key" value={secrets.key} onChange={setSecret('key')} placeholder="sk-…" /></Field>
          </>
        ) : null}
        <Field label="Notes (optional)" hint="Bots can read these: never put a secret here.">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} minRows={2} maxLength={1000} />
        </Field>
        {error ? <p className="selectable text-ui leading-snug text-danger">{error}</p> : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
