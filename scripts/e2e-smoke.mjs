#!/usr/bin/env -S npx tsx
/**
 * End-to-end smoke against a RUNNING AppuBot gateway (desktop app in dev or prod).
 * Usage: npx tsx scripts/e2e-smoke.mjs --url http://127.0.0.1:7890 --code 123456   (code from Settings → Devices → Pair)
 *    or: node scripts/e2e-smoke.mjs --url ... --token <device token>
 *    or: npx tsx scripts/e2e-smoke.mjs --devinfo /tmp/x.json   (dev app launched with APPUBOT_DEV_INFO=/tmp/x.json:
 *        uses the owner token to start pairing, then pairs as a phone would)
 * Options: --save-token <file> (keep the paired device token, e.g. to test a packaged build), --bot <name>, --prompt, --expect <substring>, --answer <text> (reply to ask_user questions; default first option), --timeout <s>
 * Steps: health → pair → connect(hello snapshot) → list bots → chat.send "reply pong" to the bot (its one conversation) → wait completion
 *        → agent.sendFile path via bridge is exercised by asking the bot to send a file → verify /files download.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import { GatewayClient, pairWithCode, checkHealth } from '@appubot/client';
import { SnapshotSchema } from '@appubot/protocol';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1]] : []).filter(Boolean));
const devinfo = args.devinfo ? JSON.parse(readFileSync(args.devinfo, 'utf8')) : null;
const url = args.url ?? devinfo?.url ?? 'http://127.0.0.1:7890';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const health = await checkHealth(url);
if (!health.ok) { console.error('gateway not reachable at', url); process.exit(1); }
log('health', health);

let token = args.token;
const device = { id: 'e2e-' + Math.random().toString(36).slice(2, 8), name: 'e2e smoke', platform: 'cli', appVersion: '0.1.0' };
if (!token && devinfo && !args.code) {
  const owner = new GatewayClient({ baseUrl: url, token: devinfo.token, device: { id: 'desktop', name: 'owner', platform: 'desktop', appVersion: '0.1.0' }, WebSocketImpl: WebSocket });
  await new Promise((res, rej) => { owner.onState((s, e) => { if (s === 'connected') res(); if (s === 'unauthorized') rej(new Error('owner unauthorized ' + e)); }); owner.connect(); });
  const pairing = await owner.call('pairing.start', { ttlSec: 120 });
  log('pairing started; qr url', pairing.url, 'hosts', pairing.hosts.map((h) => `${h.kind}:${h.host}`).join(' '));
  args.code = pairing.code;
  owner.close();
}
if (!token) {
  if (!args.code) { console.error('need --code, --token or --devinfo'); process.exit(1); }
  const p = await pairWithCode(url, { code: args.code, device });
  token = p.token; log('paired as', p.deviceId, 'role', p.role);
  if (args['save-token']) writeFileSync(args['save-token'], token, { mode: 0o600 });
}

const client = new GatewayClient({ baseUrl: url, token, device, WebSocketImpl: WebSocket, callTimeoutMs: 120_000 });
await new Promise((res, rej) => { client.onState((s, e) => { if (s === 'connected') res(); if (s === 'unauthorized') rej(new Error('unauthorized ' + e)); }); client.connect(); });
const snap = SnapshotSchema.parse(client.snapshot);
log('hello ok; bots:', snap.bots.map((b) => b.name).join(', '), '| providers installed:', snap.providers.filter((p) => p.installed).map((p) => p.id).join(', '), '| computer:', snap.computer.backend, snap.computer.permissions);

const bot = args.bot ? snap.bots.find((b) => b.name.toLowerCase() === String(args.bot).toLowerCase()) : snap.bots[0];
if (!bot) { console.error('no bot named', args.bot); process.exit(1); }
const events = [];
client.onAny((e, p) => { if (String(e).startsWith('message.') || e === 'permission.requested' || e === 'file.created' || e === 'thread.updated') events.push([e, p]); });
client.on('permission.requested', async (req) => {
  const opt = req.options.find((o) => o.kind === 'allow_once') ?? req.options[0];
  log('permission requested:', req.title, '→ auto', opt.optionId);
  await client.call('permissions.respond', { id: req.id, optionId: opt.optionId });
});

client.on('question.asked', async (q) => {
  const answer = args.answer ?? q.options[0] ?? 'yes';
  log('agent asked:', JSON.stringify(q.question), 'options', q.options, '→ answering', JSON.stringify(answer));
  await client.call('chat.answer', { questionId: q.questionId, answer });
});

const prompt = args.prompt ?? 'Reply with exactly the word pong and nothing else.';
// listen before sending: a quick reply can finish before the call returns
const completed = new Map();
const waiters = new Map();
client.on('message.completed', (p) => { completed.set(p.messageId, p); waiters.get(p.messageId)?.(p); });
const { userMessage, agentMessageId } = await client.call('chat.send', { botId: bot.id, text: prompt });
log('sent into thread', userMessage.threadId, '(the bot\'s conversation); waiting for agent message', agentMessageId);
const done = completed.get(agentMessageId) ?? await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout waiting for completion')), Number(args.timeout ?? 180) * 1000);
  waiters.set(agentMessageId, (p) => { clearTimeout(t); res(p); });
});
log('completed:', done.status, done.stopReason ?? '', done.error ?? '');
const { messages } = await client.call('bots.history', { id: bot.id, limit: 20 });
const agentMsg = messages.find((m) => m.id === agentMessageId);
const text = agentMsg.parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
log('agent text:', JSON.stringify(text.slice(0, 300)));
log('parts:', agentMsg.parts.map((p) => p.type + (p.type === 'tool_call' ? `(${p.kind}:${p.status})` : '')).join(' '));
const files = events.filter(([e]) => e === 'file.created').map(([, f]) => f);
for (const f of files) {
  const r = await fetch(client.fileUrl(f));
  log('file', f.name, f.size, 'download status', r.status, 'bytes', (await r.arrayBuffer()).byteLength);
}
const ok = done.status === 'complete' && (args.expect ? text.toLowerCase().includes(String(args.expect).toLowerCase()) : true);
log(ok ? 'E2E OK' : 'E2E FAILED');
client.close();
process.exit(ok ? 0 : 2);
