import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import type { InstanceRow, ModelRow } from '../gateway/repo.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { EXTERNAL_ZONE, isExternal, parseCidr, type ZoneSpec } from '../zones/spec.js';
import { DEFAULT_CLOUD_MODEL_CEILING, type CloudModelEntry } from './model-import.js';
import { isCloudInstance, providerOf } from './model-prices.js';

/*
 * 1.9.99-final, Sprint 61 (B-10507): residency and egress of cloud model calls (`s.cloud.modelResidency`).
 *
 * Scope of an entry (or of a cloud instance's model without one):
 *   regional       runs in one region: a Bedrock model id, an Azure `Standard` deployment;
 *   cross-region   may run in any region of a set: a Bedrock inference profile (`eu.`, `us.`...), an Azure
 *                  `DataZoneStandard` deployment;
 *   global         may run anywhere: a Bedrock `global.` profile, an Azure `GlobalStandard` deployment, DigitalOcean's
 *                  serverless endpoint (no region pinned) and Workers AI (Cloudflare's edge).
 * By default (open decision 5) a cross-region or global model is refused for anything above `internal`: at import its
 * ceiling stays `internal`, an attestation cannot raise it, and at call time a request labelled above `internal`
 * never reaches it, whatever the model's own label. A Bedrock global profile stays refused for every label (its
 * regions cannot be held to the account's allow-list).
 *
 * Before every call on a cloud instance (the lease client `withResidency` the gateway hands out), the request's own
 * label is checked: the scope rule; the entry's ceiling; each region the model may run in against the account's
 * allow-list, ceiling and residency (`checkRegion`); and the egress zone: once zones are defined, a cloud model call
 * leaves only from a pool in a zone whose egress allow-list reaches outside (the external zone, or a CIDR that covers
 * the internet), so a pool in a closed zone never calls out. Decisions are kept 30 seconds per instance, model and
 * label, so a region removed from the allow-list stops the model within that time.
 *
 * Attestations: the account's data terms for one entry (no training on prompts and outputs, retention, abuse
 * monitoring, where they are stated), proposed by one cloud admin and approved by another (migration 163). An active
 * attestation raises a regional entry's ceiling to `confidential` (bounded by its regions' ceilings), never
 * `restricted`; revoking it drops the ceiling back to `internal` and lowers the model's label with it.
 */

export type CloudScope = 'regional' | 'cross-region' | 'global';
export const SCOPE_CAP: Label = 'internal';
const CHECK_TTL_MS = 30_000;

export const attestationTermsSchema = z
  .object({
    /** The provider does not train on prompts or outputs. */
    noTraining: z.literal(true),
    /** How long prompts and outputs are kept (0: not stored), in days. */
    retentionDays: z.number().int().min(0).max(3650),
    /** Abuse monitoring: `off` (an approved exemption), `standard` (the provider may review flagged content). */
    abuseMonitoring: z.enum(['off', 'standard']),
    /** Where the terms are stated (the provider's service terms, a data processing addendum). */
    reference: z.string().trim().url().max(300),
    note: z.string().trim().max(500).nullable().default(null)
  })
  .strict();
export type AttestationTerms = z.infer<typeof attestationTermsSchema>;

export interface Attestation {
  id: string;
  modelId: string;
  accountId: string;
  terms: AttestationTerms;
  state: 'proposed' | 'active' | 'rejected' | 'revoked' | 'superseded';
  proposedBy: string;
  proposedAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  note: string | null;
}

const fromRow = (r: Record<string, unknown>): Attestation => ({
  id: String(r.id),
  modelId: String(r.model_id),
  accountId: String(r.account_id),
  terms: json<AttestationTerms>(r.terms, null as never),
  state: r.state as Attestation['state'],
  proposedBy: String(r.proposed_by),
  proposedAt: Number(r.proposed_at),
  decidedBy: (r.decided_by as string | null) ?? null,
  decidedAt: r.decided_at == null ? null : Number(r.decided_at),
  note: (r.note as string | null) ?? null
});

/** The scope of a cloud entry (or listing): regional, cross-region or global. */
export function scopeOf(e: Pick<CloudModelEntry, 'flavour' | 'offer' | 'routesTo' | 'externalId'> & { details?: Record<string, unknown> }): CloudScope {
  if (e.flavour === 'digitalocean' || e.flavour === 'workers-ai') return 'global';
  if (e.flavour === 'azure') {
    const sku = String(e.details?.sku ?? '');
    return /^global/i.test(sku) ? 'global' : /^datazone/i.test(sku) ? 'cross-region' : 'regional';
  }
  if (e.routesTo.includes('*') || /^global\./.test(e.externalId)) return 'global';
  if (e.offer === 'inference_profile' || e.routesTo.length > 1) return 'cross-region';
  return 'regional';
}

/** The scope of a model on a cloud instance that has no entry (registered from the instance directly). */
export function instanceScope(row: Pick<InstanceRow, 'kind' | 'settings'>, model: string): CloudScope {
  const p = providerOf(row);
  if (p === 'digitalocean' || p === 'cloudflare') return 'global';
  if (p === 'aws') {
    if (/^global\./.test(model)) return 'global';
    if (/^(us|eu|apac|us-gov|ca|jp|au)\./.test(model)) return 'cross-region';
    // B-10803: an ARN is regional only when it names a foundation model; an (application) inference profile may route anywhere.
    if (/^arn:/.test(model)) return /:foundation-model\//.test(model) ? 'regional' : 'cross-region';
    return 'regional';
  }
  // B-10803: fail closed. Without its own catalogue entry nothing says whether an Azure deployment is Standard,
  // DataZone or GlobalStandard, so it is treated as cross-region (nothing above internal) until it is imported.
  return 'cross-region';
}

/** Whether a zone's egress reaches outside: the external zone, or a CIDR that covers the internet. */
export function zoneHasEgress(spec: Pick<ZoneSpec, 'egress'>, zones: Map<string, { spec: Pick<ZoneSpec, 'trust'> }>): boolean {
  if (spec.egress.mode !== 'allow-list') return false;
  return spec.egress.allow.some((t) => {
    if (t.kind === 'zone' && t.zone) {
      const z = zones.get(t.zone);
      return t.zone === EXTERNAL_ZONE || (z ? isExternal(t.zone, z.spec as never) : false);
    }
    if (t.kind === 'cidr' && t.cidr) return parseCidr(t.cidr)?.prefix === 0;
    return false;
  });
}

export { withResidency } from '../gateway/residency-client.js';

export class CloudModelResidency {
  private schema: { ok: boolean; at: number } | null = null;
  private readonly decided = new Map<string, { at: number; error: unknown }>();

  constructor(private readonly s: () => Services) {}

  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < 30_000)) return this.schema.ok;
    let ok: boolean;
    try {
      ok = await this.s().db.schema.hasTable('cloud_model_attestations');
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  resetSchemaCache(): void {
    this.schema = null;
  }

  /** Forgets the kept decisions (tests, and a change that should apply at once). */
  reset(): void {
    this.decided.clear();
  }

  // ---------- the call-time check ----------

  /** Refuses (403) a call whose request label the model's scope, entry, regions or egress zone does not admit. */
  async check(row: InstanceRow, modelName: string, label: Label): Promise<void> {
    if (!isCloudInstance(row)) return;
    const key = `${row.id}|${modelName}|${label}`;
    const kept = this.decided.get(key);
    if (kept && Date.now() - kept.at < CHECK_TTL_MS) {
      if (kept.error) throw kept.error;
      return;
    }
    let error: unknown = null;
    try {
      await this.decide(row, modelName, label);
    } catch (err) {
      if (!(err instanceof HttpProblem)) throw err;
      error = err;
    }
    this.decided.set(key, { at: Date.now(), error });
    if (error) throw error;
  }

  private async decide(row: InstanceRow, modelName: string, label: Label): Promise<void> {
    const s = this.s();
    await this.assertEgress(row);
    const c = row.settings.cloud;
    if (!c) return;
    const model = await s.gateway.repo.modelByName(modelName).catch(() => undefined);
    const entry = model ? await s.cloud.modelImport.entry(model.id).catch(() => null) : null;
    const own = entry && entry.accountId === c.accountId ? entry : null;
    const scope = own ? scopeOf(own) : instanceScope(row, modelName);
    if (scope !== 'regional' && labelRank(label) > labelRank(SCOPE_CAP)) throw forbidden(`${modelName} is a ${scope} model: it may run outside one region, so it serves nothing above ${SCOPE_CAP} (this request is ${label}).`, { step: 'zone', check: 'residency', scope, region: own?.region ?? c.region });
    if (own && labelRank(label) > labelRank(own.ceiling)) throw forbidden(`${modelName}'s cloud entry has the ceiling ${own.ceiling}; a ${label} request cannot use it.`, { step: 'zone', check: 'ceiling', region: own.region, ceiling: own.ceiling });
    // Regions: the entry's (an inference profile's set), else the instance's. A global scope has no region to hold.
    const regions = own ? own.routesTo : [c.region];
    for (const r of regions) {
      if (r === '*') continue;
      const d = await s.cloud.accounts.checkRegion(c.accountId, r, label, { use: 'models' });
      if (!d.allow) throw forbidden(`${modelName} may run in ${r}: ${d.reason}`, { step: 'zone', check: d.step, region: r, zone: d.zone, ceiling: d.ceiling });
    }
  }

  /** Once zones are defined, a cloud model call leaves only from a pool in a zone with egress (the egress zone). */
  async assertEgress(row: InstanceRow): Promise<void> {
    const s = this.s();
    const zones = await s.zones.current().catch(() => new Map());
    if (!zones.size) return;
    const pool = await s.gateway.repo.pool(row.pool_id);
    if (!pool) return;
    const z = zones.get(pool.zone) as { spec: Parameters<typeof zoneHasEgress>[0] } | undefined;
    if (!z || !zoneHasEgress(z.spec, zones as never)) throw forbidden(`${pool.name} is in the ${pool.zone} zone, which has no egress: cloud model calls leave only through a zone whose egress reaches outside.`, { step: 'zone', check: 'egress', zone: pool.zone });
  }

  /** What the model card shows of a cloud entry's residency. */
  async view(entry: CloudModelEntry, label: Label) {
    const scope = scopeOf(entry);
    const att = await this.active(entry.modelId);
    const account = await this.s().cloud.accounts.get(entry.accountId).catch(() => null);
    const regions = [];
    for (const r of entry.routesTo) {
      if (r === '*') {
        regions.push({ region: '*', allowed: false, ceiling: null, reason: 'any region (a global profile)' });
        continue;
      }
      const d = account ? await this.s().cloud.accounts.checkRegion(account, r, label, { use: 'models' }) : null;
      regions.push({ region: r, allowed: !!d?.allow, ceiling: d?.ceiling ?? null, reason: d && !d.allow ? d.reason : null });
    }
    return { scope, cap: scope === 'regional' ? null : SCOPE_CAP, ceiling: entry.ceiling, regions, attestation: att ? attestationView(att) : null, pending: (await this.list({ modelId: entry.modelId })).filter((a) => a.state === 'proposed').map(attestationView) };
  }

  // ---------- attestations (dual control) ----------

  private async need(): Promise<void> {
    await this.s().cloud.accounts.need();
    if (!(await this.installed())) throw new HttpProblem(503, 'Service unavailable', 'Data-terms attestations are not installed yet (migration 163_cloud_model_prices).', { extensions: { reason: 'migration_pending' } });
    if (!(await this.s().cloud.modelImport.installed())) throw new HttpProblem(503, 'Service unavailable', 'Cloud model entries are not installed yet (migration 159_cloud_models).', { extensions: { reason: 'migration_pending' } });
  }

  async list(o: { modelId?: string; accountId?: string } = {}): Promise<Attestation[]> {
    if (!(await this.installed())) return [];
    const q = this.s().db('cloud_model_attestations').orderBy('proposed_at', 'desc').limit(500);
    if (o.modelId) q.where({ model_id: o.modelId });
    if (o.accountId) q.where({ account_id: o.accountId });
    return ((await q) as Record<string, unknown>[]).map(fromRow);
  }

  async active(modelId: string): Promise<Attestation | null> {
    if (!(await this.installed())) return null;
    const r = (await this.s().db('cloud_model_attestations').where({ model_id: modelId, state: 'active' }).orderBy('decided_at', 'desc').first()) as Record<string, unknown> | undefined;
    return r ? fromRow(r) : null;
  }

  /** Whether an entry's data terms are attested (an active attestation), for the import's ceiling. */
  async attested(modelId: string): Promise<boolean> {
    return !!(await this.active(modelId));
  }

  private async entryFor(p: Principal, modelId: string): Promise<{ entry: CloudModelEntry; model: ModelRow }> {
    const s = this.s();
    const entry = await s.cloud.modelImport.entry(modelId);
    const model = await s.gateway.repo.model(modelId);
    if (!entry || !model) throw notFound('Cloud model entry');
    await s.cloud.accounts.getFor(p, entry.accountId);
    return { entry, model };
  }

  /** A cloud admin states the account's data terms for an entry; nothing changes until a second one approves. */
  async propose(p: Principal, modelId: string, terms: AttestationTerms, ctx: { ip?: string | null; traceId?: string } = {}): Promise<Attestation> {
    await this.need();
    if (!p.userId) throw forbidden('Only a person can attest data terms.', { step: 'credential' });
    const { entry, model } = await this.entryFor(p, modelId);
    const scope = scopeOf(entry);
    if (scope !== 'regional') throw conflict(`${model.name} is a ${scope} model; it stays at ${SCOPE_CAP} whatever the data terms (open decision 5), so there is nothing to attest.`);
    if ((await this.list({ modelId })).some((a) => a.state === 'proposed')) throw conflict(`An attestation for ${model.name} is waiting for a second cloud admin.`);
    const now = Date.now();
    const row = { id: ulid(), model_id: modelId, account_id: entry.accountId, terms: JSON.stringify(terms), state: 'proposed', proposed_by: p.userId, proposed_tenant: p.tenantId, proposed_at: now, decided_by: null, decided_at: null, note: terms.note ?? null };
    await this.s().db('cloud_model_attestations').insert(row);
    await this.s().audit.append({ tenantId: p.tenantId, action: 'cloud.model.attestation.proposed', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { model: model.name, attestation: row.id }, detail: { account: entry.accountId, region: entry.region, noTraining: terms.noTraining, retentionDays: terms.retentionDays, abuseMonitoring: terms.abuseMonitoring, reference: terms.reference }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    return fromRow(row);
  }

  private async one(id: string): Promise<Attestation> {
    const r = (await this.s().db('cloud_model_attestations').where({ id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Attestation');
    return fromRow(r);
  }

  /** The ceiling of an entry with or without attested terms: its regions' lowest, capped (open decision 5). */
  private async ceiling(entry: CloudModelEntry, attested: boolean): Promise<Label> {
    const account = await this.s().cloud.accounts.get(entry.accountId);
    if (!account) return DEFAULT_CLOUD_MODEL_CEILING;
    const c = await this.s().cloud.modelImport.ceilingOf(account, entry.routesTo, attested && scopeOf(entry) === 'regional');
    return c.ceiling ?? DEFAULT_CLOUD_MODEL_CEILING;
  }

  /** A second cloud admin approves: the attestation is active and the entry's ceiling rises (at most `confidential`). */
  async approve(p: Principal, id: string, ctx: { ip?: string | null; traceId?: string } = {}): Promise<{ attestation: Attestation; ceiling: Label }> {
    await this.need();
    const a = await this.one(id);
    if (a.state !== 'proposed') throw conflict(`This attestation is ${a.state}.`);
    if (a.proposedBy === p.userId) throw forbidden('Dual control: someone other than the cloud admin who stated the terms must approve them.', { step: 'role', reason: 'dual_control' });
    const { entry, model } = await this.entryFor(p, a.modelId);
    const now = Date.now();
    const db = this.s().db;
    await db('cloud_model_attestations').where({ model_id: a.modelId, state: 'active' }).update({ state: 'superseded', decided_at: now });
    await db('cloud_model_attestations').where({ id }).update({ state: 'active', decided_by: p.userId, decided_at: now });
    const ceiling = await this.ceiling(entry, true);
    await db('cloud_model_entries').where({ model_id: entry.modelId }).update({ label_ceiling: ceiling, updated_at: now });
    this.reset();
    await this.s().audit.append({ tenantId: p.tenantId, action: 'cloud.model.attestation.approved', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { model: model.name, attestation: id }, detail: { proposedBy: a.proposedBy, ceiling: { from: entry.ceiling, to: ceiling } }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    return { attestation: await this.one(id), ceiling };
  }

  /** Rejects a proposed attestation (another admin), or withdraws one (the proposer). */
  async reject(p: Principal, id: string, ctx: { ip?: string | null; traceId?: string; note?: string | null } = {}): Promise<Attestation> {
    await this.need();
    const a = await this.one(id);
    if (a.state !== 'proposed') throw conflict(`This attestation is ${a.state}.`);
    const { model } = await this.entryFor(p, a.modelId);
    await this.s().db('cloud_model_attestations').where({ id }).update({ state: 'rejected', decided_by: p.userId, decided_at: Date.now(), ...(ctx.note ? { note: ctx.note.slice(0, 500) } : {}) });
    await this.s().audit.append({ tenantId: p.tenantId, action: 'cloud.model.attestation.rejected', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { model: model.name, attestation: id }, detail: { withdrawn: a.proposedBy === p.userId }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    return this.one(id);
  }

  /**
   * Revokes an active attestation (any cloud admin: lowering a ceiling needs no second person): the entry's ceiling
   * drops back to `internal` and the model's label with it.
   */
  async revoke(p: Principal, id: string, ctx: { ip?: string | null; traceId?: string } = {}): Promise<{ attestation: Attestation; ceiling: Label }> {
    await this.need();
    const a = await this.one(id);
    if (a.state !== 'active') throw conflict(`This attestation is ${a.state}.`);
    const { entry, model } = await this.entryFor(p, a.modelId);
    const now = Date.now();
    const db = this.s().db;
    await db('cloud_model_attestations').where({ id }).update({ state: 'revoked', decided_by: p.userId, decided_at: now });
    const ceiling = await this.ceiling(entry, false);
    await db('cloud_model_entries').where({ model_id: entry.modelId }).update({ label_ceiling: ceiling, updated_at: now });
    const lowered = labelRank(model.label) > labelRank(ceiling);
    if (lowered) await this.s().gateway.repo.updateModel(model.id, { label: ceiling });
    this.reset();
    await this.s().audit.append({ tenantId: p.tenantId, action: 'cloud.model.attestation.revoked', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { model: model.name, attestation: id }, detail: { ceiling: { from: entry.ceiling, to: ceiling }, label: lowered ? { from: model.label, to: ceiling } : null }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    return { attestation: await this.one(id), ceiling };
  }
}

export const attestationView = (a: Attestation) => ({ id: a.id, modelId: a.modelId, accountId: a.accountId, terms: a.terms, state: a.state, proposedBy: a.proposedBy, proposedAt: a.proposedAt, decidedBy: a.decidedBy, decidedAt: a.decidedAt, note: a.note });

