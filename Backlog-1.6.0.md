# Backlog: 1.6.0

The work after 1.5.0, groomed by the owner on 2026-10-05 with `design/grooming/groom.mjs` (state in
`design/grooming/grooming.json`). 1.5.0 gives the merged exprsn-platform features their screens; 1.6.0 finishes the
platform's administration surface (the five admin screens designed in `design/platform-admin/README.md`), fills the
remaining exprsn-platform gaps that Exprsn-AI wants (groups depth, tenant templates, blob deduplication, vault
extras, capability tokens, quote posts) and closes two 1.4.0 known gaps. Rules as before: everything follows
`docs/PLAN.md` and `CLAUDE.md`; screens follow `design/prototype/CONTRACT.md` (prototype board first, then live when
every control is backed by the server); every server item ships its routes, permission, audit events, jobs, tests on
SQLite, PostgreSQL and MySQL, `docs/api.md` and `docs/openapi.json` entries and any known gaps in `docs/security.md`.

**Size.** 27 items, 137 points (1 point ≈ half a day for one engineer, tests included): P1 95, P2 42. At about 78
points a sprint that is under two sprints of work spread over three, leaving room for what 1.5.0 carries over (Sprint
31 was accepted at 93 points) and for new requests.

**Builds on.** The B-4201 boards (Overview, Jobs and queues, Storage, Configuration, Social and messaging) and the
sixteen answered design questions (`design/platform-admin/DECISIONS.md`); the `JobQueue`, `Scheduler` and tenant cache
(B-2102); the blob store and attachment quarantine; B-25 groups and events; the B-17 vault; B-27 feed.

## Sprints

| Sprint | Theme | Items | Points | Status |
| --- | --- | --- | --- | --- |
| 35 | Platform administration live screens; tenant provisioning templates; model servers beyond Ollama | B-4202–B-4207, B-4501, B-4301–B-4307 | 76 | Next |
| 36 | Groups depth and categories; blob deduplication; held form values queued; vault access anomalies | B-4401–B-4405, B-4601, B-4701, B-4803 | 40 | Planned |
| 37 | Quote posts and per-post visibility; capability tokens; vault sharing and MongoDB leases; release | B-4901, B-5001, B-4801, B-4802, B-5101 | 21 | Planned |

The order follows the dependencies: the Storage screen (B-4204) before blob deduplication shows its savings (B-4601);
the Social and messaging screen (B-4206) before group categories are managed from it (B-4405); vault anomaly detection
(B-4803) before secret sharing widens who reads a secret (B-4801); the gateway interface (B-4301) before any `openai`
instance (B-4302), and both before the Models screen changes (B-4307).

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

### B-50 Capability tokens (8 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-5001 | One mechanism for exprsn-platform's CA tokens: a token bound to a URL, DID or content id with a permission set and a time or use expiry, issued and revoked from Settings and Identity; share links and scoped API keys become cases of it | A token with max uses 3 is refused on its fourth use and the refusal is audited | 8 |

## Release

| ID | Item | Pts |
| --- | --- | --- |
| B-5101 | Version `1.6.0`, the CHANGELOG, `docs/api.md`, `docs/permissions.md`, `docs/accessibility.md` and the known-gaps sections updated as each item lands (Sprint 37) | — |

---

## Still deferred

| Item | Decision |
| --- | --- |
| Live streaming | Dropped (2026-10-05): no live streaming in Exprsn-AI |
| End-to-end-encrypted messaging | Dropped (2026-10-05): server-side guardrails and AI features stay |
| Governance voting | 1.7 or later |
| Recurring events and VTIMEZONE in calendar feeds | 1.7 or later |
| Web push notifications | 1.7 or later |
| SMS one-time codes | 1.7 or later; needs a paid SMS provider |
| Server log view in the console | 1.7 or later; traces and metrics only for now |
| A tenant's own handle domain for the PDS | Deferred from 1.5.0 (B-2901); not yet groomed |

## Open decisions

- [ ] Capability tokens (B-5001): do share links and scoped API keys migrate onto the new mechanism in 1.6.0, or keep
  their own tables with the token model added beside them?
- [ ] Group locations (B-4403): is a location visible to every member who can see the group, or only to members?
- [ ] Model servers (B-43): is Apple's on-device model also offered as a `classify` fallback beside TEV on Apple
  silicon nodes?

## Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Configuration overrides | A bad override takes every instance down at the next restart | Dual control, the descriptor's types and constraints, restart-required settings flagged, and the environment value restored by removing the override |
| Blob deduplication | A shared blob deleted with one reference loses another tenant's or user's file | Dedup within a tenant only, reference counts in the same transaction as the file row, the integrity job (B-4204) checks counts |
| Vault sharing | A share widens who reads a secret beyond its policy | Shares are policy grants, explain names them, anomaly detection (B-4803) ships first |
