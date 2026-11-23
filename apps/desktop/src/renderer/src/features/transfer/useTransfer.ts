/**
 * A transfer from this Mac to the AppuBot computer on screen, as a page holds it: what the Mac could send
 * (`bots.exportable`), the picks, the plan and its run. Settings › Transfer and the cloud computer's first-visit
 * screen (`features/cloud/CloudWelcome.tsx`) both stand on it; the rules are `transferPlan.ts`.
 *
 * A page opens with everything ticked (`defaultPicks`, `defaultShared`, `defaultGroupPicks`). Until the person changes
 * a pick it follows what is on the cloud computer (a bot or group whose name turns up there loses its tick), and a run
 * freezes the picks it started with, so the rows go on showing that run. How big a bundle may be is the cloud
 * computer's to say (`SystemInfo.transfer`, `transferLimit`); its groups part shows only where it has groups.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { groupChats, transferLimit, type Exportable, type ExportableBot, type Group, type GroupMessage, type SharedSkillText } from '@appubot/protocol';
import { errorMessage, localGateway, type GatewayLike } from '../../lib/gateway';
import { useStore } from '../../lib/store';
import { cloudClientReady, useCloudLink } from '../cloud/cloudClient';
import { useThisComputer } from '../cloud/thisComputer';
import { LONG_MS, blobFrom, uploadTo } from '../bots/MoveBotDialog';
import {
  defaultGroupPicks, defaultPick, defaultPicks, defaultShared, initialState, planTransfer, runItem, sizeRefusalText,
  type BotPick, type CloudBotRef, type GroupPick, type ItemState, type MacRoomChat, type Plan, type PlanItem, type SharedPick, type TransferIo,
} from './transferPlan';

export interface Transfer {
  /** what this Mac could send; null while it is read (or when it couldn't be: `loadError`) */
  mac: Exportable | null;
  /** every bot on this Mac, the ones `only` leaves out too */
  all: ExportableBot[];
  loadError: string;
  reload: () => void;
  /** the bots on the cloud computer now */
  refs: CloudBotRef[];
  plan: Plan | null;
  pickOf: (id: string) => BotPick;
  setPick: (id: string, patch: Partial<BotPick>) => void;
  /** every bot's tick at once */
  setAll: (selected: boolean) => void;
  allSelected: boolean;
  shared: SharedPick;
  setShared: (next: (s: SharedPick) => SharedPick) => void;
  /** this Mac's groups (none where the cloud computer has no groups, or this Mac's AppuBot predates them) */
  groups: Group[];
  /** the groups on the cloud computer now */
  groupRefs: CloudBotRef[];
  groupPickOf: (id: string) => GroupPick;
  setGroupPick: (id: string, selected: boolean) => void;
  /** the cloud computer takes a group's chat history */
  rooms: boolean;
  /** the biggest bundle the cloud computer takes at once */
  limit: number;
  states: Record<string, ItemState>;
  running: boolean;
  /** the items of the run that started (the rows show it from then on) */
  ran: PlanItem[] | null;
  failed: PlanItem[];
  finished: boolean;
  /**
   * Runs the items that aren't done (a second call is Try again: each carries on where it stopped) and answers where
   * each ended. `routinesOn`: the bots' routines arrive as they were on this Mac, on or off (a move: this Mac's are
   * then switched off by the caller); without it they arrive switched off, so nothing runs twice.
   */
  run: (items: PlanItem[], o?: { routinesOn?: boolean }) => Promise<Record<string, ItemState>>;
  startOver: () => void;
}

export function useTransfer(o: { only?: (item: ExportableBot) => boolean } = {}): Transfer {
  const target = useThisComputer();
  const team = useCloudLink((s) => s.team);
  // the cloud computer's bots, live (the store follows the computer on screen)
  const cloudBots = useStore((s) => s.bots);
  const cloudGroups = useStore((s) => s.groups);
  const groupsThere = useStore((s) => s.groupsSupported);
  const takes = useStore((s) => s.system?.transfer);
  const limit = transferLimit(takes);
  const rooms = !!takes?.groupRooms;
  const [raw, setRaw] = useState<Exportable | null>(null);
  const [macGroups, setMacGroups] = useState<Group[]>([]);
  const [groupPicks, setGroupPicks] = useState<Record<string, GroupPick>>({});
  const [loadError, setLoadError] = useState('');
  // only what the person changed (or a run froze); the rest follows the defaults
  const [picks, setPicks] = useState<Record<string, BotPick>>({});
  const [sharedPick, setSharedPick] = useState<SharedPick | null>(null);
  const [states, setStates] = useState<Record<string, ItemState>>({});
  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState<PlanItem[] | null>(null);
  const skillTexts = useRef(new Map<string, SharedSkillText>());
  const only = useRef(o.only);
  only.current = o.only;

  const reload = useCallback(() => {
    setLoadError('');
    localGateway().call('bots.exportable', {}, { timeoutMs: 60_000 }).then(setRaw, (e: unknown) => {
      const msg = errorMessage(e);
      setLoadError(/unknown_method|Unknown method/i.test(msg) ? 'AppuBot on this Mac needs a restart to transfer bots (Settings › About).' : `Couldn’t read this Mac’s bots: ${msg}`);
    });
    // this Mac's groups (an AppuBot here from before groups has none to bring)
    localGateway().call('groups.list', {}).then(setMacGroups, () => setMacGroups([]));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const mac = useMemo(() => (raw ? { ...raw, bots: only.current ? raw.bots.filter(only.current) : raw.bots } : null), [raw]);
  const refs = useMemo(() => cloudBots.filter((b) => !b.id.startsWith('local:')).map((b) => ({ id: b.id, name: b.name })), [cloudBots]);
  const defaults = useMemo(() => (mac ? defaultPicks(mac, refs, limit) : {}), [mac, refs, limit]);
  const groups = useMemo(() => (groupsThere ? macGroups.filter((g) => g.botIds.length) : []), [groupsThere, macGroups]);
  const groupRefs = useMemo(() => cloudGroups.filter((g) => !g.id.startsWith('local:')).map((g) => ({ id: g.id, name: g.name })), [cloudGroups]);
  const groupDefaults = useMemo(() => defaultGroupPicks(groups, groupRefs), [groups, groupRefs]);
  const groupsEffective = useMemo(() => ({ ...groupDefaults, ...groupPicks }), [groupDefaults, groupPicks]);
  const macBots = useMemo(() => (raw?.bots ?? []).map((b) => ({ id: b.bot.id, name: b.bot.name })), [raw]);
  const effective = useMemo(() => ({ ...defaults, ...picks }), [defaults, picks]);
  const shared = useMemo(() => sharedPick ?? (mac ? defaultShared(mac, effective) : { names: [], toImported: true, toExisting: false }), [sharedPick, mac, effective]);
  const plan = useMemo(() => (mac ? planTransfer({
    mac, cloudBots: refs, picks: effective, shared, limit,
    ...(groups.length ? { groups: { mac: groups, cloud: groupRefs, picks: groupsEffective, rooms, macBots } } : {}),
  }) : null), [mac, refs, effective, shared, limit, groups, groupRefs, groupsEffective, rooms, macBots]);

  const pickOf = (id: string): BotPick => effective[id] ?? defaultPick();
  const setPick = (id: string, patch: Partial<BotPick>) => setPicks((p) => ({ ...p, [id]: { ...(p[id] ?? defaults[id] ?? defaultPick()), ...patch } }));
  const setAll = (selected: boolean) => setPicks((p) => Object.fromEntries((mac?.bots ?? []).map((b) => [b.bot.id, { ...(p[b.bot.id] ?? defaults[b.bot.id] ?? defaultPick()), selected }])));
  const allSelected = !!mac?.bots.length && mac.bots.every((b) => pickOf(b.bot.id).selected);
  const setShared = (next: (s: SharedPick) => SharedPick) => setSharedPick(next(shared));
  const groupPickOf = (id: string): GroupPick => groupsEffective[id] ?? { selected: false };
  const setGroupPick = (id: string, selected: boolean) => setGroupPicks((p) => ({ ...p, [id]: { selected } }));

  const io = async (routinesOn: boolean): Promise<TransferIo> => {
    const src = localGateway();
    const dst: GatewayLike = await cloudClientReady(team ?? undefined);
    return {
      exportBot: (id, include, sharedSkills) => src.call('bots.export', { id, include, ...(sharedSkills.length ? { sharedSkills } : {}) }, { timeoutMs: LONG_MS }),
      carry: async (file, name) => {
        let blob: Blob;
        try { blob = await blobFrom(src, 'local', file); } catch (e) { throw new Error(`Couldn’t read the bot’s bundle on this Mac: ${errorMessage(e)}`); }
        try { return await uploadTo(dst, blob, file.name); } catch (e) {
          throw new Error(sizeRefusalText(e, { name, bytes: file.size, target: target.name }) ?? `Couldn’t send it to ${target.name}: ${errorMessage(e)}`);
        }
      },
      // routines arrive switched off (the Mac keeps running its own) unless this is a move
      importBot: (fileId, name) => dst.call('bots.import', { fileId, name, ...(routinesOn ? {} : { routines: false }) }, { timeoutMs: LONG_MS }),
      cloudBots: async () => (await dst.call('bots.list', {})).map((b) => ({ id: b.id, name: b.name })),
      deleteCloudBot: async (id) => { await dst.call('bots.delete', { id, deleteWorkspace: true }); },
      sharedSkill: (name) => src.call('skills.getShared', { name }),
      saveSkill: async (botId, name, description, body) => { await dst.call('skills.save', { botId, name, description, body }); },
      cloudGroups: async () => (await dst.call('groups.list', {})).map((g) => ({ id: g.id, name: g.name })),
      createGroup: async (p) => ({ id: (await dst.call('groups.create', p)).id }),
      setGroupModel: async (id, setup) => { await dst.call('groups.update', { id, patch: { providerId: setup.providerId, ...(setup.modelId ? { modelId: setup.modelId } : {}), ...(setup.effort ? { effort: setup.effort } : {}) } }); },
      macRoom: (id) => macRoom(src, macGroups.find((g) => g.id === id)),
      restoreRoom: async (id, fromId, chats) => { await dst.call('groups.restore', { id, fromId, chats }, { timeoutMs: LONG_MS }); },
    };
  };

  const run = async (items: PlanItem[], o: { routinesOn?: boolean } = {}): Promise<Record<string, ItemState>> => {
    // the picks as they stand: the bots this run brings are "there" from now on, and must not untick themselves
    setPicks(effective);
    setSharedPick(shared);
    setGroupPicks(groupsEffective);
    setRunning(true);
    setRan(items);
    let wires: TransferIo;
    try { wires = await io(!!o.routinesOn); } catch (e) {
      setRunning(false);
      const failed: Record<string, ItemState> = Object.fromEntries(items.map((i) => [i.key, { ...(states[i.key] ?? initialState(i)), status: i.kind === 'skip' ? 'skipped' as const : 'failed' as const, error: `Couldn’t reach ${target.name}: ${errorMessage(e)}` }]));
      setStates((st) => ({ ...st, ...failed }));
      return failed;
    }
    // where each item stopped (Try again carries on from there); this run's own states from here on
    const current: Record<string, ItemState> = Object.fromEntries(items.map((i) => [i.key, states[i.key] ?? initialState(i)]));
    setStates((st) => ({ ...st, ...current }));
    for (const item of items) {
      const prev = current[item.key] ?? initialState(item);
      // the bots this run brought, by their id here: a group's members
      const landed: Record<string, string> = {};
      for (const i of items) if (i.kind === 'bot' && current[i.key]?.botId) landed[i.macBotId] = current[i.key]!.botId!;
      const end = await runItem(item, prev, wires, (s) => setStates((st) => ({ ...st, [item.key]: s })), skillTexts.current, landed);
      current[item.key] = end;
    }
    setRunning(false);
    return current;
  };
  const failed = ran?.filter((i) => states[i.key]?.status === 'failed') ?? [];
  const finished = !!ran && !running;
  const startOver = () => { setRan(null); setStates({}); setPicks({}); setSharedPick(null); setGroupPicks({}); reload(); };

  return { mac, all: raw?.bots ?? [], loadError, reload, refs, plan, pickOf, setPick, setAll, allSelected, shared, setShared, groups, groupRefs, groupPickOf, setGroupPick, rooms, limit, states, running, ran, failed, finished, run, startOver };
}

/** A group's room on this Mac, every thread whole (`groups.history`, 500 at a time, oldest first). */
async function macRoom(src: GatewayLike, group: Group | undefined): Promise<MacRoomChat[]> {
  if (!group) return [];
  const out: MacRoomChat[] = [];
  for (const chat of groupChats(group)) {
    let messages: GroupMessage[] = [];
    let before: number | undefined;
    for (;;) {
      const page = await src.call('groups.history', { id: group.id, chatId: chat.id, limit: 500, ...(before !== undefined ? { before } : {}) });
      messages = [...page.messages, ...messages];
      if (!page.hasMore || !page.messages.length) break;
      before = page.messages[0]!.createdAt;
    }
    out.push({ id: chat.id, title: chat.title, createdAt: chat.createdAt, messages });
  }
  return out;
}
