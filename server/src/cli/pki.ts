import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pem } from '../pki/asn1.js';
import { PkiError, type CertRow, type PkiActor } from '../pki/service.js';
import { REASONS, reasonName, type San } from '../pki/x509.js';
import type { Services } from '../services.js';

/*
 * Sprint 25 (B-1607, B-2103): `exprsn-ai pki`. The commands act as the operator (`{ service: 'cli' }` in the audit
 * chain) on the tenant named by `--tenant` (default DEFAULT_TENANT), through the same service as the API, so the same
 * policy checks, audit entries and CRL jobs apply. Each command writes to `out` and returns its exit code, so the
 * tests run it against a test database. Exit codes: 0 done, 1 refused or failed, 3 conflict, 64 usage.
 */

export type Out = (text: string) => void;

export const PKI_USAGE = `exprsn-ai pki <command> [--tenant <slug>]

  issuers [--json]                   The platform root and this tenant's intermediates
  list [--state valid|revoked]       Issued certificates, newest first
      [--issuer <id>] [--limit <n>] [--json]
  issue --csr <file> --profile <name|id>
      [--san dns:<name>|ip:<addr>|email:<addr>|uri:<uri>]...
                                     Names to issue instead of the request's own
      [--days <n>]                   Lifetime (default: the profile's)
      [--out <file>]                 Write the certificate and chain (PEM) here instead of printing it
  revoke <certificate id | serial>   Revoke; the issuer's next CRL is queued at once
      [--reason <reason>]            ${Object.keys(REASONS).join(', ')}
  crl [--issuer <id>] [--out <file>] Sign the issuer's next CRL now (default: this tenant's active intermediate) and
      [--der]                        print it as PEM, or write it (PEM, or DER with --der)
`;

const operator = (tenantId: string): PkiActor => ({ tenantId, userId: null, actor: { service: 'cli' } });

async function tenantId(s: Services, slug: string | undefined): Promise<string> {
  const t = await s.tenants.bySlug(slug ?? s.cfg.DEFAULT_TENANT);
  if (!t) throw new Error(`Unknown tenant ${slug ?? s.cfg.DEFAULT_TENANT}`);
  return t.id;
}

function parseSan(v: string): San {
  const m = /^(dns|ip|email|uri):(.+)$/.exec(v);
  if (!m) throw new Error(`--san ${v}: use dns:<name>, ip:<address>, email:<address> or uri:<uri>`);
  return { type: m[1] as San['type'], value: m[2]! };
}

const line = (c: CertRow) => `${c.id}  ${c.serial.padEnd(32)}  ${c.state.padEnd(7)}  ${new Date(c.not_after).toISOString().slice(0, 10)}  ${c.common_name ?? c.sans.map((x) => x.value).join(',')}`;

export async function pkiCommand(s: Services, argv: string[], out: Out): Promise<number> {
  const [sub, ...rest] = argv;
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { tenant: { type: 'string' }, json: { type: 'boolean' }, state: { type: 'string' }, issuer: { type: 'string' }, limit: { type: 'string' }, csr: { type: 'string' }, profile: { type: 'string' }, san: { type: 'string', multiple: true }, days: { type: 'string' }, out: { type: 'string' }, reason: { type: 'string' }, der: { type: 'boolean' } }
    });
    switch (sub) {
      case 'issuers': {
        const t = await tenantId(s, values.tenant);
        const rows = await s.pki.issuers(t);
        if (values.json) out(JSON.stringify(rows.map((i) => ({ id: i.id, kind: i.kind, name: i.name, state: i.state, keyType: i.key_type, custody: i.custody, notAfter: i.not_after })), null, 2) + '\n');
        else if (!rows.length) out('No issuers.\n');
        else for (const i of rows) out(`${i.id}  ${i.kind.padEnd(12)}  ${i.state.padEnd(7)}  ${i.key_type.padEnd(10)}  ${new Date(i.not_after).toISOString().slice(0, 10)}  ${i.name}\n`);
        return 0;
      }
      case 'list': {
        if (values.state && values.state !== 'valid' && values.state !== 'revoked') throw new Error('--state is valid or revoked');
        const limit = values.limit ? Number(values.limit) : 100;
        if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error('--limit is 1 to 10000');
        const t = await tenantId(s, values.tenant);
        const rows = await s.pki.certificates(t, { issuerId: values.issuer, state: values.state as 'valid' | 'revoked' | undefined, limit });
        if (values.json) out(JSON.stringify(rows.map((c) => ({ id: c.id, serial: c.serial, state: c.state, commonName: c.common_name, sans: c.sans, notAfter: c.not_after, revocationReason: c.revocation_reason === null ? null : reasonName(c.revocation_reason) })), null, 2) + '\n');
        else if (!rows.length) out('No certificates.\n');
        else for (const c of rows) out(line(c) + '\n');
        return 0;
      }
      case 'issue': {
        if (!values.csr || !values.profile) throw new Error('--csr <file> and --profile <name|id> are required');
        const days = values.days ? Number(values.days) : undefined;
        if (days !== undefined && (!Number.isInteger(days) || days < 1)) throw new Error('--days is a whole number of days');
        const t = await tenantId(s, values.tenant);
        const by = operator(t);
        const profile = (await s.pki.profiles(t)).find((p) => p.id === values.profile || p.name === values.profile);
        if (!profile) throw new Error(`Unknown profile ${values.profile}`);
        const issuer = await s.pki.activeIntermediate(t);
        if (!issuer) throw new PkiError(409, 'This tenant has no active intermediate.');
        const r = await s.pki.issue(by, issuer, { csrPem: readFileSync(values.csr, 'utf8'), profileId: profile.id, days, sans: values.san?.map(parseSan) });
        const chain = [r.cert.certificate_pem, ...r.chain].join('');
        if (values.out) {
          writeFileSync(values.out, chain, { mode: 0o644 });
          out(`Issued ${r.cert.id} (serial ${r.cert.serial}), valid until ${new Date(r.cert.not_after).toISOString()}${r.clamped ? ' (shortened to the issuer\'s lifetime)' : ''}; written to ${values.out}.\n`);
        } else out(chain);
        return 0;
      }
      case 'revoke': {
        const ref = positionals[0];
        if (!ref) throw new Error('Name the certificate: pki revoke <id | serial>');
        const reason = (values.reason ?? 'unspecified') as keyof typeof REASONS;
        if (!(reason in REASONS)) throw new Error(`--reason is one of ${Object.keys(REASONS).join(', ')}`);
        const t = await tenantId(s, values.tenant);
        const cert = (await s.pki.certificate(t, ref)) ?? (await findBySerial(s, t, ref));
        if (!cert) throw new Error(`No certificate ${ref} in this tenant`);
        const r = await s.pki.revoke(operator(t), cert, REASONS[reason], null);
        out(`Revoked ${r.id} (serial ${r.serial}, ${reason}); the next CRL is queued.\n`);
        return 0;
      }
      case 'crl': {
        const t = await tenantId(s, values.tenant);
        const issuer = values.issuer ? await s.pki.issuer(values.issuer) : await s.pki.activeIntermediate(t);
        if (!issuer || (issuer.tenant_id !== null && issuer.tenant_id !== t)) throw new Error(values.issuer ? `No issuer ${values.issuer} for this tenant` : 'This tenant has no active intermediate.');
        const crl = await s.pki.generateCrl(issuer.id);
        if (!crl) throw new PkiError(409, 'The issuer is revoked or expired; it signs no more CRLs.');
        await s.audit.append({ tenantId: t, action: 'pki.crl.requested', kind: 'admin', actor: { service: 'cli' }, target: { issuer: issuer.id }, label: 'internal', detail: { number: crl.number, entries: crl.entries } });
        const der = Buffer.from(crl.der, 'base64');
        if (values.out) {
          writeFileSync(values.out, values.der ? der : pem(der, 'X509 CRL'));
          out(`CRL ${crl.number} for ${issuer.name}: ${crl.entries} revoked, next update ${new Date(crl.next_update).toISOString()}; written to ${values.out}.\n`);
        } else out(pem(der, 'X509 CRL'));
        return 0;
      }
      default:
        out(PKI_USAGE);
        return sub ? 64 : 0;
    }
  } catch (err) {
    out(`error: ${(err as Error).message}\n`);
    return err instanceof PkiError && err.status === 409 ? 3 : 1;
  }
}

async function findBySerial(s: Services, tenantId: string, serial: string): Promise<CertRow | undefined> {
  const hex = serial.toLowerCase().replace(/:/g, '');
  if (!/^[0-9a-f]{2,64}$/.test(hex)) return undefined;
  const row = (await s.db('pki_certificates').where({ tenant_id: tenantId, serial: hex }).first('id')) as { id: string } | undefined;
  return row ? s.pki.certificate(tenantId, row.id) : undefined;
}
