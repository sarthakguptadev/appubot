import { describe, expect, it } from 'vitest';
import { transferLimit, type Bot, type BotExportIncluded, type BotImportResult, type Exportable, type ExportableBot, type FileAttachment, type Group, type GroupMessage, type GroupRestoreChat, type SharedSkillText } from '@appubot/protocol';
import {
  DEFAULT_INCLUDE, OLD_MAC_TEXT, copyName, defaultGroupPicks, defaultPick, defaultPicks, defaultShared, estimateBytes, findClash, fitInclude, groupPlanText, initialState, landedBot, planTransfer, roomForTarget, runItem, sizeRefusalText, summaryText, trimmedText, worthBringing,
  type BotPick, type CloudBotRef, type GroupPlanItem, type GroupsInput, type Include, type ItemState, type MacRoomChat, type PlanItem, type SharedPick, type TransferIo,
} from './transferPlan';

const bot = (id: string, name: string): Bot => ({ id, name, slug: name.toLowerCase(), workspace: `/bots/${id}` } as unknown as Bot);
const exportable = (id: string, name: string, sizes: Partial<Record<'memory' | 'skills' | 'files' | 'chats', number>> = {}): ExportableBot => ({
  bot: bot(id, name),
  memory: { bytes: sizes.memory ?? 1000 }, skills: { names: ['a'], bytes: sizes.skills ?? 2000 }, files: { count: 1, bytes: sizes.files ?? 3000 },
  routines: { count: 1 }, chats: { threads: 2, messages: 10, bytes: sizes.chats ?? 50_000 },
});
const MAC: Exportable = {
  hostName: 'Sarthak’s MacBook Pro',
  bots: [exportable('m1', 'Ada'), exportable('m2', 'Ben'), exportable('m3', 'Cy')],
  sharedSkills: [{ name: 'tidy-desk', description: '', from: 'claude', files: 2, bytes: 100 }, { name: 'write-mail', description: '', from: 'agents', files: 1, bytes: 50 }],
};
const pick = (patch: Partial<BotPick> = {}): BotPick => ({ ...defaultPick(), selected: true, ...patch });
const NO_SHARED: SharedPick = { names: [], toImported: true, toExisting: false };

describe('names', () => {
  it('finds a clash as people read names', () => {
    expect(findClash('ada', [{ id: 'c1', name: ' Ada ' }])?.id).toBe('c1');
    expect(findClash('Sam’s bot', [{ id: 'c1', name: "Sam's  bot" }])?.id).toBe('c1');
    expect(findClash('Adam', [{ id: 'c1', name: 'Ada' }])).toBeUndefined();
  });
  it('picks a free copy name', () => {
    expect(copyName('Ada', ['Ada'])).toBe('Ada (copy)');
    expect(copyName('Ada', ['Ada', 'ada (COPY)'])).toBe('Ada (copy 2)');
    expect(copyName('Ada', ['Ada', 'Ada (copy)', 'Ada (copy 2)'])).toBe('Ada (copy 3)');
  });
});

describe('what a page opens with', () => {
  it('ticks every bot with all of it', () => {
    const picks = defaultPicks(MAC, []);
    expect(Object.keys(picks)).toEqual(['m1', 'm2', 'm3']);
    expect(picks.m1).toEqual({ selected: true, include: DEFAULT_INCLUDE, conflict: 'copy' });
    expect(planTransfer({ mac: MAC, cloudBots: [], picks, shared: defaultShared(MAC, picks) }).ready).toBe(true);
  });
  it('leaves a bot whose name is already there unticked, so a second visit makes no copies', () => {
    const picks = defaultPicks(MAC, [{ id: 'c1', name: 'ada' }]);
    expect(picks.m1!.selected).toBe(false);
    expect(picks.m2!.selected).toBe(true);
  });
  it('leaves the heaviest part out of a bot too big to send whole', () => {
    const MB = 1024 * 1024;
    expect(fitInclude(exportable('m1', 'Ada', { chats: 900 * MB }))).toMatchObject({ chats: false, files: true, memory: true });
    expect(fitInclude(exportable('m1', 'Ada', { files: 900 * MB }))).toMatchObject({ chats: true, files: false });
    expect(fitInclude(exportable('m1', 'Ada', { files: 600 * MB, chats: 700 * MB }))).toMatchObject({ chats: false, files: false, skills: true });
    const mac: Exportable = { ...MAC, bots: [exportable('m1', 'Ada', { chats: 900 * MB })] };
    const picks = defaultPicks(mac, []);
    expect(planTransfer({ mac, cloudBots: [], picks, shared: defaultShared(mac, picks) }).ready).toBe(true);
  });
  it('brings the shared skills with the bots, and none when no bot comes', () => {
    const picks = defaultPicks(MAC, []);
    expect(defaultShared(MAC, picks)).toEqual({ names: ['tidy-desk', 'write-mail'], toImported: true, toExisting: false });
    const taken = defaultPicks(MAC, [{ id: 'c1', name: 'Ada' }, { id: 'c2', name: 'Ben' }, { id: 'c3', name: 'Cy' }]);
    expect(defaultShared(MAC, taken).names).toEqual([]);
  });
  it('offers only bots with something of the person’s in them', () => {
    expect(worthBringing(exportable('m1', 'Ada'))).toBe(true);
    expect(worthBringing({ ...exportable('m1', 'Ada'), skills: { names: [], bytes: 0 }, routines: { count: 0 }, chats: { threads: 1, messages: 0, bytes: 0 } })).toBe(false);
  });
});

describe('planTransfer', () => {
  it('brings only the picked bots, in the Mac’s order, with the default parts', () => {
    const p = planTransfer({ mac: MAC, cloudBots: [], picks: { m3: pick(), m1: pick(), m2: { ...pick(), selected: false } }, shared: NO_SHARED });
    expect(p.items.map((i) => i.key)).toEqual(['bot:m1', 'bot:m3']);
    expect(p.ready).toBe(true);
    const first = p.items[0] as Extract<PlanItem, { kind: 'bot' }>;
    expect(first).toMatchObject({ mode: 'new', name: 'Ada', include: DEFAULT_INCLUDE });
    // all of a bot comes unless a part is unticked, its chats too
    expect(DEFAULT_INCLUDE).toEqual({ memory: true, skills: true, files: true, routines: true, chats: true });
  });

  it('is not ready with nothing picked', () => {
    expect(planTransfer({ mac: MAC, cloudBots: [], picks: {}, shared: NO_SHARED }).ready).toBe(false);
  });

  it('settles a clash: skip, replace or copy', () => {
    const cloudBots: CloudBotRef[] = [{ id: 'c1', name: 'Ada' }, { id: 'c2', name: 'Ben' }, { id: 'c3', name: 'Cy' }, { id: 'c4', name: 'Cy (copy)' }];
    const p = planTransfer({ mac: MAC, cloudBots, picks: { m1: pick({ conflict: 'skip' }), m2: pick({ conflict: 'replace' }), m3: pick({ conflict: 'copy' }) }, shared: NO_SHARED });
    expect(p.items[0]).toMatchObject({ kind: 'skip', macName: 'Ada', clashName: 'Ada' });
    expect(p.items[1]).toMatchObject({ kind: 'bot', mode: 'replace', name: 'Ben', replaceId: 'c2' });
    expect(p.items[2]).toMatchObject({ kind: 'bot', mode: 'copy', name: 'Cy (copy 2)' });
    expect(p.ready).toBe(true);
  });

  it('is not ready when every pick is skipped', () => {
    const p = planTransfer({ mac: MAC, cloudBots: [{ id: 'c1', name: 'Ada' }], picks: { m1: pick({ conflict: 'skip' }) }, shared: NO_SHARED });
    expect(p.ready).toBe(false);
  });

  it('brings two Mac bots of one name side by side', () => {
    const mac: Exportable = { ...MAC, bots: [exportable('m1', 'Ada'), exportable('m9', 'Ada')] };
    const p = planTransfer({ mac, cloudBots: [], picks: { m1: pick(), m9: pick() }, shared: NO_SHARED });
    expect(p.items.map((i) => (i as { name: string }).name)).toEqual(['Ada', 'Ada (copy)']);
  });

  it('refuses a bundle too big to send, naming the part to leave out', () => {
    const mac: Exportable = { ...MAC, bots: [exportable('m1', 'Ada', { chats: 900 * 1024 * 1024 })] };
    const withChats = planTransfer({ mac, cloudBots: [], picks: { m1: pick() }, shared: NO_SHARED });
    expect(withChats.ready).toBe(false);
    expect(withChats.problems[0]).toMatch(/Ada is too big.*leave out its chats/);
    expect(planTransfer({ mac, cloudBots: [], picks: { m1: pick({ include: { ...DEFAULT_INCLUDE, chats: false } }) }, shared: NO_SHARED }).ready).toBe(true);
  });

  it('sizes each bundle from the parts picked', () => {
    const item = exportable('m1', 'Ada');
    const none: Include = { memory: false, skills: false, files: false, routines: false, chats: false };
    expect(estimateBytes(item, { ...none, memory: true }) - estimateBytes(item, none)).toBe(1000);
    expect(estimateBytes(item, { ...none, chats: true }) - estimateBytes(item, none)).toBe(50_000);
  });

  it('gives shared skills to the bots brought now and, if asked, to those already there (not one being replaced)', () => {
    const cloudBots: CloudBotRef[] = [{ id: 'c1', name: 'Ada' }, { id: 'c2', name: 'Zed' }];
    const p = planTransfer({ mac: MAC, cloudBots, picks: { m1: pick({ conflict: 'replace' }) }, shared: { names: ['tidy-desk', 'gone'], toImported: true, toExisting: true } });
    expect(p.items[0]).toMatchObject({ kind: 'bot', sharedSkills: ['tidy-desk'] });
    expect(p.items[1]).toEqual({ kind: 'skills', key: 'shared-skills', names: ['tidy-desk'], cloudBotIds: ['c2'] });
    expect(p.ready).toBe(true);
    // only to the bots brought now: no skills item
    const q = planTransfer({ mac: MAC, cloudBots, picks: { m2: pick() }, shared: { names: ['tidy-desk'], toImported: true, toExisting: false } });
    expect(q.items.map((i) => i.kind)).toEqual(['bot']);
    // shared skills alone, to the bots there
    const r = planTransfer({ mac: MAC, cloudBots, picks: {}, shared: { names: ['write-mail'], toImported: true, toExisting: true } });
    expect(r.items).toEqual([{ kind: 'skills', key: 'shared-skills', names: ['write-mail'], cloudBotIds: ['c1', 'c2'] }]);
    expect(r.ready).toBe(true);
    // with nowhere to go
    const s = planTransfer({ mac: MAC, cloudBots, picks: {}, shared: { names: ['write-mail'], toImported: true, toExisting: false } });
    expect(s.ready).toBe(false);
    expect(s.problems[0]).toMatch(/Skills live in bots there/);
  });
});

/* ------------------------------------------------------------------ running */

const ALL: BotExportIncluded = { memory: true, skills: true, files: true, routines: true, chats: true, sharedSkills: [] };
interface Fake extends TransferIo { calls: string[]; cloud: CloudBotRef[] }
function fakeIo(o: { included?: BotExportIncluded | null; size?: number; importFails?: 'before' | 'after'; deleteFails?: number; saveFailsAt?: number } = {}): Fake {
  let deleteFails = o.deleteFails ?? 0;
  let importFails = o.importFails;
  let saves = 0;
  const io: Fake = {
    calls: [], cloud: [{ id: 'c1', name: 'Ada' }],
    async exportBot(id, _inc, shared) { io.calls.push(`export:${id}`); return { file: { id: 'f-mac', name: 'ada.appubot-bot.zip', mimeType: 'application/zip', size: o.size ?? 1000, url: '/files/f-mac' } as FileAttachment, ...(o.included === null ? {} : { included: { ...(o.included ?? ALL), sharedSkills: shared } }) }; },
    async carry() { io.calls.push('carry'); return { id: 'f-cloud' }; },
    async importBot(_fileId, name) {
      io.calls.push(`import:${name}`);
      if (importFails === 'before') { importFails = undefined; throw new Error('refused'); }
      const made = { id: `new-${io.cloud.length}`, name };
      io.cloud.push(made);
      if (importFails === 'after') { importFails = undefined; throw Object.assign(new Error('timed out'), { code: 'timeout' }); }
      return { bot: { ...bot(made.id, name) }, notes: ['Sign in to Claude Code here'], counts: { threads: 0, messages: 0, routines: 0, skills: 1, files: 0 } } as unknown as BotImportResult;
    },
    async cloudBots() { return io.cloud.slice(); },
    async deleteCloudBot(id) {
      io.calls.push(`delete:${id}`);
      if (deleteFails-- > 0) throw new Error('busy');
      if (!io.cloud.some((b) => b.id === id)) throw Object.assign(new Error('gone'), { code: 'not_found' });
      io.cloud = io.cloud.filter((b) => b.id !== id);
    },
    async sharedSkill(name): Promise<SharedSkillText> { io.calls.push(`read:${name}`); return { name, description: `${name}!`, body: 'do it', files: name === 'tidy-desk' ? 2 : 1 }; },
    async saveSkill(botId, name) { saves++; if (o.saveFailsAt === saves) throw new Error('offline'); io.calls.push(`save:${botId}/${name}`); },
  };
  return io;
}
const botItem = (patch: Partial<Extract<PlanItem, { kind: 'bot' }>> = {}): Extract<PlanItem, { kind: 'bot' }> => ({ kind: 'bot', key: 'bot:m1', macBotId: 'm1', macName: 'Ada', name: 'Ada (copy)', mode: 'copy', include: { ...DEFAULT_INCLUDE }, sharedSkills: [], bytes: 1000, tooBig: false, ...patch });
const run = async (item: PlanItem, io: TransferIo, prev?: ItemState) => {
  const seen: ItemState[] = [];
  const end = await runItem(item, prev ?? initialState(item), io, (s) => seen.push(s));
  return { end, seen };
};

describe('runItem', () => {
  it('packs on the Mac, carries, unpacks there, and keeps the notes', async () => {
    const io = fakeIo();
    const { end, seen } = await run(botItem(), io);
    expect(io.calls).toEqual(['export:m1', 'carry', 'import:Ada (copy)']);
    expect(end).toMatchObject({ status: 'done', botId: 'new-1', notes: ['Sign in to Claude Code here'] });
    expect(seen.map((s) => s.step).filter(Boolean)).toEqual(['packing', 'sending', 'unpacking', 'unpacking']);
  });

  it('replaces: the new one first, then the old one goes', async () => {
    const io = fakeIo();
    const { end } = await run(botItem({ mode: 'replace', name: 'Ada', replaceId: 'c1' }), io);
    expect(io.calls).toEqual(['export:m1', 'carry', 'import:Ada', 'delete:c1']);
    expect(io.cloud.map((b) => b.id)).toEqual(['new-1']);
    expect(end).toMatchObject({ status: 'done', replaced: true });
  });

  it('on Try again after a failed removal, only removes', async () => {
    const io = fakeIo({ deleteFails: 1 });
    const item = botItem({ mode: 'replace', name: 'Ada', replaceId: 'c1' });
    const first = await run(item, io);
    expect(first.end.status).toBe('failed');
    expect(first.end.error).toMatch(/came over, but the one that was there couldn’t be removed/);
    io.calls.length = 0;
    const again = await run(item, io, first.end);
    expect(io.calls).toEqual(['delete:c1']);
    expect(again.end.status).toBe('done');
    // and a removal that already happened counts as done
    const io2 = fakeIo();
    io2.cloud = [];
    expect((await run(item, io2, { ...first.end, status: 'failed' })).end.status).toBe('done');
  });

  it('never makes a second bot when the import’s answer got lost', async () => {
    const io = fakeIo({ importFails: 'after' });
    const { end } = await run(botItem(), io);
    // found by its new id and name: done, nothing sent twice
    expect(end).toMatchObject({ status: 'done', botId: 'new-1' });
    expect(io.calls.filter((c) => c.startsWith('import'))).toHaveLength(1);
    expect(io.cloud).toHaveLength(2);
  });

  it('on Try again after a refused import, sends it again (nothing landed)', async () => {
    const io = fakeIo({ importFails: 'before' });
    const first = await run(botItem(), io);
    expect(first.end).toMatchObject({ status: 'failed', error: 'refused', attempted: true });
    const again = await run(botItem(), io, first.end);
    expect(again.end.status).toBe('done');
    expect(io.cloud.map((b) => b.name)).toEqual(['Ada', 'Ada (copy)']);
  });

  it('on Try again after a lost answer from a run before, finds the bot instead of importing', async () => {
    const io = fakeIo();
    io.cloud.push({ id: 'landed', name: 'Ada (copy)' });
    const prev: ItemState = { status: 'failed', attempted: true, before: ['c1'], notes: [] };
    const { end } = await run(botItem(), io, prev);
    expect(io.calls).toEqual([]);
    expect(end).toMatchObject({ status: 'done', botId: 'landed' });
  });

  it('sends nothing when the Mac packed more than was picked (an AppuBot from before)', async () => {
    const old = fakeIo({ included: null });
    expect((await run(botItem(), old)).end).toMatchObject({ status: 'failed', error: OLD_MAC_TEXT });
    expect(old.calls).toEqual(['export:m1']);
    // chats left out, and the Mac packed them anyway
    const wrong = fakeIo({ included: { ...ALL, chats: true } });
    expect((await run(botItem({ include: { ...DEFAULT_INCLUDE, chats: false } }), wrong)).end.status).toBe('failed');
    expect(wrong.calls).not.toContain('carry');
  });

  it('sends nothing too big', async () => {
    const io = fakeIo({ size: 600 * 1024 * 1024 });
    const { end } = await run(botItem(), io);
    expect(end.status).toBe('failed');
    expect(end.error).toMatch(/more than the 500 MB/);
    expect(io.calls).toEqual(['export:m1']);
  });

  it('skips a skipped item and leaves a finished one be', async () => {
    const io = fakeIo();
    expect((await run({ kind: 'skip', key: 'bot:m1', macBotId: 'm1', macName: 'Ada', clashName: 'Ada' }, io)).end.status).toBe('skipped');
    const done: ItemState = { status: 'done', botId: 'x', notes: [] };
    expect((await run(botItem(), io, done)).end).toBe(done);
    expect(io.calls).toEqual([]);
  });

  it('gives shared skills to the bots there once each, carrying on after a failure', async () => {
    const io = fakeIo({ saveFailsAt: 3 });
    io.cloud.push({ id: 'c2', name: 'Zed' });
    const item: PlanItem = { kind: 'skills', key: 'shared-skills', names: ['tidy-desk', 'write-mail'], cloudBotIds: ['c1', 'c2', 'gone'] };
    const first = await run(item, io);
    expect(first.end.status).toBe('failed');
    expect(first.end.saved).toEqual(['c1/tidy-desk', 'c2/tidy-desk']);
    // only its instructions travel this way
    expect(first.end.notes.join(' ')).toMatch(/“tidy-desk” has 1 more file/);
    const again = await run(item, io, first.end);
    expect(again.end.status).toBe('done');
    expect(io.calls.filter((c) => c.startsWith('save:'))).toEqual(['save:c1/tidy-desk', 'save:c2/tidy-desk', 'save:c1/write-mail', 'save:c2/write-mail']);
  });
});

describe('landedBot and summaryText', () => {
  it('tells this item’s bot from those there before', () => {
    expect(landedBot([{ id: 'c1', name: 'Ada' }, { id: 'n', name: 'Ada' }], ['c1'], 'ada')?.id).toBe('n');
    expect(landedBot([{ id: 'c1', name: 'Ada' }], ['c1'], 'Ada')).toBeUndefined();
  });
  it('says how it went', () => {
    const items: PlanItem[] = [botItem({ key: 'a' }), botItem({ key: 'b' }), { kind: 'skip', key: 'c', macBotId: 'm3', macName: 'Cy', clashName: 'Cy' }, { kind: 'skills', key: 'shared-skills', names: ['x'], cloudBotIds: ['c1'] }];
    const states: Record<string, ItemState> = { a: { status: 'done', notes: [] }, b: { status: 'failed', notes: [] }, c: { status: 'skipped', notes: [] }, 'shared-skills': { status: 'done', notes: [] } };
    expect(summaryText(items, states)).toBe('1 bot came over, skills added to the bots already there, 1 skipped, 1 didn’t make it');
  });
});

/* ------------------------------------------------------------------ size: what the computer takes */

describe('a bot too big for the computer it goes to', () => {
  const MB = 1024 * 1024;
  const limit = transferLimit(undefined);
  it('takes 300 MB less the margin from a computer that doesn’t say, and what one says (within 500 MB)', () => {
    expect(limit).toBe(296 * MB);
    expect(transferLimit({ uploadMax: 512 * MB })).toBe(500 * MB);
    expect(transferLimit({ uploadMax: 100 * MB })).toBe(96 * MB);
  });
  it('leaves its chats out by itself and says why on its row (her bot: 339 MB, 203 MB of it chats)', () => {
    const her = exportable('m1', 'Ada', { chats: 203 * MB, files: 130 * MB });
    const mac: Exportable = { ...MAC, bots: [her] };
    const picks = defaultPicks(mac, [], limit);
    expect(picks.m1).toMatchObject({ selected: true, include: { chats: false, files: true }, trimmed: ['chats'] });
    expect(trimmedText(her, picks.m1!, limit, { target: 'your AppuBot computer' })).toBe('Its chat history (203 MB) stays on this Mac: with it, Ada is too big to send at once (your AppuBot computer takes 296 MB at a time).');
    // ticked back on, the row says nothing more: the plan's own problem does
    expect(trimmedText(her, { ...picks.m1!, include: { ...picks.m1!.include, chats: true } }, limit, { target: 'x' })).toBeNull();
    const plan = planTransfer({ mac, cloudBots: [], picks: { m1: { ...picks.m1!, include: { ...DEFAULT_INCLUDE } } }, shared: NO_SHARED, limit });
    expect(plan.ready).toBe(false);
    expect(plan.problems[0]).toMatch(/296 MB at most/);
    // the whole of it goes to a computer that takes 512 MB
    expect(defaultPicks(mac, [], transferLimit({ uploadMax: 512 * MB })).m1).toEqual({ selected: true, include: DEFAULT_INCLUDE, conflict: 'copy' });
  });
  it('a bundle over the computer’s limit isn’t sent, and a refusal for size reads as words', async () => {
    const io = fakeIo({ size: 297 * MB });
    const { end } = await run(botItem({ limit }), io);
    expect(end.error).toMatch(/came to 297 MB, more than the 296 MB/);
    expect(io.calls).toEqual(['export:m1']);
    expect(sizeRefusalText(new Error('request too large'), { name: 'Ada', bytes: 339 * MB, target: 'your AppuBot computer' })).toBe('Ada’s bundle (339 MB) is more than your AppuBot computer takes at once. Leave out its chat history or files (untick them) and try again.');
    expect(sizeRefusalText(new Error('Upload failed (413)'), { name: 'Ada', bytes: 1, target: 'x' })).not.toBeNull();
    expect(sizeRefusalText(new Error('offline'), { name: 'Ada', bytes: 1, target: 'x' })).toBeNull();
  });
});

/* ------------------------------------------------------------------ groups */

const group = (id: string, name: string, botIds: string[], patch: Partial<Group> = {}): Group => ({ id, name, botIds, lastMessagePreview: '', working: [], workingIn: {}, chats: [], createdAt: 1, updatedAt: 1, ...patch });
const MAC_BOTS = [{ id: 'm1', name: 'Ada' }, { id: 'm2', name: 'Ben' }, { id: 'm3', name: 'Cy' }, { id: 'm4', name: 'Dee' }];
const groupsIn = (mac: Group[], patch: Partial<GroupsInput> = {}): GroupsInput => ({ mac, cloud: [], picks: defaultGroupPicks(mac, patch.cloud ?? []), rooms: true, macBots: MAC_BOTS, ...patch });

describe('planning groups', () => {
  it('maps members to the bots this run brings or ones there by name; the rest stay out, and a group with none waits', () => {
    const team = group('g1', 'Controll team', ['m1', 'm2', 'm4'], { leadId: 'm4', providerId: 'claude-code', modelId: 'sonnet' });
    const solo = group('g2', 'Solo', ['m4']);
    // Ada comes (as a copy: there's one there), Ben is there already and left behind, Dee neither
    const cloudBots = [{ id: 'c1', name: 'Ada' }, { id: 'c2', name: 'Ben' }];
    const p = planTransfer({ mac: MAC, cloudBots, picks: { m1: pick() }, shared: NO_SHARED, groups: groupsIn([team, solo]) });
    const g = p.items.find((i) => i.kind === 'group') as GroupPlanItem;
    expect(g).toMatchObject({ name: 'Controll team', missing: ['Dee'], room: true, setup: { providerId: 'claude-code', modelId: 'sonnet' } });
    expect(g.members).toEqual([{ macBotId: 'm1', name: 'Ada (copy)', via: 'run' }, { macBotId: 'm2', name: 'Ben', via: 'there', cloudBotId: 'c2' }]);
    // its lead isn't coming: no lead there (the first chief leads, else nobody)
    expect(g.leadMacId).toBeUndefined();
    expect(p.held).toEqual({ g2: 'None of its bots will be there: bring Dee with it.' });
    expect(p.ready).toBe(true);
    expect(groupPlanText(g, 'your AppuBot computer')).toBe('With Ada (copy) and Ben, on the model it picked. Its chat history comes too. Dee isn’t coming, so it stays out of it.');
  });
  it('starts a group whose name is there unticked, and brings one ticked anyway as a copy', () => {
    const team = group('g1', 'Team', ['m1'], { leadId: 'm1' });
    const cloud = [{ id: 'x', name: 'team' }];
    expect(defaultGroupPicks([team], cloud)).toEqual({ g1: { selected: false } });
    const p = planTransfer({ mac: MAC, cloudBots: [], picks: { m1: pick() }, shared: NO_SHARED, groups: groupsIn([team], { cloud, picks: { g1: { selected: true } }, rooms: false }) });
    const g = p.items.find((i) => i.kind === 'group') as GroupPlanItem;
    expect(g).toMatchObject({ name: 'Team (copy)', leadMacId: 'm1', room: false });
    expect(groupPlanText(g, 'your AppuBot computer')).toMatch(/stays here: your AppuBot computer can’t take it yet, so the room starts empty/);
  });
  it('a run of groups alone is a run', () => {
    const p = planTransfer({ mac: MAC, cloudBots: [{ id: 'c1', name: 'Ada' }], picks: {}, shared: NO_SHARED, groups: groupsIn([group('g1', 'Team', ['m1'])]) });
    expect(p.items.map((i) => i.kind)).toEqual(['group']);
    expect(p.ready).toBe(true);
  });
});

interface GroupFake extends Fake { groups: CloudBotRef[]; made: { name: string; botIds: string[]; leadId?: string }[]; restored: GroupRestoreChat[][]; models: string[] }
function groupIo(o: { createFails?: 'after'; modelMissing?: boolean; restore?: 'unknown' | 'conflict' } = {}): GroupFake {
  const base = fakeIo();
  let createFails = o.createFails;
  const io: GroupFake = Object.assign(base, {
    groups: [] as CloudBotRef[], made: [] as GroupFake['made'], restored: [] as GroupRestoreChat[][], models: [] as string[],
    async cloudGroups() { return io.groups.slice(); },
    async createGroup(p: { name: string; botIds: string[]; leadId?: string }) {
      io.calls.push(`group:${p.name}`);
      const id = `g-${io.groups.length + 1}`;
      io.groups.push({ id, name: p.name });
      io.made.push(p);
      if (createFails === 'after') { createFails = undefined; throw Object.assign(new Error('timed out'), { code: 'timeout' }); }
      return { id };
    },
    async setGroupModel(_id: string, setup: { providerId: string }) {
      io.calls.push('model');
      if (o.modelMissing) throw Object.assign(new Error('Agent not found'), { code: 'not_found' });
      io.models.push(setup.providerId);
    },
    async macRoom(): Promise<MacRoomChat[]> {
      return [{ id: 'g1', title: 'Launch', createdAt: 5, messages: [
        { id: 'a', groupId: 'g1', from: { kind: 'user' }, text: '@Ada go', mentions: ['m1'], hop: 0, createdAt: 6 },
        { id: 'b', groupId: 'g1', from: { kind: 'bot', botId: 'm1', name: 'Ada' }, text: 'Done.', mentions: [], hop: 1, createdAt: 7 },
      ] }];
    },
    async restoreRoom(_id: string, _from: string, chats: GroupRestoreChat[]) {
      io.calls.push('room');
      if (o.restore === 'unknown') throw Object.assign(new Error('Unknown method: groups.restore'), { code: 'unknown_method' });
      if (o.restore === 'conflict') throw Object.assign(new Error('already'), { code: 'conflict' });
      io.restored.push(chats);
    },
  });
  io.cloud = [{ id: 'c2', name: 'Ben' }, { id: 'new-ada', name: 'Ada' }];
  return io;
}
const groupItem: GroupPlanItem = {
  kind: 'group', key: 'group:g1', macGroupId: 'g1', macName: 'Team', name: 'Team', room: true, missing: ['Dee'], leadMacId: 'm1', setup: { providerId: 'claude-code' },
  members: [{ macBotId: 'm1', name: 'Ada', via: 'run' }, { macBotId: 'm2', name: 'Ben', via: 'there', cloudBotId: 'c2' }],
};
const runGroupItem = (io: TransferIo, prev?: ItemState, landed: Record<string, string> = { m1: 'new-ada' }) => runItem(groupItem, prev ?? initialState(groupItem), io, () => undefined, new Map(), landed);

describe('running a group', () => {
  it('makes it with the landed bots and the lead, sets its model, and brings its room with ids from there', async () => {
    const io = groupIo();
    const end = await runGroupItem(io);
    expect(end).toMatchObject({ status: 'done', groupId: 'g-1', groupSet: true, roomDone: true });
    expect(io.made).toEqual([{ name: 'Team', botIds: ['new-ada', 'c2'], leadId: 'new-ada' }]);
    expect(io.models).toEqual(['claude-code']);
    expect(io.restored[0]![0]!.messages).toEqual([
      { from: { kind: 'user' }, text: '@Ada go', mentions: ['new-ada'], hop: 0, createdAt: 6 },
      { from: { kind: 'bot', botId: 'new-ada', name: 'Ada' }, text: 'Done.', mentions: [], hop: 1, createdAt: 7 },
    ]);
    expect(end.notes.join(' ')).toMatch(/^Dee isn’t there, so it isn’t in it/);
  });
  it('never makes a second group when the answer got lost, and Try again carries on from the room', async () => {
    const io = groupIo({ createFails: 'after' });
    const end = await runGroupItem(io);
    expect(end).toMatchObject({ status: 'done', groupId: 'g-1' });
    expect(io.made).toHaveLength(1);
    const again = await runGroupItem(io, { ...end, status: 'failed', roomDone: false });
    expect(again.status).toBe('done');
    expect(io.made).toHaveLength(1);
  });
  it('a computer that can’t take the room, or has it already, isn’t a failure; an agent not there is said', async () => {
    const old = groupIo({ restore: 'unknown', modelMissing: true });
    const end = await runGroupItem(old);
    expect(end.status).toBe('done');
    expect(end.notes.join(' ')).toMatch(/isn’t on there, so each bot answers on its own model/);
    expect(end.notes.join(' ')).toMatch(/chat history stays on this Mac/);
    expect((await runGroupItem(groupIo({ restore: 'conflict' }))).status).toBe('done');
  });
  it('fails, making nothing, when none of its bots made it', async () => {
    const io = groupIo();
    io.cloud = [];
    const end = await runGroupItem(io, undefined, {});
    expect(end).toMatchObject({ status: 'failed' });
    expect(end.error).toMatch(/None of its bots made it there: bring Ada or Ben first/);
    expect(io.made).toEqual([]);
  });
  it('says groups in the summary', () => {
    expect(summaryText([botItem({ key: 'a' }), groupItem], { a: { status: 'done', notes: [] }, 'group:g1': { status: 'done', notes: [] } })).toBe('1 bot and 1 group came over');
  });
});

describe('roomForTarget', () => {
  const msg = (id: string, text: string, at: number, from: GroupMessage['from'] = { kind: 'user' }): GroupMessage => ({ id, groupId: 'g1', from, text, mentions: [], hop: 0, createdAt: at });
  it('keeps the newest messages within the budget, the oldest left out', () => {
    const chats: MacRoomChat[] = [
      { id: 'g1', title: '', createdAt: 0, messages: [msg('a', 'x'.repeat(800), 1), msg('b', 'y'.repeat(800), 2)] },
      { id: 'c2', title: 'Two', createdAt: 3, messages: [msg('c', 'z'.repeat(800), 4)] },
      { id: 'c3', title: 'Empty', createdAt: 5, messages: [] },
    ];
    const r = roomForTarget(chats, new Map(), 2100);
    expect(r.dropped).toBe(1);
    expect(r.chats.map((c) => [c.fromId, c.messages.map((m) => m.text[0])])).toEqual([['g1', ['y']], ['c2', ['z']]]);
  });
  it('sends nothing for a room that never had a message', () => {
    expect(roomForTarget([{ id: 'g1', title: '', createdAt: 0, messages: [] }], new Map()).chats).toEqual([]);
  });
});
