import { describe, expect, it } from 'vitest';
import type { Bot, Message, PermissionRequest, Thread } from '@appubot/protocol';
import { hasPlaceholderName, newBotName, openQuestion } from './threads';
import { appBots, connectedSlugs } from './apps';
import { argumentRows, wantsTo } from './approval';
import { repairMarkdownTableDelimiters } from './markdownTableRepair';
import { splitFileLines } from './message';
import { buildRoster, presenceOf, rosterPreview } from './roster';
import { toolIconKey, toolSentence, type ToolCallPart } from './toolText';

const bot = (id: string, name: string, job = ''): Bot => ({
  id, slug: id, name, emoji: '🤖', color: '#ee7944', shape: 'circle', job, instructions: '', providerId: 'claude-code', effort: 'medium', fast: false, workspace: `/w/${id}`,
  computerUse: true, autoApprove: 'safe', appsOff: [], pinned: false, chief: false, createdAt: 1, updatedAt: 1,
});
const thread = (id: string, botId: string, createdAt: number, extra: Partial<Thread> = {}): Thread => ({
  id, botId, title: '', providerId: 'claude-code', cwd: '/w', status: 'idle', modes: [], models: [], efforts: [], fastAvailable: false, fast: false, commands: [], source: 'desktop',
  lastMessagePreview: '', createdAt, updatedAt: createdAt, ...extra,
});

describe('roster', () => {
  const bots = [bot('a', 'Accountant', 'Makes invoices'), bot('b', 'Researcher')];
  const threads = [
    thread('t1', 'a', 1, { lastMessagePreview: 'Sent **invoice.pdf**' }),
    thread('t2', 'a', 5, { status: 'running' }),
    thread('t3', 'b', 2),
    thread('tg', 'b', 9, { source: 'channel' }),
  ];

  it('shows each bot with its current chat, its latest message, unread from any of its chats, and presence', () => {
    const rows = buildRoster(bots, threads, { unread: { t1: true }, waiting: new Set(['t3']) });
    expect(rows.map((r) => [r.bot.id, r.chat?.id, r.latest?.id, r.unread, r.presence])).toEqual([
      ['a', 't2', 't1', true, 'working'],
      ['b', 't3', undefined, false, 'needs-you'],
    ]);
  });

  it('follows the thread sent to last, and shows a reply that finished in an older thread', () => {
    // t1 was sent to after t2 started: it is current again
    const sent = [thread('t1', 'a', 1, { lastActiveAt: 9, updatedAt: 9, lastMessagePreview: 'Back here' }), thread('t2', 'a', 5, { lastMessagePreview: 'Newer thread' })];
    expect(buildRoster(bots, sent, { unread: {}, waiting: new Set() })[0]).toMatchObject({ chat: { id: 't1' }, latest: { id: 't1' } });
    // a reply in an older thread is the bot's latest message, wherever new turns go
    const replied = [thread('t1', 'a', 1, { updatedAt: 20, lastMessagePreview: 'Late reply' }), thread('t2', 'a', 5, { lastMessagePreview: '' })];
    expect(buildRoster(bots, replied, { unread: {}, waiting: new Set() })[0]).toMatchObject({ chat: { id: 't2' }, latest: { id: 't1' } });
    // any running thread makes the bot work
    const busy = [thread('t1', 'a', 1, { status: 'running' }), thread('t2', 'a', 5)];
    expect(buildRoster(bots, busy, { unread: {}, waiting: new Set() })[0]!.presence).toBe('working');
  });

  it('searches names and jobs', () => {
    expect(buildRoster(bots, threads, { unread: {}, waiting: new Set(), query: ' invo ' }).map((r) => r.bot.id)).toEqual(['a']);
  });

  it('previews the last message without markdown, else the job, else "Say hi"', () => {
    expect(rosterPreview(bots[0]!, threads[0], null)).toBe('Sent invoice.pdf');
    expect(rosterPreview(bots[0]!, undefined, null)).toBe('Makes invoices');
    expect(rosterPreview(bots[1]!, undefined, null)).toBe('Say hi');
    expect(rosterPreview(bots[0]!, threads[1], 'working')).toBe('Working…');
    expect(rosterPreview(bots[0]!, threads[0], 'needs-you')).toBe('Needs you…');
    expect(presenceOf({ status: 'waiting' }, false)).toBe('needs-you');
    expect(presenceOf([{ status: 'idle' }, { status: 'waiting' }], false)).toBe('needs-you');
    expect(presenceOf([], false)).toBe(null);
  });
});

describe('approvals', () => {
  const req = (extra: Partial<PermissionRequest>): PermissionRequest => ({
    id: 'p', threadId: 't', botId: 'b', title: 'Click', kind: 'other', content: [], options: [], createdAt: 1, ...extra,
  });
  it('says what the bot wants to do', () => {
    expect(wantsTo(req({ kind: 'execute' }))).toBe('run a command');
    expect(wantsTo(req({ kind: 'edit', content: [{ type: 'diff', path: '/a/new.ts', oldText: null, newText: 'x' }] }))).toBe('create new.ts');
    expect(wantsTo(req({ kind: 'computer', title: 'Click Save' }))).toBe('use your computer (click Save)');
    expect(wantsTo(req({ title: 'Ask you' }))).toBe('ask you a question');
  });
  it('lists arguments as rows', () => {
    expect(argumentRows({ file_name: 'a.txt', tags: ['x', 'y'], n: { a: 1 } })).toEqual([
      { name: 'file name', value: 'a.txt' }, { name: 'tags', value: 'x, y' }, { name: 'n', value: '{"a":1}' },
    ]);
  });
});

describe('messages and tools', () => {
  it('pulls attached paths out of a sent message', () => {
    expect(splitFileLines('Look at these\nFiles: /a/b.pdf\nFiles: /c.png')).toEqual({ body: 'Look at these', paths: ['/a/b.pdf', '/c.png'] });
  });

  it('names a fetch by its site even without URL.hostname', () => {
    const fetch = (url: string): ToolCallPart => ({ type: 'tool_call', toolCallId: 'f', title: 'Fetch', kind: 'fetch', status: 'completed', content: [], locations: [], rawInput: { url } });
    expect(toolSentence(fetch('https://www.example.com/a?b=1'), false)).toEqual({ verb: 'Fetched', object: 'example.com' });
    const realURL = globalThis.URL;
    // React Native's URL throws on `hostname`
    globalThis.URL = class { get hostname(): string { throw new Error('URL.hostname is not implemented'); } } as unknown as typeof URL;
    try {
      expect(toolSentence(fetch('https://docs.expo.dev/x'), true)).toEqual({ verb: 'Fetching', object: 'docs.expo.dev' });
    } finally {
      globalThis.URL = realURL;
    }
  });

  it('picks a row glyph by kind, then by AppuBot tool title', () => {
    const t = (kind: ToolCallPart['kind'], title = 'x'): ToolCallPart => ({ type: 'tool_call', toolCallId: 'i', title, kind, status: 'completed', content: [], locations: [] });
    expect(toolIconKey(t('execute'))).toBe('command');
    expect(toolIconKey(t('delete'))).toBe('edit');
    expect(toolIconKey(t('other', 'Send file to you'))).toBe('send');
    // the title older transcripts saved
    expect(toolIconKey(t('other', 'Send file to your phone'))).toBe('send');
    expect(toolIconKey(t('other', 'Remember'))).toBe('think');
    expect(toolIconKey(t('other'))).toBe('tool');
  });

  it('repairs a half-streamed table delimiter row', () => {
    expect(repairMarkdownTableDelimiters('| a | b | c |\n|---|---|\n| 1 | 2 | 3 |')).toBe('| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |');
    expect(repairMarkdownTableDelimiters('plain text')).toBe('plain text');
  });
});

describe('apps per bot', () => {
  const bots = [bot('a', 'Accountant'), { ...bot('b', 'Researcher'), appsOff: ['gmail'] }, { ...bot('c', 'Writer'), appsOff: ['gmail', 'slack'] }];

  it('says which bots may use an app', () => {
    expect(appBots(bots, 'notion')).toMatchObject({ label: 'All bots', total: 3 });
    expect(appBots(bots, 'slack').label).toBe('2 of 3 bots');
    expect(appBots(bots, 'gmail').label).toBe('Accountant');
    expect(appBots(bots, 'gmail').on.map((b) => b.id)).toEqual(['a']);
    expect(appBots([bots[2]!], 'gmail').label).toBe('No bots');
    expect(appBots([bots[0]!], 'gmail').label).toBe('Accountant');
    expect(appBots([], 'gmail').label).toBe('');
  });

  it('lists each connected app once', () => {
    expect(connectedSlugs([{ slug: 'gmail' }, { slug: 'notion' }, { slug: 'gmail' }])).toEqual(['gmail', 'notion']);
    expect(connectedSlugs(null)).toEqual([]);
  });
});

describe('new bot setup', () => {
  const q = (answer?: string) => ({ type: 'question' as const, questionId: 'q1', question: 'What for?', options: [], ...(answer !== undefined ? { answer } : {}) });
  const msg = (role: 'agent' | 'user', status: 'streaming' | 'complete', parts: Message['parts']): Message =>
    ({ id: Math.random().toString(36), threadId: 't', role, parts, status, via: 'desktop', createdAt: 1, updatedAt: 1 }) as Message;

  it('finds the question a reply still being written waits on', () => {
    expect(openQuestion([msg('agent', 'streaming', [{ type: 'text', text: 'Hi' }, q()])])).toBe('q1');
    expect(openQuestion([msg('agent', 'streaming', [q('Email')])])).toBeUndefined();
    expect(openQuestion([msg('agent', 'complete', [q()])])).toBeUndefined();
    expect(openQuestion([])).toBeUndefined();
  });

  it('names a new bot New Bot, then New Bot 2…', () => {
    expect(newBotName(['Appu'])).toBe('New Bot');
    expect(newBotName(['new bot', 'New Bot 2'])).toBe('New Bot 3');
    expect(hasPlaceholderName(' New Bot 2 ')).toBe(true);
    expect(hasPlaceholderName('Munshi')).toBe(false);
  });
});
