/**
 * What some agents need beyond plain ACP, by agent (an ACP registry agent's provider id is its registry id; a profile
 * of one is `<id>@<slug>`): an environment of their own at every start, a sign-in page AppuBot opens itself rather
 * than the agent, and their own way of asking a question. Today that is Google Antigravity (`antigravity-acp`), as T3
 * Code runs it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { providerBase } from '@appubot/protocol';
import type { ProviderSpec } from './types';

/** What the `BROWSER` helper of `captureBrowser` prints, on the agent's stderr, instead of opening a page: the URL follows. */
export const AUTH_URL_MARK = '__APPUBOT_AUTH_URL__';

export interface QuirkCtx {
  spec: ProviderSpec;
  /** AppuBot's data folder (`RuntimeOptions.dataDir`): the agent's own folders go under it */
  dataDir: string;
  platform: string;
  home: string;
}

export interface AgentQuirks {
  /** env at every start (the spec's own env and the user's keys still win), its folders made first */
  env(ctx: QuirkCtx): Record<string, string>;
  /** the sign-in pages the agent opens: a captured URL elsewhere is never opened */
  authUrl: RegExp;
  /** before `authenticate(methodId)`, with the keys saved for it: what makes that login the one it uses from then on */
  beforeLogin?(ctx: QuirkCtx, methodId: string, keys: Record<string, string>): void;
  /** a permission request that is really a question, its options the answers (never approved for the user) */
  isQuestion?(toolCallId: string): boolean;
  /** folders of throwaway files, emptied the first time the agent starts in a run of the app */
  scratch?(ctx: QuirkCtx): string[];
}

/**
 * A `BROWSER` for an agent that opens its sign-in page through it (Python's `webbrowser`): it prints the page's URL
 * on the agent's stderr after `AUTH_URL_MARK` instead, and AppuBot opens it when the user asked to sign in (anywhere
 * else, a page wanting a login means the agent needs one: it is never opened behind the user's back). Python splits
 * `BROWSER` on the path separator, so the line holds no `:` on macOS/Linux; Windows runs a PowerShell script file
 * (its `-File` arguments aren't parsed again, so a URL's `&` stays put).
 */
export function captureBrowser(dataDir: string, platform: string = process.platform): string {
  if (platform !== 'win32') return `/bin/sh -c 'echo "${AUTH_URL_MARK}$1" >&2' sh %s`;
  const script = join(dataDir, 'agent-browser.ps1');
  const body = `[Console]::Error.WriteLine('${AUTH_URL_MARK}' + $args[0])\r\n`;
  try {
    if (!existsSync(script) || readFileSync(script, 'utf8') !== body) {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(script, body);
    }
  } catch { /* the agent opens the page itself then */ }
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '${script}' %s`;
}

/** A URL `captureBrowser` printed, from one line of the agent's output; undefined when the line has none. */
export function capturedUrl(line: string): string | undefined {
  const i = line.indexOf(AUTH_URL_MARK);
  if (i < 0) return undefined;
  const url = line.slice(i + AUTH_URL_MARK.length).trim();
  return /^https:\/\/\S+$/.test(url) ? url : undefined;
}

/** The folder an Antigravity agent keeps its login, settings and conversations in (`GEMINI_HOME`). */
function antigravityHome(ctx: QuirkCtx): string {
  return ctx.spec.env.GEMINI_HOME || join(ctx.dataDir, 'agent-homes', providerBase(ctx.spec.id));
}

/**
 * Google Antigravity's ACP agent (`agy_acp_server`, the registry's `antigravity-acp`):
 * - its login, settings and conversations in a folder of AppuBot's (`GEMINI_HOME`), the login in a file there rather
 *   than the Keychain (`AGY_ACP_FORCE_FILE_STORAGE`); the user's own global skills are linked in;
 * - its `localharness_external` helper, shipped next to it, named (`ANTIGRAVITY_HARNESS_PATH`);
 * - its Google sign-in page caught through `BROWSER` (`captureBrowser`);
 * - which login it uses is `auth.type` in `antigravity-acp/settings.json` (with the Google Cloud project and location
 *   of a Gemini Enterprise or Agent Platform login): without it a session is refused until `authenticate`;
 * - a multiple-choice question comes as a permission request whose tool call id starts with `interaction_`;
 * - its temp files in a folder of AppuBot's, emptied at the first start of each app run.
 */
const ANTIGRAVITY: AgentQuirks = {
  env(ctx) {
    const home = antigravityHome(ctx);
    const tmp = join(ctx.dataDir, 'agent-tmp', providerBase(ctx.spec.id));
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(tmp, { recursive: true });
    // the user's own skills for every project (Antigravity doesn't read ~/.agents/skills)
    for (const rel of [['config', 'skills'], ['antigravity-cli', 'skills']]) {
      const target = join(ctx.home, '.gemini', ...rel);
      const link = join(home, ...rel);
      if (!existsSync(target) || existsSync(link)) continue;
      try {
        mkdirSync(dirname(link), { recursive: true });
        symlinkSync(target, link, ctx.platform === 'win32' ? 'junction' : 'dir');
      } catch { /* its own folder then */ }
    }
    const exe = ctx.platform === 'win32' ? '.exe' : '';
    const harness = isAbsolute(ctx.spec.command) ? join(dirname(ctx.spec.command), `localharness_external${exe}`) : undefined;
    return {
      GEMINI_HOME: home,
      AGY_ACP_FORCE_FILE_STORAGE: '1',
      PYTHONUNBUFFERED: '1',
      BROWSER: captureBrowser(ctx.dataDir, ctx.platform),
      ...(harness && existsSync(harness) ? { ANTIGRAVITY_HARNESS_PATH: harness } : {}),
      ...(ctx.platform === 'win32' ? { TEMP: tmp, TMP: tmp } : { TMPDIR: tmp }),
    };
  },
  authUrl: /^https:\/\/accounts\.google\.com\//,
  beforeLogin(ctx, methodId, keys) {
    const file = join(antigravityHome(ctx), 'antigravity-acp', 'settings.json');
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { /* none yet */ }
    const project = keys.GOOGLE_CLOUD_PROJECT;
    const location = keys.GOOGLE_CLOUD_LOCATION;
    const gcp = (methodId === 'oauth-business' || methodId === 'agent-platform') && project && location ? { gcp: { project, location } } : {};
    const { gcp: _old, ...rest } = settings;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ ...rest, auth: { type: methodId }, ...gcp }, null, 2));
  },
  isQuestion: (toolCallId) => toolCallId.startsWith('interaction_'),
  scratch: (ctx) => [join(ctx.dataDir, 'agent-tmp', providerBase(ctx.spec.id))],
};

const QUIRKS: Record<string, AgentQuirks> = { 'antigravity-acp': ANTIGRAVITY };

/** The quirks of the agent `spec` runs, if it has some. */
export function quirksFor(spec: ProviderSpec): AgentQuirks | undefined {
  return QUIRKS[providerBase(spec.id)] ?? (spec.registry ? QUIRKS[spec.registry.id] : undefined);
}

export function quirkCtx(spec: ProviderSpec, dataDir: string): QuirkCtx {
  return { spec, dataDir, platform: process.platform, home: homedir() };
}

/** Empty an agent's throwaway folders (`AgentQuirks.scratch`): its first start in this run, so none of its files are in use. */
export function clearScratch(q: AgentQuirks, ctx: QuirkCtx): void {
  for (const dir of q.scratch?.(ctx) ?? []) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      try { rmSync(join(dir, n), { recursive: true, force: true }); } catch { /* still in use */ }
    }
  }
}
