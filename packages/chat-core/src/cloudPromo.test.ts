import { describe, expect, it } from 'vitest';
import { CLOUD_PROMO_SNOOZE_MS, cloudPromoShows } from './cloudPromo';

describe('the sidebar’s cloud card', () => {
  const on = { eligible: true, loaded: true };
  it('shows for someone without a cloud computer once the account is read', () => {
    expect(cloudPromoShows(on)).toBe(true);
    expect(cloudPromoShows({ ...on, eligible: false })).toBe(false);
    expect(cloudPromoShows({ ...on, loaded: false })).toBe(false);
  });
  it('comes back: What’s new’s card or a dismissal for good from an older version don’t put it away', () => {
    expect(cloudPromoShows({ ...on, whatsNewCard: true, dismissed: true } as Parameters<typeof cloudPromoShows>[0])).toBe(true);
  });
  it('its ✕ puts it away for a day', () => {
    const now = 1_000_000_000;
    const snoozedUntil = now + CLOUD_PROMO_SNOOZE_MS;
    expect(cloudPromoShows({ ...on, snoozedUntil, now })).toBe(false);
    expect(cloudPromoShows({ ...on, snoozedUntil, now: snoozedUntil - 1 })).toBe(false);
    expect(cloudPromoShows({ ...on, snoozedUntil, now: snoozedUntil })).toBe(true);
    expect(cloudPromoShows({ ...on, snoozedUntil: 0, now })).toBe(true);
  });
});
