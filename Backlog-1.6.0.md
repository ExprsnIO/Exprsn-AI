# Backlog: 1.6.0

The work after 1.5.0, groomed by the owner on 2026-10-05 with `design/grooming/groom.mjs` (state in
`design/grooming/grooming.json`). 1.5.0 gives the merged exprsn-platform features their screens; 1.6.0 finishes the
platform's administration surface (the five admin screens designed in `design/platform-admin/README.md`), fills the
remaining exprsn-platform gaps that Exprsn-AI wants (groups depth, tenant templates, blob deduplication, vault
extras, quote posts; capability tokens were dropped on 2026-10-07), closes two 1.4.0 known gaps, adds model servers
beyond Ollama and image classification in Knowledge, and closes the industry gaps found by the 2026-10-05 research
(prompt-injection defence, red-teaming, MCP server and authorization, SCIM, an AI inventory and seven P2 epics), the
low-code gaps from the same day (row and field permissions, app environments and promotion, data model generation, AI
field upgrades, outside database sync, entity APIs and app embedding) and the first exprsn-platform port item, an HTTP
tool kind (the rest of the port decided on 2026-10-06 is in `Backlog-1.7.0.md`). Rules as before: everything follows
`docs/PLAN.md` and `CLAUDE.md`; screens follow `design/prototype/CONTRACT.md` (prototype board first, then live when
every control is backed by the server); every server item ships its routes, permission, audit events, jobs, tests on
SQLite, PostgreSQL and MySQL, `docs/api.md` and `docs/openapi.json` entries and any known gaps in `docs/security.md`.

**Size.** 75 items, 365 points (1 point ≈ half a day for one engineer, tests included): P1 247, P2 118 (B-11707, 2 points, pulled forward from 1.7.0 into Sprint 36b on 2026-10-08). Reconciled on
2026-10-07 from main (32 items, 158 points in Sprints 35 to 37) and `docs/backlog-1.6-gaps`: the industry gaps (B-69
to B-80, 23 items, 121 points), the low-code gaps (B-81 to B-85, 11 items, 59 points) and their second pass (B-86,
B-87 and two points on B-7101, 5 items, 23 points), groomed on 2026-10-05, now fill Sprints 37 to 39; B-50 capability
tokens (8 points) was dropped and B-89, the HTTP tool kind from the platform port (10 points), added. Sprint 36 keeps
its contents. Sprints 35 to 39 are at 76, 61, 73, 76 and 77 points, at or under the 78-point pace, and the release
(B-5101) moves to Sprint 39.

**Builds on.** The B-4201 boards (Overview, Jobs and queues, Storage, Configuration, Social and messaging) and the
sixteen answered design questions (`design/platform-admin/DECISIONS.md`); the `JobQueue`, `Scheduler` and tenant cache
(B-2102); the blob store and attachment quarantine; B-25 groups and events; the B-17 vault; B-27 feed.

## Sprints

| Sprint | Theme | Items | Points | Status |
| --- | --- | --- | --- | --- |
| 35 | Platform administration live screens; tenant provisioning templates; model servers beyond Ollama | B-4202–B-4207, B-4501, B-4301–B-4307 | 76 | **Done** |
| 36 | Groups depth and categories; blob deduplication; held form values queued; vault access anomalies; image classification in Knowledge | B-4401–B-4405, B-4601, B-4701, B-4803, B-8801–B-8805 | 61 | **Done** |
| 36b | Model thinking templates and a tool-calling evaluation that sends a system prompt (B-11707, pulled forward from 1.7.0 on 2026-10-08: the owner's Magistral profiles) | B-11707 | 2 | Next |
| 37 | Quote posts and per-post visibility; vault sharing and MongoDB leases; HTTP tool kind; prompt-injection defence; SCIM; MCP server and authorization | B-4901, B-4801, B-4802, B-8901–B-8904, B-6901–B-6903, B-7201–B-7202, B-7101–B-7103 | 73 | **Done** (B-7202 partial) |
| 38 | AI inventory; red-team harness; usage and cost analytics; compliance log export; agent identities; row and field permissions; DLP, legal hold and eDiscovery; agent handoffs | B-7301–B-7302, B-7001–B-7002, B-7401–B-7403, B-7501, B-7701, B-8101–B-8103, B-7601–B-7603, B-7801 | 76 | **Done** |
| 39 | Image provenance; versioned artifacts; app packages, environments and promotion; data model generation; AI field upgrades; outside database sync; entity APIs; app embedding; release | B-7901, B-8001, B-8201–B-8204, B-8301, B-8401–B-8402, B-8501, B-8601–B-8603, B-8701–B-8702, B-5101 | 77 | **Done** |

### Progress

**Sprint 39: done** (this PR), and with it the 1.6.0 release (B-5101). Content credentials (B-7901, migration
`041_provenance_artifacts`): a generated PNG carries a C2PA manifest store (CBOR, JUMBF, COSE_Sign1 written here, no
reference library) signed by a content-credentials certificate the tenant's issuing CA makes with its key in custody,
verified by `GET /api/images/:id/content-credentials` and offline by `exprsn-ai c2pa:verify`. Versioned artifacts
(B-8001): fenced blocks of an answer become artifacts of the conversation with a version per change, in the Chat
inspector and for share readers, rendered in a sandboxed frame from a short-lived capability URL. App packages
(B-8201 to B-8204, migration `041b_app_packages`): `exprsn-app/2` packages built, signed, sealed and verified before
they are read; pipelines of three app slots with promotion that cannot skip a stage and needs an approval workflow
before production (`app.package.promoted`); a backup before every deployment, a 365-day history and rollback on the
Apps screen; git export and import as one file per object. Data model drafts (B-8301, migration `041c_model_gen_sync`):
a description becomes a diff of entities, fields, relations, formulas, state machines and triggers to accept in one
step; AI fields (B-8401, B-8402) take field references and formula functions, regenerate once when a reference
changes, and fill every row as a cancellable job with an estimate first; outside tables (B-8501) from a PostgreSQL or
MySQL connection as app entities with writes through and scheduled pulls. Entity APIs (B-8601 to B-8603, migration
`041d_entity_api_embeds`): `/api/apps/:app/:entity` under the policies, field masks and labels with app-limited API
keys; a schema API that versions every change; an OpenAPI document and TypeScript client per app. Embedding (B-8701,
B-8702): public embed pages under a `frame-ancestors` allowlist and signed embeds from a host-signed JWT (or a tenant CA
certificate) mapped to a user, with their own bearer sessions. Unit suite 1170 passed; PostgreSQL integration 52
files passed (MySQL ran for 39b and 39c); prototype smoke 51 of 51; the full Playwright suite 168 passed, 0 failed (B-5101: the sweep list gained Analytics, the harness driver
was limited to the outside table, an Analytics reload race and the draft dialog's accessibility pass were fixed). Choices to know: the backlog's
`apps:manage` is the catalogue's `apps:design`; stages are app slots of one tenant (cross-instance only through git);
production promotion refuses without an approval workflow; outside tables are read unmasked, so attaching needs
`connections:manage`; packages share the bundle HMAC key. Known gaps in `docs/security.md`: no RFC 3161 time stamp or
ingredient chain in the manifest; JPEG images carry none; artifacts come only from fenced blocks; a field type change
on an entity with records fails a deployment; rollback restores design, not records; pulls are full reads; a public
embed page is reachable by anyone who learns its id; the host site is trusted for who is behind the browser.

**Sprint 38: done** (PR #69). The AI inventory (B-7301, B-7302, migration `040_inventory_analytics`): one register of
models, profiles, agents, workflows, tools, MCP servers and datasets with an owner, an oversight role, provenance,
lineage, an impact assessment and known issues counted from run flags and failed evaluations, on the Models screen's
Inventory tab, exported as CSV or JSON; the owner gate (an agent with no owner cannot be approved) is a tenant setting,
off by default so existing tenants keep publishing. Analytics (B-7401 to B-7403): a new Analytics screen summing
`usage_records` by workspace, group, model, profile and user and per day, prices per model or pool with a chargeback
export per workspace that sums to the screen, and `gen_ai.*` usage attributes on the chat stream span. Audit export
(B-7501): time-windowed JSONL files that end in a KMS-signed checkpoint and verify offline with
`audit:verify-export`, and per-tenant SIEM destinations (HTTPS, syslog over TLS) under dual control. Red-team suites
(B-7001, B-7002, migration `040b_redteam_agents`): built-in attack categories (the Sprint 37a corpus, jailbreaks,
exfiltration through tools, system-prompt extraction) and tenant cases run against profiles, agents and workflows by
the job `redteam.run`, judged deterministically; a gate beside the evaluation gate that no override opens; every
successful attack a flag a reviewer turns into an eval case. Agent identities (B-7701): an agent as a principal with
roles, a label ceiling and scoped keys, its runs narrowed to both grants, `actor.agent` on audit events. Handoffs
(B-7801): a specialist agent listed in the configuration answers through the chain and is named on the Runs screen.
Policies (B-8101 to B-8103, migration `040c_policies_dlp`): reusable rule sets per app entity with row conditions
over the user's attributes, groups and roles and field permissions with last-four, hash and hidden masks, enforced in
records queries, tools, forms, exports and workflows, with an editor and an explain view on Apps. DLP (B-7601): PII,
secret and tenant-pattern detectors on answers, agent outputs and uploads that raise the label and hold or redact by
rule; legal holds (B-7602) on users and workspaces under dual control that chat, memory and file purges respect; a
compliance export API (B-7603) with the `compliance:export` scope. Unit suite 1130 passed; PostgreSQL integration
passed on the merged migrations (MySQL ran for 38c only); prototype smoke 51 of 51; the specs for the touched screens
passed. Choices to know: SIEM destinations, DLP, holds and exports live on the Usage and audit screen (Settings is
personal settings); prices are per model or pool, not per instance; handoff attribution is on the Runs screen until
agents reach chat in Sprint 40; `gen_ai` usage is on chat spans only. Known gaps in `docs/security.md`: a fixed
English attack catalogue and a deterministic judge; identities narrow by permission, not by object; a handoff hands
the task, not the messages; costs are computed on read, so a price change alters past chargebacks; no offline HMAC
check; a record created outside one's own rows is accepted then unreachable; DLP inspects finished answers up to
`DLP_MAX_TEXT_BYTES`; a hold does not stop self-deletion; exports are unsigned.

**Sprint 37: done** (PR #65). The HTTP tool kind (B-8901 to B-8904): registry tools that call web APIs from a URL
template, headers, a body and a response mapping, only to the tenant's allowed hosts, credentials only as vault
references, every call metered and audited. Prompt-injection defence (B-6901 to B-6903): knowledge chunks, crawled
pages and tool, MCP and HTTP results reach the model marked as untrusted content, an `untrusted-content` checkpoint with
an injection rule (annotate by default, block per tenant), and a 57-attack, 30-benign corpus in CI with a 0.9 detection
and 0.1 false-positive bar. The MCP server and MCP authorization (B-7101 to B-7103): a per-workspace MCP endpoint that
publishes workflows, agents, knowledge bases, registry tools and app records and acts as the signed-in user, an OAuth 2.1
resource server of the tenant's issuer (RFC 9728, RFC 8707), and per-user OAuth with PKCE in the MCP client. SCIM 2.0
Users and Groups with deprovisioning that ends sessions, tokens, keys and app passwords in one request, and group
mappings to roles (B-7201, B-7202). Vault secrets shared with one principal (B-4801), MongoDB dynamic credentials
(B-4802), quote posts and per-post visibility (B-4901). Migrations `039_tools_injection`, `039b_mcp_server`,
`039c_scim_vault_posts`. **B-7202 is partial**: the Entra ID and Okta validators could not reach this server; a local
conformance suite covers what they check (`docs/identity.md`). Unit suite 1098 passed; PostgreSQL and MySQL integration
passed. Each part ran its own Playwright specs. Known gaps in `docs/security.md`: the injection heuristic is tuned on its
own corpus, the MCP server has no sessions, resources or prompts, write calls over MCP need a browser approval each time,
and an unlisted post stays in the bookmarks of whoever saved it.

**Sprint 36: done** (PR #64). Groups depth (B-4401 to B-4405, migration `038_groups2`): channels inside a group with
their own members, roles and feed, never labelled below their group; a discovery page of joinable groups ranked by shared
members and activity, filtered by clearance; places on groups and points on events with distance filters (PostGIS when
installed, a bounding box otherwise, the same great-circle cut everywhere); trending groups by job; tenant group
categories managed from Social and messaging. Blob deduplication within a tenant with the savings on the Storage screen
(B-4601), public form values the guardrail would hold queued for review in moderation (B-4701), and vault reveal anomaly
flags for a secret's owner (B-4803), migration `038b_dedup_held_vault`. Image classification in Knowledge (B-8801 to
B-8805, migration `038c_knowledge_images`): image documents and the images inside PDF and Word through quarantine and the
image safety check, a vision profile's caption and OCR as their text, the `vision` classifier engine with labels stored
on documents and refreshed on a new classifier version, label filters in search and `knowledge_search`, and the
Knowledge and Classifiers screens. Unit suite 1062 passed; PostgreSQL and MySQL integration passed; prototype smoke 50
of 50. Each part ran its own Playwright specs (the full suite runs at the release, B-5101). Known gaps are in
`docs/security.md`: a group's place is shown only to readers of the group, coordinates are not sealed, duplicates stored
before 1.6.0 stay separate, no server-side thumbnails (HEIC has none), vision calls metered as embedding usage.

**Sprint 35: done** (PR #54). Model servers beyond Ollama (B-4301 to B-4307, migration `037_model_servers`):
`kind: openai` instances on a URL or a Unix socket with an optional bearer token in the vault, Chat Completions mapped
onto the gateway, server-held models in the catalogue without a pull, the `instance.probe` job, and the Models
screen's Model servers. A smoke against the real `fm serve` on macOS 27 registered, evaluated and approved `system`,
which then answered a tool-calling chat turn. The five platform administration screens are live with their
accessibility and reflow checks (B-4202 to B-4207, migrations `037b_platform_ops`, `037c_platform_storage`,
`037d_platform_social`): Overview (instance heartbeats, computed alerts, drain), Jobs and queues (pause by type,
schedules, dead letters, cache), Storage (integrity job, orphan deletion after a dry run, copy-then-switch blob
migration), Configuration (a generated settings descriptor, overrides under dual control) and Social and messaging
(feed, groups, messaging, realtime and relations policies; legal-hold export under dual control). Tenants can be
created from the enterprise, team and personal templates (B-4501). Unit suite 1036 passed; PostgreSQL and MySQL
integration passed. At the owner's request the full Playwright suite was not run; each part ran its own specs.
Known gaps are in `docs/security.md`: realtime counts and schedule counters per instance, a drain does not end open
streams, provisioning is not one transaction, exports hold at most 50 000 messages, the Pools screen's instance form
edits Ollama settings only, and no server exposes a model file hash.

The order follows the dependencies: the Storage screen (B-4204) before blob deduplication shows its savings (B-4601);
the Social and messaging screen (B-4206) before group categories are managed from it (B-4405); vault anomaly detection
(B-4803) before secret sharing widens who reads a secret (B-4801); the gateway interface (B-4301) before any `openai`
instance (B-4302), and both before the Models screen changes (B-4307); injection trust marking and its corpus (B-6901,
B-6903) before the red-team suites reuse the corpus (B-7001), and in the same sprint as the HTTP tool kind (B-89),
whose results it marks; MCP server authorization (B-7102) in the same sprint as the server (B-7101); chaining (B-41,
1.5.0) before agent handoffs (B-7801); record queries (B-3601, 1.5.0) before policies add row conditions to them
(B-8101); policies (B-81) before packages carry them (B-8201) and before entity APIs enforce them (B-8601). The gaps
branch also put capability tokens (B-5001) before agent identities (B-7701), scoped entity API tokens (B-8601) and
embed sessions (B-8702); with B-5001 dropped on 2026-10-07 those three use scoped API keys and their own signed
sessions instead, and no longer wait on it.

---

## P1

### B-43 Model servers beyond Ollama: Apple Foundation Models, MLX and llama.cpp (34 points)

Added 2026-10-05 at the owner's request; placed in 1.6.0's first sprint (Sprint 35) by the owner the same day. Only the gateway talks to a model server, and
today that server is Ollama: an instance is an Ollama URL, the catalogue is keyed by Ollama tags, placements load and
unload through `/api/ps`, and import pulls a blob whose digest is pinned. macOS 27 ships Apple's on-device Foundation
Model with a `fm serve` command that speaks the Chat Completions API (`/v1/chat/completions`, `/v1/models`, `/health`)
on a port or a Unix socket, and the same API is what MLX (`mlx_lm.server`), llama.cpp (`llama-server`) and vLLM
offer. This epic gives an instance a `kind` (`ollama`, the default, or `openai`), so a Chat Completions server joins
a pool like an Ollama node, with the parts Ollama does for free (tags, show, load, unload, pull, embeddings, digests)
either mapped onto what the server offers or marked as not available on that instance, and nothing else in the
server, the guardrails, metering, profiles or the OpenAI-compatible API the server itself exposes changes. Apple's
Private Cloud Compute model (`pcc`) is out of scope: `fm` refuses it outside Apple's own clients, and it would leave
the tenant's network. Models on these servers follow the same catalogue rules: a recorded licence, a conformance run,
dual-control approval, a label ceiling; the digest check is replaced by the server's reported model id and, where the
server exposes it, the file's hash.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-4301 | The gateway client behind an interface: `ModelServer` with `version`, `models`, `loaded`, `show`, `load`, `unload`, `chat` (streaming, tools, thinking where supported) and `embed`; `OllamaClient` implements it unchanged; each method reports `unsupported` for what a server cannot do, and the gateway, placements and the catalogue treat `unsupported` as "skip", never as an error | The suite passes with `OllamaClient` behind the interface and no gateway test changed | 5 |
| B-4302 | `kind: openai` instances: `instances.kind` (`ollama` default, migration `037_model_servers`), a URL or a Unix socket path, an optional bearer token in the vault, the same mTLS and egress policy; health from `GET /health` or `GET /v1/models`; `/v1/models` lists the server's models as catalogue candidates; load and unload are no-ops recorded as `unsupported`; the instance's settings carry what the server reports (context length, whether tools and JSON schema output work) | An `fm serve` socket and a `llama-server` port register as instances, show healthy, and list their models in the catalogue's import picker | 8 |
| B-4303 | Chat Completions mapped onto the gateway's chat: messages, system prompt, tools and tool calls, streaming deltas, `response_format` JSON schema, stop, temperature, max tokens and usage; Ollama-only options (`num_ctx`, `keep_alive`, `think`) dropped with a recorded note; the server-side tool loop, guardrail checkpoints, labels and metering unchanged | A conversation on a profile backed by Apple's on-device model streams, calls a read-only tool and is metered like an Ollama turn; the fake server in `server/test/fake-openai-server.ts` covers the suite | 8 |
| B-4304 | Catalogue entries without a pull: a model on a `kind: openai` instance is registered from `/v1/models` with `source` the instance and model id, `format` `server`, no `expected_digest` (the licence, evaluation and dual-control approval still apply); the conformance run executes on that instance; placements on such a pool are `warm` only; retiring the entry does not delete anything on the server | Apple's on-device model is approved, evaluated and placed with the same audit events as an Ollama model, and a second approval attempt by its requester is refused | 5 |
| B-4305 | Embeddings and guard models: an `openai` instance that offers `/v1/embeddings` serves embedding models; otherwise the pool's profile for memory, knowledge and the guard falls back to an Ollama pool in the same zone, chosen as the fallback profile is today | A knowledge base whose chat profile is on Apple's model still embeds on `qwen3-embedding:0.6b` and the guard still runs, with no change to the knowledge or guardrail code | 3 |
| B-4306 | Operator docs and a reference layout: `docs/deploy.md` on running `fm serve --socket` under launchd beside Ollama on an Apple silicon node, `mlx_lm.server` and `llama-server` as alternatives, the pool as `accelerator: metal`; `docs/security.md` on what the digest check cannot cover for server-held models; `docs/api.md` and `docs/openapi.json` for the instance's new fields | A fresh macOS 27 node follows the doc to a healthy `openai` instance with Apple's model approved and answering in chat | 2 |
| B-4307 | Console: the Models screen's instance form gets the kind, the socket path and the token; the catalogue's import picker lists server-held models; the model card shows "held by the server, no digest" and the capabilities the server reported; the prototype board and the live screen, in the Playwright suite with axe-core and the reflow checks | Registering an `openai` instance and approving one of its models works end to end in the e2e suite with no axe or reflow finding | 3 |

Not in this epic: converting Apple's open-weight models (OpenELM, DCLM) to GGUF for Ollama, which the import wizard's
GGUF conversion (B-3803) already covers; Private Cloud Compute; MLX or llama.cpp as managed runtimes the server
starts and stops (they are external instances here, as Ollama is).

### B-42 Platform administration live screens (37 points)

Carried from 1.5.0, where the boards (B-4201) were done in Sprint 29. Design and decisions:
`design/platform-admin/README.md` and `DECISIONS.md`. The five screens join the Admin group (Overview first) with
their own sidebar icons, added to `app.js` when they go live (decision Q13).

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-4202 | Overview live: `GET /api/admin/overview` (alerts, counters, instances with their `/readyz` checks, next schedules, recent audit, capacity); acknowledge alerts tenant-wide, audited `platform.alert.acknowledged`; drain an instance with a confirm and a recent sign-in, audited `platform.instance.drained` | Draining an instance from the screen stops it claiming jobs | 5 |
| B-4203 | Jobs and queues live: `GET /api/admin/jobs` with filters, `/queues`, `/schedules` (run now, pause), `/dead-letters` (redrive, discard), `/cache` (namespaces, invalidate; the cache is a tab here, Q1); pause by type in `JobQueue`; system admins see every tenant's jobs with a tenant filter, tenant admins their own (Q9) | A paused type stops claiming within one poll and resumes from the screen | 8 |
| B-4204 | Storage live: stores and health, usage by workspace and user, quarantine listing with rescan, the integrity job `ops.blobs.verify` with findings, orphan deletion after a dry run by one admin with a reason (Q10), purge schedule summary, blob store migration as a copy-then-switch job (Q16) | An orphan found by the job can be deleted from the screen after a dry run | 8 |
| B-4205 | Configuration live: a settings descriptor generated from `config/index.ts` (name, section, type, default, secret, hot or restart), `GET /api/admin/platform/settings` with per-instance values; database overrides for every setting under dual control, applied hot or flagged restart required (Q2) | Two instances with different values show as differing; an override applies only after a second platform admin approves | 8 |
| B-4206 | Social and messaging live: feed approval policy and trending exclusions, group defaults and calendar feed revocation, messaging limits and legal-hold export under dual control (Q5), realtime room counts, contact rules; a new `social:manage` permission, with held content under `moderation:manage` (Q4) | A revoked calendar feed answers 404 on its next fetch | 5 |
| B-4207 | Accessibility and reflow for the five screens; `docs/accessibility.md` updated | No axe or reflow finding on any of the five | 3 |

### B-44 Groups depth (24 points)

exprsn-platform's groups had subgroups, discovery, locations and trending; Exprsn-AI groups are flat inside a
workspace.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-4401 | Subgroups or channels inside a group, with their own members, roles and feed, inheriting the group's label as a floor | A channel inside a group has its own members and feed | 8 |
| B-4402 | Discovery and recommendations: a page of groups the viewer may join, ranked by shared members and activity | The discovery page never shows a group above the viewer's clearance | 5 |
| B-4403 | Optional location on groups and events (PostGIS on PostgreSQL, a bounding box elsewhere) with distance filters | A distance filter returns the same groups on the three databases | 5 |
| B-4404 | Trending groups by job, like trending hashtags (B-2705) | A group with a burst of joins appears in trending within one job run | 3 |
| B-4405 | Group categories: a tenant-managed category list, managed from Social and messaging, filterable on Groups and discovery (decision Q6) | Removing a category leaves its groups uncategorised, not hidden | 3 |

### B-88 Image classification in Knowledge (21 points)

Added 2026-10-06 at the owner's request; placed in Sprint 36, which had room. Knowledge bases take text, Markdown,
HTML, CSV, JSON, PDF and Word documents today and no images, and classifiers have no engine that reads one (they are
`deterministic`, `linear`, `guard` and `llm`, all over text). The vision profile (`see`, Gemma 4 12B on :8091) and the
image safety check (`server/src/images/safety.ts`) exist. This epic lets a knowledge base hold images, describes and
classifies each one with a vision model, and searches and filters by those labels, under the same label, quarantine,
guardrail and evaluation rules as everything else.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-8801 | Images as knowledge documents: PNG, JPEG, WebP, GIF and HEIC uploads, and the images inside PDF and Word documents, go through the attachment quarantine and the image safety check; a vision profile named by the knowledge base writes a caption and the OCR text, which become the document's indexed text with the image as its source; a document's images are kept as its parts | An uploaded screenshot is found by a phrase from its OCR text, and an image the safety check flags never reaches the index | 5 |
| B-8802 | A `vision` classifier engine: labels with thresholds like `llm`, scored by a vision profile from the image (with optional instructions), JSON answers validated against the labels; the knowledge base names its image classifiers, the labels are stored on the document as tags with their scores and the classifier's version, and a new classifier version re-classifies in the background | Publishing a new classifier version re-labels the knowledge base's images without re-uploading them | 5 |
| B-8803 | Search and filters: `knowledge_search` and the search route take label filters (`labels.any`, `labels.all`, minimum score); image hits return the caption, the OCR excerpt, the labels and a thumbnail URL readable at the caller's clearance; the agent and workflow knowledge steps can filter by label | A search filtered to one label returns only images carrying it at or above the score | 5 |
| B-8804 | Console: the Knowledge screen shows image documents with their thumbnail, caption, labels and scores, label filter chips, re-classify, and the classifier setting on a knowledge base; the Classifiers screen offers the `vision` engine; prototype boards first, axe-core and reflow checks in their own specs | An image document opens with its labels, and every control on it is backed by the server | 3 |
| B-8805 | Evaluation and docs: the `vision` engine follows the classifier publish rule (an evaluation with at least 200 labelled samples per label), with image datasets in the eval-set format; `docs/api.md`, `docs/openapi.json`, `docs/security.md` (what a caption or OCR text may leak, labels as metadata at the image's label) and `docs/accessibility.md` | A vision classifier with an evaluation below the minimum per label cannot publish | 3 |

## P2

### B-45 Tenant provisioning templates (5 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-4501 | Create a tenant from a template (workspaces, roles, profiles, a zone, an issuer) from the Tenants screen and the CLI; the platform's enterprise, team and personal organisation types as the first templates (decision Q11) | A tenant created from the team template signs in with its first admin in one step | 5 |

### B-46 Blob deduplication (5 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-4601 | Reference-counted blobs so identical uploads share storage, within one tenant only (the sealed-key boundary); the Storage screen shows the savings | Two uploads of one file in a tenant occupy one blob; deleting one leaves the other readable | 5 |

### B-47 Held form values (3 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-4701 | A public form value the `user-input` guardrail would hold is queued as a held submission for review instead of refused (B-2205 known gap) | A held submission appears in the moderation queue and is accepted into a record from there | 3 |

### B-48 Vault extras (16 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-4801 | Share a KV secret with a principal under the path policies, revocable, audited (Sprint 37) | A shared secret is readable by its grantee and by no one else the policy denies | 3 |
| B-4802 | A MongoDB engine for dynamic database credentials beside PostgreSQL and MySQL (B-1704) (Sprint 37) | An expired MongoDB lease's user no longer exists | 5 |
| B-4803 | Anomaly detection on reveals (a new address, an odd hour, a burst) raising a flag for the secret's owner (Sprint 36) | A burst of reveals from a new address raises a flag before the tenth reveal | 8 |

### B-49 Quote posts and per-post visibility (5 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-4901 | Quote a post with a comment, and public, workspace or unlisted visibility per post alongside its label | An unlisted post is reachable by link and absent from every feed | 5 |

### B-50 Capability tokens (dropped; was 8 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-5001 | **Dropped by the owner on 2026-10-07 (port decision D3: exprsn-platform's CA-signed bearer tokens stay out)**: one mechanism for exprsn-platform's CA tokens: a token bound to a URL, DID or content id with a permission set and a time or use expiry, issued and revoked from Settings and Identity; share links and scoped API keys become cases of it | A token with max uses 3 is refused on its fourth use and the refusal is audited | — |

## Industry gaps (research 2026-10-05)

From a deep-research gap analysis on 2026-10-05 of the merged product against self-hosted AI platforms (Open WebUI,
LibreChat, Dify), enterprise AI platforms (ChatGPT Enterprise, Microsoft Foundry, Google Vertex AI Agent Builder and
Security Command Center) and standards (NIST AI 600-1, the 2026-07-28 MCP specification). Each claim about a peer
was verified against its sources by three votes. Where Exprsn-AI already meets or beats the peer, the epic says so,
and the work is the missing part only. Peers and the standard named in each epic set the bar.

### P1

### B-69 Prompt-injection defence for untrusted content (16 points)

The 11 guardrail checkpoints screen prompts and answers, but there is no named, measurable control for instructions
hidden in retrieved chunks, crawled pages, tool results and MCP responses (indirect injection; NIST AI 600-1).
Peers: Microsoft Prompt Shields (user-prompt and document attacks, at input and at tool response, block or annotate),
Spotlighting, Google Model Armor (screens MCP `tools/call`).

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-6901 | Trust marking: every RAG chunk, crawled page, tool result and MCP response is wrapped as untrusted content (delimiters and a datamarking transform) before it reaches the model, per profile, on by default | A retrieved chunk saying "ignore previous instructions" reaches the model marked as data, and the profile's answer does not follow it on the corpus in B-6903 | 5 |
| B-6902 | An `untrusted-content` guardrail checkpoint with an injection classifier (a guard model or trained classifier) in block or annotate mode; detections are counted per source, audited `guardrail.injection.detected` and shown on the Guardrails screen | A poisoned web-crawl document is blocked in block mode and annotated in annotate mode, and both appear in the counts | 8 |
| B-6903 | An injection test corpus (direct and indirect, in documents, tool and MCP results) run in CI against the default profiles, with a detection-rate floor | CI fails when the detection rate on the corpus drops below the floor | 3 |

### B-70 Red-team harness (11 points)

Profile evaluations and their publish gate exist, and flags turn into eval cases. There is no adversarial suite
(NIST AI 600-1 MS-2.7-007: prompt injection, adversarial prompts, data poisoning, membership inference, model
extraction).

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-7001 | Red-team suites as an eval kind: attack sets (B-6903's corpus, jailbreaks, data exfiltration through tools, system-prompt extraction) run against profiles, agents and workflows, and the publish gate can require a passing red-team run | A profile that leaks its system prompt in the suite cannot be published while the gate is on | 8 |
| B-7002 | Red-team results on the Evaluations screen with each failed attack linked to a flag, and tenant-added attack cases | A failed attack opens as a flag that can be turned into an eval case | 3 |

### B-71 MCP server and MCP authorization (23 points)

Exprsn-AI is an MCP client only, and that client has no OAuth, so it cannot reach most authenticated remote MCP
servers for each user. Peers: Dify publishes apps and workflows as MCP servers (authenticated only by a secret in
the URL); LibreChat's MCP client does OAuth 2.0 with PKCE, refresh, dynamic client registration and per-user
connections. The 2026-07-28 MCP specification makes a protected server an OAuth 2.1 resource server (RFC 9728
metadata, RFC 8707 audience). Building on the existing OIDC provider, DPoP and PAR beats Dify's design.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-7101 | MCP server: publish workflows, agents, knowledge bases, registry tools and app records (list, query, count, aggregate, create, update, delete, as NocoDB's free edition does) as an MCP server over Streamable HTTP, one endpoint per workspace, tools in groups a client selects (as Supabase does), tools filtered by the caller's permissions and labels, every call through the guardrails and audited | Claude Desktop lists a published workflow as a tool and running it writes an audit event | 10 |
| B-7102 | MCP server authorization: the endpoint is an OAuth 2.1 resource server of the tenant's own issuer, with RFC 9728 protected resource metadata, `WWW-Authenticate` `resource_metadata`, RFC 8707 audience checks and DPoP where the client offers it | A token issued for another resource is refused with 401 and the metadata URL in the header | 5 |
| B-7103 | MCP client OAuth: Authorization Code with PKCE per user, dynamic client registration, metadata discovery with a manual fallback, refresh, tokens sealed with the tenant key, a per-user connect and disconnect in Settings | Two users of one MCP server act under their own accounts, and disconnecting revokes the stored token | 8 |

### B-72 SCIM 2.0 provisioning (11 points)

Identity otherwise beats the self-hosted peers (OIDC provider, SAML IdP, Kerberos, DPoP, passkeys). Without SCIM,
deprovisioning depends on LDAP or manual work, a SOC 2 CC6 weakness. Peers: Open WebUI ships SCIM 2.0 Users and
Groups; ChatGPT Enterprise provisions from Okta, Entra ID, Google Workspace, Ping and OneLogin.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-7201 | SCIM 2.0 `Users` and `Groups` per tenant (RFC 7643/7644: create, replace, patch, delete, filter, pagination) as a user store in the tenant's chain, bearer tokens under `identity:manage`; deactivation ends sessions, refresh tokens and API keys | Deactivating a user through SCIM ends their open console session within one request | 8 |
| B-7202 | Conformance against the Entra ID and Okta SCIM validators recorded in `docs/identity.md`; group membership maps to roles | The Entra ID validator passes with no failure | 3 |

### B-73 AI system inventory (8 points)

The model catalogue with dual-control approval is the core of an AI inventory. NIST AI 600-1 GV-1.6 asks for every
generative AI system with provenance, known issues, human-oversight roles and model lineage; Google Security
Command Center AI Protection inventories agents and MCP servers. It also feeds ISO/IEC 42001 and EU AI Act deployer
records.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-7301 | One inventory of models, profiles, agents, workflows, tools, MCP servers and datasets, each with an owner, an oversight role, data provenance, model lineage and known issues (linked flags and failed evaluations), on a new Inventory tab of the catalogue | An agent with no owner is listed as incomplete and cannot be published | 5 |
| B-7302 | Export the inventory as a register (CSV and JSON) with a tenant impact-assessment field per system, for ISO/IEC 42001 and EU AI Act deployer records | The export lists every published agent with its model lineage | 3 |

### P2

### B-74 Usage and cost analytics (10 points)

Open WebUI's Analytics page shows messages, tokens, users and chats by time range, group and model, but no costs.
Exprsn-AI already meters every chat, so a cost view goes beyond it.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-7401 | An Analytics screen: messages, tokens, users and runs by tenant, workspace, group, model, profile and user over a time range | Totals for a day match the metering records for that day | 5 |
| B-7402 | A price per model and instance (energy or a set rate for local models) and a chargeback export per workspace | A workspace's monthly export sums to the screen's total | 3 |
| B-7403 | OpenTelemetry GenAI semantic-convention attributes (`gen_ai.*`) on model spans so usage is portable to Grafana and other backends | A model span carries `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` | 2 |

### B-75 Compliance log export (5 points)

The per-tenant hash-chained audit with signed checkpoints is stronger on integrity than OpenAI's Compliance Logs
Platform, but there is no documented export or SIEM feed. The console log view stays deferred to 1.7.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-7501 | Per-tenant audit export as time-windowed JSONL files with their chain proofs, and streaming to a SIEM (syslog over TLS or an HTTPS endpoint), set up in Settings under dual control | An exported window verifies against its signed checkpoint offline | 5 |

### B-76 DLP, legal hold and eDiscovery for AI content (13 points)

PII scrubbing on datasets, output screening and clearance labels cover part of this. ChatGPT Enterprise's
Compliance API feeds Purview, Netskope, Zscaler, Relativity and others with conversations, files and memories for
legal hold, retention and PII monitoring. B-4206 adds legal-hold export for messaging only.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-7601 | Classify answers, agent outputs and uploads by detector (PII, secrets, tenant patterns) and raise their label, with a DLP rule to hold or redact by label | An answer containing a card number is labelled and redacted under the rule | 5 |
| B-7602 | Legal hold on users and workspaces that suspends retention purges for conversations, files, memories and runs, under dual control | Conversations of a held user survive their retention period | 3 |
| B-7603 | A compliance export API (conversations, files, memories, agent runs, users) with a scoped token, for eDiscovery tools | An export by user and date range returns every conversation in it, and the export is audited | 5 |

### B-77 Agent identities (8 points)

Agents and scheduled agents act under user or service credentials. Vertex AI Agent Builder makes each agent its own
IAM principal (preview). Workflows 2 agent steps and chaining (B-39, B-41) make this pressing.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-7701 | Each agent is a principal with its own roles, label ceiling and scoped API keys (capability tokens, B-50, were dropped on 2026-10-07), acting on behalf of a user only within both grants; audit events name the agent and the user | An agent granted read-only on a knowledge base cannot write to it even for an admin user | 8 |

### B-78 Agent handoffs (5 points)

LibreChat 0.8.1 has agent handoffs (beta). Chaining (B-41) is planned for 1.5.0; handoff builds on it. No peer's
A2A support was verified, so cross-system A2A stays unscheduled.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-7801 | An agent hands the conversation to a specialist agent listed in its configuration, with the context it chooses, and the reader sees which agent answers | A triage agent hands a billing question to the billing agent and the answer is attributed to it | 5 |

### B-79 Provenance for generated images (5 points)

NIST AI 600-1 makes content provenance a primary consideration (GV-4.3, GV-1.6). The tenant CA can sign it.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-7901 | Generated images carry a C2PA manifest (model, profile, time, tenant) signed by a tenant CA certificate, kept through the file store | A C2PA verifier reads a generated image's manifest and validates its signature | 5 |

### B-80 Versioned artifacts in chat (8 points)

LibreChat's artifacts have version control and show in shared conversations. Exprsn-AI has branches and compare.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-8001 | Code, documents and HTML that an answer produces open in a side panel with versions across turns, rendered sandboxed, visible to share readers | Editing an artifact in a later turn adds a version and the earlier one stays viewable | 8 |

## Low-code gaps (research 2026-10-05)

From a second deep-research pass on 2026-10-05 of the low-code apps against Power Platform and Dataverse, Retool,
Baserow and Directus. The baseline already leads Baserow on workflow automation (approval, guardrail and
sub-workflow steps) and Retool on self-hosted AI (local models instead of customer-managed keys), and meets the SSO
bar. None of the workbench mockups (provisional B-63 to B-68) closes the two P1 gaps below.

### P1

### B-81 Row and field permissions (16 points)

Clearance labels and org or group scope already filter some rows on the server. Peers set the bar higher: Dataverse
gives privileges per table with a scope, and column security with masking. Directus 11 has reusable policies with
per-field and conditional rules. Baserow has field permissions and restricted views (2.2, April 2026).

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-8101 | Policies: reusable rule sets per app entity with row conditions (record fields compared with the user's attributes, groups and roles), combined with labels and enforced in records queries, `/api` and `/v1` tools, forms, exports and workflows | A user whose policy allows rows where `region = user.region` sees only those rows through the screen, the API and an export | 8 |
| B-8102 | Field permissions per policy (read, read unmasked, create, update) with masking formats (last four, hash, hidden) | A masked field shows `***-**-1234` to a policy without read unmasked and the full value to one with it | 5 |
| B-8103 | A permissions editor on the Apps screen with an explain view (which policy grants a row or field to a user) | Explain names the policy that lets a user see a row | 3 |

### B-82 App packages, environments and promotion (21 points)

There is no version control, environments or governed promotion. Power Platform Pipelines move one fixed package
through stages with approvals before production, backups and rollback. Retool links instances to git and has
multi-instance releases (GA January 2026, Enterprise). The in-product pipeline model is chosen here, because tenants
may share one instance (open decision below); git export is an extra.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-8201 | App packages: export and import an app (entities, fields, formulas, forms, state machines, triggers, workflows, policies) as a versioned, signed package, data optional | A package imported into an empty workspace runs the app the same way, and a tampered package is refused | 5 |
| B-8202 | Environments and promotion: each app has development, test and production stages (workspaces or app slots); promotion moves the same package from stage to stage, cannot skip one, and needs approval through the Workflows approval step before production; audited `app.package.promoted` | A promotion to production waits for an approver and lands the exact package that passed test | 8 |
| B-8203 | Automatic backup before each deployment, a deployment history on the Apps screen (source, target, version, who, status, 365 days) and rollback from it | Rolling back restores the previous version's schema and behaviour, and the rollback is audited | 5 |
| B-8204 | Git export and import of a package to a repository (one file per object, readable diffs) | Committing the package and importing it on another instance gives the same app | 3 |

### P2

### B-83 Data model generation from a description (8 points)

Baserow 2.2's assistant builds tables, formulas, automations and whole apps; Power Apps Plans (GA May 2025)
generates Dataverse models. Generating whole apps waits for an app builder (workbench mockup B-63); generating the
data model works on today's entity model, with the local models.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-8301 | Describe an app and get a draft: entities, fields, relations, formulas, state machines and triggers, shown as a diff to accept or edit, through the profile's guardrails | A description of a leave-request app gives a draft with a request entity and an approval state machine that can be accepted in one step | 8 |

### B-84 AI field upgrades (6 points)

Baserow 2.0's AI fields regenerate when the fields they read change, take references and functions as input, and
fill every row in one action. Check the 1.4.0 AI fields against these first; drop what already works.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-8401 | AI field prompts built from field references and formula functions, regenerated when a referenced field changes (debounced, metered) | Editing a referenced field regenerates the AI value once | 3 |
| B-8402 | Fill or refresh an AI field for every row as a job, with progress, a cost estimate first and a cancel | A fill over 1,000 rows runs as one job and can be cancelled midway | 3 |

### B-85 External database sync (8 points)

Baserow (1.35) syncs two ways with an outside PostgreSQL database. Exprsn-AI apps store records only in their own
database. The database management mockup (B-68) would cover this only if it includes outside connections.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-8501 | Attach a table in an outside PostgreSQL or MySQL database as an app entity, with credentials from the vault (dynamic leases where available), writes through to the source and a scheduled pull | A row changed in the outside table appears in the app after the next pull, and an app edit reaches the outside table at once | 8 |

### Second pass (APIs, embedding, components)

A second low-code research pass on 2026-10-05 covered NocoDB, Supabase, ToolJet, Budibase and Airtable. Exprsn-AI
meets or beats NocoDB's free edition (no SSO, audit, 2FA or SCIM, one workspace), and ToolJet and Budibase charge
for authenticated embedding, so shipping these in the base product is a differentiator. No peer publishes record
query latency to compare with the 732 ms p95. Custom code components (ToolJet's React component, Budibase plugins)
belong with the app builder (workbench mockup B-63) and are noted on its open decision; for many tenants on one
instance they need an iframe or CSP sandbox and per-tenant plugin approval, which the peers leave undocumented.

### P1

### B-86 Entity APIs (13 points)

Supabase generates a REST API from the schema (PostgREST, under row security); NocoDB has record (Data) and schema
(Meta) APIs with API tokens. Exprsn-AI apps have no API per entity.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-8601 | A REST API per app entity (`/api/apps/:app/:entity`): list with filter, sort and pagination, read with related records, create, update, delete; every call under the B-81 policies and field permissions and the labels, with scoped tokens (scoped API keys limited to the app and entity; capability tokens, B-50, were dropped on 2026-10-07) | A token scoped to one entity read-only lists its rows, with masked fields masked, and is refused on any write | 8 |
| B-8602 | A schema API for entities, fields, forms and state machines under `apps:manage`, each change audited and versioned into the app package (B-8201) | Adding a field through the schema API shows in the app and in the next package export | 3 |
| B-8603 | An OpenAPI document per app, regenerated when its schema changes, and a TypeScript client generated from it | The generated client creates a record against a fresh app with no hand-written code | 2 |

### P2

### B-87 App embedding (8 points)

ToolJet has public embeds and private embeds with per-user, per-app tokens; Budibase embeds through an iframe with a
host-signed JWT (ES256, RS256 or HS256). Both charge for the authenticated kind.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-8701 | Public embeds of an app's public pages and forms, with an allowlist of host sites per app (`frame-ancestors`) | An app page embeds on an allowed site and is refused by the browser on any other | 3 |
| B-8702 | Signed embeds: the host site signs a short-lived JWT with a key registered for the app (or a tenant CA certificate), mapped to an existing user by a configurable claim; the embedded session is scoped to that app, expires on its own and is kept apart from console sessions; audited | An embed with an expired or wrongly signed token is refused, and a valid one sees only what the mapped user may | 5 |

## Platform port (decisions of 2026-10-06)

From `docs/exprsn-platform-port-findings.md` (compiled 2026-10-06, kept outside the repository), whose 23 decisions the
owner answered on 2026-10-06. The port items go to 1.7.0 (`Backlog-1.7.0.md`, B-90 to B-99 and B-112 to B-114) except
this one, which is wanted early: platform-tools could not create HTTP-backed tools.

### P1

### B-89 HTTP tool kind (10 points)

Added 2026-10-07 (findings section 4.10, decision D11c: port it). exprsn-platform's agent runtime (cortex) had an HTTP
tool kind; Exprsn-AI's registry has built-in, MCP, script and workflow tools, so calling an outside HTTP API means
writing an MCP server or publishing a workflow as a tool, and workflow HTTP steps reach internal hosts only
(`workflows/http.ts`). The owner chose to port it against the findings' first suggestion (use MCP or a workflow
instead); it is built with the constraints the findings set: the outbound address guard, credentials only as vault
references, and the tool-call guardrail.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-8901 | `impl: http` registry tools: method (GET, POST, PUT, PATCH, DELETE), a URL template whose path and query parameters come from the tool's JSON input schema, header and body templates, a response mapping (a JSON pointer or the body, capped in size) and a timeout; GET tools are `read`, every other method `write` unless the author raises it to `destructive`; drafts go through the registry's review and publish lifecycle like any tool | A published GET tool answers a chat tool call with the mapped field, and a PATCH tool is offered only where write tools are | 3 |
| B-8902 | The outbound address guard: every call goes through `platform/egress.ts` (resolved once, every address checked, the connection pinned, redirects not followed); internal hosts only as the service allow-list permits, public hosts only from a per-tenant list a tenant admin keeps (the list workflow HTTP steps reuse, B-9101); secret-bearing headers, query parameters and body fields only as `vault:path#key` references resolved at call time, never stored literally | A tool whose host resolves to 169.254.169.254, or to a public host off the tenant's list, is refused; saving a literal `Authorization` header is refused | 3 |
| B-8903 | Guardrails, limits and audit: arguments pass the tool-call guardrail before the request and the result after it, marked as untrusted content (B-6901); calls count against the registry's tool rate limits; each call is metered and audited `registry.http.called` with host, method, status, size and latency, never a secret value | A response carrying an injected instruction reaches the model marked as data, and the audit entry names the host without the header's secret | 2 |
| B-8904 | Console: the Registry screen's tool form gets the HTTP kind (method, URL template, parameters mapped from the schema, vault reference pickers, response mapping) with a test call through the guard, and the tenant's list of allowed public hosts; prototype board first, its specs with axe-core and the reflow checks | An HTTP tool is created, tested and published from the console with no axe or reflow finding | 2 |

## Release

| ID | Item | Done when |
| --- | --- | --- |
| B-5101 | Version `1.6.0`, the CHANGELOG, `docs/api.md`, `docs/permissions.md`, `docs/accessibility.md` and the known-gaps sections updated as each item lands; the full Playwright suite run locally at the end of the release, its findings fixed and the cross-screen sweeps (`a-first-look`, `zz-every-screen`, `y-accessibility`, `y-reflow`, `y-reflow-overlays`) green (owner, 2026-10-06: sprints run only the specs of the screens they change) (Sprint 39; was Sprint 37 before the gaps were merged on 2026-10-07) | The full Playwright suite passes locally and in CI |

---

## Still deferred

| Item | Decision |
| --- | --- |
| Live streaming | Dropped (2026-10-05): no live streaming in Exprsn-AI |
| End-to-end-encrypted messaging | Dropped (2026-10-05): server-side guardrails and AI features stay |
| Governance voting | 1.7 or later (port decision D7); B-116 in [Backlog-1.7.0.md](Backlog-1.7.0.md) since 2026-10-07, unscheduled |
| Recurring events and VTIMEZONE in calendar feeds | 1.7 or later |
| Web push notifications | 1.7 or later |
| SMS one-time codes | 1.7 or later; needs a paid SMS provider |
| Server log view in the console | 1.7 or later; traces and metrics only for now (the audit export and SIEM feed are B-75) |
| A2A protocol between systems | Unscheduled; no peer's A2A support was verified (2026-10-05 research); handoffs inside one instance are B-78 |
| CA-signed bearer tokens and capability tokens (B-5001) | Dropped (2026-10-07, port decision D3) |
| A tenant-wide or public feed, explore and trending posts | Dropped (2026-10-06, port decision D4): workspace and group feeds only |
| Self-serve organizations | Dropped (2026-10-06, port decision D5): tenants and workspaces stay; tenant templates are B-4501 |
| Hardware key custody (HSM, PKCS#11) and FIPS mode | Left open (2026-10-06, port decision D10) |
| An IPFS blob backend | Dropped (2026-10-06, port decision D11e) |
| A tenant's own handle domain for the PDS | Deferred from 1.5.0 (B-2901); not yet groomed |

## Open decisions

- [x] Capability tokens (B-5001): closed; B-5001 was dropped on 2026-10-07 (port decision D3), so share links and
  scoped API keys keep their own tables.
- [ ] Group locations (B-4403): is a location visible to every member who can see the group, or only to members?
- [ ] Model servers (B-43): is Apple's on-device model also offered as a `classify` fallback beside TEV on Apple
  silicon nodes?
- [x] Industry gaps: a fourth sprint for 1.6.0, or move P2 gap epics to 1.7? Answered 2026-10-07: the owner merged the
  gaps into 1.6.0, now Sprints 37 to 39 after Sprint 36 took image classification.
- [ ] Injection classifier (B-6902): a guard model through the existing guard-model path, or a trained classifier
  (weak below 200 labels a class, a 1.4.0 known gap)?
- [ ] App promotion (B-82): an in-product pipeline with fixed packages and approvals, like Power Platform (assumed),
  or git-backed releases across instances, like Retool?
- [ ] Workbench mockups (provisional B-63 to B-68): schedule them in 1.6.0 or 1.7? Whole-app generation and the
  visual builder wait for B-63, and so do custom code components (sandboxed in an iframe or under CSP, approved per
  tenant), which the second research pass found at ToolJet and Budibase.
- [x] A fifth sprint (39) for the second-pass items and the release? Answered 2026-10-07: yes, Sprint 39 carries them and the
  release.
- [ ] HTTP tool kind (B-89): one tenant list of allowed public hosts shared with workflow HTTP steps (B-9101, 1.7.0), as
  assumed, or a host list per tool?

## Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Configuration overrides | A bad override takes every instance down at the next restart | Dual control, the descriptor's types and constraints, restart-required settings flagged, and the environment value restored by removing the override |
| Blob deduplication | A shared blob deleted with one reference loses another tenant's or user's file | Dedup within a tenant only, reference counts in the same transaction as the file row, the integrity job (B-4204) checks counts |
| Injection trust marking | Marking every chunk as untrusted lowers answer quality on some models | Per-profile switch, measured with the B-6903 corpus and the profile's evaluations before it becomes default |
| MCP server | A published tool reachable from outside widens the attack surface | OAuth resource server with audience checks, tools filtered by permission and label, every call through the guardrails and audited |
| Row policies | Row conditions slow records queries further (p95 732 ms against 250 ms in 1.4.0) | Record queries (B-3601) land first; policies compile to indexed SQL filters and the load test covers a policy-filtered query |
| HTTP tool kind | A tool reaches an internal service or leaks a credential | The egress guard on every call, public hosts only from the tenant's list, secrets only as vault references, results marked as untrusted |
| Vault sharing | A share widens who reads a secret beyond its policy | Shares are policy grants, explain names them, anomaly detection (B-4803) ships first |
