import type { Connector } from '@appubot/protocol';

/** Arguments as typed on one line: split at spaces, a quoted one kept whole (`--dir "My Files"`). */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let any = false;
  for (const ch of text) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (any || cur) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (any || cur) out.push(cur);
  return out;
}

/** Arguments back on one line, quoting the ones that need it. */
export function joinArgs(args: readonly string[]): string {
  return args.map((a) => (a === '' || /[\s"']/.test(a) ? (a.includes('"') ? `'${a}'` : `"${a}"`) : a)).join(' ');
}

/** A connector's line under its name: how it is doing, its tools and its bots. */
export function connectorSummary(c: Connector, botCount: number): string {
  if (c.status === 'connecting') return 'Connecting…';
  if (c.status === 'signIn') return c.error ?? 'Sign in to use it';
  if (c.status === 'error') return c.error ?? 'Can’t be reached';
  const on = c.tools.filter((t) => t.on).length;
  const tools = on === c.tools.length ? `${on} ${on === 1 ? 'tool' : 'tools'}` : `${on} of ${c.tools.length} tools on`;
  const bots = c.bots === 'all' ? 'All bots' : c.bots.length === 0 ? 'No bots' : `${c.bots.length} of ${botCount} ${botCount === 1 ? 'bot' : 'bots'}`;
  return `Connected · ${tools} · ${bots}`;
}
