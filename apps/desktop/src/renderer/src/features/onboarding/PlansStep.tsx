import { useEffect, useState } from 'react';
import type { CloudInterval, CloudPlanId } from '@appubot/protocol';
import { SETUP_COMPUTER, withMachine } from '@appubot/chat-core';
import { Button, Spinner } from '../../components/ui';
import { MACHINE } from '../../lib/platform';
import { acceptInvite, busyKey, buyCloud, loadCloud, useCloud } from '../cloud/cloudAccount';
import { cloudPhase } from '../cloud/cloudView';
import { PlanCards, usePlanChoice } from '../cloud/Paywall';
import { TeamTile } from '../cloud/PlanParts';
import type { CloudStage } from './setupFlow';
import { StepShell } from './StepShell';

/** a plan picked here: what the next screen opens the checkout for again */
export interface PlanPick { plan: CloudPlanId; interval: CloudInterval; members?: number }

/**
 * Setup's plans: the one paywall (features/cloud/Paywall.tsx, the site's cards), with its Free card as the way on
 * with this computer. Picking a plan signs in first where needed and opens its checkout in the browser (`buyCloud`);
 * the next screen follows it from there. A team's invitation is answered here too.
 */
export function PlansStep({ stage, onPicked, onOwn, onBack }: {
  stage: CloudStage;
  onPicked: (pick: PlanPick) => void;
  onOwn: () => void;
  onBack: () => void;
}) {
  const view = useCloud((s) => s.view);
  const busy = useCloud((s) => s.busy);
  const choice = usePlanChoice();
  const [asking, setAsking] = useState<string | null>(null);
  // the plans are public: read them once here if the account hasn't been yet
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (view) return;
    let live = true;
    void loadCloud(true).then((v) => { if (live && !v) setFailed(true); });
    return () => { live = false; };
  }, [view]);

  const pick = async (plan: CloudPlanId, interval: CloudInterval, members: number): Promise<void> => {
    const chosen: PlanPick = { plan, interval, ...(choice.kind === 'work' ? { members } : {}) };
    setAsking(plan);
    await buyCloud(chosen.plan, chosen.interval, chosen.members);
    setAsking(null);
    onPicked(chosen);
  };
  const invites = stage.kind === 'plans' ? stage.invites : [];
  const own = withMachine(SETUP_COMPUTER.own, MACHINE);

  return (
    <StepShell
      title="Pick their computer"
      body="Every plan is a computer of their own in the cloud, on day and night. Change or cancel any time."
      width="xl" tight
      onBack={onBack}
      actions={<Button size="lg" variant="ghost" onClick={onOwn}>{own}</Button>}
    >
      {invites.map((i) => (
        <div key={i.id} className="mx-auto mb-4 flex w-full max-w-[640px] items-center gap-3 squircle rounded-card bg-surface px-4 py-3 shadow-raised">
          <TeamTile name={i.teamName} size={36} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-copy font-medium text-fg">You’re invited to {i.teamName}</div>
            <div className="truncate text-ui text-muted">Join to use its cloud computer. Nothing to pay.</div>
          </div>
          <Button size="md" variant="primary" loading={!!busy[busyKey(`accept-${i.id}`)]} onClick={() => void acceptInvite(i.id)}>Join {i.teamName}</Button>
        </div>
      ))}
      {view ? (
        <PlanCards
          view={view} choice={choice} mode="buy"
          soldOut={cloudPhase(view) === 'sold-out'}
          loadingId={asking && (busy.checkout || busy.signIn) ? asking : null}
          onPick={(c, interval, members) => void pick(c.id as CloudPlanId, interval, members)}
          onFree={onOwn} freeLabel={own}
        />
      ) : (
        <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 text-center">
          {failed ? (
            <>
              <p className="text-copy text-fg-2">The plans couldn’t be loaded. Check your connection and try again.</p>
              <Button size="md" variant="secondary" onClick={() => { setFailed(false); void loadCloud(true).then((v) => { if (!v) setFailed(true); }); }}>Try again</Button>
            </>
          ) : <Spinner size={18} className="text-muted" />}
        </div>
      )}
    </StepShell>
  );
}
