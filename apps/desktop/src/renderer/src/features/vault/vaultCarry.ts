/**
 * Saving many Vault items on one computer (a password file brought in, this Mac's Vault carried to an AppuBot
 * computer): `vault.saveMany` in runs of `VAULT_SAVE_MANY_MAX`, each run all or nothing, so a file of hundreds is a
 * few calls rather than a round trip each. A computer from before `vault.saveMany` gets them one `vault.save` at a time.
 */
import { VAULT_SAVE_MANY_MAX, type MethodParams, type VaultItem } from '@appubot/protocol';
import { GatewayError, type GatewayLike } from '../../lib/gateway';

export type VaultSave = MethodParams<'vault.save'>;

const isUnknownMethod = (e: unknown): boolean =>
  (e instanceof GatewayError && e.code === 'unknown_method') || /unknown[_ ]method/i.test(e instanceof Error ? e.message : '');

/** Saves `items` on `g`'s computer in order; `onProgress` hears how many are in. Throws what the computer refused. */
export async function saveVaultItems(g: GatewayLike, items: readonly VaultSave[], onProgress?: (done: number, total: number) => void): Promise<VaultItem[]> {
  const out: VaultItem[] = [];
  let oneByOne = false;
  for (let i = 0; i < items.length; i += VAULT_SAVE_MANY_MAX) {
    const run = items.slice(i, i + VAULT_SAVE_MANY_MAX);
    if (!oneByOne) {
      try {
        out.push(...(await g.call('vault.saveMany', { items: run }, { timeoutMs: 120_000 })).items);
        onProgress?.(out.length, items.length);
        continue;
      } catch (e) {
        if (!isUnknownMethod(e)) throw e;
        oneByOne = true;
      }
    }
    for (const item of run) {
      out.push(await g.call('vault.save', item));
      onProgress?.(out.length, items.length);
    }
  }
  return out;
}
