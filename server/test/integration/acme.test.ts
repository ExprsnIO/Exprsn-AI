/*
 * Sprint 25 (B-1605, B-1606): the ACME server and expiry notices on PostgreSQL and MySQL. Two instances share one
 * signer and one database: a nonce handed out by one is accepted once by the other, an order placed through one is
 * validated (dns-01) and finalized through the other, the same identifiers under another tenant stay apart, and two
 * instances sweeping expiry notices at the same time send each notice once.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { buildCsr, toPem } from '../../src/ops/der.js';
import type { AcmeContext } from '../../src/pki/acme.js';
import type { PkiActor } from '../../src/pki/service.js';
import { createServices, type Services } from '../../src/services.js';
import { startSigner } from '../../src/signer/server.js';
import { testConfig } from '../helpers.js';

const b64u = (x: string | Buffer) => Buffer.from(x).toString('base64url');
const jwkOf = (k: KeyObject) => {
  const j = k.export({ format: 'jwk' }) as Record<string, string>;
  return { crv: j.crv!, kty: 'EC', x: j.x!, y: j.y! };
};

/** A flattened ES256 JWS as an ACME client sends it. */
function jws(key: KeyObject, url: string, nonce: string, payload: unknown, kid: string | null) {
  const p = b64u(JSON.stringify({ alg: 'ES256', nonce, url, ...(kid ? { kid } : { jwk: jwkOf(key) }) }));
  const pl = payload === null ? '' : b64u(JSON.stringify(payload));
  return { protected: p, payload: pl, signature: b64u(sign('sha256', Buffer.from(`${p}.${pl}`), { key, dsaEncoding: 'ieee-p1363' })) };
}

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`the ACME server on ${d.name}`, () => {
    it('shares nonces, orders and notices across two instances and keeps tenants apart', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'exs-'));
      const token = randomBytes(24).toString('base64url') + 'x'.repeat(8);
      const signer = await startSigner({ socketPath: path.join(dir, 'run', 'signer.sock'), key: randomBytes(32).toString('base64'), token });
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, DATA_KEY: '', SIGNER_SOCKET: signer.socketPath, SIGNER_TOKEN: token, PKI_PUBLIC_URL: 'http://ca.example.test' });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const one = createServices(cfg, db, createLogger('silent', false), new Metrics());
      const two = createServices(cfg, db, createLogger('silent', false), new Metrics());
      const txt = new Map<string, string[]>();
      for (const s of [one, two]) s.pki.acme.validation = { resolveTxt: async (name) => txt.get(name) ?? [] };
      try {
        await bootstrap(one);
        const tenant = (await one.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const other = await one.tenants.create({ slug: 'other', name: 'Other' });
        await one.pki.createRoot({ tenantId: tenant.id, userId: null, actor: { service: 'test' } }, { commonName: 'Integration Root', keyType: 'ecdsa-p256', days: 3650 });
        const setUp = async (s: Services, tenantId: string) => {
          const by: PkiActor = { tenantId, userId: null, actor: { service: 'test' } };
          await s.pki.createIntermediate(by, tenantId, { keyType: 'ecdsa-p256', days: 365 });
          const profile = await s.pki.createProfile(by, { name: 'acme', kind: 'server', maxDays: 30, defaultDays: 30, policy: { domains: ['*.example.test'], allowWildcard: false, ipRanges: [], emailDomains: [], uriPrefixes: [], keyTypes: ['ec-p256'] } });
          await s.pki.acme.updateSettings(by, { enabled: true, profileId: profile.id, challenges: ['dns-01'] });
        };
        await setUp(one, tenant.id);
        await setUp(two, other.id);
        const ctxA: AcmeContext = await one.pki.acme.context(tenant.slug);
        const ctxA2: AcmeContext = await two.pki.acme.context(tenant.slug);
        const ctxB: AcmeContext = await two.pki.acme.context('other');

        // A nonce from one instance is good once on the other.
        const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
        const n1 = await one.pki.acme.newNonce();
        const created = await two.pki.acme.newAccount(ctxA2, jws(key, ctxA2.urls.newAccount, n1, { termsOfServiceAgreed: true }, null), null);
        expect(created.status).toBe(201);
        await expect(one.pki.acme.newAccount(ctxA, jws(key, ctxA.urls.newAccount, n1, {}, null), null)).rejects.toMatchObject({ type: 'badNonce' });
        const kid = created.location!;

        // The same key at the other tenant's directory is a different account; this kid is unknown there.
        const atB = await two.pki.acme.newAccount(ctxB, jws(key, ctxB.urls.newAccount, await two.pki.acme.newNonce(), {}, null), null);
        expect(atB.status).toBe(201);
        expect(atB.location).not.toBe(kid);
        await expect(two.pki.acme.newOrder(ctxB, jws(key, ctxB.urls.newOrder, await two.pki.acme.newNonce(), { identifiers: [{ type: 'dns', value: 'a.example.test' }] }, kid))).rejects.toMatchObject({ type: 'accountDoesNotExist' });

        // Order through one, validate and finalize through two.
        const order = await one.pki.acme.newOrder(ctxA, jws(key, ctxA.urls.newOrder, await one.pki.acme.newNonce(), { identifiers: [{ type: 'dns', value: 'a.example.test' }] }, kid));
        const orderId = order.location!.split('/').pop()!;
        const authzId = (order.body as { authorizations: string[] }).authorizations[0]!.split('/').pop()!;
        const authz = await two.pki.acme.getAuthz(ctxA2, authzId, jws(key, ctxA2.urls.authz(authzId), await two.pki.acme.newNonce(), null, kid));
        const ch = (authz.body as { challenges: { url: string; token: string }[] }).challenges[0]!;
        const thumb = createHash('sha256').update(JSON.stringify(jwkOf(key))).digest('base64url');
        txt.set('_acme-challenge.a.example.test', [createHash('sha256').update(`${ch.token}.${thumb}`).digest('base64url')]);
        const chId = ch.url.split('/').pop()!;
        await one.pki.acme.challenge(ctxA, chId, jws(key, ctxA.urls.challenge(chId), await one.pki.acme.newNonce(), {}, kid));
        expect(await two.pki.acme.validate(chId)).toEqual({ status: 'valid' });
        const csr = buildCsr(['a.example.test'], generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey);
        const fin = await two.pki.acme.finalize(ctxA2, orderId, jws(key, ctxA2.urls.finalize(orderId), await one.pki.acme.newNonce(), { csr: b64u(csr) }, kid));
        expect((fin.body as { status: string }).status).toBe('valid');
        const certRow = (await db('pki_certificates').whereNotNull('acme_account_id').first()) as { tenant_id: string; id: string };
        expect(certRow.tenant_id).toBe(tenant.id);

        // Two instances sweeping at once send each notice once.
        const by: PkiActor = { tenantId: tenant.id, userId: null, actor: { service: 'test' } };
        const inter = (await one.pki.activeIntermediate(tenant.id))!;
        const profile = (await one.pki.profiles(tenant.id))[0]!;
        await one.pki.issue(by, inter, { csrPem: toPem(buildCsr(['soon.example.test'], generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey), 'CERTIFICATE REQUEST'), profileId: profile.id, days: 5 });
        const [a, b] = await Promise.all([one.pki.expirySweep(), two.pki.expirySweep()]);
        const notices = (await db('pki_expiry_notices')) as unknown[];
        expect(a.notified + b.notified).toBe(notices.length);
        expect(notices.length).toBe(2); // the ACME certificate (30 days) and the 5-day one
      } finally {
        await one.close();
        await two.close();
        await db.destroy();
        await signer.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);
  });
}
