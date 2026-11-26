import { Smartphone } from '../../components/ui/icons';
import { Icon, SettingsCard, cn } from '../../components/ui';
import { THIS_MACHINE } from '../../lib/platform';
import { CloudSignIn } from '../cloud/CloudSignIn';

/**
 * In place of the pairing code while this computer isn't signed in to AppuBot: pairing a phone (on the same Wi-Fi, over
 * Tailscale or through AppuBot Connect) needs both signed in. The code comes by itself once the browser comes back.
 */
export function PairSignIn({ className, card = true }: { className?: string; card?: boolean }) {
  const body = (
    <>
      <div className="flex items-start gap-3 px-4 pt-4 pb-1">
        <span className="ab-pill squircle flex size-9 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent"><Icon icon={Smartphone} size={18} /></span>
        <div className="min-w-0 space-y-1">
          <div className="text-copy font-medium text-fg">Sign in to pair a phone</div>
          <p className="max-w-xl text-note leading-normal text-muted">
            {`Phones connect to ${THIS_MACHINE} only when both are signed in to AppuBot, on the same Wi-Fi, over Tailscale or from anywhere. Your bots keep working on ${THIS_MACHINE} either way.`}
          </p>
        </div>
      </div>
      <CloudSignIn description="With Google, Apple or your email, in your browser. The pairing code shows up here once you’re back." />
    </>
  );
  return card ? <SettingsCard className={className}>{body}</SettingsCard> : <div className={cn(className)}>{body}</div>;
}
