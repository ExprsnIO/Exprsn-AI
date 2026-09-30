import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto';
import type { Services } from '../services.js';
import { PLATFORM_SCOPE } from '../platform/datakeys.js';
import type { SigningKeyType } from '../platform/kms.js';
import type { Jwk, JwsSigner } from './jose.js';
import { selfSignedCertificate, selfSignedRsaCertificate } from './x509.js';

/** oidc: ES256 token signing; saml: RS256 SAML signing; saml-enc: RSA-OAEP decryption of upstream encrypted assertions. */
export type KeyUse = 'oidc' | 'saml' | 'saml-enc';

/** A signing key that lives in the KMS: `private_sealed` holds this prefix and the KMS key name, never key material. */
const KMS_REF = 'kms:';

/** A signer for the current key: JWS (and XML-DSig) signatures through a local key or the KMS. */
export interface KeySigner extends JwsSigner {
  row: KeyRow;
  /** True when the private key is in the KMS and never in this process. */
  remote: boolean;
}
export type KeyState = 'next' | 'signing' | 'retired';

export interface KeyRow {
  kid: string;
  tenant_id: string;
  use: KeyUse;
  alg: string;
  state: KeyState;
  public_jwk: Jwk;
  private_sealed: string;
  certificate: string | null;
  created_at: number;
  activates_at: number;
  retires_at: number | null;
  removes_at: number | null;
}

const DAY = 86_400_000;

const fromRow = (r: Record<string, unknown>): KeyRow => ({
  ...(r as unknown as KeyRow),
  public_jwk: JSON.parse(String(r.public_jwk)) as Jwk,
  created_at: Number(r.created_at),
  activates_at: Number(r.activates_at),
  retires_at: r.retires_at == null ? null : Number(r.retires_at),
  removes_at: r.removes_at == null ? null : Number(r.removes_at)
});

const kidFor = (at: number): string => {
  const d = new Date(at);
  return `k-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${randomBytes(3).toString('hex')}`;
};

/**
 * Signing keys per tenant. OIDC keys are ES256 (P-256); the SAML key is RSA-2048 with a self-signed certificate,
 * because SAML service providers widely support RSA-SHA256 and not ECDSA. Private keys are PKCS#8, sealed with the
 * platform data key and bound to their key id; they never leave the server.
 *
 * OIDC key life: `next` (published in the JWKS, not signing) → `signing` → `retired` (still published for the
 * overlap window so tokens it signed keep verifying) → removed from the JWKS.
 */
export class SigningKeys {
  private readonly cache = new Map<string, KeyObject>();

  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private overlapMs(): number {
    return this.s().cfg.OIDC_KEY_OVERLAP_DAYS * DAY;
  }

  private aad(tenantId: string, kid: string): string {
    return `federation-key:${tenantId}:${kid}`;
  }

  /** Signing in the KMS: OpenBao transit when KMS_PROVIDER=openbao. Decryption keys (saml-enc) stay sealed locally. */
  private kmsSigns(use: KeyUse): boolean {
    const kms = this.s().kms;
    return use !== 'saml-enc' && typeof kms.createSigningKey === 'function' && typeof kms.sign === 'function';
  }

  private async insert(tenantId: string, use: KeyUse, activatesAt: number): Promise<KeyRow> {
    const t = Date.now();
    const kid = kidFor(activatesAt);
    const alg = use === 'oidc' ? 'ES256' : use === 'saml' ? 'RS256' : 'RSA-OAEP';
    const certificateFor = async (publicKey: KeyObject, signRsa: (tbs: Buffer) => Promise<Buffer>) => {
      const tenant = await this.s().tenants.byId(tenantId);
      const host = new URL(this.s().cfg.FEDERATION_ISSUER ?? this.s().cfg.PUBLIC_URL).hostname;
      return (await selfSignedRsaCertificate({ publicKey, signRsa, commonName: `${host} SAML ${use === 'saml' ? 'IdP' : 'SP encryption'}`, organization: tenant?.name ?? 'Exprsn-AI', days: 3 * 365 })).toString('base64');
    };
    let publicKey: KeyObject;
    let privateSealed: string;
    let certificate: string | null = null;
    if (this.kmsSigns(use)) {
      const kms = this.s().kms;
      const name = `${this.s().cfg.OPENBAO_KEY_PREFIX}fed-${kid}`.toLowerCase();
      const type: SigningKeyType = use === 'oidc' ? 'ecdsa-p256' : 'rsa-2048';
      publicKey = createPublicKey(await kms.createSigningKey!(name, type));
      if (use === 'saml') certificate = await certificateFor(publicKey, (tbs) => kms.sign!(name, 'rsa-2048', tbs));
      privateSealed = `${KMS_REF}${name}`;
    } else {
      let privateKey: KeyObject;
      if (use === 'oidc') ({ publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }));
      else {
        ({ publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 }));
        certificate = selfSignedCertificate({ publicKey, privateKey, commonName: `${new URL(this.s().cfg.FEDERATION_ISSUER ?? this.s().cfg.PUBLIC_URL).hostname} SAML ${use === 'saml' ? 'IdP' : 'SP encryption'}`, organization: (await this.s().tenants.byId(tenantId))?.name ?? 'Exprsn-AI', days: 3 * 365 }).toString('base64');
      }
      const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      privateSealed = await this.s().keys.sealer(PLATFORM_SCOPE).seal(pem, this.aad(tenantId, kid));
      this.cache.set(kid, privateKey);
    }
    const jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid, use: use === 'saml-enc' ? 'enc' : 'sig', alg };
    const row = {
      kid,
      tenant_id: tenantId,
      use,
      alg,
      state: activatesAt <= t ? 'signing' : 'next',
      public_jwk: JSON.stringify(jwk),
      private_sealed: privateSealed,
      certificate,
      created_at: t,
      activates_at: activatesAt,
      retires_at: null,
      removes_at: null
    };
    await this.db('federation_keys').insert(row);
    return fromRow(row);
  }

  /** Is this key's private half in the KMS (and so usable while KMS signing is on)? */
  static inKms(row: Pick<KeyRow, 'private_sealed'>): boolean {
    return row.private_sealed.startsWith(KMS_REF);
  }

  async list(tenantId: string, use: KeyUse = 'oidc'): Promise<KeyRow[]> {
    const rows = await this.db('federation_keys').where({ tenant_id: tenantId, use }).orderBy('activates_at', 'desc');
    const now = Date.now();
    return rows.map(fromRow).filter((k) => k.removes_at == null || k.removes_at > now);
  }

  /**
   * Moves keys along their life: a `next` key whose time has come starts signing and the key it replaces retires
   * (kept in the JWKS for the overlap window). Creates the first key when a tenant has none.
   */
  async advance(tenantId: string, use: KeyUse = 'oidc'): Promise<KeyRow> {
    const now = Date.now();
    let keys = await this.list(tenantId, use);
    const due = keys.filter((k) => k.state === 'next' && k.activates_at <= now).sort((a, b) => b.activates_at - a.activates_at)[0];
    if (due) {
      const retireAt = now;
      for (const k of keys.filter((x) => x.state === 'signing')) {
        await this.db('federation_keys').where({ kid: k.kid }).update({ state: 'retired', retires_at: retireAt, removes_at: retireAt + Math.max(this.overlapMs(), DAY) });
      }
      await this.db('federation_keys').where({ kid: due.kid }).update({ state: 'signing' });
      keys = await this.list(tenantId, use);
    }
    const signing = keys.find((k) => k.state === 'signing');
    if (signing && this.kmsSigns(use) && !SigningKeys.inKms(signing)) {
      // KMS signing was turned on: a key whose private half is in this process stops signing now (it stays published
      // for the overlap window, so what it signed keeps verifying) and a key held in the KMS replaces it.
      const next = await this.insert(tenantId, use, now);
      await this.db('federation_keys').where({ kid: signing.kid }).update({ state: 'retired', retires_at: now, removes_at: now + Math.max(this.overlapMs(), DAY) });
      this.cache.delete(signing.kid);
      return next;
    }
    if (signing) return signing;
    return this.insert(tenantId, use, now);
  }

  /** The key that signs now, as a signer: ES256 (raw r||s) for OIDC, RS256 (PKCS#1 v1.5) for SAML. */
  async signer(tenantId: string, use: 'oidc' | 'saml' = 'oidc'): Promise<KeySigner> {
    const row = await this.advance(tenantId, use);
    const alg = use === 'oidc' ? 'ES256' : 'RS256';
    if (SigningKeys.inKms(row)) {
      const kms = this.s().kms;
      if (!kms.sign) throw new Error(`Key ${row.kid} is held in a KMS that is no longer configured.`);
      const name = row.private_sealed.slice(KMS_REF.length);
      const type: SigningKeyType = use === 'oidc' ? 'ecdsa-p256' : 'rsa-2048';
      return { row, kid: row.kid, alg, remote: true, sign: (data) => kms.sign!(name, type, data) };
    }
    const key = await this.privateKey(row);
    return { row, kid: row.kid, alg, remote: false, sign: async (data) => (alg === 'ES256' ? cryptoSign('sha256', data, { key, dsaEncoding: 'ieee-p1363' }) : cryptoSign('sha256', data, key)) };
  }

  /** The tenant's SAML SP decryption key (RSA-OAEP) and its certificate, for upstream encrypted assertions. */
  async decrypter(tenantId: string): Promise<{ row: KeyRow; key: KeyObject }> {
    const row = await this.advance(tenantId, 'saml-enc');
    return { row, key: await this.privateKey(row) };
  }

  /** Key ids whose private key is held in this process right now (tests: none for signing keys with KMS signing). */
  cachedKids(): string[] {
    return [...this.cache.keys()];
  }

  private async privateKey(row: KeyRow): Promise<KeyObject> {
    if (SigningKeys.inKms(row)) throw new Error(`Key ${row.kid} is held in the KMS.`);
    const hit = this.cache.get(row.kid);
    if (hit) return hit;
    const pem = await this.s().keys.sealer(PLATFORM_SCOPE).open(row.private_sealed, this.aad(row.tenant_id, row.kid));
    const key = createPrivateKey(pem);
    this.cache.set(row.kid, key);
    return key;
  }

  /** The published key set: next, signing and retired keys still inside their overlap window. */
  async jwks(tenantId: string): Promise<{ keys: Jwk[] }> {
    await this.advance(tenantId);
    return { keys: (await this.list(tenantId)).map((k) => k.public_jwk) };
  }

  /**
   * Publishes a new key. Normally it starts signing after the overlap window, so relying parties that cache the
   * JWKS see it first; `immediate` (a suspected compromise) makes it sign now and retires the current key.
   */
  async rotate(tenantId: string, opts: { immediate?: boolean } = {}): Promise<{ next: KeyRow; current: KeyRow | null }> {
    const current = (await this.list(tenantId)).find((k) => k.state === 'signing') ?? null;
    // A pending next key is replaced rather than stacked.
    await this.db('federation_keys').where({ tenant_id: tenantId, use: 'oidc', state: 'next' }).delete();
    const next = await this.insert(tenantId, 'oidc', opts.immediate || !current ? Date.now() - 1 : Date.now() + this.overlapMs());
    if (next.state === 'signing' && current) {
      const t = Date.now();
      await this.db('federation_keys').where({ kid: current.kid }).update({ state: 'retired', retires_at: t, removes_at: t + Math.max(this.overlapMs(), DAY) });
    }
    return { next, current };
  }

  /** Scheduled: publishes the next key `overlap` days before the signing key reaches its rotation age. */
  async scheduled(tenantId: string): Promise<{ published?: string; activated?: string }> {
    const before = (await this.list(tenantId)).find((k) => k.state === 'signing')?.kid;
    const signing = await this.advance(tenantId);
    const out: { published?: string; activated?: string } = {};
    if (signing.kid !== before && before) out.activated = signing.kid;
    const keys = await this.list(tenantId);
    const rotateAt = signing.activates_at + this.s().cfg.OIDC_KEY_ROTATION_DAYS * DAY;
    if (!keys.some((k) => k.state === 'next') && Date.now() >= rotateAt - this.overlapMs()) {
      const next = await this.insert(tenantId, 'oidc', Math.max(rotateAt, Date.now() + 1000));
      out.published = next.kid;
    }
    return out;
  }

  /** When the current signing key is due to be replaced. */
  async rotatesAt(tenantId: string): Promise<number | null> {
    const keys = await this.list(tenantId);
    const next = keys.find((k) => k.state === 'next');
    if (next) return next.activates_at;
    const signing = keys.find((k) => k.state === 'signing');
    return signing ? signing.activates_at + this.s().cfg.OIDC_KEY_ROTATION_DAYS * DAY : null;
  }
}
