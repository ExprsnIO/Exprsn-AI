import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import type { Principal } from '../authz/policy.js';
import { canonicalJson, sha256 } from '../crypto/index.js';
import { json } from '../db/knex.js';
import { conflict, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import type { FormDefinition, FormRow } from './forms.js';
import { entityDefinitionSchema, fieldSchema, nameSchema, statesSchema, type EntityDefinition, type Field, type StateMachine } from './schema.js';
import type { Actor, AppRow, AppService, EntityRow } from './service.js';

/*
 * 1.6.0, Sprint 39d (B-8602, B-8603): the schema API and what it leaves behind.
 *
 * Every change to an app's design (whichever route makes it: the Apps screen, the schema API, a package import) is one
 * row of `app_schema_versions`: the version number, what changed and a hash of the whole design afterwards (entities
 * with their fields and state machines, forms). The package format reads `current()` to stamp a version and hash. The
 * OpenAPI document and the client of an app are computed from the design on each read and carry that version, so
 * they are current the moment the schema changes (the ETag is the hash).
 */

export type SchemaChangeKind = 'entity.created' | 'entity.updated' | 'entity.deleted' | 'field.added' | 'field.updated' | 'field.removed' | 'states.set' | 'form.created' | 'form.updated' | 'form.deleted';

export interface SchemaVersionRow {
  id: string;
  tenant_id: string;
  app_id: string;
  version: number;
  kind: SchemaChangeKind;
  target: string;
  summary: string;
  change: unknown;
  hash: string;
  created_by: string | null;
  source: string;
  created_at: number;
}

const versionFrom = (r: Record<string, unknown>): SchemaVersionRow => ({ ...(r as unknown as SchemaVersionRow), version: Number(r.version), change: json<unknown>(r.change, null), created_at: Number(r.created_at) });

export const schemaVersionView = (v: SchemaVersionRow) => ({ version: v.version, kind: v.kind, target: v.target, summary: v.summary, change: v.change, hash: v.hash, source: v.source, createdBy: v.created_by, createdAt: v.created_at });

export interface AppDesign {
  entities: { name: string; title: string; label: string; definition: EntityDefinition }[];
  forms: { name: string; title: string; entity: string; definition: FormDefinition; ratePerMinute: number }[];
}

export class AppSchema {
  constructor(
    private readonly s: () => Services,
    private readonly apps: AppService
  ) {}

  private get db() {
    return this.s().db;
  }

  /** The design as the package and the hash see it: entities and forms by name, nothing instance-specific. */
  async design(app: AppRow): Promise<AppDesign> {
    const entities = await this.apps.entities(app);
    const byId = new Map(entities.map((e) => [e.id, e.name]));
    const forms = await this.apps.forms.list(app);
    return {
      entities: entities.map((e) => ({ name: e.name, title: e.title, label: e.label, definition: e.definition })),
      forms: forms.map(({ form }) => ({ name: form.name, title: form.title, entity: byId.get(form.entity_id)!, definition: form.definition, ratePerMinute: form.rate_per_minute }))
    };
  }

  static hashOf(design: AppDesign): string {
    return sha256(canonicalJson(design));
  }

  /** The app's current schema version (0 before any recorded change) and the hash of its design. */
  async current(app: AppRow): Promise<{ version: number; hash: string; changedAt: number | null }> {
    const last = (await this.db('app_schema_versions').where({ app_id: app.id }).orderBy('version', 'desc').first()) as Record<string, unknown> | undefined;
    const row = last ? versionFrom(last) : null;
    return { version: row?.version ?? 0, hash: AppSchema.hashOf(await this.design(app)), changedAt: row?.created_at ?? null };
  }

  async versions(app: AppRow, limit = 100): Promise<SchemaVersionRow[]> {
    return ((await this.db('app_schema_versions').where({ app_id: app.id }).orderBy('version', 'desc').limit(limit)) as Record<string, unknown>[]).map(versionFrom);
  }

  async version(app: AppRow, n: number): Promise<SchemaVersionRow> {
    const r = (await this.db('app_schema_versions').where({ app_id: app.id, version: n }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Schema version');
    return versionFrom(r);
  }

  /**
   * Records a change after it was applied: the next version number and the hash of the design now. Called by the app
   * service for every design change, so the Apps screen, the schema API and package imports all leave a version.
   */
  async record(actor: Actor, app: AppRow, kind: SchemaChangeKind, target: string, summary: string, change: unknown): Promise<SchemaVersionRow> {
    const design = await this.design(app);
    const hash = AppSchema.hashOf(design);
    const last = (await this.db('app_schema_versions').where({ app_id: app.id }).max({ v: 'version' }).first()) as { v: number | string | null } | undefined;
    const version = Number(last?.v ?? 0) + 1;
    const row = {
      id: ulid(),
      tenant_id: app.tenant_id,
      app_id: app.id,
      version,
      kind,
      target,
      summary: summary.slice(0, 300),
      change: change == null ? null : JSON.stringify(change),
      hash,
      created_by: actor.principal?.userId ?? null,
      source: actor.via ?? (actor.source === 'api' ? 'api' : actor.source),
      created_at: Date.now()
    };
    await this.db('app_schema_versions').insert(row);
    const s = this.s();
    await s.audit.append({ tenantId: app.tenant_id, action: 'app.schema.versioned', kind: 'admin', actor: actor.principal ? actorFrom(actor.principal, actor.ip ?? null) : { service: 'apps' }, target: { app: app.id, name: app.name, version }, label: app.label, detail: { kind, target, summary: row.summary, hash, source: row.source }, traceId: actor.traceId ?? null });
    return versionFrom(row);
  }

  // ---------- the schema API's own changes (B-8602) ----------

  private via(actor: Actor & { principal: Principal }): Actor & { principal: Principal } {
    return { ...actor, via: 'schema-api' };
  }

  /** Creates the entity, or replaces its definition (title and label too when given). */
  async setEntity(actor: Actor & { principal: Principal }, app: AppRow, input: { name: string; title?: string; label?: EntityRow['label']; definition: EntityDefinition }): Promise<{ entity: EntityRow; created: boolean }> {
    const existing = await this.db('app_entities').where({ app_id: app.id, name: input.name }).first('id');
    if (!existing) {
      const out = await this.apps.createEntity(this.via(actor), app.id, { name: input.name, ...(input.title ? { title: input.title } : {}), ...(input.label ? { label: input.label } : {}), definition: input.definition });
      return { entity: out.entity, created: true };
    }
    const out = await this.apps.updateEntity(this.via(actor), app.id, input.name, { ...(input.title ? { title: input.title } : {}), ...(input.label ? { label: input.label } : {}), definition: input.definition });
    return { entity: out.entity, created: false };
  }

  async removeEntity(actor: Actor & { principal: Principal }, app: AppRow, name: string): Promise<void> {
    await this.apps.removeEntity(this.via(actor), app.id, name);
  }

  private async withFields(actor: Actor & { principal: Principal }, app: AppRow, entityRef: string, change: (fields: Field[]) => Field[], rev?: number): Promise<EntityRow> {
    const entity = await this.apps.entityOf(app, entityRef);
    const definition = entityDefinitionSchema.parse({ ...entity.definition, fields: change(entity.definition.fields) });
    const out = await this.apps.updateEntity(this.via(actor), app.id, entity.name, { definition, ...(rev ? { rev } : {}) });
    return out.entity;
  }

  async addField(actor: Actor & { principal: Principal }, app: AppRow, entityRef: string, field: Field, rev?: number): Promise<EntityRow> {
    return this.withFields(
      actor,
      app,
      entityRef,
      (fields) => {
        if (fields.some((f) => f.name === field.name)) throw conflict(`There is already a field ${field.name}.`);
        return [...fields, field];
      },
      rev
    );
  }

  async updateField(actor: Actor & { principal: Principal }, app: AppRow, entityRef: string, name: string, patch: Record<string, unknown>, rev?: number): Promise<EntityRow> {
    return this.withFields(
      actor,
      app,
      entityRef,
      (fields) => {
        const i = fields.findIndex((f) => f.name === name);
        if (i < 0) throw notFound('Field');
        // The type and name stay; the rest is replaced by the patch and checked as a whole field.
        const merged = fieldSchema.parse({ ...fields[i], ...patch, name, type: fields[i]!.type });
        return fields.map((f, j) => (j === i ? merged : f));
      },
      rev
    );
  }

  async removeField(actor: Actor & { principal: Principal }, app: AppRow, entityRef: string, name: string, rev?: number): Promise<EntityRow> {
    return this.withFields(
      actor,
      app,
      entityRef,
      (fields) => {
        if (!fields.some((f) => f.name === name)) throw notFound('Field');
        return fields.filter((f) => f.name !== name);
      },
      rev
    );
  }

  async setStates(actor: Actor & { principal: Principal }, app: AppRow, entityRef: string, states: StateMachine | null, rev?: number): Promise<EntityRow> {
    const entity = await this.apps.entityOf(app, entityRef);
    const { states: _old, ...rest } = entity.definition;
    const definition = entityDefinitionSchema.parse(states ? { ...rest, states: statesSchema.parse(states) } : rest);
    return (await this.apps.updateEntity(this.via(actor), app.id, entity.name, { definition, ...(rev ? { rev } : {}) })).entity;
  }

  /** Creates the form, or replaces its definition. */
  async setForm(actor: Actor & { principal: Principal }, app: AppRow, input: { name: string; title?: string; entity: string; definition: FormDefinition; ratePerMinute?: number }): Promise<{ form: FormRow; entity: EntityRow; created: boolean }> {
    const existing = await this.db('app_forms').where({ app_id: app.id, name: input.name }).first('id');
    if (!existing) return { ...(await this.apps.forms.create(this.via(actor), app.id, input)), created: true };
    return { ...(await this.apps.forms.update(this.via(actor), app.id, input.name, { ...(input.title ? { title: input.title } : {}), definition: input.definition, ...(input.ratePerMinute ? { ratePerMinute: input.ratePerMinute } : {}) })), created: false };
  }

  async removeForm(actor: Actor & { principal: Principal }, app: AppRow, name: string): Promise<void> {
    await this.apps.forms.remove(this.via(actor), app.id, name);
  }

  // ---------- OpenAPI and the client (B-8603) ----------

  /** The OpenAPI 3.1 document of one app: its entity API, typed from the entity definitions. */
  openapi(app: AppRow, entities: EntityRow[], current: { version: number; hash: string }, baseUrl: string): Record<string, unknown> {
    const schemas: Record<string, unknown> = {
      Problem: { type: 'object', properties: { type: { type: 'string' }, title: { type: 'string' }, status: { type: 'integer' }, detail: { type: 'string' }, step: { type: 'string' }, trace_id: { type: 'string' } } },
      RecordMeta: { type: 'object', properties: { id: { type: 'string' }, app: { type: 'string' }, entity: { type: 'string' }, label: { type: 'string', enum: ['public', 'internal', 'confidential', 'restricted'] }, state: { type: ['string', 'null'] }, version: { type: 'integer' }, source: { type: 'string' }, createdBy: { type: ['string', 'null'] }, updatedBy: { type: ['string', 'null'] }, createdAt: { type: 'integer' }, updatedAt: { type: 'integer' }, masked: { type: 'object', additionalProperties: { type: 'string' } }, hidden: { type: 'array', items: { type: 'string' } } }, required: ['id', 'app', 'entity', 'label', 'version', 'createdAt', 'updatedAt'] }
    };
    const paths: Record<string, unknown> = {};
    const problem = { description: 'A problem (RFC 9457).', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } };
    const listParams = [
      { name: 'filter', in: 'query', schema: { type: 'string' }, description: 'A record filter as JSON: {field, op, value} or {and|or: [...]} or {not: ...}; ops eq, ne, gt, gte, lt, lte, in, contains, startsWith, exists.' },
      { name: 'where', in: 'query', schema: { type: 'array', items: { type: 'string' } }, style: 'form', explode: true, description: 'Short conditions `field:op:value` (repeatable, combined with and); `field:in:a,b`.' },
      { name: 'sort', in: 'query', schema: { type: 'string' }, description: '`field:asc,field:desc`, at most three.' },
      { name: 'q', in: 'query', schema: { type: 'string' } },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
      { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'The previous page\'s nextCursor (keyset paging).' },
      { name: 'include', in: 'query', schema: { type: 'string', enum: ['related'] }, description: 'With related, each record carries the records its reference and entity-lookup fields point at.' }
    ];
    for (const e of entities) {
      const T = pascal(e.name);
      const props: Record<string, unknown> = {};
      const inputProps: Record<string, unknown> = {};
      const required: string[] = [];
      for (const f of e.definition.fields) {
        const js = jsonSchemaOf(f, entities);
        props[f.name] = js;
        if (f.type !== 'formula' && f.type !== 'ai') {
          inputProps[f.name] = js;
          if (f.required) required.push(f.name);
        }
      }
      schemas[`${T}Values`] = { type: 'object', properties: props, additionalProperties: false };
      schemas[`${T}Input`] = { type: 'object', properties: inputProps, ...(required.length ? { required } : {}), additionalProperties: false };
      schemas[T] = { allOf: [{ $ref: '#/components/schemas/RecordMeta' }, { type: 'object', properties: { values: { $ref: `#/components/schemas/${T}Values` }, related: { type: 'object', additionalProperties: { oneOf: [{ $ref: '#/components/schemas/RecordMeta' }, { type: 'null' }] } } }, required: ['values'] }] };
      schemas[`${T}Page`] = { type: 'object', properties: { total: { type: ['integer', 'null'] }, limit: { type: 'integer' }, offset: { type: 'integer' }, nextCursor: { type: ['string', 'null'] }, records: { type: 'array', items: { $ref: `#/components/schemas/${T}` } } }, required: ['records'] };
      const base = `/api/apps/${app.name}/${e.name}`;
      const ok = (ref: string, description: string) => ({ description, content: { 'application/json': { schema: { $ref: ref } } } });
      paths[base] = {
        get: { tags: [e.name], summary: `List ${e.title} records (records:read; the reader's policies and clearance apply).`, operationId: `list_${e.name}`, parameters: listParams, responses: { '200': ok(`#/components/schemas/${T}Page`, 'A page.'), '403': problem } },
        post: { tags: [e.name], summary: `Create a ${e.title} record (records:write).`, operationId: `create_${e.name}`, requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { values: { $ref: `#/components/schemas/${T}Input` }, label: { type: 'string', enum: ['public', 'internal', 'confidential', 'restricted'] } }, required: ['values'] } } } }, responses: { '201': ok(`#/components/schemas/${T}`, 'The record.'), '422': problem, '403': problem } }
      };
      paths[`${base}/{id}`] = {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', minLength: 26, maxLength: 26 } }],
        get: { tags: [e.name], summary: `Read a ${e.title} record (records:read).`, operationId: `get_${e.name}`, parameters: [{ name: 'include', in: 'query', schema: { type: 'string', enum: ['related'] } }], responses: { '200': ok(`#/components/schemas/${T}`, 'The record.'), '404': problem } },
        patch: { tags: [e.name], summary: `Update a ${e.title} record (records:write); version for optimistic locking.`, operationId: `update_${e.name}`, requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { values: { $ref: `#/components/schemas/${T}Input` }, version: { type: 'integer' } }, required: ['values'] } } } }, responses: { '200': ok(`#/components/schemas/${T}`, 'The record.'), '409': problem, '422': problem } },
        delete: { tags: [e.name], summary: `Delete a ${e.title} record (records:write).`, operationId: `delete_${e.name}`, responses: { '204': { description: 'Deleted.' }, '404': problem } }
      };
      if (e.definition.states) {
        paths[`${base}/{id}/transition`] = {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          post: { tags: [e.name], summary: `Move a ${e.title} record to another state (records:write). States: ${e.definition.states.states.map((s) => s.name).join(', ')}.`, operationId: `transition_${e.name}`, requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { to: { type: 'string', enum: e.definition.states.states.map((s) => s.name) }, version: { type: 'integer' }, note: { type: 'string' } }, required: ['to'] } } } }, responses: { '200': ok(`#/components/schemas/${T}`, 'The record.'), '409': problem } }
        };
      }
    }
    return {
      openapi: '3.1.0',
      info: { title: `${app.title} API`, version: String(current.version), description: `${app.description ?? ''}\n\nThe entity API of the Exprsn-AI app ${app.name}: every call needs a bearer credential (an API key, one limited to this app included, or an embedded session) that holds records:read or records:write, and acts within the caller's policies, clearance and workspaces. Schema version ${current.version}, hash ${current.hash}.`.trim(), 'x-exprsn-app': app.name, 'x-exprsn-schema-hash': current.hash },
      servers: [{ url: baseUrl }],
      security: [{ bearer: [] }],
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, schemas },
      tags: entities.map((e) => ({ name: e.name, description: e.title })),
      paths
    };
  }

  /** A client for the app's entity API, as TypeScript (typed) or plain JavaScript (the same code without types). */
  client(app: AppRow, entities: EntityRow[], current: { version: number; hash: string }, format: 'ts' | 'js'): string {
    const ts = format === 'ts';
    const t = (s: string) => (ts ? s : '');
    const out: string[] = [];
    out.push(`// Generated by Exprsn-AI for the app ${app.name} (${app.title}), schema version ${current.version}, hash ${current.hash}.`);
    out.push('// Regenerate it from GET /api/apps/' + app.name + (ts ? '/client.ts' : '/client.js') + ' when the schema changes. Do not edit.');
    out.push('');
    if (ts) {
      out.push(`export type Label = 'public' | 'internal' | 'confidential' | 'restricted';`);
      out.push(`export interface RecordMeta { id: string; app: string; entity: string; label: Label; state: string | null; version: number; source: string; createdBy: string | null; updatedBy: string | null; createdAt: number; updatedAt: number; masked?: Record<string, string>; hidden?: string[]; related?: Record<string, RecordMeta | null>; }`);
      out.push(`export interface Page<R> { total: number | null; limit: number; offset: number; nextCursor: string | null; records: R[]; }`);
      out.push(`export interface ListOptions { filter?: unknown; where?: string[]; sort?: string; q?: string; limit?: number; offset?: number; cursor?: string; include?: 'related'; }`);
      out.push(`export interface ClientOptions { baseUrl: string; token: string; workspace?: string; fetch?: typeof fetch; }`);
      out.push(`export class ApiError extends Error { constructor(readonly status: number, readonly problem: { title?: string; detail?: string; step?: string; trace_id?: string } | null, message: string) { super(message); } }`);
      for (const e of entities) {
        const T = pascal(e.name);
        out.push(`export interface ${T}Values { ${e.definition.fields.map((f) => `${f.name}${f.required && f.type !== 'formula' && f.type !== 'ai' ? '' : '?'}: ${tsTypeOf(f)} | null;`).join(' ')} }`);
        out.push(`export type ${T}Input = Omit<${T}Values, ${e.definition.fields.filter((f) => f.type === 'formula' || f.type === 'ai').map((f) => `'${f.name}'`).join(' | ') || 'never'}>;`);
        out.push(`export interface ${T}Record extends RecordMeta { entity: '${e.name}'; values: ${T}Values; }`);
      }
    } else {
      out.push(`export class ApiError extends Error { constructor(status, problem, message) { super(message); this.status = status; this.problem = problem; } }`);
    }
    out.push('');
    out.push(`export function createClient(o${t(': ClientOptions')}) {`);
    out.push(`  const f = o.fetch ?? fetch;`);
    out.push(`  const base = o.baseUrl.replace(/\\/+$/, '');`);
    out.push(`  const qs = (q${t(': ListOptions | undefined')}) => { if (!q) return ''; const p = new URLSearchParams(); if (q.filter !== undefined) p.set('filter', JSON.stringify(q.filter)); for (const w of q.where ?? []) p.append('where', w); for (const k of ['sort', 'q', 'limit', 'offset', 'cursor', 'include']${t(' as const')}) { const v = q[k]; if (v !== undefined && v !== null) p.set(k, String(v)); } const s = p.toString(); return s ? '?' + s : ''; };`);
    out.push(`  async function call${t('<T>')}(method${t(': string')}, path${t(': string')}, body${t('?: unknown')})${t(': Promise<T>')} {`);
    out.push(`    const res = await f(base + path, { method, headers: { authorization: 'Bearer ' + o.token, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(o.workspace ? { 'x-workspace': o.workspace } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });`);
    out.push(`    if (res.status === 204) return undefined${t(' as T')};`);
    out.push(`    const text = await res.text();`);
    out.push(`    let data${t(': unknown')} = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }`);
    out.push(`    if (!res.ok) { const p = data && typeof data === 'object' ? data${t(' as { title?: string; detail?: string; step?: string; trace_id?: string }')} : null; throw new ApiError(res.status, p, (p && (p.detail || p.title)) || ('HTTP ' + res.status)); }`);
    out.push(`    return data${t(' as T')};`);
    out.push(`  }`);
    out.push(`  const entity = ${t('<V, I, R extends RecordMeta>')}(name${t(': string')}) => ({`);
    out.push(`    list: (q${t('?: ListOptions')}) => call${t('<Page<R>>')}('GET', '/api/apps/${app.name}/' + name + qs(q)),`);
    out.push(`    get: (id${t(': string')}, include${t("?: 'related'")}) => call${t('<R>')}('GET', '/api/apps/${app.name}/' + name + '/' + encodeURIComponent(id) + (include ? '?include=' + include : '')),`);
    out.push(`    create: (values${t(': I')}, label${t('?: Label')}) => call${t('<R>')}('POST', '/api/apps/${app.name}/' + name, { values, ...(label ? { label } : {}) }),`);
    out.push(`    update: (id${t(': string')}, values${t(': Partial<I>')}, version${t('?: number')}) => call${t('<R>')}('PATCH', '/api/apps/${app.name}/' + name + '/' + encodeURIComponent(id), { values, ...(version ? { version } : {}) }),`);
    out.push(`    delete: (id${t(': string')}) => call${t('<void>')}('DELETE', '/api/apps/${app.name}/' + name + '/' + encodeURIComponent(id)),`);
    out.push(`    transition: (id${t(': string')}, to${t(': string')}, version${t('?: number')}, note${t('?: string')}) => call${t('<R>')}('POST', '/api/apps/${app.name}/' + name + '/' + encodeURIComponent(id) + '/transition', { to, ...(version ? { version } : {}), ...(note ? { note } : {}) })`);
    out.push(`  });`);
    out.push(`  return {`);
    out.push(`    schemaVersion: ${current.version},`);
    out.push(`    schemaHash: '${current.hash}',`);
    for (const e of entities) {
      const T = pascal(e.name);
      out.push(`    ${/^[a-z][a-z0-9_]*$/.test(e.name) ? e.name : `'${e.name}'`}: entity${t(`<${T}Values, ${T}Input, ${T}Record>`)}('${e.name}'),`);
    }
    out.push(`  };`);
    out.push(`}`);
    out.push('');
    return out.join('\n');
  }
}

/** What an entity update changed, for the version row: one field added, changed or removed, the state machine, or the rest. */
export function describeEntityChange(before: EntityRow, after: EntityRow): { kind: SchemaChangeKind; target: string; summary: string; change: unknown } {
  const b = new Map(before.definition.fields.map((f) => [f.name, f]));
  const a = new Map(after.definition.fields.map((f) => [f.name, f]));
  const added = [...a.keys()].filter((n) => !b.has(n));
  const removed = [...b.keys()].filter((n) => !a.has(n));
  const changed = [...a.keys()].filter((n) => b.has(n) && JSON.stringify(b.get(n)) !== JSON.stringify(a.get(n)));
  const statesChanged = JSON.stringify(before.definition.states ?? null) !== JSON.stringify(after.definition.states ?? null);
  const only = added.length + removed.length + changed.length === 1 && !statesChanged;
  if (only && added.length) return { kind: 'field.added', target: after.name, summary: `Field ${added[0]} (${a.get(added[0]!)!.type}) added to ${after.name}`, change: { field: a.get(added[0]!) } };
  if (only && removed.length) return { kind: 'field.removed', target: after.name, summary: `Field ${removed[0]} removed from ${after.name}`, change: { field: removed[0] } };
  if (only && changed.length) return { kind: 'field.updated', target: after.name, summary: `Field ${changed[0]} of ${after.name} changed`, change: { field: a.get(changed[0]!) } };
  if (statesChanged && !added.length && !removed.length && !changed.length) return { kind: 'states.set', target: after.name, summary: after.definition.states ? `State machine of ${after.name} set (${after.definition.states.states.length} states)` : `State machine of ${after.name} removed`, change: { states: after.definition.states ?? null } };
  const parts = [added.length ? `${added.length} added` : '', removed.length ? `${removed.length} removed` : '', changed.length ? `${changed.length} changed` : '', statesChanged ? 'states' : ''].filter(Boolean);
  return { kind: 'entity.updated', target: after.name, summary: `Entity ${after.name} updated (rev ${after.rev}${parts.length ? ': ' + parts.join(', ') : ''})`, change: { definition: after.definition, ...(before.title !== after.title ? { title: after.title } : {}), ...(before.label !== after.label ? { label: after.label } : {}) } };
}

export const pascal = (name: string): string => name.split(/[^a-z0-9]+/i).filter(Boolean).map((p) => p[0]!.toUpperCase() + p.slice(1)).join('');

function jsonSchemaOf(f: Field, entities: EntityRow[]): Record<string, unknown> {
  const common = { ...(f.title ? { title: f.title } : {}), ...(f.description ? { description: f.description } : {}) };
  switch (f.type) {
    case 'string':
      return { ...common, type: 'string', maxLength: f.maxLength, ...(f.minLength != null ? { minLength: f.minLength } : {}), ...(f.pattern ? { pattern: f.pattern } : {}) };
    case 'number':
      return { ...common, type: f.integer ? 'integer' : 'number', ...(f.min != null ? { minimum: f.min } : {}), ...(f.max != null ? { maximum: f.max } : {}) };
    case 'boolean':
      return { ...common, type: 'boolean' };
    case 'date':
      return { ...common, type: 'string', format: f.withTime ? 'date-time' : 'date' };
    case 'enum':
      return { ...common, type: 'string', enum: f.options.map((o) => o.value) };
    case 'reference':
      return { ...common, type: 'string', description: `${f.description ?? ''} The id of a ${entities.find((e) => e.name === f.entity)?.title ?? f.entity} record.`.trim() };
    case 'lookup':
      return f.source === 'static' ? { ...common, type: 'string', enum: (f.options ?? []).map((o) => o.value) } : { ...common, type: 'string', description: `${f.description ?? ''} The id of a ${f.source === 'entity' ? f.entity : f.source}.`.trim() };
    case 'file':
      return { ...common, type: 'string', description: `${f.description ?? ''} A file id.`.trim() };
    case 'json':
      return { ...common, description: `${f.description ?? ''} Any JSON up to ${f.maxBytes} bytes.`.trim() };
    case 'formula':
      return { ...common, readOnly: true, description: `${f.description ?? ''} Computed: ${f.expression}`.trim() };
    case 'ai':
      return { ...common, type: 'string', readOnly: true, description: `${f.description ?? ''} Filled by the profile ${f.profile}.`.trim() };
  }
}

function tsTypeOf(f: Field): string {
  switch (f.type) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'enum':
      return f.options.map((o) => `'${o.value.replace(/'/g, "\\'")}'`).join(' | ') || 'string';
    case 'lookup':
      return f.source === 'static' && f.options?.length ? f.options.map((o) => `'${o.value.replace(/'/g, "\\'")}'`).join(' | ') : 'string';
    case 'json':
      return 'unknown';
    case 'formula':
      return 'string | number | boolean';
    default:
      return 'string';
  }
}

export { nameSchema };
