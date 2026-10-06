# Backlog: 1.5.0

The work after 1.4.0. 1.4.0 shipped exprsn-platform's server features with no console work; 1.5.0 gives them their
screens, makes access reviewable as permission matrices with tenant-defined roles, adds the standard calendar,
contact and file protocols (CalDAV, CardDAV, WebDAV) over the 1.4.0 events and file store, and hosts AT-Protocol
repositories with a personal data server (PDS) and custom feed generators. Rules as before: everything follows
`docs/PLAN.md` and `CLAUDE.md`; screens follow `design/prototype/CONTRACT.md` (prototype board first, then live when
every control is backed by the server); every server item ships its routes, permission, audit events, jobs, tests on
SQLite, PostgreSQL and MySQL, `docs/api.md` and `docs/openapi.json` entries and any known gaps in `docs/security.md`.

**Size.** 71 items, 387 points in 1.5.0 (1 point ≈ half a day for one engineer, tests included; B-4202 to B-4207 count in 1.6.0): P0 134, P1 193, P2 60.
At about 78 points a sprint (roughly five engineers) that is Sprints 29 to 34. Groomed by the owner on 2026-10-05 with
`design/grooming/groom.mjs` (state in `design/grooming/grooming.json`, summary in `design/grooming/GROOMING.md`):
WebDAV (B-32) moved to Sprint 34, the import wizard split between Sprints 31 and 33, Sprint 31 accepted at 93 points,
the platform administration live screens (B-4202 to B-4207) moved to 1.6.0, and four 1.4.0 gaps, MongoDB connections,
user profiles and presence added (B-58). Model servers beyond Ollama (B-43, 34 points), approved after the grooming,
went to 1.6.0's Sprint 35. Sprint 33 (chat invocation, B-40, and the import wizard's dataset half, B-3804 to
B-3807) moved to 1.7.0 on 2026-10-05. With fewer engineers, P2 (the PDS and feed generator) moves to 1.6 first.

**Builds on.** The permission catalogue and built-in roles (`server/src/authz/permissions.ts`) and `policy.explain`;
B-25 events (B-2502) and their signed iCal feeds (B-2504); the B-24 file store with its quarantine, scan, versions,
shares and quotas; B-1608 AT-Protocol signing keys, B-1609 service DIDs, B-1610 labeler and B-1908 firehose ingest;
B-19 moderation for takedowns. Nothing here replaces those; the protocols are new front doors onto the same data and
the same policy pipeline.

## Sprints

| Sprint | Theme | Items | Points | Migration | Status |
| --- | --- | --- | --- | --- | --- |
| 29 | Permission matrices and custom roles; prototype boards; trust, identity, apps and files screens; record queries on PostgreSQL | B-3301–B-3305, B-3401–B-3404, B-3407, B-3408, B-3413, B-3601 | 76 | `031_access` | **Done** (its six screens shipped in Sprint 30) |
| 30 | Domain screens; CalDAV and CardDAV; model-based memory management; MongoDB connections | B-3405, B-3409–B-3412, B-3414, B-3101–B-3104, B-3701–B-3703, B-3602 | 76 | `032_dav`, `032c_memory` | **Done** (B-3104 partial) |
| 31 | AT-Protocol PDS and feed generator; import repositories and model import; RSVP race and relay commit signatures | B-2901–B-2906, B-3001–B-3004, B-3406, B-3801–B-3803, B-3603, B-3604 | 93 (over the guide; accepted by the owner) | `033_pds`, `033b_feeds`, `033c_imports` | **Done** |
| 32 | Workflows 2: chaining, agent and skill steps, event and schedule triggers, domain steps, map and loop, failure handling; app passwords; the chain context | B-3901–B-3910, B-3415, B-4101 | 71 | `034_workflows2`, `034b_workflow_triggers`, `034c_workflow_steps` | **Done** |
| 33 | Moved to 1.7.0 on 2026-10-05 (Sprint 38 there): agents, tools and skills in chat; dataset import, knowledge sets and the Import screen | — | — | — | Moved to 1.7.0 |
| 34 | Chaining agents, skills, tools and workflows; WebDAV for the file store; user profiles and presence; IMAP in CI; release | B-4102–B-4109, B-3201–B-3203, B-5801, B-5802, B-3605, B-3606, B-3501 | 66 | `036_chains`, `036b_profiles` | Next |

The platform administration live screens (B-4202 to B-4207) open 1.6.0 in Sprint 35 ([Backlog-1.6.0.md](Backlog-1.6.0.md)); their boards (B-4201) are done.

### Progress

**Sprint 29: done** (PR #40 and the boards in #43): permission matrices, custom roles, effective access with
`explain`, a route permission registry over every route, and access reviews with reviewers assigned per item (B-3301
to B-3305); record queries PostgreSQL answers from an index, p95 704 to 65 ms (B-3601); the prototype boards (B-3401).
Its six live screens (B-3402 to B-3404, B-3407, B-3408, B-3413) were built in Sprint 30, once the boards had landed.

**Sprint 30: done** (PR #46): CalDAV and CardDAV with DAV-only app passwords (B-3101 to B-3103), model-based memory
management (B-3701 to B-3703), MongoDB connections (B-3602), and eleven live screens with their accessibility and
reflow checks (B-3405, B-3409 to B-3412, B-3414, and Sprint 29's six). Unit suite 851 passed, Playwright 96 passed.
**B-3104 is partial**: the conformance fixtures were written from the clients' documented requests; B-3606 captures
real traffic in Sprint 34. Built ahead and parked: WebDAV for the file store (B-32, Sprint 34).

**Sprint 31: done** (PR #47): the AT-Protocol PDS with a post written to it appearing in the reference AppView in
CI (B-2901 to B-2906), feed generators and their published records (B-3001 to B-3004), relay commit signatures
verified (B-3604), the RSVP race closed on all three databases (B-3603), import repositories, browse and model import
(B-3801 to B-3803), and the live AT-Protocol screen (B-3406). The imports migration was built as `032b_imports` and
renamed `033c_imports` so it runs after the Sprint 30 migrations. Unit suite 935 passed, the PostgreSQL and MySQL
integration suites passed, Playwright 99 passed.

**Sprint 32: done** (this PR): the chain context with one `CHAIN_MAX_DEPTH` and root budgets across chat turns,
agent runs, workflow runs, tool calls, skill loads, plugin actions and app triggers (B-4101); sub-workflow, agent,
`map` and `loop` steps and skills on model steps (B-3901, B-3902, B-3905); event and schedule triggers on the workflow
itself, per-step retry, the on-failure edge and dead letters with redrive, and signed `exprsn-workflow/1` bundles
(B-3903, B-3906, B-3909); five domain built-in tools and the plugin broker's domain calls, approval forms, and the
`notify` and `webhook` steps (B-3904, B-3907, B-3908); app passwords and the DAV discovery URLs in Settings (B-3415);
and the live Workflows screen (B-3910). The migration was built as three: `034_workflows2`, `034b_workflow_triggers`
and `034c_workflow_steps`. Known gaps recorded in `docs/security.md`: cost is metered as GPU time, not priced; a chat
turn's own tokens are not charged to its chain; only feed posts record the run as their source; a redrive runs as the
admin who redrives it.

The order follows the dependencies: the permission matrix (B-3301) and custom roles (B-3302) before the roles screen
(B-3412); the prototype boards (B-3401) before any live screen; the WebDAV core (B-3101) before CalDAV, CardDAV and
the file-store mount (B-3102, B-3103, B-32); the PDS repository (B-2902) before the outbound firehose (B-2904) and
before a feed generator publishes its record into a tenant repo (B-3004); the AT-Protocol screen (B-3406) last, so it
covers the PDS and feeds; Workflows 2's agent step and skill loading (B-3902) and the built-in domain tools (B-3904)
before agents, tools and skills in chat (B-40, 1.7.0), which reuse them; the chain context (B-4101) with Workflows 2, so
sub-workflows (B-3901) and agent steps (B-3902) are chained from the start, and before the rest of chaining (B-4102 to
B-4109); the repository registry (B-3801) before any import (model import here; dataset import and the Import screen,
B-3804 to B-3807, in 1.7.0).

---

## P0

### B-33 Permission matrices and custom roles (24 points)

Today a tenant has the thirteen built-in roles and nothing shows, in one place, who can do what. These items make the
grant model inspectable and extensible without a second policy engine: every answer comes from `policy.ts`. New
permission: `roles:manage`.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-3301 | Role × permission matrix generated from the catalogue: `GET /api/authz/matrix` (JSON and CSV), and `docs/permissions.md` generated from the same source | The test fails when `docs/permissions.md` differs from the catalogue | 3 |
| B-3302 | Custom roles per tenant, built only from catalogue permissions; a creator cannot grant more than they hold; `grantableBy` and `requiresMfa` as for built-ins; roles holding admin permissions under dual control; versioned with diff and audit | A tenant admin cannot create a role holding `platform:manage` | 8 |
| B-3303 | Effective-access matrix: users × workspaces × permissions after scopes, clearance and zone ceilings, with the `explain` steps for any cell; "who can" for one permission | A cell matches `policy.explain` for the same principal and resource | 5 |
| B-3304 | Route permission registry: every route declares its permission in one table; the matrix lists routes per permission | A route registered without a declared permission fails the test suite | 3 |
| B-3305 | Access reviews: scheduled certification campaigns over the matrix; reviewers confirm or revoke each grant; overdue reviews escalate; results in the audit chain | A revoked grant is gone on the member's next request | 5 |

### B-34 Console screens (90 points)

Screens for everything 1.4.0 and 1.5.0 add, starting from prototype boards. B-3401 landed on `sprint-29` (2026-10-05): the
boards for every screen below plus the B-3413 additions are in `design/prototype/` (see `Sprints.md`, Sprint 29). Each live screen joins the Playwright
suite with axe-core (Standard and Enhanced, light and dark) and the reflow checks for its dialogs and drawers.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-3401 | Prototype boards in `design/prototype/` for every screen below, with copy, states and the "States to design" section; `node build.mjs` and the smoke run clean | Every new board passes the prototype smoke run in light and dark | 13 |
| B-3402 | Certificates: issuers, profiles, issuance from a CSR, revocation, CRLs, ACME directories and accounts, expiring certificates | Issuing and revoking a certificate works from the screen | 5 |
| B-3403 | Vault: KV with versions, transit keys with rotation, path policies with `explain`, leases and their engines | A policy's `explain` result shows on the screen | 5 |
| B-3404 | Plugins and events: the event catalogue, plugin manifests, grants, lifecycle and runs | Revoking a grant stops the plugin's next action | 3 |
| B-3405 | Moderation: routed queues with SLA timers, reports, appeals, sanctions, external providers in shadow or enforce mode, the dead-letter queue with redrive | Upholding an appeal from the screen restores the object | 8 |
| B-3406 | AT-Protocol: service DIDs and keys, the labeler and trusted labelers, firehose subscriptions, PDS accounts and feed generators (Sprint 31) | Rotating a key from the screen updates the DID document | 5 |
| B-3407 | Apps: entity designer with typed fields, formulas and lookups, a records grid with filters, the forms builder, the state-machine editor, triggers | An entity designed on the screen accepts a record | 13 |
| B-3408 | Files: folders, upload, versions with restore, trash, shares and links, quotas, previews | A shared link created on the screen downloads within its limit | 5 |
| B-3409 | Groups and events: groups with join modes, requests and invites, a calendar with RSVP and check-in, feed URLs | Cancelling an event from the screen notifies its attendees | 5 |
| B-3410 | Customer-service channels: sessions, held replies with approve, edit and reject, email threads, retention | An edited held reply reaches the customer as edited | 5 |
| B-3411 | Messages and the workspace feed for every member | A blocked user's message never appears on the screen | 8 |
| B-3412 | Roles and access: the role matrix, custom roles with diff, the effective-access matrix with `explain`, access reviews | Every cell's `explain` opens from the matrix | 5 |
| B-3413 | Identity additions to existing screens: self-registration policy, MFA policy and trusted devices, GitHub stores, CSV import, DID binding | The registration policy changes from Settings | 3 |
| B-3414 | Accessibility and reflow for every new screen; `docs/accessibility.md` updated | The e2e suite passes with no axe or reflow finding on any new screen | 5 |
| B-3415 | Settings: app passwords for DAV clients (DAV-only scope, device names, last use, revoke; creating one needs a fresh MFA step-up, per the decision below) and the CalDAV, CardDAV and WebDAV discovery URLs; added 2026-10-05 from the roll-up (B-3101 has no console item) | A revoked app password is refused by the next DAV request | 2 |

### B-36 Carried over from 1.4.0 (20 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-3601 | Low-code record queries that PostgreSQL can answer from an index: `NULLS LAST` instead of the `case` sort keys, indexes on `app_record_values` with `collate "C"` for text, a plan that filters and orders on one indexed field before joining the others, and keyset paging; the same rows on SQLite, MySQL and PostgreSQL as today (Sprint 27's 19-query proof) | The 1.4.0 load test's records query p95 is below 250 ms on PostgreSQL (732 ms at release) | 5 |
| B-3602 | Merge MongoDB data connections (`feat/mongodb-connections`): read-only find and aggregate, collection knowledge sources; rebased and tested on the three application databases (Sprint 30) | The `sample-mongodb` connection registers and its knowledge base builds | 3 |
| B-3603 | RSVP capacity race (B-2502 known gap): a conditional update or row lock on the remaining places (Sprint 31) | Fifty concurrent RSVPs for one place leave one attendee on SQLite, PostgreSQL and MySQL | 2 |
| B-3604 | Verify relay commit signatures on the firehose (B-1908 known gap) against the repo's DID key; bad commits dropped and audited, as inbound labels are (Sprint 31) | A commit with a bad signature is dropped and audited; a good one becomes a label as before | 5 |
| B-3605 | The IMAP channel adapter (B-2303) against a containerised IMAP server in CI instead of a mocked fetcher (Sprint 34) | A message delivered to the test mailbox becomes a channel thread in CI | 3 |
| B-3606 | Capture real DAV client traffic (B-3104 is partial): record Apple Calendar and Contacts, Thunderbird and DAVx5 against a test server and replace the written fixtures with the captured exchanges, replayed in CI (Sprint 34) | Every filter operator in the captured run returns the expected items | 2 |

## P1

### B-31 CalDAV and CardDAV (24 points)

Standard clients reach the B-25 calendars and the directory. Clients authenticate with per-device app passwords
(scoped API keys that never pass MFA on their own and can be revoked); sessions and cookies never apply. The platform's
CalDAV had broken filter operators: B-3104 states the fixed behaviour as its test.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-3101 | WebDAV core: PROPFIND, PROPPATCH, REPORT, ETags with `If-Match`, `sync-collection` (RFC 6578), `/.well-known/caldav` and `carddav` discovery, app passwords | A stale `If-Match` is refused with 412 | 8 |
| B-3102 | CalDAV (RFC 4791) over B-25 events and personal calendars: `calendar-query` with time-range and property filters, `calendar-multiget`, free-busy; RSVPs written back to B-2502 | An RSVP from a CalDAV client shows in the attendee list | 8 |
| B-3103 | CardDAV (RFC 6352): the directory as a read-only, clearance-filtered address book, plus personal address books | A contact above the caller's clearance is not returned | 5 |
| B-3104 | Interop: a recorded conformance run against Apple Calendar and Contacts, Thunderbird and DAVx5 in CI | Every filter operator in the conformance run returns the expected items | 3 |

### B-32 WebDAV for the file store (13 points)

Moved from Sprint 30 to Sprint 34 at grooming (2026-10-05); CalDAV and CardDAV (B-31) stay in Sprint 30 on the same WebDAV core.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-3201 | B-24 folders and files as WebDAV collections; `PUT` through the attachment quarantine, type check and ClamAV; versions kept | An upload over WebDAV is scanned before it can be read | 5 |
| B-3202 | `COPY` and `MOVE` for files and folders (the platform returned 501), `LOCK` and `UNLOCK` (class 2) for Finder and Office | Moving a folder over WebDAV keeps its versions and shares | 5 |
| B-3203 | Quota properties (RFC 4331), shares honoured, the `litmus` suite in CI | `litmus` passes its basic, copymove and locks groups | 3 |

### B-42 Platform administration screens (42 points; 5 in 1.5.0)

Renumbered from B-39 on 2026-10-05: B-39 is Workflows 2 (below), which B-40 and B-41 already reference.

The second half of the exprsn-platform merge: its administration surface (the admin SPA's 22 sections, the legacy
`admin/` service) mapped onto the console in `design/platform-admin/README.md`, and five admin boards for the concerns
that had no home: Overview, Jobs and queues, Storage, Configuration, Social and messaging. Live screens follow the B-34
rules; open questions are answered with `node design/platform-admin/decide.mjs` and recorded under Open decisions.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-4201 | Prototype boards for Overview, Jobs and queues, Storage, Configuration, Social and messaging; `node build.mjs` and the smoke run clean | Every board passes the smoke run in light and dark | 5 |
| B-4202 | Overview live: `GET /api/admin/overview` (alerts, counters, instances with their `/readyz` checks, next schedules, recent audit, capacity); acknowledge alerts; drain an instance | Draining an instance from the screen stops it claiming jobs | 5 |
| B-4203 | Jobs and queues live: `GET /api/admin/jobs` with filters, `/queues`, `/schedules` (run now, pause), `/dead-letters` (redrive, discard), `/cache` (namespaces, invalidate); pause by type in `JobQueue` | A paused type stops claiming within one poll and resumes from the screen | 8 |
| B-4204 | Storage live: stores and health, usage by workspace and user, quarantine listing with rescan, the integrity job `ops.blobs.verify` with findings, purge schedule summary | An orphan found by the job can be deleted from the screen after a dry run | 8 |
| B-4205 | Configuration live: a settings descriptor generated from `config/index.ts` (name, section, type, default, secret, hot or restart), `GET /api/admin/platform/settings` with per-instance values; database overrides for every setting under dual control, applied hot or flagged restart required (decision Q2) | Two instances with different values show as differing; an override applies only after a second platform admin approves | 8 |
| B-4206 | Social and messaging live: feed approval policy and trending exclusions, group defaults and calendar feed revocation, messaging limits and legal-hold export, realtime room counts, contact rules; a new `social:manage` permission, with held content under `moderation:manage` (decision Q4) | A revoked calendar feed answers 404 on its next fetch | 5 |
| B-4207 | Accessibility and reflow for the five screens; `docs/accessibility.md` updated | No axe or reflow finding on any of the five | 3 |

B-4201 is done (Sprint 29). B-4202 to B-4207 (37 points) open 1.6.0 in Sprint 35 (decision Q12, groomed 2026-10-05) and
are tracked in [Backlog-1.6.0.md](Backlog-1.6.0.md). All sixteen design questions are answered in `design/platform-admin/DECISIONS.md`.
### B-37 Model-based memory management (13 points)

Today memory proposals come from rules over a chat turn (`extractProposals`) and the only model memory uses is the
embedding model, chosen as the first approved one by name. This adds a model where judgement helps, always as
proposals a person accepts, with the rules kept as the fallback.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-3701 | A tenant `memory` profile that extracts proposals from chat turns and agent runs; the rules run when no profile is set or the model fails; proposals still pass the `memory` checkpoint, the credential ban and the rejection list | A model error still yields the rules' proposals, and a rejected text is never proposed again | 5 |
| B-3702 | A consolidation job: near-duplicates found by embedding similarity and confirmed by the profile become one merge proposal; stale or contradicted memories get an expiry proposal; nothing changes until accepted | Two near-duplicate memories produce one merge proposal and both stay unchanged until it is accepted | 5 |
| B-3703 | The memory embedding model as a tenant setting (instead of the first approved embedding model by name), with a reindex job and recall by recency while it runs | Switching the model reindexes every memory and recall keeps answering during the reindex | 3 |

### B-38 Model and dataset import wizard (21 points in 1.5.0)

Split at grooming (2026-10-05): repositories, browse and model import (B-3801 to B-3803) in Sprint 31. Datasets, knowledge sets, eval sets and the Import screen (B-3804 to B-3807) moved with Sprint 33 to 1.7.0 on 2026-10-05 ([Backlog-1.7.0.md](Backlog-1.7.0.md)); until then model import is reached through the API.

Approved from the mockup `design/mockups/import-wizard.html` and the prototype board `design/prototype/js/screens/import.js`
(route `#/import`) on 2026-10-05. One guided path from a public repository (Hugging Face Hub, the Ollama library,
ModelScope, data.gov, data.europa.eu, Eurostat and the ECB, data.gov.sg, data.go.jp and e-Stat, data.gov.in,
data.go.kr, OpenML, Zenodo, Kaggle, the signed import share) to a draft model in the catalogue, a versioned training
dataset, a classifier evaluation set or a knowledge set. It extends the Models, Training, Classifiers and Knowledge
screens rather than replacing them: the result lands where those screens already govern it, and the licence, label,
digest, attribution and requester are recorded on the manifest. Weights still enter only through the signed import
path (GGUF and safetensors; pickle refused before anything is written); air-gapped instances queue the request for
the weekly bundle. New permissions: `imports:run` (model, ML and knowledge admins by destination) and
`imports:repositories` (model admin, dual control). New tables: `import_repositories`, `import_catalog`,
`import_jobs`; `knowledge_sources.kind` gains `dataset`, `training_datasets.source_kind` gains `import`.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-3801 | Repository registry: types (Hugging Face compatible hub, Ollama compatible registry, CKAN, DCAT-AP, SDMX, OpenML, InvenioRDM, Kaggle, bundle share), credentials in the vault, the staging-proxy allow-list, dual-controlled add, harvest schedules and the catalogue snapshot | A CKAN portal added from the screen is harvested and browsable after confirmation | 8 |
| B-3802 | Catalogue browse: search, classification and licence facets from the source's own taxonomy, live search through the proxy when reachable, snapshot fallback with backoff when rate limited | A facet count equals the rows the filter returns | 5 |
| B-3803 | Model import: tags, variants and files, gate acceptance with the recorded token, format and pickle checks, licence policy and exceptions, GGUF conversion on the training pool, draft registration with digest pinning; bundle mode for air-gapped instances | A pickle-only repository is refused with nothing written; a safetensors import registers a draft whose digest matches | 8 |

### B-39 Workflows 2 (61 points)

Added 2026-10-05 from the Sprint 29 prototype roll-up (`design/prototype/rollup-1.5.html`), approved by the owner. The
realigned Workflows board (`design/prototype/js/screens/workflows.js`) already shows every step and trigger below as a
"1.5 proposal" that refuses to publish with error code `unavailable`; each item removes that refusal. Everything
follows the 1.4.0 workflow patterns: a step is a kind in `NODE_KINDS` with a zod config in `CONFIGS` and a port schema
(`server/src/workflows/graph.ts`), validated at publish with the existing error codes (`structure`, `cycle`, `config`,
`schema`, `label`, `limit`, `reference`, `unavailable`, `unreachable`), run as durable checkpointed jobs (each output
sealed with the tenant key, resumable after a restart), paused without holding a worker, dry-runnable with mocks,
replayable from a step, audited under `workflow.*`, and bounded by the run limits (40 steps, fan-out 10, 30 min a
step, 2 h and 200k tokens a run). Labels propagate along every path; nothing runs below the run's label or above a
step's ceiling. Trigger chains carry on: app triggers stop at `APPS_TRIGGER_MAX_DEPTH`, plugins at `PLUGIN_MAX_DEPTH`,
and sub-workflows at `WORKFLOW_MAX_DEPTH` (new; superseded by B-4101's chain context and its one `CHAIN_MAX_DEPTH` across
kinds once PR #41 lands, with the per-kind limits kept as caps).

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-3901 | Sub-workflow step (`sub`): a published workflow version runs as a child under the parent's label, principal and trigger chain; the child's approvals pause the parent; `workflow.*` tools stay refused in tool steps, chaining goes through this step; depth capped by the chain context (B-4101) | A parent run resumes with the child's output after the child's approval is decided | 8 |
| B-3902 | Agent step (`agent`) and skills on model steps: a registry agent runs within its budgets and is awaited like B-1006 in reverse; `skills[]` on a `model` step loads published skills' instructions and tools through the dispatcher | A model step with a skill calls one of the skill's tools and the call passes the `tool-call` checkpoint | 8 |
| B-3903 | Triggers on the workflow itself: source `event` (a catalogue event with the plugin fan-out rules: workspace, label, rate, loop chain) and source `schedule` (a five-field UTC cron claimed once across instances, no app entity needed) | A `file.uploaded` event starts a run without a plugin; a cron run starts once with two instances | 8 |
| B-3904 | Domain steps as built-in registry tools (`impl: builtin`, shared by chat, agents and workflows): send a message, post to a feed, write a file version, create a group event, answer a channel session; the plugin broker's `records.*`, `files.read`, `groups.read` and `posts.write` calls confirmed live | A workflow posts to a workspace feed under its label and the post carries the run as its source | 8 |
| B-3905 | `map` (fan-out over a list with a parallelism cap) and `loop` (bounded iteration) whose items and iterations count toward the run limits | A map over 200 items runs 20 at a time and a loop stops at its cap | 8 |
| B-3906 | Per-step retry policy, an on-failure edge (`branch: failure`) and a dead-letter view of failed runs with redrive, like moderation's | A failed HTTP step takes the on-failure edge instead of failing the run | 5 |
| B-3907 | Approval with a form: the step names an app form whose answers (validated like a submission) become the step's output | An approver's answers reach the next step and are audited with the decision | 5 |
| B-3908 | `notify` and `webhook` steps: in-app and email notices to cleared recipients; outbound webhooks through the tenant's allowed hosts, signed with the tenant's webhook keys | A webhook step is refused at save for a host outside the tenant's list | 5 |
| B-3909 | Workflow bundles: signed export and import (`exprsn-workflow/1`, like `exprsn-app/1`) with tool, profile and trigger references re-bound on import | A bundle changed after signing is refused with `422 Bundle refused` | 3 |
| B-3910 | Console: the live Workflows screen matches the realigned board (Triggers and callers tab, record and vault editors, decision-edge labels, the new kinds as they land) and joins the Playwright suite | Every control on the screen is backed by the server | 3 |

### B-41 Chaining agents, skills, tools and workflows (47 points)

Added 2026-10-05 at the owner's request. Some links exist: agents call tools and load skills, skills name the tools
they need, agents await workflows published as tools (B-1006), and workflows call tools; Workflows 2 adds sub-workflows
and agent steps (B-3901, B-3902) and B-40 brings agents, tools and skills into chat in 1.7.0 (moved with Sprint 33). Missing are agents delegating to
agents, skills built from skills, workflows started from chat, and above all one chain across them: today each kind
keeps its own depth limit (`PLUGIN_MAX_DEPTH`, `APPS_TRIGGER_MAX_DEPTH`, and the planned workflow and chat-agent
limits), budgets are per run, nothing checks a cycle across kinds, and no view shows a chain end to end. Rules for
every link: the principal never changes (a chain acts as the person or service that started it), the label only rises
(the chain's high-water mark), and nothing runs above a callee's ceiling or the caller's clearance.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-4101 | The chain context: every invocation (chat turn, agent run, workflow run, tool call, skill load, plugin action, app trigger) records its root, parent, depth, principal and label high-water mark; tokens, steps, wall time and cost are charged to the root's budgets; one `CHAIN_MAX_DEPTH` across kinds, with the per-kind limits kept as caps; carried across instances and job retries | A mixed chain (agent → workflow → agent → tool) stops at the depth limit or at the root's budget, whichever comes first, with the same answer on every instance | 8 |
| B-4102 | Agents delegate to agents: an agent's definition lists the `agents` it may call; each is offered as a tool (`agent:<name>`) and runs as a child run in the chain; a child's answer can be typed by its `outputSchema` | A child run cannot spend more than the parent's remaining budget nor read above the chain's ceiling | 8 |
| B-4103 | Skills compose: a skill lists the `skills` and `tools` it needs; loading resolves the closure (deduplicated, in order) and offers the required tools to the agent or model step that loads it | Loading a skill offers the tools its sub-skills need, and the closure loads each skill once | 5 |
| B-4104 | Workflows as first-class callees of agents: agents list `workflows` they may start without publishing them as tools; the run awaits the workflow and gets its output as a typed answer (starting a workflow from chat, `/workflow`, moved to 1.7.0 with B-40 as B-4009) | An agent starts a workflow it lists and receives its output; a workflow it does not list is refused | 3 |
| B-4105 | Chain checks at publish: the registry and workflow publish build the reference graph across agents, skills, tools and workflows; cycles that cannot terminate, references above the referrer's ceiling and unpublished references are refused; a "used by" view before deprecating or retiring an entry | Retiring a skill a published agent uses is refused, naming the agent | 5 |
| B-4106 | Approvals and failures through the chain: a call held anywhere pauses the chain and is approved where the root is (the run or the workflow's approval; the conversation's card comes with B-40 in 1.7.0) with the path shown; a child's failure reaches its parent as a typed error the parent handles (an agent sees it as a tool error, a workflow takes its failure edge, B-3906) | A write tool held three levels down is approved from the root run and the chain resumes | 5 |
| B-4107 | Chain view: `GET /api/chains/:id`, the tree of invocations with timing, tokens, cost, labels and guardrail decisions; links to the audit entries; replay from a node where its kind can replay | The tree's token total equals what was metered for the chain | 3 |
| B-4108 | Prototype boards: the chain tree in Runs (linked from workflow runs; chat's run cards link to it in 1.7.0), the registry editor's delegates, skill dependencies and workflows fields, and the "used by" view; the smoke run clean | The boards pass the prototype smoke run in light and dark | 3 |
| B-4109 | Console: the live chain tree and registry fields from B-4108, joining the Playwright suite with axe-core and the reflow checks | A three-level chain opens as a tree from its run in Runs with no axe or reflow finding | 5 |

### B-58 Profiles and presence (11 points)

Added at grooming (2026-10-05): exprsn-platform's users had avatars, bios and a status; Exprsn-AI users have a display
name only, so the feed, messaging and groups screens have no profile to open. Sprint 34.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-5801 | Profiles: avatar through the file store and the attachment quarantine, bio and pronouns through the `user-input` guardrail, a profile page opened from posts, messages, groups and the directory, visibility by workspace and clearance | Opening an author from a post shows their profile; an avatar that fails the scan is never shown | 8 |
| B-5802 | Presence status: available, away, busy or offline, chosen or derived from idle time, over the existing presence sockets; blocked users see nothing (B-2603, B-2606) | A member set to busy shows busy to a contact within five seconds and not at all to a blocked user | 3 |

## P2

### B-29 AT-Protocol personal data server (42 points)

Hosting user repositories, so Exprsn-AI accounts can be AT-Protocol accounts without a third-party PDS. Each account's
repo signing key is held by the signer (B-1608) and its DID is managed through B-1609. Needs a public https hostname
and a handle domain per tenant. New permission: `pds:manage`.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-2901 | Accounts tied to Exprsn-AI identities: `com.atproto.server` create, session and refresh, app passwords, handles on the tenant's domain, invite codes under the B-1801 policy | A new account's handle resolves to its DID | 8 |
| B-2902 | Repository: Merkle search tree, signed commits, `com.atproto.repo` create, put, delete and `applyWrites` with lexicon validation; `com.atproto.sync` `getRepo` (CAR), `getRecord`, `getBlocks`, `listBlobs` | A repo exported as CAR verifies against its signed commit | 13 |
| B-2903 | Blobs on the blob store through the attachment quarantine and ClamAV, with size and type limits per tenant | A blob that fails the scan is never served | 3 |
| B-2904 | Outbound `subscribeRepos` with a sequencer, cursor and backfill window; `requestCrawl` to configured relays | A relay double replays commits from a cursor | 8 |
| B-2905 | Account migration in and out, deactivation, and takedowns through B-19 with labels from B-1610 | A taken-down repo returns `RepoTakendown` | 5 |
| B-2906 | Interop: tests against the reference PDS, relay and AppView development environment in CI | A post written to Exprsn-AI's PDS appears in the reference AppView | 5 |

### B-30 Custom feed generator (18 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-3001 | `app.bsky.feed.describeFeedGenerator` and `getFeedSkeleton` with inter-service JWT verification against the caller's DID key | A request with a bad service JWT is refused | 5 |
| B-3002 | Feed definitions as rules over the firehose index (B-1908): authors, collections, keywords, labels; optional ranking by a profile (embeddings or a classifier) through the gateway | A post from an author outside the rule never appears in the feed | 8 |
| B-3003 | A feed index with retention, cursor pagination and per-feed rate limits | A cursor returns the next page without repeats | 3 |
| B-3004 | Publish the `app.bsky.feed.generator` record to the tenant's repo (B-29) or an external account | The published record names the generator's service DID | 2 |

## Release

| ID | Item | Pts |
| --- | --- | --- |
| B-3501 | Version `1.5.0`, the CHANGELOG, `docs/api.md`, `docs/permissions.md`, `docs/accessibility.md` and the known-gaps sections updated as each item lands (Sprint 34) | — |

---

## Still deferred

Groomed by the owner on 2026-10-05.

| Item | Decision |
| --- | --- |
| Live streaming (ingest, WebRTC rooms, simulcast, recordings) | Dropped: no live streaming in Exprsn-AI |
| End-to-end-encrypted messaging | Dropped: server-side guardrails, summaries and semantic search stay |
| Governance voting | 1.7 or later; no demand in Exprsn-AI's workspaces yet |
| Recurring events and VTIMEZONE in calendar feeds | 1.7 or later |
| Web push notifications | 1.7 or later |
| SMS one-time codes | 1.7 or later; needs a paid SMS provider |
| Server log view in the console | 1.7 or later; traces and metrics only for now |

## Open decisions

All six resolved by the owner on 2026-10-05.

- [x] PDS hosting: opt-in per tenant, enabled by a platform admin; handles live on a platform-controlled tenant
  subdomain (`<handle>.<tenant>.<pds domain>`). A tenant's own handle domain is deferred to 1.6 (B-2901).
- [x] Custom roles: tenant only. Workspaces assign roles but do not define them; the matrix stays one table per
  tenant (B-3302, B-3412).
- [x] Access reviews: both the workspace admin (tenant admin for tenant-level roles) and the member's directory
  manager are assigned; the first decision stands. When the manager attribute is empty only the admin is assigned
  (B-3305).
- [x] DAV app passwords: allowed for roles that require MFA, but creating one needs a fresh MFA step-up and the
  password carries a DAV-only scope (CalDAV, CardDAV, WebDAV; never the API or console) (B-3101).
- [x] Import quota (B-38): 500 GB per tenant for datasets, metered and shown beside the existing tenant quotas; any
  workspace's import draws from it (B-3804).
- [x] Licence exceptions (B-3803, B-3804): granted or refused by a reviewer holding a new `legal-review` role; tenant
  admins request but cannot grant. The import waits in the queue until the decision.
- [x] Platform administration screens (B-42), all sixteen design questions (answered 2026-10-05, full table in
  `design/platform-admin/DECISIONS.md`): the cache is a tab on Jobs and queues; Configuration takes database
  overrides for every setting under dual control; Overview is first in the Admin group; a new `social:manage`
  permission, with held content under `moderation:manage`; legal-hold exports under dual control; groups get a
  tenant-managed category list (1.6.0, B-44); system admins see every tenant's jobs, tenant admins their own; orphan
  blobs are deleted after a dry run by one admin with a reason; tenant templates on the Tenants screen (1.6.0, B-45);
  the live screens open 1.6.0 in Sprint 35; icons are added when the screens go live; instances drain from the
  console with a confirm and a recent sign-in; alerts are acknowledged tenant-wide; blob store migration is designed
  as proposed. Logs wait for 1.7 and live streaming is dropped.
- [x] Model servers beyond Ollama (B-43): 1.6.0's first sprint, Sprint 35 (decided 2026-10-05); whether Apple's
  on-device model is also a `classify` fallback beside TEV stays open in [Backlog-1.6.0.md](Backlog-1.6.0.md).
- [x] Model import screen (B-3803): none in 1.5.0; model import is reached through the API until the Import screen
  (B-3807) in 1.7.0 (decided 2026-10-05).
- [x] DAV conformance (B-3104): partial, because the fixtures were written from the clients' documented requests;
  real traffic from Apple Calendar and Contacts, Thunderbird and DAVx5 is captured later (B-3606, decided 2026-10-05).
- [x] CardDAV directory (B-3103): people who share a workspace with the caller, within the caller's clearance, as
  messaging and groups scope people; a workspace open to the whole tenant includes everyone (decided 2026-10-05).
## Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| AT-Protocol repo format | A subtle MST or CAR encoding error makes relays and AppViews reject the repo | Conformance against the reference implementation's test vectors and the dev environment in CI (B-2906) |
| Hosting public repositories | Abuse, takedown and legal duties for content Exprsn-AI now serves to the network | P2 and off by default per tenant; takedowns through B-19; the open decision above |
| DAV client quirks | Clients differ on ETags, sync tokens and locking | Recorded conformance runs (B-3104) and `litmus` (B-3203) in CI |
| Public repositories | A harvested card misstates its licence, or a gated download changes under the same revision | Licence recorded from the fetched files, not the snapshot; digests pinned at request time; pickle scan at staging as well as in the wizard (B-3803) |
| Custom roles widening access | A role grants more than its creator holds, or more than a zone allows | Creation capped at the creator's own permissions, dual control for admin permissions, the zone ceiling still applies in `policy.ts` |
| Screen volume | Fourteen new screens strain the e2e suite's run time | Share fixtures; the reflow spec covers dialogs by registry rather than per test |
| Server-held models | A model on an `openai` instance has no pinned digest, so what answers may change under the same id after an OS or server update | The instance records the server's version and the model id at approval; a change re-runs the conformance run and flags the entry (B-4304); the gap is written down in `docs/security.md` (B-4306) |
