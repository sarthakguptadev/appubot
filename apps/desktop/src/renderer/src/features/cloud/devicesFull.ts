/**
 * Words and rows for the "remove a device to connect" dialog (`CloudDevicesDialog`): a cloud computer keeps a few
 * paired devices only, and a computer it refuses as one too many can't reach its Settings › Devices, so the account
 * lists them here and removes one. Pure, so it is tested without a window.
 */
import type { CloudPairedDevice } from '@appubot/protocol';
import { timeAgo } from '@appubot/chat-core';

export interface DeviceRow {
  id: string;
  name: string;
  kind: 'phone' | 'computer';
  /** when it was last used, in words */
  seen: string;
  /** not used for a while: the likeliest to go */
  stale: boolean;
}

const DAY = 24 * 60 * 60_000;
/** a device not used this long is pointed out as the one to remove */
export const STALE_AFTER_MS = 7 * DAY;

export function seenText(lastSeenAt: number | undefined, now: number): string {
  if (!lastSeenAt) return 'Never used';
  const ago = timeAgo(lastSeenAt, now);
  if (ago === 'now') return 'Used just now';
  // a week or more reads as a date ("Nov 7"), under that as "3d"
  return /^\d+[mhd]$/.test(ago) ? `Last used ${ago} ago` : `Last used ${ago}`;
}

/** the rows, the one unused longest first */
export function deviceRows(devices: CloudPairedDevice[], now: number): DeviceRow[] {
  return [...devices]
    .sort((a, b) => (a.lastSeenAt ?? 0) - (b.lastSeenAt ?? 0))
    .map((d) => ({
      id: d.id,
      name: d.name || 'Device',
      kind: d.platform === 'ios' || d.platform === 'android' ? 'phone' : 'computer',
      seen: seenText(d.lastSeenAt, now),
      stale: !d.lastSeenAt || now - d.lastSeenAt >= STALE_AFTER_MS,
    }));
}

/** the line under the dialog's title */
export function devicesFullLine(count: number, max: number, computer: string, thisMachine: string): string {
  const has = count >= max ? `and ${count} are paired` : `${count} of them paired`;
  return `${computer} keeps ${max} devices at most, ${has}. Remove one to connect ${thisMachine}; it can be paired again later.`;
}

/**
 * The notice after a pairing for which the computer made room by itself: which device was removed, so someone who
 * still uses it knows why it asks to connect again. Short: a toast shows two lines of its body.
 */
export function madeRoomNotice(replaced: CloudPairedDevice[], max: number, computer: string, now: number): { title: string; body: string } {
  const lower = (t: string): string => t.charAt(0).toLowerCase() + t.slice(1);
  const name = (d: CloudPairedDevice): string => `“${d.name || 'Device'}”`;
  const first = replaced[0];
  if (replaced.length === 1 && first) {
    return { title: `${name(first)} was removed to make room`, body: `${computer} keeps ${max} devices. It was ${lower(seenText(first.lastSeenAt, now))}.` };
  }
  const names = replaced.map(name);
  return { title: `${replaced.length} devices were removed to make room`, body: `${computer} keeps ${max} devices: ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} went.` };
}
