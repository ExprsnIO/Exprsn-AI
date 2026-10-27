import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import { clears, labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import type { InstanceRow, ModelRow } from '../gateway/repo.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import type { CloudModelFlavour, CloudModelListing } from './model-catalogue.js';
import { scopeOf, SCOPE_CAP } from './model-residency.js';
import type { CloudAccount } from './types.js';

/*
 * 1.9.99-final, Sprint 60 (B-10504): the cloud catalogue import (`s.cloud.modelImport`). It lists what an account
 * offers (`s.cloud.modelCatalogue.listModels`: Bedrock foundation models with their model access state and inference
 * profiles, Azure deployments, DigitalOcean models, Workers AI models) and registers each chosen chat or embedding
 * model as a catalogue draft: `format: server`, held by the instance serving that account and region when there is
 * one (`kind: bedrock`, or `kind: openai` with the listing's flavour in `settings.cloud`), with the licence and terms
 * recorded, and a row in `cloud_model_entries` (provider, account, region, routing regions, terms, access state and
 * the label ceiling). The ceiling is the lowest effective ceiling of the regions it may route to, capped at
 * `internal` (open decision 5) unless the listing says the account's data terms are attested (then `confidential`),
 * never `restricted`. A model that routes outside the allow-list (a global profile) is not registered.
 *
 * Drafts go through the existing review (B-4304): evaluation on the instance, a recorded licence, dual-control
 * approval; never published here. `assertEntryAllows` is what the approval and the label change ask: a cloud entry's
 * model is never approved or labelled above its ceiling, nor while a routing region refuses its label.
 * A re-import is idempotent: the entry is updated in place (terms, access, routes, ceiling), the draft is not
 * recreated, and a draft's label above a lowered ceiling is lowered with it.
 */

export const DEFAULT_CLOUD_MODEL_CEILING: Label = 'internal';
export const ATTESTED_CLOUD_MODEL_CEILING: Label = 'confidential';

export interface CloudModelEntry {
  modelId: string;
  provider: string;
  accountId: string;
  region: string;
  externalId: string;
  flavour: CloudModelFlavour;
  offer: string;
  routesTo: string[];
  ceiling: Label;
  terms: { name: string; url?: string; notes?: string } | null;
  accessState: string;
  details: Record<string, unknown>;
  importedBy: string | null;
  importedAt: number;
  updatedAt: number;
}

export type ImportOutcome = 'registered' | 'updated' | 'unchanged' | 'skipped';

export interface ImportResultRow {
  id: string;
  region: string | null;
  kind: string;
  outcome: ImportOutcome;
  reason: string | null;
  modelId: string | null;
  ceiling: Label | null;
  label: Label | null;
  accessState: string | null;
  instance: string | null;
}

const lower = (a: Label, b: Label): Label => (labelRank(a) <= labelRank(b) ? a : b);

const TERMS: Record<CloudModelFlavour, (l: CloudModelListing) => { name: string; url: string; notes: string }> = {
  bedrock: (l) => ({ name: `${String(l.details?.providerName ?? 'Model provider')} model on Amazon Bedrock (AWS Service Terms and the model provider's end user licence agreement)`, url: 'https://aws.amazon.com/service-terms/', notes: 'Not attested for this account (B-10507).' }),
  azure: () => ({ name: 'Azure OpenAI / AI Foundry (Microsoft Product Terms and the model\'s terms)', url: 'https://www.microsoft.com/licensing/terms', notes: 'Not attested for this account (B-10507).' }),
  digitalocean: () => ({ name: 'DigitalOcean GenAI Platform (DigitalOcean terms and the model provider\'s licence)', url: 'https://www.digitalocean.com/legal/terms-of-service-agreement', notes: 'Not attested for this account (B-10507).' }),
  'workers-ai': () => ({ name: 'Cloudflare Workers AI (Developer Platform service-specific terms and the model\'s licence)', url: 'https://www.cloudflare.com/service-specific-terms-developer-platform/', notes: 'Not attested for this account (B-10507).' })
};

function entryFrom(r: Record<string, unknown>): CloudModelEntry {
  return {
    modelId: String(r.model_id),
    provider: String(r.provider),
    accountId: String(r.account_id),
    region: String(r.region),
    externalId: String(r.external_id),
    flavour: r.flavour as CloudModelFlavour,
    offer: String(r.offer),
    routesTo: json<string[]>(r.routes_to, []),
    ceiling: r.label_ceiling as Label,
    terms: json<CloudModelEntry['terms']>(r.terms, null),
    accessState: String(r.access_state),
    details: json<Record<string, unknown>>(r.details, {}),
    importedBy: (r.imported_by as string | null) ?? null,
    importedAt: Number(r.imported_at),
    updatedAt: Number(r.updated_at)
  };
}

export const entryView = (e: CloudModelEntry) => ({ modelId: e.modelId, provider: e.provider, accountId: e.accountId, region: e.region, externalId: e.externalId, flavour: e.flavour, offer: e.offer, routesTo: e.routesTo, ceiling: e.ceiling, terms: e.terms, accessState: e.accessState, importedAt: e.importedAt, updatedAt: e.updatedAt });

export class CloudModelImport {
  private schema: { ok: boolean; at: number } | null = null;

  constructor(private readonly s: () => Services) {}

  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < 30_000)) return this.schema.ok;
    let ok: boolean;
    try {
      ok = await this.s().db.schema.hasTable('cloud_model_entries');
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  resetSchemaCache(): void {
    this.schema = null;
  }

  private async need(): Promise<void> {
    await this.s().cloud.accounts.need();
    if (!(await this.installed())) throw new HttpProblem(503, 'Service unavailable', 'Cloud model entries are not installed yet (migration 159_cloud_models).', { extensions: { reason: 'migration_pending' } });
  }

  /** The cloud entry of a catalogue model, or null (not a cloud model, or the table is missing). */
  async entry(modelId: string): Promise<CloudModelEntry | null> {
    if (!(await this.installed())) return null;
    const r = (await this.s().db('cloud_model_entries').where({ model_id: modelId }).first()) as Record<string, unknown> | undefined;
    return r ? entryFrom(r) : null;
  }

  async entries(accountId?: string): Promise<CloudModelEntry[]> {
    if (!(await this.installed())) return [];
    const q = this.s().db('cloud_model_entries').orderBy('external_id');
    if (accountId) q.where({ account_id: accountId });
    return ((await q) as Record<string, unknown>[]).map(entryFrom);
  }

  /**
   * Refuses (403, step `zone`) a label for a cloud entry's model above its ceiling, or one a routing region no longer
   * admits (allow-list, ceiling, residency). A model without an entry passes (it is checked as before).
   */
  async assertEntryAllows(model: Pick<ModelRow, 'id' | 'name'>, label: Label): Promise<void> {
    const e = await this.entry(model.id);
    if (!e) return;
    if (labelRank(label) > labelRank(e.ceiling)) throw forbidden(`${model.name} is a cloud model whose ceiling is ${e.ceiling} (its regions and the account's data terms); it cannot be approved for ${label} data.`, { step: 'zone', check: 'ceiling', region: e.region, ceiling: e.ceiling });
    // Sprint 61 (B-10507): a cross-region or global model serves nothing above internal, whatever its ceiling says.
    const scope = scopeOf(e);
    if (scope !== 'regional' && labelRank(label) > labelRank(SCOPE_CAP)) throw forbidden(`${model.name} is a ${scope} model: it may run outside one region, so it cannot be approved for ${label} data.`, { step: 'zone', check: 'residency', scope, region: e.region });
    const account = await this.s().cloud.accounts.get(e.accountId);
    if (!account) throw forbidden(`${model.name}'s cloud account no longer exists.`, { step: 'zone', check: 'state' });
    for (const r of e.routesTo) {
      if (r === '*') throw forbidden(`${model.name} may route to any region (a global profile).`, { step: 'zone', check: 'region', region: '*' });
      await this.s().cloud.accounts.assertRegionAllows(account, r, label, { use: 'models' });
    }
  }

  /** The ceiling a listing would get: the lowest of its routing regions' effective ceilings, capped (open decision 5). */
  async ceilingOf(account: CloudAccount, routes: string[], attested: boolean): Promise<{ ceiling: Label | null; reason: string | null }> {
    let ceiling: Label = attested ? ATTESTED_CLOUD_MODEL_CEILING : DEFAULT_CLOUD_MODEL_CEILING;
    if (!routes.length) return { ceiling: null, reason: 'The listing names no region.' };
    for (const r of routes) {
      if (r === '*') return { ceiling: null, reason: `A global profile may route to regions outside ${account.name}'s allow-list.` };
      const c = await this.s().cloud.accounts.ceilingFor(account, r);
      if (!c) return { ceiling: null, reason: `It may route to ${r}, which is not on ${account.name}'s allow-list.` };
      ceiling = lower(ceiling, c);
    }
    return { ceiling: lower(ceiling, 'confidential'), reason: null };
  }

  /**
   * Sprint 61 (B-10507): whether a listing's ceiling may rise to `confidential`: its entry has an active data-terms
   * attestation (dual control, `s.cloud.modelResidency`) and it runs in one region (a cross-region or global model
   * stays at `internal`). Before migration 163 nothing is attested.
   */
  private async attestedFor(l: CloudModelListing, routes: string[], modelId: string | null): Promise<boolean> {
    const offer = String(l.details?.offer ?? (l.flavour === 'azure' ? 'deployment' : 'model'));
    if (scopeOf({ flavour: l.flavour, offer, routesTo: routes, externalId: l.id, details: l.details ?? {} }) !== 'regional') return false;
    if (!modelId) return false;
    return (await this.s().cloud.modelResidency?.attested(modelId).catch(() => false)) ?? false;
  }

  private routesOf(account: CloudAccount, l: CloudModelListing): { region: string | null; routes: string[] } {
    const region = l.region ?? account.defaultRegion ?? account.regions[0]?.region ?? null;
    const given = Array.isArray(l.details?.routesTo) ? (l.details!.routesTo as unknown[]).map(String) : null;
    return { region, routes: given ?? (region ? [region] : []) };
  }

  /** The instance that serves a listing: the one named, else one for its account (and region, for Bedrock) and flavour. */
  private async instanceFor(account: CloudAccount, l: CloudModelListing, region: string | null, named: InstanceRow | null): Promise<InstanceRow | null> {
    const wantKind = l.flavour === 'bedrock' ? 'bedrock' : 'openai';
    const fits = (i: InstanceRow) => i.kind === wantKind && i.settings.cloud?.accountId === account.id && (l.flavour === 'bedrock' ? i.settings.cloud.region === region : (i.settings.cloud.flavour ?? null) === l.flavour);
    if (named) return fits(named) ? named : null;
    return (await this.s().gateway.repo.instances()).find((i) => i.state !== 'disabled' && fits(i)) ?? null;
  }

  /** What the account offers, with whether each is catalogued and the ceiling it would get (nothing is written). */
  async preview(p: Principal, accountId: string, opts: { region?: string; signal?: AbortSignal } = {}) {
    await this.need();
    const account = await this.s().cloud.accounts.getFor(p, accountId);
    const listings = await this.listing(account, opts);
    const entries = await this.entries(account.id);
    const out = [];
    for (const l of listings) {
      const { region, routes } = this.routesOf(account, l);
      const e = entries.find((x) => x.externalId === l.id && x.region === (region ?? ''));
      const c = await this.ceilingOf(account, routes, await this.attestedFor(l, routes, e?.modelId ?? null));
      out.push({ id: l.id, name: l.name, kind: l.kind, flavour: l.flavour, region, routesTo: routes, available: l.available, reason: l.reason ?? c.reason ?? null, accessState: (l.details?.accessState as string | undefined) ?? (l.available ? 'available' : 'unavailable'), ceiling: c.ceiling, catalogued: e ? { modelId: e.modelId } : null });
    }
    return { account: { id: account.id, name: account.name, provider: account.provider }, models: out };
  }

  private async listing(account: CloudAccount, opts: { region?: string; signal?: AbortSignal }): Promise<CloudModelListing[]> {
    const cat = this.s().cloud.modelCatalogue;
    if (!cat) throw new HttpProblem(503, 'Service unavailable', 'The cloud model catalogue is not available in this build.', { extensions: { reason: 'cloud_component_missing' } });
    if (opts.region && !account.regions.some((r) => r.region === opts.region)) throw badRequest(`${opts.region} is not on ${account.name}'s allow-list of regions.`);
    const all = await cat.listModels(account, opts.signal ? { signal: opts.signal } : {});
    return opts.region ? all.filter((l) => (l.region ?? account.defaultRegion) === opts.region) : all;
  }

  /**
   * Registers drafts for the chosen listings (all chat and embedding models when `ids` is not given). Idempotent per
   * account, region and id.
   */
  async import(p: Principal, accountId: string, opts: { ids?: string[]; region?: string; instanceId?: string; label?: Label; ip?: string | null; traceId?: string; signal?: AbortSignal }): Promise<{ account: string; results: ImportResultRow[] }> {
    await this.need();
    const s = this.s();
    if (!p.userId) throw forbidden('Only a person can import cloud models.', { step: 'credential' });
    const account = await s.cloud.accounts.getFor(p, accountId);
    if (opts.label && !clears(p.clearance, opts.label)) throw forbidden('You cannot request a model for data above your clearance.', { step: 'clearance' });
    const named = opts.instanceId ? ((await s.gateway.repo.instance(opts.instanceId)) ?? null) : null;
    if (opts.instanceId && !named) throw notFound('Instance');
    const listings = (await this.listing(account, opts)).filter((l) => !opts.ids || opts.ids.includes(l.id));
    if (opts.ids) for (const id of opts.ids) if (!listings.some((l) => l.id === id)) throw conflict(`${account.name} does not offer ${id}${opts.region ? ` in ${opts.region}` : ''}.`);
    const results: ImportResultRow[] = [];
    const now = Date.now();
    for (const l of listings) {
      const { region, routes } = this.routesOf(account, l);
      const access = (l.details?.accessState as string | undefined) ?? (l.available ? 'available' : 'unavailable');
      const row: ImportResultRow = { id: l.id, region, kind: l.kind, outcome: 'skipped', reason: null, modelId: null, ceiling: null, label: null, accessState: access, instance: null };
      results.push(row);
      if (l.kind !== 'chat' && l.kind !== 'embedding') {
        row.reason = l.kind === 'agent' ? 'An agent is published as a registry tool (B-10503), not a model.' : 'Neither a chat nor an embedding model.';
        continue;
      }
      if (!region) {
        row.reason = 'The listing names no region and the account has no default.';
        continue;
      }
      const prior = (await s.db('cloud_model_entries').where({ account_id: account.id, region, external_id: l.id }).first('model_id')) as { model_id: string } | undefined;
      const c = await this.ceilingOf(account, routes, await this.attestedFor(l, routes, prior?.model_id ?? null));
      row.ceiling = c.ceiling;
      if (!c.ceiling) {
        row.reason = c.reason;
        continue;
      }
      const existing = (await s.db('cloud_model_entries').where({ account_id: account.id, region, external_id: l.id }).first()) as Record<string, unknown> | undefined;
      const terms = (l.details?.terms as CloudModelEntry['terms'] | undefined) ?? TERMS[l.flavour](l);
      const details = { name: l.name, model: l.model ?? null, endpoint: l.endpoint, ...(l.details ?? {}), terms: undefined };
      const fields = { provider: account.provider, flavour: l.flavour, offer: String(l.details?.offer ?? (l.flavour === 'azure' ? 'deployment' : 'model')), routes_to: JSON.stringify(routes), label_ceiling: c.ceiling, terms: JSON.stringify(terms), access_state: access, details: JSON.stringify(details), updated_at: now };
      if (existing) {
        const e = entryFrom(existing);
        const model = await s.gateway.repo.model(e.modelId);
        const changed = e.ceiling !== c.ceiling || JSON.stringify(e.routesTo) !== JSON.stringify(routes) || e.accessState !== access || JSON.stringify(e.terms) !== JSON.stringify(terms);
        if (changed) await s.db('cloud_model_entries').where({ model_id: e.modelId }).update(fields);
        // A lowered ceiling lowers a draft's label with it; an approved model's label is never raised or lowered here.
        if (model && model.state !== 'approved' && model.state !== 'deprecated' && labelRank(model.label) > labelRank(c.ceiling)) await s.gateway.repo.updateModel(model.id, { label: c.ceiling });
        Object.assign(row, { outcome: changed ? 'updated' : 'unchanged', modelId: e.modelId, label: model ? lower(model.label, c.ceiling) : null });
        continue;
      }
      if (!l.available) {
        row.reason = l.reason ?? `Not usable now (model access ${access}).`;
        continue;
      }
      const taken = await s.gateway.repo.modelByName(l.id);
      if (taken) {
        row.reason = `${l.id} is already in the catalogue${taken.format === 'server' ? ' from another account or region' : ''}.`;
        row.modelId = taken.id;
        continue;
      }
      const inst = await this.instanceFor(account, l, region, named);
      row.instance = inst?.name ?? null;
      const pool = inst ? await s.gateway.repo.pool(inst.pool_id) : undefined;
      const label = lower(opts.label ?? c.ceiling, c.ceiling);
      row.label = label;
      if (pool && labelRank(label) > labelRank(pool.label_ceiling)) {
        row.reason = `${l.id} would be labelled ${label} but ${pool.name}'s ceiling is ${pool.label_ceiling}.`;
        continue;
      }
      let m: ModelRow;
      try {
        m = await s.gateway.repo.createModel({
          name: l.id,
          source: `cloud:${l.flavour}/${account.name}/${region}/${l.id}`.slice(0, 500),
          expectedDigest: null,
          license: { name: terms?.name ?? `${l.flavour} terms`, ...(terms?.url ? { url: terms.url } : {}), ...(terms?.notes ? { notes: terms.notes } : {}), recordedBy: p.username ?? 'cloud catalogue import', recordedAt: now },
          label,
          notes: `Imported from the cloud account ${account.name} (${region}); model access ${access}.`,
          requestedBy: p.userId,
          requestedTenant: p.tenantId,
          server: { instanceId: inst?.id ?? (null as unknown as string), model: l.id, capabilities: l.kind === 'embedding' ? ['embedding'] : ['completion'], contextLength: null, family: (l.details?.providerName as string | undefined) ?? null }
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          row.reason = `${l.id} is already in the catalogue.`;
          continue;
        }
        throw err;
      }
      await s.db('cloud_model_entries').insert({ model_id: m.id, account_id: account.id, region, external_id: l.id, imported_by: p.userId, imported_at: now, ...fields });
      if (inst) await s.gateway.repo.place(m.id, inst.pool_id, 'warm', p.userId);
      Object.assign(row, { outcome: 'registered', modelId: m.id });
      await s.audit.append({ tenantId: p.tenantId, action: 'model.import.requested', kind: 'admin', actor: actorFrom(p, opts.ip ?? null), target: { model: m.name }, detail: { source: m.source, format: 'server', cloud: { provider: account.provider, account: account.name, region, routesTo: routes, ceiling: c.ceiling, accessState: access }, server: inst?.name ?? null, label, pullJob: null }, ...(opts.traceId ? { traceId: opts.traceId } : {}) });
    }
    await s.audit.append({ tenantId: p.tenantId, action: 'cloud.models.imported', kind: 'admin', actor: actorFrom(p, opts.ip ?? null), target: { account: account.name }, detail: { region: opts.region ?? null, counts: Object.fromEntries((['registered', 'updated', 'unchanged', 'skipped'] as const).map((k) => [k, results.filter((r) => r.outcome === k).length])) }, ...(opts.traceId ? { traceId: opts.traceId } : {}) });
    return { account: account.name, results };
  }
}
