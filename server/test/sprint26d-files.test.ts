import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { collect, decryptStream, encryptStream, FileIntegrityError, newFileKey, SEGMENT_BYTES } from '../src/files/crypt.js';
import { contentDisposition } from '../src/routes/files.js';
import { FakeOllama } from './fake-ollama.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';
import { client, drain, seedRetrieval } from './retrieval-seed.js';
import { FakeClamd, FakePreviewRenderer, TINY_PNG } from './sprint26d-fakes.js';

type Res = request.Response;
const binary = (res: Res, cb: (err: Error | null, body: Buffer) => void) => {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function* chunks(b: Buffer, size = 7000) {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}

describe('file content sealing', () => {
  it('round-trips in segments and refuses truncated, reordered or moved content', async () => {
    const key = newFileKey();
    const plain = Buffer.alloc(SEGMENT_BYTES * 2 + 123, 7);
    for (let i = 0; i < plain.length; i++) plain[i] = i % 251;
    const sealed = await collect(encryptStream(chunks(plain), key, 'v:1'));
    expect(sealed.length).toBe(plain.length + 3 * 16);
    expect(await collect(decryptStream(chunks(sealed, 5000), key, 'v:1'))).toEqual(plain);
    // cut off after the first full segment: the first segment was not sealed as final
    await expect(collect(decryptStream(chunks(sealed.subarray(0, SEGMENT_BYTES + 16)), key, 'v:1'))).rejects.toBeInstanceOf(FileIntegrityError);
    // another version's associated data
    await expect(collect(decryptStream(chunks(sealed), key, 'v:2'))).rejects.toBeInstanceOf(FileIntegrityError);
    // swapped segments
    const seg = SEGMENT_BYTES + 16;
    const swapped = Buffer.concat([sealed.subarray(seg, 2 * seg), sealed.subarray(0, seg), sealed.subarray(2 * seg)]);
    await expect(collect(decryptStream(chunks(swapped), key, 'v:1'))).rejects.toBeInstanceOf(FileIntegrityError);
    // an empty file is one empty final segment
    const empty = await collect(encryptStream(chunks(Buffer.alloc(0)), key, 'e'));
    expect(empty.length).toBe(16);
    expect((await collect(decryptStream(chunks(empty), key, 'e'))).length).toBe(0);
  });

  it('escapes names in Content-Disposition', () => {
    const d = contentDisposition('attachment', 'a"b\\c;é.txt');
    expect(d).toBe(`attachment; filename="a_b_c__.txt"; filename*=UTF-8''a%22b%5Cc%3B%C3%A9.txt`);
  });
});

describe('file store (Sprint 26d)', () => {
  let h: Harness;
  let clamd: FakeClamd;
  let renderer: FakePreviewRenderer;
  let wsId: string;
  let otherWsId: string;

  beforeEach(async () => {
    clamd = await new FakeClamd().start();
    renderer = new FakePreviewRenderer();
    h = await harness({ CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String(clamd.port), FILES_TRASH_DAYS: '30' }, { previewRenderer: renderer });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'confidential')).id;
    otherWsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Legal', 'internal')).id;
  });
  afterEach(async () => {
    await h.close();
    await clamd.stop();
  });

  async function member(name: string, ws: string[] = [wsId], clearance: 'internal' | 'confidential' | 'public' = 'internal') {
    const u = await localUser(h, name, ['member'], clearance);
    for (const w of ws) await h.s.tenants.addMember(w, u.id);
    const c = await login(h, name);
    const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    return {
      user: u,
      ...c,
      post: (p: string, b?: object) => send('post', p, b),
      patch: (p: string, b?: object) => send('patch', p, b),
      put: (p: string, b?: object) => send('put', p, b),
      del: (p: string) => send('delete', p),
      get: (p: string) => c.agent.get(p),
      upload: (name: string, data: Buffer | string, q: Record<string, string> = {}) =>
        c.agent
          .put(`/api/files/uploads?${new URLSearchParams({ name, workspace: wsId, ...q }).toString()}`)
          .set('x-csrf-token', c.csrf)
          .set('content-type', 'application/octet-stream')
          .send(Buffer.from(data)),
      version: (id: string, data: Buffer | string) => c.agent.put(`/api/files/${id}/content`).set('x-csrf-token', c.csrf).set('content-type', 'application/octet-stream').send(Buffer.from(data)),
      download: (path: string) => c.agent.get(path).buffer(true).parse(binary),
      downloadPost: (path: string, body: object) => c.agent.post(path).set('x-csrf-token', c.csrf).send(body).buffer(true).parse(binary)
    };
  }

  it('files are moderation objects: a takedown trashes the file and revokes its shares; an upheld appeal restores it', async () => {
    const mo = await member('mo');
    const pat = await member('pat');
    const up = (await mo.upload('notes.txt', 'Quarterly notes').expect(202)).body;
    await drain(h);
    const share = (await mo.post(`/api/files/${up.id}/shares`, { kind: 'user', userId: pat.user.id }).expect(201)).body;
    const handler = h.s.moderation.registry.get('file')!;
    const o = await handler.resolve(h.tenantId, up.id);
    expect(o).toMatchObject({ type: 'file', id: up.id, workspaceId: wsId, ownerId: mo.user.id });
    expect(await handler.text!(o!)).toBe('notes.txt');
    // a takedown: the file goes to the trash and every share is revoked
    const prev = await handler.hide!(o!);
    expect(prev).not.toBeNull();
    expect((await h.s.db('files').where({ id: up.id }).first()).trashed_at).not.toBeNull();
    expect((await h.s.db('file_shares').where({ id: share.id }).first()).revoked_at).not.toBeNull();
    expect((await handler.resolve(h.tenantId, up.id))!.state).toBe('hidden');
    expect(await handler.hide!((await handler.resolve(h.tenantId, up.id))!)).toBeNull();
    // an upheld appeal takes it out of the trash again; a file the owner trashed themselves is left alone
    expect(await handler.restore!(o!, prev!)).toBe(true);
    expect((await h.s.db('files').where({ id: up.id }).first()).trashed_at).toBeNull();
    await mo.del(`/api/files/${up.id}`).expect(200);
    expect(await handler.restore!(o!, prev!)).toBe(false);
  });

  const audits = async (action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as { target: string; detail: string | null }[];

  it('B-2401: folders, streamed sealed uploads through quarantine, versions, and a restored version scanned again', async () => {
    const ann = await member('ann');
    const events: { type: string; data: Record<string, unknown> }[] = [];
    h.s.bus.on<{ type: string; data: Record<string, unknown> }>('integration.event', (e) => void events.push(e));

    const folder = (await ann.post('/api/files/folders', { name: 'Reports', workspaceId: wsId }).expect(201)).body;
    await ann.post('/api/files/folders', { name: 'Reports', workspaceId: wsId }).expect(409);
    await ann.post('/api/files/folders', { name: '../x', workspaceId: wsId }).expect(400);
    const sub = (await ann.post('/api/files/folders', { name: 'Q3', parentId: folder.id }).expect(201)).body;

    const v1 = 'Q3 travel report, version one. '.repeat(5000); // several segments
    const up = (await ann.upload('Travel "Q3".md', v1, { folder: sub.id }).expect(202)).body;
    expect(up).toMatchObject({ state: 'pending', folderId: sub.id, version: { number: 1, state: 'quarantined' } });
    // not readable before its scan
    await ann.download(`/api/files/${up.id}/content`).expect(409);
    await drain(h);
    const ready = (await ann.get(`/api/files/${up.id}`).expect(200)).body;
    expect(ready).toMatchObject({ state: 'ready', currentVersion: 1, type: 'text/markdown', label: 'internal', size: v1.length });
    expect(clamd.scans).toHaveLength(1);
    expect(clamd.scans[0]!.bytes).toBe(v1.length);
    expect(events.find((e) => e.type === 'file.uploaded')?.data).toMatchObject({ file: up.id, folder: sub.id, workspace: wsId, version: 1, actor: ann.user.id });

    // sealed at rest, out of quarantine
    const row = await h.s.db('file_versions').where({ file_id: up.id, number: 1 }).first();
    expect(row.blob_key).toBe(`files/${h.tenantId}/store/${row.id}`);
    const stored = (await h.s.blobs.get(row.blob_key))!;
    expect(stored.toString('latin1')).not.toContain('Q3 travel');
    expect(row.sealed_key).toMatch(/^v2\./);

    // download: sandboxed, escaped name, audited
    const dl = await ann.download(`/api/files/${up.id}/content`).expect(200);
    expect((dl.body as Buffer).toString()).toBe(v1);
    expect(dl.headers['content-security-policy']).toMatch(/^sandbox/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-disposition']).toBe(`attachment; filename="Travel _Q3_.md"; filename*=UTF-8''Travel%20%22Q3%22.md`);
    expect(await audits('file.downloaded')).toHaveLength(1);

    // a second version, then a restore of the first
    await ann.version(up.id, 'Version two.').expect(202);
    await drain(h);
    expect((await ann.get(`/api/files/${up.id}`).expect(200)).body).toMatchObject({ currentVersion: 2, size: 12 });
    expect(events.some((e) => e.type === 'file.updated' && e.data.version === 2)).toBe(true);
    const restored = (await ann.post(`/api/files/${up.id}/versions/1/restore`).expect(202)).body;
    expect(restored.version).toMatchObject({ number: 3, state: 'quarantined', restoredFrom: 1 });
    await drain(h);
    expect(clamd.scans).toHaveLength(3);
    expect((await ann.get(`/api/files/${up.id}`).expect(200)).body).toMatchObject({ currentVersion: 3, size: v1.length });
    expect(events.find((e) => e.type === 'file.restored')?.data).toMatchObject({ version: 3, from: 1 });

    // Done when: a restored version is scanned again. ClamAV's signatures changed since version 1 was stored.
    clamd.signatures = ['version one'];
    const again = (await ann.post(`/api/files/${up.id}/versions/1/restore`).expect(202)).body;
    await drain(h);
    expect(clamd.scans).toHaveLength(4);
    expect(clamd.scans[3]!.found).toBe('version one');
    const versions = (await ann.get(`/api/files/${up.id}/versions`).expect(200)).body as { number: number; state: string; reason: string | null; restoredFrom: number | null }[];
    expect(versions.find((v) => v.number === again.version.number)).toMatchObject({ state: 'rejected', restoredFrom: 1, reason: expect.stringMatching(/^Malware detected/) });
    expect((await ann.get(`/api/files/${up.id}`).expect(200)).body.currentVersion).toBe(3);
    expect(await audits('file.version.rejected')).toHaveLength(1);
    // an older version is still downloadable by members
    expect((await ann.download(`/api/files/${up.id}/versions/2/content`).expect(200)).body.toString()).toBe('Version two.');

    // uploads that fail the type check or the scan
    const bin = (await ann.upload('blob.bin', Buffer.from([1, 2, 0, 3, 4]))).body;
    const evil = (await ann.upload('evil.txt', 'X5O!P%@AP version one')).body;
    await drain(h);
    expect((await ann.get(`/api/files/${bin.id}`).expect(200)).body.state).toBe('rejected');
    expect((await ann.get(`/api/files/${evil.id}`).expect(200)).body.state).toBe('rejected');

    // browse, and someone outside the workspace sees nothing
    const list = (await ann.get(`/api/files/browse?folder=${sub.id}`).expect(200)).body;
    expect(list.path.map((x: { name: string }) => x.name)).toEqual(['Reports', 'Q3']);
    expect(list.files.map((x: { name: string }) => x.name)).toEqual(['Travel "Q3".md']);
    const bob = await member('bob', [otherWsId]);
    await bob.get(`/api/files/${up.id}`).expect(404);
    await bob.get(`/api/files/browse?workspace=${wsId}`).expect(404);

    // trash: the folder takes its contents, restores them, and the purge job deletes what passed its date
    await ann.del(`/api/files/folders/${folder.id}`).expect(200);
    await ann.get(`/api/files/${up.id}`).expect(404);
    expect(events.some((e) => e.type === 'file.deleted' && e.data.file === up.id)).toBe(true);
    const trash = (await ann.get(`/api/files/trash?workspace=${wsId}`).expect(200)).body;
    expect(trash.folders.map((x: { id: string }) => x.id)).toEqual([folder.id]);
    await ann.post('/api/files/trash/restore', { kind: 'file', id: up.id }).expect(409); // went with the folder
    await ann.post('/api/files/trash/restore', { kind: 'folder', id: folder.id }).expect(200);
    await ann.get(`/api/files/${up.id}`).expect(200);
    await ann.del(`/api/files/${up.id}`).expect(200);
    expect(await h.s.files.purge(h.tenantId)).toMatchObject({ files: 0 });
    await h.s.db('files').where({ id: up.id }).update({ purge_after: Date.now() - 1 });
    expect(await h.s.files.purge(h.tenantId)).toMatchObject({ files: 1 });
    expect(await h.s.blobs.get(row.blob_key)).toBeNull();
    expect(await h.s.db('file_versions').where({ file_id: up.id })).toHaveLength(0);
    expect(await audits('file.purged')).toHaveLength(1);
  });

  it('B-2402: shares with users, groups and workspaces; use-limited links; anonymous links on the B-706 rules', async () => {
    const ann = await member('ann');
    const up = (await ann.upload('plan.txt', 'The plan.')).body;
    await drain(h);

    // a user, a workspace and a directory group
    const cy = await member('cy', [otherWsId]);
    const dee = await member('dee', [otherWsId]);
    const eve = await member('eve', []);
    await cy.get(`/api/files/${up.id}`).expect(404);
    const userShare = (await ann.post(`/api/files/${up.id}/shares`, { kind: 'user', userId: cy.user.id }).expect(201)).body;
    expect((await cy.download(`/api/files/${up.id}/content`).expect(200)).body.toString()).toBe('The plan.');
    await cy.put(`/api/files/${up.id}/tags`, { tags: ['x'] }).expect(404); // read-only
    expect((await cy.get('/api/files/shared').expect(200)).body.map((x: { id: string }) => x.id)).toEqual([up.id]);
    await ann.del(`/api/files/${up.id}/shares/${userShare.id}`).expect(204);
    await cy.get(`/api/files/${up.id}`).expect(404);
    await dee.get(`/api/files/${up.id}`).expect(404);
    await ann.post(`/api/files/${up.id}/shares`, { kind: 'workspace', workspaceId: otherWsId }).expect(201);
    await dee.get(`/api/files/${up.id}`).expect(200);
    const local = (await h.s.providers.list(h.tenantId)).find((p) => p.kind === 'local')!;
    await h.s.users.upsertIdentity(eve.user.id, local.id, eve.user.id, ['Auditors']);
    await eve.get(`/api/files/${up.id}`).expect(404);
    await ann.post(`/api/files/${up.id}/shares`, { kind: 'group', group: 'auditors' }).expect(201);
    await eve.download(`/api/files/${up.id}/content`).expect(200);
    const downloads = (await audits('file.downloaded')).map((a) => JSON.parse(a.detail ?? '{}') as { via: string });
    expect(downloads.map((d) => d.via).sort()).toEqual(['share:group', 'share:user']);

    // Done when: a link past its use limit is refused.
    const link = (await ann.post(`/api/files/${up.id}/shares`, { kind: 'link', expiresInHours: 24, maxUses: 2 }).expect(201)).body;
    expect(link.token).toMatch(/^exf_/);
    expect(await h.s.db('file_shares').where({ id: link.id }).first()).toMatchObject({ token_hash: expect.not.stringContaining('exf_') });
    expect((await eve.post('/api/file-links/open', { token: link.token }).expect(200)).body).toEqual({ name: 'plan.txt', size: 9, type: 'text/plain', label: 'internal', expiresAt: link.expiresAt, usesLeft: 2 });
    expect((await eve.downloadPost('/api/file-links/download', { token: link.token }).expect(200)).body.toString()).toBe('The plan.');
    await eve.downloadPost('/api/file-links/download', { token: link.token }).expect(200);
    const third = await eve.downloadPost('/api/file-links/download', { token: link.token }).expect(404);
    // the refusal says nothing a wrong token would not (BUG-020), and opening it says the same
    const wrong = await eve.downloadPost('/api/file-links/download', { token: `exf_${'A'.repeat(43)}` }).expect(404);
    expect(JSON.parse(third.body.toString()).detail).toBe(JSON.parse(wrong.body.toString()).detail);
    await eve.post('/api/file-links/open', { token: link.token }).expect(404);
    expect((await h.s.db('file_shares').where({ id: link.id }).first()).uses).toBe(2);
    expect((await audits('file.downloaded')).filter((a) => JSON.parse(a.detail ?? '{}').via === 'link')).toHaveLength(2);

    // concurrent uses cannot pass the limit
    const one = (await ann.post(`/api/files/${up.id}/shares`, { kind: 'link', expiresInHours: 1, maxUses: 1 }).expect(201)).body;
    const tries = await Promise.all([1, 2, 3, 4].map(() => eve.downloadPost('/api/file-links/download', { token: one.token })));
    expect(tries.filter((r: Res) => r.status === 200)).toHaveLength(1);

    // an expired link
    const old = (await ann.post(`/api/files/${up.id}/shares`, { kind: 'link', expiresInHours: 1 }).expect(201)).body;
    await h.s.db('file_shares').where({ id: old.id }).update({ expires_at: Date.now() - 1 });
    await eve.downloadPost('/api/file-links/download', { token: old.token }).expect(404);

    // anonymous: off by default, public files only, signed-out download through /api/public
    await ann.post(`/api/files/${up.id}/shares`, { kind: 'link', expiresInHours: 24, anonymous: true }).expect(403);
    await h.s.sharing.setSettings(h.tenantId, ann.user.id, { anonymousLinks: true, anonymousMaxHours: 48 });
    await ann.post(`/api/files/${up.id}/shares`, { kind: 'link', expiresInHours: 24, anonymous: true }).expect(403); // internal
    const pub = (await ann.upload('notice.txt', 'Public notice.', { label: 'public' })).body;
    await drain(h);
    await ann.post(`/api/files/${pub.id}/shares`, { kind: 'link', expiresInHours: 72, anonymous: true }).expect(400);
    const anon = (await ann.post(`/api/files/${pub.id}/shares`, { kind: 'link', expiresInHours: 24, anonymous: true }).expect(201)).body;
    const out = await request(h.app).post('/api/public/file-links/download').send({ token: anon.token }).buffer(true).parse(binary).expect(200);
    expect(out.body.toString()).toBe('Public notice.');
    expect(out.headers['content-security-policy']).toMatch(/^sandbox/);
    expect(out.headers['set-cookie']).toBeUndefined();
    // a signed-in link is not an anonymous one
    await request(h.app).post('/api/public/file-links/download').send({ token: link.token }).expect(404);
    await h.s.sharing.setSettings(h.tenantId, ann.user.id, { anonymousLinks: false });
    await request(h.app).post('/api/public/file-links/download').send({ token: anon.token }).expect(404);
  });

  it('B-2403: per-tenant and per-workspace quotas are enforced at upload and shown in usage', async () => {
    const ann = await member('ann');
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    const admin = await loginAdmin(h, 'ta');
    const put = (p: string, b: object) => admin.agent.put(p).set('x-csrf-token', admin.csrf).send(b);
    await put(`/api/admin/tenants/${h.tenantId}/workspaces/${wsId}/file-quota`, { maxBytes: 1000 }).expect(200);
    await put(`/api/admin/tenants/${h.tenantId}/file-quota`, { maxBytes: 5000 }).expect(403); // system admins only
    expect((await audits('file.quota.updated')).length).toBe(1);

    await ann.upload('a.txt', 'a'.repeat(600)).expect(202);
    // Done when: an upload over quota is refused (declared size, and while streaming without one).
    const over = await ann.upload('b.txt', 'b'.repeat(600)).expect(413);
    expect(over.body).toMatchObject({ limit: 'storage_bytes', scope: 'workspace', used: 600, max: 1000 });
    // no declared size: cut off while the bytes stream in
    const p = (await loadPrincipal(h.s, h.tenantId, ann.user.id, {}))!;
    const stream = async function* () {
      for (let i = 0; i < 6; i++) yield Buffer.from('c'.repeat(100));
    };
    await expect(h.s.files.upload(p, { workspaceId: wsId, name: 'c.txt', label: 'internal', declaredType: null, declaredBytes: null }, stream())).rejects.toMatchObject({ status: 413 });
    const left: string[] = [];
    for await (const o of h.s.blobs.list(`files/${h.tenantId}/quarantine`)) left.push(o.key);
    expect(left).toHaveLength(1); // only a.txt's, waiting for its scan
    expect(await h.s.db('files').where({ name: 'b.txt' })).toHaveLength(0);
    expect(await h.s.db('files').where({ name: 'c.txt' })).toHaveLength(0);
    await ann.upload('d.txt', 'd'.repeat(300)).expect(202);

    const usage = (await ann.get(`/api/files/usage?workspace=${wsId}`).expect(200)).body;
    expect(usage.workspace).toMatchObject({ scope: 'workspace', usedBytes: 900, maxBytes: 1000, files: 2 });
    expect(usage.tenant).toMatchObject({ scope: 'tenant', usedBytes: 900, maxBytes: null });
    const storage = (await admin.agent.get('/api/admin/usage/storage').expect(200)).body;
    expect(storage.workspaces.find((w: { workspaceId: string }) => w.workspaceId === wsId)).toMatchObject({ name: 'Finance', usedBytes: 900, maxBytes: 1000 });

    // the tenant total applies too (set here as a system admin would)
    await h.s.files.setLimit(h.tenantId, null, 950, ann.user.id);
    await ann.upload('e.txt', 'e'.repeat(60), { workspace: wsId }).expect(413);
    await member('olga', [otherWsId]).then((o) => o.agent.put(`/api/files/uploads?name=f.txt&workspace=${otherWsId}`).set('x-csrf-token', o.csrf).send(Buffer.from('f'.repeat(60))).expect(413));
  });

  it('B-2404: image and PDF previews by job, sealed, served under the media sandbox', async () => {
    const ann = await member('ann');
    const img = (await ann.upload('pixel.png', TINY_PNG)).body;
    const pdf = (await ann.upload('memo.pdf', '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF')).body;
    const txt = (await ann.upload('notes.txt', 'no preview')).body;
    await drain(h);
    expect(renderer.calls.map((c) => c.kind).sort()).toEqual(['image', 'pdf']);
    expect(renderer.calls.find((c) => c.kind === 'image')).toMatchObject({ type: 'image/png', maxPx: 512 });
    expect((await ann.get(`/api/files/${img.id}`).expect(200)).body.preview).toBe('ready');
    const row = await h.s.db('file_previews').join('file_versions', 'file_versions.id', 'file_previews.version_id').where({ 'file_versions.file_id': img.id }).first('file_previews.blob_key', 'file_previews.sealed_key');
    expect(row.sealed_key).toMatch(/^v2\./);
    expect((await h.s.blobs.get(row.blob_key))!.subarray(0, 8)).not.toEqual(TINY_PNG.subarray(0, 8));

    // Done when: a preview carries the sandbox header.
    const pv = await ann.download(`/api/files/${img.id}/preview`).expect(200);
    expect(pv.headers['content-security-policy']).toMatch(/^sandbox/);
    expect(pv.headers['x-content-type-options']).toBe('nosniff');
    expect(pv.headers['content-type']).toBe('image/png');
    expect(pv.body).toEqual(TINY_PNG);
    await ann.download(`/api/files/${pdf.id}/preview`).expect(200);
    await ann.get(`/api/files/${txt.id}/preview`).expect(404);
    const bob = await member('bob', [otherWsId]);
    await bob.get(`/api/files/${img.id}/preview`).expect(404);

    // a renderer that is not installed leaves the preview unavailable, not failing
    renderer.unavailable = true;
    const pdf2 = (await ann.upload('memo2.pdf', '%PDF-1.4\n%%EOF')).body;
    await drain(h);
    expect((await ann.get(`/api/files/${pdf2.id}`).expect(200)).body.preview).toBe('unavailable');
  });

  it('B-2404: with MEDIA_ORIGIN the preview is a signed URL on the media origin', async () => {
    await h.close();
    h = await harness({ MEDIA_ORIGIN: 'http://media.localhost:8080' }, { previewRenderer: renderer });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'confidential')).id;
    const ann = await member('ann');
    const img = (await ann.upload('pixel.png', TINY_PNG)).body;
    await drain(h);
    const redirect = await ann.get(`/api/files/${img.id}/preview`).expect(302);
    const url = new URL(redirect.headers.location as string);
    expect(url.origin).toBe('http://media.localhost:8080');
    const served = await request(h.app).get(url.pathname).set('host', 'media.localhost:8080').buffer(true).parse(binary).expect(200);
    expect(served.headers['content-security-policy']).toMatch(/^sandbox/);
    expect(served.body).toEqual(TINY_PNG);
  });

  it('B-2405: name and tag search within the caller’s workspaces and clearance', async () => {
    const ann = await member('ann', [wsId], 'confidential');
    const a = (await ann.upload('Budget 2026.csv', 'a,b\n1,2\n')).body;
    await ann.upload('budget_100%.txt', 'x').expect(202);
    const c = (await ann.upload('Secret budget.txt', 'y', { label: 'confidential' })).body;
    await drain(h);
    await ann.put(`/api/files/${a.id}/tags`, { tags: ['Finance', 'q3'] }).expect(200);
    await ann.put(`/api/files/${c.id}/tags`, { tags: ['finance'] }).expect(200);
    const names = (r: Res) => (r.body as { name: string }[]).map((x) => x.name).sort();
    expect(names(await ann.get('/api/files/search?q=budget').expect(200))).toEqual(['Budget 2026.csv', 'Secret budget.txt', 'budget_100%.txt']);
    expect(names(await ann.get('/api/files/search?q=100%25').expect(200))).toEqual(['budget_100%.txt']);
    expect(names(await ann.get('/api/files/search?q=_').expect(200))).toEqual(['budget_100%.txt']);
    expect(names(await ann.get('/api/files/search?tag=finance').expect(200))).toEqual(['Budget 2026.csv', 'Secret budget.txt']);
    expect(names(await ann.get('/api/files/search?tag=finance&tag=q3').expect(200))).toEqual(['Budget 2026.csv']);
    await ann.get('/api/files/search').expect(400);
    // an internal member of the workspace does not find the confidential one; an outsider finds nothing
    const ivy = await member('ivy', [wsId], 'internal');
    expect(names(await ivy.get('/api/files/search?q=budget').expect(200))).toEqual(['Budget 2026.csv', 'budget_100%.txt']);
    const bob = await member('bob', [otherWsId]);
    expect((await bob.get('/api/files/search?q=budget').expect(200)).body).toEqual([]);
  });

  it('B-2405: a folder as a knowledge source; chat cites a file from the indexed folder', async () => {
    const ollama = await new FakeOllama().start();
    try {
      await seedRetrieval(h, ollama);
      const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
      await h.s.tenants.addMember(wsId, curator.user.id);
      const folder = (await curator.post('/api/files/folders', { name: 'Policies', workspaceId: wsId }).expect(201)).body;
      const sub = (await curator.post('/api/files/folders', { name: 'Travel', parentId: folder.id }).expect(201)).body;
      const put = (name: string, data: string, q: Record<string, string>) => curator.agent.put(`/api/files/uploads?${new URLSearchParams({ name, workspace: wsId, ...q }).toString()}`).set('x-csrf-token', curator.csrf).send(Buffer.from(data));
      await put('Lisbon.md', '# Lisbon trip\n\nThe Lisbon onboarding travel overran by 51,380 EUR.', { folder: sub.id }).expect(202);
      await put('Pixel.png', TINY_PNG.toString('latin1'), { folder: folder.id }).expect(202);
      await put('Board.md', 'Restricted board minutes about Lisbon.', { folder: folder.id, label: 'confidential' }).expect(202);
      await drain(h);
      const kb = (await curator.post('/api/knowledge/bases', { name: 'Policy KB', label: 'internal', embedModel: 'nomic-embed-text', reranker: 'llama3.1:8b' }).expect(201)).body;
      const src = (await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'folder', location: folder.id }).expect(201)).body;
      expect(src).toMatchObject({ kind: 'folder', location: 'folder: Policies' });
      await drain(h);
      const docs = (await curator.get(`/api/knowledge/bases/${kb.id}/documents`).expect(200)).body as { name: string; state: string }[];
      // the image is not a knowledge type, the confidential file is above the base's label
      expect(docs.map((d) => [d.name, d.state])).toEqual([['Travel/Lisbon.md', 'indexed']]);
      await curator.patch(`/api/knowledge/bases/${kb.id}`, { status: 'published' }).expect(200);
      const conv = (await curator.post('/api/conversations', { title: 'Trip', label: 'internal' }).expect(201)).body;
      await curator.put(`/api/conversations/${conv.id}/knowledge`, { kbIds: [kb.id] }).expect(200);
      const sent = (await curator.post(`/api/conversations/${conv.id}/messages`, { content: 'How much did the Lisbon travel overrun?', profile: 'general' }).expect(202)).body;
      let answer: { state: string; citations: Record<string, unknown>[] } | undefined;
      for (let i = 0; i < 200; i++) {
        answer = (await curator.get(`/api/conversations/${conv.id}`)).body.messages.find((x: { id: string }) => x.id === sent.messageId);
        if (answer?.state === 'complete') break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(answer?.state).toBe('complete');
      expect(answer!.citations[0]).toMatchObject({ kind: 'knowledge', kbId: kb.id, document: 'Travel/Lisbon.md' });
      expect(JSON.stringify(answer!.citations)).not.toContain('Board.md');
      const ctx = (ollama.requests.filter((r) => r.path === '/api/chat').pop()!.body as { messages: { content: string }[] }).messages[1]!.content;
      expect(ctx).toContain('51,380');
      // someone who cannot read the folder cannot add it
      const other = await client(h, 'cur2', ['member', 'knowledge-curator'], 'confidential');
      const kb2 = (await other.post('/api/knowledge/bases', { name: 'Other KB', label: 'internal', embedModel: 'nomic-embed-text' }).expect(201)).body;
      await other.post(`/api/knowledge/bases/${kb2.id}/sources`, { kind: 'folder', location: folder.id }).expect(404);
    } finally {
      await ollama.stop();
    }
  });
});
