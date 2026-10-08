import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backfillBlobs } from '../src/db/migrations/038b_dedup_held_vault.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';

type Res = request.Response;
const binary = (res: Res, cb: (err: Error | null, body: Buffer) => void) => {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
};
async function* once(b: Buffer) {
  yield b;
}

describe('B-4601: blob deduplication within a tenant', () => {
  let h: Harness;
  let wsId: string;
  beforeEach(async () => {
    h = await harness({ FILES_TRASH_DAYS: '30' });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'internal')).id;
  });
  afterEach(async () => {
    await h.close();
  });

  async function member(name: string) {
    const u = await localUser(h, name, ['member'], 'internal');
    await h.s.tenants.addMember(wsId, u.id);
    const c = await login(h, name);
    return {
      user: u,
      ...c,
      upload: (file: string, data: Buffer | string) => c.agent.put(`/api/files/uploads?${new URLSearchParams({ name: file, workspace: wsId }).toString()}`).set('x-csrf-token', c.csrf).set('content-type', 'application/octet-stream').send(Buffer.from(data)),
      del: (p: string) => c.agent.delete(p).set('x-csrf-token', c.csrf),
      download: (p: string) => c.agent.get(p).buffer(true).parse(binary)
    };
  }
  const storeObjects = (tenantId: string) => {
    const dir = path.join(h.s.cfg.BLOB_DIR, 'files', tenantId, 'store');
    return existsSync(dir) ? readdirSync(dir) : [];
  };

  it('two uploads of one file occupy one blob; deleting one leaves the other readable; the last one frees it', async () => {
    const mo = await member('mo');
    const pat = await member('pat');
    const body = Buffer.from('The same quarterly report, byte for byte.\n'.repeat(200));
    const a = (await mo.upload('report.txt', body).expect(202)).body;
    const b = (await pat.upload('copy-of-report.txt', body).expect(202)).body;
    await drain(h);
    const va = await h.s.db('file_versions').where({ file_id: a.id }).first();
    const vb = await h.s.db('file_versions').where({ file_id: b.id }).first();
    expect(va.state).toBe('ready');
    expect(vb.state).toBe('ready');
    // One object in the store, read by both versions.
    expect(va.blob_key).toBe(vb.blob_key);
    expect(storeObjects(h.tenantId)).toHaveLength(1);
    const blobs = await h.s.db('file_blobs').where({ tenant_id: h.tenantId });
    expect(blobs).toHaveLength(1);
    expect(Number(blobs[0].refs)).toBe(2);
    expect(new Set([va.blob_id, vb.blob_id])).toEqual(new Set([blobs[0].id]));
    // No quarantined copy is left behind.
    const q = path.join(h.s.cfg.BLOB_DIR, 'files', h.tenantId, 'quarantine');
    expect(existsSync(q) ? readdirSync(q) : []).toEqual([]);
    expect((await mo.download(`/api/files/${a.id}/content`).expect(200)).body).toEqual(body);
    expect((await pat.download(`/api/files/${b.id}/content`).expect(200)).body).toEqual(body);
    // The quota still counts each version's own size.
    expect((await h.s.files.used(h.tenantId, wsId)).bytes).toBe(2 * body.length);
    const ready = (await h.s.audit.list(h.tenantId, { action: 'file.version.ready', limit: 5 })).map((e) => e.detail as Record<string, unknown>);
    expect(ready.filter((d) => d.sharedWith)).toHaveLength(1);

    // The Storage screen shows the saving.
    await localUser(h, 'root', ['system-admin'], 'restricted');
    const root = await loginAdmin(h, 'root');
    const usage = (await root.agent.get('/api/admin/storage/usage').expect(200)).body;
    expect(usage.dedup).toMatchObject({ blobs: 1, shared: 1, references: 2, storedBytes: body.length, logicalBytes: 2 * body.length, savedBytes: body.length });
    expect(usage.dedup.tenants[0]).toMatchObject({ tenantId: h.tenantId, savedBytes: body.length });

    // The integrity check finds nothing missing and no orphan.
    await root.agent.post('/api/admin/storage/integrity/verify').set('x-csrf-token', root.csrf).send({ checksums: true }).expect(202);
    await h.s.jobs.runDue();
    expect((await root.agent.get('/api/admin/storage/integrity').expect(200)).body.last).toMatchObject({ state: 'succeeded', missing: 0, orphans: 0, mismatches: 0 });

    // Deleting (trash, then purge) the first upload leaves the second readable.
    await mo.del(`/api/files/${a.id}`).expect(200);
    await h.s.db('files').where({ id: a.id }).update({ purge_after: Date.now() - 1 });
    expect(await h.s.files.purge(h.tenantId)).toMatchObject({ files: 1 });
    expect(storeObjects(h.tenantId)).toHaveLength(1);
    expect(Number((await h.s.db('file_blobs').where({ id: blobs[0].id }).first()).refs)).toBe(1);
    expect((await pat.download(`/api/files/${b.id}/content`).expect(200)).body).toEqual(body);

    // A third upload of the same content shares the blob the deleted file first stored.
    const c = (await mo.upload('again.txt', body).expect(202)).body;
    await drain(h);
    expect(storeObjects(h.tenantId)).toHaveLength(1);
    expect((await mo.download(`/api/files/${c.id}/content`).expect(200)).body).toEqual(body);

    // Purging every reader frees the object and its row.
    await pat.del(`/api/files/${b.id}`).expect(200);
    await mo.del(`/api/files/${c.id}`).expect(200);
    await h.s.db('files').whereIn('id', [b.id, c.id]).update({ purge_after: Date.now() - 1 });
    expect(await h.s.files.purge(h.tenantId)).toMatchObject({ files: 2 });
    expect(storeObjects(h.tenantId)).toHaveLength(0);
    expect(await h.s.db('file_blobs').where({ tenant_id: h.tenantId })).toHaveLength(0);
  });

  it('different content is not shared, and a new version of a file with old content shares its blob', async () => {
    const mo = await member('mo');
    const one = (await mo.upload('one.txt', 'first content').expect(202)).body;
    const two = (await mo.upload('two.txt', 'second content').expect(202)).body;
    await drain(h);
    expect(storeObjects(h.tenantId)).toHaveLength(2);
    // Version 2 of two.txt carries one.txt's content: shared. Restoring version 1 of two.txt: shared again.
    await mo.agent.put(`/api/files/${two.id}/content`).set('x-csrf-token', mo.csrf).set('content-type', 'application/octet-stream').send(Buffer.from('first content')).expect(202);
    await drain(h);
    expect(storeObjects(h.tenantId)).toHaveLength(2);
    await mo.agent.post(`/api/files/${two.id}/versions/1/restore`).set('x-csrf-token', mo.csrf).send({}).expect((r) => expect([200, 201, 202]).toContain(r.status));
    await drain(h);
    expect(storeObjects(h.tenantId)).toHaveLength(2);
    expect((await mo.download(`/api/files/${two.id}/content`).expect(200)).body.toString()).toBe('second content');
    expect((await mo.download(`/api/files/${one.id}/content`).expect(200)).body.toString()).toBe('first content');
    const refs = (await h.s.db('file_blobs').where({ tenant_id: h.tenantId }).orderBy('created_at')).map((r: { refs: number | string }) => Number(r.refs)).sort();
    expect(refs).toEqual([2, 2]);
  });

  it('the migration registers what was stored before 1.6.0, so later uploads share it', async () => {
    const mo = await member('mo');
    const a = (await mo.upload('old-1.txt', 'stored before the upgrade').expect(202)).body;
    await drain(h);
    // As before 1.6.0: no blob rows.
    const legacy = await h.s.db('file_versions').where({ file_id: a.id }).first();
    await h.s.db('file_blobs').delete();
    await h.s.db('file_versions').update({ blob_id: null });
    expect(await backfillBlobs(h.s.db)).toBe(1);
    expect(await backfillBlobs(h.s.db)).toBe(0);
    expect((await h.s.db('file_versions').where({ file_id: a.id }).first()).blob_id).toBe(legacy.id);
    const b = (await mo.upload('new.txt', 'stored before the upgrade').expect(202)).body;
    await drain(h);
    expect((await h.s.db('file_versions').where({ file_id: b.id }).first()).blob_key).toBe(legacy.blob_key);
    expect((await mo.download(`/api/files/${b.id}/content`).expect(200)).body.toString()).toBe('stored before the upgrade');
  });

  it('never shares across tenants (the sealed-key boundary)', async () => {
    const mo = await member('mo');
    const body = 'identical in two tenants';
    const mine = (await mo.upload('x.txt', body).expect(202)).body;
    const other = await h.s.tenants.create({ slug: 'other', name: 'Other' });
    const ows = await h.s.tenants.createWorkspace(other.id, 'Ops', 'internal');
    const ou = await h.s.users.create(other.id, { username: 'olga', displayName: 'Olga', clearance: 'internal' });
    await h.s.users.setRoles(ou.id, 'direct', ['member']);
    await h.s.tenants.addMember(ows.id, ou.id);
    const p = (await loadPrincipal(h.s, other.id, ou.id, {}))!;
    const theirs = await h.s.files.upload(p, { workspaceId: ows.id, name: 'x.txt', label: 'internal', declaredType: 'text/plain', declaredBytes: null }, once(Buffer.from(body)));
    await drain(h);
    const v1 = await h.s.db('file_versions').where({ file_id: mine.id }).first();
    const v2 = await h.s.db('file_versions').where({ file_id: theirs.file.id }).first();
    expect(v1.sha256).toBe(v2.sha256);
    expect(v1.blob_key).not.toBe(v2.blob_key);
    expect(v2.blob_key.startsWith(`files/${other.id}/`)).toBe(true);
    expect(await h.s.db('file_blobs').where({ sha256: v1.sha256 })).toHaveLength(2);
    expect(storeObjects(h.tenantId)).toHaveLength(1);
    expect(storeObjects(other.id)).toHaveLength(1);
  });
});
