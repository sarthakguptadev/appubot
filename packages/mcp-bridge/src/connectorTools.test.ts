import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { addConnectorTools, objectSchema } from './connectorTools';

describe('connector tools in the bridge', () => {
  it('lists them with the server’s own schema beside the bridge’s tools, and runs them through the gateway', async () => {
    const server = new McpServer({ name: 'appubot', version: '0' });
    server.registerTool('send_message', { description: 'Own tool', inputSchema: { text: z.string() } }, async () => ({ content: [{ type: 'text', text: 'sent' }] }));
    const calls: { name: string; args: unknown }[] = [];
    const schema = { type: 'object', properties: { city: { type: 'string', description: 'Which city' }, days: { type: 'integer', minimum: 1 } }, required: ['city'] };
    addConnectorTools(server, [
      { name: 'weather__forecast', description: 'Weather (custom connector): A forecast', inputSchema: schema },
      { name: 'weather__map', description: 'Weather (custom connector): A map', inputSchema: { properties: {} } },
    ], async (name, args) => { calls.push({ name, args }); return name === 'weather__map' ? { content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }], isError: false } : { content: [{ type: 'text', text: 'Rain' }], isError: true }; });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(b);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['send_message', 'weather__forecast', 'weather__map']);
    expect(tools[1]!.inputSchema).toEqual(schema);
    expect(tools[2]!.inputSchema).toEqual({ type: 'object', properties: {} });
    expect((tools[0]!.inputSchema as { properties: object }).properties).toHaveProperty('text');
    const r = await client.callTool({ name: 'weather__forecast', arguments: { city: 'Pune', days: 2 } });
    expect(r).toMatchObject({ content: [{ type: 'text', text: 'Rain' }], isError: true });
    const m = await client.callTool({ name: 'weather__map', arguments: {} });
    expect(m.content).toEqual([{ type: 'image', data: 'AA==', mimeType: 'image/png' }]);
    expect(calls).toEqual([{ name: 'weather__forecast', args: { city: 'Pune', days: 2 } }, { name: 'weather__map', args: {} }]);
  });

  it('adds nothing when the bot may use none', () => {
    const server = new McpServer({ name: 'appubot', version: '0' });
    addConnectorTools(server, [], async () => { throw new Error('never'); });
    expect(objectSchema({ properties: {} })).toEqual({ properties: {}, type: 'object' });
  });
});
