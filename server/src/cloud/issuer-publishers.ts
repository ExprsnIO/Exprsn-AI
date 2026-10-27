import { createHash } from 'node:crypto';
import { z } from 'zod';
import { signV4 } from '../platform/blob.js';
import { CloudCallError, type CloudHttp } from './credential-http.js';
import { AZURE_SCOPES } from './azure-calls.js';

/*
 * 1.9.99-final, Sprint 56 (B-10005, open decision 2): where the federation issuer's two public documents go.
 *
 * AWS IAM and Entra fetch `<issuer>/.well-known/openid-configuration` and the JWKS it names from the internet, so
 * they are published to a static public location, apart from the console (which stays private):
 *
 *   s3          an S3 bucket (SigV4, keys from an AWS cloud account or a vaulted key pair)
 *   azure-blob  an Azure Storage static website (`$web`), with an Entra token for the storage scope from an Azure
 *               cloud account
 *   spaces      a DigitalOcean Spaces bucket (S3 API, a vaulted Spaces key pair; a DigitalOcean API token cannot sign)
 *   r2          a Cloudflare R2 bucket (S3 API, a vaulted R2 key pair; served through r2.dev or a custom domain)
 *   console     the alternative: the console serves the two documents itself on `/cloud-issuer/...`, the only paths
 *               that then need to be reachable from the internet
 *   none        not published (federation does not work until a target is chosen)
 *
 * Only the discovery document and the JWKS are ever written: public keys, never anything private. A publisher only
 * writes; the check job reads the published copy back over the issuer's public URL.
 */

const prefix = z.string().trim().max(200).regex(/^(?:[A-Za-z0-9._-]+\/)*$/, 'A prefix is path segments, each ending with /').default('');
const endpoint = z.url().optional();
const ref = z.string().regex(/^vault:cloud\/[^#]+#[A-Za-z0-9_.-]{1,128}$/);

export const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('console') }).strict(),
  z.object({ kind: z.literal('s3'), bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/), region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/), prefix, endpoint, accountId: z.string().length(26).optional(), accessKeyRef: ref.optional(), secretKeyRef: ref.optional() }).strict(),
  z.object({ kind: z.literal('azure-blob'), storageAccount: z.string().regex(/^[a-z0-9]{3,24}$/), container: z.string().regex(/^(\$web|[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?)$/).default('$web'), prefix, endpoint, accountId: z.string().length(26) }).strict(),
  z.object({ kind: z.literal('spaces'), bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/), region: z.string().regex(/^[a-z]{3}\d$/), prefix, endpoint, accessKeyRef: ref, secretKeyRef: ref }).strict(),
  z.object({ kind: z.literal('r2'), bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/), cloudflareAccountId: z.string().regex(/^[a-f0-9]{32}$/), prefix, endpoint, accessKeyRef: ref, secretKeyRef: ref }).strict()
]);

export type IssuerTarget = z.infer<typeof targetSchema>;
export type TargetKind = IssuerTarget['kind'];
export const TARGET_KINDS: readonly TargetKind[] = ['none', 'console', 's3', 'azure-blob', 'spaces', 'r2'];

/** What a publisher needs from the credentials: an AWS key pair or an Azure token, and vaulted values. */
export interface PublisherDeps {
  http: CloudHttp;
  readRef(ref: string): Promise<string>;
  awsKeys(accountId: string): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>;
  azureToken(accountId: string, scope: string): Promise<string>;
}

export interface IssuerPublisher {
  readonly kind: TargetKind;
  /** Writes one public document under the target's prefix. */
  put(name: string, body: string, contentType: string): Promise<void>;
  /** Where the document lands, for the status view (no credentials in it). */
  location(name: string): string;
}

const sha256 = (b: string) => createHash('sha256').update(b).digest('hex');

/** S3 and the S3-compatible stores (Spaces, R2): a SigV4-signed PUT. */
class S3StylePublisher implements IssuerPublisher {
  constructor(
    readonly kind: 's3' | 'spaces' | 'r2',
    private readonly o: { base: string; virtualHost: boolean; bucket: string; prefix: string; region: string; acl: boolean; keys: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }> },
    private readonly http: CloudHttp
  ) {}

  location(name: string): string {
    const base = new URL(this.o.base);
    const key = `${this.o.prefix}${name}`;
    return this.o.virtualHost ? `${base.protocol}//${this.o.bucket}.${base.host}/${key}` : `${base.origin}/${this.o.bucket}/${key}`;
  }

  async put(name: string, body: string, contentType: string): Promise<void> {
    const url = new URL(this.location(name));
    const keys = await this.o.keys();
    const headers: Record<string, string> = { 'content-type': contentType, 'cache-control': 'public, max-age=300', ...(this.o.acl ? { 'x-amz-acl': 'public-read' } : {}), ...(keys.sessionToken ? { 'x-amz-security-token': keys.sessionToken } : {}) };
    const signed = signV4({ method: 'PUT', url, headers, payloadHash: sha256(body), region: this.o.region, service: 's3', accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey, date: new Date() });
    const res = await this.http.request({ method: 'PUT', url, headers: signed, body });
    if (res.status !== 200 && res.status !== 201 && res.status !== 204) throw new CloudCallError(`The ${this.kind} bucket refused the write of ${name} (HTTP ${res.status}).`, 502, String(res.status));
  }
}

class AzureBlobPublisher implements IssuerPublisher {
  readonly kind = 'azure-blob' as const;
  constructor(
    private readonly o: { base: string; container: string; prefix: string; token: () => Promise<string> },
    private readonly http: CloudHttp
  ) {}

  location(name: string): string {
    return `${this.o.base.replace(/\/+$/, '')}/${encodeURIComponent(this.o.container)}/${this.o.prefix}${name}`;
  }

  async put(name: string, body: string, contentType: string): Promise<void> {
    const token = await this.o.token();
    const res = await this.http.request({ method: 'PUT', url: this.location(name), headers: { authorization: `Bearer ${token}`, 'x-ms-version': '2021-08-06', 'x-ms-blob-type': 'BlockBlob', 'x-ms-blob-content-type': contentType, 'x-ms-blob-cache-control': 'public, max-age=300', 'content-type': contentType }, body });
    if (res.status !== 201 && res.status !== 200) throw new CloudCallError(`The Azure static website refused the write of ${name} (HTTP ${res.status}).`, 502, String(res.status));
  }
}

/** The console serves the live documents itself: nothing to write. */
class ConsolePublisher implements IssuerPublisher {
  readonly kind = 'console' as const;
  constructor(private readonly issuer: string) {}
  location(name: string): string {
    return `${this.issuer}/${name}`;
  }
  async put(): Promise<void> {
    /* served live by routes/cloud-issuer-public.ts */
  }
}

const keyPair = (deps: PublisherDeps, accessRef: string, secretRef: string) => async () => ({ accessKeyId: await deps.readRef(accessRef), secretAccessKey: await deps.readRef(secretRef) });

/** The publisher for a target, or null for `none`. */
export function publisherFor(t: IssuerTarget, issuer: string, deps: PublisherDeps): IssuerPublisher | null {
  switch (t.kind) {
    case 'none':
      return null;
    case 'console':
      return new ConsolePublisher(issuer);
    case 's3': {
      const keys = t.accessKeyRef && t.secretKeyRef ? keyPair(deps, t.accessKeyRef, t.secretKeyRef) : t.accountId ? () => deps.awsKeys(t.accountId!) : null;
      if (!keys) throw new CloudCallError('An S3 target needs an AWS cloud account or a vaulted key pair to write with.', 422, 'no-credential');
      return new S3StylePublisher('s3', { base: t.endpoint ?? `https://s3.${t.region}.amazonaws.com`, virtualHost: !t.endpoint, bucket: t.bucket, prefix: t.prefix, region: t.region, acl: false, keys }, deps.http);
    }
    case 'spaces':
      return new S3StylePublisher('spaces', { base: t.endpoint ?? `https://${t.region}.digitaloceanspaces.com`, virtualHost: !t.endpoint, bucket: t.bucket, prefix: t.prefix, region: t.region, acl: true, keys: keyPair(deps, t.accessKeyRef, t.secretKeyRef) }, deps.http);
    case 'r2':
      return new S3StylePublisher('r2', { base: t.endpoint ?? `https://${t.cloudflareAccountId}.r2.cloudflarestorage.com`, virtualHost: false, bucket: t.bucket, prefix: t.prefix, region: 'auto', acl: false, keys: keyPair(deps, t.accessKeyRef, t.secretKeyRef) }, deps.http);
    case 'azure-blob':
      return new AzureBlobPublisher({ base: t.endpoint ?? `https://${t.storageAccount}.blob.core.windows.net`, container: t.container, prefix: t.prefix, token: () => deps.azureToken(t.accountId, AZURE_SCOPES.storage) }, deps.http);
  }
}
