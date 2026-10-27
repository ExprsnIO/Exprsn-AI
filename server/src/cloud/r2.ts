import { catalogueRegion } from './catalogue.js';

/*
 * 1.9.99-final, Sprint 61 (B-10906): Cloudflare R2 as an object store.
 *
 * R2 speaks the S3 API, so an install uses it through `BLOB_STORE=s3` (`platform/blob.ts`) for files, backups,
 * training artefacts and export bundles, with nothing R2-specific in the blob store: the endpoint is the account's
 * S3 endpoint (`https://<account id>.r2.cloudflarestorage.com`, or `<account id>.eu.` / `<account id>.fedramp.` for a
 * bucket in a jurisdiction), the signing region `auto`, path-style addressing, and an R2 API token's access key id
 * and secret (the secret as S3_SECRET_ACCESS_KEY_FILE in production).
 *
 * Residency: a bucket made with a jurisdiction keeps its data there. The Cloudflare account's regions name them
 * (`r2-eu` in the `edge-eu` zone, `r2-fedramp` in `edge-us`, `cloud/catalogue.ts`), so a bucket placed in one of
 * those regions passes the same region, ceiling and residency checks as any other placement, and the adapter sends
 * the jurisdiction (`cf-r2-jurisdiction`) when it creates, reads and deletes it. Nothing here calls anything.
 */

export const R2_JURISDICTIONS = ['default', 'eu', 'fedramp'] as const;
export type R2Jurisdiction = (typeof R2_JURISDICTIONS)[number];

/** The jurisdiction a Cloudflare region implies (`r2-eu`, `r2-fedramp`), or null for the global edge. */
export function jurisdictionOfRegion(region: string | null | undefined): Exclude<R2Jurisdiction, 'default'> | null {
  return region === 'r2-eu' ? 'eu' : region === 'r2-fedramp' ? 'fedramp' : null;
}

/** The Cloudflare region a jurisdiction is placed in (`global` for none). */
export const regionOfJurisdiction = (j: R2Jurisdiction): string => (j === 'eu' ? 'r2-eu' : j === 'fedramp' ? 'r2-fedramp' : 'global');

/** A bucket's jurisdiction from its props and region (props win); `default` when neither names one. */
export function bucketJurisdiction(props: { jurisdiction?: R2Jurisdiction | undefined }, region: string | null | undefined): R2Jurisdiction {
  return props.jurisdiction ?? jurisdictionOfRegion(region) ?? 'default';
}

/** The account's S3 endpoint for a jurisdiction. */
export function r2Endpoint(accountId: string, jurisdiction: R2Jurisdiction = 'default'): string {
  if (!/^[0-9a-f]{32}$/.test(accountId)) throw new Error('A Cloudflare account id is 32 hexadecimal characters.');
  return `https://${accountId}${jurisdiction === 'default' ? '' : `.${jurisdiction}`}.r2.cloudflarestorage.com`;
}

/** True for an R2 S3 endpoint (any jurisdiction). */
export const isR2Endpoint = (endpoint: string): boolean => {
  try {
    return /\.r2\.cloudflarestorage\.com$/i.test(new URL(endpoint).hostname);
  } catch {
    return false;
  }
};

/**
 * The plain settings an install needs to keep its blobs in an R2 bucket (`BLOB_STORE=s3`). The access key id and
 * its secret are an R2 API token's; they are not here: the secret goes in S3_SECRET_ACCESS_KEY_FILE.
 */
export function r2BlobSettings(accountId: string, bucket: string, jurisdiction: R2Jurisdiction = 'default'): Record<string, string> {
  return { BLOB_STORE: 's3', S3_ENDPOINT: r2Endpoint(accountId, jurisdiction), S3_REGION: 'auto', S3_BUCKET: bucket, S3_FORCE_PATH_STYLE: 'true' };
}

/**
 * The jurisdiction a deployment's R2 bucket takes when the spec leaves it to `auto`: EU when the deployment's data
 * region is in the EU (so the bucket's data stays where its database is), else none. FedRAMP is only ever chosen
 * explicitly.
 */
export function autoJurisdiction(provider: 'aws' | 'azure' | 'digitalocean', dataRegion: string): R2Jurisdiction {
  return catalogueRegion(provider, dataRegion)?.geo === 'eu' ? 'eu' : 'default';
}
