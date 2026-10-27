/*
 * Web sites as knowledge sources, after 1.6.0 (migration 044): the images of crawled pages as documents the base's
 * vision profile captions and reads, what each sync found new, changed and gone with the line diff of the text, and
 * the built-in tool `knowledge_changes`.
 */
import { Agent } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import type { Label } from '../src/authz/labels.js';
import type { ProfileRow } from '../src/gateway/repo.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { HttpProblem } from '../src/http/problem.js';
import { crawl, pageImages } from '../src/knowledge/crawl.js';
import { textDiff } from '../src/knowledge/diff.js';
import { FakeOllama, markedPng } from './fake-ollama.js';
import { type Harness } from './helpers.js';
import { client, drain, harnessWith, seedRetrieval } from './retrieval-seed.js';
import { FakeSite } from './sprint23-fakes.js';

const GB = 1_000_000_000;
const page = (title: string, text: string, extra = '') => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${text.split('\n').map((l) => `<p>${l}</p>`).join('')}${extra}</body></html>`;

describe('Differentials and images: helpers', () => {
  it('diffs text by line, with context, and calls equal text no change', () => {
    const before = 'Robots\n\nThe arm has six joints.\nIt lifts 10 kg.\n\nContact: lab@example.org';
    const after = 'Robots\n\nThe arm has seven joints.\nIt lifts 10 kg.\nIt runs ROS 2.\n\nContact: lab@example.org';
    const d = textDiff(before, after);
    expect(d).toMatchObject({ added: 2, removed: 1, truncated: false });
    expect(d.text.split('\n')).toEqual(['@@ -1,6 +1,7 @@', ' Robots', ' ', '-The arm has six joints.', '+The arm has seven joints.', ' It lifts 10 kg.', '+It runs ROS 2.', ' ', ' Contact: lab@example.org']);
    expect(textDiff(before, before)).toEqual({ added: 0, removed: 0, text: '', truncated: false });
    expect(textDiff('', 'a\nb')).toMatchObject({ added: 2, removed: 0 });
    // Two far-apart changes are two hunks; a long diff keeps its start.
    const many = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const two = textDiff(many.join('\n'), many.map((l, i) => (i === 3 || i === 30 ? `${l} changed` : l)).join('\n'));
    expect(two.text.match(/^@@/gm)).toHaveLength(2);
    expect(two.text).toContain('@@ -29,5 +29,5 @@');
    expect(textDiff(many.join('\n'), many.map((l) => `${l}!`).join('\n'), { maxChars: 200 })).toMatchObject({ added: 40, removed: 40, truncated: true });
    // Past the comparison size the middle is replaced whole.
    expect(textDiff('a\nb\nc', 'a\nx\nc', { maxCells: 0 })).toMatchObject({ added: 1, removed: 1 });
  });

  it('collects the pictures of a page', () => {
    const html = '<img src="/a.png" alt="A"><img alt="lazy" src="data:image/gif;base64,AAAA" data-src="b.jpg"><IMG SRC=\'https://cdn.example/c.webp?x=1&amp;y=2\'><img src="/a.png"><!-- <img src="/hidden.png"> --><img alt="none">';
    expect(pageImages(html, 'http://h/dir/page')).toEqual(['http://h/a.png', 'http://h/dir/b.jpg', 'https://cdn.example/c.webp?x=1&y=2']);
    expect(pageImages('<meta name="robots" content="noimageindex"><img src="/a.png">', 'http://h/')).toEqual([]);
  });

  it('fetches images from another host only when it is allowed and its own robots.txt permits', async () => {
    const site = await new FakeSite().start();
    const cdn = await new FakeSite().start();
    const closed = await new FakeSite().start();
    const agent = new Agent();
    try {
      const png = markedPng({ caption: 'An arm' }, 64);
      cdn.pages.set('/robots.txt', { type: 'text/plain', body: 'User-agent: *\nDisallow: /private/\n' });
      cdn.pages.set('/arm.png', { type: 'image/png', data: png, etag: '"arm-1"' });
      cdn.pages.set('/private/plan.png', { type: 'image/png', data: png });
      cdn.pages.set('/moved.png', { status: 302, location: `${closed.url}/x.png` });
      cdn.pages.set('/page.png', { type: 'text/html', body: '<html>not an image</html>' });
      cdn.pages.set('/fake.png', { type: 'image/png', data: Buffer.alloc(9000, 0x41) });
      closed.pages.set('/robots.txt', { status: 503 });
      closed.pages.set('/x.png', { type: 'image/png', data: png });
      site.pages.set('/', { type: 'text/html', body: page('Home', 'Robots.', ['/arm.png', '/private/plan.png', '/moved.png', '/page.png', '/fake.png'].map((p) => `<img src="${cdn.url}${p}">`).join('') + `<img src="${closed.url}/x.png">`) });
      const run = (allowed: (h: string) => boolean, previous: Parameters<typeof crawl>[0]['previous'] = async () => null) =>
        crawl({ start: `${site.url}/`, maxDepth: 0, maxPages: 5, pathPrefix: '', sitemap: false, maxBytes: 1_000_000, timeoutMs: 5000, dispatcher: agent, previous, media: { max: 10, minBytes: 1024, allowed } });

      const none = await run(() => false);
      expect(none.images).toBe(0);
      expect(cdn.requests).toEqual([]);
      expect(none.skipped.filter((x) => /not allowed/.test(x.reason))).toHaveLength(6);

      const out = await run(() => true);
      expect(out.images).toBe(1);
      expect(out.items.map((i) => [i.key, i.type])).toEqual([[`${site.url}/`, 'text/html'], [`${cdn.url}/arm.png`, 'image/png']]);
      const why = Object.fromEntries(out.skipped.map((x) => [x.url.replace(/^http:\/\/[^/]+/, ''), x.reason]));
      expect(why).toMatchObject({ '/private/plan.png': 'skipped: robots.txt disallows it', '/page.png': 'skipped: text/html content type', '/fake.png': 'skipped: not a PNG, JPEG, WebP or GIF image' });
      // A host whose robots.txt errors is left alone, by link and by redirect.
      expect(out.skipped.filter((x) => /robots\.txt could not be read/.test(x.reason))).toHaveLength(2);
      expect(closed.requests.map((r) => r.path)).toEqual(['/robots.txt']);
      expect(cdn.requests.filter((r) => r.path === '/robots.txt')).toHaveLength(1);
      expect(cdn.requests.map((r) => r.path)).not.toContain('/private/plan.png');

      // The stored copy's validator is sent; a 304 keeps it.
      const again = await run(() => true, async (url) => (url.endsWith('/arm.png') ? { version: 'etag:"arm-1"', body: async () => png } : null));
      expect(again).toMatchObject({ images: 1, unchanged: 1 });
      expect(cdn.requests.filter((r) => r.path === '/arm.png').pop()).toMatchObject({ status: 304 });
    } finally {
      await agent.close();
      await site.stop();
      await cdn.stop();
      await closed.stop();
    }
  });
});

describe('Differentials and images of crawled sites', () => {
  let h: Harness;
  let ollama: FakeOllama;
  const stops: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await h?.s.knowledge.replication.close();
    await h?.close();
    await ollama?.stop();
    for (const s of stops.splice(0)) await s();
  });

  /** The retrieval seed, a vision model behind the published profile `see`, and a published base. */
  async function setup() {
    h = await harnessWith({}, { OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    const { pool } = await seedRetrieval(h, ollama);
    const repo = h.s.gateway.repo;
    ollama.addAvailable({ name: 'gemma3:12b', size: 8 * GB, capabilities: ['completion', 'vision'] });
    const m = await repo.createModel({ name: 'gemma3:12b', source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
    await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: ['completion', 'vision'], size_bytes: 8 * GB });
    await repo.place(m.id, pool.id, 'warm', 'x');
    const t = Date.now();
    const see: ProfileRow = { id: 'SEE'.padEnd(26, '0'), tenant_id: h.tenantId, name: 'see', display_name: 'See', description: null, alias_of: null, model_id: m.id, pool_id: pool.id, num_ctx: 8192, temperature: 0, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'confidential', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t };
    await repo.createProfile(see);
    await h.s.gateway.pollAll();
    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Robots', label: 'internal', embedModel: 'nomic-embed-text', sharing: 'members' }).expect(201)).body as { id: string };
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { status: 'published' }).expect(200);
    const site = await new FakeSite().start();
    const elsewhere = await new FakeSite().start();
    stops.push(() => site.stop(), () => elsewhere.stop());
    return { curator, kb, site, elsewhere };
  }

  type Change = { id: string; kind: string; document: string; added: number; removed: number; hasDiff: boolean; label: string };

  it('indexes the images of a site through the vision profile, and records what each sync found', async () => {
    const { curator, kb, site, elsewhere } = await setup();
    const diagram = markedPng({ caption: 'A wiring diagram of a gripper', ocr: 'Servo PWM on pin 9\nEmergency stop on pin 2' }, 64);
    elsewhere.pages.set('/far.png', { type: 'image/png', data: diagram });
    site.pages.set('/diagram.png', { type: 'image/png', data: diagram, etag: '"d-1"' });
    site.pages.set('/icon.png', { type: 'image/png', data: markedPng({ caption: 'An icon' }, 8), etag: '"i-1"' });
    site.pages.set('/', { type: 'text/html', etag: '"home-1"', body: page('Lab', 'The robotics lab home page.', `<a href="/news">News</a><img src="/diagram.png" alt="Gripper"><img src="/icon.png"><img src="${elsewhere.url}/far.png">`) });
    site.pages.set('/news', { type: 'text/html', etag: '"news-1"', body: page('News', 'The arm has six joints.\nIt lifts ten kilograms.') });
    const add = (body: Record<string, unknown>) => curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'web', location: `${site.url}/`, maxDepth: 1, maxPages: 10, sitemap: false, schedule: 'manual', ...body });

    // Images need a vision profile; both options are for web sites only.
    expect((await add({ media: true }).expect(409)).body.detail).toMatch(/no vision profile/);
    expect((await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'git', location: 'https://git.example.internal/x.git', changes: true }).expect(400)).body.detail).toMatch(/for web sites/);
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { visionProfile: 'see' }).expect(200);

    const src = (await add({ media: true, maxMedia: 5, changes: true }).expect(201)).body;
    expect(src.config).toMatchObject({ media: true, maxMedia: 5, changes: true });
    await drain(h);
    const docs = async () => ((await curator.get(`/api/knowledge/bases/${kb.id}/documents`).expect(200)).body as { id: string; name: string; state: string; media: string | null }[]).map((d) => ({ ...d, name: d.name.replace(/^127\.0\.0\.1:\d+/, '') })).sort((a, b) => a.name.localeCompare(b.name));
    expect((await docs()).map((d) => [d.name, d.state, d.media])).toEqual([['/', 'indexed', null], ['/diagram.png', 'indexed', 'image'], ['/news', 'indexed', null]]);
    const job = async () => JSON.parse(((await h.s.db('jobs').where({ type: 'knowledge.sync' }).orderBy('created_at', 'desc').first()) as { result: string }).result) as { images: number; recorded: number; skippedUrls: { url: string; reason: string }[]; added: number; changed: number; removed: number; unchanged: number };
    expect(await job()).toMatchObject({ added: 3, images: 1, recorded: 0 });
    expect((await job()).skippedUrls.map((x) => x.reason)).toEqual(expect.arrayContaining(['skipped: an image under 8192 bytes', 'skipped: the image is on a host that is not allowed']));
    expect(elsewhere.requests).toEqual([]);
    // The image is found by the text read in it.
    const hits = (await curator.post('/api/knowledge/search', { kbIds: [kb.id], query: 'emergency stop pin', rerank: false, k: 10 }).expect(200)).body.hits as { document: string; image?: { caption: string } }[];
    expect(hits.find((x) => /diagram\.png$/.test(x.document))?.image?.caption).toBe('A wiring diagram of a gripper');
    // The first sync fills the source: nothing is a change yet.
    const changes = async (q = '') => (await curator.get(`/api/knowledge/bases/${kb.id}/changes${q}`).expect(200)).body as Change[];
    expect(await changes()).toEqual([]);

    // A page's text changes, a page appears, the image's text changes.
    site.pages.set('/news', { type: 'text/html', etag: '"news-2"', body: page('News', 'The arm has seven joints.\nIt lifts ten kilograms.\nIt now runs ROS 2.') });
    site.pages.set('/launch', { type: 'text/html', etag: '"launch-1"', body: page('Launch', 'The rover launches in March.') });
    site.pages.set('/', { type: 'text/html', etag: '"home-2"', body: page('Lab', 'The robotics lab home page.', `<a href="/news">News</a><a href="/launch">Launch</a><img src="/diagram.png" alt="Gripper">`) });
    site.pages.set('/diagram.png', { type: 'image/png', data: markedPng({ caption: 'A wiring diagram of a gripper', ocr: 'Servo PWM on pin 10\nEmergency stop on pin 2' }, 64), etag: '"d-2"' });
    await curator.post(`/api/knowledge/sources/${src.id}/sync`).expect(202);
    await drain(h);
    expect(await job()).toMatchObject({ added: 1, changed: 3, recorded: 4 });
    const found = (await changes()).map((c) => [c.kind, c.document.replace(/^127\.0\.0\.1:\d+/, ''), c.added, c.removed, c.hasDiff]).sort();
    // The home page's markup changed (a link, an image less) and so did its text: the link's words.
    expect(found).toEqual([['added', '/launch', 2, 0, false], ['changed', '/', 1, 1, true], ['changed', '/diagram.png', 1, 1, true], ['changed', '/news', 2, 1, true]].sort());
    const news = (await changes()).find((c) => /\/news$/.test(c.document))!;
    const one = (await curator.get(`/api/knowledge/changes/${news.id}`).expect(200)).body as Change & { diff: string };
    expect(one.diff.split('\n')).toEqual(expect.arrayContaining(['-The arm has six joints.', '+The arm has seven joints.', '+It now runs ROS 2.', ' It lifts ten kilograms.']));
    const pic = (await changes()).find((c) => /diagram\.png$/.test(c.document))!;
    expect(((await curator.get(`/api/knowledge/changes/${pic.id}`).expect(200)).body as { diff: string }).diff).toContain('+Servo PWM on pin 10');
    // The diff is sealed at rest.
    const row = (await h.s.db('knowledge_doc_changes').where({ id: news.id }).first()) as { diff_sealed: string };
    expect(row.diff_sealed).not.toContain('seven joints');
    expect((await changes(`?source=${src.id}&limit=1`))).toHaveLength(1);

    // Only the markup of a page changes: no change. A page that is gone is recorded.
    site.pages.set('/news', { type: 'text/html', etag: '"news-3"', body: page('News', 'The arm has seven joints.\nIt lifts ten kilograms.\nIt now runs ROS 2.').replace('<body>', '<body data-build="77">') });
    site.pages.set('/', { type: 'text/html', etag: '"home-3"', body: page('Lab', 'The robotics lab home page.', `<a href="/news">News</a><a href="/launch">Launch</a>`) });
    await curator.post(`/api/knowledge/sources/${src.id}/sync`).expect(202);
    await drain(h);
    expect(await job()).toMatchObject({ changed: 2, removed: 1, recorded: 1 });
    expect((await changes())[0]).toMatchObject({ kind: 'removed', hasDiff: false });
    expect((await changes())[0]!.document).toMatch(/diagram\.png$/);

    // A reader below a change's label does not see it; the tool lists and reads changes for an agent.
    const p = (await loadPrincipal(h.s, h.tenantId, curator.user.id, {}))!;
    await expect(h.s.knowledge.change({ ...p, clearance: 'public' }, news.id)).rejects.toMatchObject({ status: 404 });
    const call = async (args: Record<string, unknown>, label: Label = 'internal') => {
      const { tools } = await h.s.tools.resolve(p, ['knowledge_changes'], label);
      return h.s.tools.call({ principal: p, label, approved: false, source: { kind: 'agent-run', id: 'R1' } }, tools[0]!, args);
    };
    const listed = (await call({ kbId: kb.id })).result as { changes: { id: string; kind: string; document: string; kb: string; linesAdded: number }[] };
    expect(listed.changes).toHaveLength(5);
    expect(listed.changes[0]).toMatchObject({ kind: 'removed', kb: 'Robots' });
    const read = (await call({ changeId: news.id })).result as { change: { document: string; linesAdded: number; linesRemoved: number }; diff: string };
    expect(read.change).toMatchObject({ linesAdded: 2, linesRemoved: 1 });
    expect(read.diff).toContain('+It now runs ROS 2.');
    // From data at a lower label than the changes, nothing is listed.
    expect(((await call({}, 'public')).result as { changes: unknown[] }).changes).toEqual([]);

    // The changes go with their source.
    await curator.del(`/api/knowledge/sources/${src.id}`).expect(200);
    expect(await h.s.db('knowledge_doc_changes').where({ kb_id: kb.id })).toHaveLength(0);
  });

  it('sets aside a page no pool may embed at its label and indexes the rest of the site', async () => {
    const { curator, kb, site } = await setup();
    site.pages.set('/', { type: 'text/html', etag: '"h-1"', body: page('Lab', 'The robotics lab home page.', '<a href="/staff">Staff</a><a href="/arms">Arms</a>') });
    site.pages.set('/staff', { type: 'text/html', etag: '"s-1"', body: page('Staff', 'ZONEMARK the staff directory.') });
    site.pages.set('/arms', { type: 'text/html', etag: '"a-1"', body: page('Arms', 'The arm reaches nine hundred millimetres.') });
    // The gateway refuses to embed one page, as it does when no pool is cleared for the label the page was given.
    const gateway = h.s.gateway;
    const embed = gateway.embed.bind(gateway);
    gateway.embed = async (model, input, label, signal) => {
      if (input.some((x) => x.includes('ZONEMARK'))) throw new HttpProblem(503, 'No capacity', `No pool cleared for ${label} data runs ${model}.`, { extensions: { step: 'zone' } });
      return embed(model, input, label, signal);
    };
    const src = (await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'web', location: `${site.url}/`, maxDepth: 1, maxPages: 10, sitemap: false, schedule: 'manual', changes: true }).expect(201)).body;
    await drain(h);
    const docs = async () => ((await curator.get(`/api/knowledge/bases/${kb.id}/documents`).expect(200)).body as { name: string; state: string; error: string | null }[]).map((d) => [d.name.replace(/^127\.0\.0\.1:\d+/, ''), d.state]).sort();
    expect(await docs()).toEqual([['/', 'indexed'], ['/arms', 'indexed'], ['/staff', 'rejected']]);
    const row = (await h.s.db('knowledge_documents').where({ kb_id: kb.id, state: 'rejected' }).first()) as { error: string; chunks: number };
    expect(row.error).toMatch(/^Not indexed: No pool cleared for internal data/);
    expect(row.chunks).toBe(0);
    const source = (await h.s.db('knowledge_sources').where({ id: src.id }).first()) as { state: string; last_error: string | null };
    expect(source).toMatchObject({ state: 'idle', last_error: null });
    const job = JSON.parse(((await h.s.db('jobs').where({ type: 'knowledge.sync' }).orderBy('created_at', 'desc').first()) as { result: string }).result) as Record<string, number>;
    expect(job).toMatchObject({ added: 3, setAside: 1 });
    // The page is not tried again while it is unchanged; another error still fails the sync.
    await curator.post(`/api/knowledge/sources/${src.id}/sync`).expect(202);
    await drain(h);
    expect(await docs()).toEqual([['/', 'unchanged'], ['/arms', 'unchanged'], ['/staff', 'rejected']]);
    expect(JSON.parse(((await h.s.db('jobs').where({ type: 'knowledge.sync' }).orderBy('created_at', 'desc').first()) as { result: string }).result)).toMatchObject({ added: 0, unchanged: 3 });

    // An upload the pools may not embed ends rejected with the reason as well, not stuck in "indexing".
    const up = (await curator.agent.put(`/api/knowledge/bases/${kb.id}/uploads?name=${encodeURIComponent('staff.md')}&label=public`).set('x-csrf-token', curator.csrf).set('content-type', 'application/octet-stream').send(Buffer.from('# Staff\n\nZONEMARK the uploaded staff list.')).expect(202)).body as { id: string };
    await drain(h);
    const uploaded = (await h.s.db('knowledge_documents').where({ id: up.id }).first()) as { state: string; error: string };
    expect(uploaded.state).toBe('rejected');
    expect(uploaded.error).toMatch(/^Not indexed: No pool cleared/);
    expect(((await h.s.db('jobs').where({ type: 'knowledge.index' }).orderBy('created_at', 'desc').first()) as { state: string }).state).toBe('succeeded');
  });
});
