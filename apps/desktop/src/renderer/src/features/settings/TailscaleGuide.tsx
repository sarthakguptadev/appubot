import { useState, type ReactNode } from 'react';
import { Check, ChevronDown, ExternalLink, Wifi } from '../../components/ui/icons';
import { Badge, Button, Icon, cn } from '../../components/ui';
import { native } from '../../lib/native';
import { IS_MAC, MACHINE, PLATFORM, THIS_MACHINE } from '../../lib/platform';
import { useStore } from '../../lib/store';
import { TailscaleMark } from './brandLogos';
import { keepAwakeTitle, settingAnchorId } from './nav';

const THIS_MACHINE_CAP = `This ${MACHINE}`;

const DOWNLOAD = 'https://tailscale.com/download';

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          'mt-px flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium tabular-nums',
          done ? 'bg-success-soft text-success' : 'bg-surface-2 text-fg-2 shadow-[inset_0_0_0_.5px_var(--ab-hairline)]',
        )}
        aria-hidden
      >
        {done ? <Icon icon={Check} size={12} /> : n}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2 text-copy font-medium text-fg">
          {title}
          {done ? <Badge tone="success">Done</Badge> : null}
        </div>
        <div className="text-ui leading-relaxed text-muted">{children}</div>
      </div>
    </li>
  );
}

/** The steps themselves: this computer's own Tailscale status ticks off what's already done. */
export function TailscaleGuideSteps({ onPair }: { onPair?: () => void }) {
  const ts = useStore((s) => s.system?.tailscale);
  const signedIn = !!ts?.loginName || !!ts?.running;
  return (
    <div className="space-y-4">
      <ol className="space-y-3.5">
        <Step n={1} title={`Install Tailscale on ${THIS_MACHINE}`} done={ts?.installed}>
          Free for personal use. Get it from tailscale.com{IS_MAC ? ' or the Mac App Store' : ''}.
          {!ts?.installed ? (
            <div className="mt-1.5">
              <Button size="xs" variant="secondary" icon={ExternalLink} onClick={() => void native().openExternal(DOWNLOAD)}>Get Tailscale</Button>
            </div>
          ) : null}
        </Step>
        <Step n={2} title={`Sign in on the ${MACHINE}`} done={signedIn}>
          Click Tailscale in the {IS_MAC ? 'menu bar' : PLATFORM === 'win32' ? 'system tray' : 'system tray (or run tailscale up)'} and log in (Google, Microsoft, GitHub, Apple or email).
          {ts?.loginName ? <> Signed in as <span className="selectable font-mono text-fg-2">{ts.loginName}</span>.</> : null}
        </Step>
        <Step n={3} title="Install Tailscale on your phone">
          From the App Store or Google Play. Sign in with the <span className="text-fg-2">same account</span> as on the {MACHINE}, so both join one private network.
        </Step>
        <Step n={4} title="Turn it on, on both" done={ts?.running}>
          The phone asks once to add a VPN configuration: allow it. Both should say Connected.
          {ts?.running && ts.dnsName ? <> {THIS_MACHINE_CAP} is <span className="selectable font-mono text-fg-2">{ts.dnsName}</span>.</> : null}
        </Step>
        <Step n={5} title="Pair your phone">
          {onPair ? (
            <>
              <button type="button" className="text-fg-2 underline decoration-[var(--ab-hairline)] underline-offset-2 hover:text-fg" onClick={onPair}>Pair a phone</button>
              {' '}and scan the code with the AppuBot app.
            </>
          ) : 'Scan the code with the AppuBot app.'}{' '}
          It carries both the Tailscale and the Wi-Fi addresses, so the phone uses whichever works.
        </Step>
      </ol>

      <div className="flex items-start gap-2.5 rounded-card bg-surface-2 px-3.5 py-2.5 text-ui leading-snug text-fg-2 shadow-[inset_0_0_0_.5px_var(--ab-hairline)]">
        <Icon icon={Wifi} size={15} className="mt-px shrink-0 text-muted" />
        <span>
          On the same Wi-Fi as {THIS_MACHINE}, the phone connects directly. From anywhere else it comes in through AppuBot
          Connect (above), or over Tailscale if you prefer your own private network: set up below.
        </span>
      </div>

      <div className="space-y-1.5">
        <div className="text-note font-medium text-muted">If it doesn’t connect</div>
        <ul className="list-disc space-y-1 pl-4 text-ui leading-relaxed text-muted marker:text-muted/60">
          <li>Both devices show Connected in Tailscale, signed in to the same account.</li>
          <li>{THIS_MACHINE_CAP} is awake and AppuBot is open (Settings › General › {keepAwakeTitle()}).</li>
          <li>Works at home but not away: Tailscale is off on the phone or on {THIS_MACHINE}.</li>
          <li>Same Wi-Fi but no connection: guest and office networks often keep devices apart; use Tailscale. On an iPhone, allow Local Network for AppuBot in Settings › Privacy &amp; Security.</li>
          <li>Still stuck: pair again. The new code carries {THIS_MACHINE}’s current addresses.</li>
        </ul>
      </div>
    </div>
  );
}

/** "How to set up Tailscale": a disclosure that opens the step-by-step guide in place. */
export function TailscaleGuide({ className, defaultOpen = false, onPair, compact }: {
  className?: string; defaultOpen?: boolean; onPair?: () => void;
  /** a quiet link-style toggle (inside the pairing view) instead of a settings row */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (compact) {
    return (
      <div className={cn('w-full', className)}>
        <button
          type="button"
          aria-expanded={open}
          className="mx-auto flex items-center gap-1 text-ui text-fg-2 underline decoration-[var(--ab-hairline)] underline-offset-2 hover:text-fg"
          onClick={() => setOpen((v) => !v)}
        >
          How to set up Tailscale
          <Icon icon={ChevronDown} size={13} className={cn('transition-transform duration-200', open && 'rotate-180')} />
        </button>
        {open ? <div className="mt-3 squircle rounded-[14px] bg-surface-2 p-3.5 text-left"><TailscaleGuideSteps onPair={onPair} /></div> : null}
      </div>
    );
  }
  return (
    <div id={settingAnchorId('How to set up Tailscale')} className={cn('scroll-mt-24', className)}>
      <button type="button" aria-expanded={open} className="flex w-full items-center gap-3 px-3 py-2.5 text-left" onClick={() => setOpen((v) => !v)}>
        <TailscaleMark />
        <div className="min-w-0 flex-1">
          <div className="text-copy font-medium text-fg">How to set up Tailscale</div>
          <div className="text-copy text-muted">Reach {THIS_MACHINE} from your phone anywhere, privately. About five minutes.</div>
        </div>
        <Icon icon={ChevronDown} size={16} className={cn('shrink-0 text-muted transition-transform duration-200', open && 'rotate-180')} />
      </button>
      {open ? <div className="px-3 pt-1 pb-4 pl-[60px]"><TailscaleGuideSteps onPair={onPair} /></div> : null}
    </div>
  );
}
