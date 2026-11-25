import { AnimatePresence, motion } from 'motion/react';
import { Cloud, RotateCw } from '../../components/ui/icons';
import { Button, Icon } from '../../components/ui';
import { MACHINE } from '../../lib/platform';
import { switchComputer, useCloudLink } from './cloudClient';
import { syncStripView } from './cloudCacheData';
import { useHeldFor } from '../../lib/connectionQuiet';

/**
 * A slim line at the top of the chat card when a cloud computer's saved copy is on screen and the computer hasn't
 * answered in 30 s (cloudCacheData.ts `syncStripView`), with Try again. Everything under it stays usable: messages queue
 * (lib/outbox.ts) and say themselves when they can't go.
 */
export function CloudSyncStrip() {
  const link = useCloudLink();
  const late = useHeldFor(link.computer === 'cloud' && link.cached && !link.ready);
  const view = syncStripView({ ...link, late });
  return (
    <AnimatePresence initial={false}>
      {view ? (
        <motion.div
          initial={{ height: 0, opacity: 0 }} animate={{ height: 32, opacity: 1 }} exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.25, ease: [0.25, 1, 0.5, 1] }}
          role="status"
          className="hairline-b flex shrink-0 items-center justify-center gap-2 overflow-hidden bg-surface-2/60 px-4 text-note text-fg-2"
        >
          <Icon icon={Cloud} size={13} className="text-muted" />
          <span className="truncate">{view.text}</span>
          <Button size="sm" variant="ghost" icon={RotateCw} onClick={() => void switchComputer('cloud', link.team)}>Try again</Button>
          <Button size="sm" variant="ghost" onClick={() => void switchComputer('local')}>Back to This {MACHINE}</Button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
