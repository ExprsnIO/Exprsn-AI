import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import { clears, highest, LABELS, labelRank, type Label } from '../authz/labels.js';
import { isRole, rolesGranting } from '../authz/permissions.js';
import type { Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { loadPrincipal } from '../http/middleware.js';
import { badRequest, conflict, forbidden, notFound } from '../http/problem.js';
import type { ToolCallContext } from '../registry/dispatch.js';
import type { Services } from '../services.js';
import { categoryPaths, CategoryError } from './categories.js';
import { textDiff } from './diff.js';
import type { DocRow, KbRow } from './service.js';

/*
 * References, revisions and review (migration 045_knowledge_revisions).
 *
 * A reference is a document of a knowledge base kept under version control: a stable slug, a title and the version
 * that is published now. Every change to it is a revision, and revisions are kept for good:
 *
 *   draft -> in-review -> approved -> published -> superseded
 *                      -> rejected            (approved -> failed when the scan or the index refuses the content)
 *            draft or in-review -> withdrawn
 *
 * - An editor of the base proposes a revision (the whole Markdown, what changed, and how the version moves: major,
 *   minor or patch, or a version of their own that is higher than the published one). A reference has one open
 *   revision at a time, so a revision is always a change to what is published.
 * - Submitting it asks for a decision. When the base names a review workflow, a run of it starts with the revision
 *   as its input and as its caller (`caller_kind: knowledge-revision`, like an app deployment): the run's approval
 *   step is the decision, and the revision is published when the run succeeds and rejected when it does not.
 *   Without a workflow, an approver decides on the revision itself.
 * - An approver is a user or a holder of a role the base lists as approver; a base that lists none is approved by
 *   whoever may manage it. With four eyes on (the default), nobody approves a revision they wrote.
 * - An approved revision is uploaded as a knowledge document like any upload (quarantine, scan, classification,
 *   index). When it is indexed the reference moves to it and the document of the version before is removed, so search
 *   answers from one version at a time and never from none.
 *
 * The review workflow is an ordinary published workflow: other workflows run it as a sub-workflow, and published as a
 * registry tool it is what a skill or an agent calls. Its last step is the built-in tool `knowledge_publish`, which
 * takes either a revision or a whole proposal and publishes it only when an approval step of the same run was
 * approved by an approver of the base.
 */

export const CALLER_KIND = 'knowledge-revision';
export const REVISION_STATES = ['draft', 'in-review', 'approved', 'published', 'superseded', 'rejected', 'withdrawn', 'failed'] as const;
export type RevisionState = (typeof REVISION_STATES)[number];
export const BUMPS = ['major', 'minor', 'patch'] as const;
export type Bump = (typeof BUMPS)[number];
const OPEN: RevisionState[] = ['draft', 'in-review', 'approved'];
export const MAX_CONTENT = 400_000;

export interface ReferenceRow {
  id: string;
  tenant_id: string;
  kb_id: string;
  slug: string;
  title: string;
  label: Label;
  categories: string[];
  state: 'draft' | 'published' | 'retired';
  version: string | null;
  revision_id: string | null;
  document_id: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface RevisionRow {
  id: string;
  tenant_id: string;
  kb_id: string;
  reference_id: string;
  number: number;
  version: string;
  bump: Bump | 'set';
  state: RevisionState;
  title: string;
  summary: string;
  feature: string | null;
  content: string;
  sha256: string;
  size: number;
  base_revision_id: string | null;
  author_id: string | null;
  author_name: string;
  approval_run_id: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decision_reason: string | null;
  document_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  submitted_at: number | null;
  decided_at: number | null;
  published_at: number | null;
}

export interface ReviewerRow {
  id: string;
  tenant_id: string;
  kb_id: string;
  duty: 'editor' | 'approver';
  principal_kind: 'user' | 'role';
  principal_id: string;
  created_by: string | null;
  created_at: number;
}

export interface ProposeInput {
  kbId: string;
  /** The reference: its id or slug. A slug that is not there yet makes a new reference. */
  reference?: string | undefined;
  title?: string | undefined;
  content: string;
  summary: string;
  bump?: Bump | undefined;
  version?: string | undefined;
  feature?: string | null | undefined;
  label?: Label | undefined;
  categories?: unknown;
}

type Review = Pick<KbRow, 'id'> & { review?: string | null; review_workflow_id?: string | null; review_four_eyes?: number | boolean | null };
const num = (v: unknown) => (v == null ? null : Number(v));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const refFrom = (r: Record<string, unknown>): ReferenceRow => ({ ...(r as unknown as ReferenceRow), categories: json<string[]>(r.categories, []), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const revFrom = (r: Record<string, unknown>): RevisionRow => ({ ...(r as unknown as RevisionRow), number: Number(r.number), size: Number(r.size), created_at: Number(r.created_at), updated_at: Number(r.updated_at), submitted_at: num(r.submitted_at), decided_at: num(r.decided_at), published_at: num(r.published_at) });

// ---------- versions and slugs ----------

const SEMVER = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
export function parseVersion(v: string): [number, number, number] | null {
  const m = SEMVER.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a) ?? [0, 0, 0];
  const y = parseVersion(b) ?? [0, 0, 0];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
/** The version after `current` for a bump; a reference that was never published starts at 1.0.0. */
export function nextVersion(current: string | null, bump: Bump): string {
  const v = current ? parseVersion(current) : null;
  if (!v) return '1.0.0';
  return bump === 'major' ? `${v[0] + 1}.0.0` : bump === 'minor' ? `${v[0]}.${v[1] + 1}.0` : `${v[0]}.${v[1]}.${v[2] + 1}`;
}
/** A reference's slug in its one spelling: lower-case path segments of letters, digits, `.`, `_` and `-`. */
export function referenceSlug(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .split('/')
    .map((seg) => seg.trim().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .join('/');
  if (!slug || slug.length > 200) throw badRequest('A reference is named by a short path such as "exprsn-ai/overview" (letters, digits, ".", "_" and "-", levels separated by "/").');
  return slug;
}
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// ---------- views ----------

export const referenceView = (r: ReferenceRow, open?: RevisionRow | null, revisions?: number) => ({
  id: r.id,
  kbId: r.kb_id,
  slug: r.slug,
  title: r.title,
  label: r.label,
  categories: r.categories,
  state: r.state,
  version: r.version,
  revisionId: r.revision_id,
  documentId: r.document_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(revisions !== undefined ? { revisions } : {}),
  ...(open !== undefined ? { open: open ? { id: open.id, state: open.state, version: open.version, author: open.author_name, summary: open.summary, submittedAt: open.submitted_at } : null } : {})
});

export const revisionView = (v: RevisionRow) => ({
  id: v.id,
  kbId: v.kb_id,
  referenceId: v.reference_id,
  number: v.number,
  version: v.version,
  bump: v.bump,
  state: v.state,
  title: v.title,
  summary: v.summary,
  feature: v.feature,
  size: v.size,
  sha256: v.sha256,
  author: { id: v.author_id, name: v.author_name },
  approvalRunId: v.approval_run_id,
  decidedBy: v.decided_by_name ? { id: v.decided_by, name: v.decided_by_name } : null,
  reason: v.decision_reason,
  documentId: v.document_id,
  error: v.error,
  createdAt: v.created_at,
  updatedAt: v.updated_at,
  submittedAt: v.submitted_at,
  decidedAt: v.decided_at,
  publishedAt: v.published_at
});

/** The line a published document starts with, so a reader and a model see which version they are reading. */
export const versionLine = (ref: Pick<ReferenceRow, 'slug'>, v: Pick<RevisionRow, 'version' | 'number'>, by: string, at: number) => `> Reference \`${ref.slug}\`, version ${v.version} (revision ${v.number}), approved ${new Date(at).toISOString().slice(0, 10)} by ${by}.`;

/** The standard review workflow: its name, the registry tool it is published as, and its graph. */
export const REVIEW_WORKFLOW = {
  name: 'knowledge-approval',
  tool: 'knowledge_approval',
  description: 'Reviews a revision of a knowledge reference: an approver of the knowledge base decides, and an approved revision is published. Takes a revision that exists (revisionId) or a whole proposal (kbId, reference or title, content, summary, bump). Knowledge starts it for a submitted revision; other workflows run it as a sub-workflow, and skills and agents call it as the tool knowledge_approval.',
  toolDescription: 'Sends a change to a knowledge reference through review and publishes it when approved: give the knowledge base (kbId), the reference (its slug, or title for a new one), the whole document as Markdown (content), what changed (summary) and how the version moves (bump: major, minor or patch). The call waits for an approver of the knowledge base, which can take hours; it returns the published version, or fails when the change is rejected. To submit and not wait, use knowledge_propose.'
} as const;

/** `role` holds the approval step; `knowledge_publish` then checks that whoever approved may approve in the base. */
/**
 * The review workflow. `reviewMs` (optional) bounds how long a revision may wait for its approver: the approval step's
 * timeout and the run's, after which an unapproved revision is rejected. Without it the approval waits up to 7 days
 * within the default run limit (2 hours).
 */
export function reviewWorkflowGraph(role = 'knowledge-curator', reviewMs?: number) {
  const s = { type: 'string' };
  return {
    nodes: [
      {
        id: 'start',
        kind: 'trigger',
        title: 'Revision',
        x: 20,
        y: 120,
        config: { source: 'manual' },
        output: { type: 'object', properties: { revisionId: s, kbId: s, reference: s, title: s, content: s, summary: s, bump: s, version: s, feature: s, categories: { type: 'array', items: s } }, required: ['summary'] }
      },
      { id: 'review', kind: 'approval', title: 'Review the revision', x: 250, y: 120, config: { role, timeoutMs: reviewMs ?? 7 * 24 * 3_600_000, show: 'Knowledge revision of {{input.reference}} ({{input.title}}).\n\n{{input.summary}}\n\nRead the revision and its diff under Knowledge, References, before deciding. A proposal sent with its text:\n\n{{input.content}}' } },
      { id: 'publish', kind: 'tool', title: 'Publish', x: 480, y: 120, config: { tool: 'knowledge_publish', args: '{{input}}' } }
    ],
    edges: [
      { from: 'start', to: 'review' },
      { from: 'review', to: 'publish' }
    ],
    limits: reviewMs ? { timeoutMs: reviewMs } : {}
  };
}

export class KnowledgeRevisions {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private seal(tenantId: string, id: string, text: string): Promise<string> {
    return this.s().keys.seal(tenantId, text, `krev:${id}`);
  }

  /** A revision's Markdown. */
  async content(v: Pick<RevisionRow, 'id' | 'tenant_id' | 'content'>): Promise<string> {
    return this.s().keys.open(v.tenant_id, v.content, `krev:${v.id}`);
  }

  private audit(p: Principal | null, tenantId: string, action: string, target: Record<string, unknown>, detail: Record<string, unknown>, label?: Label, service = 'knowledge') {
    return this.s().audit.append({ tenantId, action, kind: 'admin', actor: p ? actorFrom(p, null) : { service }, target, detail, ...(label ? { label } : {}) });
  }

  // ---------- who may do what ----------

  private async reviewers(kbId: string): Promise<ReviewerRow[]> {
    return ((await this.db('knowledge_reviewers').where({ kb_id: kbId }).orderBy('created_at')) as Record<string, unknown>[]).map((r) => ({ ...(r as unknown as ReviewerRow), created_at: Number(r.created_at) }));
  }

  /** The base as the principal sees it, with what they may do with its references. */
  async duties(p: Principal, kbId: string): Promise<{ kb: KbRow; manage: boolean; edit: boolean; approve: boolean }> {
    const hit = (await this.s().knowledge.visible(p)).find((x) => x.kb.id === kbId);
    if (!hit) throw notFound('Knowledge base');
    const rows = await this.reviewers(kbId);
    const listed = (duty: ReviewerRow['duty']) => rows.some((r) => r.duty === duty && (r.principal_kind === 'user' ? r.principal_id === p.userId : p.roles.includes(r.principal_id)));
    const manage = hit.access === 'manage';
    return { kb: hit.kb, manage, edit: manage || listed('editor'), approve: rows.some((r) => r.duty === 'approver') ? listed('approver') : manage };
  }

  private fourEyes(kb: Review): boolean {
    return kb.review_four_eyes == null ? true : !!Number(kb.review_four_eyes);
  }

  /** Why the principal may not decide this revision, or null when they may. */
  private async undecidable(p: Principal, v: RevisionRow): Promise<string | null> {
    const d = await this.duties(p, v.kb_id).catch(() => null);
    if (!d) return 'They cannot read the knowledge base.';
    if (!d.approve) return 'Deciding a revision needs to be an approver of this knowledge base.';
    if (this.fourEyes(d.kb as Review) && v.author_id && v.author_id === p.userId) return 'An author does not approve their own revision (four eyes).';
    return null;
  }

  /** The users who may approve in a base (for notices), without the author. */
  private async approverIds(kb: KbRow, except: string | null): Promise<string[]> {
    const rows = (await this.reviewers(kb.id)).filter((r) => r.duty === 'approver');
    const n = this.s().notifications;
    const ids = rows.length ? [...rows.filter((r) => r.principal_kind === 'user').map((r) => r.principal_id), ...(await n.usersWithRoles(kb.tenant_id, rows.filter((r) => r.principal_kind === 'role').map((r) => r.principal_id)))] : await n.usersWithRoles(kb.tenant_id, rolesGranting('knowledge:manage', kb.tenant_id));
    return [...new Set(ids)].filter((u) => u !== except);
  }

  // ---------- review settings ----------

  async settings(p: Principal, kbId: string) {
    const d = await this.duties(p, kbId);
    const kb = d.kb as KbRow & Review;
    const rows = await this.reviewers(kbId);
    const users = rows.filter((r) => r.principal_kind === 'user').map((r) => r.principal_id);
    const names = users.length ? new Map(((await this.db('users').where({ tenant_id: p.tenantId }).whereIn('id', users).select('id', 'display_name', 'username')) as { id: string; display_name: string | null; username: string }[]).map((u) => [u.id, u.display_name || u.username])) : new Map<string, string>();
    const wf = kb.review_workflow_id ? ((await this.db('workflows').where({ tenant_id: p.tenantId, id: kb.review_workflow_id }).first('id', 'name', 'published_version')) as { id: string; name: string; published_version: number | null } | undefined) : undefined;
    const view = (r: ReviewerRow) => ({ id: r.id, kind: r.principal_kind, principal: r.principal_id, name: r.principal_kind === 'user' ? (names.get(r.principal_id) ?? r.principal_id) : r.principal_id });
    return {
      kbId,
      review: kb.review === 'required' ? 'required' : 'off',
      fourEyes: this.fourEyes(kb),
      workflow: kb.review_workflow_id ? { id: kb.review_workflow_id, name: wf?.name ?? null, published: !!wf?.published_version } : null,
      editors: rows.filter((r) => r.duty === 'editor').map(view),
      approvers: rows.filter((r) => r.duty === 'approver').map(view),
      duties: { manage: d.manage, edit: d.edit, approve: d.approve }
    };
  }

  async setSettings(p: Principal, kbId: string, patch: { review?: 'off' | 'required' | undefined; workflowId?: string | null | undefined; fourEyes?: boolean | undefined }) {
    const d = await this.duties(p, kbId);
    if (!d.manage) throw forbidden('Changing how a knowledge base is reviewed needs the knowledge curator role or manage access to it.', { step: 'role', action: 'knowledge:manage' });
    const update: Record<string, unknown> = {};
    if (patch.review) update.review = patch.review;
    if (patch.fourEyes !== undefined) update.review_four_eyes = patch.fourEyes ? 1 : 0;
    if (patch.workflowId !== undefined) {
      if (patch.workflowId) {
        const w = await this.s().workflows.workflow(p, patch.workflowId);
        if (!w.published_version) throw conflict(`${w.name} has no published version; publish it before it reviews revisions.`);
        update.review_workflow_id = w.id;
      } else update.review_workflow_id = null;
    }
    if (Object.keys(update).length) {
      await this.db('knowledge_bases').where({ id: kbId }).update({ ...update, updated_at: Date.now() });
      await this.audit(p, p.tenantId, 'knowledge.review.settings', { kb: kbId, name: d.kb.name }, update, d.kb.label);
    }
    return this.settings(p, kbId);
  }

  async addReviewer(p: Principal, kbId: string, input: { duty: 'editor' | 'approver'; kind: 'user' | 'role'; id: string }) {
    const d = await this.duties(p, kbId);
    if (!d.manage) throw forbidden('Naming editors and approvers needs the knowledge curator role or manage access to the knowledge base.', { step: 'role', action: 'knowledge:manage' });
    if (input.kind === 'role' && !isRole(input.id, p.tenantId)) throw badRequest(`There is no role ${input.id}.`);
    if (input.kind === 'user' && !(await this.db('users').where({ tenant_id: p.tenantId, id: input.id }).first('id'))) throw notFound('User');
    if (!(await this.db('knowledge_reviewers').where({ kb_id: kbId, duty: input.duty, principal_kind: input.kind, principal_id: input.id }).first('id'))) {
      await this.db('knowledge_reviewers').insert({ id: ulid(), tenant_id: p.tenantId, kb_id: kbId, duty: input.duty, principal_kind: input.kind, principal_id: input.id, created_by: p.userId, created_at: Date.now() });
      await this.audit(p, p.tenantId, 'knowledge.reviewer.added', { kb: kbId, name: d.kb.name }, { duty: input.duty, kind: input.kind, principal: input.id }, d.kb.label);
    }
    return this.settings(p, kbId);
  }

  async removeReviewer(p: Principal, kbId: string, reviewerId: string) {
    const d = await this.duties(p, kbId);
    if (!d.manage) throw forbidden('Naming editors and approvers needs the knowledge curator role or manage access to the knowledge base.', { step: 'role', action: 'knowledge:manage' });
    const row = (await this.db('knowledge_reviewers').where({ kb_id: kbId, id: reviewerId }).first()) as ReviewerRow | undefined;
    if (!row) throw notFound('Reviewer');
    await this.db('knowledge_reviewers').where({ id: row.id }).delete();
    await this.audit(p, p.tenantId, 'knowledge.reviewer.removed', { kb: kbId, name: d.kb.name }, { duty: row.duty, kind: row.principal_kind, principal: row.principal_id }, d.kb.label);
    return this.settings(p, kbId);
  }

  // ---------- reading ----------

  private async refRow(tenantId: string, id: string): Promise<ReferenceRow> {
    const r = await this.db('knowledge_references').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('Reference');
    return refFrom(r);
  }

  private async revRow(tenantId: string, id: string): Promise<RevisionRow> {
    const r = await this.db('knowledge_revisions').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('Revision');
    return revFrom(r);
  }

  private async openRevisions(refIds: string[]): Promise<Map<string, RevisionRow>> {
    const out = new Map<string, RevisionRow>();
    for (let i = 0; i < refIds.length; i += 500) for (const r of (await this.db('knowledge_revisions').whereIn('reference_id', refIds.slice(i, i + 500)).whereIn('state', OPEN)) as Record<string, unknown>[]) out.set(String(r.reference_id), revFrom(r));
    return out;
  }

  /** The references of a base the reader is cleared for. Drafts that were never published show to editors and approvers only. */
  async references(p: Principal, kbId: string) {
    const d = await this.duties(p, kbId);
    const rows = ((await this.db('knowledge_references').where({ kb_id: kbId }).orderBy('slug')) as Record<string, unknown>[]).map(refFrom).filter((r) => clears(p.clearance, r.label) && r.state !== 'retired' && (r.state === 'published' || d.edit || d.approve));
    const open = await this.openRevisions(rows.map((r) => r.id));
    const inside = d.edit || d.approve;
    return rows.map((r) => referenceView(r, inside ? (open.get(r.id) ?? null) : undefined));
  }

  /** A reference by id, or by slug within a base. */
  async find(p: Principal, kbId: string | undefined, ref: string): Promise<ReferenceRow | null> {
    const q = this.db('knowledge_references').where({ tenant_id: p.tenantId });
    const r = ULID_RE.test(ref) ? await q.clone().where({ id: ref }).first() : kbId ? await q.clone().where({ kb_id: kbId, slug: referenceSlug(ref) }).first() : null;
    return r ? refFrom(r) : null;
  }

  /** One reference with its history. Readers see the published line of versions; editors and approvers every revision. */
  async reference(p: Principal, id: string) {
    const ref = await this.refRow(p.tenantId, id);
    const d = await this.duties(p, ref.kb_id);
    if (!clears(p.clearance, ref.label)) throw notFound('Reference');
    const inside = d.edit || d.approve;
    if (!inside && ref.state !== 'published') throw notFound('Reference');
    const revs = ((await this.db('knowledge_revisions').where({ reference_id: ref.id }).orderBy('number', 'desc')) as Record<string, unknown>[]).map(revFrom).filter((v) => inside || v.state === 'published' || v.state === 'superseded');
    return { ...referenceView(ref, inside ? (revs.find((v) => OPEN.includes(v.state)) ?? null) : undefined, revs.length), kb: d.kb.name, duties: { manage: d.manage, edit: d.edit, approve: d.approve }, history: revs.map(revisionView) };
  }

  /** One revision with its Markdown and what it changes against the version it was written on. */
  async revision(p: Principal, id: string, opts: { content?: boolean; diff?: boolean } = {}) {
    const v = await this.revRow(p.tenantId, id);
    const ref = await this.refRow(p.tenantId, v.reference_id);
    const d = await this.duties(p, v.kb_id);
    if (!clears(p.clearance, ref.label)) throw notFound('Revision');
    const inside = d.edit || d.approve;
    if (!inside && v.state !== 'published' && v.state !== 'superseded') throw notFound('Revision');
    const out: Record<string, unknown> = { ...revisionView(v), reference: { id: ref.id, slug: ref.slug, title: ref.title, version: ref.version, label: ref.label }, kb: d.kb.name };
    if (inside) out.mayDecide = v.state === 'in-review' ? (await this.undecidable(p, v)) === null : false;
    if (inside && v.state === 'in-review') out.whyNot = await this.undecidable(p, v);
    if (opts.content || opts.diff) {
      const now = await this.content(v);
      if (opts.content) out.content = now;
      if (opts.diff) {
        const base = v.base_revision_id ? ((await this.db('knowledge_revisions').where({ id: v.base_revision_id }).first()) as Record<string, unknown> | undefined) : undefined;
        const was = base ? await this.content(revFrom(base)) : '';
        const diff = textDiff(was, now);
        out.diff = { against: base ? String(base.version) : null, added: diff.added, removed: diff.removed, text: diff.text, truncated: diff.truncated };
      }
    }
    return out;
  }

  /** Revisions waiting on the caller as an approver, and the caller's own open ones. */
  async reviews(p: Principal) {
    const bases = await this.s().knowledge.visible(p);
    const byId = new Map(bases.map((b) => [b.kb.id, b.kb]));
    if (!byId.size) return { waiting: [], mine: [] };
    const rows = ((await this.db('knowledge_revisions').where({ tenant_id: p.tenantId }).whereIn('kb_id', [...byId.keys()]).whereIn('state', OPEN).orderBy('created_at')) as Record<string, unknown>[]).map(revFrom);
    const refs = new Map((rows.length ? ((await this.db('knowledge_references').whereIn('id', [...new Set(rows.map((r) => r.reference_id))])) as Record<string, unknown>[]).map(refFrom) : []).map((r) => [r.id, r]));
    const duties = new Map<string, { edit: boolean; approve: boolean }>();
    const waiting = [];
    const mine = [];
    for (const v of rows) {
      const ref = refs.get(v.reference_id);
      if (!ref || !clears(p.clearance, ref.label)) continue;
      if (!duties.has(v.kb_id)) duties.set(v.kb_id, await this.duties(p, v.kb_id));
      const d = duties.get(v.kb_id)!;
      const row = { ...revisionView(v), reference: { id: ref.id, slug: ref.slug, title: ref.title, version: ref.version }, kb: byId.get(v.kb_id)?.name ?? '' };
      if (v.state === 'in-review' && d.approve) {
        const why = await this.undecidable(p, v);
        waiting.push({ ...row, mayDecide: why === null, whyNot: why });
      }
      if (v.author_id === p.userId) mine.push(row);
    }
    return { waiting, mine };
  }

  // ---------- proposing ----------

  /**
   * A draft revision: of a reference that exists, or of a new one. `author` replaces the principal as the author
   * for work a setup script does (the revision then has no author to keep from approving it).
   */
  async propose(p: Principal, input: ProposeInput, opts: { author?: string } = {}): Promise<RevisionRow> {
    const d = await this.duties(p, input.kbId);
    if (!d.edit) throw forbidden('Proposing a revision needs to be an editor of this knowledge base.', { step: 'role', action: 'knowledge:manage' });
    const content = input.content.replace(/\r\n?/g, '\n');
    if (!content.trim()) throw badRequest('A revision needs content.');
    if (content.length > MAX_CONTENT) throw badRequest(`A revision is at most ${MAX_CONTENT} characters.`);
    const summary = input.summary.trim();
    if (!summary) throw badRequest('Say what this revision changes.');
    let ref = input.reference ? await this.find(p, d.kb.id, input.reference) : null;
    if (ref && ref.kb_id !== d.kb.id) throw notFound('Reference');
    const title = (input.title ?? ref?.title ?? '').trim().slice(0, 300);
    if (!title) throw badRequest('A new reference needs a title.');
    const label = highest(d.kb.label, input.label ?? ref?.label ?? 'public');
    if (!clears(p.clearance, label)) throw forbidden(`Your clearance is ${p.clearance}; this reference is ${label}.`, { step: 'clearance' });
    let categories: string[] | undefined;
    try {
      categories = input.categories === undefined ? undefined : categoryPaths(input.categories);
    } catch (err) {
      if (err instanceof CategoryError) throw badRequest(err.message);
      throw err;
    }
    const t = Date.now();
    if (!ref) {
      const slug = referenceSlug(input.reference && !ULID_RE.test(input.reference) ? input.reference : title);
      ref = { id: ulid(), tenant_id: p.tenantId, kb_id: d.kb.id, slug, title, label, categories: categories ?? [], state: 'draft', version: null, revision_id: null, document_id: null, created_by: opts.author ? null : p.userId, created_at: t, updated_at: t };
      await this.db('knowledge_references').insert({ ...ref, categories: JSON.stringify(ref.categories) });
    } else {
      const open = (await this.openRevisions([ref.id])).get(ref.id);
      if (open) throw conflict(`${ref.slug} already has an open revision (${open.version}, ${open.state}, by ${open.author_name}); a reference has one at a time.`);
      // A revision of a retired reference (or of one whose only draft was withdrawn) opens it again.
      const patch: Record<string, unknown> = ref.state === 'retired' ? { state: 'draft' } : {};
      if (categories && JSON.stringify(categories) !== JSON.stringify(ref.categories)) patch.categories = JSON.stringify(categories);
      if (labelRank(label) > labelRank(ref.label)) patch.label = label;
      if (Object.keys(patch).length) await this.db('knowledge_references').where({ id: ref.id }).update({ ...patch, updated_at: t });
      ref = { ...ref, ...(categories ? { categories } : {}), label: highest(ref.label, label), state: ref.state === 'retired' ? 'draft' : ref.state };
    }
    const digest = sha(content);
    if (ref.revision_id) {
      const cur = await this.revRow(p.tenantId, ref.revision_id);
      if (cur.sha256 === digest && cur.title === title) throw conflict(`Nothing changed: this is the content of version ${cur.version}.`);
    }
    let version: string;
    let bump: RevisionRow['bump'];
    if (input.version) {
      if (!parseVersion(input.version)) throw badRequest('A version is three numbers, such as 1.4.0.');
      if (ref.version && compareVersions(input.version, ref.version) <= 0) throw conflict(`The version must be higher than the published ${ref.version}.`);
      version = input.version.trim();
      bump = 'set';
    } else {
      bump = input.bump ?? (ref.version ? 'minor' : 'major');
      version = nextVersion(ref.version, bump as Bump);
    }
    const last = (await this.db('knowledge_revisions').where({ reference_id: ref.id }).max({ n: 'number' }).first()) as { n: number | null } | undefined;
    const id = ulid();
    const row: RevisionRow = { id, tenant_id: p.tenantId, kb_id: d.kb.id, reference_id: ref.id, number: Number(last?.n ?? 0) + 1, version, bump, state: 'draft', title, summary: summary.slice(0, 4000), feature: input.feature?.trim().slice(0, 300) || null, content: await this.seal(p.tenantId, id, content), sha256: digest, size: Buffer.byteLength(content), base_revision_id: ref.revision_id, author_id: opts.author ? null : p.userId, author_name: opts.author ?? p.displayName, approval_run_id: null, decided_by: null, decided_by_name: null, decision_reason: null, document_id: null, error: null, created_at: t, updated_at: t, submitted_at: null, decided_at: null, published_at: null };
    await this.db('knowledge_revisions').insert(row);
    await this.audit(p, p.tenantId, 'knowledge.revision.proposed', { kb: d.kb.id, reference: ref.id, revision: id, slug: ref.slug }, { version, bump, number: row.number, size: row.size, sha256: digest, summary: row.summary, ...(row.feature ? { feature: row.feature } : {}), ...(opts.author ? { author: opts.author } : {}) }, ref.label);
    return row;
  }

  /** Changes a draft: its Markdown, what it says it changes, the title or how the version moves. */
  async edit(p: Principal, id: string, patch: { content?: string | undefined; summary?: string | undefined; title?: string | undefined; bump?: Bump | undefined; feature?: string | null | undefined }): Promise<RevisionRow> {
    const v = await this.revRow(p.tenantId, id);
    const d = await this.duties(p, v.kb_id);
    if (!d.edit) throw forbidden('Changing a revision needs to be an editor of this knowledge base.', { step: 'role', action: 'knowledge:manage' });
    if (v.state !== 'draft') throw conflict(`This revision is ${v.state}; only a draft is changed. Withdraw it to write another.`);
    const ref = await this.refRow(p.tenantId, v.reference_id);
    const update: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.content !== undefined) {
      const content = patch.content.replace(/\r\n?/g, '\n');
      if (!content.trim()) throw badRequest('A revision needs content.');
      if (content.length > MAX_CONTENT) throw badRequest(`A revision is at most ${MAX_CONTENT} characters.`);
      Object.assign(update, { content: await this.seal(v.tenant_id, v.id, content), sha256: sha(content), size: Buffer.byteLength(content) });
    }
    if (patch.summary !== undefined) {
      if (!patch.summary.trim()) throw badRequest('Say what this revision changes.');
      update.summary = patch.summary.trim().slice(0, 4000);
    }
    if (patch.title !== undefined && patch.title.trim()) update.title = patch.title.trim().slice(0, 300);
    if (patch.feature !== undefined) update.feature = patch.feature?.trim().slice(0, 300) || null;
    if (patch.bump) Object.assign(update, { bump: patch.bump, version: nextVersion(ref.version, patch.bump) });
    await this.db('knowledge_revisions').where({ id: v.id, state: 'draft' }).update(update);
    await this.audit(p, p.tenantId, 'knowledge.revision.edited', { kb: v.kb_id, reference: ref.id, revision: v.id, slug: ref.slug }, { changed: Object.keys(patch) }, ref.label);
    return this.revRow(p.tenantId, id);
  }

  /** What a review run is started with: the revision, and enough to show an approver what they decide. */
  private runInput(v: RevisionRow, ref: ReferenceRow, kb: KbRow) {
    return { revisionId: v.id, kbId: kb.id, reference: ref.slug, title: v.title, summary: `${kb.name}: ${ref.slug} ${ref.version ? `${ref.version} to ${v.version}` : `new, ${v.version}`}, by ${v.author_name}. ${v.summary}`, ...(v.feature ? { feature: v.feature } : {}) };
  }

  /**
   * Asks for a decision on a draft. With a review workflow on the base, a run of it starts as the submitter with the
   * revision as its caller; otherwise the approvers are told.
   */
  async submit(p: Principal, id: string): Promise<RevisionRow> {
    const v = await this.revRow(p.tenantId, id);
    const d = await this.duties(p, v.kb_id);
    if (!d.edit) throw forbidden('Submitting a revision needs to be an editor of this knowledge base.', { step: 'role', action: 'knowledge:manage' });
    if (v.state !== 'draft') throw conflict(`This revision is ${v.state}.`);
    const ref = await this.refRow(p.tenantId, v.reference_id);
    const kb = d.kb as KbRow & Review;
    const t = Date.now();
    if ((await this.db('knowledge_revisions').where({ id: v.id, state: 'draft' }).update({ state: 'in-review', submitted_at: t, updated_at: t })) !== 1) throw conflict('Someone changed this revision a moment ago.');
    let runId: string | null = null;
    if (kb.review_workflow_id) {
      try {
        const run = await this.s().workflows.start(p, kb.review_workflow_id, { input: this.runInput(v, ref, kb), dry: false, trigger: 'api:knowledge-revision', caller: { kind: CALLER_KIND, id: v.id, node: 'review' } });
        runId = run.id;
        await this.db('knowledge_revisions').where({ id: v.id }).update({ approval_run_id: runId });
      } catch (err) {
        await this.db('knowledge_revisions').where({ id: v.id }).update({ state: 'draft', submitted_at: null });
        throw conflict(`The review workflow could not start: ${(err as { detail?: string }).detail ?? (err as Error).message}`);
      }
    }
    await this.audit(p, p.tenantId, 'knowledge.revision.submitted', { kb: kb.id, reference: ref.id, revision: v.id, slug: ref.slug, ...(runId ? { run: runId } : {}) }, { version: v.version, ...(runId ? { workflow: kb.review_workflow_id } : {}) }, ref.label);
    await this.s().notifications.notify({ tenantId: p.tenantId, userIds: await this.approverIds(kb, v.author_id), kind: 'knowledge', title: 'Knowledge revision waits for review', body: `${ref.title} ${v.version} in ${kb.name}, by ${v.author_name}: ${v.summary}`, route: 'knowledge', label: ref.label });
    return this.revRow(p.tenantId, id);
  }

  /** Takes a draft or a revision in review back. A review run that is deciding it is cancelled. */
  async withdraw(p: Principal, id: string): Promise<RevisionRow> {
    const v = await this.revRow(p.tenantId, id);
    const d = await this.duties(p, v.kb_id);
    if (!(d.manage || (d.edit && v.author_id === p.userId))) throw forbidden('A revision is withdrawn by its author or by someone who manages the knowledge base.', { step: 'role', action: 'knowledge:manage' });
    if (v.state !== 'draft' && v.state !== 'in-review') throw conflict(`This revision is ${v.state}.`);
    const ref = await this.refRow(p.tenantId, v.reference_id);
    if ((await this.db('knowledge_revisions').where({ id: v.id, state: v.state }).update({ state: 'withdrawn', updated_at: Date.now() })) !== 1) throw conflict('Someone changed this revision a moment ago.');
    if (v.approval_run_id) await this.s().workflows.cancel(p, v.approval_run_id).catch(() => undefined);
    await this.dropUnpublished(ref);
    await this.audit(p, p.tenantId, 'knowledge.revision.withdrawn', { kb: v.kb_id, reference: ref.id, revision: v.id, slug: ref.slug }, { version: v.version, from: v.state }, ref.label);
    return this.revRow(p.tenantId, id);
  }

  /** A reference that was never published and has no open revision left is not listed any more. */
  private async dropUnpublished(ref: ReferenceRow): Promise<void> {
    if (ref.version || ref.state === 'retired') return;
    if (await this.db('knowledge_revisions').where({ reference_id: ref.id }).whereIn('state', OPEN).first('id')) return;
    await this.db('knowledge_references').where({ id: ref.id }).update({ state: 'retired', updated_at: Date.now() });
  }

  // ---------- deciding ----------

  /**
   * An approver's decision. A revision a review run is deciding is decided on that run's approval step, so the run
   * and the revision cannot disagree; the run then publishes it.
   */
  async decide(p: Principal, id: string, input: { decision: 'approve' | 'reject'; reason?: string | null | undefined }): Promise<RevisionRow & { settling?: boolean }> {
    const v = await this.revRow(p.tenantId, id);
    if (v.state !== 'in-review') throw conflict(`This revision is ${v.state}.`);
    const why = await this.undecidable(p, v);
    if (why) throw forbidden(why, { step: 'role', action: 'knowledge:manage' });
    if (input.decision === 'reject' && !input.reason?.trim()) throw badRequest('Say why the revision is rejected, so its author can change it.');
    const ref = await this.refRow(p.tenantId, v.reference_id);
    if (v.approval_run_id) {
      const a = (await this.db('workflow_approvals').where({ tenant_id: p.tenantId, run_id: v.approval_run_id, state: 'pending' }).first('id')) as { id: string } | undefined;
      if (!a) throw conflict('The review run of this revision is not waiting for a decision right now; look at the run under Workflows.');
      // The run ends a little later; the reason given here is the one the revision keeps.
      if (input.reason?.trim()) await this.db('knowledge_revisions').where({ id: v.id, state: 'in-review' }).update({ decision_reason: input.reason.trim().slice(0, 2000) });
      await this.s().workflows.decide(p, a.id, { decision: input.decision, reason: input.reason ?? null });
      const after = await this.revRow(p.tenantId, id);
      return { ...after, settling: after.state === 'in-review' };
    }
    if (input.decision === 'approve') await this.approve(v, ref, { id: p.userId, name: p.displayName }, input.reason ?? null, p);
    else await this.reject(v, ref, { id: p.userId, name: p.displayName }, input.reason!.trim(), p);
    return this.revRow(p.tenantId, id);
  }

  private async reject(v: RevisionRow, ref: ReferenceRow, by: { id: string | null; name: string }, reason: string, p: Principal | null): Promise<void> {
    const t = Date.now();
    if ((await this.db('knowledge_revisions').where({ id: v.id, state: 'in-review' }).update({ state: 'rejected', decided_by: by.id, decided_by_name: by.name, decision_reason: reason.slice(0, 2000), decided_at: t, updated_at: t })) !== 1) return;
    await this.audit(p, v.tenant_id, 'knowledge.revision.rejected', { kb: v.kb_id, reference: ref.id, revision: v.id, slug: ref.slug, ...(v.approval_run_id ? { run: v.approval_run_id } : {}) }, { version: v.version, reason: reason.slice(0, 500), by: by.name }, ref.label);
    if (v.author_id) await this.s().notifications.notify({ tenantId: v.tenant_id, userIds: [v.author_id], kind: 'knowledge', title: 'Knowledge revision rejected', body: `${ref.title} ${v.version}: ${reason}`.slice(0, 900), route: 'knowledge', label: ref.label });
  }

  /** Marks the revision approved and uploads it as the reference's next document; `docSettled` finishes the move. */
  private async approve(v: RevisionRow, ref: ReferenceRow, by: { id: string | null; name: string }, reason: string | null, p: Principal | null): Promise<void> {
    const s = this.s();
    const t = Date.now();
    if ((await this.db('knowledge_revisions').whereIn('state', ['draft', 'in-review']).where({ id: v.id }).update({ state: 'approved', decided_by: by.id, decided_by_name: by.name, decision_reason: reason?.trim().slice(0, 2000) || null, decided_at: t, submitted_at: v.submitted_at ?? t, updated_at: t })) !== 1) throw conflict('Someone decided this revision a moment ago.');
    const kb = (await this.db('knowledge_bases').where({ id: v.kb_id }).first()) as Record<string, unknown> | undefined;
    if (!kb) throw notFound('Knowledge base');
    await this.audit(p, v.tenant_id, 'knowledge.revision.approved', { kb: v.kb_id, reference: ref.id, revision: v.id, slug: ref.slug, ...(v.approval_run_id ? { run: v.approval_run_id } : {}) }, { version: v.version, by: by.name, author: v.author_name, sha256: v.sha256 }, ref.label);
    try {
      const body = `${versionLine(ref, v, by.name, t)}\n\n${await this.content(v)}`;
      const doc = await s.knowledge.publishControlled({ id: String(kb.id), tenant_id: v.tenant_id }, by.id ?? v.author_id, { name: `${v.title.replace(/[\\/]+/g, ' ')}.md`, label: ref.label, data: Buffer.from(body), categories: ref.categories, version: v.version });
      await this.db('knowledge_revisions').where({ id: v.id }).update({ document_id: doc.id });
    } catch (err) {
      await this.fail(v, ref, `It could not be stored for indexing: ${(err as { detail?: string }).detail ?? (err as Error).message}`);
    }
  }

  private async fail(v: RevisionRow, ref: ReferenceRow, error: string): Promise<void> {
    await this.db('knowledge_revisions').where({ id: v.id }).update({ state: 'failed', error: error.slice(0, 500), updated_at: Date.now() });
    await this.audit(null, v.tenant_id, 'knowledge.revision.failed', { kb: v.kb_id, reference: ref.id, revision: v.id, slug: ref.slug }, { version: v.version, error: error.slice(0, 500) }, ref.label);
    const tell = [v.author_id, v.decided_by].filter((x): x is string => !!x);
    await this.s().notifications.notify({ tenantId: v.tenant_id, userIds: tell, kind: 'knowledge', title: 'Knowledge revision could not be published', body: `${ref.title} ${v.version}: ${error}`.slice(0, 900), route: 'knowledge', label: ref.label });
  }

  /**
   * A knowledge document left the scan or the index (the knowledge service calls this for every document). When it
   * is the document of an approved revision: indexed, the reference moves to it and the version before goes;
   * refused, the revision failed and what was published stays as it was.
   */
  async docSettled(doc: Pick<DocRow, 'id' | 'tenant_id' | 'state' | 'error'>): Promise<void> {
    const r = await this.db('knowledge_revisions').where({ tenant_id: doc.tenant_id, document_id: doc.id, state: 'approved' }).first();
    if (!r) return;
    const v = revFrom(r);
    const ref = await this.refRow(v.tenant_id, v.reference_id);
    const s = this.s();
    if (doc.state === 'rejected' || doc.state === 'failed') {
      await s.knowledge.discard(doc.tenant_id, doc.id);
      await this.fail(v, ref, doc.error ?? `The document was ${doc.state}.`);
      return;
    }
    if (doc.state !== 'indexed' && doc.state !== 'unchanged') return;
    const t = Date.now();
    if ((await this.db('knowledge_revisions').where({ id: v.id, state: 'approved' }).update({ state: 'published', published_at: t, updated_at: t })) !== 1) return;
    if (ref.revision_id && ref.revision_id !== v.id) await this.db('knowledge_revisions').where({ id: ref.revision_id, state: 'published' }).update({ state: 'superseded', updated_at: t });
    await this.db('knowledge_references').where({ id: ref.id }).update({ state: 'published', version: v.version, revision_id: v.id, document_id: doc.id, title: v.title, updated_at: t });
    if (ref.document_id && ref.document_id !== doc.id) await s.knowledge.discard(doc.tenant_id, ref.document_id).catch((err: unknown) => s.log.warn({ document: ref.document_id, err: (err as Error).message }, 'could not remove the document of a superseded revision'));
    await this.audit(null, v.tenant_id, 'knowledge.revision.published', { kb: v.kb_id, reference: ref.id, revision: v.id, slug: ref.slug, document: doc.id }, { version: v.version, from: ref.version, number: v.number }, ref.label);
    if (v.author_id && v.author_id !== v.decided_by) await s.notifications.notify({ tenantId: v.tenant_id, userIds: [v.author_id], kind: 'knowledge', title: 'Knowledge revision published', body: `${ref.title} is now version ${v.version}, approved by ${v.decided_by_name ?? 'an approver'}.`, route: 'knowledge', label: ref.label });
  }

  /** The approver of a review run: who approved its approval step last, when they may approve this revision. */
  private async runApprover(v: RevisionRow, runId: string): Promise<{ by: { id: string; name: string } } | { refused: string }> {
    const rows = (await this.db('workflow_approvals').where({ tenant_id: v.tenant_id, run_id: runId, state: 'approved' }).orderBy('decided_at', 'desc').select('decided_by')) as { decided_by: string | null }[];
    if (!rows.length) return { refused: 'no approval step of the review run was approved' };
    let last = '';
    for (const a of rows) {
      const p = a.decided_by ? await loadPrincipal(this.s(), v.tenant_id, a.decided_by, {}) : null;
      if (!p) continue;
      const why = await this.undecidable(p, v);
      if (!why) return { by: { id: p.userId, name: p.displayName } };
      last = `${p.displayName} approved the run. ${why}`;
    }
    return { refused: last || 'the approver of the review run could not be found' };
  }

  /** The review run of a submitted revision ended (`caller_kind: knowledge-revision`): a success publishes, anything else rejects. */
  async approvalDone(tenantId: string, revisionId: string): Promise<void> {
    const r = await this.db('knowledge_revisions').where({ tenant_id: tenantId, id: revisionId }).first();
    if (!r) return;
    const v = revFrom(r);
    // The run's `knowledge_publish` step may have published it already.
    if (v.state !== 'in-review' || !v.approval_run_id) return;
    const run = (await this.db('workflow_runs').where({ id: v.approval_run_id }).first('state', 'error')) as { state: string; error: string | null } | undefined;
    if (!run || !['succeeded', 'failed', 'rejected', 'cancelled'].includes(run.state)) return;
    const ref = await this.refRow(tenantId, v.reference_id);
    if (run.state === 'succeeded') {
      const who = await this.runApprover(v, v.approval_run_id);
      if ('by' in who) return this.approve(v, ref, who.by, v.decision_reason ?? 'Approved in the review run.', null);
      return this.reject(v, ref, { id: null, name: 'Review run' }, `The review run succeeded, but ${who.refused}.`, null);
    }
    const rejecter = (await this.db('workflow_approvals as a').leftJoin('users as u', 'u.id', 'a.decided_by').where({ 'a.run_id': v.approval_run_id, 'a.state': 'rejected' }).first('a.decided_by', 'u.display_name', 'u.username')) as { decided_by: string | null; display_name: string | null; username: string | null } | undefined;
    await this.reject(v, ref, { id: rejecter?.decided_by ?? null, name: rejecter ? rejecter.display_name || rejecter.username || 'An approver' : 'Review run' }, run.state === 'rejected' ? (v.decision_reason ?? 'Rejected in the review run.') : `The review run ${run.state}${run.error ? `: ${run.error}` : ''}.`, null);
  }

  /** Takes a reference out of the base: its document goes, its revisions stay as its history. */
  async retire(p: Principal, id: string): Promise<ReferenceRow> {
    const ref = await this.refRow(p.tenantId, id);
    const d = await this.duties(p, ref.kb_id);
    if (!d.manage) throw forbidden('Retiring a reference needs the knowledge curator role or manage access to the knowledge base.', { step: 'role', action: 'knowledge:manage' });
    const open = (await this.openRevisions([ref.id])).get(ref.id);
    if (open) throw conflict(`${ref.slug} has an open revision (${open.version}, ${open.state}); withdraw or decide it first.`);
    if (ref.document_id) await this.s().knowledge.discard(p.tenantId, ref.document_id);
    await this.db('knowledge_references').where({ id: ref.id }).update({ state: 'retired', document_id: null, updated_at: Date.now() });
    await this.audit(p, p.tenantId, 'knowledge.reference.retired', { kb: ref.kb_id, reference: ref.id, slug: ref.slug }, { version: ref.version }, ref.label);
    return this.refRow(p.tenantId, id);
  }

  // ---------- the built-in tools ----------

  /**
   * `knowledge_propose`, `knowledge_revisions` and `knowledge_publish`, as the caller. What is proposed is at least at
   * the label of the call; what is read is at most at it.
   */
  async tool(ctx: ToolCallContext, op: string, args: Record<string, unknown>): Promise<unknown> {
    const p = ctx.principal;
    const str = (k: string): string | undefined => (typeof args[k] === 'string' && (args[k] as string).trim() ? (args[k] as string) : undefined);
    const reader: Principal = labelRank(p.clearance) > labelRank(ctx.label) ? { ...p, clearance: ctx.label } : p;
    const proposal = (): ProposeInput => {
      if (!str('kbId') || !str('content') || !str('summary')) throw badRequest('Give kbId, content and summary (and reference or title).');
      const bump = str('bump');
      if (bump && !(BUMPS as readonly string[]).includes(bump)) throw badRequest('bump is major, minor or patch.');
      return { kbId: str('kbId')!, reference: str('reference'), title: str('title'), content: str('content')!, summary: str('summary')!, bump: bump as Bump | undefined, version: str('version'), feature: str('feature') ?? null, label: LABELS.find((l) => l === ctx.label) ?? 'internal', ...(args.categories !== undefined ? { categories: args.categories } : {}) };
    };
    switch (op) {
      case 'knowledge_propose': {
        const v = await this.propose(p, proposal());
        const out = args.submit === false ? v : await this.submit(p, v.id);
        const ref = await this.refRow(p.tenantId, v.reference_id);
        return { revision: out.id, reference: ref.slug, referenceId: ref.id, version: out.version, state: out.state, ...(out.approval_run_id ? { reviewRun: out.approval_run_id } : {}), note: out.state === 'draft' ? 'Saved as a draft; it is not submitted.' : out.approval_run_id ? 'Submitted: a review run waits for an approver. It is published once approved and indexed.' : 'Submitted: the approvers of the knowledge base were told. It is published once approved and indexed.' };
      }
      case 'knowledge_revisions': {
        const revisionId = str('revisionId');
        if (revisionId) return this.revision(reader, revisionId, { content: args.content === true, diff: args.diff === true });
        const kbId = str('kbId');
        const reference = str('reference');
        if (reference) {
          const ref = await this.find(reader, kbId, reference);
          if (!ref) throw notFound('Reference');
          return this.reference(reader, ref.id);
        }
        if (kbId) return { references: await this.references(reader, kbId) };
        const out = [];
        for (const b of await this.s().knowledge.visible(reader)) for (const r of await this.references(reader, b.kb.id)) out.push({ ...r, kb: b.kb.name });
        return { references: out.slice(0, 300), reviews: await this.reviews(reader) };
      }
      case 'knowledge_publish': {
        if (ctx.source?.kind !== 'workflow-step') throw forbidden('knowledge_publish runs as the step of a workflow after its approval step. Use knowledge_propose to submit a revision for review.');
        const step = (await this.db('workflow_steps').where({ id: ctx.source.id, tenant_id: p.tenantId }).first('run_id')) as { run_id: string } | undefined;
        if (!step) throw notFound('Workflow step');
        let v: RevisionRow;
        const revisionId = str('revisionId');
        if (revisionId) {
          v = await this.revRow(p.tenantId, revisionId);
          if (v.state !== 'draft' && v.state !== 'in-review') throw conflict(`This revision is ${v.state}.`);
          if (v.approval_run_id && v.approval_run_id !== step.run_id) throw conflict('Another review run is deciding this revision.');
        } else v = await this.propose(p, proposal());
        const ref = await this.refRow(p.tenantId, v.reference_id);
        const who = await this.runApprover(v, step.run_id);
        if ('refused' in who) {
          // A proposal made for this call does not stay behind as a draft nobody asked for.
          if (!revisionId) {
            await this.db('knowledge_revisions').where({ id: v.id }).update({ state: 'withdrawn', error: `Not published: ${who.refused}`.slice(0, 500), updated_at: Date.now() });
            await this.dropUnpublished(ref);
          }
          throw forbidden(`Not published: ${who.refused}.`);
        }
        if (!v.approval_run_id) await this.db('knowledge_revisions').where({ id: v.id }).update({ approval_run_id: step.run_id });
        await this.approve({ ...v, approval_run_id: step.run_id }, ref, who.by, v.decision_reason ?? 'Approved in the review run.', null);
        const after = await this.revRow(p.tenantId, v.id);
        return { revision: after.id, reference: ref.slug, referenceId: ref.id, version: after.version, state: after.state, approvedBy: who.by.name, document: after.document_id, note: 'Approved. It is searchable as this version once it is indexed; the version before stays until then.' };
      }
      default:
        throw badRequest(`Unknown tool ${op}.`);
    }
  }
}
