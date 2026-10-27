import { Router, type Request } from 'express';
import type { CloudActor } from '../../cloud/accounts.js';
import { supportOf } from '../../cloud/providers/registry.js';
import { cloudAudit } from '../../cloud/audit.js';
import type { NetworkRender } from '../../cloud/network.js';
import { graphProblems, renderGraph, unavailableIn, type GraphRender } from '../../cloud/render.js';
import { deploymentSpecSchema, PLACEMENT_CHECKS, validateSpec, type DeploymentSpec, type SpecValidation } from '../../cloud/spec.js';
import { isOnpremBody, onpremRefusal, onpremSpecSchema, registerOnprem, renderOnprem, validateOnprem } from '../../cloud/onprem.js';
import { forbidden, HttpProblem } from '../../http/problem.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../../http/middleware.js';
import type { Services } from '../../services.js';

/*
 * 1.9.99-final, Sprint 57 (B-10201, B-10202, B-10601): deploying Exprsn-AI from a deployment spec. Platform-only:
 * `cloud:deploy` and `platform:manage`; creating also needs a recent sign-in in a browser session.
 *
 *   POST /admin/cloud/deployments/validate-spec   the wizard's dry run: the spec's problems, the rendered graph and
 *                                                 firewalls, the unavailable types, an estimate from cached and sheet
 *                                                 prices; calls no provider and changes nothing
 *   POST /admin/cloud/deployments                 validates (refused before any provider call), creates the
 *                                                 deployment with its spec, renders its graph and returns the plan
 *                                                 (`s.cloud.plans.create`, which refreshes through the adapters and
 *                                                 carries the estimate)
 *
 * Sprint 62 (B-10209): both take an on-prem registration too (`{ kind: 'onprem', install, frontDoor, ... }`,
 * `cloud/onprem.ts`): an existing Compose, bare-metal or Helm install with no compute, on its front door's
 * Cloudflare account. Its render has no resource, its plan no step; creating one also creates its front door, so it
 * needs `cloud:admin` as well.
 *
 * The deployment's other routes (reads, plans, apply, verify) are the engine's (`routes/admin/cloud-deployments.ts`).
 */

const actorOf = (req: Request): CloudActor => ({ principal: principalOf(req), ip: ip(req), traceId: req.traceId });

/** The refusal for a spec with problems: 403 (step `zone`) when a placement check failed, else 422 `invalid_spec`. */
export function specRefusal(v: SpecValidation): HttpProblem {
  const placement = v.problems.find((p) => PLACEMENT_CHECKS.includes(p.check));
  if (placement) return forbidden(placement.message, { step: 'zone', check: placement.check, reason: 'placement_refused', problems: v.problems });
  return new HttpProblem(422, 'Unprocessable content', `The deployment spec has ${v.problems.length} problem${v.problems.length === 1 ? '' : 's'}: ${v.problems[0]!.message}`, { extensions: { reason: 'invalid_spec', problems: v.problems } });
}

const firewallView = (n: NetworkRender) => n.firewalls.map((f) => ({ zone: f.zone, key: f.key, ingress: f.ingress, egress: f.egress, egressDenied: f.egressDenied }));

export function cloudDeploymentSpecRoutes(s: Services): Router {
  const r = Router();
  const deploy = [noStore, requireAuth(), requirePermission(s, 'cloud:deploy'), requirePermission(s, 'platform:manage')];
  const fresh = [noStore, requireAuth({ sessionOnly: true }), requirePermission(s, 'cloud:deploy'), requirePermission(s, 'platform:manage'), requireRecentAuth(s)];

  const render = async (spec: DeploymentSpec): Promise<GraphRender> => {
    const zones = await s.zones.current();
    return renderGraph(spec, { zones, corporateCidrs: s.cfg.ZONES_CORPORATE_CIDRS.split(',').map((x) => x.trim()).filter(Boolean) });
  };
  const unavailable = (spec: DeploymentSpec, g: GraphRender) => {
    const caps = s.cloud.providers.capabilities()[spec.target.provider];
    return unavailableIn(g.resources, (t) => supportOf(caps, t, 'create'), (t) => caps[t].note);
  };

  r.post('/cloud/deployments/validate-spec', ...deploy, async (req, res) => {
    if (isOnpremBody(req.body)) {
      const spec = parseBody(onpremSpecSchema, req.body);
      const v = await validateOnprem(s, principalOf(req), spec);
      const g = renderOnprem(spec);
      res.json({ valid: v.valid, kind: 'onprem', problems: v.problems, unavailable: [], resources: g.resources, firewalls: [], notes: g.notes, frontDoor: g.frontDoor, appTier: null, estimate: null, origin: g.origin, attach: v.attach ? { id: v.attach.id, name: v.attach.name, state: v.attach.state } : null });
      return;
    }
    const spec = parseBody(deploymentSpecSchema, req.body);
    const v = await validateSpec(s, principalOf(req), spec);
    if (!v.resolved || v.problems.some((p) => p.check === 'zone' && p.path === 'zones')) {
      res.json({ valid: false, problems: v.problems, unavailable: [], resources: [], firewalls: [], notes: [], frontDoor: null, estimate: null });
      return;
    }
    const g = await render(spec);
    const problems = [...v.problems, ...graphProblems(g.resources).map((m) => ({ path: 'data', check: 'network' as const, message: m }))];
    const prices = s.cloud.prices;
    // The wizard's estimate: cached and sheet prices only (no price API call from a dry run).
    const estimate = prices ? await prices.estimate({ provider: spec.target.provider, region: spec.target.region, account: v.resolved.account, before: [], after: g.resources, spec, fetch: false }).catch(() => null) : null;
    res.json({ valid: problems.length === 0, problems, unavailable: unavailable(spec, g), resources: g.resources, firewalls: firewallView(g.network), notes: g.notes, frontDoor: g.frontDoor, appTier: g.appTier ?? null, estimate });
  });

  r.post('/cloud/deployments', ...fresh, async (req, res) => {
    if (isOnpremBody(req.body)) {
      const spec = parseBody(onpremSpecSchema, req.body);
      await s.cloud.deployments.need();
      const actor = actorOf(req);
      const v = await validateOnprem(s, actor.principal, spec);
      if (!v.valid || !v.account) throw onpremRefusal(v);
      const out = await registerOnprem(s, actor, spec, v);
      res.status(201).json({ kind: 'onprem', deployment: out.deployment, plan: out.plan, firewalls: [], unavailable: [], notes: out.notes, frontDoor: out.frontDoor, edge: out.edge, install: out.install });
      return;
    }
    const spec = parseBody(deploymentSpecSchema, req.body);
    // The engine's services: `cloud/deployments.ts` and `cloud/planner.ts` (503 `migration_pending` without 148).
    const { deployments, plans } = s.cloud;
    await deployments.need();
    const actor = actorOf(req);
    // Everything is checked before any provider call: account, region allow-list, ceilings, residency, zones, limits.
    const v = await validateSpec(s, actor.principal, spec);
    if (!v.valid || !v.resolved) throw specRefusal(v);
    const g = await render(spec);
    const pub = graphProblems(g.resources);
    if (pub.length) throw new HttpProblem(422, 'Unprocessable content', pub[0]!, { extensions: { reason: 'public_data', problems: pub } });
    const d = await deployments.create(actor, { name: spec.name, accountId: spec.target.accountId, region: spec.target.region, label: spec.label, ...(spec.description ? { description: spec.description } : {}), spec: spec as unknown as Record<string, unknown> });
    await cloudAudit(s, {
      tenantId: d.tenantId,
      action: 'cloud.deployment.spec',
      actor,
      deploymentId: d.id,
      deploymentName: d.name,
      label: d.label,
      detail: { shape: spec.compute.shape, size: spec.compute.size, data: spec.data.mode, frontDoor: spec.frontDoor.kind, gpuPools: spec.gpuPools.length, resources: g.resources.length, zones: g.network.firewalls.map((f) => f.zone) }
    });
    const plan = await plans.create(actor, d.id, g.resources);
    // Sprint 61 (B-10905): a Cloudflare app tier is its own deployment on the Cloudflare account (a deployment's graph
    // lives on one account), planned here too; the planner refuses it without Redis on another provider or Hyperdrive.
    let appTier: { deployment: unknown; plan: unknown } | null = null;
    if (g.appTier) {
      const cf = await deployments.create(actor, { name: `${spec.name.slice(0, 26)}-edge`, accountId: g.appTier.accountId, region: 'global', label: spec.label, description: `The Cloudflare app tier of ${spec.name}`, spec: spec as unknown as Record<string, unknown> });
      appTier = { deployment: await deployments.get(cf.id), plan: await plans.create(actor, cf.id, g.appTier.resources) };
    }
    res.status(201).json({ deployment: await deployments.get(d.id), plan, firewalls: firewallView(g.network), unavailable: unavailable(spec, g), notes: g.notes, frontDoor: g.frontDoor, ...(appTier ? { appTier } : {}) });
  });

  return r;
}
