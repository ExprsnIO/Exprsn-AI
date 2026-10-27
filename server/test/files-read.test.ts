import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Label } from '../src/authz/labels.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { FakeRunner } from './fake-runner.js';
import { markedPng } from './fake-ollama.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';
import { client, docx, drain, zip } from './retrieval-seed.js';

type Client = Awaited<ReturnType<typeof client>>;

describe('The built-in tool files.read (migration 047)', () => {
  let h: Harness;
  let runner: FakeRunner;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    runner = new FakeRunner();
    h.s.scripts.runner = runner;
  });
  afterEach(async () => {
    await h.close();
  });

  const caller = async (c: Client) => {
    const p = (await loadPrincipal(h.s, h.tenantId, c.user.id, {}))!;
    return async (args: Record<string, unknown>, label: Label = 'internal') => {
      const { tools } = await h.s.tools.resolve(p, ['files.read'], label);
      return h.s.tools.call({ principal: p, label, approved: true, source: { kind: 'agent-run', id: 'R1' } }, tools[0]!, args);
    };
  };

  async function setup() {
    const member = await client(h, 'mia', ['member'], 'confidential');
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Research', 'confidential')).id;
    await h.s.tenants.addMember(ws, member.user.id);
    const put = async (name: string, data: Buffer, label: Label = 'internal') => {
      const r = await member.agent.put(`/api/files/uploads?${new URLSearchParams({ name, workspace: ws, label }).toString()}`).set('x-csrf-token', member.csrf).set('content-type', 'application/octet-stream').send(data).expect(202);
      await drain(h);
      return (r.body as { id: string }).id;
    };
    return { member, put, call: await caller(member) };
  }

  /** Publishes a script tool named document_process whose (fake) sandbox answers from `runner.handler`. */
  async function publishReader(label: Label = 'internal') {
    const user = async (name: string, roles: string[]) => {
      await localUser(h, name, roles, 'confidential');
      const c = await loginAdmin(h, name);
      return { ...c, post: (path: string, body: object = {}) => c.agent.post(path).set('x-csrf-token', c.csrf).send(body) };
    };
    const w = await user('wf', ['workflow-admin']);
    const ta = await user('ta', ['tool-admin']);
    runner.handler = () => ({ stdout: '{"content": "ok"}' });
    const sc = (await w.post('/api/scripts', { name: 'document-process', language: 'python', source: 'import json, sys\nprint(json.dumps({"content": "ok"}))', label }).expect(201)).body as { id: string };
    await w.post(`/api/scripts/${sc.id}/run`, { stdin: '{}' }).expect(202);
    await h.s.jobs.runDue();
    const entry = (await w.post(`/api/scripts/${sc.id}/promote`, { toolName: 'document_process', description: 'Reads one document and returns its text as Markdown with its outline, metadata and counts.', sideEffect: 'read', label, inputSchema: { type: 'object', properties: { name: { type: 'string' }, base64: { type: 'string' } } }, outputSchema: { type: 'object' } }).expect(201)).body as { id: string };
    await ta.post(`/api/admin/registry/${entry.id}/review`, { decision: 'approve' }).expect(200);
  }

  it('is seeded as a published read tool of the platform', async () => {
    const row = (await h.s.db('registry_entries').where({ impl: 'builtin', name: 'files.read' }).first()) as { side_effect: string; status: string; tenant_id: string | null; input_schema: string };
    expect(row).toMatchObject({ side_effect: 'read', status: 'published', tenant_id: null });
    expect(JSON.parse(row.input_schema).required).toEqual(['fileId']);
  });

  it('reads text, Markdown, HTML and Word files, in parts, and records the read', async () => {
    const { put, call } = await setup();
    const notes = await put('notes.md', Buffer.from(`# Notes\n\n${'The ledger closes on the third working day. '.repeat(20)}`));
    const first = (await call({ fileId: notes, maxChars: 200 })).result as { file: { name: string; version: number; label: string }; format: string; readBy: string; content: string; total: number; from: number; next: number | null; note?: string };
    expect(first).toMatchObject({ file: { name: 'notes.md', version: 1, label: 'internal' }, format: 'markdown', readBy: 'files.read', from: 0, next: 200 });
    expect(first.content).toHaveLength(200);
    expect(first.content.startsWith('# Notes')).toBe(true);
    expect(first.note).toMatch(/from 200/);
    const rest = (await call({ fileId: notes, from: first.total - 50, maxChars: 200 })).result as { content: string; next: number | null; note?: string };
    expect(rest.content).toHaveLength(50);
    expect(rest.next).toBeNull();
    expect(rest.note).toBeUndefined();
    expect((await call({ fileId: notes, from: first.total + 1 })).error).toMatch(/past its end/);

    const page = await put('page.html', Buffer.from('<html><head><title>T</title><style>p{}</style></head><body><h1>Close</h1><p>Day <b>three</b>.</p></body></html>'));
    const html = (await call({ fileId: page })).result as { format: string; content: string };
    expect(html.format).toBe('text');
    expect(html.content).toContain('# Close');
    expect(html.content).toContain('Day three');
    expect(html.content).not.toContain('<p>');

    const word = await put('policy.docx', docx([{ text: 'Expense policy', style: 'Heading1' }, { text: 'Taxis after 22:00 need no approval.' }]));
    expect(((await call({ fileId: word })).result as { content: string; readBy: string })).toMatchObject({ content: '# Expense policy\n\nTaxis after 22:00 need no approval.', readBy: 'files.read' });

    const audited = (await h.s.db('audit_events').where({ action: 'file.downloaded' }).orderBy('seq', 'desc').first()) as { target: string; detail: string };
    expect(JSON.parse(audited.target)).toMatchObject({ file: word, version: 1 });
    expect(JSON.parse(audited.detail)).toMatchObject({ tool: 'files.read', via: 'tool', source: { kind: 'agent-run', id: 'R1' } });
  });

  it('refuses what it cannot read or may not show', async () => {
    const { put, call } = await setup();
    expect((await call({ fileId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })).error).toMatch(/not found/i);
    const image = await put('plan.png', markedPng({ caption: 'A floor plan', ocr: 'Room' }));
    expect((await call({ fileId: image })).error).toMatch(/is an image.*knowledge base/);
    const sheet = await put('budget.xlsx', zip({ 'xl/workbook.xml': '<workbook/>' }));
    expect((await call({ fileId: sheet })).error).toMatch(/only through the tool document_process, which is not published/);
    // A confidential file is not read into an internal conversation, and is at its own label.
    const secret = await put('board.md', Buffer.from('# Board\n\nThe offer is 40 million.'), 'confidential');
    expect((await call({ fileId: secret })).error).toMatch(/confidential/);
    expect(((await call({ fileId: secret }, 'confidential')).result as { content: string }).content).toContain('40 million');
  });

  it('hands Office files to the tool document_process where it is published and cleared for the file', async () => {
    const { put, call } = await setup();
    await publishReader('internal');
    const sheet = await put('budget.xlsx', zip({ 'xl/workbook.xml': '<workbook/>' }));
    let seen: { name?: string; base64?: string; max_rows?: number } = {};
    runner.handler = (req) => {
      seen = JSON.parse(req.stdin ?? '{}') as typeof seen;
      return { stdout: JSON.stringify({ format: 'xlsx', kind: 'Excel workbook', title: 'budget.xlsx', metadata: { author: 'Mia' }, counts: { sheets: 1 }, outline: [{ level: 1, text: 'Budget' }], warnings: ['content cut at 10 of 20 characters; raise max_chars'], truncated: false, content: '# Budget\n\n| Item | Cost |\n| --- | --- |\n| Desk | 300 |' }) };
    };
    const out = (await call({ fileId: sheet, maxRows: 50 })).result as Record<string, unknown>;
    expect(out).toMatchObject({ readBy: 'document_process', format: 'markdown', kind: 'Excel workbook', metadata: { author: 'Mia' }, counts: { sheets: 1 }, outline: [{ level: 1, text: 'Budget' }], next: null });
    expect(String(out.content)).toContain('| Desk | 300 |');
    expect(out.warnings).toBeUndefined();
    expect(seen).toMatchObject({ name: 'budget.xlsx', max_rows: 50 });
    expect(Buffer.from(seen.base64 ?? '', 'base64').subarray(0, 2).toString('latin1')).toBe('PK');

    // What the reader reports as an error comes back as one.
    runner.handler = () => ({ stdout: '{"error": "the file is password protected"}' });
    expect((await call({ fileId: sheet })).error).toMatch(/budget\.xlsx: the file is password protected/);

    // The reader's ceiling is internal: a confidential spreadsheet is not handed to it; a Word file is read here.
    const secret = await put('salaries.xlsx', zip({ 'xl/workbook.xml': '<workbook/>' }), 'confidential');
    expect((await call({ fileId: secret }, 'confidential')).error).toMatch(/not published in this tenant for confidential content/);
    const word = await put('offer.docx', docx([{ text: 'Offer' }]), 'confidential');
    expect(((await call({ fileId: word }, 'confidential')).result as { readBy: string; content: string })).toMatchObject({ readBy: 'files.read', content: 'Offer' });
  });
});
