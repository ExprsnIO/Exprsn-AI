/*
 * 1.9.0, Sprint 55 (B-187 to B-189) on PostgreSQL and MySQL: migrations 127 and 128 (applied here until they are
 * registered), settings saved and approved under dual control, a use-limited CA token spent concurrently from two
 * instances on one database (never more than its uses), and a member certificate issued and revoked.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { down as down127, up as up127 } from '../../src/db/migrations/127_pki_settings.js';
import { down as down128, up as up128 } from '../../src/db/migrations/128_ca_tokens.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { hashPassword } from '../../src/identity/passwords.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import type { PkiActor } from '../../src/pki/service.js';
import { createServices } from '../../src/services.js';
import { startSigner } from '../../src/signer/server.js';
import { testConfig } from '../helpers.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`CA settings, tokens and member certificates on ${d.name}`, () => {
    it('saves, approves, spends and revokes consistently across two instances', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'exs55-'));
      const token = randomBytes(24).toString('base64url') + 'x'.repeat(8);
      const signer = await startSigner({ socketPath: path.join(dir, 'run', 'signer.sock'), key: randomBytes(32).toString('base64'), token });
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, DATA_KEY: '', SIGNER_SOCKET: signer.socketPath, SIGNER_TOKEN: token });
      const db = createDb(cfg);
      await down128(db).catch(() => undefined);
      await down127(db).catch(() => undefined);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      await up127(db);
      await up128(db);
      const one = createServices(cfg, db, createLogger('silent', false), new Metrics());
      const two = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        await bootstrap(one);
        for (const s of [one, two]) {
          s.pki.registerJobs();
          s.caTokens.registerJobs();
          s.memberCerts.registerJobs();
        }
        const tenant = (await one.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const by = (userId: string | null): PkiActor => ({ tenantId: tenant.id, userId, actor: { service: 'test' } });

        // Settings: a floor-free change applies at once; a tier change waits for a second admin.
        const a = ulidLike('A');
        const b = ulidLike('B');
        const saved = await one.pkiSettings.save(by(a), 'platform', { values: { 'crl.validityHours': 36, 'root.keyType': 'ecdsa-p384' } }, true);
        expect(saved.applied).toEqual(['crl.validityHours']);
        await expect(one.pkiSettings.approve(by(a), saved.proposal!.id, null, true)).rejects.toThrow(/Dual control/);
        await two.pkiSettings.approve(by(b), saved.proposal!.id, null, true);
        // Without Redis the bus is per instance: the other instance reads the row again once its cache goes stale.
        one.pkiSettings.forget();
        two.pkiSettings.forget();
        expect(await two.pki.settings(null)).toMatchObject({ 'crl.validityHours': 36, 'root.keyType': 'ecdsa-p384' });
        await expect(one.pkiSettings.save(by(a), 'tenant', { values: { 'crl.validityHours': 48 } }, false)).rejects.toThrow(/never weaker/);
        await one.pkiSettings.save(by(a), 'tenant', { values: { 'tokens.defaultUses': 5, 'leaf.subject': { O: 'Integration' } } }, false);

        const root = await one.pki.createRoot(by(null), { commonName: 'Integration Root 55' });
        expect(root.key_type).toBe('ecdsa-p384');
        await two.pki.createIntermediate(by(null), tenant.id, {});

        // A token with five uses, validated twenty times from two instances at once.
        const t = await one.caTokens.issue(by(null), { resource: { type: 'url', id: 'https://files.example.test/' }, permissions: ['read'], expiry: { kind: 'uses' } });
        expect(t.row.max_uses).toBe(5);
        const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? one : two).caTokens.validate(by(null), t.token, { permission: 'read' })));
        expect(results.filter((r) => r.active)).toHaveLength(5);
        const row = (await db('pki_tokens').where({ id: t.row.id }).first()) as { uses_left: number; state: string; hash: string };
        expect(Number(row.uses_left)).toBe(0);
        expect(row.state).toBe('spent');
        expect(JSON.stringify(row)).not.toContain(t.token);
        const bulk = await two.caTokens.revokeMany(by(null), { all: true });
        expect(bulk.revoked).toBe(0);

        // A member certificate: issued, then revoked when they leave.
        const profile = await one.pki.createProfile(by(null), { name: 'members', kind: 'client', policy: { domains: [], allowWildcard: false, ipRanges: [], emailDomains: [], uriPrefixes: [`exprsn-member://${tenant.slug}/`], keyTypes: ['ec-p256'] }, maxDays: 365, defaultDays: 90 });
        await one.pkiSettings.save(by(a), 'tenant', { values: { 'members.enabled': true, 'members.profileId': profile.id } }, false);
        const user = await one.users.create(tenant.id, { username: 'member55', displayName: 'Member' });
        await db('local_credentials').insert({ user_id: user.id, password_hash: await hashPassword('lantern ferry umbrella 9'), updated_at: Date.now() });
        one.pkiSettings.forget();
        two.pkiSettings.forget();
        const m = await two.memberCerts.issueFor(tenant.id, user.id);
        expect((await one.memberCerts.active(tenant.id, user.id))?.id).toBe(m.id);
        await one.users.update(tenant.id, user.id, { state: 'disabled' });
        expect(await one.memberCerts.reconcileUser(tenant.id, user.id, 'left')).toEqual({ revoked: 1 });
        const cert = (await db('pki_certificates').where({ id: m.certificate_id }).first()) as { state: string };
        expect(cert.state).toBe('revoked');
      } finally {
        await one.close();
        await two.close();
        await down128(db).catch(() => undefined);
        await down127(db).catch(() => undefined);
        await db.destroy();
        await signer.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 180_000);
  });
}

/** A user id shape for the actors (dual control compares ids; no user row is needed). */
function ulidLike(c: string): string {
  return `01J${c.repeat(23)}`.slice(0, 26);
}
