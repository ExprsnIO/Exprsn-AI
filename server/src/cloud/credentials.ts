import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { ulid } from 'ulid';
import { b64u } from '../federation/jose.js';
import { HttpProblem } from '../http/problem.js';
import { platformTenant } from '../ops/common.js';
import type { KeyRef } from '../pki/keys.js';
import type { PkiActor } from '../pki/service.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { parseVaultRef } from '../vault/policy.js';
import { assumeRoleWithWebIdentity, createAccessKey, deleteAccessKey, getCallerIdentity, iamUserOf, type AwsKeys } from './aws-calls.js';
import { addPassword, AZURE_SCOPES, entraToken, listPasswords, removePassword, tokenEndpoint, type EntraToken } from './azure-calls.js';
import { accountPath, CLOUD_KV_ROOT, CloudVault } from './cloud-vault.js';
import { CloudCallError, cloudHttp, type CloudHttp } from './credential-http.js';
import { AWS_AUDIENCE, AZURE_AUDIENCE, CloudIssuer } from './issuer.js';
import type { CloudAccount, CloudCredentialRef, CredentialPurpose, Provider } from './types.js';

/*
 * 1.9.99-final, Sprint 56 (B-10003, B-10004, B-10006): `s.cloud.credentials`. `for(account, purpose)` buys what a
 * provider adapter needs to call the cloud, chosen by the account's credential mode:
 *
 *   AWS federated   a token from the cloud issuer (`cloud/issuer.ts`) → STS AssumeRoleWithWebIdentity → a session
 *                   (CLOUD_SESSION_SECONDS, one hour by default) for the purpose's role (`readRoleArn`,
 *                   `deployRoleArn`, `billingRoleArn`, else `roleArn`), cached per instance and refreshed at two
 *                   thirds of its life. No long-lived AWS key exists anywhere for such an account.
 *   AWS vaulted     the access key pair behind the account's `vault:` references, rotated automatically.
 *   Azure           `getToken(scope)`: an Entra token bought with a client assertion (federated: a token from the
 *                   issuer for `api://AzureADTokenExchange`; certificate: a JWT signed by the certificate's key in
 *                   the signer or transit) or a vaulted client secret; cached per scope, refreshed at two thirds.
 *                   The scopes a purpose may ask for are `PURPOSE_SCOPES`.
 *   DigitalOcean,   the vaulted token (and the provider's account id); a person replaces it, after a notice before it
 *   Cloudflare      expires.
 *
 * Values are only ever in the returned objects and the per-instance cache: never in a row, a log line, an audit entry
 * or a route's answer. A credential change or a rotation drops every instance's cache over the bus.
 */

export type { CredentialPurpose };

export type ProviderCredential =
  | { kind: 'aws'; accessKeyId: string; secretAccessKey: string; sessionToken?: string; /** Null for a long-lived vaulted key. */ expiresAt: number | null }
  | { kind: 'azure'; tenantId: string; getToken(scope: string): Promise<{ token: string; expiresAt: number }> }
  | { kind: 'token'; token: string; accountId?: string };

/** The Entra scopes each purpose may ask for. Cost Management is read under the ARM scope. */
export const PURPOSE_SCOPES: Record<CredentialPurpose, readonly string[]> = {
  validate: [AZURE_SCOPES.arm],
  // 1.9.99-final (B-10306): the Cosmos DB data plane and Entra tokens for Azure PostgreSQL connections are reads too.
  read: [AZURE_SCOPES.arm, AZURE_SCOPES.cognitive, AZURE_SCOPES.aks, AZURE_SCOPES.cosmos, AZURE_SCOPES.ossrdbms],
  deploy: [AZURE_SCOPES.arm, AZURE_SCOPES.cognitive, AZURE_SCOPES.storage, AZURE_SCOPES.aks],
  billing: [AZURE_SCOPES.arm]
};

export const AWS_ROLE_PARAM: Record<CredentialPurpose, string> = { validate: 'readRoleArn', read: 'readRoleArn', deploy: 'deployRoleArn', billing: 'billingRoleArn' };

const TOPIC = 'cloud.credentials';
const MIN = 60_000;
const DAY = 86_400_000;
/** Vaulted values are kept in memory this long at most, so a rotated key is in use within a minute everywhere. */
const VAULTED_TTL_MS = 50_000;

export type CredentialKind = 'federated' | 'aws-keys' | 'azure-secret' | 'azure-certificate' | 'token';

interface StateRow {
  account_id: string;
  kind: CredentialKind;
  last_used_at: number | null;
  last_used_purpose: string | null;
  rotated_at: number | null;
  rotation_state: 'idle' | 'overlap' | 'failed';
  previous: Record<string, string> | null;
  overlap_until: number | null;
  expires_at: number | null;
  notice_stage: 'due' | 'expired' | null;
  notice_for: number | null;
  last_error: string | null;
  updated_at: number;
}

interface Cached<T> {
  value: T;
  refreshAt: number;
  expiresAt: number;
}

/** The stored certificate credential (B-10006): the certificate (public) and the key's custody reference (opaque). */
interface CertificateDoc {
  certificatePem: string;
  key: KeyRef;
}

const kindOf = (provider: Provider, cred: CloudCredentialRef): CredentialKind => {
  if (cred.mode === 'federated') return 'federated';
  if (provider === 'aws') return 'aws-keys';
  if (provider === 'azure') return cred.refs.certificate ? 'azure-certificate' : 'azure-secret';
  return 'token';
};

const sessionName = (account: CloudAccount, purpose: string): string => `exprsn-${account.name}-${purpose}`.replace(/[^\w+=,.@-]/g, '-').slice(0, 64);
const num = (v: unknown): number | null => (v == null ? null : Number(v));

/** A provider refusal as a problem: 403 for a refused trust or secret, 502 when the provider could not be reached. */
const problemOf = (err: unknown, what: string): HttpProblem => {
  if (err instanceof HttpProblem) return err;
  if (err instanceof CloudCallError) return new HttpProblem([403, 409, 422, 503].includes(err.status) ? err.status : 502, err.status === 403 ? 'Forbidden' : err.status === 503 ? 'Not available' : err.status === 502 ? 'Bad gateway' : 'Unprocessable', `${what}: ${err.message}`, { extensions: { reason: 'cloud_credential', provider_code: err.code } });
  return new HttpProblem(502, 'Bad gateway', `${what}: ${(err as Error).message}`, { extensions: { reason: 'cloud_credential' } });
};

export class CloudCredentials {
  readonly vault: CloudVault;
  readonly issuer: CloudIssuer;
  private readonly sessions = new Map<string, Cached<ProviderCredential>>();
  private readonly tokens = new Map<string, Cached<EntraToken>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly lastUseWritten = new Map<string, number>();
  private installedAt = 0;
  private installedOk = false;
  private listening = false;

  constructor(private readonly s: () => Services) {
    this.vault = new CloudVault(s);
    this.issuer = new CloudIssuer(s, () => this);
  }

  private get cfg() {
    return this.s().cfg;
  }

  private http(): CloudHttp {
    return cloudHttp(this.cfg);
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    this.s().bus.on(TOPIC, (m: { accountId?: string }) => this.drop(m?.accountId ?? null));
  }

  /** Forgets the cached sessions, tokens and values of an account (or of all), on this instance. */
  drop(accountId: string | null): void {
    for (const map of [this.sessions, this.tokens] as Map<string, unknown>[]) for (const k of [...map.keys()]) if (!accountId || k.startsWith(`${accountId}|`)) map.delete(k);
  }

  /** Every instance forgets an account's credential (a change, a rotation, a removal). */
  changed(accountId: string): void {
    this.drop(accountId);
    this.s().bus.publish(TOPIC, { accountId });
  }

  private async installed(): Promise<boolean> {
    if (this.installedOk || Date.now() - this.installedAt < MIN) return this.installedOk;
    this.installedAt = Date.now();
    this.installedOk = await this.s().db.schema.hasTable('cloud_credential_state');
    return this.installedOk;
  }

  // ---------- for(account, purpose) ----------

  /** The credential for an account and purpose (the adapters' one entry point). */
  async for(account: CloudAccount, purpose: CredentialPurpose): Promise<ProviderCredential> {
    this.listen();
    if (account.state === 'disabled') throw new HttpProblem(409, 'Conflict', `${account.name} is disabled, so its credential is not used.`, { extensions: { reason: 'account_disabled' } });
    if (account.state === 'pending' && purpose !== 'validate') throw new HttpProblem(409, 'Conflict', `${account.name} waits for a second cloud admin's approval; until then it is used only to validate.`, { extensions: { reason: 'account_pending' } });
    const cred = await this.s().cloud.accounts.credentialRef(account.id);
    if (!cred) throw new HttpProblem(409, 'Conflict', `${account.name} has no credential yet.`, { extensions: { reason: 'no_credential' } });
    if (cred.mode !== account.credentialMode) throw new HttpProblem(409, 'Conflict', `${account.name}'s credential is ${cred.mode} but the account says ${account.credentialMode}; a change is waiting for approval.`, { extensions: { reason: 'mode_mismatch' } });
    let out: ProviderCredential;
    try {
      out = await this.build(account, cred, purpose);
    } catch (err) {
      throw problemOf(err, `The ${purpose} credential of ${account.name} could not be obtained`);
    }
    await this.recordUse(account, cred, purpose);
    return out;
  }

  /** `for` by account id (the issuer's publishers use it). */
  async forId(accountId: string, purpose: CredentialPurpose): Promise<ProviderCredential> {
    const a = await this.s().cloud.accounts.get(accountId);
    if (!a) throw new HttpProblem(404, 'Not found', 'Cloud account not found.');
    return this.for(a, purpose);
  }

  private async build(account: CloudAccount, cred: CloudCredentialRef, purpose: CredentialPurpose): Promise<ProviderCredential> {
    switch (account.provider) {
      case 'aws':
        return cred.mode === 'federated' ? this.awsFederated(account, cred, purpose) : this.awsVaulted(account, cred);
      case 'azure':
        return this.azure(account, cred, purpose);
      case 'digitalocean':
      case 'cloudflare': {
        const token = await this.cachedValue(account, 'token', () => this.resolve(account, cred, cred.refs.token!));
        const providerAccount = account.provider === 'cloudflare' ? account.providerIds.cloudflareAccountId : account.providerIds.doTeamId;
        return { kind: 'token', token, ...(providerAccount ? { accountId: providerAccount } : {}) };
      }
    }
  }

  /** The role a purpose assumes: its own ARN when the account names one, else the account's one role. */
  roleFor(cred: CloudCredentialRef, purpose: CredentialPurpose): string {
    const arn = cred.params[AWS_ROLE_PARAM[purpose]] ?? cred.params.roleArn;
    if (!arn) throw new HttpProblem(409, 'Conflict', `No role is set for ${purpose} (roleArn or ${AWS_ROLE_PARAM[purpose]}).`);
    return arn;
  }

  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async awsFederated(account: CloudAccount, cred: CloudCredentialRef, purpose: CredentialPurpose): Promise<ProviderCredential> {
    const roleArn = this.roleFor(cred, purpose);
    const key = `${account.id}|aws|${roleArn}`;
    const hit = this.sessions.get(key);
    const now = Date.now();
    if (hit && now < hit.refreshAt) return hit.value;
    return this.once(key, async () => {
      const { token } = await this.issuer.mint(account.id, AWS_AUDIENCE);
      const session = await assumeRoleWithWebIdentity(this.http(), this.cfg.CLOUD_AWS_STS_URL, { roleArn, token, sessionName: sessionName(account, purpose), durationSeconds: this.cfg.CLOUD_SESSION_SECONDS });
      const issued = Date.now();
      const value: ProviderCredential = { kind: 'aws', accessKeyId: session.accessKeyId, secretAccessKey: session.secretAccessKey, sessionToken: session.sessionToken, expiresAt: session.expiresAt };
      this.sessions.set(key, { value, refreshAt: issued + Math.floor(((session.expiresAt - issued) * 2) / 3), expiresAt: session.expiresAt });
      return value;
    });
  }

  private async awsVaulted(account: CloudAccount, cred: CloudCredentialRef): Promise<ProviderCredential> {
    const keys = await this.awsKeys(account, cred);
    return { kind: 'aws', accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey, expiresAt: null };
  }

  private async awsKeys(account: CloudAccount, cred: CloudCredentialRef): Promise<AwsKeys> {
    const accessKeyId = await this.cachedValue(account, 'accessKeyId', () => this.resolve(account, cred, cred.refs.accessKeyId!));
    const secretAccessKey = await this.cachedValue(account, 'secretAccessKey', () => this.resolve(account, cred, cred.refs.secretAccessKey!));
    return { accessKeyId, secretAccessKey };
  }

  private async cachedValue(account: CloudAccount, field: string, read: () => Promise<string>): Promise<string> {
    const key = `${account.id}|value|${field}`;
    const hit = this.sessions.get(key);
    if (hit && Date.now() < hit.refreshAt) return (hit.value as { token: string }).token;
    return this.once(key, async () => {
      const v = await read();
      this.sessions.set(key, { value: { kind: 'token', token: v }, refreshAt: Date.now() + VAULTED_TTL_MS, expiresAt: Date.now() + VAULTED_TTL_MS });
      return v;
    });
  }

  private azure(account: CloudAccount, cred: CloudCredentialRef, purpose: CredentialPurpose): ProviderCredential {
    const tenantId = account.providerIds.azureTenantId;
    const clientId = cred.params.clientId;
    if (!tenantId || !clientId) throw new HttpProblem(409, 'Conflict', `${account.name} needs its Entra tenant id and the client id.`);
    const allowed = PURPOSE_SCOPES[purpose];
    return {
      kind: 'azure',
      tenantId,
      getToken: async (scope: string) => {
        if (!allowed.includes(scope)) throw new HttpProblem(403, 'Forbidden', `A ${purpose} credential does not hand out tokens for ${scope}.`, { extensions: { reason: 'scope_not_allowed', allowed } });
        try {
          return await this.azureToken(account, cred, scope);
        } catch (err) {
          throw problemOf(err, `An Entra token for ${account.name} could not be obtained`);
        }
      }
    };
  }

  private async azureToken(account: CloudAccount, cred: CloudCredentialRef, scope: string): Promise<EntraToken> {
    const key = `${account.id}|azure|${scope}`;
    const hit = this.tokens.get(key);
    if (hit && Date.now() < hit.refreshAt) return hit.value;
    return this.once(key, async () => {
      const t = await this.entra(account, cred, scope);
      const issued = Date.now();
      this.tokens.set(key, { value: t, refreshAt: issued + Math.floor(((t.expiresAt - issued) * 2) / 3), expiresAt: t.expiresAt });
      return t;
    });
  }

  /** One Entra token, by the account's kind of credential. */
  private async entra(account: CloudAccount, cred: CloudCredentialRef, scope: string, secretOverride?: string): Promise<EntraToken> {
    const tenantId = account.providerIds.azureTenantId!;
    const clientId = cred.params.clientId!;
    const authority = this.cfg.CLOUD_AZURE_AUTHORITY;
    if (secretOverride) return entraToken(this.http(), authority, { tenantId, clientId, scope, secret: secretOverride });
    if (cred.mode === 'federated') {
      const { token } = await this.issuer.mint(account.id, AZURE_AUDIENCE);
      return entraToken(this.http(), authority, { tenantId, clientId, scope, assertion: token });
    }
    if (cred.refs.certificate) {
      const doc = JSON.parse(await this.resolve(account, cred, cred.refs.certificate)) as CertificateDoc;
      return entraToken(this.http(), authority, { tenantId, clientId, scope, assertion: await this.certificateAssertion(doc, tenantId, clientId) });
    }
    const secret = await this.cachedValue(account, 'clientSecret', () => this.resolve(account, cred, cred.refs.clientSecret!));
    return entraToken(this.http(), authority, { tenantId, clientId, scope, secret });
  }

  /** A client assertion signed with the certificate's key, which stays in the signer or transit (RS256, x5t). */
  private async certificateAssertion(doc: CertificateDoc, tenantId: string, clientId: string): Promise<string> {
    const der = new X509Certificate(doc.certificatePem).raw;
    const header = { alg: 'RS256', typ: 'JWT', x5t: b64u(createHash('sha1').update(der).digest()), 'x5t#S256': b64u(createHash('sha256').update(der).digest()) };
    const now = Math.floor(Date.now() / 1000);
    const claims = { aud: tokenEndpoint(this.cfg.CLOUD_AZURE_AUTHORITY, tenantId), iss: clientId, sub: clientId, jti: b64u(randomBytes(16)), nbf: now - 5, iat: now, exp: now + 300 };
    const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
    const sig = await this.s().pki.keys.signRaw(doc.key, Buffer.from(input));
    return `${input}.${b64u(sig)}`;
  }

  // ---------- references ----------

  /** Is this `cloud/` path the account's own, or staged for its scope? */
  private owns(account: Pick<CloudAccount, 'id' | 'tenantId'>, path: string): boolean {
    const own = accountPath(account.id);
    return path === own || path.startsWith(`${own}/`) || path.startsWith(`${CLOUD_KV_ROOT}/secrets/${this.scopeKey(account)}/`);
  }

  /** The scope key a cloud secret of this account must sit under. */
  private scopeKey(account: Pick<CloudAccount, 'tenantId'>): string {
    return (account.tenantId ?? 'platform').toLowerCase();
  }

  /**
   * One value behind a reference of the account's credential. A `vault:cloud/...` reference is read by the cloud
   * service in the platform scope, and only from the account's own path or one staged for its scope (so a tenant
   * cannot point its account at another's key); any other reference resolves as the person who saved the credential,
   * under their vault policy (B-1705).
   */
  async resolve(account: CloudAccount, cred: CloudCredentialRef, ref: string): Promise<string> {
    const parsed = parseVaultRef(ref);
    if (parsed && (parsed.path === CLOUD_KV_ROOT || parsed.path.startsWith(`${CLOUD_KV_ROOT}/`))) {
      const ok = this.owns(account, parsed.path);
      if (!ok) throw new HttpProblem(403, 'Forbidden', `${ref.slice(0, 120)} does not belong to ${account.name}.`, { extensions: { step: 'vault-owner' } });
      return this.vault.read(ref);
    }
    const s = this.s();
    const row = (await s.db('cloud_credentials').where({ account_id: account.id }).first('updated_by')) as { updated_by: string | null } | undefined;
    const owner = row?.updated_by ?? account.createdBy;
    const tenantId = account.tenantId ?? (await platformTenant(s));
    if (!tenantId) throw new HttpProblem(503, 'Unavailable', 'The platform tenant is missing.');
    return s.vault.resolveFor(tenantId, owner, ref, { via: 'cloud.credentials' });
  }

  /**
   * Stores secret values in the vault and returns their references (B-10006): at `cloud/accounts/<id>` for an
   * existing account, else staged under the scope at `cloud/secrets/<scope>/<id>`, to be named in an account's
   * credential. The values are never returned.
   */
  async store(o: { scope: 'platform' | 'tenant'; tenantId: string | null; accountId?: string; values: Record<string, string>; by: string | null; expiresAt?: number | null }): Promise<{ path: string; version: number; refs: Record<string, string> }> {
    const path = o.accountId ? accountPath(o.accountId) : `${CLOUD_KV_ROOT}/secrets/${(o.scope === 'platform' ? 'platform' : o.tenantId!).toLowerCase()}/${ulid().toLowerCase()}`;
    const out = await this.vault.write(path, o.values);
    if (o.accountId) {
      this.changed(o.accountId);
      if (await this.installed()) await this.patchState(o.accountId, { expires_at: o.expiresAt ?? null, notice_stage: null, notice_for: null, rotation_state: 'idle', last_error: null, rotated_at: Date.now() });
    }
    const tenantId = o.tenantId ?? (await platformTenant(this.s()));
    if (tenantId) await this.s().audit.append({ tenantId, action: 'cloud.credential.stored', kind: 'admin', actor: o.by ? { user: o.by } : { service: 'cloud.credentials' }, target: { path, ...(o.accountId ? { account: o.accountId } : {}) }, label: 'restricted', detail: { keys: Object.keys(o.values).sort(), version: out.version } });
    return { path, version: out.version, refs: out.refs };
  }

  /** Writes new values to the place the account's references already point at (a guided replace or a rotation). */
  async replace(account: CloudAccount, values: Record<string, string>, by: string | null, expiresAt: number | null = null): Promise<{ version: number; refs: Record<string, string>; refsChanged: boolean }> {
    const cred = await this.s().cloud.accounts.credentialRef(account.id);
    if (!cred || cred.mode !== 'vaulted') throw new HttpProblem(409, 'Conflict', `${account.name} has no vaulted credential to replace.`);
    for (const k of Object.keys(values)) if (!(k in cred.refs) && !(k === 'keyId' && cred.refs.clientSecret)) throw new HttpProblem(400, 'Bad request', `${account.name}'s credential has no secret ${k}.`);
    const paths = new Set(Object.entries(cred.refs).filter(([k]) => k in values).map(([, r]) => parseVaultRef(r)?.path ?? ''));
    const single = paths.size === 1 ? [...paths][0]! : null;
    const writable = single && this.owns(account, single);
    const path = writable ? single : accountPath(account.id);
    // The other values in the same secret (an access key id beside its secret, a Graph key id) are kept.
    let keep: Record<string, string> = {};
    if (writable) {
      try {
        keep = await this.vault.readAll(path);
      } catch {
        keep = {};
      }
    }
    const out = await this.vault.write(path, { ...keep, ...values });
    let refsChanged = false;
    if (!writable) {
      const refs = { ...cred.refs, ...Object.fromEntries(Object.keys(values).filter((k) => k in cred.refs).map((k) => [k, `vault:${path}#${k}`])) };
      await this.s().db('cloud_credentials').where({ account_id: account.id }).update({ refs: JSON.stringify(refs), updated_at: Date.now() });
      refsChanged = true;
    }
    this.changed(account.id);
    if (await this.installed()) await this.patchState(account.id, { kind: kindOf(account.provider, cred), expires_at: expiresAt, notice_stage: null, notice_for: null, last_error: null, rotated_at: Date.now() });
    await this.auditAccount(account, 'cloud.credential.replaced', by, { keys: Object.keys(values).filter((k) => k !== 'keyId').sort(), version: out.version, moved: refsChanged });
    return { version: out.version, refs: refsChanged ? Object.fromEntries(Object.keys(values).map((k) => [k, `vault:${path}#${k}`])) : Object.fromEntries(Object.keys(values).map((k) => [k, cred.refs[k] ?? `vault:${path}#${k}`])), refsChanged };
  }

  // ---------- state, last use ----------

  async state(accountId: string): Promise<StateRow | null> {
    if (!(await this.installed())) return null;
    const r = (await this.s().db('cloud_credential_state').where({ account_id: accountId }).first()) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      account_id: accountId,
      kind: r.kind as CredentialKind,
      last_used_at: num(r.last_used_at),
      last_used_purpose: (r.last_used_purpose as string | null) ?? null,
      rotated_at: num(r.rotated_at),
      rotation_state: (r.rotation_state as StateRow['rotation_state']) ?? 'idle',
      previous: r.previous ? (JSON.parse(String(r.previous)) as Record<string, string>) : null,
      overlap_until: num(r.overlap_until),
      expires_at: num(r.expires_at),
      notice_stage: (r.notice_stage as StateRow['notice_stage']) ?? null,
      notice_for: num(r.notice_for),
      last_error: (r.last_error as string | null) ?? null,
      updated_at: Number(r.updated_at)
    };
  }

  private async patchState(accountId: string, patch: Partial<Omit<StateRow, 'previous'>> & { previous?: Record<string, string> | null }): Promise<void> {
    const db = this.s().db;
    const row: Record<string, unknown> = { ...patch, updated_at: Date.now() };
    if ('previous' in patch) row.previous = patch.previous ? JSON.stringify(patch.previous) : null;
    const moved = await db('cloud_credential_state').where({ account_id: accountId }).update(row);
    if (!moved) {
      try {
        await db('cloud_credential_state').insert({ account_id: accountId, kind: 'token', rotation_state: 'idle', ...row });
      } catch {
        await db('cloud_credential_state').where({ account_id: accountId }).update(row);
      }
    }
  }

  private async recordUse(account: CloudAccount, cred: CloudCredentialRef, purpose: CredentialPurpose): Promise<void> {
    const last = this.lastUseWritten.get(account.id) ?? 0;
    if (Date.now() - last < MIN || !(await this.installed())) return;
    this.lastUseWritten.set(account.id, Date.now());
    await this.patchState(account.id, { kind: kindOf(account.provider, cred), last_used_at: Date.now(), last_used_purpose: purpose }).catch((err: Error) => this.s().log.warn({ err: err.message }, 'cloud credential last use not recorded'));
  }

  /** What the console shows of a credential: mode, kind, references' presence, last use, rotation, expiry. Never values. */
  async describe(account: CloudAccount) {
    const cred = await this.s().cloud.accounts.credentialRef(account.id);
    const st = await this.state(account.id);
    const kind = cred ? kindOf(account.provider, cred) : null;
    return {
      accountId: account.id,
      mode: cred?.mode ?? account.credentialMode,
      kind,
      secrets: cred ? Object.keys(cred.refs).sort() : [],
      roles: cred && account.provider === 'aws' && cred.mode === 'federated' ? Object.fromEntries((['read', 'deploy', 'billing'] as const).map((p) => [p, this.roleFor(cred, p)])) : null,
      lastUsedAt: st?.last_used_at ?? null,
      lastUsedPurpose: st?.last_used_purpose ?? null,
      rotation: {
        automatic: kind === 'aws-keys' ? this.cfg.CLOUD_AWS_KEY_ROTATION_DAYS > 0 : kind === 'azure-secret',
        by: kind === 'aws-keys' ? 'IAM (create, verify, switch, delete)' : kind === 'azure-secret' ? 'Microsoft Graph addPassword/removePassword, else notices' : kind === 'token' ? 'a person, after a notice' : kind === 'federated' ? 'not needed: sessions last an hour' : 'the certificate is renewed by a person',
        state: st?.rotation_state ?? 'idle',
        rotatedAt: st?.rotated_at ?? null,
        overlapUntil: st?.overlap_until ?? null,
        lastError: st?.last_error ?? null
      },
      expiresAt: st?.expires_at ?? null,
      notice: st?.notice_stage ?? null
    };
  }

  private async auditAccount(account: CloudAccount, action: string, by: string | null, detail: Record<string, unknown>): Promise<void> {
    const tenantId = account.tenantId ?? (await platformTenant(this.s()));
    if (!tenantId) return;
    await this.s().audit.append({ tenantId, action, kind: by ? 'admin' : 'system', actor: by ? { user: by } : { service: 'cloud.credentials' }, target: { account: account.id, name: account.name, provider: account.provider }, label: 'restricted', detail });
  }

  private async tell(account: CloudAccount, title: string, body: string): Promise<void> {
    const s = this.s();
    const tenantId = account.tenantId ?? (await platformTenant(s));
    if (!tenantId) return;
    const userIds = await s.cloud.accounts.cloudAdmins(tenantId, account.scope === 'platform');
    if (userIds.length) await s.notifications.notify({ tenantId, userIds, kind: 'vault', title, body, route: 'cloud', label: 'internal', email: true }).catch((err: unknown) => s.log.warn({ err }, 'cloud credential notice failed'));
  }

  // ---------- rotation (B-10006) ----------

  /**
   * AWS: a new key is created for the key's own IAM user, checked with GetCallerIdentity (retried while IAM makes it
   * visible), written to the vault and switched to on every instance at once; the old key is deleted when the overlap
   * (CLOUD_AWS_KEY_OVERLAP_MINUTES) ends. Azure: a new client secret through Graph addPassword, checked by buying a
   * token with it, switched to, and the old one removed with removePassword after the overlap.
   */
  async rotate(account: CloudAccount, by: string | null = null): Promise<{ rotated: boolean; overlapUntil: number | null; detail: string }> {
    const cred = await this.s().cloud.accounts.credentialRef(account.id);
    if (!cred || cred.mode !== 'vaulted') throw new HttpProblem(409, 'Conflict', `${account.name} has no vaulted credential to rotate; a federated account needs none.`);
    const kind = kindOf(account.provider, cred);
    if (kind !== 'aws-keys' && kind !== 'azure-secret') throw new HttpProblem(409, 'Conflict', kind === 'token' ? `A ${account.provider === 'cloudflare' ? 'Cloudflare' : 'DigitalOcean'} token is replaced by a person: create a new one with the same permissions and replace it here.` : 'A certificate credential is renewed by issuing a new certificate.');
    const st = await this.state(account.id);
    if (st?.rotation_state === 'overlap') throw new HttpProblem(409, 'Conflict', `A rotation of ${account.name} is in its overlap until ${new Date(st.overlap_until ?? 0).toISOString()}; the old ${kind === 'aws-keys' ? 'key' : 'secret'} is deleted first.`);
    try {
      return kind === 'aws-keys' ? await this.rotateAws(account, cred, by) : await this.rotateAzure(account, cred, by);
    } catch (err) {
      const msg = (err as Error).message.slice(0, 1000);
      if (await this.installed()) await this.patchState(account.id, { kind, rotation_state: 'failed', last_error: msg });
      await this.auditAccount(account, 'cloud.credential.rotation-failed', by, { error: msg.slice(0, 300) });
      throw problemOf(err, `Rotating ${account.name}'s credential failed`);
    }
  }

  private async rotateAws(account: CloudAccount, cred: CloudCredentialRef, by: string | null) {
    const http = this.http();
    const { CLOUD_AWS_STS_URL: sts, CLOUD_AWS_IAM_URL: iam } = this.cfg;
    const old = await this.awsKeys(account, cred);
    const me = await getCallerIdentity(http, sts, old);
    const user = iamUserOf(me.arn);
    if (!user) throw new CloudCallError(`The vaulted key belongs to ${me.arn ?? 'an unknown principal'}, not an IAM user, so it cannot be rotated through IAM.`, 422, 'not-a-user');
    const fresh = await createAccessKey(http, iam, old, user);
    let verified = false;
    let lastErr: unknown = null;
    for (let i = 0; i < 6 && !verified; i++) {
      try {
        const who = await getCallerIdentity(http, sts, fresh);
        verified = who.arn === me.arn;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, Math.min(250 * 2 ** i, 4000)));
      }
    }
    if (!verified) {
      await deleteAccessKey(http, iam, old, fresh.accessKeyId, user).catch(() => undefined);
      throw new CloudCallError(`The new key did not verify${lastErr ? `: ${(lastErr as Error).message}` : ''}; it was deleted and the old key stays in use.`, 502, 'verify-failed');
    }
    await this.replace(account, { accessKeyId: fresh.accessKeyId, secretAccessKey: fresh.secretAccessKey }, by);
    const overlapUntil = Date.now() + this.cfg.CLOUD_AWS_KEY_OVERLAP_MINUTES * MIN;
    await this.patchState(account.id, { kind: 'aws-keys', rotation_state: 'overlap', previous: { awsAccessKeyId: old.accessKeyId, userName: user }, overlap_until: overlapUntil, rotated_at: Date.now(), last_error: null });
    await this.auditAccount(account, 'cloud.credential.rotated', by, { provider: 'aws', newKey: `…${fresh.accessKeyId.slice(-4)}`, oldKey: `…${old.accessKeyId.slice(-4)}`, overlapUntil });
    return { rotated: true, overlapUntil, detail: `The new key is in use; the old key ending ${old.accessKeyId.slice(-4)} is deleted at ${new Date(overlapUntil).toISOString()}.` };
  }

  private async rotateAzure(account: CloudAccount, cred: CloudCredentialRef, by: string | null) {
    const http = this.http();
    const graph = await this.entra(account, cred, AZURE_SCOPES.graph);
    const clientId = cred.params.clientId!;
    const oldSecret = await this.resolve(account, cred, cred.refs.clientSecret!);
    // The current secret's Graph key id: kept beside it when this server made it, else found by its hint.
    let oldKeyId: string | null = null;
    const path = parseVaultRef(cred.refs.clientSecret!)?.path;
    if (path?.startsWith(`${CLOUD_KV_ROOT}/`)) oldKeyId = (await this.vault.readAll(path).catch(() => ({}) as Record<string, string>)).keyId ?? null;
    if (!oldKeyId) {
      const matches = (await listPasswords(http, this.cfg.CLOUD_AZURE_GRAPH_URL, graph.token, clientId)).filter((p) => p.hint && oldSecret.startsWith(p.hint));
      if (matches.length === 1) oldKeyId = matches[0]!.keyId;
    }
    const endsAt = Date.now() + this.cfg.CLOUD_AZURE_SECRET_DAYS * DAY;
    const added = await addPassword(http, this.cfg.CLOUD_AZURE_GRAPH_URL, graph.token, clientId, { displayName: `exprsn-ai ${account.name} ${new Date().toISOString().slice(0, 10)}`, endsAt });
    try {
      await this.entra(account, cred, AZURE_SCOPES.arm, added.secretText);
    } catch (err) {
      await removePassword(http, this.cfg.CLOUD_AZURE_GRAPH_URL, graph.token, clientId, added.keyId).catch(() => undefined);
      throw err;
    }
    await this.replace(account, { clientSecret: added.secretText, keyId: added.keyId }, by, added.endsAt);
    const overlapUntil = Date.now() + this.cfg.CLOUD_AWS_KEY_OVERLAP_MINUTES * MIN;
    await this.patchState(account.id, { kind: 'azure-secret', rotation_state: oldKeyId ? 'overlap' : 'idle', previous: oldKeyId ? { azureKeyId: oldKeyId } : null, overlap_until: oldKeyId ? overlapUntil : null, rotated_at: Date.now(), expires_at: added.endsAt, last_error: oldKeyId ? null : 'The previous client secret could not be identified in Graph; remove it from the app registration by hand.' });
    await this.auditAccount(account, 'cloud.credential.rotated', by, { provider: 'azure', newKeyId: added.keyId, oldKeyId, overlapUntil: oldKeyId ? overlapUntil : null, endsAt: added.endsAt });
    if (!oldKeyId) await this.tell(account, `Remove the old client secret of ${account.name}`, 'A new client secret was added and is in use. The previous one could not be identified in Microsoft Graph, so remove it from the app registration by hand.');
    return { rotated: true, overlapUntil: oldKeyId ? overlapUntil : null, detail: `The new client secret is in use until ${new Date(added.endsAt).toISOString().slice(0, 10)}.` };
  }

  /** Ends an overlap: the old AWS key or Azure secret is deleted with the new credential. */
  private async finishOverlap(account: CloudAccount, st: StateRow): Promise<void> {
    const cred = await this.s().cloud.accounts.credentialRef(account.id);
    if (!cred) return;
    const http = this.http();
    try {
      if (st.previous?.awsAccessKeyId) {
        const keys = await this.awsKeys(account, cred);
        await deleteAccessKey(http, this.cfg.CLOUD_AWS_IAM_URL, keys, st.previous.awsAccessKeyId, st.previous.userName ?? null).catch((err: unknown) => {
          if (err instanceof CloudCallError && err.code === 'NoSuchEntity') return; // already gone
          throw err;
        });
      } else if (st.previous?.azureKeyId) {
        const graph = await this.entra(account, cred, AZURE_SCOPES.graph);
        await removePassword(http, this.cfg.CLOUD_AZURE_GRAPH_URL, graph.token, cred.params.clientId!, st.previous.azureKeyId);
      }
      await this.patchState(account.id, { rotation_state: 'idle', previous: null, overlap_until: null, last_error: null });
      await this.auditAccount(account, 'cloud.credential.previous-deleted', null, { provider: account.provider, ...(st.previous?.awsAccessKeyId ? { oldKey: `…${st.previous.awsAccessKeyId.slice(-4)}` } : { oldKeyId: st.previous?.azureKeyId ?? null }) });
    } catch (err) {
      await this.patchState(account.id, { last_error: `The previous credential was not deleted: ${(err as Error).message}`.slice(0, 1000) });
    }
  }

  /**
   * The sweep (`cloud.credentials.sweep`): overlaps that ended, automatic rotations that are due (AWS by age, Azure
   * secrets before they end), and notices before a token or secret that only a person can replace expires.
   */
  async sweep(now = Date.now()): Promise<{ finished: number; rotated: number; notices: number; failed: number }> {
    const out = { finished: 0, rotated: 0, notices: 0, failed: 0 };
    const s = this.s();
    if (!(await this.installed()) || !(await s.cloud.accounts.installed())) return out;
    const accounts = (await s.cloud.accounts.list(null)).filter((a) => a.state !== 'disabled' && a.credentialMode === 'vaulted');
    for (const a of accounts) {
      const cred = await s.cloud.accounts.credentialRef(a.id);
      if (!cred || cred.mode !== 'vaulted') continue;
      const kind = kindOf(a.provider, cred);
      let st = await this.state(a.id);
      if (!st) {
        await this.patchState(a.id, { kind, rotated_at: cred.updatedAt });
        st = await this.state(a.id);
      }
      if (!st) continue;
      if (st.rotation_state === 'overlap' && st.overlap_until != null && st.overlap_until <= now) {
        await this.finishOverlap(a, st);
        out.finished++;
        continue;
      }
      if (a.state === 'pending') continue;
      const rotatedAt = st.rotated_at ?? cred.updatedAt;
      const awsDue = kind === 'aws-keys' && this.cfg.CLOUD_AWS_KEY_ROTATION_DAYS > 0 && now >= rotatedAt + this.cfg.CLOUD_AWS_KEY_ROTATION_DAYS * DAY;
      const azureDue = kind === 'azure-secret' && st.expires_at != null && now >= st.expires_at - this.cfg.CLOUD_CREDENTIAL_NOTICE_DAYS * DAY && st.rotation_state !== 'failed';
      if ((awsDue || azureDue) && st.rotation_state !== 'overlap') {
        try {
          await this.rotate(a);
          out.rotated++;
        } catch {
          out.failed++;
          if (kind === 'azure-secret') out.notices += await this.expiryNotice(a, (await this.state(a.id)) ?? st, now, true);
        }
        continue;
      }
      if (kind === 'token' || kind === 'azure-certificate' || (kind === 'azure-secret' && st.rotation_state === 'failed')) out.notices += await this.expiryNotice(a, st, now, false);
    }
    return out;
  }

  /** B-1706-style notices: once when the expiry is within CLOUD_CREDENTIAL_NOTICE_DAYS, once when it has passed. */
  private async expiryNotice(a: CloudAccount, st: StateRow, now: number, graphFailed: boolean): Promise<number> {
    if (st.expires_at == null) return 0;
    const stage = now >= st.expires_at ? 'expired' : now >= st.expires_at - this.cfg.CLOUD_CREDENTIAL_NOTICE_DAYS * DAY ? 'due' : null;
    if (!stage) return 0;
    if (st.notice_for === st.expires_at && (st.notice_stage === stage || st.notice_stage === 'expired')) return 0;
    const claimed = await this.s().db('cloud_credential_state').where({ account_id: a.id }).andWhere((q) => (st.notice_stage == null ? q.whereNull('notice_stage') : q.where('notice_stage', st.notice_stage))).update({ notice_stage: stage, notice_for: st.expires_at, updated_at: now });
    if (!claimed) return 0;
    const what = a.provider === 'azure' ? 'client secret' : a.provider === 'cloudflare' ? 'Cloudflare API token' : 'DigitalOcean token';
    const date = new Date(st.expires_at).toISOString().slice(0, 10);
    const title = stage === 'expired' ? `The ${what} of ${a.name} has expired` : `Replace the ${what} of ${a.name} before ${date}`;
    const body = `${stage === 'expired' ? `It expired on ${date}; calls with it now fail.` : `It expires on ${date}.`} ${graphFailed ? 'Exprsn-AI could not replace it through Microsoft Graph (the app may not change its own secrets). ' : ''}Create a new one with the same permissions and replace it under Cloud, the account, Credential.`;
    await this.tell(a, title, body);
    await this.auditAccount(a, stage === 'expired' ? 'cloud.credential.expired' : 'cloud.credential.expiry-due', null, { expiresAt: st.expires_at });
    return 1;
  }

  // ---------- an Azure certificate from the Exprsn-AI CA (B-10006) ----------

  /**
   * Issues a client certificate for an Azure account from its tenant's issuing CA (the platform tenant's for a
   * platform account), with the key made and kept in the signer or transit, and stores the certificate and the key's
   * reference in the vault. The certificate (public) is returned to upload to the app registration; the reference goes
   * into the account's credential (`refs.certificate`) through the usual dual-controlled change.
   */
  async issueAzureCertificate(account: CloudAccount, by: PkiActor, days?: number): Promise<{ ref: string; certificatePem: string; thumbprint: string; notAfter: number }> {
    if (account.provider !== 'azure') throw new HttpProblem(409, 'Conflict', 'Only an Azure account takes a certificate credential.');
    const s = this.s();
    const tenantId = account.tenantId ?? (await platformTenant(s));
    if (!tenantId) throw new HttpProblem(503, 'Unavailable', 'The platform tenant is missing.');
    if (!s.pki.keys.custody()) throw new HttpProblem(409, 'Conflict', 'A certificate credential needs the signer (SIGNER_SOCKET) or OpenBao transit to hold its key; this server never holds it.');
    const issuer = await s.pki.activeIntermediate(tenantId);
    if (!issuer) throw new HttpProblem(409, 'Conflict', 'The tenant has no active issuing CA; create one on the Certificates screen.');
    const profile = (await s.pki.profiles(tenantId)).find((p) => p.kind === 'client' && p.state === 'active' && p.policy.keyTypes.includes('rsa-2048'));
    if (!profile) throw new HttpProblem(409, 'Conflict', 'The tenant needs an active client certificate profile that accepts RSA-2048 keys.');
    const { ref, publicKey } = await s.pki.keys.create(`cloud-azure-${account.id.toLowerCase()}-${Date.now().toString(36)}`, 'rsa-2048');
    const issued = await s.pki.issueKey({ ...by, tenantId }, issuer, profile, { spki: publicKey.export({ type: 'spki', format: 'der' }), keyType: 'rsa-2048', commonName: `exprsn-ai cloud ${account.name}`.slice(0, 64), sans: [], ...(days ? { days } : {}), keyGenerated: true });
    const doc: CertificateDoc = { certificatePem: issued.cert.certificate_pem, key: ref };
    const stored = await this.vault.write(`${accountPath(account.id)}/certificate`, { certificate: JSON.stringify(doc) });
    const der = new X509Certificate(issued.cert.certificate_pem).raw;
    await this.auditAccount(account, 'cloud.credential.certificate-issued', by.userId, { certificate: issued.cert.id, custody: ref.custody, notAfter: issued.cert.not_after });
    if (await this.installed()) await this.patchState(account.id, { kind: 'azure-certificate', expires_at: issued.cert.not_after });
    return { ref: stored.refs.certificate!, certificatePem: issued.cert.certificate_pem, thumbprint: createHash('sha1').update(der).digest('hex').toUpperCase(), notAfter: issued.cert.not_after };
  }

  /** The account's own secrets go with it (every version) and every cache forgets it. */
  async forget(accountId: string): Promise<void> {
    this.changed(accountId);
    // 1.9.99-final (B-10803): the secrets the account's references point at under `cloud/secrets/<scope>/` (where
    // `POST /admin/cloud/secrets` stages them before the account exists, and where replace and rotation keep writing)
    // go too, unless another account's credential still names the same path.
    const s = this.s();
    const account = await s.cloud.accounts.get(accountId).catch(() => null);
    const cred = account ? await s.cloud.accounts.credentialRef(accountId).catch(() => null) : null;
    if (account && cred) {
      const staged = new Set(Object.values(cred.refs).map((r) => parseVaultRef(r)?.path ?? '').filter((p) => p.startsWith(`${CLOUD_KV_ROOT}/secrets/`) && this.owns(account, p)));
      if (staged.size) {
        const others = (await s.db('cloud_credentials').whereNot({ account_id: accountId }).select('refs')) as { refs: string }[];
        const named = new Set(others.flatMap((r) => Object.values(JSON.parse(r.refs || '{}') as Record<string, string>).map((x) => parseVaultRef(x)?.path ?? '')));
        for (const p of staged) if (!named.has(p)) await this.vault.remove(p);
      }
    }
    await this.vault.remove(accountPath(accountId)).catch(() => undefined);
    await this.vault.remove(`${accountPath(accountId)}/certificate`).catch(() => undefined);
    if (await this.installed()) await this.s().db('cloud_credential_state').where({ account_id: accountId }).delete();
  }

  // ---------- jobs ----------

  registerJobs(): void {
    const s = this.s();
    s.jobs.register('cloud.credentials.sweep', async (_p, ctx) => {
      const out = await this.sweep();
      await ctx.progress(100, `${out.rotated} rotated, ${out.finished} overlaps ended, ${out.notices} notices`);
      return out;
    });
    s.jobs.register('cloud.issuer.check', async (_p, ctx) => {
      if (!(await this.issuer.installed())) return { skipped: 'not installed' };
      const rotated = await this.issuer.scheduled();
      const st = await this.issuer.state();
      const used = await s.db('cloud_issuer_keys').first('kid');
      if (st.target.kind === 'none' && !used) return { skipped: 'no issuer in use', ...rotated };
      const check = await this.issuer.check();
      await ctx.progress(100, check.detail);
      return { ...rotated, state: check.state };
    });
  }

  schedule(scheduler: Scheduler): void {
    const platform = async () => {
      const t = await platformTenant(this.s());
      return t ? [{ tenantId: t, payload: {} }] : [];
    };
    scheduler.every('cloud.credentials.sweep', this.cfg.CLOUD_CREDENTIAL_CHECK_MINUTES * MIN, platform);
    scheduler.every('cloud.issuer.check', this.cfg.CLOUD_ISSUER_CHECK_MINUTES * MIN, platform);
  }
}

/** `s.cloud.credentials` as this module's service (tests may swap in a stub; the routes and jobs need the real one). */
export function cloudCredentials(s: Services): CloudCredentials {
  const c = s.cloud.credentials;
  if (!(c instanceof CloudCredentials)) throw new HttpProblem(503, 'Not available', 'Cloud credentials are not available in this build.', { extensions: { reason: 'cloud_component_missing' } });
  return c;
}
