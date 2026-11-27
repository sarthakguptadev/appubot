import { Check, ChevronsUpDown, Cloud, Laptop, Plus } from '../../components/ui/icons';
import { Icon, Menu, Spinner, cn, type MenuItem } from '../../components/ui';
import { useMacName } from '../../lib/macName';
import { ui } from '../../lib/store';
import { BILLING_PLANS_TITLE, settingAnchorId } from '../settings/nav';
import { paywallStart, useCloud } from './cloudAccount';
import { switchComputer, useCloudLink } from './cloudClient';
import { ADD_COMPUTER_LABEL, listsThisComputer, teamTint } from '@appubot/chat-core';
import { useHeldFor } from '../../lib/connectionQuiet';
import { useCloudOnly } from './cloudOnly';
import { cloudPhase, cloudTargets, hasPersonalPlan, ownComputerName, targetName, type CloudTarget } from './cloudView';

/** the "Add a cloud computer" row's icon: a plus in a tile's outline */
function AddComputerIcon() {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center rounded-[4px] text-muted shadow-[inset_0_0_0_1.25px_currentColor]">
      <Icon icon={Plus} size={10} strokeWidth={2.5} />
    </span>
  );
}

/**
 * A cloud computer in the switcher, drawn like This Mac's laptop: a cloud, a team's in its colour (`teamTint`, kept
 * subtle: the icon alone), amber on hold or suspended.
 */
function CloudMark({ team, size, warn }: { team?: string; size: number; warn?: boolean }) {
  return (
    <span className={cn('flex shrink-0', warn ? 'text-warning' : !team && 'text-fg-2')} style={!warn && team ? { color: teamTint(team) } : undefined}>
      <Icon icon={Cloud} size={size} />
    </span>
  );
}

/**
 * The sidebar's computer picker (plan §4.3), the first of the round buttons at the right of its top strip, always
 * there: the icon alone of the computer on screen (this Mac's laptop, a cloud for the person's own cloud computer, a
 * team's in its colour; a spinner while switching), no name (the owner's call, 2026-11-17; the name is its label and in
 * the menu). Its menu: this Mac by its own name (`useMacName`; left out while "Only in the cloud" holds: chat-core
 * `listsThisComputer`), the person's own cloud computer (once they have a plan of their own; greyed while it's being
 * set up), each team's shared computer (§6.11, its cloud in the team's colour), else "Add a cloud computer" (no plan
 * of their own: Billing's plan cards, Personal), a check on the one on screen (no state beside it: only on hold or
 * suspended turns its cloud amber). No "Settings…" (the owner's call, 2026-11-24).
 */
export function ComputerMenu({ inSettings = false }: {
  /**
   * Settings' own switcher (the head of its per-computer half): a full-width row with the whole name, the same
   * computers to pick from. Nothing where there is only this computer.
   */
  inSettings?: boolean;
} = {}) {
  const view = useCloud((s) => s.view);
  const supported = useCloud((s) => s.supported);
  const computer = useCloudLink((s) => s.computer);
  const team = useCloudLink((s) => s.team);
  const switching = useCloudLink((s) => s.switching);
  const onCloud = computer === 'cloud';
  const targets = supported ? cloudTargets(view) : [];
  const own = targets.find((t) => !t.team);
  const teams = targets.filter((t) => !!t.team);
  // a plan of their own whose computer isn't ready yet (being set up): listed, greyed
  const ownPending = !own && supported !== false && hasPersonalPlan(view) && cloudPhase(view) === 'provisioning';
  const addOwn = supported !== false && !own && !ownPending && !hasPersonalPlan(view);
  // a spinner only while switching (pairing); waking or connecting says nothing (lib/connectionQuiet.ts)
  const busy = switching;
  const macName = useMacName();
  const label = onCloud ? targetName(view, team) : macName;
  const shown = targets.find((t) => onCloud && t.team === team);
  // "Only in the cloud" (Settings › Account): this computer leaves the list, unless the cloud computer on screen has
  // been out of reach for a while (or refuses this one), so it is never a dead end
  const cloudOnly = useCloudOnly();
  const conn = useCloudLink((s) => s.conn);
  const late = useHeldFor(onCloud && conn !== 'connected') || (onCloud && (conn === 'unauthorized' || conn === 'incompatible'));
  const listsMac = listsThisComputer({ inEffect: cloudOnly.inEffect, onThis: !onCloud, late });

  const check = (on: boolean) => <Icon icon={Check} size={14} className={cn('shrink-0 text-fg', on ? '' : 'invisible')} />;
  const row = (t: CloudTarget): MenuItem => {
    const on = onCloud && t.team === team;
    return {
      label: t.name,
      leading: switching && on ? <Spinner size={14} className="shrink-0 text-muted" /> : <CloudMark team={t.team ? (t.teamName ?? t.name) : undefined} size={16} warn={t.warn} />,
      current: on,
      onSelect: () => void switchComputer('cloud', t.team),
      hint: check(on),
    };
  };
  const addComputer = () => {
    paywallStart.kind = 'personal';
    ui.openSettings('billing', settingAnchorId(BILLING_PLANS_TITLE));
  };
  const items: (MenuItem | 'separator')[] = [
    ...(listsMac ? [{ label: macName, icon: Laptop, current: !onCloud, onSelect: () => void switchComputer('local'), hint: check(!onCloud) }] : []),
    ...(own ? [row(own)] : []),
    ...(ownPending ? [{ label: ownComputerName(view), leading: <Spinner size={14} className="shrink-0 text-muted" />, disabled: true, onSelect: () => {} }] : []),
    ...teams.map(row),
    ...(addOwn ? [{ label: ADD_COMPUTER_LABEL, leading: <AddComputerIcon />, onSelect: addComputer }] : []),
  ];
  const mark = busy ? <Spinner size={inSettings ? 15 : 13} className="shrink-0 text-muted" />
    : onCloud ? <CloudMark team={team ? (shown?.teamName ?? label) : undefined} size={16} warn={shown?.warn} />
      : <Icon icon={Laptop} size={16} className="shrink-0 text-fg-2" />;

  if (inSettings) {
    // this computer alone, and no cloud computer to add (or, only in the cloud, one cloud computer): nothing to switch between
    if (items.length < 2) return null;
    return (
      <Menu
        align="start"
        className="min-w-[252px] whitespace-nowrap"
        anchorClassName="flex w-full min-w-0"
        items={items}
        trigger={(p) => (
          <button
            {...p}
            type="button"
            aria-label={`Settings for: ${label}`}
            className={cn(
              // Settings' nav row (SettingsView), with a hairline round it: it picks whose settings these are
              'no-drag flex h-8 w-full min-w-0 items-center gap-2 rounded-[10px] pr-2 pl-[9px] text-left outline-none shadow-[inset_0_0_0_1px_var(--st-field-edge)]',
              'hover:bg-[var(--st-hover)] focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]', p['aria-expanded'] && 'bg-[var(--st-selected)] hover:bg-[var(--st-selected)]',
            )}
          >
            {mark}
            <span className="min-w-0 flex-1 truncate text-[15px] text-fg">{label}</span>
            <Icon icon={ChevronsUpDown} size={14} className="shrink-0 text-muted" />
          </button>
        )}
      />
    );
  }

  // the sidebar's: the computer's icon alone in a round button, like search and + beside it (its name is in the menu)
  return (
    <Menu
      align="end"
      className="min-w-[248px] whitespace-nowrap"
      anchorClassName="flex shrink-0"
      items={items}
      trigger={(p) => (
        <button
          {...p}
          type="button"
          aria-label={`Computer: ${label}`}
          title={label}
          className={cn(
            'ab-press ab-pill squircle no-drag grid size-9 shrink-0 place-items-center rounded-control bg-surface-2 outline-none',
            'hover:bg-surface-3 focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]', p['aria-expanded'] && 'bg-surface-3',
          )}
        >
          {mark}
        </button>
      )}
    />
  );
}
