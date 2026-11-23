import { describe, expect, it, vi } from 'vitest';

vi.mock('./native', () => ({
  native: () => ({ version: '1', getGateway: async () => ({ url: 'http://127.0.0.1:7890', token: 'owner-token', deviceId: 'desktop' }) }),
}));
vi.mock('./platform', () => ({ MACHINE: 'Mac' }));

describe('the owner token on links', () => {
  it('goes only on the gateway’s own paths, inside the app; a tool’s link never hands it to the browser', async () => {
    const { fileUrl, initGateway, linkTarget } = await import('./gateway');
    await initGateway();
    // the window's own views load files with it (never leaving the app)
    expect(fileUrl('/files/abc')).toBe('http://127.0.0.1:7890/files/abc?token=owner-token');
    // a tool's link to one of AppuBot's files or pages opens it by id (`files.open`), with no URL at all
    expect(linkTarget('/files/abc')).toEqual({ fileId: 'abc' });
    expect(linkTarget('/files/file_mx1a2b3c04?download=1')).toEqual({ fileId: 'file_mx1a2b3c04' });
    expect(linkTarget('/pages/file_p1?v=key&theme=dark')).toEqual({ fileId: 'file_p1' });
    // web addresses and inline data pass as they are, with no token
    expect(linkTarget('https://example.com/a.pdf')).toEqual({ url: 'https://example.com/a.pdf' });
    expect(fileUrl('data:image/png;base64,AA')).toBe('data:image/png;base64,AA');
    for (const bad of ['someapp://x', 'javascript:alert(1)', 'file:///etc/hosts', '//evil.com/x', '/\\evil.com/x', '/%2Fevil.com', 'files/abc', '/..//evil.com', '/files/%2e%2e']) {
      expect(linkTarget(bad), bad).toBeNull();
      expect(fileUrl(bad), bad).not.toContain('owner-token');
    }
    // other gateway paths open nothing from a tool's link either
    for (const other of ['/api/files', '/files/', '/files/a/b', '/ws']) expect(linkTarget(other), other).toBeNull();
    // nothing linkTarget gives carries the token
    for (const uri of ['/files/abc', '/pages/p?v=k', 'https://example.com/x']) expect(JSON.stringify(linkTarget(uri))).not.toContain('owner-token');
  });
});
