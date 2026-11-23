import { useCloud } from './cloudAccount';
import { useCloudLink } from './cloudClient';
import { cloudPhase, hasPersonalPlan } from './cloudView';

/**
 * Whether the cloud computer is offered to this person (the sidebar's cloud card): no plan of their own, on no team
 * and invited to none, plans on sale, and this window shows this computer.
 */
export function useCloudOfferEligible(): boolean {
  const view = useCloud((s) => s.view);
  const supported = useCloud((s) => s.supported);
  const onCloud = useCloudLink((s) => s.computer === 'cloud');
  return supported !== false && !onCloud && !!view && !hasPersonalPlan(view) && !(view.teams?.length) && !(view.account?.teams?.length) && cloudPhase(view) !== 'sold-out';
}
