import { createHash } from 'node:crypto';
import { monotonicFactory, ulid } from 'ulid';
import type { AuditActor } from '../audit/chain.js';
import { isUniqueViolation } from '../audit/chain.js';
import { labelRank, type Label } from '../authz/labels.js';
import { json } from '../db/knex.js';
import type { GuardAction } from '../guardrails/types.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { DidResolver, type PlcService } from './did.js';
import { collectionAllowed } from './firehose-frames.js';
import type { Post, SubscriptionRow } from './firehose.js';
import { labelsForDecision } from './labels.js';
import type { IdentityRow } from './service.js';
import { ServiceJwtVerifier } from './service-jwt.js';

/*
 * Custom feed generators (B-3001 to B-3003).
 *
 * The generator. A tenant's feeds are served by the tenant's own AT-Protocol identity (B-1609) acting as a feed
 * generator: its DID document carries a `#bsky_fg` service of type `BskyFeedGenerator` at the identity's endpoint
 * (computed for did:web; for did:plc a signed PLC operation adds it when the first feed is made). An AppView resolves
 * that DID and calls `app.bsky.feed.describeFeedGenerator` and `app.bsky.feed.getFeedSkeleton` there
 * (`routes/atproto-feeds-public.ts`), with an inter-service JWT (`service-jwt.ts`) verified against the caller's DID
 * key. The platform's identity (the labeling fallback) serves no feeds: feeds are tenant data.
 *
 * Feeds as rules over the firehose (B-3002). Each post the tenant's firehose subscriptions (B-1908) take and the
 * moderation check passed comes here with its verdict. A feed indexes it when its rules all hold: `authors` (DIDs;
 * null for anyone), `collections` (NSIDs or `prefix.*`), `keywords` (any, case-insensitive, on word boundaries; null
 * for any text), `labels` (any of these labels in force on the post, from the tenant's labeler or its trusted external
 * labelers) and `excludeLabels` (none of these; `!hide` by default). The rules are checked again when a page is served
 * (authors, collections, labels), so a post from an author outside the rule never appears, even if it was indexed
 * under an earlier rule; narrowing the rules also deletes what no longer matches, and changing the keywords or the
 * ranking empties the index (the text is not kept).
 *
 * Ranking (optional). `embedding`: the cosine similarity of the post to a query text, both embedded through the
 * gateway with the model a gateway profile routes to; `classifier`: a guardrail classifier's score for one of its
 * labels (its engine reaches models through the gateway). The score orders the feed and `minScore` drops posts below
 * it; a post whose ranking fails is not indexed (counted in `rankFailed`). Without ranking a feed is newest first.
 *
 * The index (B-3003). `atproto_feed_items` keeps the post URI, its author and collection, and the sort key (the time it
 * was indexed, or the score × 1e9). Pages are ordered by (sort, id) descending and the cursor is the last row's pair,
 * so the next page starts strictly after it: no post is served twice, however many arrive meanwhile. Retention: rows
 * older than `retentionHours` are not served and are pruned (with anything beyond `maxItems`) every
 * FEED_PRUNE_MINUTES. `ratePerMinute` limits getFeedSkeleton per feed, across instances (the shared counters).
 *
 * B-3004 (publishing the `app.bsky.feed.generator` record) uses `generator`, `recordFor`, `feedUri` and
 * `markPublished` below; the published record names the generator's service DID.
 */

export const FEEDS_TOPIC = 'atproto.feeds.changed';
export const PRUNE_JOB = 'atproto.feeds.prune';
export const FEED_SERVICE_ID = 'bsky_fg';
export const FEED_SERVICE_TYPE = 'BskyFeedGenerator';
export const GENERATOR_COLLECTION = 'app.bsky.feed.generator';
/** Record keys of generator records: Bluesky's AppView takes at most 15 characters. */
export const FEED_RKEY_RE = /^[a-zA-Z0-9-]{1,15}$/;

export interface FeedRules {
  authors: string[] | null;
  collections: string[];
  keywords: string[] | null;
  labels: string[] | null;
  excludeLabels: string[];
}

export type FeedRanking = { kind: 'embedding'; profile: string; query: string; minScore?: number | undefined } | { kind: 'classifier'; classifier: string; label: string; minScore?: number | undefined };

export interface FeedRow {
  id: string;
  tenant_id: string;
  rkey: string;
  display_name: string;
  description: string | null;
  subscription_id: string | null;
  rules: FeedRules;
  ranking: FeedRanking | null;
  retention_hours: number;
  max_items: number;
  rate_per_minute: number;
  auth: 'optional' | 'required';
  state: 'active' | 'paused';
  rev: number;
  publisher_did: string | null;
  record_uri: string | null;
  record_cid: string | null;
  published_at: number | null;
  indexed: number;
  served: number;
  rank_failed: number;
  last_error: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface FeedInput {
  rkey: string;
  displayName: string;
  description?: string | null | undefined;
  subscriptionId?: string | null | undefined;
  rules?: Partial<FeedRules> | undefined;
  ranking?: FeedRanking | null | undefined;
  retentionHours?: number | undefined;
  maxItems?: number | undefined;
  ratePerMinute?: number | undefined;
  auth?: 'optional' | 'required' | undefined;
  state?: 'active' | 'paused' | undefined;
}

export type FeedPatch = Partial<Omit<FeedInput, 'rkey'>>;

export interface FeedActor {
  tenantId: string;
  userId: string | null;
  actor: AuditActor;
  traceId?: string | null;
}

/** What B-3004 and the console need about a tenant's generator. */
export interface GeneratorInfo {
  ready: boolean;
  /** Why not ready: the tenant has no AT-Protocol identity of its own. */
  reason: string | null;
  did: string | null;
  method: 'web' | 'plc' | null;
  endpoint: string | null;
  serviceId: string;
  serviceType: string;
  /** Whether the DID document carries the `#bsky_fg` service now. */
  advertised: boolean;
}

export class FeedError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extensions: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export const DEFAULT_RULES: FeedRules = { authors: null, collections: ['app.bsky.feed.post'], keywords: null, labels: null, excludeLabels: ['!hide'] };

const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
/** Index rows take monotonic ULIDs: within one millisecond (the same `sort` of a newest-first feed) the later is greater. */
const itemId = monotonicFactory();

const feedFrom = (r: Record<string, unknown>): FeedRow => ({
  ...(r as unknown as FeedRow),
  rules: { ...DEFAULT_RULES, ...json<Partial<FeedRules>>(r.rules, {}) },
  ranking: json<FeedRanking | null>(r.ranking, null),
  retention_hours: num(r.retention_hours),
  max_items: num(r.max_items),
  rate_per_minute: num(r.rate_per_minute),
  rev: num(r.rev),
  published_at: numOrNull(r.published_at),
  indexed: num(r.indexed),
  served: num(r.served),
  rank_failed: num(r.rank_failed),
  created_at: num(r.created_at),
  updated_at: num(r.updated_at)
});

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A keyword matcher: any keyword, case-insensitive, not inside a longer word. */
export function keywordMatcher(keywords: readonly string[]): (text: string) => boolean {
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${keywords.map((k) => escapeRe(k.trim())).join('|')})(?![\\p{L}\\p{N}_])`, 'iu');
  return (text) => re.test(text);
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) throw new Error('The embeddings have different sizes');
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const CURSOR_RE = /^(-?\d{1,19})::([0-9A-HJKMNP-TV-Z]{26})$/;
const FEED_URI_RE = /^at:\/\/(did:[a-z]+:[A-Za-z0-9._:%-]{1,2000})\/app\.bsky\.feed\.generator\/([a-zA-Z0-9-]{1,15})$/;

export class FeedGenerators {
  private readonly cache = new Map<string, { at: number; feeds: FeedRow[] }>();
  private readonly queries = new Map<string, number[]>();
  private readonly matchers = new Map<string, (text: string) => boolean>();
  private j: ServiceJwtVerifier | null = null;

  constructor(
    private readonly s: () => Services,
    readonly o: { maxPerTenant: number; itemsMax: number }
  ) {}

  private get db() {
    return this.s().db;
  }

  /** B-3001: verifies callers' service JWTs (their DID documents through the service URL checks, cached). */
  get jwt(): ServiceJwtVerifier {
    if (this.j) return this.j;
    const s = this.s();
    this.j = new ServiceJwtVerifier(new DidResolver(s.atproto.http, () => s.cfg.ATPROTO_PLC_URL, 5 * 60_000, 10_000));
    return this.j;
  }

  private audit(by: FeedActor, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: by.tenantId, action, kind: by.userId ? 'admin' : 'system', actor: by.actor, target, label: 'internal', ...(detail ? { detail } : {}), traceId: by.traceId ?? null });
  }

  private changed(tenantId: string): void {
    this.cache.delete(tenantId);
    this.s().bus.publish(FEEDS_TOPIC, { tenantId });
  }

  // ---------- the generator (B-3001, and what B-3004 needs) ----------

  async generator(tenantId: string): Promise<GeneratorInfo> {
    const identity = await this.s().atproto.identity(tenantId);
    const base = { serviceId: `#${FEED_SERVICE_ID}`, serviceType: FEED_SERVICE_TYPE };
    if (!identity) return { ...base, ready: false, reason: "The tenant has no AT-Protocol identity of its own (POST /api/atproto/identity); feeds are served under the tenant's DID.", did: null, method: null, endpoint: null, advertised: false };
    const advertised = identity.method === 'plc' ? !!identity.plc_op?.services[FEED_SERVICE_ID] : (await this.list(tenantId)).length > 0;
    return { ...base, ready: true, reason: null, did: identity.did, method: identity.method, endpoint: identity.endpoint, advertised };
  }

  /** The services the feed generator adds to a did:web document (`AtprotoService.document`). */
  async didServices(identity: IdentityRow): Promise<Record<string, PlcService>> {
    if (identity.tenant_id === null || identity.method !== 'web') return {};
    const any = await this.db('atproto_feeds').where({ tenant_id: identity.tenant_id }).first('id');
    return any ? { [FEED_SERVICE_ID]: { type: FEED_SERVICE_TYPE, endpoint: identity.endpoint } } : {};
  }

  /** The feed's at:// URI: under the repo its record was published to (B-3004), else under the generator's DID. */
  feedUri(row: FeedRow, generatorDid: string): string {
    return `at://${row.publisher_did ?? generatorDid}/${GENERATOR_COLLECTION}/${row.rkey}`;
  }

  /** The `app.bsky.feed.generator` record B-3004 publishes: it names the generator's service DID. */
  recordFor(row: FeedRow, generatorDid: string): Record<string, unknown> {
    return { $type: GENERATOR_COLLECTION, did: generatorDid, displayName: row.display_name, ...(row.description ? { description: row.description } : {}), createdAt: new Date(row.created_at).toISOString() };
  }

  /** B-3004: records where the generator record was published (or `null` to forget it). */
  async markPublished(by: FeedActor, row: FeedRow, p: { did: string; uri: string; cid: string | null } | null): Promise<FeedRow> {
    if (p && !p.uri.startsWith(`at://${p.did}/${GENERATOR_COLLECTION}/${row.rkey}`)) throw new FeedError(400, `The record URI must be at://${p.did}/${GENERATOR_COLLECTION}/${row.rkey}.`);
    await this.db('atproto_feeds')
      .where({ id: row.id })
      .update({ publisher_did: p?.did ?? null, record_uri: p?.uri ?? null, record_cid: p?.cid ?? null, published_at: p ? Date.now() : null, updated_at: Date.now() });
    await this.audit(by, p ? 'atproto.feed.published' : 'atproto.feed.unpublished', { feed: row.id, rkey: row.rkey }, p ? { did: p.did, uri: p.uri, cid: p.cid } : { was: row.record_uri });
    this.changed(row.tenant_id);
    return (await this.get(row.tenant_id, row.id))!;
  }

  // ---------- feeds (admin) ----------

  async list(tenantId: string): Promise<FeedRow[]> {
    return ((await this.db('atproto_feeds').where({ tenant_id: tenantId }).orderBy('created_at', 'asc')) as Record<string, unknown>[]).map(feedFrom);
  }

  async get(tenantId: string, id: string): Promise<FeedRow | undefined> {
    const r = (await this.db('atproto_feeds').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
    return r ? feedFrom(r) : undefined;
  }

  async byRkey(tenantId: string, rkey: string): Promise<FeedRow | undefined> {
    const r = (await this.db('atproto_feeds').where({ tenant_id: tenantId, rkey }).first()) as Record<string, unknown> | undefined;
    return r ? feedFrom(r) : undefined;
  }

  async items(row: FeedRow): Promise<number> {
    const r = (await this.db('atproto_feed_items').where({ feed_id: row.id }).count({ n: '*' }).first()) as { n: number | string } | undefined;
    return Number(r?.n ?? 0);
  }

  private async checkSubscription(tenantId: string, id: string | null | undefined): Promise<void> {
    if (id && !(await this.s().firehose.get(tenantId, id))) throw new FeedError(400, 'The firehose subscription is not in this tenant.');
  }

  private async checkRanking(tenantId: string, r: FeedRanking | null | undefined): Promise<void> {
    if (!r) return;
    if (r.kind === 'embedding') {
      try {
        const p = await this.s().gateway.resolve(tenantId, r.profile);
        if (!p.model.capabilities.includes('embedding')) throw new FeedError(400, `Profile ${p.profile.name} routes to ${p.model.name}, which is not an embedding model.`, { step: 'ranking' });
      } catch (err) {
        if (err instanceof FeedError) throw err;
        throw new FeedError(400, `The ranking profile cannot be used: ${(err as Error).message}`, { step: 'ranking' });
      }
    } else {
      const c = await this.s().guard.classifiers.get(tenantId, r.classifier);
      if (!c) throw new FeedError(400, `There is no classifier ${r.classifier}.`, { step: 'ranking' });
      if (!c.config.labels.some((l) => l.label === r.label)) throw new FeedError(400, `${c.name} has no label ${r.label} (it has ${c.config.labels.map((l) => l.label).join(', ')}).`, { step: 'ranking' });
    }
  }

  private retention(v: number | undefined): number {
    return v ?? 72;
  }

  async create(by: FeedActor, input: FeedInput): Promise<FeedRow> {
    const tenantId = by.tenantId;
    if (!FEED_RKEY_RE.test(input.rkey)) throw new FeedError(400, 'A feed key is 1 to 15 letters, digits or hyphens.');
    const identity = await this.s().atproto.identity(tenantId);
    if (!identity) throw new FeedError(409, "Create the tenant's AT-Protocol identity first (POST /api/atproto/identity): feeds are served under the tenant's DID.", { step: 'identity' });
    if ((await this.list(tenantId)).length >= this.o.maxPerTenant) throw new FeedError(409, `A tenant has at most ${this.o.maxPerTenant} feeds (FEEDS_MAX_PER_TENANT).`);
    if ((input.maxItems ?? 0) > this.o.itemsMax) throw new FeedError(400, `A feed keeps at most ${this.o.itemsMax} posts (FEED_ITEMS_MAX).`);
    await this.checkSubscription(tenantId, input.subscriptionId);
    await this.checkRanking(tenantId, input.ranking);
    // did:plc: the DID document gains the #bsky_fg service through a signed PLC operation (did:web computes it).
    if (identity.method === 'plc') {
      try {
        await this.s().atproto.ensurePlcService({ ...by }, identity, FEED_SERVICE_ID, { type: FEED_SERVICE_TYPE, endpoint: identity.endpoint });
      } catch (err) {
        const e = err as { status?: number; message: string; extensions?: Record<string, unknown> };
        throw new FeedError(e.status ?? 502, e.message, e.extensions ?? { step: 'plc' });
      }
    }
    const id = ulid();
    const now = Date.now();
    const rules: FeedRules = { ...DEFAULT_RULES, ...input.rules };
    try {
      await this.db('atproto_feeds').insert({
        id,
        tenant_id: tenantId,
        rkey: input.rkey,
        display_name: input.displayName,
        description: input.description ?? null,
        subscription_id: input.subscriptionId ?? null,
        rules: JSON.stringify(rules),
        ranking: input.ranking ? JSON.stringify(input.ranking) : null,
        retention_hours: this.retention(input.retentionHours),
        max_items: input.maxItems ?? Math.min(10_000, this.o.itemsMax),
        rate_per_minute: input.ratePerMinute ?? 300,
        auth: input.auth ?? 'optional',
        state: input.state ?? 'active',
        rev: 1,
        publisher_did: null,
        record_uri: null,
        record_cid: null,
        published_at: null,
        indexed: 0,
        served: 0,
        rank_failed: 0,
        last_error: null,
        created_by: by.userId,
        created_at: now,
        updated_at: now
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new FeedError(409, `A feed with the key ${input.rkey} exists.`);
      throw err;
    }
    await this.audit(by, 'atproto.feed.created', { feed: id, rkey: input.rkey }, { displayName: input.displayName, subscription: input.subscriptionId ?? null, rules: { authors: rules.authors?.length ?? null, collections: rules.collections, keywords: rules.keywords?.length ?? null, labels: rules.labels, excludeLabels: rules.excludeLabels }, ranking: input.ranking?.kind ?? null, generator: identity.did });
    this.changed(tenantId);
    return (await this.get(tenantId, id))!;
  }

  async update(by: FeedActor, row: FeedRow, patch: FeedPatch): Promise<FeedRow> {
    const set: Record<string, unknown> = {};
    const detail: Record<string, unknown> = {};
    if (patch.displayName !== undefined && patch.displayName !== row.display_name) set.display_name = detail.displayName = patch.displayName;
    if (patch.description !== undefined && patch.description !== row.description) set.description = detail.description = patch.description;
    if (patch.subscriptionId !== undefined && patch.subscriptionId !== row.subscription_id) {
      await this.checkSubscription(row.tenant_id, patch.subscriptionId);
      set.subscription_id = detail.subscription = patch.subscriptionId;
    }
    let rules = row.rules;
    if (patch.rules !== undefined) {
      rules = { ...row.rules, ...patch.rules };
      set.rules = JSON.stringify(rules);
      detail.rules = { authors: rules.authors?.length ?? null, collections: rules.collections, keywords: rules.keywords?.length ?? null, labels: rules.labels, excludeLabels: rules.excludeLabels };
    }
    if (patch.ranking !== undefined) {
      await this.checkRanking(row.tenant_id, patch.ranking);
      set.ranking = patch.ranking ? JSON.stringify(patch.ranking) : null;
      detail.ranking = patch.ranking?.kind ?? null;
    }
    if (patch.retentionHours !== undefined) set.retention_hours = detail.retentionHours = patch.retentionHours;
    if (patch.maxItems !== undefined) {
      if (patch.maxItems > this.o.itemsMax) throw new FeedError(400, `A feed keeps at most ${this.o.itemsMax} posts (FEED_ITEMS_MAX).`);
      set.max_items = detail.maxItems = patch.maxItems;
    }
    if (patch.ratePerMinute !== undefined) set.rate_per_minute = detail.ratePerMinute = patch.ratePerMinute;
    if (patch.auth !== undefined) set.auth = detail.auth = patch.auth;
    if (patch.state !== undefined) set.state = detail.state = patch.state;
    if (!Object.keys(set).length) return row;
    // What the index holds was chosen by the old rules: drop what the new ones would not take. Keywords and the
    // ranking cannot be checked again (the text is not kept), so changing either empties the index.
    const keywordsChanged = patch.rules?.keywords !== undefined && JSON.stringify(patch.rules.keywords) !== JSON.stringify(row.rules.keywords);
    const rankingChanged = patch.ranking !== undefined && JSON.stringify(patch.ranking) !== JSON.stringify(row.ranking);
    let removed = 0;
    await this.db.transaction(async (trx) => {
      await trx('atproto_feeds')
        .where({ id: row.id })
        .update({ ...set, rev: row.rev + 1, updated_at: Date.now() });
      if (keywordsChanged || rankingChanged) removed = Number(await trx('atproto_feed_items').where({ feed_id: row.id }).delete());
      else if (patch.rules !== undefined) removed = await this.pruneRules(trx, row.id, rules);
    });
    if (removed) detail.removed = removed;
    await this.audit(by, 'atproto.feed.updated', { feed: row.id, rkey: row.rkey }, detail);
    this.changed(row.tenant_id);
    return (await this.get(row.tenant_id, row.id))!;
  }

  /** Deletes indexed posts whose author or collection the rules no longer take. */
  private async pruneRules(trx: Services['db'], feedId: string, rules: FeedRules): Promise<number> {
    let removed = 0;
    const authors = rules.authors ? new Set(rules.authors) : null;
    let after = '';
    for (;;) {
      const rows = (await trx('atproto_feed_items').where({ feed_id: feedId }).andWhere('id', '>', after).orderBy('id', 'asc').limit(1000).select('id', 'author_did', 'collection')) as { id: string; author_did: string; collection: string }[];
      if (!rows.length) break;
      const out = rows.filter((r) => (authors && !authors.has(r.author_did)) || !collectionAllowed(r.collection, rules.collections)).map((r) => r.id);
      if (out.length) removed += Number(await trx('atproto_feed_items').whereIn('id', out).delete());
      after = rows.at(-1)!.id;
    }
    return removed;
  }

  /** A deleted post leaves every feed of the tenant (the firehose saw its delete). */
  async forget(tenantId: string, uri: string): Promise<void> {
    await this.db('atproto_feed_items').where({ tenant_id: tenantId, uri_hash: hash(uri) }).delete();
  }

  /** Deletes a feed and its index. */
  async remove(by: FeedActor, row: FeedRow): Promise<void> {
    const items = await this.items(row);
    await this.db.transaction(async (trx) => {
      await trx('atproto_feed_items').where({ feed_id: row.id }).delete();
      await trx('atproto_feeds').where({ id: row.id }).delete();
    });
    await this.audit(by, 'atproto.feed.deleted', { feed: row.id, rkey: row.rkey }, { items, publishedAs: row.record_uri });
    this.changed(row.tenant_id);
  }

  view(row: FeedRow, generatorDid: string | null, items?: number) {
    return {
      id: row.id,
      rkey: row.rkey,
      uri: generatorDid ? this.feedUri(row, generatorDid) : null,
      displayName: row.display_name,
      description: row.description,
      subscriptionId: row.subscription_id,
      rules: row.rules,
      ranking: row.ranking,
      retentionHours: row.retention_hours,
      maxItems: row.max_items,
      ratePerMinute: row.rate_per_minute,
      auth: row.auth,
      state: row.state,
      rev: row.rev,
      record: generatorDid ? this.recordFor(row, generatorDid) : null,
      published: row.record_uri ? { did: row.publisher_did, uri: row.record_uri, cid: row.record_cid, at: row.published_at } : null,
      counts: { indexed: row.indexed, served: row.served, rankFailed: row.rank_failed, ...(items !== undefined ? { items } : {}) },
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  // ---------- ingest from the firehose (B-3002) ----------

  /** The tenant's active feeds (cached for a few seconds; every instance drops its copy on a change, over the bus). */
  private async active(tenantId: string): Promise<FeedRow[]> {
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < 5000) return hit.feeds;
    const feeds = ((await this.db('atproto_feeds').where({ tenant_id: tenantId, state: 'active' })) as Record<string, unknown>[]).map(feedFrom);
    if (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(tenantId, { at: Date.now(), feeds });
    return feeds;
  }

  /** Whether the tenant has an active feed (the firehose skips deletes otherwise). */
  async hasActive(tenantId: string): Promise<boolean> {
    return (await this.active(tenantId)).length > 0;
  }

  private matches(row: FeedRow, post: Pick<Post, 'did' | 'collection' | 'text'>): boolean {
    const r = row.rules;
    if (r.authors && !r.authors.includes(post.did)) return false;
    if (!collectionAllowed(post.collection, r.collections)) return false;
    if (r.keywords?.length) {
      const key = `${row.id}:${row.rev}`;
      let m = this.matchers.get(key);
      if (!m) {
        m = keywordMatcher(r.keywords);
        if (this.matchers.size > 1000) this.matchers.delete(this.matchers.keys().next().value!);
        this.matchers.set(key, m);
      }
      if (!m(post.text)) return false;
    }
    return true;
  }

  private labelsPass(rules: FeedRules, labels: Set<string>): boolean {
    if (rules.excludeLabels.some((l) => labels.has(l))) return false;
    if (rules.labels?.length && !rules.labels.some((l) => labels.has(l))) return false;
    return true;
  }

  /**
   * The labels in force on subjects for a tenant: from its labeler (the last label per value, unless negated) and
   * from its trusted external labelers (likewise per labeler, and not expired).
   */
  async labelsOn(tenantId: string, uris: string[]): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>(uris.map((u) => [u, new Set<string>()]));
    if (!uris.length) return out;
    const hashes = [...new Set(uris.map(hash))];
    const own = (await this.db('atproto_labels').where({ tenant_id: tenantId }).whereIn('uri_hash', hashes).orderBy('seq', 'asc').select('uri', 'val', 'neg')) as { uri: string; val: string; neg: unknown }[];
    const last = new Map<string, boolean>();
    for (const r of own) last.set(`${r.uri}\n${r.val}`, r.neg === true || r.neg === 1 || r.neg === '1');
    const inbound = (await this.db('atproto_inbound_labels').where({ tenant_id: tenantId }).whereIn('uri_hash', hashes).orderBy('created_at', 'asc').select('labeler_id', 'uri', 'val', 'neg', 'exp')) as { labeler_id: string; uri: string; val: string; neg: unknown; exp: string | null }[];
    const lastIn = new Map<string, boolean>();
    for (const r of inbound) lastIn.set(`${r.labeler_id}\n${r.uri}\n${r.val}`, r.neg === true || r.neg === 1 || r.neg === '1' || (!!r.exp && Date.parse(r.exp) < Date.now()));
    for (const [k, neg] of last) {
      const [uri, val] = k.split('\n') as [string, string];
      if (!neg) out.get(uri)?.add(val);
    }
    for (const [k, neg] of lastIn) {
      const [, uri, val] = k.split('\n') as [string, string, string];
      if (!neg) out.get(uri)?.add(val);
    }
    return out;
  }

  /** The ranking score of a text for a feed, through the gateway. */
  async rank(row: FeedRow, text: string, label: Label): Promise<number> {
    const r = row.ranking!;
    const s = this.s();
    if (r.kind === 'embedding') {
      const p = await s.gateway.resolve(row.tenant_id, r.profile);
      if (labelRank(label) > labelRank(p.profile.label)) throw new Error(`Profile ${p.profile.name} handles data up to ${p.profile.label}; the posts are ${label}.`);
      const key = `${row.id}:${row.rev}:${p.model.name}`;
      let q = this.queries.get(key);
      if (!q) {
        q = (await s.gateway.embed(p.model.name, [r.query], label)).embeddings[0]!;
        if (this.queries.size > 1000) this.queries.delete(this.queries.keys().next().value!);
        this.queries.set(key, q);
      }
      const v = (await s.gateway.embed(p.model.name, [text], label)).embeddings[0]!;
      return cosine(q, v);
    }
    const c = await s.guard.classifiers.get(row.tenant_id, r.classifier);
    if (!c) throw new Error(`The classifier ${r.classifier} no longer exists`);
    const out = await s.guard.classifiers.score(row.tenant_id, c, text, label);
    return out.scores[r.label] ?? 0;
  }

  /**
   * A post the firehose took and the moderation check passed (`firehose.ts`): each active feed of the tenant whose
   * subscription and rules take it indexes it once.
   */
  async ingest(sub: Pick<SubscriptionRow, 'id' | 'tenant_id' | 'label'>, post: Post, verdict: { action: GuardAction; labels: string[] }): Promise<number> {
    const feeds = (await this.active(sub.tenant_id)).filter((f) => !f.subscription_id || f.subscription_id === sub.id);
    let indexed = 0;
    let labels: Set<string> | null = null;
    for (const f of feeds) {
      if (!this.matches(f, post)) continue;
      if (f.rules.labels?.length || f.rules.excludeLabels.length) {
        if (!labels) {
          labels = (await this.labelsOn(sub.tenant_id, [post.uri])).get(post.uri)!;
          for (const v of [...verdict.labels, ...labelsForDecision({ action: verdict.action, findings: [] })]) labels.add(v);
        }
        if (!this.labelsPass(f.rules, labels)) continue;
      }
      let score: number | null = null;
      if (f.ranking) {
        try {
          score = await this.rank(f, post.text, sub.label);
        } catch (err) {
          await this.db('atproto_feeds')
            .where({ id: f.id })
            .update({ rank_failed: this.db.raw('rank_failed + 1'), last_error: `Ranking ${post.uri.slice(0, 200)} failed: ${(err as Error).message}`.slice(0, 500) });
          continue;
        }
        if (f.ranking.minScore !== undefined && score < f.ranking.minScore) continue;
      }
      const now = Date.now();
      try {
        await this.db('atproto_feed_items').insert({ id: itemId(), feed_id: f.id, tenant_id: f.tenant_id, uri: post.uri, uri_hash: hash(post.uri), cid: post.cid, author_did: post.did, collection: post.collection, sort: score === null ? now : Math.round(score * 1e9), score, created_at: now });
      } catch (err) {
        if (isUniqueViolation(err)) continue; // already in this feed (an edit, or a replay)
        throw err;
      }
      await this.db('atproto_feeds')
        .where({ id: f.id })
        .update({ indexed: this.db.raw('indexed + 1') });
      indexed++;
    }
    return indexed;
  }

  // ---------- serving (B-3001, B-3003) ----------

  /** The feed an at:// feed URI names on this tenant's generator, if it serves it. */
  async resolveFeed(tenantId: string, feedUri: string): Promise<FeedRow | undefined> {
    const m = FEED_URI_RE.exec(feedUri);
    if (!m) return undefined;
    const row = await this.byRkey(tenantId, m[2]!);
    if (!row || row.state !== 'active') return undefined;
    // Once published, only the published record's URI names it.
    if (row.publisher_did && row.publisher_did !== m[1]) return undefined;
    return row;
  }

  /** `describeFeedGenerator`: the generator's DID and its active feeds. */
  async describe(identity: IdentityRow): Promise<{ did: string; feeds: { uri: string }[] }> {
    const feeds = identity.tenant_id ? (await this.list(identity.tenant_id)).filter((f) => f.state === 'active') : [];
    return { did: identity.did, feeds: feeds.map((f) => ({ uri: this.feedUri(f, identity.did) })) };
  }

  /**
   * One page of a feed, newest (or highest-ranked) first. The cursor is `<sort>::<id>` of the last row scanned; the
   * next page starts strictly after it. Rows outside retention, or that the current rules or labels exclude, are not
   * served (a page may then hold fewer than `limit` posts and still carry a cursor). A `preview` (the admin API) is not
   * counted as served.
   */
  async skeleton(row: FeedRow, o: { limit: number; cursor?: string | null; preview?: boolean }): Promise<{ feed: { post: string }[]; cursor?: string }> {
    const q = this.db('atproto_feed_items')
      .where({ feed_id: row.id })
      .andWhere('created_at', '>=', Date.now() - row.retention_hours * 3_600_000)
      .orderBy([
        { column: 'sort', order: 'desc' },
        { column: 'id', order: 'desc' }
      ])
      .limit(o.limit)
      .select('id', 'uri', 'author_did', 'collection', 'sort');
    if (o.cursor) {
      const m = CURSOR_RE.exec(o.cursor);
      if (!m) throw new FeedError(400, 'The cursor is not one this feed gave.', { error: 'BadCursor' });
      const sort = Number(m[1]);
      if (!Number.isSafeInteger(sort)) throw new FeedError(400, 'The cursor is not one this feed gave.', { error: 'BadCursor' });
      q.andWhere((w) => w.where('sort', '<', sort).orWhere((x) => x.where('sort', sort).andWhere('id', '<', m[2]!)));
    }
    const rows = (await q) as { id: string; uri: string; author_did: string; collection: string; sort: number | string }[];
    const authors = row.rules.authors ? new Set(row.rules.authors) : null;
    let kept = rows.filter((r) => (!authors || authors.has(r.author_did)) && collectionAllowed(r.collection, row.rules.collections));
    if (kept.length && (row.rules.labels?.length || row.rules.excludeLabels.length)) {
      const labels = await this.labelsOn(row.tenant_id, kept.map((r) => r.uri));
      kept = kept.filter((r) => this.labelsPass(row.rules, labels.get(r.uri) ?? new Set()));
    }
    if (kept.length && !o.preview) {
      await this.db('atproto_feeds')
        .where({ id: row.id })
        .update({ served: this.db.raw('served + ?', [kept.length]) });
    }
    const last = rows.at(-1);
    return { feed: kept.map((r) => ({ post: r.uri })), ...(rows.length === o.limit && last ? { cursor: `${Number(last.sort)}::${last.id}` } : {}) };
  }

  // ---------- retention (B-3003) ----------

  /** Deletes rows past their feed's retention, and the oldest (lowest-ranked) beyond its `maxItems`. */
  async prune(tenantId?: string): Promise<{ feeds: number; removed: number }> {
    const q = this.db('atproto_feeds');
    if (tenantId) q.where({ tenant_id: tenantId });
    const feeds = ((await q) as Record<string, unknown>[]).map(feedFrom);
    let removed = 0;
    for (const f of feeds) {
      removed += Number(await this.db('atproto_feed_items').where({ feed_id: f.id }).andWhere('created_at', '<', Date.now() - f.retention_hours * 3_600_000).delete());
      // Beyond maxItems: find the row at that position in serving order and delete what sorts after it.
      const edge = (await this.db('atproto_feed_items')
        .where({ feed_id: f.id })
        .orderBy([
          { column: 'sort', order: 'desc' },
          { column: 'id', order: 'desc' }
        ])
        .offset(f.max_items)
        .limit(1)
        .select('id', 'sort')
        .first()) as { id: string; sort: number | string } | undefined;
      if (edge) {
        const sort = Number(edge.sort);
        removed += Number(
          await this.db('atproto_feed_items')
            .where({ feed_id: f.id })
            .andWhere((w) => w.where('sort', '<', sort).orWhere((x) => x.where('sort', sort).andWhere('id', '<=', edge.id)))
            .delete()
        );
      }
    }
    return { feeds: feeds.length, removed };
  }

  registerJobs(): void {
    const s = this.s();
    s.jobs.register(PRUNE_JOB, async (_p, ctx) => this.prune(ctx.job.tenant_id));
    s.bus.on<{ tenantId?: string }>(FEEDS_TOPIC, (e) => {
      if (e.tenantId) this.cache.delete(e.tenantId);
    });
  }

  schedule(scheduler: Scheduler): void {
    scheduler.every(PRUNE_JOB, this.s().cfg.FEED_PRUNE_MINUTES * 60_000, async () => {
      const rows = (await this.db('atproto_feeds').distinct('tenant_id')) as { tenant_id: string }[];
      return rows.map((r) => ({ tenantId: r.tenant_id }));
    });
  }
}
