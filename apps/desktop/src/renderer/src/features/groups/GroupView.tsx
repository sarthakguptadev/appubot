// A group's room (features/groups): the bots' conversation with each other and the user. The header is the chat's
// (the group's picture and name, which open its settings, its thread ▾ once it has a name; ⋯ New thread, Delete), then one
// thread's messages spaced as a chat's (yours at the right; each bot's at the left in grouped bubbles, its avatar beside
// the run's last one, who and when behind a ⋯; AppuBot's notes centred), who is working in this thread (a row per
// member under the messages), and the chat's composer (Stop in Send's place while members work): @Name picks who answers, else the lead (or everyone).
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { currentGroupChat, groupChatOf, groupChats, stripMarkdown, type Bot, type Group, type GroupChat, type GroupMessage, type Part, type Thread } from '@appubot/protocol';
import { conversationSeparators, groupAuthorName, linkMentions, splitFileLines } from '@appubot/chat-core';
import { Separator } from '../chat/Transcript';
import { PathChip } from '../chat/MediaParts';
import { Copy, Monitor, MoreHorizontal, SquarePen, Trash2, Users } from '../../components/ui/icons';
import { BotAvatar, Button, Icon, Menu, Tooltip, cn, type MenuItem } from '../../components/ui';
import { GroupTile } from '../../components/layout/Sidebar';
import { setState, ui, useStore } from '../../lib/store';
import { useCloudLink } from '../cloud/cloudClient';
import { ChatMarkdown } from '../chat/Markdown';
import { Composer } from '../chat/Composer';
import { LiveElapsed } from '../chat/LiveTimer';
import { syncAnimationsToTimelineOrigin } from '../../lib/animationTimelineSync';
import { QuestionCard } from '../chat/QuestionCard';
import { FormCard } from '../chat/FormCard';
import { ApprovalBar } from '../chat/ApprovalBar';
import { GoalCard } from '../chat/GoalBar';
import { call, loadConversation } from '../../lib/actions';
import { ModelPicker } from '../providers/ModelPicker';
import { DitherBackground } from '../chat/DitherBackground';
import { useAppearancePrefs, useMessagesTheme } from '../../lib/appearance';
import { Bubble } from '../chat/Bubble';
import { BUBBLE_CORNERS, REPLY_BUBBLE } from '../chat/AgentTurn';
import { SENT_BUBBLE } from '../chat/UserMessage';
import { CRUMB, CRUMB_CAPSULE, CRUMB_LEAD, CRUMB_TEXT, HEADER_STRIP } from '../chat/ChatHeader';
import { deleteGroup, loadGroup, updateGroup, newGroupChat, openGroupChat, sendGroupMessage, stopGroup } from './groups';


function timeOf(t: number): string { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

/** a group thread's name: its first message, else what was said last, else "New thread" */
function chatName(c: GroupChat): string {
  return c.title || (c.lastMessagePreview ? stripMarkdown(c.lastMessagePreview).slice(0, 48) : 'New thread');
}

function GroupHeader({ group, chat }: { group: Group; chat: GroupChat }) {
  const allBots = useStore((s) => s.bots);
  const members = group.botIds.map((id) => allBots.find((b) => b.id === id)).filter((b): b is Bot => !!b);
  const panelOpen = useStore((s) => s.rightOpen);
  // the computer's screen is the one thing the side panel has for a room (a remote computer's)
  const remote = useCloudLink((s) => s.computer === 'cloud');
  const chats = groupChats(group);
  return (
    // the chat's own header (ChatHeader): a clear strip, the group alone in the capsule, and at the right its ⋯,
    // which also lists the room's threads
    <header className={HEADER_STRIP} style={panelOpen ? undefined : { paddingRight: 'calc(12px + var(--wco-right))' }}>
      <span aria-hidden />
      <div className={CRUMB_CAPSULE}>
      <Tooltip label="Group settings">
        <button type="button" onClick={() => ui.openModal({ kind: 'group', groupId: group.id })} aria-label={`${group.name} settings`} className={cn(CRUMB, CRUMB_LEAD)}>
          <GroupTile members={members} size={24} bare />
          <span className={cn(CRUMB_TEXT, 'max-w-[16rem]')}>{group.name}</span>
        </button>
      </Tooltip>
      </div>
      <div className="chat-header-buttons no-drag flex items-center justify-self-end gap-0.5">
        <Menu
          trigger={(p) => <Button {...p} size="icon-sm" variant="ghost" icon={MoreHorizontal} aria-label="Group actions" className="chat-header-button" />}
          items={[
            // the room's threads, the latest first (they sat beside the group's name in the capsule until 2026-11-17)
            ...(chats.length > 1 ? [
              ...[...chats].reverse().map((c) => ({ label: chatName(c), current: c.id === chat.id, hint: c.id === chat.id ? '✓' : undefined, onSelect: () => void openGroupChat(group.id, c.id) })),
              'separator' as const,
            ] : []),
            { label: 'New thread', icon: SquarePen, onSelect: () => void newGroupChat(group.id) },
            ...(remote ? [{ label: panelOpen ? 'Hide the computer’s screen' : 'Show the computer’s screen', icon: Monitor, onSelect: () => (panelOpen ? setState({ rightOpen: false }) : ui.openRight('computer')) }] : []),
            'separator' as const,
            { label: 'Delete group', icon: Trash2, danger: true, onSelect: () => deleteGroup(group) },
          ]}
        />
      </div>
    </header>
  );
}

/** the same author within 5 minutes: one run, the avatar only at its last bubble */
function sameRun(a: GroupMessage | undefined, b: GroupMessage | undefined): boolean {
  return !!a && !!b && a.from.kind === b.from.kind && a.from.botId === b.from.botId && Math.abs(b.createdAt - a.createdAt) < 5 * 60_000;
}

/** who wrote it and when, behind a ⋯ that shows on hover, with Copy */
function MessageDetails({ m }: { m: GroupMessage }) {
  return (
    <span className="shrink-0 self-center opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100">
      <Menu
        align={m.from.kind === 'user' ? 'end' : 'start'}
        trigger={(props) => <button {...props} type="button" aria-label="Message details" className="ab-pill grid size-6 place-items-center rounded-md text-muted hover:bg-fg/5 hover:text-fg"><Icon icon={MoreHorizontal} size={15} /></button>}
        items={[
          { label: m.from.kind === 'user' ? 'You' : groupAuthorName(m.from), hint: timeOf(m.createdAt), onSelect: () => {}, disabled: true },
          'separator',
          { label: 'Copy', icon: Copy, onSelect: () => { void navigator.clipboard.writeText(m.text); } },
        ]}
      />
    </span>
  );
}

/**
 * One room message, in the bubbles of a chat with one bot (`SENT_BUBBLE`, `REPLY_BUBBLE` and its run corners): yours
 * at the right in the group's colour; each bot's at the left, its picture beside the first bubble of its run and its
 * name (in its colour) over it; the ⋯ beside it for who and when, and Copy. AppuBot's notes centred.
 */
function RoomMessage({ m, prev, next, members, mine }: { m: GroupMessage; prev: GroupMessage | undefined; next: GroupMessage | undefined; members: readonly Bot[]; mine: { fill: string; ink: string } }) {
  const bot = useStore((s) => (m.from.kind === 'bot' ? s.bots.find((b) => b.id === m.from.botId) : undefined));
  // files attached by path ("Files: …" lines) as the chat's path chips, the rest with @Name as the bot's chip
  const { body, paths } = useMemo(() => splitFileLines(m.text), [m.text]);
  const text = useMemo(() => linkMentions(body, members), [body, members]);
  const first = !sameRun(prev, m);
  const themed = useMessagesTheme();
  // a chat's rhythm: 14px under each author's last bubble, 3px between bubbles of one run
  const gap = sameRun(m, next) ? 'pb-[3px]' : 'pb-3.5';
  if (m.from.kind === 'system') {
    return <div className="flex justify-center px-1 pb-3.5"><span className="ab-pill squircle rounded-control-sm bg-surface-2 px-3 py-1 text-note text-muted">{m.text}</span></div>;
  }
  const inRun = sameRun(m, next);
  const spot = first ? (inRun ? 'first' : 'only') : inRun ? 'middle' : 'last';
  if (m.from.kind === 'user') {
    return (
      // the room's grey and ink, resolved here (a custom property's var() is read where it is set), so the bubble below
      // can set --ab-fg for its own text without its fill following it
      <div className={cn('group/msg flex w-full items-center justify-end gap-1.5 px-1', gap)} style={{ '--ab-room-sent': 'color-mix(in srgb, var(--ab-fg) 13%, var(--ab-content))', '--ab-room-sent-ink': 'var(--ab-fg)' } as React.CSSProperties}>
        <MessageDetails m={m} />
        {themed ? (
          // the Messages theme: the theme's own bubble, the run's last one with the tail
          <Bubble side="out" at={m.createdAt} spot={spot} className="w-max max-w-[80%]">
            {paths.length ? <div className="mb-1.5 flex flex-wrap justify-end gap-1.5 last:mb-0">{paths.map((p) => <PathChip key={p} path={p} />)}</div> : null}
            {text ? <ChatMarkdown text={text} variant="user" /> : null}
          </Bubble>
        ) : (
        <div
          className={cn(SENT_BUBBLE, 'max-w-[80%]')}
          style={{ backgroundColor: mine.fill, color: mine.ink, '--ab-fg': mine.ink, '--ab-link': mine.ink } as React.CSSProperties}
        >
          {paths.length ? <div className="mb-1.5 flex flex-wrap justify-end gap-1.5 last:mb-0">{paths.map((p) => <PathChip key={p} path={p} />)}</div> : null}
          {text ? <ChatMarkdown text={text} variant="user" /> : null}
        </div>
        )}
      </div>
    );
  }
  const name = groupAuthorName(m.from);
  return (
    <div className={cn('group/msg flex w-full items-start gap-2 px-1', gap)}>
      <span className="w-[28px] shrink-0">{first ? (bot ? <BotAvatar bot={bot} size={28} still /> : <span className="grid size-7 place-items-center rounded-full bg-surface-2 text-muted"><Icon icon={Users} size={13} /></span>) : null}</span>
      {themed ? (
        <Bubble side="in" at={m.createdAt} spot={spot} className="w-fit max-w-[80%]">
          {first ? <div className="mb-0.5 truncate text-ui leading-5 font-semibold" style={{ color: bot ? `color-mix(in srgb, ${bot.color} 82%, var(--ab-fg))` : undefined }}>{name}</div> : null}
          <ChatMarkdown text={text} />
        </Bubble>
      ) : (
      <div className="flex min-w-0 flex-1 flex-col items-start">
        {first ? <div className="mb-1 max-w-full truncate pl-1 text-note leading-4 font-semibold" style={{ color: bot ? `color-mix(in srgb, ${bot.color} 82%, var(--ab-fg))` : undefined }}>{name}</div> : null}
        <div className="flex max-w-full min-w-0 items-center gap-1.5">
          <div className={cn(REPLY_BUBBLE, BUBBLE_CORNERS[spot])}>
            <ChatMarkdown text={text} />
          </div>
          <MessageDetails m={m} />
        </div>
      </div>
      )}
      {themed ? <MessageDetails m={m} /> : null}
    </div>
  );
}

/** a member at work, under the room's messages like a chat's working row: its avatar's working motion and for how long */
function MemberWorkingRow({ groupId, botId }: { groupId: string; botId: string }) {
  const bot = useStore((s) => s.bots.find((b) => b.id === botId));
  const needsYou = useStore((s) => s.threads.some((t) => t.source === 'group' && t.groupId === groupId && t.botId === botId && t.status === 'waiting'));
  const [since] = useState(() => Date.now());
  if (!bot) return null;
  return (
    <div ref={syncAnimationsToTimelineOrigin} role="status" className="flex w-fit items-center gap-2 px-1 py-1">
      <BotAvatar bot={bot} size={26} mood={needsYou ? 'needs-you' : 'working'} />
      <span className={cn('text-copy leading-normal text-muted', !needsYou && 'shimmer-group')}>
        {needsYou ? `${bot.name} is waiting for you` : <>{bot.name} is working · <span className="tabular-nums"><LiveElapsed since={since} /></span></>}
      </span>
    </div>
  );
}

type QuestionPart = Extract<Part, { type: 'question' }>;

/** The members' own threads for one of the group's threads (each answers it in a hidden thread of its own). */
function useMemberThreads(group: Group, chatId: string): Thread[] {
  const threads = useStore((s) => s.threads);
  return useMemo(() => threads.filter((t) => t.source === 'group' && t.groupId === group.id && (t.groupChatId ?? group.id) === chatId), [threads, group.id, chatId]);
}

/**
 * What the members ask while they work (a question, a form, a Vault card, a request card): it is raised in the
 * member's hidden thread, so the room reads it from there and shows it here under the messages, as the bot's chat
 * would, answered in place.
 */
function RoomAsks({ group, chatId }: { group: Group; chatId: string }) {
  const mine = useMemberThreads(group, chatId);
  const busy = useMemo(() => mine.filter((t) => t.status === 'waiting' || t.status === 'running'), [mine]);
  // a member waiting on a question: read its thread (the question card's form comes with the message)
  useEffect(() => { for (const t of busy) void loadConversation(t.id); }, [busy]);
  const convo = useStore((s) => s.convo);
  const bots = useStore((s) => s.bots);
  const asks = useMemo(() => busy.flatMap((t) => {
    const c = convo[t.id];
    if (!c) return [];
    const last = [...c.ids].reverse().map((id) => c.byId[id]).find((m) => m?.role === 'agent');
    if (!last) return [];
    return last.parts.filter((p): p is QuestionPart => p.type === 'question' && p.answer === undefined && p.values === undefined && !p.declined).map((part) => ({ part, bot: bots.find((b) => b.id === t.botId) }));
  }), [busy, convo, bots]);
  if (!asks.length) return null;
  return (
    <>
      {asks.map(({ part, bot }) => (
        <div key={part.questionId} className="flex w-full items-end gap-2 px-1 pb-3.5">
          <span className="w-[26px] shrink-0">{bot ? <BotAvatar bot={bot} size={26} mood="needs-you" /> : null}</span>
          <div className="min-w-0 max-w-[88%] flex-1">
            {part.form ? <FormCard part={part} botName={bot?.name ?? 'A bot'} botId={bot?.id} expired={false} /> : <QuestionCard part={part} botName={bot?.name ?? 'A bot'} expired={false} />}
          </div>
        </div>
      ))}
    </>
  );
}

/** The members' approvals waiting in their hidden threads for this group thread: docked on the room's composer, as in a chat. */
function useRoomApprovals(group: Group, chatId: string) {
  const mine = useMemberThreads(group, chatId);
  const all = useStore((s) => s.pendingPermissions);
  return useMemo(() => { const ids = new Set(mine.map((t) => t.id)); return all.filter((p) => ids.has(p.threadId)).sort((a, b) => a.createdAt - b.createdAt); }, [mine, all]);
}

/**
 * The model every member answers this group on (`Group.providerId`/`modelId`/`effort`): "Each bot's own" until one is
 * picked, then that agent and model for all of them (each in its own group thread), with its effort.
 */
function GroupModelPicker({ group }: { group: Group }) {
  const fallback = useStore((s) => s.settings?.defaultProviderId ?? 'claude-code');
  const defaultEffort = useStore((s) => s.settings?.defaultEffort ?? 'medium');
  const picked = !!group.providerId;
  const providerId = group.providerId ?? fallback;
  return (
    <ModelPicker
      context="bot"
      variant="chrome"
      side="top"
      align="end"
      label="Model for this group"
      providerId={providerId}
      modelId={group.modelId ?? ''}
      effort={group.effort ?? ''}
      defaultEffort={defaultEffort}
      // nothing picked: no effort to set (each bot keeps its own)
      efforts={picked ? undefined : []}
      unset={{ label: "Each bot's own model", on: !picked, onReset: () => void updateGroup(group.id, { providerId: '' }) }}
      onChange={(n) => void updateGroup(group.id, {
        ...(n.providerId !== undefined && n.providerId !== group.providerId ? { providerId: n.providerId, modelId: n.modelId ?? '' } : n.modelId !== undefined ? { modelId: n.modelId } : {}),
        ...(n.effort !== undefined ? { effort: n.effort } : {}),
      })}
    />
  );
}

function RoomComposer({ group, chatId, working, members }: { group: Group; chatId: string; working: boolean; members: readonly Bot[] }) {
  const pending = useRoomApprovals(group, chatId);
  // the group's goal in this thread, if one is on or just ended
  const goal = groupChats(group).find((c) => c.id === chatId)?.goal;
  const asker = useStore((s) => (pending.length ? s.bots.find((b) => b.id === pending[0]!.botId) : undefined));
  // the + menu: name a member (they answer it) or everyone (typing @ offers the same, at the caret: Composer's menu)
  const mentionItems = useCallback((insert: (text: string) => void): MenuItem[] => [
    ...members.map((b) => ({ label: `Ask ${b.name}`, leading: <BotAvatar bot={b} size={16} still />, onSelect: () => insert(`@${b.name} `) })),
    ...(members.length > 1 ? [{ label: 'Ask everyone', icon: Users, onSelect: () => insert('@everyone ') }] : []),
  ], [members]);
  // the chat's own composer, words only: the room takes no files, and the pickers under it belong to a bot's thread
  return (
    <div className="relative shrink-0 px-5 pb-4">
      <div className="chat-column">
        {pending.length ? <ApprovalBar requests={pending} botName={asker?.name ?? 'A bot'} /> : goal ? <GoalCard goal={goal} unit="messages" onAct={(action) => void call('groups.goal', { id: group.id, ...(chatId !== group.id ? { chatId } : {}), action }, { errorTitle: 'Couldn’t change the goal' })} /> : null}
        <Composer
          key={chatId}
          docked={pending.length > 0}
          draftKey={`group:${chatId}`}
          placeholder={`Message ${group.name}`}
          plain
          onStop={working ? () => void stopGroup(group.id) : undefined}
          addItems={mentionItems}
          mentionable={members}
          footer={<GroupModelPicker group={group} />}
          onVoiceText={(text) => void sendGroupMessage(group.id, chatId, text)}
          onSend={async (text) => { await sendGroupMessage(group.id, chatId, text); return true; }}
        />
      </div>
    </div>
  );
}

/** What an empty group's landing offers: things a few bots really do together, the first always the same. */
function groupSuggestions(members: readonly Bot[]): string[] {
  const [a, b] = members;
  return [
    '@everyone say hi and what you can each do',
    ...(a && b ? [`@${a.name} draft a short post about what we're building, then @${b.name} check it`] : []),
    'Plan a small product launch and split the work between you',
    'Research three competitors and write one short summary together',
  ].slice(0, 4);
}

/**
 * An empty group thread (the chat's own landing, EmptyThread): the group's turning ring of bots, "Message <group>",
 * who is in it and who leads, and a few things to hand them that send on click. GroupView puts the dithered field behind.
 */
function GroupLanding({ group, members, loaded, onPick }: { group: Group; members: readonly Bot[]; loaded: boolean; onPick: (text: string) => void }) {
  const suggestions = useMemo(() => groupSuggestions(members), [members]);
  const lead = members.find((b) => b.id === group.leadId) ?? members.find((b) => b.chief);
  const names = members.map((b) => b.name);
  const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? 'No bots yet';
  return (
    <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 pb-8">
      <div className="chat-column flex animate-[message-enter_240ms_var(--ease-out-quint)_both] flex-col items-center text-center">
        <GroupTile members={[...members]} size={members.length > 1 ? 76 : 44} />
        <h1 className="mt-4 text-[30px] leading-[1.15] font-normal tracking-[-0.015em] text-fg/95">Message {group.name}</h1>
        <p className="mt-2 max-w-[30rem] text-copy leading-relaxed text-muted">
          {loaded ? `${who} work this out together${lead ? `; ${lead.name} leads and hands out the parts` : ''}. Name one with @ to ask it alone.` : 'Loading…'}
        </p>
        {loaded && members.length ? (
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {suggestions.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onPick(t)}
                className="ab-press ab-pill squircle inline-flex h-9 items-center rounded-control bg-[color-mix(in_srgb,var(--ab-fg)_5%,var(--ab-content))] px-3.5 text-copy font-medium text-fg-2 shadow-edge hover:bg-[color-mix(in_srgb,var(--ab-fg)_9%,var(--ab-content))] hover:text-fg focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-bg),0_0_0_4px_var(--ab-ring)]"
              >
                {t}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function GroupView() {
  const group = useStore((s) => s.groups.find((g) => g.id === s.selectedGroupId));
  const chat = group ? currentGroupChat(group) : undefined;
  const chatId = chat?.id;
  const messages = useStore((s) => (chatId ? s.groupMessages[chatId] : undefined)) ?? [];
  const loaded = useStore((s) => (chatId ? !!s.groupLoaded[chatId] : false));
  const conn = useStore((s) => s.conn);
  const { animatedBackground } = useAppearancePrefs();
  const allBots = useStore((s) => s.bots);
  const members = useMemo(() => (group ? group.botIds.map((b) => allBots.find((x) => x.id === b)).filter((b): b is Bot => !!b) : []), [group, allBots]);
  const scroller = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  const id = group?.id;
  useEffect(() => { if (id && chatId && conn === 'connected') void loadGroup(id, chatId); }, [id, chatId, conn, loaded]);
  // the members working in this thread (a computer from before threads doesn't say where: all of them)
  const working = group ? group.working.filter((b) => !group.workingIn?.[b] || group.workingIn[b] === chatId) : [];
  // follow the end while new messages come, unless the user scrolled up
  const count = messages.length;
  const busy = working.join(',');
  useLayoutEffect(() => { const el = scroller.current; if (el && stuck) el.scrollTop = el.scrollHeight; }, [count, busy, chatId, stuck]);
  useEffect(() => { setStuck(true); }, [chatId]);
  const onScroll = () => { const el = scroller.current; if (!el) return; setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 48); };
  // the chat's date lines too: at the start and wherever the room picks up again after a while
  const rows = useMemo(() => {
    const list = messages.filter((m) => groupChatOf(m) === chatId);
    const labels = conversationSeparators(list);
    return list.map((m, i, l) => ({ m, prev: labels[i] ? undefined : l[i - 1], next: labels[i + 1] ? undefined : l[i + 1], label: labels[i] ?? null }));
  }, [messages, chatId]);
  // your bubbles wear the group's colour (its lead's, else its first member's), as a chat's wear its bot's
  // your own messages in a room are a neutral grey a step lighter than the bots' bubbles, never a bot's colour: in a
  // room of several bots one bot's colour reads as that bot's (the owner's call, 2026-11-18)
  const mine = { fill: 'var(--ab-room-sent)', ink: 'var(--ab-room-sent-ink)' };
  if (!group || !chat || !chatId) return null;
  const empty = !rows.length && !working.length;
  // a tap on the field ripples in a member's colour, a different one at random each time
  const memberColours = members.map((b) => b.color);
  return (
    <div className="chat-wallpaper flex h-full min-w-0 flex-1 flex-col">
      <GroupHeader group={group} chat={chat} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* the chat's landing: the dithered field fills an empty thread, continuous under the composer */}
        {empty && animatedBackground ? <DitherBackground colours={memberColours} /> : null}
        {empty ? (
          <GroupLanding key={chatId} group={group} members={members} loaded={loaded} onPick={(text) => void sendGroupMessage(group.id, chatId, text)} />
        ) : (
          // the transcript's own frame: a 20px gutter, the scrollbar's track outside the chat's column, its resting gap at the end
          <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 [scrollbar-gutter:stable]">
            <div className="chat-column flex flex-col pt-4">
              {rows.map(({ m, prev, next, label }) => (
                <Fragment key={m.id}>
                  {label ? <Separator label={label} /> : null}
                  <RoomMessage m={m} prev={prev} next={next} members={members} mine={mine} />
                </Fragment>
              ))}
              <RoomAsks group={group} chatId={chatId} />
              {working.map((b) => <MemberWorkingRow key={b} groupId={group.id} botId={b} />)}
              <div aria-hidden className="h-11 shrink-0" />
            </div>
          </div>
        )}
        <RoomComposer group={group} chatId={chatId} working={working.length > 0} members={members} />
      </div>
    </div>
  );
}
