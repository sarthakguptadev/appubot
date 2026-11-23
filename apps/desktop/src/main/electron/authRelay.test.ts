/** Catching an agent's sign-in return on this computer for the computer it runs on (electron/authRelay.ts). */
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { cancelAuthRelay, catchAuthReturn } from './authRelay';

/** a port nothing listens on right now */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}
const linkFor = (port: number, path = '/callback', state = 'st1') => `https://auth.example.test/authorize?response_type=code&state=${state}&redirect_uri=${encodeURIComponent(`http://localhost:${port}${path}`)}`;

describe('catchAuthReturn', () => {
  it('opens the link, ignores what isn’t this sign-in, and hands back the address it came back to', async () => {
    const port = await freePort();
    const statuses: number[] = [];
    const url = await catchAuthReturn({ url: linkFor(port), port, path: '/callback' }, async () => {
      // the browser asks for a favicon, a stale tab comes back, then the real return
      statuses.push((await fetch(`http://127.0.0.1:${port}/favicon.ico`)).status);
      statuses.push((await fetch(`http://127.0.0.1:${port}/callback?code=old&state=other`)).status);
      const ok = await fetch(`http://127.0.0.1:${port}/callback?code=c9&state=st1`);
      statuses.push(ok.status);
      expect(await ok.text()).toMatch(/Back to AppuBot/);
    });
    expect(statuses).toEqual([404, 404, 200]);
    expect(url).toBe(`http://localhost:${port}/callback?code=c9&state=st1`);
  });

  it('refuses a request that doesn’t hold together, and says when the port is busy', async () => {
    const port = await freePort();
    await expect(catchAuthReturn({ url: linkFor(port), port: port + 1, path: '/callback' }, async () => undefined)).rejects.toThrow(/doesn’t come back/);
    await expect(catchAuthReturn({ url: 'https://auth.example.test/device', port, path: '/callback' }, async () => undefined)).rejects.toThrow(/doesn’t come back/);
    const busy = createServer();
    await new Promise<void>((r) => busy.listen(port, '127.0.0.1', r));
    await expect(catchAuthReturn({ url: linkFor(port), port, path: '/callback' }, async () => undefined)).rejects.toThrow(/busy/);
    await new Promise((r) => busy.close(r));
  });

  it('stops on cancel, and after its time', async () => {
    const port = await freePort();
    const waiting = catchAuthReturn({ url: linkFor(port), port, path: '/callback' }, async () => { setTimeout(() => cancelAuthRelay(port), 20); });
    await expect(waiting).rejects.toThrow(/Cancelled/);
    const port2 = await freePort();
    await expect(catchAuthReturn({ url: linkFor(port2), port: port2, path: '/callback' }, async () => undefined, 50)).rejects.toThrow(/too long/);
  });
});
