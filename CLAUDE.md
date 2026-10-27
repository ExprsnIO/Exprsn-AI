# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What's here

Exprsn-AI is a self-hosted, multi-tenant control plane and chat interface for Ollama-served models. The repository
has three parts:

| Path | What it is |
| --- | --- |
| `server/` | The application server (npm workspace `@exprsn-ai/server`): Node.js 22, TypeScript strict, Express 5, Socket.io 4, Knex |
| `web/` | The console the server serves: one screen module per page, wired to the API |
| `e2e/` | Playwright suite across every console screen (its own package, not a workspace member) |
| `deploy/` | Dockerfile, Compose (production, development, GPU), Helm chart with NetworkPolicies, bare-metal systemd unit and installer, example identity YAML |
| `apple/` | The native macOS, iPhone and iPad client (`ExprsnAI.xcodeproj`, SwiftUI + SwiftData, Swift 5 mode, no dependencies): every console screen of 1.0 to 1.9.9 behind the same permissions, OpenAI-compatible platforms over `/v1`, a Streamable HTTP MCP client, Keychain-held secrets, export and import. `apple/README.md` has the build, the smoke run (`EXPRSN_SNAPSHOT_DIR`) and the layout |
| `docs/` | `PLAN.md` (decisions and rules), `api.md` (every route from Sprint 2 on), `identity.md`, `security.md`, `deploy.md`, `asvs.md`, `accessibility.md`, `loadtest.md`, `training-worker.md`, `classifier-worker.md`, `runbooks/` |
| `Sprints.md` | Sprint status: what each sprint delivered or will deliver, and which screens it makes live |
| Repository | `github.com/ExprsnIO/Exprsn-AI`, recreated on 2026-10-27 from the 2.0.0 tree with one fresh commit; one branch, `main` (the old history and branches are in a git bundle on the backup drive) |

Sprints 0 to 9 are done (foundations; identity and access; tenancy, audit and platform services; the Ollama gateway,
models, pools and profiles; chat, compare and metering; guardrails, classifiers and flags; knowledge, memory and
connections; registry, MCP servers, agent runs and scripts; workflows, media and images; training, zones, platform
operations and federation), Sprint 10 (hardening: Helm chart, supply-chain CI, streaming load test, runbooks, the ASVS
L2 review in `docs/asvs.md`, AA/AAA accessibility modes in `docs/accessibility.md` and the Playwright suite in `e2e/`)
produced release candidate `1.0.0-rc.1`, and Sprints 11 to 15 (account self-service and security
notices; streaming guardrails, held answers and resumable streams; the OpenAI-compatible API, webhooks, prompts,
sharing, export and billing; the second federation sprint; shared rate limits, key re-wrap, dns-01, blob backups and
restore) made version `1.1.0`. Sprints 16 to 19 (`/v1` context and tools, the guard model while
streaming, held prompts, live and anonymous sharing; sign-in notices, the strength meter, upstream step-up, DPoP nonces,
SAML metadata, enrolment links and automated accessibility checks; service URL checks, backend TLS, consistent
backups, ACME binding and hooks, sealed training data; MySQL and replicated knowledge sources with row access, ordered
and Ed25519 webhooks, price books with Stripe reconciliation, awaited workflow tools) made version `1.2.0`. Sprints 20
to 23 (the signer process, KMS-held webhook keys, HTTP Message Signatures and image provenance;
held `/v1` requests, the Responses API, evaluations and scheduled agents; tracing, dashboards and alerts, safe upgrades,
key escrow, zones applied in-cluster and an NTP quorum; S3 and web-crawl knowledge sources, PostgreSQL row security,
webhook order across instances, proration and Stripe refunds, axe-core and dialog reflow) are done in version `1.3.0`.
Sprints 24 to 28 (exprsn-platform's server features: a certificate authority with OCSP and an
ACME server, a secrets vault with leases, the event catalogue and plugins; AT-Protocol keys, DIDs, labeler, sign-in and
firehose ingest; moderation actions and appeals, the file store, low-code data apps, groups and events,
customer-service channels, messaging and the workspace feed, and a platform load test) made version `1.4.0`; they are
server-only. Sprints 29 to 34 (the console screens for the 1.4.0 domains, permission matrices,
custom roles and access reviews, CalDAV, CardDAV and WebDAV with DAV-only app passwords, model-based memory, MongoDB
connections, the AT-Protocol PDS and feed generators, import repositories and model import, Workflows 2 on the chain
context, chaining agents, skills, tools and workflows, profiles and presence, IMAP in CI) made version `1.5.0`; Sprint
33 moved to 1.7.0; B-3606 (capturing real DAV client traffic) was dropped. Sprints 35 to 39 (model
servers beyond Ollama, platform administration screens, groups depth, blob deduplication, image classification, the HTTP
tool kind, prompt-injection defence, SCIM, the MCP server, the AI inventory, analytics, audit export, red-team suites,
agent identities, handoffs, policies, DLP, legal hold, content credentials, chat artifacts, app packages and promotion,
data model drafts, AI field fills, outside tables, entity APIs and app embedding) made version `1.6.0` (B-5001,
capability tokens, was dropped on 2026-10-07). Sprints 40 to 43 made `1.7.0` (agents, tools and skills in chat,
dataset import, the exprsn-platform port items decided on 2026-10-06), Sprints 44 to 48 `1.8.0` (features of the
platform's exprsn-svr, rebuilt), Sprints 49 to 55 `1.9.0`, Sprint QA-1 `1.9.9-qa`, and the cloud epic (Sprints 56 to
62) shipped as **`2.0.0` "GM" on 2026-10-21** (`docs/release-2.0.0.md`). Since then: the Connections schema designer
and schema editing, and the Docs portal (`CHANGELOG.md`, Unreleased). Next are the Wikis (2.1.0).

Planning backlogs (`Backlog-*.md`: `1.8.0`, `1.9.0`, `1.9.9-qa`, `1.9.99-final` for the cloud epic, `2.1.0` for the
Wikis) are kept beside the code on disk and are git-ignored; the backlogs of 1.1.0 to 1.7.0 and 2.0.0 were removed on
2026-10-27. Item ids (`B-…`) cited in code and docs refer to them.
Every console screen is live, plus the Person page opened from people's names. New screens are written in `web/`
to `docs/screen-contract.md` and go live when every control is backed by the server. Check `Sprints.md` and the known
gaps in `docs/security.md` before starting work.

## Commands

From the repository root (npm workspaces; Node 22+):

```sh
npm ci
npm run dev                  # tsx watch server/src/index.ts, http://localhost:8080 (needs the env from server/.env)
npm run lint                 # eslint server/src server/test
npm run typecheck            # tsc --noEmit
npm test                     # vitest: unit and API tests on in-memory SQLite
npm test -w server -- test/policy.test.ts   # one test file (add -t "<name>" for one test)
npm run build                # tsc to server/dist
npm run cli -w server -- <migrate [--check] | admin:create | tenant:create | audit:verify | kms:rotate | kms:rewrap | kms:escrow |
                             kms:recover | signer | backup:create | backup:restore-drill | backup:restore | db:move>
npm run test:integration -w server           # each block runs when its variable is set: TEST_PG_URL, TEST_MYSQL_URL,
                                             # TEST_LDAP_URL (+ TEST_LDAP_INSECURE, TEST_LDAP_BIND_PW), TEST_REDIS_URL,
                                             # TEST_MONGODB_URL (an account that may create users), TEST_MSSQL_URL,
                                             # TEST_ORACLE_URL
TEST_HARNESS_DB=pg npm test -w server -- test/x.test.ts   # unit suites on a fresh PostgreSQL (or =mysql) database per
                                             # harness instead of SQLite (TEST_PG_URL / TEST_MYSQL_ADMIN_URL)
for f in web/js/*.js web/js/screens/*.js; do node --check "$f"; done   # console scripts must parse (CI checks this)
npx tsx server/loadtest/stream.ts --help   # streaming load test (docs/loadtest.md)
npm run loadtest:platform -- --help        # webhook, records, OCSP and firehose load test (docs/loadtest.md)
helm lint deploy/helm/exprsn-ai            # the chart (CI also renders it with kubeconform)
INTEROP_PG_URL=postgres://… npx --prefix interop tsx interop/run.ts   # the PDS against the reference AppView (cd interop && npm ci first)
cd e2e && npm ci && CHROME=/opt/pw-browsers/chromium npx playwright test   # console end-to-end suite across every screen
                                           # (starts its own server on SQLite with the test fakes; see e2e/README.md)
```

Local setup: `cp server/.env.example server/.env`, fill `SESSION_SECRET` (`openssl rand -hex 32`) and `DATA_KEY`
(`openssl rand -base64 32`), then `set -a; . server/.env; set +a`. The full stack with seeded OpenLDAP, PostgreSQL and
MySQL user stores is `docker compose -f deploy/docker/compose.dev.yml up --build` (seed logins are in the header of
that file).

CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests, build and the console parse check; integration tests
against real PostgreSQL 17, MySQL 8.4, OpenLDAP and Redis 7; a container build that must answer `/readyz`; npm audit,
`npm audit signatures`, CycloneDX SBOMs and a Trivy image scan; Helm lint and render; promtool on the Prometheus rules;
the in-process streaming load test; and the Playwright console suite. On `main` and `v*` tags it also pushes, attests
and cosign-signs the image as `ghcr.io/exprsnio/exprsn-ai` (from `GITHUB_REPOSITORY`) and attaches the SBOMs to the
release.

Tests never need a real Ollama: `server/test/fake-ollama.ts` speaks enough of its API (version, tags, ps, show, pull,
delete, generate, streamed chat with thinking and tool calls) and is also handy for driving the console by hand
(start it from a small `npx tsx` script and register its URL as a pool instance).


## Server architecture (`server/src`)

- **`index.ts`** starts the HTTP server, Socket.io, the job workers and schedules, the gateway poller and graceful
  shutdown; **`cli.ts`** is the `exprsn-ai` CLI; **`bootstrap.ts`** seeds the default tenant and identity YAML;
  **`services.ts`** builds the `Services` object (config, db, logger, metrics, bus, KMS and data keys, blob store,
  jobs, notifications, audit with checkpoints, exports and SIEM, repos, identity chain, sessions, API keys, MFA,
  directory sync, quotas, offboarding, gateway, attachments, calculator, chat, guardrails, vectors, connections,
  knowledge, memory, registry, MCP, tools, scripts, agents, workflows, media, images, and the Sprint 9 services
  training, zones, ops and federation, which read their collaborators lazily through `s`) passed to every route factory.
- **`config/`**: zod-validated environment. Secrets (`SESSION_SECRET`, `DATA_KEY`, `DATABASE_URL`, `METRICS_TOKEN`,
  `OPENBAO_TOKEN`, `REDIS_URL`, `SMTP_URL`, `S3_SECRET_ACCESS_KEY`, `SIEM_TOKEN`) may be given as `<NAME>_FILE`; empty
  variables count as unset. Production refuses non-HTTPS cookies, and `DATA_KEY`, `DATA_KEY_PREVIOUS` and
  `SIGNER_TOKEN` given inline (only their `_FILE` forms), and since 1.9.99-final the install's cloud secrets
  (`KMS_AWS_SECRET_ACCESS_KEY`, `AZURE_IDENTITY_CLIENT_SECRET`, `BLOB_AZURE_ACCOUNT_KEY`).
- **`http/app.ts`** composes the app: trace ids, pino-http, Helmet (CSP `script-src 'self'`), compression, health
  routes, then `/api` (JSON 256 kB limit except the raw attachment upload → `authenticate` (which also resolves the
  current workspace) → `csrfProtection` → rate limits → routers), then the static console with SPA fallback.
  **`http/middleware.ts`** has `authenticate`, `csrfProtection`, `requireAuth`, `requirePermission`, `parseBody`,
  `workspacesFor`; **`http/problem.ts`** has the RFC 9457 `HttpProblem` helpers.
- **`routes/`**: `auth.ts`, `me.ts` (profile, workspace switch, notifications, own jobs, sessions, API keys, factors),
  `chat.ts` (conversations, messages, stream catch-up, compare, attachments, calculate), `admin/identity.ts`,
  `admin/users.ts`, `admin/audit.ts` (events, verify, checkpoints, corrections, exports, SIEM status),
  `admin/tenants.ts` (tenants, workspaces, members, quotas, offboarding, policy explainer), `admin/usage.ts`,
  `admin/gateway.ts` (pools, instances, placements, models, profiles), `guardrails.ts` (rule sets, classifiers, flags),
  `knowledge.ts`, `memory.ts`, `admin/connections.ts`, `admin/registry.ts`, `admin/mcp.ts`, `agents.ts`, `scripts.ts`,
  `workflows.ts`, `media.ts`, `images.ts`, `training.ts`, `admin/zones.ts`, `admin/platform.ts` (plus the public ACME
  http-01 route), `admin/federation.ts`, `federation-public.ts` (OIDC, SAML, device and Kerberos endpoints mounted at
  the root, outside `/api`), `health.ts`; since 1.2.0 also `sharing-public.ts` (anonymous links, at `/api/public`),
  `trainer-worker.ts` (the training worker's key and artefact routes) and `integrations-public.ts` (the webhook JWKS
  and the Stripe webhook), mounted outside the authenticated `/api`. The full list is `docs/api.md`.
- **`identity/`**: the per-tenant store chain, adapters in `providers/`, JIT provisioning (roles, clearance and
  workspace memberships from group mappings), directory sync (`sync.ts`), sessions, MFA, lockout, API keys;
  `account.ts` (password change, reset tokens, forced change, step-up freshness, preferences), `breached.ts` (HIBP range
  API and offline file), `security-alerts.ts` (security notices).
- **`authz/`**: `permissions.ts` (catalogue and the 14 built-in roles), `labels.ts`, `policy.ts` (the single decision
  pipeline: role → scopes → tenant → clearance → zone ceiling, plus `explain` for the step-by-step view).
- **`audit/`**: `chain.ts` (append-only per-tenant SHA-256 hash chain, `onAppend` listeners), `checkpoints.ts`
  (KMS-signed checkpoints, verification), `exports.ts` (clearance-gated CSV by job), `siem.ts`.
- **`platform/`**: the infrastructure interfaces from `docs/PLAN.md`: `kms.ts` (local, OpenBao transit;
  `kms-cloud.ts` AWS KMS and Azure Key Vault, 1.9.99-final B-10208, with the install's own cloud identity in
  `cloud-identity.ts`), `datakeys.ts` (per-tenant envelope encryption, `Sealer`), `blob.ts` (filesystem, S3 SigV4;
  `blob-azure.ts` the Azure Blob API), `jobs.ts` (`JobQueue`
  on the database or BullMQ, `Scheduler`), `bus.ts` (in-process events fanned out over Redis), `notifications.ts`,
  `email-templates.ts` (escaped plain-text and HTML mail), `ratelimit.ts` (counters in memory or one atomic Redis Lua
  script, shared by the rate limits, the failed-credential throttle and the denial cap), `rewrap.ts` (`kms:rewrap`),
  `ntp.ts` (SNTP skew).
- **`tenancy/`**: `quotas.ts` (limits, `admit` → 429, metering, usage reports), `offboarding.ts`; since 2026-10-19
  `default-workspace.ts` (`defaultWorkspace`) and `usage-attribution.ts` (the workspace, profile and person an embedding
  or classifier usage record gets; a new embedding or classifier call meters through them).
- **`gateway/`**: `ollama.ts` (client, NDJSON streaming, mTLS), `repo.ts` (pools, instances, models, placements,
  profiles and versions), `gateway.ts` (poller, memory planner, anti-thrash, slot leases and queue, alias and canary
  resolution, pull, evaluate and rolling-upgrade jobs).
- **`chat/`**: `service.ts` (conversation trees, sealed content, generation with streaming, tools, fallback and
  metering), `attachments.ts` (quarantine, type sniffing, ClamAV, classifier), `calc.ts` (the exact-calculation
  worker thread), `context.ts` (context providers for knowledge and memory, citations with passages), `streams.ts`
  (resumable streams: sequenced catch-up buffer, heartbeats, interrupted answers), `sharing.ts` (read-only shares and
  exports).
- **`guardrails/`**: `types.ts` (the checkpoint seam `s.guardrails.check`, which every feature calls with its
  checkpoint), `engine.ts` (checks, precedence platform > tenant > workspace > agent, fail closed, decisions, replay and
  statistics), `sets.ts` (versioned rule sets, dual control for the baseline), `rules.ts` (rule schema, YAML, diff),
  `regex.ts` (RE2), `detectors.ts` (PII and secrets), `model.ts` (guard-model verdicts), `classifiers.ts` and
  `linear.ts`, `flags.ts` (the review queue, including held answers), `stream.ts` (sentence-by-sentence screening of
  streamed output).
- **`knowledge/`** (sources, extraction, chunking, keyword terms, hybrid search with RRF, blue/green reindex),
  **`memory/`** (scopes, proposals, forget, export; since 1.5.0 the tenant's memory settings, consolidation and
  reindex jobs, and `model.ts`: the memory profile's prompts and strict JSON parsing), **`connections/`** (PostgreSQL,
  MySQL, OpenSearch and MongoDB drivers, since 1.9.0 SQL Server, Azure SQL, Oracle, Snowflake and BigQuery, query classification, masking, `dynamic.ts` for OpenBao dynamic database credentials) and
  **`platform/vectors.ts`** (`VectorStore`: table scan or pgvector).
- **`registry/`** (entries, checks, schemas, `dispatch.ts`: the one tool dispatcher for chat, agents, workflows and
  the test harness), **`mcp/`** (streamable HTTP client, internal-host checks, schema hashing), **`agents/`** (runs
  with lanes, approvals, budgets, checkpoints and replay), **`scripts/`** (`ScriptRunner`: docker or podman sandbox).
- **`workflows/`** (`graph.ts` publish validation, `service.ts` durable checkpointed runs, `http.ts` internal-only HTTP
  step; since Sprint 32 `steps/`: the Workflows 2 kinds, `kinds.ts` their publish-time definitions registered in
  `STEP_KINDS`, `registry.ts` their runners in `STEP_RUNNERS`, `host.ts` what a runner gets from the service), **`chain/`**
  (`context.ts`: the chain context, B-4101, `s.chains`; since Sprint 34a `refs.ts`, the reference graph checked at
  publish and "used by", `s.chainRefs`, B-4105, and `view.ts`, the chain tree, held calls and replay from a node behind
  `routes/chains.ts`, B-4106, B-4107; delegation to agents is `AgentService.runAsTool`, B-4102, and a skill's closure
  `registry/skills.ts`, B-4103), **`media/`** (presets as argument arrays, `MediaRunner` over ffmpeg, `origin.ts` for the sandbox CSP and signed
  URLs on `MEDIA_ORIGIN`), **`images/`** (`ImageBackend` for ComfyUI and diffusers, safety classifier, signed
  provenance in the PNG).
- **`training/`** (datasets with PII scrub, jobs driven by the `training.tick` orchestrator, windows, evals, GGUF to a
  draft model; `TrainerBackend` over HTTP to the Python worker), **`zones/`** (versioned zone specs with dual control,
  ceilings enforced through `gateway.zoneCeiling`, NetworkPolicy/Compose/nftables rendering), **`ops/`** (signed import
  bundles, mirrors, the ACME client with `dns.ts` for dns-01, backups and restore drills, `restore.ts` for streamed
  backups and `backup:restore`, `signers.ts` for signer keys under dual control), **`federation/`** (OIDC provider with
  ES256 keys, SAML IdP with XML-DSig, upstream OIDC/SAML stores, device flow, `KerberosVerifier`, revocation,
  introspection, logout, PAR, DPoP, `xmlenc.ts` for encrypted assertions, signing in OpenBao transit; OAuth access
  tokens are accepted by `authenticate`).
- 1.1.0 modules: **`openai/`** (the `/v1` OpenAI-compatible API), **`webhooks/`** (signed deliveries as jobs, breaker),
  **`integrations/hosts.ts`** (per-tenant allowed hosts), **`prompts/`** (the prompt library), **`billing/`** (price
  books, statements, Stripe push).
- 1.2.0 modules: `identity/signin-notices.ts` (new browser or network notices) and `identity/admin-create.ts`
  (`admin:create`, enrolment links); `federation/proposals.ts` (dual-control identity changes) and
  `federation/metadata.ts` (SAML metadata by URL); `platform/egress.ts` (operator service URL checks, connect-time),
  `platform/yaml.ts` (capped YAML parsing) and `platform/diagnostics.ts` (secret masking in diagnostics and problem
  details); `ops/cert-hooks.ts` (certificate push hooks) and `ops/push.ts` (Harbor, Verdaccio and devpi pushes);
  `training/worker.ts` (worker contract 2, `docs/training-worker.md`); `knowledge/acl.ts` (row access) and
  `knowledge/replication.ts` with `connections/replication.ts` (PostgreSQL logical replication).
- 1.3.0 modules: **`signer/`** (`server.ts`, `client.ts`, `protocol.ts`: the `exprsn-ai signer` process that holds the
  local key-encryption key and the private keys, and the app's client for it), `crypto/httpsig.ts` (RFC 9421 message
  signatures, RFC 9530 `Content-Digest`); `openai/holds.ts` (held `/v1` requests) and `openai/responses.ts` (the
  Responses API subset); **`evals/`** (eval sets, runs and the publish gate); `agents/schedules.ts` (cron schedules);
  `observability/tracing.ts` (OTLP/HTTP spans) and `observability/ops-metrics.ts`; `db/schema.ts` (the schema guard and
  `migrate --check`); `platform/shamir.ts` and `platform/escrow.ts` (`kms:escrow`, `kms:recover`); `zones/kube.ts` and
  `zones/cluster.ts` (`ZONES_APPLY=kubernetes`); `knowledge/crawl.ts` (the internal web crawler). Prometheus rules and
  Grafana dashboards are in `deploy/observability/`.
- 1.5.0 modules: **`dav/`** (CalDAV, CardDAV and WebDAV at `/dav`, `docs/dav.md`: `handler.ts` the router and methods,
  `auth.ts` app-password Basic auth, `tree.ts` the namespace, `caldav.ts`, `carddav.ts`, `filters.ts` the query
  operators, `sync.ts`, `store.ts` personal collections and dead properties, `props.ts`, `xml.ts` (the strict parser),
  `ics.ts` (iCalendar and vCard), `if.ts` (the If header), `service.ts` `s.dav`, `passwords.ts` and `routes.ts` for
  `/api/me/app-passwords` and `GET /api/me/dav` (B-3415); since Sprint 34b `files.ts`, the file store under
  `/dav/files/`, and `locks.ts`, class 2 locks (B-3201 to B-3203); the conformance fixtures are in
  `server/test/fixtures/dav/`). **`registry/builtin/`** (Sprint 32c, B-3904: `catalog.ts` the domain built-in tools
  seeded by `034c_workflow_steps`, `index.ts` `BuiltinTools`, which run them as the caller through the dispatcher).
  Sprint 31b added to `atproto/`: `commit.ts` (relay commit and Merkle search tree verification, B-3604),
  `service-jwt.ts` (inter-service JWTs) and `feeds.ts` (feed generators over the firehose, `s.feedGenerators`), with
  `routes/atproto-feeds.ts` and the public XRPC in `routes/atproto-feeds-public.ts`; the AT-Protocol interop vectors
  are in `server/test/fixtures/atproto/`, and `test/sprint31b-fakes.ts` has an MST writer and repos that sign commits.
- 1.5.0 Sprint 31: **`atproto/pds/`** (the AT-Protocol PDS, `docs/pds.md`: `service.ts` hosting, accounts, sessions
  and state, `repo-store.ts` commits and reads, `mst.ts`, `car.ts`, `repo.ts`, `tid.ts` the repository format, `lexicon.ts` with `lexicon-docs.ts` and
  `lexjson.ts`, `syntax.ts`, `blobs.ts`, `sequencer.ts` (subscribeRepos), `migration.ts`, `feeds.ts`, `tokens.ts`;
  routes in `routes/pds-xrpc.ts` at `/xrpc` and `routes/pds.ts` under `/api`; interop fixtures in
  `server/test/fixtures/atproto-interop/` and `atproto-ref/`; `interop/run.ts` runs it against the reference AppView).
- 1.5.0 modules: **`imports/`** (Sprint 30: `repositories.ts` the dual-controlled repository registry and harvests,
  `catalog.ts` the snapshot with facets and live search, `fetcher.ts` the allow-listed import egress, `formats.ts`
  format, pickle and licence checks, `service.ts` model import jobs, licence exceptions and bundle mode, `adapters/`
  one per repository type); its fakes are `server/test/sprint30-imports-fakes.ts`.
- 1.5.0 Sprint 32b additions to **`workflows/`**: `trigger-config.ts` (the trigger step's `event` and `schedule` +
  `cron` sources and their publish checks), `triggers.ts` (event fan-out with the workspace, label, rate and loop
  rules, the cron tick claimed once across instances, `workflowCause` the chain of workflows), `retry.ts` (per-step
  retry policies and `branch: failure` edges), `dead-letters.ts` (failed runs and their redrive), `bundles.ts` (signed
  `exprsn-workflow/1` export and import with re-bound references), hooked into `service.ts` through `useLifecycle`;
  routes in `routes/workflow-operations.ts`.
- 1.5.0 Sprint 34c: **`profiles/`** (`service.ts` `s.people`: pronouns and bio through the `user-input` guardrail, the
  avatar as a file-store upload served only once its pinned version passed the scan, visibility by workspace and
  clearance; `presence.ts` `s.presence`: chosen or derived status, connection rows per instance with a heartbeat, one
  publish per change on `TOPICS.presence`), with `routes/people.ts` (`/api/people`, `/api/presence`) and
  `realtime/presence.ts` (`presence.watch`, `presence.idle`, `presence.changed` on the console's socket).
- 1.6.0 Sprint 35d: `social/admin.ts` (`s.socialAdmin`, B-4206: workspace policies the feed, groups and social
  relations read, the tenant's digest and summary settings, trending exclusions, legal-hold conversation exports under
  dual control as the job `messaging.conversation.export`, realtime counts from `RoomStats` in `realtime/rooms.ts`)
  with `routes/admin/social.ts`; `tenancy/templates.ts` (B-4501: tenant provisioning templates).
- 1.6.0 Sprint 36a: `groups/depth.ts` (`s.groups.depth`: tenant group categories, discovery, the `groups.trending`
  job, B-4402, B-4404, B-4405) and `groups/geo.ts` (distance filters: PostGIS `ST_DWithin` or a bounding box, one
  haversine deciding, B-4403); channels are groups with a `parent_id` (B-4401) in `groups/service.ts`.

- 1.6.0 Sprint 35b: `ops/instances.ts` (`s.instances`: every server process's heartbeat row in `platform_instances`, the
  `readiness` checks `/readyz` shares, drain), `ops/overview.ts` (`s.overview`: computed alerts, acknowledgements,
  counters, recent audit, capacity) and `ops/jobs-admin.ts` (`s.jobsAdmin`: job types, jobs, schedules, dead letters,
  the cache), behind `routes/admin/operations.ts`; `JobQueue` pauses by type (`pausesLoader`) and `requeue`s, and the
  `Scheduler` lists its schedules, runs one now and skips a paused one (`isPaused`).
- 1.6.0 Sprint 36b: `files/dedup.ts` (`s.files.dedup`, B-4601: reference-counted `file_blobs` shared within one
  tenant, adopted when a scan releases a version and released by the trash purge), `apps/forms-held.ts`
  (`s.apps.forms.held`, B-4701: public submissions the `user-input` guardrail holds, decided from the moderation and
  flag queues) and `vault/anomalies.ts` (`s.revealWatch`, B-4803: reveal history and flags for a secret's owner).
- 1.6.0 Sprint 36c: `knowledge/images.ts` (B-8801: image types from the bytes, the images inside PDF and Word
  documents as a document's parts, the vision profile's prompt and validated answer); image documents, their labels
  (`knowledge_doc_labels`) and the jobs `knowledge.classify` and `knowledge.reclassify` in `knowledge/service.ts`; the
  `vision` classifier engine and image eval cases in `guardrails/classifiers.ts`; the built-in tool `knowledge_search`.
  The fake Ollama answers image prompts from a picture's text chunks (`markedPng` in `server/test/fake-ollama.ts`).
- 1.6.0 Sprint 37a: `registry/http-tool.ts` (`s.httpTools`, B-89: `impl: http` registry tools, their definition rules,
  the runner the dispatcher calls, the meter `registry_http_calls`) over `guardedRequest` and `toolAddressProblem` in
  `platform/egress.ts`; `guardrails/injection.ts` (`s.injection`, B-69: the `untrusted-content` checkpoint, the
  `injection` mechanism's heuristic classifier, trust marking with `markUntrusted` and `toolResultContent`, detections
  per source) and `guardrails/injection-corpus.ts` (the CI corpus and its floor). The fake Ollama's guard answers
  injection prompts from the heuristic, and `obeyingReply` stands in for a model that follows unmarked instructions.
- 1.6.0 Sprint 37b: `mcp/server/` (B-7101, B-7102: `resource.ts` the endpoint URL and resource identifier per
  workspace, `service.ts` `s.mcpServer`: publications, the tool catalogue by group, calls through the dispatcher and
  held calls) behind `routes/mcp-server-public.ts` (`/mcp/<tenant>/<workspace>` and its RFC 9728 metadata, outside
  `/api`) and `routes/mcp-access.ts`; `mcp/oauth.ts` (`s.mcp.oauth`, B-7103: discovery, registration, the authorization
  code with PKCE, refresh and revocation for per-user MCP servers); RFC 8707 resources and RFC 7591 registration in
  `federation/oidc.ts`; the `records.*` built-ins in `registry/builtin/`. `server/test/sprint37b-fakes.ts` has an
  authorization server for `fake-mcp.ts`.
- 1.6.0 Sprint 37c: `identity/scim/` (`service.ts` `s.scim`: SCIM 2.0 users and groups into a SCIM store, tokens,
  deactivation, group membership to roles; `filter.ts` the RFC 7644 filter and path grammar; `patch.ts` PATCH and the
  writable document; `schemas.ts` the discovery documents) with `identity/providers/scim.ts` (the store in the chain)
  and `routes/scim.ts` (`/scim/v2`, outside `/api`, and the token routes under Identity, B-7201, B-7202);
  `vault/shares.ts` (`s.vaultShares`, B-4801: a KV secret shared as a policy grant); the MongoDB lease engine in
  `vault/db-engines.ts` (B-4802); quotes and visibility in `feed/service.ts` (B-4901).
- 1.6.0 Sprint 38a: `governance/inventory.ts` (`s.inventory`, B-7301, B-7302: the AI system inventory over the
  objects' own tables plus `inventory_systems`, the owner publish gate the registry asks through `publishGate`, the
  register as CSV or JSON); `tenancy/analytics.ts` (`s.analytics`, B-7401, B-7402: sums over `usage_records` by
  dimension and per day, prices per model or pool, the chargeback); `audit/export-verify.ts` (B-7501: the JSONL
  export's shape and its offline verifier, also `exprsn-ai audit:verify-export`) with `runAuditJsonl` in
  `audit/exports.ts` and `AuditCheckpoints.createAt`; `audit/siem-destinations.ts` (`s.siemDestinations`, B-7501:
  per-tenant HTTPS and syslog-over-TLS destinations under dual control, one `SiemForwarder` per active destination fed
  through the chain's listener). The tracer allows the `gen_ai.usage.*` attributes the gateway clients set (B-7403).

- 1.6.0 Sprint 38b: `redteam/` (`attacks.ts` the built-in attack catalogue and the deterministic judge; `service.ts`
  `s.redteam`, B-7001, B-7002: suites per target, runs as the job `redteam.run`, agent and workflow attacks as child
  runs with `caller_kind: redteam-run`, a flag per successful attack, the gate `gateProfile` beside the evaluation
  gate and `gateAgent` on approval) behind `routes/admin/redteam.ts`; `agents/identity.ts` (`s.agentIdentities`,
  B-7701: an agent's roles, ceiling and keys, `narrow` the principal a run acts as, `Principal.agent` and
  `actor.agent`, keys with `api_keys.agent_id` resolved in `authenticate`) behind `routes/admin/agent-identities.ts`;
  handoffs in `agents/service.ts` (B-7801: `handoffs` offered through `resolveCallees`, the run ends with the
  handed-to run's answer, `agent_runs.handed_to`). `leakingReply` in `server/test/fake-ollama.ts`.

- 1.6.0 Sprint 38c: `apps/policies.ts` (`s.apps.policies`, B-8101 to B-8103: row and field policies, the reader's
  grant that `apps/service.ts` applies in queries, reads, writes and views through `grantFor`, masks, explain; user
  attributes on `users.attributes`); `compliance/dlp.ts` (`s.dlp`, B-7601: rules and tenant RE2 patterns, `inspect`
  called by chat's `guardOutput`, the OpenAI-compatible API, agent `finish`, attachment and file scans; the feature
  side imports only `compliance/dlp-types.ts`, which keeps `guardrails/detectors.ts` out of an import cycle);
  `compliance/holds.ts` (`s.legalHolds`, B-7602: dual-controlled holds whose `held()` the chat, memory and file purges
  read); `compliance/exports.ts` (`s.complianceExports`, B-7603: the `compliance.export` job writing sealed JSON Lines
  parts) behind `routes/compliance.ts`.
- 1.6.0 Sprint 39a: `images/c2pa.ts` (B-7901: CBOR, JUMBF boxes, the manifest store with its assertions and claim, the
  COSE_Sign1 signature, PNG `caBX` embedding and `verifyPng`, also `exprsn-ai c2pa:verify`), `images/content-credentials.ts`
  (`s.contentCredentials`: signs in the image job through `PkiService.contentSigner`, the tenant's content-credentials
  certificate with its key in custody, `pki_content_signers`, and verifies against `contentAnchors`); `chat/artifacts.ts`
  (`s.chatArtifacts`, B-8001: `extractArtifacts` from fenced blocks on `chat.answerListeners`, `chat_artifacts` and sealed
  `chat_artifact_versions`, the share reader's view through `sharing.readable`, `forTranscript` for shares and links,
  `rawToken` and the public render route in `routes/sharing-public.ts`).

- 1.6.0 Sprint 39b: `apps/packages.ts` (`s.apps.packages`, B-8201, B-8204: `exprsn-app/2` packages built, signed,
  stored sealed in `app_packages`, verified before they are read, imported as a new app or applied to one in place by
  name, laid out as files for git and read back; git through `withRepo` with the knowledge source's URL checks) and
  `apps/pipelines.ts` (`s.apps.pipelines`, B-8202, B-8203: pipelines of three app slots, promotion with the production
  approval as a workflow run with `caller_kind: app-deployment` routed back through `onCallerDone`, the job
  `apps.deploy` with the backup first, history and rollback). `server/test/sprint39b-helpers.ts` builds the CRM app and
  the approval workflow the three suites share.

- 1.6.0 Sprint 39c: `apps/model-drafts.ts` (`s.apps.modelDrafts`, B-8301: a whole data model drafted through
  `apps/ai.ts`, diffed against the app with `diffEntity` and `mergeDefinition`, applied in dependency order);
  `aiPromptRefs`, `aiFieldsAffected` and `renderAiPrompt` in `apps/schema.ts` with `queueAiFill` in `apps/service.ts`
  (B-8401: formula placeholders, `app_records.ai_pending`, one `apps.ai-fill` job per record and quiet window);
  `apps/ai-fills.ts` (`s.apps.aiFills`, B-8402: the `apps.ai-fill-all` job, estimates priced through
  `s.analytics.prices`, `writeAiField` on the service); `apps/sources.ts` (`s.apps.sources`, B-8501: `app_entity_sources`,
  the `apps.source-pull` job and `apps.source-schedules` tick, `push` before every record write in `apps/service.ts`,
  `upsertFromSource` and `deleteFromSource`) over `readRowsForApp` and `mutateRow` in `connections/service.ts` and the
  drivers' `mutate` (`RowMutation`, `checkMutation`). `server/test/sprint39c-helpers.ts` has `SqliteTableDriver`, the
  outside table the unit tests and the e2e server use.

- 1.6.0 Sprint 39d: `apps/key-scope.ts` (B-8601: `appScopeGuard` on both apps routers and `underApps` in
  `authenticate`, for API keys with `app_scope` and embedded sessions); `routes/apps-entity-api.ts` (the entity API at
  `/apps/:app/:entity`, mounted after `routes/apps.ts`, plus the schema, OpenAPI, client and embed admin routes);
  `apps/schema-api.ts` (`s.apps.schema`, B-8602, B-8603: `record` called by `createEntity`, `updateEntity`,
  `removeEntity` and the forms service for every design change with `describeEntityChange`, the schema API's own
  changes, `openapi` and `client` computed from the design); `apps/embeds.ts` (`s.apps.embeds`, B-8701, B-8702:
  settings, keys, pages, the host-token `exchange` with `verifyWith` per algorithm and the tenant CA's `x5c`,
  `resolveSession` for `exe_` bearers) behind `routes/apps-embed-public.ts` (`/embed/...` pages with their own CSP
  and `/api/public/embeds/*`, outside `/api`); `web/js/embed.js` is the pages' script. `server/test/sprint39d-helpers.ts`
  mints host tokens and builds a tenant CA without the signer.
- After 1.6.0: the research built-ins in `registry/builtin/` (`knowledge_list`, `knowledge_read`, `knowledge_save`,
  `memory_search`, `memory_save`, seeded by `042_research_tools`; `research` in `index.ts` over
  `KnowledgeService.readDocument`, `MemoryService.contextFor` and `add`); `server/test/research-tools.test.ts`.
  `knowledge_search` takes no `kbIds` for every readable base; `coerceArgs` in `workflows/graph.ts` types the literal
  arguments of a workflow tool step or map item as the tool's input schema asks.
  `Gateway.runFollowing` makes one model call along a profile's fallback chain for agent runs (`agents/service.ts`)
  and workflow model steps (`runModel` in `workflows/service.ts`): the fallback serves when the queue wait passes
  (`acquireFollowing`) or the call fails. Chat and `/v1` keep their own loop (queue wait only).
  `server/test/profile-fallback.test.ts`.
  `channels/generate.ts` `generateAgentReply`: a chat channel with `agentTools` runs its agent's read tools and
  skills as the channel's `runAs` member account (`ChannelService.runAsPrincipal`), the reply queued as
  `channels.reply`; `server/test/channel-agent-tools.test.ts`.
  Knowledge categories (migration `043_knowledge_categories`): `knowledge/categories.ts` (a category's one spelling,
  its ancestors, filters), `knowledge_doc_categories` with a row per category and per category above it,
  `KnowledgeService.setCategories`, `categoriesOf`, `docsInCategories` and `categoryCounts`, the `categories` filter of
  `documents` and `search`; the built-ins `knowledge_add`, `knowledge_categorize`, `knowledge_categories` and
  `files.search`; `server/test/knowledge-categories.test.ts`. The built-in `files.read` (migration `047_files_read`):
  a file's text by id, read here (`knowledge/extract.ts`) or, for Office, OpenDocument and RTF files, by the tenant's
  script tool `document_process` through `ScriptService.runAsTool`; `server/test/files-read.test.ts`. Migration
  `048_net_and_file_tools`: `registry/builtin/net-files.ts` (the built-ins `http_fetch`, `http_request` and
  `http_download` over `guardedRequest` and the tenant's allowed hosts, redirects followed hop by hop; `files.run_tool`,
  `files.apply_tool`, `files.save` and `files.extract`, which put a file's content into a tenant script tool's
  arguments by the `BRIDGES` table; a dotted name there is a read-only MCP tool called through `McpService.call`, such as the
  document converter `exprsn-convert.convert_document`, whose product is saved under the name it returns) and `registry/builtin/curl.ts` (`parseFetchCommand`: a curl or wget command line
  read as a request, never run); `server/test/net-file-tools.test.ts`. Migration `049_allowed_host_tools`:
  `registry/builtin/allowed-hosts.ts` (the built-ins `allowed_hosts.check`, `allowed_hosts.list`, `allowed_hosts.add`
  and `allowed_hosts.remove` over `TenantIntegrations`, with `normaliseEntry` and the entries a tenant list refuses);
  `server/test/allowed-hosts-tools.test.ts`. Migration `046_classifier_categories`: a base may name a
  draft vision classifier (labels `provisional`), and `syncLabelCategories` files an image under
  `images/<classifier>/<label>` (`labelCategory`) from its labels, apart from the categories given to it.
  Crawled sites (migration `044_knowledge_changes`): `knowledge/crawl.ts` also offers the pictures of the indexed pages
  (`CrawlMedia`: the site's own host, or one `KNOWLEDGE_ALLOWED_HOSTS` names through `namedHost` in `mcp/hosts.ts`);
  `knowledge/diff.ts` (`textDiff`, a line diff of extracted text); `KnowledgeService.apply` records what a sync of a
  source with `config.changes` found in `knowledge_doc_changes` (`recordChange`, `changes`, `change`); the built-in
  `knowledge_changes`; `server/test/knowledge-crawl-changes.test.ts`.
  Knowledge references, revisions and review (migration `045_knowledge_revisions`): `knowledge/revisions.ts`
  (`s.knowledgeRevisions`: references with versions, revisions sealed as `krev:<id>`, editors and approvers in
  `knowledge_reviewers`, four eyes, `review: required` on a base; a submitted revision starts the base's review workflow
  as its caller, `caller_kind: knowledge-revision`, routed back through `onCallerDone` to `approvalDone`; `approve`
  uploads through `KnowledgeService.publishControlled` and `docSettled`, on `KnowledgeService.settled`, moves the
  reference once the document is indexed; `REVIEW_WORKFLOW` and `reviewWorkflowGraph` are the standard workflow),
  `routes/knowledge-revisions.ts`, the built-ins `knowledge_propose`, `knowledge_revisions` and `knowledge_publish`
  (only as a workflow step after an approval), `web/js/screens/knowledge-references.js` (the References tab, called
  from `knowledge.js`); `server/test/knowledge-revisions.test.ts`.
- 1.7.0 Sprint 40 (B-40): `chat/capabilities.ts` (`s.chatCapabilities`: what a conversation may call, `/tool` calls
  as `chat_invocations` with approval cards and the job `chat.tool`, `@agent` and `/workflow` runs with
  `caller_kind: chat-invocation` (`CHAT_CALLER`) routed back through `onCallerDone`, held tool calls as hold flags,
  the conversation's skills read through `ChatService.turnSkills`) behind `routes/chat-capabilities.ts`; migration
  `051_chat_capabilities`; a profile's `chat_capabilities` allow-list; `server/test/chat-capabilities.test.ts`. The
  console side is `web/js/screens/chat-capabilities.js`.
- 1.7.0 Sprint 40 (B-3804 to B-3807): `imports/datasets.ts` (`s.imports.datasets`: describe, preview, plan and
  request of a dataset import, the `imports.dataset` job into `training_datasets` through
  `TrainingService.registerImported`, a classifier's eval set, a knowledge source of kind `dataset` through
  `KnowledgeService.addDatasetSource`, `applyDataset` and `settleDataset`, or the sealed store; refreshes as imports
  of their own, `imports.refresh-due`), `imports/adapters/dataset-rows.ts` (the fetch steps: a hub's dataset viewer,
  CKAN datastore and Socrata paging, SDMX-CSV, files, a gated hub dataset's Parquet files),
  `imports/adapters/dataset-sources.ts` (Kaggle, and the `estat` and `ogd` repository types, whose key travels in
  the query string through `keyed`), `imports/tabular.ts` (CSV, TSV, JSON, JSON Lines and ARFF as streams, the schema
  preview with PII flags) and `imports/containers.ts` (`anyRecords`: zip archives through `imports/zip.ts` with its
  limits, xlsx through `imports/xlsx.ts`, Parquet through `imports/parquet.ts` on `hyparquet`, XML; each read whole
  within IMPORT_ARCHIVE_MAX_BYTES); migration `050_dataset_import`; `web/js/screens/import.js` (the
  Import screen); `server/test/sprint40-dataset-import.test.ts` and
  `sprint40-dataset-sources.test.ts`, with the data endpoints in `sprint30-imports-fakes.ts`, which the e2e server
  also starts, the Kaggle, e-Stat and OGD fakes in `sprint40-sources-fakes.ts` and Parquet files in
  `test/fixtures/imports/`.
- 1.7.0 Sprint 40 (B-3806, second half): imported classifier engines. `guardrails/classifier-worker.ts`
  (`s.classifierWorker`: the `ClassifierWorker` contract over HTTP, `docs/classifier-worker.md`, and
  `classifierModelDigest`), `imports/classifier-models.ts` (`s.imports.classifierModels`: the plan checks of a
  text-classification model, `stage` in the `imports.model` job, the `ImportedEngine` behind
  `s.guard.classifiers.imported`, `conformance` behind `Gateway.classifierConformance`), the `imported` engine in
  `guardrails/classifiers.ts` and `isClassifierModel` in `gateway/repo.ts`;
  `server/test/sprint40-classifier-engine.test.ts` with `fake-classifier-worker.ts`, and
  `server/test/integration/classifier-worker.test.ts` against a real worker (`TEST_CLASSIFIER_WORKER_URL`) with the
  model in `server/test/fixtures/classifier/`.
- 1.7.0 Sprint 41 (B-9001, B-9002): `ops/redis-required.ts` (`redisRequirement`: why a server process is one of
  several and so needs `REDIS_URL`; called from `index.ts` only, never from `createServices`, so the CLI, setup
  scripts and tests are not refused), `Bus.health` and the `redis` check of `readiness` in `ops/instances.ts`
  (`InstanceRegistry.staleMs`), the poll behind the bus in `atproto/stream.ts` and `atproto/pds/sequencer.ts`
  (`ATPROTO_STREAM_POLL_SECONDS`; `attach…Stream(server, s, { pollMs })` in tests), `SERVER_REPLICAS`;
  `server/test/sprint41-redis-required.test.ts` and `server/test/integration/redis-required.test.ts`.
- 1.7.0 Sprint 41 (B-9201 to B-9205): the vault's platform scope (`SYS_SCOPE`, `sys/` paths and the `service`
  subject in `vault/policy.ts`; `serviceCaller`, `rootCaller`, `hmacSecrets` and `ensureSysHmacKey` in
  `vault/service.ts`); `vault/keyring.ts` (`s.sysKeys`: the named HMAC keys in `SYS_KEYS` that replace the
  `SESSION_SECRET` derivations, version 1 of each being that secret; a `KeySource` hands a feature its accepted
  secrets, `mac` signs with the current one, `macs` and `macMatches` accept every accepted one; cached, reloaded on
  `TOPICS.vaultSys`, uses audited per service and minute); `hmac-sha256` in `vault/transit.ts`;
  `vault/generic-leases.ts` (`s.leases`: `vault_leases`, kinds registered with `registerKind`, `check` cached and
  dropped on `TOPICS.vaultLease`); `ops/boot.ts` (`openVault`, the named start steps, called from `index.ts` only:
  a process that never opens the scope keys with `SESSION_SECRET` alone, as before); `routes/admin/platform-vault.ts`;
  migration `060_vault_system_scope`; `server/test/sprint41-vault-system.test.ts`. A new digest or signature the
  server keys itself takes a key from `s.sysKeys.key(...)`, never `cfg.SESSION_SECRET`.
- 1.7.0 Sprint 41 (B-9301, B-9302): `vault/apikey-leases.ts` (`s.apiKeyLeases`: dynamic API-key leases of kind
  `apikey` on `s.leases`; the built-in provider `exprsn` issues this server's own API keys with `api_keys.lease_id`,
  which `ApiKeyService.verify` accepts only while the lease is live; outside providers as rows of
  `vault_apikey_providers` with roles in `vault_apikey_roles`; `issue` for a `VaultCaller`, `readRef` behind
  `VaultService.readValue` for `vault:apikey:<provider>/<role>#key`, `parseApiKeyRef` and `isSecretRef` in
  `vault/policy.ts`), `vault/apikey-providers.ts` (the `ApiKeyProvider` interface and the reference provider
  `github`, GitHub App installation tokens; a provider calls out only through `ProviderTarget.request`, the egress
  guard; `ServiceOverrides.apiKeyProviders` adds kinds), `routes/vault-apikeys.ts`; migration `061_apikey_leases`;
  `server/test/sprint41-apikey-leases.test.ts`, whose `FakeGitHub` checks the App's JWT and records revokes.
- 1.7.0 Sprint 42 (B-9705, B-9707): `groups/roles.ts` (the tiers `GROUP_ROLES` with `TIER_RIGHTS`, the rights
  `GROUP_RIGHTS`, and the only helpers a groups check may use: `can(access, right)`, `covers(holder, wanted)`,
  `ownsGroup`, `isStaff`, `linkRole`; `s.groups.roles`: custom roles in `group_roles`, `rightsFrom`, `rightsOf`,
  `rightsOfAll` and `holders`; `Access.rights` is set in `GroupService.accessOrNull`). Never compare a tier's name
  (`role === 'owner'`): ask for a right. In `groups/calendar.ts`: `readable(e, access, p)` is the one place that
  decides who reads an event (drafts, `visibility`, hidden), `mayAttend`, `promote` (the waitlist, under
  `lockEventRow`), `decideRsvp`, `publish`, `screenUrl`; RSVP rows may say `waitlisted` or `pending` (`RSVP_STATES`).
  Migration `065_group_roles_event_extras`; `server/test/sprint42-group-roles-events.test.ts` and
  `e2e/tests/groups-roles-events.spec.ts`.
- 1.7.0 Sprint 42 (B-9706, B-9709): `groups/cases.ts` (`s.groups.caseWork`: a group's moderators acting on the flags
  about its content; `reach` the groups whose `cases` right the caller holds, `act` over `FlagService.decide`,
  `ModerationService.actOnFlag` for a hide and `GroupBans.create` for a suspension or a ban, `assign` over
  `FlagService.assignTo`, appeals over `ModerationService.startReview` and `decideAppeal`; listeners on
  `flags.createdListeners` and `moderation.appealListeners` tell the moderators) and `groups/conversations.ts`
  (`s.groups.conversations`: the group's linked conversation; `sync` makes `dm_members` the group's members and is
  called after every membership change, `standing` gives `MessagingService.accessOrNull` the caller's role from the
  group now, `assertUnlinked` refuses member changes in the conversation, `assertLabel` the label floor); migration
  `064_group_cases_conversations`; `server/test/sprint42-group-cases-conversation.test.ts` and
  `e2e/tests/groups-cases-conversation.spec.ts`. A new change of `group_members` ends in `conversations.sync`. Module
  constants in `groups/*.ts` that use `service.ts` exports are read inside functions: `service.ts` imports those files.
- 1.7.0 Sprint 43 (B-98): `groups/subjects.ts` (`s.groups.subjects`: `of(p)` and `ofUser(tenant, user)` the groups a
  person counts as a member of: member row, active account, not deleted, no standing ban or suspension, cleared for
  the label, in the workspace; the one answer files, vault, knowledge and apps ask), `groups/ownership.ts`
  (`s.groups.ownership`: active owners, the `groups.ownerless` sweep and `claim`), `files/group-grants.ts`
  (`file_group_grants`, folder grants cover what is below), the vault's `social_group` subject (`Subjects.socialGroups`
  from `subjectsFor`), knowledge's `social_group` principal (`KnowledgeDeps.socialGroups`), `apps/group-scope.ts`
  (`s.apps.groupScope`: app and entity `group_id`, applied in `AppService.visible` and first in `AppPolicies.grantFor`;
  the `group_role` policy subject); migration `069_group_access_subjects`; `server/test/sprint43-group-access.test.ts`
  and `e2e/tests/groups-access.spec.ts`. A new place that grants to a group asks `s.groups.subjects`, never
  `group_members` directly.
- 1.7.0 Sprint 43 (B-99): `chat/response-cache.ts` (`s.responseCache`: `cacheKey`, `cachePolicy`, sealed entries in
  `chat_response_cache`, `get` checks clearance and expiry, purge, stats, the `chat.cache.sweep` job), looked up in
  `ChatService.generate` before the lease and in `OpenAiService.chat`; `Guardrails.versionKey` (the rule-set versions
  in the key); profile `cache_ttl_seconds`, `cache_lenient`; `UsageInput.cacheHit`; migration `070_response_cache`;
  `server/test/sprint43-response-cache.test.ts`. Anything new that shapes an answer goes into the key.
- 1.7.0 Sprint 43 (B-113): `atproto/did-exprsn.ts` (`did:exprsn`: parse, build, `selfCertifyingDocument`), offline
  resolution in `DidResolver.resolve` with `local` for this server's own users, `atproto/user-dids.ts`
  (`s.atproto.userDids`: mint, list, `signLabel`, `serviceJwt`; table `atproto_exprsn_dids`, not the B-1807
  `atproto_user_dids`), `com.exprsn.identity.resolveDid` in `routes/pds-xrpc.ts`; migration `071_user_dids`;
  `server/test/sprint43-did-exprsn.test.ts` with the platform's vectors in `server/test/fixtures/atproto/did-exprsn.json`.
- 1.7.0 Sprint 43 (B-112): `plugins/surfaces.ts` (`s.pluginSurfaces`: the manifest's `ui` schema and checks,
  approval in `plugin_surfaces`, `forSlot`, the bridge `call` running `domainCall(..., { viewer })`),
  `routes/plugin-surfaces.ts`, the admin routes in `routes/admin/plugins.ts`; the decision is
  `docs/decisions/plugin-ui-surfaces.md`; migration `072_plugin_surfaces`; `server/test/sprint43-plugin-surfaces.test.ts`
  (its `FIXTURE` manifest) and `e2e/tests/plugin-surfaces.spec.ts`; the console's renderer is `web/js/surfaces.js`.
  A new block type or call is a reviewed change to `surfaceSchema` and the renderer together.
- 1.7.0 Sprint 43 (B-114): `feed/crosspost.ts` (`s.feed.crosspost`: the author's choice, `textWithFacets`, the
  `feed.crosspost` job that keeps one post's `app.bsky.feed.post` record in step, queued from `post.*` integration
  events and from the moderation hide and restore of `feed-post`); `oldestSeq` in `atproto/pds/sequencer.ts` (F8);
  migration `073_feed_crosspost`; `server/test/sprint43-crosspost.test.ts`.
- 1.7.0 Sprint 42 (B-9206 to B-9208): sessions and API keys as leases (`CREDENTIAL_STORE`; the `session` and
  `api-key` lease kinds in `identity/sessions.ts` and `identity/apikeys.ts`: a lease session's token starts `l1.`, a
  leased key is `exai_k2_`, both stores are always read by that form; `held`, `use`, `rekey`, `patch`, `endWhere` and
  quiet kinds in `vault/generic-leases.ts`; migration `066_credential_leases`); `vault/signing-keys.ts`
  (`s.signingKeys`: the other domains' signing keys registered by reference in `vault_signing_keys`, discovered from
  their own tables, rotated through their own domain) and held transit keys (`vault_transit_keys.custody`,
  `signHeld` in `vault/service.ts`; migration `067_signing_key_registry`); `vault/credential-moves.ts`
  (`s.credentialMoves`, also the `CredentialVault` the integrations read a moved credential through: `SPECS` names
  each kind's table, its id column when not `id` (`mcp_oauth` is keyed by `server_id`), sealed column, reference
  column and associated data; migration `068_credential_refs`; the Vault screen's "Third-party credentials" panel);
  `server/test/sprint42-credential-leases.test.ts`, `sprint42-signing-keys.test.ts`,
  `sprint42-credential-moves.test.ts`. A new sealed third-party credential gets an entry in `SPECS`, a reference
  column, and a read through `CredentialVault.read` with `rewritten` wherever it is changed. A new way to revoke a
  session or a key goes through `SessionService` or `ApiKeyService`, never an update of the table, or leases outlive
  it.
- 1.7.0 Sprint 42 (B-9209, B-9701, B-9702): `vault/reference-owners.ts` (`s.referenceOwners`: one saved `vault:`
  reference of one person handed to a workspace or to a service `integration.<name>`; `VaultService.resolveFor` asks
  `find` first and then resolves as that owner, with no person; `TENANT_SERVICE` is the one kind of `service` subject a
  tenant's policy may name), `groups/bans.ts` (`s.groups.bans`: bans and suspensions, `barred` in the group or its
  parent, `assertNone` called by `join`, `invite`, `decide`, the invite link and, last, `addMember`; a suspension
  gives `accessOrNull` no role, and `groupsBarred` and `usersBarred` are what lists, the feed and app policies filter
  with) and `groups/invites.ts` (`s.groups.invites`: invite links whose code is kept as a digest under the `link`
  key, `redeem` over `GroupService.admitByLink`, `screenMessage` for the sealed `group_requests.message`); migration
  `063_reference_owners_group_bans`; `server/test/sprint42-reference-owners.test.ts`,
  `server/test/sprint42-group-bans-invites.test.ts` and `e2e/tests/groups-bans-invites.spec.ts`. A new way into a
  group goes through `addMember`; a new read of `group_members` that decides access leaves out `groupsBarred`.
- 1.7.0 Sprint 42 (B-9703, B-9704, B-9708): `groups/profile.ts` (`s.groups.profile`: a group's tags, website,
  avatar and banner as pinned file versions, `assertRoom` the member limit that `join`, `invite` and `decide` ask in
  `groups/service.ts`), `groups/paging.ts` (keyset cursors, `Page`, `likeOf`: the `q`, `limit` and `cursor` of
  `GroupService.listPage` and `members` and of `CalendarService.attendees`), `GroupService.membersWithAccess` (who a
  notice about a group goes to), and in `groups/calendar.ts` `attendeesWithAccess`, `noticeRescheduled` (one row of
  `group_event_notices` per event and sequence), `notifyAttendees` and `notices`; migration
  `062_group_profiles_notices`; `server/test/sprint42-groups.test.ts`.
- 1.7.0 Sprint 41 (B-9501 to B-9504): `compliance/evidence.ts` (`s.evidence`: `keptOf(tenant, type)` the objects no
  purge may delete, from open moderation cases and from legal holds of scope `case` or `object`; `recordSkip` one
  row of `retention_skips` and one audit entry per object, path and reason; `assertDeletable` for user-facing hard
  deletes; the dual-controlled evidence export as the job `compliance.evidence-export`), the `case` and `object`
  scopes in `compliance/holds.ts`, the takedown state (`files.taken_down_at`), `applyRetention` and the hold checks
  of `purge` in `files/service.ts`, the kept conversations in `ChatService.purgeExpired`, the kept sessions in
  `ChannelService.purgeExpired`; migration `059_evidence_holds`; `server/test/sprint41-evidence.test.ts`. A new purge
  path asks `s.evidence.keptOf` for its object type and calls `recordSkip` for what it leaves.
- 1.7.0 Sprint 41 (B-9401 to B-9404): `moderation/held.ts` (`s.held`: writes the `user-input` guardrail holds
  instead of refusing, as rows of `held_writes`; `holdReason` tells a reviewer's hold from one by a check that could
  not run; each domain registers a `HeldHandler` for its kinds in its `registerHeld`: `dm-message` and `dm-edit` in
  `messaging/service.ts`, `group-post` in `groups/service.ts`, `feed-comment`, `feed-post-edit` and the outage-only
  `feed-post` in `feed/service.ts`; `resolve` for a reviewer, `withdraw` for the sender, the jobs
  `moderation.held.rescreen` and `moderation.held.purge`), `FlagService.closeHold`, the `held` routes in
  `routes/moderation.ts`; migration `057_held_writes`; `server/test/sprint41-held-messages.test.ts` and
  `e2e/tests/held-messages.spec.ts`.
- 1.7.0 Sprint 41 (B-9601, B-9602): `guardrails/drafts.ts` (a guardrail rule drafted from a description on
  `apps/ai.ts` `generate`: `describeRule` reads only the fields a draft may set and keeps the validated rule in
  `guard_rule_drafts`, `saveDrafted` adds it to the set's draft in shadow from that row, `awaitingSecondApprover` and
  `markEnforceApproved` send a version in which such a rule enforces through the existing review); the `describe`
  routes and the publish gate in `routes/guardrails.ts`; migration `056_guardrail_rule_drafts`;
  `server/test/sprint41-rule-builder.test.ts`. The e2e fake model answers the builder's prompt in `e2e/server.ts`.
- 1.7.0 Sprint 41 (B-9101, B-9102): `workflows/http.ts` (`internalRequest`: an HTTP step's address guard, internal
  hosts as before and public hosts from the tenant's list of allowed hosts, `isPublicAddress` in `platform/egress.ts`;
  `HttpStepNet` is the tests' stand-in for DNS and routing, `ServiceOverrides.workflowHttpNet`),
  `workflows/http-secrets.ts` (`literalSecret`: no literal credential in a header, query parameter or body field,
  called by `checkRefs` and `validate` in `workflows/service.ts`, never by the graph schema), `queryVaultRef`,
  `BODY_VAULT_REF` and the `query` map of an HTTP step in `workflows/graph.ts`, `platform/secret-names.ts` (the
  credential-name rules HTTP tools share); `server/test/sprint41-workflow-http.test.ts`.
- 1.8.0 Sprint 46 (B-130, B-135): `workflows/signed-hooks.ts` (`SignedHooks`: the signed, replay-safe incoming hook
  that `apps/flow-hooks.ts` and `workflows/hooks.ts` share: size, HMAC over `<timestamp>.<body>`, window, the shared
  `app_flow_hook_nonces`, rate, owner re-check, `untrusted-content` and `user-input`), `workflows/hooks.ts`
  (`s.workflowHooks`: the trigger source `webhook`, `POST /hooks/workflows/<tenant>/<id>` in
  `routes/workflow-hooks-public.ts`, `workflow_hooks` and `workflow_hook_deliveries`), `workflows/retention.ts`
  (`s.workflowRetention`: `workflow_retention`, the job `workflow.retention`, the `workflow-run` moderated object
  type for legal holds, `recordSkip` for held runs), their admin routes in `routes/workflow-automation.ts`, the console
  panel and tab in `web/js/screens/workflows-ops.js`; migrations `085_workflow_hooks`, `086_workflow_retention`;
  `server/test/workflow-webhooks.test.ts`, `server/test/workflow-retention.test.ts`, `e2e/tests/workflows-webhook.spec.ts`.
- 1.6.0 Sprint 36b (B-11707): `gateway/thinking.ts` (model thinking templates: `thinkingOf` a model's mode from
  `models.thinking_mode` and `thinking_template`, the built-in `THINKING_TEMPLATES`, `withThinking` the client every
  lease and the evaluation hand out, which adds a template's instruction and moves the text between its tags to
  `message.thinking` through `ThinkSplitter`; `effectiveCapabilities` puts `thinking` in a model's capabilities as
  `modelFrom` reads them); the `thinking` body of `PATCH /api/admin/models/:id` and the inherited thinking levels of a
  new profile in `routes/admin/gateway.ts`; `EVALUATION_SYSTEM` and the "Thinking template" test in
  `gateway/gateway.ts`; migration `054_model_thinking_templates`; `server/test/thinking-templates.test.ts`.
- 1.8.0 Sprint 46 (B-130 to B-135, migrations `085` to `089`): `workflows/signed-hooks.ts` (`SignedHooks`, the one
  signed-webhook core app flows and workflows share) with `workflows/hooks.ts` (`s.workflowHooks`) and
  `routes/workflow-hooks-public.ts`; `workflows/retention.ts` (`s.workflowRetention`, the `workflow-run` held object
  type); `decisions/table.ts` (the pure decision-table engine) and `decisions/service.ts` with `routes/decisions.ts`, the
  step kinds `decision` and `switch` (`workflows/steps/choose-kinds.ts`, `decision.ts`, `switch.ts`) and the built-in
  `decision.evaluate`; `workflows/approval-deadlines.ts` (due times, escalation, quorum votes on the `workflow.approvals`
  tick); `sla/hours.ts` and `sla/service.ts` with `routes/sla.ts` (policies, timers, routing, skills; assignment through
  `FlagService.assignTo`, `ChannelService.assignSession` and `ModerationService.assignAppeal`). Console:
  `workflows-ops.js`, `workflows-decisions.js`, `sla-routing.js`. A new public hook goes through `SignedHooks`; a new
  assignment path goes through the domain's own service, never a table update.
- 1.8.0 Sprint 45 (B-125, B-126, migrations `090_saved_queries`, `091_rest_connections`): `connections/params.ts`
  (typed parameters, `bindParams`), `connections/saved-queries.ts` (`s.savedQueries`: saved queries classified when
  saved, versions, `sqlPieces`/`renderSql`/`renderJson` binding, `run` the governed read path, `lookupOptions`),
  `connections/rest.ts` (`s.restConnections`: REST connections and endpoints, `fetchRows` over `guardedRequest` with
  paging and mapping, the `untrusted-content` checkpoint, `read`, `rowsForApp`, `lookupOptions`),
  `connections/external-sources.ts` (knowledge sources `saved-query` and `rest` through `KnowledgeService.external`),
  `ConnectionService.runBound`, the built-in `connections.query`, the permission `connections:query`,
  `routes/admin/connection-sources.ts`; lookups `source: query | rest` in `apps/schema.ts`, `kind: rest` entity sources
  in `apps/sources.ts`; console `web/js/screens/connections-sources.js`; `server/test/saved-queries.test.ts`,
  `server/test/rest-connections.test.ts`, `e2e/tests/connections-queries-rest.spec.ts`. A new reader of saved queries
  or REST endpoints goes through `run`/`read` (or `runAsService`/`fetchRows` with a ceiling), never the driver.
- 1.8.0 Sprint 47 (B-141, B-142, migration `099_file_meta`): `apps/formula-functions.ts` (the formula library: each
  function's arity, parameter kinds checked at compile time in `apps/formula.ts`, result kind, catalogue entry; lists,
  zones through `Intl`, `charge` for work against the step budget) behind `routes/apps-formula.ts` and
  `web/js/screens/apps-formula.js` (the editor's list and server check); `files/exif.ts` (the JPEG, PNG, WebP and GIF
  metadata stripper), `FileService.served` (what a reader is served: cleaned unless the owner asks `original=1`),
  `compare`, `setMeta`, `suggestAlt` and versioned `preview` in `files/service.ts`; `server/test/formula-functions.test.ts`,
  `server/test/file-compare-alt-exif.test.ts`, `e2e/tests/files-compare-alt.spec.ts`. A new path that serves file
  bytes to a reader goes through `served` (or `stripBuffer`), never `content` alone.
- 1.8.0 Sprint 44 (B-120 to B-124, migrations `100` to `104`): `apps/charts.ts` (`s.apps.charts`, computed as the
  viewer through `s.apps.aggregate`; a hidden or masked field makes a chart unavailable), `apps/chart-render.ts` (one
  layout as SVG and as PDF operators), `apps/dashboards.ts` (`s.apps.dashboards.render`), `apps/report-engine.ts` and
  `apps/reports.ts` (`s.appReports`: rows read as the viewer, masked values stay masked through every total),
  `apps/exports.ts` (`s.appExports.render`, the one renderer of records, views, reports and dashboards as XLSX, PDF,
  CSV and HTML), `imports/xlsx-writer.ts`, `apps/subscriptions.ts` (scheduled delivery: each email recipient gets a
  render made as themselves, webhooks only to allowed hosts, signed unsubscribe); console `apps-charts.js`,
  `apps-dashboards.js`, `apps-reports.js`, `apps-export.js`, `apps-subscriptions.js` (`#/app-subscriptions`, Build).
  Deleting an app deletes its exports' and import reports' sealed files after the rows.
- 1.8.0 Sprint 48 (B-143 to B-149, migrations `105` to `111`): `apps/roles.ts` (`s.apps.roles`, app-local roles: a
  policy subject `app_role` only, never more than the app's policies allow; packages carry the catalogue, not who
  holds a role); use limits on keys (`max_uses`, spent in one conditional update in `ApiKeyService`/
  `GenericLeases.spend`, revoked through `revokeRows` at zero); `security/scans.ts` and `security/scan-formats.ts`
  (Trivy, SARIF, CycloneDX results by artefact digest; the gate at promotion, plugin enable and upgrade, and script
  images; unscanned allowed with a warning by default); `vault/seal.ts` (dual-control seal, break-glass with the escrow
  threshold, unseal with escrow shares; the signer's `seal`/`unseal` messages; what answers while sealed is listed in
  `docs/runbooks/emergency-seal.md`); `plugins/drafts.ts` (the plugin creator: manifests only, never code the server
  loads), `ops/overview-cards.ts`, `knowledge/feedback.ts` and `knowledge/tree.ts` (feedback, page tree, backlinks
  written when a revision publishes). A new key-using path checks the seal (`DataKeys`/keyring refuse with 503).
- 1.9.0 Sprint 49 (B-150 to B-154, migrations `115` to `118`): `platform/push-devices.ts` (`s.pushDevices`: sealed
  tokens; `forDelivery` opens them for the delivery job only; `markGone`; ended with sessions through the
  `SessionService.devices` hook), `platform/notification-kinds.ts` (the catalogue of kinds; `security` is mandatory),
  `platform/notification-prefs.ts` (`s.notificationPrefs.decide` and `collect`, cached and cleared over the bus; no
  preferences means unchanged behaviour), `push/` (`s.push`: providers, `H2Pool`, Web Push crypto, delivery and its
  log), `guardedHttp2Connect`/`guardedHttp2Request` in `platform/egress.ts`; console `settings-devices.js`,
  `settings-notifications.js`, `platform-push.js`, `web/js/webpush.js`, `web/sw.js`. A new outbound push path goes
  through the egress guard, never a raw `http2.connect`.
- 1.9.0 Sprint 50 (B-155 to B-157, migrations `119` and `120`): `guardrails/rule-tests.ts` (`s.guard.tests`: sealed
  test cases per rule set, runs on every saved draft through `RuleSetService.draftListeners` and the job
  `guardrail.tests.run`, `gate` before publish, approve and promote; `testsGate` in `routes/guardrail-tests.ts`),
  `guardrails/terms.ts` and `term-match.ts` (`s.guard.terms`: versioned term lists, the normaliser and the cached
  Aho-Corasick matcher; `RuleSetService.refCheck` refuses unknown lists), `guardrails/conditions.ts` with
  `platform/condition-tree.ts` (the all/any/none tree `apps/flows.ts` also reads; `GuardrailEngine.leaf` and
  `contextOf` evaluate it, `engine.spamScore` or the spam module's `spamScoreFor` gives the spam score), routes
  `guardrail-tests.ts` and `guardrail-terms.ts`; console `guardrails-tests.js`, `guardrails-terms.js`,
  `guardrails-conditions.js`. A new mechanism adds a case in `GuardrailEngine.evaluate`, and a leaf kind a case in
  `leaf`; anything that changes a draft goes through `saveDraft`, so the tests run.
- 1.9.0 Sprint 52 (B-170 to B-173, migrations `138_search_index` and `139_search_state`): `search/` (`s.search`:
  `normalise.ts` folding, query reading (words, "phrases", `word*`) and snippets; `keys.ts` the per-tenant search keys
  sealed with the tenant key; `indexer.ts` the blind index (`search_postings`, `search_prefixes`, `search_docs`), synced
  after writes from the `message.*`/`post.*` integration events and audit entries, the resumable `search.backfill` job,
  rebuild, rotation, `drain` for tests; `query.ts` the reader; `chats.ts`, `posts.ts`, `everything.ts` B-171 to B-173),
  `routes/search.ts`; console `web/js/screens/search.js` (`#/search`, swept like `albums`); tests `search-index`,
  `search-chats-posts`, `search-everything` with `search-helpers.ts`, `e2e/tests/search.spec.ts`. A new sealed text
  that should be searchable is a `DocKind` with its `sources` case and a write trigger; every result is checked again
  as the reader before its text is opened.
- 2.0.0 file management (migration `112_file_documents`): `files/documents/` (`model.ts` the RichDoc and Workbook
  models and limits, `markdown.ts`, `odt.ts`, `sheets.ts` (CSV, XLSX, ODS), `normalize.ts`, `service.ts`
  `FileDocuments`: read, save with a base version, create, add to knowledge), `files/reports.ts` (`FileReports`),
  `files/cid.ts`, `duplicate`/`duplicateFolder`/`byCid` in `files/service.ts`, routes `files-documents.ts` and
  `file-reports.ts` (mounted before `fileRoutes`, document bodies parsed up to 32 MB in `http/app.ts`); console
  `file-edit.js` (`#/file-edit?file=`, not in the sidebar, swept like `person`) and `files-reports.js`. A new editable
  format adds a converter, its `kindOf` case, and its type to `files/scan.ts`.
- Files table builder (migration `121_file_queries`): `files/documents/query.ts` (the pure Power Query style engine:
  `stepSchema` is the step vocabulary, `runQuery` stops at a failing step), `queries-service.ts` (`FileQueries`: sources
  read as the caller, saved queries, `loadTo`/`refresh` through `FileDocuments`), `xls.ts` (Excel 97-2003, read only;
  `saveKindOf` makes a save an `.xlsx` copy), routes `file-queries.ts`; console `file-query.js` (`#/file-query`, swept
  like `file-edit`). A new step is an entry in `stepSchema`, a case in `apply`, and a title and dialog in the console.
- 2.0.0 linked storage (migration `113_file_locations`): `files/locations/` (`model.ts` the `Connector` interface and
  per-kind config, `net.ts` the address check and pinned dialling every connector must use, `connectors/` S3, Azure,
  local, SFTP, FTP, IPFS, `service.ts` `s.files.locations`: rows, sealed credentials, browse, import job
  `files.location.import`, send, operators' local stores), `files/imports.ts` (URL, database, knowledge, runs,
  workflows, skills, tools), routes `files-locations.ts` and `files-imports.ts`, permission `files:link`;
  `KnowledgeService.originalOf`; console `files-locations.js` and the Storage › Local stores tab. A new connector
  implements `Connector`, dials only through `net.ts`, and is added to `connectors/index.ts` and `CONFIG_SCHEMAS`.
- 1.9.0 connection types (migration `114_connection_engines`): `connections/engines.ts` (the engine catalogue, each
  engine's settings schema in `OPTION_SCHEMAS`, `parseOptions`, `engineCatalogue` behind `GET
  /api/admin/connections/engines`), `connections/dialects.ts` (per-dialect lexing, placeholders and quoting for
  `sqlPieces`/`renderSql`, `canonical` and `allowedQualified` names), drivers `mssql.ts` (SQL Server and Azure SQL),
  `oracle.ts`, `snowflake.ts`, `bigquery.ts` with classifiers `classify-tsql.ts`, `classify-oracle.ts`,
  `classify-snowflake.ts`, `classify-bigquery.ts`; `graphql.ts` and `soap.ts` as `rest_connections.protocol`
  `graphql` and `soap` in `rest.ts`. A new engine is an entry in `ENGINES`, its catalogue and option schema, a
  dialect (SQL) and a driver in `createDrivers`; the console needs no change. Tests: `connection-engines`,
  `connections-mssql`, `-oracle`, `-snowflake`, `-bigquery`, `graphql-connections`, `soap-connections`.
  Second round: non-SQL engines `redis.ts`, `rabbitmq.ts`, `prometheus.ts`, `influxdb.ts`, each exporting its
  classifier (routed through `NON_SQL` in `connections/service.ts`, with `NonSqlContext` from `nonsql.ts`) and its
  driver; allow-list globs in `patterns.ts`; API protocols `odata.ts` and OpenAPI import `openapi.ts` in `rest.ts`
  (`wsdl_url`, `wsdl`, `wsdl_at` and `service_meta` hold any service description). Example servers in `docker/infra`
  and `scripts/exprsn-ai-11-example-connections.mjs`: a new connection type also gets an example there.
- 2.0.x schema changes through connections (migration `169_connection_admin_accounts`): `connections/ddl-types.ts`
  (the column types per SQL dialect with their parameters and limits, `renderType`), `connections/ddl.ts` (the
  structured definitions per engine and kind, `buildPlan` to statements or `AdminOp`s with a hash,
  `expressionProblem`, `designerInfo` in the engine catalogue), drivers' `applyDdl` (run only on the connection's
  admin account, `ConnectionService.adminSpec`) and `queues` (Redis and RabbitMQ, the read account), `previewDdl`,
  `applyDdl` and `queues` in `connections/service.ts`, the permission `connections:ddl`, `categoryOf` in `engines.ts`
  and `category` on REST connections; console `web/js/screens/connections-designer.js` (Schema designer and Queues
  tabs). Tests `connections-ddl`, `connections-ddl-sql-drivers`, `connections-ddl-nonsql-drivers`. A new engine with
  schema changes adds its kinds to `ddlKinds`, its definitions to `buildPlan`, and `applyDdl` in its driver; queries
  stay read-only and never use the admin account. Editing: `connections/ddl-edit-types.ts` (descriptions, edit and
  drop definitions, `EditOp`), `ddl-edit.ts` (`buildEditPlan` diffs a definition against the live description,
  `describeTarget`, `editKinds`), drivers' `describe` and `routines` (`describe-sql.ts`, `describe-pg-mysql.ts`,
  `parseType` in `ddl-types.ts`), `ConnectionService.objects`, `describeObject` and the `confirm` of destructive plans;
  console `web/js/screens/connections-schema-edit.js`. Tests `connections-ddl-edit`, `connections-describe`,
  `connections-edit-nonsql-drivers`. An edit is always diffed against a description read on the server.
- 2.0.x Docs portal (migration `170_doc_sites`): `docs/service.ts` (`s.docs`: sites over knowledge bases; nav, page,
  library, document and search always read through `s.knowledge`, `s.knowledgeRevisions` and `s.knowledgeTree` as the
  reader, so access is the bases' own), `docs/render.ts` (Markdown to escaped HTML with heading ids and in-site page
  links, front matter stripped), `routes/docs.ts`, permission `docs:manage`; console `web/js/screens/docs.js`
  (`#/docs`, Knowledge group); tests `docs.test.ts`, `e2e/tests/docs.spec.ts`. Never render page HTML anywhere but
  `render.ts`, and never read knowledge content for a site except as the reader.
- **`repos/`**: tenant-scoped data access (tenants and workspaces, users, providers).
- **`db/`**: Knex for `pg`, `mysql`, `sqlite`. Migrations are **imported** in `db/migrations/index.ts`, not discovered
  on disk: a new migration needs a file `00N_name.ts` and an entry in that map. Keep the schema dialect-agnostic
  (use `text(…, 'mediumtext')` for anything that can exceed 64 KB, which is MySQL's `TEXT` limit).
- **`realtime/socket.ts`**: Socket.io with the cookie-session handshake and the Redis adapter when `REDIS_URL` is set.
  The server joins each socket to its user, tenant and session rooms and to permission rooms for live admin updates;
  bus topics (job progress, notifications, chat events, pool state, revocations) are relayed to those rooms.
- Tests live in `server/test/` (`helpers.ts` builds an app on in-memory SQLite with a temporary blob directory and
  signs users in, including TOTP; `fake-ollama.ts` also answers embeddings and guard-model verdicts; `fake-mcp.ts`,
  `fake-runner.ts` (scripts) and `sprint8-fakes.ts` (media runner, image backend, safety classifier) stand in for the
  other external workers; `fake-trainer.ts`, `fake-acme.ts` and `fake-idp.ts` stand in for the training worker, an ACME directory and an
  upstream identity provider; `fake-account.ts` (mail, HIBP range API), `sprint13-fakes.ts` (webhook receiver,
  Stripe) and `fake-openbao.ts` (transit) serve the 1.1.0 suites, and `sprint18-fakes.ts` (Harbor, Verdaccio, devpi)
  the 1.2.0 ones, and `sprint22-fakes.ts` (OTLP collector, Kubernetes API, SNTP, Redis) and `sprint23-fakes.ts` (S3
  bucket, web site) the 1.3.0 ones; `seed-gateway.ts` and `retrieval-seed.ts` seed pools, models and documents). `loopback.ts` and `setup-loopback.ts` (a Vitest setup file) serve each test app on 127.0.0.1
  before SuperTest sees it, so another process cannot shadow the port on macOS. `server/test/integration/` runs the
  stores and platform paths against real servers.

### Rules for server code (from `docs/PLAN.md`)

- Every route validates input with zod, requires authentication and an explicit permission, takes the tenant from
  the session (never the body), filters output by clearance, writes an audit event for every change, and fails with
  problem+json carrying the trace id.
- Secrets are shown once and stored hashed or sealed. Dual control where the boards require it.
- Socket rooms are decided by the server from the principal; revoking a session closes its sockets.
- The prototype's infrastructure maps to interfaces (`JobQueue`, `Kms`, `BlobStore`, `VectorStore`) with a
  single-node adapter plus a scalable one; see the table in `docs/PLAN.md`. Long work runs as a job
  (`s.jobs.register` / `enqueue`), reports progress with `ctx.progress`, and is idempotent enough to retry.
- Tenant content at rest (conversation text, attachments, export files) is sealed with `s.keys` under the tenant's
  scope with the row id as associated data. Only the gateway talks to Ollama.
- Cross-instance effects go through `s.bus` (`publish` for every instance, `emitLocal` for this one), never through
  module state.

## Console (`web/`)

- Same runtime model as the prototype: plain HTML/CSS/ES2017, classic `<script>` tags sharing the global `App`, no
  build step. `web/index.html` lists every screen's `<script>` tag by hand (there is no `build.mjs` here) and loads
  `/socket.io/socket.io.min.js`. No inline scripts (CSP).
- `web/js/app.js` extends the prototype shell with the API client (`App.get/post/patch/del`, CSRF header, problem
  details as `ApiError`, `App.fail` toast), `App.me` and `App.can(perm)`, the socket (`App.socket`), the notification
  bell and the workspace switcher (`App.switchWorkspace`), and the `NAV` entries' `perm`, `live` and `sprint` fields.
  A screen without `live: true` (on its `NAV` entry or its `App.register` definition) gets the "Prototype data"
  banner.
- The sidebar (2026-10-15) is an accordion built from `NAV_GROUPS` in `app.js`, which names `NAV_FLAT` items by id: a
  new screen gets its `NAV_FLAT` entry and its id in the right group (workspace groups, or an `admin: true` group),
  otherwise it shows under "Other". It collapses to a 64 px rail with group flyouts. Side panels need nothing: every
  `aside.inspector` and `.leftpane` gets its hide button from `App.decoratePanels`.
- Accessibility: `App.setA11y` and the `:root[data-a11y="aaa"]` tokens in `app.css` give the Enhanced (AAA) mode;
  `UI.field` labels its control and dialogs are `inert`-backed with focus return; `App.tabPanel` keeps a tab's content
  in one tabpanel. Keep new markup keyboard-operable and labelled (`docs/accessibility.md`): the e2e suite fails on any
  finding of its WCAG A/AA checker (`e2e/tests/support/a11y.ts`) or of axe-core (`e2e/tests/support/axe.ts`, Standard
  and Enhanced, light and dark), and on sideways scrolling at 320 and 640 px, for screens and, through
  `e2e/tests/y-reflow-overlays.spec.ts`, their dialogs and drawers.
- `web/js/screens/shared.js` is the signed-out page for anonymous share links (`#/shared`); `person.js` (1.5.0) is the
  Profile page (`#/person?user=<id>`), not in the sidebar, opened from people's names and swept like Settings.
- Live screens that receive socket events register their listeners on `App.socket` and remove them when the route
  changes; they don't re-render while a modal or drawer is open (a re-render closes it) and throttle re-renders while
  streaming. Uploads (`PUT /api/attachments`) use `fetch` directly, because `App.api` always sends JSON.
- To add a screen: write `web/js/screens/<id>.js` against the API, add a `NAV` entry if needed, and set `live: true`
  on it (or on the `App.register` definition) only when every control on it is backed by the server.
- **`docs/screen-contract.md` is the authoritative spec for writing a screen module.** It was the design prototype's
  `CONTRACT.md`; the prototype (`design/`) was removed on 2026-10-21 and is in
  `/Volumes/Impala/exprsn_backup/pre-cleanup/cleanup-2026-10-21.tar.gz`.

### Rules from the screen contract that are easy to miss

- Screens must not modify `app.js` or `app.css`. Put screen-only CSS in a `<style>` block inside `root`, with selectors
  prefixed by the screen id.
- Inline styles may use CSS variables only (`var(--fg)`, `--panel`, `--accent`, `--warn-bg`…), never literal colours.
- Handlers registered with `ctx.on` are dropped on every re-render and route change. Register them inside `render`
  each time. Keep UI state in `ctx.state` and re-render the whole screen after a change.
- Each board's "States to design from this page" section becomes the screen's `states` array, each with an `apply`.
  The console shows no way to pick them on the page (no strip at the foot of the page, no header "States" button);
  they exist for `App.applyState(i)`, which the accessibility suite drives.
- Reproduce the board faithfully and don't invent features, but make every control do something. Primary actions go
  through confirm → toast → visible change. Plain copy: no exclamation marks, emoji or lorem ipsum.
- Escape data with `UI.esc`, and use `type="button"` on buttons.

## Keeping docs current

When a sprint's work lands, update its row and section in `Sprints.md`, move screens to live in `web/js/app.js`, and
adjust `docs/security.md` "Known gaps" and this file if commands or structure changed.

`README.md` gives the status and the feature summary: update its first section when a release ships or a major
feature lands. Work since the last release is listed under Unreleased in `CHANGELOG.md`; each feature also raises the
version of its system doc under `scripts/system-docs/` (outside this repository).
