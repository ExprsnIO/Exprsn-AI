# Cloud credential compromise (1.9.99-final, B-10704)

Use this when a cloud credential Exprsn-AI holds may be in someone else's hands: a leaked access key, Azure client
secret, DigitalOcean or Cloudflare token, a stolen federated session, a copied tunnel token, or an Exprsn-AI instance
you no longer trust. The order is: **stop Exprsn-AI using it, cut it at the provider, replace it, check what it did**.
Routes are under `/api/admin` (`docs/api.md`); console paths are screen names; `exprsn-ai` is the CLI
([Conventions](README.md#conventions)). Every step below writes a `cloud.*` audit event.

Walked through against the fakes in `server/test/runbooks.test.ts` ("credential compromise"); the walk-through against
the sandbox accounts is the owner's step (open decision 18, [cloud-sandbox-nightly.md](cloud-sandbox-nightly.md)).

## 1. Stop Exprsn-AI using the account (minutes)

- Cloud accounts > the account > Disable, or `PATCH /api/admin/cloud/accounts/:id` with `{"state":"disabled"}`
  (`cloud:admin`, a platform account also `platform:manage`). A disabled account is refused by every placement, plan,
  sweep and model call (`403` or `409`), and every instance drops its cached sessions and tokens over the bus.
- If the whole instance is suspect, also follow [incident-response.md](incident-response.md) (revoke sessions and API
  keys) and, if keys may have left with it, [emergency-seal.md](emergency-seal.md).

## 2. Cut it at the provider

| Credential | Cut the trust or revoke the token |
| --- | --- |
| AWS federated (role assumed with a token from Exprsn-AI's issuer) | Sessions last at most `CLOUD_SESSION_SECONDS` (one hour). To end them now: IAM > Roles > the `exprsn-<account>-*` role > Revoke active sessions (adds the `AWSRevokeOlderSessions` deny), or remove the issuer from the role's trust policy. If the issuer's signing key itself may be exposed: `POST /api/admin/cloud/issuer/rotate` with `{"immediate":true}` (a recent sign-in, `platform:manage`), then `POST /api/admin/cloud/issuer/publish` and `POST /api/admin/cloud/issuer/check` until the check passes |
| AWS vaulted access key | `aws iam update-access-key --user-name <user> --access-key-id <id> --status Inactive`, then `aws iam delete-access-key ...`. Do not wait for `POST /api/admin/cloud/accounts/:id/rotate`'s overlap (`CLOUD_AWS_KEY_OVERLAP_MINUTES`): a compromised key goes at once |
| Azure federated | Entra ID > App registrations > the app > Certificates & secrets > Federated credentials: delete the credential naming `cloud-account:<id>`; existing tokens last up to their hour |
| Azure client secret or certificate | `az ad app credential delete --id <appId> --key-id <keyId>` (the key id is on the account's credential: `GET /api/admin/cloud/accounts/:id/credential`) |
| DigitalOcean token | Control panel > API > Tokens > Delete the token |
| Cloudflare API token | My Profile (or the account) > API Tokens > Roll or Delete |
| Cloudflare tunnel token | Zero Trust > Networks > Tunnels > the tunnel > Refresh token; then apply the front door again and rewrite the connector's file with `exprsn-ai cloud:tunnel-token --edge <name> --out <new file>` |

## 3. Replace it

- Vaulted: `PUT /api/admin/cloud/accounts/:id/secret` with `{"values":{...}}` (a recent sign-in; values go to the
  vault only, never back), or Cloud accounts > the account > Credential > Replace. Federated: re-create the trust from
  `GET /api/admin/cloud/accounts/:id/setup` (the generated trust policy is conditioned on `aud` and on
  `sub = cloud-account:<id>`).
- `POST /api/admin/cloud/accounts/:id/validate` must report the identity and every feature `ok`.
- Enable the account: `PATCH /api/admin/cloud/accounts/:id` with `{"state":"active"}`.

## 4. Check what it did

- AWS: CloudTrail by the access key id or the role session name; Azure: the Activity Log by the app's object id;
  Cloudflare and DigitalOcean: their audit logs. Each drift finding names the principal that changed a managed
  resource (B-10703).
- Exprsn-AI: `GET /api/admin/audit/events?action=cloud.` for the window; `POST /api/admin/cloud/deployments/:id/drift/check`
  on each deployment of the account; `POST /api/admin/cloud/deployments/:id/orphans/sweep` for resources made with the
  account's tags that no deployment knows ([cloud-drift.md](cloud-drift.md)).
- Anything not made by Exprsn-AI is outside its reach: the generated policies only change resources tagged for the
  account, so resources without the tags need the provider's own review.
