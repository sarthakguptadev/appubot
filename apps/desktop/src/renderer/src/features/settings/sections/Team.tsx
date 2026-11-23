import { useEffect, useState } from 'react';
import { computerDisplayName } from '@appubot/chat-core';
import { SettingsSegmented } from '../../../components/ui';
import { loadTeam, useCloud } from '../../cloud/cloudAccount';
import { DangerGroup, InviteDialog, LoginsGroup, PeopleGroup, SeatsDialog, TeamHeader } from '../../cloud/CloudTeams';
import { useCloudRefresh } from '../../cloud/useCloudRefresh';
import { SectionLoading, SettingsEmptyState } from './shared';

/*
 * Settings › Team (only while the person is on a team; the 2026-11-05 revamp, direction A "Plan cards"): the team's
 * card on top (its tile, rename, Invite people; people and seats, plan, your role), its people as a list (Everyone |
 * Invited, search, roles, ⋯), the team's AI sign-ins as two choice cards and a danger zone (leave; admins close the
 * team by cancelling its plan). Admins invite several people at once and change the seats from here; members read.
 * Several teams: a picker on top.
 */
export function TeamSection() {
  const view = useCloud((s) => s.view);
  const teams = view?.signedIn ? (view.teams ?? []) : [];
  const [picked, setPicked] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [seats, setSeats] = useState(false);
  const t = teams.find((x) => x.team.id === picked) ?? teams[0];
  useCloudRefresh();
  // the team itself (its people and invites) fresh when it is opened
  useEffect(() => { if (t) void loadTeam(t.team.id); }, [t?.team.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!view) return <SectionLoading />;
  if (!t) return <SettingsEmptyState>You’re not on a team. Work plans are in Billing.</SettingsEmptyState>;
  const admin = t.team.canManage;
  return (
    <div className="space-y-8">
      {teams.length > 1 ? (
        <SettingsSegmented label="Team" value={t.team.id} onChange={setPicked} options={teams.map((x) => ({ value: x.team.id, label: computerDisplayName({ team: x.team.name }) }))} />
      ) : null}
      <TeamHeader view={view} t={t} onInvite={() => setInviting(true)} onSeats={() => setSeats(true)} />
      <PeopleGroup view={view} t={t} />
      <LoginsGroup t={t} />
      <DangerGroup t={t} />
      {admin ? (
        <>
          <InviteDialog view={view} t={t} open={inviting} onClose={() => setInviting(false)} />
          {t.team.plan ? <SeatsDialog view={view} t={t} open={seats} onClose={() => setSeats(false)} /> : null}
        </>
      ) : null}
    </div>
  );
}
