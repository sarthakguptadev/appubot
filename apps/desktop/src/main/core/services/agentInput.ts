/**
 * A form an agent itself asks the user to fill in (ACP elicitation: OpenCode's own `question` tool), as the chat's
 * own cards: one question with choices (or one line to type) is a question card, like `ask_user`; anything more is a
 * form card, like `ask_form`. Pure: what to show, and how the answer goes back under the agent's own field ids.
 */
import type { ElicitationAsk, ElicitationField } from '@appubot/agent-runtime';
import type { FormValues } from '@appubot/chat-core';
import { FormFieldSchema, type FormField } from '@appubot/protocol';

/** A question card: `read` turns the answer in words into the agent's values. */
export interface InputQuestion { kind: 'question'; question: string; options: string[]; read(answer: string): Record<string, unknown> }
/** A form card: `read` turns its values into the agent's; `words` an answer typed instead (Telegram, an older app). */
export interface InputForm { kind: 'form'; question: string; fields: FormField[]; read(values: FormValues): Record<string, unknown>; words(answer: string): Record<string, unknown> }
export type InputCard = InputQuestion | InputForm;

const YES = 'Yes';
const NO = 'No';
/** what OpenCode's form says when it has nothing of its own to say */
const BLAND = /^(questions?|input|form)$/i;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** A choice's "type your own" twin: OpenCode sends `q0` with `q0_custom` beside it. */
function twinOf(f: ElicitationField, all: ElicitationField[]): ElicitationField | undefined {
  if (f.kind !== 'choice' && f.kind !== 'multichoice') return undefined;
  const t = all.find((x) => x.id === `${f.id}_custom`);
  return t?.kind === 'text' ? t : undefined;
}

/** the option a typed answer names: its words, or its number in the list */
function named(f: ElicitationField, answer: string): string | undefined {
  const said = answer.trim().toLowerCase();
  if (!said) return undefined;
  const hit = f.options.find((o) => o.title.trim().toLowerCase() === said || o.value.trim().toLowerCase() === said);
  if (hit) return hit.value;
  return /^\d+$/.test(said) ? f.options[Number(said) - 1]?.value : undefined;
}

/** What to show for an agent's form: null when there is nothing a person could answer. */
export function inputCard(ask: ElicitationAsk): InputCard | null {
  const all = ask.fields;
  if (!all.length) return null;
  const twins = new Map<string, ElicitationField>();
  for (const f of all) { const t = twinOf(f, all); if (t) twins.set(f.id, t); }
  const twinIds = new Set([...twins.values()].map((t) => t.id));
  const main = all.filter((f) => !twinIds.has(f.id));
  const message = ask.message.trim();
  const one = main.length === 1 ? main[0]! : undefined;

  // one thing asked: a question in the chat, answered with a choice or in words
  if (one) {
    const question = one.description ?? one.title ?? (message || 'A question');
    const twin = twins.get(one.id);
    if (one.kind === 'choice' && twin) {
      return {
        kind: 'question', question, options: one.options.map((o) => clip(o.title, 200)),
        read: (answer) => { const v = named(one, answer); return v !== undefined ? { [one.id]: v } : answer.trim() ? { [twin.id]: answer.trim() } : {}; },
      };
    }
    if (one.kind === 'text') return { kind: 'question', question, options: [], read: (answer) => (answer.trim() ? { [one.id]: answer.trim() } : {}) };
    if (one.kind === 'toggle') {
      return { kind: 'question', question, options: [YES, NO], read: (answer) => { const s = answer.trim().toLowerCase(); return s === 'yes' || s === '1' ? { [one.id]: true } : s === 'no' || s === '2' ? { [one.id]: false } : {}; } };
    }
  }

  // several, or one that needs more than words: a form, its fields keyed f0, f1… (the agent's ids may not fit ours)
  const shown = all.slice(0, 20);
  const fields: FormField[] = shown.map((f, i) => {
    const isTwin = twinIds.has(f.id);
    const label = clip(f.title ?? f.description ?? f.id, 120);
    const def = f.default;
    const value = def === undefined ? undefined
      : f.kind === 'choice' ? f.options.find((o) => o.value === def)?.title
        : f.kind === 'multichoice' && Array.isArray(def) ? f.options.filter((o) => def.includes(o.value)).map((o) => o.title).join(',')
          : String(def);
    return FormFieldSchema.parse({
      id: `f${i}`, label,
      type: f.kind === 'text' ? (f.format === 'email' ? 'email' : f.format === 'uri' ? 'url' : f.format === 'date' ? 'date' : 'text') : f.kind,
      required: f.required,
      options: f.options.map((o) => clip(o.title, 200)),
      // a twin's line is what to type there; any other field's is what the agent wants to know
      ...(isTwin && f.description ? { placeholder: clip(f.description, 200) } : f.title && f.description ? { hint: clip(f.description, 300) } : {}),
      ...(value ? { value: clip(value, 4000) } : {}),
    });
  });
  const back = (i: number, v: unknown): unknown => {
    const f = shown[i]!;
    // the card shows titles: back to the agent's own values, by their place in the list
    const one = (x: unknown): unknown => (typeof x === 'string' ? f.options.find((o) => clip(o.title, 200) === x)?.value ?? x : x);
    return Array.isArray(v) ? v.map(one) : f.options.length ? one(v) : v;
  };
  return {
    kind: 'form',
    question: !message || BLAND.test(message) ? (main.length === 1 ? main[0]!.description ?? main[0]!.title ?? 'A question' : 'A few questions') : message,
    fields,
    read: (values) => Object.fromEntries(shown.flatMap((f, i) => (values[`f${i}`] === undefined ? [] : [[f.id, back(i, values[`f${i}`])]]))),
    words: (answer) => {
      const said = answer.trim();
      if (!said) return {};
      // a choice it names, else the first place there is to type
      for (const f of main) { if (f.options.length) { const v = named(f, said); if (v !== undefined) return { [f.id]: f.kind === 'multichoice' ? [v] : v }; } }
      const text = shown.find((f) => f.kind === 'text');
      return text ? { [text.id]: said } : {};
    },
  };
}
