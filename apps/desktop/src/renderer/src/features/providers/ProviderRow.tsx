import { useState } from 'react';
import { Download, Globe, KeyRound, LogIn, LogOut, MoreHorizontal, RefreshCw, Terminal } from '../../components/ui/icons';
import type { AuthMethod, Provider } from '@appubot/protocol';
import { deviceSignIn, providerLogin } from '@appubot/chat-core';
import { Badge, Button, Menu, cn, type MenuItem } from '../../components/ui';
import { call, confirm } from '../../lib/actions';
import { TERMINAL, THIS_MACHINE } from '../../lib/platform';
import { useThisComputer } from '../cloud/thisComputer';
import { pushToast, setState } from '../../lib/store';

import { KeysDialog } from './KeysDialog';
import { CloudLoginButton, CloudSignInDialog } from '../cloud/CloudAgentLogin';
import { useCloudLink } from '../cloud/cloudClient';

export { ProviderLogo, ProviderMark } from './providerLogos';

/**
 * Re-check install, version and login (all agents, or `ids`); the list comes back whole. `signIn` also starts those of
 * `ids` that can't be asked whether they are signed in, to see.
 */
export async function refreshProviders(ids?: string[], signIn = false): Promise<void> {
  const list = await call('providers.refresh', ids ? { ids, ...(signIn ? { signIn } : {}) } : {}, { errorTitle: 'Could not refresh providers' });
  if (list) setState({ providers: list });
}

/**
 * The status on the name line: "Logged in · s***@example.com · Max" (green), "Not logged in" (amber), "Not installed",
 * "Installed" when the login can't be told, "Error".
 */
export function ProviderStatusBadge({ provider, className }: { provider: Provider; className?: string }) {
  const v = providerLogin(provider);
  const text = v.kind === 'logged_in' && v.detail ? `${v.label} · ${v.detail}` : v.label;
  return (
    <Badge tone={v.tone} className={cn('min-w-0', className)}>
      <span className="truncate" title={v.detail ? `${v.label} · ${v.detail}` : undefined}>{text}</span>
    </Badge>
  );
}

/**
 * The row's actions (its status is ProviderStatusBadge): Install when missing; Log in when logged out (quieter when
 * the login can't be told), a menu of its logins when it has several; a login that is a key opens `KeysDialog`; when
 * logged in, a ⋯ menu with Log in again, Log out if the agent can be signed out from here, and Remove saved key. Then
 * a per-agent refresh, which also starts an agent that can't be asked whether it is signed in, to see. `compact`
 * (onboarding's agent cards) keeps only Install / Log in.
 */
export function ProviderActions({ provider: p, className, compact }: { provider: Provider; className?: string; compact?: boolean }) {
  const [busy, setBusy] = useState<'install' | 'auth' | 'refresh' | null>(null);
  /** on the cloud computer an install goes straight on into the sign-in (one press) */
  const [signIn, setSignIn] = useState(false);
  const [keysFor, setKeysFor] = useState<AuthMethod | null>(null);
  const v = providerLogin(p);
  const methods = p.authMethods;
  // on the cloud computer: Claude Code's token from this Mac, Codex's device code, or the cloud desktop
  const onCloud = useCloudLink((s) => s.computer === 'cloud');
  const computer = useThisComputer();

  const install = async () => {
    setBusy('install');
    // on an AppuBot Cloud computer the install runs there and the call ends when it is done (a minute or two)
    const r = await call('providers.install', { id: p.id }, { errorTitle: `Could not install ${p.name}`, timeoutMs: 15 * 60_000 });
    if (r && onCloud && r.ok && deviceSignIn(p)) { await refreshProviders([p.id]); setSignIn(true); }
    else if (r && onCloud) pushToast({ title: r.ok ? `${p.name} is installed` : `${p.name} didn't install`, body: r.output.slice(-240), level: r.ok ? 'success' : 'warning' });
    else if (r) pushToast({ title: r.ok ? `Installing ${p.name}` : 'Install needs attention', body: r.output.slice(-240) || `Follow the steps in ${TERMINAL}, then Refresh.`, level: r.ok ? 'info' : 'warning' });
    setBusy(null);
  };
  const login = async (m: AuthMethod | undefined = methods[0]) => {
    if (m?.vars?.length) return setKeysFor(m);
    setBusy('auth');
    const r = await call('providers.authenticate', { id: p.id, methodId: m?.id }, { errorTitle: `Could not log in to ${p.name}` });
    if (r) pushToast({ title: r.ok ? `Log in to ${p.name}` : 'Finish logging in', body: r.message ?? `Complete the login in ${TERMINAL} or your browser, then Refresh.`, level: 'info' });
    setBusy(null);
  };
  const logout = () =>
    confirm({
      title: `Log out of ${p.name}?`,
      body: onCloud ? `This signs ${p.name} out on ${computer.name}. Bots on ${p.name} can't work until you log in again.` : `This signs ${p.name} out on ${THIS_MACHINE}, in ${TERMINAL} too. Bots on ${p.name} can't work until you log in again.`,
      confirmLabel: 'Log out',
      danger: true,
      onConfirm: async () => {
        const r = await call('providers.logout', { id: p.id }, { errorTitle: `Could not log out of ${p.name}` });
        if (r) pushToast({ title: r.ok ? `Logged out of ${p.name}` : `Could not log out of ${p.name}`, body: r.message, level: r.ok ? 'success' : 'warning' });
      },
    });
  const clearKeys = () =>
    confirm({
      title: `Remove ${p.name}'s saved key?`,
      body: `${p.name} can't use it after this; bots on ${p.name} need another login.`,
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: async () => { await call('providers.clearKeys', { id: p.id }, { errorTitle: `Could not remove ${p.name}'s key` }); },
    });
  /** each login, for the menu of an agent that has several */
  const loginItems: MenuItem[] = methods.map((m) => ({
    label: m.name,
    icon: m.vars?.length ? KeyRound : m.kind === 'terminal' ? Terminal : Globe,
    ...(m.description ? { hint: m.description } : {}),
    onSelect: () => void login(m),
  }));
  const loginButton = (variant: 'secondary' | 'ghost') => onCloud ? (
    <CloudLoginButton provider={p} variant={variant} onKeys={setKeysFor} />
  ) : methods.length > 1 ? (
    <Menu
      className="min-w-[220px]"
      items={loginItems}
      trigger={(t) => <Button {...t} size="sm" variant={variant} icon={LogIn} loading={busy === 'auth'}>Log in</Button>}
    />
  ) : (
    <Button size="sm" variant={variant} icon={LogIn} loading={busy === 'auth'} onClick={() => void login()}>Log in</Button>
  );

  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {signIn ? <CloudSignInDialog provider={p} onClose={() => setSignIn(false)} /> : null}
      {v.kind === 'not_installed' ? (
        <Button size="sm" variant="secondary" icon={Download} loading={busy === 'install' || !!p.installing} onClick={() => void install()}>{p.installing ? 'Installing…' : onCloud && deviceSignIn(p) ? 'Install and log in' : 'Install'}</Button>
      ) : v.login === 'primary' ? loginButton('secondary') : null}
      {v.login === 'secondary' ? loginButton('ghost') : null}
      {v.kind === 'logged_in' && !compact ? (
        <Menu
          className="min-w-[200px]"
          items={[
            ...(onCloud ? [] : methods.length > 1 ? loginItems.map((it) => ({ ...it, label: `Log in with ${it.label}` })) : [{ label: 'Log in again', icon: LogIn, onSelect: () => void login() }]),
            // some CLIs (Copilot, OpenCode) have no sign-out command we can run
            ...(p.canLogOut ? [{ label: 'Log out', icon: LogOut, danger: true, onSelect: logout }] : []),
            ...(p.keysSaved.length ? [{ label: 'Remove saved key', icon: KeyRound, danger: true, onSelect: clearKeys }] : []),
          ]}
          trigger={(t) => <Button {...t} size="icon-sm" variant="ghost" icon={MoreHorizontal} aria-label={`${p.name} account`} title="Account" loading={busy === 'auth'} />}
        />
      ) : null}
      {!compact ? (
        <Button
          size="icon-sm" variant="ghost" icon={RefreshCw} aria-label={`Check ${p.name} again`} title="Check again"
          loading={busy === 'refresh'}
          onClick={async () => { setBusy('refresh'); await refreshProviders([p.id], !p.auth && !p.builtin); setBusy(null); }}
        />
      ) : null}
      {keysFor ? <KeysDialog provider={p} method={keysFor} onClose={() => setKeysFor(null)} /> : null}
    </div>
  );
}
