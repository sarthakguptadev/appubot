/**
 * Settings › Transfer, the plan and its run (pure: no React, no gateway; `TransferIo` is the two computers). One way
 * only: bots, their memory and skills, and the Mac's shared skills go from this Mac to an AppuBot computer, never back.
 *
 * Planning: each picked Mac bot becomes a bundle of the parts picked (`include`). A bot of the same name already on the
 * cloud computer is a clash the person settles: skip it, replace it (the new one comes in first, then the old one goes,
 * so a failure never leaves neither) or import it as a copy under a free name. Shared skills go into the bundles of the
 * bots carried now and, if asked, into the bots already there (`skills.save`: SKILL.md only).
 *
 * Running: one item at a time, each step remembered in its `ItemState`, so Try again carries on where it stopped and
 * never makes a second bot: an import whose answer got lost is found again by its new id and name before anything is
 * sent twice; a replaced bot's removal and a skill already saved aren't done again.
 *
 * Size: a bundle goes as one upload, and the computer it goes to says how big one may be (`SystemInfo.transfer`;
 * `transferLimit`: a computer from before took 300 MB). A bot too big to send whole starts with its heaviest parts left
 * out (`fitInclude`, `BotPick.trimmed`, said on its row), and a refusal for size reads as words (`sizeRefusalText`).
 *
 * Groups (2026-11-15): this Mac's groups come after the bots, made there with `groups.create`/`update` from the
 * members that will be there: the bots this run brings (their new ids, `landed`) or bots of the same name already
 * there. A group none of whose bots will be there waits (`Plan.held`), one with only some comes with those and says
 * who stayed behind. Its room comes too where the computer takes it (`groups.restore`, `roomForTarget`), else it starts
 * empty and says so. A group whose name is there starts unticked, as bots do.
 */
import { BOT_EXPORT_PARTS, GROUP_RESTORE_CHARS_MAX, GROUP_RESTORE_CHATS_MAX, TRANSFER_BUNDLE_MAX, type BotExportInclude, type BotExportIncluded, type BotExportPart, type BotImportResult, type Exportable, type ExportableBot, type FileAttachment, type Group, type GroupMessage, type GroupRestoreChat, type SharedSkillText } from '@appubot/protocol';

export type ConflictChoice = 'skip' | 'replace' | 'copy';
export type Include = Required<BotExportInclude>;

/**
 * What comes over unless the person changes it: all of the bot, its chats too (since 2026-11-14, the owner's call: a
 * bot that arrives without its chats reads as a new one). Routines arrive switched off, so they never run twice.
 */
export const DEFAULT_INCLUDE: Include = { memory: true, skills: true, files: true, routines: true, chats: true };

/** the parts dropped first when a whole bot is over the limit: the heavy ones, never its memory or skills */
const HEAVY_PARTS: readonly (keyof Include)[] = ['chats', 'files'];

/** Everything of a bot that fits one bundle: all of it, less its heaviest parts (the bigger first) when it is over `limit`. */
export function fitInclude(item: ExportableBot, limit = TRANSFER_BUNDLE_MAX): Include {
  const include = { ...DEFAULT_INCLUDE };
  const heavy = [...HEAVY_PARTS].sort((a, b) => item[b as 'chats' | 'files'].bytes - item[a as 'chats' | 'files'].bytes);
  for (const part of heavy) {
    if (estimateBytes(item, include) <= limit) break;
    include[part] = false;
  }
  return include;
}

export interface BotPick {
  selected: boolean; include: Include; conflict: ConflictChoice;
  /** the parts left out because the whole bot is too big to send at once (`fitInclude`): its row says so */
  trimmed?: ('chats' | 'files')[];
}
export function defaultPick(): BotPick { return { selected: false, include: { ...DEFAULT_INCLUDE }, conflict: 'copy' }; }

/**
 * The picks a page opens with: every bot ticked with all of it, opened so its parts show. A bot whose name is already
 * there starts unticked (ticking it by default would make a second copy on every visit), and one too big to send whole
 * leaves its heaviest part out (`fitInclude`, kept in `trimmed`).
 */
export function defaultPicks(mac: Exportable, cloudBots: CloudBotRef[], limit = TRANSFER_BUNDLE_MAX): Record<string, BotPick> {
  return Object.fromEntries(mac.bots.map((item) => {
    const include = fitInclude(item, limit);
    const trimmed = HEAVY_PARTS.filter((p) => !include[p]) as ('chats' | 'files')[];
    return [item.bot.id, { selected: !findClash(item.bot.name, cloudBots), include, conflict: 'copy' as const, ...(trimmed.length ? { trimmed } : {}) }];
  }));
}

/**
 * Why a part of this bot is off, when it is off for size (`BotPick.trimmed`): "Its chat history (203 MB) stays on this
 * Mac: with it, Ada is too big to send at once (your AppuBot computer takes 296 MB at a time)." Null when nothing was
 * left out for size, or the person ticked it back.
 */
export function trimmedText(item: ExportableBot, pick: BotPick, limit: number, o: { target: string; machine?: string }): string | null {
  const off = (pick.trimmed ?? []).filter((p) => !pick.include[p]);
  if (!off.length) return null;
  const words = off.map((p) => `${p === 'chats' ? 'chat history' : 'files'} (${mb(item[p].bytes)})`);
  const what = words.length === 1 ? words[0]! : `${words[0]} and ${words[1]}`;
  const verb = off.length === 1 && off[0] === 'chats' ? 'stays' : 'stay';
  return `Its ${what} ${verb} on this ${o.machine ?? 'Mac'}: with ${off.length === 1 && off[0] === 'chats' ? 'it' : 'them'}, ${item.bot.name} is too big to send at once (${o.target} takes ${mb(limit)} at a time).`;
}

/**
 * A computer refusing a bundle for its size reads as what happened and what to do, never "request too large" (its
 * channel's words) or "Upload failed (413)" (its gateway's); null for any other failure.
 */
export function sizeRefusalText(e: unknown, o: { name: string; bytes: number; target: string }): string | null {
  if (!/request too large|too large|\(413\)/i.test(messageOf(e))) return null;
  return `${o.name}’s bundle (${mb(o.bytes)}) is more than ${o.target} takes at once. Leave out its chat history or files (untick them) and try again.`;
}

/** The shared skills a page opens with: all of them, into the bots that come (none when no bot is ticked: skills live in bots there). */
export function defaultShared(mac: Exportable, picks: Record<string, BotPick | undefined>): SharedPick {
  const some = mac.bots.some((b) => picks[b.bot.id]?.selected);
  return { names: some ? mac.sharedSkills.map((s) => s.name) : [], toImported: true, toExisting: false };
}

/**
 * A bot with something of the person's in it: a chat, a skill or a routine. A computer's first bot nobody has talked
 * to isn't worth offering (the cloud computer has one of its own).
 */
export function worthBringing(item: ExportableBot): boolean {
  return item.chats.messages > 0 || item.skills.names.length > 0 || item.routines.count > 0;
}

export interface SharedPick {
  names: string[];
  /** into the bots carried in this run (their bundles: the skill's whole folder) */
  toImported: boolean;
  /** into the bots already on the cloud computer (SKILL.md only) */
  toExisting: boolean;
}

export interface CloudBotRef { id: string; name: string }

/** bot names compare as people read them: case, spacing and curly quotes aside */
export function nameKey(name: string): string {
  return name.normalize('NFKC').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}
export function findClash(name: string, cloudBots: CloudBotRef[]): CloudBotRef | undefined {
  const k = nameKey(name);
  return cloudBots.find((b) => nameKey(b.name) === k);
}

/** "Ada (copy)", then "Ada (copy 2)"… whichever no bot there (or earlier in this run) has */
export function copyName(name: string, taken: Iterable<string>): string {
  const keys = new Set([...taken].map(nameKey));
  const base = name.trim();
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${base} (copy)` : `${base} (copy ${n})`;
    if (!keys.has(nameKey(candidate))) return candidate;
  }
}

/** how big its bundle will be, near enough: its setup plus each part picked (zip compression ignored: an upper bound) */
const SETUP_BYTES = 8 * 1024;
export function estimateBytes(item: ExportableBot, include: Include): number {
  return SETUP_BYTES
    + (include.memory ? item.memory.bytes : 0)
    + (include.skills ? item.skills.bytes : 0)
    + (include.files ? item.files.bytes : 0)
    + (include.chats ? item.chats.bytes : 0);
}

export type PlanItem =
  | { kind: 'bot'; key: string; macBotId: string; macName: string; name: string; mode: 'new' | 'replace' | 'copy'; replaceId?: string; replaceName?: string; include: Include; sharedSkills: string[]; bytes: number; tooBig: boolean; /** the biggest bundle the computer takes (absent: `TRANSFER_BUNDLE_MAX`) */ limit?: number }
  | { kind: 'skip'; key: string; macBotId: string; macName: string; clashName: string }
  | { kind: 'skills'; key: 'shared-skills'; names: string[]; cloudBotIds: string[] }
  | GroupPlanItem;

/** A member of a group as it will be there: a bot this run brings (`run`, its id once it lands) or one there already. */
export interface GroupMemberPlan { macBotId: string; name: string; via: 'run' | 'there'; cloudBotId?: string }

/** One of this Mac's groups, to be made there. */
export interface GroupPlanItem {
  kind: 'group'; key: string; macGroupId: string; macName: string;
  /** its name there (a copy's when the name is taken) */
  name: string;
  members: GroupMemberPlan[];
  /** members that won't be there (their names): it comes without them */
  missing: string[];
  /** its lead on this Mac, when that bot will be there */
  leadMacId?: string;
  /** the agent, model and effort every member answers it on, when it picks one */
  setup?: { providerId: string; modelId?: string; effort?: string };
  /** its room comes too (the computer takes it) */
  room: boolean;
}

export interface GroupPick { selected: boolean }

export interface Plan {
  items: PlanItem[];
  /** what stops it (each a sentence); empty = ready, once there's something to do */
  problems: string[];
  /** groups ticked that can't come this run, by their id here: why, in words (they don't stop the rest) */
  held: Record<string, string>;
  ready: boolean;
}

/** The groups part of a plan: this Mac's groups, the ones there now, the picks, and whether the computer takes a room. */
export interface GroupsInput {
  mac: Group[];
  cloud: CloudBotRef[];
  picks: Record<string, GroupPick | undefined>;
  /** the computer takes a group's room (`SystemInfo.transfer.groupRooms`) */
  rooms: boolean;
  /** every bot on this Mac by id (a member a page leaves out of its list still has a name) */
  macBots: CloudBotRef[];
}

/** The groups a page opens with: every one ticked, but one whose name is already there (a second visit makes no copies). */
export function defaultGroupPicks(mac: Group[], cloud: CloudBotRef[]): Record<string, GroupPick> {
  return Object.fromEntries(mac.map((g) => [g.id, { selected: !findClash(g.name, cloud) }]));
}

/** The run a selection makes, in the Mac's order, then the shared skills for the bots already there, then the groups. */
export function planTransfer(o: { mac: Exportable; cloudBots: CloudBotRef[]; picks: Record<string, BotPick | undefined>; shared: SharedPick; limit?: number; groups?: GroupsInput }): Plan {
  const limit = o.limit ?? TRANSFER_BUNDLE_MAX;
  const items: PlanItem[] = [];
  const problems: string[] = [];
  const known = new Set(o.mac.sharedSkills.map((s) => s.name));
  const sharedNames = o.shared.names.filter((n) => known.has(n));
  // names taken there, as this run goes: the cloud's own, then each bot this run brings
  const taken = o.cloudBots.map((b) => b.name);
  const replaced = new Set<string>();
  for (const item of o.mac.bots) {
    const pick = o.picks[item.bot.id];
    if (!pick?.selected) continue;
    const macName = item.bot.name;
    const clash = findClash(macName, o.cloudBots);
    const key = `bot:${item.bot.id}`;
    let mode: 'new' | 'replace' | 'copy' = 'new';
    let name = macName;
    let replaceId: string | undefined;
    let replaceName: string | undefined;
    if (clash) {
      if (pick.conflict === 'skip') { items.push({ kind: 'skip', key, macBotId: item.bot.id, macName, clashName: clash.name }); continue; }
      if (pick.conflict === 'replace' && !replaced.has(clash.id)) { mode = 'replace'; replaceId = clash.id; replaceName = clash.name; replaced.add(clash.id); }
      else { mode = 'copy'; name = copyName(macName, taken); }
    } else if (findClash(macName, taken.map((n, i) => ({ id: String(i), name: n })))) {
      // two Mac bots of one name: the second comes as a copy
      mode = 'copy';
      name = copyName(macName, taken);
    }
    taken.push(name);
    const bytes = estimateBytes(item, pick.include);
    const tooBig = bytes > limit;
    if (tooBig) problems.push(`${macName} is too big to send at once (${mb(bytes)}, ${mb(limit)} at most): leave out its ${biggestPart(item, pick.include)}.`);
    items.push({ kind: 'bot', key, macBotId: item.bot.id, macName, name, mode, ...(replaceId ? { replaceId, replaceName } : {}), include: { ...pick.include }, sharedSkills: o.shared.toImported ? sharedNames : [], bytes, tooBig, limit });
  }
  if (sharedNames.length) {
    const cloudBotIds = o.shared.toExisting ? o.cloudBots.filter((b) => !replaced.has(b.id)).map((b) => b.id) : [];
    if (cloudBotIds.length) items.push({ kind: 'skills', key: 'shared-skills', names: sharedNames, cloudBotIds });
    const carried = o.shared.toImported && items.some((i) => i.kind === 'bot');
    if (!carried && !cloudBotIds.length) problems.push('Skills live in bots there: pick a bot to bring, or give them to the bots already there.');
  }
  const held: Record<string, string> = {};
  if (o.groups) items.push(...planGroups(o.groups, items, o.cloudBots, held));
  const work = items.some((i) => i.kind !== 'skip');
  return { items, problems, held, ready: work && problems.length === 0 };
}

/**
 * Each ticked group as it will be made there: its members mapped to the bots this run brings (by the plan's bot items)
 * or to bots of the same name there already; the ones neither are `missing`. A group with none at all can't be made (a
 * group needs a bot): it goes into `held` with why. A name taken there makes a copy's name.
 */
function planGroups(g: GroupsInput, botItems: PlanItem[], cloudBots: CloudBotRef[], held: Record<string, string>): GroupPlanItem[] {
  const out: GroupPlanItem[] = [];
  const brought = new Map<string, Extract<PlanItem, { kind: 'bot' }>>();
  for (const i of botItems) if (i.kind === 'bot') brought.set(i.macBotId, i);
  const macName = new Map(g.macBots.map((b) => [b.id, b.name]));
  const taken = g.cloud.map((x) => x.name);
  for (const group of g.mac) {
    if (!g.picks[group.id]?.selected) continue;
    const members: GroupMemberPlan[] = [];
    const missing: string[] = [];
    for (const id of group.botIds) {
      const name = macName.get(id);
      if (name === undefined) continue; // gone from this Mac: it isn't in the group here either
      const run = brought.get(id);
      if (run) { members.push({ macBotId: id, name: run.name, via: 'run' }); continue; }
      // a bot left behind (or skipped for its name) that has a namesake there: that one stands in
      const there = findClash(name, cloudBots);
      if (there) members.push({ macBotId: id, name: there.name, via: 'there', cloudBotId: there.id });
      else missing.push(name);
    }
    if (!members.length) {
      held[group.id] = missing.length
        ? `None of its bots will be there: bring ${listNames(missing, 'or')} with it.`
        : 'It has no bots to bring.';
      continue;
    }
    const name = findClash(group.name, taken.map((n, k) => ({ id: String(k), name: n }))) ? copyName(group.name, taken) : group.name;
    taken.push(name);
    const leadMacId = group.leadId && members.some((m) => m.macBotId === group.leadId) ? group.leadId : undefined;
    out.push({
      kind: 'group', key: `group:${group.id}`, macGroupId: group.id, macName: group.name, name, members, missing,
      ...(leadMacId ? { leadMacId } : {}),
      ...(group.providerId ? { setup: { providerId: group.providerId, ...(group.modelId ? { modelId: group.modelId } : {}), ...(group.effort ? { effort: group.effort } : {}) } } : {}),
      room: g.rooms,
    });
  }
  return out;
}

/** "Ada", "Ada and Ben", "Ada, Ben and Cy" (`or`: "Ada or Ben") */
export function listNames(names: string[], joiner: 'and' | 'or' = 'and'): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ${joiner} ${names[names.length - 1]}`;
}

/** what a group brings, in a line for its row before it runs */
export function groupPlanText(item: GroupPlanItem, target: string): string {
  const lead = item.members.find((m) => m.macBotId === item.leadMacId);
  let text = `With ${listNames(item.members.map((m) => m.name))}${lead ? ` (${lead.name} leads)` : ''}${item.setup ? ', on the model it picked' : ''}. `;
  text += item.room ? 'Its chat history comes too.' : `Its chat history stays here: ${target} can’t take it yet, so the room starts empty.`;
  if (item.missing.length) text += ` ${listNames(item.missing)} ${item.missing.length === 1 ? 'isn’t' : 'aren’t'} coming, so ${item.missing.length === 1 ? 'it stays' : 'they stay'} out of it.`;
  return text;
}

function mb(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}
function biggestPart(item: ExportableBot, include: Include): string {
  const sizes: [string, number][] = [['chats', include.chats ? item.chats.bytes : 0], ['files', include.files ? item.files.bytes : 0], ['skills', include.skills ? item.skills.bytes : 0], ['memory', include.memory ? item.memory.bytes : 0]];
  return sizes.sort((a, b) => b[1] - a[1])[0]![0];
}

/* ------------------------------------------------------------------ running */

/** The two computers, as the run needs them (the page wires the Mac's gateway and the cloud's channel in). */
export interface TransferIo {
  /** the Mac packs one bot (`bots.export`) */
  exportBot(macBotId: string, include: Include, sharedSkills: string[]): Promise<{ file: FileAttachment; included?: BotExportIncluded }>;
  /** the bundle from the Mac to the cloud (download there, upload here): the cloud's file id; `name`: the bot's, for the words */
  carry(file: FileAttachment, name: string): Promise<{ id: string }>;
  /** the cloud unpacks it (`bots.import`) */
  importBot(fileId: string, name: string): Promise<BotImportResult>;
  /** the bots the cloud computer has now */
  cloudBots(): Promise<CloudBotRef[]>;
  deleteCloudBot(id: string): Promise<void>;
  /** a shared skill's SKILL.md from the Mac (`skills.getShared`) */
  sharedSkill(name: string): Promise<SharedSkillText>;
  /** into a bot there (`skills.save`) */
  saveSkill(botId: string, name: string, description: string, body: string): Promise<void>;
  /** the groups the cloud computer has now */
  cloudGroups?(): Promise<CloudBotRef[]>;
  /** makes a group there (`groups.create`): its id */
  createGroup?(p: { name: string; botIds: string[]; leadId?: string }): Promise<{ id: string }>;
  /** the agent, model and effort its members answer it on (`groups.update`) */
  setGroupModel?(id: string, setup: { providerId: string; modelId?: string; effort?: string }): Promise<void>;
  /** a group's room on this Mac: each of its threads, oldest first, with all its messages (`groups.history`) */
  macRoom?(macGroupId: string): Promise<MacRoomChat[]>;
  /** puts a room into a group made there (`groups.restore`) */
  restoreRoom?(id: string, fromId: string, chats: GroupRestoreChat[]): Promise<void>;
}

/** one of a group's threads on this Mac, as `macRoom` reads it */
export interface MacRoomChat { id: string; title: string; createdAt: number; messages: GroupMessage[] }

export type ItemStep = 'packing' | 'sending' | 'unpacking' | 'replacing' | 'skills' | 'group' | 'room';
export interface ItemState {
  status: 'waiting' | 'running' | 'done' | 'skipped' | 'failed';
  step?: ItemStep;
  error?: string;
  /** the cloud's bot ids just before this item's first import call (to tell its bot from the rest) */
  before?: string[];
  /** an import call went out: its bot may be there already */
  attempted?: boolean;
  /** the bot made there */
  botId?: string;
  result?: BotImportResult;
  /** the clashing bot is gone */
  replaced?: boolean;
  /** `<botId>/<skill>` already saved there */
  saved?: string[];
  /** a group: the one made there, its model set, its room in */
  groupId?: string;
  groupSet?: boolean;
  roomDone?: boolean;
  notes: string[];
}

export function initialState(item: PlanItem): ItemState {
  return { status: item.kind === 'skip' ? 'skipped' : 'waiting', notes: [] };
}

export const STEP_WORDS: Record<ItemStep, string> = { packing: 'Packing on your Mac…', sending: 'Sending…', unpacking: 'Unpacking there…', replacing: 'Removing the old one…', skills: 'Adding skills…', group: 'Making the group there…', room: 'Bringing its chat history…' };

/** an error the computer answered with this code (GatewayError's `code`) */
function codeOf(e: unknown): string | undefined {
  return e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string' ? (e as { code: string }).code : undefined;
}
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === 'string' ? e : 'Something went wrong.';
}

/** the bot this item's import made, if it is there: a new id since `before`, by the name it was given */
export function landedBot(list: CloudBotRef[], before: string[], name: string): CloudBotRef | undefined {
  const had = new Set(before);
  const k = nameKey(name);
  return list.find((b) => !had.has(b.id) && nameKey(b.name) === k);
}

/** what the Mac packed is what was asked for (an AppuBot on the Mac from before packs everything and says nothing) */
export function includedMatches(asked: Include, sharedSkills: string[], included: BotExportIncluded | undefined): boolean {
  if (!included) return false;
  if (BOT_EXPORT_PARTS.some((p: BotExportPart) => included[p] !== asked[p])) return false;
  return included.sharedSkills.every((s) => sharedSkills.includes(s));
}

export const OLD_MAC_TEXT = 'AppuBot on this Mac needs a restart to send only what you picked (Settings › About). Nothing was sent.';

/**
 * Runs one item from where its state stopped; `update` hears every change. Resolves with the final state (never
 * throws: a failure is `status: 'failed'` with what went wrong, and running it again carries on).
 */
export async function runItem(item: PlanItem, prev: ItemState, io: TransferIo, update: (s: ItemState) => void, skillTexts = new Map<string, SharedSkillText>(), landed: Record<string, string> = {}): Promise<ItemState> {
  let s: ItemState = { ...prev, status: 'running', error: undefined };
  const set = (patch: Partial<ItemState>) => { s = { ...s, ...patch }; update(s); };
  if (item.kind === 'skip') { set({ status: 'skipped' }); return s; }
  if (prev.status === 'done' || prev.status === 'skipped') return prev;
  update(s);
  try {
    if (item.kind === 'bot') await runBot(item, () => s, set, io);
    else if (item.kind === 'group') await runGroup(item, () => s, set, io, landed);
    else await runSkills(item, () => s, set, io, skillTexts);
    set({ status: 'done', step: undefined });
  } catch (e) {
    set({ status: 'failed', error: messageOf(e) });
  }
  return s;
}

async function runBot(item: Extract<PlanItem, { kind: 'bot' }>, get: () => ItemState, set: (p: Partial<ItemState>) => void, io: TransferIo): Promise<void> {
  if (!get().botId) {
    // a call that went out before may have made it: find it rather than make another
    if (get().attempted && get().before) {
      const there = landedBot(await io.cloudBots(), get().before!, item.name);
      if (there) set({ botId: there.id, notes: [...get().notes, `${item.name} came over (its answer got lost on the way, so the details aren’t shown).`] });
    }
  }
  if (!get().botId) {
    set({ step: 'packing' });
    const packed = await io.exportBot(item.macBotId, item.include, item.sharedSkills);
    if (!includedMatches(item.include, item.sharedSkills, packed.included)) throw new Error(OLD_MAC_TEXT);
    const limit = item.limit ?? TRANSFER_BUNDLE_MAX;
    if (packed.file.size > limit) throw new Error(`${item.macName}’s bundle came to ${mb(packed.file.size)}, more than the ${mb(limit)} that can go at once: leave out its chat history or files (untick them) and try again.`);
    set({ step: 'sending' });
    const up = await io.carry(packed.file, item.macName);
    set({ step: 'unpacking', before: (await io.cloudBots()).map((b) => b.id), attempted: true });
    try {
      const result = await io.importBot(up.id, item.name);
      set({ botId: result.bot.id, result, notes: [...get().notes, ...result.notes] });
    } catch (e) {
      // the answer may be what failed: look before calling it a failure
      const there = await io.cloudBots().then((l) => landedBot(l, get().before!, item.name)).catch(() => undefined);
      if (!there) throw e;
      set({ botId: there.id });
    }
  }
  if (item.mode === 'replace' && item.replaceId && !get().replaced) {
    set({ step: 'replacing' });
    try { await io.deleteCloudBot(item.replaceId); } catch (e) {
      if (codeOf(e) !== 'not_found') throw new Error(`${item.name} came over, but the one that was there couldn’t be removed: ${messageOf(e)}`);
    }
    set({ replaced: true });
  }
}

async function runSkills(item: Extract<PlanItem, { kind: 'skills' }>, get: () => ItemState, set: (p: Partial<ItemState>) => void, io: TransferIo, texts: Map<string, SharedSkillText>): Promise<void> {
  set({ step: 'skills' });
  const there = new Set((await io.cloudBots()).map((b) => b.id));
  for (const name of item.names) {
    let text = texts.get(name);
    if (!text) { text = await io.sharedSkill(name); texts.set(name, text); }
    if (text.files > 1 && !get().notes.some((n) => n.includes(`“${name}”`))) set({ notes: [...get().notes, `“${name}” has ${text.files - 1} more file${text.files === 2 ? '' : 's'} besides its instructions: only the instructions went to the bots already there (bots you bring get the whole skill).`] });
    for (const botId of item.cloudBotIds) {
      const key = `${botId}/${name}`;
      if (get().saved?.includes(key) || !there.has(botId)) continue;
      await io.saveSkill(botId, name, text.description, text.body);
      set({ saved: [...(get().saved ?? []), key] });
    }
  }
}

/** the members' ids there: this run's landed bots (by their id here), else the namesakes that were there */
async function memberIds(item: GroupPlanItem, io: TransferIo, landed: Record<string, string>): Promise<{ ids: Map<string, string>; lost: string[] }> {
  const there = new Set((await io.cloudBots()).map((b) => b.id));
  const ids = new Map<string, string>();
  const lost: string[] = [];
  for (const m of item.members) {
    const id = m.via === 'run' ? landed[m.macBotId] : m.cloudBotId;
    if (id && there.has(id)) ids.set(m.macBotId, id);
    else lost.push(m.name);
  }
  return { ids, lost };
}

/** the group this item's create made, if it is there: a new id since `before`, by its name */
function landedGroup(list: CloudBotRef[], before: string[], name: string): CloudBotRef | undefined { return landedBot(list, before, name); }

async function runGroup(item: GroupPlanItem, get: () => ItemState, set: (p: Partial<ItemState>) => void, io: TransferIo, landed: Record<string, string>): Promise<void> {
  if (!io.cloudGroups || !io.createGroup) throw new Error('Groups can’t be brought to this computer.');
  const { ids, lost } = await memberIds(item, io, landed);
  if (!get().groupId) {
    if (!ids.size) throw new Error(`None of its bots made it there: bring ${listNames(item.members.map((m) => m.name), 'or')} first, then try again.`);
    if (get().attempted && get().before) {
      const found = landedGroup(await io.cloudGroups(), get().before!, item.name);
      if (found) set({ groupId: found.id });
    }
  }
  if (!get().groupId) {
    set({ step: 'group', before: (await io.cloudGroups()).map((g) => g.id), attempted: true });
    const botIds = item.members.flatMap((m) => (ids.has(m.macBotId) ? [ids.get(m.macBotId)!] : []));
    const leadId = item.leadMacId ? ids.get(item.leadMacId) : undefined;
    try {
      const made = await io.createGroup({ name: item.name, botIds, ...(leadId ? { leadId } : {}) });
      set({ groupId: made.id });
    } catch (e) {
      // the answer may be what failed: look before calling it a failure
      const found = await io.cloudGroups().then((l) => landedGroup(l, get().before!, item.name)).catch(() => undefined);
      if (!found) throw e;
      set({ groupId: found.id });
    }
    const left = [...item.missing, ...lost];
    if (left.length) set({ notes: [...get().notes, `${listNames(left)} ${left.length === 1 ? 'isn’t' : 'aren’t'} there, so ${left.length === 1 ? 'it isn’t' : 'they aren’t'} in it. Add ${left.length === 1 ? 'it' : 'them'} in the group’s settings once ${left.length === 1 ? 'it’s' : 'they’re'} there.`] });
  }
  const groupId = get().groupId!;
  if (item.setup && !get().groupSet && io.setGroupModel) {
    set({ step: 'group' });
    try { await io.setGroupModel(groupId, item.setup); } catch (e) {
      if (codeOf(e) !== 'not_found') throw e;
      set({ notes: [...get().notes, 'The agent it ran on isn’t on there, so each bot answers on its own model. Pick one in the group’s settings.'] });
    }
    set({ groupSet: true });
  }
  if (item.room && !get().roomDone && io.macRoom && io.restoreRoom) {
    set({ step: 'room' });
    const room = roomForTarget(await io.macRoom(item.macGroupId), ids);
    if (room.chats.length) {
      try { await io.restoreRoom(groupId, item.macGroupId, room.chats); } catch (e) {
        const code = codeOf(e);
        if (code === 'unknown_method' || /unknown method/i.test(messageOf(e))) set({ notes: [...get().notes, 'Its chat history stays on this Mac: the computer can’t take it yet, so the room starts empty.'] });
        // already in (an answer lost on the way)
        else if (code !== 'conflict') throw e;
      }
    }
    if (room.dropped) set({ notes: [...get().notes, `Its oldest ${room.dropped === 1 ? 'message' : `${room.dropped} messages`} stayed on this Mac (too much to send at once).`] });
    set({ roomDone: true });
  }
}

/**
 * A room as the computer it goes to takes it (`groups.restore`): every thread with messages, each bot named by its id
 * there (one that didn't come keeps its name only), and no more than `GROUP_RESTORE_CHARS_MAX` characters, the oldest
 * messages left out past it (`dropped`).
 */
export function roomForTarget(chats: MacRoomChat[], ids: Map<string, string>, max = GROUP_RESTORE_CHARS_MAX): { chats: GroupRestoreChat[]; dropped: number } {
  const kept = chats.filter((c, k) => k === 0 || c.messages.length).slice(-GROUP_RESTORE_CHATS_MAX);
  // newest first until the budget is spent
  const all = kept.flatMap((c, k) => c.messages.map((m) => ({ k, m })));
  all.sort((a, b) => b.m.createdAt - a.m.createdAt);
  let used = 0;
  const keep = new Set<GroupMessage>();
  for (const { m } of all) {
    used += m.text.length + 200;
    if (used > max) break;
    keep.add(m);
  }
  const out: GroupRestoreChat[] = kept.map((c) => ({
    fromId: c.id, title: c.title, createdAt: c.createdAt,
    messages: c.messages.filter((m) => keep.has(m)).map((m) => {
      const botId = m.from.kind === 'bot' && m.from.botId ? ids.get(m.from.botId) : undefined;
      return {
        from: m.from.kind === 'bot' ? { kind: 'bot' as const, ...(botId ? { botId } : {}), ...(m.from.name ? { name: m.from.name } : {}) } : { kind: m.from.kind },
        text: m.text, mentions: m.mentions.flatMap((b) => (ids.has(b) ? [ids.get(b)!] : [])), hop: m.hop, createdAt: m.createdAt,
      };
    }),
  }));
  const any = out.some((c) => c.messages.length);
  return { chats: any ? out : [], dropped: all.length - keep.size };
}

/** the end of a run in words: "3 bots came over, 1 skipped, 1 failed" */
export function summaryText(items: PlanItem[], states: Record<string, ItemState | undefined>): string {
  let came = 0, skipped = 0, failed = 0, groups = 0, skillsDone = false;
  for (const i of items) {
    const st = states[i.key];
    if (i.kind === 'skills') { skillsDone = st?.status === 'done'; if (st?.status === 'failed') failed++; continue; }
    if (i.kind === 'group') { if (st?.status === 'done') groups++; else if (st?.status === 'failed') failed++; continue; }
    if (st?.status === 'done') came++;
    else if (st?.status === 'skipped') skipped++;
    else if (st?.status === 'failed') failed++;
  }
  const parts = [`${came} bot${came === 1 ? '' : 's'}${groups ? ` and ${groups} group${groups === 1 ? '' : 's'}` : ''} came over`];
  if (skillsDone) parts.push('skills added to the bots already there');
  if (skipped) parts.push(`${skipped} skipped`);
  if (failed) parts.push(`${failed} didn’t make it`);
  return parts.join(', ');
}
