// The Usage page's activity grid (Rare UI's GitHubActivity): the tally of days and the grid made from it are
// chat-core's (`usageActivity.ts`), shared with the phone's Usage page since 2026-11-16; this file keeps the names the
// page and its test import.
export {
  ACTIVITY_KEEP_DAYS, ACTIVITY_KEY, ACTIVITY_WEEKS, activityDays, dayKey, mergeDays, readLedger,
  type DayLedger, type DayTally, type UsageActivity as Activity,
} from '@appubot/chat-core';
