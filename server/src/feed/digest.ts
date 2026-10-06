import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import { clears, highest, isLabel, LABELS, labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { generate } from '../apps/ai.js';
import { json } from '../db/knex.js';
import { HttpProblem, notFound } from '../http/problem.js';
import type { JobContext, Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { postFrom, type Ctx, type PostRow } from './service.js';

/*
 * Trending hashtags and the weekly workspace digest (B-2705), both as jobs.
 *
 * - `feed.trending` (every FEED_TRENDING_MINUTES, per tenant) counts the hashtags of the workspace posts published in
 *   the last FEED_TRENDING_HOURS, per workspace, tag and label; a reader sums the labels their clearance reaches, so a
 *   confidential post's tags never trend for someone cleared for internal. Group posts are left out (a private group's
 *   topics are its own).
 * - `feed.digest` (checked hourly, per tenant) writes, for each workspace with a digest profile, the digest of the
 *   last complete week (Monday 00:00 UTC to Monday): its FEED_DIGEST_TOP workspace posts labelled up to
 *   FEED_DIGEST_MAX_LABEL, ranked by reactions + 2 × comments + 3 × reposts, and a summary written by the profile
 *   through the gateway (only the gateway talks to Ollama). A digest exists once per workspace and week, so the job is
 *   idempotent; a model failure keeps the ranked list and records the error (fail soft). Members cleared for the
 *   digest's label are notified.
 */

export const TRENDING_JOB = 'feed.trending';
export const DIGEST_JOB = 'feed.digest';
const WEEK = 7 * 24 * 3_600_000;
const TOP_TAGS_PER_WORKSPACE = 50;

/** Monday 00:00 UTC of the week holding `t`. */
export function weekStartOf(t: number): number {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * 24 * 3_600_000;
}

/**
 * 1.6.0 (B-4206): the end of the last digest week: the latest `weekday` (0 Monday … 6 Sunday) at `hour`:00 UTC at or
 * before `t`. Monday 00:00 is `weekStartOf`.
 */
export function digestWeekEnd(t: number, weekday = 0, hour = 0): number {
  const mark = weekStartOf(t) + weekday * 24 * 3_600_000 + hour * 3_600_000;
  return mark <= t ? mark : mark - WEEK;
}

interface DigestPost {
  id: string;
  score: number;
  reactions: number;
  comments: number;
  reposts: number;
}

interface DigestRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  week_start: number;
  week_end: number;
  label: Label;
  state: 'ready' | 'empty' | 'failed';
  posts: DigestPost[];
  summary: string | null;
  profile: string | null;
  error: string | null;
  created_at: number;
}

const digestFrom = (r: Record<string, unknown>): DigestRow => ({
  ...(r as unknown as DigestRow),
  label: isLabel(r.label) ? r.label : 'restricted',
  week_start: Number(r.week_start),
  week_end: Number(r.week_end),
  created_at: Number(r.created_at),
  posts: json<DigestPost[]>(r.posts, [])
});

export class FeedDigests {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    const jobs = this.s().jobs;
    jobs.register(TRENDING_JOB, async (p, ctx) => this.trendingJob(String(p.tenantId ?? ctx.job.tenant_id)));
    jobs.register(DIGEST_JOB, async (p, ctx) => {
      const tenantId = String(p.tenantId ?? ctx.job.tenant_id);
      // 1.6.0 (B-4206): a test digest for one person (Social and messaging): nothing is kept or posted.
      if (p.test === true) return this.testJob(tenantId, String(p.by ?? ''), Array.isArray(p.workspaceIds) ? p.workspaceIds.map(String) : []);
      return this.digestJob(tenantId, { workspaceId: (p.workspaceId as string | undefined) ?? null, weekEnd: typeof p.weekEnd === 'number' ? p.weekEnd : null, by: (p.by as string | undefined) ?? null }, ctx);
    }, { timeoutMs: 30 * 60_000 });
  }

  schedule(scheduler: Scheduler, targets: () => Promise<{ tenantId: string; payload?: Record<string, unknown> }[]>): void {
    const cfg = this.s().cfg;
    if (cfg.FEED_TRENDING_MINUTES > 0) scheduler.every(TRENDING_JOB, cfg.FEED_TRENDING_MINUTES * 60_000, targets);
    scheduler.every(DIGEST_JOB, 60 * 60_000, targets);
  }

  // ---------- trending ----------

  async trendingJob(tenantId: string): Promise<{ workspaces: number; tags: number }> {
    const now = Date.now();
    const since = now - this.s().cfg.FEED_TRENDING_HOURS * 3_600_000;
    const rows = (await this.db('feed_hashtags as h')
      .join('feed_posts as x', 'x.id', 'h.post_id')
      .where({ 'h.tenant_id': tenantId, 'x.state': 'published' })
      .whereNull('x.group_id')
      .andWhere('h.published_at', '>=', since)
      .groupBy('h.workspace_id', 'h.tag', 'x.label')
      .select('h.workspace_id', 'h.tag', 'x.label')
      .count({ posts: '*' })
      .countDistinct({ people: 'x.author_id' })) as { workspace_id: string; tag: string; label: string; posts: number | string; people: number | string }[];
    // 1.6.0 (B-4206): the tenant's excluded tags never trend (they still work on posts and in hashtag feeds).
    const excluded = await this.s().socialAdmin.exclusions(tenantId);
    const byWorkspace = new Map<string, typeof rows>();
    for (const r of rows) if (!excluded.has(r.tag)) byWorkspace.set(r.workspace_id, [...(byWorkspace.get(r.workspace_id) ?? []), r]);
    const keep: Record<string, unknown>[] = [];
    for (const [ws, list] of byWorkspace) {
      list.sort((a, b) => Number(b.posts) - Number(a.posts) || Number(b.people) - Number(a.people) || a.tag.localeCompare(b.tag));
      for (const r of list.slice(0, TOP_TAGS_PER_WORKSPACE * LABELS.length)) keep.push({ tenant_id: tenantId, workspace_id: ws, tag: r.tag, label: r.label, posts: Number(r.posts), people: Number(r.people), window_start: since, computed_at: now });
    }
    await this.db.transaction(async (trx) => {
      await trx('feed_trending').where({ tenant_id: tenantId }).delete();
      for (let i = 0; i < keep.length; i += 200) await trx('feed_trending').insert(keep.slice(i, i + 200));
    });
    return { workspaces: byWorkspace.size, tags: keep.length };
  }

  /** The trending tags of one workspace (or all the caller's), counting only posts at labels the caller is cleared for. */
  async trending(p: Principal, workspaces: string[], limit = 20) {
    if (!workspaces.length) return { tags: [], computedAt: null, windowStart: null };
    const labels = LABELS.filter((l) => clears(p.clearance, l));
    const rows = (await this.db('feed_trending').where({ tenant_id: p.tenantId }).whereIn('workspace_id', workspaces).whereIn('label', labels)) as { tag: string; posts: number | string; people: number | string; computed_at: number | string; window_start: number | string }[];
    const excluded = await this.s().socialAdmin.exclusions(p.tenantId);
    const by = new Map<string, { tag: string; posts: number; people: number }>();
    for (const r of rows) {
      if (excluded.has(r.tag)) continue; // excluded since the last run
      const e = by.get(r.tag) ?? { tag: r.tag, posts: 0, people: 0 };
      e.posts += Number(r.posts);
      e.people = Math.max(e.people, Number(r.people));
      by.set(r.tag, e);
    }
    const tags = [...by.values()].sort((a, b) => b.posts - a.posts || b.people - a.people || a.tag.localeCompare(b.tag)).slice(0, limit);
    const first = rows[0];
    return { tags, computedAt: first ? Number(first.computed_at) : null, windowStart: first ? Number(first.window_start) : null };
  }

  // ---------- settings ----------

  async settings(tenantId: string, workspaceId: string): Promise<{ digestEnabled: boolean; digestProfile: string | null; effectiveProfile: string | null; updatedBy: string | null; updatedAt: number | null }> {
    const r = (await this.db('feed_settings').where({ tenant_id: tenantId, workspace_id: workspaceId }).first()) as { digest_enabled: number | boolean; digest_profile: string | null; updated_by: string | null; updated_at: number | string } | undefined;
    // 1.6.0 (B-4206): the tenant's digest profile (Social and messaging) before FEED_DIGEST_PROFILE.
    const fallback = (await this.s().socialAdmin.tenantSettings(tenantId)).digestProfile ?? this.s().cfg.FEED_DIGEST_PROFILE ?? null;
    const enabled = r ? !!r.digest_enabled : true;
    const profile = r?.digest_profile ?? null;
    return { digestEnabled: enabled, digestProfile: profile, effectiveProfile: enabled ? (profile ?? fallback) : null, updatedBy: r?.updated_by ?? null, updatedAt: r ? Number(r.updated_at) : null };
  }

  async setSettings(ctx: Ctx, workspaceId: string, input: { digestEnabled?: boolean | undefined; digestProfile?: string | null | undefined }) {
    const s = this.s();
    const p = ctx.p;
    const before = await this.settings(p.tenantId, workspaceId);
    if (input.digestProfile) {
      try {
        await s.gateway.resolve(p.tenantId, input.digestProfile);
      } catch (err) {
        if (err instanceof HttpProblem) throw new HttpProblem(422, 'Unknown profile', `Profile ${input.digestProfile} cannot write digests: ${err.detail ?? err.message}`);
        throw err;
      }
    }
    const row = { digest_enabled: input.digestEnabled ?? before.digestEnabled, digest_profile: input.digestProfile === undefined ? before.digestProfile : input.digestProfile, updated_by: p.userId, updated_at: Date.now() };
    const n = await this.db('feed_settings').where({ tenant_id: p.tenantId, workspace_id: workspaceId }).update(row);
    if (!n) await this.db('feed_settings').insert({ tenant_id: p.tenantId, workspace_id: workspaceId, ...row });
    await s.audit.append({ tenantId: p.tenantId, action: 'feed.settings.updated', kind: 'admin', actor: actorFrom(p, ctx.ip), target: { workspace: workspaceId }, detail: { before: { digestEnabled: before.digestEnabled, digestProfile: before.digestProfile }, after: { digestEnabled: row.digest_enabled, digestProfile: row.digest_profile } }, label: 'internal', traceId: ctx.traceId ?? null });
    return this.settings(p.tenantId, workspaceId);
  }

  // ---------- digests ----------

  /** Asks for a digest of the last seven days now (a job). */
  async request(ctx: Ctx, workspaceId: string) {
    const s = this.s();
    const p = ctx.p;
    const st = await this.settings(p.tenantId, workspaceId);
    if (!st.effectiveProfile) throw new HttpProblem(409, 'No digest profile', 'Set a digest profile for this workspace (or FEED_DIGEST_PROFILE) and enable digests first.');
    const job = await s.jobs.enqueue({ tenantId: p.tenantId, type: DIGEST_JOB, payload: { tenantId: p.tenantId, workspaceId, weekEnd: Date.now(), by: p.userId }, createdBy: p.userId, dedupeKey: `${DIGEST_JOB}:${workspaceId}:manual:${Math.floor(Date.now() / 60_000)}`, maxAttempts: 1 });
    await s.audit.append({ tenantId: p.tenantId, action: 'feed.digest.requested', kind: 'admin', actor: actorFrom(p, ctx.ip), target: { workspace: workspaceId, job: job.id }, label: 'internal', traceId: ctx.traceId ?? null });
    return { jobId: job.id, workspaceId };
  }

  async digestJob(tenantId: string, o: { workspaceId: string | null; weekEnd: number | null; by: string | null }, ctx?: JobContext) {
    const now = Date.now();
    const t = await this.s().socialAdmin.tenantSettings(tenantId);
    const weekEnd = o.weekEnd ?? digestWeekEnd(now, t.digestDay ?? 0, t.digestHour ?? 0);
    const weekStart = weekEnd - WEEK;
    const workspaces = ((await this.db('workspaces').where({ tenant_id: tenantId, state: 'active' }).modify((q) => (o.workspaceId ? q.andWhere({ id: o.workspaceId }) : q)).select('id', 'name')) as { id: string; name: string }[]);
    const written: string[] = [];
    for (const [i, w] of workspaces.entries()) {
      if (ctx?.signal.aborted) break;
      const st = await this.settings(tenantId, w.id);
      if (!st.effectiveProfile) continue;
      if (await this.db('feed_digests').where({ tenant_id: tenantId, workspace_id: w.id, week_start: weekStart }).first('id')) continue;
      const d = await this.write(tenantId, w, st.effectiveProfile, weekStart, weekEnd, o.by);
      if (d) written.push(d.id);
      await ctx?.progress(Math.round(((i + 1) / workspaces.length) * 100), w.name);
    }
    return { weekStart, weekEnd, digests: written.length };
  }

  /**
   * 1.6.0 (B-4206): a test digest of the last seven days for the requester alone, over the workspaces named (those
   * they may act in now with a digest profile). Nothing is stored and nobody else is told; the result is a notification
   * to the requester saying what the digest would hold, or that the model failed and the ranked list would be sent.
   */
  async testJob(tenantId: string, userId: string, workspaceIds: string[]) {
    const s = this.s();
    const now = Date.now();
    const out: { workspaceId: string; posts: number; state: string }[] = [];
    const ws = (await this.db('workspaces').where({ tenant_id: tenantId, state: 'active' }).whereIn('id', workspaceIds).select('id', 'name')) as { id: string; name: string }[];
    const me = (await this.db('users').where({ tenant_id: tenantId, id: userId }).first('clearance')) as { clearance: string } | undefined;
    if (!me || !isLabel(me.clearance)) return { test: true, workspaces: out };
    for (const w of ws) {
      const st = await this.settings(tenantId, w.id);
      if (!st.effectiveProfile) continue;
      const r = await this.rank(tenantId, w, st.effectiveProfile, now - WEEK, now, userId, true);
      out.push({ workspaceId: w.id, posts: r.posts.length, state: r.state });
      if (!clears(me.clearance, r.label)) continue; // never above the requester's clearance
      const body = r.state === 'failed' ? `The model failed (${(r.error ?? '').slice(0, 120)}); members would receive the ranked list of ${r.posts.length} posts.` : r.state === 'empty' ? 'No posts this week; no digest would be sent.' : `${r.posts.length} posts, summarised by ${st.effectiveProfile}: ${(r.summary ?? '').slice(0, 220)}`;
      await s.notifications.notify({ tenantId, userIds: [userId], kind: 'feed', title: `Test digest for ${w.name}`, body, route: 'social?tab=feed', label: r.label });
    }
    return { test: true, workspaces: out };
  }

  /** Ranks the week's workspace posts and has the profile write the summary. */
  private async write(tenantId: string, w: { id: string; name: string }, profile: string, weekStart: number, weekEnd: number, by: string | null): Promise<DigestRow | null> {
    const s = this.s();
    const { id, label, state, posts, summary, error } = await this.rank(tenantId, w, profile, weekStart, weekEnd, by, false);
    const row = { id, tenant_id: tenantId, workspace_id: w.id, week_start: weekStart, week_end: weekEnd, label, state, posts: JSON.stringify(posts), summary: summary ? await s.keys.seal(tenantId, summary, `feed-digest:${id}`) : null, profile, error, created_at: Date.now() };
    try {
      await this.db('feed_digests').insert(row);
    } catch {
      // Another instance wrote this week's digest meanwhile.
      return null;
    }
    await s.audit.append({ tenantId, action: 'feed.digest.created', kind: 'system', actor: { service: 'feed' }, target: { workspace: w.id, digest: id }, detail: { state, posts: posts.length, profile, weekStart: new Date(weekStart).toISOString(), error }, label });
    if (state === 'ready') {
      const members = (await s.tenants.members(w.id)).filter((m) => m.state === 'active' && isLabel(m.clearance) && clears(m.clearance, label)).map((m) => m.user_id);
      await s.notifications.notify({ tenantId, userIds: members, kind: 'feed', title: `This week in ${w.name}`, body: `The ${posts.length} most discussed posts of the week`, route: `feed?digest=${id}`, label });
    }
    return digestFrom(row);
  }

  /** The week's ranked posts and the profile's summary (fail soft: a model failure keeps the ranked list). */
  private async rank(tenantId: string, w: { id: string; name: string }, profile: string, weekStart: number, weekEnd: number, by: string | null, test: boolean): Promise<{ id: string; label: Label; state: DigestRow['state']; posts: DigestPost[]; summary: string | null; error: string | null }> {
    const s = this.s();
    const cfg = s.cfg;
    const t = await s.socialAdmin.tenantSettings(tenantId);
    const maxLabel = t.digestMaxLabel ?? cfg.FEED_DIGEST_MAX_LABEL;
    const top = t.digestTop ?? cfg.FEED_DIGEST_TOP;
    const labels = LABELS.filter((l) => labelRank(l) <= labelRank(maxLabel));
    const candidates = ((await this.db('feed_posts').where({ tenant_id: tenantId, workspace_id: w.id, state: 'published' }).whereNull('group_id').whereNotNull('body').whereIn('label', labels).andWhere('published_at', '>=', weekStart).andWhere('published_at', '<', weekEnd).orderBy('published_at', 'desc').limit(2000)) as Record<string, unknown>[]).map(postFrom);
    const ids = candidates.map((x) => x.id);
    const count = async (table: string, col: string, extra: Record<string, unknown> = {}) => {
      const m = new Map<string, number>();
      for (let i = 0; i < ids.length; i += 500) {
        const rows = (await this.db(table).whereIn(col, ids.slice(i, i + 500)).where(extra).groupBy(col).select(col).count({ n: '*' })) as Record<string, string | number>[];
        for (const r of rows) m.set(String(r[col]), Number(r.n));
      }
      return m;
    };
    const [reactions, comments, reposts] = ids.length ? await Promise.all([count('feed_reactions', 'post_id'), count('feed_comments', 'post_id', { state: 'published' }), count('feed_posts', 'repost_of', { state: 'published' })]) : [new Map<string, number>(), new Map<string, number>(), new Map<string, number>()];
    const ranked = candidates
      .map((x) => {
        const r = reactions.get(x.id) ?? 0;
        const c = comments.get(x.id) ?? 0;
        const rp = reposts.get(x.id) ?? 0;
        return { x, post: { id: x.id, score: r + 2 * c + 3 * rp, reactions: r, comments: c, reposts: rp } };
      })
      .sort((a, b) => b.post.score - a.post.score || (b.x.published_at ?? 0) - (a.x.published_at ?? 0))
      .slice(0, top);
    const id = ulid();
    const label = ranked.length ? highest(...ranked.map((r) => r.x.label)) : 'public';
    let state: DigestRow['state'] = ranked.length ? 'ready' : 'empty';
    let summary: string | null = null;
    let error: string | null = null;
    if (ranked.length) {
      try {
        summary = (await generate(s, { tenantId, workspaceId: w.id, profile, system: DIGEST_SYSTEM, prompt: await this.prompt(tenantId, w.name, ranked.map((r) => r.x), ranked.map((r) => r.post)), label, principal: null, userId: by, source: { kind: test ? 'feed-digest-test' : 'feed-digest', id } })).trim();
      } catch (err) {
        state = 'failed';
        error = (err as Error).message.slice(0, 500);
      }
    }
    return { id, label, state, posts: ranked.map((r) => r.post), summary, error };
  }

  private async prompt(tenantId: string, workspace: string, posts: PostRow[], ranked: DigestPost[]): Promise<string> {
    const s = this.s();
    const names = new Map(((await this.db('users').where({ tenant_id: tenantId }).whereIn('id', posts.map((x) => x.author_id)).select('id', 'display_name')) as { id: string; display_name: string }[]).map((u) => [u.id, u.display_name]));
    const lines = [];
    for (const [i, x] of posts.entries()) {
      const text = x.body ? ((await s.keys.open(tenantId, x.body, `feed-post:${x.id}`)) ?? '') : '';
      const r = ranked[i]!;
      lines.push(`${i + 1}. ${names.get(x.author_id) ?? 'Someone'} (${r.reactions} reactions, ${r.comments} comments, ${r.reposts} reposts): ${text.replace(/\s+/g, ' ').slice(0, 600)}`);
    }
    return `Workspace: ${workspace}\nThe top posts of the week, most discussed first:\n\n${lines.join('\n')}`;
  }

  /** Digests of a workspace the caller may read (labels above their clearance are left out), newest first. */
  async list(p: Principal, workspaceId: string, limit = 20) {
    const labels = LABELS.filter((l) => clears(p.clearance, l));
    const rows = ((await this.db('feed_digests').where({ tenant_id: p.tenantId, workspace_id: workspaceId }).whereIn('label', labels).orderBy('week_start', 'desc').limit(limit)) as Record<string, unknown>[]).map(digestFrom);
    return rows.map((d) => ({ id: d.id, workspaceId: d.workspace_id, weekStart: d.week_start, weekEnd: d.week_end, label: d.label, state: d.state, posts: d.posts.length, createdAt: d.created_at }));
  }

  /** One digest: its summary and its ranked posts, each as the caller may see it now (or null). */
  async get(p: Principal, id: string, workspaces: string[], views: (ids: string[]) => Promise<Map<string, unknown>>) {
    const r = await this.db('feed_digests').where({ tenant_id: p.tenantId, id }).first();
    if (!r) throw notFound('Digest');
    const d = digestFrom(r);
    if (!workspaces.includes(d.workspace_id) || !clears(p.clearance, d.label)) throw notFound('Digest');
    const seen = await views(d.posts.map((x) => x.id));
    return {
      id: d.id,
      workspaceId: d.workspace_id,
      weekStart: d.week_start,
      weekEnd: d.week_end,
      label: d.label,
      state: d.state,
      profile: d.profile,
      error: d.error,
      summary: d.summary ? ((await this.s().keys.open(p.tenantId, d.summary, `feed-digest:${d.id}`)) ?? null) : null,
      posts: d.posts.map((x) => ({ ...x, post: seen.get(x.id) ?? null })),
      createdAt: d.created_at
    };
  }
}

const DIGEST_SYSTEM =
  'You write the weekly digest of a workspace feed for its members. Summarise every post listed, in the order given, in one or two plain sentences each, naming its author. Do not add posts, links or facts that are not in the list. Plain text, no headings.';
