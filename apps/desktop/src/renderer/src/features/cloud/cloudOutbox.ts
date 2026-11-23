/**
 * Messages to a cloud computer: the same queue as this Mac's (lib/outbox.ts, which grew out of this file), keyed by the
 * cloud computer's saved-copy key (`own`, `team:<id>`). Kept as a name for the cloud code and its tests.
 */
export {
  LOCAL_PREFIX, SEND_WAIT_MS, absorbSent, discardSend, dropSendsFor, dueSends, enqueueSend, failWaiting, hasPending, isLocalId,
  localMessage, newLocalId, pumpOutbox, resetOutbox, restoreSends, retrySend, sendsFor, setOutboxChat, setOutboxLink, transient,
  useOutbox as useCloudOutbox, whenCloudReady,
} from '../../lib/outbox';
export type { OutboxChat, OutboxLink, QueuedSend } from '../../lib/outbox';
