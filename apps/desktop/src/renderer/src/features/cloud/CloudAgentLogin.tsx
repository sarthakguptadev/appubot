import { useEffect, useRef, useState } from 'react';
import { providerBase, type AuthMethod, type DeviceLogin, type Provider } from '@appubot/protocol';
import { deviceSignIn, providerLogin } from '@appubot/chat-core';
import { Check, Copy, ExternalLink, KeyRound, LogIn, Monitor, Terminal } from '../../components/ui/icons';
import { Button, Dialog, FIELD_HINT, Field, Input, Menu, Spinner, type ButtonVariant, type MenuItem } from '../../components/ui';
import { errorMessage, gateway, rpc } from '../../lib/gateway';
import { native } from '../../lib/native';
import { MACHINE, TERMINAL, THIS_MACHINE } from '../../lib/platform';
import { pushToast, setState, useStore } from '../../lib/store';
import { ProviderMark } from '../providers/providerLogos';
import { cloudClientIfAny, useCloudLink } from './cloudClient';
import { openCloudDesktop } from './DesktopView';

/*
 * Signing agents in on the cloud computer (plan §5.9: the user's own accounts, as on the Mac), with nothing to do on
 * its screen. Settings › Agents on the cloud offers, beside the agent's own logins:
 *
 * - "Sign in in your browser" (every agent chat-core `deviceSignIn` allows; Codex: "Sign in with a code"): the agent's
 *   own login runs on the cloud (`providers.deviceLogin.*`) and its page opens in this Mac's browser, where the person
 *   is already signed in. A sign-in that comes back to the cloud computer (`DeviceLogin.relay`: Claude Code's `auth
 *   login`, Google's) is caught on the same port here (main's electron/authRelay.ts) and handed back with
 *   `providers.deviceLogin.finish`; Codex shows a link and a code to approve; failing those, Claude's code or the last
 *   page's address is pasted;
 * - Claude Code: "Paste a sign-in token": `claude setup-token` runs in Terminal on this Mac, the token is pasted here
 *   and saved on the cloud computer only (`providers.setKeys`, owner only, over the end-to-end channel);
 * - any agent: "Sign in on its desktop": its login runs on the cloud (a terminal or the cloud's browser) and Open
 *   desktop shows it; the last resort.
 */

/** a login with no link or code by then is one that only asks on the computer's own screen */
const SILENT_LOGIN_MS = 20_000;

/** the variable Claude Code reads a `setup-token` token from */
export const CLAUDE_TOKEN_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';
/** the key login agent-runtime gives Claude Code for it (`builtinKeyLogins`) */
const CLAUDE_TOKEN_METHOD = 'claude-token';

/** "Paste a sign-in token" for Claude Code on the cloud. */
function ClaudeTokenDialog({ provider: p, onClose }: { provider: Provider; onClose: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const method = p.authMethods.find((m) => m.vars?.some((v) => v.name === CLAUDE_TOKEN_VAR));
  const submit = async () => {
    const value = token.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await rpc('providers.setKeys', { id: p.id, methodId: method?.id ?? CLAUDE_TOKEN_METHOD, values: { [CLAUDE_TOKEN_VAR]: value } });
      if (!r.ok) { setError(r.message ?? `${p.name} didn’t take that token. Run the command again and paste the new one.`); return; }
      pushToast({ title: `${p.name} is signed in on your AppuBot computer`, body: r.message, level: 'success' });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={<span className="flex items-center gap-3"><ProviderMark provider={p} size={32} />Sign in with your Claude account</span>}
      description={`Use the Claude account you’re signed in to on ${THIS_MACHINE}. The token is saved on your AppuBot computer only, readable only by AppuBot there, and goes only to ${p.name}.`}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!token.trim()} onClick={() => void submit()}>Save and sign in</Button>
        </>
      )}
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="flex flex-col gap-1.5">
          <span className="text-copy font-medium text-fg">1. Make a token on {THIS_MACHINE}</span>
          <div className="flex items-center gap-2">
            <code className="selectable ab-pill min-w-0 flex-1 truncate rounded-control bg-surface-2 px-3 py-1.5 font-mono text-ui text-fg">claude setup-token</code>
            <Button size="sm" variant="outline" icon={Terminal} onClick={() => void native().openTerminal('claude setup-token')}>Run in {TERMINAL}</Button>
          </div>
          <span className={FIELD_HINT}>It opens your browser to approve, then prints a token that starts with sk-ant-.</span>
        </div>
        <Field label="2. Paste it here">
          <Input
            autoFocus type="password" autoComplete="off" spellCheck={false} className="font-mono"
            placeholder={p.keysSaved.includes(CLAUDE_TOKEN_VAR) ? 'Saved: paste a new one to replace it' : 'sk-ant-…'}
            value={token} onChange={(e) => setToken(e.target.value)}
          />
        </Field>
        {error ? <p className="selectable text-ui leading-snug text-danger">{error}</p> : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/**
 * A sign-in the cloud computer runs for this Mac (`providers.deviceLogin.*`), followed by `provider.login` events:
 * - one that comes back to the cloud computer (`DeviceLogin.relay`: Claude Code's `auth login`, Google's and most
 *   browser sign-ins): this Mac listens on the same port (main's electron/authRelay.ts), opens the page in this Mac's
 *   browser, where you're already signed in, and sends where it came back to (`providers.deviceLogin.finish`), which
 *   the cloud computer hands to the agent; nothing to copy. Where that can't run (the port is busy here, an older main)
 *   the page's last address is pasted instead, or Claude's code;
 * - Codex's (and Copilot's) link and one-time code to approve on any device;
 * - a link and a code pasted back (Claude Code's other way).
 * Closing cancels a login still waiting.
 *
 * `here`: the same dialog for this computer's own agents (Settings › Agents, `SignInDialog`), with no terminal: the
 * agent opens its page in this computer's browser itself and takes the return there, while the dialog shows its link,
 * its code to enter or a field for the code to paste back.
 */
function DeviceLoginDialog({ provider: p, method, onClose, others = [], here = false }: {
  provider: Provider; method: AuthMethod | undefined; onClose: () => void;
  /** the agent's other ways in (Claude's token, an API key), as quiet links under the sign-in */
  others?: readonly { label: string; onSelect: () => void }[];
  here?: boolean;
}) {
  const [login, setLogin] = useState<DeviceLogin | null>(null);
  const [error, setError] = useState<string>();
  const [pasted, setPasted] = useState('');
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  /** the browser on this Mac is out on the sign-in (`relay`), or couldn't be (its words) */
  const [relay, setRelay] = useState<{ state: 'open' | 'finishing' | 'failed'; message?: string } | null>(null);
  /** the person asked for the code or address route instead of the browser */
  const [manual, setManual] = useState(false);
  const started = useRef(false);
  const relayed = useRef<number | null>(null);
  /** Try again after a failure starts a new sign-in */
  const [retry, setRetry] = useState(0);
  /** the login runs but has shown no link, code or prompt for a while (a terminal login that only asks in a menu) */
  const [silent, setSilent] = useState(false);
  // its progress comes as `provider.login` events from the computer running it (subscribed while the dialog is open)
  useEffect(() => (here ? gateway() : cloudClientIfAny())?.onAny((event, payload) => {
    if (event !== 'provider.login') return;
    const l = payload as DeviceLogin;
    if (l.id !== p.id) return;
    setLogin(l);
    if (l.state === 'done') pushToast({ title: here ? `${p.name} is signed in` : `${p.name} is signed in on your AppuBot computer`, level: 'success' });
  }), [p.id]);
  // started once (a second mount in development must not start a second login)
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    rpc('providers.deviceLogin.start', { id: p.id, ...(method ? { methodId: method.id } : {}), ...(here ? { here: true } : {}) })
      .then((l) => setLogin((cur) => (cur && cur.startedAt >= l.startedAt && cur.state !== 'starting' ? cur : l)))
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [retry]);
  const shown = !!(login?.url || login?.code || login?.prompt || login?.relay);
  useEffect(() => {
    setSilent(false);
    if (shown || error || login?.state === 'done' || login?.state === 'failed') return;
    const t = setTimeout(() => setSilent(true), SILENT_LOGIN_MS);
    return () => clearTimeout(t);
  }, [shown, error, login?.state, retry]);
  // a sign-in that comes back to the cloud computer: out in this Mac's browser at once, its return caught here
  const way = login?.state === 'waiting' ? login.relay : undefined;
  const canRelay = !!native().authRelay;
  useEffect(() => {
    const catchIt = native().authRelay;
    if (!way || !catchIt || relayed.current === way.port) return;
    relayed.current = way.port;
    setRelay({ state: 'open' });
    catchIt(way)
      .then(async (url) => {
        setRelay({ state: 'finishing' });
        setLogin(await rpc('providers.deviceLogin.finish', { id: p.id, url }));
      })
      .catch((e: unknown) => {
        const message = errorMessage(e);
        if (message !== 'Cancelled.') setRelay({ state: 'failed', message });
      });
  }, [way?.port]);
  const close = () => {
    if (relayed.current !== null) void native().authRelayCancel?.(relayed.current).catch(() => undefined);
    if (login && login.state !== 'done' && login.state !== 'failed') void rpc('providers.deviceLogin.cancel', { id: p.id }).catch(() => undefined);
    onClose();
  };
  /** the code Claude's page shows, or the address a sign-in page ended on */
  const send = async () => {
    const text = pasted.trim();
    if (!text || sending) return;
    setSending(true);
    setError(undefined);
    try {
      const address = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(text);
      setLogin(await rpc(address ? 'providers.deviceLogin.finish' : 'providers.deviceLogin.code', address ? { id: p.id, url: text } : { id: p.id, code: text }));
      setPasted('');
    } catch (e) { setError(errorMessage(e)); }
    finally { setSending(false); }
  };
  const failed = login?.state === 'failed' || (!!error && !login);
  // the browser route, while it runs (or until it can't)
  const browser = !!way && canRelay && !manual && relay?.state !== 'failed';
  // otherwise: the link and its code, Claude's code pasted back, or the address the page ended on
  const pasteWhat = login?.prompt ? 'code' : way ? 'address' : null;
  return (
    <Dialog
      open
      onClose={close}
      size="sm"
      title={<span className="flex items-center gap-3"><ProviderMark provider={p} size={32} />Sign in to {p.name}</span>}
      description={browser
        ? `Finish signing in in your browser on ${THIS_MACHINE}, with your own account. AppuBot brings it back to your AppuBot computer.`
        : here && pasteWhat === 'code' ? `Sign in with your own account in the page ${p.name} opened in your browser, and you’re done. If no page opened, open the link, sign in, then paste the code it shows.`
        : pasteWhat === 'code' ? 'Open the link, sign in with your own account, then paste the code it shows.'
          : pasteWhat === 'address' ? 'Open the link and sign in. The last page won’t load: copy its address from the address bar and paste it here.'
            : 'Open the link on this computer or your phone, sign in with your own account and enter the code.'}
      footer={<Button variant={login?.state === 'done' ? 'primary' : 'ghost'} onClick={close}>{login?.state === 'done' ? 'Done' : 'Cancel'}</Button>}
    >
      {login?.state === 'done' ? (
        <p className="flex items-center gap-2 text-copy text-success"><Check size={16} /> {here ? `Signed in. Bots on ${p.name} can work now.` : `Signed in. Bots on ${p.name} work on your AppuBot computer now.`}</p>
      ) : failed ? (
        <div className="flex flex-col gap-3">
          <p className="selectable text-copy leading-snug text-danger">{error ?? login?.message ?? `${p.name} didn’t start its sign-in.`}</p>
          <Button size="sm" variant="outline" className="self-start" onClick={() => { setError(undefined); setLogin(null); setRelay(null); setManual(false); relayed.current = null; started.current = false; setRetry((n) => n + 1); }}>Try again</Button>
        </div>
      ) : browser ? (
        <div className="flex flex-col items-center gap-3 py-2">
          <p className="flex items-center gap-2 text-copy text-muted"><Spinner size={14} /> {relay?.state === 'finishing' || login?.message ? 'Finishing the sign-in on your AppuBot computer…' : 'Waiting for you to sign in in your browser…'}</p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" icon={ExternalLink} onClick={() => void native().openExternal(way.url)}>Open the page again</Button>
            <Button size="sm" variant="ghost" onClick={() => { if (relayed.current !== null) void native().authRelayCancel?.(relayed.current).catch(() => undefined); setManual(true); }}>{login?.prompt ? 'Use a code instead' : 'Paste the address instead'}</Button>
          </div>
          {error ? <p className="selectable text-center text-ui leading-snug text-danger">{error}</p> : null}
        </div>
      ) : login?.url || way ? (
        <div className="flex flex-col items-center gap-3 py-1">
          {relay?.state === 'failed' && relay.message ? <p className="selectable text-center text-ui leading-snug text-muted">{relay.message}</p> : null}
          {login?.code ? <div className="selectable ab-pill rounded-control-lg bg-surface-2 px-5 py-3 font-mono text-[24px] tracking-[0.12em] text-fg">{login.code}</div> : null}
          <div className="flex items-center gap-2">
            {login?.code ? <Button size="sm" variant="outline" icon={copied ? Check : Copy} onClick={() => { void navigator.clipboard.writeText(login.code!); setCopied(true); }}>{copied ? 'Copied' : 'Copy code'}</Button> : null}
            <Button size="sm" variant="primary" icon={ExternalLink} onClick={() => void native().openExternal((pasteWhat === 'code' ? login?.url : undefined) ?? way?.url ?? login!.url!)}>Open the link</Button>
          </div>
          <p className="selectable line-clamp-2 text-center text-note break-all text-muted">{(pasteWhat === 'code' ? login?.url : undefined) ?? way?.url ?? login?.url}</p>
          {pasteWhat ? (
            <form className="flex w-full items-end gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <Field label={pasteWhat === 'code' ? 'Code from the page' : 'Address the page ended on'} className="flex-1">
                <Input autoFocus autoComplete="off" spellCheck={false} className="font-mono" placeholder={pasteWhat === 'address' ? 'http://localhost:…' : undefined} value={pasted} onChange={(e) => setPasted(e.target.value)} />
              </Field>
              <Button type="submit" variant="primary" loading={sending} disabled={!pasted.trim()}>Sign in</Button>
            </form>
          ) : (
            <p className="flex items-center gap-2 text-note text-muted"><Spinner size={12} /> Waiting for you to approve it…</p>
          )}
          {error ? <p className="selectable text-center text-ui leading-snug text-danger">{error}</p> : null}
        </div>
      ) : silent ? (
        <div className="flex flex-col gap-3">
          <p className="text-copy leading-snug text-muted">{here ? `${p.name} hasn’t given a link or code to sign in with yet. If a page opened in your browser, finish there; else sign in from ${TERMINAL}.` : `${p.name} hasn’t given a link or code to sign in with from here. Its login only asks on its own screen.`}</p>
          <div className="flex items-center gap-2">
            {here
              ? <Button size="sm" variant="outline" icon={Terminal} onClick={() => { close(); void signInInTerminal(p, method); }}>Use {TERMINAL}</Button>
              : <Button size="sm" variant="outline" onClick={() => { close(); void signInOnDesktop(p, p.authMethods.find((m) => !m.vars?.length)); }}>Sign in on its screen</Button>}
            <Button size="sm" variant="ghost" onClick={() => setSilent(false)}>Keep waiting</Button>
          </div>
        </div>
      ) : (
        <p className="flex items-center gap-2 py-4 text-copy text-muted"><Spinner size={14} /> Asking {p.name} for a sign-in link…</p>
      )}
      {others.length && login?.state !== 'done' ? (
        <p className="mt-4 text-center text-note text-muted">
          Or{' '}
          {others.map((o, i) => (
            <span key={o.label}>
              {i ? ' · ' : null}
              <button type="button" className="text-fg-2 underline-offset-2 hover:text-fg hover:underline" onClick={() => { close(); o.onSelect(); }}>{o.label.toLowerCase()}</button>
            </span>
          ))}
        </p>
      ) : null}
    </Dialog>
  );
}

/** This computer's agent's login in a terminal window: the way left when its CLI shows nothing the window can use. */
async function signInInTerminal(p: Provider, m: AuthMethod | undefined): Promise<void> {
  try {
    const r = await rpc('providers.authenticate', { id: p.id, methodId: m?.id });
    pushToast({ title: r.ok ? `Log in to ${p.name}` : 'Finish logging in', body: r.message, level: 'info' });
  } catch (e) {
    pushToast({ title: `Couldn’t sign in to ${p.name}`, body: errorMessage(e), level: 'error' });
  }
}

/**
 * Signing one of this computer's own agents in to its account from Settings › Agents, in the app (`DeviceLoginDialog`
 * with `here`), on macOS, Windows and Linux: Claude Code's subscription (`claude auth login`: its page opens in the
 * browser and returns to it, or its code is pasted here), Codex's ChatGPT plan and Copilot's GitHub account (a link
 * and a one-time code), Cursor's and Grok's account (their page). chat-core's `signsInHere` says which logins go this way.
 */
export function SignInDialog({ provider, method, onClose }: { provider: Provider; method: AuthMethod | undefined; onClose: () => void }) {
  return <DeviceLoginDialog provider={provider} method={method} onClose={onClose} here />;
}

/** The agent's login run on the cloud, shown through Open desktop (a terminal there, or the cloud's browser). */
async function signInOnDesktop(p: Provider, m: AuthMethod | undefined): Promise<void> {
  // in control at once: the agent's terminal or browser on the screen is waiting for the person's keys
  openCloudDesktop(useCloudLink.getState().team, { signIn: p.name });
  try {
    const r = await rpc('providers.authenticate', { id: p.id, methodId: m?.id }, { timeoutMs: 15 * 60_000 });
    pushToast({ title: r.ok ? `${p.name} is signed in on your AppuBot computer` : 'Finish signing in on its desktop', body: r.message, level: r.ok ? 'success' : 'info' });
  } catch (e) {
    pushToast({ title: `Couldn’t sign in to ${p.name}`, body: errorMessage(e), level: 'error' });
  }
}

/**
 * The Log in button on the cloud computer, signed in without its screen: one press starts the agent's own sign-in there for this Mac (in this Mac's
 * browser, or Codex's code), with Claude Code's token and any key login as quiet other ways under it. Only an agent
 * with none of those (its login can only run on the cloud's screen) gets the menu with "Sign in on its desktop".
 */
export function CloudLoginButton({ provider: p, variant, onKeys }: { provider: Provider; variant: ButtonVariant; onKeys: (m: AuthMethod) => void }) {
  const [dialog, setDialog] = useState<'claude' | 'device' | null>(null);
  const base = providerBase(p.id);
  const keyLogins = p.authMethods.filter((m) => m.vars?.length && !m.vars.some((v) => v.name === CLAUDE_TOKEN_VAR));
  const device = base === 'codex' ? p.authMethods.find((m) => /device/i.test(`${m.id} ${m.name}`)) : undefined;
  const others = [
    ...(base === 'claude-code' ? [{ label: 'Paste a sign-in token', onSelect: () => setDialog('claude') }] : []),
    ...keyLogins.map((m) => ({ label: `Use ${m.name}`, onSelect: () => onKeys(m) })),
  ];
  const dialogs = (
    <>
      {dialog === 'claude' ? <ClaudeTokenDialog provider={p} onClose={() => setDialog(null)} /> : null}
      {dialog === 'device' ? <DeviceLoginDialog provider={p} method={device} others={others} onClose={() => setDialog(null)} /> : null}
    </>
  );
  if (deviceSignIn(p)) {
    return (
      <>
        <Button size="sm" variant={variant} icon={LogIn} onClick={() => setDialog('device')}>Log in</Button>
        {dialogs}
      </>
    );
  }
  const items: MenuItem[] = [
    ...keyLogins.map((m): MenuItem => ({ label: m.name, icon: KeyRound, ...(m.description ? { hint: m.description } : {}), onSelect: () => onKeys(m) })),
    { label: 'Sign in on its desktop', icon: Monitor, hint: `Its own login, on your AppuBot computer’s screen`, onSelect: () => void signInOnDesktop(p, p.authMethods.find((m) => !m.vars?.length)) },
  ];
  return (
    <>
      <Menu
        className="min-w-[260px]"
        items={items}
        trigger={(t) => <Button {...t} size="sm" variant={variant} icon={LogIn}>Log in</Button>}
      />
      {dialogs}
    </>
  );
}

/** The cloud's sign-in for an agent that was just made (a new profile): the same one Log in starts. */
export function CloudSignInDialog({ provider, onClose }: { provider: Provider; onClose: () => void }) {
  const device = providerBase(provider.id) === 'codex' ? provider.authMethods.find((m) => /device/i.test(`${m.id} ${m.name}`)) : undefined;
  return <DeviceLoginDialog provider={provider} method={device} onClose={onClose} />;
}

/** What the cloud's Agents page says above its list. */
export const CLOUD_AGENTS_NOTE = `These agents run on your AppuBot computer and sign in with your own accounts, as on ${THIS_MACHINE}. Logins made on this ${MACHINE} don’t carry over.`;

/**
 * One press for an AI on the cloud computer: installs it first where it is missing (the
 * install runs there, a minute or two), then opens its sign-in in this Mac's browser or as a code; one already signed
 * in reads "✓ Signed in". The cloud's "You're all set" screen offers Claude and ChatGPT with it.
 */
export function CloudConnectButton({ providerId, label, size = 'sm' }: { providerId: string; label: string; size?: 'xs' | 'sm' }) {
  const p = useStore((s) => s.providers.find((x) => x.id === providerId));
  const [phase, setPhase] = useState<'idle' | 'installing'>('idle');
  const [signIn, setSignIn] = useState(false);
  if (!p) return null;
  const v = providerLogin(p);
  if (v.kind === 'logged_in') {
    return <span className="inline-flex items-center gap-1.5 text-ui text-muted"><Check size={14} className="text-success" />{label}</span>;
  }
  const press = async () => {
    if (v.kind === 'not_installed') {
      setPhase('installing');
      try {
        const r = await rpc('providers.install', { id: p.id }, { timeoutMs: 15 * 60_000 });
        const list = await rpc('providers.refresh', { ids: [p.id] }).catch(() => null);
        if (list) setState({ providers: list });
        if (!r.ok) { pushToast({ title: `${p.name} didn’t install`, body: r.output.slice(-240), level: 'warning' }); return; }
      } catch (e) {
        pushToast({ title: `Couldn’t install ${p.name}`, body: errorMessage(e), level: 'error' });
        return;
      } finally {
        setPhase('idle');
      }
    }
    setSignIn(true);
  };
  return (
    <>
      <Button size={size} variant="secondary" icon={LogIn} loading={phase === 'installing'} onClick={() => void press()}>
        {phase === 'installing' ? 'Installing…' : label}
      </Button>
      {signIn ? <CloudSignInDialog provider={p} onClose={() => setSignIn(false)} /> : null}
    </>
  );
}
