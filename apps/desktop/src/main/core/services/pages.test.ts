/**
 * Visual replies: a bot's `show_page` keeps its HTML (local images built in) as a `page` part, and the gateway serves it
 * to the chat's frame only with that page's own viewing key, themed and walled off from the network.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Bot, Thread } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { pageDocument } from '../pageDocument';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

let core: Core;
let root: string;
let bot: Bot;
let thread: Thread;
let base: string;

beforeAll(async () => {
  // under the home folder: pages build in images from there or the temp folder only
  root = mkdtempSync(join(homedir(), '.appubot-pages-test-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, quiet: true,
  });
  await core.start();
  bot = core.services.bots.create({ name: 'Painter', providerId: 'claude-code' } as Parameters<typeof core.services.bots.create>[0]);
  thread = core.services.threads.chatFor(bot.id);
  base = `http://127.0.0.1:${core.gateway.port}`;
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('pageDocument', () => {
  it('puts the theme and the bootstrap first in the head, or wraps a fragment', () => {
    const full = pageDocument('<html><head><title>x</title></head><body>hi</body></html>', { id: 'p1', theme: 'light' });
    expect(full.indexOf('--fg:#1c1c1c')).toBeLessThan(full.indexOf('<title>'));
    expect(full).toContain('"p1"');
    const bare = pageDocument('<div>chart</div>', { id: 'p2', theme: 'dark' });
    expect(bare.startsWith('<!doctype html><html><head>')).toBe(true);
    expect(bare).toContain('<body><div>chart</div></body>');
  });

  it('gives the page the app’s look before its own styles, and lays its own outer card flat', () => {
    const doc = pageDocument('<html><head><style>h1{color:red}</style></head><body><div class="card">x</div></body></html>', { id: 'p3', theme: 'dark' });
    // the defaults come first, so what the page styles itself wins
    expect(doc.indexOf('h1{font-size:18px;}')).toBeGreaterThan(0);
    expect(doc.indexOf('h1{font-size:18px;}')).toBeLessThan(doc.indexOf('h1{color:red}'));
    expect(doc).toContain('--surface-2:');
    expect(doc).toContain('--radius:12px');
    // the step that takes a card the page draws round itself away (the chat's own card is the only one)
    expect(doc).toContain('data-appubot-flat');
    // no face of the app's own unless one is given: the system's
    expect(doc).not.toContain('@font-face');
    expect(doc).toContain('--font:-apple-system');
  });

  it('makes a preview that holds still only where asked', () => {
    const live = pageDocument('<p>hi</p>', { id: 'p6', theme: 'dark' });
    const still = pageDocument('<p>hi</p>', { id: 'p6', theme: 'dark', still: true });
    expect(live).toContain('if (false) {');
    expect(still).toContain('if (true) {');
    expect(still).toContain('animation-play-state:paused');
  });

  it('carries the app’s face inside the document when given one, and nothing that isn’t a font', () => {
    const doc = pageDocument('<p>hi</p>', { id: 'p4', theme: 'light', font: { family: 'Geist Variable', woff2: 'd09GMgABAAAA' } });
    expect(doc).toContain('@font-face{font-family:"Geist Variable"');
    expect(doc).toContain('src:url(data:font/woff2;base64,d09GMgABAAAA)');
    expect(doc).toContain('--font:"Geist Variable",-apple-system');
    for (const font of [{ family: 'Geist Variable', woff2: 'x");}body{display:none' }, { family: 'a";}*{color:red', woff2: 'd09G' }]) {
      const bad = pageDocument('<p>hi</p>', { id: 'p5', theme: 'light', font });
      expect(bad).not.toContain('@font-face');
      expect(bad).not.toContain('display:none');
      expect(bad).not.toContain('color:red');
    }
  });
});

describe('show_page', () => {
  it('keeps the page as a part, with local images built in', async () => {
    const img = join(root, 'dot.png');
    writeFileSync(img, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    const res = await core.services.agentBridge.showPage({ threadId: thread.id, botId: bot.id }, 'Spending by month', `<img src="${img}"><img src="/etc/hosts">`);
    expect(res.ok).toBe(true);
    const msgs = core.services.threads.messages(thread.id, { limit: 10 });
    const part = msgs.flatMap((m) => m.parts).find((p) => p.type === 'page');
    expect(part?.type === 'page' && part.title).toBe('Spending by month');
    const file = part?.type === 'page' ? part.file : undefined;
    expect(file?.name).toBe('spending-by-month.html');

    const { path } = core.services.files.pageView(file!.id);
    const page = await fetch(base + path + '&theme=light');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await page.text();
    // the home folder's image is built in; one outside home and temp stays a path (and can't load)
    expect(html).toContain('src="data:image/png;base64,');
    expect(html).toContain('src="/etc/hosts"');
    expect(html).toContain('--fg:#1c1c1c');

    // another key, or none, opens nothing
    expect((await fetch(`${base}/pages/${file!.id}?v=nope`)).status).toBe(404);
    expect((await fetch(`${base}/pages/${file!.id}`)).status).toBe(404);
  });
});
