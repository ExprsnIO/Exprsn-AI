import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPrincipal } from '../src/http/middleware.js';
import { compareVersions, nextVersion, referenceSlug, REVIEW_WORKFLOW, reviewWorkflowGraph } from '../src/knowledge/revisions.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, type Harness } from './helpers.js';
import { client, drain, seedRetrieval } from './retrieval-seed.js';

type Client = Awaited<ReturnType<typeof client>>;
type Rev = { id: string; state: string; version: string; number: number; approvalRunId: string | null; decidedBy: { id: string; name: string } | null; reason: string | null; documentId: string | null };

describe('Knowledge references, revisions and review (migration 045)', () => {
  let h: Harness;
  let ollama: FakeOllama;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    h = await harness({ OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  /** A published base with an editor (ed), an approver (ap), a curator who manages it and a plain member. */
  async function setup() {
    await seedRetrieval(h, ollama);
    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    const ed = await client(h, 'ed', ['member']);
    const ap = await client(h, 'ap', ['member']);
    const reader = await client(h, 'rita', ['member']);
    const kb = (await curator.post('/api/knowledge/bases', { name: 'System documentation', label: 'public', embedModel: 'nomic-embed-text' }).expect(201)).body as { id: string };
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { status: 'published' }).expect(200);
    await curator.post(`/api/knowledge/bases/${kb.id}/reviewers`, { duty: 'editor', kind: 'user', id: ed.user.id }).expect(201);
    await curator.post(`/api/knowledge/bases/${kb.id}/reviewers`, { duty: 'approver', kind: 'user', id: ap.user.id }).expect(201);
    await curator.post(`/api/knowledge/bases/${kb.id}/reviewers`, { duty: 'approver', kind: 'user', id: ed.user.id }).expect(201);
    return { curator, ed, ap, reader, kb };
  }
  const propose = (c: Client, kbId: string, body: object) => c.post(`/api/knowledge/bases/${kbId}/revisions`, body);
  const search = async (c: Client, kbId: string, query: string) => ((await c.post('/api/knowledge/search', { kbIds: [kbId], query }).expect(200)).body as { hits: { document: string; text: string }[] }).hits;

  it('moves versions and spells slugs one way', () => {
    expect(nextVersion(null, 'patch')).toBe('1.0.0');
    expect(nextVersion('1.4.2', 'major')).toBe('2.0.0');
    expect(nextVersion('1.4.2', 'minor')).toBe('1.5.0');
    expect(nextVersion('1.4.2', 'patch')).toBe('1.4.3');
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(referenceSlug(' Exprsn AI / Model Registry ')).toBe('exprsn-ai/model-registry');
    expect(() => referenceSlug('///')).toThrow();
  });

  it('is seeded: the three tools', async () => {
    const rows = (await h.s.db('registry_entries').where({ impl: 'builtin' }).whereIn('name', ['knowledge_propose', 'knowledge_revisions', 'knowledge_publish']).orderBy('name')) as { name: string; side_effect: string; status: string }[];
    expect(rows.map((r) => [r.name, r.side_effect, r.status])).toEqual([
      ['knowledge_propose', 'write', 'published'],
      ['knowledge_publish', 'write', 'published'],
      ['knowledge_revisions', 'read', 'published']
    ]);
  });

  it('takes a revision from draft to published, keeps every version and serves one at a time', async () => {
    const { curator, ed, ap, reader, kb } = await setup();
    const settings = (await ed.get(`/api/knowledge/bases/${kb.id}/review`).expect(200)).body as { duties: object; editors: { name: string }[]; approvers: object[]; fourEyes: boolean };
    expect(settings.duties).toEqual({ manage: false, edit: true, approve: true });
    expect(settings.approvers).toHaveLength(2);
    expect(settings.fourEyes).toBe(true);

    // Someone who is not an editor proposes nothing.
    await propose(reader, kb.id, { reference: 'exprsn-ai/overview', title: 'Overview', content: '# Overview\n\nx', summary: 'First' }).expect(403);
    const draft = (await propose(ed, kb.id, { reference: 'Exprsn AI/Overview', title: 'Exprsn AI: Overview', content: '# Overview\n\nThe gateway routes zebra requests to pools.', summary: 'Baseline', categories: ['Reference/System'] }).expect(201)).body as Rev;
    expect(draft).toMatchObject({ state: 'draft', version: '1.0.0', number: 1 });
    // One open revision per reference.
    await propose(ed, kb.id, { reference: 'exprsn-ai/overview', content: '# Other', summary: 'Second' }).expect(409);
    await ed.patch(`/api/knowledge/revisions/${draft.id}`, { summary: 'Baseline of the overview' }).expect(200);
    expect(((await ed.post(`/api/knowledge/revisions/${draft.id}/submit`).expect(200)).body as Rev).state).toBe('in-review');
    await ed.patch(`/api/knowledge/revisions/${draft.id}`, { summary: 'late' }).expect(409);

    // A reader sees nothing of a reference that was never published; the approver has it waiting.
    expect((await reader.get(`/api/knowledge/bases/${kb.id}/references`).expect(200)).body).toEqual([]);
    await reader.get(`/api/knowledge/revisions/${draft.id}`).expect(404);
    const waiting = (await ap.get('/api/knowledge/reviews').expect(200)).body as { waiting: { id: string; mayDecide: boolean }[] };
    expect(waiting.waiting.map((w) => [w.id, w.mayDecide])).toEqual([[draft.id, true]]);
    // Four eyes: the author is an approver of the base and still does not approve their own revision.
    expect(((await ed.get('/api/knowledge/reviews').expect(200)).body as { waiting: { mayDecide: boolean }[] }).waiting[0]!.mayDecide).toBe(false);
    await ed.post(`/api/knowledge/revisions/${draft.id}/decision`, { decision: 'approve' }).expect(403);
    await reader.post(`/api/knowledge/revisions/${draft.id}/decision`, { decision: 'approve' }).expect(403);
    await ap.post(`/api/knowledge/revisions/${draft.id}/decision`, { decision: 'reject' }).expect(400);

    expect(((await ap.post(`/api/knowledge/revisions/${draft.id}/decision`, { decision: 'approve', reason: 'Reads well' }).expect(200)).body as Rev).state).toBe('approved');
    await drain(h);
    const refs = (await reader.get(`/api/knowledge/bases/${kb.id}/references`).expect(200)).body as { id: string; slug: string; version: string; state: string; categories: string[]; documentId: string }[];
    expect(refs).toMatchObject([{ slug: 'exprsn-ai/overview', version: '1.0.0', state: 'published', categories: ['reference/system'] }]);
    const hits = await search(reader, kb.id, 'zebra requests');
    expect(hits[0]!.document).toBe('Exprsn AI: Overview.md');
    expect(hits.map((x) => x.text).join(' ')).toContain('version 1.0.0');

    // A second revision: a minor change, rejected once, then corrected and approved.
    await propose(ed, kb.id, { reference: 'exprsn-ai/overview', content: '# Overview\n\nThe gateway routes zebra requests to pools.', summary: 'Nothing' }).expect(409);
    const r2 = (await propose(ed, kb.id, { reference: 'exprsn-ai/overview', content: '# Overview\n\nThe gateway routes quokka requests to pools.', summary: 'Wrong animal', submit: true }).expect(201)).body as Rev;
    expect(r2).toMatchObject({ state: 'in-review', version: '1.1.0', number: 2 });
    expect(((await ap.post(`/api/knowledge/revisions/${r2.id}/decision`, { decision: 'reject', reason: 'Say which pools' }).expect(200)).body as Rev).state).toBe('rejected');
    const r3 = (await propose(ed, kb.id, { reference: 'exprsn-ai/overview', content: '# Overview\n\nThe gateway routes quokka requests to GPU pools.', summary: 'Names the pools', feature: 'GPU pools', bump: 'patch', submit: true }).expect(201)).body as Rev;
    expect(r3).toMatchObject({ version: '1.0.1', number: 3 });
    const shown = (await ap.get(`/api/knowledge/revisions/${r3.id}`).expect(200)).body as { diff: { against: string; added: number; removed: number; text: string }; content: string; mayDecide: boolean };
    expect(shown.diff).toMatchObject({ against: '1.0.0', added: 1, removed: 1 });
    expect(shown.diff.text).toContain('+The gateway routes quokka requests to GPU pools.');
    await ap.post(`/api/knowledge/revisions/${r3.id}/decision`, { decision: 'approve' }).expect(200);
    // Until the new version is indexed, the published one answers.
    expect((await search(reader, kb.id, 'zebra requests'))[0]!.text).toContain('zebra');
    await drain(h);

    const ref = (await reader.get(`/api/knowledge/references/${refs[0]!.id}`).expect(200)).body as { version: string; documentId: string; history: Rev[] };
    expect(ref.version).toBe('1.0.1');
    expect(ref.documentId).not.toBe(refs[0]!.documentId);
    // A reader sees the published line; the editor also the rejected one.
    expect(ref.history.map((v) => [v.number, v.version, v.state])).toEqual([[3, '1.0.1', 'published'], [1, '1.0.0', 'superseded']]);
    const all = (await ed.get(`/api/knowledge/references/${refs[0]!.id}`).expect(200)).body as { history: Rev[] };
    expect(all.history.map((v) => [v.number, v.state, v.reason])).toEqual([[3, 'published', null], [2, 'rejected', 'Say which pools'], [1, 'superseded', 'Reads well']]);
    expect(all.history[0]!.decidedBy!.id).toBe(ap.user.id);
    // The old version is kept as a revision and gone from search; one document serves the reference.
    expect(((await reader.get(`/api/knowledge/revisions/${draft.id}`).expect(200)).body as { content: string }).content).toContain('zebra');
    const after = await search(reader, kb.id, 'quokka requests GPU pools');
    expect(after.map((x) => x.text).join(' ')).toContain('version 1.0.1');
    expect(after.map((x) => x.text).join(' ')).not.toContain('zebra');
    expect(((await curator.get(`/api/knowledge/bases/${kb.id}/documents`).expect(200)).body as object[]).length).toBe(1);

    const actions = ((await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'like', 'knowledge.revision.%').select('action')) as { action: string }[]).map((a) => a.action);
    for (const a of ['proposed', 'edited', 'submitted', 'approved', 'published', 'rejected']) expect(actions).toContain(`knowledge.revision.${a}`);
  });

  it('refuses uploads that go around review, and lets an author withdraw', async () => {
    const { curator, ed, kb } = await setup();
    await curator.patch(`/api/knowledge/bases/${kb.id}/review`, { review: 'required' }).expect(200);
    await ed.patch(`/api/knowledge/bases/${kb.id}/review`, { review: 'off' }).expect(403);
    const up = await curator.agent.put(`/api/knowledge/bases/${kb.id}/uploads?name=x.md&label=public`).set('x-csrf-token', curator.csrf).set('content-type', 'application/octet-stream').send(Buffer.from('# x'));
    expect(up.status).toBe(409);
    expect(String((up.body as { detail: string }).detail)).toContain('through review');
    const d = (await propose(ed, kb.id, { title: 'Scratch note', content: '# Scratch', summary: 'Try', submit: true }).expect(201)).body as Rev;
    expect(((await ed.post(`/api/knowledge/revisions/${d.id}/withdraw`).expect(200)).body as Rev).state).toBe('withdrawn');
    // The reference had nothing else: it is gone, and its slug is free again.
    expect((await ed.get(`/api/knowledge/bases/${kb.id}/references`).expect(200)).body).toEqual([]);
  });

  it('decides through the review workflow, for a submitted revision and for a proposal another workflow sends', async () => {
    const { curator, ed, ap, reader, kb } = await setup();
    const base = (await loadPrincipal(h.s, h.tenantId, curator.user.id, {}))!;
    const cp = { ...base, roles: [...base.roles, 'workflow-admin'], mfa: true };
    const w = await h.s.workflows.create(cp, { name: REVIEW_WORKFLOW.name, description: REVIEW_WORKFLOW.description, label: 'public', graph: reviewWorkflowGraph('member') as never });
    await h.s.workflows.publish(cp, w.id, null);
    const set = (await curator.patch(`/api/knowledge/bases/${kb.id}/review`, { workflowId: w.id }).expect(200)).body as { workflow: { name: string; published: boolean } };
    expect(set.workflow).toMatchObject({ name: 'knowledge-approval', published: true });

    // 1. A submitted revision starts a run; the approver decides in Knowledge, on the run's approval step.
    const r1 = (await propose(ed, kb.id, { reference: 'platform/modules/auth', title: 'Auth module', content: '# Auth\n\nThe auth module issues okapi tokens.', summary: 'Baseline', submit: true }).expect(201)).body as Rev;
    expect(r1.state).toBe('in-review');
    expect(r1.approvalRunId).toBeTruthy();
    await drain(h);
    expect(((await h.s.db('workflow_runs').where({ id: r1.approvalRunId }).first('state', 'caller_kind')) as { state: string; caller_kind: string })).toMatchObject({ state: 'waiting', caller_kind: 'knowledge-revision' });
    await ed.post(`/api/knowledge/revisions/${r1.id}/decision`, { decision: 'approve' }).expect(403);
    expect(((await ap.post(`/api/knowledge/revisions/${r1.id}/decision`, { decision: 'approve' }).expect(200)).body as { settling: boolean }).settling).toBe(true);
    await drain(h);
    const done = (await ed.get(`/api/knowledge/revisions/${r1.id}`).expect(200)).body as Rev;
    expect(done).toMatchObject({ state: 'published', version: '1.0.0' });
    expect(done.decidedBy!.id).toBe(ap.user.id);
    expect(((await h.s.db('workflow_runs').where({ id: r1.approvalRunId }).first('state')) as { state: string }).state).toBe('succeeded');
    expect((await search(reader, kb.id, 'okapi tokens'))[0]!.document).toBe('Auth module.md');

    // 2. Rejected in the run: the revision is rejected with the reason, and what is published stays.
    const r2 = (await propose(ed, kb.id, { reference: 'platform/modules/auth', content: '# Auth\n\nThe auth module issues tapir tokens.', summary: 'Tapir', submit: true }).expect(201)).body as Rev;
    await drain(h);
    await ap.post(`/api/knowledge/revisions/${r2.id}/decision`, { decision: 'reject', reason: 'It is okapi' }).expect(200);
    await drain(h);
    expect((await ed.get(`/api/knowledge/revisions/${r2.id}`).expect(200)).body).toMatchObject({ state: 'rejected', reason: 'It is okapi' });

    // 3. A whole proposal sent to the workflow (as a sub-workflow or the tool knowledge_approval would): the run's
    //    owner is the author, and the approval of someone who may not approve in the base publishes nothing.
    const ep = (await loadPrincipal(h.s, h.tenantId, ed.user.id, {}))!;
    const run = await h.s.workflows.start(ep, w.id, { input: { kbId: kb.id, reference: 'platform/modules/vault', title: 'Vault module', content: '# Vault\n\nThe vault leases numbat secrets.', summary: 'Baseline', bump: 'major' }, dry: false });
    await drain(h);
    const pending = async (runId: string) => ((await h.s.db('workflow_approvals').where({ run_id: runId, state: 'pending' }).first('id')) as { id: string }).id;
    const rp = (await loadPrincipal(h.s, h.tenantId, reader.user.id, {}))!;
    await h.s.workflows.decide(rp, await pending(run.id), { decision: 'approve' });
    await drain(h);
    expect(((await h.s.db('workflow_runs').where({ id: run.id }).first('state')) as { state: string }).state).toBe('failed');
    expect((await ed.get(`/api/knowledge/bases/${kb.id}/references`).expect(200)).body).toHaveLength(1);

    const run2 = await h.s.workflows.start(ep, w.id, { input: { kbId: kb.id, reference: 'platform/modules/vault', title: 'Vault module', content: '# Vault\n\nThe vault leases numbat secrets.', summary: 'Baseline', bump: 'major' }, dry: false });
    await drain(h);
    const app = (await loadPrincipal(h.s, h.tenantId, ap.user.id, {}))!;
    await h.s.workflows.decide(app, await pending(run2.id), { decision: 'approve' });
    await drain(h);
    expect(((await h.s.db('workflow_runs').where({ id: run2.id }).first('state')) as { state: string }).state).toBe('succeeded');
    const refs = (await reader.get(`/api/knowledge/bases/${kb.id}/references`).expect(200)).body as { slug: string; version: string; state: string }[];
    expect(refs.map((r) => [r.slug, r.version, r.state])).toEqual([['platform/modules/auth', '1.0.0', 'published'], ['platform/modules/vault', '1.0.0', 'published']]);
    expect((await search(reader, kb.id, 'numbat secrets'))[0]!.document).toBe('Vault module.md');
  });

  it('proposes and reads through the built-in tools', async () => {
    const { ed, ap, reader, kb } = await setup();
    const call = async (c: Client, name: string, args: Record<string, unknown>) => {
      const p = (await loadPrincipal(h.s, h.tenantId, c.user.id, {}))!;
      const { tools } = await h.s.tools.resolve(p, [name], 'public');
      return h.s.tools.call({ principal: p, label: 'public', approved: true, source: { kind: 'agent-run', id: 'R1' } }, tools[0]!, args);
    };
    const out = (await call(ed, 'knowledge_propose', { kbId: kb.id, reference: 'guides/tools', title: 'Tools guide', content: '# Tools\n\nTools are called through one dispatcher.', summary: 'Baseline', feature: 'Registry' })) as { result: { revision: string; state: string; version: string } };
    expect(out.result).toMatchObject({ state: 'in-review', version: '1.0.0' });
    // Outside a workflow step nothing is published by a tool.
    expect(JSON.stringify(await call(ed, 'knowledge_publish', { revisionId: out.result.revision }))).toContain('knowledge_propose');
    expect(JSON.stringify(await call(reader, 'knowledge_propose', { kbId: kb.id, title: 'No', content: 'x', summary: 'y' }))).toContain('editor');
    await ap.post(`/api/knowledge/revisions/${out.result.revision}/decision`, { decision: 'approve' }).expect(200);
    await drain(h);
    const list = (await call(reader, 'knowledge_revisions', { kbId: kb.id })) as { result: { references: { slug: string; version: string }[] } };
    expect(list.result.references).toMatchObject([{ slug: 'guides/tools', version: '1.0.0' }]);
    const one = (await call(reader, 'knowledge_revisions', { kbId: kb.id, reference: 'guides/tools' })) as { result: { history: { version: string; state: string; summary: string; feature: string }[] } };
    expect(one.result.history).toMatchObject([{ version: '1.0.0', state: 'published', summary: 'Baseline', feature: 'Registry' }]);
    const text = (await call(reader, 'knowledge_revisions', { revisionId: out.result.revision, content: true })) as { result: { content: string } };
    expect(text.result.content).toContain('one dispatcher');
  });
});
