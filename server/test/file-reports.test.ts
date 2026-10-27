import { createHash } from 'node:crypto';
import type request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Label } from '../src/authz/labels.js';
import type { Principal } from '../src/authz/policy.js';
import { Cid, CODEC_RAW } from '../src/atproto/encoding.js';
import { cidOfSha256, csvCell, FileReports, lastMonths, renderReport } from '../src/files/reports.js';
import { harness, localUser, login, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';

/*
 * 2.0.0 (file management): reports and the dashboard over a workspace's or a folder's files (files/reports.ts,
 * routes/file-reports.ts).
 */

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('file reports: pure helpers', () => {
  it('neutralises formulas in CSV cells and quotes per RFC 4180', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-a')).toBe("'-a");
    expect(csvCell('@sum')).toBe("'@sum");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
  });

  it('gives the raw-codec CIDv1 of a SHA-256 and the last twelve months', () => {
    const sha = createHash('sha256').update('hello').digest();
    expect(cidOfSha256(sha.toString('hex'))).toBe(Cid.create(CODEC_RAW, sha).toString());
    expect(cidOfSha256(sha.toString('hex'))).toMatch(/^bafkrei[a-z2-7]+$/);
    expect(cidOfSha256('nope')).toBeNull();
    const m = lastMonths(Date.UTC(2026, 0, 15));
    expect(m).toHaveLength(12);
    expect(m[0]).toBe('2025-02');
    expect(m[11]).toBe('2026-01');
  });
});

describe('file reports and dashboard', () => {
  let h: Harness;
  let wsId: string;
  let otherWs: string;

  beforeEach(async () => {
    h = await harness();
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Reports', 'confidential')).id;
    otherWs = (await h.s.tenants.createWorkspace(h.tenantId, 'Elsewhere', 'internal')).id;
  });
  afterEach(async () => {
    await h.close();
  });

  async function member(name: string, ws: string[] = [wsId], roles = ['member'], clearance: Label = 'internal') {
    const u = await localUser(h, name, roles, clearance);
    for (const w of ws) await h.s.tenants.addMember(w, u.id);
    const c = await login(h, name);
    const p: Principal = { kind: 'user', userId: u.id, tenantId: h.tenantId, tenantSlug: 'default', username: name, displayName: name, roles, clearance, scopes: null, sessionId: null, apiKeyId: null, mfa: false, workspaceId: ws[0] ?? null };
    return {
      user: u,
      p,
      get: (path: string) => c.agent.get(path),
      post: (path: string, body: object = {}) => c.agent.post(path).set('x-csrf-token', c.csrf).send(body),
      folder: async (name: string, parentId?: string) => (await c.agent.post('/api/files/folders').set('x-csrf-token', c.csrf).send({ name, workspaceId: wsId, ...(parentId ? { parentId } : {}) }).expect(201)).body as { id: string },
      upload: async (name: string, data: string, q: Record<string, string> = {}) => (await c.agent.put(`/api/files/uploads?${new URLSearchParams({ name, workspace: wsId, ...q }).toString()}`).set('x-csrf-token', c.csrf).set('content-type', 'application/octet-stream').send(Buffer.from(data)).expect(202)).body as { id: string },
      download: (path: string) => c.agent.get(path).buffer(true).parse(binary)
    };
  }

  /** ann's tree: root/readme.md, Docs/plan.md, Docs/Deep/notes.csv, Docs/Deep/copy.md (same bytes as plan.md), and bob's confidential secret. */
  async function seed() {
    const ann = await member('ann');
    const bob = await member('bob', [wsId], ['member'], 'confidential');
    const docs = await ann.folder('Docs');
    const deep = await ann.folder('Deep', docs.id);
    const other = await ann.folder('Other');
    const readme = await ann.upload('readme.md', '# Read me\n');
    const plan = await ann.upload('plan.md', '# Plan\n\nThe same text twice.\n', { folder: docs.id });
    const notes = await ann.upload('notes.csv', 'a,b\n=cmd(),2\n', { folder: deep.id });
    const copy = await ann.upload('copy.md', '# Plan\n\nThe same text twice.\n', { folder: deep.id });
    const secret = await bob.upload('secret.txt', 'top secret plans', { folder: docs.id, label: 'confidential' });
    await drain(h);
    return { ann, bob, docs, deep, other, readme, plan, notes, copy, secret };
  }

  it('summarises a folder and its subfolders, within the reader\'s clearance', async () => {
    const t = await seed();
    const reports = new FileReports(() => h.s);
    // An old, tagged file and a live link.
    await h.s.db('files').where({ id: t.plan.id }).update({ updated_at: Date.now() - 400 * 86_400_000 });
    await h.s.files.setTags(t.ann.p, t.plan.id, ['finance']);
    await h.s.files.createShare(t.ann.p, t.plan.id, { kind: 'link', expiresInHours: 24 });
    await h.s.files.trashFile(t.ann.p, (await t.ann.upload('gone.md', '# gone\n', { folder: t.docs.id })).id);

    const sum = await reports.summary(t.ann.p, { folderId: t.docs.id });
    expect(sum.scope.folderName).toBe('Docs');
    expect(sum.totals.files).toBe(3); // plan, notes, copy; bob's confidential file is above ann's clearance
    expect(sum.totals.folders).toBe(1);
    expect(sum.totals.tagged).toBe(1);
    expect(sum.totals.shared).toBe(1);
    expect(sum.totals.trashFiles).toBe(1);
    expect(sum.byType.map((x) => x.name).sort()).toEqual(['CSV', 'Markdown']);
    expect(sum.byType.find((x) => x.name === 'Markdown')!.files).toBe(2);
    const direct = sum.byFolder.find((x) => x.direct)!;
    expect(direct.files).toBe(1);
    expect(sum.byFolder.find((x) => x.name === 'Deep')!.files).toBe(2);
    expect(sum.duplicates).toMatchObject({ groups: 1, files: 2 });
    expect(sum.stale.files).toBe(1);
    expect(sum.byTag).toEqual([{ tag: 'finance', files: 1 }]);
    expect(sum.shares.activeLinks).toBe(1);
    expect(sum.timeline).toHaveLength(12);
    expect(sum.timeline[11]!.created).toBeGreaterThanOrEqual(3);

    const bobSum = await reports.summary(t.bob.p, { folderId: t.docs.id });
    expect(bobSum.totals.files).toBe(4);
    expect(bobSum.label).toBe('confidential');

    const ws = await reports.summary(t.ann.p, { workspaceId: wsId });
    expect(ws.totals.files).toBe(4);
    expect(ws.byFolder.map((x) => x.name)).toEqual(['Reports', 'Docs', 'Other']);
  });

  it('lists an inventory with paths and CIDs and renders it as formula-safe CSV and as Excel', async () => {
    const t = await seed();
    const reports = new FileReports(() => h.s);
    const inv = await reports.report(t.ann.p, { folderId: t.docs.id }, 'inventory');
    expect(inv.rows.map((r) => r.path)).toEqual(['Deep/copy.md', 'Deep/notes.csv', 'plan.md']);
    const notes = inv.rows.find((r) => r.name === 'notes.csv')!;
    const sha = createHash('sha256').update('a,b\n=cmd(),2\n').digest();
    expect(notes.sha256).toBe(sha.toString('hex'));
    expect(notes.cid).toBe(Cid.create(CODEC_RAW, sha).toString());

    // A file name that a spreadsheet would read as a formula.
    await t.ann.upload('=HYPERLINK(1).md', '# x\n', { folder: t.docs.id });
    await drain(h);
    const csv = renderReport(await reports.report(t.ann.p, { folderId: t.docs.id }, 'inventory'), 'csv').data.toString('utf8');
    expect(csv.split('\r\n')[0]).toMatch(/^Path,Name,Type,Size/);
    expect(csv).toContain(`'=HYPERLINK(1).md`);
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);

    const dup = await reports.report(t.ann.p, { folderId: t.docs.id }, 'duplicates');
    expect(dup.rows.map((r) => r.path).sort()).toEqual(['Deep/copy.md', 'plan.md']);
    const act = await reports.report(t.ann.p, { workspaceId: wsId }, 'activity');
    expect(act.rows[0]).toMatchObject({ person: 'ANN', versions: 5 });
  });

  it('serves reports over HTTP: JSON, CSV and XLSX exports, and saves one as a file', async () => {
    const t = await seed();
    const s1 = await t.ann.get(`/api/file-reports/summary?folder=${t.docs.id}`).expect(200);
    expect(s1.body.totals.files).toBe(3);
    const j = await t.ann.get(`/api/file-reports/by-type?workspace=${wsId}`).expect(200);
    expect(j.body.columns.map((c: { key: string }) => c.key)).toContain('bytes');

    const csv = await t.ann.download(`/api/file-reports/inventory?folder=${t.docs.id}&format=csv`).expect(200);
    expect(csv.headers['content-disposition']).toMatch(/attachment/);
    expect((csv.body as Buffer).toString('utf8')).toContain('Deep/notes.csv');
    const xlsx = await t.ann.download(`/api/file-reports/inventory?folder=${t.docs.id}&format=xlsx`).expect(200);
    expect((xlsx.body as Buffer).subarray(0, 2).toString('latin1')).toBe('PK');
    expect((await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'file.report.exported' })).length).toBe(2);

    // bob sees his confidential file, so his saved report is confidential.
    const saved = await t.bob.post('/api/file-reports/inventory/save', { folderId: t.docs.id, format: 'csv' }).expect(202);
    expect(saved.body.label).toBe('confidential');
    expect(saved.body.folderId).toBe(t.docs.id);
    expect(saved.body.name).toMatch(/^File inventory - Docs \d{4}-\d{2}-\d{2}\.csv$/);
    await drain(h);
    expect((await h.s.db('files').where({ id: saved.body.id }).first()).state).toBe('ready');
    const again = await t.bob.post('/api/file-reports/inventory/save', { folderId: t.docs.id, format: 'csv' }).expect(202);
    expect(again.body.name).toMatch(/ \(2\)\.csv$/);
    const annSaved = await t.ann.post('/api/file-reports/by-type/save', { workspaceId: wsId, format: 'xlsx', name: 'Types' }).expect(202);
    expect(annSaved.body).toMatchObject({ name: 'Types.xlsx', label: 'internal', folderId: null });
    expect((await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'file.report.saved' })).length).toBe(3);
  });

  it('refuses readers without files:read, non-members and unknown reports', async () => {
    const t = await seed();
    const curator = await member('cur', [wsId], ['knowledge-curator']);
    await curator.get(`/api/file-reports/summary?workspace=${wsId}`).expect(403);
    const eve = await member('eve', [otherWs]);
    await eve.get(`/api/file-reports/summary?workspace=${wsId}`).expect(404);
    await eve.get(`/api/file-reports/inventory?folder=${t.docs.id}`).expect(404);
    await t.ann.get(`/api/file-reports/nope?workspace=${wsId}`).expect(400);
    await t.ann.get(`/api/file-reports/inventory?workspace=${wsId}&format=pdf`).expect(400);
  });
});
