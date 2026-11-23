/** `CloudApi.overview`: one request where the backend has `/v1/overview`; the parts, once it said 404, for an older one. */
import { describe, expect, it } from 'vitest';
import { CloudApi } from './cloudApi';

const account = { id: 'acc_1', email: 'you@example.com', createdAt: 1, signupsOpen: true, emailVerified: true, teams: [{ id: 'team_1', name: 'Acme', role: 'admin', members: 1 }] };
const computer = { state: 'running', noticeSeq: 0 };
const team = { id: 'team_1', name: 'Acme', role: 'admin', members: 1, used: 1, minMembers: 2, maxMembers: 5, people: [], canManage: true };

function backend(withOverview: boolean) {
  const paths: string[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname.replace(/^\/v1/, '');
    paths.push(path);
    if (path === '/overview') return withOverview ? json(200, { account, computer, teams: [{ team, computer }] }) : json(404, { error: { code: 'not_found', message: 'No such route.' } });
    if (path === '/account') return json(200, account);
    if (path === '/computer' || path === '/teams/team_1/computer') return json(200, computer);
    if (path === '/teams/team_1') return json(200, team);
    return json(404, { error: { code: 'not_found', message: 'No such route.' } });
  }) as typeof globalThis.fetch;
  return { paths, api: new CloudApi({ baseUrl: 'https://cloud.test', token: 'cs_x', fetch }) };
}

describe('CloudApi.overview', () => {
  it('is one request on a backend that has it', async () => {
    const b = backend(true);
    expect(await b.api.overview()).toMatchObject({ account: { email: 'you@example.com' }, computer: { state: 'running' }, teams: [{ team: { name: 'Acme' }, computer: { state: 'running' } }] });
    expect(b.paths).toEqual(['/overview']);
  });

  it('reads the parts from an older backend, and stops asking for /overview', async () => {
    const b = backend(false);
    const o = await b.api.overview();
    expect(o).toMatchObject({ account: { email: 'you@example.com' }, teams: [{ team: { name: 'Acme' } }] });
    expect(o.failedTeams).toBeUndefined();
    b.paths.length = 0;
    await b.api.overview();
    expect(b.paths.sort()).toEqual(['/account', '/computer', '/teams/team_1', '/teams/team_1/computer']);
  });
});
