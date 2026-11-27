import { useId, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { parseConnectorImport, type Connector, type ConnectorSave, type ConnectorTransport } from '@appubot/protocol';
import { ChevronLeft, ChevronRight, ClipboardPaste, Globe, LogIn, LogOut, Pencil, Plus, RefreshCw, Terminal, Trash2, X, type IconComponent } from '../../components/ui/icons';
import {
  BotAvatar, Button, CardSection, Dialog, FIELD_HINT, FIELD_LABEL, Field, Icon, Input, SETTINGS_ROW, SETTINGS_ROW_BUTTON, SETTINGS_ROW_DESCRIPTION,
  SETTINGS_ROW_TITLE, SettingsSegmented, Spinner, StatusDot, Switch, Textarea, cn,
} from '../../components/ui';
import { pushToast, useStore } from '../../lib/store';
import { checkConnector, removeConnector, saveConnector, setConnectorBots, setConnectorTool, signInConnector, signOutConnector, useConnector } from './connectorsData';
import { connectorSummary, joinArgs, splitArgs } from './connectorText';

/*
 * Settings › Apps › Custom connectors: adding one (a remote server by its address, a local one by its command, or a
 * config pasted from another app), and one connector's page: how it is doing and why, its tools with a switch each,
 * the bots that may use it, Edit and Remove. Values of headers and variables are typed in and never shown again.
 */

export type ConnectorStep =
  | { kind: 'menu' }
  | { kind: 'form'; transport: 'remote' | 'stdio'; edit?: Connector }
  | { kind: 'paste' }
  | { kind: 'view'; id: string };

/** A connector's tile: its first letter on a colour of its own, and what kind it is in the corner. */
export function ConnectorIcon({ connector: c, size = 36 }: { connector: Pick<Connector, 'name' | 'transport'>; size?: number }) {
  let h = 0;
  for (const ch of c.name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  // the golden angle keeps names that hash close apart in colour
  const hue = Math.round((h % 1000) * 137.508) % 360;
  const letter = (c.name.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }} aria-hidden>
      <span
        className="squircle flex size-full items-center justify-center rounded-[10px] font-semibold text-white"
        style={{ background: `linear-gradient(160deg, hsl(${hue} 62% 58%), hsl(${(hue + 24) % 360} 58% 42%))`, fontSize: Math.round(size * 0.44) }}
      >
        {letter}
      </span>
      <span className="absolute -right-1 -bottom-1 flex size-[17px] items-center justify-center rounded-full bg-surface text-muted shadow-[0_0_0_2px_var(--ab-bg)]">
        <Icon icon={c.transport === 'stdio' ? Terminal : Globe} size={10} />
      </span>
    </span>
  );
}

const TONE = { connected: 'online', connecting: 'busy', signIn: 'warn', error: 'error' } as const;

/** One connector in the list: two lines, so a rounded rectangle, opening its page. */
export function ConnectorRow({ connector: c, onOpen }: { connector: Connector; onOpen: () => void }) {
  const bots = useStore((s) => s.bots.length);
  return (
    <button type="button" onClick={onOpen} className={cn(SETTINGS_ROW, SETTINGS_ROW_BUTTON)}>
      <ConnectorIcon connector={c} />
      <span className="min-w-0 flex-1 space-y-1">
        <span className={cn(SETTINGS_ROW_TITLE, 'block truncate')}>{c.name}</span>
        <span className={cn(SETTINGS_ROW_DESCRIPTION, 'flex items-center gap-1.5', c.status === 'error' && 'text-danger')}>
          {c.status === 'connecting' ? <Spinner size={10} /> : <StatusDot tone={TONE[c.status]} />}
          <span className="truncate">{connectorSummary(c, bots)}</span>
        </span>
      </span>
      <Icon icon={ChevronRight} size={16} className="shrink-0 text-muted" />
    </button>
  );
}

/* --------------------------------------------------------------------- menu */

function MenuRow({ icon, title, description, onClick }: { icon: IconComponent; title: string; description: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cn(SETTINGS_ROW, SETTINGS_ROW_BUTTON)}>
      <Icon icon={icon} size={16} className="mt-0.5 shrink-0 self-start text-muted" />
      <span className="min-w-0 flex-1 space-y-1">
        <span className={cn(SETTINGS_ROW_TITLE, 'block')}>{title}</span>
        <span className={cn(SETTINGS_ROW_DESCRIPTION, 'block')}>{description}</span>
      </span>
      <Icon icon={ChevronRight} size={16} className="shrink-0 text-muted" />
    </button>
  );
}

function Menu({ go }: { go: (s: ConnectorStep) => void }) {
  return (
    <CardSection>
      <MenuRow icon={Globe} title="Remote server" description="An MCP server at an address, on the internet or your network. Signs in if it asks." onClick={() => go({ kind: 'form', transport: 'remote' })} />
      <MenuRow icon={Terminal} title="Local server" description="A command this computer starts, like npx, uvx or docker." onClick={() => go({ kind: 'form', transport: 'stdio' })} />
      <MenuRow icon={ClipboardPaste} title="Paste a config" description="The JSON from Claude, Cursor, VS Code, Windsurf, Zed or OpenCode." onClick={() => go({ kind: 'paste' })} />
    </CardSection>
  );
}

/* --------------------------------------------------------------------- form */

interface Actions { at: HTMLElement | null; formId: string; onCancel: () => void }

function FooterActions({ actions, children }: { actions: Actions; children: ReactNode }) {
  if (!actions.at) return null;
  return createPortal(<><Button variant="ghost" onClick={actions.onCancel}>Cancel</Button>{children}</>, actions.at);
}

interface Pair { key: number; name: string; value: string; saved: boolean }

/** Headers or variables: a name and a masked value each; a saved value stays unless a new one is typed. */
function Pairs({ label, hint, add, namePlaceholder, valuePlaceholder, pairs, onChange }: {
  label: string; hint: string; add: string; namePlaceholder: string; valuePlaceholder: string; pairs: Pair[]; onChange: (p: Pair[]) => void;
}) {
  const set = (key: number, patch: Partial<Pair>) => onChange(pairs.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  return (
    <div className="flex flex-col gap-1.5">
      <span className={FIELD_LABEL}>{label}</span>
      {pairs.map((p) => (
        <div key={p.key} className="flex items-center gap-2">
          <Input value={p.name} onChange={(e) => set(p.key, { name: e.target.value })} placeholder={namePlaceholder} spellCheck={false} aria-label={`${label}: name`} className="w-[38%] font-mono text-ui" />
          <Input
            type="password" autoComplete="off" spellCheck={false} value={p.value} onChange={(e) => set(p.key, { value: e.target.value })}
            placeholder={p.saved ? 'Saved: type to replace' : valuePlaceholder} aria-label={`${p.name || label}: value`} className="min-w-0 flex-1 font-mono text-ui"
          />
          <Button variant="ghost" size="icon-sm" icon={X} aria-label={`Remove ${p.name || 'this one'}`} onClick={() => onChange(pairs.filter((x) => x.key !== p.key))} />
        </div>
      ))}
      <div><Button size="xs" variant="ghost" icon={Plus} onClick={() => onChange([...pairs, { key: Date.now() + pairs.length, name: '', value: '', saved: false }])}>{add}</Button></div>
      <span className={FIELD_HINT}>{hint}</span>
    </div>
  );
}

const pairsOf = (list: { name: string; saved: boolean }[] | undefined): Pair[] => (list ?? []).map((x, i) => ({ key: i, name: x.name, value: '', saved: x.saved }));
/** What a form's pairs save as: a value typed replaces, none keeps the saved one (or forgets it, if it was cleared to nothing). */
const pairsToSave = (pairs: Pair[]) => pairs.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim(), ...(p.value || !p.saved ? { value: p.value } : {}) }));

function ConnectorForm({ transport: kind, edit, onSaved, actions }: { transport: 'remote' | 'stdio'; edit?: Connector; onSaved: (c: Connector) => void; actions: Actions }) {
  const [name, setName] = useState(edit?.name ?? '');
  const [url, setUrl] = useState(edit?.url ?? '');
  const [transport, setTransport] = useState<ConnectorTransport>(edit?.transport ?? (kind === 'stdio' ? 'stdio' : 'http'));
  const [command, setCommand] = useState(edit?.command ?? '');
  const [args, setArgs] = useState(joinArgs(edit?.args ?? []));
  const [headers, setHeaders] = useState<Pair[]>(pairsOf(edit?.headers));
  const [env, setEnv] = useState<Pair[]>(pairsOf(edit?.env));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const remote = kind === 'remote';

  const submit = async () => {
    const n = name.trim() || (remote ? hostName(url) : command.trim().split(/[\\/]/).pop() ?? '');
    if (!n) return setError('Give it a name.');
    if (remote && !url.trim()) return setError('Enter the server’s address.');
    if (!remote && !command.trim()) return setError('Enter the command that starts it.');
    setError(undefined);
    setBusy(true);
    const p: ConnectorSave = remote
      ? { id: edit?.id, name: n, transport, url: url.trim(), headers: pairsToSave(headers) }
      : { id: edit?.id, name: n, transport: 'stdio', command: command.trim(), args: splitArgs(args), env: pairsToSave(env) };
    const saved = await saveConnector(p, n);
    setBusy(false);
    if (saved) onSaved(saved);
  };

  return (
    <form id={actions.formId} className="flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Field label="Name" hint="How it shows here and in your bots’ tool names.">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={remote ? 'Docs search' : 'Files'} maxLength={40} autoFocus={!edit} />
      </Field>
      {remote ? (
        <>
          <Field label="Address">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" spellCheck={false} className="font-mono text-copy" />
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className={FIELD_LABEL}>Connection</span>
            <SettingsSegmented label="Connection" value={transport} onChange={setTransport} options={[{ value: 'http', label: 'Streamable HTTP' }, { value: 'sse', label: 'SSE' }]} />
            <span className={FIELD_HINT}>Most servers use streamable HTTP. Older ones whose address ends in /sse use SSE.</span>
          </div>
          <Pairs
            label="Headers (optional)" add="Add a header" namePlaceholder="Authorization" valuePlaceholder="Bearer …" pairs={headers} onChange={setHeaders}
            hint="Values stay on this computer, locked with its keychain, and aren’t shown again. A server that wants you to sign in needs none: you’ll sign in after adding it."
          />
        </>
      ) : (
        <>
          <div className="grid grid-cols-[2fr_3fr] gap-3">
            <Field label="Command">
              <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" spellCheck={false} className="font-mono text-copy" />
            </Field>
            <Field label="Arguments">
              <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-everything" spellCheck={false} className="font-mono text-copy" />
            </Field>
          </div>
          <span className={cn(FIELD_HINT, '-mt-2')}>Separated by spaces; put one that has spaces in quotes. It runs on this computer, as you.</span>
          <Pairs
            label="Environment (optional)" add="Add a variable" namePlaceholder="API_KEY" valuePlaceholder="value" pairs={env} onChange={setEnv}
            hint="Values stay on this computer, locked with its keychain, and go only to this server."
          />
        </>
      )}
      {error ? <p className="selectable text-ui leading-snug text-danger">{error}</p> : null}
      <FooterActions actions={actions}>
        <Button type="submit" form={actions.formId} variant="primary" icon={edit ? undefined : Plus} loading={busy}>{edit ? 'Save' : 'Add connector'}</Button>
      </FooterActions>
    </form>
  );
}

function hostName(url: string): string {
  try { return new URL(url.trim()).hostname.replace(/^(www|mcp|api)\./, '').split('.')[0] ?? ''; } catch { return ''; }
}

/* -------------------------------------------------------------------- paste */

function PasteForm({ onDone, actions }: { onDone: (first?: Connector) => void; actions: Actions }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const found = useMemo(() => (text.trim() ? parseConnectorImport(text) : null), [text]);
  const add = async () => {
    if (!found?.connectors.length) return;
    setBusy(true);
    const saved: Connector[] = [];
    for (const c of found.connectors) { const s = await saveConnector(c); if (s) saved.push(s); }
    setBusy(false);
    if (!saved.length) return;
    pushToast({ title: saved.length === 1 ? `Added ${saved[0]!.name}` : `Added ${saved.length} connectors`, level: 'success' });
    onDone(saved.length === 1 ? saved[0] : undefined);
  };
  return (
    <form id={actions.formId} className="flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); void add(); }}>
      <Field label="Config" hint="Values in it are kept like the ones you type: on this computer, locked with its keychain.">
        <Textarea
          value={text} onChange={(e) => setText(e.target.value)} minRows={7} autoFocus spellCheck={false} className="font-mono text-ui"
          placeholder={'{\n  "mcpServers": {\n    "everything": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] }\n  }\n}'}
        />
      </Field>
      {found?.connectors.length ? (
        <CardSection title={`Found ${found.connectors.length}`}>
          {found.connectors.map((c, i) => (
            <div key={i} className={cn(SETTINGS_ROW, 'flex items-center gap-3')}>
              <ConnectorIcon connector={c} size={28} />
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className={cn(SETTINGS_ROW_TITLE, 'block truncate')}>{c.name}</span>
                <span className={cn(SETTINGS_ROW_DESCRIPTION, 'block truncate font-mono')}>{c.url ?? [c.command, ...(c.args ?? [])].join(' ')}</span>
              </span>
              <span className="shrink-0 text-note text-muted">{c.transport === 'stdio' ? 'Local' : c.transport === 'sse' ? 'SSE' : 'HTTP'}</span>
            </div>
          ))}
        </CardSection>
      ) : null}
      {found?.problems.length ? <ul className="selectable space-y-1 text-ui leading-snug text-danger">{found.problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
      <FooterActions actions={actions}>
        <Button type="submit" form={actions.formId} variant="primary" icon={Plus} loading={busy} disabled={!found?.connectors.length}>
          {found?.connectors.length === 1 ? 'Add connector' : `Add ${found?.connectors.length || ''} connectors`.replace('  ', ' ')}
        </Button>
      </FooterActions>
    </form>
  );
}

/* --------------------------------------------------------------------- view */

const STATUS_WORDS = { connected: 'Connected', connecting: 'Connecting…', signIn: 'Sign in to use it', error: 'Can’t be reached' } as const;

function ConnectorView({ id, onEdit, onRemoved }: { id: string; onEdit: (c: Connector) => void; onRemoved: () => void }) {
  const c = useConnector(id);
  const bots = useStore((s) => s.bots);
  const [busy, setBusy] = useState<'check' | 'signIn' | 'remove' | null>(null);
  const [confirm, setConfirm] = useState(false);
  if (!c) return <p className="text-ui text-muted">This connector was removed.</p>;
  const on = c.tools.filter((t) => t.on).length;
  const allBots = c.bots === 'all';
  const botOn = (botId: string) => allBots || (c.bots as string[]).includes(botId);
  const toggleBot = (botId: string, v: boolean) => {
    const now = allBots ? bots.map((b) => b.id) : (c.bots as string[]);
    void setConnectorBots(c.id, v ? [...new Set([...now, botId])] : now.filter((b) => b !== botId));
  };
  const run = async (what: 'check' | 'signIn', fn: () => Promise<unknown>) => { setBusy(what); await fn(); setBusy(null); };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 selectable truncate font-mono text-note text-muted">{c.url ?? [c.command, ...c.args].join(' ')}</span>
        <Button size="sm" variant="secondary" icon={Pencil} onClick={() => onEdit(c)}>Edit</Button>
      </div>

      <CardSection>
        <div className={cn(SETTINGS_ROW, 'flex items-center gap-3')}>
          <span className="min-w-0 flex-1 space-y-1">
            <span className={cn(SETTINGS_ROW_TITLE, 'flex items-center gap-2')}>
              {c.status === 'connecting' ? <Spinner size={10} /> : <StatusDot tone={TONE[c.status]} />}
              {STATUS_WORDS[c.status]}
            </span>
            <span className={cn(SETTINGS_ROW_DESCRIPTION, 'selectable block', c.status === 'error' && 'text-danger')}>
              {c.status === 'connected'
                ? [c.server ? `${c.server.name}${c.server.version ? ` ${c.server.version}` : ''}` : '', c.account ? `signed in as ${c.account}` : c.signedIn ? 'signed in' : ''].filter(Boolean).join(' · ') || 'Its tools are ready for your bots.'
                : c.status === 'signIn' ? (c.error ?? 'It asks you to sign in. Your browser opens its sign-in page.')
                  : c.status === 'error' ? c.error : c.transport === 'stdio' ? 'Starting it on this computer.' : 'Reaching it.'}
            </span>
          </span>
          {c.status === 'signIn'
            ? <Button size="sm" variant="primary" icon={LogIn} loading={busy === 'signIn'} onClick={() => void run('signIn', () => signInConnector(c.id))}>Sign in</Button>
            : <Button size="sm" variant="secondary" icon={RefreshCw} loading={busy === 'check' || c.status === 'connecting'} onClick={() => void run('check', () => checkConnector(c.id))}>{c.status === 'error' ? 'Try again' : 'Refresh'}</Button>}
          {c.signedIn ? <Button size="sm" variant="ghost" icon={LogOut} onClick={() => void signOutConnector(c.id)}>Sign out</Button> : null}
        </div>
      </CardSection>

      {c.tools.length ? (
        <CardSection title={<span>Tools <span className="font-normal text-muted">· {on === c.tools.length ? c.tools.length : `${on} of ${c.tools.length} on`}</span></span>}>
          <div className="max-h-[264px] overflow-y-auto">
            {c.tools.map((t) => (
              <label key={t.name} className={cn(SETTINGS_ROW, 'flex items-center gap-3 py-2.5')}>
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="block truncate font-mono text-ui text-fg">{t.name}</span>
                  {t.description || t.title ? <span className={cn(SETTINGS_ROW_DESCRIPTION, 'block truncate')}>{t.description ?? t.title}</span> : null}
                </span>
                <Switch checked={t.on} onChange={(v) => void setConnectorTool(c.id, t.name, v)} label={`${t.name} on`} />
              </label>
            ))}
          </div>
        </CardSection>
      ) : null}

      <CardSection title="Bots that can use it">
        <label className={cn(SETTINGS_ROW, 'flex items-center gap-3')}>
          <span className="min-w-0 flex-1 space-y-1">
            <span className={cn(SETTINGS_ROW_TITLE, 'block')}>All bots</span>
            <span className={cn(SETTINGS_ROW_DESCRIPTION, 'block')}>New bots too. Turn it off to choose.</span>
          </span>
          <Switch checked={allBots} onChange={(v) => void setConnectorBots(c.id, v ? 'all' : bots.map((b) => b.id))} label="All bots" />
        </label>
        {allBots ? null : bots.map((b) => (
          <label key={b.id} className={cn(SETTINGS_ROW, 'flex items-center gap-3 py-2.5')}>
            <BotAvatar bot={b} size={22} />
            <span className="min-w-0 flex-1 truncate text-copy text-fg">{b.name}</span>
            <Switch checked={botOn(b.id)} onChange={(v) => toggleBot(b.id, v)} label={`${b.name} can use ${c.name}`} />
          </label>
        ))}
      </CardSection>

      <div className="flex items-center justify-between gap-3">
        <span className="text-note text-muted">{c.transport === 'stdio' ? 'Runs on this computer while AppuBot is open.' : c.transport === 'sse' ? 'Remote, over SSE.' : 'Remote, over streamable HTTP.'}</span>
        {confirm ? (
          <span className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Keep it</Button>
            <Button size="sm" variant="danger" icon={Trash2} loading={busy === 'remove'} onClick={async () => { setBusy('remove'); const ok = await removeConnector(c.id, c.name); setBusy(null); if (ok) onRemoved(); }}>Remove {c.name}</Button>
          </span>
        ) : <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirm(true)}>Remove</Button>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- dialog */

/** The add flow and a connector's page, in one dialog: \`start\` opens it at a step. */
export function ConnectorDialog({ start, onClose }: { start: ConnectorStep; onClose: () => void }) {
  const [step, setStep] = useState<ConnectorStep>(start);
  const viewed = useConnector(step.kind === 'view' ? step.id : undefined);
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const actions: Actions = { at: footer, formId: useId(), onCancel: step.kind === 'form' && step.edit ? () => setStep({ kind: 'view', id: step.edit!.id }) : onClose };
  const back = step.kind === 'form' || step.kind === 'paste' ? (step.kind === 'form' && step.edit ? { kind: 'view' as const, id: step.edit.id } : start.kind === 'menu' ? { kind: 'menu' as const } : null) : null;
  const text = step.kind === 'menu' ? { title: 'Add a connector', description: 'Your own MCP server, for your bots to use.' }
    : step.kind === 'paste' ? { title: 'Paste a config', description: 'AppuBot reads the servers in it; you check them before they’re added.' }
      : step.kind === 'form' ? (step.edit ? { title: `Edit ${step.edit.name}`, description: undefined } : step.transport === 'remote'
        ? { title: 'Remote server', description: 'An MCP server at an address. AppuBot connects to it and offers its tools to your bots.' }
        : { title: 'Local server', description: 'A command this computer starts and talks to. Its tools go to your bots.' })
        : { title: viewed?.name ?? 'Connector', description: undefined };
  return (
    <Dialog
      open
      onClose={onClose}
      size={step.kind === 'view' ? 'lg' : 'md'}
      title={step.kind === 'view' ? (viewed ? <span className="flex items-center gap-3"><ConnectorIcon connector={viewed} size={32} />{viewed.name}</span> : text.title) : back ? (
        <span className="flex items-center gap-1.5">
          <Button variant="ghost" size="icon-sm" icon={ChevronLeft} aria-label="Back" onClick={() => setStep(back)} className="-ml-2" />
          {text.title}
        </span>
      ) : text.title}
      description={text.description}
      footer={step.kind === 'form' || step.kind === 'paste' ? <div ref={setFooter} className="contents" /> : undefined}
    >
      {step.kind === 'menu' ? <Menu go={setStep} />
        : step.kind === 'paste' ? <PasteForm actions={actions} onDone={(first) => (first ? setStep({ kind: 'view', id: first.id }) : onClose())} />
          : step.kind === 'form' ? <ConnectorForm key={step.edit?.id ?? step.transport} transport={step.transport} edit={step.edit} actions={actions} onSaved={(c) => setStep({ kind: 'view', id: c.id })} />
            : <ConnectorView id={step.id} onEdit={(c) => setStep({ kind: 'form', transport: c.transport === 'stdio' ? 'stdio' : 'remote', edit: c })} onRemoved={onClose} />}
    </Dialog>
  );
}
