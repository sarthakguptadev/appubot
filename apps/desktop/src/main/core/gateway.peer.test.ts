import { describe, expect, it } from 'vitest';
import { SettingsSchema } from '@appubot/protocol';
import { peerPolicy } from './gateway';

const defaults = SettingsSchema.parse({}).gateway;

describe('peerPolicy', () => {
  it('defaults admit Tailscale (with whois) and the local network', () => {
    expect(defaults).toMatchObject({ bind: 'tailscale', allowLan: true, requireTailscalePeer: true });
    expect(peerPolicy('::ffff:127.0.0.1', defaults)).toEqual({ ok: true, route: 'local' });
    expect(peerPolicy('100.101.12.44', defaults)).toEqual({ ok: true, route: 'tailscale', verify: 'whois' });
    expect(peerPolicy('::ffff:192.168.1.30', defaults)).toEqual({ ok: true, route: 'lan' });
    expect(peerPolicy('10.0.0.9', defaults)).toEqual({ ok: true, route: 'lan' });
    expect(peerPolicy('fe80::1c2d%en0', defaults)).toEqual({ ok: true, route: 'lan' });
  });

  it('refuses public addresses unless bind is all', () => {
    expect(peerPolicy('203.0.113.9', defaults).ok).toBe(false);
    expect(peerPolicy('203.0.113.9', { ...defaults, bind: 'all' })).toEqual({ ok: true, route: 'lan' });
  });

  it('allowLan off: Tailscale only', () => {
    const g = { ...defaults, allowLan: false };
    expect(peerPolicy('192.168.1.30', g).ok).toBe(false);
    expect(peerPolicy('100.101.12.44', g).ok).toBe(true);
  });

  it('loopback-only refuses everyone else', () => {
    const g = { ...defaults, bind: 'loopback' as const };
    expect(peerPolicy('192.168.1.30', g).ok).toBe(false);
    expect(peerPolicy('100.101.12.44', g).ok).toBe(false);
    expect(peerPolicy('127.0.0.1', g).ok).toBe(true);
  });

  it('skips whois when not required', () => {
    expect(peerPolicy('100.101.12.44', { ...defaults, requireTailscalePeer: false })).toEqual({ ok: true, route: 'tailscale' });
  });

  it('saved settings from before allowLan get it on', () => {
    expect(SettingsSchema.parse({ gateway: { port: 7890, bind: 'tailscale', requireTailscalePeer: true } }).gateway.allowLan).toBe(true);
  });
});
