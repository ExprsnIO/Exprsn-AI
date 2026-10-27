/*
 * 2.0.x Docs portal: documentation sites over knowledge bases. The renderer (escaped HTML, page links, contents, front
 * matter), then the API: curators make sites, readers see only what the knowledge bases let them read, pages render
 * with their place in the tree, links, backlinks and versions, and search points at pages.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderMarkdown, renderSections, stripFrontMatter } from '../src/docs/render.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, type Harness } from './helpers.js';
import { client, drain, seedRetrieval } from './retrieval-seed.js';

const pages = new Set(['exprsn-ai/gateway']);
const opts = { page: (slug: string, part: string | null) => ({ href: `#/docs?page=${slug}${part ? `&at=${part}` : ''}`, exists: pages.has(slug), kb: 'KB', slug }) };

describe('rendering a page', () => {
  it('escapes everything, links pages, and builds the contents', () => {
    const md = '---\ntitle: X\nversion: 1.2.0\n---\n# Overview\n\nSee [[exprsn-ai/gateway|the gateway]], [[exprsn-ai/nope]] and [pools](exprsn-ai/gateway#pools).\n\n<script>alert(1)</script>\n\n## Setup\n\n```sh\necho "<b>"\n```\n\n## Setup\n\n| a | b |\n| - | - |\n| <i>x</i> | [web](https://example.com) |\n\n- [x] done\n- [ ] not yet\n';
    const r = renderMarkdown(md, opts);
    expect(r.meta).toEqual({ title: 'X', version: '1.2.0' });
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(r.html).toContain('<a href="#/docs?page=exprsn-ai/gateway" data-docs-page="exprsn-ai/gateway" data-docs-kb="KB">the gateway</a>');
    expect(r.html).toMatch(/data-docs-page="exprsn-ai\/nope"[^>]*data-docs-missing="1"/);
    expect(r.html).toContain('href="#/docs?page=exprsn-ai/gateway&amp;at=pools"');
    expect(r.html).toContain('<a href="https://example.com" rel="noopener noreferrer" target="_blank">web</a>');
    expect(r.html).toContain('<code>echo &quot;&lt;b&gt;&quot;</code>');
    expect(r.html).toContain('&lt;i&gt;x&lt;/i&gt;');
    expect(r.html).toContain('<input type="checkbox" disabled checked aria-label="Done">');
    expect(r.toc).toEqual([
      { level: 1, id: 'overview', text: 'Overview' },
      { level: 2, id: 'setup', text: 'Setup' },
      { level: 2, id: 'setup-2', text: 'Setup' }
    ]);
    expect(r.html).not.toMatch(/\son\w+=/i);
  });

  it('keeps unsafe link schemes as text and renders extracted text', () => {
    const r = renderMarkdown('[x](javascript:alert(1)) [y](data:text/html,hi)', opts);
    expect(r.html).not.toContain('javascript:');
    expect(r.html).not.toMatch(/href="data:/);
    expect(stripFrontMatter('no front matter').body).toBe('no front matter');
    const s = renderSections([{ heading: 'Intro', text: 'One <b>\n\nTwo' }, { heading: 'Intro', text: 'Three' }, { heading: null, withheld: 'Withheld by a guardrail.' }]);
    expect(s.html).toBe('<h2 id="intro">Intro</h2>\n<p>One &lt;b&gt;</p>\n<p>Two</p>\n<p>Three</p>\n<p class="docs-withheld">Withheld by a guardrail.</p>');
  });
});

describe('Docs portal API', () => {
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

  type C = Awaited<ReturnType<typeof client>>;
  async function publish(ed: C, ap: C, kbId: string, reference: string, title: string, content: string) {
    const draft = (await ed.post(`/api/knowledge/bases/${kbId}/revisions`, { reference, title, content, summary: `${title} baseline`, submit: true }).expect(201)).body as { id: string; state: string };
    if (draft.state === 'draft') await ed.post(`/api/knowledge/revisions/${draft.id}/submit`).expect(200);
    await ap.post(`/api/knowledge/revisions/${draft.id}/decision`, { decision: 'approve', reason: 'ok' }).expect(200);
    await drain(h);
  }

  it('makes sites from knowledge bases and reads them as each reader may', async () => {
    await seedRetrieval(h, ollama);
    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    const ed = await client(h, 'ed', ['member']);
    const ap = await client(h, 'ap', ['member']);
    const reader = await client(h, 'rita', ['member']);
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Handbook', label: 'public', embedModel: 'nomic-embed-text' }).expect(201)).body as { id: string };
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { status: 'published' }).expect(200);
    await curator.post(`/api/knowledge/bases/${kb.id}/reviewers`, { duty: 'editor', kind: 'user', id: ed.user.id }).expect(201);
    await curator.post(`/api/knowledge/bases/${kb.id}/reviewers`, { duty: 'approver', kind: 'user', id: ap.user.id }).expect(201);
    // A second base the reader has no access to (not published).
    const secret = (await curator.post('/api/knowledge/bases', { name: 'Board papers', label: 'confidential', embedModel: 'nomic-embed-text' }).expect(201)).body as { id: string };

    await publish(ed, ap, kb.id, 'handbook/overview', 'Overview', '# Overview\n\nWelcome. Read [[handbook/gateway|the gateway page]] and [[handbook/missing]].\n\n## Zebra routing\n\nRequests are routed by zebra rules.');
    await publish(ed, ap, kb.id, 'handbook/gateway', 'Gateway', '# Gateway\n\nThe gateway sends quokka traffic. Back to [[handbook/overview]].');

    // Only curators make sites; a base must be readable by the curator; the home page must exist.
    await reader.post('/api/docs/sites', { slug: 'handbook', title: 'Handbook', kbIds: [kb.id] }).expect(403);
    await curator.post('/api/docs/sites', { slug: 'handbook', title: 'Handbook', kbIds: [kb.id], home: { kbId: kb.id, slug: 'handbook/none' } }).expect(409);
    const site = (await curator.post('/api/docs/sites', { slug: 'handbook', title: 'Handbook', description: 'How we work', kbIds: [kb.id, secret.id], home: { kbId: kb.id, slug: 'handbook/overview' } }).expect(201)).body;
    expect(site).toMatchObject({ slug: 'handbook', home: { kbId: kb.id, slug: 'handbook/overview' }, library: true, canManage: true });
    await curator.post('/api/docs/sites', { slug: 'handbook', title: 'Again', kbIds: [kb.id] }).expect(409);
    const hidden = (await curator.post('/api/docs/sites', { slug: 'board', title: 'Board', kbIds: [secret.id] }).expect(201)).body;

    // The reader sees the site with the bases they can read, and not the one made only of a base they cannot.
    const list = (await reader.get('/api/docs/sites').expect(200)).body as { slug: string; bases: { id: string }[]; canManage: boolean }[];
    expect(list.map((x) => x.slug)).toEqual(['handbook']);
    expect(list[0]!.bases.map((b) => b.id)).toEqual([kb.id]);
    expect(list[0]!.canManage).toBe(false);
    await reader.get(`/api/docs/sites/${hidden.slug}/nav`).expect(404);

    const nav = (await reader.get('/api/docs/sites/handbook/nav').expect(200)).body;
    expect(nav.sections).toHaveLength(1);
    expect(nav.sections[0].pages.map((x: { slug: string }) => x.slug).sort()).toEqual(['handbook/gateway', 'handbook/overview']);

    const page = (await reader.get(`/api/docs/sites/handbook/page?kb=${kb.id}&slug=handbook/overview`).expect(200)).body;
    expect(page.page).toMatchObject({ slug: 'handbook/overview', title: 'Overview', version: '1.0.0', current: '1.0.0', state: 'published' });
    expect(page.html).toContain('data-docs-page="handbook/gateway"');
    expect(page.html).toMatch(/data-docs-page="handbook\/missing"[^>]*data-docs-missing="1"/);
    expect(page.toc.map((t: { id: string }) => t.id)).toEqual(['overview', 'zebra-routing']);
    expect(page.links.map((x: { slug: string }) => x.slug)).toEqual(['handbook/gateway']);
    expect(page.backlinks.map((x: { slug: string }) => x.slug)).toEqual(['handbook/gateway']);
    expect(page.versions.map((v: { version: string }) => v.version)).toEqual(['1.0.0']);
    expect(page.canEdit).toBe(false);
    expect((await ed.get(`/api/docs/sites/handbook/page?kb=${kb.id}&slug=handbook/overview`).expect(200)).body.canEdit).toBe(true);
    await reader.get(`/api/docs/sites/handbook/page?kb=${kb.id}&slug=handbook/missing`).expect(404);
    await reader.get(`/api/docs/sites/handbook/page?kb=${secret.id}&slug=handbook/overview`).expect(404);

    // A second version: the current one is served, the earlier one on request.
    await publish(ed, ap, kb.id, 'handbook/overview', 'Overview', '# Overview\n\nWelcome again.');
    const v2 = (await reader.get(`/api/docs/sites/handbook/page?kb=${kb.id}&slug=handbook/overview`).expect(200)).body;
    expect(v2.page.version).not.toBe('1.0.0');
    expect(v2.versions).toHaveLength(2);
    const v1 = (await reader.get(`/api/docs/sites/handbook/page?kb=${kb.id}&slug=handbook/overview&version=1.0.0`).expect(200)).body;
    expect(v1.html).toContain('zebra rules');
    expect(v1.page.current).toBe(v2.page.version);

    const found = (await reader.get('/api/docs/sites/handbook/search?q=quokka traffic').expect(200)).body as { hits: { kind: string; slug?: string }[] };
    expect(found.hits[0]).toMatchObject({ kind: 'page', slug: 'handbook/gateway' });

    // Settings and removal are audited.
    const patched = (await curator.patch(`/api/docs/sites/${site.id}`, { title: 'Our handbook', library: false }).expect(200)).body;
    expect(patched).toMatchObject({ title: 'Our handbook', library: false, version: 2 });
    await reader.get(`/api/docs/sites/handbook/library?kb=${kb.id}`).expect(404);
    await curator.del(`/api/docs/sites/${hidden.id}`).expect(204);
    const actions = ((await h.s.db('audit_events').where({ tenant_id: h.tenantId }).whereLike('action', 'docs.site.%').select('action')) as { action: string }[]).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['docs.site.created', 'docs.site.updated', 'docs.site.removed']));
  });
});
