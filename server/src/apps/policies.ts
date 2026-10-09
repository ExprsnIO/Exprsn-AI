import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import type { Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { forbidden, HttpProblem, notFound } from '../http/problem.js';
import { normaliseGroup } from '../repos/users.js';
import type { Services } from '../services.js';
import { checkFilterSize, filterSchema, type Filter } from './query.js';
import { nameSchema, type EntityDefinition, type Values } from './schema.js';
import type { Actor, AppRow, AppService, EntityRow } from './service.js';

/*
 * Row and field policies (1.6.0, B-8101 to B-8103).
 *
 * A policy is a reusable rule set of one app, for one entity or for every entity of the app. It names its subjects
 * (everyone, a role, a directory or tenant group, a workspace's members, one user), the rows those subjects may reach
 * (a record filter in the query grammar whose values may name the user's facts: `$user.id`, `$user.username`,
 * `$user.clearance`, `$user.roles`, `$user.groups`, `$user.workspaces` and `$user.attributes.<name>`; or every row)
 * and per-field grants: read, read unmasked, create and update, with the masking format a reader without `unmasked`
 * sees (`last4`: `***-**-1234`; `hash`: a short SHA-256; `hidden`: no value).
 *
 * Enforcement is one function of the app service: `grantFor(principal, app, entity)`. An entity with no enabled
 * policy is open to every reader as before. Once an entity has one, a reader reaches the union of the rows the
 * policies that name them allow, and a reader no policy names reaches none; the field grants of the matching
 * policies are combined permissively (any policy that grants read grants it). The grant is applied in record queries
 * and counts, reads, exports, `/v1` and workflow record tools (they call the same service), form submissions by a
 * signed-in person (create grants), updates (update grants) and deletes (row reach). Designers of the app
 * (`apps:design`) are not subject to policies: they define them, and explain shows them what each reader gets.
 * Labels still apply first: a policy never shows a record above the reader's clearance.
 *
 * A policy's row conditions may only name indexed or unique fields (as every query may) of each entity it covers,
 * and a placeholder the user has no value for (an attribute not set) makes that policy grant nothing to that user.
 */

export const MASKS = ['last4', 'hash', 'hidden'] as const;
export type Mask = (typeof MASKS)[number];
export const SUBJECT_KINDS = ['everyone', 'role', 'group', 'workspace', 'user'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];
export const PLACEHOLDERS = ['$user.id', '$user.username', '$user.clearance', '$user.roles', '$user.groups', '$user.workspaces'] as const;
const LIST_PLACEHOLDERS = new Set(['$user.roles', '$user.groups', '$user.workspaces']);

export const fieldGrantSchema = z
  .object({
    read: z.boolean().default(true),
    unmasked: z.boolean().default(true),
    create: z.boolean().default(true),
    update: z.boolean().default(true),
    mask: z.enum(MASKS).default('hidden')
  })
  .strict();
export type FieldGrant = z.infer<typeof fieldGrantSchema>;
const otherFieldsSchema = fieldGrantSchema.omit({ mask: true });

export const subjectSchema = z
  .object({ kind: z.enum(SUBJECT_KINDS), value: z.string().trim().min(1).max(200).optional() })
  .strict()
  .refine((s) => s.kind === 'everyone' || !!s.value, 'A subject other than everyone needs a value');
export type Subject = z.infer<typeof subjectSchema>;

export const policyInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).nullable().optional(),
    enabled: z.boolean().default(true),
    /** The entity the policy covers; null for every entity of the app. */
    entity: nameSchema.nullable().default(null),
    subjects: z.array(subjectSchema).min(1).max(50),
    /** The rows the subjects reach; null for every row. */
    rows: filterSchema.nullable().default(null),
    fields: z.record(nameSchema, fieldGrantSchema).default({}),
    otherFields: otherFieldsSchema.default({ read: true, unmasked: true, create: true, update: true })
  })
  .strict();
export type PolicyInput = z.infer<typeof policyInputSchema>;

export interface PolicyRow {
  id: string;
  tenant_id: string;
  app_id: string;
  entity_id: string | null;
  name: string;
  description: string | null;
  enabled: boolean;
  subjects: Subject[];
  rows: Filter | null;
  fields: Record<string, FieldGrant>;
  other_fields: z.infer<typeof otherFieldsSchema>;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

const policyFrom = (r: Record<string, unknown>): PolicyRow => ({
  ...(r as unknown as PolicyRow),
  enabled: !!r.enabled,
  subjects: json<Subject[]>(r.subjects, []),
  rows: r.rows == null ? null : json<Filter | null>(r.rows, null),
  fields: json<Record<string, FieldGrant>>(r.fields, {}),
  other_fields: json(r.other_fields, { read: true, unmasked: true, create: true, update: true }),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

export const policyView = (p: PolicyRow, entityName: string | null) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  enabled: p.enabled,
  entity: entityName,
  subjects: p.subjects,
  rows: p.rows,
  fields: p.fields,
  otherFields: p.other_fields,
  createdBy: p.created_by,
  updatedBy: p.updated_by,
  createdAt: p.created_at,
  updatedAt: p.updated_at
});

/** What a policy compares a user by. */
export interface UserFacts {
  id: string;
  username: string;
  clearance: Label;
  roles: string[];
  /** Directory group names (normalised) and tenant group ids and names. */
  groups: string[];
  workspaces: string[];
  attributes: Record<string, string>;
}

/** The effective grant of one reader on one entity. */
export interface Grant {
  /** The entity has at least one enabled policy, so the grant applies. */
  policed: boolean;
  /** The policies that name the reader (enabled, covering the entity). */
  matched: PolicyRow[];
  /** The rows the reader reaches: null for every row; an impossible filter when nothing matched. */
  rows: Filter | null;
  /** True when the entity is policed and no policy names the reader: nothing is reachable. */
  none: boolean;
  field(name: string): { read: boolean; unmasked: boolean; create: boolean; update: boolean; mask: Mask; by: string | null };
}

const OPEN: Grant = { policed: false, matched: [], rows: null, none: false, field: () => ({ read: true, unmasked: true, create: true, update: true, mask: 'hidden', by: null }) };
export const openGrant = (): Grant => OPEN;

const SYSTEM_FIELDS = new Set(['id', 'state', 'createdAt', 'updatedAt', 'createdBy']);

/** Every leaf of a filter. */
function leaves(f: Filter): { field: string; op: string; value?: unknown }[] {
  if ('field' in f) return [f];
  if ('not' in f) return leaves(f.not);
  return ('and' in f ? f.and : f.or).flatMap(leaves);
}

const isPlaceholder = (v: unknown): v is string => typeof v === 'string' && v.startsWith('$user.');

/** A placeholder's value for a user: a string, a list, or undefined when the user has no such fact. */
function factOf(name: string, u: UserFacts): string | string[] | undefined {
  switch (name) {
    case '$user.id':
      return u.id;
    case '$user.username':
      return u.username;
    case '$user.clearance':
      return u.clearance;
    case '$user.roles':
      return u.roles;
    case '$user.groups':
      return u.groups;
    case '$user.workspaces':
      return u.workspaces;
    default: {
      if (!name.startsWith('$user.attributes.')) return undefined;
      const key = name.slice('$user.attributes.'.length);
      return Object.hasOwn(u.attributes, key) ? u.attributes[key] : undefined;
    }
  }
}

/** Checks a policy's placeholders: known names, lists only with `in`. */
function checkPlaceholders(f: Filter): void {
  for (const l of leaves(f)) {
    const vals = Array.isArray(l.value) ? l.value : [l.value];
    for (const v of vals) {
      if (!isPlaceholder(v)) continue;
      const known = (PLACEHOLDERS as readonly string[]).includes(v) || /^\$user\.attributes\.[a-z][a-z0-9_]{0,62}$/.test(v);
      if (!known) throw new HttpProblem(422, 'Unknown placeholder', `${v} is not a user fact a policy can compare. Use ${PLACEHOLDERS.join(', ')} or $user.attributes.<name>.`, { extensions: { field: l.field, placeholder: v } });
      if (LIST_PLACEHOLDERS.has(v) && l.op !== 'in') throw new HttpProblem(422, 'List placeholder', `${v} is a list; compare it with the in operator.`, { extensions: { field: l.field, placeholder: v } });
      if (LIST_PLACEHOLDERS.has(v) && Array.isArray(l.value) && l.value.length > 1) throw new HttpProblem(422, 'List placeholder', `${v} stands alone as the value of in.`, { extensions: { field: l.field } });
    }
  }
}

/** The policy's rows with the user's facts in place of placeholders; null when a fact the filter needs is missing. */
export function resolveRows(f: Filter, u: UserFacts): Filter | null {
  if ('and' in f) {
    const kids = f.and.map((k) => resolveRows(k, u));
    return kids.some((k) => !k) ? null : { and: kids as Filter[] };
  }
  if ('or' in f) {
    const kids = f.or.map((k) => resolveRows(k, u));
    return kids.some((k) => !k) ? null : { or: kids as Filter[] };
  }
  if ('not' in f) {
    const k = resolveRows(f.not, u);
    return k ? { not: k } : null;
  }
  if (Array.isArray(f.value)) {
    const out: unknown[] = [];
    for (const v of f.value) {
      if (!isPlaceholder(v)) {
        out.push(v);
        continue;
      }
      const fact = factOf(v, u);
      if (fact === undefined) return null;
      if (Array.isArray(fact)) out.push(...fact);
      else out.push(fact);
    }
    if (!out.length) return null;
    return { field: f.field, op: f.op, value: out.slice(0, 100) };
  }
  if (isPlaceholder(f.value)) {
    const fact = factOf(f.value, u);
    if (fact === undefined) return null;
    if (Array.isArray(fact)) return fact.length ? { field: f.field, op: 'in', value: fact.slice(0, 100) } : null;
    return { field: f.field, op: f.op, value: fact };
  }
  return f;
}

/** A filter no record matches (the reader has no policy): `id in` an id that cannot exist. */
export const NOTHING: Filter = { field: 'id', op: 'eq', value: '00000000000000000000000000' };

export function subjectMatches(s: Subject, u: UserFacts): boolean {
  switch (s.kind) {
    case 'everyone':
      return true;
    case 'role':
      return u.roles.includes(s.value!);
    case 'group':
      return u.groups.includes(normaliseGroup(s.value!)) || u.groups.includes(s.value!);
    case 'workspace':
      return u.workspaces.includes(s.value!);
    case 'user':
      return u.id === s.value || u.username === s.value!.toLowerCase();
  }
}

/** A field's value as a reader without `unmasked` sees it. */
export function maskValue(v: unknown, mask: Mask): unknown {
  if (v == null) return v;
  if (mask === 'hidden') return null;
  const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (mask === 'hash') return createHash('sha256').update(s).digest('hex').slice(0, 12);
  // last4: every letter and digit but the last four becomes *, separators stay (123-45-6789 -> ***-**-6789).
  let keep = 4;
  let out = '';
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s[i]!;
    if (/[\p{L}\p{N}]/u.test(c)) {
      out = (keep > 0 ? c : '*') + out;
      keep--;
    } else out = c + out;
  }
  return out;
}

const matchedGrant = (policed: boolean, matched: PolicyRow[], rows: Filter | null): Grant => ({
  policed,
  matched,
  rows,
  none: policed && !matched.length,
  field(name) {
    if (!policed) return { read: true, unmasked: true, create: true, update: true, mask: 'hidden', by: null };
    let read = false;
    let unmasked = false;
    let create = false;
    let update = false;
    let mask: Mask = 'hidden';
    let by: string | null = null;
    let maskSet = false;
    for (const p of matched) {
      const g = Object.hasOwn(p.fields, name) ? p.fields[name]! : { ...p.other_fields, mask: 'hidden' as Mask };
      if (g.read && !read) by = p.name;
      read ||= g.read;
      unmasked ||= g.read && g.unmasked;
      create ||= g.create;
      update ||= g.update;
      if (g.read && !g.unmasked && !maskSet) {
        mask = g.mask;
        maskSet = true;
      }
    }
    return { read, unmasked, create, update, mask, by };
  }
});

export class AppPolicies {
  constructor(
    private readonly s: () => Services,
    private readonly apps: AppService
  ) {}

  private get db() {
    return this.s().db;
  }

  // ---------- facts ----------

  /** What policies compare a user by, from the directory, roles, groups, workspaces and admin-set attributes. */
  async facts(tenantId: string, userId: string, principal?: Principal): Promise<UserFacts | null> {
    const s = this.s();
    const u = await s.users.get(tenantId, userId);
    if (!u) return null;
    const roles = principal?.userId === userId ? principal.roles : await s.users.roleIds(userId);
    const links = (await this.db('user_identities').where({ user_id: userId }).select('groups')) as { groups: string }[];
    const directory = links.flatMap((l) => json<string[]>(l.groups, [])).map(normaliseGroup);
    const social = (await this.db('group_members as m').join('social_groups as g', 'g.id', 'm.group_id').where({ 'm.user_id': userId, 'm.tenant_id': tenantId }).select('g.id', 'g.name')) as { id: string; name: string }[];
    const workspaces = (await s.tenants.workspacesForUser(tenantId, userId)).map((w) => w.id);
    const attributes = json<Record<string, unknown>>((u as unknown as { attributes?: string | null }).attributes ?? null, {});
    return {
      id: u.id,
      username: u.username,
      clearance: principal?.userId === userId ? principal.clearance : u.clearance,
      roles,
      groups: [...new Set([...directory, ...social.map((g) => g.id), ...social.map((g) => normaliseGroup(g.name))])],
      workspaces,
      attributes: Object.fromEntries(Object.entries(attributes).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, String(v)]))
    };
  }

  // ---------- grants ----------

  private async enabledFor(tenantId: string, appId: string, entityId: string): Promise<PolicyRow[]> {
    const rows = (await this.db('app_policies').where({ tenant_id: tenantId, app_id: appId, enabled: true }).andWhere((w) => w.where('entity_id', entityId).orWhereNull('entity_id')).orderBy('created_at')) as Record<string, unknown>[];
    return rows.map(policyFrom);
  }

  /** The reader's grant on an entity. Designers (`apps:design`) are open; so is an entity without policies. */
  async grantFor(p: Principal, app: Pick<AppRow, 'tenant_id' | 'id'>, entity: EntityRow): Promise<Grant> {
    if (effectivePermissions(p).has('apps:design')) return OPEN;
    const policies = await this.enabledFor(app.tenant_id, app.id, entity.id);
    if (!policies.length) return OPEN;
    const facts = await this.facts(app.tenant_id, p.userId, p);
    if (!facts) return matchedGrant(true, [], NOTHING);
    return this.grantOf(policies, facts);
  }

  private grantOf(policies: PolicyRow[], facts: UserFacts): Grant {
    const matched: PolicyRow[] = [];
    const filters: Filter[] = [];
    let all = false;
    for (const pol of policies) {
      if (!pol.subjects.some((s) => subjectMatches(s, facts))) continue;
      if (pol.rows == null) {
        all = true;
        matched.push(pol);
        continue;
      }
      const resolved = resolveRows(pol.rows, facts);
      if (!resolved) continue; // a fact the policy needs is missing: it grants nothing to this user
      matched.push(pol);
      filters.push(resolved);
    }
    if (!matched.length) return matchedGrant(true, [], NOTHING);
    return matchedGrant(true, matched, all ? null : filters.length === 1 ? filters[0]! : { or: filters });
  }

  /** The caller's filter, narrowed to the rows the grant reaches. */
  static narrow(grant: Grant, filter: Filter | undefined): Filter | undefined {
    if (grant.none) return NOTHING;
    if (!grant.rows) return filter;
    return filter ? { and: [filter, grant.rows] } : grant.rows;
  }

  /** Refuses a filter or sort naming a field the grant does not let the reader read (no sorting by a hidden value). */
  static checkReadable(grant: Grant, filter: Filter | undefined, sort: { field: string }[] | undefined): void {
    if (!grant.policed) return;
    const names = new Set<string>([...(filter ? leaves(filter).map((l) => l.field) : []), ...(sort ?? []).map((x) => x.field)]);
    for (const n of names) {
      if (SYSTEM_FIELDS.has(n)) continue;
      if (!grant.field(n).read) throw forbidden(`A policy does not let you read ${n}, so records cannot be filtered or sorted by it.`, { step: 'policy', field: n });
    }
  }

  /** Values as the grant shows them: fields without read left out, masked ones replaced. */
  static apply(grant: Grant, def: EntityDefinition, values: Values): { values: Values; masked: Record<string, Mask>; hidden: string[] } {
    if (!grant.policed) return { values, masked: {}, hidden: [] };
    const out: Values = {};
    const masked: Record<string, Mask> = {};
    const hidden: string[] = [];
    for (const f of def.fields) {
      const g = grant.field(f.name);
      if (!g.read) {
        hidden.push(f.name);
        continue;
      }
      if (!g.unmasked) {
        masked[f.name] = g.mask;
        out[f.name] = maskValue(values[f.name], g.mask);
      } else if (Object.hasOwn(values, f.name)) out[f.name] = values[f.name];
    }
    return { values: out, masked, hidden };
  }

  /** Refuses a write naming fields the grant does not let the writer create or update. */
  static checkWrite(grant: Grant, values: Values, kind: 'create' | 'update'): void {
    if (!grant.policed) return;
    if (grant.none) throw forbidden(`No policy lets you ${kind} records of this entity.`, { step: 'policy' });
    const denied = Object.keys(values).filter((k) => !grant.field(k)[kind]);
    if (denied.length) throw forbidden(`A policy does not let you ${kind} ${denied.join(', ')}.`, { step: 'policy', fields: denied });
  }

  // ---------- administration (apps:design) ----------

  private async entityRows(app: AppRow): Promise<EntityRow[]> {
    return this.apps.entities(app);
  }

  private async check(app: AppRow, input: PolicyInput): Promise<{ entityId: string | null }> {
    const entities = await this.entityRows(app);
    const entity = input.entity ? entities.find((e) => e.name === input.entity) : null;
    if (input.entity && !entity) throw notFound('Entity');
    const covered = entity ? [entity] : entities;
    for (const name of Object.keys(input.fields)) {
      if (!covered.some((e) => e.definition.fields.some((f) => f.name === name))) throw new HttpProblem(422, 'Unknown field', `${name} is not a field of ${entity ? entity.name : 'any entity of the app'}.`, { extensions: { field: name } });
    }
    if (input.rows) {
      checkFilterSize(input.rows);
      checkPlaceholders(input.rows);
      for (const l of leaves(input.rows)) {
        if (SYSTEM_FIELDS.has(l.field)) continue;
        for (const e of covered) {
          const f = e.definition.fields.find((x) => x.name === l.field);
          if (!f) throw new HttpProblem(422, 'Unknown field', `${l.field} is not a field of ${e.name}${entity ? '' : ' (an app-wide policy may only use fields every entity has)'}.`, { extensions: { field: l.field, entity: e.name } });
          if (!f.indexed && !f.unique) throw new HttpProblem(422, 'Field not indexed', `${l.field} of ${e.name} is not indexed, so rows cannot be chosen by it. Mark it indexed first.`, { extensions: { field: l.field, entity: e.name } });
        }
      }
    }
    for (const s of input.subjects) {
      if (s.kind === 'workspace' && !(await this.s().tenants.workspace(app.tenant_id, s.value!))) throw new HttpProblem(422, 'Unknown workspace', `${s.value} is not a workspace of this tenant.`, { extensions: { subject: s } });
      if (s.kind === 'user' && !(await this.s().users.get(app.tenant_id, s.value!)) && !(await this.s().users.byUsername(app.tenant_id, s.value!))) throw new HttpProblem(422, 'Unknown user', `${s.value} is not a user of this tenant.`, { extensions: { subject: s } });
    }
    return { entityId: entity?.id ?? null };
  }

  private audit(actor: Actor & { principal: Principal }, app: AppRow, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: app.tenant_id, action, kind: 'admin', actor: actorFrom(actor.principal, actor.ip ?? null), target: { app: app.id, ...target }, label: app.label, ...(detail ? { detail } : {}), traceId: actor.traceId ?? null });
  }

  async list(app: AppRow): Promise<{ policy: PolicyRow; entityName: string | null }[]> {
    const entities = new Map((await this.entityRows(app)).map((e) => [e.id, e.name]));
    const rows = (await this.db('app_policies').where({ tenant_id: app.tenant_id, app_id: app.id }).orderBy('created_at')) as Record<string, unknown>[];
    return rows.map(policyFrom).map((policy) => ({ policy, entityName: policy.entity_id ? (entities.get(policy.entity_id) ?? null) : null }));
  }

  async get(app: AppRow, id: string): Promise<PolicyRow> {
    const r = await this.db('app_policies').where({ tenant_id: app.tenant_id, app_id: app.id, id }).first();
    if (!r) throw notFound('Policy');
    return policyFrom(r);
  }

  async create(actor: Actor & { principal: Principal }, app: AppRow, input: PolicyInput): Promise<PolicyRow> {
    const { entityId } = await this.check(app, input);
    const t = Date.now();
    const id = ulid();
    await this.db('app_policies').insert({
      id,
      tenant_id: app.tenant_id,
      app_id: app.id,
      entity_id: entityId,
      name: input.name,
      description: input.description ?? null,
      enabled: input.enabled,
      subjects: JSON.stringify(input.subjects),
      rows: input.rows ? JSON.stringify(input.rows) : null,
      fields: JSON.stringify(input.fields),
      other_fields: JSON.stringify(input.otherFields),
      created_by: actor.principal.userId,
      updated_by: actor.principal.userId,
      created_at: t,
      updated_at: t
    });
    await this.audit(actor, app, 'app.policy.created', { policy: id, entity: entityId }, { name: input.name, subjects: input.subjects.length, rows: !!input.rows, fields: Object.keys(input.fields).length });
    return this.get(app, id);
  }

  async update(actor: Actor & { principal: Principal }, app: AppRow, id: string, input: PolicyInput): Promise<PolicyRow> {
    const before = await this.get(app, id);
    const { entityId } = await this.check(app, input);
    await this.db('app_policies').where({ id }).update({
      entity_id: entityId,
      name: input.name,
      description: input.description ?? null,
      enabled: input.enabled,
      subjects: JSON.stringify(input.subjects),
      rows: input.rows ? JSON.stringify(input.rows) : null,
      fields: JSON.stringify(input.fields),
      other_fields: JSON.stringify(input.otherFields),
      updated_by: actor.principal.userId,
      updated_at: Date.now()
    });
    await this.audit(actor, app, 'app.policy.updated', { policy: id, entity: entityId }, { name: input.name, enabled: input.enabled, wasEnabled: before.enabled });
    return this.get(app, id);
  }

  async remove(actor: Actor & { principal: Principal }, app: AppRow, id: string): Promise<PolicyRow> {
    const p = await this.get(app, id);
    await this.db('app_policies').where({ id }).delete();
    await this.audit(actor, app, 'app.policy.deleted', { policy: id, entity: p.entity_id }, { name: p.name });
    return p;
  }

  /**
   * B-8103 explain: what a user gets on an entity, and why: each policy of the entity with whether it names the
   * user, the rows they reach (and whether one record is among them), and the grant on one field.
   */
  async explain(app: AppRow, entity: EntityRow, input: { userId: string; recordId?: string | null; field?: string | null }) {
    const facts = await this.facts(app.tenant_id, input.userId);
    if (!facts) throw notFound('User');
    const policies = await this.enabledFor(app.tenant_id, app.id, entity.id);
    const designer = (await this.s().users.roleIds(input.userId)).length ? effectivePermissions({ roles: facts.roles, scopes: null, tenantId: app.tenant_id }).has('apps:design') : false;
    const grant = designer ? OPEN : policies.length ? this.grantOf(policies, facts) : OPEN;
    const byPolicy = policies.map((pol) => {
      const subject = pol.subjects.find((s) => subjectMatches(s, facts)) ?? null;
      const resolved = pol.rows ? resolveRows(pol.rows, facts) : null;
      const unresolved = !!pol.rows && !resolved;
      return {
        id: pol.id,
        name: pol.name,
        entity: pol.entity_id ? entity.name : null,
        matches: !!subject && !unresolved,
        subject,
        reason: !subject ? 'none of its subjects name this user' : unresolved ? 'a user fact it compares is not set for this user' : pol.rows ? 'names the user; rows by condition' : 'names the user; every row',
        rows: resolved
      };
    });
    let record: { reachable: boolean; by: string | null } | null = null;
    if (input.recordId) {
      const reach = grant.none ? false : await this.apps.reaches(app, entity, grant, input.recordId, facts.clearance);
      const by = reach && grant.policed ? (grant.matched.find((pol) => !pol.rows)?.name ?? (await this.firstPolicyReaching(app, entity, grant, facts, input.recordId))) : null;
      record = { reachable: reach, by: designer ? 'designer (apps:design)' : grant.policed ? by : 'no policies on this entity' };
    }
    const field = input.field ? { name: input.field, ...grant.field(input.field) } : null;
    return {
      user: { id: facts.id, username: facts.username, clearance: facts.clearance, roles: facts.roles, groups: facts.groups, workspaces: facts.workspaces, attributes: facts.attributes, designer },
      policed: grant.policed && !designer,
      none: grant.none,
      rows: grant.policed ? grant.rows : null,
      policies: byPolicy,
      record,
      field
    };
  }

  private async firstPolicyReaching(app: AppRow, entity: EntityRow, grant: Grant, facts: UserFacts, recordId: string): Promise<string | null> {
    for (const pol of grant.matched) {
      const rows = pol.rows ? resolveRows(pol.rows, facts) : null;
      const one = matchedGrant(true, [pol], rows);
      if (await this.apps.reaches(app, entity, one, recordId, facts.clearance)) return pol.name;
    }
    return null;
  }

  static placeholders(): readonly string[] {
    return [...PLACEHOLDERS, '$user.attributes.<name>'];
  }

  /** `$user.attributes` an admin sets on a user (B-8101): string values only, at most 50. */
  static attributesSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'lower-case letters, digits and _'), z.string().max(200)).refine((o) => Object.keys(o).length <= 50, 'at most 50 attributes');
}

