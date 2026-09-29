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
