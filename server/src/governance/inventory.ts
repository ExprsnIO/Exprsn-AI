import { ulid } from 'ulid';
import type { Db } from '../db/knex.js';
import { json } from '../db/knex.js';
import type { Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { conflict, notFound } from '../http/problem.js';
import type { AuditLog } from '../audit/chain.js';
import { csvLine } from '../audit/exports.js';

/** The kinds of system the inventory lists (B-7301). */
export const INVENTORY_KINDS = ['model', 'profile', 'agent', 'workflow', 'tool', 'mcp-server', 'dataset'] as const;
export type InventoryKind = (typeof INVENTORY_KINDS)[number];

/** What the register adds to a system beyond what its own record holds. */
export interface InventoryMeta {
  ownerId: string | null;
  ownerName: string | null;
  oversightRole: string | null;
  provenance: string | null;
  lineageNote: string | null;
  knownIssuesNote: string | null;
  impactAssessment: string | null;
  updatedAt: number | null;
}

export interface InventoryItem extends InventoryMeta {
  kind: InventoryKind;
  id: string;
  name: string;
  version: string | null;
  status: string;
  label: Label | null;
  /** Model lineage: the chain from this system down to the model weights it runs on. */
  lineage: { kind: InventoryKind | 'base'; id: string | null; name: string }[];
  /** Linked flags and failed evaluations, counted. */
  issues: { flags: number; failedEvals: number };
  /** Why the entry is incomplete; empty when it is complete. */
  missing: string[];
  complete: boolean;
}

export interface InventoryPatch {
  ownerId?: string | null;
  oversightRole?: string | null;
  provenance?: string | null;
  lineageNote?: string | null;
  knownIssuesNote?: string | null;
  impactAssessment?: string | null;
}

interface MetaRow {
  id: string;
  tenant_id: string;
  kind: InventoryKind;
  ref_id: string;
  owner_id: string | null;
  oversight_role: string | null;
  provenance: string | null;
  lineage: string | null;
  known_issues: string | null;
  impact_assessment: string | null;
  updated_by: string;
  created_at: number;
  updated_at: number;
}

const str = (v: unknown): string | null => (v == null ? null : String(v));

/**
 * B-7301, B-7302: the AI system inventory. One list of every model, profile, agent, workflow, tool, MCP server and
 * dataset of a tenant, each with its accountable owner, oversight role, data provenance, model lineage and known issues
 * (open flags raised in its runs; failed evaluations), from the objects' own records plus `inventory_systems`. A
 * system without an owner is incomplete; an agent that is incomplete cannot be published (the registry asks
 * `assertPublishable` before approving an agent). The register export (CSV or JSON) carries the tenant's impact
 * assessment per system, for ISO/IEC 42001 and EU AI Act deployer records.
 */
export class InventoryService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog
  ) {}

  private async metas(tenantId: string): Promise<Map<string, MetaRow>> {
    const rows = (await this.db('inventory_systems').where({ tenant_id: tenantId })) as MetaRow[];
    return new Map(rows.map((r) => [`${r.kind}:${r.ref_id}`, r]));
  }

  private async names(ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
    const list = [...new Set([...ids].filter((x): x is string => !!x))];
    if (!list.length) return new Map();
    const rows = (await this.db('users').whereIn('id', list).select('id', 'display_name')) as { id: string; display_name: string }[];
    return new Map(rows.map((u) => [u.id, u.display_name]));
  }

  /** Open flags per agent and per workflow, through the runs they were raised in. */
  private async flagCounts(tenantId: string): Promise<{ agents: Map<string, number>; workflows: Map<string, number> }> {
    const open = ['open'];
    const agents = new Map<string, number>();
    const workflows = new Map<string, number>();
    const a = (await this.db('guard_flags as f')
      .join('agent_runs as r', 'r.id', 'f.source_id')
      .where('f.tenant_id', tenantId)
      .andWhere('f.source_kind', 'agent-run')
      .whereIn('f.state', open)
      .groupBy('r.agent_id')
      .select('r.agent_id')
      .count({ n: 'f.id' })) as { agent_id: string; n: number | string }[];
    for (const r of a) agents.set(String(r.agent_id), Number(r.n));
    const w = (await this.db('guard_flags as f')
      .join('workflow_steps as s', 's.id', 'f.source_id')
      .join('workflow_runs as r', 'r.id', 's.run_id')
      .where('f.tenant_id', tenantId)
      .andWhere('f.source_kind', 'workflow-step')
      .whereIn('f.state', open)
      .groupBy('r.workflow_id')
      .select('r.workflow_id')
      .count({ n: 'f.id' })) as { workflow_id: string; n: number | string }[];
    for (const r of w) workflows.set(String(r.workflow_id), Number(r.n));
    return { agents, workflows };
  }

  /** Failed evaluation runs per profile (the latest run of each set). */
  private async failedEvals(tenantId: string): Promise<Map<string, number>> {
    const rows = (await this.db('eval_runs').where({ tenant_id: tenantId, state: 'succeeded' }).orderBy('created_at', 'desc').select('profile_id', 'set_id', 'passed')) as { profile_id: string; set_id: string; passed: number | boolean | null }[];
    const seen = new Set<string>();
    const out = new Map<string, number>();
    for (const r of rows) {
      const k = `${r.profile_id}:${r.set_id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (r.passed === false || r.passed === 0) out.set(r.profile_id, (out.get(r.profile_id) ?? 0) + 1);
    }
    return out;
  }

  async list(tenantId: string): Promise<InventoryItem[]> {
    const [metas, flags, failed] = await Promise.all([this.metas(tenantId), this.flagCounts(tenantId), this.failedEvals(tenantId)]);
    const models = (await this.db('models').whereNot('state', 'retired')) as Record<string, unknown>[];
    const modelById = new Map(models.map((m) => [String(m.id), m]));
    const profiles = (await this.db('profiles').where({ tenant_id: tenantId })) as Record<string, unknown>[];
    const profileByName = new Map(profiles.map((p) => [String(p.name), p]));
    const entries = (await this.db('registry_entries').where({ tenant_id: tenantId }).whereNotIn('status', ['retired'])) as Record<string, unknown>[];
    const workflows = (await this.db('workflows').where({ tenant_id: tenantId })) as Record<string, unknown>[];
    const servers = (await this.db('mcp_servers').where({ tenant_id: tenantId, state: 'active' })) as Record<string, unknown>[];
    const datasets = (await this.db('training_datasets').where({ tenant_id: tenantId })) as Record<string, unknown>[];
    const ownerNames = await this.names([...metas.values()].map((m) => m.owner_id));

    const modelLineage = (m: Record<string, unknown> | undefined): InventoryItem['lineage'] =>
      m ? [{ kind: 'model', id: String(m.id), name: String(m.name) }, { kind: 'base', id: null, name: [m.family, m.parameter_size, m.quantization].filter(Boolean).join(' ') || String(m.source) }] : [];
    const profileLineage = (p: Record<string, unknown> | undefined): InventoryItem['lineage'] => {
      if (!p) return [];
      const alias = p.alias_of ? profiles.find((x) => String(x.id) === String(p.alias_of)) : null;
      const base = alias ?? p;
      return [{ kind: 'profile', id: String(p.id), name: String(p.name) }, ...(alias ? [{ kind: 'profile' as const, id: String(alias.id), name: String(alias.name) }] : []), ...modelLineage(base.model_id ? modelById.get(String(base.model_id)) : undefined)];
    };

    const build = (kind: InventoryKind, id: string, name: string, version: string | null, status: string, label: Label | null, lineage: InventoryItem['lineage'], issues: InventoryItem['issues']): InventoryItem => {
      const meta = metas.get(`${kind}:${id}`);
      const missing: string[] = [];
      if (!meta?.owner_id) missing.push('owner');
      if (!meta?.oversight_role) missing.push('oversight role');
      if (!meta?.provenance) missing.push('data provenance');
      return {
        kind, id, name, version, status, label, lineage, issues, missing, complete: !missing.includes('owner'),
        ownerId: meta?.owner_id ?? null,
        ownerName: meta?.owner_id ? (ownerNames.get(meta.owner_id) ?? null) : null,
        oversightRole: meta?.oversight_role ?? null,
        provenance: meta?.provenance ?? null,
        lineageNote: meta?.lineage ?? null,
        knownIssuesNote: meta?.known_issues ?? null,
        impactAssessment: meta?.impact_assessment ?? null,
        updatedAt: meta ? Number(meta.updated_at) : null
      };
    };

    const out: InventoryItem[] = [];
    for (const m of models) out.push(build('model', String(m.id), String(m.name), null, String(m.state), str(m.label) as Label | null, modelLineage(m), { flags: 0, failedEvals: 0 }));
    for (const p of profiles) out.push(build('profile', String(p.id), String(p.name), String(p.version ?? ''), String(p.status), str(p.label) as Label | null, profileLineage(p), { flags: 0, failedEvals: failed.get(String(p.id)) ?? 0 }));
    for (const e of entries) {
      const def = json<Record<string, unknown>>(e.definition, {});
      const kind: InventoryKind = e.kind === 'agent' ? 'agent' : 'tool';
      const lineage = kind === 'agent' && typeof def.profile === 'string' ? profileLineage(profileByName.get(def.profile)) : [];
      out.push(build(kind, String(e.id), String(e.name), str(e.version), String(e.status), str(e.label) as Label | null, lineage, { flags: kind === 'agent' ? (flags.agents.get(String(e.id)) ?? 0) : 0, failedEvals: 0 }));
    }
    for (const w of workflows) out.push(build('workflow', String(w.id), String(w.name), w.published_version == null ? null : String(w.published_version), w.published_version == null ? 'draft' : 'published', str(w.label) as Label | null, [], { flags: flags.workflows.get(String(w.id)) ?? 0, failedEvals: 0 }));
    for (const s of servers) out.push(build('mcp-server', String(s.id), String(s.name), str(s.protocol_version), String(s.health ?? s.state), null, [], { flags: 0, failedEvals: 0 }));
    for (const d of datasets) out.push(build('dataset', String(d.id), String(d.name), str(d.version), String(d.state), str(d.label) as Label | null, [], { flags: 0, failedEvals: 0 }));
    const order = new Map(INVENTORY_KINDS.map((k, i) => [k, i]));
    return out.sort((a, b) => order.get(a.kind)! - order.get(b.kind)! || a.name.localeCompare(b.name));
  }

  async get(tenantId: string, kind: InventoryKind, id: string): Promise<InventoryItem> {
    const item = (await this.list(tenantId)).find((x) => x.kind === kind && x.id === id);
    if (!item) throw notFound('Inventory system');
    return item;
  }

  async set(p: Principal, kind: InventoryKind, id: string, patch: InventoryPatch, traceId?: string | null): Promise<InventoryItem> {
    const before = await this.get(p.tenantId, kind, id);
    if (patch.ownerId) {
      const owner = await this.db('users').where({ tenant_id: p.tenantId, id: patch.ownerId }).first('id');
      if (!owner) throw conflict('The owner must be a user of this tenant.');
    }
    const t = Date.now();
    const existing = (await this.db('inventory_systems').where({ tenant_id: p.tenantId, kind, ref_id: id }).first()) as MetaRow | undefined;
    const row: Record<string, unknown> = { updated_by: p.userId, updated_at: t };
    if (patch.ownerId !== undefined) row.owner_id = patch.ownerId;
    if (patch.oversightRole !== undefined) row.oversight_role = patch.oversightRole;
    if (patch.provenance !== undefined) row.provenance = patch.provenance;
    if (patch.lineageNote !== undefined) row.lineage = patch.lineageNote;
    if (patch.knownIssuesNote !== undefined) row.known_issues = patch.knownIssuesNote;
    if (patch.impactAssessment !== undefined) row.impact_assessment = patch.impactAssessment;
    if (existing) await this.db('inventory_systems').where({ id: existing.id }).update(row);
    else await this.db('inventory_systems').insert({ id: ulid(), tenant_id: p.tenantId, kind, ref_id: id, owner_id: null, oversight_role: null, provenance: null, lineage: null, known_issues: null, impact_assessment: null, created_at: t, ...row });
    const after = await this.get(p.tenantId, kind, id);
    await this.audit.append({
      tenantId: p.tenantId, action: 'inventory.updated', kind: 'admin', actor: { user: p.userId, username: p.username, name: p.displayName },
      target: { kind, id, name: after.name }, label: after.label ?? 'internal',
      detail: { changed: Object.keys(patch), owner: after.ownerId, oversightRole: after.oversightRole, complete: after.complete, wasComplete: before.complete }, traceId: traceId ?? null
    });
    return after;
  }

  async settings(tenantId: string): Promise<{ requireOwner: boolean; updatedBy: string | null; updatedAt: number | null }> {
    const r = await this.db('inventory_settings').where({ tenant_id: tenantId }).first();
    return { requireOwner: !!r && (r.require_owner === true || r.require_owner === 1), updatedBy: r ? String(r.updated_by) : null, updatedAt: r ? Number(r.updated_at) : null };
  }

  async setSettings(p: Principal, input: { requireOwner: boolean }, traceId?: string | null): Promise<{ requireOwner: boolean; updatedBy: string | null; updatedAt: number | null }> {
    const t = Date.now();
    const existing = await this.db('inventory_settings').where({ tenant_id: p.tenantId }).first();
    if (existing) await this.db('inventory_settings').where({ tenant_id: p.tenantId }).update({ require_owner: input.requireOwner, updated_by: p.userId, updated_at: t });
    else await this.db('inventory_settings').insert({ tenant_id: p.tenantId, require_owner: input.requireOwner, updated_by: p.userId, updated_at: t });
    await this.audit.append({ tenantId: p.tenantId, action: 'inventory.settings.updated', kind: 'admin', actor: { user: p.userId, username: p.username, name: p.displayName }, target: { setting: 'requireOwner' }, detail: { requireOwner: input.requireOwner }, traceId: traceId ?? null });
    return this.settings(p.tenantId);
  }

  /** Refuses to publish an incomplete system (an agent without an owner, B-7301) when the tenant requires owners. */
  async assertPublishable(tenantId: string, kind: InventoryKind, id: string): Promise<void> {
    if (!(await this.settings(tenantId)).requireOwner) return;
    const meta = (await this.db('inventory_systems').where({ tenant_id: tenantId, kind, ref_id: id }).first()) as MetaRow | undefined;
    if (!meta?.owner_id) throw conflict(`This ${kind} has no owner in the AI inventory. Name an owner on the Models screen's Inventory tab before publishing it.`);
  }

  /** The register (B-7302): every system with its lineage and impact assessment, as JSON rows or CSV. */
  async register(tenantId: string, format: 'csv' | 'json'): Promise<{ contentType: string; body: string; rows: number }> {
    const items = await this.list(tenantId);
    const rows = items.map((x) => ({
      kind: x.kind, id: x.id, name: x.name, version: x.version, status: x.status, label: x.label, owner: x.ownerName, ownerId: x.ownerId, oversightRole: x.oversightRole,
      provenance: x.provenance, lineage: x.lineage.map((l) => `${l.kind}:${l.name}`).join(' > '), lineageNote: x.lineageNote,
      openFlags: x.issues.flags, failedEvaluations: x.issues.failedEvals, knownIssues: x.knownIssuesNote, impactAssessment: x.impactAssessment, complete: x.complete, missing: x.missing.join('; ')
    }));
    if (format === 'json') return { contentType: 'application/json; charset=utf-8', body: JSON.stringify({ generatedAt: new Date().toISOString(), systems: rows }, null, 2), rows: rows.length };
    const cols = Object.keys(rows[0] ?? { kind: '', id: '', name: '', version: '', status: '', label: '', owner: '', ownerId: '', oversightRole: '', provenance: '', lineage: '', lineageNote: '', openFlags: '', failedEvaluations: '', knownIssues: '', impactAssessment: '', complete: '', missing: '' });
    return { contentType: 'text/csv; charset=utf-8', body: csvLine(cols) + rows.map((r) => csvLine(cols.map((c) => (r as Record<string, unknown>)[c]))).join(''), rows: rows.length };
  }
}
