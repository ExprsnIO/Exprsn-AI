# A spot interruption storm (1.9.99-final, B-10704)

Use this when many spot GPU nodes are reclaimed at once: a burst of `cloud.pool.interruption` audit events, pools
falling to `draining`, chat answers resuming on other instances, `ExprsnCloudGpuIdle` or spend rising as replacements
start on demand.

Not walked through against the fakes beyond `server/test/cloud-spot.test.ts` (which drives single notices); the storm
against a sandbox account is the owner's step.

1. **See it.** Pools > the cloud pool: its instances (`draining`, `drained`), the node group card (desired, min, max,
   capacity now `spot` or `on_demand`). Audit: `GET /api/admin/audit/events?action=cloud.pool.` (`interruption`,
   `drained`, `scaled`, `capacity.fallback`).
2. **What Exprsn-AI already did.** Each node's watcher posts its notice (`POST /cloud/v1/nodes/interruptions`, the
   node's certificate); the instance drains 20 s before the reclaim, running answers resume elsewhere, and a pool with
   `onDemandFallback` asks once per reclaimed instance for a replacement on demand, under the budget's hard stop. A
   node cannot ask twice for the same instance while its notice is open.
3. **Hold capacity.** If spot capacity is gone in the region, stay on demand:
   `PUT /api/admin/pools/:id/autoscale` with `"capacity":"on_demand"` (and the rest of the policy), or move the pool's
   node group to another zone or instance type through a reviewed plan (Deployments > Plans).
4. **Watch cost.** On-demand GPU nodes cost several times spot: [cloud-budget-exceeded.md](cloud-budget-exceeded.md).
   Lower `max` if the budget cannot carry it.
5. **Go back to spot** once the region recovers: `PUT /api/admin/pools/:id/autoscale` with `"capacity":"spot"`; the
   extra on-demand nodes go with the next idle scale-down.

A notice from a node that is not the instance's own (another pool's certificate, the gateway's, a revoked one) is
refused `401` and audited.
