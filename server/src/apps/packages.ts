import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { clears, LABELS, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { canonicalJson } from '../crypto/index.js';
import { json } from '../db/knex.js';
import { badRequest, HttpProblem, notFound } from '../http/problem.js';
import { checkGitUrl } from '../knowledge/sources.js';
import type { Services } from '../services.js';
import { workflowBundleSchema } from '../workflows/bundles.js';
import { formDefinitionSchema } from './forms.js';
import { policyInputSchema } from './policies.js';
import { entityDefinitionSchema, nameSchema, type Values } from './schema.js';
import type { Actor, AppRow, AppService, RecordEvent, RecordRow } from './service.js';
import { RECORD_EVENTS } from './triggers.js';

const run = promisify(execFile);

/*
 * App packages (1.6.0, Sprint 39b, B-8201 to B-8204): the whole of an app's design as one versioned, signed document,
 * `exprsn-app/2`, the successor of the `exprsn-app/1` bundle (B-2208, `bundles.ts`, which still imports):
 *
 * - entities (fields, formulas, state machines), forms, record and schedule triggers (naming their workflows by
 *   name), the row and field policies (B-81), and the published workflows the triggers name, each as a signed
 *   `exprsn-workflow/1` bundle; records when asked for (`withData`), with their labels and states, reference values
 *   re-pointed on import;
 * - signed with the same HMAC key as bundles (`<OPENBAO_KEY_PREFIX>app-bundles`) over the canonical JSON of everything
 *   but the signature; import and deployment verify the signature over exactly what arrived before reading anything
 *   else, so a package changed in any byte, signed elsewhere or naming another key is refused and the refusal audited;
 * - kept in `app_packages`, sealed with the tenant key, numbered per source app (`version`), with the SHA-256 of the
 *   body so a promotion can prove it lands the exact package that passed the previous stage (`pipelines.ts`);
 * - applied to an app in place (`apply`): entities, forms, triggers and policies are reconciled by name, so a
 *   deployment or a rollback restores a previous version's schema and behaviour without recreating the app; entities
 *   that still hold records are kept and reported rather than dropped;
 * - laid out as one file per object for git (`files`, `fromFiles`): pretty-printed JSON with sorted keys, so a
 *   repository diff reads as the design change, and reassembled in the same order, so the signature still verifies.
 */

export const PACKAGE_FORMAT = 'exprsn-app/2';
export const STAGES = ['development', 'test', 'production'] as const;
export type Stage = (typeof STAGES)[number];

const entityPart = z.object({ name: nameSchema, title: z.string().min(1).max(200), label: z.enum(LABELS), definition: entityDefinitionSchema }).strict();
const formPart = z.object({ name: nameSchema, title: z.string().min(1).max(200), entity: nameSchema, definition: formDefinitionSchema, ratePerMinute: z.number().int().min(1).max(10_000) }).strict();
const triggerPart = z
  .object({ entity: nameSchema, kind: z.enum(['record', 'schedule']), events: z.array(z.enum(RECORD_EVENTS)).max(4).nullable(), cron: z.string().max(120).nullable(), workflow: z.string().min(1).max(63), enabled: z.boolean() })
  .strict();
const workflowPart = z.object({ name: z.string().min(1).max(63), bundle: workflowBundleSchema }).strict();
const recordPart = z.object({ entity: nameSchema, id: z.string().length(26), values: z.record(z.string().max(63), z.unknown()), label: z.enum(LABELS), state: z.string().max(63).nullable() }).strict();

export const packageSchema = z
  .object({
    format: z.literal(PACKAGE_FORMAT),
    version: z.number().int().min(1).max(1_000_000),
    exportedAt: z.string().max(40),
    app: z.object({ name: nameSchema, title: z.string().min(1).max(200), description: z.string().max(5000).nullable(), label: z.enum(LABELS) }).strict(),
    entities: z.array(entityPart).max(200),
    forms: z.array(formPart).max(500),
    triggers: z.array(triggerPart).max(500),
    policies: z.array(policyInputSchema).max(500),
    workflows: z.array(workflowPart).max(200),
    records: z.array(recordPart).max(50_000).optional(),
    key: z.string().max(200),
    signature: z.string().max(400)
  })
  .strict();
export type AppPackage = z.infer<typeof packageSchema>;
export type PackageBody = Omit<AppPackage, 'signature'>;

export type PackageSource = 'export' | 'promotion' | 'backup' | 'git' | 'rollback';

export interface PackageRow {
  id: string;
  tenant_id: string;
  app_id: string;
  app_name: string;
  version: number;
  format: string;
  source: PackageSource;
  hash: string;
  with_data: boolean;
  size: number;
  body: string;
  note: string | null;
  created_by: string | null;
  created_at: number;
}

export const packageView = (r: PackageRow) => ({
  id: r.id,
  appId: r.app_id,
  appName: r.app_name,
  version: r.version,
  format: r.format,
  source: r.source,
  hash: r.hash,
  withData: r.with_data,
  size: r.size,
  note: r.note,
  createdBy: r.created_by,
  createdAt: r.created_at
});

/** What applying a package to an app did, object by object. */
export interface ApplyReport {
  entities: { created: string[]; updated: string[]; removed: string[]; kept: string[] };
  forms: { created: string[]; updated: string[]; removed: string[] };
  triggers: { created: number; removed: number; skipped: { entity: string; workflow: string; reason: string }[] };
  policies: { created: number; removed: number };
  workflows: { imported: string[]; existing: string[]; failed: { name: string; reason: string }[] };
  records: { created: number; skipped: { entity: string; reason: string }[] };
}

const emptyReport = (): ApplyReport => ({
  entities: { created: [], updated: [], removed: [], kept: [] },
  forms: { created: [], updated: [], removed: [] },
  triggers: { created: 0, removed: 0, skipped: [] },
  policies: { created: 0, removed: 0 },
  workflows: { imported: [], existing: [], failed: [] },
  records: { created: 0, skipped: [] }
});

const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const triggerKey = (t: z.infer<typeof triggerPart>) => [t.entity, t.kind, t.workflow, t.cron ?? '', (t.events ?? []).join(',')].join('\u0000');

/** Pretty JSON with keys in order, so a git diff of one object reads as the change. */
export function readableJson(value: unknown): string {
  return JSON.stringify(JSON.parse(canonicalJson(value)), null, 2) + '\n';
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface GitOptions {
  /** `file://` repositories (tests and same-host mirrors) beside https. */
  allowFile: boolean;
  timeoutMs: number;
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || 'x';

export class AppPackages {
  constructor(
    private readonly s: () => Services,
    private readonly apps: AppService,
    private readonly git: GitOptions
  ) {}

  private get db() {
    return this.s().db;
  }

  get keyName(): string {
    return `${this.s().cfg.OPENBAO_KEY_PREFIX}app-bundles`;
  }

  private audit(actor: Actor, tenantId: string, action: string, target: Record<string, unknown>, label?: Label, detail?: Record<string, unknown>) {
    const who = actor.principal ? actorFrom(actor.principal, actor.ip ?? null) : { service: actor.service ?? 'apps' };
    return this.s().audit.append({ tenantId, action, kind: actor.principal ? 'admin' : 'system', actor: who, target, ...(label ? { label } : {}), ...(detail ? { detail } : {}), traceId: actor.traceId ?? null });
  }

  // ---------- building and signing ----------

  /** The next version number for packages made from `appId`. */
  async nextVersion(tenantId: string, appId: string): Promise<number> {
    const row = (await this.db('app_packages').where({ tenant_id: tenantId, app_id: appId }).max({ v: 'version' }).first()) as { v: number | string | null } | undefined;
    return Number(row?.v ?? 0) + 1;
  }

  /** Reads an app's whole design (and its records when asked) and signs it as a package of version `version`. */
  async build(actor: Actor & { principal: Principal }, app: AppRow, o: { withData: boolean; version: number }): Promise<AppPackage> {
    const s = this.s();
    const p = actor.principal;
    const entities = (await this.apps.entities(app)).slice().sort(byName);
    const entityName = new Map(entities.map((e) => [e.id, e.name]));
    const forms = (await this.apps.forms.list(app)).map(({ form }) => ({ name: form.name, title: form.title, entity: entityName.get(form.entity_id) ?? '', definition: form.definition, ratePerMinute: form.rate_per_minute })).sort(byName);
    const triggers = (await this.apps.triggers.list(app))
      .filter((t) => t.workflow)
      .map((t) => ({ entity: t.entity, kind: t.kind, events: t.kind === 'record' ? (t.events as RecordEvent[]) : null, cron: t.kind === 'schedule' ? t.cron : null, workflow: t.workflow!, enabled: t.enabled }))
      .sort((a, b) => (triggerKey(a) < triggerKey(b) ? -1 : 1));
    const policies = (await this.apps.policies.list(app))
      .map(({ policy, entityName: en }) => ({ name: policy.name, description: policy.description, enabled: policy.enabled, entity: en, subjects: policy.subjects, rows: policy.rows, fields: policy.fields, otherFields: policy.other_fields }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // The workflows the triggers name, as signed workflow bundles; one the designer cannot see is left out, so the
    // trigger is reported at deployment rather than the package failing to build.
    const workflows: z.infer<typeof workflowPart>[] = [];
    for (const name of [...new Set(triggers.map((t) => t.workflow))].sort()) {
      const bundle = await s.workflowBundles.export(p, name, { ip: actor.ip ?? null, ...(actor.traceId ? { traceId: actor.traceId } : {}) }).catch(() => null);
      if (bundle) workflows.push({ name, bundle });
    }
    const records: z.infer<typeof recordPart>[] = [];
    if (o.withData) {
      for (const e of entities) {
        const rows = (await this.db('app_records').where({ entity_id: e.id, hidden: false }).orderBy('created_at')) as RecordRow[];
        const computed = new Set(e.definition.fields.filter((f) => f.type === 'formula' || f.type === 'ai').map((f) => f.name));
        for (const r of rows) {
          if (!clears(p.clearance, r.label)) continue;
          const values = await this.apps.open(r);
          for (const k of Object.keys(values)) if (computed.has(k)) delete values[k]; // recomputed on import
          records.push({ entity: e.name, id: r.id, values, label: r.label, state: r.state });
        }
      }
    }
    const body: PackageBody = {
      format: PACKAGE_FORMAT,
      version: o.version,
      exportedAt: new Date().toISOString(),
      app: { name: app.name, title: app.title, description: app.description, label: app.label },
      entities: entities.map((e) => ({ name: e.name, title: e.title, label: e.label, definition: e.definition })),
      forms,
      triggers,
      policies,
      workflows,
      ...(o.withData ? { records } : {}),
      key: this.keyName
    };
    const text = canonicalJson(body);
    if (Buffer.byteLength(text) > s.cfg.APPS_PACKAGE_MAX_BYTES) throw new HttpProblem(413, 'Package too large', `The package is ${Buffer.byteLength(text)} bytes; the limit is ${s.cfg.APPS_PACKAGE_MAX_BYTES} (APPS_PACKAGE_MAX_BYTES). Leave the records out.`);
    const signature = await s.kms.hmac(this.keyName, text);
    return { ...body, signature };
  }

  static hashOf(pkg: AppPackage | PackageBody): string {
    const { signature: _s, ...body } = pkg as AppPackage;
    void _s;
    return sha256(canonicalJson(body));
  }

  /** Keeps a signed package in `app_packages`, sealed, and returns its row. */
  async store(actor: Actor & { principal: Principal }, app: Pick<AppRow, 'id' | 'name' | 'tenant_id' | 'label'>, pkg: AppPackage, source: PackageSource, note: string | null = null): Promise<PackageRow> {
    const s = this.s();
    const id = ulid();
    const text = JSON.stringify(pkg);
    const row: PackageRow = {
      id,
      tenant_id: app.tenant_id,
      app_id: app.id,
      app_name: app.name,
      version: pkg.version,
      format: pkg.format,
      source,
      hash: AppPackages.hashOf(pkg),
      with_data: !!pkg.records,
      size: Buffer.byteLength(text),
      body: await s.keys.seal(app.tenant_id, text, `apppkg:${id}`),
      note,
      created_by: actor.principal.userId,
      created_at: Date.now()
    };
    await this.db('app_packages').insert({ ...row, with_data: row.with_data });
    await this.audit(actor, app.tenant_id, 'app.package.created', { app: app.id, name: app.name, package: id }, app.label, { version: pkg.version, source, hash: row.hash, withData: row.with_data, size: row.size, entities: pkg.entities.length, forms: pkg.forms.length, triggers: pkg.triggers.length, policies: pkg.policies.length, workflows: pkg.workflows.length, records: pkg.records?.length ?? 0 });
    return row;
  }

  /** Builds, signs and stores a new version of `app`. */
  async create(actor: Actor & { principal: Principal }, app: AppRow, o: { withData?: boolean; note?: string | null; source?: PackageSource }): Promise<{ row: PackageRow; pkg: AppPackage }> {
    const version = await this.nextVersion(app.tenant_id, app.id);
    const pkg = await this.build(actor, app, { withData: !!o.withData, version });
    const row = await this.store(actor, app, pkg, o.source ?? 'export', o.note ?? null);
    return { row, pkg };
  }

  async list(app: AppRow): Promise<PackageRow[]> {
    return ((await this.db('app_packages').where({ tenant_id: app.tenant_id, app_id: app.id }).orderBy('version', 'desc').select('id', 'tenant_id', 'app_id', 'app_name', 'version', 'format', 'source', 'hash', 'with_data', 'size', 'note', 'created_by', 'created_at')) as Record<string, unknown>[]).map((r) => ({ ...(r as unknown as PackageRow), with_data: !!r.with_data, created_at: Number(r.created_at), body: '' }));
  }

  async row(tenantId: string, id: string): Promise<PackageRow> {
    const r = (await this.db('app_packages').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Package');
    return { ...(r as unknown as PackageRow), with_data: !!r.with_data, created_at: Number(r.created_at) };
  }

  /** A stored package, opened and verified again (the row could not have changed, but the proof is cheap). */
  async open(tenantId: string, id: string): Promise<{ row: PackageRow; pkg: AppPackage }> {
    const row = await this.row(tenantId, id);
    const text = await this.s().keys.open(tenantId, row.body, `apppkg:${id}`);
    const pkg = packageSchema.parse(JSON.parse(text));
    if (AppPackages.hashOf(pkg) !== row.hash) throw new HttpProblem(500, 'Package damaged', `The stored package ${id} no longer matches its hash.`);
    return { row, pkg };
  }

  // ---------- verifying ----------

  private async refuse(actor: Actor & { principal: Principal }, reason: string, detail: Record<string, unknown> = {}): Promise<never> {
    await this.audit(actor, actor.principal.tenantId, 'app.import.refused', {}, undefined, { reason, format: PACKAGE_FORMAT, ...detail });
    throw new HttpProblem(422, 'Package refused', reason);
  }

  /** Verifies the signature over exactly what arrived, then the shape. */
  async verify(actor: Actor & { principal: Principal }, raw: unknown): Promise<AppPackage> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return this.refuse(actor, `The package is not an ${PACKAGE_FORMAT} package.`);
    const { signature, ...body } = raw as Record<string, unknown>;
    if (typeof signature !== 'string' || typeof body.key !== 'string') return this.refuse(actor, 'The package is not signed.');
    if (body.key !== this.keyName) return this.refuse(actor, 'The package was signed with a key this server does not hold.', { key: body.key.slice(0, 100) });
    const ok = await this.s().kms.verifyHmac(this.keyName, canonicalJson(body), signature).catch(() => false);
    const named = typeof (body.app as { name?: unknown } | undefined)?.name === 'string' ? String((body.app as { name: string }).name).slice(0, 63) : null;
    if (!ok) return this.refuse(actor, 'The package signature does not verify: it was changed after it was signed, or signed elsewhere.', { app: named });
    const parsed = packageSchema.safeParse(raw);
    if (!parsed.success) return this.refuse(actor, `The package is not an ${PACKAGE_FORMAT} package: ${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`.trim());
    const pkg = parsed.data;
    const names = new Set(pkg.entities.map((e) => e.name));
    if (names.size !== pkg.entities.length) return this.refuse(actor, 'The package lists an entity twice.');
    for (const f of pkg.forms) if (!names.has(f.entity)) return this.refuse(actor, `The form ${f.name} names an entity the package does not carry.`);
    for (const t of pkg.triggers) if (!names.has(t.entity)) return this.refuse(actor, `A trigger names the entity ${t.entity}, which the package does not carry.`);
    for (const pol of pkg.policies) if (pol.entity && !names.has(pol.entity)) return this.refuse(actor, `The policy ${pol.name} names an entity the package does not carry.`);
    for (const r of pkg.records ?? []) if (!names.has(r.entity)) return this.refuse(actor, `A record names the entity ${r.entity}, which the package does not carry.`);
    return pkg;
  }

  // ---------- importing and applying ----------

  /** Creates a new app from a verified package (optionally under another name, in a workspace) and fills it. */
  async importNew(actor: Actor & { principal: Principal }, pkg: AppPackage, o: { name?: string; workspaceId?: string | null; source?: PackageSource }): Promise<{ app: AppRow; report: ApplyReport; row: PackageRow }> {
    const app = await this.apps.create(actor, { name: o.name ?? pkg.app.name, title: pkg.app.title, description: pkg.app.description, label: pkg.app.label, ...(o.workspaceId !== undefined ? { workspaceId: o.workspaceId } : {}) });
    let report: ApplyReport;
    try {
      report = await this.apply(actor, pkg, app, { mode: 'create' });
    } catch (err) {
      await this.apps.remove(actor, app.id).catch(() => undefined);
      throw err;
    }
    const row = await this.store(actor, app, pkg, o.source ?? 'export', `imported from ${pkg.app.name} v${pkg.version}`);
    await this.audit(actor, app.tenant_id, 'app.imported', { app: app.id, name: app.name, package: row.id }, app.label, { from: pkg.app.name, version: pkg.version, format: pkg.format, exportedAt: pkg.exportedAt, entities: pkg.entities.length, forms: pkg.forms.length, triggers: pkg.triggers.length, policies: pkg.policies.length, records: report.records.created });
    return { app, report, row };
  }

  /**
   * Reconciles `target` with the package: entities, forms, triggers and policies by name. In `deploy` mode objects the
   * package no longer has are removed (an entity still holding records is kept and reported); records come in only
   * into an entity that has none.
   */
  async apply(actor: Actor & { principal: Principal }, pkg: AppPackage, target: AppRow, o: { mode: 'create' | 'deploy' }): Promise<ApplyReport> {
    const s = this.s();
    const p = actor.principal;
    const report = emptyReport();
    const appRef = target.id;

    if (o.mode === 'deploy' && (target.title !== pkg.app.title || target.description !== pkg.app.description || target.label !== pkg.app.label)) {
      await this.apps.update(actor, appRef, { title: pkg.app.title, description: pkg.app.description, label: pkg.app.label });
    }

    // Entities: those that refer to others come after them (passes cover any order without cycles).
    const existing = new Map((await this.apps.entities(target)).map((e) => [e.name, e]));
    const pending = [...pkg.entities];
    const done = new Set<string>();
    for (let pass = 0; pending.length && pass <= pkg.entities.length; pass++) {
      for (let i = 0; i < pending.length; ) {
        const e = pending[i]!;
        const needs = e.definition.fields.flatMap((f) => (f.type === 'reference' ? [f.entity] : f.type === 'lookup' && f.source === 'entity' && f.entity ? [f.entity] : [])).filter((n) => n !== e.name);
        const ready = needs.every((n) => done.has(n) || (existing.has(n) && !pkg.entities.some((x) => x.name === n && !done.has(n))));
        if (!ready) {
          i++;
          continue;
        }
        const cur = existing.get(e.name);
        if (cur) {
          if (cur.title !== e.title || cur.label !== e.label || canonicalJson(cur.definition) !== canonicalJson(e.definition)) {
            await this.apps.updateEntity(actor, appRef, cur.id, { title: e.title, label: e.label, definition: e.definition });
            report.entities.updated.push(e.name);
          }
        } else {
          await this.apps.createEntity(actor, appRef, e);
          report.entities.created.push(e.name);
        }
        done.add(e.name);
        pending.splice(i, 1);
      }
    }
    if (pending.length) throw new HttpProblem(422, 'Package refused', `The entities ${pending.map((e) => e.name).join(', ')} refer to each other in a cycle.`);

    // Forms by name.
    const curForms = new Map((await this.apps.forms.list(target)).map((f) => [f.form.name, f]));
    for (const f of pkg.forms) {
      const cur = curForms.get(f.name);
      if (cur) {
        const curEntity = (await this.apps.entityById(target.tenant_id, cur.form.entity_id))?.name;
        if (curEntity !== f.entity) {
          await this.apps.forms.remove(actor, appRef, cur.form.id);
          await this.apps.forms.create(actor, appRef, { name: f.name, title: f.title, entity: f.entity, definition: f.definition, ratePerMinute: f.ratePerMinute });
        } else if (cur.form.title !== f.title || cur.form.rate_per_minute !== f.ratePerMinute || canonicalJson(cur.form.definition) !== canonicalJson(f.definition)) {
          await this.apps.forms.update(actor, appRef, cur.form.id, { title: f.title, definition: f.definition, ratePerMinute: f.ratePerMinute });
        } else continue;
        report.forms.updated.push(f.name);
      } else {
        await this.apps.forms.create(actor, appRef, { name: f.name, title: f.title, entity: f.entity, definition: f.definition, ratePerMinute: f.ratePerMinute });
        report.forms.created.push(f.name);
      }
    }
    if (o.mode === 'deploy') {
      const keep = new Set(pkg.forms.map((f) => f.name));
      for (const [name, f] of curForms) {
        if (keep.has(name)) continue;
        await this.apps.forms.remove(actor, appRef, f.form.id);
        report.forms.removed.push(name);
      }
    }

    // Workflows the triggers name: imported as drafts where none of that name exists (the importer publishes them).
    for (const w of pkg.workflows) {
      const found = await s.workflows.workflow(p, w.name).catch(() => null);
      if (found) {
        report.workflows.existing.push(w.name);
        continue;
      }
      try {
        await s.workflowBundles.import(p, w.bundle, { name: w.name }, { ip: actor.ip ?? null, ...(actor.traceId ? { traceId: actor.traceId } : {}) });
        report.workflows.imported.push(w.name);
      } catch (err) {
        report.workflows.failed.push({ name: w.name, reason: (err as Error).message.slice(0, 300) });
      }
    }

    // Triggers: replaced as a whole (they hold no data); one whose workflow is missing or unpublished is skipped.
    const curTriggers = await this.apps.triggers.list(target);
    for (const t of curTriggers) {
      await this.apps.triggers.remove(actor, appRef, t.id);
      report.triggers.removed++;
    }
    for (const t of pkg.triggers) {
      try {
        await this.apps.triggers.create(actor, appRef, { entity: t.entity, kind: t.kind, ...(t.events ? { events: t.events } : {}), ...(t.cron ? { cron: t.cron } : {}), workflow: t.workflow, enabled: t.enabled });
        report.triggers.created++;
      } catch (err) {
        report.triggers.skipped.push({ entity: t.entity, workflow: t.workflow, reason: (err as Error).message.slice(0, 300) });
      }
    }

    // Policies: replaced as a whole.
    for (const { policy } of await this.apps.policies.list(target)) {
      await this.apps.policies.remove(actor, target, policy.id);
      report.policies.removed++;
    }
    for (const pol of pkg.policies) {
      await this.apps.policies.create(actor, target, pol);
      report.policies.created++;
    }

    // Entities the package no longer has: dropped when empty, kept (and reported) when they still hold records.
    if (o.mode === 'deploy') {
      const keep = new Set(pkg.entities.map((e) => e.name));
      let gone = (await this.apps.entities(target)).filter((e) => !keep.has(e.name));
      for (let pass = 0; gone.length && pass <= gone.length + 1; pass++) {
        const next: typeof gone = [];
        for (const e of gone) {
          const records = Number(((await this.db('app_records').where({ entity_id: e.id }).count({ n: '*' })) as Record<string, unknown>[])[0]?.n ?? 0);
          if (records > 0) {
            if (!report.entities.kept.includes(e.name)) report.entities.kept.push(e.name);
            continue;
          }
          try {
            await this.apps.removeEntity(actor, appRef, e.id);
            report.entities.removed.push(e.name);
          } catch {
            next.push(e); // referred to by another entity that goes in a later pass
          }
        }
        if (next.length === gone.length) {
          for (const e of next) if (!report.entities.kept.includes(e.name)) report.entities.kept.push(e.name);
          break;
        }
        gone = next;
      }
    }

    // Records, into empty entities only, references re-pointed to the new ids.
    if (pkg.records?.length) {
      const entities = new Map((await this.apps.entities(target)).map((e) => [e.name, e]));
      const idMap = new Map<string, string>();
      const byEntity = new Map<string, typeof pkg.records>();
      for (const r of pkg.records) byEntity.set(r.entity, [...(byEntity.get(r.entity) ?? []), r]);
      const refFields = (name: string) => (entities.get(name)?.definition.fields ?? []).filter((f) => f.type === 'reference').map((f) => f.name);
      // Entities whose references point elsewhere come after their targets (two passes cover any order).
      const order = [...byEntity.keys()].sort((a, b) => {
        const aRefs = (entities.get(a)?.definition.fields ?? []).some((f) => f.type === 'reference' && f.entity === b);
        const bRefs = (entities.get(b)?.definition.fields ?? []).some((f) => f.type === 'reference' && f.entity === a);
        return aRefs && !bRefs ? 1 : bRefs && !aRefs ? -1 : a < b ? -1 : 1;
      });
      for (const name of order) {
        const entity = entities.get(name)!;
        const has = await this.db('app_records').where({ entity_id: entity.id }).first('id');
        if (has) {
          report.records.skipped.push({ entity: name, reason: 'the entity already holds records' });
          continue;
        }
        const refs = refFields(name);
        const computed = new Set(entity.definition.fields.filter((f) => f.type === 'formula' || f.type === 'ai').map((f) => f.name));
        for (const r of byEntity.get(name)!) {
          const values: Values = { ...r.values };
          for (const k of Object.keys(values)) if (computed.has(k)) delete values[k];
          for (const f of refs) if (typeof values[f] === 'string' && idMap.has(values[f] as string)) values[f] = idMap.get(values[f] as string);
          try {
            const created = await this.apps.createRecord({ ...actor, source: 'import' }, target, entity, { values, label: r.label });
            idMap.set(r.id, created.id);
            if (r.state && created.state !== r.state && entity.definition.states) await this.db('app_records').where({ id: created.id }).update({ state: r.state });
            report.records.created++;
          } catch (err) {
            report.records.skipped.push({ entity: name, reason: (err as Error).message.slice(0, 200) });
          }
        }
      }
    }
    return report;
  }

  // ---------- one file per object (B-8204) ----------

  /** The package as files: a manifest with the signature, then one readable JSON file per object. */
  static files(pkg: AppPackage): Map<string, string> {
    const { signature, key, format, version, exportedAt, app, entities, forms, triggers, policies, workflows, records } = pkg;
    const out = new Map<string, string>();
    out.set('package.json', readableJson({ format, version, exportedAt, app: app.name, key, signature, hash: AppPackages.hashOf(pkg), withData: !!records }));
    out.set('app.json', readableJson(app));
    for (const e of entities) out.set(`entities/${e.name}.json`, readableJson(e));
    for (const f of forms) out.set(`forms/${f.name}.json`, readableJson(f));
    triggers.forEach((t, i) => out.set(`triggers/${String(i + 1).padStart(3, '0')}-${t.entity}-${t.kind}.json`, readableJson(t)));
    policies.forEach((p, i) => out.set(`policies/${String(i + 1).padStart(3, '0')}-${slug(p.name)}.json`, readableJson(p)));
    for (const w of workflows) out.set(`workflows/${w.name}.json`, readableJson(w));
    if (records) {
      const byEntity = new Map<string, typeof records>();
      for (const r of records) byEntity.set(r.entity, [...(byEntity.get(r.entity) ?? []), r]);
      for (const [name, rows] of byEntity) out.set(`records/${name}.json`, JSON.stringify(rows.map((r) => JSON.parse(canonicalJson(r))), null, 2) + '\n');
      if (!byEntity.size) out.set('records/.empty', '');
    }
    return out;
  }

  /** Reassembles a package from the files `files` wrote, in the order the signature was made over. */
  static fromFiles(files: Map<string, string>): unknown {
    const read = (name: string): unknown => {
      const text = files.get(name);
      if (text == null) throw badRequest(`The repository has no ${name}.`);
      try {
        return JSON.parse(text);
      } catch {
        throw badRequest(`${name} is not JSON.`);
      }
    };
    const manifest = read('package.json') as Record<string, unknown>;
    const group = (dir: string) =>
      [...files.keys()]
        .filter((k) => k.startsWith(`${dir}/`) && k.endsWith('.json'))
        .sort()
        .map((k) => read(k));
    const sortByName = (xs: unknown[]) => xs.slice().sort((a, b) => byName(a as { name: string }, b as { name: string }));
    const body: Record<string, unknown> = {
      format: manifest.format,
      version: manifest.version,
      exportedAt: manifest.exportedAt,
      app: read('app.json'),
      entities: sortByName(group('entities')),
      forms: sortByName(group('forms')),
      triggers: group('triggers'),
      policies: group('policies'),
      workflows: sortByName(group('workflows')),
      key: manifest.key,
      signature: manifest.signature
    };
    if (manifest.withData) {
      const records: unknown[] = [];
      for (const k of [...files.keys()].filter((k) => k.startsWith('records/') && k.endsWith('.json')).sort()) {
        const rows = read(k);
        if (Array.isArray(rows)) records.push(...rows);
      }
      // records were written grouped per entity, in the order they were exported within each entity
      const ents = (body.entities as { name: string }[]).map((e) => e.name);
      records.sort((a, b) => ents.indexOf((a as { entity: string }).entity) - ents.indexOf((b as { entity: string }).entity));
      body.records = records;
    }
    return body;
  }

  // ---------- git export and import (B-8204) ----------

  private gitEnv(dir: string, askpass: string | null): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: dir, ...(askpass ? { GIT_ASKPASS: askpass } : {}) };
  }

  private gitProtocols(): string[] {
    return ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', ...(this.git.allowFile ? ['-c', 'protocol.file.allow=always'] : []), '-c', 'core.hooksPath=/dev/null'];
  }

  private async checkRepo(url: string): Promise<void> {
    const bad = checkGitUrl(url, this.git.allowFile);
    if (bad) throw badRequest(bad);
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (host) {
      const { isIP } = await import('node:net');
      const { isNeverAddress } = await import('../mcp/hosts.js');
      if (!isIP(host)) {
        const { lookup } = await import('node:dns/promises');
        const addrs = await lookup(host, { all: true }).catch(() => []);
        if (addrs.some((a) => isNeverAddress(a.address))) throw badRequest(`${host} resolves to a link-local, multicast or unspecified address.`);
      } else if (isNeverAddress(host)) throw badRequest('Link-local, multicast and unspecified addresses are refused.');
    }
  }

  private async withRepo<T>(actor: Actor & { principal: Principal }, o: { url: string; ref: string | null; credential: string | null; username: string }, fn: (repo: string, env: NodeJS.ProcessEnv, protocols: string[]) => Promise<T>): Promise<T> {
    await this.checkRepo(o.url);
    const dir = await mkdtemp(path.join(tmpdir(), 'exprsn-apppkg-'));
    try {
      let token: string | null = null;
      let askpass: string | null = null;
      if (o.credential) {
        if (!/^vault:/.test(o.credential)) throw badRequest('The credential is a vault reference (vault:path#key).');
        token = await this.s().vault.readAs(actor.principal, o.credential, { via: 'app-package-git', traceId: actor.traceId ?? null });
        askpass = path.join(dir, 'askpass.sh');
        await writeFile(askpass, `#!/bin/sh\ncase "$1" in\n  Username*) printf '%s\\n' "$EXPRSN_GIT_USER" ;;\n  *) printf '%s\\n' "$EXPRSN_GIT_TOKEN" ;;\nesac\n`, { mode: 0o700 });
      }
      const env: NodeJS.ProcessEnv = { ...this.gitEnv(dir, askpass), ...(token ? { EXPRSN_GIT_USER: o.username, EXPRSN_GIT_TOKEN: token } : {}) };
      const protocols = this.gitProtocols();
      const repo = path.join(dir, 'repo');
      const fail = (err: unknown, what: string) => badRequest(`git ${what} failed: ${String((err as { stderr?: string }).stderr || (err as Error).message).trim().split('\n').pop()?.slice(0, 300)}`);
      const clone = (ref: string | null) => run('git', [...protocols, 'clone', '--quiet', '--depth', '1', '--single-branch', '--no-tags', ...(ref ? ['--branch', ref] : []), '--', o.url, repo], { env, timeout: this.git.timeoutMs });
      try {
        await clone(o.ref);
      } catch (err) {
        const msg = String((err as { stderr?: string }).stderr || (err as Error).message);
        // A branch that does not exist yet (or an empty repository): take the default branch and start it.
        if (!o.ref || !/not found|Could not find remote branch|empty repository/i.test(msg)) throw fail(err, 'clone');
        await rm(repo, { recursive: true, force: true });
        await clone(null).catch((e: unknown) => {
          throw fail(e, 'clone');
        });
        await run('git', ['-C', repo, 'checkout', '--quiet', '-b', o.ref], { env, timeout: 30_000 }).catch((e: unknown) => {
          throw fail(e, 'checkout');
        });
      }
      return await fn(repo, env, protocols);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Writes a package into a repository under `path` (one file per object) and pushes a commit. */
  async gitPush(actor: Actor & { principal: Principal }, app: AppRow, pkg: AppPackage, o: { url: string; ref: string | null; path: string; message: string | null; credential: string | null; username: string }): Promise<{ commit: string; files: number; path: string }> {
    const sub = o.path.replace(/^\/+|\/+$/g, '');
    if (!sub || sub.split('/').some((x) => x === '..' || x === '.git')) throw badRequest('The path inside the repository is relative and leaves no directory.');
    const files = AppPackages.files(pkg);
    const out = await this.withRepo(actor, o, async (repo, env, protocols) => {
      const root = path.join(repo, sub);
      await rm(root, { recursive: true, force: true });
      for (const [name, text] of files) {
        const full = path.join(root, name);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, text);
      }
      await run('git', ['-C', repo, 'add', '-A', '--', sub], { env, timeout: 60_000 });
      const status = await run('git', ['-C', repo, 'status', '--porcelain', '--', sub], { env, timeout: 60_000 });
      if (!status.stdout.trim()) {
        const head = await run('git', ['-C', repo, 'rev-parse', 'HEAD'], { env, timeout: 30_000 }).catch(() => ({ stdout: '' }));
        return { commit: head.stdout.trim(), files: files.size, unchanged: true };
      }
      const message = o.message?.trim() || `${app.name} v${pkg.version}`;
      await run('git', ['-C', repo, '-c', 'user.name=Exprsn-AI', '-c', 'user.email=exprsn-ai@localhost', 'commit', '--quiet', '-m', message], { env, timeout: 60_000 });
      const head = await run('git', ['-C', repo, 'rev-parse', 'HEAD'], { env, timeout: 30_000 });
      const branch = o.ref ?? (await run('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { env, timeout: 30_000 })).stdout.trim();
      try {
        await run('git', [...protocols, '-C', repo, 'push', '--quiet', 'origin', `HEAD:${branch}`], { env, timeout: this.git.timeoutMs });
      } catch (err) {
        throw badRequest(`git push failed: ${String((err as { stderr?: string }).stderr || (err as Error).message).trim().split('\n').pop()?.slice(0, 300)}`);
      }
      return { commit: head.stdout.trim(), files: files.size, unchanged: false };
    });
    await this.audit(actor, app.tenant_id, 'app.package.pushed', { app: app.id, name: app.name }, app.label, { version: pkg.version, hash: AppPackages.hashOf(pkg), repository: o.url, ref: o.ref, path: sub, commit: out.commit, files: out.files, unchanged: out.unchanged });
    return { commit: out.commit, files: out.files, path: sub };
  }

  /** Reads a package laid out under `path` in a repository; the caller verifies it. */
  async gitRead(actor: Actor & { principal: Principal }, o: { url: string; ref: string | null; path: string; credential: string | null; username: string }): Promise<{ raw: unknown; commit: string }> {
    const sub = o.path.replace(/^\/+|\/+$/g, '');
    if (!sub || sub.split('/').some((x) => x === '..' || x === '.git')) throw badRequest('The path inside the repository is relative and leaves no directory.');
    return this.withRepo(actor, o, async (repo, env) => {
      const root = path.resolve(repo, sub);
      if (!root.startsWith(path.resolve(repo))) throw badRequest('The path leaves the repository.');
      const files = new Map<string, string>();
      const walk = async (d: string): Promise<void> => {
        for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
          if (e.name === '.git') continue;
          const full = path.join(d, e.name);
          if (e.isDirectory()) await walk(full);
          else if (e.isFile()) {
            if (files.size >= 60_000) throw badRequest('The package in the repository has too many files.');
            files.set(path.relative(root, full).split(path.sep).join('/'), await readFile(full, 'utf8'));
          }
        }
      };
      await walk(root);
      if (!files.has('package.json')) throw badRequest(`No package at ${sub} in the repository (no package.json).`);
      const commit = (await run('git', ['-C', repo, 'rev-parse', 'HEAD'], { env, timeout: 30_000 })).stdout.trim();
      return { raw: AppPackages.fromFiles(files), commit };
    });
  }

  /** Reads the deployment report a job stored. */
  static report(raw: unknown): ApplyReport | null {
    return raw == null ? null : json<ApplyReport | null>(raw, null);
  }
}
