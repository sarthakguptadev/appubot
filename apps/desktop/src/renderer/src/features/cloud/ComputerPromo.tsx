/**
 * The side panel's Computer tab on This Mac (2026-11-18, the owner's "show the Computer tab in normal too, and in it the
 * cloud's promo"): there is no remote screen to watch here, so the tab says what a cloud computer gives. For someone
 * without one, the sidebar card's picture (the person's own bots riding a cloud at night, `Scene`), the three things it
 * gives (chat-core `CLOUD_ONBOARDING.points`, as setup's card has them) and one button to the plan cards ("Try free for
 * 3 days" while a first plan starts with the free trial), the price under it. For someone who has one (theirs, or a
 * team's), a line and Open it, which puts that computer on screen. Nothing is snoozed here: the tab is only opened on
 * purpose.
 */
import { useState } from 'react';
import { CLOUD_ONBOARDING, CLOUD_PROMO, cloudPromoCta, setupFrom, trialDaysOf, withMachine } from '@appubot/chat-core';
import { ArrowRight, Clock, Cloud, Monitor, type IconComponent } from '../../components/ui/icons';
import { Button, Icon } from '../../components/ui';
import { MACHINE } from '../../lib/platform';
import { ui } from '../../lib/store';
import { ProviderLogo } from '../providers/providerLogos';
import { useCloud } from './cloudAccount';
import { switchComputer } from './cloudClient';
import { Scene } from './CloudPromoCard';
import { cloudTargets } from './cloudView';

const GIVE_ICONS: Partial<Record<(typeof CLOUD_ONBOARDING.points)[number]['id'], IconComponent>> = { always: Clock, screen: Monitor };

export function ComputerPromo() {
  const view = useCloud((s) => s.view);
  const targets = cloudTargets(view);
  const cheapest = (view?.catalog?.plans ?? [])
    .map((p) => p.monthly)
    .filter((p): p is NonNullable<typeof p> => !!p)
    .sort((a, b) => a.amount - b.amount)[0]?.display;
  const trialDays = trialDaysOf(view?.catalog, view?.signedIn ? (view.account ?? {}) : null);
  const [cheer, setCheer] = useState(0);
  const own = targets[0];

  if (own) {
    // a cloud computer of their own (or a team's): the way there
    return (
      <div className="flex h-full flex-col items-center overflow-y-auto px-5 pt-6 pb-16 text-center">
        <span className="ab-pill squircle flex size-11 items-center justify-center rounded-[14px] bg-surface-2 text-fg-2"><Icon icon={Cloud} size={22} /></span>
        <p className="mt-3 text-copy font-semibold text-fg">Your bots there have a screen of their own</p>
        <p className="mt-1 max-w-[280px] text-ui leading-snug text-muted">Open {own.name} to watch its screen here, or take over.</p>
        <Button variant="primary" size="md" className="mt-4" onClick={() => void switchComputer('cloud', own.team)}>Open {own.name}</Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto px-4 pt-1 pb-16">
      <div
        onMouseEnter={() => setCheer((n) => n + 1)}
        className="squircle flex flex-col overflow-hidden rounded-card bg-surface-2"
      >
        <div className="px-6 pt-4"><Scene cheer={cheer} /></div>
        <div className="flex flex-col px-5 pt-1 pb-5">
          <h2 className="text-lead leading-snug font-semibold tracking-ui text-fg">{CLOUD_PROMO.title}</h2>
          <p className="mt-1 text-ui leading-snug text-muted">{withMachine(CLOUD_ONBOARDING.body, MACHINE)}</p>
          <ul className="mt-4 flex flex-col gap-3.5">
            {CLOUD_ONBOARDING.points.map((p) => {
              const icon = GIVE_ICONS[p.id];
              return (
                <li key={p.id} className="flex gap-3">
                  <span className="ab-pill squircle flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-content text-fg-2">
                    {icon ? <Icon icon={icon} size={16} /> : <ProviderLogo id="claude-code" size={16} />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-ui font-semibold text-fg">{p.title}</span>
                    <span className="mt-0.5 block text-note leading-snug text-muted">{withMachine(p.line, MACHINE)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          <Button variant="primary" size="lg" className="mt-5 w-full justify-center" iconRight={ArrowRight} onClick={() => ui.openSettings('billing')}>
            {cloudPromoCta(trialDays)}
          </Button>
          {cheapest ? <p className="mt-2 text-center text-note text-muted">{setupFrom(trialDays, cheapest)}</p> : null}
        </div>
      </div>
    </div>
  );
}
