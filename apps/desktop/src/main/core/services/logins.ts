/**
 * Whose logins a bot runs on (a team admin's setting, `CloudInfo.logins`): on a team's
 * AppuBot Cloud computer set to `own`, every person has a login scope of their own, `member:<id>`: the agent CLIs run
 * with a home folder of theirs (`<dataDir>/members/<id>/home`: Claude Code, Codex, OpenCode, Gemini and every other
 * agent keep their sign-in under their home, so one folder per person separates them all, new agents included), and
 * their saved API keys (`agent-keys.json`), Vault (`vault.json`) and connected apps (`apps.json`) live in that folder
 * too. A bot belongs to the person whose device made it (`Bot.memberId`) and runs in their scope; a bot nobody owns
 * yet runs in an empty scope until an admin assigns it. On `shared`, on a personal cloud computer and on a Mac the
 * scope is `''`: the computer's own files and home, as always. Switching loses nothing: each scope's files stay, and
 * the bots' agents restart with their conversations resumed under the other set.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Bot, CloudTeamLogins } from '@appubot/protocol';
import { botLoginsText } from '@appubot/chat-core';
import type { CoreCtx } from '../context';

/** `''` = this computer's own; `member:<id>` a team member's; `member:unassigned` a team bot nobody owns yet (`own` only) */
export type LoginScope = string;
export const UNASSIGNED_SCOPE = 'member:unassigned';
export const memberScope = (memberId: string): LoginScope => `member:${memberId}`;

export class LoginsService {
  constructor(private ctx: CoreCtx) {}

  /** a team's cloud computer: its setting; elsewhere none */
  mode(): CloudTeamLogins | undefined { return this.ctx.s.system.cloudLogins(); }
  /** logins are sorted by person here (a team's computer on `own`) */
  own(): boolean { return this.mode() === 'own'; }

  scopeOfMember(memberId: string | undefined): LoginScope { return this.own() && memberId ? memberScope(memberId) : ''; }
  scopeOfBot(bot: Pick<Bot, 'memberId'>): LoginScope { return this.own() ? (bot.memberId ? memberScope(bot.memberId) : UNASSIGNED_SCOPE) : ''; }
  scopeOfBotId(botId: string): LoginScope { return this.scopeOfBot(this.ctx.s.bots.require(botId)); }
  /** the scope of a device's call: the member it belongs to (an admin's too: in `own` admins use their own logins like everyone) */
  scopeOfCall(cx: { member?: string }): LoginScope { return this.scopeOfMember(cx.member); }

  /** the scope's folder under the data folder (`''`: the data folder itself), made 0700 */
  dirOf(scope: LoginScope): string {
    if (!scope) return this.ctx.paths.dataDir;
    const dir = join(this.ctx.paths.dataDir, 'members', scope.replace(/^member:/, '').replace(/[^A-Za-z0-9_-]/g, '_'));
    this.ensureDir(dir);
    return dir;
  }
  /** the home folder the scope's agents run with (`LoginEnv.loginHome`); none for the computer's own */
  homeOf(scope: LoginScope): string | undefined {
    if (!scope) return undefined;
    const home = join(this.dirOf(scope), 'home');
    this.ensureDir(home);
    return home;
  }
  /** a per-scope file (`agent-keys.json`, `vault.json`, `apps.json`) */
  fileOf(scope: LoginScope, name: string): string { return join(this.dirOf(scope), name); }
  /** what the runtime gets for a scope */
  loginEnv(scope: LoginScope): { loginHome?: string; loginScope?: string } {
    const loginHome = this.homeOf(scope);
    return { ...(loginHome ? { loginHome } : {}), ...(scope ? { loginScope: scope } : {}) };
  }

  /** the people the computer knows (their devices are paired), for naming whose logins a bot uses */
  members(): { id: string; email: string }[] { return this.ctx.s.devices.members(); }
  /** "Uses ada@acme.com's logins" / "Uses the team's logins" / "Uses no one's logins yet"; nothing off a team's cloud computer */
  botLoginsLine(bot: Pick<Bot, 'memberId'>): string | undefined {
    const mode = this.mode();
    if (!mode) return undefined;
    const email = bot.memberId ? this.members().find((m) => m.id === bot.memberId)?.email : undefined;
    return botLoginsText(mode, bot.memberId ? { email: email || bot.memberId } : undefined);
  }

  private ensureDir(dir: string): void {
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); } catch { /* exists, or a read-only disk: the next write says */ }
  }
}
