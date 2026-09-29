# Exprsn-AI: architecture and delivery plan

Exprsn-AI is a self-hosted, multi-tenant control plane and chat interface for models served by Ollama. The design
prototype in [`design/prototype`](../design/prototype/README.md) (27 screens) is the specification for behaviour
and copy. This plan turns it into a production application server, in two-week sprints.

## Decisions

| Topic | Decision |
| --- | --- |
| Server | Node.js 22+, TypeScript (strict), Express 5, Socket.io 4 on the same HTTP server |
| Console | The prototype's vanilla-JS screen modules (`App.register`), served by the server, with `DATA` replaced by API and socket calls screen by screen. No build step; strict CSP (`script-src 'self'`) |
| Application database | Dialect-agnostic through Knex: **PostgreSQL** (recommended), **MySQL 8**, or **SQLite** (single small node). No database-specific features in the core schema; tenant isolation is enforced in the repository layer |
| User stores | Pluggable, **chained per tenant**: OpenLDAP (LDAPS/StartTLS), PostgreSQL user table, MySQL user table, SQLite user table, and local accounts. Users are linked just in time into the app's own `users` table, where roles, clearance, sessions and audit hang |
| Authorisation | One pipeline for every request: role → credential scopes → tenant → clearance ≥ data label → zone ceiling ≥ data label. Denials return RFC 9457 problems naming the failing step and are written to the audit chain |
| Audit | Append-only, per-tenant SHA-256 hash chain; corrections are new rows; verification is read-only |
| Placement | Docker Compose and bare-metal systemd first; Helm in the hardening sprint. Ollama runs in a container or natively on GPU nodes, on an internal network only |

### Prototype infrastructure, mapped

The boards name a large platform. We keep their behaviour and voice, with components a self-hosted team can run:

| The boards say | We build |
| --- | --- |
| Cedar policies | The TypeScript policy evaluator in `server/src/authz/policy.ts`, Cedar-shaped (principal, action, resource, decision step). Cedar itself can replace it later without changing callers |
| RabbitMQ, Temporal | A `JobQueue` interface with a BullMQ (Redis) adapter and a database-polling adapter for single-node installs; workflows are checkpointed steps in the database |
| OpenBao transit | A `Kms` interface: local AES-256-GCM (today's `DATA_KEY`) and an OpenBao transit adapter; per-tenant data keys for envelope encryption |
| MinIO | A `BlobStore` interface: filesystem and S3-compatible adapters |
| pgvector | A `VectorStore` interface: pgvector on PostgreSQL, Qdrant otherwise, brute force for SQLite development |
| Kubernetes NetworkPolicy, Kueue | Compose networks (`internal: true`) and host firewalls first; Helm and NetworkPolicy in Sprint 10 |

## Rules for every sprint

- Every route validates input (zod), requires authentication and an explicit permission, takes the tenant from the
  session (never the body), filters output by clearance, writes an audit event for every change, and fails with
  problem+json carrying the trace id.
- Secrets are shown once (API keys, client secrets, recovery codes) and stored hashed or sealed.
- Labels are `public < internal < confidential < restricted`, propagate as a high-water mark, and compare numerically.
- Lifecycles follow the components sheet: registry objects `draft → in review → published → deprecated → retired`;
  jobs `queued | running | succeeded | failed | cancelled | preempted`; progress is what the worker reports.
- Dual control where the boards require it (baseline guardrails, zone changes, model approval).
- Socket rooms are decided by the server from the principal; revoking a session closes its sockets.
- A screen moves from prototype data to live only when every control on it is backed by the server. Until then it
  shows the "Prototype data" banner.

## Sprints

| Sprint | Theme | Screens made live | Status |
| --- | --- | --- | --- |
| 0 | Foundations | — | **Done** (this PR) |
| 1 | Identity and access | Sign in, Settings, User stores (new) | **Done** (this PR) |
| 2 | Tenancy, audit, platform services | Tenants, Usage and audit | Next |
| 3 | Ollama gateway, models, pools, profiles | Models, Pools, Profiles | Planned |
| 4 | Chat, compare, metering | Chat, Compare | Planned |
| 5 | Guardrails, classifiers, flags | Guardrails, Classifiers, Flags | Planned |
| 6 | Knowledge, memory, connections | Knowledge, Memory, Connections | Planned |
| 7 | Registry, MCP servers, agent runs, scripts | Registry, MCP servers, Runs, Scripts | Planned |
| 8 | Workflows, media, images | Workflows, Media, Images | Planned |
| 9 | Training, zones, platform, federation | Training, Zones, Platform, Identity | Planned |
| 10 | Hardening and release | all | Planned |

### Sprint 0: Foundations (done)

npm workspaces; TypeScript strict, ESLint, Vitest; zod-validated configuration with `*_FILE` secrets; Express with
Helmet (strict CSP, HSTS behind HTTPS), compression, per-user and per-address rate limits, W3C trace ids,
problem+json errors, pino logs with redaction; `/healthz`, `/readyz` (database and migrations), `/metrics`
(token-protected); Knex for PostgreSQL, MySQL and SQLite with the core migration; Socket.io with cookie-session
handshake; graceful shutdown; Dockerfile, Compose (production and development), systemd unit and installer; CI with
unit, integration (real PostgreSQL, MySQL, OpenLDAP) and image jobs.

### Sprint 1: Identity and access (done)

- User-store adapters: OpenLDAP (service bind → search → user bind → groups; RFC 4515 escaping; empty passwords
  refused; LDAPS/StartTLS required outside development), SQL user tables on PostgreSQL, MySQL and SQLite
  (configurable columns and group sources; argon2 and bcrypt only; bound parameters), and local accounts.
- Ordered chain per tenant: unknown user → next store; wrong password in the owning store → stop; broken store →
  skipped and reported; equal timing when no store knows the user.
- Just-in-time provisioning keyed on (store, external id); a username already linked to another store is refused.
  Group mappings give the union of roles and the highest clearance; stores without groups may grant default
  (non-admin) roles.
- Sessions: opaque cookie token, HMAC'd at rest, `__Host-` httpOnly SameSite=Strict, idle and absolute timeouts,
  token rotation when a second factor completes; CSRF double-submit bound to the session; Origin checks.
- Second factors: TOTP (single use per time step), WebAuthn passkeys, recovery codes; admin roles must enrol at
  first sign-in and cannot use admin routes without a verified factor.
- Lockout per account and per address, stored in the database for every instance.
- API keys `exai_k1_…`: shown once, HMAC'd, scopes a subset of the owner's permissions and re-intersected on every
  request; revoked with the owner's disablement.
- The 13 built-in roles and grant rules (only a system admin grants system admin; admins cannot change their own
  access).
- Audit hash chain with verification, and clearance redaction when reading it.
- Admin API and the new **User stores** screen: stores (add, edit, order, enable, test connection), group mappings,
  users (roles, clearance, disable, reset factors, local accounts), sessions (revoke), and "Test a login".

### Sprint 2: Tenancy, audit and platform services

Tenants and workspaces CRUD with the workspace switcher; per-tenant and per-workspace quotas (tokens/day,
GPU-seconds/month, training GPU-hours) enforced with 429 and `Retry-After`; Usage and audit screen (filters, full
event view, chain verification, signed checkpoints, CSV export gated by clearance, corrections, SIEM stream);
`Kms` (local and OpenBao transit) with per-tenant data keys, replacing `DATA_KEY`; `BlobStore`; `JobQueue` with job
progress to socket rooms; notifications over the socket and SMTP; Redis adapter for Socket.io when running more
than one instance; directory sync job (disable users removed from every mapped group; LDAP hourly).

**Done when:** a tenant admin can create a workspace, set a quota and watch a request get 429; an auditor can
verify the chain and export only what their clearance allows.

### Sprint 3: Ollama gateway, models, pools, profiles

Pool and instance registry for Docker and bare-metal Ollama endpoints (optional mTLS); poller of `/api/ps` and
`/api/tags` every 5 s with health; load, pin, unload and drain through `keep_alive`; memory planner and anti-thrash
limit; model catalogue with lifecycle, licence record, digest verification, pickle refusal and import requests;
profiles (pinned model, pool, `num_ctx`, thinking ceiling, fallback chain, aliases, canary and rollback); rolling
Ollama upgrade.

**Done when:** a model admin approves a model, places it on a pool, and a profile routes to it.

### Sprint 4: Chat, compare, metering

Conversations, messages and branches (content sealed with the tenant key); profile picker filtered by clearance;
token streaming over Socket.io with sequence numbers and resume; stop, regenerate, edit and branch; cold-start
queueing; thinking levels; attachments (quarantine → scan → classify); usage rows metered on the final chunk;
compare with 2–4 parallel streams metered per column; the exact-calculation worker.

### Sprint 5: Guardrails, classifiers, flags

The eleven checkpoints; RE2 patterns, PII detectors and the guard model through Ollama; shadow and enforce;
precedence platform > tenant > workspace > agent; fail closed; versioned rule sets with diff, shadow replay and dual
control; classifiers with thresholds, test and batch jobs; the flag queue with SLA timers, clearance redaction and
keyboard actions.

### Sprint 6: Knowledge, memory, connections

Knowledge bases and sources (upload, S3, Git, database view); extraction and structure-aware chunking; embeddings
through Ollama; `VectorStore`; hybrid search with reciprocal rank fusion and reranking; clearance filter inside the
query; blue/green reindex. Memory scopes, proposals, forget across every backend, export. Data connections
(PostgreSQL, OpenSearch) with schema allow-lists, query classification, read-only accounts, row caps and PII masking.

### Sprint 7: Registry, MCP servers, runs, scripts

Registry entries (tools, skills, agents) with automated checks, review and publish scope; MCP servers over
streamable HTTP on internal hosts only, schema hashing and change detection, per-user vault tokens; agent runs with
think/do/calc lanes, approvals, budgets and replay from checkpoints; script sandbox (container, no network, limits)
and the promotion path.

### Sprint 8: Workflows, media, images

Workflow graphs with publish validation (acyclic, schemas, labels, limits), durable checkpointed execution,
approvals, dry run and replay; media presets as validated argument arrays with caps and NVENC/CPU encoders; image
generation through a ComfyUI/diffusers worker with the safety classifier, provenance sidecar and GPU-second quota.

### Sprint 9: Training, zones, platform, federation

Training jobs (datasets with PII scrub, approval for confidential data, windows, checkpoints, evals, GGUF
conversion to a registry draft); zones (definitions, ceilings, draft and approve, rendered Compose and firewall
configuration); platform (signed import bundles, mirrors, ACME certificates, backups and restore drills); the
Identity screen: OIDC provider (ES256 JWKS, key rotation, clients), SAML IdP, upstream OIDC/SAML federation,
Kerberos SPNEGO and device flow.

### Sprint 10: Hardening and release

OWASP ASVS level 2 review; dependency scanning and SBOM; load test of the streaming path; Helm chart and
NetworkPolicies; backup, restore and incident runbooks; accessibility (AA and AAA modes); a Playwright suite across
every screen; the 1.0 release.
