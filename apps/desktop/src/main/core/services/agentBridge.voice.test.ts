/** The bridge's voice tools: `transcribe_audio` (agent.transcribe) and `send_voice` (agent.speak), on a fake voice service. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId, type Bot, type FileAttachment, type Message } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { RpcError, silentLogger } from '../util';

let core: Core;
let root: string;
let bot: Bot;
let realVoice: unknown;

const fakeVoice = (o: { stt?: boolean; tts?: boolean } = {}) => ({
  ready: (k: 'stt' | 'tts') => (k === 'stt' ? o.stt ?? true : o.tts ?? true),
  transcribe: vi.fn(async () => {
    if (o.stt === false) throw new RpcError('voice_not_ready', 'The speech model is not downloaded yet. Download it in Settings › Voice.');
    return { text: 'call mum at six', durationMs: 2400 };
  }),
  speakForMessage: vi.fn(async (threadId: string, messageId: string, s: { text: string }) => {
    const file = core.services.files.upload(new Uint8Array([0x4f, 0x67, 0x67, 0x53]), 'reply-test.ogg', 'audio/ogg');
    core.services.threads.appendPart(threadId, messageId, { type: 'voice', file, durationMs: 1500, kind: 'reply', transcript: s.text });
    return { ogg: new Uint8Array(), durationMs: 1500, language: 'en' as const, file };
  }),
});
const useVoice = (v: ReturnType<typeof fakeVoice>) => { (core.services as unknown as { voice: unknown }).voice = v; return v; };
const ctx = () => ({ botId: bot.id, threadId: core.services.threads.chatFor(bot.id).id });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-bridge-voice-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
  });
  await core.start();
  bot = core.services.bots.list()[0]!;
  realVoice = core.services.voice;
});

afterAll(async () => {
  (core.services as unknown as { voice: unknown }).voice = realVoice;
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => { vi.restoreAllMocks(); });

describe('transcribe_audio', () => {
  it('refuses files outside the home folder and temp', async () => {
    useVoice(fakeVoice());
    const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts';
    await expect(core.services.agentBridge.transcribe(ctx(), outside)).rejects.toMatchObject({ code: 'forbidden', message: expect.stringMatching(/^Can only hear files in your home folder/) });
  });

  it('hears OGG here and anything else through the app\'s decoder', async () => {
    const v = useVoice(fakeVoice());
    const dir = mkdtempSync(join(tmpdir(), 'appubot-hear-'));
    try {
      writeFileSync(join(dir, 'note.ogg'), 'OggS....');
      writeFileSync(join(dir, 'clip.m4a'), '....ftyp');
      writeFileSync(join(dir, 'odd-name'), 'OggS....');
      expect(await core.services.agentBridge.transcribe(ctx(), join(dir, 'note.ogg'))).toEqual({ text: 'call mum at six', durationMs: 2400 });
      await core.services.agentBridge.transcribe(ctx(), join(dir, 'clip.m4a'), 'en');
      await core.services.agentBridge.transcribe(ctx(), join(dir, 'odd-name'));
      const calls = (v.transcribe.mock.calls as unknown as [Record<string, unknown>][]).map(([c]) => { const { audio: _a, ...rest } = c; return rest; });
      expect(calls).toEqual([{ format: 'ogg' }, { format: 'encoded', mimeType: 'audio/mp4', language: 'en' }, { format: 'ogg' }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('tells the bot plainly when the speech model is missing', async () => {
    useVoice(fakeVoice({ stt: false }));
    const dir = mkdtempSync(join(tmpdir(), 'appubot-hear-'));
    try {
      writeFileSync(join(dir, 'note.ogg'), 'OggS....');
      await expect(core.services.agentBridge.transcribe(ctx(), join(dir, 'note.ogg'))).rejects.toThrow(
        "The speech model isn't downloaded on this computer yet: ask the user to download it in Settings › Voice.",
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('send_voice', () => {
  /** a turn running in the bot's chat, its agent message the one `currentAgentMessage` gives */
  const running = (): Message => {
    const threadId = ctx().threadId;
    const now = Date.now();
    const m = core.services.threads.addMessage({ id: newId('msg'), threadId, role: 'agent', parts: [], status: 'streaming', via: 'channel', createdAt: now, updatedAt: now });
    vi.spyOn(core.services.chat, 'currentAgentMessage').mockReturnValue(m);
    return m;
  };

  it('reads the text into the running message, the caption after it, and tells Telegram', async () => {
    const v = useVoice(fakeVoice());
    const msg = running();
    const sent = vi.spyOn(core.services.channels, 'voiceSent');
    const r = await core.services.agentBridge.speak(ctx(), { text: 'Your flight is at nine.', caption: 'Flight time' });
    expect(r).toMatchObject({ ok: true, durationMs: 1500, language: 'en' });
    expect(v.speakForMessage).toHaveBeenCalledWith(msg.threadId, msg.id, { text: 'Your flight is at nine.' });
    const parts = core.services.threads.findMessage(msg.threadId, msg.id)!.parts;
    expect(parts.map((p) => p.type)).toEqual(['voice', 'text']);
    expect(parts[1]).toEqual({ type: 'text', text: 'Flight time', said: true });
    expect(sent).toHaveBeenCalledWith(msg.id, r.file, 'Flight time');
  });

  it('without a caption, only the voice part; without a turn, a message of its own', async () => {
    useVoice(fakeVoice());
    const sent = vi.spyOn(core.services.channels, 'voiceSent');
    vi.spyOn(core.services.chat, 'currentAgentMessage').mockReturnValue(undefined);
    const r = await core.services.agentBridge.speak(ctx(), { text: 'Done.' });
    const [id, file, caption] = sent.mock.calls[0]! as [string, FileAttachment, string | undefined];
    expect(file).toEqual(r.file);
    expect(caption).toBeUndefined();
    const m = core.services.threads.findMessage(ctx().threadId, id)!;
    expect(m).toMatchObject({ role: 'agent', via: 'system' });
    expect(m.parts.map((p) => p.type)).toEqual(['voice']);
  });

  it('says what to do when the voice model is missing, before making anything', async () => {
    const v = useVoice(fakeVoice({ tts: false }));
    const sent = vi.spyOn(core.services.channels, 'voiceSent');
    await expect(core.services.agentBridge.speak(ctx(), { text: 'hi' })).rejects.toThrow(/voice model isn't downloaded on this computer yet: ask the user/);
    expect(v.speakForMessage).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
  });
});
