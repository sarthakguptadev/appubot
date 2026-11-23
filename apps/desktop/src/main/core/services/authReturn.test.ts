/** A sign-in that comes back to this computer: where a link returns to, what counts as its return, and the replay. */
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkReturn, deliverReturn, loopbackReturn } from './authReturn';

const CLAUDE_AUTO = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A51898%2Fcallback&scope=user%3Ainference&code_challenge=x&code_challenge_method=S256&state=B3Rd';
const CLAUDE_MANUAL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=B3Rd';
const GEMINI = 'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A40123%2Foauth2callback&access_type=offline&state=g1&response_type=code';

describe('loopbackReturn', () => {
  it('reads where a sign-in comes back to on this computer', () => {
    expect(loopbackReturn(CLAUDE_AUTO)).toEqual({ port: 51898, path: '/callback', state: 'B3Rd' });
    expect(loopbackReturn(GEMINI)).toEqual({ port: 40123, path: '/oauth2callback', state: 'g1' });
  });
  it('is null for a sign-in that returns anywhere else, or isn’t one', () => {
    expect(loopbackReturn(CLAUDE_MANUAL)).toBeNull();
    expect(loopbackReturn('https://auth.openai.com/codex/device')).toBeNull();
    expect(loopbackReturn('http://example.test/?redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb')).toBeNull();
    expect(loopbackReturn('https://x.test/?redirect_uri=http%3A%2F%2Fevil.test%3A80%2Fcb')).toBeNull();
    expect(loopbackReturn('not a link')).toBeNull();
  });
});

describe('checkReturn', () => {
  const expectBack = { port: 51898, path: '/callback', state: 'B3Rd' };
  it('takes the address the browser ended on, with or without http://, at any loopback name', () => {
    expect(checkReturn('http://localhost:51898/callback?code=c1&state=B3Rd', expectBack).searchParams.get('code')).toBe('c1');
    expect(checkReturn('  localhost:51898/callback?code=c1&state=B3Rd ', expectBack).port).toBe('51898');
    expect(checkReturn('http://127.0.0.1:51898/callback?error=access_denied&state=B3Rd', expectBack).searchParams.get('error')).toBe('access_denied');
  });
  it('refuses another sign-in’s return, another port or path, a missing or doubled code, or another host', () => {
    const bad = [
      'http://localhost:51898/callback?code=c1&state=other',
      'http://localhost:51898/callback?code=c1',
      'http://localhost:51899/callback?code=c1&state=B3Rd',
      'http://localhost:51898/other?code=c1&state=B3Rd',
      'http://localhost:51898/callback?state=B3Rd',
      'http://localhost:51898/callback?code=a&code=b&state=B3Rd',
      'http://localhost:51898/callback?code=a&error=x&state=B3Rd',
      'http://evil.test:51898/callback?code=c1&state=B3Rd',
      'https://localhost:51898/callback?code=c1&state=B3Rd',
      'http://user:pw@localhost:51898/callback?code=c1&state=B3Rd',
      '',
    ];
    for (const b of bad) expect(() => checkReturn(b, expectBack), b).toThrow();
  });
});

describe('deliverReturn', () => {
  it('hands the return to the listener here as the browser would have', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => { seen.push(req.url ?? ''); res.writeHead(302, { location: 'https://done.test/' }).end(); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    await deliverReturn(checkReturn(`localhost:${port}/callback?code=c1&state=s`, { port, path: '/callback', state: 's' }));
    expect(seen).toEqual(['/callback?code=c1&state=s']);
    await new Promise((r) => server.close(r));
  });
  it('says so when nothing listens any more, or the agent refuses it', async () => {
    const server = createServer((_req, res) => res.writeHead(400).end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    await expect(deliverReturn(new URL(`http://localhost:${port}/callback?code=c`))).rejects.toThrow(/didn’t accept/);
    await new Promise((r) => server.close(r));
    await expect(deliverReturn(new URL(`http://localhost:${port}/callback?code=c`), 2000)).rejects.toThrow(/already ended/);
  });
});
