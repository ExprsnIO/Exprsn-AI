import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import type { Principal } from '../authz/policy.js';
import { hmac, randomToken } from '../crypto/index.js';
import { json } from '../db/knex.js';
import { conflict, HttpProblem, notFound, tooManyRequests } from '../http/problem.js';
import { Limiter } from '../platform/ratelimit.js';
import type { Services } from '../services.js';
import { isComputed, nameSchema, normText, type Field, type Values } from './schema.js';
import type { Actor, AppRow, AppService, EntityRow } from './service.js';

/*
 * Forms (B-2205): an ordered list of an entity's fields, each optionally shown only when an earlier field has a value
 * (`visibleIf`). The server evaluates the conditions again on every submission and keeps only the fields the form
 * lists and shows; anything else in the body is dropped (and counted), never written.
 *
 * A form can be made public: a link token (shown once, stored as an HMAC) opens it without signing in at
 * `/api/public/forms`. Public submissions are rate-limited per address and per form in the shared counters, every
 * text value passes the `user-input` guardrail checkpoint (a block or hold refuses the submission, a redaction is
 * kept), and the record is written by no one (`source: form`). Public forms cannot ask for files, references or
 * lookups of users, workspaces or records: an anonymous visitor must not learn which ids exist.
 */

const condition = z
  .object({
    field: nameSchema,
    op: z.enum(['eq', 'ne', 'in', 'truthy', 'falsy']),
    value: z.union([z.string().max(200), z.number(), z.boolean(), z.array(z.union([z.string().max(200), z.number()])).max(50)]).optional()
  })
  .strict();
export type Condition = z.infer<typeof condition>;

export const formDefinitionSchema = z
  .object({
    fields: z
      .array(
        z
          .object({
            field: nameSchema,
            /** Overrides the entity: a field the entity leaves optional can be required on this form. */
            required: z.boolean().optional(),
            label: z.string().max(200).optional(),
            help: z.string().max(500).optional(),
            visibleIf: condition.optional()
          })
          .strict()
      )
      .min(1)
      .max(100),
    submitLabel: z.string().max(60).optional(),
    successMessage: z.string().max(500).optional()
  })
  .strict();
export type FormDefinition = z.infer<typeof formDefinitionSchema>;

export interface FormRow {
  id: string;
  tenant_id: string;
  app_id: string;
  entity_id: string;
  name: string;
  title: string;
  definition: FormDefinition;
  public: boolean;
  token_hash: string | null;
  rate_per_minute: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

const formFrom = (r: Record<string, unknown>): FormRow => ({ ...(r as unknown as FormRow), definition: formDefinitionSchema.parse(json(r.definition, {})), public: !!r.public, rate_per_minute: Number(r.rate_per_minute), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

export const formView = (f: FormRow, entity: EntityRow) => ({ id: f.id, name: f.name, title: f.title, entity: entity.name, definition: f.definition, public: f.public, ratePerMinute: f.rate_per_minute, createdAt: f.created_at, updatedAt: f.updated_at });

const PUBLIC_REFUSED = (f: Field): boolean => f.type === 'file' || f.type === 'reference' || (f.type === 'lookup' && f.source !== 'static');

/** Is a condition met by the values so far? */
export function conditionMet(c: Condition, values: Values): boolean {
  const v = values[c.field];
  const norm = (x: unknown) => (typeof x === 'string' ? normText(x) : x);
  switch (c.op) {
    case 'truthy':
      return v != null && v !== '' && v !== false && v !== 0;
    case 'falsy':
      return v == null || v === '' || v === false || v === 0;
    case 'eq':
      return norm(v) === norm(c.value);
    case 'ne':
      return norm(v) !== norm(c.value);
    case 'in':
      return Array.isArray(c.value) && c.value.map(norm).includes(norm(v) as string | number);
  }
}

/**
 * The values a submission may write: the form's fields, in order, that are visible given the earlier ones. Returns
 * them and the names of everything dropped.
 */
export function pickFormValues(def: FormDefinition, input: Values): { values: Values; dropped: string[]; visible: string[] } {
  const values: Values = {};
  const visible: string[] = [];
  for (const f of def.fields) {
    if (f.visibleIf && !conditionMet(f.visibleIf, values)) continue;
    visible.push(f.field);
    if (Object.prototype.hasOwnProperty.call(input, f.field)) values[f.field] = input[f.field];
  }
  const dropped = Object.keys(input).filter((k) => !Object.prototype.hasOwnProperty.call(values, k));
  return { values, dropped, visible };
}

export class AppForms {
  constructor(
    private readonly s: () => Services,
    private readonly apps: AppService
  ) {}

  private get db() {
    return this.s().db;
  }

  private check(entity: EntityRow, def: FormDefinition, isPublic: boolean): void {
    const fields = new Map(entity.definition.fields.map((f) => [f.name, f]));
    const seen = new Set<string>();
    const problems: string[] = [];
    for (const ff of def.fields) {
      const f = fields.get(ff.field);
      if (!f) problems.push(`${ff.field} is not a field of ${entity.name}.`);
      else if (isComputed(f)) problems.push(`${ff.field} is computed; a form cannot ask for it.`);
      else if (isPublic && PUBLIC_REFUSED(f)) problems.push(`${ff.field} is a ${f.type === 'lookup' ? `${f.source} lookup` : f.type} field; a public form cannot ask for it.`);
      if (seen.has(ff.field)) problems.push(`${ff.field} is on the form twice.`);
      if (ff.visibleIf && !seen.has(ff.visibleIf.field)) problems.push(`${ff.field} depends on ${ff.visibleIf.field}, which must come earlier on the form.`);
      seen.add(ff.field);
    }
    // A field the entity requires and the form leaves out (or hides) would refuse every submission.
    for (const f of entity.definition.fields) if (f.required && !seen.has(f.name)) problems.push(`${entity.name} requires ${f.name}; the form must ask for it.`);
    if (problems.length) throw new HttpProblem(400, 'Invalid form', problems[0]!, { extensions: { problems } });
  }

  async list(app: AppRow): Promise<{ form: FormRow; entity: EntityRow }[]> {
    const entities = new Map((await this.apps.entities(app)).map((e) => [e.id, e]));
    return ((await this.db('app_forms').where({ app_id: app.id }).orderBy('name')) as Record<string, unknown>[]).map(formFrom).flatMap((f) => (entities.get(f.entity_id) ? [{ form: f, entity: entities.get(f.entity_id)! }] : []));
  }

  async form(p: Principal, appRef: string, formRef: string): Promise<{ app: AppRow; entity: EntityRow; form: FormRow }> {
    const app = await this.apps.app(p, appRef);
    const r = await this.db('app_forms').where({ app_id: app.id }).andWhere((q) => q.where({ id: formRef }).orWhere({ name: formRef })).first();
    if (!r) throw notFound('Form');
    const form = formFrom(r);
    const entity = await this.apps.entityById(app.tenant_id, form.entity_id);
    if (!entity) throw notFound('Form');
    return { app, entity, form };
  }

  private audit(actor: Actor & { principal: Principal }, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: actor.principal.tenantId, action, kind: 'admin', actor: actorFrom(actor.principal, actor.ip ?? null), target, ...(detail ? { detail } : {}), traceId: actor.traceId ?? null });
  }

  async create(actor: Actor & { principal: Principal }, appRef: string, input: { name: string; title?: string; entity: string; definition: FormDefinition; ratePerMinute?: number }) {
    const app = await this.apps.app(actor.principal, appRef);
    const entity = await this.apps.entityOf(app, input.entity);
    this.check(entity, input.definition, false);
    const t = Date.now();
    const row: FormRow = { id: ulid(), tenant_id: app.tenant_id, app_id: app.id, entity_id: entity.id, name: input.name, title: input.title ?? input.name, definition: input.definition, public: false, token_hash: null, rate_per_minute: input.ratePerMinute ?? 10, created_by: actor.principal.userId, updated_by: actor.principal.userId, created_at: t, updated_at: t };
    const dup = await this.db('app_forms').where({ app_id: app.id, name: input.name }).first('id');
    if (dup) throw conflict(`The app has a form named ${input.name}.`);
    await this.db('app_forms').insert({ ...row, definition: JSON.stringify(row.definition) });
    await this.audit(actor, 'app.form.created', { app: app.id, form: row.id, name: row.name, entity: entity.id });
    return { app, entity, form: row };
  }

  async update(actor: Actor & { principal: Principal }, appRef: string, formRef: string, patch: { title?: string; definition?: FormDefinition; ratePerMinute?: number }) {
    const { app, entity, form } = await this.form(actor.principal, appRef, formRef);
    const def = patch.definition ?? form.definition;
    this.check(entity, def, form.public);
    const upd = { title: patch.title ?? form.title, definition: JSON.stringify(def), rate_per_minute: patch.ratePerMinute ?? form.rate_per_minute, updated_by: actor.principal.userId, updated_at: Date.now() };
    await this.db('app_forms').where({ id: form.id }).update(upd);
    await this.audit(actor, 'app.form.updated', { app: app.id, form: form.id, name: form.name }, { fields: def.fields.length, ratePerMinute: upd.rate_per_minute });
    return { app, entity, form: { ...form, ...upd, definition: def } };
  }

  async remove(actor: Actor & { principal: Principal }, appRef: string, formRef: string) {
    const { app, form } = await this.form(actor.principal, appRef, formRef);
    await this.db('app_forms').where({ id: form.id }).delete();
    await this.audit(actor, 'app.form.deleted', { app: app.id, form: form.id, name: form.name }, { public: form.public });
  }

  private tokenHash(token: string): string {
    return hmac(this.s().cfg.SESSION_SECRET, `app-form:${token}`);
  }

  /** Makes a form public with a new link (the token is shown once; an older link stops working), or private again. */
  async setPublic(actor: Actor & { principal: Principal }, appRef: string, formRef: string, enabled: boolean): Promise<{ token: string | null }> {
    const { app, entity, form } = await this.form(actor.principal, appRef, formRef);
    if (!enabled) {
      await this.db('app_forms').where({ id: form.id }).update({ public: false, token_hash: null, updated_by: actor.principal.userId, updated_at: Date.now() });
      await this.audit(actor, 'app.form.unpublished', { app: app.id, form: form.id, name: form.name });
      return { token: null };
    }
    this.check(entity, form.definition, true);
    const token = `exa_${randomToken(32)}`;
    await this.db('app_forms').where({ id: form.id }).update({ public: true, token_hash: this.tokenHash(token), updated_by: actor.principal.userId, updated_at: Date.now() });
    await this.audit(actor, form.public ? 'app.form.link.rotated' : 'app.form.published', { app: app.id, form: form.id, name: form.name });
    return { token };
  }

  /** What a form shows: its fields with type, options and conditions (never other fields of the entity). */
  describe(entity: EntityRow, form: FormRow) {
    const fields = new Map(entity.definition.fields.map((f) => [f.name, f]));
    return {
      title: form.title,
      submitLabel: form.definition.submitLabel ?? 'Submit',
      fields: form.definition.fields.map((ff) => {
        const f = fields.get(ff.field)!;
        return {
          name: f.name,
          label: ff.label ?? f.title ?? f.name,
          help: ff.help ?? f.description ?? null,
          type: f.type,
          required: ff.required ?? f.required,
          ...(f.type === 'enum' ? { options: f.options } : {}),
          ...(f.type === 'lookup' && f.source === 'static' ? { options: f.options ?? [] } : {}),
          ...(f.type === 'string' ? { maxLength: f.maxLength, multiline: !!f.multiline } : {}),
          ...(f.type === 'number' ? { min: f.min ?? null, max: f.max ?? null, integer: f.integer } : {}),
          ...(f.type === 'date' ? { withTime: f.withTime } : {}),
          visibleIf: ff.visibleIf ?? null
        };
      })
    };
  }

  /**
   * A submission: the form's visible fields only (the rest dropped), required ones checked, text screened at the
   * `user-input` checkpoint, then written as a record of the form's entity.
   */
  private async submit(app: AppRow, entity: EntityRow, form: FormRow, input: Values, actor: Actor): Promise<{ id: string; dropped: string[] }> {
    const s = this.s();
    const { values, dropped, visible } = pickFormValues(form.definition, input);
    const required = form.definition.fields.filter((f) => f.required && visible.includes(f.field) && (values[f.field] == null || values[f.field] === ''));
    if (required.length) throw new HttpProblem(400, 'Invalid record', `${required.map((f) => f.field).join(', ')} ${required.length === 1 ? 'is' : 'are'} required.`, { extensions: { problems: required.map((f) => ({ field: f.field, message: 'is required' })) } });
    for (const [k, v] of Object.entries(values)) {
      if (typeof v !== 'string' || !v) continue;
      const d = await s.guardrails.check({ tenantId: app.tenant_id, workspaceId: app.workspace_id, checkpoint: 'user-input', text: v, label: entity.label, ...(actor.principal ? { principal: actor.principal } : {}), source: { kind: 'app-form', id: form.id }, meta: { app: app.id, entity: entity.name, field: k, public: !actor.principal } });
      if (d.action === 'block' || d.action === 'require-approval') throw new HttpProblem(422, 'Submission refused', `The submission was refused by the content rules${d.reason ? `: ${d.reason}` : '.'}`, { extensions: { field: k } });
      if (d.action === 'redact') values[k] = d.text;
    }
    const rec = await this.apps.createRecord(actor, app, entity, { values });
    await s.audit.append({
      tenantId: app.tenant_id,
      action: 'app.form.submitted',
      kind: actor.principal ? 'admin' : 'system',
      actor: actor.principal ? actorFrom(actor.principal, actor.ip ?? null) : { service: 'apps.forms', ...(actor.ip ? { ip: actor.ip } : {}) },
      target: { app: app.id, form: form.id, record: rec.id },
      label: rec.label,
      detail: { public: !actor.principal, fields: Object.keys(values), dropped: dropped.slice(0, 50) },
      traceId: actor.traceId ?? null
    });
    return { id: rec.id, dropped };
  }

  async submitSignedIn(actor: Actor & { principal: Principal }, appRef: string, formRef: string, input: Values) {
    const { app, entity, form } = await this.form(actor.principal, appRef, formRef);
    return this.submit(app, entity, form, input, { ...actor, source: 'form' });
  }

  private async byToken(token: string): Promise<{ app: AppRow; entity: EntityRow; form: FormRow }> {
    const r = await this.db('app_forms').where({ token_hash: this.tokenHash(token), public: true }).first();
    if (!r) throw notFound('Form');
    const form = formFrom(r);
    const tenant = await this.s().tenants.byId(form.tenant_id);
    const app = await this.apps.appById(form.tenant_id, form.app_id);
    const entity = await this.apps.entityById(form.tenant_id, form.entity_id);
    if (!tenant || tenant.state !== 'active' || !app || !entity) throw notFound('Form');
    return { app, entity, form };
  }

  async openPublic(token: string) {
    const { entity, form } = await this.byToken(token);
    return this.describe(entity, form);
  }

  /** A public submission: per-address and per-form limits first, then the same path as a signed-in one. */
  async submitPublic(token: string, input: Values, ip: string | null, traceId: string | undefined, perAddress: Limiter): Promise<{ submitted: true; message: string; dropped: number }> {
    const { app, entity, form } = await this.byToken(token);
    const addr = await perAddress.consume(ip ?? 'unknown');
    if (!addr.allowed) throw tooManyRequests('Too many form submissions from this address; try again in a minute.', addr.resetMs / 1000);
    const perForm = await new Limiter(this.s().counters, 'app-form', form.rate_per_minute, 60_000).consume(form.id);
    if (!perForm.allowed) throw tooManyRequests('This form is receiving too many submissions; try again in a minute.', perForm.resetMs / 1000);
    const out = await this.submit(app, entity, form, input, { principal: null, source: 'form', service: 'apps.forms', ip, ...(traceId ? { traceId } : {}) });
    return { submitted: true, message: form.definition.successMessage ?? 'Thank you. Your submission was received.', dropped: out.dropped.length };
  }
}
