import { createHash, createPublicKey, verify as verifySig, type KeyObject } from 'node:crypto';
import type { Config } from '../config/index.js';
import type { CloudTransport } from '../cloud/providers/transport.js';
import { signV4 } from './blob.js';
import { awsInstallCredential, azureInstallCredential, installTransport, KEY_VAULT_SCOPE, type AwsCredential, type AzureCredential } from './cloud-identity.js';
import type { Kms } from './kms.js';

/*
 * 1.9.99-final, Sprint 58 (B-10208): the cloud key management services as `Kms` adapters, for deployed installs.
 *
 *   aws-kms         one symmetric KMS key per key name (a tenant's key-encryption key is `alias/<prefix>tenant-<id>`),
 *                   created on first use with automatic yearly rotation; data keys are wrapped with Encrypt and the
 *                   associated data as the encryption context, so a wrapped key opens only for its own context.
 *   azure-keyvault  one RSA-3072 key per key name in the vault (RSA-HSM with KMS_AZURE_HSM); data keys are wrapped
 *                   with wrapKey (RSA-OAEP-256), the SHA-256 of the associated data bound inside the wrapped bytes.
 *
 * Signing (the `hmac` and `verifyHmac` of audit checkpoints, backup manifests, provenance and model cards): neither
 * cloud offers HMAC keys in both, so these adapters sign with an asymmetric key per name instead, ECC_NIST_P256
 * (ES256) in AWS KMS and EC P-256 in Key Vault, inside the KMS; the private key never leaves it. The "mac" is
 * `aws-kms:v1:<key id>:<DER signature>` or `azure-kv:v1:<key version>:<r||s>`, over the SHA-256 of the key name and
 * the data (so a signature made for one name never verifies for another). It names the key (version) that made it,
 * so a signature stays verifiable after the signing key is rotated (`rotateSigningKey`): the old key stays known to
 * the KMS and its public key is fetched once and cached. Verification is local, with that public key.
 *
 * Every call goes through `CloudTransport` (the egress guard, the rate limiter, the breaker, retries). Nothing here
 * uses an SDK's default credential chain or the instance metadata service: the credential is the install's own
 * (`cloud-identity.ts`). The asymmetric signing keys are not offered as `createSigningKey`/`sign`: OIDC, PKI and
 * webhook keys keep their own custody (the signer or sealed keys), since neither cloud holds every key type they use.
 */

export type CloudKmsKind = 'aws-kms' | 'azure-keyvault';

export class CloudKmsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null
  ) {
    super(message);
  }
}

const sha256hex = (d: string | Buffer) => createHash('sha256').update(d).digest('hex');
const macPayload = (name: string, data: string): Buffer => Buffer.from(`exprsn-kms-mac:v1\n${name}\n${data}`, 'utf8');
const digestOf = (name: string, data: string): Buffer => createHash('sha256').update(macPayload(name, data)).digest();
const b64u = (b: Buffer) => b.toString('base64url');

// ---------------------------------------------------------------- AWS KMS

interface AwsKeyMetadata {
  KeyId: string;
  Arn: string;
  KeyState?: string;
  KeyUsage?: string;
  KeySpec?: string;
}

export interface AwsKmsOptions {
  region: string;
  /** Default https://kms.<region>.amazonaws.com. */
  endpoint?: string;
  credential: () => Promise<AwsCredential>;
  transport: CloudTransport;
  /** ScheduleKeyDeletion's waiting period when a key is destroyed (7 to 30 days). */
  deletionDays?: number;
}

/** AWS KMS over its JSON API (`TrentService`), SigV4-signed, through the cloud transport. */
export class AwsKms implements Kms {
  readonly kind = 'aws-kms' as const;
  private readonly endpoint: URL;
  /** Alias → key ARN (wrap and signing keys). */
  private readonly keys = new Map<string, string>();
  private readonly creating = new Map<string, Promise<string>>();
  /** Key id → public key (signing keys, current and earlier ones). */
  private readonly publicKeys = new Map<string, KeyObject>();

  constructor(private readonly o: AwsKmsOptions) {
    this.endpoint = new URL(o.endpoint ?? `https://kms.${o.region}.amazonaws.com/`);
  }

  /** The alias of a name's key: the wrap key, or (`sign`) its ES256 signing key. */
  alias(name: string, sign = false): string {
    return `alias/${name.replace(/[^A-Za-z0-9/_-]/g, '-')}${sign ? '-mac' : ''}`.slice(0, 256);
  }

  async call<T>(action: string, body: Record<string, unknown>, apiClass: 'read' | 'mutate' = 'read'): Promise<T> {
    const cred = await this.o.credential();
    const payload = JSON.stringify(body);
    const headers: Record<string, string> = { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `TrentService.${action}`, ...(cred.sessionToken ? { 'x-amz-security-token': cred.sessionToken } : {}) };
    const signed = signV4({ method: 'POST', url: this.endpoint, headers, payloadHash: sha256hex(payload), region: this.o.region, service: 'kms', accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey, date: new Date() });
    const res = await this.o.transport.send({ method: 'POST', url: this.endpoint, headers: signed, body: payload, accountId: 'install-kms', apiClass });
    const text = res.body.toString('utf8');
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* not JSON */
    }
    if (res.status !== 200) {
      const type = String(parsed.__type ?? res.headers['x-amzn-errortype'] ?? '').split('#').pop()!.split(':')[0]! || null;
      const msg = String(parsed.message ?? parsed.Message ?? '').slice(0, 300);
      throw new CloudKmsError(`AWS KMS ${action} refused${type ? ` (${type})` : ''}${msg ? `: ${msg}` : ''} [${res.status}]`, res.status, type);
    }
    return parsed as T;
  }

  private async describe(alias: string): Promise<AwsKeyMetadata | null> {
    try {
      const r = await this.call<{ KeyMetadata: AwsKeyMetadata }>('DescribeKey', { KeyId: alias });
      return r.KeyMetadata;
    } catch (err) {
      if (err instanceof CloudKmsError && err.code === 'NotFoundException') return null;
      throw err;
    }
  }

  private async createKey(alias: string, name: string, sign: boolean): Promise<AwsKeyMetadata> {
    const spec = sign ? { KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY' } : { KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT' };
    const r = await this.call<{ KeyMetadata: AwsKeyMetadata }>('CreateKey', { ...spec, Description: `Exprsn-AI ${sign ? 'signing' : 'key-encryption'} key ${name}`.slice(0, 8192), Tags: [{ TagKey: 'exprsn:key-name', TagValue: name.slice(0, 256) }, { TagKey: 'exprsn:purpose', TagValue: sign ? 'sign' : 'wrap' }] }, 'mutate');
    if (!sign) await this.call('EnableKeyRotation', { KeyId: r.KeyMetadata.KeyId }, 'mutate');
    return r.KeyMetadata;
  }

  /** The ARN behind an alias, creating the key and the alias on first use (another instance may race: theirs wins). */
  private async keyArn(name: string, sign: boolean): Promise<string> {
    const alias = this.alias(name, sign);
    const hit = this.keys.get(alias);
    if (hit) return hit;
    const running = this.creating.get(alias);
    if (running) return running;
    const p = (async () => {
      const found = await this.describe(alias);
      if (found) {
        if (found.KeyState && found.KeyState !== 'Enabled') throw new CloudKmsError(`AWS KMS key ${alias} is ${found.KeyState}`, 409, 'KMSInvalidStateException');
        this.keys.set(alias, found.Arn);
        return found.Arn;
      }
      const made = await this.createKey(alias, name, sign);
      try {
        await this.call('CreateAlias', { AliasName: alias, TargetKeyId: made.KeyId }, 'mutate');
      } catch (err) {
        if (!(err instanceof CloudKmsError && err.code === 'AlreadyExistsException')) throw err;
        // Another instance named its key first: retire ours and use theirs.
        await this.call('ScheduleKeyDeletion', { KeyId: made.KeyId, PendingWindowInDays: 7 }, 'mutate').catch(() => undefined);
        const theirs = await this.describe(alias);
        if (!theirs) throw err;
        this.keys.set(alias, theirs.Arn);
        return theirs.Arn;
      }
      this.keys.set(alias, made.Arn);
      return made.Arn;
    })().finally(() => this.creating.delete(alias));
    this.creating.set(alias, p);
    return p;
  }

  async ensureKey(name: string): Promise<void> {
    await this.keyArn(name, false);
  }

  async wrap(name: string, plaintext: Buffer, aad: string): Promise<string> {
    await this.keyArn(name, false);
    const r = await this.call<{ CiphertextBlob: string }>('Encrypt', { KeyId: this.alias(name), Plaintext: plaintext.toString('base64'), EncryptionContext: { exprsn: aad } });
    return `aws-kms:v1:${r.CiphertextBlob}`;
  }

  async unwrap(name: string, wrapped: string, aad: string): Promise<Buffer> {
    if (!wrapped.startsWith('aws-kms:v1:')) throw new Error('Not a value wrapped by AWS KMS');
    // KeyId binds the ciphertext to this name's key, and the context to this associated data.
    const r = await this.call<{ Plaintext: string }>('Decrypt', { KeyId: this.alias(name), CiphertextBlob: wrapped.slice('aws-kms:v1:'.length), EncryptionContext: { exprsn: aad } });
    return Buffer.from(r.Plaintext, 'base64');
  }

  async hmac(name: string, data: string): Promise<string> {
    const arn = await this.keyArn(name, true);
    const keyId = arn.split('/').pop()!;
    const r = await this.call<{ Signature: string }>('Sign', { KeyId: arn, Message: digestOf(name, data).toString('base64'), MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' });
    return `aws-kms:v1:${keyId}:${b64u(Buffer.from(r.Signature, 'base64'))}`;
  }

  private async publicKey(keyId: string): Promise<KeyObject> {
    const hit = this.publicKeys.get(keyId);
    if (hit) return hit;
    const r = await this.call<{ PublicKey: string; KeyUsage?: string; KeySpec?: string }>('GetPublicKey', { KeyId: keyId });
    if (r.KeyUsage !== 'SIGN_VERIFY' || r.KeySpec !== 'ECC_NIST_P256') throw new CloudKmsError(`AWS KMS key ${keyId} is not an ES256 signing key`, 409, 'wrong_key');
    const key = createPublicKey({ key: Buffer.from(r.PublicKey, 'base64'), format: 'der', type: 'spki' });
    this.publicKeys.set(keyId, key);
    return key;
  }

  async verifyHmac(name: string, data: string, mac: string): Promise<boolean> {
    const m = /^aws-kms:v1:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32}):([A-Za-z0-9_-]{16,200})$/.exec(mac);
    if (!m) return false;
    const key = await this.publicKey(m[1]!);
    return verifySig('sha256', macPayload(name, data), { key, dsaEncoding: 'der' }, Buffer.from(m[2]!, 'base64url'));
  }

  /** A new signing key for a name (the alias moves to it); signatures made with the old one keep verifying. */
  async rotateSigningKey(name: string): Promise<string> {
    const alias = this.alias(name, true);
    await this.keyArn(name, true);
    const made = await this.createKey(alias, name, true);
    await this.call('UpdateAlias', { AliasName: alias, TargetKeyId: made.KeyId }, 'mutate');
    this.keys.set(alias, made.Arn);
    return made.KeyId;
  }

  /** Schedules the name's keys for deletion (KMS_AWS_DELETION_DAYS) and removes their aliases: the wrapped keys no longer open. */
  async destroyKey(name: string): Promise<void> {
    for (const sign of [false, true]) {
      const alias = this.alias(name, sign);
      this.keys.delete(alias);
      const found = await this.describe(alias);
      if (!found) continue;
      if (found.KeyState !== 'PendingDeletion') await this.call('ScheduleKeyDeletion', { KeyId: found.KeyId, PendingWindowInDays: this.o.deletionDays ?? 7 }, 'mutate');
      await this.call('DeleteAlias', { AliasName: alias }, 'mutate').catch((err) => {
        if (!(err instanceof CloudKmsError && err.code === 'NotFoundException')) throw err;
      });
    }
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.call('ListKeys', { Limit: 1 });
      return { ok: true, detail: `AWS KMS ${this.o.region}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message.slice(0, 300) };
    }
  }
}

// ---------------------------------------------------------------- Azure Key Vault

interface KvKey {
  key: { kid: string; kty: string; n?: string; e?: string; crv?: string; x?: string; y?: string };
  attributes?: { enabled?: boolean };
}

export interface AzureKeyVaultOptions {
  vaultUrl: string;
  credential: AzureCredential;
  transport: CloudTransport;
  /** RSA-HSM and EC-HSM keys (a Premium vault or Managed HSM). */
  hsm?: boolean;
}

const KV_API = '7.4';

/** Azure Key Vault keys over the data-plane REST API (7.4), with an Entra token for the vault scope. */
export class AzureKeyVaultKms implements Kms {
  readonly kind = 'azure-keyvault' as const;
  private readonly base: string;
  /** Key name → the current version (wrap and signing keys). */
  private readonly versions = new Map<string, string>();
  private readonly creating = new Map<string, Promise<string>>();
  /** `<key name>/<version>` → public key of a signing key. */
  private readonly publicKeys = new Map<string, KeyObject>();

  constructor(private readonly o: AzureKeyVaultOptions) {
    this.base = o.vaultUrl.replace(/\/+$/, '');
  }

  /** The Key Vault name of a key name's key: the wrap key, or (`sign`) its ES256 signing key. */
  keyName(name: string, sign = false): string {
    const n = name.replace(/[^0-9A-Za-z-]/g, '-').slice(0, sign ? 123 : 127);
    return sign ? `${n}-mac` : n;
  }

  async call<T>(method: string, path: string, body?: unknown, apiClass?: 'read' | 'mutate'): Promise<{ status: number; body: T }> {
    const token = await this.o.credential.getToken(KEY_VAULT_SCOPE);
    const url = new URL(`${this.base}/${path}`);
    url.searchParams.set('api-version', KV_API);
    const res = await this.o.transport.send({ method, url, headers: { authorization: `Bearer ${token.token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), accountId: 'install-kms', ...(apiClass ? { apiClass } : {}) });
    const text = res.body.toString('utf8');
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (res.status < 200 || res.status >= 300) {
      const e = (parsed as { error?: { code?: string; message?: string; innererror?: { code?: string } } } | null)?.error;
      const code = e?.innererror?.code ?? e?.code ?? null;
      throw new CloudKmsError(`Key Vault ${method} ${path.split('/').slice(0, 2).join('/')} refused${code ? ` (${code})` : ''}${e?.message ? `: ${e.message.slice(0, 300)}` : ''} [${res.status}]`, res.status, code);
    }
    return { status: res.status, body: parsed as T };
  }

  private versionOf(kid: string): string {
    const v = kid.split('/').pop() ?? '';
    if (!/^[0-9a-zA-Z]{1,64}$/.test(v)) throw new CloudKmsError('Key Vault answered with an unreadable key id', 502, 'malformed');
    return v;
  }

  private async create(kvName: string, sign: boolean, name: string): Promise<string> {
    const hsm = this.o.hsm ? '-HSM' : '';
    const spec = sign ? { kty: `EC${hsm}`, crv: 'P-256', key_ops: ['sign', 'verify'] } : { kty: `RSA${hsm}`, key_size: 3072, key_ops: ['wrapKey', 'unwrapKey'] };
    const r = await this.call<KvKey>('POST', `keys/${kvName}/create`, { ...spec, attributes: { enabled: true }, tags: { 'exprsn-key-name': name.slice(0, 256), 'exprsn-purpose': sign ? 'sign' : 'wrap' } }, 'mutate');
    return this.versionOf(r.body.key.kid);
  }

  /** The current version of a key, creating it on first use. */
  private async current(name: string, sign: boolean): Promise<string> {
    const kvName = this.keyName(name, sign);
    const hit = this.versions.get(kvName);
    if (hit) return hit;
    const running = this.creating.get(kvName);
    if (running) return running;
    const p = (async () => {
      let version: string;
      try {
        const r = await this.call<KvKey>('GET', `keys/${kvName}`);
        if (r.body.attributes?.enabled === false) throw new CloudKmsError(`Key Vault key ${kvName} is disabled`, 409, 'KeyDisabled');
        version = this.versionOf(r.body.key.kid);
      } catch (err) {
        if (!(err instanceof CloudKmsError && err.status === 404)) throw err;
        version = await this.create(kvName, sign, name);
      }
      this.versions.set(kvName, version);
      return version;
    })().finally(() => this.creating.delete(kvName));
    this.creating.set(kvName, p);
    return p;
  }

  async ensureKey(name: string): Promise<void> {
    await this.current(name, false);
  }

  async wrap(name: string, plaintext: Buffer, aad: string): Promise<string> {
    const v = await this.current(name, false);
    // RSA-OAEP has no associated data: its digest goes in front of the key, and unwrap checks it.
    const value = Buffer.concat([createHash('sha256').update(aad).digest(), plaintext]);
    const r = await this.call<{ value: string }>('POST', `keys/${this.keyName(name)}/${v}/wrapkey`, { alg: 'RSA-OAEP-256', value: b64u(value) }, 'read');
    return `azure-kv:v1:${v}:${r.body.value}`;
  }

  async unwrap(name: string, wrapped: string, aad: string): Promise<Buffer> {
    const m = /^azure-kv:v1:([0-9a-zA-Z]{1,64}):([A-Za-z0-9_-]+)$/.exec(wrapped);
    if (!m) throw new Error('Not a value wrapped by Key Vault');
    const r = await this.call<{ value: string }>('POST', `keys/${this.keyName(name)}/${m[1]}/unwrapkey`, { alg: 'RSA-OAEP-256', value: m[2] }, 'read');
    const out = Buffer.from(r.body.value, 'base64url');
    if (out.length < 32 || !out.subarray(0, 32).equals(createHash('sha256').update(aad).digest())) throw new Error('Wrapped key does not belong to this context');
    return out.subarray(32);
  }

  async hmac(name: string, data: string): Promise<string> {
    const v = await this.current(name, true);
    const r = await this.call<{ value: string }>('POST', `keys/${this.keyName(name, true)}/${v}/sign`, { alg: 'ES256', value: b64u(digestOf(name, data)) }, 'read');
    return `azure-kv:v1:${v}:${r.body.value}`;
  }

  private async publicKey(kvName: string, version: string): Promise<KeyObject> {
    const id = `${kvName}/${version}`;
    const hit = this.publicKeys.get(id);
    if (hit) return hit;
    const r = await this.call<KvKey>('GET', `keys/${kvName}/${version}`);
    const k = r.body.key;
    if (!/^EC/.test(k.kty) || k.crv !== 'P-256' || !k.x || !k.y) throw new CloudKmsError(`Key Vault key ${kvName} is not an ES256 signing key`, 409, 'wrong_key');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: k.x, y: k.y }, format: 'jwk' });
    this.publicKeys.set(id, key);
    return key;
  }

  async verifyHmac(name: string, data: string, mac: string): Promise<boolean> {
    const m = /^azure-kv:v1:([0-9a-zA-Z]{1,64}):([A-Za-z0-9_-]{80,90})$/.exec(mac);
    if (!m) return false;
    const key = await this.publicKey(this.keyName(name, true), m[1]!);
    return verifySig('sha256', macPayload(name, data), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[2]!, 'base64url'));
  }

  /** A new version of a name's signing key; signatures made with earlier versions keep verifying. */
  async rotateSigningKey(name: string): Promise<string> {
    const kvName = this.keyName(name, true);
    const v = await this.create(kvName, true, name);
    this.versions.set(kvName, v);
    return v;
  }

  /** Deletes the name's keys (and purges them where the vault allows it): the wrapped keys no longer open. */
  async destroyKey(name: string): Promise<void> {
    for (const sign of [false, true]) {
      const kvName = this.keyName(name, sign);
      this.versions.delete(kvName);
      try {
        await this.call('DELETE', `keys/${kvName}`, undefined, 'mutate');
      } catch (err) {
        if (err instanceof CloudKmsError && err.status === 404) continue;
        throw err;
      }
      // Soft delete keeps a deleted key recoverable for the vault's retention; purge needs the purge permission.
      await this.call('DELETE', `deletedkeys/${kvName}`, undefined, 'mutate').catch(() => undefined);
    }
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.call('GET', 'keys?maxresults=1');
      return { ok: true, detail: `Key Vault ${new URL(this.base).host}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message.slice(0, 300) };
    }
  }
}

/** The configured cloud KMS (`KMS_PROVIDER` or, for `kms:rewrap`, `KMS_PREVIOUS_PROVIDER`), with the install's identity. */
export function createCloudKms(cfg: Config, kind: CloudKmsKind): Kms {
  if (kind === 'aws-kms') {
    return new AwsKms({ region: cfg.KMS_AWS_REGION as string, ...(cfg.KMS_AWS_ENDPOINT ? { endpoint: cfg.KMS_AWS_ENDPOINT } : {}), credential: awsInstallCredential(cfg), transport: installTransport(cfg, 'aws'), deletionDays: cfg.KMS_AWS_DELETION_DAYS });
  }
  return new AzureKeyVaultKms({ vaultUrl: cfg.KMS_AZURE_VAULT_URL as string, credential: azureInstallCredential(cfg), transport: installTransport(cfg, 'azure'), hsm: cfg.KMS_AZURE_HSM });
}
