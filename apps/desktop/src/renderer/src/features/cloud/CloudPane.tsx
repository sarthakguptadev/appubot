import { useState } from 'react';
import type { CloudRepairKind } from '@appubot/protocol';
import { REPAIR_OPTIONS, UNREACHABLE_FIX_HINT, fixOffer, unreachableFixes } from '@appubot/chat-core';
import { Cloud, Laptop, RefreshCw, RotateCw, Settings, Wrench } from '../../components/ui/icons';
import { Button, Icon } from '../../components/ui';
import { MACHINE } from '../../lib/platform';
import { ui } from '../../lib/store';
import { useCloud } from './cloudAccount';
import { switchComputer, useCloudLink } from './cloudClient';
import { cloudPhase, phaseWords, teamAsView } from './cloudView';
import { RepairDialog, RepairProgress } from './FixComputer';
import { YOUR_COMPUTER } from './names';
import { useHeldFor } from '../../lib/connectionQuiet';

/**
 * The chat's place while the cloud is on screen with no saved copy to show yet (the first visit): quiet while it
 * connects or wakes (no spinner, no "Waking…": lib/connectionQuiet.ts), then, 30 s on or after a refusal, why it can't
 * be reached, with Try again, the fixes and a way back to this Mac.
 */
export function CloudPane() {
  const link = useCloudLink();
  const account = useCloud((s) => s.view);
  // a team's computer reads as its own view (its plan and state), the person's own as the account's
  const teamView = link.team ? account?.teams?.find((t) => t.team.id === link.team) : undefined;
  const view = account && teamView ? teamAsView(account, teamView) : account;
  const phase = cloudPhase(view);
  const refused = link.conn === 'unauthorized' || link.conn === 'incompatible';
  const late = useHeldFor(!link.ready);
  const failed = refused || (late && (link.conn === 'closed' || !!link.error || link.conn !== 'connected'));
  const words = phaseWords(phase, view);
  // can't reach it: Update, then Recover, for whoever may fix it (the owner; a team's admins); a fix already running shows instead
  const computer = teamView ? teamView.computer : account?.computer;
  const admin = teamView ? teamView.team.canManage : true;
  const fixes = failed ? unreachableFixes(computer, admin) : [];
  const running = fixOffer(computer, admin).running ? computer?.repair : undefined;
  const [fixing, setFixing] = useState<CloudRepairKind | null>(null);
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="drag h-16 shrink-0" />
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 pb-20 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-fg-2">
          <Icon icon={Cloud} size={22} />
        </span>
        <div className="flex max-w-[420px] flex-col gap-1.5">
          <h2 className="text-[18px] leading-tight font-semibold tracking-[-0.01em] text-fg">
            {failed ? `Can’t reach ${YOUR_COMPUTER}` : 'Your bots will be here in a moment'}
          </h2>
          <p className="text-copy leading-relaxed text-muted">
            {failed
              ? link.error ?? words.line ?? 'It hasn’t answered yet. AppuBot keeps trying.'
              : 'Your bots there pick up where they left off.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" icon={Laptop} onClick={() => void switchComputer('local')}>Back to This {MACHINE}</Button>
          {failed ? <Button variant="primary" icon={RotateCw} onClick={() => void switchComputer('cloud', link.team)}>Try again</Button> : null}
          {failed ? <Button variant="ghost" icon={Settings} onClick={() => ui.openSettings('account')}>Account settings</Button> : null}
        </div>
        {running ? <div className="w-full max-w-[460px] rounded-card border border-[var(--ab-hairline)] text-left"><RepairProgress repair={running} /></div> : null}
        {fixes.length ? (
          <div className="flex max-w-[420px] flex-col items-center gap-2.5 pt-2">
            <p className="text-copy leading-relaxed text-muted">{UNREACHABLE_FIX_HINT}</p>
            <div className="flex items-center gap-2">
              {fixes.map((k) => <Button key={k} variant="outline" icon={k === 'update' ? RefreshCw : Wrench} onClick={() => setFixing(k)}>{REPAIR_OPTIONS[k].title}…</Button>)}
            </div>
          </div>
        ) : null}
        <RepairDialog kind={fixing} team={link.team} version={computer?.computer?.version} onClose={() => setFixing(null)} />
      </div>
    </div>
  );
}
