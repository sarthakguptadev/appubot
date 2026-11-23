/**
 * ACP elicitation (`elicitation/create`, form mode): an agent asking the user for input on a form of plain fields.
 * OpenCode's own `question` tool is one: a client that doesn't say it takes forms has the question dismissed at once
 * and the turn ended `cancelled`. Here the requested schema is read into fields the host can show (`elicitationAsk`),
 * and the host's answer is put back into the shape the schema asked for (`elicitationContent`). Pure, no I/O.
 */

export interface ElicitationOption { value: string; title: string; description?: string }

export interface ElicitationField {
  /** the key its value comes back under */
  id: string;
  title?: string;
  description?: string;
  kind: 'text' | 'number' | 'toggle' | 'choice' | 'multichoice';
  /** a text's format: `email`, `uri`, `date`, `date-time` */
  format?: string;
  /** a number that must be whole */
  integer?: boolean;
  /** choice and multichoice */
  options: ElicitationOption[];
  required: boolean;
  default?: ElicitationValue;
}

export interface ElicitationAsk {
  sessionId: string;
  toolCallId?: string;
  /** what the agent says it needs */
  message: string;
  fields: ElicitationField[];
}

export type ElicitationValue = string | number | boolean | string[];

/** What the user did with it: filled in (values by field id), turned down, or nothing (no answer, the turn ended). */
export type ElicitationAnswer =
  | { action: 'accept'; content: Record<string, ElicitationValue> }
  | { action: 'decline' }
  | { action: 'cancel' };

/** the most fields and options read from one request (a form past this isn't one a person fills in) */
const FIELDS_MAX = 20;
const OPTIONS_MAX = 20;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function options(list: unknown): ElicitationOption[] {
  if (!Array.isArray(list)) return [];
  const out: ElicitationOption[] = [];
  for (const o of list) {
    if (typeof o === 'string') { if (o) out.push({ value: o, title: o }); continue; }
    if (!o || typeof o !== 'object') continue;
    const r = o as Record<string, unknown>;
    if (typeof r.const !== 'string' || !r.const) continue;
    const description = str(r.description);
    out.push({ value: r.const, title: str(r.title) ?? r.const, ...(description ? { description } : {}) });
  }
  return out.slice(0, OPTIONS_MAX);
}

/** The fields a form-mode request asks for, in the schema's order. A property of a kind not known is asked as text. */
export function elicitationFields(schema: unknown): ElicitationField[] {
  const s = schema && typeof schema === 'object' ? (schema as Record<string, unknown>) : {};
  const props = s.properties && typeof s.properties === 'object' ? (s.properties as Record<string, unknown>) : {};
  const required = new Set(Array.isArray(s.required) ? s.required.filter((x): x is string => typeof x === 'string') : []);
  const out: ElicitationField[] = [];
  for (const [id, raw] of Object.entries(props)) {
    if (!id || !raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const title = str(p.title);
    const description = str(p.description);
    const base = { id, ...(title ? { title } : {}), ...(description ? { description } : {}), required: required.has(id) };
    if (p.type === 'boolean') {
      out.push({ ...base, kind: 'toggle', options: [], ...(typeof p.default === 'boolean' ? { default: p.default } : {}) });
    } else if (p.type === 'number' || p.type === 'integer') {
      out.push({ ...base, kind: 'number', options: [], ...(p.type === 'integer' ? { integer: true } : {}), ...(typeof p.default === 'number' ? { default: p.default } : {}) });
    } else if (p.type === 'array') {
      const items = p.items && typeof p.items === 'object' ? (p.items as Record<string, unknown>) : {};
      const opts = options(items.anyOf ?? items.oneOf ?? items.enum);
      const def = Array.isArray(p.default) ? p.default.filter((x): x is string => typeof x === 'string') : undefined;
      out.push({ ...base, kind: 'multichoice', options: opts, ...(def?.length ? { default: def } : {}) });
    } else {
      const opts = options(p.oneOf ?? p.enum);
      const def = typeof p.default === 'string' && p.default ? { default: p.default } : {};
      if (opts.length) out.push({ ...base, kind: 'choice', options: opts, ...def });
      else out.push({ ...base, kind: 'text', options: [], ...(str(p.format) ? { format: str(p.format) } : {}), ...def });
    }
    if (out.length >= FIELDS_MAX) break;
  }
  return out;
}

/**
 * An answer as the schema wants it: only the fields asked for, each in its own type, a choice only among its options
 * (by value, else by the title a person saw). What doesn't fit is left out rather than sent wrong.
 */
export function elicitationContent(fields: ElicitationField[], values: Record<string, unknown>): Record<string, ElicitationValue> {
  const out: Record<string, ElicitationValue> = {};
  const pick = (f: ElicitationField, v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const said = v.trim().toLowerCase();
    return (f.options.find((o) => o.value === v) ?? f.options.find((o) => o.title.trim().toLowerCase() === said || o.value.trim().toLowerCase() === said))?.value;
  };
  for (const f of fields) {
    const v = values[f.id];
    if (v === undefined || v === null) continue;
    if (f.kind === 'toggle') {
      if (typeof v === 'boolean') out[f.id] = v;
      else if (v === 'true' || v === 'false') out[f.id] = v === 'true';
    } else if (f.kind === 'number') {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
      if (Number.isFinite(n)) out[f.id] = f.integer ? Math.round(n) : n;
    } else if (f.kind === 'choice') {
      const one = pick(f, v);
      if (one !== undefined) out[f.id] = one;
    } else if (f.kind === 'multichoice') {
      const list = (Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : []).map((x) => pick(f, x)).filter((x): x is string => x !== undefined);
      if (list.length || Array.isArray(v)) out[f.id] = [...new Set(list)];
    } else if (typeof v === 'string') {
      if (v.trim()) out[f.id] = v;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[f.id] = String(v);
    }
  }
  return out;
}
