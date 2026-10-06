# Exprsn-platform administration in the Exprsn-AI console

1.4.0 merged exprsn-platform's server features into Exprsn-AI, and Sprint 29 (B-3401) gave the eleven domains their
console boards: Files, Apps, Groups and events, Messages and feed, Moderation, Channels, Roles and access, Certificates,
Vault, Plugins and events, AT-Protocol. This document is the second half of that merge: the platform's own
**administration** surface (its admin SPA with 22 sections, the legacy `admin/` service and the operator mockups),
mapped onto the Exprsn-AI console, and the five admin screens that were still missing, designed to the console's
conventions (`design/prototype/CONTRACT.md`, the components sheet, `docs/accessibility.md`).

Everything here follows the console's rules: one screen is one module in `design/prototype/js/screens/<id>.js`, plain
copy with no exclamation marks, every control does something, every state the board lists is in the `states` array and
applied from the command palette, only CSS variables for colour, and a Playwright smoke run in light and dark. The
prototype boards are the specification; the live screens come later, when every control is backed by the server
(`Backlog-1.5.0.md` B-34 rules).

Questions this design could not settle alone are listed at the end and in `questions.json`; answer them with the
terminal menu: `node design/platform-admin/decide.mjs`.

## Where the platform's administration went

The platform's admin navigation (`web/src/features/admin/AdminLayout.tsx`) had four groups. Every item now has a home.
"Board" means a Sprint 29 prototype board that is not live yet; "live" means a console screen that is live in 1.4.0;
"new" means a board added by this design.

| Platform admin section | What it administered | Exprsn-AI home |
| --- | --- | --- |
| Overview | Gateway modules, uptime, environment, per-module stats | **Overview** (new) |
| Platform | Environment settings with database overrides, hot or restart-required | **Configuration** (new) |
| Certificate Authority | Certificates, tokens, CRL and OCSP, ACME | Certificates (board); Identity › Keys (live) |
| Authentication | Directory, organisations, sessions | Identity (live), Tenants (live), Settings › Sessions |
| Groups (identity) | Auth groups, base permissions, role bindings | Identity › user stores and group mappings (live) |
| Users | Directory, orgs, groups, roles, sessions | Identity (live), Tenants › Members (live) |
| Roles, Permissions, Scopes | Role definitions, permission catalogue by service and scope | Roles and access (board, B-3412) |
| AT-Protocol | Labeler, firehose bridge, inbound labels, DLQ | AT-Protocol (board) |
| AI | Providers, models, moderation agents, tools, guardrails, skills | Models, Profiles, Pools, Registry, Guardrails (live) |
| Timeline | Posts, approvals, lists, job queues | **Social and messaging › Feed** (new); Moderation (board); Jobs and queues (new) |
| Groups (nexus) | Groups, events, governance, flags, audit, config | Groups and events (board); **Social and messaging › Groups** (new); governance stays deferred |
| Live | Streams, rooms, destinations, ffmpeg queue | Still deferred (`Backlog-1.5.0.md`); no board |
| Vault | Inventory, policies, keys, anomalies, audit, maintenance | Vault (board) |
| File Vault | Storage backend health, dedup, quotas, blobs, migration | Files (board) for folders and shares; **Storage** (new) for the operator's view |
| Spark | Message queues, runtime config | **Social and messaging › Messaging** (new); Jobs and queues (new) |
| Jobs & Queues | Bull queues, failed jobs, retry, pause, prefetch | **Jobs and queues** (new) |
| Prefetch | Timeline cache warming, per-user cache, metrics | **Jobs and queues › Cache** (new; the B-2102 tenant cache replaced prefetch) |
| Low-Code | Apps, entities, lookups, flows, records | Apps (board, B-3407) |
| Cortex | Tasks, reviews, prompt log | Runs, Chat held answers, Guardrails (live) |
| Plugins | Catalogue, installations, endpoints, deliveries | Plugins and events (board); Tenants › Webhooks (live) |
| Moderation | Queue, reports, rules, word lists, appeals, workflows, metrics | Moderation (board, B-3405); Guardrails and Classifiers (live) |

The legacy `admin/` service (dashboard, services with start, stop and restart, config for database, Redis and
security, logs, monitoring, backups, certificates, tokens, users) maps the same way: dashboard and monitoring to
**Overview**, services to Overview's instances table (drain, never restart from the console), config to
**Configuration**, backups to Platform › Backups (live), certificates to Certificates, tokens to Settings › API keys
and Identity › OIDC clients, users to Identity. Logs have no console home: Exprsn-AI exports traces and metrics
(Sprint 22) and keeps logs on the host; see question 7.

## The five new screens

All five sit in the sidebar's Admin group. Overview goes first, because it is where an administrator starts the day;
Jobs and queues, Storage and Configuration go between Usage and audit and Platform, because they are the operator's
screens; Social and messaging goes after Channels, with the other domain policies. In the prototype the modules add
their own entries to `App.NAV` at load time (so `app.js` is untouched, as Sprint 29 asked); the live console adds the
entries to its NAV table with their permissions.

| Screen | Route | Nav label | Icon (prototype, proposed) | Permission | Board |
| --- | --- | --- | --- | --- | --- |
| Overview | `#/overview` | Overview | `grid`, proposed `overview` | `platform:manage` for instances; `tenant:manage` sees the tenant's counts | `js/screens/overview.js` |
| Jobs and queues | `#/jobs` | Jobs and queues | `clock`, proposed `jobs` | `platform:manage` for queue control and schedules; `tenant:manage` sees the tenant's jobs | `js/screens/jobs.js` |
| Storage | `#/storage` | Storage | `upload`, proposed `storage` | `platform:manage` for stores and integrity; `tenant:manage` for usage and quotas | `js/screens/storage.js` |
| Configuration | `#/configuration` | Configuration | `settings`, proposed `configuration` | `platform:manage` (a second factor, like Platform) | `js/screens/configuration.js` |
| Social and messaging | `#/social` | Social and messaging | `thumb`, proposed `social` | `tenant:manage` for policies; `platform:manage` for Realtime | `js/screens/social.js` |

Shared example data, as on every board: tenant Northwind, workspaces Finance Ops (confidential), People Ops, Field
Sales (internal), Legal; Contoso's Platform lab; the viewer is Mara Okafor (system admin); other people are Jonas
Lindqvist (platform team), Felix Brandt (finance), Lena Hoffmann, Noor Rahimi (people ops). Instances: `api-1` and
`api-2` (the application, version 1.5.0-rc.1), `signer-1` (the signer process), `trainer-gpu-1` (the training worker,
contract v2), `images-1` (the ComfyUI worker). Stores, as on Platform: Postgres, MinIO (the S3 blob store), OpenBao,
LDAP, the KDC. Zones as on Zones: edge, app, data, directory, inference, sandbox, training, external. Job types and
schedules are the server's real names (`server/src/services.ts`, `platform/jobs.ts`); settings are the real names in
`server/src/config/index.ts`. Dates are in September 2026; the boards' "now" is 19 Sep 2026, 14:10.

### Overview

A dashboard, not a list: what needs attention now, and whether the instances are healthy. No tabs; a window segment
(1 h, 24 h, 7 d) changes the counters.

- **Alerts** at the top, one `.notice` per open platform alert, newest first, each with an Open button (navigates to
  the screen that owns it) and Acknowledge (confirm, then the row leaves; audited as `platform.alert.acknowledged`,
  tenant-wide, see question 15). Alerts in the data: rate limits counting per instance since 09:12 (Redis not
  answering; warn, opens Platform); backup store MinIO 22 min past its RPO (danger, opens Platform › Backups); zone
  policy drift on `data` in-cluster (warn, opens Zones); 3 certificates expire within 7 days (warn, opens
  Certificates); instance `api-2` behind the schema, migration `032_dav` pending (danger, opens the instance in the
  inspector). With none open: an `.empty` "No open alerts".
- **Counters** (`.stats`): instances ready 4 of 5; queued jobs 41, oldest 4 min; running 7; failed in the window 5;
  open flags 14, 4 overdue (opens Flags); held replies 3 (opens Channels); sign-ins 212, 2 refused by sanction; sockets
  318 on 2 instances.
- **Instances** table: Instance | Role | Version | Schema | Database | KMS | Blobs | Jobs claimed | Started | State.
  Rows: `api-1` (api, jobs; current; ok; ok; ok; 5; 3 d ago; ready), `api-2` (api, jobs; behind `032_dav`; ok; ok;
  ok; 0, claims none while behind; 41 min ago; not ready), `signer-1` (signer; no database; sealed keys 12; ready),
  `trainer-gpu-1` (training worker v2; heartbeat 20 s ago; 1 job; ready), `images-1` (ComfyUI; queue 2; ready).
  Selecting a row fills the inspector: the `/readyz` checks as a key-value list (`database`, `migrations`, `schema`,
  `kms`, `blobs`, `shutdown`), tracing (exported, dropped, failed spans), NTP offset and the servers that agreed,
  rate-limit store, uptime, node and process, and two actions: **Drain** (confirm, tag "no new work": the instance
  stops claiming jobs and taking new streams, finishes what it has; audited `platform.instance.drained`) and **Open
  metrics** (the `/metrics` link, token protected, shown as a copyable URL). Workers show their contract version and
  last heartbeat instead of database and KMS.
- **Scheduled work** panel: the next six schedules (name, in how long, last result) with a link to Jobs and queues ›
  Schedules. **Recent audit** panel: the last eight audit events (actor, action, object, when) with a link to Usage and
  audit. **Capacity** panel: meters for the blob store (1.42 TiB of 2 TiB), database (48 GiB), vectors (11.2 M), GPU
  hours this month (61 of 120), rate-limit store (Redis, degraded).
- Cross-links: Flags, Channels, Zones, Certificates, Platform, Jobs and queues, Storage, Usage and audit.
- Commands: Acknowledge every alert; Drain an instance.
- States: **Instance behind the schema** (danger: `api-2` not ready, the alert and the inspector explain `032_dav`);
  **Rate limits degraded** (warn: the alert, the capacity meter and the inspector's rate-limit store say per instance);
  **Backup RPO missed** (danger: the alert first, the Platform link); **Everything healthy** (ok: no alerts, all
  instances ready); **Tenant admin view** (neutral: without `platform:manage` the instances table and capacity panel
  are replaced by a notice "Instance health is visible to system admins"; counters and audit stay).

### Jobs and queues

The platform had Bull queues per module and a prefetch cache; Exprsn-AI has one `JobQueue` (BullMQ on Redis, or
database polling), one `Scheduler`, and the tenant cache. Five tabs.

- **Queues**: one row per job type, grouped by domain (Knowledge, Chat and agents, Media and images, Moderation and
  files, Channels and webhooks, Platform operations, PKI and vault, Identity, Apps, Social, Training). Columns: Type |
  Domain | Queued | Running | Oldest queued | Failed 24 h | p95 | Timeout | Concurrency | State. Types from the server:
  `webhook.deliver`, `knowledge.index`, `knowledge.sync`, `media.process`, `image.generate`, `agent.run`,
  `file.scan`, `attachment.scan`, `channels.send`, `channels.imap-poll`, `channels.reply`, `pki.crl`, `pki.acme.validate`,
  `ops.backup.create`, `training.tick`, `plugin.invoke`, `feed`, `memory.extract`, `users.import`, `apps.import`,
  `moderation` sweep, `directory.sync`. Toolbar: search, domain filter, a pill naming the backend ("BullMQ on Redis",
  or "database polling"), and the paused count. Row actions: Pause type / Resume (confirm; a paused type keeps queuing
  and stops claiming; audited `jobs.type.paused`). Inspector: the type's description in the board's voice, where it
  is registered, timeout and concurrency, p50 and p95 with a sparkline, the last five jobs, Retry all failed (confirm).
- **Jobs**: Job | Type | Tenant and workspace | State | Progress | Attempts | Created | Started | Duration | Node.
  Filters: state (`queued`, `running`, `succeeded`, `failed`, `cancelled`, `preempted`), type, window; search by job
  id or trace id. Inspector: payload keys only (never tenant content), message, error, the trace id in mono with
  copy and an Open trace button (disabled with "Tracing is off" when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset),
  progress events as a timeline, Cancel (queued or running) and Retry (failed) with confirm.
- **Schedules**: Schedule | Every | Last run | Next run | Last result | Targets | State. The server's schedules:
  `audit.checkpoint`, `directory.sync`, `guardrails.sweep`, `mcp.poll`, `knowledge.sync-due`, `memory.purge`,
  `chat.retention`, `chat.sweep`, `training.tick`, `zones.health`, `zones.cluster.drift`, `ops.backup.create`,
  `ops.backup.drill`, `ops.backup.watch`, `ops.cert.sweep`, `ops.mirror.check`, `federation.keys`,
  `federation.metadata`, `federation.purge`, `billing.close`, `agents.schedules`, `apps.schedules`, `pki.crl`,
  `pki.expiry`, `files.purge`, `channels.imap-poll`, `channels.retention`. Targets are "every active tenant" or
  "platform". Row actions: Run now (confirm), Pause / Resume. Inspector: what the schedule does, the setting that sets
  its period (for example `DIRECTORY_SYNC_MINUTES`, with a link to Configuration), the last five runs.
- **Dead letters**: everything that gave up, across domains. Source | Item | Reason | Attempts | First failed | Last
  failed | actions. Rows: moderation dead-letter queue (B-1905; redrive), a webhook with its breaker open (opens
  Tenants › Webhooks), plugin invocations failed after three attempts (opens Plugins › Runs), a firehose subscription
  stalled (opens AT-Protocol), email bounces from channels (opens Channels). Redrive (confirm, the row moves to
  Jobs as queued) and Discard (confirm, danger, audited).
- **Cache**: the tenant cache (B-2102). Header stats: store (Redis, shared; or memory, per instance), entries, hit rate
  in the window, invalidations (local and from the bus). Table: Namespace | Tier | TTL | Requests | Hit rate |
  Invalidations | Entries. Namespaces: tenant settings (long), profiles (medium), policy decisions (short), directory
  groups (medium), model catalogue (medium), zones (long), permission matrix (medium), prompt templates (medium),
  feature flags (short). Row action: Invalidate namespace (confirm; broadcast over the bus). A notice when the store
  is memory on more than one instance: each instance keeps its own cache and invalidations travel over the bus.
- Commands: Retry failed jobs; Run a schedule now.
- States: **Queue backlog growing** (warn: `webhook.deliver` oldest 18 min, breaker open on one target, notice with a
  link to Dead letters); **Job failed with trace** (danger: a failed `knowledge.index` job selected, error text and
  trace id shown); **Instance behind claims no jobs** (info: notice on Queues that `api-2` claims none while behind the
  schema, link to Overview); **Dead letter redriven** (ok: the moderation item moved to Jobs, toast); **Database
  polling backend** (neutral: backend pill "database polling", cache store "memory", the per-instance notice).

### Storage

The platform's File Vault admin (backend health, dedup, quotas, blob maintenance, migration) plus everything else in
Exprsn-AI that occupies space. Five tabs.

- **Stores**: table Store | Kind | Location | Used | Capacity | Objects | Health | Checked. Rows: Blob store (S3,
  MinIO bucket `exprsn-blobs`, 1.42 TiB of 2 TiB, 2.1 M objects, 3 multipart uploads in flight, ok); Database
  (PostgreSQL 16, 48 GiB, 34 of 100 connections, ok); Vector store (pgvector, 11.2 M vectors in 9 bases, ok);
  Backups (MinIO bucket `exprsn-backups`, 310 GiB, retention 14, last backup 23:00, RPO 60 min; opens Platform ›
  Backups); Media work directory (`MEDIA_WORK_DIR`, 12 GiB on `api-1`, scratch); Training datasets (sealed, 86 GiB,
  on the trainer); Model files (on the pools, opens Pools). Inspector: the settings that configure the store
  (`BLOB_STORE`, `S3_BUCKET`, `S3_ENDPOINT`, with a link to Configuration), the health detail from `/readyz`, growth
  over 30 days as a sparkline, Verify now (runs the integrity check), and Migrate to another store (a proposal:
  copies objects to a second store as a job and switches reads when complete; marked "proposed", question 16).
- **Usage**: by workspace, then by user or kind (a segment). Workspace | Files | Versions | Trash | Media | Knowledge
  uploads | Attachments | Total | Quota | meter. Rows for Finance Ops (412 GiB of 500, warn), People Ops, Field Sales,
  Legal (quota exceeded in the state), Platform lab (Contoso). Set quota (modal with GiB and a notice that uploads are
  refused with `413` above it, B-2403). Inspector: top five users, growth sparkline, link to Files for the workspace.
- **Quarantine**: objects waiting for or refused by the attachment check. Object | Kind | Workspace | Size | State
  (`scanning`, `infected`, `type mismatch`, `too large`, `timed out`) | Age. A panel for the scanner: ClamAV daemon
  (`CLAMD_HOST`), reachable, signature database date, scanned today, refused today. Rescan (confirm) and Delete
  (confirm, danger). A notice when the daemon is unreachable: uploads stay queued and nothing is released unscanned.
- **Integrity**: the last verification (when, objects checked, missing, orphans, checksum mismatches, duration) and a
  table of findings: Finding | Object | Referenced by | Size | Found | action. Run verification (confirm; a job
  `ops.blobs.verify`, proposed), Delete orphans (dry run first, then confirm with a reason; question 10), Restore
  missing from backup (opens Platform › restore drill).
- **Purges**: every retention and purge job in one table: What | Policy set in | Period | Last run | Removed | Next
  run. Rows: file trash (`FILES_TRASH_DAYS`, `files.purge`), conversation retention (Tenants › Retention,
  `chat.retention`), channel retention (Channels, `channels.retention`), memory purge, media outputs TTL
  (`MEDIA_URL_TTL_SECONDS`), audit exports, backup retention (`PLATFORM_BACKUP_RETAIN`), knowledge replication
  snapshots. Each row links to where the policy is set.
- Commands: Run an integrity check; Set a workspace quota.
- States: **Store nearly full** (warn: blob store at 93 %, meter and notice); **ClamAV unreachable** (danger:
  quarantine growing, the scanner panel red, releases blocked); **Orphans found** (warn: 1,204 orphans, 3 missing);
  **Quota exceeded** (danger: Legal at 104 %, uploads refused); **Filesystem store on one node** (neutral:
  `BLOB_STORE=fs`, a notice that a second instance needs a shared path or S3).

### Configuration

The platform kept environment settings with database overrides and a hot-or-restart flag; Exprsn-AI reads 300-odd
settings from the environment and files (`SECRET_REF_DIRS`) and masks secrets in diagnostics. This screen shows every
setting this build reads, where its value came from, whether the instances agree, and what a change needs. Whether it
may also change them is question 2; the board shows both answers.

- Layout: a `.leftpane` with sections and counts (Server and HTTP, Database, Keys and KMS, Blob store and files,
  Jobs and cache, Identity and sessions, Federation, Gateway and Ollama, Guardrails and moderation, Knowledge and
  connections, Media and images, Training, Zones, Platform operations, PKI and ACME, Vault, Channels and email,
  Social and messaging, Apps and plugins, AT-Protocol, Observability, Billing), then the page: search, filter chips
  (changed from default, secrets, restart required, instances differ, deprecated), and the table Setting | Value |
  Source | Applies | Description. Values of secrets read "set, 44 characters, from file `/run/secrets/data_key`".
  Source is env, file, default or override. Applies is hot or restart.
- Inspector for a setting: description, type and constraints, default, current value per instance (`api-1`,
  `api-2`, and the workers that read it), source, since when, and history (audit of overrides, when enabled). Actions:
  Copy name, Compare instances (highlights the differing row), Propose override (a drawer: value, reason; another
  platform admin approves; then "applied" for a hot setting or "restart required" with a banner naming the instances)
  or, when overrides are off, a notice "Settings are managed in the environment of this deployment" with the name to
  copy. Export as `.env` (secrets masked) and Diff against defaults in the page header.
- Rows: at least 28 real settings across the sections, for example `PUBLIC_URL`, `DB_CLIENT`, `DATABASE_URL`
  (secret), `REDIS_URL`, `JOB_QUEUE`, `JOB_CONCURRENCY`, `BLOB_STORE`, `S3_BUCKET`, `DATA_KEY` (secret, file),
  `KMS_PROVIDER`, `CACHE_STORE`, `CACHE_TTL_MEDIUM_SECONDS`, `DIRECTORY_SYNC_MINUTES`, `AUDIT_CHECKPOINT_MINUTES`,
  `SESSION_IDLE_MINUTES`, `BREACHED_PASSWORDS`, `DPOP_PROOF_MAX_AGE_SECONDS`, `OLLAMA_MAX_INFLIGHT`,
  `CHAT_RETENTION_SWEEP_MINUTES`, `FILES_TRASH_DAYS`, `FILES_PURGE_MINUTES`, `CLAMD_HOST`, `PLATFORM_BACKUP_MINUTES`,
  `PLATFORM_BACKUP_RETAIN`, `PLATFORM_BUNDLE_REQUIRE_CHECKS`, `PLUGINS_REQUIRE_SIGNED`, `PLUGIN_MAX_DEPTH`,
  `APPS_TRIGGER_MAX_DEPTH`, `NTP_SERVER`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_SAMPLE_RATIO`, `ZONES_APPLY`,
  `RATELIMIT_PROBE_SECONDS`, `SCHEMA_CHECK_SECONDS`, `MESSAGING_EMBED_MODEL`, `FEED_TRENDING_MINUTES`,
  `FEED_DIGEST_PROFILE`, `PKI_CRL_MINUTES`, `VAULT_LEASE_MAX_TTL_SECONDS`, `ATPROTO_PUBLIC_URL`, `DATA_KEY_PREVIOUS`
  (deprecated once the rewrap finished), `WEBHOOK_BREAKER_COOLDOWN_MS`, `USER_IMPORT_MAX_ROWS`, `METRICS_TOKEN`
  (secret). Only real names from `server/src/config/index.ts`.
- Commands: Find a setting; Export settings as .env.
- States: **Instances disagree** (danger: `PLATFORM_BACKUP_MINUTES` is 60 on `api-1` and 120 on `api-2`; the filter
  chip, the row and the inspector show it); **Restart required** (warn: a banner lists `api-1` and `api-2` after an
  approved override of `JOB_CONCURRENCY`); **Overrides disabled** (neutral: Propose override replaced by the
  environment notice); **Secret from file** (info: `DATA_KEY` selected, the value never shown, the file path and
  mode); **Deprecated setting still set** (warn: `DATA_KEY_PREVIOUS` set although the rewrap finished on 2 Sep).

### Social and messaging

The platform's Timeline, Spark and Nexus admin sections set policies and watched queues for the social domains.
Exprsn-AI's Messages and feed and Groups and events boards are the members' screens; this is the administrator's, for
every workspace at once. Five tabs.

- **Feed**: counters (posts today, held, comments, reactions). Approval policy per workspace: Workspace | Posts pass
  `user-input` | Held posts approved by | Edits and comments a rule would hold | Media | Max media size, with toggles
  and selects; a notice that edits and comments are refused rather than held (B-2704). Trending: the `feed` trending
  job every `FEED_TRENDING_MINUTES` over `FEED_TRENDING_HOURS`, last run, and the top hashtags with Exclude from
  trending (confirm; a per-tenant exclusion list, proposed). Weekly digest: the profile (`FEED_DIGEST_PROFILE`, a
  select of published profiles), day and time, top `FEED_DIGEST_TOP`, max label, the last digest (sent, or "ranked
  list kept; the model failed"), Send a test digest to me (confirm, toast). Held posts count links to Moderation.
- **Groups and events**: defaults per workspace: who may create groups (any member or workspace admins), default
  visibility and join mode (open, request, invite), request and invitation expiry (`GROUP_REQUEST_DAYS`,
  `GROUP_INVITE_DAYS`), event defaults (capacity, reminder lead times for `calendar.reminder`). A table of groups
  across workspaces: Group | Workspace | Visibility | Join mode | Members | Pending requests | Upcoming events | Open
  reports, selecting one fills the inspector (owners, created, feed URL issued, Transfer ownership, Archive group
  with confirm). Calendar feeds: issued signed feed URLs (`/calendar/feeds/<id>/<sig>.ics`) by group and user, with
  Revoke (confirm). Governance voting is still deferred; the board says so in a notice.
- **Messaging**: retention per workspace (table, links to Tenants › Retention); limits (`MESSAGING_MAX_MEMBERS`,
  `ATTACHMENT_MAX_BYTES`, attachment types through quarantine); search: keyword always, semantic when
  `MESSAGING_EMBED_MODEL` is set (a pill), summaries and digests by `MESSAGING_SUMMARY_PROFILE` (select); presence
  (last join or leave, not a live status, B-2603); blocked pairs and muted conversations counts from the shared social
  module. Export a conversation for a legal hold: a drawer with the conversation id, a reason, and the approver
  (dual control by default; question 5), audited `messaging.conversation.exported`.
- **Realtime**: rooms (B-2101): Room kind (`conversation`, `group`, `feed`, `channel`, `job`, `flag`) | Rooms open |
  Sockets | Signals per minute (sparkline) | Backlog; sockets per instance; socket authentication failures in the
  last hour; `ROOM_SIGNALS_PER_MINUTE`. A notice: rooms are decided by the server from the principal, and revoking a
  session closes its sockets (links to Identity › Sessions). Close a user's rooms (confirm; what a sanction does).
- **Relations**: follows, blocks, mutes and lists counts from the shared social module (ids only, never text);
  contact rules per workspace (who may start a conversation: anyone in the workspace, contacts only, admins only)
  with Apply (confirm); the top blocked accounts as counts with a link to Moderation › Sanctions.
- Commands: Send a test digest; Export a conversation.
- States: **Post held by guardrail** (info: held count 3 with a link to Moderation); **Digest fell back** (warn: the
  last digest kept the ranked list because the model failed); **Semantic search off** (neutral: `MESSAGING_EMBED_MODEL`
  unset, the pill and a notice); **Calendar feed revoked** (ok: the row shows revoked, toast); **Realtime backlog**
  (warn: the `feed` room backlog on `api-2`, notice linking to Overview).

## HIG alignment, in short

- Page: `UI.pagehead` with a one-line subtitle in the board's voice; `.toolbar` with search and filter buttons that
  filter; tables with `UI.table` and a selected row that fills an `aside.inspector`; `.stats` for counters; `.notice`
  for conditions; `UI.problem` with a trace id for refusals; `ctx.confirm` before anything that changes state, then a
  toast and a visible change.
- Status words map to pills as the components sheet does: ready, succeeded, ok → `ok`; failed, not ready, infected,
  exceeded → `danger`; behind, degraded, paused, warn → `warn`; running, queued, scanning → `info`.
- Classification labels (`UI.label`) wherever a row carries tenant data (quotas by workspace, groups, conversations);
  platform rows carry none, as on Platform.
- Colour only through variables; both themes; no literal colours in inline styles.
- Copy: plain, specific, no exclamation marks, no emoji; settings and identifiers in `.mono`; numbers tabular.
- Accessibility: tabs are buttons in a `nav`, rows are focusable, dialogs and drawers reflow at 320 and 640 px; the
  live screens join `y-reflow` and the axe run in both modes (B-3414).

## Proposed backlog items (epic B-42, Platform administration screens)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-4201 | Prototype boards for Overview, Jobs and queues, Storage, Configuration, Social and messaging (this design); `node build.mjs` and the smoke run clean | Every board passes the smoke run in light and dark | 5 |
| B-4202 | Overview live: `GET /api/admin/overview` (alerts, counters, instances from the instance registry with their `/readyz` checks, next schedules, recent audit, capacity); acknowledge alerts; drain an instance | Draining an instance from the screen stops it claiming jobs | 5 |
| B-4203 | Jobs and queues live: `GET /api/admin/jobs` with filters, `/queues`, `/schedules` (run now, pause), `/dead-letters` (redrive, discard), `/cache` (namespaces, invalidate); pause by type in `JobQueue` | A paused type stops claiming within one poll and resumes from the screen | 8 |
| B-4204 | Storage live: stores and health, usage by workspace and user, quarantine listing with rescan, the integrity job `ops.blobs.verify` with findings, purge schedule summary | An orphan found by the job can be deleted from the screen after a dry run | 8 |
| B-4205 | Configuration live: a settings descriptor generated from `config/index.ts` (name, section, type, default, secret, hot or restart), `GET /api/admin/platform/settings` with per-instance values; overrides only if question 2 says so | Two instances with different values show as differing on the screen | 5 |
| B-4206 | Social and messaging live: feed approval policy and trending exclusions, group defaults and calendar feed revocation, messaging limits and legal-hold export, realtime room counts, contact rules | A revoked calendar feed answers 404 on its next fetch | 5 |
| B-4207 | Accessibility and reflow for the five screens; `docs/accessibility.md` updated | No axe or reflow finding on any of the five | 3 |

39 points. B-4201 is this design. The rest fit Sprint 35, the first of 1.6.0, unless question 12 says otherwise; 1.5.0 is full at six sprints. (Numbered B-42 because sprint-29 took B-39 for Workflows 2.)

## Open questions

Answer these with `node design/platform-admin/decide.mjs`; it writes `decisions.json` and `DECISIONS.md` beside this
file and prints the lines to carry into `Backlog-1.5.0.md` "Open decisions". The defaults the boards show are marked.

1. Cache: a tab on Jobs and queues (as designed), or a screen of its own?
2. Configuration: a read-only view of the environment (default), database overrides with dual control for every
   setting, or overrides only for hot settings?
3. Overview placement: first in the Admin group (default), or replacing Platform with Platform's tabs folded in?
4. Social and messaging policies: `tenant:manage` (default) or a new `social:manage` permission?
5. Exporting another member's conversation for a legal hold: dual control (default), one tenant admin with a reason
   and audit, or not offered in the console?
6. Group categories (the platform had twelve): add categories to groups, tags only, or none (default; workspaces are
   the grouping)?
7. Server logs in the console: none, traces and metrics only (default), or the last lines per instance, redacted?
8. Live streaming administration: stays deferred (default), or a board now against SRS or Cloudflare Stream?
9. Jobs visibility: system admins see every tenant's jobs with a tenant filter and tenant admins see their own
   (default), or tenant-scoped only?
10. Deleting orphan blobs: dry run then one admin with a reason (default), or dual control?
11. Tenant provisioning templates (the platform's enterprise, team and personal organisation types): add Create from
    template to Tenants (default), or leave provisioning to the CLI?
12. Sprint placement for B-4202 to B-4207: Sprint 31 (default), Sprint 30 displacing WebDAV, or 1.6?
13. Icons: the sprint-29 session adds `overview`, `jobs`, `storage`, `configuration` and `social` to `app.js` when the
    screens go live (default), or this branch edits `app.js` now?
14. Draining an instance: from the console with a confirm and a recent sign-in (default), or the CLI only?
15. Acknowledging an alert: tenant-wide and audited (default), or per administrator?
16. Migrating the blob store to another store from the console: design it (as proposed on the Stores tab), or CLI only?
