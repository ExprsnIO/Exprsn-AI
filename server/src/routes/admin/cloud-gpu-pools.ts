import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { cloudAudit } from '../../cloud/audit.js';
import { enrolSchema } from '../../cloud/gpu-enrol.js';
import type { GpuPoolLink } from '../../cloud/gpu-pools.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../../http/middleware.js';
import { HttpProblem, tooManyRequests } from '../../http/problem.js';
import { Limiter } from '../../platform/ratelimit.js';
import type { Services } from '../../services.js';
import type { Principal } from '../../authz/policy.js';

/*
 * 1.9.99-final, Sprint 60 (B-10401, B-10404): GPU pools of cloud deployments (`cloud/gpu-pools.ts`,
 * `cloud/gpu-enrol.ts`). Reads need `cloud:read` and see the links of deployments the caller can see; minting an
 * enrolment token by hand (a GPU VM set up as in `deploy/baremetal/ollama-node.md`) needs `cloud:deploy` and a recent
 * sign-in, and a platform deployment also `platform:manage`. Without migration 157 every route answers 503
 * `migration_pending`.
 *
 *   GET  /admin/cloud/gpu-pools                      links with their joined nodes and the latest boot-to-healthy
 *   GET  /admin/cloud/gpu-pools/:id                  one link: instances, boot timings, the warm-up list
 *   POST /admin/cloud/gpu-pools/:id/enrolments       { node?, address? } → 201 { token, url, mirror, expiresAt } (shown once)
 *   POST /admin/cloud/gpu-pools/:id/reconcile        → 202 { job } (node groups: tokens and the DaemonSet)
 *
 * And, mounted at the root outside `/api` (no session, no CSRF: the single-use token is the credential):
 *
 *   POST /cloud/gpu/v1/enrol                         { token, csr, address, node?, bootedAt? } → 201 the node's certificate
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const mintSchema = z
  .object({
    node: z.string().trim().max(253).regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/, 'a node name').optional(),
    address: z.ipv4().optional()
  })
  .strict();

export function cloudGpuPoolRoutes(s: Services): Router {
  const r = Router();
  const read = [noStore, requireAuth(), requirePermission(s, 'cloud:read')];
  const freshDeploy = [noStore, requireAuth({ sessionOnly: true }), requirePermission(s, 'cloud:deploy'), requireRecentAuth(s)];
  const deploy = [noStore, requireAuth(), requirePermission(s, 'cloud:deploy')];
  const gp = () => s.cloud.gpuPools;

  /** A link the caller can see (its deployment visible to them), else 404. */
  const visible = async (p: Principal, id: string): Promise<GpuPoolLink> => {
    await gp().need();
    const link = await gp().get(id);
    if (!link || link.state === 'removed') throw new HttpProblem(404, 'Not found', 'GPU pool not found.');
    await s.cloud.deployments.getFor(p, link.deploymentId);
    return link;
  };

  const view = async (link: GpuPoolLink) => {
    const instances = await gp().nodes.instancesOf(link);
    const timings = await gp().nodes.timings(link.id);
    const done = timings.filter((t) => t.seconds != null).map((t) => t.seconds!);
    return {
      link,
      nodes: { enrolled: instances.length, healthy: instances.filter((i) => i.state === 'active' && i.health === 'healthy').length },
      bootToHealthy: { last: done[0] ?? null, median: done.length ? [...done].sort((a, b) => a - b)[Math.floor(done.length / 2)]! : null, samples: done.length },
      instances: instances.map((i) => ({ id: i.id, name: i.name, url: i.url, state: i.state, health: i.health, node: i.settings.node ?? null })),
      timings
    };
  };

  r.get('/cloud/gpu-pools', ...read, async (req, res) => {
    await gp().need();
    const p = principalOf(req);
    const out = [];
    for (const l of await gp().all()) {
      try {
        await s.cloud.deployments.getFor(p, l.deploymentId);
      } catch {
        continue;
      }
      const v = await view(l);
      out.push({ ...v.link, nodes: v.nodes, bootToHealthy: v.bootToHealthy });
    }
    res.json({ pools: out });
  });

  r.get('/cloud/gpu-pools/:id', ...read, async (req, res) => {
    const link = await visible(principalOf(req), parseBody(id26, req.params.id));
    res.json({ ...(await view(link)), warmup: await gp().nodes.warmup(link) });
  });

  r.post('/cloud/gpu-pools/:id/enrolments', ...freshDeploy, async (req, res) => {
    const p = principalOf(req);
    const link = await visible(p, parseBody(id26, req.params.id));
    const d = (await s.cloud.deployments.get(link.deploymentId))!;
    s.cloud.deployments.assertCanDeploy(p, d);
    if (link.state !== 'active') throw new HttpProblem(409, 'Conflict', `The GPU pool is ${link.state}${link.stateDetail ? `: ${link.stateDetail}` : ''}.`, { extensions: { reason: 'pool_not_active' } });
    const body = parseBody(mintSchema, req.body ?? {});
    const out = await gp().nodes.mint(link, { node: body.node ?? null, address: body.address ?? null, createdBy: p.userId });
    await cloudAudit(s, { tenantId: link.tenantId, action: 'cloud.gpu.enrolment.minted', actor: { principal: p, ip: ip(req), ...(req.traceId ? { traceId: req.traceId } : {}) }, deploymentId: d.id, deploymentName: d.name, label: d.label, detail: { pool: link.poolName, node: body.node ?? null, address: body.address ?? null, expiresAt: out.expiresAt } });
    res.status(201).json(out);
  });

  r.post('/cloud/gpu-pools/:id/reconcile', ...deploy, async (req, res) => {
    const p = principalOf(req);
    const link = await visible(p, parseBody(id26, req.params.id));
    const d = (await s.cloud.deployments.get(link.deploymentId))!;
    s.cloud.deployments.assertCanDeploy(p, d);
    const job = await s.jobs.enqueue({ tenantId: link.tenantId, type: 'cloud.gpu.reconcile', payload: { deploymentId: link.deploymentId }, createdBy: p.userId, maxAttempts: 2 });
    res.status(202).json({ job: { id: job.id, type: 'cloud.gpu.reconcile' } });
  });

  return r;
}

/** The node's enrolment, at the root (outside `/api`): the single-use token is the only credential. */
export function cloudGpuEnrolRoutes(s: Services): Router {
  const r = Router();
  // B-10403 review: a per-address limit on the public enrolment (30 attempts in ten minutes), on the shared counters.
  const limit = new Limiter(s.counters, 'cloud-gpu-enrol', 30, 10 * 60_000);
  r.post('/cloud/gpu/v1/enrol', noStore, express.json({ limit: '16kb' }), async (req: Request, res) => {
    const l = await limit.consume(ip(req) ?? 'unknown');
    if (!l.allowed) throw tooManyRequests('Too many enrolment attempts from this address; try again later.', l.resetMs / 1000);
    const body = parseBody(enrolSchema, req.body ?? {});
    res.status(201).json(await s.cloud.gpuPools.nodes.enrol(body, req.ip ?? null));
  });
  return r;
}
