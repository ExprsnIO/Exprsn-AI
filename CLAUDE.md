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
server-only, and their console screens are planned in `Backlog-1.5.0.md`.
Every console screen is live. Sprint 29 (B-3401, `Backlog-1.5.0.md`) added the prototype boards for the 1.4.0 domains
(`files`, `apps`, `groups`, `messages`, `moderation`, `channels`, `roles`, `certificates`, `vault`, `plugins`, `atproto`,
plus identity additions to `signin`, `settings` and `identity`); they exist only in `design/prototype/` until their sprint
makes them live in `web/`. Check `Sprints.md` and the known gaps in `docs/security.md` before starting work.

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
npm run cli -w server -- <migrate [--check] | admin:create | audit:verify | kms:rotate | kms:rewrap | kms:escrow |
                             kms:recover | signer | backup:create | backup:restore-drill | backup:restore>
npm run test:integration -w server           # each block runs when its variable is set: TEST_PG_URL, TEST_MYSQL_URL,
                                             # TEST_LDAP_URL (+ TEST_LDAP_INSECURE, TEST_LDAP_BIND_PW), TEST_REDIS_URL,
                                             # TEST_MONGODB_URL (an account that may create users)
for f in web/js/*.js web/js/screens/*.js; do node --check "$f"; done   # console scripts must parse (CI checks this)
npx tsx server/loadtest/stream.ts --help   # streaming load test (docs/loadtest.md)
npm run loadtest:platform -- --help        # webhook, records, OCSP and firehose load test (docs/loadtest.md)
helm lint deploy/helm/exprsn-ai            # the chart (CI also renders it with kubeconform)
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
- **`authz/`**: `permissions.ts` (catalogue and the 13 built-in roles), `labels.ts`, `policy.ts` (the single decision
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
  step), **`media/`** (presets as argument arrays, `MediaRunner` over ffmpeg, `origin.ts` for the sandbox CSP and signed
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
- 1.5.0 modules: **`dav/`** (CalDAV and CardDAV at `/dav`, `docs/dav.md`: `handler.ts` the router and methods,
  `auth.ts` app-password Basic auth, `tree.ts` the namespace, `caldav.ts`, `carddav.ts`, `filters.ts` the query
  operators, `sync.ts`, `store.ts` personal collections and dead properties, `passwords.ts` and `routes.ts` for
  `/api/me/app-passwords`; the conformance fixtures are in `server/test/fixtures/dav/`).
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
- Accessibility: `App.setA11y` and the `:root[data-a11y="aaa"]` tokens in `app.css` give the Enhanced (AAA) mode;
  `UI.field` labels its control and dialogs are `inert`-backed with focus return; `App.tabPanel` keeps a tab's content
  in one tabpanel. Keep new markup keyboard-operable and labelled (`docs/accessibility.md`): the e2e suite fails on any
  finding of its WCAG A/AA checker (`e2e/tests/support/a11y.ts`) or of axe-core (`e2e/tests/support/axe.ts`, Standard
  and Enhanced, light and dark), and on sideways scrolling at 320 and 640 px, for screens and, through
  `e2e/tests/y-reflow-overlays.spec.ts`, their dialogs and drawers.
- `web/js/screens/shared.js` is the signed-out page for anonymous share links (`#/shared`).
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
