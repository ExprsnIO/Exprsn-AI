import { createPrivateKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import type { Services } from '../services.js';
import { PLATFORM_SCOPE } from '../platform/datakeys.js';
import type { Jwk } from './jose.js';
import { selfSignedCertificate } from './x509.js';

export type KeyUse = 'oidc' | 'saml';
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

  private async insert(tenantId: string, use: KeyUse, activatesAt: number): Promise<KeyRow> {
    const t = Date.now();
    const kid = kidFor(activatesAt);
    let publicKey: KeyObject;
    let privateKey: KeyObject;
    let certificate: string | null = null;
    if (use === 'oidc') ({ publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }));
    else {
      ({ publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 }));
      const tenant = await this.s().tenants.byId(tenantId);
      certificate = selfSignedCertificate({ publicKey, privateKey, commonName: `${new URL(this.s().cfg.FEDERATION_ISSUER ?? this.s().cfg.PUBLIC_URL).hostname} SAML IdP`, organization: tenant?.name ?? 'Exprsn-AI', days: 3 * 365 }).toString('base64');
    }
    const jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid, use: 'sig', alg: use === 'oidc' ? 'ES256' : 'RS256' };
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const row = {
      kid,
      tenant_id: tenantId,
      use,
      alg: jwk.alg,
      state: activatesAt <= t ? 'signing' : 'next',
      public_jwk: JSON.stringify(jwk),
      private_sealed: await this.s().keys.sealer(PLATFORM_SCOPE).seal(pem, this.aad(tenantId, kid)),
      certificate,
      created_at: t,
      activates_at: activatesAt,
      retires_at: null,
      removes_at: null
    };
    await this.db('federation_keys').insert(row);
    this.cache.set(kid, privateKey);
    return fromRow(row);
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
    if (signing) return signing;
    return this.insert(tenantId, use, now);
  }

  /** The key that signs now, and its private key. */
  async signer(tenantId: string, use: KeyUse = 'oidc'): Promise<{ row: KeyRow; key: KeyObject }> {
    const row = await this.advance(tenantId, use);
    return { row, key: await this.privateKey(row) };
  }

  private async privateKey(row: KeyRow): Promise<KeyObject> {
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
