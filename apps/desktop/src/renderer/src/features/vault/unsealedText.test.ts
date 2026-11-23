import { describe, expect, it } from 'vitest';
import { unsealedVaultText } from './unsealedText';

describe('a cloud computer whose Vault isn’t encrypted', () => {
  it('is told to update only while an update is there to take', () => {
    expect(unsealedVaultText('Your AppuBot computer', false, 'carry')).toBe('Your AppuBot computer doesn’t encrypt its Vault yet, so nothing is sent to it. Update it first (Settings › Account › Manage › Update), then come back.');
    expect(unsealedVaultText('Your AppuBot computer', false, 'page')).toContain('Update it (Settings › Account › Manage › Update)');
  });

  it('on the newest version, or with the version not known, never says to update', () => {
    for (const upToDate of [true, undefined]) {
      for (const place of ['carry', 'page'] as const) {
        const text = unsealedVaultText('Acme Cloud Computer', upToDate, place);
        expect(text).not.toMatch(/Update it/);
        expect(text).toContain('isn’t out for this computer yet');
        expect(text.startsWith('Acme Cloud Computer doesn’t encrypt its Vault yet')).toBe(true);
      }
    }
    expect(unsealedVaultText('Your AppuBot computer', true, 'carry')).toContain('nothing is sent to it');
    expect(unsealedVaultText('Your AppuBot computer', true, 'page')).toContain('kept as typed');
  });
});
