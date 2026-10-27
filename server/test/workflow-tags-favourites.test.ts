import type request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.8.0, Sprint 47 (B-137): workflow tags and favourites (migration 097_designer_editing), and step comments.
 *
 * Tags are the tenant's, set by workflow admins and audited; the list carries them and filters by one; the vocabulary
 * offered is what the caller may see (a tag only a confidential workflow carries is not offered below that).
 * Favourites are per person. Both go with their workflow. Step comments are kept in the draft graph, stamped with the
 * saver by the server, never change validation, and are carried by published versions and bundles.
 */

type Api = Client & { post: (p: string, b?: object) => request.Test; put: (p: string, b?: object) => request.Test; del: (p: string) => request.Test; get: (p: string) => request.Test };
const graph = { nodes: [{ id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 20, config: { source: 'manual' } }], edges: [], limits: {} };

describe('workflow tags, favourites and step comments (B-137)', () => {
  let h: Harness;
  let wsId: string;
  let wren: Api;
  let tia: Api;
  let lou: Api;

  const api = (c: Client): Api => {
    const send = (method: 'post' | 'put', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    return { ...c, post: (p, b) => send('post', p, b), put: (p, b) => send('put', p, b), del: (p) => c.agent.delete(p).set('x-csrf-token', c.csrf), get: (p) => c.agent.get(p) };
  };

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Ops', 'confidential')).id;
    for (const [u, roles, c] of [['wren', ['workflow-admin', 'member'], 'confidential'], ['tia', ['workflow-admin', 'member'], 'confidential'], ['lou', ['member'], 'internal']] as const) await h.s.tenants.addMember(wsId, (await localUser(h, u, [...roles], c)).id);
    wren = api(await loginAdmin(h, 'wren'));
    tia = api(await loginAdmin(h, 'tia'));
    const l = await login(h, 'lou');
    lou = api({ agent: l.agent, csrf: l.csrf, cookie: l.cookie });
    for (const c of [wren, tia, lou]) await c.put('/api/me/workspace', { workspaceId: wsId }).expect(200);
  });
  afterEach(async () => {
    await h.close();
  });

  const workflow = async (name: string, label = 'internal') => (await wren.post('/api/workflows', { name, label, graph }).expect(201)).body as { id: string; draftRev: number };

  it('tags: set by workflow admins, audited, carried by the list, filtered, and offered within clearance', async () => {
    const a = await workflow('expenses');
    const b = await workflow('payroll', 'confidential');
    expect((await wren.put(`/api/workflows/${a.id}/tags`, { tags: ['Finance', 'monthly', 'finance'] }).expect(200)).body.tags).toEqual(['finance', 'monthly']);
    await wren.put(`/api/workflows/${b.id}/tags`, { tags: ['finance', 'board-only'] }).expect(200);
    await wren.put(`/api/workflows/${a.id}/tags`, { tags: ['not a tag'] }).expect(400);
    await wren.put(`/api/workflows/${a.id}/tags`, { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }).expect(400);
    await lou.put(`/api/workflows/${a.id}/tags`, { tags: ['mine'] }).expect(403);

    const audit = (await h.s.db('audit_events').where({ action: 'workflow.tags.updated' }).orderBy('seq')) as { detail: string }[];
    expect(JSON.parse(audit[0]!.detail)).toMatchObject({ added: ['finance', 'monthly'], removed: [] });
    // No change, no entry.
    await wren.put(`/api/workflows/${a.id}/tags`, { tags: ['monthly', 'finance'] }).expect(200);
    expect(await h.s.db('audit_events').where({ action: 'workflow.tags.updated' })).toHaveLength(2);

    const list = (await wren.get('/api/workflows').expect(200)).body as { name: string; tags: string[]; favourite: boolean }[];
    expect(list.find((w) => w.name === 'expenses')).toMatchObject({ tags: ['finance', 'monthly'], favourite: false });
    expect(((await wren.get('/api/workflows?tag=monthly').expect(200)).body as { name: string }[]).map((w) => w.name)).toEqual(['expenses']);
    expect(((await wren.get('/api/workflows?tag=finance').expect(200)).body as { name: string }[]).map((w) => w.name).sort()).toEqual(['expenses', 'payroll']);
    expect((await wren.get('/api/workflow-tags').expect(200)).body.tags).toEqual([{ tag: 'board-only', count: 1 }, { tag: 'finance', count: 2 }, { tag: 'monthly', count: 1 }]);
    // lou (internal) never sees the confidential workflow's tags.
    expect((await lou.get('/api/workflow-tags').expect(200)).body.tags).toEqual([{ tag: 'finance', count: 1 }, { tag: 'monthly', count: 1 }]);
    expect(((await lou.get('/api/workflows?tag=board-only').expect(200)).body as unknown[]).length).toBe(0);
    await lou.put(`/api/workflows/${b.id}/favourite`, {}).expect(404);
    expect((await wren.get(`/api/workflows/${a.id}`).expect(200)).body.tags).toEqual(['finance', 'monthly']);
  });

  it('favourites are per person, audited, filtered, and go with the workflow', async () => {
    const a = await workflow('expenses');
    await workflow('payroll');
    expect((await lou.put(`/api/workflows/${a.id}/favourite`, {}).expect(200)).body.favourite).toBe(true);
    await lou.put(`/api/workflows/${a.id}/favourite`, {}).expect(200);
    expect(await h.s.db('audit_events').where({ action: 'workflow.favourite.added' })).toHaveLength(1);
    expect(((await lou.get('/api/workflows?favourites=true').expect(200)).body as { name: string; favourite: boolean }[]).map((w) => [w.name, w.favourite])).toEqual([['expenses', true]]);
    // Nobody else's list shows lou's star.
    expect(((await tia.get('/api/workflows').expect(200)).body as { favourite: boolean }[]).every((w) => !w.favourite)).toBe(true);
    expect(((await tia.get('/api/workflows?favourites=true').expect(200)).body as unknown[]).length).toBe(0);
    await lou.del(`/api/workflows/${a.id}/favourite`).expect(204);
    expect(await h.s.db('audit_events').where({ action: 'workflow.favourite.removed' })).toHaveLength(1);
    expect(((await lou.get('/api/workflows?favourites=true').expect(200)).body as unknown[]).length).toBe(0);

    await tia.put(`/api/workflows/${a.id}/favourite`, {}).expect(200);
    await wren.put(`/api/workflows/${a.id}/tags`, { tags: ['finance'] }).expect(200);
    await wren.del(`/api/workflows/${a.id}`).expect(204);
    expect(await h.s.db('workflow_tags').where({ workflow_id: a.id })).toHaveLength(0);
    expect(await h.s.db('workflow_favourites').where({ workflow_id: a.id })).toHaveLength(0);
  });

  it('step comments: stamped by the server, no effect on validation, carried by versions and bundles', async () => {
    const w = await workflow('notes');
    const g = { ...graph, nodes: [{ ...graph.nodes[0]!, comments: [{ id: 'c1', text: 'Check with finance before changing the trigger.', by: 'SOMEONE-ELSE', byName: 'Not me', at: 1 }] }] };
    const before = (await wren.get(`/api/workflows/${w.id}`).expect(200)).body.validation;
    const saved = (await wren.put(`/api/workflows/${w.id}/draft`, { graph: g, rev: w.draftRev }).expect(200)).body;
    const c = saved.draft.nodes[0].comments[0];
    expect(c).toMatchObject({ id: 'c1', text: 'Check with finance before changing the trigger.', byName: 'WREN' });
    expect(c.by).not.toBe('SOMEONE-ELSE');
    expect(c.at).toBeGreaterThan(1);
    expect(saved.validation).toEqual(before);

    // tia edits the text and adds a reply: the first keeps wren as its author, the new one is tia's.
    const g2 = { ...g, nodes: [{ ...graph.nodes[0]!, comments: [{ ...c, text: 'Checked with finance.', byName: 'TIA' }, { id: 'c2', text: 'Done.' }] }] };
    const s2 = (await tia.put(`/api/workflows/${w.id}/draft`, { graph: g2, rev: saved.draftRev }).expect(200)).body;
    expect(s2.draft.nodes[0].comments).toEqual([expect.objectContaining({ id: 'c1', text: 'Checked with finance.', byName: 'WREN', at: c.at }), expect.objectContaining({ id: 'c2', byName: 'TIA' })]);
    await tia.put(`/api/workflows/${w.id}/draft`, { graph: { ...g, nodes: [{ ...graph.nodes[0]!, comments: [{ id: 'x', text: '' }] }] }, rev: s2.draftRev }).expect(400);

    const pub = (await wren.post(`/api/workflows/${w.id}/publish`, { note: null }).expect(200)).body;
    expect(pub.workflow.versions[0].graph.nodes[0].comments).toHaveLength(2);
    const bundle = (await wren.get(`/api/workflows/${w.id}/bundle`).expect(200)).body;
    expect(JSON.stringify(bundle)).toContain('Checked with finance.');
    // A run of the version is unaffected (the trigger passes its input through).
    const run = (await wren.post(`/api/workflows/${w.id}/runs`, { input: {} }).expect(202)).body;
    expect(run.state).toBeTruthy();
  });
});
