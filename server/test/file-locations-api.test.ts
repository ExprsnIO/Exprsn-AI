import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';

/*
 * 2.0.0: linked storage locations in Files, end to end through the API with a local store (a temporary directory an
 * operator offers): linking needs files:link, credentials never come back, browsing, copying in (at once and as a
 * job, folders kept), sending out, read-only stores, labels, and the operator's checks on a local store's path.
 */

describe('Files: linked storage locations', () => {
  let h: Harness;
  let wsId: string;
  let dir: string;

  beforeEach(async () => {
    h = await harness();
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Docs', 'confidential')).id;
    dir = await mkdtemp(path.join(tmpdir(), 'exprsn-locations-'));
    await mkdir(path.join(dir, 'reports', 'q3'), { recursive: true });
    await writeFile(path.join(dir, 'readme.md'), '# Read me\n');
    await writeFile(path.join(dir, 'reports', 'a.csv'), 'x,y\n1,2\n');
    await writeFile(path.join(dir, 'reports', 'q3', 'b.txt'), 'quarter three\n');
  });
  afterEach(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function client(name: string, roles: string[], clearance: 'internal' | 'confidential' = 'internal') {
    const u = await localUser(h, name, roles, clearance);
    await h.s.tenants.addMember(wsId, u.id);
    const c = roles.includes('tenant-admin') ? await loginAdmin(h, name) : await login(h, name);
    const send = (method: 'post' | 'patch' | 'delete', p: string, body: object = {}) => c.agent[method](p).set('x-csrf-token', c.csrf).send(body);
    return { user: u, get: (p: string) => c.agent.get(p), post: (p: string, b?: object) => send('post', p, b), patch: (p: string, b?: object) => send('patch', p, b), del: (p: string) => send('delete', p) };
  }

  it('links a local store, browses it, copies files in and sends one out; members without files:link cannot link', async () => {
    const root = await h.s.files.locations.addLocalRoot('op', { name: 'Shared drive', path: dir, readOnly: false, tenants: null });
    const admin = await client('tina', ['member', 'tenant-admin'], 'confidential');
    const ann = await client('ann', ['member']);
    expect((await admin.get('/api/files/local-roots').expect(200)).body).toEqual([{ id: root.id, name: 'Shared drive', readOnly: false }]);
    await ann.post('/api/files/locations', { workspaceId: wsId, name: 'Drive', kind: 'local', config: { rootId: root.id, path: '' } }).expect(403);
    const tested = (await admin.post('/api/files/locations/test', { kind: 'local', config: { rootId: root.id, path: '' } }).expect(200)).body;
    expect(tested.ok).toBe(true);
    const loc = (await admin.post('/api/files/locations', { workspaceId: wsId, name: 'Drive', kind: 'local', config: { rootId: root.id, path: '' } }).expect(201)).body;
    expect(loc).toMatchObject({ kind: 'local', writable: true, hasSecret: false, label: 'internal' });
    await admin.post('/api/files/locations', { workspaceId: wsId, name: 'drive', kind: 'local', config: { rootId: root.id, path: '' } }).expect(409);

    // Members browse it.
    const top = (await ann.get(`/api/files/locations/${loc.id}/browse`).expect(200)).body;
    expect(top.entries.map((e: { name: string; dir: boolean }) => `${e.dir ? 'd' : 'f'}:${e.name}`)).toEqual(['d:reports', 'f:readme.md']);
    const sub = (await ann.get(`/api/files/locations/${loc.id}/browse?path=reports`).expect(200)).body;
    expect(sub.entries.map((e: { name: string }) => e.name)).toEqual(['q3', 'a.csv']);
    await ann.get(`/api/files/locations/${loc.id}/browse?path=../etc`).expect(400);

    // One small file comes in at once; a folder goes as a job and keeps its subfolders.
    const one = (await ann.post(`/api/files/locations/${loc.id}/import`, { paths: ['readme.md'] }).expect(202)).body;
    expect(one.files[0]).toMatchObject({ name: 'readme.md', state: 'ready', label: 'internal' });
    const job = (await ann.post(`/api/files/locations/${loc.id}/import`, { paths: ['reports'] }).expect(202)).body;
    expect(job.jobId).toBeTruthy();
    await drain(h);
    await drain(h);
    const names = ((await h.s.db('files').where({ workspace_id: wsId }).select('name')) as { name: string }[]).map((r) => r.name).sort();
    expect(names).toEqual(['a.csv', 'b.txt', 'readme.md']);
    const q3 = await h.s.db('file_folders').where({ workspace_id: wsId, name: 'q3' }).first();
    expect(q3).toBeTruthy();

    // A Files file goes out under a new name; credentials and paths stay out of the answers.
    const sent = (await ann.post(`/api/files/${one.files[0].id}/send`, { locationId: loc.id, path: 'out/copy.md' }).expect(200)).body;
    expect(sent.path).toBe('out/copy.md');
    expect(await readFile(path.join(dir, 'out', 'copy.md'), 'utf8')).toBe('# Read me\n');
    const listed = (await ann.get('/api/files/locations').expect(200)).body;
    expect(JSON.stringify(listed)).not.toContain(dir);
    const audits = ((await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'like', 'file.location.%').select('action')) as { action: string }[]).map((a) => a.action);
    expect(new Set(audits)).toEqual(new Set(['file.location.created', 'file.location.imported', 'file.location.import.requested', 'file.location.sent']));
  });

  it('keeps read-only stores read-only, refuses files above the location label, and checks operator paths', async () => {
    const ro = await h.s.files.locations.addLocalRoot('op', { name: 'Archive', path: dir, readOnly: true, tenants: null });
    const admin = await client('tina', ['member', 'tenant-admin'], 'confidential');
    const loc = (await admin.post('/api/files/locations', { workspaceId: wsId, name: 'Archive', kind: 'local', config: { rootId: ro.id, path: 'reports' } }).expect(201)).body;
    expect(loc.writable).toBe(false);
    const doc = (await admin.post('/api/files/documents', { name: 'secret', kind: 'markdown', workspaceId: wsId, label: 'confidential' }).expect(202)).body;
    await admin.post(`/api/files/${doc.id}/send`, { locationId: loc.id }).expect(403);
    const pub = (await admin.post('/api/files/documents', { name: 'open', kind: 'markdown', workspaceId: wsId }).expect(202)).body;
    await admin.post(`/api/files/${pub.id}/send`, { locationId: loc.id }).expect(409);
    // A confidential location is invisible to an internal member.
    const conf = (await admin.post('/api/files/locations', { workspaceId: wsId, name: 'Vault', kind: 'local', label: 'confidential', config: { rootId: ro.id, path: '' } }).expect(201)).body;
    const ann = await client('ann', ['member']);
    expect((await ann.get('/api/files/locations').expect(200)).body.map((x: { name: string }) => x.name)).toEqual(['Archive']);
    await ann.get(`/api/files/locations/${conf.id}/browse`).expect(404);
    // Operators cannot offer the blob directory or a relative path; a root in use cannot be removed.
    await expect(h.s.files.locations.addLocalRoot('op', { name: 'Blobs', path: h.s.cfg.BLOB_DIR, readOnly: true, tenants: null })).rejects.toThrow(/storage directories/);
    await expect(h.s.files.locations.addLocalRoot('op', { name: 'Rel', path: 'relative/dir', readOnly: true, tenants: null })).rejects.toThrow(/absolute/);
    await expect(h.s.files.locations.removeLocalRoot(ro.id)).rejects.toThrow(/linked/);
  });

  it('validates credentials per kind and never returns them', async () => {
    const admin = await client('tina', ['member', 'tenant-admin'], 'confidential');
    await admin.post('/api/files/locations', { workspaceId: wsId, name: 'Bucket', kind: 's3', config: { endpoint: 'http://127.0.0.1:9', bucket: 'reports' } }).expect(400);
    const s3 = (await admin.post('/api/files/locations', { workspaceId: wsId, name: 'Bucket', kind: 's3', config: { endpoint: 'http://127.0.0.1:9', bucket: 'reports', pathStyle: true }, secret: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'super-secret-value' } }).expect(201)).body;
    expect(s3.hasSecret).toBe(true);
    expect(JSON.stringify(s3)).not.toContain('super-secret-value');
    const row = await h.s.db('file_locations').where({ id: s3.id }).first();
    expect(String(row.secret_sealed)).not.toContain('super-secret-value');
    const audit = (await h.s.db('audit_events').where({ action: 'file.location.created' }).first()) as { detail: string };
    expect(audit.detail).not.toContain('super-secret-value');
    // 127.0.0.1 is internal and not named by the operator: refused before anything is dialled.
    const t = await admin.post(`/api/files/locations/${s3.id}/test`).expect(403);
    expect(t.body.detail).toMatch(/internal address/);
    expect((await h.s.db('file_locations').where({ id: s3.id }).first()).state).toBe('failing');
  });
});
