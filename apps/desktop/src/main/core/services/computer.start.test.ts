// Computer use starting beside the window at launch (CoreDeps.computerStartAfter): core.start() doesn't wait for it,
// a phone's hello and the bots' steps do (this computer's own window doesn't: it hears the status when it comes).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { GatewayClient } from '@appubot/client';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import type { ComputerBackend } from './computer';

let core: Core;
let root: string;
let letStart: () => void = () => undefined;
const started: string[] = [];

const backend: ComputerBackend = {
  name: 'native',
  init: async () => { started.push('init'); },
  permissions: async () => ({ accessibility: true, screenRecording: true }),
  requestPermissions: async () => undefined,
  screenSize: async () => ({ width: 1440, height: 900, scale: 2 }),
  screenshot: async () => ({ data: '', mimeType: 'image/png', width: 1440, height: 900 }),
  act: async () => ({ text: 'ok' }),
  shutdown: async () => undefined,
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-computer-start-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, host: '127.0.0.1', quiet: true,
    computerBackends: () => [backend], helperTransport: () => null,
    computerStartAfter: new Promise<void>((r) => { letStart = r; }),
  });
  await core.start();
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('computer use at launch', () => {
  it("doesn't hold up core.start; a phone's hello and the user's step wait for it, the window's hello doesn't", async () => {
    expect(started).toEqual([]);
    expect(core.services.computer.status().available).toBe(false);
    expect(core.services.computer.whenReady()).not.toBeNull();

    const client = (token: string, id: string) => new GatewayClient({ baseUrl: `http://127.0.0.1:${core.gateway.port}`, token, device: { id, name: 'test', platform: 'cli' }, WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket, callTimeoutMs: 10_000 });
    const { code } = core.ctx.auth.startPairing(120);
    const [status, out] = await core.services.devices.pair({ code, device: { id: 'phone-1', name: 'Phone', platform: 'ios' } }, '127.0.0.1', undefined, 'local');
    expect(status).toBe(200);
    // this computer's own window: its snapshot at once (computer use not up yet), then the status once it is
    const win = client(core.ownerToken, 'test-desktop');
    const statuses: { available: boolean }[] = [];
    win.onAny((event, payload) => { if (event === 'computer.status') statuses.push(payload as { available: boolean }); });
    win.connect();
    const phone = client((out as { token: string }).token, 'phone-1');
    phone.connect();
    const step = core.services.computer.userAct({ type: 'key', key: 'return' });
    await waitUntil(() => !!win.snapshot);
    expect(win.snapshot!.computer).toMatchObject({ available: false });
    await new Promise((r) => setTimeout(r, 150));
    // still starting: no hello for the phone yet, the step waits rather than failing
    expect(phone.snapshot).toBeNull();

    letStart();
    await expect(step).resolves.toEqual({ text: 'ok' });
    await waitUntil(() => !!phone.snapshot);
    expect(started).toEqual(['init']);
    expect(phone.snapshot!.computer).toMatchObject({ available: true, permissions: { accessibility: true, screenRecording: true } });
    await waitUntil(() => statuses.some((x) => x.available));
    expect(core.services.computer.whenReady()).toBeNull();
    win.close();
    phone.close();
  });
});

async function waitUntil(fn: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
