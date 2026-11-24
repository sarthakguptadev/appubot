import { useState, type ReactNode } from 'react';
import type { CloudAccountView, CloudInterval, CloudPlanChangePreview, CloudTeamView } from '@appubot/protocol';
import { CLOUD_ENDED_KEEP_DAYS, keepDaysText, intervalLabel, peopleText, priceText, shortDate, computerDisplayName } from '@appubot/chat-core';
import { ChevronRight, CreditCard, ExternalLink, FileText, MoreHorizontal, Users, X } from '../../../components/ui/icons';
import { Badge, Button, Dialog, Icon, Menu, SETTINGS_SECTION_TITLE, SettingsCard, type MenuItem } from '../../../components/ui';
import { useNow } from '../../../lib/hooks';
import { MACHINE } from '../../../lib/platform';
import { ui } from '../../../lib/store';
import { buyCloud, busyKey, cancelPlanChange, changePlan, openBilling, previewPlanChange, useCloud } from '../../cloud/cloudAccount';
import { CloudSignIn } from '../../cloud/CloudSignIn';
import { InviteCard, SeatsDialog } from '../../cloud/CloudTeams';
import { PlanCards, usePlanChoice, type CurrentPlan } from '../../cloud/Paywall';
import { Band, CloudTile, LinkRow, MacTile, PlanCardBox, QuietLink, RowIcon, TeamTile, type Fact } from '../../cloud/PlanParts';
import {
  cloudPhase, creditFact, hasPersonalPlan, ownComputerName, perText, phaseWords, planCard, planMove, planMoveLabel, planName, planStatus, seatsBreakdown, seatsFree,
  teamAsView, teamCard, yearlySaving, type CloudPhase, type PaywallCard,
} from '../../cloud/cloudView';
import { YOUR_COMPUTER_CAP, exportOnlyText, teamComputerLong } from '../../cloud/names';
import { useCloudRefresh } from '../../cloud/useCloudRefresh';
import { BILLING_PLAN_TITLE, BILLING_PLANS_TITLE, BILLING_TEAMS_TITLE, settingAnchorId } from '../nav';
import { SectionLoading, SettingsEmptyState } from './shared';

/*
 * Settings › Billing (the 2026-11-05 revamp, direction A "Plan cards", after Vercel's and Cursor's billing pages):
 *  - invites waiting for this person on top, each a card with Decline / Join;
 *  - Your plan(s): a card per computer: the person's own ("Sarthak’s Cloud Computer") and each team's with a cloud tile (a team's in its colour), or Free
 *    on this Mac. A card has a status badge, one action (Change plan) and a ⋯ menu, a coloured band when something
 *    needs the person (a failed payment: Update card; ending: Keep my plan; a downgrade waiting: Keep <plan>), and a
 *    strip of facts: price (a team's as base + extra seats), next charge, seats with a meter, the launch bonus with one;
 *  - Change plan opens the site's plan cards under the list; picking one previews the change, then makes it;
 *  - no plan of their own: the plan cards (a team member gets one quiet row that opens them); on Free (no team) the
 *    plan cards come first and "Your plan · Free" under them;
 *  - Payments: payment method and invoices, both on Dodo's secure page; Teams: Start a team (Start another team once on one: a person may run several). Cancel plan lives in each plan card's ⋯ menu.
 */

/** which plan's cards are open under the list: the person's own, a team's (its id), or a new team's */
type Chooser = { kind: 'own' } | { kind: 'team'; team: string } | { kind: 'new-team' } | null;

/** what a plan change will do, asked before it's made */
interface Pending { title: string; confirm: string; preview: CloudPlanChangePreview; run: () => Promise<unknown> }

const scrollTo = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));

function Section({ id, title, description, action, children }: { id?: string; title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section id={id ?? settingAnchorId(title)} className="flex scroll-mt-24 flex-col gap-3">
      <div>
        <div className="flex min-h-7 items-center justify-between gap-4">
          <h2 className={SETTINGS_SECTION_TITLE}>{title}</h2>
          {action}
        </div>
        {description ? <p className="text-ui leading-5 text-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function MoreMenu({ items, label }: { items: (MenuItem | 'separator')[]; label: string }) {
  if (!items.length) return null;
  return <Menu align="end" items={items} trigger={(p) => <Button {...p} size="icon-sm" variant="ghost" icon={MoreHorizontal} aria-label={label} />} />;
}

/** The band, the badge and the second fact for a computer's phase (the person's own or a team's). */
function phaseParts(phase: CloudPhase, opts: { plan: string; periodEnd?: number; /** on its free trial until then */ trialEndsAt?: number; pastDueEndsAt?: number; exportUntil?: number; team?: string; scheduled?: string[]; onKeep?: () => void; keepLoading?: boolean; portalLoading: boolean }, now: number) {
  const fix = (label: string) => <Button size="xs" variant="primary" loading={opts.portalLoading} onClick={() => void openBilling(opts.team)}>{label}</Button>;
  const whose = opts.team ? 'the team’s computer' : 'your computer';
  let band: ReactNode = null;
  let fact: Fact | null = null;
  switch (phase) {
    case 'past-due':
      band = <Band tone="danger" action={fix('Update card')}>The last payment didn’t go through. {opts.pastDueEndsAt ? `Update the card by ${shortDate(opts.pastDueEndsAt, now)} to keep ${whose} running.` : `Update the card to keep ${whose} running.`}</Band>;
      fact = { label: 'Payment', value: 'Didn’t go through', tone: 'danger', sub: opts.pastDueEndsAt ? `Pauses ${shortDate(opts.pastDueEndsAt, now)}` : 'Retrying' };
      break;
    case 'on-hold':
      band = <Band tone="danger" action={fix('Update card')}>{opts.team ? 'The team’s computer is paused: the payment didn’t go through. Its bots and files are kept.' : 'Your computer is paused: the payment didn’t go through. Your bots and files are kept.'}</Band>;
      fact = { label: 'Payment', value: 'On hold', tone: 'danger', sub: 'Paused until it’s paid' };
      break;
    case 'ending':
      band = <Band tone="warning" action={fix('Keep my plan')}>The {opts.plan} plan ends on {opts.periodEnd ? shortDate(opts.periodEnd, now) : 'the renewal'}. {opts.team ? 'Its' : 'Your'} bots and files are kept for {keepDaysText(CLOUD_ENDED_KEEP_DAYS)} after, then deleted.</Band>;
      fact = { label: 'Ends on', value: opts.periodEnd ? shortDate(opts.periodEnd, now) : 'At the renewal', tone: 'warning', sub: 'No more charges' };
      break;
    case 'export-only': case 'suspended':
      band = <Band tone="neutral">{phase === 'export-only' ? exportOnlyText(opts.plan, opts.exportUntil, now) : phaseWords(phase).line}</Band>;
      break;
    default:
      if (opts.scheduled?.length) {
        band = <Band tone="neutral" action={opts.onKeep ? <Button size="xs" variant="outline" loading={opts.keepLoading} onClick={opts.onKeep}>Keep {opts.plan}</Button> : undefined}>{opts.scheduled.join('. ')}.</Band>;
      }
      // on its free trial: nothing charged yet, the first charge the day it ends
      fact = opts.trialEndsAt ? { label: 'First charge', value: shortDate(opts.trialEndsAt, now), sub: 'Free until then. Cancel before and you pay nothing' }
        : opts.periodEnd ? { label: 'Next charge', value: shortDate(opts.periodEnd, now), sub: 'Renews by itself' } : null;
  }
  return { band, fact };
}

function OwnPlanCard({ view, phase, onChange, onYearly }: { view: CloudAccountView; phase: CloudPhase; onChange: () => void; onYearly: () => void }) {
  const now = useNow();
  const busy = useCloud((s) => s.busy);
  const card = planCard(view, phase, now);
  const sub = view.account?.subscription;
  if (!card || !sub) return null;
  const name = view.computer?.plan?.name ?? planName(view, sub.plan);
  const ended = phase === 'export-only' || phase === 'suspended';
  const price = view.computer?.plan?.price;
  const save = sub.interval === 'monthly' && phase !== 'ending' && !card.attention ? yearlySaving(view, sub.plan) : '';
  const status = planStatus(phase, !!sub.trialEndsAt);
  const credit = view.computer?.credit;
  const { band, fact } = phaseParts(phase, {
    plan: name, periodEnd: sub.periodEnd, ...(sub.trialEndsAt ? { trialEndsAt: sub.trialEndsAt } : {}), ...(sub.pastDueEndsAt ? { pastDueEndsAt: sub.pastDueEndsAt } : {}), ...(view.account?.exportUntil ? { exportUntil: view.account.exportUntil } : {}),
    scheduled: card.scheduled ? [card.scheduled] : [], onKeep: () => void cancelPlanChange(), keepLoading: !!busy.cancelPlanChange, portalLoading: !!busy.portal,
  }, now);
  const facts: Fact[] = ended ? [] : [
    { label: 'Price', value: price ? perText(price) : card.price || name, sub: sub.interval === 'yearly' ? 'Billed yearly' : <>Billed monthly{save ? <> · <QuietLink onClick={onYearly}>Save {save} yearly</QuietLink></> : null}</> },
    ...(fact ? [fact] : []),
    ...(credit ? [(() => { const c = creditFact(credit, now); return { label: 'Claude launch bonus', value: c.value, meter: c.fraction, accent: true, sub: c.sub } satisfies Fact; })()] : []),
  ];
  const menu: (MenuItem | 'separator')[] = ended ? [] : [
    { label: 'Manage billing', icon: ExternalLink, onSelect: () => void openBilling() },
    ...(save ? [{ label: `Switch to yearly (save ${save})`, onSelect: onYearly }] : []),
    ...(phase !== 'ending' ? ['separator' as const, { label: 'Cancel plan', danger: true, onSelect: () => void openBilling() }] : []),
  ];
  return (
    <PlanCardBox
      band={band}
      tile={<CloudTile size={44} />}
      title={ownComputerName(view)}
      badges={<>
        <Badge>{name}</Badge>
        {sub.interval === 'yearly' ? <Badge tone="accent">{intervalLabel(sub.interval)}</Badge> : null}
        <Badge tone={status.tone} dot>{status.label}</Badge>
      </>}
      line={[YOUR_COMPUTER_CAP, card.shape].filter(Boolean).join(' · ')}
      actions={ended ? null : (
        <>
          {card.attention || phase === 'ending' ? null : <Button size="sm" variant="outline" onClick={onChange}>Change plan</Button>}
          <MoreMenu items={menu} label="More for your plan" />
        </>
      )}
      facts={facts}
    />
  );
}

function FreePlanCard() {
  return (
    <PlanCardBox
      tile={<MacTile size={44} />}
      title="Free"
      badges={<Badge>This {MACHINE}</Badge>}
      line={`Your bots work while this ${MACHINE} is awake and AppuBot is open.`}
    />
  );
}

function TeamPlanCard({ view, t, onChange, onSeats }: { view: CloudAccountView; t: CloudTeamView; onChange: () => void; onSeats: () => void }) {
  const now = useNow();
  const busy = useCloud((s) => s.busy);
  const team = t.team;
  const card = teamCard(view, t, now);
  const plan = team.plan ? planName(view, team.plan) : '';
  if (!team.canManage) {
    return (
      <PlanCardBox
        tile={<CloudTile team={team.name} size={44} />}
        title={computerDisplayName({ team: team.name })}
        badges={plan ? <Badge>{plan}</Badge> : null}
        line={`You’re a member · ${peopleText(team.members)} · its admins handle the plan and billing`}
        actions={<Button size="sm" variant="ghost" onClick={() => ui.openSettings('team')}>Open Team<Icon icon={ChevronRight} size={12} className="text-muted" /></Button>}
      />
    );
  }
  const tv = teamAsView(view, t);
  const phase = cloudPhase(tv);
  const sub = team.subscription;
  const status = planStatus(phase, !!sub?.trialEndsAt);
  const free = seatsFree(team);
  const work = team.plan ? view.catalog?.work?.plans.find((p) => p.id === team.plan) : undefined;
  const credit = t.computer?.credit;
  const { band, fact } = phaseParts(phase, {
    plan: plan || 'team', team: team.id, ...(sub ? { periodEnd: sub.periodEnd } : {}), ...(sub?.trialEndsAt ? { trialEndsAt: sub.trialEndsAt } : {}), ...(sub?.pastDueEndsAt ? { pastDueEndsAt: sub.pastDueEndsAt } : {}),
    scheduled: card.scheduled, onKeep: () => void cancelPlanChange(team.id), keepLoading: !!busy[busyKey('cancelPlanChange', team.id)], portalLoading: !!busy[busyKey('portal', team.id)],
  }, now);
  const price = card.price.replace(/ a (month|year)$/, ' / $1');
  const facts: Fact[] = team.plan ? [
    { label: 'Price', value: price || plan, sub: seatsBreakdown(view, team) || (work ? '' : undefined) },
    ...(team.seats ? [{
      label: 'Seats', value: `${team.used} of ${team.seats} used`, meter: team.used / team.seats,
      sub: <><QuietLink onClick={onSeats}>Change seats</QuietLink>{free ? ` · ${free} open` : ''}</>,
    } satisfies Fact] : []),
    ...(fact ? [fact] : []),
    ...(credit ? [(() => { const c = creditFact(credit, now); return { label: 'Claude launch bonus', value: c.value, meter: c.fraction, accent: true, sub: c.sub } satisfies Fact; })()] : []),
  ] : [];
  const menu: (MenuItem | 'separator')[] = [
    { label: 'Manage billing', icon: ExternalLink, onSelect: () => void openBilling(team.id) },
    ...(team.plan && team.seats ? [{ label: 'Change seats', icon: Users, onSelect: onSeats }] : []),
    { label: 'People and roles', onSelect: () => ui.openSettings('team') },
    ...(team.plan && phase !== 'ending' ? ['separator' as const, { label: 'Cancel the team’s plan', danger: true, onSelect: () => void openBilling(team.id) }] : []),
  ];
  return (
    <PlanCardBox
      band={band}
      tile={<CloudTile team={team.name} size={44} />}
      title={computerDisplayName({ team: team.name })}
      badges={<>
        {plan ? <Badge>{plan}</Badge> : null}
        {team.interval === 'yearly' ? <Badge tone="accent">{intervalLabel(team.interval)}</Badge> : null}
        {team.plan ? <Badge tone={status.tone} dot>{status.label}</Badge> : null}
      </>}
      line={`${teamComputerLong(team.name)} · you’re an admin`}
      actions={(
        <>
          {team.plan && !card.attention && phase !== 'ending' ? <Button size="sm" variant="outline" onClick={onChange}>Change plan</Button> : null}
          <MoreMenu items={menu} label={`More for ${computerDisplayName({ team: team.name })}`} />
        </>
      )}
      facts={facts}
    />
  );
}

/** The cards for a plan being changed (or a new team): opened from a card's Change plan or Start a team. */
function ChooserGroup({ view, chooser, onClose, onPending }: { view: CloudAccountView; chooser: NonNullable<Chooser>; onClose: () => void; onPending: (p: Pending) => void }) {
  const sub = view.account?.subscription;
  const t = chooser.kind === 'team' ? (view.teams ?? []).find((x) => x.team.id === chooser.team) : undefined;
  const seats = t?.team.seats ?? t?.team.used;
  const current: CurrentPlan | undefined = chooser.kind === 'own' && sub ? { plan: sub.plan, interval: sub.interval }
    : t?.team.plan ? { plan: t.team.plan, interval: t.team.interval ?? 'monthly', ...(seats ? { seats } : {}) } : undefined;
  const choice = usePlanChoice({ kind: chooser.kind === 'own' ? 'personal' : 'work', ...(current ? { interval: current.interval } : {}), ...(seats ? { members: seats } : {}) });
  const [asking, setAsking] = useState<string | null>(null);
  const title = chooser.kind === 'own' ? 'Change your plan' : chooser.kind === 'team' ? `Change ${t?.team.name ?? 'the team'}’s plan` : 'Start a team';
  const used = t?.team.used ?? 0;
  const blocked = t && choice.members < used ? `${peopleText(used)} are on ${t.team.name} or invited: remove someone in Settings › Team first.` : undefined;

  const pick = async (c: PaywallCard, interval: CloudInterval, members: number) => {
    if (chooser.kind === 'new-team' || !current) { setAsking(c.id); await buyCloud(c.id, interval, members); setAsking(null); return; }
    const team = t?.team.id;
    const order = (team ? view.catalog?.work?.plans : view.catalog?.plans)?.map((p) => p.id) ?? [];
    const move = planMove(order, current, { plan: c.id, interval, ...(team ? { seats: members } : {}) });
    setAsking(c.id);
    const preview = await previewPlanChange(c.id, interval, team, team ? members : undefined);
    setAsking(null);
    if (!preview) return;
    const label = move === 'seats' ? `Change to ${peopleText(members)}` : planMoveLabel(move, c.name, interval);
    onPending({ title: `${label}?`, confirm: label, preview, run: () => changePlan(c.id, interval, team, team ? members : undefined) });
  };

  return (
    <Section id="billing-chooser" title={title} action={<Button size="icon-sm" variant="ghost" icon={X} aria-label="Close the plans" onClick={onClose} />}>
      {view.catalog ? (
        <PlanCards
          view={view}
          choice={choice}
          mode={chooser.kind === 'own' ? 'personal' : chooser.kind === 'team' ? 'team' : 'buy'}
          current={current}
          blocked={blocked}
          loadingId={asking}
          onPick={(c, i, m) => void pick(c, i, m)}
        />
      ) : <SettingsEmptyState>The plans show once AppuBot reaches its servers.</SettingsEmptyState>}
    </Section>
  );
}

export function BillingSection() {
  const view = useCloud((s) => s.view);
  const supported = useCloud((s) => s.supported);
  const busy = useCloud((s) => s.busy);
  const now = useNow();
  const choice = usePlanChoice();
  const [chooser, setChooser] = useState<Chooser>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [showPlans, setShowPlans] = useState(false);
  const [seatsFor, setSeatsFor] = useState<string | null>(null);
  useCloudRefresh();
  if (supported === false) return <SettingsEmptyState>Update AppuBot to see your plan.</SettingsEmptyState>;
  if (!view) return <SectionLoading />;

  const phase = cloudPhase(view);
  const sub = view.account?.subscription;
  const personal = view.signedIn && hasPersonalPlan(view) && !!sub;
  const live = personal && phase !== 'export-only' && phase !== 'suspended';
  const teams = view.signedIn ? (view.teams ?? []) : [];
  const managed = teams.filter((t) => t.team.canManage && t.team.plan);
  const invites = view.signedIn ? (view.account?.invites ?? []) : [];
  const email = view.account?.email;
  const seatsTeam = teams.find((t) => t.team.id === seatsFor);
  const cheapest = (view.catalog?.plans ?? []).map((p) => p.monthly).filter((p) => !!p).sort((a, b) => a!.amount - b!.amount)[0];

  const open = (c: NonNullable<Chooser>) => { setChooser(c); scrollTo('billing-chooser'); };
  const startTeam = () => {
    if (!live) { choice.setKind('work'); setShowPlans(true); scrollTo(settingAnchorId(BILLING_PLANS_TITLE)); return; }
    open({ kind: 'new-team' });
  };
  const buy = async (c: PaywallCard, interval: CloudInterval, members: number) => {
    setBuying(c.id);
    await buyCloud(c.id, interval, choice.kind === 'work' ? members : undefined);
    setBuying(null);
  };
  const yearly = async () => {
    if (!sub) return;
    const preview = await previewPlanChange(sub.plan, 'yearly');
    if (preview) setPending({ title: 'Switch to yearly?', confirm: 'Switch to yearly', preview, run: () => changePlan(sub.plan, 'yearly') });
  };
  const confirm = async () => {
    if (!pending) return;
    if (await pending.run()) { setPending(null); setChooser(null); }
  };
  // the person's own plan cards: always without a plan, behind one quiet row for someone already on a team
  // signed out too: the plans are public, and picking one signs in first, then opens its checkout (`buyCloud`)
  const plansOpen = !live && (!teams.length || showPlans || choice.kind === 'work');
  // on Free (signed in, no plan of their own, no team) the plans lead and "Your plan · Free" follows them
  const freeFirst = plansOpen && !personal && !teams.length;

  // the anchor the search and the switcher land on, whatever the group's title says
  const planGroup = (
    <Section id={settingAnchorId(BILLING_PLAN_TITLE)} title={teams.length ? 'Your plans' : BILLING_PLAN_TITLE}>
      <div className="flex flex-col gap-3">
        {personal ? <OwnPlanCard view={view} phase={phase} onChange={() => open({ kind: 'own' })} onYearly={() => void yearly()} /> : <FreePlanCard />}
        {teams.map((t) => (
          <TeamPlanCard key={t.team.id} view={view} t={t} onChange={() => open({ kind: 'team', team: t.team.id })} onSeats={() => setSeatsFor(t.team.id)} />
        ))}
        {!view.signedIn ? <SettingsCard><CloudSignIn /></SettingsCard> : null}
      </div>
    </Section>
  );

  const plansGroup = plansOpen ? (
    <Section id={settingAnchorId(BILLING_PLANS_TITLE)} title={personal ? 'Start again' : 'Get your AppuBot computer'} description="Your bots keep working 24/7 in the cloud, even when this computer sleeps.">
      {view.catalog ? (
        <PlanCards view={view} choice={choice} mode="buy" soldOut={phase === 'sold-out'} loadingId={busy.checkout ? buying : null} onPick={(c, i, m) => void buy(c, i, m)} />
      ) : <SettingsEmptyState>The plans show once AppuBot reaches its servers.</SettingsEmptyState>}
    </Section>
  ) : view.signedIn && !live ? (
    <div id={settingAnchorId(BILLING_PLANS_TITLE)} className="scroll-mt-24"><SettingsCard>
      <LinkRow
        lead={<CloudTile size={32} />}
        title="Your own AppuBot computer"
        description={`Bots of your own, running 24/7 in the cloud.${cheapest ? ` From ${cheapest.display} a month.` : ''}`}
        action={<Button size="sm" variant="outline" onClick={() => setShowPlans(true)}>See plans</Button>}
      />
    </SettingsCard></div>
  ) : null;

  return (
    <div className="space-y-8">
      {invites.length ? <div className="flex flex-col gap-2.5">{invites.map((i) => <InviteCard key={i.id} invite={i} />)}</div> : null}

      {freeFirst ? plansGroup : planGroup}

      {chooser && view.signedIn ? (
        <ChooserGroup key={chooser.kind === 'team' ? chooser.team : chooser.kind} view={view} chooser={chooser} onClose={() => setChooser(null)} onPending={setPending} />
      ) : null}

      {freeFirst ? planGroup : plansGroup}

      {live || managed.length ? (
        <Section title="Payments">
          <SettingsCard>
            {live ? (
              <>
                <LinkRow
                  lead={<RowIcon><Icon icon={CreditCard} size={16} /></RowIcon>}
                  title="Payment method"
                  description="Change the card your plan is charged to"
                  action={<Button size="sm" variant="outline" iconRight={ExternalLink} loading={!!busy.portal} onClick={() => void openBilling()}>Update</Button>}
                />
                <LinkRow
                  lead={<RowIcon><Icon icon={FileText} size={16} /></RowIcon>}
                  title="Invoices and receipts"
                  description="Every receipt, your billing address and tax ID"
                  action={<Button size="sm" variant="outline" iconRight={ExternalLink} loading={!!busy.portal} onClick={() => void openBilling()}>View</Button>}
                />
              </>
            ) : null}
            {managed.map((t) => (
              <LinkRow
                key={t.team.id}
                lead={<TeamTile name={t.team.name} size={32} />}
                title={`${t.team.name}’s payments`}
                description="The team’s card, receipts, billing address and tax ID"
                action={<Button size="sm" variant="outline" iconRight={ExternalLink} loading={!!busy[busyKey('portal', t.team.id)]} onClick={() => void openBilling(t.team.id)}>Manage billing</Button>}
              />
            ))}
          </SettingsCard>
          <p className="-mt-1 text-note leading-5 text-muted">Payments are handled by Dodo Payments; these open its secure page in your browser.</p>
        </Section>
      ) : null}

      {view.signedIn ? (
        <Section title={BILLING_TEAMS_TITLE}>
          <SettingsCard>
            <LinkRow
              lead={<RowIcon><Icon icon={Users} size={16} /></RowIcon>}
              title={teams.length ? 'Start another team' : 'Start a team'}
              description={teams.length
                ? `A separate computer with its own people, bots and bill. Your teams stay as they are.${workFrom(view)}`
                : `One computer for your team, shared bots, roles and one bill.${workFrom(view)}`}
              action={<Button size="sm" variant="outline" onClick={startTeam}>See Work plans</Button>}
            />
          </SettingsCard>
          {teams.length ? null : <p className="-mt-1 text-note leading-5 text-muted">Joining one? Ask its admin to invite {email ? <span className="text-fg-2">{email}</span> : 'your email'}.</p>}
        </Section>
      ) : null}

      {seatsTeam?.team.plan ? <SeatsDialog view={view} t={seatsTeam} open={!!seatsFor} onClose={() => setSeatsFor(null)} /> : null}
      <Dialog
        open={!!pending}
        onClose={() => setPending(null)}
        size="md"
        title={pending?.title ?? ''}
        description={pending ? changeWords(pending.preview, now) : ''}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
            <Button variant="primary" loading={Object.keys(busy).some((k) => k.startsWith('changePlan'))} onClick={() => void confirm()}>{pending?.confirm ?? 'Confirm'}</Button>
          </>
        )}
      />
    </div>
  );
}

/** " From $29 a month." for Start a team ('' without the catalog) */
function workFrom(view: CloudAccountView): string {
  const p = (view.catalog?.work?.plans ?? []).map((w) => w.base.monthly).filter((x) => !!x).sort((a, b) => a!.amount - b!.amount)[0];
  return p ? ` From ${p.display} a month.` : '';
}

/** "$30 is charged now, less what's left of this period. From then on: $89 a month." / "It changes on 5 Dec. …" */
function changeWords(p: CloudPlanChangePreview, now: number): string {
  const when = p.when === 'immediate'
    ? (p.chargeNow ? `${p.chargeNow.display} is charged now, less what’s left of this period.` : 'It applies now.')
    : `It changes on ${shortDate(p.effectiveAt, now)}; until then nothing changes.`;
  return p.recurring ? `${when} From then on: ${priceText(p.recurring)}.` : when;
}
