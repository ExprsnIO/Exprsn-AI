import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.9.0, Sprint 53 (B-174 to B-176): what the governance suites share. Migrations 133 and 134 are applied here until
 * they are registered in migrations/index.ts (each table is created only when missing).
 */

export type Person = Awaited<ReturnType<typeof personIn>>;

export async function install(h: Harness): Promise<void> {
  if (!(await h.s.db.schema.hasTable('group_proposals'))) await (await import('../src/db/migrations/133_group_proposals.js')).up(h.s.db);
  if (!(await h.s.db.schema.hasTable('group_ballots'))) await (await import('../src/db/migrations/134_group_votes.js')).up(h.s.db);
  h.s.groupGovernance.resetSchemaCache();
}

export async function personIn(h: Harness, name: string, workspaces: string[], roles: string[] = ['member'], clearance: 'internal' | 'confidential' = 'internal') {
  const user = await localUser(h, name, roles, clearance);
  for (const w of workspaces) await h.s.tenants.addMember(w, user.id);
  const c: Client = roles.some((r) => r !== 'member') ? await loginAdmin(h, name) : await login(h, name);
  const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
  return { user, ...c, post: (p: string, b?: object) => send('post', p, b), put: (p: string, b?: object) => send('put', p, b), patch: (p: string, b?: object) => send('patch', p, b), del: (p: string) => send('delete', p), get: (p: string) => c.agent.get(p) };
}

export interface World {
  h: Harness;
  ws: string;
  alice: Person;
  bob: Person;
  carol: Person;
  dave: Person;
  erin: Person;
}

/** A tenant with a workspace and five people: Alice will own groups, the others join them. */
export async function world(): Promise<World> {
  const h = await harness();
  await install(h);
  const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Commons', 'confidential')).id;
  const [alice, bob, carol, dave, erin] = [await personIn(h, 'alice', [ws]), await personIn(h, 'bob', [ws]), await personIn(h, 'carol', [ws]), await personIn(h, 'dave', [ws]), await personIn(h, 'erin', [ws])];
  return { h, ws, alice, bob, carol, dave, erin };
}

/** Alice owns an open public group; the people named join it. */
export async function club(w: World, members: Person[], name = 'Garden club'): Promise<{ id: string }> {
  const g = (await w.alice.post('/api/groups', { workspaceId: w.ws, name, joinMode: 'open', visibility: 'public' }).expect(201)).body as { id: string };
  for (const x of members) await x.post(`/api/groups/${g.id}/join`).expect(200);
  return g;
}

/** Ends a proposal's voting time now (the next read or tick closes it). */
export async function expire(h: Harness, proposalId: string): Promise<void> {
  await h.s.db('group_proposals').where({ id: proposalId }).update({ closes_at: Date.now() - 1 });
}

export const audits = async (h: Harness, action: string) => ((await h.s.db('audit_events').where({ tenant_id: h.tenantId, action }).orderBy('seq')) as { detail: string | null; target: string | null; actor: string }[]).map((r) => ({ detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null, target: r.target ? (JSON.parse(r.target) as Record<string, unknown>) : null, actor: JSON.parse(r.actor) as Record<string, unknown> }));
