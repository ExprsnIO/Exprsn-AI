import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import type { Db } from '../db/knex.js';
import { SecretBox } from '../crypto/index.js';
import { newDataKey, type Kms } from './kms.js';
import type { Bus } from './bus.js';

const DESTROYED = 'keys.destroyed';

export const PLATFORM_SCOPE = 'platform';

export class KeyDestroyedError extends Error {
  constructor(scope: string) {
    super(`The data key for ${scope} has been destroyed; its data cannot be opened`);
  }
}

interface KeyRow {
  id: string;
  tenant_id: string;
  version: number;
  kms: string;
  key_name: string;
  wrapped: string | null;
  state: 'active' | 'retired' | 'destroyed';
  created_at: number;
}

/** Something that seals short secrets at rest (TOTP seeds, provider secrets). */
export interface Sealer {
  seal(plaintext: string, aad: string): Promise<string>;
  open(sealed: string, aad: string): Promise<string>;
}

/**
 * Envelope encryption with one data key (DEK) per tenant, plus one for platform-wide secrets. DEKs are random
 * AES-256 keys, stored only wrapped by the tenant's key-encryption key in the KMS, and cached unwrapped in memory
 * for a short time. Sealed values look like `v2.<key id>.<iv>.<tag>.<ciphertext>` (base64url), so rotation keeps
 * old values readable. Destroying a tenant's keys crypto-shreds everything sealed with them.
 */
export class DataKeys {
  private readonly cache = new Map<string, { key: Buffer; at: number; scope: string }>();
  private readonly active = new Map<string, Promise<KeyRow>>();
  private readonly legacy: SecretBox | null;

  constructor(
    private readonly db: Db,
    private readonly kms: Kms,
    private readonly prefix: string,
    legacyDataKey?: string,
    private readonly bus?: Bus,
    private readonly ttlMs = 5 * 60_000
  ) {
    this.legacy = legacyDataKey ? new SecretBox(legacyDataKey) : null;
    // Every instance drops its cached copies when any instance destroys a scope's keys.
    bus?.on<{ scope: string }>(DESTROYED, ({ scope }) => this.forget(scope));
  }

  private forget(scope: string): void {
    for (const [id, e] of this.cache) if (e.scope === scope) this.cache.delete(id);
    this.active.delete(scope);
  }

  kekName(scope: string): string {
    return `${this.prefix}${scope === PLATFORM_SCOPE ? 'platform' : 'tenant-' + scope.toLowerCase()}`;
  }

  private aad(row: Pick<KeyRow, 'tenant_id' | 'version'>): string {
    return `dek:${row.tenant_id}:${row.version}`;
  }

  /** The active key row for a scope, creating version 1 on first use. */
  private activeKey(scope: string): Promise<KeyRow> {
    let p = this.active.get(scope);
    if (!p) {
      p = this.loadOrCreate(scope).catch((err) => {
        this.active.delete(scope);
        throw err;
      });
      this.active.set(scope, p);
    }
    return p;
  }

  private async loadOrCreate(scope: string): Promise<KeyRow> {
    const existing = (await this.db('tenant_keys').where({ tenant_id: scope, state: 'active' }).orderBy('version', 'desc').first()) as KeyRow | undefined;
    if (existing) return existing;
    if (await this.db('tenant_keys').where({ tenant_id: scope, state: 'destroyed' }).first()) throw new KeyDestroyedError(scope);
    return this.create(scope, 1);
  }

  private async create(scope: string, version: number): Promise<KeyRow> {
    const name = this.kekName(scope);
    await this.kms.ensureKey(name);
    const dek = newDataKey();
    const row: KeyRow = { id: ulid(), tenant_id: scope, version, kms: this.kms.kind, key_name: name, wrapped: null, state: 'active', created_at: Date.now() };
    row.wrapped = await this.kms.wrap(name, dek, this.aad(row));
    try {
      await this.db('tenant_keys').insert(row);
    } catch (err) {
      // Another instance created it first: use theirs.
      const theirs = (await this.db('tenant_keys').where({ tenant_id: scope, version }).first()) as KeyRow | undefined;
      if (theirs) return theirs;
      throw err;
    }
    this.cache.set(row.id, { key: dek, at: Date.now(), scope });
    return row;
  }

  private async keyById(id: string): Promise<Buffer> {
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.key;
    const row = (await this.db('tenant_keys').where({ id }).first()) as KeyRow | undefined;
    if (!row) throw new Error('Unknown data key');
    if (row.state === 'destroyed' || !row.wrapped) throw new KeyDestroyedError(row.tenant_id);
    const key = await this.kms.unwrap(row.key_name, row.wrapped, this.aad(row));
    this.cache.set(id, { key, at: Date.now(), scope: row.tenant_id });
    return key;
  }

  async sealBytes(scope: string, plaintext: Buffer, aad: string): Promise<string> {
    const row = await this.activeKey(scope);
    const key = await this.keyById(row.id);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${scope}|${aad}`));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return ['v2', row.id, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  async openBytes(scope: string, sealed: string, aad: string): Promise<Buffer> {
    if (sealed.startsWith('v1.')) {
      if (!this.legacy) throw new Error('A value sealed with DATA_KEY needs DATA_KEY to open');
      return Buffer.from(this.legacy.open(sealed, aad), 'utf8');
    }
    const [v, keyId, iv, tag, ct] = sealed.split('.');
    if (v !== 'v2' || !keyId || !iv || !tag || ct === undefined) throw new Error('Unrecognised sealed value');
    const key = await this.keyById(keyId);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`${scope}|${aad}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
  }

  async seal(scope: string, plaintext: string, aad: string): Promise<string> {
    return this.sealBytes(scope, Buffer.from(plaintext, 'utf8'), aad);
  }

  async open(scope: string, sealed: string, aad: string): Promise<string> {
    return (await this.openBytes(scope, sealed, aad)).toString('utf8');
  }

  /** A sealer bound to one scope, for services that only ever use one. */
  sealer(scope: string): Sealer {
    return { seal: (p, a) => this.seal(scope, p, a), open: (s, a) => this.open(scope, s, a) };
  }

  /** Starts a new key version; values sealed with older versions stay readable. */
  async rotate(scope: string): Promise<{ version: number }> {
    const current = await this.activeKey(scope);
    await this.db('tenant_keys').where({ id: current.id }).update({ state: 'retired' });
    this.active.delete(scope);
    const next = await this.create(scope, current.version + 1);
    this.active.set(scope, Promise.resolve(next));
    return { version: next.version };
  }

  /** Crypto-shreds a scope: every wrapped key is deleted and the KEK destroyed in the KMS. Irreversible. */
  async destroy(scope: string): Promise<{ versions: number }> {
    const rows = (await this.db('tenant_keys').where({ tenant_id: scope })) as KeyRow[];
    await this.db('tenant_keys').where({ tenant_id: scope }).update({ wrapped: null, state: 'destroyed', destroyed_at: Date.now() });
    this.forget(scope);
    this.bus?.publish(DESTROYED, { scope });
    await this.kms.destroyKey(this.kekName(scope));
    return { versions: rows.length };
  }

  async describe(scope: string): Promise<{ kms: string; keyName: string; version: number | null; state: string; createdAt: number | null }> {
    const row = (await this.db('tenant_keys').where({ tenant_id: scope }).orderBy('version', 'desc').first()) as KeyRow | undefined;
    return { kms: row?.kms ?? this.kms.kind, keyName: this.kekName(scope), version: row?.version ?? null, state: row?.state ?? 'not created', createdAt: row?.created_at ?? null };
  }
}
