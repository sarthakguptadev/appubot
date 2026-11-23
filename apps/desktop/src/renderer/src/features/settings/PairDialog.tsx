import { Button, Dialog } from '../../components/ui';
import { useThisComputer } from '../cloud/thisComputer';
import { PairingView } from './PairingView';

/**
 * Pairing a phone with this Mac: the QR and code (PairingView). A remote computer (your AppuBot computer, a team's)
 * is paired from the phone itself, through the account it signs in to: a code from this window would carry that
 * computer's own addresses, which no phone can reach.
 */
export function PairDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const computer = useThisComputer();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="Pair a phone"
      description={computer.remote ? `Your phone reaches ${computer.name} through your account.` : 'Chat with your bots and approve actions from anywhere.'}
      footer={<Button variant="primary" data-autofocus onClick={onClose}>Done</Button>}
    >
      {computer.remote ? (
        <p className="pt-2 pb-1 text-copy leading-relaxed text-fg-2">
          Install AppuBot on your phone and sign in with the same account in its Settings › Account: {computer.name} shows up there, no code needed. Pairing here is for this Mac.
        </p>
      ) : <PairingView className="pt-2 pb-1" />}
    </Dialog>
  );
}
