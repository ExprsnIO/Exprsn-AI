# Changelog

## Unreleased

### Docs portal (2026-10-26)

- **Docs** (Knowledge › Docs, `#/docs`): documentation sites made from knowledge bases. A site's pages are the bases'
  published references, browsed as a tree with breadcrumbs, a table of contents, page links, backlinks and earlier
  versions; with the Library on, the bases' other documents (crawled pages, files) are listed by category and read as
  pages too; search covers the site and points at pages. Editors open a page in Knowledge to propose a revision.
- **Access follows the knowledge bases**: a reader sees only bases, references and documents they can already read
  (labels, publication, row access); a site of bases they cannot read is not listed. Curators (`docs:manage`, new,
  in the Knowledge curator role) make and change sites; audited `docs.site.*`.
- Pages are rendered on the server (`docs/render.ts`) from the parsed Markdown with all text escaped; `[[slug]]` and
  bare-slug links become links within the site. Migration `170_doc_sites`; routes under `/api/docs` (docs/api.md).

### Schema editing through Connections (2026-10-26)

- **Edit existing objects in the designer's forms.** The Schema designer opens on the connection's objects (tables,
  views, routines, collections, indexes, queues) with Edit and Drop. A table opens in the create form, prefilled from
  the database (`GET …/objects/describe`): add, drop (struck through, with Undo) and rename columns; change a type,
  nullability, default or comment; change the primary key, unique and foreign keys and checks; rename the table; a
  Changes list shows what will happen. Indexes are replaced (dropped and created); procedures and functions are
  replaced (MySQL: dropped and created). Non-SQL: MongoDB validators (`collMod`), OpenSearch new fields and replicas,
  DynamoDB billing, capacity, indexes and TTL, Cosmos DB TTL and indexing, Redis consumer group start ids.
- **Each vendor's ALTER syntax** (`connections/ddl-edit.ts`): PostgreSQL `ALTER COLUMN … TYPE … USING`, MySQL
  `MODIFY COLUMN` with the whole definition, SQL Server default constraints and `sp_rename`, Oracle `MODIFY (…)`,
  Snowflake and BigQuery widening only, SQLite add, drop and rename only.
- **Drops** of tables, views, indexes, routines, schemas and datasets, collections, search indexes, DynamoDB tables and
  indexes, Cosmos containers and databases, InfluxDB databases, Redis consumer groups, RabbitMQ queues, exchanges and
  bindings, with CASCADE where the database has it.
- **Safety.** Edits are diffed against the object described from the database at preview and again at apply (a change
  in between is refused); changes that lose data need the object's name typed back; edits and drops act only on
  allow-listed objects, and the allow-list follows renames and drops. Drivers gained `describe` and `routines`
  (`parseType` reads each vendor's type text into the designer's types).
- New routes `GET /api/admin/connections/:id/objects` and `…/objects/describe`; `confirm` on apply.

### Schema changes and queues through Connections (2026-10-26)

- **Schema designer** (Connections, a data connection's new tab): create tables, indexes, stored procedures,
  functions and datasets (schemas, databases) on PostgreSQL, MySQL, SQL Server, Azure SQL, Oracle, Snowflake,
  BigQuery and Cloudflare D1; collections and indexes on MongoDB, DocumentDB and the Cosmos DB and DigitalOcean
  MongoDB services; indexes with mappings on OpenSearch; tables and global secondary indexes on DynamoDB; containers
  and databases on Cosmos DB for NoSQL; databases on InfluxDB 1.x and 3. Column types are each vendor's own
  (`connections/ddl-types.ts`: `varchar(n)`, `NVARCHAR(MAX)`, `VARCHAR2(n)`, `NUMBER(p, s)`, `BIGNUMERIC(p, s)`,
  `TIMESTAMP(6) WITH TIME ZONE`, `ENUM(…)`, `UNSIGNED`, arrays, identity columns), with their limits checked. The
  console sends a structured definition; the server writes the statements (`connections/ddl.ts`), shows them in a
  preview, and runs exactly the previewed plan.
- **A separate admin account.** Changes run only on a connection's admin account (sealed, or a `vault:` reference),
  never on the read-only account, which queries keep using. Setting it and applying need the new permission
  `connections:ddl` (Connection admin) and a recent sign-in; a change acting on an existing object needs it on the
  allow-list; every change is audited with its statements (`connection.ddl.*`). Migration `169_connection_admin_accounts`.
- **Queues tab** for Redis and RabbitMQ: allow-listed queues with depth, in-flight, consumers and rates; Redis lists,
  streams with their consumer groups (pending, lag), BullMQ queues by state and pub/sub channels; RabbitMQ queue
  type, arguments, policy and dead-letter exchange. Create a Redis stream consumer group, or a RabbitMQ queue
  (classic, quorum or stream, with only the arguments valid for the type), exchange or binding.
- **Categories.** The connection list is grouped: Relational databases, NoSQL and search, Messaging and cache,
  Time series, REST APIs (REST and OData) and Non-REST APIs (GraphQL and SOAP). `category` on connections and the
  engine catalogue, which also carries each engine's `designer` (kinds, types, languages, index methods).
- New routes: `PUT`/`DELETE /api/admin/connections/:id/admin-credential`, `POST …/ddl/preview`, `POST …/ddl/apply`,
  `GET …/queues` (docs/api.md). Security notes and known gaps: docs/security.md.

### Settings in tabs (2026-10-21)

- **Settings** (`web/js/screens/settings.js`) is tabbed: Profile (account, email address, password, public profile,
  status), Preferences (appearance, chat profiles, notifications), Security (second factors and trusted devices,
  sessions, devices, certificates), Apps and keys (API keys, app passwords for DAV clients, connected applications,
  MCP access, with a count of MCP calls waiting) and Linked accounts (AT-Protocol account, did:exprsn; hidden when
  neither applies). The email address left the Security card for its own card on Profile. The tab is `?tab=` in the
  address; the MCP OAuth return lands on Apps and keys and the AT-Protocol link return on Linked accounts. Panels
  from other files (`App.settingsPanels`) name their tab (`tab:`), and only the shown tab's panels are drawn and
  load. The e2e specs that use Settings open the tab they need. No server change.

## 2.0.0 "GM" (2026-10-21)

The cloud epic (Sprints 56 to 62, `Backlog-1.9.99-final.md`, planned as 1.9.99-final): cloud accounts and federation for AWS,
Azure, DigitalOcean and Cloudflare; deployments with plan, apply, verify, drift, destroy and upgrades on Kubernetes, VMs
and container platforms; managed databases and caches; GPU pools with scale-to-zero and spot; cloud model backends with
per-model prices, provider guardrails and residency; the Cloudflare front door and app tier; costs, budgets, showback
and anomalies; the cloud console screens. Release notes, breaking changes and upgrade notes: `docs/release-2.0.0.md`.
The owner named it "GM" and chose 2.0.0 over 1.0.0-GM, which semantic versioning orders below 1.9.9-qa. Everything
below, down to 1.9.9-qa, was listed under Unreleased until this release.

### Admin accounts with platform CA tokens, second factor by default (2026-10-21)

- **Platform CA tokens and admin roles**: a token minted from an Exprsn platform login verified with a second factor
  carries the CA's signed `mfa: true` (the platform stamps it, a token minted with such a bearer inherits it, and a
  refresh without one drops it). Exprsn-AI counts such a v2 token as MFA-verified, so admin roles that need a second
  factor now work with it; the CA's answer must agree (`claims_mismatch`). Any other token still gets `403`
  `step: mfa` for those roles. A store can waive this with the new `adminTokensWithoutMfa` (default false; "Admin
  tokens without a second factor" under the store's advanced API token settings). `docs/identity.md`. No migration.

### The cloud screens live (Sprint 62, B-10706)

- **Deployments**, **Cloud data** and **Cloud compute** are live console screens (`web/js/screens/deployments.js`,
  `cloud-data.js`, `cloud-compute.js`) from their boards, and **Cloud accounts** is brought to its board: credential
  state and rotation, the federation issuer, the setup helper's output and Discover data services. Deployments has the
  wizard from spec to a plan with its estimate (and on-prem registration), plan review with field changes and
  blockers, apply by hash after a fresh sign-in, the journal, verify, drift with who changed it, destroy with a second
  admin's approval of protected resources, releases, upgrades and snapshots, and the front door. No migration, no new
  route.
- e2e: `e2e/cloud-seed.ts` seeds an account, three deployments (a plan, a drift finding, a managed database) through
  the real services against the DigitalOcean fake; `zz-cloud-screens.spec.ts` covers every design state and the
  primary flows. The seeded GPU deployment's ids are now valid ULIDs (they were refused by the routes' id checks).

### Release security review, runbooks and the nightly sandbox job (Sprint 62, B-10803, B-10704, B-10804; migration `167_cloud_sandbox_flag`, not registered yet)

- **Security review (B-10803)**: the ASVS delta of the cloud epic (`docs/asvs.md`) and the findings, fixed and accepted
  with their severity, in `docs/security.md` ("The release security review of the cloud epic"). Fixed:
  - the generated AWS deploy policy allows tagging only at create time (`ec2:CreateAction`, `ecs:CreateAction`) or on
    resources that already carry the account's tags (`ExprsnRetagOwn`, which also holds `s3:PutBucketTagging`), so a
    stolen session can no longer tag a foreign resource as managed and then delete it; `ssm:GetParameters` is limited
    to the public AMI parameters. **Re-render the policies** (`GET /api/admin/cloud/accounts/:id/setup`) and apply them;
  - `CLOUDFLARE_TUNNEL_PEERS` has no default (it was `loopback`, which let a local proxy pass on any client's
    `CF-Connecting-IP`). **An install that runs a tunnel connector and relied on the default must now set it**;
  - Cloudflare Access and the WAF's admin allow-list compare paths in lower case, as the router matches them;
  - removing an account (and refusing or withdrawing its add) removes the staged secrets its references named; a
    credential change, swap or disable drops cached sessions and tokens on every instance;
  - a tenant's own cloud account no longer backs a gateway pool instance or AI Gateway (pools serve every tenant), and
    AI Gateway needs a pool ceiling the Cloudflare account's region admits;
  - GPU node enrolment: a token bound to no node cannot take over another node's instance, and a token presented for
    another node is refused without being spent; an open interruption notice makes further notices for the instance
    the same event, whatever their id;
  - an Azure OpenAI model (or a Bedrock inference-profile ARN) without its own catalogue entry counts as cross-region.
- **Runbooks (B-10704)** in `docs/runbooks/`: credential compromise, a stuck operation, a region outage and failover to
  a standby, budget exceeded, a spot interruption storm, drift, restoring a managed database from a snapshot, and the
  nightly sandbox job; `server/test/runbooks.test.ts` walks the credential compromise, stuck operation, budget and drift
  sequences against the DigitalOcean fake. The walk-through against the sandbox accounts is the owner's.
- **The nightly sandbox job (B-10804)**: `exprsn-ai cloud:sandbox-run --accounts <ids> --as <username> [--dry-run]`
  (also `--mark`, `--unmark`, `--history`) and `.github/workflows/cloud-nightly.yml` (scheduled, disabled until
  `CLOUD_SANDBOX_ENABLED` and its secrets exist): deploy small, verify, drift by hand, revert, upgrade, destroy, and a
  sweeper for what is tagged for the account and older than a day. It refuses accounts not marked sandbox, without a
  budget or at or past it, and never touches untagged resources. Migration `167_cloud_sandbox_flag`
  (`cloud_accounts.sandbox`, `cloud_sandbox_runs`, `cloud_sandbox_seen`) is not registered yet.

### On-prem front doors and the change trail on drift findings (Sprint 62, B-10209, B-10703; migration `165_cloud_change_trail`, not registered yet)

- **On-prem front doors (B-10209)**: an existing Compose, bare-metal or Helm install is registered from the deployment
  wizard (`kind: onprem` on `validate-spec` and `POST /api/admin/cloud/deployments`) as a deployment without compute
  (`compute.shape: none`) on its front door's Cloudflare account: nothing but the tunnel and the proxied record is
  rendered, the plan has no step, and its front door is created with it (or an earlier one for the name attached).
  Applying the front door records the tunnel and the record in the deployment's graph, so drift reads them and the
  deployment shows `applied` with its public URL; spend is the Cloudflare account's by deployment. Deployments carry
  `kind: cloud | onprem` and the list takes `?kind=`.
- **Change trail (B-10703)**: every open drift finding names who changed the resource and when (`changedBy`, with the
  `trail` it came from) from CloudTrail `LookupEvents`, the Azure Activity Log or Cloudflare's audit logs, looked up by
  the drift run for open findings only, in the 24 hours before the finding, at most ten per run and four times per
  finding, through the cloud transport. Exprsn-AI's own changes are marked and not chosen. DigitalOcean: unsupported.
- **Permissions**: `cloudtrail:LookupEvents` joins the AWS `deploy` feature (the read policy),
  `Microsoft.Insights/eventtypes/values/read` the Azure `deploy` feature and custom role, and "Account Settings Read"
  the Cloudflare `frontdoor` token; validate accounts again (and update the policies or token) to keep those features
  `ok`.

### Spend anomalies and the Cloud spend screen (Sprint 62, B-10606, B-10607; migration `166_cloud_anomalies`, not registered yet)

- **Anomaly alerts**: after every billing fetch (and daily), each account's spend per service on the last three
  ingested days is compared with the 14 days before it: the median and the median absolute deviation, so one earlier
  spike does not move the baseline. A day at least four robust deviations, 50 % and 50 (in its currency) above the
  median opens one anomaly per account, day and service, never repeated, naming its top contributors (service,
  deployment, region, `exprsn:` tags) with their extra. It is announced as the audit event `cloud.anomaly.detected`
  (webhooks on `cloud.anomaly.*`), a notice of the new kind `cloud.anomaly` (Administration) to FinOps readers and
  cloud admins, and `exprsn_cloud_anomalies_total`; `exprsn_cloud_anomalies_open` drives the alert
  `ExprsnCloudSpendAnomaly`. Acknowledging (`POST /api/admin/cloud/anomalies/:id/acknowledge`, `finops:manage`) stops
  repeat notices for three days. Fewer than 7 days of history decide nothing.
- **Cloud spend screen** (`#/cloud-spend`, live from the `finops` board): overview with daily spend by provider,
  budgets with the hard stop switch, budget changes and override requests, showback by workspace or tenant with the
  CSV export and statement lines, anomalies with their contributors and acknowledgement, cloud model calls priced at
  metering, and the billing sources with "Ingest now". `GET /api/admin/cloud/spend` serves its overview. The Analytics
  screen's Cloud showback tab stays and is linked from the Showback tab.

### Model pricing, provider guardrails and residency (Sprint 61, B-10505 to B-10508; migration `163_cloud_model_prices`, not registered yet)

- **Per-model prices**: per million input, output and cached tokens (embeddings as input tokens) or Workers AI
  neurons, versioned by the day they take effect, from the AWS Price List API (`AmazonBedrock`), the Azure Retail
  Prices API (Azure OpenAI meters of the deployment's type), the price sheet (DigitalOcean GenAI has no price API) or
  recorded by hand (`PUT /api/admin/cloud/model-prices`). One pricer (`cloud/model-prices.ts`) puts `cost_micros`,
  `currency` and `price_id` on every cloud model record (Workers AI's neurons included, as before) and none on an
  Ollama one; a price change applies from its effective date only. Prompt-cache reads are metered as
  `usage_records.cached_tokens` and priced at the cached rate. The usage report's day cost (`cloudCostMicros`) is the
  sum of its records' `cost_micros`; analytics rows carry `cloudCost`. The sheet's new model entries are marked
  unverified: shown, never used to price a record until confirmed.
- **Bedrock Guardrail as an extra layer**: `PUT /api/admin/cloud/model-servers/:id/guardrail` attaches a Bedrock
  Guardrail to a Bedrock instance, as `guardrailConfig` on Converse and ConverseStream or with ApplyGuardrail on the
  prompt and the answer. Interventions are recorded as guardrail decisions (`provider:bedrock:<category>`, rule
  "Bedrock Guardrail"); Exprsn-AI's checkpoints still run before and after, and turning the guardrail off turns none of
  them off. IAM: `bedrock:ApplyGuardrail`, `bedrock:GetGuardrail`.
- **Residency and egress**: every call on a cloud model server is checked with the request's own label: cross-region
  and global models (inference profiles, Azure data-zone and global deployments, DigitalOcean serverless, Workers AI)
  serve nothing above `internal`; each entry's regions are held to the account's allow-list; once zones are defined, a
  cloud call leaves only from a pool in a zone with egress. The account's data terms, attested by one cloud admin and
  approved by another (`/api/admin/cloud/model-entries/:modelId/attestations`, `/api/admin/cloud/attestations/:id/*`),
  raise a regional entry to `confidential`, never `restricted`; revoking drops it back.
- **Models screen**: a Provider column and filter, the cloud catalogue import (account, region, model access, the
  ceiling, Import as a draft), and on a cloud model's card its price (source, effective date), region, residency and
  attestation, the provider guardrail layer and AI Gateway (`GET /api/admin/cloud/model-cards`). The e2e suite imports,
  evaluates and approves a Bedrock model end to end against the e2e server's Bedrock fake.
- Changed: a cloud listing's own `dataTermsAttested` no longer raises an entry's ceiling (attestation is the
  dual-controlled record); the Sprint 60 catalogue test follows.

### Cloudflare app tier, R2, D1 and AI Gateway (Sprint 61, B-10905 to B-10908; no migration)

- **The Cloudflare app tier (hybrid)**: `compute.shape: cloudflare` in the deployment spec renders, on the front
  door's Cloudflare account, a Worker (the console's static files as Workers static assets, plain settings as
  bindings, secrets as Worker secrets from the vault, the custom domain), the signed image on Cloudflare Containers,
  Hyperdrive to PostgreSQL (the provisioned database or an on-prem one through the tunnel, an existing one directly)
  and an R2 bucket; the data tier stays on AWS, Azure, DigitalOcean or on-prem. Creating the deployment also plans the
  app tier's own deployment on the Cloudflare account. Redis is required from a managed cache on another provider: a
  spec or plan without it is refused with that reason, as is any secret among the Worker's settings. New resource
  types `worker` and `hyperdrive`; Containers as `container_service` (`cloudflare-containers`) in the Cloudflare
  adapter and its fake.
- **R2 as an object store**: buckets provisioned in the EU or FedRAMP jurisdiction where their region (`r2-eu`,
  `r2-fedramp`) or props say (`cf-r2-jurisdiction`); `cloud/r2.ts` gives the endpoint and the `BLOB_STORE=s3`
  settings (`S3_REGION=auto`, path style). A backup written to R2 restores with `backup:restore`. `deletePrefix` on an
  S3 store no longer refuses every prefix.
- **D1 as a read-only data connection**: the engine `cloudflare-d1` (SQLite dialect) over the D1 query API; writes,
  `PRAGMA`, `ATTACH`, schema changes and transactions are refused before anything reaches Cloudflare; masking, the
  allow-list and schema listing as for every SQL engine. Never a `DB_CLIENT`.
- **AI Gateway**: `PUT /api/admin/instances/:id/ai-gateway` puts Cloudflare AI Gateway in front of a Bedrock, Azure
  OpenAI, DigitalOcean GenAI or Workers AI instance; caching and logs follow the turn's label (off above `internal`
  by default, never for `restricted`); an answer from a gateway-side fallback is refused, so the profile's fallback
  decides; `PUT /api/admin/cloud/accounts/:id/ai-gateways/:gateway` writes the gateway's rate limits.
- Tests never reach a real cloud: `gateway.ai.cloudflare.com` and `*.workers.dev` join the offline guard, and the S3
  store's requests go through it too.

### The Cloudflare front door (Sprint 61, B-10901 to B-10904; migration `161_cloud_edge`, not registered yet)

- **DNS and edge TLS for any install** (`cloud/edge.ts`, `s.cloud.edge`, routes under `/api/admin/cloud/edge`): a
  front door for a cloud deployment or an install without one, as an alternative to ACME. Apply checks the edge
  certificate, sets SSL to Full (strict), checks the origin's certificate, and switches a DNS-only (ACME) name in place
  (proxied first, then re-pointed) so it never lacks a record or a certificate. Capped at `confidential`.
- **The client address**: `cloudflare` in `TRUST_PROXY` makes `CF-Connecting-IP` the client only from Cloudflare's
  ranges (a dated list shipped as data, `CLOUDFLARE_IP_RANGES` to replace it) or the tunnel connector
  (`CLOUDFLARE_TUNNEL_PEERS`); from anyone else the header is dropped. Without the keyword nothing changes.
- **Cloudflare Tunnel**: a named tunnel through the API, its token read once into the vault and written to a 0600
  file by `exprsn-ai cloud:tunnel-token`; `cloudflared` beside the app with no inbound port: the chart's
  `cloudflared.enabled` (its own Deployment and NetworkPolicy; `ci/tunnel-values.yaml`),
  `deploy/baremetal/exprsn-cloudflared.service`, `deploy/docker/compose.tunnel.yml`; WebSocket upgrades for
  `/socket.io/`.
- **WAF and rate limits** (`cloud/edge-waf.ts`): managed rulesets, custom rules, and rate limits for sign-in,
  `/api/auth`, `/v1` and `/api` mirroring the server's limits per plan (sign-in one attempt below the lockout, so a
  burst stops at the edge first); `/socket.io/` and streams exempt from buffering and caching; others' rules kept.
- **Cloudflare Access** (optional): applications for the admin console with Exprsn-AI's OIDC provider or the
  account's IdP, the machine and public paths excluded; the server's own `Cf-Access-Jwt-Assertion` check
  (`CLOUDFLARE_ACCESS_AUD`, `CLOUDFLARE_ACCESS_TEAM_DOMAIN`, `CLOUDFLARE_ACCESS_SCOPE`) as an extra condition, never a
  sign-in.

### Cloudflare billing and showback (Sprint 61, B-10608, B-10604; migration `164_cloud_showback`, not registered yet)

- **Cloudflare billing** (`cloud/cloudflare-billing.ts`, through `s.cloud.costs`): Cloudflare accounts are now fetched
  by `cloud.costs.ingest`, once a UTC day per account (two requests: one GraphQL Analytics query for Workers,
  Containers, R2, Tunnel and Workers AI neurons, and the billing history). Usage becomes daily `cloud_costs` rows per
  product priced at the published rates (`cloudflare-analytics`, estimated); each finished month is reconciled with
  what was charged (`cloudflare-billing`); another billing currency is kept apart, never converted.
- **The neuron check**: the job `cloud.costs.neurons.check` (after each Cloudflare fetch) compares the analytics'
  Workers AI neurons per day with the neurons metered on `usage_records`; more than 1 % apart is audited
  `cloud.costs.neurons.mismatch`. Route `GET /api/admin/cloud/accounts/:id/costs/neurons`.
- **Showback** (`cloud/showback.ts`, `s.cloud.showback`): each month's ingested cloud costs per workspace and tenant, by
  the `exprsn:workspace`, `exprsn:pool` and `exprsn:tenant` tags, with shared costs split by a platform rule per cost
  type (GPU time, tokens, model cost, requests, storage, evenly; defaults per type), per currency, the month adding up
  to its ingested total with an unallocated line. Stored monthly by `cloud.showback.compute` (daily); CSV export.
- **Statement lines**: a tenant may show its showback on its B-13 statements as informational lines (off by default;
  never in the total, never pushed). Statements and analytics are unchanged while it is off.
- Console: Analytics › Cloud showback (month, totals per currency, per tenant and workspace, CSV export, the rules,
  the statement setting).
- Routes: `GET /api/admin/cloud/showback`, `GET .../export`, `POST .../:month/compute`, `GET`/`PUT .../rules`,
  `GET`/`PUT .../settings`.

### GPU node groups and VMs as gateway pools, node enrolment, warm-up from the mirror, GPU quotas (Sprint 60, B-10401, B-10404, B-10405; migration `157_cloud_gpu_pools`, not registered yet)

- A deployment's GPU pools (EKS managed node groups, AKS and DOKS GPU node pools, EC2 / Azure / DigitalOcean GPU VMs)
  are linked to gateway pools after the apply (`s.cloud.gpuPools`: `linkFor`, `nodeGroupsFor`, `setDesired`), with the
  node group's id, size limits, instance type and price per hour; the PKI profiles and the gateway's client identity per
  pool come from the tenant's CA.
- Nodes register themselves: a single-use enrolment token (in a VM's user data at create time, or per node in the
  `exprsn-enrol` Secret by the `cloud.gpu.reconcile` job) is exchanged at `POST /cloud/gpu/v1/enrol` for a server
  certificate from the Exprsn-AI CA; the instance (`deploy: cloud`) is trusted by that certificate and reached with
  the pool's client certificate (`InstanceTls.identity`, `pinSha256`; `Gateway.tlsResolver`).
- Warm-up (B-10404): the approved placements pulled from the model mirror only (the node's egress guard refuses any
  other registry) or a pre-seeded volume snapshot; boot to healthy recorded per node.
- GPU quotas (B-10405) at plan time (AWS Service Quotas, Azure compute usages, the DigitalOcean droplet limit): a plan
  past them is refused with the quota's name and the requested and available numbers; capacity errors fall back to the
  next allowed instance type, then zone (`gpuPools[].fallbackTypes`, `zones`).
- Metrics: node-group nodes now count as joined through their link (`exprsn_cloud_gpu_nodes`, the idle counter).
- Routes: `GET /api/admin/cloud/gpu-pools`, `GET .../:id`, `POST .../:id/enrolments`, `POST .../:id/reconcile`.

### Scale-to-zero, autoscale, spot interruptions and idle GPU savings (Sprint 60, B-10402, B-10403, B-10406, B-10605; migration `158_cloud_autoscale`, not registered yet)

- **Autoscale** (`cloud/autoscale.ts`, `s.cloud.autoscale`): a scale policy per cloud GPU pool (min, max, desired,
  idle minutes, queue depth, capacity); every 30 s the pool scales to its minimum after the idle minutes with no slot
  lease on any server, and up by one node when the queue reaches the queue depth per node. Size changes are the node
  group's adapter `update` (journaled, audited `cloud.pool.scaled`); `s.cloud.gpuPools.setDesired` scales through it.
- **Cold starts in the gateway**: a request on a pool with no healthy instance starts a node and waits in the queue
  with the estimate (the median boot-to-healthy timing), or takes the profile's fallback when the estimate exceeds the
  wait (`Gateway.awaitCold`, `GatewayCloudHooks`). Other pools are unchanged.
- **Budgets**: a scale-up is refused past the hard stop (`409 budget_exceeded`, `CloudBudgets.decideScale`); a
  scale-down always passes.
- **Spot**: `gpuPools[].purchase: spot` (EC2 Spot, Azure Spot; refused on DigitalOcean) with an on-demand sibling node
  group the autoscaler grows when spot capacity runs out. `POST /cloud/v1/nodes/interruptions` (mTLS, the node's CA
  certificate) takes the EC2 two-minute notice, the rebalance recommendation and Azure `Preempt`; `Gateway.preempt`
  drains the instance before the reclaim, moves leases still running 20 s before it (`Lease.preempted`), and a moved
  chat answer continues on another instance. `deploy/baremetal/exprsn-spot-watch.sh` is the node-side watcher.
- **Pools card**: "Cloud node group" on Pools (`web/js/screens/pools-cloud.js`): size controls, cost per hour, idle
  timer, spot state, cold-start estimate, savings; `GET /api/admin/pools/cloud`, `PUT /api/admin/pools/:id/autoscale`,
  `POST /api/admin/pools/:id/scale`.
- **Idle GPU savings**: `GET /api/admin/cloud/gpu-savings?month=` (scaled-down node-hours × the on-demand price per
  pool and month), metrics `exprsn_cloud_gpu_saved_hours`, `exprsn_cloud_gpu_savings`, `exprsn_cloud_autoscale_total`,
  `exprsn_cloud_interruptions_total`.

### Azure OpenAI, DigitalOcean GenAI and Workers AI model servers (Sprint 60, B-10502, B-10503, B-10509; migration `160_cloud_model_servers`, not registered yet)

- **Flavoured `kind: openai` instances** (`gateway/openai-server.ts`, `cloud/model-backends.ts`): `cloud: {flavour,
  accountId, region, apiVersion?, resourceId?, auth?}` on `POST /api/admin/pools/:id/instances`. `azure`: the
  deployment path with `api-version`, an Entra token for the Cognitive Services scope from the account or the API key
  from the vault (`api-key`), deployments listed through ARM; `digitalocean`: serverless inference with a model access
  key from the vault; `workers-ai`: Cloudflare's OpenAI-compatible endpoint with the account's token. No `/health` or
  `/props` calls to cloud endpoints. Instances without a flavour are unchanged.
- **Azure content filter → guardrail decisions** (`gateway/provider-filter.ts`, `GuardrailEngine.recordProvider`):
  a filtered prompt (`400 content_filter`) or completion (`finish_reason: content_filter`), streamed or not, is a
  `block` decision at `user-input` or `model-output` with one finding per category; the turn fails and no fallback
  retries it.
- **DigitalOcean agents as registry tools**: `POST /api/admin/cloud/accounts/:id/agent-tools` makes a draft tool
  (`impl: cloud-agent`) that runs through the dispatcher's checks, the `tool-call` checkpoint included.
- **Workers AI neurons**: usage records of Workers AI models carry `neurons`, `cost_micros`, `currency` and `price_id`
  from the price sheet's `workersAi` table (USD 0.011 per 1,000 neurons), once migration 160 is applied.
- **Listing**: `s.cloud.modelCatalogue.listModels(account)` lists Azure deployments, DigitalOcean models and agents
  and Workers AI models for the catalogue import.
- **Egress**: Azure OpenAI, AI Foundry and DigitalOcean inference hosts are provider hosts; under
  `EXPRSN_TESTS_OFFLINE` the Chat Completions client's lookup refuses every provider host too. An address the egress
  guard refuses is named in the instance's error instead of "fetch failed".

### Amazon Bedrock model servers and the cloud catalogue import (Sprint 60, B-10501, B-10504; migration `159_cloud_models`, not registered yet)

- **`kind: bedrock`** pool instances (`gateway/bedrock-server.ts`, `cloud/bedrock.ts`): an AWS account and region;
  Converse and ConverseStream with system prompts, images, tools and tool results, streamed deltas, reasoning as
  thinking and the provider's token counts for metering; Titan and Cohere embeddings through InvokeModel; SigV4 with
  the account's `read` credential (session token included) to the regional endpoints, every call through the cloud
  transport. Models that do not stream tool use fall back to Converse.
- **The AWS event-stream decoder** (`cloud/aws-event-stream.ts`): frames split anywhere, CRC32 of prelude and
  message, limits, exception events as errors. `guardedStream` in `platform/egress.ts` and the transport's `stream`
  mode read an answer as it arrives under the same egress checks.
- **Inference profiles** are recorded with their routing regions and refused (at import, approval and every call)
  when a region is off the account's allow-list, a global profile, or the model's label is above a region's ceiling.
- **Cloud catalogue import** (`cloud/model-import.ts`, `GET`/`POST /api/admin/cloud/accounts/:id/model-import`,
  `GET /api/admin/cloud/model-entries`): Bedrock foundation models (with model access) and inference profiles, and the
  Azure, DigitalOcean and Workers AI listings, registered as `format: server` drafts with provider, account, region,
  terms, access state and a label ceiling capped at the region's and at `internal` (open decision 5); idempotent;
  never approved. Approval and label changes of a cloud model are refused above its ceiling.
- IAM: `bedrock:ListInferenceProfiles` and `bedrock:GetFoundationModelAvailability` join the `models` feature.

### Managed PostgreSQL and MySQL: extensions, deletion protection, snapshots and restores (Sprint 59, B-10301, B-10303, B-10307; migration `153_cloud_databases`, not registered yet)

- The `database` resource type is built on AWS (RDS and Aurora, PostgreSQL and MySQL, `providers/aws-rds.ts` over the
  RDS Query API), Azure (Database for PostgreSQL and MySQL Flexible Server, `azure-databases.ts`) and DigitalOcean
  (Managed PostgreSQL and MySQL, `do-databases.ts`): version, size, HA, storage, backups, maintenance window,
  parameters; private only (private endpoints, `publicAccess: false`); deletion protection on by default.
- Extensions: pgvector, PostGIS and pg_trgm through each provider's allow-list step (Azure `azure.extensions`, RDS
  parameter groups that restrict extensions; none on DigitalOcean); a plan asking for one the provider does not offer
  is refused with its name; `GET .../databases/:key/extensions` is the check.
- Protection: a plan's delete, replace or protection change of a protected database is blocked whatever the graph's
  flag; destroy takes the final snapshot (a manual RDS snapshot, an Azure or DigitalOcean retained copy) after the
  second admin's approval; the adapters refuse a delete without a fresh final snapshot.
- Snapshots listed with their cost (price sheet, new `unverified` entries left out of totals; the sheet's loader now
  skips `unverified` entries as `docs/cloud.md` said), on demand or on a schedule with retention
  (`cloud_db_snapshot_schedules`, the job `cloud.db.schedules`), restored to a new instance that joins the graph.
- The upgrade's database snapshot and restore (B-10207) are now the adapters' own; `REPLACE_FIELDS.database` gains
  `version` and `service`. Routes: `/api/admin/cloud/deployments/:id/databases` and below (`docs/api.md`).

### Moving the install's database to a managed PostgreSQL; managed caches as REDIS_URL (Sprint 59, B-10302, B-10305; no migration)

- **`exprsn-ai db:move`** (`server/src/cloud/db-move.ts`, `server/src/cli/db-move.ts`): a guided, resumable move of
  this install's database onto RDS, Aurora, Azure Flexible Server, DigitalOcean or any PostgreSQL: preflight (TLS
  verified against the provider's CA bundle file, `sslrootcert`; the connection budget `DB_POOL_MAX × instances + 5`
  against the live `max_connections` less the reserved slots; pgvector; an empty target), schema, the read-only window
  (`503 read_only_window`, the job queue paused), `backup:create`, restore, verify (rows, writes during the window,
  `audit:verify` per tenant on the target), `migrate --check`, and the switch of `DATABASE_URL` in its file (the old
  URL kept as `.previous`, the old database read-only for the keep window). `--dry-run`, `--status`, `--resume`,
  `--rollback [--discard-new-writes]`, `--finish`. A crash between steps resumes at the next one.
- **Console, under dual control**: `/api/admin/cloud/db-moves` (`cloud:admin` and `platform:manage`, recent sign-in,
  approved by a second admin; the job `cloud.db.move`). Audit `cloud.db_move.*`.
- **A provisioned data tier in the deployed app** (`server/src/cloud/data-tier.ts`): the database's password and the
  cache's AUTH token generated once into the vault and handed to the provider through the secret broker; the database
  URL (verify-full against the CA file), the CA bundle and the cache URL wired into the vault and delivered as files
  (Helm Secret with `/run/secrets/database_ca.pem`, VM systemd credentials, Container Apps secret files); ECS and App
  Platform refuse a provisioned database (`ca_file_unsupported`). App VMs and container services wait for the data tier.
- **Caches** (`server/src/cloud/caches.ts`, `providers/aws-cache.ts`, `azure-cache.ts`, `do-cache.ts`): the `cache`
  type is built: ElastiCache for Valkey or Redis OSS (cluster mode off, TLS, an AUTH token, the account's noeviction
  parameter group; MemoryDB described only), Azure Cache for Redis and Azure Managed Redis (TLS only, a private
  endpoint, noeviction, the key from `listKeys`), DigitalOcean Managed Valkey (VPC, noeviction). Cluster mode, an
  evicting `maxmemory-policy` or TLS off is refused with the reason by the planner, by the adapters and when a cache is
  wired as `REDIS_URL`; `/readyz` reports `checks.redis: "incompatible: ..."` for a configured Redis that breaks a rule
  (`platform/redis-compat.ts`, `Bus.compatibility`).
- **Docs**: "Own database and caches" in `docs/cloud.md`, "Moving to a managed database" in `docs/deploy.md`,
  `docs/runbooks/db-move.md` (with the owner's sandbox run against RDS), `docs/api.md`, `docs/security.md`.
- **Tests**: `cloud-db-move.test.ts`, `cloud-caches.test.ts`, `integration/cloud-db-move-pg.test.ts` (`TEST_MOVE_PG_URL`,
  `TEST_MOVE_PG_CA`: a PostgreSQL with pgvector and TLS); the fakes in `fake-cloud-caches.ts`.

### Cloud metrics, dashboards and alerts; metadata endpoints refused everywhere; least privilege (Sprint 59, B-10702, B-10705; no migration)

- **Metrics** (`server/src/cloud/cloud-metrics.ts`): operations by step and state and steps in flight, apply duration,
  deployments by state, drift findings detected and open, budget burn (actual and forecast), accounts by budget band,
  hard stop and spend source, budget alerts sent, cost fetches by outcome, GPU nodes (provisioned, minimum, joined,
  idle) and idle GPU node-seconds; with the transport's throttling waits, calls and breakers, all registered at start.
  "GPU idle" is defined in `docs/cloud.md` from what is observable before Sprint 60.
- **Dashboard and rules**: `deploy/observability/grafana/exprsn-ai-cloud.json`;
  `deploy/observability/prometheus/exprsn-ai-cloud.rules.yml` (11 alerts, 5 recording rules) with promtool unit tests
  in `exprsn-ai-cloud.rules.test.yml`, run by CI and by `cloud-metrics.test.ts` when promtool is available; runbook
  entries in `docs/runbooks/alerts.md`.
- **Metadata endpoints** (`server/src/platform/metadata.ts`): every egress check refuses the instance metadata
  addresses (now also `168.63.129.16`, `169.254.0.23`, `fd20:ce::254` and IPv6 spellings such as NAT64 and hex-mapped
  forms) and names (`metadata.google.internal`, `metadata.goog`, `instance-data`...), before any allow-list, by name
  and at connect time. Fixed: a workflow HTTP step accepted `fd00:ec2::254` as an internal address. Operator-set URLs
  that had no check (OpenBao, S3, Stripe, HIBP, SIEM, ACME directory, image safety, Kubernetes API, OTLP) refuse
  metadata through `metadataSafeFetch`/`metadataSafeAgent`; everything else they reached still works.
- **IMDSv2 on EKS node groups**: each node group is made from its own launch template requiring IMDSv2 with hop
  limit 1, deleted with the group; the planner refuses any VM spec with IMDSv1 or a hop limit above 1.
- **Least privilege** (`server/src/cloud/setup.ts`): the generated AWS policies are derived from the feature lists in
  `capabilities.ts` (no wildcards; `iam:PassRole` limited to the account's roles; untaggable actions on their
  narrowest resource), the feature lists gain what the adapters call (describes, lists, launch templates, the
  certificate push), and the Azure setup renders a custom role for the managed resource group.
- **Docs**: the cloud plane's threat model in `docs/security.md`; "Metrics and security" in `docs/cloud.md`.
- **Tests**: `cloud-metrics.test.ts`, `metadata-refusal.test.ts`, `cloud-least-privilege.test.ts`.

### Document and key-value stores, cloud databases as data connections (Sprint 59, B-10304, B-10306; migration `156_cloud_connections`, not registered yet)

- **Five engines** (`server/src/connections/engines.ts`): Amazon DocumentDB (`documentdb`), Azure Cosmos DB for
  MongoDB vCore (`cosmos-mongodb`) and DigitalOcean Managed MongoDB (`do-mongodb`) on the MongoDB driver of 1.5.0 with
  each service's TLS CA bundle, SASL mechanism, read preference and unsupported stages (`connections/mongo-services.ts`);
  a read-only DynamoDB driver (`connections/dynamodb.ts`: Query and PartiQL SELECT only, SigV4 through the egress
  guard; writes, table changes and scans refused by classification) and a read-only Cosmos DB for NoSQL driver
  (`connections/cosmos.ts`: the SQL query API with the account key, an Entra service principal or a cloud account's
  token). Classification, allow-lists, masking inside documents, row caps and audit as for SQL; schema sampling.
- **Discover and connect** (`server/src/cloud/discovery.ts`, `s.cloud.discovery`): `GET
  /api/admin/cloud/accounts/:id/discover` lists RDS, Aurora, DocumentDB and DynamoDB; Azure flexible servers, Cosmos DB
  accounts and vCore clusters; DigitalOcean database clusters (with the managed ones of `cloud/databases.ts` marked);
  `POST .../connect` makes a data connection to one, discovered or provisioned, adding the private endpoint's host to
  the tenant's allowed hosts with it, with the admin password in the vault, per-connection users from a B-1704 lease
  engine (dropped when their lease ends), RDS IAM or Entra tokens through `s.cloud.credentials`, or the account's own
  credential (DynamoDB, Cosmos DB). `GET .../connections` lists them. `cloud:read` and `connections:manage`.
  `ConnectionService.cloud` reads a connection's cloud link at each use; connections without one are unchanged.
  `DatabaseLeases.issueForService` and `revokeForService`; PostgreSQL and MySQL drivers verify TLS with a linked CA.
- **Fakes and tests**: DynamoDB and the RDS discovery lists (`fake-aws-data.ts`), the Cosmos DB data plane, read-only
  keys and subscription lists (`fake-azure-cosmos.ts`, `fake-azure.ts`), DigitalOcean clusters and CAs (`fake-do.ts`);
  `connections-dynamodb`, `connections-cosmos`, `connections-documentdb`, `cloud-discovery`. Example servers: DynamoDB
  Local in `docker/infra` and `example-dynamodb`, `example-documentdb` (the infra MongoDB as a stand-in) in the example
  connections script.

### Cloud billing ingestion and budgets on actuals (Sprint 59, B-10603; migration `155_cloud_costs`, not registered yet)

- **Daily cost rows** (`server/src/cloud/costs.ts`, `s.cloud.costs`): `cloud_costs` (provider, account, deployment,
  allocation, service, day, amount, currency, source, estimated, fetched at) from AWS Cost Explorer `GetCostAndUsage`
  (daily, by the `exprsn:deployment` cost allocation tag and service), Azure Cost Management `query` (by the same tag
  key) and DigitalOcean's balance and invoice items (attributed by resource id); the currency is kept, never converted.
  Job `cloud.costs.ingest`, daily: one Cost Explorer request per account per UTC day, claimed in `cloud_cost_fetches`
  across instances, resumable, the last 14 days and the current month re-fetched and replaced (revisions overwrite).
  Only active accounts whose validation shows billing read access are fetched; Cloudflare billing stays B-10608.
- **Budgets on actuals** (`cloud/billing-spend.ts`): `s.cloud.budgets.spend` is `AccountSpend`: billing data for an
  account with a successful fetch in the last three days (forecast: month-to-date actuals plus the applied plans' run
  rate for the rest of the month), else the Sprint 58 estimates; the budget view says which. `budgetBurn` for the
  metrics. Alerts, the hard stop and overrides are unchanged.
- **Routes**: `GET /api/admin/cloud/costs`, `GET /api/admin/cloud/accounts/:id/costs` (rows or sums by day, deployment
  or service), `.../costs/estimate-vs-actual`, `.../costs/fetches`, `POST .../costs/fetch` (fetch now, `finops:manage`,
  once an hour) and `GET /api/admin/cloud/deployments/:id/costs`. Audit `cloud.costs.ingested`, `cloud.costs.failed`,
  `cloud.costs.fetch.requested`. The Cloud accounts screen gains a "Cost this month" column and a Cloud costs inspector
  section (estimate against actual, the budget's source, the last fetch, Fetch costs now).
- **Fakes**: Cost Explorer `GetCostAndUsage` in `fake-aws.ts`, Cost Management `query` in `fake-azure.ts`, balance,
  billing history, invoices, items and the CSV in `fake-do.ts`. Tests `cloud-costs.test.ts`, `cloud-budgets.test.ts`.

### Kubernetes target, upgrades and rollback (Sprint 58, B-10203, B-10207; migration `151_cloud_releases`, not registered yet)

- **EKS, AKS and DOKS** (`server/src/cloud/providers/aws-eks.ts`, `azure-aks.ts`, `do-doks.ts`, `kubernetes.ts`):
  `kubernetes_cluster` and `node_group` are built on the three; `load_balancer` with `managedBy: cluster` is the one
  the cluster's controller makes from the release. AKS and DOKS clusters are created with the app pool, which its step
  adopts. Fakes: `fake-aws-eks.ts`, `fake-azure-aks.ts`, `fake-do-doks.ts`, `fake-kube.ts`.
- **The release** (`cloud/releases.ts`, `helm.ts`, `kubeconfig.ts`, `kube.ts`, `chart-values.ts`): after an apply,
  `cloud.release` installs the chart with the pinned Helm 3.19.0 (`HELM_BIN`), a short-lived kubeconfig per operation
  (EKS presigned STS token, AKS Entra token, DOKS credentials) in a private file deleted afterwards, values derived
  from the spec, one Kubernetes Secret from the vault, the chart's migrate Job; then verify reads `/readyz`. The chart
  accepts `config.kms.provider` `aws-kms` and `azure-keyvault`, and a spec's `clusterKeys` uses the cloud KMS through
  the pods' workload identity, so no `DATA_KEY` is in the cluster (open decision 8).
- **Upgrades** (`cloud/upgrades.ts`): an upgrade by image digest is planned and applied by its plan's hash (purpose
  `upgrade`); the database snapshot first, `migrate --check` as a Job, the rolling update, verify, and an automatic
  `helm rollback` of the app tier when verify fails. The database rolls back only by restoring its snapshot, asked
  for by one cloud admin and approved by another. Routes in `routes/admin/cloud-releases.ts`.
- **Also:** firewall rules compare as what they allow (`sameRules` in `planner.ts`), and DigitalOcean firewalls write
  an `all` rule as TCP, UDP and ICMP, so a deployment's firewalls verify as desired on AWS and DigitalOcean; the
  egress guard admits `*.azmk8s.io` and `*.k8s.ondigitalocean.com` and takes a private CA for a cluster's API.

### VM and container targets (Sprint 58, B-10204, B-10205; no migration)

- **VMs on EC2, Azure and DigitalOcean** (`server/src/cloud/compute.ts`, `providers/aws-compute.ts`,
  `providers/azure-compute.ts`, the droplet's `user_data`): `vm` is built for AWS and Azure. Cloud-init runs the
  bare-metal installer from the signed release tarball pinned in the spec (`release.tarball`: url, sha256, optional
  cosign bundle and signer identity), verifying the digest before anything from it runs. EC2 requires IMDSv2 with hop
  limit 1; Azure VMs are Trusted Launch with a vTPM; no public address. Secrets reach the VM once in a single-use
  OpenBao response-wrapping token and become systemd credentials (`EngineHooks.secrets`, `defaultSecretBroker`). The
  readiness check `vm.install` reads the installer's console lines (EC2 `GetConsoleOutput`, Azure boot diagnostics), so
  a tampered tarball fails verify.
- **Container platforms** (`providers/aws-compute.ts`, `azure-compute.ts`, `do-apps.ts`): `container_service` is built
  as ECS on Fargate (cluster, task definition, secrets in Secrets Manager, the service's own ALB), Azure Container Apps
  (environment, manual migration job, app in single revision mode with secrets mounted as files) and DigitalOcean App
  Platform (app spec with a `PRE_DEPLOY` migration job); the migration runs as a one-off task or job before every
  rollout. The render no longer adds a separate load balancer for the container shape.
- **Spec**: `release` (tarball for VMs, image by digest for containers) and `keys` (`openbao`, or B-10208's `aws-kms`
  and `azure-keyvault` where the platform takes the credential as a file), checked by `validateSpec`.
- **The planner refuses** (`computeProblems`, also checked at apply) a graph with `DATA_KEY` or any other secret as a
  plain variable, a file-only secret through a platform's secret variables, an unpinned release, or a VM without
  IMDSv2 and hop limit 1. Apply now also re-checks the public-data rule.
- **`install.sh --from-release <url> --sha256 <digest>`** (`deploy/baremetal/install.sh`): download, digest and
  optional cosign check, archive containment, `--dry-run`, `--kms`, `--credentials-list`, `--credentials-wrapped`,
  `--start`. Running it with no mode still builds the checkout, as before (the same as `--from-source`), with a note.
- `parent.refs` on a `ResourceSpec` (the provider ids of what a resource depends on, by key); the lazy registry adapter
  forwards `vmInstallStatus`; the Azure adapter's `find` of a subnet whose network does not exist yet answers none
  instead of failing the refresh.
- Tests `cloud-vm-containers.test.ts`, `deploy-from-release.test.ts`; fakes `fake-aws-compute.ts`,
  `fake-azure-compute.ts`, `fake-do-apps.ts`, `fake-vm-boot.ts`.

### Cloud DNS and TLS, budgets and the hard stop (Sprint 58, B-10206, B-10602; migration `152_cloud_budgets`, not registered yet)

- **DNS records from the load balancer's address** (`server/src/cloud/value-from.ts`): a `dns_record` with
  `valueFrom: {key, field}` is ordered after its source by the planner, compared with the source's observed address,
  updated after a source the plan creates or replaces, and filled in at apply (`cloud/apply.ts`); a CNAME to an IP
  address is written as an A or AAAA record.
- **dns-01 through a cloud account** (`cloud/cloud-dns.ts`): `ACME_DNS_PROVIDER` gains `route53`, `azure-dns` and
  `digitalocean`, with `ACME_DNS_CLOUD_ACCOUNT` and `ACME_DNS_CLOUD_ZONE` (new settings; the settings descriptor is
  regenerated). The TXT records go through the account's DNS adapter and credential. A public CA or the Exprsn-AI CA.
- **Renewed certificates on the load balancer** (`cloud/cert-push.ts`): certificate hook kinds `aws-acm` (ACM import
  into the same ARN, ELBv2 listener), `azure-appgw` (Application Gateway PKCS#12) and `do-lb` (DigitalOcean
  certificate and forwarding rules), on `POST /api/admin/platform/certificates/:id/hooks`.
- **Budgets** (`cloud/budgets.ts`, `cloud/spend.ts`): a monthly budget per account with alerts at 50, 80 and 100 % of
  actual and forecast spend (audit `cloud.budget.alert` for webhooks, notice kind `cloud.budget`), once each per month;
  a hard stop refusing plans that add monthly cost with `budget_exceeded` (scale-down and destroy always allowed; a GPU
  node group above its minimum counts); overrides under dual control with a reason for at most 7 days. Spend is
  estimated from applied plans until billing data arrives in Sprint 59 (`SpendSource`). Routes under
  `/api/admin/cloud/accounts/:id/budget` and `GET /api/admin/cloud/budgets`; job `cloud.budgets.check`
  (`CLOUD_BUDGET_CHECK_MINUTES`); event group `cloud.*` in the catalogue; a Budget column and inspector section on the
  Cloud accounts screen. Tests `cloud-dns-tls.test.ts`, `cloud-budgets.test.ts`; the e2e Cloud accounts spec sets a
  budget.

### Cloud keys and blobs for deployed installs (Sprint 58, B-10208; no migration)

- **`KMS_PROVIDER=aws-kms` and `azure-keyvault`** (`server/src/platform/kms-cloud.ts`) beside `local` and `openbao`: a
  KMS key per tenant (AWS symmetric key with yearly rotation behind `alias/<prefix>tenant-<id>`; Key Vault RSA-3072, or
  RSA-HSM with `KMS_AZURE_HSM`) wraps the tenant's data keys with the associated data bound in; checkpoints, backup
  manifests, provenance and model cards are signed in the KMS with an ES256 key per name and verified with its public
  key, so signatures made before a signing-key rotation keep verifying. Offboarding schedules AWS keys for deletion
  (`KMS_AWS_DELETION_DAYS`) or deletes and purges Key Vault keys.
- **`BLOB_STORE=azure`** (`platform/blob-azure.ts`): the Azure Blob API with block uploads, ranged ETag-pinned reads,
  prefix listing and delete; Entra or Shared Key. AWS S3, DigitalOcean Spaces and R2 stay on `s3`.
- **The install's identity** (`platform/cloud-identity.ts`): an EKS web identity token file
  (`KMS_AWS_ROLE_ARN`, `KMS_AWS_WEB_IDENTITY_TOKEN_FILE`) or a vaulted key pair; an AKS workload identity token file
  (`AZURE_IDENTITY_*`) or a client secret file; never the metadata service. Every call goes through the cloud
  transport. Production refuses `KMS_AWS_SECRET_ACCESS_KEY`, `AZURE_IDENTITY_CLIENT_SECRET` and
  `BLOB_AZURE_ACCOUNT_KEY` inline (only `_FILE`).
- **`kms:rewrap`** moves a tenant from `local` to `aws-kms` or `azure-keyvault` (`KMS_PREVIOUS_PROVIDER` takes the
  cloud kinds too) and `audit:verify` passes afterwards. New settings in `docs/deploy.md` ("Keys and blobs on a
  cloud"); the settings descriptor is regenerated. Tests `kms-cloud.test.ts`, `blob-azure.test.ts`; the fakes gain AWS
  KMS (`fake-aws-kms.ts`), Key Vault and Blob storage (`fake-azure-data.ts`).

### Cloud deployments: drift, destroy, rollback, orphans, rate limits and the circuit breaker (Sprint 57, B-10106 to B-10108; migration `149_cloud_lifecycle`, not registered yet)

- **Drift** (`server/src/cloud/drift.ts`, `s.cloud.lifecycle.drift`): the scheduled `cloud.drift`
  (`CLOUD_DRIFT_MINUTES`, 15) reads every managed resource and records field drift, missing resources and unmanaged
  resources inside managed networks or tagged for the deployment; each finding is reverted (a plan back to desired,
  applied at once if asked), adopted (desired becomes observed) or ignored. New findings are told to the deployment's
  owners. Audit `cloud.drift.detected`, `cloud.drift.decided`.
- **Destroy** (`destroy.ts`, the job `cloud.destroy`): reverse-order destroy in rounds of destroy plans; protected
  resources (and every database) wait, with what they depend on, for a second cloud admin's approval, and their final
  snapshot is taken through the new adapter hook (`snapshotSupport`, `snapshot`, `snapshotStatus`; DigitalOcean
  droplets in this build) before they are deleted; refused with the reason where there is no snapshot.
- **Rollback**: a failed apply of a verified deployment rolls its replaceable resources back to the last verified
  state (`cloud.rollback`, `CLOUD_AUTO_ROLLBACK`), or by hand.
- **Orphans** (`orphans.ts`, `cloud.orphans`, `CLOUD_ORPHAN_SWEEP_HOURS`): tagged resources no graph or journal knows,
  adopted into a deployment, ignored or deleted.
- **Rate limits and retries** (`providers/transport.ts`): buckets per account, provider and API class (`read`, `list`,
  `mutate`, `billing`) on the shared counter store, refilled in slices; ARM's `x-ms-ratelimit-remaining-*` and
  DigitalOcean's `ratelimit-remaining` hold a class back while low; AWS throttling also read from `x-amzn-errortype`;
  5xx and transport errors retried for every call that changes nothing (AWS's POSTed Describe calls too). A circuit
  breaker per provider and account (five failures open it, a half-open probe after 30 s). Metrics
  `exprsn_cloud_wait_seconds`, `exprsn_cloud_calls_total`, `exprsn_cloud_breaker_transitions_total`,
  `exprsn_cloud_breakers_open` (`cloud/limits-metrics.ts`).
- **Routes** under `/api/admin/cloud/deployments/:id/`: `drift`, `drift/check`, `drift/:findingId/decide`, `destroy`,
  `destroy/:destroyId/protected/:key/approve|reject`, `destroy/:destroyId/cancel`, `rollback`, `orphans`,
  `orphans/sweep`, `orphans/:orphanId/adopt|ignore|delete`. Tests `cloud-drift-destroy.test.ts`,
  `cloud-limits.test.ts`; the DigitalOcean fake takes droplet snapshots and a shorter rate window.

### Cloud deployments: the resource graph, the operation journal, plans, apply and verify (Sprint 57, B-10102 to B-10105, B-10701; migration `148_cloud_journal`, not registered yet)

- **The graph and the journal** (`server/src/cloud/graph.ts`, `deployments.ts`, `journal.ts`): per deployment the
  desired spec, observed state, provider id, dependencies, protection and tags of each resource; an append-only
  journal of every step (idempotency key, client token, provider request id, attempt, state, error, the long-running
  operation's handle). `s.cloud.deployments`, `s.cloud.journal`.
- **Plans** (`planner.ts`, `s.cloud.plans`): create, update, replace (with the reason), delete or no-op per resource
  with field-level changes and the estimate from `s.cloud.estimatePlan`; stored with a hash, expiring after 60
  minutes or when the observed state changes; apply by hash only, refused with `409 plan_stale` and a fresh plan when
  a resource changed out of band. Types the adapters do not drive show as unavailable. Revert, destroy-all and
  rollback-to-verified plans for the lifecycle work.
- **The apply worker** (`apply.ts`, `s.cloud.engine`): jobs `cloud.apply` and `cloud.poll`; deletions dependents first,
  then the rest dependencies first, with bounded parallelism; one apply per deployment (a lease held by the job id);
  every step journalled and resumed from the journal after a crash without a second copy; long-running operations
  polled from their stored handles; retries of throttling; cancel after the steps in flight; `hooks.beforeCall` and
  `afterCall` for the limiter and the breaker.
- **Verify** (`verify.ts`, job `cloud.verify`): readiness per resource and for the deployment (`ReadinessCheck`s: the
  app's `/readyz` with its database and Redis, the TLS chain); a failed verify marks the deployment degraded and offers
  rollback.
- **Audit** (`audit.ts`, `cloudAudit`): `cloud.deployment.*`, `cloud.plan.*`, `cloud.apply.*`, `cloud.resource.*`,
  `cloud.verify.*` with the journal step and the provider's request id; every resource traced to the audit entry and
  journal step that created it.
- Routes under `/api/admin/cloud/deployments` (list, one, graph, plans, apply by hash, operations, verify) with
  `cloud:read` and `cloud:deploy` (a platform deployment also `platform:manage`; apply needs a recent sign-in).
  Test `cloud-journal-plan-apply`.

### Cloud deployment specs, network foundation and the price catalogue (Sprint 57, B-10201, B-10202, B-10601; migration `150_cloud_prices`, not registered yet)

- **Deployment spec** (`server/src/cloud/spec.ts`): target account and region, label, compute shape (Kubernetes, VMs,
  container platforms) and size preset (small, medium, large with HA), data tier (provision, existing by `vault:`
  reference, on-prem), front door (Cloudflare, ACME with the provider's DNS, bring your own), up to four GPU pools, the
  tiers' zones and the network range. `validateSpec` checks it before any provider call: account state, scope and
  allow-list, ceilings and residency (`assertRegionAllows`'s decision), zone ceilings, the last permission report, GPU
  offers, limits, the front door's account and its `confidential` cap.
- **Network foundation** (`network.ts`): a VPC or virtual network with a private subnet per zone and availability zone
  (DigitalOcean: a VPC per zone), NAT only where a zone's egress reaches a public range, and one firewall per zone
  whose rules are the zone's: `zoneRules` in `zones/render.ts`, now the shared model the nftables rendering prints
  too, so a cloud firewall equals the zone's nftables table rule for rule. The data tier gets private endpoints in the
  data zone; `publicDataProblems` refuses any data resource with a public address.
- **Desired graph** (`render.ts`, `renderGraph`): the network, the compute shape, the data tier and the ACME DNS
  record as `DesiredResource`s; types the adapters do not build yet are rendered and shown unavailable by the plan. A
  Cloudflare front door is rendered apart (it lives on the Cloudflare account) for the edge work.
- **Routes** (`routes/admin/cloud-deployment-specs.ts`): `POST /api/admin/cloud/deployments/validate-spec` (the
  wizard's dry run, no provider call) and `POST /api/admin/cloud/deployments` (spec → deployment → plan), both
  `cloud:deploy` and `platform:manage`, creating with a recent sign-in. Audited `cloud.deployment.spec`.
- **Price catalogue** (`prices.ts`, `s.cloud.prices`, `s.cloud.estimatePlan`): the AWS Price List Query API, the Azure
  Retail Prices API (`prices.azure.com`, added to the Azure API hosts in `platform/egress.ts`), DigitalOcean
  `/v2/sizes`, and the maintained `price-sheet.json` (dated, sourced) for what has no API and as the fallback; cached
  in `cloud_prices` for a day, refreshed daily by `cloud.prices.refresh` for accounts with a deployment. Every plan's
  estimate: monthly, delta, the assumptions (hours, storage, egress) and every price used with its source and date;
  the account's currency (USD by default) with no conversion. Without migration 150 the sheet answers alone and the
  estimate says so.
- Fakes: Pricing `GetProducts` in `fake-aws.ts` (`setPrice`), Retail Prices in `fake-azure.ts` (`addRetailPrice`),
  `/v2/sizes` in `fake-do.ts`. Tests `cloud-spec-network`, `cloud-prices`.

### Cloud provider adapters and test fakes (Sprint 56, B-10101, B-10109; no migration)

- **`CloudProvider`** (`server/src/cloud/providers/`): one adapter per provider behind `s.cloud.providers` and
  `s.cloud.providerFor(kind)`: AWS on the AWS SDK v3 modular clients (STS, IAM, EC2, S3, Route 53), Azure on
  `@azure/arm-resources`, `-network`, `-storage`, `-dns` and `-authorization` with a `TokenCredential` over the
  account's credential, DigitalOcean v2 and Cloudflare v4 over the egress guard. Each answers `identity`,
  `checkPermissions` (missing permissions per feature) and `describe`, `list`, `find`, `create`, `update`, `delete`
  and `poll` with idempotent creates (lookup by tag or name, PUT by name, adoption of an earlier attempt) and JSON
  operation handles for the Sprint 57 journal. Built: network, firewall and DNS records everywhere the provider has
  them, subnets and buckets on AWS and Azure, R2 buckets and tunnels on Cloudflare, droplets on DigitalOcean; the rest
  answer `not_yet` or `unsupported` from a capability table (`docs/cloud.md`, "Provider adapters").
- **Every call through the egress guard and the shared rate limiter** (`providers/transport.ts`): the SDKs get a
  request handler and an HTTP client that send through `guardedRequest` with the new `cloudAddressProblem` and
  `CLOUD_PROVIDER_HOSTS` in `platform/egress.ts` (metadata addresses always refused, internal addresses only when
  `SERVICE_ALLOWED_HOSTS` names them, only the providers' API hosts otherwise), one bucket per provider and account
  on the counter store, and retries of throttling that honour `Retry-After` and DigitalOcean's `ratelimit-reset`. The
  SDKs' own retries and default HTTP clients are off. Adapters load on first use, so nothing changes until a cloud
  account is used.
- **Fakes** `server/test/fake-aws.ts`, `fake-azure.ts`, `fake-do.ts`, `fake-cloudflare.ts` (with `fake-cloud-base.ts`):
  in-process on 127.0.0.1, recording requests, with injectable throttling and errors. Test `cloud-providers`.
- Dependencies (exact versions): `@aws-sdk/client-sts`, `-iam`, `-ec2`, `-s3`, `-route-53` 3.1146.0, `@smithy/types`
  4.19.0, `@azure/arm-resources` 8.0.0, `@azure/arm-network` 39.0.0, `@azure/arm-storage` 20.2.0, `@azure/arm-dns`
  5.1.0, `@azure/arm-authorization` 9.0.0, `@azure/core-auth` 1.11.0, `@azure/core-rest-pipeline` 1.25.0.

### Cloud accounts, regions and validation (Sprint 56, B-10002, B-10007 to B-10009; migration `146_cloud_accounts`, not registered yet)

- **Cloud accounts** (`cloud/accounts.ts`, `s.cloud.accounts`; `GET/POST/PATCH/DELETE /api/admin/cloud/accounts`):
  AWS, Azure, DigitalOcean and Cloudflare accounts, platform-scoped (changed only with `platform:manage`) or bound to
  one tenant (its data connections and model backends), with the provider's own ids, the credential mode, the default
  region and a state. Credentials are `vault:` references and non-secret parameters only.
- **Permissions and roles**: `cloud:read`, `cloud:deploy`, `cloud:admin`, `finops:read`, `finops:manage`; Cloud admin
  (MFA required), Cloud operator (MFA required) and FinOps analyst. 17 built-in roles.
- **Dual control** (`/api/admin/cloud/proposals`): adding (the account stays `pending` and unusable), removing,
  changing the credential mode, raising a region's ceiling and widening a tenant's residency wait for a second cloud
  admin; `restricted` ceilings need a platform admin.
- **Validation** (`POST /api/admin/cloud/accounts/:id/validate`, `cloud/validate.ts`): the identity call and the
  per-feature permission check through `s.cloud.credentials` and the provider adapter, reporting what is missing per
  feature; `assertFeature` refuses a feature with the missing permissions named.
- **Regions, zones and residency** (`cloud/catalogue.ts`): the regions of open decision 1, each mapped to a zone and
  starting at `internal`; `assertRegionAllows`, the check every placement calls, and `regionAdmits` with
  `Resource.region` in `authz/policy.ts`, so `explain` names the region's ceiling; residency per open decision 4
  (`/api/admin/cloud/residency`).
- **Token-only providers**: DigitalOcean and Cloudflare show federation unavailable with the reason and a permission
  checklist per feature (`GET /api/admin/cloud/catalogue`).
- **Tags** (`cloud/tags.ts`): `exprsn:managed`, `exprsn:account`, `exprsn:deployment`, `exprsn:tenant`,
  `exprsn:workspace`, `exprsn:pool`, in each provider's form.
- **Console**: Cloud accounts (`web/js/screens/cloud.js`, `#/cloud`): the list, the inspector with credentials,
  regions, ceilings and the checklist, the connect wizard, regions, credentials, residency and proposals. Docs
  `docs/cloud.md`. Tests `cloud-accounts`, `e2e/tests/cloud-accounts.spec.ts`.

### Cloud federation issuer and credentials (Sprint 56, B-10003 to B-10006; migration `147_cloud_federation`, not registered yet)

- **`s.cloud.credentials.for(account, purpose)`** (`cloud/credentials.ts`): the credential a provider adapter needs,
  by the account's mode: an AWS session bought with `AssumeRoleWithWebIdentity` for the purpose's role (`roleArn`, or
  `readRoleArn`, `deployRoleArn`, `billingRoleArn`), cached per instance and refreshed at two thirds of its hour; an
  Azure `getToken(scope)` with Entra tokens per scope (federated client assertion, certificate assertion or client
  secret), refreshed early; the vaulted key pair; or the DigitalOcean or Cloudflare token with the account id.
- **Federation issuer** (`cloud/issuer.ts`): a separate issuer URL (`CLOUD_ISSUER_URL`, default
  `PUBLIC_URL/cloud-issuer`) with its own ES256 keys in the signer or OpenBao transit, minting tokens with `sub`
  `cloud-account:<id>` and the cloud's audience; `CLOUD_AZURE_SIGNING_ALG=RS256` adds an RSA key for the Azure
  audience only (open decision 3). Publication (`cloud/issuer-publishers.ts`) to S3, an Azure Blob static website,
  DigitalOcean Spaces or R2, or served by the console on `/cloud-issuer/...` (open decision 2); a new key signs only
  once the published JWKS holds it, and a retired key stays until every session has ended. The `cloud.issuer.check`
  job compares the published JWKS with the issuer's keys and alerts on a mismatch.
- **Setup helper** (`cloud/setup.ts`): the IAM OIDC provider, the trust policy (conditions on `aud` and `sub`), the
  read, deploy (conditioned on the `exprsn:*` tags) and billing policies and the CLI lines; for Azure the federated
  identity credential and the role assignments as `az` commands.
- **Vaulted credentials**: values in the vault's platform scope (`sys/kv/cloud`, service `cloud.credentials`),
  sealed, never returned; AWS keys rotate automatically (create, verify, switch, delete after the overlap), Azure
  client secrets through Graph `addPassword`/`removePassword`, DigitalOcean and Cloudflare tokens by notice and a
  guided replace; last use and rotation state in `cloud_credential_state`; an Azure client certificate from the CA
  with its key in custody. The sweep job `cloud.credentials.sweep`.
- Routes under `/api/admin/cloud/issuer` and `/api/admin/cloud/accounts/:id/{credential,setup,secret,rotate,azure-certificate}`
  and `POST /api/admin/cloud/secrets`; settings `CLOUD_*` (issuer, endpoints, session, rotation and notice timings).
  `server/test/fake-aws.ts` stores S3 objects and serves them unsigned, as a public bucket. Tests `cloud-federation`
  and `cloud-credentials`.

## 1.9.9-qa (2026-10-19)

The QA release before 1.9.99-final (the cloud epic) and 2.0.0: Sprints 44 to 55 (1.8.0 and 1.9.0) and Sprint QA-1
(`Backlog-1.9.9-qa.md`). Everything below was listed under Unreleased until this release.

### QA-1 fixes: real databases, flaky tests, a local SOAP example, who uploaded a document (Sprint QA-1, release 1.9.9-qa; migration `144_knowledge_document_creator`, not registered yet)

- **Who added a knowledge document** (`knowledge_documents.created_by`, migration `144_knowledge_document_creator`):
  set on upload and on a published revision, inherited by the images taken out of a document; null for synced
  documents and older rows. `KnowledgeService.indexInto` meters for whoever queued that index, else the document's
  `created_by`, else whoever added the source, so a background reindex of a base credits each document's uploader.
  The build writes and reads the column only while it exists (`KnowledgeService.hasDocumentCreator`); `e2e/server.ts`
  applies the migration when it is missing. Test `knowledge-document-creator`.
- **TOTP**: `MfaService` reads the clock once for a code's check and the step it records; read twice, a step boundary
  between the readings recorded the next step as used and refused the next (valid) code as a replay.
- **Console**: after a sign-in or sign-out the shell renders once (on the hashchange) instead of twice; the second
  render rebuilt the sign-in form and dropped what was typed (the identity-additions e2e failure "Missing details").
  The Import screen's live refresh keeps a focused field's selection, not only its caret: typing over a selected
  value after a poll landed in front of it ("imported-banksfailed-banks").
- **Backups**: a restore (the drill and `backup:restore`) skips and reports the columns a target table lacks, as it
  already did for missing tables (`restoreRows` returns `skippedColumns`); the e2e restore drill failed on
  `knowledge_documents.created_by` from the unregistered migration 144. Test `restore-skipped-columns`.
- **Egress**: an answer over a guarded request's size cap is refused and the request torn down without an error
  object, which under load surfaced as an uncaught exception in `rest-connections.test.ts`.
- **Example SOAP connection**: `docker/infra` service `soap-samples` (a small dependency-free Node SOAP 1.1 service,
  `soap-samples/server.mjs`, on LAN_IP:8096: `GET /soap/CityLookup?wsdl`, document/literal `LookupCity(zip)` answering
  `LookupCityResult { City, State, Zip }` as the crcind.com demo did); `scripts/exprsn-ai-11-example-connections.mjs`
  points `example-soap` at it (its host on the tenants' allowed hosts), skips it with a note while the service is
  down, and registers a connection still on crcind.com again once it answers.
- **Tests**: `sprint15-ops` measures the bundle stream's live memory (a forced collection before each sample, `gc()`
  exposed at run time) instead of uncollected garbage: about 5 MB, against a bound of 64 MB (was 96 MB, failing at
  117 MB under load); `sprint25a-acme` checks the PKCS#12 MAC digest and PBES2 algorithms from the DER, so LibreSSL
  (which prints no algorithm names) passes too; `sprint18` ACME hook waits are deadline-based (a reload command is a
  child process that took over 2 s under load) with 90 s test timeouts; `y-reflow-overlays` parks the pointer before
  stamping controls and clicks a control again once if the screen re-rendered it away (Analytics re-renders on chart
  hover, so at 320 px every click missed and it reported "analytics: no dialog opened"); `app-reports` no longer
  looks for "60" in random ciphertext (it checks the sealed form instead). `TEST_HARNESS_DB=pg|mysql`
  runs `harness`/`harnessWith` suites on a fresh PostgreSQL or MySQL database (`test/helpers.ts`).

### Saved searches, search within, links to the exact message, live flag changes (Sprint QA-1, release 1.9.9-qa)

- **Saved searches** (B-173, `search/saved.ts`, migration `145_saved_searches`, not yet registered): a person saves a
  query with its source and (for chats and posts) its filters, lists, renames or changes, deletes and runs it, under
  `/api/search/saved`. Per person and private (another person's is `404`); the name, query and filters are sealed
  with the tenant key, the owner and row in the associated data; running one searches as the reader now. Audited
  `search.saved.created`/`updated`/`deleted` without the query; runs are not audited. Until 145 is applied the list
  says `available: false`, writes answer `503` and the console hides the feature.
- **Search within** (B-173): "Search in this conversation" (the conversation's Search drawer and the palette),
  "Search in this group" (a group's header and the palette) and "Search in this feed" (the feed's toolbar and the
  palette) open `#/search` kept to that container (`?conversation=`, `?group=`, `?workspace=`, `?list=`, `?tag=`), with
  "Searching only in …" and "Search everywhere". The chat search sends `group` and `workspace`, the post search
  `workspace` and `list`.
- **Links to the exact message**: chat results link to `messages?convo=<id>&message=<id>`, comment results to
  `messages?post=<id>&comment=<id>`. Messages loads older pages until the message is there, scrolls to it, marks it,
  moves focus to it and announces it; a deleted or hidden one is marked with a notice, and one the reader cannot see
  gets a plain notice. New `GET /api/search/messages/:id/locate` (`messages:read`): where a message is, without its
  text, `unavailable` alike for gone and not yours. A linked post not in the feed shown opens on its own.
- **Live flag changes** (B-169, `realtime/flags.ts`): a flag change on the bus becomes a `flags.changed` `{at}` socket
  event to the affected tenant's consoles (every socket for a platform change), coalesced, with no key or value;
  `web/js/flags.js` fetches `GET /api/me/flags` at once and re-applies the gates. The one-minute refetch stays.
- **Docs**: `docs/security.md` "Feature flags" (what the console sees, dual control, no secrets in flags, live
  changes) and saved-search sealing under "Search index"; `docs/api.md`.

### User store governance: dual control, purge, scheduled backups, users export, large uploads (Sprint QA-1, release 1.9.9-qa)

- **Dual control** (Sprint 54 leftovers, B-181, B-186): a change of a store's connection or attribute configuration,
  restoring a backup, purging an archived store and turning dual control off are proposals a second identity admin
  approves with a recent sign-in (`202` with the proposal; the proposer cannot approve; a stale proposal is superseded).
  Name, sign-in order and enable/disable stay single-admin. Tenant setting `dualControl`: `auto` (default: on with two or
  more identity admins, else off with a warning), `on`, `off`.
- **Purge** (B-185): an archived store is removed only after `purgeAfterDays` (default 30); before, `409` with the date.
  Links, mappings and versions go, accounts stay. Audited `identity.store.purged`.
- **Scheduled backups** (B-186): daily or weekly per store, run by the Scheduler (`identity.store.backups.due`), pruned
  to a count and age (scheduled ones only, never the newest); failures notify the identity admins.
- **CSV export of a store's users** (`identity:manage` + `users:manage`): no secrets, within the requester's clearance,
  as a sealed job file above 1,000 accounts.
- **Large backups**: `PUT /api/admin/identity-store-backups/upload` streams a backup of up to 50 MB to the blob store
  for a restore by id (dry run first).
- Console: User stores › Governance tab (settings, proposals, schedules); Purge, Backup schedule and Export users on a
  store's panel; "Restore from a file" uploads. Migration `142_identity_store_governance` (not registered yet; without
  it everything works as before).

### User stores: directory import, Graph delta, AD primary group, ranges and SRV weights (Sprint QA-1, release 1.9.9-qa)

- **Full import of a cloud directory** before first sign-in (`identity/directory-import.ts`, the job
  `directory.import`): every user of an Entra ID (Graph) or Google Workspace (Directory API) store, made as
  just-in-time provisioning makes them (roles, clearance and workspaces from the group mappings, linked by the
  directory id); disabled or suspended accounts, accounts with no mapped group, username conflicts and accounts
  beyond the importer's roles are not created. A dry run first (counts and a per-user list); the run names it.
  Routes `GET|POST /api/admin/identity-providers/{id}/directory-imports`, `GET …/directory-imports/{importId}`
  (`identity:manage` and `users:manage`). Console: User stores › the store › Import users (`directories-import.js`).
- **Microsoft Graph delta queries** in directory sync (`/users/delta`, `/groups/delta`, links per store): only the
  accounts that changed are looked up; a 410 (expired link), a deleted group or too many changes fall back to a full
  pull. Google has no incremental listing and is pulled in full. Sync reports carry `mode` and `fullBecause`.
- **Active Directory:** the primary group (`primaryGroupID`, usually Domain Users) resolved through the domain SID and
  mapped like any group (`primaryGroup`, default on); `memberOf;range=` retrieval for large group lists when nesting is
  off; SRV records in RFC 2782 order (priority, then weighted-random), drawn on every connection.
- `provision()` takes `{ signIn: false }` (no last sign-in time) for the import.
- **Migration `143_directory_sync_state`** (`directory_sync_state`, `directory_imports`), not yet registered in
  `migrations/index.ts`; without it sync pulls in full and the import answers 409. The e2e server applies it when
  missing.
- Exprsn platform memberships: no platform endpoint lists a user's organisations and roles for the OAuth access
  token; the endpoint that would be needed is described in `docs/identity.md`. `membershipsPath` stays empty.

### Platform CA tokens: signed claims (Sprint QA-1, release 1.9.9-qa)

- **The platform's fix** (exprsn-platform BUG-082): its CA signed `JSON.stringify(t, Object.keys(t).sort())`, whose
  replacer applies at every depth, so a token's issuer, permission bits, resource and data were signed as `{}`. New
  platform tokens are `sigVersion: 2`, signed over a canonical JSON (keys sorted at every depth) of every field but
  `signature` and `checksum`; v1 tokens verify there until `TOKEN_SIG_V1_SUNSET` (default 2026-11-18), then
  `SIGNATURE_SCHEME_RETIRED`.
- **Here** (`federation/platform-tokens.ts`, `federation/canonical-json.ts`): v2 tokens are verified over every
  presented field; a token from a trusted signing certificate whose signature does not cover what it presents is
  refused `signature_invalid`, and its signed bits, resource and account must equal the CA's answer
  (`claims_mismatch`). The CA is still asked (revocation, use counts). v1 tokens behave as before. New store setting
  `requireSignedClaims` (default false) refuses v1 (`unsigned_claims`, also the reason when the platform has retired
  v1). Shared canonical vectors with the platform: `server/test/fixtures/canonical-json-vectors.json`.
- **Setup:** `scripts/exprsn-platform-api-tokens.mjs` (in `bin/exprsn-setup`) keeps each opted-in store's
  `X-Service-Token` (HMAC of its service id under the platform's `SERVICE_TOKEN_SECRET`) in the tenant vault at the
  store's `tokenServiceToken` reference; idempotent, prints no secret, a no-op when no store opts in (none does
  today). No migration.

### Embedding and classifier metering by workspace, profile and person; the Analytics view for it (2026-10-19)

- **Where embedding and classifier usage counts** (`tenancy/usage-attribution.ts`, `tenancy/default-workspace.ts`):
  every `usage_records` row of an embedding or a classifier call now has a workspace (the object's own: knowledge
  base, memory, conversation; else the caller's current workspace; else the tenant's default workspace, the active
  workspace named or slugged `general`, else `platform`, else the oldest; null only for a tenant without workspaces),
  a profile (the classifier's, or for an embedding by model name the tenant's published profile for that model,
  preferring one whose name starts with `embed`) and the person who caused it (the searcher, the uploader, the
  memory's author, the message's author; background work stays without one). Before, `embed` records had no
  workspace or profile and mostly no user. Workflow and agent model calls on a classifier's profile with no
  workspace count in the default workspace too. `defaultWorkspace(db, tenantId)` is exported for backfills.
- **`KnowledgeService.embed`** takes an options object as its sixth argument: `embed(tenantId, model, texts, label,
  userId, { signal, workspaceId, profileId, preferProfiles })`. Knowledge indexing meters for whoever queued the
  upload (carried from the scan job to the index and classify jobs), else whoever added the source.
- **Analytics** (`GET /api/admin/analytics/summary` and `/daily`): `class=embedding` narrows to embedding and
  classifier usage; by profile, records with no profile are one row per model, named after it; by user, records with
  no person are named "System". Console: the Analytics screen's "Embeddings and classifiers" tab, per profile and per
  user, with requests, tokens, GPU-seconds and cost. No migration.

### Search: the blind index, search across chats and posts, one search box (Sprint 52, B-170 to B-173; migrations `138_search_index` and `139_search_state`, not registered yet)

- **The search index** (`search/`, `s.search`): messages, posts and comments stay sealed; keyword search runs on a
  per-tenant blind index of HMAC-SHA-256 term hashes (`search_postings`, with positions for phrases), hashed 2- to
  4-letter prefixes for type-ahead (`search_prefixes`) and each document's ids, time, label and length
  (`search_docs`). Words are folded (case, accents, a final plural "s"; stop words left out). The tenant's search key
  is random and sealed with its data key, one per version (`search_keys`). Off until a tenant admin turns it on
  (`POST /api/admin/search/enable`): from then, writes are indexed after they commit (never failing them) and the job
  `search.backfill` covers what exists, resumably (its cursor saved after every batch of 200); rebuild and key
  rotation index everything under a new version while queries keep the old one, then delete it. Audited `search.*`
  for those admin actions only; queries are never audited or stored. What the index reveals (term frequency,
  co-occurrence and order, document length, the vocabulary's prefixes) is in `docs/security.md`.
- **Search across chats** (`GET /api/search/messages`): every conversation the reader is in now, filtered by who, a
  conversation, a group's linked conversation, dates, a file or a link, and label; words, "phrases" and prefixes from
  the index fused with the `messaging.embed` vectors by meaning; each result checked again as the reader and shown as
  a snippet with the matched words marked.
- **Post search** (`GET /api/search/posts`): posts and comments of the feed, groups and lists by words, phrases,
  author, tag, group, list, kind and date, with visibility, blocks, mutes and labels applied before counting.
- **One search box** (`GET /api/search`, `GET /api/search/suggest`): chats, posts, files, knowledge, groups, people, app
  records and one's assistant chats, grouped by source, each searched through its own search as the reader; type-ahead
  with completions from the reader's own results. Console: the Search screen (`web/js/screens/search.js`, `#/search`,
  an ARIA combobox with announced counts, chat and post filters, recent searches kept in the browser, and a "Search
  index" tab for tenant admins), the palette's "Search everything", "Search messages" and "Search posts", and "/"
  from any screen. Until the migrations are registered, search answers as before (per conversation, by tag) and
  indexing does nothing.

### Feature flags: targeting, rollout and using flags (Sprint 52, B-167 to B-169; migration `137_feature_flags`, not registered yet)

- **Flags** (`flags/model.ts`, `flags/service.ts`, `s.flags`): key, type (on/off, variant, number with bounds),
  default, description, owner, review date, and a life cycle `planned → active → deprecated → removed` (a planned or
  removed flag answers its default). Stale warnings: deprecated over 30 days, unchanged over 90, planned over 90, past
  its review date, or rolled out to everyone on the platform for over 30 days.
- **Targeting**: values at the platform, plan (set on the flag, or the plan's B-162 entitlement `flag.<key>`), tenant
  and workspace, the most specific winning, each with an optional percentage rollout, sticky by a SHA-256 bucket of
  the flag key and the person (or workspace, or tenant). A flag may be locked to the platform and plans. "Why does this
  tenant see this" (`GET /api/admin/feature-flags/{key}/explain`) gives the winning level and every level's account.
- **Dual control**: a live flag's platform default and platform rollout change only when a second platform admin
  approves; both, defining a flag and its life-cycle moves need a recent sign-in. Tenant admins (`tenant:manage`)
  set their own tenant's and workspaces' values.
- **Using flags**: `s.flags.on(ctx, key)` / `value(ctx, key)`, cached 30 seconds and dropped on every instance over
  the bus (`feature.flags`; subscription changes and approved plan versions drop the tenant's plan); built-in defaults
  through `declareFlag`. The console gets its flags in `/api/me`, `/api/auth/session` and `/api/me/flags`, and
  `web/js/flags.js` hides `[data-feature-flag]` elements (`key`, `!key`, `key=value`) through a MutationObserver, without
  changing `app.js`. A workflow branch step takes `flag` in place of `left`, and an app-flow condition a `flag` leaf.
  Plugins get the capability `read:flags` and the call `flags.read`.
- **Console**: Platform › Feature flags (`web/js/screens/platform-flags.js`), also on its own route `#/feature-flags`
  for tenant admins (in the command palette). Every change is audited `flag.*`. Until the migration is registered,
  every flag answers its built-in default and the screen says flags are unavailable.

### User stores: Active Directory, cloud directory presets, Exprsn platform accounts (Sprint 54, B-182 to B-184; no migration)

- **Active Directory** (`identity/providers/ad.ts`, kind `ad`): LDAPS or StartTLS only (a plain bind is refused in
  every environment); sign-in by sAMAccountName (also `DOMAIN\name`) or userPrincipalName; objectGUID as the link, so
  directory sync follows a renamed account (`lookupById`); nested groups by `LDAP_MATCHING_RULE_IN_CHAIN` with the
  paged results control; disabled, locked and expired accounts refused from `userAccountControl`,
  `msDS-User-Account-Control-Computed`, `lockoutTime` and `accountExpires` before the password is sent, "must change"
  (`pwdLastSet` 0) and expired passwords after it, and AD's bind codes read; an expired or must-change password is told
  in words at sign-in (`403`, `reason`); domain controllers from DNS SRV (a site first, the Global Catalog for a
  forest) with failover.
- **Cloud directory presets** (`identity/providers/store-kinds.ts`): Microsoft Entra ID, Google Workspace, Okta,
  Keycloak and Authentik (OIDC, SAML or SCIM), FreeIPA and 389 Directory Server (LDAP), filling each kind's form. An
  `oidc` store may pull users and groups from Microsoft Graph (client credentials grant) or the Google Directory API
  (a service account's signed assertion) (`identity/providers/cloud-directory.ts`): credentials as `vault:`
  references only, every call through the egress guard, the store joins directory sync with its safety stop, and its
  groups at sign-in come from the directory, named as sync names them. `subjectClaim` (Entra ID: `oid`) picks the
  link claim.
- **Exprsn platform accounts** (`federation/exprsn-platform.ts`, kind `exprsn-platform`, `platform:manage` to change):
  sign-in through the platform's OAuth 2.0 server with the authorization code and PKCE
  (`/federation/exprsn-platform/start` and `/callback`), userinfo and an optional memberships endpoint, the token
  revoked afterwards; linked by the platform account id; organisations and roles become groups `org:<slug>`,
  `org:<slug>/<role>` and `role:<name>`; the preset starts from `PLATFORM_LOWCODE_URL`.
- The kinds and presets are registered in the kind registry (`kinds.ts`, B-181), so the store wizard shows them with
  forms generated from their schemas. Tests: `store-ad.test.ts` (a fake domain controller, `test/fake-ad.ts`),
  `store-cloud-presets.test.ts` (fake Graph and Google, `test/fake-cloud-directory.ts`), `store-exprsn-platform.test.ts`
  (a fake platform authorization server); e2e `identity-store-kinds.spec.ts`.
- **Platform CA tokens on the API** (B-184, last part; `federation/platform-tokens.ts`, no migration): a tenant whose
  active `exprsn-platform` store sets `acceptApiTokens` (default false) accepts the platform CA's signed token object
  (base64url JSON) as a bearer on `/api` and `/v1`. The tenant comes from the matching store (`X-Exprsn-Tenant` when
  several match, else `401 tenant_ambiguous`); the signature (RSA-PSS SHA-256) is checked against the store's trust
  anchor (PEM bundle, or a JWKS with `x5c`), the times with 60 seconds' skew, and the CA's validation endpoint (service
  credentials as a `vault:` reference, cached briefly) gives revocation, the account, the permission bits and the
  resource, which must match `apiAudience`. The person is the account linked through the store (no creation); the
  roles are narrowed by the store's `scopeMap`; no CSRF, no step-up. Refusals audited rate-limited as
  `identity.platform_token.refused`. The store form's new "API tokens" section (a PEM field shows as a text area).
  Test: `store-exprsn-platform-tokens.test.ts` (a fake platform CA).

### User stores: the store wizard and form editor, archive and restore, store backups (Sprint 54, B-180, B-181, B-185, B-186; migrations `140_identity_store_state`, `141_identity_store_backups`, not registered yet)

- **Kind registry** (`identity/providers/kinds.ts`): each store kind registers `{ kind, title, config (zod), schema
  (sections and field labels), presets?, signIn, platform?, test }`; `formFor` generates its form from the zod schema
  (secrets as references, enums as choices, required and defaults from zod), so new kinds plug in with a schema alone.
  `IdentityChain.probe` builds an uncached provider for an unsaved configuration.
- **Store wizard** (`web/js/screens/directories-stores.js`): kind or preset, connection, attributes and groups (with
  first mappings), sign-in order, a test with a real account (the password used once, never stored or audited) and
  review; "test before save" refuses with 409. The form editor has Form, JSON (advanced) and Versions; each saved
  change is a version with its reason and diff. New routes `GET /api/admin/identity-store-kinds`, `POST
  …/identity-store-kinds/{kind}/check` and `/test`, `PUT /api/admin/identity-providers/order`, `GET
  …/identity-providers/{id}/versions`.
- **Archive and restore**: `archived` beside enabled and disabled; an archived store leaves the sign-in chain, sync and
  the sign-in options, keeps its users, mappings and links read-only, optionally ends its sessions and the API keys of
  users with no other store; restore returns it to its previous state (or disabled for review). Audited
  `identity.store.archived` and `.restored`.
- **Store backups**: one store as a sealed (KMS-wrapped AES-256-GCM) and KMS-signed `exprsn-store-backup/1` archive with
  its versions, mappings, links and, for local and SQL stores, account records, password hashes (local) and second
  factors; downloaded or saved to the blob store; restored into this tenant or another of the same installation, into
  the same store or as a new one, with a dry run; a changed archive is refused. Audited `identity.store.backup.*`.
- B-180 (permission areas as an accordion in the role matrix) verified as done; no change.

### Group proposals, voting and carrying out decisions (Sprint 53, B-174 to B-176; migrations `133_group_proposals`, `134_group_votes`, not registered yet)

- **Proposals** (`groups/governance.ts`, `s.groupGovernance`, `routes/group-governance.ts`): free-form, change a group
  setting, add or remove a member, give or take a role, change the group's rules, spend from the group's budget. Draft,
  open, closed (passed, rejected, no quorum), carried out or failed. Sealed as `group-proposal:<id>` with the group's
  label and screened at `user-input`. Opening fixes the electorate, posts the proposal for discussion in the group's
  linked conversation and tells the electorate. Each group's governance settings: who may propose (members, holders of
  a role or more, owners only), the default method, supermajority fraction and quorum, how long voting lasts (minimum,
  maximum, default), secret ballots by default, the kinds owners confirm, and written rules (sealed).
- **Budget** (`groups/budget.ts`): new; a currency, a balance in minor units and a ledger whose memos are sealed;
  owners and admins set the currency and record money in or out; a decision's spend is one entry, unique per
  proposal. Nothing is paid from it.
- **Voting** (`groups/tally.ts`): simple majority, supermajority (two thirds or a set fraction, exact in integers),
  approval (a top tie goes to the option listed first) and ranked choice by instant runoff (a tie for last is broken
  by the earlier rounds, most recent first, then by the proposal's order; each break written into the round). Quorum
  as a share of the electorate or a number of ballots. Votes change until close. Public ballots name their voter to
  members; secret ballots store no voter and no time, keep who voted apart, and give each voter a receipt (an HMAC
  commitment) found in the list published at close (`docs/security.md` says what an administrator could still learn).
  The tally and the working go into the audit chain (`group.proposal.closed`). The job `groups.governance.tick`
  closes due votes and sends one reminder; a new notification kind `group.governance` (voting opens, the reminder, the
  result, decisions carried out or waiting) honours Sprint 49 preferences.
- **Decisions**: a passed proposal of an actionable kind is applied through the group's own services as the group
  (`groups/service-principal.ts`: an owner's rights in that group only, nothing outside it; `GroupService.accessOrNull`
  recognises it), at most once (one conditional claim); the result or the failure is kept on the proposal and posted
  in the conversation. Owners may require their confirmation for chosen kinds (confirm or decline). Adding a member
  accepts a pending request or sends an invitation, as an owner would. Audited `group.proposal.*`, `group.vote.*`
  (participation only for secret ballots) and `group.decision.*`.
- **Console**: a Proposals tab on the group page (`web/js/screens/groups-governance.js`: list, new proposal, voting,
  results with rounds, ballots or published commitments, the receipt kept in this browser and checked, owner
  confirmation, the budget) and a Governance panel in the group's Overview settings.
- Until the migrations are registered the feature reports itself unavailable and nothing changes. Tests:
  `server/test/group-proposals.test.ts`, `group-voting.test.ts`, `group-decisions.test.ts`,
  `server/test/integration/group-governance.test.ts` (PostgreSQL and MySQL), `e2e/tests/group-governance.spec.ts`;
  the e2e server applies 133 and 134 when missing. Routes in `docs/api.md`.

### Albums on Files, album share and upload links, albums in the feed and groups (Sprint 53, B-177 to B-179; migrations `135_albums`, `136_album_links`, not registered yet)

- **Albums** (`files/albums.ts`, `s.files.albums`, `routes/albums.ts`): ordered sets of images (and videos once the
  file store accepts them) that stay files, with a title, a description and a cover; workspace, group and personal
  albums; viewers, contributors (add their own, remove their own) and editors (order, remove any, edit, manage
  people), with the owner managing editors and a group's moderators acting as editors. The album's label is the
  high-water mark of its floor and its items; an item above someone's clearance is never shown or counted. The access
  rule never widens who reads a file: an item goes to the album's audience only while the person who added it could
  share it with them (`docs/security.md`, "Albums"). A grid, a keyboard slideshow (arrow keys, Home, End, Escape; the
  alt text shown and announced; no autoplay or fading under reduced motion), and a streamed zip of what the reader
  sees (`zipStream` in `platform/zip-writer.ts`). Audited `album.*`.
- **Share links** (`files/album-links.ts`): expiry, an optional argon2id password with limited attempts, view only or
  download, revocable; a signed-out page at `#/shared?t=exa_…` with the grid and slideshow; public items only, on the
  tenant's anonymous-link rules; each open and download audited (`album.share.*`).
- **Upload links**: expiry, a maximum number of files and a maximum size, the uploader's name asked and stored as
  given (sealed); each upload is scanned and held until it passes, then added with the album's label; the owner sees
  pending and rejected uploads; recorded with the spam signals per link and address range (`album.upload.*`).
- **Feed and groups**: post an album to its workspace's or group's feed (a card that opens it, labelled at least as
  high as the album), an Albums tab on group pages, and a new notification kind `album`, batched per album and ten
  minutes, honouring Sprint 49 preferences. Files has an Albums entry; the console screen is `web/js/screens/albums.js`
  (`#/albums`, not in the sidebar) and the signed-out pages `albums-public.js`, drawn by `shared.js`.
- `FileService` gains `servedCurrent` and `previewCurrent` (for callers that decided access themselves) and
  `settledListeners` (told when a scan finishes). Until the migrations are registered, albums report as not
  available and nothing changes. Routes in `docs/api.md`.
- Tests: `server/test/albums.test.ts`, `album-links.test.ts`, `album-feed.test.ts`, `e2e/tests/albums.spec.ts`; the
  e2e server applies 135 and 136 when missing, and the accessibility and reflow sweeps include `albums`.

### Notification templates, and a clearer notifications table (migration `132_notification_templates`, not registered yet)

- **Notification templates** (`platform/notification-templates.ts`, `s.notificationPrefs.templates`): named,
  versioned preference sets per tenant (a choice per kind and channel, quiet hours with "urgent passes", digest hour
  and weekday, a description), managed in Tenants › Notifications under `tenant:manage`, the permission of the tenant
  defaults. Applied to one person, a list, a role, a group or everyone, as `replace` (reset the person's kind choices,
  then apply; the time zone is kept) or `fill` (only kinds the person has not chosen), with a dry-run preview that
  counts people and kinds. The choices become the person's own, so they customise afterwards; Settings says "Based on
  template X, version N. You changed M kinds since." One template can be the default for new members: every account
  created in the tenant (`UserRepo.create`, after its transaction commits) gets it. A template that would turn off or
  delay a mandatory kind is refused (`409`, naming the kinds); applying skips kinds made mandatory later. Audited
  `notification.template.created`, `.updated`, `.deleted`, `.applied`. Without the migration's tables the list says
  `available: false`, the other routes answer `503`, and nothing else changes. Routes in `docs/api.md`.
- **Settings › Notifications and the tenant defaults table**: kind titles wrap with the description under them (no
  more text cut off behind the checkboxes); groups collapse (disclosure buttons with `aria-expanded`, Expand all and
  Collapse all); Enable all and Disable all for the table, a group and a channel change the form only and leave
  mandatory kinds alone, announced politely ("43 kinds turned off; Security alerts is mandatory and stays on");
  below 760 px of width each kind stacks with its channels in a grid. Controls are named "Email for Workflows",
  "Email timing for Workflows", "Mandatory for Workflows".
- Tests: `server/test/notification-templates.test.ts`, `e2e/tests/notification-templates.spec.ts`; the e2e server
  applies 132 when missing.

### CA settings, CA tokens and one-time tickets, member certificates (Sprint 55, B-187 to B-189, B-195; migrations `127_pki_settings`, `128_ca_tokens`, not registered yet)

- **Certificates › Settings** (`pki/settings.ts`, `s.pkiSettings`, `routes/pki-settings.ts`): the CA's settings in the
  console, platform-wide with per-tenant overrides where safe: subject (C, ST, L, O, OU, email), validity, key
  algorithm (ECDSA P-256 and P-384, RSA 2,048 to 4,096) and path length of the root and intermediates; subject of
  issued certificates (and per profile); CRL interval, validity and next update; OCSP answer validity, cache,
  delegated responder (on or off, lifetime, algorithm) and batch requests; ACME terms URL, certificate validity,
  private identifiers and issuing intermediate; the public URL and per-address rate; CA token defaults; member
  certificates. The `PKI_*` variables stay the defaults and, when set, the floors; each value shows its source.
  Out-of-range or weaker values are refused (`422`). Root and intermediate changes wait for a second platform admin
  and apply at the next rotation or re-issue; nothing is re-keyed. Audit `pki.settings.*`.
- **CA tokens and tickets** (`pki/tokens.ts`, `s.caTokens`, `routes/ca-tokens.ts`): compact JWS (ES256, ES384 or
  PS256) signed in custody by a per-tenant token-signing certificate under the intermediate, bound to a URL, DID or
  CID with permission bits (read, write, append, delete, admin); expiry by time, by uses (an atomic spend) or
  persistent; validate, introspect, refresh, revoke and bulk revoke; one-time tickets for a single action; scheduled
  signer rotation (`pki.tokens.rotate`); revoking the signer's certificate revokes its tokens; only the id and hash
  are stored. Public signer chains at `/pki/tokens/<tenant>/keys`. New permission `pki:tokens` (validate, introspect,
  refresh) for tenant and identity admins. Audit `pki.token.*`.
- **Member certificates** (`pki/members.ts`, `s.memberCerts`, `routes/member-certs.ts`): off by default; a client
  certificate (and optionally a CA token) for each member at join, the key picked up once in Settings, renewed before
  expiry by the `pki.members.sweep` job, revoked when they leave and at tenant offboarding. Certificate sign-in
  (`POST /api/auth/certificate`) and mTLS for the API (`X-Client-Cert-Auth: 1`), mapped to the account by a URI or
  email SAN, from a TLS proxy listed in `PKI_CLIENT_CERT_PROXIES` only (`PKI_CLIENT_CERT_HEADER`,
  `PKI_CLIENT_CERT_VERIFY_HEADER`, `PKI_MEMBER_SWEEP_MINUTES`; nginx example in `docs/pki.md`). Audit `pki.member.*`.
- **Signer**: ECDSA P-384 and RSA 4,096 keys, and RSA-PSS signatures (`padding: pss`); restart the signer with this
  release before choosing them. **CLI** `exprsn-ai pki:settings show | set | reset | proposals`. **Console**
  Certificates › Settings and Certificates › Tokens (`web/js/screens/certificates-settings.js`,
  `certificates-tokens.js`).
- Fixed: creating the root awaits the (now asynchronous) step-up check again, so a stale sign-in is refused.

### Leaked-password lists, checks against them and tenant deny words (Sprint 55, B-192 to B-195; migration `131_leaked_password_lists`, not registered yet)

- **Lists** (`identity/leaked/`, `s.leakedPasswords`): platform-wide (`platform:manage`) and per-tenant
  (`identity:manage`) lists of SHA-1 or NTLM hashes, imported from the console or `exprsn-ai passwords:import` as
  HIBP "hash:count" files, one hash per line, or plain text hashed as it streams in (never stored or logged). The
  job `passwords.list.build` sorts and de-duplicates them into prefix-indexed shards in the blob store with a Bloom
  filter in front (`LEAKED_BLOOM_FP_RATE`, 0.1%); every import is a version, which can be made active again to roll
  back. An HIBP mirror (`passwords.list.mirror`, an explicit platform action) fetches all 16^5 ranges of the range API
  at `LEAKED_MIRROR_RPS` and resumes from its cursor. Audit `passwords.list.*`.
- **Checks** (B-193): the password pipeline's leaked step asks every enabled list, then the `BREACHED_*` sources as
  before; the answer is only found, not found or unavailable, never which list or how often. Per tenant: fail open
  (default) or closed when a list cannot be read, and what a sign-in with a password on a newly added list does (warn,
  require a change (default), block), audited `password.leaked.signin`, with a report of the accounts found and
  whether they changed their password. A check against a ten-million-entry list takes well under a millisecond.
- **Deny words** (B-194, `identity/deny-words.ts`, `s.passwordDenyWords`): up to 200 words per tenant, optionally a
  guardrail term list, matched with the B-156 normaliser (case, accents, lookalikes, leetspeak, spacing).
- **Console and CLI** (B-195): Platform › Leaked passwords (`web/js/screens/platform-leaked.js`): lists, versions,
  upload, mirror, the tenant's checks, deny words and report; `exprsn-ai passwords:import`, `passwords:lists` and
  `passwords:check` (a k-anonymous self-check: only a five-character hash prefix leaves the process).
- Settings `LEAKED_BLOOM_FP_RATE`, `LEAKED_BLOOM_MAX_MB`, `LEAKED_CACHE_MB`, `LEAKED_UPLOAD_MAX_BYTES`,
  `LEAKED_MIRROR_RPS`, `LEAKED_WORK_DIR`. With no lists (or before the migration) every check is today's.

### The tenant sign-in policy and OAuth client settings (Sprint 55, B-190, B-191; migrations `129_signin_policy`, `130_oidc_client_settings`)

- **Sign-in policy, enforced** (`identity/signin-policy.ts`, `routes/admin/signin-policy.ts`): per tenant, within the
  platform's bounds: password minimum (never below 12) and maximum length, character classes (off by default), "not
  too close to the old password", a history of the last n (argon2id hashes only, compared by verifying), a forced
  expiry (off by default; saving it warns); lockout attempts, window and duration; session idle and absolute
  lifetimes and the step-up window (only shorter than the platform's); the second-factor kinds allowed. Without a
  policy, sign-in behaves exactly as before. Audit `identity.policy.*`.
- **One password pipeline**: every new password (Settings, reset and invitation links, sign-up, admin create and set,
  and the CSV import's new `password` column) is checked by the policy, then the tenant's deny words
  (`s.passwordDenyWords`), then the leaked-password lists (`s.leakedPasswords`, which decide what a hit or an
  unavailable list means). The strength meter shows the tenant's rules.
- **At sign-in**: the tenant's lockout; a correct password that no longer meets the policy, or has expired, signs in
  to the `password` stage and is changed there (`passwordChange.reason`), never a lockout; the second-factor step
  offers the allowed kinds (an account with none of them keeps its own).
- **What applies to this person** on the user page: the effective policy with its sources (platform floor, platform,
  tenant, default), the password's age and expiry, and the second-factor requirement.
- **OAuth and OIDC client settings** (`federation/client-settings.ts`): tenant defaults and per-client settings for
  the authorization code, access and refresh lifetimes, PKCE for every client or only public ones, the consent screen
  on or off per client, a per-client rate limit at the token, PAR and device endpoints, and refresh-token rotation (a
  reused token revokes its family, recorded in `oidc_refresh_families`; confidential clients may keep a token instead).
  Withdrawing a consent in Settings is audited `oidc.consent.withdrawn`. Audit `oidc.client.settings.*`.
- **Console**: Identity › Sign-in policy (`web/js/screens/identity-signin-policy.js`), token settings in the OIDC
  client inspector, and "What applies to this person" in the User stores user drawer.

### Billing cycles, tiered prices and discounts (Sprint 51, B-163 to B-165; migrations `125_billing_cycles_tiers`, `126_billing_discounts`)

- **Cycles** (`billing/service.ts` `windowFor`, `billing/cycles.ts`): a statement per billing cycle (monthly,
  quarterly, annual or custom, on an anchor day; a 31st anchor gives 28 February), read from `s.subscriptions.at()`
  and `periods()`; the plan and the seats above the included ones in advance, mid-cycle plan and seat changes as
  proration lines (a credit for the old, a charge for the new, over what is left), usage beyond the plan's allowances
  in arrears; price book versions split a cycle as they split a month. A tenant without a subscription, discounts or
  tiered prices keeps exactly its monthly statement; statements stored before read as one-month cycles, unchanged.
- **The line model** (`billing/types.ts` `ChargeLine`, kept in `billing_statements.charges`): plan, seats,
  proration, usage, discount, credit and tax lines; in a cycle statement each line is a whole minor unit (half away
  from zero) and the totals are their sums, tax after discounts. `GET /api/admin/billing/statements/{month}/preview`.
- **Tiered prices** (`billing/tiers.ts`): price book items flat, graduated, volume or package (per block, rounded up),
  with a minimum and a cap per cycle; still effective-dated by price book version, the tier position carrying over a
  version change. Existing flat items are unchanged.
- **Discounts** (`billing/discounts.ts`, `billing/engine.ts`, `routes/admin/billing-discounts.ts`): rules by scope
  (plan, seats, meter, model, model family, statement) and kind (percentage, fixed amount, free allowance, volume
  tiers, annual-prepay commitment), validity dates and targeting (all, tenants, plans); promotion codes with expiry and
  redemption limits, redeemed by a tenant admin (`tenant:manage`), counted in one conditional update; negotiated
  discounts per tenant; an explicit stacking order and a cap (percentage of the pre-discount total or an amount); each
  discount its own line. Above the approval threshold (20% or 500.00 by default; every free allowance) a second
  `billing:manage` holder approves, never the proposer. Audit actions `billing.discount.*` and `billing.promo.*`.

### Plans, subscriptions and the statement PDF (Sprint 51, B-162, B-166; migration `124_billing_plans_subscriptions`)

- A platform-wide plan catalogue: key, name, description, prices per currency and cycle length (cycle price, seat
  price, included seats, in minor units), monthly usage allowances per meter, flat entitlements, visible or private,
  active or retired, a trial length. Prices, allowances and entitlements change only through a version a second
  platform admin approves (`platform:manage`, recent sign-in).
- A tenant's subscription: plan, seats, currency, trialing, active, paused, cancelled or ended; monthly, quarterly,
  annual or custom cycles (1 to 36 months) on an anchor day (1 to 28); cancel at period end; pause and resume; plan or
  seat changes now (prorated over whole seconds, half away from zero) or at renewal. The full history is kept;
  `s.subscriptions.at()` and `periods()` feed the statement engine, and a tenant without a subscription is billed by
  usage alone, as before. The `billing.subscriptions.tick` job writes trial ends, renewals and cancellations.
- `GET /api/admin/billing/statements/{id}.pdf`: a statement as PDF (plan, seats, subscription lines, usage by meter
  and tier, discounts, taxes, totals, credit notes).
- The Stripe push sends subscription and discount lines as their own invoice items, with an idempotency key per line;
  older statements push exactly as before.
- Audit actions `billing.plan.*` and `billing.subscription.*`.

### Guardrails: rule-set tests, term lists and nested conditions (Sprint 50, B-155 to B-157; migrations `119_guardrail_tests`, `120_guardrail_term_lists`)

- **Rule-set tests** (`guardrails/rule-tests.ts`, `s.guard.tests`, `routes/guardrail-tests.ts`): cases on a rule set,
  a text (sealed, labelled, shown only to those cleared) with its context (checkpoint, surface, channel, label, role,
  clearance, account age, new account, spam score) and an expectation (`pass`, `block`, `annotate`, `redact`, naming
  the rule that must fire). They run against the draft after every saved change (the job `guardrail.tests.run`, only
  when the set has cases), on demand, and before publish, approve and promote, which answer `409 Rule-set tests
  failing` with the failing cases until all pass. A run keeps verdicts and its diff from the previous run (cases now
  failing or passing, rules added, removed or changed). Imports: from a finished shadow replay (its result now lists
  the decision ids each rule would hit), from recorded decisions where the set's rules fired, within label and
  clearance, and from CSV with a dry run. Audited `guardrail.tests.*`.
- **Named term lists** (`guardrails/terms.ts`, `guardrails/term-match.ts`, `s.guard.terms`,
  `routes/guardrail-terms.ts`): tenant-wide, versioned deny and allow lists of words, phrases and domains (word
  boundary, substring, or a domain with its subdomains), at most 50,000 entries, matched after normalisation (case,
  accents, full-width forms, Cyrillic and Greek lookalikes, leetspeak, zero-width characters, letters split by spaces
  or dots) by one cached Aho-Corasick automaton per version. The mechanism `{kind: term-list, list, version:
  latest|<n>, except?}`; one list serves many rules, and "used by" shows them. CSV import with a dry run (duplicates
  after normalisation, invalid rows, the limit) and CSV export. Audited `guardrail.terms.*`.
- **Nested conditions** (`platform/condition-tree.ts`, shared with app flows, and `guardrails/conditions.ts`): the
  mechanism `{kind: conditions, when}`, an all/any/none tree up to 4 deep of patterns, term lists, classifier
  categories with a threshold each (S1 0.5, S10 0.8), detectors and facts (surface, channel, label, role, account age,
  new account, and the spam score from the spam module, with its reasons). The live test and test runs return
  `explain`, node by node. Rules without a tree are unchanged; `apps/flows.ts` reads its tree shape, leaves and depth
  from the shared module, with its behaviour and tests unchanged.
- **Console**: a Rules, Tests and Term lists tab row on the Guardrails screen; `web/js/screens/guardrails-tests.js`
  (cases, run, results, the diff since the last run, imports), `guardrails-terms.js` (lists, versions, live test, CSV
  dry run, import, export) and `guardrails-conditions.js` (the condition tree editor: add, remove, move up and down,
  change a group's kind, all from the keyboard; the explanation).
- Tests: `server/test/guardrail-tests.test.ts`, `guardrail-term-lists.test.ts`, `guardrail-conditions.test.ts`,
  `e2e/tests/guardrails-tests-terms.spec.ts`.

### Spam and flood checks and moderation metrics (Sprint 50, B-158 to B-161; migrations `122_spam_signals`, `123_spam_responses`)

- **Rate signals** (`spam/signals.ts`): sliding windows per account, per IP range (/24, /56) and per tenant over
  posts, comments, messages, follows, group invitations, reports, sign-ups, failed sign-ins and firehose records,
  counted in the rate limiter's store (shared across instances with Redis), with thresholds per surface. Each surface
  calls `s.spam.record(event)`, fire and forget and time-boxed; nothing is counted until a tenant saves a policy.
- **Spam patterns** (`spam/patterns.ts`): SimHash near-duplicates sent to many places, link bursts and newly seen
  domains, mention and hashtag flooding, new-account velocity, coordinated clusters of accounts posting the same text;
  a score from 0 to 100 per account with its reasons, decaying with a half-life. Only fingerprints, domains and counts
  are stored. The score is a guardrail condition leaf (`spamScoreFor` in `guardrails/detectors.ts`).
- **Graduated responses** (`spam/service.ts`): slow mode, hold for review (through the held writes), a temporary
  posting limit and a case in the moderation queue with the evidence; shadow mode first (scores only) until an admin
  switches a surface to enforce; never a ban. The person gets a `spam.response` notice (new notification kind `spam`,
  "Posting limits") and a system warning to appeal through the existing appeals; an upheld appeal lifts the response.
  Admins and an allow-list are exempt. `ModerationService` gains `systemWarning`, `updateSystemWarning`,
  `endSystemWarning` and `sanctionEndedListeners`. Audited `spam.scored`, `spam.response.applied`,
  `spam.response.lifted`, `spam.policy.updated`.
- **Metrics** (`spam/metrics.ts`): daily aggregates of guardrail hits per rule and set, action rates, the
  false-positive rate from upheld appeals, time to decision for flags, held writes and appeals, and spam responses by
  kind; `GET /api/moderation/metrics`, the CSV export (`moderation:review`, audited `moderation.metrics.exported`) and
  the optional Overview card "Moderation trends".
- **Routes**: `/api/moderation/spam/policy|accounts|responses|signals|mine`, `POST /api/moderation/spam/responses/:id/lift`,
  `GET /api/moderation/metrics` and `/export`. No new permissions.
- **Console**: the "Spam and flood" tab of the Moderation screen (`web/js/screens/moderation-spam.js`) and the Overview
  card.
- Tests: `server/test/spam-signals.test.ts`, `spam-patterns.test.ts`, `spam-responses.test.ts`,
  `moderation-metrics.test.ts`; `e2e/tests/moderation-spam.spec.ts`.

### Passkeys on every trusted secure origin (2026-10-16)

- A passkey is made and used on the origin of the page asking when it is in `PUBLIC_URL` or `TRUSTED_ORIGINS` and a secure context (https, or localhost), with that host as the relying party (or `WEBAUTHN_RP_ID` when it is a parent domain of it); otherwise on `PUBLIC_URL`, as before (`MfaService.relyingParty`). Enrolment, sign-in and step-up all follow it.

### Files: table builder (Power Query style) and Excel 97-2003 files (migration `121_file_queries`)

- **Query engine** (`files/documents/query.ts`, pure): a source (a sheet of an `.xlsx`, `.xls` or `.ods` workbook, a
  CSV, TSV or JSON file, or another saved query) and up to 100 applied steps from a fixed vocabulary checked by zod:
  types, rename, choose, remove, reorder and duplicate columns, filters (values or conditions), sort, distinct,
  keep and remove rows, fill, replace, text and number transforms, split and merge columns, custom columns in the apps
  formula language (`[Column name]`), conditional and index columns, group by, pivot, unpivot, transpose, headers,
  append and merge (six join kinds). A failing step stops the run and is reported with the table before it; values
  that do not convert become empty and are counted. Every table is held to the document limits.
- **Service and routes** (`files/documents/queries-service.ts`, `routes/file-queries.ts`): files read as the caller
  (`FileService.readyVersion`, new, checks without opening the bytes), decoded versions cached by version id;
  `GET /api/files/:id/tables`, `POST /api/files/queries/preview|values|detect` (`files:read`), saved queries per
  workspace (`file_queries`, labelled with the highest label read, hidden below it), `load` into a new `.xlsx`, `.ods`
  or `.csv` or a sheet of an existing workbook (never one labelled below the data) and `refresh` (`files:write`).
  Audited `file.query.created`, `.updated`, `.deleted`, `.loaded`, `.refreshed`.
- **Excel 97-2003** (`files/documents/xls.ts`): a bounded Compound File reader and BIFF5/BIFF8 records (shared strings
  across CONTINUE records, RK and MULRK numbers, dates by format, booleans, errors, formula results); the upload scan
  accepts a Compound File only when it holds a workbook; the editor opens `.xls` and saves an `.xlsx` copy (`saveKind`
  on `GET /api/files/:id/document`).
- **Console**: `web/js/screens/file-query.js` (`#/file-query?query=` or `?file=`), the Files side pane's "Table
  builder", "New table query" in the inspector and the spreadsheet editor.
- Tests: `server/test/file-queries.test.ts` (with `test/xls-writer.ts`, which writes real `.xls` files),
  `e2e/tests/files-queries.spec.ts`.

### Push providers and delivery (Sprint 49, B-151, B-152, B-154; migrations `117_push_providers`, `118_push_deliveries`)

- **Providers** (`push/`, `s.push`, `/api/admin/platform/push/*` with `platform:manage` and `/api/admin/push/*` with
  `tenant:manage`): platform defaults and per-tenant overrides of Apple APNs (HTTP/2, an ES256 token from a `.p8` key
  renewed every 50 minutes, or a certificate; sandbox or production), Google FCM (HTTP v1 over HTTP/2, a service
  account's OAuth token minted with a signed assertion and cached), Web Push (VAPID, RFC 8030 delivery, RFC 8291
  `aes128gcm` encryption in node:crypto; key pairs generated into the vault), any HTTP vendor (URL, method, auth from
  the vault, a body template and a response mapping for success, retry and "token gone") and WebSocket (the console's
  own socket with acknowledgements, or an outside endpoint). Credentials only as `vault:` references; checks without
  sending; test sends to one's own devices. Audited `push.provider.created`, `.updated`, `.checked`, `.deleted`,
  `push.test.sent`.
- **HTTP/2 through the egress guard** (`guardedHttp2Connect`, `guardedHttp2Request` in `platform/egress.ts`): resolve,
  check every address, dial the checked one, cap each answer; `guardedRequest` also sends bytes.
- **Delivery** (`push.deliver`, `push.fallback`, `push.send`): the console's socket first when the person is online,
  push when no client acknowledges in time (5 s by default); preferences asked per channel (digests collected,
  suppressions logged); one job per notification and device over one reused HTTP/2 session per provider and origin;
  collapse id, time to live and priority (`NotifyInput.push`); retries on 429 and 5xx at `Retry-After` or a backoff;
  tokens the provider says are gone end the device. With no provider configured nothing changes.
- **Delivery log** (`push_deliveries`, `/…/push/deliveries`): sent, failed, dropped, suppressed, retrying and waiting,
  with provider, status, reason and latency, never the token or the text; kept 30 days (`push.deliveries.sweep`).
  Metrics `exprsn_push_deliveries_total` and `exprsn_push_send_seconds` per provider.
- **Console and CLI**: Platform › Push providers (`web/js/screens/platform-push.js`); `web/sw.js` and `web/js/webpush.js`
  (`App.webPush.subscribe()`/`unsubscribe()`, used by Settings › Devices, and the socket acknowledgement);
  `exprsn-ai push:test --user <u> [--kind]`.
- Tests: `push-providers`, `push-delivery`, `e2e/tests/platform-push.spec.ts`.

### Push devices and notification preferences (Sprint 49, B-150, B-153, B-154; migrations `115_push_devices`, `116_notification_preferences`)

- **Devices** (`platform/push-devices.ts`, `/api/me/devices`): each person's endpoints (iOS, Android, web, desktop)
  with the provider kind (`apns`, `fcm`, `webpush`, `http`, `websocket`), app id and a name; the token or Web Push
  subscription sealed with the tenant key and shown only as a fingerprint; registering the same token again updates
  its row; rename and revoke; last seen. Admins list and revoke a person's devices with `users:manage`
  (`/api/admin/users/:id/devices`). Devices end with the person's sessions (sign out everywhere else, signing out,
  password changes, deactivation, tenant offboarding, whose purge deletes them), when a provider reports them gone
  (`s.pushDevices.markGone`), and after `PUSH_DEVICE_IDLE_DAYS` (90) idle (`push.devices.prune`).
  `s.pushDevices.forDelivery` gives the delivery job the opened tokens. Audited `push.device.registered`, `.renamed`,
  `.revoked`, `.gone`, `.pruned`.
- **Notification preferences** (`platform/notification-kinds.ts`, `platform/notification-prefs.ts`,
  `/api/me/notification-preferences`, `/api/admin/notification-defaults`): an explicit catalogue of notification
  kinds; per person, kind and channel (in-app, email, push, WebSocket) on or off, at once or in an hourly, daily or
  weekly digest; quiet hours per weekday in the person's time zone, across midnight and daylight saving changes, with
  urgent notifications let through or not; tenant defaults and kinds a tenant admin makes mandatory (security alerts
  are mandatory everywhere). `s.notificationPrefs.decide` answers every delivery path, cached; `Notifications.notify`
  asks it for in-app and email, so with no preferences nothing changes. Held notifications go out at their period as
  one in-app summary and one email (`notifications.digest`, every `NOTIFICATION_DIGEST_MINUTES`). Audited
  `notification.prefs.updated`, `.reset`, `notification.defaults.updated`.
- **Console**: Settings › Devices and Settings › Notifications (`web/js/screens/settings-devices.js`,
  `settings-notifications.js`, panels of Settings), and Tenants › Notifications for the tenant's defaults.
- Tests: `push-devices`, `notification-prefs`, `e2e/tests/settings-devices-notifications.spec.ts`.

### Connections: Redis, RabbitMQ, Prometheus, InfluxDB, OData v4 and OpenAPI import (2026-10-16; no migration)

- **Redis** (`redis.ts`): one read command at a time from a fixed list (GET, HGETALL, LRANGE, ZRANGE, XRANGE, SCAN with
  MATCH, JSON.GET, TS.RANGE…) on allow-listed key patterns (`customer:*`); writes, KEYS, scripts and admin commands
  refused; the checked address dialled; ranges capped before they are sent; `test` reads the ACL (`ACL DRYRUN`).
- **RabbitMQ** (`rabbitmq.ts`): the management API, read-only: overview, queues, one queue, exchanges, bindings,
  consumers, and (off unless the connection turns it on) peek, which fetches and requeues; queues named
  `<vhost>/<queue>` on the allow-list; list answers filtered to it.
- **Prometheus** (`prometheus.ts`): PromQL instant and range queries on allow-listed metrics (every selector names
  one), ranges capped at 31 days and points per series; **InfluxDB** (`influxdb.ts`): v1, v2 (InfluxQL through the
  compatibility API) and v3 (SQL or InfluxQL), SELECT and SHOW only, no INTO, no Flux; measurements on the allow-list.
- **Allow-list patterns** (`patterns.ts`): globs for keys, queues, metrics and measurements; a pattern asked for
  (SCAN MATCH, a `__name__` regex) must sit under an allowed `prefix*`. Allow-list names may now hold `: / ? % [ ] {
  } @ #`. The catalogue carries each engine's query hint, examples and object noun for the data browser.
- **OData v4 API connections** (`odata.ts`): `$metadata` read with the strict XML parser; endpoints name an entity
  set with `$select`, `$expand`, `$filter` (property names, operators and functions only; parameters as typed OData
  literals), `$orderby`, `$search`; `@odata.nextLink` followed only under the base URL; actions and functions never
  offered. **OpenAPI import** (`openapi.ts`): an OpenAPI 3 or Swagger 2 document (JSON or YAML) lists the GET
  operations under the base URL, with typed parameters, a paging and a mapping guess; importing creates endpoints
  through the usual checks; credential parameters are dropped.
- **Egress**: the guarded request and the drivers' host check try IPv4 first, and the guarded request offers every
  checked address, so a host with an AAAA record no longer waits out the timeout on a machine without IPv6.
- **Example servers** (`docker/infra`: `mssql`, `oracle`, `prometheus`, `influxdb`, `redis-samples` with
  `seed-examples.sh`) and `scripts/exprsn-ai-11-example-connections.mjs` in `bin/exprsn-setup`: an example connection
  of every type in tenants localhost and exprsn-platform (public example APIs for GraphQL, SOAP, OData, OpenAPI and
  REST), their hosts on the tenants' allowed hosts.
- Tests: `connections-redis`, `connections-rabbitmq`, `connections-prometheus`, `connections-influxdb`,
  `odata-connections`, `openapi-import`; integration `redis-connection` (`TEST_REDIS_URL`).

### Connections: SQL Server, Azure SQL, Oracle, Snowflake, BigQuery, GraphQL and SOAP (2026-10-16; migration `114_connection_engines`)

- **Engine catalogue** (`connections/engines.ts`, `GET /api/admin/connections/engines`): each engine's family,
  dialect, transport, database field, TLS rule, credential labels and settings (`data_connections.options`, checked
  per engine). The Connections screen's Register dialog, settings and credential dialogs are drawn from it.
- **SQL dialects** (`connections/dialects.ts`): lexing, placeholders (`$1`, `?`, `@p1`, `:1`), identifier quoting and
  allow-list naming per dialect; saved queries bind `:name` parameters in every SQL engine; knowledge sources, file
  imports and the data browser take every SQL engine.
- **SQL Server and Azure SQL** (`mssql.ts`, `classify-tsql.ts`, dependency `tedious`): the checked address dialled
  with TLS verifying the name, reads in a transaction that is always rolled back, Azure redirects only within the
  endpoint's domain, Microsoft Entra service principals through the egress guard.
- **Oracle** (`oracle.ts`, `classify-oracle.ts`, dependency `oracledb` in thin mode): `SET TRANSACTION READ ONLY`,
  the checked address dialled, TLS with the server certificate's DN; PL/SQL, database links, `UTL_*`, `DBMS_*` and
  `NEXTVAL` refused.
- **Snowflake** (`snowflake.ts`, `classify-snowflake.ts`): the SQL API v2 over HTTPS through the egress guard, key-pair
  JWT or programmatic access token, polling and partitions; stages, `SYSTEM$` and `RESULT_SCAN` refused.
- **BigQuery** (`bigquery.ts`, `classify-bigquery.ts`): the REST API with a service account key (RS256 JWT grant),
  positional typed parameters, a byte cap, region INFORMATION_SCHEMA introspection; scripting, `EXTERNAL_QUERY` and
  DML refused.
- **GraphQL and SOAP API connections** (`graphql.ts`, `soap.ts`, `rest.ts`): `rest_connections.protocol`. GraphQL
  runs only `query` operations with parameters as variables, cursor paging over `pageInfo`, and a schema helper. SOAP
  reads a WSDL 1.1 (SOAP 1.1 and 1.2, document and rpc literal) with the strict XML parser, builds envelopes from
  escaped arguments, turns answers into JSON for the mapping, and refuses write-named operations without
  `confirmRead`. Both keep the REST rules: allowed hosts, the egress guard, caps, sealed secrets, the
  untrusted-content checkpoint and audit.
- Tests: `connection-engines`, `connections-mssql`, `connections-oracle`, `connections-snowflake`,
  `connections-bigquery`, `graphql-connections`, `soap-connections`; integration tests `mssql` and `oracle` run with
  `TEST_MSSQL_URL` and `TEST_ORACLE_URL`; e2e `connections.spec.ts`.

### Files: linked storage, imports from URLs, databases and AI objects (2026-10-16; migration `113_file_locations`)

- **Linked locations** (`files/locations/`): a workspace links S3 (AWS, MinIO, any S3-compatible endpoint), Azure Blob
  (shared key or SAS), local stores, SFTP (host key pinned on first use), FTP/FTPS and IPFS (a Kubo node's RPC API, or a
  read-only gateway). Members browse a location; copying in is an ordinary upload (scanned, labelled at least as the
  location, quota counted; folders keep their subfolders; one small file at once, the rest as the job
  `files.location.import`); "Send to…" writes a Files file out (images without metadata). Credentials are sealed
  (`file-location:<id>`) and never returned. Every connection resolves its host once, checks each address (cloud
  metadata refused; internal hosts only through `SERVICE_ALLOWED_HOSTS`; public hosts only through the tenant's allowed
  hosts) and dials the checked address (`files/locations/net.ts`). New permission `files:link` (tenant admin,
  connection admin). Dependencies `ssh2`, `basic-ftp`.
- **Local stores**: operators offer server directories under Storage › Local stores (`platform:manage`, step-up),
  to every tenant or to some; never the blob or media directories; paths are kept inside the store with `realpath`.
- **Imports** (`files/imports.ts`, `routes/files-imports.ts`): a URL (the `http_download` rules), a database table,
  SQL or saved query through the governed read path (CSV with formula cells neutralised, XLSX, JSON), a knowledge
  document (Markdown, text, or its original through the new `KnowledgeService.originalOf`), an agent or workflow run
  (Markdown or JSON), a workflow's signed bundle, a skill (Markdown with front matter) and a tool definition (secrets
  withheld). Each keeps at least its source's label. Files › Import menu.
- `signV4` encodes query values as RFC 3986 asks (`!'()*` were left bare).
- docker/infra: SeaweedFS (S3, :9000), Azurite (:10010), Kubo (:5001, gateway :8088), SFTP (:2222) and FTP (:2121),
  loopback only, for trying the connectors.
- Tests: `file-locations-api`, `file-locations-connectors-a` (S3, Azure, local), `file-locations-connectors-b` (SFTP,
  FTP, IPFS), `file-imports`.

### Roles and access: permission areas collapse like an accordion (2026-10-16)

- **Role matrix**: each area row (Workspace, Admin areas, Vault, Certificates and so on) is a button that collapses or
  expands its permissions, with `aria-expanded` and a count of its permissions and of the grants shown; Expand all and
  Collapse all in the toolbar. Collapsed areas are remembered in the viewer's browser only. A permission search opens
  every area while it is set, so a match is never hidden.
- **Custom-role dialog**: the catalogue picker groups permissions in collapsible areas, each with "n of m chosen"
  that updates as boxes are ticked; areas holding a chosen permission open, a new role starts with all closed, and
  the open areas survive a change of the ceiling preview. Expand all and Collapse all at the top.
- Fix: pressing Enter in the matrix or member search re-rendered twice (Enter, then the input's change event) and
  raised a page error; it now re-renders only when the text changed.
- Tests: e2e `roles.spec.ts` (new accordion test; the custom-role test opens the areas it needs).

### Files as a file manager: document editors, table tools, copies, knowledge, reports, CIDs (2026-10-16; migration `112_file_documents`)

- **Documents** (`files/documents/`): New document creates Markdown, text, CSV, Excel (`.xlsx`), OpenDocument text
  (`.odt`) and spreadsheet (`.ods`) files; the editor (`#/file-edit`, `web/js/screens/file-edit.js`) edits Markdown and
  ODT in a WYSIWYG editor built from a block model (Markdown also as source) and CSV, XLSX and ODS in a grid with
  sheets, formulas, bold and italic. Saves are new versions through the scan; a save based on an older version is 409.
  Shared readers open read-only. Converters: `markdown.ts`, `odt.ts`, `sheets.ts` (own XML reader, no DOCTYPE).
  The scan recognises ODT and ODS (`files/scan.ts`).
- **Table tools** (`normalize.ts`): column definitions (name, type, required, width) kept per file in
  `file_doc_columns`; type inference; normalising (trim, empty markers, type coercion with ISO dates, empty rows and
  columns, duplicates, padding, text and header case) with a report of changed and invalid cells.
- **Copies and bulk actions**: `POST /api/files/:id/duplicate`, `POST /api/files/folders/:id/duplicate` (up to 500
  files); multi-select Move, Copy, Add tags and Trash in the list.
- **Knowledge**: `POST /api/files/:id/knowledge` adds the current version to a base the caller curates (ODT as
  Markdown, spreadsheets as CSV or Markdown tables), never below the file's label; links in `file_knowledge_links`.
- **Reports and dashboards** (`files/reports.ts`, `routes/file-reports.ts`, `web/js/screens/files-reports.js`):
  `/api/file-reports/summary` and eight reports for a workspace or folder subtree, as JSON, CSV (formula cells
  neutralised) or XLSX, or saved into the folder at the highest label they list.
- **CIDs** (`files/cid.ts`): every version carries `cid`, CIDv1 raw SHA2-256 base32, the CID a PDS gives the same blob;
  `GET /api/files/by-cid/:cid`.
- Tests: `file-documents-api`, `file-documents-rich`, `file-documents-sheets`, `file-reports`; e2e
  `files-documents.spec.ts`, and `file-edit` in the accessibility and reflow sweeps.

### Image exports: WebP, GIF, JPEG XL, JPEG, PNG and PDF, downloaded or saved into Files (2026-10-16)

- Images › Export: one image, or several as one animation (a page each in PDF); downloaded, or saved into Files at the images' label (`files:write`). `POST /api/images/export` and `GET /api/images/export` (`images:generate`, `images/export.ts`), audited `image.exported` with the SHA-256 of the sources and the result.
- JPEG XL: transparency, 8, 10, 12 or 16 bits per channel, lossless, animation, HDR (PQ or HLG, Rec.2100 with BT.2020 primaries), a region of interest decoded first, tile size, progressive, effort.
- The converter: `image_convert` takes `frames` (2 to 120 images, 40 MB in all) and the JPEG XL options; image `exprsn-ai/imgconv:2` on Debian trixie (libjxl 0.11, numpy), because libjxl 0.7 misread samples above 8 bits.

### Sprint 48 (Access and safety): security scans as a promotion gate, emergency vault seal (B-144, B-145; migrations `107_security_scans`, `108_vault_seal`)

- **Security scan results** (`security/scans.ts`, `security/scan-formats.ts`, `s.securityScans`): Trivy JSON, SARIF
  2.1.0 and CycloneDX SBOMs, uploaded from the console or by a CI hook (`PUT /api/admin/security/scans/upload`),
  normalised to findings (severity, id, package, version, fixed version, licence, path) and stored against the exact
  digest of an app package, a plugin bundle or a script runner image.
- **The gate**: a tenant policy (critical and high counts allowed, the maximum age of a result, a licence deny-list,
  what happens without a result: allowed with a warning by default) checked at pipeline promotion to test and
  production and again when the deployment runs, at plugin enablement and upgrade, and at SCRIPT_IMAGE_* proposals
  and approvals. A refusal (409) lists the blocking findings. Exceptions with a reason and an expiry count once a
  second platform admin approves them. Promotion to test may now name an existing package (`packageId`). Audited
  `security.scan.*` and `security.gate.*`. Console: Platform › Security scans (`platform-security.js`), and the gate's
  outcome on the Apps promotion dialog.
- **Emergency vault seal** (`vault/seal.ts`, `s.vaultSeal`): "Seal the vault" proposed by one platform admin and
  approved by another, or break-glass with the escrow threshold of shares. Every instance (bus, persisted flag, a
  5-second poll) drops its data keys, keyring secrets, opened private keys and cached secrets, stops claiming jobs and
  answers 503 "Vault sealed" for everything but health, the console's pages, the session probe and the unseal page.
  The signer drops its key too (new protocol messages `seal`, `unseal`, `seal-status`; a marker keeps it sealed across
  restarts). Unsealing takes k of n escrow shares on `/unseal.html` or with `exprsn-ai vault:unseal`; the audit chain
  records every step while sealed. CLI: `vault:seal-status`, `vault:unseal`, `vault:seal --break-glass`. Console:
  Platform › Vault seal. Runbook: `docs/runbooks/emergency-seal.md`.

### Sprint 48 (Access and safety): plugin creator, Overview cards, knowledge feedback and page tree (B-147 to B-149; migrations `109_plugin_drafts`, `110_overview_prefs`, `111_knowledge_feedback_tree`)

- **Plugin creator** (`plugins/drafts.ts`, `s.pluginDrafts`; console `plugin-creator.js`, opened from Plugins and
  events): a five-step wizard (basics; capabilities from the closed vocabulary with plain-language help and the
  required/optional split; UI surfaces with a live preview drawn by the console's own renderer,
  `App.surfaces.preview`; events and a handler: declarative actions, a webhook or a sandboxed script with a written
  skeleton; review). The server builds the manifest and checks it with `validateManifest` and `surfaceProblems` on
  every change, naming each problem's step. Drafts are saved per person (`plugin_drafts`). The result downloads as an
  unsigned import bundle (sign it offline as any bundle) or the plugin file, or installs as a plugin in the state
  `installed` with nothing granted, so the grant and enable flow, the signing policy and the scan gate apply as
  before. Nothing in a draft is loaded or run by the server. `plugins:manage`; audited `plugin.draft.created`,
  `.saved`, `.exported`, `.installed`, `.deleted`.
- **Overview cards** (`ops/overview-cards.ts`, `s.overviewCards`; console `overview-cards.js`): each admin pins,
  hides and reorders the Overview's cards (Move up and Move down buttons, or drag), picks a compact or comfortable
  density and resets, stored per person in `overview_prefs`. Optional cards: running workflows, SLA items breaching
  soon, pending approvals and knowledge revisions waiting. A card whose permission the admin lacks is never listed,
  computed or accepted in a saved layout. Audited `overview.cards.updated` and `.reset`.
- **Knowledge feedback** (`knowledge/feedback.ts`, `s.knowledgeFeedback`; console `knowledge-feedback.js`): "Was this
  helpful?" on documents, references and the sources of chat answers, with an optional comment through the
  `user-input` guardrail, sealed (`kfb:<id>`); a citation's question is kept only when its author allows it. Per-page
  counts, comments and a curation list (low helpfulness or a recent negative comment) for the base's editors and
  curators, in a new Feedback tab; the negative cases export as an eval-set seed in the shape
  `POST /api/admin/profiles/:id/eval-sets` takes. Audited `knowledge.feedback.given`, `.changed`, `.withdrawn`,
  `.exported`.
- **Page tree and backlinks** (`knowledge/tree.ts`, `s.knowledgeTree`): references get a parent and a position, shown
  as a page tree in the References tab with breadcrumbs, children, links and backlinks in a reference's drawer.
  Links (`[[slug]]` and Markdown links to a bare slug) are written when a revision publishes. Moves are for the base's
  editors, audited `knowledge.reference.moved`, and a move that would make a cycle is refused. Nothing the reader
  cannot read (label, row access, unpublished pages) is listed as a parent, child or backlink.

### Sprint 48 (Access and safety): app-local roles and use-limited credentials (B-143, B-146; migrations `105_app_roles`, `106_credential_use_limits`)

- **App-local roles** (`apps/roles.ts`, `s.apps.roles`): each app's own role catalogue (Clerk, Approver, Viewer...),
  names unique per app with an optional description, held by people, by social groups (their members as
  `s.groups.subjects` counts them) or by every member of a workspace as a default role. Managed by the app's designers
  (`apps:design`, the app's label within their clearance), no tenant administration needed.
- A new policy subject `app_role` in `apps/policies.ts`: row and field policies name a role, `grantFor` reads the
  reader's roles (direct, through a group, or a workspace default) when a policy of the entity names one. A role only
  narrows through policies: it never passes `records:read`/`records:write`, clearance or the app's own scope, and means
  nothing in another app. Renaming a role renames it in the policies; a role a policy names cannot be deleted. Views,
  charts, reports and dashboards are shared with the app's readers as a whole (no subject list), so their rows still
  follow the policies, roles included.
- Explain shows the reader's app roles and how each is held, and which role gave the record and the field
  (`appRole`, `byRole`). Audited `app.role.created`, `.updated`, `.deleted`, `.assigned`, `.unassigned`.
- Packages (`exprsn-app/2`) and promotion carry the catalogue (`roles`, `roles/NNN-<name>.json` in git), never the
  assignments, which belong to each environment; a deployment removes roles the package no longer has. The platform
  importer creates the app's AppRoles by name when the platform serves `/lowcode/api/security/roles`.
- Console: the Roles tab of an app (`apps-roles.js`): the catalogue, assignments with a person picker, group and
  workspace pickers, and "What this role can do" from the policies naming it; `app_role` in the policy editor and
  explain.
- **Use-limited credentials**: an optional `maxUses` on personal and agent API keys (and on the lease behind an
  `exai_k2_` key, `GenericLeases.spend`) and a `max_uses` claim on host tokens for embedded sessions. Each accepted use
  is spent by one conditional update, so parallel requests across instances never pass the limit; at zero the key is
  revoked through `ApiKeyService` (its lease ends too), audited `apikey.exhausted` and its owner notified (the
  embedded session: `app.embed.session.exhausted`). `maxUses: 1` makes a one-shot key. Key lists show the uses left
  (Settings, the agent identity's keys). A key without a limit makes no extra query.

### Public REST connections; endpoint definitions checked before they are saved (2026-10-16)

- `scripts/exprsn-rest-connections.mjs` creates 13 public, keyless REST connections (29 endpoints) in every tenant, labelled public: Open-Meteo, USGS earthquakes, the US National Weather Service, Sunrise-Sunset, SEC EDGAR, the World Bank, US Treasury fiscal data, Wikipedia, Open Library, GitHub, Hacker News, the npm registry and PyPI. Their 13 exact hosts are added to each tenant's allowed hosts (audited `tenant.hosts.updated`). Safe to re-run; it reads every endpoint once to check it.
- `scripts/exprsn-public-data-suite.mjs` builds on them: six workflows published as tools (`weather_briefing`, `us_weather_alerts`, `earthquake_report`, `company_financials`, `country_profile`, `package_health`), the script tool `sec_annual_values`, the skill `public-data-apis`, the profile `public-data` and the agent Public data researcher, all label internal. Both scripts run in `bin/exprsn-setup`.
- Fix: `RestConnections.saveEndpoint` validates the definition against its schema before it stores it. A service caller (not the HTTP route, which already validated) could store a definition that could not be read back, which blocked listing the connection's endpoints.

### Sprint 44 (Insight in Apps): charts and dashboards of an app (B-120, B-121; migrations `100_app_charts`, `101_app_dashboards`)

- **Charts** (`apps/charts.ts`, `s.apps.charts`): bar (vertical or horizontal, grouped or stacked), line, area, pie,
  donut, scatter, number tile (with a target or the previous period) and table, over an entity's records (optionally
  through a saved view), a saved query or a REST endpoint. Group by a field or a date by day, ISO week, month, quarter
  or year (new `bucket` on `records/aggregate`, UTC, on SQLite, PostgreSQL and MySQL); count, sum, average, minimum and
  maximum; a split into at most 8 series; sort, a limit of up to 200 categories, theme colours and labels. Each save is
  a version. Private, or shared with the app's readers by a designer (`apps:design`); saved-query and REST sources need
  `connections:query`.
- **Computed as the reader**: through `records/aggregate` with their grant, clearance and hidden rules (a row they may
  not read is never counted; a field a policy hides or masks makes the chart unavailable to them), or through
  `s.savedQueries.run` and `s.restConnections.read` as them (5000 rows at most, held to the app's label). Cached for 15
  seconds per reader, grant and chart version.
- **Dashboards** (`apps/dashboards.ts`, `s.apps.dashboards`): a grid of chart, number tile, saved view table and
  Markdown text cards (rendered escaped) at preset sizes, with date range and field value filters applied to every card
  that has the field, an auto-refresh interval, private or shared. A card the viewer cannot read says "Not available to
  you". `s.apps.dashboards.render(principal, id, {format: 'html' | 'pdf', filters})`: a static snapshot computed as that
  person, PDF charts as vector drawings (a `drawing` block in `chat/export-pdf.ts`) with their tables; also a download.
- **Console**: the Dashboards tab of an app (`apps-dashboards.js`): the grid, filters, Edit layout (drag, or Move
  earlier and Move later; size presets), PDF and HTML downloads, Subscribe, and the app's charts; the chart builder with
  a live preview and the accessible SVG renderer (`apps-charts.js`): `role="img"` with a summary, keyboard through every
  data point with its value, "View as table" on every chart, patterns and marker shapes as well as colour, theme
  colours only (AA and AAA), no motion when reduced, redrawn at the box's width for reflow.
- Audited `app.chart.created`, `.updated`, `.deleted` and `app.dashboard.created`, `.updated`, `.deleted`, `.rendered`.

### Sprint 44 (Insight in Apps): reports and XLSX, PDF and CSV exports (B-122, B-123; migrations `102_app_reports`, `103_app_exports`)

- **Reports** (`apps/report-engine.ts`, `apps/reports.ts`, `s.appReports`): a definition per app, never SQL, over an
  entity (with a shared saved view and filters), a saved query or a REST endpoint; typed parameters bound into the
  filters or the query's parameters; a table, a grouped table with group headers, subtotals and a grand total, or a
  cross-tab (row fields, a column field, count, sum, average, minimum and maximum, row and column totals, distinct
  columns capped with an "Other" column); computed columns in the formula language; sorting; conditional formatting
  with a symbol and words as well as colour; title, notes and a PDF page setup. Designing needs `apps:design`; running
  `records:read`, and `connections:query` for saved-query and REST sources.
- **Runs as the viewer**: rows through the records query (row policies, field grants and masks, clearance, hidden
  records) or the connections' read API as them; every total counts only rows they may read, and anything computed
  from a masked column stays masked. Row caps with "truncated". Run history with sealed parameters; results cached
  sealed for the report's minutes, only for the person who ran it, then cleared (`apps.report-cache.sweep`).
- **Exports** (`apps/exports.ts`, `s.appExports.render`, the one function scheduled delivery calls as the subscriber):
  records with the current filters, saved views and reports as XLSX, PDF, CSV or HTML (dashboards through
  `s.apps.dashboards.render`). `imports/xlsx-writer.ts` on `platform/zip-writer.ts`: shared strings, typed numbers,
  booleans and dates, frozen header, column widths, bold group and total rows with outline levels. PDF through the chat
  exports' writer, extended additively with A4 or Letter, portrait or landscape, column widths and alignment, shaded
  rows, the header repeated on each page and page breaks. Up to 5000 rows download at once; larger exports run as the
  job `apps.export-file` with progress into a sealed file only the requester downloads, kept 7 days. Masked values are
  exported masked.
- **Console**: the Reports tab of an app (`apps-reports.js`): the run view with parameter inputs, the result table,
  the run history and Subscribe; the designer with a live preview of the first 200 rows; the export dialog
  (`apps-export.js`) on reports and the Records tab.
- Audited `app.report.created`, `.updated`, `.deleted`, `.run`, `.run.failed` and `app.export.rendered`, `.queued`,
  `.ready`, `.failed`, `.downloaded`.

### Sprint 44 (Insight in Apps): scheduled delivery of views, reports and dashboards (B-124; migration `104_app_subscriptions`)

- **Subscribe** to a saved view, report, dashboard or an entity's records (`apps/subscriptions.ts`,
  `routes/apps-subscriptions.ts`, `web/js/screens/apps-subscriptions.js`): XLSX, PDF, CSV or HTML, with parameters and
  filters, on a schedule from the workflow schedule model (a preset or a cron, an IANA time zone, the next runs
  previewed; at least `APPS_DELIVERY_MIN_INTERVAL_MINUTES` apart).
- **Destinations**: email to the subscriber and to other people a designer adds (each rendered as themselves, never
  with the subscriber's data); a folder of the file store the subscriber may write to; a signed webhook (HMAC with its
  own secret, shown once and sealed, or the tenant's Ed25519 key) to a host on the tenant's list of allowed hosts only.
  Files over `APPS_DELIVERY_ATTACH_MAX_BYTES` go to the recipient's file store with a link in the email instead.
- **Options**: only when there are rows; only when the render changed since that recipient's last delivery; a message.
- **Every run re-checks** the recipient's right to the object, clearance and the renderer's own checks; someone who
  cannot read gets nothing and the history says why. Runs are claimed once across instances (`apps.subscriptions`
  tick), retried with backoff (`APPS_DELIVERY_MAX_ATTEMPTS`), and paused after `APPS_DELIVERY_PAUSE_AFTER` failed runs
  in a row with a notice to the owner. The history keeps time, recipients, rows, size and outcome, never content.
- **Unsubscribe** from an email with a signed link (and `List-Unsubscribe` one-click) that stops only that person's
  copies; or from the console.
- **Console**: a Subscribe button on saved views (and `App.appsSubscribeButton` for reports and dashboards), the
  Subscribe dialog, and Subscriptions (`#/app-subscriptions`): My subscriptions, Sent to me and, for tenant admins, All
  in the tenant, with pause, resume, run now, delete and the delivery history. Audited `app.subscription.*` and
  `app.delivery.*`.

### Sprint 47 (Builders' tools): designer editing; presence and soft locks in the designers (B-137, B-140; migrations `097_designer_editing`, `098_design_locks`)

- **Undo and redo** of every change to a workflow's draft graph in the session (100 steps back), with Ctrl/Cmd+Z,
  Shift+Ctrl/Cmd+Z or Ctrl+Y and buttons; also on the app-flow canvas.
- **Copy, paste and duplicate** of one or more selected steps (Shift-click, Ctrl/Cmd+A) with the edges between them and
  new ids, through this browser's clipboard, so they paste into another workflow; the pasted steps' references are
  checked there and those that do not resolve are flagged in the inspector. App-flow actions copy, paste (also into
  another app's flow, with their entity and fields checked) and duplicate.
- **Step comments** kept on the step in the draft graph, stamped by the server with who wrote them; carried by
  versions and bundles, never validated or run.
- **Zoom** (buttons, Ctrl+wheel, + - and 0 on the canvas), panning by dragging the canvas, a keyboard-operable
  **minimap**, and a list of the shortcuts; smooth scrolling only without `prefers-reduced-motion`.
- **Tags and favourites**: tenant tags on workflows (`PUT /api/workflows/:id/tags`, `GET /api/workflow-tags`), a
  per-person star (`PUT`/`DELETE /api/workflows/:id/favourite`), and filters by tag and favourites in the list.
- **Presence and soft locks** in the workflow designer, the app-flow canvas, the form editor and the entity designer
  (`realtime/design-locks.ts`, `routes/design-locks.ts`, `web/js/screens/design-presence.js`): who else has it open,
  through socket rooms the server joins from the principal; the first to change holds an edit lock renewed by the
  heartbeat and released on save, close, disconnect or expiry; others are read-only and may take over (the holder is
  told and keeps unsaved changes on the device); tenant admins may break it. A save against someone else's lock is
  refused with `409 Being edited`. The rows are in the database and the state goes on the bus, so it works across
  instances. Audited `design.lock.taken`, `.released`, `.taken_over`, `.broken`.

### Sprint 47 (Builders' tools): workflow templates, schedules with a time zone, workflow analytics (B-136, B-138, B-139; migrations `094_workflow_templates`, `095_workflow_analytics_indexes`, `096_workflow_schedule_timezone`)

- **Template gallery.** Six built-in starters ship as data and publish once bound (`workflows/template-catalog.ts`):
  lead follow-up (record trigger, decision table, branch, notify, wait, reminder), invoice approval routed by amount
  (switch; approvals with a due time, reminders, escalation and a two-of-many quorum), weekly report (schedule,
  saved query, model summary, notice), new-starter onboarding (task records, approval, notices), inbound webhook to a
  record, and document intake (files, curator approval, knowledge, notice). "Save as template" keeps a workflow's
  label and workspace; "use template" goes through the bundle import path with every reference (tools, profiles,
  apps, decision tables, roles, saved queries, knowledge bases, vault references) bound to one of yours or reported
  missing, and makes a draft (`workflows/templates.ts`, `s.workflowTemplates`). Audited `workflow.template.*`.
- **Schedules with a time zone.** A schedule trigger takes `timezone` (IANA; absent is UTC, so existing schedules fire
  exactly as before) with daylight-saving handling both ways, names, `L`, `W` and `#`, 21 presets, a next-runs
  preview and validation messages in plain words (`workflows/schedules.ts`). The tick is still claimed once across
  instances.
- **Workflow analytics.** Per workflow: counts by outcome, success rate, p50 and p95 duration, slowest and failing
  steps, top failure reasons and trends by day; a tenant summary; and a "running now" board of queued, running and
  waiting runs with age, current step and owner. SQL aggregates bounded by date range and indexes; only workflows the
  viewer may open, runs within their clearance, and their own runs unless they manage workflows
  (`workflows/analytics.ts`, `s.workflowAnalytics`).
- **Routes.** `/api/workflow-templates` (list, preview, options, check, use, save, change, delete),
  `/api/workflow-schedules/presets` and `/preview`, `/api/workflow-analytics` and `/:id`, `/api/workflow-activity`
  (`routes/workflow-builders.ts`). `WorkflowBundles` gains `snapshot` and `instantiate` (the import path without a
  signature, for templates).
- **Console.** The Templates view (`#/workflows?view=templates`: search, category and tag filters, a graph preview,
  the use-template dialog with bindings) and "Save as template" (`web/js/screens/workflows-templates.js`); the
  schedule editor on the trigger inspector with presets, the time zone and the next runs
  (`workflows-schedules.js`); the Analytics tab and the Running now view (`#/workflows?view=activity`,
  `workflows-analytics.js`). Tests: `server/test/workflow-templates.test.ts`, `workflow-schedules-tz.test.ts`,
  `workflow-analytics.test.ts`, `e2e/tests/workflows-templates-analytics.spec.ts`.

### Sprint 47 (Builders' tools): formula functions; file version compare, alt text and served copies without metadata (B-141, B-142; migration `099_file_meta`)

- **Formula functions.** The safe evaluator gains about 45 functions (`apps/formula-functions.ts`): text (`Proper`,
  `Substitute` with an instance, `Split` to a list, `Join`, `Find`, `Search`, `Rept`, `Value`, `Char` and `Code`
  limited to printable characters, `text` with a small number and date format vocabulary), logic (`Switch`,
  `IfError`, `IsNumeric`, `IsText`), math (`Power`, `Sqrt`, `Exp`, `Ln`, `Log` with a base, `RoundUp`, `RoundDown`,
  `Mod`, `Sign`, `Clamp`, `Average`, and `min`, `max`, `sum` over lists), dates (`DateAdd` and `DateDiff` in seconds to
  years with month-end handling, `Hour`, `Minute`, `Second`, `Weekday`, ISO `WeekNum`, `EOMonth`, `NetWorkDays` and
  `WorkDay` with holidays; UTC unless an IANA zone is given) and lists (`List`, `Count`, `CountIf` with a condition on
  `item`, `First`, `Last`, `Index`, `Sort`, `Unique`). Still no `eval`, `Function` or globals; names are
  case-insensitive. New functions' arguments are checked at save with messages that name the function, the argument
  and what it must be; text, list and work limits; the old functions behave as before. Nesting now counts calls inside
  calls rather than precedence levels, so `Join(Sort(Unique(Split(x))))` is no longer "nested too deeply".
- **Formula editor.** `GET /api/apps/formula-functions` (the catalogue: signature, description, example, category)
  and `POST /api/apps/formula-check` (the save-time check while typing); the entity designer lists the functions with
  search and Insert at the cursor, and shows the server's check (`web/js/screens/apps-formula.js`). The advisory check
  in `apps.js` now skips single-quoted text and ignores the case of function names.
- **Version compare.** `GET /api/files/:id/compare?from=&to=`: a line diff (`textDiff`) of text, Markdown, CSV, JSON,
  HTML, PDF and Word versions (text extracted as `files.read` does), or both previews of an image
  (`GET /api/files/:id/versions/:n/preview`), for members cleared for both versions; "too large to compare" past 4 MB
  or 1,000,000 characters. The file inspector's Compare dialog shows one column or side by side. Audited
  `file.versions.compared`.
- **Alt text and description on images.** Per file, with the version they were written for; editable by people who
  may change the file (`PUT /api/files/:id/meta`, screened at `user-input`, audited `file.alt.updated` and
  `file.description.updated`), used as the `alt` of every preview and thumbnail in the console, matched by file
  search, and used as the alt of crossposted pictures. "Suggest alt text" asks a vision profile through the gateway
  (`POST /api/files/:id/alt-suggestion`, audited `file.alt.suggested`); the suggestion is shown as one and saved only
  when a person saves it.
- **EXIF stripped from served copies.** Images are served without EXIF, GPS, XMP, IPTC, comments, text chunks, C2PA
  manifests and trailing data, keeping the ICC profile and the orientation (`files/exif.ts`, a JPEG, PNG, WebP and GIF
  container rewriter, no image library): downloads, version downloads, previews, links (signed-in and anonymous), DAV
  for non-owners, avatars, group pictures and crossposts. The original is kept intact; its owner downloads it with
  `?original=1`. `docs/security.md` has the details.

### Sprint 45 (Data in): saved connection queries and REST connections (B-125, B-126; migrations `090_saved_queries`, `091_rest_connections`)

- **Saved queries.** A named query on a data connection with typed parameters (string, number, boolean, date, list,
  identifier; required, default, allowed values, range) and row and time limits (`connections/saved-queries.ts`,
  `connections/params.ts`). SQL takes `:name` placeholders, bound as the driver's own (`$1`, `?`); OpenSearch and
  MongoDB JSON take `{"$param": "name"}`, replaced by the value. Classified when saved (writes refused unless marked as
  a write query by a connections manager, and a write query never runs), checked again against the allow-list,
  masked and passed through the `db-query` guardrail at every run. Draft and published versions with a test run;
  audited `connection.query.*`.
- **REST connections.** A base URL on the tenant's list of allowed hosts, authentication (none, basic, bearer, an API
  key in a header or the query, OAuth2 client credentials) with the secret sealed or a `vault:` reference and movable
  to the vault (`rest-connection` in `vault/credential-moves.ts`), default headers without credential literals, a
  timeout and a size cap (`connections/rest.ts`). Named GET endpoints with path parameters, query parameters, paging
  (page, offset, cursor, Link header) and a response mapping with typed fields. Every request through `guardedRequest`;
  every answer through the `untrusted-content` checkpoint. Audited `connection.rest.*`.
- **One read API.** `POST /api/connection-queries/:id/run` and `POST /api/rest-connections/:id/endpoints/:endpoint/read`
  (new permission `connections:query`) return typed columns, rows, truncation and a cursor; the same path is
  `s.savedQueries.run` and `s.restConnections.read` for imports, and the built-in tool `connections.query` for chat,
  agents and workflow tool steps.
- **Sources.** Knowledge sources of kind `saved-query` and `rest` (rows become documents on sync), app lookups with
  `source: query` or `rest` (only queries and endpoints offered to lookups), and app entities pulled read-only from a
  REST endpoint (`app_entity_sources.kind = rest`).
- **Console.** The Connections screen lists REST APIs (register, settings, authentication, endpoints with a test call
  showing the mapped rows) and has a Saved queries tab per data connection (editor, parameters, test run, versions)
  (`web/js/screens/connections-sources.js`).
- **Fix.** `guardedRequest` rejects an answer cut at its size cap instead of sometimes resolving it short.

### Sprint 45 (Data in): many-to-many relationships and back-references in Apps (B-128; migration `093_app_record_links`)

- **Relation fields.** A new field type `relation` links a record to many records of another entity of the app, or of
  its own (a self-relation, `symmetric` for "related tickets"). Links are rows of `app_record_links` (relation,
  from, to, position; unique per pair; indexed by relation and from, and by relation and to), never values of the
  record. `inverse` shows a back-reference ("related records") on the target, editable from there when `twoWay`;
  `required` asks for at least one link, `max` caps them, `onDelete` unlinks (the default) or blocks deleting a
  record at either end while links exist. A `reference` with `inverse` gives the one-to-many back-reference,
  read-only.
- **Access.** Every read of related records (lists, `expand`, the Records column, filters, counts) keeps only links
  whose other end the reader may read now (the other entity's row policies and group scope, clearance, hidden
  records); a hidden link is neither listed nor counted. Adding a link needs `records:write`, the record readable
  with its field writable, and the other record readable (`404` otherwise). Field policies apply to relations; a
  credential limited to one entity reaches no other through a relation.
- **Integrity.** Deleting a record removes its links in the same transaction (`app.record.unlinked`); a blocking
  relation refuses with `409`. Removing a relation field or its entity clears its links (`app.relation.cleared`) with
  the schema version; a relation with links cannot change its target. Setting links in a record write
  (`values.<relation>` as ids) shares the versioned update's transaction.
- **Query.** `{field: rel, op: eq | ne | in | exists}`, `{op: matches, where}` (one level, through the other
  entity's grant) and `rel.count` in filters, sorts (keyset cursors too) and aggregate metrics; saved views take them.
- **APIs.** `GET /api/apps/:app/entities/:entity/relations`; `GET|POST …/records/:id/links/:relation`,
  `…/candidates`, `PUT …/order`, `DELETE …/:target`, the same under the entity API (`/api/apps/:app/:entity/:id/links/
  :relation`), and `expand=` with `expandLimit` on record lists and reads. The per-app OpenAPI document and the
  client describe them. Packages carry relation fields and, with data, the links (`links/<entity>.<field>.json` in
  the git layout). The platform importer has nothing to map: the platform's low-code fields reference one record.
- **Console.** The record inspector's Related records (paging, an add-link picker that searches through the reader's
  access, Up and Down, remove), a relation column in the Records table (titles, then +N), relation filters, the
  relation editor in the entity designer (target, cardinality, back-reference, two-way, symmetric, on delete, max) and
  a multi-select for a new record's first links (`web/js/screens/apps-relations.js`).

### Sprint 45 (Data in): spreadsheet and connection imports into app entities (B-127, B-129; migration `092_app_import`)

- **Sources.** An import into an entity reads a workbook (`.xlsx`: the sheet, the header row and a range such as
  `A3:F200` are chosen), CSV or TSV (header row and range too), JSON (an array, the usual wrapper keys, or a dotted
  path such as `data.items`), JSON Lines or pasted text (`apps/import-read.ts`, over `imports/tabular.ts` and
  `imports/xlsx.ts`, which gains `xlsxSheets` and `xlsxRows`). Files come from the file store (or a ready chat
  attachment), so quarantine, type sniffing and the scan come first. A file is read whole within
  `IMPORT_ARCHIVE_MAX_BYTES`, a workbook unpacks to at most `IMPORT_ARCHIVE_MAX_UNPACKED_BYTES` (a zip bomb is `413`),
  and more than `APPS_IMPORT_MAX_ROWS` data rows refuse the import.
- **From a connection (B-129).** An allow-listed table, view or collection (masked as every connection read, after
  the `db-query` guardrail, paged by a key column, needs `connections:manage`; an OpenSearch index through the query
  path), a published saved query with parameter values, or a REST connection's endpoint (the B-125 and B-126 read API,
  cursor paging, `connections:query`). A source key column records which record each row made (`app_import_keys`), so
  a re-import updates instead of duplicating; records are at least the source's label, and a source above the app's
  label or the importer's clearance is refused.
- **Scheduled re-imports.** `app_import_schedules`: a connection import on a five-field UTC cron, its settings sealed,
  each due time claimed once across instances by the `apps.import-schedules` tick, run as its owner and re-checked at
  every run (records:write, the connection right, clearance); a run the owner may no longer do is skipped and audited.
- **Transformations.** A fixed vocabulary with zod-checked options, applied in order and identically in the preview,
  the dry run and the job (`apps/import-transforms.ts`): trim and collapse, change case, split, merge, fill down,
  exact-match replace, parse dates in a chosen format, parse numbers with a chosen decimal mark, default for empty,
  drop rows (empty or matching), dedupe on columns keeping the first or the last. No expressions and no code.
- **New entity from file.** `POST /api/apps/:app/imports/infer` proposes a field per column from a sample (text with
  a rounded `maxLength`, whole or decimal numbers, booleans, dates and dates with a time, an enum from a few repeated
  values, e-mail and web addresses as text with a pattern), required and unique from the data, the PII flags of the
  dataset preview, a title field and a label (confidential when a column is flagged). The designer renames, retypes
  and skips columns; `POST /api/apps/:app/imports/entity` creates the entity through `createEntity` (its checks,
  schema version and audit) and imports into it.
- **Upsert by key.** `upsert: {field, mode}` updates the record whose unique field matches (unchanged rows are
  skipped; `update-only` skips rows that match none), through the record service: policies, validation, audit,
  labels, triggers, AI-fill queueing and the outside-source push all apply.
- **The job.** Still `apps.import`, the dry run first (the default), now with a per-row report (`created`, `updated`,
  `skipped`, `failed`, with reasons), progress, cancellation (`POST /api/apps/transfers/:id/cancel`) and the failed
  rows as a sealed CSV with their reasons (`GET /api/apps/transfers/:id/errors`). Audited `app.import.queued`,
  `.checked`, `.completed`, `.cancelled`, `.failed`, `.entity-created`, `.errors.downloaded`, `.source.previewed` and
  `.schedule.*`. The CSV import of B-2202 is unchanged.
- **Console.** The Records tab's import is a stepper (`web/js/screens/apps-import.js`): source (a file, pasted text or
  a connection), sheet and range, mapping with transformations and a live preview of 20 rows computed by the server,
  the dry run, then the import with progress, cancel, the error CSV and a schedule for connection imports. The Entities
  tab has "New entity from file".
- Tests: `server/test/app-spreadsheet-import.test.ts` (fixtures in `server/test/app-import-fixtures.ts`),
  `e2e/tests/apps-spreadsheet-import.spec.ts` (with `e2e/tests/fixtures/orders.xlsx`); `e2e/tests/apps-lowcode.spec.ts`
  drives the stepper for its CSV import.

### Sprint 46 (Automation): decision tables and the switch step (B-131, B-132; migration `087_decision_tables`)

- **Decision tables.** Versioned, tenant-scoped tables with a label (`decisions/table.ts`, `decisions/service.ts`,
  `s.decisions`): typed input columns (string, number, boolean, date), output columns (with a ranked value list and a
  default), ordered rules and a hit policy: `first`, `unique` (two matches are an error), `priority` (by the output
  values' order), `any` (matches must agree) and `collect` (every match, or `sum`, `min`, `max`, `count`). Tests are
  `-`, `=`, `≠`, `<`, `≤`, `>`, `≥`, `[a..b]`, `in (…)`, `not in (…)`, `contains`, `starts with` and `is empty`,
  written as text in cells and stored structured. Evaluation is pure and deterministic (no code runs) and explains
  which rule matched and why. Publishing checks types, values, overlaps under `unique` and disagreements under `any`
  (exactly, over value sets), and warns of a rule an earlier one always takes first under `first`.
- **Routes.** `/api/decision-tables`: list, create, view, draft (with the revision guard), check, publish, versions,
  test, used-by, export and import as `exprsn-decision/1` JSON, delete (refused while a published workflow uses the
  table). Reading and testing need `agents:run`, designing and publishing `workflows:manage` (no new permission).
  Audited `decision.created`, `.draft.saved`, `.published`, `.publish.refused`, `.tested`, `.exported`, `.imported`,
  `.deleted`.
- **Three ways in.** The workflow step kind `decision` (a table by name, a pinned or the latest version, inputs mapped
  from the run, outputs into the run, at the table's label; read as the run's owner); the app-flow action `decision`,
  compiled onto that step; and the read-only built-in tool `decision.evaluate` (seeded by the migration), as the
  caller and never above the label of the call.
- **Switch step.** The step kind `switch`: a value (a context path or text built from templates) compared with up to 9
  ordered cases (`equals`, `in` a list, a number `range`) and a default; each edge names its case (`edges[].case`) and
  exactly one is taken. Publishing needs unique case labels, an edge for every case, one edge per case and a default
  edge. No retry policy (it decides the same each time).
- **Bundles.** Workflow bundles carry case edges, and decision steps by table name (`references.decisions`); import
  binds each to the table of that name, or another through `bindings.decisions`, and reports it missing otherwise.
- **Console.** A "Decision tables" view of the Workflows screen (`#/workflows?view=decisions`,
  `web/js/screens/workflows-decisions.js`): the rules grid with keyboard navigation, rows and columns added, moved and
  removed, the hit policy, live checks, a test panel with the explanation, versions, export and import. The designer
  has Switch (cases, edges labelled by case) and Decision (table picker, input and output mapping) steps, and the app
  flow canvas a "Decide with a table" action. The view has no sidebar entry of its own yet.
- Tests: `server/test/decision-tables.test.ts`, `server/test/workflow-switch.test.ts`, `e2e/tests/decisions.spec.ts`.

### Sprint 46 (Automation): approval deadlines and quorum, SLA timers and routing (B-133, B-134; migrations `088_approval_deadlines`, `089_sla_routing`)

- **Approval deadlines.** An Approval step may have a due time (`due.afterMs` from when it paused, or `due.at` read
  from the context), up to five reminders before it, and a breach action: notify (default), escalate to another role
  or person (who may then decide too), reject automatically, approve automatically (only with `autoApprove: true` on
  the step, published with a warning, recorded with no decider so four-eyes checks still refuse it), or take the
  step's `timeout` edges (`branch: timeout`, new). `timeoutMs` stays the hard expiry. Stored on the approval row and
  fired by the scheduled `workflow.approvals` tick, each reminder, breach and expiry claimed once across instances; the
  per-approval timeout job is no longer queued (`workflows/approval-deadlines.ts`). Audited `workflow.approval.reminded`,
  `.overdue`, `.escalated`, `.auto-rejected`, `.auto-approved`, `.timed-out`, `.expired`, `.voted`.
- **Quorum.** `quorum: {mode: any | all | count, count, rejects: final | counted}`; one vote per person
  (`workflow_approval_votes`); `all` counts the eligible approvers when the step paused. Publish validation for every
  new option. The pending list and the run view show the due time, overdue and escalated state, the quorum and the
  votes; the designer's Approval inspector edits them and an Approval step's edges switch between "when decided" and
  "on timeout".
- **SLA policies.** Per tenant, queue type (`channel-session`, `flag`, `held-write`, `appeal`) and scope (a channel, a
  moderation queue, a kind): first-response and resolution targets in business hours (weekly windows in a time zone,
  holidays), a warn threshold, a pause while waiting on the customer (channel sessions), and warn and breach actions
  (notify, raise priority, escalate to a role or person). Timers are computed from each item's own timestamps; the
  `sla.tick` job fires the actions once per item and target and keeps outcomes for the statistics (`sla/service.ts`,
  `sla/hours.ts`). `/api/sla/*` with each domain's own manage and review permissions.
- **Assignment routing.** Per queue: manual, round-robin, least-loaded or skills (`user_skills`, matched against the
  item's tags), skipping people who are away or offline, with a fallback. Assignment goes through the domain's own
  path: `FlagService.assignTo`, the new `ChannelService.assignSession` (`POST
  /api/channels/{id}/sessions/{sessionId}/assign`, event `channel.session.assigned`, catalogue version 10) and
  `ModerationService.assignAppeal` (`POST /api/moderation/appeals/{ref}/assign`).
- **Console.** An "SLA and routing" section on the Moderation screen (flags, held writes, appeals) and the Channels
  screen (sessions) with policies, routing, skills and per-queue statistics; SLA badges and a "Breaching soon" filter
  in the queues (`web/js/screens/sla-routing.js`).
- Tests: `server/test/approval-deadlines.test.ts`, `server/test/sla-routing.test.ts`, `e2e/tests/sla-routing.spec.ts`.

### Sprint 46 (Automation): the webhook trigger of every workflow and run retention (B-130, B-135; migrations `085_workflow_hooks`, `086_workflow_retention`)

- **One signed hook for app flows and workflows.** `workflows/signed-hooks.ts` holds the signature, window, replay,
  size, rate and content checks the app flow hook had; `apps/flow-hooks.ts` uses it unchanged in behaviour.
- **Webhook trigger.** A trigger step may have source `webhook`: `POST /hooks/workflows/<tenant>/<workflowId>`, signed
  with HMAC-SHA256 over `<timestamp>.<body>`, five-minute window, replays refused on every instance, 64 KB, 60 a minute,
  JSON objects only, screened by `untrusted-content` and `user-input`, checked against the trigger's output schema,
  run at the workflow's label as the person who turned it on (re-checked each time). Off by default; the secret is
  sealed, shown once and rotated with no grace period (`workflows/hooks.ts`, `workflow_hooks`,
  `workflow_hook_deliveries`). `GET`/`PUT /api/workflows/{id}/hook`, `POST /api/workflows/{id}/hook/secret`
  (`workflows:manage`); audited `workflow.hook.rotated`, `workflow.hook.updated`, `workflow.hook.received`,
  `workflow.hook.refused`. A bundle's webhook arrives switched off with no secret.
- **Run retention.** A tenant policy (finished runs 90 days, failed 180, at most 1000 per workflow) and per-workflow
  overrides (`workflow_retention`); the `workflow.retention` job every 6 hours deletes old runs with their steps, items,
  approvals and redriven dead letters, never waiting runs, runs with an open dead letter, runs finished in the last day
  or held (legal holds on the owner or workspace, holds of scope `object` on a `workflow-run`), recording held runs in
  `retention_skips` (`workflows/retention.ts`). `GET`/`PUT /api/workflow-retention`, `GET`/`PUT
  /api/workflows/{id}/retention`, `POST /api/workflow-retention/prune` with a dry run (`workflows:manage`); audited
  `workflow.retention.updated` and `workflow.retention.pruned`.
- **Console.** The trigger step's inspector shows the webhook (Enable, Rotate secret with the secret shown once, the
  URL, signing instructions with a `curl` example, recent deliveries); the Workflows screen's Retention tab holds the
  workflow's override and the tenant policy, with a dry-run count and prune now (`web/js/screens/workflows-ops.js`).
- Tests: `server/test/workflow-webhooks.test.ts`, `server/test/workflow-retention.test.ts`,
  `e2e/tests/workflows-webhook.spec.ts`.

### Default profile, visible profiles, and every tool on chat, cortex, spark and knowledge (migration `084_profile_preferences`)

- **Default profile by tenant, workspace and person.** `profile_preferences` holds each scope's default
  (`gateway/profile-preferences.ts`): the person's own over the workspace's over the tenant's; a tenant or workspace
  default may override people's choice (the tenant's first). Unusable profiles are skipped. Chat starts a new
  conversation on it. `GET`/`PUT /api/me/profile-preferences`, `GET /api/admin/profile-defaults`,
  `PUT /api/admin/profile-defaults/tenant` and `/workspaces/{id}` (`profiles:manage`); audited
  `user.profile-preferences.updated` and `profile.default.updated`. Console: Settings, Chat profiles; Profiles, Defaults.
- **Visible profiles.** A person hides profiles from their Chat and Compare pickers; `GET /api/chat/profiles` marks
  `hidden`, `default`, `defaultSource` and `defaultEnforced`. A conversation keeps a hidden profile it uses.
- **Tools offered per turn.** A profile listing more than 24 tools has them ranked against the last user message
  (`registry/select.ts`, `ToolDispatcher.resolveForTurn`, `RegistryService.briefs`) in chat and `/v1`; skills' tools
  first. Setup (`scripts/exprsn-profile-catalogue.mjs`) adds every published read-only tool to chat, cortex, spark and
  knowledge, and completes their chat allow-lists where they have one.
- Tests: `server/test/profile-preferences.test.ts`.

### The console's sidebar and side panels

- **The sidebar is an accordion.** Workspace screens in five groups (Assistant, Knowledge, Build, Create, Social), then
  the Admin section by domain: Overview, AI models, Tools & integrations, Safety & moderation, Identity & access,
  Security & keys, Operations (`NAV_GROUPS` in `web/js/app.js`; a screen no group names appears under "Other"). Workspace
  groups start open and admin groups closed; the group of the current screen is always open; the choice is kept in the
  browser (`exprsn.nav`).
- **It collapses to a 64 px icon rail** ("Collapse"): 44 px targets, every link keeps its name as a tooltip and for
  screen readers, and a group opens as a flyout beside the rail. Below 900 px the off-canvas menu is unchanged.
- **Every side panel can be hidden.** `App.decoratePanels` gives each screen's `aside.inspector` and `.leftpane` a hide
  and show button (a 44 px strip when hidden), kept per screen and panel (`exprsn.panels`); screens are not changed.
- Tests: `e2e/tests/shell-sidebar.spec.ts` (accordion, rail and flyout, panels, both checkers in light and dark,
  Standard and Enhanced, reflow at 320 and 640 px).

### Apps: the low-code builder ported from exprsn-platform (migration `079_lowcode_port`)

Decision and gap analysis: `docs/decisions/lowcode-port.md` (ported into the Apps screen, not embedded).

- **Flows on Workflows.** The Apps screen's Flows tab (`web/js/screens/apps-flows.js`) edits an app's automations on a
  canvas of trigger, condition and actions with a node inspector and a condition builder (`all`, `any`, `none` groups,
  14 comparisons). The server (`apps/flows.ts`, `routes/apps-flows.ts`, `/api/apps/:app/flows`) compiles a flow into
  an ordinary workflow (one branch step per comparison, one step per action; retries, and failure edges for "go on
  after a failure"), publishes it and keeps the app trigger that starts it, so runs, labels, approvals and owner checks
  are the Workflows ones. A flow edited on Workflows is noticed (`409`, overwrite on request). Dry runs on a record,
  the run list, and drafts from a description (`/flows/draft`). Audited `app.flow.*`.
- **Records board.** A Board view on the Records tab (`apps-board.js`): columns by state, enum or static lookup; a
  card moves by transition (only allowed moves offered) or by a versioned update, from its menu or by dragging.
- **Records table.** Column chooser (per entity, kept in the browser), sortable headers on indexed and system fields,
  rows per page; Next waits for the page of the current query.
- **CSV import.** Choose a file or paste, map each column to a field (matched by name or title) or skip it
  (`apps-import.js`); the existing import job is unchanged.
- **Form builder.** Fields move up as well as down.

### Apps: flows reach the rest of the environment (migration `082_app_flow_integration`)

Follow-up 3 and the webhook trigger of `docs/decisions/lowcode-port.md`.

- **Integration actions on the canvas.** Run a tool (the grouped, searchable picker of tools published to the
  workspace), Run a script (reviewed or tested versions), Ask an agent, AI step (a profile picker limited to published
  profiles cleared for the entity's label), Send a message (a direct message or a conversation, through the built-in
  `messages.send`) and HTTP request. Each compiles onto the existing workflow step (`tool`, `script`, `agent`,
  `model`, `http`) with all of its checks; records of another entity of the same app were already reachable through
  create, update and transition. Each action's output is `{{steps.act<N>.…}}` in later actions, and the inspector
  lists what earlier actions give (`apps/flow-integrations.ts`, `GET /api/apps/:app/flows/palette`).
- **Checked at save.** A write tool, a message or a writing script needs an approval action with no run condition
  before it, or the flow is refused (it never pauses for one at run time); tools, agents and profiles must be
  published here and cleared for the entity's label; an HTTP request goes only to a host on the tenant's list of
  allowed hosts, with credentials as vault references (a literal secret is refused as the HTTP step refuses it); a
  template that reads a later action, and an approval set to go on after a failure, are refused.
- **Incoming webhook trigger.** `POST /hooks/apps/<tenant>/<flow>` (outside `/api`): JSON at most 64 KB, signed with
  HMAC-SHA256 over `<timestamp>.<body>` (`X-Exprsn-Signature`, `X-Exprsn-Timestamp` within 5 minutes), each signature
  accepted once across instances, 60 requests a minute per flow. Off by default; the secret is shown once, stored
  sealed and rotated at once; the payload passes the `untrusted-content` and `user-input` checkpoints before any step;
  runs carry the flow's label and start as the person who turned the hook on (`apps/flow-hooks.ts`). Audited
  `app.flow.hook.received`, `.refused`, `.updated`, `.rotated`.
- **Flows in packages.** `exprsn-app/2` packages and their git layout (`flows/<name>.json`) carry each flow's model
  instead of its workflow and trigger; import and deployment re-create or update flows by name and compile them again,
  so references re-bind by name; promotion reports them (`report.flows`).
- **AI flow draft** knows the new actions and is told the profiles, agents, tools and scripts available by name.
- Tests: `server/test/app-flow-actions.test.ts`, `app-flow-webhooks.test.ts`, `app-flow-packages.test.ts`,
  `e2e/tests/apps-flows-actions.spec.ts` (axe-core).

### Apps: form sections, wizard steps and condition trees (no migration)

Follow-up 2 of `docs/decisions/lowcode-port.md`, ported from exprsn-platform's form editor.

- **Sections and wizard steps.** A form definition may carry a `layout`: sections (title, help, collapsible, starting
  collapsed) on one page, or a wizard of ordered steps of sections with an optional review step
  (`apps/form-layout.ts`). Stored in the definition as `version: 2` with the fields in layout order; a flat form is
  stored and evaluated exactly as before and described as one untitled section.
- **Nested conditions.** `visibleIf` and `requiredIf` on fields, sections and steps take the flows condition model
  (`all`, `any`, `none` groups of 14 comparisons, imported from `apps/flows.ts`); the one-leaf `visibleIf` of older
  forms is still accepted. The server walks the layout on every submission: fields hidden by their step, section or
  own condition are dropped and never stored, `requiredIf` is enforced, and a missing field's problem names its step.
  Held public submissions are still held, with only the shown fields.
- **One evaluator in the browser.** `web/js/form-layout.js` mirrors the server's evaluator for the console preview,
  the embed page and the new public link page **`/form#token=…`** (its own CSP, not framed; the token stays in the
  fragment). Both pages render sections and wizard steps with a step list (`aria-current`), focus moved to each step's
  heading, per-step checks and a review step.
- **Editor.** The Forms tab moved to `web/js/screens/apps-forms.js`: layout mode (one list, sections, wizard), add,
  move and remove sections and steps, move fields between sections, a keyboard-operable condition tree builder for
  each field, section and step, and a live preview that runs the wizard. The public link is shown as the page URL.
- Tests: `server/test/app-form-layout.test.ts` (flat forms, wizard checks per step, hidden fields dropped, requiredIf,
  held, public and embed submissions, browser and server evaluators agree), `e2e/tests/apps-forms-layout.spec.ts`
  (editor, builder, preview and public page wizard; axe-core; reflow at 320 and 640 px).

### Apps: saved views and a paged board (migration `080_app_views`)

Follow-ups 1 and 4 of `docs/decisions/lowcode-port.md`.

- **Saved views.** A named configuration of an entity's Records tab: table or board and the board's grouping, filters,
  search, sort, the visible columns in their order and rows per page (`apps/views.ts`, `routes/apps-views.ts`,
  `/api/apps/:app/entities/:entity/views`). Private to its owner or shared with the app's readers (sharing needs
  `apps:design`); labelled between the entity's and the app's label and listed only to those it clears; name and
  settings sealed with the tenant key. A personal default view per entity (`PUT .../views/default`). A view stores
  settings only: records are still read with each reader's own policies and clearance. Deleted with the entity or app.
  Audited `app.view.created`, `app.view.updated`, `app.view.deleted`, `app.view.default`.
- **View picker.** On the Records tab (`web/js/screens/apps-views.js`): choose, Save as, Save, Discard changes, Rename,
  Shared with readers, Set as default, Column order and Delete, with an unsaved-changes indicator; the default view
  opens first.
- **Board paged per column.** `POST /api/apps/:app/entities/:entity/records/board` (`apps/board.ts`) returns each
  column's count and first page from the server, by state or an indexed enum or static lookup; "Load more" pages one
  column from its cursor. The board no longer groups the 200 most recent records in the browser. Moves are unchanged.
- Tests: `server/test/app-views.test.ts`, `e2e/tests/apps-views.spec.ts` (axe-core, reflow at 320 and 640 px).

### Apps: importing the Exprsn platform's low-code apps (migration `083_platform_app_import`)

- **Import from Exprsn platform.** `s.apps.platformImport` (`apps/platform-import.ts`) reads one of the platform's
  low-code apps through its API (`PLATFORM_LOWCODE_URL`, `PLATFORM_LOWCODE_TOKEN_FILE`, the operator service URL
  checks) and maps its entities, typed fields, lookups, state machines, forms, flows and records onto a new app or an
  existing one by name. A dry run returns the whole mapping report (what maps, what changes, what is dropped and why,
  the records that would fail, the platform writes); the import is the job `apps.platform-import`, writing through the
  record, form and flow services as the person who started it. Re-running updates by the stored platform ids
  (`app_platform_links`) instead of duplicating. Imported flows start off. Routes under `/api/apps/platform-import`
  (`apps:design` and `platform:manage`); the console's "Import from Exprsn platform" on the Apps screen
  (`web/js/screens/apps-platform-import.js`); the setup script `scripts/exprsn-platform-apps-import.mjs` (dry run unless
  `--apply`). The only platform write, with `markPlatform`, is the lookup `exprsn_ai_link` on the platform app.
- Settings `PLATFORM_LOWCODE_URL`, `PLATFORM_LOWCODE_TOKEN` (and `_FILE`), `PLATFORM_IMPORT_MAX_RECORDS`.
- Tests: `server/test/platform-app-import.test.ts` (a fake platform lowcode API).
- Not done: a sync back of record changes to the platform; platform-wide lookups (`appId` null) and provider lookups
  other than `lowcode.entity`; the platform's `notify` and module actions in flows; record owners and record scopes.

### Chat: export formats, folders and message groups (migration `076_chat_folders`)

- **More export formats.** A conversation exports as Word (`.docx`), OpenDocument text (`.odt`), PDF, a
  self-contained HTML page, plain text and RTF besides Markdown and JSON, all drawn from the transcript the Markdown
  export uses (`chat/export-doc.ts`, `chat/export-formats.ts`, `chat/export-pdf.ts`, `platform/zip-writer.ts`; no new
  dependencies). Pictures the requester may read are embedded, others named with a placeholder. The console's Export
  dialog offers every format.
- **Conversation folders.** Per-user folders in Chat's conversation list, per workspace, nested three deep
  (`chat/folders.ts`; `/api/chat/folders`, `PUT /api/conversations/:id/folder`, `GET /api/conversations?folder=`):
  collapsible groups remembered per user, New folder, Move to folder on each conversation (drag and drop too), and a
  filter to one folder. Deleting a folder moves its conversations back to no folder. Audited `chat.folder.*` and
  `conversation.filed`.
- **Message groups.** Select messages in a conversation and save them under a name (`chat/message-groups.ts`,
  `/api/conversations/:id/groups`); groups are listed in the side panel, renamed, deleted, opened (highlighted) and
  exported on their own (`groupId` on the export). Groups keep message ids only; access follows the conversation's.
  Audited `conversation.group.*`.

### Tools and scripts in workflows

- **Script steps.** The Workflows 2 kind `script` (`workflows/steps/script.ts`, `STEP_KINDS.script`) runs a tenant
  script directly by name and version: the version its published registry tool pins (reviewed), or a pinned version
  that passed its checks and ran cleanly once (tested), wired in by a publisher holding `scripts:run`
  (`ScriptService.refInfo`, `runForStep`). Same sandbox and limits, `tool-call` checkpoint on the arguments, JSON
  output as the step's output, failures through retries and failure edges; publish checks for the script, its label
  against the workflow's, the reviewed tool's input schema and approval. Recorded in the script's runs and audited
  `workflow.script.ran`. `GET /api/workflow-callees` adds `scripts`. No migration.
- **Workflow editor.** The palette offers Tool and Script; the tool picker is searchable and grouped by source
  (built-in, registry, MCP servers, scripts); a Script step picks the script and version and edits its arguments.

### Message folders (migration `077_dm_folders`)

- **Permissions.** Listing folders needs `messages:read`; creating, renaming, reordering and deleting folders and
  filing a conversation need `messages:write` (the owner's choice, 2026-10-15), so a read-only key cannot rearrange an
  inbox.

- **Folders on the Messages screen.** Each person files the conversations they are in into Inbox, Archive or folders
  of their own (nested two deep), without changing what other members see (`messaging/folders.ts`,
  `s.messagingFolders`; `GET/POST /api/messaging/folders`, `PATCH`/`DELETE /api/messaging/folders/:id`,
  `PUT /api/messaging/folders/order`, `PUT /api/messaging/conversations/:id/folder`; conversations carry `folder`). A
  message from someone else brings an archived conversation back to the Inbox; deleting a folder returns its
  conversations there. The console shows a collapsible folder list with unread counts, and Move to folder and Archive
  on each conversation. Audited `messaging.folder.*` and `messaging.conversation.filed`.

### Image editing in chat (migration `074_image_tools`)

- **Built-in image tools.** `image_list`, `image_generate`, `image_crop`, `image_resize`, `image_rotate`,
  `image_blur`, `image_adjust`, `image_effect`, `image_style`, `image_edit` and `image_restyle`
  (`registry/builtin/image-catalog.ts`, `images.ts`). They act as the caller on their own pictures (a gallery picture
  or a picture attached in chat; left out, the newest picture of the conversation) and each adds a new picture; the
  original never changes. They are `read` tools by the owner's decision, so a model calls them in chat without a
  confirmation; the `image` guardrail checkpoint, the GPU quota and the safety classifier still apply.
- **Edits.** `ImageService.edit` queues an `image.generate` job with `backend: editor` and the operations in
  `image_jobs.edits` (checked by `images/edits.ts`); the job runs them on the CPU editor (`ImageEditor`,
  `HttpImageEditor` over `IMAGE_EDIT_URL`: crop, resize, rotate, flip, blur, sharpen, adjust, 14 effects, 16 filter
  styles, border), outside the GPU slots and unmetered. The image worker serves it as `POST /edit`
  (`services/image-worker/edits.py`).
- **Restyle.** `ImageService.restyle` sends the source picture as `GenerateRequest.image` to the first worker in
  `IMAGE_PREFERENCE` order that has `restyles: true` and is up (FLUX.2 klein takes it as a reference picture).
- **The first worker that is up.** `ImageBackend.available()` (a diffusers worker's `/health`, ComfyUI's
  `/system_stats`); `ImageService.pick` and `generateBest` go down `IMAGE_PREFERENCE`.
- **Provenance.** An edited or restyled picture's manifest has `derivedFrom` (the source and its SHA-256) and, for an
  edit, `edits`. New columns `image_jobs.source_kind`, `source_id`, `edits`, `conversation_id`; image views gain
  `url`, `source`, `edit` and `conversationId`.
- **Console.** `web/js/screens/chat-images.js`: a tool result that holds image views shows the pictures in the chat
  (in the answer and on a `/tool` card), follows one still being made until it is done, and opens it full size in a
  dialog.
- **Settings.** `IMAGE_EDIT_URL`, `IMAGE_PREFERENCE`, and `restyles` on an `IMAGE_BACKENDS` entry.
- **Guardrail screening of their results.** The chat screens an image built-in's call and result as the arguments
  with ids masked plus the result's `summary` sentence (`screenedToolText` in `chat/service.ts`, by the owner's
  decision): `llama-guard3:1b` read their ids and JSON as unsafe (S1, S8) and hid the pictures. Every other tool is
  screened as raw JSON as before, and a tool cannot choose its screened text with a `summary` of its own.
- **"latest".** Migration `075_image_tool_schemas` lets `image` be `latest`, `newest`, `last`, `previous` or
  `current` (the newest picture), as models write it.
- **Fixes found in a live chat.** Image backends' HTTP agents take the backend's `timeoutMs` as undici's header and
  body timeouts (the SD worker answers only when the picture is done, and undici's five-minute default failed its
  jobs as "fetch failed"). The image worker's `/classify` and model loading hold its GPU lock (two threads on Metal
  abort the process).
- **Tests.** `server/test/image-tools.test.ts`.

### Scripts: more languages

- **Fourteen languages.** Scripts run Python, JavaScript, TypeScript, Bash, POSIX sh, Perl, Ruby, Tcl, Lua, PHP, awk
  (gawk), jq, SQL and PowerShell (`LANGUAGES` and `commandFor` in `scripts/runner.ts`). Each run is still one
  disposable container with no network, a read-only root, a noexec `/tmp`, the nobody user and the script's limits;
  the interpreter is now the container's entrypoint. Languages that only read files (TypeScript, Tcl, Lua, PHP,
  PowerShell) have `sh` write the source to `/tmp` first. Every language can be promoted to a registry tool as before.
- **Tools image.** `deploy/docker/script-tools` builds `exprsn-ai/scripts:1` (`SCRIPT_IMAGE_TOOLS`): Bash, Perl, Ruby,
  Tcl, Lua, PHP, gawk, jq, SQLite and what shell scripts call (coreutils, grep, sed, diff, bc, miller, xmlstarlet,
  file, python3). TypeScript uses `SCRIPT_IMAGE_NODE` (types stripped, not checked); PowerShell uses
  `SCRIPT_IMAGE_POWERSHELL`. `GET /api/scripts/runtime` lists the image of every language.
- **SQL.** An in-memory SQLite database in safe mode (no `.shell`, `.system`, extensions or file functions). The
  script's stdin is the one-row table `input(body)` (a tool's arguments: `json_extract(body, '$.x')`); results print
  as JSON arrays.
- **Checks.** The blocked-module check knows each language: network commands and `/dev/tcp` in shell scripts (which
  may start programs), network modules and process calls in Perl, Ruby, Tcl, Lua, PHP and PowerShell, network
  redirections in awk (also run with `--sandbox`), dot-commands and file functions in SQL.
- **Console.** Scripts: a language filter, the new runtimes in the create form and the runtimes panel, and templates
  for Bash, Perl, SQL, jq, Tcl and PowerShell.

## 1.7.0

### Groups as access subjects (Sprint 43, B-9801 to B-9805, migration `069_group_access_subjects`)

- **One rule for "a member".** `s.groups.subjects` (`groups/subjects.ts`) says which social groups a person counts as a
  member of: a member row, an active account, the group (and a channel's parent) not deleted, no standing ban or
  suspension, cleared for the group's label, and a member of its workspace. Files, the vault, knowledge and apps all
  ask it at every decision, so leaving a group, being removed, banned or suspended ends what the group was granted at
  once. A grant never lifts anyone above their clearance or the object's label. App policies' `group` subject now
  uses it too (a deleted group, or one outside the reader's workspaces, no longer matches).
- **Ownerless groups (B-9801).** Owners count only while their account is active, for the last-owner rules too. The
  sweep `groups.ownerless` (every `GROUPS_OWNERLESS_MINUTES`, 15) tells the managers of a group whose owners have all
  left, once (`group.ownerless`); `POST /api/groups/:id/claim-ownership` makes a holder of `groups:manage` its owner
  (`group.ownership.claimed`). Member lists leave out departed members unless a manager asks (`departed=1`); notices
  already went to active members only. The group view tells a manager `manager` and `ownerless`.
- **Files and folders (B-9802).** `file_group_grants`: a social group reads a file, or everything below a folder.
  Routes under `/api/files/:id/group-grants`, `/api/files/folders/:id/group-grants`, `/api/files/group-grants/:id`;
  "shared with me" lists them (`sharedVia: social_group`, `viaFolder`). Folders could not be shared before.
- **Vault (B-9803).** The subject kind `social_group` in path grants (deny wins); explain lists the caller's groups and
  names them (`socialGroupNames`).
- **Knowledge (B-9804).** `social_group` as a reader or manager of a base; `GET /api/knowledge/principals` lists groups.
- **Apps (B-9805).** An app (`groupId` on create and update) or one entity (`PUT /api/apps/:app/entities/:entity/group`)
  scoped to a group: visible, and its records listed, read and written, only for the group's members (and
  `tenant:manage`), designers included. Only the group's owners (or `groups:manage`) scope data to it. Policies take
  the subject `group_role` (the reader's tier or custom role in the scoping group).
- **Console.** Groups: "Take ownership" and "Show departed members" for managers. Files: share a file or a folder with a
  group; "via group" in Shared with me. Vault: "Social group" grants and explain. Knowledge: share with a group. Apps:
  group scope on apps and entities, `group_role` policy subjects. Files no longer reloads in a loop when opened from a
  `#/files?folder=` link.

### Response cache (Sprint 43, B-9901 to B-9903, migration `070_response_cache`)

- An exact-match cache for chat and `/v1` turns, off unless a profile sets `cacheTtlSeconds` (`cacheLenient` also
  caches turns with tools, attachments or a temperature above zero). The key is a SHA-256 over the tenant, workspace,
  label, profile and version, model and digest, the versions of the guardrail rule sets in force
  (`Guardrails.versionKey`), the parameters and the whole prompt with its retrieved context: two tenants never share
  an entry, and publishing a rule set misses the cache. Entries (`chat_response_cache`) are sealed with the tenant key
  and expire; a hit is never served above the caller's clearance, passes the output check again, is metered with no
  model tokens (`usage_records.cache_hit`) and audited (`chat.cache.hit`, `api.chat.cache.hit`). `/v1` does not
  cache requests with tools or knowledge and memory context.
- `GET /api/admin/cache/responses` (entries, hits and hit rate per profile) and `POST
  /api/admin/cache/responses/purge` (tenant, profile or entry; `chat.cache.purged`). The job `chat.cache.sweep`
  removes expired entries.

### `did:exprsn` (Sprint 43, B-11301, B-11302, migration `071_user_dids`)

- The platform's self-certifying DID method (`atproto/did-exprsn.ts`): the id is the multibase public key, and the
  document (keys `#atproto` and `#atproto_label`) is derived offline. The server's DID resolver resolves `did:exprsn`
  and `did:key` beside `did:plc` and `did:web`, so labels and service-auth tokens signed under one verify; the public
  XRPC `com.exprsn.identity.resolveDid` answers any of them. Interop vectors from the platform's own resolver and
  label signer are in `server/test/fixtures/atproto/did-exprsn.json`.
- Each user's own `did:exprsn` (`GET /api/me/atproto/exprsn-did`), minted on first use with a key in the signer or
  OpenBao (`atproto_exprsn_dids`; `atproto.user-did.minted`), naming their hosted PDS DID in `alsoKnownAs`. No shared
  secret derives it.

### Plugin UI surfaces (Sprint 43, B-11201 to B-11203, migration `072_plugin_surfaces`)

- Declarative surfaces (`docs/decisions/plugin-ui-surfaces.md`): a manifest's `ui` describes panels as data (text,
  key-value lines, a table, actions) for the slots `settings`, `record`, `conversation`, `file` and `dashboard`, and
  the console renders them with its own helpers. No plugin markup or script reaches the browser; the CSP is
  unchanged. A tenant admin approves each surface (`plugin.surface.approved`) and can disable it at once. The bridge
  (`POST /api/plugin-surfaces/:plugin/:surface/data|actions/:call`) runs only a declared call, as the viewer, within
  the plugin's grants and the viewer's clearance (capped at the plugin's max label); actions are audited. A
  declarative plugin may now have UI surfaces and no action.

### Cross-posting to the author's PDS repo (Sprint 43, B-11401 to B-11403, migration `073_feed_crosspost`)

- An author who opts in (`PUT /api/me/crosspost`) and has an account on this server's PDS has each published post
  that is marked public and labelled public written as an `app.bsky.feed.post` in their repo, with link and hashtag
  facets, up to four images as blobs (the file name as alt text) and a link back to the post. Edits update the
  record; a delete, a change to workspace or unlisted, a label above public or a hide remove it; a takedown also
  labels the record `!takedown`, and a restore writes it again and negates the label. Held posts go out only once
  accepted. Per post: `GET /api/feed/posts/:id/crosspost`. The job `feed.crosspost` keeps each post's record in step.
- The PDS on the public network (B-11401): the runbook is in `docs/deploy.md`; `PDS_RELAYS` stays empty until set
  (`https://bsky.network` is the value to use). Fixed: a relay reconnecting with a cursor below the oldest event the
  trim left now gets `#info OutdatedCursor` (defect F8).

### MCP tool changes reach system admins

- When an approved MCP tool changes its schema, the notification now goes to everyone whose role grants
  `mcp:manage` (`rolesGranting`), system admins and custom roles included, not only `tool-admin` and `tenant-admin`.
  A tenant whose only admin was a system admin was never told that a tool had been disabled. The same applies to the
  notices about an MCP server becoming unreachable or incompatible.

### Sessions and API keys as leases; signing keys as vault keys; third-party credentials in the vault (Sprint 42, B-9206 to B-9208)

Three steps, each with its own expand-only migration that changes no existing row and after which the previous build
still runs. Nothing is moved, converted or registered by a migration or at start-up: each step has one explicit
action, and each action can be taken back. The steps are in `docs/deploy.md`, "Sprint 42: the vault moves".

- **Sessions and API keys as leases (B-9206, migration `066_credential_leases`).** `CREDENTIAL_STORE` (default
  `table`) chooses where a new session and a new API key are kept. With `leases` a session is a lease of kind
  `session` in `vault_leases` that holds only the digest of its cookie token: the renew period is the idle timeout,
  the maximum the absolute lifetime, and signing out revokes the lease. A new API key is `exai_k2_...`: its verifier
  is in a lease of kind `api-key`, with what a request needs of the key in the lease's data, and its row of `api_keys`
  (`store_lease_id`) holds no verifier. Revoking the key revokes the lease and the other way round. Both stores are
  always read, by the form of the token (`l1.` for a lease session) or key, so a request makes one indexed lookup
  (none while the lease is cached) and switching in either direction ends nothing. Nothing is converted: a session
  ends by itself within `SESSION_ABSOLUTE_HOURS`, an `exai_k1_` key stays a row until it expires or is replaced. Keys
  issued under a dynamic lease (B-9301) stay rows. The offboarding of a tenant and the narrowing of an agent
  identity's keys go through the key service, so leases follow. The secret detector of the registry knows `exai_k2_`.
- **Signing keys as vault keys (B-9207, migration `067_signing_key_registry`).** `s.signingKeys`
  (`vault/signing-keys.ts`) registers the OIDC, SAML, webhook, CA, OCSP, content-credential, AT-Protocol and PDS
  signing keys (and, in the platform scope, the issuers of no tenant and the ACME account key) with the vault by
  reference: a row of `vault_signing_keys` with the key's domain, the domain's id for it, where its private half is
  (`signer`, `openbao` or `sealed`) and a path `transit/signing/<domain>/<name>` the vault's policy applies to. No key
  is copied, moved or rotated by registering, and none is read into the in-memory transit. An OIDC or webhook key is
  rotated from the vault (`manage` on `transit/signing/<domain>`) through its domain's own rotation. A transit
  signing key (`ed25519`, `ecdsa-p256`) can be made `custody: held`: its private half is made and used in the signer
  process or OpenBao transit, the version row holds a reference, and signing is a call there.
- **Third-party credentials in the vault (B-9208, migration `068_credential_refs`).** `s.credentialMoves`
  (`vault/credential-moves.ts`) moves webhook secrets, MCP service tokens, MCP OAuth client secrets, data-connection
  passwords, moderation provider keys, channel secrets and knowledge-source keys to KV secrets at `integrations/<kind>/<id>` and records a
  reference in a new column beside the sealed value. The integration then reads through the vault as the tenant
  service `integration.<kind>`, so the path policy, versions and the read audit apply. The sealed value stays and
  stays current (a credential changed after its move is written to both places), so `restore` takes the references
  away at any time. A credential that is already a `vault:` reference, or comes from OpenBao, is left alone. Left
  sealed on purpose: each person's MCP access and refresh tokens, and SIEM destination tokens (the audit forwarder
  does not read through the vault whose reads it forwards). Registry HTTP tools hold only `vault:` references already.
  The Vault screen's Policies tab has a "Third-party credentials" panel with the counts per kind, Move and Take back;
  it and the signing-key actions ask for a fresh sign-in when the server wants one.

Routes: `GET /api/vault/signing-keys`, `POST /api/vault/signing-keys/register`,
`POST /api/vault/signing-keys/:id/rotate`, `DELETE /api/vault/signing-keys/:id`; the same list, register and remove
under `/api/admin/platform/vault/signing-keys`; `GET /api/vault/credential-moves`, `POST /api/vault/credential-moves`,
`POST /api/vault/credential-moves/restore`; `POST /api/vault/transit/keys` takes `custody`. Setting:
`CREDENTIAL_STORE`. Audit: `vault.signing-key.registered`, `.unregistered`, `.rotated`; `vault.credential.moved`,
`.restored`. A session lease writes no `vault.lease.issued` or `.expired` entry (the sign-in is audited where it
happens); its revocation writes `vault.lease.revoked`.

### Group roles and permission flags; event extras (Sprint 42, B-9705 and B-9707)

Migration `065_group_roles_event_extras` (expand only: `group_roles`, `group_members.custom_role_id`, six columns on
`group_events`, three on `group_event_rsvps`). No membership, event or RSVP row changes.

- **Roles (B-9705).** A membership has a tier: owner, admin, moderator, member or guest. Owner, moderator and member
  carry the rights they carried before; admin is everything but deleting the group, guest reads and answers events
  and does not post. A group may define up to 20 custom roles, each a name and the rights it carries (any right but
  `delete`); a member who holds one has those rights and `read`, nothing else. Routes: `GET`, `POST
  /api/groups/:id/roles`, `PATCH`, `DELETE /api/groups/:id/roles/:roleId`; `PATCH /api/groups/:id/members/:userId`
  takes `role` or `customRoleId`. `GET /api/groups/:id` carries `rights` and `customRole`; members carry `customRole`.
- **One place decides.** `groups/roles.ts` holds the tiers' rights and the helpers every check uses (`can`, `covers`,
  `ownsGroup`, `isStaff`, `linkRole`); `roleHas` and every comparison with a tier's name are gone from the groups
  code, the calendar, bans, cases, the linked conversation and CalDAV. Nobody gives a role, an invitation or a custom
  role that carries a right they do not hold; nobody changes, removes, bans or suspends a member who holds a right
  they do not; a person changes their own role only to fewer rights; nobody changes a custom role they hold; the last
  owner stays. Audit: `group.role.created`, `.updated`, `.removed`; `group.member.role` now carries the rights before
  and after.
- **Event extras (B-9707).** An event has a `kind` (in-person, virtual, hybrid), a `virtualUrl` (screened by the
  `user-input` guardrail, sealed, never in a feed), a `visibility` (`group`, `members`, `organisers`), an
  `rsvpDeadline`, `rsvpApproval` and `waitlist`. `draft: true` on create keeps it a draft, read only by those who may
  edit it, with no notice until `POST /api/calendar/events/:id/publish`. With approval, "going" waits as `pending`
  until `POST /api/calendar/events/:id/rsvps/:userId/decide` (audited as `group.event.rsvp.approved` or
  `.declined`). With a waitlist, "going" to a full event waits as `waitlisted`; a freed place goes to the first on the
  list who may still attend, once, and they are told (`event.waitlist.promoted`, audited as
  `group.event.waitlist.promoted`).
- **Changed behaviour.** A banned or suspended person can no longer answer "going" or "maybe" to an event of a public
  group. A holder of `groups:manage` who is a member can no longer make themselves owner through the role route (they
  act as owner regardless). Request and join notices go to whoever holds the right `decide`; case notices to whoever
  holds `cases`.
- Console: the Members tab lists the tiers and custom roles, with a dialog to make and change a role and the Role menu
  offering all of them; the event dialog has the new fields; a draft has Publish; the attendees drawer shows who waits
  and lets an organiser approve or decline. `e2e/tests/groups-roles-events.spec.ts`.

### Group moderators act on cases; a group's linked conversation (Sprint 42, B-9706 and B-9709)

Migration `064_group_cases_conversations` (expand only: `group_case_actions` and `group_conversations`). No existing
row changes, and no conversation is linked by it.

- Cases (B-9706, GRP-16, `groups/cases.ts`, `s.groups.caseWork`). A case is a flag on the group, one of its posts or
  one of its events; it stays a flag of the tenant. A new one is told to the group's owners and moderators, never to
  the reporter or the author. `POST /api/groups/:id/cases/:ref/act` with `{action, note?, days?}`: `confirm` and
  `dismiss` decide the flag; `hide` hides the object through the moderation service, so it is a moderation action its
  author is told of and may appeal, and evidence keeps it (B-9502); `warn` sends the author the moderator's note;
  `suspend` and `ban` go through `GroupBans` in the group the content is in. The last four confirm a flag still open.
  `POST .../assign` gives an open case to one of the group's moderators. `GET /api/groups/:id/cases` now also lists
  the cases of the channels the caller moderates, with `groupId`, `assignee` and `hideable`.
- Reach and independence. A moderator reaches the cases of the groups in which their role has the `cases` right
  (their group; a channel they moderate; a group's owners in its channels) and nothing else of the tenant's flags, at
  their clearance. Nobody decides, or is assigned, a case about their own content (403 `step: independence`). A case
  assigned to someone else is left to them unless an owner acts. Every decision is audited as `group.case.<action>`.
- Appeals. An appeal of an action on a group's content is told to its moderators, except the appellant and whoever
  took the decision. `GET /api/groups/:id/appeals`, `POST .../appeals/:ref/review` and `.../decide` let one of them
  decide it; the moderation service's own rule refuses the appellant and the decider. `ModerationService` gained
  `appealListeners`, `appealRow` and `actionRow`, and `FlagService` `assignTo`.
- Linked conversation (B-9709, GRP-21, `groups/conversations.ts`, `s.groups.conversations`). `PUT
  /api/groups/:id/conversation` (owners) links a new conversation named after the group, or an existing one the caller
  owns. While the link stands the conversation's members are the group's: `dm_members` is kept in step by `sync`
  after every change of the group's membership, and `MessagingService.accessOrNull` asks the group for the caller's
  standing on every read, so someone removed, banned or suspended has no way in. Roles follow the group's (owner,
  moderator as admin, member). Adding, removing, leaving and role changes in the conversation itself answer 409
  `step: group-link`. `DELETE` removes the link and leaves an ordinary conversation.
- Decisions. A member reads from when they came into the conversation: joining later, or leaving and joining again,
  reads from then on. Linking an existing conversation that has people outside the group is refused (409 `step:
  members`) unless `removeOthers` is set, which the audit entry counts. The conversation's label is never below the
  group's: a link is refused when it would be, and so is raising the group's label above it (422 `step: label-floor`).
  A suspended member keeps their row and read position and is told nothing of the conversation meanwhile.
- Console: the Cases tab has Act and Assign and an Appeals panel; the overview has the Conversation panel (Open, Link,
  Remove link); Messages offers no member controls for a group's conversation and points to the group.
- Tenant offboarding deletes the two new tables.

### Vault reference owners; group bans, invite links and messages (Sprint 42, B-9209, B-9701 and B-9702)

Migration `063_reference_owners_group_bans` (three areas, expand only: `vault_reference_owners`, `group_bans`,
`group_invite_links` with `group_invite_uses`, and the nullable `group_requests.message`). No existing row changes.

- Reference owners (B-9209, VLT-10, `vault/reference-owners.ts`, `s.referenceOwners`). A saved `vault:<path>#<key>`
  reference resolves as the person who saved it, so disabling that person stopped the integration. A holder of
  `secrets:admin` may now hand one reference of one person to a workspace or to a service
  (`PUT /api/vault/reference-owners`); `VaultService.resolveFor` then asks that owner's path policy and no person.
  Handing over grants nothing: the owner must already hold `read` on the path (`409`, `step: vault-policy`), the
  admin must be able to read the reference themselves, and the reference reads at no higher a label than the secret
  had at that moment. Nothing is converted by the migration; `DELETE /api/vault/reference-owners/:id` gives the
  reference back to the person. Audit: `vault.reference.owner.set`, `vault.reference.owner.removed`; a read is
  audited with the actor `service: vault.reference` and the owner's name.
- A tenant's vault policy may name a `service` subject called `integration.<name>`, the owner of handed-over
  references. Every other service name stays in the platform scope (400 in a tenant, as before).
- Bans and suspensions (B-9701, GRP-8, `groups/bans.ts`, `s.groups.bans`). `POST /api/groups/:id/bans` with
  `kind: ban` removes the member from the group and its channels, withdraws their pending requests and invitations
  and refuses every way back in (`403` or `409`, `step: ban`): an open join, a request, an invitation, an invite
  link and the acceptance of anything pending; `GroupService.addMember` asks again as the last check. `kind:
  suspend` keeps the membership and takes its effect away for a number of days: `accessOrNull` gives a suspended
  member no role, in the group and its channels, and the lists, the feed, the notices and the user facts of app
  policies leave the group out. Either ends at its time or when a moderator lifts it
  (`DELETE /api/groups/:id/bans/:banId`). The reason passes the `user-input` guardrail, is sealed and is read by
  the group's moderators only; the person is told what and until when. Audit: `group.ban.created`,
  `group.ban.lifted`.
- Invite links (B-9702, GRP-9, `groups/invites.ts`, `s.groups.invites`). `POST /api/groups/:id/invite-links` makes a
  link with `maxUses` and `expiresInDays`; its code of twenty letters and digits is in that answer only and is kept
  as a digest under the platform's `link` key. `POST /api/group-invites/lookup` says what a code leads to and
  `POST /api/group-invites/redeem` joins: the place on the link is taken in one statement before the member is
  added and given back when the group refuses, so a limit of three never admits a fourth. A link admits into a
  group of any join mode, but only someone in its workspace, cleared for its label, a member of the group for a
  channel, not banned or suspended, and while the group has room. Audit: `group.invite-link.created`,
  `group.invite-link.revoked`, and `group.member.joined` with `via: invite-link`.
- Messages (B-9702). `POST /api/groups/:id/join` and `/invites` take `message` (up to 500 characters), screened at
  `user-input` (a block or a hold answers `422`) and sealed with the request; the group's moderators and the person
  concerned read it in the request views.
- Console: the Members tab of Groups has Ban on a member, the panels "Invite links" and "Bans and suspensions", a
  Message on Invite and on Ask to join, and "Join with a code" (also `#/groups?code=`); the Vault's Policies tab
  has "Reference owners".
- Tests: `server/test/sprint42-reference-owners.test.ts`, `server/test/sprint42-group-bans-invites.test.ts`,
  `e2e/tests/groups-bans-invites.spec.ts`.

### Groups: profile fields, search and paging, notifications (Sprint 42, B-9703, B-9704 and B-9708)

- Profile fields (B-9703, `groups/profile.ts`, `s.groups.profile`, migration `062_group_profiles_notices`). A group or
  channel has `tags` (up to ten, lower case, in the clear like the name), a `website`, an avatar and a banner. The two
  images go through the file store (the group's workspace, the group's label, quarantine and scan) and are served
  from `GET /api/groups/:id/avatar` and `/banner` only once the pinned version is released and to a viewer who clears
  the file's label, as a person's avatar is. Tags and the website pass the `user-input` guardrail.
- Member limit (B-9703). `memberLimit` on a group: at the limit it answers `409` (`step: member-limit`) to a join, a
  request to join, an invitation and the acceptance of a pending request or invitation, which stays pending. The last
  place is taken under a lock on the group's row. Lowering the limit below the present count removes nobody.
- Search and paging (B-9704, `groups/paging.ts`). `GET /api/groups`, `/api/groups/:id/members` and
  `/api/calendar/events/:id/attendees` take `q`, and `limit` with `cursor`; with either of the last two they answer
  `{items, next, total}`, cut by keyset so that a row joining or leaving between two requests neither repeats nor
  skips the others. Without them each answers the array it always did. `GET /api/groups/discover` takes `q`. A group
  search matches the name and the tags.
- Notifications (B-9708). The group's members hear of a new event; a change of an event's time tells its attendees
  once (`group_event_notices`, one row per event and sequence) and never one who can no longer read the event; a
  member is told when their role changes or they are removed; owners and moderators hear of joins and departures.
  `POST /api/calendar/events/:id/notify` sends the attendees an organiser's message (screened at `user-input`, kept
  sealed with the event, at most five in 24 hours), and `GET /api/calendar/events/:id/notices` lists what was sent.
  No notification carries an event's sealed title or the message.
- Console: the Groups and events screen shows a group's tags, website, picture and banner and whether it is full;
  Settings has the three fields and the two uploads; the Members tab searches on the server and loads a page at a
  time; an event has "Notify attendees" and "Notices".

### Dynamic API-key leases (Sprint 41, B-9301 and B-9302)

- An `apikey` lease engine on the generic lease table (B-9301, `vault/apikey-leases.ts`, `s.apiKeyLeases`). A role
  names a scope set and a lifetime; reading its credential path (`POST /api/vault/apikey/creds/<provider>/<role>`,
  the vault policy's `read` on `apikey/<provider>/<role>`) issues a fresh key under a lease of kind `apikey`. The
  built-in provider `exprsn` issues this server's own API keys: the key belongs to the reader, carries the role's
  scopes that the reader holds (and that the credential of the request carries), is stored as a digest like every
  API key, and has `api_keys.lease_id`. `ApiKeyService.verify` accepts it only while its lease is live, so a lease
  that is revoked, expired or idle past its renew period ends the key before the sweeper runs; when the lease ends
  the key row is revoked too. A leased key cannot take a lease, leased keys are not in a person's own key list,
  and one person holds at most `VAULT_APIKEY_LEASES_MAX` (20) live leases of a role.
- References (B-9301): `vault:apikey:<provider>/<role>#key` resolves through `VaultService.readValue` like any vault
  reference, as the person who saved it, and issues a fresh key on each read. `assertRefsReadable` checks the policy
  at save. HTTP tools accept it in secret-bearing fields (`isSecretRef`); workflow HTTP steps and plugins resolve it
  through the same call.
- Outside providers (B-9302, `vault/apikey-providers.ts`): the `ApiKeyProvider` interface (`create`, `revoke`), called
  through the outbound address guard with the tenant's list of allowed hosts, with the provider's admin credential
  as a `vault:path#key` reference read as the person who registered it. The reference provider is `github`: GitHub
  App installation tokens (the App id and installation id as configuration, the App private key as the credential).
  The token is kept sealed with its lease only for the revoke; a lease never outlives the token; a token that comes
  back with more than its role asked for is revoked and refused. Nothing is configured by the server: a tenant
  without a registered provider has none, and no call leaves it.
- A lease that ends revokes its key at the provider (`DELETE /installation/token`); a provider that fails leaves the
  lease in `revoking`, retried by `vault.leases.generic-sweep` with back-off. A provider with live leases cannot be
  removed.
- Routes under `/api/vault/apikey` (providers and roles with `secrets:admin`; roles, creds and leases with
  `secrets:read`), the policy namespace `apikey`, migration `061_apikey_leases` (`vault_apikey_providers`,
  `vault_apikey_roles`, `api_keys.lease_id`), the setting `VAULT_APIKEY_LEASES_MAX`, and API-key leases listed with
  Revoke on the Vault screen's Leases tab. `GenericLeases.issue` takes an optional `id`.
- Not done: no console form to register a provider or a role, or to take a lease (the API only); the GitHub provider
  was exercised against a fake only; no notice to admins when a provider's revoke keeps failing.

### The vault for signing keys and session tokens, first half (Sprint 41, B-9201 to B-9205)

- A platform scope in the vault (B-9201): rows of `vault_transit_keys`, `vault_transit_versions` and `vault_policies`
  with `platform` in `tenant_id`, policy paths that start with `sys/`, sealed under the platform data key. Its
  subject is a `service` (an internal caller, `VaultService.serviceCaller`), its grants name services, and its audit
  entries go to the default tenant's chain with `scope: sys`. No route builds a platform caller from a tenant's
  principal; a tenant's grant may name neither a `sys/` path nor a service. Holders of `platform:manage` manage it
  at `/api/admin/platform/vault/*` (keys, rotate, retire, policies, explain).
- Named HMAC keys replace the `SESSION_SECRET` derivations (B-9205): `session`, `api-key`, `mfa`, `app-password`,
  `pds`, `link`, `feed`, `federation`, `channel` and `identifier` (`vault/keyring.ts`, `s.sysKeys`). Version 1 of each
  is the `SESSION_SECRET` in use when the server first opens the scope, so every session, API key, app password,
  recovery code, link and feed URL issued before stays valid. A rotation adds a version; new digests and signatures
  use it, and the versions from the key's minimum up are accepted until an admin retires them. This is the rotation
  path defect F21 lacked.
- Transit keys of type `hmac-sha256` (B-9205), also for tenants: `sign` and `verify` in the `exai:v<n>:` form;
  a signature verifies under the version it names until the minimum decryption version passes it.
- Start order with named steps (B-9202): configuration, database, KMS, data keys, the vault's platform scope,
  sessions and API keys, then the authentication middleware (`ops/boot.ts`). A step that fails stops the process
  with `exprsn-ai failed to start: at step <name> (n of 7): ...`. While the scope is closed after a failed start,
  `authenticate` answers `503` to every request.
- The hot path (B-9203): the keys are held in each process and reloaded on the bus topic `vault.sys` and every
  `VAULT_SYS_REFRESH_SECONDS` (60). A session check is still one indexed lookup. Uses are audited as one
  `vault.sys.used` entry per service and minute, not one per read.
- The generic lease table (B-9204): `vault_leases` and `s.leases` (`vault/generic-leases.ts`), with the renew period
  as the idle timeout, an absolute maximum, revoke, a sweeper (`vault.leases.generic-sweep`), a per-kind handler
  that undoes the credential, an optional verifier for one indexed lookup, and a cache of `VAULT_LEASE_CACHE_MS`
  (1000) dropped on every instance over the bus topic `vault.lease`. Nothing issues such leases yet (B-9301 and
  B-9206 will); the database engines keep `vault_db_leases`.
- Migration `060_vault_system_scope` (the `vault_leases` table; no existing row changes).

### Agent rule sets on agent runs

- Rule sets of scope `agent` now apply to the runs of their agent. The tool-call and tool-result checks of a run
  name the agent (`ToolCallContext.agent`, `meta.agent`), which no check did before, so such a set never matched.
- A run's task and its answer are checked against the agent's own rule sets (`meta.agentOnly`, checkpoints
  `user-input` and `model-output`, source kind `agent-run`; `AgentService.ownRules`). Platform, tenant and workspace
  sets are not asked again there, and an agent without such rules is not checked and nothing is recorded. A `block`
  or a hold ends the run as failed with "Held by guardrails"; a redaction of the task is what the model reads, and a
  redaction of the answer is what is stored and what DLP then inspects; a flag goes to the review queue.
- Several classifier rules on one checked text ask the classifier once (`GuardrailEngine.scoreOnce`): a rule per
  label of one classifier used to be a model call per rule.

### Review queues per agent

- A moderation review queue may list `agents` (names or registry entry ids): it takes the flags raised in those
  agents' runs (source kind `agent-run`, the agent read from the run) and no others. Queues without `agents` route
  as before (`moderation/service.ts` `route` and `agentOf`; migration `058_moderation_queue_agents`). The queue
  dialog on the Moderation screen has an Agents field, and the queue list shows a queue's agents.

### Evidence retention and legal hold (Sprint 41, B-9501 to B-9504)

- Takedown as its own state (B-9501): a file a moderation decision took down has `taken_down_at`. It is served to
  nobody and out of the folder tree as before, but it is not in the trash its members see, and they can neither
  restore it (`409`, audited `file.restore.refused`) nor empty it from the trash (left in place, audited
  `file.purge.refused`). Only the decision, reversed or appealed, lifts it. A file that was in a member's trash when
  it was taken down is in their trash again afterwards.
- Evidence retention (B-9502): what a moderation action hid or took down is kept while its case is open (the flag
  undecided, an appeal waiting, or the last decision younger than `MODERATION_EVIDENCE_DAYS`, default 30), whatever
  its own retention. The file purge, the file retention and version cap, conversation retention and channel
  retention leave it, and record that once per object, path and case (`retention_skips`, audited
  `retention.skipped`). Deleting a kept conversation, direct message, knowledge document or record answers `409`
  (audited `retention.delete.refused`).
- File retention and a version cap per workspace (B-9503): `PUT /api/admin/tenants/:tid/workspaces/:wid/file-retention`
  sets the days after which an unchanged file goes to the trash and the number of versions kept of each file; the
  `files.purge` job applies both before it purges, leaving files under a hold alone. `GET /api/files/usage` carries
  `retention`. The Storage screen has "Set retention".
- Legal hold on a case or an object (B-9504): `POST /api/compliance/holds` takes the scopes `case` (the flag, by id
  or reference) and `object` (`objectType`, `objectId`), under the same dual control. What such a hold keeps
  survives every purge above and the purges of held writes and held form values. Its content is exported with a
  second approver: `POST /api/compliance/holds/:id/exports`, `POST /api/compliance/evidence-exports/:id/decide` and
  `/withdraw`, `GET …/download` (sealed JSON Lines, the job `compliance.evidence-export`). A tenant with an active
  legal hold cannot be offboarded.
- Migration `059_evidence_holds`; `server/src/compliance/evidence.ts` (`s.evidence`); setting
  `MODERATION_EVIDENCE_DAYS`; `server/test/sprint41-evidence.test.ts`.

### Held messages, group posts, comments and edits (Sprint 41, B-9401 to B-9404)

- A direct or group message, an edit of one, a group post, a feed comment and an edit of a feed post that the
  `user-input` guardrail holds are no longer refused with `422`: they answer `202` and wait, stored sealed and read
  by their sender only (`moderation/held.ts`, `s.held`; migration `057_held_writes`). A hold flag (source kind
  `held-write`) is filed in the review queue. A reviewer other than the sender accepts it, which delivers it once with
  its original time and notifies as a new write would, or rejects it, which tells the sender. `block` verdicts still
  refuse.
- Guard-model outage (B-9403): when every rule that held a write is a model-backed rule that could not run, the write
  is held with no flag and the job `moderation.held.rescreen` screens it again every `HELD_RESCREEN_SECONDS`. A fresh
  verdict delivers it, refuses it or sends it to a reviewer; nothing is released without one, and after
  `HELD_OUTAGE_EXPIRE_HOURS` it is refused. New feed posts are held this way too.
- Bounds: `HELD_MAX_PER_AUTHOR` (20) and `HELD_OUTAGE_MAX_PER_TENANT` (500); past either the write is refused as
  before. Reviewers are told once an hour that writes wait on a check, and the Moderation screen shows the count with
  "Check again now".
- Routes: `GET /api/moderation/held`, `/held/summary`, `/held/:id`, `POST /api/moderation/held/:id/decide`,
  `POST /api/moderation/held/rescreen`, `GET /api/me/held`, `POST /api/me/held/:id/withdraw`. Deleting a held message,
  group post or comment withdraws it and closes its flag (new flag event `flag.withdrawn`); deleting a held feed post
  now closes its flag as well.
- Console: Messages and feed and Groups show the sender what is held or rejected, with Withdraw or Remove, and a
  held edit beside the text everyone reads; Moderation shows a held item with the conversation before it and accepts
  or rejects it. `e2e/tests/held-messages.spec.ts`.
- `dm_messages.released_at` counts a delivered held message as unread for members who had read past its time. The
  built-in tool `messages.send` returns `state`. Settings `HELD_MAX_PER_AUTHOR`, `HELD_OUTAGE_MAX_PER_TENANT`,
  `HELD_RESCREEN_SECONDS`, `HELD_OUTAGE_EXPIRE_HOURS`, `HELD_KEEP_DAYS`. `server/test/sprint41-held-messages.test.ts`.

### Guardrail rules drafted from a description (Sprint 41, B-9601, B-9602)

- `POST /api/admin/guardrails/sets/:id/describe` (`guardrails:manage` and `inference:invoke`) has a published profile
  draft one rule from a description, on the low-code draft assistant's model call (`apps/ai.ts`): the description
  passes the `user-input` checkpoint, the call is metered and audited (`guardrails.rule.drafted`), and the answer is
  validated with the rule schema and returned with its diff against the rule set. Nothing in the set changes.
- The model's answer is untrusted: only the name, checkpoint, mechanism, action, severity and description are read
  from it. The id (one no rule of the set or the platform baseline has), `stage: shadow`, `onError: closed` and
  `enabled` are set by the server, and the mechanism is one of `pattern`, `pii`, `secrets`, `budget` and
  `allow-list`, which name no profile and no classifier. A draft adds one rule and changes or removes none.
- `POST /api/admin/guardrails/sets/:id/describe/:draftId/save` adds the drafted rule to the set's draft exactly as it
  was drafted (from `guard_rule_drafts`, not from the request), in shadow.
- A version in which a rule drafted this way enforces is not published directly: `POST …/draft/publish` answers 403
  `dual-control` (audited as `guardrails.publish.refused`) until another guardrail admin approved such a version
  through the existing review (`…/draft/submit`, `…/draft/approve`). The set's view lists these rules in `described`.
- The Guardrails screen has "Describe a rule": the draft with its diff, "Save in shadow", the mark on the rule, and a
  Publish button that gives way to "Request review" while a described rule would enforce. Replay and promotion are the
  existing controls.
- Migration `056_guardrail_rule_drafts`. `server/src/guardrails/drafts.ts`, `server/test/sprint41-rule-builder.test.ts`,
  `e2e/tests/guardrails.spec.ts`. Draft quality depends on the profile's model; the tests use a fake model.

### Workflows calling listed public hosts (Sprint 41, B-9101, B-9102)

- Workflow HTTP steps reach public hosts on the tenant's list of allowed hosts (decision D15), the list HTTP tools and
  webhooks read (`PUT /api/admin/integrations/hosts`), still through the address guard: the name is resolved once,
  every address checked, the connection pinned, and redirects not followed. An internal host is governed as before
  (`WORKFLOW_HTTP_HOSTS`, narrowed by the tenant's list when it has entries); a public host needs the tenant's list
  to name it or a network holding every address, and no entry in `WORKFLOW_HTTP_HOSTS`. Cloud metadata, link-local
  and unspecified addresses, and a name that answers with both internal and public addresses, are refused whatever
  the lists say. The list is read for each call, so a host taken off it fails the next step that calls it, with the
  host named.
- `PATCH` and `DELETE` join `GET`, `POST` and `PUT`. Every method but `GET` is a write for the retry warning ("writes
  to another system; a retry may send it again"); a workflow published as a tool is `destructive` when it has a
  `DELETE` step.
- Every header, query parameter and body field of an HTTP step whose name says it carries a credential takes a vault
  reference (VLT-9), as `Authorization` did: a header `vault:path#key` (optionally after Bearer, Basic or Token), a
  query parameter under the step's new `query` map as `vault:path#key`, a body field as `{vault:path#key}`. A literal
  there, a credential in the URL's own query string, or a value shaped like a private key, a cloud access key, a
  provider token or a JWT, is refused with `400` when a workflow is created, saved, published or imported from a
  bundle, and listed by the editor's validation. References are checked for the saver at save and resolved at each
  run as the run's principal; a reference in a body is taken from the template before it is rendered, so text from a
  run's input is never read as one. Bundles name and rebind the references of query parameters and bodies too.
- A version stored before the rule still loads and runs; saving or publishing it again is refused until the literal
  is replaced.
- `workflows/http.ts`, `workflows/http-secrets.ts`, `platform/secret-names.ts` (shared with HTTP tools),
  `isPublicAddress` in `platform/egress.ts`; `server/test/sprint41-workflow-http.test.ts`. No migration, no setting.

### Redis for multi-process installs (Sprint 41, B-9001, B-9002)

- A server process refuses to start without `REDIS_URL` when it is one of several on its database (decision D17), and
  its exit message names what it found: `WORKERS_ENABLED=false` (another process runs its jobs), `SERVER_REPLICAS`
  above 1 (new setting; the Helm chart sets it from the replica count or the autoscaler's maximum), or another
  instance's live heartbeat in `platform_instances`. A row left by a killed process of the same host is not counted
  and is removed, so a single process restarts at once after a crash. The CLI and scripts that use the services write
  no heartbeat and are not refused. `server/src/ops/redis-required.ts`, checked in `server/src/index.ts`.
- `/readyz` has a `redis` check when Redis is configured (`Bus.health`: the subscriber connection up and a PING
  answered within two seconds). A replica cut off from Redis answers 503 with `checks.redis: "unavailable"` and its
  heartbeat records `not ready`; it turns ready again when Redis answers. Without `REDIS_URL` the answer is as before.
- `subscribeLabels` and `subscribeRepos` read the database behind the bus: every `ATPROTO_STREAM_POLL_SECONDS` (new,
  default 5) an instance with open streams reads the newest seq and sends its subscribers what they have not had, so
  a label or repo event whose bus message was lost is delivered within one interval, in order and once.
- The Helm chart uses the `Recreate` strategy for one replica without Redis, because a surge pod would be a second
  process and refuse to start. `docs/deploy.md` has a section "Redis and more than one process" for bare metal,
  Compose and the chart.
- `server/test/sprint41-redis-required.test.ts` (with two real server processes on one SQLite database),
  `server/test/integration/redis-required.test.ts` (`TEST_REDIS_URL`: a replica behind a TCP proxy that is cut and
  restored), and a lost-announcement case in `sprint25b-atproto.test.ts` and `sprint31a-pds.test.ts`.

### Model thinking templates (Sprint 36b, B-11707)

- A catalogue model records how it is made to think: `native` (the model server's think option), `template` (an
  instruction joins the system prompt and the model reasons between two tags, which the gateway moves from the answer
  to the thinking) or `none`. `PATCH /api/admin/models/:id` takes `thinking: { mode, template }`; a template is a
  built-in by id (`magistral`, `magistral-think-tokens`, `think-tags`, listed by
  `GET /api/admin/models/thinking-templates`) or a custom instruction with its opening and closing tag. A model with
  nothing recorded thinks natively when its manifest says so, as before. Migration `054_model_thinking_templates`.
- Every caller of a lease gets the same client (`gateway/thinking.ts`, `withThinking`), so chat, `/v1`, agents,
  workflows and channels receive a template model's reasoning as `thinking`, as they do native thinking: the stream
  guards, the full output check, the sealed `thinking` column and the thinking panel treat both alike, and the tags
  never reach the answer or the stored content. The instruction is sent only when a request asks for thinking.
- Profiles inherit it: a profile created without thinking levels on a model whose entry records native or template
  thinking starts at `medium` up to `high`; `off` still switches it off. No convention is written in the system prompt.
- The conformance run's tool-calling test (and the model-server probe's) sends a system prompt, as chat does, so a
  model that calls no tool without one (Magistral) passes. A template model gets a third test, "Thinking template":
  its reasoning must arrive apart from the answer and neither tag may be left in the answer. The smoke test still
  decides the state.
- Console: Models shows a model's thinking with a Change dialog (the built-in templates or a custom one); Profiles
  shows what the profile inherits under Thinking default. `server/test/thinking-templates.test.ts`.

### Agents, tools and skills in chat (B-40)

- `GET /api/conversations/:id/capabilities` (B-4001) lists the published tools, agents, skills and workflows the
  caller may call in a conversation: published to the workspace, within the entry's ceiling for the conversation's
  label, on the profile's allow-list when it has one (`chatCapabilities` on a profile), with each tool's input schema
  and side-effect class. What is not listed is refused by name as not found.
- `/tool` (B-4002, B-4003): `POST /api/conversations/:id/tools` calls a tool through the dispatcher and the
  `tool-call` guardrail, with arguments from a form or text the profile's model turns into arguments. Write,
  destructive and `confirm: always` tools wait on an approval card for the caller's own approval; a call the
  guardrail holds waits for a reviewer other than the caller in the Flags queue; denied, rejected, expired and
  blocked cards are recorded and run nothing. The call and its result join the conversation as a turn the model reads
  from the next answer on.
- `@agent` (B-4004): `POST /api/conversations/:id/agents` starts an agent run bound to the conversation (optionally
  with the recent turns within the agent's ceiling); its answer becomes an assistant turn; the run shows in Runs with
  `conversation`, is metered to the conversation, and is cancelled or has its held calls decided from the conversation.
- `+skill` (B-4005): `PUT` and `DELETE /api/conversations/:id/skills/:name` add a skill's instructions to the system
  prompt of later turns (`sticky`, or `once`); a removed skill is out of the very next turn.
- `/workflow` (B-4009): `POST /api/conversations/:id/workflows` starts a published workflow; its approvals, and any
  call held in the run's chain, are decided with `POST …/invocations/:iid/held`.
- Migration `051_chat_capabilities`; job `chat.tool`; socket events `chat.invocation` and `chat.skills`; settings
  `CHAT_CARD_EXPIRY_MINUTES` and `CHAT_HELD_CALL_EXPIRY_HOURS`. `server/src/chat/capabilities.ts`,
  `server/src/routes/chat-capabilities.ts`, `server/test/chat-capabilities.test.ts`. B-4006 (the model handing a
  turn to an agent) is not part of this.

### Imported classifier engines (B-3806, second half)

- A text-classification model of a hub is imported through the model import and served by a classifier worker
  (`CLASSIFIER_WORKER_URL`; contract in `docs/classifier-worker.md`), because Ollama serves no sequence-classification
  heads. The plan takes safetensors weights with the configuration and tokenizer files from the repository's root, no
  conversion and no pool (`serving: classifier`); pickle stays refused; without a worker the model is refused as
  before. The job reads the labels from `config.json`, has the worker check every file's hash, recompute the model
  digest and load the model, and registers a draft model pinned by that digest (`format: safetensors`, capability
  `classification`). Its evaluation is the worker's digest check and a smoke test; approval is dual control as for
  any model.
- The classifier engine `imported`: a classifier names the model and takes its labels (all, or some). It is measured
  on its eval set while a draft (an eval set imported into it shows precision and recall per label from the model's
  own scores) and publishes only once the model is approved. Text is scored only within the model's label and
  `CLASSIFIER_WORKER_LABEL_CEILING`. A worker that lost a model is sent the verified files again.
- `GET /api/admin/classifier-models`; `engine: imported` and `model` on `POST /api/admin/classifiers`; `classifier:
  {name, create}` on a model import, which makes the draft classifier for a requester holding `classifiers:manage`.
  The Import screen's destination step and the New classifier form on Classifiers offer both.
- Settings `CLASSIFIER_WORKER_URL`, `CLASSIFIER_WORKER_TOKEN`, `CLASSIFIER_WORKER_TIMEOUT_MS`,
  `CLASSIFIER_WORKER_LABEL_CEILING`, `CLASSIFIER_WORKER_CA_FILE`. No migration, no new permission, no new dependency.
  `server/src/guardrails/classifier-worker.ts`, `server/src/imports/classifier-models.ts`;
  `server/test/sprint40-classifier-engine.test.ts` with `fake-classifier-worker.ts`; a real tiny BERT classifier in
  `server/test/fixtures/classifier/` for `server/test/integration/classifier-worker.test.ts`
  (`TEST_CLASSIFIER_WORKER_URL`).
- Not built: label mapping (a model's labels are used as published), token-classification and zero-shot models,
  batching and metering of worker calls, removing a retired model's files from the worker.

### Import adapters against the real public repositories

- Ollama registry: `registry.ollama.ai` has no `/v2/`, catalogue or tag listing (404), so the adapter reads the tags
  the repository names (`models` entries as `library/gemma3:4b`, or the `tags` option), falls back to `latest`, and
  checks the registry by a named model's manifest.
- DCAT-AP: named graphs (one per dataset, data.europa.eu) are read; a hydra `next` address on another path of the
  host keeps the page's path; machine-translated titles do not win over the original; a dataset identifier over
  `http://` on the catalogue's `https://` host is read over `https://`; an address that lists no dataset fails the
  check and the harvest, where it used to harvest nothing and say "reachable".
- SDMX: the harvest asks for dataflow stubs (Eurostat's full list was over the 32 MB limit), a structure query the
  provider answers 400, 406 or 415 is asked again with any type (the ECB), and the data request finds the provider's
  CSV parameter (`format=SDMX-CSV`, `format=csvdata`) when `dataQuery` is not set. A row's id is the provider's
  `KEY` and the period where it sends one.
- InvenioRDM: pages of 25 without a token and 100 with one (Zenodo answers 400 to an anonymous page of 100); option
  `pageSize`.
- `scripts/import-repositories.json` (workspace): tags for the Ollama models, three CKAN portals that answer in place
  of `catalog.data.gov` (no longer CKAN), the Joint Research Centre's listing on data.europa.eu, Eurostat with its
  CSV parameter, the ECB, Zenodo's datasets. The setup script keeps an entry's options on the repository and removes
  an address the list retires.
- `server/test/integration/imports-live.test.ts` runs the adapters against the real services with
  `TEST_IMPORT_LIVE=1` (or a list: `ollama,ckan,sdmx,ecb,zenodo,dcat`); the same shapes are in
  `server/test/sprint30-imports.test.ts` against the fakes.

### Model repositories: Models.dev catalogue and a knowledge base

- New import repository type **`modelsdev`** (`server/src/imports/adapters/modelsdev.ts`, `REPO_TYPE_INFO` in
  `imports/types.ts`): the Models.dev catalogue (`models.dev/api.json`). It harvests every provider's models with
  their capabilities (reasoning, tool calling, structured output, attachments), modalities, context and output
  limits, cost and open-weights flag, filed with facets for access, library, family and capability. It serves no
  weights, so it is browse-and-compare only (`modelImport: false`, like InvenioRDM's model kind). Added to the
  seeded Repositories list in `scripts/import-repositories.json`; the type surfaces automatically through
  `GET /api/imports/repo-types`. No migration (repository types are code).
- New knowledge base **"Model repositories"** (`scripts/exprsn-model-repos-knowledge.mjs` from authored pages in
  `scripts/model-repository-knowledge/`, run by `bin/exprsn-setup`): an overview plus a page each for Hugging Face,
  the Ollama registry, Models.dev, ModelScope, Kaggle Models, Replicate, NVIDIA NGC, the ONNX Model Zoo, the
  TensorFlow/PyTorch hubs, and OpenML/Zenodo — what each holds, how Exprsn-AI imports from or browses it, and how
  they differ.

### Network diagnostic tools

- Three read-only built-in tools (migration `053_net_diagnostics`, `server/src/registry/builtin/net-diagnostics.ts`
  over `server/src/platform/netdiag.ts`), published to every tenant like the other built-ins and callable from chat,
  agent runs and workflow steps by anyone with `tools:invoke`:
  - `dns.lookup` resolves every DNS record type for a domain at once (A, AAAA, CNAME, MX, NS, SOA, TXT, SRV, CAA,
    NAPTR), or the reverse PTR names for an address, over the system resolver (or resolvers given in `servers`). The
    query reaches the resolver, not the host, so it reads nothing of the tenant's and reaches no arbitrary host.
  - `whois.lookup` makes a WHOIS query over TCP port 43, following the referral from IANA to the registry and then
    one registrar (each WHOIS server checked to resolve to a public address before the connection opens), and pulls
    out the common fields (registrar, created, expires, updated, name servers, status; for an address the network,
    organisation and country) beside the reply text.
  - `net.scan` is an nmap-style TCP connect scan of one host: open, closed or filtered per port, the well-known
    service name, the response time and, with `banner`, a short greeting. It reaches the target, so it goes through
    the same outbound-address guard as the HTTP tools (`toolAddressProblem`): the host is resolved and every address
    checked against the operator's policy and the tenant's list of allowed hosts, so a public host must be on the
    list (Registry, Allowed hosts) and an internal one named by the operator; a host that is not allowed is refused,
    not scanned. Ports are a list or a string such as `22,80,443,8000-8010` (at most 1024; a common set by default).
    Each scan is audited as `net.scan.ran` with the host, address, port count and how many were open.
- A `net-diagnostics` skill groups the three for agents (`scripts/exprsn-net-tools.mjs`, run by `bin/exprsn-setup`).
  `server/test/net-diagnostics.test.ts`.

### Dataset import, knowledge sets, eval sets and the Import screen (B-3804 to B-3807)

- Dataset import (B-3804): `GET /api/imports/repositories/:id/dataset`, `POST /api/imports/datasets/preview`,
  `/plan` and `POST /api/imports/datasets` fetch a dataset's rows through the import fetcher (a hub's dataset viewer,
  CKAN datastore and Socrata paging, SDMX-CSV, CSV, TSV, JSON, JSON Lines and ARFF files), preview the schema with PII
  flags, import a sample above the quota, and register a `training_datasets` version through the inline version's own
  scrub, hash and report (`source_kind: import`). An air-gapped instance refuses dataset import.
- More dataset sources and formats (B-3804): repository types `estat` (e-Stat API 3.0) and `ogd` (the OGD platform's
  API), each with a catalogue adapter and a paged fetch step, their key sent in the query string to the repository's
  own host only; Kaggle datasets by file or as the whole archive; a gated hub dataset read from the hub's own Parquet
  files with the recorded token; zip archives, xlsx workbooks, Parquet (the new dependency `hyparquet` 1.31.1, MIT, no
  dependencies of its own) and XML as resources, read whole within `IMPORT_ARCHIVE_MAX_BYTES` and
  `IMPORT_ARCHIVE_MAX_UNPACKED_BYTES`. `server/src/imports/zip.ts`, `xlsx.ts`, `parquet.ts`, `containers.ts`,
  `adapters/dataset-sources.ts`; `server/test/sprint40-dataset-sources.test.ts`.
- Knowledge sets (B-3805): `knowledge_sources.kind = dataset` with title, text and metadata columns, grouping by a
  column, refresh schedules (also following the publisher's frequency) as imports on the queue, and row ids in every
  document. A refresh builds the next index version beside the serving one and swaps it in (migration
  `052_knowledge_index_versions`: `knowledge_indexes.source_id`, `knowledge_documents.staged_index_id` and
  `staged_key`): new and changed rows are staged and embedded, the rest of the base is copied across with its vectors
  (`VectorStore.copy`), and one transaction moves serving to the new version. Search answers from the old rows until
  then; a failed or cancelled refresh discards the partial version and leaves the last good one serving. The first
  load fills the serving index directly. `server/test/sprint40-knowledge-refresh.test.ts`.
- Classifier eval sets (B-3806): rows into an eval set with per-label counts and minimum-sample warnings, then a
  training or evaluation job. Imported classifier engines are not built: there is no classifier worker.
- The Import screen (B-3807, `#/import`): the wizard, the Imports queue with cancel, retry, logs and licence
  decisions, the Repositories tab, and entry points on Models, Training, Classifiers and Knowledge.
- Migration `050_dataset_import`; jobs `imports.dataset` and `imports.refresh-due`; settings
  `IMPORT_DATASET_MAX_ROWS`, `IMPORT_PREVIEW_ROWS`, `IMPORT_KNOWLEDGE_MAX_DOCS` and `IMPORT_REFRESH_TICK_MINUTES`.
  `server/src/imports/datasets.ts`, `tabular.ts`, `adapters/dataset-rows.ts`, `server/test/sprint40-dataset-import.test.ts`,
  `web/js/screens/import.js`, `e2e/tests/import.spec.ts`.

### Tenant-wide scripts in every workspace

- The Scripts screen and `GET /api/scripts` list the scripts of the caller's workspace and the tenant-wide ones
  (no workspace: what setup scripts and tenant admins create outside any workspace), and a tenant-wide script can be
  opened and run from inside a workspace; before, a workspace saw only its own, so scripts made by setup were missing
  from the screen. A list item carries `workspaceId` (null: tenant-wide). One workspace still does not see
  another's scripts. `server/src/scripts/service.ts`, `server/test/scripts-tenant-wide.test.ts`.

### The allowed hosts list as tools

- Four built-in tools (migration `049_allowed_host_tools`, `server/src/registry/builtin/allowed-hosts.ts`):
  `allowed_hosts.check` (read: whether the request tools may reach a host, why not, and the entry that would allow it),
  `allowed_hosts.list` (read) and `allowed_hosts.add` and `allowed_hosts.remove` (write, with a reason), the last
  three for holders of `tenant:manage`. They change the same list as Registry, Allowed hosts and write the same audit
  event, `tenant.hosts.updated`, with what was added or removed and the reason. `add` normalises what it is given (a
  URL to its host, an IDN to ASCII) and refuses internal names and addresses, names that resolve to internal
  addresses, wildcards over a public suffix or a shared hosting domain and very large networks; the first entry of an
  empty list is reported with the active webhooks it now refuses. `server/test/allowed-hosts-tools.test.ts`.

### Requests to the outside, and script tools on files

- Seven built-in tools (migration `048_net_and_file_tools`, `server/src/registry/builtin/net-files.ts`).
  `http_fetch` (read), `http_request` (write) and `http_download` (write, into Files) make one HTTP request the way
  curl or wget would, through the outbound address guard and the tenant's list of allowed hosts, like an `impl: http`
  tool; every hop of a redirect is checked again, credentials do not follow a redirect to another host, and the
  tools' ceiling is internal. A request may be given as a curl or wget command line (`registry/builtin/curl.ts`),
  which is read and never run: shell variables, substitutions, pipes and redirections are refused, and so are options
  that need a disk, a proxy or an unchecked certificate.
- `files.run_tool` (read) runs one of the tenant's script tools on files in Files with their content put into the
  tool's arguments by the server; `files.apply_tool` (write) saves the tool's product as a new version or a new file;
  `files.save` (write) creates a file; `files.extract` (write) unpacks an archive into a folder through the tenant's
  `archive_tool`. A script tool's ceiling must cover the label of what it is handed.
- `GuardedResponse` (`platform/egress.ts`) carries the response headers. `server/test/net-file-tools.test.ts`.

### The built-in tool files.read

- `files.read` returns the text of a file in Files by its id (migration `047_files_read`), read as the caller and
  within the label of the call, in parts for a long file (`from`, `maxChars`, `next`). The server reads text, Markdown,
  CSV, JSON, HTML, PDF and Word files itself. Excel, PowerPoint, OpenDocument and RTF files, and Word files with their
  structure, are handed to the script tool `document_process` where the tenant has published it and its ceiling covers
  the version's label; the answer then carries the document's outline, metadata and counts. Images are refused with a
  pointer to `knowledge_add`. A read is audited as `file.downloaded` with `tool: files.read`.
  `server/src/registry/builtin/` (`catalog.ts`, `index.ts`), `server/test/files-read.test.ts`.

### Knowledge references, revisions and review

- A knowledge base can keep documents under version control. A reference has a stable slug, a version
  (`major.minor.patch`) and a history; each change is a revision (draft, in review, approved, published, superseded,
  rejected, withdrawn, failed) that keeps its text sealed, what it changes, the feature it documents, its author and
  its approver. Migration `045_knowledge_revisions` (`knowledge_references`, `knowledge_revisions`,
  `knowledge_reviewers`; `review`, `review_workflow_id`, `review_four_eyes` on `knowledge_bases`).
  `server/src/knowledge/revisions.ts` (`s.knowledgeRevisions`), `server/src/routes/knowledge-revisions.ts`.
- Editors and approvers per base, as users or roles; four eyes by default; `review: required` refuses uploads that go
  around review. An approved revision is indexed like an upload, and the version before it leaves the index only once
  the new one is indexed.
- A base can name a review workflow: a submitted revision starts a run of it as its caller
  (`caller_kind: knowledge-revision`). The built-in tool `knowledge_publish` is the workflow's last step and publishes
  only when the run's approval step was approved by an approver of the base, so the same workflow serves Knowledge,
  other workflows (as a sub-workflow) and, published as a tool, skills and agents. Built-ins `knowledge_propose` and
  `knowledge_revisions`.
- Console: Knowledge, References (`web/js/screens/knowledge-references.js`). Tests:
  `server/test/knowledge-revisions.test.ts`.

### Crawled sites: images and differentials

- A web source can index the pictures of its pages (`media`, `maxMedia`): PNG, JPEG, WebP and GIF of 8 KB or more
  become image documents that the base's vision profile captions and reads, from the site itself or from another
  host `KNOWLEDGE_ALLOWED_HOSTS` names, each host's robots.txt deciding. `server/src/knowledge/crawl.ts`
  (`pageImages`, `CrawlMedia`).
- A web source can record what each sync after the first found new, changed and gone (`changes`), with the line diff
  of the indexed text, sealed. Migration `044_knowledge_changes` (`knowledge_doc_changes`),
  `server/src/knowledge/diff.ts`, `GET /api/knowledge/bases/:id/changes`, `GET /api/knowledge/changes/:id`, and the
  built-in tool `knowledge_changes`.
- Console: the Knowledge screen's add-source form has both options, and a web source's drawer lists what its syncs
  found with each diff. The source type reads "Web site". `server/test/knowledge-crawl-changes.test.ts`.
- A crawl keeps a site's `Crawl-delay` up to 30 seconds between requests (it stopped at five).
- A sync sets aside a document that no pool may embed at its label (the classifier raised a public page, for
  example): the document is `rejected` with the reason, the rest of the source is indexed, and the job's result
  carries `setAside`. Before, one such document failed the whole source at every sync.

### Job queue: lost queue entries (BullMQ mode)

- Every 30 seconds the queue gives each queued, due job its BullMQ entry again (`JobQueue.redispatch`), so the worker
  runs it within its own concurrency: jobs queued by a process without a queue connection (setup scripts, the CLI),
  jobs the worker passed over while their type was paused, and jobs whose entry a Redis restart lost. Before, the
  fallback poll ran such jobs itself and waited for the whole batch, so one long job held the others back.
  `server/test/jobs-redispatch.test.ts`.
- `JOB_TYPE_LIMITS` (`knowledge.sync=2` by default): the most jobs of one type an instance runs at once. A type at
  its limit is passed over when jobs are claimed and its next job starts as soon as one ends, so long syncs no longer
  hold every worker slot while scans, schedules and script runs wait.

### Knowledge categories and the tools that file under them

- Documents in a knowledge base are filed under categories: paths such as `finance/reports/quarterly`, at most 6
  levels and 12 per document, stored in one spelling (lower case, hyphens for spaces). A filter on a category also
  finds what is filed under its subcategories; an image taken out of a PDF or Word document is filed where that
  document is. Migration `043_knowledge_categories` (`knowledge_doc_categories`), `server/src/knowledge/categories.ts`.
- Built-in tools: `knowledge_add` (text, or a document or image from Files by `fileId`, filed under at least one
  category), `knowledge_categorize` (add, set or remove a document's categories), `knowledge_categories` (the
  categories in use with their document counts) and `files.search` (files by name and tags, for their ids).
  `knowledge_search` takes `categories` and `categoriesAll` and its hits carry their document's categories;
  `knowledge_list` takes `categories` and lists them; `knowledge_save` takes `categories`.
- API: `categories` on the upload route, `categories` and `categoriesAll` on the document list, `categories` on the
  test search, `GET /api/knowledge/bases/:id/categories`, `GET /api/knowledge/categories` and
  `PUT /api/knowledge/documents/:id/categories` (audited `knowledge.document.categorised`).
- Console: the Knowledge screen shows a document's categories under its name, filters the Documents tab by category
  and edits them from the document's drawer. `server/test/knowledge-categories.test.ts`.
- A knowledge base may name a draft vision classifier (before, only a published one): its labels are `provisional`
  until it is published, as a guardrail rule may already use a draft. A new version of a draft re-labels the images
  like a published one's.
- A label a vision classifier gives an image files it under `images/<classifier>/<label>` (the classifier slug without
  a leading `image-`: `images/kind/screenshot`), so category filters find images by what they show. These categories
  follow the labels: they change when the image is re-labelled and go when the base stops naming the classifier; the
  categories given to a document are kept apart (`origin` on `knowledge_doc_categories`, migration
  `046_classifier_categories`). `GET /api/knowledge/documents/:id` and the document list carry `filedByClassifier`.

### Chat lists loaded profiles only

- The Chat screen's profile picker, its regenerate dialog and its default pick offer only profiles whose model is
  loaded on an instance (`residency: loaded`); a cold profile no longer appears. With none loaded the composer is
  disabled and the empty state says so. `GET /api/chat/profiles` is unchanged (Compare, Messages, Channels, Workflows
  and `/v1/models` still list cold profiles). `web/js/screens/chat.js`; the end-to-end seed starts its two chat models
  loaded.

### Tenant workflows in every workspace

- `GET /api/workflows` and every route that opens a workflow by id or name show the current workspace's workflows
  and the tenant's own (`workspaceId: null`), within the caller's clearance; before, a session in a workspace saw only
  that workspace's, so workflows made without one (by a setup script, a plugin or an API key) never reached the
  console. Dead letters follow. A tenant's own workflow saved or published from a workspace is checked where it
  lives (`WorkflowService.at`): the workspace's ceiling does not apply to its label. The step palette, `sub` steps
  and agent callees stay those of the current workspace. `server/test/workflows.test.ts`.

### Chat tool rounds and built-in refusals

- Chat: the last of the six tool rounds offers no tools, so a model that keeps calling tools answers with what it has
  instead of leaving the answer empty; a system message on that round says that no more calls can be made.
- Built-in tools: a call refused because its arguments did not validate names the argument and the reason
  (`Invalid request: The request did not validate. metrics.0: …`), so a model can correct the call. A record
  tool's malformed `filter` or `sort` is refused with the shape it takes.

### Channels that run their agent's tools

- A chat channel bound to an agent may run the agent's read tools, skills and workflow tools in its answers
  (`agentTools`, with `runAs`: a member account of the channel's workspace without admin permissions). Read tools
  only; at most 8 model calls and 10 tool calls per answer; the answer is queued and read on the customer's next
  poll (`pending: true`). No migration: both settings live in the channel's `settings`. `generateAgentReply` in
  `channels/generate.ts`, `ChannelService.runAsPrincipal`; `server/test/channel-agent-tools.test.ts`. The console's
  Channels screen does not show the two settings yet (API only).

### Profile fallback in agent runs and workflow steps

- A profile's `fallback` (`{profileId, afterQueueWaitMs}`) now applies to every model call of an agent run and of a
  workflow model step (also a map or loop prompt and a step with skills). As in chat and `/v1`, when every slot for
  the profile stays busy past the wait, the fallback serves the call, its own fallback in turn (at most three hops,
  never a profile twice). Here it also serves a call that fails on the profile (the model server refuses or drops
  it, the runner fails): these callers collect the whole answer before using it, so the call is made afresh. Chat and
  `/v1` are unchanged (queue wait only). A cancelled call is not tried elsewhere.
- A fallback must pass the same checks as the profile (published, model approved, clearance, the label of the data)
  and, when the call offers tools, have a tools-capable model; otherwise the call waits for, or fails on, the profile.
  It serves one call: the next tries the profile again. An agent step's `meta` carries `profile` and `model` (the
  ones that answered), `fallbackFrom` and, after a failure, `fallbackAfter: [{profile, error}]`; a workflow step's
  `detail` carries `fallback` and `fallbackAfter`. Usage is metered against the profile and model that answered.
  `Gateway.acquireFollowing` and `runFollowing`; `server/test/profile-fallback.test.ts`.

### Research built-in tools

- Migration `042_research_tools`: five platform registry tools beside `knowledge_search`. `knowledge_list` (the
  published bases a caller may read, or the documents of one), `knowledge_read` (a document's indexed sections in
  order, in parts), `memory_search` (the caller's and their workspace's memories nearest to a query),
  `knowledge_save` (a Markdown document into a base the caller may manage, scanned like an upload) and `memory_save`
  (a memory as `POST /api/memory` makes it). Reads are at most at the label of the call; saves are at it and need
  approval. `KnowledgeService.readDocument`; `server/test/research-tools.test.ts`.
- `knowledge_search` without `kbIds` searches every published base the caller may read (the first 20 by name).
- Workflow tool steps and map items: a literal argument (`"k": "5"`) becomes a number, an integer or a boolean
  where the tool's input schema asks for one (`coerceArgs` in `workflows/graph.ts`).

## 1.6.0

### Image provenance and chat artifacts (Sprint 39a, B-7901, B-8001)

- Migration `041_provenance_artifacts`: `image_jobs.c2pa`, `pki_content_signers`, `chat_artifacts`,
  `chat_artifact_versions`.
- Content credentials (B-7901): a generated PNG carries a C2PA manifest store in a `caBX` chunk (`c2pa.actions`,
  `c2pa.hash.data` over every byte outside the chunk, `io.exprsn.generation`), signed as a COSE_Sign1 (ES256) by the
  tenant's content-credentials certificate, which the tenant's issuing CA makes on first use with its key in custody
  and lists among the tenant's certificates (revoke it there and the next image signs with a new one). The manifest
  travels with the bytes through the blob store, downloads and attachments; `GET /api/images/:id/content-credentials`
  and `exprsn-ai c2pa:verify <file.png> [anchor.pem…]` read it back and check the claim hashes, the data hash, the
  signature, the chain and its trust. The HMAC manifest of Sprint 20 stays and still verifies. Without an issuing CA
  or key custody the image keeps the HMAC manifest and says why. Setting `IMAGE_C2PA`. Built from the
  specification's parts (CBOR, JUMBF, COSE) in `server/src/images/c2pa.ts`; the deviations a conformance validator
  may flag are in `docs/security.md`.
- Versioned artifacts (B-8001): the fenced blocks of a finished answer become artifacts of the conversation, named
  from the fence or `<language>-<n>`; a later turn that changes one adds a version and the earlier ones stay
  readable, the same content adds none. `GET /api/conversations/:id/artifacts` and `.../versions/:n` for owners and
  share readers; transcripts of shares and links carry the artifacts of the shown messages. HTML renders in a
  sandboxed iframe on `GET /api/public/artifacts/:vid/raw`, a short-lived capability URL with its own CSP (an opaque
  origin with no access to the console, its cookies or the API). Settings `CHAT_ARTIFACT_MIN_CHARS`,
  `CHAT_ARTIFACT_MAX_BYTES`, `CHAT_ARTIFACT_RAW_TTL_SECONDS`.
- Console: the Images inspector and download dialog show the content credentials beside the HMAC manifest, with a
  details dialog of every check; the Chat inspector (and the shared and public link views) has an Artifacts panel with
  chips under each answer, a version switcher, the sandboxed render and text views. Prototype boards first;
  `e2e/tests/chat.spec.ts` and `images.spec.ts` extended with axe-core.

### AI inventory, analytics and audit export (Sprint 38a, B-7301 to B-7302, B-7401 to B-7403, B-7501)

- Migration `040_inventory_analytics`: `inventory_systems`, `inventory_settings`, `usage_prices`,
  `audit_siem_destinations`.
- The AI system inventory (B-7301): one list of the tenant's models, profiles, agents, workflows, tools, MCP servers
  and datasets, each with an accountable owner, a human-oversight role, data provenance, model lineage (agent →
  profile → model → base weights), known issues (open flags raised in its runs, failed evaluations) and whether the
  entry is complete, on the Models screen's Inventory tab (`models:manage`). With the tenant's "publishing an agent
  needs an owner" switch on, the registry refuses to approve an agent that has no owner. Audited `inventory.updated`
  and `inventory.settings.updated`. `server/src/governance/inventory.ts`.
- The register (B-7302): `GET /api/admin/inventory/register` as CSV or JSON, every system with its lineage and the
  tenant's impact assessment, for ISO/IEC 42001 and EU AI Act deployer records; audited `inventory.exported`.
- The Analytics screen (B-7401, `usage:read`): messages, agent and workflow runs, users, tokens, GPU time and cost
  by workspace, group (through membership), model, profile and user (and tenant for system admins) over a period, a
  per-day chart, totals, every figure a sum over the metering records so a day's totals equal that day's meter.
  `server/src/tenancy/analytics.ts`, `/api/admin/analytics/summary` and `/daily`.
- Prices and chargeback (B-7402): a price per model or per pool (per million input and output tokens and per
  GPU-hour, energy or a set rate for local models, one currency per tenant, `tenant:manage`, audited); a row whose
  records a price does not cover shows no cost rather than a partial one; the chargeback per workspace and month as
  JSON or CSV with a total line that equals the screen's total, audited `analytics.chargeback.exported`.
- OpenTelemetry GenAI attributes (B-7403): `gen_ai.provider.name`, `gen_ai.response.model`,
  `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` on the `gateway chat stream` span, for Ollama and
  Chat Completions servers.
- JSONL audit exports with a chain proof (B-7501): `POST /api/admin/audit/exports/jsonl {from, to}` writes every
  event of the window (rows above the requester's clearance redacted to their hashes) and a checkpoint signed at the
  window's last sequence; `exprsn-ai audit:verify-export <file>` and `verifyAuditExport` verify it offline. The Usage
  and audit export dialog offers it.
- Audit streaming per tenant (B-7501): HTTPS (NDJSON with a sealed bearer token) or syslog-over-TLS (RFC 5424, octet
  counting, optional private CA) destinations proposed by a tenant admin and approved by a second one, tested,
  disabled, with delivery counters, on the Usage and audit screen's Exports tab; the outbound address guard applies;
  audited `audit.siem.*`. New setting `SIEM_TENANT_MAX_DESTINATIONS` (5). `server/src/audit/siem-destinations.ts`.
- Prototype boards first (Models inventory tab, Analytics, Usage and audit); `e2e/tests/analytics.spec.ts` and
  additions to `models.spec.ts` and `usage-audit.spec.ts` with axe-core.

### HTTP tool kind (Sprint 37a, B-8901 to B-8904)

- Migration `039_tools_injection` (with the items below): `registry_http_calls`, the meter of HTTP tool calls.
- Registry tools with `impl: http` (B-8901): a method (GET, POST, PUT, PATCH, DELETE), a URL template whose path and
  query parameters come from the tool's input schema, query and header values, a body (none, the other arguments as
  JSON, or a template), a response mapping (a JSON pointer, capped in size) and a timeout. GET tools are `read`, every
  other method `write` unless the author raises it to `destructive`. Drafts go through the registry's checks (a new
  one, HTTP request), review and publish lifecycle; a draft's request can be edited. Ported from exprsn-platform's
  agent runtime (port decision D11c). `server/src/registry/http-tool.ts`.
- The outbound address guard (B-8902): every call through `platform/egress.ts` (resolved once, every address checked,
  the connection pinned, redirects not followed); cloud metadata addresses always refused, internal hosts only as
  `SERVICE_ALLOWED_HOSTS` names them, public hosts only from the tenant's list of allowed hosts (the list workflow HTTP
  steps and webhooks read). Credentials only as `vault:path#key` references, resolved at call time as the tool's
  author; a literal credential in a header, query parameter or body field is refused when the tool is saved.
- Guardrails, limits and audit (B-8903): arguments pass the `tool-call` guardrail before the request and the result
  the `context` and `untrusted-content` checkpoints after it; the tool's rate limit applies; each call is metered and
  audited `registry.http.called` with host, method, status, size and latency, never a secret. New settings
  `HTTP_TOOL_TIMEOUT_MS` (30 s) and `HTTP_TOOL_MAX_RESPONSE_BYTES` (1 MiB).
- Console (B-8904): the Registry screen's entry form has the kind Tool (HTTP request) with a vault reference picker;
  the inspector shows the request and the last day's calls; the test harness calls a read-only HTTP tool through the
  guard; Allowed hosts keeps the tenant's list. Prototype board first; `e2e/tests/registry-http.spec.ts` with axe-core
  and the reflow checks. The e2e server names 127.0.0.1 in `SERVICE_ALLOWED_HOSTS`.

### Prompt-injection defence for untrusted content (Sprint 37a, B-6901 to B-6903)

- Trust marking (B-6901): knowledge chunks, crawled pages, tool results, MCP results and HTTP tool answers reach the
  model inside `<untrusted-content>` delimiters naming the source, with their words datamarked, in chat, `/v1`, agent
  runs and workflow model steps with skills. Per profile (`profiles.trust_marking`, `trustMarking` on the profiles
  API and the Profiles screen), on by default. Calculate, delegated agents and workflows are not wrapped.
- The `untrusted-content` checkpoint (B-6902), the twelfth, with the `injection` rule mechanism (a heuristic
  classifier, or a guard model answering injection or benign). The platform baseline gains `injection-untrusted`
  (annotate: the text goes on with a warning); migration `039` adds it to an existing baseline as a new published
  version. A blocking rule in a tenant set leaves chunks out and withholds tool results. Detections are counted per
  source (`injection_detections`), audited `guardrail.injection.detected` and shown on the Guardrails screen
  (`GET /api/admin/guardrails/injection`), with Add a blocking rule.
- The injection corpus (B-6903): `server/src/guardrails/injection-corpus.ts`, 57 attacks (direct; indirect in
  documents, pages, tool, MCP and HTTP results) and 30 benign texts. CI (`server/test/sprint37a-injection.test.ts`)
  fails below a 90% detection rate or above a 10% false-positive rate, for the heuristic classifier, the checkpoint
  with the baseline rule and a guard-model rule on the fake guard model; canary cases check that a marked prompt is
  not followed.
- Tests that compared a tool result echoed by the fake model now expect it wrapped (`mcp.test.ts`, `agents.test.ts`).

### Pinned models stay pinned while they serve

- Every chat and embedding request to an Ollama instance now carries its placement's keep-alive: `-1` for a pinned
  model, the instance's keep-alive for a warm one, none for a cold one (Ollama's default). Before, only explicit
  loads set it, and Ollama resets a model's expiry on every request, so the first answer a pinned model gave set its
  expiry back to Ollama's default (five minutes) and the pin was lost. The keep-alive per model is refreshed on every
  instance poll.

### The MCP server and MCP authorization (Sprint 37b, B-7101 to B-7103)

- Migration `039b_mcp_server`: `mcp_publications`, `mcp_server_settings`, `mcp_server_holds`, `mcp_oauth`,
  `mcp_oauth_states`; `oidc_codes.resource`, `oidc_refresh_tokens.resource`, `oidc_clients.dynamic`;
  `mcp_tokens.refresh_token`, `source`, `refreshed_at`; the `records.*` built-in tools.
- An MCP server per workspace (B-7101) at `/mcp/<tenant>/<workspace>` over streamable HTTP (protocol 2025-06-18, JSON
  answers): the workspace's published workflows, its agents, one search tool per knowledge base, its registry tools and
  the record tools over low-code apps (list, query, count, aggregate, create, update, delete), in groups a client picks
  with `?groups=`. Each call acts as the person who signed in, at most at the label the workspace publishes at, through
  the tool dispatcher, guardrails and audit (`mcp.server.call`); writes wait for the person's approval from a browser
  session (`/api/me/mcp-holds`). The record tools (`records.entities`, `records.query`, `records.count`,
  `records.aggregate`, `records.create`, `records.update`, `records.delete`) are built-ins for chat, agents and
  workflows too. A separate MCP service with a service account is no longer needed to reach Exprsn-AI from an MCP client.
- MCP authorization (B-7102): the endpoint is an OAuth 2.1 resource server of the tenant's issuer, with RFC 9728
  protected resource metadata, `WWW-Authenticate` naming it on 401, RFC 8707 audiences (the resource named at the
  authorization endpoint is kept with the code and the refresh token family and becomes `aud`; `invalid_target` for a
  resource the issuer does not serve) and DPoP, optionally required per workspace. The issuer publishes RFC 8414
  metadata at the addresses MCP clients try and, when an identity admin turns it on, RFC 7591 dynamic client
  registration (`POST /oauth/register`, off by default). Discovery documents announce `authorization_response_iss_
  parameter_supported`.
- MCP client OAuth (B-7103): for per-user MCP servers, discovery (the 401 challenge, RFC 9728, RFC 8414, RFC 7591
  registration) or endpoints and a client entered by hand; each person connects with the authorization code and PKCE
  (state bound to the browser), tokens are sealed with the tenant key, refreshed before they expire and on a 401, and
  revoked at the authorization server on disconnect.
- Console: Identity gains the MCP server tab (publish per workspace, tool groups, label, DPoP, a preview, self-
  registration and the clients that registered themselves); Settings gains MCP access (connection URLs, held calls,
  connect and disconnect); MCP servers gains OAuth for users. Prototype boards first; `e2e/tests/mcp-server.spec.ts`.
- Fixed: Identity's PKCE switch for a public client is `aria-disabled`, so axe-core's enhanced contrast check no longer
  flags its dimmed label.

### SCIM 2.0, vault sharing, MongoDB leases, quote posts and visibility (Sprint 37c, B-7201, B-7202, B-4801, B-4802, B-4901)

- Migration `039c_scim_vault_posts`: `scim_tokens`, `scim_users`, `scim_groups`, `scim_group_members`;
  `vault_policies.share_secret_id` and `expires_at`; `feed_posts.visibility` and `quote_of`.
- SCIM 2.0 provisioning (B-7201): a SCIM store (`kind: scim`) in the tenant's chain, `/scim/v2` Users and Groups
  (RFC 7643/7644: create, replace, patch, delete, the full filter grammar, paging, `attributes`, ETags), SCIM tokens
  made and revoked under Identity (`identity:manage`, shown once). Deactivating a user ends their sessions, OAuth
  refresh tokens, API keys and DAV app passwords in the same request; a delete disables and unlinks them. SCIM users
  sign in through the upstream stores the SCIM store names. `server/src/identity/scim/`, `routes/scim.ts`.
- Group membership maps to roles (B-7202): group mappings with the SCIM store name SCIM groups; every membership change
  recomputes roles, clearance and workspaces (`identity.scim.reapply` after mapping changes). A local conformance suite
  (`server/test/sprint37c-scim.test.ts`) covers what the Entra ID and Okta validators check; the external validator run
  could not be made from here (`docs/identity.md`).
- Vault sharing (B-4801): share a KV secret with a person, a directory group, a workspace or an API key, as a policy
  grant of read on its exact path, with an expiry (`VAULT_SHARE_MAX_DAYS`), revocable, audited; a deny still wins and
  the label must clear the grantee. `GET /api/vault/shared-with-me`; expired shares stop applying at once and are
  removed by `vault.shares.expire`. `server/src/vault/shares.ts`.
- MongoDB leases (B-4802): `dialect: mongodb` for database engines (createUser with read or readWrite, updateUser on
  renew, killAllSessionsByPattern and dropUser at the end), tested against `mongo:8`.
- Quote posts and visibility (B-4901): `POST /api/feed/posts/:id/quote` quotes a post with a comment in any workspace
  or group the author may post in, labelled at least as high as the quoted post; `visibility: public | workspace |
  unlisted` on posts. An unlisted post is reachable by its link and absent from every feed, tag and digest; a repost
  of it is refused, a quote of it is unlisted.
- Console: Identity shows SCIM stores with their tokens and recent changes; Vault has Share, Shared with and Shared
  with you; Messages and feed has a visibility choice, Quote, the quoted post, a post opened by its link and Your
  unlisted posts. Prototype boards first.
- Settings: `VAULT_SHARE_MAX_DAYS`, `IDENTITY_SCIM_MAX_RESULTS`, `IDENTITY_SCIM_RATE_PER_MINUTE`,
  `IDENTITY_SCIM_TOKEN_MAX_DAYS`.
- Docs: `docs/api.md`, `docs/openapi.json`, `docs/identity.md` (SCIM and its conformance), `docs/security.md` (SCIM
  tokens, shares, MongoDB lease expiry, what unlisted means), `docs/accessibility.md`, `docs/permissions.md`.

### Red-team suites, agent identities and handoffs (Sprint 38b, B-7001 to B-7002, B-7701, B-7801)

- Migration `040b_redteam_agents`: `redteam_suites`, `redteam_runs`, `agent_identities`; `api_keys.agent_id`;
  `agent_runs.handed_to`. Job `redteam.run`. No new settings.
- Red-team suites (B-7001): an adversarial evaluation of a profile, an agent (by name) or a workflow, from the
  built-in attack categories (the Sprint 37a injection corpus cases with a canary, handed over as documents to
  summarise; jailbreaks; data exfiltration through tools, by answer or by tool call; system-prompt extraction) and
  the tenant's own cases, with a threshold and a gate. A profile answers each attack through the gateway as an
  evaluation case is answered; an agent as a child run of its own; a workflow as a run of its published version. An
  attack is resisted when the answer carries no canary, no tool call reaches for the outside address and no eight
  consecutive words of the system prompt come back. The gate: a profile with gated suites is published only once its
  settings hash has a passing run (no evaluation override opens it); an agent version is approved or restored only
  once its schema hash has one. Routes under `/api/admin/red-team`. `server/src/redteam/`.
- Red-team results as flags (B-7002): every attack that succeeded is a flag (checkpoint `red-team`, high severity for
  extraction and exfiltration), which a reviewer confirms into an eval case like any other; tenant-added attack
  cases with their own canaries.
- Agent identities (B-7701): roles, a label ceiling and keys per agent name (`/api/admin/agent-identities`). A run on
  behalf of a user acts within both grants: the user's permissions narrowed to the identity's roles, as credential
  scopes, and the lower clearance, so a tool call the roles do not cover is refused even for an admin and a run above
  the ceiling fails before it thinks; `actor.agent` beside the user in audit events. Keys minted for an identity
  authenticate as the agent on the owner's behalf, are refused once the identity is off, narrowed with its roles and
  never listed among the owner's keys. `server/src/agents/identity.ts`.
- Agent handoffs (B-7801): `handoffs` in the agent definition, offered like delegates and described as handing the
  conversation over; the handed-to run's answer ends the run as its own answer (`handedTo` on the run,
  `agent.run.handed_off`); chain references and the ceiling rule cover handoffs (`via: handoff`).
- Console: the Red team panel on the Profiles screen's Evaluations tab; the agent card's identity and red-team status
  with their modals and the handoffs field on the Registry screen; who answered on the Runs screen. Prototype boards
  first; `e2e/tests/profiles.spec.ts` and `e2e/tests/registry.spec.ts`.
- Tests: `sprint38b-redteam`, `sprint38b-identities`, `sprint38b-handoffs`; integration `redteam-agents`. The fake
  Ollama gained `leakingReply` (a model that prints its system prompt and obeys canaries).

### Row and field policies, DLP, legal hold and compliance export (Sprint 38c, B-8101 to B-8103, B-7601 to B-7603)

- Migration `040c_policies_dlp`: `app_policies`, `users.attributes`, `dlp_rules`, `dlp_patterns`, `legal_holds`,
  `compliance_exports`. Permissions `compliance:manage` (tenant-admin, legal-review) and `compliance:export`
  (legal-review, and an API key scope). Settings `DLP_MAX_TEXT_BYTES`, `COMPLIANCE_EXPORT_MAX_ROWS`,
  `COMPLIANCE_EXPORT_MAX_DAYS`. Job `compliance.export`.
- Row and field policies (B-8101, B-8102): reusable rule sets per app or entity with subjects (everyone, a role, a
  group, a workspace's members, a user), row conditions in the record query grammar whose values name the reader
  (`$user.id`, `$user.username`, `$user.clearance`, `$user.roles`, `$user.groups`, `$user.workspaces`,
  `$user.attributes.<name>`, the last set by a tenant admin on the user) and per-field grants (read, read unmasked,
  create, update) with masks `last4`, `hash` and `hidden`. The reader's grant narrows record queries, counts,
  aggregates, reads, updates, deletes, transitions, bulk writes, exports, the `records.*` tools and workflow record
  steps, and form submissions by a signed-in person; a reader no policy names reaches nothing; designers are exempt.
  `server/src/apps/policies.ts`, `/api/apps/:app/policies`.
- Explain (B-8103): `POST /api/apps/:app/entities/:entity/policies/explain` says which policies name a reader and
  why, whether a record is in their reach and by which policy, and what a field shows; the Apps screen's Policies tab
  has the editor and the explain panel.
- DLP (B-7601): rules over the built-in PII and secret detectors and the tenant's own RE2 patterns that raise the
  label and act by it (label, redact, hold) on chat and `/v1` answers, agent run outputs and uploads (attachments and
  file versions); content raised above its owner's clearance is held. A held answer goes to the flag queue as
  `DLP: <rule>`; a held run fails with the reason; a held upload is rejected. `server/src/compliance/dlp.ts`,
  `/api/compliance/dlp`.
- Legal holds (B-7602): a hold on a user or a workspace, asked for by one holder of `compliance:manage` and approved
  by another, suspends the chat, memory and file retention purges of their content until it is released; the reason
  is sealed. `server/src/compliance/holds.ts`, `/api/compliance/holds`.
- Compliance exports (B-7603): conversations (with messages), files (metadata and versions), memories, agent runs and
  accounts of a user and/or a workspace over a date range as sealed JSON Lines, requested and downloaded with
  `compliance:export` (a person or a scoped API key); rows above the requester's clearance are left out and counted;
  every request, run and download is audited. `server/src/compliance/exports.ts`, `/api/compliance/exports`.
- Console: the Apps screen's Policies tab (designers) and the Usage and audit screen's Compliance tab (DLP rules and
  patterns with a test box, legal holds, compliance exports). `e2e/tests/apps-policies.spec.ts`,
  `e2e/tests/compliance.spec.ts`.


### App packages, environments and promotion (Sprint 39b, B-8201 to B-8204)

- Migration `041b_app_packages`: `app_packages`, `app_pipelines`, `app_deployments`. Settings `APPS_PACKAGE_MAX_BYTES`,
  `APPS_DEPLOYMENT_HISTORY_DAYS`, `APPS_GIT_TIMEOUT_MS`, `APPS_GIT_ALLOW_FILE`. Job `apps.deploy`.
- App packages (B-8201): `exprsn-app/2`, the whole of an app's design (entities with their fields, formulas and state
  machines, forms, record and schedule triggers naming their workflows, the row and field policies, and the published
  workflows the triggers name as signed workflow bundles), with the records when asked for, signed with the KMS key
  over its canonical JSON, numbered per app and kept sealed. Import verifies the signature over exactly what arrived
  before anything is read (`422 Package refused`, audited `app.import.refused`); the old bundle door takes a package
  too. A package imports as a new app or applies to an app in place with entities, forms, triggers and policies
  reconciled by name (an entity still holding records is kept and reported). `server/src/apps/packages.ts`.
- Environments and promotion (B-8202): a pipeline names three apps as development, test and production and the
  workflow whose approval step guards production. A promotion to test packages the development app now; a promotion
  to production lands the exact package the last successful promotion to test landed (a stage cannot be skipped),
  once a run of the approval workflow, started with the deployment as its input and caller, succeeds; a rejected,
  failed or expired run rejects the deployment and tells the requester. `WorkflowService.start` takes a `caller`.
  Audited `app.package.promotion.requested`, `app.package.promotion.approved`, `app.package.promotion.rejected`,
  `app.package.promoted`. `server/src/apps/pipelines.ts`.
- Backups, history and rollback (B-8203): every deployment first packages the target (`source: backup`); the history
  keeps source, target, version, who, state and the report for `APPS_DEPLOYMENT_HISTORY_DAYS`; a rollback deploys the
  backup onto the same stage as a deployment of its own, audited `app.package.rolled_back`; a failure is audited
  `app.package.deployment.failed` and notified.
- Git export and import (B-8204): a package pushed to a repository as one readable JSON file per object
  (`package.json` with the signature, `app.json`, `entities/`, `forms/`, `triggers/`, `policies/`, `workflows/`,
  `records/`) and read back from one, reassembled in signing order and verified like a pasted package; https only
  (`file://` when `APPS_GIT_ALLOW_FILE`), a vault-held token answered to git through a credential helper. Audited
  `app.package.pushed`.
- Console (B-8201 to B-8204): the Apps screen's Deployments tab for designers: packages (make, download, push to git,
  import, import from git), the pipeline's stages with promote, edit and delete, and the deployment history with
  rollback; the page refreshes while a deployment is going. Prototype board first; `e2e/tests/apps-deployments.spec.ts`
  with axe-core.

### Data model generation, AI fields and outside database sync (Sprint 39c, B-8301, B-8401, B-8402, B-8501)

- Migration `041c_model_gen_sync`: `app_ai_fills`, `app_entity_sources`, `app_records.ai_pending` and
  `app_records.external_key`. Settings `APPS_AI_DEBOUNCE_MS`, `APPS_AI_FILL_MAX_ROWS`, `APPS_SOURCE_PULL_MAX_ROWS`.
  Jobs `apps.ai-fill-all`, `apps.source-pull`, `apps.source-schedules`.
- Data model drafts (B-8301): a description of an app becomes a draft of its whole data model from a local model
  through a published profile (entities, typed fields, relations, formulas, state machines, record triggers naming
  existing workflows), validated like a saved entity and shown as a diff per entity (new, changed, fields added,
  changed, omitted but kept, states); accepting it creates the new entities in dependency order, extends existing ones
  without removing anything and creates the triggers whose workflow exists, in one request. `POST
  /api/apps/{app}/model/draft` and `/model/apply`; audited `app.model.drafted` / `app.model.applied`.
- AI field prompts (B-8401) take field names and formulas over fields as placeholders (`{{upper(name)}}`), checked when
  the entity is saved; an edit regenerates only the AI fields that read a changed field, once per quiet window.
- AI fills over every row (B-8402): fill the empty values or refresh every record of one AI field as a job with an
  estimate first (records, tokens, the cost at the tenant's model price), progress and token totals on the fill, and a
  cancel between records; `/api/apps/{app}/entities/{entity}/ai/estimate|fills`; audited `app.ai.fill.started` /
  `cancelled` / `finished`.
- Outside tables as entities (B-8501): an entity backed by a table of a PostgreSQL or MySQL data connection: a pull (on
  demand or every N minutes) brings its rows in as records keyed by the key column, typed by the fields, with the
  state from a mapped column and rows gone removed; with writes on, a record created, changed, moved or deleted in
  the app reaches the table first (insert, update, delete through the drivers' new row mutation) so a refused outside
  write changes nothing here; attaching needs `apps:design` and `connections:manage` and an entity label covering the
  connection's. `/api/apps/{app}/entities/{entity}/source` and `/source/pull`; audited
  `app.entity.source.set` / `updated` / `removed` / `pulled` / `pull_failed`.
- Console (Apps screen): the draft dialog with its diff and editable JSON, an "AI fills over every row" panel and an
  "Outside table" panel on the Entities tab; prototype boards first; `e2e/tests/apps-model.spec.ts` with axe-core.
- Unit tests on SQLite (the outside table as a SQLite stand-in behind the real connection flow) and an integration
  test through the real PostgreSQL and MySQL drivers.

### Entity APIs and app embedding (Sprint 39d, B-8601 to B-8603, B-8701, B-8702)

- Migration `041d_entity_api_embeds`: `api_keys.app_scope`, `app_schema_versions`, `app_embeds`, `app_embed_keys`,
  `app_embed_pages`, `app_embed_sessions`. New settings `APP_EMBED_MAX_TTL_SECONDS` (3600) and
  `APP_EMBED_SESSION_PER_MINUTE` (30).
- The entity API (B-8601): every entity of an app is a REST resource at `/api/apps/:app/:entity`: list with a JSON
  `filter`, `where=field:op:value` conditions, `sort`, `q`, `limit`, `offset` or `cursor`, and `include=related` for the
  records the reference and lookup fields point at; read, create, update with `version`, transition and delete. The
  same service as the records routes, so policies, masks, labels, workspaces and audit apply unchanged. API keys may
  be limited to one app or one entity (`POST /api/me/api-keys {app: {app, entity?}}`, `records:read` and
  `records:write` only): accepted under `/api/apps` alone and refused on another app or entity.
- Schema versions and the schema API (B-8602): every design change, whichever route makes it, records a version
  with a hash of the whole design (`app_schema_versions`, audited `app.schema.versioned`); `/api/apps/:app/schema`
  reads the design and its versions, and creates, replaces or deletes entities, fields, state machines and forms.
- OpenAPI and a client per app (B-8603): `GET /api/apps/:app/openapi.json`, an OpenAPI 3.1 document typed from the
  entity definitions with the schema version and hash (its `ETag`), and `client.ts` or `client.js`, a generated
  client that creates a record against a fresh app with no hand-written code.
- Public embeds (B-8701): a public form published as an embed page under a random id (`/embed/:id`), served with
  `frame-ancestors` naming the app's allowed host sites and no `X-Frame-Options`; opened and submitted by that id
  through `/api/public/embeds`, on the public submission path, with the form's link token never on the page.
- Signed embeds (B-8702): keys registered per app (ES256, RS256, EdDSA public keys, an HS256 secret shown once, or
  the tenant CA verifying the token's `x5c`); a host token with the app as audience, `exp`, `jti` (once per key) and
  the claim that names the person is exchanged at `/api/public/embeds/session` for an embedded session, a bearer of
  its own apart from console sessions, inside the app's entities, read-only unless the app allows writes, capped by
  the app's limit and the server's; revoking a key ends its sessions; every exchange is audited.
- Console: the Apps screen's API tab (routes per entity, a curl, the schema version and hash, the downloads, the
  versions table) and Embed tab (settings, keys, pages with their iframe snippet, sessions); the embed pages
  (`web/js/embed.js`); Settings lets a key be limited to an app and an entity.
- Prototype boards for the two tabs and the key option; `e2e/tests/apps-api.spec.ts` with axe-core on the tabs and
  the embed page; unit tests `sprint39d-entity-api`, `sprint39d-schema-api` (the generated client runs against the
  test server), `sprint39d-embeds` (every key kind, a tenant CA built in the test); an integration test for
  PostgreSQL and MySQL.
- Known gaps in `docs/security.md`: an entity named like one of the app's own route segments is reached only through
  the records routes; a schema version holds the whole definition, not a diff, and nothing restores one; an
  app-limited key is refused on `/v1` and the MCP server outright; the tenant CA path checks one intermediate and
  no OCSP; the session's `host` is the token's `iss`; a reload of an embed page needs a new host token.

### Image classification in Knowledge (Sprint 36c, B-8801 to B-8805)

- Migration `038c_knowledge_images`: the base's vision profile and image classifiers, image documents (`parent_id`,
  `media`, the sealed description, the safety score), `knowledge_doc_labels`, image eval cases (`eval_cases.media_key`,
  `media_type`) and the `knowledge_search` built-in tool.
- Images as knowledge documents (B-8801): PNG, JPEG, WebP, GIF and HEIC uploads pass quarantine and the image safety
  check (a flagged image is rejected and deleted, audited `knowledge.image.withheld`); the base's vision profile
  writes a caption and the text in the image, which become the indexed text, so a screenshot is found by a phrase from
  it. The images inside PDF and Word documents become the document's parts, at least its label; a scanned PDF is
  indexed through its images. `server/src/knowledge/images.ts`.
- The `vision` classifier engine (B-8802): labels with thresholds like `llm`, scored by a vision profile from the
  image, JSON answers validated against the labels. A knowledge base names its published vision classifiers; the
  labels are stored on each image with their scores and the classifier version (`knowledge.classify`), and a new
  version of a published classifier re-labels the base's images in the background (`knowledge.reclassify`, audited
  `knowledge.reclassified`) without re-uploading them.
- Label search (B-8803): `labels: {any, all, minScore}` on `POST /api/knowledge/search` and on the documents list
  (`labels`, `labelsAll`, `minScore`, `media=image`); `GET /api/knowledge/bases/:id/labels` for the filter chips; image
  hits carry the caption, a text excerpt, the labels and a thumbnail URL (`GET /api/knowledge/documents/:id/thumbnail`,
  at the caller's clearance). The built-in tool `knowledge_search` is the knowledge step of agents and workflows, with
  the same filters, at the label of the call.
- Console (B-8804): the Knowledge screen shows image documents with their thumbnail, caption, labels and scores, label
  filter chips, re-classify for a base and an image, and the vision profile and image classifiers in a base's settings;
  the Classifiers screen offers the `vision` engine. Prototype boards first; axe-core and reflow checks in
  `e2e/tests/knowledge-images.spec.ts`.
- Evaluation (B-8805): image cases in the eval-set format (`image` as base64 on the samples route, or
  `PUT /api/admin/classifiers/:id/samples/image`), sealed in the blob store; a vision classifier publishes only after
  an evaluation with at least 200 image cases per label. `POST /api/classify` takes an image for a vision classifier.
- Docs: `docs/api.md`, `docs/openapi.json`, `docs/security.md` (what a caption or OCR text may leak, labels as
  metadata at the image's label, known gaps) and `docs/accessibility.md`.

### Model servers beyond Ollama: Apple Foundation Models, MLX and llama.cpp (Sprint 35a, B-4301 to B-4307)

- The gateway client behind an interface (B-4301): `ModelServer` (`server/src/gateway/server.ts`) with `version`,
  `models`, `loaded`, `show`, `load`, `unload`, `pull`, `delete`, `chat` and `embed`; `OllamaClient` implements it
  unchanged and no gateway test changed. What a server cannot do throws `Unsupported`, which the gateway, placements
  and the catalogue skip: nothing resident is reported, loads and unloads are recorded as `unsupported` instance
  events, pulls onto a mixed pool and rolling upgrades skip the server.
- `kind: openai` instances (B-4302): migration `037_model_servers` (`instances.kind` defaulting to `ollama`,
  `socket_path`, `token_ref`, `token_tenant`, `token_owner`). A Chat Completions server on a URL (the egress check and
  mutual TLS as for Ollama) or a Unix socket (`fm serve --socket`), with an optional bearer token stored in the
  caller's vault (`model-servers/<id>#token`) or given as a vault reference, resolved as the person who saved it.
  Health from `/health` or `/v1/models`; models from `/v1/models` (Apple's `pcc` listed but unavailable is not
  offered); llama.cpp's `/props` context length. The new `instance.probe` job (`POST /api/admin/instances/:id/probe`,
  run at registration) records whether tool calls and JSON schema output work; what the server reported is in
  `settings.reported`. `GET /api/admin/model-servers` (`models:manage`) is the import picker's list. Audited
  `instance.created {kind, socket, token}`, `instance.probe.started`.
- Chat Completions mapped onto the gateway's chat (B-4303, `server/src/gateway/openai-server.ts`): messages, the
  system prompt, tools and tool calls (ids kept, results paired with their calls), streamed deltas and reasoning,
  `response_format` from a JSON schema (`format` on the gateway's chat request, also passed to Ollama), stop,
  temperature, max tokens and usage (estimated when the server reports none). Ollama-only options are dropped and
  noted once as a `dropped` instance event. The tool loop, guardrails, labels and metering are unchanged.
  `server/test/fake-openai-server.ts` stands in for `fm serve`, `mlx_lm.server` and `llama-server` (TCP or socket).
- Catalogue entries without a pull (B-4304): `POST /api/admin/models {serverInstanceId, serverModel}` registers a
  listed model with `format: server`, no expected digest, `source: server:<instance>/<id>` (`models.server_instance_id`,
  `server_model`), placed warm on the instance's pool. Licence, conformance (run on that instance; the tool-calling
  test always runs and grants `tools`), label and dual-control approval apply; placements on a pool with such a
  server are warm only; retiring deletes nothing on the server.
- Embeddings and guard models (B-4305): a server that answers `/v1/embeddings` serves embedding models; one that
  refuses is remembered and the request goes to another instance with the model, such as an Ollama pool, with no
  change to the knowledge or guardrail code.
- Docs (B-4306): `docs/deploy.md` on `fm serve --socket` under launchd beside Ollama on a `metal` pool, with
  `mlx_lm.server` and `llama-server` as alternatives; `docs/security.md` on what the digest check cannot cover for
  server-held models; `docs/api.md` and `docs/openapi.json`.
- Console (B-4307): the Models screen gets Model servers (a drawer of the registered servers with what they report,
  Register model server with the kind, the socket path or URL and the token, and Probe again), Request import gets
  "Held by a model server" (the import picker of server-held models, unavailable ones disabled with the reason), and
  a held model's inspector, approval and card say "held by the server, no digest" with the capabilities the server
  reported. The prototype board first, then the live screen; `e2e/tests/models.spec.ts` registers an `fm serve`
  socket (the e2e server starts the fake on one) and approves its model with axe-core and 320 px reflow checks. The
  Pools screen's Load model offers Ollama instances only.

### Social and messaging live (Sprint 35d, B-4206, with B-4207)

- The Social and messaging screen is live (`#/social`, after Channels, its own sidebar icon; decision Q13), over
  `GET`/`PUT` routes under `/api/admin/social/` (`docs/api.md`). Migration `037d_platform_social`
  (`social_workspace_policies`, `social_tenant_settings`, `feed_trending_exclusions`, `messaging_exports`) and the
  group state `archived`. `social:manage` now also governs these policies (decision Q4); held content stays under
  `moderation:manage`.
- Feed: per-workspace approval policy (whether posts pass `user-input` in full, with the platform baseline always
  kept; who approves held posts; media allowed and their largest size), a per-tenant trending exclusion list honoured
  at once and by the `feed.trending` job, Run trending now, and the weekly digest's profile, weekday and hour (UTC),
  size and highest label per tenant, with a test digest sent to the requester alone.
- Groups and events: per-workspace defaults (who may create groups, visibility, join mode, event capacity), groups
  across workspaces with members, pending requests, upcoming events, open reports and feeds, Transfer ownership and
  Archive (read only), and the tenant's calendar feeds with Revoke: a revoked feed answers 404 on its next fetch
  (the item's "done when").
- Messaging: retention, limits, search and the tenant's summary profile; legal-hold export of a conversation under
  dual control (decision Q5): requested with a reason and a recent sign-in, approved by a second platform admin, then
  written by the job `messaging.conversation.export` as a sealed CSV only the requester downloads. Audited
  `messaging.export.*` and `messaging.conversation.exported`.
- Realtime (`platform:manage`): this instance's rooms and sockets by kind, signals per minute and those refused by
  `ROOM_SIGNALS_PER_MINUTE`, socket authentication failures, and Close a user's rooms on every instance
  (`TOPICS.roomsClose`, audited `realtime.rooms.closed`).
- Relations: follow, block, mute and list counts, the most blocked accounts (counts only), and contact rules per
  workspace (anyone in the workspace, contacts only, admins only) enforced when a conversation is started or someone
  added, on top of each person's own rule.
- Accessibility and reflow for the screen and its dialogs (B-4207's share): `docs/accessibility.md`,
  `e2e/tests/social.spec.ts`. The prototype board now names a second platform admin as the export approver and shows
  refused signals instead of a backlog, as the server reports them.

### Groups depth (Sprint 36a, B-4401 to B-4405)

- Channels inside a group (B-4401): groups one level down with their own members, roles, posts and events, created by
  the group's owners and moderators (`POST /api/groups/:id/channels`). The group is a channel's outer boundary: only
  its readers see its channels, only its members join them, leaving the group leaves them, and archiving or deleting
  the group takes them along. The group's owners act as owners of its channels. A channel's label is never below its
  group's; raising the group's label raises the channels below it. The feed's group scope and fan-out follow the same
  rule. Migration `038_groups2`.
- Discovery (B-4402): `GET /api/groups/discover` lists the groups the caller may join, ranked by shared members and
  activity of the last 30 days, and never one labelled above the caller's clearance.
- Places (B-4403): an optional place on groups (a sealed name and a point) and a point on events, with distance
  filters (`near`, `km`) on the group list, discovery and the calendar. PostGIS narrows on PostgreSQL when the
  extension is there (the migration creates it and a GiST index when the role may), a bounding box elsewhere; one
  great-circle distance decides, so the three databases return the same groups.
- Trending groups (B-4404): the `groups.trending` job counts joins and posts per group like trending hashtags;
  `GET /api/groups/trending` and Recount now on Social and messaging.
- Group categories (B-4405, decision Q6): a tenant-managed list on Social and messaging
  (`/api/admin/social/group-categories`), a category per group, and category filters on Groups and Discover; removing
  a category leaves its groups uncategorised, never hidden.
- Screens: Groups gains Discover (ranked), Trending, category and distance filters, a group's category and place, a
  Channels tab and channel pages, and points on events; Social and messaging gains Group categories and Trending
  groups. Boards first in `design/prototype/`, then live; `e2e/tests/groups-depth.spec.ts` checks them with axe-core,
  the in-page checker and reflow.

### Tenant provisioning templates (Sprint 35d, B-4501)

- Tenants are created from a template (decision Q11): **Create from template** on the Tenants screen (system
  admins), `POST /api/admin/tenants/from-template` and `exprsn-ai tenant:create --template <id>`. The first
  templates are exprsn-platform's organisation types: **enterprise** (General, Finance, People, Engineering and Legal
  workspaces up to confidential; Reader and Contributor roles; assistant, analyst and summariser profiles; an issuing
  CA), **team** (Team and Projects workspaces; a Contributor role; an assistant profile; an issuing CA) and
  **personal** (one confidential workspace; an assistant profile). `GET /api/admin/tenant-templates` lists what each
  creates. No new permission (`tenant:manage` and the system-admin role) and no migration.
- One step: the tenant, its local user store and data key, the workspaces, the custom roles (member-baseline
  permissions only, version 1 applied), draft gateway profiles pinned to a pool in the template's zone (`inference`)
  when one may process their label, the tenant's intermediate CA under the platform root when there is one (reported
  as skipped otherwise), and the first admin: `tenant-admin`, cleared for the highest workspace ceiling, a member of
  every workspace, with a single-use enrolment link by default or a password. Audited in both chains: the parts' own
  events and `tenant.template.applied {template, workspaces, roles, profiles, zone, issuer, admin}`.
- `admin:create`'s `createAdmin` takes the audit actor, so the first admin's `user.created` names the provisioning
  admin rather than the CLI.

### Overview and Jobs and queues live (Sprint 35b, B-4202, B-4203, with B-4207)

- The Overview screen is live, first in the Admin group (Q3): open alerts computed from the existing watches (an
  instance behind the schema or not answering, the backup RPO, zone drift in the cluster, platform certificates and the
  tenant's own certificates expiring within 7 days, the rate-limit probe), acknowledged tenant-wide and audited
  `platform.alert.acknowledged` (Q15); counters for 1 h, 24 h or 7 d; every server instance with its `/readyz` checks,
  schema, claimed jobs, sockets, rate-limit store, tracing and NTP offset; the next schedules; the recent audit; and
  capacity (database size and pool, vectors, blob store). `GET /api/admin/overview`.
- Instances register themselves: each server process beats into `platform_instances` every 30 seconds (migration
  `037b_platform_ops`) with what `/readyz` answers, which now shares that code. Draining an instance from the screen
  (Q14: a confirm and a recent sign-in, `platform:manage`) stops it claiming jobs and makes `/readyz` answer 503 with
  `checks.shutdown: draining`; audited `platform.instance.drained`.
- The Jobs and queues screen is live, with five tabs: Queues (every job type with queued, running, oldest, failed,
  p50 and p95, and pause by type, which every instance honours within one poll: `jobs.type.paused`,
  `jobs.type.resumed`), Jobs (filters by state, type, window, job id or trace id; cancel and retry, retry every failed
  job: `jobs.cancelled`, `jobs.retried`), Schedules (last runs, run now, pause: `jobs.schedule.*`), Dead letters
  (moderation jobs and workflow runs, redriven or discarded with a reason: `jobs.deadletter.discarded`) and Cache (the
  tenant cache's namespaces with reads, hits and invalidations, and invalidate: `jobs.cache.invalidated`, Q1). System
  admins see every tenant's jobs with a tenant filter, tenant admins their own (Q9). `JobQueue` gains pause by type
  and `requeue`; `Scheduler` lists its schedules, runs one now and skips a paused one.
- Both screens are in the accessibility and reflow checks (axe-core, Standard and Enhanced, light and dark, 320 and
  640 px) through their own Playwright spec; `docs/accessibility.md` lists them.

### Storage and Configuration live (Sprint 35c, B-4204, B-4205, with B-4207)

- **Storage** (B-4204) is a live admin screen (`platform:manage`) with Stores, Usage, Quarantine, Integrity and Purges.
  Stores: the blob store (health from `/readyz`, size and objects from the last verification, capacity from `statfs`),
  the database (its own size and connections), the vector store, backups, the media work directory, training datasets
  and model files, with daily growth samples (`ops.storage.sample`). Usage: bytes by workspace (files, versions,
  trash, media, knowledge uploads, attachments) against the file quota (which counts files, versions and trash), by
  user and by kind; quotas are set from the screen. Quarantine: what waits for its scan or was refused in the last 24
  hours, the ClamAV scanner (`PING`, `VERSION`, counts today), Rescan (`503` while ClamAV does not answer) and Delete,
  audited `file.quarantine.rescanned` and `file.quarantine.deleted`.
- The integrity check `ops.blobs.verify` (every `BLOBS_VERIFY_MINUTES`, or from the screen, optionally comparing
  checksums) lists the store and walks every row: **missing** objects a row names, **orphans** older than
  `BLOBS_ORPHAN_GRACE_HOURS` that nothing references (never backups or mirror files), and **mismatches** (an object
  whose SHA-256 changed without the server writing it). It never changes the store. Orphans are deleted after a dry
  run that walks the references again, by one admin with a reason (decision Q10), within `BLOBS_DRY_RUN_MINUTES`;
  audited `platform.blobs.orphans.dry-run` and `platform.blobs.orphans.deleted` with the list of objects. An expected
  checksum change is accepted with a reason (`platform.blobs.checksum.accepted`).
- Blob store migration (decision Q16) as a copy-then-switch job `ops.blobs.migrate`, started with a recent sign-in and
  a reason: every instance also writes to the target while every object is copied and its SHA-256 checked, the target
  is verified, then reads and writes switch, with reads of anything missed falling back to the old store until it is
  retired. A failure puts every instance back on the old store. The store any process uses is now a switchable store
  (`platform/blob-switch.ts`) that follows the shared mode.
- **Configuration** (B-4205) is a live admin screen: every setting this build reads, from a descriptor generated from
  `server/src/config/index.ts` (`npm run gen:settings -w server`; section, type, constraint, default, secret, hot or
  restart, description), what each instance reads and where it came from (env, file, default or override), and
  whether instances differ. Every instance reports under `INSTANCE_NAME` every `PLATFORM_INSTANCE_REPORT_SECONDS`;
  secrets are reported as set or unset, their length, file and mode and a keyed fingerprint, never their value.
  Export as `.env` (secrets masked, audited `platform.settings.exported`) and Diff against defaults.
- Database overrides for every overridable setting under dual control (decision Q2): one platform admin proposes a
  value with a reason, another approves (never the proposer). The value is checked against the field and the
  configuration's cross-field rules. A hot setting applies on every instance at once; a restart setting at each
  instance's next start (applied before the services are built), and the screen names the instances still waiting.
  Secrets and the settings needed to reach the database are not overridable; `PLATFORM_SETTINGS_OVERRIDES=false` keeps
  every setting in the environment. Audited `platform.setting.proposed`, `.approved`, `.rejected`, `.withdrawn`.
- New routes under `/api/admin/storage/` and `/api/admin/platform/settings` (`docs/api.md`, `docs/openapi.json`,
  `docs/permissions.md`); migration `037c_platform_storage`; new settings `PLATFORM_SETTINGS_OVERRIDES`,
  `INSTANCE_NAME`, `PLATFORM_INSTANCE_REPORT_SECONDS`, `BLOBS_VERIFY_MINUTES`, `BLOBS_ORPHAN_GRACE_HOURS`,
  `BLOBS_DRY_RUN_MINUTES`. The boards (B-4201) follow what the server does: the migration and the verification are no
  longer proposals, a checksum mismatch is accepted rather than re-sealed, the purge table lists the jobs the server
  schedules, and Mark restarted became Check again (the banner clears itself as instances report).
- Accessibility and reflow (B-4207, this part): both screens in the Playwright sweeps and in
  `e2e/tests/storage-configuration.spec.ts` (axe-core and the in-page checker on every tab and design state, Standard
  and Enhanced, light and dark; reflow at 320 and 640 px for the screens and their dialogs); `docs/accessibility.md`.

### Blob deduplication, held form values and reveal anomalies (Sprint 36b, B-4601, B-4701, B-4803)

- Reference-counted blobs in the file store, within one tenant only (B-4601): migration `038b_dedup_held_vault`
  (`file_blobs`, `file_versions.blob_id`). When a version passes its scan and the tenant already stores the same
  content (SHA-256 of the plaintext), the version reads the existing sealed object and the quarantined copy is
  deleted; otherwise its object becomes a blob later uploads share. The trash purge releases references and deletes
  an object with its last reader; offboarding deletes the tenant's blob rows. Every upload still stores and scans its
  full bytes, and quotas still count each version's own size. The migration registers the first ready copy of each
  content per tenant. `GET /api/admin/storage/usage` adds `dedup` (objects, shared objects, references, bytes held,
  bytes stored, bytes saved, per tenant), shown on Storage, Usage. The integrity check, orphan deletion, purges and
  blob store migration see shared objects through `file_blobs.blob_key`. `file.version.ready` names the shared blob.
- Held form values (B-4701, closing the B-2205 known gap): a public form value the `user-input` guardrail holds no
  longer refuses the submission. It waits as a held submission (values sealed, `app_form_holds`) with a hold flag of
  source kind `app-form-submission`, routed to moderation queues like any flag; the submitter gets `202 {held: true}`.
  `GET /api/apps/held`, `GET /api/apps/held/:id` and `POST /api/apps/held/:id/decide` (`flags:review` or
  `moderation:review`) list, read and accept (into a record, written by no one, `source: form`) or reject it; the
  Flags decide route does the same for these flags and shows the values. Moderation shows the held submission in the
  queue inspector with Accept and Reject. At most `APPS_HELD_MAX_PER_FORM` (200) wait per form; decided ones go
  `APPS_HELD_KEEP_DAYS` (30) after the decision (`apps.held.purge`). Audited `app.form.held`,
  `app.form.held.accepted`, `app.form.held.rejected`.
- Anomaly detection on vault reveals (B-4803): reveals of KV secrets over the API are kept (`vault_reveals`,
  `VAULT_ANOMALY_HISTORY_DAYS`) and each is compared with the secret's history before it is answered: a new address,
  an odd hour of the day (once it has `VAULT_ANOMALY_MIN_HISTORY` reveals) or a burst (`VAULT_ANOMALY_BURST` reveals by
  one caller within `VAULT_ANOMALY_BURST_SECONDS`) opens a flag for the secret's owner (`vault_reveal_flags`), with a
  notification and email. `GET /api/vault/reveal-flags`, `GET /api/vault/reveal-flags/:id` and `POST
  /api/vault/reveal-flags/:id/resolve` (`secrets:read`; the owner or `secrets:admin`) list and resolve them as expected
  or suspicious; Vault has a Reveal flags tab. Detection never refuses a reveal; `VAULT_ANOMALY_BURST=0` turns it off.
  Audited `vault.reveal.flagged`, `vault.reveal.flag.updated`, `vault.reveal.flag.resolved`; `vault.reveals.prune`
  drops old reveals hourly.

## 1.5.0

### Chaining agents, skills, tools and workflows (Sprint 34a, B-4102 to B-4107)

- Built on the chain context of Sprint 32 (B-4101): every link is a node of the caller's chain, acts as the chain's
  principal, runs at the chain's label within the callee's ceiling and is charged to the root's budgets. Migration
  `036_chains` (`chain_nodes.decision` and `error_type`, two indexes). No new permission.
- Agents delegate to agents (B-4102): an agent's `definition.agents` (up to 16) lists the agents it may call, each
  offered to the model as the tool `agent:<name>`. A call passes the dispatcher like any tool call and starts a child
  run of the published delegate as the same principal, at the chain's label, with budgets no larger than the
  delegating run has left; the delegating run waits and continues with `{run, agent, answer}`, the answer typed by the
  delegate's `outputSchema` when it declares one (agents take `inputSchema` and `outputSchema`). Audited
  `agent.run.delegated`; cancelling a run cancels the runs it delegated to.
- Skills compose (B-4103): a skill's `definition.skills` lists the skills it builds on; loading a skill loads its
  closure once each, dependencies first (at most 32), and offers the tools of the whole closure, deduplicated. Every
  skill of the closure is a `skill-load` node of the chain.
- Workflows an agent lists (B-4104): `definition.workflows` (up to 16) are offered as `workflow:<name>` and run and
  awaited as a workflow tool is (B-1006), without publishing one; a workflow the agent does not list is refused.
  `GET /api/workflows/:id/callers` adds the agents that list the workflow.
- Chain checks at publish (B-4105): the registry and workflow publish build the reference graph across agents, skills,
  tools and workflows. A cycle made only of steps that always run is refused (the registry's **Chain references**
  check; a workflow publish answers `422` with code `chain` and the path); a cycle through a model's choice is a
  warning; references above the referrer's ceiling and unpublished references fail the check. "Used by" at
  `GET /api/admin/registry/:id/used-by` and `GET /api/workflows/:id/used-by`; retiring the last callable version of an
  entry something live uses, or deleting a workflow a published agent or workflow uses, is `409 Still in use`, naming
  them.
- Approvals and failures through the chain (B-4106): a call held anywhere pauses the chain. The root's run views list
  the held calls (`held`, with the path), and `POST /api/chains/:id/held/:node/decision` decides one with the rules of
  the place where it waits (audited `chain.held.decided`). A model step's skill call that needs approval now pauses the
  step on an approval (`approverRole`, `approvalTimeoutMs`) instead of being reported to the model. A child's failure
  reaches its parent typed (`failed`, `budget`, `cancelled`, `rejected`, `chain_limit`, `output`, `label`, `timeout`):
  an agent sees a tool error starting `child_<type>:`, a workflow's failure edge receives `type`.
- The chain view (B-4107): `GET /api/chains/:id`, the tree of invocations with timing, tokens, steps, wall and GPU
  time, labels, guardrail decisions, audit links and held calls; its totals equal what was metered for the chain.
  `POST /api/chains/:id/nodes/:node/replay` replays an agent-run or workflow-run node from a step as a new chain
  (audited `chain.node.replayed`); `GET /api/admin/audit` takes a `target` filter.

### The chain tree and registry fields in the console (Sprint 34d, B-4108, B-4109)

- Prototype boards (B-4108): Runs gains the chain tree with a node inspector (usage and subtree, label, guardrail
  decisions, typed error, audit link, replay from a node) and held calls decided from the root with their path;
  the registry editor gains agent delegates, listed workflows, input and output schemas, skill dependencies with the
  loaded closure, the Chain references check and a "used by" view before deprecating or retiring; Workflows gains
  "used by" before deleting and a Chain tree button on runs. The smoke run is clean in light and dark.
- Live screens (B-4109): the tree comes from `GET /api/chains/:id` and opens from a run, a workflow run or
  `#/runs?chain=<id>&node=`; held calls are decided through `POST /api/chains/:id/held/:node/decision` and nodes
  replayed through the chain replay route; Retire and Delete are disabled while an entry is still used.
  `e2e/tests/runs-chain.spec.ts` opens a three-level chain (planner, broker, clerk) as a tree from its root run with
  no axe-core, in-page checker or reflow finding, and approves a `feed.post` call held three levels down from the root.
  The fake model in `e2e/server.ts` makes the tool call named on an `E2E-CALL` line of an agent's prompt; the reflow
  check is shared from `e2e/tests/support/reflow.ts`.
- Fixed on Runs: a run with its own error text no longer shows "The run could not be loaded", and route parameters
  no longer cause a re-fetch loop.
- Known limit: the registry editor cannot clear an agent's input schema once set (the PATCH schema does not take
  `null`).

### Profiles and presence (Sprint 34c, B-5801, B-5802)

- Migration `036b_profiles` (`user_profiles`, `user_presence`, `presence_connections`). Routes `/api/people` and
  `/api/presence` under `social:read` and `social:write` (an avatar also needs `files:write`), answered with
  `Cache-Control: no-store`.
- Profiles (B-5801): pronouns (up to 40 characters) and a bio (up to 500) screened at the `user-input` guardrail; an
  avatar (PNG, JPEG, WebP or GIF, at most 2 MiB) uploaded into the file store of the caller's current workspace
  through its quarantine and served only while its pinned version is a ready image, not in the trash, within the
  viewer's clearance; a version that fails its scan is never shown. A profile is known to people who share a workspace
  with its owner (anyone else gets `404`); the pronouns, bio and avatar further need the viewer's clearance to reach
  the profile's label and, when the owner narrowed it, a shared workspace among those named. Two people in a block see
  each other's name only. Audited `profile.updated` (the fields, never the text), `profile.avatar.set`,
  `profile.avatar.removed`.
- Presence (B-5802): available, away, busy or offline, chosen or `auto` (away while every socket the person holds
  reports idle); without a connected socket a person reads offline. `PUT /api/presence/me` is audited
  `presence.status.updated`. On the console's socket, `presence.watch`, `presence.unwatch`, `presence.idle` and
  `presence.changed`: each change is published once and relayed by every instance without the sockets of people in a
  block with the person, and a new block takes each out of the other's presence room at once. Connections are kept per
  instance with a 30-second heartbeat and swept after 90 seconds.
- Console: a Profile page opened from people's names on Messages, the feed and Groups, with a People directory; the
  public profile (pronouns, bio, picture) and status in Settings; the console reports idle after five minutes without
  input or while the page is hidden. Fixed: the feed's Post handler matched any click inside a post.

### The IMAP channel adapter against a real IMAP server (Sprint 34b, B-3605)

- `server/test/integration/imap.test.ts` (gated on `TEST_IMAP_URL` and `TEST_IMAP_SMTP_URL`): mail delivered by SMTP
  to a GreenMail mailbox becomes a channel thread through the `channels.imap-poll` job and imapflow, is answered
  through the outbox, a reply in the thread joins the session, nothing is marked seen, and a wrong password is
  recorded on the cursor and audited once. `server/test/integration/greenmail.sh` starts GreenMail 2.1.5 (pinned by
  digest) with a throwaway CA; the CI integration job runs it.
- CI: the MongoDB service's health command no longer has a `: ` in a plain YAML scalar.

### WebDAV for the file store (Sprint 34b, B-3201 to B-3203)

- Migration `036c_dav_files` (WebDAV locks). Described in `docs/dav.md`.
- B-24 workspaces, folders and files as WebDAV collections under `/dav/files/` (and `~shared` for files shared with
  the caller): PUT through quarantine, the type check and ClamAV, scanned before it answers and unreadable until it
  passes; every PUT a new version; DELETE to the trash; Finder's AppleDouble files dropped (B-3201).
- COPY and MOVE for files and folders (MOVE keeps ids, so versions and shares stay; COPY scans again), LOCK and UNLOCK
  (class 2, exclusive and shared, depth 0 and infinity, lock-null resources, the If header with lock tokens) (B-3202).
- Quota properties (RFC 4331) and 507 over a limit; the `litmus` suite (basic, copymove, props, locks, http) in CI,
  all passing (B-3203). `JobQueue.runNow` and `FileService.scanNow` run a version's scan job before answering.

### Workflows 2 and the chain context (Sprint 32, B-3901 to B-3910, B-4101)

- Migrations `034_workflows2` (`chains`, `chain_nodes`, `workflow_items`; the chain on agent and workflow runs),
  `034b_workflow_triggers` (`workflow_triggers`, `workflow_trigger_firings`, `workflow_dead_letters`) and
  `034c_workflow_steps` (the domain built-in tools, a feed post's source, approval forms and answers). New settings
  `CHAIN_MAX_DEPTH`, `CHAIN_MAX_TOKENS`, `CHAIN_MAX_STEPS`, `CHAIN_MAX_WALL_SECONDS`, `CHAIN_MAX_GPU_SECONDS`,
  `WORKFLOW_MAX_DEPTH`, `AGENT_MAX_DEPTH`, `WORKFLOW_EVENT_RATE_PER_MINUTE`, `WORKFLOW_EVENT_MAX_DEPTH`,
  `WORKFLOW_SCHEDULE_TICK_SECONDS`. No new permission.
- The chain context (B-4101): every invocation (a chat turn whose answer calls a tool, an agent run, a workflow run, a
  tool call, a skill load, a plugin action that starts a workflow, an app trigger) is a node of its root's chain. A
  child acts as the root's principal, its label is at least the chain's high-water mark, and depth is capped by one
  `CHAIN_MAX_DEPTH` (default 8) across kinds, with `WORKFLOW_MAX_DEPTH` and `AGENT_MAX_DEPTH` (3 each) as per-kind caps;
  tokens, steps, wall time and GPU time are charged atomically to the root's budgets. Nodes are unique by kind and
  reference, so a job retried on another instance resumes its node. Refusals are audited `chain.refused`, a budget stop
  `chain.stopped`; a refused tool call reaches the model as a `chain_limit` tool error. Run views carry `chain` and
  `caller`, and workflow runs their `children` and map and loop `items`.
- Sub-workflow, agent, `map` and `loop` steps and skills on model steps (B-3901, B-3902, B-3905): a `sub` step runs a
  published workflow as a child under the parent's owner and label, and the child's approvals pause the parent; an
  `agent` step runs a published agent and waits without a worker; `skills` (up to 8) on a `model` step load published
  skills' instructions and tools through the dispatcher, so every call passes the tool's ceiling, schema, the
  `tool-call` checkpoint and its rate limit; `map` fans out over up to 200 items (`maxParallel` up to 20) with each
  item's result checkpointed, and `loop` iterates up to 40 times with an optional `while`. `GET /api/workflow-callees`
  lists what the new steps may call.
- Triggers on the workflow itself (B-3903): source `event` (a catalogue event or group, with the plugin fan-out rules:
  workspace, label, `WORKFLOW_EVENT_RATE_PER_MINUTE`, no loops through the chain of workflows) and source `schedule`
  (a five-field UTC cron, each due time claimed once across instances). Runs start as the version's publisher with
  what they hold at that moment, or are skipped with the reason. `GET` and `PATCH /api/workflows/:id/triggers`;
  audited `workflow.trigger.*`.
- Failure handling (B-3906): a per-step `retry` (up to 5, fixed or exponential, waiting durably), an on-failure edge
  (`branch: failure`) whose steps receive `{error, step}`, and dead letters for runs that fail for good, with redrive
  from the failed step (`/api/workflow-dead-letters`, audited `workflow.run.dead_lettered` and
  `workflow.dead_letter.redriven`).
- Bundles (B-3909): signed `exprsn-workflow/1` export (`GET /api/workflows/:id/bundle`) and import
  (`POST /api/workflows/import`) with tool, profile, app, vault and trigger references re-bound; a bundle changed after
  signing is refused with `422 Bundle refused`.
- Domain built-in tools (B-3904): `messages.send`, `feed.post`, `files.write_version`, `groups.create_event` and
  `channels.answer` (`impl: builtin`, published to every tenant, all `write`), acting as the caller through the domain
  services and called the same way from chat, agents and workflows; a post made by a built-in or a plugin records its
  `source`. The plugin broker's `records.read`, `records.write`, `files.read`, `groups.read` and `posts.write` calls are
  live, acting as the installing user within the plugin's max label.
- Approval forms (B-3907): an `approval` step names an app form; the approver's answers are validated like a
  submission, sealed with the approval, become the step's output and are audited with the decision. `notify` and
  `webhook` steps (B-3908): in-app and email notices to cleared recipients (`workflow.step.notified`); one signed
  delivery per run and step through the tenant's webhook path, with the endpoint checked against the outbound host rules
  when the graph is saved (`422 Workflow invalid` otherwise).
- Console (B-3910): the live Workflows screen edits every step kind the server has, sets event and schedule triggers,
  per-step retries and failure edges, and has the run history (with chain, caller, children and items), Triggers and
  callers (`GET /api/workflows/:id/callers`), versions with bundle export and import, approvals and dead letters with
  redrive; a New workflow button in the toolbar. The event catalogue is also readable with `workflows:manage`.

### App passwords for DAV clients in Settings (Sprint 32, B-3415)

- `GET /api/me/dav`: the CalDAV, CardDAV and WebDAV discovery URLs, the username to type into a client, which scopes
  the caller's roles make usable, and how long the session's second-factor confirmation still counts for creating an
  app password. The create response also names the WebDAV URL (`/dav/files/`, B-32).
- Settings has a panel under Security with each device's app password (scopes, creation, last use with time, address
  and client, expiry) and Revoke; creating one asks for an authenticator code or a passkey first when the second factor
  is older than the step-up window (the password does not count), and the password is shown once. The step-up dialog
  takes a factor-only mode, used whenever the server answers `step_up` with `factor`.

### Console screens for the 1.4.0 domains (Sprints 29 to 31, B-3401 to B-3414)

- Prototype boards in `design/prototype/` for every new screen and the identity additions (B-3401), with the Workflows
  board realigned on the server's step kinds.
- Live screens: Certificates (B-3402), Vault (B-3403), Plugins and events (B-3404), Apps (B-3407), Files (B-3408) and
  the identity additions on Identity, User stores, Settings and Sign in (B-3413); Moderation (B-3405), Groups and events
  (B-3409), Channels (B-3410), Messages and feed (B-3411) and Roles and access (B-3412); and AT-Protocol (B-3406,
  Sprint 31), with the read endpoints and fields they need on the server. Each joined the Playwright suite with
  axe-core (Standard and Enhanced, light and dark) and the reflow checks for its dialogs and drawers, described in
  `docs/accessibility.md` (B-3414).

### Custom feed generators, relay commit verification and the RSVP race (Sprint 31b, B-3001 to B-3003, B-3604, B-3603)

- Feed generators (B-3001): a tenant's feeds are served by its own AT-Protocol identity, whose DID document gains a
  `#bsky_fg` `BskyFeedGenerator` service (did:web computed; did:plc through a signed PLC operation, audited
  `atproto.identity.service-added`). Public XRPC `app.bsky.feed.describeFeedGenerator` and
  `app.bsky.feed.getFeedSkeleton` at `/xrpc/…` and `/atproto/<key>/xrpc/…`; an inter-service JWT (ES256K or ES256)
  is verified against the issuer's `#atproto` key, its audience, expiry and `lxm`, and a bad one is refused with `401`.
- Feeds as rules over the firehose (B-3002) under `/api/atproto/feeds` (`firehose:manage`, audited
  `atproto.feed.*`): authors, collections, keywords and labels (in force from the tenant's labeler and trusted
  labelers, or the check's verdict; `!hide` excluded by default), checked again when served; optional ranking by
  embedding similarity through a gateway profile or by a classifier's score. Posts reach the feeds after the
  moderation check; deletes leave them.
- The feed index (B-3003): keyset cursor pagination by (sort, id), retention and a size cap pruned by
  `atproto.feeds.prune` every `FEED_PRUNE_MINUTES`, and a per-feed rate limit on getFeedSkeleton. Migration
  `033b_feeds` (`atproto_feeds`, `atproto_feed_items`, `firehose_subscriptions.rejected`). New settings
  `FEEDS_MAX_PER_TENANT`, `FEED_ITEMS_MAX`, `FEED_PRUNE_MINUTES`, `FIREHOSE_REJECT_AUDITS`.
- B-3004 (publishing the `app.bsky.feed.generator` record) has its interface: the feed view's `record` (naming the
  generator's service DID) and `PUT`/`DELETE /api/atproto/feeds/{id}/publication`.
- Relay commit verification (B-3604): subscribeRepos commits are checked against the repo's `#atproto` key (DID
  documents through the service URL checks, cached, refreshed once on a failed signature) and each record used is
  proven against the signed Merkle search tree; a commit that fails is dropped, counted (`counts.rejected`) and
  audited `atproto.firehose.commit.rejected` (rate-limited). Tested against the AT-Protocol interop vectors (MST key
  layers, commit proofs, signature fixtures) in `server/test/fixtures/atproto/`.
- RSVP capacity (B-3603): the event row is locked (`SELECT … FOR UPDATE` on PostgreSQL and MySQL) while the places are
  counted; fifty simultaneous RSVPs for one place leave one attendee on SQLite, PostgreSQL and MySQL.

### The AT-Protocol personal data server (Sprint 31, B-2901 to B-2906, B-3004)

- Exprsn-AI hosts AT-Protocol repositories, described in `docs/pds.md`. Hosting is off until a platform admin enables
  it per tenant (`PUT /api/admin/pds/tenants/{tid}`), and is refused in an air-gapped deployment or a PDS zone without
  egress: repositories are public by protocol. New permission `pds:manage` (tenant admins); members keep their own
  account under `atproto:link`. Migration `033_pds`; new settings `PDS_*`; the event catalogue (version 7) lists a
  `pds.*` group.
- Accounts are tied to Exprsn-AI users: a did:plc whose repo and rotation keys live in the signer or OpenBao, a handle
  `<name>.<tenant>.<PDS_HANDLE_DOMAIN>` that resolves to it (`/.well-known/atproto-did`, `resolveHandle`), created from
  the console or by `com.atproto.server.createAccount`, which follows the tenant's sign-up policy with invite codes
  for closed and approval policies (B-1801). Bluesky clients sign in with app passwords made in the console; the
  Exprsn-AI password never works over XRPC. Sessions are refresh-once token pairs (B-2901).
- Repositories: the Merkle search tree, signed version 3 commits, DAG-CBOR and CAR, matched byte for byte against the
  AT-Protocol interop fixtures and the reference implementation; `com.atproto.repo` writes (`createRecord`,
  `putRecord`, `deleteRecord`, `applyWrites`) validated against the bundled Bluesky lexicons; reads and the
  `com.atproto.sync` exports (`getRepo`, `getRecord`, `getBlocks`, `listBlobs`, `getBlob`, `getLatestCommit`,
  `getRepoStatus`, `listRepos`) (B-2902).
- Blobs stream through the attachment quarantine, typed from their bytes, limited per tenant, scanned by ClamAV and
  sealed at rest; a blob that fails the scan is never served (B-2903).
- The firehose: a sequencer whose seq is taken in each commit's transaction, `com.atproto.sync.subscribeRepos` with
  cursors, a backfill window and sync 1.1 commit proofs, and `requestCrawl` to the relays in `PDS_RELAYS` (B-2904).
- Deactivation, takedowns as moderation actions on `pds-repo` objects (`RepoTakendown`, `!takedown` published by the
  tenant's labeler, appealable), and account migration into and out of Exprsn-AI with signed PLC operations (B-2905).
- Interop: `interop/run.ts` and the CI `interop` job run the PDS against the reference development environment's PLC
  directory and Bluesky AppView; a post written to Exprsn-AI's PDS appears in the AppView (B-2906).
- `app.bsky.feed.generator` records published to a hosted repo or an external account
  (`POST /api/admin/pds/feed-generators`), naming the feed generator's service DID (B-3004).
- Moderation gains `takeDown` and `reverse` for direct admin actions; self-registration takes an AT-Protocol invite
  code in place of an invitation.

### Model-based memory management (Sprint 30, B-3701 to B-3703)

- Per-tenant memory settings under `GET`/`PUT /api/memory/settings` (`knowledge:manage`, audited as
  `memory.settings.updated`). Migration `032c_memory` (`memory_settings`; `memories.superseded_by` and
  `memories.expiry_proposal`).
- A tenant `memory` profile extracts proposals from chat turns and, under an agent's memory policy, from succeeded
  agent runs (`memory.extract`). The text goes to the model as JSON data and its answer must be one JSON object that
  a zod schema accepts; with no profile, or when the model fails or answers anything else, the rules extract as before
  (`memory.extraction.fallback` records why). Every proposal still passes the `memory` checkpoint, the credential ban
  and the rejection list, and carries its source's label (B-3701).
- Consolidation (`memory.consolidate`, daily and `POST /api/memory/consolidate`): near-duplicates found by embedding
  similarity and confirmed by the profile become one merge proposal (keeping both sources); stale and contradicted
  memories get expiry proposals, decided with `POST /api/memory/{id}/expiry/accept|reject`. Nothing changes until a
  person accepts; accepting a merge activates the new memory and retires both (`superseded`, `supersededBy`, audited
  as `memory.merged`) (B-3702).
- The memory embedding model is a tenant setting (unset: the first approved embedding model by name, as before).
  Changing it starts `memory.reindex` (also `POST /api/memory/reindex`), which re-embeds every active memory; recall is
  by recency while it runs, and only vectors of the query's model are compared (B-3703).
- The event catalogue lists a `memory.*` group for the memory audit actions.

### CalDAV and CardDAV (Sprint 30, B-3101 to B-3104)

- New permissions `calendars:read`, `calendars:write`, `contacts:read` and `contacts:write` (members and tenant
  admins). Migration `032_dav`. Described in `docs/dav.md`.
- App passwords for DAV clients under `/api/me/app-passwords` (list, create, revoke): per device, shown once, with
  DAV-only scopes (`caldav`, `carddav`, `webdav`) and an optional expiry; creating one needs a second factor confirmed
  within the step-up window (a TOTP or passkey step-up now records the factor on the session); the list shows the last
  use. They authenticate `/dav` only (HTTP Basic over TLS) and are refused by `/api`, `/v1` and the console (B-3101).
- The WebDAV core at `/dav` with `/.well-known/caldav` and `/.well-known/carddav` discovery: PROPFIND, PROPPATCH (all
  or nothing; dead properties sealed), REPORT, ETags with `If-Match`, `If-None-Match` and the If header (a stale ETag is
  412), `sync-collection` (RFC 6578), strict XML parsing (no DOCTYPE or entities, size and depth caps), its own rate
  limit and failed-credential limits (B-3101).
- CalDAV over personal calendars (MKCALENDAR, validated objects stored sealed with indexed time spans) and the
  calendars of one's groups: `calendar-query` with every RFC 4791 filter operator, `calendar-multiget`,
  `free-busy-query`; answering a group event from a client (its `PARTSTAT`) is written back as the RSVP, and
  moderators' edits and cancellations go through the groups service (B-3102). The iCalendar writer of B-2504 renders
  organisers and attendees and a METHOD-less object form.
- CardDAV: the directory as a read-only address book filtered by clearance (a contact above the caller's clearance is
  never returned), and personal address books (extended MKCOL, vCard 3.0 and 4.0), `addressbook-query` with every RFC
  6352 operator and `addressbook-multiget` (B-3103).
- A conformance run of Apple Calendar and Contacts, Thunderbird and DAVx5 exchanges (`server/test/fixtures/dav/`),
  replayed by the test suite; it fails when a filter operator is not exercised (B-3104).
- B-3104 stays partial: the fixtures were written from the clients' documented requests. Capturing real traffic
  (B-3606) was dropped by the owner on 2026-10-06 (not needed); it had been held because macOS 27 Calendar refuses Basic authentication over plain HTTP, and capturing over TLS
  needs a per-host certificate trust on the capturing Mac that was not approved.

### Import repositories and model import (Sprint 30, B-3801 to B-3803)

- New permissions `imports:run`, `imports:repositories` and `imports:review`, and a fourteenth built-in role,
  `legal-review` (granted only by a system admin), which decides licence exceptions and keeps the tenant's licence
  allow-list; tenant admins can request exceptions but not decide them. Migration `033c_imports`.
- Repository registry under `/api/imports/repositories`: Hugging Face compatible hubs, Ollama compatible registries,
  CKAN, DCAT-AP, SDMX, OpenML, InvenioRDM, Kaggle and the signed bundle share. A repository is proposed by one admin
  and confirmed by another before its hosts join the staging-proxy allow-list and it is harvested; credentials are
  vault references sent only to the repository's own host; harvests run on a schedule and back off when the source
  rate-limits. `GET /api/imports/proxy-allowlist` exports the allow-list for the staging proxy (B-3801).
- Catalogue browse with classification, licence, format and other facets from each source's own taxonomy; a facet's
  count is exactly what its filter returns; live search through the proxy when the source can be searched, the
  snapshot otherwise and while a source backs off (B-3802).
- Model import: plan (every check, nothing written), gate acceptance with the recorded token, format and pickle checks
  by name and by content, digests pinned at request time and checked after resumable downloads, licence policy with
  exceptions, GGUF conversion or packaging on the training pool (`POST /v1/convert` gains `source`), draft registration
  with the digest pinned and a signed import manifest; air-gapped instances queue requests for the weekly bundle and
  continue them when a promoted bundle carries the files. The Imports queue with cancel and resumable retry; a 500 GB
  dataset import quota per tenant, metered beside model imports (B-3803).

### Permission matrices and custom roles (Sprint 29, B-3301 to B-3305)

- New permission `roles:manage` (tenant admins). Migration `031_access`.
- Role × permission matrix generated from the catalogue: `GET /api/authz/matrix` (JSON, or CSV with `?format=csv`),
  with the tenant's custom roles and the routes of each permission. `docs/permissions.md` is generated from the same
  source (`npm run docs:permissions`); the test suite fails when it differs from the catalogue (B-3301).
- Custom roles per tenant under `/api/authz/roles`: built only from catalogue permissions the creator holds (a tenant
  admin cannot create a role holding `platform:manage`), with `grantableBy` and `requiresMfa` as for built-in roles; a
  role holding an admin permission is under dual control; every version is kept with a diff and audited
  (`authz.role.*`). Custom roles resolve wherever built-in ones do: assignment, group mappings, invitations, CSV
  imports, `GET /api/me`, the policy, effective permissions and `explain`, whose role step now names the granting
  roles (B-3302).
- Effective-access matrix `GET /api/authz/access` (users and their API keys × workspaces × permissions after scopes,
  clearance and zone ceilings), `explain` for any cell and "who can" for one permission; every cell is
  `policy.explain`'s decision (B-3303).
- Route permission registry `server/src/authz/routes.ts`: every route declares its permission, and a route without one
  fails the test suite; `requireAnyPermission` replaces the routes' own any-of helpers (B-3304).
- Access reviews under `/api/authz/reviews`: scheduled and repeating certification campaigns over direct role grants
  and workspace memberships. Each grant is assigned to its admins (the tenant admins, and for a workspace membership
  also the workspace's members holding `roles:manage`) and to the member's directory manager, never to the member;
  the first decision stands. A revoke is gone on the member's next request and their sockets leave the rooms it gave;
  overdue campaigns escalate once to the tenant admins; every step is in the audit chain (`authz.review.*`, the
  `authz.reviews` job) (B-3305).
- LDAP stores read the user's manager (`managerAttribute`, default `manager`) and SQL user tables an optional
  `columns.manager`; sign-in and directory sync keep it on the user's identity (`user_identities.manager_ref`).

### Record queries PostgreSQL answers from an index (Sprint 29, B-3601)

- Low-code record pages sorted on a value field are read in order from that field's value index and stop at the
  page; the filter's top-level conditions on the same field are tested on the index row, the count starts from one
  condition's index rows, and records are reached by primary key, so the plans hold before PostgreSQL has statistics
  for a freshly loaded entity (the cause of the 1.4.0 load test's miss). Empty values sort last with `NULLS LAST` on
  PostgreSQL and text compares and sorts with `COLLATE "C"`, as its indexes are built. SQLite, MySQL and PostgreSQL
  return the same rows in the same order (`server/test/integration/apps.test.ts`, now also paged by cursor and by
  offset). Migration `031b_record_queries`: the value indexes gain the record id (on PostgreSQL collated and partial).
- Keyset paging: record listings and queries answer `nextCursor`; send it back as `cursor` for the next page.
  `offset` still works (not together with a cursor). The CSV export pages by cursor and counts once.
- Formula sorts put numbers before text on every dialect (PostgreSQL put text first when descending, SQLite and MySQL
  when ascending), and text range filters on `state` compare bytes on PostgreSQL too.
- Platform load test on PostgreSQL: records query p95 65 and 62 ms in two full runs (732 ms at release), every target
  met; 67 ms with autovacuum off. The records scenario reports each query body's p95 and signs in 128 users (64 hit
  the per-user API limit once queries got faster). `docs/loadtest.md`.

### MongoDB data connections (Sprint 30, B-3602)

- `engine: mongodb` on `POST /api/admin/connections`, merged from `feat/mongodb-connections`. Reads are `find` and
  `aggregate` only, written as JSON; writes, DDL, `$out`, `$merge`, server-side JavaScript (`$where`, `$function`,
  `$accumulator`, Code values, `mapReduce`) and stages off a read-only list are refused before anything is sent and
  checked again in the driver. Collections read through `$lookup`, `$graphLookup` and `$unionWith` must be on the
  allow-list (names or patterns such as `orders_*`); `system.*` and other databases are refused. Reads use the
  connection's row limit (plus one, to report capping) and timeout (`maxTimeMS`), mask personal fields inside
  sub-documents too, and are audited as for the other engines.
- One direct connection to the checked address (no replica-set discovery or SRV), no retries, credentials as options
  (sealed, or a `vault:` reference). The account authenticates against the connection's database unless the
  username is `<authdb>/<user>`. Test connection reports an account with write privileges, or a server without
  authentication, as `degraded`. OpenBao dynamic credentials stay PostgreSQL and MySQL only (`409`).
- Collections as knowledge sources (`kind: database`): `fields` to index (by default the text fields of the sampled
  schema), `idColumn` (`_id`), a watermark field (`updatedAt` or `updated_at` when sampled), and an access field as for
  B-1002. No migration; the metadata is tested on SQLite, PostgreSQL and MySQL (`TEST_MONGODB_URL` gates the
  real-server test; CI runs a `mongo:8` service).
- Dependency: the official `mongodb` driver 7.7.0 (pinned).

## 1.4.0

### AT-Protocol firehose ingest (Sprint 27, B-1908)

- AT-Protocol firehose ingest (B-1908, Sprint 27): per-tenant subscriptions to a Jetstream or a relay's
  `com.atproto.sync.subscribeRepos` under `/api/atproto/firehose` (new permission `firehose:manage`, held by tenant and
  guardrail admins), with collection and author allow-lists and deterministic sampling. Posts go through the
  moderation check and their verdicts become flags and signed labels from the tenant's labeler. Each consumer runs on
  one worker instance through a lease, stores its cursor periodically and at shutdown and resumes from it after a
  restart, pauses its socket when its queue is full, and reconnects with backoff. Migration `029b_firehose`; settings
  `FIREHOSE_*`; metrics `exprsn_firehose_*`; audit actions `atproto.firehose.*`.

### Low-code data apps (Sprint 27, B-2201 to B-2208)

- Apps per tenant or workspace with entities of typed fields (string, number, boolean, date, enum, reference, lookup,
  file, JSON, formula, AI), validation and uniqueness; a duplicate unique value is refused on SQLite, PostgreSQL and
  MySQL (`server/test/integration/apps.test.ts`). New permissions `apps:design` (workflow and tenant admins),
  `records:read` and `records:write` (members and tenant admins). Migration `029_apps`.
- Records sealed with the tenant key, with CRUD, filters, sorts, search, pagination, aggregation, all-or-nothing bulk
  writes, and CSV import and export as jobs. Fields a designer marks `indexed` are also kept in a normalised clear
  index, so the same filter returns the same rows in the same order on all three databases; the choice and what it
  exposes are in `docs/security.md`.
- Lookups (static, entity, user, workspace) and formula fields from a parser that walks a tree (no `eval`, no
  property access, a fixed list of functions), so a formula cannot reach a global.
- A state machine per entity: illegal transitions are refused, transitions are audited and emitted as
  `record.transitioned`. The `record.*` events are now emitted (catalogue version 3).
- Forms with conditional fields; public forms (a link token, at `/api/public/forms`) keep only the fields they list
  and show, are rate-limited per address and per form, and pass the `user-input` guardrail.
- Record-event and schedule triggers start published workflows as their owner, and workflows have a `record` step that
  creates, updates or moves records; chains stop at `APPS_TRIGGER_MAX_DEPTH`.
- AI fields filled from a profile prompt by a job, failing soft (a model error leaves the field empty and the record
  saved), and natural-language drafts of entities and workflows from a local model, validated and never saved.
- Apps export and import as bundles signed with a KMS HMAC key; a tampered bundle is refused. Records are moderation
  objects.

### Groups and events (Sprint 27, B-2501 to B-2505)

- Groups inside a workspace (`/api/groups`): public, private or hidden; open, request or invitation-only joining;
  join requests and invitations that expire (`GROUP_REQUEST_DAYS`, `GROUP_INVITE_DAYS`); owner, moderator and member
  roles. Workspace membership is the outer boundary: a user outside the workspace cannot see, join or be invited to
  its groups. New permissions `groups:read` and `groups:write` (members) and `groups:manage` (tenant admins).
- Group events with IANA time zones (stored as UTC plus the zone), RSVPs with guests and capacity, attendee lists and
  check-in. Cancelling an event notifies every attendee in the console and by email (the new `event-notice` template).
- Reminders as `calendar.reminder` queue jobs at their time, sent in the console and by email, once across instances.
- Signed iCalendar feeds per event, group and user at `/calendar/feeds/<id>/<signature>.ics` (RFC 5545, HMAC with a
  derived key, revocable); events above `CALENDAR_FEED_MAX_LABEL` show as busy time.
- Group posts (sealed, screened at `user-input`) and group, post and event moderation through the moderation API:
  a report on a group post makes a flag in the workspace queue, and moderators see their group's cases.
- The `group` realtime room kind; catalogue version 3 emits `group.*` events (members, posts, events).
- Migration `029c_groups`; new settings `GROUP_INVITE_DAYS`, `GROUP_REQUEST_DAYS`, `CALENDAR_FEED_PER_MINUTE`,
  `CALENDAR_FEED_MAX_LABEL`.

### Customer-service channels and email one-time codes (Sprint 28, B-2301 to B-2304, B-1806)

- Chat channels (B-2301): a channel in a workspace answers customers with a published profile or agent (prompt and
  profile; never its tools) at the channel's label, checked against the workspace ceiling and the profile's and agent's
  labels when saved and enforced by the gateway's pool ceilings when answering. Customers use the public endpoints at
  `/api/public/channels` anonymously or with an identity assertion the channel's site signs (an identified customer
  resumes their open session), with a session token scoped to one session, and rate limits per address and per session.
  Every customer message passes `user-input` and every answer `model-output`; a model failure tells the customer a
  person will follow up and escalates the session. New permissions `channels:manage` (tenant admins) and
  `channels:review` (tenant and guardrail admins, flag reviewers). Migration `030_channels`.
- Held replies (B-2302): answers wait for a reviewer when the channel reviews every answer, when it reviews escalated
  sessions (the default) and the customer asked for a person, or when a guardrail requires approval. Each is a `hold`
  flag; a reviewer approves, edits or rejects it (`/api/channels/held`, or approve and reject in the flag queue), and
  only then does the customer receive it, as edited (the model's text is kept as the original).
- Email channels (B-2303): inbound by IMAP polling (one `channels.imap-poll` job per channel per tick, read-only,
  with a UID cursor) and by signed webhooks (a generic JSON shape with an HMAC header per channel, and Mailgun routes
  and events); threaded into sessions by Message-ID together with the sender's address; answers from an outbox of
  `channels.send` jobs over the channel's SMTP server or `SMTP_URL`, with `In-Reply-To`, `References` and
  `Auto-Submitted`; bounces from delivery reports and provider events recorded once and marked on the outbox. Mail
  credentials are vault references. New dependencies: `imapflow` and `mailparser` (and `@types/mailparser`).
- Retention and exports (B-2304): per-channel retention in days with a `channels.retention` purge job; transcripts as
  CSV per session, or a whole channel through a `channels.export` job sealed in the blob store.
- Channel sessions and messages are moderation object types (`channel-session`, `channel-message`). Event catalogue
  version 4: `channel.*` events are emitted. Settings `CHANNELS_*`.
- Email one-time codes as a second factor (B-1806): enrol the account's address with a code
  (`POST /api/me/mfa/email`), then `POST /api/auth/mfa/email/send` and `POST /api/auth/mfa/email` at sign-in. Codes
  are HMAC-stored, single use, bound to the pending session, sent at most `MFA_EMAIL_SENDS_PER_HOUR` times an hour,
  and wrong codes count in the same lockout as TOTP codes: a sixth wrong code is refused like a sixth wrong TOTP code.

### Social relations and messaging (Sprint 28, B-2601 to B-2606)

- Social relations shared by messaging and the workspace feed (`/api/social`, `server/src/social/`): blocks that work
  in both directions and end follows both ways, private mutes that may expire, follows and lists inside the workspaces
  two people share, and a contact rule per user (everyone in my workspaces, people I follow, or nobody). A block
  refuses with the same words as a contact rule, so the blocked person is not told. Room events raised through
  `SocialService.emitToRoom` leave out everyone in a block with the actor on every instance (the platform's BUG-080).
  New permissions `social:read` and `social:write` (members and tenant admins) and `social:manage` (tenant admins, an
  audited view of anyone's relations); audit actions `social.*`; catalogue version 4. Migration `030b_social`.
- Person-to-person messaging (`/api/messaging`, `server/src/messaging/`), sealed at rest with the tenant key (no
  end-to-end encryption, so search and summaries work). Direct conversations, one per pair even when both start one at
  once, and group conversations in a workspace with owner, admin and member roles; workspace membership stays the
  outer boundary. New permissions `messages:read` and `messages:write` (members and tenant admins).
- Send, edit, delete, reply, threads, reactions, pins and forwarding; edits and deletes are audited without the text,
  and a deleted message keeps only a tombstone. The `message.sent`, `message.edited` and `message.deleted` catalogue
  events are now emitted; audit actions `messaging.*`. Messages are a moderation object type (`dm-message`).
- Delivery and read receipts, typing and presence in the `conversation` realtime room, through the new `room.signal`
  client message and room presence hooks; every event from a person leaves out the people in a block with them, on
  the socket as well as in the API.
- Attachments from the file store once they passed its quarantine; a mute and a notification rule (all, mentions,
  none) per conversation: a muted conversation sends no notification.
- Keyword search (keyed-hash terms) and semantic search (`MESSAGING_EMBED_MODEL`, by job) in a conversation; thread
  summaries and catch-up digests from a profile, citing only messages the reader can see.
- New settings `MESSAGING_MAX_MEMBERS`, `MESSAGING_EMBED_MODEL`, `MESSAGING_SUMMARY_PROFILE`,
  `MESSAGING_SUMMARY_MAX_MESSAGES`, `ROOM_SIGNALS_PER_MINUTE`; the messaging tables are in migration `030b_social`.

### Workspace feed (Sprint 28, B-2701 to B-2705)

- A feed for a workspace or a group (`/api/feed`, `server/src/feed/`): posts with media from the file store (only
  files that passed quarantine; they raise the post's label), threaded comments, reactions, plain and quoted reposts
  that stay in the original's workspace and group, and bookmarks. Bodies, comments and digest summaries are sealed
  with the tenant key. A comment, reaction or repost on a deleted post is refused (`409`). New permissions
  `feed:read` and `feed:write` (members and tenant admins) and `feed:manage` (tenant admins); audit actions `feed.*`.
  Migration `030c_feed`.
- Home (the caller and the people they follow), workspace, group, user, list, hashtag and bookmark feeds with cursor
  pagination. The relations are the shared ones of `/api/social`: a muted author leaves the home feed; a block,
  either way, hides posts, comments and reposted originals in every feed and refuses comments, reactions and reposts.
- Realtime: the `feed` room kind (a workspace, a group, or one's own home room). A new post reaches open feeds without
  a reload, as ids only, leaving out people below its label and everyone in a block with the author; followers' home
  rooms get it up to `FEED_HOME_FANOUT_MAX`.
- Posts pass the `user-input` guardrail checkpoint before publishing: a held post waits in the Flags queue (a `hold`
  flag), invisible to everyone but its author until a reviewer approves it, and stays invisible when rejected. Posts
  and comments are moderation object types (`feed-post`, `feed-comment`). The `post.*` catalogue events are now
  emitted (catalogue version 5, with the `feed.*` group for the audit actions).
- Hashtags extracted at publishing and counted by the `feed.trending` job per workspace and label (a reader sees only
  what their clearance reaches); a weekly workspace digest (`feed.digest`) of the week's top posts, ranked by
  reactions, comments and reposts and summarised by a profile through the gateway, with per-workspace settings.
  Settings `FEED_*`.
- Group feeds are feed posts targeted at the group; the group notices of Sprint 27 (`/api/groups/:id/posts`) stay as
  they are.

### Load test of the event and data paths (Sprint 28, B-2105)

- `server/loadtest/platform.ts` (`npm run loadtest:platform`): webhook fan-out with a hanging endpoint, low-code record
  writes and queries, OCSP (signed and cached) and firehose ingest from a fake Jetstream with a dropped connection and
  a restart, against the application in its own process with the signer as a process, on SQLite or an empty
  PostgreSQL or MySQL database. Targets, the reference setup and the measured results are in `docs/loadtest.md`; CI
  runs the scenarios with the looser `ci` targets next to the streaming load test. `npm run loadtest` runs the
  streaming load test.
- Fixed: the database job queue (`JOB_QUEUE=db`) waited for its whole batch at every poll, so it ran at most
  `JOB_CONCURRENCY` jobs per `JOB_POLL_MS` and one slow job held the other slots idle (webhooks measured 2.9 deliveries
  a second with p95 21.7 s). It now fills a slot as soon as a job finishes and starts a job queued on the worker at
  once when a slot is free (100 deliveries a second, p95 under 10 ms on the reference setup).
- Fixed: webhook attempts failing at the same time each wrote the failure count they had read, so the breaker opened
  late, could be closed again by a stale failure, and announced its opening more than once. The count now goes up in
  the database and only the attempt that changes the breaker's state announces it. While its breaker is still closed,
  an endpoint whose last attempt failed gets at most half the job slots of an instance, so it cannot starve the
  other endpoints.

## Unreleased

### Fixed

- Registry tool schemas are checked and validated in the JSON Schema dialect they declare with `$schema`: draft-07
  (the default), 2019-09 or 2020-12. MCP servers such as Context7 send 2020-12 schemas, which failed before. An
  unknown dialect is reported as a schema problem.
- `OLLAMA_LOAD_TIMEOUT_MS` (default 5 minutes, as before) sets how long chat and embedding requests wait for Ollama's
  first response, which includes a cold model load. Raise it for large models on slow storage.
## Unreleased

### Fixes

- A workspace whose ceiling is `public` could not start a conversation: when no label was given, a new conversation
  (and compare, and `/v1` without `X-Data-Label`) was always `internal`, which is above that ceiling, so every message
  was refused with "Label above this profile ... Pick a profile cleared for this label", which no profile could fix.
  The default is now `internal`, or the workspace's ceiling when that is lower. When the workspace ceiling is what
  refuses a message, the problem carries `ceiling: workspace` and the console says so. Test in `chat.test.ts` (fails
  on the old code with the same 403).

## 1.3.2

Follow-ups from reviewing 1.3.1 and its CI run.

### Fixes

- Shared rate limits: 1.3.1 made a hit wait up to 250 ms for Redis's first connection, but only "until Redis has
  answered once", so with Redis unreachable from the start every API request would have waited 250 ms for as long as
  it stayed down. The wait now applies only in the first five seconds after start; after that a hit falls back to
  memory at once, as during any outage. Test: `ratelimit-connect.test.ts` (fails without the fix: five hits took
  1.25 s).
- Console suite: the dialog and drawer reflow check (B-1507) gave up on a screen whose controls had not rendered yet
  and then reported it as "no dialog opened" (Platform, on a loaded CI runner). It now waits up to five seconds for a
  screen's controls before concluding it has none.

## 1.3.1

CI on `main` had been red since the pre-1.0 review fixes: the integration and load-test jobs failed on every run. The
unit suite and the console suite were green throughout, which is why it went unnoticed.

### Fixes

- SQL user stores (PostgreSQL, MySQL) could not connect at all since 1.2.0. The per-connection host check of B-809 used
  Knex's `expirationChecker`, which made the pool re-resolve its settings on every acquire and never hand out a
  connection. The check now runs inside the stream the driver asks for, once for each new connection, and dials the
  address that check returned, so the DNS-rebinding protection of B-809 is unchanged.
- Shared rate limits (B-406) never shared anything for a fresh connection: the Redis client refuses commands until it
  is connected (its offline queue is off so that an outage falls back at once), so each instance counted its first
  requests, and a new counter store all of them, in memory. Until Redis has answered once, a hit now waits up to
  250 ms for it; outages still fall back to memory at once.
- The OpenLDAP integration tests set their own secret-reference policy (`SECRET_REF_ENV` from the pre-1.0 review
  refuses every reference until one exists).
- The CI load test's fake answers now end a sentence every 12 words. Since 1.1.0 output is screened a sentence at a
  time, and fake answers with no sentence end were only released at the 240-character fallback, so the job measured
  the fake text rather than the platform (p95 time to first token 465 ms without sentence ends, 120 ms with, measured
  in-process with the CI settings; the 500 ms budget is unchanged).

## 1.3.0

Sprints 20 to 23: the [1.3.0 backlog](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.3.0.md), which keeps key material out of the application, adds the
operational features a production install still lacked (tracing, dashboards and alerts, safe upgrades, key escrow) and
deepens AI, knowledge and integrations. This release line starts from `main` with 1.2.0 and the dependency fixes (PR
#20: otplib 13 through `server/src/identity/totp.ts`, `@types/node` 26, TypeScript 7). Sprint details are in
[Sprints.md](Sprints.md); the remaining gaps are in [docs/security.md](docs/security.md), [docs/asvs.md](docs/asvs.md)
(now 56 groups met, 8 partly, 7 not applicable) and [docs/accessibility.md](docs/accessibility.md).

### Keys and supply chain
- An optional signer process (`exprsn-ai signer`, `SIGNER_SOCKET`) holds the local key-encryption key and every OIDC,
  SAML, SAML SP decryption and webhook private key, and signs and decrypts over a token-checked UNIX socket; with it the
  application holds no private key and no key-encryption key. A systemd unit (`deploy/baremetal/exprsn-signer.service`)
  and a Helm sidecar (`signer.*`) run it as its own user.
- Webhook Ed25519 keys are made and used in OpenBao transit or the signer; keys sealed before stay published.
- HTTP Message Signatures (RFC 9421, with RFC 9530 `Content-Digest`): an API key may register an Ed25519 public key,
  after which `/v1` accepts only signed requests from it; webhooks can add RFC 9421 signatures (HMAC-SHA256 or
  Ed25519).
- Production refuses `DATA_KEY`, `DATA_KEY_PREVIOUS` and `SIGNER_TOKEN` given inline in the environment; with the
  signer it refuses `DATA_KEY` from any source.
- CI runs `npm audit signatures`; on `main` and `v*` tags it pushes the image to GHCR with a SLSA build provenance
  attestation and a keyless cosign signature, verifies both, and attaches the SBOMs to the release. These steps were
  validated with actionlint and a YAML parse only and have not yet run on GitHub; they assume the image is
  `ghcr.io/<owner>/<repo>`.

### AI
- A `/v1` request sent with an API key that `require-approval` stops answers `202` with a held-request id; another
  reviewer approves it in Flags and the client fetches the answer from `GET /v1/held/:id`. Compare holds the prompt and
  every column.
- `POST /v1/responses` and `GET /v1/responses/:id`: a documented subset of the Responses API with streaming events and
  function tools; `store: true` (off by default) saves the exchange to Chat, and `previous_response_id` continues it.
- Evaluations per profile (contains, regex, JSON schema, a judge rubric), scored per profile version; a profile version
  whose gated eval sets do not pass cannot be published unless a second profile admin approves an override. The
  Profiles screen gains an Evaluations tab.
- The full `model-output` check covers thinking as well as the answer.
- A reader removed from a shared workspace (by an admin, a group mapping or directory sync) loses an open watch at once.
- Scheduled agent runs: UTC cron schedules on agents, run as the owner with their current roles, with a run history;
  each due time runs once across instances.

### Operations
- OpenTelemetry tracing over OTLP/HTTP (`OTEL_EXPORTER_OTLP_ENDPOINT`) for requests, jobs, Ollama calls, guardrail
  checks and database queries, with an attribute allow-list and no tenant content.
- Prometheus recording and alert rules with promtool unit tests, and overview and operations Grafana dashboards, in
  `deploy/observability/`; the alerts runbook is [docs/runbooks/alerts.md](docs/runbooks/alerts.md).
- `migrate --check` lists pending migrations and their destructive steps. An instance older than the database schema
  stops taking jobs, reports not ready (`/readyz` 503 with `checks.schema`) and refuses to start. Migrations follow an
  expand/contract rule, linted by a test.
- `kms:escrow` splits the local key-encryption key into k-of-n Shamir shares (`--key-file` takes the signer's key file),
  and `kms:recover` rebuilds it into a new 0600 file.
- `ZONES_APPLY=kubernetes` applies each zone's NetworkPolicy with server-side apply and reports drift.
- `NTP_SERVER` takes several servers; the reported skew is their median, with outliers named.
- A Redis outage that leaves rate limits counting per instance shows on Platform and as the
  `exprsn_ratelimit_degraded` metric and alert.

### Knowledge and integrations
- S3-compatible bucket sources with their own endpoint and sealed keys, include patterns and ETag change detection.
- An internal web crawler: same origin, robots.txt and sitemaps, depth and page limits, conditional re-fetch.
- PostgreSQL row security for database sources: reads run as a mapped database role per group.
- Ordered webhook delivery across instances, with a position counter and a delivery lease per endpoint.
- Price book versions prorate mid-month price changes; Stripe refunds, credit notes and disputes are reconciled.

### Accessibility
- axe-core 4.13.0 runs beside the in-page checker on every screen and design state, sign-in and a streaming chat, in
  Standard and Enhanced (with AAA contrast), light and dark; any violation fails the suite.
- Dialogs and drawers are checked for reflow at 320 and 640 px.
- Fixed: a Profiles hint link below the 24 px target size, the unlabelled workflow picker on Workflows, and a long
  breadcrumb that pushed the page sideways at 640 px and below.

### Testing
- 532 unit and API tests (1 skipped) across 42 files, with new suites `sprint20.test.ts`, `sprint21.test.ts`,
  `sprint22-ops.test.ts`, `sprint23-knowledge.test.ts` and `sprint23-integrations.test.ts`, and fakes for an OTLP
  collector, the Kubernetes API, SNTP and Redis (`sprint22-fakes.ts`) and for an S3 bucket and a web site
  (`sprint23-fakes.ts`).
- `integration/rls.test.ts` (row security by role) and `integration/webhooks.test.ts` (ordered delivery across
  instances) against PostgreSQL.
- 57 Playwright tests, with axe-core in `y-accessibility.spec.ts` and the new `y-reflow-overlays.spec.ts`.
- A CI job checks and unit-tests the Prometheus rules with promtool.

### Upgrade notes
- Migrations `022_keys` to `025_integrations3` run on start (`DB_MIGRATE_ON_START`) or with `exprsn-ai migrate`.
- Production refuses `DATA_KEY`, `DATA_KEY_PREVIOUS` and `SIGNER_TOKEN` given inline in the environment. Give them as
  files (`DATA_KEY_FILE`, `DATA_KEY_PREVIOUS_FILE`, `SIGNER_TOKEN_FILE`) before upgrading.
- The signer is optional. To use it, run `exprsn-ai signer` as its own user with the old `DATA_KEY` as its key file (no
  re-wrap is needed), then remove `DATA_KEY` and `DATA_KEY_FILE` from the application and set `SIGNER_SOCKET` and
  `SIGNER_TOKEN_FILE`: on bare metal with `deploy/baremetal/exprsn-signer.service` and the commented lines in
  `exprsn-ai.service`, in Kubernetes with the chart's `signer.enabled`. Turning it on replaces the federation signing
  keys: SAML service providers re-import the IdP metadata.
- An instance whose build is older than the database schema now stops taking jobs and reports not ready. For a rolling
  upgrade, run `exprsn-ai migrate --check` first: expand-only migrations (all of 1.3.0's) keep the previous release
  working while instances are replaced; a contract step needs every old instance stopped first
  ([docs/runbooks/upgrade.md](docs/runbooks/upgrade.md)).
- Publishing a profile version that has gated eval sets now answers `409 eval_gate` until they pass or a second profile
  admin approves an override. Profiles without gated sets publish as before.
- New settings, all optional with safe defaults: signer and signatures (`SIGNER_SOCKET`, `SIGNER_TOKEN_FILE`,
  `SIGNER_TIMEOUT_MS`, `HTTP_SIGNATURE_MAX_AGE_SECONDS`; in the signer `SIGNER_KEY_FILE`, `SIGNER_SOCKET_MODE`,
  `SIGNER_ALLOW_GROUP_READ`), scheduled agents (`AGENT_SCHEDULE_TICK_SECONDS`), tracing (`OTEL_EXPORTER_OTLP_*`,
  `OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLE_RATIO`, `OTEL_BSP_*`), upgrades (`SCHEMA_CHECK_SECONDS`), zones
  (`ZONES_APPLY`, `ZONES_APPLY_*`), time and rate limits (`NTP_OUTLIER_MS`, `RATELIMIT_PROBE_SECONDS`; `NTP_SERVER`
  takes a list) and knowledge (`KNOWLEDGE_ALLOWED_HOSTS`, `KNOWLEDGE_FETCH_TIMEOUT_MS`). See
  [docs/deploy.md](docs/deploy.md).
- The e2e package adds `axe-core` to its devDependencies; run `npm ci` in `e2e/` again.
- No new permissions.

## 1.2.0

Sprints 16 to 19: the [1.2.0 backlog](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.2.0.md), which closes most of the known gaps and ASVS follow-ups left
after 1.1.0 and deepens chat, knowledge and integrations. Sprint details are in [Sprints.md](Sprints.md); the remaining
gaps are in [docs/security.md](docs/security.md), [docs/asvs.md](docs/asvs.md) (now 54 groups met, 10 partly, 7 not
applicable) and [docs/accessibility.md](docs/accessibility.md).

### Chat and AI
- `/v1` takes chat's knowledge and memory context on request (`X-Exprsn-Knowledge`, `X-Exprsn-Memory`) under chat's
  clearance rules, with citations in an `exprsn` extension field, and runs the profile's read-only tools on the server
  (`X-Exprsn-Tools: profile`); each header needs its own permission or scope.
- The guard model and classifiers check streamed answers in the background; with a hold-back
  (`CHAT_GUARD_HOLDBACK_SENTENCES`, 1) a sentence is shown only once a clean verdict covers it. Tool results shown in
  chat pass the stream screen.
- `require-approval` on `user-input` holds the prompt in the Flags queue until a reviewer approves or rejects it.
- Readers of a shared conversation watch answers stream, and lose them at once on revocation.
- Anonymous share links, off per tenant by default, for conversations labelled `public` only, expiring,
  rate-limited and audited, opened on a signed-out page.
- Retention per workspace and per user; the shortest applicable period wins.
- Prompt templates pass the `user-input` guardrail checkpoint when saved and published.

### Identity and security
- A sign-in from a new browser or a new network sends a security notice (`SIGNIN_NOTICES`, on by default).
- A password strength meter on every password form; Platform warns while the breached-password check is off.
- Re-authenticating at an upstream OIDC or SAML IdP counts as step-up.
- Admin password reset revokes the account's API keys unless the option is unticked.
- Optional DPoP nonces (`DPOP_NONCES`) and `API_PUBLIC_URL` for proofs behind a proxy prefix.
- Resource servers may introspect any client's token after a second identity admin approves.
- SAML: optional whole-response signing; SP and IdP metadata fetched by URL, refreshed daily, with certificate and
  endpoint changes held for approval.
- Console sign-out runs front-channel logout; SQL user stores dial the checked address.
- `admin:create --enrol-link` gives the first admin a single-use link that sets the password and enrols a factor.
- Operator-chosen service URLs (pool instances, zone endpoints, image backends, the trainer) refuse metadata,
  link-local and unspecified addresses when saved and at every connection (`SERVICE_ALLOWED_HOSTS`,
  `SERVICE_INTERNAL_ONLY`).
- `REQUIRE_BACKEND_TLS` refuses plaintext PostgreSQL, MySQL, Redis, S3 and OpenBao links in production (off by
  default; `BACKEND_TLS_EXEMPT` per link).
- YAML size, depth, node and alias caps; secrets masked in diagnostics and problem details.
- Training data leaves the platform sealed with a per-run key (worker contract 2); checkpoints and GGUF files come back
  sealed under the tenant key.
- `kms:rewrap` also re-signs image provenance and training model cards.

### Accessibility
- The Playwright suite checks every screen and design state, sign-in and a streaming chat, light and dark, against an
  in-page checker modelled on axe-core's WCAG A/AA rules (Standard mode).
- No two-dimensional scrolling at 320 and 640 px; wide tables scroll in a named, keyboard-reachable region.
- One tab panel per tab list; faint text at 4.5:1 or more; no nested buttons in Pools rows; Media caption contrast.

### Platform and operations
- Backups read one snapshot, and the blob archive holds exactly the objects it names.
- ACME external account binding, RFC 2136 over TCP with fallback and SOA zone discovery, and push hooks per
  certificate (named reload commands or signed webhooks).
- MCP servers and connections outside their zone are listed with a move proposal under dual control.
- Promoted artefacts are pushed to Harbor, Verdaccio and devpi.
- `API_RATE_PER_MINUTE` sets the `/api` limit per user (600 by default).

### Knowledge and integrations
- MySQL tables and views as knowledge sources.
- Row-level access for database knowledge sources from an access column, enforced at retrieval.
- PostgreSQL logical replication for knowledge sources (`KNOWLEDGE_REPLICATION`), falling back to watermarks.
- Ordered webhook delivery per endpoint, and Ed25519 signatures with a per-tenant key published as a JWKS.
- Per-tenant price books, currency and taxes; a signed Stripe webhook marks statements paid, failed or void
  (`STRIPE_WEBHOOK_SECRET`).
- A paused workflow tool gives an agent run a pending result it awaits; approval timeouts per step; run events reach
  approvers live.
- `IMAGE_SAFETY_REQUIRED` withholds images no classifier checked; `SCRIPT_RUNTIME=runsc` runs scripts under gVisor.

### Testing
- 477 unit and API tests (1 skipped) across 37 files, with new suites `sprint16.test.ts`, `sprint17.test.ts`,
  `sprint18.test.ts`, `sprint19-knowledge.test.ts`, `sprint19-integrations.test.ts` and `sprint19-workflows.test.ts`,
  and fakes for Harbor, Verdaccio and devpi (`sprint18-fakes.ts`).
- `integration/replication.test.ts`: logical replication against PostgreSQL with `wal_level=logical`.
- 55 Playwright tests, with new specs `shared.spec.ts`, `password-meter.spec.ts`, `y-accessibility.spec.ts` and
  `y-reflow.spec.ts`.
- A flake in `memory.test.ts`, where a random sealed value could contain the searched substring, is fixed.

### Dependencies

- Builds on the dependency updates merged into `main` after 1.1.0: TypeScript 7, `@types/node` 26, otplib 13,
  undici 8, and the PostgreSQL 18, Redis 8 and MySQL 9.6 images. otplib 13 drops the `authenticator` API; TOTP now
  goes through `server/src/identity/totp.ts` (the same SHA-1, six-digit, 30-second codes with one step of drift, so
  enrolled authenticators keep working; checked against the RFC 6238 vectors). `@types/node` 26 keeps the JWK type
  under `crypto.webcrypto`.

### Upgrade notes
- Migrations `018_chat_depth` to `021_integrations2` run on start (`DB_MIGRATE_ON_START`) or with `exprsn-ai migrate`.
- The training worker must speak contract 2 ([docs/training-worker.md](docs/training-worker.md)). A contract-1 worker
  is refused unless `TRAINER_PLAINTEXT_FALLBACK=true`, which sends rows in plaintext as before.
- The integration tests need PostgreSQL with `wal_level=logical`; CI sets it with `ALTER SYSTEM` and a restart. Add the
  same step to other pipelines that run `npm run test:integration` against PostgreSQL.
- The `/api` rate limit is now `API_RATE_PER_MINUTE` (600 a minute per user, or per address when signed out, as
  before); raise it for automation that makes many console requests.
- Admin password reset now revokes the account's API keys by default; untick the option to keep them.
- New-sign-in notices are on by default (`SIGNIN_NOTICES=true`). Each account's first sign-in after the upgrade only
  records its browser and network; a later sign-in from another browser or network sends a notice. Set it to `false`
  to turn them off.
- New settings, all optional with safe defaults: chat (`CHAT_GUARD_HOLDBACK_SENTENCES`, `CHAT_GUARD_STREAM_CONCURRENCY`,
  `SHARE_ANONYMOUS_PER_MINUTE`), identity (`SIGNIN_NOTICES`, `DPOP_NONCES`, `DPOP_NONCE_SECONDS`, `API_PUBLIC_URL`,
  `FEDERATION_METADATA_REFRESH_HOURS`), outbound and backend links (`SERVICE_ALLOWED_HOSTS`, `SERVICE_INTERNAL_ONLY`,
  `REQUIRE_BACKEND_TLS`, `BACKEND_TLS_EXEMPT`), ACME (`ACME_EAB_KID`, `ACME_EAB_HMAC_KEY`,
  `ACME_DNS_RFC2136_TRANSPORT`, `ACME_RELOAD_COMMANDS`, `ACME_HOOK_TIMEOUT_MS`; `ACME_DNS_RFC2136_ZONE` is now
  optional), training (`TRAINER_*`), knowledge (`KNOWLEDGE_REPLICATION`, `KNOWLEDGE_REPLICATION_TICK_MS`), billing
  (`STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_TOLERANCE_SECONDS`), `IMAGE_SAFETY_REQUIRED`, `SCRIPT_RUNTIME` and
  `API_RATE_PER_MINUTE`. See [docs/deploy.md](docs/deploy.md).
- No new permissions.

## 1.1.0

Sprints 11 to 15: the [1.1.0 backlog](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.1.0.md), which closes most of the known gaps and ASVS follow-ups of
the release candidate and adds the platform features the 1.0 review found missing. Sprint details are in
[Sprints.md](Sprints.md); the remaining gaps are in [docs/security.md](docs/security.md), [docs/asvs.md](docs/asvs.md)
(now 50 groups met, 14 partly, 7 not applicable) and [docs/accessibility.md](docs/accessibility.md).

### Account and security
- Password change for local accounts in Settings: the current password is required, reuse is refused, and every other
  session and OAuth grant ends.
- Admin password reset (a temporary password or an emailed single-use link) and email invitations; admin-set and reset
  passwords must be changed at the next sign-in, after the second factor.
- Password reset by email from the sign-in screen: the same answer whether or not the account exists, a single-use
  token stored as a digest, throttled; a reset ends sessions and grants and lifts a lockout.
- Breached-password check against the HIBP range API (only a five-character prefix leaves) or an offline file
  (`BREACHED_PASSWORDS`, off by default).
- Step-up re-authentication for creating API keys, removing factors and regenerating recovery codes
  (`STEPUP_WINDOW_SECONDS`).
- Security notices in the console and by email for password, factor, recovery-code, API-key, session and grant
  changes and admin resets; plain-text and HTML email templates with every value escaped.

### Chat
- Output guardrails while an answer streams: text is released a sentence at a time, after the deterministic
  `model-output` rules have screened it; a block stops the model.
- `require-approval` on an answer holds it for review in the Flags queue until a reviewer approves or rejects it.
- Resumable streams across instances: a client catches up from any instance, and an interrupted answer can be
  continued.
- Agent memory write-back through the memory checkpoint, under each agent's memory policy.
- Citations keep the quoted passage; Sources show it within the reader's clearance.
- Conversation retention per tenant, purged by the `chat.retention` job and audited.

### Integrations
- OpenAI-compatible API at `/v1` (models, chat completions with streaming and tools, embeddings) with the same
  profiles, clearance, quotas, guardrails and metering as chat; OAuth tokens scoped `inference:invoke:<profile>` are
  bound to those profiles.
- Signed webhooks for audit actions, job states, flags and approvals, delivered as jobs with retries and a
  per-endpoint breaker, with a delivery log and replay; per-tenant allowed hosts for webhooks and workflow HTTP steps.
- Prompt library of versioned templates with variables, per workspace or tenant, with a picker in chat.
- Read-only conversation sharing with a person, a workspace or an expiring link; Markdown and JSON conversation export.
- Billing: price books, monthly statements from the usage meter, CSV and JSON export, and an optional Stripe invoice
  push.

### Federation
- Connected applications in Settings: users see and remove the applications they allowed.
- Access-token revocation (RFC 7009) through a shared deny-list, and introspection (RFC 7662).
- RP-initiated, front-channel and back-channel logout; `prompt=login` and `max_age`.
- Pushed authorization requests and signed request objects; DPoP sender-constrained tokens.
- SAML single logout in both directions, and encrypted assertions (AES-GCM with RSA-OAEP).
- With OpenBao, OIDC and SAML signing in transit, so no private signing key is in the process.

### Operations
- Rate limits, a throttle on failed bearer credentials (20 a minute per address) and the denial cap share one atomic
  Redis counter across instances.
- `kms:rewrap` moves every data key, checkpoint signature and backup to a new `DATA_KEY` or KMS.
- ACME dns-01 through a signed webhook or RFC 2136 with TSIG, wildcards included; issued certificates are written to
  `ACME_CERT_DIR` on every instance.
- Streamed backups that include the blob store, and `backup:restore` into an empty database; streaming blob stores
  with S3 multipart uploads for large import bundles.
- `PLATFORM_BUNDLE_REQUIRE_CHECKS` makes the bundle scan and staging steps mandatory; signer keys are under dual
  control.
- Media and images served with `Content-Security-Policy: sandbox`, optionally from a separate `MEDIA_ORIGIN`.
- Clock skew against NTP on the platform status; zones enforced when MCP servers and connections are registered.
- MySQL data connections, read-only, and OpenBao dynamic database credentials.

### Accessibility
- The accessibility mode is stored per user and follows them to another browser.
- `UI.tabs` implements the full ARIA tabs pattern with arrow keys, Home and End.
- Move buttons for workflow steps and Up and Down buttons for classifier levels (WCAG 2.5.7).
- The Chat title is an `h1`.

### Testing
- 411 unit and API tests (1 skipped) across 31 files, with new suites `account.test.ts`, `sprint12.test.ts`,
  `sprint13.test.ts`, `sprint14.test.ts`, `sprint15-access.test.ts` and `sprint15-ops.test.ts`, and fakes for mail and
  the HIBP range API, webhook receivers, Stripe, OpenBao transit and DNS.
- `integration/operations.test.ts`: shared limits across two instances on Redis, and streamed backups restored into
  PostgreSQL and MySQL.
- The test harness serves each app on 127.0.0.1 before SuperTest sees it (`test/loopback.ts`,
  `test/setup-loopback.ts`), which fixes a port-shadowing flake on macOS.

### Upgrade notes
- Migrations `013_account` to `017_ops` run on start (`DB_MIGRATE_ON_START`) or with `exprsn-ai migrate`.
- Chat answers now stream a sentence at a time when `model-output` rules apply (the platform baseline has them), because
  each sentence is screened before it is sent.
- `POST /platform/signers` answers `202` with a proposal once any signer key exists (the first key is still added at
  once, `201`), and revoking a key answers `202`; a second platform admin approves.
- New permissions `webhooks:manage`, `prompts:manage`, `billing:read` and `billing:manage`. Tenant admins get the first
  three, knowledge curators get `prompts:manage`, and system admins hold all of them.
- New settings, all optional with safe defaults: breached passwords (`BREACHED_*`), step-up and password links
  (`STEPUP_WINDOW_SECONDS`, `PASSWORD_RESET_*`, `PASSWORD_INVITE_HOURS`), chat streams and retention
  (`CHAT_STREAM_LEASE_SECONDS`, `CHAT_RETENTION_SWEEP_MINUTES`), `/v1` (`OPENAI_STREAM_MODE`), webhooks (`WEBHOOK_*`),
  billing (`BILLING_*`, `STRIPE_*`), DPoP (`DPOP_PROOF_MAX_AGE_SECONDS`), key re-wrap (`DATA_KEY_PREVIOUS`,
  `KMS_PREVIOUS_PROVIDER`), bundles and backups (`PLATFORM_BUNDLE_REQUIRE_CHECKS`, `PLATFORM_BACKUP_BLOBS`), ACME
  (`ACME_CHALLENGE`, `ACME_DNS_*`, `ACME_CERT_DIR`), media (`MEDIA_ORIGIN`, `MEDIA_URL_TTL_SECONDS`), NTP (`NTP_SERVER`,
  `NTP_TIMEOUT_MS`) and OpenBao database credentials (`OPENBAO_DATABASE_MOUNT`). See [docs/deploy.md](docs/deploy.md).
- New CLI commands: `kms:rewrap` and `backup:restore`.
- Backups now include the blob store by default (`PLATFORM_BACKUP_BLOBS=true`), so they are larger; set it to `false`
  to keep database-only backups.

## Pre-1.0 review fixes

Fixes from the pre-1.0 codebase review, made after `1.0.0-rc.1` and included in 1.1.0.

### Security
- Secret references (`env:`, `file:`) in user stores and upstream IdPs are confined by the operator: `env:` names must
  be on `SECRET_REF_ENV`, `file:` paths inside `SECRET_REF_DIRS`, and the server's own settings and secret files are
  never readable. **Upgrade note:** list the variables your identity YAML references in `SECRET_REF_ENV` (the dev
  Compose file sets `DEV_*`); `file:/run/secrets/...` references keep working.
- LDAP and SQL user stores must be internal hosts unless `IDENTITY_ALLOWED_HOSTS` names them; a SQLite store cannot be
  the application's database. Data connections get the same confinement (`CONNECTIONS_ALLOWED_HOSTS`); PostgreSQL and
  LDAP dial the checked address and OpenSearch never follows redirects.
- A chat stream can only be resumed through the conversation it belongs to.
- Sign-in, "Test a login" and second-factor attempts reserve their place in the lockout count before the credential is
  checked, so parallel requests cannot exceed it.
- Ending someone's session (Users, Sessions, Federation) or OAuth grant needs roles that could grant theirs.
- Tool results pass the `context` guardrail checkpoint before the model sees them.
- A message cannot raise a conversation above its workspace's ceiling.
- Scheduled training jobs run with their owner's current roles and are skipped when the owner is disabled, gone or no
  longer allowed to submit.
- Authorisation denials are capped per principal (20 a minute in full, then one summary event).
- CI actions, kubeconform and base images are pinned by SHA, checksum and digest.

### Reliability
- One instance with unreadable mTLS files no longer stops gateway polling for every instance.
- Bootstrap no longer fails at start when a workspace the identity file declares has been archived.
- A response that fails after it started streaming is closed at once instead of waiting for the request timeout.
- Data-key rotation reaches every instance (a bus event, and the active key is re-read at least every five minutes).
- A throwing event-bus listener no longer breaks the publisher or other listeners.
- The gateway queue no longer adds an abort listener per wait round.
- The Compare screen detaches its socket listeners and timers when you leave it.

### Other
- Audit and usage exports are written and downloaded in sealed parts instead of in memory.
- User creation is one transaction; tenant-wide session revocation lives in `SessionService`.
- The Users and Tenants lists no longer query per row.
- The CI parse check covers `web/js/federation.js`.
- New Playwright specs for refusal states (a user store referencing a server secret, a connection to a public host).

## 1.0.0-rc.1

The first release candidate: every screen of the design prototype backed by the server. Sprint details are in
[Sprints.md](Sprints.md); the open items are the known gaps in [docs/security.md](docs/security.md), the follow-ups in
[docs/asvs.md](docs/asvs.md) and the gaps in [docs/accessibility.md](docs/accessibility.md).

### Sprint 10: hardening
- Helm chart (`deploy/helm/exprsn-ai`) with a hardened Deployment, migrations as an init container or hook Job,
  secrets from existing Kubernetes Secrets, and default-deny NetworkPolicies mirroring the zones.
- CI: npm audit, CycloneDX SBOMs of the workspace and the image, a Trivy image scan, Helm lint and render, the
  streaming load test and the Playwright console suite; Dependabot. The runtime image no longer ships npm, yarn or
  corepack.
- The OWASP ASVS 4.0.3 level 2 assessment (`docs/asvs.md`) and its fixes: `no-store` on every API answer, no internal
  errors on public pages, rate limits on the public sign-in endpoints, redaction of codes and tokens in request logs, a
  local-account password policy, protection of an admin's last second factor, the old session ended on a new
  password sign-in, and link-local hosts refused for git sources.
- Accessibility: Standard (AA) and Enhanced (AAA) modes, landmarks and skip link, labelled fields, accessible dialogs,
  popovers, toasts and command palette, focus management.
- Streaming load test (`server/loadtest/stream.ts`, `docs/loadtest.md`) and runbooks for backup and restore, incident
  response and upgrades (`docs/runbooks/`).
- Fixes: the Connections screen no longer fails to render when no connection is registered; "Test a login" counts
  directly granted roles; page loads no longer count against the sign-in rate limit.

### Sprint 9: training, zones, platform, federation
- Training: datasets with PII scrub, approval by a second ML admin for confidential data, training windows, a
  fair-share queue, checkpoints and resume, evals per hardware class, GGUF conversion to a draft model.
- Zones: versioned zone definitions with dual control, ceilings enforced by the gateway, rendered NetworkPolicy,
  Compose and nftables, endpoint health.
- Platform: signed import bundles verified in seven steps, mirrors, ACME certificates, data key rotation, backups and
  restore drills (`backup:create`, `backup:restore-drill`).
- Identity: OIDC provider (ES256 JWKS with rotation, clients, PKCE, refresh rotation, device flow, token exchange),
  SAML IdP, upstream OIDC and SAML user stores, Kerberos SPNEGO; OAuth access tokens accepted by the API.

### Sprints 0 to 8
Foundations, identity and access, tenancy and audit, the Ollama gateway, chat and compare, guardrails, knowledge,
memory and connections, the registry, MCP servers, agent runs and scripts, workflows, media and images. See
[Sprints.md](Sprints.md).
