// What a new bot is made with: the New bot dialog picks a look and a name, the rest is Settings' defaults for new
// bots, on an agent that can run. A bot is changed afterwards in its side panel (BotHero, BotPanel).
import { BOT_COLORS, BOT_SHAPES_V1, BotShape, type Bot, type Provider } from '@appubot/protocol';
import { newBotName } from '@appubot/chat-core';
import { getState } from '../../lib/store';

export interface BotForm {
  name: string;
  emoji: string;
  color: string;
  shape: BotShape;
  /** a custom character from the library ('' none: the shape) */
  characterId: string;
  job: string;
  instructions: string;
  providerId: string;
  /** '' is the agent's own default */
  modelId: string;
  effort: string;
  /** fast mode (Claude Code; applied where the model offers it) */
  fast: boolean;
  /** the permission mode ('' is the agent's own) */
  modeId: string;
  computerUse: boolean;
  /** a chief: may message every bot at once and leads its groups */
  chief: boolean;
  appsOff: string[];
  /** a team's cloud computer: whose logins it uses ('' = no one yet); only admins change it */
  memberId: string;
}

/** Settings' choices for new bots. */
export interface NewBotDefaults { providerId: string; modelId: string; effort: string; fast: boolean; modeId: string }

/** What the New bot dialog picked: a look, and a name when one was typed. */
export type BotDraft = Partial<Pick<BotForm, 'name' | 'shape' | 'color'>>;

/** Each built-in shape's name. */
export const SHAPE_LABEL: Record<BotShape, string> = {
  circle: 'Circle', squircle: 'Blob', square: 'Square', pill: 'Pill', triangle: 'Triangle', hex: 'Hexagon', cloud: 'Cloud', drop: 'Drop',
  egg: 'Egg', ghost: 'Ghost', flower: 'Flower', shield: 'Shield',
  octagon: 'Octagon', heart: 'Heart', diamond: 'Diamond', bell: 'Bell', mushroom: 'Mushroom', bear: 'Bear',
};

const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

/** A look of its own for a new bot: a shape and a colour, new each time. */
export const randomLook = (shapes: readonly BotShape[] = BOT_SHAPES_V1): Pick<BotForm, 'shape' | 'color'> => ({ shape: pick(shapes), color: pick(BOT_COLORS) });

/** The name a bot made without one gets ("New Bot", "New Bot 2"): its first chat asks what to call it. */
export const placeholderName = (): string => newBotName(getState().bots.map((b) => b.name));

export function initialForm(bot: Bot | undefined, defaults: NewBotDefaults): BotForm {
  return {
    // a new bot is ready to create as it opens: it asks what to call itself while it sets up
    name: bot?.name ?? placeholderName(),
    emoji: bot?.emoji ?? '🤖', // no longer edited here, but kept so older clients still show something
    color: bot?.color ?? pick(BOT_COLORS),
    shape: bot?.shape ?? pick(BOT_SHAPES_V1),
    characterId: bot?.characterId ?? '',
    job: bot?.job ?? '',
    instructions: bot?.instructions ?? '',
    providerId: bot?.providerId ?? defaults.providerId,
    // a new bot starts on Settings' defaults (the model only belongs to the default agent)
    modelId: bot ? (bot.modelId ?? '') : defaults.modelId,
    effort: bot?.effort ?? defaults.effort,
    fast: bot?.fast ?? defaults.fast,
    modeId: bot ? (bot.modeId ?? '') : defaults.modeId,
    computerUse: bot?.computerUse ?? true,
    chief: bot?.chief ?? false,
    appsOff: bot?.appsOff ?? [],
    memberId: bot?.memberId ?? '',
  };
}

/** A new bot's form on an agent that can run: Settings' default, else the first one installed and on (with its own default model). */
export function newBotForm(defaults: NewBotDefaults, providers: readonly Provider[], draft?: BotDraft): BotForm {
  const form = { ...initialForm(undefined, defaults), ...draft };
  const usable = providers.filter((p) => p.installed && p.enabled);
  if (usable.length && !usable.some((p) => p.id === form.providerId)) { form.providerId = usable[0]!.id; form.modelId = ''; }
  return form;
}

export const normalize = (f: BotForm): BotForm => ({ ...f, name: f.name.trim(), job: f.job.trim(), emoji: f.emoji.trim() || '🤖' });
