import { AnimatePresence, motion } from 'motion/react';
import { RotateCw, WifiOff } from '../ui/icons';
import { Button, Icon, Logo, Spinner } from '../ui';
import { native } from '../../lib/native';
import { useStore } from '../../lib/store';
import { useCloudLink } from '../../features/cloud/cloudClient';
import { useHeldFor } from '../../lib/connectionQuiet';

/**
 * Slim strip at the top of the chat card once the socket has been reconnecting for 30 s (lib/connectionQuiet.ts): a
 * drop, the Mac waking or a cloud computer waking reconnect by themselves, and the chat stays usable meanwhile.
 */
export function ReconnectBanner() {
  const conn = useStore((s) => s.conn);
  const onCloud = useCloudLink((s) => s.computer === 'cloud');
  // a cloud computer's saved copy waiting on its first word: its own strip says so (CloudSyncStrip)
  const copyWaiting = useCloudLink((s) => s.computer === 'cloud' && s.cached && !s.ready);
  const late = useHeldFor(conn === 'reconnecting');
  const show = late && !copyWaiting;
  return (
    <AnimatePresence initial={false}>
      {show ? (
        <motion.div
          initial={{ height: 0, opacity: 0 }} animate={{ height: 32, opacity: 1 }} exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.25, ease: [0.25, 1, 0.5, 1] }}
          role="status"
          className="hairline-b flex shrink-0 items-center justify-center gap-2 overflow-hidden bg-[color-mix(in_srgb,var(--ab-warning)_9%,transparent)] text-note text-fg-2"
        >
          <Spinner size={12} className="text-warning" /> {onCloud ? 'Can’t reach your AppuBot computer yet. Still trying…' : 'Can’t reach AppuBot yet. Still trying…'}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** Blocking screen when the gateway rejected us or the connection was closed. */
export function ConnectionOverlay() {
  const conn = useStore((s) => s.conn);
  const err = useStore((s) => s.connError);
  // the cloud computer's own failures show in its pane (features/cloud/CloudPane), never as this Mac's
  const onCloud = useCloudLink((s) => s.computer === 'cloud');
  if (onCloud || (conn !== 'unauthorized' && conn !== 'closed')) return null;
  return (
    <div className="drag fixed inset-0 z-[80] flex items-center justify-center overflow-hidden bg-[var(--ab-coat)] backdrop-blur-2xl">
      <div className="no-drag relative flex max-w-[400px] flex-col items-center text-center">
        <div className="mb-5 flex size-12 items-center justify-center rounded-full bg-surface-2 text-fg-2"><Icon icon={WifiOff} size={22} /></div>
        <h1 className="font-display text-[24px] font-medium tracking-display text-fg">
          {conn === 'unauthorized' ? 'AppuBot couldn’t sign in' : 'Disconnected from AppuBot'}
        </h1>
        <p className="mt-2 text-copy leading-relaxed text-muted">
          {conn === 'unauthorized'
            ? 'This window couldn’t sign in to AppuBot. Relaunching usually fixes it.'
            : 'AppuBot stopped responding. Relaunch it to start it again.'}
        </p>
        {err ? <p className="mt-2 font-mono text-note text-muted">{err}</p> : null}
        <Button className="mt-6" variant="primary" icon={RotateCw} onClick={() => native().relaunch()}>Relaunch</Button>
      </div>
    </div>
  );
}

export function Splash({ error }: { error?: string }) {
  return (
    <div className="drag relative flex h-full items-center justify-center overflow-hidden">
      <div className="no-drag relative flex flex-col items-center gap-4 text-center">
        <Logo size={48} />
        {error ? (
          <>
            <p className="max-w-[360px] text-copy text-muted">Couldn’t reach the AppuBot gateway: {error}</p>
            <Button variant="primary" icon={RotateCw} onClick={() => native().relaunch()}>Relaunch</Button>
          </>
        ) : (
          <Spinner size={18} className="text-muted" />
        )}
      </div>
    </div>
  );
}
