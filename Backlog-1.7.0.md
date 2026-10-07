# Backlog: 1.7.0

The work after 1.6.0. On 2026-10-05 the owner moved 1.5.0's Sprint 33 here: agents, tools and skills in chat (B-40)
and the second half of the model and dataset import wizard (B-38: datasets, knowledge sets, classifier eval sets and
the Import screen). 1.5.0 keeps what these build on: Workflows 2's agent step and skill loading (B-3902) and built-in
domain tools (B-3904), the chain context (B-4101) and the rest of chaining (B-4102 to B-4109), and the repository
registry, browse and model import (B-3801 to B-3803). On 2026-10-07 the owner added the exprsn-platform port items
decided on 2026-10-06 (B-90 to B-99 and B-112 to B-114, below; the HTTP tool kind is B-89 in 1.6.0). Rules as
before: everything follows `docs/PLAN.md` and `CLAUDE.md`; screens follow `design/prototype/CONTRACT.md` (prototype
board first, then live when every control is backed by the server); every server item ships its routes, permission,
audit events, jobs, tests on SQLite, PostgreSQL and MySQL, `docs/api.md` and `docs/openapi.json` entries and any known
gaps in `docs/security.md`.

**Size.** 63 items, 283 points (1 point ≈ half a day for one engineer, tests included), plus the release item: P1 222,
P2 61. Agents, tools and skills in chat and the second half of the import wizard are 13 items and 72 points; the port
items added on 2026-10-07 are 50 items and 211 points. That is four sprints at the 78-point pace, Sprints 40 to 43
(72, 74, 72 and 65 points). The first of them was numbered Sprint 38 until 2026-10-07, when the 1.6.0 gaps took
Sprints 37 to 39 and this release moved to 40 to 43; 2.0.0 follows at Sprints 44 to 50.

**Builds on.** B-39 Workflows 2 and B-41 chaining (1.5.0), the registry dispatcher and the tool-call guardrail, agent
runs and their budgets, the B-3801 repository registry and B-3803 model import, the 500 GB dataset quota and the
`legal-review` licence exceptions decided on 2026-10-05. The port items build on the B-17 vault and its leases, the
egress guard (`platform/egress.ts`), moderation on guardrails and flags, B-25 groups and events, the B-27 feed and the
B-29 PDS, and on 1.6.0's HTTP tool kind (B-89), per-post visibility (B-4901), groups depth (B-44), MongoDB leases
(B-4802) and legal hold (B-7602).

## Sprints

| Sprint | Theme | Items | Points | Status |
| --- | --- | --- | --- | --- |
| 40 | Agents, tools and skills in chat; dataset import, knowledge sets and the Import screen (Sprint 38 until 2026-10-07) | B-4001–B-4009, B-3804–B-3807 | 72 | Planned |
| 41 | Redis for multi-process installs; workflows calling listed public hosts; the vault's system scope, boot order, hot path, leases and transit HMAC; dynamic API-key leases; held messages; evidence retention and legal hold; the guardrail rule builder | B-9001–B-9002, B-9101–B-9102, B-9201–B-9205, B-9301–B-9302, B-9401–B-9404, B-9501–B-9504, B-9601–B-9602 | 74 | Planned |
| 42 | Sessions, API keys, signing keys and third-party credentials in the vault; groups: bans, invite links, profile fields, search, custom roles, group moderation, event extras, notifications, linked conversations | B-9206–B-9209, B-9701–B-9709 | 72 | Planned |
| 43 | Groups as access subjects; response cache; plugin UI surfaces; `did:exprsn`; cross-posting to the hosted PDS; release | B-9801–B-9805, B-9901–B-9903, B-11201–B-11203, B-11301–B-11302, B-11401–B-11403, B-5901 | 65 | Planned |

The order follows the dependencies: what a conversation may call (B-4001) before any call from chat (B-4002 to
B-4006); the Chat board (B-4007) before the live screen (B-4008); dataset import (B-3804) before knowledge sets and
eval sets (B-3805, B-3806), and all of them before the Import screen (B-3807) goes live, which also gives 1.5.0's
model import its screen. For the port items: Redis as a requirement (B-90) before the vault's bus-invalidated cache
(B-9203); the system scope (B-9201) before everything else in B-92, the generic lease table (B-9204) before API-key
leases (B-93) and before sessions as leases (B-9206), which also wait for the hot path (B-9203) and transit HMAC
(B-9205); the HTTP tool kind's host list (B-8902, 1.6.0) before workflows use it (B-9101); takedown as its own state
(B-9501) before evidence retention (B-9502) and file retention (B-9503); bans and per-group roles (B-9701, B-9705)
and ownerless groups (B-9801) before groups carry access (B-9802 to B-9805); per-post visibility (B-4901, 1.6.0) and
the live PDS run (B-11401) before cross-posting (B-11402).

---

## P1

### B-40 Agents, tools and skills in chat (43 points)

Added 2026-10-05 at the owner's request. Chat today offers only the tools on its profile's list, read-only ones whose
`confirm` is `never`, and only when the model decides to call them; write and destructive tools are left out because
their approval exists only in agent runs; agents run only from the Runs screen; skills reach a model only through an
agent's definition. This epic lets a person call each of them from a conversation, and reuses what already decides
them: the registry's publish and label rules, the dispatcher with the tool-call guardrail and its approvals, agent runs
with their budgets, and skill instructions as agents load them (and as model steps will, B-3902). Every invocation is
audited, metered to the conversation, sealed with the tenant key and labelled at the higher of the conversation's and
the entry's label; nothing runs above the conversation's ceiling or the caller's clearance.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-4001 | What a conversation may call: `GET /api/conversations/:id/capabilities` lists the published agents, tools and skills the caller may use there (tenant, workspace, clearance, the conversation's ceiling, the profile's allow-list), with each tool's input schema and side-effect class | An entry above the conversation's ceiling is never listed, and calling it by name is refused the same way | 3 |
| B-4002 | A person calls a tool: the composer's `/tool` sends arguments (a form from the tool's JSON schema, or text the profile turns into arguments) through the dispatcher and the tool-call guardrail; the call and its result join the conversation as a tool turn the model sees next | A call the guardrail holds shows as held, and runs only when a reviewer approves it in the flag queue | 5 |
| B-4003 | Write and destructive tools in chat, user- or model-proposed, behind an in-chat approval card: write tools run on the caller's own approval, destructive ones and `confirm: always` ones also need the guardrail's approver when a rule says so; denied and expired cards are recorded | A write tool runs only after its card is approved, and a denied card leaves no side effect | 5 |
| B-4004 | `@agent` in a conversation starts an agent run bound to it: input is the message plus, when the person allows it, the recent turns within the agent's label; the run's steps stream into a run card; its answer becomes an assistant turn attributed to the agent; budgets, approvals and cancel as in Runs | A run started from chat shows in Runs with a link back, and cancelling it from the chat stops it | 8 |
| B-4005 | Skills on a conversation: `+skill` adds a published skill's instructions to the conversation's system prompt (sticky until removed, or for one turn), shown as chips; the profile can restrict which skills apply | Removing a skill leaves its instructions out of the very next turn | 3 |
| B-4006 | The model may hand a turn to an agent: agents on a profile's list are offered as tools (`agent:<name>`), run as in B-4004 within the chain's depth and budgets (B-4101) | An agent offered as a tool cannot start itself again past the chain's depth limit | 5 |
| B-4007 | Prototype board for the Chat screen additions: the `/` and `@` and `+` pickers, tool, approval and run cards, skill chips, their states and copy; the smoke run clean | The board passes the prototype smoke run in light and dark | 3 |
| B-4008 | Console: the live Chat screen gets the pickers and cards from B-4007, keyboard-first, with the run card linking to Runs; joins the Playwright suite with axe-core and the reflow checks | An agent run, a held tool call and a skill chip work end to end in the e2e suite with no axe or reflow finding | 8 |
| B-4009 | Chaining in chat, moved here from B-41 with this epic: `/workflow` starts a published workflow from a conversation (a form from its input schema, a run card, its approvals as cards in the conversation); a call held anywhere in a chain started from chat is approved from the root conversation's card (B-4106); a chat run card opens the chain tree (B-4109) | A workflow started from chat pauses on an approval card in the conversation, and approving it there resumes the chain | 3 |

### B-38 Model and dataset import wizard, second half (29 points)

Moved from 1.5.0's Sprint 33 on 2026-10-05; the first half (B-3801 to B-3803: repositories, browse and model import)
ships in 1.5.0. The epic's description, sources and permissions are in [Backlog-1.5.0.md](Backlog-1.5.0.md) (B-38).

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-3804 | Dataset import: configurations, splits, resources and API paging (CKAN datastore, Socrata, SDMX, e-Stat, OGD), schema preview with PII flags, sampling above the quota, scrub and versioning into `training_datasets` | An imported version has a manifest, hash and scrub report identical in shape to an inline one | 8 |
| B-3805 | Knowledge sets: `knowledge_sources.kind = dataset` with column mapping (title, text, metadata), grouping by a column, refresh schedules that follow the publisher, citations back to the row | A monthly SDMX table refreshes on schedule and the index swaps without downtime | 8 |
| B-3806 | Classifier eval sets and imported classifier engines: rows into an eval set with minimum-sample warnings; a text-classification model served by the classifier worker | An imported eval set shows precision and recall per label on the Classifiers screen | 5 |
| B-3807 | Import screen: the wizard, the Imports queue with cancel, retry and logs, the Repositories tab; entry points on Models, Training, Classifiers and Knowledge; Playwright and axe coverage for every state on the board | Every state on the board is reachable in the e2e suite in light and dark | 8 |

## Platform port (decisions of 2026-10-06)

Added 2026-10-07 at the owner's request. The goal (2026-10-06) is every core feature of exprsn-platform in Exprsn-AI,
without the platform's UI or CSS. The gap audit is `docs/exprsn-platform-port-findings.md` (compiled 2026-10-06, kept
outside the repository); the owner answered its 23 decisions on 2026-10-06 (`docs/port-decisions/DECISIONS.md` in that
tree). The to-do ids it uses (VLT-1, GRP-8, MSG-19 and so on) are cited on each item. Most of the port was already done
by 1.4.0 and 1.5.0; these epics are what the owner put in and no backlog had yet: `did:exprsn` (D6a), cross-posting to
the author's hosted PDS repo (D6b), held direct messages (D8), the vault for signing keys and session tokens (D9), a
response cache, a natural-language guardrail builder, plugin UI surfaces and dynamic API-key leases (D11a, b, d, f),
the groups feature set except governance (D13), groups as access subjects (D14), workflows calling listed public hosts
(D15), evidence retention with legal hold (D16) and Redis for multi-process installs (D17). The HTTP tool kind (D11c)
is B-89 in 1.6.0, wanted early. The owner chose to port the response cache, the HTTP tool kind and `did:exprsn`
against the findings' first suggestion; they are built with the constraints the findings set, not re-argued here.

Left out by the same decisions: live streaming (D1), end-to-end-encrypted messaging (D2), CA-signed bearer tokens and
B-5001 (D3), a tenant-wide or public feed (D4), self-serve organizations (D5), cross-posting to an external PDS (the
other half of D6b), group governance until later (D7), hardware key custody and FIPS mode (D10, left open) and IPFS
(D11e). The findings' fix-first defects (F1 to F28) and its deployment to-do lists are not in this backlog; items here
name a defect only where they depend on its fix.

### P1

### B-90 Redis for multi-process installs (5 points)

Decision D17: Redis is required for any install with more than one process, and the server refuses to start without
it. Several correctness properties depend on the bus today (PDS and label delivery, revocation propagation, role and
guardrail-set reloads, the vault cache of B-9203), and a split web and worker install without Redis silently never
delivers worker-made events (findings 4.8 and 6.3).

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-9001 | A start-up check: a server process that finds another live instance heartbeat (B-4202) for the same database, or is configured as a separate worker or with more than one replica, refuses to start without `REDIS_URL` and names why; `/readyz` fails when Redis is configured and unreachable (DEP-25) | A second process started against the same database without Redis exits with the reason, and a replica cut off from Redis turns unready | 3 |
| B-9002 | `docs/deploy.md` states the requirement for bare metal, Compose and the chart; PDS and label streams poll the database behind the bus, so a lost bus message is delivered late, not never (PDS-4, now a safety net) | A label made in a worker reaches a subscriber on another process within one poll interval with the bus message dropped | 2 |

### B-91 Workflows calling listed public hosts (5 points)

Decision D15: workflow HTTP steps may call hosts a tenant admin has listed, and PATCH and DELETE join GET, POST and
PUT (APP-9), with credentials as vault references (VLT-9). Today HTTP steps call internal hosts only
(`workflows/http.ts`) and only the `Authorization` header must be a vault reference.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-9101 | Workflow HTTP steps may call public hosts on the tenant's list of allowed public hosts (the list B-8902 adds for HTTP tools), still through the egress guard (resolved once, pinned, redirects to unlisted hosts refused); PATCH and DELETE added, both treated as writes by the retry warnings (`workflows/retry.ts`); a host removed from the list fails the next step that calls it | A step to a listed public API succeeds, the same step to an unlisted host is refused with the host named, and a DELETE step warns on retry | 3 |
| B-9102 | Every secret-bearing header, query parameter and body field of an HTTP step is a vault reference, not only `Authorization` (VLT-9); saving a step or importing a bundle with a literal secret-looking value is refused | Saving a step with a literal `X-Api-Key` is refused, and the same header as a vault reference runs | 2 |

### B-92 The vault for signing keys and session tokens (52 points)

Decision D9: the vault becomes the store of record for signing keys and session tokens (VLT-1 to VLT-8 and VLT-10;
VLT-2 and VLT-6 first). Today sessions, API keys, app passwords and link tokens are HMAC columns under one static
`SESSION_SECRET` with no rotation path (defect F21); signing keys (OIDC, SAML, webhook, CA and OCSP, ACME, AT-Protocol,
PDS) are database rows sealed with the data key or signer-wrapped blobs; third-party credentials are sealed outside the
vault; and the vault has no platform scope, so every caller must be a user in a tenant. The key-encryption key
(`DATA_KEY`, the signer or OpenBao) stays outside: the vault is sealed under it. Sessions as leases put the vault on
every request, so the read path is cached and invalidated over the bus, which needs Redis with more than one process
(B-90).

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-9201 | A platform (`sys/`) scope and a `service` subject, so internal callers read without a user; path policies, explain and audit apply; tenants never list or read `sys/` (VLT-1) | The OIDC provider reads a `sys/` key as the service subject, and a tenant admin's listing does not show it | 5 |
| B-9202 | Boot order: configuration, database, KMS, data keys, the vault's system scope, sessions and API keys, then the authentication middleware; a vault that cannot open fails closed at a named step (VLT-6) | A server whose KMS is unreachable stops at the named step and serves no authenticated route | 2 |
| B-9203 | A hot-path read: an in-process cache for `sys/` and lease reads, invalidated over the bus, and audit aggregated per subject and minute instead of one append per read (VLT-2) | A session check is one indexed lookup with a warm cache, and a revoked lease is refused on every instance within one second | 5 |
| B-9204 | A generic lease table generalised from the PostgreSQL, MySQL and MongoDB (B-4802) leases: idle timeout as the renew period, absolute lifetime as the maximum, revoke and sweep (VLT-4) | A lease idle past its renew period is refused and swept, and renewing past its maximum is refused | 5 |
| B-9205 | Transit HMAC with key versions (verify under the current and the previous version); the 18 `SESSION_SECRET` derivations (sessions, CSRF, API-key digests, recovery codes, DAV and PDS app passwords, PDS JWTs, file links, feed and calendar signatures) move to named keys, the rotation path F21 lacks (VLT-3) | Rotating the session key keeps existing sessions, app passwords and file links valid until the previous version is retired | 8 |
| B-9206 | Sessions and API keys stored as leases that hold only verifiers, keeping the single indexed lookup per request, with a dual-read migration from `sessions` and `api_keys` (VLT-5) | After the migration an existing session still works, a new one is a lease, and signing out revokes it | 8 |
| B-9207 | Transit keys backed by the signer or OpenBao, then the OIDC, SAML, webhook, CA and OCSP, ACME, AT-Protocol and PDS signing keys registered as vault keys; never moved into today's in-memory transit, which would weaken signer isolation (VLT-7) | Rotating the OIDC signing key from the Vault screen publishes the new key in JWKS, and tokens signed before still verify until they expire | 8 |
| B-9208 | Sealed third-party credentials (webhook secrets, MCP tokens, connections, registry tool tokens, moderation provider keys, channel secrets, knowledge source credentials) move to vault paths with references created automatically, so path policy, versions, rotation notices and reveal audit apply (VLT-8) | After the migration no third-party secret is held outside the vault, and revealing an MCP token is audited | 8 |
| B-9209 | Workspace or service ownership of references, so disabling the user who saved a reference does not break the integrations that use it (VLT-10) | Disabling the admin who set up a connection leaves the connection working | 3 |

### B-94 Held messages for review (13 points)

Decision D8: direct messages are still screened at send, and a held verdict goes to a review queue instead of becoming
a refusal (MSG-19, built with MOD-3). Today only feed posts can be held; every other write a rule would hold is
refused with a 422 and no flag, and a guard-model outage refuses or stalls every message, because model-backed rules
fail closed (findings 4.1 and 4.5). Public form values are held by B-4701 (1.6.0).

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-9401 | A held verdict on a direct or group message, or an edit, stores it sealed as held, visible only to its sender as "held for review", and files a flag in the moderation queue; accepting delivers it with its original time and notifies the conversation, rejecting tells the sender; `block` verdicts still refuse (MSG-19) | A held message is invisible to the other members until a reviewer accepts it, then arrives once | 5 |
| B-9402 | The same hold for group posts, feed comments and their edits, the other writes that can wait (MOD-3; forms are B-4701, feed posts are held already) | A held group post appears in the moderation queue and, once accepted, in the group feed | 3 |
| B-9403 | Guard-model outage: a send while a model-backed rule is unavailable is held, not refused, and a job re-screens held items when the guard answers again, delivering those that pass; nothing is released without a fresh verdict | With the guard model stopped, messages queue as held, and when it returns the clean ones are delivered without a reviewer | 3 |
| B-9404 | Console: Messages and feed show the sender a held message with withdraw; the Moderation queue shows held messages with their conversation's context at the reviewer's clearance; their specs with axe-core and the reflow checks | A reviewer accepts a held message from the queue and the sender's view updates live | 2 |

### B-95 Evidence retention and legal hold (13 points)

Decision D16: moderated objects are kept until the case and its appeal close, plus legal hold (MOD-16 and FIL-14,
extending the messaging legal-hold export of B-4206). Today a takedown of a file is an ordinary trash entry, so a
workspace member can restore it or empty the trash and destroy the evidence (defect F5), and taken-down files are
purged with the trash. Legal hold on users and workspaces is B-7602 (1.6.0); this epic adds cases and single objects.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-9501 | Takedown as its own state, separate from trash: a taken-down file cannot be restored or purged from the trash by workspace members; only the moderation decision lifts it (FIL-1, defect F5) | A member with write access can neither restore nor purge a taken-down file, and the attempt is audited | 2 |
| B-9502 | Evidence retention: a hidden or taken-down object, its versions and its flag's content are kept until the case and any appeal close, whatever the object's own retention, then fall back to it; purge jobs skip them and record why (MOD-16) | A message taken down in a case survives its conversation's retention purge until the appeal closes | 5 |
| B-9503 | File retention and a version cap per workspace that honour holds (FIL-14) | A workspace capped at 10 versions keeps the newest 10 of each file, except files under hold | 3 |
| B-9504 | Legal hold on a moderation case or a single object, under dual control, on B-7602's hold, with B-4206's legal-hold export extended to a case's objects | A held case's objects survive every purge, and exporting them needs a second approver | 3 |

### B-97 Groups: the rest of nexus (45 points)

Decision D13: every groups feature of exprsn-platform's nexus except governance (GRP-8 to GRP-16, GRP-18, GRP-19 and
GRP-21). B-44 (1.6.0, Sprint 36) already covers subgroups and channels (GRP-14), discovery, recommendations,
locations and trending (GRP-13) and categories (GRP-11); this epic is the rest. Governance (GRP-17, decision D7) waits
for a later release. Each item ships its Groups and events screen changes with their specs.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-9701 | Group ban and suspend, enforced in join, invitations and request decisions (GRP-8) | A banned member cannot rejoin an open group or be invited back until the ban ends | 5 |
| B-9702 | Invite links and codes with a use limit and an expiry; a message on requests and invitations, screened by the guardrails (GRP-9) | An invite link with a limit of 3 admits three people and refuses the fourth | 5 |
| B-9703 | Profile fields: tags, avatar and banner through the file store, website, an enforced member limit (GRP-10) | A group at its member limit refuses the next join and request | 3 |
| B-9704 | Search and paging on groups, members and attendees (GRP-12; B-4402's discovery page uses it) | Searching a 5,000-member group's members returns pages in a stable order | 3 |
| B-9705 | Per-group custom roles and permission flags, with admin and guest tiers beside owner, moderator and member (GRP-15) | A custom role with "create events" but not "post" can do the one and not the other | 8 |
| B-9706 | Group moderators act on cases (confirm, dismiss, hide, warn, suspend, ban) with assignment and appeals routed to the group's moderators (GRP-16) | A report on a group post reaches that group's moderators, and their ban is enforced | 5 |
| B-9707 | Event extras: a waitlist with promotion, an RSVP deadline, approval-required RSVPs, type and virtual URL, per-event visibility, drafts (GRP-18) | When a "going" place frees up, the first on the waitlist is promoted and notified | 8 |
| B-9708 | Notifications for reschedules, new events, member and role changes, and "notify attendees" (GRP-19) | Rescheduling an event notifies its attendees once, and never one who has lost access | 3 |
| B-9709 | A group-to-conversation link, with the conversation's membership following the group's (GRP-21) | Leaving the group removes the member from the linked conversation | 5 |

### B-98 Groups as access subjects (17 points)

Decision D14: a social group is a grant subject for files, vault paths and knowledge, and a scope for low-code apps
(GRP-22). Group owners then control access to data, so ownerless groups (GRP-6), bans (B-9701) and per-group roles
(B-9705) land first. A grant never lifts a member above their clearance or the object's label, and leaving a group or
being banned ends the access at once.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-9801 | Ownerless groups and departed members: owners counted by active membership, the tenant admin offered ownership when the last owner leaves, departed users filtered from member lists and notices (GRP-6, part of defect F23) | A group whose only owner is disabled can be administered again, and the departed owner receives no notices | 3 |
| B-9802 | A social group as a grant subject for files and folders, beside users, directory groups and workspaces | A folder granted to a group is readable by its members and by no one who leaves it | 3 |
| B-9803 | A social group as a subject of vault path grants, deny-wins, with explain naming the group | Explain shows the group grant that lets a member read a secret | 3 |
| B-9804 | A social group as a reader or editor of a knowledge base | A group member searches the knowledge base; a former member's search no longer returns it | 3 |
| B-9805 | Groups as a scope for low-code apps: an app or entity visible to a group's members, with app roles mapped from group roles (B-9705) | A record in a group-scoped app is listed only to that group's members | 5 |

### P2

### B-93 Dynamic API-key leases (8 points)

Decision D11f: port exprsn-platform's dynamic API-key secrets as a new lease engine on the generic lease table
(B-9204). Today dynamic credentials exist for PostgreSQL and MySQL (and MongoDB with B-4802) only.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-9301 | An `apikey` lease engine: a role names a scope set and a lifetime; reading its credential path issues a fresh scoped Exprsn-AI API key whose life is the lease's, revoked when the lease ends or is revoked; workflows, agents and plugins read it by vault reference | A key issued from a lease stops working the moment the lease is revoked, and its scopes never exceed the role's | 5 |
| B-9302 | Outside providers: a provider interface (create key, revoke key) called through the egress guard with the provider's admin credential as a vault reference, one reference provider and a fake in the suite; leases listed with revoke on the Vault screen | The sweeper revokes an expired lease's key at the provider, and the fake records the revoke | 3 |

### B-96 Natural-language guardrail builder (5 points)

Decision D11b: port cortex's natural-language guardrail builder by reusing the low-code draft assistant (B-2207,
`apps/drafts.ts`); a drafted rule starts in shadow mode. Rule sets already have versions, shadow mode, replay and dual
control.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-9601 | Draft a rule from a description: the description passes the profile's guardrails, the draft is validated with the rule schema, shown as a diff against the rule set, and saved only in shadow mode | A rule drafted from "hold answers that quote a card number" validates, saves in shadow and blocks nothing until promoted | 3 |
| B-9602 | The Guardrails screen's "Describe a rule": the draft diff, a replay of the shadow rule against recent traffic, and promotion under the existing dual control; its specs with axe-core and the reflow checks | A drafted rule is replayed and promoted from the screen with a second approver | 2 |

### B-99 Response cache (10 points)

Decision D11a: port cortex's response cache. The findings' constraints: the cache key includes the tenant, the label
and the guardrail set's version, and entries are sealed. Exprsn-AI has no answer cache today.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-9901 | An exact-match cache for chat and `/v1` turns, opt-in per profile: the key hashes the tenant, the workspace, the conversation's label, the profile and its version, the model and its digest (or the server's model id), the guardrail set's version, the parameters and the whole message list; entries sealed with the tenant key and given a TTL; turns with tool calls, attachments or a temperature above zero are not cached unless the profile says so | The same question in two tenants never shares an entry, and changing the guardrail set misses the cache | 5 |
| B-9902 | A hit still passes the user-input checkpoint, is metered as a cache hit with no model tokens and is audited; entries are never served above the caller's clearance; purge per tenant, profile or entry | After a purge of a profile's entries, its next turn reaches the model | 3 |
| B-9903 | Console: the cache switch and TTL on Profiles; hit rate and purge on the cache tab of Jobs and queues (B-4203); their specs with axe-core and the reflow checks | A purge from the console is audited and the profile's hit rate drops to zero | 2 |

### B-112 Plugin UI surfaces (14 points)

Decision D11d: plugins may add UI surfaces to the console (PLG-9), which needs a rendering design under the console's
content-security policy first. Plugins today are declarative, webhook or script handlers with strict manifests,
fourteen capabilities with risk classes and audited installs; none renders anything.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-11201 | A prototype board and a decision record for rendering plugin UI under the console's CSP: a sandboxed iframe on a separate origin with a narrow `postMessage` bridge, or declarative surfaces from a schema the console renders; the surfaces offered (a settings panel, a side panel on a record, conversation or file, a dashboard card) | The board passes the prototype smoke run, and the record names every CSP directive that changes | 3 |
| B-11202 | Manifest `ui` surfaces: each declares where it appears and which of the plugin's granted capabilities its bridge may call; the bridge enforces them with the viewer's permissions and labels and never hands the plugin the session; a tenant admin approves each surface at install | A surface calling a capability its plugin was not granted is refused, and a surface never reads data above the viewer's clearance | 8 |
| B-11203 | The console hosts the surfaces on the screens they name, keyboard reachable, disabled per surface from Plugins and events; axe-core and the reflow checks on a fixture plugin's surfaces | The fixture plugin's settings panel and record side panel render with no axe or reflow finding, and disabling one removes it at once | 3 |

### B-113 `did:exprsn` (8 points)

Decision D6a: port exprsn-platform's `did:exprsn`, its self-certifying DID method (the `did:exprsn` half of PDS-21);
the platform minted one per user and resolved it offline. The platform derived every user's DID from one secret
(`ATPROTO_USER_DID_SECRET`, whose change re-keys every DID); Exprsn-AI holds a key per account in the signer, as it
does for AT-Protocol account keys, and does not copy the derivation.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-11301 | The `did:exprsn` method: a DID derived from an account's public key held by the signer, resolvable offline; `com.exprsn.identity.resolveDid` and the server's DID resolver resolve it beside `did:plc`, `did:web` and `did:key`; the method written up in `docs/identity.md` | A `did:exprsn` resolves offline to a document whose key verifies the account's signature, and no shared secret is read to derive it | 5 |
| B-11302 | Per-user DIDs minted on first use and listed for the user, linked to their hosted PDS `did:plc` through `alsoKnownAs` where they have one; labels and service-auth tokens signed under a `did:exprsn` verify; interop vectors from the platform's resolver | A user's `did:exprsn` names their PDS DID, and a label they signed verifies | 3 |

### B-114 Cross-posting to the author's hosted PDS repo (16 points)

Decision D6b: public feed posts can be cross-posted to the author's repo on Exprsn-AI's own PDS (FEED-13); the
external-PDS half of PDS-21 is not built, and the feed itself stays workspace and group only (D4). It needs a post to
be marked public, which per-post visibility (B-4901, 1.6.0) supplies, and the PDS reachable by a relay (PDS-5), which
has never been run against live infrastructure.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-11401 | The PDS against live infrastructure (PDS-5): the PLC directory, a relay crawl (`PDS_RELAYS` with a documented default) and the public AppView indexing a test account, with the public HTTPS host and wildcard DNS it needs in `docs/deploy.md`; the cursor-after-trim fix first (PDS-1, defect F8) | A test account's post written on the PDS is shown by the public AppView after a relay crawl | 5 |
| B-11402 | Cross-posting: an author who opts in has each post marked public written as an `app.bsky.feed.post` record in their hosted repo (text, facets, images as blobs with alt text, a link back), edits and deletes mirrored; workspace and unlisted posts, and anything labelled above public, are never written | A public post appears in the author's repo, deleting it deletes the record, and a workspace post is never written | 8 |
| B-11403 | Only posts that passed the feed's checks cross-post (a held post once accepted); a hide or takedown deletes the record and emits the takedown label; the composer's cross-post switch and a per-post status on Messages and feed, with their specs and axe-core and the reflow checks | A post taken down in Moderation disappears from the author's repo | 3 |

## Release

| ID | Item | Done when |
| --- | --- | --- |
| B-5901 | Version `1.7.0`, the CHANGELOG, `docs/api.md`, `docs/permissions.md`, `docs/accessibility.md` and the known-gaps sections updated as each item lands; the full Playwright suite run locally at the end of the release, its findings fixed and the cross-screen sweeps (`a-first-look`, `zz-every-screen`, `y-accessibility`, `y-reflow`, `y-reflow-overlays`) green (owner, 2026-10-06: sprints run only the specs of the screens they change) (Sprint 43; Sprint 38 until 2026-10-07) | The full Playwright suite passes locally and in CI |

## Still deferred

| Item | Why |
| --- | --- |
| Server log view in the console (B-57) | 1.7 or later per the platform administration decisions; traces and metrics only for now |
| Group governance: proposals, voting, quorum (GRP-17) | Port decision D7: 1.7 or later; not placed in Sprints 40 to 43 and still without an id |

## Open decisions

- [ ] Plugin UI surfaces (B-11201): a sandboxed iframe on a separate origin or declarative surfaces the console renders?
  The board and decision record are the epic's first item.
- [ ] Sessions as leases (B-9206): migrate every install in 1.7.0 with the dual read, or keep the `sessions` table as an
  option for single-process installs?

## Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Chat calls write tools | A person approves an action they did not read | Approval cards show the tool, its side-effect class and the exact arguments; destructive tools follow the guardrail's approver rules (B-4003) |
| Dataset sources change shape | Imports and refreshes break on a publisher's schema change | Schema preview on every version, refresh jobs that fail soft and keep the last good version (B-3804, B-3805) |
| Vault on every request | Sessions as leases (B-9206) make a slow or unavailable vault an outage | The hot-path cache (B-9203), a single indexed lookup, Redis required for more than one process (B-90), and a fail-closed boot order (B-9202) |
| Response cache | A cached answer crosses a tenant, a label or a changed guardrail set | Tenant, label and guardrail-set version in the key, entries sealed with the tenant key, opt-in per profile (B-9901) |
| Groups carrying access | A group owner widens who reads files, secrets or knowledge | Grants never exceed a member's clearance or the object's label, bans and per-group roles first, explain names the group (B-98) |
