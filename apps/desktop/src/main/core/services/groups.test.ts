/**
 * Bots talking to each other: `message_bot` (one bot's message lands in another's chat as its own, the reply comes
 * back), `message_bots` (a chief's broadcast), and groups (a room where the user's message goes to the lead, who
 * hands work out with @Name; each member answers in its own group thread and its reply is posted to the room; the
 * lead's plain message is a report to the user; the bots' exchange is paused after GROUP_HOPS_MAX).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot, GroupMessage } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

let core: Core;
let root: string;
let runtime: FakeRuntime;
let ada: Bot, bo: Bot, cy: Bot;
const ctxOf = (b: Bot) => ({ botId: b.id, threadId: core.services.threads.chatFor(b.id).id });
/** what each bot says in a group turn, by its name (the prompt names it "you (Name)") */
const script = new Map<string, (text: string) => string>();

const until = async (ok: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!ok()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const room = (id: string): GroupMessage[] => core.services.groups.history(id).messages;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-groups-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
  });
  await core.start();
  await core.services.providers.refresh();
  ada = core.services.bots.update(core.services.bots.list()[0]!.id, { name: 'Ada', chief: true });
  bo = core.services.bots.create({ name: 'Bo', providerId: ada.providerId, computerUse: false });
  cy = core.services.bots.create({ name: 'Cy', providerId: ada.providerId, computerUse: false });
  runtime.reply = (text) => {
    const who = /you \((\w+)\)/.exec(text)?.[1];
    if (who) return script.get(who)?.(text) ?? 'NO_REPLY';
    // a direct message from a bot: answer with what was asked
    if (text.includes('A message from the bot')) return `Got it: ${text.split('\n').at(-1)}`;
    return undefined;
  };
});
afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('message_bot', () => {
  it('lands in the other bot’s chat as a message from the caller, and its reply comes back', async () => {
    const r = await core.services.agentBridge.messageBot(ctxOf(ada), { bot: 'bo', text: 'What is 2+2?', wait: true });
    expect(r.bot).toEqual({ id: bo.id, name: 'Bo' });
    expect(r.reply).toBe('Got it: What is 2+2?');
    const msgs = core.services.threads.messages(r.threadId);
    const sent = msgs.find((m) => m.role === 'user');
    expect(sent).toMatchObject({ via: 'bot', from: { botId: ada.id, name: 'Ada' } });
    expect(sent?.parts).toEqual([{ type: 'text', text: 'What is 2+2?' }]);
    // the words the agent got carry the preface, the stored message doesn't
    expect(runtime.prompts.at(-1)?.blocks.some((b) => b.type === 'text' && b.text.includes('A message from the bot Ada'))).toBe(true);
    // the other bot's chat stays its current one, not Ada's
    expect(core.services.threads.chatFor(bo.id).id).toBe(r.threadId);
  });

  it('refuses itself and an unknown bot; without wait it answers at once', async () => {
    await expect(core.services.agentBridge.messageBot(ctxOf(ada), { bot: 'Ada', text: 'hi', wait: true })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(core.services.agentBridge.messageBot(ctxOf(ada), { bot: 'Zed', text: 'hi', wait: true })).rejects.toMatchObject({ code: 'not_found' });
    const r = await core.services.agentBridge.messageBot(ctxOf(ada), { bot: cy.id, text: 'Later', wait: false });
    expect(r.reply).toBeNull();
    await until(() => core.services.threads.messages(r.threadId).some((m) => m.role === 'agent' && m.status === 'complete'));
  });

  it('broadcasts for a chief only', async () => {
    await expect(core.services.agentBridge.broadcast(ctxOf(bo), { text: 'Status?', wait: true })).rejects.toMatchObject({ code: 'forbidden' });
    const r = await core.services.agentBridge.broadcast(ctxOf(ada), { text: 'Status?', wait: true });
    expect(r.replies.map((x) => x.bot.name).sort()).toEqual(['Bo', 'Cy']);
    expect(r.replies.every((x) => x.reply === 'Got it: Status?')).toBe(true);
  });
});

describe('groups', () => {
  it('runs the room: the user to the lead, the lead to members by @Name, members back to the lead, the lead’s report to the user', async () => {
    const g = core.services.groups.create({ name: 'Launch', botIds: [ada.id, bo.id, cy.id] });
    expect(g.leadId).toBeUndefined();
    script.set('Ada', (t) => (t.includes('The user wrote') ? '@Bo write the email. @Cy book the venue.' : t.includes('Venue booked') ? 'All done: email written, venue booked.' : 'NO_REPLY'));
    script.set('Bo', () => 'Email written.');
    script.set('Cy', () => 'Venue booked.');
    // members take turns: never more than GROUP_TURNS_AT_ONCE working at once, and two reports to the lead are one turn
    let mostAtOnce = 0;
    const off = core.ctx.bus.on((e) => { if (e.event === 'group.updated') mostAtOnce = Math.max(mostAtOnce, (e.payload as { working: string[] }).working.length); });
    const m = core.services.groups.send({ id: g.id, text: 'Plan the launch', limit: undefined } as never);
    expect(m.from).toEqual({ kind: 'user' });
    await until(() => room(g.id).some((x) => x.text.startsWith('All done')));
    off();
    expect(mostAtOnce).toBe(1);
    const adaGroup = core.services.threads.list({ limit: 1000 }).find((t) => t.botId === ada.id && t.source === 'group' && t.groupId === g.id)!;
    const adaTurns = core.services.threads.messages(adaGroup.id).filter((x) => x.role === 'user');
    expect(adaTurns.map((x) => x.parts.find((p) => p.type === 'text')?.text)).toEqual(['Plan the launch', 'Bo: Email written.\n\nCy: Venue booked.']);
    const texts = room(g.id).map((x) => `${x.from.kind === 'user' ? 'You' : x.from.name}: ${x.text}`);
    expect(texts[0]).toBe('You: Plan the launch');
    expect(texts[1]).toBe('Ada: @Bo write the email. @Cy book the venue.');
    expect(texts.slice(2).sort()).toEqual(['Ada: All done: email written, venue booked.', 'Bo: Email written.', 'Cy: Venue booked.']);
    const ada1 = room(g.id)[1]!;
    expect(ada1.mentions.sort()).toEqual([bo.id, cy.id].sort());
    expect(ada1.hop).toBe(1);
    // each member answered in its own thread for the group, never its current chat
    const boGroup = core.services.threads.list({ limit: 1000 }).find((t) => t.botId === bo.id && t.source === 'group');
    expect(boGroup?.groupId).toBe(g.id);
    expect(core.services.threads.chatFor(bo.id).id).not.toBe(boGroup!.id);
    expect(core.services.threads.messages(boGroup!.id).find((x) => x.role === 'user')).toMatchObject({ via: 'bot', from: { botId: ada.id, name: 'Ada' } });
    await until(() => core.services.groups.require(g.id).working.length === 0);
    expect(core.services.groups.require(g.id).lastMessagePreview).toMatch(/^Ada: All done/);
  });

  it('pins a group to the top of the roster and takes the pin off again', () => {
    const g = core.services.groups.create({ name: 'Pinned', botIds: [ada.id, bo.id] });
    expect(g.pinned).toBeUndefined();
    expect(core.services.groups.update(g.id, { pinned: true }).pinned).toBe(true);
    // a change of anything else keeps it
    expect(core.services.groups.update(g.id, { name: 'Pinned crew' })).toMatchObject({ name: 'Pinned crew', pinned: true });
    expect(core.services.groups.update(g.id, { pinned: false }).pinned).toBeUndefined();
    expect(core.services.system.info().groupPins).toBe(true);
    core.services.groups.delete(g.id);
  });

  it('pauses the bots’ exchange after GROUP_HOPS_MAX and takes a stop', async () => {
    const g = core.services.groups.create({ name: 'Loop', botIds: [ada.id, bo.id], leadId: ada.id });
    script.set('Ada', () => '@Bo again?');
    script.set('Bo', () => '@Ada again!');
    core.services.groups.send({ id: g.id, text: 'Go', limit: undefined } as never);
    await until(() => room(g.id).some((x) => x.from.kind === 'system' && x.text.startsWith('Paused')), 15000);
    const bots = room(g.id).filter((x) => x.from.kind === 'bot');
    expect(bots.length).toBe(12);
    await until(() => core.services.groups.require(g.id).working.length === 0);
    await core.services.groups.stop(g.id);
    expect(core.services.groups.require(g.id).working).toEqual([]);
  });

  it('a bot posts from its own chat, a deleted bot leaves, and the group’s threads go with it', async () => {
    const g = core.services.groups.create({ name: 'Ops', botIds: [bo.id, cy.id], leadId: cy.id });
    script.set('Cy', () => 'NO_REPLY');
    const posted = core.services.agentBridge.postToGroup(ctxOf(bo), 'ops', 'Heads up: done.');
    expect(posted.from).toEqual({ kind: 'bot', botId: bo.id, name: 'Bo' });
    await until(() => core.services.groups.require(g.id).working.length === 0 && room(g.id).length === 1);
    expect(() => core.services.agentBridge.postToGroup(ctxOf(ada), 'Ops', 'x')).not.toThrow(); // a chief may post anywhere
    const list = core.services.agentBridge.listGroups(ctxOf(bo));
    expect(list.map((x) => x.name).sort()).toEqual(['Launch', 'Loop', 'Ops']);
    expect(list.find((x) => x.name === 'Ops')?.lead).toBe('Cy');
    const zed = core.services.bots.create({ name: 'Zed', providerId: ada.providerId, computerUse: false });
    core.services.groups.update(g.id, { botIds: [bo.id, cy.id, zed.id] });
    await core.services.bots.delete(zed.id, false);
    expect(core.services.groups.require(g.id).botIds).toEqual([bo.id, cy.id]);
    await core.services.groups.delete(g.id);
    expect(core.services.groups.list().some((x) => x.id === g.id)).toBe(false);
    expect(core.services.threads.list({ limit: 1000 }).some((t) => t.groupId === g.id)).toBe(false);
  });

  it('keeps threads: a new one starts every member afresh, each with its own messages', async () => {
    const g = core.services.groups.create({ name: 'Threads', botIds: [bo.id], leadId: bo.id });
    script.set('Bo', (t) => `Bo heard: ${t.split('\n').at(-1)}`);
    // an empty current thread is reused
    expect(core.services.groups.newChat(g.id).chats).toEqual([]);
    core.services.groups.send({ id: g.id, text: 'first thread' });
    await until(() => room(g.id).length === 2);
    const first = core.services.threads.list({ limit: 1000 }).filter((t) => t.groupId === g.id);
    expect(first).toHaveLength(1);
    const next = core.services.groups.newChat(g.id);
    expect(next.chats.map((c) => c.id)).toEqual([g.id, next.currentChatId]);
    expect(next.chats[0]!.title).toBe('first thread');
    const chatId = next.currentChatId!;
    core.services.groups.send({ id: g.id, text: 'second thread' });
    await until(() => core.services.groups.history(g.id, { chatId }).messages.length === 2);
    expect(core.services.groups.history(g.id, { chatId }).messages.every((m) => m.chatId === chatId)).toBe(true);
    expect(room(g.id).map((m) => m.text)).toEqual(['second thread', 'Bo heard: second thread']);
    expect(core.services.groups.history(g.id, { chatId: g.id }).messages.map((m) => m.text)).toEqual(['first thread', 'Bo heard: first thread']);
    // the member answered the new thread in a new thread of its own
    const threads = core.services.threads.list({ limit: 1000 }).filter((t) => t.groupId === g.id);
    expect(threads).toHaveLength(2);
    expect(threads.find((t) => t.groupChatId === chatId)).toBeTruthy();
    // writing in an older thread makes it current again
    core.services.groups.send({ id: g.id, chatId: g.id, text: 'back to the first' });
    expect(core.services.groups.require(g.id).currentChatId).toBe(g.id);
    await until(() => core.services.groups.require(g.id).working.length === 0 && core.services.groups.history(g.id, { chatId: g.id }).messages.length === 4);
    await core.services.groups.delete(g.id);
  });

  it('puts every member on the group’s model, and back on its own when cleared', async () => {
    const g = core.services.groups.create({ name: 'Model', botIds: [bo.id], leadId: bo.id });
    script.set('Bo', () => 'NO_REPLY');
    const other = core.services.providers.list().find((p) => p.id !== bo.providerId)!;
    expect(() => core.services.groups.update(g.id, { providerId: 'nope' })).toThrow();
    core.services.groups.update(g.id, { providerId: bo.providerId, modelId: 'fake-model' });
    core.services.groups.send({ id: g.id, text: 'one' });
    await until(() => core.services.groups.require(g.id).working.length === 0 && core.services.threads.list({ limit: 1000 }).some((t) => t.groupId === g.id && t.status === 'idle'));
    const t = () => core.services.threads.list({ limit: 1000 }).find((x) => x.groupId === g.id)!;
    expect(t().modelId).toBe('fake-model');
    // another agent: the model goes with it, and the thread moves over
    const moved = core.services.groups.update(g.id, { providerId: other.id });
    expect(moved.modelId).toBeUndefined();
    core.services.groups.send({ id: g.id, text: 'two' });
    await until(() => t().providerId === other.id);
    await until(() => core.services.groups.require(g.id).working.length === 0);
    // cleared: each bot's own again
    const cleared = core.services.groups.update(g.id, { providerId: '' });
    expect(cleared.providerId).toBeUndefined();
    core.services.groups.send({ id: g.id, text: 'three' });
    await until(() => t().providerId === bo.providerId);
    await until(() => core.services.groups.require(g.id).working.length === 0);
    await core.services.groups.delete(g.id);
  });

  it('works toward a goal on its own: the lead is sent on when the room is quiet, past the hop limit, until it finishes', async () => {
    const g = core.services.groups.create({ name: 'Goal', botIds: [bo.id, cy.id], leadId: bo.id });
    let leadTurns = 0;
    script.set('Bo', (t) => {
      expect(t).toContain('The group has a goal');
      leadTurns++;
      // the lead hands a part out, then finishes once Cy has reported back twice
      if (leadTurns >= 3) { core.services.groups.finishGoal(g.id, g.id, 'done', 'Both parts are in.'); return 'All done.'; }
      return '@Cy do the next part';
    });
    script.set('Cy', () => 'Part done.');
    core.services.groups.startGoal(g.id, g.id, 'Ship both parts', 40);
    await until(() => core.services.groups.require(g.id).chats.find((c) => c.id === g.id)?.goal?.status === 'done', 10_000);
    const texts = room(g.id).map((m) => m.text);
    expect(texts[0]).toBe('Goal on: Ship both parts');
    expect(texts).toContain('Goal done: Both parts are in.');
    expect(texts.filter((x) => x === 'Part done.').length).toBe(2);
    const goal = core.services.groups.require(g.id).chats.find((c) => c.id === g.id)!.goal!;
    expect(goal.turns).toBeGreaterThanOrEqual(4);
    await until(() => core.services.groups.require(g.id).working.length === 0);
    await core.services.groups.delete(g.id);
  });

  it('pauses a group goal when its messages run out', async () => {
    const g = core.services.groups.create({ name: 'Budget', botIds: [bo.id, cy.id], leadId: bo.id });
    script.set('Bo', () => '@Cy again');
    script.set('Cy', () => '@Bo again');
    core.services.groups.startGoal(g.id, g.id, 'Loop', 5);
    await until(() => core.services.groups.require(g.id).chats.find((c) => c.id === g.id)?.goal?.status === 'paused', 10_000);
    expect(room(g.id).at(-1)?.text).toBe('Goal paused: it used its 5 messages. Resume it to carry on.');
    await until(() => core.services.groups.require(g.id).working.length === 0);
    await core.services.groups.delete(g.id);
  });

  it('never makes a group thread a bot’s chat, frees the room when a working bot is deleted, and keeps post_to_group out of the conversation', async () => {
    const zed = core.services.bots.create({ name: 'Zed', providerId: ada.providerId, computerUse: false });
    const g = core.services.groups.create({ name: 'Fixes', botIds: [zed.id, cy.id], leadId: zed.id });
    let release: (v: string) => void = () => undefined;
    script.set('Zed', () => new Promise<string>((r) => { release = r; }) as unknown as string);
    core.services.groups.send({ id: g.id, text: 'go' });
    await until(() => core.services.groups.require(g.id).working.includes(zed.id));
    const gt = core.services.threads.list({ limit: 1000 }).find((t) => t.groupId === g.id && t.botId === zed.id)!;
    expect(gt.lastActiveAt).toBe(0);
    expect(core.services.threads.chatFor(zed.id).id).not.toBe(gt.id);
    expect(() => core.services.agentBridge.postToGroup({ botId: zed.id, threadId: gt.id }, g.id, 'x')).toThrow(/conversation/);
    await core.services.bots.delete(zed.id, false);
    release('late');
    await until(() => core.services.groups.require(g.id).working.length === 0);
    // the room still takes work
    script.set('Cy', () => 'On it.');
    core.services.groups.send({ id: g.id, text: '@Cy you there?' });
    await until(() => room(g.id).some((m) => m.text === 'On it.'));
    await core.services.groups.delete(g.id);
  });

  it('restores a room another computer had into a new group, once, linking its members’ threads to it', async () => {
    // a member's own thread for the group as it came with the bot (its group id from the other computer)
    const old = core.services.threads.create({ botId: bo.id, source: 'group', groupId: 'grp_there', title: 'Group: Team' });
    const oldSecond = core.services.threads.create({ botId: bo.id, source: 'group', groupId: 'grp_there', groupChatId: 'gc_there', title: 'Group: Team' });
    const g = core.services.groups.create({ name: 'Team', botIds: [ada.id, bo.id], leadId: ada.id });
    const t0 = Date.now() - 60_000;
    const after = core.services.groups.restore({
      id: g.id, fromId: 'grp_there',
      chats: [
        { fromId: 'grp_there', title: 'Launch', createdAt: t0, messages: [
          { from: { kind: 'user' }, text: '@Bo plan the launch', mentions: [bo.id], hop: 0, createdAt: t0 + 1 },
          { from: { kind: 'bot', botId: bo.id, name: 'Bo' }, text: 'Planned.', mentions: [], hop: 1, createdAt: t0 + 2 },
          // a bot that didn't come keeps its name only
          { from: { kind: 'bot', botId: 'bot_gone', name: 'Dee' }, text: 'Me too.', mentions: ['bot_gone'], hop: 2, createdAt: t0 + 3 },
        ] },
        { fromId: 'gc_there', title: 'Later', createdAt: t0 + 10, messages: [{ from: { kind: 'user' }, text: 'Next week?', mentions: [], hop: 0, createdAt: t0 + 11 }] },
      ],
    });
    expect(after.chats.map((c) => c.title)).toEqual(['Launch', 'Later']);
    expect(after.chats[0]!.id).toBe(g.id);
    expect(after.currentChatId).toBe(after.chats[1]!.id);
    expect(after.lastMessagePreview).toContain('Next week?');
    const first = core.services.groups.history(g.id, { chatId: g.id }).messages;
    expect(first.map((m) => m.text)).toEqual(['@Bo plan the launch', 'Planned.', 'Me too.']);
    expect(first[2]!.from).toEqual({ kind: 'bot', name: 'Dee' });
    expect(first[2]!.mentions).toEqual([]);
    expect(core.services.groups.history(g.id, { chatId: after.chats[1]!.id }).messages).toHaveLength(1);
    // nobody was asked to answer them
    expect(core.services.groups.require(g.id).working).toEqual([]);
    // the member's threads follow the group here
    expect(core.services.threads.get(old.id)).toMatchObject({ groupId: g.id });
    expect(core.services.threads.get(old.id)?.groupChatId).toBeUndefined();
    expect(core.services.threads.get(oldSecond.id)).toMatchObject({ groupId: g.id, groupChatId: after.chats[1]!.id });
    // a second call (an answer lost on the way) doubles nothing
    expect(() => core.services.groups.restore({ id: g.id, chats: [{ title: '', createdAt: t0, messages: [] }] })).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(core.services.groups.history(g.id, { chatId: g.id }).messages).toHaveLength(3);
    await core.services.groups.delete(g.id);
  });
});
