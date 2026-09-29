# Sprints

Two-week sprints that turn the [design prototype](design/prototype/README.md) into the production application.
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
| 5 | Guardrails, classifiers, flags | Guardrails, Classifiers, Flags | **Next** |
| 6 | Knowledge, memory, connections | Knowledge, Memory, Connections | Planned |
| 7 | Registry, MCP servers, agent runs, scripts | Registry, MCP servers, Runs, Scripts | Planned |
| 8 | Workflows, media, images | Workflows, Media, Images | Planned |
| 9 | Training, zones, platform, federation | Training, Zones, Platform, Identity | Planned |
| 10 | Hardening and release | all | Planned |

Current codebase: Sign in, Settings, User stores, Tenants, Usage and audit, Models, Pools, Profiles, Chat and Compare
are live, and the other 17 sidebar screens show prototype data; four database migrations (`001_core` to `004_chat`);
120 unit and API tests (against a fake Ollama for the gateway and chat) plus the integration suite against
PostgreSQL, MySQL, OpenLDAP and Redis.

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

Left for later sprints (see `docs/security.md`, known gaps): guardrails on prompts and answers (Sprint 5); knowledge,
memory and tool bindings in chat (Sprints 6 and 7); continuing a stream on another instance after the serving
instance stops.

## Sprint 5: Guardrails, classifiers, flags (next)

The eleven checkpoints; RE2 patterns, PII detectors and the guard model through Ollama; shadow and enforce; precedence
platform > tenant > workspace > agent; fail closed; versioned rule sets with diff, shadow replay and dual control;
classifiers with thresholds, test and batch jobs; the flag queue with SLA timers, clearance redaction and keyboard
actions.

## Sprint 6: Knowledge, memory, connections

Knowledge bases and sources (upload, S3, Git, database view); extraction and structure-aware chunking; embeddings
through Ollama; `VectorStore`; hybrid search with reciprocal rank fusion and reranking; clearance filter inside the
query; blue/green reindex. Memory scopes, proposals, forget across every backend, export. Data connections
(PostgreSQL, OpenSearch) with schema allow-lists, query classification, read-only accounts, row caps and PII masking.

## Sprint 7: Registry, MCP servers, runs, scripts

Registry entries (tools, skills, agents) with automated checks, review and publish scope; MCP servers over streamable
HTTP on internal hosts only, schema hashing and change detection, per-user vault tokens; agent runs with think/do/calc
lanes, approvals, budgets and replay from checkpoints; script sandbox (container, no network, limits) and the
promotion path.

## Sprint 8: Workflows, media, images

Workflow graphs with publish validation (acyclic, schemas, labels, limits), durable checkpointed execution, approvals,
dry run and replay; media presets as validated argument arrays with caps and NVENC/CPU encoders; image generation
through a ComfyUI/diffusers worker with the safety classifier, provenance sidecar and GPU-second quota.

## Sprint 9: Training, zones, platform, federation

Training jobs (datasets with PII scrub, approval for confidential data, windows, checkpoints, evals, GGUF conversion to
a registry draft); zones (definitions, ceilings, draft and approve, rendered Compose and firewall configuration);
platform (signed import bundles, mirrors, ACME certificates, backups and restore drills); the Identity screen: OIDC
provider (ES256 JWKS, key rotation, clients), SAML IdP, upstream OIDC/SAML federation, Kerberos SPNEGO and device flow.

## Sprint 10: Hardening and release

OWASP ASVS level 2 review; dependency scanning and SBOM; load test of the streaming path; Helm chart and
NetworkPolicies; backup, restore and incident runbooks; accessibility (AA and AAA modes); a Playwright suite across
every screen; the 1.0 release.
