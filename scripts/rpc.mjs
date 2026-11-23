#!/usr/bin/env -S npx tsx
/**
 * Call one gateway method as the owner of a dev app (launched with APPUBOT_DEV_INFO=<file>).
 * Usage: npx tsx scripts/rpc.mjs <devinfo.json> <method> ['<json params>']
 */
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { GatewayClient } from '@appubot/client';

const [infoPath, method, raw] = process.argv.slice(2);
if (!infoPath || !method) { console.error('usage: rpc.mjs <devinfo.json> <method> [json]'); process.exit(1); }
const { url, token } = JSON.parse(readFileSync(infoPath, 'utf8'));
const client = new GatewayClient({ baseUrl: url, token, device: { id: 'desktop', name: 'rpc', platform: 'desktop', appVersion: '0.1.0' }, WebSocketImpl: WebSocket, callTimeoutMs: 120_000 });
await new Promise((res, rej) => { client.onState((s, e) => { if (s === 'connected') res(); if (s === 'unauthorized') rej(new Error('unauthorized ' + e)); }); client.connect(); });
try {
  const result = await client.call(method, raw ? JSON.parse(raw) : undefined);
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exitCode = 1;
} finally {
  client.close();
}
