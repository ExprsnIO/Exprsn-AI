import { ulid } from 'ulid';
import { json } from '../db/knex.js';
import { clears, labelRank, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { badRequest, conflict, forbidden, notFound } from '../http/problem.js';
import { workspacesFor } from '../http/middleware.js';
import type { Services } from '../services.js';

/*
 * The prompt library (B-304): versioned templates with `{{variables}}`, for a workspace or the whole tenant, each with
 * a label and a lifecycle (draft → published → deprecated → retired). Bodies are sealed with the tenant key. Anyone
 * with chat access sees the published templates of the tenant and of their workspaces, at or below their clearance;
 * holders of `prompts:manage` also see drafts and write them. Filling a template is plain substitution in one pass:
 * values are inserted literally, so a value that itself contains `{{x}}` is not expanded again.
 */

export const PROMPT_STATES = ['draft', 'published', 'deprecated', 'retired'] as const;
export type PromptState = (typeof PROMPT_STATES)[number];

const TRANSITIONS: Record<PromptState, PromptState[]> = {
  draft: ['published', 'retired'],
  published: ['deprecated', 'retired'],
  deprecated: ['published', 'retired'],
  retired: []
};

export const VARIABLE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,40})\s*\}\}/g;

export interface VariableDef {
  name: string;
  description?: string | null;
  default?: string | null;
}

/** The variable names a body uses, in order of first appearance. */
export function variablesOf(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(VARIABLE)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/** Fills a body. Missing values fall back to the variable's default; any still missing are reported together. */
export function fillTemplate(body: string, values: Record<string, string>, defs: VariableDef[] = []): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = body.replace(VARIABLE, (whole, name: string) => {
    const v = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : (defs.find((d) => d.name === name)?.default ?? undefined);
    if (v == null) {
      if (!missing.includes(name)) missing.push(name);
      return whole;
    }
    return v;
  });
  return { text, missing };
}

export interface TemplateRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  name: string;
  description: string | null;
  label: Label;
  state: PromptState;
  version: number;
  published_version: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

interface VersionRow {
  id: string;
  tenant_id: string;
  template_id: string;
  version: number;
  body: string;
  variables: string;
  notes: string | null;
  created_by: string | null;
  created_at: number;
}

const fromRow = (r: Record<string, unknown>): TemplateRow => ({ ...(r as unknown as TemplateRow), version: Number(r.version), published_version: r.published_version == null ? null : Number(r.published_version), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

export class PromptService {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  canManage(p: Principal): boolean {
    return effectivePermissions(p).has('prompts:manage');
  }

  private async workspaceIds(p: Principal): Promise<string[]> {
    return (await workspacesFor(this.s(), p)).map((w) => w.id);
  }

  /** Templates the caller may see: tenant-wide or in their workspaces, within clearance; drafts for managers only. */
  async list(p: Principal, opts: { workspaceId?: string | null; includeRetired?: boolean } = {}): Promise<TemplateRow[]> {
    const ws = await this.workspaceIds(p);
    const q = this.db('prompt_templates').where({ tenant_id: p.tenantId }).andWhere((b) => {
      b.whereNull('workspace_id');
      if (ws.length) b.orWhereIn('workspace_id', ws);
    });
    const rows = ((await q.orderBy('name', 'asc')) as Record<string, unknown>[]).map(fromRow);
    const manage = this.canManage(p);
    return rows.filter(
      (t) =>
        clears(p.clearance, t.label) &&
        (opts.workspaceId === undefined || t.workspace_id === opts.workspaceId || t.workspace_id === null) &&
        (manage ? opts.includeRetired || t.state !== 'retired' : (t.state === 'published' || t.state === 'deprecated') && t.published_version != null)
    );
  }

  async get(p: Principal, id: string): Promise<TemplateRow> {
    const r = await this.db('prompt_templates').where({ tenant_id: p.tenantId, id }).first();
    if (!r) throw notFound('Prompt template');
    const t = fromRow(r);
    if (t.workspace_id && !(await this.workspaceIds(p)).includes(t.workspace_id)) throw notFound('Prompt template');
    if (!clears(p.clearance, t.label)) throw notFound('Prompt template');
    if (!this.canManage(p) && (t.published_version == null || (t.state !== 'published' && t.state !== 'deprecated'))) throw notFound('Prompt template');
    return t;
  }

  private async version(t: TemplateRow, version: number) {
    const v = (await this.db('prompt_versions').where({ template_id: t.id, version }).first()) as VersionRow | undefined;
    if (!v) throw notFound('Prompt version');
    return { version: Number(v.version), body: await this.s().keys.open(t.tenant_id, v.body, `prompt:${v.id}`), variables: json<VariableDef[]>(v.variables, []), notes: v.notes, createdBy: v.created_by, createdAt: Number(v.created_at) };
  }

  async versions(p: Principal, id: string) {
    const t = await this.get(p, id);
    if (!this.canManage(p)) return [await this.version(t, t.published_version!)];
    const rows = (await this.db('prompt_versions').where({ template_id: t.id }).orderBy('version', 'desc').select('version')) as { version: number }[];
    return Promise.all(rows.map((r) => this.version(t, Number(r.version))));
  }

  /** The version a reader uses: the published one; managers may name any version. */
  async body(p: Principal, t: TemplateRow, version?: number) {
    if (version !== undefined && version !== t.published_version && !this.canManage(p)) throw forbidden('Only the published version can be used.', { step: 'role' });
    const v = version ?? t.published_version ?? t.version;
    return this.version(t, v);
  }

  private async assertScope(p: Principal, workspaceId: string | null, label: Label): Promise<void> {
    if (!clears(p.clearance, label)) throw forbidden(`Your clearance is ${p.clearance}; a ${label} template is above it.`, { step: 'clearance' });
    if (!workspaceId) return;
    if (!(await this.workspaceIds(p)).includes(workspaceId)) throw notFound('Workspace');
    const ws = await this.s().tenants.workspace(p.tenantId, workspaceId);
    if (!ws) throw notFound('Workspace');
    if (labelRank(label) > labelRank(ws.label_ceiling)) throw forbidden(`${ws.name}'s ceiling is ${ws.label_ceiling}.`, { step: 'zone' });
  }

  private async assertNameFree(tenantId: string, workspaceId: string | null, name: string, except?: string): Promise<void> {
    const q = this.db('prompt_templates').where({ tenant_id: tenantId, name });
    if (workspaceId) q.andWhere({ workspace_id: workspaceId });
    else q.whereNull('workspace_id');
    if (except) q.andWhereNot({ id: except });
    if (await q.first('id')) throw conflict(`A template named ${name} already exists here.`);
  }

  private checkVariables(body: string, defs: VariableDef[]): VariableDef[] {
    const used = variablesOf(body);
    const unknown = defs.filter((d) => !used.includes(d.name)).map((d) => d.name);
    if (unknown.length) throw badRequest(`Described variables the body does not use: ${unknown.join(', ')}.`);
    return used.map((name) => defs.find((d) => d.name === name) ?? { name });
  }

  async create(p: Principal, input: { name: string; description?: string | null; workspaceId: string | null; label: Label; body: string; variables?: VariableDef[]; notes?: string | null }): Promise<TemplateRow> {
    await this.assertScope(p, input.workspaceId, input.label);
    await this.assertNameFree(p.tenantId, input.workspaceId, input.name);
    const vars = this.checkVariables(input.body, input.variables ?? []);
    const id = ulid();
    const t = Date.now();
    const vid = ulid();
    // Sealed before the transaction: the key lookup must not wait on the connection the transaction holds.
    const sealed = await this.s().keys.seal(p.tenantId, input.body, `prompt:${vid}`);
    await this.db.transaction(async (trx) => {
      await trx('prompt_templates').insert({ id, tenant_id: p.tenantId, workspace_id: input.workspaceId, name: input.name, description: input.description ?? null, label: input.label, state: 'draft', version: 1, published_version: null, created_by: p.userId, created_at: t, updated_at: t });
      await trx('prompt_versions').insert({ id: vid, tenant_id: p.tenantId, template_id: id, version: 1, body: sealed, variables: JSON.stringify(vars), notes: input.notes ?? null, created_by: p.userId, created_at: t });
    });
    return this.get(p, id);
  }

  async update(p: Principal, id: string, patch: { name?: string; description?: string | null; label?: Label }): Promise<{ before: TemplateRow; after: TemplateRow }> {
    const before = await this.get(p, id);
    if (patch.label !== undefined) await this.assertScope(p, before.workspace_id, patch.label);
    if (patch.name !== undefined) await this.assertNameFree(p.tenantId, before.workspace_id, patch.name, id);
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.name !== undefined) upd.name = patch.name;
    if (patch.description !== undefined) upd.description = patch.description;
    if (patch.label !== undefined) upd.label = patch.label;
    await this.db('prompt_templates').where({ id }).update(upd);
    return { before, after: await this.get(p, id) };
  }

  /** A new version of the body. It becomes what chat uses only when it is published. */
  async addVersion(p: Principal, id: string, input: { body: string; variables?: VariableDef[]; notes?: string | null }): Promise<TemplateRow> {
    const t = await this.get(p, id);
    if (t.state === 'retired') throw conflict('A retired template cannot change.');
    const vars = this.checkVariables(input.body, input.variables ?? []);
    const version = t.version + 1;
    const vid = ulid();
    await this.db('prompt_versions').insert({ id: vid, tenant_id: t.tenant_id, template_id: t.id, version, body: await this.s().keys.seal(t.tenant_id, input.body, `prompt:${vid}`), variables: JSON.stringify(vars), notes: input.notes ?? null, created_by: p.userId, created_at: Date.now() });
    await this.db('prompt_templates').where({ id: t.id }).update({ version, updated_at: Date.now() });
    return this.get(p, id);
  }

  async transition(p: Principal, id: string, to: PromptState, version?: number): Promise<{ before: TemplateRow; after: TemplateRow }> {
    const before = await this.get(p, id);
    const publishing = to === 'published';
    if (!(TRANSITIONS[before.state].includes(to) || (publishing && before.state === 'published'))) throw conflict(`A ${before.state} template cannot become ${to}.`);
    const upd: Record<string, unknown> = { state: to, updated_at: Date.now() };
    if (publishing) {
      const v = version ?? before.version;
      if (v < 1 || v > before.version) throw badRequest(`Version ${v} does not exist.`);
      upd.published_version = v;
    }
    await this.db('prompt_templates').where({ id }).update(upd);
    return { before, after: await this.get(p, id) };
  }

  async render(p: Principal, id: string, values: Record<string, string>, version?: number) {
    const t = await this.get(p, id);
    if (t.state === 'retired') throw conflict('This template is retired.');
    const v = await this.body(p, t, version);
    const { text, missing } = fillTemplate(v.body, values, v.variables);
    if (missing.length) throw badRequest(`Fill in: ${missing.join(', ')}.`, { missing });
    return { text, template: { id: t.id, name: t.name, version: v.version, label: t.label, state: t.state } };
  }

  /** Finds a usable template by id or name (the caller's workspace first, then tenant-wide). */
  async find(p: Principal, ref: string): Promise<TemplateRow> {
    const list = await this.list(p);
    const hit = list.find((t) => t.id === ref) ?? list.find((t) => t.name === ref && t.workspace_id === (p.workspaceId ?? null)) ?? list.find((t) => t.name === ref && t.workspace_id === null) ?? list.find((t) => t.name === ref);
    if (!hit) throw notFound('Prompt template');
    return hit;
  }
}

export const templateView = (t: TemplateRow) => ({
  id: t.id,
  name: t.name,
  description: t.description,
  workspaceId: t.workspace_id,
  scope: t.workspace_id ? 'workspace' : 'tenant',
  label: t.label,
  state: t.state,
  version: t.version,
  publishedVersion: t.published_version,
  createdAt: t.created_at,
  updatedAt: t.updated_at
});
