import { describe, expect, it } from 'vitest';
import type { VaultItem } from '@appubot/protocol';
import { CARDS_STAY, carryKey, carryLine, carrySave, defaultCarryPicks, planVaultCarry } from './vaultCarryPlan';

const item = (p: Partial<VaultItem> & Pick<VaultItem, 'id' | 'kind' | 'name'>): VaultItem => ({ secrets: [], createdAt: 1, updatedAt: 1, ...p });

const MAC: VaultItem[] = [
  item({ id: 'm1', kind: 'login', name: 'GitHub', site: 'www.GitHub.com', username: 'Me@x.com', secrets: ['password'], notes: 'work' }),
  item({ id: 'm2', kind: 'login', name: 'Zoho', site: 'zoho.com', username: 'me', secrets: ['password'] }),
  item({ id: 'm3', kind: 'apiKey', name: 'OpenAI', envName: 'OPENAI_API_KEY', secrets: ['key'], hint: 'abcd' }),
  item({ id: 'm4', kind: 'card', name: 'Work card', expiry: '08/29', secrets: ['number', 'cvc'], hint: '4242', brand: 'Visa' }),
  item({ id: 'm5', kind: 'contact', name: 'Home', contact: { fullName: 'A', email: 'a@x.com', phone: '', company: '', address1: '', address2: '', city: 'Pune', region: '', postalCode: '', country: '' } }),
  item({ id: 'm6', kind: 'login', name: 'Wi-Fi', secrets: ['password'] }),
];
const THERE: VaultItem[] = [
  item({ id: 'c1', kind: 'login', name: 'My GitHub', site: 'github.com', username: 'me@x.com', secrets: ['password'] }),
  item({ id: 'c2', kind: 'apiKey', name: 'OpenAI key', envName: 'OPENAI_API_KEY', secrets: ['key'] }),
  item({ id: 'c3', kind: 'login', name: 'wi-fi', secrets: ['password'] }),
];

describe('planVaultCarry', () => {
  it('finds what is already there, keeps cards back, and ticks only what is new', () => {
    const rows = planVaultCarry(MAC, THERE);
    const by = Object.fromEntries(rows.map((r) => [r.item.id, r]));
    expect(by.m1!.existing?.id).toBe('c1');
    expect(by.m2!.existing).toBeUndefined();
    expect(by.m3!.existing?.id).toBe('c2');
    expect(by.m4!.blocked).toBe(CARDS_STAY);
    expect(by.m5!.existing).toBeUndefined();
    // a login with no site or username is matched by its name
    expect(by.m6!.existing?.id).toBe('c3');
    expect(rows.map((r) => r.item.name)).toEqual(['GitHub', 'Home', 'OpenAI', 'Wi-Fi', 'Work card', 'Zoho']);
    expect([...defaultCarryPicks(rows)].sort()).toEqual(['m2', 'm5']);
    // where cards are kept, a card goes like the rest (never matched: two cards are never taken for one)
    expect(planVaultCarry(MAC, THERE, { cards: true }).find((r) => r.item.id === 'm4')).toEqual({ item: MAC[3] });
    expect(carryKey(MAC[3]!)).toBe('');
  });

  it('saves an item as it is here, over the one there when it stands for it', () => {
    const rows = planVaultCarry(MAC, THERE);
    const gh = rows.find((r) => r.item.id === 'm1')!;
    expect(carrySave(gh, { password: 'hunter2' })).toEqual({ id: 'c1', kind: 'login', name: 'GitHub', site: 'www.GitHub.com', username: 'Me@x.com', notes: 'work', secrets: { password: 'hunter2' } });
    const zoho = rows.find((r) => r.item.id === 'm2')!;
    // a secret of another kind never rides along, and none revealed sends none
    expect(carrySave(zoho, { password: 'pw', key: 'nope' } as never)).toEqual({ kind: 'login', name: 'Zoho', site: 'zoho.com', username: 'me', secrets: { password: 'pw' } });
    expect(carrySave(rows.find((r) => r.item.id === 'm5')!, {})).toMatchObject({ kind: 'contact', name: 'Home', contact: { city: 'Pune' } });
    expect('secrets' in carrySave(rows.find((r) => r.item.id === 'm5')!, {})).toBe(false);
  });

  it('describes an item without a secret', () => {
    expect(carryLine(MAC[0]!)).toBe('Login · www.GitHub.com · Me@x.com');
    expect(carryLine(MAC[2]!)).toBe('API key · OPENAI_API_KEY');
    expect(carryLine(MAC[3]!)).toBe('Card · Visa · ending 4242');
  });
});
