import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '../src/authz/policy.js';
import { csvCell, downloadName, FileImports, redactDefinition } from '../src/files/imports.js';
import { HttpProblem } from '../src/http/problem.js';
import { loadPrincipal } from '../src/http/middleware.js';
import type { EntryRow } from '../src/registry/service.js';
import { FakeOllama } from './fake-ollama.js';
import { localUser, type Harness } from './helpers.js';
import { client, drain, harnessWith, seedRetrieval } from './retrieval-seed.js';
import { clients, SqliteTableDriver } from './sprint39c-helpers.js';

/*
 * 2.0.0: imports into Files from a URL, a database, a knowledge document, agent and workflow runs, a workflow bundle,
 * a skill and a tool (`files/imports.ts`). The service is called as a signed-in person; every import lands as an
 * ordinary file upload (scanned, labelled, never below its source).
 */

describe('Pure helpers of the imports', () => {
  it('names a download from Content-Disposition, the URL or the type', () => {
    expect(downloadName(new URL('https://h.example/a/b'), "attachment; filename*=UTF-8''Q3%20report.csv", 'text/csv')).toBe('Q3 report.csv');
    expect(downloadName(new URL('https://h.example/a/b'), 'attachment; filename="x.txt"', null)).toBe('x.txt');
    expect(downloadName(new URL('https://h.example/docs/notes'), undefined, 'text/markdown; charset=utf-8')).toBe('notes.md');
    expect(downloadName(new URL('https://h.example/'), undefined, 'application/pdf')).toBe('download.pdf');
    expect(downloadName(new URL('https://h.example/x'), 'attachment; filename="../../etc/passwd"', null)).toBe('.. .. etc passwd');
  });
  it('neutralises formula cells in CSV and withholds secrets of a definition', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(12)).toBe('12');
    expect(redactDefinition({ url: 'https://x', headers: { authorization: 'Bearer abc', 'x-trace': 'vault:secret/kv/x#token' }, apiKey: 'k', nested: [{ password: 'p', ok: 1 }] })).toEqual({ url: 'https://x', headers: { authorization: '[withheld]', 'x-trace': '[vault reference]' }, apiKey: '[withheld]', nested: [{ password: '[withheld]', ok: 1 }] });
  });
});

/** The SQLite stand-in, also reading the quoted "public"."table" a table import writes for PostgreSQL. */
class QuotedSqliteDriver extends SqliteTableDriver {
  override async query(c: unknown, text: string, opts: { limit: number; params?: unknown[]; offset?: number }) {
    return super.query(c, text.replace(/"public"\./g, ''), opts);
  }
}

describe('FileImports', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let outside: Database.Database;
  let web: Server;
  let base: string;
  let wsId: string;
  let imports: FileImports;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    outside = new Database(':memory:');
    outside.exec("create table customers (id integer primary key, name text, email text, note text); insert into customers (name, email, note) values ('Contoso', 'ops@contoso.example', '=HYPERLINK(\"x\")'), ('Fabrikam', 'it@fabrikam.example', 'plain');");
    h = await harnessWith({ drivers: { postgres: (spec) => new QuotedSqliteDriver(outside, spec) } }, { OLLAMA_POLL_MS: '600000', SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Imports', 'confidential')).id;
    imports = new FileImports(() => h.s);
    web = createServer((req, res) => {
      if (req.url === '/notes.md') {
        res.writeHead(200, { 'content-type': 'text/markdown' });
        res.end('# Notes\n\nFetched by URL.\n');
      } else if (req.url === '/go') {
        res.writeHead(302, { location: '/notes.md' });
        res.end();
      } else if (req.url === '/report') {
        res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': "attachment; filename*=UTF-8''Q3%20report.csv" });
        res.end('a,b\r\n1,2\r\n');
      } else {
        res.writeHead(404);
        res.end('nope');
      }
    });
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => web.close(() => r()));
    await h.close();
    await ollama.stop();
    outside.close();
  });

  async function principal(name: string, roles = ['member'], clearance: 'internal' | 'confidential' = 'internal', ws = wsId): Promise<Principal> {
    const u = await localUser(h, name, roles, clearance);
    await h.s.tenants.addMember(ws, u.id);
    return { ...(await loadPrincipal(h.s, h.tenantId, u.id, {}))!, workspaceId: ws };
  }
  const text = async (fileId: string, p: Principal) => {
    const got = await h.s.files.content(p, fileId);
    const parts: Buffer[] = [];
    for await (const c of got.stream) parts.push(c);
    return Buffer.concat(parts);
  };

  it('fetches a URL through the address guard, follows a redirect, names the file, and refuses a host not allowed', async () => {
    const p = await principal('ann');
    const a = await imports.url(p, { url: `${base}/go`, workspaceId: wsId });
    expect(a.file.name).toBe('notes.md');
    expect(a.version.state).toBe('ready');
    expect(a.file.type).toBe('text/markdown');
    expect(a.detail).toMatchObject({ from: 'url', redirects: 1 });
    expect((await text(a.file.id, p)).toString()).toContain('Fetched by URL');
    const b = await imports.url(p, { url: `${base}/report`, workspaceId: wsId });
    expect(b.file.name).toBe('Q3 report.csv');
    // The same name again gets a free one.
    expect((await imports.url(p, { url: `${base}/report`, workspaceId: wsId })).file.name).toBe('Q3 report (2).csv');
    await expect(imports.url(p, { url: 'http://8.8.8.8/x', workspaceId: wsId })).rejects.toMatchObject({ status: 403 });
    await expect(imports.url(p, { url: `${base}/missing`, workspaceId: wsId })).rejects.toMatchObject({ status: 502 });
    await expect(imports.url(p, { url: 'ftp://example.com/x', workspaceId: wsId })).rejects.toMatchObject({ status: 400 });
  });

  it('saves a table of a connection as CSV, Excel and JSON with masked values and neutralised formulas', async () => {
    const c = clients(h, wsId);
    const admin = await c.designer('cora', ['connection-admin', 'member']);
    const conn = (await admin.post('/api/admin/connections', { name: 'crm', engine: 'postgres', endpoint: 'crm.internal:5432', database: 'crm', label: 'internal', username: 'app', password: 'right' }).expect(201)).body as { id: string };
    await admin.post(`/api/admin/connections/${conn.id}/schema`).expect(200);
    await admin.put(`/api/admin/connections/${conn.id}/allow-list`, { objects: ['public.customers'] }).expect(200);
    const p = { ...(await loadPrincipal(h.s, h.tenantId, admin.user.id, {}))!, workspaceId: wsId };
    const ctx = { ip: null, traceId: 't1' };
    expect(await imports.sources(p, 'database')).toMatchObject([{ id: conn.id, name: 'crm' }]);
    expect((await imports.sources(p, 'database-object', { connection: conn.id })).map((x) => x.id)).toEqual(['public.customers']);
    const csv = await imports.database(p, { connectionId: conn.id, object: 'public.customers', format: 'csv', workspaceId: wsId }, ctx);
    expect(csv.file.name).toMatch(/^crm customers \d{4}-\d{2}-\d{2}\.csv$/);
    expect(csv.file.label).toBe('internal');
    const body = (await text(csv.file.id, p)).toString();
    expect(body).toContain('Contoso');
    expect(body).not.toContain('ops@contoso.example');
    expect(body).toContain('"\'=HYPERLINK(""x"")"');
    expect(csv.detail).toMatchObject({ from: 'database', rows: 2, masked: expect.arrayContaining(['email']) });
    const xlsx = await imports.database(p, { connectionId: conn.id, object: 'public.customers', format: 'xlsx', workspaceId: wsId }, ctx);
    expect(xlsx.file.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect((await text(xlsx.file.id, p)).subarray(0, 2).toString()).toBe('PK');
    const json = await imports.database(p, { connectionId: conn.id, sql: 'select name from customers', format: 'json', workspaceId: wsId }, ctx);
    expect(JSON.parse((await text(json.file.id, p)).toString())).toEqual([{ name: 'Contoso' }, { name: 'Fabrikam' }]);
    // Outside the allow-list, or without connections:manage, nothing is read.
    await expect(imports.database(p, { connectionId: conn.id, sql: 'select * from orders', format: 'csv', workspaceId: wsId }, ctx)).rejects.toBeInstanceOf(HttpProblem);
    const member = await principal('mo');
    await expect(imports.database(member, { connectionId: conn.id, object: 'public.customers', format: 'csv', workspaceId: wsId }, ctx)).rejects.toMatchObject({ status: 403 });
    await expect(imports.database(p, { connectionId: conn.id, format: 'csv', workspaceId: wsId }, ctx)).rejects.toMatchObject({ status: 400 });
  });

  it('saves a knowledge document as Markdown, text or its original at its label', async () => {
    await seedRetrieval(h, ollama);
    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    await h.s.tenants.addMember(wsId, curator.user.id);
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Handbook', label: 'internal', embedModel: 'nomic-embed-text' }).expect(201)).body as { id: string };
    await curator.agent.put(`/api/knowledge/bases/${kb.id}/uploads?name=travel.md&label=internal`).set('x-csrf-token', curator.csrf).set('content-type', 'application/octet-stream').send(Buffer.from('# Travel\n\n## Taxis\n\nTake a taxi after 22:00.\n\n## Trains\n\nSecond class.\n')).expect(202);
    await drain(h);
    const p = { ...(await loadPrincipal(h.s, h.tenantId, curator.user.id, {}))!, workspaceId: wsId };
    const listed = await imports.sources(p, 'knowledge', { q: 'travel' });
    expect(listed).toMatchObject([{ name: 'travel.md', sub: 'Handbook', label: 'internal' }]);
    const md = await imports.knowledge(p, { documentId: listed[0]!.id, as: 'markdown', workspaceId: wsId });
    expect(md.file.name).toBe('travel.md');
    expect(md.file.label).toBe('internal');
    const t = (await text(md.file.id, p)).toString();
    expect(t).toContain('# travel');
    expect(t).toContain('Take a taxi after 22:00.');
    const plain = await imports.knowledge(p, { documentId: listed[0]!.id, as: 'text', workspaceId: wsId });
    expect(plain.file.name).toBe('travel.txt');
    // The original, byte for byte (2.0.0: KnowledgeService.originalOf); it gets a free name beside the Markdown copy.
    const orig = await imports.knowledge(p, { documentId: listed[0]!.id, as: 'original', workspaceId: wsId });
    expect(orig.file.name).toBe('travel (2).md');
    expect((await text(orig.file.id, p)).toString()).toBe('# Travel\n\n## Taxis\n\nTake a taxi after 22:00.\n\n## Trains\n\nSecond class.\n');
  });

  it('saves agent and workflow runs as Markdown and JSON at their label', async () => {
    const p = await principal('ann', ['member'], 'confidential');
    const run = { id: 'R1', agent: 'Researcher', agentVersion: '1.2.0', profile: 'chat', state: 'succeeded', label: 'confidential', by: 'Ann', error: null, startedAt: 1, finishedAt: 2, input: 'Summarise Q3', output: 'Q3 grew 4 %.', steps: [{ n: 1, lane: 'do', title: 'knowledge_search', state: 'done', meta: {}, detail: { args: { query: 'Q3' }, result: 'hits' }, createdAt: 1, finishedAt: 2 }] };
    vi.spyOn(h.s.agents, 'view').mockResolvedValue(run as never);
    const md = await imports.agentRun(p, { runId: 'R1', format: 'markdown', workspaceId: wsId });
    expect(md.file.label).toBe('confidential');
    const t = (await text(md.file.id, p)).toString();
    expect(t).toContain('# Agent run: Researcher');
    expect(t).toContain('Q3 grew 4 %.');
    expect(t).toContain('### 1. knowledge_search');
    const js = await imports.agentRun(p, { runId: 'R1', format: 'json', workspaceId: wsId });
    expect(JSON.parse((await text(js.file.id, p)).toString()).output).toBe('Q3 grew 4 %.');

    const wfRun = { id: 'W1', workflowId: 'WF', version: 3, mode: 'live', state: 'succeeded', label: 'internal', createdByName: 'Ann', error: null, startedAt: 1, finishedAt: 2, input: { region: 'EU' }, steps: [{ nodeId: 'fetch', state: 'passed', error: null, output: { rows: 3 } }] };
    vi.spyOn(h.s.workflows, 'runView').mockResolvedValue(wfRun as never);
    const w = await imports.workflowRun(p, { runId: 'W1', format: 'markdown', workspaceId: wsId });
    const wt = (await text(w.file.id, p)).toString();
    expect(wt).toContain('### fetch (passed)');
    expect(wt).toContain('"region": "EU"');
    // A member who may not run agents is refused before anything is read.
    const pub = await principal('pat', ['guest'], 'internal');
    await expect(imports.agentRun(pub, { runId: 'R1', format: 'json', workspaceId: wsId })).rejects.toMatchObject({ status: 403 });
  });

  it('saves a skill as Markdown and a tool as JSON without secrets, never below their label', async () => {
    const p = await principal('ann', ['member'], 'confidential');
    const entry = (over: Partial<EntryRow>): EntryRow => ({ id: 'E1', tenant_id: h.tenantId, workspace_id: null, kind: 'skill', name: 'variance', version: '1.0.0', description: 'Explains variances.', impl: 'builtin', side_effect: null, confirm: 'never', rate_per_hour: null, label: 'internal', input_schema: null, output_schema: null, definition: { instructions: 'Compute actual minus budget.', tools: ['calculate'] }, status: 'published', schema_hash: 'x', approved_hash: null, checks: [], checked_at: null, owner_id: null, owner_name: null, submitted_at: null, reviewed_by: null, reviewed_at: null, review_note: null, publish_scope: 'tenant', publish_workspaces: [], replacement: null, created_at: 1, updated_at: 1, ...over }) as EntryRow;
    const skill = entry({});
    const tool = entry({ id: 'E2', kind: 'tool', name: 'crm_lookup', impl: 'http' as EntryRow['impl'], label: 'confidential', input_schema: { type: 'object' } as never, definition: { url: 'https://crm.example/{id}', headers: { authorization: 'vault:secret/crm#token' }, secretKey: 'abc' } });
    vi.spyOn(h.s.registry, 'get').mockImplementation(async (_t, id) => (id === 'E1' ? skill : id === 'E2' ? tool : undefined));
    vi.spyOn(h.s.registry, 'resolve').mockImplementation(async (_s, name) => (name === 'variance' ? skill : name === 'crm_lookup' ? tool : undefined));
    const md = await imports.skill(p, { skillId: 'E1', workspaceId: wsId });
    expect(md.file.name).toBe('variance.skill.md');
    const st = (await text(md.file.id, p)).toString();
    expect(st).toMatch(/^---\nname: variance\n/);
    expect(st).toContain('tools:\n  - calculate');
    expect(st).toContain('Compute actual minus budget.');
    const js = await imports.tool(p, { toolId: 'E2', workspaceId: wsId });
    expect(js.file.label).toBe('confidential');
    const def = JSON.parse((await text(js.file.id, p)).toString());
    expect(def.definition).toEqual({ url: 'https://crm.example/{id}', headers: { authorization: '[withheld]' }, secretKey: '[withheld]' });
    expect(JSON.stringify(def)).not.toContain('abc');
    // A confidential tool cannot land in a workspace whose ceiling is internal, nor be asked for below its label.
    const low = (await h.s.tenants.createWorkspace(h.tenantId, 'Low', 'internal')).id;
    await h.s.tenants.addMember(low, p.userId);
    await expect(imports.tool({ ...p, workspaceId: low }, { toolId: 'E2', workspaceId: low })).rejects.toMatchObject({ status: 403 });
    const asked = await imports.skill(p, { skillId: 'E1', workspaceId: wsId, label: 'public' });
    expect(asked.file.label).toBe('internal');
    expect((await imports.sources(p, 'skill')).map((x) => x.name)).toEqual([]);
  });
});
