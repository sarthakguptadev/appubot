import { describe, expect, it } from 'vitest';
import { deviceRows, devicesFullLine, madeRoomNotice, seenText } from './devicesFull';

const NOW = Date.UTC(2026, 10, 19, 13, 40);
const MIN = 60_000, DAY = 24 * 60 * MIN;

describe('the devices of a cloud computer that is full', () => {
  it('lists the one unused longest first and points out the stale ones', () => {
    const rows = deviceRows([
      { id: 'mac', name: 'Sarthak’s MacBook Air', platform: 'desktop', lastSeenAt: NOW - 2 * MIN },
      { id: 'old', name: 'iPhone', platform: 'ios', lastSeenAt: NOW - 12 * DAY },
      { id: 'never', name: '', platform: 'android' },
      { id: 'phone', name: 'iPhone', platform: 'ios', lastSeenAt: NOW - 2 * 60 * MIN },
    ], NOW);
    expect(rows.map((r) => r.id)).toEqual(['never', 'old', 'phone', 'mac']);
    expect(rows.map((r) => r.kind)).toEqual(['phone', 'phone', 'phone', 'computer']);
    expect(rows.map((r) => r.stale)).toEqual([true, true, false, false]);
    expect(rows[0]).toMatchObject({ name: 'Device', seen: 'Never used' });
    expect(rows[2]!.seen).toBe('Last used 2h ago');
    expect(rows[3]!.seen).toBe('Last used 2m ago');
  });

  it('says when a device was last used', () => {
    expect(seenText(NOW - 10_000, NOW)).toBe('Used just now');
    expect(seenText(NOW - 3 * DAY, NOW)).toBe('Last used 3d ago');
    // a week or more is a date, with no "ago"
    expect(seenText(NOW - 12 * DAY, NOW)).toMatch(/^Last used \D*7\D*$/);
    expect(seenText(undefined, NOW)).toBe('Never used');
  });

  it('says which device made room', () => {
    expect(madeRoomNotice([{ id: 'a', name: 'iPhone', platform: 'ios', lastSeenAt: NOW - 3 * DAY }], 3, 'Your AppuBot computer', NOW))
      .toEqual({ title: '“iPhone” was removed to make room', body: 'Your AppuBot computer keeps 3 devices. It was last used 3d ago.' });
    expect(madeRoomNotice([{ id: 'a', name: 'iPhone', platform: 'ios' }], 3, 'Your AppuBot computer', NOW).body).toBe('Your AppuBot computer keeps 3 devices. It was never used.');
    // a date keeps its capital
    expect(madeRoomNotice([{ id: 'a', name: 'iPhone', platform: 'ios', lastSeenAt: NOW - 12 * DAY }], 3, 'Your AppuBot computer', NOW).body).toMatch(/It was last used [A-Z0-9]/);
    expect(madeRoomNotice([{ id: 'a', name: 'iPhone', platform: 'ios' }, { id: 'b', name: '', platform: 'desktop' }], 3, 'Acme’s AppuBot computer', NOW))
      .toEqual({ title: '2 devices were removed to make room', body: 'Acme’s AppuBot computer keeps 3 devices: “iPhone” and “Device” went.' });
  });

  it('words the line under the title', () => {
    expect(devicesFullLine(3, 3, 'Your AppuBot computer', 'this Mac')).toBe('Your AppuBot computer keeps 3 devices at most, and 3 are paired. Remove one to connect this Mac; it can be paired again later.');
  });
});
