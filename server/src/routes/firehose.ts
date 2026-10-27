import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { clears, LABELS } from '../authz/labels.js';
import { COLLECTION_RE } from '../atproto/firehose-frames.js';
import type { FirehoseActor, SubscriptionRow } from '../atproto/firehose.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { notFound } from '../http/problem.js';
import type { Services } from '../services.js';

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const collection = z.string().trim().max(317).regex(COLLECTION_RE, 'an NSID such as app.bsky.feed.post, or a prefix such as app.bsky.graph.*');
const did = z.string().trim().max(2048).regex(/^did:(plc:[a-z2-7]{24}|web:[A-Za-z0-9.%:-]{3,250})$/, 'a did:plc or did:web');
const fields = {
  name: z.string().trim().min(1).max(100),
  protocol: z.enum(['jetstream', 'subscribe-repos']),
  endpoint: z.url().max(500),
  collections: z.array(collection).min(1).max(100),
  // Jetstream takes at most 10,000 wantedDids; null takes everyone.
  dids: z.array(did).min(1).max(10_000).nullable(),
  sampleRate: z.number().gt(0).max(1),
  workspaceId: id26.nullable(),
  label: z.enum(LABELS)
};
const createBody = z
  .object({ ...fields, collections: fields.collections.optional(), dids: fields.dids.optional(), sampleRate: fields.sampleRate.optional(), workspaceId: fields.workspaceId.optional(), label: fields.label.optional(), start: z.boolean().optional() })
  .strict();
const patchBody = z
  .object({
    name: fields.name.optional(),
    protocol: fields.protocol.optional(),
    endpoint: fields.endpoint.optional(),
    collections: fields.collections.optional(),
    dids: fields.dids.optional(),
    sampleRate: fields.sampleRate.optional(),
    workspaceId: fields.workspaceId.optional(),
    label: fields.label.optional(),
    cursor: z.null().optional()
  })
  .strict();

/**
 * AT-Protocol firehose subscriptions (Sprint 27, B-1908) under `/api/atproto/firehose`, all with `firehose:manage`:
 * create, change, start, stop and remove a tenant's subscriptions, and read their status. A subscription labelled
 * above the caller's clearance is not shown to them. The consumers themselves run on worker instances
 * (`atproto/firehose.ts`).
 */
export function firehoseRoutes(s: Services): Router {
  const r = Router();
  r.use('/atproto/firehose', noStore, requireAuth());
  const perm = requirePermission(s, 'firehose:manage');
  const f = s.firehose;

  const by = (req: Request): FirehoseActor => {
    const p = principalOf(req);
    return { tenantId: p.tenantId, userId: p.userId, actor: actorFrom(p, ip(req)), traceId: req.traceId };
  };

  const load = async (req: Request): Promise<SubscriptionRow> => {
    const p = principalOf(req);
    const id = id26.safeParse(req.params.id);
    const row = id.success ? await f.get(p.tenantId, id.data) : undefined;
    if (!row || !clears(p.clearance, row.label)) throw notFound('Firehose subscription');
    return row;
  };

  r.get('/atproto/firehose', perm, async (req, res) => {
    const p = principalOf(req);
    res.json({ subscriptions: (await f.list(p.tenantId)).filter((x) => clears(p.clearance, x.label)).map((x) => f.view(x)) });
  });

  r.post('/atproto/firehose', perm, async (req, res) => {
    const b = parseBody(createBody, req.body);
    const row = await f.create(by(req), principalOf(req).clearance, b);
    res.status(201).json(f.view(row));
  });

  r.get('/atproto/firehose/:id', perm, async (req, res) => {
    res.json(f.view(await load(req)));
  });

  r.patch('/atproto/firehose/:id', perm, async (req, res) => {
    const row = await load(req);
    const b = parseBody(patchBody, req.body);
    res.json(f.view(await f.update(by(req), principalOf(req).clearance, row, b)));
  });

  r.delete('/atproto/firehose/:id', perm, async (req, res) => {
    await f.remove(by(req), await load(req));
    res.status(204).end();
  });

  r.post('/atproto/firehose/:id/start', perm, async (req, res) => {
    parseBody(z.object({}).strict(), req.body ?? {});
    res.json(f.view(await f.setState(by(req), await load(req), 'running')));
  });

  r.post('/atproto/firehose/:id/stop', perm, async (req, res) => {
    parseBody(z.object({}).strict(), req.body ?? {});
    res.json(f.view(await f.setState(by(req), await load(req), 'stopped')));
  });

  return r;
}
