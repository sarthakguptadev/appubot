/**
 * The free Claude day on a person's own computer (2026-11-10, decided by the backend): for a set
 * window everyone signed in to AppuBot may run Claude for free, here too. Never on an AppuBot Cloud computer:
 * its plan's AppuBot AI is simply paid by the day while it lasts, with nothing to do there.
 *
 * - `check` asks the backend whether a day is on (`GET /v1/promo`, public: signed out too): a little after launch,
 *   every `CHECK_OPEN_MS` while one is on (it can end early: its pool, a switch) and every `CHECK_IDLE_MS` otherwise.
 * - A day that is on and not taken here is an `offer` (`SystemInfo.promo`: the window shows it once; `dismiss` puts
 *   it away for that day).
 * - `begin` (Start): the account's place in the day (`POST /v1/promo/start`: the pass-through's address and the day's
 *   token, given to `CreditService`, which offers the AppuBot AI agent) and Claude Code installed in the background
 *   where it is missing (AppuBot AI runs it). No bot moves by itself (the owner's call, 2026-11-10: every bot on it
 *   would spend the gift on work nobody asked it for): the person picks it for the bots they like, in a bot's model
 *   picker or on the gift's last page (`useBot`). What a bot used before is written down as it moves (`botMoved`,
 *   from `BotsService.update`: `restore`), and forgotten when the person moves it off again.
 * - While it is on, the account's place is read again every `REFRESH_MS`: a day that closed early, or this account's
 *   fair-use limit reached, ends it here at once rather than leaving bots on an agent that refuses.
 * - `finish` (at the day's end, by a timer, or at the next launch after it): the bots still on AppuBot AI go back to
 *   their agent, model and fast mode, the agent for new bots too if it was made the gift, a bot made on it during the
 *   day gets the default,
 *   and the token and agent go (`CreditService.clear`). The window says so once (`over`). A group set to the gift's
 *   agent goes back to each bot's own.
 * - A day that closed here and is open again (its pool raised, a switch turned back on, its end moved later) is
 *   offered again: `check` drops the finish, and Start takes it up as before. One that only reached this account's
 *   limit stays over.
 *
 * Kept in `<dataDir>/promo.json`. Nothing here is an amount: the day has no price and its limit is never shown.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APPUBOT_AI_PROVIDER_ID, PROMO_DEFAULT_MODEL, type Bot, type PromoStatus } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { systemDirOf } from '../context';
import { writeFileAtomic } from '../store';
import { errMsg, RpcError } from '../util';

/** the first look after launch */
export const FIRST_CHECK_MS = 8_000;
export const CHECK_OPEN_MS = 30 * 60_000;
export const CHECK_IDLE_MS = 3_600_000;
/** while the day is on here: the account's place read again this often */
export const REFRESH_MS = 10 * 60_000;
/** a day that ended here is offered again only with this much of it left (a clock a little ahead never flaps at the end) */
export const REOPEN_MIN_LEFT_MS = 5 * 60_000;
const CLAUDE = 'claude-code';

interface Was { providerId: string; modelId?: string; fast?: boolean }
interface StoredPromo {
  /** the day last heard of */
  id: string; model: string; open: boolean; endsAt?: number; checkedAt: number;
  /** the backend's own launch page and post words for the card, when it sent any */
  launchUrl?: string; postText?: string;
  /** "Not now" on this day's offer */
  dismissed?: boolean;
  startedAt?: number;
  /** what to put back when it is over: the agent for new bots and each bot's own */
  restore?: { defaultProviderId: string; defaultModelId: string; bots: Record<string, Was> };
  finishedAt?: number;
  why?: 'ended' | 'used-up';
  /** the "it's over" note was closed */
  overSeen?: boolean;
}

export interface PromoOptions { firstCheckMs?: number; checkOpenMs?: number; checkIdleMs?: number; refreshMs?: number }

export class PromoService {
  private stored: StoredPromo | null = null;
  private job: Promise<PromoStatus> | null = null;
  private step: PromoStatus['step'];
  private error: string | undefined;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private last = '';

  constructor(private ctx: CoreCtx, private o: PromoOptions = {}) {
    if (!ctx.deps.cloud) this.stored = this.read();
  }

  private get file(): string { return join(systemDirOf(this.ctx.paths), 'promo.json'); }

  private read(): StoredPromo | null {
    try {
      if (!existsSync(this.file)) return null;
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as StoredPromo;
      return typeof raw.id === 'string' && typeof raw.open === 'boolean' ? raw : null;
    } catch (e) { this.ctx.log.warn('promo: reading the free day failed', errMsg(e)); return null; }
  }

  private save(next: StoredPromo): void {
    this.stored = next;
    try { writeFileAtomic(this.file, JSON.stringify(next), 0o600); } catch (e) { this.ctx.log.warn('promo: saving the free day failed', errMsg(e)); }
    this.changed();
  }

  /** everyone hears a new `SystemInfo.promo` */
  private changed(): void {
    const json = JSON.stringify(this.status() ?? null);
    if (json === this.last) return;
    this.last = json;
    this.ctx.bus.emit('system.updated', this.ctx.s.system.info());
  }

  /** signed in or out of AppuBot: the card's Start follows (`PromoStatus.signedIn`) */
  accountChanged(): void { this.changed(); }

  /** the day is on here: started and not finished */
  active(): boolean { return !!this.stored?.startedAt && !this.stored.finishedAt; }

  /** `SystemInfo.promo`: undefined when there is nothing to show */
  status(): PromoStatus | undefined {
    const p = this.stored;
    if (!p || this.ctx.deps.cloud) return undefined;
    const base = { id: p.id, model: p.model, ...(p.endsAt !== undefined ? { endsAt: p.endsAt } : {}), signedIn: this.ctx.s.cloudAccount.isSignedIn(), ...(p.launchUrl ? { launchUrl: p.launchUrl } : {}), ...(p.postText ? { postText: p.postText } : {}) };
    if (this.job) return { ...base, state: 'starting', ...(this.step ? { step: this.step } : {}) };
    if (p.startedAt && !p.finishedAt) return { ...base, state: 'on', bots: this.ctx.s.bots.list().filter((b) => b.providerId === APPUBOT_AI_PROVIDER_ID).length };
    if (p.finishedAt) return p.overSeen ? undefined : { ...base, state: 'over', why: p.why ?? 'ended' };
    if (!p.open || p.dismissed || (p.endsAt !== undefined && Date.now() >= p.endsAt)) return undefined;
    return { ...base, state: 'offer', ...(this.error ? { error: this.error } : {}) };
  }

  /** At the core's start (a person's own computer): a day that ended while AppuBot was closed is finished, then the first look. */
  start(): void {
    if (this.ctx.deps.cloud || this.running) return;
    this.running = true;
    if (this.active()) {
      if (this.stored!.endsAt !== undefined && Date.now() >= this.stored!.endsAt) this.finish('ended');
      else this.watch();
    } else if (this.ctx.s.credit.promo()) {
      // a gift's token with no gift on here (promo.json lost, or its write failed): the agent would stay for good
      this.ctx.log.warn('promo: a launch gift’s token without the gift; taking it away');
      try { this.offGift(); this.ctx.s.credit.clear(); } catch (e) { this.ctx.log.warn('promo: taking the leftover gift away failed', errMsg(e)); }
    }
    this.schedule(this.o.firstCheckMs ?? FIRST_CHECK_MS);
  }

  stop(): void {
    this.running = false;
    if (this.checkTimer) clearTimeout(this.checkTimer);
    if (this.endTimer) clearTimeout(this.endTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.checkTimer = this.endTimer = this.refreshTimer = null;
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => { this.checkTimer = null; void this.check(); }, ms);
    this.checkTimer.unref?.();
  }

  /** Ask the backend whether a day is on; a failure keeps what was known. */
  async check(): Promise<void> {
    try {
      const day = await this.ctx.s.cloudAccount.promo();
      const prev = this.stored;
      const same = prev?.id === day.id;
      // another day than the one kept: its offer is new (one still on here is finished first)
      if (prev && !same && this.active()) this.finish('ended');
      let kept = same ? prev! : null;
      // closed here and open again (its pool raised, the switch back on, its end moved later): offered again
      if (kept?.finishedAt && kept.why !== 'used-up' && day.open && (day.endsAt === undefined || day.endsAt - Date.now() > REOPEN_MIN_LEFT_MS)) {
        const { startedAt: _s, finishedAt: _f, why: _w, overSeen: _o, dismissed: _d, restore: _r, ...rest } = kept;
        kept = rest;
        this.ctx.log.info('promo: the launch gift is open again; offering it');
      }
      // nothing known and nothing on: nothing to keep
      if (kept || day.open) {
        const { launchUrl: _url, postText: _text, ...rest } = kept ?? ({} as Partial<StoredPromo>);
        this.save({
          ...rest, id: day.id, model: day.model || PROMO_DEFAULT_MODEL, open: day.open, checkedAt: Date.now(),
          ...(day.endsAt !== undefined ? { endsAt: day.endsAt } : {}), ...(day.launchUrl ? { launchUrl: day.launchUrl } : {}), ...(day.postText ? { postText: day.postText } : {}),
        });
      }
      if (this.active()) {
        // closed early (its pool, a switch), or its end moved
        if (!day.open) this.finish('ended'); else this.watch();
      }
    } catch (e) { this.ctx.log.debug('promo: asking about the free day failed', errMsg(e)); }
    this.schedule(this.stored?.open || this.active() ? this.o.checkOpenMs ?? CHECK_OPEN_MS : this.o.checkIdleMs ?? CHECK_IDLE_MS);
  }

  /** "Not now" on the offer, or closing the "it's over" note: not shown again for this day. */
  dismiss(): { ok: true } {
    const p = this.stored;
    if (p) {
      this.error = undefined;
      this.save(p.finishedAt ? { ...p, overSeen: true } : { ...p, dismissed: true });
    }
    return { ok: true };
  }

  /** Start: one at a time (a second press joins the first). */
  begin(): Promise<PromoStatus> {
    if (this.ctx.deps.cloud) throw new RpcError('unsupported', 'Your AppuBot computer’s Claude is already free while the launch gift lasts.');
    if (this.job) return this.job;
    if (this.active()) return Promise.resolve(this.status()!);
    if (!this.ctx.s.cloudAccount.isSignedIn()) throw new RpcError('sign_in_required', 'Sign in to AppuBot to open your launch gift.');
    this.error = undefined;
    const done = () => { this.job = null; this.step = undefined; };
    const job: Promise<PromoStatus> = this.run().then(
      () => { done(); this.changed(); return this.status()!; },
      (e: unknown) => {
        done();
        this.error = e instanceof RpcError ? e.message : `Couldn’t start it: ${errMsg(e)}`;
        this.ctx.log.warn('promo: starting the free day failed', errMsg(e));
        this.changed();
        throw e instanceof RpcError ? e : new RpcError('internal', this.error);
      },
    );
    this.job = job;
    this.changed();
    return job;
  }

  private setStep(step: PromoStatus['step']): void { this.step = step; this.changed(); }

  private async run(): Promise<void> {
    const s = this.ctx.s;
    this.setStep('account');
    const credit = await s.cloudAccount.startPromo();
    if (!credit.enabled || !credit.token || !credit.baseUrl) {
      if (this.stored) this.save({ ...this.stored, open: false, checkedAt: Date.now() });
      throw new RpcError('unavailable', 'AppuBot’s launch gift has ended.');
    }
    if (credit.exhausted) throw new RpcError('unavailable', 'This account has reached the launch gift’s fair-use limit.');
    const model = credit.defaultModel ?? this.stored?.model ?? PROMO_DEFAULT_MODEL;
    const day: StoredPromo = { ...(this.stored?.id === credit.promo ? this.stored : {}), id: credit.promo ?? this.stored?.id ?? 'free-claude-day', model, open: true, checkedAt: Date.now(), ...(credit.endsAt !== undefined ? { endsAt: credit.endsAt } : {}) };
    delete day.finishedAt; delete day.why; delete day.overSeen;

    // AppuBot AI runs Claude Code: installed here, in the background, where it is missing
    this.setStep('install');
    await s.providers.refresh([CLAUDE]).catch((e) => this.ctx.log.warn('promo: checking Claude Code failed', errMsg(e)));
    if (s.providers.list().find((p) => p.id === CLAUDE)?.installed === false) {
      this.ctx.log.info('promo: installing Claude Code');
      const r = await s.providers.install(CLAUDE, { quiet: true }).catch((e: unknown) => ({ ok: false, output: errMsg(e) }));
      if (!r.ok) throw new RpcError('unavailable', `Claude Code couldn’t be installed here (${lastLine(r.output) ?? 'no reason given'}). Install it from Settings › Agents, then press Start again.`);
    }

    // the token: AppuBot AI is offered from here on
    s.credit.apply(credit);
    if (!s.credit.active()) throw new RpcError('internal', 'AppuBot AI couldn’t be set up here.');
    await s.providers.refresh([APPUBOT_AI_PROVIDER_ID]).catch(() => undefined);

    // nothing moves by itself: the agent is there to pick, bot by bot (the model picker, or `useBot`). What the
    // agent for new bots was is kept, in case the person makes the gift their default meanwhile
    const settings = s.settings.get();
    const keptDefault = day.restore && settings.defaultProviderId === APPUBOT_AI_PROVIDER_ID;
    this.save({
      ...day, startedAt: Date.now(),
      restore: {
        defaultProviderId: keptDefault ? day.restore!.defaultProviderId : settings.defaultProviderId ?? CLAUDE,
        defaultModelId: keptDefault ? day.restore!.defaultModelId : settings.defaultModelId ?? '',
        bots: { ...(day.restore?.bots ?? {}) },
      },
    });
    this.ctx.log.info(`promo: the launch gift is on (${model}${day.endsAt ? `, until ${new Date(day.endsAt).toISOString()}` : ''}); bots use it where the person picks it`);
    this.watch();
    this.ctx.bus.emit('providers.updated', s.providers.list());
  }

  /**
   * A bot changed agent (`BotsService.update`) while the gift is on: onto it, what it used is written down for the
   * end; off it by hand, that is forgotten (it stays where the person put it).
   */
  botMoved(prev: { id: string; providerId: string; modelId?: string; fast?: boolean }, next: { providerId: string }): void {
    const p = this.stored;
    if (!p || !this.active() || prev.providerId === next.providerId) return;
    const bots = { ...(p.restore?.bots ?? {}) };
    if (next.providerId === APPUBOT_AI_PROVIDER_ID) {
      if (bots[prev.id]) return;
      bots[prev.id] = { providerId: prev.providerId, ...(prev.modelId ? { modelId: prev.modelId } : {}), ...(prev.fast ? { fast: true } : {}) };
    } else if (prev.providerId === APPUBOT_AI_PROVIDER_ID) {
      if (!bots[prev.id]) return;
      delete bots[prev.id];
    } else return;
    this.save({ ...p, restore: { defaultProviderId: p.restore?.defaultProviderId ?? CLAUDE, defaultModelId: p.restore?.defaultModelId ?? '', bots } });
    this.changed();
  }

  /** The gift's last page: put one bot on the gift, or back on what it used (the agent for new bots when nothing is known). */
  useBot(botId: string, on: boolean): Bot {
    if (!this.active()) throw new RpcError('unavailable', 'AppuBot’s launch gift isn’t on.');
    const s = this.ctx.s;
    const bot = s.bots.get(botId);
    if (!bot) throw new RpcError('not_found', 'That bot isn’t here any more.');
    if (on) return bot.providerId === APPUBOT_AI_PROVIDER_ID ? bot : s.bots.update(botId, { providerId: APPUBOT_AI_PROVIDER_ID, modelId: s.credit.giftModel() });
    if (bot.providerId !== APPUBOT_AI_PROVIDER_ID) return bot;
    const { providerId, modelId, fast } = this.backTo(bot.id);
    return s.bots.update(botId, { providerId, modelId, ...(fast ? { fast: true } : {}) });
  }

  /** where a bot on the gift goes back to: what it used when that agent is still here, else the agent for new bots */
  private backTo(botId: string): { providerId: string; modelId: string; fast: boolean } {
    const s = this.ctx.s;
    const restore = this.stored?.restore ?? { defaultProviderId: CLAUDE, defaultModelId: '', bots: {} };
    const known = new Set(s.providers.list().map((x) => x.id));
    const now = s.settings.get();
    // the agent for new bots as it is now, unless that is the gift itself: then as it was when the gift started
    const dflt = now.defaultProviderId && now.defaultProviderId !== APPUBOT_AI_PROVIDER_ID
      ? { providerId: now.defaultProviderId, modelId: now.defaultModelId ?? '' }
      : { providerId: restore.defaultProviderId, modelId: restore.defaultModelId };
    const fallback = known.has(dflt.providerId) && dflt.providerId !== APPUBOT_AI_PROVIDER_ID ? dflt : { providerId: CLAUDE, modelId: '' };
    const was = restore.bots?.[botId];
    return was && known.has(was.providerId) && was.providerId !== APPUBOT_AI_PROVIDER_ID
      ? { providerId: was.providerId, modelId: was.modelId ?? '', fast: !!was.fast }
      : { ...fallback, fast: false };
  }

  /** While it is on: the timer for its end, and the account's place read again now and then. */
  private watch(): void {
    if (!this.running || !this.active()) return;
    if (this.endTimer) clearTimeout(this.endTimer);
    const endsAt = this.stored!.endsAt;
    if (endsAt !== undefined) {
      // setTimeout holds 24.8 days at most; a day is one
      this.endTimer = setTimeout(() => { this.endTimer = null; this.finish('ended'); }, Math.min(Math.max(0, endsAt - Date.now()), 2 ** 31 - 1));
      this.endTimer.unref?.();
    }
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => { void this.refresh(); }, this.o.refreshMs ?? REFRESH_MS);
      this.refreshTimer.unref?.();
    }
  }

  /** The account's place again: closed early or used up ends it here; a new token is taken. Offline: nothing changes. */
  async refresh(): Promise<void> {
    if (!this.active() || this.job) return;
    try {
      const credit = await this.ctx.s.cloudAccount.startPromo();
      if (!this.active()) return;
      if (!credit.enabled) { this.finish('ended'); return; }
      this.ctx.s.credit.apply(credit);
      if (credit.exhausted) { this.finish('used-up'); return; }
      if (credit.endsAt !== undefined && credit.endsAt !== this.stored!.endsAt) { this.save({ ...this.stored!, endsAt: credit.endsAt }); this.watch(); }
    } catch (e) {
      // signed out meanwhile or offline: the day's token still works, and its end is a timer of our own
      this.ctx.log.debug('promo: reading the free day again failed', errMsg(e));
    }
  }

  /**
   * Everything still on the gift's agent comes off it: each bot back on what it used (`backTo`), and a group set to it
   * back on each bot's own agent (its members would be fitted to an agent that is gone). How many bots moved.
   */
  private offGift(): number {
    const s = this.ctx.s;
    let back = 0;
    for (const b of s.bots.list()) {
      if (b.providerId !== APPUBOT_AI_PROVIDER_ID) continue;
      const to = this.backTo(b.id);
      try { s.bots.update(b.id, { providerId: to.providerId, modelId: to.modelId, ...(to.fast ? { fast: true } : {}) }); back += 1; } catch (e) { this.ctx.log.warn(`promo: putting ${b.name} back on ${to.providerId} failed`, errMsg(e)); }
    }
    try {
      for (const g of s.groups.list()) {
        if (g.providerId !== APPUBOT_AI_PROVIDER_ID) continue;
        try { s.groups.update(g.id, { providerId: '' }); } catch (e) { this.ctx.log.warn(`promo: putting the group ${g.name} back on its bots’ own agents failed`, errMsg(e)); }
      }
    } catch (e) { this.ctx.log.warn('promo: reading the groups failed', errMsg(e)); }
    return back;
  }

  /** The day is over here: everything still on AppuBot AI goes back to what it used, then the token and the agent go. */
  finish(why: 'ended' | 'used-up'): void {
    const p = this.stored;
    if (!p?.startedAt || p.finishedAt) return;
    if (this.endTimer) clearTimeout(this.endTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.endTimer = this.refreshTimer = null;
    const s = this.ctx.s;
    const restore = p.restore ?? { defaultProviderId: CLAUDE, defaultModelId: '', bots: {} };
    // the agent for new bots first, if the person made it the gift: the bots without a past go there
    if (s.settings.get().defaultProviderId === APPUBOT_AI_PROVIDER_ID) {
      const known = new Set(s.providers.list().map((x) => x.id));
      const providerId = known.has(restore.defaultProviderId) && restore.defaultProviderId !== APPUBOT_AI_PROVIDER_ID ? restore.defaultProviderId : CLAUDE;
      try { s.settings.update({ defaultProviderId: providerId, defaultModelId: providerId === restore.defaultProviderId ? restore.defaultModelId : '' }); } catch (e) { this.ctx.log.warn('promo: putting the agent for new bots back failed', errMsg(e)); }
    }
    // the moves below are the end's own, not the person's: finished first, so `botMoved` leaves the record alone
    this.stored = { ...p, finishedAt: Date.now(), why };
    const back = this.offGift();
    s.credit.clear();
    this.ctx.log.info(`promo: the launch gift is over here (${why}); ${back} bots are back on their own agents`);
    this.save({ ...p, open: why === 'ended' ? false : p.open, finishedAt: Date.now(), why });
    try {
      s.notifications.notify({
        title: why === 'used-up' ? 'You’ve reached the launch gift’s fair-use limit' : 'AppuBot’s launch gift has ended',
        body: back ? 'The bots you put on it are back on what they used before.' : '', level: 'info',
      });
    } catch (e) { this.ctx.log.debug('promo: the notice failed', errMsg(e)); }
  }
}

/** the installer's last words, short */
function lastLine(output: string): string | undefined {
  const line = output.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop();
  return line ? line.slice(0, 160) : undefined;
}
