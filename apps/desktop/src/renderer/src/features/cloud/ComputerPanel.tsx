import { useEffect, useRef, useState } from 'react';
import type { CloudRepairKind } from '@appubot/protocol';
import { REPAIR_OPTIONS, UNREACHABLE_FIX_HINT, WATCHING_KEEPS_AWAKE, unreachableFixes } from '@appubot/chat-core';
import { Cloud, Maximize2, Moon, RefreshCw, RotateCw, Wrench } from '../../components/ui/icons';
import { Button, Icon, Spinner, cn } from '../../components/ui';
import { useStore } from '../../lib/store';
import { startCloud, useCloud } from './cloudAccount';
import { switchComputer, useCloudLink } from './cloudClient';
import { cloudPhase, teamAsView, type CloudPhase } from './cloudView';
import { ScreenSurface, openCloudDesktop, useScreenTitle } from './DesktopView';
import { RepairDialog } from './FixComputer';
import { releaseScreen, retryScreen, useCloudDesktop, useScreen, wantScreen } from './screenSession';
import { mayStream, screenCard, type ScreenCard, type ScreenPhase } from './screenView';

/*
 * The side panel's Computer tab (only while the app is on your AppuBot computer or a team's: watching this Mac from
 * itself makes no sense): a small live picture of the screen (16:10, one picture a second at the cheapest quality:
 * `screenSession.ts` paces it), nothing under it, and its states: waking up, asleep (Wake), connecting, live, can't
 * reach (the Fix your computer choices). View only; a click opens the full-screen viewer (`DesktopView`) straight
 * away, where Take control is. It streams only while this tab shows in an open panel and the window is visible, and
 * never wakes a sleeping computer by itself. Where bots have screens of their own (the computer's status lists
 * `screens`), a bot's Computer tab is that bot's screen: opening the tab starts it if it sleeps.
 */

/** dev: `?screen=asleep|waking|connecting|live|reconnecting|paused|unreachable` shows that state (the browser mock has no screen) */
const MOCK = import.meta.env.DEV && typeof location !== 'undefined' ? new URLSearchParams(location.search).get('screen') : null;

function useVisible(): boolean {
  const [v, setV] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => setV(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return v;
}

export function ComputerPanel() {
  const link = useCloudLink();
  const account = useCloud((s) => s.view);
  const teamView = link.team ? account?.teams?.find((t) => t.team.id === link.team) : undefined;
  const view = account && teamView ? teamAsView(account, teamView) : account;
  const cloud: CloudPhase = cloudPhase(view);
  const phase = useScreen((s) => s.phase);
  const why = useScreen((s) => s.why);
  const fb = useScreen((s) => s.fb);
  const viewerOpen = useCloudDesktop((s) => s.open);
  const visible = useVisible();
  const [woke, setWoke] = useState(false);
  const allowed = !MOCK && (woke || mayStream({ cloud, conn: link.conn, linkError: link.error }));
  const title = useScreenTitle(link.team);
  // a bot's own screen, where bots have them (a group's room shows the computer's own)
  const bot = useStore((s) => (s.computer?.screens && s.selectedGroupId === null ? s.bots.find((b) => b.id === s.selectedBotId) : undefined));
  const screen = bot?.id;

  useEffect(() => {
    if (!visible || !allowed) return;
    wantScreen('panel', { full: false, team: link.team, screen });
    return () => releaseScreen('panel');
  }, [visible, allowed, link.team, screen]);
  useEffect(() => { setWoke(false); }, [link.team]);

  const card: ScreenCard = MOCK ? mockCard(MOCK) : screenCard({ cloud, conn: link.conn, linkError: link.error, phase, why });
  const computer = teamView ? teamView.computer : account?.computer;
  const fixes = card.kind === 'unreachable' ? unreachableFixes(computer, teamView ? teamView.team.canManage : true) : [];
  const [fixing, setFixing] = useState<CloudRepairKind | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const canExpand = card.kind === 'live' || card.kind === 'reconnecting' || card.kind === 'connecting' || card.kind === 'waking';
  const expand = () => openCloudDesktop(link.team, { screen, from: cardRef.current?.getBoundingClientRect() });

  const wake = () => {
    setWoke(true);
    void startCloud(link.team);
    retryScreen();
  };
  const tryAgain = () => {
    if (link.conn === 'closed' || link.conn === 'unauthorized' || link.error) void switchComputer('cloud', link.team);
    else retryScreen();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5">
        <div
          ref={cardRef}
          className={cn(
            'group relative w-full overflow-hidden rounded-card border border-[var(--ab-hairline)] bg-surface-2',
            card.kind === 'live' && 'bg-black',
          )}
          // the screen's own shape once known (no letterbox), within reason for the panel; 16:10 until then
          style={{ aspectRatio: fb ? `${Math.min(2.4, Math.max(1.2, fb.w / fb.h))}` : '16 / 10' }}
        >
          {/* the picture (not while the full viewer has it), under the states; clicks go to the card */}
          {!viewerOpen ? <ScreenSurface slot="preview" className="pointer-events-none absolute inset-0" /> : null}
          {canExpand ? (
            <button
              type="button"
              onClick={() => expand()}
              aria-label={`Open ${bot ? `${bot.name}’s screen` : title} full screen`}
              title={`Open full screen. ${WATCHING_KEEPS_AWAKE}.`}
              className="absolute inset-0 cursor-zoom-in rounded-card outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ab-ring)]"
            />
          ) : null}
          {card.kind === 'live' || card.kind === 'reconnecting' ? (
            <span className="pointer-events-none absolute top-2 right-2 flex size-7 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur group-hover:opacity-100 group-focus-within:opacity-100">
              <Icon icon={Maximize2} size={14} />
            </span>
          ) : null}
          {card.kind === 'reconnecting' ? (
            <span className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
              <span className="ab-pill squircle flex items-center gap-1.5 rounded-control-sm bg-black/65 px-2.5 py-1 text-note text-white/85 backdrop-blur"><Spinner size={11} /> Reconnecting…</span>
            </span>
          ) : null}
          {card.kind !== 'live' && card.kind !== 'reconnecting' ? <CardState card={card} onWake={wake} onRetry={tryAgain} /> : null}
        </div>

        {fixes.length ? (
          <div className="mt-5 flex flex-col items-center gap-2.5 text-center">
            <p className="text-ui leading-relaxed text-muted">{UNREACHABLE_FIX_HINT}</p>
            <div className="flex flex-wrap justify-center gap-2">
              {fixes.map((k) => <Button key={k} size="sm" variant="outline" icon={k === 'update' ? RefreshCw : Wrench} onClick={() => setFixing(k)}>{REPAIR_OPTIONS[k].title}…</Button>)}
            </div>
          </div>
        ) : null}
        <RepairDialog kind={fixing} team={link.team} version={computer?.computer?.version} onClose={() => setFixing(null)} />
      </div>
    </div>
  );
}

/** what the card says while there's no live picture (over the card's own button: only the action takes clicks) */
function CardState({ card, onWake, onRetry }: { card: ScreenCard; onWake: () => void; onRetry: () => void }) {
  const busy = card.kind === 'waking' || card.kind === 'connecting';
  return (
    <span className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-2/85 px-4 text-center" role="status">
      <span className="ab-pill squircle flex size-9 items-center justify-center rounded-control bg-[color-mix(in_srgb,var(--ab-fg)_6%,transparent)] text-fg-2">
        {busy ? <Spinner size={16} /> : <Icon icon={card.kind === 'asleep' ? Moon : card.kind === 'unreachable' ? Cloud : RotateCw} size={17} />}
      </span>
      <span className="text-copy font-medium text-fg-2">{card.title}</span>
      {card.line ? <span className="line-clamp-2 max-w-[260px] text-note leading-snug text-muted">{card.line}</span> : null}
      {card.kind === 'asleep' ? <Button size="sm" variant="primary" className="pointer-events-auto mt-1" onClick={onWake}>Wake</Button> : null}
      {card.kind === 'paused' ? <Button size="sm" variant="secondary" className="pointer-events-auto mt-1" onClick={retryScreen}>Keep watching</Button> : null}
      {card.kind === 'unreachable' ? <Button size="sm" variant="secondary" icon={RotateCw} className="pointer-events-auto mt-1" onClick={onRetry}>Try again</Button> : null}
    </span>
  );
}

function mockCard(kind: string): ScreenCard {
  const phase: ScreenPhase = kind === 'connecting' ? 'connecting' : kind === 'live' ? 'connected' : kind === 'reconnecting' ? 'reconnecting' : kind === 'paused' ? 'paused' : kind === 'unreachable' ? 'failed' : 'idle';
  const cloud: CloudPhase = kind === 'asleep' ? 'asleep' : kind === 'waking' ? 'waking' : 'running';
  return screenCard({ cloud, conn: 'connected', phase, why: kind === 'unreachable' ? 'The connection to your AppuBot computer dropped.' : '' });
}
