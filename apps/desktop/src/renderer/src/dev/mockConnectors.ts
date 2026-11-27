/**
 * Dev-only: custom connectors (Settings › Apps) in the mock gateway. `?connectors=1` starts with four: a local server
 * that is connected (one tool switched off), a remote one kept to Appu, one waiting for a sign-in and one that can't
 * be reached. A remote one added here connects unless its address has "down" in it.
 */
import type { Connector } from '@appubot/protocol';
import type { MockGateway } from './MockGateway';
import type { Handlers } from './mockHandlers';
import { IDS, ago, DAY } from './mockIds';

const tool = (name: string, description: string, on = true) => ({ name, description, on });

const EVERYTHING = [
  tool('echo', 'Echoes back the input'),
  tool('add', 'Adds two numbers'),
  tool('longRunningOperation', 'Demonstrates a long running operation with progress updates'),
  tool('printEnv', 'Prints all environment variables, helpful for debugging MCP server configuration', false),
  tool('sampleLLM', 'Samples from an LLM using MCP’s sampling feature'),
  tool('getTinyImage', 'Returns the MCP_TINY_IMAGE'),
  tool('annotatedMessage', 'Demonstrates how annotations can be used to provide metadata about content'),
  tool('getResourceReference', 'Returns a resource reference that can be used by MCP clients'),
];

function seed(): Connector[] {
  if (typeof location === 'undefined' || !new URLSearchParams(location.search).has('connectors')) return [];
  return [
    { id: 'con_everything', name: 'Everything', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], headers: [], env: [{ name: 'LOG_LEVEL', saved: true }], bots: 'all', status: 'connected', server: { name: 'example-servers/everything', version: '1.0.0' }, tools: EVERYTHING, createdAt: ago(3 * DAY) },
    { id: 'con_docs', name: 'Docs search', transport: 'http', url: 'https://docs.example.dev/mcp', args: [], headers: [{ name: 'Authorization', saved: true }], env: [], bots: [IDS.appu], status: 'connected', server: { name: 'docs-search', version: '2.3.1' }, tools: [tool('search_docs', 'Search the documentation for a phrase'), tool('fetch_page', 'Read one page of the docs as Markdown'), tool('list_sections', 'The documentation’s table of contents')], createdAt: ago(2 * DAY) },
    { id: 'con_tracker', name: 'Issue tracker', transport: 'sse', url: 'https://mcp.tracker.example/sse', args: [], headers: [], env: [], bots: 'all', status: 'signIn', signedIn: false, tools: [], createdAt: ago(DAY) },
    { id: 'con_home', name: 'Home server', transport: 'http', url: 'http://homeserver.local:8123/mcp', args: [], headers: [{ name: 'X-Api-Key', saved: true }], env: [], bots: 'all', status: 'error', error: 'Nothing answered at homeserver.local:8123.', tools: [], createdAt: ago(DAY / 2) },
  ];
}

const AGENT_TOOLS = ['agent.connectors.tools', 'agent.connectors.call'] as const;
type Names = 'connectors.list' | 'connectors.save' | 'connectors.remove' | 'connectors.check' | 'connectors.setTool' | 'connectors.setBots' | 'connectors.signIn' | 'connectors.signOut' | typeof AGENT_TOOLS[number];

export function createConnectorHandlers(g: MockGateway): Pick<Handlers, Names> {
  let list = seed();
  const emit = () => g.emit('connectors.updated', { connectors: list });
  const put = (c: Connector) => { list = list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [...list, c]; emit(); return c; };
  const find = (id: string) => {
    const c = list.find((x) => x.id === id);
    if (!c) throw new Error(`Connector not found: ${id}`);
    return c;
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    'connectors.list': () => ({ connectors: list, encrypted: true }),
    'connectors.save': async (p) => {
      const prev = p.id ? find(p.id) : undefined;
      const remote = p.transport !== 'stdio';
      const down = remote && /down/.test(p.url ?? '');
      const c: Connector = {
        id: prev?.id ?? `con_${Date.now().toString(36)}`, name: p.name, transport: p.transport, ...(remote ? { url: p.url } : { command: p.command }), args: remote ? [] : p.args ?? [],
        headers: (p.headers ?? []).map((h) => ({ name: h.name, saved: h.value === undefined ? !!prev?.headers.find((x) => x.name === h.name)?.saved : !!h.value })),
        env: (p.env ?? []).map((v) => ({ name: v.name, saved: v.value === undefined ? !!prev?.env.find((x) => x.name === v.name)?.saved : !!v.value })),
        bots: p.bots ?? prev?.bots ?? 'all', status: 'connecting', tools: prev?.tools ?? [], createdAt: prev?.createdAt ?? Date.now(),
      };
      put(c);
      await wait(700);
      return put(down
        ? { ...c, status: 'error', error: `Nothing answered at ${new URL(p.url!).host}.` }
        : { ...c, status: 'connected', server: { name: remote ? 'remote-server' : 'local-server', version: '1.0.0' }, tools: c.tools.length ? c.tools : EVERYTHING.slice(0, 5).map((t) => ({ ...t, on: true })) });
    },
    'connectors.remove': (p) => { list = list.filter((c) => c.id !== p.id); emit(); return { ok: true as const }; },
    'connectors.check': async (p) => { const c = find(p.id); put({ ...c, status: 'connecting' }); await wait(600); return put(c.status === 'error' ? c : { ...c, status: c.status === 'signIn' ? 'signIn' : 'connected' }); },
    'connectors.setTool': (p) => { const c = find(p.id); return put({ ...c, tools: c.tools.map((t) => (t.name === p.tool ? { ...t, on: p.on } : t)) }); },
    'connectors.setBots': (p) => put({ ...find(p.id), bots: p.bots }),
    'connectors.signIn': async (p) => {
      const c = find(p.id);
      setTimeout(() => put({ ...c, status: 'connected', signedIn: true, account: 'sarthak@example.com', server: { name: 'tracker', version: '4.2.0' }, tools: [tool('search_issues', 'Find issues by text, label or person'), tool('create_issue', 'Open a new issue'), tool('update_issue', 'Change an issue’s state, owner or labels')] }), 900);
      return { redirectUrl: 'https://mcp.tracker.example/authorize' };
    },
    'connectors.signOut': (p) => put({ ...find(p.id), status: 'signIn', signedIn: false }),
    'agent.connectors.tools': () => ({ tools: [] }),
    'agent.connectors.call': () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
  };
}
