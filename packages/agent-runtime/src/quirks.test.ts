import { describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTH_URL_MARK, captureBrowser, capturedUrl, clearScratch, quirksFor, type QuirkCtx } from './quirks';
import type { ProviderSpec } from './types';

const spec = (over: Partial<ProviderSpec> = {}): ProviderSpec => ({ id: 'antigravity-acp', name: 'Google Antigravity', command: '/x/agy_acp_server.par', args: [], env: {}, ...over });

describe('quirks', () => {
  it('belong to Antigravity by its registry id, profiles of it included', () => {
    expect(quirksFor(spec())).toBeDefined();
    expect(quirksFor(spec({ id: 'antigravity-acp@work' }))).toBeDefined();
    expect(quirksFor(spec({ id: 'mine', registry: { id: 'antigravity-acp', version: '1' } }))).toBeDefined();
    expect(quirksFor(spec({ id: 'gemini' }))).toBeUndefined();
  });

  it('catch a sign-in page through BROWSER without a colon on macOS/Linux, and through a script file on Windows', () => {
    const posix = captureBrowser('/data', 'darwin');
    expect(posix).not.toContain(':');
    expect(posix).toMatch(/%s$/);
    const dir = mkdtempSync(join(tmpdir(), 'appubot-quirks-'));
    try {
      const win = captureBrowser(dir, 'win32');
      expect(win).toMatch(/^powershell\.exe .* -File '.*agent-browser\.ps1' %s$/);
      expect(readFileSync(join(dir, 'agent-browser.ps1'), 'utf8')).toContain(AUTH_URL_MARK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(capturedUrl(`${AUTH_URL_MARK}https://accounts.google.com/o/oauth2/v2/auth?a=1&b=2`)).toBe('https://accounts.google.com/o/oauth2/v2/auth?a=1&b=2');
    expect(capturedUrl(`${AUTH_URL_MARK}file:///etc/passwd`)).toBeUndefined();
    expect(capturedUrl('plain log line')).toBeUndefined();
  });

  it("give Antigravity its own folders, link the user's skills in and write the login it uses", () => {
    const root = mkdtempSync(join(tmpdir(), 'appubot-quirks-'));
    try {
      const home = join(root, 'home');
      mkdirSync(join(home, '.gemini', 'config', 'skills'), { recursive: true });
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'localharness_external'), '');
      const ctx: QuirkCtx = { spec: spec({ command: join(bin, 'agy_acp_server.par') }), dataDir: join(root, 'data'), platform: 'darwin', home };
      const q = quirksFor(ctx.spec)!;
      const env = q.env(ctx);
      const agyHome = join(root, 'data', 'agent-homes', 'antigravity-acp');
      expect(env).toMatchObject({ GEMINI_HOME: agyHome, AGY_ACP_FORCE_FILE_STORAGE: '1', PYTHONUNBUFFERED: '1', ANTIGRAVITY_HARNESS_PATH: join(bin, 'localharness_external'), TMPDIR: join(root, 'data', 'agent-tmp', 'antigravity-acp') });
      expect(lstatSync(join(agyHome, 'config', 'skills')).isSymbolicLink()).toBe(true);
      expect(existsSync(join(agyHome, 'antigravity-cli', 'skills'))).toBe(false);
      // a profile keeps its own folder
      expect(q.env({ ...ctx, spec: spec({ id: 'antigravity-acp@work', env: { GEMINI_HOME: join(root, 'work') } }) }).GEMINI_HOME).toBe(join(root, 'work'));

      q.beforeLogin!(ctx, 'oauth-business', { GOOGLE_CLOUD_PROJECT: 'my-proj', GOOGLE_CLOUD_LOCATION: 'us-central1' });
      const file = join(agyHome, 'antigravity-acp', 'settings.json');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ auth: { type: 'oauth-business' }, gcp: { project: 'my-proj', location: 'us-central1' } });
      q.beforeLogin!(ctx, 'oauth-personal', { GOOGLE_CLOUD_PROJECT: 'my-proj', GOOGLE_CLOUD_LOCATION: 'us-central1' });
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ auth: { type: 'oauth-personal' } });

      writeFileSync(join(root, 'data', 'agent-tmp', 'antigravity-acp', 'cacerts.txt'), 'x');
      clearScratch(q, ctx);
      expect(existsSync(join(root, 'data', 'agent-tmp', 'antigravity-acp', 'cacerts.txt'))).toBe(false);
      expect(q.isQuestion!('interaction_42')).toBe(true);
      expect(q.isQuestion!('tool_1')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
