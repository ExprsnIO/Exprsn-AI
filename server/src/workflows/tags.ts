import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { clears } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import type { Services } from '../services.js';

/*
 * 1.8.0, Sprint 47 (B-137): workflow tags and favourites (migration 097_designer_editing).
 *
 * - Tags are the tenant's: any workflow admin may put up to ten on a workflow they can open, and the list filters by
 *   them. The vocabulary offered is the distinct tags of the workflows the caller may see (their workspace and
 *   clearance), so a tag that only a confidential workflow carries is not offered to someone below that.
 * - Favourites are per person: a star on a workflow they can open, read by nobody else.
 * Both are dropped with their workflow (`forget`).
 */

export const TAG = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Tags are lower-case letters, digits and hyphens, up to 40');
export const MAX_TAGS = 10;
export const tagsSchema = z.array(TAG).max(MAX_TAGS);

export interface Ctx {
  p: Principal;
  ip: string | null;
  traceId?: string | null;
}

export class WorkflowTags {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  async tagsOf(workflowIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (let i = 0; i < workflowIds.length; i += 500) {
      const rows = (await this.db('workflow_tags').whereIn('workflow_id', workflowIds.slice(i, i + 500)).orderBy('tag').select('workflow_id', 'tag')) as { workflow_id: string; tag: string }[];
      for (const r of rows) out.set(r.workflow_id, [...(out.get(r.workflow_id) ?? []), r.tag]);
    }
    return out;
  }

  async favouritesOf(p: Principal): Promise<Set<string>> {
    const rows = (await this.db('workflow_favourites').where({ tenant_id: p.tenantId, user_id: p.userId }).select('workflow_id')) as { workflow_id: string }[];
    return new Set(rows.map((r) => r.workflow_id));
  }

  /** The list rows with their tags and the caller's star, optionally only those with a tag or only the starred. */
  async decorate<T extends { id: string }>(p: Principal, rows: T[], filter: { tag?: string | undefined; favourites?: boolean | undefined } = {}): Promise<(T & { tags: string[]; favourite: boolean })[]> {
    const tags = await this.tagsOf(rows.map((r) => r.id));
    const fav = await this.favouritesOf(p);
    return rows
      .map((r) => ({ ...r, tags: tags.get(r.id) ?? [], favourite: fav.has(r.id) }))
      .filter((r) => (!filter.tag || r.tags.includes(filter.tag)) && (!filter.favourites || r.favourite));
  }

  /** The tags in use on the workflows the caller may see, with how many carry each. */
  async vocabulary(p: Principal): Promise<{ tag: string; count: number }[]> {
    const visible = (await this.s().workflows.list(p)).filter((w) => clears(p.clearance, w.label)).map((w) => w.id);
    const counts = new Map<string, number>();
    for (const list of (await this.tagsOf(visible)).values()) for (const t of list) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count }));
  }

  /** Replaces the workflow's tags; audited `workflow.tags.updated` with what was added and removed. */
  async setTags(ctx: Ctx, workflowId: string, tags: string[]): Promise<string[]> {
    const w = await this.s().workflows.workflow(ctx.p, workflowId);
    const next = [...new Set(tags)].sort();
    const before = (await this.tagsOf([w.id])).get(w.id) ?? [];
    const added = next.filter((t) => !before.includes(t));
    const removed = before.filter((t) => !next.includes(t));
    if (!added.length && !removed.length) return before;
    await this.db.transaction(async (trx) => {
      if (removed.length) await trx('workflow_tags').where({ workflow_id: w.id }).whereIn('tag', removed).delete();
      const t = Date.now();
      if (added.length) await trx('workflow_tags').insert(added.map((tag) => ({ tenant_id: w.tenant_id, workflow_id: w.id, tag, created_by: ctx.p.userId, created_at: t })));
    });
    await this.s().audit.append({ tenantId: w.tenant_id, action: 'workflow.tags.updated', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { workflow: w.id, name: w.name }, label: w.label, detail: { added, removed, tags: next }, traceId: ctx.traceId ?? null });
    return next;
  }

  /** Stars or unstars the workflow for the caller; audited `workflow.favourite.added` / `.removed` when it changes. */
  async setFavourite(ctx: Ctx, workflowId: string, on: boolean): Promise<boolean> {
    const w = await this.s().workflows.workflow(ctx.p, workflowId);
    const where = { user_id: ctx.p.userId, workflow_id: w.id };
    const had = !!(await this.db('workflow_favourites').where(where).first('workflow_id'));
    if (had === on) return on;
    if (on) {
      try {
        await this.db('workflow_favourites').insert({ ...where, tenant_id: w.tenant_id, created_at: Date.now() });
      } catch {
        return true; // starred at the same moment in another tab
      }
    } else await this.db('workflow_favourites').where(where).delete();
    await this.s().audit.append({ tenantId: w.tenant_id, action: on ? 'workflow.favourite.added' : 'workflow.favourite.removed', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { workflow: w.id, name: w.name }, label: w.label, traceId: ctx.traceId ?? null });
    return on;
  }

  /** The workflow is gone: its tags and everyone's stars on it go too. */
  async forget(workflowId: string): Promise<void> {
    await this.db('workflow_tags').where({ workflow_id: workflowId }).delete();
    await this.db('workflow_favourites').where({ workflow_id: workflowId }).delete();
  }
}
