import { CreditCard } from '../../components/ui/icons';
import { Button } from '../../components/ui';
import { NoticeCard } from '../chat/NoticeCard';
import { ui, useStore } from '../../lib/store';
import { openBilling, useCloud } from './cloudAccount';
import { useCloudLink } from './cloudClient';
import { cloudPhase } from './cloudView';
import { YOUR_COMPUTER_CAP, exportOnlyText, onHoldText } from './names';

/**
 * Which notice the cloud's chat shows now (null: none), so ThreadView can slot it with the others. Waking or
 * connecting is never one: the chat shows what it has and messages queue (lib/connectionQuiet.ts); a computer that
 * hasn't answered in 30 s gets the strip at the top (CloudSyncStrip, ReconnectBanner).
 */
export function useCloudNoticeKind(): 'on-hold' | 'past-due' | 'export-only' | null {
  const onCloud = useCloudLink((s) => s.computer === 'cloud');
  const view = useCloud((s) => s.view);
  // what the computer itself says (SystemInfo.cloud) wins over the backend's last read
  const state = useStore((s) => s.system?.cloud?.state);
  if (!onCloud) return null;
  if (state && state !== 'ok') return state;
  const p = cloudPhase(view);
  if (p === 'on-hold' || p === 'past-due' || p === 'export-only') return p;
  return null;
}

/** Above the cloud's composer (plan §4.4): payment on hold, the plan ended; each with the one thing that helps. */
export function CloudStateNotice() {
  const kind = useCloudNoticeKind();
  const busy = useCloud((s) => s.busy);
  const keptUntil = useCloud((s) => s.view?.computer?.exportUntil ?? s.view?.account?.exportUntil);
  switch (kind) {
    case null: return null;
    case 'on-hold':
      return (
        <NoticeCard tone="danger" icon={CreditCard} title="Payment on hold" detail={onHoldText(keptUntil)}>
          <Button size="sm" variant="primary" loading={!!busy.portal} onClick={() => void openBilling()}>Manage billing</Button>
        </NoticeCard>
      );
    case 'past-due':
      return (
        <NoticeCard tone="attention" icon={CreditCard} title="The last payment didn’t go through" detail={`${YOUR_COMPUTER_CAP} keeps working for now. Update your card to keep it that way.`}>
          <Button size="sm" variant="primary" loading={!!busy.portal} onClick={() => void openBilling()}>Manage billing</Button>
        </NoticeCard>
      );
    case 'export-only':
      return (
        <NoticeCard tone="attention" icon={CreditCard} title="Your plan has ended" detail={exportOnlyText()}>
          <Button size="sm" variant="primary" onClick={() => ui.openSettings('billing')}>See plans</Button>
        </NoticeCard>
      );
  }
}
