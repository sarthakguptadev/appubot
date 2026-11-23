/**
 * Installing an agent's CLI on an AppuBot Cloud computer. The image ships no
 * agent: each person installs only the ones they use, from Settings › Agents (desktop or phone) or onboarding, and
 * `providers.install` runs the agent's own installer there, non-interactively, into the home folder (the instance's
 * disk: it survives sleep and image updates). Where a Mac opens Terminal with `installHint`, the cloud runs it itself:
 *  - npm installs (`npm i -g <pkg>`: Codex, Copilot, OpenCode) go to `~/.local` (`--prefix`; the image also sets
 *    NPM_CONFIG_PREFIX there, so `providers.update`'s `npm i -g <pkg>@latest` lands in the same place);
 *  - the makers' own installers (`curl … | bash`: Claude Code, Cursor, Grok) already install into `~/.local/bin`.
 * `~/.local/bin` is on the gateway's PATH (headless.ts), so the runtime finds the CLI as soon as it is there. Windows
 * hints (PowerShell) and Homebrew ones have no Linux meaning: undefined, and the app says so.
 */
import { join } from 'node:path';

/** where agents install on a cloud computer, under its home */
export const CLOUD_AGENT_PREFIX = '.local';

const shq = (s: string): string => (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The shell line (bash -lc) that installs this agent into `home`, or undefined when its hint can't run on Linux. */
export function cloudInstallLine(installHint: string | undefined, home: string): string | undefined {
  const hint = installHint?.trim();
  if (!hint) return undefined;
  const npm = /^npm (?:i|install) -g ((?:@[\w.-]+\/)?[\w.-]+(?:@[\w.^~<>=-]+)?)$/.exec(hint);
  if (npm) return `npm install -g --prefix ${shq(join(home, CLOUD_AGENT_PREFIX))} --no-fund --no-audit ${shq(npm[1]!)}`;
  if (/^curl [^|;&`$]*\| *bash$/.test(hint)) return hint;
  return undefined;
}

/**
 * The command that installs this agent here without a terminal: `bash -lc <line>` (`cloudInstallLine`) on macOS and
 * Linux, the hint's own PowerShell command on Windows (Claude Code's `irm … | iex`); undefined when the hint can't
 * run by itself.
 */
export function quietInstall(installHint: string | undefined, home: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } | undefined {
  if (platform === 'win32') {
    const ps = /^powershell (?:-\w+(?: Bypass)? )*-Command "([^"]+)"$/.exec(installHint?.trim() ?? '');
    return ps ? { command: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps[1]!] } : undefined;
  }
  const line = cloudInstallLine(installHint, home);
  return line ? { command: 'bash', args: ['-lc', line] } : undefined;
}
