import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { createIdentity, roomIdForPublicKey } from './connect';
import { makeConnectTicket, readConnectTicket, verifyConnectTicket } from './connectTicket';

describe('connect ticket', () => {
  const secret = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(secret);
  const room = roomIdForPublicKey(createIdentity().edPublic);
  const now = 1_800_000_000_000;
  const t = makeConnectTicket(secret, { room, account: 'acc_1', expiresAt: now + 60_000 });

  it('round-trips its claims', () => {
    expect(readConnectTicket(t)).toEqual({ room, account: 'acc_1', expiresAt: now + 60_000 });
  });
  it('verifies for its room until it runs out', () => {
    expect(verifyConnectTicket(t, pub, room, now)).toBe(true);
    expect(verifyConnectTicket(t, pub, room, now + 60_000)).toBe(false);
  });
  it('refuses another room, another key, and any change', () => {
    expect(verifyConnectTicket(t, pub, roomIdForPublicKey(createIdentity().edPublic), now)).toBe(false);
    expect(verifyConnectTicket(t, ed25519.getPublicKey(ed25519.utils.randomPrivateKey()), room, now)).toBe(false);
    const [v, p, s] = t.split('.');
    const forged = makeConnectTicket(secret, { room, account: 'acc_2', expiresAt: now + 60_000 }).split('.')[1];
    expect(verifyConnectTicket(`${v}.${forged}.${s}`, pub, room, now)).toBe(false);
    expect(verifyConnectTicket(`${v}.${p}.`, pub, room, now)).toBe(false);
    expect(readConnectTicket('nonsense')).toBeNull();
  });
});
