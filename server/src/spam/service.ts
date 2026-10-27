import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation, type AuditActor } from '../audit/chain.js';
import { permissionsFor } from '../authz/permissions.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { setSpamScoreSource } from '../guardrails/detectors.js';
import type { GuardDecision, GuardFinding } from '../guardrails/types.js';
import { badRequest, conflict, HttpProblem, notFound, tooManyRequests } from '../http/problem.js';
import type { CounterStore } from '../platform/ratelimit.js';
import type { Services } from '../services.js';
import { decayed, features, hamming, parseFingerprint, shortHash, type TextFeatures } from './patterns.js';
import { levelFor, levelRank, policyInput, resolvePolicy, type Level, type Policy, type PolicyInput, type ResponseKind } from './policy.js';
import { CONTENT_SURFACES, GATED_SURFACES, ipRange, SlidingWindows, SURFACES, timeBox, windowKey, type Surface } from './signals.js';

/*
 * 1.9.0, Sprint 50 (B-159 to B-161): spam and flood.
 *
 * - `record(event)` is called at each surface where people write (posts, comments, messages, follows, invites,
 *   reports, sign-ups, failed sign-ins, firehose records). It returns at once: the counting and scoring run behind
 *   the request, time-boxed, and a slow or failing store only drops the event.
 * - The rate windows (B-159) are counters in the rate limiter's store; the pattern detectors (B-160) keep SimHash
 *   fingerprints, domains and counts (never text) in `spam_fingerprints`, `spam_domains` and `spam_scores`.
 * - A score from 0 to 100 with its reasons, decaying with the policy's half-life, reaches a step: slow mode, hold for
 *   review, a temporary posting limit, a case in the moderation queue (B-161). On a surface in `shadow` (the default)
 *   nothing is done but the score and its audit; on one in `enforce` the step is applied to the person, who is told
 *   and can appeal it (a system warning sanction stands for the response in the existing appeals). Never a ban.
 * - `gate(principal, surface)` is called before a write on an enforcing surface: it refuses (429) in slow mode or past
 *   the limit, and returns a hold finding the surface adds to its guardrail decision, so `moderation/held.ts` holds the
 *   write as for any rule. Admins and the policy's allow-list are exempt. Until a tenant saves a policy the whole
 *   thing is off: `record` and `gate` read the cached policy and return.
 */

export const SWEEP_JOB = 'spam.sweep';
const POLICY_NS = 'spam-policy';
const FINGERPRINT_KEEP_MS = 24 * 3_600_000;
const DOMAIN_KEEP_MS = 90 * 24 * 3_600_000;
const SCORE_KEEP_MS = 30 * 24 * 3_600_000;
const MAX_PENDING = 2000;
const CANDIDATES = 2000;

export interface SpamEvent {
  tenantId: string;
  surface: Surface;
  /** The local account that acted, when there is one. */
  userId?: string | null | undefined;
  /** Another account key when there is no local one (an AT-Protocol DID). */
  account?: string | null | undefined;
  ip?: string | null | undefined;
  /** The screened text, read here and never kept. */
  text?: string | null | undefined;
  /** Where it went (a conversation, a post, a workspace or group, a person); kept only as a hash. */
  recipient?: string | null | undefined;
  /** When the account was made, if the caller knows it. */
  accountCreatedAt?: number | null | undefined;
}

export interface Reason {
  signal: string;
  value: number;
  threshold: number;
  points: number;
}

export interface Observation {
  account: string;
  score: number;
  instant: number;
  level: Level;
  /** The reasons behind the score (this event's, or the earlier ones while their score is higher). */
  reasons: Reason[];
  /** What this event alone showed. */
  signals: Reason[];
  applied: ResponseKind | null;
  mode: 'shadow' | 'enforce';
}

interface ScoreRow {
  tenant_id: string;
  account: string;
  kind: 'user' | 'did' | 'ip';
  user_id: string | null;
  score: number;
  level: Level;
  reasons: Reason[];
  events: number;
  last_surface: string | null;
  first_seen: number;
  updated_at: number;
}

export interface ResponseRow {
  id: string;
  tenant_id: string;
  user_id: string;
  surface: Surface;
  kind: ResponseKind;
  state: 'active' | 'lifted' | 'expired';
  score: number;
  reasons: Reason[];
  sanction_id: string | null;
  flag_id: string | null;
  starts_at: number;
  ends_at: number | null;
  created_at: number;
  lifted_by: string | null;
  lifted_at: number | null;
  lift_reason: string | null;
}

const scoreFrom = (r: Record<string, unknown>): ScoreRow => ({ ...(r as unknown as ScoreRow), score: Number(r.score), events: Number(r.events ?? 0), reasons: json<Reason[]>(r.reasons, []), first_seen: Number(r.first_seen), updated_at: Number(r.updated_at) });
const responseFrom = (r: Record<string, unknown>): ResponseRow => ({ ...(r as unknown as ResponseRow), score: Number(r.score), reasons: json<Reason[]>(r.reasons, []), starts_at: Number(r.starts_at), ends_at: r.ends_at == null ? null : Number(r.ends_at), created_at: Number(r.created_at), lifted_at: r.lifted_at == null ? null : Number(r.lifted_at) });

export const responseView = (r: ResponseRow) => ({ id: r.id, userId: r.user_id, surface: r.surface, kind: r.kind, state: r.state, score: r.score, reasons: r.reasons, sanctionId: r.sanction_id, flagId: r.flag_id, startsAt: r.starts_at, endsAt: r.ends_at, createdAt: r.created_at, liftedBy: r.lifted_by, liftedAt: r.lifted_at, liftReason: r.lift_reason });

const SURFACE_WORDS: Record<Surface, string> = { post: 'posts', comment: 'comments', message: 'messages', follow: 'follows', invite: 'invitations', report: 'reports', signup: 'sign-ups', signin_failed: 'failed sign-ins', firehose: 'firehose records' };
const KIND_WORDS: Record<ResponseKind, string> = { slow: 'slow mode', hold: 'held for review', limit: 'a temporary posting limit', case: 'a temporary posting limit and a moderation case' };

/** Points of a signal past its threshold: `base` at the threshold, growing with the ratio up to `cap` times. */
const points = (base: number, value: number, threshold: number, cap = 1.5): number => Math.round(base * Math.min(cap, value / Math.max(1, threshold)));

/** The finding a hold adds to a surface's guardrail decision, so `moderation/held.ts` holds the write for review. */
export function withSpamHold(d: GuardDecision, hold: GuardFinding | null): GuardDecision {
  if (!hold || d.action === 'block') return d;
  return { ...d, action: 'require-approval', findings: [...d.findings, hold], reason: d.reason ?? 'The spam and flood checks hold what you write for review for a while; a moderator looks at it before it is delivered.' };
}

export interface SpamOptions {
  now?: () => number;
  /** How long `gate` may take before it lets the write through (ms). */
  gateTimeoutMs?: number;
  /** How long one recorded event may take before it is dropped (ms). */
  recordTimeoutMs?: number;
  /** The counter store (the rate limiter's by default). */
  store?: CounterStore;
}

export class SpamService {
  private readonly now: () => number;
  private readonly gateMs: number;
  private readonly recordMs: number;
  private winCache: SlidingWindows | null = null;
  private readonly pending = new Set<Promise<unknown>>();
  private started = false;
  /** Events dropped because too many were in flight or the store did not answer in time. */
  dropped = 0;

  constructor(
    private readonly s: () => Services,
    private readonly o: SpamOptions = {}
  ) {
    this.now = o.now ?? Date.now;
    this.gateMs = o.gateTimeoutMs ?? 150;
    this.recordMs = o.recordTimeoutMs ?? 2000;
  }

  private get store(): CounterStore {
    return this.o.store ?? this.s().counters;
  }

  get windows(): SlidingWindows {
    return (this.winCache ??= new SlidingWindows(this.store, this.now));
  }

  private get db() {
    return this.s().db;
  }

  init(): void {
    if (this.started) return;
    this.started = true;
    const s = this.s();
    s.jobs.register(SWEEP_JOB, async (p, ctx) => this.sweep(String(p.tenantId ?? ctx.job.tenant_id)));
    // An upheld appeal reverses the warning that stands for a response; a lift or expiry ends it too.
    s.moderation.sanctionEndedListeners.push(async (row, state) => {
      if (row.kind !== 'warn' || row.created_by !== 'system') return;
      await this.sanctionEnded(row.tenant_id, row.id, state, row.ended_by ?? null);
    });
    setSpamScoreSource(async (tenantId, userId) => {
      const r = await this.scoreOf(tenantId, userId);
      return r ? { score: r.score, reasons: r.reasons.map((x) => ({ signal: x.signal, value: x.value, threshold: x.threshold })) } : null;
    });
  }

  schedule(): void {
    const s = this.s();
    s.scheduler.every(SWEEP_JOB, 15 * 60_000, async () => {
      const rows = (await this.db('spam_policies').where({ enabled: true }).select('tenant_id').catch(() => [])) as { tenant_id: string }[];
      return rows.map((r) => ({ tenantId: r.tenant_id, payload: { tenantId: r.tenant_id } }));
    });
  }

  // ---------- policy ----------

  private async stored(tenantId: string): Promise<{ row: Record<string, unknown> | null; input: PolicyInput | null }> {
    const row = ((await this.db('spam_policies').where({ tenant_id: tenantId }).first()) as Record<string, unknown> | undefined) ?? null;
    if (!row) return { row: null, input: null };
    const input = json<PolicyInput>(row.policy, {});
    return { row, input: { ...input, enabled: !!row.enabled, allowList: json<string[]>(row.allow_list, []) } };
  }

  /** The tenant's policy, defaults filled in (cached; off when nothing is saved or the tables are missing). */
  async policy(tenantId: string): Promise<Policy> {
    try {
      return await this.s().cache.get(tenantId, POLICY_NS, 'policy', 'short', async () => resolvePolicy((await this.stored(tenantId)).input as Parameters<typeof resolvePolicy>[0]));
    } catch {
      return resolvePolicy(null);
    }
  }

  async policyView(tenantId: string) {
    const { row } = await this.stored(tenantId);
    const p = await this.policy(tenantId);
    return { ...p, saved: !!row, updatedAt: row ? Number(row.updated_at) : null, updatedBy: row ? ((row.updated_by as string | null) ?? null) : null, surfaceNames: SURFACES };
  }

  /** Saves the policy (`spam.policy.updated`): only what the admin sent is stored, over the defaults. */
  async savePolicy(p: Principal, raw: unknown, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    const parsed = policyInput.safeParse(raw);
    if (!parsed.success) throw badRequest('The request did not validate.', { errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const input = parsed.data;
    const before = await this.stored(p.tenantId);
    const prev = before.input ?? {};
    const next: PolicyInput = {
      surfaces: { ...(prev.surfaces ?? {}) },
      patterns: { ...(prev.patterns ?? {}), ...(input.patterns ?? {}) },
      responses: { ...(prev.responses ?? {}), ...(input.responses ?? {}) }
    };
    for (const [k, v] of Object.entries(input.surfaces ?? {})) next.surfaces![k as Surface] = { ...(next.surfaces![k as Surface] ?? {}), ...v };
    const enabled = input.enabled ?? (before.row ? !!before.row.enabled : true);
    const allowList = input.allowList ?? before.input?.allowList ?? [];
    // The merged policy must still hold together (rising steps, valid numbers): ZodError → 400.
    let resolved: Policy;
    try {
      resolved = resolvePolicy({ ...(next as Parameters<typeof resolvePolicy>[0]), enabled, allowList });
    } catch (err) {
      const issues = (err as { issues?: { path: PropertyKey[]; message: string }[] }).issues ?? [];
      throw badRequest('The policy does not hold together.', { errors: issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) });
    }
    if (allowList.length) {
      const known = ((await this.db('users').where({ tenant_id: p.tenantId }).whereIn('id', allowList).select('id')) as { id: string }[]).map((u) => u.id);
      const missing = allowList.filter((id) => !known.includes(id));
      if (missing.length) throw new HttpProblem(422, 'Unknown accounts', `The allow-list names accounts that are not in this tenant: ${missing.slice(0, 5).join(', ')}.`, { extensions: { step: 'allow-list', missing } });
    }
    const t = this.now();
    const row = { tenant_id: p.tenantId, enabled, policy: JSON.stringify({ surfaces: next.surfaces, patterns: next.patterns, responses: next.responses }), allow_list: JSON.stringify(allowList), updated_by: p.userId, updated_at: t };
    if (before.row) await this.db('spam_policies').where({ tenant_id: p.tenantId }).update(row);
    else {
      try {
        await this.db('spam_policies').insert({ ...row, created_at: t });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        await this.db('spam_policies').where({ tenant_id: p.tenantId }).update(row);
      }
    }
    await this.s().cache.invalidate({ tenantId: p.tenantId, ns: POLICY_NS });
    const modes = Object.fromEntries(SURFACES.map((x) => [x, resolved.surfaces[x].mode]));
    const beforeModes = before.input ? Object.fromEntries(SURFACES.map((x) => [x, resolvePolicy(before.input as Parameters<typeof resolvePolicy>[0]).surfaces[x].mode])) : null;
    await this.s().audit.append({ tenantId: p.tenantId, action: 'spam.policy.updated', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { policy: 'spam' }, label: 'internal', detail: { enabled, modes, beforeModes, changed: Object.keys(input).filter((k) => k !== 'allowList'), allowList: allowList.length }, traceId: ctx.traceId ?? null });
    return this.policyView(p.tenantId);
  }

  // ---------- B-159: recording ----------

  /** Fire and forget: counts and scores the event behind the request; never throws, never waits. */
  record(e: SpamEvent): void {
    if (this.pending.size >= MAX_PENDING) {
      this.dropped++;
      return;
    }
    const p = timeBox<Observation | null | 'timeout'>(
      this.observe(e).catch((err: unknown) => {
        this.s().log.warn({ err: (err as Error).message, surface: e.surface }, 'spam: an event was not scored');
        return null;
      }),
      this.recordMs,
      'timeout'
    ).then((r) => {
      if (r === 'timeout') this.dropped++;
    });
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  /** Waits for the events recorded so far (tests and graceful shutdown). */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Counts one event and scores its account; null when the tenant has the checks off. */
  async observe(e: SpamEvent): Promise<Observation | null> {
    const policy = await this.policy(e.tenantId);
    if (!policy.enabled) return null;
    const sp = policy.surfaces[e.surface];
    if (!sp || sp.mode === 'off') return null;
    const now = this.now();
    const range = ipRange(e.ip);
    const account = e.userId ?? e.account ?? (range ? `ip:${range}` : null);
    const kind: ScoreRow['kind'] = e.userId ? 'user' : e.account ? 'did' : 'ip';
    const w = this.windows;
    const win = sp.windowSeconds * 1000;
    const reasons: Reason[] = [];

    // B-159: rate windows per account, IP range and tenant.
    const [byAccount, byIp, byTenant] = await Promise.all([
      account && kind !== 'ip' ? w.add(windowKey(e.tenantId, e.surface, 'account', account), win) : Promise.resolve(0),
      range ? w.add(windowKey(e.tenantId, e.surface, 'ip', range), win) : Promise.resolve(0),
      w.add(windowKey(e.tenantId, e.surface, 'tenant', '*'), win)
    ]);
    if (byAccount > sp.account) reasons.push({ signal: `rate.${e.surface}.account`, value: byAccount, threshold: sp.account, points: points(20, byAccount, sp.account, 2) });
    if (byIp > sp.ip) reasons.push({ signal: `rate.${e.surface}.ip`, value: byIp, threshold: sp.ip, points: points(15, byIp, sp.ip, 2) });
    if (byTenant > sp.tenant) reasons.push({ signal: `rate.${e.surface}.tenant`, value: byTenant, threshold: sp.tenant, points: 5 });
    if (!account) return null;

    // B-160: patterns over what was written.
    const pat = policy.patterns;
    const pw = pat.windowSeconds * 1000;
    const f = features(e.text);
    if (f) reasons.push(...(await this.patterns(e, account, f, pat, pw, now)));
    if (kind === 'user') {
      const all = await w.add(`${e.tenantId}:all:${account}`, pw);
      const created = e.accountCreatedAt ?? (await this.createdAt(e.tenantId, account));
      if (created != null && now - created < pat.newAccountHours * 3_600_000 && all >= pat.newAccountEvents) reasons.push({ signal: 'new_account_velocity', value: all, threshold: pat.newAccountEvents, points: points(20, all, pat.newAccountEvents) });
    }

    // The score: what this event shows, or what is left of the last one after decay, whichever is higher.
    const instant = Math.min(100, reasons.reduce((a, r) => a + r.points, 0));
    const halfLife = policy.responses.halfLifeMinutes * 60_000;
    const prev = await this.scoreRow(e.tenantId, account);
    const prevScore = prev ? decayed(prev.score, now - prev.updated_at, halfLife) : 0;
    const score = Math.round(Math.max(prevScore, instant));
    const keepReasons = instant >= prevScore ? reasons : (prev?.reasons ?? []);
    const prevLevel = prev ? levelFor(Math.round(prevScore), policy.responses) : 'none';
    const level = levelFor(score, policy.responses);
    if (prev || score > 0) await this.saveScore({ tenant_id: e.tenantId, account, kind, user_id: e.userId ?? null, score, level, reasons: keepReasons, events: (prev?.events ?? 0) + 1, last_surface: e.surface, first_seen: prev?.first_seen ?? now, updated_at: now }, !!prev);

    const mode = sp.mode === 'enforce' ? 'enforce' : 'shadow';
    let applied: ResponseKind | null = null;
    let exempt = false;
    if (level !== 'none' && e.userId) {
      exempt = await this.exempt(e.tenantId, e.userId, policy);
      if (mode === 'enforce' && !exempt && GATED_SURFACES.includes(e.surface)) applied = await this.apply(e.tenantId, e.userId, e.surface, level as ResponseKind, score, keepReasons, policy);
    }
    if (levelRank(level) > levelRank(prevLevel)) {
      await this.s().audit.append({ tenantId: e.tenantId, action: 'spam.scored', kind: 'system', actor: { service: 'spam' }, target: { account: kind === 'user' ? account : account.slice(0, 200), kind }, label: 'internal', detail: { surface: e.surface, score, level, from: prevLevel, mode, exempt, ...(mode === 'shadow' && level !== 'none' ? { wouldApply: level } : {}), applied, reasons: keepReasons } });
    }
    return { account, score, instant, level, reasons: keepReasons, signals: reasons, applied, mode };
  }

  private async patterns(e: SpamEvent, account: string, f: TextFeatures, pat: Policy['patterns'], pw: number, now: number): Promise<Reason[]> {
    const out: Reason[] = [];
    const w = this.windows;
    if (f.mentions >= pat.mentions) out.push({ signal: 'mention_flood', value: f.mentions, threshold: pat.mentions, points: points(15, f.mentions, pat.mentions) });
    if (f.hashtags >= pat.hashtags) out.push({ signal: 'hashtag_flood', value: f.hashtags, threshold: pat.hashtags, points: points(10, f.hashtags, pat.hashtags) });
    if (f.links) {
      const links = await w.add(`${e.tenantId}:links:${account}`, pw, f.links);
      if (links >= pat.linkBurst) out.push({ signal: 'link_burst', value: links, threshold: pat.linkBurst, points: points(15, links, pat.linkBurst) });
      const fresh = await this.newDomains(e.tenantId, f.domains, now, pat.newDomainHours * 3_600_000);
      const recent = fresh ? await w.add(`${e.tenantId}:newdom:${account}`, pw, fresh) : await w.read(`${e.tenantId}:newdom:${account}`, pw);
      if (recent >= pat.newDomains) out.push({ signal: 'new_domains', value: recent, threshold: pat.newDomains, points: points(15, recent, pat.newDomains) });
    }
    if (f.fingerprint) {
      const fp = f.fingerprint;
      const recipient = e.recipient ? shortHash(`${e.tenantId}:${e.recipient}`) : null;
      await this.db('spam_fingerprints').insert({ id: ulid(), tenant_id: e.tenantId, account: account.slice(0, 200), surface: e.surface, fingerprint: fp.hex, b0: fp.bands[0], b1: fp.bands[1], b2: fp.bands[2], b3: fp.bands[3], recipient, created_at: now });
      const rows = (await this.db('spam_fingerprints')
        .where({ tenant_id: e.tenantId })
        .andWhere('created_at', '>=', now - pw)
        // Within 3 bits two fingerprints share a band; past that, the window's most recent ones are compared.
        .modify((q) => {
          if (pat.hamming <= 3) q.andWhere((b) => b.where({ b0: fp.bands[0] }).orWhere({ b1: fp.bands[1] }).orWhere({ b2: fp.bands[2] }).orWhere({ b3: fp.bands[3] }));
        })
        .orderBy('created_at', 'desc')
        .limit(CANDIDATES)
        .select('account', 'fingerprint', 'recipient')) as { account: string; fingerprint: string; recipient: string | null }[];
      const near = rows.filter((r) => hamming(parseFingerprint(r.fingerprint), fp) <= pat.hamming);
      const recipients = new Set(near.filter((r) => r.account === account && r.recipient).map((r) => r.recipient));
      const accounts = new Set(near.map((r) => r.account));
      if (recipients.size >= pat.duplicateRecipients) out.push({ signal: 'near_duplicate', value: recipients.size, threshold: pat.duplicateRecipients, points: points(30, recipients.size, pat.duplicateRecipients) });
      if (accounts.size >= pat.clusterAccounts) out.push({ signal: 'coordinated_cluster', value: accounts.size, threshold: pat.clusterAccounts, points: points(30, accounts.size, pat.clusterAccounts) });
    }
    return out;
  }

  /** Records the domains as seen in the tenant; returns how many of them were first seen within `freshMs`. */
  private async newDomains(tenantId: string, domains: string[], now: number, freshMs: number): Promise<number> {
    if (!domains.length) return 0;
    const known = new Map(((await this.db('spam_domains').where({ tenant_id: tenantId }).whereIn('domain', domains).select('domain', 'first_seen')) as { domain: string; first_seen: number | string }[]).map((r) => [r.domain, Number(r.first_seen)]));
    let fresh = 0;
    for (const d of domains) {
      const first = known.get(d);
      if (first == null) {
        try {
          await this.db('spam_domains').insert({ tenant_id: tenantId, domain: d, first_seen: now, last_seen: now, uses: 1 });
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
        fresh++;
      } else {
        await this.db('spam_domains').where({ tenant_id: tenantId, domain: d }).update({ last_seen: now, uses: this.db.raw('uses + 1') });
        if (now - first < freshMs) fresh++;
      }
    }
    return fresh;
  }

  private async createdAt(tenantId: string, userId: string): Promise<number | null> {
    const r = (await this.db('users').where({ tenant_id: tenantId, id: userId }).first('created_at')) as { created_at: number | string } | undefined;
    return r ? Number(r.created_at) : null;
  }

  private async scoreRow(tenantId: string, account: string): Promise<ScoreRow | null> {
    const r = await this.db('spam_scores').where({ tenant_id: tenantId, account: account.slice(0, 200) }).first();
    return r ? scoreFrom(r) : null;
  }

  private async saveScore(row: ScoreRow, exists: boolean): Promise<void> {
    const values = { ...row, account: row.account.slice(0, 200), reasons: JSON.stringify(row.reasons) };
    if (exists) {
      await this.db('spam_scores').where({ tenant_id: row.tenant_id, account: values.account }).update(values);
      return;
    }
    try {
      await this.db('spam_scores').insert(values);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await this.db('spam_scores').where({ tenant_id: row.tenant_id, account: values.account }).update(values);
    }
  }

  /** The account's score now (decayed), its level and reasons; null when it has none. */
  async scoreOf(tenantId: string, account: string): Promise<{ score: number; level: Level; reasons: Reason[]; updatedAt: number } | null> {
    const row = await this.scoreRow(tenantId, account).catch(() => null);
    if (!row) return null;
    const policy = await this.policy(tenantId);
    const score = Math.round(decayed(row.score, this.now() - row.updated_at, policy.responses.halfLifeMinutes * 60_000));
    return { score, level: levelFor(score, policy.responses), reasons: score > 0 ? row.reasons : [], updatedAt: row.updated_at };
  }

  // ---------- B-161: responses ----------

  /** Admins (tenant or system) and the allow-list are never slowed, held or limited. */
  private async exempt(tenantId: string, userId: string, policy: Policy): Promise<boolean> {
    if (policy.allowList.includes(userId)) return true;
    const roles = await this.s().users.roleIds(userId);
    return roles.includes('system-admin') || permissionsFor(roles, tenantId).has('tenant:manage');
  }

  private exemptPrincipal(p: Principal, policy: Policy): boolean {
    return policy.allowList.includes(p.userId) || p.roles.includes('system-admin') || effectivePermissions(p).has('tenant:manage');
  }

  private async active(tenantId: string, userId: string, surface?: Surface): Promise<ResponseRow[]> {
    const q = this.db('spam_responses').where({ tenant_id: tenantId, user_id: userId, state: 'active' });
    if (surface) q.andWhere({ surface });
    const now = this.now();
    return ((await q.orderBy('created_at', 'desc')) as Record<string, unknown>[]).map(responseFrom).filter((r) => r.ends_at == null || r.ends_at > now);
  }

  private reasonText(surface: Surface, kind: ResponseKind, score: number, reasons: Reason[]): string {
    const why = reasons.length ? reasons.map((r) => `${r.signal} ${r.value} (threshold ${r.threshold})`).join(', ') : 'earlier activity';
    return `Spam and flood checks: ${KIND_WORDS[kind]} on ${SURFACE_WORDS[surface]} (score ${score}: ${why}).`;
  }

  /**
   * Applies the step a score reached on one surface: a new response, or the person's active one on that surface
   * raised to it. Returns the kind applied, or null when a response at or above it is already active.
   */
  async apply(tenantId: string, userId: string, surface: Surface, kind: ResponseKind, score: number, reasons: Reason[], policy: Policy): Promise<ResponseKind | null> {
    const s = this.s();
    const now = this.now();
    const current = (await this.active(tenantId, userId, surface))[0] ?? null;
    if (current && levelRank(current.kind) >= levelRank(kind)) return null;
    const endsAt = now + policy.responses.durationMinutes * 60_000;
    const reasonText = this.reasonText(surface, kind, score, reasons);
    let flagId: string | null = current?.flag_id ?? null;
    if (kind === 'case' && !flagId) {
      const user = await s.users.get(tenantId, userId);
      const flag = await s.guard.flags.create({
        tenantId,
        workspaceId: null,
        kind: 'reviewer',
        checkpoint: 'spam',
        ruleName: 'Spam and flood',
        severity: 'medium',
        label: 'internal',
        text: null,
        note: `${user?.display_name ?? 'An account'} (${user?.username ?? userId}) reached a score of ${score} on ${SURFACE_WORDS[surface]}. Evidence: ${reasons.map((r) => `${r.signal} = ${r.value}, threshold ${r.threshold}`).join('; ') || 'earlier activity'}. Posting is limited for ${policy.responses.durationMinutes} minutes; nothing is banned. Lift it or sanction from the Moderation screen.`,
        actor: { user: null, name: 'Spam and flood checks', via: 'spam' },
        source: { kind: 'spam-account', id: userId }
      });
      flagId = flag.id;
    }
    let id: string;
    let sanctionId = current?.sanction_id ?? null;
    if (current) {
      id = current.id;
      await this.db('spam_responses').where({ id, state: 'active' }).update({ kind, score, reasons: JSON.stringify(reasons), ends_at: endsAt, flag_id: flagId });
      if (sanctionId) await s.moderation.updateSystemWarning(tenantId, sanctionId, { reason: reasonText, endsAt });
    } else {
      id = ulid();
      sanctionId = (await s.moderation.systemWarning(tenantId, userId, { reason: reasonText, endsAt, service: 'spam' })).id;
      await this.db('spam_responses').insert({ id, tenant_id: tenantId, user_id: userId, surface, kind, state: 'active', score, reasons: JSON.stringify(reasons), sanction_id: sanctionId, flag_id: flagId, starts_at: now, ends_at: endsAt, created_at: now, lifted_by: null, lifted_at: null, lift_reason: null });
    }
    await s.audit.append({ tenantId, action: 'spam.response.applied', kind: 'system', actor: { service: 'spam' }, target: { response: id, user: userId }, label: 'internal', detail: { surface, kind, from: current?.kind ?? null, score, endsAt, sanction: sanctionId, flag: flagId, reasons } });
    const until = new Date(endsAt).toISOString();
    const what = kind === 'slow' ? `Slow mode is on for your ${SURFACE_WORDS[surface]}` : kind === 'hold' ? `Your ${SURFACE_WORDS[surface]} are held for review for a while` : `Your ${SURFACE_WORDS[surface]} are limited for a while`;
    const how = kind === 'slow' ? `You can send one every ${policy.responses.slowSeconds} seconds.` : kind === 'hold' ? 'A moderator reads what you send before anyone else sees it.' : `You can send at most ${policy.responses.limitPerHour} an hour.`;
    try {
      await s.notifications.notify({ tenantId, userIds: [userId], kind: 'spam.response', title: what, body: `${how} It ends at ${until}. It was applied automatically because of unusual activity; nothing is banned. If it is a mistake, appeal it from Settings (warning ${sanctionId}).`, route: 'settings', label: 'internal' });
    } catch (err) {
      s.log.warn({ err, user: userId }, 'spam: the notice was not sent');
    }
    return kind;
  }

  /**
   * Called before a write on a surface. Refuses (429) in slow mode or past the limit; returns the hold finding on an
   * enforcing content surface while a hold (or more) is active. Fails open: past its time box it lets the write by.
   */
  async gate(p: Principal, surface: Surface): Promise<{ hold: GuardFinding | null }> {
    const r = await timeBox(this.gateInner(p, surface), this.gateMs, { hold: null, refuse: null });
    if (r.refuse) throw r.refuse;
    return { hold: r.hold };
  }

  private async gateInner(p: Principal, surface: Surface): Promise<{ hold: GuardFinding | null; refuse: HttpProblem | null }> {
    const none = { hold: null, refuse: null };
    const policy = await this.policy(p.tenantId);
    if (!policy.enabled || policy.surfaces[surface]?.mode !== 'enforce' || this.exemptPrincipal(p, policy)) return none;
    const act = await this.active(p.tenantId, p.userId, surface);
    if (!act.length) return none;
    const top = act.reduce((a, b) => (levelRank(b.kind) > levelRank(a.kind) ? b : a));
    const rank = levelRank(top.kind);
    const r = policy.responses;
    const base = `${p.tenantId}:${p.userId}:${surface}`;
    const slow = await this.store.hit(`spam:slow:${base}`, r.slowSeconds * 1000, 1);
    if (slow.count > 1) return { hold: null, refuse: refusal(tooManyRequests(`Slow mode is on for your ${SURFACE_WORDS[surface]}: one every ${r.slowSeconds} seconds. Try again in ${Math.ceil(slow.resetMs / 1000)} seconds.`, Math.ceil(slow.resetMs / 1000)), 'spam-slow', top) };
    if (rank >= levelRank('limit')) {
      const lim = await this.store.hit(`spam:limit:${base}`, 3_600_000, 1);
      if (lim.count > r.limitPerHour) return { hold: null, refuse: refusal(tooManyRequests(`Your ${SURFACE_WORDS[surface]} are limited to ${r.limitPerHour} an hour for a while. Try again in ${Math.ceil(lim.resetMs / 60_000)} minutes.`, Math.ceil(lim.resetMs / 1000)), 'spam-limit', top) };
    }
    if (rank >= levelRank('hold') && CONTENT_SURFACES.includes(surface)) return { hold: { ruleId: 'spam', ruleName: 'Spam and flood', action: 'require-approval', stage: 'enforce', score: top.score / 100, detail: `spam: score ${top.score}` }, refuse: null };
    return none;
  }

  /** Lifts a response (`spam.response.lifted`) and ends the warning that stands for it. */
  async lift(p: Principal, id: string, reason: string | null, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    const r = await this.db('spam_responses').where({ tenant_id: p.tenantId, id }).first();
    if (!r) throw notFound('Response');
    const row = responseFrom(r);
    if (row.state !== 'active') throw conflict(`That response is ${row.state}.`);
    const done = await this.end(row, 'lifted', reason ?? 'Lifted by a moderator', actorFrom(p, ctx.ip ?? null), p.userId, ctx.traceId ?? null);
    if (done && row.sanction_id) await this.s().moderation.endSystemWarning(p.tenantId, row.sanction_id, 'lifted', reason ?? 'The spam response was lifted by a moderator', p, ctx.ip ?? null);
    return responseView(responseFrom(await this.db('spam_responses').where({ id }).first()));
  }

  private async end(row: ResponseRow, state: 'lifted' | 'expired', reason: string, actor: AuditActor, by: string | null, traceId: string | null = null): Promise<boolean> {
    const n = await this.db('spam_responses').where({ id: row.id, state: 'active' }).update({ state, lifted_by: by, lifted_at: this.now(), lift_reason: reason.slice(0, 500) });
    if (!n) return false;
    await this.s().audit.append({ tenantId: row.tenant_id, action: 'spam.response.lifted', kind: by ? 'admin' : 'system', actor, target: { response: row.id, user: row.user_id }, label: 'internal', detail: { surface: row.surface, kind: row.kind, state, reason }, traceId });
    return true;
  }

  /** The warning behind a response ended elsewhere (an upheld appeal, a moderator's lift, its expiry). */
  private async sanctionEnded(tenantId: string, sanctionId: string, state: 'lifted' | 'reversed' | 'expired', by: string | null): Promise<void> {
    const rows = ((await this.db('spam_responses').where({ tenant_id: tenantId, sanction_id: sanctionId, state: 'active' })) as Record<string, unknown>[]).map(responseFrom);
    for (const row of rows) await this.end(row, state === 'expired' ? 'expired' : 'lifted', state === 'reversed' ? 'Appeal upheld' : state === 'expired' ? 'Its duration ended' : 'The warning was lifted', by ? { user: by } : { service: 'moderation' }, by);
  }

  /** Ends expired responses and prunes fingerprints, unused domains and old scores. */
  async sweep(tenantId: string): Promise<{ expired: number; pruned: number }> {
    const now = this.now();
    const due = ((await this.db('spam_responses').where({ tenant_id: tenantId, state: 'active' }).whereNotNull('ends_at').andWhere('ends_at', '<=', now).limit(500)) as Record<string, unknown>[]).map(responseFrom);
    let expired = 0;
    for (const row of due) {
      if (await this.end(row, 'expired', 'Its duration ended', { service: 'spam' }, null)) expired++;
      if (row.sanction_id) await this.s().moderation.endSystemWarning(tenantId, row.sanction_id, 'expired', 'Its duration ended', null);
    }
    let pruned = await this.db('spam_fingerprints').where({ tenant_id: tenantId }).andWhere('created_at', '<', now - FINGERPRINT_KEEP_MS).delete();
    pruned += await this.db('spam_domains').where({ tenant_id: tenantId }).andWhere('last_seen', '<', now - DOMAIN_KEEP_MS).delete();
    pruned += await this.db('spam_scores').where({ tenant_id: tenantId }).andWhere('updated_at', '<', now - SCORE_KEEP_MS).delete();
    return { expired, pruned };
  }

  // ---------- reading ----------

  /** Accounts with a score now, highest first, with their reasons, active responses and whether they are exempt. */
  async accounts(p: Principal, q: { min?: number | undefined; limit?: number | undefined } = {}) {
    const policy = await this.policy(p.tenantId);
    const now = this.now();
    const half = policy.responses.halfLifeMinutes * 60_000;
    const rows = ((await this.db('spam_scores').where({ tenant_id: p.tenantId }).andWhere('updated_at', '>', now - 14 * 24 * 3_600_000).orderBy('score', 'desc').limit(2000)) as Record<string, unknown>[]).map(scoreFrom);
    const scored = rows.map((r) => ({ r, score: Math.round(decayed(r.score, now - r.updated_at, half)) })).filter((x) => x.score >= (q.min ?? 1)).sort((a, b) => b.score - a.score).slice(0, q.limit ?? 200);
    const userIds = scored.flatMap((x) => (x.r.user_id ? [x.r.user_id] : []));
    const users = new Map(((userIds.length ? await this.db('users').where({ tenant_id: p.tenantId }).whereIn('id', userIds).select('id', 'username', 'display_name') : []) as { id: string; username: string; display_name: string }[]).map((u) => [u.id, u]));
    const responses = ((userIds.length ? await this.db('spam_responses').where({ tenant_id: p.tenantId, state: 'active' }).whereIn('user_id', userIds) : []) as Record<string, unknown>[]).map(responseFrom);
    const out = [];
    for (const { r, score } of scored) {
      const u = r.user_id ? users.get(r.user_id) : undefined;
      out.push({ account: r.account, kind: r.kind, userId: r.user_id, username: u?.username ?? null, displayName: u?.display_name ?? null, score, level: levelFor(score, policy.responses), reasons: r.reasons, events: r.events, lastSurface: r.last_surface, firstSeen: r.first_seen, updatedAt: r.updated_at, exempt: r.user_id ? await this.exempt(p.tenantId, r.user_id, policy) : false, responses: responses.filter((x) => x.user_id === r.user_id).map(responseView) });
    }
    return out;
  }

  async responses(p: Principal, q: { state?: ResponseRow['state'] | undefined; userId?: string | undefined } = {}) {
    const qb = this.db('spam_responses').where({ tenant_id: p.tenantId });
    if (q.state) qb.andWhere({ state: q.state });
    if (q.userId) qb.andWhere({ user_id: q.userId });
    return ((await qb.orderBy('created_at', 'desc').limit(500)) as Record<string, unknown>[]).map(responseFrom).map(responseView);
  }

  /** The person's own active responses (what slows or holds them, and the warning to appeal). */
  async mine(p: Principal) {
    return (await this.active(p.tenantId, p.userId).catch(() => [])).map(responseView);
  }

  /** The tenant-wide windows now, per surface, against their thresholds (counts only). */
  async signals(p: Principal) {
    const policy = await this.policy(p.tenantId);
    const out = [];
    for (const surface of SURFACES) {
      const sp = policy.surfaces[surface];
      const tenant = await timeBox(this.windows.read(windowKey(p.tenantId, surface, 'tenant', '*'), sp.windowSeconds * 1000), 500, null);
      out.push({ surface, mode: sp.mode, windowSeconds: sp.windowSeconds, thresholds: { account: sp.account, ip: sp.ip, tenant: sp.tenant }, tenant });
    }
    return { enabled: policy.enabled, store: this.store.kind, degraded: this.store.health?.().degraded ?? false, dropped: this.dropped, surfaces: out };
  }
}

function refusal(p: HttpProblem, step: string, r: ResponseRow): HttpProblem {
  return new HttpProblem(p.status, p.title, p.detail, { headers: p.headers, extensions: { ...p.extensions, step, response: r.id, appeal: r.sanction_id } });
}
