import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import type { Principal } from '../authz/policy.js';
import { badRequest, conflict, notFound } from '../http/problem.js';
import { platformTenant } from '../ops/common.js';
import type { Services } from '../services.js';
import { SYS_SCOPE } from './policy.js';

/*
 * 1.7.0, Sprint 42 (B-9207, VLT-7): the signing keys of the other domains, registered as vault keys.
 *
 * The OIDC, SAML, webhook, CA and OCSP, content-credential, ACME, AT-Protocol and PDS signing keys each live where
 * their domain put them: in the signer process, in OpenBao transit, or (the older ones, and the ACME account key)
 * sealed in this server's database. Registering one writes a row of `vault_signing_keys` that points at it: its
 * domain, the domain's own id for it, where its private half is, and a path in the vault's transit namespace
 * (`transit/signing/<domain>/<name>`), so the vault's path policy decides who may list it and rotate it and the audit
 * chain records both. Nothing is copied, moved or rotated by registering: a key held by the signer or OpenBao stays
 * there, and no private key is ever read into the vault's in-memory transit, which would undo the signer's isolation.
 * Removing a registration removes the row and nothing else.
 *
 * Rotation from the vault is the domain's own rotation (OIDC: a new key published in the JWKS, the previous one kept
 * for the overlap window, so tokens it signed verify until they expire; webhooks: a new active key, the previous one
 * retired but still published). Domains without one (the CA, AT-Protocol, the PDS) are listed and not rotated here.
 */

export const SIGNING_DOMAINS = ['oidc', 'saml', 'saml-enc', 'webhook', 'ca', 'ocsp', 'content', 'acme', 'atproto', 'pds'] as const;
export type SigningDomain = (typeof SIGNING_DOMAINS)[number];
export type KeyBackend = 'signer' | 'openbao' | 'sealed';

/** A signing key as its domain holds it. No key material: the reference columns are read only for their prefix. */
export interface FoundKey {
  domain: SigningDomain;
  /** The domain's own id for the key. */
  sourceId: string;
  /** What the key is called where it is shown. */
  title: string;
  keyType: string;
  backend: KeyBackend;
  /** The domain's state for it (signing, next, retired, active, ...). */
  state: string;
  createdAt: number | null;
}

interface Row {
  id: string;
  tenant_id: string;
  domain: SigningDomain;
  source_id: string;
  path: string;
  backend: KeyBackend;
  key_type: string;
  title: string;
  registered_by: string | null;
  registered_at: number;
}

const ROTATABLE: readonly SigningDomain[] = ['oidc', 'webhook'];

/** `signer:` and `kms:` are references; anything else in such a column is a sealed private key. */
const backendOfRef = (ref: unknown): KeyBackend => (String(ref ?? '').startsWith('signer:') ? 'signer' : String(ref ?? '').startsWith('kms:') ? 'openbao' : 'sealed');
const backendOfCustody = (custody: unknown): KeyBackend => (custody === 'signer' ? 'signer' : custody === 'openbao' || custody === 'kms' ? 'openbao' : 'sealed');
const slug = (v: string): string => v.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100) || 'key';
const num = (v: unknown): number | null => (v == null ? null : Number(v));

/** The key's path in the vault's transit namespace. A grant on `transit/signing/<domain>` covers the domain's keys. */
export const signingKeyPath = (domain: SigningDomain, sourceId: string): string => `transit/signing/${domain}/${slug(sourceId)}`;
export const signingDomainPath = (domain: SigningDomain): string => `transit/signing/${domain}`;

export class SigningKeyRegistry {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private async has(table: string): Promise<boolean> {
    return this.db.schema.hasTable(table);
  }

  /** The signing keys that exist in a tenant (or, for the platform scope, the platform's own): read from each domain's table. */
  async discover(scope: string): Promise<FoundKey[]> {
    const out: FoundKey[] = [];
    const sys = scope === SYS_SCOPE;
    const rows = async (table: string, where?: (q: Knex.QueryBuilder) => void): Promise<Record<string, unknown>[]> => {
      if (!(await this.has(table))) return [];
      const q = this.db(table);
      if (where) where(q);
      return (await q) as Record<string, unknown>[];
    };
    if (!sys) {
      const now = Date.now();
      for (const r of await rows('federation_keys', (q) => void q.where({ tenant_id: scope }))) {
        if (r.removes_at != null && Number(r.removes_at) <= now) continue;
        out.push({ domain: String(r.use) as SigningDomain, sourceId: String(r.kid), title: String(r.kid), keyType: String(r.alg), backend: backendOfRef(r.private_sealed), state: String(r.state), createdAt: num(r.created_at) });
      }
      for (const r of await rows('webhook_signing_keys', (q) => void q.where({ tenant_id: scope }))) out.push({ domain: 'webhook', sourceId: String(r.id), title: `Webhook signing key ${String(r.id).slice(-6)}`, keyType: 'ed25519', backend: backendOfRef(r.private_sealed), state: String(r.state), createdAt: num(r.created_at) });
      for (const r of await rows('pki_content_signers', (q) => void q.where({ tenant_id: scope }))) out.push({ domain: 'content', sourceId: String(r.id), title: `Content credentials signer ${String(r.fingerprint ?? r.id).slice(0, 12)}`, keyType: String(r.key_type), backend: backendOfCustody(r.custody), state: String(r.state), createdAt: num(r.created_at) });
      for (const r of await rows('atproto_keys', (q) => void q.where({ tenant_id: scope }))) out.push({ domain: 'atproto', sourceId: String(r.id), title: `AT-Protocol ${String(r.purpose)} key`, keyType: String(r.curve), backend: backendOfCustody(r.custody), state: String(r.state), createdAt: num(r.created_at) });
      for (const r of await rows('pds_accounts', (q) => void q.where({ tenant_id: scope }))) {
        const who = String(r.handle ?? r.did ?? r.id);
        if (r.key_name != null) out.push({ domain: 'pds', sourceId: `${String(r.id)}.signing`, title: `PDS signing key of ${who}`, keyType: String(r.key_curve), backend: backendOfCustody(r.key_custody), state: String(r.state), createdAt: num(r.created_at) });
        if (r.rot_key_name != null) out.push({ domain: 'pds', sourceId: `${String(r.id)}.rotation`, title: `PDS rotation key of ${who}`, keyType: String(r.rot_curve), backend: backendOfCustody(r.rot_custody), state: String(r.state), createdAt: num(r.created_at) });
      }
    }
    // Issuers: a tenant's own, or (platform scope) those that belong to no tenant, the root among them.
    const issuers = await rows('pki_issuers', (q) => void (sys ? q.where((w) => void w.whereNull('tenant_id').orWhere({ tenant_id: '' })) : q.where({ tenant_id: scope })));
    for (const r of issuers) out.push({ domain: 'ca', sourceId: String(r.id), title: String(r.name ?? r.id), keyType: String(r.key_type), backend: backendOfCustody(r.custody), state: String(r.state), createdAt: num(r.created_at) });
    if (issuers.length) {
      const byId = new Map(issuers.map((i) => [String(i.id), String(i.name ?? i.id)]));
      for (const r of await rows('pki_responders', (q) => void q.whereIn('issuer_id', [...byId.keys()]))) out.push({ domain: 'ocsp', sourceId: String(r.id), title: `OCSP responder of ${byId.get(String(r.issuer_id)) ?? String(r.issuer_id)}`, keyType: String(r.key_type), backend: backendOfCustody(r.custody), state: Number(r.not_after) > Date.now() ? 'active' : 'expired', createdAt: num(r.created_at) });
    }
    // The ACME client's account key is the platform's, sealed with the platform data key.
    if (sys) for (const r of await rows('platform_acme_accounts')) out.push({ domain: 'acme', sourceId: slug(String(r.directory_url)), title: `ACME account at ${String(r.directory_url)}`, keyType: 'account key', backend: 'sealed', state: 'active', createdAt: num(r.created_at) });
    return out;
  }

  private view(r: Row, live: FoundKey | undefined) {
    return {
      id: r.id,
      domain: r.domain,
      name: r.title,
      path: r.path,
      keyType: r.key_type,
      /** Where the private half is: `signer` and `openbao` never have it in this process; `sealed` is in the database. */
      backend: live?.backend ?? r.backend,
      isolated: (live?.backend ?? r.backend) !== 'sealed',
      state: live?.state ?? 'gone',
      createdAt: live?.createdAt ?? null,
      rotatable: ROTATABLE.includes(r.domain) && (live?.state === 'signing' || live?.state === 'active'),
      registeredBy: r.registered_by,
      registeredAt: Number(r.registered_at)
    };
  }

  private async registered(scope: string): Promise<Row[]> {
    return (await this.db('vault_signing_keys').where({ tenant_id: scope }).orderBy('domain').orderBy('registered_at')) as Row[];
  }

  private async caller(p: Principal, scope: string, ctx: { ip?: string | null; traceId?: string | null }) {
    return scope === SYS_SCOPE ? this.s().vault.rootCaller(p, ctx) : this.s().vault.callerFor(p, ctx);
  }

  private async audit(p: Principal, scope: string, action: string, r: Pick<Row, 'id' | 'domain' | 'path' | 'source_id'>, detail: Record<string, unknown>, ctx: { ip?: string | null; traceId?: string | null }): Promise<void> {
    const tenantId = scope === SYS_SCOPE ? await platformTenant(this.s()) : scope;
    if (!tenantId) return;
    await this.s().audit.append({ tenantId, action, kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { key: r.id, domain: r.domain, path: r.path, source: r.source_id, ...(scope === SYS_SCOPE ? { scope: 'sys' } : {}) }, label: 'restricted', detail, traceId: ctx.traceId ?? null });
  }

  /** The registered keys the caller's vault policy lets them list, with what each domain says of its key now. */
  async list(p: Principal, scope: string, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    const rows = await this.registered(scope);
    const found = new Map((await this.discover(scope)).map((f) => [`${f.domain}:${f.sourceId}`, f]));
    const c = await this.caller(p, scope, ctx);
    const ok = scope === SYS_SCOPE ? new Set(rows.map((r) => r.path)) : await this.s().vault.allowedPaths(c, rows.map((r) => r.path), 'list');
    const known = new Set(rows.map((r) => `${r.domain}:${r.source_id}`));
    return {
      custody: this.s().vault.heldCustody(),
      keys: rows.filter((r) => ok.has(r.path)).map((r) => this.view(r, found.get(`${r.domain}:${r.source_id}`))),
      /** Keys their domains hold that are not registered (counts only: what they are is shown once registered). */
      unregistered: [...found.values()].filter((f) => !known.has(`${f.domain}:${f.sourceId}`)).reduce<Record<string, number>>((a, f) => ({ ...a, [f.domain]: (a[f.domain] ?? 0) + 1 }), {})
    };
  }

  /**
   * Registers every key the domains hold that is not registered yet (optionally of some domains only). It reads the
   * domains' tables and writes rows of `vault_signing_keys`; no key is created, moved or rotated. Run again, it adds
   * only what is new.
   */
  async register(p: Principal, scope: string, opts: { domains?: SigningDomain[] } = {}, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    const known = new Set((await this.registered(scope)).map((r) => `${r.domain}:${r.source_id}`));
    const found = (await this.discover(scope)).filter((f) => !known.has(`${f.domain}:${f.sourceId}`) && (!opts.domains?.length || opts.domains.includes(f.domain)));
    const added: Row[] = [];
    for (const f of found) {
      const row: Row = { id: ulid(), tenant_id: scope, domain: f.domain, source_id: f.sourceId, path: signingKeyPath(f.domain, f.sourceId), backend: f.backend, key_type: f.keyType.slice(0, 40), title: f.title.slice(0, 200), registered_by: p.userId, registered_at: Date.now() };
      try {
        await this.db('vault_signing_keys').insert(row);
      } catch (err) {
        // Registered at the same time by someone else; anything else is a real failure.
        if (await this.db('vault_signing_keys').where({ tenant_id: scope, domain: f.domain, source_id: f.sourceId }).first('id')) continue;
        throw err;
      }
      added.push(row);
      await this.audit(p, scope, 'vault.signing-key.registered', row, { backend: f.backend, keyType: f.keyType, state: f.state }, ctx);
    }
    return { registered: added.length, keys: added.map((r) => this.view(r, found.find((f) => f.domain === r.domain && f.sourceId === r.source_id))) };
  }

  private async row(scope: string, id: string): Promise<Row> {
    const r = (await this.db('vault_signing_keys').where({ tenant_id: scope, id }).first()) as Row | undefined;
    if (!r) throw notFound('Signing key');
    return r;
  }

  /** Removes a registration: the row goes, the key stays where it is and goes on signing. */
  async unregister(p: Principal, scope: string, id: string, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<void> {
    const r = await this.row(scope, id);
    await this.db('vault_signing_keys').where({ id: r.id }).delete();
    await this.audit(p, scope, 'vault.signing-key.unregistered', r, { backend: r.backend }, ctx);
  }

  /**
   * Rotates a registered key through its domain. The vault's policy is asked for `manage` on the domain's path. The
   * new key is registered too; the previous one stays registered for as long as its domain publishes it.
   */
  async rotate(p: Principal, scope: string, id: string, opts: { immediate?: boolean } = {}, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    const r = await this.row(scope, id);
    if (scope === SYS_SCOPE || !ROTATABLE.includes(r.domain)) throw conflict(`A ${r.domain} key is not rotated from the vault: its own screen does that.`);
    await this.s().vault.authorize(await this.caller(p, scope, ctx), signingDomainPath(r.domain), 'manage');
    const live = (await this.discover(scope)).find((f) => f.domain === r.domain && f.sourceId === r.source_id);
    if (!live || (live.state !== 'signing' && live.state !== 'active')) throw conflict('Only the key that signs now is rotated; this one is already on its way out.');
    let next: string;
    let detail: Record<string, unknown>;
    if (r.domain === 'oidc') {
      const out = await this.s().federation.keys.rotate(scope, { immediate: !!opts.immediate });
      next = out.next.kid;
      detail = { next, previous: out.current?.kid ?? null, immediate: !!opts.immediate, activatesAt: out.next.activates_at };
    } else {
      if (opts.immediate === false) throw badRequest('A webhook signing key is replaced at once; the previous one stays published for verification.');
      const out = await this.s().webhooks.createKey(scope, p.userId);
      next = out.row.id;
      detail = { next, previous: out.retired };
    }
    await this.audit(p, scope, 'vault.signing-key.rotated', r, detail, ctx);
    await this.register(p, scope, { domains: [r.domain] }, ctx);
    const after = await this.list(p, scope, ctx);
    return { rotated: r.id, next: after.keys.find((k) => k.domain === r.domain && k.path === signingKeyPath(r.domain, next)) ?? null, keys: after.keys.filter((k) => k.domain === r.domain) };
  }
}
