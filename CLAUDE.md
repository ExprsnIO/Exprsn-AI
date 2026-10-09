# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What's here

Exprsn-AI is a self-hosted, multi-tenant control plane and chat interface for Ollama-served models. The repository
has three parts:

| Path | What it is |
| --- | --- |
| `server/` | The application server (npm workspace `@exprsn-ai/server`): Node.js 22, TypeScript strict, Express 5, Socket.io 4, Knex |
| `web/` | The console the server serves: the prototype's screen modules, wired to the API screen by screen |
| `e2e/` | Playwright suite across every console screen (its own package, not a workspace member) |
| `design/prototype/` | The clickable design prototype. It is the specification for behaviour and copy, with example data only |
| `deploy/` | Dockerfile, Compose (production, development, GPU), Helm chart with NetworkPolicies, bare-metal systemd unit and installer, example identity YAML |
| `docs/` | `PLAN.md` (decisions and rules), `api.md` (every route from Sprint 2 on), `identity.md`, `security.md`, `deploy.md`, `asvs.md`, `accessibility.md`, `loadtest.md`, `training-worker.md`, `runbooks/` |
| `Sprints.md` | Sprint status: what each sprint delivered or will deliver, and which screens it makes live |

Sprints 0 to 9 are done (foundations; identity and access; tenancy, audit and platform services; the Ollama gateway,
models, pools and profiles; chat, compare and metering; guardrails, classifiers and flags; knowledge, memory and
connections; registry, MCP servers, agent runs and scripts; workflows, media and images; training, zones, platform
operations and federation), Sprint 10 (hardening: Helm chart, supply-chain CI, streaming load test, runbooks, the ASVS
L2 review in `docs/asvs.md`, AA/AAA accessibility modes in `docs/accessibility.md` and the Playwright suite in `e2e/`)
produced release candidate `1.0.0-rc.1`, and Sprints 11 to 15 (`Backlog-1.1.0.md`: account self-service and security
notices; streaming guardrails, held answers and resumable streams; the OpenAI-compatible API, webhooks, prompts,
sharing, export and billing; the second federation sprint; shared rate limits, key re-wrap, dns-01, blob backups and
restore) made version `1.1.0`. Sprints 16 to 19 (`Backlog-1.2.0.md`: `/v1` context and tools, the guard model while
streaming, held prompts, live and anonymous sharing; sign-in notices, the strength meter, upstream step-up, DPoP nonces,
SAML metadata, enrolment links and automated accessibility checks; service URL checks, backend TLS, consistent
backups, ACME binding and hooks, sealed training data; MySQL and replicated knowledge sources with row access, ordered
and Ed25519 webhooks, price books with Stripe reconciliation, awaited workflow tools) made version `1.2.0`. Sprints 20
to 23 (`Backlog-1.3.0.md`: the signer process, KMS-held webhook keys, HTTP Message Signatures and image provenance;
held `/v1` requests, the Responses API, evaluations and scheduled agents; tracing, dashboards and alerts, safe upgrades,
key escrow, zones applied in-cluster and an NTP quorum; S3 and web-crawl knowledge sources, PostgreSQL row security,
webhook order across instances, proration and Stripe refunds, axe-core and dialog reflow) are done in version `1.3.0`.
Sprints 24 to 28 (`Backlog-1.4.0.md`: exprsn-platform's server features: a certificate authority with OCSP and an
ACME server, a secrets vault with leases, the event catalogue and plugins; AT-Protocol keys, DIDs, labeler, sign-in and
firehose ingest; moderation actions and appeals, the file store, low-code data apps, groups and events,
customer-service channels, messaging and the workspace feed, and a platform load test) made version `1.4.0`; they are
server-only. Sprints 29 to 34 (`Backlog-1.5.0.md`: the console screens for the 1.4.0 domains, permission matrices,
custom roles and access reviews, CalDAV, CardDAV and WebDAV with DAV-only app passwords, model-based memory, MongoDB
connections, the AT-Protocol PDS and feed generators, import repositories and model import, Workflows 2 on the chain
context, chaining agents, skills, tools and workflows, profiles and presence, IMAP in CI) made version `1.5.0`; Sprint
33 moved to 1.7.0; B-3606 (capturing real DAV client traffic) was dropped. Sprints 35 to 39 (`Backlog-1.6.0.md`: model
servers beyond Ollama, platform administration screens, groups depth, blob deduplication, image classification, the HTTP
tool kind, prompt-injection defence, SCIM, the MCP server, the AI inventory, analytics, audit export, red-team suites,
agent identities, handoffs, policies, DLP, legal hold, content credentials, chat artifacts, app packages and promotion,
data model drafts, AI field fills, outside tables, entity APIs and app embedding) made version `1.6.0` (B-5001,
capability tokens, was dropped on 2026-10-07); Sprints 40 to 43 in
`Backlog-1.7.0.md`, with the exprsn-platform port items decided on 2026-10-06; Sprints 44 to 50 in `Backlog-2.0.0.md`.
Every console screen is live, plus the Person page opened from people's names. New screens start as boards in
`design/prototype/` and go live in `web/` when every control is backed by the server. Check `Sprints.md` and the known
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
                             kms:recover | signer | backup:create | backup:restore-drill | backup:restore>
npm run test:integration -w server           # each block runs when its variable is set: TEST_PG_URL, TEST_MYSQL_URL,
                                             # TEST_LDAP_URL (+ TEST_LDAP_INSECURE, TEST_LDAP_BIND_PW), TEST_REDIS_URL,
                                             # TEST_MONGODB_URL (an account that may create users)
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
and cosign-signs the image and attaches the SBOMs to the release (not yet run on GitHub; it assumes
`ghcr.io/<owner>/<repo>`).

Tests never need a real Ollama: `server/test/fake-ollama.ts` speaks enough of its API (version, tags, ps, show, pull,
delete, generate, streamed chat with thinking and tool calls) and is also handy for driving the console by hand
(start it from a small `npx tsx` script and register its URL as a pool instance).

Prototype commands, run from `design/prototype/`:

```sh
node build.mjs              # regenerate index.html, screens/<id>.html and dist/artifact.html from the sources
npm install && npm run smoke                        # Playwright: every screen, light + dark, every state; exit 1 on error
npm run shot -- <route> [out.png] [width] [dark]    # screenshot #/<route>, signed in
```

Run `node build.mjs` before smoke/shot. In cloud sessions set `CHROME=/opt/pw-browsers/chromium` and don't run
`playwright install`.

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
  `SIGNER_TOKEN` given inline (only their `_FILE` forms).
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
- **`platform/`**: the infrastructure interfaces from `docs/PLAN.md`: `kms.ts` (local, OpenBao transit),
  `datakeys.ts` (per-tenant envelope encryption, `Sealer`), `blob.ts` (filesystem, S3 SigV4), `jobs.ts` (`JobQueue`
  on the database or BullMQ, `Scheduler`), `bus.ts` (in-process events fanned out over Redis), `notifications.ts`,
  `email-templates.ts` (escaped plain-text and HTML mail), `ratelimit.ts` (counters in memory or one atomic Redis Lua
  script, shared by the rate limits, the failed-credential throttle and the denial cap), `rewrap.ts` (`kms:rewrap`),
  `ntp.ts` (SNTP skew).
- **`tenancy/`**: `quotas.ts` (limits, `admit` → 429, metering, usage reports), `offboarding.ts`.
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
  MySQL and OpenSearch drivers, query classification, masking, `dynamic.ts` for OpenBao dynamic database credentials) and
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
- 1.6.0 Sprint 35a: `gateway/server.ts` (the `ModelServer` interface, B-4301: `version`, `models`, `loaded`, `show`,
  `load`, `unload`, `pull`, `delete`, `chat`, `embed`; `Unsupported` for what a server cannot do, which the gateway,
  placements and the catalogue skip), `gateway/openai-server.ts` (B-4302, B-4303: `kind: openai` instances on a URL or a
  Unix socket with a vault-held bearer token, Chat Completions mapped onto the gateway's chat, the `instance.probe`
  job), `gateway/repo.ts` (instance kind, socket and token columns of `037_model_servers`), server-held catalogue
  entries (`format: server`, B-4304) in `routes/admin/gateway.ts`. `server/test/fake-openai-server.ts` stands in for
  `fm serve`, `mlx_lm.server` and `llama-server`.
- 1.6.0 Sprint 35c: `ops/storage.ts` (`s.storage`, B-4204: stores, usage by workspace, user and kind, quotas, the
  quarantine) and `ops/blob-integrity.ts` (the `ops.blobs.verify` job: missing, orphan and mismatched objects, the dry
  run and deletion, the copy-then-switch migration `ops.blobs.migrate` over `platform/blob-switch.ts`, the switchable
  store every process follows); `config/settings.ts` and `settings.generated.ts` (B-4205: the settings descriptor
  `npm run gen:settings -w server` writes, what each instance reports, database overrides under dual control applied
  before the services are built) behind `routes/admin/storage.ts` and `routes/admin/platform-settings.ts`.
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
  bucket, web site) the 1.3.0 ones; `sprint37b-fakes.ts` (an OAuth authorization server for the MCP client) and
  `fake-openai-server.ts` (a Chat Completions server) the 1.6.0 ones, with `sprint38c-policies-helpers.ts`,
  `sprint39b-helpers.ts` (the CRM app and its approval workflow), `sprint39c-helpers.ts` (`SqliteTableDriver` for
  outside tables) and `sprint39d-helpers.ts` (embed keys and a tenant CA) building the apps their suites share, and
  `sprint38a-siem.test.ts` starting real HTTPS and syslog-over-TLS receivers; `seed-gateway.ts` and
  `retrieval-seed.ts` seed pools, models and documents). `loopback.ts` and `setup-loopback.ts` (a Vitest setup file) serve each test app on 127.0.0.1
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
- Accessibility: `App.setA11y` and the `:root[data-a11y="aaa"]` tokens in `app.css` give the Enhanced (AAA) mode;
  `UI.field` labels its control and dialogs are `inert`-backed with focus return; `App.tabPanel` keeps a tab's content
  in one tabpanel. Keep new markup keyboard-operable and labelled (`docs/accessibility.md`): the e2e suite fails on any
  finding of its WCAG A/AA checker (`e2e/tests/support/a11y.ts`) or of axe-core (`e2e/tests/support/axe.ts`, Standard
  and Enhanced, light and dark), and on sideways scrolling at 320 and 640 px, for screens and, through
  `e2e/tests/y-reflow-overlays.spec.ts`, their dialogs and drawers.
- 1.6.0 console additions: `analytics.js` (the Analytics screen, B-7401), `embed.js` (the script of the public and
  signed embed pages served outside the console, B-8701), the Models screen's Inventory tab and Model servers
  drawer, the Usage and audit screen's Exports (JSONL exports, SIEM destinations) and Compliance (DLP, legal holds,
  compliance exports) tabs, the Apps screen's Policies, Deployments, API and Embed tabs beside Entities, Records,
  Forms and Triggers, the Chat inspector's Artifacts panel (also on `shared.js`), the Profiles and Registry red-team
  and identity dialogs, and `App.put` (the client had no PUT helper before Sprint 38b).
- `web/js/screens/shared.js` is the signed-out page for anonymous share links (`#/shared`); `person.js` (1.5.0) is the
  Profile page (`#/person?user=<id>`), not in the sidebar, opened from people's names and swept like Settings.
- Live screens that receive socket events register their listeners on `App.socket` and remove them when the route
  changes; they don't re-render while a modal or drawer is open (a re-render closes it) and throttle re-renders while
  streaming. Uploads (`PUT /api/attachments`) use `fetch` directly, because `App.api` always sends JSON.
- To make a screen live: copy or adapt it from `design/prototype/js/screens/<id>.js` into `web/js/screens/<id>.js`,
  replace `DATA` with API calls, set `live: true` on its `NAV` entry (or on the `App.register` definition), and only do
  so when every control on it is backed by the server. `directories.js` (User stores) exists only in `web/`.

## Design prototype (`design/prototype/`)

- `shell.html` is the source template; `build.mjs` inlines it into the committed outputs `index.html` and
  `screens/<id>.html` (plus gitignored `dist/artifact.html`). Never hand-edit the outputs; edit sources, rebuild,
  commit both.
- `js/app.js` holds the router (`#/<id>?params`), `NAV`, `DATA`, `UI` helpers, command palette (Ctrl K), prototype map
  (`?`), theme, toasts, modals, drawers and the "States" popover. Only the theme and `exprsn.signedIn` persist.
- **`CONTRACT.md` is the authoritative spec for writing a screen module** (in both `design/prototype/` and `web/`).
  Adding a prototype screen: add the module, add its `<script>` tag to `shell.html`, add a `NAV` entry if needed,
  rebuild.

### Rules from CONTRACT.md that are easy to miss

- Screens must not modify `app.js` or `app.css`. Put screen-only CSS in a `<style>` block inside `root`, with selectors
  prefixed by the screen id.
- Inline styles may use CSS variables only (`var(--fg)`, `--panel`, `--accent`, `--warn-bg`…), never literal colours.
- Handlers registered with `ctx.on` are dropped on every re-render and route change. Register them inside `render`
  each time. Keep UI state in `ctx.state` and re-render the whole screen after a change.
- Each board's "States to design from this page" section becomes the screen's `states` array, each with an `apply`.
  Neither the console nor (since Sprint 29) the prototype shows a way to pick them on the page (no strip at the foot
  of the page, no header "States" button); they exist for `App.applyState(i)`, which the accessibility suite and the
  prototype smoke drive, and the prototype lists them in its command palette.
- Reproduce the board faithfully and don't invent features, but make every control do something. Primary actions go
  through confirm → toast → visible change. Plain copy: no exclamation marks, emoji or lorem ipsum.
- Escape data with `UI.esc`, and use `type="button"` on buttons.

## Keeping docs current

When a sprint's work lands, update its row and section in `Sprints.md`, move screens to live in `web/js/app.js`, and
adjust `docs/security.md` "Known gaps" and this file if commands or structure changed.
