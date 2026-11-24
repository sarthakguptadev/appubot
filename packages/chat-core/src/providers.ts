/**
 * Coding agents (providers) as both clients show them: each built-in's brand mark (SVG path data; the desktop draws it
 * with <svg>, the phone with react-native-svg) and how its install and login status reads.
 *
 * Marks: Claude's starburst keeps Anthropic's clay; the others are monochrome and drawn in the text colour, so they
 * flip with the theme. Paths from Synara's Icons.tsx (MIT) and Simple Icons (CC0).
 */
import { FREE_MODELS_ACCOUNT, PROMO_AGENT_NAME, PROMO_PROFILE_NAME, providerBase, type Provider } from '@appubot/protocol';

export interface ProviderMarkPath {
  d: string;
  evenOdd?: boolean;
  /** monochrome marks: drawn in the text colour at this opacity (default 1) */
  opacity?: number;
}

export interface ProviderMark {
  viewBox: string;
  /** a fixed brand colour; absent: the text colour */
  color?: string;
  paths: ProviderMarkPath[];
}

const CLAUDE =
  'm50.23 170.32 50.36-28.26.843-2.46-.843-1.36h-2.46l-8.43-.518-28.77-.778-24.95-1.04-24.18-1.3-6.09-1.3L0 125.8l.583-3.76 5.12-3.43 7.32.648 16.2 1.1 24.3 1.69 17.63 1.04 26.12 2.72h4.15l.583-1.69-1.43-1.04-1.1-1.04-25.15-17.05-27.22-18.02-14.26-10.37-7.71-5.25-3.89-4.92-1.69-10.76 7-7.71 9.4.649 2.4.648 9.53 7.32 20.35 15.75L94.82 91.9l3.89 3.24 1.55-1.1.195-.777-1.75-2.92-14.45-26.12-15.43-26.57-6.87-11.02-1.81-6.61c-.648-2.72-1.1-4.99-1.1-7.78l7.97-10.82L71.42 0 82.05 1.43l4.47 3.89 6.61 15.1 10.69 23.79 16.59 32.34 4.86 9.59 2.59 8.88.973 2.72h1.69v-1.56l1.36-18.21 2.53-22.36 2.46-28.78.843-8.1 4.02-9.72 7.97-5.25 6.22 2.98 5.12 7.32-.713 4.73-3.05 19.77-5.96 30.98-3.89 20.74h2.27l2.59-2.59 10.5-13.93 17.63-22.04 7.78-8.75 9.07-9.66 5.83-4.6h11.02l8.1 12.05-3.63 12.44-11.34 14.39-9.4 12.18-13.48 18.15-8.43 14.52.778 1.17 2.01-.194 30.46-6.48 16.46-2.98 19.64-3.37 8.88 4.15.971 4.21-3.5 8.62-21 5.18-24.63 4.93-36.68 8.69-.454.32.519.65 16.53 1.55 7.07.389h17.3l32.21 2.4 8.43 5.57 5.05 6.8-.843 5.18-12.96 6.61-17.5-4.15-40.83-9.72-14-3.5h-1.94v1.17l11.67 11.41 21.39 19.31 26.77 24.89 1.36 6.16-3.43 4.86-3.63-.518-23.53-17.69-9.07-7.97-20.55-17.3h-1.36v1.81l4.73 6.93 25.02 37.59 1.3 11.54-1.81 3.76-6.48 2.27-7.13-1.3-14.65-20.54-15.1-23.14-12.19-20.74-1.49.84-7.19 77.45-3.37 3.95-7.78 2.98-6.48-4.92-3.44-7.97 3.44-15.75 4.15-20.54 3.37-16.33 3.05-20.29 1.81-6.74-.13-.454-1.49.19-15.29 21-23.27 31.43-18.41 19.7-4.41 1.75-7.65-3.95.713-7.06 4.28-6.29 25.47-32.41 15.36-20.09 9.92-11.6-.065-1.69h-.583L44.07 198.12l-12.05 1.55-5.18-4.86.65-7.97 2.46-2.59 20.35-14-.64.06Z';

const OPENAI =
  'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z';

const CURSOR =
  'M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z';

const GROK_A =
  'M395.48 633.83 735.91 381.11c16.69-12.39 40.54-7.56 48.5 11.69 41.85 101.49 23.16 223.46-60.12 307.2-83.27 83.74-199.14 102.11-305.04 60.28l-115.69 53.87C469.49 928.2 670.99 900 796.9 773.28c99.88-100.44 130.81-237.34 101.88-360.81l.262.26C857.11 231.37 909.36 158.87 1016.4 10.63 1018.93 7.12 1021.47 3.6 1024 0L883.14 141.65v-.439L395.39 633.92';
const GROK_B =
  'M325.23 695.25C206.13 580.84 226.66 403.78 328.29 301.67c75.15-75.57 198.26-106.41 305.74-61.07l115.43-53.6c-20.8-15.11-47.45-31.37-78.03-42.79-138.23-57.21-303.73-28.73-416.1 84.18C147.23 337.08 113.24 504.21 171.61 646.83c43.6 106.59-27.87 181.99-99.87 258.08C46.22 931.89 20.62 958.87 0 987.43l325.14-292.09';

const COPILOT =
  'M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z';

/** Brand marks by provider id (built-ins only; custom agents get their initials). */
export const PROVIDER_MARKS: Readonly<Record<string, ProviderMark>> = {
  'claude-code': { viewBox: '0 0 256 257', color: '#D97757', paths: [{ d: CLAUDE }] },
  codex: { viewBox: '0 0 24 24', paths: [{ d: OPENAI }] },
  cursor: { viewBox: '0 0 466.73 532.09', paths: [{ d: CURSOR }] },
  grok: { viewBox: '0 0 1024 1024', paths: [{ d: GROK_A }, { d: GROK_B }] },
  copilot: { viewBox: '0 0 24 24', paths: [{ d: COPILOT }] },
  // OpenCode's block "O": the frame in ink, the inner block a quieter ink (its grey on the light logo)
  opencode: { viewBox: '0 0 32 40', paths: [{ d: 'M24 8H8V32H24V8ZM32 40H0V0H32V40Z' }, { d: 'M24 32H8V16H24V32Z', opacity: 0.32 }] },
};

export function providerMark(id: string): ProviderMark | undefined {
  return PROVIDER_MARKS[providerBase(id)];
}

/** Up to two initials, for agents without a mark. */
export function providerInitials(name: string): string {
  return name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

/* ---------- install and login status ---------- */

export type ProviderLoginKind = 'not_installed' | 'logged_in' | 'logged_out' | 'unknown' | 'error';

export interface ProviderLoginView {
  kind: ProviderLoginKind;
  /** the status in a word or two: "Logged in", "Not logged in", "Not installed", "Installed", "Error" */
  label: string;
  /** who and on what: "s***@example.com · Max"; for unknown, why */
  detail?: string;
  tone: 'success' | 'warning' | 'neutral' | 'danger';
  /** offer Log in, and how loudly */
  login?: 'primary' | 'secondary';
}

type LoginFields = Pick<Provider, 'installed' | 'authStatus' | 'auth'>;

/**
 * How a provider's status reads. The CLI's own login check (`auth`) wins; without one (custom agents, a check not run
 * yet) the ACP handshake's verdict (`authStatus`) stands in.
 */
export function providerLogin(p: LoginFields): ProviderLoginView {
  if (!p.installed || p.authStatus === 'not_installed') return { kind: 'not_installed', label: 'Not installed', tone: 'neutral' };
  const state = p.auth?.state;
  if (state === 'logged_in' || (!state && p.authStatus === 'authenticated')) {
    const detail = [p.auth?.account, p.auth?.plan].filter(Boolean).join(' · ');
    // the free agent with nothing signed in (protocol `freeModels.ts`): nobody logged in, and nothing is missing
    if (p.auth?.account === FREE_MODELS_ACCOUNT) return { kind: 'logged_in', label: 'Ready', tone: 'success', detail };
    return { kind: 'logged_in', label: 'Logged in', tone: 'success', ...(detail ? { detail } : {}) };
  }
  if (state === 'logged_out' || (!state && p.authStatus === 'needs_auth')) return { kind: 'logged_out', label: 'Not logged in', tone: 'warning', login: 'primary' };
  if (!state && p.authStatus === 'error') return { kind: 'error', label: 'Error', tone: 'danger', login: 'secondary' };
  return { kind: 'unknown', label: 'Installed', tone: 'neutral', login: 'secondary', ...(state === 'unknown' ? { detail: "Couldn't check the login" } : {}) };
}

/** One line for pickers: "Logged in · s***@example.com", "Not logged in", "Not installed". */
export function providerLoginLine(p: LoginFields): string {
  const v = providerLogin(p);
  return v.kind === 'logged_in' && v.detail ? `${v.label} · ${v.detail}` : v.label;
}

/* ---------- agent profiles in pickers ---------- */

type AgentLike = Pick<Provider, 'id' | 'name'> & Partial<Pick<Provider, 'profile' | 'profileName'>>;

/**
 * The profile's name ("work", "Main") of an agent that has profiles: a profile itself, or a built-in that has some
 * (its own default one is "Main" until renamed); '' for an agent without any.
 */
/** AppuBot's launch gift (the free Claude day's agent): "Claude" under the profile "AppuBot Launch Gift" */
export const isLaunchGift = (a: AgentLike | undefined): boolean => a?.profile?.source === 'credit' && a.profile.name === PROMO_PROFILE_NAME;
/** what a model of an agent is called when its list doesn't name it: the gift's is "Claude", never its id's name */
export const giftModelName = (a: AgentLike | undefined): string | undefined => (isLaunchGift(a) ? PROMO_AGENT_NAME : undefined);

export function agentProfileLabel(a: AgentLike, all: readonly AgentLike[]): string {
  // AppuBot AI (the included credit's own Claude Code profile) is an agent of its own name, not "Claude Code · AppuBot AI";
  // the launch gift is "Claude" under its profile, "AppuBot Launch Gift"
  if (a.profile?.source === 'credit') return isLaunchGift(a) ? a.profile.name : '';
  if (!a.profile && !all.some((p) => p.profile?.of === a.id && p.profile.source !== 'credit')) return '';
  return a.profile?.name ?? a.profileName ?? 'Main';
}

/** "Claude Code · work" for an agent with profiles (a profile's base is its built-in's name), else its own name. */
export function agentDisplayName(a: AgentLike, all: readonly AgentLike[]): string {
  const prof = agentProfileLabel(a, all);
  if (!prof) return a.name;
  const base = isLaunchGift(a) ? a.name : a.profile ? all.find((p) => p.id === a.profile!.of)?.name ?? a.name.split(' · ')[0]! : a.name;
  return `${base} · ${prof}`;
}

/* ---------- permission modes ---------- */

/**
 * AppuBot offers each permission-level agent's Auto ("Approve for me") and Bypass ("Full access") only. Their ids per
 * agent: Claude Code's `auto`/`bypassPermissions`, Codex's `agent`/`agent-full-access`. Settings' default is stored as
 * Claude Code's.
 */
const MODE_KIND: Readonly<Record<string, 'auto' | 'bypass'>> = { auto: 'auto', agent: 'auto', bypassPermissions: 'bypass', 'agent-full-access': 'bypass' };
const GENERIC_MODE: Readonly<Record<'auto' | 'bypass', string>> = { auto: 'auto', bypass: 'bypassPermissions' };

/** Whether a mode id is an Auto or a Bypass mode (undefined for any other). */
export function permissionModeKind(id: string): 'auto' | 'bypass' | undefined {
  return MODE_KIND[id];
}

/** `value` as one of `modes`: itself, else that agent's mode of the same kind (Claude Code's `auto` is Codex's `agent`). */
export function shownMode(modes: readonly { id: string }[], value: string): string {
  if (modes.some((m) => m.id === value)) return value;
  const kind = MODE_KIND[value];
  return (kind && modes.find((m) => MODE_KIND[m.id] === kind)?.id) || value;
}

/** A mode as Claude Code's id (how Settings' `defaultModeId` is stored); other ids unchanged. */
export function genericModeId(id: string): string {
  const kind = MODE_KIND[id];
  return kind ? GENERIC_MODE[kind] : id;
}

/** The built-in agents whose own CLI login can run on a computer for another device (`providers.deviceLogin.*`). */
const DEVICE_SIGN_IN_AGENTS = ['claude-code', 'codex', 'copilot', 'cursor', 'grok'];

/**
 * `m` signs one of this computer's own agents in inside the app, with no terminal (Settings › Agents on macOS, Windows
 * and Linux: `providers.deviceLogin.start` with `here`): the account login of a built-in agent that can (or of its
 * profile), not a key or a pasted token, which have dialogs of their own.
 */
export function signsInHere(p: { id: string; builtin?: boolean; profile?: unknown }, m?: { id: string; vars?: readonly unknown[] }): boolean {
  if (m?.vars?.length || m?.id === 'claude-token') return false;
  return (!!p.builtin || !!p.profile) && DEVICE_SIGN_IN_AGENTS.includes(providerBase(p.id));
}

/**
 * How an agent signs in from another device, with its login run on the computer (`providers.deviceLogin.start`):
 * `code` (Codex: a link and a one-time code to approve anywhere) or `browser` (a page opened in the device's browser,
 * which comes back to the computer: the desktop app catches it, a phone pastes a code or the last page's address).
 * Null where it can't: OpenCode's login asks which provider in a menu of its own, key logins are typed instead.
 * An added agent's terminal login counts: its printed link or code is read on the computer and shown on the device.
 */
export function deviceSignIn(p: { id: string; builtin?: boolean; authMethods?: readonly { kind?: string; vars?: readonly unknown[] }[] }): 'code' | 'browser' | null {
  const base = providerBase(p.id);
  if (base === 'codex') return 'code';
  if (DEVICE_SIGN_IN_AGENTS.includes(base)) return 'browser';
  if (p.builtin) return null;
  // an added agent: its own browser login (ACP `authenticate`, its page caught), or its terminal login run on the
  // computer, whose printed link, code or "paste the code" prompt comes to the device (the owner's call, 2026-11-17:
  // every sign-in happens on the person's own device, never on the cloud computer's screen)
  return (p.authMethods ?? []).some((m) => (m.kind === 'agent' || m.kind === 'terminal') && !m.vars?.length) ? 'browser' : null;
}
