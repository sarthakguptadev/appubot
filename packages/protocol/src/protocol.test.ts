import { test } from 'vitest';
import assert from 'node:assert/strict';
import { BATCH_FEATURE, BATCH_ITEMS_MAX, BatchFrameSchema, ClientFrameSchema, GATEWAY_FEATURES, ServerFrameSchema, ConnectFrameSchema, HelloErrorFrameSchema, HelloFrameSchema, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION, protocolMatch, buildPairUrl, parsePairUrl, applyDelta, SettingsSchema, stripMarkdown, currentChat, botThreads, appOn, appsOn, withAppOn, Methods, Events, MessageSchema, BotSchema, AppsStatusSchema, AppToolkitSchema, AppConnectionSchema } from './index';

test('pair url round-trips', () => {
  const url = buildPairUrl({ hosts: ['100.91.133.6', 'mac.tail.ts.net'], port: 7890, code: '123456', hostName: 'Mac' });
  const p = parsePairUrl(url);
  assert.deepEqual(p, { hosts: ['100.91.133.6', 'mac.tail.ts.net'], port: 7890, code: '123456', hostName: 'Mac' });
  assert.equal(parsePairUrl('https://nope'), null);
});

test('applyDelta creates parts and appends', () => {
  const m = MessageSchema.parse({ id: 'm', threadId: 't', role: 'agent', parts: [], createdAt: 1, updatedAt: 1 });
  applyDelta(m, 0, 'text', 'hel');
  applyDelta(m, 0, 'text', 'lo');
  applyDelta(m, 1, 'thought', 'hmm');
  assert.equal(m.parts.length, 2);
  assert.deepEqual(m.parts[0], { type: 'text', text: 'hello' });
});

test('every method and event has a schema', () => {
  for (const [k, v] of Object.entries(Methods)) { assert.ok(v.params, k); assert.ok(v.result, k); }
  for (const [k, v] of Object.entries(Events)) assert.ok(v, k);
  assert.ok(Methods['chat.send'].params.parse({ threadId: 't', text: 'hi' }));
});

test('stripMarkdown turns agent markdown into preview text', () => {
  assert.equal(stripMarkdown("I'm running on **Claude Opus 5.5** (model ID `claude-opus-5-5`)."), "I'm running on Claude Opus 5.5 (model ID claude-opus-5-5).");
  assert.equal(stripMarkdown("I've sent `outbox/list.txt` - see [the docs](https://x.y) and *this*."), "I've sent outbox/list.txt - see the docs and this.");
  assert.equal(stripMarkdown('## Done\n- one\n- two\n> quoted'), 'Done\none\ntwo\nquoted');
  assert.equal(stripMarkdown('Here:\n\n| Item | Taxable value | IGST |\n|---|:---:|---:|\n| Pens | 1,200 | 216 |\n| | Total | 216 |'), 'Here:\n\nItem · Taxable value · IGST\nPens · 1,200 · 216\nTotal · 216');
  assert.equal(stripMarkdown('Use a | b or c'), 'Use a | b or c');
  assert.equal(stripMarkdown('Before\n---\nAfter'), 'Before\n---\nAfter');
  assert.equal(stripMarkdown('keep snake_case_names and 2 * 3 * 4'), 'keep snake_case_names and 2 * 3 * 4');
});

test('currentChat picks the newest non-Telegram thread of the bot', () => {
  const t = (id: string, botId: string, createdAt: number, source: 'desktop' | 'routine' | 'channel' = 'desktop') => ({ id, botId, createdAt, source });
  const threads = [t('a', 'b1', 1), t('b', 'b1', 5), t('c', 'b1', 9, 'channel'), t('d', 'b2', 7), t('e', 'b1', 3, 'routine')];
  assert.equal(currentChat(threads, 'b1')?.id, 'b');
  assert.equal(currentChat(threads, 'b2')?.id, 'd');
  assert.equal(currentChat(threads, 'nope'), undefined);
});

test('currentChat follows the thread started or sent to last; botThreads lists a bot\'s threads by latest activity', () => {
  const t = (id: string, createdAt: number, extra: { lastActiveAt?: number; updatedAt?: number; source?: 'desktop' | 'channel' } = {}) =>
    ({ id, botId: 'b1', createdAt, updatedAt: extra.updatedAt ?? createdAt, source: extra.source ?? 'desktop', lastActiveAt: extra.lastActiveAt });
  // a thread from an older version (no lastActiveAt) counts from when it was made
  assert.equal(currentChat([t('old', 1), t('new', 5, { lastActiveAt: 5 })], 'b1')?.id, 'new');
  // sending in the older thread makes it current again
  assert.equal(currentChat([t('old', 1, { lastActiveAt: 9 }), t('new', 5, { lastActiveAt: 5 })], 'b1')?.id, 'old');
  // ties go to the newer thread
  assert.equal(currentChat([t('x', 1, { lastActiveAt: 9 }), t('y', 2, { lastActiveAt: 9 })], 'b1')?.id, 'y');
  const list = botThreads([t('a', 1, { updatedAt: 3 }), t('b', 2, { updatedAt: 8 }), t('tg', 4, { updatedAt: 20, source: 'channel' }), { ...t('c', 1), botId: 'b2' }], 'b1');
  assert.deepEqual(list.map((x) => x.id), ['tg', 'b', 'a']);
});

test('apps: status never carries tokens, catalog pages default, connect takes a slug, agent calls are bounded', () => {
  const status = AppsStatusSchema.parse({ configured: true, account: 'me@example.com', accessToken: 'secret' });
  assert.equal('accessToken' in status, false);
  assert.deepEqual(status.pending, []);
  assert.equal(status.signingIn, false);
  assert.ok(Events['apps.updated'].parse(status));
  assert.deepEqual(Methods['apps.catalog'].params.parse(undefined), { limit: 60 });
  assert.deepEqual(Methods['apps.catalog'].params.parse({ search: 'gma', category: 'productivity' }), { search: 'gma', category: 'productivity', limit: 60 });
  assert.throws(() => Methods['apps.catalog'].params.parse({ limit: 0 }));
  assert.throws(() => Methods['apps.catalog'].params.parse({ slugs: Array.from({ length: 51 }, (_, i) => `t${i}`) }));
  assert.deepEqual(Methods['apps.connect'].params.parse({ slug: 'gmail' }), { slug: 'gmail' });
  // API-key fields and the old phone-only fields are dropped: Composio's own page asks for what an app needs
  assert.deepEqual(Methods['apps.connect'].params.parse({ slug: 'tavily', fields: { api_key: 'tvly-1' } }), { slug: 'tavily' });
  assert.deepEqual(Methods['apps.connect'].params.parse({ slug: 'gmail', open: 'caller' }), { slug: 'gmail', open: 'caller' });
  assert.throws(() => Methods['apps.connect'].params.parse({ slug: 'gmail', open: 'phone' }));
  assert.throws(() => Methods['apps.connect'].params.parse({ slug: '' }));
  assert.throws(() => Methods['apps.disconnect'].params.parse({ connectedAccountId: 'gmail_x' }));
  assert.ok(Methods['apps.disconnect'].params.parse({ connectedAccountId: 'gmail_x', slug: 'gmail' }));
  assert.deepEqual(AppToolkitSchema.parse({ slug: 'gmail', name: 'Gmail', authKind: 'oauth' }), { slug: 'gmail', name: 'Gmail', categories: [], authKind: 'oauth' });
  assert.throws(() => AppToolkitSchema.parse({ slug: 'gmail', name: 'Gmail', authKind: 'magic' }));
  assert.ok(AppConnectionSchema.parse({ slug: 'gmail', connectedAccountId: 'gmail_x', status: 'ACTIVE' }));
  assert.throws(() => Methods['agent.apps.search'].params.parse({ queries: [] }));
  assert.ok(Methods['agent.apps.execute'].params.parse({ tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'a@b.c' } }] }));
  assert.throws(() => Methods['agent.apps.execute'].params.parse({ tools: [{ tool_slug: 'GMAIL_SEND_EMAIL' }] }));
});

test('update patches never fill in defaults for fields the caller did not send', () => {
  assert.deepEqual(Methods['settings.update'].params.parse({ theme: 'dark' }), { theme: 'dark' });
  assert.deepEqual(Methods['settings.update'].params.parse({ computer: { liveView: false } }), { computer: { liveView: false } });
  assert.deepEqual(Methods['bots.update'].params.parse({ id: 'b1', patch: { color: '#fff' } }), { id: 'b1', patch: { color: '#fff' } });
  assert.deepEqual(Methods['routines.update'].params.parse({ id: 'r1', patch: { enabled: false } }), { id: 'r1', patch: { enabled: false } });
  assert.throws(() => Methods['bots.update'].params.parse({ id: 'b1', patch: { shape: 'banana' } }));
  // a phone switching lid mode alone must not reset keepAwake
  assert.deepEqual(Methods['settings.update'].params.parse({ power: { lidClosed: true } }), { power: { lidClosed: true } });
  assert.deepEqual(Methods['agent.bots.update'].params.parse({ patch: { job: 'Books' } }), { patch: { job: 'Books' } });
});

test('a bot may change its setup or another bot’s, but never its folder or raw app list', () => {
  assert.deepEqual(Methods['agent.bots.update'].params.parse({ id: 'b2', patch: { instructions: 'Be brief', name: 'Ledger' } }), { id: 'b2', patch: { instructions: 'Be brief', name: 'Ledger' } });
  // what grants abilities is in the patch (the Mac asks the user first); apps change one at a time; the rest is dropped
  const p = Methods['agent.bots.update'].params.parse({ patch: { job: 'x', modeId: 'bypassPermissions', providerId: 'codex', computerUse: true, appsTurnOn: ['gmail'], appsOff: [], workspace: '/', autoApprove: 'always' } });
  assert.deepEqual(p, { patch: { job: 'x', modeId: 'bypassPermissions', providerId: 'codex', computerUse: true, appsTurnOn: ['gmail'] } });
  // nothing left out is filled in with a default
  assert.deepEqual(Methods['agent.bots.create'].params.parse({ name: 'Scout' }), { name: 'Scout' });
  assert.deepEqual(Methods['agent.bots.history'].params.parse({}), { limit: 30 });
  assert.throws(() => Methods['agent.bots.history'].params.parse({ limit: 500 }));
});

test('bot creation can ask the new bot to speak first; settings default to keeping the Mac awake', () => {
  assert.equal(Methods['bots.create'].params.parse({ name: 'N', providerId: 'p', greet: true }).greet, true);
  assert.equal(Methods['bots.create'].params.parse({ name: 'N', providerId: 'p' }).greet, undefined);
  const s = Methods['settings.get'].result.parse({});
  assert.deepEqual(s.power, { keepAwake: true, lidClosed: false });
  assert.ok(Methods['power.setLidClosed'].params.parse({ on: true }));
});

test('apps per bot: every connected app is on unless the bot turned it off', () => {
  const bot = BotSchema.parse({ id: 'b1', slug: 'b', name: 'B', providerId: 'claude-code', workspace: '/w', createdAt: 1, updatedAt: 1 });
  assert.deepEqual(bot.appsOff, []);
  // the patch carries only what the caller sent, and a list replaces the old one
  assert.deepEqual(Methods['bots.update'].params.parse({ id: 'b1', patch: { appsOff: ['gmail'] } }), { id: 'b1', patch: { appsOff: ['gmail'] } });
  assert.deepEqual(Methods['bots.update'].params.parse({ id: 'b1', patch: { appsOff: [] } }), { id: 'b1', patch: { appsOff: [] } });
  assert.throws(() => Methods['bots.update'].params.parse({ id: 'b1', patch: { appsOff: 'gmail' } }));
  assert.deepEqual(Methods['bots.create'].params.parse({ name: 'N', providerId: 'p' }).appsOff, []);
  assert.deepEqual(Methods['bots.create'].params.parse({ name: 'N', providerId: 'p', appsOff: ['slack'] }).appsOff, ['slack']);

  const off = { appsOff: ['slack'] };
  assert.equal(appOn(off, 'gmail'), true);
  assert.equal(appOn(off, 'slack'), false);
  // bots saved before per-bot apps have no list: everything is on
  assert.equal(appOn({} as { appsOff: string[] }, 'slack'), true);
  assert.deepEqual(appsOn(off, ['slack', 'notion', 'gmail', 'gmail']), ['gmail', 'notion']);
  assert.deepEqual(withAppOn(off, 'gmail', false), ['slack', 'gmail']);
  assert.deepEqual(withAppOn(off, 'slack', true), []);
  assert.deepEqual(withAppOn({ appsOff: ['gmail'] }, 'gmail', false), ['gmail']);
});

test('providers carry their update check, and checking/updating take an id list / an id', () => {
  const base = { id: 'claude-code', name: 'Claude Code', command: '$node' };
  const before = Events['provider.updated'].parse(base);
  assert.equal(before.updateAvailable, undefined);
  assert.equal(before.update, undefined);
  const p = Events['provider.updated'].parse({ ...base, latestVersion: '2.0.20', updateAvailable: true, update: { current: '2.0.14', via: 'claude update' } });
  assert.deepEqual(p.update, { current: '2.0.14', via: 'claude update', running: false });
  assert.deepEqual(Methods['providers.checkUpdates'].params.parse(undefined), {});
  assert.deepEqual(Methods['providers.update'].params.parse({ id: 'codex' }), { id: 'codex' });
  assert.throws(() => Methods['providers.update'].params.parse({}));
});

test('resume and revisions: bootId, gap, a message’s rev, an answer’s clientId', () => {
  const connect = ConnectFrameSchema.parse({ type: 'connect', token: 't', device: { id: 'p', name: 'p', platform: 'ios' }, lastSeq: 9, bootId: 'run-1' });
  assert.equal(connect.bootId, 'run-1');
  // older servers send neither (both optional)
  assert.equal(HelloFrameSchema.shape.bootId.safeParse(undefined).success, true);
  assert.equal(HelloFrameSchema.shape.gap.safeParse(true).success, true);
  assert.equal(MessageSchema.parse({ id: 'm', threadId: 't', role: 'agent', parts: [], createdAt: 1, updatedAt: 1, rev: 4 }).rev, 4);
  assert.throws(() => MessageSchema.parse({ id: 'm', threadId: 't', role: 'agent', parts: [], createdAt: 1, updatedAt: 1, rev: -1 }));
  assert.equal(Events['message.delta'].parse({ threadId: 't', messageId: 'm', partIndex: 0, partType: 'text', delta: 'x', rev: 3 }).rev, 3);
  assert.equal(Events['message.completed'].parse({ threadId: 't', messageId: 'm', status: 'complete' }).rev, undefined);
  assert.equal(Methods['chat.answer'].params.parse({ questionId: 'q', answer: 'a', clientId: 'local:1' }).clientId, 'local:1');
});

test('protocol range: each side must speak at least the other’s oldest, and they speak the lower version', () => {
  assert.ok(MIN_PROTOCOL_VERSION <= PROTOCOL_VERSION);
  // equal
  assert.deepEqual(protocolMatch({ version: 3, min: 2 }, { version: 3, min: 2 }), { ok: true, version: 3 });
  // a newer phone within the computer's range, and the other way round
  assert.deepEqual(protocolMatch({ version: 4, min: 2 }, { version: 3, min: 1 }), { ok: true, version: 3 });
  assert.deepEqual(protocolMatch({ version: 3, min: 1 }, { version: 4, min: 3 }), { ok: true, version: 3 });
  // a phone too old for the computer
  assert.deepEqual(protocolMatch({ version: 2, min: 2 }, { version: 5, min: 3 }), { ok: false, update: 'client' });
  // a computer too old for the phone
  assert.deepEqual(protocolMatch({ version: 5, min: 4 }, { version: 3, min: 1 }), { ok: false, update: 'server' });
  // an old client without a minimum speaks only its own version (the gateway passes its version as its min)
  assert.deepEqual(protocolMatch({ version: 1, min: 1 }, { version: 2, min: 1 }), { ok: true, version: 1 });
});

test('batches: a feature each side names, frames that carry frames', () => {
  assert.ok(GATEWAY_FEATURES.includes(BATCH_FEATURE));
  // older peers send no features (both optional), and an older server strips the client's
  assert.equal(ConnectFrameSchema.parse({ type: 'connect', token: 't', device: { id: 'p', name: 'p', platform: 'ios' } }).features, undefined);
  assert.deepEqual(ConnectFrameSchema.parse({ type: 'connect', token: 't', device: { id: 'p', name: 'p', platform: 'ios' }, features: ['batch', 'later'] }).features, ['batch', 'later']);
  assert.equal(HelloFrameSchema.shape.features.safeParse(undefined).success, true);
  const batch = { type: 'batch', items: [{ type: 'event', event: 'message.delta', payload: {}, seq: 4 }, { type: 'res', id: 'r', ok: true, result: 1 }] };
  assert.equal(BatchFrameSchema.safeParse(batch).success, true);
  assert.equal(ServerFrameSchema.safeParse(batch).success, true);
  assert.equal(ClientFrameSchema.safeParse({ type: 'batch', items: [{ type: 'req', id: 'a', method: 'system.ping' }] }).success, true);
  assert.equal(ClientFrameSchema.safeParse({ type: 'batch', items: Array.from({ length: BATCH_ITEMS_MAX + 1 }, (_, i) => ({ type: 'req', id: String(i), method: 'system.ping' })) }).success, false);
});

test('connect and hello frames: the range is optional for peers that predate it', () => {
  const old = ConnectFrameSchema.parse({ type: 'connect', protocolVersion: 1, token: 't', device: { id: 'd', name: 'n', platform: 'ios' } });
  assert.equal(old.minProtocolVersion, undefined);
  const now = ConnectFrameSchema.parse({ type: 'connect', protocolVersion: 2, minProtocolVersion: 1, token: 't', device: { id: 'd', name: 'n', platform: 'ios', appVersion: '2026.10.31' } });
  assert.equal(now.minProtocolVersion, 1);
  assert.equal(now.device.appVersion, '2026.10.31');
  assert.equal(HelloErrorFrameSchema.parse({ type: 'hello', ok: false, error: 'x', code: 'protocol_mismatch' }).update, undefined);
  assert.equal(HelloErrorFrameSchema.parse({ type: 'hello', ok: false, error: 'x', code: 'protocol_mismatch', update: 'server', protocolVersion: 1, minProtocolVersion: 1, serverVersion: '2026.10.31' }).update, 'server');
});
