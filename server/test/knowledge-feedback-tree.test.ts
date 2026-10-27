import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evalCase, evalSetBody } from '../src/evals/service.js';
import { linkedSlugs } from '../src/knowledge/tree.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';
import { client, drain, seedRetrieval } from './retrieval-seed.js';

/*
 * 1.8.0, Sprint 48 (B-149): "was this helpful" feedback on knowledge documents, references and chat citations (with
 * the user-input guardrail and sealed comments), the stats and curation list for editors and curators, the eval seed,
 * and the reference tree with backlinks computed on publish, never showing a page the reader cannot read.
 */

type Client = Awaited<ReturnType<typeof client>>;

describe('Knowledge feedback and the reference tree (Sprint 48, B-149)', () => {
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

  /** A published base; the curator, an editor (ed, also an approver), an approver and two readers. */
  async function setup() {
    await seedRetrieval(h, ollama);
    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    const ed = await client(h, 'ed', ['member'], 'confidential');
    const ap = await client(h, 'ap', ['member'], 'confidential');
    const reader = await client(h, 'rita', ['member'], 'internal');
    const other = await client(h, 'otto', ['member'], 'internal');
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Handbook', label: 'public', embedModel: 'nomic-embed-text' }).expect(201)).body as { id: string };
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { status: 'published' }).expect(200);
    await curator.post(`/api/knowledge/bases/${kb.id}/reviewers`, { duty: 'editor', kind: 'user', id: ed.user.id }).expect(201);
    await curator.post(`/api/knowledge/bases/${kb.id}/reviewers`, { duty: 'approver', kind: 'user', id: ap.user.id }).expect(201);
    return { curator, ed, ap, reader, other, kb };
  }

  /** Proposes, approves and publishes a reference; returns its id. */
  async function publish(ed: Client, ap: Client, kbId: string, slug: string, title: string, content: string, label?: string): Promise<string> {
    const rev = (await ed.post(`/api/knowledge/bases/${kbId}/revisions`, { reference: slug, title, content, summary: 'First', submit: true, ...(label ? { label } : {}) }).expect(201)).body as { id: string };
    await ap.post(`/api/knowledge/revisions/${rev.id}/decision`, { decision: 'approve' }).expect(200);
    await drain(h);
    const r = (await h.s.db('knowledge_references').where({ kb_id: kbId, slug }).first()) as { id: string; state: string };
    expect(r.state).toBe('published');
    return r.id;
  }

  it('reads links from Markdown: [[slug]] and links to bare slugs, never URLs', () => {
    expect(linkedSlugs('See [[Guide/Setup]], [[guide/install|installing]] and [[faq#top]]. Also [the API](guide/api), [same](./guide/api.md#x), [web](https://x.example/a), [mail](mailto:a@b.c), [abs](/docs/a), [anchor](#here) and [[guide/overview]].', 'guide/overview')).toEqual(['faq', 'guide/api', 'guide/install', 'guide/setup']);
    expect(linkedSlugs('no links here')).toEqual([]);
  });

  it('takes feedback with the user-input guardrail, seals comments and shows stats, curation and an eval seed to editors only', async () => {
    const { curator, ed, ap, reader, other, kb } = await setup();
    const setup1 = await publish(ed, ap, kb.id, 'guide/setup', 'Setting up', '# Setting up\n\nInstall the zebra agent on every host.');
    const ref = (await reader.get(`/api/knowledge/references/${setup1}`).expect(200)).body as { documentId: string };

    // A guardrail: gift cards are blocked, phone numbers redacted, at user-input.
    await localUser(h, 'ga', ['guardrail-admin'], 'confidential');
    const ga = await loginAdmin(h, 'ga');
    const gsend = (m: 'post' | 'put', p: string, b: object = {}) => ga.agent[m](p).set('x-csrf-token', ga.csrf).send(b);
    const set = (await gsend('post', '/api/admin/guardrails/sets', { name: 'Feedback rules', scope: 'tenant' }).expect(201)).body as { id: string };
    await gsend('put', `/api/admin/guardrails/sets/${set.id}/draft`, { rules: [
      { id: 'scam', name: 'Scam bait', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: '(?i)gift cards' }, action: 'block', stage: 'enforce' },
      { id: 'phone', name: 'Phone numbers', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: '\\d{3}-\\d{4}' }, action: 'redact', stage: 'enforce' }
    ] }).expect(200);
    await gsend('post', `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);

    const blocked = await reader.post('/api/knowledge/feedback', { target: { kind: 'reference', id: setup1 }, helpful: false, comment: 'Pay me in gift cards' }).expect(422);
    expect(blocked.body).toMatchObject({ step: 'guardrails', action: 'block', field: 'comment' });
    const given = (await reader.post('/api/knowledge/feedback', { target: { kind: 'reference', id: setup1 }, helpful: false, comment: 'Which hosts? Call 555-1234' }).expect(201)).body as { id: string; comment: string; helpful: boolean };
    expect(given.helpful).toBe(false);
    expect(given.comment).not.toContain('555-1234');
    // Sealed at rest.
    const raw = (await h.s.db('knowledge_feedback').where({ id: given.id }).first()) as { comment: string; reference_id: string; document_id: string };
    expect(raw.comment).not.toContain('Which hosts');
    expect(raw.comment).toMatch(/^v\d\./);
    expect(raw).toMatchObject({ reference_id: setup1, document_id: ref.documentId });
    // Answering again replaces the answer; the document of a reference counts as the reference.
    const again = (await reader.post('/api/knowledge/feedback', { target: { kind: 'document', id: ref.documentId }, helpful: false, comment: 'Still unclear which hosts' }).expect(201)).body as { id: string };
    expect(again.id).toBe(given.id);
    expect(((await reader.get(`/api/knowledge/feedback/mine?reference=${setup1}`).expect(200)).body as { mine: { comment: string } }).mine.comment).toBe('Still unclear which hosts');
    await other.post('/api/knowledge/feedback', { target: { kind: 'reference', id: setup1 }, helpful: false }).expect(201);
    await curator.post('/api/knowledge/feedback', { target: { kind: 'reference', id: setup1 }, helpful: true, comment: 'Clear enough' }).expect(201);

    // A chat answer (the editor's; the profile handles confidential data) citing the reference's document: feedback on its citation, with the question shared.
    const conv = (await ed.post('/api/conversations', { title: 'Setup', label: 'internal' }).expect(201)).body as { id: string };
    await ed.put(`/api/conversations/${conv.id}/knowledge`, { kbIds: [kb.id] }).expect(200);
    const sent = (await ed.post(`/api/conversations/${conv.id}/messages`, { content: 'Where do I install the zebra agent?', profile: 'general' }).expect(202)).body as { messageId: string };
    let cites: { n: number; documentId: string }[] = [];
    for (let i = 0; i < 100; i++) {
      const m = ((await ed.get(`/api/conversations/${conv.id}`)).body.messages as { id: string; state: string; citations: { n: number; documentId: string }[] }[]).find((x) => x.id === sent.messageId)!;
      if (m.state === 'complete') {
        cites = m.citations;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(cites[0]).toMatchObject({ n: 1, documentId: ref.documentId });
    await other.post('/api/knowledge/feedback', { target: { kind: 'citation', conversationId: conv.id, messageId: sent.messageId, n: 1 }, helpful: false }).expect(404);
    await ed.post('/api/knowledge/feedback', { target: { kind: 'citation', conversationId: conv.id, messageId: sent.messageId, n: 9 }, helpful: false }).expect(404);
    const cite = (await ed.post('/api/knowledge/feedback', { target: { kind: 'citation', conversationId: conv.id, messageId: sent.messageId, n: 1 }, helpful: false, comment: 'It did not name the hosts', shareQuestion: true }).expect(201)).body as { origin: string; referenceId: string };
    expect(cite).toMatchObject({ origin: 'citation', referenceId: setup1 });

    // Stats and the curation list: editors and curators only.
    await reader.get(`/api/knowledge/bases/${kb.id}/feedback`).expect(403);
    await ap.get(`/api/knowledge/bases/${kb.id}/feedback`).expect(403);
    const stats = (await ed.get(`/api/knowledge/bases/${kb.id}/feedback`).expect(200)).body as { totals: { answers: number; helpful: number; notHelpful: number }; items: { referenceId: string; up: number; down: number; helpfulness: number }[]; curation: { referenceId: string; reasons: string[] }[] };
    expect(stats.totals).toEqual({ answers: 4, helpful: 1, notHelpful: 3 });
    expect(stats.items).toMatchObject([{ referenceId: setup1, up: 1, down: 3, helpfulness: 0.25 }]);
    expect(stats.curation).toMatchObject([{ referenceId: setup1, reasons: ['low helpfulness', 'recent negative comment'] }]);
    const comments = (await curator.get(`/api/knowledge/bases/${kb.id}/feedback/comments?reference=${setup1}`).expect(200)).body as { comments: { comment: string | null; by: string; helpful: boolean }[] };
    expect(comments.comments.map((c) => c.comment).filter(Boolean).sort()).toEqual(['Clear enough', 'It did not name the hosts', 'Still unclear which hosts']);

    // The eval seed: the negative answers with a comment or a shared question, in the shape of an eval set.
    const exported = (await ed.get(`/api/knowledge/bases/${kb.id}/feedback/eval-seed`).expect(200)).body as { seed: { cases: { prompt: string; checks: { kind: string; rubric: string }[] }[]; judgeProfile: null; gate: boolean }; cases: number };
    expect(exported.cases).toBe(2);
    expect(exported.seed.gate).toBe(false);
    expect(exported.seed.cases.map((c) => c.prompt)).toContain('Where do I install the zebra agent?');
    expect(exported.seed.cases.every((c) => c.checks[0]!.kind === 'judge' && c.checks[0]!.rubric.includes('Setting up'))).toBe(true);
    for (const c of exported.seed.cases) expect(evalCase.safeParse(c).success).toBe(true);
    expect(evalSetBody.safeParse({ ...exported.seed, judgeProfile: 'general' }).success).toBe(true);
    await reader.get(`/api/knowledge/bases/${kb.id}/feedback/eval-seed`).expect(403);

    // Withdrawing an answer is the author's.
    await other.del(`/api/knowledge/feedback/${given.id}`).expect(404);
    await reader.del(`/api/knowledge/feedback/${given.id}`).expect(204);
    const actions = ((await h.s.audit.list(h.tenantId, { limit: 300 })) as { action: string }[]).map((e) => e.action);
    for (const a of ['knowledge.feedback.given', 'knowledge.feedback.changed', 'knowledge.feedback.exported', 'knowledge.feedback.withdrawn']) expect(actions).toContain(a);
  });

  it('builds a tree without cycles, writes backlinks on publish and hides what the reader cannot read', async () => {
    const { curator, ed, ap, reader, kb } = await setup();
    const guide = await publish(ed, ap, kb.id, 'guide', 'Guide', '# Guide\n\nStart with [[guide/setup]].');
    const setupRef = await publish(ed, ap, kb.id, 'guide/setup', 'Setting up', '# Setting up\n\nThen read [installing](guide/install).');
    const install = await publish(ed, ap, kb.id, 'guide/install', 'Installing', '# Installing\n\nBack to [[guide]] or [[guide/setup]].');
    // Confidential: the internal reader never sees it, in the tree, as a parent or as a backlink.
    const secret = await publish(ed, ap, kb.id, 'guide/secret', 'Secret runbook', '# Secret\n\nSee [[guide/setup]].', 'confidential');
    // A draft only editors see.
    await ed.post(`/api/knowledge/bases/${kb.id}/revisions`, { reference: 'guide/draft', title: 'Draft page', content: '# Draft\n\n[[guide/setup]]', summary: 'WIP' }).expect(201);
    const draft = ((await h.s.db('knowledge_references').where({ kb_id: kb.id, slug: 'guide/draft' }).first()) as { id: string }).id;

    // Moves: setup under guide, install under setup, secret under guide, draft under secret.
    const move = (c: Client, id: string, parentId: string | null, position?: number) => c.put(`/api/knowledge/references/${id}/tree`, { parentId, ...(position !== undefined ? { position } : {}) });
    await move(reader, setupRef, guide).expect(403);
    await move(ed, setupRef, guide).expect(200);
    await move(ed, install, setupRef).expect(200);
    await move(ed, secret, guide, 0).expect(200);
    await move(ed, draft, secret).expect(200);
    // No cycles: not under itself, not under its own descendant.
    expect((await move(ed, guide, guide).expect(409)).body.detail).toMatch(/own parent/);
    expect((await move(ed, guide, install).expect(409)).body.detail).toMatch(/cycle/);
    expect((await move(curator, setupRef, install).expect(409)).body.detail).toMatch(/cycle/);
    // The reader cannot move under, or even name, a parent they cannot read.
    await move(ed, install, '0'.repeat(26)).expect(404);

    // Editors see the whole tree, in order.
    const full = (await ed.get(`/api/knowledge/bases/${kb.id}/tree`).expect(200)).body as { nodes: { id: string; parentId: string | null; position: number; children: number }[] };
    const byId = (n: { id: string }[], id: string) => n.find((x) => x.id === id) as { parentId: string | null; position: number; children: number } | undefined;
    expect(byId(full.nodes, secret)).toMatchObject({ parentId: guide, position: 0 });
    expect(byId(full.nodes, setupRef)).toMatchObject({ parentId: guide, position: 1 });
    expect(byId(full.nodes, guide)!.children).toBe(2);
    expect(byId(full.nodes, draft)).toMatchObject({ parentId: secret });

    // The reader: no secret, no draft; the guide has one child.
    const seen = (await reader.get(`/api/knowledge/bases/${kb.id}/tree`).expect(200)).body as { nodes: { id: string; parentId: string | null; children: number }[] };
    expect(seen.nodes.map((n) => n.id).sort()).toEqual([guide, setupRef, install].sort());
    expect(byId(seen.nodes, guide)!.children).toBe(1);

    // Breadcrumbs and children.
    const ctxOf = async (c: Client, id: string) => (await c.get(`/api/knowledge/references/${id}/tree`).expect(200)).body as { breadcrumbs: { id: string }[]; children: { id: string }[]; links: { id: string }[]; backlinks: { id: string }[]; parentId: string | null };
    const inst = await ctxOf(reader, install);
    expect(inst.breadcrumbs.map((b) => b.id)).toEqual([guide, setupRef]);
    expect((await ctxOf(reader, guide)).children.map((c) => c.id)).toEqual([setupRef]);
    await reader.get(`/api/knowledge/references/${secret}/tree`).expect(404);
    await reader.get(`/api/knowledge/references/${draft}/tree`).expect(404);

    // Backlinks, written when each revision published: guide and install link to setup (and secret, which the reader cannot read).
    const setupFor = (c: Client) => ctxOf(c, setupRef);
    expect((await setupFor(reader)).backlinks.map((b) => b.id).sort()).toEqual([guide, install].sort());
    expect((await setupFor(ed)).backlinks.map((b) => b.id).sort()).toEqual([guide, install, secret].sort());
    expect((await setupFor(reader)).links.map((l) => l.id)).toEqual([install]);
    expect((await ctxOf(reader, guide)).backlinks.map((b) => b.id)).toEqual([install]);

    // A new revision that drops a link drops the backlink.
    const rev = (await ed.post(`/api/knowledge/bases/${kb.id}/revisions`, { reference: 'guide/install', content: '# Installing\n\nBack to [[guide]].', summary: 'Fewer links', submit: true }).expect(201)).body as { id: string };
    await ap.post(`/api/knowledge/revisions/${rev.id}/decision`, { decision: 'approve' }).expect(200);
    await drain(h);
    expect((await setupFor(reader)).backlinks.map((b) => b.id)).toEqual([guide]);

    // Under a parent the reader cannot read, a page shows at the top level with no breadcrumbs above it.
    await move(ed, install, secret).expect(200);
    const top = (await reader.get(`/api/knowledge/bases/${kb.id}/tree`).expect(200)).body as { nodes: { id: string; parentId: string | null }[] };
    expect(byId(top.nodes, install)!.parentId).toBeNull();
    expect((await ctxOf(reader, install)).breadcrumbs).toEqual([]);
    expect((await ctxOf(ed, install)).breadcrumbs.map((b) => b.id)).toEqual([guide, secret]);

    const moved = ((await h.s.audit.list(h.tenantId, { limit: 300 })) as unknown as { action: string; detail: { before: unknown; after: unknown } }[]).filter((e) => e.action === 'knowledge.reference.moved');
    expect(moved.length).toBe(5);
    expect(moved[0]!.detail).toMatchObject({ after: { parentId: secret } });
  });
});
