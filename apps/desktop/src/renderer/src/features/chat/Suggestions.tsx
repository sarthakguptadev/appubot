/**
 * The row of pills under a bot's latest reply (ThreadView passes it to the transcript as its footer): first what the
 * system still has to allow (ThreadView's own pills), then what the bot itself offered as the next step with that
 * reply (its follow-ups: chat-core followUps.ts), then a random few things to try next, picked by chat-core
 * `pickPills` from what this person hasn't done yet (no apps connected, no phone, no Telegram, no routine...): two to
 * five of them, fewer beside the bot's own. A follow-up or an ask is sent to the bot as a message; a setup opens its
 * place in AppuBot. A pill's ✕ (under the pointer) puts the whole row of suggestions away for that reply, and pressing
 * a pill sends it and does the same (the owner's "if kross one dont show else", 2026-11-27); either way that pill
 * isn't offered again in this run. A short reply ("Sent!", chat-core `shortReply`) gets no suggestions at all.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Bot } from '@appubot/protocol';
import { appOn } from '@appubot/protocol';
import { activeSlugs, cleanFollowUps, followUpKey, pickPills, shortReply, type SuggestionFacts, type SuggestionId } from '@appubot/chat-core';
import {
  ArrowRight, Bell, Bot as BotIcon, Brain, CalendarClock, Cloud, Download, FolderOpen, GraduationCap, Mail, MessageCircle, Mic,
  Search, Smartphone, Sparkles, Telegram, Users, X, Zap,
} from '../../components/ui/icons';
import { Icon, cn } from '../../components/ui';
import { LANDING_CHIP } from './EmptyThread';
import { sendMessage } from '../../lib/actions';
import { TEACH } from '../../lib/platform';
import { ui, useStore } from '../../lib/store';
import { loadAppsStatus, loadConnections, useAppsUi } from '../apps/appsData';
import { useCloudOfferEligible } from '../cloud/cloudOffer';
import { useCloudLacks } from '../cloud/useCloudLacks';
import { useVoiceRoute } from '../voice/macVoice';
import { startVoice } from '../voice/useVoiceConversation';

/**
 * One pill: an icon and what pressing it does, in a row that wraps (the owner's call, 2026-11-17). Its small ✕, shown
 * under the pointer, puts it away for this run. `chip`: in an empty chat it is one of the landing's own chips, in
 * their row (a filled pill of its own over the composer's corner read as a stray button: "fix the let olive btn").
 */
export function SetupPill({ icon, label, onAction, onDismiss, chip, dismissLabel = `Not now: ${label}` }: { icon: typeof Bell; label: string; onAction: () => void; onDismiss: () => void; chip?: boolean; dismissLabel?: string }) {
  return (
    <span className="group/pill relative inline-flex max-w-full">
      <button
        type="button"
        onClick={onAction}
        className={chip
          ? cn(LANDING_CHIP, 'max-w-full gap-2')
          : 'ab-pill ab-press squircle inline-flex h-8 max-w-full items-center gap-2 rounded-control bg-surface-2 pr-3.5 pl-3 text-copy text-fg outline-none hover:bg-surface-3 focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]'}
      >
        <Icon icon={icon} size={15} className="shrink-0 text-fg-2" />
        <span className="truncate">{label}</span>
      </button>
      <button
        type="button"
        aria-label={dismissLabel}
        onClick={onDismiss}
        className="absolute -top-1.5 -right-1.5 hidden size-[18px] place-items-center rounded-full bg-surface-3 text-muted shadow-[0_0_0_2px_var(--ab-content)] outline-none hover:text-fg focus-visible:grid group-hover/pill:grid"
      >
        <Icon icon={X} size={10} strokeWidth={2.5} />
      </button>
    </span>
  );
}

const ICONS: Record<SuggestionId, typeof Bell> = {
  morning: CalendarClock, 'inbox-bot': BotIcon, remember: Brain, 'what-can-you-do': Sparkles, 'plan-week': CalendarClock,
  inbox: Mail, calendar: CalendarClock, slack: MessageCircle, github: Zap, notion: Search, downloads: FolderOpen,
  'find-file': Search, 'team-ask': Users,
  apps: Mail, phone: Smartphone, telegram: Telegram, voice: Mic, teach: GraduationCap, group: Users, import: Download, cloud: Cloud,
};

/** put away or used in this run (the same for every chat) */
const hidden = new Set<SuggestionId>();
/** a bot's follow-ups put away or used in this run, by the reply they came with and the line */
const hiddenFollowUps = new Set<string>();
/** the replies whose row of suggestions was put away (a ✕ pressed or a pill used) in this run, by chat and reply */
const hiddenRows = new Set<string>();

/** What is known about this person and bot, for `pickSuggestions`; a fact not read yet stays undefined. */
function useFacts(bot: Bot): SuggestionFacts {
  const hydrated = useStore((s) => s.hydrated);
  const bots = useStore((s) => s.bots.length);
  const firstBot = useStore((s) => s.bots[0]?.id);
  const routines = useStore((s) => s.routines.filter((r) => r.botId === bot.id).length);
  const groups = useStore((s) => (s.groupsSupported ? s.groups.length : undefined));
  const phonePaired = useStore((s) => s.devices.some((d) => d.platform === 'ios' || d.platform === 'android'));
  const telegram = useStore((s) => s.channels.some((c) => (c.botId ?? firstBot) === bot.id && !!c.botUsername));
  const computerOn = useStore((s) => !!s.settings?.computer.enabled);
  const apps = useStore((s) => s.apps);
  const conn = useStore((s) => s.conn);
  const connections = useAppsUi((s) => s.connections);
  const lacks = useCloudLacks();
  const voice = useVoiceRoute().hear !== null;
  const cloudOffer = useCloudOfferEligible();
  // the apps' state is read once where no view has read it yet (Apps, Settings)
  useEffect(() => {
    if (conn !== 'connected') return;
    if (!apps) void loadAppsStatus();
    else if (apps.configured && !connections) void loadConnections();
  }, [conn, apps?.configured, !!connections]);
  const connected = useMemo(() => (connections ? activeSlugs(connections) : undefined), [connections]);
  const appSlugs = useMemo(() => connected?.filter((slug) => appOn(bot, slug)), [connected, bot.appsOff]);
  if (!hydrated) return { botName: bot.name, bots, routines };
  return {
    botName: bot.name, bots, routines, groups, phonePaired, telegram,
    appsSignedIn: apps ? apps.configured : undefined,
    apps: apps?.configured ? appSlugs : undefined,
    connected: apps?.configured ? connected : undefined,
    computerUse: bot.computerUse && computerOn,
    voice,
    teach: TEACH && !lacks.teach,
    cloudOffer,
  };
}

/**
 * The pills for the reply `seed` names, at most `room` of them: the bot's own `followUps` for it, then the app's
 * suggestions. Which and how many is decided by the reply (chat-core `pickPills`), so they are the same on every
 * redraw, in another window and after a restart.
 */
export function SuggestionPills({ bot, threadId, seed, room, followUps }: { bot: Bot; threadId: string; seed: string; room: number; followUps?: readonly string[] }) {
  const facts = useFacts(bot);
  const [, redraw] = useState(0);
  // what the person wrote in this chat: nothing they already asked is offered again
  const conv = useStore((s) => s.convo[threadId]);
  const sent = useMemo(() => (conv ? conv.ids.flatMap((id) => {
    const m = conv.byId[id];
    return m?.role === 'user' ? [m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(' ')] : [];
  }) : []), [conv]);
  const offered = useMemo(() => cleanFollowUps(followUps ?? []).filter((line) => !hiddenFollowUps.has(`${seed}\n${followUpKey(line)}`)), [followUps, seed, hiddenFollowUps.size]);
  const picked = useMemo(() => pickPills({ facts, seed: `${bot.id}:${seed}`, room, hide: hidden, followUps: offered, sent }), [facts, seed, room, bot.id, hidden.size, offered, sent]);
  const row = `${threadId}\n${seed}`;
  const away = (id: SuggestionId) => { hidden.add(id); hiddenRows.add(row); redraw((n) => n + 1); };
  const followUpAway = (line: string) => { hiddenFollowUps.add(`${seed}\n${followUpKey(line)}`); hiddenRows.add(row); redraw((n) => n + 1); };
  const run = (id: SuggestionId, label: string, kind: 'ask' | 'setup') => {
    away(id);
    if (kind === 'ask') { void sendMessage(bot.id, threadId, label, []); return; }
    switch (id) {
      case 'apps': ui.openApps(); break;
      case 'phone': ui.openModal({ kind: 'pair' }); break;
      case 'telegram': ui.openSettings('channels'); break;
      case 'voice': startVoice(bot.id, threadId); break;
      case 'teach': ui.openModal({ kind: 'teach' }); break;
      case 'group': ui.openModal({ kind: 'group' }); break;
      case 'import': ui.openSettings('import'); break;
      case 'cloud': ui.openSettings('billing'); break;
      default: break;
    }
  };
  const reply = conv?.byId[seed];
  if (hiddenRows.has(row) || (reply?.role === 'agent' && shortReply(reply.parts))) return null;
  return (
    <>
      {picked.followUps.map((line) => (
        <SetupPill key={`follow-up:${line}`} icon={ArrowRight} label={line} onAction={() => { followUpAway(line); void sendMessage(bot.id, threadId, line, []); }} onDismiss={() => followUpAway(line)} dismissLabel="Hide suggestions" />
      ))}
      {picked.suggestions.map((s) => (
        <SetupPill key={s.id} icon={ICONS[s.id]} label={s.label} onAction={() => run(s.id, s.label, s.kind)} onDismiss={() => away(s.id)} dismissLabel="Hide suggestions" />
      ))}
    </>
  );
}
