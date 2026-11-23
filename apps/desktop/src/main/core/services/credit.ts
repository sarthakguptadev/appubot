/**
 * The included Claude credit on an AppuBot Cloud computer, a limited-time launch bonus that
 * the backend can end for everyone (`ended`: refused like a used-up month): the backend tells this computer
 * its credit (bootstrap, `/control/state`, every heartbeat answer: `CloudCreditSettings`) and, when it is new, the
 * credit token. This service keeps them (`<dataDir>/cloud-credit.json`, 0600; the token stays in the core and never
 * goes on the wire: `SystemInfo.cloud.credit` carries the amounts alone), offers the agent "AppuBot AI"
 * (`APPUBOT_AI_PROVIDER_ID`: a Claude Code profile with a config folder of its own, so no login of the user's is
 * mixed in) while the credit is on, gives its sessions the environment Claude Code reads a gateway from
 * (`ANTHROPIC_BASE_URL` = the backend's pass-through, `ANTHROPIC_AUTH_TOKEN` = the token, sent as `Authorization:
 * Bearer`; Claude Code's docs: a token in that variable takes precedence over any saved login at once), and, the first
 * time the credit comes, makes AppuBot AI the default agent and moves the bots on plain Claude Code (a fresh
 * computer's default bot, signed in to nothing) onto it, so a new subscriber's bots work with no sign-in at all. The
 * user can switch any bot to their own logins any time. While the plan has no credit (payment on hold, the plan
 * ended: `enabled: false`) the agent stays listed, shown as paused and signed out, and its turns get the backend's
 * refusal, so nothing of the user's is moved around by a short hold; the credit coming back signs it in again.
 *
 * A person's own computer (`deps.cloud` absent) has no plan's credit. It holds credit only during a free Claude day
 * (`promo.ts`: `CloudCreditSettings.promo` set, from `POST /v1/promo/start`): the same agent id, token and
 * environment, but shown as "Claude" under the profile "AppuBot Launch Gift" with one model row, "Claude" (the gift's
 * model is never named: `ProviderSpec.oneModel`, every alias of Claude Code's pointed at it), no amounts shown anywhere (`status()` answers none) and no defaults applied here (`PromoService`
 * moves the bots and puts them back); `clear()` takes it all away when the day is over.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { APPUBOT_AI_BIG_MODEL, APPUBOT_AI_DEFAULT_MODEL, APPUBOT_AI_NAME, APPUBOT_AI_PROVIDER_ID, CREDIT_MODELS_TEXT, PROMO_AGENT_NAME, PROMO_DEFAULT_MODEL, PROMO_PROFILE_NAME, creditModelAllowed, modelDisplayName, promoModelAllowed, type CloudCreditSettings, type CloudCreditStatus } from '@appubot/protocol';
import type { ProviderSpec } from '@appubot/agent-runtime';
import type { CoreCtx } from '../context';
import { systemDirOf } from '../context';
import { writeFileAtomic } from '../store';
import { errMsg, RpcError } from '../util';

/** what the file holds: the backend's last word, the token when it was sent, and whether the defaults were applied once */
interface StoredCredit {
  enabled: boolean;
  status?: CloudCreditStatus;
  baseUrl?: string;
  token?: string;
  key?: string;
  defaultsAppliedAt?: number;
  /** a free Claude day's credit (its id), not a plan's: the only kind a person's own computer holds */
  promo?: string;
  at: number;
}

export const isAppubotAi = (providerId: string): boolean => providerId === APPUBOT_AI_PROVIDER_ID;

/**
 * AppuBot AI (the launch bonus) runs Sonnet and Haiku at the standard speed only (the backend refuses the rest): a
 * pick of another model or of fast mode for it is refused here with words for the user, wherever it comes from (the
 * pickers, the bot editor, `update_bot`, Telegram's /model and /fast).
 */
export function checkCreditPick(providerId: string, pick: { modelId?: string; fast?: boolean }, gift = false): void {
  if (!isAppubotAi(providerId)) return;
  if (pick.modelId && gift && !promoModelAllowed(pick.modelId)) throw new RpcError('invalid_params', 'AppuBot’s launch gift runs its own Claude model only. Move this bot to your own Claude account to pick another.');
  if (pick.modelId && !creditModelAllowed(pick.modelId)) throw new RpcError('invalid_params', `AppuBot AI runs ${CREDIT_MODELS_TEXT} only. Pick one of them, or move this bot to your own Claude account for ${modelDisplayName(pick.modelId)}.`);
  if (pick.fast) throw new RpcError('invalid_params', 'AppuBot AI has no fast mode. Move this bot to your own Claude account to use it.');
}

export class CreditService {
  private stored: StoredCredit | null = null;

  constructor(private ctx: CoreCtx) {
    this.stored = this.read();
    // a person's own computer keeps only a free day's credit
    if (!ctx.deps.cloud && this.stored && !this.stored.promo) this.stored = null;
  }

  private get file(): string { return join(systemDirOf(this.ctx.paths), 'cloud-credit.json'); }

  private read(): StoredCredit | null {
    try {
      if (!existsSync(this.file)) return null;
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as StoredCredit;
      return typeof raw.enabled === 'boolean' ? raw : null;
    } catch (e) { this.ctx.log.warn('reading the cloud credit failed', errMsg(e)); return null; }
  }

  private save(next: StoredCredit | null): void {
    this.stored = next;
    try {
      if (!next) { if (existsSync(this.file)) rmSync(this.file); return; }
      writeFileAtomic(this.file, JSON.stringify(next), 0o600);
    } catch (e) { this.ctx.log.warn('saving the cloud credit failed', errMsg(e)); }
  }

  /** the AppuBot AI agent is offered: this computer holds a credit token (the plan may be paused meanwhile: `active`) */
  offered(): boolean { return (!!this.ctx.deps.cloud || !!this.stored?.promo) && !!this.stored?.token && !!this.stored.baseUrl; }
  /** this credit is a free Claude day's (its id), not a plan's */
  promo(): string | undefined { return this.offered() ? this.stored?.promo : undefined; }
  /** the credit is on and the token is here: the AppuBot AI agent can work */
  active(): boolean { return this.offered() && !!this.stored?.enabled; }

  /** `SystemInfo.cloud.credit`: the amounts, while the plan has credit (never the token) */
  status(): CloudCreditStatus | undefined {
    // a free day's amounts are its fair-use limit: never shown
    return this.stored?.enabled && this.stored.status && !this.stored.promo ? this.stored.status : undefined;
  }

  /** the token's fingerprint, for the heartbeat ('' when none: the backend sends the token again) */
  key(): string { return this.stored?.token && this.stored.key ? this.stored.key : ''; }

  /** the config folder the AppuBot AI profile runs with (`CLAUDE_CONFIG_DIR`): made 0700 */
  home(): string {
    const dir = join(this.ctx.paths.dataDir, 'profiles', 'claude-code', 'appubot-ai');
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
    return dir;
  }

  /** the AppuBot AI agent as a provider spec (a profile of Claude Code), or null while this computer never had credit */
  spec(): ProviderSpec | null {
    if (!this.offered()) return null;
    let claude: ProviderSpec | undefined;
    try { claude = this.ctx.runtime.getProviders().find((p) => p.id === 'claude-code' && !p.profile); } catch { claude = undefined; }
    if (!claude) return null;
    // the launch gift: "Claude" under the profile "AppuBot Launch Gift", one model row named "Claude"
    if (this.stored?.promo) {
      return {
        id: APPUBOT_AI_PROVIDER_ID, name: PROMO_AGENT_NAME, description: 'Claude, free while AppuBot’s launch gift lasts.',
        command: claude.command, args: [], env: {}, icon: claude.icon ?? 'sparkles', enabled: true,
        profile: { of: 'claude-code', name: PROMO_PROFILE_NAME, home: this.home(), source: 'credit' },
        oneModel: { id: this.giftModel(), name: PROMO_AGENT_NAME },
      };
    }
    return {
      id: APPUBOT_AI_PROVIDER_ID, name: APPUBOT_AI_NAME, description: 'Claude Sonnet and Haiku on your plan’s launch bonus, for a limited time. Sonnet uses it faster.',
      command: claude.command, args: [], env: {}, icon: claude.icon ?? 'sparkles', enabled: true,
      profile: { of: 'claude-code', name: APPUBOT_AI_NAME, home: this.home(), source: 'credit' },
    };
  }

  /**
   * What AppuBot AI's sessions get in their environment (the runtime's `secretEnv`); nothing for any other agent. The
   * launch bonus pays for Sonnet and Haiku at the standard speed only (the backend refuses the rest), so Claude Code
   * is kept to them: fast mode off, Haiku when nothing else is picked, and its `opus`/`fable` aliases (a subagent's or
   * a plan mode's pick) run Sonnet instead of failing.
   */
  env(providerId: string): Record<string, string> | undefined {
    if (!isAppubotAi(providerId) || !this.offered()) return undefined;
    if (this.stored?.promo) {
      // the launch gift pays for one model: Claude Code's default and every alias of its (a subagent's or plan mode's pick) run it
      const model = this.giftModel();
      return {
        ANTHROPIC_BASE_URL: this.stored.baseUrl!, ANTHROPIC_AUTH_TOKEN: this.stored.token!,
        CLAUDE_CODE_DISABLE_FAST_MODE: '1', ANTHROPIC_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_FABLE_MODEL: model,
      };
    }
    return {
      ANTHROPIC_BASE_URL: this.stored!.baseUrl!, ANTHROPIC_AUTH_TOKEN: this.stored!.token!,
      CLAUDE_CODE_DISABLE_FAST_MODE: '1',
      ANTHROPIC_MODEL: this.stored?.status?.defaultModel ?? APPUBOT_AI_DEFAULT_MODEL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: APPUBOT_AI_BIG_MODEL,
      ANTHROPIC_DEFAULT_FABLE_MODEL: APPUBOT_AI_BIG_MODEL,
    };
  }

  /**
   * The backend's word (bootstrap, `/control/state`, a heartbeat answer): kept, the agent offered or taken away, the
   * defaults applied the first time. The token only changes when one is sent (a status-only answer keeps it).
   */
  apply(c: CloudCreditSettings): void {
    if (!this.ctx.deps.cloud && !c.promo) return;
    const prev = this.stored;
    const wasOffered = this.offered(), wasActive = this.active();
    const status: CloudCreditStatus | undefined = c.enabled && c.budgetCents !== undefined && c.usedCents !== undefined && c.resetsAt !== undefined
      ? { budgetCents: c.budgetCents, usedCents: c.usedCents, currency: c.currency ?? 'USD', resetsAt: c.resetsAt, exhausted: !!c.exhausted, defaultModel: c.defaultModel ?? APPUBOT_AI_DEFAULT_MODEL, ...(c.shared ? { shared: true } : {}), ...(c.ended ? { ended: true } : {}), ...(c.endsAt !== undefined ? { endsAt: c.endsAt } : {}) }
      : undefined;
    const next: StoredCredit = {
      enabled: c.enabled, ...(status ? { status } : {}), baseUrl: c.baseUrl ?? prev?.baseUrl,
      token: c.token ?? prev?.token, key: c.token ? c.key ?? prev?.key : c.key ?? prev?.key,
      ...(prev?.defaultsAppliedAt ? { defaultsAppliedAt: prev.defaultsAppliedAt } : {}), ...(c.promo ? { promo: c.promo } : {}), at: Date.now(),
    };
    // a token the backend knows by another key is stale: forget it, the next heartbeat brings the new one
    if (!c.token && c.key && prev?.key && c.key !== prev.key) { next.token = undefined; next.key = c.key; }
    const changed = JSON.stringify({ ...next, at: 0 }) !== JSON.stringify({ ...(prev ?? {}), at: 0 });
    this.save(next);
    if (!changed) return;
    const nowOffered = this.offered(), nowActive = this.active();
    if (nowOffered !== wasOffered || nowActive !== wasActive) {
      this.ctx.log.info(`cloud credit: ${nowActive ? 'on' : nowOffered ? 'paused' : 'off'}${status ? ` (${status.usedCents} of ${status.budgetCents} cents used)` : ''}`);
      if (nowOffered !== wasOffered) this.ctx.s.providers.applyCustom();
      if (nowActive && !next.promo) this.applyDefaultsOnce();
      void this.ctx.s.providers.refreshQuiet(APPUBOT_AI_PROVIDER_ID);
      this.ctx.bus.emit('providers.updated', this.ctx.s.providers.list());
    } else if (nowActive && c.token && c.token !== prev?.token) {
      // a rotated token: the running sessions carry the old one in their environment
      this.ctx.log.info('cloud credit: a new token; AppuBot AI chats restart with it');
      this.ctx.s.chat.restartAgents((id) => isAppubotAi(id));
    }
    this.ctx.s.system.cloudChanged();
  }

  /** the launch gift's one model (the backend's word, else the protocol's) */
  giftModel(): string { return this.stored?.status?.defaultModel ?? PROMO_DEFAULT_MODEL; }

  /** A free Claude day is over here: the token and the agent go (the bots were moved off it first: `PromoService`). */
  clear(): void {
    if (!this.stored) return;
    const wasOffered = this.offered();
    this.save(null);
    if (!wasOffered) return;
    this.ctx.log.info('credit: the free Claude day’s credit is gone; AppuBot AI is taken away');
    this.ctx.s.providers.applyCustom();
    this.ctx.bus.emit('providers.updated', this.ctx.s.providers.list());
  }

  /** the free day's fair-use limit is reached for this account (the backend's word) */
  usedUp(): boolean { return !!this.stored?.promo && !!this.stored.status?.exhausted; }

  /** the launch bonus has ended for everyone (the backend's `ended`): AppuBot AI's turns are refused like a used-up month */
  ended(): boolean { return !!this.stored?.enabled && !!this.stored.status?.ended; }

  /**
   * The first time the credit arrives: AppuBot AI becomes the default agent, and the bots on plain Claude Code move
   * onto it. Not once the launch bonus has ended (nothing would work on it), and then never later either: a bonus
   * that comes back doesn't move bots the user may have signed in meanwhile.
   */
  private applyDefaultsOnce(): void {
    if (this.stored?.defaultsAppliedAt) return;
    // OpenCode's free models are the default here (`freeAgent.ts`, the owner's call 2026-11-14): AppuBot AI is a pick away
    if (this.ctx.s.freeAgent?.adopted()) { this.save({ ...this.stored!, defaultsAppliedAt: Date.now() }); this.ctx.log.info('cloud credit: OpenCode is the default agent here; the defaults are left as they are'); return; }
    if (this.ended()) { this.save({ ...this.stored!, defaultsAppliedAt: Date.now() }); this.ctx.log.info('cloud credit: the launch bonus has ended; the defaults are left as they are'); return; }
    const s = this.ctx.s;
    const model = this.stored?.status?.defaultModel ?? APPUBOT_AI_DEFAULT_MODEL;
    s.settings.update({ defaultProviderId: APPUBOT_AI_PROVIDER_ID, defaultModelId: model });
    for (const bot of s.bots.list()) {
      if (bot.providerId !== 'claude-code') continue;
      try { s.bots.update(bot.id, { providerId: APPUBOT_AI_PROVIDER_ID, modelId: model }); } catch (e) { this.ctx.log.warn(`cloud credit: moving ${bot.name} to AppuBot AI failed`, errMsg(e)); }
    }
    this.save({ ...this.stored!, defaultsAppliedAt: Date.now() });
    this.ctx.log.info(`cloud credit: AppuBot AI (${model}) is the default agent now`);
  }
}
