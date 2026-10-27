# A cloud budget exceeded (1.9.99-final, B-10704)

Use this on `ExprsnCloudBudgetForecastOver` or `ExprsnCloudBudgetHardStop` ([alerts.md](alerts.md)), a `cloud.budget`
notice, or a plan refused with `budget_exceeded`.

Walked through against the fakes in `server/test/runbooks.test.ts` ("budget exceeded"); the walk-through against the
sandbox accounts is the owner's step.

1. **Read the budget.** Cloud spend, or `GET /api/admin/cloud/accounts/:id/budget`: the amount, actual and forecast
   spend, whether the hard stop holds, the source of the figures (billing data, or estimates when the last fetch is
   older than three days) and any override.
2. **Find what costs.** Cloud spend > Anomalies (`#/cloud-spend?tab=anomalies`) and Showback name the deployments,
   services and tags; `GET /api/admin/cloud/gpu-savings` the idle GPU nodes.
3. **Cut cost; it always runs, whatever the budget:**
   - GPU pools down or to zero: Pools > the pool > Scale, or `POST /api/admin/pools/:id/scale` with `{"desired":0}`.
   - Remove what is not needed: `POST /api/admin/cloud/deployments/:id/destroy` (a recent sign-in; protected
     resources need a second admin, [cloud-database-restore.md](cloud-database-restore.md) for their snapshots).
4. **If work must go on past the stop**, an override (at most seven days) proposed by one admin and approved by
   another: `POST /api/admin/cloud/accounts/:id/budget/overrides` with `{"reason":"...","hours":24}`, then the second
   admin `POST /api/admin/cloud/accounts/:id/budget/overrides/:oid/approve` (a recent sign-in). Plans that add cost pass
   until it expires or is revoked (`.../overrides/:oid/revoke`).
5. **Or change the budget** for next month: `PUT /api/admin/cloud/accounts/:id/budget` with
   `{"amount":<n>,"hardStop":"actual"}` (`finops:manage`). One FinOps admin can do this alone today; it is audited
   (`cloud.budget.updated`) and is a known gap in [security.md](../security.md#known-gaps-tracked-in-the-plan).

The hard stop is checked at plan and at apply, not during a long apply; spend Exprsn-AI did not make still counts on
billing data.
