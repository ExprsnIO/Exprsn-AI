# Release 2.0.0 "GM"

A draft of the `## 2.0.0` section of [CHANGELOG.md](../CHANGELOG.md) (B-10805). It is kept in its own file so it
does not collide with the Unreleased entries still being written for Sprint 62. When the version is bumped, the
maintainer moves the section below into the CHANGELOG and replaces its Unreleased entries since 1.9.9-qa. The full
entries per item stay in the CHANGELOG under the new heading. Sprint 62's items (B-10209, B-10606, B-10607, B-10703,
B-10704, B-10706, B-10803, B-10804) are summarised from their Unreleased entries as of 2026-10-21; check them again at
the bump.

**Before the bump, read [About the version name](#about-the-version-name).**

---

## 2.0.0 (unreleased)

The general-availability release. It is 1.9.99-final, the cloud epic (`Backlog-1.9.99-final.md`, Sprints 56 to 62),
on top of 1.9.9-qa. From a running install, Exprsn-AI now works with **AWS, Azure, DigitalOcean and Cloudflare** in
both directions:

- it **deploys itself** (the application, PostgreSQL, Redis, GPU nodes running Ollama) to a cloud from the console;
- it **uses cloud services**: model APIs, GPU compute joined as gateway pools, managed databases (as its own database
  or as data connections), object stores, and an edge front door.

The server calls the providers' APIs directly (AWS SDK for JavaScript v3, the Azure ARM APIs, the DigitalOcean API
v2, the Cloudflare API v4). It does not use Terraform. It keeps a resource graph and an operation journal in its own
database, and every change goes plan (a previewed diff with a cost estimate), then apply, then verify. Drift
detection, rollback and destroy are built in. Design and setup are in [docs/cloud.md](cloud.md), the operator's side
in [docs/deploy.md](deploy.md#cloud-100-gm-the-1999-final-epic-sprints-56-to-62), and the routes in
[docs/api.md](api.md).

### Features

- **Cloud accounts and credentials (B-100, Sprint 56).**
  - Accounts at platform or tenant scope, under dual control.
  - Per-region allow-lists. Each region maps to a zone and a label ceiling, and `policy.ts` refuses placements above
    it.
  - Residency per tenant. `restricted` data never goes to a cloud without a dual-controlled override.
  - Validation against a permission checklist per feature.
  - Federation for AWS and Azure: short-lived sessions bought with tokens from a separate federation issuer, whose
    discovery document and JWKS are published to a bucket or served on `/cloud-issuer`. DigitalOcean and Cloudflare
    use vaulted tokens.
  - Vaulted keys and secrets with automatic rotation where the provider allows it.
  - A setup helper that renders the IAM, trust and Azure role assignments.
  - The permissions `cloud:read`, `cloud:deploy`, `cloud:admin`, `finops:read` and `finops:manage`, with the roles
    `cloud-admin`, `cloud-operator` and `finops-analyst`.
  - Migrations `146_cloud_accounts` and `147_cloud_federation`.
- **Provider adapters and the deployment engine (B-101, Sprint 57).**
  - One `CloudProvider` interface over the four providers, with test fakes for each.
  - The resource graph, the operation journal (idempotent, resumable on any instance), plans with hashes, apply,
    verify, drift with decisions, destroy, rollback and the orphan sweep.
  - A shared rate limiter, retries and a circuit breaker per account.
  - `cloud.*` audit events, each carrying the provider's request id.
  - Migrations `148_cloud_journal` and `149_cloud_lifecycle`.
- **Deploying Exprsn-AI (B-102, Sprints 57, 58, 62).**
  - Deployment specs with presets, and a network foundation derived from the zone specs.
  - Targets:
    - Kubernetes (EKS, AKS, DOKS), installed with a pinned Helm 3.19.0 (`HELM_BIN`);
    - VMs, installed from a signed release tarball with `install.sh --from-release`;
    - container platforms (ECS on Fargate, Container Apps, App Platform);
    - the Cloudflare app tier.
  - Upgrades by image digest: a database snapshot first, then `migrate --check` in the cluster, a rolling update,
    verify, and an automatic app-tier rollback. A database restore is dual-controlled.
  - Cloud DNS and TLS: dns-01 through Route 53, Azure DNS or DigitalOcean, and certificate pushes to cloud load
    balancers.
  - Cloud KMS (`aws-kms`, `azure-keyvault`) and Azure Blob for deployed installs.
  - On-prem front doors (B-10209), so an existing install can sit behind a Cloudflare front door.
  - Migrations `150_cloud_prices`, `151_cloud_releases` and `152_cloud_budgets`.
- **Managed data (B-103, Sprint 59).**
  - Managed PostgreSQL and MySQL on all three clouds, with extensions (pgvector, PostGIS, pg_trgm), deletion
    protection, snapshots, schedules and dual-controlled restores.
  - Moving this install's own database onto a managed PostgreSQL (`exprsn-ai db:move`).
  - Managed caches as `REDIS_URL`.
  - Document and key-value stores, and cloud databases as read-only data connections.
  - Migrations `153_cloud_databases` and `156_cloud_connections`.
- **GPU compute (B-104, Sprint 60).**
  - GPU node groups and VMs joined as gateway pools, with single-use enrolment tokens for mTLS node certificates.
  - Warm-up from the model mirror, GPU quotas and capacity fallbacks.
  - Scale-to-zero and autoscale, with cold starts handled in the gateway.
  - Spot nodes with interruption handling, and idle GPU savings.
  - Migrations `157_cloud_gpu_pools` and `158_cloud_autoscale`.
- **Cloud model backends (B-105, Sprints 60, 61).**
  - Amazon Bedrock, Azure OpenAI and AI Foundry, DigitalOcean GenAI and Workers AI, as model servers behind the
    gateway.
  - The cloud catalogue import.
  - Per-model prices, metered into `usage_records` (`cost_micros`, `currency`, `price_id`, `neurons`,
    `cached_tokens`).
  - Provider guardrails as an extra layer: Bedrock Guardrails and Azure's content filter recorded as guardrail
    decisions. Exprsn-AI's own checks always run too.
  - Residency, and dual-controlled data-terms attestations that raise an entry's ceiling to `confidential`.
  - Migrations `159_cloud_models`, `160_cloud_model_servers` and `163_cloud_model_prices`.
- **FinOps (B-106, Sprints 57 to 62).**
  - A price catalogue and an estimate on every plan.
  - Budgets with 50, 80 and 100 % alerts and a hard stop, with overrides.
  - Billing ingestion: AWS Cost Explorer, Azure Cost Management, DigitalOcean invoices, and Cloudflare usage
    analytics.
  - Estimate against actual, and showback by tenant and workspace, with optional statement lines.
  - Spend anomaly alerts and the Cloud spend screen (B-10606, B-10607).
  - Migrations `155_cloud_costs`, `164_cloud_showback` and Sprint 62's `166_cloud_anomalies`.
- **Operations and security (B-107, Sprints 57, 59, 62).**
  - Cloud metrics, a Grafana dashboard and Prometheus alerts with promtool tests.
  - Cloud metadata endpoints are refused by every egress check, by name and at connect time. EKS nodes require
    IMDSv2 with a hop limit of 1.
  - Least-privilege generated policies.
  - The change trail on drift findings, from CloudTrail, the Azure Activity Log or Cloudflare's audit logs (B-10703,
    `165_cloud_change_trail`).
  - Runbooks (B-10704).
- **Cloudflare (B-109, Sprint 61).**
  - The front door:
    - DNS and edge TLS;
    - Cloudflare Tunnel, with the `cloudflared` connector in the chart, a systemd unit and a Compose file;
    - WAF and rate limits;
    - optional Cloudflare Access in front of the console.
  - The app tier: Containers behind a Worker, Hyperdrive, and blobs on R2.
  - R2 as an object store, D1 as a read-only data connection, and AI Gateway in front of cloud model instances.
  - Cloudflare billing and showback.
  - Migration `161_cloud_edge`.
- **The cloud screens (B-10706, Sprint 62).** Cloud, Deployments, Cloud data, Cloud compute and FinOps, plus the
  provider filter and cloud catalogue on Models. Each is live once every control on it is backed by the server.
  Check `web/js/app.js` at the bump.
- **Release (B-108, Sprint 62).**
  - The upgrade path from 1.6.0, 1.7.0 and 1.9.9-qa tested both ways on SQLite, PostgreSQL and MySQL
    (`server/test/upgrade-path.test.ts`, `server/test/integration/upgrade-path.test.ts`).
  - The docs check that every cloud route and permission is in `docs/api.md`, `docs/openapi.json` and
    `docs/permissions.md` (`server/test/api-docs.test.ts`).
  - The release-version guard (`server/test/release-version.test.ts`).
  - The security review (B-10803).
  - The nightly sandbox job (B-10804).

### Breaking changes

None of open decision 11's candidates breaks an existing 1.9.9-qa install as they actually shipped. The behaviour
changes an operator should know about are these:

- **Cloud metadata addresses are refused everywhere (B-10705).** This covers every egress check and every
  operator-set URL that had no check before: OpenBao, S3, Stripe, HIBP, SIEM, the ACME directory, image safety, the
  Kubernetes API and OTLP. The refusal applies to these addresses and names, before any allow-list:
  - `169.254.169.254`, `168.63.129.16`, `169.254.0.23`, `fd00:ec2::254`, `fd20:ce::254`, and their IPv6 spellings;
  - `metadata.google.internal` and similar names.

  A service that was reached through such an address stops working. Nothing legitimate should be. A workflow HTTP
  step no longer accepts `fd00:ec2::254` as internal.
- **New cloud secrets are file-only in production.** The production refusal of inline secrets now also covers
  `KMS_AWS_SECRET_ACCESS_KEY`, `AZURE_IDENTITY_CLIENT_SECRET` and `BLOB_AZURE_ACCOUNT_KEY`. Give them as `<NAME>_FILE`.
  These settings are new, so no existing install sets them. `S3_SECRET_ACCESS_KEY` is still accepted inline. Cloud
  account credentials are never read from the environment: they are federated sessions or vault references.
- **The bare-metal installer is unchanged by default.** `install.sh` with no mode still builds the checkout
  (`--from-source`), as before. `--from-release <url> --sha256 <digest>` is opt-in: it installs a signed release
  tarball, and cloud VMs use it. The proposal to make release tarballs the default was not adopted, because refusing
  a bare run broke existing installs (2026-10-20).
- **The Helm chart's values are additive.** The new options are `config.kms.provider: aws-kms | azure-keyvault`
  (settings in `config.extra`, the identity in `serviceAccount.annotations`) and the `cloudflared` block. The secrets
  values did not gain a provider, so the chart's version was not moved to 2 for it. The chart still says
  `version: 1.7.0`, `appVersion: "1.7.0"`: see the version note below.
- **The gateway's `ModelServer` interface (B-43)** shipped in 1.6.0 and changes nothing for operators.

### Upgrading from 1.9.9-qa

1. **Back up** the database and the blob store ([runbooks/upgrade.md](runbooks/upgrade.md)). That backup is the
   rollback path.
2. **Migrations.** This release adds `146_cloud_accounts` to `164_cloud_showback` (`154` and `162` are unused),
   plus Sprint 62's `165_cloud_change_trail`, `166_cloud_anomalies` and `167_cloud_sandbox_flag` once they are
   registered. Check the list in `server/src/db/migrations/index.ts` at the bump.
   - Every migration only expands: `exprsn-ai migrate --check` with the new build exits **2** on a 1.9.9-qa database,
     so a rolling upgrade is safe.
   - The old instances stop taking jobs and report not ready once the schema is newer (the schema handshake, exit 4
     from their own `migrate --check`).
   - The path is tested both ways on SQLite, PostgreSQL and MySQL: upgrade, `migrate --check` clean, a restore of the
     pre-upgrade dump, `migrate --check` clean as 1.9.9-qa.
3. **Metering.** `usage_records` gains `cost_micros`, `currency`, `price_id`, `neurons` and `cached_tokens`. They
   are null on every row metered before the upgrade (nothing is back-filled). Costs of older rows are still computed
   at read time from the analytics price books.
4. **Settings.**
   - No setting was renamed or removed from 1.9.0 to this release, so no deprecated names need to be accepted.
   - Every new setting has a default, and nothing needs to be set unless a cloud feature is used. The new settings
     are:
     - the `CLOUD_*` family (issuer, sessions, rotation, drift, orphans, budgets, endpoints), in
       [deploy.md](deploy.md#cloud-100-gm-the-1999-final-epic-sprints-56-to-62);
     - `HELM_BIN`;
     - `CLOUDFLARE_ACCESS_TEAM_DOMAIN`, `CLOUDFLARE_ACCESS_AUD`, `CLOUDFLARE_ACCESS_SCOPE`, `CLOUDFLARE_IP_RANGES` and
       `CLOUDFLARE_TUNNEL_PEERS`;
     - `KMS_AWS_*`, `KMS_AZURE_*`, `AZURE_IDENTITY_*` and `BLOB_AZURE_*`.
   - New values of existing settings:
     - `KMS_PROVIDER=aws-kms | azure-keyvault`;
     - `BLOB_STORE=azure`;
     - `ACME_DNS_PROVIDER=route53 | azure-dns | digitalocean`, with `ACME_DNS_CLOUD_ACCOUNT` and
       `ACME_DNS_CLOUD_ZONE`.
5. **`TRUST_PROXY` and the `cloudflare` keyword.** Behind the Cloudflare front door, add `cloudflare` to the list,
   for example `TRUST_PROXY=loopback,cloudflare`, or `uniquelocal,cloudflare` in the chart.
   - The server then trusts Cloudflare's published ranges (`CLOUDFLARE_IP_RANGES` replaces the shipped list) and the
     tunnel's connector (`CLOUDFLARE_TUNNEL_PEERS`).
   - It takes the client address from `CF-Connecting-IP` from those peers only, and drops the header from anyone else.
   - Without the keyword nothing changes.
6. **KMS and blobs on a cloud.** These are optional ([deploy.md](deploy.md#keys-and-blobs-on-a-cloud-1999-final-b-10208)).
   - Moving an install's key-encryption key into a cloud KMS is a `kms:rewrap` from the current provider.
   - Moving blobs to Azure Blob or R2 follows the blob-store switch in the deploy guide.
7. **Helm values.** Merge your values with the chart's: `config.kms.provider` and the `cloudflared` block are new.
   The chart's `appVersion` is the default image tag, and it still reads `1.7.0`, so pin `image.digest` (recommended
   in any case) or `image.tag`.
8. **Cloud accounts added during the epic's testing.** Validate them again after the upgrade: Sprint 62 added
   `cloudtrail:LookupEvents` (AWS `deploy`), `Microsoft.Insights/eventtypes/values/read` (Azure `deploy`) and
   "Account Settings Read" (the Cloudflare `frontdoor` token).
9. **Rollback.** Before the migrations ran, deploy 1.9.9-qa again. After they ran, 1.9.9-qa refuses the database:
   restore the pre-upgrade backup and redeploy 1.9.9-qa. Never delete rows from `knex_migrations`.

### Known gaps

The current list for the cloud epic is in [cloud.md, Known gaps (2.0.0)](cloud.md#known-gaps-200). Its
security-relevant items and the security review are in [security.md](security.md#known-gaps-tracked-in-the-plan).
Nothing has yet run against real cloud accounts: the nightly sandbox job (B-10804) and the owner's sandbox steps are
open, as is open decision 18.

---

## About the version name

The epic was planned as 1.9.99-final, to ship as `1.0.0-GM`. Semantic versioning reads `1.0.0-GM` as a pre-release of
1.0.0 and orders it below `1.0.0-rc.1`, `1.7.0` and `1.9.9-qa` (`G` sorts before `r`), so Helm would hide it without
`--devel`, chart constraints such as `>=1.7.0` would never match it, and Renovate, Flux, Argo, Dependabot and
`git tag --sort=v:refname` would rank it below the releases it replaces. On 2026-10-21 the owner chose **`2.0.0`, named
"GM"** instead: it orders above 1.9.9-qa everywhere.

Inside Exprsn-AI nothing compares release version strings: safe upgrades, the schema handshake and `/readyz` compare
migration names; cloud upgrades compare image digests and the exit code of `migrate --check`; bundles and plugins
check signatures and digests. `server/test/release-version.test.ts` keeps it that way (it allow-lists the places that
read the server version and fails if one starts comparing it) and checks that 2.0.0 sorts above 1.9.9-qa.

The Helm chart is `version: 2.0.0`, `appVersion: "2.0.0"`; the OpenAPI document's `info.version` is `2.0.0`.
