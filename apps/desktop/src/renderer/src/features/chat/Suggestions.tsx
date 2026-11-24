/**
 * The row of pills under a bot's latest reply (ThreadView passes it to the transcript as its footer): first what the
 * system still has to allow (ThreadView's own pills), then a random few things to try next, picked by chat-core
 * `pickSuggestions` from what this person hasn't done yet (no apps connected, no phone, no Telegram, no routine...).
 * An ask is sent to the bot as a message; a setup opens its place in AppuBot. Each pill's ✕ (under the pointer) puts
 * it away for this run, and one used isn't offered again in this run.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Bot } from '@appubot/protocol';
import { appOn } from '@appubot/protocol';
import { activeSlugs, pickSuggestions, type SuggestionFacts, type SuggestionId } from '@appubot/chat-core';
import {
  Bell, Bot as BotIcon, Brain, CalendarClock, Cloud, Download, FolderOpen, GraduationCap, Mail, MessageCircle, Mic,
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
export function SetupPill({ icon, label, onAction, onDismiss, chip }: { icon: typeof Bell; label: string; onAction: () => void; onDismiss: () => void; chip?: boolean }) {
  return (
    <span className="group/pill relative inline-flex max-w-full">
      <button
        type="button"
        onClick={onAction}
        className={chip
          ? cn(LANDING_CHIP, 'max-w-full gap-2')
          : 'ab-pill ab-press squircle inline-flex h-8 max-w-full items-center gap-2 rounded-control bg-surface-2 pr-3.5 pl-3 text-copy text-fg outline-none transition-colors hover:bg-surface-3 focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]'}
      >
        <Icon icon={icon} size={15} className="shrink-0 text-fg-2" />
        <span className="truncate">{label}</span>
      </button>
      <button
        type="button"
        aria-label={`Not now: ${label}`}
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
  const appSlugs = useMemo(() => (connections ? activeSlugs(connections).filter((slug) => appOn(bot, slug)) : undefined), [connections, bot.appsOff]);
  if (!hydrated) return { botName: bot.name, bots, routines };
  return {
    botName: bot.name, bots, routines, groups, phonePaired, telegram,
    appsSignedIn: apps ? apps.configured : undefined,
    apps: apps?.configured ? appSlugs : undefined,
    computerUse: bot.computerUse && computerOn,
    voice,
    teach: TEACH && !lacks.teach,
    cloudOffer,
  };
}

/** The suggestion pills for the reply `seed` names, at most `room` of them. */
export function SuggestionPills({ bot, threadId, seed, room }: { bot: Bot; threadId: string; seed: string; room: number }) {
  const facts = useFacts(bot);
  const [, redraw] = useState(0);
  const picked = useMemo(() => pickSuggestions(facts, `${bot.id}:${seed}`, room, hidden), [facts, seed, room, bot.id, hidden.size]);
  const away = (id: SuggestionId) => { hidden.add(id); redraw((n) => n + 1); };
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
  return (
    <>
      {picked.map((s) => (
        <SetupPill key={s.id} icon={ICONS[s.id]} label={s.label} onAction={() => run(s.id, s.label, s.kind)} onDismiss={() => away(s.id)} />
      ))}
    </>
  );
}
