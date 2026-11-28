import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { currentChat, type PermissionRequest } from '@appubot/protocol';
import { threadTitle } from '@appubot/chat-core';
import { Bell, MonitorSmartphone, Plus, ShieldQuestion } from '../../components/ui/icons';
import { Button, EmptyState, Icon } from '../../components/ui';
import { openThread, sendMessage } from '../../lib/actions';
import { rpc } from '../../lib/gateway';
import { MACHINE, THIS_MACHINE } from '../../lib/platform';
import { selectSelectedBot, selectSelectedThread, ui, useStore } from '../../lib/store';
import { ApprovalBar } from './ApprovalBar';
import { GoalBar } from './GoalBar';
import { ChatHeader } from './ChatHeader';
import { NOTICE_LINE } from './NoticeCard';
import { Composer } from './Composer';
import { useComputerAccessMissing, useRecheckOnFocus } from '../computer/PermissionRows';
import { turnOnNotifications, useNotificationsBlocked } from '../notifications/access';
import { PERMISSIONS_TITLE, settingAnchorId } from '../settings/nav';
import { EmptyThread } from './EmptyThread';
import { VoiceView } from '../voice/VoiceView';
import { VoiceDownloadNotice, useVoiceDownload } from '../voice/DownloadNotice';
import { Transcript } from './Transcript';
import { SetupPill, SuggestionPills } from './Suggestions';
import { ThreadSearch } from './ThreadSearch';
import { QuoteSelection } from './QuoteSelection';
import { CloudStateNotice, useCloudNoticeKind } from '../cloud/CloudStateNotice';
import { CreditNotice, useCreditExhausted } from '../cloud/CreditNotice';
import { ClaudeSetupNotice, useClaudeSetup } from '../cloud/ClaudeSetupNotice';
import { useCloudLacks } from '../cloud/useCloudLacks';

const NONE: PermissionRequest[] = [];

/** Approvals waiting in another thread of the bot: a quiet line above the composer that opens that thread. */
function ElsewhereNotice({ requests }: { requests: PermissionRequest[] }) {
  const req = requests[0]!;
  const title = useStore((s) => threadTitle(s.threads.find((t) => t.id === req.threadId)));
  const more = new Set(requests.map((r) => r.threadId)).size - 1;
  return (
    <motion.div
      role="status"
      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      className={NOTICE_LINE}
    >
      <Icon icon={ShieldQuestion} size={14} className="shrink-0 text-warning" />
      <p className="min-w-0 flex-1 truncate text-fg-2">
        Waiting for you in <span className="text-fg">“{title}”</span>
        {more > 0 ? <span className="text-muted"> and {more} other thread{more > 1 ? 's' : ''}</span> : null}
      </p>
      <Button size="xs" variant="secondary" onClick={() => void openThread(req.threadId)}>Open</Button>
    </motion.div>
  );
}

/** notices dismissed for this run of the app ("Not now"), not for good: they come back after a restart */
const dismissedNotices = new Set<'computer' | 'notifications'>();

/**
 * macOS: the bot uses the computer but Accessibility or Screen Recording isn't granted (onboarding's step was skipped,
 * or a new build lost the grant). The pill opens Settings › Permissions, where each one is named with its state.
 */
function ComputerAccessPill({ botName, onDismiss, chip }: { botName: string; onDismiss: () => void; chip?: boolean }) {
  useRecheckOnFocus();
  return (
    <SetupPill
      chip={chip}
      icon={MonitorSmartphone} label={`Let ${botName} use your ${MACHINE}`}
      onAction={() => ui.openSettings('permissions', settingAnchorId(PERMISSIONS_TITLE))} onDismiss={onDismiss}
    />
  );
}

/** The OS hides AppuBot's notifications: the user won't hear when a bot finishes, needs approval or asks something. */
function NotificationsPill({ onDismiss, chip }: { onDismiss: () => void; chip?: boolean }) {
  return <SetupPill chip={chip} icon={Bell} label="Turn on notifications" onAction={() => void turnOnNotifications()} onDismiss={onDismiss} />;
}

/**
 * The chat card: header strip, the thread on screen (or the bot's landing before that thread has a message), and the
 * composer with that thread's approvals docked on it. Turns go to the thread on screen; approvals from the bot's
 * other threads show as a notice that opens them.
 */
export function ThreadView() {
  const bot = useStore(selectSelectedBot);
  const thread = useStore(selectSelectedThread);
  const threads = useStore((s) => s.threads);
  const allPending = useStore((s) => s.pendingPermissions);
  // docked: the thread on screen's and a Telegram chat's (the same bot asking, answered here); others: a notice
  const [docked, elsewhere] = useMemo(() => {
    if (!bot) return [NONE, NONE];
    // a group thread's approvals show in the room (GroupView), never here
    const mine = allPending.filter((p) => p.botId === bot.id && threads.find((t) => t.id === p.threadId)?.source !== 'group').sort((a, b) => a.createdAt - b.createdAt);
    const here = (p: PermissionRequest) => p.threadId === thread?.id || threads.find((t) => t.id === p.threadId)?.source === 'channel';
    return [mine.filter(here), mine.filter((p) => !here(p))];
  }, [allPending, bot, thread?.id, threads]);
  // a bot with other threads that have messages: its empty one is a fresh start
  const accessMissing = useComputerAccessMissing();
  const computerOn = useStore((s) => !!s.settings?.computer.enabled);
  const notificationsBlocked = useNotificationsBlocked();
  // voice mode for this bot's chat takes the column over (it shows the models' download itself); else a download runs
  // in the background
  const reduce = useReducedMotion();
  const voiceHere = useStore((s) => !!bot && s.voiceMode?.botId === bot.id);
  const voiceDownload = useVoiceDownload();
  // on the cloud computer: waking, payment on hold, plan ended (features/cloud)
  const cloudNotice = useCloudNoticeKind();
  const creditOut = useCreditExhausted(thread?.providerId);
  // Claude Code still setting itself up on the cloud computer (its first start)
  const claudeSetup = !!useClaudeSetup(thread?.providerId ?? bot?.providerId);
  const [dismissed, setDismissed] = useState(() => new Set(dismissedNotices));
  const dismiss = (k: 'computer' | 'notifications') => { dismissedNotices.add(k); setDismissed(new Set(dismissedNotices)); };
  // the cloud computer has no system permissions to give, and its notices are this Mac's own business
  const lacks = useCloudLacks();
  const showAccess = !!bot?.computerUse && computerOn && accessMissing && !lacks.permissions && !dismissed.has('computer');
  // this Mac's own notifications, also with an AppuBot computer on screen (its bots' notices show here)
  const showNotifications = notificationsBlocked && !dismissed.has('notifications');
  const isEmpty = useStore((s) => {
    if (!thread) return true;
    const c = s.convo[thread.id];
    return !!c && c.loaded && c.ids.length === 0;
  });
  // the chat's last message is a reply that has finished (or there is none yet)
  const lastSettled = useStore((s) => {
    if (!thread) return true;
    const c = s.convo[thread.id];
    const last = c?.ids.length ? c.byId[c.ids[c.ids.length - 1]!] : undefined;
    return !last || (last.role === 'agent' && last.status !== 'streaming');
  });
  // the reply the suggestions sit under: a new one gets a new random few
  const lastId = useStore((s) => {
    const c = thread ? s.convo[thread.id] : undefined;
    return c?.ids.length ? c.ids[c.ids.length - 1]! : '';
  });
  // what the bot offered as the next step with that reply: only while it is the chat's newest message
  const followUps = useStore((s) => {
    const c = thread ? s.convo[thread.id] : undefined;
    const last = c?.ids.length ? c.byId[c.ids[c.ids.length - 1]!] : undefined;
    return last?.role === 'agent' && last.status === 'complete' ? last.followUps : undefined;
  });

  // no model or mode pickers yet (a new bot or thread, or an agent no chat has used): start its agent so they arrive now
  const needsWarm = !!bot && (!thread || !thread.models.length || !thread.modes.length);
  useEffect(() => {
    // (a chat or bot shown before the computer has made it waits for its own id)
    if (needsWarm && bot && !bot.id.startsWith('local:') && !thread?.id.startsWith('local:')) rpc('threads.warm', { botId: bot.id, threadId: thread?.id }).catch(() => undefined);
  }, [needsWarm, bot?.id, bot?.providerId, thread?.id]);

  const send = useCallback(async (text: string, images: { mimeType: string; data: string }[], files?: File[]) => {
    if (!bot) { ui.openModal({ kind: 'new-bot' }); return false; }
    // files for a bot on a remote computer go over first, in the background (lib/outbox.ts)
    return sendMessage(bot.id, thread?.id ?? null, text, images, files?.length ? { blobs: files } : {});
  }, [bot, thread?.id]);

  // A thread never sits empty: one nobody has written in (made before bots opened their threads, or for a bot another
  // bot made) is opened when it comes on screen. `threads.start` returns the bot's current thread while nobody has
  // written in it and has the bot say the first thing there (core `ChatService.openThread`); a computer from before
  // returns it as it is. Once per thread a run, and only for the bot's current thread: on an older empty one it would
  // start another.
  const connected = useStore((s) => s.conn === 'connected' && s.hydrated);
  const opened = useRef(new Set<string>());
  const botId = bot?.id;
  const threadId = thread?.id;
  const idle = !thread || thread.status === 'idle';
  const isCurrent = useStore((s) => !!botId && (!threadId || currentChat(s.threads, botId)?.id === threadId));
  useEffect(() => {
    if (!botId || !connected || !idle || !isCurrent || !(isEmpty || !threadId)) return;
    // a thread still on its way to the computer (New thread just pressed) is opened by that very call
    if (threadId?.startsWith('local:')) return;
    const key = threadId ?? `bot:${botId}`;
    if (opened.current.has(key)) return;
    opened.current.add(key);
    void rpc('threads.start', { botId }).catch(() => undefined);
  }, [botId, threadId, connected, idle, isCurrent, isEmpty]);

  if (!bot) {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <div className="drag h-16 shrink-0" />
        <EmptyState
          className="flex-1 pb-20"
          title="Make your first bot"
          body={`A bot is a helper with its own job, workspace and memory. It works on ${THIS_MACHINE} and answers you on your phone and on Telegram.`}
          action={<Button variant="primary" icon={Plus} onClick={() => ui.openModal({ kind: 'new-bot' })}>New bot</Button>}
        />
      </div>
    );
  }

  // what the system still has to allow, as pills under the latest message: only under a reply that has finished
  // (never under the working row, a reply still streaming or your own message waiting for one), and only while
  // nothing else is being said
  const quiet = lastSettled && thread?.status !== 'running' && !docked.length && !elsewhere.length && !cloudNotice && !creditOut && !claudeSetup && voiceDownload === null;
  // an empty chat has no message to sit under: there they are chips of the landing's own row, after its suggestions
  const landingSetup = quiet && (showAccess || showNotifications) ? (
    <>
      {showAccess ? <ComputerAccessPill chip botName={bot.name} onDismiss={() => dismiss('computer')} /> : null}
      {showNotifications ? <NotificationsPill chip onDismiss={() => dismiss('notifications')} /> : null}
    </>
  ) : null;
  // under a finished reply, after those: the bot's own follow-ups for it, then a random few things to try next, from
  // what this person hasn't done yet (chat-core suggestions.ts); never in a chat with no reply yet (the landing has its
  // own) or one waiting on an answer
  const room = 5 - (showAccess ? 1 : 0) - (showNotifications ? 1 : 0);
  const footer = quiet && thread && lastId && thread.status !== 'waiting' ? (
    <div className="flex flex-wrap gap-2">
      {showAccess ? <ComputerAccessPill botName={bot.name} onDismiss={() => dismiss('computer')} /> : null}
      {showNotifications ? <NotificationsPill onDismiss={() => dismiss('notifications')} /> : null}
      <SuggestionPills bot={bot} threadId={thread.id} seed={lastId} room={room} followUps={followUps} />
    </div>
  ) : null;

  // one draft per thread (per bot until its first message makes one)
  const draftKey = thread ? `thread:${thread.id}` : `bot:${bot.id}`;
  return (
    // `chat-wallpaper`: the Messages theme's lines behind the whole chat column (themes/messages.css)
    // `--ab-bot`: the bot's colour, for what in its chat is tinted with it (a code block's theme: components/rare/codeBlock.css)
    <div className="chat-wallpaper flex h-full min-w-0 flex-1 flex-col" style={{ '--ab-bot': bot.color } as React.CSSProperties}>
      <ChatHeader bot={bot} thread={thread} />
      {/* presenceAffectsLayout off: with it on, motion rebuilds this presence's context on every render of the chat
          card, so every animated element in every message on screen drew again with it (bench/renderer.mjs: ~1000
          renders of the copy and reaction buttons' motion in one streamed reply); nothing inside lays out by presence */}
      <AnimatePresence mode="wait" initial={false} presenceAffectsLayout={false}>
        {voiceHere ? (
          <motion.div
            key="voice"
            className="flex min-h-0 flex-1 flex-col"
            initial={{ opacity: 0, scale: reduce ? 1 : 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: reduce ? 1 : 0.97 }}
            transition={{ duration: reduce ? 0 : 0.2, ease: 'easeOut' }}
          >
            <VoiceView bot={bot} approvals={docked} />
          </motion.div>
        ) : (
          <motion.div
            key="chat"
            className="relative flex min-h-0 flex-1 flex-col"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.15, ease: 'easeOut' }}
          >
            {/* no landing: the bot opens every thread itself (`openEmpty` above), so an empty one is only a moment */}
            {isEmpty || !thread ? (
              <EmptyThread key={thread?.id ?? bot.id} bot={bot} setup={landingSetup} />
            ) : (
              <>
                <Transcript key={thread.id} threadId={thread.id} botName={bot.name} cwd={thread.cwd || bot.workspace} footer={footer} />
                <ThreadSearch threadId={thread.id} />
                <QuoteSelection threadId={thread.id} />
              </>
            )}
            {/* the composer in the chat's column (the messages' edges), a 20px gutter at least, 16px under it */}
            <div className="relative shrink-0 px-5 pb-4">
              <div className="chat-column">
                <AnimatePresence initial={false}>
                  {elsewhere.length && !docked.length ? <ElsewhereNotice key="elsewhere" requests={elsewhere} /> : null}
                  {/* one at a time, below what's waiting for the user: approvals first
                      (what the system still has to allow is a row of pills under the latest message: `setupLine`) */}
                  {!docked.length && !elsewhere.length ? (
                    cloudNotice ? <CloudStateNotice key={`cloud-${cloudNotice}`} />
                      : creditOut ? <CreditNotice key="credit" providerId={thread?.providerId} />
                      : claudeSetup ? <ClaudeSetupNotice key="claude-setup" providerId={thread?.providerId ?? bot?.providerId} />
                      : voiceDownload !== null ? <VoiceDownloadNotice key="voice-download" progress={voiceDownload} />
                        : null
                  ) : null}
                  {thread?.goal && !docked.length ? <GoalBar key="goal" thread={thread} /> : null}
                  {docked.length ? <ApprovalBar key="approval" requests={docked} botName={bot.name} /> : null}
                </AnimatePresence>
                <Composer key={draftKey} thread={thread} bot={bot} draftKey={draftKey} onSend={send} docked={docked.length > 0} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
