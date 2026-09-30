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
| 5 | Guardrails, classifiers, flags | Guardrails, Classifiers, Flags | **Done** |
| 6 | Knowledge, memory, connections | Knowledge, Memory, Connections | **Done** |
| 7 | Registry, MCP servers, agent runs, scripts | Registry, MCP servers, Runs, Scripts | **Done** |
| 8 | Workflows, media, images | Workflows, Media, Images | **Done** |
| 9 | Training, zones, platform, federation | Training, Zones, Platform, Identity | **Done** |
| 10 | Hardening and release | all | **Release candidate** (1.0.0-rc.1) |

Current codebase: every sidebar screen is live (Sign in, Settings, User stores, Tenants, Usage and audit, Models, Pools,
Profiles, Training, Chat, Compare, Guardrails, Flags, Classifiers, Knowledge, Memory, Connections, Registry, MCP
servers, Runs, Scripts, Workflows, Media, Images, Identity, Zones and Platform); twelve database migrations (`001_core`
to `012_federation`); 281 unit and API tests (against a fake Ollama, a fake MCP server, fake script, media, image and
training workers, a fake ACME directory and a fake upstream identity provider) plus the integration suite against
PostgreSQL, MySQL, OpenLDAP and Redis; a Helm chart, supply-chain CI and a streaming load test.

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
