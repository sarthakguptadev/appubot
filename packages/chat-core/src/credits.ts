/**
 * Credits: whose work AppuBot is made with, for people to read (the desktop's Settings › About › Credits, the phone's
 * About) and for the notices file every build writes (apps/desktop/scripts/notices.mjs reads `credits.json` itself).
 * One list, so nothing is credited in one place and missed in another:
 *  - `code`: code or a design ported into AppuBot's own source (each ported file names where it came from);
 *  - `asset`: faces and icons the apps carry;
 *  - `service`: what the apps run on or talk to.
 * Only what is in the apps is listed: products whose ideas were merely studied are not named here (the owner's call).
 * A new port goes into `credits.json` as it is made. The speech models are credited from protocol `VOICE_MODELS`.
 */
import { VOICE_MODELS } from '@appubot/protocol';
import list from './credits.json';

export type CreditKind = 'code' | 'asset' | 'service';

export interface Credit {
  kind: CreditKind;
  name: string;
  /** who made it */
  by?: string;
  url?: string;
  /** what of it AppuBot uses, in plain words */
  used: string;
  /** its licence's name, where the app carries its code */
  license?: string;
  /** an MIT licence's copyright lines ("2026 Nick") */
  holders?: string[];
  /** a licence kept as a file of its own (apps/desktop/scripts/licenses) */
  licenseFile?: string;
}

export const CREDITS: Credit[] = list as Credit[];

export interface CreditGroup { kind: CreditKind | 'models'; title: string; line: string; credits: Credit[] }

/** A speech model as a credit: who made it and under which licence, linked to its model card. */
export function modelCredits(): Credit[] {
  return VOICE_MODELS.map((m) => ({
    kind: 'asset' as const, name: m.name, by: m.credit.by, url: m.credit.url, license: m.credit.license,
    used: m.kind === 'stt' ? 'Hears what you say.' : 'Reads replies aloud.',
  }));
}

/** The credits in the order they are shown, a group at a time; a group with nothing in it is left out. */
export function creditGroups(): CreditGroup[] {
  const of = (kind: CreditKind) => CREDITS.filter((c) => c.kind === kind);
  const groups: CreditGroup[] = [
    { kind: 'code', title: 'Built on', line: 'Code and designs ported into AppuBot. Each keeps its own licence.', credits: of('code') },
    { kind: 'service', title: 'Runs on', line: 'What the apps are built with and talk to.', credits: of('service') },
    { kind: 'asset', title: 'Fonts and icons', line: 'The logos of agents and apps are their owners’, shown only to name them.', credits: of('asset') },
    { kind: 'models', title: 'Speech models', line: 'Downloaded to your computer when you first use voice.', credits: modelCredits() },
  ];
  return groups.filter((g) => g.credits.length > 0);
}

/** "MIT · Nick": the small line under a credit's name. */
export function creditByline(c: Credit): string {
  return [c.by, c.license].filter(Boolean).join(' · ');
}

/** A credit's address without its scheme, as a link's words ("github.com/hardbeat920/monocode"). */
export function creditLinkText(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
}
