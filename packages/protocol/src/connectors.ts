import { z } from 'zod';
import { Id, Timestamp } from './entities';

/**
 * Custom connectors (Settings › Apps › Custom connectors): MCP servers the person adds themselves, a remote one by its
 * address (streamable HTTP or SSE, with headers and the standard MCP sign-in when the server asks for one) or a local
 * one by the command that starts it. AppuBot runs them on the computer and offers their tools to the bots through its
 * own bridge, so every agent gets them, each tool can be switched off, and each connector can be kept to some bots.
 * Header values, environment values and sign-in tokens stay on the computer, sealed with its keychain where it has
 * one; the wire only names them and says whether a value is saved.
 */

export const ConnectorTransport = z.enum(['http', 'sse', 'stdio']);
export type ConnectorTransport = z.infer<typeof ConnectorTransport>;

export const CONNECTOR_NAME_MAX = 40;
/** an HTTP header's name */
export const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
/** an environment variable's name */
export const CONNECTOR_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A header or environment variable: its name, and whether a value is saved for it (the value never leaves the computer). */
export const ConnectorSecretSchema = z.object({ name: z.string(), saved: z.boolean() });
export type ConnectorSecret = z.infer<typeof ConnectorSecretSchema>;

export const ConnectorToolSchema = z.object({
  name: z.string(),
  /** the server's own title for it, when it gives one */
  title: z.string().optional(),
  description: z.string().optional(),
  /** whether bots are offered it */
  on: z.boolean(),
});
export type ConnectorTool = z.infer<typeof ConnectorToolSchema>;

/**
 * `connecting`: being reached; `connected`: answered with its tools; `signIn`: it wants the person to sign in (in the
 * browser); `error`: it can't be used now, `error` says why in plain words.
 */
export const ConnectorStatus = z.enum(['connecting', 'connected', 'signIn', 'error']);
export type ConnectorStatus = z.infer<typeof ConnectorStatus>;

/** Which bots may use a connector: every bot (new ones too), or the ones named. */
export const ConnectorBots = z.union([z.literal('all'), z.array(Id).max(500)]);
export type ConnectorBots = z.infer<typeof ConnectorBots>;

export const ConnectorSchema = z.object({
  id: Id,
  name: z.string(),
  transport: ConnectorTransport,
  /** a remote server's address */
  url: z.string().optional(),
  /** a local server's command and its arguments */
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  headers: z.array(ConnectorSecretSchema).default([]),
  env: z.array(ConnectorSecretSchema).default([]),
  bots: ConnectorBots,
  status: ConnectorStatus,
  /** why it can't be used now, in plain words */
  error: z.string().optional(),
  /** a sign-in is saved for it (the standard MCP sign-in) */
  signedIn: z.boolean().optional(),
  /** the account it is signed in as, when the server says */
  account: z.string().optional(),
  /** the server's own name and version, as it introduced itself */
  server: z.object({ name: z.string(), version: z.string().optional() }).optional(),
  /** its tools as it last listed them */
  tools: z.array(ConnectorToolSchema).default([]),
  createdAt: Timestamp,
});
export type Connector = z.infer<typeof ConnectorSchema>;

/**
 * Adds a connector (no `id`) or changes one. `headers` and `env` are the whole list: a name left out is forgotten,
 * and an entry without a `value` keeps the one saved for that name. `bots` absent: every bot for a new one, as it was
 * for an edit.
 */
export const ConnectorSaveSchema = z.object({
  id: Id.optional(),
  name: z.string().trim().min(1).max(CONNECTOR_NAME_MAX),
  transport: ConnectorTransport,
  url: z.string().trim().max(2048).optional(),
  command: z.string().trim().max(1024).optional(),
  args: z.array(z.string().max(4096)).max(64).default([]),
  headers: z.array(z.object({ name: z.string().trim().regex(HEADER_NAME, 'not a header name').max(128), value: z.string().max(8192).optional() })).max(32).default([]),
  env: z.array(z.object({ name: z.string().trim().regex(CONNECTOR_ENV_NAME, 'not a variable name').max(128), value: z.string().max(32_768).optional() })).max(64).default([]),
  bots: ConnectorBots.optional(),
});
export type ConnectorSave = z.input<typeof ConnectorSaveSchema>;

/** A connector's tool as a bot's agent is offered it (`agent.connectors.tools`). */
export const ConnectorAgentToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
});

/** What a connector's tool answered, as the bridge hands it on. */
export const ConnectorContentSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
]);

/* ------------------------------------------------------------------ import */

/** The connectors a pasted config describes, and what couldn't be read from it. */
export interface ConnectorImport { connectors: ConnectorSave[]; problems: string[] }

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const strMap = (v: unknown): { name: string; value: string }[] =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean').map(([name, x]) => ({ name: name.trim(), value: String(x) }))
    : [];

/** The transport a config's `type` / `transport` names, else what its address suggests. */
function transportOf(o: Record<string, unknown>, url: string | undefined): ConnectorTransport {
  const said = (str(o.type) ?? str(o.transport) ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (said === 'stdio' || said === 'local') return 'stdio';
  if (said === 'sse') return 'sse';
  if (said === 'http' || said === 'streamablehttp' || said === 'remote') return 'http';
  if (!url) return 'stdio';
  return /\/sse\/?$/i.test(new URL(url, 'http://x').pathname) ? 'sse' : 'http';
}

/** One server's entry, in any of the shapes other apps write (Claude, Cursor, VS Code, Windsurf, OpenCode, Zed). */
export function connectorFromConfig(name: string, raw: unknown): ConnectorSave | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `“${name}” isn't a server entry.`;
  const o = raw as Record<string, unknown>;
  // Zed wraps it: { command: { path, args, env } }
  const zed = o.command && typeof o.command === 'object' && !Array.isArray(o.command) ? o.command as Record<string, unknown> : undefined;
  const url = str(o.url) ?? str(o.serverUrl) ?? str(o.httpUrl);
  const clean = name.trim().slice(0, CONNECTOR_NAME_MAX) || 'Connector';
  if (url) {
    try { new URL(url); } catch { return `“${name}”: ${url} isn't an address.`; }
    const transport = transportOf(o, url);
    return { name: clean, transport: transport === 'stdio' ? 'http' : transport, url, args: [], headers: strMap(o.headers), env: [] };
  }
  // OpenCode: { type: 'local', command: ['npx', '-y', 'pkg'], environment }
  const list = Array.isArray(o.command) ? (o.command as unknown[]).filter((x): x is string => typeof x === 'string') : undefined;
  const command = zed ? str(zed.path) : list ? list[0] : str(o.command);
  if (!command) return `“${name}” has neither a command nor an address.`;
  const argv = zed?.args ?? o.args;
  const args = list ? list.slice(1) : Array.isArray(argv) ? (argv as unknown[]).map((x) => String(x)) : [];
  return { name: clean, transport: 'stdio', command, args, headers: [], env: strMap(zed?.env ?? o.env ?? o.environment) };
}

/**
 * The connectors in a pasted JSON config: `{ "mcpServers": { name: … } }` (Claude, Cursor, Windsurf), `{ "servers": … }`
 * (VS Code's mcp.json), `{ "mcp": { "servers": … } }` (VS Code's settings), `{ "mcp": { name: … } }` (OpenCode),
 * `{ "context_servers": … }` (Zed), a bare map of servers, or one server's entry.
 */
export function parseConnectorImport(text: string): ConnectorImport {
  let json: unknown;
  try { json = JSON.parse(text.trim().replace(/^[^{]*?(\{)/s, '$1')); } catch { return { connectors: [], problems: ["That isn't JSON. Paste the whole config, starting with {."] }; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { connectors: [], problems: ["That isn't a config: it should be a JSON object."] };
  const o = json as Record<string, unknown>;
  const mcp = o.mcp && typeof o.mcp === 'object' ? o.mcp as Record<string, unknown> : undefined;
  const isEntry = (v: unknown) => !!v && typeof v === 'object' && ('command' in (v as object) || 'url' in (v as object) || 'serverUrl' in (v as object) || 'httpUrl' in (v as object));
  let map: Record<string, unknown>;
  if (o.mcpServers && typeof o.mcpServers === 'object') map = o.mcpServers as Record<string, unknown>;
  else if (o.servers && typeof o.servers === 'object') map = o.servers as Record<string, unknown>;
  else if (o.context_servers && typeof o.context_servers === 'object') map = o.context_servers as Record<string, unknown>;
  else if (mcp?.servers && typeof mcp.servers === 'object') map = mcp.servers as Record<string, unknown>;
  else if (mcp) map = mcp;
  else if (isEntry(o)) map = { [str(o.name) ?? 'Connector']: o };
  else map = o;
  const connectors: ConnectorSave[] = [];
  const problems: string[] = [];
  for (const [name, entry] of Object.entries(map)) {
    const c = connectorFromConfig(name, entry);
    if (typeof c === 'string') problems.push(c); else connectors.push(c);
  }
  if (!connectors.length && !problems.length) problems.push('No servers in it.');
  return { connectors, problems };
}
