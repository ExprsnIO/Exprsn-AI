import { hostname } from 'node:os';
import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import { csvLine } from '../audit/exports.js';
import { clears, isLabel, LABELS, type Label } from '../authz/labels.js';
import { rolesGranting } from '../authz/permissions.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { TRENDING_JOB, DIGEST_JOB } from '../feed/digest.js';
import { normaliseTag } from '../feed/tags.js';
import { JOIN_MODES, VISIBILITIES, type JoinMode, type Visibility } from '../groups/service.js';
import { workspacesFor } from '../http/middleware.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { TOPICS } from '../platform/bus.js';
import type { Workspace } from '../repos/tenants.js';
import type { Services } from '../services.js';

/*
 * Social and messaging administration (1.6.0, B-4206): the policies and health views behind the Social and messaging
 * screen, for every workspace an administrator may act in at once. Decisions (design/platform-admin/DECISIONS.md):
 * social:manage governs the feed, group, messaging and relations policies (Q4); the moderation-facing parts (whether
 * posts pass user-input in full, who approves held posts) also need moderation:manage; exporting another member's
 * conversation for a legal hold is under dual control, approved by a second platform admin (Q5); Realtime is a
 * platform view (platform:manage).
 *
 * Workspace policies (`social_workspace_policies`) are read by the domains where they apply: the feed (`feedGuard`,
 * `feedMedia`, `feedMediaMaxBytes` at post time, `feedApprover` when a held post is decided), groups (`groupCreate`,
 * the defaults a new group or event starts with) and social relations (`contactRule`, when a conversation is started
 * or someone added). A workspace without a row has the defaults below.
 */

export const FEED_APPROVERS = ['reviewers', 'feed', 'guardrails', 'moderators'] as const;
export type FeedApprover = (typeof FEED_APPROVERS)[number];
export const GROUP_CREATORS = ['members', 'admins'] as const;
export type GroupCreator = (typeof GROUP_CREATORS)[number];
export const WORKSPACE_CONTACT_RULES = ['workspace', 'contacts', 'admins'] as const;
export type WorkspaceContactRule = (typeof WORKSPACE_CONTACT_RULES)[number];
export const EXPORT_JOB = 'messaging.conversation.export';
export const EXPORT_MAX_MESSAGES = 50_000;
export const MEDIA_MAX_BYTES = 1024 * 1024 * 1024;

export interface WorkspacePolicy {
  workspaceId: string;
  feedGuard: boolean;
  feedApprover: FeedApprover;
  feedMedia: boolean;
  feedMediaMaxBytes: number | null;
  groupCreate: GroupCreator;
  groupVisibility: Visibility;
  groupJoin: JoinMode;
  eventCapacity: number | null;
  contactRule: WorkspaceContactRule;
  updatedBy: string | null;
  updatedAt: number | null;
}

export type PolicyPatch = Partial<Omit<WorkspacePolicy, 'workspaceId' | 'updatedBy' | 'updatedAt'>>;

export interface TenantSettings {
  digestProfile: string | null;
  digestDay: number | null;
  digestHour: number | null;
  digestTop: number | null;
  digestMaxLabel: Label | null;
  summaryProfile: string | null;
  updatedBy: string | null;
  updatedAt: number | null;
}

export type SettingsPatch = Partial<Omit<TenantSettings, 'updatedBy' | 'updatedAt'>>;

export type ExportState = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'ready' | 'failed';

interface ExportRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  workspace_id: string | null;
  label: Label;
  reason: string;
  requested_by: string;
  approver_id: string | null;
  state: ExportState;
  decided_by: string | null;
  decided_at: number | null;
  note: string | null;
  job_id: string | null;
  file: string | null;
  blob_key: string | null;
  messages: number | null;
  error: string | null;
  downloaded_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface Ctx {
  p: Principal;
  ip: string | null;
  traceId?: string | null;
}

const DEFAULT_POLICY: Omit<WorkspacePolicy, 'workspaceId'> = { feedGuard: true, feedApprover: 'reviewers', feedMedia: true, feedMediaMaxBytes: null, groupCreate: 'members', groupVisibility: 'private', groupJoin: 'request', eventCapacity: null, contactRule: 'workspace', updatedBy: null, updatedAt: null };
const pick = <T extends string>(list: readonly T[], v: unknown, d: T): T => ((list as readonly string[]).includes(String(v)) ? (v as T) : d);
const numOrNull = (v: unknown) => (v == null ? null : Number(v));
const DAY = 86_400_000;
const startOfDay = (t: number) => t - (t % DAY);

const policyFrom = (workspaceId: string, r: Record<string, unknown> | undefined): WorkspacePolicy =>
  r
    ? {
        workspaceId,
        feedGuard: !!r.feed_guard,
        feedApprover: pick(FEED_APPROVERS, r.feed_approver, 'reviewers'),
        feedMedia: !!r.feed_media,
        feedMediaMaxBytes: numOrNull(r.feed_media_max_bytes),
        groupCreate: pick(GROUP_CREATORS, r.group_create, 'members'),
        groupVisibility: pick(VISIBILITIES, r.group_visibility, 'private'),
        groupJoin: pick(JOIN_MODES, r.group_join, 'request'),
        eventCapacity: numOrNull(r.event_capacity),
        contactRule: pick(WORKSPACE_CONTACT_RULES, r.contact_rule, 'workspace'),
        updatedBy: (r.updated_by as string | null) ?? null,
        updatedAt: numOrNull(r.updated_at)
      }
    : { workspaceId, ...DEFAULT_POLICY };

const exportFrom = (r: Record<string, unknown>): ExportRow => ({ ...(r as unknown as ExportRow), label: isLabel(r.label) ? r.label : 'restricted', decided_at: numOrNull(r.decided_at), messages: numOrNull(r.messages), downloaded_at: numOrNull(r.downloaded_at), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

export class SocialAdmin {
  readonly instance = `${hostname()}:${process.pid}`;

  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    this.s().jobs.register(EXPORT_JOB, async (p) => this.exportJob(String(p.exportId ?? '')), { timeoutMs: 30 * 60_000 });
  }

  private async audit(ctx: Ctx, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>, label: Label = 'internal'): Promise<void> {
    await this.s().audit.append({ tenantId: ctx.p.tenantId, action, kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target, ...(detail ? { detail } : {}), label, traceId: ctx.traceId ?? null });
  }

  /** The workspaces the caller administers here: those they may act in. */
  async workspaces(p: Principal): Promise<Workspace[]> {
    return workspacesFor(this.s(), p);
  }

  private async workspaceOf(p: Principal, id: string): Promise<Workspace> {
    const w = (await this.workspaces(p)).find((x) => x.id === id);
    if (!w) throw notFound('Workspace');
    return w;
  }

  private async names(tenantId: string, ids: (string | null)[]): Promise<Map<string, { username: string; displayName: string }>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    const out = new Map<string, { username: string; displayName: string }>();
    for (let i = 0; i < list.length; i += 500) {
      const rows = (await this.db('users').where({ tenant_id: tenantId }).whereIn('id', list.slice(i, i + 500)).select('id', 'username', 'display_name')) as { id: string; username: string; display_name: string }[];
      for (const r of rows) out.set(r.id, { username: r.username, displayName: r.display_name });
    }
    return out;
  }

  private async count(q: Promise<{ n: number | string }[]> | PromiseLike<unknown>): Promise<number> {
    const rows = (await q) as { n: number | string }[];
    return Number(rows[0]?.n ?? 0);
  }

  // ---------- policies (read by the domains) ----------

  async policy(tenantId: string, workspaceId: string): Promise<WorkspacePolicy> {
    const r = (await this.db('social_workspace_policies').where({ tenant_id: tenantId, workspace_id: workspaceId }).first()) as Record<string, unknown> | undefined;
    return policyFrom(workspaceId, r);
  }

  async policies(tenantId: string, workspaceIds: string[]): Promise<Map<string, WorkspacePolicy>> {
    const out = new Map<string, WorkspacePolicy>();
    if (!workspaceIds.length) return out;
    const rows = (await this.db('social_workspace_policies').where({ tenant_id: tenantId }).whereIn('workspace_id', workspaceIds)) as Record<string, unknown>[];
    const by = new Map(rows.map((r) => [String(r.workspace_id), r]));
    for (const w of workspaceIds) out.set(w, policyFrom(w, by.get(w)));
    return out;
  }

  /**
   * Changes a workspace's policy. Whether posts pass user-input in full and who approves held posts are the
   * moderation-facing parts (decision Q4): they also need moderation:manage. Audited `social.policy.updated` with the
   * fields before and after; turning the full check off is marked `weakened`.
   */
  async setPolicy(ctx: Ctx, workspaceId: string, patch: PolicyPatch): Promise<WorkspacePolicy> {
    const p = ctx.p;
    const w = await this.workspaceOf(p, workspaceId);
    const before = await this.policy(p.tenantId, w.id);
    if ((patch.feedGuard !== undefined && patch.feedGuard !== before.feedGuard) || (patch.feedApprover !== undefined && patch.feedApprover !== before.feedApprover)) {
      if (!effectivePermissions(p).has('moderation:manage')) throw forbidden('Whether posts pass user-input and who approves held posts need moderation:manage.', { step: 'permission', permission: 'moderation:manage' });
    }
    const next = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as WorkspacePolicy;
    if (!next.feedMedia) next.feedMediaMaxBytes = null;
    const row = {
      feed_guard: next.feedGuard,
      feed_approver: next.feedApprover,
      feed_media: next.feedMedia,
      feed_media_max_bytes: next.feedMediaMaxBytes,
      group_create: next.groupCreate,
      group_visibility: next.groupVisibility,
      group_join: next.groupJoin,
      event_capacity: next.eventCapacity,
      contact_rule: next.contactRule,
      updated_by: p.userId,
      updated_at: Date.now()
    };
    const n = await this.db('social_workspace_policies').where({ tenant_id: p.tenantId, workspace_id: w.id }).update(row);
    if (!n) {
      try {
        await this.db('social_workspace_policies').insert({ tenant_id: p.tenantId, workspace_id: w.id, ...row });
      } catch {
        await this.db('social_workspace_policies').where({ tenant_id: p.tenantId, workspace_id: w.id }).update(row);
      }
    }
    const after = await this.policy(p.tenantId, w.id);
    const changed = (Object.keys(DEFAULT_POLICY) as (keyof typeof DEFAULT_POLICY)[]).filter((k) => k !== 'updatedBy' && k !== 'updatedAt' && before[k] !== after[k]);
    if (changed.length) {
      const pickOf = (x: WorkspacePolicy) => Object.fromEntries(changed.map((k) => [k, x[k]]));
      await this.audit(ctx, 'social.policy.updated', { workspace: w.id }, { changed, before: pickOf(before), after: pickOf(after), ...(before.feedGuard && !after.feedGuard ? { weakened: 'feedGuard' } : {}) });
    }
    return after;
  }

  // ---------- tenant settings ----------

  async tenantSettings(tenantId: string): Promise<TenantSettings> {
    const r = (await this.db('social_tenant_settings').where({ tenant_id: tenantId }).first()) as Record<string, unknown> | undefined;
    if (!r) return { digestProfile: null, digestDay: null, digestHour: null, digestTop: null, digestMaxLabel: null, summaryProfile: null, updatedBy: null, updatedAt: null };
    return {
      digestProfile: (r.digest_profile as string | null) ?? null,
      digestDay: numOrNull(r.digest_day),
      digestHour: numOrNull(r.digest_hour),
      digestTop: numOrNull(r.digest_top),
      digestMaxLabel: isLabel(r.digest_max_label) ? r.digest_max_label : null,
      summaryProfile: (r.summary_profile as string | null) ?? null,
      updatedBy: (r.updated_by as string | null) ?? null,
      updatedAt: numOrNull(r.updated_at)
    };
  }

  /** The digest and summary settings; a profile must resolve through the gateway (else 422). Audited `social.settings.updated`. */
  async setTenantSettings(ctx: Ctx, patch: SettingsPatch): Promise<TenantSettings> {
    const s = this.s();
    const p = ctx.p;
    for (const name of [patch.digestProfile, patch.summaryProfile]) {
      if (!name) continue;
      try {
        await s.gateway.resolve(p.tenantId, name);
      } catch (err) {
        if (err instanceof HttpProblem) throw new HttpProblem(422, 'Unknown profile', `Profile ${name} cannot be used: ${err.detail ?? err.message}`, { extensions: { field: patch.digestProfile === name ? 'digestProfile' : 'summaryProfile' } });
        throw err;
      }
    }
    if (patch.digestMaxLabel && !clears(p.clearance, patch.digestMaxLabel)) throw forbidden(`You are not cleared for ${patch.digestMaxLabel}.`, { step: 'clearance' });
    const before = await this.tenantSettings(p.tenantId);
    const next = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as TenantSettings;
    const row = { digest_profile: next.digestProfile, digest_day: next.digestDay, digest_hour: next.digestHour, digest_top: next.digestTop, digest_max_label: next.digestMaxLabel, summary_profile: next.summaryProfile, updated_by: p.userId, updated_at: Date.now() };
    const n = await this.db('social_tenant_settings').where({ tenant_id: p.tenantId }).update(row);
    if (!n) {
      try {
        await this.db('social_tenant_settings').insert({ tenant_id: p.tenantId, ...row });
      } catch {
        await this.db('social_tenant_settings').where({ tenant_id: p.tenantId }).update(row);
      }
    }
    const after = await this.tenantSettings(p.tenantId);
    const keys = ['digestProfile', 'digestDay', 'digestHour', 'digestTop', 'digestMaxLabel', 'summaryProfile'] as const;
    const changed = keys.filter((k) => before[k] !== after[k]);
    if (changed.length) await this.audit(ctx, 'social.settings.updated', { tenant: p.tenantId }, { changed, before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, after[k]])) });
    return after;
  }

  /** What the digest and summaries use now, with where each value comes from. */
  private effective(t: TenantSettings) {
    const cfg = this.s().cfg;
    return {
      digestProfile: t.digestProfile ?? cfg.FEED_DIGEST_PROFILE ?? null,
      digestDay: t.digestDay ?? 0,
      digestHour: t.digestHour ?? 0,
      digestTop: t.digestTop ?? cfg.FEED_DIGEST_TOP,
      digestMaxLabel: t.digestMaxLabel ?? cfg.FEED_DIGEST_MAX_LABEL,
      summaryProfile: t.summaryProfile ?? cfg.MESSAGING_SUMMARY_PROFILE
    };
  }

  // ---------- trending exclusions ----------

  async exclusions(tenantId: string): Promise<Set<string>> {
    return new Set(((await this.db('feed_trending_exclusions').where({ tenant_id: tenantId }).select('tag')) as { tag: string }[]).map((r) => r.tag));
  }

  async exclude(ctx: Ctx, raw: string): Promise<{ tag: string; excluded: true }> {
    const tag = normaliseTag(raw);
    if (!tag) throw new HttpProblem(422, 'Not a hashtag', `${raw} is not a hashtag.`);
    try {
      await this.db('feed_trending_exclusions').insert({ tenant_id: ctx.p.tenantId, tag, created_by: ctx.p.userId, created_at: Date.now() });
    } catch {
      return { tag, excluded: true };
    }
    await this.audit(ctx, 'feed.trending.excluded', { tag });
    return { tag, excluded: true };
  }

  async include(ctx: Ctx, raw: string): Promise<{ tag: string; excluded: false }> {
    const tag = normaliseTag(raw) ?? raw;
    const n = await this.db('feed_trending_exclusions').where({ tenant_id: ctx.p.tenantId, tag }).delete();
    if (n) await this.audit(ctx, 'feed.trending.included', { tag });
    return { tag, excluded: false };
  }

  /** Recounts the tenant's trending tags now (the `feed.trending` job). */
  async runTrending(ctx: Ctx): Promise<{ jobId: string }> {
    const job = await this.s().jobs.enqueue({ tenantId: ctx.p.tenantId, type: TRENDING_JOB, payload: { tenantId: ctx.p.tenantId }, createdBy: ctx.p.userId, dedupeKey: `${TRENDING_JOB}:${ctx.p.tenantId}:manual:${Math.floor(Date.now() / 60_000)}`, maxAttempts: 1 });
    await this.audit(ctx, 'feed.trending.requested', { job: job.id });
    return { jobId: job.id };
  }

  /** A test digest for the caller alone, over the workspaces they administer that have a digest profile. */
  async testDigest(ctx: Ctx): Promise<{ jobId: string; workspaces: number }> {
    const s = this.s();
    const ws = await this.workspaces(ctx.p);
    const ids: string[] = [];
    for (const w of ws) if ((await s.feed.digests.settings(ctx.p.tenantId, w.id)).effectiveProfile) ids.push(w.id);
    if (!ids.length) throw new HttpProblem(409, 'No digest profile', 'Choose a digest profile first (here, per workspace on the feed, or FEED_DIGEST_PROFILE).');
    const job = await s.jobs.enqueue({ tenantId: ctx.p.tenantId, type: DIGEST_JOB, payload: { tenantId: ctx.p.tenantId, test: true, by: ctx.p.userId, workspaceIds: ids }, createdBy: ctx.p.userId, dedupeKey: `${DIGEST_JOB}:test:${ctx.p.userId}:${Math.floor(Date.now() / 60_000)}`, maxAttempts: 1 });
    await this.audit(ctx, 'feed.digest.test-requested', { job: job.id }, { workspaces: ids.length });
    return { jobId: job.id, workspaces: ids.length };
  }

  // ---------- the Feed tab ----------

  async feed(p: Principal) {
    const s = this.s();
    const ws = await this.workspaces(p);
    const ids = ws.map((w) => w.id);
    const labels = LABELS.filter((l) => clears(p.clearance, l));
    const today = startOfDay(Date.now());
    const pol = await this.policies(p.tenantId, ids);
    const perWs = async (q: () => ReturnType<Services['db']>) => {
      const m = new Map<string, number>();
      if (!ids.length) return m;
      const rows = (await q().whereIn('workspace_id', ids).groupBy('workspace_id').select('workspace_id').count({ n: '*' })) as { workspace_id: string; n: number | string }[];
      for (const r of rows) m.set(r.workspace_id, Number(r.n));
      return m;
    };
    const [postsToday, held] = await Promise.all([
      perWs(() => this.db('feed_posts').where({ tenant_id: p.tenantId, state: 'published' }).andWhere('published_at', '>=', today)),
      perWs(() => this.db('feed_posts').where({ tenant_id: p.tenantId, state: 'held' }))
    ]);
    const comments = ids.length ? await this.count(this.db('feed_comments as c').join('feed_posts as x', 'x.id', 'c.post_id').where({ 'c.tenant_id': p.tenantId, 'c.state': 'published' }).whereIn('x.workspace_id', ids).andWhere('c.created_at', '>=', today).count({ n: '*' })) : 0;
    const reactions = ids.length ? await this.count(this.db('feed_reactions as r').join('feed_posts as x', 'x.id', 'r.post_id').where({ 'x.tenant_id': p.tenantId }).whereIn('x.workspace_id', ids).andWhere('r.created_at', '>=', today).count({ n: '*' })) : 0;
    // Trending: every tag counted at labels the caller is cleared for, excluded ones included (marked).
    const excluded = await this.exclusions(p.tenantId);
    const trows = ids.length ? ((await this.db('feed_trending').where({ tenant_id: p.tenantId }).whereIn('workspace_id', ids).whereIn('label', labels)) as { tag: string; posts: number | string; people: number | string; computed_at: number | string }[]) : [];
    const tags = new Map<string, { tag: string; posts: number; people: number; excluded: boolean }>();
    for (const r of trows) {
      const e = tags.get(r.tag) ?? { tag: r.tag, posts: 0, people: 0, excluded: excluded.has(r.tag) };
      e.posts += Number(r.posts);
      e.people = Math.max(e.people, Number(r.people));
      tags.set(r.tag, e);
    }
    for (const t of excluded) if (!tags.has(t)) tags.set(t, { tag: t, posts: 0, people: 0, excluded: true });
    const lastRun = trows.length ? Math.max(...trows.map((r) => Number(r.computed_at))) : null;
    const settings = await this.tenantSettings(p.tenantId);
    const eff = this.effective(settings);
    const last = (await this.db('feed_digests').where({ tenant_id: p.tenantId }).whereIn('workspace_id', ids.length ? ids : ['-']).whereIn('label', labels).orderBy('created_at', 'desc').first()) as Record<string, unknown> | undefined;
    const profiles = (await s.gateway.repo.profiles(p.tenantId)).filter((x) => x.status === 'published' && clears(p.clearance, x.label)).map((x) => x.name);
    const cfg = s.cfg;
    return {
      counters: { postsToday: [...postsToday.values()].reduce((a, b) => a + b, 0), held: [...held.values()].reduce((a, b) => a + b, 0), commentsToday: comments, reactionsToday: reactions, trendingTags: [...tags.values()].filter((t) => !t.excluded && t.posts > 0).length },
      workspaces: ws.map((w) => {
        const x = pol.get(w.id)!;
        return { id: w.id, name: w.name, label: w.label_ceiling, feedGuard: x.feedGuard, feedApprover: x.feedApprover, feedMedia: x.feedMedia, feedMediaMaxBytes: x.feedMediaMaxBytes, postsToday: postsToday.get(w.id) ?? 0, held: held.get(w.id) ?? 0 };
      }),
      trending: { minutes: cfg.FEED_TRENDING_MINUTES, hours: cfg.FEED_TRENDING_HOURS, lastRun, tags: [...tags.values()].sort((a, b) => b.posts - a.posts || a.tag.localeCompare(b.tag)).slice(0, 30) },
      digest: {
        settings,
        effective: eff,
        profiles,
        last: last ? { id: String(last.id), workspaceId: String(last.workspace_id), state: String(last.state), profile: (last.profile as string | null) ?? null, error: (last.error as string | null) ?? null, posts: (JSON.parse(String(last.posts ?? '[]')) as unknown[]).length, weekStart: Number(last.week_start), createdAt: Number(last.created_at) } : null
      },
      canModerate: effectivePermissions(p).has('moderation:manage')
    };
  }

  // ---------- the Groups and events tab ----------

  async groups(p: Principal) {
    const s = this.s();
    const ws = await this.workspaces(p);
    const ids = ws.map((w) => w.id);
    const wsName = new Map(ws.map((w) => [w.id, w.name]));
    const pol = await this.policies(p.tenantId, ids);
    const rows = ids.length ? ((await this.db('social_groups').where({ tenant_id: p.tenantId }).whereIn('workspace_id', ids).whereNot({ state: 'deleted' }).orderBy('name')) as Record<string, unknown>[]) : [];
    const visible = rows.filter((g) => isLabel(g.label) && clears(p.clearance, g.label));
    const gids = visible.map((g) => String(g.id));
    const now = Date.now();
    const by = async (q: () => ReturnType<Services['db']>, col: string) => {
      const m = new Map<string, number>();
      for (let i = 0; i < gids.length; i += 500) {
        const r = (await q().whereIn(col, gids.slice(i, i + 500)).groupBy(col).select(col).count({ n: '*' })) as Record<string, string | number>[];
        for (const x of r) m.set(String(x[col]), Number(x.n));
      }
      return m;
    };
    const [members, pending, events, feeds, reports] = gids.length
      ? await Promise.all([
          by(() => this.db('group_members'), 'group_id'),
          by(() => this.db('group_requests').where({ state: 'pending' }).andWhere('expires_at', '>', now), 'group_id'),
          by(() => this.db('group_events').where({ state: 'scheduled' }).andWhere('starts_at', '>=', now), 'group_id'),
          by(() => this.db('calendar_feeds').where({ tenant_id: p.tenantId, kind: 'group' }).whereNull('revoked_at'), 'target_id'),
          by(() => this.db('moderation_reports as r').join('guard_flags as f', 'f.id', 'r.flag_id').where({ 'r.tenant_id': p.tenantId, 'r.object_type': 'group', 'f.state': 'open' }), 'r.object_id')
        ])
      : [new Map(), new Map(), new Map(), new Map(), new Map()];
    const reportsOf = (id: string) => reports.get(id) ?? 0;
    // Calendar feeds of the tenant: who they were issued to and what they show (labels above the caller: left out).
    const feedRows = (await this.db('calendar_feeds').where({ tenant_id: p.tenantId }).orderBy('created_at', 'desc').limit(500)) as Record<string, unknown>[];
    const groupLabel = new Map(rows.map((g) => [String(g.id), g.label as Label]));
    const eventRows = (await this.db('group_events').where({ tenant_id: p.tenantId }).whereIn('id', feedRows.filter((f) => f.kind === 'event' && f.target_id).map((f) => String(f.target_id))).select('id', 'label', 'workspace_id')) as { id: string; label: Label; workspace_id: string }[];
    const eventInfo = new Map(eventRows.map((e) => [e.id, e]));
    const groupWs = new Map(rows.map((g) => [String(g.id), String(g.workspace_id)]));
    const userIds = feedRows.map((f) => String(f.user_id));
    const owners = gids.length ? ((await this.db('group_members').whereIn('group_id', gids).andWhere({ role: 'owner' }).select('group_id', 'user_id')) as { group_id: string; user_id: string }[]) : [];
    const who = await this.names(p.tenantId, [...userIds, ...owners.map((o) => o.user_id)]);
    const feedsOut = [];
    for (const f of feedRows) {
      const kind = String(f.kind);
      const target = (f.target_id as string | null) ?? null;
      let label: Label | null = null;
      let workspace: string | null = null;
      if (kind === 'group' && target) {
        label = groupLabel.get(target) ?? null;
        workspace = groupWs.get(target) ?? null;
        if (!label) continue; // a group gone or outside the caller's workspaces
      } else if (kind === 'event' && target) {
        const e = eventInfo.get(target);
        if (!e) continue;
        label = isLabel(e.label) ? e.label : 'restricted';
        workspace = e.workspace_id;
      }
      if (workspace && !ids.includes(workspace)) continue;
      if (label && !clears(p.clearance, label)) continue;
      feedsOut.push({ id: String(f.id), kind, targetId: target, name: (f.name as string | null) ?? null, issuedTo: { userId: String(f.user_id), ...(who.get(String(f.user_id)) ?? { username: null, displayName: null }) }, label, createdAt: Number(f.created_at), lastUsedAt: numOrNull(f.last_used_at), revokedAt: numOrNull(f.revoked_at), state: f.revoked_at ? 'revoked' : 'active' });
    }
    const cfg = s.cfg;
    return {
      settings: { requestDays: cfg.GROUP_REQUEST_DAYS, inviteDays: cfg.GROUP_INVITE_DAYS, feedPerMinute: cfg.CALENDAR_FEED_PER_MINUTE, feedMaxLabel: cfg.CALENDAR_FEED_MAX_LABEL },
      defaults: ws.map((w) => {
        const x = pol.get(w.id)!;
        return { workspaceId: w.id, name: w.name, groupCreate: x.groupCreate, groupVisibility: x.groupVisibility, groupJoin: x.groupJoin, eventCapacity: x.eventCapacity };
      }),
      groups: visible.map((g) => {
        const id = String(g.id);
        return {
          id,
          name: String(g.name),
          workspaceId: String(g.workspace_id),
          workspace: wsName.get(String(g.workspace_id)) ?? null,
          label: g.label as Label,
          visibility: String(g.visibility),
          joinMode: String(g.join_mode),
          state: String(g.state),
          members: members.get(id) ?? 0,
          pending: pending.get(id) ?? 0,
          upcomingEvents: events.get(id) ?? 0,
          openReports: reportsOf(id),
          feeds: feeds.get(id) ?? 0,
          owners: owners.filter((o) => o.group_id === id).map((o) => ({ userId: o.user_id, displayName: who.get(o.user_id)?.displayName ?? null })),
          createdAt: Number(g.created_at)
        };
      }),
      above: rows.length - visible.length,
      feeds: feedsOut
    };
  }

  /** One group's members (for the ownership transfer picker), as an administrator sees them. */
  async groupMembers(p: Principal, id: string) {
    const g = await this.s().groups.adminRow(p, id);
    const rows = (await this.db('group_members as m').join('users as u', 'u.id', 'm.user_id').where({ 'm.group_id': g.id, 'u.state': 'active' }).select('m.user_id', 'm.role', 'u.username', 'u.display_name').orderBy('u.display_name').limit(1000)) as { user_id: string; role: string; username: string; display_name: string }[];
    return { id: g.id, name: g.name, state: g.state, members: rows.map((r) => ({ userId: r.user_id, username: r.username, displayName: r.display_name, role: r.role })) };
  }

  // ---------- the Messaging tab ----------

  async messaging(p: Principal) {
    const s = this.s();
    const cfg = s.cfg;
    const ws = await this.workspaces(p);
    const r = (await this.db('chat_retention').where({ tenant_id: p.tenantId }).first()) as { conversation_days: number | null } | undefined;
    const scopes = (await this.db('chat_retention_scopes').where({ tenant_id: p.tenantId, scope: 'workspace' })) as { scope_id: string; conversation_days: number }[];
    const byWs = new Map(scopes.map((x) => [x.scope_id, Number(x.conversation_days)]));
    const tenantDays = r?.conversation_days == null ? null : Number(r.conversation_days);
    const now = Date.now();
    const [blocks, muted, exportsReady] = await Promise.all([
      this.count(this.db('social_blocks').where({ tenant_id: p.tenantId }).count({ n: '*' })),
      this.count(this.db('dm_members').where({ tenant_id: p.tenantId }).andWhere('muted_until', '>', now).count({ n: '*' })),
      this.count(this.db('messaging_exports').where({ tenant_id: p.tenantId, state: 'ready' }).count({ n: '*' }))
    ]);
    const settings = await this.tenantSettings(p.tenantId);
    const profiles = (await s.gateway.repo.profiles(p.tenantId)).filter((x) => x.status === 'published' && clears(p.clearance, x.label)).map((x) => x.name);
    return {
      retention: ws.map((w) => ({ workspaceId: w.id, name: w.name, days: byWs.has(w.id) ? byWs.get(w.id)! : tenantDays, source: byWs.has(w.id) ? 'workspace' : tenantDays == null ? 'none' : 'tenant' })),
      limits: { maxMembers: cfg.MESSAGING_MAX_MEMBERS, attachmentMaxBytes: cfg.ATTACHMENT_MAX_BYTES, signalsPerMinute: cfg.ROOM_SIGNALS_PER_MINUTE },
      search: { keyword: true, semantic: !!cfg.MESSAGING_EMBED_MODEL, embedModel: cfg.MESSAGING_EMBED_MODEL || null },
      summary: { profile: settings.summaryProfile, effective: settings.summaryProfile ?? cfg.MESSAGING_SUMMARY_PROFILE, maxMessages: cfg.MESSAGING_SUMMARY_MAX_MESSAGES, profiles },
      relations: { blocks, mutedConversations: muted, exported: exportsReady },
      exports: await this.exports(p),
      approvers: await this.approvers(p),
      canApprove: effectivePermissions(p).has('platform:manage')
    };
  }

  /**
   * Conversations the caller may ask to export: group conversations in a workspace they administer, and direct
   * conversations with a member in one, at labels they are cleared for. Titles of group conversations and the names
   * of the people in direct ones; never a message.
   */
  async conversations(p: Principal, q?: string) {
    const ws = await this.workspaces(p);
    const ids = ws.map((w) => w.id);
    if (!ids.length) return [];
    const labels = LABELS.filter((l) => clears(p.clearance, l));
    const wsName = new Map(ws.map((w) => [w.id, w.name]));
    const members = this.db('workspace_members').whereIn('workspace_id', ids).select('user_id');
    const rows = (await this.db('dm_conversations as c')
      .where({ 'c.tenant_id': p.tenantId, 'c.state': 'active' })
      .whereIn('c.label', labels)
      .andWhere((w) => {
        void w.where((g) => g.where({ 'c.kind': 'group' }).whereIn('c.workspace_id', ids)).orWhere((d) => d.where({ 'c.kind': 'direct' }).whereIn('c.id', this.db('dm_members').whereIn('user_id', members).select('conversation_id')));
      })
      .orderBy([{ column: 'c.last_message_at', order: 'desc' }, { column: 'c.created_at', order: 'desc' }])
      .limit(300)) as Record<string, unknown>[];
    const convIds = rows.map((r) => String(r.id));
    const mem = convIds.length ? ((await this.db('dm_members').whereIn('conversation_id', convIds).select('conversation_id', 'user_id')) as { conversation_id: string; user_id: string }[]) : [];
    const who = await this.names(p.tenantId, mem.map((m) => m.user_id));
    const out = [];
    for (const r of rows) {
      const id = String(r.id);
      const people = mem.filter((m) => m.conversation_id === id).map((m) => who.get(m.user_id)?.displayName ?? '?');
      const title = r.kind === 'group' ? ((r.title ? await this.s().keys.open(p.tenantId, String(r.title), `dm-title:${id}`) : null) ?? 'Untitled conversation') : people.join(' and ');
      const item = { id, kind: String(r.kind), title, workspace: r.workspace_id ? (wsName.get(String(r.workspace_id)) ?? null) : null, members: people.length, label: r.label as Label, lastMessageAt: numOrNull(r.last_message_at) };
      if (q && !`${item.title} ${item.workspace ?? ''}`.toLowerCase().includes(q.toLowerCase())) continue;
      out.push(item);
    }
    return out.slice(0, 200);
  }

  /** Other platform admins of the tenant (who may approve an export). */
  async approvers(p: Principal) {
    const ids = (await this.s().notifications.usersWithRoles(p.tenantId, rolesGranting('platform:manage', p.tenantId))).filter((id) => id !== p.userId);
    const who = await this.names(p.tenantId, ids);
    return ids.map((id) => ({ userId: id, displayName: who.get(id)?.displayName ?? null, username: who.get(id)?.username ?? null })).sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
  }

  private async exportRow(tenantId: string, id: string): Promise<ExportRow> {
    const r = await this.db('messaging_exports').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('Export');
    return exportFrom(r);
  }

  private async exportView(x: ExportRow, p: Principal, who?: Map<string, { username: string; displayName: string }>) {
    const names = who ?? (await this.names(x.tenant_id, [x.requested_by, x.approver_id, x.decided_by]));
    const mine = x.requested_by === p.userId;
    const platform = effectivePermissions(p).has('platform:manage');
    return {
      id: x.id,
      conversationId: x.conversation_id,
      label: x.label,
      // The reason is for the requester and the approvers.
      reason: mine || platform ? await this.s().keys.open(x.tenant_id, x.reason, `messaging-export:${x.id}`) : null,
      requestedBy: { userId: x.requested_by, displayName: names.get(x.requested_by)?.displayName ?? null },
      approver: x.approver_id ? { userId: x.approver_id, displayName: names.get(x.approver_id)?.displayName ?? null } : null,
      decidedBy: x.decided_by ? { userId: x.decided_by, displayName: names.get(x.decided_by)?.displayName ?? null } : null,
      decidedAt: x.decided_at,
      note: x.note,
      state: x.state,
      jobId: x.job_id,
      file: x.state === 'ready' ? x.file : null,
      messages: x.messages,
      error: x.error,
      downloadedAt: x.downloaded_at,
      createdAt: x.created_at,
      mine,
      canDecide: x.state === 'pending' && !mine && platform
    };
  }

  /** Export requests the caller made, and (for platform admins) every request of the tenant. Newest first. */
  async exports(p: Principal) {
    const platform = effectivePermissions(p).has('platform:manage');
    const labels = LABELS.filter((l) => clears(p.clearance, l));
    const rows = ((await this.db('messaging_exports').where({ tenant_id: p.tenantId }).whereIn('label', labels).modify((q) => (platform ? q : q.andWhere({ requested_by: p.userId }))).orderBy('created_at', 'desc').limit(100)) as Record<string, unknown>[]).map(exportFrom);
    const who = await this.names(p.tenantId, rows.flatMap((x) => [x.requested_by, x.approver_id, x.decided_by]));
    return Promise.all(rows.map((x) => this.exportView(x, p, who)));
  }

  /**
   * Asks for a legal-hold export of a conversation (decision Q5): a reason, and the platform admin asked to approve
   * (another person). Nothing is read until a second platform admin approves. Audited `messaging.export.requested`.
   */
  async requestExport(ctx: Ctx, input: { conversationId: string; reason: string; approverId: string }) {
    const s = this.s();
    const p = ctx.p;
    const conv = (await this.conversations(p)).find((c) => c.id === input.conversationId) ?? (await this.conversationIn(p, input.conversationId));
    if (!conv) throw notFound('Conversation');
    if (input.approverId === p.userId) throw forbidden('Dual control: you cannot approve your own request. Name another platform admin.', { step: 'dual-control' });
    if (!(await this.approvers(p)).some((a) => a.userId === input.approverId)) throw new HttpProblem(422, 'Not an approver', 'The approver must be another platform admin of this tenant.', { extensions: { field: 'approverId' } });
    if (await this.db('messaging_exports').where({ tenant_id: p.tenantId, conversation_id: conv.id, state: 'pending' }).first('id')) throw conflict('An export of this conversation already waits for approval.');
    const id = ulid();
    const t = Date.now();
    const row = { id, tenant_id: p.tenantId, conversation_id: conv.id, workspace_id: null, label: conv.label, reason: await s.keys.seal(p.tenantId, input.reason, `messaging-export:${id}`), requested_by: p.userId, approver_id: input.approverId, state: 'pending', decided_by: null, decided_at: null, note: null, job_id: null, file: null, blob_key: null, messages: null, error: null, downloaded_at: null, created_at: t, updated_at: t };
    await this.db('messaging_exports').insert(row);
    await this.audit(ctx, 'messaging.export.requested', { export: id, conversation: conv.id, approver: input.approverId }, { reason: input.reason.slice(0, 500) }, conv.label);
    await s.notifications.notify({ tenantId: p.tenantId, userIds: [input.approverId], kind: 'messaging.export', title: `${p.displayName} asks you to approve a conversation export`, body: `For a legal hold: ${input.reason.slice(0, 200)}`, route: 'social?tab=messaging', label: conv.label });
    return this.exportView(exportFrom(row), p);
  }

  /** A conversation in the caller's reach beyond the 300 most recent `conversations` lists. */
  private async conversationIn(p: Principal, id: string) {
    const c = (await this.db('dm_conversations').where({ tenant_id: p.tenantId, id, state: 'active' }).first()) as Record<string, unknown> | undefined;
    if (!c || !isLabel(c.label) || !clears(p.clearance, c.label)) return null;
    const ids = (await this.workspaces(p)).map((w) => w.id);
    if (c.kind === 'group' ? !ids.includes(String(c.workspace_id)) : !(await this.db('dm_members as m').join('workspace_members as wm', 'wm.user_id', 'm.user_id').where({ 'm.conversation_id': id }).whereIn('wm.workspace_id', ids).first('m.user_id'))) return null;
    return { id, label: c.label };
  }

  /** A second platform admin approves (the export job runs) or rejects. Audited `messaging.export.approved` / `rejected`. */
  async decideExport(ctx: Ctx, id: string, decision: 'approved' | 'rejected', note: string | null) {
    const s = this.s();
    const p = ctx.p;
    const x = await this.exportRow(p.tenantId, id);
    if (!clears(p.clearance, x.label)) throw notFound('Export');
    if (x.requested_by === p.userId) throw forbidden('Dual control: you cannot approve your own request. Another platform admin must decide it.', { step: 'dual-control' });
    if (x.state !== 'pending') throw conflict(`The request was already ${x.state}.`);
    const t = Date.now();
    const n = await this.db('messaging_exports').where({ id: x.id, state: 'pending' }).update({ state: decision, decided_by: p.userId, decided_at: t, note: note?.slice(0, 500) ?? null, updated_at: t });
    if (!n) throw conflict('The request was decided by someone else.');
    let jobId: string | null = null;
    if (decision === 'approved') {
      jobId = (await s.jobs.enqueue({ tenantId: p.tenantId, type: EXPORT_JOB, payload: { exportId: x.id }, createdBy: x.requested_by, dedupeKey: `${EXPORT_JOB}:${x.id}`, maxAttempts: 2 })).id;
      await this.db('messaging_exports').where({ id: x.id }).update({ job_id: jobId });
    }
    await this.audit(ctx, `messaging.export.${decision}`, { export: x.id, conversation: x.conversation_id, requestedBy: x.requested_by }, { note, ...(jobId ? { job: jobId } : {}) }, x.label);
    await s.notifications.notify({ tenantId: p.tenantId, userIds: [x.requested_by], kind: 'messaging.export', title: decision === 'approved' ? 'Your conversation export was approved; it is being written' : 'Your conversation export was rejected', ...(note ? { body: note.slice(0, 200) } : {}), route: 'social?tab=messaging', label: x.label });
    return this.exportView(await this.exportRow(p.tenantId, x.id), p);
  }

  async withdrawExport(ctx: Ctx, id: string) {
    const x = await this.exportRow(ctx.p.tenantId, id);
    if (x.requested_by !== ctx.p.userId) throw forbidden('Only the admin who asked for an export can withdraw it.', { step: 'owner' });
    if (x.state !== 'pending') throw conflict(`The request was already ${x.state}.`);
    await this.db('messaging_exports').where({ id: x.id, state: 'pending' }).update({ state: 'withdrawn', updated_at: Date.now() });
    await this.audit(ctx, 'messaging.export.withdrawn', { export: x.id, conversation: x.conversation_id }, undefined, x.label);
    return this.exportView(await this.exportRow(ctx.p.tenantId, x.id), ctx.p);
  }

  /**
   * The approved export as a job: every message of the conversation (deleted ones as tombstones, attachments by file
   * id), oldest first, as CSV sealed with the tenant key. The members are not told. Audited
   * `messaging.conversation.exported` with the reason and both names.
   */
  async exportJob(id: string) {
    const s = this.s();
    const r = await this.db('messaging_exports').where({ id }).first();
    if (!r) return { skipped: 'gone' };
    const x = exportFrom(r);
    if (x.state === 'ready') return { messages: x.messages };
    if (x.state !== 'approved') return { skipped: x.state };
    try {
      const rows = (await this.db('dm_messages').where({ tenant_id: x.tenant_id, conversation_id: x.conversation_id }).orderBy([{ column: 'created_at' }, { column: 'id' }]).limit(EXPORT_MAX_MESSAGES + 1)) as Record<string, unknown>[];
      const truncated = rows.length > EXPORT_MAX_MESSAGES;
      const list = rows.slice(0, EXPORT_MAX_MESSAGES);
      const who = await this.names(x.tenant_id, list.map((m) => String(m.author_id)));
      let csv = csvLine(['message', 'sent', 'author', 'author_name', 'thread', 'reply_to', 'state', 'edits', 'attachments', 'label', 'text']);
      for (const m of list) {
        const text = m.body ? ((await s.keys.open(x.tenant_id, String(m.body), `dm-message:${String(m.id)}`)) ?? '') : '';
        const attachments = (() => {
          try {
            return (JSON.parse(String(m.attachments ?? '[]')) as string[]).join(' ');
          } catch {
            return '';
          }
        })();
        csv += csvLine([m.id, new Date(Number(m.created_at)).toISOString(), who.get(String(m.author_id))?.username ?? m.author_id, who.get(String(m.author_id))?.displayName ?? '', m.thread_id ?? '', m.reply_to_id ?? '', m.state, m.edits ?? 0, attachments, m.label, m.state === 'deleted' ? '' : text]);
      }
      if (truncated) csv += csvLine(['', '', '', '', '', '', 'truncated', '', '', '', `Only the first ${EXPORT_MAX_MESSAGES} messages are in this export.`]);
      const key = `exports/${x.tenant_id}/messaging/${x.id}.sealed`;
      await s.blobs.put(key, Buffer.from(await s.keys.sealBytes(x.tenant_id, Buffer.from(csv, 'utf8'), `messaging-export-file:${x.id}`), 'utf8'), 'application/octet-stream');
      const file = `conversation-${x.conversation_id.slice(-8).toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
      await this.db('messaging_exports').where({ id: x.id }).update({ state: 'ready', blob_key: key, file, messages: list.length, updated_at: Date.now() });
      const names = await this.names(x.tenant_id, [x.requested_by, x.decided_by]);
      const reason = await s.keys.open(x.tenant_id, x.reason, `messaging-export:${x.id}`);
      await s.audit.append({ tenantId: x.tenant_id, action: 'messaging.conversation.exported', kind: 'admin', actor: { service: 'messaging' }, target: { export: x.id, conversation: x.conversation_id }, detail: { reason: (reason ?? '').slice(0, 500), requestedBy: names.get(x.requested_by)?.username ?? x.requested_by, approvedBy: x.decided_by ? (names.get(x.decided_by)?.username ?? x.decided_by) : null, messages: list.length, truncated }, label: x.label });
      await s.notifications.notify({ tenantId: x.tenant_id, userIds: [x.requested_by], kind: 'messaging.export', title: 'Your conversation export is ready', body: `${list.length} messages`, route: 'social?tab=messaging', label: x.label });
      return { messages: list.length, truncated };
    } catch (err) {
      await this.db('messaging_exports').where({ id: x.id }).update({ state: 'failed', error: (err as Error).message.slice(0, 500), updated_at: Date.now() });
      throw err;
    }
  }

  /** The ready export's CSV, for the requester only. Audited `messaging.export.downloaded`. */
  async download(ctx: Ctx, id: string): Promise<{ file: string; csv: Buffer }> {
    const s = this.s();
    const x = await this.exportRow(ctx.p.tenantId, id);
    if (x.requested_by !== ctx.p.userId || !clears(ctx.p.clearance, x.label)) throw notFound('Export');
    if (x.state !== 'ready' || !x.blob_key) throw conflict(`The export is ${x.state}.`);
    const sealed = await s.blobs.get(x.blob_key);
    if (!sealed) throw notFound('Export file');
    const csv = await s.keys.openBytes(x.tenant_id, sealed.toString('utf8'), `messaging-export-file:${x.id}`);
    await this.db('messaging_exports').where({ id: x.id }).update({ downloaded_at: Date.now() });
    await this.audit(ctx, 'messaging.export.downloaded', { export: x.id, conversation: x.conversation_id }, { bytes: csv.length }, x.label);
    return { file: x.file ?? `conversation-${x.id}.csv`, csv };
  }

  // ---------- the Realtime tab (platform) ----------

  realtime() {
    const s = this.s();
    return { instance: this.instance, ...s.rooms.stats.snapshot(), signalsPerMinuteLimit: s.cfg.ROOM_SIGNALS_PER_MINUTE, redis: !!s.cfg.REDIS_URL };
  }

  /** Closes every socket of a user on every instance (what a sanction does); the session stays. Audited `realtime.rooms.closed`. */
  async closeRooms(ctx: Ctx, userId: string) {
    const u = (await this.db('users').where({ tenant_id: ctx.p.tenantId, id: userId }).first('id', 'username')) as { id: string; username: string } | undefined;
    if (!u) throw notFound('User');
    this.s().bus.publish(TOPICS.roomsClose, { tenantId: ctx.p.tenantId, userId: u.id });
    await this.audit(ctx, 'realtime.rooms.closed', { user: u.id }, { username: u.username });
    return { userId: u.id, closed: true };
  }

  /** People of the tenant, for the Close rooms picker. */
  async people(p: Principal, q?: string) {
    const like = q ? `%${q.toLowerCase().replace(/[%_\\]/g, '')}%` : null;
    const rows = (await this.db('users').where({ tenant_id: p.tenantId, state: 'active' }).modify((b) => { if (like) b.andWhere((w) => { void w.whereRaw('lower(username) like ?', [like]).orWhereRaw('lower(display_name) like ?', [like]); }); }).orderBy('display_name').limit(200).select('id', 'username', 'display_name')) as { id: string; username: string; display_name: string }[];
    return rows.map((r) => ({ userId: r.id, username: r.username, displayName: r.display_name }));
  }

  // ---------- the Relations tab ----------

  async relations(p: Principal) {
    const ws = await this.workspaces(p);
    const pol = await this.policies(p.tenantId, ws.map((w) => w.id));
    const [follows, blocks, mutes, lists] = await Promise.all(['social_follows', 'social_blocks', 'social_mutes', 'social_lists'].map((t) => this.count(this.db(t).where({ tenant_id: p.tenantId }).count({ n: '*' }))));
    // Counts only: who blocked whom is never shown.
    const top = (await this.db('social_blocks').where({ tenant_id: p.tenantId }).groupBy('target_id').select('target_id').count({ n: '*' }).orderBy('n', 'desc').limit(10)) as { target_id: string; n: number | string }[];
    const who = await this.names(p.tenantId, top.map((t) => t.target_id));
    const now = Date.now();
    const sanctions = top.length ? ((await this.db('moderation_sanctions').where({ tenant_id: p.tenantId, state: 'active' }).whereIn('user_id', top.map((t) => t.target_id)).andWhere((q) => q.whereNull('ends_at').orWhere('ends_at', '>', now)).select('user_id', 'kind', 'ends_at')) as { user_id: string; kind: string; ends_at: number | null }[]) : [];
    const firstWs = new Map<string, string>();
    if (top.length) for (const r of (await this.db('workspace_members as m').join('workspaces as w', 'w.id', 'm.workspace_id').whereIn('m.user_id', top.map((t) => t.target_id)).select('m.user_id', 'w.name').orderBy('w.name')) as { user_id: string; name: string }[]) if (!firstWs.has(r.user_id)) firstWs.set(r.user_id, r.name);
    return {
      counts: { follows, blocks, mutes, lists },
      rules: ws.map((w) => ({ workspaceId: w.id, name: w.name, contactRule: pol.get(w.id)!.contactRule })),
      mostBlocked: top.map((t) => {
        const sn = sanctions.find((x) => x.user_id === t.target_id);
        return { userId: t.target_id, displayName: who.get(t.target_id)?.displayName ?? null, username: who.get(t.target_id)?.username ?? null, blockedBy: Number(t.n), workspace: firstWs.get(t.target_id) ?? null, sanction: sn ? { kind: sn.kind, endsAt: numOrNull(sn.ends_at) } : null };
      })
    };
  }
}
