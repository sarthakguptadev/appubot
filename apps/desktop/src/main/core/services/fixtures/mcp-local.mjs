#!/usr/bin/env node
// A local MCP server for the connectors tests: a few tools, one that shows the environment it was given reached it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'test-local', version: '1.2.3' });
server.registerTool('echo', { description: 'Says back what it is given', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }));
server.registerTool('add', { description: 'Adds two numbers', inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));
server.registerTool('greeting', { description: 'The greeting this server was started with' }, async () => ({ content: [{ type: 'text', text: process.env.GREETING ?? '(none)' }] }));
server.registerTool('picture', { description: 'A tiny picture' }, async () => ({ content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] }));
server.registerTool('fail', { description: 'Always fails' }, async () => ({ content: [{ type: 'text', text: 'it went wrong' }], isError: true }));
process.stderr.write('test-local ready\n');
await server.connect(new StdioServerTransport());
