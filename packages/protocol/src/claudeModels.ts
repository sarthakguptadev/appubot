/**
 * Claude Code's model picker, the way Synara builds it: what Claude Code itself lists (Default and each family's
 * newest: Fable, Opus, Sonnet, Haiku, so a new model shows up by itself) plus a built-in catalog of the older
 * versions, the one in Synara's `packages/contracts/src/model.ts` (`claudeAgent`). AppuBot hands the catalog to Claude
 * Code as a `modelPicker` lineup in the settings every Claude session starts with (agent-runtime
 * `providerSessionMeta`, the adapter's `_meta.claudeCode.options.settings`: nothing is written to disk); Claude Code
 * adds those rows after its own, skips one its own rows already cover (Opus 5.5 is its `opus`) and drops one the
 * account can't use. `tidyModels` then puts the list in Synara's order. Needs Claude Code 2.1.242 or later (older
 * versions ignore the setting and list only their own rows).
 */
import { labelFreeModels } from './freeModels';
export const CLAUDE_MODEL_CATALOG: readonly { model: string; label: string }[] = [
  { model: 'claude-fable-5-1', label: 'Fable 5.1' },
  { model: 'claude-fable-5', label: 'Fable 5' },
  { model: 'claude-opus-5-5', label: 'Opus 5.5' },
  { model: 'claude-opus-5', label: 'Opus 5' },
  { model: 'claude-opus-4-8', label: 'Opus 4.8' },
  { model: 'claude-opus-4-7', label: 'Opus 4.7' },
  { model: 'claude-opus-4-6', label: 'Opus 4.6' },
  { model: 'claude-opus-4-5', label: 'Opus 4.5' },
  { model: 'claude-sonnet-5', label: 'Sonnet 5' },
  { model: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { model: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

/**
 * The settings a Claude Code session starts with: the catalog as extra picker rows after Claude Code's own; `keep`
 * narrows them (AppuBot AI: the Sonnet and Haiku rows the launch bonus pays for).
 */
export function claudeSessionSettings(keep: (model: string) => boolean = () => true): { modelPicker: { options: { model: string; label: string }[] } } {
  return { modelPicker: { options: CLAUDE_MODEL_CATALOG.filter((r) => keep(r.model)).map((r) => ({ ...r })) } };
}

const RAW_ID = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/;
/** Synara's order: strongest family first, newest version first within it */
const FAMILY_ORDER = ['fable', 'opus', 'sonnet', 'haiku'];

/** A Claude row's family and version, from its id (`claude-opus-4-6`) or, for a family alias (`opus`), its name ("Opus 5.5"). */
function claudeRank(m: { id: string; name: string }): { family: number; version: number } | undefined {
  const raw = RAW_ID.exec(m.id);
  const f = FAMILY_ORDER.indexOf(raw ? raw[1]! : m.id);
  if (f < 0) return undefined;
  const n = raw ? [raw[2], raw[3]] : (/(\d+)(?:\.(\d+))?/.exec(m.name)?.slice(1, 3) ?? []);
  return { family: f, version: Number(n[0] ?? 0) + Number(n[1] ?? 0) / 100 };
}

/**
 * Tidies a model list as an agent reports it. A row left unnamed (its name is still the raw id) gets one
 * (`claude-opus-4-6` → "Opus 4.6"). When the list is Claude's (it has family rows), the family rows go in Synara's
 * order (Fable, Opus, Sonnet, Haiku; newest first) after anything else (Default). Other agents' lists come back as
 * they are.
 */
export function tidyModels<T extends { id: string; name: string }>(models: T[]): T[] {
  // OpenCode's list: its free models named as such and first (`freeModels.ts`); nothing of Claude's is in it
  const labelled = labelFreeModels(models);
  if (labelled !== models) return labelled;
  const named = models.map((m) => {
    const r = m.name === m.id ? RAW_ID.exec(m.id) : null;
    if (!r) return m;
    const family = r[1]!.charAt(0).toUpperCase() + r[1]!.slice(1);
    return { ...m, name: `${family} ${r[2]}${r[3] ? `.${r[3]}` : ''}` };
  });
  const ranked = named.map((m, i) => ({ m, i, r: claudeRank(m) }));
  if (!ranked.some((x) => x.r)) return named;
  return ranked
    .sort((a, b) => {
      if (!a.r || !b.r) return a.r ? 1 : b.r ? -1 : a.i - b.i;
      return a.r.family - b.r.family || b.r.version - a.r.version || a.i - b.i;
    })
    .map((x) => x.m);
}

/** Claude Code's family aliases and the ids its picker uses for "Default" */
const ALIAS_NAMES: Record<string, string> = { default: 'Default', fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', opusplan: 'Opus Plan' };

/**
 * A model's name for people when the agent's own list doesn't name it (a model set before the list arrived, one the
 * account's list leaves out, AppuBot AI's `claude-haiku-5-5`): the catalog's label, else a Claude id read as its
 * family and version (`claude-haiku-5-5` → "Haiku 5.5", also with a date (`-20251001`), a `[1m]` context suffix or a
 * Bedrock/Vertex prefix), else a family alias ("sonnet" → "Sonnet"). Anything else comes back as given.
 */
export function modelDisplayName(id: string): string {
  const known = CLAUDE_MODEL_CATALOG.find((r) => r.model === id);
  if (known) return known.label;
  const wide = /\[1m\]$/i.test(id) ? ' (1M)' : '';
  const bare = id
    .replace(/\[1m\]$/i, '')
    .replace(/^(?:[a-z]{2,4}\.)?anthropic\./, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/@\d{8}$/, '')
    .replace(/-\d{8}$/, '');
  const alias = ALIAS_NAMES[bare];
  if (alias) return alias + wide;
  const raw = RAW_ID.exec(bare);
  if (raw && FAMILY_ORDER.includes(raw[1]!)) {
    const family = raw[1]!.charAt(0).toUpperCase() + raw[1]!.slice(1);
    return `${family} ${raw[2]}${raw[3] ? `.${raw[3]}` : ''}${wide}`;
  }
  return id;
}
