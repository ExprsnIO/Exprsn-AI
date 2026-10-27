import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import { clears, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { conflict, notFound } from '../http/problem.js';
import { referenceSlug, type RevisionRow } from '../knowledge/revisions.js';
import type { KbRow } from '../knowledge/service.js';
import type { Services } from '../services.js';
import { renderMarkdown, renderSections } from './render.js';

/*
 * 2.0.x: the Docs portal. A documentation site is a reading view over knowledge bases:
 *
 * - Its pages are the bases' references (curated Markdown with slugs, versions and a tree, `knowledge/revisions.ts`,
 *   `knowledge/tree.ts`); with `library` on, the bases' other documents show as a Library grouped by category.
 * - Who reads what is the knowledge bases' decision, asked through the knowledge services every time: a base the
 *   reader cannot see is left out of the site (a site with none is not listed), references follow their label and
 *   publication state, documents their label and row access. The site row holds no content and grants nothing.
 * - Pages are rendered on the server (`render.ts`) to escaped HTML, with internal links resolved within the site.
 * - Curating sites needs `docs:manage` (knowledge curators) and read access to each base it names; audited `docs.site.*`.
 */

export interface SiteRow {
  id: string;
  tenant_id: string;
  slug: string;
  title: string;
  description: string | null;
  kb_ids: string[];
  home_kb_id: string | null;
  home_slug: string | null;
  library: boolean;
  version: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const siteFrom = (r: Record<string, unknown>): SiteRow => ({ ...(r as unknown as SiteRow), kb_ids: json<string[]>(r.kb_ids, []), library: !!r.library, version: Number(r.version), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

interface RefRow {
  id: string;
  kb_id: string;
  slug: string;
  title: string;
  label: Label;
  state: string;
  version: string | null;
  revision_id: string | null;
  document_id: string | null;
  parent_id: string | null;
  position: number;
  updated_at: number;
}

export interface SiteInput {
  slug: string;
  title: string;
  description?: string | null | undefined;
  kbIds: string[];
  home?: { kbId: string; slug: string } | null | undefined;
  library?: boolean | undefined;
}

export const SITE_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class DocsService {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private audit(p: Principal, action: string, site: SiteRow, detail: Record<string, unknown>, ctx: { ip?: string | null; traceId?: string | null }) {
    return this.s().audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { docSite: site.id, slug: site.slug }, label: 'internal', detail, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
  }

  /** The bases of a site the principal can read, in the site's order. */
  private async bases(p: Principal, site: SiteRow): Promise<{ kb: KbRow; access: 'read' | 'manage' }[]> {
    const visible = new Map((await this.s().knowledge.visible(p)).map((v) => [v.kb.id, v]));
    return site.kb_ids.map((id) => visible.get(id)).filter((v): v is { kb: KbRow; access: 'read' | 'manage' } => !!v && clears(p.clearance, v.kb.label as Label));
  }

  private async row(tenantId: string, idOrSlug: string): Promise<SiteRow> {
    const r = (await this.db('doc_sites').where({ tenant_id: tenantId }).andWhere((q) => q.where({ id: idOrSlug }).orWhere({ slug: idOrSlug })).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Documentation site');
    return siteFrom(r);
  }

  /** A site the principal can read (at least one of its bases), or 404 without saying whether it exists. */
  private async readable(p: Principal, idOrSlug: string) {
    const site = await this.row(p.tenantId, idOrSlug).catch(() => null);
    if (!site) throw notFound('Documentation site');
    const bases = await this.bases(p, site);
    if (!bases.length) throw notFound('Documentation site');
    return { site, bases };
  }

  private view(site: SiteRow, bases: { kb: KbRow }[], canManage: boolean) {
    return {
      id: site.id,
      slug: site.slug,
      title: site.title,
      description: site.description,
      bases: bases.map((b) => ({ id: b.kb.id, name: b.kb.name, label: b.kb.label })),
      home: site.home_kb_id && site.home_slug && bases.some((b) => b.kb.id === site.home_kb_id) ? { kbId: site.home_kb_id, slug: site.home_slug } : null,
      library: site.library,
      version: site.version,
      updatedAt: site.updated_at,
      canManage
    };
  }

  private canManage(p: Principal): boolean {
    return authorize(p, 'docs:manage').allow;
  }

  /** The sites with at least one base the principal can read. */
  async sites(p: Principal) {
    const rows = ((await this.db('doc_sites').where({ tenant_id: p.tenantId }).orderBy('title')) as Record<string, unknown>[]).map(siteFrom);
    const out = [];
    const manage = this.canManage(p);
    for (const site of rows) {
      const bases = await this.bases(p, site);
      if (bases.length) out.push(this.view(site, bases, manage));
      else if (manage && !site.kb_ids.length) out.push(this.view(site, [], manage));
    }
    return out;
  }

  /** Checks a site's bases and home page against what the curator can read. */
  private async checkInput(p: Principal, input: { kbIds: string[]; home?: { kbId: string; slug: string } | null | undefined }) {
    if (new Set(input.kbIds).size !== input.kbIds.length) throw conflict('A knowledge base is listed twice.');
    const visible = new Set((await this.s().knowledge.visible(p)).map((v) => v.kb.id));
    const unknown = input.kbIds.filter((id) => !visible.has(id));
    if (unknown.length) throw notFound(`Knowledge base ${unknown[0]}`);
    if (input.home) {
      if (!input.kbIds.includes(input.home.kbId)) throw conflict('The home page must be a page of one of the site\'s knowledge bases.');
      const ref = await this.db('knowledge_references').where({ tenant_id: p.tenantId, kb_id: input.home.kbId, slug: referenceSlug(input.home.slug) }).first();
      if (!ref) throw conflict(`There is no page ${input.home.slug} in that knowledge base.`);
    }
  }

  async create(p: Principal, input: SiteInput, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    if (!SITE_SLUG.test(input.slug)) throw conflict('A site slug is lower-case letters, digits and dashes.');
    await this.checkInput(p, input);
    if (await this.db('doc_sites').where({ tenant_id: p.tenantId, slug: input.slug }).first()) throw conflict(`A site ${input.slug} exists.`);
    const t = Date.now();
    const row = { id: ulid(), tenant_id: p.tenantId, slug: input.slug, title: input.title, description: input.description ?? null, kb_ids: JSON.stringify(input.kbIds), home_kb_id: input.home?.kbId ?? null, home_slug: input.home ? referenceSlug(input.home.slug) : null, library: input.library ?? true, version: 1, created_by: p.userId, created_at: t, updated_at: t };
    await this.db('doc_sites').insert(row);
    const site = siteFrom(row);
    await this.audit(p, 'docs.site.created', site, { title: site.title, kbIds: site.kb_ids, home: input.home ?? null, library: site.library }, ctx);
    return this.view(site, await this.bases(p, site), true);
  }

  async update(p: Principal, id: string, patch: Partial<SiteInput>, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    const site = await this.row(p.tenantId, id);
    const kbIds = patch.kbIds ?? site.kb_ids;
    const home = patch.home !== undefined ? patch.home : site.home_kb_id && site.home_slug ? { kbId: site.home_kb_id, slug: site.home_slug } : null;
    // The bases are checked when they change; a home page when it changes (it must be one of the bases' pages).
    if (patch.kbIds) await this.checkInput(p, { kbIds, home: patch.home !== undefined ? patch.home : null });
    else if (patch.home) await this.checkInput(p, { kbIds: [patch.home.kbId].filter((k) => kbIds.includes(k)), home: patch.home });
    if (patch.slug !== undefined && patch.slug !== site.slug) {
      if (!SITE_SLUG.test(patch.slug)) throw conflict('A site slug is lower-case letters, digits and dashes.');
      if (await this.db('doc_sites').where({ tenant_id: p.tenantId, slug: patch.slug }).first()) throw conflict(`A site ${patch.slug} exists.`);
    }
    const keepHome = home && kbIds.includes(home.kbId) ? home : null;
    const upd = {
      slug: patch.slug ?? site.slug,
      title: patch.title ?? site.title,
      description: patch.description !== undefined ? patch.description : site.description,
      kb_ids: JSON.stringify(kbIds),
      home_kb_id: keepHome?.kbId ?? null,
      home_slug: keepHome ? referenceSlug(keepHome.slug) : null,
      library: patch.library ?? site.library,
      version: site.version + 1,
      updated_at: Date.now()
    };
    await this.db('doc_sites').where({ id: site.id }).update(upd);
    const now = await this.row(p.tenantId, site.id);
    await this.audit(p, 'docs.site.updated', now, { changed: Object.keys(patch), version: now.version }, ctx);
    return this.view(now, await this.bases(p, now), true);
  }

  async remove(p: Principal, id: string, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    const site = await this.row(p.tenantId, id);
    await this.db('doc_sites').where({ id: site.id }).delete();
    await this.audit(p, 'docs.site.removed', site, { title: site.title }, ctx);
  }

  /** The navigation: per readable base, its page tree and (with the Library on) its categories. */
  async nav(p: Principal, slug: string) {
    const { site, bases } = await this.readable(p, slug);
    const sections = [];
    for (const b of bases) {
      const tree = await this.s().knowledgeTree.tree(p, b.kb.id);
      let library: { documents: number; categories: { path: string; depth: number; documents: number }[] } | null = null;
      if (site.library) {
        const refDocs = await this.referenceDocIds(b.kb.id);
        const docs = (await this.s().knowledge.documents(p, b.kb.id, { limit: 1000 })).filter((d) => !refDocs.has(d.id) && !d.parentId);
        const cats = await this.s().knowledge.categoryCounts(p, [b.kb]);
        library = { documents: docs.length, categories: cats.filter((c) => c.documents > 0) };
      }
      sections.push({ kb: { id: b.kb.id, name: b.kb.name, label: b.kb.label }, duties: tree.duties, pages: tree.nodes, library });
    }
    return { site: this.view(site, bases, this.canManage(p)), sections };
  }

  private async referenceDocIds(kbId: string): Promise<Set<string>> {
    const rows = (await this.db('knowledge_references').where({ kb_id: kbId }).whereNotNull('document_id').select('document_id')) as { document_id: string }[];
    const revs = (await this.db('knowledge_revisions').where({ kb_id: kbId }).whereNotNull('document_id').select('document_id')) as { document_id: string }[];
    return new Set([...rows, ...revs].map((r) => r.document_id));
  }

  /** The references of the readable bases, by slug, as links resolve them (a page of the same base first). */
  private async slugMap(p: Principal, bases: { kb: KbRow }[]): Promise<Map<string, RefRow[]>> {
    const out = new Map<string, RefRow[]>();
    for (const b of bases) {
      const tree = await this.s().knowledgeTree.tree(p, b.kb.id);
      for (const n of tree.nodes) out.set(n.slug, [...(out.get(n.slug) ?? []), { id: n.id, kb_id: b.kb.id, slug: n.slug, title: n.title, label: n.label as Label, state: n.state, version: n.version, revision_id: null, document_id: null, parent_id: n.parentId, position: n.position, updated_at: n.updatedAt }]);
    }
    return out;
  }

  private href(site: SiteRow, kbId: string, slug: string, part?: string | null) {
    return `#/docs?site=${encodeURIComponent(site.slug)}&kb=${encodeURIComponent(kbId)}&page=${encodeURIComponent(slug)}${part ? `&at=${encodeURIComponent(part)}` : ''}`;
  }

  /** One page: its Markdown rendered, contents, place in the tree, links, backlinks and versions. */
  async page(p: Principal, slugOrId: string, kbId: string, refSlug: string, version?: string | null) {
    const { site, bases } = await this.readable(p, slugOrId);
    if (!bases.some((b) => b.kb.id === kbId)) throw notFound('Page');
    const revs = this.s().knowledgeRevisions;
    const found = await revs.find(p, kbId, refSlug).catch(() => null);
    if (!found) throw notFound('Page');
    const ref = await revs.reference(p, found.id).catch(() => null);
    if (!ref) throw notFound('Page');
    const history = (ref.history as unknown as Record<string, unknown>[]).map((h) => ({ id: String(h.id), version: String(h.version), number: Number(h.number), state: String(h.state), at: Number(h.publishedAt ?? h.decidedAt ?? h.updatedAt ?? h.createdAt ?? 0), summary: String(h.summary ?? ''), approvedBy: ((h.decidedBy as { name?: string } | null | undefined)?.name ?? (h.author as { name?: string } | undefined)?.name) ?? null }));
    const published = history.filter((h) => h.state === 'published' || h.state === 'superseded');
    const want = version ? history.find((h) => h.version === version && (h.state === 'published' || h.state === 'superseded' || ref.duties.edit || ref.duties.approve)) : (history.find((h) => h.state === 'published') ?? (ref.duties.edit || ref.duties.approve ? history[0] : undefined));
    if (!want) throw notFound(version ? `Version ${version}` : 'Page');
    const rev = (await revs.revision(p, want.id, { content: true })) as { content?: string; title?: string };
    const map = await this.slugMap(p, bases);
    const { html, toc } = renderMarkdown(String(rev.content ?? ''), {
      page: (slug, part) => {
        let s = slug;
        try {
          s = referenceSlug(slug);
        } catch {
          // left as written
        }
        const hits = map.get(s) ?? [];
        const hit = hits.find((h) => h.kb_id === kbId) ?? hits[0];
        return hit ? { href: this.href(site, hit.kb_id, hit.slug, part), exists: true, kb: hit.kb_id, slug: hit.slug } : { href: this.href(site, kbId, s, part), exists: false, kb: kbId, slug: s };
      }
    });
    const ctx = await this.s().knowledgeTree.context(p, found.id).catch(() => null);
    const brief = (x: { slug: string; title: string }) => ({ slug: x.slug, title: x.title });
    return {
      page: { id: found.id, kbId, kb: bases.find((b) => b.kb.id === kbId)!.kb.name, slug: found.slug, title: found.title, version: want.version, current: published[0]?.version ?? null, label: found.label, state: found.state, updatedAt: want.at || found.updated_at, approvedAt: want.at || null, approvedBy: want.approvedBy },
      html,
      toc,
      breadcrumbs: (ctx?.breadcrumbs ?? []).map(brief),
      children: (ctx?.children ?? []).map(brief),
      links: (ctx?.links ?? []).map(brief),
      backlinks: (ctx?.backlinks ?? []).map(brief),
      versions: published.map((h) => ({ version: h.version, number: h.number, state: h.state, at: h.at, summary: h.summary })),
      canEdit: ref.duties.edit
    };
  }

  /** The Library: a base's other documents (not references), newest first, optionally in a category or matching a name. */
  async library(p: Principal, slugOrId: string, kbId: string, opts: { category?: string | null; q?: string | null; limit?: number }) {
    const { site, bases } = await this.readable(p, slugOrId);
    if (!site.library || !bases.some((b) => b.kb.id === kbId)) throw notFound('Library');
    const refDocs = await this.referenceDocIds(kbId);
    const docs = await this.s().knowledge.documents(p, kbId, { limit: Math.min(opts.limit ?? 50, 200) + refDocs.size, ...(opts.q ? { q: opts.q } : {}), ...(opts.category ? { categories: { any: [opts.category] } } : {}) });
    return {
      documents: docs
        .filter((d) => !refDocs.has(d.id) && !d.parentId)
        .slice(0, Math.min(opts.limit ?? 50, 200))
        .map((d) => {
          const v = d as unknown as Record<string, unknown>;
          return { id: d.id, name: d.name, title: (v.title as string | undefined) ?? d.name, categories: (v.categories as string[] | undefined) ?? [], label: d.label, updatedAt: Number(v.updatedAt ?? 0) || null, source: d.source };
        })
    };
  }

  /** A library document's extracted text as a readable page. */
  async document(p: Principal, slugOrId: string, docId: string, from?: number) {
    const { site, bases } = await this.readable(p, slugOrId);
    if (!site.library) throw notFound('Document');
    const r = await this.s().knowledge.readDocument(p, docId, { from: from ?? 0, maxChars: 40_000 });
    if (!bases.some((b) => b.kb.id === r.kb.id)) throw notFound('Document');
    const { html, toc } = renderSections(r.sections);
    const cats = (await this.s().knowledge.categoriesOf([r.doc.id])).get(r.doc.id) ?? [];
    const url = /^https?:\/\//.test(r.doc.external_key) ? r.doc.external_key : /^https?:\/\//.test(r.doc.name) ? r.doc.name : null;
    return { doc: { id: r.doc.id, name: r.doc.name, title: r.doc.name, kbId: r.kb.id, kb: r.kb.name, label: r.doc.label, categories: cats, updatedAt: r.doc.updated_at, source: r.doc.source_id, url }, html, toc, next: r.next };
  }

  /** Search across the site's readable bases: hits on a reference's document point at the page, others at the Library. */
  async search(p: Principal, slugOrId: string, q: string) {
    const { site, bases } = await this.readable(p, slugOrId);
    const { hits } = await this.s().knowledge.search(p, bases.map((b) => b.kb), q, { k: 20, withText: true });
    const refByDoc = new Map<string, { kb_id: string; slug: string; title: string }>();
    const docIds = [...new Set(hits.map((h) => h.documentId))];
    if (docIds.length) {
      for (const r of (await this.db('knowledge_references').where({ tenant_id: p.tenantId }).whereIn('document_id', docIds).select('kb_id', 'slug', 'title', 'document_id')) as { kb_id: string; slug: string; title: string; document_id: string }[]) refByDoc.set(r.document_id, r);
      for (const r of (await this.db('knowledge_revisions as v').join('knowledge_references as r', 'r.id', 'v.reference_id').where({ 'v.tenant_id': p.tenantId }).whereIn('v.document_id', docIds).select('r.kb_id', 'r.slug', 'r.title', 'v.document_id')) as { kb_id: string; slug: string; title: string; document_id: string }[]) if (!refByDoc.has(r.document_id)) refByDoc.set(r.document_id, r);
    }
    const seen = new Set<string>();
    const out = [];
    for (const h of hits) {
      const ref = refByDoc.get(h.documentId);
      const key = ref ? `p:${ref.kb_id}:${ref.slug}` : `d:${h.documentId}`;
      if (seen.has(key)) continue;
      if (!ref && !site.library) continue;
      seen.add(key);
      const snippet = (h.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
      out.push(ref ? { kind: 'page' as const, kbId: ref.kb_id, slug: ref.slug, title: ref.title, heading: h.heading, snippet } : { kind: 'document' as const, kbId: h.kbId, docId: h.documentId, title: h.document, heading: h.heading, snippet });
    }
    return { hits: out };
  }
}

export type { RevisionRow };
