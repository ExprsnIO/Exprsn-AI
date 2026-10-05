import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { davUser } from './dav-helpers.js';
import { harness, login, type Harness } from './helpers.js';
import { FakeClamd, FakePreviewRenderer } from './sprint26d-fakes.js';

/*
 * B-32 (planned for Sprint 34, built on Sprint 30's DAV core): the file store over WebDAV. Folders and files as
 * collections; PUT through quarantine, the type check and ClamAV, with versions kept (B-3201); COPY, MOVE, LOCK and
 * UNLOCK (B-3202); quota properties and shares (B-3203). litmus runs in CI (`.github/workflows/ci.yml`).
 */

const hrefs = (xml: string): string[] => [...xml.matchAll(/<d:href>([^<]*)<\/d:href>/g)].map((m) => decodeURIComponent(m[1]!));
const PROPFIND = (props: string) => `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>${props}</d:prop></d:propfind>`;
const LOCKINFO = (scope = 'exclusive') => `<?xml version="1.0"?><d:lockinfo xmlns:d="DAV:"><d:lockscope><d:${scope}/></d:lockscope><d:locktype><d:write/></d:locktype><d:owner><d:href>mailto:me@example.test</d:href></d:owner></d:lockinfo>`;

describe('WebDAV for the file store (B-3201 to B-3203)', () => {
  let h: Harness;
  let clamd: FakeClamd;
  let ws: string;
  let other: string;

  beforeEach(async () => {
    clamd = await new FakeClamd().start();
    h = await harness({ CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String(clamd.port) }, { previewRenderer: new FakePreviewRenderer() });
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'confidential')).id;
    other = (await h.s.tenants.createWorkspace(h.tenantId, 'Legal', 'internal')).id;
  });
  afterEach(async () => {
    await h.close();
    await clamd.stop();
  });

  const member = async (name: string, workspaces: string[], clearance: 'internal' | 'confidential' = 'internal') => {
    const u = await davUser(h, name, { clearance, scopes: ['webdav'] });
    for (const w of workspaces) await h.s.tenants.addMember(w, u.user.id);
    return u;
  };
  const wsSeg = async (id: string) => {
    const w = await h.s.tenants.workspace(h.tenantId, id);
    return w!.slug || w!.id;
  };

  it('B-3201: lists workspaces and folders; an upload over WebDAV is scanned before it can be read; versions are kept', async () => {
    const u = await member('alice', [ws]);
    const root = `/dav/files/${await wsSeg(ws)}`;
    const top = (await u.dav('PROPFIND', '/dav/files/').set('Depth', '1').send(PROPFIND('<d:displayname/><d:resourcetype/>')).expect(207)).text;
    expect(hrefs(top)).toEqual(expect.arrayContaining([`${root}/`, '/dav/files/~shared/']));
    expect(top).toContain('<d:displayname>Finance</d:displayname>');
    await u.dav('PROPFIND', `/dav/files/${await wsSeg(other)}/`).set('Depth', '0').expect(404);

    await u.dav('MKCOL', `${root}/Reports/`).expect(201);
    await u.dav('MKCOL', `${root}/Reports/`).expect(405);
    await u.dav('MKCOL', `${root}/Missing/Deeper/`).expect(409);

    // Clean: scanned (ClamAV saw the bytes) before the answer, then readable with the ETag the PUT returned.
    const put = await u.dav('PUT', `${root}/Reports/q3.txt`).set('Content-Type', 'text/plain').send('Quarter three: fine.\n').expect(201);
    expect(clamd.scans.at(-1)).toMatchObject({ found: null });
    const got = await u.dav('GET', `${root}/Reports/q3.txt`).expect(200);
    expect(got.text).toBe('Quarter three: fine.\n');
    expect(got.headers.etag).toBe(put.headers.etag);
    expect(got.headers['content-security-policy']).toContain('sandbox');
    const file = await h.s.db('files').where({ name: 'q3.txt' }).first();
    expect((await h.s.db('file_versions').where({ file_id: file.id }).first()).state).toBe('ready');

    // Infected: the scan rejects it; it is never readable or listed.
    clamd.signatures.push('EICAR-TEST');
    const bad = await u.dav('PUT', `${root}/Reports/evil.txt`).send('EICAR-TEST payload\n').expect(403);
    expect(bad.text).toContain('Malware');
    await u.dav('GET', `${root}/Reports/evil.txt`).expect(404);
    expect(hrefs((await u.dav('PROPFIND', `${root}/Reports/`).set('Depth', '1').expect(207)).text)).not.toContain(`${root}/Reports/evil.txt`);
    // A type the store does not take.
    await u.dav('PUT', `${root}/Reports/blob.bin`).send(Buffer.from([0, 1, 2, 3, 0, 0, 7])).expect(415);

    // A version still in quarantine is not served (an API upload whose scan has not run yet).
    const a = await login(h, 'alice');
    const pending = (await a.agent.put(`/api/files/uploads?name=pending.txt&workspace=${ws}`).set('x-csrf-token', a.csrf).set('Content-Type', 'text/plain').send('not scanned yet').expect(202)).body;
    expect(pending.state).toBe('pending');
    expect((await u.dav('GET', `${root}/pending.txt`).expect(409)).text).toContain('scanned');

    // A second PUT is a new version; the first is kept.
    await u.dav('PUT', `${root}/Reports/q3.txt`).set('If-Match', put.headers.etag as string).send('Quarter three: revised.\n').expect(204);
    await u.dav('PUT', `${root}/Reports/q3.txt`).set('If-Match', put.headers.etag as string).send('stale\n').expect(412);
    expect((await a.agent.get(`/api/files/${file.id}/versions`).expect(200)).body.map((v: { number: number }) => v.number)).toEqual([2, 1]);
    expect((await u.dav('GET', `${root}/Reports/q3.txt`).expect(200)).text).toBe('Quarter three: revised.\n');

    // Finder's AppleDouble files are accepted and dropped.
    await u.dav('PUT', `${root}/Reports/._q3.txt`).send(Buffer.from([0, 5, 22, 7, 0, 2])).expect(201);
    await u.dav('GET', `${root}/Reports/._q3.txt`).expect(404);
    // DELETE is the trash.
    await u.dav('DELETE', `${root}/Reports/q3.txt`).expect(204);
    expect((await h.s.db('files').where({ id: file.id }).first()).trashed_at).not.toBeNull();
    const actions = ((await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'like', 'file.%').select('action')) as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['file.upload.received', 'file.version.ready', 'file.version.rejected', 'file.folder.created', 'file.downloaded', 'file.trashed']));
  });

  it('B-3202: moving a folder over WebDAV keeps its versions and shares; COPY scans again; cross-workspace moves are refused', async () => {
    const u = await member('alice', [ws, other]);
    const bob = await member('bob', [other]);
    const root = `/dav/files/${await wsSeg(ws)}`;
    await u.dav('MKCOL', `${root}/Plans/`).expect(201);
    await u.dav('MKCOL', `${root}/Archive/`).expect(201);
    await u.dav('PUT', `${root}/Plans/plan.md`).send('# Plan\n').expect(201);
    await u.dav('PUT', `${root}/Plans/plan.md`).send('# Plan, v2\n').expect(204);
    const file = await h.s.db('files').where({ name: 'plan.md' }).first();
    const a = await login(h, 'alice');
    await a.agent.post(`/api/files/${file.id}/shares`).set('x-csrf-token', a.csrf).send({ kind: 'user', userId: bob.user.id }).expect(201);

    await u.dav('MOVE', `${root}/Plans/`).set('Destination', `${root}/Archive/Plans 2026/`).expect(201);
    await u.dav('PROPFIND', `${root}/Plans/`).set('Depth', '0').expect(404);
    expect((await u.dav('GET', `${root}/Archive/Plans 2026/plan.md`).expect(200)).text).toBe('# Plan, v2\n');
    const after = await h.s.db('files').where({ id: file.id }).first();
    expect(after.id).toBe(file.id);
    expect((await a.agent.get(`/api/files/${file.id}/versions`).expect(200)).body).toHaveLength(2);
    expect((await a.agent.get(`/api/files/${file.id}/shares`).expect(200)).body).toEqual([expect.objectContaining({ kind: 'user', userId: bob.user.id, state: 'active' })]);
    // The share still works for Bob, under ~shared, read-only.
    expect(hrefs((await bob.dav('PROPFIND', '/dav/files/~shared/').set('Depth', '1').expect(207)).text)).toContain('/dav/files/~shared/plan.md');
    expect((await bob.dav('GET', '/dav/files/~shared/plan.md').expect(200)).text).toBe('# Plan, v2\n');
    await bob.dav('PUT', '/dav/files/~shared/plan.md').send('mine now').expect(409);

    // Overwrite: F refuses an existing destination; COPY makes a new file, scanned again.
    await u.dav('PUT', `${root}/notes.txt`).send('notes\n').expect(201);
    await u.dav('COPY', `${root}/notes.txt`).set('Destination', `${root}/Archive/Plans 2026/plan.md`).set('Overwrite', 'F').expect(412);
    const scans = clamd.scans.length;
    await u.dav('COPY', `${root}/notes.txt`).set('Destination', `${root}/notes copy.txt`).expect(201);
    expect(clamd.scans.length).toBe(scans + 1);
    expect((await u.dav('GET', `${root}/notes copy.txt`).expect(200)).text).toBe('notes\n');
    await u.dav('COPY', `${root}/Archive/`).set('Destination', `${root}/Archive copy/`).expect(201);
    expect((await u.dav('GET', `${root}/Archive copy/Plans 2026/plan.md`).expect(200)).text).toBe('# Plan, v2\n');
    // Across workspaces: refused for MOVE (versions and shares would not follow), allowed for COPY.
    await u.dav('MOVE', `${root}/notes.txt`).set('Destination', `/dav/files/${await wsSeg(other)}/notes.txt`).expect(403);
    await u.dav('COPY', `${root}/notes.txt`).set('Destination', `/dav/files/${await wsSeg(other)}/notes.txt`).expect(201);
    await u.dav('MOVE', `${root}/Archive/`).set('Destination', `${root}/Archive/inside/`).expect(403);
  });

  it('B-3202: LOCK and UNLOCK (class 2): a locked file needs its token, and only its owner may use it', async () => {
    const u = await member('alice', [ws]);
    const carl = await member('carl', [ws]);
    const root = `/dav/files/${await wsSeg(ws)}`;
    expect((await u.dav('OPTIONS', `${root}/`).expect(200)).headers.dav).toMatch(/^1, 2, 3/);
    await u.dav('PUT', `${root}/doc.txt`).send('v1\n').expect(201);
    const lock = await u.dav('LOCK', `${root}/doc.txt`).set('Timeout', 'Second-600').send(LOCKINFO()).expect(200);
    const token = /<([^>]+)>/.exec(lock.headers['lock-token'] as string)![1]!;
    expect(lock.text).toContain('<d:lockdiscovery><d:activelock>');
    expect(lock.text).toContain('Second-600');
    await u.dav('PUT', `${root}/doc.txt`).send('v2\n').expect(423);
    await carl.dav('PUT', `${root}/doc.txt`).set('If', `(<${token}>)`).send('v2\n').expect(423);
    await carl.dav('LOCK', `${root}/doc.txt`).send(LOCKINFO('shared')).expect(423);
    await u.dav('PUT', `${root}/doc.txt`).set('If', '(<opaquelocktoken:00000000-0000-0000-0000-000000000000>)').send('v2\n').expect(412);
    await u.dav('PUT', `${root}/doc.txt`).set('If', `(<${token}>)`).send('v2\n').expect(204);
    await u.dav('DELETE', `${root}/doc.txt`).expect(423);
    const disc = (await u.dav('PROPFIND', `${root}/doc.txt`).set('Depth', '0').send(PROPFIND('<d:lockdiscovery/><d:supportedlock/>')).expect(207)).text;
    expect(disc).toContain(token);
    expect(disc).toContain('<d:lockentry><d:lockscope><d:exclusive/>');
    // Refresh with the If header.
    await u.dav('LOCK', `${root}/doc.txt`).set('If', `(<${token}>)`).set('Timeout', 'Second-120').expect(200);
    await carl.dav('UNLOCK', `${root}/doc.txt`).set('Lock-Token', `<${token}>`).expect(403);
    await u.dav('UNLOCK', `${root}/other.txt`).set('Lock-Token', `<${token}>`).expect(409);
    await u.dav('UNLOCK', `${root}/doc.txt`).set('Lock-Token', `<${token}>`).expect(204);
    await u.dav('DELETE', `${root}/doc.txt`).expect(204);
    // A depth-infinity lock on a folder covers what is inside; locking an unmapped URL makes an empty file.
    await u.dav('MKCOL', `${root}/Locked/`).expect(201);
    const fl = await u.dav('LOCK', `${root}/Locked/`).send(LOCKINFO()).expect(200);
    const ft = /<([^>]+)>/.exec(fl.headers['lock-token'] as string)![1]!;
    await u.dav('PUT', `${root}/Locked/a.txt`).send('a\n').expect(423);
    await u.dav('PUT', `${root}/Locked/a.txt`).set('If', `<http://localhost${root}/Locked/> (<${ft}>)`).send('a\n').expect(201);
    await u.dav('UNLOCK', `${root}/Locked/`).set('Lock-Token', `<${ft}>`).expect(204);
    await u.dav('LOCK', `${root}/new.txt`).send(LOCKINFO()).expect(201);
    expect((await u.dav('GET', `${root}/new.txt`).expect(200)).text).toBe('');
  });

  it('B-3203: quota properties (RFC 4331), 507 over the limit, clearance on every read', async () => {
    const u = await member('alice', [ws]);
    const root = `/dav/files/${await wsSeg(ws)}`;
    await h.s.files.setLimit(h.tenantId, ws, 100, u.user.id);
    await u.dav('PUT', `${root}/a.txt`).send('x'.repeat(40)).expect(201);
    const q = (await u.dav('PROPFIND', `${root}/`).set('Depth', '0').send(PROPFIND('<d:quota-used-bytes/><d:quota-available-bytes/>')).expect(207)).text;
    expect(q).toContain('<d:quota-used-bytes>40</d:quota-used-bytes>');
    expect(q).toContain('<d:quota-available-bytes>60</d:quota-available-bytes>');
    const over = await u.dav('PUT', `${root}/b.txt`).send('y'.repeat(80)).expect(507);
    expect(over.text).toContain('quota-not-exceeded');

    // A confidential file is invisible to an internal member of the same workspace.
    const conf = await member('cora', [ws], 'confidential');
    const c = await login(h, 'cora');
    await c.agent.put(`/api/files/uploads?name=secret.txt&workspace=${ws}&label=confidential`).set('x-csrf-token', c.csrf).set('Content-Type', 'text/plain').send('secret').expect(202);
    await h.s.jobs.runDue();
    expect(hrefs((await conf.dav('PROPFIND', `${root}/`).set('Depth', '1').expect(207)).text)).toContain(`${root}/secret.txt`);
    expect(hrefs((await u.dav('PROPFIND', `${root}/`).set('Depth', '1').expect(207)).text)).not.toContain(`${root}/secret.txt`);
    await u.dav('GET', `${root}/secret.txt`).expect(404);
    // A calendar-only app password reaches no files.
    const cal = await davUser(h, 'calvin', { scopes: ['caldav'] });
    await h.s.tenants.addMember(ws, cal.user.id);
    await cal.dav('PROPFIND', `${root}/`).set('Depth', '0').expect(403);
  });
});
