/**
 * The pills under a bot's latest reply (2026-11-17, the owner's ask: "show more such pills, random, based on what the
 * user has done"): a few things to try next, picked from what this person hasn't done yet. Two kinds:
 *
 * - `ask`: words sent to the bot as a message ("Check in with me every morning"), so the bot does it itself (it can
 *   make routines, bots and groups, and reads the apps it has).
 * - `setup`: something set up in AppuBot (connect apps, pair a phone, Telegram, voice, a team...), opened by the app.
 *
 * Only what still makes sense is offered (no "Connect your phone" once one is paired), then a random few, the same
 * for one reply (`seed`: the reply's id) and others under the next one. Pure: the apps say what each one does.
 *
 * How many is random too (2026-11-26, the owner's "why fixed number everytime of pills it should be random"): two to
 * five, decided by the reply like the pick (`suggestionCount`), so a redraw or a restart shows the same row. When the
 * bot gave follow-ups of its own with that reply (followUps.ts), those come first and these fill up after them or step
 * aside (`pickPills`).
 */
import { cleanFollowUps, followUpKey } from './followUps';

export type SuggestionId =
  // asks
  | 'morning' | 'inbox-bot' | 'remember' | 'what-can-you-do' | 'plan-week' | 'inbox' | 'calendar' | 'slack'
  | 'github' | 'notion' | 'downloads' | 'find-file' | 'team-ask'
  // setups
  | 'apps' | 'phone' | 'telegram' | 'voice' | 'teach' | 'group' | 'import' | 'cloud';

export interface Suggestion {
  id: SuggestionId;
  kind: 'ask' | 'setup';
  /** what the pill reads, and for an ask also what is sent */
  label: string;
}

/** What is known about this person and bot; a fact not known yet (`undefined`) offers nothing about it. */
export interface SuggestionFacts {
  botName: string;
  /** bots on this computer, this one included */
  bots: number;
  /** this bot's routines */
  routines: number;
  /** groups on this computer; undefined where the computer has none to offer */
  groups?: number;
  /** a phone (iOS or Android) paired with this computer */
  phonePaired?: boolean;
  /** this bot answers on Telegram */
  telegram?: boolean;
  /** Apps (Composio) signed in */
  appsSignedIn?: boolean;
  /** the slugs of the apps connected and on for this bot */
  apps?: readonly string[];
  /** the slugs of every app connected, also those switched off for this bot; where unknown, `apps` stands in */
  connected?: readonly string[];
  /** this bot may use the computer, and the computer can (computer use is on) */
  computerUse?: boolean;
  /** voice mode can be used here */
  voice?: boolean;
  /** Teach mode is offered here */
  teach?: boolean;
  /** the cloud computer is offered to this person */
  cloudOffer?: boolean;
  /** the bot's memory has something in it */
  memory?: boolean;
}

export const SUGGESTIONS_MAX = 5;
export const SUGGESTIONS_MIN = 2;
/** how many of the app's own suggestions may sit beside a bot's follow-ups */
export const SUGGESTIONS_BESIDE_FOLLOW_UPS = 2;
/** the apps "Connect email & calendar" is about: with one of them connected it has nothing left to offer */
const MAIL_OR_CALENDAR = ['gmail', 'outlook', 'googlecalendar'];

/** Every suggestion that fits these facts, asks first, in a fixed order. */
export function eligibleSuggestions(f: SuggestionFacts): Suggestion[] {
  const ask = (id: SuggestionId, label: string): Suggestion => ({ id, kind: 'ask', label });
  const setup = (id: SuggestionId, label: string): Suggestion => ({ id, kind: 'setup', label });
  const apps = new Set(f.apps ?? []);
  const connected = f.connected ?? f.apps;
  const out: Suggestion[] = [];
  // asks
  if (f.routines === 0) out.push(ask('morning', 'Check in with me every morning'));
  if (f.bots < 4) out.push(ask('inbox-bot', 'Set up a bot for my inbox'));
  if (f.memory) out.push(ask('remember', 'What do you remember about me?'));
  out.push(ask('what-can-you-do', 'What can you do for me?'));
  out.push(ask('plan-week', 'Help me plan my week'));
  if (apps.has('gmail') || apps.has('outlook')) out.push(ask('inbox', 'What’s new in my inbox?'));
  if (apps.has('googlecalendar') || apps.has('outlook')) out.push(ask('calendar', 'What’s on my calendar today?'));
  if (apps.has('slack')) out.push(ask('slack', 'Catch me up on Slack'));
  if (apps.has('github')) out.push(ask('github', 'What changed on GitHub today?'));
  if (apps.has('notion')) out.push(ask('notion', 'Find my notes in Notion'));
  if (f.computerUse) {
    out.push(ask('downloads', 'Tidy up my Downloads folder'));
    out.push(ask('find-file', 'Find a file for me'));
  }
  if (f.groups !== undefined && f.groups === 0 && f.bots >= 2) out.push(ask('team-ask', 'Put my bots in a group'));
  // setups
  // not once mail or a calendar is connected, even when it is switched off for this bot
  if (f.appsSignedIn === false || (f.appsSignedIn && connected !== undefined && !MAIL_OR_CALENDAR.some((slug) => connected.includes(slug)))) out.push(setup('apps', 'Connect email & calendar'));
  if (f.phonePaired === false) out.push(setup('phone', 'Connect your phone'));
  if (f.telegram === false) out.push(setup('telegram', `Talk to ${f.botName} on Telegram`));
  if (f.voice) out.push(setup('voice', `Talk to ${f.botName} out loud`));
  if (f.teach && f.computerUse) out.push(setup('teach', `Show ${f.botName} a task`));
  if (f.groups !== undefined && f.groups === 0 && f.bots >= 2) out.push(setup('group', 'Make a group of bots'));
  if (f.bots <= 2) out.push(setup('import', 'Bring in my bots'));
  if (f.cloudOffer) out.push(setup('cloud', 'Keep my bots working 24/7'));
  // "Put my bots in a group" and "Make a group of bots" are one idea: only one of them is ever picked (pickSuggestions)
  return out;
}

/** A small number from a string (FNV-1a), what `random` starts from. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** mulberry32: the same numbers for the same seed */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ideas that say the same thing: never two of one. */
const SAME: Partial<Record<SuggestionId, SuggestionId>> = { 'team-ask': 'group', group: 'team-ask', inbox: 'inbox-bot', 'inbox-bot': 'inbox' };

/** The same number between 0 and 1 for the same words. */
const draw = (words: string): number => random(hash(words))();

/** How many suggestions sit under the reply `seed` names: two to five, the same every time it is asked. */
export function suggestionCount(seed: string): number {
  return SUGGESTIONS_MIN + Math.floor(draw(`${seed}#count`) * (SUGGESTIONS_MAX - SUGGESTIONS_MIN + 1));
}

/**
 * A random few of the eligible ones for this `seed` (the reply they sit under), at most `max`: two or three asks and
 * the rest setups, asks first, nothing in `hide` (put away, or already done this run) and no ask whose words are in
 * `said` (`followUpKey`s: what the person already sent in this chat, what the bot offers itself).
 *
 * Each suggestion has its own place in the order for a seed, whatever else is eligible: a fact learnt a moment later
 * (the apps' list arriving) moves one pill in or out and leaves the others where they were.
 */
export function pickSuggestions(f: SuggestionFacts, seed: string, max = SUGGESTIONS_MAX, hide: ReadonlySet<SuggestionId> = new Set(), said: ReadonlySet<string> = new Set()): Suggestion[] {
  if (max <= 0) return [];
  const place = new Map<SuggestionId, number>();
  const ordered = (list: Suggestion[]): Suggestion[] => {
    for (const s of list) place.set(s.id, draw(`${seed}:${s.id}`));
    return [...list].sort((a, b) => place.get(a.id)! - place.get(b.id)! || (a.id < b.id ? -1 : 1));
  };
  const all = eligibleSuggestions(f).filter((s) => !hide.has(s.id) && !(s.kind === 'ask' && said.has(followUpKey(s.label))));
  const asks = ordered(all.filter((s) => s.kind === 'ask'));
  const setups = ordered(all.filter((s) => s.kind === 'setup'));
  const wantAsks = Math.min(asks.length, Math.max(max - setups.length, Math.ceil(max / 2)));
  const picked: Suggestion[] = [];
  const taken = new Set<SuggestionId>();
  const take = (s: Suggestion) => {
    const twin = SAME[s.id];
    if (taken.has(s.id) || (twin && taken.has(twin))) return false;
    picked.push(s); taken.add(s.id);
    return true;
  };
  for (const s of asks) { if (picked.length >= wantAsks) break; take(s); }
  for (const s of setups) { if (picked.length >= max) break; take(s); }
  for (const s of asks) { if (picked.length >= max) break; take(s); }
  return [...picked.filter((s) => s.kind === 'ask'), ...picked.filter((s) => s.kind === 'setup')];
}

/**
 * The pills under one reply: the bot's own follow-ups first (`followUps`, as it gave them; cleaned here), then the
 * app's suggestions. Without follow-ups the reply's own count of suggestions (`suggestionCount`); with them, what is
 * left of that count, at most `SUGGESTIONS_BESIDE_FOLLOW_UPS`, so a bot that gave enough has the row to itself.
 * `room`: how many pills the row may hold in all. `sent`: what the person wrote in this chat, so nothing they
 * already asked is offered again.
 */
export function pickPills(o: {
  facts: SuggestionFacts;
  seed: string;
  room?: number;
  hide?: ReadonlySet<SuggestionId>;
  followUps?: readonly string[];
  sent?: readonly string[];
}): { followUps: string[]; suggestions: Suggestion[] } {
  const room = o.room ?? SUGGESTIONS_MAX;
  const followUps = cleanFollowUps(o.followUps ?? []).slice(0, Math.max(0, room));
  const count = suggestionCount(o.seed);
  const own = followUps.length ? Math.min(SUGGESTIONS_BESIDE_FOLLOW_UPS, count - followUps.length) : count;
  const said = new Set([...followUps, ...(o.sent ?? [])].map(followUpKey));
  return { followUps, suggestions: pickSuggestions(o.facts, o.seed, Math.min(own, room - followUps.length), o.hide, said) };
}
