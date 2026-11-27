import { useId, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ENDPOINT_PRESETS, type EndpointKind, type ModelEndpoint } from '@appubot/protocol';
import { Bot, Check, ChevronLeft, ChevronRight, Globe, HardDrive, Plus, Search, type IconComponent } from '../../components/ui/icons';
import { Button, CardSection, Dialog, FIELD_LABEL, Field, Icon, Input, SETTINGS_CARD, SETTINGS_ROW, SETTINGS_ROW_BUTTON, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE, Textarea, cn } from '../../components/ui';
import { call } from '../../lib/actions';
import { useThisComputer } from '../cloud/thisComputer';
import { byId, pushToast, setState, upsertBy, useStore } from '../../lib/store';
import { refreshProviders } from './ProviderRow';
import { reloadEndpoints } from './endpoints';

/*
 * Settings › Agents › Add custom: models for OpenCode (Ollama, LM Studio, any OpenAI-compatible server: `endpoints.*`,
 * handed to OpenCode as providers of its own) or an agent of its own (any command that speaks ACP over stdio:
 * `providers.upsert`). One dialog: the menu, then the chosen form, with a way back.
 */

type Step = { kind: 'menu' } | { kind: 'endpoint'; type: EndpointKind; edit?: ModelEndpoint } | { kind: 'agent' };

/** Where a form puts its buttons: the dialog's footer (`at`), submitting the form by its id like every dialog's. */
interface Actions { at: HTMLElement | null; formId: string; onCancel: () => void }

/** A form's buttons in the dialog's footer, Cancel before them. */
function FooterActions({ actions, children }: { actions: Actions; children: ReactNode }) {
  if (!actions.at) return null;
  return createPortal(<><Button variant="ghost" onClick={actions.onCancel}>Cancel</Button>{children}</>, actions.at);
}

const ENDPOINT_ROWS: { type: EndpointKind; title: string; description: string; icon: IconComponent }[] = [
  { type: 'ollama', title: 'Ollama', description: 'Local models at 127.0.0.1:11434.', icon: HardDrive },
  { type: 'lmstudio', title: 'LM Studio', description: 'Local models at 127.0.0.1:1234.', icon: HardDrive },
  { type: 'openai', title: 'OpenAI-compatible endpoint', description: 'Any server that has the OpenAI chat API.', icon: Globe },
];

function MenuRow({ icon, title, description, onClick }: { icon: IconComponent; title: string; description: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cn(SETTINGS_ROW, SETTINGS_ROW_BUTTON)}>
      <Icon icon={icon} size={16} className="shrink-0 self-start mt-0.5 text-muted" />
      <span className="min-w-0 flex-1 space-y-1">
        <span className={cn(SETTINGS_ROW_TITLE, 'block')}>{title}</span>
        <span className={cn(SETTINGS_ROW_DESCRIPTION, 'block truncate')}>{description}</span>
      </span>
      <Icon icon={ChevronRight} size={16} className="shrink-0 text-muted" />
    </button>
  );
}

/** The choices as Settings draws a page: a titled card each for models and agents, one row per kind. */
function Menu({ go }: { go: (s: Step) => void }) {
  return (
    <div className="flex flex-col gap-5">
      <CardSection title="Models">
        {ENDPOINT_ROWS.map((r) => <MenuRow key={r.type} icon={r.icon} title={r.title} description={r.description} onClick={() => go({ kind: 'endpoint', type: r.type })} />)}
      </CardSection>
      <CardSection title="Agents">
        <MenuRow icon={Bot} title="Custom ACP agent" description="Cursor, Copilot CLI, Qwen Code, Goose and others." onClick={() => go({ kind: 'agent' })} />
      </CardSection>
    </div>
  );
}

/** OpenCode runs the custom models: switched on when it's installed, else a line saying how to get it. */
async function makeOpenCodeReady(): Promise<string | undefined> {
  const oc = useStore.getState().providers.find((p) => p.id === 'opencode');
  if (!oc || !oc.installed) return 'Install OpenCode to use them: Settings › Agents › OpenCode › Install.';
  if (oc.enabled) return undefined;
  const res = await call('providers.upsert', {
    id: oc.id, name: oc.name, description: oc.description, command: oc.command, args: oc.args, env: oc.env, icon: oc.icon, enabled: true, installHint: oc.installHint,
  });
  if (res) setState((s) => ({ providers: upsertBy(s.providers, res, byId) }));
  return undefined;
}

function EndpointForm({ type, edit, onDone, actions }: { type: EndpointKind; edit?: ModelEndpoint; onDone: () => void; actions: Actions }) {
  const preset = ENDPOINT_PRESETS[type];
  const [name, setName] = useState(edit?.name ?? preset.name);
  const [baseUrl, setBaseUrl] = useState(edit?.baseUrl ?? preset.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [found, setFound] = useState<string[] | null>(edit ? edit.models : null);
  const [picked, setPicked] = useState<Set<string>>(new Set(edit?.models ?? []));
  const [filter, setFilter] = useState('');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string>();
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const local = type !== 'openai';
  const computer = useThisComputer();

  const probe = async () => {
    if (!baseUrl.trim()) return setError('Enter the server’s address.');
    setProbing(true);
    setError(undefined);
    const r = await call('endpoints.probe', { id: edit?.id, baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined }, { errorTitle: 'Could not reach the server' });
    setProbing(false);
    if (!r) return;
    if (!r.ok) return setError(r.error ?? 'The server didn’t list any models.');
    setBaseUrl(r.baseUrl);
    // what was picked before stays picked, plus what was typed in by hand
    const extra = [...picked].filter((m) => !r.models.includes(m));
    setFound([...r.models, ...extra]);
    // a local server's handful of models all go in; a big hosted list waits for a pick
    if (!picked.size && r.models.length <= 20) setPicked(new Set(r.models));
  };

  const addTyped = () => {
    const m = typed.trim();
    if (!m) return;
    setFound((f) => (f?.includes(m) ? f : [...(f ?? []), m]));
    setPicked((s) => new Set(s).add(m));
    setTyped('');
  };

  const toggle = (m: string) => setPicked((s) => {
    const next = new Set(s);
    if (next.has(m)) next.delete(m); else next.add(m);
    return next;
  });

  const save = async () => {
    if (!name.trim()) return setError('Give it a name.');
    if (!picked.size) return setError('Pick at least one model.');
    setSaving(true);
    setError(undefined);
    const res = await call('endpoints.save', {
      id: edit?.id, kind: type, name: name.trim(), baseUrl: baseUrl.trim(), models: [...picked],
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    }, { errorTitle: `Could not save ${name.trim()}` });
    if (!res) return setSaving(false);
    const hint = await makeOpenCodeReady();
    await Promise.all([reloadEndpoints(), refreshProviders()]);
    setSaving(false);
    pushToast({
      title: edit ? `Saved ${res.name}` : `Added ${res.name}`,
      body: hint ?? `${res.models.length === 1 ? 'Its model is' : `Its ${res.models.length} models are`} in OpenCode’s model list.`,
      level: hint ? 'warning' : 'success',
    });
    onDone();
  };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (found ?? []).filter((m) => !q || m.toLowerCase().includes(q));
  }, [found, filter]);

  return (
    <form id={actions.formId} className="flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); void (found ? save() : probe()); }}>
      {type === 'openai' ? (
        <Field label="Name" hint="How it shows in OpenCode's model list.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My server" maxLength={40} autoFocus />
        </Field>
      ) : null}
      <Field label="Address" hint={local ? `Where ${preset.name} serves its OpenAI-compatible API on ${computer.name}.` : 'Its OpenAI-compatible base address, usually ending in /v1.'}>
        <Input
          value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setFound(edit ? found : null); }}
          placeholder="https://example.com/v1" spellCheck={false} className="font-mono text-copy" autoFocus={local}
        />
      </Field>
      <Field label={local ? 'API key (optional)' : 'API key'} hint={`Stays on ${computer.name}, readable only by you, and goes only to OpenCode.`}>
        <Input
          type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)}
          placeholder={edit?.keySaved ? 'Saved: enter a new one to replace it' : local ? 'Only if the server asks for one' : 'sk-…'}
          className="font-mono text-copy"
        />
      </Field>

      {found ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className={FIELD_LABEL}>Models <span className="font-normal text-muted">· {picked.size} of {found.length} picked</span></span>
            <div className="flex items-center gap-1">
              <Button size="xs" variant="ghost" onClick={() => setPicked(new Set(shown.length ? [...picked, ...shown] : picked))}>Pick all</Button>
              <Button size="xs" variant="ghost" onClick={() => setPicked(new Set([...picked].filter((m) => !shown.includes(m))))}>None</Button>
            </div>
          </div>
          {found.length > 8 ? (
            <div className="relative">
              <Icon icon={Search} size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search models" className="h-8 pl-8 text-copy" />
            </div>
          ) : null}
          <div className={cn(SETTINGS_CARD, 'max-h-56 overflow-y-auto')}>
            {shown.length ? shown.map((m) => (
              <button
                key={m} type="button" onClick={() => toggle(m)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-copy hover:bg-[color-mix(in_srgb,var(--ab-fg)_4%,transparent)]"
              >
                <span className={cn('ab-pill flex size-4 shrink-0 items-center justify-center rounded-[5px] border', picked.has(m) ? 'border-accent bg-accent text-white' : 'border-border')}>
                  {picked.has(m) ? <Icon icon={Check} size={11} strokeWidth={2.6} /> : null}
                </span>
                <span className="min-w-0 truncate font-mono text-ui text-fg">{m}</span>
              </button>
            )) : <p className="px-3 py-3 text-ui text-muted">No model matches.</p>}
          </div>
          <div className="flex gap-2">
            <Input
              value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Add a model by its name" spellCheck={false}
              className="h-8 flex-1 font-mono text-ui"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTyped(); } }}
            />
            <Button size="sm" variant="outline" icon={Plus} disabled={!typed.trim()} onClick={addTyped}>Add</Button>
          </div>
        </div>
      ) : null}

      {error ? <p className="selectable text-ui leading-snug text-danger">{error}</p> : null}
      <FooterActions actions={actions}>
        {found ? <Button variant="ghost" className="order-first mr-auto" loading={probing} onClick={() => void probe()}>Find models again</Button> : null}
        {found
          ? <Button type="submit" form={actions.formId} variant="primary" loading={saving} disabled={!picked.size}>{edit ? 'Save' : `Add ${picked.size === 1 ? 'model' : 'models'}`}</Button>
          : <Button type="submit" form={actions.formId} variant="primary" loading={probing}>Find models</Button>}
      </FooterActions>
    </form>
  );
}

function parseEnv(text: string): { env: Record<string, string>; error?: string } {
  const env: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) return { env, error: `"${line}" should look like KEY=value` };
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { env };
}

function AgentForm({ onDone, actions }: { onDone: () => void; actions: Actions }) {
  const providers = useStore((s) => s.providers);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [envText, setEnvText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) return setError('Give the agent a name.');
    if (!command.trim()) return setError('Enter the command that starts it, e.g. my-agent or /usr/local/bin/my-agent.');
    // its id comes from the name, kept clear of the agents already here
    const base = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 32) || 'agent';
    let id = base;
    for (let n = 2; providers.some((p) => p.id === id); n++) id = `${base}-${n}`;
    const { env, error: envError } = parseEnv(envText);
    if (envError) return setError(envError);
    setError(null);
    setBusy(true);
    const res = await call(
      'providers.upsert',
      { id, name: name.trim(), command: command.trim(), args: args.trim() ? args.trim().split(/\s+/) : [], env, enabled: true },
      { errorTitle: 'Could not add the agent', success: `Added ${name.trim()}` },
    );
    setBusy(false);
    if (!res) return;
    setState((s) => ({ providers: upsertBy(s.providers, res, byId) }));
    onDone();
    void refreshProviders();
  };

  return (
    <form id={actions.formId} className="flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Qwen Code" maxLength={40} autoFocus />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Command" hint="Starts the agent, speaking ACP over stdio.">
          <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="qwen" spellCheck={false} className="font-mono text-copy" />
        </Field>
        <Field label="Arguments" hint="Separated by spaces.">
          <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="--acp" spellCheck={false} className="font-mono text-copy" />
        </Field>
      </div>
      <Field label="Environment (optional)" hint="One KEY=value per line.">
        <Textarea value={envText} onChange={(e) => setEnvText(e.target.value)} minRows={3} placeholder={'API_KEY=...\nLOG_LEVEL=info'} spellCheck={false} className="font-mono text-copy" />
      </Field>
      {error ? <p className="selectable text-ui leading-snug text-danger">{error}</p> : null}
      <FooterActions actions={actions}>
        <Button type="submit" form={actions.formId} variant="primary" icon={Plus} loading={busy}>Add agent</Button>
      </FooterActions>
    </form>
  );
}

const STEP_TEXT = {
  menu: { title: 'Add custom', description: 'Models for OpenCode, or an agent of its own.' },
  agent: { title: 'Custom ACP agent', description: 'Any agent that speaks ACP: AppuBot starts it like the others.' },
} as const;

/** `start`: open straight at a form (editing an endpoint); else the menu. */
export function AddCustomDialog({ start, onClose }: { start?: Step; onClose: () => void }) {
  const [step, setStep] = useState<Step>(start ?? { kind: 'menu' });
  const computer = useThisComputer();
  const text = step.kind === 'endpoint'
    ? {
      title: step.edit ? step.edit.name : ENDPOINT_ROWS.find((r) => r.type === step.type)!.title,
      description: step.type === 'openai' ? 'Its models go to OpenCode, next to the ones you sign in to.' : `Models you run on ${computer.name}, through OpenCode.`,
    }
    : STEP_TEXT[step.kind];
  const back = step.kind !== 'menu' && !start;
  // the forms put their buttons in the footer, under its hairline, like every other dialog's
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const actions: Actions = { at: footer, formId: useId(), onCancel: onClose };
  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={
        back ? (
          <span className="flex items-center gap-1.5">
            <Button variant="ghost" size="icon-sm" icon={ChevronLeft} aria-label="Back" onClick={() => setStep({ kind: 'menu' })} className="-ml-2" />
            {text.title}
          </span>
        ) : text.title
      }
      description={text.description}
      footer={step.kind === 'menu' ? undefined : <div ref={setFooter} className="contents" />}
    >
      {step.kind === 'menu' ? <Menu go={setStep} />
        : step.kind === 'agent' ? <AgentForm onDone={onClose} actions={actions} />
        : <EndpointForm key={step.type} type={step.type} edit={step.edit} onDone={onClose} actions={actions} />}
    </Dialog>
  );
}

export type AddCustomStep = Step;
