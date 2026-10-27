import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { clears, LABELS, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { canonicalJson } from '../crypto/index.js';
import { json } from '../db/knex.js';
import { conflict, HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';
import { BODY_VAULT_REF, emptyGraph, graphSchema, graphVaultRefs, headerVaultRef, queryVaultRef, type WfGraph } from './graph.js';
import { triggerConfigSchema } from './trigger-config.js';

/*
 * Workflow bundles (Sprint 32b, B-3909), like app bundles (`exprsn-app/1`, B-2208): a workflow's graph (its published
 * version, or the draft when nothing is published) exported as one JSON document with the references it makes, and
 * signed with an HMAC key held in the KMS (`<OPENBAO_KEY_PREFIX>workflow-bundles`). Runs, versions, the registry
 * tool a workflow is published as and app triggers that start it are not part of a bundle.
 *
 * Import verifies the signature over the canonical JSON of everything but the signature before reading anything
 * else: a bundle changed in any byte after it was signed, signed with another key or naming another key is refused
 * (`422 Bundle refused`) and the refusal audited. References are re-bound in the importing workspace: each tool,
 * profile, app and vault reference keeps its name unless `bindings` maps it to another, and the import reports for
 * each whether it resolves there. The workflow is created as a draft (never published), so its trigger starts nothing
 * until the importer publishes it, and then runs as them; publishing validates every reference again.
 *
 * 1.8.0 (B-130): a webhook trigger's secret, owner and on/off state are kept in `workflow_hooks`, not in the graph, so
 * an imported workflow's webhook arrives switched off with no secret.
 */

export const WORKFLOW_BUNDLE_FORMAT = 'exprsn-workflow/1';

const refName = z.string().min(1).max(300);
const references = z
  .object({
    tools: z.array(z.object({ name: refName, version: z.string().max(60).nullable() }).strict()).max(200),
    profiles: z.array(refName).max(200),
    apps: z.array(refName).max(200),
    vault: z.array(refName).max(200),
    trigger: triggerConfigSchema,
    /** Sprint 46 (B-131): decision tables by name, with the version a step pins (absent in older bundles). */
    decisions: z.array(z.object({ name: refName, version: z.number().int().min(1).nullable() }).strict()).max(200).optional()
  })
  .strict();

export const workflowBundleSchema = z
  .object({
    format: z.literal(WORKFLOW_BUNDLE_FORMAT),
    exportedAt: z.string().max(40),
    workflow: z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), description: z.string().max(500).nullable(), label: z.enum(LABELS) }).strict(),
    /** The version exported, or null for the draft. */
    version: z.number().int().min(1).nullable(),
    graph: graphSchema,
    references,
    key: z.string().max(200),
    signature: z.string().max(400)
  })
  .strict();
export type WorkflowBundle = z.infer<typeof workflowBundleSchema>;

const bindingMap = z.record(refName, refName).default({});
export const bindingsSchema = z.object({ tools: bindingMap, profiles: bindingMap, apps: bindingMap, vault: bindingMap, decisions: bindingMap }).strict().default({ tools: {}, profiles: {}, apps: {}, vault: {}, decisions: {} });
export type Bindings = z.infer<typeof bindingsSchema>;

export interface BindingReport {
  kind: 'tool' | 'profile' | 'app' | 'vault' | 'trigger' | 'decision';
  from: string;
  to: string;
  status: 'bound' | 'missing' | 'on publish';
  detail: string | null;
}

/** The references a graph makes, by kind (names as the steps write them). */
export function referencesOf(g: WfGraph) {
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort();
  return {
    tools: uniq(g.nodes.filter((n) => n.kind === 'tool').map((n) => String(n.config.tool ?? '').trim())),
    profiles: uniq(g.nodes.filter((n) => n.kind === 'model').map((n) => String(n.config.profile ?? ''))),
    apps: uniq(g.nodes.filter((n) => n.kind === 'record').map((n) => String(n.config.app ?? ''))),
    vault: uniq(graphVaultRefs(g)),
    decisions: [...new Map(g.nodes.filter((n) => n.kind === 'decision').map((n) => [`${String(n.config.table ?? '')}@${Number(n.config.version ?? 0)}`, { name: String(n.config.table ?? '').trim(), version: typeof n.config.version === 'number' ? n.config.version : null }])).values()].filter((x) => x.name)
  };
}

/** The graph with every reference renamed by the bindings. */
function rebind(g: WfGraph, b: Bindings): WfGraph {
  const out = JSON.parse(JSON.stringify(g)) as WfGraph;
  for (const n of out.nodes) {
    const c = n.config as Record<string, unknown>;
    if (n.kind === 'tool' && typeof c.tool === 'string') c.tool = b.tools[c.tool.trim()] ?? c.tool;
    if (n.kind === 'model' && typeof c.profile === 'string') c.profile = b.profiles[c.profile] ?? c.profile;
    if (n.kind === 'record' && typeof c.app === 'string') c.app = b.apps[c.app] ?? c.app;
    if (n.kind === 'decision' && typeof c.table === 'string') c.table = b.decisions?.[c.table.trim()] ?? c.table;
    if (n.kind === 'http' && c.headers && typeof c.headers === 'object') {
      for (const [k, v] of Object.entries(c.headers as Record<string, unknown>)) {
        const r = typeof v === 'string' ? headerVaultRef(v) : null;
        if (r && b.vault[r.ref]) (c.headers as Record<string, string>)[k] = r.prefix + b.vault[r.ref];
      }
    }
    // 1.7.0 (B-9102): references in query parameters and in the body.
    if (n.kind === 'http' && c.query && typeof c.query === 'object') {
      for (const [k, v] of Object.entries(c.query as Record<string, unknown>)) {
        const r = typeof v === 'string' ? queryVaultRef(v) : null;
        if (r && b.vault[r]) (c.query as Record<string, string>)[k] = b.vault[r]!;
      }
    }
    if (n.kind === 'http' && typeof c.body === 'string') c.body = c.body.replace(BODY_VAULT_REF, (m: string, ref: string) => (b.vault[ref] ? `{${b.vault[ref]}}` : m));
  }
  return graphSchema.parse(out);
}

export class WorkflowBundles {
  constructor(private readonly s: () => Services) {}

  get keyName(): string {
    return `${this.s().cfg.OPENBAO_KEY_PREFIX}workflow-bundles`;
  }

  /**
   * The graph a bundle (or, 1.8.0 B-136, a template) carries: the published version, or the draft when nothing is
   * published, with decision steps naming their table by name.
   */
  async snapshot(p: Principal, ref: string) {
    const s = this.s();
    const w = await s.workflows.workflow(p, ref);
    let graph: WfGraph = graphSchema.parse(json(w.draft, emptyGraph()));
    let version: number | null = null;
    if (w.published_version) {
      const v = await s.db('workflow_versions').where({ workflow_id: w.id, version: w.published_version }).first('graph');
      if (v) {
        graph = graphSchema.parse(json(v.graph, emptyGraph()));
        version = w.published_version;
      }
    }
    // B-131: decision steps travel by table name (an id names nothing in another tenant).
    for (const n of graph.nodes) {
      if (n.kind !== 'decision' || typeof n.config.table !== 'string') continue;
      const t = (await s.db('decision_tables').where({ tenant_id: w.tenant_id, id: n.config.table }).first('name')) as { name: string } | undefined;
      if (t) n.config = { ...n.config, table: t.name };
    }
    return { w, graph, version };
  }

  async export(p: Principal, ref: string, ctx: { ip?: string | null; traceId?: string } = {}): Promise<WorkflowBundle> {
    const s = this.s();
    const { w, graph, version } = await this.snapshot(p, ref);
    const refs = referencesOf(graph);
    const scope = { tenantId: w.tenant_id, workspaceId: w.workspace_id };
    const tools = [];
    for (const name of refs.tools) tools.push({ name, version: (await s.registry.resolve(scope, name))?.version ?? null });
    const trigger = triggerConfigSchema.parse(graph.nodes.find((n) => n.kind === 'trigger')?.config ?? {});
    const body: Omit<WorkflowBundle, 'signature'> = {
      format: WORKFLOW_BUNDLE_FORMAT,
      exportedAt: new Date().toISOString(),
      workflow: { name: w.name, description: w.description, label: w.label },
      version,
      graph,
      references: { tools, profiles: refs.profiles, apps: refs.apps, vault: refs.vault, trigger, ...(refs.decisions.length ? { decisions: refs.decisions } : {}) },
      key: this.keyName
    };
    const signature = await s.kms.hmac(this.keyName, canonicalJson(body));
    await s.audit.append({ tenantId: w.tenant_id, action: 'workflow.exported', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { workflow: w.id, name: w.name }, label: w.label, detail: { version, steps: graph.nodes.length, tools: tools.length, profiles: refs.profiles.length }, traceId: ctx.traceId ?? null });
    return { ...body, signature };
  }

  private async refuse(p: Principal, reason: string, detail: Record<string, unknown>, ctx: { ip?: string | null; traceId?: string }): Promise<never> {
    await this.s().audit.append({ tenantId: p.tenantId, action: 'workflow.import.refused', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: {}, detail: { reason, ...detail }, traceId: ctx.traceId ?? null });
    throw new HttpProblem(422, 'Bundle refused', reason);
  }

  /** What each reference of the re-bound graph resolves to in the importer's workspace. */
  async report(p: Principal, bundle: Pick<WorkflowBundle, 'references'>, g: WfGraph, b: Bindings): Promise<BindingReport[]> {
    const s = this.s();
    const scope = { tenantId: p.tenantId, workspaceId: p.workspaceId ?? null };
    const out: BindingReport[] = [];
    for (const t of bundle.references.tools) {
      const to = b.tools[t.name] ?? t.name;
      const e = await s.registry.resolve(scope, to);
      out.push({ kind: 'tool', from: t.name, to, status: e ? 'bound' : 'missing', detail: e ? (t.version && e.version !== t.version ? `version ${e.version} here; the bundle was exported against ${t.version}` : `version ${e.version}`) : `${to} is not published to this workspace` });
    }
    const profiles = await s.gateway.repo.profiles(p.tenantId);
    for (const name of bundle.references.profiles) {
      const to = b.profiles[name] ?? name;
      const pr = profiles.find((x) => x.name === to && x.status === 'published');
      out.push({ kind: 'profile', from: name, to, status: pr ? 'bound' : 'missing', detail: pr ? `handles data up to ${pr.label}` : `${to} is not a published profile here` });
    }
    for (const name of bundle.references.apps) {
      const to = b.apps[name] ?? name;
      const ok = await s.apps.app(p, to).then(() => true, () => false);
      out.push({ kind: 'app', from: name, to, status: ok ? 'bound' : 'missing', detail: ok ? null : `${to} is not an app you can reach here` });
    }
    for (const ref of bundle.references.vault) out.push({ kind: 'vault', from: ref, to: b.vault[ref] ?? ref, status: 'bound', detail: 'readable by you' });
    // B-131: a decision step binds to the table of that name here (or the one `bindings.decisions` names).
    for (const x of bundle.references.decisions ?? []) {
      const to = b.decisions?.[x.name] ?? x.name;
      const info = await s.decisions.refInfo(p.tenantId, to, x.version ?? undefined);
      const readable = !('missing' in info) && clears(p.clearance, info.label);
      out.push({ kind: 'decision', from: x.name, to, status: readable ? 'bound' : 'missing', detail: 'missing' in info ? `decision table ${to}${x.version ? ` version ${x.version}` : ''} ${info.missing}` : readable ? `version ${info.version}, ${info.label}` : `${to} is above your clearance` });
    }
    const trig = triggerConfigSchema.parse(g.nodes.find((n) => n.kind === 'trigger')?.config ?? {});
    if (trig.source === 'event' || (trig.source === 'schedule' && trig.cron)) out.push({ kind: 'trigger', from: trig.event ?? trig.cron!, to: trig.event ?? trig.cron!, status: 'on publish', detail: 'starts runs once you publish the workflow, as you' });
    // B-130: a webhook trigger arrives switched off with no secret (they live beside the workflow, never in a bundle).
    if (trig.source === 'webhook') out.push({ kind: 'trigger', from: 'webhook', to: 'webhook', status: 'on publish', detail: 'arrives switched off with no secret: make a secret and turn the webhook on after publishing; it then runs as you' });
    return out;
  }

  /** Verifies a bundle, re-binds its references and creates its workflow as a draft in the current workspace. */
  async import(p: Principal, raw: unknown, o: { name?: string; bindings?: Bindings }, ctx: { ip?: string | null; traceId?: string } = {}) {
    const s = this.s();
    // The signature is checked over exactly what arrived, before anything in the bundle is interpreted.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return this.refuse(p, `The bundle is not an ${WORKFLOW_BUNDLE_FORMAT} bundle.`, {}, ctx);
    const { signature, ...body } = raw as Record<string, unknown>;
    if (typeof signature !== 'string' || typeof body.key !== 'string') return this.refuse(p, 'The bundle is not signed.', {}, ctx);
    if (body.key !== this.keyName) return this.refuse(p, 'The bundle was signed with a key this server does not hold.', { key: body.key.slice(0, 100) }, ctx);
    const ok = await s.kms.verifyHmac(this.keyName, canonicalJson(body), signature).catch(() => false);
    const named = typeof (body.workflow as { name?: unknown } | undefined)?.name === 'string' ? String((body.workflow as { name: string }).name).slice(0, 63) : null;
    if (!ok) return this.refuse(p, 'The bundle signature does not verify: it was changed after it was signed, or signed elsewhere.', { workflow: named }, ctx);
    const parsed = workflowBundleSchema.safeParse(raw);
    if (!parsed.success) return this.refuse(p, `The bundle is not an ${WORKFLOW_BUNDLE_FORMAT} bundle: ${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`.trim(), { workflow: named }, ctx);
    return this.instantiate(p, parsed.data, o, ctx);
  }

  /**
   * Creates a verified (or, for a template, trusted) bundle's workflow as a draft in the current workspace with its
   * references re-bound, and reports each binding. 1.8.0 (B-136): templates come through here, with their own audit.
   */
  async instantiate(p: Principal, b: Omit<WorkflowBundle, 'signature' | 'key'>, o: { name?: string; bindings?: Bindings; label?: Label }, ctx: { ip?: string | null; traceId?: string } = {}, audit: { action: string; detail?: Record<string, unknown> } = { action: 'workflow.imported' }) {
    const s = this.s();
    const bindings = bindingsSchema.parse(o.bindings ?? {});
    const graph = rebind(b.graph, bindings);
    const name = o.name ?? b.workflow.name;
    let w;
    try {
      w = await s.workflows.create(p, { name, description: b.workflow.description, label: o.label ?? (b.workflow.label as Label), graph });
    } catch (err) {
      // An unreadable vault reference is a binding to fix, not a broken bundle.
      if (err instanceof HttpProblem && err.status === 403 && /vault|secret|polic/i.test(`${err.detail ?? ''}`)) throw conflict(`The bundle's HTTP steps read vault references you cannot read here; bind each to one you can (bindings.vault): ${err.detail ?? err.title}`);
      throw err;
    }
    const report = await this.report(p, b, graph, bindings);
    await s.audit.append({ tenantId: p.tenantId, action: audit.action, kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { workflow: w.id, name: w.name }, label: w.label, detail: { from: b.workflow.name, version: b.version, exportedAt: b.exportedAt, rebound: report.filter((r) => r.from !== r.to).length, missing: report.filter((r) => r.status === 'missing').map((r) => `${r.kind}:${r.to}`).slice(0, 50), ...(audit.detail ?? {}) }, traceId: ctx.traceId ?? null });
    return { workflow: await s.workflows.view(p, w.id), bindings: report };
  }
}
