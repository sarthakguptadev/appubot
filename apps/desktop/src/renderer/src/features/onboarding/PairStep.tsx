import { useEffect, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { ArrowRight, Check, RefreshCw, ShieldCheck, Smartphone } from '../../components/ui/icons';
import { Button, Card, Icon, Spinner, cn } from '../../components/ui';
import { PhoneAppCodes } from '../settings/PhoneApps';
import { MACHINE } from '../../lib/platform';
import { useStore } from '../../lib/store';
import { countdown, usePairingSession } from '../settings/PairingView';
import { PairSignIn } from '../settings/PairSignIn';
import { loadSystemInfo } from '../settings/TailscaleSettingRow';
import { StepShell } from './StepShell';

/**
 * Pair a phone: the pairing QR big, the code under it, and three plain steps (get the app, tap Pair, scan). Later
 * goes on without; Settings › Devices pairs any time. Once a phone pairs, the code turns into a check.
 */
export function PairStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const { pairing, qr, loading, regenerate, remaining, expired, connected, needsSignIn } = usePairingSession();
  const tailscale = useStore((s) => s.system?.tailscale);
  const systemLoaded = useStore((s) => !!s.system);
  useEffect(() => { if (!systemLoaded) void loadSystemInfo(); }, [systemLoaded]);
  const code = pairing?.code ?? '';

  const reach = pairing?.connectId ? 'Encrypted end to end. Works at home and away.'
    : tailscale?.running ? 'Works on the same Wi-Fi, and away through Tailscale.'
      : `Works while your phone is on the same Wi-Fi as this ${MACHINE}.`;

  return (
    <StepShell
      title="Take your bots with you"
      body="Chat, approve and watch them work from your phone."
      onBack={onBack}
      note={connected ? undefined : 'Pair any time in Settings › Devices'}
      actions={connected
        ? <Button size="lg" variant="primary" iconRight={ArrowRight} onClick={onNext} autoFocus>Continue</Button>
        : <Button size="lg" variant="secondary" onClick={onNext}>Later</Button>}
    >
      {needsSignIn ? <PairSignIn className="mx-auto max-w-[560px] text-left" /> : (
      <div className="mx-auto grid max-w-[680px] grid-cols-1 items-center gap-10 min-[760px]:grid-cols-[272px_minmax(0,1fr)]">
        {/* the code */}
        <Card className="!rounded-[22px] mx-auto flex w-[272px] flex-col items-center px-5 pt-5 pb-4">
          {connected ? (
            <motion.div
              className="flex h-[232px] w-[232px] flex-col items-center justify-center gap-3 text-center"
              initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4, ease: [0.25, 1, 0.5, 1] }}
            >
              <span className="flex size-16 items-center justify-center rounded-full bg-success text-white"><Icon icon={Check} size={30} strokeWidth={2.4} /></span>
              <div>
                <div className="text-lead font-medium text-fg">Paired</div>
                <div className="mt-0.5 flex items-center justify-center gap-1.5 text-ui text-muted"><Icon icon={Smartphone} size={14} />{connected.name}</div>
              </div>
            </motion.div>
          ) : (
            <div className="relative flex size-[232px] items-center justify-center rounded-[14px] bg-white p-2 shadow-[0_0_0_.5px_rgba(0,0,0,.12)]">
              {qr && pairing ? (
                <img src={qr} alt="Pairing QR code" width={216} height={216} draggable={false} className={cn('size-[216px] transition-[filter,opacity] duration-200', expired && 'opacity-20 blur-[3px]')} />
              ) : (
                <Spinner size={20} className="text-[#999]" />
              )}
              {expired ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                  <span className="text-ui font-medium text-[#3d3d3d]">Code expired</span>
                  <Button size="sm" variant="primary" icon={RefreshCw} loading={loading} onClick={() => void regenerate()} className="!bg-[#0d0d0d] !text-white">New code</Button>
                </div>
              ) : null}
            </div>
          )}
          <div className="mt-3.5 flex h-5 items-center gap-1.5 text-note text-muted">
            {connected ? <span>Your phone can reach your bots now.</span>
              : pairing && !expired ? (
                <>
                  <span className="selectable font-mono text-copy font-medium tracking-[.12em] text-fg" aria-label={`Pairing code ${code}`}>{code.slice(0, 3)} {code.slice(3)}</span>
                  <span aria-hidden>·</span>
                  <span className="tabular-nums">{countdown(remaining)}</span>
                </>
              ) : !pairing && !loading ? (
                <button type="button" onClick={() => void regenerate()} className="underline underline-offset-2 hover:text-fg">Make a code</button>
              ) : expired ? <span>This code can’t be used anymore.</span> : <span>Making a code…</span>}
          </div>
        </Card>

        {/* how */}
        <div className="flex flex-col">
          <ol className="flex flex-col gap-5">
            <Step n={1} done={!!connected} title="Get AppuBot on your phone">
              <div className="mt-0.5 text-ui text-muted">Point your phone’s camera at one of these</div>
              <PhoneAppCodes size={72} className="mt-2 justify-start" />
            </Step>
            <Step n={2} done={!!connected} title={<>Open it and tap <b className="font-semibold">Pair</b></>} />
            <Step n={3} done={!!connected} title="Scan this code">
              <div className="mt-0.5 text-ui text-muted">or type the six digits under it</div>
            </Step>
          </ol>
          <div className="mt-7 flex items-start gap-2 text-note leading-snug text-muted">
            <Icon icon={ShieldCheck} size={15} className="mt-px shrink-0 text-success" />
            <span>{reach}</span>
          </div>
        </div>
      </div>
      )}
    </StepShell>
  );
}

function Step({ n, title, done, children }: { n: number; title: ReactNode; done: boolean; children?: ReactNode }) {
  return (
    <li className="flex items-start gap-3.5">
      <span className={cn('flex size-[26px] shrink-0 items-center justify-center rounded-full text-ui font-semibold tabular-nums transition-colors', done ? 'bg-success text-white' : 'bg-surface-2 text-fg')}>
        {done ? <Icon icon={Check} size={13} strokeWidth={2.6} /> : n}
      </span>
      <div className="min-w-0 pt-[3px]">
        <div className="text-lead leading-snug text-fg">{title}</div>
        {children}
      </div>
    </li>
  );
}
