/**
 * The Telegram bot wears its AppuBot bot's face: name, job as description, avatar as photo, each pushed only when it
 * changed since the last push (and all of it again for another Telegram bot).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VOICE_SPEAK_MAX_CHARS, type Bot } from '@appubot/protocol';
import { botAvatarSvg } from '@appubot/chat-core';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { GrammyError } from 'grammy';
import { describe as describeMessage, mediaOf, sendKind, speakable, telegramAbout } from './channels';
import { modelName } from './telegramCommands';

let core: Core;
let root: string;
let bot: Bot;
const drawn: string[] = [];
const calls: [string, unknown][] = [];
const api = {
  setMyName: async (n: string) => { calls.push(['name', n]); return true; },
  setMyDescription: async (d: string) => { calls.push(['description', d]); return true; },
  setMyShortDescription: async (d: string) => { calls.push(['short', d]); return true; },
  setMyProfilePhoto: async (p: { type: string }) => { calls.push(['photo', p.type]); return true; },
};
let channelId: string;
const runner = (id: string) => (core.services.channels as unknown as { runner(id: string): Record<string, unknown> }).runner(id);
/** a running Telegram bot with this id, without the network */
const attach = (id: number) => Object.assign(runner(channelId), { tg: { api }, tgId: id });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-channels-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    svgToJpeg: async (svg) => { drawn.push(svg); return new Uint8Array([0xff, 0xd8, 0xff]); },
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
  });
  await core.start();
  bot = core.services.bots.list()[0]!;
  bot = core.services.bots.update(bot.id, { name: 'Ledger', job: 'Keeps the books', color: '#3B82F6', shape: 'hex' });
  channelId = core.services.channels.add({ botId: bot.id }).id;
});

afterAll(async () => {
  Object.assign(runner(channelId), { tg: null, tgId: null });
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('telegram profile sync', () => {
  it('pushes the name, description and avatar once', async () => {
    attach(42);
    await core.services.channels.syncProfile();
    expect(calls).toEqual([['name', 'Ledger'], ['description', 'Keeps the books'], ['short', 'Keeps the books'], ['photo', 'static']]);
    expect(drawn).toEqual([botAvatarSvg('hex', '#3B82F6', 640)]);
    calls.length = 0;
    await core.services.channels.syncProfile();
    expect(calls).toEqual([]);
  });

  it('pushes only what changed', async () => {
    core.services.bots.update(bot.id, { name: 'Ledger Pro' });
    await core.services.channels.syncProfile();
    expect(calls).toEqual([['name', 'Ledger Pro']]);
    calls.length = 0;
    core.services.bots.update(bot.id, { color: '#EF4444' });
    await core.services.channels.syncProfile();
    expect(calls).toEqual([['photo', 'static']]);
    calls.length = 0;
  });

  it('starts over for another Telegram bot (a new token)', async () => {
    attach(43);
    await core.services.channels.syncProfile();
    expect(calls.map((c) => c[0])).toEqual(['name', 'description', 'short', 'photo']);
  });

  it('describes a bot without a job by its name', () => {
    expect(telegramAbout({ name: 'Appu', job: '  ' })).toBe('Appu, your AppuBot.');
  });
});

describe('several Telegram bots', () => {
  it('keeps the first one\'s id and gives the next bot its own handle', async () => {
    expect(channelId).toBe('telegram');
    const other = core.services.bots.create({ name: 'Second', providerId: bot.providerId });
    const c = core.services.channels.add({});
    expect(c.id).not.toBe('telegram');
    expect(c.botId).toBe(other.id);
    expect(core.services.channels.list().map((x) => x.id)).toEqual(['telegram', c.id]);
  });

  it('refuses a token another bot already uses', async () => {
    await core.services.channels.configure({ id: 'telegram', token: '123:abc', enabled: false });
    const c = core.services.channels.list()[1]!;
    await expect(core.services.channels.configure({ id: c.id, token: '123:abc' })).rejects.toThrow(/already uses/);
  });

  it('answers on Telegram only for the turns Telegram started', async () => {
    const c = core.services.channels.list()[1]!;
    const thread = core.services.threads.chatFor(c.botId!);
    const svc = core.services.channels as unknown as { askingIn(id: string): { chatId: string } | undefined };
    expect(svc.askingIn(thread.id)).toBeUndefined(); // a turn from the app: nothing goes to Telegram
    core.services.channels.trackTurn('msg_from_tg', { runnerId: c.id, chatId: '99', threadId: thread.id });
    expect(svc.askingIn(thread.id)?.chatId).toBe('99');
  });

  it('removes one and keeps the rest', async () => {
    const c = core.services.channels.list()[1]!;
    await core.services.channels.remove(c.id);
    expect(core.services.channels.list().map((x) => x.id)).toEqual(['telegram']);
  });
});

describe('telegram messages', () => {
  const sent: [string, ...unknown[]][] = [];
  const tgApi = {
    ...api,
    sendMessage: async (chat: string, text: string, o?: { parse_mode?: string }) => {
      if (o?.parse_mode === 'HTML' && text.includes('BROKEN')) throw new GrammyError('bad', { ok: false, error_code: 400, description: "can't parse entities" }, 'sendMessage', {});
      sent.push(['message', chat, text, o?.parse_mode]); return { message_id: 1 };
    },
    sendChatAction: async () => true,
    sendAudio: async (chat: string, f: { filename?: string }) => { sent.push(['audio', chat, f.filename]); return {}; },
    sendPhoto: async (chat: string, f: { filename?: string }) => { sent.push(['photo', chat, f.filename]); return {}; },
    sendVoice: async (chat: string, f: { filename?: string }) => { sent.push(['voice', chat, f.filename]); return {}; },
    sendVideo: async (chat: string, f: { filename?: string }) => { sent.push(['video', chat, f.filename]); return {}; },
    sendDocument: async (chat: string, f: { filename?: string }) => { sent.push(['document', chat, f.filename]); return {}; },
    getFile: async (id: string) => ({ file_id: id, file_path: `music/${id}.mp3` }),
  };
  const live = () => Object.assign(runner('telegram'), { tg: { api: tgApi }, tgId: 7 }) as unknown as {
    onCompleted(t: unknown, e: unknown): Promise<void>; sendFile(chat: string, f: unknown): Promise<void>; onMessage(cx: unknown): Promise<void>;
  };

  it('sends the reply formatted, quoting the message it answers', async () => {
    const r = live();
    await r.onCompleted({ chatId: '5', replyTo: 9 }, { status: 'complete', message: { parts: [{ type: 'text', text: '# Done\n\n**All** set: `ok`' }, { type: 'text', text: 'said', said: true }] } });
    expect(sent).toEqual([['message', '5', '<b>Done</b>\n\n<b>All</b> set: <code>ok</code>', 'HTML']]);
    sent.length = 0;
  });

  it('falls back to plain text when Telegram refuses the HTML', async () => {
    await live().onCompleted({ chatId: '5' }, { status: 'complete', message: { parts: [{ type: 'text', text: '**BROKEN** reply' }] } });
    expect(sent).toEqual([['message', '5', 'BROKEN reply', undefined]]);
    sent.length = 0;
  });

  it('sends files as what they are', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'appubot-tgfiles-'));
    const kinds: string[] = [];
    for (const name of ['song.mp3', 'pic.png', 'note.ogg', 'clip.mp4', 'report.pdf']) {
      writeFileSync(join(dir, name), 'x');
      const att = core.services.files.sendToDevices(join(dir, name), undefined, undefined);
      await live().sendFile('5', att);
      kinds.push(String(sent.pop()![0]));
    }
    expect(kinds).toEqual(['audio', 'photo', 'voice', 'video', 'document']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('brings an mp3 from Telegram into the bot\'s inbox', async () => {
    const c = core.services.channels.stored('telegram')!;
    core.services.channels.save('telegram', { allowedUsers: [...c.allowedUsers, '77'] });
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1, 2, 3])));
    const spy = vi.spyOn(core.services.chat, 'send');
    try {
      await live().onMessage({
        from: { id: 77 }, chat: { id: 5 }, reply: async () => undefined,
        message: { message_id: 3, caption: 'what song is this?', audio: { file_id: 'abc', performer: 'Band', title: 'Tune', mime_type: 'audio/mpeg', file_size: 3, duration: 1 } },
      });
      const p = spy.mock.calls[0]![0];
      expect(p.text).toBe('what song is this?');
      const rec = core.services.files.getRecord(p.attachments![0]!.id)!;
      expect(rec.name).toBe('Band - Tune.mp3');
      expect(rec.mimeType).toBe('audio/mpeg');
      expect(existsSync(rec.path!) && [...readFileSync(rec.path!)]).toEqual([1, 2, 3]);
      expect(rec.path).toContain('inbox');
    } finally { spy.mockRestore(); vi.unstubAllGlobals(); }
  });

  describe('voice messages', () => {
    type FakeVoice = { ready(k: 'stt' | 'tts'): boolean; hears(): boolean; transcribe: ReturnType<typeof vi.fn>; speakForMessage: ReturnType<typeof vi.fn> };
    const fakeVoice = (o: { stt?: boolean; tts?: boolean; hears?: boolean; heard?: string } = {}): FakeVoice => ({
      ready: (k) => (k === 'stt' ? o.stt ?? true : o.tts ?? true),
      hears: () => o.hears ?? true,
      transcribe: vi.fn(async () => ({ text: o.heard ?? 'what is on my calendar today', durationMs: 2000 })),
      speakForMessage: vi.fn(async () => ({ audio: new Uint8Array([0x4f, 0x67, 0x67, 0x53]), mimeType: 'audio/ogg', durationMs: 900, language: 'en', file: {} })),
    });
    const services = () => core.services as unknown as { voice: unknown };
    let realVoice: unknown;
    let nextMsg = 500;
    /** a voice note from chat `chat`, through a fake voice service */
    const voiceNote = async (voice: FakeVoice, chat = 5) => {
      const n = nextMsg++;
      services().voice = voice;
      vi.stubGlobal('fetch', async () => new Response(new Uint8Array([7, 8, 9])));
      const spy = vi.spyOn(core.services.chat, 'send').mockImplementation(() => ({ userMessage: {} as never, agentMessageId: `msg_voice_${n}` }));
      try {
        await live().onMessage({
          from: { id: 77 }, chat: { id: chat }, reply: async () => undefined,
          message: { message_id: n, voice: { file_id: `vf${n}`, duration: 2, mime_type: 'audio/ogg', file_size: 3 } },
        });
        return spy.mock.calls.map((c) => c[0]);
      } finally { spy.mockRestore(); vi.unstubAllGlobals(); }
    };
    const turns = () => (core.services.channels as unknown as { telegramTurns: Map<string, { voice?: boolean }> }).telegramTurns;

    beforeAll(() => {
      realVoice = services().voice;
      const c = core.services.channels.stored('telegram')!;
      if (!c.allowedUsers.includes('77')) core.services.channels.save('telegram', { allowedUsers: [...c.allowedUsers, '77'] });
    });
    afterAll(() => { services().voice = realVoice; });

    it('hears a voice note: the bot gets the words, the message keeps the recording', async () => {
      sent.length = 0;
      const voice = fakeVoice();
      const [p] = await voiceNote(voice);
      expect(p!.text).toBe('what is on my calendar today');
      expect(p!.attachments).toEqual([]);
      const rec = core.services.files.getRecord(p!.voice!.recordingId)!;
      expect(rec.name).toMatch(/^voice-\d+\.ogg$/);
      expect(p!.voice!.durationMs).toBe(2000);
      expect(voice.transcribe).toHaveBeenCalledWith({ audio: expect.anything(), format: 'ogg' });
      expect([...(voice.transcribe.mock.calls[0]![0] as { audio: Uint8Array }).audio]).toEqual([7, 8, 9]);
      expect(turns().get(`msg_voice_${nextMsg - 1}`)?.voice).toBe(true);
      expect(sent.filter((x) => x[0] === 'message')).toEqual([]);
    });

    it('starts no turn for silence', async () => {
      sent.length = 0;
      expect(await voiceNote(fakeVoice({ heard: '  ' }))).toEqual([]);
      expect(sent).toEqual([['message', '5', "🎙 I couldn't hear anything in that voice message.", undefined]]);
    });

    it('sends the recording itself when it can\'t be heard, with a note', async () => {
      sent.length = 0;
      const voice = fakeVoice();
      voice.transcribe.mockRejectedValueOnce(new Error('bad audio'));
      const [p] = await voiceNote(voice);
      expect(p!.text).toBe('(A voice message, 2s)');
      expect(p!.attachments).toHaveLength(1);
      expect(p!.voice).toBeUndefined();
      expect(sent).toEqual([['message', '5', "⚠️ Couldn't understand the voice message (bad audio).", undefined]]);
    });

    it('without the speech model: the file goes as before, and the chat is told once', async () => {
      sent.length = 0;
      const voice = fakeVoice({ stt: false });
      const [p] = await voiceNote(voice, 6);
      expect(p!.text).toBe('(A voice message, 2s)');
      expect(core.services.files.getRecord(p!.attachments![0]!.id)!.name).toMatch(/^voice-\d+\.ogg$/);
      expect(p!.voice).toBeUndefined();
      expect(voice.transcribe).not.toHaveBeenCalled();
      await voiceNote(voice, 6);
      const notes = sent.filter((x) => x[0] === 'message');
      expect(notes).toHaveLength(1);
      expect(notes[0]![2]).toMatch(/^🎙 To have your voice messages understood, open AppuBot on your .+ → Settings → Voice and download the speech model\.$/);
    });

    it('on a computer that hears nothing (it only reads aloud): the file goes, and nobody is sent to Settings › Voice', async () => {
      sent.length = 0;
      const voice = fakeVoice({ stt: false, hears: false });
      const [p] = await voiceNote(voice, 7);
      expect(p!.text).toBe('(A voice message, 2s)');
      expect(voice.transcribe).not.toHaveBeenCalled();
      expect(sent.filter((x) => x[0] === 'message')).toHaveLength(0);
    });

    it('answers a voice message with a voice note, then the text', async () => {
      sent.length = 0;
      const voice = fakeVoice();
      services().voice = voice;
      await live().onCompleted({ chatId: '5', replyTo: 9, threadId: 'th_1', voice: true }, { status: 'complete', message: { id: 'msg_a', parts: [{ type: 'text', text: '**Two** meetings.' }] } });
      expect(sent).toEqual([['voice', '5', 'reply.ogg'], ['message', '5', '<b>Two</b> meetings.', 'HTML']]);
      expect(voice.speakForMessage).toHaveBeenCalledWith('th_1', 'msg_a', { text: '**Two** meetings.' });
    });

    it('answers in text only with voice replies off, without the voice model, or when speaking fails', async () => {
      const done = (voice: FakeVoice) => { services().voice = voice; return live().onCompleted({ chatId: '5', threadId: 'th_1', voice: true }, { status: 'complete', message: { id: 'msg_b', parts: [{ type: 'text', text: 'ok' }] } }); };
      const v = core.services.settings.get().voice;
      core.services.settings.update({ voice: { ...v, telegramVoiceReplies: false } });
      sent.length = 0;
      const off = fakeVoice();
      await done(off);
      core.services.settings.update({ voice: { ...v, telegramVoiceReplies: true } });
      await done(fakeVoice({ tts: false }));
      const failing = fakeVoice();
      failing.speakForMessage.mockRejectedValueOnce(new Error('no voice'));
      await done(failing);
      expect(off.speakForMessage).not.toHaveBeenCalled();
      expect(sent.map((x) => x[0])).toEqual(['message', 'message', 'message']);
      // a turn asked in text never speaks
      sent.length = 0;
      await live().onCompleted({ chatId: '5', threadId: 'th_1' }, { status: 'complete', message: { id: 'msg_c', parts: [{ type: 'text', text: 'ok' }] } });
      expect(sent.map((x) => x[0])).toEqual(['message']);
    });

    /** a turn Telegram started, with a voice note the bot sent itself mid-turn (`send_voice`) */
    const spokeItself = (id: string, o: { voice?: boolean } = {}) => {
      live();
      const file = core.services.files.upload(new Uint8Array([0x4f, 0x67, 0x67, 0x53]), `reply-${id}.ogg`, 'audio/ogg');
      core.services.channels.trackTurn(id, { runnerId: 'telegram', chatId: '5', threadId: 'th_1', replyTo: 9, ...o });
      const turn = turns().get(id)!;
      core.services.channels.voiceSent(id, file, 'Your plan');
      const parts = [
        { type: 'voice', file, durationMs: 900, kind: 'reply', transcript: 'the plan' },
        { type: 'text', text: 'Your plan', said: true },
        { type: 'text', text: 'Done.' },
      ];
      return { turn, file, done: () => live().onCompleted(turn, { status: 'complete', message: { id, parts } }) };
    };

    it('sends a voice note the bot sent itself at once, and nothing of it again with the reply', async () => {
      sent.length = 0;
      const voice = fakeVoice();
      services().voice = voice;
      const spy = vi.spyOn(tgApi, 'sendVoice');
      try {
        const { done } = spokeItself('msg_spoke_1');
        await done();
        expect(sent).toEqual([['voice', '5', 'reply-msg_spoke_1.ogg'], ['message', '5', 'Done.', 'HTML']]);
        expect(spy).toHaveBeenCalledTimes(1);
        expect((spy.mock.calls[0] as unknown[])[2]).toEqual({ caption: 'Your plan' });
        // a text-started turn never reads its reply aloud anyway
        expect(voice.speakForMessage).not.toHaveBeenCalled();
      } finally { spy.mockRestore(); }
    });

    it('reads no reply aloud in a voice turn where the bot already spoke', async () => {
      sent.length = 0;
      const voice = fakeVoice();
      services().voice = voice;
      const { done } = spokeItself('msg_spoke_2', { voice: true });
      await done();
      expect(voice.speakForMessage).not.toHaveBeenCalled();
      expect(sent.map((x) => x[0])).toEqual(['voice', 'message']);
    });

    it('reads at most VOICE_SPEAK_MAX_CHARS aloud, ending at a sentence', () => {
      const long = 'This is a sentence. '.repeat(300);
      const out = speakable(long);
      expect(out.length).toBeLessThanOrEqual(VOICE_SPEAK_MAX_CHARS);
      expect(out.endsWith('sentence.')).toBe(true);
      expect(speakable('short')).toBe('short');
    });
  });

  it('reads what a message carries', () => {
    const m = { message_id: 4, voice: { file_id: 'v', duration: 3, mime_type: 'audio/ogg' }, reply_to_message: { text: 'earlier' } } as never;
    expect(mediaOf(m)).toEqual([{ fileId: 'v', name: 'voice-4.ogg', mime: 'audio/ogg', size: undefined }]);
    expect(describeMessage(m)).toBe('(Replying to: "earlier")\n(A voice message, 3s)');
    expect(describeMessage(m, { voice: false })).toBe('(Replying to: "earlier")');
    expect(describeMessage({ message_id: 1, location: { latitude: 1.5, longitude: 2 } } as never)).toContain('📍 Location: 1.5, 2');
    expect(sendKind('image/png', 'a.png', 20 * 1024 * 1024)).toBe('document');
    expect(sendKind('audio/mp4', 'a.m4a', 1)).toBe('audio');
  });
});

describe('telegram commands', () => {
  const sent: { chat: string; text: string; buttons?: string[]; id: number }[] = [];
  const edits: string[] = [];
  const replies: string[] = [];
  const answers: string[] = [];
  let nextId = 100;
  const tgApi = {
    ...api,
    sendMessage: async (chat: string, text: string, o?: { reply_markup?: { inline_keyboard: { text: string }[][] } }) => {
      const id = nextId++;
      sent.push({ chat, text, id, ...(o?.reply_markup ? { buttons: o.reply_markup.inline_keyboard.flat().map((b) => b.text) } : {}) });
      return { message_id: id };
    },
    sendChatAction: async () => true,
    editMessageText: async (_c: string, _m: number, text: string) => { edits.push(text); return true; },
    editMessageReplyMarkup: async () => true,
  };
  const r = () => Object.assign(runner('telegram'), { tg: { api: tgApi }, tgId: 7 }) as unknown as { onMessage(cx: unknown): Promise<void>; onButton(cx: unknown): Promise<void> };
  const say = (text: string) => r().onMessage({ from: { id: 77 }, chat: { id: 5 }, reply: async (t: string) => { replies.push(t); }, message: { message_id: nextId++, text } });
  /** taps button `label` on the last menu sent */
  const tap = async (label: string) => {
    const menu = sent.filter((m) => m.buttons).at(-1)!;
    const n = menu.buttons!.indexOf(label);
    expect(n).toBeGreaterThanOrEqual(0);
    await r().onButton({ from: { id: 77 }, chat: { id: 5 }, callbackQuery: { data: `k:${n}`, message: { message_id: menu.id } }, answerCallbackQuery: async (o: { text: string }) => { answers.push(o.text); } });
  };
  const current = () => core.services.threads.chatFor(bot.id);

  beforeAll(async () => {
    // no agent running in it (the fake one would answer with lists of its own)
    await core.services.chat.closeThread(current().id);
    const c = core.services.channels.stored('telegram')!;
    if (!c.allowedUsers.includes('77')) core.services.channels.save('telegram', { allowedUsers: [...c.allowedUsers, '77'] });
    core.services.threads.update(current().id, {
      models: [{ id: 'opus', name: 'Opus' }, { id: 'sonnet', name: 'Sonnet' }], modelId: 'opus',
      efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], effortId: 'low',
    });
  });

  it('picks a model from buttons', async () => {
    await say('/model');
    expect(sent.at(-1)!.buttons).toEqual(['✓ Opus', 'Sonnet']);
    await tap('Sonnet');
    expect(current().modelId).toBe('sonnet');
    expect(edits.at(-1)).toBe('✅ Model: Sonnet');
  });

  it('keeps the effort on the bot, like the app', async () => {
    await say('/effort@LedgerBot');
    await tap('High');
    expect(current().effortId).toBe('high');
    expect(core.services.bots.require(bot.id).effort).toBe('high');
  });

  it('goes back to an earlier chat', async () => {
    const first = current();
    core.services.threads.rename(first.id, 'Taxes');
    core.services.chat.send({ threadId: first.id, text: 'hi' });
    const fresh = core.services.chat.startThread(bot.id);
    expect(current().id).toBe(fresh.id);
    await say('/chats');
    await tap(sent.at(-1)!.buttons!.find((b) => b.startsWith('Taxes'))!);
    expect(current().id).toBe(first.id);
  });

  it('says where things stand, and renames the chat', async () => {
    await say('/rename   Year <end>');
    expect(current().title).toBe('Year <end>');
    expect(replies.at(-1)).toBe('✏️ Renamed this chat to <b>Year &lt;end&gt;</b>.');
    await say('/status');
    expect(replies.at(-1)).toContain('<b>🤖 Ledger');
    expect(replies.at(-1)).toContain('💬 Chat: <b>Year &lt;end&gt;</b>');
    // its agent is up again since the chat was sent to: the fake agent's own names
    expect(replies.at(-1)).toContain(`🎛 Model: <b>${modelName(current())}</b>\n💭 Effort: <b>High</b>`);
    await say('/help');
    expect(replies.at(-1)).toContain('<b>🎛 Settings</b>\n/status · Its agent, model and settings now');
  });

  it('turns voice replies on and off', async () => {
    await say('/voice off');
    expect(core.services.settings.get().voice.telegramVoiceReplies).toBe(false);
    expect(replies.at(-1)).toBe('✅ Voice replies off: voice messages get their answer as text.');
    await say('/voice');
    expect(sent.at(-1)!.text).toContain('Now: <b>Off</b>');
    expect(sent.at(-1)!.buttons).toEqual(['On', '✓ Off']);
    await tap('On');
    expect(core.services.settings.get().voice.telegramVoiceReplies).toBe(true);
    expect(edits.at(-1)).toMatch(/^✅ Voice replies on: a voice message gets its answer as a voice note too/);
    await say('/help');
    expect(replies.at(-1)).toContain('/voice · Answer voice messages with a voice note: on or off');
  });

  it('lets an expired menu go, and hands other commands to the agent', async () => {
    await r().onButton({ from: { id: 77 }, chat: { id: 5 }, callbackQuery: { data: 'k:0', message: { message_id: 1 } }, answerCallbackQuery: async (o: { text: string }) => { answers.push(o.text); } });
    expect(answers.at(-1)).toContain('expired');
    const spy = vi.spyOn(core.services.chat, 'send');
    try {
      await say('/compact');
      expect(spy.mock.calls[0]![0].text).toBe('/compact');
    } finally { spy.mockRestore(); }
  });
});
