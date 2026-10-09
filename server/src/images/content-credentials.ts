import type { Services } from '../services.js';
import { serverVersion } from '../ops/instances.js';
import { fromPem } from '../pki/asn1.js';
import { isPng } from './png.js';
import { signPng, verifyPng, type GenerationInfo, type VerifyResult } from './c2pa.js';

/*
 * 1.6.0, Sprint 39a (B-7901): content credentials for generated images. `sign` runs inside the image job after the
 * HMAC provenance chunk is in place: the tenant's content-credentials certificate (issued by the tenant CA on first
 * use, `PkiService.contentSigner`) signs a C2PA manifest that is embedded in the PNG's `caBX` chunk and covers every
 * other byte of the file, so the manifest travels with the bytes through the blob store, downloads and attachments.
 * `verify` reads the manifest back and checks it against the tenant's CA certificates. Not signing is never an
 * error for the job: the image keeps the HMAC manifest and the summary says why.
 */

export interface C2paSummary {
  signed: boolean;
  label?: string;
  instanceId?: string;
  signedAt?: string;
  certificate?: string;
  fingerprint?: string;
  issuer?: string;
  reason?: string;
}

export class ContentCredentials {
  constructor(private readonly s: () => Services) {}

  enabled(): boolean {
    return this.s().cfg.IMAGE_C2PA === 'on';
  }

  async sign(tenantId: string, png: Buffer, info: Omit<GenerationInfo, 'tenantName' | 'generator'>): Promise<{ png: Buffer; summary: C2paSummary }> {
    if (!this.enabled()) return { png, summary: { signed: false, reason: 'Content credentials are off (IMAGE_C2PA).' } };
    if (!isPng(png)) return { png, summary: { signed: false, reason: 'Only PNG images carry a manifest.' } };
    const s = this.s();
    let got;
    try {
      got = await s.pki.contentSigner(tenantId);
    } catch (err) {
      return { png, summary: { signed: false, reason: `The content-credentials certificate could not be issued: ${(err as Error).message}` } };
    }
    if (!got.signer) return { png, summary: { signed: false, reason: got.reason } };
    const { signer, chain } = got;
    const tenant = (await s.db('tenants').where({ id: tenantId }).first('name')) as { name?: string } | undefined;
    const chainDer = [fromPem(signer.certificate_pem, 'CERTIFICATE'), ...chain.map((c) => fromPem(c, 'CERTIFICATE'))];
    try {
      const out = await signPng(png, { ...info, tenantName: tenant?.name ?? null, generator: `Exprsn-AI/${serverVersion()}` }, { chain: chainDer, sign: (data) => s.pki.signContent(signer, data) });
      return { png: out.png, summary: { signed: true, label: out.label, instanceId: out.instanceId, signedAt: out.signedAt, certificate: signer.certificate_id, fingerprint: signer.fingerprint, issuer: signer.issuer_id } };
    } catch (err) {
      s.log.warn({ tenant: tenantId, err: (err as Error).message }, 'C2PA signing failed; the image keeps its HMAC manifest');
      return { png, summary: { signed: false, reason: `Signing failed: ${(err as Error).message}` } };
    }
  }

  /** Verifies a PNG's manifest against the tenant's CA certificates. */
  async verify(tenantId: string, png: Buffer): Promise<VerifyResult> {
    const anchors = (await this.s().pki.contentAnchors(tenantId)).map((p) => fromPem(p, 'CERTIFICATE'));
    return verifyPng(png, { anchors });
  }
}
