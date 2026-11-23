/**
 * Fix your computer as the desktop shows it (plan §6.9): the view-model lives in chat-core (`cloudRepair.ts`), shared
 * with the phone; re-exported here for the desktop's components and tests.
 */
export { fixOffer, repairCard, unreachableFixes, updateLine, type FixOffer, type RepairCard } from '@appubot/chat-core';
