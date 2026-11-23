#!/usr/bin/env -S npx tsx
/**
 * Voice mode's latency, stage by stage, against a dev app (launched with APPUBOT_DEV_INFO=<file>): plays a WAV
 * utterance through the server calls voice mode makes, sends what was heard to the first bot as a spoken message and
 * times everything from the moment the speaker stops talking: hearing it, `chat.send`, the agent's first words, its
 * first speakable piece, and that piece's audio ready to play.
 * `--pipeline legacy` is the voice mode before segment hearing (wait 1.2 s, hear the whole recording with `keep`,
 * read sentence by sentence as OGG).
 * Ask things the bot answers in words (a question it needs a tool or your "Allow" for has no first sentence soon).
 * Usage: npx tsx scripts/voice-latency.mjs --devinfo <file> [--audio a.wav,b.wav] [--runs 3] [--pipeline live|legacy]
 * (`--audio`: 16 kHz mono WAVs, one per run in turn: say -v Samantha --data-format=LEI16@16000 -o a.wav "…")
 */
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { GatewayClient } from '@appubot/client';
import { speechChunks, speechLanguage } from '../packages/chat-core/src/index.ts';
import { FIRST_CLAUSE_MIN, speakableEnd, speakablePiece } from '../apps/desktop/src/renderer/src/features/voice/speakable.ts';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]] : [])).filter((x) => x.length));
if (!args.devinfo) { console.error('usage: voice-latency.mjs --devinfo <file> [--audio a.wav,b.wav] [--runs 3] [--pipeline live|legacy]'); process.exit(1); }
const { url, token } = JSON.parse(readFileSync(String(args.devinfo), 'utf8'));
const runs = Number(args.runs ?? 3);
const pipeline = String(args.pipeline ?? 'live');
const audioPaths = String(args.audio ?? '/tmp/appubot-voice-e2e/q1.wav,/tmp/appubot-voice-e2e/q2.wav,/tmp/appubot-voice-e2e/q3.wav').split(',');
/** how long a reply may take to say something */
const REPLY_WAIT_MS = 120_000;
const RATE = 16_000;

/** 16 kHz mono 16-bit samples of a WAV file */
function readWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path} is not a WAV file`);
  let at = 12;
  let fmt = null;
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(at + 10), rate: b.readUInt32LE(at + 12), bits: b.readUInt16LE(at + 22) };
    if (id === 'data') {
      if (!fmt || fmt.channels !== 1 || fmt.rate !== RATE || fmt.bits !== 16) throw new Error('the WAV must be 16 kHz mono 16-bit (say -v Samantha --data-format=LEI16@16000 -o x.wav "…")');
      const data = b.subarray(at + 8, at + 8 + size);
      return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    at += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

const b64 = (pcm) => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
const ms = (a, b) => (a == null || b == null ? null : Math.round(b - a));
const now = () => performance.now();
const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

const client = new GatewayClient({ baseUrl: url, token, device: { id: 'voice-latency', name: 'voice latency', platform: 'cli' }, WebSocketImpl: WebSocket, callTimeoutMs: 300_000 });
await new Promise((res, rej) => { client.onState((s, e) => { if (s === 'connected') res(); if (s === 'unauthorized') rej(new Error(`unauthorized ${e}`)); }); client.connect(); });

// every reply's text as it streams, by message id (deltas may come before chat.send has answered)
const replies = new Map();
const reply = (id) => { let r = replies.get(id); if (!r) { r = { parts: [], firstDeltaAt: null, done: null, listeners: new Set() }; replies.set(id, r); } return r; };
client.on('message.delta', (p) => {
  if (p.partType !== 'text') return;
  const r = reply(p.messageId);
  r.firstDeltaAt ??= now();
  r.parts[p.partIndex] = (r.parts[p.partIndex] ?? '') + p.delta;
  for (const l of r.listeners) l();
});
client.on('message.part', (p) => {
  if (p.part.type !== 'text') return;
  const r = reply(p.messageId);
  r.parts[p.partIndex] = p.part.text;
  for (const l of r.listeners) l();
});
client.on('message.completed', (p) => { const r = reply(p.messageId); r.done = p.status; for (const l of r.listeners) l(); });
const textOf = (r) => r.parts.filter((t) => t && t.trim()).join('\n\n');

/** the first piece voice mode would read: resolves with the words, or null when the reply ends without any */
function firstPiece(id, clauseMin) {
  const r = reply(id);
  return new Promise((resolve) => {
    const check = () => {
      const text = textOf(r);
      const cut = speakableEnd(text, 0, !!r.done, clauseMin);
      const words = cut > 0 ? speakablePiece(text.slice(0, cut)) : '';
      if (words || r.done) { clearTimeout(timer); r.listeners.delete(check); resolve(words ? { words, at: now() } : null); }
    };
    const timer = setTimeout(() => { r.listeners.delete(check); resolve(null); }, REPLY_WAIT_MS);
    r.listeners.add(check);
    check();
  });
}
const completed = (id) => new Promise((resolve) => { const r = reply(id); const check = () => { if (r.done) { r.listeners.delete(check); resolve(r.done); } }; r.listeners.add(check); check(); });

try {
  const bots = await client.call('bots.list');
  const bot = bots[0];
  if (!bot) throw new Error('no bot');
  const utterances = audioPaths.map(readWav);
  const live = pipeline === 'live';
  // the dev build's constants (the legacy pipeline's were fixed)
  const td = await import('../apps/desktop/src/renderer/src/features/voice/turnDetector.ts');
  const endQuiet = live ? td.END_QUIET_MS : 1200;
  console.log(`voice latency · ${pipeline} pipeline · ${bot.name} · ${utterances.length} utterance(s) · ${runs} run(s)`);

  if (live) {
    await client.call('voice.warm', {});
    await client.call('threads.warm', { botId: bot.id, session: true }).catch(() => undefined);
  }
  const rows = [];
  for (let run = 1; run <= runs; run++) {
    if (live) await client.call('voice.warm', {});
    const pcm = utterances[(run - 1) % utterances.length];
    const row = { run };
    let t0;
    let text;
    let recordingId;
    if (live) {
      const { Segmenter, joinSegments } = await import('../apps/desktop/src/renderer/src/features/voice/segmenter.ts');
      // fed as the microphone feeds it, 50 ms at a time in real time: the speech, then the quiet voice mode waits for;
      // what is cut at a pause is heard meanwhile
      const seg = new Segmenter();
      const pending = [];
      const padded = new Int16Array(pcm.length + endQuiet * 16);
      padded.set(pcm);
      for (let i = pcm.length; i < padded.length; i++) padded[i] = (i % 7) - 3;
      const tStart = now();
      for (let i = 0; i < padded.length; i += 800) {
        for (const s of seg.push(padded.subarray(i, i + 800))) pending.push(client.call('voice.transcribe', { audio: b64(s), format: 'pcm16' }).then((r) => r.text));
        await new Promise((r) => setTimeout(r, Math.max(0, tStart + (i + 800) / 16 - now())));
      }
      t0 = tStart + pcm.length / 16;
      // the turn's end is noticed now: the rest is heard (when it holds sound) while the recording uploads
      const tHear = now();
      const rest = seg.rest();
      if (rest.voiced || !pending.length) pending.push(client.call('voice.transcribe', { audio: b64(rest.pcm), format: 'pcm16' }).then((r) => r.text));
      const fd = new FormData();
      fd.append('file', new Blob([Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)], { type: 'audio/wav' }), 'voice.wav');
      const [texts, file] = await Promise.all([Promise.all(pending), fetch(`${url}/api/files`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd }).then((r) => r.json())]);
      row.heard = ms(tHear, now());
      row.segments = pending.length;
      text = joinSegments(texts);
      recordingId = file.id;
    } else {
      // the speaker stopped talking at t0; voice mode noticed `endQuiet` later and heard the whole recording, kept
      t0 = now();
      await new Promise((r) => setTimeout(r, endQuiet));
      const tHear = now();
      const heard = await client.call('voice.transcribe', { audio: b64(pcm), format: 'pcm16', keep: true });
      row.heard = ms(tHear, now());
      text = heard.text;
      recordingId = heard.recording.id;
    }
    const tSend = now();
    const sent = await client.call('chat.send', { botId: bot.id, text, voice: { recordingId, durationMs: Math.round(pcm.length / 16) } });
    const tSent = now();
    row.send = ms(tSend, tSent);
    const id = sent.agentMessageId;
    // the legacy pipeline waited for a whole sentence
    const piece = await firstPiece(id, live ? FIRST_CLAUSE_MIN : undefined);
    const r = reply(id);
    row.firstText = ms(tSent, r.firstDeltaAt);
    row.firstPiece = piece ? ms(tSent, piece.at) : null;
    if (piece) {
      const language = speechLanguage(piece.words, 'en');
      const first = speechChunks(piece.words, language)[0];
      const tSpeak = now();
      await client.call('voice.speak', { text: first, language, ...(live ? { format: 'wav', live: true } : {}) });
      row.speak = ms(tSpeak, now());
      row.total = ms(t0, now());
      row.words = first;
    }
    row.detect = endQuiet;
    // a reply that asks or works without saying anything is stopped, so the next run starts on an idle agent
    if (!piece) await client.call('chat.cancel', { threadId: sent.userMessage.threadId }).catch(() => undefined);
    row.status = await Promise.race([completed(id), new Promise((r) => setTimeout(() => r('still running'), REPLY_WAIT_MS))]);
    rows.push(row);
    console.log(`run ${run}: heard "${text}"${row.segments ? ` in ${row.segments} segment(s)` : ''}`);
    console.log(`  detect ${row.detect} · hear ${row.heard} · send ${row.send} · first text ${row.firstText} · first piece ${row.firstPiece} · speak ${row.speak} · total ${row.total} ms · "${row.words ?? ''}" (${row.status})`);
    // the agent is idle again before the next turn
    await new Promise((r) => setTimeout(r, 1500));
  }
  const keys = ['detect', 'heard', 'send', 'firstText', 'firstPiece', 'speak', 'total'];
  console.log(`\nmedian of ${rows.length}:`);
  for (const k of keys) console.log(`  ${k.padEnd(11)} ${String(median(rows.map((r) => r[k]))).padStart(6)} ms`);
  console.log('  (first text and first piece are counted from chat.send\'s answer; total from the end of speech to the first audio ready)');
} finally {
  client.close();
}
