/**
 * Which AppuBot versions still work: `version-policy.json` in the public releases repo (written by `pnpm
 * version-policy`, scripts/version-policy.mjs). The top-level rules are the desktop's (core/services/appUpdate.ts: a
 * stopped computer refuses everything but updating); `phone` holds the phone app's own rules, which the phone reads
 * for itself (the phone app: a stopped phone shows only its app store) and every computer applies to
 * the phones that connect to it (the gateway's hello and `/api/pair`), so a phone from before it read the policy is
 * stopped too. Versions compare with `compareVersions` (dates: 2026.1107.2).
 */
import { compareVersions } from './whatsNew';

export interface VersionRules {
  /** versions below it are stopped */
  minVersion?: string;
  /** these versions are stopped */
  blocked?: string[];
  /** what a stopped version says, else the default */
  message?: string;
}

export interface VersionPolicy extends VersionRules {
  /** the phone app's rules; absent: every phone works */
  phone?: VersionRules;
}

export const VERSION_POLICY_URL = 'https://raw.githubusercontent.com/sarthakguptadev/appubot/main/version-policy.json';

export const STOPPED_MESSAGE = 'This version of AppuBot has stopped working. Update to keep using it.';

/** `os`: where the phone gets its update; unknown names both stores */
export function phoneStoppedMessage(os?: 'ios' | 'android' | string): string {
  const store = os === 'ios' ? 'the App Store' : os === 'android' ? 'Google Play' : 'the App Store or Google Play';
  return `This version of the AppuBot app has stopped working. Update it from ${store} to keep using it.`;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function rulesOf(raw: unknown): VersionRules {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const minVersion = str(r.minVersion);
  const blocked = Array.isArray(r.blocked) ? r.blocked.map(str).filter((v): v is string => !!v) : undefined;
  const message = str(r.message);
  return { ...(minVersion ? { minVersion } : {}), ...(blocked?.length ? { blocked } : {}), ...(message ? { message } : {}) };
}

/** Reads a policy file's JSON leniently: unknown keys and odd values are dropped, never a throw. */
export function parseVersionPolicy(raw: unknown): VersionPolicy {
  const top = rulesOf(raw);
  const phone = raw && typeof raw === 'object' && 'phone' in raw ? rulesOf((raw as { phone?: unknown }).phone) : {};
  return { ...top, ...(Object.keys(phone).length ? { phone } : {}) };
}

/** What `version` must show under `rules`, or null while it keeps working. */
export function stoppedBy(rules: VersionRules, version: string, fallback = STOPPED_MESSAGE): string | null {
  const below = !!rules.minVersion && compareVersions(version, rules.minVersion) < 0;
  const listed = !!rules.blocked?.some((v) => compareVersions(v, version) === 0);
  return below || listed ? rules.message?.trim() || fallback : null;
}

/** The phone app at `version` on `os`: its stop message, or null while it works (no version known: it works). */
export function phoneStoppedBy(policy: VersionPolicy, version: string | undefined, os?: string): string | null {
  if (!policy.phone || !version) return null;
  return stoppedBy(policy.phone, version, phoneStoppedMessage(os));
}
