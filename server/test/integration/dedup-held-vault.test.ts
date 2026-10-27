/*
 * 1.6.0, Sprint 36b against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 038b_dedup_held_vault; B-4601: two uploads of one file in a tenant
 *                                  share one blob (the conditional reference count and the per-tenant unique key),
 *                                  the savings query, a purge that leaves the other readable and the last one that
 *                                  frees the object, the backfill of existing versions; B-4701: a held public
 *                                  submission routed to a moderation queue and accepted into a record; B-4803: a
 *                                  burst of reveals from a new address raising a flag for the owner
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { backfillBlobs } from '../../src/db/migrations/038b_dedup_held_vault.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { Limiter } from '../../src/platform/ratelimit.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

async function* once(b: Buffer) {
  yield b;
}
const collect = async (it: AsyncIterable<Buffer>) => {
  const parts: Buffer[] = [];
  for await (const c of it) parts.push(c);
  return Buffer.concat(parts);
};

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`Sprint 36b on ${d.name}`, () => {
    it('migrates 038b_dedup_held_vault and shares blobs, holds submissions and flags reveals on it', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, BLOB_DIR: mkdtempSync(path.join(tmpdir(), 'exprsn-36b-it-')) });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      const drain = async () => {
        for (let i = 0; i < 20; i++) if (!(await s.jobs.runDue())) return;
      };
      try {
        for (const t of ['file_blobs', 'app_form_holds', 'vault_reveals', 'vault_reveal_flags']) expect(await db.schema.hasTable(t), t).toBe(true);
        expect(await db.schema.hasColumn('file_versions', 'blob_id')).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const ws = await s.tenants.createWorkspace(tenant.id, 'Sales', 'confidential');
        const person = async (username: string, roles: string[], clearance: 'internal' | 'confidential' = 'confidential') => {
          const u = await s.users.create(tenant.id, { username, displayName: username.toUpperCase(), clearance });
          await s.users.update(tenant.id, u.id, { clearance_direct: clearance });
          await s.users.setRoles(u.id, 'direct', roles);
          await s.tenants.addMember(ws.id, u.id);
          const p = (await loadPrincipal(s, tenant.id, u.id, {}))!;
          p.workspaceId = ws.id;
          return { u, p };
        };
        const mo = await person('mo', ['member'], 'internal');

        // ---- B-4601: one blob for two uploads of one file ----
        const body = Buffer.from('identical bytes\n'.repeat(500));
        const a = await s.files.upload(mo.p, { workspaceId: ws.id, name: 'a.txt', label: 'internal', declaredType: 'text/plain', declaredBytes: null }, once(body));
        const b = await s.files.upload(mo.p, { workspaceId: ws.id, name: 'b.txt', label: 'internal', declaredType: 'text/plain', declaredBytes: null }, once(body));
        await drain();
        const blobs = await db('file_blobs').where({ tenant_id: tenant.id });
        expect(blobs).toHaveLength(1);
        expect(Number(blobs[0].refs)).toBe(2);
        const keys = (await db('file_versions').whereIn('file_id', [a.file.id, b.file.id]).select('blob_key')).map((r: { blob_key: string }) => r.blob_key);
        expect(new Set(keys).size).toBe(1);
        const saved = (await s.files.dedup.savings()).find((x) => x.tenantId === tenant.id)!;
        expect(saved).toMatchObject({ blobs: 1, shared: 1, references: 2, storedBytes: body.length, savedBytes: body.length, logicalBytes: 2 * body.length });
        // A concurrent adoption and a duplicate registration are refused by the database, not by luck.
        expect(await s.files.dedup.register({ id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ', tenant_id: tenant.id, sha256: blobs[0].sha256, size: body.length, blob_key: 'x', sealed_key: 'y' })).toBe(false);
        await s.files.trashFile(mo.p, a.file.id);
        await db('files').where({ id: a.file.id }).update({ purge_after: Date.now() - 1 });
        expect(await s.files.purge(tenant.id)).toMatchObject({ files: 1 });
        expect(Number((await db('file_blobs').where({ id: blobs[0].id }).first()).refs)).toBe(1);
        expect(await collect((await s.files.content(mo.p, b.file.id)).stream)).toEqual(body);
        await s.files.trashFile(mo.p, b.file.id);
        await db('files').where({ id: b.file.id }).update({ purge_after: Date.now() - 1 });
        await s.files.purge(tenant.id);
        expect(await db('file_blobs').where({ tenant_id: tenant.id })).toHaveLength(0);
        expect(await s.blobs.get(keys[0]!)).toBeNull();
        // The backfill registers versions stored before the migration.
        const c = await s.files.upload(mo.p, { workspaceId: ws.id, name: 'c.txt', label: 'internal', declaredType: 'text/plain', declaredBytes: null }, once(Buffer.from('older')));
        await drain();
        await db('file_blobs').delete();
        await db('file_versions').update({ blob_id: null });
        expect(await backfillBlobs(db)).toBe(1);
        expect((await db('file_versions').where({ file_id: c.file.id }).first()).blob_id).toBeTruthy();

        // ---- B-4701: a held public submission, accepted from the moderation queue ----
        const dee = await person('dee', ['workflow-admin', 'member']);
        const ga = await person('ga', ['guardrail-admin']);
        const actor = { principal: dee.p, source: 'api' as const };
        await s.apps.create(actor, { name: 'crm', label: 'confidential', workspaceId: ws.id });
        await s.apps.createEntity(actor, 'crm', { name: 'lead', label: 'internal', definition: { fields: [{ name: 'email', type: 'string', required: true, maxLength: 200 }, { name: 'note', type: 'string', multiline: true }] } as never });
        await s.apps.forms.create(actor, 'crm', { name: 'contact', entity: 'lead', definition: { fields: [{ field: 'email' }, { field: 'note' }] } });
        const { token } = await s.apps.forms.setPublic(actor, 'crm', 'contact', true);
        const allow = s.guardrails;
        s.guardrails = {
          check: async (i) => (i.checkpoint === 'user-input' && /wire transfer/i.test(i.text) ? { action: 'require-approval', text: i.text, findings: [{ ruleId: 'wire', ruleName: 'Wire transfers', action: 'require-approval', stage: 'enforce' }], reason: 'Payment instructions are reviewed.' } : allow.check(i))
        };
        const q = await s.moderation.saveQueue({ tenantId: tenant.id, principal: ga.p, actor: { user: ga.u.id } }, null, { name: 'Held forms', kinds: ['hold'], workspaceId: ws.id, slaMinutes: 60, escalateTo: 'tenant' });
        const limiter = new Limiter(s.counters, 'it-36b', 100, 60_000);
        const out = await s.apps.forms.submitPublic(token!, { email: 'x@example.test', note: 'send the wire transfer' }, '198.51.100.7', undefined, limiter);
        expect(out).toMatchObject({ submitted: true, held: true });
        const items = (await s.moderation.queueFlags(ga.p, q.id)).items;
        expect(items).toHaveLength(1);
        const held = (await s.apps.forms.held.list(ga.p))[0]!;
        expect(held.flag?.ref).toBe(items[0]!.ref);
        const dec = await s.apps.forms.held.decide(ga.p, held.id, 'accept', 'a real customer', { ip: null, traceId: null });
        expect(dec).toMatchObject({ state: 'accepted', flag: { state: 'approved' } });
        expect(await db('app_records').where({ id: dec.recordId!, source: 'form' }).first()).toBeTruthy();
        s.guardrails = allow;

        // ---- B-4803: a burst from a new address flags the reveal for the owner ----
        const owner = await person('owner', ['tenant-admin'], 'confidential');
        const mel = await person('mel', ['member'], 'internal');
        const oc = await s.vault.callerFor(owner.p, { ip: '198.51.100.1' });
        await s.vault.createGrant(oc, { subjectKind: 'user', subject: owner.u.id, path: '*', capabilities: ['*'], effect: 'allow' });
        await s.vault.createGrant(oc, { subjectKind: 'user', subject: mel.u.id, path: 'kv/apps', capabilities: ['read'], effect: 'allow' });
        await s.vault.write(oc, 'apps/stripe', { key: 'sk_live' });
        await s.vault.read(oc, 'apps/stripe');
        const mc = await s.vault.callerFor(mel.p, { ip: '203.0.113.9' });
        let raised = 0;
        for (let i = 1; i <= 9 && !raised; i++) {
          await s.vault.read(mc, 'apps/stripe');
          if (await db('vault_reveal_flags').first('id')) raised = i;
        }
        expect(raised).toBeGreaterThan(0);
        expect(raised).toBeLessThan(10);
        const flags = await s.revealWatch.list(owner.p);
        expect(flags).toEqual([expect.objectContaining({ path: 'apps/stripe', ownerId: owner.u.id, ip: '203.0.113.9' })]);
        expect(await s.revealWatch.list(mel.p)).toEqual([]);
        expect(await s.revealWatch.resolve(owner.p, flags[0]!.id, 'suspicious', 'rotating')).toMatchObject({ state: 'suspicious' });
      } finally {
        await db.destroy();
      }
    }, 120_000);
  });
}
