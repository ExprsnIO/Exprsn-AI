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
| 2 | Tenancy, audit, platform services | Tenants, Usage and audit | **Next** |
| 3 | Ollama gateway, models, pools, profiles | Models, Pools, Profiles | Planned |
| 4 | Chat, compare, metering | Chat, Compare | Planned |
| 5 | Guardrails, classifiers, flags | Guardrails, Classifiers, Flags | Planned |
| 6 | Knowledge, memory, connections | Knowledge, Memory, Connections | Planned |
| 7 | Registry, MCP servers, agent runs, scripts | Registry, MCP servers, Runs, Scripts | Planned |
| 8 | Workflows, media, images | Workflows, Media, Images | Planned |
| 9 | Training, zones, platform, federation | Training, Zones, Platform, Identity | Planned |
| 10 | Hardening and release | all | Planned |

Current codebase: Sign in, Settings and User stores are live, and the other 24 sidebar screens show prototype data;
one database migration (`001_core`); 71 unit and API tests plus the integration suite against PostgreSQL, MySQL and
OpenLDAP.

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

Carried forward to Sprint 2 (listed in `docs/security.md` under known gaps): directory sync, the Socket.io Redis
adapter, and replacing `DATA_KEY` with the KMS.

## Sprint 2: Tenancy, audit and platform services (next)

- Tenants and workspaces CRUD with the workspace switcher.
- Per-tenant and per-workspace quotas (tokens/day, GPU-seconds/month, training GPU-hours) enforced with 429 and
  `Retry-After`.
- Usage and audit screen: filters, full event view, chain verification, signed checkpoints, CSV export gated by
  clearance, corrections, SIEM stream.
- `Kms` (local and OpenBao transit) with per-tenant data keys, replacing `DATA_KEY`.
- `BlobStore` (filesystem, S3-compatible); `JobQueue` (BullMQ and database polling) with job progress to socket rooms.
- Notifications over the socket and SMTP (the console's bell is empty until then).
- Redis adapter for Socket.io when running more than one instance.
- Directory sync job: disable users removed from every mapped group; LDAP hourly.

**Done when:** a tenant admin can create a workspace, set a quota and watch a request get 429; an auditor can verify
the chain and export only what their clearance allows.

## Sprint 3: Ollama gateway, models, pools, profiles

Pool and instance registry for Docker and bare-metal Ollama endpoints (optional mTLS); poller of `/api/ps` and
`/api/tags` every 5 s with health; load, pin, unload and drain through `keep_alive`; memory planner and anti-thrash
limit; model catalogue with lifecycle, licence record, digest verification, pickle refusal and import requests;
profiles (pinned model, pool, `num_ctx`, thinking ceiling, fallback chain, aliases, canary and rollback); rolling
Ollama upgrade.

**Done when:** a model admin approves a model, places it on a pool, and a profile routes to it.

## Sprint 4: Chat, compare, metering

Conversations, messages and branches (content sealed with the tenant key); profile picker filtered by clearance; token
streaming over Socket.io with sequence numbers and resume; stop, regenerate, edit and branch; cold-start queueing;
thinking levels; attachments (quarantine → scan → classify); usage rows metered on the final chunk; compare with 2–4
parallel streams metered per column; the exact-calculation worker.

## Sprint 5: Guardrails, classifiers, flags

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
