/**
 * "Remove a device to connect": a cloud computer keeps a few paired devices only (`PAIRED_DEVICES_MAX`), and when it
 * refuses this computer as one too many, the only other place to remove one is its own Settings › Devices, which this
 * computer can't reach. So the account lists them (the backend asks the computer, which wakes) and removes the one
 * picked here; then this computer pairs and the cloud computer opens. Opened by `pairCloud` on `device_limit`.
 */
import { useEffect, useRef, useState } from 'react';
import type { CloudPairedDevices } from '@appubot/protocol';
import { Button, Dialog, Icon, Spinner, cn } from '../../components/ui';
import { SettingsCard, SETTINGS_ROW } from '../../components/ui/SettingsCard';
import { Laptop, Smartphone } from '../../components/ui/icons';
import { errorMessage } from '../../lib/gateway';
import { THIS_MACHINE } from '../../lib/platform';
import { pushToast, ui, type Modal } from '../../lib/store';
import { cloudCall } from './cloudAccount';
import { switchComputer } from './cloudClient';
import { deviceRows, devicesFullLine } from './devicesFull';
import { YOUR_COMPUTER_CAP, teamComputerLong } from './names';

type DevicesModal = Extract<Modal, { kind: 'cloud-devices' }>;

export function CloudDevicesDialog({ modal }: { modal: DevicesModal | null }) {
  // keeps its content while it animates out
  const last = useRef(modal);
  if (modal) last.current = modal;
  const m = last.current;
  const team = m?.team;
  const [list, setList] = useState<CloudPairedDevices | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!modal) return;
    let gone = false;
    setList(null);
    setFailed(null);
    setRemoving(null);
    cloudCall('cloudAccount.devices', team ? { team } : {}, { timeoutMs: 250_000 })
      .then((r) => { if (!gone) setList(r); })
      .catch((e) => { if (!gone) setFailed(errorMessage(e)); });
    return () => { gone = true; };
  }, [modal, team, round]);

  const remove = async (id: string): Promise<void> => {
    setRemoving(id);
    try {
      await cloudCall('cloudAccount.removeDevice', { id, ...(team ? { team } : {}) }, { timeoutMs: 250_000 });
    } catch (e) {
      setRemoving(null);
      pushToast({ title: 'Couldn’t remove it', body: errorMessage(e), level: 'error' });
      return;
    }
    ui.closeModal();
    // there is room now: this computer pairs and the cloud computer comes on screen
    void switchComputer('cloud', team);
  };

  const computer = team ? teamComputerLong(m?.teamName) : YOUR_COMPUTER_CAP;
  const rows = list ? deviceRows(list.devices, Date.now()) : [];
  return (
    <Dialog
      open={!!modal}
      onClose={ui.closeModal}
      size="md"
      title={`Remove a device to connect ${THIS_MACHINE}`}
      description={list ? devicesFullLine(list.devices.length, list.max, computer, THIS_MACHINE) : undefined}
      footer={<Button variant="ghost" onClick={ui.closeModal}>Not now</Button>}
    >
      {failed ? (
        <div className="space-y-3">
          <p className="text-copy leading-relaxed text-fg-2">{m?.message}</p>
          <p className="text-ui leading-relaxed text-muted">Its devices couldn’t be read from here: {failed}</p>
          <Button variant="secondary" size="sm" onClick={() => setRound((n) => n + 1)}>Try again</Button>
        </div>
      ) : !list ? (
        <div className="flex items-center gap-2.5 py-6 text-copy text-muted"><Spinner size={14} /> Reading its devices…</div>
      ) : rows.length === 0 ? (
        <div className="space-y-3">
          <p className="text-copy leading-relaxed text-fg-2">Nothing is paired with it any more.</p>
          <Button variant="primary" size="sm" onClick={() => { ui.closeModal(); void switchComputer('cloud', team); }}>Connect {THIS_MACHINE}</Button>
        </div>
      ) : (
        <SettingsCard>
          {rows.map((d) => (
            <div key={d.id} className={cn(SETTINGS_ROW, 'flex items-center gap-3')}>
              <div className="squircle flex size-9 shrink-0 items-center justify-center rounded-control bg-surface-2 text-fg-2">
                <Icon icon={d.kind === 'phone' ? Smartphone : Laptop} size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-copy font-semibold tracking-ui text-fg">{d.name}</div>
                <div className={cn('text-ui', d.stale ? 'text-warning' : 'text-muted')}>{d.seen}</div>
              </div>
              <Button variant="secondary" size="sm" loading={removing === d.id} disabled={!!removing && removing !== d.id} onClick={() => void remove(d.id)}>Remove</Button>
            </div>
          ))}
        </SettingsCard>
      )}
    </Dialog>
  );
}
