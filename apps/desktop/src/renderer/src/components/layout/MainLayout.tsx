import { useEffect, useState } from 'react';
import { lazyComponent } from '../../lib/lazyComponent';
import { PREFETCH_DELAY_MS, loadConversation, prefetchChats, startThread } from '../../lib/actions';
import { isDialogOpen } from '../ui';
import { useHotkey } from '../../lib/hooks';
import { getState, ui, useStore } from '../../lib/store';
import { ThreadView } from '../../features/chat/ThreadView';
import { GroupView } from '../../features/groups/GroupView';
import { TeachBanner } from '../../features/skills/TeachBanner';
import { SupportWidget } from '../../features/support/SupportWidget';
import { useWhatsNewAutoOpen } from '../../features/whatsNew/WhatsNew';
import { useAgentUpdateNotices } from '../../features/providers/agentUpdates';
import { ReconnectBanner } from './Connection';
import { AppsPage, preloadDialogs } from './ModalHost';
import { RightPanel } from './RightPanel';
import { Sidebar } from './Sidebar';
import { CloudPane } from '../../features/cloud/CloudPane';
import { DesktopView } from '../../features/cloud/DesktopView';
import { MoveBotDialog } from '../../features/bots/MoveBotDialog';
import { useCloudLink, watchCloudCopies, watchCloudVisibility } from '../../features/cloud/cloudClient';
import { CloudSyncStrip } from '../../features/cloud/CloudSyncStrip';
import { markOnce } from '../../lib/perfMarks';
import { appearanceNow } from '../../lib/appearance';
import { loadMath } from '../../features/chat/Markdown';

function useShortcuts(): void {
  const cmd = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;
  useHotkey((e) => cmd(e) && e.key.toLowerCase() === 'k', () => {
    const m = getState().modal;
    if (m?.kind === 'quick') ui.closeModal(); else if (!isDialogOpen()) ui.openModal({ kind: 'quick' });
  });
  useHotkey((e) => cmd(e) && e.key === ',', () => ui.openSettings());
  // ⌘N: a new thread with the selected bot (settings and Apps step aside so you see it)
  useHotkey((e) => cmd(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n', () => {
    const s = getState();
    if (isDialogOpen() || !s.selectedBotId) return;
    if (s.settingsSection !== null) ui.closeSettings();
    if (s.appsOpen) ui.closeApps();
    void startThread(s.selectedBotId);
  });
  // ⌘1…⌘9 jump to the n-th bot
  useHotkey((e) => cmd(e) && !e.shiftKey && /^[1-9]$/.test(e.key), (e) => {
    const bot = getState().bots[Number(e.key) - 1];
    if (bot && !isDialogOpen()) ui.selectBot(bot.id);
  });
}

/** Mark the thread on screen read while the window has focus (Akeru: a visit only counts when you can see it). */
function useReadTracking(): void {
  const threadId = useStore((s) => s.selectedThreadId);
  const isUnread = useStore((s) => !!s.selectedThreadId && !!s.unread[s.selectedThreadId]);
  // the settings and Apps pages cover the chat
  const hidden = useStore((s) => s.settingsSection !== null || s.appsOpen || s.selectedGroupId !== null);
  useEffect(() => {
    if (!threadId || hidden) return;
    const mark = () => { if (document.hasFocus() && document.visibilityState === 'visible') ui.markRead(threadId); };
    mark();
    window.addEventListener('focus', mark);
    document.addEventListener('visibilitychange', mark);
    return () => { window.removeEventListener('focus', mark); document.removeEventListener('visibilitychange', mark); };
  }, [threadId, isUnread, hidden]);
}

// Settings (its pages, Billing's plan cards, Team…) isn't needed to show the chat: its code loads in a quiet moment
// after launch, or at once when it is opened first
const SettingsModal = lazyComponent(() => import('../../features/settings/SettingsView').then((m) => m.SettingsModal));

function SettingsHost() {
  const open = useStore((s) => s.settingsSection !== null);
  const [wanted, setWanted] = useState(open);
  if (open && !wanted) setWanted(true);
  useEffect(() => {
    const id = requestIdleCallback(() => setWanted(true), { timeout: 5000 });
    return () => cancelIdleCallback(id);
  }, []);
  // once loaded it stays mounted: it opens and closes (with its fade) by itself
  return wanted ? <SettingsModal /> : null;
}

export function MainLayout() {
  const selectedThreadId = useStore((s) => s.selectedThreadId);
  const appsOpen = useStore((s) => s.appsOpen);
  const groupOpen = useStore((s) => s.selectedGroupId !== null);
  useShortcuts();
  useReadTracking();
  useWhatsNewAutoOpen();
  useAgentUpdateNotices();
  useEffect(() => markOnce('appubot:main-painted', true), []);
  // what launch left out (KaTeX, the dialogs and the Apps page: chunks of their own) in a quiet moment, so a reply with
  // maths or a dialog opened later draws in its first frame
  useEffect(() => {
    const id = requestIdleCallback(() => { if (appearanceNow().math) void loadMath(); preloadDialogs(); }, { timeout: 8000 });
    return () => cancelIdleCallback(id);
  }, []);
  // the cloud computer's connection follows what the user looks at (plan §5.8): open while on screen, closed when not
  useEffect(() => watchCloudVisibility(), []);
  // its saved copy kept as it changes (shown at once on the next switch there)
  useEffect(() => watchCloudCopies(), []);
  // with no saved copy to show, the cloud's pane says it is waking; with one, the chat shows it (CloudSyncStrip)
  const cloudWaiting = useCloudLink((s) => s.computer === 'cloud' && !s.ready && !s.cached);

  // lazy-load the thread on screen whenever it changes (also after reconnects)
  const conn = useStore((s) => s.conn);
  const stale = useStore((s) => !!s.selectedThreadId && !s.convo[s.selectedThreadId]?.loaded);
  useEffect(() => {
    if (selectedThreadId && conn === 'connected') void loadConversation(selectedThreadId);
  }, [selectedThreadId, conn, stale]);
  // the chats opening a bot would show, fetched ahead once connected (and on each computer's hello), so they open at once
  const hydrated = useStore((s) => s.hydrated);
  const computer = useCloudLink((s) => s.computer);
  useEffect(() => {
    if (conn !== 'connected' || !hydrated) return;
    const t = setTimeout(() => void prefetchChats(), PREFETCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [conn, hydrated, computer]);

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="app-main flex min-w-0 flex-1 py-[3px] pr-[3px]">
        <section className="content-card flex min-w-0 flex-1 flex-col overflow-hidden">
          <ReconnectBanner />
          <CloudSyncStrip />
          <TeachBanner />
          {/* Apps is a page of its own: it takes over the card (settings is a window over everything, below); composer
              drafts live outside the chat view, so they survive the round trip */}
          {cloudWaiting ? (
            <CloudPane />
          ) : appsOpen ? (
            <AppsPage />
          ) : groupOpen ? (
            <div className="flex min-h-0 flex-1">
              <GroupView />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1">
              <ThreadView />
            </div>
          )}
        </section>
        {!appsOpen ? <RightPanel /> : null}
      </main>
      <SettingsHost />
      <DesktopView />
      <MoveBotDialog />
      <SupportWidget />
    </div>
  );
}
