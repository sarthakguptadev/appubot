import { describe, expect, test } from 'vitest';
import { addressKey, connectIdOfUrl, connectUrl, hostKind, hostOfUrl, isConnectUrl, urlRoute, hostRoute, hostUrl, isLoopbackAddress, isPrivateLanAddress, isTailscaleAddress, mergeHosts, orderHosts, plainIp, safeGatewayPath, MAX_SAVED_HOSTS } from './net';

describe('address classes', () => {
  test('tailscale ranges', () => {
    expect(isTailscaleAddress('100.91.133.6')).toBe(true);
    expect(isTailscaleAddress('::ffff:100.64.0.1')).toBe(true);
    expect(isTailscaleAddress('100.128.0.1')).toBe(false);
    expect(isTailscaleAddress('fd7a:115c:a1e0::1')).toBe(true);
    expect(isTailscaleAddress('192.168.1.5')).toBe(false);
  });

  test('private local-network ranges', () => {
    for (const ip of ['10.0.0.7', '172.16.4.2', '172.31.255.1', '192.168.1.20', '169.254.3.3', 'fe80::1%en0', 'fd12:3456::1', '::ffff:192.168.0.9']) {
      expect(isPrivateLanAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.91.133.6', 'fd7a:115c:a1e0::1', '2001:db8::1', '127.0.0.1', '', 'mac.local']) {
      expect(isPrivateLanAddress(ip), ip).toBe(false);
    }
  });

  test('host kinds and routes', () => {
    expect(hostKind('100.91.133.6')).toBe('tailscale');
    expect(hostKind('my-mac.tail1234.ts.net')).toBe('magicdns');
    expect(hostKind('192.168.1.20')).toBe('lan');
    expect(hostKind('appubot.com')).toBe('lan');
    expect(hostKind('Sarthaks-Mac.local')).toBe('lan');
    expect(hostKind('127.0.0.1')).toBe('loopback');
    expect(hostRoute('my-mac.tail1234.ts.net')).toBe('tailscale');
    expect(hostRoute('10.0.0.7')).toBe('lan');
    expect(hostRoute('::1')).toBe('local');
  });

  test('loopback is a real loopback literal or localhost, never a name that starts like one', () => {
    for (const ip of ['127.0.0.1', '127.8.9.10', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', 'localhost', 'LOCALHOST']) {
      expect(isLoopbackAddress(ip), ip).toBe(true);
    }
    for (const ip of ['127.x.example.com', '127.0.0.1.example.com', '127.evil', '127.', '127.0.0.256', '1270.0.0.1', '::2', '::', 'localhost.example.com', 'mylocalhost', '', '10.0.0.1']) {
      expect(isLoopbackAddress(ip), ip).toBe(false);
    }
    // a name like that is a host on the network: the phone never goes to it plainly
    expect(hostKind('127.x.example.com')).toBe('lan');
    expect(urlRoute('http://127.0.0.1.example.com:7890')).toBe('lan');
    expect(urlRoute('http://127.0.0.1:7890')).toBe('local');
    expect(urlRoute('http://[::1]:7890')).toBe('local');
  });

  test('urls', () => {
    expect(hostUrl('100.91.133.6', 7890)).toBe('http://100.91.133.6:7890');
    expect(hostUrl('fd7a:115c:a1e0::1', 7890)).toBe('http://[fd7a:115c:a1e0::1]:7890');
    expect(hostOfUrl('http://[fd7a:115c:a1e0::1]:7890')).toBe('fd7a:115c:a1e0::1');
    expect(hostOfUrl('http://192.168.1.20:7890/')).toBe('192.168.1.20');
    expect(hostOfUrl('nope')).toBe('');
    expect(plainIp('::ffff:10.0.0.1')).toBe('10.0.0.1');
  });
});

describe('host lists', () => {
  test('orderHosts puts the last good host first', () => {
    expect(orderHosts(['100.1.1.1', 'mac.t.ts.net', '192.168.1.5'], '192.168.1.5')).toEqual(['192.168.1.5', '100.1.1.1', 'mac.t.ts.net']);
    expect(orderHosts(['a', 'b', 'a'], 'zzz')).toEqual(['a', 'b']);
  });

  test('mergeHosts: the Mac’s current list first, Tailscale hosts kept, stale LAN capped', () => {
    const saved = ['100.91.133.6', 'mac.tail.ts.net', '192.168.1.5', '10.0.0.4', '192.168.0.12'];
    // DHCP gave the Mac a new address and Tailscale is off on it right now
    const merged = mergeHosts(saved, [{ host: '192.168.1.9', kind: 'lan' }, { host: '127.0.0.1', kind: 'loopback' }]);
    expect(merged).toEqual(['192.168.1.9', '100.91.133.6', 'mac.tail.ts.net', '192.168.1.5', '10.0.0.4']);
  });

  test('mergeHosts keeps the saved list when the Mac reports nothing', () => {
    expect(mergeHosts(['100.91.133.6'], [])).toEqual(['100.91.133.6']);
    expect(mergeHosts(['100.91.133.6'], [{ host: '127.0.0.1', kind: 'loopback' }])).toEqual(['100.91.133.6']);
  });

  test('mergeHosts dedupes and caps', () => {
    const fresh = Array.from({ length: 20 }, (_, i) => ({ host: `10.0.0.${i}`, kind: 'lan' as const }));
    expect(mergeHosts([], [...fresh, ...fresh])).toHaveLength(MAX_SAVED_HOSTS);
    expect(mergeHosts(['100.1.1.1'], [{ host: '100.1.1.1', kind: 'tailscale' }, { host: '192.168.1.2', kind: 'lan' }])).toEqual(['100.1.1.1', '192.168.1.2']);
  });
});

describe('AppuBot Connect URLs', () => {
  const room = 'abcdefghijklmnopqrstuvwxyz';
  test('a room as a base URL, and back', () => {
    expect(connectUrl(room)).toBe(`connect://${room}`);
    expect(isConnectUrl(connectUrl(room))).toBe(true);
    expect(isConnectUrl('http://100.64.0.1:7890')).toBe(false);
    expect(connectIdOfUrl(`connect://${room}/files/x?token=t`)).toBe(room);
    expect(connectIdOfUrl('http://10.0.0.2:7890')).toBeNull();
    expect(hostOfUrl(`connect://${room}/ws`)).toBe(room);
  });
  test('the route of a base URL', () => {
    expect(urlRoute(connectUrl(room))).toBe('connect');
    expect(urlRoute('http://100.64.0.1:7890')).toBe('tailscale');
    expect(urlRoute('http://192.168.1.4:7890')).toBe('lan');
    expect(urlRoute('http://127.0.0.1:7890')).toBe('local');
  });
});

describe('gateway paths a token may go on', () => {
  test('the gateway’s own paths, with their queries', () => {
    expect(safeGatewayPath('/files/f_1')).toBe('/files/f_1');
    expect(safeGatewayPath('/pages/p?v=abc&theme=light')).toBe('/pages/p?v=abc&theme=light');
    expect(safeGatewayPath('/files/a%2Fb')).toBe('/files/a%2Fb');
  });
  test('anything that could name another host or app never does', () => {
    for (const bad of [
      'someapp://x', 'javascript:alert(1)', 'file:///etc/passwd', 'https://evil.com/x', 'data:text/html,x',
      '//evil.com/x', '/\\evil.com/x', '\\evil.com', '/\t/evil.com', '/\n/evil.com', ' /files/x', '/files/x ',
      '/%2Fevil.com/x', '/%2fevil.com', '/%5Cevil.com', '/%255Cevil.com', '/%252F%252Fevil.com', '/%09/evil.com', '/%0a/evil.com',
      'files/x', '', '%2F%2Fevil.com', '/%E0%A4%A', '/%25252525252F',
      // dot segments: `/..//evil.com` resolves to `//evil.com`
      '/..//evil.com', '/../files/x', '/files/../../x', '/files/..', '/./files/x', '/files/.', '/files/..?download=1',
      '/%2e%2e//evil.com', '/%2E%2E/x', '/.%2e/x', '/%2e./x', '/%252e%252e//evil.com', '/files/%2e',
    ]) expect(safeGatewayPath(bad), bad).toBeNull();
    // dots inside a name are fine
    expect(safeGatewayPath('/files/report..v2.pdf')).toBe('/files/report..v2.pdf');
    expect(safeGatewayPath('/files/.hidden')).toBe('/files/.hidden');
    expect(safeGatewayPath('/pages/p?v=a..b')).toBe('/pages/p?v=a..b');
    expect(safeGatewayPath(undefined)).toBeNull();
    expect(safeGatewayPath(42)).toBeNull();
  });
});

describe('addressKey', () => {
  test('IPv4 as is, IPv6 by its /64', () => {
    expect(addressKey('203.0.113.9')).toBe('203.0.113.9');
    expect(addressKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(addressKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:0db8:0001:0002:ffff:1:2:3')).toBe('2001:db8:1:2::/64');
    expect(addressKey('[2001:db8:1:2::9]')).toBe('2001:db8:1:2::/64');
    expect(addressKey('fe80::1%en0')).toBe('fe80:0:0:0::/64');
    expect(addressKey('connect')).toBe('connect');
  });
});
