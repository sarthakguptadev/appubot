// A bot's form card in the chat: `ask_form` (fields the user fills in and sends), `vault_request` (a login, card,
// API key or contact info added to the Vault right here, its secrets never reaching the bot; or one already saved,
// picked), `apps_request` (an app connected, or turned on for the bot, from the card's own buttons: it settles by
// itself once the app is the bot's), `telegram_request` (a Telegram bot's token, typed in here and kept on the
// computer), the routine cards (`create_routine`: the schedule as fields to adjust before allowing it;
// `update_routine`: the change's rows, the new schedule adjustable) and the bot cards (`create_bot`: the bot as it
// would look, its setup as rows, its name a field; `update_bot`: each change as a row, was → now, a shield on what
// grants power). Words and checks in chat-core `forms.ts`; styles share the question card's `.gen-*`.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FormField, FormValue, Part } from '@appubot/protocol';
import { appOn, isDirectApp } from '@appubot/protocol';
import {
  activeSlugs, appCardState, appCardText, fileValue, fileValueName, formAnswerRows, formChangeRows, formDeclinedText, formDeclineLabel, formEyebrow, formProblems,
  codeLength, formSubmitLabel, formTitle, initialFormValues, ratingMax, TELEGRAM_CARD_STEPS, cronToHuman, type FormValues,
} from '@appubot/chat-core';
import type { FormChange } from '@appubot/protocol';
import { ArrowRight, CalendarClock, Check, Contact, Target, CreditCard, FileText, KeyRound, LockKeyhole, Paperclip, Plug, Send, ShieldCheck, Star, X } from '../../components/ui/icons';
import { BotAvatar, Button, DatePicker, FIELD_CLASS, FIELD_SHAPE, Icon, Select, Switch, TimePicker, cn } from '../../components/ui';
import { OtpInput } from '../../components/rare/OtpInput';
import { PasswordInput } from '../../components/rare/PasswordInput';
import { answerForm } from '../../lib/actions';
import { AnsweredExchange, AnsweredLine } from './Answered';
import { errorMessage, upload } from '../../lib/gateway';
import { native } from '../../lib/native';
import { useStore } from '../../lib/store';

import { AppLogo } from '../apps/AppRow';
import { loadConnections, setAppOn, signIn, startConnect, useAppsLive, useAppsUi } from '../apps/appsData';
import { onCloud } from '../apps/cloudApps';

type QuestionPart = Extract<Part, { type: 'question' }>;

const VAULT_ICON = { login: KeyRound, card: CreditCard, apiKey: LockKeyhole, contact: Contact } as const;

/** What the card shows once sent, until the computer's copy of the answer comes back. */
interface Sent { values: FormValues; savedName?: string; declined?: boolean }

function Label({ field, htmlFor }: { field: FormField; htmlFor: string }) {
  return (
    <label htmlFor={htmlFor} className="text-ui font-medium text-fg">
      {field.label}
      {field.required ? <span className="text-muted"> *</span> : null}
    </label>
  );
}

/** A secret (a password, a card number, a key, a token) on Rare UI's PasswordInput; only a password gets the strength meter. */
function SecretInput({ id, value, onChange, placeholder, invalid, disabled, strength }: { id: string; value: string; onChange: (v: string) => void; placeholder?: string; invalid: boolean; disabled: boolean; strength?: boolean }) {
  return <PasswordInput id={id} size="sm" meter="flow" strength={strength} value={value} onChange={onChange} placeholder={placeholder} invalid={invalid} disabled={disabled} />;
}

/** A one-time code a site sent the user, a box a character (Rare UI's OTPInput): it shakes while the form says it is wrong and rings green once whole. */
function CodeInput({ field, id, value, onChange, invalid, disabled }: { field: FormField; id: string; value: string; onChange: (v: FormValue) => void; invalid: boolean; disabled: boolean }) {
  const length = codeLength(field);
  return (
    <OtpInput
      inputId={id}
      length={length}
      type="both"
      size="sm"
      value={value}
      onChange={onChange}
      status={invalid ? 'error' : value.length === length ? 'success' : 'idle'}
      disabled={disabled}
      aria-label={field.label}
    />
  );
}

/**
 * A file the user picks: on this Mac a path through the system dialog (the bot reads the file where it is); on a
 * remote computer (your AppuBot computer) the file is uploaded and sent as `file:<id>:<name>`, which the computer
 * turns into the bot's inbox copy.
 */
function FileInput({ field, id, value, onChange, invalid, disabled }: { field: FormField; id: string; value: string; onChange: (v: FormValue) => void; invalid: boolean; disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const remote = onCloud();
  const filters = field.accept?.length ? [{ name: 'Files', extensions: field.accept.map((e) => e.replace(/^\./, '')) }] : undefined;
  const pick = async () => {
    setProblem(null);
    if (!remote) {
      const paths = await native().pickFiles({ multiple: false, ...(filters ? { filters } : {}) }).catch(() => [] as string[]);
      if (paths[0]) onChange(paths[0]);
      return;
    }
    inputRef.current?.click();
  };
  const uploaded = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      const att = await upload(f, f.name);
      onChange(fileValue(att.id, att.name));
    } catch (e) { setProblem(errorMessage(e)); }
    setBusy(false);
  };
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Button type="button" id={id} size="sm" variant="secondary" loading={busy} disabled={disabled} onClick={() => void pick()} aria-invalid={invalid || undefined}>
        <Icon icon={Paperclip} size={14} />
        {value ? 'Change' : field.placeholder ?? 'Choose a file…'}
      </Button>
      {value ? (
        <span className="flex min-w-0 items-center gap-1 text-ui text-fg">
          <span className="truncate" title={value}>{fileValueName(value)}</span>
          <button type="button" aria-label="Remove file" disabled={disabled} onClick={() => onChange('')} className="ab-pill grid size-5 shrink-0 place-items-center rounded-md text-muted hover:text-fg"><Icon icon={X} size={12} /></button>
        </span>
      ) : null}
      {problem ? <span className="text-note text-danger">{problem}</span> : null}
      {remote ? <input ref={inputRef} type="file" className="hidden" accept={field.accept?.map((e) => `.${e.replace(/^\./, '')}`).join(',')} onChange={(e) => { void uploaded(e.target.files?.[0]); e.target.value = ''; }} /> : null}
    </div>
  );
}

/** 1 to N stars (N = `max`, 5 by default). */
function RatingInput({ field, id, value, onChange, disabled }: { field: FormField; id: string; value: string; onChange: (v: FormValue) => void; disabled: boolean }) {
  const max = ratingMax(field);
  const n = Number(value) || 0;
  const [hover, setHover] = useState(0);
  const lit = hover || n;
  return (
    <div id={id} role="radiogroup" aria-label={field.label} className="flex items-center gap-0.5" onMouseLeave={() => setHover(0)}>
      {Array.from({ length: max }, (_, i) => i + 1).map((i) => (
        <button
          key={i}
          type="button"
          role="radio"
          aria-checked={n === i}
          aria-label={`${i} of ${max}`}
          disabled={disabled}
          onMouseEnter={() => setHover(i)}
          onClick={() => onChange(n === i ? '' : String(i))}
          className={cn('grid size-7 place-items-center rounded-full', i <= lit ? 'text-[var(--ab-accent)]' : 'text-muted/60 hover:text-muted')}
        >
          <Icon icon={Star} size={18} className={i <= lit ? 'fill-current' : undefined} />
        </button>
      ))}
      {n ? <span className="ml-1.5 text-note tabular-nums text-muted">{n} of {max}</span> : null}
    </div>
  );
}

function FieldInput({ field, id, value, onChange, invalid, disabled }: { field: FormField; id: string; value: FormValue | undefined; onChange: (v: FormValue) => void; invalid: boolean; disabled: boolean }) {
  const text = typeof value === 'string' ? value : '';
  const common = { id, disabled, 'aria-invalid': invalid || undefined, placeholder: field.placeholder } as const;
  switch (field.type) {
    case 'file':
      return <FileInput field={field} id={id} value={text} onChange={onChange} invalid={invalid} disabled={disabled} />;
    case 'rating':
      return <RatingInput field={field} id={id} value={text} onChange={onChange} disabled={disabled} />;
    case 'secret':
      return <SecretInput id={id} value={text} onChange={onChange} placeholder={field.placeholder} invalid={invalid} disabled={disabled} strength={field.id === 'password'} />;
    case 'code':
      return <CodeInput field={field} id={id} value={text} onChange={onChange} invalid={invalid} disabled={disabled} />;
    case 'time':
      return <TimePicker id={id} aria-label={field.label} aria-invalid={invalid || undefined} value={text} onChange={onChange} disabled={disabled} />;
    case 'date':
      return <DatePicker id={id} aria-label={field.label} aria-invalid={invalid || undefined} value={text} onChange={onChange} disabled={disabled} />;
    case 'longtext':
      return <textarea {...common} rows={3} value={text} onChange={(e) => onChange(e.target.value)} className={cn(FIELD_CLASS, 'resize-none rounded-control-lg px-3 py-2.5 leading-relaxed [field-sizing:content] max-h-48')} />;
    case 'toggle':
      return <Switch checked={value === true} onChange={onChange} disabled={disabled} label={field.label} />;
    case 'choice':
      if (field.options.length > 5) {
        return (
          <Select id={id} value={text} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
            <option value="">{field.placeholder ?? 'Choose…'}</option>
            {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </Select>
        );
      }
      return (
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-labelledby={id}>
          {field.options.map((o) => (
            <Chip key={o} on={text === o} disabled={disabled} onClick={() => onChange(text === o ? '' : o)}>{o}</Chip>
          ))}
        </div>
      );
    case 'multichoice': {
      const list = Array.isArray(value) ? value : [];
      return (
        <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={id}>
          {field.options.map((o) => (
            <Chip key={o} on={list.includes(o)} disabled={disabled} check onClick={() => onChange(list.includes(o) ? list.filter((x) => x !== o) : [...list, o])}>{o}</Chip>
          ))}
        </div>
      );
    }
    default: {
      const type = field.type === 'phone' ? 'tel' : field.type === 'text' ? 'text' : field.type;
      return <input {...common} type={type} value={text} onChange={(e) => onChange(e.target.value)} className={cn(FIELD_CLASS, FIELD_SHAPE)} />;
    }
  }
}

function Chip({ on, disabled, check, onClick, children }: { on: boolean; disabled: boolean; check?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'gen-choice ab-press ab-pill squircle inline-flex h-8 items-center gap-1.5 rounded-control-sm bg-surface-2 px-3 text-ui font-semibold tracking-ui text-fg enabled:hover:bg-surface-3',
      )}
    >
      {check && on ? <Icon icon={Check} size={12} strokeWidth={2.5} /> : null}
      {children}
    </button>
  );
}

/**
 * The rows of a bot or routine card: a new bot's setup (label: value), or a change's was → now, with a shield on what
 * grants the bot power (computer use, an app, Full access, another agent). Long values (instructions, a prompt) scroll.
 */
function ChangeRows({ rows, compact }: { rows: FormChange[]; compact?: boolean }) {
  if (!rows.length) return null;
  return (
    <dl className={cn('flex flex-col overflow-hidden rounded-card bg-surface-2', compact ? 'divide-y divide-border/60' : 'divide-y divide-border/60')}>
      {rows.map((r) => (
        <div key={r.label} className={cn('grid gap-x-3 px-3.5', compact ? 'grid-cols-[minmax(0,2fr)_minmax(0,3fr)] py-1.5' : 'grid-cols-[minmax(0,2fr)_minmax(0,3fr)] py-2')}>
          <dt className="flex min-w-0 items-center gap-1.5 text-ui text-muted">
            {r.grants ? <Icon icon={ShieldCheck} size={13} className="shrink-0 text-[var(--ab-accent)]" aria-label="Grants more" /> : null}
            <span className="truncate">{r.label}</span>
          </dt>
          <dd className="flex min-w-0 flex-col gap-0.5 text-copy">
            {r.was !== undefined ? (
              <span className="max-h-16 min-w-0 overflow-y-auto break-words whitespace-pre-wrap text-muted line-through decoration-muted/60">{r.was}</span>
            ) : null}
            <span className="flex min-w-0 items-start gap-1.5">
              {r.was !== undefined ? <Icon icon={ArrowRight} size={12} className="mt-1 shrink-0 text-muted" aria-label="becomes" /> : null}
              <span className={cn('min-w-0 flex-1 overflow-y-auto break-words font-medium whitespace-pre-wrap text-fg', compact ? 'max-h-20' : 'max-h-40')}>{r.value}</span>
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A bot card's head: the bot as it would look, who asks, its name (a field on a new bot) and its job. */
function BotCardHead({ part, botName, expired, name, setName, problem, disabled }: { part: QuestionPart; botName: string; expired: boolean; name?: string; setName?: (v: string) => void; problem?: string; disabled: boolean }) {
  const form = part.form!;
  const b = form.bot!;
  const look = b.characterId ? { shape: b.shape ?? 'circle', color: b.color ?? '#8E8E93', characterId: b.characterId } : undefined;
  const id = `${part.questionId}-name`;
  return (
    <div className="flex items-start gap-3">
      <BotAvatar bot={look} shape={look ? undefined : b.shape} color={look ? undefined : b.color} size={40} mood="rest" cheer={false} className="mt-0.5 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-note text-muted">{formEyebrow(form, botName, expired)}</span>
        {setName ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={id} className="sr-only">Name</label>
            <input
              id={id}
              value={name ?? ''}
              disabled={disabled}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!!problem || undefined}
              placeholder="Name"
              className={cn(FIELD_CLASS, FIELD_SHAPE, 'max-w-64 font-semibold')}
            />
            {problem ? <span className="text-note text-danger">{problem}</span> : null}
          </div>
        ) : <span className="text-copy leading-snug font-semibold text-fg">{formTitle(part)}</span>}
        {b.action === 'create' && b.job?.trim() ? <span className="text-ui leading-snug text-muted">{b.job.trim()}</span> : null}
      </div>
    </div>
  );
}

/**
 * A form once it is answered: no card (Answered.tsx). A plain form reads as the conversation it was: what was asked
 * as the bot's bubble, what you sent as yours (a secret as dots). A decision or a setup step (a Vault item, an app or
 * Telegram connected, a bot, routine or goal allowed, any of them declined) leaves one quiet line.
 */
function AnsweredForm({ part, sent, botColor }: { part: QuestionPart; sent: Sent | null; botColor?: string }) {
  const form = part.form!;
  const declined = part.declined ?? sent?.declined ?? false;
  const values = part.values ?? sent?.values ?? {};
  if (form.kind === 'form') {
    const rows = declined ? [] : formAnswerRows(form.fields, values);
    const answer = declined ? formDeclinedText(form) : rows.length ? rows.map((r) => `${r.label}: ${r.value}`).join('\n') : 'Sent';
    return <AnsweredExchange ask={formTitle(part)} answer={answer} botColor={botColor} />;
  }
  const savedName = sent?.savedName ?? form.vault?.saved.find((s) => s.id === part.savedId)?.name;
  // what it was about: the bot, the routine, the goal, what was turned down
  const about = form.kind === 'bot' ? ((values.name as string | undefined)?.trim() || form.bot?.name)
    : form.kind === 'routine' ? formTitle(part)
      : form.kind === 'goal' ? ((values.objective as string | undefined)?.trim() || form.fields.find((f) => f.id === 'objective')?.value)
        : form.kind === 'app' ? form.app?.name
          : form.kind === 'telegram' ? 'Telegram'
            : 'the Vault';
  const said = part.answer?.trim().replace(/\s*\n+\s*/g, ' ');
  const text = declined ? `${formDeclinedText(form)}${about ? ` · ${about}` : ''}`
    : form.kind === 'vault' ? (said ?? (savedName ? `Chose “${savedName}” from the Vault` : 'Saved to the Vault'))
      : form.kind === 'app' ? (said ?? `Connected ${form.app?.name ?? ''}`.trim())
        : form.kind === 'telegram' ? (said ?? 'Connected')
          // the computer's own words name what was allowed ("Allowed: Weekly digest, every Thursday at 17:00"); anything
          // else (an older computer, an answer in words) is said here
          : said && /^allowed\b.{3,}/i.test(said) ? said : `Allowed${about ? ` · ${about}` : ''}`;
  return <AnsweredLine declined={declined} text={text} />;
}

/**
 * An app card: no fields, buttons for where the app stands right now (sign in to Apps, connect it, turn it on for the
 * bot), read live from the Composio status, the connections and the bot; once connected and on, the computer settles
 * the card by itself (`apps.updated`), so nothing is sent here but a decline.
 */
function AppCardBody({ part, botName, botId, expired, onDecline, busy }: { part: QuestionPart; botName: string; botId?: string; expired: boolean; onDecline: () => void; busy: boolean }) {
  const app = part.form!.app!;
  useAppsLive();
  const apps = useStore((s) => s.apps);
  const bot = useStore((s) => (botId ? s.bots.find((b) => b.id === botId) : undefined));
  const conns = useAppsUi((s) => s.connections);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { if (apps?.configured || apps?.direct) void loadConnections(); }, [apps?.configured, apps?.direct]);
  const live = {
    // an app on its own server needs no Composio sign-in
    signedIn: isDirectApp(app.slug) || (apps ? apps.configured : app.state !== 'sign-in'),
    // connected means a connection that works: a signed-out one gets the Connect button again
    connected: conns ? activeSlugs(conns).includes(app.slug) : app.state === 'turn-on',
    on: bot ? appOn(bot, app.slug) : app.state !== 'turn-on',
  };
  const state = appCardState(live);
  const pending = !!apps?.pending.includes(app.slug);
  const text = appCardText(state, app.name, botName);
  const act = async () => {
    setProblem(null);
    setWorking(true);
    try {
      if (state === 'sign-in') { useAppsUi.setState({ afterSignIn: { slug: app.slug, name: app.name, logo: app.logo, categories: [], authKind: 'oauth' } }); await signIn(); }
      else if (state === 'connect') await startConnect({ slug: app.slug, name: app.name, logo: app.logo, categories: [], authKind: 'oauth' });
      else if (state === 'turn-on' && bot) await setAppOn(bot, app.slug, true);
    } catch (e) { setProblem(errorMessage(e)); }
    setWorking(false);
  };
  return (
    <>
      <div className="flex items-start gap-3">
        <AppLogo toolkit={app} size={40} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-note text-muted">{formEyebrow(part.form!, botName, expired)}</span>
          <span className="text-copy leading-snug font-semibold text-fg">{app.name}</span>
          {app.reason ? <span className="text-ui leading-snug text-muted">{app.reason}</span> : null}
        </div>
      </div>
      <p className="text-ui leading-snug text-muted">{pending ? `Finish signing in to ${app.name} in your browser…` : text.line}</p>
      {problem ? <p className="text-note text-danger" role="alert">{problem}</p> : null}
      {expired ? <p className="text-note text-muted">This ended without an answer.</p> : (
        <div className="flex items-center gap-2 pt-0.5">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-note text-muted">
            <Icon icon={Plug} size={13} className="shrink-0" />
            <span className="min-w-0">Through your own Composio account. You can turn it off for {botName} any time.</span>
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={onDecline} loading={busy} disabled={busy || working}>Decline</Button>
          {state === 'ready'
            ? <span className="flex items-center gap-1 text-ui font-medium text-fg"><Icon icon={Check} size={14} /> Connected</span>
            : <Button type="button" variant="primary" size="sm" onClick={() => void act()} loading={working} disabled={busy || (state === 'turn-on' && !bot)}>{pending ? 'Open the page again' : text.button}</Button>}
        </div>
      )}
    </>
  );
}

/** `expired`: the turn ended without an answer, so the card no longer goes anywhere. `botId`: the card's bot (an app card switches its apps). */
export function FormCard({ part, botName, botId, botColor, expired }: { part: QuestionPart; botName: string; botId?: string; botColor?: string; expired: boolean }) {
  const form = part.form!;
  const vault = form.kind === 'vault' ? form.vault : undefined;
  const [values, setValues] = useState<FormValues>(() => initialFormValues(form.fields));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState<'send' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverProblems, setServerProblems] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<Sent | null>(null);
  const [mode, setMode] = useState<'new' | 'saved'>(() => (vault?.saved.length ? 'saved' : 'new'));
  const [picked, setPicked] = useState<string | null>(null);
  // a routine change's schedule fields stay folded until asked for: the rows already say what moves
  const [adjusting, setAdjusting] = useState(false);

  // the computer's answered copy came back: the card's own memory of it is no longer needed
  useEffect(() => { if (part.answer !== undefined) setSent(null); }, [part.answer]);

  const problems = useMemo(() => ({ ...formProblems(form, values), ...serverProblems }), [form, values, serverProblems]);
  const answered = part.answer !== undefined || !!sent;
  if (answered) return <AnsweredForm part={part} sent={sent} botColor={botColor} />;

  const disabled = expired || !!busy;
  const set = (id: string, v: FormValue) => {
    setValues((s) => ({ ...s, [id]: v }));
    setServerProblems((s) => { if (!(id in s)) return s; const n = { ...s }; delete n[id]; return n; });
    setError(null);
  };

  const send = async () => {
    if (disabled) return;
    if (mode === 'saved' && vault) {
      if (!picked) { setError('Pick one, or add a new one.'); return; }
      setBusy('send');
      const r = await answerForm(part.questionId, {}, { savedId: picked });
      setBusy(null);
      if (r.ok) setSent({ values: {}, savedName: vault.saved.find((s) => s.id === picked)?.name });
      else setError(r.message);
      return;
    }
    setTried(true);
    if (Object.keys(formProblems(form, values)).length) return;
    setBusy('send');
    const r = await answerForm(part.questionId, values);
    setBusy(null);
    if (r.ok) setSent({ values });
    else { setError(r.message); setServerProblems(r.problems ?? {}); }
  };

  const decline = async () => {
    if (disabled) return;
    setBusy('decline');
    const r = await answerForm(part.questionId, {}, { decline: true });
    setBusy(null);
    if (r.ok) setSent({ values: {}, declined: true });
    else setError(r.message);
  };

  if (form.kind === 'app' && form.app) {
    return (
      <section aria-label={part.question} className="chat-generative glass-raised squircle w-full max-w-[34rem] overflow-hidden rounded-card">
        <div className="flex flex-col gap-3.5 px-4 pt-3.5 pb-3.5">
          <AppCardBody part={part} botName={botName} botId={botId} expired={expired} onDecline={() => void decline()} busy={busy === 'decline'} />
        </div>
      </section>
    );
  }

  const VaultIcon = vault ? VAULT_ICON[vault.kind] : form.kind === 'telegram' ? Send : form.kind === 'routine' ? CalendarClock : form.kind === 'goal' ? Target : FileText;
  const reason = vault?.reason ?? form.telegram?.reason;
  const isBot = form.kind === 'bot' && !!form.bot;
  const nameField = isBot ? form.fields.find((f) => f.id === 'name') : undefined;
  const changeRows = formChangeRows(form);
  const routineUpdate = form.kind === 'routine' && form.routine?.action === 'update';
  return (
    <section aria-label={part.question} className="chat-generative glass-raised squircle w-full max-w-[34rem] overflow-hidden rounded-card">
      <form
        className="flex flex-col gap-3.5 px-4 pt-3.5 pb-3.5"
        noValidate
        onSubmit={(e) => { e.preventDefault(); void send(); }}
      >
        {isBot ? (
          <BotCardHead
            part={part} botName={botName} expired={expired} disabled={disabled}
            {...(nameField ? { name: typeof values.name === 'string' ? values.name : '', setName: (v: string) => set('name', v), problem: tried || serverProblems.name ? problems.name : undefined } : {})}
          />
        ) : (
          <div className="flex items-start gap-3">
            <span className="ab-pill mt-0.5 grid size-8 shrink-0 place-items-center rounded-control-lg bg-surface-2 text-fg"><Icon icon={VaultIcon} size={16} /></span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-note text-muted">{formEyebrow(form, botName, expired)}</span>
              <span className="block max-h-40 overflow-y-auto text-copy leading-snug font-semibold whitespace-pre-wrap break-words text-fg">{formTitle(part)}</span>
              {reason ? <span className="text-ui leading-snug text-muted">{reason}</span> : null}
              {form.kind === 'routine' && form.routine && !routineUpdate ? <span className="text-note text-muted">Proposed: {cronToHuman(form.routine.schedule)}</span> : null}
            </div>
          </div>
        )}
        {changeRows.length ? <ChangeRows rows={changeRows} /> : null}

        {form.kind === 'telegram' ? (
          <ol className="flex flex-col gap-1 rounded-card bg-surface-2 px-3.5 py-2.5 text-ui text-muted">
            {TELEGRAM_CARD_STEPS.map((step, i) => <li key={step} className="flex gap-2"><span className="tabular-nums text-fg">{i + 1}.</span><span>{step}</span></li>)}
          </ol>
        ) : null}
        {form.kind === 'routine' && form.routine && !routineUpdate ? (
          <blockquote className="max-h-32 overflow-y-auto rounded-card border-l-2 border-border bg-surface-2 px-3.5 py-2.5 text-ui leading-snug whitespace-pre-wrap text-fg">
            <span className="mb-1 block text-note text-muted">It will send {botName} this, on its own:</span>
            {form.routine.prompt}
          </blockquote>
        ) : null}

        {vault && vault.saved.length ? (
          <div className="ab-pill squircle flex gap-1 self-start rounded-control-sm bg-surface-2 p-0.5 text-note font-medium" role="tablist">
            {(['saved', 'new'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                disabled={disabled}
                onClick={() => { setMode(m); setError(null); }}
                className={cn('ab-pill squircle h-6 rounded-[6px] px-3', mode === m ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg')}
              >
                {m === 'saved' ? `Use one you saved (${vault.saved.length})` : 'Add a new one'}
              </button>
            ))}
          </div>
        ) : null}

        {vault && mode === 'saved' ? (
          <div className="gen-choices flex flex-col gap-1.5" data-unavailable={expired || undefined}>
            {vault.saved.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={picked === s.id}
                disabled={disabled}
                onClick={() => { setPicked(s.id); setError(null); }}
                className="gen-choice ab-press squircle flex w-full items-center gap-3 rounded-card bg-surface-2 px-3 py-2.5 text-left enabled:hover:bg-surface-3"
              >
                <span aria-hidden className="gen-mark" data-checked={picked === s.id || undefined}><span className="gen-mark-dot" /></span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-copy font-medium text-fg">{s.name}</span>
                  {s.detail ? <span className="truncate text-note text-muted">{s.detail}</span> : null}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className={cn('grid grid-cols-1 gap-3', ((isBot && form.fields.every((f) => f.id === 'name')) || (routineUpdate && !adjusting && !Object.keys(problems).length)) && 'hidden')}>
            {form.fields.filter((f) => !(isBot && f.id === 'name')).map((f) => {
              const id = `${part.questionId}-${f.id}`;
              const problem = tried || serverProblems[f.id] ? problems[f.id] : undefined;
              const inline = f.type === 'toggle';
              return (
                <div key={f.id} className={cn('flex gap-1.5', inline ? 'items-center justify-between' : 'flex-col')}>
                  <Label field={f} htmlFor={id} />
                  <FieldInput field={f} id={id} value={values[f.id]} onChange={(v) => set(f.id, v)} invalid={!!problem} disabled={disabled} />
                  {problem ? <span className="text-note text-danger">{problem}</span> : f.hint ? <span className="text-note text-muted">{f.hint}</span> : null}
                </div>
              );
            })}
          </div>
        )}

        {routineUpdate && !adjusting && !expired && form.fields.length ? (
          <button type="button" onClick={() => setAdjusting(true)} className="self-start text-ui font-medium text-fg underline-offset-2 hover:underline">Adjust the schedule…</button>
        ) : null}
        {error ? <p className="text-note text-danger" role="alert">{error}</p> : null}
        {expired ? <p className="text-note text-muted">This ended without an answer.</p> : (
          <div className="flex items-center gap-2 pt-0.5">
            {vault ? (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-note text-muted">
                <Icon icon={ShieldCheck} size={13} className="shrink-0" />
                <span className="min-w-0">{mode === 'saved' ? `${botName} may use it in this chat, without seeing its secrets.` : `Goes straight into your Vault. ${botName} never sees it.`}</span>
              </span>
            ) : form.kind === 'telegram' ? (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-note text-muted">
                <Icon icon={ShieldCheck} size={13} className="shrink-0" />
                <span className="min-w-0">The token stays on this computer. {botName} never sees it.</span>
              </span>
            ) : form.kind === 'routine' ? (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-note text-muted">
                <Icon icon={CalendarClock} size={13} className="shrink-0" />
                <span className="min-w-0">Runs on its own until you turn it off in Routines.</span>
              </span>
            ) : isBot ? (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-note text-muted">
                <Icon icon={ShieldCheck} size={13} className="shrink-0" />
                <span className="min-w-0">{form.bot!.action === 'create' ? 'You can change or delete it any time in its settings.' : 'You can change it back any time in its settings.'}</span>
              </span>
            ) : <span className="flex-1" />}
            <Button type="button" variant="ghost" size="sm" onClick={() => void decline()} loading={busy === 'decline'} disabled={disabled}>{formDeclineLabel(form)}</Button>
            <Button type="submit" variant="primary" size="sm" loading={busy === 'send'} disabled={disabled}>
              {vault && mode === 'saved' ? 'Use this one' : formSubmitLabel(form)}
            </Button>
          </div>
        )}
      </form>
    </section>
  );
}
