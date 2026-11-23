/**
 * Custom characters (protocol characters.ts): the library bots wear them from (`<dataDir>/characters.json`, shared by
 * every bot, at most CHARACTERS_MAX) and drawing new ones with the user's own agent.
 *
 * Generating runs on the user's own subscription (Claude Code, Codex…): a hidden one-off session of that agent in an
 * empty folder of its own, like the model pickers' probe (providers.ts `readChoices`): no MCP bridge, no files, and
 * whatever tool it asks for is refused (ChatService refuses permission requests from sessions that aren't a chat's).
 * Its text comes back through `ChatService.listenSession` (never a thread, never an event), is read by chat-core's
 * `parseCharacterReply`, asked again (twice at most) when nothing in it was usable, and the session is closed. 90 s at
 * most, cancellable; a few a minute.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHARACTERS_MAX, CharacterSchema, freeModelsToTry, newId, providerBase,
  type Character, type MethodParams, type MethodResult, type Provider,
} from '@appubot/protocol';
import {
  CHARACTER_CANDIDATES, CHARACTER_STORED_LIMITS, characterPrompt, characterRetryPrompt, cleanCharacterName, normalizeCharacter, parseCharacterReply,
} from '@appubot/chat-core';
import type { CoreCtx } from '../context';
import { errMsg, notFound, RpcError } from '../util';
import { writeFileAtomic } from '../store';

/** The whole generation, agent start to last reply. */
export const GENERATE_TIMEOUT_MS = 90_000;
/** Tries per generation: the first ask and up to two more when nothing in a reply could be used. */
const GENERATE_TRIES = 3;
/** Generations started in any minute, and running at once. */
const GENERATE_PER_MINUTE = 6;
const GENERATE_AT_ONCE = 2;
/** Agents asked first, in this order, when the one asked for can't draw. */
const PREFERRED = ['claude-code', 'codex'];

interface Generation { cancelled: boolean; sessionId?: string; stop: (e: Error) => void }

const cancelledError = () => new RpcError('cancelled', 'Stopped.');

export class CharactersService {
  private items: Character[];
  private running = new Map<string, Generation>();
  private started: number[] = [];

  constructor(private ctx: CoreCtx) {
    this.items = this.read();
  }

  private file(): string { return join(this.ctx.paths.dataDir, 'characters.json'); }

  private read(): Character[] {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.file(), 'utf8')); } catch { return []; }
    const list = Array.isArray((raw as { characters?: unknown })?.characters) ? (raw as { characters: unknown[] }).characters : [];
    // anything that doesn't read as a character (edited by hand, an older format) is left out
    return list.flatMap((c) => {
      const r = CharacterSchema.safeParse(c);
      return r.success ? [r.data] : [];
    }).slice(0, CHARACTERS_MAX);
  }

  private write(): void {
    try { writeFileAtomic(this.file(), JSON.stringify({ characters: this.items }, null, 2)); } catch (e) { this.ctx.log.error('characters: could not save', errMsg(e)); }
  }

  list(): Character[] { return this.items; }
  get(id: string | undefined): Character | undefined { return id ? this.items.find((c) => c.id === id) : undefined; }
  require(id: string): Character {
    const c = this.get(id);
    if (!c) throw notFound('Character', id);
    return c;
  }

  /** Keep one in the library: read, fitted and its face placed again here, whatever the caller did. */
  save(p: MethodParams<'characters.save'>): Character {
    if (this.items.length >= CHARACTERS_MAX) throw new RpcError('limit', `You have ${CHARACTERS_MAX} characters already. Delete one to keep another.`);
    const r = normalizeCharacter({ body: p.body, face: p.face ?? null }, { limits: CHARACTER_STORED_LIMITS });
    if (!r.ok) throw new RpcError('invalid_params', r.error);
    const c = CharacterSchema.parse({ id: newId('chr'), name: cleanCharacterName(p.name), body: r.body, face: r.face, source: p.source, createdAt: Date.now() });
    this.items = [...this.items, c];
    this.write();
    this.ctx.bus.emit('character.updated', c);
    return c;
  }

  rename(id: string, name: string): Character {
    const prev = this.require(id);
    const next = { ...prev, name: cleanCharacterName(name, prev.name) };
    this.items = this.items.map((c) => (c.id === id ? next : c));
    this.write();
    this.ctx.bus.emit('character.updated', next);
    return next;
  }

  /** Out of the library; the bots wearing it go back to their own shapes (through `bots.update`, so everything follows). */
  delete(id: string): MethodResult<'characters.delete'> {
    this.require(id);
    this.items = this.items.filter((c) => c.id !== id);
    this.write();
    this.ctx.bus.emit('character.removed', { id });
    let bots = 0;
    for (const b of this.ctx.s.bots.list().filter((x) => x.characterId === id)) {
      try { this.ctx.s.bots.update(b.id, { characterId: '' }); bots++; } catch (e) { this.ctx.log.warn(`characters: ${b.name} kept a removed character`, errMsg(e)); }
    }
    return { ok: true, bots };
  }

  /* ------------------------------------------------------------------ generating */

  /** Whether an agent can draw now: installed, on, and not known to be signed out. */
  private usable(p: Provider | undefined): p is Provider {
    return !!p && p.installed && p.enabled && p.authStatus !== 'needs_auth' && p.authStatus !== 'not_installed' && p.auth?.state !== 'logged_out';
  }

  /** The agent asked for (or the bot's, or the one new bots start on), else the first that can draw. */
  private agentFor(p: { providerId?: string; botId?: string }): string {
    const all = this.ctx.s.providers.list();
    const wanted = [p.providerId, p.botId ? this.ctx.s.bots.get(p.botId)?.providerId : undefined, this.ctx.s.settings.get().defaultProviderId];
    for (const id of wanted) {
      const hit = id ? all.find((x) => x.id === id) : undefined;
      if (this.usable(hit)) return hit.id;
    }
    const rest = all.filter((x) => this.usable(x)).sort((a, b) => rank(a.id) - rank(b.id));
    if (rest[0]) return rest[0].id;
    throw new RpcError('unavailable', 'Drawing characters uses one of your agents, like Claude Code or Codex, and none is installed and signed in on this computer. Set one up in Settings › Agents, then try again.');
  }

  /** A few new characters from `prompt`, drawn by the user's own agent in a hidden session (none saved). */
  async generate(p: MethodParams<'characters.generate'>, device: string): Promise<MethodResult<'characters.generate'>> {
    const now = Date.now();
    this.started = this.started.filter((t) => now - t < 60_000);
    if (this.started.length >= GENERATE_PER_MINUTE) throw new RpcError('rate_limited', 'That’s a lot of characters in a minute. Try again shortly.');
    if (this.running.size >= GENERATE_AT_ONCE) throw new RpcError('busy', 'Already drawing characters. Wait for those, or stop them.');
    const providerId = this.agentFor(p);
    this.started.push(now);
    const key = `${device}:${p.requestId ?? newId('gen')}`;
    this.running.get(key)?.stop(cancelledError());
    let stop!: (e: Error) => void;
    const stopped = new Promise<never>((_, reject) => { stop = reject; });
    stopped.catch(() => undefined);
    const gen: Generation = { cancelled: false, stop: (e) => { gen.cancelled = true; stop(e); } };
    this.running.set(key, gen);
    const timer = setTimeout(() => gen.stop(new RpcError('timeout', 'Your agent took too long to draw. Try again, maybe with a simpler description.')), GENERATE_TIMEOUT_MS);
    timer.unref?.();
    try {
      // the model picked beside it, when it is that agent's
      const modelId = providerId === p.providerId && p.modelId ? p.modelId : undefined;
      const candidates = await this.draw(providerId, p.prompt, gen, stopped, modelId);
      return { candidates, providerId };
    } finally {
      clearTimeout(timer);
      if (this.running.get(key) === gen) this.running.delete(key);
      const sid = gen.sessionId;
      if (sid) {
        if (gen.cancelled) void this.ctx.runtime.cancel(sid).catch(() => undefined);
        void this.ctx.runtime.closeSession(sid).catch(() => undefined);
      }
    }
  }

  private async draw(providerId: string, description: string, gen: Generation, stopped: Promise<never>, modelId?: string): Promise<MethodResult<'characters.generate'>['candidates']> {
    const cwd = join(this.ctx.paths.dataDir, 'character-studio');
    mkdirSync(cwd, { recursive: true });
    const race = <T>(p: Promise<T>) => Promise.race([p, stopped]);
    const opening = this.ctx.runtime.createSession({ providerId, cwd, effortId: 'low', ...(modelId ? { modelId } : {}) });
    // a session that opens after a cancel is closed all the same
    void opening.then((info) => { if (gen.cancelled) void this.ctx.runtime.closeSession(info.id).catch(() => undefined); }, () => undefined);
    let info;
    try {
      info = await race(opening);
    } catch (e) {
      throw agentError(e, this.ctx.s.providers.list().find((x) => x.id === providerId)?.name ?? providerBase(providerId));
    }
    gen.sessionId = info.id;
    // the free agent (OpenCode) with no model asked for: its own pick may be a model that refuses ("The requested model
    // is not supported", a provider of the person's own, or one that left the free tier), so it draws on a free model
    // that answers, as a chat would (ChatService.openSession)
    if (!modelId) {
      for (const want of freeModelsToTry(providerId, info.currentModelId, info.models)) {
        if (gen.cancelled) break;
        try { info = await race(this.ctx.runtime.setModel(info.id, want)); break; } catch (e) {
          if (gen.cancelled) throw e;
          this.ctx.log.warn(`characters: drawing on ${want} failed`, errMsg(e));
        }
      }
    }
    let text = '';
    let part = -1;
    const off = this.ctx.s.chat.listenSession(info.id, (op) => {
      if (op.op !== 'delta' || op.partType !== 'text') return;
      if (part !== op.partIndex && text) text += '\n';
      part = op.partIndex;
      text += op.delta;
    });
    try {
      let prompt = characterPrompt(description, CHARACTER_CANDIDATES);
      let lastError = '';
      for (let i = 0; i < GENERATE_TRIES; i++) {
        text = '';
        part = -1;
        try {
          await race(this.ctx.runtime.prompt(info.id, [{ type: 'text', text: prompt }]));
        } catch (e) {
          if (gen.cancelled || e instanceof RpcError) throw e;
          throw agentError(e, providerBase(providerId));
        }
        if (gen.cancelled) throw cancelledError();
        const { drafts, errors } = parseCharacterReply(text, CHARACTER_CANDIDATES);
        if (drafts.length) return drafts;
        lastError = errors[0] ?? 'nothing in the reply could be used';
        this.ctx.log.info(`characters: try ${i + 1} gave nothing usable (${lastError})`);
        prompt = characterRetryPrompt(lastError, CHARACTER_CANDIDATES);
      }
      throw new RpcError('invalid_reply', 'Your agent’s drawings couldn’t be used. Try again, or describe it another way.');
    } finally {
      off();
    }
  }

  /** Stop this device's generation (`requestId`), or all of them. */
  cancel(device: string, requestId?: string): { ok: true } {
    for (const [key, gen] of this.running) {
      if (requestId ? key === `${device}:${requestId}` : key.startsWith(`${device}:`)) gen.stop(cancelledError());
    }
    return { ok: true };
  }

  shutdown(): void {
    for (const gen of this.running.values()) gen.stop(cancelledError());
  }
}

const rank = (id: string) => {
  const i = PREFERRED.indexOf(providerBase(id));
  return i < 0 ? PREFERRED.length : i;
};

/** What went wrong with the agent, in the user's words. */
function agentError(e: unknown, agent: string): RpcError {
  if (e instanceof RpcError) return e;
  const code = (e as { code?: unknown })?.code;
  if (code === 'needs_auth') return new RpcError('needs_auth', `${agent} isn’t signed in. Sign in to it in Settings › Agents, then try again.`);
  if (code === 'not_installed') return new RpcError('unavailable', `${agent} isn’t installed on this computer.`);
  return new RpcError('agent_error', `${agent} couldn’t draw right now: ${errMsg(e)}`);
}
