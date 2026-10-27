import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { LABELS, labelRank } from '../authz/labels.js';
import type { Permission } from '../authz/permissions.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';
import { isPlatformAdmin } from './jobs-admin.js';

/*
 * 1.8.0, Sprint 48 (B-148): the Overview's cards, arranged by each admin. The cards are the parts the Overview
 * already computes (`ops/overview.ts` and the route), plus four optional ones an admin may add: running workflows, SLA
 * items breaching soon, approvals waiting on them and knowledge revisions waiting for review.
 *
 * Each person keeps an order, a set pinned to the top, a set hidden and a density in `overview_prefs`. What a person
 * may see is decided every time the page is read, never stored: a card whose permission they lack is not listed, not
 * computed and not accepted in their layout, and one they lose later simply stops appearing (their saved layout keeps
 * it, so it comes back if the permission does). Reset deletes the row.
 */

export const DENSITIES = ['comfortable', 'compact'] as const;
export type Density = (typeof DENSITIES)[number];

export interface CardDef {
  id: string;
  title: string;
  description: string;
  /** Optional cards start hidden: the admin adds them. */
  optional: boolean;
  /** Who may see it: a permission, platform administration, or a check of its own. */
  may: (p: Principal, s: Services) => boolean;
}

const has = (perm: Permission) => (p: Principal) => effectivePermissions(p).has(perm);

export const CARDS: readonly CardDef[] = [
  { id: 'alerts', title: 'Alerts', description: 'Open alerts from the watches: schema, instances, backups, zones, certificates and rate limits.', optional: false, may: () => true },
  { id: 'counters', title: 'Counters', description: 'Jobs, flags, held replies, sign-ins and workspaces for the window.', optional: false, may: () => true },
  { id: 'instances', title: 'Instances', description: 'Every server process with its /readyz checks (system admins).', optional: false, may: (p) => isPlatformAdmin(p) },
  { id: 'schedules', title: 'Scheduled work', description: 'The next scheduled jobs and how they last ran.', optional: false, may: () => true },
  { id: 'audit', title: 'Recent audit', description: 'The newest audit entries of the tenant.', optional: false, may: has('audit:read') },
  { id: 'capacity', title: 'Capacity', description: 'Database, vectors, blob store, cache and rate-limit store (system admins).', optional: false, may: (p) => isPlatformAdmin(p) },
  { id: 'plugins', title: 'Plugin cards', description: 'Approved dashboard surfaces of enabled plugins.', optional: false, may: () => true },
  { id: 'workflows-running', title: 'Running workflows', description: 'Workflow runs running or waiting now, at or below your clearance.', optional: true, may: has('workflows:manage') },
  { id: 'sla-breaching', title: 'SLA breaching soon', description: 'Queue items in their warning band or past a target, in the queues you review.', optional: true, may: (p, s) => s.sla.readableTypes(p).length > 0 },
  { id: 'approvals-pending', title: 'Pending approvals', description: 'Workflow approvals waiting for you to decide.', optional: true, may: () => true },
  { id: 'revisions-waiting', title: 'Revisions waiting', description: 'Knowledge revisions waiting for you as an approver.', optional: true, may: has('knowledge:read') },
  // 1.9.0, Sprint 50 (B-158): guardrail and moderation trends (daily aggregates, no content).
  { id: 'moderation-trends', title: 'Moderation trends', description: 'Guardrail decisions by action, the false-positive rate from upheld appeals, time to decision and spam responses over 14 days.', optional: true, may: has('moderation:review') }
];
const byId = new Map(CARDS.map((c) => [c.id, c]));
export const CARD_IDS = CARDS.map((c) => c.id);

export const prefsBody = z
  .object({
    order: z.array(z.string().max(40)).max(CARDS.length),
    pinned: z.array(z.string().max(40)).max(CARDS.length).default([]),
    hidden: z.array(z.string().max(40)).max(CARDS.length).default([]),
    density: z.enum(DENSITIES).default('comfortable')
  })
  .strict();
export type PrefsInput = z.infer<typeof prefsBody>;

interface Stored {
  order: string[];
  pinned: string[];
  hidden: string[];
  density: Density;
}

const DEFAULT: Stored = { order: CARD_IDS, pinned: [], hidden: CARDS.filter((c) => c.optional).map((c) => c.id), density: 'comfortable' };

export class OverviewCards {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  /** The cards the principal may see, in catalogue order. */
  available(p: Principal): CardDef[] {
    const s = this.s();
    return CARDS.filter((c) => c.may(p, s));
  }

  private async stored(p: Principal): Promise<{ prefs: Stored; saved: boolean; updatedAt: number | null }> {
    const r = (await this.db('overview_prefs').where({ tenant_id: p.tenantId, user_id: p.userId }).first()) as { cards: string; density: string; updated_at: number | string } | undefined;
    if (!r) return { prefs: DEFAULT, saved: false, updatedAt: null };
    const c = json<Partial<Stored>>(r.cards, {});
    return { prefs: { order: c.order ?? DEFAULT.order, pinned: c.pinned ?? [], hidden: c.hidden ?? DEFAULT.hidden, density: (DENSITIES as readonly string[]).includes(r.density) ? (r.density as Density) : 'comfortable' }, saved: true, updatedAt: Number(r.updated_at) };
  }

  /**
   * The person's layout over what they may see: every available card once, pinned first, then the rest in their
   * order (cards new since they saved go last), each with whether it is shown.
   */
  async layout(p: Principal) {
    const avail = this.available(p);
    const ids = new Set(avail.map((c) => c.id));
    const { prefs, saved, updatedAt } = await this.stored(p);
    const ordered = [...prefs.order.filter((id) => ids.has(id)), ...avail.map((c) => c.id).filter((id) => !prefs.order.includes(id))];
    const unique = [...new Set(ordered)];
    const pinned = unique.filter((id) => prefs.pinned.includes(id));
    const rest = unique.filter((id) => !prefs.pinned.includes(id));
    // A card that is new since the person saved is shown unless it is optional.
    const hidden = new Set([...prefs.hidden.filter((id) => ids.has(id)), ...(saved ? avail.filter((c) => c.optional && !prefs.order.includes(c.id)).map((c) => c.id) : [])]);
    const cards = [...pinned, ...rest].map((id) => {
      const c = byId.get(id)!;
      return { id, title: c.title, description: c.description, optional: c.optional, pinned: pinned.includes(id), hidden: hidden.has(id) };
    });
    return { cards, density: prefs.density, saved, updatedAt, visible: cards.filter((c) => !c.hidden).map((c) => c.id) };
  }

  /** Saves the person's layout. Every id must be a card they may see now; one they may not is refused, not stored. */
  async save(p: Principal, input: PrefsInput, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    const ids = new Set(this.available(p).map((c) => c.id));
    const named = [...input.order, ...input.pinned, ...input.hidden];
    const unknown = named.filter((id) => !byId.has(id));
    if (unknown.length) throw new HttpProblem(400, 'Invalid request', `There is no Overview card ${unknown[0]}.`, { extensions: { errors: unknown.map((id) => ({ path: 'cards', message: `${id} is not a card` })) } });
    const refused = [...new Set(named.filter((id) => !ids.has(id)))];
    if (refused.length) throw new HttpProblem(403, 'Forbidden', `You may not see the card ${refused.join(', ')}.`, { extensions: { step: 'permission', cards: refused } });
    if (new Set(input.order).size !== input.order.length) throw new HttpProblem(400, 'Invalid request', 'Each card once in the order.');
    const before = await this.stored(p);
    const cards = { order: input.order, pinned: [...new Set(input.pinned)], hidden: [...new Set(input.hidden)] };
    const t = Date.now();
    await this.db.transaction(async (trx) => {
      await trx('overview_prefs').where({ tenant_id: p.tenantId, user_id: p.userId }).delete();
      await trx('overview_prefs').insert({ tenant_id: p.tenantId, user_id: p.userId, cards: JSON.stringify(cards), density: input.density, updated_at: t });
    });
    await this.s().audit.append({ tenantId: p.tenantId, action: 'overview.cards.updated', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { user: p.userId }, label: 'internal', detail: { before: before.saved ? { ...before.prefs } : null, after: { ...cards, density: input.density } }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    return this.layout(p);
  }

  /** Back to the default layout. */
  async reset(p: Principal, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    const n = await this.db('overview_prefs').where({ tenant_id: p.tenantId, user_id: p.userId }).delete();
    if (n) await this.s().audit.append({ tenantId: p.tenantId, action: 'overview.cards.reset', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { user: p.userId }, label: 'internal', detail: {}, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    return this.layout(p);
  }

  /**
   * The optional cards' figures, for those of `want` the person may see (others are left out, never computed).
   * Each is computed as the person, through the domain's own reader.
   */
  async extras(p: Principal, want: string[]) {
    const s = this.s();
    const may = new Set(this.available(p).map((c) => c.id));
    const pick = want.filter((id) => may.has(id) && byId.get(id)?.optional);
    const out: Record<string, unknown> = {};
    for (const id of pick) {
      try {
        if (id === 'workflows-running') {
          const labels = LABELS.filter((l) => labelRank(l) <= labelRank(p.clearance));
          const rows = (await s.db('workflow_runs as r').leftJoin('workflows as w', 'w.id', 'r.workflow_id').where({ 'r.tenant_id': p.tenantId }).whereIn('r.state', ['running', 'waiting']).whereIn('r.label', labels).orderBy('r.created_at', 'desc').limit(200).select('r.id', 'r.state', 'r.started_at', 'r.created_at', 'w.name')) as { id: string; state: string; started_at: number | string | null; created_at: number | string; name: string | null }[];
          out[id] = { running: rows.filter((r) => r.state === 'running').length, waiting: rows.filter((r) => r.state === 'waiting').length, items: rows.slice(0, 5).map((r) => ({ id: r.id, workflow: r.name, state: r.state, since: Number(r.started_at ?? r.created_at) })) };
        } else if (id === 'sla-breaching') {
          let warning = 0;
          let breached = 0;
          const byType: { type: string; warning: number; breached: number }[] = [];
          for (const type of s.sla.readableTypes(p)) {
            const r = await s.sla.items(p, type, { filter: 'breaching-soon' }).catch(() => null);
            if (!r) continue;
            warning += r.counts.warning;
            breached += r.counts.breached;
            byType.push({ type, warning: r.counts.warning, breached: r.counts.breached });
          }
          out[id] = { warning, breached, byType };
        } else if (id === 'approvals-pending') {
          const list = (await s.workflows.pendingApprovals(p)) as { id: string; workflow: string | null; step: string; created_at?: number }[];
          out[id] = { count: list.length, items: list.slice(0, 5).map((a) => ({ id: a.id, workflow: a.workflow, step: a.step })) };
        } else if (id === 'revisions-waiting') {
          const r = await s.knowledgeRevisions.reviews(p);
          out[id] = { count: r.waiting.length, decidable: r.waiting.filter((w) => w.mayDecide).length, items: r.waiting.slice(0, 5).map((w) => ({ id: w.id, title: w.reference.title, version: w.version, kb: w.kb })) };
        } else if (id === 'moderation-trends') {
          const t = await s.moderationMetrics.trend(p, 14);
          out[id] = { totals: t.totals, series: t.series.map((d) => ({ day: d.day, decisions: d.decisions, block: d.block, redact: d.redact, annotate: d.annotate, spam: Object.values(d.spam).reduce((a, b) => a + b, 0) })), topRules: t.topRules.slice(0, 3) };
        }
      } catch (err) {
        s.log.warn({ card: id, err: (err as Error).message }, 'an Overview card could not be computed');
        out[id] = { error: 'This card could not be read just now.' };
      }
    }
    return out;
  }
}
