/**
 * The free agent (2026-11-14): OpenCode runs a set of models with no account and no key ("OpenCode Zen"'s free tier;
 * checked on OpenCode 2.0.22 and 2.3.0 with an empty home folder), so it is the agent a person with nothing signed in
 * starts on. This module is the one place that says which agent that is, which of its models cost nothing, what they
 * are called, and which one a chat starts on.
 *
 * What OpenCode sends: ids `opencode/<slug>` with names `opencode/<Name>` (`opencode/Big Pickle`,
 * `opencode/MiMo-V2.6-Flash Free`). A model the free tier covers has a name ending in "Free", or is one of the few
 * free ones named without it (`FREE_WITHOUT_MARK`). Anything else under `opencode/` is OpenCode's paid catalog.
 */
import { providerBase } from './util';

/** the agent that works with no account */
export const FREE_AGENT_ID = 'opencode';
/** how its sign-in reads when nothing is signed in (`Provider.auth.account`): the apps say "Ready", not "Logged in" */
export const FREE_MODELS_ACCOUNT = 'Free models';
/** the line under it */
export const FREE_MODELS_NOTE = 'No account needed';
/** its one-line description in agent lists */
export const FREE_AGENT_DESCRIPTION = 'Free models with no account, plus the model providers you sign in to.';

const PREFIX = 'opencode/';
/** free models whose name carries no "Free" */
const FREE_WITHOUT_MARK: ReadonlySet<string> = new Set(['opencode/big-pickle']);

/**
 * The models a chat on the free tier starts on, best first: the ones seen answering through AppuBot with no account
 * (2026-11-17: Big Pickle, GLM 5.3 Flash and DeepSeek V4.1 Flash each answered; MiniMax M3.1 Flash, on this list
 * since 2026-11-14, was gone: "model not found"; 2026-11-18 GLM 5.3 Flash was retired too: "Model glm-5.3-flash-free
 * has been deprecated. Use deepseek-v4.1-flash-free instead", while OpenCode's own catalog still listed it). OpenCode's
 * own pick isn't used, see `freeModelsToTry`. A model that leaves the free tier needs no release: see
 * `noteRetiredModel`.
 */
export const FREE_MODELS_PREFERRED: readonly string[] = [
  'opencode/big-pickle',
  'opencode/deepseek-v4.1-flash-free',
];

/**
 * Free models OpenCode's server no longer runs while its own catalog may still name them (checked against
 * `opencode.ai/zen/v1/models` on 2026-11-18). Every computer also learns these by itself from a turn's error
 * (`retiredModelError`), keeps them (`<dataDir>/retired-models.json`) and tells this module (`noteRetiredModel`), so a
 * model retired after a release drops out without one.
 */
const RETIRED_FREE_MODELS: readonly string[] = ['opencode/glm-5.3-flash-free', 'opencode/minimax-m3.1-flash-free'];
const retired = new Set<string>(RETIRED_FREE_MODELS);

/** a model that has left the free tier: never listed, never started on (ids are compared in lower case) */
export const isRetiredModel = (id: string | undefined): boolean => !!id && retired.has(id.trim().toLowerCase());
/** learn one (from a turn's error or the saved file); answers whether it was new */
export function noteRetiredModel(id: string): boolean {
  const key = id.trim().toLowerCase();
  if (!key.startsWith(PREFIX) || retired.has(key)) return false;
  retired.add(key);
  return true;
}
/** the ones learnt on this computer, for saving (not the shipped ones) */
export const learntRetiredModels = (): string[] => [...retired].filter((id) => !RETIRED_FREE_MODELS.includes(id));
/** a model list without the retired ones */
export const withoutRetired = <T extends { id: string }>(models: T[]): T[] => (models.some((m) => isRetiredModel(m.id)) ? models.filter((m) => !isRetiredModel(m.id)) : models);

/**
 * What a turn's error says about its model, for a chat on the free agent: `retired` when the server says the model
 * is gone for good (deprecated, no longer offered, not found, not supported), `unavailable` when it only can't answer
 * now (kept, never learnt as retired), else null. `instead` is the model the server names in its place ("Use
 * deepseek-v4.1-flash-free instead"), as an OpenCode id.
 */
export function retiredModelError(error: string | undefined): { kind: 'retired' | 'unavailable'; instead?: string } | null {
  const text = (error ?? '').trim();
  if (!text) return null;
  const gone = /has been deprecated|is deprecated|been retired|no longer (?:available|supported|offered|served)|model (?:is )?not supported|requested model is not supported|model not found|unknown model|model .{0,60} does not exist/i.test(text);
  const unavailable = !gone && /model is unavailable|model (?:is )?(?:temporarily )?unavailable|model .{0,60} is not available/i.test(text);
  if (!gone && !unavailable) return null;
  const named = /\buse ([a-z0-9][a-z0-9._\-/]*[a-z0-9]) instead/i.exec(text)?.[1]?.toLowerCase();
  const instead = named ? (named.startsWith(PREFIX) ? named : `${PREFIX}${named}`) : undefined;
  return { kind: gone ? 'retired' : 'unavailable', ...(instead ? { instead } : {}) };
}

export const isFreeAgent = (providerId: string | undefined): boolean => !!providerId && providerBase(providerId) === FREE_AGENT_ID;

/** whether this model of the free agent costs nothing (by its id, and its name when the id alone doesn't say) */
export function isFreeModel(providerId: string | undefined, id: string, name?: string): boolean {
  if (!isFreeAgent(providerId)) return false;
  const key = id.trim().toLowerCase();
  if (!key.startsWith(PREFIX)) return false;
  return freeById(key, name);
}

const freeById = (key: string, name?: string): boolean => FREE_WITHOUT_MARK.has(key) || /-free$/.test(key) || /\bfree\)?$/i.test((name ?? '').trim());

/**
 * A free agent's model as people read it: OpenCode's own provider prefix and the trailing "Free" come off (the apps
 * draw "Free" as a tag), so `opencode/MiMo-V2.6-Flash Free` is "MiMo-V2.6-Flash". A model with no name gets one from
 * its id. Models of other providers inside OpenCode (`github-copilot/…`) keep their names.
 */
export function freeModelName(id: string, name?: string): string {
  const given = (name ?? '').trim();
  let text = given && given !== id ? given : id.replace(/^[^/]+\//, '').replace(/-free$/i, '').split('-').map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ');
  if (text.toLowerCase().startsWith(PREFIX)) text = text.slice(PREFIX.length);
  return text.replace(/\s*\(free\)$/i, '').replace(/\s+free$/i, '').trim() || id;
}

/** how a free model's name ends in every list ("Big Pickle (Free)") */
export const FREE_MARK = ' (Free)';

/**
 * An OpenCode model list as people read it: its own models lose the `opencode/` in their names, the ones that cost
 * nothing end in "(Free)" (Big Pickle says so too, which OpenCode's own name doesn't) and lead the list, the ones a
 * chat starts on first. Other providers' models inside OpenCode, and every other agent's list, come back as they are.
 */
export function labelFreeModels<T extends { id: string; name: string }>(models: T[]): T[] {
  if (!models.some((m) => m.id.toLowerCase().startsWith(PREFIX))) return models;
  models = withoutRetired(models);
  const rank = (m: T): number => {
    const key = m.id.toLowerCase();
    if (!key.startsWith(PREFIX) || !freeById(key, m.name)) return FREE_MODELS_PREFERRED.length + 1;
    const i = FREE_MODELS_PREFERRED.indexOf(key);
    return i >= 0 ? i : FREE_MODELS_PREFERRED.length;
  };
  return models
    .map((m, i) => ({ m, i, r: rank(m) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ m }) => {
      const key = m.id.toLowerCase();
      if (!key.startsWith(PREFIX)) return m;
      const name = freeModelName(m.id, m.name);
      return { ...m, name: freeById(key, m.name) ? `${name}${FREE_MARK}` : name };
    });
}

/**
 * The models a chat on the free agent should try as it starts, best first, when it asked for none: it starts on a
 * free one whatever OpenCode itself picked (the owner's call, 2026-11-17: "it should pick a free one"). OpenCode's
 * own pick can't be trusted either way: a first start may list only the person's own providers and land on one of
 * theirs that doesn't answer (seen: `github-copilot/gemini-4-hydrogen`, refused by Copilot with "The requested model
 * is not supported", which failed the very first message of a new install), or on a model of its built-in catalog
 * that has left the free tier. A person who wants one of their own models picks it in the model picker, and a
 * picked model is never moved.
 *
 * The order: the preferred ones, then any other free model the session lists. Until OpenCode's own models are in
 * the list (the live one comes moments after the session), the preferred ones are tried unlisted: OpenCode takes a
 * model it knows and refuses one it doesn't ("model not found"), so the caller sets each in turn and keeps the
 * first that takes. Nothing to try when the chat is already on the best one, and only better ones than a free model
 * it is already on.
 */
export function freeModelsToTry(providerId: string | undefined, current: string | undefined, models: readonly { id: string; name?: string }[]): string[] {
  if (!isFreeAgent(providerId)) return [];
  const own = models.filter((m) => m.id.toLowerCase().startsWith(PREFIX) && !isRetiredModel(m.id));
  const listed = new Set(own.map((m) => m.id));
  const order = own.length
    ? [
      ...FREE_MODELS_PREFERRED.filter((id) => listed.has(id)),
      ...own.filter((m) => freeById(m.id.toLowerCase(), m.name) && !FREE_MODELS_PREFERRED.includes(m.id)).map((m) => m.id),
    ]
    : FREE_MODELS_PREFERRED.filter((id) => !isRetiredModel(id));
  const at = current && !isRetiredModel(current) ? order.indexOf(current) : -1;
  return at >= 0 ? order.slice(0, at) : order;
}

/**
 * What a chat on the free agent moves to when its model stopped answering (`retiredModelError`): the model the server
 * named in its place when it is a free one still running, else the best free model to try (`freeModelsToTry`), never
 * the one that failed. Null when there is none left to try.
 */
export function nextFreeModel(providerId: string | undefined, failed: string | undefined, models: readonly { id: string; name?: string }[], instead?: string): string | null {
  if (!isFreeAgent(providerId)) return null;
  const not = failed?.trim().toLowerCase();
  if (instead && instead !== not && !isRetiredModel(instead) && freeById(instead, models.find((m) => m.id === instead)?.name)) return instead;
  return freeModelsToTry(providerId, undefined, models).find((id) => id !== not) ?? null;
}
