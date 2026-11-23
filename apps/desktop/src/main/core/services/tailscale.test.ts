import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { hostCandidates, lanAddresses, type TailscaleStatus } from './tailscale';

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null }) as NetworkInterfaceInfo;
const v6 = (address: string) => ({ address, family: 'IPv6', internal: false, netmask: 'ffff::', mac: '00:00:00:00:00:00', cidr: null, scopeid: 0 }) as NetworkInterfaceInfo;

const running: TailscaleStatus = { installed: true, running: true, ips: ['100.91.133.6', 'fd7a:115c:a1e0::1'], dnsName: 'mac.tail1234.ts.net' };

describe('lanAddresses', () => {
  it('keeps private IPv4 addresses, Wi-Fi/Ethernet first', () => {
    const ifaces = {
      lo0: [v4('127.0.0.1', true)],
      bridge100: [v4('192.168.2.1')],
      utun4: [v4('100.91.133.6')],
      en0: [v4('192.168.1.20'), v6('fe80::1')],
      en7: [v4('10.0.0.4')],
      en9: [v4('169.254.10.2'), v4('203.0.113.9')],
    };
    expect(lanAddresses(ifaces)).toEqual(['192.168.1.20', '10.0.0.4', '192.168.2.1']);
  });
});

describe('hostCandidates', () => {
  it('Tailscale on: its addresses first, then the local network, IPv6 last', () => {
    expect(hostCandidates(running, ['192.168.1.20']).map((h) => `${h.kind}:${h.host}`)).toEqual([
      'tailscale:100.91.133.6', 'magicdns:mac.tail1234.ts.net', 'lan:192.168.1.20', 'tailscale:fd7a:115c:a1e0::1',
    ]);
  });

  it('Tailscale off: local network first, the tailnet addresses still listed for later', () => {
    expect(hostCandidates({ ...running, running: false }, ['192.168.1.20']).map((h) => h.host)).toEqual([
      '192.168.1.20', '100.91.133.6', 'mac.tail1234.ts.net', 'fd7a:115c:a1e0::1',
    ]);
  });

  it('no Tailscale: only the local network', () => {
    expect(hostCandidates({ installed: false, running: false, ips: [] }, ['10.0.0.4'])).toEqual([{ host: '10.0.0.4', kind: 'lan' }]);
  });

  it('no local addresses offered (LAN not admitted): only Tailscale', () => {
    expect(hostCandidates(running, []).map((h) => h.kind)).toEqual(['tailscale', 'magicdns', 'tailscale']);
  });
});
