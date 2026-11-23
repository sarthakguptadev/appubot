#!/usr/bin/env -S npx tsx
/**
 * Computer-use benchmark against a RUNNING dev instance (launched with APPUBOT_DEV_INFO=<file>).
 * Usage: npx tsx scripts/cu-bench.mjs --devinfo <file> [--bot Name] [--task calc|textedit|<prompt>] [--expect <substring>] [--timeout <s>]
 * Sends one task to the bot (in a new chat), waits for the turn, then prints the wall time, the number of computer
 * tool calls, the time spent inside tools vs. in the model, and the reply.
 */
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { GatewayClient } from '@appubot/client';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : [])).filter((x) => x.length));
const devinfo = JSON.parse(readFileSync(args.devinfo, 'utf8'));
const TASKS = {
  calc: { prompt: 'Use the Calculator app on this Mac to work out 4827 × 391 by clicking its on-screen buttons (do not type on the keyboard). Then tell me exactly the number the display shows.', expect: '1887357' },
  calclong: { prompt: 'Use the Calculator app on this Mac to work out 1234 + 5678 + 9012 + 3456 − 7890 by clicking its on-screen buttons (do not type on the keyboard). Then tell me exactly the number the display shows.', expect: '11490' },
  textedit: { prompt: 'Open TextEdit, make a new document, and write three lines in it: "Shopping", "milk", "eggs". Then make the first line bold. Do not save it. Tell me when done.', expect: '' },
};
const task = TASKS[args.task ?? 'calc'] ?? { prompt: args.task, expect: '' };
const expect = args.expect ?? task.expect;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const client = new GatewayClient({ baseUrl: devinfo.url, token: devinfo.token, device: { id: 'desktop', name: 'cu-bench', platform: 'desktop', appVersion: '0.1.0' }, WebSocketImpl: WebSocket, callTimeoutMs: 120_000 });
await new Promise((res, rej) => { client.onState((s, e) => { if (s === 'connected') res(); if (s === 'unauthorized') rej(new Error('unauthorized ' + e)); }); client.connect(); });
const bots = await client.call('bots.list', {});
const bot = args.bot ? bots.find((b) => b.name.toLowerCase() === String(args.bot).toLowerCase()) : bots[0];
client.on('permission.requested', async (req) => {
  const opt = req.options.find((o) => o.kind === 'allow_always') ?? req.options.find((o) => o.kind === 'allow_once') ?? req.options[0];
  await client.call('permissions.respond', { id: req.id, optionId: opt.optionId });
});
const thread = await client.call('threads.create', { botId: bot.id });
const completed = new Map();
const waiters = new Map();
client.on('message.completed', (p) => { completed.set(p.messageId, p); waiters.get(p.messageId)?.(p); });
const t0 = Date.now();
const { agentMessageId } = await client.call('chat.send', { botId: bot.id, threadId: thread.id, text: task.prompt });
const done = completed.get(agentMessageId) ?? (await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout')), Number(args.timeout ?? 600) * 1000);
  waiters.set(agentMessageId, (p) => { clearTimeout(t); res(p); });
}));
const wall = (Date.now() - t0) / 1000;
const { messages } = await client.call('bots.history', { id: bot.id, limit: 5 });
const msg = messages.find((m) => m.id === agentMessageId);
const tools = msg.parts.filter((p) => p.type === 'tool_call');
const cu = tools.filter((p) => p.kind === 'computer');
const inTools = tools.reduce((s, p) => s + (p.endedAt && p.startedAt ? p.endedAt - p.startedAt : 0), 0) / 1000;
const text = msg.parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
for (const p of tools) log(`  ${((p.endedAt ?? 0) - (p.startedAt ?? 0)).toString().padStart(6)}ms  ${p.title}`);
log(`status ${done.status} · wall ${wall.toFixed(1)}s · tool calls ${tools.length} (computer ${cu.length}) · in tools ${inTools.toFixed(1)}s · model/other ${(wall - inTools).toFixed(1)}s`);
log('reply:', JSON.stringify(text.slice(-300)));
const ok = done.status === 'complete' && (!expect || text.replace(/[,\s]/g, '').includes(expect));
log(ok ? 'BENCH OK' : 'BENCH FAILED');
client.close();
process.exit(ok ? 0 : 2);
