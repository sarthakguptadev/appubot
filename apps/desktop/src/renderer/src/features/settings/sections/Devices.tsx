import { useEffect, useState } from 'react';
import { PhoneAppCodes } from '../PhoneApps';
import { Check, Globe, Laptop, MonitorSmartphone, Pencil, QrCode, Smartphone, Terminal, X, type LucideIcon } from '../../../components/ui/icons';
import type { ConnectStatus, Device, NetRoute } from '@appubot/protocol';
import { Badge, Button, EmptyState, Icon, Input, StatusDot, Switch, cn, type BadgeTone } from '../../../components/ui';
import { call, confirm } from '../../../lib/actions';
import { optimisticCall } from '../../../lib/optimistic';
import { timeAgo } from '@appubot/chat-core';
import { useNow } from '../../../lib/hooks';
import { native } from '../../../lib/native';
import { MACHINE, THIS_MACHINE } from '../../../lib/platform';
import { setState, ui, useStore } from '../../../lib/store';
import { SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE, SettingRow, SettingsGroup, updateSettings } from './shared';
import { TailscaleGuide } from '../TailscaleGuide';
import { useThisComputer } from '../../cloud/thisComputer';
import { settingAnchorId } from '../nav';

const PLATFORM_ICON: Partial<Record<Device['platform'], LucideIcon>> = {
  ios: Smartphone, android: Smartphone, desktop: Laptop, web: Globe, cli: Terminal,
};
/** How a device reaches this Mac (its latest connection). */
const ROUTE_LABEL: Record<NetRoute, string> = { tailscale: 'Tailscale', lan: 'local network', local: THIS_MACHINE, connect: 'AppuBot Connect', cloud: 'the internet' };

const ROLE: Record<Device['role'], { label: string; tone: BadgeTone }> = {
  owner: { label: 'Owner', tone: 'accent' },
  full: { label: 'Full access', tone: 'indigo' },
  limited: { label: 'Limited', tone: 'neutral' },
};

function DeviceRow({ device: d, self, now }: { device: Device; self: boolean; now: number }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(d.name);

  const save = async () => {
    const next = name.trim();
    if (!next || next === d.name) { setEditing(false); setName(d.name); return; }
    // the new name shows at once; a refusal puts the old one back
    setEditing(false);
    const res = await optimisticCall('devices.rename', { id: d.id, name: next }, [{ kind: 'patch', coll: 'devices', id: d.id, fields: { name: next } }], {
      errorTitle: 'Could not rename device', answered: (x) => ({ coll: 'devices', entity: x }),
    });
    if (!res) setName(d.name);
  };

  const revoke = () =>
    confirm({
      title: `Revoke ${d.name}?`,
      body: 'This device will be disconnected immediately and will need to pair again to reach your bots.',
      confirmLabel: 'Revoke',
      danger: true,
      onConfirm: () => {
        void optimisticCall('devices.revoke', { id: d.id }, [{ kind: 'remove', coll: 'devices', id: d.id }], { errorTitle: 'Could not revoke device' });
      },
    });

  // a phone's notifications from here: it registers for them itself (AppuBot on the phone › Settings › Notifications);
  // this switch only stops or allows them, and the computer-wide one in General stops every phone's
  const phone = d.platform === 'ios' || d.platform === 'android';
  const pushSetUp = d.pushOn !== undefined || !!d.pushOff;
  const mobileOn = useStore((s) => s.settings?.notifications.mobile ?? true);
  const setNotifications = (on: boolean) => {
    void optimisticCall('devices.setNotifications', { id: d.id, on }, [{ kind: 'patch', coll: 'devices', id: d.id, fields: { pushOn: on, pushOff: on ? undefined : true } }], {
      errorTitle: 'Could not change notifications', answered: (x) => ({ coll: 'devices', entity: x }),
    });
  };

  const seen = d.online ? 'Online now' : d.lastSeenAt ? (timeAgo(d.lastSeenAt, now) === 'now' ? 'Seen just now' : `Seen ${timeAgo(d.lastSeenAt, now)} ago`) : 'Never connected';
  const meta = [d.tailscaleUser, d.lastIp].filter(Boolean).join(' · ');
  const via = d.route && d.route !== 'local' ? `${d.online ? 'via' : 'last via'} ${ROUTE_LABEL[d.route]}` : null;

  return (
    <div className={cn(SETTINGS_ROW, 'flex items-center gap-3')}>
      <div className="relative ab-pill squircle flex size-9 shrink-0 items-center justify-center rounded-control bg-surface-2 text-fg-2">
        <Icon icon={PLATFORM_ICON[d.platform] ?? MonitorSmartphone} size={18} />
        <StatusDot tone={d.online ? 'online' : 'idle'} className="absolute -right-0.5 -bottom-0.5 size-2.5 ring-2 ring-[var(--ab-bg)]" title={d.online ? 'Online' : 'Offline'} />
      </div>
      <div className="min-w-0 flex-1">
        {editing ? (
          <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="h-8 max-w-64 text-copy" aria-label="Device name" />
            <Button type="submit" size="icon-sm" variant="ghost" icon={Check} aria-label="Save name" />
            <Button size="icon-sm" variant="ghost" icon={X} aria-label="Cancel" onClick={() => { setEditing(false); setName(d.name); }} />
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn(SETTINGS_ROW_TITLE, 'truncate')}>{d.name}</span>
            <Badge tone={ROLE[d.role].tone}>{ROLE[d.role].label}</Badge>
            {self ? <Badge tone="neutral">This {MACHINE}</Badge> : null}
          </div>
        )}
        <div className={cn('mt-0.5 flex flex-wrap items-center gap-x-2', SETTINGS_ROW_DESCRIPTION)}>
          <span>{seen}</span>
          {via ? <span title={d.route === 'lan' ? `Same Wi-Fi as ${THIS_MACHINE}, without Tailscale` : 'Over your private Tailscale network'}>{via}</span> : null}
          {d.appVersion && !self ? <span title="The AppuBot version it ran when it last connected">AppuBot {d.appVersion}</span> : null}
          {meta ? <span className="selectable font-mono text-note">{meta}</span> : null}
          {phone && !self && !pushSetUp ? <span title="Turn them on in AppuBot on the phone: Settings › Notifications">Notifications not set up</span> : null}
        </div>
      </div>
      {!editing ? (
        <div className="flex shrink-0 items-center gap-1">
          {phone && !self && pushSetUp ? (
            <label className="mr-2 flex items-center gap-2 text-ui text-fg-2" title={mobileOn ? 'Notifications on this phone when a bot finishes, needs you or fails, also with AppuBot closed there' : 'Phone notifications are off in Settings › General'}>
              Notifications
              <Switch label={`Notifications on ${d.name}`} checked={!d.pushOff && mobileOn} disabled={!mobileOn} onChange={(on) => void setNotifications(on)} />
            </label>
          ) : null}
          <Button size="icon-sm" variant="ghost" icon={Pencil} aria-label={`Rename ${d.name}`} title="Rename" onClick={() => { setName(d.name); setEditing(true); }} />
          {!self ? <Button size="sm" variant="danger" onClick={revoke}>Revoke</Button> : null}
        </div>
      ) : null}
    </div>
  );
}

/** What AppuBot Connect's state means, in the row's words. */
function connectDescription(c: ConnectStatus | undefined, enabled: boolean, paired: boolean): string {
  if (!enabled) return `Off. Phones reach ${THIS_MACHINE} only over Tailscale or the same Wi-Fi.`;
  if (!paired) return 'Starts when you pair a phone: reach this computer from anywhere, no Tailscale needed, encrypted end to end.';
  switch (c?.state) {
    case 'up': return 'Phones reach this computer from anywhere. Everything is encrypted between your phone and this computer.';
    case 'starting': return 'Connecting…';
    case 'down': return 'Lost the connection to AppuBot Connect. Trying again by itself.';
    case 'error': return c.error ?? 'Something went wrong.';
    default: return 'Starting…';
  }
}

/** AppuBot Connect: its switch, state and key (settings.connect.enabled, SystemInfo.connect). */
function ConnectRow() {
  const enabled = useStore((s) => s.settings?.connect.enabled ?? true);
  const status = useStore((s) => s.system?.connect);
  const paired = useStore((s) => s.devices.length > 0);
  const [busy, setBusy] = useState(false);
  const setOn = async (on: boolean) => {
    setBusy(true);
    const res = await call('connect.set', { enabled: on }, { errorTitle: on ? 'Could not turn on AppuBot Connect' : 'Could not turn off AppuBot Connect' });
    setBusy(false);
    if (res) setState((s) => (s.system ? { system: { ...s.system, connect: res } } : {}));
  };
  const reset = () =>
    confirm({
      title: 'Get a new key?',
      body: `${THIS_MACHINE}’s current AppuBot Connect key stops working at once. Paired phones learn the new one when they next connect over Tailscale; otherwise pair them again.`,
      confirmLabel: 'New key',
      onConfirm: async () => {
        const res = await call('connect.reset', {}, { errorTitle: 'Could not reset AppuBot Connect' });
        if (res) setState((s) => (s.system ? { system: { ...s.system, connect: res } } : {}));
      },
    });
  const tone: BadgeTone = status?.state === 'up' ? 'success' : status?.state === 'error' ? 'danger' : status?.state === 'down' ? 'warning' : 'neutral';
  const label = !enabled ? null : status?.state === 'up' ? 'Connected' : status?.state === 'error' ? 'Problem' : status?.state === 'down' ? 'Reconnecting' : status?.state === 'off' ? (paired ? 'Starting' : null) : 'Connecting';
  return (
    <div id={settingAnchorId('AppuBot Connect')} className={cn(SETTINGS_ROW, 'flex scroll-mt-24 items-center gap-3')}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className={SETTINGS_ROW_TITLE}>AppuBot Connect</h3>
          {label ? <Badge tone={tone}>{label}</Badge> : null}
        </div>
        <p className={cn('mt-0.5', SETTINGS_ROW_DESCRIPTION)}>{connectDescription(status, enabled, paired)}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {enabled && status?.connectId && status.state !== 'off' ? <Button size="xs" variant="ghost" onClick={reset}>New key</Button> : null}
        <Switch label="AppuBot Connect" checked={enabled} disabled={busy} onChange={(on) => void setOn(on)} />
      </div>
    </div>
  );
}

/** AppuBot Connect, local-network access (settings.gateway.allowLan) and the Tailscale guide. */
function ConnectionGroup() {
  const gateway = useStore((s) => s.settings?.gateway);
  if (!gateway) return null;
  return (
    <SettingsGroup
      title="Connection"
      description={`Your phone tries every way to reach ${THIS_MACHINE} and uses whichever works: the Wi-Fi you share, Tailscale, or AppuBot Connect from anywhere.`}
    >
      <ConnectRow />
      <SettingRow
        title="Same Wi-Fi without Tailscale"
        description={`Paired phones on ${THIS_MACHINE}’s network connect directly, encrypted end to end, even with Tailscale off. They still need their pairing. Turn off to allow Tailscale only.`}
      >
        <Switch
          label="Same Wi-Fi without Tailscale"
          checked={gateway.allowLan}
          disabled={gateway.bind !== 'tailscale'}
          onChange={(allowLan) => void updateSettings({ gateway: { ...gateway, allowLan } })}
        />
      </SettingRow>
      <TailscaleGuide onPair={() => ui.openModal({ kind: 'pair' })} />
    </SettingsGroup>
  );
}

export function DevicesSection() {
  const devices = useStore((s) => s.devices);
  // a remote computer's devices are paired through the account; its Connect, Wi-Fi and Tailscale settings don't apply
  const computer = useThisComputer();
  const now = useNow(30_000);
  const [selfId, setSelfId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    native().getGateway().then((g) => { if (alive) setSelfId(g.deviceId); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const sorted = [...devices].sort(
    (a, b) => Number(b.id === selfId) - Number(a.id === selfId) || Number(b.online) - Number(a.online) || (b.lastSeenAt ?? b.pairedAt) - (a.lastSeenAt ?? a.pairedAt),
  );
  const others = sorted.filter((d) => d.id !== selfId);

  return (
    <div className="space-y-6">
      <SettingsGroup
        title="Paired devices"
        description={computer.remote ? `Phones and computers signed in to ${computer.name} through your account.` : 'Phones and computers that can talk to your bots over Tailscale or your local network.'}
        action={<Button size="xs" variant="outline" icon={QrCode} onClick={() => ui.openModal({ kind: 'pair' })}>Pair a phone</Button>}
      >
        {sorted.map((d) => <DeviceRow key={d.id} device={d} self={d.id === selfId} now={now} />)}
        {!others.length ? (
          <EmptyState
            icon={Smartphone}
            title="No phones paired yet"
            body={computer.remote ? `Sign in to the AppuBot app on your phone with the same account: ${computer.name} shows up there.` : 'Pair the AppuBot app on your phone to chat with your bots, approve actions and watch live from anywhere.'}
            action={computer.remote ? undefined : <Button size="sm" variant="secondary" icon={QrCode} onClick={() => ui.openModal({ kind: 'pair' })}>Pair a phone</Button>}
          />
        ) : null}
        {!others.length ? (
          <div className="flex flex-col items-center gap-1 px-4 pb-4">
            <div className="text-note text-muted">Get the app: point your phone’s camera at one of these</div>
            <PhoneAppCodes size={64} />
          </div>
        ) : null}
      </SettingsGroup>
      {computer.remote ? null : <ConnectionGroup />}
    </div>
  );
}
