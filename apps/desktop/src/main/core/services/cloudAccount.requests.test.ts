/**
 * How many backend requests the Mac's cloud account makes (every one a billed Worker request): the core's own timer
 * plus what the window asks for, played on a fake clock against the fake backend with the window's triggers as
 * `features/cloud` makes them (a Settings account page opening, the window's focus, the cloud computer's socket
 * coming up and dropping). `APPUBOT_CLOUD_REQUESTS=1` prints the table.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreCtx } from '../context';
import { silentLogger } from '../util';
import { CloudAccountService } from './cloudAccount';
import type { FakeCloudState } from './cloudFake';

const MIN = 60_000;
let root: string;
let hidden = false;
let acc: CloudAccountService;
let backend: { requests: { path: string }[] };

function make(state: FakeCloudState): void {
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'cloud-account.json'), JSON.stringify({ token: 'cs_fake_test', sealed: false, email: 'you@example.com', signedInAt: 0 }));
  writeFileSync(join(dataDir, 'cloud-fake.json'), JSON.stringify({ state }));
  const ctx = {
    deps: { cloudFake: { state }, hostName: 'Mac', version: '0', openExternal: () => undefined, windowHidden: () => hidden, log: silentLogger },
    paths: { dataDir }, log: silentLogger, bus: { emit: () => undefined },
    s: { notifications: { notify: () => undefined } }, gateway: { port: 0 },
  } as unknown as CoreCtx;
  acc = new CloudAccountService(ctx);
  backend = (acc as unknown as { fake: { requests: { path: string }[] } }).fake;
}

/** the window's triggers (renderer `features/cloud`) */
const win = {
  /** a Settings account page opens (`useCloudRefresh`'s first effect) */
  openAccountPage: () => acc.status(),
  /** the window comes to the front (`watchCloud`) */
  focus: () => acc.status(),
  /** the cloud computer's socket answers (`cloudClient` onState) */
  connected: () => acc.status(true),
  /** … and drops after being up */
  dropped: () => acc.status(),
};

const requests = () => backend.requests.length;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const rows: [string, number][] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  root = mkdtempSync(join(tmpdir(), 'appubot-cloud-requests-'));
  hidden = false;
});
afterEach(() => {
  acc.shutdown();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

/** launch: the timer's first read and the window's first ask, settled; the count starts after it */
async function launched(state: FakeCloudState): Promise<number> {
  make(state);
  acc.startPolling();
  await win.openAccountPage(); // watchCloud's first status
  await tick(1000);
  return requests();
}

describe('backend requests made by the Mac’s cloud account', () => {
  it('idle 5 min with the window in front: one read every two minutes', async () => {
    const start = await launched('running');
    await tick(5 * MIN);
    const n = requests() - start;
    rows.push(['idle 5 min, window in front', n]);
    expect(n).toBeLessThanOrEqual(2);
  });

  it('a free user (no plan, team or invite) with the window in front: nothing on the timer, only when they look', async () => {
    const start = await launched('no-plan');
    await tick(30 * MIN);
    const n = requests() - start;
    rows.push(['free user, window in front 30 min', n]);
    expect(n).toBe(0);
    await win.openAccountPage();
    await win.focus();
    expect(requests() - start).toBeLessThanOrEqual(1);
  });

  it('idle 5 min with Settings › Billing open: no more than without it', async () => {
    const start = await launched('running');
    await win.openAccountPage();
    await tick(5 * MIN);
    const n = requests() - start;
    rows.push(['idle 5 min, Settings › Billing open', n]);
    expect(n).toBeLessThanOrEqual(2);
  });

  it('idle 5 min hidden: nothing without a computer, seldom with one (its notices)', async () => {
    let start = await launched('no-plan');
    hidden = true;
    await tick(10 * MIN);
    const none = requests() - start;
    rows.push(['hidden 10 min, no computer', none]);
    expect(none).toBe(0);
    acc.shutdown();
    hidden = false;
    start = await launched('running');
    hidden = true;
    await tick(2 * MIN); // the timer planned while it showed runs once more
    const mid = requests();
    await tick(10 * MIN);
    const n = requests() - mid;
    rows.push(['hidden 10 min, with a computer', n]);
    expect(n).toBeLessThanOrEqual(2);
  });

  it('opening Settings › Billing 5 times in a minute reads once at most', async () => {
    const start = await launched('running');
    await tick(30_000);
    for (let i = 0; i < 5; i++) { await win.openAccountPage(); await tick(10_000); }
    const n = requests() - start;
    rows.push(['open Billing 5× within a minute', n]);
    expect(n).toBeLessThanOrEqual(1);
  });

  it('switching to the cloud computer and back, with a socket that retries', async () => {
    const start = await launched('running');
    await tick(20_000);
    await win.connected();
    await tick(30_000);
    await win.dropped();
    // the socket retries three times before it answers again
    for (let i = 0; i < 3; i++) await tick(2_000);
    await win.connected();
    await tick(5_000);
    await win.focus();
    const n = requests() - start;
    rows.push(['switch to cloud, drop, 3 retries, back, focus', n]);
    expect(n).toBeLessThanOrEqual(2);
  });

  it('a person on a team: one request a read however many teams', async () => {
    const start = await launched('personal-team');
    await tick(5 * MIN);
    const n = requests() - start;
    rows.push(['idle 5 min in front, own plan + 1 team', n]);
    expect(backend.requests.filter((r) => r.path.startsWith('/teams/')).length).toBe(0);
    expect(n).toBeLessThanOrEqual(2);
  });

  it('a failing backend is asked less and less often', async () => {
    const start = await launched('running');
    const fake = acc as unknown as { api: { overview: () => Promise<never> } };
    fake.api.overview = () => { backend.requests.push({ path: '/overview' }); return Promise.reject(new Error('down')); };
    await tick(10_000);
    for (let i = 0; i < 20; i++) { await win.focus(); await tick(30_000); }
    const n = requests() - start;
    rows.push(['backend down, focus every 30 s for 10 min', n]);
    expect(n).toBeLessThanOrEqual(6);
    if (process.env.APPUBOT_CLOUD_REQUESTS) console.log(rows.map(([k, v]) => `${k.padEnd(48)} ${v}`).join('\n'));
  });
});
