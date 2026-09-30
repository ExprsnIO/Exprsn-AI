# API reference

Every route is under `/api`, takes and returns JSON, and fails with RFC 9457 problem details
(`application/problem+json`, with `trace_id`). Cookie sessions send `X-CSRF-Token` on unsafe methods; API keys send
`Authorization: Bearer exai_k1_…` and may pick a workspace with `X-Workspace: <id>`. Timestamps are epoch
milliseconds; days in usage reports are `YYYYMMDD` integers in queries and `YYYY-MM-DD` strings in answers. Labels
are `public < internal < confidential < restricted`.

Sprint 1 routes (`/api/auth/*`, `/api/me` profile, factors, API keys and sessions, `/api/admin/{identity-providers,
test-login, group-mappings, roles, users, sessions}`) are described in [identity.md](identity.md).

## Me (Sprint 2 additions)

| Method and path | What it does |
| --- | --- |
| `GET /me` | Now also returns `workspaces` (the ones the caller may use) and `workspace` (the current one) |
| `PUT /me/workspace` `{workspaceId}` | Switches the session's current workspace |
| `GET /me/notifications` | `{items: [{id, kind, title, body, route, label, createdAt, read}], email}` |
| `POST /me/notifications/read` `{ids?}` | Marks the given (or all) notifications read |
| `GET /me/jobs` | Jobs the caller started: `{id, type, state, progress, message, error, createdAt, finishedAt}` |
| `POST /me/jobs/:id/cancel` | Cancels one of them |

Socket events for the signed-in user: `notification` (a notification as above), `job.progress`
`{id, type, state, progress, message}`, `session.revoked`.

## Tenants and workspaces (`tenant:manage`)

A tenant admin works in their own tenant; system admins may act on any tenant. `:tid` is a tenant id.

| Method and path | What it does |
| --- | --- |
| `GET /admin/tenants` | Tenants the caller may manage: `{id, slug, name, directoryDn, state, users, key: {kms, name, version, state}, quota, lastSync, workspaces: [workspace]}` |
| `GET /admin/tenants/:tid` | One tenant, same shape |
| `POST /admin/tenants` `{slug, name, directoryDn?}` | System admin: creates a tenant with a local user store and its data key |
| `PATCH /admin/tenants/:tid` `{name?, directoryDn?, state?: active\|disabled}` | Renames; only system admins change state (never their own tenant) |
| `POST /admin/tenants/:tid/offboard` `{confirm: <tenant name>}` | System admin: destroys the tenant key, revokes every session and key, queues the purge job. `202 {keyVersionsDestroyed, sessionsRevoked, apiKeysRevoked, jobId}` |
| `GET/PUT /admin/tenants/:tid/quota` | Tenant totals `{tokensPerDay, gpuSecondsPerMonth, trainingGpuHoursPerMonth}` (null = unlimited). PUT is system admin only |
| `GET /admin/tenants/:tid/workspaces` | Workspaces including archived |
| `POST /admin/tenants/:tid/workspaces` `{name, description?, labelCeiling, visibility: tenant\|members, mapping?: {group, role, clearance, providerId?}}` | Creates a workspace, optionally with its first group mapping |
| `PATCH /admin/tenants/:tid/workspaces/:wid` `{name?, description?, labelCeiling?, visibility?, state?: active\|archived}` | Updates or archives |
| `GET /admin/tenants/:tid/workspaces/:wid/members` | `{id, username, displayName, clearance, state, lastLoginAt, sources: [direct\|mapping], roles}` |
| `POST /admin/tenants/:tid/workspaces/:wid/members` `{userId}` | Adds a direct member |
| `DELETE /admin/tenants/:tid/workspaces/:wid/members/:uid` | Removes a direct membership |
| `GET/PUT /admin/tenants/:tid/workspaces/:wid/quota` | Workspace limits, capped by the tenant's |
| `POST /admin/authz/evaluate` `{userId, action, label?, zoneCeiling?}` | Explains the policy pipeline for a user: `{user, decision, steps: [{step, ok, detail}]}` |

A workspace is `{id, tenantId, name, slug, description, label, visibility, state, members, createdAt, updatedAt}`.
A quota view is `{scope, workspaceId, tokensPerDay, gpuSecondsPerMonth, trainingGpuHoursPerMonth, used: {tokensToday,
gpuSecondsMonth, trainingGpuHoursMonth}, resets: {daily, monthly}, updatedAt}`.

Group mappings (`/admin/group-mappings`, `identity:manage`) take an optional `workspaceId`; a mapping with a
workspace also makes the group's members members of it. `PATCH /admin/group-mappings/:id` edits one.
`POST /admin/identity-providers/:id/sync` runs directory sync for one store now (`202 {jobId}`).

Over quota, interactive requests fail with `429`, `Retry-After`, and `{limit, scope, used, max, resets_at,
raised_by}` in the problem.

## Usage (`usage:read`)

| Method and path | What it does |
| --- | --- |
| `GET /admin/usage/summary?by=user\|model\|workspace\|profile\|tenant&days=14&from&to&workspace` | `{by, from, to, rows: [{key, name, prompt, output, thinking, calc, gpuMs, requests}]}`; `tenant` is for system admins |
| `GET /admin/usage/daily?days=14&workspace` | One entry per day: `[{day, tokens, gpuSeconds}]` |
| `GET /admin/quotas` | `{tenant: quota view, workspaces: [{id, name, label, ...quota view}]}` |
| `POST /admin/usage/exports` `{from?, to?, workspaceId?}` | Queues a usage CSV export (`202`, an export) |

## Audit (`audit:read`)

| Method and path | What it does |
| --- | --- |
| `GET /admin/audit?kind&action&from&to&label&actor&limit&before` | Events, newest first; rows above the reader's clearance are redacted |
| `GET /admin/audit/summary` | `{head: {seq, hash, ts}, eventsToday, checkpoint, lastVerification, siem}` |
| `GET /admin/audit/:id` | One event plus `correctedBy: [{id, seq, ts}]` |
| `POST /admin/audit/verify` | Recomputes the chain and checks every signed checkpoint: `{status, checked, head, brokenAt?, checkpoints: {checked, failed}, lastGoodCheckpoint, notified}` |
| `GET/POST /admin/audit/checkpoints` | Lists, or signs the current head |
| `POST /admin/audit/:id/corrections` `{reason, correction}` | Appends a correction row (original actor or tenant admin) |
| `GET /admin/audit/stream` | SIEM stream status `{enabled, url, state, delivered, pending, dropped, lastDeliveredAt, lastError}` |
| `POST /admin/audit/exports` `{kind?, action?, from?, to?, label?, actor?, filtered}` | Queues a CSV export. Without `filtered`, a selection with rows above the caller's clearance fails `403 Export blocked` with `{total, above, clearance}` |
| `GET /admin/exports` | Exports (audit ones need `audit:read`, usage ones `usage:read`) |
| `GET /admin/exports/:id/download` | The CSV (logged to audit), streamed part by part; a part that fails to open ends the connection |

An export is `{id, kind, file, scope, maxLabel, state: queued|running|ready|failed, rows, omitted, jobId, createdBy,
createdByName, createdAt}`.

## Ollama gateway (Sprint 3)

Pools, instances and the model catalogue are shared by every tenant; profiles belong to one. Pool routes need
`pools:manage`, catalogue changes `models:manage` (reading it `models:read`), profiles `profiles:manage`.

### Pools and instances

| Method and path | What it does |
| --- | --- |
| `GET /admin/pools` | Live snapshot: pools with `placements` and `instances` (below) |
| `POST /admin/pools` `{name, accelerator: cuda\|rocm\|metal\|cpu, zone, labelCeiling, description?}` | Creates a pool |
| `PATCH /admin/pools/:id`, `DELETE /admin/pools/:id` | Edits; deletes an empty pool |
| `POST /admin/pools/:id/upgrade` `{targetVersion, waitMinutes}` | Rolling Ollama upgrade job (`202 {jobId}`): drains one instance at a time, waits for it to report the target version, reloads pinned models |
| `POST /admin/pools/:id/instances` `{name, url, deploy: docker\|baremetal, tls?: {caFile, certFile, keyFile}, settings}` | Registers an Ollama endpoint; `settings`: `memoryBytes, hardware, node, device, parallel, maxLoaded, numCtx, kvCacheType, keepAlive` |
| `PATCH /admin/instances/:id` `{url?, tls?, settings?, state?: active\|disabled}`, `DELETE /admin/instances/:id` | Edits, removes |
| `GET /admin/instances/:id/plan?model=<name>` | Memory planner: `{fits, resident, needBytes, freeBytes, evict: [names], reason}` |
| `GET /admin/instances/:id/events` | Load, unload, eviction and pull history `[{model, event, reason, actor, ts}]` ("why is this cold?") |
| `POST /admin/instances/:id/load` `{model, pinned}` | Loads (evicting warm models if the plan says so). `409 No spare memory` with `plan`; `429` with `limit: anti_thrash` |
| `POST /admin/instances/:id/unload` `{model}` | Unloads |
| `POST /admin/instances/:id/drain`, `POST /admin/instances/:id/undrain` | Stops routing, waits for requests, unloads; returns to service |

A snapshot instance: `{id, pool_id, name, url, deploy, settings, state, health: unknown|healthy|degraded|unreachable,
health_detail, version, last_seen_at, latencyMs, firstTokenMs, inflight, queued, parallel, memory: {totalBytes,
usedBytes, freeBytes}, loaded: [{name, sizeBytes, vramBytes, expiresAt, residency: pinned|warm|draining,
estimateBytes, drift}], loading: [names], available: [{name, sizeBytes, digest}]}`. The socket event `pools.state`
(to holders of `pools:manage`) says the snapshot changed.

### Placements

| Method and path | What it does |
| --- | --- |
| `POST /admin/placements` `{modelId, poolId, residency: pinned\|warm\|cold, pull: true}` | Places a model on a pool (refused when the model's label is above the pool's ceiling) and queues the pull (`jobId`) |
| `PATCH /admin/placements/:id` `{residency}`, `DELETE /admin/placements/:id` | Changes residency; removes |

### Model catalogue

Lifecycle: `draft → evaluated → approved → deprecated → retired`.

| Method and path | What it does |
| --- | --- |
| `GET /admin/models` | Models with `pools: [{placementId, poolId, pool, residency}]` and `profiles` (count) |
| `POST /admin/models` `{name, source, expectedDigest?, license?: {name, url?, notes?}, label, notes?, poolId?}` | Import request. Pickle sources are refused (`422 Import refused`, `reason: pickle`); with `poolId` it is placed and pulled |
| `PATCH /admin/models/:id` `{license?, label?, notes?}` | Records the licence and so on |
| `POST /admin/models/:id/pull` `{poolId}` | Pulls again (job). A digest mismatch or a non-GGUF/safetensors format deletes the blob and fails the import |
| `POST /admin/models/:id/evaluate` | Conformance job: chat smoke test, and a tool-calling test for models claiming tools (failing it withholds tools). Passing moves draft → evaluated |
| `POST /admin/models/:id/lifecycle` `{to: approved\|deprecated\|retired, retireAt?, reason?}` | Approval needs an evaluation, a recorded licence and a second person (`403` with `step: dual-control` for the requester) |

A model: `{id, name, family, parameterSize, quantization, format, sizeBytes, contextLength, capabilities, source,
expectedDigest, digest, license, label, state, importState: pending|pulling|pulled|failed, importError, evaluation:
{at, instance, tests: [{name, ok, detail}], passed, total, toolsWithheld}, requestedBy, approvedBy, approvedAt,
retireAt, notes, createdAt, updatedAt}`.

### Profiles

| Method and path | What it does |
| --- | --- |
| `GET /admin/profiles` | Profiles with `model {id, name, state, label, capabilities, digest}`, `pool` (name), `canaryModel`, `residency: loaded\|cold\|unavailable\|none` |
| `POST /admin/profiles` `{name, displayName, aliasOf?, modelId?, poolId?, numCtx?, temperature?, thinkDefault?, thinkCeiling?, systemPrompt?, fallback?: {profileId, afterQueueWaitMs}, tools?: ['calculate'], label?, description?}` | Creates a draft (an alias is created published and only points at another profile) |
| `PATCH /admin/profiles/:id` (same fields, plus `note`) | Saves a new version |
| `POST /admin/profiles/:id/publish` `{status: published\|disabled\|draft}` | Publishing checks: approved model, placed on a pool cleared for the profile's label, thinking and tools supported |
| `PUT /admin/profiles/:id/canary` `{modelId, percent}`, `POST /admin/profiles/:id/canary/promote`, `DELETE /admin/profiles/:id/canary` | Canary rollout |
| `GET /admin/profiles/:id/versions`, `POST /admin/profiles/:id/rollback` `{version}` | History and rollback (as a new version) |
| `DELETE /admin/profiles/:id` | Refused while an alias or fallback points at it |

A profile: `{id, name, displayName, description, aliasOf, modelId, poolId, numCtx, temperature, thinkDefault,
thinkCeiling, systemPrompt, fallback, canary, tools, label, status, version, updatedAt}`.

## Chat and compare (Sprint 4)

Conversations belong to their author and to the session's current workspace. Reading needs `chat:read`; sending
needs `chat:write` and `inference:invoke`.

| Method and path | What it does |
| --- | --- |
| `GET /chat/profiles` | Profiles the caller may pick: `{id, name, displayName, description, aliasOf, model, label, thinkDefault, thinkCeiling, tools, vision, residency: loaded\|cold, deprecated}` |
| `GET /conversations?kind=chat\|compare&archived` | `[{id, kind, title, label, profileId, workspaceId, updatedAt, createdAt, archived}]` |
| `POST /conversations` `{title?, label?}` | An empty conversation |
| `POST /chat` `{content, profile, think?, attachments?, label?}` | Creates a conversation and sends its first message: `202 {conversationId, userMessageId, messageId, profile, model, think, label}` |
| `GET /conversations/:id` | The whole tree: `{id, kind, title, label, headId, messages: [message]}` |
| `PATCH /conversations/:id` `{title?, archived?, label?, headId?}` | Renames, archives, raises the label, or moves the head (to the newest leaf under the given message) |
| `DELETE /conversations/:id` | Deletes it |
| `POST /conversations/:id/messages` `{content, profile, parentId?, think?, attachments?, label?}` | Sends under `parentId` (default: the head) |
| `POST /conversations/:id/messages/:mid/regenerate` `{profile?, think?}` | A sibling answer |
| `POST /conversations/:id/messages/:mid/edit` `{content, profile?, think?}` | A sibling question with a new answer |
| `POST /conversations/:id/messages/:mid/stop` | Stops generation; what was produced is kept and metered |
| `GET /conversations/:id/messages/:mid/stream?after=<seq>` | Catch up: `{state, seq, chunks}` while streaming, or the stored `{state, seq, content, thinking, tools, usage, error}` |
| `POST /compare` `{prompt, profiles: [2–4], think?, label?}` | `202 {conversationId, userMessageId, columns: [{slot, messageId, profile, model, think, canary}]}`; each column streams and is metered separately |
| `PUT /attachments?name=<file>&label=<label>` (body: the file) | `202` attachment in quarantine; a job scans and classifies it (`attachment.state` socket event) |
| `GET /attachments/:id` | `{id, name, type, size, state: quarantined\|scanning\|rejected\|ready, label, reason, findings}` |
| `POST /calculate` `{expression}` | The exact-calculation worker: `{fraction, decimal, exact}` |

A message: `{id, parentId, role, content, thinking, tools: [{name, expression, result?: {fraction, decimal, exact},
error?}], state: queued|streaming|complete|stopped|failed, seq, profileId, profile, model, think, compareSlot, canary,
error, label, attachments, usage: {promptTokens, outputTokens, thinkingTokens, calcCalls, gpuMs, firstTokenMs},
createdAt, completedAt}`.

Socket events to the author: `chat.status {conversationId, messageId, state: queued|loading|streaming|fallback,
position?, instance?, profile?, model?}`, `chat.chunk {conversationId, messageId, seq, delta?, thinking?, tool?}`,
`chat.done {conversationId, messageId, state, seq, usage, error, profile, model}`. Sequence numbers start at 1 per
message; a gap means call the stream endpoint with `after`.

Errors worth handling: `429` over quota (with `Retry-After` and the limit), `403` with `step: clearance|zone` when
the conversation's label is above the caller or the profile, `409` for attachments not ready or images on a model
without vision, `410` when the tenant's key was destroyed.

## Sprint 5: Guardrails, classifiers and flags

Every feature calls `s.guardrails.check` at its checkpoint (`user-input`, `context`, `tool-call`, `model-output`,
`image`, `context-transfer`, `memory`, `script`, `db-query`, `media`, `export`). The published rule sets that apply
are the platform baseline, the tenant's sets, the workspace's sets and the agent's; the most restrictive enforced
finding wins (`allow < log < warn < flag < redact < require-approval < block`), and a tenant rule cannot relax a
baseline rule with the same id. Shadow rules are recorded and flagged for sampling but never change the outcome.
When a guard model or classifier cannot answer, the rule's `onError` decides (`closed` holds the turn, `allow` lets
it through and flags the fail-open decision); confidential and tool-calling turns are held either way.

A rule (the GuardrailRule schema; the same object as YAML): `{id, name, checkpoint, type, mechanism, action,
stage: shadow|enforce, onError: closed|allow, severity: low|medium|high, enabled, description?}`. Mechanisms:
`{kind: pattern, pattern}` (RE2), `{kind: pii, detectors, threshold}`, `{kind: secrets, detectors, threshold}`,
`{kind: label, against: clearance|ceiling|fixed, label?}`, `{kind: budget, metric: tokens|chars|steps, max}`,
`{kind: allow-list, field: domains, values}`, `{kind: meta, key, values}` (a fact the checkpoint passes, such as
`sideEffect`), `{kind: classifier, classifier, label, threshold?}`, `{kind: guard-model, profile, categories}` (a
Llama Guard style model through the gateway).

### Rule sets (`guardrails:manage`)

The platform baseline is changed only by platform guardrail admins (who also hold `platform:manage`) and publishes
when a second one approves; for everyone else it is read-only and writes fail with `403 step: baseline-locked`.

| Method and path | What it does |
| --- | --- |
| `GET /admin/guardrails/sets` | `[{id, scope: platform\|tenant\|workspace\|agent, name, description, workspaceId, workspace, agent, publishedVersion, draft: {version, status}\|null, locked, owner, rulesByCheckpoint, updatedAt}]` |
| `POST /admin/guardrails/sets` `{name, scope: tenant\|workspace\|agent, workspaceId?, agent?, description?}` | A new, empty set |
| `GET /admin/guardrails/sets/:id` | The summary plus `published` and `draft` versions (`{version, status, rules, createdByName, submittedBy, submittedByName, submittedAt, approvedByName, publishedAt…}`), `versions`, `yaml` (per rule), `stats` (per rule: `{evaluated, triggered, triggerRate, latencyMs, falsePositives: {confirmed, dismissed, rate}}` over 7 days), `baseline` (rule ids shared with the baseline) and `promotionLimit` |
| `PUT /admin/guardrails/sets/:id/draft` `{rules}` or `{yaml}` | Replaces the draft's rules; `{version, status, rules, diff}` |
| `PUT /admin/guardrails/sets/:id/draft/rules/:ruleId` `{rule}` or `{yaml}` | Adds or replaces one rule (new rules start in shadow); `{version, status, rule, yaml}` |
| `DELETE /admin/guardrails/sets/:id/draft/rules/:ruleId` | Removes a rule from the draft |
| `DELETE /admin/guardrails/sets/:id/draft` | Withdraws the draft (kept in the history) |
| `POST /admin/guardrails/sets/:id/draft/submit` | Requests review; the other guardrail admins are notified: `{version, status: pending, notified}` |
| `POST /admin/guardrails/sets/:id/draft/approve` | Dual control: someone other than the author and submitter approves, and it publishes (`403 step: dual-control` for your own change) |
| `POST /admin/guardrails/sets/:id/draft/publish` | Publishes a tenant, workspace or agent set's draft (the baseline only through approval) |
| `GET /admin/guardrails/sets/:id/diff?from&to` | `{from, to, added, removed, changed: [{id, fields}], text}` (default: published to draft) |
| `POST /admin/guardrails/sets/:id/promote` `{ruleId}` | Moves a shadow rule to enforce in the draft; `409 Promotion refused` when reviewers' false-positive rate is above the limit (10%) |
| `POST /admin/guardrails/sets/:id/replay` `{version?}` | `202 {jobId, version}`: a `guardrails.replay` job runs the version over the recorded (sealed) inputs of the last 7 days; its result is `{turns, rules: [{id, name, checkpoint, action, stage, wouldTrigger, publishedTriggered, errors}]}` |
| `POST /admin/guardrails/test` `{rule}` or `{setId, ruleId}`, `{text, label?, meta?}` | Live test of one rule on sample text, nothing recorded: `{hit, score, unit, detail, ms, error?, action, stage, onError, spans: [{start, end, text}]}` |
| `POST /admin/guardrails/validate` `{yaml}` | Validates YAML against the schema without saving: `{rules}` |
| `POST /admin/guardrails/requests` `{setId, ruleId, change}` | A tenant admin asks the platform guardrail admins to change a baseline rule: `202 {notified}` |
| `GET /admin/guardrails/status` | Guard-model and classifier failures in the last hour: `{degraded, since, held, failOpen, last: {at, rule, detail}}` |

An invalid pattern fails with `422 Invalid pattern` carrying `{ruleId, pattern, pos, msg, fix?}` (`fix` is an
equivalent RE2 pattern where one exists); a rule that does not match the schema fails with `422 Invalid rule` and
`errors: [{path, message}]`.

### Classifiers (`classifiers:manage`)

Four engines behind one registry: `deterministic` (the platform's PII and secrets detectors), `linear` (hashed word
features and a trained logistic head per label), `guard` (a guard model through the gateway) and `llm` (a profile
answering JSON). Platform classifiers are visible to every tenant and changed by platform admins; evaluations are per
tenant, on the tenant's own labelled cases.

| Method and path | What it does |
| --- | --- |
| `GET /admin/classifiers` | `[{id, slug, name, engine, description, status: draft\|published, version, owner, dataset, platform, labels: [{label, threshold}], family, profile, instructions, trained: {at, samples}\|null, metrics, samples: {<label>: n}, usage: [{set, setId, rule, ruleId, checkpoint}]}]` |
| `POST /admin/classifiers` `{name, engine: linear\|guard\|llm, labels, profile?, instructions?, description?}` | A draft classifier with its own dataset |
| `GET /admin/classifiers/:id` | The classifier plus `versions` and `usage` |
| `PATCH /admin/classifiers/:id` `{thresholds?, profile?, instructions?, dataset?, description?}` | A new version |
| `POST /admin/classifiers/:id/publish` | `409 Eval set too small` below 200 labelled cases per label |
| `POST /admin/classifiers/:id/evaluate` | `202 {jobId}`: a `classifier.evaluate` job (`classify.batch` on the console) computes precision and recall per label over the dataset |
| `POST /admin/classifiers/:id/train` | `202 {jobId}`: trains a linear classifier on four fifths of the dataset and evaluates it on the rest |
| `POST /admin/classifiers/:id/samples` `{items: [{text, expected: <label>\|none, label?}]}` | Adds labelled cases (sealed): `201 {added, samples}` |
| `POST /classify` `{classifier, text, label?}` (`inference:invoke` or `classifiers:manage`) | Synchronous: `{classifier, version, labels, scores, hits, top: {label, score}, engine, ms, spans: [{kind, start, end, score}]}`; `503` when the model is unavailable |
| `GET /admin/label-names` / `PUT /admin/label-names` `{names, order?}` | The tenant's names for the four levels; a different order fails with `409 Reorder refused` |
| `GET /eval-sets` (`flags:review` or `classifiers:manage`) | `[{name, cases}]` |

Evaluation `metrics`: `{at, dataset, samples, heldOut, perLabel: {<label>: {precision, recall, n, tp, fp, fn}}, points,
distribution, errors}`, where `points` keeps each case's score so the console previews precision and recall at any
threshold.

### Flags (`flags:review`)

Flags come from enforced `flag` actions, sampled shadow findings, fail-open decisions and user reports. Each has a
timer set by its severity (high 60 min, medium 4 h, low 2 days); an overdue flag notifies the guardrail admins once.
A reviewer sees the flags of their current workspace (and tenant-wide ones) not assigned to someone else; a flag
labelled above the reviewer's clearance shows redacted (`restricted: true`, no rule, actor, note, conversation or
excerpt) and can only be reassigned.

| Method and path | What it does |
| --- | --- |
| `GET /flags` | `{items: [flag], open, overdue, otherWorkspaces}` |
| `GET /flags/decisions?hours=24` | `[{id, ref, rule, action, by, at}]` |
| `GET /flags/:ref` | A flag with `excerpt: {before, span, after, clippedBefore, clippedAfter}`, `prior: {confirmed, dismissed}`, `ownConversation` and `history` |
| `POST /flags/:ref/decide` `{decision: confirmed\|dismissed, reason?}` | A confirmation becomes a positive eval case of the rule (`evalCase`); a dismissal counts as a false positive against it |
| `POST /flags/:ref/escalate` `{to: workspace\|tenant\|platform, note?}` | Moves it to the guardrail admins at that level with a fresh 60 min timer |
| `GET /flags/:ref/reviewers` | Reviewers cleared for the flag's label: `[{id, name, roles, clearance}]` |
| `POST /flags/:ref/reassign` `{userId}` | Assigns it to a reviewer cleared for its label, who is notified |
| `POST /flags/:ref/eval` `{evalSet, expected: positive\|negative}` | Adds the flagged text to an eval set: `201 {evalSet, case}` |
| `POST /flags/:ref/rule` `{setId, action?, name?}` (also `guardrails:manage`) | Drafts a shadow pattern rule matching the flagged span |
| `POST /flags/report` `{conversationId, messageId, reason, note?, span?, severity?}` (`chat:read`) | Reports an answer from the caller's own conversation |

A flag: `{id, ref: F-<n>, kind, checkpoint, severity, label, state: open|confirmed|dismissed, stage, action,
restricted, rule, ruleId, setId, setName, setVersion, actor, note, conversationId, workspaceId, assignee, escalatedTo,
slaMinutes, dueAt, createdAt, decidedBy, decidedAt, reason, evalSet}`. Socket event to `flags:review` holders:
`flags.changed {id, ref, action, severity}` (fetch the queue again; it is redacted per reviewer).

### Chat

`user-input` runs before a message is stored: a block or hold fails with `422 Blocked by guardrail` (or `Held by
guardrail`) carrying `{step: guardrail, action, rules}`, and a redaction is what is stored and sent to the model.
`model-output` runs on the finished answer: a block or hold replaces the answer with a notice, a redaction replaces
the spans. The message then carries `guard: {action, reason?, rules}`, `chat.done` carries the same `guard`, and a
replaced answer ends with a higher sequence number so a client holding the streamed text reads it again.

## Sprint 7: Registry, MCP servers, agent runs, scripts

### Registry (`tools:manage`; agent entries `agents:manage`)

Lifecycle: `draft → in_review → published → deprecated → retired`. Each version is its own entry. Platform entries
(`platform: true`, such as the built-in `calculate` tool) are published to every tenant and read-only. An entry's
`label` is a ceiling: the highest data label it may receive. Profiles list registry tools by name in `tools`
(`POST/PATCH /admin/profiles` now accepts any tool name); chat offers the read-class ones that need no confirmation.

| Method and path | What it does |
| --- | --- |
| `GET /admin/registry?kind=tool\|skill\|agent&status=` | Entries of the tenant and the platform (below) |
| `GET /admin/registry/:id` | The entry with `versions [{id, version, status, createdAt}]`, `referencedBy` (agents and skills using a tool), `profiles` (profiles listing it), `workspaces` (publish scope names) |
| `POST /admin/registry` | A draft, checked at once. Tool: `{kind: 'tool', name, version, description, sideEffect: read\|write\|destructive, confirm?, ratePerHour?, label, inputSchema, outputSchema?, definition: {scriptId}}` (script-backed; MCP tools come from the MCP screen). Skill: `{kind: 'skill', name, version, description, label, definition: {instructions, tools}}`. Agent: `{kind: 'agent', name, version, description, label, definition: {profile, systemPrompt, tools, skills, budgets: {steps, tokens, wallSeconds, toolCalls}}}` |
| `PATCH /admin/registry/:id` `{description?, sideEffect?, confirm?, ratePerHour?, label?, inputSchema?, outputSchema?, definition?}` | Edits a draft (anything else takes a new version) and re-runs the checks |
| `POST /admin/registry/:id/checks` | Re-runs the automated checks |
| `POST /admin/registry/:id/submit` | Draft → in review, with fresh checks |
| `POST /admin/registry/:id/review` `{decision: approve\|reject, note?, scope: tenant\|workspace, workspaces?}` | By someone other than the author (`403 step: dual-control`), cleared for the label. Approval needs every check passing (`409` naming the failing ones), records the schema hash and the publish scope (workspaces must have a ceiling at least the entry's label). Rejection returns it to draft; the owner is notified either way |
| `POST /admin/registry/:id/publish` `{scope, workspaces?}` | Changes the scope of a published entry |
| `POST /admin/registry/:id/lifecycle` `{to: deprecated\|retired\|published, replacement?}` | Deprecate (still callable, with a warning), retire (from deprecated or draft; returns `referencedBy`), or restore a deprecated entry |
| `POST /admin/registry/:id/versions` `{version}` | A new draft version copied from this one |
| `POST /admin/registry/:id/test` `{arguments, label?}` or, for agents, `{input, label?}` | Test harness. A tool runs once through the dispatcher (built-in and script tools in their sandbox; write and destructive MCP tools are not run against live systems): the dispatcher outcome below plus `{label, sandboxed, note}`. An agent starts a real run: `202 {runId}` |

Tools with `impl: workflow` run a workflow version (`definition: {workflowId, workflowName, version}`); they are
created from the Workflows screen (`POST /workflows/:id/tool`, below) and reviewed here like any other tool.

An entry: `{id, kind, name, version, description, impl: builtin|mcp|script|archive|agent|workflow, sideEffect, confirm,
ratePerHour, label, inputSchema, outputSchema, definition, status, schemaHash, approvedHash, checks: [{name, ok,
detail}], checksPassed, checkedAt, platform, owner, ownerId, submittedAt, reviewedBy, reviewedAt, reviewNote,
publishScope: tenant|workspace|platform, publishWorkspaces, replacement, createdAt, updatedAt}`. The checks: Required
fields, Schema valid (tools), Description quality, Side effect declared (tools; a name that suggests write or
destructive must declare at least that), Secrets scan, Referenced tools published (agents and skills), Limits within
workspace policy (agents: at most 100 steps, 200,000 tokens, 3,600 s).

A dispatcher outcome (harness, and each doing step of a run): `{name, arguments, ok, result?, error?, decision
(the tool-call guardrail's action), denied?, needsApproval?, withheld?, valid (output schema), durationMs}`. Every call
passes the `tool-call` guardrail checkpoint with `meta: {tool, sideEffect, toolLabel, ceiling, confirm, impl}`, and its
result passes the `context` checkpoint with `meta: {via: 'tool-result', tool, impl, sideEffect}` before it goes to the
model: `block` or `require-approval` withholds it (`ok: false, withheld: true`), `redact` replaces it. Context and memory
tags inside a result are defused as in retrieved context.

A workflow tool call starts a run of the pinned version as the caller (trigger `tool`, label the higher of the
workflow's and the caller's data) and executes it within the call, for at most 5 minutes (or the workflow's shorter
run timeout). The result is `{run, output}`: the output of the steps nothing follows. A run that pauses on an approval
carries on without the caller, which gets an error naming the run; a result labelled above the caller's data is
refused; a workflow step cannot call a workflow tool.

### MCP servers (`mcp:manage`)

Streamable HTTP only (protocol 2025-06-18 or 2025-03-26). Hosts must resolve to internal addresses (RFC 1918, unique
local IPv6, loopback, 100.64/10) unless `MCP_ALLOWED_HOSTS` names the host or network; link-local, multicast and
unspecified addresses are always refused. The check runs at registration and inside every connection's DNS lookup.

| Method and path | What it does |
| --- | --- |
| `GET /admin/mcp-servers` | Servers with tool counts (`tools, approved, disabled, pending`) and bound `profiles` |
| `POST /admin/mcp-servers` `{name, url, zone, auth: none\|service\|user, credential?, description?}` | Registers and runs the first check: `201` server with `report`. A public host is `422 Internal only` (`reason: public-host`), and audited |
| `GET /admin/mcp-servers/:id` | Server with `tools` (below), `events` (the changes timeline), `bindings [{profileId, profile, model, toolsCapable, label, tools, toolCount, status}]`, `connections` (per-user tokens: who and when, never the token) and `myToken` |
| `POST /admin/mcp-servers/:id/check` | Compatibility and health check now: `report [{check, result: passed\|failed\|changed\|skipped, detail}]` (internal address, initialize handshake, tools/list with hash comparison). Per-user servers are checked with the caller's own token |
| `POST /admin/mcp-servers/:id/tools/:tool/approve` `{sideEffect, confirm: always\|never, label}` | Records the tool's hash and reviewed class (annotations are only hints; write and destructive need `confirm: always`) and publishes it as registry tool `<server>.<tool>`. Also approves a changed schema |
| `POST /admin/mcp-servers/:id/tools/:tool/revoke` | Hides an approved tool again |
| `POST /admin/mcp-servers/:id/tools/:tool/reject-change` | Keeps a changed tool disabled |
| `PUT /admin/mcp-servers/:id/credential` `{secret}` | Rotates the sealed service token |
| `POST /admin/mcp-servers/:id/bind` `{profileId, tools?}` (also `profiles:manage`) | Adds approved tools to a profile (a new profile version); refused for models without tools |
| `DELETE /admin/mcp-servers/:id/bind/:profileId` | Removes the server's tools from a profile |
| `DELETE /admin/mcp-servers/:id` | Deregisters: tools leave every profile, registry entries are deprecated, user tokens deleted |

A server: `{id, name, description, url, zone, auth, hasCredential, credentialRotatedAt, state: active|deregistered,
health: registering|healthy|changed|unreachable|incompatible, healthDetail, protocolVersion, serverInfo, latencyMs,
failures, lastCheckedAt, lastOkAt, createdAt}`. A tool: `{id, name, description, inputSchema, annotations, hash,
approvedHash, approvedSchema, state: pending|approved|changed|rejected|removed, sideEffect, suggestedSideEffect,
confirm, label, approvedAt, updatedAt}`. The `mcp.poll` job (every `MCP_POLL_MINUTES`, default 15) checks every
server; an approved tool whose hash changes becomes `changed` (disabled) and tool admins are notified.

The per-user vault (`tools:invoke`): `GET /mcp/servers` (servers using per-user tokens with `{connected, scopes,
expiresAt, expired}`), `PUT /mcp/servers/:id/token` `{token, scopes?, expiresAt?}` (sealed; the answer is the
status, never the token), `DELETE /mcp/servers/:id/token`.

### Agent runs (`agents:run`)

| Method and path | What it does |
| --- | --- |
| `GET /agents` | Published agents the caller may run here: `{id, name, version, description, label, profile, tools, budgets, deprecated, replacement}` |
| `POST /runs` `{agent, input, label?, budgets?}` | Starts a run (a job): `202` run summary. The label must be within the caller's clearance, the workspace ceiling and the agent's ceiling; quotas apply |
| `GET /runs?all=true&state=` | The caller's runs in this workspace; `all` (agent and tool admins) the tenant's, within their clearance |
| `GET /runs/:id` | The run with `input`, `output`, `steps` (below), `lanes {think: {steps, tokens}, do: {calls, ms, waiting, denied}, calc: {results, ms}}` and `checkpoints` (step numbers) |
| `POST /runs/:id/cancel` | Owner or `agents:manage` |
| `POST /runs/:id/steps/:n/decision` `{decision: approve\|reject, note?}` | On a waiting step. Write calls: the owner or a tool admin; destructive calls: a tool admin other than the owner (`step: dual-control`). The run continues from its checkpoint; a rejection reaches the model as the tool's result |
| `POST /runs/:id/resume` `{budgets}` | After a budget stop: raises this run's limits (never beyond the maximum) and continues from the last checkpoint |
| `POST /runs/:id/replay` `{fromStep}` | A new run (`replayOf`, `replayFrom`) reusing steps before `fromStep` and continuing from the checkpoint before it; approvals are asked again |

A run's first prompt holds the agent's system prompt, its skills' instructions and the agent's accepted memories
(scope `agent`, owned by the agent's name, unexpired, at or below the run's label, each through the `memory`
checkpoint). Runs do not write memories yet.

A run summary: `{id, agentId, agent, agentVersion, profile, state: queued|running|waiting|succeeded|failed|cancelled|
budget, label, userId, by, error, budgets: {steps, tokens, wallSeconds, toolCalls}, usage: {steps, tokens, toolCalls,
calcCalls, wallMs, gpuMs}, replayOf, replayFrom, createdAt, startedAt, finishedAt}`. A step: `{n, lane: think|do|calc,
title, state: ok|failed|waiting|denied|rejected, meta (think: tokens, profile, model, proposal; do/calc: tool,
sideEffect, ceiling, durationMs, decision, valid, warning, approval), detail (sealed at rest: content and thinking, or
arguments, result and error), createdAt, finishedAt}`. Socket events to the owner: `run.state {runId, state, error?}`
and `run.step {runId, n, lane, title, state, meta}`; tool admins also get `run.state` for runs that start waiting.

### Scripts (`scripts:run`)

Scripts belong to the current workspace. Every version is checked (the `script` guardrail checkpoint, blocked network
and process modules, a secrets scan) and a failing check refuses runs before they start. Runs execute in the
`ScriptRunner`: `docker` or `podman` (`SCRIPT_RUNNER`, default `auto`) with no network, a read-only root, a noexec
tmpfs, the nobody user, all capabilities dropped, and memory, CPU, process, time and output limits.

| Method and path | What it does |
| --- | --- |
| `GET /scripts`, `GET /scripts/runtime` | The workspace's scripts; which runner is configured and whether it answers, with default and maximum limits and the image for each language |
| `POST /scripts` `{name, language: python\|javascript, source, label, limits?}` | Creates version 1 (source sealed) with its checks |
| `GET /scripts/:id` | `{id, name, language, label, status: draft\|tested\|in_review\|promoted, version, source, limits: {timeoutSeconds, memoryMb, cpus, pids, outputKb}, checks: [{name, result, tone, detail, line?}], blocked, registry, lastRunId}` |
| `PATCH /scripts/:id` `{source?, limits?, label?, note?}` | A new version (a tested draft goes back to draft) |
| `GET /scripts/:id/versions`, `GET /scripts/:id/versions/:v`, `POST /scripts/:id/restore` `{version}` | History; restoring makes a new version |
| `POST /scripts/:id/checks` | Re-runs the checks on the current version |
| `POST /scripts/:id/run` `{stdin?}` | `202 {runId, jobId}`; `409 Refused before start` naming the blocking check. A clean run makes a draft `tested` |
| `GET /scripts/:id/runs`, `GET /script-runs/:id` | Runs; one run with `{state: queued\|running\|succeeded\|failed\|timeout\|cancelled, stdin, stdout, stderr, exitCode, durationMs, truncated, runner, error}` (sealed at rest) |
| `POST /scripts/:id/promote` `{toolName, version, description, sideEffect, label?, inputSchema, outputSchema?}` (also `workflows:manage` or `tools:manage`) | A tested script becomes a script-backed registry tool, submitted for review; published, the script is `promoted`. The tool pins the script version, takes its arguments as JSON on stdin and returns the JSON on stdout |

Socket event to the script's runner: `script.run {runId, scriptId, state, exitCode?, error?}`.

## Sprint 8: Workflows, media and images

### Workflows

Workflows belong to the session's current workspace and are hidden above the caller's clearance. Editing and
publishing need `workflows:manage`; reading, starting runs of the published version, replaying and cancelling one's
own runs need `agents:run`. Approvals are decided by holders of the role the step names (and by the person who
started a dry run), with clearance for the run's label.

| Method and path | What it does |
| --- | --- |
| `GET /workflows` | `[{id, name, description, label, draftRev, publishedVersion, waiting, createdAt, updatedAt…}]` (`waiting`: runs paused on an approval) |
| `POST /workflows` `{name, description?, label?, graph?}` | A new workflow; the draft starts with a manual trigger |
| `GET /workflows/:id` | `{…, draft: graph, dirty, validation, limits, tools: [{id, name, version, status, workflowVersion, sideEffect, label}] (registry tools that run it), versions: [{version, state: published\|deprecated, note, publishedBy, publishedAt, graph}]}` |
| `PUT /workflows/:id/draft` `{graph?, rev?, description?, label?}` | Saves the draft; `rev` is the revision the editor loaded (`409` when someone saved since) |
| `POST /workflows/:id/validate` `{graph?}` | Validates the given graph (or the draft) without saving |
| `POST /workflows/:id/publish` `{note?}` | Publishes the draft as the next version; `422` with `errors` when it is invalid |
| `POST /workflows/:id/tool` `{name, version?, description, sideEffect?, label?, ratePerHour?}` | Publish as tool: a registry tool (`impl: workflow`) pinned to the published version, its input schema the trigger's output schema (`409` without a published version or an object trigger schema). The side effect defaults to, and cannot be below, what the steps do (an HTTP write or a write tool makes it `write`); the label defaults to, and cannot be below, the workflow's. The registry's checks must pass (`422` with `checks`); the entry is submitted for review and a tool admin other than the author approves it on the Registry screen. `201` entry |
| `GET /workflow-tools` | Tools a tool step may call from the current workspace: published registry and MCP tools visible there with their approved schema, newest version per name, workflow tools left out: `[{name, version, description, impl, sideEffect, confirm, label, status, inputSchema, outputSchema}]` |
| `DELETE /workflows/:id` | Refused (`409`) while runs are queued, running or waiting |
| `POST /workflows/:id/runs` `{input}` | Starts a run of the published version: `202 {id, state, version, mode: run, label}`; `input` must match the trigger's output schema |
| `POST /workflows/:id/dry-run` `{input}` | Runs the draft with model and HTTP steps mocked, guardrails not consulted and nothing metered (`workflows:manage`) |
| `GET /workflows/:id/runs?limit` | Run history (everyone's for workflow admins, one's own otherwise) with each step's state |
| `GET /workflow-runs/:id` | `{…, graph, input, steps: [{nodeId, state, label, attempts, detail, error, output, resumeAt, startedAt, finishedAt}], approvals}`; outputs above the caller's clearance are withheld |
| `POST /workflow-runs/:id/replay` `{from}` | A new run from step `from`: upstream checkpoints are reused, the step and everything after it run again |
| `POST /workflow-runs/:id/cancel` | Cancels a queued, running or waiting run (its owner or a workflow admin) |
| `GET /workflow-approvals` | Approvals waiting on the caller: `[{id, runId, nodeId, role, state, shown, dueAt, canDecide, workflow, step, label, mode}]` |
| `POST /workflow-approvals/:id` `{decision: approve\|reject, reason?}` | Decides; the run resumes (approve) or ends `rejected`. Undecided approvals expire at `dueAt` and the run fails |

A graph: `{nodes: [{id, kind, title, x, y, config, input?, output?, ceiling?, raises?, timeoutMs?}], edges: [{from, to,
branch?: true|false}], limits: {timeoutMs?, tokens?}}`. `input` and `output` are port schemas
`{type: string|number|integer|boolean|array|object|any, properties?, required?, items?}`. Step kinds:

| Kind | Config | Output |
| --- | --- | --- |
| `trigger` | `{source: manual\|api}` | the run input (checked against `output`) |
| `model` | `{profile, prompt, think?, format: text\|json}` | `{text}`, or the parsed JSON (checked against `output`) |
| `transform` | `{fields: {name: template}}` | the fields |
| `branch` | `{left, op: eq\|ne\|gt\|gte\|lt\|lte\|contains\|truthy\|exists, right?}` | input plus `{result}`; outgoing edges carry `branch` |
| `guardrail` | `{checkpoint, text, approverRole}` | input plus `{text, action}`; block fails the step, require-approval pauses for `approverRole` |
| `approval` | `{role, timeoutMs, show}` | input plus `{approved, by}` |
| `http` | `{method: GET\|POST\|PUT, url, body?, headers?}` | `{status, body}`; private addresses only, never link-local |
| `calc` | `{expression}` | `{value, fraction, exact}` |
| `wait` | `{ms}` | its input, after the wait |
| `tool` | `{tool, args?: {name: template} \| template, approverRole}` | the tool's result when it is an object, else `{result}` |

Templates read `{{input.path}}` and `{{steps.<id>.path}}` of upstream steps; a template that is a single placeholder
keeps the value's type, and URL placeholders are percent-encoded. Validation errors are `{code: structure|cycle|config|
schema|label|limit|reference|unavailable|unreachable, message, nodeId?, edge?, expected?, actual?}`. Limits: 40 steps,
fan-out 10, 30 minutes per step, 2 hours and 200,000 tokens per run.

Tool steps call a published registry tool (built-in, script or MCP) through the dispatcher, as the run's owner in the
workflow's workspace: the arguments are `args` rendered (or, without `args`, the fields of the step's input that the
tool's input schema names), checked against its input schema, then the `tool-call` guardrail checkpoint and the
tool's rate limit apply. Publishing checks that the tool exists, is published and visible in the workspace, is not a
workflow tool, that the incoming port (or `args`) fits its input schema, and that the data's label is within its
ceiling. A write or destructive tool (or one with `confirm: always`, or a call the checkpoint holds) is called as
approved when an Approval step comes before it on every path; otherwise the step pauses for `approverRole` like an
Approval step (the approver sees the tool and arguments) and runs again, approved, once someone decides, and
validation warns about it. A replay asks again. Dry runs mock the result from the tool's output schema and call
nothing. Calls of write tools are audited as `workflow.tool.called`.

Socket events to the run's owner: `workflow.run {runId, workflowId, state, mode, error}` and `workflow.step {runId,
workflowId, nodeId, state: running|passed|failed|skipped|waiting|blocked, error, label, attempts, detail}`.

### Media (`chat:read` to read, `chat:write` to upload and run)

| Method and path | What it does |
| --- | --- |
| `GET /media/caps` | `{caps: {maxBytes, maxDurationMs, maxWidth, maxHeight, maxStreams}, presets: [{id, sub, kinds, fields: [{name, label, type: time\|select, options, default}], encodes, available, reason, model}], encoder: {setting, video: nvenc\|cpu}}` |
| `GET /media/assets` | Assets in the workspace up to the caller's clearance |
| `PUT /media/assets?name=&label=` (body: the file) | `202` asset in quarantine; an ingest job probes it, refuses it above a cap, strips metadata and draws previews (`media.asset` socket event); `413` above the size cap |
| `GET /media/assets/:id` | `{id, name, kind: video\|audio\|image, format, size, durationMs, width, height, streams, previews, state: quarantined\|probing\|ready\|refused, label, reason, uploadedByName, jobs}` |
| `GET /media/assets/:id/content` | The file (supports `Range`) |
| `GET /media/assets/:id/previews/:i` | Frame-strip thumbnails (video), the waveform (audio) or a preview (image) |
| `POST /media/assets/:id/jobs` `{preset, params}` | Queues a preset; parameters are validated against its schema and times against the media (`400`): `202` job |
| `GET /media/jobs/:id` | `{id, assetId, preset, params, encoder: nvenc\|cpu, state, stage, progress, node, outputs: [{index, name, type, size}], result: {words?, frames?, withheld?, withheldAt?, masked?}, label, error}` |
| `POST /media/jobs/:id/cancel` | Cancels the caller's own job |
| `GET /media/jobs/:id/outputs/:i?download=1` | An output (a download is audited) |
| `POST /media/caps/request` `{assetId, note?}` | Asks the system admins for a higher cap, with the probe result |
| `POST /media/jobs/:id/knowledge` `{kbId}` | Send transcript to a knowledge base: the transcript of a finished `transcribe-srt` job (`409` otherwise) becomes a text document (`<asset> transcript.txt`, one line per caption with its start time) in the base's uploads, labelled with the job's label (classification may raise it). The caller must curate the base (`403`). `202` document with `kb: {id, name}`; audited as `media.transcript.sent` |

Presets: `clip-720p` `{start, end, height: 720|480|1080, crop}`, `transcribe-srt` `{language}` (needs whisper.cpp),
`frames-1fps` `{start, end, fps: 1|0.5|2, maxFrames: 48|96|200}` (frames pass the image-safety classifier) and
`normalise-audio` `{loudness, truePeak}`. Transcripts pass the `media` guardrail checkpoint. Socket event:
`media.job {id, assetId, preset, state, stage, progress, encoder, error, result}`.

### Images (`images:generate`)

| Method and path | What it does |
| --- | --- |
| `GET /images/backends` | `{backends: [{id, kind, label, model, concurrency, steps}], safety: {classifier, threshold}}` |
| `GET /images/quota` | `{scope: workspace\|tenant, used, limit, resetsAt, raisedBy}` in GPU-seconds this month |
| `GET /images` | The caller's images in the workspace, newest first |
| `POST /images` `{prompt, backend, width, height, count: 1–8, seed?, steps?, label?}` | Checks the prompt at the `image` guardrail checkpoint (`422 Prompt blocked` with `rule`) and the GPU-second quota (`429`), then queues one job per image: `202 {batch, redacted, images}` |
| `GET /images/:id` | `{id, state: queued\|running\|succeeded\|withheld\|failed\|cancelled, stage, step, steps, position?, etaMs?, seed, gpuSeconds, safety, classified, provenance, prompt, label, …}` |
| `POST /images/:id/cancel`, `POST /images/:id/vary` | Cancel; a variation with the next seed |
| `GET /images/:id/image`, `GET /images/:id/download` | The PNG with its provenance chunk (`exprsn-provenance`); downloads are audited |
| `GET /images/:id/provenance` | `{verified, signature, bytesMatch, embedded, manifest}` (HMAC by the KMS) |
| `POST /images/:id/attach` | Sends the image to chat as an attachment (also needs `chat:write`) |
| `POST /images/report` `{kind: prompt\|output, imageId?, rule?, note?}` | Reports a possible false positive to flag reviewers and guardrail admins |

Unsafe outputs (a score at or above `IMAGE_SAFETY_THRESHOLD`) are discarded, still metered, audited and raised to
reviewers. Socket event: `image.job {id, state, stage, step, steps, node, error}`.

## Sprint 6: Knowledge, memory, connections

### Knowledge (`knowledge:read`; changes need `knowledge:manage` or manage access on the base)

A caller sees the bases of their tenant that are tenant-wide or in one of their workspaces (unless shared with
curators only), plus bases shared with them or their workspaces; curators see every base. Documents and chunks
above the caller's clearance are filtered inside every query: they are never listed, ranked or counted.

| Method and path | What it does |
| --- | --- |
| `GET /knowledge/bases` | `[base]` the caller may read |
| `POST /knowledge/bases` `{name, description?, label, embedModel, reranker?, sharing: members\|curators, workspaceId?, chunking?: {tokens, overlap}}` | Curators: creates a draft base with an empty serving index v1. The embedding model must be approved, have the `embedding` capability and be cleared for the label |
| `GET /knowledge/bases/:id` | The base with `sources: [source]`, `indexes: [index]` (newest ten), `quarantined` and `vectorStore: db\|pgvector` |
| `PATCH /knowledge/bases/:id` `{name?, description?, label?, reranker?, sharing?, status?: draft\|published, chunking?}` | Updates; a higher label floor applies to indexed chunks at once. Only published bases are used in chat |
| `DELETE /knowledge/bases/:id` | Deletes the base, its documents, chunks, vectors and stored files |
| `POST /knowledge/bases/:id/reindex` `{embedModel?}` | `202 index`: builds the next version beside the serving one by job (`knowledge.reindex`); the switch is one transaction, then the old index is dropped. `409` while one is building |
| `POST /knowledge/bases/:id/cancel-build` | Cancels the build and discards the partial index; the serving index is untouched |
| `GET /knowledge/bases/:id/access` | `[{id, kind: workspace\|user\|profile, principalId, name, access: read\|manage, createdBy, createdAt}]` |
| `POST /knowledge/bases/:id/access` `{kind, id, access}` | Shares with a workspace or user (read or manage), or attaches the base to a profile (read: retrieval in chat for that profile) |
| `DELETE /knowledge/bases/:id/access/:grant` | Removes a share |
| `POST /knowledge/bases/:id/sources` `{kind: upload\|s3\|git\|database, location, labelFloor?, schedule?: 15m\|hourly\|daily\|manual, ref?, path?, connectionId?, idColumn?, watermarkColumn?}` | Adds a source and queues its first sync. S3: `s3://bucket/prefix/`, read with the platform's S3 credentials. Git: an `https://` URL, cloned shallow by job. Database: `pg: schema.view` through a PostgreSQL connection, allow-listed, synced by watermark (`updated_at` by default); its floor is at least the connection's label |
| `POST /knowledge/sources/:id/sync` | `202 {jobId}` (`knowledge.sync`); unchanged documents are skipped by version (ETag, commit) or content hash |
| `DELETE /knowledge/sources/:id` | Removes the source and its documents from every index |
| `GET /knowledge/bases/:id/documents?q=` | `[document]` at or below the caller's clearance |
| `PUT /knowledge/bases/:id/uploads?name=<file>&label=<label>` (body: the file) | `202 document` in sealed quarantine; `knowledge.scan` detects the type from the bytes (text, Markdown, CSV, JSON, HTML, PDF, DOCX) and runs ClamAV when configured, then indexing classifies and chunks it |
| `GET /knowledge/documents/:id` | `document` with `kb: {id, name}` |
| `PATCH /knowledge/documents/:id` `{label, reason?}` | Relabels: never below the classifier's finding or the floor (`409` naming the finding); chunks take the label at once |
| `POST /knowledge/documents/:id/reindex` | `202 {jobId}`: extraction and embedding again (retry after a failure); embeddings come from the cache where the text is unchanged |
| `DELETE /knowledge/documents/:id` | Removes it from every index; a synced document stays `removed` so the next sync does not bring it back |
| `POST /knowledge/search` `{kbIds, query, k?, rerank?}` | Test search as the caller: `{hits: [hit], ceiling, vectorSkipped, vectorStore}` |
| `GET /knowledge/models` | `{embedding: [{name, label, state}], rerankers: [...]}`: approved models for the forms |
| `GET /knowledge/principals` | Curators: `{workspaces, users, profiles}` to share with |
| `GET /knowledge/connections` | Curators: `[{id, name, label, objects, columns}]`, the PostgreSQL connections and allow-listed objects a database source can read (never credentials) |
| `GET /conversations/:id/knowledge` (`context:read`) | Bases attached to one of the caller's conversations |
| `PUT /conversations/:id/knowledge` `{kbIds}` (`context:write`) | Attaches bases the caller can read to the conversation |

A base: `{id, name, description, workspaceId, label, embedModel, reranker, sharing, status, chunking, documents,
chunks, access: read|manage, serving: index, building: index|null, lastSyncAt, createdAt, updatedAt}`. An index:
`{id, version, embedModel, dims, state: building|serving|retired|cancelled|failed, progress, message, chunks, jobId,
error, createdAt, builtAt}`. A source: `{id, kind, location, config, labelFloor, schedule, state: idle|syncing|failed,
watermark, lastSyncAt, lastError, lastTrace, jobId, documents}`. A document: `{id, name, sourceId, source, type, size,
sha256, label, autoLabel, manualLabel, labelOrigin, detections, state: quarantined|scanning|queued|indexing|indexed|
unchanged|failed|rejected|removed, error, traceId, chunks, createdAt, updatedAt, indexedAt}`. A hit: `{chunkId, kbId,
kb, documentId, document, source, heading, label, vector, keyword, fused, rerank, text?, withheld?}`: `vector` is the
cosine similarity, `keyword` the BM25 score relative to the best, `fused` the reciprocal rank fusion score, `rerank`
the reranker's 0–1 score; `withheld` names the reason when the `context` guardrail checkpoint blocked the chunk.

Chat: for each answer, published bases attached to the conversation or to its profile are searched (the query is the
user's message) up to the lowest of the user's clearance, the profile's label, the pool's ceiling and the
workspace's ceiling; the chunks go to the model as one system message of `<context id label source section>` blocks,
the conversation's label rises to the highest chunk used, and the answer records `citations: [{n, kind: knowledge,
kbId, kb, documentId, document, chunkId, section, score, label}]` (sealed at rest). A `chat.status` event with
`state: context, label, citations` reports it.

### Memory (`memory:write`)

| Method and path | What it does |
| --- | --- |
| `GET /memory?tab=mine\|workspace\|agents` | `{tab, items: [memory], counts: {mine, workspace, agents}, curator, workspace, backend, policy}`. Workspace proposals are listed to curators and to their author |
| `GET /memory/:id` | One memory with its history |
| `POST /memory` `{text, scope: user\|workspace, type?, label, expiresAt?}` | Saves (own memories and curators' workspace entries) or proposes (a member's workspace entry). The memory checkpoint runs first: restricted memories are refused by tenant policy, credentials are never stored, then the guardrail rules (`422` with the reason) |
| `PATCH /memory/:id` `{text?, label?, expiresAt?}` | A new version; the label never goes below the source's; the checkpoint runs again |
| `POST /memory/:id/accept` | Accepts a proposal (the owner, or a curator for a workspace) |
| `POST /memory/:id/reject` | Discards a proposal; the same text is not proposed again |
| `DELETE /memory/:id` | Forgets everywhere: the record, its versions, its vector and export files that could hold it. `{id, vectors, versions, exports}`; audited |
| `POST /memory/exports` `{tab, format: json\|csv}` | `202 {id, file, jobId}` (`memory.export`); workspace and agent exports need a curator |
| `GET /memory/exports/:id` | `{id, file, state: queued\|ready\|failed\|purged, rows, label, format}` (the requester only) |
| `GET /memory/exports/:id/download` | The file (sealed at rest) |

A memory: `{id, scope: user|workspace|agent, ownerId, type, text, label, sourceLabel, state: proposed|active|superseded,
origin: manual|chat|extraction, source: {conversationId, title}|null, author, acceptedBy, backend, embedded, expiresAt,
version, history: [{version, note, actor, at}], createdAt, updatedAt}`. After an answer completes, `memory.extract`
proposes memories from explicit phrases in the user's message ("remember that…", "I prefer…", "call me…", "I am
working on…"); accepted memories of the user and the current workspace go into later prompts as `<memory>` blocks
(each through the `memory` checkpoint), recalled by vector similarity when an embedding model is approved, else by
recency. Expired memories are purged hourly from every backend.

### Data connections (`connections:manage`)

| Method and path | What it does |
| --- | --- |
| `GET /admin/connections` | `[connection]` |
| `POST /admin/connections` `{name, engine: postgres\|opensearch, endpoint, database?, zone, label, rowLimit, timeoutS, tls, username?, password?}` | Registers; the credential is sealed with the tenant key and never returned. Other engines are refused |
| `GET /admin/connections/:id` | One connection |
| `PATCH /admin/connections/:id` `{endpoint?, database?, zone?, label?, rowLimit?, timeoutS?, tls?}` | New version of the settings; `ops: write` is refused |
| `PUT /admin/connections/:id/credential` `{username, password}` | Replaces the credential |
| `DELETE /admin/connections/:id` | Refused (`409`) while a knowledge source reads from it |
| `POST /admin/connections/:id/test` | `{ok, ms, version, readOnly, detail, health}`; an account with write grants is `degraded` |
| `POST /admin/connections/:id/schema` | Introspects: `{objects, allowed, outside, connection}` |
| `PUT /admin/connections/:id/allow-list` `{objects, piiColumns}` | Objects the model and the browser may read (OpenSearch patterns such as `logs-*` allowed); extra PII columns as `object.column` |
| `POST /admin/connections/:id/query` `{query, object?, confirmUnparsed?}` | Classifies, then runs on the read-only account in a read-only transaction with the statement timeout: `{columns, rows, capped, estimate, ms, masked, label, unparsed, verb}`. Refusals: `422` write, DDL, several statements, object or function outside the allow-list (`kind`, `verb`, `object`); `409 kind: unparsed` until confirmed; `403` above the caller's clearance or blocked by the `db-query` checkpoint. Every outcome is audited with the query text |
| `POST /admin/connections/:id/export` | Same body and checks; the result as CSV (`X-Label` header), through the `export` checkpoint |
| `POST /admin/connections/:id/sync` | `202 {jobs}`: syncs every knowledge source reading from the connection |

A connection: `{id, name, engine, endpoint, database, zone, label, ops, rowLimit, timeoutS, account, hasCredential,
tls, allowList, piiColumns, schema: [{name, kind, allowed, columns: [{name, type, pii}]}], schemaAt, health,
healthDetail, checkedAt, version, syncs: [{kbId, kb, sourceId, object, lastSyncAt, state, docs}]}`. PII columns (by
name, or marked) and values the classifier recognises (emails, IBANs, cards, national identifiers, phone numbers)
are masked in every result as `••••` plus the last four characters.


## Sprint 9: Training

### Training (`training:submit` to read and submit; `training:manage` to approve and to change windows, schedules, withdrawals and thresholds)

Tenant-scoped (the tenant comes from the session). Datasets and jobs are filtered by the caller's clearance against
their label (`404` above it). Both permissions belong to the `ml-admin` role, which needs an MFA-verified session.
The GPU work runs on the training worker (`TRAINER_URL`, contract in `server/src/training/trainer.ts`); without one,
jobs queue with `waitReason` naming the missing setting.

| Method and path | What it does |
| --- | --- |
| `GET /training/summary` | `{stages, worker: {available, reason, kind, container?, trainers?, accelerators?, gpus?: {total, free}, reachable?}, quota: {usedHours, limitHours, resets}, tenant, settings, tickSeconds}` |
| `GET /training/settings` | `{thresholds: {suite: n}, suites: [{id, name, defaultThreshold, threshold}], conversationOptIn, optInScope, optInBy, optInAt}` |
| `PUT /training/settings` `{thresholds?, conversationOptIn?, optInScope?}` | Per-tenant eval thresholds (`training:manage`). Changing the conversation-data opt-in also needs `tenant:manage` (`403`) |
| `GET /training/datasets` | Dataset versions: `{id, name, version, ver, rows, label, source, sourceKind: inline\|staging, conversationData, optIn, state: scrubbing\|ready\|failed\|withdrawn, hash, splits: {pct, rows}, scrub: {masked, rowsAffected, byKind, detectors}, pii, usedBy, stored, withdrawn, withdrawnReason, createdBy, createdAt}` |
| `POST /training/datasets` `{name, version?, label, source, rows? \| stagingPath?, conversationData?, splits?}` | `202`: registers a version (next number by default; `409` if not above the latest). Rows come inline (JSON objects with prompt and completion, instruction and output, messages, or text) or from JSON Lines at `training/staging/<tenant>/<stagingPath>` in the blob store. A `training.dataset` job parses the rows (`failed` with the line number), masks PII with the guardrail detectors (`[EMAIL]`, `[PAYMENT_CARD]`…), hashes the rows (sha256), seals the rows and `pii-report.json` with the tenant key, and deletes the unscrubbed input (`train.dataset` socket event). Conversation data needs the tenant opt-in (`409`); a label above the caller's clearance is refused (`403`) |
| `GET /training/datasets/:id` | One version |
| `GET /training/datasets/:id/report` | The scrub report (counts by kind; row, field and kind per finding, never values); every read is audited |
| `POST /training/datasets/:id/withdraw` `{reason}` | Deletes the rows and cancels jobs not finished training on it: `{dataset, cancelled}` (`training:manage`) |
| `GET /training/base-models` | Approved or evaluated catalogue models the caller is cleared for |
| `GET /training/jobs` | Jobs, newest first: `{id, name, desc, baseModel, baseDigest, dataset: {id, name, version, label, rows, state}, method, methodText, trainer, hardware, hardwareText, maxHours, maxGpuHours, priority, preemptible, priorityText, deadline, packaging, canary, checkpointEvery, label, state: queued\|running\|succeeded\|failed\|cancelled\|preempted, stage (0–8), stageTone, awaiting, approval, approvedBy, holding, runNow, waitReason, window, step, steps, epoch, epochs, loss, series: [[step, loss]], gpuHours, checkpoint: {step, ref, at, reason}, container, note, error, evals, registration: {state: pending\|blocked\|registered\|failed, reason, modelId, model}, model: {id, name, state}, owner, createdAt, startedAt, finishedAt}` |
| `POST /training/jobs` `{name, baseModel, datasetId, method: {kind: lora\|qlora\|full, rank, alpha, learningRate, epochs, seed, seqLen, microBatch}, trainer: unsloth\|axolotl\|trl, hardware: {accelerator: cuda\|rocm\|metal, gpus, memoryGb}, maxHours, deadline, priority: low\|normal\|high, preemptible, packaging, canary, checkpointEvery, steps}` | `201` job. The dataset must be `ready`; the base model approved or evaluated; conversation data only at or below the base model's label (`409`). `429` with `limit: training_gpu_hours_per_month` when the tenant used its training GPU-hours. A confidential or restricted dataset holds the job for approval (`awaiting: true`; ML admins other than the submitter are notified) |
| `GET /training/jobs/:id` | One job |
| `GET /training/jobs/:id/card` | The model card: `{model, label, baseModel, baseDigest, dataset: {name, version, hash, label, rows}, trainer, container, hyperparameters, hardware, approval: {byName, at}, evals, packaging: {requested, quantization, tool, artifact, digest, sizeBytes}, registration, manifest: {signature, key, signedAt}}` |
| `POST /training/jobs/:id/approve` | Approval for confidential or restricted data (`training:manage`): the approver must differ from the submitter (`403`, `step: dual-control`) and be cleared for the label |
| `POST /training/jobs/:id/pause` | The worker checkpoints at the current step and releases the GPUs; the job waits (`holding`) until resumed. Submitter or ML admin |
| `POST /training/jobs/:id/resume` | Run now / Resume now: may start outside a window, from the last checkpoint (`409` while awaiting approval; `429` over quota) |
| `POST /training/jobs/:id/cancel` | Stops the run after the current step, keeping the last checkpoint |
| `POST /training/jobs/:id/retry` `{change: gpus4\|half-batch\|seq4096\|none}` | Requeues a failed or cancelled job with the same dataset version, seed and container, from its checkpoint, with the change |
| `GET /training/evals` | Eval results: `{id, jobId, model, hardware, suite, name, score, base, threshold, passed, total, result: pass\|fail, scoreText, thresholdText, createdAt}` |
| `POST /training/evals` `{jobId \| model, hardware?, suites?}` | `202`: re-runs a job's evals (registration proceeds automatically on a pass), or evaluates a catalogue model on the given hardware classes and suites (`heldout`, `regression`, `redteam`, `tools`) |
| `GET /training/windows` | `{windows: [{id, name, poolId, pool, kind: always\|daily\|weekly, startDay, startTime, endDay, endTime, reloadMinutes, when, effect, state: idle\|open, open, closing, closesAt, opensAt}], pools: [{id, name, accelerator}]}` |
| `POST /training/windows` `{name, poolId, kind, startDay?, startTime?, endDay?, endTime?, reloadMinutes}` | `201`. Times are UTC. Lending a gateway pool (`poolId`) also needs `pools:manage` (`403`): the pool is drained when the window opens and its pinned models reloaded `reloadMinutes` before it closes |
| `DELETE /training/windows/:id` | `204`; an open window is closed first (jobs checkpoint, the pool returns to service) |
| `GET /training/schedules` | `{id, name, templateJobId, template, cron, cronText, condition: dataset-changed\|always, conditionText, window, priority, enabled, nextRunAt, lastRunAt, lastResult, lastJobId}` |
| `POST /training/schedules` `{name, templateJobId, cron, condition?, windowId?, priority?}` | `201`; five-field cron in UTC (`400` with the reason) |
| `PATCH /training/schedules/:id` `{enabled}` | Enables or pauses (the next run is skipped) |
| `DELETE /training/schedules/:id` | `204` |

The orchestrator runs `training.tick` every `TRAINING_TICK_SECONDS` (and right after a submit, approval or resume):
windows open (drain) and close (checkpoint, undrain, reload pinned models); running jobs sync with the worker (step,
loss points, checkpoint, GPU time metered as `training` usage; a job past its maximum duration fails with its
checkpoint kept, and one over the tenant quota is checkpointed and preempted); due schedules fire (a job with the
template's spec and the dataset's newest version, skipped when the version is unchanged under `dataset-changed`); and
queued jobs start in fair-share order (priority, then the tenant's training GPU-hours this month, then deadline and
age) inside an open window of their tenant, when the worker has the GPUs. A higher-priority job may preempt a
lower-priority preemptible one; preempted jobs resume from their checkpoint. After training, `training.evaluate` runs
each suite on every hardware class of the pools cleared for the job's label, against the tenant's thresholds; a failure
stops the pipeline and is recorded on the card. On a pass, `training.package` converts the checkpoint to GGUF on the
worker and registers a **draft** model in the gateway catalogue (`source: training:<job>`, `expected_digest`, the job's
label, format and quantization, the base model's family and licence), signs the card's manifest with the KMS key
`<OPENBAO_KEY_PREFIX>training-manifests` and notifies the model admins, whose usual pull, evaluation and dual-control
approval follow. Socket events: `train.progress {id, name, state, stage, stageTone, step, steps, epoch, loss, points,
gpuHours, checkpoint, note, error, waitReason, awaiting, holding}` (to the owner and to `training:manage` holders) and
`train.dataset {id, state, error?}`. Audit actions: `training.dataset.{registered,scrubbed,report.read,withdrawn}`,
`training.job.{submitted,approved,started,paused,resumed,cancelled,retried,preempted,trained,failed}`,
`training.evals.{queued,passed,failed}`, `training.model.registered`, `training.window.{created,deleted,opened,closed}`,
`training.schedule.{created,enabled,paused,deleted,fired}`, `training.settings.updated`.

## Sprint 9: Zones (`zones:manage`)

Zones are platform-wide, like pools: every route needs `zones:manage`, which only system admins hold. Zone rows carry
no tenant; each change is audited into the acting admin's tenant chain (as pool and platform-baseline changes are)
with `{zone, version}` as the target. A zone is versioned: a proposal creates a draft, which becomes current only when
a system admin other than the proposer approves it. Until a zone has a current version no zone ceiling applies to
pools that name it; once zones exist, a pool must name a defined zone.

A zone specification: `{contents, trust: private|external, cidrs: [cidr], maxLabel, accepts: [target], acceptsNote,
egress: {mode: deny|allow-list, allow: [target], note}, peers: [{zone, transport: vpc-peering|wireguard|ipsec|direct,
mtls: required|optional}], services: [compose service]}`. A target is `{kind: zone, zone, ports}`, `{kind: cidr, cidr,
ports}` or `{kind: corporate, ports}` (rendered from `ZONES_CORPORATE_CIDRS`).

| Method and path | What it does |
| --- | --- |
| `GET /admin/zones` | `{airGapped, corporateCidrs, zones, undefinedRefs, problems, defaults, lastChange}`. Each zone: `{id, position, version, spec, external, draft: {version, spec, reason, movePools, proposedBy, proposedByName, proposedAt, mine} \| null, pools: [{id, name, labelCeiling, effectiveCeiling, instances}], members}`; a member is `{ref, name, kind: instance\|endpoint\|connection\|mcp, health: healthy\|degraded\|unhealthy\|unknown, state, detail, since, failures, checks, address, pool, tenant, drainable}` |
| `POST /admin/zones/seed` | Creates the default zones (edge, app, data, directory, inference, sandbox, training, external) that do not exist, as approved v1. `{created, skipped, adjusted: [{zone, from, to}]}`: a default ceiling is raised to what the zone already holds |
| `POST /admin/zones` `{id, spec, movePools?, reason?}` | Proposes a new zone (draft v1). `seed` and `rendered` are reserved ids |
| `POST /admin/zones/:id/proposals` `{patch, movePools?, reason?}` | Proposes a change: `patch` (any spec fields) is merged over the current version; `movePools` (pool names) move into the zone on approval. One open draft per zone (`409`). Other system admins are notified |
| `GET /admin/zones/:id/blockers?ceiling=<label>` | What must move first for that ceiling: `[{kind: pool\|placement\|profile\|connection, label, pool, model, profile, connection, tenant}]` |
| `POST /admin/zones/:id/draft/approve` `{note?}` | Dual control: another system admin applies the draft (`403 step: dual-control` for the proposer). Re-checks everything; routing follows at once |
| `POST /admin/zones/:id/draft/reject` `{note?}`, `POST /admin/zones/:id/draft/withdraw` | Rejects (not the proposer), withdraws (the proposer only) |
| `GET /admin/zones/:id/versions` | History: `[{version, status: draft\|current\|superseded\|withdrawn\|rejected, spec, movePools, reason, proposedBy(Name), proposedAt, decidedBy(Name), decidedAt, decisionNote}]` |
| `GET /admin/zones/:id/diff?version=` | The open draft (else current), or version N, against the version current before it: `{zone, from, to, renders: {networkpolicy, compose, nftables: {before, after, text, added, removed}}}`; `text` is a line diff (`+`, `-`, space) |
| `GET /admin/zones/rendered/:format` | Every current zone as a file (`networkpolicy`, `compose` or `nftables`) |
| `GET /admin/zones/:id/rendered/:format?version=` | One zone at a version (default current) as a file |
| `POST /admin/zones/:id/endpoints` `{name, address, kind?}`, `DELETE /admin/zones/:id/endpoints/:endpointId` | Registers a static endpoint (`http(s)://` URL checked with GET, `host:port` with a TCP connect) and checks it at once; removes it. Refused in the external zone |
| `POST /admin/zones/:id/endpoints/check` | Checks the zone's registered endpoints now; `unhealthy` after `ZONE_HEALTH_FAILURES` consecutive failures |
| `POST /admin/zones/:id/members/drain`, `.../undrain` `{ref: instance:<id> \| endpoint:<id>}` | Drains an Ollama instance through the gateway (as `POST /admin/instances/:id/drain`), or stops checking an endpoint |

Proposals and approvals are validated against the whole zone set: peers and zone targets must be defined; a
zone-to-zone rule needs a peer link, and an egress rule needs the target to accept the source; CIDRs may not overlap;
a service belongs to one zone; the external zone stays empty (no pools, connections, MCP servers, endpoints or
services), is capped at `internal`, and in the air-gapped posture (`ZONES_AIR_GAPPED`, default true) has no peers,
ingress or egress while no zone may name a public address. Violations: `422 Invalid zone` with `problems: [{zone,
field, message}]` (problems the current set already has elsewhere do not block). A ceiling below what the zone holds:
`422 Ceiling too low` with `step: zone-ceiling, zone, ceiling, blockers`.

Elsewhere: `POST/PATCH /admin/pools` refuse a pool in the external zone or in a zone whose ceiling is below the pool's
(`403 step: zone`), or in an undefined zone once zones exist (`422 Unknown zone`); placements refuse models labelled
above the zone ceiling (`403 step: zone`); profile publication and gateway routing use a pool's effective ceiling
(the lower of its own and its zone's). The socket event `zones.state` (to holders of `pools:manage`) says zones,
drafts or endpoint health changed. The `zones.health` job checks registered endpoints every `ZONE_HEALTH_MINUTES`.

## Sprint 9: Platform operations

Every route below is under `/api/admin/platform`, needs a session (or API key) with `platform:manage` (system
admins; the role needs a second factor), answers `Cache-Control: no-store`, and writes an audit event in the
caller's tenant for every change. Platform rows carry no tenant data and no labels, so there is no clearance
filtering; long work runs as jobs (`ops.*`) whose progress reaches the caller's sockets as `job.progress`. Scheduled
work (backups, drills, the RPO watch, mirror probes, the certificate sweep) runs once per bucket, recorded in the
default tenant's chain with `actor.service = "platform-ops"`.

### Summary

| Method and path | What it does |
| --- | --- |
| `GET /platform/summary` | `{kms: {kind, ok, detail}, blobs, clock: {skewMs, against}, secretsFromFiles: [{name, file}], scanner, staging, licenceAllow, scanFailSeverity, bundleMaxBytes, acme: {directoryUrl, registered, kid, contact, renewDays, checkMinutes}, backup: {everyMinutes, retain, rpoMinutes, rtoMinutes, drillEveryMinutes, dbClient, alert}, keyRotationDays, bundles: {total, ready, rejected, expedited}, certificates: {total, expiring, nextExpiry}, mirrors: {total, stale}}`. `clock.skewMs` is the difference between this server's clock and the database server's |

### Import signer keys

| Method and path | What it does |
| --- | --- |
| `GET /platform/signers` | `[{id, name, algorithm, fingerprint, short, publicKeyPem, state, createdAt, revokedAt, revokeReason}]`; `fingerprint` is the sha256 of the SPKI DER (hex), `short` its first three bytes (`3f:9a:c1`) |
| `POST /platform/signers` `{name, publicKeyPem}` | Registers the public half of an offline signing key (Ed25519 or ECDSA P-256); 201. 400 for any other key type, 409 when already registered |
| `POST /platform/signers/:id/revoke` `{reason}` | Revokes it; bundles signed by it fail step 2 from then on, including verified bundles not yet promoted |

### Import bundles

A bundle is a POSIX tar whose first two entries are `manifest.json` and `manifest.sig`, followed by
`files/<path>` for every file the manifest lists:

```json
{ "format": "exprsn-bundle/1", "id": "2026-38-weekly", "created": "2026-09-18T22:10:00Z", "contents": "optional summary",
  "files": [{ "path": "npm/left-pad-1.3.0.tgz", "sha256": "<hex>", "size": 1234, "mirror": "npm" }],
  "sbom": { "bomFormat": "CycloneDX", "specVersion": "1.5", "components": [{ "name": "left-pad", "version": "1.3.0", "licenses": [{ "license": { "id": "MIT" } }] }] } }
```

`mirror` is one of `images`, `npm`, `pypi`, `trivy`, `models`, `apt`, `tofu`. `manifest.sig` is
`{"algorithm": "ed25519" | "ecdsa-p256-sha256", "key": "<fingerprint hex>", "signature": "<base64>"}`, a detached
signature over the exact bytes of `manifest.json` (ECDSA in DER encoding). Links, devices and paths outside the
bundle make it invalid.

Bundle views: `{id, name, state, expedited, ticket, transfer, contents, size, digest, manifestId, signer: {fingerprint, short, name, algorithm, state} | null, steps: [{title, state, detail, at}] × 7, report, error, jobId, createdAt, receivedAt, verifiedAt, promotedAt}`.
`state` is `awaiting transfer`, `verifying`, `ready to promote`, `promoting`, `in production` or `rejected`; each
step is `waiting`, `running`, `passed`, `failed` or `skipped` (not configured). The steps: transfer received,
signature verified against the offline key, digest matched the manifest, SBOM and vulnerability scan, licence
check, staging deploy, promoted to internal mirrors. `report` holds `{files, byMirror, components, scanner,
findings, blocking, licences, licenceProblems, staging, promotedTo, kindsWithoutMirror}` as far as the pipeline got.

| Method and path | What it does |
| --- | --- |
| `GET /platform/bundles` | Newest first, up to 500 |
| `GET /platform/bundles/:id` | One bundle |
| `POST /platform/bundles` `{name, transfer: diode \| removable media \| upload, contents?, expedited?, ticket?}` | Opens an import that waits for its transfer; 201. `name` is lower-case letters, digits, `.`, `-`, `_`. An expedited import needs its security ticket (400 without). 409 for a duplicate name |
| `PUT /platform/bundles/:id/transfer` | The bundle file as the raw body (`Content-Type: application/octet-stream` or `application/x-tar`, never JSON), capped at `PLATFORM_BUNDLE_MAX_BYTES` (413). Stores it in the blob store at `platform/bundles/<id>/transfer.tar`, records its sha256 and queues verification (`ops.bundle.verify`); 202. Accepted while awaiting a transfer or after a rejection |
| `POST /platform/bundles/:id/verify` | Runs the pipeline again (for example after a signer key was added); 202. 409 while promoting, in production or already verifying |
| `POST /platform/bundles/:id/promote` | Only for `ready to promote`; 202 and an `ops.bundle.promote` job that checks the digest and signature again, writes each file to `mirrors/<kind>/sha256/<digest>` with an index at `mirrors/<kind>/index/<bundle>.json`, and records the promotion on every mirror of that kind |
| `DELETE /platform/bundles/:id` | Deletes a rejected (quarantined) bundle, or one still awaiting its transfer, and its file; 204. The audit event keeps the reason and both the actual and expected signer fingerprints |

A signature failure rejects the bundle before anything past the first two entries is read; nothing is written
anywhere before promotion. System admins are notified of every rejection.

### Mirrors

Views: `{id, name, kind, store, url, host, consumer, maxAgeDays, lastBundle, lastPromotedAt, ageDays, policy, stale, lastCheckAt, lastCheckOk, lastCheckDetail, createdAt, updatedAt}`.
`policy` is `ok`, `older than N days`, `never promoted` or `unreachable`; `maxAgeDays: null` means content-addressed
(never stale; the default for `models`, 7 days otherwise).

| Method and path | What it does |
| --- | --- |
| `GET /platform/mirrors` | Every mirror, by name |
| `POST /platform/mirrors` `{name, kind, store, url, consumer?, maxAgeDays?}` | 201. The URL must resolve only to internal addresses (private, loopback, CGNAT) unless `PLATFORM_ALLOWED_HOSTS` names it; 400 otherwise |
| `PATCH /platform/mirrors/:id` | Any of the fields above; the audit event records before and after |
| `DELETE /platform/mirrors/:id` | 204; files already in its store stay |
| `POST /platform/mirrors/check` `{mirrorIds?}` | Queues `ops.mirror.check`: a GET to each URL through a dispatcher that re-checks every resolved address at connect time; any answer below 500 counts as up; 202 `{jobId}` |

### Certificates

Views: `{id, name, domains, issuedTo, use, method: acme | tracked, state, status, days, autoRenew, issuer, serial, fingerprint, notBefore, notAfter, hasKey, error, jobId, renewedAt, createdAt}`.
`status` is `pending`, `issuing`, `valid`, `expiring` (inside `ACME_RENEW_DAYS`), `expired`, `failed` or `revoked`.

| Method and path | What it does |
| --- | --- |
| `GET /platform/certificates` | By expiry |
| `POST /platform/certificates` `{domains, issuedTo?, use?: TLS \| mTLS \| LDAPS \| other, autoRenew?}` | Orders from `ACME_DIRECTORY_URL` (409 when unset) with a fresh ECDSA P-256 key and an http-01 challenge; 202 and an `ops.cert.issue` job. The account is registered on first use (ES256 JWS, key sealed with the platform data key) |
| `POST /platform/certificates/track` `{pem, issuedTo?, use?}` | Tracks a certificate issued elsewhere (the CA's own, for example) for expiry; refuses PEM that contains a private key |
| `PATCH /platform/certificates/:id` `{issuedTo?, use?, autoRenew?}` | Edits the description and renewal |
| `POST /platform/certificates/:id/renew` | ACME only; a new order with a new key. A failed renewal keeps the certificate in place and notifies system admins |
| `POST /platform/certificates/:id/revoke` `{reason: unspecified \| keyCompromise \| superseded \| cessationOfOperation}` | Revokes at the CA (RFC 8555 `revokeCert`) and stops renewal |
| `DELETE /platform/certificates/:id` | Removes a tracked, failed, expired or revoked certificate (409 for a valid ACME one: revoke it first) |
| `GET /platform/certificates/:id/chain` | The PEM chain as `application/pem-certificate-chain` |
| `POST /platform/certificates/:id/key` | The private key (PKCS#8 PEM) for the deploy tooling. POST so it is CSRF-checked; audited as `platform.cert.key.exported` every time |

The sweep (`ops.cert.sweep`, every `ACME_CHECK_MINUTES`) renews ACME certificates inside the window and notifies
system admins (socket and email) once a day about certificates that expire within it without renewal, or within 7
days despite it. The http-01 answer is public: `GET /.well-known/acme-challenge/:token` (outside `/api`, no session)
returns the key authorization of an order in flight as `text/plain`, 404 otherwise.

### Data keys

| Method and path | What it does |
| --- | --- |
| `GET /platform/keys` | `[{scope, name, tenant, kms, version, rotatedAt, nextRotation, versions, state}]`: the platform data key and each tenant's; `nextRotation` is `rotatedAt + PLATFORM_KEY_ROTATION_DAYS` |
| `POST /platform/keys/:scope/rotate` | A new data key version (`platform` or a tenant id); old versions stay readable; audited as `kms.key.rotated`. 404 for an unknown scope |

### Backups and restore drills

A backup is a logical dump of every table of the application database (one repeatable-read transaction on
PostgreSQL and MySQL), gzipped, encrypted with a fresh AES-256-GCM key wrapped by the KMS
(`<OPENBAO_KEY_PREFIX>platform-backups`), and stored with a KMS-signed manifest (tables, row counts, migrations,
archive digest, wrapped key) at `platform/backups/<id>.bin` and `.manifest.json`. Opening one needs only the KMS.

| Method and path | What it does |
| --- | --- |
| `GET /platform/backups` | `{backups: [{id, state, kind, dbClient, tables, rows, bytes, manifestHash, signed, error, jobId, createdAt, finishedAt}], drills: [{id, backupId, state, steps: [{title, state, ms, detail}], rpoMs, rtoMs, rpoTargetMs, rtoTargetMs, withinTarget, detail: {counts, chains, skipped, migrations}, error, jobId, createdAt, finishedAt}], alert, rpoMinutes, rtoMinutes, everyMinutes, retain, dbClient, blobStore, kms}` |
| `POST /platform/backups` | Queues `ops.backup.create`; 202. 409 while one runs. The newest `PLATFORM_BACKUP_RETAIN` successful backups are kept |
| `POST /platform/backups/drills` `{backupId?}` | Restores a backup (default: the newest) into a scratch SQLite file, never the live database, and checks the manifest signature, the archive digest, the schema version, every table's row count and each tenant's audit chain and signed checkpoints; 202. Records measured RPO (backup age at the start) and RTO (drill duration) against the targets |
| `GET /platform/backups/drills/:id` | One drill |
| `POST /platform/backups/alert/acknowledge` | Acknowledges the "backup target missed" alert (raised by `ops.backup.watch` when the newest backup is older than `PLATFORM_BACKUP_RPO_MINUTES`; cleared by the next backup) |

CLI: `exprsn-ai backup:create` and `exprsn-ai backup:restore-drill [--backup <id>]` do the same without the queue
(the drill exits 2 when it fails).

## Sprint 9: Federation (Identity screen)

The OIDC provider, SAML IdP, upstream federation, Kerberos SPNEGO and device flow. Flows and design decisions are in
`docs/identity.md` ("Federation"). The default tenant's issuer is `FEDERATION_ISSUER` (default `PUBLIC_URL`); other
tenants' issuers are `<issuer>/t/<slug>` and their protocol endpoints live under that prefix.

### Protocol endpoints (outside `/api`, under the tenant's issuer)

| Method and path | What it does |
| --- | --- |
| `GET /.well-known/openid-configuration` | Discovery (issuer, endpoints, `S256`, `ES256`, grant types). CORS open |
| `GET /.well-known/jwks.json` | The key set: `next`, `signing` and retired keys still in their overlap window (public members only) |
| `GET /oauth/authorize` | Authorization code: `response_type=code`, `client_id`, exact `redirect_uri`, `scope`, `state`, `nonce`, `code_challenge` + `code_challenge_method=S256` (required for public clients and clients with PKCE required), `prompt=none\|consent`, `audience`/`resource`. Unknown client or redirect URI → error page (no redirect). Other errors redirect with `error`, `state` and `iss` (RFC 9207). Without a session (or with the Strict cookie withheld on a cross-site redirect): a continue page that resumes or opens the console sign-in. Consent page when needed |
| `POST /oauth/authorize` (form) `handle, csrf, decision=allow\|deny` | The consent decision; the token is bound to the session; cross-origin refused |
| `POST /oauth/token` (form; client auth by HTTP Basic, form `client_secret`, or `client_id` alone for public clients) | `grant_type=authorization_code` (`code, redirect_uri, code_verifier`), `refresh_token` (`refresh_token`, optional narrower `scope`; rotated on use, reuse revokes the family), `client_credentials` (`scope?`, `audience?`), `urn:ietf:params:oauth:grant-type:device_code` (`device_code`), `urn:ietf:params:oauth:grant-type:token-exchange` (`subject_token`, `subject_token_type=urn:ietf:params:oauth:token-type:access_token`, `scope?`, `audience?`). Returns `{access_token, token_type: Bearer, expires_in, scope, id_token?, refresh_token?}`; errors are RFC 6749 JSON (`invalid_client` 401, `invalid_grant`, `invalid_scope`, `unauthorized_client`, `authorization_pending`, `slow_down`, `access_denied`, `expired_token`). 60 requests a minute per address |
| `GET/POST /oauth/userinfo` (Bearer) | `sub`, `tenant` and the identity claims of the token's scopes; `401 WWW-Authenticate: Bearer error="invalid_token"` when the token, client, user or grant is no longer live |
| `POST /oauth/revoke` (form, client auth) `token` | RFC 7009: revokes a refresh token's family, or the grant behind an access token; always 200 for an authenticated client |
| `POST /oauth/device_authorization` (form, client auth) `scope` | RFC 8628: `{device_code, user_code: "XXXX-XXXX", verification_uri, verification_uri_complete, expires_in, interval}` |
| `GET /device?user_code=` | The verification page (approves through `/api/auth/device`) |
| `GET /saml/metadata` | IdP metadata: entity ID `<issuer>/saml/idp`, signing certificate, SSO for both bindings, NameID formats |
| `GET /saml/sso?SAMLRequest=&RelayState=&SigAlg=&Signature=`, `POST /saml/sso` (form) | SP-initiated SSO (HTTP-Redirect with DEFLATE, or HTTP-POST). Registered, enabled SP; registered ACS URL; signature checked when the SP requires signed requests. Redirects to `/saml/continue?h=` |
| `GET /saml/continue?h=` | With the console session: a page that posts the signed `SAMLResponse` (and `RelayState`) to the ACS; its CSP allows that origin in `form-action` |
| `GET /federation/oidc/start?provider=&return=` | Starts an upstream OIDC sign-in (PKCE, nonce, state; browser-binding cookie) |
| `GET /federation/oidc/callback?code=&state=` | Completes it: code exchange, ID token verification, JIT provisioning, session (second factor for admin roles) |
| `GET /federation/saml/start?provider=&return=` | Starts an upstream SAML sign-in (AuthnRequest over HTTP-Redirect) |
| `POST /federation/saml/acs` (form) `SAMLResponse, RelayState` | Completes it (signed assertion, audience, recipient, `InResponseTo`, validity) |
| `GET /federation/saml/:providerId` | Our SP metadata for that upstream provider (the URL is our entity ID) |
| `GET /auth/negotiate?return=` | Kerberos SPNEGO: `401 WWW-Authenticate: Negotiate` without a ticket; with `Authorization: Negotiate <token>` verifies it, maps the principal through the user stores and signs in (302); `WWW-Authenticate: Negotiate <token>` for mutual authentication |

`return` accepts only this server's `/oauth/authorize?…`, `/saml/continue?…` and `/device` paths.

### Sign-in helpers (`/api/auth`)

| Method and path | What it does |
| --- | --- |
| `GET /auth/sign-in-options?tenant=` | Public. `{upstream: [{id, name, protocol, start}], kerberos: false \| {start}}` for the sign-in screen |
| `GET /auth/device?user_code=` | Signed-in browser session. `{client: {name, type}, scopes, expiresAt}` of a pending device request in the caller's tenant (scopes already intersected with the caller's permissions); 404 when unknown, used or expired |
| `POST /auth/device` `{userCode, approve}` | Approves or denies it as the caller (audited `oidc.device.approved`/`denied`) |

### Admin (`identity:manage`)

| Method and path | What it does |
| --- | --- |
| `GET /admin/federation` | `{issuer, discoveryUrl, jwksUrl, rotation: {days, overlapDays, rotatesAt}, keyStore, keys, idp: {entityId, metadataUrl, ssoUrl, assertionMinutes, certificate}, upstream: {redirectUri, acsUrl, allowList}, device: {verificationUri, minutes, interval}, kerberos: {available, service, detail, enabled, realms}, settings}` |
| `GET /admin/federation/keys` | `{keys, jwks, rotatesAt}`. A key: `{kid, alg, state: signing \| next, published \| verify only, overlap, createdAt, activatesAt, retiresAt, removesAt, jwk}` |
| `POST /admin/federation/keys/rotate` `{immediate?}` | Publishes a new key that signs after the overlap (or at once with `immediate`); a pending next key is replaced. `201 {next, previous, keys}` |
| `GET /admin/federation/scopes` | The scope catalogue `[{scopes, grants, consent}]` |
| `GET/PATCH /admin/federation/settings` `{consent?: {firstPartyPreconsented?, thirdPartyAsk?, remember?}, kerberos?: {enabled?, realms?}}` | Per-tenant consent policy and Kerberos settings |
| `GET /admin/federation/oidc/clients`, `GET …/:id` | Clients: `{id, clientId, name, type: first_party\|public\|service\|third_party, typeLabel, grants, scopes, redirectUris, pkceRequired, status, accessTtl, refreshTtl, models, confidential, secretCreatedAt, serviceUserId, lastUsedAt, createdAt, consent}`. Never the secret |
| `POST /admin/federation/oidc/clients` `{name, type, redirectUris, scopes, grants (authorization_code, refresh_token, client_credentials, device_code, token_exchange), pkceRequired?, accessTtl? (300\|600\|1800), models?}` | `201 {client, secret}`: the secret (`xs_live_…`) is returned only here, and `null` for public clients. Redirect URIs: exact https, loopback http or a private-use scheme; wildcards refused. Client credentials only for service accounts, which get a `svc-<name>` user with the `member` role |
| `PATCH /admin/federation/oidc/clients/:id` `{name?, redirectUris?, scopes?, pkceRequired?, accessTtl?, models?}` | Edits (public clients always require PKCE) |
| `POST /admin/federation/oidc/clients/:id/secret` | Rotates the secret: `201 {client, secret}`, shown once; the old one stops at once |
| `POST /admin/federation/oidc/clients/:id/disable`, `…/enable` | Disabling revokes refresh tokens and pending device codes: `{client, revoked}` |
| `GET /admin/federation/saml/sps` | Service providers: `{id, name, entityId, acsUrls, nameIdFormat, cert: {subject, issuer, validTo, fingerprint, expired}, signedRequests, attributeMap, status, lastUsedAt, createdAt}` |
| `POST /admin/federation/saml/parse` `{xml}` | Parses SP metadata for review: `{entityId, acsUrls, certificate, cert, nameIdFormat, signedRequests}` |
| `POST /admin/federation/saml/sps` `{name, xml, nameIdFormat?, attributeMap?}` | Registers it (re-parsed on the server) |
| `PATCH /admin/federation/saml/sps/:id` `{status?, signedRequests?, nameIdFormat?}` | Enabling with an expired certificate needs `signedRequests: false` (`409` otherwise) |
| `DELETE /admin/federation/saml/sps/:id` | Removes it |
| `GET /admin/federation/upstream` | Upstream providers: `{id, name, protocol, protocolLabel, source, reach, status: connected\|unreachable\|disabled, usedBy, spEntityId, startUrl}` |
| `POST /admin/federation/upstream/check` `{protocol: oidc\|saml, source}` | Reachability: resolves and checks the address (internal only, or `FEDERATION_ALLOWED_HOSTS`), fetches discovery and JWKS, or reads SAML metadata (URL or pasted XML): `{ok, reach, steps, parsed}` |
| `POST /admin/federation/upstream` `{name, protocol, source, clientId?, clientSecret? (env:/file: reference)}` | Adds an `oidc` or `saml` user store after a successful check. Edit, reorder or remove it in User stores |
| `GET /admin/federation/sessions` | Console sessions, OAuth grants and recently used service clients: `[{kind: session\|grant\|service, id, user, username, signedInAt, method, client}]` |
| `POST /admin/federation/sessions/revoke` `{kind, id}` | Revokes a session (and its refresh tokens), a grant, or disables a service client |
| `POST /admin/federation/test-login` `{method: kerberos\|password\|device, username}` | Runs the sign-in pieces without a session: `{ok, steps, pending?}` |

Audit actions: `oidc.authorized`, `oidc.consent.granted`/`denied`, `oidc.token.issued`/`refused`/`revoked`,
`oidc.refresh.reused`, `oidc.device.approved`/`denied`, `oidc.grant.revoked`, `saml.sso`, `saml.sso.refused`,
`federation.key.rotated`, `federation.settings.updated`, `federation.client.created`/`updated`/`secret_rotated`/
`disabled`/`enabled`, `federation.saml_sp.created`/`updated`/`deleted`, `federation.upstream.checked`,
`federation.test_login`, and `auth.login*` with `target.kind` `oidc`, `saml` or `kerberos`.

Access tokens whose audience is `<issuer>/api` are also accepted by the console API as `Authorization: Bearer <jwt>`, like API keys: the token's scopes narrow the user's roles, the client, grant, user and tenant must still be active, and an admin-role user's token must carry a second factor in `amr`.

## Sprint 14: Federation, second part

Revocation and introspection, logout, pushed and signed authorization requests, DPoP, re-authentication, SAML single
logout and encrypted assertions, and signing in OpenBao transit. Discovery now advertises `introspection_endpoint`,
`end_session_endpoint`, `pushed_authorization_request_endpoint`, `request_parameter_supported`,
`request_uri_parameter_supported`, `request_object_signing_alg_values_supported` and
`dpop_signing_alg_values_supported` (`ES256`, `RS256`), and front- and back-channel logout support (with `sid`).

### Protocol endpoints (outside `/api`, under the tenant's issuer)

| Method and path | What it does |
| --- | --- |
| `POST /oauth/revoke` (form, client auth) `token, token_type_hint?` | RFC 7009. A refresh token revokes its family; an access token goes on the deny-list (by `jti`, kept until it would have expired), so the API, `userinfo` and introspection refuse it at once on every instance. Only the client the token was issued to can revoke it; anything else answers 200 without effect |
| `POST /oauth/introspect` (form, confidential client auth) `token, token_type_hint?` | RFC 7662. `{active: true, token_type: Bearer\|DPoP\|refresh_token, scope, client_id, sub, username, iss, aud?, iat, exp, jti?, cnf?, auth_time?, act?, tenant}` for a live token issued to the calling client; `{active: false}` for anything revoked, expired, unknown or issued to another client. Public clients get `401 invalid_client` |
| `POST /oauth/par` (form, client auth) authorization parameters or `request` | RFC 9126: validates the request as `/oauth/authorize` would and answers `201 {request_uri: "urn:ietf:params:oauth:request_uri:…", expires_in: 60}`. The URI works for one authorization; once a browser presents it, it stays usable for the sign-in (ten minutes) |
| `GET /oauth/authorize` | Also: `request_uri` (a pushed request, with `client_id`), `request` (a request object signed ES256 or RS256 with a key in the client's registered `jwks`; `iss` the client, `aud` the issuer, `exp` within an hour, `jti` single use; only its parameters are used), `prompt=login` and `max_age` (the page asks to sign in again: it signs the session out and resumes after a new sign-in; with `prompt=none` the answer is `login_required`). A client with `parRequired` must push its requests |
| `POST /oauth/token` | Also: a `DPoP` header (RFC 9449 proof: `typ dpop+jwt`, ES256 or RS256 with the public JWK in the header, `htm` POST, `htu` the token endpoint, `iat` within `DPOP_PROOF_MAX_AGE_SECONDS`, single-use `jti`) binds the tokens to the key: `token_type: DPoP` and `cnf.jkt` in the access token; the refresh token only refreshes with a proof from the same key. `invalid_dpop_proof` when a proof is bad, or missing for a client with `dpopRequired` |
| `GET/POST /oauth/userinfo` | Also accepts `Authorization: DPoP <token>` with a proof (`htu` the userinfo endpoint, `ath` the token hash); a DPoP-bound token sent as Bearer is refused |
| `GET /oauth/logout`, `POST /oauth/logout` (form) `id_token_hint?, client_id?, post_logout_redirect_uri?, state?` | RP-initiated logout. The hint (an ID token from this issuer, expired or not) names the client and user; `post_logout_redirect_uri` must be registered exactly for that client. Answers a confirmation page whose form posts back (`handle, decision=logout\|stay`) from our origin, so the SameSite=Strict session cookie is present and a cross-site sign-out is impossible. Signing out ends the session (and its refresh tokens), then shows a page that loads each front-channel logout URL (`?iss=&sid=`) in hidden frames (CSP `frame-src` allows exactly those origins, on this page only) and continues to the redirect with `state`. When the session came from an upstream SAML IdP with a logout endpoint, the browser goes there first (signed LogoutRequest) and comes back through `/federation/saml/slo`. A hint for another user is refused |
| `GET /saml/metadata` | Also lists `SingleLogoutService` (both bindings) at `<issuer>/saml/slo` |
| `GET /saml/slo?SAMLRequest=&RelayState=&SigAlg=&Signature=`, `POST /saml/slo` (form) | IdP single logout. A signed LogoutRequest from a registered SP (a certificate is required) ends the sign-in sessions it names by NameID and SessionIndex, tells the other SPs (HTTP-Redirect LogoutRequests) and OIDC clients (front-channel) in frames, and answers with a signed LogoutResponse over the SP's binding. A `SAMLResponse` here (an SP answering a frame) just shows the signed-out page |
| `GET /federation/saml/slo`, `POST /federation/saml/slo` (form) | SP single logout for upstream SAML IdPs: a signed LogoutRequest from the provider ends the sessions it names and gets a LogoutResponse signed with the tenant's SAML key; a LogoutResponse to a logout started here continues to the relying party |
| `GET /federation/saml/:providerId` | Our SP metadata now carries a signing certificate (the tenant's SAML key), an encryption certificate (AES-256-GCM, RSA-OAEP) and `SingleLogoutService` |
| `POST /federation/saml/acs` | Also accepts one `EncryptedAssertion` (AES-GCM content, RSA-OAEP key transport with SHA-1 or SHA-256; CBC and RSA 1.5 refused), decrypted with the tenant's SP key, then checked as before |

Access tokens carry `jti`; ID tokens from a browser session carry `sid`. Back-channel logout tokens (`typ
logout+jwt`, `events` with `http://schemas.openid.net/event/backchannel-logout`, `sid`, `sub`, two minutes) are posted
as `logout_token` to each client with a `backchannelLogoutUri` that the session signed in to, by a
`federation.backchannel` job (retried; the host must pass the upstream checks: internal, or in
`FEDERATION_ALLOWED_HOSTS`). This happens whenever the session ends: sign-out in the console or at `/oauth/logout`, a
revocation by the user or an admin, a disabled user or tenant.

The console API accepts `Authorization: DPoP <token>` with a `DPoP` proof whose `htu` is `PUBLIC_URL`'s origin plus the
request path.

### Me

| Method and path | What it does |
| --- | --- |
| `GET /me/grants` | The applications the caller consented to or holds live tokens for: `[{clientId, name, type, scopes, consentedAt, consentExpiresAt, activeGrants, lastUsedAt, createdAt}]` |
| `DELETE /me/grants/:clientId` (browser session) | Revokes the caller's grant to that application: the consent is forgotten, every refresh-token family is revoked, and every access token issued so far is refused (deny-list); `{revoked, clientId, consents, refreshTokens}`. The user gets a `security` notification (also on a new consent) |

### Admin (`identity:manage`)

| Method and path | What it does |
| --- | --- |
| `GET /admin/federation` | Also `signingInKms` (true with `KMS_PROVIDER=openbao`), `idp.sloUrl`, `upstream.sloUrl` |
| `POST /admin/federation/oidc/clients`, `PATCH …/:id` | Also `postLogoutRedirectUris` (exact, like redirect URIs), `frontchannelLogoutUri`, `backchannelLogoutUri` (https, or http on loopback), `jwks` (a JWK set of one to five public EC P-256 or RSA-2048+ keys for request objects; `null` removes it), `parRequired`, `dpopRequired`. The client view adds these (keys as `{kid, kty}`) |
| `GET /admin/federation/saml/sps`, `POST …/parse` | Also `sloUrl`, `sloBinding: redirect\|post`, `encryptionCert` and `encryptAssertions` (parse: `encryptionCertificate`, `encryptionCert`) |
| `POST /admin/federation/saml/sps` `{…, encryptAssertions?}` | Assertions are encrypted by default for an SP whose metadata has a valid encryption certificate |
| `PATCH /admin/federation/saml/sps/:id` `{…, encryptAssertions?}` | Turns encryption on or off (`409` without a valid encryption certificate) |

Audit actions: `oidc.token.revoked` (`detail.token`), `oidc.par.pushed`, `oidc.reauth.required`,
`oidc.grant.revoked_by_user`, `oidc.logout.backchannel`, `auth.logout` (`detail.via: end_session`), `saml.slo`,
`saml.slo.upstream`, `saml.slo.refused`.
