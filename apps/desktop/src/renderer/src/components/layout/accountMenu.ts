/**
 * What the account menu at the sidebar's foot says about the plan (Sidebar's AccountButton): the plan's name, how much
 * of the agents' plan limits is used (Settings › Usage, "how much of your plans is left"), whether Upgrade plan shows
 * and on which kind of plan, and the team Invite teammates adds people to.
 */
import { CloudPersonalPlanId, type CloudAccountView, type CloudWorkPlanId, type ProviderLimits } from '@appubot/protocol';
import { hasPersonalPlan, planName } from '../../features/cloud/cloudView';

/** the top plan of each kind: there is nothing to upgrade to from it */
const TOP_PERSONAL = CloudPersonalPlanId.options[CloudPersonalPlanId.options.length - 1];
const TOP_WORK: CloudWorkPlanId = 'scale';

export interface AccountPlan {
  /** "Pro", "Team"; "Free" with no plan */
  name: string;
  /** the most used window of the agents' plan limits, 0..100; null on Free, or when none has been read */
  used: number | null;
  /** the kind of plan Upgrade plan opens on; null on the top plan */
  upgrade: 'personal' | 'work' | null;
  /** the Work plan's team whose people you may invite; null otherwise */
  inviteTeam: string | null;
}

export function accountPlan(v: CloudAccountView | null | undefined, limits: readonly ProviderLimits[]): AccountPlan {
  const own = hasPersonalPlan(v) ? (v?.account?.subscription?.plan ?? v?.account?.plan) : undefined;
  const teams = v?.signedIn ? (v.teams ?? []).filter((t) => t.team.plan) : [];
  const admin = teams.find((t) => t.team.canManage);
  const team = admin ?? teams[0];
  const windows = limits.filter((l) => l.status !== 'unavailable' && l.status !== 'signed_out').flatMap((l) => l.windows);
  const used = (own || team) && windows.length ? Math.min(100, Math.round(Math.max(...windows.map((w) => w.usedPercent)))) : null;
  const upgrade = own ? (own === TOP_PERSONAL ? null : 'personal')
    : team ? (team.team.plan === TOP_WORK || !team.team.canManage ? null : 'work')
    : 'personal';
  return {
    name: own ? planName(v, own) : team?.team.plan ? planName(v, team.team.plan) : 'Free',
    used,
    upgrade,
    inviteTeam: admin?.team.id ?? null,
  };
}
