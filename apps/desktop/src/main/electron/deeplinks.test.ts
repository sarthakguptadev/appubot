import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ready: false,
  sent: [] as { channel: string; payload: unknown }[],
  cloudLinks: [] as string[],
  shown: 0,
}));

vi.mock('electron', () => ({ app: { isReady: () => h.ready, on: () => undefined, whenReady: () => new Promise(() => undefined), setAsDefaultProtocolClient: () => true } }));
vi.mock('./window', () => ({
  mainWindow: () => (h.ready ? { webContents: { isLoading: () => false, send: (channel: string, payload: unknown) => { h.sent.push({ channel, payload }); } } } : null),
  showMainWindow: () => { h.shown++; },
}));
vi.mock('./cloudLinks', () => ({ handleCloudLink: (url: string) => { h.cloudLinks.push(url); return true; } }));

describe('parseCloudLink', async () => {
  const { parseCloudLink } = await import('./deeplinks');
  it('reads the sign-in’s code and state', () => {
    expect(parseCloudLink('appubot://cloud/signed-in?code=abc_DEF-123&state=s1234567')).toEqual({ kind: 'signed-in', code: 'abc_DEF-123', state: 's1234567' });
    expect(parseCloudLink('appubot://cloud/signed-in?error=access_denied&state=s1')).toEqual({ kind: 'signed-in', error: 'access_denied', state: 's1' });
  });
  it('reads the checkout’s return', () => {
    expect(parseCloudLink('appubot://cloud/checkout-done')).toEqual({ kind: 'checkout-done' });
    expect(parseCloudLink('appubot://cloud/invite?token=inv_abcdefghijklmnop')).toEqual({ kind: 'invite' });
    expect(parseCloudLink('appubot://cloud/checkout-done?status=succeeded')).toEqual({ kind: 'checkout-done', status: 'succeeded' });
  });
  it('ignores anything else', () => {
    for (const bad of ['appubot://pair?h=1&p=2&c=3', 'https://cloud/signed-in?code=a&state=b', 'appubot://cloud/signed-in', 'appubot://cloud/signed-in?code=a%20b&state=c', 'appubot://cloud/other', 'appubot://apps/signed-in?code=a&state=b', 'not a url']) {
      expect(parseCloudLink(bad), bad).toBeNull();
    }
  });
});

describe('parseAppsLink', async () => {
  const { parseAppsLink } = await import('./deeplinks');
  const state = '0123456789abcdef0123456789abcdef';
  it('reads a Composio sign-in’s code and state, or its refusal', () => {
    expect(parseAppsLink(`appubot://apps/signed-in?code=ac_Zx9.k~-1&state=${state}`)).toEqual({ code: 'ac_Zx9.k~-1', state });
    expect(parseAppsLink(`appubot://apps/signed-in/?state=${state}&code=abc`)).toEqual({ code: 'abc', state });
    expect(parseAppsLink(`appubot://apps/signed-in?error=access_denied&state=${state}`)).toEqual({ error: 'access_denied', state });
    // a refusal with markup in it keeps only plain words
    expect(parseAppsLink('appubot://apps/signed-in?error=%3Cscript%3Ebad')).toEqual({ error: 'scriptbad' });
  });
  it('drops anything that isn’t one', () => {
    for (const bad of [
      'appubot://apps/signed-in',
      'appubot://apps/signed-in?code=abc',
      `appubot://apps/signed-in?code=a%20b&state=${state}`,
      `appubot://apps/signed-in?code=a%3Cb&state=${state}`,
      `appubot://apps/signed-in?code=${'a'.repeat(2001)}&state=${state}`,
      'appubot://apps/signed-in?code=abc&state=short',
      `https://apps/signed-in?code=abc&state=${state}`,
      `appubot://apps/other?code=abc&state=${state}`,
      `appubot://cloud/signed-in?code=abc&state=${state}`,
      'not a url',
    ]) expect(parseAppsLink(bad), bad).toBeNull();
  });
});

describe('handling a link', async () => {
  const { handle } = await import('./deeplinks');
  const state = '0123456789abcdef0123456789abcdef';
  beforeEach(() => { h.ready = true; h.sent.length = 0; h.cloudLinks.length = 0; h.shown = 0; });

  it('hands a Composio sign-in to the window, which finishes it on the cloud computer', () => {
    handle(`appubot://apps/signed-in?code=abc&state=${state}`, () => undefined);
    expect(h.shown).toBe(1);
    expect(h.sent).toEqual([{ channel: 'appubot:appsSignedIn', payload: { code: 'abc', state } }]);
    // never the core's cloud links
    expect(h.cloudLinks).toEqual([]);
  });

  it('sends a malformed one nowhere', () => {
    handle('appubot://apps/signed-in?code=a%3Cb', () => undefined);
    expect(h.sent).toEqual([]);
    expect(h.cloudLinks).toEqual([]);
  });

  it('still takes the cloud’s own links to the core and Settings › Cloud', () => {
    handle('appubot://cloud/checkout-done', () => undefined);
    expect(h.cloudLinks).toEqual(['appubot://cloud/checkout-done']);
    expect(h.sent).toEqual([{ channel: 'appubot:navigate', payload: { to: 'settings', id: 'cloud' } }]);
  });
});
