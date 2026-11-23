import { describe, expect, it } from 'vitest';
import { CLOUD_CACHE_OWN, cloudCacheKey, lostCloudCaches, teamOfCacheKey } from './cloudCache';

const keys = [CLOUD_CACHE_OWN, 'team:acme', 'team:beta'];

describe('cloud cache keys', () => {
  it('names the own computer and teams', () => {
    expect(cloudCacheKey()).toBe('own');
    expect(cloudCacheKey('acme')).toBe('team:acme');
    expect(teamOfCacheKey('team:acme')).toBe('acme');
    expect(teamOfCacheKey('own')).toBeNull();
  });
});

describe('lostCloudCaches', () => {
  it('drops everything when signed out, read or not', () => {
    expect(lostCloudCaches({ signedIn: false, read: false }, keys)).toEqual(keys);
  });

  it('drops nothing on a failed read', () => {
    expect(lostCloudCaches({ signedIn: true, read: false, ownState: 'deleted', teams: [] }, keys)).toEqual([]);
  });

  it('keeps a working computer and its teams', () => {
    const teams = [{ id: 'acme', state: 'asleep' as const }, { id: 'beta', state: 'running' as const }];
    expect(lostCloudCaches({ signedIn: true, read: true, accountStatus: 'active', ownState: 'asleep', teams }, keys)).toEqual([]);
  });

  it('keeps one on hold or suspended (still the person’s)', () => {
    expect(lostCloudCaches({ signedIn: true, read: true, ownState: 'on-hold' }, [CLOUD_CACHE_OWN])).toEqual([]);
    expect(lostCloudCaches({ signedIn: true, read: true, ownState: 'suspended' }, [CLOUD_CACHE_OWN])).toEqual([]);
  });

  it('drops the own copy once the plan ended or the computer is gone', () => {
    for (const ownState of ['export-only', 'deleted', 'failed', 'none'] as const) {
      expect(lostCloudCaches({ signedIn: true, read: true, ownState }, [CLOUD_CACHE_OWN])).toEqual([CLOUD_CACHE_OWN]);
    }
    expect(lostCloudCaches({ signedIn: true, read: true, ownState: null }, [CLOUD_CACHE_OWN])).toEqual([CLOUD_CACHE_OWN]);
    expect(lostCloudCaches({ signedIn: true, read: true, accountStatus: 'ended', ownState: 'asleep' }, [CLOUD_CACHE_OWN])).toEqual([CLOUD_CACHE_OWN]);
  });

  it('drops a team the person is no longer on, or whose computer is gone', () => {
    const teams = [{ id: 'acme', state: 'export-only' as const }];
    expect(lostCloudCaches({ signedIn: true, read: true, ownState: 'running', teams }, keys)).toEqual(['team:acme', 'team:beta']);
  });

  it('keeps a team whose computer wasn’t read this time, and all teams when teams weren’t read', () => {
    expect(lostCloudCaches({ signedIn: true, read: true, ownState: 'running', teams: [{ id: 'acme', state: null }, { id: 'beta', state: 'asleep' }] }, keys)).toEqual([]);
    expect(lostCloudCaches({ signedIn: true, read: true, ownState: 'running' }, keys)).toEqual([]);
  });
});
