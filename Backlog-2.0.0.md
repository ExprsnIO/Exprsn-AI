# Backlog: 2.0.0

Cloud deployments and integrations for AWS, Azure, DigitalOcean and Cloudflare, in both directions: (a) deploy
Exprsn-AI itself (application, PostgreSQL, Redis, Ollama GPU nodes) to a cloud from the console, and (b) from any
running install, use the clouds' services: model APIs, GPU compute joined as gateway pools, managed databases as
Exprsn-AI's own database or as data connections, object stores, and an edge front door. The server calls the
providers directly (AWS SDK for JavaScript v3, the Azure ARM SDKs, the DigitalOcean REST API v2 and the Cloudflare API
v4), not Terraform: it keeps a resource graph and an operation journal in its own database and works plan (a
previewed diff with a cost estimate) → apply → verify, with drift detection, rollback and destroy, idempotent retries,
provider rate limits and long-running operations tracked by a deploy worker. Rules as before: everything follows
`docs/PLAN.md` and `CLAUDE.md`; screens follow `design/prototype/CONTRACT.md` (prototype board first, then live when
every control is backed by the server); every server item ships its routes, permission, audit events, jobs, tests on
SQLite, PostgreSQL and MySQL, `docs/api.md` and `docs/openapi.json` entries and any known gaps in `docs/security.md`.

The owner's decisions of 2026-10-05 this backlog designs to: both directions; native cloud SDKs; all four model
backends (Bedrock, Azure AI Foundry, DigitalOcean GenAI, Workers AI) plus cloud GPU instances running Ollama; federated
short-lived credentials or vaulted static keys, the admin's choice per account (DigitalOcean and Cloudflare: vaulted
tokens only); every managed database family; every compute shape (Kubernetes, VMs, container platforms, GPU nodes with
scale-to-zero); full FinOps. Added the same day: Cloudflare as the fourth provider, for the edge and the app tier
only (B-109).

**Numbering.** Epics start at B-100 and items at B-10001. Lower epic numbers are taken: B-42 to B-99 in 1.6.0 and
1.7.0 (the 1.6.0 gaps and the exprsn-platform port were merged on 2026-10-07; B-63 to B-68 are held for the workbench
storyboard). B-100 to B-111 are 2.0.0's, and later epics continue at B-112 (the port's last three, in 1.7.0).

**Size.** 76 items, 474 points (1 point ≈ half a day for one engineer, tests included): P0 197, P1 254, release 23. At
about 70 points a sprint that is Sprints 44 to 50, after 1.7.0, which ends at Sprint 43 (renumbered from 40 to 46 on
2026-10-07, when the 1.6.0 gaps and the 1.7.0 port items were placed); Sprint 50 is the release sprint at 55 points. With fewer engineers, the first things to move to a 2.1 are the
out-of-band change trail (B-10703), the document and key-value drivers (B-10304), D1 (B-10907) and the cloud KMS
providers (B-10208).

**Builds on.** The OIDC provider with per-tenant issuers and ES256 keys signed in OpenBao transit (`docs/identity.md`,
B-14); the certificate authority and ACME client (`docs/pki.md`, dns-01 since Sprint 15); the tenant vault with KV
versions, rotation schedules and the PostgreSQL and MySQL lease engines (B-17, `server/src/vault/`); OpenBao dynamic
database credentials for connections (`connections/dynamic.ts`); the `JobQueue`, `Scheduler` and shared rate limiter
(`platform/ratelimit.ts`); `platform/egress.ts` service URL checks; the gateway's pools, instances, placements and
profiles; the Helm chart, Compose files and bare-metal installer in `deploy/`; zones and labels in `authz/policy.ts`;
`usage_records` and the billing price books (B-13); and, for every cloud model API, **B-43 "Model servers beyond
Ollama"** (`Backlog-1.6.0.md`, done in Sprint 35): the `ModelServer` interface over `OllamaClient`, instances of `kind:
openai` and catalogue entries with `format: server`. B-105 is designed on top of B-43 and does not redesign it.

**Design.** The storyboard is `design/mockups/cloud.html` (built from `cloud.src.html` and the parts in
`design/mockups/cloud/` by `node design/mockups/build-cloud.mjs`; its backlog summary is generated from this file). The
prototype boards are `design/prototype/js/screens/cloud.js` (`#/cloud`), `deployments.js` (`#/deployments`),
`cloud-data.js` (`#/cloud-data`), `cloud-compute.js` (`#/cloud-compute`), `finops.js` (`#/finops`) and the provider
filter and cloud catalogue on `models.js` (`#/models`).

## Sprints

| Sprint | Theme | Items | Points | Migration | Status |
| --- | --- | --- | --- | --- | --- |
| 44 | Cloud accounts and credentials (federated and vaulted, all four providers); the provider adapter interface and the test fakes | B-10002–B-10009, B-10101, B-10109 | 68 | `0NN_cloud_accounts` | Planned |
| 45 | Resource graph, operation journal, plan, apply, verify, drift, destroy and rate limits; deployment spec and network foundation; audit; price catalogue and estimates | B-10102–B-10108, B-10201, B-10202, B-10701, B-10601 | 71 | `0NN_cloud_journal` | Planned |
| 46 | Platform deployment: Kubernetes, VMs and container platforms, DNS and TLS, upgrades and rollback, cloud KMS and Azure Blob; budgets and the hard stop | B-10203–B-10208, B-10602 | 66 | `0NN_cloud_deploy` | Planned |
| 47 | Managed data services; cloud metrics and dashboards; metadata-endpoint hardening; billing ingestion | B-10301–B-10307, B-10702, B-10705, B-10603 | 70 | `0NN_cloud_data` | Planned |
| 48 | GPU compute pools with scale-to-zero and spot; Bedrock, Azure AI Foundry, DigitalOcean GenAI and Workers AI backends; idle savings | B-10401–B-10406, B-10501–B-10504, B-10509, B-10605 | 68 | `0NN_cloud_compute` | Planned |
| 49 | Cloudflare edge and hosting; model pricing, provider guardrails and residency; Cloudflare billing; showback | B-10901–B-10908, B-10505–B-10508, B-10608, B-10604 | 71 | `0NN_cloud_edge_finops` | Planned |
| 50 | Anomaly alerts and the Cloud spend screen; on-prem front-door targets; change trail and runbooks; the cloud screens live; release | B-10209, B-10606, B-10607, B-10703, B-10704, B-10706, B-10801–B-10805 | 55 | — | Planned |

The order follows the dependencies: accounts and credentials (B-100) before any adapter call; the adapter interface
(B-10101) and the fakes (B-10109) before the journal and planner, which every later epic uses; the price catalogue
(B-10601) with the planner, so the first plan already carries an estimate, and budgets (B-10602) before any compute or
data epic can create spend; network foundation (B-10202) before every deployment target and before managed data
(B-103), whose private endpoints live in it; Kubernetes (B-10203) before GPU node groups on EKS, AKS and DOKS
(B-10401); B-43 before any cloud model backend (B-105), which B-105 waits for in Sprint 48 (B-43 shipped in Sprint 35,
so open decision 13 no longer shifts the plan); billing ingestion (B-10603) before showback and anomalies (B-10604, B-10606); Cloudflare's front door
(B-10901, B-10902) before its app tier (B-10905), which reaches its database through a tunnel; and B-109 before the
release (B-108), which depends on it.

---

## P0

### B-100 Cloud accounts and credentials (52 points)

A cloud account is a credential plus a scope: which provider account or subscription, which regions, which data it may
hold. Accounts are platform-wide (owned by system admins; used for deploying Exprsn-AI, platform GPU pools and the own
database) or bound to one tenant (bring your own account: used for that tenant's data connections and model backends,
and shown back to that tenant). New permissions: `cloud:read`, `cloud:deploy`, `cloud:admin`, `finops:read`,
`finops:manage`. New built-in roles: Cloud admin (every cloud permission and `finops:manage`, MFA required), Cloud
operator (`cloud:read`, `cloud:deploy`), FinOps analyst (`cloud:read`, `finops:read`, `usage:read`). Adding or
removing an account, changing its credential mode and raising a region's label ceiling are under dual control. Every
resource Exprsn-AI creates carries the tags `exprsn:managed=true`, `exprsn:account`, `exprsn:deployment`, and where
they apply `exprsn:tenant`, `exprsn:workspace` and `exprsn:pool`, and the generated cloud policies are conditioned on
those tags. New tables: `cloud_accounts`, `cloud_account_regions`, `cloud_credentials` (references only, never values).

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-10001 | Prototype boards (`cloud`, `deployments`, `cloud-data`, `cloud-compute`, `finops`, the Models additions) and the storyboard `design/mockups/cloud.html`; `node build.mjs` and the smoke run clean (done on `design/cloud-2.0`, awaiting review) | Every new board passes the prototype smoke run in light and dark | 5 |
| B-10002 | Cloud accounts: provider (`aws`, `azure`, `digitalocean`, `cloudflare`), scope (platform or one tenant), the provider's own ids (AWS account, Azure tenant and subscription, DigitalOcean team, Cloudflare account and zones), credential mode, default region, state; `GET/POST/PATCH/DELETE /api/admin/cloud/accounts`; the five permissions and three roles; dual control for add, remove and credential-mode changes | A tenant admin cannot add a platform-scoped account, and an account added by one admin is unusable until a second approves it | 8 |
| B-10003 | AWS federation: the account's issuer mints a short-lived JWT (`sub` `cloud-account:<id>`, `aud` `sts.amazonaws.com`) signed in OpenBao transit; `AssumeRoleWithWebIdentity` gives one-hour sessions cached per instance and refreshed at two thirds; a setup helper renders the IAM OIDC provider, the role's trust policy (conditions on `aud` and `sub`) and the read, deploy and billing permission policies conditioned on the `exprsn:*` tags | A role whose trust policy names another `sub` is refused, and no long-lived AWS key exists anywhere for a federated account | 8 |
| B-10004 | Azure federation: a federated identity credential on an app registration or a user-assigned managed identity (`aud` `api://AzureADTokenExchange`); a client assertion buys Entra tokens for ARM, Cost Management and Cognitive Services scopes; the setup helper renders the `az` commands and the role assignments (Reader on the subscription, Contributor on the managed resource groups, Cost Management Reader) | Validation of a federated Azure account succeeds with no client secret stored | 5 |
| B-10005 | A public issuer for federation: the issuer's discovery document and JWKS are published to a static public location (an S3 bucket, an Azure Blob static website, DigitalOcean Spaces or R2) or served on a public path of the console, per the open decision; republished on signing-key rotation with the old key kept until every cached session has ended; a check job compares the published JWKS with the issuer's | Rotating the signing key never fails an `AssumeRoleWithWebIdentity` call, and a stale published JWKS raises an alert | 5 |
| B-10006 | Vaulted credentials: AWS access keys, an Azure client secret or a certificate issued by the Exprsn-AI CA (key held by the signer), DigitalOcean and Cloudflare tokens; stored as `vault:` references under B-17's policies (OpenBao KV when the operator chooses it), sealed, never returned by any route; rotation: AWS automatic (create, verify, switch, delete), Azure through Graph `addPassword`/`removePassword` when the app may, otherwise B-1706 notices; DigitalOcean and Cloudflare tokens by notice and a guided replace; last use shown | An automatically rotated AWS key is in use within one minute and the old key is deleted after the overlap | 8 |
| B-10007 | Validation and permission check: `POST /api/admin/cloud/accounts/:id/validate` calls the identity endpoint (STS `GetCallerIdentity`, ARM subscription get, DigitalOcean `/v2/account`, Cloudflare `/user/tokens/verify`) and checks the actions each feature needs (IAM `SimulatePrincipalPolicy`, ARM permissions list, DigitalOcean token scopes, Cloudflare token policies), reporting what is missing per feature (deploy, data, compute, models, billing, front door) | A token missing one permission shows that permission against the feature it blocks, and that feature's actions are disabled with the reason | 5 |
| B-10008 | Regions, labels and zones: an allow-list of regions per account; each region maps to a zone and a label ceiling (for example `eu-central-1` → zone `cloud-eu`, ceiling `confidential`); `policy.ts` refuses data, pools, model entries or deployments above the region's ceiling; residency rules per label (the open decision's default: `restricted` never in a cloud) | A knowledge base labelled `restricted` cannot be placed on a cloud database, with the policy `explain` naming the region's ceiling | 5 |
| B-10009 | Token-only providers: DigitalOcean (custom-scoped token) and Cloudflare (scoped API token plus the account id) with a permission checklist in the connect wizard; federation shown unavailable with the reason | A Cloudflare token without Containers Edit is accepted for the front door but refused for a Cloudflare app tier, with the missing permission named | 3 |

### B-101 Provider adapter layer and operation journal (68 points)

The engine every other epic uses. A `CloudProvider` adapter per provider maps a small set of resource types onto the
provider's API; the planner compares the desired graph with what the provider reports and produces a diff; the deploy
worker applies it step by step as jobs, journalling every call so that any instance can resume after a crash. Nothing
calls a provider outside an adapter, and every adapter call goes through the egress checks and the rate limiter. New
tables: `cloud_deployments`, `cloud_resources`, `cloud_plans`, `cloud_operations`. New jobs: `cloud.apply`,
`cloud.poll`, `cloud.verify`, `cloud.drift` (scheduled), `cloud.destroy`.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-10101 | `CloudProvider` interface and the four adapters (AWS SDK v3 modular clients, `@azure/arm-*` with a custom `TokenCredential` over B-100, DigitalOcean v2 and Cloudflare v4 over undici); resource types network, subnet, firewall, Kubernetes cluster, node group, VM, container service, database, cache, bucket, DNS record, load balancer, tunnel, secret; each adapter declares what it supports and the rest is `unsupported`; provider endpoints allow-listed in `platform/egress.ts` | An adapter asked for a type it does not support answers `unsupported` and the planner shows it as unavailable, never as an error | 13 |
| B-10102 | Resource graph and journal: desired spec, observed state, provider id, dependencies, protection flag and tags per resource; an append-only operation journal (step, idempotency key, provider client token, provider request id, attempt, state, error) with a summary in the audit chain | Killing the instance mid-apply and starting another resumes from the journal without creating a second copy of any resource | 8 |
| B-10103 | Plan: desired graph against observed → create, update, replace, delete or no-op per resource with field-level changes, the reason for each replace, and the cost delta (B-10601); a plan is stored with its hash, expires after 60 minutes or when the observed state changes, and apply accepts only an unexpired plan's hash | Applying a plan after a resource changed out of band is refused with `plan_stale` and a fresh plan is offered | 8 |
| B-10104 | Apply worker: walks the graph in dependency order with bounded parallelism, one apply per deployment at a time (a lease), every step idempotent (AWS client tokens, Azure PUT by name, DigitalOcean and Cloudflare lookup by tag or name before create); long-running operations polled (`Azure-AsyncOperation`, AWS describe calls and waiters, DigitalOcean actions, Cloudflare async endpoints) with progress through `ctx.progress`; cancel stops after the steps in flight | A retried create step after a lost response adopts the resource it already created instead of making a second one, on all four providers' fakes | 13 |
| B-10105 | Verify: readiness per resource and for the deployment (the app's `/readyz` at its public URL, database and Redis reachable from the app, TLS chain valid for the name, pool instances healthy); a failed verify marks the deployment degraded and offers rollback | A deployment whose app cannot reach its database is never shown healthy | 3 |
| B-10106 | Drift: the scheduled `cloud.drift` reads every managed resource; field-level drift, missing resources and unmanaged resources inside managed groups; per finding revert (plan back to desired), adopt (desired becomes observed) or ignore the field; notices to the deployment's owners | An inbound rule added by hand shows as drift within one schedule interval and revert removes it | 5 |
| B-10107 | Destroy and rollback: reverse-order destroy; protected resources (databases, buckets with data) need a final snapshot and dual control; a failed apply rolls replaceable resources back to the last verified state; an orphan sweep finds tagged resources the journal does not know | Destroying a deployment with a protected database stops at that resource until a second admin approves, and the snapshot exists before deletion | 5 |
| B-10108 | Rate limits and retries: token buckets per account, provider and API class in the shared limiter; retries with jitter honouring `Retry-After` and the providers' throttling signals (AWS throttling errors, ARM `429` and `x-ms-ratelimit-remaining-*`, DigitalOcean `ratelimit-reset`, Cloudflare `429`); a circuit breaker per provider and account; metrics for waits | A burst of 500 reads against the DigitalOcean fake stays under its per-minute limit and every read completes | 5 |
| B-10109 | Test fakes: `server/test/fake-aws.ts` (STS, EC2, EKS, RDS, ElastiCache, Pricing, Cost Explorer, Bedrock), `fake-azure.ts` (Entra token, ARM with async operations), `fake-do.ts` (v2 with actions and rate-limit headers) and `fake-cloudflare.ts` (v4: DNS, tunnels, Workers, Containers, Hyperdrive, R2, AI Gateway) | The cloud suites run in CI with no network access | 8 |

### B-102 Platform deployment (77 points)

Deploying Exprsn-AI itself from the console: a wizard writes a deployment spec, the planner turns it into a graph, the
apply worker builds it. Three compute shapes per cloud (Kubernetes through the existing Helm chart, VMs through the
bare-metal installer, managed container platforms) and Cloudflare's hybrid app tier (B-10905). The first deployment of
a new install is still done by hand (something has to run the console); 2.0.0 deploys additional installs (a second
region, a standby, a lab) and upgrades the ones it built.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-10201 | Deployment spec and wizard API: target provider, account and region; compute shape and size preset (small, medium, large with HA); data tier (provision new, use existing, on-prem); front door (Cloudflare, ACME with provider DNS, bring your own); optional GPU pools; validated against the account's regions, quotas and label ceilings; `POST /api/admin/cloud/deployments` returns a plan | A spec naming a region outside the account's allow-list is refused before any provider call | 5 |
| B-10202 | Network foundation: VPC, VNet or DigitalOcean VPC with private subnets and NAT; security groups, NSGs or cloud firewalls rendered from the zone specs (the NetworkPolicy and nftables rendering of `zones/`); private endpoints for the data tier | The rendered rules for a deployment equal the zone spec's rules, and no data resource has a public address | 8 |
| B-10203 | Kubernetes target: EKS, AKS or DOKS with node groups; a short-lived kubeconfig per apply (an EKS token from STS, an AKS Entra token, the DOKS credentials endpoint); the chart installed by a pinned `helm` binary in the deploy worker with values derived from the spec; secrets from the cloud secret store through the CSI driver or as Kubernetes Secrets; the migrate Job; ingress and load balancer | A medium deployment on each of the three fakes renders the chart with `helm lint` clean and answers `/readyz` | 13 |
| B-10204 | VM target: EC2, Azure VMs or Droplets with cloud-init running the bare-metal installer from a signed release tarball (`install.sh --from-release <url> --sha256 <digest>`, new); IMDSv2 required with hop limit 1; secrets as systemd credentials | A VM built from a tampered tarball refuses to install and the apply fails at verify | 8 |
| B-10205 | Container platforms: ECS on Fargate (task definitions, service, ALB), Azure Container Apps (environment, app, revisions) and DigitalOcean App Platform (app spec); migrations as a one-off task or job; secrets as files where the platform mounts them, otherwise through the signer or OpenBao (open decision 8) | No container platform deployment carries `DATA_KEY` as a plain environment variable | 8 |
| B-10206 | DNS and TLS: records in Route 53, Azure DNS or DigitalOcean DNS; `ACME_DNS_PROVIDER` gains `route53`, `azure-dns` and `digitalocean` beside `rfc2136` and `webhook`; a public CA or the Exprsn-AI CA; renewed certificates pushed to the load balancer (ACM import, Application Gateway, DigitalOcean certificates) by the B-1806 hooks | A certificate renewed by dns-01 on Route 53 is served by the load balancer before the old one expires | 8 |
| B-10207 | Upgrades and rollback: an upgrade plan to a new release by image digest; a database snapshot first; `migrate --check`; rolling update; verify; the app tier rolls back by itself when verify fails; the database rolls back only by restoring the snapshot, under dual control | A failed verify after an upgrade puts the previous image back with no manual step, and the snapshot is listed for restore | 8 |
| B-10208 | Cloud keys and blobs for deployed installs: `KMS_PROVIDER=aws-kms` and `azure-keyvault` (per-tenant keys, wrap and unwrap, signing for audit checkpoints) beside `local` and `openbao`; `BLOB_STORE=azure` (Blob API); AWS S3, DigitalOcean Spaces and R2 already work through `s3` | `kms:rewrap` moves a tenant from `local` to `aws-kms` and `audit:verify` still passes | 13 |
| B-10209 | On-prem targets for the front door only: an existing install (Compose, bare metal, Helm) registered as a deployment without compute so B-109's front door and the drift and spend views apply to it | An on-prem install gets a Cloudflare Tunnel and DNS from the wizard without any compute resource being planned | 6 |

## P1

### B-103 Managed data services (52 points)

Provision or adopt managed databases and caches, and connect them either as Exprsn-AI's own database and Redis or as
data connections. Public access is off by default; every database sits behind a private endpoint in the deployment's
network, and `CONNECTIONS_ALLOWED_HOSTS` follows. pgvector and PostGIS are expected on every managed PostgreSQL offer
(RDS, Aurora, Azure Flexible Server after the `azure.extensions` allow-list, DigitalOcean); the provisioner checks
`pg_available_extensions` instead of trusting the table, and the sandbox e2e (B-10804) records the versions. pgvector
stays the vector store everywhere (Cloudflare Vectorize is not used, B-109).

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-10301 | PostgreSQL family: RDS PostgreSQL, Aurora PostgreSQL, Azure Database for PostgreSQL Flexible Server, DigitalOcean Managed PostgreSQL; version, size, HA, storage, backups, maintenance window, parameter groups; extension check and the provider's allow-list step for pgvector, PostGIS and pg_trgm | Provisioning on Azure allow-lists `vector` before Exprsn-AI's migrations run, and a missing extension stops the plan with its name | 8 |
| B-10302 | As Exprsn-AI's own database: for a new deployment, or moving an existing install (`backup:create`, restore into the managed database, a read-only cutover window, `migrate --check`, switch `DATABASE_URL`); connection limits checked against the pool size; TLS with the provider's CA bundle | An install moved to RDS passes `audit:verify` and keeps every conversation, with the cutover window under the documented bound | 8 |
| B-10303 | MySQL family: RDS MySQL, Aurora MySQL, Azure Database for MySQL Flexible Server, DigitalOcean Managed MySQL; as data connections and as the own database (`DB_CLIENT=mysql`) | The MySQL integration suite passes against a managed MySQL from the sandbox accounts | 5 |
| B-10304 | Document and key-value: Amazon DocumentDB, DynamoDB, Azure Cosmos DB (NoSQL and MongoDB vCore) and DigitalOcean Managed MongoDB as data connections; a MongoDB driver shared with the 1.6 MongoDB work, a read-only DynamoDB driver (Query and PartiQL `SELECT`) and a read-only Cosmos NoSQL driver; query classification, masking and schema sampling as for SQL | A DynamoDB `UPDATE` through the connection is refused by classification before it reaches the provider | 13 |
| B-10305 | Caches as `REDIS_URL`: ElastiCache (Valkey or Redis OSS, cluster mode off), MemoryDB, Azure Cache for Redis or Azure Managed Redis, DigitalOcean Managed Valkey; `rediss://` with the auth token in the vault; a compatibility check for BullMQ and the bus (no cluster mode, `maxmemory-policy noeviction`) | A cache with an eviction policy other than `noeviction` is refused as `REDIS_URL` with the reason | 5 |
| B-10306 | Connect as a data connection: provisioned or discovered (list the account's instances); the private endpoint and the allowed hosts updated together; the admin password in the vault and per-connection users through the B-1704 lease engines; RDS IAM authentication and Entra authentication for Azure PostgreSQL as the federated option | A discovered RDS instance becomes a data connection whose queries run as a leased user that is dropped when the lease ends | 8 |
| B-10307 | Backups and protection: provider snapshots scheduled and listed with their cost, restore to a new instance, deletion protection on by default, a final snapshot on destroy, retention shown | A protected database cannot be destroyed from any route without its final snapshot | 5 |

### B-104 GPU compute pools (39 points)

Cloud GPUs running Ollama join the gateway as ordinary pools, so profiles, placements, labels and the memory planner
treat them like on-prem nodes. Scale-to-zero is the default for cloud GPU pools; the gateway, which already sees the
queue, decides when to scale. Cloudflare offers no GPU pools (its models are a backend, B-10509).

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-10401 | Cloud node groups as pools: EKS managed node groups, AKS GPU node pools, DOKS GPU node pools, or standalone GPU VMs (EC2, Azure NC and ND series, DigitalOcean GPU Droplets) set up as in `deploy/baremetal/ollama-node.md`; instances register themselves with mTLS certificates from the Exprsn-AI CA; `instances.deploy` gains `cloud` and pools gain the node group's id, size limits and price | A node group scaled from one to two nodes shows two healthy instances on Pools with no manual registration | 13 |
| B-10402 | Scale-to-zero and autoscale: minimum, maximum and desired per node group; scale to zero after the idle minutes with no slot leases; a request on a cold pool waits in the queue with a cold-start estimate, or takes the profile's fallback when the estimate exceeds the wait; scale up on queue depth | A chat on a scaled-to-zero pool either answers after the cold start or answers from the fallback profile, and never fails for lack of capacity | 8 |
| B-10403 | Spot and preemptible capacity: EC2 Spot and Azure Spot with on-demand fallback; interruption notices (the EC2 two-minute notice and rebalance recommendation, Azure Scheduled Events `Preempt`) drain the instance through the gateway; DigitalOcean offers on-demand only | An interruption notice drains the instance before it is reclaimed and its streams resume on another instance | 5 |
| B-10404 | Model warm-up: approved placements pulled from the registry mirror at boot, or from a pre-seeded volume snapshot; time from boot to healthy recorded per node group | A new node serves its placements without a pull from outside the mirror | 5 |
| B-10405 | GPU quotas and capacity: provider quotas checked at plan time (AWS Service Quotas for G and P instances, Azure family vCPU quotas, DigitalOcean GPU limits); capacity errors fall back to the next allowed instance type or zone | A plan that exceeds the GPU quota is refused at plan time with the quota's name and the request link | 5 |
| B-10406 | Pools screen: the cloud node group card with size controls, cost per hour, the idle timer and spot state | Scaling a node group to zero from Pools takes effect and is audited | 3 |

### B-105 Cloud model backends (42 points)

Depends on **B-43**. Bedrock gets its own `ModelServer` because its Converse API is not Chat Completions; Azure AI
Foundry and Azure OpenAI deployments, DigitalOcean GenAI serverless inference and Cloudflare Workers AI are `kind:
openai` instances with provider-specific authentication. Cloud entries are `format: server` catalogue entries with a
recorded licence and terms, a conformance run, dual-control approval and a label ceiling no higher than their region's.
Exprsn-AI's guardrails, profiles, fallback, metering and its own `/v1` API stay authoritative; provider guardrails and
Cloudflare's AI Gateway (B-10908) are extra layers.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-10501 | Bedrock `ModelServer`: Converse and ConverseStream (messages, system, tools and tool results, streaming deltas, usage), embeddings through InvokeModel (Titan, Cohere), SigV4 with the account's session, the regional endpoint; inference profiles recorded with the regions they may route to | A conversation on a Bedrock profile streams, calls a read-only tool and is metered like an Ollama turn, against `fake-aws.ts` | 8 |
| B-10502 | Azure AI Foundry and Azure OpenAI: deployments as `kind: openai` instances with an Entra token (federated) or an API key from the vault; deployments discovered through ARM; content filter results mapped onto guardrail decisions | A response blocked by Azure's content filter is recorded as a guardrail decision with the filter's category | 5 |
| B-10503 | DigitalOcean GenAI: serverless inference as a `kind: openai` instance with a model access key from the vault; GenAI agents callable as registry tools through their endpoint and key | A DigitalOcean agent published as a tool passes the tool-call checkpoint like any other tool | 5 |
| B-10504 | Cloud catalogue import: list what each account offers (Bedrock `ListFoundationModels` with model access state and inference profiles, Azure deployments, DigitalOcean models, Workers AI models) and register drafts with `format: server`, provider, account, region, terms and a label ceiling capped at the region's; the conformance run on that instance; approval as B-4304 | Importing a Bedrock model registers a draft that cannot be approved above its region's ceiling | 5 |
| B-10505 | Per-model pricing: price per million input, output and cached tokens, per embedding token or per Workers AI neuron, versioned with an effective date, from the AWS Price List API, the Azure Retail Prices API, and the DigitalOcean and Cloudflare price sheets (no price API); `usage_records` gains `cost_micros`, `currency` and `price_id`, priced at metering | A day's cloud-model cost on the usage report equals the sum of its usage records' `cost_micros` | 5 |
| B-10506 | Provider guardrails as an extra layer: a Bedrock Guardrail attached through `guardrailConfig` or called with `ApplyGuardrail`; its interventions recorded as guardrail decisions; Exprsn-AI's checkpoints still run before and after | Turning off the Bedrock Guardrail never turns off an Exprsn-AI rule | 5 |
| B-10507 | Residency and egress: cloud model calls leave only through the gateway's egress zone; each entry lists its allowed regions; cross-region and global inference profiles are refused above `internal` by default; the account's data terms (no training, retention) recorded as an attestation | A `confidential` conversation is never routed to a global inference profile | 3 |
| B-10508 | Models screen: the provider filter, the cloud catalogue import, and price, region, residency, guardrail layer and AI Gateway on the model card; the prototype board and the live screen in the Playwright suite | Importing and approving a Bedrock model works end to end in the e2e suite with no axe or reflow finding | 3 |
| B-10509 | Workers AI: Cloudflare's OpenAI-compatible endpoint as a `kind: openai` instance with the account's scoped token; neurons converted to cost through B-10505 | A Workers AI turn is metered with its neurons and its cost on the usage record | 3 |

### B-106 FinOps (48 points)

Every plan carries an estimate, every account a budget, every cloud bill comes back as daily rows, and every cost is
shown back to the workspace and tenant that caused it. This complements 1.6.0's usage and cost analytics (B-74) and
1.1.0's price books and statements (B-13); it does not replace them. New tables: `cloud_prices`, `cloud_budgets`,
`cloud_costs`, `cloud_allocation_rules`, `cloud_anomalies`, `model_prices`.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-10601 | Price catalogue and estimates: the AWS Price List Query API, the Azure Retail Prices API, the DigitalOcean sizes API and a maintained price sheet for what has no API (DigitalOcean databases, Cloudflare), cached daily; an estimate per plan (monthly, with its assumptions: hours, storage, egress) and the delta for upgrades | Every plan shows a monthly estimate and lists the prices it used with their dates | 8 |
| B-10602 | Budgets: a monthly budget per account with alerts at 50, 80 and 100 % of actual and of forecast spend, as notices and webhooks; a hard stop past 100 %: plans that add monthly cost are refused with `budget_exceeded`, scale-down and destroy always allowed; an override under dual control, with a reason, for at most 7 days | A plan adding a database to an account over budget is refused, and the same plan is accepted after a second admin approves an override | 8 |
| B-10603 | Billing ingestion: AWS Cost Explorer `GetCostAndUsage` daily by tag (or CUR 2.0 exports, open decision 9), Azure Cost Management queries by tag, DigitalOcean balance, billing history and invoice CSV; daily rows in `cloud_costs`; estimate against actual per deployment | Yesterday's AWS cost for a deployment equals Cost Explorer's figure for its tag | 8 |
| B-10604 | Showback: allocation by the `exprsn:tenant`, `exprsn:workspace` and `exprsn:pool` tags; shared costs (clusters, databases, the front door) split by a rule per cost type (GPU time, tokens, storage); a monthly showback per workspace and tenant; CSV export; optional lines on the B-13 statements | A month's showback across all workspaces plus the unallocated line equals the month's ingested total | 8 |
| B-10605 | Idle GPU savings: idle hours avoided by scale-to-zero and their estimated saving per pool and month | The savings report for a pool equals its scaled-down hours times its on-demand price | 3 |
| B-10606 | Anomaly alerts: daily spend per account and service against a 14-day baseline; an alert names the top contributors (service, region, deployment, tag) | A tripled NAT gateway cost raises one alert naming the deployment | 5 |
| B-10607 | Cloud spend screen live: overview, budgets, showback, anomalies, model tokens and billing sources, in the Playwright suite | Every state on the board is reachable in the e2e suite in light and dark | 5 |
| B-10608 | Cloudflare billing: the billing API and the GraphQL Analytics API for Workers, Containers, R2, Tunnel and Workers AI neurons, as daily rows | Workers AI neurons in the analytics for a day match the metered neurons in `usage_records` within 1 % | 3 |

### B-107 Cloud operations, observability, audit and runbooks (29 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-10701 | Audit: `cloud.*` events for accounts, credentials, plans, applies, resources, drift decisions, destroys and budget overrides, each with the provider's request id; dual-control proposals as for identity changes | Every resource Exprsn-AI created can be traced to the audit entry and journal step that created it | 3 |
| B-10702 | Metrics, dashboards and alerts: operations by state, apply duration, throttling waits, drift findings, budget burn, GPU idle time; Prometheus rules and `deploy/observability/grafana/exprsn-ai-cloud.json` | promtool passes the new rules and the dashboard renders against the test metrics | 5 |
| B-10703 | Out-of-band change trail: CloudTrail `LookupEvents`, the Azure Activity Log and Cloudflare audit logs for managed resources, shown on each drift finding ("changed by …") | A drift finding on AWS names the principal and time of the change that caused it | 5 |
| B-10704 | Runbooks in `docs/runbooks/`: credential compromise (cut the trust or revoke the token), a stuck operation, a region outage and failover to a standby, budget exceeded, a spot interruption storm, drift, restoring a managed database from a snapshot | Each runbook is walked through once against the sandbox accounts | 3 |
| B-10705 | Security: instance metadata endpoints (`169.254.169.254`, `fd00:ec2::254`) refused by every egress check; IMDSv2 required on everything Exprsn-AI builds; least-privilege policies documented and tested; the cloud plane's threat model in `docs/security.md` | A workflow HTTP step, an MCP server or a webhook pointed at the metadata address is refused | 5 |
| B-10706 | The cloud screens live (Cloud accounts, Deployments, Cloud data, Cloud compute; Cloud spend is B-10607), in the Playwright suite with axe-core and the reflow checks | Every state on the boards is reachable in the e2e suite with no axe or reflow finding | 8 |

### B-109 Cloudflare edge and hosting (44 points)

Cloudflare is the edge and, optionally, the app tier, never a full platform host: it cannot run PostgreSQL, Redis or
Ollama GPUs, so a Cloudflare deployment is always hybrid, with its data and GPU tiers on AWS, Azure, DigitalOcean or
on-prem. Wherever a provider is picked, Cloudflare's unsupported tiers are shown disabled with the reason ("Runs the
app tier only; pick a provider for data and GPUs"), not hidden. Decisions recorded 2026-10-05: Vectorize is not used
(pgvector stays the vector store); Workers KV, Queues and Durable Objects are out of scope as data services (KV is no
substitute for Redis); D1 is only ever a read-only data connection; Cloudflare Access is an extra layer and Exprsn-AI's
identity stays authoritative; AI Gateway never replaces Exprsn-AI's gateway or profile fallback.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-10901 | Front door for any deployment (cloud or on-prem): Cloudflare DNS for the deployment's names and edge TLS (Full strict to the origin), as an alternative to ACME; `TRUST_PROXY` set for Cloudflare and the client address taken from `CF-Connecting-IP` only behind it | A deployment switched from ACME to the Cloudflare front door keeps answering on its name with no certificate gap | 5 |
| B-10902 | Cloudflare Tunnel: a named tunnel created through the API, `cloudflared` run beside the app (a Deployment in the chart, a systemd unit for bare metal, a Compose service), its token in the vault; no inbound port open at the origin; WebSocket upgrades for `/socket.io/` | An install behind a tunnel has no listening public port and Socket.io still connects | 5 |
| B-10903 | WAF and rate limits: the managed ruleset plus custom rules for `/api`, `/v1` and sign-in that mirror the server's own limits, with `/socket.io/` and streaming responses exempt from buffering rules | A burst of sign-in attempts is stopped at the edge before the server's own throttle counts them | 3 |
| B-10904 | Cloudflare Access in front of the admin console (optional): an Access application for the console with Exprsn-AI's OIDC provider or the tenant's IdP; `/v1`, the OIDC and SAML endpoints, `/.well-known/`, the ACME challenge path, webhooks and public share links excluded; the server may also check `Cf-Access-Jwt-Assertion` as an extra condition, never instead of its session | A user who passes Access still has to sign in to Exprsn-AI, and a `/v1` client never sees Access | 5 |
| B-10905 | Cloudflare app tier (hybrid): the signed image on Cloudflare Containers behind a Worker, the console's static assets on Workers static assets, PostgreSQL through Hyperdrive (to a managed database on another provider, or on-prem through the tunnel), Redis required from a managed cache on another provider (open decision 19 on how Containers reach it), blobs on R2; the planner refuses a Cloudflare app tier without both | A Cloudflare deployment plan without a Redis on another provider is refused with that reason | 13 |
| B-10906 | R2 as an object store: buckets provisioned with an EU or FedRAMP jurisdiction where residency needs it; used through `BLOB_STORE=s3` for files, backups, training artefacts and export bundles | A backup written to R2 restores with `backup:restore` | 3 |
| B-10907 | D1 as a read-only data connection: the D1 query API, SQLite dialect, the same classification that refuses writes, masking and schema listing; never offered as Exprsn-AI's own database | An `INSERT` through a D1 connection is refused before it reaches Cloudflare | 5 |
| B-10908 | AI Gateway: an optional proxy in front of every cloud model call (Bedrock, Azure, DigitalOcean, Workers AI) per backend, for caching, logs, rate limits and provider fallback; caching and logging off by default for anything above `internal`; Exprsn-AI's profile fallback still decides | A `confidential` turn through AI Gateway leaves no prompt in the gateway's logs, and an AI Gateway fallback never selects a model the profile does not allow | 5 |

## Release

### B-108 Release 2.0.0 (23 points)

Depends on B-109 and on every epic above.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-10801 | Migrations and the upgrade path from 1.x: the cloud migrations (numbered when scheduled, open decision 12), `migrate --check`, `usage_records` cost columns null for old rows, renamed settings accepted with a deprecation warning for one minor release | A 1.6 database upgrades to 2.0.0 and back to a 1.6 snapshot with `migrate --check` clean at each step | 5 |
| B-10802 | Docs: `docs/cloud.md` (accounts, federation setup per provider, the permission policies, regions and labels, Cloudflare front door), the cloud section of `docs/deploy.md`, `docs/api.md`, `docs/openapi.json`, `docs/permissions.md` | Every route and permission added in 2.0.0 is in the docs and the generated permissions file | 5 |
| B-10803 | Security review: the ASVS delta, the cloud-plane threat model (confused deputy, credential theft, metadata endpoints, cross-tenant accounts), a review of every generated IAM, Azure RBAC and token policy, and a test of the credential paths | No finding above low is open at release, or each is accepted in `docs/security.md` | 5 |
| B-10804 | End-to-end against sandbox accounts: a nightly job on dedicated AWS, Azure, DigitalOcean and Cloudflare sandbox accounts with budget caps: deploy small, verify, introduce drift, revert, upgrade, destroy; a sweeper deletes anything tagged and older than a day | Seven consecutive nightly runs pass with nothing left in the accounts | 8 |
| B-10805 | Version `2.0.0`, the CHANGELOG with the breaking changes, upgrade notes, the known-gaps sections updated as each item lands (Sprint 50) | — |

---

## Still deferred

| Item | Why |
| --- | --- |
| Google Cloud | Not requested; the adapter interface leaves room for it |
| Terraform or OpenTofu export of a deployment | Native SDKs were chosen; an export could follow if operators ask |
| Bootstrapping the first install from a laptop CLI | 2.0.0 deploys from a running console; a first-install CLI is a later item |
| Cloudflare Vectorize, Workers KV, Queues, Durable Objects as data services | Decided out of scope: pgvector stays the vector store and Redis stays required |
| Multi-cloud active-active for one install | Standby and second-region deployments only; one database writer per install |
| Reserved instances and savings plans purchasing | Shown in billing data; buying commitments stays with finance |

## Open decisions

Everything below was assumed so the design could proceed; each names the assumption the boards use.

- [ ] 1. Regions offered first. Assumed: AWS `eu-central-1`, `eu-west-1`, `us-east-1`, `us-west-2`; Azure
  `swedencentral`, `westeurope`, `eastus2`; DigitalOcean `ams3`, `fra1`, `nyc3`, `sfo3`, `tor1`; Cloudflare's global
  edge with R2 jurisdictions. GPU availability differs per region and is checked at plan time (B-10405).
- [ ] 2. Public issuer for federation (B-10005). AWS and Entra fetch the issuer's discovery document and JWKS from the
  internet. Assumed: publish them to a static public bucket under a separate issuer URL (the console stays private;
  signing stays in OpenBao transit). Alternatives: expose only those two paths of the console publicly, or per-tenant
  issuers for tenant-scoped accounts (the existing `<issuer>/t/<slug>` scheme).
- [ ] 3. Signing algorithm for Entra. The issuer signs with ES256 today; if Entra's federated credentials accept only
  RS256, the issuer gains an RS256 key used only for the Azure audience. To be confirmed against the sandbox tenant.
- [ ] 4. Data residency per label. Assumed: `public` and `internal` anywhere in the account's allow-list;
  `confidential` only in regions mapped to the tenant's residency (an EU tenant to EU regions); `restricted` never in
  a cloud unless a platform admin overrides it under dual control.
- [ ] 5. Default label ceiling for cloud model entries. Assumed `internal`, raised to `confidential` per entry once the
  account's data terms are attested (B-10507); never `restricted`. Cloudflare's edge sees decrypted traffic, so a
  deployment behind the Cloudflare front door is assumed capped at `confidential`.
- [ ] 6. Tenant-scoped accounts (bring your own account). Assumed allowed, created by tenant admins holding
  `cloud:admin` in their tenant, limited to data connections and model backends; deploying Exprsn-AI stays
  platform-only.
- [ ] 7. Helm in the deploy worker. Assumed a pinned `helm` binary in the worker image (the chart stays the single
  source). Alternative: manifests pre-rendered at release time and applied with server-side apply.
- [ ] 8. Secrets on platforms without file mounts (App Platform, some Container Apps and ECS setups). Assumed the signer
  or OpenBao holds `DATA_KEY`, since production refuses it inline. Alternative: cloud KMS (B-10208) for every container
  deployment.
- [ ] 9. AWS billing source. Assumed Cost Explorer `GetCostAndUsage` (simple, daily, charged per request). Alternative:
  CUR 2.0 data exports to S3 (hourly, cheaper at scale, needs Parquet parsing).
- [ ] 10. Hard-stop semantics. Assumed: scaling a GPU node group above its minimum counts as adding cost and is refused
  past 100 %; scaling down, destroying and upgrades with a zero or negative delta are always allowed.
- [ ] 11. Breaking changes that justify 2.0. Candidates: the gateway's `ModelServer` interface (B-43) replacing direct
  `OllamaClient` use; the bare-metal installer installing from signed release tarballs by default (building from a
  checkout behind `--from-source`); the Helm chart's secrets values gaining a provider (chart major version 2); metadata
  endpoints refused by every egress check; production refusing cloud credentials in the environment. If the owner
  judges these not breaking enough, this ships as 1.8.0 with the same content.
- [ ] 12. Migration numbers. The boards use `0NN_cloud_*` placeholders; 1.5.0 used up to `036c` and 1.6.0's Sprint 35
  `037` to `037d`, and the rest of 1.6.0 and 1.7.0 add more, so the numbers are fixed when Sprint 44 starts.
- [x] 13. B-43 scheduling. B-105 needs B-43's `ModelServer` interface and `kind: openai`. Settled: B-43 shipped in
  1.6.0's Sprint 35 (B-4301 to B-4307).
- [ ] 14. Cloud KMS providers (B-10208) in 2.0.0 or a 2.1. Assumed 2.0.0, since container deployments need somewhere to
  keep `DATA_KEY` other than the environment.
- [ ] 15. Write access through document and key-value connections. Assumed read-only for DynamoDB, Cosmos DB and D1,
  as for SQL connections today.
- [x] 16. Sprint numbering. Settled 2026-10-07: 1.6.0 ends at Sprint 39 and 1.7.0 at Sprint 43, so 2.0.0 is Sprints 44
  to 50 (it was 40 to 46).
- [ ] 17. Currency. Assumed each account's billing currency, USD by default, with no conversion; showback across
  accounts in different currencies is shown per currency.
- [ ] 18. Sandbox accounts for the nightly e2e (B-10804): who owns them and their monthly cap. Assumed four dedicated
  accounts capped at $500 a month each.
- [ ] 19. How Cloudflare Containers reach Redis on another provider. Assumed a TLS endpoint with authentication and an
  IP allow-list of Cloudflare's egress ranges, until Cloudflare's private networking to a VPC is confirmed for
  Containers; a cache reached only through a tunnel would need a TCP proxy in the container.
- [ ] 20. Cloudflare Access identity source. Assumed Exprsn-AI's own OIDC provider as Access's IdP, so one sign-in
  identity serves both layers.

## Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Provider API drift | An SDK or API change breaks an adapter between releases | Adapters pinned to SDK versions, the fakes updated from recorded responses, the nightly sandbox e2e (B-10804) |
| Leaked or orphaned resources | A failed apply or a crash leaves billed resources nobody tracks | Tags on everything, the journal, the orphan sweep (B-10107), budgets with a hard stop (B-10602) |
| Over-privileged credentials | A compromised Exprsn-AI instance can do anything in the cloud account | Tag-conditioned policies, separate read, deploy and billing tiers, federation with one-hour sessions, the credential-compromise runbook |
| Cost surprises | GPU nodes or NAT traffic run up a bill before anyone looks | Estimates on every plan, scale-to-zero by default, 50/80/100 % alerts, anomaly alerts |
| Data residency | A label's data reaches a region or an edge it may not | Region ceilings in `policy.ts`, cross-region model profiles refused above `internal`, R2 jurisdictions, AI Gateway logging off above `internal` |
| Public issuer exposure | The federation issuer's JWKS must be reachable from the internet | Only discovery and JWKS are published, statically; signing keys never leave OpenBao |
| Cloudflare as a hybrid host | Latency between Containers and a database in another provider, and Redis reachability | Hyperdrive pooling and caching, a region close to the data tier, decision 19 before B-10905 starts |
| Scope | 474 points over seven sprints with four providers | The 2.1 fallback list in the size paragraph; each provider's adapter can ship behind a flag |
