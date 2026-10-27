/*
 * Sprint 24 (B-1601 to B-1604): the certificate authority on PostgreSQL and MySQL. Two instances share one signer
 * and one database: CRL numbers claimed at the same time stay unique and gap-free, and a certificate revoked through
 * one instance is listed on the other's next CRL and answered revoked by its OCSP responder.
 */
import { createHash, generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { buildCsr, toPem } from '../../src/ops/der.js';
import { children, int, nul, octets, oid, parse, seq } from '../../src/pki/asn1.js';
import { OCSP_OIDS } from '../../src/pki/ocsp.js';
import type { PkiActor } from '../../src/pki/service.js';
import { certificateParts, spkiKeyBits } from '../../src/pki/x509.js';
import { createServices } from '../../src/services.js';
import { startSigner } from '../../src/signer/server.js';
import { testConfig } from '../helpers.js';

const derOfPem = (p: string) => Buffer.from(p.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');

function ocspRequest(issuerPem: string, serialHex: string): Buffer {
  const parts = certificateParts(derOfPem(issuerPem));
  const h = (b: Buffer) => createHash('sha1').update(b).digest();
  return seq(seq(seq(seq(seq(seq(oid(OCSP_OIDS.sha1), nul()), octets(h(parts.subject)), octets(h(spkiKeyBits(parts.spki))), int(Buffer.from(serialHex, 'hex')))))));
}

/** The certStatus tag of the first single response: 0x80 good, 0xa1 revoked, 0x82 unknown. */
function certStatusTag(der: Buffer): number {
  const top = children(parse(der));
  const basic = children(parse(children(children(top[1]!)[0]!)[1]!.value));
  const single = children(children(children(basic[0]!)[2]!)[0]!);
  return single[1]!.tag;
}

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`the certificate authority on ${d.name}`, () => {
    it('issues, revokes and numbers CRLs consistently across two instances', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'exs-'));
      const token = randomBytes(24).toString('base64url') + 'x'.repeat(8);
      const signer = await startSigner({ socketPath: path.join(dir, 'run', 'signer.sock'), key: randomBytes(32).toString('base64'), token });
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, DATA_KEY: '', SIGNER_SOCKET: signer.socketPath, SIGNER_TOKEN: token });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const one = createServices(cfg, db, createLogger('silent', false), new Metrics());
      const two = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        await bootstrap(one);
        const tenant = (await one.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const by: PkiActor = { tenantId: tenant.id, userId: null, actor: { service: 'test' } };
        const root = await one.pki.createRoot(by, { commonName: 'Integration Root', keyType: 'ecdsa-p256', days: 3650 });
        const inter = await two.pki.createIntermediate(by, tenant.id, { keyType: 'rsa-3072', days: 365 });
        expect(new X509Certificate(inter.certificate_pem).verify(new X509Certificate(root.certificate_pem).publicKey)).toBe(true);
        const profile = await one.pki.createProfile(by, { name: 'web', kind: 'server', maxDays: 30, defaultDays: 30, policy: { domains: ['*.example.test'], allowWildcard: false, ipRanges: [], emailDomains: [], uriPrefixes: [], keyTypes: ['ec-p256'] } });
        const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        const issued = await one.pki.issue(by, inter, { csrPem: toPem(buildCsr(['a.example.test'], privateKey), 'CERTIFICATE REQUEST'), profileId: profile.id });
        await expect(two.pki.issue(by, inter, { csrPem: toPem(buildCsr(['a.example.org'], privateKey), 'CERTIFICATE REQUEST'), profileId: profile.id })).rejects.toThrow(/outside/);

        expect(certStatusTag((await two.pki.ocsp(ocspRequest(inter.certificate_pem, issued.cert.serial))).body)).toBe(0x80);
        await one.pki.revoke(by, issued.cert, 1, null);
        // Instance two had cached a good answer; without Redis the bus is per instance, so drop its cache as the bus would.
        two.bus.emitLocal('pki.changed', { issuerId: inter.id });
        expect(certStatusTag((await two.pki.ocsp(ocspRequest(inter.certificate_pem, issued.cert.serial))).body)).toBe(0xa1);

        const crls = await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? one : two).pki.generateCrl(inter.id)));
        expect(crls.map((c) => c!.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(crls.every((c) => c!.entries === 1)).toBe(true);
        const stored = (await db('pki_crls').where({ issuer_id: inter.id })) as unknown[];
        expect(stored).toHaveLength(6);
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
