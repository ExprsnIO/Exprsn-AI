# Drift on a cloud deployment (1.9.99-final, B-10704)

Use this on `ExprsnCloudDriftOpen` ([alerts.md](alerts.md#exprsnclouddriftopen)) or a `cloud.drift` notice: a managed
resource differs from its desired spec, or is missing.

Walked through against the fakes in `server/test/runbooks.test.ts` ("drift"); the nightly sandbox job
([cloud-sandbox-nightly.md](cloud-sandbox-nightly.md)) makes and reverts drift every night once it runs.

1. **See it.** Deployments > the deployment > Drift, or `GET /api/admin/cloud/deployments/:id/drift`: the resource key,
   the field (`ingress`, `cidr`, ...) or `missing`, the observed and desired values, and who changed it (B-10703, from
   CloudTrail, the Azure Activity Log or Cloudflare's audit log). Check now with
   `POST /api/admin/cloud/deployments/:id/drift/check`.
2. **Decide whether it is an attack.** An inbound rule opened to the world, a role or a key changed, or a principal you
   do not know is a security event: [incident-response.md](incident-response.md), and if it was made with Exprsn-AI's
   own credential, [cloud-credential-compromise.md](cloud-credential-compromise.md).
3. **Decide** (`cloud:deploy`): `POST /api/admin/cloud/deployments/:id/drift/:findingId/decide` with
   - `{"decision":"revert","apply":true}`: a plan back to the desired spec, applied at once (a recent sign-in); without
     `apply` it waits to be applied by its hash;
   - `{"decision":"adopt"}`: the observed value becomes the desired one;
   - `{"decision":"ignore"}`: this field is left alone in later runs.
4. **Confirm.** `POST /api/admin/cloud/deployments/:id/drift/check` shows nothing open; `POST .../verify` passes.

Resources tagged for the account that no deployment knows are orphans, not drift:
`POST /api/admin/cloud/deployments/:id/orphans/sweep`.
