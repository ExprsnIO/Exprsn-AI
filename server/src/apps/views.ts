import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { clears, LABELS, labelRank, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { boardGrouping } from './board.js';
import { filterSchema, OPS, sortSchema } from './query.js';
import type { Actor, AppRow, AppService, EntityRow } from './service.js';

/*
 * Saved views of the Records tab (the exprsn-platform low-code port, docs/decisions/lowcode-port.md, follow-up 1). A
 * view is a named configuration of one entity's records: the layout (table or board) and the board's group field, the
 * filters, search, sort, the visible columns in their order and the rows per page. It is private to its owner, or
 * shared with everyone who reads the app's records (sharing needs `apps:design` and the app's label within the
 * designer's clearance). A person may pick one view per entity as their default.
 *
 * A view stores query settings only. Records are always read through the records routes and so through the reader's
 * grant (`AppService.grantFor`), clearance and hidden rules: opening someone's shared view shows each reader what they
 * may read, no more. The name and the settings are sealed with the tenant key (`app-view:<id>`); the view carries a
 * label (the entity's at least, the app's at most) and is listed only to those it clears.
 */

const META = ['state', 'label', 'version', 'source', 'ai', 'updated'] as const;
const SYSTEM = new Set(['id', 'state', 'createdAt', 'updatedAt', 'createdBy']);
const scalar = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);
// 1.8.0 (B-128): a relation filter (`matches` with its `where` on the linked records) and `<relation>.count`.
const leaf = z.object({ field: z.string().min(1).max(70), op: z.enum(OPS), value: z.union([scalar, z.array(scalar).max(100)]).optional(), where: filterSchema.optional() }).strict();

export const viewSettingsSchema = z
  .object({
    layout: z.enum(['table', 'board']).default('table'),
    /** The board's grouping: `@state` or an indexed enum or static-lookup field; null for the first one offered. */
    groupBy: z.string().min(1).max(63).nullable().default(null),
    filters: z.array(leaf).max(30).default([]),
    filterMode: z.enum(['and', 'or']).default('and'),
    /** The state filter of the toolbar; null for every state. */
    state: z.string().min(1).max(60).nullable().default(null),
    q: z.string().trim().max(200).default(''),
    sort: sortSchema.default([]),
    /** The visible columns in their order (fields) and the record columns shown; null for the entity's defaults. */
    columns: z.object({ fields: z.array(z.string().min(1).max(63)).max(200), meta: z.array(z.enum(META)).max(META.length) }).strict().nullable().default(null),
    pageSize: z.union([z.literal(10), z.literal(25), z.literal(50), z.literal(100), z.literal(200)]).default(25)
  })
  .strict();
export type ViewSettings = z.infer<typeof viewSettingsSchema>;

export const viewInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    shared: z.boolean().default(false),
    label: z.enum(LABELS).optional(),
    settings: viewSettingsSchema
  })
  .strict();
export const viewPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    shared: z.boolean().optional(),
    label: z.enum(LABELS).optional(),
    settings: viewSettingsSchema.optional()
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to change');

/** Views one person keeps on one entity, and shared views on one entity. */
const MAX_OWN = 50;
const MAX_SHARED = 50;

interface ViewRow {
  id: string;
  tenant_id: string;
  app_id: string;
  entity_id: string;
  owner_id: string;
  shared: boolean;
  label: Label;
  data: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
}
const rowFrom = (r: Record<string, unknown>): ViewRow => ({ ...(r as unknown as ViewRow), shared: !!r.shared, created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const aad = (id: string) => `app-view:${id}`;

/** Every problem with a view's settings on an entity (fields that are not there, filters and sorts on unindexed ones). */
export function viewProblems(entity: EntityRow, s: ViewSettings, links: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  const def = entity.definition;
  const byName = new Map(def.fields.map((f) => [f.name, f]));
  // `links`: the entity's relations (its own and two-way or read-only back-references), filtered through their links
  const linked = (n: string) => links.has(n.endsWith('.count') ? n.slice(0, -'.count'.length) : n);
  const queryable = (n: string) => SYSTEM.has(n) || linked(n) || (byName.get(n)?.indexed ?? false) || (byName.get(n)?.unique ?? false);
  for (const f of s.filters) if (!queryable(f.field)) out.push(`Filter: ${f.field} is not ${byName.has(f.field) ? 'indexed' : 'a field of ' + entity.name}.`);
  for (const x of s.sort) if (!queryable(x.field) || (links.has(x.field) && !x.field.endsWith('.count'))) out.push(`Sort: ${x.field} is not ${links.has(x.field) ? 'sortable; sort by ' + x.field + '.count' : byName.has(x.field) ? 'indexed' : 'a field of ' + entity.name}.`);
  if (s.state != null && !def.states?.states.some((x) => x.name === s.state)) out.push(`State: ${s.state} is not a state of ${entity.name}.`);
  if (s.columns) for (const n of s.columns.fields) if (!byName.has(n)) out.push(`Columns: ${n} is not a field of ${entity.name}.`);
  if (s.groupBy != null) {
    try {
      boardGrouping(entity, s.groupBy);
    } catch (err) {
      out.push(`Group by: ${(err as Error).message}`);
    }
  }
  return out;
}

export class AppViews {
  constructor(
    private readonly s: () => Services,
    private readonly apps: AppService
  ) {}

  private get db() {
    return this.s().db;
  }

  private designer(p: Principal): boolean {
    return effectivePermissions(p).has('apps:design');
  }

  /** May this person change the view: its owner, or (a shared view) a designer cleared for the app. */
  private canEdit(p: Principal, app: AppRow, v: ViewRow): boolean {
    if (!clears(p.clearance, v.label)) return false;
    if (v.owner_id === p.userId) return true;
    return v.shared && this.designer(p) && clears(p.clearance, app.label);
  }

  private async open(v: ViewRow): Promise<{ name: string; settings: ViewSettings }> {
    const d = json<{ name?: string; settings?: unknown }>(await this.s().keys.open(v.tenant_id, v.data, aad(v.id)), {});
    const parsed = viewSettingsSchema.safeParse(d.settings ?? {});
    return { name: String(d.name ?? ''), settings: parsed.success ? parsed.data : viewSettingsSchema.parse({}) };
  }

  private seal(tenantId: string, id: string, name: string, settings: ViewSettings): Promise<string> {
    return this.s().keys.seal(tenantId, JSON.stringify({ name, settings }), aad(id));
  }

  private async present(p: Principal, app: AppRow, entity: EntityRow, v: ViewRow, defaultId: string | null) {
    const { name, settings } = await this.open(v);
    return { id: v.id, app: app.name, entity: entity.name, name, shared: v.shared, label: v.label, ownerId: v.owner_id, mine: v.owner_id === p.userId, canEdit: this.canEdit(p, app, v), isDefault: v.id === defaultId, settings, updatedBy: v.updated_by, createdAt: v.created_at, updatedAt: v.updated_at };
  }

  /** The views a reader sees on an entity: their own and the shared ones, at labels their clearance clears. */
  private async visibleRows(p: Principal, entity: EntityRow): Promise<ViewRow[]> {
    const rows = ((await this.db('app_views').where({ tenant_id: p.tenantId, entity_id: entity.id }).andWhere((q) => q.where({ owner_id: p.userId }).orWhere({ shared: true })).orderBy('created_at')) as Record<string, unknown>[]).map(rowFrom);
    return rows.filter((v) => clears(p.clearance, v.label));
  }

  private async defaultOf(p: Principal, entity: EntityRow): Promise<string | null> {
    const r = (await this.db('app_view_defaults').where({ tenant_id: p.tenantId, user_id: p.userId, entity_id: entity.id }).first()) as { view_id: string } | undefined;
    return r?.view_id ?? null;
  }

  private async visible(p: Principal, entity: EntityRow, id: string): Promise<ViewRow> {
    const v = (await this.visibleRows(p, entity)).find((x) => x.id === id);
    if (!v) throw notFound('View');
    return v;
  }

  private label(p: Principal, app: AppRow, entity: EntityRow, wanted: Label | undefined): Label {
    const l = wanted ?? entity.label;
    if (labelRank(l) < labelRank(entity.label)) throw badRequest(`A view of ${entity.name} is labelled ${entity.label} at least.`);
    if (labelRank(l) > labelRank(app.label)) throw badRequest(`The app's label is ${app.label}; a view cannot be above it.`);
    if (!clears(p.clearance, l)) throw forbidden(`Your clearance is ${p.clearance}; a ${l} view is above it.`, { step: 'clearance' });
    return l;
  }

  private async check(app: AppRow, entity: EntityRow, settings: ViewSettings): Promise<void> {
    const links = new Set((await this.apps.relations.ends(app, entity)).filter((e) => e.kind === 'relation').map((e) => e.name));
    const problems = viewProblems(entity, settings, links);
    if (problems.length) throw new HttpProblem(400, 'Invalid view', problems[0]!, { extensions: { problems } });
  }

  private assertShare(p: Principal, app: AppRow): void {
    if (!this.designer(p)) throw forbidden('Sharing a view with the app\'s readers needs apps:design.', { step: 'role' });
    if (!clears(p.clearance, app.label)) throw forbidden(`The app holds records up to ${app.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
  }

  private async assertName(p: Principal, entity: EntityRow, name: string, shared: boolean, exceptId?: string): Promise<void> {
    const rows = (await this.visibleRows(p, entity)).filter((v) => v.id !== exceptId && (shared ? v.shared : v.owner_id === p.userId));
    for (const v of rows) if ((await this.open(v)).name.toLowerCase() === name.toLowerCase()) throw conflict(`There is already a ${shared ? 'shared view' : 'view of yours'} named ${name} on ${entity.name}.`);
  }

  async list(p: Principal, appRef: string, entityRef: string) {
    const { app, entity } = await this.apps.resolve(p, appRef, entityRef);
    const def = await this.defaultOf(p, entity);
    const rows = await this.visibleRows(p, entity);
    const views = await Promise.all(rows.map((v) => this.present(p, app, entity, v, def)));
    views.sort((a, b) => Number(b.mine) - Number(a.mine) || a.name.localeCompare(b.name));
    return { views, defaultView: rows.some((v) => v.id === def) ? def : null, canShare: this.designer(p) && clears(p.clearance, app.label) };
  }

  async create(actor: Actor & { principal: Principal }, appRef: string, entityRef: string, input: z.infer<typeof viewInputSchema>) {
    const p = actor.principal;
    const { app, entity } = await this.apps.resolve(p, appRef, entityRef);
    if (input.shared) this.assertShare(p, app);
    await this.check(app, entity, input.settings);
    const label = this.label(p, app, entity, input.label);
    const counted = await this.db('app_views').where({ tenant_id: p.tenantId, entity_id: entity.id }).andWhere(input.shared ? { shared: true } : { owner_id: p.userId, shared: false }).count({ n: '*' });
    if (Number((counted as Record<string, unknown>[])[0]?.n ?? 0) >= (input.shared ? MAX_SHARED : MAX_OWN)) throw conflict(`At most ${input.shared ? MAX_SHARED + ' shared views' : MAX_OWN + ' views of yours'} on one entity.`);
    await this.assertName(p, entity, input.name, input.shared);
    const id = ulid();
    const now = Date.now();
    const row = { id, tenant_id: p.tenantId, app_id: app.id, entity_id: entity.id, owner_id: p.userId, shared: input.shared, label, data: await this.seal(p.tenantId, id, input.name, input.settings), updated_by: p.userId, created_at: now, updated_at: now };
    await this.db('app_views').insert(row);
    await this.audit(actor, 'app.view.created', { app: app.id, entity: entity.id, view: id }, label, { shared: input.shared, layout: input.settings.layout });
    return this.present(p, app, entity, rowFrom(row), await this.defaultOf(p, entity));
  }

  async update(actor: Actor & { principal: Principal }, appRef: string, entityRef: string, id: string, patch: z.infer<typeof viewPatchSchema>) {
    const p = actor.principal;
    const { app, entity } = await this.apps.resolve(p, appRef, entityRef);
    const v = await this.visible(p, entity, id);
    if (!this.canEdit(p, app, v)) throw forbidden(v.shared ? 'Only its owner or a designer of the app changes a shared view.' : 'Only its owner changes a view.', { step: 'owner' });
    // Sharing and unsharing are design changes; so is any change to someone else's shared view (canEdit checked it).
    if (patch.shared !== undefined && patch.shared !== v.shared) this.assertShare(p, app);
    const cur = await this.open(v);
    const name = patch.name ?? cur.name;
    const settings = patch.settings ?? cur.settings;
    const shared = patch.shared ?? v.shared;
    if (patch.settings) await this.check(app, entity, settings);
    const label = patch.label ? this.label(p, app, entity, patch.label) : v.label;
    if (patch.name !== undefined || patch.shared !== undefined) await this.assertName(p, entity, name, shared, v.id);
    const now = Date.now();
    const data = await this.seal(v.tenant_id, v.id, name, settings);
    await this.db('app_views').where({ id: v.id }).update({ shared, label, data, updated_by: p.userId, updated_at: now });
    // A view that is no longer shared (or now above someone's clearance) stops being their default.
    if (v.shared && !shared) await this.db('app_view_defaults').where({ tenant_id: v.tenant_id, view_id: v.id }).whereNot({ user_id: v.owner_id }).delete();
    const changed = [...(patch.name !== undefined ? ['name'] : []), ...(patch.settings ? ['settings'] : []), ...(patch.shared !== undefined ? ['shared'] : []), ...(patch.label ? ['label'] : [])];
    await this.audit(actor, 'app.view.updated', { app: app.id, entity: entity.id, view: v.id }, label, { changed, shared, ...(v.owner_id !== p.userId ? { owner: v.owner_id } : {}) });
    return this.present(p, app, entity, { ...v, shared, label, data, updated_by: p.userId, updated_at: now }, await this.defaultOf(p, entity));
  }

  async remove(actor: Actor & { principal: Principal }, appRef: string, entityRef: string, id: string): Promise<void> {
    const p = actor.principal;
    const { app, entity } = await this.apps.resolve(p, appRef, entityRef);
    const v = await this.visible(p, entity, id);
    if (!this.canEdit(p, app, v)) throw forbidden(v.shared ? 'Only its owner or a designer of the app deletes a shared view.' : 'Only its owner deletes a view.', { step: 'owner' });
    await this.db.transaction(async (trx) => {
      await trx('app_view_defaults').where({ tenant_id: v.tenant_id, view_id: v.id }).delete();
      await trx('app_views').where({ id: v.id }).delete();
    });
    await this.audit(actor, 'app.view.deleted', { app: app.id, entity: entity.id, view: v.id }, v.label, { shared: v.shared, ...(v.owner_id !== p.userId ? { owner: v.owner_id } : {}) });
  }

  /** The caller's default view of an entity (null: none, the Records tab's own defaults). */
  async setDefault(actor: Actor & { principal: Principal }, appRef: string, entityRef: string, viewId: string | null) {
    const p = actor.principal;
    const { app, entity } = await this.apps.resolve(p, appRef, entityRef);
    const where = { tenant_id: p.tenantId, user_id: p.userId, entity_id: entity.id };
    if (viewId) {
      await this.visible(p, entity, viewId);
      await this.db.transaction(async (trx) => {
        await trx('app_view_defaults').where(where).delete();
        await trx('app_view_defaults').insert({ ...where, app_id: app.id, view_id: viewId, updated_at: Date.now() });
      });
    } else await this.db('app_view_defaults').where(where).delete();
    await this.audit(actor, 'app.view.default', { app: app.id, entity: entity.id, ...(viewId ? { view: viewId } : {}) }, entity.label, { cleared: !viewId });
    return { defaultView: viewId };
  }

  private audit(actor: Actor & { principal: Principal }, action: string, target: Record<string, unknown>, label: Label, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: actor.principal.tenantId, action, kind: 'admin', actor: actorFrom(actor.principal, actor.ip ?? null), target, label, ...(detail ? { detail } : {}), traceId: actor.traceId ?? null });
  }
}
