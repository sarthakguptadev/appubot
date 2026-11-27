/**
 * A bot's own computer, in its Details tab (after Grok Bot's "Bot's computer" card): where bots have screens of their
 * own (your AppuBot computer), a small live picture of this bot's screen with what it is doing ("Working", "Asleep",
 * "Sam has control"), and a click opens it full screen (`DesktopView`, on this bot's screen), where Take control is.
 * The picture streams only while the screen is up and the card shows in a visible window, so it never wakes a
 * sleeping screen or computer by itself; opening the viewer does.
 */
import { useEffect, useRef, useState } from 'react';
import type { Bot } from '@appubot/protocol';
import { Maximize2, Monitor } from '../../components/ui/icons';
import { Icon, cn } from '../../components/ui';
import { useStore } from '../../lib/store';
import { useCloudLink } from './cloudClient';
import { ScreenSurface, openCloudDesktop } from './DesktopView';
import { releaseScreen, useCloudDesktop, useScreen, wantScreen } from './screenSession';
import { botScreenLine } from './screenView';

function useVisible(): boolean {
  const [v, setV] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => setV(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return v;
}

export function BotScreenCard({ bot }: { bot: Bot }) {
  const link = useCloudLink();
  const enabled = useStore((s) => !!s.computer?.screens);
  const screen = useStore((s) => s.computer?.screens?.find((x) => x.botId === bot.id));
  const viewerOpen = useCloudDesktop((s) => s.open);
  const showing = useScreen((s) => s.screen === bot.id && s.phase === 'connected');
  const visible = useVisible();
  const ref = useRef<HTMLButtonElement | null>(null);
  const up = screen?.state === 'on';
  const onCloud = link.computer === 'cloud' && link.conn === 'connected';

  useEffect(() => {
    if (!onCloud || !up || !visible) return;
    wantScreen('bot-card', { full: false, team: link.team, screen: bot.id });
    return () => releaseScreen('bot-card');
  }, [onCloud, up, visible, link.team, bot.id]);

  if (!onCloud || !enabled) return null;
  const line = botScreenLine(screen, bot.name);
  const busy = !!screen && (screen.busy || !!screen.activeThreadId);
  return (
    <section aria-label={`${bot.name}’s computer`} className="shrink-0">
      <div className="mb-1.5 flex items-center gap-2 px-1">
        <span className="text-copy font-medium text-fg">{bot.name}’s computer</span>
        <span className="flex-1" />
        <span className="flex items-center gap-1.5 text-note text-muted">
          {busy ? <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-success" /> : null}
          {line}
        </span>
      </div>
      <button
        ref={ref}
        type="button"
        onClick={() => openCloudDesktop(link.team, { screen: bot.id, from: ref.current?.getBoundingClientRect() })}
        aria-label={`Open ${bot.name}’s screen full screen`}
        className={cn(
          'group relative block aspect-[16/10] w-full overflow-hidden rounded-card border border-[var(--ab-hairline)] outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]',
          showing ? 'cursor-zoom-in bg-black' : 'bg-surface-2',
        )}
      >
        {up && !viewerOpen ? <ScreenSurface slot="preview" className="pointer-events-none absolute inset-0" /> : null}
        {!showing ? (
          <span className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
            <span className="ab-pill squircle flex size-9 items-center justify-center rounded-control bg-[color-mix(in_srgb,var(--ab-fg)_6%,transparent)] text-fg-2">
              <Icon icon={Monitor} size={17} />
            </span>
            <span className="max-w-[240px] text-note leading-snug text-muted">
              {screen?.state === 'asleep' ? 'Its screen sleeps while unused. Open it to wake it.' : up ? 'Connecting…' : `A screen of its own, so it works beside your other bots.`}
            </span>
          </span>
        ) : (
          <span className="pointer-events-none absolute top-2 right-2 flex size-7 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
            <Icon icon={Maximize2} size={14} />
          </span>
        )}
      </button>
    </section>
  );
}
