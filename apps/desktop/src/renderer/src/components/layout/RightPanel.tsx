import { X } from '../ui/icons';
import { useEffect, useState } from 'react';
import { Button, Tooltip, cn, type TabItem } from '../ui';
import { selectSelectedBot, selectSelectedThread, setState, ui, useStore, type RightTab } from '../../lib/store';
import { BotHero } from '../../features/bots/BotHero';
import { BotPanel } from '../../features/bots/BotPanel';
import { ThreadsPanel } from '../../features/chat/ThreadsPanel';
import { SkillsPanel } from '../../features/skills/SkillsPanel';
import { MemoryPanel } from '../../features/memory/MemoryPanel';
import { RoutinesPanel } from '../../features/routines/RoutinesPanel';
import { FilesPanel } from '../../features/files/FilesPanel';
import { ComputerPanel } from '../../features/cloud/ComputerPanel';
import { ComputerPromo } from '../../features/cloud/ComputerPromo';
import { useCloudLink } from '../../features/cloud/cloudClient';
import { ResizeHandle } from './ResizeHandle';
import { PanelTabs } from '../ui/PanelTabs';

/** The top row: Threads, Computer (on your AppuBot computer or a team's its screen; on This Mac, what a cloud computer
 * gives, `ComputerPromo`, since watching this Mac from itself makes no sense) and Advanced, whose own row of the rest
 * opens under it. */
type TopTab = 'threads' | 'computer' | 'advanced';
const THREADS_TAB: TabItem<TopTab> = { id: 'threads', label: 'Threads' };
const COMPUTER_TAB: TabItem<TopTab> = { id: 'computer', label: 'Computer' };
const ADVANCED_TAB: TabItem<TopTab> = { id: 'advanced', label: 'Advanced' };
/** under Advanced: the bot's setup and what it keeps */
const ADVANCED: TabItem<RightTab>[] = [
  { id: 'bot', label: 'Details' },
  { id: 'skills', label: 'Skills' },
  { id: 'memory', label: 'Memory' },
  { id: 'routines', label: 'Routines' },
  { id: 'files', label: 'Files' },
];
const topOf = (t: RightTab): TopTab => (t === 'threads' || t === 'computer' ? t : 'advanced');
/** the Advanced tab picked last in this run, so Advanced reopens where it was left */
let lastAdvanced: RightTab = 'bot';
/** dev: `?screen=<state>` shows the Computer tab in the browser mock (no remote computer there) */
const MOCK_SCREEN = import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).has('screen');

/** the chat beside the panel keeps at least this much room (a readable column) */
const CHAT_MIN = 440;
const PANEL_MIN = 280;
const PANEL_MAX = 720;

/** How wide the panel can be in a window this wide: what was dragged, less what the chat needs (never under PANEL_MIN). */
function panelWidth(wanted: number, windowWidth: number, sidebarWidth: number): number {
  const room = Math.max(PANEL_MIN, windowWidth - sidebarWidth - CHAT_MIN);
  return Math.min(wanted, room, PANEL_MAX);
}

function useWindowWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return w;
}

function Body({ tab, remote }: { tab: RightTab; remote: boolean }) {
  switch (tab) {
    case 'threads': return <ThreadsPanel />;
    case 'bot': return <BotPanel />;
    case 'skills': return <SkillsPanel />;
    case 'memory': return <MemoryPanel />;
    case 'routines': return <RoutinesPanel />;
    case 'files': return <FilesPanel />;
    case 'computer': return remote ? <ComputerPanel /> : <ComputerPromo />;
  }
}

/**
 * The bot's panel beside its chat, opened and closed by the bot's name in the chat header, and the one place a bot is
 * set up (there is no editor dialog). No bar: ✕ in a clear strip (the window drags by it), then the bot's avatar, name
 * and job, each changed where it stands (features/bots/BotHero.tsx), with the tabs in words under them (Threads, the
 * first and the one the header opens; Computer on a remote computer; Advanced, with its own row under it: Details,
 * everything it runs on and its instructions; Skills, Memory, Routines, Files), then the tab, which carries no heading of its own. A group's room has no bot of its own, so only the
 * computer's screen (a remote computer) shows beside it, bare.
 */
export function RightPanel() {
  const wantOpen = useStore((s) => s.rightOpen);
  const remote = useCloudLink((s) => s.computer === 'cloud') || MOCK_SCREEN;
  const chosen = useStore((s) => s.rightTab);
  const inGroup = useStore((s) => s.selectedGroupId !== null);
  const bot = useStore(selectSelectedBot);
  const working = useStore((s) => { const t = selectSelectedThread(s); return !!t && t.botId === s.selectedBotId && t.status === 'running'; });
  const tab: RightTab = chosen;
  const top = topOf(tab);
  const tops = [THREADS_TAB, COMPUTER_TAB, ADVANCED_TAB];
  if (top === 'advanced') lastAdvanced = tab;
  // a group's room has no bot of its own: only a remote computer's screen shows beside it
  const open = wantOpen && (!inGroup || (tab === 'computer' && remote));
  const wanted = useStore((s) => s.rightWidth);
  const sidebar = useStore((s) => s.sidebarWidth);
  // a narrow window: the panel gives way so the chat stays usable (the dragged width comes back as the window grows)
  const windowWidth = useWindowWidth();
  const width = panelWidth(wanted, windowWidth, sidebar);
  const maxWidth = panelWidth(PANEL_MAX, windowWidth, sidebar);

  // opens and closes at once, like T3 Code's panels
  if (!open) return null;
  return (
    <aside style={{ width }} className="app-panel relative flex h-full shrink-0 flex-col pl-1.5">
      <div className="content-card flex h-full flex-col overflow-hidden" style={{ width: width - 6 }}>
        {/* at the window's right edge: clear of Windows' and Linux's window buttons (--wco-right) */}
        <div className="drag flex h-16 shrink-0 items-center justify-end pr-[calc(10px+var(--wco-right))]">
          <Tooltip label="Close panel">
            <Button size="icon-sm" variant="secondary" icon={X} aria-label="Close panel" onClick={() => setState({ rightOpen: false })} className="no-drag" />
          </Tooltip>
        </div>
        {bot && !inGroup ? (
          <div className="-mt-3 flex shrink-0 flex-col items-center px-4 pb-4">
            <BotHero bot={bot} working={working} />
            <div className="mt-3"><PanelTabs items={tops} value={top} onChange={(t) => ui.openRight(t === 'advanced' ? lastAdvanced : t)} /></div>
            {top === 'advanced' ? (
              // 8px into the side padding each way: the five fit on one line at the panel's own width (they wrap in a narrower one)
              <div className="-mx-2 mt-1.5 max-w-[calc(100%+16px)]"><PanelTabs small items={ADVANCED} value={tab} onChange={(t) => ui.openRight(t)} /></div>
            ) : null}
          </div>
        ) : null}
        <div className="min-h-0 flex-1"><Body tab={tab} remote={remote} /></div>
      </div>
      <ResizeHandle side="left" label="Resize side panel" width={width} min={Math.min(320, maxWidth)} max={maxWidth} onWidth={(w) => setState({ rightWidth: w })} onReset={() => setState({ rightWidth: 380 })} />
    </aside>
  );
}
