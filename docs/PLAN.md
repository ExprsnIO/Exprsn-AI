# Exprsn-AI: architecture and delivery plan

Exprsn-AI is a self-hosted, multi-tenant control plane and chat interface for models served by Ollama. The design
prototype in [`design/prototype`](../design/prototype/README.md) (27 screens) is the specification for behaviour
and copy. This plan turns it into a production application server, in two-week sprints tracked in [Sprints.md](../Sprints.md).

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

The sprint table, what each sprint delivered or will deliver, and current status are in
[Sprints.md](../Sprints.md).

## Migrations: expand and contract (1.3.0)

Rolling upgrades run two releases against one database for a while: the new release migrates (the Helm init
container or hook Job), the old pods keep serving until they are replaced. So a migration's `up` only **expands**: new
tables, new nullable columns or columns with defaults, new indexes. A **contract** step (dropping or renaming a column
or table, changing a column's type) waits for a later release, once no running build reads the old shape, and its line
(or the line above it) carries the marker `// contract: <why it is safe now>`.

- `server/test/sprint22-ops.test.ts` lints every migration's `up` for `dropColumn`, `renameColumn`, `dropTable`,
  `renameTable`, `DROP COLUMN`, `RENAME`, `ALTER COLUMN … TYPE` and friends without the marker, and fails the build.
- `exprsn-ai migrate --check` lists pending migrations and their destructive steps without applying anything (exit 2:
  pending, 3: pending with contract steps, 4: the database is newer than this build). A contract step means every
  instance of the previous release must be stopped before `migrate` runs.
- The schema version handshake (`server/src/db/schema.ts`): each build knows its migrations; when the database has one
  applied that the build does not know, the instance is older than the schema. It refuses to start, and a running one
  stops claiming jobs and reports not ready (`/readyz` `checks.schema`) with the reason, so only up-to-date instances
  do work. It recovers by itself when the database matches again.
- `down` may drop what its `up` added; it runs only in development and rollback drills.
