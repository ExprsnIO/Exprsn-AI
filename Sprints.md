# Sprints

Two-week sprints that turned the design prototype (removed on 2026-10-21) into the production application.
Architecture decisions and the rules every sprint follows are in [docs/PLAN.md](docs/PLAN.md). A console screen moves
from prototype data to live only when every control on it is backed by the server; until then it shows the
"Prototype data" banner with the sprint number below (set in the `NAV` table in `web/js/app.js`).

## Status

| Sprint | Theme | Screens made live | Status |
| --- | --- | --- | --- |
| 0 | Foundations | — | **Done** |
| 1 | Identity and access | Sign in, Settings, User stores (new) | **Done** |
| 2 | Tenancy, audit, platform services | Tenants, Usage and audit | **Done** |
| 3 | Ollama gateway, models, pools, profiles | Models, Pools, Profiles | **Done** |
| 4 | Chat, compare, metering | Chat, Compare | **Done** |
| 5 | Guardrails, classifiers, flags | Guardrails, Classifiers, Flags | **Done** |
| 6 | Knowledge, memory, connections | Knowledge, Memory, Connections | **Done** |
| 7 | Registry, MCP servers, agent runs, scripts | Registry, MCP servers, Runs, Scripts | **Done** |
| 8 | Workflows, media, images | Workflows, Media, Images | **Done** |
| 9 | Training, zones, platform, federation | Training, Zones, Platform, Identity | **Done** |
| 10 | Hardening and release | all | **Release candidate** (1.0.0-rc.1) |
| 11 | Account self-service and security notifications (1.1.0) | Sign in, Settings, User stores; accessibility in Chat, Workflows, Classifiers | **Done** |
| 12 | Chat: streaming guardrails, held answers, resumable streams, agent memory (1.1.0) | Chat, Flags, Tenants, Registry, Memory | **Done** |
| 13 | Integrations: OpenAI-compatible API, webhooks, prompts, sharing, export, billing (1.1.0) | Chat, Tenants, Usage and audit | **Done** |
| 14 | Federation, second part: grants, revocation, logout, PAR, DPoP, SAML SLO, KMS signing (1.1.0) | Settings, Identity | **Done** |
| 15 | Operations: shared rate limits, key re-wrap, dns-01, backups, streaming blobs, zones, connections (1.1.0) | Platform, Connections | **Done** |
| 16 | Chat and AI depth: `/v1` context and tools, guard model while streaming, held prompts, live and anonymous sharing, finer retention (1.2.0) | Chat, Flags, Tenants, Shared (new, signed out) | **Done** |
| 17 | Identity, security and accessibility: sign-in notices, strength meter, upstream step-up, DPoP nonces, SAML metadata, enrolment links, automated WCAG checks and reflow (1.2.0) | Sign in, Settings, User stores, Identity, Platform; accessibility in Pools, Media, Models, Workflows | **Done** |
| 18 | Platform hardening: service URL checks, backend TLS, consistent backups, ACME binding and hooks, sealed training data, input caps, zone re-checks, registry pushes (1.2.0) | Platform, Zones | **Done** |
| 19 | Knowledge, integrations and workflows: MySQL sources, row access, logical replication, ordered and Ed25519 webhooks, price books and Stripe reconciliation, awaited workflow tools (1.2.0) | Knowledge, Tenants, Usage and audit, Runs, Workflows, Images | **Done** |
| 20 | Keys and supply chain: a signer process, KMS-held webhook keys, HTTP Message Signatures, image provenance, `DATA_KEY` out of the environment (1.3.0) | Settings, Tenants | **Done** |
| 21 | AI: held `/v1` requests and compare prompts, the Responses API, evaluations, thinking at the full output check, membership changes ending watches, scheduled agents (1.3.0) | Compare, Flags, Profiles, Runs | **Done** |
| 22 | Operations: tracing, dashboards and alerts, safe upgrades, key escrow, zones applied in-cluster, NTP quorum, rate-limit health (1.3.0) | Platform, Zones | **Done** |
| 23 | Knowledge, integrations and accessibility: S3 and web-crawl sources, PostgreSQL row security, webhook order across instances, proration and Stripe refunds, axe-core and dialog reflow (1.3.0) | Knowledge, Usage and audit; accessibility in Profiles, Workflows and the header | **Done** |
| 24 | Trust foundations: CA issuance and OCSP, tenant secrets, the event catalogue and plugin manifests, core (1.4.0) | — (server only) | **Done** |
| 25 | ACME server, AT-Protocol keys, DIDs and labeler, secret leases, plugins (1.4.0) | — | **Done** |
| 26 | Identity gaps and AT-Protocol sign-in, moderation actions and appeals, file store (1.4.0) | — | **Done** |
| 27 | AT-Protocol firehose, low-code data apps, groups and events (1.4.0) | — | **Done** |
| 28 | Customer-service channels, messaging, workspace feed, load test, release (1.4.0) | — | **Done** |
| 29 | Permission matrices and custom roles, prototype boards, trust, identity, apps and files screens (1.5.0) | Certificates, Vault, Plugins and events, Apps, Files (new); Sign in, Settings, Identity | **Done** (screens in Sprint 30) |
| 30 | Domain screens; CalDAV and CardDAV; model-based memory management; MongoDB connections (1.5.0) | Moderation, Groups and events, Channels, Messages and feed, Roles and access (new); Memory, Connections | **Done** |
| 31 | AT-Protocol PDS and feed generator; import repositories and model import; RSVP race and relay commit signatures (1.5.0) | AT-Protocol (new); Models | **Done** |
| 32 | Workflows 2: chaining, agent and skill steps, event and schedule triggers, domain steps, map and loop, failure handling; app passwords; the chain context (1.5.0) | Workflows, Settings | **Done** |
| 33 | Moved to 1.7.0 on 2026-10-05 as Sprint 38 (now Sprint 40) | — | Moved |
| 34 | Chaining agents, skills, tools and workflows; WebDAV for the file store; profiles and presence; IMAP in CI; release (1.5.0) | Person (new); Runs, Registry, Settings, Messages and feed, Groups and events | **Done** (B-3606 dropped) |
| 35 | Platform administration live screens; tenant provisioning templates; model servers beyond Ollama (1.6.0) | Overview, Jobs and queues, Storage, Configuration, Social and messaging (new); Tenants; Models | **Done** |
| 36 | Groups depth and categories; blob deduplication; held form values queued; vault access anomalies; image classification in Knowledge (1.6.0) | Groups and events, Storage, Apps, Vault, Knowledge, Classifiers | **Done** |
| 36b | Model thinking templates; the tool-calling evaluation sends a system prompt (1.6.0; B-11707, pulled forward from 1.7.0 on 2026-10-08) | Models, Profiles | **Done** (2026-10-13) |
| 37 | Quote posts and per-post visibility; vault sharing and MongoDB leases; HTTP tool kind; prompt-injection defence; SCIM; MCP server and authorization (1.6.0) | Messages and feed, Vault, Registry, Guardrails, User stores, Settings, MCP servers | **Done** (B-7202 partial) |
| 38 | AI inventory; red-team harness; usage and cost analytics; compliance log export; agent identities; row and field permissions; DLP, legal hold and eDiscovery; agent handoffs (1.6.0) | Analytics (new); Models, Training, Usage and audit, Settings, Registry, Apps, Chat | **Done** |
| 39 | Image provenance; versioned artifacts; app packages, environments and promotion; data model generation; AI field upgrades; outside database sync; entity APIs; app embedding; release (1.6.0) | Images, Chat, Apps, Settings | **Done** |
| 40 | Agents, tools and skills in chat; dataset import, knowledge sets and the Import screen (1.7.0; Sprint 38 until 2026-10-07) | Chat, Import (new); Training, Classifiers, Knowledge | **Done** (2026-10-13; left out: B-4006 and model-proposed write tools in B-4003) |
| 41 | Redis for multi-process installs; workflows calling listed public hosts; the vault's system scope, leases and transit HMAC; dynamic API-key leases; held messages; evidence retention and legal hold; the guardrail rule builder (1.7.0) | Workflows, Vault, Messages and feed, Moderation, Files, Guardrails | **Done** (74 of 74 points deployed 2026-10-13) |
| 42 | Sessions, API keys, signing keys and third-party credentials in the vault; groups: bans, invite links, custom roles, group moderation, event extras, linked conversations (1.7.0) | Vault, Settings, Groups and events | **Done** (72 of 72 points: migrations `062` to `065` deployed 2026-10-13; B-9206 to B-9208, migrations `066` to `068`, deployed 2026-10-14, each vault move off until an admin takes its action) |
| 43 | Groups as access subjects; response cache; plugin UI surfaces; `did:exprsn`; cross-posting to the hosted PDS; release (1.7.0) | Groups and events, Files, Vault, Knowledge, Apps, Profiles, Jobs and queues, Plugins and events, AT-Protocol, Messages and feed | **Done** (2026-10-14; B-11401 built and documented, its live run on the public network left to the operator: `docs/deploy.md`) |
| 44–48 | 1.8.0 (`Backlog-1.8.0.md`): features of the platform's exprsn-svr rebuilt here: insight in Apps (charts, dashboards, reports, exports, scheduled delivery), data in (saved queries, REST sources, spreadsheet import, many-to-many), automation (webhook trigger for every workflow, decision tables, switch, approval deadlines and quorum, SLAs, run retention), builders' tools and access and safety | Apps, Connections, Workflows, Scripts, Knowledge, Files, Vault, Plugins, Overview | Sprints 46, 45, 47, 44 and 48 done (2026-10-15 and 16) |
| 49–55 | 1.9.0 (`Backlog-1.9.0.md`, planned 2026-10-16): push notifications, guardrails with spam and flood detection, group governance, feature flags, search, photo albums, billing, user stores, the CA and Auth configuration, leaked-password lists | — | Sprints 49 to 55 done (2026-10-16 to 18); 1.9.0 complete (Wikis moved to 2.1.0 on 2026-10-19) |
| QA-1 | 1.9.9-qa (`Backlog-1.9.9-qa.md`, planned 2026-10-19): the 1.9.0 open items, the platform CA signing fix, integration on PostgreSQL and MySQL, flaky tests; the QA release before 1.9.99-final | Search, Messages and feed, Groups, User stores, Analytics | **Done** (deployed 2026-10-20 as 1.9.9-qa; migrations `142` to `145`; the platform's CA signs whole tokens from the same day) |
| 56–62 | 1.9.99-final (`Backlog-1.9.99-final.md`, imported from 2.0.0 on 2026-10-19; ships as 2.0.0 (GM)): cloud deployments and integrations (AWS, Azure, DigitalOcean, Cloudflare; deployments with plan, apply, verify and drift; managed data; GPU pools; cloud model backends; the edge; FinOps) | — | **Done** (Sprints 56 to 62, 2026-10-20 to 21; released as 2.0.0 "GM") |
| — | 2.1.0 (`Backlog-2.1.0.md`, moved from 1.9.0 on 2026-10-19): Wikis (B-196 to B-211), after the 2.0.0 release | — | Planned |

**End-to-end tests (owner, 2026-10-06).** During a sprint, each part runs only the Playwright specs of the screens
it changes (with their accessibility and reflow checks); CI runs the full suite on every pull request. The full
local run, fixing what it finds, and the cross-screen sweeps belong to each major release's release item (1.6.0's
B-5101, 1.7.0's B-5901, and the same for 1.8.0 and later).

Current codebase: every sidebar screen is live (Chat, Compare, Runs, Knowledge, Memory, Workflows, Scripts, Media,
Images, Files, Apps, Groups and events, Messages and feed, Models, Profiles, Pools, Registry, MCP servers, Guardrails,
Flags, Classifiers, Moderation, Channels, Connections, Training, Tenants, Roles and access, User stores, Identity,
Certificates, Vault, Plugins and events, AT-Protocol, Zones, Usage and audit and Platform), plus Sign in, Settings
(with app passwords for DAV clients and the public profile and status), the Person page (a profile, opened from
people's names) and the signed-out Shared page for anonymous links; eighty-nine database migrations (`001_core` to
`059_evidence_holds`); 149 unit and API test files (1170 tests across 126 files, 1 skipped, at the 1.6.0 release; against a fake Ollama, a fake MCP server, fake
script, media, image and training workers, a fake ACME directory, a fake upstream identity provider, a fake OpenBao, a
fake OTLP collector, Kubernetes API, SNTP server and Redis, a fake S3 bucket and web site, fake mail, HIBP range,
webhook, Stripe, DNS, Harbor, Verdaccio and devpi endpoints, recorded DAV client exchanges and the AT-Protocol interop
vectors) plus the integration suite against PostgreSQL, MySQL, OpenLDAP, Redis, MongoDB and GreenMail (IMAP),
`litmus` for WebDAV and the PDS against the reference AppView in CI; over 100 Playwright tests across the console,
including axe-core, the in-page accessibility checker and the reflow checks for screens, dialogs and drawers; a Helm
chart with an optional signer sidecar, supply-chain CI, Prometheus rules and Grafana dashboards, a streaming load test
and a platform load test. The version is `1.7.0` (Sprints 40 to 43, [below](#release-170)); next are Sprints 44 to 48 (1.8.0, [backlog](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.8.0.md)), then 49 to 55 (2.0.0): Sprints 29 to 34 delivered the [1.5.0 backlog](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.5.0.md)
(Sprint 33 moved to 1.7.0), after Sprints 24 to 28 delivered the server-only [1.4.0 backlog](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.4.0.md),
Sprints 20 to 23 the [1.3.0 backlog](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.3.0.md), Sprints 16 to 19 the [1.2.0 backlog](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.2.0.md) and
Sprints 11 to 15 the [1.1.0 backlog](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.1.0.md). Sprints 35 to 39 are done and released as 1.6.0 from the
[1.6.0 backlog](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.6.0.md): the platform administration screens, model servers beyond Ollama, groups depth,
tenant templates, blob deduplication, vault extras and image classification (groomed 2026-10-05 with
`design/grooming/groom.mjs`; capability tokens, B-5001, were dropped on 2026-10-07), an HTTP tool kind, and the
industry and low-code gaps from the 2026-10-05 research (prompt-injection defence, red-teaming, MCP server and
authorization, SCIM, an AI inventory, usage analytics, compliance export, DLP and eDiscovery, agent identities and
handoffs, image provenance, versioned artifacts, row and field permissions, app environments and promotion, data model
generation, AI field upgrades, outside database sync, entity APIs and app embedding). Sprints 40 to 43 are in the
[1.7.0 backlog](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.7.0.md): agents, tools and skills in chat, dataset import, and the rest of the exprsn-platform
port the owner decided on 2026-10-06 (Redis for multi-process installs, the vault for signing keys and session tokens,
held messages, evidence retention, groups features and groups as access subjects, workflows calling listed public
hosts, API-key leases, a response cache, a guardrail rule builder, plugin UI surfaces, `did:exprsn` and cross-posting
to the hosted PDS). Sprints 44 to 48 are in the [1.8.0 backlog](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.8.0.md) and Sprints 49 to 55 in the [2.0.0 backlog](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-2.0.0.md): cloud deployments and
integrations.

---

## Sprint 0: Foundations (done)

Delivered in `server/`, `deploy/` and `.github/workflows/ci.yml`:

- npm workspaces; TypeScript strict, ESLint, Vitest.
- zod-validated configuration (`server/src/config`) with `*_FILE` variants for secrets.
- Express 5 with Helmet (strict CSP, HSTS behind HTTPS), compression, per-user and per-address rate limits, W3C trace
  ids, RFC 9457 problem+json errors, pino logs with redaction.
- `/healthz`, `/readyz` (database and migrations), `/metrics` (Prometheus, token-protected).
- Knex for PostgreSQL, MySQL and SQLite with the core migration (tenants, workspaces, identity providers, users and
  identities, local credentials, group mappings, roles, sessions, API keys, second factors, login throttle, audit).
- Socket.io on the same server with the cookie-session handshake; graceful shutdown.
- `exprsn-ai` CLI: `migrate`, `admin:create`, `audit:verify`.
- Dockerfile; Compose for production (app, PostgreSQL, Ollama on internal networks), development (seeded OpenLDAP,
  PostgreSQL and MySQL user stores) and GPU; systemd unit and installer for bare metal.
- CI: lint, typecheck, unit tests, build, console parse check; integration job against real PostgreSQL, MySQL and
  OpenLDAP; container image job that must answer `/readyz`.

## Sprint 1: Identity and access (done)

Delivered in `server/src/identity`, `server/src/authz`, `server/src/audit`, `server/src/routes` and the live console
screens `signin.js`, `settings.js` and `directories.js`. Details in [docs/identity.md](docs/identity.md) and
[docs/security.md](docs/security.md).

- User-store adapters: OpenLDAP (service bind → search → user bind → groups; RFC 4515 escaping; empty passwords
  refused; LDAPS/StartTLS required outside development), SQL user tables on PostgreSQL, MySQL and SQLite
  (configurable columns and group sources; argon2 and bcrypt only; bound parameters), and local accounts.
- Ordered chain per tenant: unknown user → next store; wrong password in the owning store → stop; broken store →
  skipped and reported; equal timing when no store knows the user. Stores can also be declared in the identity YAML
  (`IDENTITY_CONFIG`) and are then managed by config.
- Just-in-time provisioning keyed on (store, external id); a username already linked to another store is refused.
  Group mappings give the union of roles and the highest clearance; stores without groups may grant default
  (non-admin) roles.
- Sessions: opaque cookie token, HMAC'd at rest, `__Host-` httpOnly SameSite=Strict, idle and absolute timeouts, token
  rotation when a second factor completes; CSRF double-submit bound to the session; Origin checks.
- Second factors: TOTP (single use per time step), WebAuthn passkeys, recovery codes. Admin roles must enrol at first
  sign-in and cannot use admin routes without a verified factor.
- Lockout per account and per address, stored in the database so every instance shares it.
- API keys `exai_k1_…`: shown once, HMAC'd, scoped to a subset of the owner's permissions and re-intersected on every
  request; revoked with the owner's disablement.
- The 13 built-in roles and grant rules (only a system admin grants system admin; admins cannot change their own
  access); one policy pipeline (role → scopes → tenant → clearance → zone ceiling).
- Audit hash chain with verification, and clearance redaction when reading it.
- API: `/api/auth/*`, `/api/me/*`, `/api/admin/{identity-providers, test-login, group-mappings, roles, users,
  sessions, audit}`.
- Console: **Sign in** (password, second factor, first-time enrolment), **Settings** (profile, appearance, factors,
  API keys, sessions) and the new **User stores** screen (stores: add, edit, order, enable, test connection; group
  mappings; users: roles, clearance, disable, reset factors, local accounts; sessions: revoke; "Test a login").

Carried forward to Sprint 2 (and delivered there): directory sync, the Socket.io Redis adapter, and replacing
`DATA_KEY` with the KMS.

## Sprint 2: Tenancy, audit and platform services (done)

Delivered in `server/src/platform`, `server/src/tenancy`, `server/src/audit`, `server/src/identity/sync.ts`,
`server/src/routes/admin/{tenants,usage,audit}.ts` and the live console screens `tenants.js` and `usage-audit.js`.
API in [docs/api.md](docs/api.md).

- Tenants and workspaces: system admins create, rename, disable and offboard tenants; tenant admins create, edit and
  archive workspaces (label ceiling, tenant-wide or members-only), add and remove members, and map directory groups
  to a workspace. The shell's workspace switcher stores the choice in the session (`X-Workspace` for API keys).
- Quotas per tenant and per workspace (tokens per day, GPU-seconds per month, training GPU-hours per month), nested
  under the tenant's, enforced on every chat and compare request with `429`, `Retry-After` and a problem naming the
  limit and who can raise it. Usage is metered per tenant, workspace, user, model and profile.
- Usage and audit: usage by user, model, workspace, profile and tenant; daily tokens; audit filters (kind, action,
  actor, label, time); the full event; chain verification against signed checkpoints (KMS HMAC, copy in the blob
  store; hourly and on demand) with notification of tenant admins and auditors when it breaks; corrections as linked
  rows; CSV exports produced by a job, sealed, never above the requester's clearance (blocked with the count, or
  filtered); the SIEM stream (NDJSON over HTTPS).
- `Kms` with local and OpenBao transit adapters and per-tenant envelope data keys: versioned, rotatable
  (`exprsn-ai kms:rotate`), destroyed at offboarding with every instance dropping cached copies. TOTP seeds moved from
  `DATA_KEY` to the platform data key (older seeds still open).
- `BlobStore` (filesystem, and S3-compatible with SigV4 over fetch); `JobQueue` (database polling, or BullMQ on
  Redis) with retries, cancellation, stale-lock recovery and progress pushed to the submitter's sockets; a
  deduplicating scheduler so several instances enqueue a recurring job once.
- Notifications stored per user, pushed over the socket (the console's bell), and emailed over SMTP when configured.
- Redis: the Socket.io adapter and a cross-instance bus (session revocation, job cancellation, chat stop,
  notifications), so several instances can run behind a load balancer.
- Directory sync (hourly by default, or on demand per store): disables users removed from the store or from every
  mapped group and revokes their sessions and keys, refreshes roles, workspaces and clearance for the rest, never
  disables anyone when the store cannot be read, and stops if a run would disable more than half of a store's users.
- Offboarding in three steps: export, destroy the tenant key, then a purge job for conversations, attachments,
  exports and notifications (the audit chain and usage stay); the tenant ends `offboarded` and cannot be re-enabled.
- `/readyz` also checks the KMS and the blob store; the effective-permission explainer
  (`POST /api/admin/authz/evaluate`) shows every step of the policy for a user.

**Done when:** a tenant admin can create a workspace, set a quota and watch a request get 429; an auditor can verify
the chain and export only what their clearance allows. Both are covered by tests (`tenancy.test.ts`,
`chat.test.ts`).

## Sprint 3: Ollama gateway, models, pools, profiles (done)

Delivered in `server/src/gateway`, `server/src/routes/admin/gateway.ts` and the live console screens `models.js`,
`pools.js` and `profiles.js`.

- Pools (accelerator, zone, label ceiling) and instances for Docker and bare-metal Ollama, with optional mutual TLS
  (CA, client certificate and key per instance) and the node's settings (memory, parallel requests, maximum loaded
  models, context, KV cache type, keep-alive).
- A poller of `/api/version`, `/api/ps` and `/api/tags` (every 5 s by default) keeping health (healthy, degraded,
  unreachable), versions, residency and what is pulled, and recording models that disappear without an unload as
  evicted; `pools.state` socket updates for the Pools screen.
- Load, pin, unload and drain through `keep_alive`; a memory planner (fits, fits after evicting warm models, never
  evicts pinned ones) and estimate drift against measured memory; an anti-thrash limit of loads per instance per ten
  minutes; slot accounting per instance with a queue (and the caller's place in it); load and eviction history
  ("why is this cold?").
- The model catalogue with lifecycle draft → evaluated → approved → deprecated → retired: import requests (pickle
  sources refused), pulls by job with progress, digest verification against the digest pinned in the request (the
  blob is deleted on a mismatch), GGUF/safetensors only, a conformance run (chat smoke test and tool calling;
  failing tool calling withholds tools), a recorded licence, and dual-control approval. Retiring removes a model
  from routing.
- Placements of models on pools with residency (pinned, warm, cold), refused above the pool's label ceiling.
- Profiles per tenant: model, pool, `num_ctx`, temperature, system prompt, thinking default and ceiling, a fallback
  chain after a queue wait, the built-in calculate tool, a label, aliases, a canary share of requests to another
  approved model (promote or stop), and every change as a version with rollback. Publishing checks the model's
  approval and capabilities and that a pool cleared for the profile's label runs it.
- Rolling Ollama upgrade by job: one instance at a time is drained, waited for until it reports the target version,
  given back its pinned models and returned to service.

**Done when:** a model admin approves a model, places it on a pool, and a profile routes to it (`gateway.test.ts`).

## Sprint 4: Chat, compare, metering (done)

Delivered in `server/src/chat`, `server/src/routes/chat.ts` and the live console screens `chat.js` and `compare.js`.

- Conversations as message trees (edits and regenerations are branches; the head is the leaf being viewed), scoped to
  the author and the current workspace; titles, content, thinking and calculation steps sealed with the tenant key.
- The profile picker lists published profiles the user is cleared for; a conversation's label (a high-water mark,
  raised by attachments) must not exceed the profile's label.
- Token streaming over Socket.io with per-message sequence numbers; `chat.status` (queued with position, loading
  on a cold start, fallback, streaming) and `chat.done` with usage; catch-up and resume through the stream endpoint.
- Stop (partial answers kept and metered by estimate), regenerate (optionally with another profile or thinking
  level), edit, and branch switching.
- Thinking levels capped by the profile's ceiling, streamed separately from the answer.
- Attachments: raw upload into sealed quarantine, a scan job (type detected from the bytes, ClamAV when configured,
  classification for payment cards, IBANs, national identifiers, emails and phone numbers), then ready or rejected;
  text is given to the model as labelled context, images to vision models.
- Usage recorded once per answer on the final chunk (prompt, output and thinking tokens, calculator calls,
  GPU-milliseconds); quotas checked before every request.
- Compare: one prompt to 2–4 profiles in parallel, each column streamed, stoppable, regenerable and metered on its
  own.
- The exact-calculation worker: a rational-arithmetic evaluator in a worker thread with memory and time limits,
  offered to models as the `calculate` tool and at `POST /api/calculate`.

Guardrails on prompts and answers arrived in Sprint 5, and knowledge, memory and tool bindings in chat in Sprints 6
and 7. Still open (see `docs/security.md`, known gaps): continuing a stream on another instance after the serving
instance stops.

## Sprint 5: Guardrails, classifiers, flags (done)

Delivered in `server/src/guardrails`, `server/src/routes/guardrails.ts` and the live console screens `guardrails.js`,
`flags.js` and `classifiers.js`.

- The checkpoint seam `s.guardrails.check` behind every feature, over the eleven checkpoints. Published rule sets apply
  in the order platform baseline, tenant, workspace, agent; the most restrictive enforced finding wins, and a tenant
  cannot relax a baseline rule.
- Mechanisms: RE2 patterns (an invalid pattern is reported with its position, the message and an equivalent), PII and
  secrets detectors with checksums and entropy, label checks, budgets, allow-lists, checkpoint facts, classifiers with
  thresholds, and the guard model through the gateway. Actions allow, log, warn, flag, redact, require-approval, block.
- Shadow and enforce (shadow never changes the outcome and a sample of its findings is flagged); fail closed per
  rule's onError, with confidential and tool-calling turns held and every fail-open decision flagged.
- Versioned rule sets: drafts edited in a form or as YAML, diff, withdraw, publish; the platform baseline publishes
  only when a second platform guardrail admin approves; live test of a rule on sample text (spans and score); shadow
  replay of a draft over recorded, sealed inputs as a job; promotion to enforce refused above a 10% false-positive rate.
- Classifiers: deterministic, trained linear, guard-model and LLM engines in one registry, thresholds, a synchronous
  classify endpoint, evaluation and training jobs with precision and recall per tenant, labelled cases (sealed),
  publishing gated on 200 samples per label, tenant names for the four levels.
- The flag queue: SLA timers by severity with a breach notice, clearance redaction (reassign only above clearance),
  confirm into an eval case, dismiss as a false positive, escalate, reassign, send to eval set, user reports, live
  updates over the socket.
- Chat checks user input before sending (block refuses, redact stores and sends the redacted text) and model output
  on the finished answer (block replaces the answer with a notice, redact replaces the spans, flags are raised).

**Done when:** a secret in a prompt is refused with the rule named, a PII rule redacts the prompt before the model sees
it, an unsafe answer judged by the guard model is withheld, a confidential turn is held while the guard model is down,
and a reviewer confirms a flag into an eval case from the queue (`guardrails.test.ts`).

## Sprint 6: Knowledge, memory, connections (done)

Delivered in `server/src/knowledge`, `server/src/memory`, `server/src/connections`, `server/src/platform/vectors.ts`,
`server/src/chat/context.ts`, `server/src/routes/{knowledge,memory}.ts`, `server/src/routes/admin/connections.ts`,
migration `006_knowledge` and the live console screens `knowledge.js`, `memory.js` and `connections.js`.

- Knowledge bases with a label floor, workspace scope and sharing (members or curators only; grants to workspaces,
  users and profiles); draft and published, and only published bases are used in chat.
- Sources: upload (sealed quarantine, type from the bytes, ClamAV when configured, classification), S3 prefixes with
  the platform's credentials, Git repositories over https (shallow clone by job), and PostgreSQL views through a data
  connection's allow-list, synced by watermark; unchanged documents skipped by version or content hash; schedules.
- Extraction (text, Markdown, CSV, JSON, HTML, DOCX, PDF text layer) and structure-aware chunking with headings as
  metadata; embeddings through the gateway, cached by content hash for 30 days.
- `VectorStore`: a table scan in the database, or pgvector on PostgreSQL when the extension is available.
- Hybrid search (vector plus BM25 over keyed-hash terms) fused with reciprocal rank fusion and optional model
  reranking, with the clearance filter inside every query; blue/green reindex by job with an atomic switch and
  cancel; relabelling never below the classifier's finding.
- Chat: published bases attached to a conversation or profile add labelled, delimited context through the `context`
  checkpoint, raise the conversation label and record sealed citations; accepted memories are included.
- Memory: user and workspace scopes (members propose, curators accept), agent memories, proposals extracted after
  each answer, the `memory` checkpoint on write and read (restricted and credentials refused), versions, expiry and an
  hourly purge, forget across every backend with audit, export by job.
- Data connections for PostgreSQL and OpenSearch: sealed credentials, test (a read-only account is checked), schema
  introspection and allow-lists, query classification (writes, DDL, several statements, objects and functions
  outside the allow-list refused; unparsed syntax only after confirmation), the `db-query` checkpoint, read-only
  transaction, row caps, statement timeouts, PII masking, CSV export through the `export` checkpoint; every query
  audited.

**Done when:** a curator builds a knowledge base from an upload, S3, Git or a Postgres view, reindexes it with another
embedding model while it keeps serving, and a chat answer cites its chunks only up to the reader's clearance; a user
accepts, edits, exports and forgets memories; a connection admin browses an allow-listed view read-only and every
refused write is audited (`knowledge.test.ts`, `memory.test.ts`, `connections.test.ts`).

## Sprint 7: Registry, MCP servers, runs, scripts (done)

Delivered in `server/src/registry`, `server/src/mcp`, `server/src/agents`, `server/src/scripts`, the routes
`routes/admin/registry.ts`, `routes/admin/mcp.ts`, `routes/agents.ts`, `routes/scripts.ts`, migration `007_registry`
and the live console screens `registry.js`, `mcp-servers.js`, `runs.js` and `scripts.js`.

- Registry entries (tools, skills, agents): draft → in review → published → deprecated → retired (and restore), versions,
  JSON Schema input and output, side-effect class, label ceiling, automated checks (required fields, schema validity,
  description quality, side effect declared, secrets scan, referenced tools published, limits), review by a tool admin
  other than the author, publish scope (tenant or named workspaces under their ceiling), and a test harness. The
  built-in `calculate` is a published platform tool.
- MCP servers over streamable HTTP (JSON and SSE responses, sessions, pagination) on internal hosts only: DNS resolved
  and every address checked at registration and on each connection, with `MCP_ALLOWED_HOSTS` for exceptions. Tools are
  hashed and wait for review; a polling job disables approved tools whose schema changes until they are re-approved.
  Service credentials and per-user vault tokens are sealed and never returned or shown to models.
- One tool dispatcher for chat, agents and the harness: argument validation, label ceiling, rate limit, the
  `tool-call` guardrail checkpoint, approval for write and destructive calls, output schema check.
- Agent runs as jobs with think/do/calc lanes, approvals that pause and resume the run, budgets (steps, tokens, wall
  time, tool calls) with raise-and-resume, a checkpoint after every step, replay from any checkpoint, cancel, live
  steps over Socket.io, and metering.
- Scripts: versions sealed at rest, the `script` guardrail checkpoint, blocked-module and secrets checks, runs as jobs
  through a `ScriptRunner` (docker or podman with no network, read-only root, non-root user, dropped capabilities,
  memory/CPU/pids/time/output limits; a fake runner for tests), promotion draft → tested → registry tool.
- Chat: profiles may bind published registry and MCP tools; read-only tools that need no confirmation are offered in
  chat through the dispatcher.

**Done when:** a script can be promoted to a tool, reviewed by a second tool admin and published; an MCP tool whose
schema changes is disabled until re-approved; and an agent run pauses for approval of a write call, resumes, and can
be replayed from a checkpoint (`registry.test.ts`, `mcp.test.ts`, `agents.test.ts`, `scripts.test.ts`).

## Sprint 8: Workflows, media, images (done)

Delivered in `server/src/workflows`, `server/src/media`, `server/src/images`, `server/src/routes/{workflows,media,images}.ts`
(migration `008_workflows`) and the live console screens `workflows.js`, `media.js` and `images.js`.

- Workflow graphs with typed ports, a draft (revisioned, 409 on a stale save) and published versions; publish
  validation that points at the step and edge: one trigger, acyclic, port schemas along every edge, label ceilings
  along every path (profiles' labels included), 40 steps, fan-out 10, 30 min per step, 2 h and 200k tokens per run,
  template references to upstream steps only.
- Step kinds: trigger, model (a published profile through the gateway, metered, quota-admitted), transform, branch,
  guardrail check (block fails, redact passes on, require-approval pauses), approval (role, timeout, data shown),
  HTTP to internal addresses only (never link-local or public, host not templated), calculate, wait, and tool.
- Durable execution as jobs: each step's output checkpointed sealed with the tenant key; after a restart a run resumes
  after its last checkpoint without re-running completed steps; approvals and waits pause without holding a worker;
  expired approvals fail the run; cancel.
- Dry runs of the draft (models and HTTP mocked, nothing metered, the owner decides approvals); replay from any step
  reusing upstream checkpoints; run history and live `workflow.run` / `workflow.step` socket events.
- Media: uploads streamed into sealed quarantine, containers recognised from their bytes, ffprobe caps (duration,
  resolution, streams, size) enforced before any processing, metadata stripped, previews drawn; presets
  (`clip-720p`, `transcribe-srt`, `frames-1fps`, `normalise-audio`) as typed parameter schemas that build argument
  arrays (no shell, no free-form options); NVENC with a CPU fallback; jobs with progress; sealed outputs; frames through
  the image-safety classifier and transcripts through the `media` checkpoint. `MediaRunner` has the ffmpeg-process
  adapter and a test fake.
- Images: `ImageBackend` with ComfyUI and diffusers-style HTTP adapters and a test fake; the `image` checkpoint on the
  prompt; GPU-second quota admission and metering; a safety classifier on the output (unsafe images discarded, still
  metered, audited, raised to reviewers); a KMS-signed provenance manifest in the PNG and beside it; images sealed at
  rest; send to chat as an attachment.

**Done when:** a workflow with a model step, a branch and an approval publishes, runs, pauses for the approver, resumes
after an instance restart without repeating steps, and replays from a step; a clip is probed, refused above a cap or
processed by a preset with progress; an image is generated, classified, signed, sealed and metered in GPU-seconds
(`workflows.test.ts`, `media.test.ts`, `images.test.ts`).

### Links between Sprints 5 to 8

Sprints 5 to 8 were built side by side against one guardrail seam (`server/src/guardrails/types.ts`,
`s.guardrails.check`), then connected:

- Workflow tool steps call published registry and MCP tools through the dispatcher (argument schema, `tool-call`
  checkpoint, rate limit); a write tool runs only after an approval step on every path, or pauses the run for one.
- A published workflow can be published as a registry tool (`impl: 'workflow'`, pinned to its version, reviewed like
  any tool); calling it runs the workflow within five minutes and returns its output. Workflows cannot call workflow
  tools.
- A media transcript can be sent to a knowledge base the user curates, keeping its label.
- Chat has a knowledge picker per conversation, `[n]` citation markers and a Sources list under each answer.
- Agent runs read the agent's accepted memories through the `memory` checkpoint.

## Sprint 9: Training, zones, platform, federation (done)

Built side by side on shared scaffolding (migrations `009_training` to `012_federation`, services in `services.ts`
reading their collaborators through `s`, and the Sprint 9 blocks in `config/index.ts`).

### Training

Delivered in `server/src/training` (`service.ts`, `trainer.ts`, `scrub.ts`, `calendar.ts`), `server/src/routes/training.ts`
(migration `009_training`) and the live console screen `training.js`.

- Dataset versions with a manifest (rows, sha256 hash, label, source, splits, PII-scrub summary, tenant opt-in):
  rows inline or JSON Lines from the blob store's staging area; a job masks PII with the guardrail detectors, seals the
  rows and the scrub report (counts, rows and fields, never values) with the tenant key and deletes the unscrubbed
  input; conversation data only with the tenant admin's opt-in and at or below the base model's label; withdraw
  (rows deleted, unfinished jobs cancelled); report reads audited.
- Training jobs as durable pipeline state (base model, dataset version, LoRA/QLoRA/full, trainer, hardware, max
  duration, priority, deadline, packaging, canary): approval by a different ML admin, cleared for the label, before any
  training on confidential or restricted data; pause (checkpoint, GPUs released), run or resume now, cancel, retry
  from the checkpoint with a change (4 GPUs, half micro-batch, sequence length 4,096); preemption by the worker, by a
  higher-priority job or at window close always checkpoints and resumes from that step, not from zero.
- The orchestrator tick (`training.tick`): windows (always, daily, weekly; UTC) that lend a gateway pool through the
  existing drain, undrain and pinned load operations; run sync with loss series and progress on the socket
  (`train.progress`); GPU time metered as `training` usage against the tenant's training GPU-hours (429 on admission,
  checkpoint and preempt when used up while running, maximum duration enforced); recurring schedules (cron, "only when
  the dataset version changed", enable and pause); fair-share queue ordering (priority, then tenant GPU-hours this
  month, then deadline).
- Evals per hardware class (the accelerators of pools cleared for the job's label) with per-tenant thresholds; a
  failing suite stops the pipeline before registration and is recorded on the model card; re-run evals registers on a
  pass. GGUF conversion on the worker, then registration as a draft in the gateway catalogue (digest pinned, label,
  licence and family from the base) with a KMS-signed card manifest; the model admins' pull, evaluation and dual-control
  approval follow, and the job's stage follows the model through approval and canary.
- `TrainerBackend`: the HTTP contract to the Python GPU worker (info, submit, status, checkpoint, cancel, evaluate,
  convert) with an HTTP adapter, an unavailable adapter when `TRAINER_URL` is unset (jobs say so), and a test fake.
  New settings: `TRAINER_URL`, `TRAINER_TOKEN`, `TRAINER_TIMEOUT_MS`, `TRAINING_TICK_SECONDS`.

**Done when:** a job on a confidential dataset waits until a different ML admin approves it; a preempted or paused job
resumes from its checkpoint; an eval below threshold blocks registration and is on the model card; a passing job is
converted and registered as a draft model; a tenant over its training GPU-hours gets 429 (`server/test/training.test.ts`).

### Zones

Delivered in `server/src/zones` (`spec.ts`, `render.ts`, `service.ts`), `server/src/routes/admin/zones.ts`, additive
changes to the gateway and policy (`zoneAdmits`), and the live console screen `zones.js`.

- Zone definitions (`server/src/zones/`, migration `010_zones`): contents, CIDRs, trust (private or external), label
  ceiling, accepted sources, egress (deny or allow-list), peers with transport and mTLS, Compose services. Pools,
  connections and MCP servers join a zone through their existing `zone` column.
- Versioned with dual control: a proposal (a patch over the current version, optionally moving pools in) creates a
  draft; a second system admin approves it (the proposer cannot), or it is rejected or withdrawn. Other system admins
  are notified. Every change is audited (`zone.proposed`, `zone.approved`, `zone.rejected`, `zone.withdrawn`,
  `zone.seeded`, `zone.endpoint.*`).
- Validation of the whole set on proposal and again on approval: references, peer links for zone-to-zone rules,
  egress accepted by its target, overlapping CIDRs, one zone per service; the external zone exists in the schema,
  stays empty and is capped at internal; in the air-gapped posture (`ZONES_AIR_GAPPED`) no zone has internet ingress or
  egress. Lowering a ceiling is refused while pools, placements, profiles or connections above it are in the zone, and
  the problem lists them ("Ceiling too low").
- Zone ceilings are enforced: the gateway never routes data above a pool's zone ceiling (the policy zone step,
  `zoneAdmits`, `403 step: zone`); pools cannot be created in or moved to a zone whose ceiling is below theirs, to the
  external zone, or to an undefined zone once zones exist; placements and profile publication use the effective ceiling.
- Rendered configuration per zone and for the whole set, with line diffs between versions and downloads: Kubernetes
  Namespace and default-deny NetworkPolicy, Compose networks and service networks (matching
  `deploy/docker/compose.yml`), and nftables tables for bare-metal hosts.
- Endpoint health: pool instances from the gateway poller, registered static endpoints checked by the `zones.health`
  job (HTTP GET or TCP connect, unhealthy after `ZONE_HEALTH_FAILURES` failures), connections and MCP servers from
  their own checks. Unhealthy members are marked on the map and in the table; instances and endpoints can be drained.
- The default zone set (edge, app, data, directory, inference, sandbox, training, external) is offered by a "Seed
  default zones" action, not applied by a migration: seeding only creates missing zones and raises a default ceiling
  to what a zone already holds, so it never refuses a request that worked before.
- The Zones console screen is live: map, table, inspector, ceiling change with refusal list, peers, pools, endpoint
  health with drain, definition, propose (field change or new zone), rendered diff with approve, reject or withdraw,
  downloads.

**Done when:** a zone change is proposed, diffed and approved by a second system admin; lowering a ceiling below what a
zone holds is refused with the list of blockers; the gateway refuses data above a zone ceiling (`zones.test.ts`).

### Platform

Delivered in `server/src/ops` (`bundles.ts`, `mirrors.ts`, `certs.ts`, `acme.ts`, `backups.ts`, `der.ts`, `tar.ts`),
`server/src/routes/admin/platform.ts`, the CLI and the live console screen `platform.js`.

- **Signed import bundles.** A bundle is a tar with `manifest.json` (files with sha256 and size, target mirror,
  CycloneDX SBOM) and `manifest.sig` (detached Ed25519 or ECDSA P-256 signature) first, then `files/…`. System
  admins register and revoke the offline signer keys (audited). Uploading a transfer queues a verification job with
  seven recorded steps: transfer received, signature against the registered keys (a failure rejects the bundle
  before anything past the signature is read, showing the expected and actual signer), digests against the
  manifest (missing, extra and altered files), SBOM and vulnerability scan (Trivy when `PLATFORM_TRIVY_BIN` is set,
  failing at `PLATFORM_SCAN_FAIL_SEVERITY`; otherwise the step shows "not configured"), licence check against
  `PLATFORM_LICENCE_ALLOW` (SPDX expressions), staging deploy (an internal hook at `PLATFORM_STAGING_URL`, or "not
  configured"), and promotion. Promotion is a separate admin action that checks digest and signature again and
  writes each file content-addressed into the mirror store. Expedited imports (security ticket required) skip the
  cadence, not the checks. Rejections notify system admins; quarantined bundles can be deleted with the rejection
  and both fingerprints kept in the audit chain.
- **Mirrors.** A registry of internal mirrors (images and charts, npm, PyPI wheels, Trivy DB, model weights, OS
  packages, OpenTofu providers) with store, URL, consumer and a freshness policy (7 days by default; model weights
  never go stale). Freshness comes from the last promotion; URLs must resolve to internal addresses, and a probe job
  (`PLATFORM_MIRROR_CHECK_MINUTES`) re-checks the address at connect time. A stale Trivy mirror is called out with
  the verified bundle that would refresh it.
- **ACME certificates.** An RFC 8555 client in `server/src/ops/acme.ts` (directory, nonces, ES256 JWS with
  `node:crypto`, account, order, http-01 answered by this server at `/.well-known/acme-challenge/<token>`, finalize
  with a PKCS#10 request built by a small DER writer, chain download, revocation). Each issue uses a fresh ECDSA
  P-256 key sealed with the platform data key; the account key is sealed too. A sweep renews certificates
  `ACME_RENEW_DAYS` before expiry and notifies system admins about expiring ones; certificates issued elsewhere can
  be tracked for expiry. Private keys are exported only through an audited POST.
- **Backups and restore drills.** A backup job dumps every table (repeatable read on PostgreSQL and MySQL) into a
  gzipped archive encrypted with a KMS-wrapped key, with a KMS-signed manifest of tables, row counts and digest, on
  a schedule (`PLATFORM_BACKUP_MINUTES`) with retention (`PLATFORM_BACKUP_RETAIN`). A drill restores a backup into a
  scratch SQLite file, never the live database, and verifies the signature, digest, schema version, row counts and
  every tenant's audit chain and checkpoints, recording measured RPO and RTO against the targets. Weekly drills by
  default; a missed RPO raises a platform alert that admins acknowledge. CLI: `backup:create`,
  `backup:restore-drill`.
- **Secrets health.** KMS and blob store health, data keys per scope with rotation (audited), which secrets are
  mounted as files, clock skew against the database server.
- Screen made live: **Platform** (`web/js/screens/platform.js`, `live: true`).

**Done when:** a correctly signed bundle passes the seven steps and is promoted, while one signed by an unknown key is
rejected before it is unpacked; a certificate is issued, renewed and revoked against an ACME directory; a backup is
restored in a drill that verifies row counts and the audit chain (`platform-ops.test.ts`).

### Identity (federation)

Delivered in `server/src/federation`, `server/src/identity/providers/federated.ts`, `server/src/routes/admin/federation.ts`,
`server/src/routes/federation-public.ts` and the live console screen `identity.js` (flows in
[docs/identity.md](docs/identity.md)).

- **OIDC provider**: per-tenant issuer (`FEDERATION_ISSUER` or `PUBLIC_URL` for the default tenant, `<issuer>/t/<slug>`
  for the others); discovery and JWKS; ES256 signing keys generated with node:crypto and sealed with the platform data
  key, rotated on a schedule (`OIDC_KEY_ROTATION_DAYS`) or by hand, the next key published `OIDC_KEY_OVERLAP_DAYS`
  before it signs and the old one kept for the overlap; authorization code with PKCE (S256, exact redirect URIs),
  refresh tokens rotated on every use with family revocation on reuse, client credentials for service accounts, device
  authorization (RFC 8628) with an approval page, token exchange (RFC 8693), userinfo and revocation (RFC 7009).
- **Clients**: confidential (BFF), public, service account and third party; secrets shown once and stored as HMAC
  digests; rotate and disable (revokes the grants); consent policy per tenant (first party pre-consented, third party
  asked, remembered 90 days); scopes are permissions intersected with the user's roles, re-checked at every refresh;
  `groups` gives groups, roles and clearance claims.
- **SAML IdP**: metadata with a self-signed RSA certificate (DER written with node:crypto), SP registration from
  pasted metadata, SP-initiated SSO over HTTP-Redirect and HTTP-POST (signed requests verified when required), signed
  assertions (enveloped XML-DSig, exclusive C14N, RSA-SHA256) with groups, roles and clearance attributes, posted by a
  CSP-clean page.
- **Upstream federation**: OIDC (PKCE, nonce, state, ID token verified against the upstream JWKS, RS256 or ES256) and
  SAML (signed assertion, audience, recipient, `InResponseTo`) providers as `oidc`/`saml` user stores in the chain;
  internal hosts only (the air gap) unless `FEDERATION_ALLOWED_HOSTS` names them; claims feed the group mappings and
  JIT provisioning; offered on the sign-in screen.
- The console API accepts the provider's access tokens (audience `<issuer>/api`) as bearer credentials, narrowed to
  their scopes like API keys.
- **Kerberos SPNEGO**: `/auth/negotiate` with `s.kerberos` (optional `kerberos` module, `KERBEROS_SERVICE`,
  `KERBEROS_KEYTAB`; a fake in tests), realm allow-list per tenant, principal mapped through the user stores.
- Federated and Kerberos sign-ins are a first factor: admin roles still complete or enrol a second factor.
- Protocol pages that need the console session survive the Strict session cookie on cross-site redirects through a
  continue page (`web/js/federation.js`) and a resume step in the sign-in screen.
- The Identity screen is live: clients, SAML service providers, scopes and consent, keys and JWKS, upstream
  providers with reachability checks, sessions and grants, and "Test a login".
- Tests: `federation.test.ts` (discovery and JWKS, code + PKCE with ID token verification, redirect and PKCE refusals,
  refresh rotation and reuse, key rotation overlap, device flow, secrets shown once, SAML metadata and a signed
  response verified with node:crypto alone, upstream OIDC and SAML sign-in against in-process fakes with group
  mapping, Kerberos with a fake verifier, permission checks); `fake-idp.ts`.

**Done when:** a relying party signs a user in with code + PKCE and verifies the ID token against the JWKS through a
key rotation; a device is approved from the console; a SAML SP receives a signed assertion; an upstream OIDC user is
provisioned by group mapping; Kerberos signs a user in with the fake verifier (`federation.test.ts`).

## Sprint 10: Hardening and release (release candidate)

OWASP ASVS level 2 review; dependency scanning and SBOM; load test of the streaming path; Helm chart and
NetworkPolicies; backup, restore and incident runbooks; accessibility (AA and AAA modes); a Playwright suite across
every screen; the 1.0 release.

**Infrastructure.** A Helm chart (`deploy/helm/exprsn-ai`, 1.0.0-rc.1) runs the server as a hardened
Deployment (UID 1000, read-only root filesystem, no capabilities, `RuntimeDefault` seccomp, no service-account token,
startup and liveness probes on `/healthz`, readiness on `/readyz`) with a Service, an Ingress with WebSocket-friendly
timeouts, a PodDisruptionBudget, an optional HorizontalPodAutoscaler and ServiceMonitor, and a ConfigMap. Every secret
comes from an existing Kubernetes Secret, mounted as a file and read through `<NAME>_FILE`. Migrations run in an init
container or a pre-upgrade hook Job (`node server/dist/cli.js migrate`). The chart refuses to render several replicas
without Redis, SQLite, or a plain `http://` address in production. NetworkPolicies mirror the zones: default deny in and
out, ingress from the ingress controller (and Prometheus), and egress groups for DNS, the data zone (database, Redis,
S3), OpenBao, the directory (LDAP, KDC), the inference zone (Ollama), the sandbox, mail and SIEM, each configured in
values; nothing allows the internet. CI gains a production `npm audit` (high and above), a CycloneDX SBOM of the npm
workspace and of the image, a Trivy scan of the image that fails on fixed critical and high findings, a Helm lint,
render and kubeconform job, and an in-process streaming load test; Dependabot watches npm, GitHub Actions, Docker and
Compose. `server/loadtest/stream.ts` measures the streaming path (time to first token, tokens per second, p50, p95 and
p99, errors) in-process on the fake Ollama or against a running stack, with the 1.0 targets in `docs/loadtest.md`.
Runbooks for backup and restore, incident response and upgrades are in `docs/runbooks/`, and `docs/deploy.md` has a
Kubernetes section.

**OWASP ASVS 4.0.3 level 2 review.** [docs/asvs.md](docs/asvs.md) assesses the server and its deployment files
chapter by chapter (V1 to V14, 71 requirement groups): 37 met, 27 partly met, none wholly unmet and 7 not applicable,
each with file and test evidence and a follow-up. The review closed the gaps that were safe to fix now, each with a
test in `server/test/asvs.test.ts`: every `/api` answer is sent with `Cache-Control: no-store`; the public `/readyz`
and the federation error pages and userinfo no longer echo internal errors (hosts, paths, driver messages); the
browser sign-in, SAML and upstream callback and Kerberos endpoints outside `/api` are throttled per address; request
logs redact authorization codes, PKCE verifiers, device codes, SAML messages and CSRF tokens; local-account passwords
are checked against common and service-named passwords; an admin cannot remove their only second factor when their
roles (however granted) require one; a password sign-in revokes the session the browser already held; and git
knowledge sources refuse link-local (cloud metadata) hosts. The larger follow-ups (step-up re-authentication for
sensitive account changes, self-service password change, a full breached-password check, shared rate limits across
instances, user revocation of OAuth grants) are listed at the end of the assessment and in the security known gaps.

**Accessibility (AA and AAA modes).** The console now targets WCAG 2.2 AA by default and has an Enhanced (AAA) mode
(Settings → Appearance → Accessibility: Follow system, Standard (AA), Enhanced (AAA); stored in the browser like the
theme). Follow system switches to Enhanced when the browser asks for more contrast. Enhanced redefines the colour tokens
under `:root[data-a11y="aaa"]` for light and dark (text at 7:1 or more on every surface), and adds 44 px targets, a focus
ring on every focused element, underlined links, no motion, no shadows and longer-lived toasts. Reduced motion is always
honoured, and forced-colour modes keep state visible. The shell now provides a skip link, `main`/`nav`/`header`
landmarks, `aria-current` on the active nav item and breadcrumb, focus moved to the heading on screen change and kept on
re-render, labelled `inert`-backed dialogs with a focus trap, Esc and focus return, keyboard popovers, the command
palette as an ARIA combobox and listbox, toasts in a live region with Dismiss and pause, `UI.field` labels and hint
descriptions, `scope` on table headers, keyboard-operable clickable rows, 3:1 field borders (`--control`), 24 px minimum
buttons, and a single-key shortcut switch (WCAG 2.1.4). axe-core reports no WCAG A/AA violations (and no AAA contrast
violations in Enhanced) on sign-in and all 26 screens in light and dark; the measured contrast ratios and the known gaps
are in `docs/accessibility.md`.

**Console end-to-end suite.** `e2e/` holds a Playwright suite (its own package, not a workspace member)
that drives every console screen against the real server. `e2e/server.ts` builds the services on a temporary SQLite
file with generated secrets, runs the migrations and the bootstrap, starts the test fakes from `server/test` (Ollama,
MCP server, script sandbox, ffmpeg, image worker and safety classifier, GPU trainer, ACME directory), seeds a pool with
approved models and published profiles, a workspace, a flag and a staged training file, creates system admins (one
with a pre-enrolled authenticator, one that enrols at first sign-in), an ML admin and a member, and serves `web/`.
A setup project signs every account in through the sign-in screen, including the second-factor step and first-time
enrolment. One spec per sidebar screen exercises a primary action end to end: a streamed chat answer and a two-column
comparison from the fake Ollama, an agent run, a knowledge base with an uploaded document, a memory added and
forgotten, a media job and a generated image, a model import pulled, evaluated and approved by a second admin, a
profile published, a pool added and a model loaded through the planner, a dataset scrubbed and a confidential training
job approved by a different admin, a registry agent approved by a second admin, an MCP server registered and a tool
approved, a workflow published and run, a script run in the sandbox, a connection registered and tested, a guardrail
live test and a new rule set, a flag confirmed, text classified, a checkpoint signed and the audit chain verified, a
workspace created, "Test a login", an OIDC client whose secret is shown once, zones seeded and a new zone approved by
a second system admin, a backup with a restore drill and an ACME certificate, and an API key shown once, used and
revoked from Settings. Sign-in refusals and the "not permitted" page are covered, and every screen is opened in light
and dark as a system admin and as a member, on the fresh server and again at the end. Any console error, page error
or unexpected 4xx/5xx fails the test. 41 tests, about two minutes; CI runs them in the "Console end-to-end
(Playwright)" job and keeps the report and traces of a failed run. The suite found and fixed a crash on the
Connections screen when no connection is registered, and a "Test a login" preview that ignored directly granted
roles.

**Release.** The workspace, the server and the chart are versioned `1.0.0-rc.1`, with the changes since the design
prototype in [CHANGELOG.md](CHANGELOG.md). Tagging `v1.0.0` and publishing the image and chart are left to the
maintainers once the release candidate has been deployed and reviewed; the open items are the known gaps in
[docs/security.md](docs/security.md), [docs/asvs.md](docs/asvs.md) and [docs/accessibility.md](docs/accessibility.md).

## Sprint 11: Account self-service and security notifications (done)

Delivered in `server/src/identity` (`account.ts`, `breached.ts`, `security-alerts.ts`), `server/src/platform/email-templates.ts`,
`server/src/routes/auth.ts`, `server/src/routes/me.ts`, `server/src/routes/admin/users.ts` (migration `013_account`)
and the console screens `signin.js`, `settings.js` and `directories.js`. The design of the password change, reset
tokens and email templates is ported from exprsn-platform's auth service, as cited in [Backlog-1.1.0.md](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.1.0.md).
No new permissions or dependencies.

- Password change for local accounts in Settings (B-101): the current password is required and a wrong one counts
  toward the sign-in lockout, reuse is refused, and every other session and OAuth grant ends. Directory accounts are
  told to change their password in their directory.
- Admin password reset (B-102): an identity admin sets a temporary password or sends a single-use link by email; the
  old password stops working, sessions and grants end, and the reset is audited. Admins can also invite a local account
  by email instead of setting a password (`PASSWORD_INVITE_HOURS`).
- Forced change (B-103): an admin-set or reset password (and new accounts by default, `mustChange`) puts the session in
  a `password` stage, after the second factor, that reaches only `POST /api/me/password`.
- Reset by email from the sign-in screen (B-104): the same answer whether or not the account exists; a 256-bit token
  stored as its sha256, single use, valid for `PASSWORD_RESET_MINUTES` (60) and carried in the URL fragment; throttled
  per address, identifier and account (`PASSWORD_RESET_PER_HOUR`); a reset ends sessions and grants and lifts a lockout.
- Breached-password check (B-105, `BREACHED_PASSWORDS`, off by default): the HIBP range API (only the five-character
  prefix leaves, with padding; `BREACHED_HIBP_URL`, `BREACHED_TIMEOUT_MS`), an offline sorted SHA-1 file searched in
  place (`BREACHED_FILE`), or both. It fails open with an audit event.
- Step-up re-authentication (B-106): creating an API key, removing a factor and regenerating recovery codes need a
  password, TOTP or passkey check within `STEPUP_WINDOW_SECONDS` (300), otherwise 401 `Step-up required`; Settings
  asks and retries. Removing an application's access does not need step-up, because it only reduces access.
- Security notices in the console and by email, carrying no secrets (B-109), for changes to passwords, factors,
  recovery codes, API keys, sessions and OAuth grants, and for admin resets. Plain-text and HTML templates for reset,
  admin-set password, invitation and security alert, with every value escaped (B-110).
- Accessibility (B-501 to B-504): the accessibility mode is stored per user (`PATCH /api/me/preferences`) and applied
  at sign-in; `UI.tabs` implements the full ARIA tabs pattern (roles, `aria-selected`, roving tab stop, arrow keys,
  Home and End, linked tab panel); Workflow steps have Move buttons in the inspector and Classifier levels have Up and
  Down buttons (WCAG 2.5.7); the Chat title is an `h1`.

**Done when:** changing the password ends every other session and grant, and a wrong current password counts toward
the lockout; an admin reset is audited and the old password stops working; a reset link works once, expires and never
appears in a response; a known-breached password is refused and only the hash prefix is sent; sensitive changes
outside the step-up window answer 401; every listed change notifies the user; the accessibility mode follows the user
to another browser (`server/test/account.test.ts`, 22 tests; `fake-account.ts` records email and answers as the range
API).

## Sprint 12: Chat (done)

Delivered in `server/src/guardrails/stream.ts`, `server/src/chat` (`service.ts`, `streams.ts`, `context.ts`),
`server/src/guardrails/flags.ts`, `server/src/agents/service.ts`, `server/src/memory/service.ts`,
`server/src/routes/chat.ts`, `server/src/routes/admin/tenants.ts` (migration `014_chat_hold`) and the console screens
`chat.js`, `flags.js`, `tenants.js`, `registry.js` and `memory.js`. The streaming screen is ported from exprsn-platform's
cortex `streamGuard`, and held answers from its review jobs.

- Output guardrails while an answer streams (B-201): text is buffered to a sentence or line end (or 240 characters),
  the whole buffer is re-checked by the deterministic `model-output` rules, and only screened text is sent, thinking
  included. A block stops the model, a hold stops release, and a redaction replaces the spans. The guard model and
  classifiers still run on the finished answer. With the platform baseline's rules, answers now arrive a sentence at a
  time.
- Held answers (B-202): `require-approval` at `model-output` stores the answer sealed as `held` and files a `hold` flag
  in the Flags queue. The owner sees "Held for review" until a reviewer approves it (released) or rejects it (withdrawn
  with a notice); the owner is notified, decisions are audited, and reviewers cannot decide their own answers.
- Resumable streams across instances (B-203): chunks carry sequence numbers into a shared catch-up buffer (Redis or
  the database, sealed, trimmed at two-second snapshots), so a client catches up from any instance; heartbeats mark a
  silent answer `interrupted` after `CHAT_STREAM_LEASE_SECONDS` (30), and it can be continued in place.
- Agent memory write-back (B-204): agents declare a memory policy; with `propose`, runs get a `remember` tool that files
  agent-scope memory proposals through the `memory` checkpoint, capped by type and count, for a curator to accept.
- Citation passages (B-205): citations store the chunk id, span and passage (sealed); Sources quote the passage, and
  withhold it above the reader's clearance.
- Conversation retention (B-206, ASVS 8.3.4): a tenant retention period; the `chat.retention` job
  (`CHAT_RETENTION_SWEEP_MINUTES`, 60) deletes idle conversations with their messages, buffers and unused attachments,
  and audits each purge.

**Done when:** a blocked phrase never reaches the socket and the full check still runs on the finished answer; a held
answer is invisible until approved and withdrawn when rejected; catch-up works from a second instance and an
interrupted answer continues there; a run proposes a memory a curator accepts; Sources show the passage only within
clearance; conversations past the retention period are purged and audited (`server/test/sprint12.test.ts`).

## Sprint 13: Integrations (done)

Delivered in `server/src/openai`, `server/src/webhooks`, `server/src/integrations/hosts.ts`, `server/src/prompts`,
`server/src/chat/sharing.ts`, `server/src/billing` (`service.ts`, `stripe.ts`), `server/src/routes/prompts.ts`,
`server/src/routes/sharing.ts`, `server/src/routes/admin/integrations.ts`, `server/src/routes/admin/billing.ts`
(migration `015_integrations`) and the console screens `chat.js`, `tenants.js` and `usage-audit.js`. Webhook signing and
delivery are ported from exprsn-platform's plugins `webhookDispatcher`. New permissions `webhooks:manage`,
`prompts:manage`, `billing:read` and `billing:manage`: tenant admins get the first three and knowledge curators get
`prompts:manage` (system admins hold every permission).

- OpenAI-compatible API at `/v1` (B-301): models, chat completions with streaming and tools, and embeddings, with an
  API key or OAuth token, through the same profile resolution, clearance, quota, guardrail and metering paths as chat.
  Streams send the answer after the output guardrail by default (`OPENAI_STREAM_MODE`). OAuth tokens scoped
  `inference:invoke:<profile>` are bound to those profiles.
- Webhooks (B-302): tenants subscribe endpoints to audit actions, job states, flags and approvals; each delivery is
  signed (HMAC-SHA256 over `timestamp.body`), sent as a job, retried with backoff and paused by a per-endpoint breaker
  (`WEBHOOK_TIMEOUT_MS`, `WEBHOOK_MAX_ATTEMPTS`, `WEBHOOK_RETRY_BASE_MS`, `WEBHOOK_BREAKER_THRESHOLD`,
  `WEBHOOK_BREAKER_COOLDOWN_MS`); the Tenants screen's Webhooks tab has the delivery log, replay and secret rotation.
- Per-tenant allowed outbound hosts for workflow HTTP steps and webhooks (B-303, with the operator's
  `WEBHOOK_ALLOWED_HOSTS`).
- Prompt library (B-304): versioned `{{variable}}` templates per workspace or tenant, with labels and a lifecycle, and a
  picker in chat.
- Conversation sharing (B-305): read-only with a person, a workspace or an expiring link, inside the tenant and within
  the conversation's label; revoking ends access at once.
- Conversation export (B-306): Markdown or JSON as a job, with the active branch and citations; clearance-gated,
  audited and sealed.
- Billing (B-307): price books and monthly statements from the usage meter (matching the usage report), CSV and JSON
  export, and an optional Stripe invoice push (`BILLING_PROVIDER`, `STRIPE_SECRET_KEY`, `STRIPE_API_URL`,
  `STRIPE_DAYS_UNTIL_DUE`, `BILLING_CLOSE_MINUTES`); a Statements tab on Usage and audit.

**Done when:** the OpenAI wire format lists models, chats, streams and embeds with a bearer API key; a delivery is
signed and verifiable, and a failing endpoint retries, then opens the breaker; a host outside the tenant's list is
refused; a template is inserted into chat with its variables filled; a shared reader can read but not write, and
revocation ends access; an export has the active branch and citations; a month's statement matches the usage report
(`server/test/sprint13.test.ts`, with the webhook receiver and Stripe fakes in `sprint13-fakes.ts`).

## Sprint 14: Federation, second part (done)

Delivered in `server/src/federation` (`oidc.ts`, `service.ts`, `jose.ts`, `keys.ts`, `saml.ts`, `upstream.ts`,
`xmlenc.ts`), `server/src/platform/kms.ts`, `server/src/http/middleware.ts`, `server/src/routes/federation-public.ts`,
`server/src/routes/admin/federation.ts`, `server/src/routes/me.ts` (migration `016_federation2`) and the console screens
`settings.js`, `identity.js` and `web/js/federation.js`. The revocation model and SAML encryption follow
exprsn-platform's auth service, as cited in the backlog. New setting `DPOP_PROOF_MAX_AGE_SECONDS` (60); no new
permissions.

- Connected applications in Settings (B-107): users see and remove the applications they allowed; the tokens stop at
  once, the consent is forgotten, and a security notice is sent.
- Token revocation (RFC 7009) and introspection (RFC 7662) (B-108): access tokens are revocable one by one through a
  shared deny-list; confidential clients introspect their own tokens.
- Logout (B-401): RP-initiated logout at `/oauth/logout`, with front-channel frames and back-channel logout tokens to
  every registered client whenever a session ends.
- Re-authentication (B-402): `prompt=login` and `max_age` make an old session sign in again.
- Pushed authorization requests (B-403, a single-use `request_uri` for 60 seconds) and request objects signed with the
  client's registered keys.
- DPoP sender-constrained tokens (B-404): a bound token without a valid proof is refused (no DPoP nonces).
- SAML single logout in both directions, and encrypted assertions sent to service providers and accepted from
  identity providers, with AES-GCM and RSA-OAEP only (B-405).
- Signing in the KMS (B-408): with OpenBao, OIDC and SAML signing happens in transit, and no private signing key is in
  the process.

**Done when:** a revoked access token is refused before it expires, and other clients' tokens introspect as inactive;
removing an application ends its tokens at once; sign-out reaches every back-channel client; an old session is asked to
sign in again; a pushed `request_uri` works once; a DPoP-bound token without a proof is refused; an SP's LogoutRequest
ends the session and an encrypted assertion is accepted; with OpenBao, ID tokens and SAML assertions are signed with no
private key in the process (`server/test/sprint14.test.ts`, with the transit engine in `fake-openbao.ts`).

## Sprint 15: Operations (done)

Delivered in `server/src/platform` (`ratelimit.ts`, `rewrap.ts`, `ntp.ts`, `blob.ts`), `server/src/ops` (`dns.ts`,
`acme.ts`, `certs.ts`, `backups.ts`, `restore.ts`, `bundles.ts`, `signers.ts`), `server/src/media/origin.ts`,
`server/src/connections` (`dynamic.ts`, `drivers.ts`, `classify.ts`), `server/src/zones/service.ts`, `server/src/cli.ts`
(migration `017_ops`) and the console screens `platform.js` and `connections.js`. The shared limiter, versioned data keys,
dns-01 checks, backup scripts and dynamic credentials start from the exprsn-platform files cited in the backlog. No new
permissions or dependencies. New CLI commands `kms:rewrap` and `backup:restore`.

- Shared rate limits (B-111, B-406): rate limits, the failed-credential throttle (20 bad bearer or DPoP credentials a
  minute per address, then 429) and the denial cap share one atomic Redis counter (a Lua script) across instances;
  without Redis, or while it is down, they count in memory.
- Key-encryption-key re-wrap (B-407): `kms:rewrap` moves every data key, checkpoint signature and backup to a new
  `DATA_KEY` or KMS (`DATA_KEY_PREVIOUS`, `KMS_PREVIOUS_PROVIDER`); reads fall back to the previous key until the
  re-wrap reports verified.
- ACME dns-01 (B-409, `ACME_CHALLENGE`, `ACME_DNS_*`) through a signed webhook or RFC 2136 with TSIG, wildcards
  included; renewals publish a bus event and every instance writes the PEMs to `ACME_CERT_DIR`.
- Backups and streaming blobs (B-410, B-411): streamed backups that include the blob store (`PLATFORM_BACKUP_BLOBS`);
  `backup:restore` into an empty database behind a guard; streaming blob stores with S3 multipart uploads, so a 3 GiB
  bundle verifies with flat memory.
- Required bundle checks and signer dual control (B-412): `PLATFORM_BUNDLE_REQUIRE_CHECKS` makes the scan and staging
  steps mandatory; adding or revoking a signer key needs a second admin (the first key is exempt), so
  `POST /platform/signers` answers 202 with a proposal once a key exists.
- Sandboxed media (B-413): media and images are served with `Content-Security-Policy: sandbox` and `nosniff`,
  optionally from a separate origin through signed URLs (`MEDIA_ORIGIN`, `MEDIA_URL_TTL_SECONDS`).
- Clock skew against NTP (B-414, `NTP_SERVER`, `NTP_TIMEOUT_MS`): platform status shows the SNTP offset.
- Zones on registration (B-415): MCP server and connection registration are refused in an undefined zone or above the
  zone ceiling.
- Data connections (B-416): MySQL with read-only enforcement, and OpenBao dynamic database credentials
  (`OPENBAO_DATABASE_MOUNT`).

**Done when:** the 21st bad bearer token a minute from one address gets 429, and two instances share one limit; after a
re-wrap everything reads without the old key; a dns-01 order completes through the webhook and through RFC 2136; a
backup restores into an empty database and blob store and the app starts on it; a large bundle verifies with flat
memory (256 MiB by default, 3 GiB with `TEST_BIG_BUNDLE=1`); an unscanned bundle cannot be promoted when checks are required, and a signer key needs a second admin; media
carry the sandbox header; platform status shows NTP skew; registration outside a zone fails; a MySQL connection queries
read-only (`server/test/sprint15-access.test.ts`, `server/test/sprint15-ops.test.ts`, and
`server/test/integration/operations.test.ts` against Redis, PostgreSQL and MySQL).

## Release 1.1.0

The workspace, the server and the chart are versioned `1.1.0`, with the changes in [CHANGELOG.md](CHANGELOG.md) and
the backlog in [Backlog-1.1.0.md](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.1.0.md). The ASVS assessment ([docs/asvs.md](docs/asvs.md)) and the known
gaps ([docs/security.md](docs/security.md)) are updated for what Sprints 11 to 15 closed. The test harness now serves
each test app on 127.0.0.1 before SuperTest sees it (`server/test/loopback.ts`, `setup-loopback.ts`), which fixed a
macOS port-shadowing flake. The suite: 411 tests passed and 1 skipped across 31 files. Tagging `v1.0.0` and publishing
the image and chart (B-601) remain with the maintainers.

## Sprint 16: Chat and AI depth (done)

Delivered in `server/src/chat` (`service.ts`, `context.ts`, `sharing.ts`), `server/src/guardrails` (`stream.ts`,
`engine.ts`), `server/src/openai`, `server/src/prompts/service.ts`, `server/src/realtime/socket.ts`,
`server/src/routes/sharing.ts`, `server/src/routes/sharing-public.ts` (mounted at `/api/public`),
`server/src/routes/admin/tenants.ts` (migration `018_chat_depth`) and the console screens `chat.js`, `flags.js`,
`tenants.js` and the new signed-out `shared.js`. New settings `CHAT_GUARD_HOLDBACK_SENTENCES` (1),
`CHAT_GUARD_STREAM_CONCURRENCY` (16) and `SHARE_ANONYMOUS_PER_MINUTE` (30); no new permissions or dependencies. The load
test takes `--guard-model`, `--holdback` and `--sentence-words` ([docs/loadtest.md](docs/loadtest.md): a hold-back of
1 adds about 10 ms to the time to first token; run the guard model in its own pool).

- `/v1` context (B-701): `X-Exprsn-Knowledge: <ids>` and `X-Exprsn-Memory: on` add chat's knowledge and memory context
  under chat's clearance and ceiling rules, with citations and passages in an `exprsn` extension field.
- `/v1` server tools (B-702): `X-Exprsn-Tools: profile` runs the profile's read-only tools on the server through the
  dispatcher (up to six rounds) and returns only the final answer. Each header needs its own permission or scope
  (`knowledge:read`, `memory:write`, `tools:invoke`).
- Guard model while streaming (B-703): the guard model and classifiers check a streamed answer in the background,
  bounded per instance; with a hold-back of N, a sentence window is shown only once a clean verdict covers it and the
  next N-1. Generation never waits for a verdict. Tool results shown in chat pass the stream screen.
- Held prompts (B-704): `require-approval` at `user-input` holds the prompt in the Flags queue; approval re-checks the
  owner and generates, rejection withdraws the prompt and notifies the user.
- Live sharing (B-705): readers of a shared conversation watch answers stream in socket rooms the server chooses, and
  lose them at once when the share is revoked or the label raised.
- Anonymous links (B-706): off per tenant by default, only for conversations labelled `public`, expiring, rate-limited
  per address, audited, and opened on the signed-out `#/shared` page.
- Retention per workspace and per user (B-707): the shortest applicable period wins.
- Prompt templates pass the `user-input` checkpoint when saved, versioned and published (B-708).

**Done when:** `/v1` cites a knowledge base the caller may read and never one they may not; `/v1` runs profile tools on
the server and returns only the final answer; a phrase only the guard model blocks is never released with the default
hold-back; a held prompt generates nothing until approved and a rejection tells the user; an anonymous link opens a
public conversation signed out and never an internal one; a workspace with a shorter period purges first; a template
with a blocked secret cannot be saved or published; a shared reader receives `chat.chunk` and loses it at once on
revoke (`server/test/sprint16.test.ts`, `e2e/tests/shared.spec.ts`).

## Sprint 17: Identity, security and accessibility (done)

Delivered in `server/src/identity` (`signin-notices.ts`, `admin-create.ts`, `account.ts`, `passwords.ts`,
`providers/sql.ts`), `server/src/federation` (`proposals.ts`, `metadata.ts`, `saml.ts`, `upstream.ts`, `oidc.ts`,
`jose.ts`), `server/src/http/middleware.ts`, `server/src/routes` (`auth.ts`, `me.ts`, `federation-public.ts`,
`admin/users.ts`, `admin/federation.ts`, `admin/platform.ts`), `server/src/cli.ts` (migration `019_identity3`) and the
console screens `signin.js`, `settings.js`, `directories.js`, `identity.js` and `platform.js`, with accessibility fixes
in `web/css/app.css`, `web/js/app.js`, `pools.js`, `media.js`, `models.js` and `workflows.js`. New settings
`SIGNIN_NOTICES` (on), `DPOP_NONCES` (off), `DPOP_NONCE_SECONDS` (300), `API_PUBLIC_URL` and
`FEDERATION_METADATA_REFRESH_HOURS` (24); new CLI option `admin:create --enrol-link`. No new permissions or
dependencies.

- New sign-in notices (B-801): a sign-in from a new browser (a signed device cookie, `exai_device`) or a new network
  (/24 or /48) sends a security notice; an account's first sign-in only records the browser and network.
- Password strength meter (B-802) on every password form, from `POST /api/auth/password/check` (entropy estimate, the
  policy's rules, the breached result when enabled); Platform warns while `BREACHED_PASSWORDS=off`.
- Upstream step-up (B-803): re-authenticating at the upstream OIDC or SAML IdP (`prompt=login`/`max_age=0`,
  `ForceAuthn`) counts as step-up, bound by state and nonce and a single-use handle.
- Admin password reset revokes the account's API keys unless the option is unticked (B-804).
- Optional DPoP nonces (B-805): stateless HMAC windows; `API_PUBLIC_URL` gives the `htu` base behind a proxy prefix.
- Resource-server introspection (B-806): a client flagged `introspect: any` after a second identity admin approves
  (`federation/proposals.ts`).
- SAML (B-807): optional whole-response signing; SP and upstream IdP metadata fetched by URL through the outbound checks
  (`federation/metadata.ts`), refreshed daily; certificate and endpoint changes wait for approval, and an entity ID
  change is refused.
- Console sign-out loads each front-channel logout URI on a signed-out page (B-808).
- SQL user stores dial the checked address and re-check the name for every new connection (B-809).
- First admin enrolment (B-810): `admin:create --enrol-link` prints a single-use link that sets the password and enrols
  the second factor; until it is used, no admin route answers.
- Accessibility (B-1101 to B-1104): an in-page WCAG A/AA checker (`e2e/tests/support/a11y.ts`, modelled on axe-core's
  rules, with no axe dependency) runs on every screen and design state, a streaming chat and sign-in, in light and dark
  (Standard mode); no two-dimensional scrolling at 320 and 640 px, with wide tables scrolling in a named,
  keyboard-reachable region; one tab panel per tab list (`App.tabPanel`); `--faint-text` at 4.5:1 or more wherever
  faint text is shown, no nested buttons in Pools rows, and Media caption contrast fixed.

**Done when:** the first sign-in from a new browser notifies and the second does not; the meter shows on every
password form and Platform warns when the breached check is off; an upstream OIDC user with no local factor creates an
API key after re-authenticating upstream; a reset revokes keys by default; a proof without the current nonce gets
`use_dpop_nonce` and a prefixed deployment accepts proofs; an approved resource server introspects another client's
token and an ordinary client cannot; a fetched metadata certificate change waits for approval; console sign-out loads
each front-channel URI; a SQL store whose name re-resolves to a link-local address is refused; an admin created with the
link must use it before any admin route (`server/test/sprint17.test.ts`, 16 tests); the accessibility and reflow checks
pass on every screen (`e2e/tests/y-accessibility.spec.ts`, `e2e/tests/y-reflow.spec.ts`,
`e2e/tests/password-meter.spec.ts`).

## Sprint 18: Platform hardening (done)

Delivered in `server/src/platform` (`egress.ts`, `yaml.ts`, `diagnostics.ts`, `rewrap.ts`), `server/src/ops`
(`cert-hooks.ts`, `push.ts`, `acme.ts`, `dns.ts`, `certs.ts`, `backups.ts`, `restore.ts`, `bundles.ts`),
`server/src/training` (`worker.ts`, `trainer.ts`, `service.ts`), `server/src/routes/trainer-worker.ts`,
`server/src/zones/service.ts`, `server/src/mcp/hosts.ts`, `server/src/gateway`, `server/src/images`,
`server/src/routes/admin` (`platform.ts`, `gateway.ts`, `zones.ts`) (migration `020_platform3`) and the console screens
`platform.js` and `zones.js`. The training worker contract, version 2, is in
[docs/training-worker.md](docs/training-worker.md). New settings `SERVICE_ALLOWED_HOSTS`, `SERVICE_INTERNAL_ONLY`,
`REQUIRE_BACKEND_TLS` (off), `BACKEND_TLS_EXEMPT`, `ACME_EAB_KID`, `ACME_EAB_HMAC_KEY`, `ACME_DNS_RFC2136_TRANSPORT`,
`ACME_RELOAD_COMMANDS`, `ACME_HOOK_TIMEOUT_MS` and `TRAINER_*` (`CALLBACK_URL`, `PLAINTEXT_FALLBACK`,
`KEY_TTL_SECONDS`, `CLIENT_CERT_SHA256`, `ARTIFACT_MAX_BYTES`, `CA_FILE`, `CERT_FILE`, `KEY_FILE`);
`ACME_DNS_RFC2136_ZONE` is now optional. No new permissions or dependencies.

- Operator-chosen service URLs (B-901): pool instances, zone endpoints, image backends and the trainer refuse
  metadata, link-local and unspecified addresses when saved and at every connection (`platform/egress.ts`); loopback
  and private addresses stay allowed. `mcp/hosts.ts` also refuses 100.100.100.200, 192.0.0.192 and fd00:ec2::254.
- Backend TLS (B-902): `REQUIRE_BACKEND_TLS` in production refuses plaintext PostgreSQL, MySQL, Redis, S3 and OpenBao
  links, with per-link exemptions in `BACKEND_TLS_EXEMPT`; SQLite is exempt.
- Consistent backups (B-903): a backup reads one snapshot, and the blob archive holds exactly the objects that
  snapshot's rows name.
- ACME (B-904): external account binding; RFC 2136 over UDP with TCP fallback and zone discovery from the SOA; push
  hooks per certificate, named reload commands or signed webhooks (`ops/cert-hooks.ts`).
- Training data protection (B-905, worker contract 2): rows are sealed with a per-run key the worker fetches once
  (with a client certificate check when configured); checkpoints and GGUF files are sealed under the tenant key in the
  platform's blob store (`training/worker.ts`, `routes/trainer-worker.ts`).
- `kms:rewrap` re-signs image provenance (the row and the PNG) and training model cards (B-906).
- Input limits (B-907): size, depth, node and alias caps for YAML (`platform/yaml.ts`); secrets masked in diagnostics
  and problem details (`platform/diagnostics.ts`).
- Zones (B-908): MCP servers and connections outside their zone are listed with a suggested zone and a move proposal
  under dual control; admins are told when the first zones appear.
- Registry pushes (B-909): promoted artefacts go to Harbor (OCI layout tars), Verdaccio and devpi through their APIs
  (`ops/push.ts`); outcomes are recorded and a push can be repeated.
- A training job whose start fails gets its wait reason back.

**Done when:** a pool instance pointing at 169.254.169.254 is refused and clients refuse a metadata address at connect;
production with `sslmode=disable` refuses to start with `REQUIRE_BACKEND_TLS` on; a blob written during a backup is
neither missing nor orphaned after restore; an EAB order completes against the fake ACME and a renewal calls the hooks;
the submit request carries no plaintext rows and a contract-1 worker is refused unless the fallback is set; old images
still verify after a re-wrap; a billion-laughs YAML is refused and a driver message shows its password masked;
out-of-zone members are listed with a move proposal; a promoted npm package appears in a fake Verdaccio
(`server/test/sprint18.test.ts`, 18 tests, with the registry fakes in `sprint18-fakes.ts`).

## Sprint 19: Knowledge, integrations and workflows (done)

Delivered in `server/src/knowledge` (`acl.ts`, `replication.ts`, `service.ts`, `sources.ts`), `server/src/connections`
(`replication.ts`, `drivers.ts`), `server/src/webhooks/service.ts`, `server/src/billing` (`service.ts`, `stripe.ts`),
`server/src/routes/integrations-public.ts`, `server/src/routes/admin` (`billing.ts`, `integrations.ts`),
`server/src/agents/service.ts`, `server/src/workflows` (`graph.ts`, `service.ts`), `server/src/registry/dispatch.ts`,
`server/src/images/service.ts`, `server/src/scripts/runner.ts` (migration `021_integrations2`) and the console screens
`knowledge.js`, `tenants.js`, `usage-audit.js`, `runs.js`, `workflows.js` and `images.js`. New settings
`KNOWLEDGE_REPLICATION` (on for sources that ask for it), `KNOWLEDGE_REPLICATION_TICK_MS` (10000),
`STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_TOLERANCE_SECONDS` (300), `IMAGE_SAFETY_REQUIRED` (off) and `SCRIPT_RUNTIME`.
No new permissions or dependencies. CI turns on `wal_level=logical` in its PostgreSQL service for the replication test.

- MySQL knowledge sources (B-1001): tables and views feed knowledge bases by watermark, as PostgreSQL does.
- Row-level access (B-1002): a database source may name an access column (groups or users per row), carried onto
  documents and chunks and enforced at retrieval; an empty value admits nobody (`knowledge/acl.ts`).
- PostgreSQL logical replication (B-1003): `pgoutput` over the `pg` package, one leased stream per source, acknowledged
  after apply, falling back to watermarks (`knowledge/replication.ts`, `connections/replication.ts`).
- Webhooks (B-1004): ordered delivery per endpoint (per instance), and Ed25519 signatures with a per-tenant key
  published as a JWKS (`GET /webhooks/keys/:tenant`), with rotation.
- Billing (B-1005): per-tenant price books, currency and taxes; a signed, idempotent Stripe webhook
  (`POST /billing/stripe/webhook`) marks statements paid, failed or void.
- Workflows (B-1006): a paused workflow tool gives an agent run a pending result it awaits; approval timeouts per step;
  run events reach approvers live.
- `IMAGE_SAFETY_REQUIRED` withholds images and sampled frames no classifier checked (B-1007).
- `SCRIPT_RUNTIME=runsc` runs scripts under gVisor, and runs are refused if the container engine lacks the runtime
  (B-1008).

**Done when:** a MySQL view feeds a knowledge base; a member not in a row's group never retrieves its chunk; a streamed
update reaches the index at once and a broken stream falls back; ordered deliveries arrive in event order and an
Ed25519 signature verifies with the published key; a paid Stripe invoice marks the statement paid; a calling agent run
resumes when the workflow's approval completes; with the setting on and no classifier, generation returns withheld;
the runner passes `--runtime=runsc` and reports it (`server/test/sprint19-knowledge.test.ts`,
`server/test/sprint19-integrations.test.ts`, `server/test/sprint19-workflows.test.ts`, and
`server/test/integration/replication.test.ts` against PostgreSQL with `wal_level=logical`).

## Release 1.2.0

The workspace, the server and the chart are versioned `1.2.0`, with the changes in [CHANGELOG.md](CHANGELOG.md) and
the backlog in [Backlog-1.2.0.md](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.2.0.md). The ASVS assessment ([docs/asvs.md](docs/asvs.md)), the known
gaps ([docs/security.md](docs/security.md)) and [docs/accessibility.md](docs/accessibility.md) are updated for what
Sprints 16 to 19 closed. `API_RATE_PER_MINUTE` (600) now sets the `/api` limit per user (per address when signed
out), which was fixed at 600, and the console suite's server raises it to 6000. A flake in `memory.test.ts` (a random sealed value could contain the searched substring) is fixed.
The suite: 477 tests passed and 1 skipped across 37 files, and 55 Playwright tests passed. Tagging `v1.0.0` and
publishing the image and chart (B-601) remain with the maintainers.

## Sprint 20: Keys and supply chain (done)

Delivered in `server/src/signer` (`server.ts`, `client.ts`, `protocol.ts`), `server/src/crypto/httpsig.ts`,
`server/src/platform/kms.ts`, `server/src/federation` (`keys.ts`, `upstream.ts`, `xmlenc.ts`),
`server/src/webhooks/service.ts`, `server/src/identity` (`apikeys.ts`, `security-alerts.ts`),
`server/src/http/middleware.ts`, `server/src/openai/routes.ts`, `server/src/routes` (`me.ts`, `admin/federation.ts`,
`admin/integrations.ts`), `server/src/config/index.ts`, `server/src/cli.ts` (migration `022_keys`), the console screens
`settings.js` and `tenants.js`, `.github/workflows/ci.yml`, `deploy/baremetal/exprsn-signer.service` and the Helm
chart's `signer.*` sidecar (`ci/signer-values.yaml`). New settings `SIGNER_SOCKET`, `SIGNER_TOKEN` (or
`SIGNER_TOKEN_FILE`), `SIGNER_TIMEOUT_MS` (5000) and `HTTP_SIGNATURE_MAX_AGE_SECONDS` (300); the signer itself reads
`SIGNER_KEY_FILE`, `SIGNER_TOKEN_FILE`, `SIGNER_SOCKET_MODE` and `SIGNER_ALLOW_GROUP_READ`. New CLI command `signer`
and notice `api_key.changed`. No new permissions or dependencies.

- Signer process (B-1201): `exprsn-ai signer` holds the local key-encryption key and every OIDC, SAML, SAML SP
  decryption and webhook private key, and signs and decrypts over a UNIX socket that checks a shared token on every
  connection. With `SIGNER_SOCKET` set the app holds no private key and no key-encryption key, only wrapped blobs it
  cannot open. Node cannot read a socket peer's uid, so access rests on the socket's permissions, a separate user and
  the token. The signer signs bytes (at most 64 KiB), not digests, and the app fails closed when it is gone.
- Webhook Ed25519 keys (B-1202) are made and used in OpenBao transit or the signer; keys sealed before are retired but
  stay published.
- HTTP Message Signatures (B-1203): an RFC 9421 subset with an RFC 8941 parser and RFC 9530 `Content-Digest`
  (`crypto/httpsig.ts`). An API key may register an Ed25519 public key; `/v1` then accepts only requests signed over
  `@method`, `@target-uri`, `authorization` and `content-digest`, and the key is refused outside `/v1`. Webhooks can add
  RFC 9421 signatures (HMAC-SHA256 or Ed25519) next to their own headers.
- Supply chain (B-1204): `npm audit signatures` in CI; on `main` and `v*` tags a `publish-image` job pushes the image to
  GHCR with a SLSA build provenance attestation and a keyless cosign signature, then checks both with `cosign verify`
  and `gh attestation verify`; a `release-sboms` job attaches the SBOMs to tagged releases. These steps were validated
  with actionlint and a YAML parse only; they have not run on GitHub, and they assume the image is
  `ghcr.io/<owner>/<repo>`.
- `DATA_KEY` out of the environment (B-1205): production refuses `DATA_KEY`, `DATA_KEY_PREVIOUS` and `SIGNER_TOKEN`
  given inline (use the `_FILE` forms), and with the signer refuses `DATA_KEY` from any source. The signer's key file is
  the old `DATA_KEY`, so moving to the signer needs no re-wrap.

**Done when:** with `SIGNER_SOCKET` set the app signs ID tokens and SAML assertions and decrypts assertions with no
private key in its memory; with OpenBao a webhook signature is made in transit; a signed `/v1` request verifies and an
unsigned one or a tampered header is refused; production refuses `DATA_KEY` inline and accepts `DATA_KEY_FILE`
(`server/test/sprint20.test.ts`, 16 tests). CI fails on a package with an invalid registry signature and verifies the
image with `cosign verify` once the workflow runs on GitHub.

## Sprint 21: AI (done)

Delivered in `server/src/openai` (`holds.ts`, `responses.ts`, `routes.ts`, `service.ts`), `server/src/evals/service.ts`,
`server/src/routes/admin/evals.ts`, `server/src/agents` (`schedules.ts`, `service.ts`), `server/src/chat/service.ts`,
`server/src/guardrails/flags.ts`, `server/src/platform/bus.ts`, `server/src/realtime/socket.ts`,
`server/src/repos/users.ts`, `server/src/routes` (`agents.ts`, `guardrails.ts`, `admin/gateway.ts`,
`admin/tenants.ts`) (migration `023_ai`) and the console screens `compare.js`, `flags.js`, `profiles.js` and `runs.js`.
New setting `AGENT_SCHEDULE_TICK_SECONDS` (60); no new permissions or dependencies.

- Held `/v1` requests and compare prompts (B-1301): a `/v1` request sent with an API key that `require-approval`
  stops answers `202` with a held-request id and `GET /v1/held/:id`; another reviewer approves it in Flags, and it runs
  as its sender (job `openai.held`) with the key's scopes at approval time; the answer is kept sealed for the client.
  Compare holds the prompt and every column. A request sent with an OAuth access token is still refused.
- Responses API (B-1302): `POST` and `GET /v1/responses`, a documented subset (string or item input, `instructions`,
  function tools, the `response.created`, `response.output_text.delta` and `response.completed` events); `store: true`
  (needs `chat:write`, off by default) saves the exchange to Chat, and `previous_response_id` continues it.
- Evaluations (B-1303): eval sets per profile (contains and not-contains, RE2 regex, JSON schema, a judge rubric
  through a judge profile), run as `evals.run` jobs and scored per profile version and settings hash. Publishing
  answers `409 eval_gate` unless the gated sets pass or a second profile admin approves an override. The Profiles
  screen gains an Evaluations tab.
- The full `model-output` check covers thinking (B-1304): thinking it blocks or holds is withheld or redacted, with a
  `guard.thinking` entry.
- The bus topic `workspace.membership` (admin removal, group mappings, directory sync) ends a removed reader's shared
  watches at once (B-1305).
- Scheduled agent runs (B-1306): UTC cron schedules on agents (the training cron parser), run as the owner with their
  current roles and memberships, with a run history and skips; each due time is claimed once across instances.
  `/api/agent-schedules`, and a Schedules dialog on the Runs screen.

**Done when:** a held `/v1` request completes after approval and the client fetches the answer, and compare holds both
columns; a response stored through `/v1/responses` appears in Chat and can be continued; a profile version whose eval
score is below its threshold cannot be published; thinking a guard-model rule blocks is withheld after the answer
finishes; removing a reader from the shared workspace ends their stream without a reload; a scheduled agent runs at its
time with the owner's permissions and is skipped when the owner is disabled (`server/test/sprint21.test.ts`, 9 tests).

## Sprint 22: Operations (done)

Delivered in `server/src/observability` (`tracing.ts`, `ops-metrics.ts`), `server/src/db/schema.ts`,
`server/src/platform` (`shamir.ts`, `escrow.ts`, `jobs.ts`, `ntp.ts`, `ratelimit.ts`), `server/src/zones`
(`kube.ts`, `cluster.ts`), `server/src/routes/admin/zones-cluster.ts`, `server/src/ops` (`service.ts`, `watch.ts`),
`server/src/gateway/ollama.ts`, `server/src/http/app.ts`, `server/src/routes/health.ts`, `server/src/index.ts`,
`server/src/cli.ts` (migration `024_ops2`), the console screens `platform.js` and `zones.js`, `deploy/observability/`
(Prometheus rules with promtool unit tests, two Grafana dashboards), the Helm chart's optional `zonesApply` RBAC, the CI
job `observability` (promtool from `prom/prometheus` v3.5.0, pinned by digest) and the runbook
[docs/runbooks/alerts.md](docs/runbooks/alerts.md). New settings `OTEL_EXPORTER_OTLP_ENDPOINT`,
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_SERVICE_NAME`,
`OTEL_TRACES_SAMPLE_RATIO`, `OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_BSP_SCHEDULE_DELAY`, `SCHEMA_CHECK_SECONDS`, `ZONES_APPLY`,
`ZONES_APPLY_API_URL`, `ZONES_APPLY_TOKEN_FILE`, `ZONES_APPLY_CA_FILE`, `ZONES_APPLY_FIELD_MANAGER`,
`ZONES_APPLY_DRIFT_MINUTES`, `NTP_OUTLIER_MS` and `RATELIMIT_PROBE_SECONDS`; `NTP_SERVER` takes a comma-separated list.
New CLI commands `migrate --check`, `kms:escrow` and `kms:recover`. No new permissions or dependencies.

- Tracing (B-1401): OpenTelemetry spans over OTLP/HTTP JSON without the SDK (`observability/tracing.ts`) for requests,
  jobs (the parent carried in `jobs.trace_parent`), Ollama calls (which receive `traceparent`), guardrail checks and
  database queries (operation and table only), with an attribute allow-list and no tenant content.
- Dashboards and alerts (B-1402): Prometheus recording and alert rules with promtool unit tests, overview and
  operations Grafana dashboards in `deploy/observability/`, and the metrics they need (`observability/ops-metrics.ts`).
- Safe upgrades (B-1403): `migrate --check` lists pending migrations and their destructive steps (exit 0, 2, 3 or 4);
  the schema guard (`db/schema.ts`) stops an instance older than the schema from claiming jobs, answers `/readyz` with
  503 and `checks.schema`, and refuses to start it. The expand/contract rule is in `docs/PLAN.md`, and a lint test
  refuses a dropping or renaming migration without the `// contract:` marker.
- Key escrow (B-1404): `kms:escrow` splits the local key-encryption key into k-of-n Shamir shares over GF(256)
  (`platform/shamir.ts`, `platform/escrow.ts`), each with a share check value and a key check value; `kms:recover`
  writes the rebuilt key to a new 0600 file, never to standard output. At the merge, `kms:escrow` gained
  `--key-file <signer key file>`, so a deployment whose key lives only in the signer can escrow it (checked end to end:
  three of five shares rebuilt the signer key file).
- Zones in-cluster (B-1405): with `ZONES_APPLY=kubernetes`, each zone's NetworkPolicy is applied with server-side
  apply, and drift is reported in the audit chain, as a notification, on the Zones screen and as an alert
  (`/api/admin/zones-cluster`).
- NTP quorum (B-1406): several `NTP_SERVER`s, the median skew, and outliers named.
- Rate-limit health (B-1407): a Redis probe, the `exprsn_ratelimit_degraded` metric and alert, and a Platform warning
  while limits count per instance.

**Done when:** a chat request is one trace across HTTP, guardrails, the gateway, the database and the job, with no
message text; the rules parse and `promtool check rules` and `promtool test rules` pass, and the dashboards load; an
instance older than the schema stops taking jobs and says why; three of five shares rebuild a key that opens a backup
and two do not; against a fake API server a zone change applies its NetworkPolicy and a manual edit shows as drift;
with one lying server out of three the reported skew is the honest one; stopping Redis shows the warning within a
minute (`server/test/sprint22-ops.test.ts`, 19 tests, with a fake OTLP collector, Kubernetes API, SNTP server and Redis
in `sprint22-fakes.ts`).

## Sprint 23: Knowledge, integrations and accessibility (done)

Delivered in `server/src/knowledge` (`crawl.ts`, `sources.ts`, `service.ts`), `server/src/connections` (`drivers.ts`,
`service.ts`), `server/src/webhooks/service.ts`, `server/src/billing/service.ts`, `server/src/routes`
(`knowledge.ts`, `integrations-public.ts`, `admin/billing.ts`) (migration `025_integrations3`), the console screens
`knowledge.js`, `usage-audit.js`, `profiles.js` and `workflows.js` and `web/css/app.css`, and in `e2e/`
(`tests/support/axe.ts`, `tests/y-accessibility.spec.ts`, `tests/y-reflow-overlays.spec.ts`). New settings
`KNOWLEDGE_ALLOWED_HOSTS` and `KNOWLEDGE_FETCH_TIMEOUT_MS`; no new permissions. New dependency: `axe-core` 4.13.0 in
the e2e package only.

- S3 buckets (B-1501): S3-compatible bucket sources with their own endpoint and sealed keys, include patterns and
  ETag change detection; removed objects are dropped. Endpoints must be internal or in `KNOWLEDGE_ALLOWED_HOSTS`.
- Web crawler (B-1502, `knowledge/crawl.ts`): same origin, robots.txt (RFC 9309) and sitemaps, depth, page and path
  limits, `noindex` and `nofollow`, conditional re-fetch, and every dialled address checked.
- PostgreSQL row security (B-1503): `roleMappings` from group to role; reads run under `SET LOCAL ROLE` in a read-only
  transaction. The setup is validated (membership, no superuser or `BYPASSRLS`, row security on and forced,
  `security_invoker` views) and documented in [docs/deploy.md](docs/deploy.md).
- Webhook order across instances (B-1504): a position counter (`webhook_order`) and a delivery lease per endpoint.
- Billing (B-1505): price book versions with `effectiveFrom` prorate the month; Stripe refunds mark a statement partly
  refunded or refunded, credit notes are recorded, and disputes are reconciled and audited.
- axe-core (B-1506): axe-core 4.13.0 runs beside the in-page checker on every screen and design state, sign-in and a
  streaming chat, in Standard and Enhanced (AAA contrast), light and dark. Fixed on the way: a field-hint link on
  Profiles below the 24 px target size and the unlabelled workflow picker on Workflows.
- Dialogs and drawers (B-1507) are measured for reflow at 320 and 640 px; a long breadcrumb that pushed the page sideways at
  640 px and below now shrinks and clips.

**Done when:** a file added to a fake S3 bucket is indexed and a removed one is dropped; a two-level internal site is
indexed within its limits and never leaves its host; a row a policy hides from a group's role never reaches that
group's chunks; ordered events raised on two instances arrive in order; a refunded invoice marks the statement
refunded with the amount (`server/test/sprint23-knowledge.test.ts`, 6 tests,
`server/test/sprint23-integrations.test.ts`, 5 tests, with a fake S3 bucket and web site in `sprint23-fakes.ts`, and
`server/test/integration/rls.test.ts` and
`integration/webhooks.test.ts` against PostgreSQL); the suite fails on any axe-core WCAG 2.2 A/AA violation and on AAA
contrast in Enhanced, and each screen's dialogs and drawers open at 320 px without sideways scrolling
(`e2e/tests/y-accessibility.spec.ts`, `e2e/tests/y-reflow-overlays.spec.ts`).

## Sprint 29: Permission matrices, custom roles and the 1.5.0 boards (done)

Delivered on `sprint-29`:

- **B-3401, prototype boards** in `design/prototype/` for every screen of B-34, built from `docs/api.md` (Sprints 24 to
  28) and `Backlog-1.5.0.md`, each with example data, working filters, sorts, tabs, inspectors, modals and confirms, and
  a "States to design from this page" strip wired to `App.applyState`:
  - workspace: `files` (folders, upload through quarantine, versions and restore, trash, shares and links, quotas,
    previews), `apps` (entity designer with every field type, formulas and AI fields, the state machine, the records grid
    with the filter builder, sorts, paging, bulk, import and export, forms builder with public links, triggers),
    `groups` (groups, join modes, requests and invitations, posts, the calendar with RSVP, check-in, reminders and
    cancellation, feed URLs, cases), `messages` (conversations, threads, reactions, pins, attachments, search,
    summaries; the feed with holds, comments, reposts, bookmarks, trending and digests; blocks, mutes, follows, lists and
    the contact rule);
  - admin: `moderation` (routed queues with SLA timers, reports, appeals with independence, actions, sanctions,
    providers in shadow or enforce, dead letters), `channels` (sessions and transcripts, held replies with approve, edit
    and reject, settings and secrets, email outbox and bounces, exports), `roles` (the role × permission matrix with
    routes, custom roles with the creator ceiling, dual control and diffs, the effective-access matrix with `explain`,
    access reviews; tenant-only roles and the workspace admin as default reviewer, per the decisions),
    `certificates` (issuers, certificates, profiles, ACME, expiry), `vault` (KV versions, transit keys, policies with
    `explain`, database leases), `plugins` (plugins, grants and lifecycle, install and bundles, the event catalogue,
    runs and logs), `atproto` (identity and keys, labels, trusted labelers, firehose, DID bindings, and the planned PDS
    and feed generators);
  - B-3413 on existing boards: `signin` (self-registration under the policy, invitation and verification links, trusted
    devices and email codes at the MFA step, GitHub and AT-Protocol sign-in, sanction and pending refusals), `settings`
    (email verification, second factors with email codes, trusted devices, the user's DID binding) and `identity`
    (GitHub and AT-Protocol user stores, the sign-up and MFA policy, sign-ups, invitations, CSV imports, DID bindings).
  - The shell gained the eleven NAV entries and icons; `node build.mjs` and `npm run smoke` (38 screens, light and dark,
    every state) run clean.
  - The Workflows board was rebuilt on the server's step kinds (trigger sources manual, api, record and schedule; model,
    transform, branch with labelled true and false edges, guardrail, approval, HTTP with vault references, calc, wait,
    tool, record), with a Triggers and callers tab (app triggers, plugins' `call:workflow`, agent tool calls, chat) and
    the 1.5 proposals (sub-workflow, agent, skills, event trigger, map, loop, media, query, script, plugin action) shown
    dashed and refused at publish. The roll-up `design/prototype/rollup-1.5.html` lists what 1.5.0 was missing; the
    owner approved rolling it into the backlog as B-39 Workflows 2 (Sprint 32) and B-3415.
  - The design-state controls (header "States" button, the strip at the foot of each page) were removed from the
    prototype as from the console; states are applied from the command palette and by the smoke run.

B-3301 to B-3305 (`031_access`) and B-3601 were done on `sprint-29a` and `sprint-29b`; the live screens B-3402 to
B-3404, B-3407, B-3408 and B-3413 were built in Sprint 30. Sprints 30 to 34 are summarised in
[Backlog-1.5.0.md](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.5.0.md) (Progress) and below.

## Sprint 41: the platform port, first part (1.7.0, done)

74 points in [Backlog-1.7.0.md](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.7.0.md), all built and deployed on 2026-10-13. Each item's changes are in
[CHANGELOG.md](CHANGELOG.md) under "Unreleased".

| Items | What | Migration | Status |
| --- | --- | --- | --- |
| B-9001, B-9002 | Redis for multi-process installs: a server that is one of several refuses to start without `REDIS_URL`, `/readyz` has a `redis` check, and the PDS and label streams poll the database behind the bus | — | **Done** |
| B-9101, B-9102 | Workflow HTTP steps call public hosts on the tenant's list of allowed hosts; no literal credential in a header, query parameter or body field | — | **Done** |
| B-9601, B-9602 | A guardrail rule drafted from a description, saved in shadow, with a second approver before it enforces | `056_guardrail_rule_drafts` | **Done** |
| B-9401 to B-9404 | Held messages: a direct or group message, a group post, a feed comment or an edit the `user-input` guardrail holds waits for a reviewer instead of being refused; re-screening after a guard-model outage | `057_held_writes` | **Done** |
| B-9501 to B-9504 | Takedown as its own state, evidence retention while a case is open, file retention and a version cap per workspace, legal hold on a case or an object with a dual-controlled export | `059_evidence_holds` | **Done** |
| B-9201 to B-9205 | The vault's platform (`sys/`) scope and `service` subject, boot order, the hot-path read, the generic lease table and transit HMAC with key versions | `060` | Done, deployed 2026-10-13 |
| B-9301, B-9302 | Dynamic API-key leases on the generic lease table, and outside providers (GitHub App tokens, built against a fake; no provider registered) | `061` | Done, deployed 2026-10-13 |

Screens changed: Workflows, Messages and feed, Groups and events, Moderation, Files, Storage and Guardrails; the
Vault screen changed in Sprint 42.

Deployed with it, outside the backlog: review queues per agent (`058_moderation_queue_agents`) and rule sets of
scope `agent` applied to their agent's runs. Sprint 36b (B-11707, model thinking templates,
`054_model_thinking_templates`) was finished the same day. Sprint 40 left out B-4006 (the model handing a turn to an
agent) and model-proposed write tools in B-4003.

## Sprint 62: Spend, the cloud screens and the release (2.0.0 "GM", 2026-10-21)

From `Backlog-1.9.99-final.md` (B-10209, B-10606, B-10607, B-10703, B-10704, B-10706, B-10801 to B-10805), migrations `165`
to `167`:

- **B-10209, B-10703** On-prem front doors and the change trail (`cloud/onprem.ts`, `cloud/change-trail.ts`): an existing
  install registered as a deployment without compute for the tunnel and DNS; drift findings name the principal and time
  from CloudTrail, the Azure Activity Log and Cloudflare audit logs.
- **B-10606, B-10607** Anomalies and Cloud spend (`cloud/anomalies.ts`, `cloud-spend.js`): daily spend per service
  against a 14-day robust baseline, one alert per account, day and service naming the top contributors; the Cloud spend
  screen.
- **B-10706** The cloud screens live: Cloud accounts to its board, Deployments, Cloud data, Cloud compute, in a Cloud
  sidebar group.
- **B-10801, B-10802, B-10805** The upgrade path from 1.6.0, 1.7.0 and 1.9.9-qa and back (SQLite, PostgreSQL, MySQL),
  upgrade decisions by migration state (`release-version.test.ts`), the docs check for every epic route and permission,
  the release notes `docs/release-2.0.0.md`; version 2.0.0, named "GM" (the owner's choice over 1.0.0-GM, which semver
  orders below 1.9.9-qa).
- **B-10803, B-10704, B-10804** The security review (13 findings fixed, the rest accepted in `docs/security.md`), eight
  cloud runbooks, and the nightly sandbox job (`exprsn-ai cloud:sandbox-run`, `.github/workflows/cloud-nightly.yml`,
  disabled until the owner sets up the sandbox accounts).

## Sprint 61: Cloudflare edge, model pricing and showback (1.9.99-final, built 2026-10-21)

From `Backlog-1.9.99-final.md` (B-10901 to B-10908, B-10505 to B-10508, B-10608, B-10604), migrations `161`, `163` and
`164` (`162` unused):

- **B-10901 to B-10904** Cloudflare front door (`cloud/edge.ts`, `edge-waf.ts`, `http/client-address.ts`,
  `http/cloudflare-access.ts`): DNS with Full (strict) edge TLS switched without a gap; `CF-Connecting-IP` trusted only
  from Cloudflare's ranges or the tunnel; a tunnel with its token in the vault and `cloudflared` for Helm, systemd and
  Compose (pinned by digest); WAF rules mirroring the server's limits; optional Access for the admin console.
- **B-10905 to B-10908** Cloudflare app tier, R2, D1 and AI Gateway (`cloud/cloudflare-app.ts`, `cloud/r2.ts`,
  `connections/d1.ts`, `cloud/ai-gateway.ts`): Containers behind a Worker with Hyperdrive; R2 with jurisdictions as the S3
  blob store; D1 read-only; AI Gateway in front of cloud model calls with caching and logs off above `internal`. Also
  fixed: `S3BlobStore.deletePrefix` failed on every prefix.
- **B-10505 to B-10508** Model pricing, provider guardrails and residency (`cloud/model-prices.ts`,
  `gateway/residency-client.ts`, `models-cloud.js`): dated per-model prices from the AWS and Azure price APIs and checked
  sheets; Bedrock Guardrails as an extra layer; cross-region and global models refused above `internal`; data-terms
  attestation under dual control; the Models screen with the cloud catalogue.
- **B-10608, B-10604** Cloudflare billing and showback (`cloud/cloudflare-billing.ts`, `cloud/showback.ts`,
  `analytics-showback.js`): Cloudflare analytics and billing as daily cost rows reconciled to the bill, a Workers AI
  neuron check; monthly showback per workspace and tenant with shared costs split by rule, CSV, optional statement lines.

## Sprint 60: GPU compute and cloud model backends (1.9.99-final, built 2026-10-20)

From `Backlog-1.9.99-final.md` (B-10401 to B-10406, B-10501 to B-10504, B-10509, B-10605), migrations `157` to `160`:

- **B-10401, B-10404, B-10405** GPU pools (`cloud/gpu-pools.ts`, `gpu-enrol.ts`, `gpu-node.ts`, `gpu-quotas.ts`): EKS, AKS
  and DOKS GPU node groups and GPU VMs join gateway pools; each node enrols with a single-use token for a certificate
  naming its IP, and the gateway pins it; placements only from the registry mirror; GPU quotas checked at plan time
  with fallback to the next type or zone.
- **B-10402, B-10403, B-10406, B-10605** Autoscale, spot and savings (`cloud/autoscale.ts`, `pools-cloud.js`): scale to
  zero after idle minutes; a cold pool waits with an estimate or takes the profile's fallback; scale up on queue depth;
  spot with an on-demand sibling group, interruption notices draining the instance first; the Pools card; idle-hour
  savings; scale-ups honour the budget's hard stop.
- **B-10501, B-10504** Bedrock and the catalogue (`gateway/bedrock-server.ts`, `cloud/bedrock.ts`,
  `cloud/aws-event-stream.ts`, `cloud/model-import.ts`): Converse and ConverseStream with tools, streaming and usage,
  Titan and Cohere embeddings, residency checks on inference profiles; each account's models imported as drafts with a
  capped label ceiling, never published by the import.
- **B-10502, B-10503, B-10509** Azure, DigitalOcean and Workers AI (`cloud/model-backends.ts`, `gateway/openai-server.ts`
  flavours): Azure AI Foundry and Azure OpenAI with content-filter blocks recorded as guardrail decisions; DigitalOcean
  GenAI inference and agents as registry tools; Workers AI metered in neurons and cost (rates checked 2026-10-20).

## Sprint 59: Managed data, metrics, security and billing (1.9.99-final, built 2026-10-20)

From `Backlog-1.9.99-final.md` (B-10301 to B-10307, B-10702, B-10705, B-10603), migrations `153`, `155` and `156`:

- **B-10301, B-10303, B-10307** Managed databases (`cloud/databases.ts`, `providers/aws-rds.ts`, `azure-databases.ts`,
  `do-databases.ts`): PostgreSQL and MySQL on RDS and Aurora, Azure Flexible Server and DigitalOcean, private endpoints
  only; pgvector, PostGIS and pg_trgm through each provider's allow-list; snapshots with their cost, restore to a new
  instance, deletion protection on by default, and no destroy of a protected database without a final snapshot.
- **B-10302, B-10305** Own database and caches (`cloud/db-move.ts`, `cloud/data-tier.ts`, `cloud/caches.ts`,
  `exprsn-ai db:move`, `docs/runbooks/db-move.md`): a resumable move onto a managed PostgreSQL (backup, restore, a
  read-only window, `migrate --check`, the switch, rollback) under dual control; managed Redis or Valkey as `REDIS_URL`,
  refused with cluster mode, an evicting policy, no TLS or public access.
- **B-10304, B-10306** Document stores and connecting (`connections/dynamodb.ts`, `cosmos.ts`, `mongo-services.ts`,
  `cloud/discovery.ts`): read-only DocumentDB, Cosmos (MongoDB vCore and NoSQL), DigitalOcean MongoDB and DynamoDB;
  discovery of an account's databases and connect with private endpoints, vault passwords, leased users, RDS IAM and
  Entra tokens.
- **B-10702, B-10705** Metrics and security (`cloud/cloud-metrics.ts`, `platform/metadata.ts`,
  `deploy/observability/grafana/exprsn-ai-cloud.json`): cloud metrics, 11 alerts and a dashboard; metadata addresses
  refused on every outbound path; IMDSv2 on EKS nodes too; generated least-privilege IAM policies.
- **B-10603** Billing ingestion (`cloud/costs.ts`, `cloud/billing-spend.ts`): AWS Cost Explorer (one request per account
  per day, the owner's choice), Azure Cost Management and DigitalOcean invoices into `cloud_costs`; budgets use actual
  spend when billing data is fresh, estimates otherwise.

## Sprint 58: Platform deployment (1.9.99-final, built 2026-10-20)

From `Backlog-1.9.99-final.md` (B-10203 to B-10208, B-10602), migrations `151` and `152`:

- **B-10203, B-10207** Kubernetes and upgrades (`cloud/releases.ts`, `upgrades.ts`, `helm.ts`, `kube.ts`,
  `kubeconfig.ts`, `chart-values.ts`, `providers/aws-eks.ts`, `azure-aks.ts`, `do-doks.ts`): EKS, AKS and DOKS with node
  groups, a short-lived kubeconfig per operation, the chart installed by Helm 3.19.0 (`HELM_BIN`, pinned) with values
  from the spec; upgrades by image digest with a snapshot, `migrate --check`, rolling update and automatic app rollback
  on a failed verify; database restore only from the snapshot under dual control.
- **B-10204, B-10205** VM and container targets (`cloud/compute.ts`, `providers/aws-compute.ts`, `azure-compute.ts`,
  `do-apps.ts`): VMs installed by cloud-init from a release tarball verified by sha256 (`install.sh --from-release`;
  building from a checkout needs `--from-source`), IMDSv2 with hop limit 1, secrets as systemd credentials from a
  single-use wrapped token; ECS on Fargate, Container Apps and App Platform with migrations as a one-off before each
  rollout; the planner refuses any secret as a plain environment variable.
- **B-10206, B-10602** DNS, TLS and budgets (`cloud/cloud-dns.ts`, `cert-push.ts`, `value-from.ts`, `budgets.ts`,
  `spend.ts`): records whose value comes from another resource; dns-01 through Route 53, Azure DNS and DigitalOcean;
  renewed certificates pushed to load balancers; monthly budgets with alerts at 50, 80 and 100 % and a hard stop
  (`budget_exceeded`) with a 7-day override by a second admin; spend from applied estimates until billing ingestion.
- **B-10208** Cloud keys and blobs (`platform/kms-cloud.ts`, `blob-azure.ts`, `cloud-identity.ts`): `KMS_PROVIDER`
  `aws-kms` and `azure-keyvault` with ES256 checkpoint signing, `kms:rewrap` from `local` verified end to end;
  `BLOB_STORE=azure`.
- Tests run offline for the clouds: `EXPRSN_TESTS_OFFLINE` makes `guardedRequest` refuse real provider hosts
  (`test/setup-offline.ts`, `test/offline-guard.test.ts`).

## Sprint 57: Deployment engine (1.9.99-final, built 2026-10-20)

From `Backlog-1.9.99-final.md` (B-10102 to B-10108, B-10201, B-10202, B-10601, B-10701), migrations `148` to `150`:

- **B-10102 to B-10105, B-10701** The engine (`cloud/graph.ts`, `journal.ts`, `planner.ts`, `apply.ts`, `verify.ts`,
  `audit.ts`, `routes/admin/cloud-deployments.ts`): the resource graph and an append-only journal that a crashed apply
  resumes from; plans with field changes, replace reasons, a hash and a 60-minute expiry, refused when the cloud changed;
  the apply worker (`cloud.apply`, `cloud.poll`) with one lease per deployment; verify (`cloud.verify`); `cloud.*` audit
  entries with provider request ids. The planner also refuses a data resource with a public address.
- **B-10106 to B-10108** The lifecycle (`cloud/lifecycle.ts`, `drift.ts`, `destroy.ts`, `orphans.ts`): scheduled drift
  with revert, adopt or ignore; reverse-order destroy that stops at protected resources for a snapshot and a second
  admin; rollback to the last verified state; the orphan sweep; per-class rate buckets, provider throttling signals and
  a circuit breaker in `providers/transport.ts`, with Prometheus metrics.
- **B-10201, B-10202, B-10601** Specs, network and prices (`cloud/spec.ts`, `network.ts`, `render.ts`, `prices.ts`,
  `price-sheet.json`): the deployment spec and wizard API, refused before any provider call when placement fails;
  networks and firewalls rendered from the zone specs' rules; estimates from the providers' price APIs and a dated sheet
  (its values still to be checked against the providers' pages).

## Sprint 56: Cloud accounts and credentials (1.9.99-final, built 2026-10-20)

From `Backlog-1.9.99-final.md` (B-10002 to B-10009, B-10101, B-10109), migrations `146` and `147`:

- **B-10002, B-10007 to B-10009** Cloud accounts (`cloud/accounts.ts`, `cloud/validate.ts`, `routes/admin/cloud.ts`,
  console `cloud.js`): platform or tenant accounts for AWS, Azure, DigitalOcean and Cloudflare under dual control;
  permissions `cloud:*` and `finops:*` and the Cloud admin, Cloud operator and FinOps analyst roles; validation of
  identity and per-feature permissions; region allow-lists with label ceilings and per-tenant residency in
  `authz/policy.ts`; the `exprsn:*` tags (`cloud/tags.ts`).
- **B-10003 to B-10006** Federation and credentials (`cloud/credentials.ts`, `cloud/issuer.ts`): AWS web-identity and
  Entra client-assertion federation from a separate issuer whose keys stay in custody, publication to a bucket or a
  console path, vaulted credentials in the platform vault scope with AWS and Azure rotation.
- **B-10101, B-10109** Provider adapters (`cloud/providers/`) over one transport with the egress checks and a rate
  limit per account; networks, firewalls, buckets and DNS records first; fakes for all four providers.

## Sprint 52: Feature flags and search (1.9.0, done 2026-10-18)

From `Backlog-1.9.0.md` (B-167 to B-173, 58 points), migrations `137` to `139`:

- **B-167 to B-169** Feature flags (`flags/model.ts`, `flags/service.ts`, `s.flags`): on/off, variant and number flags
  with a life cycle and stale warnings; values at platform, plan (B-162 entitlement `flag.<key>`), tenant and
  workspace, the most specific winning, each with a sticky percentage rollout; live platform changes under dual
  control; `s.flags.on`/`value`, flags in the session, the `data-flag` gate (`web/js/flags.js`), a workflow branch and
  app-flow leaf, plugin capability `read:flags`.
- **B-170** The search index (`search/`): per-tenant keyed HMAC postings with positions and hashed 2-4 character
  prefixes, no plaintext terms, indexing after commit, a resumable backfill, rebuild and key rotation; off until a
  tenant admin enables it; leakage in `docs/security.md`.
- **B-171 to B-173** Search across conversations (keyword plus meaning), full-text posts with visibility, blocks,
  mutes and labels, and one search box (`#/search`, a combobox, palette commands and "/"); every result re-checked as
  the reader.
- 1.9.9-qa (Sprint QA-1, the leftovers): saved searches (`search/saved.ts`, migration `145_saved_searches`, sealed, per
  person), "Search in this conversation / group / feed", result links to the exact message or comment
  (`GET /api/search/messages/:id/locate`), and live flag changes (`realtime/flags.ts`, the `flags.changed` event).

## Sprint 54: User stores (1.9.0, done 2026-10-18)

From `Backlog-1.9.0.md` (B-180 to B-186, 54 points), migrations `140` and `141`:

- **B-180** The role matrix accordion (already in place).
- **B-181** The store wizard and form editor over a kind registry (`identity/providers/kinds.ts`).
- **B-182** Active Directory (`identity/providers/ad.ts`): sAMAccountName or UPN, nested groups, objectGUID, account
  control, paging, TLS, SRV.
- **B-183** Cloud directory presets (`identity/providers/cloud-directory.ts`): Entra ID through Microsoft Graph,
  Google Workspace through the Directory API with a service-account assertion, SCIM presets.
- **B-184** Exprsn platform accounts (`federation/exprsn-platform.ts`), sign-in with PKCE; the platform's CA tokens on
  API calls (`federation/platform-tokens.ts`, 2026-10-19): opt-in per store, tenant from the store (`X-Exprsn-Tenant`
  when several match), linked accounts only, checked with the CA's validate endpoint every time (cached briefly).
- **B-185** Archive and restore (`identity/store-admin.ts`) and **B-186** sealed, signed store backups
  (`identity/store-backups.ts`).

## Sprint 53: Community (1.9.0, done 2026-10-18)

From `Backlog-1.9.0.md` (B-174 to B-179, 52 points), migrations `133` to `136`:

- **B-174** Group proposals (`groups/governance.ts`): free-form, setting, member (invite or accept), role, rules
  (sealed text) and budget kinds (a minimal ledger, `groups/budget.ts`); governance settings per group.
- **B-175** Voting (`groups/tally.ts`): majority, supermajority, approval and ranked choice with recorded tie-breaks;
  quorum; the electorate fixed at opening; secret ballots stored without a voter, with receipts checked against the
  commitments published at close (limits in `docs/security.md`); tallies in the audit chain.
- **B-176** Carrying out decisions as the group (`groups/service-principal.ts`, owner rights in its own group only),
  owner confirmation for chosen kinds, at most once.
- **B-177** Albums on Files (`files/albums.ts`): personal, group and workspace albums whose items stay files;
  contributor roles; an access rule never wider than a share the adder could make; grid, slideshow, zip download.
- **B-178** Share links and upload links (`files/album-links.ts`): expiry, password, view or download; uploads scanned
  and held, limited, recorded in the spam signals, at the album's label.
- **B-179** Albums in the feed and on group pages; contributors notified in 10-minute batches.

## Sprint 55: CA, Auth and leaked passwords (1.9.0, done 2026-10-18, before 52 to 54 at the owner's choice)

From `Backlog-1.9.0.md` (B-187 to B-195, 68 points), migrations `127` to `131`:

- **B-187** CA settings (`pki/settings.ts`): subjects, validity, key types (RSA 2048 to 4096, ECDSA P-256 and P-384),
  path length, CRL, OCSP and ACME settings with per-tenant overrides; environment values are floors; root and
  intermediate changes under dual control, applied at the next rotation or re-issue, never by a silent re-key.
- **B-188** CA tokens (`pki/tokens.ts`): JWS signed in custody, bound to a resource with permission bits, expiring by
  time or uses; refresh, introspect, revoke and bulk revoke; one-time tickets; only hashes stored.
- **B-189** Member certificates (`pki/members.ts`): off by default; issued at join, renewed, revoked at offboarding;
  certificate sign-in through `PKI_CLIENT_CERT_PROXIES` only, re-verified by the app.
- **B-190** Sign-in policy (`identity/signin-policy.ts`): length (floor 12), optional character rules, closeness to
  the old password, history, lockout, session lifetimes, step-up window and MFA methods per tenant; one check path.
- **B-191** OAuth and OIDC client settings (`federation/client-settings.ts`): lifetimes, PKCE, consent, rate limits,
  refresh rotation with reuse detection.
- **B-192/B-193** Leaked-password lists (`identity/leaked/`): HIBP, SHA-1 and plain-text imports into prefix shards
  with a Bloom filter, versions, an optional HIBP mirror; checked at every save and, for new lists, at sign-in.
- **B-194** Tenant deny words (`identity/deny-words.ts`), normalised like the Sprint 50 term lists.
- **B-195** Certificates › Settings and Tokens, Identity › Sign-in policy, Platform › Leaked passwords; CLI
  `pki:settings`, `passwords:import`, `passwords:lists`, `passwords:check`.
- Also on 2026-10-18 (owner's request): notification templates (`platform/notification-templates.ts`, migration
  `132`) and the Settings › Notifications table (wrapped titles, collapsible groups, Enable all / Disable all).
- Fixed in integration: a step-up check called without `await` after `requireRecentAuth` became async
  (`routes/atproto.ts`), and the guard `server/test/stepup-awaited.test.ts`.

## Sprint 51: Billing (1.9.0, done 2026-10-18)

From `Backlog-1.9.0.md` (B-162 to B-166, 50 points), migrations `124` to `126`:

- **B-162** Plans and subscriptions (`billing/plans.ts`, `billing/subscriptions.ts`): a plan catalogue with prices per
  cycle and currency, seats, allowances and entitlements, every version under dual control; a tenant's subscription
  with trial, renewal, cancel at period end, pause and changes prorated to the second; `s.subscriptions.at`/`periods`.
- **B-163** Billing cycles (`billing/cycles.ts`, `billing/engine.ts`): monthly, quarterly, annual and custom with an
  anchor; the plan and seats in advance, usage beyond allowances in arrears; monthly statements unchanged.
- **B-164** Tiered pricing (`billing/tiers.ts`): flat, graduated, volume and package, minimums and caps.
- **B-165** Discounts (`billing/discounts.ts`): rules by scope and kind, promotion codes with limits, a stacking order
  and a cap, each its own line; a second admin above a threshold.
- **B-166** Statement PDF (`billing/pdf.ts`), Stripe invoice lines with idempotency keys (`billing/invoice-lines.ts`),
  the Billing screens (`billing-plans.js`).

## Sprint 50: Guardrails, spam and flood (1.9.0, done 2026-10-18)

From `Backlog-1.9.0.md` (B-155 to B-161, 52 points), migrations `119`, `120`, `122` and `123`:

- **B-155** Rule-set tests (`guardrails/rule-tests.ts`): cases on a set, sealed, run after every draft change and on
  demand; publish, approve and promote refused with 409 and the failing cases; imported from replay hits, decisions
  and CSV within label and clearance.
- **B-156** Term lists (`guardrails/terms.ts`, `guardrails/term-match.ts`): versioned deny and allow lists with
  normalisation (case, accents, leetspeak, confusables, spacing) and an Aho-Corasick matcher; mechanism `term-list`.
- **B-157** Nested conditions (`platform/condition-tree.ts`, shared with `apps/flows.ts`; `guardrails/conditions.ts`):
  all/any/none trees of mechanisms and context, per-category classifier thresholds, the spam score as a leaf, explain.
- **B-158** Metrics (`spam/metrics.ts`): hits, action rates, false positives from overturned appeals, time to
  decision; an Overview card and a CSV export.
- **B-159** Rate signals (`spam/signals.ts`): sliding windows per account, IP range and tenant in the limiter store.
- **B-160** Spam patterns (`spam/patterns.ts`): SimHash near-duplicates, link bursts, new domains, mention flooding,
  new-account velocity, coordinated clusters; a score with reasons; only fingerprints and counts stored.
- **B-161** Graduated responses (`spam/policy.ts`, `spam/service.ts`): off until a policy is saved, then shadow per
  surface until enforced; slow mode, hold, a posting limit, a case; backed by a warning, appealable, never a ban.

## Sprint 49: Push notifications (1.9.0, done 2026-10-16)

From `Backlog-1.9.0.md` (B-150 to B-154, 56 points), migrations `115` to `118`:

- **B-150** Devices (`platform/push-devices.ts`, `s.pushDevices`): iOS, Android, web and desktop endpoints with the
  token or Web Push subscription sealed; Settings › Devices; pruned when a provider reports them gone or after 90 idle
  days; revoked with the person's sessions (a `SessionService` hook) and at offboarding.
- **B-151** Providers (`push/`, `s.push`): APNs with an ES256 token, FCM HTTP v1 with a service-account assertion, Web
  Push (RFC 8291 and VAPID in `node:crypto`), any HTTP vendor by template and mapping, WebSocket; credentials only as
  vault references; HTTP/2 through the egress guard (`guardedHttp2Connect`), one session per origin.
- **B-152** Delivery: a job per notification and device, retries honouring `Retry-After`, gone tokens dropped, collapse
  id, TTL and priority, WebSocket first then push, a 30-day delivery log, metrics per provider.
- **B-153** Preferences (`platform/notification-prefs.ts`, `s.notificationPrefs`): per kind and channel, instant or
  digest, quiet hours in the person's zone with urgent passing, tenant defaults and mandatory kinds (security).
- **B-154** Platform › Push providers, Settings › Devices and Notifications, Tenants › Notifications, `web/sw.js`,
  `push:test`.

## Sprint 48: Access and safety (1.8.0, done 2026-10-16)

From `Backlog-1.8.0.md` (B-143 to B-149, 58 points), migrations `105` to `111`:

- **B-143** App-local roles (`apps/roles.ts`): a catalogue per app, given to people, groups or a workspace default;
  policies name them as the subject `app_role`; explain shows the role; never widens tenant permissions or clearance.
- **B-144** Scan gate (`security/scans.ts`): Trivy, SARIF and CycloneDX results by artefact digest; thresholds, a
  licence deny-list and exceptions under dual control; checked at promotion, plugin enable and upgrade, script images.
- **B-145** Emergency vault seal (`vault/seal.ts`): dual control or break-glass with the escrow threshold; every
  instance and the signer drop their keys; unseal with escrow shares. Live use needs a signer restart and an escrow.
- **B-146** Use-limited keys: `max_uses` on API keys, their leases and embed sessions; revoked at zero.
- **B-147** Plugin creator (`plugins/drafts.ts`): a wizard that writes a checked manifest, installed as a draft.
- **B-148** Overview cards (`ops/overview-cards.ts`): pin, hide, reorder per admin; no card without its permission.
- **B-149** Knowledge feedback and page tree (`knowledge/feedback.ts`, `knowledge/tree.ts`): helpfulness with sealed
  comments, curation list and eval seed; parent pages, breadcrumbs and backlinks.

## Sprint 44: Insight in Apps (1.8.0, done 2026-10-16)

From `Backlog-1.8.0.md` (B-120 to B-124, 60 points), migrations `100` to `104`:

- **B-120** Charts (`apps/charts.ts`, `apps/chart-render.ts`): bar, line, area, pie and donut, scatter, number tiles
  and tables over an entity (with a saved view), a saved query or a REST endpoint; date buckets in `records/aggregate`;
  computed as the viewer (hidden rows never counted, a hidden or masked field makes the chart unavailable); inline SVG
  with a text summary, keyboard through the points, a table alternative and patterns besides colour.
- **B-121** Dashboards (`apps/dashboards.ts`): cards, dashboard filters, auto-refresh, private or shared; every card
  computed as the viewer; HTML and PDF snapshots through `s.apps.dashboards.render`.
- **B-122** Reports (`apps/report-engine.ts`, `apps/reports.ts`): table, grouped with subtotals, cross-tab;
  parameters, computed columns on the formula evaluator, conditional formatting in words and icons; rows read as the
  viewer, masked values stay masked through every total; run history with sealed results that expire.
- **B-123** Exports (`apps/exports.ts`, `imports/xlsx-writer.ts`): XLSX with typed cells, PDF, CSV and HTML of
  records, views, reports and dashboards; large ones as a job into a sealed file kept 7 days; one `s.appExports.render`.
- **B-124** Scheduled delivery (`apps/subscriptions.ts`): subscriptions by email (each recipient's own render), to the
  file store or a signed webhook on an allowed host; schedules with a time zone claimed once; "only if rows" and "only
  if changed"; re-checked every run; pause after repeated failures; a signed one-click unsubscribe.

## Sprint 47: Builders' tools (1.8.0, done 2026-10-15)

From `Backlog-1.8.0.md` (B-136 to B-142, 52 points), migrations `094` to `099`:

- **B-136** Workflow templates (`workflows/templates.ts`, `template-catalog.ts`): six built-in starters (lead
  follow-up, invoice approval by amount, weekly report, onboarding, webhook to record, document intake) seeded by `094`,
  save as template, use template with a binding step for every reference (tools, profiles, connections, saved queries,
  decision tables, knowledge bases, roles); the gallery at `#/workflows?view=templates`.
- **B-137** Designer editing (`workflows-editing.js`, `workflows/comments.ts`, `workflows/tags.ts`): step comments
  (authors set by the server), copy, paste and duplicate across workflows, undo and redo, zoom, a minimap, shortcuts,
  tags and per-person favourites.
- **B-138** Schedules with a time zone (`workflows/schedules.ts`, migration `096`): DST-correct next runs, 21 presets,
  a next-runs preview, plain-word errors; UTC schedules unchanged.
- **B-139** Workflow analytics (`workflows/analytics.ts`): outcomes, success rate, p50 and p95, slowest steps, failure
  reasons and daily trends over up to 366 days; the "Running now" board.
- **B-140** Presence and soft locks in the workflow, flow, form and entity designers (`realtime/design-locks.ts`,
  `App.designPresence`): viewers and one editor at a time in the database and on the bus, takeover, saves refused while
  someone else holds a live lock, an admin break.
- **B-141** About 72 formula functions in the safe evaluator (`apps/formula-functions.ts`), a catalogue the editor
  lists; nesting now counts calls.
- **B-142** Files: version compare (text, PDF, Word; images side by side), alt text and descriptions on images with a
  suggestion that a person accepts, and metadata (EXIF, GPS, XMP, IPTC, C2PA) stripped from every served copy
  (`files/exif.ts`); the stored original only to its owner with `?original=1`.

## Sprint 45: Data in (1.8.0, done 2026-10-15)

From `Backlog-1.8.0.md` (B-125 to B-129, 50 points with B-129 added by the owner the same day), migrations `090` to `093`:

- **B-125** Saved connection queries (`connections/saved-queries.ts`, `connections/params.ts`): named, typed parameters
  always bound, classified when saved and again on each run against the current allow-list, masking and the `db-query`
  guardrail, published versions, the built-in tool `connections.query`, knowledge source kind `saved-query`, lookup
  source `query`. Running needs the new permission `connections:query` (connection, tenant and workflow admins and
  knowledge curators; not members).
- **B-126** REST connections (`connections/rest.ts`): allowed hosts only, checked again at dial time, no redirects,
  sealed or `vault:` credentials (a `credential-moves` SPECS entry), OAuth2 client credentials, paging styles,
  response mapping, the `untrusted-content` checkpoint on every answer; as an entity source, lookup and knowledge
  source.
- **B-127** Spreadsheet import (`apps/sheet-import.ts`, `import-transforms.ts`, `import-read.ts`, `import-infer.ts`):
  XLSX, CSV, JSON and JSON Lines, "new entity from file" with inferred types and PII flags, a fixed set of
  transformations, upsert by key, dry run, per-row report, an error CSV; the import stepper in `apps-import.js`.
- **B-128** Relations (`apps/relations.ts`): the `relation` field (many-to-many in `app_record_links`, self and
  symmetric relations, two-way, max, required, unlink or block on delete) and back-references of a reference; links
  shown only when their other end is readable; filters and sorting by links, expand in the entity API, packages.
- **B-129** Import from connections: a table, a saved query or a REST endpoint into an entity, once or on a schedule,
  as the person who set it up, re-checked each run, idempotent by source row key.

## Sprint 46: Automation (1.8.0, done 2026-10-15)

From `Backlog-1.8.0.md` (B-130 to B-135, 46 points), migrations `085` to `089`:

- **B-130** A `webhook` trigger source for every workflow on one signed-hook core shared with app flows
  (`workflows/signed-hooks.ts`, `workflows/hooks.ts`, `POST /hooks/workflows/<tenant>/<workflow>`): off by default, a
  sealed secret shown once, HMAC over timestamp and body, a five-minute window and replay refusal on every instance, the
  owner re-checked per request, the payload through the content guardrails and the trigger schema.
- **B-131** Decision tables (`decisions/table.ts`, `decisions/service.ts`, `/api/decision-tables`): typed input and
  output columns, the hit policies first, unique, priority, any and collect, exact overlap checks at publish, versions,
  a test panel; used as the workflow step `decision`, the app-flow action "Decide with a table" and the read-only tool
  `decision.evaluate`. The console view is `#/workflows?view=decisions`.
- **B-132** The `switch` step: ordered cases (equals, one of, a number range) and a default, one edge taken.
- **B-133** Approvals with a soft due time, reminders, escalation, automatic decision on breach (approving only when
  the step allows it, re-checked when it fires), a timeout edge, and `all` or N-of-M quorum, on a durable tick
  (`workflows/approval-deadlines.ts`).
- **B-134** SLA policies with business hours, pause and resume, warn and breach actions, and assignment routing
  (round-robin, least-loaded, skills, availability with a fallback) for channel sessions, flags, held writes and appeals
  (`sla/hours.ts`, `sla/service.ts`, `/api/sla/*`; the console's `App.sla` in `web/js/screens/sla-routing.js` on
  Moderation, Flags and Channels).
- **B-135** Run retention by tenant policy and per-workflow override (`workflows/retention.ts`), never deleting waiting
  runs, recent runs, open dead letters or held runs; the Retention tab on Workflows.

## After 1.7.0: console and productivity round (2026-10-15, unreleased)

The owner's UI and UX round, before 2.0.0: the sidebar as an accordion by domain with a 64 px icon rail and hideable
side panels on every screen (`web/js/app.js`, `e2e/tests/shell-sidebar.spec.ts`); Chat exports as Word, OpenDocument,
PDF, HTML, plain text and RTF, conversation folders and message groups (migration `076_chat_folders`); folders in
Messages and feed (`077_dm_folders`); a `script` step in workflows and a grouped, searchable tool picker; the
exprsn-platform low-code builder ported into Apps: flows on Workflows, the records board, the advanced table and mapped
CSV import (`079_lowcode_port`, `docs/decisions/lowcode-port.md`). Not done from the port: saved views, form sections
and wizard steps, nested form conditions, flows in packages and bundles. Details in `CHANGELOG.md` under Unreleased.

## Release 1.7.0

The workspace, the server and the chart are versioned `1.7.0`, with the changes in [CHANGELOG.md](CHANGELOG.md) and
the backlog in [Backlog-1.7.0.md](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.7.0.md). Sprints 40 to 43 added agents, tools, skills and workflows called
from a conversation; dataset import, knowledge sets, eval sets and the Import screen with imported classifier engines;
Redis for multi-process installs; workflow HTTP steps to listed public hosts; the vault's platform scope with named,
rotatable platform keys, a generic lease table, transit HMAC and dynamic API-key leases; held messages; evidence
retention and legal hold on cases and objects; the guardrail rule builder; sessions and API keys as leases, signing
keys as vault keys and third-party credentials moved to the vault (each an explicit, reversible step); group bans,
invite links, profile fields, search, custom roles, moderators' cases, event extras and linked conversations; and in
Sprint 43 groups as access subjects for files, folders, vault paths, knowledge and apps, the response cache,
`did:exprsn`, declarative plugin UI surfaces and cross-posting public posts to the author's PDS repo. Migrations
`050_dataset_import` to `073_feed_crosspost`. Left out: B-4006 and model-proposed write tools in B-4003 (Sprint 40);
B-11401's live run on the public network is the operator's (the runbook is in `docs/deploy.md`). The suite at
release: 1397 tests across 164 files (one load-dependent failure in a full run, `sprint18` YAML caps, passes alone);
the full Playwright console suite run locally at the release, 201 passed, 0 failed, after two fixes (the Analytics
spec read a row before the model dimension had rendered; the MCP authorization spec now serves its client's redirect
address instead of relying on route interception of a redirected navigation) (B-5901). The known gaps of each sprint
are in [docs/security.md](docs/security.md). Tagging `v1.7.0` and publishing the image and chart remain with the
maintainers.

## Release 1.6.0

The workspace, the server and the chart are versioned `1.6.0`, with the changes in [CHANGELOG.md](CHANGELOG.md) and
the backlog in [Backlog-1.6.0.md](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.6.0.md). Sprints 35 to 39 added model servers beyond Ollama (`kind: openai`
instances, Apple's on-device model among them) and the five platform administration screens; groups depth and
categories, blob deduplication, held form values, vault access anomalies and image classification in Knowledge; the
HTTP tool kind, prompt-injection defence with its CI corpus, SCIM 2.0 provisioning, the MCP server with MCP
authorization and per-user OAuth, vault sharing, MongoDB leases, quote posts and per-post visibility; the AI system
inventory with its register export, usage and cost analytics with chargebacks, `gen_ai` span attributes, JSONL audit
exports with chain proofs and per-tenant SIEM destinations, red-team suites with a publish gate, agent identities,
agent handoffs, row and field policies with masking and an explain view, DLP detectors with hold and redact rules,
legal holds and a compliance export API; and C2PA content credentials on generated images, versioned chat artifacts,
app packages with environments, promotion, deployment history, rollback and git export, data model drafts from a
description, AI field fills and regeneration, outside PostgreSQL and MySQL tables as app entities, a REST and schema
API per app with a generated OpenAPI document and client, and public and signed app embeds. B-5001 (capability
tokens) was dropped on 2026-10-07; B-7202 (SCIM against the Entra ID and Okta validators) stays partial with a local
conformance suite. Migrations `037_model_servers` to `041d_entity_api_embeds`. The suite at release: 1170 passed and 1
skipped across 126 files; the PostgreSQL integration suite (52 files) and the prototype smoke (51 screens) locally;
the full Playwright console suite run locally at the release, 168 passed, 0 failed, after fixes to the
sweep list, the harness driver, an Analytics reload race and the draft dialog's accessibility pass (B-5101). The known gaps of each sprint are in [docs/security.md](docs/security.md). Tagging `v1.6.0` and
publishing the image and chart remain with the maintainers.

## Release 1.5.0

The workspace, the server and the chart are versioned `1.5.0`, with the changes in [CHANGELOG.md](CHANGELOG.md) and
the backlog in [Backlog-1.5.0.md](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.5.0.md). Sprints 29 to 34 gave the 1.4.0 features their screens
(Certificates, Vault, Plugins and events, Apps, Files, Moderation, Groups and events, Channels, Messages and feed, Roles
and access and AT-Protocol, with identity additions on Sign in, Settings, Identity and User stores) and added
permission matrices, custom roles, effective access and access reviews; record queries PostgreSQL answers from an
index; CalDAV, CardDAV and WebDAV for the file store with DAV-only app passwords managed in Settings; model-based memory
management; MongoDB connections; an AT-Protocol PDS with feed generators and relay commit verification; import
repositories and model import; Workflows 2 (sub-workflow, agent, map and loop steps, skills on model steps, event and
schedule triggers, retries, failure edges and dead letters, signed bundles, domain built-in tools, approval forms,
notify and webhook steps) on one chain context across chat, agents, workflows, tools, skills, plugins and app
triggers; chaining agents, skills, tools and workflows with checks at publish, held calls decided from the root and a
chain view; profiles and presence with the Person page; and the IMAP adapter against GreenMail in CI. Sprint 33 (chat
invocation and dataset import) moved to 1.7.0. Migrations `031_access` to `036c_dav_files`. The suite at release: 985
passed and 1 skipped across 86 files; the PostgreSQL and MySQL integration suites, `litmus`, GreenMail and the PDS
interop job in CI. B-3104 (the DAV conformance run) stays partial and B-3606 (capturing real DAV client traffic) was
dropped by the owner (not needed); it had been held because macOS 27 Calendar refuses Basic authentication over plain HTTP, and capturing over TLS needs a per-host
certificate trust on the owner's Mac that was not approved. The known gaps of each sprint are in
[docs/security.md](docs/security.md). Tagging `v1.5.0` and publishing the image and chart remain with the maintainers.

## Release 1.4.0

The workspace, the server and the chart are versioned `1.4.0`, with the changes in [CHANGELOG.md](CHANGELOG.md) and
the backlog in [Backlog-1.4.0.md](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.4.0.md). Sprints 24 to 28 re-implemented exprsn-platform's server
features in Exprsn-AI: the certificate authority with OCSP and an ACME server, the secrets vault with leases, the event
catalogue and plugins; AT-Protocol keys, DIDs, labeler, sign-in and firehose ingest; moderation actions and appeals,
the file store, low-code data apps, groups and events, customer-service channels, messaging and the workspace feed.
They are server-only: no console screen changed, and the screens are planned in [Backlog-1.5.0.md](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.5.0.md)
(Sprints 29 to 32). Migrations `026_pki_secrets` to `030c_feed`. The suite at release: 794 passed and 1 skipped across 66 files; the PostgreSQL
integration suite against throwaway servers (22 files), MySQL and Redis in CI. The platform load test (B-2105,
[docs/loadtest.md](docs/loadtest.md)): every target met with the `ci` targets on SQLite, and on PostgreSQL every target but one: the records query p95 (732 ms against 250 ms; the query path sorts every matching record, fix planned for 1.5.0). The known gaps of each sprint are in [docs/security.md](docs/security.md).
Tagging `v1.4.0` and publishing the image and chart remain with the maintainers.

## Release 1.3.0

The workspace, the server and the chart are versioned `1.3.0`, with the changes in [CHANGELOG.md](CHANGELOG.md) and
the backlog in [Backlog-1.3.0.md](https://github.com/ExprsnIO/Exprsn-AI/blob/b49b596a57da4a1087ad6f501f1aea162dd4105f/Backlog-1.3.0.md). The ASVS assessment ([docs/asvs.md](docs/asvs.md)), the known
gaps ([docs/security.md](docs/security.md)) and [docs/accessibility.md](docs/accessibility.md) are updated for what
Sprints 20 to 23 closed. The release line starts from `main` with 1.2.0 and the dependency fixes (PR #20: otplib 13
through `server/src/identity/totp.ts`, `@types/node` 26, TypeScript 7). The suite after the merge: 532 tests passed and
1 skipped across 42 files, and 57 Playwright tests passed (with axe-core in Standard and Enhanced, light and dark, and
the dialog and drawer reflow spec). The supply-chain steps of B-1204 have not yet run on GitHub. Tagging `v1.0.0` and
publishing the image and chart (B-601) remain with the maintainers.
