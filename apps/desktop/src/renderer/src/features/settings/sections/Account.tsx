import { useEffect, useState, type ReactNode } from 'react';
import { computerDisplayName, repairActive } from '@appubot/chat-core';
import type { CloudAccountView, CloudComputer, CloudTeamView } from '@appubot/protocol';
import { ChevronDown, ChevronRight, Cloud, Laptop, LogOut } from '../../../components/ui/icons';
import {
  Badge, Button, Icon, SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE, Spinner, cn, type BadgeTone,
} from '../../../components/ui';
import { useNow } from '../../../lib/hooks';
import { MACHINE } from '../../../lib/platform';
import { useMacName } from '../../../lib/macName';
import { ui } from '../../../lib/store';
import { fixStart, signOutOfCloud, useCloud } from '../../cloud/cloudAccount';
import { forgetCloud, switchComputer, useCloudLink } from '../../cloud/cloudClient';
import { setCloudOnly, useCloudOnly } from '../../cloud/cloudOnly';
import { CloudSignIn } from '../../cloud/CloudSignIn';
import { InvitesGroup, PersonAvatar } from '../../cloud/CloudTeams';
import { CloudTile, MacTile, RowIcon } from '../../cloud/PlanParts';
import { FixComputerGroup } from '../../cloud/FixComputer';
import { fixOffer } from '../../cloud/repairView';
import { cloudPhase, hasPersonalPlan, ownComputerName, phaseWords, planName, teamAsView, type CloudPhase } from '../../cloud/cloudView';
import { useCloudRefresh } from '../../cloud/useCloudRefresh';
import { YOUR_COMPUTER } from '../../cloud/names';
import { ACCOUNT_COMPUTERS_TITLE, ACCOUNT_WHERE_TITLE, ACCOUNT_YOU_TITLE, FIX_COMPUTER_TITLE, settingAnchorId } from '../nav';
import { SectionLoading, SettingsEmptyState, SettingsGroup } from './shared';

/*
 * Settings › Account (the redesign, PROPOSAL.md §3.2): who you are (the email, Sign out), your computers (the AppuBot
 * computer with Awake / Asleep, each team's, this Mac by its own name), each with a Manage that holds Fix your computer (Update /
 * Recover / Reset) and nothing else. No "Download my bots" (owner's call, 2026-11-07). There is no
 * Delete account (2026-11-06: people can't close their account themselves; support does). Watching a computer's screen
 * lives in the right panel's Computer tab, switching computers in the sidebar's switcher; money is Billing's.
 */

const TONE: Partial<Record<CloudPhase, BadgeTone>> = {
  running: 'success', waking: 'accent', provisioning: 'accent', 'past-due': 'warning', ending: 'warning', 'on-hold': 'warning', suspended: 'danger', failed: 'warning',
};
const SPINS: CloudPhase[] = ['provisioning', 'waking'];

/** One computer: its tile, name, state badge and one line; Manage opens its Fix your computer rows under it. */
function ComputerRow({ tile, name, phase, view, line, computer, team, admin = true, action }: {
  tile: ReactNode; name: string; phase?: CloudPhase; view?: CloudAccountView; line: string;
  computer?: CloudComputer; team?: string; admin?: boolean; action?: ReactNode;
}) {
  const now = useNow();
  const offer = fixOffer(computer, admin);
  // opens by itself while a fix runs, or when asked (a notice's "Fix it", the dev mock's &fixdialog=)
  const [open, setOpen] = useState(() => (!team && !!fixStart.kind) || repairActive(computer?.repair));
  useEffect(() => { if (repairActive(computer?.repair)) setOpen(true); }, [computer?.repair]);
  const words = phase ? phaseWords(phase, view, now) : null;
  return (
    <>
      <div className={cn(SETTINGS_ROW, 'flex items-center gap-3')}>
        {tile}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className={cn(SETTINGS_ROW_TITLE, 'truncate')}>{name}</h3>
            {words ? (
              <Badge tone={TONE[phase!] ?? 'neutral'}>
                {SPINS.includes(phase!) ? <Spinner size={10} /> : null}{words.label}
              </Badge>
            ) : null}
          </div>
          <p className={cn('mt-0.5', SETTINGS_ROW_DESCRIPTION)}>{line}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {action}
          {offer.show ? (
            <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              Manage
              <Icon icon={open ? ChevronDown : ChevronRight} size={12} className="text-muted" />
            </Button>
          ) : null}
        </div>
      </div>
      {open && offer.show ? (
        <div id={team ? undefined : settingAnchorId(FIX_COMPUTER_TITLE)} className="scroll-mt-24 bg-[color-mix(in_srgb,var(--ab-fg)_2%,transparent)]">
          <p className={cn(SETTINGS_ROW, 'pb-0 text-note font-medium text-fg')}>{FIX_COMPUTER_TITLE}</p>
          <FixComputerGroup computer={computer} team={team} admin={admin} inline />
        </div>
      ) : null}
    </>
  );
}


/** what the computer row says under its name: the plan and the benefit, or what's going on */
function ownLine(view: CloudAccountView, phase: CloudPhase): string {
  const sub = view.account?.subscription;
  const plan = view.computer?.plan?.name ?? (sub ? planName(view, sub.plan) : '');
  if (phase === 'running' || phase === 'asleep' || phase === 'stopped') return `${plan ? `${plan} · ` : ''}your bots run here 24/7, in the cloud`;
  return phaseWords(phase, view).line || plan;
}

function ComputersGroup({ view }: { view: CloudAccountView }) {
  const phase = cloudPhase(view);
  const personal = view.signedIn && hasPersonalPlan(view) && phase !== 'deleted';
  const teams = view.signedIn ? (view.teams ?? []) : [];
  const macName = useMacName();
  const cloudOnly = useCloudOnly().inEffect;
  return (
    <SettingsGroup title={ACCOUNT_COMPUTERS_TITLE}>
      {personal ? (
        <ComputerRow
          tile={<CloudTile size={36} />}
          name={ownComputerName(view)}
          phase={phase}
          view={view}
          line={ownLine(view, phase)}
          computer={view.computer}
        />
      ) : null}
      {teams.map((t) => <TeamComputerRow key={t.team.id} view={view} t={t} />)}
      <ComputerRow
        tile={<MacTile size={36} />}
        name={macName}
        line={cloudOnly ? 'Only in the cloud · its bots are paused here' : 'Free · bots here work while it’s awake'}
      />
    </SettingsGroup>
  );
}

/**
 * Where your bots work (2026-11-15): "Only in the cloud" or "Cloud and this Mac", for someone with a cloud computer
 * that can work (and always while it is on, so it can be turned off from either computer). Only in the cloud, this Mac
 * leaves the switchers, its routines and Telegram bots pause and AppuBot opens on the cloud computer; nothing is
 * deleted, and turning it off brings it all back as it was (features/cloud/cloudOnly.ts, chat-core `cloudOnly.ts`).
 */
function WhereGroup() {
  const c = useCloudOnly();
  const macName = useMacName();
  const onMac = useCloudLink((s) => s.computer !== 'cloud');
  const [busy, setBusy] = useState(false);
  if (!c.offered) return null;
  const pick = async (cloudOnly: boolean) => {
    if (busy || cloudOnly === c.chosen) return;
    setBusy(true);
    const saved = await setCloudOnly(cloudOnly);
    setBusy(false);
    // turned on from this Mac's screen: over to the cloud computer at once (Settings stays open)
    const to = c.usable[0];
    if (saved && cloudOnly && onMac && to) void switchComputer('cloud', to.team);
  };
  const cards = [
    { on: true, icon: Cloud, title: 'Only in the cloud', line: `${macName} stops running bots: its routines and Telegram bots pause, and it leaves the computer menu.` },
    { on: false, icon: Laptop, title: `Cloud and this ${MACHINE}`, line: `Bots work in both places, each with its own routines and Telegram bots.` },
  ];
  const note = c.chosen && !c.inEffect
    ? `None of your AppuBot computers can work right now, so ${macName} runs its bots as before until one can.`
    : `Nothing is deleted. Switch back any time and everything on this ${MACHINE} runs again as it was.`;
  return (
    <SettingsGroup title={ACCOUNT_WHERE_TITLE} description={`Keep using this ${MACHINE} for bots, or let ${YOUR_COMPUTER} do it all.`} bare>
      <div role="radiogroup" aria-label={ACCOUNT_WHERE_TITLE} className="grid gap-2.5 sm:grid-cols-2">
        {cards.map((o) => {
          const on = o.on === c.chosen;
          return (
            <button
              key={o.title}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={busy}
              onClick={() => void pick(o.on)}
              className={cn(
                'ab-press squircle relative flex cursor-pointer flex-col items-start gap-2.5 rounded-card p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--ab-ring)] disabled:cursor-default',
                on ? 'bg-[color-mix(in_srgb,var(--ab-accent)_8%,var(--ab-surface))] shadow-[inset_0_0_0_2px_var(--ab-accent)]'
                  : 'bg-surface shadow-raised hover:shadow-raised-hover',
              )}
            >
              <RowIcon><Icon icon={o.icon} size={16} /></RowIcon>
              {on && busy ? <Spinner size={14} className="absolute top-4 right-4 text-muted" />
                : <span aria-hidden className={cn('absolute top-4 right-4 size-4 rounded-full border-[1.5px]', on ? 'border-[5px] border-accent' : 'border-[color-mix(in_srgb,var(--ab-fg)_25%,transparent)]')} />}
              <span>
                <span className="block text-copy font-semibold text-fg">{o.title}</span>
                <span className="mt-1 block text-ui leading-5 text-muted">{o.line}</span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-note leading-5 text-muted">{note}</p>
    </SettingsGroup>
  );
}

function TeamComputerRow({ view, t }: { view: CloudAccountView; t: CloudTeamView }) {
  const tv = teamAsView(view, t);
  const phase = cloudPhase(tv);
  const plan = t.team.plan ? planName(view, t.team.plan) : '';
  const people = t.team.members;
  const line = [plan, `shared with ${people} ${people === 1 ? 'person' : 'people'}`, t.team.canManage ? 'you’re an admin' : ''].filter(Boolean).join(' · ');
  return (
    <ComputerRow
      tile={<CloudTile team={t.team.name} size={36} />}
      name={computerDisplayName({ team: t.team.name })}
      phase={t.computer ? phase : undefined}
      view={tv}
      line={line}
      computer={t.computer}
      team={t.team.id}
      admin={t.team.canManage}
      action={(
        <Button size="sm" variant="ghost" onClick={() => ui.openSettings('team')}>
          Team
          <Icon icon={ChevronRight} size={12} className="text-muted" />
        </Button>
      )}
    />
  );
}

function YouGroup({ view }: { view: CloudAccountView }) {
  const busy = useCloud((s) => !!s.busy.signOut);
  const email = view.account?.email;
  const name = view.account?.name;
  return (
    <section id={settingAnchorId(ACCOUNT_YOU_TITLE)} className="scroll-mt-24">
      <div className="overflow-hidden rounded-control-lg border border-[color-mix(in_srgb,var(--ab-fg)_6%,transparent)] bg-[color-mix(in_srgb,var(--ab-fg)_1.5%,transparent)]">
        {view.signedIn ? (
          <div className={cn(SETTINGS_ROW, 'flex items-center gap-3 py-4')}>
            {email ? <PersonAvatar email={email} name={name} size={40} photoUrl={view.account?.photoUrl} /> : null}
            <div className="min-w-0 flex-1">
              <h3 className={cn(SETTINGS_ROW_TITLE, 'selectable truncate')}>{name ?? email ?? 'Signed in'}</h3>
              {name && email ? <p className={cn('selectable truncate', SETTINGS_ROW_DESCRIPTION)}>{email}</p> : null}
              <p className={cn('mt-0.5', SETTINGS_ROW_DESCRIPTION)}>The same account on this {MACHINE}, your phone and the web.</p>
            </div>
            <Button size="sm" variant="outline" icon={LogOut} loading={busy} onClick={async () => { forgetCloud(); await signOutOfCloud(); }}>Sign out</Button>
          </div>
        ) : <CloudSignIn />}
      </div>
    </section>
  );
}

export function AccountSection() {
  const view = useCloud((s) => s.view);
  const supported = useCloud((s) => s.supported);
  useCloudRefresh();
  if (supported === false) return <SettingsEmptyState>Update AppuBot to sign in.</SettingsEmptyState>;
  if (!view) return <SectionLoading />;
  return (
    <div className="space-y-6">
      <YouGroup view={view} />
      {view.signedIn ? <InvitesGroup view={view} /> : null}
      <ComputersGroup view={view} />
      <WhereGroup />
    </div>
  );
}
