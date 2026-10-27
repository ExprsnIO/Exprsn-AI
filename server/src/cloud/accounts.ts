import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { LABELS, labelRank, type Label } from '../authz/labels.js';
import { permissionsFor } from '../authz/permissions.js';
import { authorize, regionAdmits, type Principal, type RegionPlacement } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { isSecretRef } from '../vault/policy.js';
import { cloudCredentials } from './credentials.js';
import { catalogueRegion, RESIDENCY_GEOS, START_CEILING, type ResidencyGeo } from './catalogue.js';
import {
  ACCOUNT_SCOPES,
  CREDENTIAL_FIELDS,
  CREDENTIAL_MODES,
  FEATURE_NAMES,
  PROVIDER_ID_FIELDS,
  PROVIDER_MODES,
  PROVIDER_NAMES,
  PROVIDERS,
  TENANT_ACCOUNT_USES,
  federationUnavailable,
  type AccountState,
  type AccountUse,
  type CloudAccount,
  type CloudCredentialRef,
  type CloudFeature,
  type CloudProposal,
  type CloudProposalKind,
  type CredentialMode,
  type Provider,
  type ProviderIds,
  type Region,
  type RegionDecision,
  type ValidationReport
} from './types.js';

/*
 * 1.9.99-final, Sprint 56 (B-10002, B-10008, B-10009): cloud accounts, their regions and label ceilings, and the
 * dual-controlled changes to them. `s.cloud.accounts`.
 *
 * - An account is platform-scoped (tenant_id null; seen by the platform tenant's cloud readers and by platform admins;
 *   changed only by a cloud admin who also holds `platform:manage`) or tenant-scoped (one tenant's own account, added
 *   by that tenant's cloud admins; usable for data connections and model backends only, open decision 6).
 * - Credentials are references: `vault:` references for vaulted keys and tokens, and the non-secret parameters of a
 *   federated trust (an AWS role ARN, an Azure client id). No route takes or returns a secret value.
 * - Dual control (B-10002): adding an account, removing it, changing its credential mode, raising a region's ceiling
 *   and widening a tenant's residency are proposals a second cloud admin approves. An added account is `pending`,
 *   and unusable, until then. Approving a platform account's change, or a `restricted` ceiling (open decision 4: never
 *   in a cloud unless a platform admin overrides it), also needs `platform:manage`.
 * - Regions (B-10008): an allow-list per account; each region maps to a zone and a label ceiling (the lower of its
 *   own and its zone's, when `zones/` defines that zone). `assertRegionAllows` is the one check every placement of
 *   data, a pool, a model entry or a deployment calls; its decision is `regionAdmits` in `authz/policy.ts`.
 *   Residency per label (open decision 4): `public` and `internal` anywhere on the allow-list; `confidential` (and an
 *   overridden `restricted`) only in regions whose geography is in the owning tenant's residency.
 *
 * Needs migration 146_cloud_accounts. Until it is applied every read answers "not installed" (503
 * `migration_pending`) and `assertRegionAllows` refuses, so nothing is placed in a cloud.
 */

const SCHEMA_RECHECK_MS = 30_000;
const PLATFORM_KEY = 'platform';
const TABLES = ['cloud_accounts', 'cloud_account_regions', 'cloud_credentials', 'cloud_account_proposals', 'cloud_residency'] as const;

export const cloudMissing = () => new HttpProblem(503, 'Not installed', 'Cloud accounts need the database migration 146_cloud_accounts, which has not been applied.', { extensions: { reason: 'migration_pending' } });

export interface CloudActor {
  principal: Principal;
  ip: string | null;
  traceId?: string;
}

// ---------- input schemas (the routes parse with these) ----------

const guid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'a GUID');
const hex32 = z.string().regex(/^[0-9a-f]{32}$/, '32 hexadecimal characters');

export const providerIdsSchema = z
  .object({
    awsAccountId: z.string().regex(/^\d{12}$/, 'twelve digits').optional(),
    azureTenantId: guid.optional(),
    azureSubscriptionId: guid.optional(),
    doTeamId: guid.optional(),
    cloudflareAccountId: hex32.optional(),
    cloudflareZoneIds: z.array(hex32).max(50).optional()
  })
  .strict();

export const credentialSchema = z
  .object({
    mode: z.enum(CREDENTIAL_MODES),
    params: z.record(z.string().max(40), z.string().trim().min(1).max(600)).default({}),
    refs: z.record(z.string().max(40), z.string().trim().min(1).max(300)).default({})
  })
  .strict();

export const regionInputSchema = z.object({ region: z.string().trim().min(1).max(40), ceiling: z.enum(LABELS).optional() }).strict();

export const accountName = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/, 'lower case letters, digits and dashes, starting with a letter');

export const addAccountSchema = z
  .object({
    name: accountName,
    provider: z.enum(PROVIDERS),
    scope: z.enum(ACCOUNT_SCOPES),
    providerIds: providerIdsSchema,
    credential: credentialSchema,
    regions: z.array(regionInputSchema).min(1).max(20),
    defaultRegion: z.string().trim().max(40).optional(),
    description: z.string().trim().max(500).optional(),
    reason: z.string().trim().max(500).optional()
  })
  .strict();

export const patchAccountSchema = z
  .object({
    description: z.string().trim().max(500).nullable().optional(),
    defaultRegion: z.string().trim().max(40).optional(),
    state: z.enum(['active', 'disabled']).optional(),
    regions: z.array(regionInputSchema).min(1).max(20).optional(),
    credential: credentialSchema.optional(),
    reason: z.string().trim().max(500).optional()
  })
  .strict();

export type AddAccountInput = z.infer<typeof addAccountSchema>;
export type PatchAccountInput = z.infer<typeof patchAccountSchema>;
type CredentialInput = z.infer<typeof credentialSchema>;

const ROLE_ARN = /^arn:aws(?:-[a-z]+)*:iam::(\d{12}):role\/[\w+=,.@/-]{1,512}$/;

// ---------- rows ----------

const lower = (a: Label, b: Label): Label => (labelRank(a) <= labelRank(b) ? a : b);

function regionFrom(r: Record<string, unknown>): Region {
  return { region: String(r.region), zone: String(r.zone), ceiling: r.ceiling as Label, geo: String(r.geo), isDefault: !!r.is_default };
}

function proposalFrom(r: Record<string, unknown>): CloudProposal {
  return {
    id: String(r.id),
    kind: r.kind as CloudProposalKind,
    accountId: (r.account_id as string | null) ?? null,
    scope: r.scope === 'platform' ? 'platform' : 'tenant',
    tenantId: (r.tenant_id as string | null) ?? null,
    summary: String(r.summary),
    payload: json<Record<string, unknown>>(r.payload, {}),
    state: r.state as CloudProposal['state'],
    proposedBy: String(r.proposed_by),
    proposedAt: Number(r.proposed_at),
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: r.decided_at == null ? null : Number(r.decided_at),
    note: (r.note as string | null) ?? null,
    needsPlatformAdmin: !!r.needs_platform
  };
}

/** Validates a credential against the provider's fields: the right mode, known parameters, `vault:` references only. */
export function checkCredential(provider: Provider, providerIds: ProviderIds, cred: CredentialInput): void {
  if (!PROVIDER_MODES[provider].includes(cred.mode)) throw badRequest(federationUnavailable(provider) ?? `${PROVIDER_NAMES[provider]} does not offer ${cred.mode} credentials.`, { reason: 'mode_unavailable' });
  const spec = CREDENTIAL_FIELDS[provider][cred.mode]!;
  const allowedParams = [...spec.params, ...(spec.optionalParams ?? [])];
  const allowedRefs = [...spec.refs, ...(spec.optionalRefs ?? [])];
  for (const k of Object.keys(cred.params)) if (!allowedParams.includes(k)) throw badRequest(`A ${PROVIDER_NAMES[provider]} ${cred.mode} credential has no parameter ${k}.`);
  for (const k of Object.keys(cred.refs)) if (!allowedRefs.includes(k)) throw badRequest(`A ${PROVIDER_NAMES[provider]} ${cred.mode} credential has no secret ${k}.`);
  for (const k of spec.params) if (!cred.params[k]) throw badRequest(`A ${PROVIDER_NAMES[provider]} ${cred.mode} credential needs ${k}.`);
  for (const k of spec.refs) if (!cred.refs[k]) throw badRequest(`A ${PROVIDER_NAMES[provider]} ${cred.mode} credential needs ${k} as a vault: reference.`);
  for (const [k, v] of Object.entries(cred.refs)) {
    if (!isSecretRef(v)) throw badRequest(`${k} must be a vault reference (vault:<path>#<key>), never the secret itself.`, { reason: 'not_a_reference' });
  }
  if (provider === 'azure' && cred.mode === 'vaulted' && Object.keys(cred.refs).length !== 1) throw badRequest('A vaulted Azure credential needs exactly one of clientSecret or certificate, as a vault: reference.');
  if (cred.params.roleArn) {
    const m = ROLE_ARN.exec(cred.params.roleArn);
    if (!m) throw badRequest('roleArn must be an IAM role ARN (arn:aws:iam::<account>:role/<name>).');
    if (providerIds.awsAccountId && m[1] !== providerIds.awsAccountId) throw badRequest(`The role ARN names account ${m[1]}, not ${providerIds.awsAccountId}.`);
  }
  if (cred.params.clientId && !guid.safeParse(cred.params.clientId).success) throw badRequest('clientId must be the app registration\'s or managed identity\'s client id (a GUID).');
}

function checkProviderIds(provider: Provider, ids: ProviderIds): void {
  const spec = PROVIDER_ID_FIELDS[provider];
  const allowed = [...spec.required, ...spec.optional];
  for (const k of Object.keys(ids) as (keyof ProviderIds)[]) if (!allowed.includes(k)) throw badRequest(`${k} is not an id of a ${PROVIDER_NAMES[provider]} account.`);
  for (const k of spec.required) if (!ids[k]) throw badRequest(`A ${PROVIDER_NAMES[provider]} account needs ${k}.`);
}

interface RegionSpec {
  region: string;
  zone: string;
  geo: string;
  ceiling: Label;
}

function regionSpecs(provider: Provider, list: { region: string; ceiling?: Label | undefined }[]): RegionSpec[] {
  const seen = new Set<string>();
  return list.map((r) => {
    const c = catalogueRegion(provider, r.region);
    if (!c) throw badRequest(`${r.region} is not a ${PROVIDER_NAMES[provider]} region Exprsn-AI offers.`, { reason: 'unknown_region' });
    if (seen.has(r.region)) throw badRequest(`${r.region} is listed twice.`);
    seen.add(r.region);
    return { region: c.region, zone: c.zone, geo: c.geo, ceiling: r.ceiling ?? c.ceiling };
  });
}

// ---------- the service ----------

export class CloudAccounts {
  private schema: { ok: boolean; at: number } | null = null;

  constructor(private readonly s: () => Services) {}

  /** Whether migration 146 is applied (cached; rechecked every 30 seconds while it is not). */
  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < SCHEMA_RECHECK_MS)) return this.schema.ok;
    let ok = true;
    try {
      for (const name of TABLES) if (!(await this.s().db.schema.hasTable(name))) ok = false;
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  resetSchemaCache(): void {
    this.schema = null;
  }

  async need(): Promise<void> {
    if (!(await this.installed())) throw cloudMissing();
  }

  // ---------- who sees and changes what ----------

  /** A platform admin: `platform:manage` (system admins). */
  isPlatformAdmin(p: Principal): boolean {
    return authorize(p, 'platform:manage').allow;
  }

  /** Platform accounts are seen by the platform tenant's cloud readers and by platform admins. */
  private seesPlatform(p: Principal): boolean {
    return this.isPlatformAdmin(p) || p.tenantSlug === this.s().cfg.DEFAULT_TENANT;
  }

  canSee(p: Principal, a: Pick<CloudAccount, 'scope' | 'tenantId'>): boolean {
    if (this.isPlatformAdmin(p)) return true;
    return a.scope === 'platform' ? this.seesPlatform(p) : a.tenantId === p.tenantId;
  }

  /** Changing an account: its own tenant's cloud admin, or for a platform account one who also holds platform:manage. */
  assertCanChange(p: Principal, a: Pick<CloudAccount, 'scope' | 'tenantId' | 'name'>): void {
    if (a.scope === 'platform') {
      if (!this.isPlatformAdmin(p)) throw forbidden(`${a.name} is a platform account; changing it also needs platform:manage.`, { step: 'role', action: 'platform:manage' });
    } else if (a.tenantId !== p.tenantId) {
      throw forbidden('This account belongs to another tenant.', { step: 'tenant' });
    }
  }

  // ---------- reads ----------

  private async regionsOf(ids: string[]): Promise<Map<string, Region[]>> {
    const out = new Map<string, Region[]>();
    if (!ids.length) return out;
    const rows = (await this.s().db('cloud_account_regions').whereIn('account_id', ids).orderBy('region')) as Record<string, unknown>[];
    for (const r of rows) out.set(String(r.account_id), [...(out.get(String(r.account_id)) ?? []), regionFrom(r)]);
    return out;
  }

  private fromRow(r: Record<string, unknown>, regions: Region[]): CloudAccount {
    return {
      id: String(r.id),
      name: String(r.name),
      provider: r.provider as Provider,
      scope: r.scope === 'platform' ? 'platform' : 'tenant',
      tenantId: (r.tenant_id as string | null) ?? null,
      providerIds: json<ProviderIds>(r.provider_ids, {}),
      credentialMode: r.credential_mode as CredentialMode,
      defaultRegion: (r.default_region as string | null) ?? null,
      state: r.state as AccountState,
      description: (r.description as string | null) ?? null,
      regions: regions.map((x) => ({ ...x, isDefault: x.region === r.default_region })),
      validation: r.validation ? json<ValidationReport | null>(r.validation, null) : null,
      createdBy: (r.created_by as string | null) ?? null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at)
    };
  }

  /** One account by id, with no visibility check (for the cloud plane's own callers). Null when missing or not installed. */
  async get(id: string): Promise<CloudAccount | null> {
    if (!(await this.installed())) return null;
    const r = (await this.s().db('cloud_accounts').where({ id }).first()) as Record<string, unknown> | undefined;
    if (!r) return null;
    return this.fromRow(r, (await this.regionsOf([id])).get(id) ?? []);
  }

  /** One account the principal may see, else 404. */
  async getFor(p: Principal, id: string): Promise<CloudAccount> {
    await this.need();
    const a = await this.get(id);
    if (!a || !this.canSee(p, a)) throw notFound('Cloud account');
    return a;
  }

  /** The accounts a principal may see, or (no principal) every account. */
  async list(p: Principal | null, opts: { provider?: Provider; scope?: 'platform' | 'tenant'; state?: AccountState } = {}): Promise<CloudAccount[]> {
    await this.need();
    const q = this.s().db('cloud_accounts').orderBy('name');
    if (opts.provider) q.where({ provider: opts.provider });
    if (opts.scope) q.where({ scope: opts.scope });
    if (opts.state) q.where({ state: opts.state });
    if (p && !this.isPlatformAdmin(p)) {
      const platform = this.seesPlatform(p);
      q.where((w) => {
        w.where({ scope: 'tenant', tenant_id: p.tenantId });
        if (platform) w.orWhere({ scope: 'platform' });
      });
    }
    const rows = (await q) as Record<string, unknown>[];
    const regions = await this.regionsOf(rows.map((r) => String(r.id)));
    return rows.map((r) => this.fromRow(r, regions.get(String(r.id)) ?? []));
  }

  /** An account's allow-list of regions. */
  async regions(account: CloudAccount | string): Promise<Region[]> {
    if (typeof account !== 'string') return account.regions;
    return (await this.get(account))?.regions ?? [];
  }

  /** The stored credential of an account: references and parameters only (read by `cloud/credentials.ts`). */
  async credentialRef(accountId: string): Promise<CloudCredentialRef | null> {
    if (!(await this.installed())) return null;
    const r = (await this.s().db('cloud_credentials').where({ account_id: accountId }).first()) as Record<string, unknown> | undefined;
    if (!r) return null;
    return { accountId, mode: r.mode as CredentialMode, params: json<Record<string, string>>(r.params, {}), refs: json<Record<string, string>>(r.refs, {}), updatedAt: Number(r.updated_at) };
  }

  // ---------- regions, ceilings and residency (B-10008) ----------

  /** The tenant's residency geographies, or [] when none is set (then `confidential` goes nowhere in a cloud). */
  async residency(tenantId: string): Promise<ResidencyGeo[]> {
    if (!(await this.installed())) return [];
    const r = (await this.s().db('cloud_residency').where({ tenant_id: tenantId }).first()) as Record<string, unknown> | undefined;
    return r ? json<string[]>(r.geos, []).filter((g): g is ResidencyGeo => (RESIDENCY_GEOS as readonly string[]).includes(g)) : [];
  }

  private async platformTenantId(): Promise<string | null> {
    return (await this.s().tenants.bySlug(this.s().cfg.DEFAULT_TENANT))?.id ?? null;
  }

  private async resolve(account: CloudAccount | string): Promise<CloudAccount | null> {
    return typeof account === 'string' ? this.get(account) : account;
  }

  /** A region's effective ceiling on an account (the lower of its own and its zone's), or null when it is not allowed there. */
  async ceilingFor(account: CloudAccount | string, region: string): Promise<Label | null> {
    const a = await this.resolve(account);
    const r = a?.regions.find((x) => x.region === region);
    if (!r) return null;
    const zc = await this.s().zones.ceilingOf(r.zone).catch(() => null);
    return zc ? lower(r.ceiling, zc) : r.ceiling;
  }

  /**
   * The region as `authz/policy.ts` sees it, for `authorize` and `explain` (`Resource.region`), with the residency rule
   * for `label` worked out against the owning tenant (`tenantId`, else the account's, else the platform's).
   */
  async placementFor(account: CloudAccount | string, region: string, label: Label | undefined, opts: { tenantId?: string | null } = {}): Promise<RegionPlacement | null> {
    const a = await this.resolve(account);
    const r = a?.regions.find((x) => x.region === region);
    const ceiling = a ? await this.ceilingFor(a, region) : null;
    if (!a || !r || !ceiling) return null;
    const placement: RegionPlacement = { region: r.region, zone: r.zone, ceiling };
    if (label && labelRank(label) >= labelRank('confidential')) {
      const owner = opts.tenantId ?? a.tenantId ?? (await this.platformTenantId());
      const geos = owner ? await this.residency(owner) : [];
      const ok = (geos as string[]).includes(r.geo);
      placement.residency = {
        ok,
        detail: ok ? `Residency ${geos.join(', ')} admits ${r.region} (${r.geo})` : geos.length ? `${label} data stays in the tenant's residency (${geos.join(', ')}); ${r.region} is in ${r.geo}` : `${label} data may be placed only in regions of the tenant's residency, and none is set`
      };
    }
    return placement;
  }

  /** The decision for a placement, without throwing: account state, use, allow-list, ceiling, residency. */
  async checkRegion(account: CloudAccount | string, region: string, label: Label | undefined, opts: { tenantId?: string | null; use?: AccountUse } = {}): Promise<RegionDecision> {
    const deny = (step: RegionDecision['step'], reason: string, zone: string | null = null, ceiling: Label | null = null): RegionDecision => ({ allow: false, step, reason, region, zone, ceiling });
    if (!(await this.installed())) return deny('state', 'Cloud accounts are not installed (migration 146_cloud_accounts).');
    const a = await this.resolve(account);
    if (!a) return deny('state', 'The cloud account does not exist.');
    if (a.state === 'pending') return deny('state', `${a.name} waits for a second cloud admin and cannot be used until it is approved.`);
    if (a.state === 'disabled') return deny('state', `${a.name} is disabled.`);
    if (opts.use && a.scope === 'tenant' && !TENANT_ACCOUNT_USES.includes(opts.use)) return deny('use', `${a.name} is a tenant account: it may be used for data connections and model backends only, not for ${opts.use}.`);
    if (opts.tenantId && a.scope === 'tenant' && a.tenantId !== opts.tenantId) return deny('use', `${a.name} belongs to another tenant.`);
    const placement = await this.placementFor(a, region, label, opts);
    if (!placement) return deny('region', `${region} is not on ${a.name}'s allow-list of regions.`);
    const r = regionAdmits(label, placement);
    if (!r.ok) return deny(placement.residency && !placement.residency.ok && labelRank(label!) <= labelRank(placement.ceiling) ? 'residency' : 'ceiling', r.reason, placement.zone, placement.ceiling);
    return { allow: true, step: null, reason: r.reason, region, zone: placement.zone, ceiling: placement.ceiling };
  }

  /**
   * The one check every placement of data, a pool, a model entry or a deployment in a cloud region calls (B-10008).
   * Refuses (403, step `zone`, with the region, its zone and ceiling) anything above the region's ceiling or outside
   * the label's residency; returns the region with its effective ceiling.
   */
  async assertRegionAllows(account: CloudAccount | string, region: string, label: Label | undefined, opts: { tenantId?: string | null; use?: AccountUse } = {}): Promise<Region> {
    const d = await this.checkRegion(account, region, label, opts);
    if (!d.allow) throw forbidden(d.reason, { step: 'zone', check: d.step, region, zone: d.zone, ceiling: d.ceiling });
    const a = (await this.resolve(account))!;
    const r = a.regions.find((x) => x.region === region)!;
    return { ...r, ceiling: d.ceiling ?? r.ceiling };
  }

  /** Refuses a feature the last validation found missing permissions for, naming them (B-10007, B-10009). */
  assertFeature(account: CloudAccount, feature: CloudFeature): void {
    const f = account.validation?.features.find((x) => x.feature === feature);
    if (!account.validation) throw conflict(`${account.name} has not been validated yet; validate it before using ${FEATURE_NAMES[feature]}.`);
    if (!f || f.status === 'unsupported') throw new HttpProblem(409, 'Conflict', `${PROVIDER_NAMES[account.provider]} offers no ${FEATURE_NAMES[feature]}.`, { extensions: { reason: 'unsupported', feature } });
    if (f.status === 'missing') throw forbidden(`${account.name}'s credential lacks ${f.missing.join(', ')}, which ${FEATURE_NAMES[feature]} needs.`, { step: 'cloud-permission', feature, missing: f.missing });
    if (f.status === 'error') throw new HttpProblem(409, 'Conflict', `The permission check for ${FEATURE_NAMES[feature]} failed: ${f.reason ?? 'unknown error'}. Validate again.`, { extensions: { reason: 'check_failed', feature } });
  }

  // ---------- audit and notices ----------

  private audit(a: CloudActor, action: string, target: Record<string, unknown>, detail: Record<string, unknown>, tenantId?: string | null) {
    return this.s().audit.append({ tenantId: tenantId ?? a.principal.tenantId, action, kind: 'admin', actor: actorFrom(a.principal, a.ip), target, detail, ...(a.traceId ? { traceId: a.traceId } : {}) });
  }

  /** The active users of a tenant whose roles grant cloud:admin (and platform:manage, when asked). */
  async cloudAdmins(tenantId: string, platform = false): Promise<string[]> {
    const rows = (await this.s().db('users as u').join('user_roles as r', 'r.user_id', 'u.id').where({ 'u.tenant_id': tenantId, 'u.state': 'active' }).select('u.id', 'r.role')) as { id: string; role: string }[];
    const roles = new Map<string, string[]>();
    for (const r of rows) roles.set(r.id, [...(roles.get(r.id) ?? []), r.role]);
    return [...roles].filter(([, list]) => { const perms = permissionsFor(list, tenantId); return perms.has('cloud:admin') && (!platform || perms.has('platform:manage')); }).map(([id]) => id);
  }

  private async notify(tenantId: string, userIds: string[], title: string, body: string): Promise<void> {
    if (!userIds.length) return;
    await this.s()
      .notifications.notify({ tenantId, userIds, kind: 'cloud.proposal', title, body: body.slice(0, 300), route: 'cloud', label: 'internal' })
      .catch((err: unknown) => this.s().log.warn({ err }, 'cloud proposal notice failed'));
  }

  // ---------- proposals ----------

  private async propose(a: CloudActor, input: { kind: CloudProposalKind; account: CloudAccount | null; scope: 'platform' | 'tenant'; tenantId: string | null; summary: string; payload: Record<string, unknown>; needsPlatform: boolean }): Promise<CloudProposal> {
    const by = a.principal.userId;
    if (!by || a.principal.kind !== 'user') throw forbidden('Only a person can propose a cloud account change.', { step: 'credential' });
    const db = this.s().db;
    const scopeKey = input.scope === 'platform' ? PLATFORM_KEY : input.tenantId!;
    const q = db('cloud_account_proposals').where({ kind: input.kind, state: 'pending', scope_key: scopeKey });
    if (input.account) q.andWhere({ account_id: input.account.id });
    else q.whereNull('account_id');
    if (await q.first('id')) throw new HttpProblem(409, 'Conflict', 'A change of this kind is already waiting for approval; approve, reject or withdraw it first.', { extensions: { reason: 'proposal_pending' } });
    const row = {
      id: ulid(),
      kind: input.kind,
      account_id: input.account?.id ?? null,
      scope: input.scope,
      tenant_id: input.tenantId,
      scope_key: scopeKey,
      summary: input.summary.slice(0, 1000),
      payload: JSON.stringify(input.payload),
      needs_platform: input.needsPlatform,
      state: 'pending',
      proposed_by: by,
      proposed_tenant: a.principal.tenantId,
      proposed_at: Date.now(),
      decided_by: null,
      decided_at: null,
      note: null
    };
    await db('cloud_account_proposals').insert(row);
    await this.audit(a, 'cloud.proposal.created', { proposal: row.id, kind: input.kind, account: input.account?.id ?? null, name: input.account?.name ?? null }, { summary: row.summary, needsPlatformAdmin: input.needsPlatform }, input.tenantId);
    const admins = (await this.cloudAdmins(a.principal.tenantId, input.scope === 'platform' || input.needsPlatform)).filter((id) => id !== by);
    await this.notify(a.principal.tenantId, admins, `${input.account?.name ?? 'Residency'}: a cloud change waits for a second cloud admin`, input.summary);
    return proposalFrom(row);
  }

  /** The proposals a principal may see and decide: their tenant's, and the platform's (and every restricted override) for platform admins. */
  async proposals(p: Principal, opts: { state?: CloudProposal['state']; accountId?: string } = {}): Promise<CloudProposal[]> {
    await this.need();
    const q = this.s().db('cloud_account_proposals').orderBy('proposed_at', 'desc').limit(200);
    if (opts.state) q.where({ state: opts.state });
    if (opts.accountId) q.where({ account_id: opts.accountId });
    const platform = this.isPlatformAdmin(p);
    const seesPlatform = this.seesPlatform(p);
    q.where((w) => {
      w.where({ scope_key: p.tenantId });
      if (seesPlatform) w.orWhere({ scope_key: PLATFORM_KEY });
      if (platform) w.orWhere({ needs_platform: true });
    });
    return ((await q) as Record<string, unknown>[]).map(proposalFrom);
  }

  private async pendingProposal(p: Principal, id: string): Promise<CloudProposal> {
    await this.need();
    const r = (await this.s().db('cloud_account_proposals').where({ id }).first()) as Record<string, unknown> | undefined;
    const prop = r ? proposalFrom(r) : null;
    if (!prop || !(prop.tenantId === p.tenantId || (prop.scope === 'platform' && this.seesPlatform(p)) || (prop.needsPlatformAdmin && this.isPlatformAdmin(p)))) throw notFound('Proposal');
    if (prop.state !== 'pending') throw new HttpProblem(409, 'Conflict', `The proposal is ${prop.state}.`);
    return prop;
  }

  private decide(id: string, state: CloudProposal['state'], by: string | null, note: string | null) {
    return this.s().db('cloud_account_proposals').where({ id, state: 'pending' }).update({ state, decided_by: by, decided_at: Date.now(), note });
  }

  /** Approves and applies, as a second cloud admin (the route checked cloud:admin and a recent sign-in). */
  async approve(a: CloudActor, id: string, note: string | null): Promise<{ proposal: CloudProposal; account: CloudAccount | null }> {
    const p = a.principal;
    const prop = await this.pendingProposal(p, id);
    if (prop.proposedBy === p.userId) throw forbidden('Dual control: you cannot approve your own proposal. Another cloud admin must approve it.', { step: 'dual-control' });
    if ((prop.scope === 'platform' || prop.needsPlatformAdmin) && !this.isPlatformAdmin(p)) {
      throw forbidden(prop.scope === 'platform' ? 'This is a platform account: approving its changes also needs platform:manage.' : 'A restricted ceiling is a platform override: approving it needs platform:manage.', { step: 'role', action: 'platform:manage' });
    }
    if (prop.scope === 'tenant' && prop.tenantId !== p.tenantId && !prop.needsPlatformAdmin) throw notFound('Proposal');
    const account = prop.accountId ? await this.get(prop.accountId) : null;
    if (prop.accountId && !account) {
      await this.decide(prop.id, 'superseded', p.userId ?? null, 'The account no longer exists.');
      throw new HttpProblem(409, 'Conflict', 'The account no longer exists; the proposal was closed.');
    }
    if (!(await this.decide(prop.id, 'approved', p.userId ?? null, note))) throw new HttpProblem(409, 'Conflict', 'The proposal was decided by someone else.');
    try {
      await this.apply(a, prop, account);
    } catch (err) {
      await this.s().db('cloud_account_proposals').where({ id: prop.id }).update({ state: 'pending', decided_by: null, decided_at: null, note: null });
      throw err;
    }
    await this.audit(a, 'cloud.proposal.approved', { proposal: prop.id, kind: prop.kind, account: prop.accountId, name: account?.name ?? null }, { proposedBy: prop.proposedBy, summary: prop.summary, note }, prop.tenantId);
    const r = (await this.s().db('cloud_account_proposals').where({ id: prop.id }).first()) as Record<string, unknown>;
    const proposedTenant = String(r.proposed_tenant);
    await this.notify(proposedTenant, [prop.proposedBy], `${account?.name ?? 'Residency'}: your cloud change was approved`, prop.summary);
    return { proposal: proposalFrom(r), account: prop.accountId ? await this.get(prop.accountId) : null };
  }

  private async apply(a: CloudActor, prop: CloudProposal, account: CloudAccount | null): Promise<void> {
    const db = this.s().db;
    const t = Date.now();
    const pl = prop.payload;
    if (prop.kind === 'account.add') {
      if (!account || account.state !== 'pending') throw conflict('The account is no longer waiting for approval.');
      await db('cloud_accounts').where({ id: account.id, state: 'pending' }).update({ state: 'active', updated_at: t });
      await this.audit(a, 'cloud.account.created', { account: account.id, name: account.name, provider: account.provider }, { scope: account.scope, proposal: prop.id, proposedBy: prop.proposedBy }, account.tenantId);
      return;
    }
    if (prop.kind === 'account.remove') {
      // Its vaulted secrets and cached sessions go with it (`cloud/credentials.ts`); a failure there never keeps the account.
      try {
        await cloudCredentials(this.s()).forget(account!.id);
      } catch (err) {
        this.s().log.warn({ err, account: account!.id }, 'cloud credential forget failed');
      }
      await this.deleteRows(account!.id);
      await this.audit(a, 'cloud.account.removed', { account: account!.id, name: account!.name, provider: account!.provider }, { scope: account!.scope, proposal: prop.id, proposedBy: prop.proposedBy, reason: pl.reason ?? null }, account!.tenantId);
      return;
    }
    if (prop.kind === 'account.credential') {
      const cred = pl.credential as CredentialInput;
      await db.transaction(async (trx) => {
        await trx('cloud_credentials').where({ account_id: account!.id }).delete();
        await trx('cloud_credentials').insert({ account_id: account!.id, mode: cred.mode, params: JSON.stringify(cred.params), refs: JSON.stringify(cred.refs), updated_by: prop.proposedBy, updated_at: t });
        await trx('cloud_accounts').where({ id: account!.id }).update({ credential_mode: cred.mode, validation: null, validated_at: null, state: account!.state === 'attention' ? 'active' : account!.state, updated_at: t });
      });
      // B-10803: every instance drops the sessions, tokens and values bought with the old credential.
      this.dropCached(account!.id);
      await this.audit(a, 'cloud.credential.changed', { account: account!.id, name: account!.name }, { before: { mode: account!.credentialMode }, after: { mode: cred.mode, params: Object.keys(cred.params), refs: Object.keys(cred.refs) }, proposal: prop.id, proposedBy: prop.proposedBy }, account!.tenantId);
      return;
    }
    if (prop.kind === 'region.ceiling') {
      const list = pl.regions as RegionSpec[];
      for (const r of list) {
        const n = await db('cloud_account_regions').where({ account_id: account!.id, region: r.region }).update({ ceiling: r.ceiling, zone: r.zone, geo: r.geo, updated_at: t });
        if (!n) await db('cloud_account_regions').insert({ account_id: account!.id, region: r.region, zone: r.zone, geo: r.geo, ceiling: r.ceiling, is_default: false, updated_at: t });
      }
      await db('cloud_accounts').where({ id: account!.id }).update({ updated_at: t });
      await this.audit(a, 'cloud.region.ceiling.raised', { account: account!.id, name: account!.name }, { regions: list.map((r) => ({ region: r.region, ceiling: r.ceiling })), proposal: prop.id, proposedBy: prop.proposedBy }, account!.tenantId);
      return;
    }
    // residency
    const tenantId = String(pl.tenantId);
    const geos = pl.geos as string[];
    await this.writeResidency(tenantId, geos, prop.proposedBy);
    await this.audit(a, 'cloud.residency.updated', { residency: tenantId }, { before: pl.before ?? [], after: geos, proposal: prop.id, proposedBy: prop.proposedBy }, tenantId);
  }

  /** B-10803: every instance forgets the account's cached sessions, tokens and values (when this build has the credentials part). */
  private dropCached(accountId: string): void {
    try {
      cloudCredentials(this.s()).changed(accountId);
    } catch {
      // No credential part (a test stand-in): nothing is cached.
    }
  }

  /** B-10803: a refused or withdrawn add takes its staged secrets, state and cached credentials with it. */
  private async dropAdded(accountId: string): Promise<void> {
    try {
      await cloudCredentials(this.s()).forget(accountId);
    } catch (err) {
      this.s().log.warn({ err, account: accountId }, 'cloud credential forget failed');
    }
    await this.deleteRows(accountId);
  }

  private async deleteRows(accountId: string): Promise<void> {
    await this.s().db.transaction(async (trx) => {
      await trx('cloud_account_regions').where({ account_id: accountId }).delete();
      await trx('cloud_credentials').where({ account_id: accountId }).delete();
      await trx('cloud_accounts').where({ id: accountId }).delete();
    });
  }

  /** Rejects: a rejected add removes the waiting account (nothing was ever usable). */
  async reject(a: CloudActor, id: string, note: string | null): Promise<CloudProposal> {
    const prop = await this.pendingProposal(a.principal, id);
    if (prop.proposedBy === a.principal.userId) throw new HttpProblem(409, 'Conflict', 'This is your own proposal: withdraw it instead.');
    if ((prop.scope === 'platform') && !this.isPlatformAdmin(a.principal)) throw forbidden('This is a platform account: deciding its changes also needs platform:manage.', { step: 'role', action: 'platform:manage' });
    if (!(await this.decide(prop.id, 'rejected', a.principal.userId ?? null, note))) throw new HttpProblem(409, 'Conflict', 'The proposal was decided by someone else.');
    if (prop.kind === 'account.add' && prop.accountId) await this.dropAdded(prop.accountId);
    await this.audit(a, 'cloud.proposal.rejected', { proposal: prop.id, kind: prop.kind, account: prop.accountId }, { proposedBy: prop.proposedBy, note }, prop.tenantId);
    return { ...prop, state: 'rejected', decidedBy: a.principal.userId ?? null, decidedAt: Date.now(), note };
  }

  async withdraw(a: CloudActor, id: string): Promise<CloudProposal> {
    const prop = await this.pendingProposal(a.principal, id);
    if (prop.proposedBy !== a.principal.userId) throw forbidden('Only the admin who proposed a change can withdraw it; reject it instead.', { step: 'dual-control' });
    if (!(await this.decide(prop.id, 'withdrawn', a.principal.userId ?? null, null))) throw new HttpProblem(409, 'Conflict', 'The proposal was decided by someone else.');
    if (prop.kind === 'account.add' && prop.accountId) await this.dropAdded(prop.accountId);
    await this.audit(a, 'cloud.proposal.withdrawn', { proposal: prop.id, kind: prop.kind, account: prop.accountId }, {}, prop.tenantId);
    return { ...prop, state: 'withdrawn', decidedBy: a.principal.userId ?? null, decidedAt: Date.now() };
  }

  // ---------- changes ----------

  /** Adds an account as `pending` with a proposal for a second cloud admin (B-10002). */
  async add(a: CloudActor, input: AddAccountInput): Promise<{ account: CloudAccount; proposal: CloudProposal }> {
    await this.need();
    const p = a.principal;
    if (input.scope === 'platform' && !this.isPlatformAdmin(p)) throw forbidden('Only a platform admin (platform:manage) may add a platform account; a tenant admin adds tenant accounts.', { step: 'role', action: 'platform:manage' });
    checkProviderIds(input.provider, input.providerIds);
    checkCredential(input.provider, input.providerIds, input.credential);
    const regions = regionSpecs(input.provider, input.regions);
    const defaultRegion = input.defaultRegion ?? regions[0]!.region;
    if (!regions.some((r) => r.region === defaultRegion)) throw badRequest(`The default region ${defaultRegion} is not on the account's allow-list.`);
    const tenantId = input.scope === 'tenant' ? p.tenantId : null;
    const scopeKey = tenantId ?? PLATFORM_KEY;
    const db = this.s().db;
    if (await db('cloud_accounts').where({ scope_key: scopeKey, name: input.name }).first('id')) throw conflict(`An account named ${input.name} already exists in this scope.`);
    const t = Date.now();
    const id = ulid();
    await db.transaction(async (trx) => {
      await trx('cloud_accounts').insert({
        id,
        name: input.name,
        provider: input.provider,
        scope: input.scope,
        tenant_id: tenantId,
        scope_key: scopeKey,
        provider_ids: JSON.stringify(input.providerIds),
        credential_mode: input.credential.mode,
        default_region: defaultRegion,
        state: 'pending',
        description: input.description ?? null,
        validation: null,
        validated_at: null,
        created_by: p.userId,
        created_tenant: p.tenantId,
        created_at: t,
        updated_at: t
      });
      for (const r of regions) await trx('cloud_account_regions').insert({ account_id: id, region: r.region, zone: r.zone, geo: r.geo, ceiling: r.ceiling, is_default: r.region === defaultRegion, updated_at: t });
      await trx('cloud_credentials').insert({ account_id: id, mode: input.credential.mode, params: JSON.stringify(input.credential.params), refs: JSON.stringify(input.credential.refs), updated_by: p.userId, updated_at: t });
    });
    const account = (await this.get(id))!;
    const restricted = regions.some((r) => r.ceiling === 'restricted');
    const summary = `Add the ${PROVIDER_NAMES[input.provider]} ${input.scope} account ${input.name} (${input.credential.mode}), regions ${regions.map((r) => `${r.region} at ${r.ceiling}`).join(', ')}.${input.reason ? ` Reason: ${input.reason}` : ''}`;
    let proposal: CloudProposal;
    try {
      proposal = await this.propose(a, { kind: 'account.add', account, scope: input.scope, tenantId, summary, payload: { name: input.name, provider: input.provider, regions: regions.map((r) => ({ region: r.region, ceiling: r.ceiling })) }, needsPlatform: restricted });
    } catch (err) {
      await this.deleteRows(id);
      throw err;
    }
    await this.audit(a, 'cloud.account.proposed', { account: id, name: input.name, provider: input.provider }, { scope: input.scope, mode: input.credential.mode, regions: regions.map((r) => r.region), proposal: proposal.id }, tenantId);
    return { account, proposal };
  }

  /**
   * Changes an account. Immediate: description, default region, disable and enable, removing regions, adding a region
   * or lowering a ceiling at or below where regions start, and a new credential of the same mode. Proposals: a
   * credential of another mode, and a raised ceiling (or a new region above the start ceiling).
   */
  async update(a: CloudActor, id: string, input: PatchAccountInput): Promise<{ account: CloudAccount; proposals: CloudProposal[] }> {
    const acct = await this.getFor(a.principal, id);
    this.assertCanChange(a.principal, acct);
    if (acct.state === 'pending') throw conflict(`${acct.name} waits for approval; it can be changed once it is approved (or withdraw it and add it again).`);
    const db = this.s().db;
    const t = Date.now();
    const proposals: CloudProposal[] = [];
    const changes: Record<string, unknown> = {};
    const patch: Record<string, unknown> = {};
    if (input.description !== undefined && input.description !== acct.description) { patch.description = input.description; changes.description = { before: acct.description, after: input.description }; }
    if (input.state && input.state !== (acct.state === 'disabled' ? 'disabled' : 'active')) {
      patch.state = input.state;
      changes.state = { before: acct.state, after: input.state };
      // B-10803 (the credential-compromise runbook): a disabled account's cached sessions and tokens go on every instance.
      if (input.state === 'disabled') this.dropCached(acct.id);
    }

    let regionsAfter = acct.regions.map((r) => r.region);
    if (input.regions) {
      const wanted = regionSpecs(acct.provider, input.regions);
      const now = new Map(acct.regions.map((r) => [r.region, r]));
      const raise: RegionSpec[] = [];
      const immediate: RegionSpec[] = [];
      for (const w of wanted) {
        const cur = now.get(w.region);
        const startsAt = cur?.ceiling ?? START_CEILING;
        const explicit = input.regions.find((x) => x.region === w.region)?.ceiling;
        const ceiling = explicit ?? cur?.ceiling ?? w.ceiling;
        if (labelRank(ceiling) > labelRank(startsAt)) raise.push({ ...w, ceiling });
        else immediate.push({ ...w, ceiling });
        if (!cur && labelRank(ceiling) > labelRank(START_CEILING)) immediate.push({ ...w, ceiling: START_CEILING });
      }
      const removed = acct.regions.filter((r) => !wanted.some((w) => w.region === r.region)).map((r) => r.region);
      regionsAfter = wanted.map((w) => w.region);
      await db.transaction(async (trx) => {
        if (removed.length) await trx('cloud_account_regions').where({ account_id: acct.id }).whereIn('region', removed).delete();
        for (const r of immediate) {
          const n = await trx('cloud_account_regions').where({ account_id: acct.id, region: r.region }).update({ ceiling: r.ceiling, updated_at: t });
          if (!n) await trx('cloud_account_regions').insert({ account_id: acct.id, region: r.region, zone: r.zone, geo: r.geo, ceiling: r.ceiling, is_default: false, updated_at: t });
        }
      });
      const before = acct.regions.map((r) => ({ region: r.region, ceiling: r.ceiling }));
      const after = (await this.regions(acct.id)).map((r) => ({ region: r.region, ceiling: r.ceiling }));
      if (JSON.stringify(before) !== JSON.stringify(after)) changes.regions = { before, after };
      if (raise.length) {
        proposals.push(await this.propose(a, { kind: 'region.ceiling', account: acct, scope: acct.scope, tenantId: acct.tenantId, summary: `Raise the label ceiling of ${raise.map((r) => `${r.region} to ${r.ceiling}`).join(', ')} on ${acct.name}.${input.reason ? ` Reason: ${input.reason}` : ''}`, payload: { regions: raise }, needsPlatform: raise.some((r) => r.ceiling === 'restricted') }));
      }
    }
    const defaultRegion = input.defaultRegion ?? (acct.defaultRegion && regionsAfter.includes(acct.defaultRegion) ? acct.defaultRegion : regionsAfter[0]);
    if (defaultRegion && !regionsAfter.includes(defaultRegion)) throw badRequest(`The default region ${defaultRegion} is not on the account's allow-list.`);
    if (defaultRegion !== acct.defaultRegion) { patch.default_region = defaultRegion; changes.defaultRegion = { before: acct.defaultRegion, after: defaultRegion }; }

    if (input.credential) {
      checkCredential(acct.provider, acct.providerIds, input.credential);
      if (input.credential.mode !== acct.credentialMode) {
        proposals.push(await this.propose(a, { kind: 'account.credential', account: acct, scope: acct.scope, tenantId: acct.tenantId, summary: `Change ${acct.name}'s credentials from ${acct.credentialMode} to ${input.credential.mode}.${input.reason ? ` Reason: ${input.reason}` : ''}`, payload: { credential: input.credential }, needsPlatform: false }));
      } else {
        await db('cloud_credentials').where({ account_id: acct.id }).update({ params: JSON.stringify(input.credential.params), refs: JSON.stringify(input.credential.refs), updated_by: a.principal.userId, updated_at: t });
        patch.validation = null;
        patch.validated_at = null;
        changes.credential = { mode: input.credential.mode, params: Object.keys(input.credential.params), refs: Object.keys(input.credential.refs) };
        this.dropCached(acct.id);
      }
    }
    if (Object.keys(patch).length) await db('cloud_accounts').where({ id: acct.id }).update({ ...patch, updated_at: t });
    if (Object.keys(changes).length) await this.audit(a, 'cloud.account.updated', { account: acct.id, name: acct.name }, { changes, ...(input.reason ? { reason: input.reason } : {}) }, acct.tenantId);
    return { account: (await this.get(acct.id))!, proposals };
  }

  /** Proposes removing an account (B-10002). Nothing in the cloud is deleted; Exprsn-AI stops managing it. */
  async remove(a: CloudActor, id: string, reason: string | null): Promise<CloudProposal> {
    const acct = await this.getFor(a.principal, id);
    this.assertCanChange(a.principal, acct);
    if (acct.state === 'pending') throw conflict(`${acct.name} waits for approval; withdraw or reject that proposal instead.`);
    return this.propose(a, { kind: 'account.remove', account: acct, scope: acct.scope, tenantId: acct.tenantId, summary: `Disconnect ${acct.name} (${PROVIDER_NAMES[acct.provider]}). Nothing in the cloud is deleted.${reason ? ` Reason: ${reason}` : ''}`, payload: { reason }, needsPlatform: false });
  }

  /** Sets the tenant's residency: narrowing applies at once, widening (or the first one) is a proposal. */
  async setResidency(a: CloudActor, geos: ResidencyGeo[], reason: string | null): Promise<{ geos: ResidencyGeo[]; proposal: CloudProposal | null }> {
    await this.need();
    const tenantId = a.principal.tenantId;
    const before = await this.residency(tenantId);
    const after = [...new Set(geos)].sort();
    const widened = after.some((g) => !before.includes(g));
    if (widened) {
      const proposal = await this.propose(a, { kind: 'residency', account: null, scope: 'tenant', tenantId, summary: `Set the tenant's residency to ${after.join(', ') || 'none'}: confidential data may then be placed in those regions.${reason ? ` Reason: ${reason}` : ''}`, payload: { tenantId, geos: after, before }, needsPlatform: false });
      return { geos: before, proposal };
    }
    if (after.join() !== before.join()) {
      await this.writeResidency(tenantId, after, a.principal.userId ?? null);
      await this.audit(a, 'cloud.residency.updated', { residency: tenantId }, { before, after, ...(reason ? { reason } : {}) });
    }
    return { geos: after, proposal: null };
  }

  private async writeResidency(tenantId: string, geos: string[], by: string | null): Promise<void> {
    const db = this.s().db;
    const t = Date.now();
    const n = await db('cloud_residency').where({ tenant_id: tenantId }).update({ geos: JSON.stringify(geos), updated_by: by, updated_at: t });
    if (!n) await db('cloud_residency').insert({ tenant_id: tenantId, geos: JSON.stringify(geos), updated_by: by, updated_at: t });
  }

  /** Keeps a validation's report and moves the account between `active` and `attention` (a pending account stays pending). */
  async recordValidation(a: CloudActor, account: CloudAccount, report: ValidationReport): Promise<CloudAccount> {
    const state: AccountState = account.state === 'active' || account.state === 'attention' ? (report.ok ? 'active' : 'attention') : account.state;
    await this.s().db('cloud_accounts').where({ id: account.id }).update({ validation: JSON.stringify(report), validated_at: report.at, state, updated_at: Date.now() });
    await this.audit(a, 'cloud.account.validated', { account: account.id, name: account.name, provider: account.provider }, { ok: report.ok, identity: { ok: report.identity.ok, requestId: report.identity.requestId ?? null }, missing: report.features.filter((f) => f.missing.length).map((f) => ({ feature: f.feature, missing: f.missing })), state }, account.tenantId);
    return (await this.get(account.id))!;
  }

  /** What the console and the API get for an account: references for cloud admins, field names for everyone else. */
  async view(p: Principal, account: CloudAccount): Promise<CloudAccount & { credential: { mode: CredentialMode; params: Record<string, string>; refs: Record<string, string> | string[] } | null; federation: string | null; pending: CloudProposal[]; mayChange: boolean }> {
    const cred = await this.credentialRef(account.id);
    const admin = authorize(p, 'cloud:admin').allow;
    const pending = (await this.s().db('cloud_account_proposals').where({ account_id: account.id, state: 'pending' }).orderBy('proposed_at')) as Record<string, unknown>[];
    let mayChange = admin;
    try { this.assertCanChange(p, account); } catch { mayChange = false; }
    return {
      ...account,
      credential: cred ? { mode: cred.mode, params: cred.params, refs: admin ? cred.refs : Object.keys(cred.refs) } : null,
      federation: federationUnavailable(account.provider),
      pending: pending.map(proposalFrom),
      mayChange
    };
  }
}

/** True for a use a tenant-scoped account may serve (open decision 6). */
export const tenantMayUse = (use: AccountUse): boolean => TENANT_ACCOUNT_USES.includes(use);
