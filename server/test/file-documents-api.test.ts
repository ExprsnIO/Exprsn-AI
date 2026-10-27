import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { cidOf, sha256OfCid } from '../src/files/cid.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, type Harness } from './helpers.js';
import { seedRetrieval } from './retrieval-seed.js';

/*
 * 2.0.0, file management: documents created and edited through the API (Markdown, CSV, Excel, OpenDocument), copies
 * of files and folders, files added to a knowledge base, and the content identifier (CID) of a version.
 */

describe('File documents, copies, knowledge links and CIDs', () => {
  let h: Harness;
  let wsId: string;
  let ollama: FakeOllama;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Docs', 'confidential')).id;
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  async function member(name: string, roles = ['member'], clearance: 'internal' | 'confidential' = 'internal', ws: string[] = [wsId]) {
    const u = await localUser(h, name, roles, clearance);
    for (const w of ws) await h.s.tenants.addMember(w, u.id);
    const c = await login(h, name);
    const send = (method: 'post' | 'put' | 'patch', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    return {
      user: u,
      post: (p: string, b?: object) => send('post', p, b),
      put: (p: string, b?: object) => send('put', p, b),
      get: (p: string) => c.agent.get(p),
      upload: (name: string, data: Buffer | string) => c.agent.put(`/api/files/uploads?${new URLSearchParams({ name, workspace: wsId }).toString()}`).set('x-csrf-token', c.csrf).set('content-type', 'application/octet-stream').send(Buffer.from(data))
    };
  }

  it('creates a Markdown document, opens it as a model and saves edits as versions; a stale save is 409', async () => {
    const ann = await member('ann');
    const made = (await ann.post('/api/files/documents', { name: 'Notes', kind: 'markdown', workspaceId: wsId }).expect(202)).body;
    expect(made.name).toBe('Notes.md');
    expect(made.version.state).toBe('ready');
    expect(made.version.cid).toMatch(/^bafkrei/);
    const opened = (await ann.get(`/api/files/${made.id}/document`).expect(200)).body;
    expect(opened.kind).toBe('markdown');
    expect(opened.editable).toBe(true);
    expect(opened.doc.blocks[0]).toMatchObject({ type: 'heading', level: 1 });
    const doc = { blocks: [{ type: 'heading', level: 1, runs: [{ text: 'Notes' }] }, { type: 'paragraph', runs: [{ text: 'Plan ' }, { text: 'bold', b: true }] }, { type: 'list', ordered: false, items: [{ runs: [{ text: 'one' }] }, { runs: [{ text: 'two' }], checked: true }] }] };
    const saved = (await ann.put(`/api/files/${made.id}/document`, { kind: 'markdown', baseVersion: opened.version, doc }).expect(202)).body;
    expect(saved.version.number).toBe(2);
    expect(saved.file.currentVersion).toBe(2);
    const text = (await ann.get(`/api/files/${made.id}/content`).expect(200)).text;
    expect(text).toContain('**bold**');
    expect(text).toContain('[x] two');
    const stale = await ann.put(`/api/files/${made.id}/document`, { kind: 'markdown', baseVersion: 1, text: '# old' }).expect(409);
    expect(stale.body.latest).toBe(2);
    // Source text saves too, and the convert route goes both ways.
    const conv = (await ann.post('/api/files/document-convert', { kind: 'markdown', text: '# A\n\n*b*' }).expect(200)).body;
    expect(conv.doc.blocks).toHaveLength(2);
    expect((await ann.post('/api/files/document-convert', { kind: 'markdown', doc: conv.doc }).expect(200)).body.text).toContain('# A');
    const audits = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).whereIn('action', ['file.document.created', 'file.document.saved', 'file.document.opened'])) as { action: string }[];
    expect(new Set(audits.map((a) => a.action))).toEqual(new Set(['file.document.created', 'file.document.saved', 'file.document.opened']));
  });

  it('keeps CSV column definitions, normalises a table and writes Excel and OpenDocument files the scan accepts', async () => {
    const ann = await member('ann');
    const sheet = { name: 'Sheet1', header: true, columns: [{ name: 'Name', type: 'text' }, { name: 'Amount', type: 'number', required: true }, { name: 'Due', type: 'date' }], rows: [[{ v: 'Name' }, { v: 'Amount' }, { v: 'Due' }], [{ v: ' Ann ' }, { v: '1,200' }, { v: '2026-03-04' }], [{ v: 'Bob' }, { v: '' }, { v: '2026-03-05' }]] };
    const csv = (await ann.post('/api/files/documents', { name: 'ledger.csv', kind: 'csv', workspaceId: wsId, workbook: { sheets: [sheet] } }).expect(202)).body;
    const opened = (await ann.get(`/api/files/${csv.id}/document`).expect(200)).body;
    expect(opened.kind).toBe('csv');
    expect(opened.workbook.sheets[0].columns.map((c: { type: string }) => c.type)).toEqual(['text', 'number', 'date']);
    expect(opened.workbook.sheets[0].columns[1].required).toBe(true);
    const norm = (await ann.post('/api/files/table/normalize', { sheet: opened.workbook.sheets[0], options: {} }).expect(200)).body;
    expect(norm.sheet.rows[1][0].v).toBe('Ann');
    expect(norm.sheet.rows[1][1].v).toBe(1200);
    expect(norm.report.requiredMissing).toBe(1);
    const inferred = (await ann.post('/api/files/table/infer', { sheet: opened.workbook.sheets[0] }).expect(200)).body;
    expect(inferred.columns[2].type).toBe('date');

    for (const kind of ['xlsx', 'ods'] as const) {
      const wb = { sheets: [{ name: 'Data', header: true, columns: [{ name: 'Item', type: 'text' }, { name: 'Qty', type: 'number' }], rows: [[{ v: 'Item', b: true }, { v: 'Qty', b: true }], [{ v: 'Pens' }, { v: 3 }], [{ v: 'Total' }, { v: 3, f: 'SUM(B2:B2)' }]] }] };
      const f = (await ann.post('/api/files/documents', { name: `stock-${kind}`, kind, workspaceId: wsId, workbook: wb }).expect(202)).body;
      expect(f.version.state).toBe('ready');
      expect(f.name).toBe(`stock-${kind}.${kind}`);
      const back = (await ann.get(`/api/files/${f.id}/document`).expect(200)).body;
      expect(back.workbook.sheets[0].rows[2][1].f).toBe('SUM(B2:B2)');
      expect(back.workbook.sheets[0].rows[1][1].v).toBe(3);
    }
    const odt = (await ann.post('/api/files/documents', { name: 'Letter', kind: 'odt', workspaceId: wsId }).expect(202)).body;
    expect(odt.version.state).toBe('ready');
    expect(odt.type).toBe('application/vnd.oasis.opendocument.text');
    const letter = (await ann.get(`/api/files/${odt.id}/document`).expect(200)).body;
    expect(letter.doc.blocks[0]).toMatchObject({ type: 'heading', runs: [{ text: 'Letter' }] });
    // Bad models are 400; a type that is not edited here is 415.
    await ann.put(`/api/files/${odt.id}/document`, { kind: 'odt', baseVersion: 1, doc: { blocks: [{ type: 'heading', level: 9, runs: [] }] } }).expect(400);
    const json = (await ann.upload('data.json', '{"a":1}').expect(202)).body;
    await h.s.files.scanNow((await h.s.db('file_versions').where({ file_id: json.id }).first('id')).id);
    await ann.get(`/api/files/${json.id}/document`).expect(415);
  });

  it('opens a shared file read-only and refuses edits by readers', async () => {
    const ann = await member('ann');
    const other = (await h.s.tenants.createWorkspace(h.tenantId, 'Elsewhere', 'internal')).id;
    const bob = await member('bob', ['member'], 'internal', [other]);
    const f = (await ann.post('/api/files/documents', { name: 'Shared', kind: 'markdown', workspaceId: wsId }).expect(202)).body;
    await ann.post(`/api/files/${f.id}/shares`, { kind: 'user', userId: bob.user.id }).expect(201);
    const opened = (await bob.get(`/api/files/${f.id}/document`).expect(200)).body;
    expect(opened.editable).toBe(false);
    await bob.put(`/api/files/${f.id}/document`, { kind: 'markdown', baseVersion: 1, text: '# mine' }).expect(404);
  });

  it('duplicates files with their tags, copies folders, and finds files by CID', async () => {
    const ann = await member('ann');
    const folder = (await ann.post('/api/files/folders', { name: 'Plans', workspaceId: wsId }).expect(201)).body;
    const sub = (await ann.post('/api/files/folders', { name: 'Q3', parentId: folder.id }).expect(201)).body;
    const a = (await ann.post('/api/files/documents', { name: 'plan', kind: 'markdown', folderId: folder.id, text: '# Plan\n\nSame bytes\n' }).expect(202)).body;
    await ann.post('/api/files/documents', { name: 'q3', kind: 'text', folderId: sub.id, text: 'quarter' }).expect(202);
    await ann.put(`/api/files/${a.id}/tags`, { tags: ['plan', 'draft'] }).expect(200);
    const copy = (await ann.post(`/api/files/${a.id}/duplicate`, {}).expect(202)).body;
    expect(copy.name).toBe('plan copy.md');
    await h.s.files.scanNow((await h.s.db('file_versions').where({ file_id: copy.id }).first('id')).id);
    const details = (await ann.get(`/api/files/${copy.id}`).expect(200)).body;
    expect(details.tags).toEqual(['draft', 'plan']);
    expect(details.cid).toBe(cidOf(createHash('sha256').update('# Plan\n\nSame bytes\n').digest('hex')));
    const again = (await ann.post(`/api/files/${a.id}/duplicate`, {}).expect(202)).body;
    expect(again.name).toBe('plan copy (2).md');
    // Both copies and the original share one CID.
    await h.s.files.scanNow((await h.s.db('file_versions').where({ file_id: again.id }).first('id')).id);
    const found = (await ann.get(`/api/files/by-cid/${details.cid}`).expect(200)).body;
    expect(found.files.map((f: { id: string }) => f.id).sort()).toEqual([a.id, copy.id, again.id].sort());
    expect(sha256OfCid(details.cid)).toBe(details.sha256);
    await ann.get('/api/files/by-cid/not-a-cid-at-all').expect(400);

    const fc = (await ann.post(`/api/files/folders/${folder.id}/duplicate`, {}).expect(202)).body;
    expect(fc.name).toBe('Plans copy');
    expect(fc.folders).toBe(2);
    expect(fc.files).toBe(4);
    await ann.post(`/api/files/folders/${folder.id}/duplicate`, { parentId: sub.id }).expect(409);
  });

  it('adds a file to a knowledge base, converting OpenDocument, within the base label', async () => {
    await seedRetrieval(h, ollama);
    const cura = await member('cura', ['member', 'knowledge-curator'], 'confidential');
    const kb = (await cura.post('/api/knowledge/bases', { name: 'Handbook', label: 'internal', embedModel: 'nomic-embed-text' }).expect(201)).body;
    const odt = (await cura.post('/api/files/documents', { name: 'Policy', kind: 'odt', workspaceId: wsId, doc: { blocks: [{ type: 'heading', level: 1, runs: [{ text: 'Policy' }] }, { type: 'paragraph', runs: [{ text: 'Be kind.' }] }] } }).expect(202)).body;
    const added = (await cura.post(`/api/files/${odt.id}/knowledge`, { kbId: kb.id, categories: ['policies'] }).expect(201)).body;
    expect(added.convertedTo).toBe('text/markdown');
    expect(added.document.name).toBe('Policy.md');
    const links = (await cura.get(`/api/files/${odt.id}/knowledge`).expect(200)).body;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ kbId: kb.id, kbName: 'Handbook', version: 1, current: true });
    const secret = (await cura.post('/api/files/documents', { name: 'Secret', kind: 'markdown', workspaceId: wsId, label: 'confidential' }).expect(202)).body;
    await cura.post(`/api/files/${secret.id}/knowledge`, { kbId: kb.id }).expect(403);
    const plain = await member('pat');
    const mine = (await plain.post('/api/files/documents', { name: 'Mine', kind: 'markdown', workspaceId: wsId }).expect(202)).body;
    const refused = await plain.post(`/api/files/${mine.id}/knowledge`, { kbId: kb.id });
    expect([403, 404]).toContain(refused.status);
  });
});
