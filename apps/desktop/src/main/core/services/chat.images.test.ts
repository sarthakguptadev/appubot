/**
 * Attached pictures reach the agent as image blocks when they fit its vision (5 MB of base64, ≤8000px); bigger ones
 * are shrunk through the image codec first, and stay a file link when even that doesn't fit.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot } from '@appubot/protocol';
import type { PromptBlock } from '@appubot/agent-runtime';
import { createCore, type Core } from '../app';
import type { ImageCodec } from '../context';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

let core: Core;
let runtime: FakeRuntime;
let root: string;
let bot: Bot;
const encodes: { maxDim: number; quality: number }[] = [];
/** what the fake codec answers: its JPEG's base64 length */
let encodedLength = 1000;
const codec: ImageCodec = {
  encode: (_b64, o) => { encodes.push(o); return { data: 'j'.repeat(encodedLength), mimeType: 'image/jpeg', width: o.maxDim, height: o.maxDim }; },
};

/** a PNG of `width`×`height` (header only) padded to `bytes` */
function png(width: number, height: number, bytes: number): Uint8Array {
  const b = new Uint8Array(bytes);
  b.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

async function send(data: Uint8Array): Promise<Extract<PromptBlock, { type: 'image' }>[]> {
  const thread = core.services.threads.chatFor(bot.id);
  const att = core.services.files.upload(data, 'shot.png', 'image/png', thread.id);
  const before = runtime.prompts.length;
  encodes.length = 0;
  core.services.chat.send({ threadId: thread.id, text: 'look', attachments: [{ id: att.id }], images: [] });
  await vi.waitFor(() => expect(runtime.prompts.length).toBe(before + 1));
  await vi.waitFor(() => expect(core.services.threads.require(thread.id).status).toBe('idle'));
  const blocks = runtime.prompts.at(-1)!.blocks;
  expect(blocks.some((b) => b.type === 'resource_link')).toBe(true);
  return blocks.filter((b): b is Extract<PromptBlock, { type: 'image' }> => b.type === 'image');
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-images-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    imageCodec: codec,
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, quiet: true,
  });
  await core.start();
  runtime.reply = () => 'ok';
  bot = core.services.bots.create({ name: 'Viewer', providerId: 'claude-code' } as Parameters<typeof core.services.bots.create>[0]);
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('attached images', () => {
  it('sends one that fits as is', async () => {
    const imgs = await send(png(800, 600, 2000));
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.mimeType).toBe('image/png');
    expect(encodes).toEqual([]);
  });

  it('shrinks one over 5 MB of base64 to a JPEG ≤2048px', async () => {
    encodedLength = 1000;
    const imgs = await send(png(6000, 4000, 4_000_000));
    expect(imgs).toEqual([{ type: 'image', mimeType: 'image/jpeg', data: 'j'.repeat(1000) }]);
    expect(encodes).toEqual([{ maxDim: 2048, quality: 0.92 }]);
  });

  it('shrinks a small file with too many pixels', async () => {
    const imgs = await send(png(1440, 20_000, 3000));
    expect(imgs[0]!.mimeType).toBe('image/jpeg');
    expect(encodes[0]!.maxDim).toBe(2048);
  });

  it('walks the ladder, then leaves only the link when nothing fits', async () => {
    encodedLength = 6_000_000;
    expect(await send(png(6000, 4000, 4_000_000))).toEqual([]);
    expect(encodes.map((e) => e.maxDim)).toEqual([2048, 2048, 2048, 2048, 1536, 1536, 1536, 1536, 1126, 1126, 1126, 1126]);
  });
});
