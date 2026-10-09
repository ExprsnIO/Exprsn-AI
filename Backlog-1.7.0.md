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

**Size.** 77 items, 350 points (1 point ≈ half a day for one engineer, tests included), plus the release item: P1 257,
P2 93 (B-117, B-119 and B-122 counted since 2026-10-09; the 240-point governance set below still lists B-117 and B-119). Agents, tools and skills in chat and the second half of the import wizard are 13 items and 72 points; the port
items added on 2026-10-07 are 51 items and 216 points (B-122 added 2026-10-09). That is five sprints, Sprints 40 to 44
(72, 68, 60, 76 and 74 points; re-planned by usage on 2026-10-09). The first of them was numbered Sprint 38 until 2026-10-07, when the 1.6.0 gaps took
Sprints 37 to 39 and this release moved to 40 to 43; 2.0.0 follows at Sprints 45 to 51. Unscheduled beside them, added
2026-10-07: governance, thinking, learning, skills from knowledge, classification and moderation (B-115 to B-121,
below), 52 items and 240 points, about three more sprints; where they go is an open decision.

**Builds on.** B-39 Workflows 2 and B-41 chaining (1.5.0), the registry dispatcher and the tool-call guardrail, agent
runs and their budgets, the B-3801 repository registry and B-3803 model import, the 500 GB dataset quota and the
`legal-review` licence exceptions decided on 2026-10-05. The port items build on the B-17 vault and its leases, the
egress guard (`platform/egress.ts`), moderation on guardrails and flags, B-25 groups and events, the B-27 feed and the
B-29 PDS, and on 1.6.0's HTTP tool kind (B-89), per-post visibility (B-4901), groups depth (B-44), MongoDB leases
(B-4802) and legal hold (B-7602).

## Sprints

| Sprint | Theme | Items | Points | Status |
| --- | --- | --- | --- | --- |
| 40 | Agents, tools and skills in chat; dataset import, knowledge sets and the Import screen (Sprint 38 until 2026-10-07) | B-4001–B-4009, B-3804–B-3807 | 72 | **Done** |
| 41 | Thinking policy, budgets, plans and reflection; skills from knowledge; the vault's system scope and hot path; the guardrail rule builder; standing MCP approvals (re-planned by usage on 2026-10-09) | B-11701–B-11706, B-11708, B-11901–B-11902, B-11906, B-9201, B-9203, B-9601–B-9602, B-12201 | 68 | **Partly done** (42 of 68 points; B-9201, B-9203, B-11901, B-11902, B-11906 not started) |
| 42 | The vault for signing keys and session tokens; Redis for multi-process installs; workflows calling listed public hosts; dynamic API-key leases | B-9202, B-9204–B-9209, B-9001–B-9002, B-9101–B-9102, B-9301–B-9302 | 60 | Planned |
| 43 | Groups: the rest of nexus; groups as access subjects; skills from knowledge, second part | B-9701–B-9709, B-9801–B-9805, B-11903–B-11905 | 76 | Planned |
| 44 | Held messages for review; evidence retention and legal hold; response cache; plugin UI surfaces; `did:exprsn`; cross-posting to the hosted PDS; release | B-9401–B-9404, B-9501–B-9504, B-9901–B-9903, B-11201–B-11203, B-11301–B-11302, B-11401–B-11403, B-5901 | 74 | Planned |

**Usage review (2026-10-09).** The live install (one host, one server process, four users, two workspaces) shows
where the work goes: 142,813 embedding calls in 30 days over 8 knowledge bases and 170,191 documents against 21
conversations, 11 of them on the `think` profile; 40 workflows and 366 runs, 304 of them one scheduled trigger; 6 MCP
servers with 151 write-call approvals in a week; 249 registry entries; `vault.secret.read` the most frequent audit
action (328 a week); 6 guardrail rule sets with real block and redact decisions. It shows no direct messages, feed
posts, moderation reports, flags, legal holds, webhooks, HTTP tool calls, workflow HTTP steps, database leases or
second server process (Redis is configured but one process runs), and 3 API keys. Sprint 41 was re-planned around
that: thinking (B-117, less the done B-11707), the first part of skills from knowledge (B-119), the vault's system
scope and hot path (B-9201, B-9203), the rule builder (B-96) and a new epic for MCP approval ergonomics (B-122), with
the rest of the port items moved to Sprints 42 to 44 in dependency order. Every moved item keeps its text. The
placement question for B-115 to B-121 (Open decisions) is partly answered: B-117 and B-119 are scheduled by usage;
B-115, B-116, B-118, B-120 and B-121 stay unscheduled.

### Progress

**Sprint 41: partly done** (this PR; 42 of 68 points, the owner's choice). Standing approvals for MCP write calls
(B-12201, migration `043_mcp_standing_approvals`), the guardrail rule builder (B-9601, B-9602) and thinking policy,
budgets, plan first, reflection, step levels and evaluations with their screens (B-11701 to B-11706, B-11708, migration
`043c_thinking`). Not started: B-9201, B-9203 (vault system scope and hot path) and B-11901, B-11902, B-11906 (skills
from knowledge, first part); they stay in Sprint 41 until the owner moves them. Unit suite 1209 passed; PostgreSQL
integration passed; prototype smoke 51 of 51; touched specs passed (27). Choices to know: the person grants standing
approvals for their own client and an identity admin lists and revokes them tenant-wide; drafting a rule needs
`inference:invoke`, which `guardrail-admin` does not hold; plan first fails open when the draft cannot be parsed. Known
gaps in `docs/security.md`.

**Sprint 40: done** (PR #74). Agents, tools, skills and workflows in chat (B-4001 to B-4009, migration
`042_chat_invocation`): the capabilities of a conversation, `/tool` through the dispatcher and the tool-call guardrail
with held calls in the Flags queue, approval cards for write and destructive tools, `@agent` runs with run cards and
attributed answers linked from Runs, `+skill` chips, agents as `agent:<name>` tools within the chain, `/workflow` with
approval cards; the Chat board and live screen. Dataset import, knowledge sets, eval sets and the Import screen
(B-3804 to B-3807, migration `042b_dataset_import`): streaming readers for CKAN, Socrata, SDMX, e-Stat, OGD, OpenML,
InvenioRDM and Hugging Face datasets, PII-flagged previews, sampling, scrub and versioning; dataset-backed knowledge
sources with schedules, citations and a serving refresh; eval sets and the `imported` classifier engine; the Import
screen with its wizard, queue and repositories, and entry points on four screens. Unit suite 1191 passed; PostgreSQL
integration passed; prototype smoke 51 of 51; the touched screens' specs passed (21). Choices to know: write tools are
now offered to the model in chat and always held for the person; a model-proposed card is decided after the answer;
handoff answers are awaited for `CHAT_AGENT_WAIT_SECONDS`; a licence the requester records counts only when the source
states none; the `imported` engine is created only through the import path. Known gaps in `docs/security.md`: free
text becomes arguments through one model turn; Parquet, Excel and archives are not read (Kaggle imports nothing yet);
no pinned source revision; importing twice doubles an eval set; refresh reads the whole source; the classifier worker
protocol is this server's own and no reference worker ships.

The order follows the dependencies: what a conversation may call (B-4001) before any call from chat (B-4002 to
B-4006); the Chat board (B-4007) before the live screen (B-4008); dataset import (B-3804) before knowledge sets and
eval sets (B-3805, B-3806), and all of them before the Import screen (B-3807) goes live, which also gives 1.5.0's
model import its screen. For the port items: the vault's bus-invalidated cache (B-9203, Sprint 41) runs on the bus the single-process
install has today and Redis as a requirement (B-90, Sprint 42) hardens it for more than one process; the system scope (B-9201) before everything else in B-92, the generic lease table (B-9204) before API-key
leases (B-93) and before sessions as leases (B-9206), which also wait for the hot path (B-9203, Sprint 41) and transit
HMAC (B-9205), so the rest of the vault chain stays whole in Sprint 42; thinking templates (B-11707, 1.6.0) before the
thinking policy and plans (B-117, Sprint 41); a skill that names knowledge (B-11901) before drafting one from a base
(B-11902) and both before staleness, evaluation and packs (B-11903 to B-11905, Sprint 43); held messages (B-94) and
evidence retention (B-95) wait in Sprint 44 for a usage trigger: build them when messaging or moderation is in use,
and the owner may drop them; the HTTP tool kind's host list (B-8902, 1.6.0) before workflows use it (B-9101); takedown as its own state
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

### B-122 MCP approval ergonomics (5 points)

Added 2026-10-09 from the usage review: the owner approves about 151 MCP write calls a week by hand, and Sprint 37b's
known gap says write calls over MCP need a browser approval each time. A standing approval keeps the audit and the
label rules and removes the repeated click.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-12201 | Standing approvals for MCP server write calls: a tenant admin grants a connected client a standing approval per tool (or per server) for a period, under the same label rules; each call is still audited and metered, the approval is revocable from the MCP access screen and expires on its own; the Flags queue still holds calls a guardrail rule holds | A client with a standing approval runs a write tool without a browser approval, and revoking it makes the next call wait again | 5 |

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

## Governance, thinking, learning and classification (2026-10-07)

Added 2026-10-07 at the owner's request: governance, thinking, learning, skills from knowledge, classification and
moderation. The same day the owner built three governance and moderation profiles on their own install (`moderate`,
`appeal` and `govern` on Magistral, thinking high, with hand-written skills, agents, five read-only moderation tools
and a Moderation knowledge base holding four starter policies: a governance charter, community guidelines, a
moderation playbook and an appeals procedure). That build-out shows what the platform lacks: the policies are prose
in a knowledge base that nothing enforces; the skills were written by hand beside the base they describe; a reviewer
works flags one by one with no case; the tenant's safety rule set blocks a reviewer discussing a policy's own
categories; Magistral thinks only with a hand-written prompt convention and fails the tool-calling evaluation; and
nobody can tell an answer it was wrong. Each epic here closes one of those gaps and the ones next to it, on the seams
that already decide things: labels and clearances, publish checks and dual control, the guardrail checkpoints, the
registry, the chain context, the flags queue and the audit chain.

**Size.** 52 items, 240 points: B-115 AI governance (41), B-116 group governance (23), B-117 thinking (34), B-118
learning (38), B-119 skills from knowledge (30), B-120 classification (36) and B-121 moderation (38). Unscheduled:
three sprints at the 78-point pace, split by dependency below; where they go (two or three more sprints in 1.7.0
with 2.0.0 moving, or the first sprints of a 1.8.0) is an open decision. The priorities below are a proposal.

**Proposed split.** A: governance and moderation, B-115, B-121 and B-11707 (81 points). B: classification, skills from
knowledge and the thinking policy and budgets, B-120, B-119, B-11701 and B-11702 (74 points). C: plans, reflection,
learning and group governance, the rest of B-117, B-118 and B-116 (85 points). The order follows the dependencies:
policy documents (B-11501) before guidelines as reason codes (B-12104); the inventory (B-7301, 1.6.0) before risk
tiers and reviews (B-11503, B-11505); cases (B-12101) before assisted review and strikes (B-12103, B-12106); taxonomies
(B-12002) before classification on write and search by finding (B-12001, B-12006); the review band (B-12004) before
active learning (B-11806); a skill naming knowledge (B-11901) before drafting one (B-11902); feedback (B-11801)
before the rest of B-118; the thinking policy (B-11701) before plans and reflection show thinking (B-11703, B-11704);
per-group roles and bans (B-9705, B-9701) before proposals execute (B-11604).

**Builds on.** The B-73 inventory, B-75 compliance export and B-76 DLP (1.6.0); access reviews (B-3305); the registry's
publish checks, skill closure (B-4103) and signed bundles (B-3909); the chain context (B-4101); profile evaluations and
their gate (Sprint 21); the `memory` checkpoint and memory proposals (B-37); the training scrub and worker (Sprint 9);
classifiers and their publish rule (Sprint 5, B-88); moderation queues, appeals and providers (B-19, B-3405), held
items (B-4701, B-94), evidence retention (B-95) and group moderation (B-9706); the draft assistant (B-2207) and the
guardrail rule builder (B-96); groups depth (B-44) and the rest of nexus (B-97).

### P1

### B-115 AI governance: policies, register, reviews and exceptions (41 points)

Governance today is spread over seams that each decide one thing: labels and clearances, a profile's allow-lists and
ceilings, publish checks and dual control on models, profiles, overrides and exports, access reviews over the
permission matrix (B-3305), the audit chain with its signed checkpoints and, in 1.6.0, the AI inventory (B-73), the
compliance export (B-75) and DLP (B-76). No one place states a tenant's AI-use policy, records who owns each AI
system and at what risk, grants a time-boxed exception, or shows which control is met by what evidence. The owner's
charter, guidelines, playbook and appeals procedure (2026-10-07) are prose in a knowledge base; this epic makes such
documents records the server enforces where it already decides, and reviews them from one screen.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-11501 | Policy documents as records: charter, guidelines, playbook and procedures per tenant with workspace overrides, versioned, with an owner, an effective date and dual-control publish; a published version is indexed into a knowledge base of the tenant's choosing by itself (the Moderation base is filled by hand today) and cited by the governance profiles | Publishing a new charter version re-indexes the base, and a profile's next answer cites the new version, not the old one | 5 |
| B-11502 | An AI-use policy per tenant: which model families, servers (`openai` instances, cloud backends when 2.0.0 adds them) and labels may serve which purposes and roles, which tool side-effect classes each role may approve, and which data labels may leave for an outside server; enforced at profile publish, the conversation capability list (B-4001), the dispatcher and the gateway's placement, with `explain` naming the policy line | A profile on an outside server for confidential data cannot be published while the policy forbids it, and explain names the line | 8 |
| B-11503 | Risk tier, purpose, owner and review date on every inventory system (B-7301: models, profiles, agents, skills, workflows, tools, MCP servers, classifiers, datasets); a tier above minimal needs an evaluation set, a named oversight role and a review cadence before publish; a service subject may own a system, and its effective clearance follows its direct value as soon as an admin changes it (today it is recomputed only at sign-in) | A high-tier agent without an evaluation set cannot be published, and a service account's raised clearance applies on its next call | 5 |
| B-11504 | Exceptions: a time-boxed exemption from a policy line or a publish check (who, what, why, until when) under dual control, a reminder before expiry, re-blocked at expiry; listed on the system and in the register | An expired exception blocks the next publish it allowed, and the reminder went out seven days before | 3 |
| B-11505 | Governance reviews: scheduled attestation campaigns over the register, like access reviews (B-3305): each owner confirms purpose, data, evaluations and incidents for their systems; overdue systems are flagged and, when the policy says so, unlisted until reviewed | A system 30 days overdue under an "unlist" policy is no longer offered to members until its review closes | 5 |
| B-11506 | Control mapping: NIST AI RMF, ISO/IEC 42001 and EU AI Act deployer obligations mapped to the evidence the platform already produces (audit events, evaluations, the inventory, guardrail sets, reviews, exceptions), each control met, partial or missing, exported with the compliance export (B-7501) and the register (B-7302) | The export shows the evidence behind a met control, and a control with no evidence is marked missing, never met | 5 |
| B-11507 | A decision log: every dual-control decision, override, exception, review outcome and policy publish as one record with its reason, the people and its audit entries, searchable and signed into the checkpoints | A decision in the log verifies against the audit chain offline | 2 |
| B-11508 | Prototype board for a Governance screen: Policies, Register, Reviews, Exceptions, Controls and Decisions, their states and copy; the smoke run clean | The board passes the prototype smoke run in light and dark | 3 |
| B-11509 | Console: the Governance screen live, keyboard-first, with the inventory tab (B-7301) linking into it; Playwright with axe-core and the reflow checks | A review is completed and an exception granted end to end in the e2e suite with no axe or reflow finding | 5 |

### B-119 Skills from knowledge (30 points)

A skill is a registry entry: instructions, the tools it needs and the skills it builds on (B-4103), loaded by agents
and model steps and, with B-4005, in chat. A knowledge base holds documents, chunks and vectors with labels and a
classifier's finding. The two do not meet: a skill cannot name a base, and a skill about a base is written by hand
(the owner's three moderation skills of 2026-10-07 restate the playbook, guidelines and procedure that sit in the
Moderation base beside them). This epic lets a skill carry knowledge, drafts a skill from a base with citations,
keeps it in step with the base, and makes it earn publication as a classifier does.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-11901 | A skill names knowledge: `definition.knowledge: [kbId…]`; loading the skill attaches those bases for retrieval during the turn as a profile grant does, under the base's label rules; the closure (B-4103) carries the bases of every skill in it; a `knowledge-attach` node in the chain | A turn with the skill cites the base, and a member below the base's label gets the skill's instructions, no citations and a notice | 3 |
| B-11902 | Draft a skill from a base: a job reads the base (or chosen documents) with a profile and writes the instructions (purpose, when to use it, the procedure, rules, examples, glossary), each part citing its documents; validated against the skill schema, secrets scanned, screened by the guardrails; saved as a draft entry that names its sources and their versions | A draft from the Moderation base cites each of its four documents, and a draft missing the procedure fails validation | 8 |
| B-11903 | Staleness: a changed or removed source document marks the skill stale (on the entry, with a notice to its owner); a re-draft makes a new version with a diff against the published one; publishing runs the usual checks | Editing the playbook marks the moderation-review skill stale at the next sync, and the re-draft's diff shows the changed rule | 5 |
| B-11904 | Skill evaluation: an eval set drafted from the base (questions with expected answers and citations, judged by a profile) and curated; a skill publishes only with at least 20 cases and a passing run; results on the entry as on a classifier | A skill with 12 cases cannot be published, and the entry shows per-case results after a run | 5 |
| B-11905 | Skill packs: one skill per document or folder of a base and a parent skill that lists them (sub-skills, the closure), exported and imported as a signed bundle (B-3909) that references the base's documents rather than copying them | Importing a pack into another workspace recreates the skills and refuses to publish them until their base exists there | 4 |
| B-11906 | Console: "Create a skill" on the Knowledge screen (documents, profile, a preview of the draft, edit, save as draft) and the Registry entry's Sources, Staleness and Evaluation sections; Playwright with axe-core and the reflow checks | A skill is drafted, evaluated and published in the e2e suite with no axe or reflow finding | 5 |

### B-120 Classification across the platform (36 points)

Classifiers (deterministic, linear, guard-model, `llm`, and `vision` with B-88) run where a feature calls them:
guardrail rules at the checkpoints, attachment and knowledge document labels (never relabelled below the finding),
feed ranking, image safety, and the owner's support-ticket triage on the `classify` profile. Messages, posts,
records, files and conversations get a label only from their author or a guardrail rule; there is no taxonomy shared
between classifiers, no batch run, no search by finding and no routing by what a classifier found. This epic makes
classification a platform service: one taxonomy, a policy saying what runs on what, and findings every screen can
search.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-12001 | Classification on write: a tenant policy names which classifiers run on which kinds (messages, posts and comments, records by entity, files, memories, knowledge documents, conversations) and when (synchronous under a size, a job above it); findings stored as labels with scores on the object; a sensitivity finding raises the object's label as knowledge does today and its author cannot lower it; a classifier that is down queues the job and holds nothing | A record whose text holds a card number is labelled confidential on save, and its author cannot relabel it below that | 8 |
| B-12002 | Taxonomies: named label sets, flat or hierarchical, with definitions and examples, versioned, shared by classifiers, routing rules, queue rules, feed definitions and search; a classifier's labels map onto a taxonomy's | Renaming a taxonomy label updates every classifier and queue rule that uses it, and the old name still resolves in exports | 5 |
| B-12003 | Conversation classification and routing: a profile-level classifier tags a conversation's topic, intent and language on its first turn (and on request) for analytics (B-7401) and routing: a profile may send a turn to another profile by label (a cheaper or specialised one) within the caller's clearance and the conversation's ceiling, recorded in the chain | A billing question on the general profile is answered by the billing profile, and the chain shows the route | 5 |
| B-12004 | Classification as a step and a tool: a `classify` workflow step and a built-in `classify` domain tool (B-3904's pattern) returning labels and scores from a published classifier; a "needs review" band between two thresholds files a flag instead of a decision, and feeds active learning (B-11806) | A workflow branches on a classifier's label, and a score inside the band files a flag and takes no branch | 3 |
| B-12005 | Batch classification: a job over an app entity, a folder, a knowledge base or a range of conversations with a cost estimate, progress and cancel; re-classification offered when a classifier publishes a new version; results summarised per label | A batch over 10,000 records reports progress, can be cancelled, and its summary matches the stored labels | 5 |
| B-12006 | Search and filters by finding on Files, Messages and feed, app records, Knowledge and chat history, with label chips and counts; findings never shown above the viewer's clearance | Filtering Files by a label lists only files with that finding and none above the viewer's clearance | 5 |
| B-12007 | Console: Taxonomies and Policies tabs and a run history on Classifiers; a finding's "why" (labels, scores, classifier version) on each object; Playwright with axe-core and the reflow checks | A policy is set and a batch run watched in the e2e suite with no axe or reflow finding | 5 |

### B-121 Moderation 2: cases, assisted review and transparency (38 points)

Moderation has reports, flags routed to queues with SLA timers, hide actions, sanctions, appeals with independence
rules, external providers in shadow or enforce mode and dead letters; 1.6.0 and 1.7.0 add held posts, forms and
messages (B-4701, B-94), evidence retention and legal hold (B-95), group moderators (B-9706) and DLP (B-76). The
owner's `moderate` and `appeal` profiles (2026-10-07) assist reviewers from the playbook and guidelines with five
read-only moderation tools, and met two gaps: the tenant's safety rule set blocks a reviewer discussing a policy's
own categories, and a reviewer has flags to work one by one, never a case. This epic adds cases, review assisted by a
profile under the reviewer's decision, guidelines as reason codes, statements of reasons, strikes, reports on
generated content and a transparency report.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-12101 | Cases: flags on one object, or on one user within a window, fold into a case with a timeline (reports, verdicts, held items, actions, appeals, notes), assignment, SLA and escalation at the case level; queues list cases; actions and appeals cite the case | Three reports on one post make one case, and its SLA runs from the earliest flag | 5 |
| B-12102 | Review context for rule sets: a published rule set may exempt a checkpoint for a named profile or role (a moderation or governance profile discussing a policy's categories), under dual control, audited and listed as a known weakening of the set; the exemption never covers tool calls or anything leaving the reviewer's screen | The `govern` profile lists the policy's categories under the exemption, and the same text in a member's chat is still blocked | 3 |
| B-12103 | Assisted review: a moderation profile summarises the case's content at the reviewer's clearance, maps it to the guidelines and proposes an action with a reason code and a confidence; the proposal sits beside the case and is audited; the reviewer decides; a policy may let a duplicate report below a confidence be dismissed by itself, and nothing else | A proposal is never applied without a reviewer, and a dismissed duplicate is audited as automatic | 8 |
| B-12104 | Guidelines and reason codes: the community guidelines per tenant, workspace and group as a policy document (B-11501), its rules as reason codes on report forms, actions and sanctions, shown at join and before a first post; drafted with the draft assistant (B-2207) and screened | A report form offers the workspace's reason codes, and an action records the guideline version it cites | 3 |
| B-12105 | Statement of reasons: every action and sanction notifies the affected person with the reason code, the guideline cited, an evidence reference and how to appeal; the appeal references it; `GET /api/moderation/mine` lists them; exportable for the transparency report | A hidden post's author receives the statement with the appeal link, and the appeal shows it to the reviewer | 3 |
| B-12106 | Strikes: a policy of confirmed violations within a window to a proposed warn, suspend or ban, with decay; proposals land in the queue for a reviewer; a member sees their strikes in `mine` | A third confirmed violation in 30 days proposes a suspension, and a decayed strike does not count | 5 |
| B-12107 | Reporting generated content: images, media and `/v1` answers reportable into the same queues with their generation context (profile, model, prompt hash, guardrail decisions) so a reviewer can act on the content and propose a guardrail rule from the case | A reported image's case shows its profile and model, and "propose a rule" opens a shadow draft (B-9601) | 3 |
| B-12108 | Transparency report: a scheduled report per tenant (reports, actions, appeals and outcomes by reason code, median time to decision, provider share, proposals accepted), CSV and JSON, with an opt-in public page per workspace | The report's counts match the audit chain for the period, and the public page names no object or person | 3 |
| B-12109 | Console: Cases, Guidelines, Strikes and Reports tabs on Moderation, the proposal card and the statement of reasons; Playwright with axe-core and the reflow checks | A case is worked from proposal to statement in the e2e suite with no axe or reflow finding | 5 |

### P2

### B-116 Group governance: proposals, voting and execution (23 points)

Port decision D7 left exprsn-platform's nexus governance (GRP-17) for 1.7 or later without an id; this is the id.
The platform had a governance model per group (centralized, decentralized, dao, consensus), proposals with a voting
method, a quorum, a window and an action, weighted votes, results, close and execute (role, member and rule
actions). Exprsn-AI's groups (B-25, B-44, B-97) have owners, moderators, members, per-group roles (B-9705) and group
moderation (B-9706) for a passed proposal to act through.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-11601 | A governance model on a group: the owner decides, simple majority, supermajority (a set fraction) or consensus (no "no" votes), with rules: who may propose (a role), quorum as a fraction of active members, the default window, vote weight by role or one each; edited by the owner, audited, shown on the group | Changing the model while a proposal is open leaves that proposal on the model it opened under | 3 |
| B-11602 | Proposals: title, description (screened by the guardrails), type (free text, rule change, role change, member removal, setting change) with the action's parameters; states draft, active, passed, failed, cancelled, executed; opened and closed by the scheduler at the window's ends; one active proposal per subject | A proposal with a two-day window closes itself on time on every instance | 5 |
| B-11603 | Votes: yes, no or abstain, one per member, weighted as the model says, changeable while active; open or secret ballots (secret: the tally is public, the ballots only to the proposer after close); results with quorum and the threshold applied; audited without the ballot when secret | A secret ballot's tally is right, and no route or export shows who voted which way while it is open | 5 |
| B-11604 | Execution: a passed proposal's action runs with the same checks as a manual one (a role through B-9705, a removal through B-9701, a setting through the group's own routes), by a moderator or by itself when the model says so; a failed action records why and the proposal stays passed, not executed | An executed removal is enforced at once, and an action its executor lacks permission for fails with the permission named | 3 |
| B-11605 | Notifications and the feed: proposal opened, closing within a day, result and execution to members through the group notifications (B-9708); the proposal as a card in the group feed with the vote control | A member sees the closing notice once and can vote from the feed card | 2 |
| B-11606 | Console: a Governance tab on Groups and events (the model and rules form, proposals by state, the proposal page with the vote control, results and the execution record); Playwright with axe-core and the reflow checks | A proposal passes and executes end to end in the e2e suite with no axe or reflow finding | 5 |

### B-117 Thinking: policy, budgets, plans and reflection (34 points)

Thinking exists: profiles carry a default and a ceiling, levels stream apart from the answer, the `model-output`
check screens thinking and withholds what it blocks, thinking tokens are metered and priced, `/v1` maps
`reasoning.effort`, and the chain view carries thinking per node. Missing are control over who sees thinking and how
long it is kept, a budget for it, a way to make a model plan before it acts, a second look at an answer before it is
trusted, and models whose thinking needs a prompt template: the owner's Magistral profiles (2026-10-07) thought only
once a hand-written `<think>` convention was in their system prompt, and the model failed the console's tool-calling
evaluation because the evaluation sends no system prompt.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-11701 | A thinking policy per tenant and workspace: who sees thinking (the author, reviewers, nobody), its retention apart from the answer (purged earlier), whether exports carry it; thinking never shown above the viewer's clearance; applied to chat, `/v1`, runs and the chain view | With "nobody" set, the author's stream carries no thinking and the stored message holds only its token count | 5 |
| B-11702 | Thinking budgets: a thinking-token budget per profile and per workspace per day, metered with the rest, a notice near the limit and a level drop at it rather than a refusal; `/v1` `reasoning.effort` mapped onto levels and capped by the ceiling and the budget | A workspace at its budget gets answers at `low`, and the usage summary shows the drop | 3 |
| B-11703 | Plan first: a profile or agent option under which the model drafts a plan (steps, the tools and data it intends to use) shown as a card before any tool runs; the person approves, edits or declines; in an agent run the plan becomes the step list and a deviation needs a new approval; write and destructive tools keep their own cards (B-4003); the chain records the plan | A declined plan runs no tool, and an agent that calls a tool outside its approved plan pauses for approval | 8 |
| B-11704 | Reflection: an optional second pass that checks the answer against the question, its citations and its tool results (unsupported claims, missing parts, contradictions), with another profile allowed; the result is a "checked" badge with findings or a revised answer, metered and screened like any answer; a profile's evaluations may require it | An answer whose citation does not support its claim gets a finding, and the badge names it | 5 |
| B-11705 | Thinking on workflow model steps and agent steps: a level per step within the profile's ceiling, counted against the run's budget (B-4101) and shown per node in the chain view | A step at `high` on a profile whose ceiling is `medium` is refused at publish with the ceiling named | 3 |
| B-11706 | Evaluations on thinking and plans: a case may hold a rubric for the thinking (judged by a profile) and the tools a plan must and must not include; outputs sealed; the profile's gate counts them | A profile whose plan calls a destructive tool the case forbids fails the gate | 3 |
| B-11707 | Model thinking templates: a catalogue entry records how a model is made to think (native, a template such as Magistral's `<think>` convention, or none) and profiles inherit it, so every profile on the model thinks; the tool-calling evaluation sends a system prompt as chat does | A profile created on Magistral thinks without a hand-written convention, and the model passes the tool-calling evaluation (scheduled early: 1.6.0 Sprint 36b, 2026-10-08) | 2 |
| B-11708 | Console: Profiles (policy, budget, plan first, reflection), Chat (the plan card, the checked badge, thinking shown per policy), Runs and the chain view; Playwright with axe-core and the reflow checks | A plan is approved and a reflection finding shown in the e2e suite with no axe or reflow finding | 5 |

### B-118 Learning: feedback, corrections and the improvement loop (38 points)

What the platform learns from today: a reviewer confirms a flag into an eval case, curators accept memory proposals,
classifiers train on labelled samples, profiles are gated by evaluation sets, and the training worker fine-tunes on
sealed datasets. A person cannot say an answer was wrong, and nothing turns corrections into eval cases, memories,
samples or training data. This epic adds feedback at the answer, a curated path from feedback to each of those, and
continuous evaluation so the loop is measured. Nothing changes a model or a prompt without a curator or the usual
dual control.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-11801 | Feedback on answers: up or down, a reason from a list, an optional correction (the answer as it should have been), on chat, `/v1` (a feedback route keyed by the response id) and agent runs; sealed with the tenant key, labelled as the conversation, audited; the author chooses whether it may be used for learning, with a tenant default | Feedback on a confidential answer is withheld from a curator cleared for internal | 5 |
| B-11802 | A feedback queue for curators: grouped by profile and reason, the turn opened at the curator's clearance, a correction turned into an eval case (an expected answer or a rubric) for the profile or into a classifier sample, or dismissed; duplicates folded; the flags queue's routing and SLA reused | A correction becomes an eval case that the profile's next evaluation run fails until the profile is fixed | 5 |
| B-11803 | Learned instructions: a pattern in accepted corrections (the same fix three times for a profile) proposed as a workspace memory or a system-prompt amendment through the `memory` checkpoint; a curator accepts; never applied by itself | A repeated correction becomes a proposal, and until it is accepted the next answer is unchanged | 5 |
| B-11804 | Learning datasets: consented conversations and corrections for a profile exported into a training dataset through the training scrub, sealed; a fine-tune job on the training worker; the resulting model enters the catalogue as any import does and needs its evaluation and dual-control approval | An unconsented conversation is never in the dataset, and the fine-tuned model is unusable before approval | 8 |
| B-11805 | Continuous evaluation: scheduled runs per profile on its growing set, a score history, a regression alert (a drop beyond a threshold notifies the owner and, under the policy, un-publishes), and the learning numbers (feedback rate, corrections, cases, the score trend) on the Analytics screen (B-7401) | A regression beyond the threshold raises an alert on the next scheduled run, and the trend shows it | 5 |
| B-11806 | Active learning for classifiers: classifications in the review band (B-12004) queue for labelling, labelled items join the dataset, retraining or re-evaluation is proposed when the set has grown by a set count; the `classify` profile's results included | A low-confidence classification is labelled from the queue, and the next training run uses it | 5 |
| B-11807 | Console: feedback controls on Chat and Runs; a Learning tab on Profiles (queue, cases, trend) and a Labelling tab on Classifiers; Playwright with axe-core and the reflow checks | Feedback given in the e2e suite reaches the queue and becomes a case with no axe or reflow finding | 5 |

## Release

| ID | Item | Done when |
| --- | --- | --- |
| B-5901 | Version `1.7.0`, the CHANGELOG, `docs/api.md`, `docs/permissions.md`, `docs/accessibility.md` and the known-gaps sections updated as each item lands; the full Playwright suite run locally at the end of the release, its findings fixed and the cross-screen sweeps (`a-first-look`, `zz-every-screen`, `y-accessibility`, `y-reflow`, `y-reflow-overlays`) green (owner, 2026-10-06: sprints run only the specs of the screens they change) (Sprint 43; Sprint 38 until 2026-10-07) | The full Playwright suite passes locally and in CI |

## Still deferred

| Item | Why |
| --- | --- |
| Server log view in the console (B-57) | 1.7 or later per the platform administration decisions; traces and metrics only for now |
| Group governance: proposals, voting, quorum (GRP-17) | Port decision D7: 1.7 or later; now B-116 (added 2026-10-07), unscheduled |

## Open decisions

- [ ] Plugin UI surfaces (B-11201): a sandboxed iframe on a separate origin or declarative surfaces the console renders?
  The board and decision record are the epic's first item.
- [ ] Sessions as leases (B-9206): migrate every install in 1.7.0 with the dual read, or keep the `sessions` table as an
  option for single-process installs?
- [ ] Placement of B-115 to B-121 (added 2026-10-07, 240 points; partly answered 2026-10-09: B-117 and B-119 scheduled by usage in Sprints 41 and 43, the rest open): two or three more sprints in 1.7.0 (Sprints 44 to 46,
  with 2.0.0 moving to 47 to 53 and the release item to the last of them), or the first sprints of a 1.8.0 after 2.0.0?
  The split A, B, C above is sized for three.
- [ ] Priorities of B-115 to B-121: the P1 and P2 above are a proposal; the owner asked for the seven together and set no
  order.
- [ ] AI-use policy (B-11502): policy lines as records edited in the console under dual control (assumed), or a policy file
  in the deployment, versioned with it, that the console only shows?
- [ ] Review context (B-12102): an exemption on the rule set for a named profile or role (assumed), or a separate `review`
  checkpoint with its own rules that moderation and governance profiles run under?
- [ ] Learning datasets (B-11804): fine-tuning in scope with the rest of B-118, or stop at eval cases, samples and
  memories until a training worker runs on cluster GPUs (2.0.0's compute pools, B-104)?
- [ ] Secret ballots (B-11603): ballots shown to the proposer after close (assumed), or to nobody?

## Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Chat calls write tools | A person approves an action they did not read | Approval cards show the tool, its side-effect class and the exact arguments; destructive tools follow the guardrail's approver rules (B-4003) |
| Dataset sources change shape | Imports and refreshes break on a publisher's schema change | Schema preview on every version, refresh jobs that fail soft and keep the last good version (B-3804, B-3805) |
| Vault on every request | Sessions as leases (B-9206) make a slow or unavailable vault an outage | The hot-path cache (B-9203), a single indexed lookup, Redis required for more than one process (B-90), and a fail-closed boot order (B-9202) |
| Response cache | A cached answer crosses a tenant, a label or a changed guardrail set | Tenant, label and guardrail-set version in the key, entries sealed with the tenant key, opt-in per profile (B-9901) |
| Groups carrying access | A group owner widens who reads files, secrets or knowledge | Grants never exceed a member's clearance or the object's label, bans and per-group roles first, explain names the group (B-98) |
| Assisted review | Reviewers accept the profile's proposal without reading the case | The proposal shows its evidence and confidence, its acceptance rate is in the transparency report, and it is never applied by itself (B-12103, B-12108) |
| Classification on write | A slow or stopped classifier slows or fails writes | Synchronous only under a size, jobs above it, a stopped classifier queues the job and holds nothing; a sensitivity finding is never lowered (B-12001) |
| Learning datasets | Unconsented or over-labelled content reaches a training set | Consent per author with a tenant default, the training scrub, labels carried into the dataset, dual-control approval of the model (B-11804) |
| Plan first | Approving a plan is taken as approving every tool call in it | Write and destructive tools keep their approval cards, and a deviation from the plan pauses the run (B-11703) |
| Skill drafts | A drafted skill states something its base does not say | Every part of the draft cites a document, the evaluation set comes from the same base, and a changed document marks the skill stale (B-11902 to B-11904) |
| AI-use policy | A policy line blocks profiles already in use | Policy evaluated at publish and listing, not retroactively on stored conversations; exceptions with expiry (B-11504); explain names the line |
