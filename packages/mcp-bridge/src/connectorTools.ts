/**
 * The custom connectors' tools (Settings › Apps › Custom connectors), offered as the bridge's own: the gateway lists
 * the ones this bot may use (`agent.connectors.tools`) and runs each call on its server (`agent.connectors.call`).
 * Agents see them as `<connector>__<tool>` with the input schema the server itself wrote.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MethodResult } from '@appubot/protocol';

type ConnectorTool = MethodResult<'agent.connectors.tools'>['tools'][number];
type CallResult = MethodResult<'agent.connectors.call'>;
type ToolList = { tools: { name: string; inputSchema?: unknown }[] };
type RawHandler = (request: unknown, extra: unknown) => Promise<ToolList>;

/** A server's schema as a tool's `inputSchema` must be: an object schema. */
export function objectSchema(s: Record<string, unknown>): Record<string, unknown> {
  return s.type === 'object' ? s : { ...s, type: 'object' };
}

export function addConnectorTools(server: McpServer, tools: ConnectorTool[], call: (name: string, args: Record<string, unknown>) => Promise<CallResult>): void {
  if (!tools.length) return;
  const schemas = new Map<string, Record<string, unknown>>();
  for (const t of tools) {
    schemas.set(t.name, objectSchema(t.inputSchema));
    // any arguments pass here: the connector's server checks them against its own schema
    server.registerTool(t.name, { description: t.description, inputSchema: z.looseObject({}) }, async (args) => {
      try {
        const r = await call(t.name, args as Record<string, unknown>);
        return { content: r.content, ...(r.isError ? { isError: true } : {}) };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    });
  }
  // the SDK lists a tool by the zod schema it was registered with: these go out with the server's own JSON schema
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, RawHandler> })._requestHandlers;
  const list = handlers?.get('tools/list');
  if (!handlers || !list) return;
  handlers.set('tools/list', async (request, extra) => {
    const res = await list(request, extra);
    return { ...res, tools: res.tools.map((t) => (schemas.has(t.name) ? { ...t, inputSchema: schemas.get(t.name) } : t)) };
  });
}
