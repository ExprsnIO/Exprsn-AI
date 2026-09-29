import { ulid } from 'ulid';
import { json, type Db } from '../db/knex.js';
import { clears, labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { conflict, forbidden, notFound } from '../http/problem.js';
import { runChecks, type CheckResult } from './checks.js';
import { schemaHash, type JsonSchema } from './schema.js';

export const ENTRY_KINDS = ['tool', 'skill', 'agent'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export const ENTRY_STATUSES = ['draft', 'in_review', 'published', 'deprecated', 'retired'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];
export const SIDE_EFFECTS = ['read', 'write', 'destructive'] as const;
export type SideEffect = (typeof SIDE_EFFECTS)[number];
export type EntryImpl = 'builtin' | 'mcp' | 'script' | 'archive' | 'agent';

/** Upper limits an agent definition may ask for; a run can be raised up to these, never beyond. */
export const MAX_BUDGETS = { steps: 100, tokens: 200_000, wallSeconds: 3600, toolCalls: 100 } as const;

export interface AgentBudgets {
  steps: number;
  tokens: number;
  wallSeconds: number;
  toolCalls: number;
}

export interface AgentDefinition {
  profile: string;
  systemPrompt?: string | null;
  tools: string[];
  skills?: string[];
  budgets: AgentBudgets;
}

export interface EntryRow {
  id: string;
  tenant_id: string | null;
  workspace_id: string | null;
  kind: EntryKind;
  name: string;
  version: string;
  description: string | null;
  impl: EntryImpl;
  side_effect: SideEffect | null;
  confirm: 'always' | 'never';
  rate_per_hour: number | null;
  label: Label;
  input_schema: JsonSchema | null;
  output_schema: JsonSchema | null;
  definition: Record<string, unknown>;
  status: EntryStatus;
  schema_hash: string;
  approved_hash: string | null;
  checks: CheckResult[];
  checked_at: number | null;
  owner_id: string | null;
  owner_name: string | null;
  submitted_at: number | null;
  reviewed_by: string | null;
  reviewed_at: number | null;
  review_note: string | null;
  publish_scope: 'tenant' | 'workspace' | 'platform' | null;
  publish_workspaces: string[];
  replacement: string | null;
  created_at: number;
  updated_at: number;
}

const fromRow = (r: Record<string, unknown>): EntryRow => ({
  ...(r as unknown as EntryRow),
  rate_per_hour: r.rate_per_hour == null ? null : Number(r.rate_per_hour),
  input_schema: json<JsonSchema | null>(r.input_schema, null),
  output_schema: json<JsonSchema | null>(r.output_schema, null),
  definition: json<Record<string, unknown>>(r.definition, {}),
  checks: json<CheckResult[]>(r.checks, []),
  publish_workspaces: json<string[]>(r.publish_workspaces, []),
  checked_at: r.checked_at == null ? null : Number(r.checked_at),
  submitted_at: r.submitted_at == null ? null : Number(r.submitted_at),
  reviewed_at: r.reviewed_at == null ? null : Number(r.reviewed_at),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

const toRow = (e: Partial<EntryRow>): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...e };
  for (const k of ['input_schema', 'output_schema', 'definition', 'checks', 'publish_workspaces'] as const) if (k in e) out[k] = e[k] == null ? null : JSON.stringify(e[k]);
  return out;
};

export const entryView = (e: EntryRow, names: Map<string, string> = new Map()) => ({
  id: e.id,
  kind: e.kind,
  name: e.name,
  version: e.version,
  description: e.description,
  impl: e.impl,
  sideEffect: e.side_effect,
  confirm: e.confirm,
  ratePerHour: e.rate_per_hour,
  label: e.label,
  inputSchema: e.input_schema,
  outputSchema: e.output_schema,
  definition: e.definition,
  status: e.status,
  schemaHash: e.schema_hash,
  approvedHash: e.approved_hash,
  checks: e.checks,
  checksPassed: e.checks.length > 0 && e.checks.every((c) => c.ok),
  checkedAt: e.checked_at,
  platform: e.tenant_id === null,
  owner: e.owner_name,
  ownerId: e.owner_id,
  submittedAt: e.submitted_at,
  reviewedBy: e.reviewed_by ? (names.get(e.reviewed_by) ?? e.reviewed_by) : null,
  reviewedAt: e.reviewed_at,
  reviewNote: e.review_note,
  publishScope: e.publish_scope,
  publishWorkspaces: e.publish_workspaces,
  replacement: e.replacement,
  createdAt: e.created_at,
  updatedAt: e.updated_at
});

export interface EntryInput {
  kind: EntryKind;
  name: string;
  version: string;
  description: string | null;
  impl: EntryImpl;
  sideEffect: SideEffect | null;
  confirm?: 'always' | 'never';
  ratePerHour?: number | null;
  label: Label;
  inputSchema: JsonSchema | null;
  outputSchema: JsonSchema | null;
  definition: Record<string, unknown>;
}

const hashOf = (e: Pick<EntryRow, 'name' | 'description' | 'input_schema' | 'output_schema' | 'side_effect' | 'definition'>) =>
  schemaHash({ name: e.name, description: e.description, inputSchema: e.input_schema, outputSchema: e.output_schema, sideEffect: e.side_effect, annotations: e.definition });

/** Names of the tools an agent or skill uses, from its definition. */
export const referencedTools = (e: Pick<EntryRow, 'kind' | 'definition'>): string[] => (e.kind === 'tool' ? [] : Array.isArray(e.definition.tools) ? (e.definition.tools as unknown[]).map(String) : []);

/**
 * The registry: tools, skills and agents with the lifecycle draft → in review → published → deprecated → retired.
 * Each version is its own row. Submission runs the automated checks; a tool admin other than the author reviews
 * and chooses the publish scope (the tenant, or named workspaces). Approval records the schema hash; an entry whose
 * hash no longer matches is not callable. Platform entries (no tenant) such as the built-in calculate tool are
 * published to everyone and read-only here.
 */
export class RegistryService {
  constructor(private readonly db: Db) {}

  async get(tenantId: string, id: string): Promise<EntryRow | undefined> {
    const r = await this.db('registry_entries').where({ id }).andWhere((q) => q.where({ tenant_id: tenantId }).orWhereNull('tenant_id')).first();
    return r ? fromRow(r) : undefined;
  }

  async mustGet(tenantId: string, id: string): Promise<EntryRow> {
    const e = await this.get(tenantId, id);
    if (!e) throw notFound('Registry entry');
    return e;
  }

  /** Every entry of the tenant plus platform entries, newest first. */
  async list(tenantId: string, opts: { kind?: EntryKind; status?: EntryStatus } = {}): Promise<EntryRow[]> {
    const q = this.db('registry_entries').where((w) => w.where({ tenant_id: tenantId }).orWhereNull('tenant_id'));
    if (opts.kind) q.andWhere({ kind: opts.kind });
    if (opts.status) q.andWhere({ status: opts.status });
    return (await q.orderBy([{ column: 'name' }, { column: 'created_at', order: 'desc' }])).map(fromRow);
  }

  async versions(e: EntryRow): Promise<EntryRow[]> {
    const q = this.db('registry_entries').where({ kind: e.kind, name: e.name });
    if (e.tenant_id) q.andWhere({ tenant_id: e.tenant_id });
    else q.whereNull('tenant_id');
    return (await q.orderBy('created_at', 'desc')).map(fromRow);
  }

  /**
   * Is the entry published to the principal's current workspace? An entry's label is a ceiling (the highest data it
   * may receive), not a classification of the entry, so it limits calls rather than who sees the entry.
   */
  visibleTo(e: EntryRow, p: Principal): boolean {
    if (e.tenant_id === null) return true;
    if (e.tenant_id !== p.tenantId) return false;
    if (e.publish_scope === 'tenant') return true;
    return e.publish_scope === 'workspace' && !!p.workspaceId && e.publish_workspaces.includes(p.workspaceId);
  }

  /**
   * The callable version of a name for the principal: published (or deprecated, still callable with a warning),
   * visible to them, the newest first. Retired and unreviewed entries are never returned.
   */
  async resolve(p: Principal, name: string, kind: EntryKind = 'tool'): Promise<EntryRow | undefined> {
    const rows = (await this.db('registry_entries')
      .where({ kind, name })
      .whereIn('status', ['published', 'deprecated'])
      .andWhere((q) => q.where({ tenant_id: p.tenantId }).orWhereNull('tenant_id'))
      .orderBy('created_at', 'desc')).map(fromRow);
    const visible = rows.filter((e) => this.visibleTo(e, p) && e.approved_hash === e.schema_hash);
    return visible.find((e) => e.status === 'published') ?? visible[0];
  }

  /** The newest status of each referenced tool name in the tenant (for the agent and skill checks). */
  async referenceStatus(tenantId: string, names: string[]): Promise<{ name: string; status: string | null }[]> {
    if (!names.length) return [];
    const rows = (await this.db('registry_entries').where({ kind: 'tool' }).whereIn('name', names).andWhere((q) => q.where({ tenant_id: tenantId }).orWhereNull('tenant_id')).select('name', 'status', 'created_at')) as { name: string; status: string; created_at: number }[];
    return names.map((n) => {
      const mine = rows.filter((r) => r.name === n);
      return { name: n, status: mine.find((r) => r.status === 'published')?.status ?? mine.sort((a, b) => Number(b.created_at) - Number(a.created_at))[0]?.status ?? null };
    });
  }

  async checks(e: EntryRow): Promise<CheckResult[]> {
    const refs = referencedTools(e);
    return runChecks({
      kind: e.kind,
      name: e.name,
      version: e.version,
      description: e.description,
      sideEffect: e.side_effect,
      inputSchema: e.input_schema,
      outputSchema: e.output_schema,
      definition: e.definition,
      ...(e.kind !== 'tool' ? { references: await this.referenceStatus(e.tenant_id ?? '', refs) } : {}),
      ...(e.kind === 'agent' ? { maxBudgets: MAX_BUDGETS } : {})
    });
  }

  async create(p: Principal, input: EntryInput, ownerName?: string): Promise<EntryRow> {
    if (!clears(p.clearance, input.label)) throw forbidden(`You cannot set a ceiling above your clearance (${p.clearance}).`, { step: 'clearance' });
    const dup = await this.db('registry_entries').where({ tenant_id: p.tenantId, kind: input.kind, name: input.name, version: input.version }).first('id');
    if (dup) throw conflict(`${input.name} ${input.version} is already in the registry; submit a new version.`);
    const t = Date.now();
    const row: EntryRow = {
      id: ulid(),
      tenant_id: p.tenantId,
      workspace_id: p.workspaceId ?? null,
      kind: input.kind,
      name: input.name,
      version: input.version,
      description: input.description,
      impl: input.impl,
      side_effect: input.kind === 'tool' ? input.sideEffect : null,
      confirm: input.confirm ?? (input.sideEffect && input.sideEffect !== 'read' ? 'always' : 'never'),
      rate_per_hour: input.ratePerHour ?? null,
      label: input.label,
      input_schema: input.inputSchema,
      output_schema: input.outputSchema,
      definition: input.definition,
      status: 'draft',
      schema_hash: '',
      approved_hash: null,
      checks: [],
      checked_at: null,
      owner_id: p.userId,
      owner_name: ownerName ?? p.displayName,
      submitted_at: null,
      reviewed_by: null,
      reviewed_at: null,
      review_note: null,
      publish_scope: null,
      publish_workspaces: [],
      replacement: null,
      created_at: t,
      updated_at: t
    };
    row.schema_hash = hashOf(row);
    row.checks = await this.checks(row);
    row.checked_at = t;
    await this.db('registry_entries').insert(toRow(row));
    return row;
  }

  /** Drafts are editable; anything else is a new version. */
  async update(p: Principal, e: EntryRow, patch: Partial<Omit<EntryInput, 'kind' | 'name' | 'version' | 'impl'>>): Promise<EntryRow> {
    if (e.tenant_id === null) throw forbidden('Platform entries are read-only.', { step: 'tenant' });
    if (e.status !== 'draft') throw conflict(`Only drafts can be edited; ${e.name} ${e.version} is ${e.status.replace('_', ' ')}. Create a new version.`);
    if (patch.label && !clears(p.clearance, patch.label)) throw forbidden('You cannot set a ceiling above your clearance.', { step: 'clearance' });
    const next: EntryRow = {
      ...e,
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.sideEffect !== undefined && e.kind === 'tool' ? { side_effect: patch.sideEffect } : {}),
      ...(patch.confirm !== undefined ? { confirm: patch.confirm } : {}),
      ...(patch.ratePerHour !== undefined ? { rate_per_hour: patch.ratePerHour } : {}),
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.inputSchema !== undefined ? { input_schema: patch.inputSchema } : {}),
      ...(patch.outputSchema !== undefined ? { output_schema: patch.outputSchema } : {}),
      ...(patch.definition !== undefined ? { definition: patch.definition } : {}),
      updated_at: Date.now()
    };
    next.schema_hash = hashOf(next);
    next.checks = await this.checks(next);
    next.checked_at = Date.now();
    await this.save(next);
    return next;
  }

  private async save(e: EntryRow): Promise<void> {
    const { id, ...rest } = e;
    await this.db('registry_entries').where({ id }).update(toRow(rest));
  }

  async recheck(e: EntryRow): Promise<EntryRow> {
    if (e.tenant_id === null) return e;
    const next = { ...e, checks: await this.checks(e), checked_at: Date.now(), updated_at: Date.now() };
    await this.save(next);
    return next;
  }

  async submit(e: EntryRow): Promise<EntryRow> {
    if (e.status !== 'draft') throw conflict(`${e.name} ${e.version} is ${e.status.replace('_', ' ')}, not a draft.`);
    const next: EntryRow = { ...e, status: 'in_review', checks: await this.checks(e), checked_at: Date.now(), submitted_at: Date.now(), review_note: null, updated_at: Date.now() };
    await this.save(next);
    return next;
  }

  /**
   * Approval by a tool admin who is not the author, once every check passes; it records the schema hash and the
   * publish scope. Rejection returns the entry to draft with the reason for the owner.
   */
  async review(p: Principal, e: EntryRow, input: { decision: 'approve' | 'reject'; note?: string | null; scope?: 'tenant' | 'workspace'; workspaces?: string[] }): Promise<EntryRow> {
    if (e.status !== 'in_review') throw conflict(`${e.name} ${e.version} is not in review.`);
    if (e.owner_id === p.userId) throw forbidden('Dual control: someone other than the author must review.', { step: 'dual-control' });
    if (!clears(p.clearance, e.label)) throw forbidden(`Reviewing an entry with ceiling ${e.label} needs that clearance.`, { step: 'clearance' });
    const t = Date.now();
    if (input.decision === 'reject') {
      const next: EntryRow = { ...e, status: 'draft', reviewed_by: p.userId, reviewed_at: t, review_note: input.note ?? null, updated_at: t };
      await this.save(next);
      return next;
    }
    const checks = await this.checks(e);
    if (!checks.every((c) => c.ok)) {
      await this.save({ ...e, checks, checked_at: t });
      throw conflict(`Approve stays disabled until the checks pass: ${checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}.`);
    }
    const scope = await this.checkScope(e, input.scope ?? 'tenant', input.workspaces ?? []);
    const next: EntryRow = { ...e, status: 'published', checks, checked_at: t, approved_hash: e.schema_hash, reviewed_by: p.userId, reviewed_at: t, review_note: input.note ?? null, publish_scope: scope.scope, publish_workspaces: scope.workspaces, updated_at: t };
    await this.save(next);
    return next;
  }

  /** A workspace scope names workspaces of the tenant whose ceiling is at least the entry's label. */
  private async checkScope(e: EntryRow, scope: 'tenant' | 'workspace', workspaces: string[]) {
    if (scope === 'tenant') return { scope, workspaces: [] as string[] };
    if (!workspaces.length) throw conflict('Choose at least one workspace.');
    const rows = (await this.db('workspaces').where({ tenant_id: e.tenant_id }).whereIn('id', workspaces).select('id', 'name', 'label_ceiling')) as { id: string; name: string; label_ceiling: Label }[];
    if (rows.length !== new Set(workspaces).size) throw notFound('Workspace');
    const low = rows.filter((w) => labelRank(w.label_ceiling) < labelRank(e.label));
    if (low.length) throw conflict(`${low.map((w) => w.name).join(', ')} ${low.length === 1 ? 'has a ceiling' : 'have ceilings'} below this entry's max label (${e.label}).`);
    return { scope, workspaces: [...new Set(workspaces)] };
  }

  async publishTo(e: EntryRow, scope: 'tenant' | 'workspace', workspaces: string[]): Promise<EntryRow> {
    if (e.tenant_id === null) throw forbidden('Platform entries are published to every tenant.', { step: 'tenant' });
    if (e.status !== 'published' && e.status !== 'deprecated') throw conflict('Only published entries change scope.');
    const s = await this.checkScope(e, scope, workspaces);
    const next = { ...e, publish_scope: s.scope, publish_workspaces: s.workspaces, updated_at: Date.now() };
    await this.save(next);
    return next;
  }

  /** Agents (and skills) in the tenant that still reference a tool name, for the retire warning. */
  async referencedBy(tenantId: string, name: string): Promise<{ id: string; kind: EntryKind; name: string; version: string }[]> {
    const rows = (await this.db('registry_entries').where({ tenant_id: tenantId }).whereIn('kind', ['agent', 'skill']).whereNot({ status: 'retired' })).map(fromRow);
    return rows.filter((r) => referencedTools(r).includes(name)).map((r) => ({ id: r.id, kind: r.kind, name: r.name, version: r.version }));
  }

  async lifecycle(e: EntryRow, to: 'deprecated' | 'retired' | 'published', opts: { replacement?: string | null } = {}): Promise<EntryRow> {
    if (e.tenant_id === null) throw forbidden('Platform entries are read-only.', { step: 'tenant' });
    const from = e.status;
    if (to === 'deprecated' && from !== 'published') throw conflict('Only published entries can be deprecated.');
    if (to === 'retired' && from !== 'deprecated' && from !== 'draft') throw conflict('Deprecate the entry before retiring it.');
    if (to === 'published' && from !== 'deprecated') throw conflict('Only deprecated entries can be restored.');
    if (to === 'published' && e.approved_hash !== e.schema_hash) throw conflict('The schema changed since approval; submit a new version.');
    const next: EntryRow = { ...e, status: to, ...(to === 'deprecated' ? { replacement: opts.replacement ?? null } : {}), ...(to === 'published' ? { replacement: null } : {}), updated_at: Date.now() };
    await this.save(next);
    return next;
  }

  /** A new draft version copied from an existing one. */
  async newVersion(p: Principal, e: EntryRow, version: string): Promise<EntryRow> {
    if (e.tenant_id === null) throw forbidden('Platform entries are read-only.', { step: 'tenant' });
    return this.create(p, { kind: e.kind, name: e.name, version, description: e.description, impl: e.impl, sideEffect: e.side_effect, confirm: e.confirm, ratePerHour: e.rate_per_hour, label: e.label, inputSchema: e.input_schema, outputSchema: e.output_schema, definition: e.definition });
  }

  /**
   * The registry face of an approved MCP tool: published at approval by the tool admin who approved it (the MCP
   * screen is its review), with the tool's hash. A changed or revoked tool keeps its entry; the MCP tool's own state
   * gates calls.
   */
  async upsertMcpEntry(p: Principal, input: { serverId: string; serverName: string; tool: string; description: string | null; inputSchema: JsonSchema | null; sideEffect: SideEffect; confirm: 'always' | 'never'; label: Label; hash: string }): Promise<EntryRow> {
    const name = `${input.serverName}.${input.tool}`;
    const t = Date.now();
    const existing = (await this.db('registry_entries').where({ tenant_id: p.tenantId, kind: 'tool', name, impl: 'mcp' }).orderBy('created_at', 'desc').first()) as Record<string, unknown> | undefined;
    const base = { description: input.description, side_effect: input.sideEffect, confirm: input.confirm, label: input.label, input_schema: input.inputSchema, definition: { serverId: input.serverId, tool: input.tool }, status: 'published' as const, schema_hash: input.hash, approved_hash: input.hash, reviewed_by: p.userId, reviewed_at: t, updated_at: t };
    if (existing) {
      const e = fromRow(existing);
      const next = { ...e, ...base, checks: [] as CheckResult[] };
      next.checks = await this.checks(next);
      next.checked_at = t;
      await this.save(next);
      return next;
    }
    const row: EntryRow = {
      id: ulid(),
      tenant_id: p.tenantId,
      workspace_id: null,
      kind: 'tool',
      name,
      version: '1.0.0',
      impl: 'mcp',
      rate_per_hour: null,
      output_schema: null,
      checks: [],
      checked_at: t,
      owner_id: null,
      owner_name: `MCP server ${input.serverName}`,
      submitted_at: t,
      review_note: 'Approved on the MCP servers screen.',
      publish_scope: 'tenant',
      publish_workspaces: [],
      replacement: null,
      created_at: t,
      ...base
    };
    row.checks = await this.checks(row);
    await this.db('registry_entries').insert(toRow(row));
    return row;
  }

  /** Entries backed by an MCP server, for deregistration. */
  async mcpEntries(tenantId: string, serverId: string): Promise<EntryRow[]> {
    return (await this.db('registry_entries').where({ tenant_id: tenantId, impl: 'mcp' })).map(fromRow).filter((e) => e.definition.serverId === serverId);
  }

  async setStatus(e: EntryRow, status: EntryStatus, extra: Partial<EntryRow> = {}): Promise<void> {
    await this.save({ ...e, ...extra, status, updated_at: Date.now() });
  }
}
