import { describe, expect, it } from 'vitest';
import { Methods } from './wire';
import { parseConnectorImport } from './connectors';

describe('importing connectors from another app’s config', () => {
  it('reads Claude’s and Cursor’s mcpServers, local and remote', () => {
    const r = parseConnectorImport(JSON.stringify({
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me/Desktop'], env: { LOG: 'debug', PORT: 3000 } },
        linear: { url: 'https://mcp.linear.app/sse' },
        notion: { type: 'http', url: 'https://mcp.notion.com/mcp', headers: { Authorization: 'Bearer abc' } },
      },
    }));
    expect(r.problems).toEqual([]);
    expect(r.connectors).toEqual([
      { name: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me/Desktop'], headers: [], env: [{ name: 'LOG', value: 'debug' }, { name: 'PORT', value: '3000' }] },
      { name: 'linear', transport: 'sse', url: 'https://mcp.linear.app/sse', args: [], headers: [], env: [] },
      { name: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp', args: [], headers: [{ name: 'Authorization', value: 'Bearer abc' }], env: [] },
    ]);
  });

  it('reads VS Code’s servers, OpenCode’s mcp, Zed’s context_servers and Windsurf’s serverUrl', () => {
    expect(parseConnectorImport(JSON.stringify({ servers: { gh: { type: 'sse', url: 'https://x.dev/events' } } })).connectors[0]).toMatchObject({ name: 'gh', transport: 'sse' });
    expect(parseConnectorImport(JSON.stringify({ mcp: { servers: { a: { command: 'uvx', args: ['a'] } } } })).connectors[0]).toMatchObject({ name: 'a', transport: 'stdio', command: 'uvx' });
    expect(parseConnectorImport(JSON.stringify({ mcp: { mem: { type: 'local', command: ['bunx', 'mem-server', '--fast'], environment: { K: 'v' } }, web: { type: 'remote', url: 'https://w.dev/mcp' } } })).connectors).toEqual([
      { name: 'mem', transport: 'stdio', command: 'bunx', args: ['mem-server', '--fast'], headers: [], env: [{ name: 'K', value: 'v' }] },
      { name: 'web', transport: 'http', url: 'https://w.dev/mcp', args: [], headers: [], env: [] },
    ]);
    expect(parseConnectorImport(JSON.stringify({ context_servers: { z: { command: { path: '/bin/zs', args: ['--stdio'], env: {} } } } })).connectors[0]).toMatchObject({ transport: 'stdio', command: '/bin/zs', args: ['--stdio'] });
    expect(parseConnectorImport(JSON.stringify({ mcpServers: { w: { serverUrl: 'https://w.dev/mcp' } } })).connectors[0]).toMatchObject({ transport: 'http', url: 'https://w.dev/mcp' });
  });

  it('takes a bare map, one server’s entry, and text around the JSON', () => {
    expect(parseConnectorImport('{"one": {"command": "node", "args": ["s.js"]}}').connectors[0]).toMatchObject({ name: 'one', command: 'node' });
    expect(parseConnectorImport('{"url": "https://solo.dev/mcp"}').connectors[0]).toMatchObject({ name: 'Connector', url: 'https://solo.dev/mcp' });
    expect(parseConnectorImport('claude_desktop_config.json: {"mcpServers": {"x": {"command": "x"}}}').connectors).toHaveLength(1);
  });

  it('says what it couldn’t read, in words', () => {
    expect(parseConnectorImport('not json').problems[0]).toContain("isn't JSON");
    expect(parseConnectorImport('[1]').problems[0]).toContain('JSON object');
    expect(parseConnectorImport('{"mcpServers": {"bad": {"args": []}, "worse": 3, "ok": {"command": "x"}}}')).toMatchObject({
      connectors: [{ name: 'ok' }], problems: ['“bad” has neither a command nor an address.', '“worse” isn\'t a server entry.'],
    });
    expect(parseConnectorImport('{"mcpServers": {}}').problems).toEqual(['No servers in it.']);
  });

  it('every imported entry is a valid save', () => {
    const r = parseConnectorImport(JSON.stringify({ mcpServers: { a: { command: 'npx', args: ['-y', 'x'], env: { A_B: '1' } }, b: { url: 'https://b.dev/sse', headers: { 'X-Key': 'k' } } } }));
    for (const c of r.connectors) expect(() => Methods['connectors.save'].params.parse(c)).not.toThrow();
    expect(() => Methods['connectors.save'].params.parse({ name: 'x', transport: 'stdio', env: [{ name: 'BAD NAME', value: '1' }] })).toThrow();
    expect(() => Methods['connectors.save'].params.parse({ name: 'x', transport: 'http', headers: [{ name: 'Bad Header', value: '1' }] })).toThrow();
  });
});
