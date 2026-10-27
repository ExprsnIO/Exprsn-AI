import type { TLSSocket } from 'node:tls';
import express, { Router, type Request } from 'express';
import { z } from 'zod';
import type { CloudActor } from '../../cloud/accounts.js';
import { desiredSchema, monthOfTs, noticeSchema, policySchema } from '../../cloud/autoscale.js';
import { HttpProblem, notFound, tooManyRequests } from '../../http/problem.js';
import { Limiter } from '../../platform/ratelimit.js';
import { ip, noStore, parseBody, principalOf, requireAnyPermission, requireAuth, requirePermission } from '../../http/middleware.js';
import type { Services } from '../../services.js';

/*
 * 1.9.99-final, Sprint 60 (B-10402, B-10403, B-10406, B-10605): the Pools screen's cloud node group card, scale
 * policies and manual scaling, the idle GPU savings report, and the node-side interruption channel
 * (`cloud/autoscale.ts`). Without migration 158 the admin routes answer 503 `migration_pending`.
 *
 *   GET  /api/admin/pools/cloud                       the cloud card of every cloud pool (pools:manage)
 *   PUT  /api/admin/pools/:id/autoscale               { min, max, idleMinutes?, queueDepth?, maxColdWaitMinutes?, capacity?, onDemandFallback?, deploymentId?, resourceKey? } (pools:manage and cloud:deploy or cloud:admin)
 *   POST /api/admin/pools/:id/scale                   { desired, reason? } (pools:manage and cloud:deploy or cloud:admin); 409 budget_exceeded above the hard stop
 *   GET  /api/admin/cloud/gpu-savings?month=YYYY-MM   idle hours avoided and their saving per pool (finops:read or cloud:read)
 *   POST /cloud/v1/nodes/interruptions                { kind, eventId?, reclaimAt?, detail? } from a GPU node's watcher, outside /api: no
 *                                                     session, only the node's Exprsn-AI CA certificate (mTLS on this
 *                                                     server's socket, or the verified certificate a trusted proxy forwards)
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const actorOf = (req: Request): CloudActor => ({ principal: principalOf(req), ip: ip(req), traceId: req.traceId });

export function cloudAutoscaleRoutes(s: Services): Router {
  const r = Router();
  const a = () => s.cloud.autoscale;
  const pools = [noStore, requireAuth(), requirePermission(s, 'pools:manage')];
  const scale = [...pools, requireAnyPermission(s, ['cloud:deploy', 'cloud:admin'])];
  const savings = [noStore, requireAuth(), requireAnyPermission(s, ['finops:read', 'cloud:read'])];

  r.get('/pools/cloud', ...pools, async (_req, res) => {
    if (!(await a().installed())) {
      res.json({ installed: false, cards: {} });
      return;
    }
    const cards: Record<string, unknown> = {};
    for (const p of await s.gateway.repo.pools()) {
      const c = await a().card(p.id);
      if (c) cards[p.id] = c;
    }
    res.json({ installed: true, cards });
  });

  r.put('/pools/:id/autoscale', ...scale, async (req, res) => {
    const id = parseBody(id26, req.params.id);
    const body = parseBody(policySchema, req.body);
    await a().setPolicy(actorOf(req), id, body);
    res.json(await a().card(id));
  });

  r.post('/pools/:id/scale', ...scale, async (req, res) => {
    const id = parseBody(id26, req.params.id);
    const body = parseBody(desiredSchema, req.body);
    if (!(await s.gateway.repo.pool(id))) throw notFound('Pool');
    const out = await a().scaleTo(actorOf(req), id, body.desired, body.reason);
    res.json({ ...out, card: await a().card(id) });
  });

  r.get('/cloud/gpu-savings', ...savings, async (req, res) => {
    await a().need();
    const month = parseBody(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'a month (YYYY-MM)').default(monthOfTs(Date.now())), req.query.month);
    const names = new Map((await s.gateway.repo.pools()).map((p) => [p.id, p.name]));
    const rows = (await a().savings(month)).map((x) => ({ ...x, pool: names.get(x.poolId) ?? null }));
    res.json({ month, pools: rows });
  });

  return r;
}

/** The node-side watcher's channel, mounted at the root (outside `/api`, no session, no CSRF): mTLS only. */
export function cloudNodeRoutes(s: Services): Router {
  const r = Router();
  // A per-address limit (60 notices a minute: a watcher posts each notice once, and retries a failed post).
  const limit = new Limiter(s.counters, 'cloud-node-interruptions', 60, 60_000);
  r.post('/cloud/v1/nodes/interruptions', noStore, express.json({ limit: '4kb' }), async (req, res) => {
    const l = await limit.consume(ip(req) ?? 'unknown');
    if (!l.allowed) throw tooManyRequests('Too many interruption notices from this address; try again in a minute.', l.resetMs / 1000);
    const sock = req.socket as TLSSocket;
    let instanceId: string | null = null;
    if (typeof sock.getPeerCertificate === 'function' && sock.authorized) {
      const fp = sock.getPeerCertificate()?.fingerprint256;
      if (fp) instanceId = await s.cloud.autoscale.instanceForCertificate(fp);
    }
    if (!instanceId) {
      const c = s.memberCerts.clientCertificate(req);
      if (c.kind === 'cert') instanceId = await s.cloud.autoscale.instanceForCertificate(c.cert);
    }
    if (!instanceId) throw new HttpProblem(401, 'Unauthorized', 'A GPU node posts interruption notices with its Exprsn-AI CA certificate.', { extensions: { reason: 'node_certificate' } });
    const body = parseBody(noticeSchema, req.body);
    res.status(202).json(await s.cloud.autoscale.interruption(instanceId, body, { wait: false }));
  });
  return r;
}
