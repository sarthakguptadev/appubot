import type { Bot, Thread } from '@appubot/protocol';

/**
 * `?roster=many`: a crowded sidebar for the shell's states: many bots, long names (pinned and listed), one working,
 * one waiting on you, and a bot with many threads with long titles (its "Show more"). Unread marks live in the
 * window's localStorage (`appubot:unread:v1`), read before the mock starts: set them there for `thr_many_<n>`.
 */
export const mockRosterMany = (): boolean =>
  typeof location !== 'undefined' && new URLSearchParams(location.search).get('roster') === 'many';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const LOOKS: { name: string; color: string; shape: Bot['shape']; job: string; pinned?: boolean }[] = [
  { name: 'Research assistant for the quarterly investor update', color: '#8B5CF6', shape: 'hex', job: 'Reads, summarises and drafts', pinned: true },
  { name: 'Inbox', color: '#10B981', shape: 'drop', job: 'Email triage', pinned: true },
  { name: 'Travel', color: '#F59E0B', shape: 'cloud', job: 'Trips and bookings' },
  { name: 'Very long bot name that keeps going and going past the sidebar', color: '#EF4444', shape: 'circle', job: 'Testing long names' },
  { name: 'Design', color: '#EC4899', shape: 'squircle', job: 'Mockups' },
  { name: 'Code reviewer', color: '#06B6D4', shape: 'hex', job: 'Reviews pull requests' },
  { name: 'Groceries', color: '#84CC16', shape: 'drop', job: 'Weekly shop' },
  { name: 'Calendar', color: '#6366F1', shape: 'cloud', job: 'Meetings' },
  { name: 'Photos', color: '#F97316', shape: 'circle', job: 'Sorts the camera roll' },
  { name: 'Taxes', color: '#14B8A6', shape: 'squircle', job: 'GST and ITR' },
];

export function rosterExtras(base: { bot: Bot; thread: (p: Pick<Thread, 'id' | 'botId' | 'title'> & Partial<Thread>) => Thread }): { bots: Bot[]; threads: Thread[] } {
  const now = Date.now();
  const bots: Bot[] = LOOKS.map((l, i) => ({
    ...base.bot, id: `bot_many_${i}`, slug: `many-${i}`, name: l.name, color: l.color, shape: l.shape, job: l.job,
    pinned: !!l.pinned, workspace: `/Users/sarthak/AppuBot/many-${i}`, createdAt: now - (30 - i) * DAY, updatedAt: now - i * HOUR,
  }));
  const threads: Thread[] = [];
  bots.forEach((b, i) => {
    const id = `thr_many_${i}`;
    threads.push(base.thread({
      id, botId: b.id, title: i === 0 ? 'Draft the investor update with every number from the board deck checked twice' : `${b.name} chat`,
      status: i === 2 ? 'running' : i === 4 ? 'waiting' : 'idle',
      lastMessagePreview: i === 3 ? 'A very long preview of the last message that certainly will not fit on a single line of the sidebar row' : `Last word from ${b.name}`,
      createdAt: now - (i + 1) * DAY, updatedAt: now - (i * 7 + 2) * MIN, lastActiveAt: now - (i * 7 + 2) * MIN,
    }));
  });
  // the first listed bot gets many threads (its "Show more")
  for (let k = 0; k < 14; k++) {
    threads.push(base.thread({
      id: `thr_many_t${k}`, botId: bots[2]!.id, title: k % 4 === 0 ? `A thread with a long title number ${k} that runs on past the sidebar edge` : `Trip ${k + 1}`,
      lastMessagePreview: 'ok', createdAt: now - (k + 2) * DAY, updatedAt: now - (k + 2) * DAY, lastActiveAt: now - (k + 2) * DAY,
    }));
  }
  return { bots, threads };
}
