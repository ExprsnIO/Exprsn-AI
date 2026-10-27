# Cloud: accounts, deployments and cloud services

1.9.99-final, Sprint 56 (B-10002, B-10007 to B-10009; `Backlog-1.9.99-final.md`). The cloud plane starts with
accounts: a credential plus a scope (which provider account, which regions, which data it may hold). Everything that
later deploys Exprsn-AI, joins GPU pools, provisions databases or calls cloud model APIs (B-101 to B-109) asks the
account first. Code: `server/src/cloud/accounts.ts` (`s.cloud.accounts`), `validate.ts` (`s.cloud.validation`),
`catalogue.ts`, `tags.ts`, `types.ts`; routes `server/src/routes/admin/cloud.ts`; console `web/js/screens/cloud.js`
(`#/cloud`). The routes are listed in [api.md](api.md). Federation, vaulted credentials and their rotation are
described [below](#federation-and-credentials-b-10003-to-b-10006); the routes are in [api.md](api.md) and the threat
model in [security.md](security.md).

Migration `146_cloud_accounts`: until it is applied every cloud route answers `503`
`migration_pending`, the screen says "not installed", and `assertRegionAllows` refuses every placement, so nothing is
placed in a cloud.

## Contents

- [Accounts](#accounts)
- [Dual control](#dual-control)
- [Validation and the permission checklist](#validation-and-the-permission-checklist)
- [Regions, zones and label ceilings](#regions-zones-and-label-ceilings)
- [Residency (open decision 4)](#residency-open-decision-4)
- [Tags](#tags)
- [Audit](#audit)
- [Federation and credentials (B-10003 to B-10006)](#federation-and-credentials-b-10003-to-b-10006)
- [Provider adapters (B-10101)](#provider-adapters-b-10101)
- [Deployments, plans and the journal (B-10102 to B-10105, B-10701)](#deployments-plans-and-the-journal-b-10102-to-b-10105-b-10701)
- [Deployment specs, network and prices (B-10201, B-10202, B-10601)](#deployment-specs-network-and-prices-b-10201-b-10202-b-10601)
- [Drift, destroy and limits (B-10106 to B-10108)](#drift-destroy-and-limits-b-10106-to-b-10108)
- [DNS, TLS and budgets (B-10206, B-10602)](#dns-tls-and-budgets-b-10206-b-10602)
- [Billing ingestion (B-10603)](#billing-ingestion-b-10603)
- [VM and container targets (B-10204, B-10205)](#vm-and-container-targets-b-10204-b-10205)
- [Kubernetes target and upgrades (B-10203, B-10207)](#kubernetes-target-and-upgrades-b-10203-b-10207)
- [Managed databases (B-10301, B-10303, B-10307)](#managed-databases-b-10301-b-10303-b-10307)
- [Own database and caches (B-10302, B-10305)](#own-database-and-caches-b-10302-b-10305)
- [Data connections from the cloud (B-10304, B-10306)](#data-connections-from-the-cloud-b-10304-b-10306)
- [Metrics and security (B-10702, B-10705)](#metrics-and-security-b-10702-b-10705)
- [Cloud model backends (B-105)](#cloud-model-backends-b-105)
- [Model pricing, provider guardrails and residency (B-10505 to B-10508)](#model-pricing-provider-guardrails-and-residency-b-10505-to-b-10508)
- [GPU pools (B-10401, B-10404, B-10405)](#gpu-pools-b-10401-b-10404-b-10405)
- [Autoscale, spot and savings (B-10402, B-10403, B-10406, B-10605)](#autoscale-spot-and-savings-b-10402-b-10403-b-10406-b-10605)
- [Cloudflare front door (B-10901 to B-10904)](#cloudflare-front-door-b-10901-to-b-10904)
- [On-prem front doors (B-10209)](#on-prem-front-doors-b-10209)
- [Cloudflare billing and showback (B-10608, B-10604)](#cloudflare-billing-and-showback-b-10608-b-10604)
- [Anomalies and the Cloud spend screen (B-10606, B-10607)](#anomalies-and-the-cloud-spend-screen-b-10606-b-10607)
- [Cloudflare app tier, R2, D1 and AI Gateway (B-10905 to B-10908)](#cloudflare-app-tier-r2-d1-and-ai-gateway-b-10905-to-b-10908)
- [Known gaps (2.0.0)](#known-gaps-200)

## Accounts

| Field | Meaning |
| --- | --- |
| `provider` | `aws`, `azure`, `digitalocean` or `cloudflare` |
| `scope` | `platform` (owned by system admins: deploying Exprsn-AI, platform pools, the own database) or `tenant` (one tenant's own account: its data connections and model backends only, open decision 6) |
| `providerIds` | AWS account id; Azure tenant and subscription; DigitalOcean team; Cloudflare account and zones |
| `credentialMode` | `federated` (AWS, Azure: short-lived sessions bought with a token from Exprsn-AI's issuer) or `vaulted` (all four: `vault:` references) |
| `defaultRegion`, `regions` | The allow-list, each region with its zone, label ceiling and residency geography |
| `state` | `pending` (waiting for a second cloud admin; unusable), `active`, `attention` (the last validation found something missing), `disabled` |

The name is lower case, unique within its scope and never changes: it is the `exprsn:account` tag.

Who may do what:

- `cloud:read` sees the accounts of one's tenant; the platform tenant's readers also see platform accounts; holders of
  `platform:manage` see every account.
- `cloud:admin` adds, changes, validates and proposes removing the accounts of one's tenant, and decides their
  proposals. A platform account also needs `platform:manage`, so a tenant admin can never add or change one.
- Roles: **Cloud admin** (`cloud:read`, `cloud:deploy`, `cloud:admin`, `finops:read`, `finops:manage`; MFA required),
  **Cloud operator** (`cloud:read`, `cloud:deploy`; no second factor required), **FinOps analyst** (`cloud:read`, `finops:read`,
  `usage:read`). Tenant admins may grant them in their tenant.

Credentials are references only. A vaulted credential names `vault:<path>#<key>` references (AWS `accessKeyId` and
`secretAccessKey`, Azure `clientSecret` or `certificate`, DigitalOcean and Cloudflare `token`); a federated one holds
the role ARN or the client id. Any other value is refused (`400 not_a_reference`). Readers without `cloud:admin` see the
field names only.

## Dual control

These are proposals that another cloud admin approves (with a recent sign-in). The proposer can withdraw, never
approve.

| Change | Proposal kind | Note |
| --- | --- | --- |
| Adding an account | `account.add` | The account exists as `pending` and is refused everywhere until approved; rejected or withdrawn, it is removed |
| Removing an account | `account.remove` | Nothing in the cloud is deleted; Exprsn-AI stops managing it |
| Changing the credential mode | `account.credential` | A new reference in the same mode applies at once and clears the last validation |
| Raising a region's ceiling | `region.ceiling` | Lowering a ceiling, removing a region and adding one at the start ceiling apply at once |
| Widening a tenant's residency | `residency` | Narrowing applies at once |

Approving a platform account's change, and any `restricted` ceiling, also needs `platform:manage`.

## Validation and the permission checklist

`POST /api/admin/cloud/accounts/:id/validate` buys a credential (`s.cloud.credentials.for(account, 'validate')`), asks
the provider adapter who it is (STS `GetCallerIdentity`, the ARM subscription, DigitalOcean `/v2/account`, Cloudflare
`/user/tokens/verify`) and checks what each feature needs. Features: deploy, data, compute, models and billing on AWS,
Azure and DigitalOcean; front door, app tier, data, models and billing on Cloudflare. The report names every missing
permission against the feature it blocks; `assertFeature` refuses that feature with the same names (so a Cloudflare
token without Containers Edit serves the front door but not the app tier). A credential that belongs to another
provider account fails the identity step. A provider error answers `502` with the provider's request id, throttling
`429` with its retry time; neither replaces the last report.

DigitalOcean and Cloudflare offer no federation: the catalogue (`GET /api/admin/cloud/catalogue`) says so with the
reason and lists the token's permission checklist per feature, which the connect wizard shows before the token exists.

## Regions, zones and label ceilings

Regions offered first (open decision 1), each starting at the ceiling `internal`:

| Provider | Regions (zone) |
| --- | --- |
| AWS | `eu-central-1`, `eu-west-1` (`cloud-eu`); `us-east-1`, `us-west-2` (`cloud-us`) |
| Azure | `swedencentral`, `westeurope` (`cloud-eu`); `eastus2` (`cloud-us`) |
| DigitalOcean | `ams3`, `fra1` (`cloud-eu`); `nyc3`, `sfo3` (`cloud-us`); `tor1` (`cloud-ca`) |
| Cloudflare | `global` (`edge`); `r2-eu` (`edge-eu`); `r2-fedramp` (`edge-us`) |

A region's effective ceiling is the lower of its own and its zone's, when `zones/` defines a zone of that name.

`s.cloud.accounts.assertRegionAllows(account, region, label, { tenantId?, use? })` is the one check every placement of
data, a pool, a model entry or a deployment calls. It refuses (403, step `zone`, with `check`, `region`, `zone` and
`ceiling`): an account that is pending or disabled; a tenant account used for anything but data and models; a region
off the allow-list; a label above the ceiling; a label outside its residency. `placementFor` gives the region as
`authz/policy.ts` takes it (`Resource.region`), so `authorize` and `explain` name the region's ceiling in the zone step.

## Residency (open decision 4)

- `public` and `internal`: any region on the account's allow-list.
- `confidential`: only regions whose geography (`eu`, `us`, `ca`) is in the owning tenant's residency
  (`PUT /api/admin/cloud/residency`). With none set, confidential data goes to no cloud region.
- `restricted`: never, unless a platform admin approves a `restricted` ceiling for the region (the override); the
  residency rule then applies too. Cloudflare's global edge has no residency geography.

## Tags

Every resource Exprsn-AI creates carries `exprsn:managed=true`, `exprsn:account=<name>`, `exprsn:deployment`, and
where they apply `exprsn:tenant`, `exprsn:workspace` and `exprsn:pool` (`cloud/tags.ts`: `cloudTags`,
`providerTags`, `isManagedBy`, `namePrefix`). AWS and Azure take them as key/value pairs; DigitalOcean as strings
(`exprsn:account:<name>`); Cloudflare has no general tags, so its resources are named with `exprsn-<account>-` and
their tags kept in the journal. The generated cloud policies are conditioned on these tags.

## Audit

`cloud.account.proposed`, `cloud.account.created`, `cloud.account.updated`, `cloud.account.removed`,
`cloud.account.validated`, `cloud.credential.changed`, `cloud.region.ceiling.raised`, `cloud.residency.updated`,
`cloud.proposal.created`, `.approved`, `.rejected`, `.withdrawn`; none carries a secret value.

## Federation and credentials (B-10003 to B-10006)

`s.cloud.credentials.for(account, purpose)` (`cloud/credentials.ts`) is the one way an adapter gets a credential.
`purpose` is `validate`, `read`, `deploy` or `billing`; a pending account is used to validate only, a disabled one
not at all. What it answers, by provider and mode:

| Account | `ProviderCredential` | How |
| --- | --- | --- |
| AWS, federated | `{kind: 'aws', accessKeyId, secretAccessKey, sessionToken, expiresAt}` | A token from the cloud issuer → STS `AssumeRoleWithWebIdentity` for the purpose's role (`readRoleArn`, `deployRoleArn`, `billingRoleArn`, else `roleArn`; validate uses read's). `CLOUD_SESSION_SECONDS` (one hour), cached per instance and role, refreshed at two thirds |
| AWS, vaulted | `{kind: 'aws', accessKeyId, secretAccessKey, expiresAt: null}` | The key pair behind the references, rotated automatically |
| Azure | `{kind: 'azure', tenantId, getToken(scope)}` | Entra client credentials with a client assertion (federated: a token from the issuer for `api://AzureADTokenExchange`; certificate: a JWT signed by the certificate's key in custody) or a vaulted client secret. Tokens per scope, refreshed at two thirds. Scopes per purpose: validate ARM; read ARM and Cognitive Services; deploy ARM, Cognitive Services and Storage; billing ARM (Cost Management is under the ARM scope) |
| DigitalOcean, Cloudflare | `{kind: 'token', token, accountId}` | The vaulted token; `accountId` is the team or Cloudflare account id |

### The federation issuer

A separate issuer from the console's OIDC provider: its own URL (`CLOUD_ISSUER_URL`, default `PUBLIC_URL/cloud-issuer`)
and keys (`cloud_issuer_keys`, in the signer or OpenBao transit). Tokens: `sub` `cloud-account:<id>`, the cloud's
`aud`, five minutes, used once at the exchange. ES256; `CLOUD_AZURE_SIGNING_ALG=RS256` adds an RSA key used only for
the Azure audience (open decision 3: Entra's acceptance of ES256 for federated credentials is to be confirmed
against a sandbox tenant; ES256 stays the default).

Publication (open decision 2): the discovery document and the JWKS are written to a public bucket (`s3`,
`azure-blob` static website, `spaces`, `r2`; `cloud/issuer-publishers.ts`) with the vaulted key pair or an account's
credential, or served by the console itself on `/cloud-issuer/.well-known/openid-configuration` and
`/cloud-issuer/jwks.json` (`console`). Rotation publishes the new key first; it signs only once the last successful
publication listed it and `CLOUD_ISSUER_PUBLISH_LEAD_MINUTES` have passed, so no exchange fails; the retired key stays
published until every session bought with it has ended. `cloud.issuer.check` (every `CLOUD_ISSUER_CHECK_MINUTES`)
republishes when what should be published changed, reads the published copy back and alerts on a mismatch.
Bootstrapping an S3 target in a federated AWS account: publish the first documents by hand (the setup helper lists
them) or give the target a vaulted key pair.

### The setup helper

`GET /api/admin/cloud/accounts/:id/setup` renders, without calling the cloud: for AWS the IAM OIDC provider (client
id `sts.amazonaws.com`), the trust policy with conditions on `aud` and `sub`, the read, deploy and billing policies
(deploy may create only resources tagged `exprsn:managed=true` and `exprsn:account=<name>` and change only resources
carrying them, and may not remove `exprsn:*` tags) and the `aws iam` lines; for Azure the federated identity
credential (app registration or user-assigned managed identity) and the `az role assignment` lines (Reader and Cost
Management Reader on the subscription, Contributor on each managed resource group).


### Setting up each provider (B-10802)

| Provider | Credential modes | Steps |
| --- | --- | --- |
| AWS | federated (recommended) or a vaulted IAM user key pair | Add the account (`POST /api/admin/cloud/accounts`, mode `federated`, the role ARNs); open its setup helper; create the IAM OIDC provider for `CLOUD_ISSUER_URL` (client id `sts.amazonaws.com`), the read, deploy and billing roles with the rendered trust policy and policies (the `aws iam` lines); publish the issuer (above); validate. A second cloud admin approves the account |
| Azure | federated (an app registration's or a user-assigned managed identity's federated credential), a client certificate from the tenant's CA, or a vaulted client secret | Add the account (tenant, subscription, client id, the managed resource groups); create the federated identity credential the helper renders (issuer `CLOUD_ISSUER_URL`, subject `cloud-account:<id>`, audience `api://AzureADTokenExchange`); run its `az role assignment` lines (Reader and Cost Management Reader on the subscription, Contributor and the rendered custom role on each managed resource group); validate |
| DigitalOcean | a vaulted personal access token with custom scopes (no federation) | Create a token with the scopes of the features you use (table below) and its expiry; stage it (`POST /api/admin/cloud/secrets`), add the account with the reference and the expiry; validate. Rotation is by a person after the notice |
| Cloudflare | a vaulted account-owned API token (no federation) | Create an account API token with the permissions of the features you use (table below), on the zones the front door uses; stage it, add the account with the Cloudflare account id; validate. "API Tokens Read" lets validation read the token's policies instead of probing |

What each feature needs (from `server/src/cloud/providers/capabilities.ts`; validation checks exactly these and names
what is missing, and the setup helper renders AWS and Azure as policies):

| Feature | AWS | Azure | DigitalOcean scopes | Cloudflare permissions |
| --- | --- | --- | --- | --- |
| `deploy` | EC2 networking and launch templates, EKS, ECS, ELBv2, Route 53, S3, IAM `PassRole` on the account's roles, `cloudtrail:LookupEvents`; conditioned on the `exprsn:*` tags | resource groups, networking, AKS, Container Apps, DNS, storage, `Microsoft.Insights/eventtypes/values/read` | `vpc`, `firewall`, `domain`, `kubernetes`, `load_balancer:create`, `tag:create`, `app` | — |
| `data` | RDS and Aurora (create, modify, snapshot, restore, delete), ElastiCache | PostgreSQL and MySQL Flexible Server, Azure Cache for Redis and Managed Redis, resource locks | `database` | `Workers R2 Storage Write`, `D1 Write` |
| `compute` | `ec2:RunInstances` and friends, EKS node groups, `servicequotas:GetServiceQuota` | virtual machines, AKS agent pools, `Microsoft.Compute/locations/usages/read` | `droplet`, `kubernetes:update`, `actions:read` | — |
| `models` | Bedrock list, invoke (streaming too), `ApplyGuardrail`, `GetGuardrail` | Cognitive Services accounts and deployments | `genai:read`, `genai:create` | `Workers AI Read`, `AI Gateway Write` |
| `billing` | `ce:GetCostAndUsage`, `pricing:GetProducts` | Cost Management query, usage details | `billing:read` | `Billing Read` (and Account Analytics Read for usage) |
| `frontdoor` | — | — | — | `Zone Read`, `DNS Write`, `Cloudflare Tunnel Write`, `SSL and Certificates Write`, `Zone WAF Write`, `Account Settings Read`; Access applications need the Access permissions (below) |
| `apptier` | — | — | — | `Workers Scripts Write`, `Containers Edit`, `Hyperdrive Write` |

The exact AWS actions and Azure operations are long lists; read them from the setup helper or the account's
validation report rather than from this table.

### Vaulted credentials and rotation

Values are written to the vault's platform scope under `cloud/` (`POST /api/admin/cloud/secrets` stages them under
`cloud/secrets/<scope>/<id>`; rotations and guided replaces write new versions in place), sealed, label
`restricted`, read only by the service `cloud.credentials`; the account's credential holds the references. A
`vault:cloud/` reference resolves only for the account it belongs to; any other reference resolves as the person who
saved the credential. Rotation: AWS keys automatically every `CLOUD_AWS_KEY_ROTATION_DAYS` (create for the key's IAM
user, verify with `GetCallerIdentity`, switch on every instance at once, delete the old key after
`CLOUD_AWS_KEY_OVERLAP_MINUTES`); Azure client secrets through Graph `addPassword` and `removePassword` before they
end (notices when Graph refuses); DigitalOcean and Cloudflare tokens by a person after a notice
`CLOUD_CREDENTIAL_NOTICE_DAYS` before the expiry given with them, then `PUT /api/admin/cloud/accounts/:id/secret`. An
Azure client certificate comes from the tenant's CA with its key in custody
(`POST /api/admin/cloud/accounts/:id/azure-certificate`). Last use, rotation state and expiry are in
`cloud_credential_state` (migration `147_cloud_federation`) and on `GET /api/admin/cloud/accounts/:id/credential`.
Audit: `cloud.issuer.published`, `.publish-failed`, `.rotated`, `.mismatch`, `.target-set`; `cloud.credential.stored`,
`.replaced`, `.rotated`, `.rotation-failed`, `.previous-deleted`, `.expiry-due`, `.expired`, `.certificate-issued`.

## Provider adapters (B-10101)

Code: `server/src/cloud/providers/` (`types.ts` the interface, `capabilities.ts` the tables, `transport.ts` the egress
and rate-limit path, `sdk-bridges.ts` the SDKs' way into it, `aws.ts`, `azure.ts`, `digitalocean.ts`,
`cloudflare.ts`, `registry.ts`). `s.cloud.providers` is the registry and `s.cloud.providerFor(kind)` its lookup;
nothing outside these files calls a provider. The registry loads an adapter (and its SDK) on the first call, so a
server with no cloud account never loads the AWS or Azure SDKs and calls nothing.

### The interface

Every adapter implements `CloudProvider`:

| Method | What it does |
| --- | --- |
| `supports(type, op?)` | `built`, `not_yet` (the provider has it, this release does not drive it: listed under [Known gaps](#known-gaps-200)) or `unsupported` (the provider has no such thing), from the capability table, without calling anything |
| `identity(cred, account)` | STS `GetCallerIdentity`, the ARM subscription, DigitalOcean `/v2/account`, Cloudflare `/user/tokens/verify` (then the account-owned form) |
| `checkPermissions(cred, account, features)` | What is missing per feature: IAM `SimulatePrincipalPolicy` (with the `exprsn:*` tag context), the ARM permissions list (subscription, then the managed resource group), DigitalOcean scope probes, Cloudflare token policies (or probes without "API Tokens Read") |
| `find(ctx, spec)` | The idempotency hook: what an earlier attempt of this spec already made |
| `describe`, `list` | The observed state (`list` takes `managedOnly`, a zone or a network) |
| `create`, `update`, `delete` | Done, or an `OperationHandle` to poll; a create adopts what `find` returns (never a second copy); deleting what is gone is done |
| `poll(ctx, handle)` | `pending` with a wait, `succeeded` with the resource, or `failed` with the provider's code |

A `ResourceSpec` carries the type, the logical name, the journal step's idempotency key, the `exprsn:*` tags
(`cloudTags` in `tags.ts`), the region, the parent network and the type's props. An `OperationHandle` is plain JSON
(provider, type, op, kind, resource reference, the operation's URL or id), so the Sprint 57 journal (B-10102) keeps it
and any instance resumes polling it. Calls for an unbuilt type throw `CloudUnsupported` (code `unsupported`, with
`support`); provider failures throw `CloudProviderError` with the status, the provider's code and request id, and
`retryAfterSeconds` when the retries ran out on throttling. Adapters refuse to run without an account
(`no_account`) or for another provider's account.

### What is built (capability table)

| Type | AWS | Azure | DigitalOcean | Cloudflare |
| --- | --- | --- | --- | --- |
| network | built: VPC | built: virtual network | built: VPC | unsupported |
| subnet | built | built | unsupported | unsupported |
| firewall | built: security group | built: NSG | built: cloud firewall | not a graph resource: the front door's WAF and rate limits (B-10903) |
| bucket | built: S3 | built: storage account | not yet (Spaces keys) | built: R2 |
| dns_record | built: Route 53 | built: Azure DNS | built: domain records | built |
| vm | built: EC2 instance (B-10204) | built: virtual machine | built: droplet | unsupported |
| tunnel | unsupported | unsupported | unsupported | built |
| kubernetes_cluster, node_group | built: EKS cluster, managed node group (B-10203) | built: AKS cluster, agent pool | built: DOKS cluster, node pool | unsupported |
| container_service | built: ECS on Fargate (B-10205) | built: Container Apps | built: App Platform | built: Containers application (B-10905) |
| database | built: RDS instance or Aurora cluster, PostgreSQL and MySQL (B-10301, B-10303) | built: Database for PostgreSQL / MySQL Flexible Server | built: Managed PostgreSQL and MySQL | unsupported (D1 is never Exprsn-AI's own database; it is a read-only data connection, B-10907) |
| cache | built: ElastiCache replication group (Valkey or Redis OSS; MemoryDB described only, B-10305) | built: Azure Cache for Redis, Azure Managed Redis | built: Managed Valkey | unsupported |
| load_balancer | built: the cluster's ALB (`managedBy: cluster`, B-10203) and the ECS service's own ALB (B-10205); no standalone one | built: the cluster's (application routing) | built: the cluster's (from the Service) | not yet |
| secret | not yet as a resource (Secrets Manager; ECS creates its own with the service, B-10205) | not yet (Key Vault) | unsupported | not yet as a resource (a Worker's secrets are set with the Worker, B-10905) |
| worker, hyperdrive | unsupported | unsupported | unsupported | built (B-10905) |

Every built type has all six operations. Idempotency: AWS VPCs, subnets and security groups take no client token, so
they carry `exprsn:name` and `exprsn:account` from create time (tag specifications) and are looked up by them; S3
buckets by name (`BucketAlreadyOwnedByYou` is adopted); Route 53 record sets by name and type. Azure: every create is
a PUT by name in the managed resource group `exprsn-<account>` (made on first use, tagged). DigitalOcean: lookup by
name (`exprsn-<account>-<name>`), droplets by their `exprsn:name:<name>` tag, records by name, type and value.
Cloudflare: records by name, type and content; R2 buckets and tunnels by name. Tags: native on AWS, Azure and
droplets; Azure DNS keeps them as record set metadata; DigitalOcean VPCs in their description; Cloudflare records in
their comment (`exprsn:managed=true exprsn:account=<a> ...`, at most 100 characters); Route 53 records, DigitalOcean
firewalls and records, R2 buckets and tunnels take none, so the name prefix and the journal carry them.
Long-running operations: EC2 described until `available`, Route 53 `GetChange` until `INSYNC`, Azure
`Azure-AsyncOperation` and `Location` (read only on the ARM endpoint's own origin), DigitalOcean actions and firewall
status. The tables are also `capabilityRows()` for the console.

### Egress and rate limits

Every call goes through `CloudTransport.send`, including every request the SDKs make: the AWS SDK v3 clients get
`smithyHandler` as their `requestHandler` (with the SDK's retries off, `maxAttempts: 1`, configured endpoint URLs
from the environment ignored, and an explicit credential and region, so the default credential chain and the instance
metadata service are never reached); the Azure clients get `azureHttpClient` as their `httpClient` (pipeline retries
off; the token scope is always `https://management.azure.com/.default`). The transport:

1. counts the call in its API class's bucket and in the account's total for the provider, on the shared counter store
   (`platform/ratelimit.ts`, Redis when `REDIS_URL` is set): totals by default 1200 a minute for AWS, 1000 for Azure,
   240 for DigitalOcean (under its 250, plus 4800 an hour under its 5000) and 200 for Cloudflare; a call over a bucket
   waits, and is refused locally (`429` `rate_limited`) when the wait would pass two minutes. Since Sprint 57
   (B-10108) the buckets are per API class, refill in slices, and a circuit breaker stands in front; see "Drift,
   destroy and limits" below.
2. checks the address with `cloudAddressProblem` in `platform/egress.ts` inside `guardedRequest` (resolved once,
   pinned, no redirects, capped): metadata addresses (169.254.169.254, fd00:ec2::254 and the rest) and unspecified,
   multicast and broadcast addresses always refused; the host must be one of the provider's API hosts
   (`CLOUD_PROVIDER_HOSTS`) or named in `SERVICE_ALLOWED_HOSTS`; a private, loopback or link-local address only when
   `SERVICE_ALLOWED_HOSTS` names the host or its network; plain `http:` only to a named host.
3. retries throttling: AWS's throttling codes, `429` everywhere, `503` with `Retry-After`; it waits what the provider
   asks (`Retry-After` in seconds or as a date, `x-ms-retry-after-ms`, DigitalOcean `ratelimit-reset`), else
   exponential backoff with full jitter, up to four attempts and a minute's wait; transport errors and `5xx` are
   retried only for calls that change nothing (every API class but `mutate`, so AWS's POSTed Describe calls too).

### Tests and fakes (B-10109)

`server/test/cloud-providers.test.ts` drives every adapter against its fake, all on 127.0.0.1 in the test process, so
the suite needs no network: `fake-aws.ts` (STS with `AssumeRoleWithWebIdentity`, IAM simulation and access keys, EC2
VPCs, subnets and security groups, S3, Route 53; stubs for EKS, RDS, ElastiCache, Pricing, Cost Explorer and Bedrock, since filled in: RDS and Aurora in
`fake-aws-rds.ts`, Sprint 59),
`fake-azure.ts` (the Entra token endpoint with client assertions and secrets, ARM with asynchronous operations and the
permissions list, Graph `addPassword` and `removePassword`), `fake-do.ts` (v2 with actions, custom scopes and
`ratelimit-*` headers) and `fake-cloudflare.ts` (v4: token verify and policies, zones, DNS, R2, tunnels; Workers,
Containers, Hyperdrive and AI Gateway basic). Each records its requests (`calls(op)`) and can throttle (`throttle`) or
fail (`fail`) the next calls. The Azure clients insist on https for a bearer token, so the test maps the ARM origin to
the fake with the transport's test-only `testOrigins`; the egress guard still checks the address dialled.

## Deployments, plans and the journal (B-10102 to B-10105, B-10701)

1.9.99-final, Sprint 57. Code: `server/src/cloud/graph.ts` (the types and the pure graph functions),
`deployments.ts` (`s.cloud.deployments`), `journal.ts` (`s.cloud.journal`), `planner.ts` (`s.cloud.plans`),
`apply.ts` (`s.cloud.engine`: the `cloud.apply` and `cloud.poll` jobs), `verify.ts` (`cloud.verify`), `audit.ts`
(`cloudAudit`); routes `server/src/routes/admin/cloud-deployments.ts` ([api.md](api.md)). Migration
`148_cloud_journal`: `cloud_deployments`, `cloud_resources`, `cloud_plans`, `cloud_operations`.
Until it is applied every deployment route answers `503` `migration_pending`, and nothing is planned or applied.

### The graph

A deployment lives on one account (its scope is the account's: a platform deployment is seen like a platform account
and changed only with `platform:manage` as well as `cloud:deploy`), in a default region, holding data up to a label.
Its desired graph is a list of `DesiredResource` (`{key, type, spec, dependsOn, protect, region, name?, network?,
tags?}`): `spec` is the type's props (`PropsByType` in `providers/types.ts`), `network` the key of the network it lives
in (its provider id becomes the adapter's `parent.networkId`, and it is a dependency). The deployment spec work's
`renderGraph(spec)` produces it. The provider's logical name is `name`, else `<deployment>-<key>`, so two deployments
on one account never share one.

`cloud_resources` keeps per key the desired resource, the observed state (`ObservedResource`, as the adapter reports
it) with its hash, the provider id and locator, dependencies, protection, the `exprsn:*` tags, the state (`planned`,
`creating`, `ready`, `updating`, `deleting`, `deleted`, `failed`, `missing`), the journal step and audit entry that
created it, and the desired and observed state at the last passing verify (`lastVerified`, what a rollback returns
to). `refresh` reads every resource through the adapter (`describe` by provider id, `find` for desired resources
without one) and stores what changed; any change moves the deployment's `observedVersion` on.

### Plans

`s.cloud.plans.create(actor, deploymentId, desired)` checks every region with `assertRegionAllows` (use `deploy`, the
deployment's label) and the account's `deploy` feature (`frontdoor` on Cloudflare) before any provider call, refreshes,
and diffs per resource:

| Action | When |
| --- | --- |
| `create` | Not in the graph, or its provider id is gone (deleted out of band: the reason says so); `adopts` when `find` already sees what a lost attempt made |
| `update` | A field differs and the adapter updates the type in place |
| `replace` | A field the provider cannot change in place (`REPLACE_FIELDS`: a network's `cidr`, a subnet's `cidr` and `zone`, a bucket's name, a DNS record's zone, name and type, a VM's image; always region, name and network), its network is replaced, it failed at the provider, or the adapter cannot update the type; the reason names which |
| `delete` | In the graph, not in the desired graph |
| `noop` | Nothing differs |

Changes are field level (`{path, before, after, forcesReplace}`), compared against what the provider reports: a key
the provider does not report is not compared, arrays compare as multisets, scalars by their string form. A type or
operation the adapter does not drive is a step with `unavailable` (`not_yet` or `unsupported`, with the reason), never
an error; a delete or replace of a protected resource is `blocked`. Either makes the plan inapplicable (`blockers`).
The estimate is `s.cloud.estimatePlan(plan)` (the price catalogue, B-10601) or `null`.

A plan is stored with a sha256 hash over everything it says and expires after 60 minutes, or as soon as the observed
state changes (its `observedVersion` is no longer the deployment's). `apply(actor, id, hash)` accepts only that hash
while the plan is open, refuses while another apply holds the deployment's lease, then reads the provider once more:
when the digest of what it sees differs from the plan's, the plan becomes `stale` and the answer is `409 plan_stale`
with a fresh plan (`freshPlan`) to review and apply. Helpers for the lifecycle work: `revert` (back to the stored
desired graph), `destroyAll` (every resource deleted, dependents first), `rollbackToVerified` (to `lastVerified`), and
`apply(..., { approvedProtected })` for protected resources a second admin approved.

### The journal and the apply worker

`cloud_operations` is append-only: every state of every step is a new row (`started` before the provider call,
`pending` with the long-running operation's handle, then `succeeded`, `adopted` or `failed`), with the step, the
idempotency key (stable across attempts and instances; sent as the client token where the provider takes one), the
provider's request id, the attempt and the error. Ids are monotonic ULIDs, so the journal's order is its id order.

`cloud.apply` takes the deployment's lease (the job id holds it, renewed every third of `leaseMs`): one apply per
deployment at a time, and the same job resumed on another instance after a crash takes it over. It runs deletions
(deletes and the delete half of replaces) dependents first, then creates, updates and the create half of replaces
dependencies first, each step starting when what it waits for is done, at most `parallelism` (4) at once; a failure
starts nothing new and lets the steps in flight finish. Resuming reads the journal: a done step is skipped, a pending
one is polled from its stored handle (never created again), a started or failed one runs again with the same
idempotency key and the adapter's `find` adopts what the lost attempt made. Long-running operations are polled with
the provider's wait (at most 30 seconds between polls, an hour in all), progress through `ctx.progress`. Retryable
failures (throttling with the provider's retry time, `429`, `5xx`, transport errors) are retried up to four attempts,
each journalled. Cancel stops after the steps in flight; operations still pending are left to `cloud.poll`, which
settles them from their handles when no apply holds the lease. Every provider call passes
`s.cloud.engine.hooks.beforeCall` and `afterCall`, where the per-account limiter and the breaker are wired (B-10108).
A successful apply queues `cloud.verify`.

### Verify

Readiness per resource (reported, `ready`, and as desired) and per deployment, through `ReadinessCheck`s
(`s.cloud.engine.verifier.register`): `app.readyz` reads the app's `/readyz` at `endpoints.publicUrl` through the
egress guard and, from its body, `app.database` and `app.redis` (reachable from the app); `tls.chain` checks the
public URL's certificate chain, validity and name. A check that cannot run, or a deployment with `endpoints.app` but no
public URL yet, is `unknown`, which is not a pass: a deployment whose app cannot reach its database is never shown
healthy. A failed verify marks the deployment `degraded` and offers rollback; a passing one marks it `ready` and
records `lastVerified`. Since Sprint 58 verify also checks a VM's install (`vm.install`, B-10204); GPU pool health
is not a verify check in this release (pools report on the Pools screen; [Known gaps](#known-gaps-200)).

### Audit

`cloudAudit(s, {...})` writes every `cloud.*` event with the deployment, the resource key and provider id, the plan,
the journal step (`detail.operation`) and the provider's request id (`detail.providerRequestId`); the lifecycle work
and the budgets write their drift decisions, destroys, rollbacks, orphans and budget overrides through it. Every
resource is traced to the audit entry and the journal step that created it (`createdByAudit`, `createdByOperation`;
the journal row carries the audit id back). Events: `cloud.deployment.created`, `.updated`, `.ready`, `.degraded`;
`cloud.plan.created`, `.refused`; `cloud.apply.started`, `.succeeded` (with the journal's summary), `.failed`,
`.cancelled`; `cloud.resource.created`, `.adopted`, `.updated`, `.replaced`, `.deleted`, `.failed`;
`cloud.verify.passed`, `.failed`.

Test: `server/test/cloud-journal-plan-apply.test.ts`, against the DigitalOcean fake (droplet actions and firewall
status are the long-running operations): plan actions and field changes, replace reasons, hash and expiry, the
out-of-band refusal, bounded parallelism, the lease, two crashes mid-apply resumed with no second copy, cancel and
`cloud.poll`, verify, audit traceability and the missing migration.

## Deployment specs, network and prices (B-10201, B-10202, B-10601)

Code: `server/src/cloud/spec.ts` (the spec schema, presets and `validateSpec`), `network.ts` (`renderNetwork`, the
network foundation from the zone specs), `render.ts` (`renderGraph(spec, env)`, the desired graph), `prices.ts`
(`s.cloud.prices`, the price catalogue and `estimatePlan`) with `price-sheet.json`; routes
`server/src/routes/admin/cloud-deployment-specs.ts`. Deploying Exprsn-AI is platform-only: `cloud:deploy` and
`platform:manage`, and creating needs a recent sign-in.

### The spec and its presets

A spec names the target (an AWS, Azure or DigitalOcean platform account and one of its regions), the highest label the
deployment holds (default `internal`), the compute shape (`kubernetes`, `vm`, `container`) and size, the data tier
(`provision`: PostgreSQL, Redis and the blob bucket; `existing`: `vault:` references to a database and Redis;
`onprem`: the data network's CIDRs), the front door (`cloudflare` with a Cloudflare account, `acme` with the
provider's DNS for dns-01, `byo`), up to four GPU pools (`l4`, `a10`, `h100`, with a minimum, a maximum and the busy
hours a scale-to-zero pool is estimated at), the tiers' zones (default `edge`, `app`, `data`, `inference`), the
network range (default `10.64.0.0/16`, a private /16 to /22) and the estimate's assumptions.

| Preset | App | Database | Cache | Availability zones | Egress assumed |
| --- | --- | --- | --- | --- | --- |
| small | 1 × 2 vCPU, 4 GiB | 2 vCPU, 4 GiB, 50 GB | 1 GiB | 1 | 100 GB |
| medium | 2 × 4 vCPU, 8 GiB | 2 vCPU, 8 GiB, 100 GB | 2 GiB | 2 | 500 GB |
| large (HA) | 3 × 8 vCPU, 16 GiB | 4 vCPU, 16 GiB, 250 GB, standby | 4 GiB, replica | 3 | 2000 GB |

The provider's sizes per preset are `PROVIDER_SKUS` (AWS `t3.medium`/`m6i.xlarge`/`m6i.2xlarge`, RDS `db.t4g.medium`
to `db.m6g.xlarge`; Azure `Standard_D2s_v5` to `D8s_v5`; DigitalOcean `s-2vcpu-4gb` to `s-8vcpu-16gb`, managed
databases `db-s-2vcpu-4gb` to `db-s-6vcpu-16gb`). GPU kinds a provider does not offer in the presets (Azure and
DigitalOcean L4, DigitalOcean A10) are refused at validation.

### Validation, before any provider call

`validateSpec` lists every problem with its field and check: the account (visible, the named provider, platform
scope); `checkRegion` with `use: deploy` (and `pools` for GPU pools), the same decision `assertRegionAllows` makes
(state, allow-list, ceiling, residency); the last validation's report for the features the spec needs (deploy, data
when provisioned, compute for GPU pools); the zones (defined, not the external zone, ceilings at or above the label for
the app, data and inference tiers); on-prem data reachable by the app zone's egress as its spec stands; GPU offers and
limits (four pools, 16 nodes a pool, 32 in all; no GPU pools on container platforms); the network range; the front
door (hostname in its zone; a Cloudflare front door caps the label at `confidential`, open decision 5, and its account
is checked the same way); a free name. `POST /api/admin/cloud/deployments` refuses a placement problem with `403` step
`zone` and any other with `422` `invalid_spec`, before the deployment exists and before any adapter or credential is
used; `validate-spec` answers the same list without changing anything.

### The network foundation from the zone specs

`renderNetwork` places each tier in its zone. AWS and Azure get one network (VPC, virtual network) on the spec's range,
with a private subnet per zone and availability zone (blocks of the range's prefix + 4; a zone whose own CIDRs already
lie inside the range keeps them); DigitalOcean VPCs have no subnets, so there each zone gets its own VPC, peered as the
zones are. One firewall per zone (security group, NSG, cloud firewall) carries the zone's rules from `zoneRules` in
`zones/render.ts`, the model the nftables rendering prints, read against the zone set with the deployed zones
addressed by their subnets (a zone the deployment does not place, such as an on-prem directory, keeps its own CIDRs).
So the cloud firewall of a zone equals the nftables table rendered for that zone's hosts rule for rule: within the
zone, each accepted source with its ports (one rule per TCP port; every protocol when the zone names none), and the
egress allow-list (deny egress keeps only traffic within the zone). A rule with no CIDRs (the corporate network while
`ZONES_CORPORATE_CIDRS` is unset) is left out, as nftables leaves it out. NAT is rendered only for a zone whose egress
allow-list reaches a public range. The edge subnets are public only for an internet-facing load balancer (ACME or
bring your own); behind Cloudflare the tunnel dials out and nothing is public.

The data tier's resources (database, cache, bucket) have `publicAccess: false`, private endpoints and the data zone's
private subnets and firewall; `publicDataProblems` (`graphProblems`) is the check that no data resource has a public
address, a public subnet or no private network, and the create route refuses a graph that fails it (`422`
`public_data`).

### The desired graph

`renderGraph` adds to the network: for `kubernetes` the cluster, the app node group and a node group per GPU pool
(tainted, tagged with its pool); for `vm` one VM per replica (IMDSv2, no public address, the release installer) and
GPU VMs per pool; for `container` ECS on Fargate, Container Apps or App Platform; a load balancer where the shape needs
one; the data tier; for `acme` a DNS record in Route 53, Azure DNS or DigitalOcean DNS (its value is the load
balancer's address once it exists). A type the adapter does not build (in this release DigitalOcean Spaces, a standalone load
balancer, a secret: the capability table) is rendered anyway: the plan shows them as unavailable and is not
applicable, and apply refuses it with `plan_unavailable`. A Cloudflare front door's tunnel and proxied record live on
the Cloudflare account, so they are rendered apart (`frontDoor`, `planned: false`) and applied from the front door
(`POST /api/admin/cloud/edge/:id/apply`, B-10901), after which they join the graph.

### Prices and estimates

Sources, each through `CloudTransport` (the egress guard and the rate limiter), never outside it:

| Source | What it prices | Credential |
| --- | --- | --- |
| AWS Price List Query API (`GetProducts`, `api.pricing.us-east-1.amazonaws.com`) | EC2, RDS for PostgreSQL (single-AZ) and ElastiCache instance hours, on demand, Linux | the account's `billing` credential (SigV4, `pricing:GetProducts`) |
| Azure Retail Prices API (`prices.azure.com`) | virtual machine hours, Linux consumption meters (no Spot, Low Priority or Windows), in the account's currency | none |
| DigitalOcean `/v2/sizes` | droplet and GPU sizes, monthly and hourly | the account's token |
| `price-sheet.json` (maintained, each entry with its source page and date) | what has no API: DigitalOcean databases, caches, load balancers, NAT, App Platform and Spaces; Cloudflare plans, R2, Tunnel; the EKS, AKS, DOKS, load balancer, NAT, egress and storage fees; and a fallback for every API-priced SKU | none |

API prices are cached in `cloud_prices` (migration `150_cloud_prices`) per provider, region, SKU, unit and currency;
a price older than a day is fetched again on use, and the job `cloud.prices.refresh` (daily) refreshes the preset
SKUs of every active platform account that has a deployment, so nothing calls a price API before someone deploys. A
failed fetch uses the stale cached price (marked `stale`), then the sheet. Without the table the sheet answers alone
and the estimate says so.

`estimatePlan(plan)` (`s.cloud.estimatePlan`, which the planner calls) prices the plan's desired graph against what
the deployment has now (`cloud_resources`): `{monthly, delta, before, currency, assumptions: {hours, storageGb,
egressGb, notes}, prices: [{sku, unit, price, currency, source, ref, date, region}], lines}`. Assumptions: always-on
resources run `hours` a month (730), month-priced ones are prorated to that; a highly available database or cache is
two nodes; GPU node groups run their minimum all month plus one node for the pool's busy hours; internet egress (and
NAT processing where there is NAT) is the spec's or the preset's; subnets, firewalls, records and tunnels are not
priced. A destroy plan's monthly is 0 and its delta minus the current cost. Currency (open decision 17): the account's
billing currency, USD by default (accounts carry none yet), with no conversion; a price in another currency is listed
but not in the total.

The sheet's prices were recorded from the providers' public pages on its `date` and must be checked at every release
(`version` in the file); an API price replaces a sheet price as soon as it is fetched.

Sheet `2026-10-20` was checked on 2026-10-20, read-only and without any account, against the providers' own public
sources: the AWS price list offer files for us-east-1 (`pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<service>/current/us-east-1/index.json`:
EC2 including NAT gateway, RDS, ElastiCache, EKS, ELB, S3, ECS (Fargate), AWSDataTransfer), the Azure Retail Prices
API for East US (`prices.azure.com/api/retail/prices`, or the global meter where Azure prices one), DigitalOcean's
pricing pages and its billing docs (load balancer, VPC NAT gateway, bandwidth), and Cloudflare's plans and developer
pricing pages. Each entry's `source` is the exact page or API query read. Every entry was confirmed; none is
unverified (an entry that cannot be confirmed would carry `"unverified": true`, which the loader ignores). Corrected:
RDS db.m6g.large (0.159) and db.m6g.xlarge (0.318), ElastiCache cache.m6g.xlarge (0.297), Azure Cache for Redis C1
(0.138) and C2 (0.224, Standard, per cache), Azure Blob hot LRS (0.0208 in East US), the DigitalOcean H100 GPU Droplet
(4.41 an hour, DigitalOcean's pricing of 2026-08-01), DigitalOcean PostgreSQL (60.90, 122.10 and 244.35 a month, the
primary-only plan with its minimum storage), and App Platform (78, 156 and 392 a month: the dedicated
`apps-d-2vcpu-4gb`, `apps-d-4vcpu-8gb` and `apps-d-8vcpu-32gb` instances `do-apps.ts` deploys, not shared ones).
Notes: the AKS free tier is 0 per the AKS pricing page, though the Retail Prices API lists a
`FreeTierInfrastructureCost` meter at 0.05 an hour from 2026-10-01 that the page does not mention; recheck it at the
next release. Azure VM, Redis and AKS pages render their prices client-side, so their entries cite the API.
The Workers AI rates (the `workersAi` section: USD 0.011 per 1,000 neurons and each model's neurons per million input
and output tokens) were checked on 2026-10-20 against `developers.cloudflare.com/workers-ai/platform/pricing/`; all
nine models matched and none changed. The page's daily free allocation of 10,000 neurons is recorded in the section's
note and is not subtracted.
The cloud model prices (`models.entries`, B-10505) were checked on 2026-10-21 against the us-east-1 offer files
`AmazonBedrock` and `AmazonBedrockFoundationModels`, the Azure Retail Prices API's Global Standard meters for East US
(`serviceName eq 'Foundry Models' and startswith(productName, 'Azure OpenAI')`) and DigitalOcean's inference pricing
docs (`docs.digitalocean.com/products/inference/details/pricing/`): all 19 priced models matched (DigitalOcean's
GPT-4o and GPT-4o mini gained their cached-input price), and each now carries its source, `date` and the provider's
effective day; still unverified are DigitalOcean's `llama3.3-70b-instruct`, `llama3-8b-instruct`,
`mistral-nemo-instruct-2407`, `deepseek-r1-distill-llama-70b` and `anthropic-claude-3.5-haiku`, which its pricing page
no longer lists (retired between February and August 2026 per its model support policy).

## Drift, destroy and limits (B-10106 to B-10108)

Sprint 57. Code: `server/src/cloud/lifecycle.ts` (`s.cloud.lifecycle`), `drift.ts`, `destroy.ts` (destroy and
rollback), `orphans.ts`; the limits in `providers/transport.ts` and `limits-metrics.ts`; routes
`server/src/routes/admin/cloud-lifecycle.ts`. Migration `149_cloud_lifecycle` (until it is applied
the routes answer `503` `migration_pending` and the drift and orphan schedules queue nothing). Nothing runs and nothing
is called until a deployment exists.

### Drift

`cloud.drift` runs every `CLOUD_DRIFT_MINUTES` (15; 0 turns it off), one job per deployment that has been applied and
is not being destroyed or applied. It reads every managed resource through the adapters and records findings:

| Kind | What it is |
| --- | --- |
| `field` | A field of the desired spec the provider reports differently, compared as the planner compares (`fieldChanges`): an inbound rule added by hand to a firewall is drift of `ingress` |
| `missing` | The provider no longer reports a resource the graph holds |
| `unmanaged` | A resource the graph does not hold inside a managed group: a subnet, firewall or machine in one of the deployment's networks, or anything tagged `exprsn:deployment=<name>`. Resources another deployment of the account manages, and AWS's default security group, are left out |

Each open finding is decided once (`cloud:deploy`): **revert** makes a plan back to the desired graph (purpose
`revert`; an unmanaged resource is first taken into the graph, so the plan deletes it) and, with `apply: true` and a
recent sign-in, applies it; **adopt** makes the observed state the desired one (the field's value; a missing resource
leaves the graph; an unmanaged one joins it under a key made from its name); **ignore** keeps that field or resource
out of later runs (the next apply still sets an ignored field back to desired: adopt it to keep the provider's value).
A revert plan returns the whole graph to desired, so other open findings it fixes are `resolved` at the next run. New
findings are told once to the deployment's owners (who created it and the tenant's cloud admins; for a platform
deployment those who also hold `platform:manage`). Audit: `cloud.drift.detected`, `cloud.drift.decided`.

### Change trail (B-10703)

Sprint 62. Code: `server/src/cloud/change-trail.ts` (`s.cloud.lifecycle.trail`), the adapters' `changeEvents`
(`providers/aws.ts`, `azure.ts`, `cloudflare.ts`). Migration `165_cloud_change_trail` (not registered yet: until it is
applied nothing is looked up, drift runs as before and each finding answers `changedBy: null` with the trail
`unavailable`).

Each drift run, after recording its findings, asks the provider's own trail who changed the resources of the **open**
findings, so every finding on `GET .../drift` carries `changedBy` (`principal`, `principalType`, `at`, `action`,
`source`, `eventId`, `sourceIp`, `byExprsn`) and `trail` (`state`, `attempts`, `window`, up to five `events`,
`checkedAt`, `error`):

| Provider | Trail | Looked up by | Permission (feature) |
| --- | --- | --- | --- |
| AWS | CloudTrail `LookupEvents`, in the resource's region (us-east-1 for Route 53) | `ResourceName`: the provider id, a record set's hosted zone | `cloudtrail:LookupEvents` (deploy) |
| Azure | Activity Log, `eventtypes/management/values` | `resourceUri`: the ARM id | `Microsoft.Insights/eventtypes/values/read` (deploy; Reader holds it) |
| Cloudflare | the account's audit logs | the resource's ids (a record set's record ids, a tunnel's id) or the record's name | Account Settings Read (frontdoor) |
| DigitalOcean | none this build reads | — | — (`unsupported`, nothing is called) |

Bounded, as CloudTrail allows two lookups a second per account and region: a resource without an open finding is never
looked up, a run with no finding calls nothing, the window is the 24 hours before the finding was first seen (plus two
minutes of clock slack), at most ten lookups per run and three pages per lookup (five of 100 on Cloudflare), each
through the adapter's transport (egress guard, per-account limiter, breaker). Reads are left out. A change made with
Exprsn-AI's own credential (the principal the account's last validation saw; two sessions of one AWS role are one
principal) is listed with `byExprsn: true` and chosen only when no one else changed the resource in the window. Trails
arrive late (CloudTrail within about 15 minutes), so a finding with nothing found yet stays `pending` and is asked again
on later runs, at most four times and for six hours after its first sighting; then it is `not_found`. A found finding
is not asked again. A failed lookup (a missing permission, throttling) never fails the drift run: the finding's trail
says `error` with the provider's message and the next run tries again.

Test: `server/test/cloud-change-trail.test.ts` (AWS: the principal and time from CloudTrail, the drifted resource only,
the bounded window, Exprsn-AI's own change flagged and not chosen, a read and an older change left out; no finding, no
lookup; late delivery and the attempt cap; a refused lookup; Azure's Activity Log for a resource deleted out of band;
Cloudflare's audit log for a record made DNS-only by hand; DigitalOcean unsupported; the missing migration), against
`fake-aws.ts` (`addTrailEvent`), `fake-azure.ts` (`addActivity`) and `fake-cloudflare.ts` (`addAuditLog`).

### Destroy

`POST .../destroy` (`cloud:deploy`, a recent sign-in) starts `cloud.destroy`, which deletes in rounds, each an ordinary
`cloud.apply` of a destroy plan whose desired graph is what must stay for now, so the planner deletes the rest in
reverse dependency order:

1. A protected resource (the graph's `protect` flag, and every database) stays, with everything it depends on; the rest
   of the deployment is deleted at once. The destroy then waits (`waiting`) and tells the other cloud admins.
2. A second cloud admin approves deleting it (`.../protected/:key/approve`, `cloud:admin`, a recent sign-in, never the
   person who asked; a platform deployment also `platform:manage`). Its final snapshot is taken through the adapter's
   `snapshot` hook and followed until it exists; only then does the next round delete it (`approvedProtected`).
3. Where the adapter has no snapshot for the type (this build: DigitalOcean droplets and, since Sprint 59, managed
   databases on AWS, Azure and DigitalOcean have one; object stores have none), approving is refused with the reason
   (`409` `snapshot_unsupported`) and the resource stays until its protection is removed from the desired graph. A
   database's final snapshot outlives it ("Managed databases" below).
4. After the last round the deployment is `destroyed`. Rejecting an approval or cancelling a waiting destroy ends it
   (`cancelled`, the deployment `failed`); what was deleted stays deleted. A round's failed apply fails the destroy;
   asking again continues from what is left.

Audit: `cloud.destroy.requested`, `.approved`, `.rejected`, `.snapshot` (with the snapshot's id), `.finished`.

### Rollback

When an apply of a deployment that passed verify before fails, `cloud.rollback` (on behalf of the person who applied;
`CLOUD_AUTO_ROLLBACK`, on by default) plans every resource that is not protected back to its desired spec at the last
passing verify; resources added since are deleted and protected ones are left as they are. It is applied at once when
it can be. `POST .../rollback` does the same by hand. Audit: `cloud.rollback.started` (`auto`, `failedPlan`),
`cloud.rollback.finished`.

### Orphans

`cloud.orphans` (every `CLOUD_ORPHAN_SWEEP_HOURS`, 24, per account a deployment uses; also `POST .../orphans/sweep`)
lists in every region of the account's allow-list what carries the account's `exprsn:*` tags (or, where the provider
keeps none, its `exprsn-<account>-` name prefix) and keeps what no graph and no journal knows: no live resource row
holds its provider id and no journal step of a deployment that is not destroyed recorded it. Each orphan is adopted
into a deployment of the same account, ignored, or deleted (`cloud:admin`, a recent sign-in; journalled under the
deployment). A database is never deleted as an orphan: adopt it and destroy the deployment. Audit:
`cloud.orphan.found`, `.adopted`, `.ignored`, `.deleted`.

### Rate limits, retries and the circuit breaker

Every call has an API class (`apiClassOf` in `providers/transport.ts`): `read`, `list` (AWS `Describe*` and `List*`
actions, collection and paged reads), `mutate` and `billing` (Cost Explorer, Pricing, Budgets, Cost Management and
Consumption, DigitalOcean `/v2/customers/my/`, Cloudflare `/billing/`). Buckets per account, provider and class, a
minute each, beside the account's total:

| Provider | read | list | mutate | billing |
| --- | --- | --- | --- | --- |
| AWS | 1200 | 600 | 300 | 60 |
| Azure | 1000 | 500 | 300 | 30 |
| DigitalOcean | 240 | 240 | 120 | 30 |
| Cloudflare | 200 | 200 | 100 | 20 |

Each bucket refills in six slices of its window, a slice spending at most twice its share, so a burst never takes a
window's allowance at its start. Providers that say what is left hold the class back while it is low: ARM's
`x-ms-ratelimit-remaining-*` at two or less (a second per call short, at most 10 s), DigitalOcean's
`ratelimit-remaining` until its `ratelimit-reset`. Throttling signals: AWS throttling codes in the body or
`x-amzn-errortype`, `429` everywhere, `503` with `Retry-After`; the wait is the provider's (`Retry-After`,
`x-ms-retry-after-ms`, `ratelimit-reset`) or exponential backoff with full jitter.

The breaker, per provider and account in each process: five `5xx` answers or timeouts in a row open it; while open,
calls fail at once with `503` `circuit_open` and the time left (the apply worker waits that long and tries again); after
30 s one probe goes through (half-open), and its answer closes the breaker or opens it again. `4xx` answers and
throttling never count.

Metrics (`/metrics`): `exprsn_cloud_wait_seconds{provider,api_class,reason}` (reason `limiter`, `retry`, `hold`),
`exprsn_cloud_calls_total{provider,api_class,outcome}` (`ok`, `error`, `throttled`, `unreachable`, `refused`,
`rate_limited`, `circuit_open`), `exprsn_cloud_breaker_transitions_total{provider,to}`,
`exprsn_cloud_breakers_open{provider}`.

Tests: `server/test/cloud-drift-destroy.test.ts` (drift and its three decisions, notices, destroy order, the protected
droplet waiting for a second admin with its snapshot first, rollback after a failed apply, the orphan sweep) and
`server/test/cloud-limits.test.ts` (API classes, a burst of 500 reads under the DigitalOcean fake's limit with no
refusal reaching the caller, each provider's throttling signals, the breaker open, half-open and closed, the metrics).

## DNS, TLS and budgets (B-10206, B-10602)

Sprint 58. Code: `server/src/cloud/value-from.ts` (records whose value comes from another resource), `cloud-dns.ts`
(dns-01 through a cloud account's DNS), `cert-push.ts` (certificates pushed to load balancers), `budgets.ts`
(`s.cloud.budgets`), `spend.ts` (the `SpendSource`); routes `server/src/routes/admin/cloud-budgets.ts`
([api.md](api.md)). Migration `152_cloud_budgets`: `cloud_budgets`, `cloud_budget_alerts`,
`cloud_budget_overrides`, and two nullable columns of `platform_cert_hooks` (`account_id`, `target`). Until it is
applied the budget routes answer `503` `migration_pending`, no alert is sent, no plan is refused for budget, and the
load-balancer hook kinds are refused. Nothing changes until someone sets a budget or a cloud DNS provider.

### Records from another resource's address

The front door's record (`renderGraph`, `frontDoor.kind: acme`) is `{type: dns_record, spec: {zone, record,
recordType: CNAME, values: [], valueFrom: {key: lb, field: address}}}`. The planner makes the source a dependency, so
the record is ordered after it; it compares the record with the source's address as the provider reports it now (the
values are left out of the comparison while the source has none), and when the plan creates or replaces the source an
existing record is updated after it. At apply the values are filled in from the source's row as the apply just stored
it (`address`, else `dnsName`, `hostname`, `fqdn`, `ip`, or the row's locator, where the cluster's load balancer keeps
the address the deploy worker read); a source with no address yet fails the step with `value_source_pending`. A CNAME
whose source reports an IP address (DigitalOcean load balancers) is written as an A or AAAA record.

### dns-01 through Route 53, Azure DNS or DigitalOcean DNS

`ACME_DNS_PROVIDER=route53`, `azure-dns` or `digitalocean` (beside `rfc2136` and `webhook`) with
`ACME_DNS_CLOUD_ACCOUNT` (the account's id or name: active, of that provider) and `ACME_DNS_CLOUD_ZONE` (the zones it
may write in, a comma list; Route 53 may leave it out and finds the hosted zone; an Azure zone lives in the account's
managed resource group `exprsn-<account>`). The `_acme-challenge` TXT record set is written through the account's
`dns_record` adapter with its `deploy` credential, so every call goes through the egress guard, the limiter and the
breaker; a wildcard and its base name share one set, and a change is followed until the provider applied it (Route 53
INSYNC) before the CA validates. The CA is whatever `ACME_DIRECTORY_URL` names: a public CA (with `ACME_EAB_*` when it
asks) or the Exprsn-AI CA's own directory (`/pki/acme/<tenant>/directory`), whose dns-01 validation asks
`PKI_ACME_DNS_SERVERS`.

### Renewed certificates on the load balancer

Three certificate hook kinds (B-1806, `ops/cert-hooks.ts`) push each issued or renewed certificate, with its key, from
the issuing instance, so the load balancer serves it as soon as it exists, inside the renewal window
(`ACME_RENEW_DAYS`) and so before the old one expires:

| Kind | Target | What it does |
| --- | --- | --- |
| `aws-acm` | `{listenerArn}` or `{loadBalancerArn, port? (443)}` | ACM `ImportCertificate` (re-imported into the same ARN after the first push, which listeners using it pick up), then ELBv2 `ModifyListener` when the HTTPS listener names another certificate |
| `azure-appgw` | `{resourceGroup, gateway, certificateName?, listener?}` | The gateway's SSL certificate replaced by a PKCS#12 with a one-time password (never stored), the listener pointed at it, by an ARM PUT followed until it succeeds |
| `do-lb` | `{loadBalancerId}` | A DigitalOcean custom certificate uploaded, the HTTPS forwarding rules pointed at it, the replaced certificate deleted |

Each target may instead name `{deploymentId, resourceKey}`, resolved from the resource graph at push time. The hook
keeps what the last push left in `target.state` (the ACM ARN, the DigitalOcean certificate id, the serial); the key is
opened from its seal only for the push and never stored elsewhere or written to the audit chain. Results are the
hook's `lastState` and `platform.cert.hook.ran` / `.failed`.

### Budgets

A monthly budget per account (`PUT /api/admin/cloud/accounts/:id/budget`, `finops:manage`; a platform account also
`platform:manage`) in the account's billing currency (open decision 17: USD by default, never converted; spend in
another currency is listed as excluded), with a hard stop at 100 % of actual spend (`hardStop: actual`, the default),
of the forecast (`forecast`) or none (`off`).

- **Alerts** at 50, 80 and 100 % of actual and of forecast spend, each once per account and month (UTC;
  `cloud_budget_alerts`, unique, so two instances never both send one): the audit event `cloud.budget.alert`, which
  every webhook subscribed to `cloud.*`, `cloud.budget.*` or `*` receives, and a notice of kind `cloud.budget`
  (Administration) to the tenant's FinOps readers and cloud admins, by email too at 100 %. `cloud.budgets.check` runs
  every `CLOUD_BUDGET_CHECK_MINUTES` (60) and after every successful apply. A changed amount or currency starts the
  month's alerts afresh.
- **The hard stop**: past it, a plan that adds monthly cost carries the blocker `budget_exceeded` and apply refuses
  it with `409 budget_exceeded` (asked again at apply, so the same plan goes through once an override is approved).
  Adding cost is a positive estimated delta; without an estimate, a create or replace of anything priced; and,
  whatever the estimate, a GPU node group scaled above its minimum (a new one that can run nodes, a higher `min`,
  `count` or `max`; open decision 10). Destroy, scale-down and plans with a zero or negative delta always pass.
- **Overrides** (dual control): proposed with a reason (10 to 500 characters) for up to 168 hours, approved by
  another admin holding `finops:manage` or `cloud:admin` with a recent sign-in (never the proposer); they run from
  approval, end by themselves (`expired`, audited once) and can be revoked at once. One pending or active override per
  account. Audit: `cloud.budget.set`, `.updated`, `.removed`, `.alert`, `cloud.budget.override.proposed`,
  `.approved`, `.rejected`, `.withdrawn`, `.revoked`, `.expired`.

### Spend: billing data, else estimates

`SpendSource` (`cloud/spend.ts`) has two calls, `actualMonthToDate(accountId, {currency?, now?})` and
`forecast(accountId, {currency?, now?})`, each `{amount, currency, source, deployments, excluded, month, at}` (since
Sprint 59 also `basis`, why that source; `billedThrough`; `runRate`; `lastFetchedAt`). `s.cloud.budgets.spend` is
`AccountSpend` (`cloud/billing-spend.ts`), which picks per account:

- **Billing data** (`BillingSpend`, `source: billing`) when the account has a successful billing fetch in the last
  three days ([Billing ingestion](#billing-ingestion-b-10603)): the actual is the sum of the account's `cloud_costs`
  rows of this UTC month in the budget's currency (today's included); the **forecast is the month-to-date actuals plus
  the current run rate for the rest of the month**, where the run rate is the sum of the latest applied plan's
  `estimate.monthly` of each of the account's deployments (a destroy's is 0), counted from the end of the last billed
  day (so the days not billed yet, today included, are forecast at that rate) to the month's end. Rows in another
  currency are listed in `excluded`, never converted. Costs with no deployment tag (support, tax, shared traffic) count
  towards the actual but not the run rate.
- **Estimates** (`EstimatedSpend`, `source: estimate`) otherwise: no billing fetch yet, the last one older than three
  days, or migration 155 missing. Each applied plan's `estimate.monthly` is the deployment's run rate from when it was
  applied until the next applied plan (a destroy's is 0), prorated over the UTC month; the forecast adds the current
  run rate for the rest of the month.

The budget view's `status.source` says which, in words (and `status.actual.basis` why); the alert notices end "From
billing data." or "Estimated from applied plans; no billing data yet.", and `cloud.budget.alert` carries `source`. The
alerts, the hard stop and the overrides are unchanged. `budgetBurn(s, now?)` (`cloud/billing-spend.ts`) lists every
budget against its spend through `statusOf` (budget, actual, forecast, percentages, source, stopped), for the budget
burn metric.

Tests: `server/test/cloud-dns-tls.test.ts` (valueFrom ordered, resolved, followed on replace and turned into an A
record for an IP; dns-01 on the Route 53, Azure DNS and DigitalOcean fakes; a certificate renewed by dns-01 on Route
53 served by the AWS fake's listener before the old one expires; the Application Gateway and DigitalOcean pushes; the
Exprsn-AI CA issuing by dns-01 through Route 53 and the listener serving it and its renewal) and
`server/test/cloud-budgets.test.ts` (alerts once each per month as notices and webhooks; the refusal, the override by a
second admin and its expiry; scale-down, destroy and the GPU rule; permissions; the estimate source; the missing
migration).

## Billing ingestion (B-10603)

Sprint 59. Code: `server/src/cloud/costs.ts` (`s.cloud.costs`), `billing-spend.ts` (budgets on actuals, above);
routes `server/src/routes/admin/cloud-costs.ts` ([api.md](api.md)). Migration `155_cloud_costs`:
`cloud_costs` (the daily rows) and `cloud_cost_fetches` (one row per account and fetch key). Until it is applied nothing
is fetched, the cost routes answer `503` `migration_pending`, and budgets stay on estimates. Nothing is called until an
account is **active and its last validation shows billing read access** (the `billing` feature `ok`); Cloudflare
accounts are fetched since Sprint 61 ([Cloudflare billing](#cloudflare-billing-and-showback-b-10608-b-10604)).

Each fetch uses the account's billing credential (`s.cloud.credentials.for(account, 'billing')`: the AWS billing role or
key, the Azure identity's ARM token, the DigitalOcean token) and goes through `CloudTransport` (the egress guard, the
`billing` API class's small rate-limit share, retries on throttling, the breaker).

| Provider | Call | Rows |
| --- | --- | --- |
| AWS | Cost Explorer `GetCostAndUsage` (open decision 9, settled 2026-10-20), `DAILY`, `UnblendedCost`, `GroupBy` the `exprsn:deployment` tag and `SERVICE`, filtered to the account's own `LINKED_ACCOUNT` | one per day, tag value and service; `estimated` is Cost Explorer's flag for the day |
| Azure | Cost Management `POST /subscriptions/<id>/providers/Microsoft.CostManagement/query` (`ActualCost`, `Daily`, grouped by the `exprsn:deployment` tag key, the same key as on AWS, and `ServiceName`), following `nextLink` | one per day, tag value and service, in the currency Azure bills in |
| DigitalOcean | `/v2/customers/my/balance`, `/v2/customers/my/invoices`, and the items of the current month's preview and of finished months not yet ingested from their final invoice (those in the window and always the last one) | each item's amount spread over the days of its start and end times; attributed by its `resource_uuid` or `resource_id` to the deployment whose graph holds that provider id; `source` `digitalocean-preview` (estimated) or `digitalocean-invoice` |

DigitalOcean has no per-tag costs, so attribution is by resource id; the invoice CSV
(`/v2/customers/my/invoices/<uuid>/csv`) and the billing history are not read, because the JSON items carry the
resource ids the CSV does not (the fake serves both). The balance's month-to-date usage is kept with the fetch
(`note.balance`) beside the preview total ingested, as a check.

**Requests kept to a minimum.** Cost Explorer charges per request (USD 0.01 at the time of writing), so:

- the whole window is **one** `GetCostAndUsage` request (a second only when the answer carries a `NextPageToken`);
- each account is fetched at most **once a UTC day** by the schedule: the claim is a unique row per account and fetch
  key (the day) in `cloud_cost_fetches`, so a re-run, a second instance or the next tick the same day calls nothing
  (`skipped: cached`); a fetch that failed or crashed (still `running` after 30 minutes) is taken over by the next run,
  at most three attempts a day, which makes the daily job resumable;
- "fetch now" (`POST .../costs/fetch`, `finops:manage`) is keyed by the day and hour: at most one an hour per account,
  refused with `409 costs_recent` otherwise;
- the window is the last 14 days and at least the whole current month (providers revise recent days); each fetch
  **replaces** the rows of the days it covers (a DigitalOcean invoice replaces its whole month), so a revision
  overwrites and a re-fetch of the same answer writes the same rows.

`cloud.costs.ingest` runs daily as the platform tenant over every eligible account (only once an active AWS, Azure or
DigitalOcean account exists); with `accountId` it fetches one (the "fetch now" job). Amounts keep the currency the
provider billed in (open decision 17): nothing is converted, and sums are per currency. Audit: `cloud.costs.ingested`
(window, requests, rows, totals), `cloud.costs.failed`, `cloud.costs.fetch.requested`.

**Estimate against actual** (`GET .../costs/estimate-vs-actual`, `GET /admin/cloud/deployments/:id/costs`): per
deployment over a period (UTC days, default this month), the applied plans' estimates prorated over the days up to now
(month by month) against the ingested rows, in the account's billing currency, with the difference and the ratio;
unattributed rows are their own line, rows in other currencies are listed apart. The Cloud accounts screen shows the
month's billed total per account ("Cost this month") and, in the inspector, the estimate against actual so far, where
the budget's spend comes from, the last fetch and "Fetch costs now".

Tests: `server/test/cloud-costs.test.ts` (Cost Explorer by tag into daily rows, yesterday's cost for a deployment equal
to the fake's figure for its tag, the full row; one request per account and day, revisions overwriting, idempotent
re-fetch, paging, the attempt cap; Azure by tag with its currency kept; DigitalOcean from invoice items by resource id;
estimate against actual; budgets switching to actuals and back on stale data; the routes and permissions; without
migration 155) and `server/test/cloud-budgets.test.ts` (the budget view and the hard stop on billing data).

## VM and container targets (B-10204, B-10205)

Sprint 58. Code: `server/src/cloud/compute.ts` (the user data, the secret bindings, `computeProblems`, the secret
broker and the `vm.install` readiness check), `providers/aws-compute.ts` (EC2 and ECS), `providers/azure-compute.ts`
(virtual machines and Container Apps), `providers/do-apps.ts` (App Platform) and the droplet's user data in
`providers/digitalocean.ts`; the render branches for `compute.shape` `vm` and `container` in `render.ts`. No migration,
no new route: a VM or container deployment is planned and applied like any other. Nothing is called until someone
creates a deployment.

### The spec

`release` pins what the app tier runs: `release.tarball` (`url` https, `sha256`, optionally a cosign `bundleUrl` with
the signer `identity` it must come from) for VMs, `release.image` (an image by digest, `registry/repo@sha256:...`) for
containers, `release.version` for the revision suffix. `keys` says where the deployed app's key-encryption key lives
(open decision 8): `openbao` (`addr`, `transitMount`), or the cloud KMS of B-10208, `aws-kms` (`region`,
`accessKeyId`, the secret key's `secretRef`) on AWS and `azure-keyvault` (`vaultUrl`, `tenantId`, `clientId`, the
client secret's `secretRef`) on Azure. `validateSpec` asks for the tarball on the VM shape, the image on the
container shape and `keys` on both, and refuses `aws-kms` on ECS: ECS hands secrets to a task as variables, and
production takes `KMS_AWS_SECRET_ACCESS_KEY` only as a file.

### VMs

One VM per app replica (`app-1`...), in the app zone's subnet and firewall, no public address. Its user data is
cloud-init (`renderCloudInit`): the plain settings in `/etc/exprsn-ai/exprsn-ai.env` (`NODE_ENV`, `PUBLIC_URL`,
`KMS_PROVIDER` and the key provider's non-secret settings), the list of systemd credentials the unit loads
(`/etc/exprsn-ai/credentials.list`: `session_secret`, `database_url`, `redis_url` and the key provider's credential,
by `vault:` reference only), a placeholder for the bootstrap token, and a bootstrap script that downloads the release
tarball, compares its sha256 with the pinned digest and refuses on a mismatch before anything from the archive is
extracted, then runs the installer out of the verified archive: `install.sh --from-release <url> --sha256 <digest>
--archive <copy> --kms <provider> --credentials-list ... --credentials-wrapped ... --start`
([deploy.md](deploy.md#bare-metal-systemd)). The rendered user data holds no secret value.

At create time the adapter asks the engine's secret broker (`EngineHooks.secrets`, `defaultSecretBroker`) for a
single-use OpenBao response-wrapping token (`sys/wrapping/wrap`, 15 minutes) holding the credentials' values and puts
it in place of the placeholder; the installer unwraps it once, writes each value as a systemd credential
(`LoadCredentialEncrypted=` when `systemd-creds` can seal it to the host, `LoadCredential=` from a root-only file
otherwise) and the unit reads them as `<NAME>_FILE=%d/<name>`, never as variables. A token that was already used makes
the install refuse, which is how a leaked copy of the user data shows. Without OpenBao (`OPENBAO_ADDR` unset on the
control plane) the VM installs with its credentials pending, and its readiness says so.

| | EC2 | Azure | DigitalOcean |
| --- | --- | --- | --- |
| Create | `RunInstances` with the step's idempotency key as `ClientToken`, Ubuntu 24.04 from Canonical's SSM parameter, encrypted gp3 root volume, tags on instance and volume | network interface (no public IP, the zone's NSG), then the VM: Trusted Launch with a vTPM, password sign-in off, an SSH key nobody holds, boot diagnostics on; PUT by name | droplet with `user_data`, in the deployment VPC, monitoring on |
| Metadata service | IMDSv2 required, hop limit 1 (`MetadataOptions`); reported back and put back by an update when it drifts | IMDS answers only with the `Metadata: true` header; no hop limit to set | no tokens; the cloud firewall carries the zone's rules |
| The installer's result | `GetConsoleOutput` | `retrieveBootDiagnosticsData`, the serial log read through the transport without the ARM token | no console read: `unknown`, `/readyz` decides |

The installer writes one `exprsn-install: <state> ...` line per outcome on the console. The readiness check `vm.install`
(registered with verify, `vmInstallStatus` on the adapters) reads it for every app VM: `installed` passes, `refused`
(a sha256 mismatch, a bad signature, an archive that leaves its tree, a used token) fails, anything else is
`unknown`. So a VM built from a tampered tarball applies (the VM exists), refuses to install, and the deployment fails
verify and is `degraded`. A VM is not updated in place beyond its tags and metadata options; a new release is a new
VM.

### Container platforms

One `container_service` named `app`, with settings in `env`, secrets as `secrets` bindings (references) and the
migration `node server/dist/cli.js migrate` run as a one-off before every rollout.

| | ECS on Fargate | Container Apps | App Platform |
| --- | --- | --- | --- |
| What is made | cluster, the secrets in Secrets Manager, the service's own ALB (load balancer, target group on `/readyz`, listener), task definition, service with the deployment circuit breaker | managed environment in the app subnet (internal behind a tunnel), the migration job, the app in single revision mode (suffix from the release version), readiness and liveness probes | one app spec in the VPC, health check on `/readyz` |
| Migration | `RunTask` with the command overridden; the service is created or moved only after it stopped with exit code 0 | a manual job started once per rollout and followed to `Succeeded` before the app is put | a `PRE_DEPLOY` job; a failed one fails the deployment and the previous one keeps serving |
| Secrets | Secrets Manager values, named in the task definition by ARN (`secrets`), so ECS gives them to the task as variables | Container Apps secrets mounted as files at `/run/secrets/exprsn/`, read as `<NAME>_FILE` | `SECRET` values (encrypted by App Platform), as variables |
| Key-encryption key | OpenBao transit (`OPENBAO_TOKEN` as a secret) | OpenBao or `azure-keyvault` with `AZURE_IDENTITY_CLIENT_SECRET_FILE` | OpenBao |
| Long-running operation | `aws-ecs` | `azure-apps` | `do-app` |

The ALB belongs to the ECS service (decision of 2026-10-20): a separate `load_balancer` resource would have to be
wired to the ECS service's target group across two resources, so the container service owns it, and the render adds
no `lb` for the container shape. Behind a Cloudflare tunnel it is internal with an HTTP listener; internet-facing it
gets an HTTPS listener when the service has a certificate (`certificateArn`, B-10206's ACM import) and no listener at
all until then, never plain HTTP to the internet. Each rollout is a reconcile read back from the provider at every
poll (a journalled handle cannot change): the migration task or this rollout's job execution, then the service or app
until its deployment settles.

Values come from the broker (`value`, the vault as the deployment's creator) and go only to the provider's own
secret store; they are never in props, observed state, the journal or an error. Production refuses `DATA_KEY`,
`DATA_KEY_PREVIOUS`, `SIGNER_TOKEN` and the cloud credentials inline, so none of those is ever handed over as a
variable.

### The check the planner refuses on

`computeProblems(desired)` is a blocker of every plan (beside `publicDataProblems`) and is checked again at apply: a
secret the config reads (`DATA_KEY` above all) set as a plain variable, a file-only secret delivered through a
platform's secret variables, a secret binding that is not a `vault:` reference, an image not pinned by digest, no
migration, and for an app VM no signed release pinned, user data that does not run `--from-release` with the pinned
digest or sets a secret inline, IMDSv2 without hop limit 1, or a public address. The adapters refuse `DATA_KEY` in a
task definition, a Container Apps template or an app spec as well.

Tests: `server/test/cloud-vm-containers.test.ts` (the render per provider; VMs on the EC2, Azure and DigitalOcean fakes
with their user data, IMDSv2 and hop limit 1, systemd credentials and the console; ECS, Container Apps and App Platform
created against the fakes with the migration first and no DATA_KEY in any request; the engine path where a tampered
tarball fails verify at `vm.install` on AWS and Azure; the planner's refusal) and
`server/test/deploy-from-release.test.ts` (the installer's verification with a good, a tampered and malformed local
tarballs, `--dry-run` only).

## Kubernetes target and upgrades (B-10203, B-10207)

1.9.99-final, Sprint 58. Code: `server/src/cloud/providers/kubernetes.ts` (shared), `aws-eks.ts`, `azure-aks.ts`,
`do-doks.ts` (each adapter hands the Kubernetes types to its module), `cloud/kubeconfig.ts`, `cloud/helm.ts`,
`cloud/kube.ts`, `cloud/chart-values.ts`, `cloud/releases.ts` (`s.cloud.releases`), `cloud/upgrades.ts`
(`s.cloud.releases.upgrades`); routes `server/src/routes/admin/cloud-releases.ts` ([api.md](api.md)). Migration
`151_cloud_releases`: `cloud_releases`, `cloud_upgrades`, `cloud_snapshots`. Without it a
Kubernetes deployment is verified as before, without a release, and the routes answer `503` `migration_pending`.

### Clusters and node groups

| | EKS | AKS | DOKS |
| --- | --- | --- | --- |
| Cluster | REST API (SigV4 `eks`), client request token, access entries (`authenticationMode: API`, the creator as admin), the app subnets and security group, private endpoint on, public only to `apiCidrs` | PUT by name: AKS-managed Entra ID, Azure RBAC, local accounts off, Azure CNI with Azure policy, application routing; the deployer gets "AKS RBAC Cluster Admin" (a role assignment named from cluster and principal) | `POST /v2/kubernetes/clusters` in the app VPC; deleted with `destroy_with_associated_resources` so the load balancer goes with it |
| App node group | managed node group (AL2023; NVIDIA AMI for GPU pools), labels and taints, `update-config` | the cluster's system pool (`initialPool`), adopted by the `nodes-app` step | the cluster's first pool (`initialPool`), adopted by name |
| IAM | roles `exprsn-<account>-eks-cluster` and `-eks-node` (or `clusterRoleArn`, `nodeRoleArn`), not graph resources | — | — |
| Kubeconfig token | presigned STS `GetCallerIdentity` (60 s signature, `x-k8s-aws-id` signed), 15 minutes | Entra token for the AKS server application (`6dae42f8-…`), server and CA from `listClusterUserCredential` | `GET .../credentials?expiry_seconds=600` |

`load_balancer` with `managedBy: cluster` is the load balancer in front of the release: the cluster's controller makes
it (the ALB from the AWS Load Balancer Controller, AKS application routing's, DigitalOcean's cloud controller from
the Service), so the adapter calls nothing; the deploy worker records its address in the graph row's locator, which
a front door record with `valueFrom: lb.address` reads. A standalone load balancer is another variant (B-10204,
B-10205).

### The release

After an apply of a Kubernetes deployment succeeds, `cloud.release` runs instead of verify:

1. A short-lived kubeconfig per operation in a private temporary file (0700 directory, 0600 file), deleted afterwards
   whether it worked or not; the token is never stored, logged or put in the environment. The API server's address is
   checked as every cloud address is (`*.eks.amazonaws.com`, `*.azmk8s.io`, `*.k8s.ondigitalocean.com`, or one
   `SERVICE_ALLOWED_HOSTS` names) before `helm`, which dials it itself, runs.
2. The namespace and one Kubernetes Secret (`exprsn-ai-secrets`), by server-side apply through the egress guard: the
   session secret and the key-encryption key (made once per deployment, sealed in the vault at
   `cloud/deployments/<id>`), and the database and Redis URLs behind the spec's `vault:` references (data mode
   `existing`; a provisioned data tier's URLs and CA bundle come from `s.cloud.dataTier` since Sprint 59, B-10302). With `clusterKeys` (open decision 8, B-10208) the app uses the
   cloud KMS through its workload identity: the chart projects the service-account token itself (audience
   `sts.amazonaws.com` or `api://AzureADTokenExchange`) and no `DATA_KEY` is in the cluster; with `keys` (a vaulted
   key pair or client secret) that secret is a file from the Secret. DigitalOcean has no cloud KMS: `DATA_KEY` is a
   file from the Secret.
3. `helm upgrade --install --wait --wait-for-jobs` with the pinned binary (`HELM_BIN`, Helm 3.19.0; any other version
   is refused), an argument array, never a shell, and an environment of its own. Values from the spec
   (`chart-values.ts`): the release image by digest, the preset's replicas and resources on the `exprsn.ai/role: app`
   nodes, `https://<hostname>`, the Secret's keys, `migrations.mode: job` (the chart's pre-install/pre-upgrade migrate
   Job), the ingress (AWS ALB with certificate discovery, AKS application routing) or a LoadBalancer Service
   (DigitalOcean, TLS on it with a certificate id), and the NetworkPolicies with the edge and data ranges. The blob
   store is a shared volume (`efs-sc`, `azurefile-csi`): the values do not switch to a provisioned bucket in this release.
4. The load balancer's address from the ingress or Service, the deployment's public URL, then `cloud.verify` (the
   app's `/readyz`).

A front door record that waits for the load balancer's address fails the first apply with `value_source_pending`;
the release then goes first and the plan is made and applied again, as the person who applied it.

### Upgrades (B-10207)

`POST .../upgrades` `{ image | imageDigest, externalBackup? }` plans an upgrade to a new release by image digest and
refuses before anything changes: no release yet, the running digest, another open upgrade, the resources not as
desired, or no database snapshot possible (the adapter's reason; `snapshot_unavailable` for a database the
deployment does not manage unless `externalBackup.ref` names the operator's own backup). It is approved as a plan with
the purpose `upgrade` (the current graph; the planner's checks and the budgets apply), applied by its hash; then
`cloud.upgrade` runs, holding the deployment's lease:

| Step | What |
| --- | --- |
| snapshot | through the adapter's snapshot hook, followed until it exists (or the operator's backup, recorded); listed in `cloud_snapshots` |
| migrate_check | `migrate --check` with the new image as a Job: exit 0 or 2 (expand only) go on; 3 (destructive) or 4 (the database is newer) stop the upgrade as `blocked` before anything is rolled |
| rollout | `helm upgrade` to the new digest (the migrate hook Job, then a rolling update, a new pod ready before an old one goes) |
| verify | the deployment's readiness checks |
| rollback | when the rollout or verify failed: `helm rollback` to the previous revision with no manual step, then verify again |

The database never rolls back with the app: its snapshot is listed for restore, which one cloud admin asks for
(`.../snapshots/:id/restore`) and another approves (`.../restore/approve`, `cloud:admin`, a recent sign-in, never the
one who asked); the job `cloud.snapshot.restore` runs the adapter's `restoreSnapshot`. An operator's own backup is
restored with its own tooling (`409 restore_external`). Since Sprint 59 (B-10307) the snapshot is the database
adapter's own (an RDS or Aurora manual snapshot, an Azure on-demand backup, a DigitalOcean restore point inside its
point-in-time window), and a restore makes a new instance that joins the graph beside the old one (`restoredTo` in
the audit entry); switching the app to it is the own-database move's cutover (B-10302).

Audit: `cloud.release.deployed`, `.failed`, `.rolled_back`; `cloud.upgrade.planned`, `.started`, `.snapshot`,
`.succeeded`, `.rolled_back`, `.blocked`, `.failed`; `cloud.snapshot.restore.requested`, `.approved`, `.rejected`,
`.failed`, `cloud.snapshot.restored`.

Tests: `server/test/cloud-kubernetes.test.ts` (a medium deployment on each fake: cluster and node groups, the
kubeconfig per provider, values, the Secret, the migrate Job, `helm lint` and `template` with the pinned binary
(skipped, saying so, without it), `/readyz`) and `server/test/cloud-upgrades.test.ts` (refusals, upgrade by digest
with the snapshot first and the migrate check, the automatic rollback after a failed verify, a destructive migration
blocked, the restore under dual control). The fakes: `fake-aws-eks.ts`, `fake-azure-aks.ts`, `fake-do-doks.ts`, and
`fake-kube.ts` (a cluster's API, the `helm` commands that need a cluster played against it, the app's `/readyz`).
What is faked: the clusters' Kubernetes API and `helm upgrade`/`rollback`/`history` (played by `kubeHelm`); `helm
version`, `template` and `lint` are the real pinned binary; the database is a DigitalOcean Managed PostgreSQL cluster on
`fake-do-db.ts`, snapshotted and restored through the adapter (Sprint 59).


## Managed databases (B-10301, B-10303, B-10307)

1.9.99-final, Sprint 59. Code: `server/src/cloud/databases.ts` (`s.cloud.databases`: engines, versions, sizes, the
extension allow-list table, the planner's protection rule, snapshot costs, schedules, restores),
`providers/aws-rds.ts` (RDS and Aurora over the RDS Query API, SigV4 on the adapter's transport), `azure-databases.ts`
(Flexible Server over raw ARM), `do-databases.ts`; routes `server/src/routes/admin/cloud-databases.ts`
([api.md](api.md)). Migration `153_cloud_databases`: `cloud_db_snapshot_schedules`. Without it the
schedule route answers `503` `migration_pending` and the schedule tick queues nothing; everything else works. Nothing
runs until a deployment's graph has a `database`.

### The database type

`DatabaseProps` (`providers/types.ts`): `engine` (`postgres` or `mysql`), `service` (AWS: `rds` or `aurora`),
`version` (a major version), `size`, `ha`, `storageGb`, `storageAutogrow`, `subnets` and `firewall` (graph keys),
`publicAccess` (must be `false`), `privateEndpoint`, `backups` (`days`, `window`), `maintenanceWindow` (`day`, `hour`,
UTC), `parameters`, `extensions`, `deletionProtection` (default on), `adminUser`, `adminPasswordRef` (a `vault:`
reference). Changing `engine`, `version` or `service` replaces the database, which a protected database never is.

| | AWS | Azure | DigitalOcean |
| --- | --- | --- | --- |
| Offer | RDS instance (`instance:<id>`); Aurora cluster with its writer and, for HA, a reader (`cluster:<id>`) | Database for PostgreSQL / MySQL Flexible Server (PUT by name, `Azure-AsyncOperation`) | Managed PostgreSQL / MySQL cluster |
| Versions | RDS PostgreSQL 13 to 17, MySQL 8.0 and 8.4; Aurora PostgreSQL 13 to 16, MySQL 8.0 | PostgreSQL 13 to 17, MySQL 8.0 and 8.4 | PostgreSQL 13 to 17, MySQL 8 |
| HA | Multi-AZ (RDS), a reader (Aurora) | zone-redundant (not on Burstable sizes) | a standby node |
| Private only | a DB subnet group in the data subnets, the data security group, not publicly accessible | public network access off, a private endpoint in the data subnet (`postgresqlServer` / `mysqlServer`) | in the data VPC; trusted sources from the data zone's firewall sources, else the VPC's range (DigitalOcean keeps a public host name, which the firewall refuses) |
| Parameters | a DB (or cluster) parameter group per database | server parameters | the engine config |
| Backups | retention 1 to 35 days and the daily window | retention 7 to 35 days | seven days, fixed |
| Admin password | managed by RDS in Secrets Manager, or the reference's value handed straight to RDS | the reference's value, or a random one Azure gets once and nobody keeps | the one DigitalOcean answers with, dropped |
| Deletion protection | `DeletionProtection` | a `CanNotDelete` management lock | a tag (`exprsn-deletion-protection`) the adapter honours; DigitalOcean has none |

An admin password is never in props, observed state, a handle, the journal or an error. Where none is named, whoever
connects first resets it (B-10302 for the own database, B-10306 for data connections).

### Extensions (pgvector, PostGIS, pg_trgm)

The render asks for `vector` (pgvector, the vector store) and `pg_trgm`; PostGIS on request. The planner refuses a
graph that asks for an extension the provider does not offer for the engine and version, naming it (`extension plv8
is not offered by azure PostgreSQL 16.`), before anything is created. The allow-list step, in the create (and every
update), before anything uses the database:

| Offer | Step |
| --- | --- |
| Azure | the `azure.extensions` server parameter gets the wanted extensions (merged with what is there, upper case) |
| RDS, Aurora | none by default; a parameter group whose `rds.allowed_extensions` restricts them gets the wanted ones added |
| DigitalOcean | none: every supported extension can be created |

`GET .../databases/:key/extensions` is the check: per extension `available`, `not_allowed` (offered, not in the
allow-list yet) or `not_offered`, from the provider's allow-list or supported list. `pg_available_extensions` is read
on the database by whoever connects to it (the own-database move, B-10302, and data connections, B-10306); the
control plane does not reach a private database itself.

### Deletion protection

On by default (the render and the adapters). The planner blocks a delete or a replace of a database with deletion
protection whatever the graph's `protect` flag says, and a change that turns it off (`deletionProtection: false` only
counts when the database was created so and the provider agrees). Only destroy deletes a protected database, after a
second cloud admin's approval and its final snapshot (above). And every adapter refuses the delete itself unless a
final snapshot of it from the last 24 hours exists (`409` `final_snapshot_required`); only then does it turn the
provider's protection off and delete. So no route (a plan, drift's revert, the orphan sweep, which never deletes a
database, or a direct adapter call) deletes one without its final snapshot.

### Snapshots, schedules and restores

| Purpose | AWS | Azure | DigitalOcean |
| --- | --- | --- | --- |
| final (destroy) | manual DB or cluster snapshot (outlives the database) | a retained copy: a point-in-time restore to a new Burstable server tagged `exprsn:snapshot-of` | a retained fork at the smallest size, tagged `exprsn:snapshot-of:<id>`, with the source's trusted sources |
| upgrade (B-10207) | manual snapshot | on-demand backup | a restore point (`pitr:<time>`) inside the seven days |
| manual, scheduled | manual snapshot | on-demand backup | manual: a fork; scheduled: refused (`provider_schedule`): DigitalOcean's daily backups are the schedule |

Copies and forks are snapshots, not databases: the adapters' lists leave them out, so drift and the orphan sweep never
see them. `GET .../databases/:key/snapshots` lists the provider's own backups and Exprsn-AI's snapshots with their
kind, size, retention and cost: from the price sheet (RDS and Aurora snapshot storage per GB-month, Azure backup
storage, a copy's or fork's monthly price; the provider's own backups are included in the database's price). The
snapshot prices were added from the providers' pricing pages without an account and are marked `"unverified": true`:
shown with the snapshot, never put in an estimate or a total (the sheet's loader leaves them out) until they are
confirmed at the release check.

A schedule (`PUT .../databases/:key/schedule` `{ everyHours, keep, enabled }`) is a row of
`cloud_db_snapshot_schedules`; the tick `cloud.db.schedules` (every 15 minutes) queues `cloud.db.snapshot` for what is
due, and a scheduled run deletes the schedule's own snapshots beyond `keep` (never a final, manual or provider-made
one). `POST .../databases/:key/snapshots` takes one now. `POST .../snapshots/:snapshotId/restore` `{ key?, size? }`
restores to a new instance beside the source (the same network, subnets, security group or private endpoint,
parameters, trusted sources, deletion protection on), which joins the graph as `<key>-restored`, protected; the
source is never overwritten. Audit: `cloud.database.snapshot.requested`, `.taken`, `.failed`, `.pruned`,
`cloud.database.schedule.set`, `cloud.database.restore.requested`, `cloud.database.restored`, `.restore.failed`.

### Tests and the sandbox

`server/test/cloud-databases.test.ts` (each provider and engine on its fake: create with HA, storage, backups, the
maintenance window and parameters, private only; the extension allow-list and check; snapshots with their cost,
restore to a new instance; deletion protection; through the engine: provisioning on Azure enabling the extensions,
schedules with retention, restore, a protected database blocked on every route, drift's revert, destroy with the final
snapshots) and `cloud-upgrades.test.ts` (the upgrade's snapshot and restore through the DigitalOcean adapter). The
fakes: `fake-aws-rds.ts`, `fake-azure-db.ts`, `fake-do-db.ts`. The owner's step (open decision 18): B-10303's "done
when" is the MySQL integration suite against a managed MySQL in the sandbox accounts (`TEST_MYSQL_URL` pointed at an
RDS, Azure and DigitalOcean MySQL made through a deployment), and the sandbox e2e (B-10804) records the extension
versions; neither runs in this build.

## Own database and caches (B-10302, B-10305)

1.9.99-final, Sprint 59. Code: `server/src/cloud/db-move.ts` (`s.cloud.dbMoves`: the move and its read-only window),
`cloud/data-tier.ts` (`s.cloud.dataTier`: a provisioned data tier wired into the deployed app), `cloud/caches.ts`
(`s.cloud.caches`) with the rules in `platform/redis-compat.ts`, the cache modules `providers/aws-cache.ts`,
`providers/azure-cache.ts` and `providers/do-cache.ts`; routes `server/src/routes/admin/cloud-db-moves.ts`
([api.md](api.md)); the CLI `exprsn-ai db:move` (`server/src/cli/db-move.ts`). No migration: a move's record and the
window live in `platform_state`. Nothing runs until someone plans a cache or starts a move.

### Caches as REDIS_URL

| | AWS | Azure | DigitalOcean |
| --- | --- | --- | --- |
| Offer | ElastiCache for Valkey or Redis OSS, a replication group, cluster mode off (one primary, a replica with failover and Multi-AZ for HA). MemoryDB is listed and described, never created or accepted | Azure Cache for Redis (Basic or Standard `C<n>`, Premium `P<n>` without shards); Azure Managed Redis (`Balanced_B1` and the like) with the `NoCluster` policy | Managed Valkey |
| Eviction | the account's own parameter group per engine family with `maxmemory-policy noeviction` (the default groups use `volatile-lru`) | `redisConfiguration.maxmemory-policy: noeviction`; Managed Redis `evictionPolicy: NoEviction` | `PUT .../eviction_policy noeviction` once online (the default evicts) |
| Network | the data subnets as a cache subnet group, the data zone's security group | public network access off, a private endpoint in the data subnet | in the deployment VPC; trusted sources from `allowCidrs` |
| TLS and the token | in-transit encryption, the AUTH token Exprsn-AI generates (`cache_auth_token`) and hands over through the secret broker | the non-TLS port off, TLS 1.2; the access key from `listKeys` (port 6380, Managed Redis 10000) | TLS; the password DigitalOcean generates, from the cluster's private connection |

The rules (`cacheCompatibility`): no cluster mode (BullMQ's multi-key scripts fail with `CROSSSLOT` across shards, and
the build does not hash-tag its keys; MemoryDB is always clustered), `maxmemory-policy noeviction` (an evicting
policy drops queued jobs, their locks and the shared counters without an error), TLS on, public access off. Where
they are enforced:

- the planner: a desired cache that breaks one is a blocker of the plan and of its apply, with the reason
  (`cache: refused as REDIS_URL (eviction_policy): maxmemory-policy is allkeys-lru: ...`); the adapters refuse it
  too (`cache_incompatible`) before calling the provider;
- wiring a cache as a deployment's `REDIS_URL` (`CloudCaches.wire`): the observed cache is checked again (a cache
  changed by hand), a refusal is `409` `cache_incompatible` with the problems and audited `cloud.cache.refused`;
  otherwise `rediss://[user]:<token>@<host>:<port>` is written to the vault (`cloud/deployments/<id>/data#redis_url`,
  platform scope) and audited `cloud.cache.wired` (host and port only);
- `/readyz`: with `REDIS_URL` set, `Bus.compatibility` reads `INFO cluster` and `INFO memory` at most once a minute,
  and `checks.redis` says `incompatible: cluster mode, maxmemory-policy allkeys-lru` (reported, not failed: the
  instance keeps serving while the operator fixes the cache). A Redis that does not report a field is not flagged.

### A provisioned data tier in the deployed app

With `data.mode: provision` the render adds the database (with `adminUser: exprsn` and `adminPasswordRef:
vault:cloud/<deployment>#db_admin_password`) and the cache; app VMs and container services depend on both. The app's
bindings name `vault:cloud/<deployment>#database_url`, `#redis_url` and `#database_ca`; the engine's secret broker
answers them from `s.cloud.dataTier` (`intercept`), which generates the database password and the cache token once
(the platform scope of the vault, `cloud/deployments/<id>/data`) and, at the first resolve after the database and cache
exist, wires the tier: `database_url` is `postgres://exprsn:<password>@<private endpoint>:<port>/<database>?sslmode=verify-full&sslrootcert=<file>`,
`database_ca` the provider's CA bundle (RDS's global bundle; DigiCert Global Root G2 and Microsoft RSA Root CA 2017
for Azure; DigitalOcean's per-cluster CA from `/v2/databases/<id>/ca`), checked to be PEM CA certificates, and
`redis_url` from the cache. Everything reaches the app as a file, never a value: the Helm release's Secret with the CA
at `/run/secrets/database_ca.pem` (`extraSecretFiles`), VM systemd credentials (`/run/credentials/exprsn-ai.service/database_ca`),
Container Apps secret files (`/run/secrets/exprsn/database-ca`). ECS and App Platform hand secrets over as variables
only, so `sslrootcert` has no file there and a provisioned database on them is refused (`ca_file_unsupported`).

### Moving an existing install

`exprsn-ai db:move --to <url file or deployment> --ca-file <bundle>`, or from the console under dual control
(`POST /api/admin/cloud/db-moves`, a second admin approves; both need `cloud:admin`, `platform:manage` and a recent
sign-in). The steps, each recorded as it finishes so a crash resumes at the next one (`--resume`, or the job's retry
once the dead instance's lease has passed):

| Step | What |
| --- | --- |
| preflight | the target over TLS verified against the CA file (`sslmode=verify-full`, `sslrootcert`; `pg_stat_ssl` must say TLS), its version, pgvector available, no tenant, user or audit row, the source fully migrated, a URL file to switch (`DATABASE_URL_FILE`), and the connection budget: `DB_POOL_MAX × instances + 5 ≤ max_connections − reserved` (the live `max_connections`, `superuser_reserved_connections` and RDS's `rds.rds_superuser_reserved_connections`; for planning, `MANAGED_MAX_CONNECTIONS` per size), and the window's estimate within its bound |
| schema | this build's migrations applied to the target |
| read_only | the window opens: every instance refuses changes (`503 read_only_window`, the job queue claims nothing) within two seconds; the move waits for running jobs (at most two minutes) |
| backup | `backup:create` (one consistent snapshot, sealed and signed) |
| restore | `backup:restore` into the target (the blob store is shared; only rows move) |
| verify | the source took no writes during the window (row counts against the manifest; a change closes the window and the resume takes a new backup), the target's rows equal the manifest's, `audit:verify` passes for every tenant on the target |
| migrate_check | `migrate --check` on the target: current, nothing pending, nothing newer |
| switch | the URL file rewritten (atomic, 0600; the old URL kept as `<file>.previous`), the old database kept read-only for `--keep-old-days` (default 7): `ALTER DATABASE ... SET default_transaction_read_only = on` where PostgreSQL lets the install's role, and the window's flag in any case. Restart every instance |

The window's documented bound is 30 minutes (`--window-minutes`): the dry run refuses a move estimated past it (twice
the last backup's time plus a restore at 20,000 rows a second), and a window that passes it before the switch closes
again and the move stops. Audit entries made while the window is open are held in the move's record and written when
it closes (to the new database after the switch), so the old database's chain takes no writes during the window.
Rollback: before the switch the window closes and the install stays where it was; after it, within the keep window,
the URL file goes back, the old database is writable again and the new one is put in a window, refused when the new
database took writes since the switch (`writes_since_switch`) unless they are given up. The runbook is
[runbooks/db-move.md](runbooks/db-move.md); the sandbox run against RDS (open decision 18) is the owner's step there.

Tests: `server/test/cloud-db-move.test.ts` (the move into a SQLite file standing in for the target: dry run, the
steps, the window, a crash resumed, the connection-limit refusal, the CA file, rollback before and after, writes
during the window, dual control and a recent sign-in), `server/test/integration/cloud-db-move-pg.test.ts` (a real
PostgreSQL with pgvector and TLS, `TEST_MOVE_PG_URL` and `TEST_MOVE_PG_CA`; the source SQLite or, with
`TEST_HARNESS_DB=pg`, PostgreSQL), `server/test/cloud-caches.test.ts` (each provider's fake, the refusals, `/readyz`).
The fakes: `fake-cloud-caches.ts` (ElastiCache and MemoryDB for `fake-aws.ts`, cache hosts and keys for
`fake-azure.ts`, Valkey clusters for `fake-do.ts`).

## Data connections from the cloud (B-10304, B-10306)

Code: `server/src/cloud/discovery.ts` (`s.cloud.discovery`), the drivers `server/src/connections/dynamodb.ts`,
`cosmos.ts`, `mongo-services.ts` (with `mongo.ts`), routes `server/src/routes/admin/cloud-data.ts`, migration
`156_cloud_connections` (without it discovery answers uncached and connect answers 503
`migration_pending`; existing connections are not affected either way).

### The engines (B-10304)

Five data connection engines, read-only (open decision 15), registered in `connections/engines.ts` like every other
(the Connections screen draws them from the catalogue):

| Engine | Service | Driver | Reads | Notes |
| --- | --- | --- | --- | --- |
| `documentdb` | Amazon DocumentDB | the MongoDB driver | `find`, `aggregate` | TLS with the Amazon RDS CA bundle (`tlsCaFile`, or carried by a cloud link), SCRAM-SHA-1, `retryWrites=false`, `readPreference=secondaryPreferred`; `$setWindowFields`, `$densify`, `$fill` and `$graphLookup` refused by classification; privileges are not reported |
| `cosmos-mongodb` | Azure Cosmos DB for MongoDB (vCore; RU accounts on port 10255 too) | the MongoDB driver | `find`, `aggregate` | TLS always, SCRAM-SHA-256, port 10260 |
| `do-mongodb` | DigitalOcean Managed MongoDB | the MongoDB driver | `find`, `aggregate` | TLS always with the cluster's CA; one member's `host:27017` (the driver dials the checked address directly, not the `mongodb+srv` name); accounts in `admin` |
| `dynamodb` | Amazon DynamoDB | `dynamodb.ts`, SigV4 through the egress guard | `Query`, PartiQL `SELECT` (ExecuteStatement) | writes, table changes, `Scan`, `GetItem` and every other operation refused; a SELECT without WHERE, or whose WHERE does not name the introspected partition key with `=` or `IN`, is refused as a scan |
| `cosmos-nosql` | Azure Cosmos DB for NoSQL | `cosmos.ts`, the SQL query API through the egress guard | one `SELECT` | account key (a read-only key), an Entra service principal (`https://cosmos.azure.com/.default`), or a cloud account's token; `udf.*` refused |

Classification, the allow-list (tables, containers, collections), masking of PII names and values inside documents,
the row cap (one more row is asked for to know a result is capped), the statement timeout and the audit of every
query, run or refused, are the service's, as for SQL. A refused request never reaches the provider: the DynamoDB
`UPDATE` of the backlog's acceptance is refused by classification (`422 Write refused`) with nothing sent. HTTPS
engines dial through `guardedRequest` with the connection rules (internal hosts, or `CONNECTIONS_ALLOWED_HOSTS`), so
the offline test guard refuses a real AWS or Azure host (`*.documents.azure.com` is listed with the Azure hosts).

### Discover and connect (B-10306)

`GET /api/admin/cloud/accounts/:id/discover` lists, per region on the account's allow-list, through the adapters'
transports (the egress guard, the shared rate limiter and the breaker) and the account's `read` credential:

| Provider | What | Calls |
| --- | --- | --- |
| AWS | RDS PostgreSQL and MySQL instances, Aurora clusters (the reader endpoint), DocumentDB clusters, DynamoDB tables | RDS `DescribeDBInstances`, `DescribeDBClusters`; DynamoDB `ListTables`, `DescribeTable` |
| Azure | PostgreSQL and MySQL flexible servers, Cosmos DB accounts (NoSQL; MongoDB RU), MongoDB vCore clusters | ARM lists across the subscription |
| DigitalOcean | PostgreSQL, MySQL and MongoDB clusters (Valkey, Kafka and OpenSearch listed without an engine) | `/v2/databases` |

The managed databases a deployment made (the `database` type of `cloud/databases.ts`) are marked with their
deployment and resource key, from the deployments' graphs and the adapter's own `list`. Each instance carries its
private and public endpoints, the connection engine it maps to and the ways it may authenticate. The last discovery
is kept in `cloud_discovered` for ten minutes (`?refresh=1` asks again), never with a password in it (DigitalOcean's
API lists the admin password with the cluster: it is dropped).

`POST /api/admin/cloud/accounts/:id/connect` makes a data connection to one instance (`providerId`, or `deploymentId`
and `resourceKey` for a provisioned one). The private endpoint is used unless `endpoint: public` is asked for; the
host is added to the tenant's allowed hosts at the same time and taken out again when the connection cannot be made
(audited `tenant.hosts.updated`). A public endpoint also needs the operator's `CONNECTIONS_ALLOWED_HOSTS`, which the
answer's `notes` say. The region is checked against the account's ceilings and the tenant's residency for the
connection's label (`assertRegionAllows`, use `data`).

| `auth` | For | What the connection holds | At each use |
| --- | --- | --- | --- |
| `password` | every SQL and MongoDB-family instance | the admin password (given once, or DigitalOcean's from its API) written to the tenant vault at `connections/cloud/<name>/admin`; the connection keeps the `vault:` reference | read as the admin who saved it |
| `lease` | PostgreSQL, MySQL, DocumentDB, DigitalOcean MongoDB | the admin password in the vault, a lease engine `cloud-<name>` (B-1704) logging in with it, a read role `conn` | a leased user (`exai_conn_…`) taken by the connections service, renewed by taking a fresh one at two thirds of its life (the old one is revoked); the sweeper drops a user when its lease ends; removing the connection revokes its lease |
| `rds-iam` | RDS and Aurora with IAM database authentication on | the database user | a 15-minute token presigned for `rds-db` with the account's credential (`rdsIamToken`), never stored |
| `entra` | Azure PostgreSQL flexible servers with Entra sign-in on | the Entra principal's database role | a token for `https://ossrdbms-aad.database.windows.net/.default` from the account's credential |
| `account` | DynamoDB, Cosmos DB for NoSQL | nothing | the account's session (DynamoDB, with its session token) or its token for `https://cosmos.azure.com/.default` (the principal needs the Cosmos DB Built-in Data Reader role) |
| `key` | Cosmos DB for NoSQL | the account's read-only key (ARM `readonlykeys`) in the vault | read from the vault |

The CA bundle a connection verifies TLS with comes from DigitalOcean's `/v2/databases/<id>/ca`, or is given as
`caPem` (the Amazon RDS `global-bundle.pem`; public certificates only), and is kept on the link. The link
(`cloud_connection_links`) is what `ConnectionService.cloud` reads at each use; a connection without one is read as
before. Audit: `cloud.discovery.run`, `cloud.connection.connected`, `connection.registered` (`via: cloud-connect`),
the lease engine's own events (`vault.database.engine.registered`, `vault.database.lease.issued` with the service as
actor, `.revoked`, `.expired`). Permissions: `cloud:read` and `connections:manage` together.

Tests: `server/test/connections-dynamodb.test.ts`, `connections-cosmos.test.ts`, `connections-documentdb.test.ts`
(TEST_MONGODB_URL runs the DocumentDB engine against a real MongoDB stand-in), `cloud-discovery.test.ts`; the fakes
`fake-aws-data.ts` (DynamoDB, RDS discovery lists), `fake-azure-cosmos.ts` (the Cosmos DB data plane and read-only
keys), DigitalOcean database clusters and CAs in `fake-do.ts`.

## Metrics and security (B-10702, B-10705)

### Metrics

`/metrics` serves the cloud plane's metrics (`server/src/cloud/cloud-metrics.ts`, beside the transport's in
`cloud/limits-metrics.ts`); labels are providers, steps, states, kinds and bases, never an account, deployment or
tenant.

| Metric | What it counts |
| --- | --- |
| `exprsn_cloud_operations_total{step,state}` | Journal rows appended, by step kind and state (started, pending, succeeded, adopted, failed, cancelled) |
| `exprsn_cloud_operations_inflight{state}` | Steps whose latest journal row is started or pending (last day) |
| `exprsn_cloud_apply_duration_seconds{provider,state}` | Apply runs that ended (applied, failed, cancelled), from taking the lease to the end; a resumed apply counts the resumed run |
| `exprsn_cloud_deployments{provider,state}` | Deployments by state |
| `exprsn_cloud_wait_seconds`, `exprsn_cloud_calls_total`, `exprsn_cloud_breaker_transitions_total`, `exprsn_cloud_breakers_open` | Throttling waits (limiter, retry, hold), calls by outcome, breakers (B-10108) |
| `exprsn_cloud_drift_findings_detected_total{kind}`, `exprsn_cloud_drift_findings{kind,state="open"}` | New drift findings, and those still open |
| `exprsn_cloud_budget_burn_ratio{provider,basis}` | The highest share of a budget spent (actual) or forecast this month among the provider's accounts (1 = 100 %) |
| `exprsn_cloud_budgets{provider,band}`, `exprsn_cloud_budgets_stopped{provider}`, `exprsn_cloud_budget_spend_source{provider,source}` | Accounts by band of actual spend, with the hard stop engaged, and by where their spend came from (billing or estimate) |
| `exprsn_cloud_budget_alerts_total{basis,threshold}`, `exprsn_cloud_cost_ingests_total{provider,outcome}` | Budget alerts sent; billing cost fetches (`cloud.costs.ingest`) by outcome |
| `exprsn_cloud_gpu_nodes{provider,state}`, `exprsn_cloud_gpu_idle_seconds_total{provider}` | GPU nodes provisioned, the node groups' minimum, joined, idle; idle node-seconds |
| `exprsn_cloud_autoscale_total{direction,reason,outcome}`, `exprsn_cloud_interruptions_total{provider,kind}` | GPU pool scale decisions (up or down; idle, queue, cold, manual, interruption, fallback; applied, refused, failed) and spot interruption notices (Sprint 60) |
| `exprsn_cloud_gpu_saved_hours{provider}`, `exprsn_cloud_gpu_savings{provider,currency}` | GPU node-hours avoided by idle scale-downs this month and their estimated saving at the on-demand price (B-10605) |
| `exprsn_cloud_anomalies_total{provider}`, `exprsn_cloud_anomalies_open{provider}` | Spend anomalies detected, and those still open from the last 7 days (B-10606, [Anomalies](#anomalies-and-the-cloud-spend-screen-b-10606-b-10607)) |

Budget gauges come from the last budget evaluation on the instance (the `cloud.budgets.check` job and every apply);
the database gauges are read at each scrape on every instance, so rules and panels take `max without (instance)`.

**GPU idle time**: *provisioned* is a GPU node group's current size as the provider reports it (its desired size
until then) plus every GPU VM not stopped or deleted; *joined* (since Sprint 60, B-10401) is a node that enrolled
itself into its GPU pool's gateway pool and whose instance is active and healthy: a node group's enrolled instances
through its link (`cloud_gpu_pool_links`, at most the group's provisioned count), and a GPU VM whose private address is
the host of an active, healthy gateway pool instance (an enrolled VM's instance is on its private address); *idle* =
provisioned − joined. The idle counter adds idle × the seconds since the previous scrape. See "GPU pools" below.

Dashboard `deploy/observability/grafana/exprsn-ai-cloud.json` (operations, applies, provider calls and throttling,
drift, budgets, GPU nodes); rules and alerts `deploy/observability/prometheus/exprsn-ai-cloud.rules.yml` with unit
tests in `exprsn-ai-cloud.rules.test.yml`; what each alert means in `docs/runbooks/alerts.md`.

### Security

The cloud plane's threat model, the metadata endpoints every egress check refuses, IMDSv2 on what Exprsn-AI builds
(EC2 instances, and EKS node groups through a launch template since Sprint 59) and the least-privilege policies the
setup helper generates from the feature lists are in `docs/security.md` ("The cloud plane"). The setup helper also
renders an Azure custom role (`exprsn-role.json`) with exactly the deploy, data and compute actions, for the managed
resource group in place of Contributor.

## Cloud model backends (B-105)

1.9.99-final, Sprint 60. Cloud model APIs are gateway model servers (B-43's `ModelServer`), so profiles, fallback,
guardrail checkpoints, metering and the `/v1` API above them do not change. Nothing changes until someone registers a
cloud model server and imports a model. Routes are in [api.md](api.md).

### Amazon Bedrock (B-10501)

A pool instance of `kind: bedrock` names an AWS account and a region (`settings.cloud: {provider: aws, accountId,
region}`); registering it checks the region with `assertRegionAllows` against the pool's label ceiling (a pool above
the region's ceiling is refused). Code: `gateway/bedrock-server.ts` (`BedrockServer`, the mapping) over
`cloud/bedrock.ts` (`s.cloud.bedrock`: the calls, the residency guard, the AWS lister) and `cloud/aws-event-stream.ts`
(the event-stream decoder).

- **Calls.** `ListFoundationModels`, `ListInferenceProfiles` and `GetFoundationModelAvailability` on
  `bedrock.<region>.amazonaws.com`; `Converse`, `ConverseStream` and `InvokeModel` on
  `bedrock-runtime.<region>.amazonaws.com`. Each is signed with SigV4 (service `bedrock`, the instance's region) with
  the account's `read` credential (`s.cloud.credentials.for(account, 'read')`: a federated session's key and token, or
  the vaulted key) and sent through the cloud transport: the egress guard, the shared rate limiter (API class `read`),
  the breaker and the retries of throttling. A model id's `:` is encoded on the wire and the canonical path is encoded
  twice, as AWS asks of every service but S3. The IAM actions are the `models` feature's in
  `providers/capabilities.ts` (`bedrock:InvokeModel` covers Converse and InvokeModel,
  `bedrock:InvokeModelWithResponseStream` ConverseStream); the read role's policy carries them.
- **Mapping.** System messages become `system`; user text and images, assistant text and tool calls (`toolUse`), tool
  results (`toolResult`, paired in order with the calls before them, Bedrock's `toolUseId` kept as the call id) become
  alternating turns; tools become `toolConfig` (also when a conversation carries tool turns and the round offers none);
  `temperature`, `top_p`, `num_predict` and `stop` become `inferenceConfig`. Other options, `think`, `format` and
  `keep_alive` are not sent and are recorded once as a `dropped` model event.
- **Streaming.** Chat uses ConverseStream, read as it arrives (the transport's `stream` mode over `guardedStream`) and
  decoded frame by frame (prelude and message CRC32 checked; a frame cut short, a bad CRC or an oversized frame fails
  the turn, never a partial message). Text deltas are chunks, reasoning deltas are `thinking`, tool use arrives as one
  `tool_calls` chunk, `messageStop` gives the done reason (`max_tokens` is `length`), `metadata.usage` the token
  counts the turn is metered with. An exception event mid-stream (`throttlingException`, `modelStreamErrorException`)
  fails the turn with the provider's status. A model whose ConverseStream refuses the request (no tool use when
  streaming) is served by Converse from then on.
- **Embeddings** through InvokeModel: Amazon Titan (`amazon.titan-embed-*`, one text a call) and Cohere
  (`cohere.embed-*`, up to 96 texts), token counts from the body or `X-Amzn-Bedrock-Input-Token-Count`.
- **Listing.** On-demand foundation models and active system inference profiles, cached for five minutes; the poller's
  `version()` is `bedrock <region>`. Bedrock holds its models: no pull, load, unload or delete; placements are warm.
- **Inference profiles and residency.** A profile is recorded with the regions it may route to (its models' ARNs).
  Before every call the server checks that each of the model's routing regions (its catalogue entry's, else the
  profile's own, else the instance's region) is on the account's allow-list and admits the model's label
  (`checkRegion`: ceiling and residency); a global profile is always refused. The check is kept for thirty seconds per
  model, so a region removed from the allow-list stops the model within that time.

### Azure OpenAI, DigitalOcean GenAI and Workers AI (B-10502, B-10503, B-10509)

These speak Chat Completions, so each is a `kind: openai` instance (B-4302's `OpenAIServer`) with a **flavour** in
`settings.cloud` (`{provider, accountId, region, flavour, auth, apiVersion?, resourceId?}`), given as `cloud` when the
instance is registered (`POST /api/admin/pools/:id/instances`). Registration checks that the account is the
flavour's provider and that the region admits the pool's label ceiling (`assertRegionAllows`, use `models`); an
instance without a flavour behaves exactly as before. Code: `gateway/openai-server.ts` (the flavours),
`gateway/provider-filter.ts` (content filters), `cloud/model-backends.ts` (`s.cloud.modelBackends`: credentials,
Azure deployments, filter decisions, neurons, agents as tools), `routes/admin/cloud-models.ts`.

| Flavour | URL | Paths | Authentication |
| --- | --- | --- | --- |
| `azure` | the resource endpoint (`https://<resource>.openai.azure.com`, `.cognitiveservices.azure.com` or `.services.ai.azure.com`) | `/openai/deployments/<deployment>/chat/completions?api-version=<v>` and `.../embeddings`; `apiVersion` defaults to `2024-10-21` | `auth: account` (default): an Entra token for the Cognitive Services scope from the account's credential (federated or a vaulted client secret), asked for every request (the credential source caches and refreshes it). `auth: key`: the resource's API key from the vault (the instance's `token`/`tokenRef`), sent as `api-key` |
| `digitalocean` | `https://inference.do-ai.run` (default) | `/v1/models`, `/v1/chat/completions`, `/v1/embeddings` | a model access key from the vault (`token`/`tokenRef`, required) as a bearer token |
| `workers-ai` | `https://api.cloudflare.com/client/v4/accounts/<cloudflareAccountId>/ai` (default) | `/v1/chat/completions`, `/v1/embeddings`; models from `/models/search` (text generation and embeddings) | the account's scoped token ("Workers AI Read") as a bearer token, or the instance's own token (`auth: key`) |

Cloud endpoints are never asked for `/health` or `/props`; `version()` is `azure-openai <api-version>`, `do-genai` or
`workers-ai`, and the model list is kept five minutes between polls. An **Azure instance's models are its
deployments**, listed through ARM (`Microsoft.CognitiveServices/accounts/<account>/deployments`, API
`2024-10-01`) with the account's ARM token through the Azure transport: the account named by `resourceId`, else the
Cognitive Services account whose endpoint is the instance's URL. A deployment not `Succeeded` is listed as
unavailable. The deployment name is what a catalogue entry (and so a request's `model`) names.

**Content filter (Azure).** Azure AI Content Safety's verdicts become `ProviderFiltered` errors: a prompt it filters
(`400`, `error.code: content_filter`, categories in `innererror.content_filter_result`) at stage `prompt`, and a
completion that ends with `finish_reason: content_filter` (the choice's `content_filter_results`, the last chunk's
when streamed, after the text that had passed) at stage `completion`. The lease client of a flavoured instance
reports it, and `GuardrailEngine.recordProvider` records a guardrail decision: checkpoint `user-input` (prompt) or
`model-output` (completion), action `block`, one finding per filtered category (`provider:azure:<category>`, rule
name "Azure content filter", detail `hate (severity high)`, `jailbreak (detected)`, `blocklist:<id>`), `meta`
`{provider, providerStage, categories, instance, model, profileId}`, the inspected text (the prompt, or the partial
answer) sealed as for every decision, source `model-instance`. The turn fails with the filter's message; the
fallback chain does not retry a provider's block. Exprsn-AI's own checkpoints run before and after as always, and no
provider verdict relaxes them. A lease without a profile (an embedding, a guard model) is not attributed to a tenant,
and a borrowed slot (Sprint 26a) is not wrapped: neither records a decision.

**Agents as tools (DigitalOcean).** `POST /api/admin/cloud/accounts/:id/agent-tools` (`cloud:read` and
`tools:manage`) makes a draft registry tool from one of the account's GenAI agents (`GET /v2/gen-ai/agents`): `impl:
cloud-agent`, side effect `read`, input `{prompt}`, the agent's endpoint and a vault reference to its access key
(never a value; the caller must be able to read it) in the definition. It is published like any tool. A call goes
through the dispatcher as every tool does (schema, ceiling, rate, the `tool-call` checkpoint with `meta.impl:
cloud-agent`, approval, the context and `untrusted-content` checkpoints on the answer); only then is
`<endpoint>/api/v1/chat/completions` called with the key, resolved as the entry's owner, through the DigitalOcean
transport.

**Neurons (Workers AI).** At metering, a record whose pool holds a Workers AI instance and whose model is in the
price sheet's `workersAi` table gets `neurons` (input tokens × the model's neurons per million input tokens, output
and thinking tokens × its output rate), `cost_micros` (neurons × USD 0.011 per 1,000), `currency` and `price_id`
(`workers-ai:neurons@<sheet version>`) (migration `160_cloud_model_servers`; until it is applied
nothing is written). Other records keep them null; B-10505 prices every cloud model into the same columns. The daily
free allocation is not subtracted per record.

**Listing.** `s.cloud.modelCatalogue.listModels(account)` (the import's source, B-10504): Azure deployments of every
Cognitive Services account of kind `OpenAI` or `AIServices` (endpoint, model, version, SKU, capacity, state);
DigitalOcean models (`GET /v2/gen-ai/models`) and agents (`kind: agent`); Workers AI models with their task and
neuron rates.

**Egress.** `*.openai.azure.com`, `*.cognitiveservices.azure.com`, `*.services.ai.azure.com`, `inference.do-ai.run`
and `*.do-ai.run` are provider hosts in `CLOUD_PROVIDER_HOSTS`; Workers AI is `api.cloudflare.com`. In tests the
connect-time lookup the Chat Completions client uses refuses them too, so a cloud instance without its fake fails.

### The cloud catalogue import (B-10504)

`s.cloud.modelCatalogue` (`cloud/model-catalogue.ts`) lists what an account offers through the provider's lister:
Bedrock's (`s.cloud.bedrock.lister`: per allowed region, foundation models with their model access state, `granted`,
`pending` or `not_granted`, and inference profiles with their routing regions), and the Azure deployments,
DigitalOcean models and Workers AI models of B-10502, B-10503 and B-10509. `s.cloud.modelImport`
(`cloud/model-import.ts`, migration `159_cloud_models`) registers what is chosen as drafts:

| Draft field | Value |
| --- | --- |
| catalogue model | `format: server`, `name` = what requests name (the Bedrock model or profile id, the Azure deployment, the model id), `source` `cloud:<flavour>/<account>/<region>/<id>`, capabilities `completion` or `embedding`, `state: draft`, held by the instance serving the account (and region, for Bedrock) and placed warm on its pool when there is one |
| licence | the provider's terms (Bedrock: the AWS Service Terms and the model provider's EULA; Azure: the Microsoft Product Terms; DigitalOcean and Cloudflare their terms), recorded by the importer |
| `cloud_model_entries` | provider, account, region, `external_id`, flavour, offer (`foundation`, `inference_profile`, `deployment`, `model`), `routes_to`, `label_ceiling`, terms, `access_state`, details |
| label ceiling | the lowest effective ceiling of the regions it may route to, capped at `internal` (open decision 5) until a cloud admin attests the account's data terms for the entry (then `confidential`, B-10507; since Sprint 61 the listing's own `dataTermsAttested` raises nothing); never `restricted` |
| label | the requested label or the ceiling, whichever is lower |

Not registered: agents (registry tools, B-10503), models that are neither chat nor embedding, models without access,
profiles that may route outside the allow-list (global ones), a name already in the catalogue from elsewhere. A
re-import updates the entry in place (terms, access, routes, ceiling) and lowers a draft's label with a lowered
ceiling; it never creates a second draft. Drafts are reviewed as any server-held model (B-4304): evaluation on the
instance, a recorded licence, approval by someone else. `assertEntryAllows` refuses approving, or raising the label
of, a cloud model above its entry's ceiling or while a routing region does not admit its label.

### Tests and fakes

`server/test/fake-aws-bedrock.ts` (inside `fake-aws.ts`, for SigV4 scopes of service `bedrock`): the control plane,
Converse, ConverseStream encoded in the event-stream framing (its own CRC32 from `node:zlib`, sent in seven-byte
pieces so frames split across reads), InvokeModel for Titan and Cohere, Converse's own message rules, and a SigV4
verifier recomputing every signature from the key's secret. `bedrock-server.test.ts` and
`cloud-model-catalogue.test.ts` run against it; the real Bedrock hosts are refused in tests (`EXPRSN_TESTS_OFFLINE`).
`fake-azure-openai.ts` (an Azure OpenAI data plane with keys, Entra tokens, `api-version`, the content filter on
prompt and completion, and `seedArm` for its deployments in `fake-azure.ts`), `fake-do-genai.ts` (inside
`fake-do.ts`: serverless inference, agents and their endpoints) and `fake-workers-ai.ts` (inside
`fake-cloudflare.ts`), with the answers they share in `fake-cloud-models.ts` (plain and streamed, tool calls, usage):
`azure-openai-server.test.ts`, `do-genai.test.ts`, `workers-ai.test.ts` and `cloud-model-listing.test.ts`.

## Model pricing, provider guardrails and residency (B-10505 to B-10508)

1.9.99-final, Sprint 61. What a cloud model turn costs, the provider's own guardrail as an extra layer, and where a
cloud model may run. Nothing here changes an Ollama model or its metering, and nothing runs until a cloud model
server exists. Migration `163_cloud_model_prices` (versioned prices, attestations, `usage_records.cached_tokens`) holds them;
without it prices come from the price sheet and the APIs uncached, nothing can be attested and
cached tokens are priced as input tokens. Routes are in [api.md](api.md).

### Per-model prices (B-10505)

`s.cloud.modelPrices` (`cloud/model-prices.ts`) is the one pricer of every cloud model record (`s.quotas.pricer`;
Sprint 60's Workers AI neurons go through it unchanged). A price is a **version**: provider, region (`*` for every
region), the model as the provider prices it, currency, basis and the day it takes effect.

| Basis | What is priced |
| --- | --- |
| `tokens` | USD (or the account's currency) per million input, output and cached input tokens; thinking tokens as output; an embedding model's tokens as input |
| `neurons` | Workers AI: neurons per million input and output tokens and the price per 1,000 neurons |

| Source | Provider | How |
| --- | --- | --- |
| AWS Price List API | Bedrock | `GetProducts` for service codes `AmazonBedrock` (Amazon's, Meta's, Mistral's models) and `AmazonBedrockFoundationModels` (Anthropic's, Cohere's and other Marketplace sellers'), merged, filtered by `regionCode` and `model` (the listing's model name, e.g. `Claude 3 Haiku`; Titan text embeddings by `titanModel`), one product per token kind told apart by `inferenceType` (input, output, cache read; batch, provisioned, custom-model, flex, priority, latency-optimized, long-context, `global` and image, audio and video products left out); units `1K tokens`, `1M tokens` or per token. SigV4 for `pricing` in us-east-1 with the account's `billing` credential (`pricing:GetProducts`) |
| Azure Retail Prices API | Azure OpenAI / AI Foundry | `serviceName eq 'Foundry Models' and startswith(productName, 'Azure OpenAI') and armRegionName eq '<region>' and priceType eq 'Consumption'`, paged (`Azure OpenAI`, `... GPT5`, `... Reasoning`, `... Embedding`; the `Media` and fine-tuned products left out); the meters whose name is the deployment's model and not a longer model's (`gpt-4o` is not `gpt-4o-mini`), of the deployment's type (`Standard` regional: `regnl`, `regional`; `DataZoneStandard` data zone: `Data Zone`, `DZone`, `DZ`; `GlobalStandard` global: `glbl`, `global`), at the deployment's model version (`gpt 4o 1120` for `2024-11-20`; the latest named when none is known), as input, cached input (`cchd`, `cached`) or output; batch, provisioned and fine-tuning meters left out; `1K` and `1M` units. No credential |
| price sheet | DigitalOcean GenAI (no price API), Bedrock and Azure as a fallback | `price-sheet.json` `models.entries`, each with its `effective` day and source page |
| price sheet | Workers AI | the `workersAi` section (Sprint 60, checked 2026-10-20) |
| by hand | any | `PUT /api/admin/cloud/model-prices` (`finops:manage`), a version with its effective day |

API and hand-made versions are kept in `cloud_model_prices`, one row per provider, region, model, currency and day,
so a refresh that finds the same price again stores nothing. Prices are fetched only when asked:
`POST /api/admin/cloud/accounts/:id/model-prices/refresh` (the Models card's "Refresh prices") prices every entry of
an AWS or Azure account; DigitalOcean and Cloudflare answer that they have no price API. Nothing calls a price API at
metering.

**Effective dates.** The version that prices a record is the latest whose effective day is on or before the record's
day (a region's own version wins over `*`, an API or hand-made one over the sheet's on the same day). A new price
applies from its effective date only: earlier records keep their price, and a version dated earlier but added later
does not reprice anything after a later version took over.

**Unverified sheet entries.** An entry marked `"unverified": true` is shown on the Models card, flagged, and **never
prices a usage record**. The model entries were checked on 2026-10-21 (see the price check above): the Bedrock and
Azure ones (us-east-1 and Global Standard list prices, a fallback for a region the API has not priced) and
DigitalOcean's GPT-4o and GPT-4o mini price records; DigitalOcean's five retired models stay unverified, so a record of
one is metered with its tokens and no cost unless a version is recorded by hand.

**Metering.** A record whose pool holds a cloud instance (`kind: bedrock`, or `kind: openai` with a flavour) gets
`cost_micros`, `currency` and `price_id` (`aws-price-list:<id>`, `azure-retail-prices:<id>`, `manual:<id>`,
`sheet:<provider>/<model>@<day>`, or Sprint 60's `workers-ai:neurons@<sheet>`) and, for Workers AI, `neurons`. An Azure
deployment is priced as its model (the entry's `details.model.name`, else the deployment's reported model); a Bedrock
inference profile (`eu.`, `us.`, `apac.`...) at its model's price in the source region. Prompt-cache reads arrive as
`cached_prompt_tokens` on the done chunk (Bedrock's `cacheReadInputTokens`, Chat Completions'
`prompt_tokens_details.cached_tokens`), are metered as `usage_records.cached_tokens` and priced at the cached rate
(the input rate when the price has none); Bedrock's cache reads and writes count as prompt tokens, writes at the input
rate. Every other record is untouched: an Ollama record has no cost, currency, price id, neurons or cached tokens.

**Reports.** `GET /api/admin/usage/daily` gives each day's `cloudCostMicros` per currency, the sum of that day's
records' `cost_micros`; `GET /api/admin/usage/summary` gives `costMicros` per row; the analytics summary gives
`cloudCost` per row in currency units. Statement lines from these costs are the showback's (B-10604).

### Provider guardrails as an extra layer (B-10506)

A Bedrock instance may carry a Bedrock Guardrail (`settings.cloud.guardrail: {id, version, mode, enabled}`), set with
`PUT /api/admin/cloud/model-servers/:id/guardrail` (`cloud:admin`, `models:manage`; GetGuardrail confirms the version
exists in the instance's region first, so a typo never runs unguarded):

| Mode | What happens |
| --- | --- |
| `converse` | Converse and ConverseStream carry `guardrailConfig` (`trace: enabled`; streams `streamProcessingMode: sync`). An intervention ends with `stopReason: guardrail_intervened`; the trace's input or output assessments say which side fired |
| `apply` | ApplyGuardrail on the last user message before the call (a prompt it blocks never reaches the model) and on the answer after it |

An intervention is a `ProviderFiltered` error (provider `bedrock`), which the gateway's lease client records as a
guardrail decision through `GuardrailEngine.recordProvider`, as Sprint 60 does for Azure's content filter: checkpoint
`user-input` (prompt) or `model-output` (answer), action `block`, rule name "Bedrock Guardrail", one finding per policy
that fired (`provider:bedrock:topic:<name>`, `content:<type>` with its confidence, `word:custom`, `pii:<type>`,
`regex:<name>`, `grounding:<type>`), meta with the guardrail's id, version and mode, the inspected text sealed. The
matched text itself is never kept. The turn fails with the guardrail's message; the fallback chain does not retry it.

**Exprsn-AI's checkpoints stay authoritative.** The tenant's and the platform's rules run at `user-input` before the
model is called and at `model-output` after it, whatever the provider layer does: a prompt Exprsn-AI blocks never
reaches Bedrock or its guardrail, and an answer the guardrail lets through still meets the `model-output` rules.
Setting the guardrail `enabled: false`, or removing it, only stops `guardrailConfig` and ApplyGuardrail; no Exprsn-AI
rule, set or checkpoint is touched (`provider-guardrails.test.ts` runs the same rules with the guardrail on, off and
removed). Embeddings are not guarded on the provider side. IAM: `bedrock:ApplyGuardrail` (also what Converse with
`guardrailConfig` needs) and `bedrock:GetGuardrail`, under the `models` feature.

### Residency and egress (B-10507)

`s.cloud.modelResidency` (`cloud/model-residency.ts`). Each entry's **scope**:

| Scope | Which |
| --- | --- |
| regional | a Bedrock model id; an Azure `Standard` deployment |
| cross-region | a Bedrock inference profile (`eu.`, `us.`...; its regions from its models' ARNs); an Azure `DataZoneStandard` deployment |
| global | a Bedrock `global.` profile; an Azure `GlobalStandard` deployment; DigitalOcean's serverless endpoint (no region pinned); Workers AI (Cloudflare's edge) |

Before every chat or embedding call on a cloud instance, the gateway's lease client (`gateway/residency-client.ts`,
hook `gateway.cloudResidency`) checks the **request's own label** (not the model's): a cross-region or global model
serves nothing above `internal` (`403` step `zone`, check `residency`); the label must be within the entry's
ceiling; each region the entry may run in (its allowed regions: `routesTo`, shown on the card with whether each is
allowed) must be on the account's allow-list and admit the label, residency included (`checkRegion`). A Bedrock
global profile stays refused for every label, as before. So a `confidential` conversation is never routed to a
global (or cross-region) inference profile, whatever label the model carries. Decisions are kept 30 seconds per
instance, model and label.

**The egress zone.** Once zones are defined, a cloud model call leaves only from a pool in a zone whose egress
allow-list reaches outside (the external zone, or a `0.0.0.0/0` or `::/0` CIDR): a pool in a closed zone such as the
default `inference` zone is refused (`check: egress`). Put cloud model pools in an egress zone. Without zones nothing
changes. Every call also goes through the egress guard (provider hosts only, never a metadata address).

**Attestations (open decision 5).** `POST /api/admin/cloud/model-entries/:modelId/attestations` (`cloud:admin`)
states the account's data terms for one entry: no training on prompts and outputs (required), retention in days,
abuse monitoring (`off` or `standard`) and where the terms are stated. A second cloud admin approves it
(`POST /api/admin/cloud/attestations/:id/approve`; the proposer gets `403` `dual_control`); only then does the entry's
ceiling rise to `confidential`, bounded by its regions' ceilings and never `restricted`, and a re-import keeps it.
A cross-region or global entry cannot be attested (`409`): it stays at `internal`. Revoking
(`.../revoke`, any cloud admin) drops the ceiling back to `internal` and the model's label with it. Every step is
audited (`cloud.model.attestation.proposed`, `.approved`, `.rejected`, `.revoked`). Since Sprint 61 a listing's own
`dataTermsAttested` no longer raises anything.

### The Models screen (B-10508)

`web/js/screens/models.js` with `models-cloud.js`: a Provider column and filter (Ollama, model server, Bedrock, Azure
AI Foundry, DigitalOcean GenAI, Workers AI); "Cloud catalogue" (an account and region, what it offers with model
access and the ceiling, Import as a draft); on a cloud model's card the provider and account, region and routing
regions, the price in effect (source and effective date, unverified flagged; "Refresh prices", "Record a price"),
residency (scope, ceiling, the attestation and its actions), the provider guardrail layer ("Set guardrail") and AI
Gateway (B-10908's `settings.cloud.aiGateway`). `GET /api/admin/cloud/model-cards` feeds it. `e2e/tests/models-cloud.spec.ts` imports, evaluates and approves a Bedrock
model end to end against the e2e server's Bedrock fake.

### Tests

`cloud-model-pricing.test.ts` (each provider's prices with effective dates from the AWS Price List and Azure Retail
Prices fakes, the sheet and by hand; cached tokens; embeddings; neurons; the cost on every cloud record and none on
an Ollama one; a price change from its effective date only; the usage report's day cost), `provider-guardrails.test.ts`
(guardrailConfig and ApplyGuardrail against the Bedrock fake's guardrails; interventions as decisions; Exprsn-AI's
checkpoints with the guardrail on, off and removed) and `cloud-model-residency.test.ts` (allowed regions per entry;
cross-region and global refused above `internal`; attestation under dual control up to `confidential`, never
`restricted`; the egress zone). The fakes: `setBedrockPrice` in `fake-aws.ts`, `addOpenAiMeter` in `fake-azure.ts`,
`guardrails`, `applyCalls` and `cacheTokens` in `fake-aws-bedrock.ts`.

## GPU pools (B-10401, B-10404, B-10405)

1.9.99-final, Sprint 60. Code: `server/src/cloud/gpu-pools.ts` (`s.cloud.gpuPools`: the link model, `linkFor`,
`nodeGroupsFor`, `setDesired`), `cloud/gpu-enrol.ts` (`s.cloud.gpuPools.nodes`: links, enrolment, the gateway's client
identities, warm-up, reconcile, boot timings), `cloud/gpu-node.ts` (what a node runs at first boot),
`cloud/gpu-quotas.ts` (`s.cloud.gpuPools.quotas`, quotas and the capacity fallback); routes
`server/src/routes/admin/cloud-gpu-pools.ts` ([api.md](api.md)). Migration `157_cloud_gpu_pools`:
`cloud_gpu_pool_links`, `cloud_gpu_enrolments`, `cloud_gpu_boot_timings`. Without it nothing changes: deployments
with GPU pools apply as before, no link is made, and the routes answer `503` `migration_pending`. Nothing is read or
called until someone plans a GPU node group.

### Node groups and VMs as pools

A deployment spec's `gpuPools[]` render as before (an EKS managed node group, an AKS or DOKS GPU node pool, or GPU VMs
on EC2, Azure NC/ND/NV or DigitalOcean GPU Droplets), now with `capacity` (the allowed sizes and zones), `warmup` and
`gpuNode` (pool and DaemonSet images). New spec fields per pool: `fallbackTypes`, `zones`, `warmup` (`mirror`, the
default, or `snapshot` with `snapshotId`) and `images` (`ollama`, `proxy`, pinned by digest, for node groups).

After an apply of such a deployment succeeds, a follow-up makes per pool, once: the gateway pool `<deployment>-<pool>`
(accelerator cuda, the inference zone, the deployment's label as the ceiling), the link (provider id, instance type,
min / max / desired, the price per node hour from the price catalogue, warm-up, state), the deployment's two PKI
profiles under the tenant's active intermediate (`gpu-nodes-<deployment>`: server certificates for IP names inside the
deployment's network; `gpu-gateway-<deployment>`: the gateway's client certificate, an `exprsn-gpu://gateway/` URI
name), and the gateway's client identity for the pool (a P-256 key made on the server, sealed with the tenant key, held
in memory for the gateway). Without an active intermediate the link is `pki_missing` and no node can enrol. Verify (or
the Kubernetes release) runs as before.

Decision: GPU pools join the gateway of the install that planned them (this install), which reaches the nodes'
private addresses over the network the operator provides (peering, VPN, or the data network); the deployed app does not
take them over.

### Enrolment: a single-use token for a certificate

| Shape | Where the token is | Bound to |
| --- | --- | --- |
| GPU VM | the user data: `@@EXPRSN_ENROL:<pool>:<key>@@` is replaced at create time by the secret broker (`enrol`), never in the graph | the VM's graph key |
| Node group | the Secret `exprsn-enrol` in namespace `exprsn-gpu`, one key per node, written by the reconcile job (`cloud.gpu.reconcile`, every minute while any link exists) from the cluster's nodes labelled `exprsn.ai/node-group` | the node's name and its InternalIP |

A token is `exe1_` and 32 random bytes; only its SHA-256 is kept; it lives 30 minutes. The node's bootstrap makes its
own key and CSR (the key never leaves the node) and posts `{ token, csr, address, node, port, bootedAt }` to
`POST /cloud/gpu/v1/enrol` (outside `/api`; the token is the credential). The token is spent in one conditional update
(two nodes cannot both use it); a used, expired or unknown token, another node's token, an address other than the
bound one or outside the deployment's network, and an unreadable CSR are refused (`401`/`400`, `why`) and audited
(`cloud.gpu.node.refused`). The node gets a server certificate naming exactly its address, the CA chain and the gateway
client certificate's SHA-1; it registers as an instance of the pool (`deploy: cloud`, `https://<address>:11435`,
`tls.identity` the pool's client identity, `tls.pinSha256` its own certificate). The gateway connects with that client
certificate and trusts the node by the CA chain and the pinned certificate; the node's nginx accepts only the
gateway's certificate (CA and fingerprint). Re-enrolling a node (a replacement) updates its instance in place. An
operator can mint a token by hand for a VM set up as in [ollama-node.md](../deploy/baremetal/ollama-node.md)
(`POST /api/admin/cloud/gpu-pools/:id/enrolments`, shown once).

### Warm-up from the mirror (B-10404)

The enrolment answer lists the pool's approved placements as references on the model mirror (Platform › Mirrors, kind
`models`): `<mirror host>/library/<model>`. A reference that is not on the mirror is never listed, and the node's
bootstrap refuses it too (`mirror_ok`, the rule `mirrorRefProblem` applies); its egress guard (nftables) admits only
DNS, the enrolment host and the mirror. With `warmup.source: snapshot` the node mounts the pre-seeded volume (`LABEL=
exprsn-models`; EC2 attaches it from `snapshotId`) and pulls only what is missing. Boot to healthy is a row per node:
booted (the node's boot time, clamped to its token's life), enrolled, and healthy (the gateway first saw the instance
healthy with every approved placement listed); `GET /api/admin/cloud/gpu-pools` shows the last and median per pool.

### Quotas and capacity (B-10405)

A plan that creates or grows a GPU node group or VM reads the quota (only such a plan) and is refused, not applicable,
with a blocker naming the quota, the requested and available numbers, the limit, what is in use, and where to ask for
more: AWS Service Quotas (`L-DB2E81BA` Running On-Demand G and VT instances, `L-417A185B` P instances, vCPUs; in use from
`DescribeInstances`), the Azure region's compute usages (the VM family's vCPUs), the DigitalOcean droplet limit against
the account's droplets (GPU Droplet access itself is granted per team and refused at create). A quota that cannot be
read leaves a note on the plan and the provider decides. A create refused for capacity (InsufficientInstanceCapacity,
SkuNotAvailable, ZonalAllocationFailed, …) is tried with the next allowed type, then zone, each with its own idempotency
key, audited `cloud.gpu.capacity.fallback`; a size in `capacity.sizes` satisfies the plan, so the fallback is not drift.
New permissions in the generated policies: `servicequotas:GetServiceQuota`, `Microsoft.Compute/locations/usages/read`.

Tests: `server/test/cloud-gpu-pools.test.ts` (node groups on each fake with the nodes played in-process by
`fake-gpu-node.ts` behind their own mTLS proxy and a fake Ollama; GPU VMs on each fake; tokens; warm-up; timings;
quotas; capacity; the metrics). Known gaps: the gateway's own `model.pull` on a cloud instance pulls by the model's
name (the node's egress guard refuses it unless it is on the mirror); EKS capacity failures that surface only later as
node group health issues are not retried; AKS and DigitalOcean do not attach a snapshot volume yet.

## Autoscale, spot and savings (B-10402, B-10403, B-10406, B-10605)

Sprint 60 lets the gateway, which sees every slot lease and queue, size the cloud GPU node groups that serve its
pools (`server/src/cloud/autoscale.ts`, `s.cloud.autoscale`; migration `158_cloud_autoscale`).
Without the migration nothing changes: cloud pools are served as before, with no autoscale, cold-start wait or savings.
Pools with no scale policy, and every on-prem pool, behave exactly as before; only pools in `Gateway.cloudPools` get
the cold-start wait and preemptible leases.

### The scale policy

One row of `cloud_scale_policies` per pool: `min`, `max` and `desired` nodes; `idleMinutes` (15); `queueDepth` (2
waiting requests per node add a node); the longest cold wait (10 minutes); `capacity` (`on_demand`, or `spot` with
`onDemandFallback`); which capacity serves now; how many nodes run on the on-demand sibling; and the last slot lease
any server saw. The node group is the GPU pools link's (`s.cloud.gpuPools.linkFor`, B-10401), else the policy's
`deploymentId` and `resourceKey`; `max` may not exceed the deployment spec's. `s.cloud.gpuPools.setDesired` scales
through here.

A size change is the adapter's `update` of the node group with `count` set (and `gatewayScaled`, so an AKS agent pool
runs no cluster autoscaler of its own), its own min and max kept, journaled as an `update` step of the deployment and
audited as `cloud.pool.scaled` with the provider's request id. GPU VM pools still scale by plan.

### Scale-to-zero and scale-up

`tick` runs every 30 s on every server (`index.ts`; tests call it):

- **Shared lease times.** Each server writes its own last lease (now, while anything runs, queues or waits for a cold
  start in the pool) into the policy row, so the idle decision sees every server.
- **Scale down to the minimum** when no server has had a lease for `idleMinutes` (counted from the last lease or the
  last scale, whichever is later). With `min: 0` that is scale-to-zero.
- **Scale up by one node** when waiting requests (queued plus cold waiters) reach `queueDepth` × the nodes, up to
  `max`, and no scale-up is still booting.
- **Healthy scale-ups**: a scale-up whose pool has a healthy instance gets `healthy_at`, the boot-to-healthy timing.

### Cold starts in the gateway

When `Gateway.acquire` finds no healthy instance for a request, it asks `cloudHooks.coldStart` (only for pools in
`cloudPools`; every other pool answers `503 No capacity` as before). The autoscaler scales the node group to at least
one node (or reports the scale-up already booting) and answers the estimate: the median of the pool's last ten
boot-to-healthy timings (GPU pools' `cloud_gpu_boot_timings`, B-10404, else the scale events' own; four minutes with
none). `Gateway.awaitCold` then:

- takes the **fallback**: when the caller allows a bounded wait (a profile with a fallback: `afterQueueWaitMs`) and the
  estimate exceeds it, it ends at once with `QueueTimeout`, so chat, `/v1`, `acquireFollowing` and `runFollowing` go to
  the fallback profile; the node is still started for the next request;
- **waits in the queue** otherwise (position 1 on `chat.status`), polling until an instance answers healthy, up to the
  pool's longest cold wait, then `QueueTimeout`;
- **refuses** when no node can start (the hard stop, a provider error): a queue timeout with a fallback, else `503`
  with `reason: cold_start_refused` and why.

So a chat on a scaled-to-zero pool answers after the cold start or from the fallback profile, never failing for lack
of capacity while a node can start.

### Budgets

Open decision 10, through `CloudBudgets.decideScale`: a scale-up (desired above the current size, so above the
minimum) adds cost; past the account's hard stop without an active override it is refused (`409 budget_exceeded` from
Pools, `cloud.pool.scale.refused` and a `refused` scale event from the autoscaler, `cold_start_refused` for a cold
start). A scale-down is always allowed.

### Spot and interruptions

- A GPU pool with `purchase: spot` in the deployment spec renders its node group with spot capacity (EKS
  `capacityType: SPOT`; AKS `scaleSetPriority: Spot`, eviction `Delete`, `spotMaxPrice: -1`) and an on-demand sibling
  `gpu-<pool>-od` (minimum 0). DigitalOcean offers on-demand only: the spec check refuses `purchase: spot` there
  (`offer`), and so does the policy (`spot_unavailable`). The estimate prices spot nodes at the on-demand price.
- **On-demand fallback**: a scale-up the spot group cannot take (`InsufficientInstanceCapacity`, `SkuNotAvailable` and
  the like) grows the sibling instead (`cloud.pool.capacity.fallback`); scale-downs shrink the sibling first, and the
  pool returns to spot once it is empty.
- **Interruption notices**: the node's watcher posts the EC2 two-minute notice (`ec2_interruption`, from
  `spot/instance-action`), the EC2 rebalance recommendation (`ec2_rebalance`) or Azure Scheduled Events `Preempt`
  (`azure_preempt`, `NotBefore` as `reclaimAt`) to `POST /cloud/v1/nodes/interruptions` with its Exprsn-AI CA
  certificate (mTLS). The notice is recorded once (`cloud_interruptions`, unique per instance, kind and event) and the
  instance drains through `Gateway.preempt`: it is marked `draining`, so no new lease is placed there; requests waiting
  for its slots go back to picking another instance (or a cold start) instead of failing; running leases may finish
  until 20 s before the reclaim, and those still running are moved: their `preempted` signal aborts with `Preempted`,
  their calls end, and a chat answer becomes `interrupted` and continues from its stored text on another instance
  (`ChatService.continue`). A rebalance recommendation drains without a deadline (up to ten minutes). For a reclaim
  the pool asks for a replacement node at once (on demand when it falls back), under the budget's hard stop.
- What drains on another server process: the instance's `draining` state reaches every server at its next poll; only
  the server that took the notice moves running leases.

### The Pools card (B-10406)

`web/js/screens/pools-cloud.js` (`App.poolsCloud`) draws a "Cloud node group" card in each cloud pool's panel: the
provider, region and node size; nodes asked and healthy with min and max; cost per hour (desired × the on-demand price);
the idle timer ("Scales to 0 in 12 min without a lease"); the spot state; the cold-start estimate; this month's saving;
the last scale events and open interruption notices. "Size and policy" edits min, max, desired, idle minutes, queue
depth and capacity; "Scale to zero" confirms and scales. Both are audited.

### Idle GPU savings (B-10605)

Every idle (or manual) scale-down opens an interval in `cloud_gpu_savings` with the nodes it took away and the node
SKU; the next scale-up closes it. `savings(month)` sums each pool's scaled-down node-hours in the UTC month (an open
interval up to now) and multiplies them by the on-demand hourly price: the GPU pools link's `priceHourly`, else the
price catalogue's (`cloud/prices.ts`, cache and sheet, no API call). `GET /api/admin/cloud/gpu-savings` and the gauges
`exprsn_cloud_gpu_saved_hours` and `exprsn_cloud_gpu_savings` read it.

### Tests

`server/test/cloud-autoscale.test.ts` (scale to zero after the idle minutes, never during a lease; a chat on a
scaled-to-zero pool answering after the cold start, and from the fallback when the estimate exceeds the wait; scale-up
on queue depth; min and max; the Pools routes, audited; the hard stop refusing scale-ups and allowing scale-downs; the
missing migration), `cloud-spot.test.ts` (EC2 notice and rebalance, Azure `Preempt`: drained before the reclaim,
leases moved at the deadline, a streaming chat answer resuming on another instance, the node certificate, on-demand
fallback, DigitalOcean on-demand only) and `cloud-gpu-savings.test.ts` (savings = scaled-down hours × on-demand
price), over `cloud-autoscale-helpers.ts`: an in-memory provider per cloud and the fake Ollama as the "node". The
console: `e2e/tests/pools-cloud.spec.ts` (the card, scale to zero, audited; axe and reflow). No test reaches a cloud.

## Cloudflare front door (B-10901 to B-10904)

Sprint 61. Code: `server/src/cloud/edge.ts` (`s.cloud.edge`), `cloud/edge-waf.ts` (the WAF render and the simulated
edge), `server/src/http/client-address.ts` (`CF-Connecting-IP`), `http/cloudflare-ips.ts` (Cloudflare's ranges),
`http/cloudflare-access.ts` (the server's Access check), routes `server/src/routes/admin/cloud-edge.ts`
([api.md](api.md)), the CLI `exprsn-ai cloud:tunnel-token` (`server/src/cli/cloud-edge.ts`), and the shipped
`deploy/helm/exprsn-ai/templates/cloudflared.yaml`, `deploy/baremetal/exprsn-cloudflared.service` and
`deploy/docker/compose.tunnel.yml`. Migration `161_cloud_edge` (without it the routes answer 503
`migration_pending` and nothing else changes).

A **front door** is one hostname in a Cloudflare zone on a platform Cloudflare account (the `frontdoor` feature's
token: Zone Read, DNS Write, Cloudflare Tunnel Write, SSL and Certificates Write, Zone WAF Write and, since Sprint 62,
Account Settings Read for the audit logs the change trail reads; Access needs Access:
Apps and Policies Write and Access: Organizations, Identity Providers, and Groups Write), in front of a cloud
deployment (`deploymentId`) or of an install without one: this install, or an on-prem Compose, bare-metal or Helm one.
Its origin is a **tunnel** (`origin.kind: tunnel`, the address the connector reaches the app at) or a **public**
origin (`origin.kind: public`, an address that keeps serving its own certificate). Cloudflare's edge sees decrypted
traffic, so a deployment behind it holds at most `confidential` (open decision 5; a `restricted` deployment is
refused, and the deployment spec's `cloudflare` front door checks the same cap).

### DNS and edge TLS, as an alternative to ACME (B-10901)

`POST /admin/cloud/edge/:id/apply` runs, in order, and stops before anything later changes when a step fails (each
step's result is kept on the front door and audited `cloud.edge.applied` or `cloud.edge.apply.failed`):

1. **Edge certificate**: an active certificate pack covering the name (the zone's Universal certificate, or an
   advanced one). While it is pending nothing is changed (`409 edge_certificate_pending`).
2. **SSL**: Full (strict), minimum TLS 1.2, always HTTPS.
3. **Origin certificate** (public origin): a TLS handshake with the name as SNI must verify, as Full (strict) will
   (`409 origin_certificate` otherwise).
4. **Tunnel** (tunnel origin, B-10902 below).
5. **DNS, switched with no gap.** A name that answered DNS-only (the ACME setup) is switched in place: each of its A,
   AAAA or CNAME records becomes proxied first with its content unchanged, so the origin and its ACME certificate keep
   serving Full (strict); extra records go only while a proxied one remains; the last is then pointed at the tunnel
   (`<tunnel>.cfargotunnel.com`, a CNAME behind the proxy, invisible to clients). The name never lacks a record and
   never serves without a certificate. The front door remembers `switchedFrom: acme`. A name without a record gets a
   proxied one. ACME renewals of a public origin keep working: `/.well-known/acme-challenge/` passes the edge and is
   never behind Access.
6. **WAF** (B-10903 below).

Applying again changes nothing that is already right.

**The client address.** `TRUST_PROXY` keeps Express's meaning; the keyword `cloudflare` in its list
(`loopback,cloudflare`, `uniquelocal,cloudflare`; never with `true`) turns on:

- Express also trusts Cloudflare's published ranges and the tunnel's connector (`CLOUDFLARE_TUNNEL_PEERS`, empty
  by default since the B-10803 review: name the connector's address, as the rendered systemd, Compose and Helm settings
  do; a peer that is also a local proxy, such as nginx on loopback, would pass on any client's `CF-Connecting-IP`), so
  `X-Forwarded-Proto` from them counts.
- `CF-Connecting-IP` is the client address (`req.ip`, so the throttles, audit and share-link limits see the client)
  only when the socket's peer is the tunnel connector or a Cloudflare address, or the socket's peer is a local proxy the
  rest of `TRUST_PROXY` trusts and the hop it saw (the right end of `X-Forwarded-For`) is a Cloudflare address. The
  connector counts only as the socket's own peer, never as a forwarded hop a client could write.
- From anyone else the header is **dropped** from the request, so nothing later reads a spoofed value.

Without `cloudflare` in `TRUST_PROXY` nothing is installed and no Cloudflare header is read: an install not behind
Cloudflare behaves exactly as before.

**Cloudflare's ranges** are a maintained list shipped as data (`http/cloudflare-ips.ts`, with the day it was last
compared with Cloudflare's publication); nothing fetches them at start or in tests, and the suite fails when the date
is more than 180 days old. `GET /admin/cloud/edge/ranges?accountId=` compares the list with Cloudflare's API
(`GET /client/v4/ips`) through an account and names what was added or removed; `CLOUDFLARE_IP_RANGES` replaces the
list until a release carries the change.

### Cloudflare Tunnel (B-10902)

A **named tunnel** (`exprsn-<account>-edge-<name>`, remotely managed, found again by name) is created through the API.
Its token is read **once** into the vault (`vault:cloud/edge/<id>#tunnel_token`, platform scope, `restricted`); no
route, log or audit entry carries it, only its reference. Its ingress is set remotely: the name to the origin service
(with the name as the Host header) and a 404 catch-all. cloudflared forwards WebSocket upgrades on every rule, so
`/socket.io/` needs nothing more than reaching the app.

`cloudflared` runs **beside the app with no inbound port**; `GET /admin/cloud/edge/:id/install/:target` gives each
target's settings and steps, and `exprsn-ai cloud:tunnel-token --edge <name> --out <file>` writes the token from the
vault to a **new** file with mode 0600 (never over an existing one, never printed; audited
`cloud.edge.token.written`):

| Target | What runs it | No inbound port |
| --- | --- | --- |
| Helm | `cloudflared.enabled: true`: a Deployment of its own (2 replicas, the token mounted from `cloudflared.tokenSecret`, a Secret you create from the token file; never a value or an environment variable), its own NetworkPolicy (nothing in; out only DNS, the server pods and Cloudflare's tunnel edge on 7844 and 443) | the chart refuses `ingress.enabled` and a Service other than `ClusterIP` with the tunnel on; the server's ingress policy admits the connector's pods only; `config.trustProxy: uniquelocal,cloudflare` |
| Bare metal | `deploy/baremetal/exprsn-cloudflared.service` (`DynamicUser`, the token as the systemd credential `cloudflared_token`, `--token-file`) | the app on `HOST=127.0.0.1`; `TRUST_PROXY=loopback,cloudflare` |
| Compose | `deploy/docker/compose.tunnel.yml` on top of `compose.yml` (the token a Compose secret file) | the app's `ports: !reset []` (Compose 2.24 or later); the connector and the app alone on the `edge` network |

The image is `cloudflare/cloudflared:2025.8.1@sha256:b77d84e8704db38db22c22661cf7e56468c526e3a6a5fe9c8b7c151452fa1472`:
Cloudflare's release 2025.8.1 (2025-08-21), pinned by its multi-arch index digest from Docker Hub (checked 2026-10-21;
`cloudflared.image.tag` and `cloudflared.image.digest` in the chart, `CLOUDFLARED_IMAGE` in Compose; change them
together). `tunnel run --token-file` needs cloudflared 2025.4.0 or later
([run parameters](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/cloudflared-parameters/run-parameters/));
the bare-metal unit is `Type=notify`, as Cloudflare's own `cloudflared.service` is.

**Not yet:** the connector runs beside the app only. A Cloudflare app tier (B-10905) whose database is on another
provider or on-prem reaches it through Hyperdrive over a tunnel, but nothing renders or plans the `cloudflared` beside
the data tier yet; run it there by hand with the same unit, Compose file or chart (a known gap in
[security.md](security.md)).

### WAF and rate limits (B-10903)

The rules (`cloud/edge-waf.ts`) are rendered from the server's own limits and written to each phase's zone
entrypoint; rules this build did not write (any `ref` not starting `exprsn-`) stay where they were.

| Phase | Rules |
| --- | --- |
| `http_request_firewall_managed` | the Cloudflare Managed Ruleset (the Free Managed Ruleset on the free plan); from Pro also the OWASP Core Ruleset, skipped for model prompts (`POST` to `/v1/`, `/api/chat/`, `/api/conversations/`: code and SQL in a prompt are not attacks) |
| `http_request_firewall_custom` | `TRACE`, `TRACK`, `CONNECT` blocked; `waf.adminCidrs` an allow-list for `/api/admin/` |
| `http_ratelimit` | in this order, as many as the plan allows (free 1, Pro 2, Business 5): sign-in (`POST /api/auth/login`), `/api/auth` changes (30 a minute), `/v1` (600 a minute), `/api` (`API_RATE_PER_MINUTE`; not `/api/public/`), each per client address and data centre |
| `http_request_cache_settings` | no caching for `/api/`, `/v1/`, `/socket.io/` and the streaming paths |
| `http_config_settings` | `/socket.io/` and the streaming paths (`/v1/chat/completions`, `/v1/responses`, `/v1/completions`) exempt from what buffers or rewrites a response (email obfuscation, Rocket Loader, Mirage, HTTPS rewrites, server-side excludes) |

**Mirroring.** Each limit counts over the longest period the plan allows that is not longer than the server's window,
with the server's count, so the edge never refuses what the server would allow; sign-in is the exception: the edge
allows one attempt fewer than `LOCKOUT_MAX_ATTEMPTS` and blocks for the lockout window (or the plan's longest block),
so a burst of guesses stops at the edge before the server's failed-sign-in throttle has counted enough of them to lock
the account. The server's own limiters stay in force behind the edge. A limit the plan has no room for is named in
the render (`mirrored[].edge: null`) and left to the server. The render is in `GET /admin/cloud/edge/:id` (`waf`).

### Cloudflare Access in front of the console (B-10904, optional)

`PUT /admin/cloud/edge/:id/access` makes the Access applications on the Cloudflare account:

- **Identity provider**: Exprsn-AI's own OIDC provider (open decision 20's assumption): give a confidential OIDC client
  registered under Federation with the redirect address `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`
  and the scopes `openid` and `email`, and its secret (checked against the client, passed to Cloudflare, never
  stored); or an identity provider already on the Cloudflare account (the tenant's IdP, `idp.kind: cloudflare`).
- **Scope `admin`** (the only one offered with Exprsn-AI's own provider, whose sign-in page is this console): one
  application on `<host>/api/admin` and `<host>/admin`; admins open `https://<host>/admin` first. Nothing else is
  covered, so `/v1`, the OIDC and SAML endpoints, `/.well-known/`, the ACME challenge, webhooks and public share links
  never meet Access.
- **Scope `host`**: one application on the whole name and a **bypass** application for the exclusions
  (`ACCESS_EXCLUSIONS`): `/v1`, `/oauth`, `/t` (tenant issuers), `/saml`, `/federation`, `/.well-known` and
  `/.well-known/acme-challenge`, `/device`, `/auth/negotiate`, `/hooks`, `/webhooks`, `/billing/stripe/webhook`,
  `/api/public`, `/shared` (anonymous share links then open at `/shared/#/shared?t=...`) and the console's static
  files the share page loads, `/embed`, `/forms`, `/app-subscriptions`, `/calendar/feeds`, `/scim`, `/dav`, `/xrpc`,
  `/atproto`, `/mcp`, `/pki`, `/cloud-issuer`, `/cloud`, `/trainer`, `/plugin-broker`, `/healthz`, `/readyz`.
- The policy allows `allowedEmails` and `allowedDomains`, or everyone the identity provider signs in.

**The server's own check** (optional, an extra condition): with `CLOUDFLARE_ACCESS_AUD` (the audience tag the route
answers) and `CLOUDFLARE_ACCESS_TEAM_DOMAIN`, a path the scope (`CLOUDFLARE_ACCESS_SCOPE`) protects also needs a valid
`Cf-Access-Jwt-Assertion`: RS256, the team's issuer, the audience, within its lifetime, signed by a key from the team's
`/cdn-cgi/access/certs` (fetched through the egress guard, cached for an hour, fetched again for an unknown key at
most once a minute). Without one the answer is `403 access_required`. A valid token never signs anyone in: the session
is still required (Exprsn-AI's identity stays authoritative), and a path Access does not protect is never asked for
one. WebSocket handshakes are not checked by it (the socket's session check stays).

### Tests

`server/test/cloudflare-front-door.test.ts` (the trust of `CF-Connecting-IP` from the ranges, the tunnel and through a
local proxy, a spoofed header ignored and dropped, nothing read without `cloudflare`; the ranges' date and the API
comparison; a pending edge certificate and a refused origin certificate changing nothing; switches from ACME to a
public origin and to a tunnel with the name never dark), `server/test/cloudflare-tunnel.test.ts` (the tunnel created
and found by name, the token in the vault only and in a 0600 file, the ingress, Socket.io over WebSocket through a
stand-in connector following the tunnel's ingress, the chart rendered with `ci/tunnel-values.yaml` by the pinned helm
when `HELM_BIN` is set, the systemd unit and the Compose file) and `server/test/cloudflare-waf-access.test.ts` (rules
mirroring the limits per plan and checked by the fake against the zone's plan, rules of others kept, a sign-in burst
stopped by the simulated edge before the server's throttle locks the account, `/socket.io/` and streams unbuffered,
Access with both identity providers and every exclusion, and the server's token check), all against
`fake-cloudflare.ts` with `fake-cloudflare-edge.ts`. No test reaches Cloudflare.

## On-prem front doors (B-10209)

Sprint 62. Code: `server/src/cloud/onprem.ts`; the wizard's routes in `routes/admin/cloud-deployment-specs.ts` take it
(`validate-spec` and `POST /api/admin/cloud/deployments` with `kind: onprem`); `?kind=onprem|cloud` on the deployments
list. No migration of its own (148 and 161).

An existing install (Compose, bare metal or Helm) is registered as a deployment **without compute**, so the front door,
drift and spend apply to it:

```json
{ "kind": "onprem", "name": "plant-a", "label": "internal",
  "install": { "kind": "compose", "service": "http://app:8080" },
  "frontDoor": { "kind": "cloudflare", "accountId": "<platform Cloudflare account>", "hostname": "ai.example.com", "zone": "example.com", "plan": "free" } }
```

- `install.kind` is `compose`, `baremetal` or `helm`; `install.service` is where the tunnel's connector reaches the
  app, by default `http://app:8080` (the shipped Compose file), `http://127.0.0.1:8080` (bare metal) or
  `http://exprsn-ai.exprsn-ai.svc:80` (the chart). `compute.shape` is always `none` (any other is refused).
- Validation, before anything exists or is called: the Cloudflare account (visible, platform scope, `global` region,
  validated with the `frontdoor` feature), the name in its zone, the label at most `confidential` (403 above), the
  name free as a deployment and as a front door; a front door already made for this name without a deployment (same
  account, tunnel origin) is attached instead of refused. Creating one also creates its front door, so it needs
  `cloud:admin` besides `cloud:deploy` and `platform:manage`, and a recent sign-in.
- The render has no network, compute or data tier (`resources: []`); its `frontDoor` lists the tunnel and the proxied
  record. The deployment lives on the Cloudflare account (region `global`, `kind: onprem`, its spec stored), and the
  plan made at registration has no step. Registration calls no cloud. The answer carries the front door (`edge`) and
  the install's settings for `cloudflared` (`install`: the chart's values, the systemd unit or the Compose file).
- Applying the front door (`POST /api/admin/cloud/edge/:id/apply`, the edge flow above) makes the tunnel and the DNS
  record; afterwards both join the deployment's graph with their provider ids (`tunnel`, `dns-app`), the deployment is
  `applied` with `endpoints.publicUrl`, and the scheduled drift reads them through the Cloudflare adapter (a token
  scoped to the front door lists no R2 or Containers, which drift skips). Spend is the Cloudflare account's by
  deployment (`GET .../deployments/:id/costs`).

Test: `server/test/cloud-onprem.test.ts` (each install kind: the dry run and registration with nothing planned or
called, the tunnel and the record from the edge flow, the graph, the list by kind, drift with its change trail, spend;
attaching an earlier front door; refusals), against `fake-cloudflare.ts`.

## Cloudflare billing and showback (B-10608, B-10604)

Sprint 61. Code: `server/src/cloud/cloudflare-billing.ts` (called by `cloud/costs.ts`), `cloud/showback.ts`
(`s.cloud.showback`), routes `server/src/routes/admin/cloud-showback.ts` and the neuron check in
`routes/admin/cloud-costs.ts` ([api.md](api.md)); the console's Cloud showback view on Analytics
(`web/js/screens/analytics-showback.js`). Migration `164_cloud_showback`.

### Cloudflare billing (B-10608)

Cloudflare has no per-resource cost API, so a Cloudflare account's daily fetch (the same claim per account and UTC
day as the other providers, the same "fetch now" once an hour, through the Cloudflare transport with the account's
billing token: "Billing Read" and "Account Analytics Read") is **three requests** (two GraphQL, one billing history):

| Call | Rows |
| --- | --- |
| Two GraphQL Analytics requests (`POST /client/v4/graphql`) for the whole window, one aliased dataset per product and calendar month (Cloudflare answers at most 31 days per dataset query): `workersInvocationsAdaptive` (requests, CPU time per script), `containersUsageAdaptiveGroups` (CPU seconds and allocated memory and disk byte-seconds per application id: the dataset Cloudflare names for billing estimates), `r2StorageAdaptiveGroups` and `r2OperationsAdaptiveGroups` (stored bytes, operations by action per bucket) and `aiInferenceAdaptiveGroups` (neurons per model). Tunnel is not queried: it costs nothing and has no documented dataset | one per day, product and script, application, bucket or model, priced at the published usage rates (`CF_USAGE_RATES`, checked 2026-10-21 against [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Containers](https://developers.cloudflare.com/containers/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/) and [Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/) pricing: Workers USD 0.30 per M requests and 0.02 per M CPU ms; Containers 0.000020 per vCPU-second, 0.0000025 per GiB-second, 0.00000007 per disk GB-second; R2 0.015 per GB-month, 4.50 and 0.36 per M Class A and B operations; Workers AI the price sheet's neuron price, 0.011 per 1,000; Tunnel free), `source: cloudflare-analytics`, `estimated: true`; attributed to the deployment that owns the resource (its provider id, else the `exprsn-<account>-<deployment>-` name prefix); Workers AI rows are unattributed, allocated by the model id |
| The account's billing history (`GET /client/v4/accounts/{account_id}/billing/history`, "Billing Read"; the user-level `/user/billing/history` is deprecated), every page, charges inside the window | for each **finished** month in the window with charges, one `cloudflare-billing` row per day carrying the difference between what was charged and the month's priced analytics (plan fees, included allowances), unattributed, so the month adds up to the bill while the daily attribution stays. A month charged in another currency than the analytics' (USD) keeps its charges as its rows and drops its analytics rows (never converted, open decision 17) |

The window is the usual one (the last 14 days and the whole month) reaching back to the start of the previous month,
so the last finished month is reconciled from complete analytics in the same request. Included allocations are not
subtracted from the daily rows; the reconciliation takes them out of the finished month. The day's usage (neurons,
Workers requests and CPU, container vCPU-seconds, R2 storage and operations, tunnel bytes) is kept with the fetch
(`note.analytics.days`), and each reconciled month in `note.billing`. The dataset and field names follow Cloudflare's
GraphQL schema as documented when this was written; the nightly sandbox run (B-10804) confirms them.
Workers AI (`aiInferenceAdaptiveGroups`, not in Cloudflare's public schema docs) goes in a second GraphQL request of its own (so a fetch is at most three requests), and when that request fails the other products' rows are still written: the fetch is partial (`note.partial.workersAi` and the `cloud.costs.ingested` audit say Workers AI neurons were unavailable, with the error), it has no Workers AI rows, and the neuron check reports its days as `unavailable` ("analytics unavailable"), not as mismatches.

**The neuron check.** After each Cloudflare fetch the job `cloud.costs.neurons.check` compares, per day, the
analytics' Workers AI neurons (the newest fetch covering the day) with the neurons metered on `usage_records`
(B-10509) for the pools that hold the account's Workers AI instances; a day differing by more than 1 % is audited
`cloud.costs.neurons.mismatch` (the days, both figures and the difference) and logged.
`GET /admin/cloud/accounts/:id/costs/neurons` shows the comparison.

### Showback (B-10604)

A month's ingested costs (`cloud_costs`, every provider) are shown back to the workspace and tenant that caused them,
per currency (open decision 17: never converted; a report lists each currency apart):

1. **Tags.** A row's tags are its resource's (DigitalOcean and Cloudflare rows name one by provider id), else the
   tags every resource of its deployment shares, plus the deployment's tenant (a tenant-scoped deployment) and the
   account's (a tenant-scoped account). `exprsn:workspace` places the cost in that workspace (method `tag`);
   `exprsn:pool` splits it over the workspaces that used the gateway pool (`pool`, by the type's rule, GPU time by
   default); `exprsn:tenant` alone splits it over that tenant's workspaces (`tenant`).
2. **Shared costs** (nothing says whose: clusters, databases, the front door, Workers AI, billing adjustments, tax) are
   split across the month's metered usage (`shared`) by the **rule of the row's cost type**:

   | Cost type | What | Default basis |
   | --- | --- | --- |
   | `gpu` | GPU node groups, anything tagged with a pool | `gpu_time` (`usage_records.gpu_ms`) |
   | `model` | Model APIs (Bedrock, Azure OpenAI, DigitalOcean GenAI, Workers AI) | `model_cost` (`usage_records.cost_micros` in the row's currency, B-10505), else tokens |
   | `compute` | Clusters, VMs, containers, Workers | `requests` (metering records) |
   | `database` | Managed databases and caches | `storage` (bytes in the file store per workspace) |
   | `storage` | Object stores, R2, Blob, Spaces | `storage` |
   | `network` | Load balancers, DNS, NAT, the front door, tunnels | `requests` |
   | `other` | Everything else (support, tax, adjustments) | `requests` |

   The bases are `gpu_time`, `tokens`, `model_cost`, `requests`, `storage`, `even` and `unallocated`; the platform sets
   them (`PUT /admin/cloud/showback/rules`, `finops:manage` and `platform:manage`). A model cost is split only over the
   pools holding that account's model instances when there are any. A basis with nothing to weigh by falls back to
   `requests`; a tenant's cost with no usage is split evenly over its workspaces; what is left is the **unallocated**
   line.
3. **Exact sums.** Splits are in millionths with the remainders handed out by size, so **a month's showback across all
   workspaces (and a tenant's usage outside any workspace) plus the unallocated line equals the month's ingested
   total**, in each currency.

Monthly rows are stored in `cloud_showback` by the daily `cloud.showback.compute` (this month and the last) and by
"compute now"; a month never computed is computed on request. A platform admin sees every tenant and the unallocated
line; anyone else with `finops:read` sees their own tenant. The CSV export is audited. **Statement lines** (B-13): a
tenant may turn on `statementLines` (`PUT /admin/cloud/showback/settings`, default off); its statements then carry a
`showback` section (and the CSV export a `showback` part), informational only: never in the total, never pushed to
Stripe. With the setting off, statements and analytics answer exactly as before.

Without migration 164 showback is computed on request with the default rules and nothing is stored, the rule and
setting changes answer `503` `migration_pending`, and no statement carries showback lines. Audit:
`cloud.showback.rules.updated`, `cloud.showback.settings.updated`, `cloud.showback.computed`,
`cloud.showback.exported`, `cloud.costs.neurons.mismatch`.

### Tests

`server/test/cloudflare-billing.test.ts` (GraphQL analytics and the billing history into daily rows per product, one
analytics and one billing request per account and day, a finished month reconciled with its charges and another
currency kept apart, Workers AI neurons matching the metered ones within 1 % and a mismatch reported by the check job,
the neuron route, a token without analytics access) against `fake-cloudflare.ts` with `fake-cloudflare-billing.ts`;
`server/test/cloud-showback.test.ts` (allocation by tags, pools and tenants; shared costs per rule; the month's
identity; per workspace and tenant; CSV; statement lines only when on; currencies apart; without migration 164); the
console: `e2e/tests/analytics-showback.spec.ts` (axe light and dark, AA and AAA, reflow at 320 and 640 px). No test
reaches a cloud.


## Anomalies and the Cloud spend screen (B-10606, B-10607)

Sprint 62. Code: `server/src/cloud/anomalies.ts` (`s.cloud.anomalies`), `anomaly-metrics.ts`, `spend-overview.ts`;
routes `server/src/routes/admin/cloud-anomalies.ts` ([api.md](api.md)); the console's Cloud spend screen
`web/js/screens/cloud-spend.js` (`#/cloud-spend`), live from the `finops` board. Migration `166_cloud_anomalies` (not
registered yet): `cloud_anomalies`, one row per account, day, service and currency. Until it is applied nothing is
detected, no notice is sent, the anomaly routes answer `503` `migration_pending`, and the screen's Anomalies tab says
so; everything else on the screen works.

### Detection

After every successful billing fetch `cloud.costs.ingest` queues `cloud.anomalies.detect` for the account (and the job
also runs daily over every account with ingested costs, as a fallback). It checks each of the **last three ingested
days** (providers revise recent days and some arrive a day late), per service and currency (never converted), against
that service's daily spend in the same account over the **14 days before** it (`cloud_costs`):

- **The baseline is robust.** Its centre is the **median** of the 14 daily totals and its spread the **median
  absolute deviation** (MAD) scaled by 1.4826, the standard deviation of normally distributed spend. One earlier spike,
  a quiet weekend or a single missing row does not move either, where a mean and standard deviation would follow
  them. A day the account has rows for but not this service counts as 0; a day with no rows at all for the account
  (ingestion had not started, or failed) is left out.
- **A day is an anomaly** when all three hold: its robust score, (actual − median) / max(1.4826 × MAD, 5 % of the
  median, 0.01), is at least **4**; it is at least **50 %** above the median; and at least **50** (in the rows'
  currency) above it, so small services never page anyone. These are the constants `ANOMALY_MIN_SCORE`,
  `ANOMALY_MIN_RATIO` and `ANOMALY_MIN_DELTA`.
- **Too little history decides nothing**: with fewer than 7 baseline days holding data (a new account, a gap) the day
  is not judged.

An anomaly names its **top contributors**, each with the day's actual, its own baseline median and the extra: the
service itself, then up to three each of the deployments (the row's attribution: the `exprsn:deployment` tag, or the
resource id on DigitalOcean and Cloudflare; unattributed rows are a contributor of their own), the regions (the
resource's region, else the deployment's, else the account's default) and the tags (the `exprsn:` tags the resources
share, such as `exprsn:workspace`, `exprsn:pool` and `exprsn:tenant`; `exprsn:managed`, `exprsn:account` and
`exprsn:deployment` are left out). A tripled NAT gateway cost in one deployment therefore names that deployment, its
region and its workspace, and not a deployment whose NAT cost stayed flat.

**Once per account, day and service.** The row's unique key (account, day, service, currency) means a re-run, the
daily fallback or another instance never stores or announces the same anomaly twice. A new anomaly is:

- the audit event `cloud.anomaly.detected` (its target names the top deployment; the detail carries the figures and
  contributors), which every webhook subscribed to `cloud.*`, `cloud.anomaly.*` or `*` receives;
- a notice of kind `cloud.anomaly` (group Administration) to the tenant's FinOps readers and cloud admins, linking to
  `#/cloud-spend?tab=anomalies&anomaly=<id>`;
- a count in `exprsn_cloud_anomalies_total{provider}`; `exprsn_cloud_anomalies_open{provider}` (read at each scrape) is
  the open ones of the last 7 days, and the alert `ExprsnCloudSpendAnomaly` (in `exprsn-ai-cloud.rules.yml`, runbook
  in [runbooks/alerts.md](runbooks/alerts.md#exprsncloudspendanomaly)) fires while one is open.

**Acknowledging** (`finops:manage`; a platform account also `platform:manage`) records who and an optional note
(`cloud.anomaly.acknowledged`) and stops repeat notices: an anomaly of the same account, service and currency in the
next three days is stored already acknowledged (`suppressedBy`), audited `cloud.anomaly.suppressed`, with no notice and
no count; after that it opens again.

### The Cloud spend screen

`#/cloud-spend` (Admin, beside Cloud accounts) reads `finops:read` or `cloud:read` and shows only the accounts the
viewer may see; changes need `finops:manage`. Its tabs follow the board:

| Tab | What it shows and does | From |
| --- | --- | --- |
| Overview | Spent this month (in the most common billing currency), the forecast, accounts under hard stop, the idle GPU saving; daily spend stacked by provider; every account with its budget, use, forecast and alerts; estimates marked | `GET /admin/cloud/costs`, `/budgets`, `/spend` |
| Budgets | The rule, the month's counts, each account's budget, alerts sent, the hard stop as a switch, "Set budget" and "Request override" (sent for a second admin's approval on Cloud accounts) | `/budgets`, `PUT .../budget`, `POST .../budget/overrides` |
| Showback | By workspace or tenant: GPU, model tokens, storage and other, with the mix; the allocation rules; CSV export; statement lines on | `/showback`, `/showback/export`, `/showback/settings` |
| Anomalies | Every anomaly with actual, baseline and state; the inspector's contributors; Acknowledge with a note | `/anomalies`, `.../acknowledge` |
| Model tokens | Cloud model calls priced at metering, per model and profile, with input, output (or neurons) and cost | `/spend` (`usage_records.cost_micros`) |
| Sources | Each account's billing API, last fetch, result and "Ingest now" (once an hour per account) | `/costs`, `POST .../costs/fetch` |

Amounts stay in the currency each account bills in and are never added across currencies. The Analytics screen's
"Cloud showback" tab stays; the Showback tab links to it. The board's states (no accounts, loading, ingestion failed,
budget hard stop, anomaly detected, permission denied, estimates only) are the screen's `states`.

### Tests

`server/test/cloud-anomalies.test.ts` (the median and MAD; a tripled NAT gateway cost raising one alert naming the
deployment, its region and workspace tag, as a notice, the audit event a webhook receives and the metric; no repeat the
same day; ordinary variation and too little history raising nothing; acknowledging through the routes, the
permissions and the suppressed repeat; the overview; without migration 166); `promtool test rules` for
`ExprsnCloudSpendAnomaly` in `exprsn-ai-cloud.rules.test.yml`; `e2e/tests/cloud-spend.spec.ts` (every tab, board state
and dialog with the WCAG checker and axe-core, Standard and Enhanced, light and dark; reflow at 320 and 640 px;
acknowledging and a budget). No test reaches a cloud.

## Cloudflare app tier, R2, D1 and AI Gateway (B-10905 to B-10908)

Sprint 61. Code: `server/src/cloud/cloudflare-app.ts` (the render, the Worker module, `cloudflareAppProblems`),
`providers/cloudflare-app.ts` (Workers with static assets, Hyperdrive and Containers in the Cloudflare adapter),
`cloud/r2.ts` (jurisdictions and the S3 settings), `connections/d1.ts` and `connections/classify-sqlite.ts` (the D1
engine), `cloud/ai-gateway.ts` and `gateway/ai-gateway-hop.ts` (AI Gateway), routes `routes/admin/cloud-ai-gateway.ts`.
No migration. Nothing changes until a spec names the `cloudflare` shape, a bucket names a jurisdiction, a D1
connection is registered or an instance names a gateway.

### The app tier (B-10905)

Cloudflare cannot run PostgreSQL, Redis or Ollama GPUs, so `compute.shape: cloudflare` is always hybrid: the target
provider (AWS, Azure, DigitalOcean) or on-prem holds the data tier, and the front door's Cloudflare account runs the
app tier. The render (`renderGraph(...).appTier`) puts four resources on that account; creating a deployment from the
spec also makes the app tier's own deployment there (`<name>-edge`) and plans it, since a deployment's graph lives on
one account.

| Key | Type | What it is |
| --- | --- | --- |
| `blobs` | `bucket` | An R2 bucket for `BLOB_STORE=s3`; `r2Jurisdiction: auto` puts it in the EU jurisdiction (region `r2-eu`) when the data region is in the EU, `fedramp` only when asked; protected |
| `hyperdrive` | `hyperdrive` | PostgreSQL through Hyperdrive: through the tunnel with an Access service token for a provisioned database (no public address) or an on-prem one, directly for an existing one unless `databaseVia: tunnel`. The database URL is read from the vault at create time and goes to Cloudflare only |
| `worker` | `worker` | The Worker: the console's script, style, image and font files as Workers static assets (from this build's `web/`; never HTML, so every page comes from the app with its CSP), plain settings as `plain_text` bindings, secrets as Worker secrets through the secrets API (values from the deployment's secret broker), Hyperdrive whose connection string becomes the container's `DATABASE_URL`, the R2 endpoint and bucket, the container as a Durable Object class, and the front door's hostname as its custom domain |
| `app` | `container_service` (`platform: cloudflare-containers`) | The signed image by digest on Cloudflare Containers, one instance per app replica, the instance type by size (`standard-1`, `standard-2`, `standard-4`); its settings come from the Worker; the first instance to start runs the migrations (`DB_MIGRATE_ON_START`), as Containers have no one-off job |

Redis is required from a managed cache on another provider (open decision 19: a TLS endpoint with authentication
and an IP allow-list of Cloudflare's egress ranges), named by `compute.cloudflare.redisUrlRef` or `data.redisUrlRef`.
`validateSpec` refuses a spec without it (check `app_tier`), and `cloudflareAppProblems`, a blocker of every plan
through `computeProblems`, refuses a Worker without a `REDIS_URL` secret or without Hyperdrive with the same reason:
"A Cloudflare app tier needs Redis on another provider ...". No cache is provisioned for this shape: Containers cannot
reach a private one. Secrets are never plain settings: a secret variable among the Worker's `vars` is refused, and so
is `DATA_KEY` or a cloud credential among its secrets (they would reach the container as variables), so the
key-encryption key stays in OpenBao transit (`keys.provider: openbao`). GPU pools are refused for this shape ("Runs
the app tier only; pick a provider for data and GPUs"). The capability table now has `worker`, `hyperdrive` and
`container_service` built for Cloudflare; `database` is unsupported there (D1 is never Exprsn-AI's own database).

### R2 as an object store (B-10906)

An install keeps its files, backups, training artefacts and export bundles in R2 through `BLOB_STORE=s3`:
`S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com` (`<account id>.eu.` or `<account id>.fedramp.` for a
bucket in a jurisdiction), `S3_REGION=auto`, `S3_FORCE_PATH_STYLE=true`, an R2 API token's access key id and its
secret as `S3_SECRET_ACCESS_KEY_FILE` (`r2BlobSettings` gives the plain ones). The adapter sends `cf-r2-jurisdiction`
when it creates, reads, lists and deletes a bucket placed in `r2-eu` or `r2-fedramp` (or with `props.jurisdiction`),
so the bucket passes the same region, ceiling and residency checks as any placement. `backup:restore` reads a backup
from the configured store, R2 included. Fixed on the way: `deletePrefix` on an S3 store refused every prefix.

### D1 as a read-only data connection (B-10907)

The engine `cloudflare-d1` (SQL, dialect `sqlite`): the endpoint `https://api.cloudflare.com`, the account the
Cloudflare account id, the database the D1 database id, the secret an API token scoped to D1;
`api.cloudflare.com` must be on `CONNECTIONS_ALLOWED_HOSTS`. Reads go to the query API (`/d1/database/<id>/raw`),
wrapped as `SELECT * FROM (...) LIMIT n+1 OFFSET m` with bound values apart. D1 has no read-only role and the API no
read-only transaction, so the SQLite classifier is what keeps it read-only: writes (`INSERT`, `INSERT OR REPLACE`,
`REPLACE`, `UPDATE`, `DELETE`, upserts, data-modifying CTEs), `PRAGMA`, `ATTACH`, `DETACH`, `VACUUM`, schema changes
and transactions are refused before anything is sent, and the driver refuses anything not classified as a read too;
file, extension and schema functions (`load_extension`, `readfile`, `pragma_*`, `sqlite_*`) are denied; the schema
tables are objects like any other. Masking and the allow-list (unqualified names resolve to `main`) are as for every
SQL engine; schema listing reads `sqlite_schema` and `pragma_table_info`. D1 is never a `DB_CLIENT`. There is no local
D1 server, so the example connections script lists it as skipped.

### AI Gateway (B-10908)

`PUT /api/admin/instances/:id/ai-gateway` puts Cloudflare AI Gateway in front of a cloud model instance's inference
calls (`settings.cloud.aiGateway`): Workers AI as `workers-ai`, Azure OpenAI as `azure-openai/<resource>/<deployment>`,
DigitalOcean GenAI as a custom provider (`custom-digitalocean`), Bedrock as `aws-bedrock/bedrock-runtime/<region>`
(the request is signed for the regional endpoint and passed on). The provider's own credential goes with the call;
the gateway gets the Cloudflare account's token (`cf-aig-authorization`). Model listings and health go straight to
the provider.

- Caching and logs follow the label of the lease the call serves (`withAiGatewayLabel`): up to `internal` as the
  instance says (`cache`, `logs`, both on by default; `cacheTtl`); above `internal` off (`cf-aig-skip-cache: true`,
  `cf-aig-collect-log: false`) unless `confidential` is turned on explicitly; `restricted` never; a call outside a
  lease counts as above `internal`. So a `confidential` turn leaves no prompt in the gateway's logs.
- Exprsn-AI's profile fallback decides: Exprsn-AI never asks the gateway for a fallback, and an answer with
  `cf-aig-step` other than 0 or a `cf-aig-model` that is not the requested model is refused (a `502` from the model
  server), so the profile's fallback (`runFollowing`) serves next, on the model the profile names.
- Rate limits are the gateway's own: `PUT /api/admin/cloud/accounts/:id/ai-gateways/:gateway` writes them with the
  default cache TTL (0), logs (off) and authentication (on).

### Tests and fakes

`server/test/cloudflare-app-tier.test.ts` (the render, the Redis refusal at spec, render check and plan, no plain
secrets, the adapter against `fake-cloudflare-app.ts`, the engine path on the Cloudflare account),
`server/test/r2-blob.test.ts` (jurisdictions in provisioning, `BLOB_STORE=s3` against the S3 fake as R2, a backup
written to it restored as `backup:restore` does), `server/test/connections-d1.test.ts` (`fake-d1.ts` runs the
statements on SQLite and records them; an `INSERT` never reaches it), `server/test/ai-gateway.test.ts`
(`fake-ai-gateway.ts` in front of the Workers AI, Azure OpenAI, DigitalOcean and Bedrock fakes). The offline guard
also refuses `gateway.ai.cloudflare.com` and `*.workers.dev`, and `metadataSafeFetch` (the S3 store) refuses every
real cloud host in tests.

## Known gaps (2.0.0)

The one current list for the cloud epic at release (B-10805), gathered from the sections above and from the epic's
entries in [security.md](security.md#known-gaps-tracked-in-the-plan), with what later sprints closed taken out. The
security review's findings and their acceptance are in [security.md](security.md) (B-10803).

**Not run against real accounts yet.** Everything above is tested against the providers' fakes; the nightly sandbox
run (B-10804, open decision 18) and the owner's sandbox steps (the RDS move in [runbooks/db-move.md](runbooks/db-move.md),
the managed-database restore in "Tests and the sandbox") have not run. Until they do, these are as this build reads
them, not confirmed: the generated IAM statements (`aws:RequestTag` conditions on `ec2:RunInstances` also apply to the
subnet, image and security group, which may need statements of their own), the Azure custom role and the DigitalOcean
and Cloudflare token scopes (derived from the feature lists, not scanned from the adapters' code as AWS is); the AWS
Price List attribute names and Azure meter names; the price sheet's model entries (DigitalOcean GenAI is priced only
once an entry is confirmed or a price recorded by hand), snapshot prices, the AKS free-tier meter and the Workers AI
neuron rates (review at every release); Cloudflare's GraphQL analytics dataset and field names, its rate-limiting
availability per plan and managed ruleset ids; AI Gateway's answer headers; whether Entra accepts ES256 for federated
credentials (open decision 3, `CLOUD_AZURE_SIGNING_ALG=RS256` is the fallback); whether a Cloudflare container can use
its Worker's Hyperdrive string directly.

**Accounts and credentials.** An S3 issuer target in a federated AWS account cannot publish the issuer's first
documents with that account's own sessions: publish them by hand from the setup helper, or give the target a vaulted
key pair. Sessions are cached per instance. A DigitalOcean or Cloudflare token's expiry is what the admin entered, not
read from the provider. An Azure secret not made by this server is matched to its Graph key by its hint; when that is
ambiguous the old secret is left for an admin. A region's residency geography is fixed by the catalogue, and a
tenant's residency is a list of geographies, not countries. Accounts carry no billing currency of their own (USD is
assumed; nothing is converted, open decision 17). The EKS cluster and node roles, the ECS task execution role
(`exprsn-<account>-ecs-execution`) and the cloud KMS identities are created by hand (the setup helper does not list
them).

**The deployment engine.** A replace deletes before it creates (names are reused), so the resource is absent in
between. Between the apply's own out-of-band check and the worker's first step a change goes unnoticed until the next
plan or verify. Rollback is offered by verify, not performed (except the automatic one after a failed apply,
`CLOUD_AUTO_ROLLBACK`). GPU pool health is not a verify check. Circuit breakers and "remaining calls" holds are per
process. Drift and the orphan sweep do not look for unmanaged DNS records, nor in regions the account no longer
allows. An ignored drift field is still set back by the next apply. Final snapshots exist for databases and
DigitalOcean droplets; object stores have none, so a protected bucket loses its protection through a plan before a
destroy can delete it. The change trail finds a resource by its name (a change made through another resource may not
be found), reads one day before the finding within the trails' 90 days, and has nothing for DigitalOcean. What the
provider does not build in this release (the capability table's `not yet`): DigitalOcean Spaces buckets, standalone
load balancers, secrets as resources (Secrets Manager, Key Vault).

**DNS and TLS.** The load-balancer certificate pushes (ACM, Application Gateway, DigitalOcean) open the certificate's
private key on the issuing instance and send it over the cloud transport. An Azure DNS zone used for dns-01 must sit
in the account's managed resource group, and Azure DNS and DigitalOcean need `ACME_DNS_CLOUD_ZONE`. A `valueFrom`
record whose source has no address yet fails its step (`value_source_pending`) rather than waiting.

**Targets.** Destroying a deployment does not uninstall its Helm release first: on EKS the ALB the controller made can
keep the VPC from being deleted. The worker image carries neither Helm nor the chart ([deploy.md](deploy.md#the-deploy-workers-helm-1999-final-b-10203-open-decision-7)).
The deployed app's blob store is a shared volume (`efs-sc`, `azurefile-csi`); DOKS has none built in, so blobs on
DigitalOcean need an S3-compatible bucket configured by hand. A DigitalOcean deployment keeps `DATA_KEY` as a file in
its Kubernetes Secret (no cloud KMS). AKS and DigitalOcean do not attach a model snapshot volume to GPU nodes. CI does not
build or sign the release tarball (only the image), so a VM's `--bundle` check applies to releases signed by hand.
DigitalOcean has no console read: a droplet's install result is `unknown` until `/readyz` answers. ECS and App Platform
hand the non-file-only secrets (session secret, database URL, OpenBao token) to the app as variables from their secret
stores; `aws-kms` is refused on ECS; a VM bootstrap without OpenBao on the control plane installs with its credentials
pending. A provisioned database on ECS or App Platform is refused (`ca_file_unsupported`). The control plane does not
reach a private database itself.

**Budgets, billing and showback.** Without fresh billing data (three days), budgets use the applied plans' estimates:
spend they miss neither alerts nor stops, and the hard stop is checked at plan and at apply, not during a long apply.
AWS and Azure figures are the whole account or subscription; several Exprsn-AI accounts naming one bill each count it
all. Providers' revisions older than 14 days are not re-fetched. DigitalOcean costs are spread evenly over each invoice
item's period. Cloudflare's daily rows are priced usage analytics (`estimated`, no allowances or plan fees), reconciled
to the bill for finished months only; the tunnel is not queried. Workers AI's free daily allocation is not subtracted.
Showback is informational (tags and rules decide; the `storage` basis is the file store's current bytes). Prices are
refreshed only when asked. Bedrock prompt-cache writes are priced at the input rate. Spot nodes are estimated at the
on-demand price. Cost Explorer is charged per request (one a day per account plus pages, one manual fetch an hour).
Tenant readers of showback see only their tenant, but their share of a shared cost reveals the ratio of their usage
to the platform's.

**Data.** DocumentDB privileges are not reported. D1's query API runs no read-only transaction (the classifier is the
only guard), and there is no local D1 server for tests. No cache is provisioned for the Cloudflare shape: Redis comes
from a managed cache on another provider (open decision 19).

**GPU pools and models.** The gateway's own `model.pull` on a cloud instance pulls by name, which the node's egress
guard refuses unless it is the mirror; the nftables guard admits the mirror's and enrolment host's addresses as
resolved at boot. EKS capacity failures that arrive late are not retried. GPU VM pools scale by plan only. Only the
server that takes an interruption notice moves leases off the node; a node without the watcher drains only when it
stops answering. The enrolment endpoint has no rate limit of its own beyond the app's, and every node of a node
group's DaemonSet can read the `exprsn-enrol` Secret (tokens are bound to a node's name and address). The GPU network
is the operator's. The gateway's client key for a pool is held in memory on every server (sealed in the database), and
the node certificate is a server certificate only. Azure's content filter is recorded only for leases taken for a profile; inference calls are not
counted in the transport's per-account rate limit; a request riding on a slot its turn holds is not checked again for
residency. Bedrock Guardrails in `converse` mode may stream the guardrail's message before the turn fails, `apply`
mode checks after streaming, and ANONYMIZE is treated as a block. Embeddings are not guarded on the provider side. A
catalogue name is unique, so a second import of the same Bedrock model from another account or region is skipped.

**Cloudflare.** The server's Access check does not cover WebSocket handshakes (the socket's own session check stays).
A cloud deployment's Helm values do not run the connector yet. Nothing renders or plans a `cloudflared` beside the
**data** tier: run it there by hand from the shipped unit, Compose file or chart. WAF limits with no room are left to
the server. An on-prem deployment has no verify of its own (`applied`, never `ready`), and its front door's WAF rules
and Access applications are not drift-checked. Containers have no one-off job, so the first instance's start runs the
migrations; GPU pools are refused for the `cloudflare` shape. Cloudflare's ranges are compared with its API only when
asked. The `cloudflared` image is pinned by version and digest from Docker Hub; pin a mirror's digest where one is used.

**Keys and blobs.** The cloud KMSes neither create signing keys nor sign: OIDC, SAML, PKI, AT-Protocol and webhook keys
keep their own custody. Checkpoint signatures are ES256 only. Moving between two accounts or vaults of the same cloud
KMS is not a `kms:rewrap`. AWS key deletion can be cancelled during its waiting period; a Key Vault key without the
purge permission stays soft-deleted for the vault's retention. The Azure blob store expects its container to exist.
`S3_SECRET_ACCESS_KEY` is still accepted inline (only the new cloud secrets are file-only).

**Protocol clients outside the metadata refusal.** The application database, `REDIS_URL`, `SMTP_URL`, LDAP stores,
ClamAV, the signer socket and NTP are not HTTP and not tenant input, so they are not run through the metadata refusal.

## Console (B-10706)

The cloud screens are live (`web/js/screens/`); each opens with `cloud:read`
and every control calls the routes above:

| Screen | File | What it does |
| --- | --- | --- |
| Cloud accounts (`#/cloud`) | `cloud.js` | Accounts, regions and ceilings, the permission checklist, proposals, residency, budgets and costs; the credential's state and rotation (`GET .../credential`, `POST .../rotate`, `PUT .../secret`); the federation issuer (`GET /cloud/issuer`, check, publish, rotate); the setup helper (`GET .../setup`) under View trust; Discover data services opens Cloud data's connect dialog |
| Deployments (`#/deployments`) | `deployments.js` | The list (estimate, month to date, open drift); the wizard: spec, `validate-spec`, `POST /cloud/deployments` with the plan and estimate (an on-prem registration too); plan review with field changes and blockers; apply by hash (recent sign-in); the journal; verify; drift with revert, adopt or ignore and `changedBy` or the trail's state; destroy with the protected resources' second approval; releases, upgrades and pre-upgrade snapshot restores; the Cloudflare front door |
| Cloud data (`#/cloud-data`) | `cloud-data.js` | Databases, caches and buckets from the deployments' graphs and `GET .../databases`; extensions, snapshots, the schedule, restore to a new instance; the own-database move (`/cloud/db-moves`); discover and connect (`GET .../discover`, `POST .../connect`); a new database as a plan on its deployment |
| Cloud compute (`#/cloud-compute`) | `cloud-compute.js` | GPU pools from `GET /pools/cloud` and `GET /cloud/gpu-pools`, savings from `GET /cloud/gpu-savings`; the scale policy (`PUT /pools/:id/autoscale`) and manual scaling (`POST /pools/:id/scale`, 409 `budget_exceeded` past the hard stop); a new GPU node group as a plan (quota checked by the planner); Open in Pools |
| Cloud spend (`#/cloud-spend`) | `cloud-spend.js` | B-10607 |

The e2e server seeds their state through the real services against the DigitalOcean fake (`e2e/cloud-seed.ts`);
`e2e/tests/zz-cloud-screens.spec.ts` applies every design state (axe-core and the WCAG checker, light and dark, Standard
and Enhanced, reflow at 320 and 640 px) and runs the primary flows. Not on the screens yet, for want of a route: turning
a database's deletion protection off outside destroy (a plan never does), allow-listing an extension at the provider,
and cancelling an apply after its running step.

