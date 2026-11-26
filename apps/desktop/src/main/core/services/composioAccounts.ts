/**
 * Several accounts of one app (two Gmails, a work and a personal calendar). Composio keeps every account the user
 * connects, and a call that names none goes to the one it picks itself: the newest, which is how a second Gmail
 * seemed to replace the first. So for an app with several working accounts AppuBot names the account on every call:
 * the one the bot asked for (by its address, name or id), or the user's default. An app with one account is left as
 * it was: nothing is named, and whatever the bot wrote goes through.
 */
import type { AppConnection } from '@appubot/protocol';

/** What Composio says of a call that names no account for an app with several (it then runs nothing). */
export const NEEDS_ACCOUNT = /multiple \w+ accounts connected/i;

/** Who an account is at the app, from what the app told Composio (`user_info`): its address, else a name. */
export function accountLabel(info: unknown): string | undefined {
  if (!info || typeof info !== 'object') return undefined;
  const i = info as Record<string, unknown>;
  for (const k of ['email', 'emailAddress', 'email_address', 'username', 'login', 'name', 'display_name', 'team_name', 'workspace_name', 'team']) {
    const v = i[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 120);
  }
  return undefined;
}

/** The accounts that work. */
export function workingAccounts(accounts: readonly AppConnection[] | undefined): AppConnection[] {
  return (accounts ?? []).filter((a) => a.status === 'ACTIVE');
}

/**
 * The account an app's calls use when the bot names none: the one the user chose (`chosen`, an account id), else the
 * one Composio calls its default, else the first. Only a working account can be it.
 */
export function defaultAccount(accounts: readonly AppConnection[] | undefined, chosen?: string): AppConnection | undefined {
  const working = workingAccounts(accounts);
  return working.find((a) => a.connectedAccountId === chosen) ?? working.find((a) => a.isDefault) ?? working[0];
}

/** What each account is called, by id: who it is, else the name it was given, else its id; two called the same get their ids too. */
export function accountNames(accounts: readonly AppConnection[]): Map<string, string> {
  const plain = (a: AppConnection) => a.label ?? a.alias ?? a.connectedAccountId;
  const seen = new Map<string, number>();
  for (const a of accounts) seen.set(plain(a).toLowerCase(), (seen.get(plain(a).toLowerCase()) ?? 0) + 1);
  return new Map(accounts.map((a) => [a.connectedAccountId, seen.get(plain(a).toLowerCase())! > 1 ? `${plain(a)} [${a.connectedAccountId}]` : plain(a)]));
}

/** The account a bot meant by `said`: its id, or its address or name when only one account has that. */
export function pickAccount(accounts: readonly AppConnection[], said: string): AppConnection | undefined {
  const s = said.trim().toLowerCase();
  // as `accountNames` writes two that are called the same: "name [id]"
  const id = /\[([^\]]+)\]$/.exec(s)?.[1] ?? s;
  const byId = accounts.find((a) => a.connectedAccountId.toLowerCase() === id);
  if (byId) return byId;
  const alike = accounts.filter((a) => a.label?.toLowerCase() === s || a.alias?.toLowerCase() === s);
  return alike.length === 1 ? alike[0] : undefined;
}

/** An app's accounts in words for a bot: "Gmail has 2 accounts: a@x.com (the default) and b@y.com". */
export function accountsText(name: string, accounts: readonly AppConnection[], chosen?: string): string {
  const working = workingAccounts(accounts);
  const names = accountNames(working);
  const first = defaultAccount(working, chosen);
  const list = working.map((a) => `${names.get(a.connectedAccountId)}${a === first ? ' (the default)' : ''}`);
  return `${name} has ${working.length} accounts: ${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}
