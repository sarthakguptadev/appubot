/**
 * Settings › Transfer (shown while an AppuBot computer is on screen, the person's own or a team's): copy bots, their
 * memory, skills and chats, and this Mac's shared skills from this Mac to it. It opens with every bot ticked and
 * opened, all of its parts with it (a bot whose name is already there starts unticked). One way only, Mac → cloud; the Mac keeps
 * everything it has. The Mac packs each bot (`bots.export` with the parts picked), this window carries the bundle over
 * the Move dialog's path (the Mac's gateway, then the cloud's end-to-end channel) and the cloud unpacks it with the
 * `bots.import` every image has. Beside the bots (`features/transfer/CarryGroups.tsx`): this Mac's Vault, git's name,
 * email and GitHub sign-in, and the folders here its bots may read. Agent sign-ins, apps and Telegram never travel.
 * Groups (2026-11-15): this Mac's groups, made there from the bots that come (or are there already) with their lead,
 * model and, where the computer takes it, their chat history; shown only where the computer has groups.
 * Plan and run: `features/transfer/transferPlan.ts`, held by `useTransfer`.
 */
import { bytes } from '@appubot/chat-core';
import type { Bot, ExportableBot, Group } from '@appubot/protocol';
import { AlertTriangle, CircleCheck, LockKeyhole, RotateCw } from '../../../components/ui/icons';
import { BotAvatar, Button, Checkbox, Icon, Select, Spinner, Switch, cn } from '../../../components/ui';
import { useMacName } from '../../../lib/macName';
import { MACHINE } from '../../../lib/platform';
import { useCloudLink } from '../../cloud/cloudClient';
import { useThisComputer } from '../../cloud/thisComputer';
import {
  STEP_WORDS, copyName, estimateBytes, findClash, groupPlanText, listNames, summaryText, trimmedText,
  type BotPick, type ConflictChoice, type Include, type ItemState, type PlanItem,
} from '../../transfer/transferPlan';
import { GroupMembers } from '../../transfer/GroupMembers';
import { useTransfer } from '../../transfer/useTransfer';
import { GitCarryGroup, MacFilesGroup, VaultCarryGroup } from '../../transfer/CarryGroups';
import { TRANSFER_BOTS_TITLE, TRANSFER_GROUPS_TITLE, TRANSFER_SECRETS_TITLE, TRANSFER_SKILLS_TITLE } from '../nav';
import { SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE, SectionLoading, SettingRow, SettingsEmptyState, SettingsGroup } from './shared';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const size = (n: number) => bytes(n) || '0 B';

/** each part's words: its checkbox label and what it holds */
function partRows(item: ExportableBot): { part: keyof Include; label: string; detail: string; note?: string }[] {
  return [
    { part: 'memory', label: 'Memory', detail: size(item.memory.bytes) },
    { part: 'skills', label: 'Skills', detail: item.skills.names.length ? `${plural(item.skills.names.length, 'skill')}, ${size(item.skills.bytes)}` : 'none yet' },
    { part: 'files', label: 'Files in its folder', detail: item.files.count ? `${plural(item.files.count, 'file')}, ${size(item.files.bytes)}` : 'none' },
    { part: 'routines', label: 'Routines', detail: item.routines.count ? plural(item.routines.count, 'routine') : 'none', note: 'They arrive switched off, so they don’t run twice.' },
    { part: 'chats', label: 'Chat history', detail: item.chats.threads ? `${plural(item.chats.threads, 'chat')}, ${plural(item.chats.messages, 'message')}, ${size(item.chats.bytes)}` : 'none' },
  ];
}

const CONFLICT_WORDS: Record<ConflictChoice, string> = { copy: 'Bring it as a copy', replace: 'Replace the one there', skip: 'Skip it' };

export function TransferSection() {
  const macName = useMacName();
  const target = useThisComputer();
  const onCloud = useCloudLink((s) => s.computer === 'cloud');
  const { mac, all, loadError, reload, refs, plan, pickOf, setPick, setAll, allSelected, shared, setShared, groups, groupRefs, groupPickOf, setGroupPick, rooms, limit, states, running, ran, failed, finished, run, startOver } = useTransfer();

  if (!onCloud) return <SettingsEmptyState>Switch to your AppuBot computer (the computer menu at the top) to bring bots to it from {macName}.</SettingsEmptyState>;
  if (loadError) {
    return (
      <SettingsEmptyState>
        <div className="flex flex-col items-center gap-3">
          <span>{loadError}</span>
          <Button size="sm" variant="ghost" icon={RotateCw} onClick={reload}>Try again</Button>
        </div>
      </SettingsEmptyState>
    );
  }
  if (!mac || !plan) return <SectionLoading />;


  return (
    <>
      <SettingsGroup
        title={TRANSFER_BOTS_TITLE}
        description={`Copies of ${macName}’s bots on ${target.name}: each comes with its setup (name, look, job, instructions, agent, model and permissions) and the parts ticked, its chats too. Untick what should stay behind. ${macName} keeps its own; nothing comes back this way.`}
        action={mac.bots.length && !ran ? <Button size="xs" variant="ghost" onClick={() => setAll(!allSelected)}>{allSelected ? 'Select none' : 'Select all'}</Button> : undefined}
      >
        {mac.bots.length ? mac.bots.map((item) => {
          const key = `bot:${item.bot.id}`;
          // once it has run, the rows show that run (the bots it brought are "there" now: no clash with themselves)
          const ranItem = ran?.find((i) => i.key === key);
          return (
            <BotRow
              key={item.bot.id} item={item} pick={pickOf(item.bot.id)} locked={running || !!ran}
              clash={ran ? (ranItem?.kind === 'skip' ? ranItem.clashName : ranItem?.kind === 'bot' && ranItem.mode !== 'new' ? item.bot.name : undefined) : findClash(item.bot.name, refs)?.name}
              copyAs={copyName(item.bot.name, refs.map((r) => r.name))}
              planned={ran ? ranItem : plan.items.find((i) => i.key === key)} state={ranItem ? states[key] : undefined}
              trimmed={ran ? null : trimmedText(item, pickOf(item.bot.id), limit, { target: target.name, machine: MACHINE })}
              onPick={(patch) => setPick(item.bot.id, patch)}
            />
          );
        }) : <div className={cn(SETTINGS_ROW, 'text-copy text-muted')}>{macName} has no bots yet.</div>}
      </SettingsGroup>

      <SettingsGroup title={TRANSFER_SKILLS_TITLE} description={`Skills you keep for every agent on ${macName} (in ~/.claude/skills, ~/.agents/skills or ~/.codex/skills). ${target.cap} keeps skills in its bots, so they go into bots there.`}>
        {mac.sharedSkills.length ? (
          <>
            {mac.sharedSkills.map((k) => {
              const on = shared.names.includes(k.name);
              return (
                <label key={k.name} className={cn(SETTINGS_ROW, 'flex cursor-pointer items-start gap-3', ran && 'cursor-default')}>
                  <Checkbox className="mt-px" checked={on} disabled={!!ran} onChange={() => setShared((s) => ({ ...s, names: on ? s.names.filter((n) => n !== k.name) : [...s.names, k.name] }))} />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className={SETTINGS_ROW_TITLE}>{k.name}</div>
                    {k.description ? <p className={cn(SETTINGS_ROW_DESCRIPTION, 'line-clamp-2')}>{k.description}</p> : null}
                  </div>
                  <span className="shrink-0 text-note text-muted tabular-nums">{plural(k.files, 'file')}, {size(k.bytes)}</span>
                </label>
              );
            })}
            {shared.names.length ? (
              <>
                <SettingRow title="Give them to the bots you bring" description="The whole skill, with its files, in each bot’s own skills.">
                  <Switch checked={shared.toImported} disabled={!!ran} onChange={(v) => setShared((s) => ({ ...s, toImported: v }))} label="Give them to the bots you bring" />
                </SettingRow>
                <SettingRow title={`Also give them to the bots already on ${target.name}`} description={refs.length ? `${plural(refs.length, 'bot')} there. Only each skill’s instructions (SKILL.md) go this way.` : 'There are none yet.'}>
                  <Switch checked={shared.toExisting} disabled={!!ran || !refs.length} onChange={(v) => setShared((s) => ({ ...s, toExisting: v }))} label="Also give them to the bots already there" />
                </SettingRow>
              </>
            ) : null}
          </>
        ) : <div className={cn(SETTINGS_ROW, 'text-copy text-muted')}>No shared skills on {macName}.</div>}
        {ran?.find((i) => i.kind === 'skills') ? <ItemStatus state={states['shared-skills']} doneText="Added to the bots already there." /> : null}
      </SettingsGroup>

      {groups.length ? (
        <SettingsGroup
          title={TRANSFER_GROUPS_TITLE}
          description={`${macName}’s groups, made again on ${target.name} with the bots that come (or are there already), their lead and model${rooms ? ', and their chat history' : ''}. Bring a group’s bots with it.`}
        >
          {groups.map((g) => {
            const key = `group:${g.id}`;
            const ranItem = ran?.find((i) => i.key === key);
            return (
              <GroupRow
                key={g.id} group={g} bots={all.map((b) => b.bot)} selected={groupPickOf(g.id).selected} locked={running || !!ran}
                clash={ran ? undefined : findClash(g.name, groupRefs)?.name}
                planned={(ran ? ranItem : plan.items.find((i) => i.key === key)) as Extract<PlanItem, { kind: 'group' }> | undefined}
                held={ran ? undefined : plan.held[g.id]}
                state={ranItem ? states[key] : undefined} target={target.name}
                onPick={(v) => setGroupPick(g.id, v)}
              />
            );
          })}
        </SettingsGroup>
      ) : null}

      <div className="flex flex-col gap-3">
        {!ran && plan.problems.length ? <ul className="flex flex-col gap-1.5">{plan.problems.map((p) => <li key={p} className="flex gap-2 text-copy text-danger"><Icon icon={AlertTriangle} size={14} className="mt-0.5 shrink-0" /><span>{p}</span></li>)}</ul> : null}
        {finished ? (
          <div className="flex items-center gap-2 text-copy text-fg">
            <Icon icon={failed.length ? AlertTriangle : CircleCheck} size={16} className={failed.length ? 'text-attention' : 'text-success'} />
            <span>{summaryText(ran ?? [], states)}.</span>
          </div>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          {finished ? <Button size="sm" variant="ghost" onClick={startOver}>Transfer more</Button> : null}
          {finished && failed.length ? <Button size="sm" variant="primary" icon={RotateCw} onClick={() => void run(ran ?? [])}>Try again</Button> : null}
          {!ran ? (
            <Button size="sm" variant="primary" disabled={!plan.ready} onClick={() => void run(plan.items)}>
              {transferButtonText(plan.items)}
            </Button>
          ) : null}
          {running ? <span className="flex items-center gap-2 text-copy text-muted"><Spinner size={14} />Copying to {target.name}…</span> : null}
        </div>
      </div>

      <VaultCarryGroup />
      <GitCarryGroup />
      <MacFilesGroup />

      <SettingsGroup title={TRANSFER_SECRETS_TITLE} bare>
        <div className="flex gap-2.5 rounded-control-lg border border-[var(--ab-hairline)] px-4 py-3 text-copy leading-snug text-muted">
          <Icon icon={LockKeyhole} size={15} className="mt-0.5 shrink-0" />
          <span>Your AI agents’ sign-ins, connected apps, Telegram and your private SSH key stay on your Mac: sign in to your agents on {target.name} (Settings › Agents), and sign in to Apps there once to get every app you connected. Each bot says what it needs once it’s there.</span>
        </div>
      </SettingsGroup>
    </>
  );
}

function transferButtonText(items: PlanItem[]): string {
  const bots = items.filter((i) => i.kind === 'bot').length;
  const groups = items.filter((i) => i.kind === 'group').length;
  if (bots && groups) return `Transfer ${plural(bots, 'bot')} and ${plural(groups, 'group')}`;
  if (bots) return `Transfer ${plural(bots, 'bot')}`;
  if (groups) return `Transfer ${plural(groups, 'group')}`;
  if (items.some((i) => i.kind === 'skills')) return 'Transfer skills';
  return 'Transfer selected';
}

function GroupRow({ group, bots, selected, locked, clash, planned, held, state, target, onPick }: {
  group: Group; bots: Bot[]; selected: boolean; locked: boolean;
  /** the group of the same name on the cloud computer */
  clash?: string;
  planned?: Extract<PlanItem, { kind: 'group' }>;
  /** why it can't come this run */
  held?: string;
  state?: ItemState; target: string;
  onPick: (selected: boolean) => void;
}) {
  const members = group.botIds.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => !!b);
  const threads = group.chats.length || 1;
  return (
    <div className={cn(SETTINGS_ROW, 'flex flex-col gap-3')}>
      <label className={cn('flex items-center gap-3', locked ? 'cursor-default' : 'cursor-pointer')}>
        <Checkbox checked={selected} disabled={locked} onChange={() => onPick(!selected)} aria-label={`Bring ${group.name}`} />
        <GroupMembers members={members} size={28} />
        <div className="min-w-0 flex-1">
          <div className={cn(SETTINGS_ROW_TITLE, 'truncate')}>{group.name}</div>
          <p className={cn(SETTINGS_ROW_DESCRIPTION, 'truncate')}>{[listNames(members.map((b) => b.name)), plural(threads, 'thread')].filter(Boolean).join(' · ')}</p>
        </div>
      </label>
      {selected ? (
        <div className="ml-7 flex flex-col gap-2 text-copy">
          {held ? <div className="flex gap-2 text-attention"><Icon icon={AlertTriangle} size={14} className="mt-0.5 shrink-0" /><span>{held}</span></div> : null}
          {planned && !state ? <p className="text-muted">{groupPlanText(planned, target)}</p> : null}
          {clash && planned ? <div className="flex items-center gap-2"><Icon icon={AlertTriangle} size={14} className="text-attention" /><span className="text-fg">{clash} is already there.</span><span className="text-note text-muted">This one comes as “{planned.name}”.</span></div> : null}
          {state ? <ItemStatus state={state} doneText={`On there now${planned ? ` as “${planned.name}”` : ''}.`} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function BotRow({ item, pick, locked, clash, copyAs, planned, state, trimmed, onPick }: {
  item: ExportableBot; pick: BotPick; locked: boolean;
  /** the bot of the same name on the cloud computer */
  clash?: string; copyAs: string;
  planned?: PlanItem; state?: ItemState;
  /** what was left out for size, and why (`trimmedText`) */
  trimmed?: string | null;
  onPick: (patch: Partial<BotPick>) => void;
}) {
  const parts = partRows(item);
  const figure = item.character ? { body: item.character.body, face: item.character.face } : item.bot.shape;
  const summary = [
    item.memory.bytes ? 'memory' : '',
    item.skills.names.length ? plural(item.skills.names.length, 'skill') : '',
    item.chats.threads ? plural(item.chats.threads, 'chat') : '',
  ].filter(Boolean).join(' · ');
  return (
    <div className={cn(SETTINGS_ROW, 'flex flex-col gap-3')}>
      <label className={cn('flex items-center gap-3', locked ? 'cursor-default' : 'cursor-pointer')}>
        <Checkbox checked={pick.selected} disabled={locked} onChange={() => onPick({ selected: !pick.selected })} aria-label={`Bring ${item.bot.name}`} />
        <BotAvatar figure={figure} color={item.bot.color} size={28} still />
        <div className="min-w-0 flex-1">
          <div className={cn(SETTINGS_ROW_TITLE, 'truncate')}>{item.bot.name}</div>
          <p className={cn(SETTINGS_ROW_DESCRIPTION, 'truncate')}>{[item.bot.job, summary].filter(Boolean).join(' · ') || 'A new bot'}</p>
        </div>
        {pick.selected ? <span className="shrink-0 text-note text-muted tabular-nums">about {size(estimateBytes(item, pick.include))}</span> : null}
      </label>
      {pick.selected ? (
        <div className="ml-7 flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            {parts.map((p) => (
              <label key={p.part} className={cn('flex items-baseline gap-2 text-copy', locked ? 'cursor-default' : 'cursor-pointer')}>
                <Checkbox size={16} className="self-center" checked={pick.include[p.part]} disabled={locked} onChange={() => onPick({ include: { ...pick.include, [p.part]: !pick.include[p.part] } })} />
                <span className="text-fg">{p.label}</span>
                <span className="text-muted">{p.detail}</span>
                {p.note && pick.include[p.part] ? <span className="text-note text-muted">· {p.note}</span> : null}
              </label>
            ))}
          </div>
          {trimmed ? <div className="flex gap-2 text-copy text-attention"><Icon icon={AlertTriangle} size={14} className="mt-0.5 shrink-0" /><span>{trimmed}</span></div> : null}
          {clash ? (
            <div className="flex flex-wrap items-center gap-2 text-copy">
              <Icon icon={AlertTriangle} size={14} className="text-attention" />
              <span className="text-fg">{clash} is already there.</span>
              <Select fit value={pick.conflict} disabled={locked} onChange={(e) => onPick({ conflict: e.target.value as ConflictChoice })} aria-label={`What to do with ${item.bot.name}`}>
                {(Object.keys(CONFLICT_WORDS) as ConflictChoice[]).map((c) => <option key={c} value={c}>{CONFLICT_WORDS[c]}</option>)}
              </Select>
              <span className="text-note text-muted">
                {pick.conflict === 'copy' ? `as “${planned?.kind === 'bot' ? planned.name : copyAs}”` : pick.conflict === 'replace' ? `the one there goes, with its chats, once the new one is in` : 'nothing changes there'}
              </span>
            </div>
          ) : null}
          {state ? <ItemStatus state={state} doneText={state.result ? `On there now: ${plural(state.result.counts.skills, 'skill')}, ${plural(state.result.counts.threads, 'chat')}, ${plural(state.result.counts.routines, 'routine')}.` : 'On there now.'} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function ItemStatus({ state, doneText }: { state?: ItemState; doneText: string }) {
  if (!state || state.status === 'waiting') return state ? <div className="text-note text-muted">Waiting…</div> : null;
  return (
    <div className="flex flex-col gap-1 text-copy">
      {state.status === 'running' ? <div className="flex items-center gap-2 text-muted"><Spinner size={13} />{state.step ? STEP_WORDS[state.step] : 'Starting…'}</div> : null}
      {state.status === 'done' ? <div className="flex items-center gap-2 text-fg"><Icon icon={CircleCheck} size={14} className="text-success" />{doneText}</div> : null}
      {state.status === 'skipped' ? <div className="text-muted">Skipped: the one there stays as it is.</div> : null}
      {state.status === 'failed' ? <div className="flex gap-2 text-danger"><Icon icon={AlertTriangle} size={14} className="mt-0.5 shrink-0" /><span>{state.error}</span></div> : null}
      {state.notes.length ? <ul className="flex flex-col gap-1 pl-1">{state.notes.map((n) => <li key={n} className="flex gap-2 text-note text-muted"><Icon icon={AlertTriangle} size={12} className="mt-0.5 shrink-0" /><span>{n}</span></li>)}</ul> : null}
    </div>
  );
}
