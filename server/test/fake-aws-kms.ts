/*
 * 1.9.99-final, Sprint 58 (B-10208): AWS KMS for `FakeAws` (`fake.kms`), over the JSON 1.1 protocol
 * (`X-Amz-Target: TrentService.<Action>`). Working: CreateKey (SYMMETRIC_DEFAULT ENCRYPT_DECRYPT, ECC_NIST_P256
 * SIGN_VERIFY), DescribeKey, ListKeys, CreateAlias, UpdateAlias, DeleteAlias, EnableKeyRotation, Encrypt, Decrypt
 * and GenerateDataKey (AES-256-GCM with the encryption context as associated data; a ciphertext names its key, and
 * Decrypt with a KeyId refuses another key's ciphertext), Sign (ECDSA_SHA_256 over a DIGEST or a RAW message) and
 * GetPublicKey, ScheduleKeyDeletion (the key refuses every use while pending deletion). It is never the real AWS KMS.
 */
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import type { Reply } from './fake-cloud-base.js';
import { rawToDer, signDigestP256 } from './fake-ecdsa.js';

export interface FakeKmsKey {
  KeyId: string;
  Arn: string;
  KeySpec: string;
  KeyUsage: string;
  KeyState: 'Enabled' | 'PendingDeletion' | 'Disabled';
  rotation: boolean;
  tags: Record<string, string>;
  deletionDays?: number;
  material?: Buffer;
  privateKey?: KeyObject;
  publicKey?: KeyObject;
}

const err = (status: number, type: string, message: string): Reply => ({ status, headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amzn-errortype': `${type}:` }, body: { __type: type, message } });
const ok = (body: unknown): Reply => ({ status: 200, headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amzn-requestid': randomUUID() }, body });
const ctxAad = (c: unknown) => Buffer.from(JSON.stringify(Object.entries((c as Record<string, string>) ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))));

export class FakeKms {
  readonly keys = new Map<string, FakeKmsKey>();
  /** alias/... → KeyId */
  readonly aliases = new Map<string, string>();
  /** Every operation, with its key id and encryption context (never the plaintext). */
  readonly log: { action: string; keyId?: string; context?: Record<string, string> }[] = [];

  constructor(private readonly account: () => string) {}

  private resolve(id: unknown, region: string): FakeKmsKey | null {
    const s = String(id ?? '');
    if (s.startsWith('alias/')) return this.keys.get(this.aliases.get(s) ?? '') ?? null;
    const arnAlias = /^arn:aws:kms:[^:]+:\d+:(alias\/.+)$/.exec(s)?.[1];
    if (arnAlias) return this.keys.get(this.aliases.get(arnAlias) ?? '') ?? null;
    const keyId = /^arn:aws:kms:[^:]+:\d+:key\/(.+)$/.exec(s)?.[1] ?? s;
    const k = this.keys.get(keyId);
    return k && k.Arn.includes(`:${region}:`) ? k : null;
  }

  private meta(k: FakeKmsKey) {
    return { KeyId: k.KeyId, Arn: k.Arn, KeySpec: k.KeySpec, KeyUsage: k.KeyUsage, KeyState: k.KeyState, Enabled: k.KeyState === 'Enabled', KeyManager: 'CUSTOMER', ...(k.KeyUsage === 'SIGN_VERIFY' ? { SigningAlgorithms: ['ECDSA_SHA_256'] } : { EncryptionAlgorithms: ['SYMMETRIC_DEFAULT'] }) };
  }

  /** One KMS call (the caller already passed the fake's signature check). */
  handle(action: string, body: Record<string, unknown>, region: string): Reply {
    const usable = (k: FakeKmsKey | null, usage: string): FakeKmsKey | Reply => {
      if (!k) return err(400, 'NotFoundException', `Key '${String(body.KeyId)}' does not exist`);
      if (k.KeyState !== 'Enabled') return err(400, 'KMSInvalidStateException', `${k.Arn} is pending deletion.`);
      if (k.KeyUsage !== usage) return err(400, 'InvalidKeyUsageException', `${k.Arn} key usage is ${k.KeyUsage} which is not valid for ${action}.`);
      return k;
    };
    switch (action) {
      case 'CreateKey': {
        const spec = String(body.KeySpec ?? 'SYMMETRIC_DEFAULT');
        const usage = String(body.KeyUsage ?? 'ENCRYPT_DECRYPT');
        if (!['SYMMETRIC_DEFAULT', 'ECC_NIST_P256'].includes(spec)) return err(400, 'ValidationException', `This fake makes SYMMETRIC_DEFAULT and ECC_NIST_P256 keys, not ${spec}`);
        if ((spec === 'SYMMETRIC_DEFAULT') !== (usage === 'ENCRYPT_DECRYPT')) return err(400, 'ValidationException', `KeyUsage ${usage} is not valid for ${spec}`);
        const id = randomUUID();
        const k: FakeKmsKey = { KeyId: id, Arn: `arn:aws:kms:${region}:${this.account()}:key/${id}`, KeySpec: spec, KeyUsage: usage, KeyState: 'Enabled', rotation: false, tags: Object.fromEntries(((body.Tags as { TagKey: string; TagValue: string }[]) ?? []).map((t) => [t.TagKey, t.TagValue])) };
        if (spec === 'SYMMETRIC_DEFAULT') k.material = randomBytes(32);
        else Object.assign(k, generateKeyPairSync('ec', { namedCurve: 'P-256' }));
        this.keys.set(id, k);
        this.log.push({ action, keyId: id });
        return ok({ KeyMetadata: this.meta(k) });
      }
      case 'DescribeKey': {
        const k = this.resolve(body.KeyId, region);
        this.log.push({ action, ...(k ? { keyId: k.KeyId } : {}) });
        return k ? ok({ KeyMetadata: this.meta(k) }) : err(400, 'NotFoundException', `Alias ${String(body.KeyId)} is not found.`);
      }
      case 'ListKeys':
        return ok({ Keys: [...this.keys.values()].slice(0, Number(body.Limit ?? 100)).map((k) => ({ KeyId: k.KeyId, KeyArn: k.Arn })), Truncated: false });
      case 'CreateAlias':
      case 'UpdateAlias': {
        const name = String(body.AliasName ?? '');
        if (!/^alias\/[A-Za-z0-9/_-]{1,250}$/.test(name) || name.startsWith('alias/aws/')) return err(400, 'ValidationException', `Alias name ${name} is not valid`);
        const k = this.resolve(body.TargetKeyId, region);
        if (!k) return err(400, 'NotFoundException', 'The target key does not exist');
        if (action === 'CreateAlias' && this.aliases.has(name)) return err(400, 'AlreadyExistsException', `An alias with the name ${name} already exists`);
        if (action === 'UpdateAlias' && !this.aliases.has(name)) return err(400, 'NotFoundException', `Alias ${name} is not found.`);
        this.aliases.set(name, k.KeyId);
        this.log.push({ action, keyId: k.KeyId });
        return ok({});
      }
      case 'DeleteAlias': {
        const name = String(body.AliasName ?? '');
        if (!this.aliases.delete(name)) return err(400, 'NotFoundException', `Alias ${name} is not found.`);
        this.log.push({ action });
        return ok({});
      }
      case 'EnableKeyRotation': {
        const k = usable(this.resolve(body.KeyId, region), 'ENCRYPT_DECRYPT');
        if ('status' in k) return k;
        k.rotation = true;
        return ok({});
      }
      case 'ScheduleKeyDeletion': {
        const k = this.resolve(body.KeyId, region);
        if (!k) return err(400, 'NotFoundException', 'Key does not exist');
        const days = Number(body.PendingWindowInDays ?? 30);
        if (days < 7 || days > 30) return err(400, 'ValidationException', 'PendingWindowInDays must be between 7 and 30');
        k.KeyState = 'PendingDeletion';
        k.deletionDays = days;
        this.log.push({ action, keyId: k.KeyId });
        return ok({ KeyId: k.Arn, KeyState: 'PendingDeletion', PendingWindowInDays: days, DeletionDate: (Date.now() + days * 864e5) / 1000 });
      }
      case 'Encrypt':
      case 'GenerateDataKey': {
        const k = usable(this.resolve(body.KeyId, region), 'ENCRYPT_DECRYPT');
        if ('status' in k) return k;
        const plain = action === 'Encrypt' ? Buffer.from(String(body.Plaintext ?? ''), 'base64') : randomBytes(Number(body.NumberOfBytes ?? 32));
        if (action === 'Encrypt' && (plain.length < 1 || plain.length > 4096)) return err(400, 'ValidationException', 'Plaintext must be 1 to 4096 bytes');
        const iv = randomBytes(12);
        const c = createCipheriv('aes-256-gcm', k.material!, iv);
        c.setAAD(ctxAad(body.EncryptionContext));
        const ct = Buffer.concat([c.update(plain), c.final()]);
        const blob = Buffer.concat([Buffer.from(k.KeyId, 'ascii'), iv, c.getAuthTag(), ct]).toString('base64');
        this.log.push({ action, keyId: k.KeyId, context: (body.EncryptionContext as Record<string, string>) ?? {} });
        return ok({ CiphertextBlob: blob, KeyId: k.Arn, EncryptionAlgorithm: 'SYMMETRIC_DEFAULT', ...(action === 'GenerateDataKey' ? { Plaintext: plain.toString('base64') } : {}) });
      }
      case 'Decrypt': {
        const blob = Buffer.from(String(body.CiphertextBlob ?? ''), 'base64');
        const own = this.keys.get(blob.subarray(0, 36).toString('ascii'));
        if (!own || blob.length < 36 + 28) return err(400, 'InvalidCiphertextException', '');
        if (body.KeyId !== undefined) {
          const named = this.resolve(body.KeyId, region);
          if (!named) return err(400, 'NotFoundException', `Key '${String(body.KeyId)}' does not exist`);
          if (named.KeyId !== own.KeyId) return err(400, 'IncorrectKeyException', 'The key ID in the request does not identify a KMS key that can perform this operation.');
        }
        const k = usable(own, 'ENCRYPT_DECRYPT');
        if ('status' in k) return k;
        try {
          const d = createDecipheriv('aes-256-gcm', k.material!, blob.subarray(36, 48));
          d.setAAD(ctxAad(body.EncryptionContext));
          d.setAuthTag(blob.subarray(48, 64));
          const plain = Buffer.concat([d.update(blob.subarray(64)), d.final()]);
          this.log.push({ action, keyId: k.KeyId, context: (body.EncryptionContext as Record<string, string>) ?? {} });
          return ok({ Plaintext: plain.toString('base64'), KeyId: k.Arn, EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' });
        } catch {
          return err(400, 'InvalidCiphertextException', '');
        }
      }
      case 'Sign': {
        const k = usable(this.resolve(body.KeyId, region), 'SIGN_VERIFY');
        if ('status' in k) return k;
        if (body.SigningAlgorithm !== 'ECDSA_SHA_256') return err(400, 'ValidationException', `${String(body.SigningAlgorithm)} is not valid for ${k.KeySpec}`);
        const msg = Buffer.from(String(body.Message ?? ''), 'base64');
        const digest = body.MessageType === 'DIGEST' ? msg : createHash('sha256').update(msg).digest();
        if (digest.length !== 32) return err(400, 'ValidationException', 'Digest is invalid length for algorithm ECDSA_SHA_256.');
        this.log.push({ action, keyId: k.KeyId });
        return ok({ KeyId: k.Arn, Signature: rawToDer(signDigestP256(k.privateKey!, digest)).toString('base64'), SigningAlgorithm: 'ECDSA_SHA_256' });
      }
      case 'GetPublicKey': {
        const k = this.resolve(body.KeyId, region);
        if (!k) return err(400, 'NotFoundException', 'Key does not exist');
        if (k.KeyState !== 'Enabled') return err(400, 'KMSInvalidStateException', `${k.Arn} is pending deletion.`);
        if (!k.publicKey) return err(400, 'UnsupportedOperationException', `${k.Arn} key usage is ENCRYPT_DECRYPT which is not valid for GetPublicKey.`);
        this.log.push({ action, keyId: k.KeyId });
        return ok({ KeyId: k.Arn, PublicKey: k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), KeySpec: k.KeySpec, KeyUsage: k.KeyUsage, SigningAlgorithms: ['ECDSA_SHA_256'] });
      }
    }
    return err(400, 'UnsupportedOperationException', `${action} is not something this fake answers`);
  }
}
