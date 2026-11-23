/**
 * This Mac's Vault carried to the AppuBot computer on screen (Settings › Transfer): which items go, and what each
 * becomes there. Pure; the page (`VaultCarry.tsx`) reads both Vaults, has this Mac open each picked item's secrets
 * (`vault.reveal`, the Mac's own window only) and saves them on the other computer through its end-to-end channel
 * (`vault.saveMany`), where they are sealed with that computer's own key. Nothing passes through AppuBot's servers
 * in a form they could read, and nothing is written to disk on the way.
 *
 * An item the other Vault already has (a login for the same site and username, a key with the same variable name,
 * contact info of the same name) starts unticked; ticked, it replaces that one's fields and secrets.
 */
import { VAULT_SECRETS, type VaultItem, type VaultKind, type VaultSecretField } from '@appubot/protocol';
import type { VaultSave } from '../vault/vaultCarry';

export interface CarryRow {
  item: VaultItem;
  /** the item there it stands for, if any */
  existing?: VaultItem;
  /** why it can't go (a payment card: the cloud computer keeps none) */
  blocked?: string;
}

const norm = (v: string | undefined) => (v ?? '').trim().toLowerCase();
const site = (v: string | undefined) => norm(v).replace(/^www\./, '');

/** what makes two items the same thing on two computers; '' when nothing does (it never matches) */
export function carryKey(i: Pick<VaultItem, 'kind' | 'name' | 'site' | 'username' | 'envName'>): string {
  switch (i.kind) {
    case 'login': return site(i.site) || norm(i.username) ? `login\n${site(i.site)}\n${norm(i.username)}` : `login-name\n${norm(i.name)}`;
    case 'apiKey': return `key\n${(i.envName ?? '').trim()}`;
    case 'contact': return `contact\n${norm(i.name)}`;
    case 'card': return '';
  }
}

export const CARDS_STAY = 'Payment cards stay on this Mac.';

/** Every item of this Mac's Vault against the other computer's, in the Vault's own order (by name). */
export function planVaultCarry(mac: readonly VaultItem[], there: readonly VaultItem[], o: { cards?: boolean } = {}): CarryRow[] {
  const have = new Map<string, VaultItem>();
  for (const i of there) {
    const k = carryKey(i);
    if (k && !have.has(k)) have.set(k, i);
  }
  return [...mac].sort((a, b) => a.name.localeCompare(b.name)).map((item) => {
    if (item.kind === 'card' && !o.cards) return { item, blocked: CARDS_STAY };
    const k = carryKey(item);
    const existing = k ? have.get(k) : undefined;
    return existing ? { item, existing } : { item };
  });
}

/** the rows ticked to begin with: what can go and isn't there yet */
export function defaultCarryPicks(rows: readonly CarryRow[]): Set<string> {
  return new Set(rows.filter((r) => !r.blocked && !r.existing).map((r) => r.item.id));
}

/** What a row is saved as on the other computer, with its secrets as this Mac revealed them. */
export function carrySave(row: CarryRow, secrets: Partial<Record<VaultSecretField, string>>): VaultSave {
  const i = row.item;
  const kind: VaultKind = i.kind;
  const kept = Object.fromEntries(VAULT_SECRETS[kind].filter((f) => secrets[f]).map((f) => [f, secrets[f]!]));
  return {
    ...(row.existing ? { id: row.existing.id } : {}),
    kind, name: i.name,
    ...(i.site !== undefined ? { site: i.site } : {}),
    ...(i.username !== undefined ? { username: i.username } : {}),
    ...(i.cardholder !== undefined ? { cardholder: i.cardholder } : {}),
    ...(i.expiry !== undefined ? { expiry: i.expiry } : {}),
    ...(i.contact ? { contact: i.contact } : {}),
    ...(i.envName !== undefined ? { envName: i.envName } : {}),
    ...(i.notes !== undefined ? { notes: i.notes } : {}),
    ...(Object.keys(kept).length ? { secrets: kept } : {}),
  };
}

const KIND_WORD: Record<VaultKind, string> = { login: 'Login', card: 'Card', contact: 'Contact info', apiKey: 'API key' };

/** the line under an item's name (never a secret) */
export function carryLine(i: VaultItem): string {
  const parts = i.kind === 'login' ? [i.site, i.username]
    : i.kind === 'card' ? [i.brand, i.hint && `ending ${i.hint}`]
    : i.kind === 'apiKey' ? [i.envName]
    : [i.contact?.email, i.contact?.city];
  return [KIND_WORD[i.kind], ...parts].filter(Boolean).join(' · ');
}

export const itemsCount = (n: number): string => `${n} ${n === 1 ? 'item' : 'items'}`;
