import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import { clears, LABELS, labelRank, type Label } from '../authz/labels.js';
import { isRole, ROLES } from '../authz/permissions.js';
import type { Principal } from '../authz/policy.js';
import { json, type Db } from '../db/knex.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { referencesOf, WORKFLOW_BUNDLE_FORMAT, type BindingReport } from './bundles.js';
import { emptyGraph, graphSchema, type WfGraph } from './graph.js';
import { BUILTIN_TEMPLATES, NEED_KINDS, rebindExtras, templateNeeds, type NeedKind, type TemplateNeeds } from './template-catalog.js';
import { triggerConfigSchema } from './trigger-config.js';

/*
 * 1.8.0, Sprint 47 (B-136): the workflow template gallery.
 *
 * A template is a workflow graph (what an `exprsn-workflow/1` bundle carries) with gallery metadata: title, summary,
 * category, tags, icon, a semantic version, its label and what it needs (`template-catalog.ts`). Built-in starters
 * (scope `builtin`) ship as data and are seeded by migration 094; a tenant's own templates are saved from a workflow
 * the caller may manage ("save as template"), in the caller's workspace (or tenant-wide outside one), at that
 * workflow's label. Everyone sees the built-ins and the templates of their workspace and tenant at or below their
 * clearance; nobody sees another tenant's.
 *
 * "Use template" is the bundle import path (`WorkflowBundles.instantiate`, without a signature: the graph comes from
 * this table, not from outside): every reference is re-bound to the object the person chose (`bindings`), each is
 * reported as bound or missing, and the new workflow is a draft until someone publishes it, which checks every
 * reference again. Roles, saved queries and knowledge bases are re-bound here first, because bundles do not carry
 * them as references. Every change is audited as `workflow.template.saved`, `.updated`, `.deleted` and `.used`.
 */

const name = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Lower-case letters, digits and hyphens');
const semver = z.string().trim().regex(/^\d+\.\d+\.\d+$/, 'A version such as 1.0.0');
const tag = z.string().trim().min(1).max(40);
const map = z.record(z.string().min(1).max(300), z.string().min(1).max(300)).default({});

export const templateBindingsSchema = z
  .object({ tools: map, profiles: map, apps: map, vault: map, decisions: map, roles: map, connections: map, knowledge: map })
  .strict()
  .default({ tools: {}, profiles: {}, apps: {}, vault: {}, decisions: {}, roles: {}, connections: {}, knowledge: {} });
export type TemplateBindings = z.infer<typeof templateBindingsSchema>;

export const templateMetaSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(500),
    category: z.string().trim().min(1).max(40),
    tags: z.array(tag).max(12).default([]),
    icon: z.string().trim().regex(/^[a-z][a-z0-9-]{0,39}$/, 'An icon name such as workflows').default('workflows'),
    version: semver.default('1.0.0')
  })
  .strict();

export const saveTemplateSchema = templateMetaSchema.extend({ workflow: z.string().trim().min(1).max(63), name }).strict();
export const updateTemplateSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    summary: z.string().trim().min(1).max(500).optional(),
    category: z.string().trim().min(1).max(40).optional(),
    tags: z.array(tag).max(12).optional(),
    icon: z.string().trim().regex(/^[a-z][a-z0-9-]{0,39}$/, 'An icon name such as workflows').optional(),
    version: semver.optional(),
    refresh: z.boolean().default(false)
  })
  .strict();
export const listQuerySchema = z.object({ q: z.string().trim().max(100).optional(), category: z.string().trim().max(40).optional(), tag: z.string().trim().max(40).optional(), scope: z.enum(['builtin', 'tenant']).optional() }).strict();
export const useTemplateSchema = z.object({ name, label: z.enum(LABELS).optional(), bindings: templateBindingsSchema.optional() }).strict();

interface TemplateRow {
  id: string;
  scope: string;
  tenant_id: string | null;
  workspace_id: string | null;
  name: string;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  icon: string;
  version: string;
  label: Label;
  graph: WfGraph;
  needs: TemplateNeeds;
  source_workflow: string | null;
  uses: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

const rowFrom = (r: Record<string, unknown>): TemplateRow => ({
  ...(r as unknown as TemplateRow),
  tags: json<string[]>(r.tags, []),
  graph: graphSchema.parse(json(r.graph, emptyGraph())),
  needs: { ...Object.fromEntries(NEED_KINDS.map((k) => [k, []])), ...json<Partial<TemplateNeeds>>(r.needs, {}) } as TemplateNeeds,
  uses: Number(r.uses ?? 0),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

/** One binding of a template's reference, with the objects the person may choose from. */
export interface TemplateBinding {
  kind: 'tool' | 'profile' | 'app' | 'vault' | 'decision' | 'role' | 'connection' | 'knowledge' | 'trigger';
  from: string;
  to: string;
  status: 'bound' | 'missing' | 'on publish';
  detail: string | null;
}


export class WorkflowTemplates {
  constructor(private readonly s: () => Services) {}

  private synced: Promise<unknown> | null = null;

  private get db(): Db {
    return this.s().db;
  }

  /** Once per process, before the first read: built-in starters whose catalogue version changed are refreshed. */
  private ensure(): Promise<unknown> {
    this.synced ??= this.syncBuiltins().catch((err: Error) => {
      this.synced = null;
      this.s().log.warn({ err: err.message }, 'workflow templates: refreshing the built-in starters failed');
    });
    return this.synced;
  }

  /** Refreshes a built-in starter whose catalogue version changed (migration 094 inserted them). */
  async syncBuiltins(): Promise<number> {
    let changed = 0;
    if (!(await this.db.schema.hasTable('workflow_templates'))) return 0;
    for (const b of BUILTIN_TEMPLATES) {
      const row = (await this.db('workflow_templates').where({ id: b.id }).first('version')) as { version: string } | undefined;
      const fields = { scope: 'builtin', tenant_id: null, workspace_id: null, name: b.name, title: b.title, summary: b.summary, category: b.category, tags: JSON.stringify(b.tags), icon: b.icon, version: b.version, label: b.label, graph: JSON.stringify(b.graph), needs: JSON.stringify(templateNeeds(b.graph)), updated_at: Date.now() };
      if (!row) {
        await this.db('workflow_templates').insert({ id: b.id, source_workflow: null, uses: 0, created_by: null, updated_by: null, created_at: Date.now(), ...fields }).catch((err: unknown) => {
          if (!isUniqueViolation(err)) throw err;
        });
        changed++;
      } else if (row.version !== b.version) {
        await this.db('workflow_templates').where({ id: b.id }).update(fields);
        changed++;
      }
    }
    return changed;
  }

  // ---------- reading ----------

  /** Built-ins and the caller's tenant templates in their workspace (or tenant-wide ones), within their clearance. */
  private visible(p: Principal) {
    return (q: Knex.QueryBuilder) =>
      q.where((x) =>
        x.where({ scope: 'builtin' }).orWhere((y) => {
          y.where({ scope: p.tenantId, tenant_id: p.tenantId });
          if (p.workspaceId) y.andWhere((z2) => z2.where({ workspace_id: p.workspaceId }).orWhereNull('workspace_id'));
          else y.whereNull('workspace_id');
        })
      );
  }

  private async row(p: Principal, id: string): Promise<TemplateRow> {
    await this.ensure();
    const r = await this.visible(p)(this.db('workflow_templates')).andWhere((q) => q.where({ id }).orWhere({ name: id })).orderByRaw("case when scope = 'builtin' then 1 else 0 end").first();
    if (!r) throw notFound('Template');
    const t = rowFrom(r as Record<string, unknown>);
    if (!clears(p.clearance, t.label)) throw notFound('Template');
    return t;
  }

  private summary(t: TemplateRow) {
    return { id: t.id, name: t.name, title: t.title, summary: t.summary, category: t.category, tags: t.tags, icon: t.icon, version: t.version, label: t.label, builtIn: t.scope === 'builtin', workspaceId: t.workspace_id, steps: t.graph.nodes.length, trigger: triggerConfigSchema.safeParse(t.graph.nodes.find((n) => n.kind === 'trigger')?.config ?? {}).data?.source ?? 'manual', needs: t.needs, uses: t.uses, sourceWorkflow: t.source_workflow, createdBy: t.created_by, createdAt: t.created_at, updatedAt: t.updated_at };
  }

  /** The gallery: search over title, summary, name and tags; category and tag filters; facet counts of what is visible. */
  async list(p: Principal, q: z.infer<typeof listQuerySchema> = {}) {
    await this.ensure();
    const rows = ((await this.visible(p)(this.db('workflow_templates')).orderBy('title')) as Record<string, unknown>[]).map(rowFrom).filter((t) => clears(p.clearance, t.label));
    const categories = new Map<string, number>();
    const tags = new Map<string, number>();
    for (const t of rows) {
      categories.set(t.category, (categories.get(t.category) ?? 0) + 1);
      for (const g of t.tags) tags.set(g, (tags.get(g) ?? 0) + 1);
    }
    const words = (q.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const items = rows.filter((t) => {
      if (q.category && t.category.toLowerCase() !== q.category.toLowerCase()) return false;
      if (q.tag && !t.tags.some((g) => g.toLowerCase() === q.tag!.toLowerCase())) return false;
      if (q.scope === 'builtin' && t.scope !== 'builtin') return false;
      if (q.scope === 'tenant' && t.scope === 'builtin') return false;
      const hay = `${t.title} ${t.summary} ${t.name} ${t.category} ${t.tags.join(' ')}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    const facet = (m: Map<string, number>) => [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([n, count]) => ({ name: n, count }));
    return { items: items.map((t) => this.summary(t)), categories: facet(categories), tags: facet(tags), total: rows.length };
  }

  /** One template with its graph, for the preview. */
  async view(p: Principal, id: string) {
    const t = await this.row(p, id);
    return { ...this.summary(t), graph: t.graph };
  }

  // ---------- binding ----------

  /** What the caller can bind each kind of reference to here (names; the console's choices). */
  async options(p: Principal): Promise<Record<NeedKind, { value: string; label: string }[]>> {
    const s = this.s();
    const safe = async <T>(f: () => Promise<T[]>): Promise<T[]> => f().catch(() => []);
    const tools = await safe(() => s.workflows.callableTools(p) as Promise<{ name: string; version: string; sideEffect?: string }[]>);
    const profiles = (await safe(() => s.gateway.repo.profiles(p.tenantId))).filter((x) => x.status === 'published' && !x.alias_of && clears(p.clearance, x.label));
    const apps = await safe(() => s.apps.list(p));
    const decisions = (await safe(() => s.decisions.list(p))).filter((d) => d.publishedVersion != null);
    const queries = (await safe(() => s.savedQueries.listFor(p))).filter((q) => q.published_version != null && !q.write);
    const kbs = (await safe(() => s.knowledge.visible(p))).filter((x) => x.access === 'manage');
    return {
      tools: tools.map((t) => ({ value: t.name, label: `${t.name} ${t.version}` })),
      profiles: profiles.map((x) => ({ value: x.name, label: `${x.name} (up to ${x.label})` })),
      apps: apps.map((a) => ({ value: a.name, label: a.title || a.name })),
      decisions: decisions.map((d) => ({ value: d.name, label: `${d.title || d.name} v${d.publishedVersion}` })),
      roles: ROLES.map((r) => ({ value: r.id, label: r.name })),
      connections: queries.map((q) => ({ value: q.name, label: q.title || q.name })),
      knowledge: kbs.map((k) => ({ value: k.kb.id, label: `${k.kb.name} (${k.kb.label})` })),
      vault: []
    };
  }

  /** The bundle-shaped body of a template, with the extra kinds re-bound. */
  private body(t: TemplateRow, b: TemplateBindings) {
    const graph = rebindExtras(t.graph, b);
    const refs = referencesOf(graph);
    const trigger = triggerConfigSchema.parse(graph.nodes.find((n) => n.kind === 'trigger')?.config ?? {});
    return {
      format: WORKFLOW_BUNDLE_FORMAT,
      exportedAt: new Date(t.updated_at).toISOString(),
      workflow: { name: t.name, description: t.summary, label: t.label },
      version: null,
      graph,
      references: { tools: refs.tools.map((n) => ({ name: n, version: null })), profiles: refs.profiles, apps: refs.apps, vault: refs.vault, trigger, ...(refs.decisions.length ? { decisions: refs.decisions } : {}) }
    } as const;
  }

  /** Roles, saved queries and knowledge bases: what bundles do not report. */
  private async extras(p: Principal, t: TemplateRow, b: TemplateBindings): Promise<TemplateBinding[]> {
    const s = this.s();
    const out: TemplateBinding[] = [];
    for (const r of t.needs.roles) {
      const to = b.roles[r] ?? r;
      out.push({ kind: 'role', from: r, to, status: isRole(to) ? 'bound' : 'missing', detail: isRole(to) ? (ROLES.find((x) => x.id === to)?.name ?? null) : `${to} is not a role steps can name here` });
    }
    const queries = t.needs.connections.length ? await s.savedQueries.listFor(p).catch(() => []) : [];
    for (const c of t.needs.connections) {
      const to = b.connections[c] ?? c;
      const q = queries.find((x) => x.name === to || x.id === to);
      out.push({ kind: 'connection', from: c, to, status: q && q.published_version != null ? 'bound' : 'missing', detail: q ? (q.published_version != null ? `saved query ${q.name}, ${q.label}` : `${to} is not published yet`) : `${to} is not a saved query you can read here` });
    }
    const kbs = t.needs.knowledge.length ? await s.knowledge.visible(p).catch(() => []) : [];
    for (const k of t.needs.knowledge) {
      const to = b.knowledge[k] ?? k;
      const kb = kbs.find((x) => x.kb.id === to || x.kb.name === to);
      out.push({ kind: 'knowledge', from: k, to, status: kb && kb.access === 'manage' ? 'bound' : 'missing', detail: kb ? (kb.access === 'manage' ? `${kb.kb.name}, ${kb.kb.label}` : `you may read ${kb.kb.name} but not add to it`) : `${to} is not a knowledge base you can manage here` });
    }
    return out;
  }

  /** Every reference the template needs, bound with `bindings` as given, and whether each resolves here. */
  async check(p: Principal, id: string, raw: unknown) {
    const t = await this.row(p, id);
    const b = templateBindingsSchema.parse(raw ?? {});
    // Knowledge bases bind by id; the bundle report then names the graph's other references after the rebind.
    const body = this.body(t, b);
    const report = (await this.s().workflowBundles.report(p, body, body.graph, { tools: b.tools, profiles: b.profiles, apps: b.apps, vault: b.vault, decisions: b.decisions })).map((r: BindingReport) => r as TemplateBinding);
    const bindings = [...report, ...(await this.extras(p, t, b))];
    return { template: this.summary(t), bindings, missing: bindings.filter((x) => x.status === 'missing').length, options: await this.options(p) };
  }

  /** Creates a draft workflow from the template in the caller's workspace, with every reference re-bound. */
  async use(p: Principal, id: string, input: z.infer<typeof useTemplateSchema>, ctx: { ip?: string | null; traceId?: string } = {}) {
    const t = await this.row(p, id);
    const label = input.label ?? t.label;
    if (labelRank(label) < labelRank(t.label)) throw new HttpProblem(422, 'Label too low', `This template is ${t.label}; a workflow made from it is ${t.label} or above.`);
    const b = templateBindingsSchema.parse(input.bindings ?? {});
    const body = this.body(t, b);
    const extras = await this.extras(p, t, b);
    const bundleBindings = { tools: b.tools, profiles: b.profiles, apps: b.apps, vault: b.vault, decisions: b.decisions };
    const out = await this.s().workflowBundles.instantiate(p, body, { name: input.name, bindings: bundleBindings, label }, ctx, { action: 'workflow.template.used', detail: { template: t.id, templateName: t.name, templateVersion: t.version, builtIn: t.scope === 'builtin', missingExtras: extras.filter((x) => x.status === 'missing').map((x) => `${x.kind}:${x.to}`).slice(0, 50) } });
    await this.db('workflow_templates').where({ id: t.id }).increment('uses', 1);
    const bindings = [...(out.bindings as TemplateBinding[]), ...extras];
    return { workflow: out.workflow, template: this.summary({ ...t, uses: t.uses + 1 }), bindings, missing: bindings.filter((x) => x.status === 'missing').length };
  }

  // ---------- saving ----------

  /** "Save as template": the workflow's published version (or draft) and what it needs, at the workflow's label. */
  async save(p: Principal, input: z.infer<typeof saveTemplateSchema>, ctx: { ip?: string | null; traceId?: string } = {}) {
    const s = this.s();
    const snap = await s.workflowBundles.snapshot(p, input.workflow);
    const w = snap.w;
    if (!clears(p.clearance, w.label)) throw forbidden(`The workflow is ${w.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    const t = Date.now();
    const row = { id: ulid(), scope: p.tenantId, tenant_id: p.tenantId, workspace_id: w.workspace_id, name: input.name, title: input.title, summary: input.summary, category: input.category, tags: JSON.stringify([...new Set(input.tags)]), icon: input.icon, version: input.version, label: w.label, graph: JSON.stringify(snap.graph), needs: JSON.stringify(templateNeeds(snap.graph)), source_workflow: w.id, uses: 0, created_by: p.userId, updated_by: p.userId, created_at: t, updated_at: t };
    try {
      await this.db('workflow_templates').insert(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A template named ${input.name} exists in this tenant.`);
      throw err;
    }
    await this.audit(p, 'workflow.template.saved', row.id, input.name, w.label, { workflow: w.id, workflowName: w.name, version: snap.version, templateVersion: input.version, steps: snap.graph.nodes.length, category: input.category }, ctx);
    return this.view(p, row.id);
  }

  /** A tenant template the caller may change: theirs to manage, in reach and within clearance (never a built-in). */
  private async own(p: Principal, id: string): Promise<TemplateRow> {
    const t = await this.row(p, id);
    if (t.scope === 'builtin') throw forbidden('Built-in templates ship with the server and cannot be changed; save a copy from a workflow instead.', { step: 'builtin' });
    return t;
  }

  async update(p: Principal, id: string, input: z.infer<typeof updateTemplateSchema>, ctx: { ip?: string | null; traceId?: string } = {}) {
    const t = await this.own(p, id);
    const upd: Record<string, unknown> = { updated_by: p.userId, updated_at: Date.now() };
    for (const k of ['title', 'summary', 'category', 'icon', 'version'] as const) if (input[k] !== undefined) upd[k] = input[k];
    if (input.tags) upd.tags = JSON.stringify([...new Set(input.tags)]);
    let refreshed: number | null | undefined;
    if (input.refresh) {
      if (!t.source_workflow) throw conflict('This template has no workflow to refresh from.');
      const snap = await this.s().workflowBundles.snapshot(p, t.source_workflow).catch((err: unknown) => {
        if (err instanceof HttpProblem && err.status === 404) throw conflict('The workflow this template was saved from is gone or out of your reach.');
        throw err;
      });
      if (!clears(p.clearance, snap.w.label)) throw forbidden(`The workflow is ${snap.w.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
      upd.graph = JSON.stringify(snap.graph);
      upd.needs = JSON.stringify(templateNeeds(snap.graph));
      upd.label = snap.w.label;
      if (input.version === undefined) {
        const [a, b] = t.version.split('.').map(Number);
        upd.version = `${a}.${(b ?? 0) + 1}.0`;
      }
      refreshed = snap.version;
    }
    await this.db('workflow_templates').where({ id: t.id }).update(upd);
    await this.audit(p, 'workflow.template.updated', t.id, t.name, (upd.label as Label | undefined) ?? t.label, { fields: Object.keys(upd).filter((k) => !['updated_by', 'updated_at', 'graph', 'needs'].includes(k)), ...(input.refresh ? { refreshedFrom: t.source_workflow, workflowVersion: refreshed } : {}) }, ctx);
    return this.view(p, t.id);
  }

  async remove(p: Principal, id: string, ctx: { ip?: string | null; traceId?: string } = {}) {
    const t = await this.own(p, id);
    await this.db('workflow_templates').where({ id: t.id }).delete();
    await this.audit(p, 'workflow.template.deleted', t.id, t.name, t.label, { version: t.version, uses: t.uses }, ctx);
  }

  private audit(p: Principal, action: string, id: string, templateName: string, label: Label, detail: Record<string, unknown>, ctx: { ip?: string | null; traceId?: string }) {
    return this.s().audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { template: id, name: templateName }, label, detail, traceId: ctx.traceId ?? null });
  }
}
