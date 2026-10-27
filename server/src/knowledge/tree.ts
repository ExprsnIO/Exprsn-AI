import { actorFrom } from '../audit/chain.js';
import { clears, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { conflict, forbidden, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { referenceSlug } from './revisions.js';
import type { DocRow } from './service.js';

/*
 * 1.8.0, Sprint 48 (B-149): references as a browsable tree, with breadcrumbs and backlinks.
 *
 * - A reference may have a parent reference of the same base (`parent_id`) and a place among its siblings
 *   (`position`). Moving one is for the base's editors and curators, is audited (`knowledge.reference.moved`) and is
 *   refused when the new parent is the reference itself or one of its descendants, so the tree never has a cycle.
 *   Moves within one base are serialised on the base's row (PostgreSQL and MySQL lock it; SQLite has one writer).
 * - Links: when a revision publishes, the reference's Markdown is read for `[[slug]]` (also `[[slug|text]]` and
 *   `[[slug#part]]`) and for Markdown links whose target is a bare slug (`[text](exprsn-ai/overview)`, `./slug`, with
 *   an optional `.md` or `#part`), and `knowledge_reference_links` is rewritten. Backlinks of a reference are the
 *   published references of its base that link to its slug.
 * - Access follows the base: everything here is filtered with the same rule as the references list (the base readable,
 *   the label cleared, unpublished references only for editors and approvers). A parent the reader cannot read is left
 *   out, so its child shows at the top level and the breadcrumbs stop below it; children and backlinks they cannot read
 *   are left out; nothing tells them such pages exist.
 */

export interface TreeRef {
  id: string;
  kb_id: string;
  slug: string;
  title: string;
  label: Label;
  state: string;
  version: string | null;
  parent_id: string | null;
  position: number;
  revision_id: string | null;
  document_id: string | null;
  updated_at: number;
}

const refFrom = (r: Record<string, unknown>): TreeRef => ({ ...(r as unknown as TreeRef), parent_id: (r.parent_id as string | null | undefined) ?? null, position: Number(r.position ?? 0), updated_at: Number(r.updated_at) });

/** The slugs a reference's Markdown links to, in their one spelling (not the reference's own). */
export function linkedSlugs(markdown: string, own?: string): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    try {
      const slug = referenceSlug(raw);
      if (slug !== own) out.add(slug);
    } catch {
      // not a slug
    }
  };
  for (const m of markdown.matchAll(/\[\[([^\]|#\n]{1,200})(?:[|#][^\]\n]{0,300})?\]\]/g)) add(m[1]!);
  for (const m of markdown.matchAll(/\]\(\s*<?([^)\s>]{1,240})>?(?:\s+"[^"\n]*")?\s*\)/g)) {
    let t = m[1]!;
    // URLs, absolute paths, anchors on the same page and mail addresses are not references.
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('/') || t.startsWith('#') || t.includes('@')) continue;
    t = t.replace(/^\.\//, '').replace(/#.*$/, '').replace(/\.md$/i, '');
    if (t && !t.startsWith('..')) add(t);
  }
  return [...out].sort();
}

export class KnowledgeTree {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  /** The references of a base the principal may read, with what they may do there. */
  private async readable(p: Principal, kbId: string) {
    const d = await this.s().knowledgeRevisions.duties(p, kbId);
    const inside = d.edit || d.approve;
    const all = ((await this.db('knowledge_references').where({ tenant_id: p.tenantId, kb_id: kbId })) as Record<string, unknown>[]).map(refFrom);
    const shown = all.filter((r) => clears(p.clearance, r.label) && r.state !== 'retired' && (r.state === 'published' || inside));
    return { d, all, shown, byId: new Map(shown.map((r) => [r.id, r])) };
  }

  private order = (a: TreeRef, b: TreeRef) => a.position - b.position || a.slug.localeCompare(b.slug);

  private node(r: TreeRef, byId: Map<string, TreeRef>) {
    return { id: r.id, slug: r.slug, title: r.title, state: r.state, version: r.version, label: r.label, parentId: r.parent_id && byId.has(r.parent_id) ? r.parent_id : null, position: r.position, updatedAt: r.updated_at };
  }

  /** The base's references as a tree the reader can browse: each node's readable parent, in order. */
  async tree(p: Principal, kbId: string) {
    const { d, shown, byId } = await this.readable(p, kbId);
    const nodes = shown.sort(this.order).map((r) => this.node(r, byId));
    const kids = new Map<string | null, number>();
    for (const n of nodes) kids.set(n.parentId, (kids.get(n.parentId) ?? 0) + 1);
    return { kbId, duties: { manage: d.manage, edit: d.edit, approve: d.approve }, nodes: nodes.map((n) => ({ ...n, children: kids.get(n.id) ?? 0 })) };
  }

  private async refById(p: Principal, id: string): Promise<TreeRef> {
    const r = (await this.db('knowledge_references').where({ tenant_id: p.tenantId, id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Reference');
    return refFrom(r);
  }

  /** A reference's place: breadcrumbs from the top, children, the pages it links to and its backlinks, all readable. */
  async context(p: Principal, id: string) {
    const ref = await this.refById(p, id);
    const { byId, shown } = await this.readable(p, ref.kb_id);
    if (!byId.has(ref.id)) throw notFound('Reference');
    const crumbs: TreeRef[] = [];
    const seen = new Set([ref.id]);
    for (let cur = ref.parent_id ? byId.get(ref.parent_id) : undefined; cur && !seen.has(cur.id); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) {
      seen.add(cur.id);
      crumbs.unshift(cur);
    }
    const children = shown.filter((r) => r.parent_id === ref.id).sort(this.order);
    const bySlug = new Map(shown.map((r) => [r.slug, r]));
    const out = ((await this.db('knowledge_reference_links').where({ tenant_id: p.tenantId, from_reference_id: ref.id }).select('to_slug')) as { to_slug: string }[]).map((x) => bySlug.get(x.to_slug)).filter((x): x is TreeRef => !!x);
    const fromIds = ((await this.db('knowledge_reference_links').where({ tenant_id: p.tenantId, kb_id: ref.kb_id, to_slug: ref.slug }).select('from_reference_id')) as { from_reference_id: string }[]).map((x) => x.from_reference_id);
    const backlinks = fromIds.map((x) => byId.get(x)).filter((x): x is TreeRef => !!x && x.state === 'published' && x.id !== ref.id).sort(this.order);
    const brief = (r: TreeRef) => ({ id: r.id, slug: r.slug, title: r.title, state: r.state, label: r.label });
    return { id: ref.id, slug: ref.slug, kbId: ref.kb_id, parentId: ref.parent_id && byId.has(ref.parent_id) ? ref.parent_id : null, position: ref.position, breadcrumbs: crumbs.map(brief), children: children.map(brief), links: out.map(brief), backlinks: backlinks.map(brief) };
  }

  /**
   * Moves a reference under another of its base (or to the top with `parentId: null`), at `position` among its new
   * siblings (the end when not given). Refuses a cycle, a parent in another base and a parent the mover cannot read.
   */
  async move(p: Principal, id: string, input: { parentId: string | null; position?: number | undefined }, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    const ref = await this.refById(p, id);
    const { d, byId } = await this.readable(p, ref.kb_id);
    if (!byId.has(ref.id)) throw notFound('Reference');
    if (!d.edit) throw forbidden('Moving a reference in the tree needs to be an editor of this knowledge base.', { step: 'role', action: 'knowledge:manage' });
    if (input.parentId === ref.id) throw conflict('A reference cannot be its own parent.');
    if (input.parentId && !byId.has(input.parentId)) throw notFound('Parent reference');
    const sqlite = this.s().cfg.DB_CLIENT === 'sqlite';
    const before = { parentId: ref.parent_id, position: ref.position };
    const after = await this.db.transaction(async (trx) => {
      // One move at a time per base, so two moves cannot make a cycle between them.
      const kbq = trx('knowledge_bases').where({ id: ref.kb_id });
      await (sqlite ? kbq : kbq.forUpdate()).first('id');
      const rows = ((await trx('knowledge_references').where({ tenant_id: p.tenantId, kb_id: ref.kb_id }).select('id', 'parent_id', 'position', 'slug')) as { id: string; parent_id: string | null; position: number | string; slug: string }[]).map((r) => ({ ...r, position: Number(r.position) }));
      const parentOf = new Map(rows.map((r) => [r.id, r.parent_id]));
      if (input.parentId) {
        if (!parentOf.has(input.parentId)) throw notFound('Parent reference');
        const seen = new Set<string>();
        for (let cur: string | null | undefined = input.parentId; cur; cur = parentOf.get(cur)) {
          if (cur === ref.id) throw conflict('That would put the reference under one of its own descendants; the tree cannot have a cycle.');
          if (seen.has(cur)) break;
          seen.add(cur);
        }
      }
      const siblings = rows.filter((r) => r.parent_id === input.parentId && r.id !== ref.id).sort((a, b) => a.position - b.position || a.slug.localeCompare(b.slug));
      const at = input.position === undefined ? siblings.length : Math.max(0, Math.min(input.position, siblings.length));
      const ordered = [...siblings.slice(0, at).map((r) => r.id), ref.id, ...siblings.slice(at).map((r) => r.id)];
      const t = Date.now();
      for (const [i, rid] of ordered.entries()) {
        const cur = rows.find((r) => r.id === rid)!;
        if (rid === ref.id) await trx('knowledge_references').where({ id: rid }).update({ parent_id: input.parentId, position: i, updated_at: t });
        else if (cur.position !== i) await trx('knowledge_references').where({ id: rid }).update({ position: i });
      }
      // The siblings it left keep their order without a gap.
      if (ref.parent_id !== input.parentId) {
        const left = rows.filter((r) => r.parent_id === ref.parent_id && r.id !== ref.id).sort((a, b) => a.position - b.position || a.slug.localeCompare(b.slug));
        for (const [i, r] of left.entries()) if (r.position !== i) await trx('knowledge_references').where({ id: r.id }).update({ position: i });
      }
      return { parentId: input.parentId, position: at };
    });
    await this.s().audit.append({ tenantId: p.tenantId, action: 'knowledge.reference.moved', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { kb: ref.kb_id, reference: ref.id, slug: ref.slug }, label: ref.label, detail: { before, after }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    return this.context(p, ref.id);
  }

  /** Rewrites the links of a reference from its published Markdown. */
  async recordLinks(tenantId: string, ref: Pick<TreeRef, 'id' | 'kb_id' | 'slug' | 'revision_id'>): Promise<string[]> {
    if (!ref.revision_id) return [];
    const r = (await this.db('knowledge_revisions').where({ tenant_id: tenantId, id: ref.revision_id }).first('id', 'tenant_id', 'content')) as { id: string; tenant_id: string; content: string } | undefined;
    if (!r) return [];
    const slugs = linkedSlugs(await this.s().knowledgeRevisions.content(r), ref.slug);
    const t = Date.now();
    await this.db.transaction(async (trx) => {
      await trx('knowledge_reference_links').where({ from_reference_id: ref.id }).delete();
      for (const slug of slugs) await trx('knowledge_reference_links').insert({ tenant_id: tenantId, kb_id: ref.kb_id, from_reference_id: ref.id, to_slug: slug, created_at: t });
    });
    return slugs;
  }

  /** A knowledge document settled: when a reference was just published with it, its links are written again. */
  async docSettled(doc: Pick<DocRow, 'id' | 'tenant_id' | 'state'>): Promise<void> {
    if (doc.state !== 'indexed' && doc.state !== 'unchanged') return;
    const r = (await this.db('knowledge_references').where({ tenant_id: doc.tenant_id, document_id: doc.id, state: 'published' }).first()) as Record<string, unknown> | undefined;
    if (!r) return;
    await this.recordLinks(doc.tenant_id, refFrom(r));
  }
}
