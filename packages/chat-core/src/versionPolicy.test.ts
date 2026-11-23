import { describe, expect, it } from 'vitest';
import { STOPPED_MESSAGE, parseVersionPolicy, phoneStoppedBy, phoneStoppedMessage, stoppedBy } from './versionPolicy';

describe('versionPolicy', () => {
  it('reads a policy leniently', () => {
    expect(parseVersionPolicy(null)).toEqual({});
    expect(parseVersionPolicy({ minVersion: ' 2026.1107.1 ', blocked: ['2026.1106.1', 7, ''], message: '', updatedAt: 'x' }))
      .toEqual({ minVersion: '2026.1107.1', blocked: ['2026.1106.1'] });
    expect(parseVersionPolicy({ phone: { minVersion: '2026.1108.1', message: 'Update the app.' } }))
      .toEqual({ phone: { minVersion: '2026.1108.1', message: 'Update the app.' } });
    expect(parseVersionPolicy({ phone: 'nope' })).toEqual({});
  });

  it('stops versions below the minimum or listed', () => {
    expect(stoppedBy({}, '2026.10.17')).toBeNull();
    expect(stoppedBy({ minVersion: '2026.10.17' }, '2026.10.17')).toBeNull();
    expect(stoppedBy({ minVersion: '2026.10.18' }, '2026.10.17')).toBe(STOPPED_MESSAGE);
    expect(stoppedBy({ minVersion: '2026.1107.1' }, '2026.10.31')).toBe(STOPPED_MESSAGE);
    expect(stoppedBy({ blocked: ['2026.10.17'], message: ' Fix inside. ' }, '2026.10.17')).toBe('Fix inside.');
    expect(stoppedBy({ blocked: ['2026.10.16'] }, '2026.10.17')).toBeNull();
  });

  it('applies only the phone rules to phones, naming the store', () => {
    const policy = parseVersionPolicy({ minVersion: '2026.1108.1', phone: { blocked: ['2026.1107.1'] } });
    expect(phoneStoppedBy(policy, '2026.1107.1', 'ios')).toBe(phoneStoppedMessage('ios'));
    expect(phoneStoppedBy(policy, '2026.1107.1', 'android')).toContain('Google Play');
    expect(phoneStoppedBy(policy, '2026.1107.1')).toContain('the App Store or Google Play');
    // the desktop's minimum doesn't touch phones
    expect(phoneStoppedBy(policy, '2026.10.1', 'ios')).toBeNull();
    expect(phoneStoppedBy({ minVersion: '2026.1108.1' }, '2026.10.1', 'ios')).toBeNull();
    // no version known (a client from before it said one): it works
    expect(phoneStoppedBy(policy, undefined, 'ios')).toBeNull();
    expect(phoneStoppedBy({ phone: { minVersion: '2026.1108.1', message: 'Please update.' } }, '2026.1107.2', 'ios')).toBe('Please update.');
  });
});
