# Backlog: 1.6.0

The work after 1.5.0, groomed by the owner on 2026-10-05 with `design/grooming/groom.mjs` (state in
`design/grooming/grooming.json`). 1.5.0 gives the merged exprsn-platform features their screens; 1.6.0 finishes the
platform's administration surface (the five admin screens designed in `design/platform-admin/README.md`), fills the
remaining exprsn-platform gaps that Exprsn-AI wants (groups depth, tenant templates, blob deduplication, vault
extras, capability tokens, quote posts), closes two 1.4.0 known gaps and the industry gaps found by the 2026-10-05
research (prompt-injection defence, red-teaming, MCP server and authorization, SCIM, an AI inventory and seven P2
epics). Rules as before: everything follows
`docs/PLAN.md` and `CLAUDE.md`; screens follow `design/prototype/CONTRACT.md` (prototype board first, then live when
every control is backed by the server); every server item ships its routes, permission, audit events, jobs, tests on
SQLite, PostgreSQL and MySQL, `docs/api.md` and `docs/openapi.json` entries and any known gaps in `docs/security.md`.

**Size.** 43 items, 224 points (1 point ≈ half a day for one engineer, tests included): P1 128, P2 96. The industry
gaps (B-69 to B-80, 23 items, 121 points) were added on 2026-10-05 and need a fourth sprint, 38, which now carries
the release. Sprints 35 and 36 are at 69 points, under the 78-point pace.

**Builds on.** The B-4201 boards (Overview, Jobs and queues, Storage, Configuration, Social and messaging) and the
sixteen answered design questions (`design/platform-admin/DECISIONS.md`); the `JobQueue`, `Scheduler` and tenant cache
(B-2102); the blob store and attachment quarantine; B-25 groups and events; the B-17 vault; B-27 feed.

## Sprints

| Sprint | Theme | Items | Points | Status |
| --- | --- | --- | --- | --- |
| 35 | Platform administration live screens; tenant provisioning templates; prompt-injection defence; SCIM | B-4202–B-4207, B-4501, B-6901–B-6903, B-7201–B-7202 | 69 | Planned |
| 36 | Groups depth and categories; blob deduplication; held form values queued; vault access anomalies; MCP server and authorization; AI inventory | B-4401–B-4405, B-4601, B-4701, B-4803, B-7101–B-7103, B-7301–B-7302 | 69 | Planned |
| 37 | Quote posts and per-post visibility; capability tokens; vault sharing and MongoDB leases; red-team harness; usage and cost analytics; compliance log export; agent identities | B-4901, B-5001, B-4801, B-4802, B-7001–B-7002, B-7401–B-7403, B-7501, B-7701 | 55 | Planned |
| 38 | DLP, legal hold and eDiscovery; agent handoffs; image provenance; versioned artifacts; release | B-7601–B-7603, B-7801, B-7901, B-8001, B-5201 | 31 | Planned |

The order follows the dependencies: the Storage screen (B-4204) before blob deduplication shows its savings (B-4601);
the Social and messaging screen (B-4206) before group categories are managed from it (B-4405); vault anomaly detection
(B-4803) before secret sharing widens who reads a secret (B-4801); injection trust marking and its corpus (B-6901,
B-6903) before the red-team suites reuse the corpus (B-7001); MCP server authorization (B-7102) in the same sprint
as the server (B-7101); capability tokens (B-5001) before agent identities use them (B-7701); chaining (B-41,
1.5.0) before agent handoffs (B-7801).

---

## P1

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

### B-71 MCP server and MCP authorization (21 points)

Exprsn-AI is an MCP client only, and that client has no OAuth, so it cannot reach most authenticated remote MCP
servers for each user. Peers: Dify publishes apps and workflows as MCP servers (authenticated only by a secret in
the URL); LibreChat's MCP client does OAuth 2.0 with PKCE, refresh, dynamic client registration and per-user
connections. The 2026-07-28 MCP specification makes a protected server an OAuth 2.1 resource server (RFC 9728
metadata, RFC 8707 audience). Building on the existing OIDC provider, DPoP and PAR beats Dify's design.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-7101 | MCP server: publish workflows, agents, knowledge bases and registry tools as an MCP server over Streamable HTTP, one endpoint per workspace, tools filtered by the caller's permissions and labels, every call through the guardrails and audited | Claude Desktop lists a published workflow as a tool and running it writes an audit event | 8 |
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
| B-7701 | Each agent is a principal with its own roles, label ceiling and capability tokens (B-50), acting on behalf of a user only within both grants; audit events name the agent and the user | An agent granted read-only on a knowledge base cannot write to it even for an admin user | 8 |

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

## Release

| ID | Item | Pts |
| --- | --- | --- |
| B-5201 | Version `1.6.0`, the CHANGELOG, `docs/api.md`, `docs/permissions.md`, `docs/accessibility.md` and the known-gaps sections updated as each item lands (Sprint 38; renumbered from B-5101, which 1.5.0 uses for profiles) | — |

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
| Server log view in the console | 1.7 or later; traces and metrics only for now (the audit export and SIEM feed are B-75) |
| A2A protocol between systems | Unscheduled; no peer's A2A support was verified (2026-10-05 research); handoffs inside one instance are B-78 |
| A tenant's own handle domain for the PDS | Deferred from 1.5.0 (B-2901); not yet groomed |

## Open decisions

- [ ] Capability tokens (B-5001): do share links and scoped API keys migrate onto the new mechanism in 1.6.0, or keep
  their own tables with the token model added beside them?
- [ ] Group locations (B-4403): is a location visible to every member who can see the group, or only to members?
- [ ] Industry gaps: is a fourth sprint (38) acceptable for 1.6.0, or should some of the P2 gap epics (B-74 to B-80)
  move to 1.7?
- [ ] Injection classifier (B-6902): a guard model through the existing guard-model path, or a trained classifier
  (weak below 200 labels a class, a 1.4.0 known gap)?

## Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Configuration overrides | A bad override takes every instance down at the next restart | Dual control, the descriptor's types and constraints, restart-required settings flagged, and the environment value restored by removing the override |
| Blob deduplication | A shared blob deleted with one reference loses another tenant's or user's file | Dedup within a tenant only, reference counts in the same transaction as the file row, the integrity job (B-4204) checks counts |
| Injection trust marking | Marking every chunk as untrusted lowers answer quality on some models | Per-profile switch, measured with the B-6903 corpus and the profile's evaluations before it becomes default |
| MCP server | A published tool reachable from outside widens the attack surface | OAuth resource server with audience checks, tools filtered by permission and label, every call through the guardrails and audited |
| Vault sharing | A share widens who reads a secret beyond its policy | Shares are policy grants, explain names them, anomaly detection (B-4803) ships first |
