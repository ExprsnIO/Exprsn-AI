import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { FEED_RKEY_RE, FeedError, type FeedActor, type FeedRow } from '../atproto/feeds.js';
import { COLLECTION_RE } from '../atproto/firehose-frames.js';
import { AtprotoError } from '../atproto/service.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const did = z.string().trim().max(300).regex(/^did:(plc:[a-z2-7]{24}|web:[A-Za-z0-9.%:-]{3,250})$/, 'a did:plc or did:web');
const collection = z.string().trim().max(317).regex(COLLECTION_RE, 'an NSID such as app.bsky.feed.post, or a prefix such as app.bsky.graph.*');
const labelVal = z.string().regex(/^!?[a-z0-9][a-z0-9-]{0,127}$/, 'a label value: lower-case letters, digits and hyphens, optionally after !');
const rules = z
  .object({
    authors: z.array(did).min(1).max(10_000).nullable().optional(),
    collections: z.array(collection).min(1).max(100).optional(),
    keywords: z.array(z.string().trim().min(1).max(100)).min(1).max(200).nullable().optional(),
    labels: z.array(labelVal).min(1).max(50).nullable().optional(),
    excludeLabels: z.array(labelVal).max(50).optional()
  })
  .strict();
const ranking = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('embedding'), profile: z.string().trim().min(1).max(100), query: z.string().trim().min(1).max(2000), minScore: z.number().min(-1).max(1).optional() }).strict(),
  z.object({ kind: z.literal('classifier'), classifier: z.string().trim().min(1).max(100), label: z.string().trim().min(1).max(100), minScore: z.number().min(0).max(1).optional() }).strict()
]);
const fields = {
  displayName: z.string().trim().min(1).max(24),
  description: z.string().trim().max(300).nullable(),
  subscriptionId: id26.nullable(),
  rules,
  ranking: ranking.nullable(),
  retentionHours: z.number().int().min(1).max(8760),
  maxItems: z.number().int().min(10),
  ratePerMinute: z.number().int().min(1).max(100_000),
  auth: z.enum(['optional', 'required']),
  state: z.enum(['active', 'paused'])
};
const createBody = z
  .object({
    rkey: z.string().regex(FEED_RKEY_RE, '1 to 15 letters, digits or hyphens'),
    displayName: fields.displayName,
    description: fields.description.optional(),
    subscriptionId: fields.subscriptionId.optional(),
    rules: fields.rules.optional(),
    ranking: fields.ranking.optional(),
    retentionHours: fields.retentionHours.optional(),
    maxItems: fields.maxItems.optional(),
    ratePerMinute: fields.ratePerMinute.optional(),
    auth: fields.auth.optional(),
    state: fields.state.optional()
  })
  .strict();
const patchBody = z
  .object({
    displayName: fields.displayName.optional(),
    description: fields.description.optional(),
    subscriptionId: fields.subscriptionId.optional(),
    rules: fields.rules.optional(),
    ranking: fields.ranking.optional(),
    retentionHours: fields.retentionHours.optional(),
    maxItems: fields.maxItems.optional(),
    ratePerMinute: fields.ratePerMinute.optional(),
    auth: fields.auth.optional(),
    state: fields.state.optional()
  })
  .strict();
const publicationBody = z
  .object({
    did,
    uri: z.string().trim().max(500).regex(/^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]+\/app\.bsky\.feed\.generator\/[a-zA-Z0-9-]{1,15}$/, 'the at:// URI of an app.bsky.feed.generator record'),
    cid: z
      .string()
      .regex(/^b[a-z2-7]{8,200}$/, 'a base32 CIDv1')
      .nullable()
      .optional()
  })
  .strict();
const pageQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(200).optional() }).strict();

const TITLES: Record<number, string> = { 400: 'Invalid request', 403: 'Forbidden', 404: 'Not found', 409: 'Conflict', 502: 'Upstream error' };

/**
 * Custom feed generators (Sprint 31, B-3001 to B-3003) under `/api/atproto/feeds`, all with `firehose:manage` (feeds are
 * rules over the firehose subscriptions that permission manages): the tenant's generator (its service DID and
 * endpoint), its feeds with their rules, ranking, retention and rate limit, a preview page of each, and where the
 * generator record was published (B-3004 records it here, or an admin who published it from an external account).
 * The public XRPC side is `atproto-feeds-public.ts`.
 */
export function atprotoFeedRoutes(s: Services): Router {
  const r = Router();
  r.use('/atproto/feeds', noStore, requireAuth());
  const perm = requirePermission(s, 'firehose:manage');
  const g = s.feedGenerators;

  const by = (req: Request): FeedActor => {
    const p = principalOf(req);
    return { tenantId: p.tenantId, userId: p.userId, actor: actorFrom(p, ip(req)), traceId: req.traceId };
  };

  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof FeedError || err instanceof AtprotoError) throw new HttpProblem(err.status, TITLES[err.status] ?? 'Error', err.message, { extensions: err.extensions });
      throw err;
    }
  };

  const load = async (req: Request): Promise<FeedRow> => {
    const id = id26.safeParse(req.params.id);
    const row = id.success ? await g.get(principalOf(req).tenantId, id.data) : undefined;
    if (!row) throw notFound('Feed');
    return row;
  };

  const generatorDid = async (req: Request) => (await g.generator(principalOf(req).tenantId)).did;

  r.get('/atproto/feeds', perm, async (req, res) => {
    const tenantId = principalOf(req).tenantId;
    const generator = await g.generator(tenantId);
    const rows = await g.list(tenantId);
    res.json({ generator, feeds: await Promise.all(rows.map(async (f) => g.view(f, generator.did, await g.items(f)))) });
  });

  r.post('/atproto/feeds', perm, async (req, res) => {
    const b = parseBody(createBody, req.body);
    const row = await run(() => g.create(by(req), b));
    res.status(201).json(g.view(row, await generatorDid(req), 0));
  });

  r.get('/atproto/feeds/:id', perm, async (req, res) => {
    const row = await load(req);
    res.json(g.view(row, await generatorDid(req), await g.items(row)));
  });

  r.patch('/atproto/feeds/:id', perm, async (req, res) => {
    const row = await load(req);
    const b = parseBody(patchBody, req.body);
    const out = await run(() => g.update(by(req), row, b));
    res.json(g.view(out, await generatorDid(req), await g.items(out)));
  });

  r.delete('/atproto/feeds/:id', perm, async (req, res) => {
    await g.remove(by(req), await load(req));
    res.status(204).end();
  });

  r.get('/atproto/feeds/:id/skeleton', perm, async (req, res) => {
    const row = await load(req);
    const q = parseBody(pageQuery, req.query);
    res.json(await run(() => g.skeleton(row, { limit: q.limit, cursor: q.cursor ?? null, preview: true })));
  });

  r.put('/atproto/feeds/:id/publication', perm, async (req, res) => {
    const row = await load(req);
    const b = parseBody(publicationBody, req.body);
    const out = await run(() => g.markPublished(by(req), row, { did: b.did, uri: b.uri, cid: b.cid ?? null }));
    res.json(g.view(out, await generatorDid(req), await g.items(out)));
  });

  r.delete('/atproto/feeds/:id/publication', perm, async (req, res) => {
    const row = await load(req);
    const out = await run(() => g.markPublished(by(req), row, null));
    res.json(g.view(out, await generatorDid(req), await g.items(out)));
  });

  return r;
}
