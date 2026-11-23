/** What an approval request says, on any client: "<bot> wants to run a command" and the tool's arguments. */
import type { PermissionRequest } from '@appubot/protocol';
import { basename } from './format';
import { rawPath } from './toolText';

const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** The end of "<bot> wants to …": "run a command", "edit invoice.ts", "use your computer (click …)". */
export function wantsTo(req: Pick<PermissionRequest, 'kind' | 'title' | 'content' | 'rawInput'>): string {
  const diff = req.content.find((c) => c.type === 'diff');
  const path = rawPath(req.rawInput) ?? (diff?.type === 'diff' ? diff.path : undefined);
  switch (req.kind) {
    case 'execute': return 'run a command';
    case 'edit': return diff?.type === 'diff' && diff.oldText === null ? `create ${path ? basename(path) : 'a file'}` : `edit ${path ? basename(path) : 'a file'}`;
    case 'delete': return `delete ${path ? basename(path) : 'a file'}`;
    case 'move': return `move ${path ? basename(path) : 'a file'}`;
    case 'read': return `read ${path ? basename(path) : 'a file'}`;
    case 'fetch': return 'fetch from the web';
    case 'computer': return `use your computer (${lowerFirst(req.title)})`;
    default: return req.title === 'Ask you' ? 'ask you a question' : lowerFirst(req.title) || 'do something';
  }
}

/** One argument value as text (lists of plain values joined, anything else as JSON). */
export function fieldText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.every((x) => typeof x !== 'object')) return v.join(', ');
  return JSON.stringify(v);
}

/** Tool arguments as "name: value" rows rather than raw JSON. */
export function argumentRows(rawInput: unknown): { name: string; value: string }[] {
  const fields = Object.entries(rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : {});
  return fields.map(([k, v]) => ({ name: k.replace(/_/g, ' '), value: fieldText(v) }));
}
