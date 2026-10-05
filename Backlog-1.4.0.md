# Backlog: 1.4.0

The work after 1.3.1. It brings the server features of 13 of the 14 `/Volumes/Storage/exprsn-platform` modules into
Exprsn-AI, with no console work: a certificate authority with AT-Protocol trust, a secrets vault, the remaining
identity gaps with AT-Protocol accounts, moderation actions and appeals, events and plugins, and new domains (low-code
apps, customer-service channels, a file store, groups and events, messaging and a workspace feed). Rules as before:
everything follows `docs/PLAN.md` and `CLAUDE.md`; the platform's backend design is re-implemented here in strict
TypeScript on Knex, never its UI or CSS, and nothing is copied verbatim. Every item ships its routes, permission, audit
events, jobs, tests on SQLite, PostgreSQL and MySQL, `docs/api.md` entries and any known gaps in `docs/security.md`.
The console screens follow in a later release.

**Size.** 76 items, 391 points (1 point ≈ half a day for one engineer, tests included): P0 217, P1 114, P2 60. At about
78 points a sprint (roughly five engineers) that is Sprints 24 to 28. With fewer, P2 moves to 1.5 first, then P1 in
the order B-25, B-24, B-23, B-22.

**Already delivered, so smaller here.** 1.1.0 to 1.3.1 built parts of what this backlog first planned: admin
invitations (`PASSWORD_INVITE_HOURS`), password reset by email and the email templates (B-104, B-110), roles that
require a second factor, the new-device cookie (B-801), PAR and DPoP as an authorisation server (B-403, B-404, B-805),
outbound webhooks with event groups, HMAC and Ed25519 signatures, ordering and RFC 9421 (B-302, B-1004, B-1202,
B-1203, B-1504), OpenBao dynamic credentials for data connections (B-416), the signer process (B-1201), and socket
rooms decided by the server and closed on membership change (B-705, B-1305). Items below build on these rather than
repeat them; webhook delivery is dropped from the plugins epic entirely.

## Sprints

| Sprint | Theme | Items | Points | Migration | Status |
| --- | --- | --- | --- | --- | --- |
| 24 | Trust foundations: CA issuance, OCSP, secrets, plugin catalogue, core | B-2101–B-2104, B-1601–B-1604, B-1701–B-1703, B-2001–B-2002 | 78 | `026_pki_secrets`, `026b_secrets`, `026c_core` | **Done** |
| 25 | ACME server, AT-Protocol trust, leases, plugins | B-1605–B-1611, B-1704–B-1706, B-2003–B-2005 | 77 | `027_acme`, `027b_atproto`, `027c_leases`, `027d_plugins` | **Done** |
| 26 | Identity gaps and AT-Protocol sign-in, moderation, file store | B-1801–B-1805, B-1807–B-1808, B-1901–B-1907, B-2401–B-2405 | 81 | `028_identity`, `028b_atproto_accounts`, `028c_moderation`, `028d_files` | **Done** |
| 27 | Firehose, low-code apps, groups and events | B-1908, B-2201–B-2208, B-2501–B-2505 | 71 | `029_apps`, `029b_firehose`, `029c_groups` | **Done** |
| 28 | Customer-service channels, messaging, feed, load test, release | B-2301–B-2304, B-1806, B-2105, B-2601–B-2606, B-2701–B-2705, B-2801 | 84 | `030_channels_social` | Next |

### Progress

**Before Sprint 24: done.** `fix/schema-dialects-load-timeout` merged (#23). The gateway slot deadlock is fixed: chat
builds its prompt and retrieval context before taking the slot, then applies the pool ceiling, label and citations
after the lease (`server/test/chat-slot.test.ts` fails on the old code). Two places still hold a slot while asking for
another and are left for a later sprint: the guard model screening a stream, and chat's tool rounds.

**Sprint 24: done** (78 points), built as three parallel parts with migrations `026_pki_secrets`, `026b_secrets` and
`026c_core`. Unit suite 599 passed, console suite 57 passed; the PostgreSQL integration tests ran against throwaway
servers, MySQL and Redis run in CI.

| Item | Status | Notes |
| --- | --- | --- |
| B-1601 to B-1604 | Done | Root and per-tenant intermediates (P-256, RSA 3072) with keys only in the signer or OpenBao; profiles and CSR issuance; numbered CRLs; OCSP. Interop with `openssl x509`, `crl`, `verify` and `ocsp` |
| B-1701 to B-1703 | Done | Versioned KV, tenant transit (with rewrap and trim), path policies with `explain`. Transit key material is sealed with the tenant key rather than held in OpenBao (known gap) |
| B-2001 | Done | Catalogue at `GET /api/events/catalogue`; every emitted event is checked against its schema, and the test suite fails on a mismatch |
| B-2002 | Done (data only) | Manifests, grants and lifecycle; nothing runs a plugin until B-2003 and B-2004 |
| B-2101 | Done (mechanism) | Generic rooms; no domain registers one until messaging, groups, feeds or channels ship |
| B-2102 | Done | Tenant read-through cache, Redis or memory, invalidated over the bus |
| B-2103 | Partial | `plugins` and `events replay` done; `pki` comes with B-1607, `secrets` and `users import` remain |
| B-2104 | Done | `docs/openapi.json` covers every registered route and is checked by a test |

**Sprint 25: done** (77 points), built as four parallel parts with migrations `027_acme`, `027b_atproto`,
`027c_leases` and `027d_plugins`. Unit suite 663 passed in one run; the PostgreSQL integration tests (ACME, AT-Protocol,
leases, plugins) ran against throwaway servers, MySQL in CI. Decisions taken: a service DID and labeler per tenant with
a platform fallback; built-in database leases registered only by `connections:manage` holders, in a zone whose ceiling
covers the target database. New dependency: `ws` (already installed through socket.io), for AT-Protocol's plain
WebSocket subscriptions.

| Item | Status | Notes |
| --- | --- | --- |
| B-1605 | Done | Per-tenant RFC 8555 directory bound to a server profile; http-01 through the service address checks, dns-01; EAB, key-change, revoke, tenant and account isolation. Exprsn-AI's own ACME client obtains certificates from it (http-01 and a dns-01 wildcard). Gaps: dns identifiers only, no ARI, single-vantage validation |
| B-1606 | Done | PEM, DER, chain and PKCS#12 export (checked with OpenSSL); renewal with the same or a new key; notices once at 30 and 7 days |
| B-1607 | Done | `exprsn-ai pki issuers\|list\|issue\|revoke\|crl` and `docs/pki.md` (the `pki` part of B-2103) |
| B-1608 | Done | secp256k1 (signer only; OpenBao transit has none) and P-256; compact low-S signatures; rotation updates the DID document |
| B-1609 | Done | Per-tenant `did:web` or `did:plc` with platform fallback; PLC operations accepted by a directory double. Not yet run against the live PLC directory |
| B-1610 | Done | Signed labeler with `queryLabels` and `subscribeLabels` (cursor replay verified); dismissed flags negate their labels; `negateForFlag` ready for appeals (B-1903) |
| B-1611 | Done | Trusted labelers resolved through the service URL checks; bad labels dropped and audited, good ones become flags |
| B-1704 | Done | Built-in PostgreSQL and MySQL engines; on a real PostgreSQL an expired lease's role is gone after the sweep. MySQL accounts rely on the sweeper for expiry |
| B-1705 | Done | `vault:path#key` in user stores, data connections, MCP tokens and workflow HTTP headers, checked at save and at use. Stores from the configuration file cannot use them |
| B-1706 | Done | Rotation notices for KV secrets; transit keys can rotate themselves |
| B-2003 | Done | Declarative actions gated by grants; webhook actions through the outbound host checks; per-plugin rate and concurrency; loop rule with `PLUGIN_MAX_DEPTH` |
| B-2004 | Done | Script handlers in the container sandbox, platform calls through a per-run scoped token. CI runs handlers as local processes, not containers |
| B-2005 | Done | Plugins from signed import bundles, re-verified at install; scripts only from signed bundles by default. No CLI import yet |

**Sprint 26: done** (81 points), built as four parallel parts with migrations `028_identity`,
`028b_atproto_accounts`, `028c_moderation` and `028d_files`. Unit suite 710 passed, console suite 57 passed; the
PostgreSQL integration tests ran against throwaway servers, MySQL in CI. The Sprint 24 leftovers are closed: the
`secrets` and `users import` CLI commands, and the two places a chat turn waited for a slot it held (a turn now reuses
its own slot for guard-model verdicts, tool-result screens and embeddings).

| Item | Status | Notes |
| --- | --- | --- |
| B-1801 | Done | Self-registration under a per-tenant policy (closed by default, open, approval, domain list); invitations with `members:invite` |
| B-1802 | Done | Single-use verification links; sign-in refused with `email_unverified` when required |
| B-1803 | Done | MFA policy for everyone or chosen roles with a grace period; trusted devices on the device cookie, never for admins (decided at merge) |
| B-1804 | Done | GitHub and GitHub Enterprise Server as an OAuth 2.0 store; organisations and teams become groups. Team changes apply at the next sign-in |
| B-1805 | Done | CSV import of users, memberships and group mappings as a job with a dry run |
| B-1807 | Done | DIDs bound by a profile challenge or a sign-in at the account's server; handles resolved through the service URL checks |
| B-1808 | Done | AT-Protocol OAuth as a client (PAR, PKCE, DPoP with nonces); tested only against a local PDS double, interop with real PDSes unproven; needs a public https issuer |
| B-1901 to B-1907 | Done | Checks with one flag per object, a registry of moderated object types (now including files), reports, appeals that restore objects and negate labels, sanctions enforced on the next request, routed queues with SLA escalation and a dead-letter queue, shadow and enforce external providers, notices |
| B-2401 to B-2405 | Done | Streamed, sealed, scanned files with versions and trash; shares and use-limited links (the platform's BUG-020 fixed); quotas; sandboxed previews; search and folder knowledge sources. Files are moderation objects (wired at merge) |


**Sprint 27: done** (71 points), built as three parallel parts with migrations `029_apps`, `029b_firehose` and
`029c_groups`, merged onto `main` after #32 to #35. Unit suite 750 passed and 1 skipped across 61 files; the PostgreSQL
integration tests (apps, groups and the rest of the suite) ran against throwaway servers, MySQL in CI. Event catalogue
version 3: `record.*`, `app.*` and `group.*` are now emitted. New permissions: `firehose:manage`, `apps:design`,
`records:read`, `records:write`, `groups:read`, `groups:write` and `groups:manage`. Records, groups, group events and
group posts are moderation object types.

| Item | Status | Notes |
| --- | --- | --- |
| B-1908 | Done | Per-tenant Jetstream or relay `subscribeRepos` subscriptions; one consumer per subscription through a lease, bounded queue with backpressure, cursor checkpoints, backoff; posts go through the moderation check and become labels. Tested against local doubles only; relay commits are not signature-verified (known gap) |
| B-2201 | Done | Typed fields, validation; a duplicate unique value is refused, also under a race (SQLite, PostgreSQL) |
| B-2202 | Done | Records sealed with the tenant key; fields marked `indexed` are copied in clear to `app_record_values` for filter, sort, search and aggregation. The same 19 queries return the same rows on SQLite and PostgreSQL; MySQL in CI. CSV import and export as jobs (import limited to about 200 kB in the JSON body) |
| B-2203 | Done | Lookups and a formula parser with no eval; a formula cannot reach a global |
| B-2204 | Done | Per-entity state machine; illegal transitions refused, transitions audited and emitted |
| B-2205 | Done | Forms with conditional fields; public forms keep only listed fields, are rate-limited and pass `user-input` (a held value is refused rather than queued, known gap) |
| B-2206 | Done | Record-event and schedule triggers; a `record` workflow step; chains stop at `APPS_TRIGGER_MAX_DEPTH` |
| B-2207 | Done | AI fields fail soft (a model error leaves the field empty and the record saved); natural-language drafts of entities and flows |
| B-2208 | Done | App design bundles signed with a KMS HMAC key; a tampered bundle is refused. Bundles verify only where the key is shared and carry no records |
| B-2501 | Done | Visibility, open, request and invite joining with expiring requests and invitations, owner, moderator and member roles, a `group` realtime room; a user outside the workspace cannot join |
| B-2502 | Done | IANA zones stored as UTC plus zone, RSVPs with guests and capacity, attendees, check-in; cancelling notifies every attendee in-app and by email. Two simultaneous RSVPs can both take the last place (known gap) |
| B-2503 | Done | `calendar.reminder` queue jobs; two instances on one database send a reminder once (SQLite and PostgreSQL) |
| B-2504 | Done | RFC 5545 feeds per event, group and user (UTC, no VTIMEZONE, no recurrence) at `/calendar/feeds/<id>/<sig>.ics`; HMAC signatures from a derived key, revocable; a bad signature is refused |
| B-2505 | Done | Small sealed group posts; a report on a group post makes a flag and a case |

The order follows the dependencies: the event catalogue (B-2001) before record triggers (B-2206); the moderation API
(B-1901) before the labeler (B-1610), the firehose (B-1908), held replies (B-2302) and the moderation of files,
groups, messages and posts; the file store (B-24) before file fields (B-2201) and message attachments (B-2604); the
generic realtime rooms (B-2101) before any socket feature in B-25 to B-27.

**Before Sprint 24.** Merge `fix/schema-dialects-load-timeout` (JSON Schema 2019-09 and 2020-12 tool schemas,
`OLLAMA_LOAD_TIMEOUT_MS`). Fix the gateway slot deadlock: chat calls `addContext` after `gateway.acquire`, so with one
slot per instance a turn holds the slot while its knowledge embedding waits for it (`server/src/chat/service.ts`).
Build context before the lease, or let embeddings bypass the chat slot.

---

## P0

### B-16 Certificate authority and AT-Protocol trust (76 points)

A platform root CA plus one intermediate per tenant. Private keys are held by the signer process or OpenBao transit
(B-1201, B-408) and never by the app. The same key custody signs AT-Protocol DIDs and labels (from the platform's
atproto module). New permission: `pki:manage`.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-1601 | Issuer hierarchy: root and per-tenant intermediates (EC P-256, RSA 3072) with keys in the signer or OpenBao; rotation and re-issue | An intermediate signs with no private key in the app process | 8 |
| B-1602 | Profiles (server, client, code signing) with SAN, key-usage and lifetime policy; `POST /pki/issuers/:id/issue` from a CSR | A CSR naming a host outside policy is refused | 8 |
| B-1603 | Revocation with RFC 5280 reason codes; a CRL job with numbered versions; public `GET /pki/crl/:issuer.{crl,pem}` | A revoked certificate appears in the next CRL | 5 |
| B-1604 | OCSP responder (RFC 6960 GET and POST), delegated signer, response cache | `openssl ocsp` reports good, then revoked | 8 |
| B-1605 | ACME server (RFC 8555): directory, nonce, account, order, http-01 and dns-01, finalize, revoke, key-change | Exprsn-AI's own ACME client (B-409, B-904) gets a certificate from it end to end | 13 |
| B-1606 | Export (PEM, DER, chain, PKCS#12), renewal, expiry notices at 30 and 7 days | A certificate 7 days from expiry notifies its owner | 5 |
| B-1607 | `exprsn-ai pki` issue, revoke, list and crl; `docs/pki.md` | The CLI issues and revokes against a test database | 3 |
| B-1608 | AT-Protocol signing keys: secp256k1 and P-256 for the labeler and DID rotation, in the signer or OpenBao, never exported | Rotating a key updates the DID document | 5 |
| B-1609 | Service DIDs: `did:web` and `did:plc` per tenant (or platform), `/.well-known/did.json` and `/.well-known/atproto-did`, PLC operations signed by rotation keys | A PLC directory test double accepts the signed operation | 8 |
| B-1610 | Signed labeler: guardrail and flag verdicts mapped to labels (`!hide`, `!warn`, categories), signed with an ordered `seq`, negated when an appeal is upheld (B-1903); `com.atproto.label.queryLabels` and `subscribeLabels` | A subscriber replays labels from a cursor and verifies each signature | 8 |
| B-1611 | Inbound labels: a registry of trusted external labelers; labels verified against the labeler's DID key, then turned into flags | A label with a bad signature is dropped and audited | 5 |

### B-17 Secrets vault (37 points)

Tenant-facing secrets and keys on top of the per-tenant data keys. New permissions: `secrets:read`, `secrets:write`,
`secrets:admin`.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-1701 | Versioned KV secrets by path, sealed with the tenant key; versions, metadata, soft delete and destroy; reveals audited, never logged | Reading version 2 after a write of version 3 returns version 2 | 8 |
| B-1702 | Transit API for tenants: named keys, encrypt, decrypt, rewrap, sign, verify; rotation with a minimum decrypt version | Ciphertext below the minimum version is refused | 8 |
| B-1703 | Policies: path-prefix grants to users, directory groups, workspaces and API keys; deny wins; `explain` names the deciding grant | `explain` shows the deny that blocked a read | 5 |
| B-1704 | Dynamic database credentials as tenant leases: built-in PostgreSQL and MySQL engines that `CREATE ROLE`, grant and drop when OpenBao is not configured (B-416 covers OpenBao); renew, revoke and an expiry sweeper | An expired lease's role no longer exists in the database | 8 |
| B-1705 | `vault:path#key` references in user stores, data connections, MCP credentials and workflow HTTP steps, under the same policies | A reference the caller's policy denies is refused at save and at use | 3 |
| B-1706 | Rotation schedules and expiry notices | A secret past its rotation period notifies its owner | 5 |

### B-18 Identity gaps and AT-Protocol accounts (34 points)

What exprsn-platform's auth module has and Exprsn-AI 1.3.1 still lacks, plus AT-Protocol accounts as a user store.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-1801 | Self-registration with a per-tenant signup policy (closed, domain allow-list, approval); invitations by workspace admins with roles, on top of the admin invite | A signup from a domain outside the list is refused | 3 |
| B-1802 | Email verification for local accounts (signed, single-use link, same templates as reset) | An unverified account cannot sign in when the tenant requires verification | 2 |
| B-1803 | Tenant MFA policy (required for all or for roles, grace period) and an optional trusted-device period that skips the second factor, built on the B-801 device cookie and revoked with sessions | A trusted device skips the factor until its period ends or sessions are revoked | 3 |
| B-1804 | GitHub sign-in: an OAuth2 user store with org and team mapping to roles (Google already works through upstream OIDC) | A team member gets the mapped role | 3 |
| B-1805 | Users, memberships and group mappings as CSV, imported as a job with a dry-run report | A dry run reports conflicts and changes nothing | 3 |
| B-1806 | Email one-time-code factor (P2): enrol and verify, rate-limited and counted in the lockout | A sixth wrong code locks like a wrong TOTP | 5 |
| B-1807 | User DIDs and handles: bind a DID by proof-of-control challenge; handles resolved by DNS and `/.well-known/atproto-did` through the service-URL checks (B-901) | A handle pointing at a link-local address is refused | 5 |
| B-1808 | Sign in with an AT-Protocol account: handle → DID → PDS resolution and AT-Protocol OAuth as a client (PAR, PKCE, DPoP proofs; the server side of PAR and DPoP from B-403 and B-404 is reused); group mapping by DID | Sign-in against a local PDS test double completes with a DPoP-bound token | 10 |

### B-19 Moderation actions and appeals (38 points)

Builds on the guardrails, the flag queue and the holds (B-202, B-704, B-1301) rather than a second engine.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-1901 | `POST /moderation/check` and `/batch` for any object type, deduplicated per object, returning the guardrail verdict and flag | The same object checked twice makes one flag | 5 |
| B-1902 | Reports for any object (messages, posts, files, records), each creating a flag in the right workspace | A report on a file appears in its workspace's queue | 3 |
| B-1903 | Appeals: submit, review, decide; an upheld appeal reopens the flag and reverses the action, all in the audit chain | Upholding an appeal restores the hidden object | 5 |
| B-1904 | User sanctions: warn, suspend or ban with a duration, enforced at sign-in and on every request, lifted by a job | A suspended user's open session is refused on the next request | 5 |
| B-1905 | Routed review queues by rule, label and workspace with SLA timers and escalation; failed moderation jobs to a dead-letter queue with redrive | A flag past its SLA escalates | 5 |
| B-1906 | External moderation providers (off by default) in shadow or enforce mode, only in zones with egress | Shadow mode records a verdict without acting | 5 |
| B-1907 | Notices for decisions, sanctions and appeals through the existing email templates | A sanctioned user receives the notice | 2 |
| B-1908 | AT-Protocol firehose ingest (P1): Jetstream or `subscribeRepos` with a persisted cursor, sampling, collection and author allow-lists, backpressure; posts go through B-1901 and verdicts feed the labeler (B-1610) | A restart resumes from the stored cursor | 8 |

### B-20 Events and plugins (25 points)

A plugin is data (a manifest and its grants), never code loaded into the server. Scripts run in the existing
sandbox, and plugin webhooks use the existing webhook delivery. New permission: `plugins:manage`.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-2001 | A versioned event catalogue: the webhook event groups extended to records, files, groups, messages and posts, with a schema per event type, served at `GET /events/catalogue` | Every emitted event validates against its catalogue schema in tests | 3 |
| B-2002 | Plugin manifests with a closed capability vocabulary; per-tenant installs (installed, enabled, disabled, removed) with audited transitions | A manifest asking for an unknown capability is refused | 8 |
| B-2003 | Declarative actions (log, audit, notify, flag, webhook, start workflow), each gated by a granted capability | An action without its grant is refused and audited | 3 |
| B-2004 | Script plugins: handlers in the sandbox; every platform call brokered through a scoped token checked against the grants | A handler calling an ungranted API gets 403 | 8 |
| B-2005 | Plugins imported through the signed import bundles, with signer, SBOM and licence checks | An unsigned plugin bundle cannot be installed | 3 |

### B-21 Platform core (20 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-2101 | Realtime rooms for the new domains (conversation, group, feed, channel), on the existing server-decided rooms and membership-change handling | Removing a group member closes their room at once | 2 |
| B-2102 | Tenant-scoped read-through cache with TTL tiers, invalidated by bus events; Redis when configured, memory otherwise; hit and miss metrics (replaces the platform's prefetch) | A bus invalidation on one instance clears the entry on another | 5 |
| B-2103 | CLI: `exprsn-ai` pki, secrets, plugins, users import and events replay | Each command runs against a test database | 5 |
| B-2104 | Migrations `026` to `030` in the migration map, expand/contract checked by `migrate --check` (B-1403); `docs/api.md` and an OpenAPI file for every new route | `migrate --check` passes on all three databases | 5 |
| B-2105 | Load test: webhook fan-out, record writes, OCSP and firehose scenarios, with targets in `docs/loadtest.md` | The targets are met on the reference setup | 3 |

## P1

### B-22 Low-code data apps (42 points)

Tenant-scoped apps of typed entities and records, driven by workflows. New permissions: `apps:design`, `records:read`,
`records:write`.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-2201 | Apps per tenant or workspace; entities with typed fields (string, number, date, enum, reference, file, json), validation and uniqueness | A duplicate unique value is refused on all three databases | 8 |
| B-2202 | Records: CRUD, filter, sort, search, pagination, aggregation, bulk writes, CSV import and export as jobs; sealed at rest | The same filter returns the same rows on SQLite, MySQL and PostgreSQL | 8 |
| B-2203 | Lookups (static, entity, user, workspace) and formula fields from a parser with no eval | A formula cannot reach a global | 5 |
| B-2204 | A state machine per entity; transitions audited and emitted as events | An illegal transition is refused | 3 |
| B-2205 | Forms with conditional fields; public forms take only listed fields, are rate-limited and pass the `user-input` guardrail | An extra field in a public submission is dropped | 5 |
| B-2206 | Record-event and schedule triggers; create, update and transition nodes in workflows | A record update starts its workflow | 5 |
| B-2207 | AI fields filled by a profile prompt, failing soft; natural-language drafts of entities and flows from a local model | A model error leaves the field empty and the record saved | 5 |
| B-2208 | Export and import an app as a signed bundle | A tampered app bundle is refused | 3 |

### B-23 Customer-service channels (21 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-2301 | Chat channels: customer sessions (anonymous or identified) bound to a published agent or profile, with their own rate limits and labels | An anonymous customer gets answers within the channel's label | 5 |
| B-2302 | Held replies: an escalation holds the reply as a flag; a reviewer approves, edits or rejects; the customer then receives it | An edited reply reaches the customer as edited | 5 |
| B-2303 | Email channel: inbound by IMAP poll or provider webhook, threaded into sessions; outbound from an SMTP outbox; bounces recorded | A reply in the same thread joins the session | 8 |
| B-2304 | Per-channel retention with purge jobs; transcripts exportable as CSV | A session older than the period is purged | 3 |

### B-24 File store (22 points)

Folders and files on the existing blob store; every upload and restored version goes through the attachment
quarantine, type check and ClamAV.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-2401 | Workspace folders, files, versions with restore (rescanned), trash with a purge job; sealed with the tenant key | A restored version is scanned again | 8 |
| B-2402 | Sharing with users, groups and workspaces, and expiring, use-limited links on the conversation-sharing model (B-305, B-706); downloads audited | A link past its use limit is refused | 3 |
| B-2403 | Per-tenant and per-workspace quotas enforced at upload and shown in usage | An upload over quota is refused | 3 |
| B-2404 | Image and PDF previews by job, sealed like the original and served under the media sandbox (B-413) | A preview carries the sandbox header | 3 |
| B-2405 | Name and tag search; a folder as a knowledge source | Chat cites a file from an indexed folder | 5 |

### B-25 Groups and events (21 points)

Groups live inside a workspace, so workspace membership stays the outer boundary.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-2501 | Groups: visibility, join modes (open, request, invite), requests and invites with expiry, group roles | A user outside the workspace cannot join | 8 |
| B-2502 | Events with time zones, RSVP with guests, attendee list, check-in; cancelling notifies attendees | Cancelling notifies every attendee | 5 |
| B-2503 | Reminders as queue jobs, sent in-app and by email | A reminder fires at its time on a single instance only | 3 |
| B-2504 | iCal per event, group and user through signed feed URLs | A feed URL with a bad signature is refused | 3 |
| B-2505 | Reports and cases on group content through B-19 | A report on a group post makes a flag | 2 |

## P2

### B-26 Messaging (29 points)

Person-to-person messages, sealed at rest so search and summaries keep working. End-to-end encryption is out of
scope.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-2601 | Direct and group conversations with owner, admin and member roles; one direct conversation per pair | A second direct conversation for a pair returns the first | 5 |
| B-2602 | Send, edit, delete, reply, thread, react, pin, forward; edits and deletes audited | A deleted message leaves an audit entry, not its text | 8 |
| B-2603 | Delivery, read receipts, presence and typing over sockets, filtered by blocks on the socket as well as the API (the platform's BUG-080) | A blocked user receives no typing or presence event | 5 |
| B-2604 | Attachments through the quarantine; mute per conversation with notification rules | A muted conversation sends no notification | 3 |
| B-2605 | Keyword and semantic search in a conversation; thread summaries and catch-up digests from a profile | A summary cites only messages the reader can see | 5 |
| B-2606 | Block and contact rules shared with the feed | A block in messaging also hides posts | 3 |

### B-27 Workspace feed (26 points)

A feed for a workspace or group, not a public social network.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-2701 | Posts with media, threaded comments, reactions, reposts and bookmarks; sealed at rest | A comment on a deleted post is refused | 8 |
| B-2702 | Follow, block, mute (shared with B-2606) and lists | A muted author's posts leave the home feed | 5 |
| B-2703 | Home, workspace, group and user feeds with cursor pagination and realtime updates | A new post reaches open feeds without a reload | 5 |
| B-2704 | Posts pass the guardrails before publishing; held posts wait in the flag queue | A held post is invisible until approved | 3 |
| B-2705 | Hashtag extraction and trending by job; a weekly workspace digest written by a profile | The digest lists the week's top posts | 5 |

## Release

| ID | Item | Pts |
| --- | --- | --- |
| B-2801 | Version `1.4.0`, the CHANGELOG, `docs/api.md`, `docs/pki.md` and the known-gaps sections updated as each item lands | — |

---

## Deferred to 1.5 or later

| Item | Why |
| --- | --- |
| Live streaming (ingest, WebRTC rooms, simulcast) | Needs SRS or Cloudflare Stream plus RTMP and TURN infrastructure; about 60 routes on its own |
| AT-Protocol PDS and custom feed generator | Planned for 1.5.0: B-29 and B-30 in [Backlog-1.5.0.md](Backlog-1.5.0.md) (Sprint 31) |
| CalDAV/CardDAV and WebDAV | Planned for 1.5.0: B-31 and B-32 in [Backlog-1.5.0.md](Backlog-1.5.0.md) (Sprint 30) |
| Governance voting | No demand in Exprsn-AI's workspaces yet |
| End-to-end-encrypted messaging | Conflicts with server-side guardrails and AI features |
| SMS one-time codes | Needs a paid SMS provider; scaffolding only in the platform |
| Console screens for the 1.4.0 features | Planned for 1.5.0: B-34 in [Backlog-1.5.0.md](Backlog-1.5.0.md) (Sprints 29 to 31), with permission matrices (B-33) |

Not carried over from the platform: its CA bearer tokens, service-HMAC headers, `PLATFORM_ADMIN_EMAILS` allow-list,
open sockets and dev-only token bypasses.

## Open decisions

- [ ] Team size and the Sprint 24 start date (the plan assumes about five engineers).
- [x] Messaging (B-26) and the workspace feed (B-27) stay in Exprsn-AI, in Sprint 28.
- [x] CA and AT-Protocol key custody: the signer or OpenBao, as planned (Sprint 24; an HSM through PKCS#11 stays
  open). Each tenant gets its own service DID and labeler, with a platform fallback (Sprint 25).
- [x] One intermediate CA per tenant, as the platform's ADR 0003 (Sprint 24).
- [x] Built-in dynamic database credentials need an admin login to each target database: only `connections:manage`
  holders register one, in a zone whose ceiling covers the target database (Sprint 25).
- [x] Customer-service email (B-2303): both IMAP polling and provider webhooks.

## Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Low-code records on three dialects | JSON filters and aggregation differ on SQLite, MySQL and PostgreSQL | A query builder with a tested subset; a PostgreSQL-only fast path behind a flag |
| ACME and OCSP conformance | Clients reject subtle encoding errors | Tests against OpenSSL, certbot and Exprsn-AI's own ACME client in CI |
| AT-Protocol interoperability | The platform's atproto module was unit-tested but never run against the live network; AT-Protocol OAuth needs DPoP and PAR on the client side, which Exprsn-AI only has as a server | Interop tests against a local PDS and the public Jetstream in CI; client-side proofs reuse the B-404 code |
| Event volume | Plugin fan-out and the firehose load the job queue and database | Per-endpoint breakers (already in webhooks), firehose backpressure, the load test (B-2105) before release |
| Gateway slot deadlock | With one slot per instance a chat turn holds the slot while its embedding waits for it | Fixed before Sprint 24 (see above) |
| Platform bugs copied across | Socket delivery ignoring blocks (BUG-080), share-link metadata leaks (BUG-020), `/ca` sockets that accept anyone | B-2603, B-2402 and B-2101 state the fixed behaviour as their test |
| External moderation providers | Content leaves the site | Off by default, only in zones with egress, shadow mode first |
