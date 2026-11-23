/**
 * Form cards: a bot's `ask_form` (fields the user fills in), `vault_request` (a login, card, API key or contact
 * info the user adds to the Vault right in the chat, its secrets never reaching the bot), `apps_request` (connect an
 * app, or turn one on for the bot, from the card's own buttons), `telegram_request` (a Telegram bot's token, typed in
 * on the computer), the routine cards `create_routine` / `update_routine` show (the schedule as fields the user can
 * adjust before allowing it; a change's rows) and the bot cards `create_bot` / `update_bot` show (the bot's look and
 * setup, or each change as a row, allowed or not). The fields of each AppuBot-made card, checking what was typed, and
 * the words an answered card reads back, shared by the computer and both apps.
 */
import { ENV_NAME, FORM_FILE_PREFIX, type FormChange, type FormField, type FormValue, type QuestionForm } from '@appubot/protocol';
import { cronToSpec, SHORT_DAYS, specToCron, timeValue, type ScheduleSpec } from './schedule';

export type VaultFormKind = NonNullable<QuestionForm['vault']>['kind'];
export type FormValues = Record<string, FormValue>;

/** What a Vault card asks for, in the words of its title ("Add a login to your Vault"). */
export const VAULT_FORM_WHAT: Record<VaultFormKind, string> = { login: 'a login', card: 'a card', apiKey: 'an API key', contact: 'contact info' };

/** What a bot's Vault card starts filled in with (its own guesses; never a secret). */
export interface VaultFormPrefill { name?: string; site?: string; username?: string; envName?: string }

/** The fields of a Vault card for a kind: AppuBot's own, so a bot can't ask for a secret in a field of its making. */
export function vaultFormFields(kind: VaultFormKind, prefill: VaultFormPrefill = {}): FormField[] {
  const f = (id: string, label: string, type: FormField['type'], more: Partial<FormField> = {}): FormField => ({ id, label, type, required: false, options: [], ...more });
  const name = f('name', 'Name in the Vault', 'text', { required: true, value: prefill.name, placeholder: 'GitHub' });
  switch (kind) {
    case 'login':
      return [
        name,
        f('site', 'Website or app', 'text', { value: prefill.site, placeholder: 'github.com' }),
        f('username', 'Username or email', 'text', { value: prefill.username }),
        f('password', 'Password', 'secret', { required: true }),
      ];
    case 'card':
      return [
        { ...name, placeholder: 'Work Visa' },
        f('cardholder', 'Name on card', 'text'),
        f('number', 'Card number', 'secret', { required: true, placeholder: '1234 5678 9012 3456' }),
        f('expiry', 'Expiry', 'text', { placeholder: 'MM/YY' }),
        f('cvc', 'Security code', 'secret', { placeholder: 'CVC' }),
      ];
    case 'apiKey':
      return [
        { ...name, placeholder: 'OpenAI' },
        f('envName', 'Variable name', 'text', { required: true, value: prefill.envName, placeholder: 'OPENAI_API_KEY', hint: 'The bot reads the key from this variable, never in the chat.' }),
        f('key', 'Key', 'secret', { required: true }),
      ];
    case 'contact':
      return [
        { ...name, placeholder: 'Home' },
        f('fullName', 'Full name', 'text'),
        f('email', 'Email', 'email'),
        f('phone', 'Phone', 'phone'),
        f('company', 'Company', 'text'),
        f('address1', 'Address', 'text'),
        f('address2', 'Address line 2', 'text'),
        f('city', 'City', 'text'),
        f('region', 'State or region', 'text'),
        f('postalCode', 'Postal code', 'text'),
        f('country', 'Country', 'text'),
      ];
  }
}

/** The contact fields of a Vault card, in the Vault's own `VaultContact` names. */
export const VAULT_CONTACT_FIELDS = ['fullName', 'email', 'phone', 'company', 'address1', 'address2', 'city', 'region', 'postalCode', 'country'] as const;

const asText = (v: FormValue | undefined): string => (typeof v === 'string' ? v.trim() : '');
const isEmpty = (v: FormValue | undefined): boolean => (Array.isArray(v) ? v.length === 0 : typeof v === 'boolean' ? false : asText(v) === '');

/** What's wrong with one field's value, in a few words (undefined: fine). */
export function fieldProblem(field: FormField, value: FormValue | undefined, vault?: VaultFormKind): string | undefined {
  if (isEmpty(value)) return field.required && field.type !== 'toggle' ? 'Required' : undefined;
  const t = asText(value);
  switch (field.type) {
    case 'email': if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return 'Not an email address'; break;
    case 'url': if (!/^(https?:\/\/)?[^\s/]+\.[^\s]+$/i.test(t)) return 'Not a web address'; break;
    case 'number': if (!Number.isFinite(Number(t.replace(/,/g, '')))) return 'Not a number'; break;
    case 'phone': if (!/^\+?[\d\s().-]{5,}$/.test(t)) return 'Not a phone number'; break;
    case 'date': if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return 'Pick a date'; break;
    case 'time': if (!/^\d{1,2}:\d{2}$/.test(t)) return 'Pick a time'; break;
    case 'choice': if (field.options.length && !field.options.includes(t)) return 'Pick one'; break;
    case 'multichoice': if (!Array.isArray(value) || value.some((x) => !field.options.includes(x))) return 'Pick from the list'; break;
    case 'toggle': if (typeof value !== 'boolean') return 'On or off'; break;
    case 'rating': { const n = Number(t); if (!Number.isInteger(n) || n < 1 || n > ratingMax(field)) return `1 to ${ratingMax(field)}`; break; }
    case 'code': if (!/^[A-Za-z0-9]+$/.test(t) || t.length !== codeLength(field)) return `Enter all ${codeLength(field)} characters`; break;
    case 'file': if (!t.startsWith(FORM_FILE_PREFIX) && !/^(\/|[A-Za-z]:\\)/.test(t)) return 'Pick a file'; break;
  }
  if (vault === 'card' && field.id === 'number' && !/^\d{12,19}$/.test(t.replace(/[\s-]/g, ''))) return 'A card number has 12 to 19 digits';
  if (vault === 'card' && field.id === 'expiry' && !/^(0[1-9]|1[0-2])\/\d{2}$/.test(t)) return 'Write it as MM/YY';
  if (vault === 'card' && field.id === 'cvc' && !/^\d{3,4}$/.test(t)) return '3 or 4 digits';
  if (vault === 'apiKey' && field.id === 'envName' && !ENV_NAME.test(t)) return 'Letters, digits and _ only';
  return undefined;
}

/** Every field's problem, by field id (empty: the form can be sent). */
export function formProblems(form: Pick<QuestionForm, 'fields' | 'vault'>, values: FormValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of form.fields) {
    const p = fieldProblem(f, values[f.id], form.vault?.kind);
    if (p) out[f.id] = p;
  }
  return out;
}

/**
 * A form's values cleaned to its fields: unknown ids dropped, text trimmed, a toggle a boolean, a multichoice a list,
 * empty optional fields left out.
 */
export function cleanFormValues(fields: readonly FormField[], values: FormValues): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    const v = values[f.id];
    if (f.type === 'toggle') { out[f.id] = v === true || v === 'true' || v === 'yes'; continue; }
    if (f.type === 'multichoice') {
      const list = Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : [];
      if (list.length) out[f.id] = list.map((x) => x.trim()).filter(Boolean);
      continue;
    }
    const t = Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : (v ?? '');
    const clean = f.type === 'longtext' ? t.replace(/\s+$/, '') : t.trim();
    if (clean) out[f.id] = clean;
  }
  return out;
}

/** The values with every secret field left out (what may be kept in the chat or told to anyone). */
export function withoutSecrets(fields: readonly FormField[], values: FormValues): FormValues {
  const secret = new Set(fields.filter((f) => f.type === 'secret').map((f) => f.id));
  return Object.fromEntries(Object.entries(values).filter(([k]) => !secret.has(k)));
}

/** One value as words: a toggle Yes/No, a multichoice joined, a file by its name. */
export function formValueText(v: FormValue | undefined, field?: Pick<FormField, 'type' | 'max'>): string {
  if (v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.join(', ');
  if (field?.type === 'file') return fileValueName(v);
  if (field?.type === 'rating') return `${v} of ${ratingMax(field)}`;
  return v;
}

/** How many characters a one-time code field takes (6 unless the bot said otherwise; 4 to 8). */
export const codeLength = (field: Pick<FormField, 'max'>): number => Math.min(8, Math.max(4, field.max ?? 6));

/** A rating field's top mark (5 unless the bot said otherwise). */
export const ratingMax = (field: Pick<FormField, 'max'>): number => field.max ?? 5;

/** A file value's name for reading back: the last part of a path; an uploaded file's (`file:<id>:<name>`) name. */
export function fileValueName(v: string): string {
  if (v.startsWith(FORM_FILE_PREFIX)) { const i = v.indexOf(':', FORM_FILE_PREFIX.length); return i > 0 ? v.slice(i + 1) : 'a file'; }
  return v.split(/[\\/]/).filter(Boolean).at(-1) ?? v;
}

/** The value a device sends for a file it uploaded: its id and name, so the card reads it back without a round trip. */
export const fileValue = (id: string, name: string): string => `${FORM_FILE_PREFIX}${id}:${name}`;

/** An uploaded file value's id (`file:<id>:<name>`), or undefined for a path. */
export function fileValueId(v: string): string | undefined {
  if (!v.startsWith(FORM_FILE_PREFIX)) return undefined;
  const rest = v.slice(FORM_FILE_PREFIX.length);
  const i = rest.indexOf(':');
  return (i > 0 ? rest.slice(0, i) : rest) || undefined;
}

/** An answered form's fields read back (label and value), secrets shown as saved, empty ones left out. */
export function formAnswerRows(fields: readonly FormField[], values: FormValues): { label: string; value: string; secret: boolean }[] {
  const rows: { label: string; value: string; secret: boolean }[] = [];
  for (const f of fields) {
    if (f.type === 'secret') { if (values[f.id] !== undefined || f.required) rows.push({ label: f.label, value: '••••••••', secret: true }); continue; }
    const text = formValueText(values[f.id], f);
    if (text) rows.push({ label: f.label, value: text, secret: false });
  }
  return rows;
}

/** A form's answer in a line or a few (the question part's `answer`, what older apps and the chat's previews show). */
export function formAnswerText(fields: readonly FormField[], values: FormValues): string {
  const rows = formAnswerRows(fields, values).filter((r) => !r.secret);
  if (!rows.length) return 'Sent';
  return rows.map((r) => `${r.label}: ${r.value}`).join('\n');
}

/** A form's values as the bot reads them: one `label (id): value` line each, so it knows which is which. */
export function formValuesForBot(fields: readonly FormField[], values: FormValues): string {
  const lines = fields.map((f) => `- ${f.label} (${f.id}): ${values[f.id] === undefined ? '(left empty)' : JSON.stringify(values[f.id])}`);
  return lines.join('\n');
}

/** The words a Vault card's answer reads back: saved, picked or declined. */
export function vaultAnswerText(how: 'saved' | 'picked', name: string): string {
  return how === 'saved' ? `Saved “${name}” to the Vault` : `Chose “${name}” from the Vault`;
}

/** Whether a question part is a form card (answered on the card, not by typing in the composer). */
export const isFormQuestion = (p: { form?: unknown }): boolean => !!p.form;

/** Whether a card is allowed or not (a routine, a bot) rather than sent or declined: its buttons and read-back say so. */
export const isAllowCard = (form: Pick<QuestionForm, 'kind'>): boolean => form.kind === 'routine' || form.kind === 'bot' || form.kind === 'goal';

/** What a form card's submit button says. */
export function formSubmitLabel(form: Pick<QuestionForm, 'kind' | 'submit'>): string {
  if (form.submit?.trim()) return form.submit.trim();
  switch (form.kind) {
    case 'vault': return 'Save to Vault';
    case 'telegram': return 'Connect';
    case 'routine': case 'bot': return 'Allow';
    default: return 'Send';
  }
}

/**
 * A form card's line over its title ("Ada asks", "Ada needs a login", "Ada needs Gmail", "Ada proposes a routine",
 * "Ada wants to make a new bot", "Ada wants to change Bo").
 */
export function formEyebrow(form: Pick<QuestionForm, 'kind' | 'vault' | 'app' | 'routine' | 'bot'>, botName: string, expired: boolean): string {
  if (form.kind === 'vault' && form.vault) return `${botName} ${expired ? 'asked for' : 'needs'} ${VAULT_FORM_WHAT[form.vault.kind]}`;
  if (form.kind === 'app' && form.app) return `${botName} ${expired ? 'asked for' : 'needs'} ${form.app.name}`;
  if (form.kind === 'telegram') return expired ? `${botName} asked to connect Telegram` : `${botName} wants to connect Telegram`;
  if (form.kind === 'routine') {
    const whose = form.routine?.forBot ? ` for ${form.routine.forBot}` : '';
    if (form.routine?.action === 'update') return `${botName} ${expired ? 'proposed' : 'proposes'} a change to a routine${whose}`;
    return `${botName} ${expired ? 'proposed' : 'proposes'} a routine${whose}`;
  }
  if (form.kind === 'goal') return `${botName} ${expired ? 'proposed' : 'proposes'} a goal to work on by itself`;
  if (form.kind === 'bot' && form.bot) {
    const verb = expired ? 'wanted' : 'wants';
    if (form.bot.action === 'create') return `${botName} ${verb} to make a new bot`;
    return `${botName} ${verb} to change ${form.bot.self ? 'itself' : form.bot.name}`;
  }
  return expired ? `${botName} asked` : `${botName} asks`;
}

/** What a card's Decline button says ("Don't allow" for a routine or a bot, "Decline" otherwise). */
export const formDeclineLabel = (form: Pick<QuestionForm, 'kind'>): string => (isAllowCard(form) ? 'Don’t allow' : 'Decline');

/** What an answered card's head says when it was turned down. */
export const formDeclinedText = (form: Pick<QuestionForm, 'kind'>): string => (isAllowCard(form) ? 'Not allowed' : 'Declined');

/** A bot card's one field: the new bot's name, which the user may change before allowing it (an update has none). */
export const botCardFields = (name: string): FormField[] => [{ id: 'name', label: 'Name', type: 'text', required: true, options: [], value: name }];

/** The rows a new bot's card shows under its name: what it is set up as (an empty job or instructions left out). */
export function botCardSetup(bot: NonNullable<QuestionForm['bot']>): FormChange[] {
  const rows: FormChange[] = [];
  if (bot.agent) rows.push({ label: 'Runs on', value: bot.agent, grants: false });
  if (bot.computerUse !== undefined) rows.push({ label: 'Computer use', value: bot.computerUse ? 'On' : 'Off', grants: bot.computerUse });
  if (bot.job?.trim()) rows.push({ label: 'Job', value: bot.job.trim(), grants: false });
  if (bot.instructions?.trim()) rows.push({ label: 'Instructions', value: bot.instructions.trim(), grants: false });
  return rows;
}

/** The rows a card lays out: a new bot's setup, or a change's `changes` (was → value). */
export function formChangeRows(form: Pick<QuestionForm, 'kind' | 'bot' | 'routine'>): FormChange[] {
  if (form.kind === 'bot' && form.bot) return form.bot.action === 'create' ? botCardSetup(form.bot) : form.bot.changes;
  if (form.kind === 'routine' && form.routine) return form.routine.changes;
  return [];
}

/** The line under an allowed or refused bot card. */
export function botCardDoneText(bot: NonNullable<QuestionForm['bot']>, declined: boolean): string {
  const who = bot.self ? 'It' : bot.name;
  if (declined) return bot.action === 'create' ? 'No bot was made.' : `${who} stays as it was.`;
  return bot.action === 'create' ? `${bot.name} is in the sidebar now.` : `${who} has the change now.`;
}

/* ------------------------------------------------------------------ app cards */

/** Where an app card stands: computed live by the apps from the Composio status, the connections and the bot. */
export type AppCardState = 'sign-in' | 'connect' | 'turn-on' | 'ready';

export function appCardState(live: { signedIn: boolean; connected: boolean; on: boolean }): AppCardState {
  if (!live.signedIn) return 'sign-in';
  if (!live.connected) return 'connect';
  return live.on ? 'ready' : 'turn-on';
}

/** An app card's button and the line under it, per state. */
export function appCardText(state: AppCardState, appName: string, botName: string): { button: string; line: string } {
  switch (state) {
    case 'sign-in': return { button: 'Sign in to Apps', line: `Apps run through your own Composio account. Sign in once, then connect ${appName}.` };
    case 'connect': return { button: `Connect ${appName}`, line: `Signs in to ${appName} in your browser. ${botName} then uses it through AppuBot, within what you allow.` };
    case 'turn-on': return { button: `Turn on for ${botName}`, line: `${appName} is connected, but turned off for ${botName}.` };
    case 'ready': return { button: 'Connected', line: `${botName} can use ${appName} now.` };
  }
}

/* ------------------------------------------------------------- Telegram cards */

/** The one field of a Telegram card: the token, a secret typed in on the computer (never a phone, never the bot). */
export const TELEGRAM_FORM_FIELDS: FormField[] = [
  { id: 'token', label: 'Bot token', type: 'secret', required: true, options: [], placeholder: '123456789:AAH…', hint: 'From @BotFather on Telegram.' },
];

/** How to get a token, for the card's steps. */
export const TELEGRAM_CARD_STEPS = [
  'Open Telegram and message @BotFather.',
  'Send /newbot and pick a name and a @handle.',
  'Paste the token it gives you here.',
] as const;

/* -------------------------------------------------------------- routine cards */

const REPEAT = { hourly: 'Every hour', daily: 'Every day', weekdays: 'Weekdays', days: 'Certain days', monthly: 'Monthly' } as const;
type RepeatWords = (typeof REPEAT)[keyof typeof REPEAT];
const WEEK_FROM_MONDAY = [1, 2, 3, 4, 5, 6, 0] as const;
const RESULTS = { notify: 'Notify me when done', thread: 'Keep them in the chat' } as const;

/**
 * The fields of a routine card from the schedule the bot proposed (a cron the editor can't express keeps its cron in
 * an Advanced field), prefilled, so the user adjusts the time or days before allowing it.
 */
export function routineFormFields(o: { name: string; schedule: string; deliverTo: 'notify' | 'thread' }): FormField[] {
  const spec = cronToSpec(o.schedule);
  const f = (id: string, label: string, type: FormField['type'], more: Partial<FormField> = {}): FormField => ({ id, label, type, required: false, options: [], ...more });
  const fields: FormField[] = [f('name', 'Name', 'text', { required: true, value: o.name })];
  if (spec.kind === 'custom') {
    fields.push(f('cron', 'Schedule (cron)', 'text', { required: true, value: spec.cron, hint: 'Minute, hour, day of month, month, day of week.' }));
  } else {
    fields.push(f('repeat', 'Repeat', 'choice', { required: true, options: Object.values(REPEAT), value: REPEAT[spec.kind] }));
    if (spec.kind === 'hourly') fields.push(f('minute', 'At minute', 'number', { required: true, value: String(spec.minute), hint: '0 to 59' }));
    else fields.push(f('time', 'At', 'time', { required: true, value: timeValue(spec.hour, spec.minute) }));
    const days = spec.kind === 'days' ? spec.days : spec.kind === 'weekdays' ? [1, 2, 3, 4, 5] : [];
    fields.push(f('days', 'On', 'multichoice', { options: WEEK_FROM_MONDAY.map((d) => SHORT_DAYS[d]), value: days.map((d) => SHORT_DAYS[d]).join(','), hint: 'For “Certain days”.' }));
    fields.push(f('day', 'Day of the month', 'number', { value: spec.kind === 'monthly' ? String(spec.day) : undefined, hint: 'For “Monthly”: 1 to 31.' }));
  }
  fields.push(f('results', 'Results', 'choice', { required: true, options: Object.values(RESULTS), value: RESULTS[o.deliverTo] }));
  return fields;
}

/** A routine card's answer read as a schedule (`problems` by field id when it can't be). */
export function routineFormSpec(values: FormValues): { spec: ScheduleSpec; deliverTo: 'notify' | 'thread'; name: string } | { problems: Record<string, string> } {
  const text = (id: string) => (typeof values[id] === 'string' ? (values[id] as string).trim() : '');
  const problems: Record<string, string> = {};
  const name = text('name');
  if (!name) problems.name = 'Required';
  const deliverTo = text('results') === RESULTS.thread ? 'thread' : 'notify';
  let spec: ScheduleSpec | undefined;
  if (text('cron')) spec = { kind: 'custom', cron: text('cron') };
  else {
    const repeat = text('repeat') as RepeatWords;
    const kind = (Object.keys(REPEAT) as (keyof typeof REPEAT)[]).find((k) => REPEAT[k] === repeat);
    if (!kind) problems.repeat = 'Pick one';
    const tm = /^(\d{1,2}):(\d{2})$/.exec(text('time'));
    const hour = tm ? Number(tm[1]) : NaN, minute = tm ? Number(tm[2]) : NaN;
    if (kind === 'hourly') {
      const m = Number(text('minute'));
      if (!Number.isInteger(m) || m < 0 || m > 59) problems.minute = '0 to 59'; else spec = { kind, minute: m };
    } else if (kind) {
      if (!tm || hour > 23 || minute > 59) problems.time = 'Pick a time';
      else if (kind === 'days') {
        const picked = Array.isArray(values.days) ? values.days : [];
        const days = picked.map((d) => SHORT_DAYS.indexOf(d as (typeof SHORT_DAYS)[number])).filter((d) => d >= 0);
        if (!days.length) problems.days = 'Pick the days'; else spec = { kind, days, hour, minute };
      } else if (kind === 'monthly') {
        const day = Number(text('day'));
        if (!Number.isInteger(day) || day < 1 || day > 31) problems.day = '1 to 31'; else spec = { kind, day, hour, minute };
      } else spec = { kind, hour, minute };
    }
  }
  if (Object.keys(problems).length || !spec) return { problems: Object.keys(problems).length ? problems : { repeat: 'Pick one' } };
  return { spec, deliverTo, name };
}

/** A routine card's schedule back as cron. */
export const routineFormCron = (spec: ScheduleSpec): string => specToCron(spec);

/** The values a form starts with: what the bot filled in (never a secret), toggles off, multichoices empty. */
export function initialFormValues(fields: readonly FormField[]): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    if (f.type === 'toggle') out[f.id] = f.value === 'true' || f.value === 'yes';
    else if (f.type === 'multichoice') out[f.id] = f.value ? f.value.split(',').map((s) => s.trim()).filter((s) => f.options.includes(s)) : [];
    else if (f.type !== 'secret' && f.value) out[f.id] = f.value;
  }
  return out;
}

/**
 * A form card's title: the question, or for a Vault card the item's name (its question, "Ada needs a login: “GitHub”",
 * is a sentence for notifications and older apps; the card's line above already says who needs what).
 */
export function formTitle(part: { question: string; form?: Pick<QuestionForm, 'kind' | 'fields' | 'app' | 'bot'> }): string {
  if (part.form?.kind === 'app' && part.form.app) return part.form.app.name;
  if (part.form?.kind === 'telegram') return 'A Telegram bot';
  if (part.form?.kind === 'bot' && part.form.bot) return part.form.fields.find((f) => f.id === 'name')?.value?.trim() || part.form.bot.name;
  if (part.form?.kind === 'routine') return part.form.fields.find((f) => f.id === 'name')?.value?.trim() || part.question;
  if (part.form?.kind !== 'vault') return part.question;
  const name = part.form.fields.find((f) => f.id === 'name')?.value?.trim();
  return name ? `“${name}”` : part.question;
}
