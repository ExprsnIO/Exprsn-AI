# A stuck cloud operation (1.9.99-final, B-10704)

Use this when an apply, destroy or rollback has not finished: the alert `ExprsnCloudStepsStuck` (steps waiting on a
provider's long-running operation for hours, [alerts.md](alerts.md#exprsncloudstepsstuck)), a deployment that stays
`applying`, or a journal step that stays `pending`.

Walked through against the fakes in `server/test/runbooks.test.ts` ("stuck operation"); the walk-through against the
sandbox accounts is the owner's step.

1. **See where it waits.** Deployments > the deployment > Operations, or
   `GET /api/admin/cloud/deployments/:id/operations`: the step, its state (`pending` with the provider's operation
   handle), its attempt and the provider's request id. `GET /api/admin/cloud/deployments/:id/plans/:planId` gives the
   plan's state and `applyJobId`.
2. **Check the provider.** Find the operation by its request id (the AWS console's event, the Azure operation URL in the
   handle, the DigitalOcean action id). Throttling and an open breaker slow steps without failing them
   ([alerts.md](alerts.md#exprsncloudthrottled), [alerts.md](alerts.md#exprsncloudbreakeropen)).
3. **If the provider finished it**, the next poll settles the step: Admin > Jobs, filter `cloud.poll` or `cloud.apply`
   (`GET /api/admin/jobs`), and `POST /api/admin/jobs/:id/retry` on a failed one. Nothing is repeated: each step resumes
   from the journal with the same idempotency key.
4. **If the provider lost it, or you need the deployment back now**, cancel the apply job:
   `POST /api/admin/jobs/:id/cancel` with the plan's `applyJobId`. The steps in flight finish, the plan ends
   `cancelled`, the deployment `failed`, and the lease is released (`cloud.apply.cancelled`).
5. **Plan again.** `POST /api/admin/cloud/deployments/:id/plans` with the desired graph, review, then
   `POST /api/admin/cloud/deployments/:id/plans/:planId/apply` with the plan's `hash` (a recent sign-in). The plan
   starts from what exists; a resource the lost operation did make is found and adopted, never made twice. Or roll
   back to the last verified state: `POST /api/admin/cloud/deployments/:id/rollback`.
6. **Verify.** `POST /api/admin/cloud/deployments/:id/verify`; the deployment returns to `ready`.

A resource the provider made but no deployment recorded is an orphan: `POST /api/admin/cloud/deployments/:id/orphans/sweep`,
then adopt or delete it (`.../orphans/:orphanId/adopt`, `.../delete`).
