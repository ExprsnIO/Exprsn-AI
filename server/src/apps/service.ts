import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation, type AuditActor } from '../audit/chain.js';
import { clears, highest, LABELS, labelRank, type Label } from '../authz/labels.js';
import { authorize, effectivePermissions, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { loadPrincipal, workspacesFor } from '../http/middleware.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { parseCsv } from '../identity/user-import.js';
import { TOPICS, type IntegrationEvent } from '../platform/bus.js';
import type { JobContext } from '../platform/jobs.js';
import type { Workspace } from '../repos/tenants.js';
import type { Services } from '../services.js';
import { generate } from './ai.js';
import { AppBundles } from './bundles.js';
import { AppForms } from './forms.js';
import { aggregate, applyFilter, applySearch, applySort, checkFilterSize, countRecords, pageRecords, type AggregateInput, type Filter, type QueryContext, type Sort } from './query.js';
import {
  checkDefinition,
  computeFormulas,
  entityDefinitionSchema,
  fromCell,
  indexRows,
  isComputed,
  normText,
  titleFieldOf,
  transitionFor,
  uniqueKeys,
  validateValues,
  ValueError,
  type EntityDefinition,
  type Field,
  type IndexRow,
  type Values
} from './schema.js';
import { AppTriggers } from './triggers.js';

/*
 * Low-code data apps (B-2201 to B-2208). An app belongs to a tenant, and to a workspace unless it is tenant-wide; it
 * holds entities (typed fields, an optional state machine) whose records are sealed with the tenant key. Members of
 * the app's workspace (every tenant member for a tenant-wide app) read records with `records:read` and write them with
 * `records:write`, within their clearance; designers change apps, entities, forms and triggers with `apps:design`.
 *
 * The app's label is the highest label its records may carry; an entity's label is its records' default (and lowest)
 * label. Fields marked `indexed` or `unique` are also written to the clear index (query.ts explains the queries);
 * everything else exists only in the sealed record. Every change is audited; record changes are also emitted as
 * `record.*` events, fire the entity's triggers, and (for entities with AI fields) queue the fill.
 */

export interface AppRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  scope_key: string;
  name: string;
  title: string;
  description: string | null;
  label: Label;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface EntityRow {
  id: string;
  tenant_id: string;
  app_id: string;
  name: string;
  title: string;
  label: Label;
  definition: EntityDefinition;
  rev: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface RecordRow {
  id: string;
  tenant_id: string;
  app_id: string;
  entity_id: string;
  workspace_id: string | null;
  label: Label;
  state: string | null;
  data: string;
  hidden: boolean;
  version: number;
  source: RecordSource;
  ai_state: string | null;
  ai_error: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

export type RecordSource = 'api' | 'form' | 'import' | 'workflow' | 'plugin';

/** Who writes: a person (or a run as its owner), or nobody (a public form). */
export interface Actor {
  principal: Principal | null;
  source: RecordSource;
  ip?: string | null;
  traceId?: string;
  /** The service writing without a person (`apps.forms`). */
  service?: string;
  /** Trigger depth: a workflow started by a trigger carries it, so chains of triggers end (APPS_TRIGGER_MAX_DEPTH). */
  depth?: number;
  /** The workflow whose step made the change: its own triggers do not fire again. */
  causedBy?: string | null;
}

export interface AppsOptions {
  maxImportBytes: number;
  maxImportRows: number;
  maxExportRows: number;
  maxBulk: number;
  triggerMaxDepth: number;
}

export type RecordEvent = 'created' | 'updated' | 'deleted' | 'transitioned';

const num = (v: unknown): number | null => (v == null ? null : Number(v));
export const appFrom = (r: Record<string, unknown>): AppRow => ({ ...(r as unknown as AppRow), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
export const entityFrom = (r: Record<string, unknown>): EntityRow => ({ ...(r as unknown as EntityRow), definition: entityDefinitionSchema.parse(json(r.definition, {})), rev: Number(r.rev), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
export const recordFrom = (r: Record<string, unknown>): RecordRow => ({ ...(r as unknown as RecordRow), hidden: !!r.hidden, version: Number(r.version), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

const recordAad = (id: string) => `app-record:${id}`;
const transferAad = (id: string) => `app-transfer:${id}`;

export const appView = (a: AppRow) => ({ id: a.id, name: a.name, title: a.title, description: a.description, label: a.label, workspaceId: a.workspace_id, scope: a.workspace_id ? ('workspace' as const) : ('tenant' as const), createdBy: a.created_by, updatedBy: a.updated_by, createdAt: a.created_at, updatedAt: a.updated_at });
export const entityView = (e: EntityRow) => ({ id: e.id, name: e.name, title: e.title, label: e.label, definition: e.definition, rev: e.rev, createdAt: e.created_at, updatedAt: e.updated_at });

export interface RecordView {
  id: string;
  app: string;
  entity: string;
  label: Label;
  state: string | null;
  values: Values;
  version: number;
  source: RecordSource;
  aiState: string | null;
  aiError: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Text for a CSV cell: quoted when needed, and a leading = + - @ (or tab, CR) made inert for spreadsheets. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

interface Prepared {
  values: Values;
  rows: IndexRow[];
  keys: { field: string; hash: string }[];
  sealed: string;
}

export class AppService {
  readonly forms: AppForms;
  readonly triggers: AppTriggers;
  readonly bundles: AppBundles;

  constructor(
    private readonly s: () => Services,
    readonly o: AppsOptions
  ) {
    this.forms = new AppForms(s, this);
    this.triggers = new AppTriggers(s, this);
    this.bundles = new AppBundles(s, this);
  }

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    const jobs = this.s().jobs;
    jobs.register('apps.ai-fill', (p) => this.fillAi(String(p.recordId)), { timeoutMs: 10 * 60_000 });
    jobs.register('apps.reindex', (p, ctx) => this.reindex(String(p.entityId), ctx), { timeoutMs: 60 * 60_000 });
    jobs.register('apps.import', (p, ctx) => this.runImport(String(p.transferId), ctx), { timeoutMs: 60 * 60_000 });
    jobs.register('apps.export', (p, ctx) => this.runExport(String(p.transferId), ctx), { timeoutMs: 60 * 60_000 });
    this.triggers.registerJobs();
  }

  // ---------- access ----------

  private async workspaces(p: Principal): Promise<Map<string, Workspace>> {
    return new Map((await workspacesFor(this.s(), p)).map((w) => [w.id, w]));
  }

  /** An app is visible in its workspace (everywhere in the tenant when tenant-wide); its label only caps its records. */
  private visible(a: AppRow, _p: Principal, ws: Map<string, Workspace>): boolean {
    return !a.workspace_id || ws.has(a.workspace_id);
  }

  async list(p: Principal): Promise<AppRow[]> {
    const ws = await this.workspaces(p);
    return ((await this.db('apps').where({ tenant_id: p.tenantId }).orderBy('name')) as Record<string, unknown>[]).map(appFrom).filter((a) => this.visible(a, p, ws));
  }

  /** An app the caller can see, by id or name (the current workspace's app first, then a tenant-wide one). */
  async app(p: Principal, ref: string): Promise<AppRow> {
    const ws = await this.workspaces(p);
    const rows = ((await this.db('apps').where({ tenant_id: p.tenantId }).andWhere((q) => q.where({ id: ref }).orWhere({ name: ref }))) as Record<string, unknown>[]).map(appFrom).filter((a) => this.visible(a, p, ws));
    const a = rows.find((x) => x.id === ref) ?? rows.find((x) => x.workspace_id && x.workspace_id === p.workspaceId) ?? rows.find((x) => !x.workspace_id) ?? rows[0];
    if (!a) throw notFound('App');
    return a;
  }

  /** An app the caller may change: visible, and its label within their clearance (it caps every record in it). */
  async designable(p: Principal, ref: string): Promise<AppRow> {
    const a = await this.app(p, ref);
    if (!clears(p.clearance, a.label)) throw forbidden(`The app holds records up to ${a.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    return a;
  }

  async appById(tenantId: string, id: string): Promise<AppRow | undefined> {
    const r = await this.db('apps').where({ tenant_id: tenantId, id }).first();
    return r ? appFrom(r) : undefined;
  }

  async entities(app: AppRow): Promise<EntityRow[]> {
    return ((await this.db('app_entities').where({ app_id: app.id }).orderBy('name')) as Record<string, unknown>[]).map(entityFrom);
  }

  async entityOf(app: AppRow, ref: string): Promise<EntityRow> {
    const r = await this.db('app_entities').where({ app_id: app.id }).andWhere((q) => q.where({ id: ref }).orWhere({ name: ref })).first();
    if (!r) throw notFound('Entity');
    return entityFrom(r);
  }

  async entityById(tenantId: string, id: string): Promise<EntityRow | undefined> {
    const r = await this.db('app_entities').where({ tenant_id: tenantId, id }).first();
    return r ? entityFrom(r) : undefined;
  }

  async resolve(p: Principal, appRef: string, entityRef: string): Promise<{ app: AppRow; entity: EntityRow }> {
    const app = await this.app(p, appRef);
    return { app, entity: await this.entityOf(app, entityRef) };
  }

  private audit(actor: Actor, tenantId: string, action: string, target: Record<string, unknown>, label?: Label, detail?: Record<string, unknown>) {
    const who: AuditActor = actor.principal ? actorFrom(actor.principal, actor.ip ?? null) : { service: actor.service ?? 'apps' };
    return this.s().audit.append({ tenantId, action, kind: actor.principal ? 'admin' : 'system', actor: who, target, ...(label ? { label } : {}), ...(detail ? { detail } : {}), traceId: actor.traceId ?? null });
  }

  // ---------- apps (B-2201) ----------

  private async checkScope(p: Principal, workspaceId: string | null, label: Label): Promise<void> {
    if (!clears(p.clearance, label)) throw forbidden(`Your clearance is ${p.clearance}; a ${label} app is above it.`, { step: 'clearance' });
    if (workspaceId) {
      const w = (await this.workspaces(p)).get(workspaceId);
      if (!w) throw notFound('Workspace');
      if (labelRank(label) > labelRank(w.label_ceiling)) throw forbidden(`${w.name}'s ceiling is ${w.label_ceiling}; the app would be ${label}.`, { step: 'zone' });
    }
  }

  async create(actor: Actor & { principal: Principal }, input: { name: string; title?: string; description?: string | null; label: Label; workspaceId?: string | null }): Promise<AppRow> {
    const p = actor.principal;
    const workspaceId = input.workspaceId === undefined ? (p.workspaceId ?? null) : input.workspaceId;
    await this.checkScope(p, workspaceId, input.label);
    const t = Date.now();
    const row: AppRow = { id: ulid(), tenant_id: p.tenantId, workspace_id: workspaceId, scope_key: workspaceId ?? 'tenant', name: input.name, title: input.title ?? input.name, description: input.description ?? null, label: input.label, created_by: p.userId, updated_by: p.userId, created_at: t, updated_at: t };
    try {
      await this.db('apps').insert(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`An app named ${input.name} exists ${workspaceId ? 'in this workspace' : 'tenant-wide'}.`);
      throw err;
    }
    await this.audit(actor, p.tenantId, 'app.created', { app: row.id, name: row.name, workspace: row.workspace_id }, row.label);
    return row;
  }

  async update(actor: Actor & { principal: Principal }, ref: string, patch: { title?: string; description?: string | null; label?: Label }): Promise<AppRow> {
    const p = actor.principal;
    const a = await this.designable(p, ref);
    const upd: Partial<AppRow> = { updated_by: p.userId, updated_at: Date.now() };
    if (patch.title !== undefined) upd.title = patch.title;
    if (patch.description !== undefined) upd.description = patch.description;
    if (patch.label && patch.label !== a.label) {
      await this.checkScope(p, a.workspace_id, patch.label);
      const above = (await this.entities(a)).find((e) => labelRank(e.label) > labelRank(patch.label!));
      if (above) throw conflict(`The entity ${above.name} is ${above.label}; lower it first.`);
      const rec = await this.db('app_records').where({ app_id: a.id }).whereIn('label', LABELS.filter((l) => labelRank(l) > labelRank(patch.label!))).first('id');
      if (rec) throw conflict(`Records of this app are labelled above ${patch.label}.`);
      upd.label = patch.label;
    }
    await this.db('apps').where({ id: a.id }).update(upd);
    const after = { ...a, ...upd };
    await this.audit(actor, p.tenantId, 'app.updated', { app: a.id, name: a.name }, after.label, { before: { title: a.title, label: a.label }, after: { title: after.title, label: after.label } });
    return after;
  }

  async remove(actor: Actor & { principal: Principal }, ref: string): Promise<AppRow> {
    const a = await this.designable(actor.principal, ref);
    const records = Number(((await this.db('app_records').where({ app_id: a.id }).count({ n: '*' })) as Record<string, unknown>[])[0]?.n ?? 0);
    const entityIds = ((await this.db('app_entities').where({ app_id: a.id }).select('id')) as { id: string }[]).map((e) => e.id);
    await this.db.transaction(async (trx) => {
      if (entityIds.length) {
        await trx('app_record_values').whereIn('entity_id', entityIds).delete();
        await trx('app_unique_values').whereIn('entity_id', entityIds).delete();
      }
      for (const t of ['app_records', 'app_forms', 'app_triggers', 'app_transfers', 'app_entities']) await trx(t).where({ app_id: a.id }).delete();
      await trx('apps').where({ id: a.id }).delete();
    });
    await this.audit(actor, a.tenant_id, 'app.deleted', { app: a.id, name: a.name }, a.label, { entities: entityIds.length, records });
    return a;
  }

  // ---------- entities (B-2201, B-2203, B-2204) ----------

  private async checkEntity(app: AppRow, name: string, label: Label, def: EntityDefinition, exceptId?: string): Promise<void> {
    if (labelRank(label) > labelRank(app.label)) throw forbidden(`The app is ${app.label}; an entity cannot be ${label}.`, { step: 'clearance' });
    const names = new Set((await this.entities(app)).filter((e) => e.id !== exceptId).map((e) => e.name));
    names.add(name);
    const problems = checkDefinition(def, names);
    if (problems.length) throw new HttpProblem(400, 'Invalid entity', problems[0]!, { extensions: { problems } });
  }

  async createEntity(actor: Actor & { principal: Principal }, appRef: string, input: { name: string; title?: string; label?: Label; definition: EntityDefinition }): Promise<{ app: AppRow; entity: EntityRow }> {
    const p = actor.principal;
    const app = await this.designable(p, appRef);
    const label = input.label ?? app.label;
    await this.checkEntity(app, input.name, label, input.definition);
    const t = Date.now();
    const row: EntityRow = { id: ulid(), tenant_id: p.tenantId, app_id: app.id, name: input.name, title: input.title ?? input.name, label, definition: input.definition, rev: 1, created_by: p.userId, updated_by: p.userId, created_at: t, updated_at: t };
    try {
      await this.db('app_entities').insert({ ...row, definition: JSON.stringify(row.definition) });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`The app has an entity named ${input.name}.`);
      throw err;
    }
    await this.audit(actor, p.tenantId, 'app.entity.created', { app: app.id, entity: row.id, name: row.name }, label, { fields: input.definition.fields.length, states: input.definition.states?.states.length ?? 0 });
    return { app, entity: row };
  }

  /**
   * Changes an entity. With records present a field's type cannot change, an existing field cannot become unique, and
   * a state still held by a record cannot go; a change to what is indexed or computed reindexes the records by job.
   */
  async updateEntity(actor: Actor & { principal: Principal }, appRef: string, entityRef: string, patch: { title?: string; label?: Label; definition?: EntityDefinition; rev?: number }): Promise<{ app: AppRow; entity: EntityRow; reindex: string | null }> {
    const p = actor.principal;
    const { app, entity } = await this.resolve(p, appRef, entityRef);
    if (patch.rev != null && patch.rev !== entity.rev) throw conflict(`The entity changed since you opened it (revision ${entity.rev}, you have ${patch.rev}).`);
    const def = patch.definition ?? entity.definition;
    const label = patch.label ?? entity.label;
    await this.checkEntity(app, entity.name, label, def, entity.id);
    const hasRecords = !!(await this.db('app_records').where({ entity_id: entity.id }).first('id'));
    const before = new Map(entity.definition.fields.map((f) => [f.name, f]));
    if (hasRecords && patch.definition) {
      for (const f of def.fields) {
        const old = before.get(f.name);
        if (old && old.type !== f.type) throw conflict(`${f.name} holds values as ${old.type}; its type cannot change while the entity has records.`);
        if (old && f.unique && !old.unique) throw conflict(`${f.name} cannot become unique while the entity has records; add a new unique field instead.`);
      }
      const keep = new Set(def.states?.states.map((s) => s.name) ?? []);
      const held = (await this.db('app_records').where({ entity_id: entity.id }).whereNotNull('state').distinct('state')) as { state: string }[];
      const gone = held.find((h) => !keep.has(h.state));
      if (gone) throw conflict(`Records are in the state ${gone.state}; it cannot be removed.`);
    }
    if (hasRecords && labelRank(label) > labelRank(entity.label)) {
      const below = await this.db('app_records').where({ entity_id: entity.id }).whereIn('label', LABELS.filter((l) => labelRank(l) < labelRank(label))).first('id');
      if (below) throw conflict(`Records of this entity are labelled below ${label}.`);
    }
    const t = Date.now();
    const n = await this.db('app_entities').where({ id: entity.id, rev: entity.rev }).update({ title: patch.title ?? entity.title, label, definition: JSON.stringify(def), rev: entity.rev + 1, updated_by: p.userId, updated_at: t });
    if (n !== 1) throw conflict('The entity changed while saving; reload it and try again.');
    const after: EntityRow = { ...entity, title: patch.title ?? entity.title, label, definition: def, rev: entity.rev + 1, updated_by: p.userId, updated_at: t };
    const sig = (d: EntityDefinition) => JSON.stringify(d.fields.filter((f) => f.indexed || f.unique || f.type === 'formula').map((f) => [f.name, f.type, f.indexed, f.unique, f.type === 'formula' ? f.expression : null]));
    let reindex: string | null = null;
    if (hasRecords && sig(entity.definition) !== sig(def)) {
      const job = await this.s().jobs.enqueue({ tenantId: p.tenantId, type: 'apps.reindex', payload: { entityId: entity.id }, createdBy: p.userId, maxAttempts: 3 });
      reindex = job.id;
    }
    await this.audit(actor, p.tenantId, 'app.entity.updated', { app: app.id, entity: entity.id, name: entity.name }, label, { rev: after.rev, fields: def.fields.length, reindex });
    return { app, entity: after, reindex };
  }

  async removeEntity(actor: Actor & { principal: Principal }, appRef: string, entityRef: string): Promise<{ app: AppRow; entity: EntityRow; records: number }> {
    const { app, entity } = await this.resolve(actor.principal, appRef, entityRef);
    const ref = (await this.entities(app)).find((e) => e.id !== entity.id && e.definition.fields.some((f) => (f.type === 'reference' && f.entity === entity.name) || (f.type === 'lookup' && f.source === 'entity' && f.entity === entity.name)));
    if (ref) throw conflict(`The entity ${ref.name} refers to ${entity.name}; change it first.`);
    const records = Number(((await this.db('app_records').where({ entity_id: entity.id }).count({ n: '*' })) as Record<string, unknown>[])[0]?.n ?? 0);
    await this.db.transaction(async (trx) => {
      for (const t of ['app_record_values', 'app_unique_values', 'app_records', 'app_forms', 'app_triggers', 'app_transfers']) await trx(t).where({ entity_id: entity.id }).delete();
      await trx('app_entities').where({ id: entity.id }).delete();
    });
    await this.audit(actor, app.tenant_id, 'app.entity.deleted', { app: app.id, entity: entity.id, name: entity.name }, entity.label, { records });
    return { app, entity, records };
  }

  // ---------- records (B-2202) ----------

  private cleared(p: Principal): Label[] {
    return LABELS.filter((l) => clears(p.clearance, l));
  }

  private qctx(entity: EntityRow): QueryContext {
    return { db: this.db, def: entity.definition, entityId: entity.id, pg: this.s().cfg.DB_CLIENT === 'pg' };
  }

  /** Records of an entity the caller can read: cleared, not hidden. */
  private base(p: Principal, entity: EntityRow): Knex.QueryBuilder {
    return this.db('app_records as r').where('r.tenant_id', p.tenantId).andWhere('r.entity_id', entity.id).andWhere('r.hidden', false).whereIn('r.label', this.cleared(p));
  }

  async open(r: RecordRow): Promise<Values> {
    return json<Values>(await this.s().keys.open(r.tenant_id, r.data, recordAad(r.id)), {});
  }

  async view(app: AppRow, entity: EntityRow, r: RecordRow, values?: Values): Promise<RecordView> {
    return { id: r.id, app: app.name, entity: entity.name, label: r.label, state: r.state, values: values ?? (await this.open(r)), version: r.version, source: r.source, aiState: r.ai_state, aiError: r.ai_error, createdBy: r.created_by, updatedBy: r.updated_by, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  /**
   * A page of records (B-2202): from an offset, or after a cursor from the previous page (keyset paging, B-3601), with
   * the cursor of the next page. `total` counts every match; `count: false` leaves it null (the export's later pages).
   */
  async query(p: Principal, appRef: string, entityRef: string, input: { filter?: Filter; sort?: Sort; q?: string; limit?: number; offset?: number; cursor?: string; count?: boolean }) {
    const { app, entity } = await this.resolve(p, appRef, entityRef);
    const ctx = this.qctx(entity);
    if (input.filter) checkFilterSize(input.filter);
    const match = { ...(input.filter ? { filter: input.filter } : {}), ...(input.q ? { q: input.q } : {}) };
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;
    // What `base` reads, for the query builder: the tenant's records (of ctx's entity, not hidden) at cleared labels.
    const who = { tenantId: p.tenantId, labels: this.cleared(p) };
    const page = await pageRecords(who, { ...match, sort: input.sort ?? [], limit, offset, ...(input.cursor ? { cursor: input.cursor } : {}) }, ctx);
    const total = input.count === false ? null : await countRecords(who, match, ctx);
    const rows = page.rows.map(recordFrom);
    return { app, entity, total, limit, offset, nextCursor: page.nextCursor, records: await Promise.all(rows.map((r) => this.view(app, entity, r))) };
  }

  async aggregate(p: Principal, appRef: string, entityRef: string, input: AggregateInput) {
    const { entity } = await this.resolve(p, appRef, entityRef);
    const ctx = this.qctx(entity);
    const q = this.base(p, entity).select('r.id', 'r.state');
    if (input.filter) {
      checkFilterSize(input.filter);
      applyFilter(q, input.filter, ctx);
    }
    if (input.q) applySearch(q, input.q, ctx);
    if (input.groupBy === 'state' && !entity.definition.states) throw badRequest('This entity has no state machine to group by.');
    return aggregate(q, input, ctx);
  }

  private async row(tenantId: string, entity: EntityRow, id: string): Promise<RecordRow | undefined> {
    const r = await this.db('app_records').where({ tenant_id: tenantId, entity_id: entity.id, id }).first();
    return r ? recordFrom(r) : undefined;
  }

  /** A record the caller can read (cleared, not hidden). */
  async readable(p: Principal, entity: EntityRow, id: string): Promise<RecordRow> {
    const r = await this.row(p.tenantId, entity, id);
    if (!r || r.hidden || !clears(p.clearance, r.label)) throw notFound('Record');
    return r;
  }

  async get(p: Principal, appRef: string, entityRef: string, id: string): Promise<RecordView> {
    const { app, entity } = await this.resolve(p, appRef, entityRef);
    return this.view(app, entity, await this.readable(p, entity, id));
  }

  /** Checks that references, lookups and files point at things that exist and the writer may see. */
  private async checkLinks(actor: Actor, app: AppRow, def: EntityDefinition, values: Values, changed: Set<string> | null): Promise<void> {
    const s = this.s();
    const problems: { field: string; message: string }[] = [];
    for (const f of def.fields) {
      const v = values[f.name];
      if (v == null || (changed && !changed.has(f.name))) continue;
      const target = f.type === 'reference' ? f.entity : f.type === 'lookup' && f.source === 'entity' ? f.entity : null;
      if (target) {
        const e = await this.db('app_entities').where({ app_id: app.id, name: target }).first('id');
        const r = e ? ((await this.db('app_records').where({ tenant_id: app.tenant_id, entity_id: e.id, id: String(v), hidden: false }).first('label')) as { label: Label } | undefined) : undefined;
        if (!r || (actor.principal && !clears(actor.principal.clearance, r.label))) problems.push({ field: f.name, message: `refers to a ${target} record that does not exist` });
        continue;
      }
      if (f.type === 'lookup' && f.source === 'user') {
        const u = await this.db('users').where({ tenant_id: app.tenant_id, id: String(v), state: 'active' }).first('id');
        if (!u) problems.push({ field: f.name, message: 'is not an active user of this tenant' });
      } else if (f.type === 'lookup' && f.source === 'workspace') {
        const ok = actor.principal ? (await this.workspaces(actor.principal)).has(String(v)) : !!(await s.tenants.workspace(app.tenant_id, String(v)));
        if (!ok) problems.push({ field: f.name, message: 'is not a workspace you can use' });
      } else if (f.type === 'file') {
        if (!actor.principal) problems.push({ field: f.name, message: 'files can only be attached by a signed-in person' });
        else {
          try {
            await s.files.readable(actor.principal, String(v));
          } catch {
            problems.push({ field: f.name, message: 'is not a file you can read' });
          }
        }
      }
    }
    if (problems.length) throw new ValueError(problems);
  }

  /** Validates, computes and seals a record's values; nothing is written. */
  async prepare(actor: Actor, app: AppRow, entity: EntityRow, id: string, input: Values, existing: Values | null): Promise<Prepared> {
    const def = entity.definition;
    const computed = def.fields.filter(isComputed).map((f) => f.name);
    const given = Object.fromEntries(Object.entries(input).filter(([k]) => !(existing && computed.includes(k) && input[k] === existing[k])));
    let values: Values;
    try {
      values = validateValues(def, given, existing ? { existing } : {});
    } catch (err) {
      if (err instanceof ValueError) throw new HttpProblem(400, 'Invalid record', err.message, { extensions: { problems: err.problems } });
      throw err;
    }
    computeFormulas(def, values);
    const changed = existing ? new Set(Object.keys(given)) : null;
    try {
      await this.checkLinks(actor, app, def, values, changed);
    } catch (err) {
      if (err instanceof ValueError) throw new HttpProblem(400, 'Invalid record', err.message, { extensions: { problems: err.problems } });
      throw err;
    }
    return { values, rows: indexRows(def, values), keys: uniqueKeys(entity.id, def, values), sealed: await this.s().keys.seal(app.tenant_id, JSON.stringify(values), recordAad(id)) };
  }

  private recordLabel(actor: Actor, app: AppRow, entity: EntityRow, wanted?: Label): Label {
    const label = wanted ?? entity.label;
    if (labelRank(label) < labelRank(entity.label)) throw badRequest(`Records of ${entity.name} are at least ${entity.label}.`);
    if (labelRank(label) > labelRank(app.label)) throw forbidden(`The app holds records up to ${app.label}.`, { step: 'clearance' });
    if (actor.principal && !clears(actor.principal.clearance, label)) throw forbidden(`Your clearance is ${actor.principal.clearance}; the record would be ${label}.`, { step: 'clearance' });
    return label;
  }

  /** Writes index rows and unique keys; a duplicate unique value fails the transaction with 409 naming the field. */
  private async writeIndex(trx: Knex.Transaction, r: RecordRow, prep: Prepared, entity: EntityRow): Promise<void> {
    if (prep.rows.length) await trx('app_record_values').insert(prep.rows.map((x) => ({ record_id: r.id, tenant_id: r.tenant_id, entity_id: r.entity_id, ...x })));
    for (const k of prep.keys) {
      try {
        await trx('app_unique_values').insert({ entity_id: r.entity_id, field: k.field, value_hash: k.hash, record_id: r.id, tenant_id: r.tenant_id });
      } catch (err) {
        if (isUniqueViolation(err)) {
          const f = entity.definition.fields.find((x) => x.name === k.field);
          throw new HttpProblem(409, 'Duplicate value', `Another ${entity.name} record already has this ${f?.title ?? k.field}; ${k.field} is unique.`, { extensions: { field: k.field } });
        }
        throw err;
      }
    }
  }

  private async clearIndex(trx: Knex.Transaction, recordId: string): Promise<void> {
    await trx('app_record_values').where({ record_id: recordId }).delete();
    await trx('app_unique_values').where({ record_id: recordId }).delete();
  }

  private hasAi(entity: EntityRow): boolean {
    return entity.definition.fields.some((f) => f.type === 'ai');
  }

  /** Creates a record (B-2202). The caller has decided the actor may write here. */
  async createRecord(actor: Actor, app: AppRow, entity: EntityRow, input: { values: Values; label?: Label }): Promise<RecordView> {
    const id = ulid();
    const label = this.recordLabel(actor, app, entity, input.label);
    const prep = await this.prepare(actor, app, entity, id, input.values, null);
    const t = Date.now();
    const by = actor.principal?.userId ?? null;
    const r: RecordRow = { id, tenant_id: app.tenant_id, app_id: app.id, entity_id: entity.id, workspace_id: app.workspace_id, label, state: entity.definition.states?.initial ?? null, data: prep.sealed, hidden: false, version: 1, source: actor.source, ai_state: this.hasAi(entity) ? 'pending' : null, ai_error: null, created_by: by, updated_by: by, created_at: t, updated_at: t };
    await this.db.transaction(async (trx) => {
      await trx('app_records').insert(r);
      await this.writeIndex(trx, r, prep, entity);
    });
    await this.after(actor, app, entity, r, 'created', {});
    return this.view(app, entity, r, prep.values);
  }

  async updateRecord(actor: Actor, app: AppRow, entity: EntityRow, id: string, input: { values: Values; version?: number }): Promise<RecordView> {
    const r = actor.principal ? await this.readable(actor.principal, entity, id) : await this.row(app.tenant_id, entity, id);
    if (!r) throw notFound('Record');
    if (input.version != null && input.version !== r.version) throw conflict(`The record changed since you read it (version ${r.version}, you have ${input.version}).`);
    const existing = await this.open(r);
    const prep = await this.prepare(actor, app, entity, r.id, input.values, existing);
    const fields = Object.keys(input.values).filter((k) => JSON.stringify(existing[k] ?? null) !== JSON.stringify(prep.values[k] ?? null));
    const aiNeeded = this.hasAi(entity) && fields.some((k) => entity.definition.fields.find((f) => f.name === k)?.type !== 'ai');
    const t = Date.now();
    const by = actor.principal?.userId ?? null;
    await this.db.transaction(async (trx) => {
      const n = await trx('app_records').where({ id: r.id, version: r.version }).update({ data: prep.sealed, version: r.version + 1, updated_by: by, updated_at: t, ...(aiNeeded ? { ai_state: 'pending', ai_error: null } : {}) });
      if (n !== 1) throw conflict('The record changed while saving; read it again and retry.');
      await this.clearIndex(trx, r.id);
      await this.writeIndex(trx, r, prep, entity);
    });
    const after: RecordRow = { ...r, data: prep.sealed, version: r.version + 1, updated_by: by, updated_at: t, ...(aiNeeded ? { ai_state: 'pending', ai_error: null } : {}) };
    await this.after(actor, app, entity, after, 'updated', { fields }, aiNeeded);
    return this.view(app, entity, after, prep.values);
  }

  async removeRecord(actor: Actor & { principal: Principal }, app: AppRow, entity: EntityRow, id: string): Promise<RecordRow> {
    const r = await this.readable(actor.principal, entity, id);
    await this.db.transaction(async (trx) => {
      await this.clearIndex(trx, r.id);
      await trx('app_records').where({ id: r.id }).delete();
    });
    await this.after(actor, app, entity, r, 'deleted', {});
    return r;
  }

  /** Moves a record through its entity's state machine (B-2204); a transition the machine does not list is refused. */
  async transition(actor: Actor, app: AppRow, entity: EntityRow, id: string, to: string, o: { version?: number; note?: string | null } = {}): Promise<RecordView> {
    const sm = entity.definition.states;
    if (!sm) throw conflict(`${entity.name} has no state machine.`);
    const r = actor.principal ? await this.readable(actor.principal, entity, id) : await this.row(app.tenant_id, entity, id);
    if (!r) throw notFound('Record');
    if (o.version != null && o.version !== r.version) throw conflict(`The record changed since you read it (version ${r.version}, you have ${o.version}).`);
    const t = transitionFor(sm, r.state, to);
    if (!t) {
      const allowed = sm.transitions.filter((x) => x.from.includes('*') || (r.state != null && x.from.includes(r.state))).map((x) => x.to);
      throw new HttpProblem(409, 'Illegal transition', `${entity.name} records cannot go from ${r.state ?? 'no state'} to ${to}.${allowed.length ? ` From ${r.state} they can go to ${[...new Set(allowed)].join(', ')}.` : ''}`, { extensions: { from: r.state, to, allowed: [...new Set(allowed)] } });
    }
    if (t.roles?.length && actor.principal && !actor.principal.roles.some((x) => t.roles!.includes(x) || x === 'system-admin')) throw forbidden(`Only ${t.roles.join(', ')} may move a record to ${to}.`, { step: 'role' });
    const now = Date.now();
    const by = actor.principal?.userId ?? null;
    const n = await this.db('app_records').where({ id: r.id, version: r.version, state: r.state }).update({ state: to, version: r.version + 1, updated_by: by, updated_at: now });
    if (n !== 1) throw conflict('The record changed while moving it; read it again and retry.');
    const after: RecordRow = { ...r, state: to, version: r.version + 1, updated_by: by, updated_at: now };
    await this.after(actor, app, entity, after, 'transitioned', { from: r.state ?? '', to, ...(t.name ? { transition: t.name } : {}), ...(o.note ? { note: o.note.slice(0, 300) } : {}) });
    return this.view(app, entity, after);
  }

  /**
   * Bulk writes (B-2202): up to APPS_BULK_MAX creates, updates and deletes, all validated and sealed first, then
   * written in one transaction, so a duplicate or a stale version anywhere writes nothing.
   */
  async bulk(actor: Actor & { principal: Principal }, app: AppRow, entity: EntityRow, ops: { create?: { values: Values; label?: Label }[]; update?: { id: string; values: Values; version?: number }[]; delete?: string[] }) {
    const p = actor.principal;
    const total = (ops.create?.length ?? 0) + (ops.update?.length ?? 0) + (ops.delete?.length ?? 0);
    if (!total) throw badRequest('Nothing to write.');
    if (total > this.o.maxBulk) throw badRequest(`A bulk write has at most ${this.o.maxBulk} operations.`);
    const ids = [...(ops.update ?? []).map((u) => u.id), ...(ops.delete ?? [])];
    if (new Set(ids).size !== ids.length) throw badRequest('A record appears twice in one bulk write.');
    const t = Date.now();
    const created: { r: RecordRow; prep: Prepared }[] = [];
    const updated: { r: RecordRow; prep: Prepared; fields: string[] }[] = [];
    const deleted: RecordRow[] = [];
    const at = (kind: string, i: number, err: unknown): never => {
      if (err instanceof HttpProblem) throw new HttpProblem(err.status, err.title, `${kind} ${i + 1}: ${err.detail ?? err.title}`, { extensions: { ...(err.extensions ?? {}), op: kind, index: i } });
      throw err;
    };
    for (const [i, c] of (ops.create ?? []).entries()) {
      try {
        const id = ulid();
        const label = this.recordLabel(actor, app, entity, c.label);
        const prep = await this.prepare(actor, app, entity, id, c.values, null);
        created.push({ prep, r: { id, tenant_id: app.tenant_id, app_id: app.id, entity_id: entity.id, workspace_id: app.workspace_id, label, state: entity.definition.states?.initial ?? null, data: prep.sealed, hidden: false, version: 1, source: actor.source, ai_state: this.hasAi(entity) ? 'pending' : null, ai_error: null, created_by: p.userId, updated_by: p.userId, created_at: t, updated_at: t } });
      } catch (err) {
        at('create', i, err);
      }
    }
    for (const [i, u] of (ops.update ?? []).entries()) {
      try {
        const r = await this.readable(p, entity, u.id);
        if (u.version != null && u.version !== r.version) throw conflict(`The record ${r.id} changed (version ${r.version}, you have ${u.version}).`);
        const existing = await this.open(r);
        const prep = await this.prepare(actor, app, entity, r.id, u.values, existing);
        updated.push({ r, prep, fields: Object.keys(u.values).filter((k) => JSON.stringify(existing[k] ?? null) !== JSON.stringify(prep.values[k] ?? null)) });
      } catch (err) {
        at('update', i, err);
      }
    }
    for (const [i, id] of (ops.delete ?? []).entries()) {
      try {
        deleted.push(await this.readable(p, entity, id));
      } catch (err) {
        at('delete', i, err);
      }
    }
    await this.db.transaction(async (trx) => {
      for (const d of deleted) {
        await this.clearIndex(trx, d.id);
        await trx('app_records').where({ id: d.id }).delete();
      }
      for (const u of updated) {
        const n = await trx('app_records').where({ id: u.r.id, version: u.r.version }).update({ data: u.prep.sealed, version: u.r.version + 1, updated_by: p.userId, updated_at: t });
        if (n !== 1) throw conflict(`The record ${u.r.id} changed while saving; nothing was written.`);
        await this.clearIndex(trx, u.r.id);
      }
      for (const u of updated) await this.writeIndex(trx, u.r, u.prep, entity);
      for (const c of created) {
        await trx('app_records').insert(c.r);
        await this.writeIndex(trx, c.r, c.prep, entity);
      }
    });
    const quiet: Actor = { ...actor };
    for (const c of created) await this.after(quiet, app, entity, c.r, 'created', {}, true, false);
    for (const u of updated) await this.after(quiet, app, entity, { ...u.r, version: u.r.version + 1, updated_at: t, updated_by: p.userId }, 'updated', { fields: u.fields }, this.hasAi(entity) && u.fields.length > 0, false);
    for (const d of deleted) await this.after(quiet, app, entity, d, 'deleted', {}, false, false);
    await this.audit(actor, app.tenant_id, 'app.records.bulk', { app: app.id, entity: entity.id }, highest(entity.label, ...created.map((c) => c.r.label), ...updated.map((u) => u.r.label), ...deleted.map((d) => d.label)), {
      created: created.map((c) => c.r.id).slice(0, 500),
      updated: updated.map((u) => u.r.id).slice(0, 500),
      deleted: deleted.map((d) => d.id).slice(0, 500)
    });
    return { created: created.map((c) => c.r.id), updated: updated.map((u) => u.r.id), deleted: deleted.map((d) => d.id) };
  }

  /** After a write: audit (unless the caller audits a batch), the `record.*` event, triggers and the AI fill. */
  private async after(actor: Actor, app: AppRow, entity: EntityRow, r: RecordRow, event: RecordEvent, extra: Record<string, unknown>, ai = event === 'created', audited = true): Promise<void> {
    const s = this.s();
    const actorId = actor.principal?.userId ?? null;
    if (audited) await this.audit(actor, r.tenant_id, `app.record.${event}`, { app: app.id, entity: entity.id, record: r.id }, r.label, { source: actor.source, version: r.version, ...extra });
    const data: Record<string, unknown> = { app: app.id, entity: entity.name, record: r.id, workspace: app.workspace_id, actor: actorId };
    if (event === 'updated') data.fields = ((extra.fields as string[] | undefined) ?? []).slice(0, 500);
    if (event === 'transitioned') Object.assign(data, { from: String(extra.from ?? ''), to: String(extra.to ?? '') });
    s.bus.emitLocal(TOPICS.integrationEvent, { tenantId: r.tenant_id, type: `record.${event}`, label: r.label, id: `record.${event}:${ulid()}`, data } satisfies IntegrationEvent);
    await this.triggers.onRecordEvent(app, entity, r, event, extra, actor).catch((err: Error) => s.log.warn({ record: r.id, err: err.message }, 'record triggers not queued'));
    if (ai && this.hasAi(entity) && event !== 'deleted') await s.jobs.enqueue({ tenantId: r.tenant_id, type: 'apps.ai-fill', payload: { recordId: r.id }, createdBy: actorId, maxAttempts: 3 });
  }

  // ---------- lookups (B-2203) ----------

  /** Options for a lookup, reference, enum or file field, filtered by `q`. */
  async options(p: Principal, appRef: string, entityRef: string, fieldName: string, q: string | null, limit = 20): Promise<{ value: string; label: string }[]> {
    const { app, entity } = await this.resolve(p, appRef, entityRef);
    const f = entity.definition.fields.find((x) => x.name === fieldName);
    if (!f) throw notFound('Field');
    const needle = q ? normText(q) : null;
    const match = (label: string) => !needle || normText(label).includes(needle);
    const opts = (list: { value: string; label?: string | undefined }[]) => list.map((o) => ({ value: o.value, label: o.label ?? o.value })).filter((o) => match(o.label) || match(o.value)).slice(0, limit);
    if (f.type === 'enum') return opts(f.options);
    if (f.type === 'lookup' && f.source === 'static') return opts(f.options ?? []);
    if (f.type === 'lookup' && f.source === 'user') {
      const like = needle ? `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const qb = this.db('users').where({ tenant_id: p.tenantId, state: 'active' });
      if (like) qb.andWhere((w) => w.whereRaw('lower(username) like ? escape ?', [like, '\\']).orWhereRaw('lower(display_name) like ? escape ?', [like, '\\']));
      return ((await qb.orderBy('display_name').limit(limit).select('id', 'display_name')) as { id: string; display_name: string }[]).map((u) => ({ value: u.id, label: u.display_name }));
    }
    if (f.type === 'lookup' && f.source === 'workspace') return [...(await this.workspaces(p)).values()].map((w) => ({ value: w.id, label: w.name })).filter((o) => match(o.label)).slice(0, limit);
    const targetName = f.type === 'reference' ? f.entity : f.type === 'lookup' && f.source === 'entity' ? f.entity : null;
    if (!targetName) throw badRequest(`${f.name} is a ${f.type} field; it has no options.`);
    const target = await this.entityOf(app, targetName);
    const display = (f.type === 'lookup' ? f.display : undefined) ?? titleFieldOf(target.definition);
    const displayField = display ? target.definition.fields.find((x) => x.name === display) : undefined;
    const qb = this.base(p, target);
    if (needle && displayField && (displayField.indexed || displayField.unique)) applyFilter(qb, { field: displayField.name, op: 'contains', value: q! }, this.qctx(target));
    applySort(qb, displayField && (displayField.indexed || displayField.unique) ? [{ field: displayField.name, dir: 'asc' }] : [], this.qctx(target));
    const rows = ((await qb.select('r.*').limit(needle && !(displayField?.indexed || displayField?.unique) ? 500 : limit)) as Record<string, unknown>[]).map(recordFrom);
    const out: { value: string; label: string }[] = [];
    for (const r of rows) {
      const v = await this.open(r);
      const label = display && v[display] != null ? String(v[display]) : r.id;
      if (match(label)) out.push({ value: r.id, label });
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---------- AI fields (B-2207) ----------

  /**
   * Fills a record's AI fields from their profile prompts. It fails soft: a model that is down, refuses, or answers
   * with something the guardrails hold leaves the field empty, records why (`ai_error`, audited), and keeps the record.
   */
  async fillAi(recordId: string): Promise<unknown> {
    const s = this.s();
    const raw = await this.db('app_records').where({ id: recordId }).first();
    if (!raw) return { skipped: 'gone' };
    const r = recordFrom(raw);
    const entity = await this.entityById(r.tenant_id, r.entity_id);
    const app = await this.appById(r.tenant_id, r.app_id);
    if (!entity || !app) return { skipped: 'gone' };
    const fields = entity.definition.fields.filter((f): f is Extract<Field, { type: 'ai' }> => f.type === 'ai');
    if (!fields.length) return { skipped: 'no AI fields' };
    const values = await this.open(r);
    const principal = r.updated_by ? await loadPrincipal(s, r.tenant_id, r.updated_by, {}) : null;
    if (principal) principal.workspaceId = app.workspace_id;
    const filled: Record<string, string> = {};
    const failed: Record<string, string> = {};
    for (const f of fields) {
      const prompt = f.prompt.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_m, k: string) => {
        const v = values[k];
        return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
      });
      try {
        const text = (await generate(s, { tenantId: r.tenant_id, workspaceId: app.workspace_id, profile: f.profile, prompt, label: r.label, principal, userId: r.updated_by, source: { kind: 'app-record', id: r.id } })).trim();
        if (text) filled[f.name] = [...text].slice(0, f.maxLength).join('');
        else failed[f.name] = 'the model gave an empty answer';
      } catch (err) {
        failed[f.name] = ((err as Error).message || 'the model call failed').slice(0, 200);
      }
    }
    // Merge into the record as it is now; a write meanwhile makes the job retry.
    const nowRaw = await this.db('app_records').where({ id: r.id }).first();
    if (!nowRaw) return { skipped: 'gone' };
    const cur = recordFrom(nowRaw);
    const curValues = await this.open(cur);
    for (const f of fields) {
      if (filled[f.name] != null) curValues[f.name] = filled[f.name];
      else delete curValues[f.name];
    }
    const sealed = await s.keys.seal(r.tenant_id, JSON.stringify(curValues), recordAad(r.id));
    const errText = Object.keys(failed).length ? Object.entries(failed).map(([k, v]) => `${k}: ${v}`).join('; ').slice(0, 300) : null;
    await this.db.transaction(async (trx) => {
      const n = await trx('app_records').where({ id: cur.id, version: cur.version }).update({ data: sealed, version: cur.version + 1, ai_state: errText ? 'failed' : 'filled', ai_error: errText, updated_at: Date.now() });
      if (n !== 1) throw new Error('the record changed while its AI fields were filled; retrying');
      await trx('app_record_values').where({ record_id: cur.id }).delete();
      const rows = indexRows(entity.definition, curValues);
      if (rows.length) await trx('app_record_values').insert(rows.map((x) => ({ record_id: cur.id, tenant_id: cur.tenant_id, entity_id: cur.entity_id, ...x })));
    });
    const actor: Actor = { principal: null, source: cur.source, service: 'apps.ai' };
    if (errText) await this.audit(actor, r.tenant_id, 'app.record.ai.failed', { app: app.id, entity: entity.id, record: r.id }, r.label, { fields: Object.keys(failed), filled: Object.keys(filled), reasons: failed });
    if (Object.keys(filled).length) {
      await this.audit(actor, r.tenant_id, 'app.record.ai.filled', { app: app.id, entity: entity.id, record: r.id }, r.label, { fields: Object.keys(filled) });
      s.bus.emitLocal(TOPICS.integrationEvent, { tenantId: r.tenant_id, type: 'record.updated', label: r.label, id: `record.updated:${ulid()}`, data: { app: app.id, entity: entity.name, record: r.id, workspace: app.workspace_id, actor: null, fields: Object.keys(filled) } } satisfies IntegrationEvent);
    }
    return { filled: Object.keys(filled), failed: Object.keys(failed) };
  }

  // ---------- reindex ----------

  /** Recomputes formulas and the clear index of every record of an entity (after its indexed fields changed). */
  private async reindex(entityId: string, ctx: JobContext): Promise<unknown> {
    const s = this.s();
    const e = await this.db('app_entities').where({ id: entityId }).first();
    if (!e) return { skipped: 'gone' };
    const entity = entityFrom(e);
    const total = Number(((await this.db('app_records').where({ entity_id: entityId }).count({ n: '*' })) as Record<string, unknown>[])[0]?.n ?? 0);
    let done = 0;
    let after = '';
    for (;;) {
      const rows = ((await this.db('app_records').where({ entity_id: entityId }).andWhere('id', '>', after).orderBy('id').limit(200)) as Record<string, unknown>[]).map(recordFrom);
      if (!rows.length) break;
      for (const r of rows) {
        const values = computeFormulas(entity.definition, await this.open(r));
        const sealed = await s.keys.seal(r.tenant_id, JSON.stringify(values), recordAad(r.id));
        await this.db.transaction(async (trx) => {
          await trx('app_records').where({ id: r.id }).update({ data: sealed });
          await trx('app_record_values').where({ record_id: r.id }).delete();
          const idx = indexRows(entity.definition, values);
          if (idx.length) await trx('app_record_values').insert(idx.map((x) => ({ record_id: r.id, tenant_id: r.tenant_id, entity_id: r.entity_id, ...x })));
          // Unique keys of fields that are no longer unique go; new unique fields only start empty (see updateEntity).
          const keep = new Set(entity.definition.fields.filter((f) => f.unique).map((f) => f.name));
          const stale = ((await trx('app_unique_values').where({ record_id: r.id }).select('field')) as { field: string }[]).filter((k) => !keep.has(k.field)).map((k) => k.field);
          if (stale.length) await trx('app_unique_values').where({ record_id: r.id }).whereIn('field', stale).delete();
        });
        after = r.id;
        done++;
      }
      await ctx.progress(total ? Math.min(99, Math.round((done * 100) / total)) : 99, `${done} of ${total} records`);
    }
    return { records: done };
  }

  // ---------- CSV import and export (B-2202) ----------

  async transfer(p: Principal, id: string) {
    const r = (await this.db('app_transfers').where({ tenant_id: p.tenantId, id }).first()) as Record<string, unknown> | undefined;
    if (!r || (r.created_by !== p.userId && !effectivePermissions(p).has('apps:design'))) throw notFound('Transfer');
    return { id: String(r.id), kind: String(r.kind), state: String(r.state), dryRun: !!r.dry_run, summary: json<Record<string, unknown> | null>(r.summary, null), report: json<unknown[]>(r.report, []), error: (r.error as string | null) ?? null, jobId: (r.job_id as string | null) ?? null, createdBy: String(r.created_by), createdAt: Number(r.created_at), finishedAt: num(r.finished_at), download: r.kind === 'export' && r.state === 'succeeded' && r.created_by === p.userId };
  }

  async submitImport(actor: Actor & { principal: Principal }, app: AppRow, entity: EntityRow, csv: string, dryRun: boolean): Promise<{ id: string; jobId: string }> {
    const p = actor.principal;
    if (Buffer.byteLength(csv) > this.o.maxImportBytes) throw new HttpProblem(413, 'Too large', `The CSV is larger than ${this.o.maxImportBytes} bytes (APPS_IMPORT_MAX_BYTES).`);
    const rows = parseCsv(csv, this.o.maxImportRows);
    if (rows.length < 2) throw badRequest('The CSV needs a header row and at least one record.');
    this.importHeader(entity, rows[0]!);
    const id = ulid();
    await this.db('app_transfers').insert({ id, tenant_id: p.tenantId, app_id: app.id, entity_id: entity.id, kind: 'import', state: 'queued', dry_run: dryRun, input: await this.s().keys.seal(p.tenantId, csv, transferAad(id)), blob_key: null, summary: null, report: null, error: null, job_id: null, created_by: p.userId, created_at: Date.now(), finished_at: null });
    const job = await this.s().jobs.enqueue({ tenantId: p.tenantId, type: 'apps.import', payload: { transferId: id }, createdBy: p.userId, maxAttempts: 1 });
    await this.db('app_transfers').where({ id }).update({ job_id: job.id });
    await this.audit(actor, p.tenantId, 'app.records.import.queued', { app: app.id, entity: entity.id, transfer: id }, entity.label, { rows: rows.length - 1, dryRun });
    return { id, jobId: job.id };
  }

  /** Header cells name fields; system columns (id, state, label, timestamps) are read where they make sense, else ignored. */
  private importHeader(entity: EntityRow, header: string[]): (Field | 'label' | null)[] {
    const byName = new Map(entity.definition.fields.map((f) => [f.name, f]));
    const out: (Field | 'label' | null)[] = [];
    const unknown: string[] = [];
    for (const h of header.map((x) => x.trim())) {
      if (h === 'label') out.push('label');
      else if (['id', 'state', 'version', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'].includes(h)) out.push(null);
      else {
        const f = byName.get(h);
        if (!f) unknown.push(h);
        else if (isComputed(f)) out.push(null);
        else out.push(f);
      }
    }
    if (unknown.length) throw badRequest(`The header names columns that are not fields of ${entity.name}: ${unknown.slice(0, 10).join(', ')}.`);
    return out;
  }

  private async finishTransfer(id: string, patch: Record<string, unknown>): Promise<void> {
    await this.db('app_transfers').where({ id }).update({ ...patch, finished_at: Date.now() });
  }

  /** The import job: each row is a record of its own, so a bad row is reported and the others are written. */
  private async runImport(transferId: string, ctx: JobContext): Promise<unknown> {
    const s = this.s();
    const t = (await this.db('app_transfers').where({ id: transferId }).first()) as Record<string, unknown> | undefined;
    if (!t || t.state !== 'queued') return { skipped: t?.state ?? 'gone' };
    await this.db('app_transfers').where({ id: transferId }).update({ state: 'running' });
    const tenantId = String(t.tenant_id);
    const fail = async (error: string) => {
      await this.finishTransfer(transferId, { state: 'failed', error: error.slice(0, 500), input: null });
      return { error };
    };
    const p = await loadPrincipal(s, tenantId, String(t.created_by), {});
    if (!p || !authorize(p, 'records:write').allow) return fail('The person who started the import can no longer write records.');
    const app = await this.appById(tenantId, String(t.app_id));
    const entity = await this.entityById(tenantId, String(t.entity_id));
    if (!app || !entity) return fail('The app or entity is gone.');
    p.workspaceId = app.workspace_id;
    const csv = await s.keys.open(tenantId, String(t.input), transferAad(transferId));
    const rows = parseCsv(csv, this.o.maxImportRows);
    const cols = this.importHeader(entity, rows[0]!);
    const dry = !!t.dry_run;
    const report: { row: number; problem: string }[] = [];
    const actor: Actor & { principal: Principal } = { principal: p, source: 'import' };
    let created = 0;
    const seen = new Map<string, number>();
    const data = rows.slice(1);
    for (const [i, cells] of data.entries()) {
      if (ctx.signal.aborted) throw ctx.signal.reason as Error;
      if (cells.length === 1 && cells[0] === '') continue;
      const values: Values = {};
      let label: Label | undefined;
      cols.forEach((c, j) => {
        const cell = cells[j] ?? '';
        if (c === 'label') {
          if (cell) label = cell as Label;
        } else if (c) values[c.name] = fromCell(c, cell);
      });
      try {
        if (label && !LABELS.includes(label)) throw badRequest(`${label} is not a label.`);
        if (dry) {
          const prep = await this.prepare(actor, app, entity, ulid(), values, null);
          this.recordLabel(actor, app, entity, label);
          for (const k of prep.keys) {
            const key = `${k.field}:${k.hash}`;
            const dup = seen.get(key) ?? ((await this.db('app_unique_values').where({ entity_id: entity.id, field: k.field, value_hash: k.hash }).first('record_id')) ? 0 : undefined);
            if (dup !== undefined) throw conflict(`${k.field} duplicates ${dup ? `row ${dup}` : 'an existing record'}; it is unique.`);
            seen.set(key, i + 2);
          }
          created++;
        } else {
          await this.createRecord(actor, app, entity, { values, ...(label ? { label } : {}) });
          created++;
        }
      } catch (err) {
        const msg = err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message;
        if (report.length < 500) report.push({ row: i + 2, problem: msg.slice(0, 300) });
      }
      if (i % 50 === 0) await ctx.progress(Math.min(99, Math.round(((i + 1) * 100) / data.length)), `${i + 1} of ${data.length} rows`);
    }
    const summary = { rows: data.length, created: dry ? 0 : created, valid: created, failed: data.length - created, dryRun: dry };
    await this.finishTransfer(transferId, { state: 'succeeded', summary: JSON.stringify(summary), report: JSON.stringify(report), input: null });
    await this.audit(actor, tenantId, dry ? 'app.records.import.checked' : 'app.records.imported', { app: app.id, entity: entity.id, transfer: transferId }, entity.label, summary);
    return summary;
  }

  async submitExport(actor: Actor & { principal: Principal }, app: AppRow, entity: EntityRow, input: { filter?: Filter; q?: string; sort?: Sort }): Promise<{ id: string; jobId: string }> {
    const p = actor.principal;
    if (input.filter) checkFilterSize(input.filter);
    // Check the query now, so a bad filter is a 400 and not a failed job.
    const probe = this.base(p, entity);
    if (input.filter) applyFilter(probe, input.filter, this.qctx(entity));
    if (input.q) applySearch(probe, input.q, this.qctx(entity));
    applySort(probe, input.sort ?? [], this.qctx(entity));
    const id = ulid();
    await this.db('app_transfers').insert({ id, tenant_id: p.tenantId, app_id: app.id, entity_id: entity.id, kind: 'export', state: 'queued', dry_run: false, input: JSON.stringify(input), blob_key: null, summary: null, report: null, error: null, job_id: null, created_by: p.userId, created_at: Date.now(), finished_at: null });
    const job = await this.s().jobs.enqueue({ tenantId: p.tenantId, type: 'apps.export', payload: { transferId: id }, createdBy: p.userId, maxAttempts: 2 });
    await this.db('app_transfers').where({ id }).update({ job_id: job.id });
    await this.audit(actor, p.tenantId, 'app.records.export.queued', { app: app.id, entity: entity.id, transfer: id }, entity.label);
    return { id, jobId: job.id };
  }

  /** The export job: records the starter may read, now, as a CSV sealed into the blob store. */
  private async runExport(transferId: string, ctx: JobContext): Promise<unknown> {
    const s = this.s();
    const t = (await this.db('app_transfers').where({ id: transferId }).first()) as Record<string, unknown> | undefined;
    if (!t || (t.state !== 'queued' && t.state !== 'running')) return { skipped: t?.state ?? 'gone' };
    await this.db('app_transfers').where({ id: transferId }).update({ state: 'running' });
    const tenantId = String(t.tenant_id);
    const p = await loadPrincipal(s, tenantId, String(t.created_by), {});
    const app = await this.appById(tenantId, String(t.app_id));
    const entity = await this.entityById(tenantId, String(t.entity_id));
    if (!p || !authorize(p, 'records:read').allow || !app || !entity) {
      await this.finishTransfer(transferId, { state: 'failed', error: 'The person who started the export can no longer read these records.' });
      return { error: 'not allowed' };
    }
    p.workspaceId = app.workspace_id;
    const input = json<{ filter?: Filter; q?: string; sort?: Sort }>(t.input, {});
    const fields = entity.definition.fields;
    const lines = [['id', 'state', 'label', 'createdAt', 'updatedAt', ...fields.map((f) => f.name)].map(csvCell).join(',')];
    let done = 0;
    let total = 0;
    let cursor: string | null = null;
    let label: Label = entity.label;
    for (;;) {
      // Keyset pages (B-3601): each page starts where the last ended, and only the first counts the matches.
      const page = await this.query(p, app.id, entity.id, { ...(input.filter ? { filter: input.filter } : {}), ...(input.q ? { q: input.q } : {}), sort: input.sort ?? [], limit: 500, ...(cursor ? { cursor, count: false } : {}) });
      if (page.total != null) total = page.total;
      for (const r of page.records) {
        lines.push([r.id, r.state, r.label, new Date(r.createdAt).toISOString(), new Date(r.updatedAt).toISOString(), ...fields.map((f) => r.values[f.name])].map(csvCell).join(','));
        label = highest(label, r.label);
      }
      done += page.records.length;
      cursor = page.nextCursor;
      await ctx.progress(total ? Math.min(99, Math.round((done * 100) / total)) : 99, `${done} of ${total} records`);
      if (!cursor) break;
      if (done >= this.o.maxExportRows) {
        await this.finishTransfer(transferId, { state: 'failed', error: `More than ${this.o.maxExportRows} records match (APPS_EXPORT_MAX_ROWS); narrow the filter.` });
        return { error: 'too many' };
      }
    }
    const body = Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
    const key = `apps/${tenantId}/exports/${transferId}.csv.sealed`;
    await s.blobs.put(key, Buffer.from(await s.keys.sealBytes(tenantId, body, transferAad(transferId)), 'utf8'), 'application/octet-stream');
    const summary = { records: lines.length - 1, bytes: body.length, label };
    await this.finishTransfer(transferId, { state: 'succeeded', blob_key: key, summary: JSON.stringify(summary) });
    await this.audit({ principal: p, source: 'api' }, tenantId, 'app.records.exported', { app: app.id, entity: entity.id, transfer: transferId }, label, summary);
    return summary;
  }

  /** The CSV an export wrote, for the person who started it (audited). */
  async download(actor: Actor & { principal: Principal }, id: string): Promise<{ name: string; body: Buffer }> {
    const p = actor.principal;
    const t = (await this.db('app_transfers').where({ tenant_id: p.tenantId, id, kind: 'export' }).first()) as Record<string, unknown> | undefined;
    if (!t || t.created_by !== p.userId) throw notFound('Export');
    if (t.state !== 'succeeded' || !t.blob_key) throw conflict(`The export is ${String(t.state)}.`);
    const summary = json<{ label?: Label }>(t.summary, {});
    if (summary.label && !clears(p.clearance, summary.label)) throw forbidden(`The export is ${summary.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    const sealed = await this.s().blobs.get(String(t.blob_key));
    if (!sealed) throw notFound('Export file');
    const body = await this.s().keys.openBytes(p.tenantId, sealed.toString('utf8'), transferAad(id));
    const entity = await this.entityById(p.tenantId, String(t.entity_id));
    await this.audit(actor, p.tenantId, 'app.records.downloaded', { transfer: id, entity: String(t.entity_id) }, summary.label ?? 'internal', { bytes: body.length });
    return { name: `${entity?.name ?? 'records'}-${id}.csv`, body };
  }

  // ---------- moderation (B-1902) ----------

  async moderationTarget(tenantId: string, id: string): Promise<{ id: string; workspaceId: string | null; label: Label; ownerId: string | null; hidden: boolean } | null> {
    const r = await this.db('app_records').where({ tenant_id: tenantId, id }).first();
    if (!r) return null;
    const rec = recordFrom(r);
    return { id: rec.id, workspaceId: rec.workspace_id, label: rec.label, ownerId: rec.created_by, hidden: rec.hidden };
  }

  /** The record's text values, for a moderation check. */
  async moderationText(tenantId: string, id: string): Promise<string> {
    const r = await this.db('app_records').where({ tenant_id: tenantId, id }).first();
    if (!r) return '';
    const v = await this.open(recordFrom(r));
    return Object.values(v).filter((x) => typeof x === 'string').join('\n').slice(0, 50_000);
  }

  async setHidden(tenantId: string, id: string, hidden: boolean): Promise<boolean> {
    return (await this.db('app_records').where({ tenant_id: tenantId, id, hidden: !hidden }).update({ hidden })) === 1;
  }
}
