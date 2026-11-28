/**
 * What the account menu at the sidebar's foot knows about the plan (Sidebar's AccountButton): the plan's name, whether
 * Upgrade plan shows and on which kind of plan, and the team Invite teammates adds people to. How much is used isn't
 * in the menu (Settings › Usage shows it).
 */
import { CloudPersonalPlanId, type CloudAccountView, type CloudWorkPlanId } from '@appubot/protocol';
import { hasPersonalPlan, planName } from '../../features/cloud/cloudView';

/** the top plan of each kind: there is nothing to upgrade to from it */
const TOP_PERSONAL = CloudPersonalPlanId.options[CloudPersonalPlanId.options.length - 1];
const TOP_WORK: CloudWorkPlanId = 'scale';

export interface AccountPlan {
  /** "Pro", "Team"; "Free" with no plan */
  name: string;
  /** the kind of plan Upgrade plan opens on; null on the top plan */
  upgrade: 'personal' | 'work' | null;
  /** the Work plan's team whose people you may invite; null otherwise */
  inviteTeam: string | null;
}

export function accountPlan(v: CloudAccountView | null | undefined): AccountPlan {
  const own = hasPersonalPlan(v) ? (v?.account?.subscription?.plan ?? v?.account?.plan) : undefined;
  const teams = v?.signedIn ? (v.teams ?? []).filter((t) => t.team.plan) : [];
  const admin = teams.find((t) => t.team.canManage);
  const team = admin ?? teams[0];
  const upgrade = own ? (own === TOP_PERSONAL ? null : 'personal')
    : team ? (team.team.plan === TOP_WORK || !team.team.canManage ? null : 'work')
    : 'personal';
  return {
    name: own ? planName(v, own) : team?.team.plan ? planName(v, team.team.plan) : 'Free',
    upgrade,
    inviteTeam: admin?.team.id ?? null,
  };
}
