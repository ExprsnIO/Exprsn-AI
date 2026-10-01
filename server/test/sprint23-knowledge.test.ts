/*
 * Sprint 23, knowledge: S3-compatible buckets with their own endpoint, keys and include patterns (B-1501), internal
 * web sites crawled within their limits and their host (B-1502), and row security from PostgreSQL roles mapped per
 * group (B-1503). The real-PostgreSQL path of B-1503 is in test/integration/rls.test.ts.
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionSpec, DataDriver, QueryResult, RoleCheck } from '../src/connections/drivers.js';
import { parseRobots, robotsAllows, pageLinks, parseValidators } from '../src/knowledge/crawl.js';
import { globRegex, included } from '../src/knowledge/sources.js';
import { FakeOllama } from './fake-ollama.js';
import { loginAdmin, localUser, type Harness } from './helpers.js';
import { client, drain, harnessWith, seedRetrieval } from './retrieval-seed.js';
import { FakeS3, FakeSite } from './sprint23-fakes.js';

describe('Sprint 23: helpers', () => {
  it('matches include globs relative to the prefix', () => {
    const md = [globRegex('**/*.md')];
    expect(included('intro.md', md)).toBe(true);
    expect(included('hr/leave/annual.md', md)).toBe(true);
    expect(included('data.csv', md)).toBe(false);
    expect(included('a/b.md', [globRegex('*.md')])).toBe(false);
    expect(included('policy-2026.txt', [globRegex('policy-????.txt')])).toBe(true);
    expect(included('x.(1).md', [globRegex('x.(1).md')])).toBe(true);
    expect(included('anything', [])).toBe(true);
  });

  it('reads robots.txt like RFC 9309: our group, the longest rule, Allow on a tie', () => {
    const r = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: ExprsnAI-Knowledge\nUser-agent: other\nDisallow: /private\nAllow: /private/open\nDisallow: /*.pdf$\nCrawl-delay: 1\nSitemap: http://x/sitemap.xml\n');
    expect(r.sitemaps).toEqual(['http://x/sitemap.xml']);
    expect(r.delayMs).toBe(1000);
    expect(robotsAllows(r, '/docs')).toBe(true);
    expect(robotsAllows(r, '/private/x')).toBe(false);
    expect(robotsAllows(r, '/private/open/x')).toBe(true);
    expect(robotsAllows(r, '/a/report.pdf')).toBe(false);
    expect(robotsAllows(r, '/a/report.pdf?x=1')).toBe(true);
    // Another crawler's file: the * group applies.
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /tmp/\n'), '/tmp/a')).toBe(false);
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow:\n'), '/tmp/a')).toBe(true);
  });

  it('collects followable links and validators', () => {
    expect(pageLinks('<a href="/a#top">A</a><a rel="nofollow" href="/b">B</a><a href="mailto:x@y">m</a><area href="c">', 'http://h/dir/page')).toEqual(['http://h/a#top', 'http://h/dir/c']);
    expect(pageLinks('<meta name="robots" content="noindex, nofollow"><a href="/a">A</a>', 'http://h/')).toEqual([]);
    expect(parseValidators('etag:"x"\nmodified:Tue, 29 Sep 2026 10:00:00 GMT')).toEqual({ etag: '"x"', modified: 'Tue, 29 Sep 2026 10:00:00 GMT' });
  });
});

describe('Sprint 23: knowledge sources', () => {
  let h: Harness;
  let ollama: FakeOllama;
  const stops: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await h?.s.knowledge.replication.close();
    await h?.close();
    await ollama?.stop();
    for (const s of stops.splice(0)) await s();
  });

  async function base(drivers: Record<string, (spec: ConnectionSpec) => DataDriver> = {}, env: Record<string, string> = {}) {
    h = await harnessWith({ drivers }, { OLLAMA_POLL_MS: '600000', CONNECTIONS_ALLOWED_HOSTS: 'db.data.internal', ...env });
    ollama = await new FakeOllama().start();
    await seedRetrieval(h, ollama);
    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Handbook', label: 'internal', embedModel: 'nomic-embed-text', sharing: 'members' }).expect(201)).body;
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { status: 'published' }).expect(200);
    const search = async (c: { post: typeof curator.post }, q: string) => ((await c.post('/api/knowledge/search', { kbIds: [kb.id], query: q, rerank: false, k: 20 }).expect(200)).body.hits as { document: string; text?: string }[]).map((x) => x.document);
    return { curator, kb, search };
  }

  it('B-1501: a file added to an S3-compatible bucket is indexed and a removed one is dropped', async () => {
    const s3 = await new FakeS3('docs', 'AKIDTENANT').start();
    stops.push(() => s3.stop());
    s3.objects.set('handbook/intro.md', { body: '# Welcome\n\nThe office opens at eight in the morning.', etag: 'a1' });
    s3.objects.set('handbook/hr/leave.md', { body: '# Leave\n\nAnnual leave is twenty-five days.', etag: 'b1' });
    s3.objects.set('handbook/data.csv', { body: 'a,b\n1,2', etag: 'c1' });
    s3.objects.set('other/outside.md', { body: 'Not under the prefix.', etag: 'd1' });
    const { curator, kb, search } = await base();

    // Keys go with an endpoint; endpoints must be internal and never link-local.
    await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 's3', location: 's3://docs/handbook/', endpoint: s3.url }).expect(400);
    expect((await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 's3', location: 's3://docs/handbook/', endpoint: 'http://169.254.169.254', accessKeyId: 'AKIDTENANT', secretAccessKey: 's3cret-value' }).expect(409)).body.detail).toMatch(/link-local/);
    expect((await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 's3', location: 's3://docs/handbook/', endpoint: 'http://8.8.8.8', accessKeyId: 'AKIDTENANT', secretAccessKey: 's3cret-value' }).expect(409)).body.detail).toMatch(/KNOWLEDGE_ALLOWED_HOSTS/);

    const src = (await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 's3', location: 's3://docs/handbook/', endpoint: s3.url, accessKeyId: 'AKIDTENANT', secretAccessKey: 's3cret-value', include: ['**/*.md'] }).expect(201)).body;
    expect(src.config).toEqual({ bucket: 'docs', prefix: 'handbook/', include: ['**/*.md'], endpoint: s3.url, region: 'us-east-1', pathStyle: true });
    expect(JSON.stringify(src)).not.toContain('s3cret-value');
    const row = (await h.s.db('knowledge_sources').where({ id: src.id }).first()) as { secret_sealed: string; config: string };
    expect(row.secret_sealed).toBeTruthy();
    expect(row.secret_sealed + row.config).not.toContain('s3cret-value');
    const audit = (await h.s.db('audit_events').where({ action: 'knowledge.source.added' }).first()) as { detail: string };
    expect(audit.detail).toContain('"ownKeys":true');
    expect(audit.detail).not.toContain('s3cret');

    await drain(h);
    const docs = async () => ((await curator.get(`/api/knowledge/bases/${kb.id}/documents`).expect(200)).body as { name: string; state: string }[]).map((d) => `${d.name}:${d.state}`).sort();
    expect(await docs()).toEqual(['hr/leave.md:indexed', 'intro.md:indexed']);
    expect(s3.requests.every((r) => r.keyId === 'AKIDTENANT')).toBe(true);
    expect(s3.gets.some((g) => g.includes('data.csv'))).toBe(false); // excluded by the pattern, never fetched

    // A new file is indexed; a removed one is dropped; unchanged ETags are not fetched again.
    s3.objects.set('handbook/hr/travel.md', { body: '# Travel\n\nBook trains for journeys under four hours.', etag: 't1' });
    s3.objects.delete('handbook/intro.md');
    const before = s3.gets.length;
    await curator.post(`/api/knowledge/sources/${src.id}/sync`).expect(202);
    await drain(h);
    expect(s3.gets.slice(before)).toEqual(['/docs/handbook/hr/travel.md']);
    const job = (await h.s.db('jobs').where({ type: 'knowledge.sync' }).orderBy('created_at', 'desc').first()) as { result: string };
    expect(JSON.parse(job.result)).toMatchObject({ added: 1, removed: 1, unchanged: 1 });
    expect(await docs()).toEqual(['hr/leave.md:unchanged', 'hr/travel.md:indexed']);
    expect(await search(curator, 'trains journeys four hours')).toContain('hr/travel.md');
    expect(await search(curator, 'office opens eight morning')).not.toContain('intro.md');

    // Wrong keys fail the sync with the bucket's answer.
    await h.s.db('knowledge_sources').where({ id: src.id }).update({ secret_sealed: await h.s.keys.seal(h.tenantId, JSON.stringify({ accessKeyId: 'AKIDOTHER', secretAccessKey: 'x' }), `knowledge-source:${src.id}`) });
    await curator.post(`/api/knowledge/sources/${src.id}/sync`).expect(202);
    await drain(h);
    expect((await curator.get(`/api/knowledge/bases/${kb.id}`).expect(200)).body.sources[0]).toMatchObject({ state: 'failed', lastError: expect.stringMatching(/HTTP 403/) });
  });

  it('B-1502: a two-level internal site is indexed within its limits and never leaves its host', async () => {
    const site = await new FakeSite().start();
    const elsewhere = await new FakeSite().start();
    stops.push(() => site.stop(), () => elsewhere.stop());
    elsewhere.html('/elsewhere', 'Elsewhere', 'Another host entirely.');
    site.pages.set('/robots.txt', { type: 'text/plain', body: `User-agent: *\nDisallow: /private\nSitemap: ${site.url}/sitemap.xml\n` });
    site.pages.set('/sitemap.xml', { type: 'application/xml', body: `<?xml version="1.0"?><urlset><url><loc>${site.url}/listed</loc></url><url><loc>${elsewhere.url}/elsewhere</loc></url></urlset>` });
    site.html('/', 'Intranet', 'Welcome to the intranet home page.', ['/policies', '/canteen', '/private/salaries', `${elsewhere.url}/elsewhere`, '/out', '#top']);
    site.html('/policies', 'Policies', 'The expenses policy needs receipts for every claim.', ['/policies/expenses']);
    site.html('/policies/expenses', 'Expenses', 'Mileage is paid at forty-five pence per mile.', ['/policies/expenses/archive']);
    site.html('/policies/expenses/archive', 'Archive', 'Level three: beyond the depth limit.');
    site.html('/canteen', 'Canteen', 'The canteen serves soup on Thursdays.');
    site.html('/listed', 'Listed', 'Only the sitemap names the parking rota page.');
    site.html('/private/salaries', 'Salaries', 'Robots keep crawlers out of here.');
    site.pages.set('/out', { status: 302, location: `${elsewhere.url}/elsewhere` });
    site.pages.set('/logo.png', { type: 'image/png', body: 'PNG' });
    const { curator, kb, search } = await base();

    // Only http(s), internal hosts, never link-local.
    await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'web', location: 'ftp://intranet/' }).expect(400);
    expect((await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'web', location: 'http://169.254.169.254/latest/' }).expect(409)).body.detail).toMatch(/link-local/);

    const src = (await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'web', location: `${site.url}/`, maxDepth: 2, maxPages: 20 }).expect(201)).body;
    expect(src).toMatchObject({ kind: 'web', location: `${site.url}/`, config: { url: `${site.url}/`, maxDepth: 2, maxPages: 20, pathPrefix: '', sitemap: true } });
    await drain(h);
    const names = async () => ((await curator.get(`/api/knowledge/bases/${kb.id}/documents`).expect(200)).body as { name: string; state: string }[]).map((d) => d.name.replace(/^127\.0\.0\.1:\d+/, '')).sort();
    expect(await names()).toEqual(['/', '/canteen', '/listed', '/policies', '/policies/expenses']);
    expect(elsewhere.requests).toEqual([]); // never left its host: not by link, sitemap or redirect
    expect(site.requests.map((r) => r.path)).not.toContain('/private/salaries');
    expect(site.requests.map((r) => r.path)).not.toContain('/policies/expenses/archive');
    expect(site.requests.every((r) => String(r.headers['user-agent']).startsWith('ExprsnAI-Knowledge'))).toBe(true);
    expect(await search(curator, 'mileage pence per mile')).toEqual(expect.arrayContaining([expect.stringMatching(/\/policies\/expenses$/)]));
    const job = JSON.parse(((await h.s.db('jobs').where({ type: 'knowledge.sync' }).orderBy('created_at', 'desc').first()) as { result: string }).result);
    expect(job).toMatchObject({ added: 5 });
    expect(job.skippedUrls.map((x: { reason: string }) => x.reason)).toEqual(expect.arrayContaining(['skipped: robots.txt disallows it', 'skipped: it is on another site']));

    // Again: every page answers 304 to its validator, nothing is downloaded or re-indexed.
    const mark = site.requests.length;
    await curator.post(`/api/knowledge/sources/${src.id}/sync`).expect(202);
    await drain(h);
    const again = site.requests.slice(mark).filter((r) => !['/robots.txt', '/sitemap.xml', '/out'].includes(r.path));
    expect(again).toHaveLength(5);
    expect(again.every((r) => r.status === 304 && r.headers['if-none-match'])).toBe(true);
    expect(JSON.parse(((await h.s.db('jobs').where({ type: 'knowledge.sync' }).orderBy('created_at', 'desc').first()) as { result: string }).result)).toMatchObject({ added: 0, changed: 0, unchanged: 5, removed: 0 });

    // A page no longer linked is dropped; a changed page is re-indexed.
    site.html('/', 'Intranet', 'Welcome to the new intranet home page.', ['/policies'], '"home-2"');
    await curator.post(`/api/knowledge/sources/${src.id}/sync`).expect(202);
    await drain(h);
    expect(await names()).toEqual(['/', '/listed', '/policies', '/policies/expenses']);
    expect(await search(curator, 'soup Thursdays canteen')).not.toContain(expect.stringMatching(/canteen/));

    // The page limit holds.
    const small = (await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'web', location: `${site.url}/policies`, maxDepth: 3, maxPages: 1, sitemap: false }).expect(201)).body;
    await drain(h);
    expect(await h.s.db('knowledge_documents').where({ source_id: small.id })).toHaveLength(1);
  });

  it('B-1503: a row a policy hides from a group\'s role never reaches that group\'s chunks', async () => {
    const data = new Database(':memory:');
    stops.push(async () => {
      data.close();
    });
    data.exec(`create table notices (id integer primary key, title text, body text, region text);
      insert into notices values (1, 'Finance close', 'The quarterly close for the ledger is on the 28th.', 'finance'),
                                 (2, 'Network change', 'The firewall change window is on the 28th.', 'ops'),
                                 (3, 'Town hall', 'Everyone joins the town hall on the 28th.', 'all'),
                                 (4, 'Restructure', 'The HR restructure plan lands on the 28th.', 'hr');`);
    const policies: Record<string, (region: string) => boolean> = { kb_finance: (r) => r === 'finance' || r === 'all', kb_ops: (r) => r === 'ops' || r === 'all' };
    const reads: (string | null)[] = [];
    let check: RoleCheck = { account: 'kb_reader', object: { kind: 'table', rowSecurity: true, forced: false, owner: 'app_owner', securityInvoker: false }, roles: [] };
    class RoleDriver implements DataDriver {
      constructor(readonly spec: ConnectionSpec) {}
      async test() {
        return { version: 'PostgreSQL 17', readOnly: true, health: 'healthy' as const, detail: 'read-only' };
      }
      async introspect() {
        return [{ name: 'public.notices', kind: 'table' as const, columns: ['id', 'title', 'body', 'region'].map((name) => ({ name, type: 'text' })) }];
      }
      async query(): Promise<QueryResult> {
        throw new Error('not used');
      }
      async rows(_object: string, opts: { limit: number; role?: string | null }): Promise<QueryResult> {
        reads.push(opts.role ?? null);
        const all = data.prepare('select id, title, body, region from notices order by id').raw(true).all() as unknown[][];
        const policy = opts.role ? policies[opts.role] : null;
        const rows = opts.role ? all.filter((r) => !!policy && policy(String(r[3]))) : all;
        return { columns: ['id', 'title', 'body', 'region'], rows: rows.slice(0, opts.limit), capped: false, estimate: null };
      }
      async roleCheck(_object: string, roles: string[]): Promise<RoleCheck> {
        return { ...check, roles: roles.map((role) => check.roles.find((r) => r.role === role) ?? { role, exists: true, member: true, bypass: false, canSelect: true }) };
      }
    }
    const { curator, kb, search } = await base({ postgres: (spec) => new RoleDriver(spec) });
    await localUser(h, 'connadmin', ['connection-admin', 'member'], 'confidential');
    const a = await loginAdmin(h, 'connadmin');
    const conn = (await a.agent.post('/api/admin/connections').set('x-csrf-token', a.csrf).send({ name: 'intranet', engine: 'postgres', endpoint: 'db.data.internal:5432', database: 'intranet', label: 'internal', username: 'kb_reader', password: 'pw' }).expect(201)).body;
    await a.agent.post(`/api/admin/connections/${conn.id}/schema`).set('x-csrf-token', a.csrf).send({}).expect(200);
    await a.agent.put(`/api/admin/connections/${conn.id}/allow-list`).set('x-csrf-token', a.csrf).send({ objects: ['public.notices'], piiColumns: [] }).expect(200);
    const add = (extra: object) => curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'database', location: 'pg: notices', connectionId: conn.id, ...extra });
    const maps = [{ group: 'Finance', role: 'kb_finance' }, { group: 'ops', role: 'kb_ops' }];

    // The database must enforce row security for the role, and the account must be able to take it on.
    check = { ...check, roles: [{ role: 'kb_finance', exists: true, member: false, bypass: false, canSelect: true }] };
    expect((await add({ roleMappings: maps }).expect(409)).body.detail).toMatch(/GRANT kb_finance TO kb_reader/);
    check = { ...check, roles: [{ role: 'kb_ops', exists: true, member: true, bypass: true, canSelect: true }] };
    expect((await add({ roleMappings: maps }).expect(409)).body.detail).toMatch(/BYPASSRLS/);
    check = { ...check, roles: [], object: { ...check.object, rowSecurity: false } };
    expect((await add({ roleMappings: maps }).expect(409)).body.detail).toMatch(/ENABLE ROW LEVEL SECURITY/);
    check = { ...check, object: { ...check.object, rowSecurity: true, owner: 'kb_ops' } };
    expect((await add({ roleMappings: maps }).expect(409)).body.detail).toMatch(/FORCE ROW LEVEL SECURITY/);
    check = { ...check, object: { ...check.object, owner: 'app_owner' } };
    expect((await add({ roleMappings: maps, accessColumn: 'region' }).expect(409)).body.detail).toMatch(/not both/);
    expect((await add({ roleMappings: maps, replication: true }).expect(409)).body.detail).toMatch(/row security/);
    await add({ roleMappings: [{ group: 'x', role: 'bad role' }] }).expect(400);

    const src = (await add({ roleMappings: maps }).expect(201)).body;
    expect(src.config).toMatchObject({ roleMappings: [{ group: 'finance', role: 'kb_finance' }, { group: 'ops', role: 'kb_ops' }], watermarkColumn: null });
    await drain(h);
    expect(reads.slice(-2)).toEqual(['kb_finance', 'kb_ops']); // never read without a role
    const docs = (await h.s.db('knowledge_documents').where({ source_id: src.id }).orderBy('name')) as { name: string; acl: string }[];
    expect(docs.map((d) => [d.name, JSON.parse(d.acl)])).toEqual([
      ['public.notices #1', ['g:finance']],
      ['public.notices #2', ['g:ops']],
      ['public.notices #3', ['g:finance', 'g:ops']]
    ]); // row 4 is seen by no mapped role, so it is not indexed at all
    const chunkAcl = (await h.s.db('knowledge_chunks').join('knowledge_documents', 'knowledge_documents.id', 'knowledge_chunks.document_id').where('knowledge_documents.source_id', src.id).select('knowledge_documents.name', 'knowledge_chunks.acl')) as { name: string; acl: string }[];
    expect(chunkAcl.find((c) => c.name === 'public.notices #1')!.acl).toBe('["g:finance"]');

    const fin = await client(h, 'fin', ['member']);
    const ops = await client(h, 'ops', ['member']);
    await h.s.db('user_identities').where({ user_id: fin.user.id }).update({ groups: JSON.stringify(['finance']) });
    await h.s.db('user_identities').where({ user_id: ops.user.id }).update({ groups: JSON.stringify(['ops']) });
    expect((await search(fin, 'what happens on the 28th')).sort()).toEqual(['public.notices #1', 'public.notices #3']);
    expect((await search(ops, 'what happens on the 28th')).sort()).toEqual(['public.notices #2', 'public.notices #3']);

    // The database changes its policy: ops may now see the HR row, finance no longer sees the town hall.
    policies.kb_ops = (r) => r === 'ops' || r === 'all' || r === 'hr';
    policies.kb_finance = (r) => r === 'finance';
    await curator.post(`/api/knowledge/sources/${src.id}/sync`).expect(202);
    await drain(h);
    expect((await search(fin, 'what happens on the 28th')).sort()).toEqual(['public.notices #1']);
    expect((await search(ops, 'what happens on the 28th')).sort()).toEqual(['public.notices #2', 'public.notices #3', 'public.notices #4']);
    const town = (await h.s.db('knowledge_chunks').join('knowledge_documents', 'knowledge_documents.id', 'knowledge_chunks.document_id').where('knowledge_documents.name', 'public.notices #3').select('knowledge_chunks.acl')) as { acl: string }[];
    expect(town.every((c) => c.acl === '["g:ops"]')).toBe(true);
  });
});
