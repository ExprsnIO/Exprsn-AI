import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { down as unmigrate131, up as migrate131 } from '../src/db/migrations/131_leaked_password_lists.js';
import { FsBlobStore } from '../src/platform/blob.js';
import { Bloom, bloomSize } from '../src/identity/leaked/bloom.js';
import { md4, ntlm, sha1 } from '../src/identity/leaked/hashes.js';
import { build, ShardCache, VersionReader } from '../src/identity/leaked/store.js';
import type { Actor } from '../src/identity/leaked/service.js';
import { hibpSource, passwordsCommand, selfCheck, type RangeSource } from '../src/cli/passwords.js';
import { harness, localUser, login, loginAdmin, PASSWORD, type Harness } from './helpers.js';

/*
 * 1.9.0, Sprint 55 (B-192, B-193, B-195): leaked-password lists, imported and checked. The migration is applied by
 * hand here (it is not registered yet). The HIBP mirror runs against a fake range server on loopback only.
 */

const hex = (b: Buffer) => b.toString('hex').toUpperCase();
const sha1Hex = (p: string) => hex(createHash('sha1').update(p, 'utf8').digest());

class CountingBlobs extends FsBlobStore {
  gets = 0;
  override async get(key: string): Promise<Buffer | null> {
    this.gets++;
    return super.get(key);
  }
}

async function setup(cfg: Record<string, string> = {}): Promise<{ h: Harness; blobs: CountingBlobs; blobDir: string; workDir: string }> {
  const blobDir = mkdtempSync(path.join(tmpdir(), 'exprsn-leaked-blobs-'));
  const workDir = mkdtempSync(path.join(tmpdir(), 'exprsn-leaked-work-'));
  const blobs = new CountingBlobs(blobDir);
  const h = await harness({ BLOB_DIR: blobDir, LEAKED_WORK_DIR: workDir, ...cfg }, { blobs });
  await unmigrate131(h.s.db);
  await migrate131(h.s.db);
  h.s.leakedPasswords.resetSchemaCache();
  return { h, blobs, blobDir, workDir };
}

const actorFor = (h: Harness): Actor => ({ tenantId: h.tenantId, userId: null, audit: { service: 'test' }, traceId: null, platform: true, identity: true });

async function* text(s: string): AsyncGenerator<Buffer> {
  yield Buffer.from(s, 'utf8');
}

async function importText(h: Harness, listId: string, format: 'hibp' | 'hashes' | 'plain', body: string, activate = true) {
  return h.s.leakedPasswords.upload(actorFor(h), listId, { format, source: text(body), via: 'cli', activate, inline: { onProgress: () => undefined } });
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(f));
    else out.push(f);
  }
  return out;
}

describe('hashes and the Bloom filter', () => {
  it('MD4 and NTLM match the published vectors', () => {
    expect(md4(Buffer.alloc(0)).toString('hex')).toBe('31d6cfe0d16ae931b73c59d7e0c089c0');
    expect(md4(Buffer.from('abc')).toString('hex')).toBe('a448017aaf21d8525fc10ae87aa6729d');
    expect(md4(Buffer.from('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toString('hex')).toBe('e33b4ddc9c38f2199c3e7b164fcc0536');
    expect(hex(ntlm('password'))).toBe('8846F7EAEE8FB117AD06BDD830B7586C');
  });

  it('keeps its false-positive rate near the asked one and never misses an entry', () => {
    const n = 50_000;
    const size = bloomSize(n, 0.001, 64 * 1024 * 1024);
    const bloom = new Bloom(size.bits, size.hashes);
    const inside: Buffer[] = [];
    for (let i = 0; i < n; i++) {
      const d = sha1(Buffer.from(`in-${i}`));
      bloom.add(d);
      inside.push(d);
    }
    expect(inside.every((d) => bloom.has(d))).toBe(true);
    let fp = 0;
    const trials = 200_000;
    for (let i = 0; i < trials; i++) if (bloom.has(sha1(Buffer.from(`out-${i}`)))) fp++;
    expect(fp / trials).toBeLessThan(0.002);
    expect(size.rate).toBeLessThan(0.0011);
    // Round-trips through its stored form.
    const again = Bloom.from(Buffer.concat([bloom.header(), Buffer.from(bloom.data)]));
    expect(inside.slice(0, 100).every((d) => again.has(d))).toBe(true);
  });

  it('caps the filter and reports the higher rate instead', () => {
    const size = bloomSize(10_000_000, 0.001, 1024 * 1024);
    expect(size.bits).toBe(8 * 1024 * 1024);
    expect(size.rate).toBeGreaterThan(0.01);
  });
});

describe('leaked-password lists: import', () => {
  let h: Harness;
  let blobs: CountingBlobs;
  let blobDir: string;
  let workDir: string;

  beforeAll(async () => {
    ({ h, blobs, blobDir, workDir } = await setup());
  });
  afterAll(async () => {
    await h.close();
    rmSync(blobDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it('with no lists, a check is exactly the BREACHED_* behaviour (off: nothing found)', async () => {
    expect(await h.s.leakedPasswords.check(h.tenantId, 'whatever-password-1')).toEqual({ found: false, action: 'accept' });
    expect(await h.s.leakedPasswords.atSignIn(h.tenantId, 'nobody', 'whatever-password-1')).toEqual({ found: false });
  });

  it('imports every format: HIBP with counts (padding dropped), plain SHA-1 hashes, plain text, and NTLM', async () => {
    const svc = h.s.leakedPasswords;
    const a = actorFor(h);
    const hibp = await svc.create(a, { scope: 'platform', name: 'hibp-sample', hashKind: 'sha1' });
    await importText(h, hibp.id, 'hibp', [`${sha1Hex('hibp-one-password')}:12`, `${sha1Hex('hibp-two-password')}:3\r`, `${sha1Hex('padding-only-pw')}:0`, 'not-a-hash:1', ''].join('\n'));
    const hashes = await svc.create(a, { scope: 'tenant', name: 'hash-sample', hashKind: 'sha1' });
    const r2 = await importText(h, hashes.id, 'hashes', `${sha1Hex('hashes-one-pass')}\n${sha1Hex('hashes-two-pass').toLowerCase()}\nXYZ\n`);
    expect(r2.counts.invalid).toBe(1);
    expect(r2.counts.invalidLines).toEqual([3]);
    const plain = await svc.create(a, { scope: 'tenant', name: 'plain-sample', hashKind: 'sha1' });
    await importText(h, plain.id, 'plain', 'plain-one-password\nplain two password with spaces\n\n');
    const nt = await svc.create(a, { scope: 'platform', name: 'ntlm-sample', hashKind: 'ntlm' });
    await importText(h, nt.id, 'hibp', `${hex(ntlm('ntlm-hash-password'))}:5\n`);
    const ntPlain = await svc.create(a, { scope: 'tenant', name: 'ntlm-plain', hashKind: 'ntlm' });
    await importText(h, ntPlain.id, 'plain', 'ntlm-plain-password\n');

    for (const pw of ['hibp-one-password', 'hibp-two-password', 'hashes-one-pass', 'hashes-two-pass', 'plain-one-password', 'plain two password with spaces', 'ntlm-hash-password', 'ntlm-plain-password']) {
      expect(await svc.check(h.tenantId, pw), pw).toMatchObject({ found: true, action: 'block' });
    }
    expect(await svc.check(h.tenantId, 'padding-only-pw')).toEqual({ found: false, action: 'accept' });
    expect(await svc.check(h.tenantId, 'not-on-any-list-x')).toEqual({ found: false, action: 'accept' });
    const v = await svc.version(hibp.id, 1);
    expect(v).toMatchObject({ state: 'ready', entries: 2, invalid: 1 });
  });

  it('streams a one-million-line plain file with flat memory, and never stores or logs the plain text', async () => {
    const svc = h.s.leakedPasswords;
    const list = await svc.create(actorFor(h), { scope: 'tenant', name: 'million', hashKind: 'sha1' });
    const SAMPLE = 'Sample-Leaked-Pass-7731!';
    const N = 1_000_000;
    global.gc?.();
    const base = process.memoryUsage();
    const baseline = base.heapUsed + base.arrayBuffers;
    let peak = 0;
    const sample = () => {
      const m = process.memoryUsage();
      peak = Math.max(peak, m.heapUsed + m.arrayBuffers - baseline);
    };
    async function* lines(): AsyncGenerator<Buffer> {
      let buf = '';
      for (let i = 0; i < N; i++) {
        buf += i === 777_777 ? `${SAMPLE}\n` : `streamed-pw-${i}-${(i * 7919) % 100_003}\n`;
        if (buf.length > 64 * 1024) {
          yield Buffer.from(buf);
          buf = '';
          if (i % 50_000 === 0) sample();
        }
      }
      if (buf) yield Buffer.from(buf);
    }
    const r = await svc.upload(actorFor(h), list.id, { format: 'plain', source: lines(), via: 'cli', inline: { onProgress: () => sample() } });
    sample();
    expect(r.counts.lines).toBe(N);
    expect(r.version.state).toBe('ready');
    expect(r.version.entries + r.version.duplicates).toBe(N);
    // About 26 MB of text went through; the build holds a 16 KB buffer per bucket, one bucket and the filter.
    expect(peak).toBeLessThan(96 * 1024 * 1024);
    expect(await svc.check(h.tenantId, SAMPLE)).toMatchObject({ found: true });
    expect(await svc.check(h.tenantId, 'streamed-pw-12-95028')).toMatchObject({ found: true });

    // Not in the blob store, nor in the work directory, nor anywhere in the database.
    const needle = Buffer.from(SAMPLE, 'utf8');
    for (const f of walk(blobDir)) expect(readFileSync(f).includes(needle), f).toBe(false);
    expect(walk(workDir)).toEqual([]);
    const tables = (await h.s.db.raw("select name from sqlite_master where type = 'table'")) as { name: string }[];
    for (const t of tables) {
      const rows = await h.s.db(t.name).select('*');
      expect(JSON.stringify(rows).includes(SAMPLE), t.name).toBe(false);
    }
  }, 120_000);

  it('removes duplicates and counts them', async () => {
    const svc = h.s.leakedPasswords;
    const list = await svc.create(actorFor(h), { scope: 'tenant', name: 'dupes', hashKind: 'sha1' });
    const r = await importText(h, list.id, 'hashes', [sha1Hex('dupe-a-password'), sha1Hex('dupe-a-password'), sha1Hex('dupe-b-password'), sha1Hex('dupe-a-password').toLowerCase()].join('\n'));
    expect(r.version).toMatchObject({ entries: 2, duplicates: 2 });
    const shards = (await h.s.db('leaked_password_shards').where({ version_id: r.version.id })) as { entries: number }[];
    expect(shards.reduce((n, x) => n + Number(x.entries), 0)).toBe(2);
  });

  it('answers most misses from the Bloom filter without reading a shard', async () => {
    const svc = h.s.leakedPasswords;
    await svc.check(h.tenantId, 'warm-up-the-readers');
    const before = blobs.gets;
    for (let i = 0; i < 500; i++) await svc.check(h.tenantId, `bloom-miss-${i}`);
    // At most a handful of false positives read a shard; everything else stops at the filter.
    expect(blobs.gets - before).toBeLessThan(15);
  });

  it('replaces a list with a new version and rolls back to the old one', async () => {
    const svc = h.s.leakedPasswords;
    const a = actorFor(h);
    const list = await svc.create(a, { scope: 'tenant', name: 'versions', hashKind: 'sha1' });
    await importText(h, list.id, 'plain', 'version-one-password\n');
    expect(await svc.check(h.tenantId, 'version-one-password')).toMatchObject({ found: true });
    await importText(h, list.id, 'plain', 'version-two-password\n');
    expect(await svc.check(h.tenantId, 'version-one-password')).toMatchObject({ found: false });
    expect(await svc.check(h.tenantId, 'version-two-password')).toMatchObject({ found: true });
    // A version imported without activation waits.
    await importText(h, list.id, 'plain', 'version-three-password\n', false);
    expect(await svc.check(h.tenantId, 'version-three-password')).toMatchObject({ found: false });
    const rolled = await svc.activate(a, list.id, 1);
    expect(rolled.active_version).toBe(1);
    expect(await svc.check(h.tenantId, 'version-one-password')).toMatchObject({ found: true });
    expect(await svc.check(h.tenantId, 'version-two-password')).toMatchObject({ found: false });
    await expect(svc.removeVersion(a, list.id, 1)).rejects.toMatchObject({ status: 409 });
    await svc.removeVersion(a, list.id, 2);
    expect((await svc.versions(list.id)).map((v) => v.version)).toEqual([3, 1]);
    // A disabled list is not checked.
    await svc.update(a, list.id, { enabled: false });
    expect(await svc.check(h.tenantId, 'version-one-password')).toMatchObject({ found: false });
    const actions = ((await h.s.db('audit_events').where('action', 'like', 'passwords.list.%').select('action')) as { action: string }[]).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['passwords.list.created', 'passwords.list.uploaded', 'passwords.list.built', 'passwords.list.activated', 'passwords.list.version.deleted', 'passwords.list.updated']));
  });
});

describe('leaked-password lists: routes, scope and the console upload', () => {
  let h: Harness;
  let blobDir: string;
  let workDir: string;

  beforeAll(async () => {
    ({ h, blobDir, workDir } = await setup());
  });
  afterAll(async () => {
    await h.close();
    rmSync(blobDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it('uploads a list raw, builds it as a job, and keeps platform lists to platform:manage', async () => {
    await localUser(h, 'root', ['system-admin'], 'restricted');
    const root = await loginAdmin(h, 'root');
    const created = await root.agent.post('/api/admin/leaked-passwords/lists').set('x-csrf-token', root.csrf).send({ scope: 'platform', name: 'Common passwords', hashKind: 'sha1' });
    expect(created.status).toBe(201);
    const up = await root.agent.put(`/api/admin/leaked-passwords/lists/${created.body.id}/upload?format=plain&note=first`).set('x-csrf-token', root.csrf).set('content-type', 'text/plain').send('uploaded-leaked-one\nuploaded-leaked-two\n');
    expect(up.status).toBe(202);
    expect(up.body).toMatchObject({ lines: 2, digests: 2, version: { version: 1, state: 'queued' } });
    expect(await h.s.jobs.runNow(up.body.jobId)).toBe(true);
    const one = await root.agent.get(`/api/admin/leaked-passwords/lists/${created.body.id}`);
    expect(one.body).toMatchObject({ name: 'Common passwords', activeVersion: 1, versions: [{ version: 1, state: 'ready', entries: 2, note: 'first' }] });
    const lists = await root.agent.get('/api/admin/leaked-passwords/lists?scope=platform');
    expect(lists.body).toMatchObject({ installed: true, lists: [{ name: 'Common passwords', activeEntries: 2 }] });

    // An identity admin manages the tenant's lists, and only sees how many platform lists apply.
    await localUser(h, 'ida', ['identity-admin'], 'internal');
    const ida = await loginAdmin(h, 'ida');
    const denied = await ida.agent.post('/api/admin/leaked-passwords/lists').set('x-csrf-token', ida.csrf).send({ scope: 'platform', name: 'Mine', hashKind: 'sha1' });
    expect(denied.status).toBe(403);
    expect((await ida.agent.get(`/api/admin/leaked-passwords/lists/${created.body.id}`)).status).toBe(403);
    expect((await ida.agent.get('/api/admin/leaked-passwords/lists?scope=platform')).status).toBe(403);
    const tenantLists = await ida.agent.get('/api/admin/leaked-passwords/lists');
    expect(tenantLists.body).toMatchObject({ scope: 'tenant', lists: [], platformLists: 1 });
    const mine = await ida.agent.post('/api/admin/leaked-passwords/lists').set('x-csrf-token', ida.csrf).send({ scope: 'tenant', name: 'Our products', hashKind: 'sha1' });
    expect(mine.status).toBe(201);
    expect((await ida.agent.post(`/api/admin/leaked-passwords/lists/${mine.body.id}/mirror`).set('x-csrf-token', ida.csrf).send({})).status).toBe(403);

    // A member has no access.
    await localUser(h, 'mem', ['member']);
    const mem = await login(h, 'mem');
    expect((await mem.agent.get('/api/admin/leaked-passwords/lists')).status).toBe(403);
    expect((await mem.agent.get('/api/admin/leaked-passwords/report')).status).toBe(403);

    // Settings: zod-checked and audited.
    const bad = await ida.agent.put('/api/admin/leaked-passwords/settings').set('x-csrf-token', ida.csrf).send({ signinAction: 'nuke' });
    expect(bad.status).toBe(400);
    expect(bad.headers['content-type']).toMatch(/problem\+json/);
    const ok = await ida.agent.put('/api/admin/leaked-passwords/settings').set('x-csrf-token', ida.csrf).send({ signinAction: 'warn', failMode: 'closed', denyWords: ['Acme', 'acme', 'Springfield'] });
    expect(ok.body).toMatchObject({ signinAction: 'warn', failMode: 'closed', denyWords: ['acme', 'Springfield'] });
    expect(await h.s.db('audit_events').where({ action: 'passwords.settings.updated' }).first()).toBeTruthy();
  });
});

describe('leaked-password checks', () => {
  let h: Harness;
  let blobDir: string;
  let workDir: string;
  let listId = '';

  beforeAll(async () => {
    ({ h, blobDir, workDir } = await setup());
    listId = (await h.s.leakedPasswords.create(actorFor(h), { scope: 'platform', name: 'Secret list name', hashKind: 'sha1' })).id;
    await importText(h, listId, 'plain', 'first-version-entry\n');
  });
  afterAll(async () => {
    await h.close();
    rmSync(blobDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  const setAction = async (signinAction: 'warn' | 'require_change' | 'block', failMode: 'open' | 'closed' = 'open') => h.s.leakedPasswords.saveSettings(actorFor(h), { signinAction, failMode });

  it('refuses a listed password in the password pipeline, and names neither the list nor a count', async () => {
    const found = await h.s.leakedPasswords.check(h.tenantId, 'first-version-entry');
    expect(found).toMatchObject({ found: true, action: 'block' });
    const json = JSON.stringify(found);
    expect(json).not.toContain('Secret list name');
    expect(json).not.toContain(listId);
    expect(json).not.toMatch(/\d{2,}/);
    const err = await h.s.account.checkNewPassword({ tenantId: h.tenantId, username: 'someone', password: 'first-version-entry' }).catch((e: unknown) => e as { status: number; detail: string; extensions?: Record<string, unknown> });
    expect(err).toMatchObject({ status: 400 });
    expect(JSON.stringify(err)).not.toContain('Secret list name');
    await expect(h.s.account.checkNewPassword({ tenantId: h.tenantId, username: 'someone', password: 'a fine new passphrase here' })).resolves.toBeTruthy();
  });

  it('fails open or closed by the tenant\'s setting when a list cannot be read', async () => {
    const v = await h.s.leakedPasswords.version(listId, 1);
    const bloom = path.join(blobDir, v.blob_prefix, 'bloom.bin');
    const saved = readFileSync(bloom);
    rmSync(bloom);
    h.s.leakedPasswords.resetSchemaCache();
    (h.s.leakedPasswords as unknown as { readers: Map<string, unknown> }).readers.clear();
    try {
      await setAction('require_change', 'open');
      expect(await h.s.leakedPasswords.check(h.tenantId, 'unreadable-check-pw')).toMatchObject({ unavailable: true, action: 'accept' });
      await h.s.account.checkNewPassword({ tenantId: h.tenantId, username: 'someone', password: 'unreadable but accepted pw' });
      await setAction('require_change', 'closed');
      expect(await h.s.leakedPasswords.check(h.tenantId, 'unreadable-check-pw')).toMatchObject({ unavailable: true, action: 'block' });
      await expect(h.s.account.checkNewPassword({ tenantId: h.tenantId, username: 'someone', password: 'unreadable and refused pw' })).rejects.toMatchObject({ status: 503 });
      const audits = (await h.s.db('audit_events').where({ action: 'password.breach_check.unavailable' })) as unknown[];
      expect(audits.length).toBeGreaterThanOrEqual(2);
    } finally {
      writeFileSync(bloom, saved);
      (h.s.leakedPasswords as unknown as { readers: Map<string, unknown> }).readers.clear();
      await setAction('require_change', 'open');
    }
  });

  it('at sign-in, checks only lists added since the last check, and applies the tenant\'s action', async () => {
    const user = await localUser(h, 'ann', ['member']);
    // Signed in against version 1 (PASSWORD is not on it): recorded as checked.
    const first = await login(h, 'ann');
    expect(first.res.body.stage).toBe('active');
    const rec = await h.s.db('leaked_password_checks').where({ user_id: user.id }).first();
    expect(rec).toBeTruthy();
    // Only versions added since are looked at: version 1 is not checked again, whatever the password.
    expect(await h.s.leakedPasswords.atSignIn(h.tenantId, user.id, 'first-version-entry')).toEqual({ found: false });

    // A new version that lists the password: accepted once, then a change is required (the default).
    await importText(h, listId, 'plain', `first-version-entry\n${PASSWORD}\n`);
    const second = await login(h, 'ann');
    expect(second.res.status).toBe(200);
    expect(second.res.body.stage).toBe('password');
    expect(JSON.stringify(second.res.body)).not.toContain('Secret list name');
    expect((await h.s.db('local_credentials').where({ user_id: user.id }).first()).must_change).toBeTruthy();
    expect(await h.s.db('audit_events').where({ action: 'password.leaked.signin' }).first()).toBeTruthy();

    // Block: refused at every sign-in until the password changes.
    const bob = await localUser(h, 'bob', ['member']);
    await setAction('block');
    await importText(h, listId, 'plain', `${PASSWORD}\n`);
    const blocked = await login(h, 'bob');
    expect(blocked.res.status).toBe(403);
    expect(JSON.stringify(blocked.res.body)).not.toContain('Secret list name');
    expect((await login(h, 'bob')).res.status).toBe(403);

    // Warn: signed in, told once by a security notice.
    const cat = await localUser(h, 'cat', ['member']);
    await setAction('warn');
    const warned = await login(h, 'cat');
    expect(warned.res.body.stage).toBe('active');
    const notice = await h.s.db('notifications').where({ user_id: cat.id, kind: 'security' }).first();
    expect(notice?.title).toMatch(/leaked-password list/);
    expect(JSON.stringify(notice)).not.toContain('Secret list name');
    expect((await login(h, 'cat')).res.body.stage).toBe('active');

    // The report: who was found, and whether they changed it since.
    await h.s.db('local_credentials').where({ user_id: user.id }).update({ updated_at: Date.now() + 1000 });
    const report = await h.s.leakedPasswords.report(h.tenantId);
    expect(report.flagged).toBe(3);
    expect(report.changed).toBe(1);
    expect(report.accounts.find((x) => x.userId === bob.id)).toMatchObject({ action: 'block', changedAt: null });
    expect(JSON.stringify(report)).not.toContain('Secret list name');
    await setAction('require_change');
  });

  it('records the baseline when a checked password is saved, so sign-in only checks lists added after it', async () => {
    const activeId = async () => {
      const l = await h.s.db('leaked_password_lists').where({ id: listId }).first();
      return ((await h.s.db('leaked_password_versions').where({ list_id: listId, version: l.active_version }).first()) as { id: string }).id;
    };
    // PASSWORD is on the active version: dan signs in to the password stage and changes it through the console route.
    const dan = await localUser(h, 'dan', ['member']);
    const first = await login(h, 'dan');
    expect(first.res.body.stage).toBe('password');
    const NEW = 'a brand new passphrase for him';
    const changed = await first.agent.post('/api/me/password').set('x-csrf-token', first.csrf).send({ currentPassword: PASSWORD, newPassword: NEW });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const rec = await h.s.db('leaked_password_checks').where({ user_id: dan.id }).first();
    expect(JSON.parse(rec.versions)).toEqual([await activeId()]);
    expect(rec.flagged_at).toBeTruthy(); // the flag stays for the report
    expect((await h.s.leakedPasswords.report(h.tenantId)).accounts.find((x) => x.userId === dan.id)?.changedAt).toBeTruthy();

    // No list added since: signing in with the new password checks nothing and is not flagged again.
    const flagsBefore = (await h.s.db('audit_events').where({ action: 'password.leaked.signin' })).length;
    expect((await login(h, 'dan', NEW)).res.body.stage).toBe('active');
    expect((await h.s.db('audit_events').where({ action: 'password.leaked.signin' })).length).toBe(flagsBefore);

    // A version added after the change is still checked at the next sign-in.
    await importText(h, listId, 'plain', `${NEW}\n${PASSWORD}\n`);
    expect((await login(h, 'dan', NEW)).res.body.stage).toBe('password');

    // A list changed after the check started is left out of the baseline (it is checked at sign-in instead).
    await h.s.leakedPasswords.markChecked(h.tenantId, dan.id, 1);
    expect(JSON.parse((await h.s.db('leaked_password_checks').where({ user_id: dan.id }).first()).versions)).toEqual([]);
    expect(await h.s.leakedPasswords.atSignIn(h.tenantId, dan.id, NEW)).toMatchObject({ found: true });

    // An admin creating an account with a checked password records it too.
    await localUser(h, 'eve', ['tenant-admin'], 'restricted');
    await setAction('warn'); // eve's own password is on the list; she only needs to be signed in
    const eve = await loginAdmin(h, 'eve');
    await setAction('require_change');
    const made = await eve.agent.post('/api/admin/users').set('x-csrf-token', eve.csrf).send({ username: 'fay', displayName: 'Fay', password: 'a clean passphrase of her own', roles: ['member'] });
    expect(made.status).toBe(201);
    const fay = await h.s.db('leaked_password_checks').where({ user_id: made.body.id }).first();
    expect(JSON.parse(fay.versions)).toEqual([await activeId()]);
  });
});

describe('the HIBP mirror (fake range server only)', () => {
  let h: Harness;
  let blobDir: string;
  let workDir: string;
  let server: Server;
  let url = '';
  const requests: { path: string; at: number }[] = [];
  const failOnce = new Set<string>(['00028']);
  const byPrefix = new Map<string, string[]>();
  const known: string[] = [];
  const TOTAL = 64;

  beforeAll(async () => {
    // Real passwords whose SHA-1 falls in the first 64 range prefixes, plus random suffixes.
    for (let i = 0; known.length < 3; i++) {
      const pw = `mirror-pw-${i}`;
      if (parseInt(sha1Hex(pw).slice(0, 5), 16) < TOTAL) known.push(pw);
    }
    for (let p = 0; p < TOTAL; p++) {
      const prefix = p.toString(16).toUpperCase().padStart(5, '0');
      const suffixes = Array.from({ length: 3 }, () => randomBytes(18).toString('hex').toUpperCase().slice(0, 35));
      for (const pw of known) if (sha1Hex(pw).startsWith(prefix)) suffixes.push(sha1Hex(pw).slice(5));
      byPrefix.set(prefix, suffixes.sort());
    }
    server = createServer((req, res) => {
      requests.push({ path: req.url ?? '', at: Date.now() });
      const m = /^\/range\/([0-9A-F]{5})$/.exec(req.url ?? '');
      if (!m) return void res.writeHead(404).end();
      if (failOnce.delete(m[1]!)) return void res.writeHead(404).end();
      const lines = (byPrefix.get(m[1]!) ?? []).map((s) => `${s}:7`).concat(['0000000000000000000000000000000000A:0']);
      res.writeHead(200, { 'content-type': 'text/plain' }).end(lines.join('\r\n'));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ({ h, blobDir, workDir } = await setup({ BREACHED_HIBP_URL: url, LEAKED_MIRROR_RPS: '40' }));
  });
  afterAll(async () => {
    await h.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(blobDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it('stops on a failing range, resumes from its cursor, and keeps to the rate limit', async () => {
    const svc = h.s.leakedPasswords;
    const a = actorFor(h);
    const list = await svc.create(a, { scope: 'platform', name: 'hibp-mirror', hashKind: 'sha1' });
    const tenantList = await svc.create(a, { scope: 'tenant', name: 'tenant-only', hashKind: 'sha1' });
    await expect(svc.startMirror(a, tenantList.id)).rejects.toMatchObject({ status: 400 });
    const { version, jobId } = await svc.startMirror(a, list.id, { total: TOTAL });
    expect(jobId).toBeTruthy();
    const ctx = { progress: async () => undefined, signal: new AbortController().signal };
    await expect(svc.runMirrorJob(version.id, ctx)).rejects.toThrow(/404/);
    const stopped = await svc.version(list.id, version.version);
    expect(stopped.state).toBe('failed');
    expect(stopped.mirror_cursor).toBe(40); // batches of 8: 00000 to 00027 are in, the batch with 00028 is not
    const firstRun = requests.length;

    // Resume: a second start finds the stopped version and continues it.
    const again = await svc.startMirror(a, list.id, { total: TOTAL });
    expect(again.version.id).toBe(version.id);
    await svc.runMirrorJob(version.id, ctx);
    const resumed = requests.slice(firstRun).map((r) => r.path);
    expect(resumed[0]).toBe('/range/00028');
    expect(resumed.some((p) => parseInt(p.slice(-5), 16) < 40)).toBe(false);
    expect(new Set(requests.map((r) => r.path)).size).toBe(TOTAL);

    const done = await svc.version(list.id, version.version);
    expect(done).toMatchObject({ state: 'ready', entries: [...byPrefix.values()].reduce((n, x) => n + x.length, 0) });
    for (const pw of known) expect(await svc.check(h.tenantId, pw)).toMatchObject({ found: true });
    expect(await svc.check(h.tenantId, 'mirror-pw-not-there')).toMatchObject({ found: false });

    // 40 requests a second: request starts are at least about 25 ms apart.
    const resumedAt = requests.slice(firstRun).map((r) => r.at);
    const span = resumedAt[resumedAt.length - 1]! - resumedAt[0]!;
    expect(span).toBeGreaterThanOrEqual(((resumedAt.length - 1) * 1000) / 40 - 60);
    for (let i = 8; i < resumedAt.length; i++) expect(resumedAt[i]! - resumedAt[i - 8]!).toBeGreaterThanOrEqual(8 * 25 - 30);
    expect(requests.every((r) => /^\/range\/[0-9A-F]{5}$/.test(r.path))).toBe(true);
  }, 30_000);
});

describe('passwords:check is k-anonymous', () => {
  let h: Harness;
  let blobDir: string;
  let workDir: string;

  beforeAll(async () => {
    ({ h, blobDir, workDir } = await setup());
  });
  afterAll(async () => {
    await h.close();
    rmSync(blobDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it('sends only a five-character prefix to every source and compares the suffixes here', async () => {
    const svc = h.s.leakedPasswords;
    const list = await svc.create(actorFor(h), { scope: 'tenant', name: 'cli-list', hashKind: 'sha1' });
    await importText(h, list.id, 'plain', 'cli-listed-password\n');
    const seen: string[] = [];
    const recording = (src: RangeSource): RangeSource => ({ ...src, range: (prefix) => (seen.push(prefix), src.range(prefix)) });
    const local = recording({ name: 'lists', kind: 'sha1', range: (prefix) => svc.range(h.tenantId, 'sha1', prefix) });
    expect(await selfCheck('cli-listed-password', [local])).toMatchObject({ found: true });
    expect(await selfCheck('cli-unlisted-password', [local])).toMatchObject({ found: false });
    expect(seen).toEqual([sha1Hex('cli-listed-password').slice(0, 5), sha1Hex('cli-unlisted-password').slice(0, 5)]);
    expect(seen.every((p) => /^[0-9A-F]{5}$/.test(p))).toBe(true);

    // Against a range API: the request carries the prefix and nothing else of the password or its hash.
    const got: { url: string; headers: string }[] = [];
    const srv = createServer((req, res) => {
      got.push({ url: req.url ?? '', headers: JSON.stringify(req.headers) });
      res.writeHead(200).end(`${sha1Hex('online-listed-pw').slice(5)}:3\r\n0000000000000000000000000000000000A:0`);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const online = hibpSource(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, 'sha1', 2000);
      expect(await selfCheck('online-listed-pw', [online])).toMatchObject({ found: true, asked: 1 });
      expect(got[0]!.url).toBe(`/range/${sha1Hex('online-listed-pw').slice(0, 5)}`);
      for (const g of got) {
        expect(g.url + g.headers).not.toContain('online-listed-pw');
        expect(g.url + g.headers).not.toContain(sha1Hex('online-listed-pw').slice(5));
      }
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('imports and lists from the CLI', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'exprsn-leaked-cli-'));
    try {
      const file = path.join(dir, 'list.txt');
      writeFileSync(file, `${sha1Hex('cli-file-pw-one')}:4\n${sha1Hex('cli-file-pw-two')}:1\n`);
      const out: string[] = [];
      const code = await passwordsCommand(h.s, 'passwords:import', [file, '--list', 'from-cli', '--create'], (t) => void out.push(t), () => undefined);
      expect(code).toBe(0);
      expect(out.join('')).toMatch(/Version 1 of from-cli: 2 lines read, 0 invalid, 2 hashes/);
      const listed: string[] = [];
      expect(await passwordsCommand(h.s, 'passwords:lists', ['--platform'], (t) => void listed.push(t))).toBe(0);
      expect(listed.join('')).toMatch(/from-cli {2}sha1 {2}enabled {2}active v1 {2}2 hashes/);
      expect(await h.s.leakedPasswords.check(h.tenantId, 'cli-file-pw-two')).toMatchObject({ found: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('performance', () => {
  let h: Harness;
  let blobDir: string;
  let workDir: string;

  beforeAll(async () => {
    ({ h, blobDir, workDir } = await setup());
  });
  afterAll(async () => {
    await h.close();
    rmSync(blobDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it('checks against a ten-million-entry list in under 5 ms after warm-up', async () => {
    const N = 10_000_000;
    const listed = Array.from({ length: 200 }, (_, i) => `perf-listed-${i}`);
    async function* generated(): AsyncGenerator<Buffer> {
      const per = 50_000;
      for (let b = 0; b < N / per; b++) {
        const block = randomBytes(per * 20);
        if (b < listed.length) sha1(Buffer.from(listed[b]!)).copy(block, 0);
        yield block;
      }
    }
    const svc = h.s.leakedPasswords;
    const list = await svc.create(actorFor(h), { scope: 'platform', name: 'ten-million', hashKind: 'sha1' });
    const vid = 'PERFVERSION000000000000001';
    const blobPrefix = `leaked-passwords/${list.id}/${vid}`;
    const started = Date.now();
    const r = await build(generated(), { blobs: h.s.blobs, kind: 'sha1', blobPrefix, total: N, fpRate: 0.001, bloomMaxBytes: 512 * 1024 * 1024, workDir });
    const buildMs = Date.now() - started;
    expect(r.entries).toBeGreaterThan(N - 10);
    expect(r.prefixLen).toBe(2);
    await h.s.db('leaked_password_versions').insert({ id: vid, list_id: list.id, version: 1, state: 'ready', format: 'hashes', source: 'test', activate: true, entries: r.entries, bytes: r.bytes, bloom_bits: r.bloom.bits, bloom_hashes: r.bloom.hashes, fp_rate: r.bloom.rate, prefix_len: r.prefixLen, blob_prefix: blobPrefix, created_at: Date.now() });
    for (let i = 0; i < r.shards.length; i += 200) await h.s.db('leaked_password_shards').insert(r.shards.slice(i, i + 200).map((sh) => ({ version_id: vid, ...sh })));
    await h.s.db('leaked_password_lists').where({ id: list.id }).update({ active_version: 1, latest_version: 1 });
    svc.resetSchemaCache();

    // Warm-up: the filter is read once, and the shards of the listed passwords come into the cache.
    for (const pw of listed) expect(await svc.check(h.tenantId, pw)).toMatchObject({ found: true });
    for (let i = 0; i < 500; i++) await svc.check(h.tenantId, `perf-warm-${i}`);

    const times: number[] = [];
    for (let round = 0; round < 3; round++) {
      for (const pw of listed) {
        const t = process.hrtime.bigint();
        const res = await svc.check(h.tenantId, pw);
        times.push(Number(process.hrtime.bigint() - t) / 1e6);
        expect(res).toMatchObject({ found: true });
      }
      for (let i = 0; i < 300; i++) {
        const t = process.hrtime.bigint();
        await svc.check(h.tenantId, `perf-miss-${round}-${i}`);
        times.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
    }
    times.sort((a, b) => a - b);
    const p99 = times[Math.floor(times.length * 0.99)]!;
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    // eslint-disable-next-line no-console -- the measured figures, for the report
    console.log(`10M-entry list: built in ${buildMs} ms, ${r.shards.length} shards, Bloom ${(r.bloom.bits / 8 / 1024 / 1024).toFixed(1)} MB; check mean ${mean.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms, max ${times[times.length - 1]!.toFixed(3)} ms`);
    expect(p99).toBeLessThan(5);
    expect(mean).toBeLessThan(5);

    // The direct reader, without the service around it.
    const reader = await VersionReader.open(h.s.blobs, new ShardCache(64 * 1024 * 1024), { id: vid, kind: 'sha1', blobPrefix, prefixLen: r.prefixLen, shards: r.shards.map((x) => x.prefix) });
    expect(await reader.has(sha1(Buffer.from(listed[3]!)))).toBe(true);
    // Everything stays in the temporary blob directory; the work directory is cleaned.
    expect(walk(workDir)).toEqual([]);
    expect(walk(blobDir).reduce((n, f) => n + statSync(f).size, 0)).toBeGreaterThan(N * 20);
  }, 600_000);
});
