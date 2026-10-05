# Backlog: 1.5.0

The work after 1.4.0. 1.4.0 shipped exprsn-platform's server features with no console work; 1.5.0 gives them their
screens, makes access reviewable as permission matrices with tenant-defined roles, adds the standard calendar,
contact and file protocols (CalDAV, CardDAV, WebDAV) over the 1.4.0 events and file store, and hosts AT-Protocol
repositories with a personal data server (PDS) and custom feed generators. Rules as before: everything follows
`docs/PLAN.md` and `CLAUDE.md`; screens follow `design/prototype/CONTRACT.md` (prototype board first, then live when
every control is backed by the server); every server item ships its routes, permission, audit events, jobs, tests on
SQLite, PostgreSQL and MySQL, `docs/api.md` and `docs/openapi.json` entries and any known gaps in `docs/security.md`.

**Size.** 48 items, 277 points (1 point ≈ half a day for one engineer, tests included): P0 119, P1 98, P2 60. At about
78 points a sprint (roughly five engineers) that is Sprints 29 to 32. With fewer, P2 (the PDS and feed generator)
moves to 1.6 first, then WebDAV (B-32), then Workflows 2 (B-37, added 2026-10-05 from the Sprint 29 prototype roll-up
`design/prototype/rollup-1.5.html`).

**Builds on.** The permission catalogue and built-in roles (`server/src/authz/permissions.ts`) and `policy.explain`;
B-25 events (B-2502) and their signed iCal feeds (B-2504); the B-24 file store with its quarantine, scan, versions,
shares and quotas; B-1608 AT-Protocol signing keys, B-1609 service DIDs, B-1610 labeler and B-1908 firehose ingest;
B-19 moderation for takedowns. Nothing here replaces those; the protocols are new front doors onto the same data and
the same policy pipeline.

## Sprints

| Sprint | Theme | Items | Points | Migration | Status |
| --- | --- | --- | --- | --- | --- |
| 29 | Permission matrices and custom roles; prototype boards; trust, identity, apps and files screens; record queries on PostgreSQL | B-3301–B-3305, B-3401–B-3404, B-3407, B-3408, B-3413, B-3601 | 76 | `031_access` | In progress (B-3401 done) |
| 30 | Domain screens; CalDAV, CardDAV and WebDAV | B-3405, B-3409–B-3412, B-3414, B-3101–B-3104, B-3201–B-3203 | 73 | `032_dav` | Planned |
| 31 | AT-Protocol PDS and feed generator | B-2901–B-2906, B-3001–B-3004, B-3406 | 65 | `033_pds_feeds` | Planned |
| 32 | Workflows 2: chaining, agent and skill steps, event and schedule triggers, domain steps, map and loop, failure handling, release | B-3701–B-3710, B-3415, B-3501 | 63 | `034_workflows2` | Planned |

The order follows the dependencies: the permission matrix (B-3301) and custom roles (B-3302) before the roles screen
(B-3412); the prototype boards (B-3401) before any live screen; the WebDAV core (B-3101) before CalDAV, CardDAV and
the file-store mount (B-3102, B-3103, B-32); the PDS repository (B-2902) before the outbound firehose (B-2904) and
before a feed generator publishes its record into a tenant repo (B-3004); the AT-Protocol screen (B-3406) last, so it
covers the PDS and feeds.

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
| B-3415 | Settings: app passwords for DAV clients (scoped keys with device names, last use, revoke) and the CalDAV, CardDAV and WebDAV discovery URLs; added 2026-10-05 from the roll-up (B-3101 has no console item) | A revoked app password is refused by the next DAV request | 2 |

### B-36 Carried over from 1.4.0 (5 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-3601 | Low-code record queries that PostgreSQL can answer from an index: `NULLS LAST` instead of the `case` sort keys, indexes on `app_record_values` with `collate "C"` for text, a plan that filters and orders on one indexed field before joining the others, and keyset paging; the same rows on SQLite, MySQL and PostgreSQL as today (Sprint 27's 19-query proof) | The 1.4.0 load test's records query p95 is below 250 ms on PostgreSQL (732 ms at release) | 5 |

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

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-3201 | B-24 folders and files as WebDAV collections; `PUT` through the attachment quarantine, type check and ClamAV; versions kept | An upload over WebDAV is scanned before it can be read | 5 |
| B-3202 | `COPY` and `MOVE` for files and folders (the platform returned 501), `LOCK` and `UNLOCK` (class 2) for Finder and Office | Moving a folder over WebDAV keeps its versions and shares | 5 |
| B-3203 | Quota properties (RFC 4331), shares honoured, the `litmus` suite in CI | `litmus` passes its basic, copymove and locks groups | 3 |

### B-37 Workflows 2 (61 points)

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
and sub-workflows at `WORKFLOW_MAX_DEPTH` (new).

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-3701 | Sub-workflow step (`sub`): a published workflow version runs as a child under the parent's label, principal and trigger chain; the child's approvals pause the parent; `workflow.*` tools stay refused in tool steps, chaining goes through this step; depth capped by `WORKFLOW_MAX_DEPTH` | A parent run resumes with the child's output after the child's approval is decided | 8 |
| B-3702 | Agent step (`agent`) and skills on model steps: a registry agent runs within its budgets and is awaited like B-1006 in reverse; `skills[]` on a `model` step loads published skills' instructions and tools through the dispatcher | A model step with a skill calls one of the skill's tools and the call passes the `tool-call` checkpoint | 8 |
| B-3703 | Triggers on the workflow itself: source `event` (a catalogue event with the plugin fan-out rules: workspace, label, rate, loop chain) and source `schedule` (a five-field UTC cron claimed once across instances, no app entity needed) | A `file.uploaded` event starts a run without a plugin; a cron run starts once with two instances | 8 |
| B-3704 | Domain steps as built-in registry tools (`impl: builtin`, shared by chat, agents and workflows): send a message, post to a feed, write a file version, create a group event, answer a channel session; the plugin broker's `records.*`, `files.read`, `groups.read` and `posts.write` calls confirmed live | A workflow posts to a workspace feed under its label and the post carries the run as its source | 8 |
| B-3705 | `map` (fan-out over a list with a parallelism cap) and `loop` (bounded iteration) whose items and iterations count toward the run limits | A map over 200 items runs 20 at a time and a loop stops at its cap | 8 |
| B-3706 | Per-step retry policy, an on-failure edge (`branch: failure`) and a dead-letter view of failed runs with redrive, like moderation's | A failed HTTP step takes the on-failure edge instead of failing the run | 5 |
| B-3707 | Approval with a form: the step names an app form whose answers (validated like a submission) become the step's output | An approver's answers reach the next step and are audited with the decision | 5 |
| B-3708 | `notify` and `webhook` steps: in-app and email notices to cleared recipients; outbound webhooks through the tenant's allowed hosts, signed with the tenant's webhook keys | A webhook step is refused at save for a host outside the tenant's list | 5 |
| B-3709 | Workflow bundles: signed export and import (`exprsn-workflow/1`, like `exprsn-app/1`) with tool, profile and trigger references re-bound on import | A bundle changed after signing is refused with `422 Bundle refused` | 3 |
| B-3710 | Console: the live Workflows screen matches the realigned board (Triggers and callers tab, record and vault editors, decision-edge labels, the new kinds as they land) and joins the Playwright suite | Every control on the screen is backed by the server | 3 |

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
| B-3501 | Version `1.5.0`, the CHANGELOG, `docs/api.md`, `docs/permissions.md`, `docs/accessibility.md` and the known-gaps sections updated as each item lands (Sprint 32) | — |

---

## Still deferred

| Item | Why |
| --- | --- |
| Live streaming (ingest, WebRTC rooms, simulcast) | Needs SRS or Cloudflare Stream plus RTMP and TURN infrastructure |
| Governance voting | No demand in Exprsn-AI's workspaces yet |
| End-to-end-encrypted messaging | Conflicts with server-side guardrails and AI features |
| SMS one-time codes | Needs a paid SMS provider |

## Open decisions

- [ ] PDS hosting: which tenants may host repositories, and the handle domain each uses (a tenant subdomain or the
  tenant's own domain).
- [x] Custom roles: the tenant only (decided 2026-10-05 for the B-3412 board; workspaces reuse tenant roles).
- [x] Access reviews: the workspace admin reviews by default (decided 2026-10-05); a campaign may name other reviewers.
- [ ] DAV app passwords: allowed for roles that require MFA, or refused for them?

## Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| AT-Protocol repo format | A subtle MST or CAR encoding error makes relays and AppViews reject the repo | Conformance against the reference implementation's test vectors and the dev environment in CI (B-2906) |
| Hosting public repositories | Abuse, takedown and legal duties for content Exprsn-AI now serves to the network | P2 and off by default per tenant; takedowns through B-19; the open decision above |
| DAV client quirks | Clients differ on ETags, sync tokens and locking | Recorded conformance runs (B-3104) and `litmus` (B-3203) in CI |
| Custom roles widening access | A role grants more than its creator holds, or more than a zone allows | Creation capped at the creator's own permissions, dual control for admin permissions, the zone ceiling still applies in `policy.ts` |
| Screen volume | Thirteen new screens strain the e2e suite's run time | Share fixtures; the reflow spec covers dialogs by registry rather than per test |
