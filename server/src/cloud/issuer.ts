import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { b64u, signJwtWith, type Jwk, type JwsSigner } from '../federation/jose.js';
import { PLATFORM_SCOPE } from '../platform/datakeys.js';
import type { SigningKeyType } from '../platform/kms.js';
import { platformTenant } from '../ops/common.js';
import type { Services } from '../services.js';
import { cloudHttp, CloudCallError } from './credential-http.js';
import { publisherFor, targetSchema, type IssuerTarget, type PublisherDeps } from './issuer-publishers.js';
import type { CloudCredentials } from './credentials.js';

/*
 * 1.9.99-final, Sprint 56 (B-10003 to B-10005): the federation issuer the clouds trust.
 *
 * A separate issuer from the console's OIDC provider (`federation/oidc.ts`): its own URL (CLOUD_ISSUER_URL, or
 * PUBLIC_URL + /cloud-issuer), its own keys (`cloud_issuer_keys`), and only two public documents. It mints one kind of
 * token: `sub` `cloud-account:<id>`, `aud` the cloud's token exchange (`sts.amazonaws.com`,
 * `api://AzureADTokenExchange`), a few minutes long, used once to buy a cloud session.
 *
 * Keys. ES256 (P-256) always; with CLOUD_AZURE_SIGNING_ALG=RS256 (open decision 3) also an RSA-2048 key used only for
 * the Azure audience. Each private key is held by the signer process (SIGNER_SOCKET) or OpenBao transit
 * (KMS_PROVIDER=openbao); only when neither is configured is it sealed with the platform data key, and a key made
 * that way is replaced as soon as one of them is (the held key is published at once and takes over as soon as the
 * published JWKS holds it). Life: `next` (published, not signing) →
 * `signing` → `retired` (still published until every session bought with it has ended) → removed from the JWKS.
 *
 * Rotation never fails an exchange: a new key is published first and starts signing only once the published JWKS
 * holds it (for a bucket target: the last successful publication listed its kid) and CLOUD_ISSUER_PUBLISH_LEAD_MINUTES
 * have passed. The retired key stays for CLOUD_SESSION_SECONDS plus the token lifetime plus 15 minutes.
 */

export type IssuerAlg = 'ES256' | 'RS256';
export type IssuerKeyState = 'next' | 'signing' | 'retired';
export const AWS_AUDIENCE = 'sts.amazonaws.com';
export const AZURE_AUDIENCE = 'api://AzureADTokenExchange';
export const subjectOf = (accountId: string): string => `cloud-account:${accountId}`;
export const DISCOVERY_NAME = '.well-known/openid-configuration';
export const JWKS_NAME = 'jwks.json';
const STATE_ID = 'issuer';
const SIGNER_REF = 'signer:';
const KMS_REF = 'kms:';
const MIN = 60_000;

export interface IssuerKeyRow {
  kid: string;
  alg: IssuerAlg;
  state: IssuerKeyState;
  public_jwk: Jwk;
  private_ref: string;
  created_at: number;
  activates_at: number;
  retires_at: number | null;
  removes_at: number | null;
}

export type CheckState = 'ok' | 'mismatch' | 'error' | 'unpublished';

interface StateRow {
  target: IssuerTarget;
  published_at: number | null;
  published_hash: string | null;
  published_kids: string[];
  publish_error: string | null;
  checked_at: number | null;
  check_state: CheckState | null;
  check_detail: string | null;
  alerted_at: number | null;
  updated_by: string | null;
  updated_at: number;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const keyFrom = (r: Record<string, unknown>): IssuerKeyRow => ({
  kid: String(r.kid),
  alg: String(r.alg) as IssuerAlg,
  state: String(r.state) as IssuerKeyState,
  public_jwk: JSON.parse(String(r.public_jwk)) as Jwk,
  private_ref: String(r.private_ref),
  created_at: Number(r.created_at),
  activates_at: Number(r.activates_at),
  retires_at: num(r.retires_at),
  removes_at: num(r.removes_at)
});
const json = <T>(v: unknown, fallback: T): T => {
  try {
    return v == null ? fallback : (JSON.parse(String(v)) as T);
  } catch {
    return fallback;
  }
};
const kidFor = (alg: IssuerAlg): string => {
  const d = new Date();
  return `ci-${alg === 'ES256' ? 'es' : 'rs'}-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${randomBytes(4).toString('hex')}`;
};
const typeOf = (alg: IssuerAlg): SigningKeyType => (alg === 'ES256' ? 'ecdsa-p256' : 'rsa-2048');
export const custodyOfRef = (ref: string): 'signer' | 'openbao' | 'sealed' => (ref.startsWith(SIGNER_REF) ? 'signer' : ref.startsWith(KMS_REF) ? 'openbao' : 'sealed');

/** The JWKS as compared and published: kids sorted, public members only. */
export function canonicalJwks(keys: Jwk[]): { keys: Jwk[] } {
  const pub = (k: Jwk): Jwk => (k.kty === 'EC' ? { kty: 'EC', crv: k.crv, x: k.x, y: k.y, kid: k.kid, use: 'sig', alg: k.alg } : { kty: 'RSA', n: k.n, e: k.e, kid: k.kid, use: 'sig', alg: k.alg });
  return { keys: keys.map(pub).sort((a, b) => String(a.kid).localeCompare(String(b.kid))) };
}
const hashOf = (body: string) => createHash('sha256').update(body).digest('hex');

export class CloudIssuer {
  private installedAt = 0;
  private installedOk = false;
  private readonly cache = new Map<string, KeyObject>();
  private publishing = false;

  constructor(
    private readonly s: () => Services,
    private readonly creds: () => CloudCredentials
  ) {}

  private get db() {
    return this.s().db;
  }

  private get cfg() {
    return this.s().cfg;
  }

  /** The issuer URL (no trailing slash): never the console's own OIDC issuer. */
  url(): string {
    return (this.cfg.CLOUD_ISSUER_URL ?? `${this.cfg.PUBLIC_URL.replace(/\/+$/, '')}/cloud-issuer`).replace(/\/+$/, '');
  }

  /** Migration 147 applied? Cached for a minute, so a migration run later is seen without a restart. */
  async installed(): Promise<boolean> {
    if (this.installedOk || Date.now() - this.installedAt < MIN) return this.installedOk;
    this.installedAt = Date.now();
    this.installedOk = (await this.db.schema.hasTable('cloud_issuer_keys')) && (await this.db.schema.hasTable('cloud_issuer_state'));
    return this.installedOk;
  }

  private async assertInstalled(): Promise<void> {
    if (!(await this.installed())) throw new CloudCallError('The federation issuer is not installed: migration 147_cloud_federation has not run.', 503, 'not-installed');
  }

  /** Where new keys go: the signer, OpenBao transit, or (neither configured) sealed in the database. */
  custody(): 'signer' | 'openbao' | 'sealed' {
    const k = this.s().kms;
    if (k.heldKeys) return 'signer';
    if (typeof k.createSigningKey === 'function' && typeof k.sign === 'function') return 'openbao';
    return 'sealed';
  }

  /** The algorithms the issuer signs with now. */
  algs(): IssuerAlg[] {
    return this.cfg.CLOUD_AZURE_SIGNING_ALG === 'RS256' ? ['ES256', 'RS256'] : ['ES256'];
  }

  /** Retired keys stay published this long: every session bought with them has ended by then. */
  private retentionMs(): number {
    return this.cfg.CLOUD_SESSION_SECONDS * 1000 + this.cfg.CLOUD_ISSUER_TOKEN_SECONDS * 1000 + 15 * MIN;
  }

  async keys(alg?: IssuerAlg): Promise<IssuerKeyRow[]> {
    if (!(await this.installed())) return [];
    const q = this.db('cloud_issuer_keys').orderBy('activates_at', 'desc');
    if (alg) q.where({ alg });
    const now = Date.now();
    return ((await q) as Record<string, unknown>[]).map(keyFrom).filter((k) => k.removes_at == null || k.removes_at > now);
  }

  private async insert(alg: IssuerAlg, activatesAt: number): Promise<IssuerKeyRow> {
    const kid = kidFor(alg);
    const type = typeOf(alg);
    const kms = this.s().kms;
    let publicKey: KeyObject;
    let privateRef: string;
    const custody = this.custody();
    if (custody === 'signer') {
      const r = await kms.heldKeys!.create(`cloud-issuer:${kid}`, type);
      publicKey = createPublicKey(r.publicKey);
      privateRef = `${SIGNER_REF}${r.wrapped}`;
    } else if (custody === 'openbao') {
      const name = `${this.cfg.OPENBAO_KEY_PREFIX}cloud-issuer-${kid}`.toLowerCase();
      publicKey = createPublicKey(await kms.createSigningKey!(name, type));
      privateRef = `${KMS_REF}${name}`;
    } else {
      const pair = alg === 'ES256' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('rsa', { modulusLength: 2048 });
      publicKey = pair.publicKey;
      privateRef = await this.s().keys.sealer(PLATFORM_SCOPE).seal(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), `cloud-issuer-key:${kid}`);
      this.cache.set(kid, pair.privateKey);
    }
    const jwk: Jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid, use: 'sig', alg };
    const now = Date.now();
    const row = { kid, alg, state: activatesAt <= now ? 'signing' : 'next', public_jwk: JSON.stringify(jwk), private_ref: privateRef, created_at: now, activates_at: activatesAt, retires_at: null, removes_at: null };
    await this.db('cloud_issuer_keys').insert(row);
    return keyFrom(row);
  }

  private async retire(kids: string[], at = Date.now()): Promise<void> {
    if (!kids.length) return;
    await this.db('cloud_issuer_keys').whereIn('kid', kids).update({ state: 'retired', retires_at: at, removes_at: at + this.retentionMs() });
    for (const k of kids) this.cache.delete(k);
  }

  /** May this next key start signing? Only once the published JWKS holds it (a bucket target), or at once otherwise. */
  private async publishedFor(kid: string): Promise<boolean> {
    const st = await this.state();
    if (st.target.kind === 'none' || st.target.kind === 'console') return true;
    return st.published_kids.includes(kid);
  }

  /**
   * Moves one algorithm's keys along: a due `next` key that is published starts signing and the one it replaces
   * retires; a signing key whose private half is in this process while the signer or transit is configured gets a
   * held successor, published at once; the first key is made when there is none.
   */
  async advance(alg: IssuerAlg): Promise<IssuerKeyRow> {
    await this.assertInstalled();
    const now = Date.now();
    let keys = await this.keys(alg);
    const due = keys.filter((k) => k.state === 'next' && k.activates_at <= now).sort((a, b) => b.activates_at - a.activates_at)[0];
    if (due && (await this.publishedFor(due.kid))) {
      await this.retire(keys.filter((k) => k.state === 'signing').map((k) => k.kid), now);
      await this.db('cloud_issuer_keys').where({ kid: due.kid }).update({ state: 'signing' });
      keys = await this.keys(alg);
    }
    const signing = keys.find((k) => k.state === 'signing');
    if (signing && custodyOfRef(signing.private_ref) === 'sealed' && this.custody() !== 'sealed' && !keys.some((k) => k.state === 'next')) {
      // The signer or transit was turned on: a key held there is published now and replaces this one as soon as the
      // published JWKS holds it (the same path as a rotation, so no exchange fails meanwhile).
      await this.insert(alg, now + 1);
      if (!this.publishing) await this.publish('custody').catch((err: Error) => this.s().log.warn({ err: err.message }, 'cloud issuer: publication after a custody change failed'));
      return this.advance(alg);
    }
    if (signing) return signing;
    return this.insert(alg, now);
  }

  private async privateKey(row: IssuerKeyRow): Promise<KeyObject> {
    const hit = this.cache.get(row.kid);
    if (hit) return hit;
    const pem = await this.s().keys.sealer(PLATFORM_SCOPE).open(row.private_ref, `cloud-issuer-key:${row.kid}`);
    const key = createPrivateKey(pem);
    this.cache.set(row.kid, key);
    return key;
  }

  /** The signer of the key that signs now for `alg`. `remote` is true when the private key is not in this process. */
  async signer(alg: IssuerAlg): Promise<JwsSigner & { remote: boolean; row: IssuerKeyRow }> {
    const row = await this.advance(alg);
    const type = typeOf(alg);
    const custody = custodyOfRef(row.private_ref);
    if (custody === 'signer') {
      const held = this.s().kms.heldKeys;
      if (!held) throw new CloudCallError(`Issuer key ${row.kid} is held by the signer, which is not configured (SIGNER_SOCKET).`, 503, 'custody');
      const wrapped = row.private_ref.slice(SIGNER_REF.length);
      return { kid: row.kid, alg, remote: true, row, sign: (d) => held.sign(`cloud-issuer:${row.kid}`, type, wrapped, d) };
    }
    if (custody === 'openbao') {
      const kms = this.s().kms;
      if (!kms.sign) throw new CloudCallError(`Issuer key ${row.kid} is held in OpenBao transit, which is not configured.`, 503, 'custody');
      const name = row.private_ref.slice(KMS_REF.length);
      return { kid: row.kid, alg, remote: true, row, sign: (d) => kms.sign!(name, type, d) };
    }
    const key = await this.privateKey(row);
    return { kid: row.kid, alg, remote: false, row, sign: async (d) => (alg === 'ES256' ? cryptoSign('sha256', d, { key, dsaEncoding: 'ieee-p1363' }) : cryptoSign('sha256', d, key)) };
  }

  /** The algorithm for an audience: RS256 only for Azure and only when the setting asks for it. */
  algFor(audience: string): IssuerAlg {
    return audience === AZURE_AUDIENCE && this.cfg.CLOUD_AZURE_SIGNING_ALG === 'RS256' ? 'RS256' : 'ES256';
  }

  /** A token for one exchange: `sub` cloud-account:<id>, the cloud's audience, a few minutes long. */
  async mint(accountId: string, audience: string): Promise<{ token: string; kid: string; alg: IssuerAlg; expiresAt: number }> {
    const alg = this.algFor(audience);
    const signer = await this.signer(alg);
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + this.cfg.CLOUD_ISSUER_TOKEN_SECONDS;
    const token = await signJwtWith({ iss: this.url(), sub: subjectOf(accountId), aud: audience, iat, nbf: iat - 5, exp, jti: b64u(randomBytes(16)) }, signer);
    return { token, kid: signer.kid, alg, expiresAt: exp * 1000 };
  }

  discovery(): Record<string, unknown> {
    const issuer = this.url();
    return {
      issuer,
      jwks_uri: `${issuer}/${JWKS_NAME}`,
      response_types_supported: ['id_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: this.algs(),
      claims_supported: ['iss', 'sub', 'aud', 'iat', 'nbf', 'exp', 'jti']
    };
  }

  /** The key set to publish: next, signing and retired keys of every algorithm still inside their window. */
  async jwks(): Promise<{ keys: Jwk[] }> {
    if (!(await this.installed())) return { keys: [] };
    for (const alg of this.algs()) await this.advance(alg);
    return canonicalJwks((await this.keys()).map((k) => k.public_jwk));
  }

  // ---- publication (B-10005) ----

  async state(): Promise<StateRow> {
    const r = (await this.installed()) ? ((await this.db('cloud_issuer_state').where({ id: STATE_ID }).first()) as Record<string, unknown> | undefined) : undefined;
    if (!r) return { target: { kind: 'none' }, published_at: null, published_hash: null, published_kids: [], publish_error: null, checked_at: null, check_state: null, check_detail: null, alerted_at: null, updated_by: null, updated_at: 0 };
    const parsed = targetSchema.safeParse(json(r.target, { kind: 'none' }));
    return {
      target: parsed.success ? parsed.data : { kind: 'none' },
      published_at: num(r.published_at),
      published_hash: (r.published_hash as string | null) ?? null,
      published_kids: json<string[]>(r.published_kids, []),
      publish_error: (r.publish_error as string | null) ?? null,
      checked_at: num(r.checked_at),
      check_state: (r.check_state as CheckState | null) ?? null,
      check_detail: (r.check_detail as string | null) ?? null,
      alerted_at: num(r.alerted_at),
      updated_by: (r.updated_by as string | null) ?? null,
      updated_at: Number(r.updated_at ?? 0)
    };
  }

  private async saveState(patch: Record<string, unknown>): Promise<void> {
    const now = Date.now();
    const moved = await this.db('cloud_issuer_state').where({ id: STATE_ID }).update({ ...patch, updated_at: now });
    if (!moved) {
      try {
        await this.db('cloud_issuer_state').insert({ id: STATE_ID, target: JSON.stringify({ kind: 'none' }), ...patch, updated_at: now });
      } catch {
        await this.db('cloud_issuer_state').where({ id: STATE_ID }).update({ ...patch, updated_at: now });
      }
    }
  }

  /** Sets where the documents go (references only; the values were vaulted by the caller) and publishes. */
  async setTarget(target: IssuerTarget, by: string | null): Promise<void> {
    await this.assertInstalled();
    await this.saveState({ target: JSON.stringify(targetSchema.parse(target)), updated_by: by, published_kids: JSON.stringify([]), published_hash: null, published_at: null, publish_error: null, check_state: null, check_detail: null });
  }

  private deps(): PublisherDeps {
    const s = this.s();
    const creds = this.creds();
    return {
      http: cloudHttp(s.cfg),
      readRef: (ref) => creds.vault.read(ref),
      awsKeys: async (accountId) => {
        const c = await creds.forId(accountId, 'deploy');
        if (c.kind !== 'aws') throw new CloudCallError('The S3 target\'s account is not an AWS account.', 422, 'wrong-provider');
        return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}) };
      },
      azureToken: async (accountId, scope) => {
        const c = await creds.forId(accountId, 'deploy');
        if (c.kind !== 'azure') throw new CloudCallError('The Azure Blob target\'s account is not an Azure account.', 422, 'wrong-provider');
        return (await c.getToken(scope)).token;
      }
    };
  }

  /** Writes the discovery document and the JWKS to the target. Failures are recorded and rethrown. */
  async publish(reason: string): Promise<{ published: boolean; kids: string[]; hash: string | null; target: IssuerTarget['kind'] }> {
    await this.assertInstalled();
    const st = await this.state();
    const jwks = await this.jwks();
    const jwksBody = JSON.stringify(jwks);
    const discoveryBody = JSON.stringify(this.discovery());
    const kids = jwks.keys.map((k) => String(k.kid));
    const hash = hashOf(`${discoveryBody}\n${jwksBody}`);
    const pub = publisherFor(st.target, this.url(), this.deps());
    if (!pub) return { published: false, kids: [], hash: null, target: 'none' };
    this.publishing = true;
    try {
      // JWKS first: a discovery document never names a key set that is not there yet.
      await pub.put(JWKS_NAME, jwksBody, 'application/jwk-set+json');
      await pub.put(DISCOVERY_NAME, discoveryBody, 'application/json');
    } catch (err) {
      await this.saveState({ publish_error: (err as Error).message.slice(0, 1000) });
      await this.auditSys('cloud.issuer.publish-failed', { target: st.target.kind, reason, error: (err as Error).message.slice(0, 300) });
      throw err;
    } finally {
      this.publishing = false;
    }
    await this.saveState({ published_at: Date.now(), published_hash: hash, published_kids: JSON.stringify(kids), publish_error: null });
    await this.auditSys('cloud.issuer.published', { target: st.target.kind, reason, kids, hash });
    return { published: true, kids, hash, target: st.target.kind };
  }

  private async auditSys(action: string, detail: Record<string, unknown>): Promise<void> {
    const tenantId = await platformTenant(this.s());
    if (!tenantId) return;
    await this.s().audit.append({ tenantId, action, kind: 'system', actor: { service: 'cloud.issuer' }, target: { issuer: this.url() }, detail });
  }

  /**
   * Rotates the issuer key of one algorithm: a new key is published at once and starts signing once the published
   * JWKS holds it and the lead time has passed. `immediate` (a suspected compromise) signs with it now and retires the
   * current key, which stays published for the session window.
   */
  async rotate(o: { alg?: IssuerAlg; immediate?: boolean; by?: string | null } = {}): Promise<{ next: IssuerKeyRow; previous: string | null; published: boolean; publishError: string | null }> {
    await this.assertInstalled();
    const alg = o.alg ?? 'ES256';
    const current = (await this.keys(alg)).find((k) => k.state === 'signing') ?? null;
    await this.db('cloud_issuer_keys').where({ alg, state: 'next' }).delete();
    // Never `signing` at once unless immediate: it starts signing in `advance`, once the published JWKS holds it.
    const at = o.immediate || !current ? Date.now() - 1 : Date.now() + Math.max(1, this.cfg.CLOUD_ISSUER_PUBLISH_LEAD_MINUTES * MIN);
    const next = await this.insert(alg, at);
    if (next.state === 'signing' && current) await this.retire([current.kid]);
    let published = false;
    let publishError: string | null = null;
    try {
      published = (await this.publish(o.immediate ? 'rotation (immediate)' : 'rotation')).published;
    } catch (err) {
      publishError = (err as Error).message;
    }
    const tenantId = await platformTenant(this.s());
    if (tenantId) await this.s().audit.append({ tenantId, action: 'cloud.issuer.rotated', kind: 'admin', actor: o.by ? { user: o.by } : { service: 'cloud.issuer' }, target: { issuer: this.url(), kid: next.kid }, label: 'restricted', detail: { alg, previous: current?.kid ?? null, immediate: !!o.immediate, activatesAt: next.activates_at, published } });
    return { next, previous: current?.kid ?? null, published, publishError };
  }

  /** Scheduled: a rotation that is due is started (published ahead of signing). */
  async scheduled(): Promise<{ rotated: string[] }> {
    const out: string[] = [];
    if (!(await this.installed()) || this.cfg.CLOUD_ISSUER_ROTATION_DAYS <= 0) return { rotated: out };
    if (!(await this.db('cloud_issuer_keys').first('kid'))) return { rotated: out }; // never used: nothing to rotate
    for (const alg of this.algs()) {
      const keys = await this.keys(alg);
      const signing = keys.find((k) => k.state === 'signing');
      if (!signing || keys.some((k) => k.state === 'next')) continue;
      if (Date.now() >= signing.activates_at + this.cfg.CLOUD_ISSUER_ROTATION_DAYS * 86_400_000) out.push((await this.rotate({ alg })).next.kid);
    }
    return { rotated: out };
  }

  /**
   * The check job: what is published at the issuer URL against what should be. A key set that lacks a key the
   * issuer signs with (or will soon), or holds one it does not, is a mismatch and raises an alert (a notice to the
   * platform admins and an audit entry), once per change. A JWKS that only differs because a retired key has left
   * the window is republished first.
   */
  async check(): Promise<{ state: CheckState; detail: string; missing: string[]; extra: string[] }> {
    await this.assertInstalled();
    let st = await this.state();
    const expected = await this.jwks();
    const want = expected.keys.map((k) => String(k.kid));
    if (st.target.kind === 'none') {
      const detail = 'No publication target is set, so clouds cannot fetch the issuer\'s keys.';
      await this.saveState({ checked_at: Date.now(), check_state: 'unpublished', check_detail: detail });
      return { state: 'unpublished', detail, missing: want, extra: [] };
    }
    const expectedHash = hashOf(`${JSON.stringify(this.discovery())}\n${JSON.stringify(expected)}`);
    if (st.target.kind !== 'console' && st.published_hash !== expectedHash) {
      try {
        await this.publish('check');
      } catch {
        /* recorded; the comparison below reports what is out there */
      }
      st = await this.state();
    }
    let state: CheckState;
    let detail: string;
    let missing: string[] = [];
    let extra: string[] = [];
    try {
      const http = cloudHttp(this.cfg);
      const disc = await http.request({ method: 'GET', url: `${this.url()}/${DISCOVERY_NAME}`, headers: { accept: 'application/json' } });
      if (disc.status !== 200) throw new Error(`the discovery document answered HTTP ${disc.status}`);
      const d = JSON.parse(disc.body.toString('utf8')) as Record<string, unknown>;
      if (d.issuer !== this.url()) throw new Error(`the published discovery document names the issuer ${String(d.issuer).slice(0, 200)}`);
      const jwksUri = typeof d.jwks_uri === 'string' ? d.jwks_uri : `${this.url()}/${JWKS_NAME}`;
      const res = await http.request({ method: 'GET', url: jwksUri, headers: { accept: 'application/json' } });
      if (res.status !== 200) throw new Error(`the JWKS answered HTTP ${res.status}`);
      const got = canonicalJwks(((JSON.parse(res.body.toString('utf8')) as { keys?: Jwk[] }).keys ?? []).filter((k) => k && typeof k === 'object'));
      const gotByKid = new Map(got.keys.map((k) => [String(k.kid), JSON.stringify(k)]));
      const wantByKid = new Map(expected.keys.map((k) => [String(k.kid), JSON.stringify(k)]));
      missing = [...wantByKid.keys()].filter((k) => gotByKid.get(k) !== wantByKid.get(k));
      extra = [...gotByKid.keys()].filter((k) => !wantByKid.has(k));
      state = missing.length || extra.length ? 'mismatch' : 'ok';
      detail = state === 'ok' ? `The published JWKS matches the issuer's ${want.length} key${want.length === 1 ? '' : 's'}.` : `The published JWKS is stale: ${missing.length ? `missing or different ${missing.join(', ')}` : ''}${missing.length && extra.length ? '; ' : ''}${extra.length ? `not the issuer's ${extra.join(', ')}` : ''}.`;
    } catch (err) {
      state = 'error';
      detail = `The published documents could not be read: ${(err as Error).message.slice(0, 300)}.`;
    }
    const changed = state !== st.check_state || detail !== st.check_detail;
    await this.saveState({ checked_at: Date.now(), check_state: state, check_detail: detail.slice(0, 1000), ...(state !== 'ok' && changed ? { alerted_at: Date.now() } : {}) });
    if (state !== 'ok' && changed) await this.alert(state, detail);
    return { state, detail, missing, extra };
  }

  private async alert(state: CheckState, detail: string): Promise<void> {
    const s = this.s();
    const tenantId = await platformTenant(s);
    if (!tenantId) return;
    await s.audit.append({ tenantId, action: 'cloud.issuer.mismatch', kind: 'system', actor: { service: 'cloud.issuer' }, target: { issuer: this.url() }, label: 'internal', detail: { state, detail } });
    const userIds = await s.cloud.accounts.cloudAdmins(tenantId, true);
    if (userIds.length) await s.notifications.notify({ tenantId, userIds, kind: 'security', title: state === 'mismatch' ? 'The published cloud issuer keys are stale' : 'The published cloud issuer documents cannot be read', body: `${detail} Federated cloud accounts may fail to get sessions until it is published again (Cloud, Federation issuer, Publish now).`, label: 'internal', email: true }).catch(() => undefined);
  }

  /** The status view: no private material, only kids, custody, dates and the publication's state. */
  async status() {
    const installed = await this.installed();
    const st = await this.state();
    const keys = installed ? await this.keys() : [];
    return {
      installed,
      issuer: this.url(),
      consoleIssuer: (this.cfg.FEDERATION_ISSUER ?? this.cfg.PUBLIC_URL).replace(/\/+$/, ''),
      algs: this.algs(),
      azureAlg: this.cfg.CLOUD_AZURE_SIGNING_ALG,
      custody: this.custody(),
      keys: keys.map((k) => ({ kid: k.kid, alg: k.alg, state: k.state, custody: custodyOfRef(k.private_ref), createdAt: k.created_at, activatesAt: k.activates_at, retiresAt: k.retires_at, removesAt: k.removes_at, published: st.target.kind === 'console' || st.published_kids.includes(k.kid) })),
      target: st.target,
      publication: { at: st.published_at, hash: st.published_hash, kids: st.published_kids, error: st.publish_error },
      check: { at: st.checked_at, state: st.check_state, detail: st.check_detail, alertedAt: st.alerted_at },
      documents: { discovery: `${this.url()}/${DISCOVERY_NAME}`, jwks: `${this.url()}/${JWKS_NAME}` }
    };
  }
}
