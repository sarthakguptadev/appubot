import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  CLOUD_ENDED_KEEP_DAYS, keepDaysText, personInitials, profilePhoto,
  DROP_SEAT_QUESTION, TEAM_LOGINS_MEMBER_NOTE, TEAM_LOGINS_OPTIONS, TEAM_LOGINS_TERMS_NOTE, peopleText, priceText, seatDropOffer, shortDate,
  computerDisplayName, teamRoleNote, workPrice,
} from '@appubot/chat-core';
import { CLOUD_TEAM_MEMBERS, type CloudAccountView, type CloudInviteForMe, type CloudPlanChangePreview, type CloudTeamLogins, type CloudTeamRole, type CloudTeamView } from '@appubot/protocol';
import { AlertTriangle, ChevronDown, Copy, KeyRound, LogOut, Minus, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Trash2, User, UserPlus, X } from '../../components/ui/icons';
import { Badge, Button, CachedImg, Dialog, Icon, Input, Menu, SettingsSegmented, Spinner, Switch, cn, type MenuItem } from '../../components/ui';
import { useNow } from '../../lib/hooks';
import { ui } from '../../lib/store';
import { SettingsGroup } from '../settings/sections/shared';
import { TEAM_LOGINS_TITLE, TEAM_PEOPLE_TITLE } from '../settings/nav';
import {
  acceptInvite, busyKey, changePlan, declineInvite, inviteToTeam, leaveTeam, loadTeam, openBilling, previewPlanChange, removeMember, renameTeam, resendInvite,
  revokeInvite, setMemberRole, setTeamLogins, useCloud,
} from './cloudAccount';
import { forgetTeamCloud } from './cloudClient';
import { cloudPhase, inviteEmails, memberRows, perText, planCard, planName, seatCheck, seatsFree, teamAsView } from './cloudView';
import { teamComputerLong } from './names';
import { LinkRow, PlanCardBox, QuietLink, RowIcon, TeamTile, type Fact } from './PlanParts';

/*
 * The team's parts of Settings (Work plans, plan §6.11; the 2026-11-05 revamp, direction A "Plan cards"): the team's
 * card (its tile, rename, Invite people, then people and seats, plan and your role), its people as a list (Everyone |
 * Invited, a search, a role menu and a ⋯ menu per row), the invite dialog (several emails at once; when they don't fit
 * the seats left it offers to add seats, previewed and then charged), the remove dialog ("Also drop their seat" with
 * the new price), AI sign-ins as two choice cards and a danger zone (leave; admins cancel the team's plan). Members see
 * everything read-only. Billing uses the seats dialog and the invite card too, Account the invites.
 */

const isBusy = (k: string, team?: string) => (s: { busy: Partial<Record<string, true>> }) => !!s.busy[busyKey(k, team)];

/**
 * A person's round avatar: their profile picture (`CloudAccount.photoUrl`, https only, loaded without a referrer) when
 * there is one and it loads, else their initials (the name's, else the email's) on a soft tint of their own.
 */
export function PersonAvatar({ email, name, size = 32, dashed, photoUrl }: { email: string; name?: string; size?: number; dashed?: boolean; photoUrl?: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  const initials = personInitials(email, name);
  let h = 0;
  for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const src = dashed ? null : profilePhoto(photoUrl, size * 2);
  if (src && broken !== src) {
    return (
      <CachedImg
        aria-hidden
        alt=""
        src={src}
        referrerPolicy="no-referrer"
        draggable={false}
        onError={() => setBroken(src)}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size, background: `hsl(${h} 70% 72%)` }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn('flex shrink-0 items-center justify-center rounded-full font-semibold', dashed ? 'border border-dashed border-[color-mix(in_srgb,var(--ab-fg)_28%,transparent)] text-muted' : 'text-[#111]')}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38), ...(dashed ? {} : { background: `hsl(${h} 70% 72%)` }) }}
    >
      {initials}
    </span>
  );
}

/** One invite addressed to this person: the team's tile, who asked, Decline / Join. */
export function InviteCard({ invite: i }: { invite: CloudInviteForMe }) {
  const busy = useCloud((s) => s.busy);
  const now = useNow();
  return (
    <div className="flex flex-col gap-3 rounded-card border border-[color-mix(in_srgb,var(--ab-accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--ab-accent)_7%,transparent)] p-4 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-3.5">
        <TeamTile name={i.teamName} size={40} />
        <div className="min-w-0">
          <p className="text-copy leading-5 font-semibold text-fg">{i.invitedBy ? `${i.invitedBy} invited you to ${i.teamName} on AppuBot` : `You’re invited to ${i.teamName} on AppuBot`}</p>
          <p className="text-ui leading-5 text-muted">As {i.role === 'admin' ? 'an admin' : 'a member'} · {teamComputerLong(i.teamName)} · expires {shortDate(i.expiresAt, now)}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="ghost" loading={!!busy[busyKey(`decline-${i.id}`)]} onClick={() => void declineInvite(i.id)}>Decline</Button>
        <Button size="sm" variant="primary" loading={!!busy[busyKey(`accept-${i.id}`)]} onClick={() => void acceptInvite(i.id)}>Join {i.teamName}</Button>
      </div>
    </div>
  );
}

/** Invites addressed to this person (Settings › Account). */
export function InvitesGroup({ view }: { view: CloudAccountView }) {
  const invites = view.account?.invites ?? [];
  if (!invites.length) return null;
  return (
    <SettingsGroup title="Team invites" bare>
      <div className="flex flex-col gap-2.5">{invites.map((i) => <InviteCard key={i.id} invite={i} />)}</div>
    </SettingsGroup>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Seats

/** "−  5 seats  +" */
function SeatStepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <div className="ab-pill squircle inline-flex h-8 items-center overflow-hidden rounded-control bg-surface-2">
      <Button size="icon-sm" variant="ghost" icon={Minus} aria-label="One seat fewer" disabled={value <= min} onClick={() => onChange(value - 1)} className="rounded-r-none" />
      <output className="min-w-[84px] border-x border-[var(--ab-hairline)] px-2 text-center text-copy leading-[30px] font-medium text-fg tabular-nums">{value} seat{value === 1 ? '' : 's'}</output>
      <Button size="icon-sm" variant="ghost" icon={Plus} aria-label="One seat more" disabled={value >= max} onClick={() => onChange(value + 1)} className="rounded-l-none" />
    </div>
  );
}

/**
 * Admins: change the seats, a preview of what it costs before anything changes (more apply now and are charged for the
 * time left; fewer wait for the renewal).
 */
export function SeatsDialog({ view, t, open, onClose }: { view: CloudAccountView; t: CloudTeamView; open: boolean; onClose: () => void }) {
  const team = t.team;
  const plans = view.catalog?.work?.plans ?? [];
  const work = plans.find((p) => p.id === team.plan);
  const interval = team.interval ?? 'monthly';
  const seatsNow = team.scheduledSeats ?? team.seats ?? team.used;
  const [seats, setSeats] = useState(seatsNow);
  const [preview, setPreview] = useState<CloudPlanChangePreview | null>(null);
  const previewing = useCloud(isBusy('previewPlanChange', team.id));
  const changing = useCloud(isBusy('changePlan', team.id));
  useEffect(() => { if (open) { setSeats(seatsNow); setPreview(null); } }, [open, seatsNow]);
  const check = seatCheck(team, seats, plans);
  const per = work?.perMember[interval];
  const after = work ? workPrice(work, seats, interval) : undefined;
  const dirty = seats !== seatsNow;
  const ask = async () => { const p = await previewPlanChange(team.plan!, interval, team.id, seats); if (p) setPreview(p); };
  const confirm = async () => { if (await changePlan(team.plan!, interval, team.id, seats)) { void loadTeam(team.id); onClose(); } };
  const more = seats > seatsNow;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={preview ? `${more ? 'Add' : 'Remove'} ${Math.abs(seats - seatsNow)} seat${Math.abs(seats - seatsNow) === 1 ? '' : 's'}?` : `Seats on ${team.name}`}
      description={preview
        ? (preview.when === 'immediate'
          ? `${team.name} gets ${seats} seats now${preview.chargeNow ? `, and ${preview.chargeNow.display} is charged for the time left in this period` : ''}.`
          : `${team.name} keeps ${seatsNow} seats until ${shortDate(preview.effectiveAt)}, then ${seats}.`)
        : `One seat per person, admins included${per ? `; each one after the first is ${per.display} a ${interval === 'yearly' ? 'year' : 'month'}` : ''}. More apply now, fewer at the renewal.`}
      footer={(
        <>
          <Button variant="ghost" onClick={preview ? () => setPreview(null) : onClose}>{preview ? 'Back' : 'Cancel'}</Button>
          {preview
            ? <Button variant="primary" loading={changing} onClick={() => void confirm()}>{preview.when === 'immediate' ? 'Add seats' : 'Lower at renewal'}</Button>
            : <Button variant="primary" disabled={!dirty || !check.ok} loading={previewing} onClick={() => void ask()}>Review</Button>}
        </>
      )}
    >
      {preview ? (
        (preview.recurring ?? after) ? <p className="text-copy text-fg-2 tabular-nums">From then on: {priceText((preview.recurring ?? after)!)}.</p> : null
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-copy text-fg-2">{peopleText(team.used)} on the team or invited</span>
            <SeatStepper value={seats} min={Math.max(team.minMembers, CLOUD_TEAM_MEMBERS.min)} max={CLOUD_TEAM_MEMBERS.max} onChange={setSeats} />
          </div>
          {dirty ? (
            <p className={cn('text-ui leading-5 tabular-nums', check.ok ? 'text-muted' : 'text-warning')}>
              {check.ok ? (after ? `From then on: ${priceText(after)}.` : '') : check.reason}
            </p>
          ) : null}
          {!check.ok && seats > team.maxMembers ? (
            <div><Button size="sm" variant="outline" onClick={() => { onClose(); ui.openSettings('billing'); }}>Change plan in Billing</Button></div>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The team's card

/** The team at the top of Settings › Team: tile, name (admins rename it), Invite people, then people, plan and role. */
export function TeamHeader({ view, t, onInvite, onSeats }: { view: CloudAccountView; t: CloudTeamView; onInvite: () => void; onSeats: () => void }) {
  const team = t.team;
  const admin = team.canManage;
  const now = useNow();
  const [renaming, setRenaming] = useState(false);
  const active = team.people.filter((p) => p.status === 'active').length || team.members;
  const invited = team.people.filter((p) => p.status === 'invited').length;
  const tv = teamAsView(view, t);
  const card = planCard(tv, cloudPhase(tv), now);
  const work = team.plan ? view.catalog?.work?.plans.find((p) => p.id === team.plan) : undefined;
  const interval = team.interval ?? 'monthly';
  const price = work && team.seats ? workPrice(work, team.seats, interval) : undefined;
  const plan = team.plan ? planName(view, team.plan) : '';
  const facts: Fact[] = admin ? [
    {
      label: 'People',
      value: invited ? `${active} + ${invited} invited` : peopleText(active),
      ...(team.seats ? { meter: team.used / team.seats } : {}),
      sub: team.seats ? <>{team.used} of {team.seats} seats · <QuietLink onClick={onSeats}>Change seats</QuietLink></> : undefined,
    },
    {
      label: 'Plan',
      value: plan ? `${plan}${price ? ` · ${perText(price)}` : ''}` : 'No plan yet',
      sub: <>{card?.billing ? `${card.billing.replace(/ on /, ' ')} · ` : ''}<QuietLink onClick={() => ui.openSettings('billing')}>Billing</QuietLink></>,
    },
    { label: 'Your role', value: 'Admin', sub: 'People, plan and billing' },
  ] : [
    { label: 'People', value: String(active), sub: `On ${team.name}` },
    { label: 'Plan', value: plan || 'No plan yet', sub: 'Admins handle billing' },
    { label: 'Your role', value: 'Member', sub: teamRoleNote('member').replace(/\.$/, '') },
  ];
  return (
    <>
      <PlanCardBox
        tile={<TeamTile name={team.name} size={52} />}
        title={<span className="text-[17px]">{computerDisplayName({ team: team.name })}</span>}
        badges={admin ? <Button size="icon-xs" variant="ghost" icon={Pencil} aria-label={`Rename ${team.name}`} onClick={() => setRenaming(true)} /> : null}
        line={`${teamComputerLong(team.name)}: the bots, routines and apps everyone shares.`}
        actions={admin ? <Button size="md" variant="primary" icon={UserPlus} onClick={onInvite}>Invite people</Button> : null}
        facts={facts}
      />
      {admin ? <RenameDialog t={t} open={renaming} onClose={() => setRenaming(false)} /> : null}
    </>
  );
}

function RenameDialog({ t, open, onClose }: { t: CloudTeamView; open: boolean; onClose: () => void }) {
  const [name, setName] = useState(t.team.name);
  const busy = useCloud(isBusy('rename', t.team.id));
  useEffect(() => { if (open) setName(t.team.name); }, [open, t.team.name]);
  const ok = !!name.trim() && name.trim().length <= 60 && name.trim() !== t.team.name;
  const save = async () => { if (ok && await renameTeam(t.team.id, name.trim())) onClose(); };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="Rename the team"
      description="Everyone on the team sees the new name."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ok} loading={busy} onClick={() => void save()}>Save</Button></>}
    >
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Team name" autoFocus className="w-full" />
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// People

/** The role picker on a person's row (admins): "Member ⌄" / "Admin ⌄". */
function RolePicker({ team, id, role, email }: { team: string; id: string; role: CloudTeamRole; email: string }) {
  const label = role === 'admin' ? 'Admin' : 'Member';
  return (
    <Menu
      align="start"
      items={(['member', 'admin'] as const).map((r) => ({
        label: r === 'admin' ? 'Admin' : 'Member',
        hint: <span className="text-[11px] text-muted">{r === 'admin' ? 'People, plan and billing' : 'Uses the team’s bots'}</span>,
        current: r === role,
        onSelect: () => { if (r !== role) void setMemberRole(team, id, r); },
      }))}
      trigger={(p) => (
        <Button {...p} size="sm" variant="outline" aria-label={`Role of ${email}: ${label}`}>
          {label}
          <Icon icon={ChevronDown} size={12} className="text-muted" />
        </Button>
      )}
    />
  );
}

const copy = (text: string) => { void navigator.clipboard?.writeText(text).catch(() => {}); };
const ROW_GRID = 'grid grid-cols-[minmax(0,1fr)_104px_112px_28px] items-center gap-3 px-4 py-2.5';

/** The team's people: everyone sees the list; admins change roles, remove people, resend and take invites back. */
export function PeopleGroup({ view, t }: { view: CloudAccountView; t: CloudTeamView }) {
  const team = t.team;
  const now = useNow();
  const admin = team.canManage;
  const busy = useCloud((s) => s.busy);
  const rows = memberRows(team, now);
  const invitedCount = rows.filter((r) => r.invited).length;
  const [tab, setTab] = useState<'all' | 'invited'>('all');
  const [query, setQuery] = useState('');
  const [removing, setRemoving] = useState<{ id: string; email: string; invited: boolean } | null>(null);
  const shown = rows
    .filter((r) => (tab === 'invited' ? r.invited : admin || !r.invited))
    .filter((r) => !query.trim() || r.email.toLowerCase().includes(query.trim().toLowerCase()));
  const everyone = admin ? rows.length : rows.filter((r) => !r.invited).length;
  return (
    <SettingsGroup title={TEAM_PEOPLE_TITLE} bare>
      <div className="squircle overflow-hidden rounded-card bg-surface shadow-raised">
        <div className="flex items-center gap-2 border-b border-[color-mix(in_srgb,var(--ab-fg)_6%,transparent)] px-3 py-2.5">
          <div role="tablist" aria-label="People" className="flex gap-0.5">
            <TabButton on={tab === 'all'} onClick={() => setTab('all')} label="Everyone" count={everyone} />
            {admin && invitedCount ? <TabButton on={tab === 'invited'} onClick={() => setTab('invited')} label="Invited" count={invitedCount} /> : null}
          </div>
          <span className="flex-1" />
          <label className="relative w-56 max-w-[45%]">
            <Icon icon={Search} size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search people" aria-label="Search people" className="h-7 w-full pl-8 text-ui" spellCheck={false} />
          </label>
        </div>
        {shown.map((r) => {
          const role = team.people.find((m) => m.id === r.id)?.role ?? 'member';
          const spin = !!(busy[busyKey(`role-${r.id}`, team.id)] || busy[busyKey(`remove-${r.id}`, team.id)] || busy[busyKey(`resend-${r.id}`, team.id)] || busy[busyKey(`revoke-${r.id}`, team.id)]);
          const menu: (MenuItem | 'separator')[] = r.invited ? [
            { label: 'Resend invite', icon: RefreshCw, onSelect: () => void resendInvite(team.id, r.id) },
            { label: 'Copy email', icon: Copy, onSelect: () => copy(r.email) },
            'separator',
            { label: 'Take back invite', icon: X, danger: true, onSelect: () => setRemoving({ id: r.id, email: r.email, invited: true }) },
          ] : [
            { label: role === 'admin' ? 'Make member' : 'Make admin', icon: User, onSelect: () => void setMemberRole(team.id, r.id, role === 'admin' ? 'member' : 'admin') },
            { label: 'Copy email', icon: Copy, onSelect: () => copy(r.email) },
            'separator',
            { label: `Remove from ${team.name}`, icon: Trash2, danger: true, onSelect: () => setRemoving({ id: r.id, email: r.email, invited: false }) },
          ];
          return (
            <div key={r.id} className={cn(ROW_GRID, 'border-t border-[color-mix(in_srgb,var(--ab-fg)_5%,transparent)] first-of-type:border-t-0')}>
              <div className="flex min-w-0 items-center gap-3">
                <PersonAvatar email={r.email} dashed={r.invited} {...(r.you && view.account ? { name: view.account.name, photoUrl: view.account.photoUrl } : {})} />
                <div className="min-w-0">
                  <p className="flex min-w-0 items-center gap-1.5 text-copy leading-5 font-medium text-fg">
                    <span className="selectable truncate">{r.email}</span>
                    {r.you ? <span className="shrink-0 font-normal text-muted">(you)</span> : null}
                  </p>
                  {r.invited ? <p className={cn('truncate text-note leading-4', r.expired ? 'text-warning' : 'text-muted')}>{r.line}</p> : null}
                </div>
              </div>
              <div className="justify-self-start">
                {admin && !r.invited ? <RolePicker team={team.id} id={r.id} role={role} email={r.email} />
                  : admin ? <span className="text-ui text-muted">{r.role}</span>
                  : <Badge tone={role === 'admin' ? 'accent' : 'neutral'}>{r.role}</Badge>}
              </div>
              <div className="justify-self-start">
                {r.invited ? <Badge tone={r.expired ? 'danger' : 'warning'}>{r.expired ? 'Expired' : 'Pending'}</Badge>
                  : <span className="text-ui text-muted tabular-nums">{r.line}</span>}
              </div>
              <div className="flex justify-end">
                {spin ? <Spinner size={14} className="text-muted" /> : admin && !r.you ? (
                  <Menu align="end" items={menu} trigger={(p) => <Button {...p} size="icon-xs" variant="ghost" icon={MoreHorizontal} aria-label={`More for ${r.email}`} />} />
                ) : null}
              </div>
            </div>
          );
        })}
        {!shown.length ? <p className="px-4 py-6 text-center text-copy text-muted">{query ? `No one matches “${query}”.` : 'No one here yet.'}</p> : null}
      </div>
      <RemoveDialog view={view} t={t} removing={removing} onClose={() => setRemoving(null)} />
    </SettingsGroup>
  );
}

function TabButton({ on, onClick, label, count }: { on: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      onClick={onClick}
      className={cn('ab-pill squircle h-7 rounded-md px-2.5 text-copy transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--ab-ring)]', on ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg')}
    >
      {label}<span className="ml-1.5 text-muted tabular-nums">{count}</span>
    </button>
  );
}

/** Remove someone or take an invite back, with "Also drop their seat" (on by default) and what the team then pays. */
function RemoveDialog({ view, t, removing, onClose }: { view: CloudAccountView; t: CloudTeamView; removing: { id: string; email: string; invited: boolean } | null; onClose: () => void }) {
  const team = t.team;
  const now = useNow();
  const busy = useCloud((s) => s.busy);
  const [dropSeat, setDropSeat] = useState(true);
  useEffect(() => { if (removing) setDropSeat(true); }, [removing]);
  const plans = view.catalog?.work?.plans ?? null;
  const drop = seatDropOffer(team, plans, now);
  const interval = team.subscription?.interval ?? team.interval ?? 'monthly';
  const per = plans?.find((p) => p.id === team.plan)?.perMember[interval];
  const confirm = async () => {
    if (!removing) return;
    const drops = drop.offer && dropSeat;
    const ok = removing.invited ? await revokeInvite(team.id, removing.id, drops) : await removeMember(team.id, removing.id, drops);
    if (ok) onClose();
  };
  const loading = !!(removing && (busy[busyKey(`remove-${removing.id}`, team.id)] || busy[busyKey(`revoke-${removing.id}`, team.id)]));
  return (
    <Dialog
      open={!!removing}
      onClose={onClose}
      size="md"
      title={removing?.invited ? `Take back the invite to ${removing.email}?` : `Remove ${removing?.email ?? ''}?`}
      description={removing?.invited ? 'Its link stops working.' : `They lose ${team.name} at once on every device. What they made stays with the team.`}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={loading} onClick={() => void confirm()}>{removing?.invited ? 'Take back' : 'Remove'}</Button>
        </>
      )}
    >
      {drop.offer ? (
        <label className="flex cursor-pointer items-start gap-3 rounded-card bg-surface-2 p-3">
          <Switch checked={dropSeat} onChange={setDropSeat} label={DROP_SEAT_QUESTION} className="mt-0.5" />
          <span className="min-w-0">
            <span className="block text-copy font-medium text-fg">Also drop their seat</span>
            <span className="block text-note leading-5 text-muted tabular-nums">
              {dropSeat
                ? `From ${drop.at ? shortDate(drop.at, now) : 'the renewal'}: ${drop.to} seats${drop.price ? `, ${priceText(drop.price)}` : ''}${per ? ` (saves ${per.display})` : ''}. Until then the seat stays free for someone new.`
                : `The seat stays paid and free for someone new (${drop.from} seats).`}
            </span>
          </span>
        </label>
      ) : (
        <p className="text-note text-muted">Their seat stays{drop.reason ? `: ${drop.reason}` : '.'}</p>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Inviting

/**
 * Invite several people at once: emails as chips (commas, spaces or Enter), a role, and when they don't fit the seats
 * left, an offer to add the seats (previewed, then charged for the time left) or a way to a bigger plan.
 */
export function InviteDialog({ view, t, open, onClose }: { view: CloudAccountView; t: CloudTeamView; open: boolean; onClose: () => void }) {
  const team = t.team;
  const [text, setText] = useState('');
  const [emails, setEmails] = useState<string[]>([]);
  const [bad, setBad] = useState<string[]>([]);
  const [role, setRole] = useState<CloudTeamRole>('member');
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState<CloudPlanChangePreview | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const previewing = useCloud(isBusy('previewPlanChange', team.id));
  const changing = useCloud(isBusy('changePlan', team.id));
  useEffect(() => { if (open) { setText(''); setEmails([]); setBad([]); setRole('member'); setPreview(null); } }, [open]);

  const onTeam = useMemo(() => new Set(team.people.map((p) => p.email.toLowerCase())), [team.people]);
  const pending = inviteEmails(text);
  const all = [...emails, ...pending.emails.filter((e) => !emails.includes(e) && !onTeam.has(e))];
  const free = seatsFree(team);
  const short = Math.max(0, all.length - free);
  const plans = view.catalog?.work?.plans ?? [];
  const interval = team.interval ?? 'monthly';
  const per = plans.find((p) => p.id === team.plan)?.perMember[interval];
  const target = (team.scheduledSeats ?? team.seats ?? team.used) + short;
  const check = seatCheck(team, target, plans);

  const commit = (raw = text) => {
    const { emails: got, bad: wrong } = inviteEmails(raw);
    const fresh = got.filter((e) => !emails.includes(e));
    const already = fresh.filter((e) => onTeam.has(e));
    setEmails((cur) => [...cur, ...fresh.filter((e) => !onTeam.has(e) && !cur.includes(e))]);
    setBad((cur) => [...cur, ...wrong, ...already].filter((b, i, a) => a.indexOf(b) === i));
    setText('');
    setPreview(null);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ' || e.key === 'Tab') {
      if (text.trim()) { e.preventDefault(); commit(); }
    } else if (e.key === 'Backspace' && !text) {
      if (bad.length) setBad((b) => b.slice(0, -1)); else setEmails((m) => m.slice(0, -1));
    }
  };
  const addSeats = async () => { const p = await previewPlanChange(team.plan!, interval, team.id, target); if (p) setPreview(p); };
  const confirmSeats = async () => { if (await changePlan(team.plan!, interval, team.id, target)) { setPreview(null); await loadTeam(team.id); } };
  const send = async () => {
    commit();
    const list = all;
    if (!list.length || short > 0) return;
    setSending(true);
    const failed: string[] = [];
    for (const email of list) if (!(await inviteToTeam(team.id, email, role))) failed.push(email);
    setSending(false);
    if (failed.length) setEmails(failed); else onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={`Invite people to ${team.name}`}
      description={`They sign in with their own email. ${free ? `${free} seat${free === 1 ? '' : 's'} left` : 'No seats left'}${per ? ` · each extra person is ${per.display} a ${interval === 'yearly' ? 'year' : 'month'}` : ''}.`}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!all.length || short > 0} loading={sending} onClick={() => void send()}>
            {all.length > 1 ? `Send ${all.length} invites` : 'Send invite'}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <div
          className="flex min-h-16 cursor-text flex-wrap content-start items-center gap-1.5 squircle rounded-control-lg bg-surface-2 p-2 transition-shadow focus-within:shadow-[0_0_0_2px_var(--ab-ring)]"
          onClick={() => input.current?.focus()}
        >
          {emails.map((e) => <Chip key={e} label={e} onRemove={() => setEmails((m) => m.filter((x) => x !== e))} />)}
          {bad.map((e) => <Chip key={`bad-${e}`} label={e} bad title={onTeam.has(e) ? 'Already on the team or invited' : 'Not an email address'} onRemove={() => setBad((m) => m.filter((x) => x !== e))} />)}
          <input
            ref={input}
            value={text}
            onChange={(e) => { const v = e.target.value; if (/[,;\s]/.test(v.slice(-1)) && v.trim()) commit(v); else setText(v); }}
            onKeyDown={onKey}
            onBlur={() => { if (text.trim()) commit(); }}
            onPaste={(e) => { const v = e.clipboardData.getData('text'); if (/[,;\s]/.test(v.trim())) { e.preventDefault(); commit(`${text} ${v}`); } }}
            placeholder={emails.length || bad.length ? '' : 'Add emails, separated by commas'}
            aria-label="Emails to invite"
            spellCheck={false}
            autoComplete="off"
            className="h-7 min-w-40 flex-1 bg-transparent px-1 text-copy text-fg outline-none placeholder:text-muted"
          />
        </div>
        {bad.length ? <p className="-mt-2 text-note text-warning">{bad.some((b) => onTeam.has(b)) ? 'Some are already on the team or invited; ' : ''}{bad.some((b) => !onTeam.has(b)) ? 'some aren’t email addresses; ' : ''}they won’t be invited.</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-copy font-medium text-fg">Role</span>
          <SettingsSegmented label="Role" value={role} onChange={setRole} options={[{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }]} />
          <span className="text-note text-muted">{teamRoleNote(role)}</span>
        </div>
        {short > 0 ? (
          <div className="flex items-start gap-2.5 rounded-card bg-warning-soft p-3 text-ui leading-5 text-warning">
            <Icon icon={AlertTriangle} size={15} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              {!check.ok ? check.reason
                : preview ? `${preview.chargeNow ? `${preview.chargeNow.display} is charged now for the time left. ` : ''}${preview.recurring ? `From then on: ${priceText(preview.recurring)}.` : ''}`
                : `${peopleText(all.length)}, ${free ? `${free} seat${free === 1 ? '' : 's'}` : 'no seats'} left. Add ${short} seat${short === 1 ? '' : 's'}${per ? ` (${per.display} a ${interval === 'yearly' ? 'year' : 'month'} each, charged now for the time left)` : ''}?`}
            </div>
            {!check.ok ? (
              <Button size="xs" variant="outline" className="shrink-0" onClick={() => { onClose(); ui.openSettings('billing'); }}>Change plan</Button>
            ) : preview ? (
              <Button size="xs" variant="primary" className="shrink-0" loading={changing} onClick={() => void confirmSeats()}>Add {short} seat{short === 1 ? '' : 's'}</Button>
            ) : (
              <Button size="xs" variant="primary" className="shrink-0" loading={previewing} onClick={() => void addSeats()}>Add {short} seat{short === 1 ? '' : 's'}</Button>
            )}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function Chip({ label, bad, title, onRemove }: { label: string; bad?: boolean; title?: string; onRemove: () => void }) {
  return (
    <span title={title} className={cn('ab-pill squircle inline-flex h-6 max-w-full items-center gap-1 rounded-md pr-0.5 pl-2 text-ui', bad ? 'bg-warning-soft text-warning' : 'bg-surface-3 text-fg')}>
      <span className="truncate">{label}</span>
      <button type="button" aria-label={`Remove ${label}`} onClick={(e) => { e.stopPropagation(); onRemove(); }} className="ab-pill flex size-5 items-center justify-center rounded text-current opacity-60 hover:opacity-100">
        <Icon icon={X} size={11} />
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// AI sign-ins, leaving

const LOGIN_CARDS: Record<CloudTeamLogins, { title: string; icon: typeof User }> = {
  own: { title: 'Each person’s own', icon: User },
  shared: { title: 'Shared for the team', icon: KeyRound },
};

/**
 * AI sign-ins (§6.11): each person's own (the default), or one shared set an admin signs in, as two choice cards.
 * Admins pick; members see which it is. Switching loses nothing: every bot carries on under the other set.
 */
export function LoginsGroup({ t }: { t: CloudTeamView }) {
  const team = t.team;
  const admin = team.canManage;
  const logins: CloudTeamLogins = team.logins ?? 'own';
  const busy = useCloud(isBusy('logins', team.id));
  return (
    <SettingsGroup title={TEAM_LOGINS_TITLE} description="Which Claude, ChatGPT and other AI accounts the team’s bots use." bare>
      <div role="radiogroup" aria-label={TEAM_LOGINS_TITLE} className="grid gap-2.5 sm:grid-cols-2">
        {TEAM_LOGINS_OPTIONS.map((o) => {
          const on = o.id === logins;
          const card = LOGIN_CARDS[o.id];
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!admin || busy}
              onClick={() => { if (!on) void setTeamLogins(team.id, o.id); }}
              className={cn(
                'ab-press squircle relative flex flex-col items-start gap-2.5 rounded-card p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--ab-ring)]',
                on ? 'bg-[color-mix(in_srgb,var(--ab-accent)_8%,var(--ab-surface))] shadow-[inset_0_0_0_2px_var(--ab-accent)]'
                  : 'bg-surface shadow-raised',
                admin && !on && 'hover:shadow-raised-hover',
                !admin && !on && 'opacity-55',
                admin && 'cursor-pointer disabled:cursor-default',
              )}
            >
              <RowIcon><Icon icon={card.icon} size={16} /></RowIcon>
              {admin ? (
                <span aria-hidden className={cn('absolute top-4 right-4 size-4 rounded-full border-[1.5px]', on ? 'border-[5px] border-accent' : 'border-[color-mix(in_srgb,var(--ab-fg)_25%,transparent)]')} />
              ) : null}
              {on && busy ? <Spinner size={14} className="absolute top-4 right-4 text-muted" /> : null}
              <span>
                <span className="block text-copy font-semibold text-fg">{card.title}</span>
                <span className="mt-1 block text-ui leading-5 text-muted">{o.description}</span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-note leading-5 text-muted">{admin ? TEAM_LOGINS_TERMS_NOTE : TEAM_LOGINS_MEMBER_NOTE}</p>
    </SettingsGroup>
  );
}

/** Leaving the team, and for admins closing it (cancelling its plan in the billing portal). */
export function DangerGroup({ t }: { t: CloudTeamView }) {
  const team = t.team;
  const [open, setOpen] = useState(false);
  const leaving = useCloud(isBusy('leave', team.id));
  const portal = useCloud(isBusy('portal', team.id));
  const leave = async () => { if (await leaveTeam(team.id)) { forgetTeamCloud(team.id); setOpen(false); } };
  const closes = team.canManage && !!team.plan && !team.subscription?.cancelAtPeriodEnd;
  return (
    <SettingsGroup title="Danger zone" bare>
      <div className="divide-y divide-[color-mix(in_srgb,var(--ab-danger)_18%,transparent)] overflow-hidden rounded-card border border-[color-mix(in_srgb,var(--ab-danger)_32%,transparent)]">
        <LinkRow
          lead={null}
          title={`Leave ${team.name}`}
          description={`Your devices lose ${teamComputerLong(team.name)} at once. What you made stays with the team.`}
          action={<Button size="sm" variant="danger" icon={LogOut} onClick={() => setOpen(true)}>Leave team</Button>}
        />
        {closes ? (
          <LinkRow
            lead={null}
            title={`Close ${team.name}`}
            description={`Cancel the team’s plan in the billing page; it ends at the renewal, and the team’s computer is kept ${keepDaysText(CLOUD_ENDED_KEEP_DAYS)} after that, then deleted.`}
            action={<Button size="sm" variant="danger" loading={portal} onClick={() => void openBilling(team.id)}>Cancel team plan</Button>}
          />
        ) : null}
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="md"
        title={`Leave ${team.name}?`}
        description={`Your devices lose ${teamComputerLong(team.name)} at once. The bots, files and routines you made there stay with the team. An admin can invite you again.`}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="danger" icon={LogOut} loading={leaving} onClick={() => void leave()}>Leave team</Button>
          </>
        )}
      />
    </SettingsGroup>
  );
}

