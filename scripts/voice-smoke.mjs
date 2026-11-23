#!/usr/bin/env -S npx tsx
/**
 * Voice smoke against a dev app (launched with APPUBOT_DEV_INFO=<file>): hears a recording (`voice.transcribe`),
 * speaks a line (`voice.speak`), and, with --chat, sends the words to the bot as a spoken message (`chat.send` with
 * `voice`), waits for the reply and has it read aloud onto the message (`voice.speak` with messageId → a `voice` part).
 * Usage: npx tsx scripts/voice-smoke.mjs --devinfo <file> --audio <file.wav|.m4a|.ogg> [--expect "words"] [--chat] [--speak "text"]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import WebSocket from 'ws';
import { GatewayClient } from '@appubot/client';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]] : [])).filter((x) => x.length));
if (!args.devinfo || !args.audio) { console.error('usage: voice-smoke.mjs --devinfo <file> --audio <file> [--expect words] [--chat] [--speak text]'); process.exit(1); }
const { url, token } = JSON.parse(readFileSync(String(args.devinfo), 'utf8'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const MIME = { '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.webm': 'audio/webm', '.ogg': 'audio/ogg' };

const client = new GatewayClient({ baseUrl: url, token, device: { id: 'voice-smoke', name: 'voice smoke', platform: 'cli' }, WebSocketImpl: WebSocket, callTimeoutMs: 300_000 });
await new Promise((res, rej) => { client.onState((s, e) => { if (s === 'connected') res(); if (s === 'unauthorized') rej(new Error(`unauthorized ${e}`)); }); client.connect(); });
try {
  const status = await client.call('voice.status');
  log('voice', status.supported ? 'supported' : `unsupported: ${status.reason}`, status.models.map((m) => `${m.name}=${m.phase}`).join(' '));
  const ext = extname(String(args.audio)).toLowerCase();
  const bytes = readFileSync(String(args.audio));
  const format = ext === '.ogg' ? 'ogg' : 'encoded';
  let t = Date.now();
  const heard = await client.call('voice.transcribe', { audio: bytes.toString('base64'), format, mimeType: MIME[ext] ?? 'application/octet-stream', keep: true });
  log(`heard in ${Date.now() - t}ms (${heard.durationMs}ms of audio):`, JSON.stringify(heard.text));
  if (heard.recording) log('recording kept as', heard.recording.name, heard.recording.mimeType, heard.recording.size, 'bytes');
  if (args.expect) {
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9ऀ-ॿ ]/g, '').replace(/\s+/g, ' ').trim();
    const want = norm(String(args.expect)).split(' ');
    const got = norm(heard.text);
    const hits = want.filter((w) => got.includes(w)).length;
    log(`expected words present: ${hits}/${want.length}`);
    if (hits < Math.ceil(want.length * 0.7)) throw new Error(`transcript misses too many expected words: ${heard.text}`);
  }
  const line = String(args.speak ?? 'Hello! This is AppuBot speaking from your computer. Everything you hear was made here, by a model running on the CPU.');
  t = Date.now();
  const spoken = await client.call('voice.speak', { text: line });
  const ogg = Buffer.from(spoken.audio, 'base64');
  const out = `/tmp/appubot-voice-smoke-${Date.now()}.ogg`;
  writeFileSync(out, ogg);
  log(`spoke in ${Date.now() - t}ms: ${spoken.durationMs}ms of ${spoken.language}, ${ogg.length} bytes → ${out}`);

  if (args.chat) {
    const bots = await client.call('bots.list');
    const bot = bots[0];
    if (!bot) throw new Error('no bot');
    if (!heard.recording) throw new Error('no recording kept');
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the reply took too long')), 240_000);
      client.on('message.completed', (p) => { if (p.messageId === sent.agentMessageId) { clearTimeout(timer); resolve(p); } });
    });
    const sent = await client.call('chat.send', { botId: bot.id, text: heard.text, voice: { recordingId: heard.recording.id, durationMs: heard.durationMs } });
    const voicePart = sent.userMessage.parts.find((p) => p.type === 'voice');
    log('sent as', bot.name, 'spoken message; user message has voice part:', !!voicePart, voicePart ? `${voicePart.kind} ${voicePart.durationMs}ms` : '');
    const completed = await done;
    log('reply', completed.status);
    const { messages } = await client.call('threads.history', { id: sent.userMessage.threadId, limit: 5 });
    const reply = messages.find((m) => m.id === sent.agentMessageId);
    const text = reply?.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim();
    log('reply text:', JSON.stringify(text?.slice(0, 200)));
    if (text) {
      const partPromise = new Promise((resolve) => client.on('message.part', (p) => { if (p.messageId === reply.id && p.part.type === 'voice') resolve(p.part); }));
      t = Date.now();
      const read = await client.call('voice.speak', { text, threadId: reply.threadId, messageId: reply.id });
      const part = await Promise.race([partPromise, new Promise((r) => setTimeout(() => r(null), 5000))]);
      log(`reply read aloud in ${Date.now() - t}ms: ${read.durationMs}ms, stored as ${read.file?.name}; voice part event:`, part ? `${part.kind} ${part.durationMs}ms` : 'none');
    }
  }
  log('OK');
} finally {
  client.close();
}
