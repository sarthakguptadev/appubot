/**
 * Apps on an AppuBot Cloud computer: its browser is on a desktop the user isn't looking at, so the device that asks
 * (the desktop app switched to Cloud, or the phone) signs in with its own return address and opens every Composio page
 * itself; the cloud keeps the tokens, watches the connection and reports with `apps.updated`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPS_SIGNED_IN_LINK } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { RpcError, silentLogger } from '../util';
import { accountOf, type ComposioConnect, type ComposioTokens } from './composioConnect';

interface Account { id: string; slug: string; status: string }

/** Composio for You, just enough of it: one user, a Slack connected elsewhere, link pages for the rest. */
class FakeConnect implements ComposioConnect {
  redirects: string[] = [];
  accounts: Account[] = [{ id: 'slack_elsewhere', slug: 'slack', status: 'active' }];
  private n = 0;
  async register(redirectUri: string) { this.redirects.push(redirectUri); return { clientId: `client_${this.redirects.length}` }; }
  authorizeUrl(p: { clientId: string; redirectUri: string; challenge: string; state: string }) {
    return `https://connect.composio.dev/oauth/authorize?${new URLSearchParams({ client_id: p.clientId, redirect_uri: p.redirectUri, code_challenge: p.challenge, state: p.state })}`;
  }
  async exchange(p: { code: string; verifier: string }): Promise<ComposioTokens> {
    if (p.code !== 'good-code' || !p.verifier) throw new Error('invalid_grant');
    const claims = Buffer.from(JSON.stringify({ email: 'me@example.com' })).toString('base64url');
    return { accessToken: `at_${++this.n}`, refreshToken: `rt_${this.n}`, expiresAt: Date.now() + 3600_000, account: accountOf(`h.${claims}.s`) };
  }
  async refresh(): Promise<ComposioTokens> { throw new Error('not in this test'); }
  async callTool(_token: string, name: string, args: Record<string, unknown>) {
    const ok = (data: unknown) => ({ text: JSON.stringify({ successful: true, data, error: null }), isError: false });
    if (name !== 'COMPOSIO_MANAGE_CONNECTIONS') return ok({});
    const results: Record<string, unknown> = {};
    for (const t of args.toolkits as { name: string; action: string; account_id?: string }[]) {
      if (t.action === 'add') {
        const id = `${t.name}_${++this.n}`;
        this.accounts.push({ id, slug: t.name, status: 'initiated' });
        results[t.name] = { redirect_url: `https://connect.composio.dev/link/lk_${id}`, accounts: this.accounts.filter((a) => a.slug === t.name).map((a) => ({ id: a.id, status: a.status })) };
      } else {
        if (t.action === 'remove') this.accounts = this.accounts.filter((a) => a.id !== t.account_id);
        results[t.name] = { accounts: this.accounts.filter((a) => a.slug === t.name).map((a) => ({ id: a.id, status: a.status })) };
      }
    }
    return ok({ results });
  }
  activate(slug: string): void { for (const a of this.accounts) if (a.slug === slug) a.status = 'active'; }
}

let core: Core;
let root: string;
const fake = new FakeConnect();
const opened: string[] = [];
let shown = 0;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-apps-cloud-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    // Chrome on the cloud's own desktop: nothing of the user's may open there
    openExternal: (url) => { opened.push(url); },
    showApp: () => { shown++; },
    composioConnect: () => fake,
    openTerminal: () => undefined, nativeNotify: async () => ({ shown: true }),
    version: '0.0.0-test', hostName: 'AppuBot Cloud', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    cloud: { publicUrl: 'https://ab12cd34ef.agent37.app', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 3 },
  });
  await core.start();
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

const refusal = async (p: Promise<unknown>): Promise<RpcError> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(RpcError);
  return e as RpcError;
};

describe('apps on an AppuBot Cloud computer', () => {
  it('offers no apps on their own servers: their sign-in has no browser of the person’s to come back to', async () => {
    const composio = core.services.composio;
    expect(composio.status().direct).toBeUndefined();
    expect(composio.catalog({ search: 'paypal', limit: 60 }).toolkits.map((t) => t.slug)).not.toContain('paypal_direct');
    expect((await refusal(composio.connections())).code).toBe('apps_not_configured');
    expect((await refusal(composio.connect('paypal_direct'))).message).not.toMatch(/sign-in page/);
  });

  it('signs in only with the asking device’s own return address, opening nothing here', async () => {
    const composio = core.services.composio;
    const e = await refusal(composio.signIn());
    expect(e.code).toBe('unsupported');
    expect(e.message).toMatch(/phone or computer/);
    expect(composio.status().signingIn).toBe(false);

    const s = await composio.signIn(APPS_SIGNED_IN_LINK);
    expect(opened).toEqual([]);
    const url = new URL(s.url!);
    expect(url.searchParams.get('redirect_uri')).toBe('appubot://apps/signed-in');
    // never the cloud's loopback page, which the user's browser can't reach
    expect(fake.redirects).toEqual(['appubot://apps/signed-in']);
    expect(await composio.finishSignIn({ code: 'good-code', state: 'forged' })).toBe(false);
    expect(await composio.finishSignIn({ code: 'good-code', state: url.searchParams.get('state')! })).toBe(true);
    expect(composio.status()).toMatchObject({ configured: true, account: 'me@example.com' });
    // the same account's apps connected elsewhere (on the user's Mac, Claude.ai…) reach the cloud's bots
    await vi.waitFor(() => expect(composio.connectedSlugs()).toEqual(['slack']), { timeout: 10_000 });
  });

  it('leaves an app’s link page to the device that asked, even when it didn’t say so', async () => {
    const composio = core.services.composio;
    // `open` absent (an older desktop) or 'computer': still the caller's
    const r = await composio.connect('gmail', false);
    expect(r.redirectUrl).toMatch(/^https:\/\/connect\.composio\.dev\/link\//);
    expect(opened).toEqual([]);
    expect(composio.status().pending).toEqual(['gmail']);
    fake.activate('gmail');
    await vi.waitFor(() => expect(composio.status().pending).toEqual([]), { timeout: 10_000 });
    expect(composio.connectedSlugs()).toEqual(['gmail', 'slack']);
    // nothing to bring forward on the cloud's desktop
    expect(shown).toBe(0);
    expect(opened).toEqual([]);
  });

  it('tells the bots to connect apps from AppuBot on the user’s phone or computer', async () => {
    const bot = core.services.bots.list()[0]!;
    const e = await refusal(core.services.composio.schemas(bot.id, ['GITHUB_CREATE_AN_ISSUE']));
    expect(e.message).toMatch(/AppuBot → Apps \(on their phone or computer\)/);
    const data = core.services.composio.filterSearch({ toolkit_connection_statuses: [{ toolkit: 'github', has_active_connection: false }] }, new Set(['gmail']));
    expect(data.toolkit_connection_statuses?.[0]?.status_message).toMatch(/on their phone or computer/);
  });
});
