import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { HttpProblem } from '../../http/problem.js';
import type { OpsActor } from '../../ops/common.js';
import type { Services } from '../../services.js';
import { KubeError } from '../../zones/kube.js';
import type { ClusterObjectRow } from '../../zones/cluster.js';

const view = (r: ClusterObjectRow) => ({ zone: r.zone_id, version: r.zone_version, namespace: r.namespace, kind: r.kind, name: r.name, state: r.state, detail: r.detail, appliedAt: r.applied_at, checkedAt: r.checked_at });

/**
 * Sprint 22 (B-1405): the zones' NetworkPolicies applied through the Kubernetes API. Like every zone route these need
 * `zones:manage`; applying and checking are recorded in the audit chain (`zone.cluster.applied`, `zone.cluster.drift`).
 */
export function zoneClusterRoutes(s: Services): Router {
  const r = Router();
  r.use('/zones-cluster', noStore, requireAuth(), requirePermission(s, 'zones:manage'));

  const by = (req: Request): OpsActor => {
    const p = principalOf(req);
    return { tenantId: p.tenantId, actor: actorFrom(p, ip(req)), userId: p.userId, traceId: req.traceId };
  };
  const off = () => new HttpProblem(409, 'Not applied in-cluster', 'Zones are rendered for download only. Set ZONES_APPLY=kubernetes (with a service account allowed to change networkpolicies) to apply them through the Kubernetes API.');
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof KubeError) throw new HttpProblem(502, 'Kubernetes API', err.message);
      throw err;
    }
  };

  r.get('/zones-cluster', async (_req, res) => {
    const rows = await s.zoneCluster.status();
    res.json({ mode: s.cfg.ZONES_APPLY, driftMinutes: s.cfg.ZONES_APPLY_DRIFT_MINUTES, fieldManager: s.cfg.ZONES_APPLY_FIELD_MANAGER, objects: rows.map(view), drift: rows.filter((x) => x.state === 'drift' || x.state === 'missing').length });
  });

  /** Applies every zone's current NetworkPolicy now (also how drift is put right). */
  r.post('/zones-cluster/apply', async (req, res) => {
    parseBody(z.object({}).strict(), req.body ?? {});
    if (!s.zoneCluster.enabled) throw off();
    res.json(await run(() => s.zoneCluster.apply(by(req))));
  });

  /** Compares the live objects with what was applied. */
  r.post('/zones-cluster/check', async (req, res) => {
    parseBody(z.object({}).strict(), req.body ?? {});
    if (!s.zoneCluster.enabled) throw off();
    res.json(await run(() => s.zoneCluster.check(by(req))));
  });

  return r;
}
