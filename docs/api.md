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
| `GET /media/assets/:id/content` | The file (supports `Range`). Sprint 15: media, previews, outputs and images are served with `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff` and `Cross-Origin-Resource-Policy: same-site`; with `MEDIA_ORIGIN` set these reads answer `302` to a signed URL on that origin instead (below) |
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

#### Media origin (Sprint 15)

With `MEDIA_ORIGIN` set (a separate host name for the same deployment), `GET /media/assets/:id/content`,
`/media/assets/:id/previews/:i`, `/media/jobs/:id/outputs/:i` and `/images/:id/image` and `/images/:id/download`
authorise the caller as before (and audit downloads), then redirect to `GET <MEDIA_ORIGIN>/media-content/<token>`
(outside `/api`, no session). The token is an HMAC-signed `{resource, tenant, user, workspace, exp}` valid for
`MEDIA_URL_TTL_SECONDS`; the principal is rebuilt from it and the same clearance and workspace checks run again. The
media host answers only `/media-content/*` and the health checks (404 for everything else). The console's CSP allows
that origin for `img-src` and `media-src` only.

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
| `POST /admin/connections` `{name, engine: postgres\|mysql\|opensearch, endpoint, database?, zone, label, rowLimit, timeoutS, tls, username?, password?, baoRole?}` | Registers; the credential is sealed with the tenant key and never returned. With `baoRole` (PostgreSQL and MySQL; needs `OPENBAO_ADDR` and `OPENBAO_TOKEN`) no credential is stored: each instance takes a short-lived account from OpenBao's database engine (`GET <OPENBAO_DATABASE_MOUNT>/creds/<role>`), renews its lease while in use and revokes it when dropped. Once zones are defined, `422 step: zone` for a zone that is not defined and `403 step: zone` for the external zone or a label above the zone's ceiling (audited as `connection.register.refused`). Other engines are refused |
| `GET /admin/connections/:id` | One connection |
| `PATCH /admin/connections/:id` `{endpoint?, database?, zone?, label?, rowLimit?, timeoutS?, tls?}` | New version of the settings; `ops: write` is refused; a new zone or label is checked against the zones as on registration |
| `PUT /admin/connections/:id/credential` `{username, password}` or `{baoRole}` | Replaces the credential with a sealed account, or switches to OpenBao dynamic credentials for that role; any OpenBao lease this instance holds for the connection is revoked |
| `DELETE /admin/connections/:id` | Refused (`409`) while a knowledge source reads from it |
| `POST /admin/connections/:id/test` | `{ok, ms, version, readOnly, detail, health}`; an account with write grants is `degraded` |
| `POST /admin/connections/:id/schema` | Introspects: `{objects, allowed, outside, connection}` |
| `PUT /admin/connections/:id/allow-list` `{objects, piiColumns}` | Objects the model and the browser may read (OpenSearch patterns such as `logs-*` allowed); extra PII columns as `object.column` |
| `POST /admin/connections/:id/query` `{query, object?, confirmUnparsed?}` | Classifies, then runs on the read-only account in a read-only transaction with the statement timeout: `{columns, rows, capped, estimate, ms, masked, label, unparsed, verb}`. Refusals: `422` write, DDL, several statements, object or function outside the allow-list (`kind`, `verb`, `object`); `409 kind: unparsed` until confirmed; `403` above the caller's clearance or blocked by the `db-query` checkpoint. Every outcome is audited with the query text |
| `POST /admin/connections/:id/export` | Same body and checks; the result as CSV (`X-Label` header), through the `export` checkpoint |
| `POST /admin/connections/:id/sync` | `202 {jobs}`: syncs every knowledge source reading from the connection |

A connection: `{id, name, engine, endpoint, database, zone, label, ops, rowLimit, timeoutS, account, hasCredential,
credentialSource: static | openbao, baoRole, lease: {username, expiresAt, renewable} | null, tls, allowList, piiColumns, schema: [{name, kind, allowed, columns: [{name, type, pii}]}], schemaAt, health,
healthDetail, checkedAt, version, syncs: [{kbId, kb, sourceId, object, lastSyncAt, state, docs}]}`. PII columns (by
name, or marked) and values the classifier recognises (emails, IBANs, cards, national identifiers, phone numbers)
are masked in every result as `••••` plus the last four characters.

MySQL (Sprint 15): queries are lexed as MySQL does before classification (backslash escapes, double-quoted strings,
backtick identifiers, `#` comments); `/*! */` executable comments, `--` without a following space, `LOAD_FILE`,
`SLEEP`, `BENCHMARK`, lock functions, `INTO OUTFILE`, `LOCK IN SHARE MODE` and `REPLACE` are refused. Reads run in
`START TRANSACTION READ ONLY` with `MAX_EXECUTION_TIME`; unqualified names resolve to the connection's database for
the allow-list. MySQL tables are not a knowledge source yet (PostgreSQL only).


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
| `GET /platform/summary` | `{kms: {kind, ok, detail}, blobs, clock: {skewMs, against}, secretsFromFiles: [{name, file}], scanner, staging, licenceAllow, scanFailSeverity, bundleMaxBytes, acme: {directoryUrl, registered, kid, contact, renewDays, checkMinutes}, backup: {everyMinutes, retain, rpoMinutes, rtoMinutes, drillEveryMinutes, dbClient, alert}, keyRotationDays, bundles: {total, ready, rejected, expedited}, certificates: {total, expiring, nextExpiry}, mirrors: {total, stale}}`. `clock.skewMs` is the difference between this server's clock and the database server's. Sprint 15 adds `clock.ntp: {server, skewMs, offsetMs, delayMs, stratum, error} \| null` (one SNTP query to `NTP_SERVER`; `offsetMs` is positive when this server is behind), `acme.challenge`, `acme.dnsProvider`, `acme.certDir`, `bundleRequireChecks`, `signerProposals` (pending), `mediaOrigin` and `rateLimits: memory \| redis` |

### Import signer keys

| Method and path | What it does |
| --- | --- |
| `GET /platform/signers` | `[{id, name, algorithm, fingerprint, short, publicKeyPem, state, createdAt, revokedAt, revokeReason}]`; `fingerprint` is the sha256 of the SPKI DER (hex), `short` its first three bytes (`3f:9a:c1`) |
| `POST /platform/signers` `{name, publicKeyPem}` | Registers the public half of an offline signing key (Ed25519 or ECDSA P-256). Sprint 15: under dual control. The first key (none registered) is added at once, 201 with the key; after that it is a proposal, `202 {proposal}`, applied when another platform admin approves. 400 for any other key type, 409 when already registered or already proposed |
| `POST /platform/signers/:id/revoke` `{reason}` | Proposes revoking it: `202 {proposal}`. Once approved by another platform admin, bundles signed by it fail step 2, including verified bundles not yet promoted |
| `GET /platform/signers/proposals` | `[{id, action: add \| revoke, keyId, name, algorithm, fingerprint, short, reason, state: pending \| approved \| rejected \| withdrawn, proposedBy, proposedByName, proposedAt, decidedBy, decidedByName, decidedAt, note, mine}]`, newest first |
| `POST /platform/signers/proposals/:id/approve` `{note?}` | Applies the change: `{proposal, key}`. 403 `step: dual-control` for the proposer; 409 once decided |
| `POST /platform/signers/proposals/:id/reject` `{note?}` | Another admin declines it (the proposer withdraws instead) |
| `POST /platform/signers/proposals/:id/withdraw` | The proposer withdraws it (403 for anyone else) |

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
| `PUT /platform/bundles/:id/transfer` | The bundle file as the raw body (`Content-Type: application/octet-stream` or `application/x-tar`, never JSON), capped at `PLATFORM_BUNDLE_MAX_BYTES` (413). Streamed (Sprint 15) into the blob store at `platform/bundles/<id>/transfer.tar` (S3: multipart), hashed on the way; queues verification (`ops.bundle.verify`); 202. Verification and promotion stream the archive too, so memory stays flat whatever the size. Accepted while awaiting a transfer or after a rejection. With `PLATFORM_BUNDLE_REQUIRE_CHECKS`, a missing scanner or staging hook fails steps 4 and 6 instead of skipping them, and `POST …/promote` answers 409 for a bundle whose scan or staging did not pass |
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
| `POST /platform/certificates` `{domains, issuedTo?, use?: TLS \| mTLS \| LDAPS \| other, autoRenew?}` | Orders from `ACME_DIRECTORY_URL` (409 when unset) with a fresh ECDSA P-256 key and an http-01 challenge, or dns-01 with `ACME_CHALLENGE=dns-01` (wildcards such as `*.apps.internal` need dns-01; 400 otherwise); 202 and an `ops.cert.issue` job. The account is registered on first use (ES256 JWS, key sealed with the platform data key) |
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

dns-01 (Sprint 15): the TXT record `_acme-challenge.<name>` holds base64url(sha256(key authorization)); it is
published before the CA is asked to validate and removed afterwards, through `ACME_DNS_PROVIDER`:

- `webhook`: `POST ACME_DNS_WEBHOOK_URL` with `{action: present | cleanup, domain, fqdn, value}` and
  `X-Exprsn-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with ACME_DNS_WEBHOOK_SECRET>`; any 2xx
  means done. The URL must be internal unless `PLATFORM_ALLOWED_HOSTS` names it.
- `rfc2136`: a DNS UPDATE (RFC 2136) over UDP to `ACME_DNS_RFC2136_SERVER` for the zone `ACME_DNS_RFC2136_ZONE`,
  signed with the TSIG key `ACME_DNS_TSIG_NAME`/`ACME_DNS_TSIG_SECRET` (HMAC-SHA256 or SHA512); the server's answer
  must carry a valid TSIG too.

After every issue or renewal the bus event `platform.cert.issued` `{certificate, name, serial, notAfter, renewal}`
goes to every instance; with `ACME_CERT_DIR` set, each writes `<dir>/<name>/fullchain.pem`, `cert.pem`, `chain.pem`
and `privkey.pem` (0600) atomically (a wildcard's directory is `_wildcard.<name>`) for its reverse proxy to reload.

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
Sprint 15: the dump is read a page at a time and streamed through gzip and the cipher into the blob store (S3:
multipart), never held in memory; with `PLATFORM_BACKUP_BLOBS` (default on) the blob store (everything but
`platform/backups/`) is archived too, as a tar sealed under its own key at `platform/backups/<id>.blobs.bin`, listed in
the manifest as `blobs: {objects, bytes, sha256, …}`. Drills authenticate both archives.

| Method and path | What it does |
| --- | --- |
| `GET /platform/backups` | `{backups: [{id, state, kind, dbClient, tables, rows, bytes, manifestHash, signed, error, jobId, createdAt, finishedAt}], drills: [{id, backupId, state, steps: [{title, state, ms, detail}], rpoMs, rtoMs, rpoTargetMs, rtoTargetMs, withinTarget, detail: {counts, chains, skipped, migrations}, error, jobId, createdAt, finishedAt}], alert, rpoMinutes, rtoMinutes, everyMinutes, retain, dbClient, blobStore, kms}` |
| `POST /platform/backups` | Queues `ops.backup.create`; 202. 409 while one runs. The newest `PLATFORM_BACKUP_RETAIN` successful backups are kept |
| `POST /platform/backups/drills` `{backupId?}` | Restores a backup (default: the newest) into a scratch SQLite file, never the live database, and checks the manifest signature, the archive digest, the schema version, every table's row count and each tenant's audit chain and signed checkpoints; 202. Records measured RPO (backup age at the start) and RTO (drill duration) against the targets |
| `GET /platform/backups/drills/:id` | One drill |
| `POST /platform/backups/alert/acknowledge` | Acknowledges the "backup target missed" alert (raised by `ops.backup.watch` when the newest backup is older than `PLATFORM_BACKUP_RPO_MINUTES`; cleared by the next backup) |

CLI: `exprsn-ai backup:create` and `exprsn-ai backup:restore-drill [--backup <id>]` do the same without the queue
(the drill exits 2 when it fails). Sprint 15: `exprsn-ai backup:restore --backup <id> [--from <dir>] [--no-blobs]
[--force --confirm "replace all data"]` restores into the configured database and blob store (see
`docs/deploy.md`), and `exprsn-ai kms:rewrap` moves every data key, checkpoint signature and backup to a new
key-encryption key.

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

## Sprint 11: Account self-service

Password routes apply to accounts in the tenant's local user store. For an LDAP, SQL or upstream account the password
is kept by the directory: the change route answers `409 Managed by the directory` naming the stores, and the admin
reset answers `409`.

### Me

| Method and path | What it does |
| --- | --- |
| `GET /me` | Now also returns `preferences {a11y: system\|aa\|aaa}`, `password` (`{managedHere: true, mustChange}` or `{managedHere: false, stores}`) and `stepUp {windowSeconds, authAt, methods}` (`password`, `totp`, `webauthn`) |
| `PATCH /me/preferences` `{a11y}` | Stores the accessibility mode with the account (it follows the user to every browser) |
| `POST /me/password` `{currentPassword, newPassword}` | Changes the local password. A wrong current password counts toward the sign-in lockout (`400 Wrong password` with `attempts_remaining`, `429` once locked); the new one must differ from the current one (`reason: reuse`), pass the policy (`reason: policy`) and the breached-password check (`reason: breached`). Ends every other session and every OAuth grant of the user: `{changed, stage, sessionsRevoked, grantsRevoked, csrf?}`. Also serves a session in the `password` stage, which becomes `active` under a new cookie (`csrf` is then the new token) |
| `POST /me/step-up` `{password}` or `{code}` or `{response}` | Confirms the signed-in user with the password (checked by the store that owns the account), a TOTP code or a passkey assertion; wrong answers count toward the lockout. `{authAt, windowSeconds, method}` |
| `POST /me/step-up/webauthn/options` | Passkey assertion options for step-up |

Step-up: `POST /me/api-keys`, `DELETE /me/mfa/:id` and `POST /me/mfa/recovery-codes` need a password or factor check
within `STEPUP_WINDOW_SECONDS` (signing in counts). Outside it they answer `401` with title `Step-up required` and
`step_up: true`; the session itself stays valid. The password change is its own re-authentication (it requires the
current password).

### Sign-in (`/api/auth`, public)

| Method and path | What it does |
| --- | --- |
| `POST /auth/password/forgot` `{identifier, tenant?}` | Username or email. Always `202 {accepted, detail}`, whether or not a matching local account with an email address exists; when one does, a single-use link valid for `PASSWORD_RESET_MINUTES` is emailed. `429` after `PASSWORD_RESET_PER_HOUR` requests an hour for one identifier, or four times that from one address; a third, per-account limit silently stops further emails |
| `POST /auth/password/reset` `{token, password}` | Sets the password with a reset, admin or invite link. `400 Invalid link` for an unknown, used or expired token. Ends every session and OAuth grant and lifts a sign-in lockout: `{reset, username, tenant}` |

The link is `<PUBLIC_URL>/#/signin?reset=<token>[&tenant=<slug>]`: the token travels in the URL fragment, which
browsers never send to a server, and the console removes it from the address bar as soon as it loads. Only
`sha256(token)` is stored.

`POST /auth/login` and the second-factor routes answer `stage: password` when the account's password was set or reset
by an admin. In that stage the session reaches only `POST /me/password` and `/auth/*` (every other route answers
`401` with `stage: password`); the second factor, when the account has one, is asked first.

### Users (`users:manage`)

| Method and path | What it does |
| --- | --- |
| `POST /admin/users` | Now takes `mustChange` (default `true`: the initial password must be changed at first sign-in), or `invite: true` with an `email` and no `password` to email a single-use link valid for `PASSWORD_INVITE_HOURS` (`{…, invited}`; `409` without an email address or SMTP) |
| `GET /admin/users/:id` | Now also returns `password {local, mustChange}` |
| `POST /admin/users/:id/password` `{mode: temporary, password}` or `{mode: link}` | Admin reset of a local account (not your own; only for someone whose roles you could grant). The old password stops working at once and every session and OAuth grant ends. `temporary` sets a password the user must change at next sign-in; `link` emails a single-use link (the admin never sees it). `{mode, mustChange, linkSent, sessionsRevoked, grantsRevoked}` |

Audit actions: `password.changed`, `password.change.failed`, `password.reset.requested`, `password.reset.ignored`,
`password.reset.completed`, `password.invite.accepted`, `password.breach_check.unavailable`, `user.password_reset`,
`user.invited`, `auth.step_up`, `auth.step_up.failed`, `auth.login.pending_password`, `user.preferences.updated`.

Security notices (`kind: security`, console and email, never carrying a secret) go to the account owner when their
password is changed or reset, a factor is added or removed or all are reset by an admin, recovery codes are
regenerated, an API key is created or revoked, or their sessions are signed out.

## Sprint 12: Chat (streaming guardrails, held answers, resumable streams, agent memory, citations, retention)

### Streaming and output guardrails

Answer text is not sent token by token. It is buffered to a sentence end or line break (or 240 characters without
one), the whole answer so far is screened by the enforced deterministic `model-output` rules (patterns, PII and
secret detectors, allow-lists, label, budget and meta rules), and only the part that passed goes out as `chat.chunk`
(thinking is screened the same way). A `block` stops the generation and nothing more is sent; a `require-approval`
sends nothing more and lets the answer finish for review; a `redact` sends the new text with the spans replaced.
The full `model-output` check (guard model and classifiers included) still runs once on the finished answer, as
before. When no deterministic rule applies at `model-output`, deltas stream as they arrive.

### Held answers (`require-approval` at `model-output`)

The answer is stored whole and sealed with `state: held`; the owner's view and catch-up show `state: held` with empty
content, thinking, tools and citations, and `chat.status {state: held}` / `chat.done {state: held}` say so. A flag of
`kind: hold` (action `require-approval`) goes to the review queue.

| Route | Behaviour |
| --- | --- |
| `GET /flags/:ref` | For a `hold` flag also `held: {messageId, state, content}` (the full answer), or `null` when it is gone; withheld above the reviewer's clearance like the rest |
| `POST /flags/:ref/decide` `{decision: approved\|rejected, reason?}` | Only for `hold` flags (`409` otherwise; `confirmed`/`dismissed` are refused on them). `approved`: the answer becomes `complete` and visible; `rejected`: it becomes `withdrawn` with the text "This answer was withdrawn after review." Either way the sequence number rises, the owner gets `chat.released {conversationId, messageId, state, seq}` and a notification, and the message's `guard.review` records the decision. A reviewer cannot decide on an answer in their own conversation (`403`, `step: dual-control`). An approval counts as a false positive of the rule, a rejection as a true positive. Audit: `chat.held`, `chat.hold.approved`, `chat.hold.rejected` |

Held and withdrawn answers are never sent back to the model as history.

### Resumable streams

Each chunk carries a sequence number and goes out on the bus. The generating instance writes the chunks, sealed, in
small batches to a shared catch-up buffer (Redis when `REDIS_URL` is set, the `chat_stream_chunks` table otherwise),
stores a snapshot of the released text every two seconds and then drops the batches the snapshot covers. It renews
a heartbeat on the answer; an answer whose heartbeat is older than `CHAT_STREAM_LEASE_SECONDS` is marked
`interrupted` (by whichever instance notices first: a catch-up, a conversation view, or the `chat.sweep` job), with
`chat.done {state: interrupted}` and the audit action `chat.interrupted`. An instance shutting down marks its own
answers interrupted.

| Route | Behaviour |
| --- | --- |
| `GET /conversations/:id/messages/:mid/stream?after=<seq>` | From any instance. Streaming: `{state, seq, chunks}` with the chunks after `after`, or, for a client behind the last snapshot, `{state, seq, content, thinking, tools}` (the snapshot with the buffered chunks after it applied). Otherwise the stored message as before |
| `POST /conversations/:id/messages/:mid/continue` `{profile?, think?}` (`chat:write`, `inference:invoke`) | For an `interrupted` or `stopped` answer: generates the rest in place (same message; sequence numbers continue). The model gets the stored text as the start of its turn. `202 {messageId, profile, model, think, from}`; `409` for any other state. The finished answer passes the output check as a whole; usage adds to the stored totals |

### Agent memory write-back

An agent definition may carry `memory: {write: off|propose, types: [progress, quirk], maxPerRun: 1-20}` (default
off). With `propose`, runs are offered a built-in `remember` tool `{text, type}`; each call becomes a `do` step titled
`remember` that proposes an `agent`-scope memory (owner: the agent's name, `origin: agent`, `source: {runId}`) through
the memory checkpoint (tenant policy, the credential ban and the `memory` guardrail rules with `meta.agent`). The
policy's type list and per-run cap, a text a curator rejected before, and a duplicate are refused as a `denied` step
whose error the model sees. Proposals wait for a knowledge curator (`POST /memory/:id/accept`); memory views carry
`run` for them. Audit: `memory.proposed`.

### Citations

Knowledge citations on an answer now also carry `span: [start, end]` (within the cited chunk) and `passage` (that
text), stored sealed with the answer. A reader whose clearance is below a citation's label gets `passage: null,
span: null, restricted: true`. Memory citations carry no passage.

### Conversation retention (`tenant:manage`)

| Route | Behaviour |
| --- | --- |
| `GET /admin/tenants/:tid/retention` | `{conversationDays, updatedBy, updatedAt, lastRunAt, lastPurged, sweepMinutes}`; `conversationDays: null` keeps conversations until their owners delete them |
| `PUT /admin/tenants/:tid/retention` `{conversationDays: 1-3650 \| null}` | Sets the policy. Audit: `tenant.retention.updated` |
| `POST /admin/tenants/:tid/retention/run` | Applies it now as the `chat.retention` job: `202 {jobId}`; `409` without a policy. Audit: `tenant.retention.run` |

The `chat.retention` job (every `CHAT_RETENTION_SWEEP_MINUTES` per tenant) deletes conversations not updated for more
than the period, with their messages, catch-up buffers and attachments no remaining message uses; conversations with
an answer still generating wait for the next run. Each purge is audited as `chat.retention.purged` with
`{days, before, conversations, messages, attachments}`.

## Sprint 13: Integrations

### OpenAI-compatible API (`/v1`, outside `/api`)

Bearer credentials only: an API key or an OAuth access token (`Authorization: Bearer …`). The session cookie is not
read, so no CSRF token is needed. Every route needs `inference:invoke`. Errors use OpenAI's shape
`{error: {message, type, code, param}}` (`invalid_request_error`, `authentication_error`, `permission_error`,
`rate_limit_error`, `api_error`) instead of problem+json; a quota refusal is `429` with `code: insufficient_quota` and
`Retry-After`, and a guardrail refusal is `400` with `code: content_filter`. `X-Data-Label` (default `internal`) is
the request's data label, checked against the caller's clearance, the workspace ceiling (`X-Workspace` picks the
workspace) and the profile's label, as in chat. Usage is metered as kind `api` (chat) or `embed`, with the API key.

| Route | Notes |
| --- | --- |
| `GET /v1/models`, `GET /v1/models/:id` | Published profiles and aliases the caller is cleared for (`id` is the profile name), plus approved embedding models: `{object: 'list', data: [{id, object: 'model', created, owned_by, meta}]}` |
| `POST /v1/chat/completions` `{model, messages, tools?, tool_choice?, temperature?, top_p?, max_tokens? \| max_completion_tokens?, stop?, seed?, presence_penalty?, frequency_penalty?, reasoning_effort?, stream?, stream_options?: {include_usage}}` | Roles `system`, `developer`, `user`, `assistant` (with `tool_calls`), `tool` (`tool_call_id`); images only as `data:` URLs for vision models. Every non-assistant message passes the `user-input` checkpoint (a redaction is what the model sees) and the answer the `model-output` checkpoint (a block replaces it with a notice and `finish_reason: content_filter`). The profile's system prompt goes first. Tool calls are returned to the client (`finish_reason: tool_calls`), never run on the server. Non-streaming: a `chat.completion`. Streaming: server-sent events of `chat.completion.chunk` objects (role, content, indexed `tool_calls`, the finish reason, then `usage` when asked) ending with `data: [DONE]`; with `OPENAI_STREAM_MODE=checked` (default) the content arrives after the output check, with `live` token by token. Nothing is sent before generation, so refusals are ordinary HTTP errors; an error after the stream started is a `data: {error}` event |
| `POST /v1/embeddings` `{model, input: string \| string[] (≤ 256), encoding_format?: float \| base64}` | An approved catalogue model with the `embedding` capability, through the gateway; inputs pass the `user-input` checkpoint. `dimensions` is refused |

### Outbound webhooks (`webhooks:manage`) and allowed hosts (`tenant:manage`)

| Route | Notes |
| --- | --- |
| `GET /admin/integrations/hosts` | The tenant's outbound allow-list `{hosts, updatedAt, operator: {webhooks, workflows}}` |
| `PUT /admin/integrations/hosts` `{hosts}` | Hostnames, `*.domain`, addresses or CIDR networks. When not empty, workflow HTTP steps and webhooks may only reach hosts on it (on top of the internal-address rules). Audited `tenant.hosts.updated` |
| `GET /admin/webhooks` | `{webhooks: [{id, name, url, events, maxLabel, state, breaker, failures, openedAt, retryAt, lastDeliveryAt, lastStatus}], events: [{pattern, description}], settings}` |
| `POST /admin/webhooks` `{name, url, events, maxLabel?}` | `events` are audit action names, prefixes ending in `.*`, or `*`. Besides audit actions: `job.succeeded`/`failed`/`cancelled`, `flag.<action>` and `approval.requested`. The endpoint is checked (internal only unless `WEBHOOK_ALLOWED_HOSTS`, never link-local, and the tenant's list): `422` otherwise. Returns the webhook and its `secret`, once |
| `PATCH /admin/webhooks/:id` `{name?, url?, events?, maxLabel?, state?: active \| disabled}` | Re-enabling or a new URL closes the breaker |
| `POST /admin/webhooks/:id/secret` | Rotates the signing secret: `{secret}`, once |
| `DELETE /admin/webhooks/:id` | With its delivery log |
| `POST /admin/webhooks/:id/test` | Queues a `webhook.ping` delivery: `202` |
| `GET /admin/webhooks/:id/deliveries?state=&limit=` | `{deliveries: [{id, event, eventId, label, state: pending \| succeeded \| failed, attempts, statusCode, error, nextAttemptAt, durationMs, replayOf, createdAt, deliveredAt}], withheld}`; deliveries above the caller's clearance are counted, not listed |
| `POST /admin/webhooks/:id/deliveries/:did/replay` | The same body again, as a new delivery: `202` |

A delivery is a `webhook.deliver` job: `POST` of `{id, type, tenant, label, createdAt, data}` with headers
`X-Exprsn-Event`, `X-Exprsn-Timestamp` (Unix seconds), `X-Exprsn-Delivery-Id` and
`X-Exprsn-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>" with the secret>`. Any `2xx` is success; other
answers and network errors are retried with exponential backoff (`WEBHOOK_RETRY_BASE_MS`, doubling) up to
`WEBHOOK_MAX_ATTEMPTS`; a refused host fails at once. `WEBHOOK_BREAKER_THRESHOLD` consecutive failures open the
endpoint's breaker: deliveries wait `WEBHOOK_BREAKER_COOLDOWN_MS`, then one trial closes or reopens it. Events above a
webhook's `maxLabel` are never queued; each event is delivered once per webhook (the event id is the dedupe key).
Audit actions: `webhook.created`/`updated`/`enabled`/`disabled`/`deleted`/`tested`, `webhook.secret.rotated`,
`webhook.delivery.replayed`, `webhook.breaker.opened`/`closed`.

### Prompt library (`chat:read` to use; `prompts:manage` to write)

| Route | Notes |
| --- | --- |
| `GET /prompts?retired=` | `{canManage, templates: [{id, name, description, workspaceId, workspace, scope, label, state, version, publishedVersion}]}`: tenant-wide and the caller's workspaces, up to their clearance; readers see published and deprecated templates only |
| `GET /prompts/:id` | The template and `versions: [{version, body, variables: [{name, description, default}], notes, createdBy, createdAt}]` (readers: the published version only) |
| `POST /prompts` `{name, description?, workspaceId?, label?, body, variables?, notes?}` | A draft, version 1. `{{name}}` marks a variable; described variables must appear in the body |
| `PATCH /prompts/:id` `{name?, description?, label?}` | |
| `POST /prompts/:id/versions` `{body, variables?, notes?}` | A new version; chat keeps using the published one until it is published |
| `POST /prompts/:id/state` `{state: published \| deprecated \| retired, version?}` | Lifecycle `draft → published → deprecated → retired`; publishing names the version (default the latest) |
| `POST /prompts/:id/render` `{variables, version?}` | `{text, template: {id, name, version, label, state}}`; missing variables are a `400` listing `missing`. Values are inserted literally in one pass |

Audit actions: `prompt.created`, `prompt.updated`, `prompt.version.added`, `prompt.published`/`deprecated`/`retired`.

### Conversation sharing and export

| Route | Notes |
| --- | --- |
| `GET /conversations/:id/shares` (`chat:read`, owner) | `[{id, kind: user \| workspace \| link, userName, workspaceName, expiresAt, state: active \| revoked \| expired, lastViewedAt}]` |
| `GET /conversations/:id/share-targets?q=` (`chat:read`, owner) | People and workspaces of the tenant, each with `cleared` for the conversation's label |
| `POST /conversations/:id/shares` (`chat:write`, owner) `{kind: user, userId}` \| `{kind: workspace, workspaceId}` \| `{kind: link, expiresInHours (1–720)}` | A person must be cleared for the label and a workspace's ceiling must hold it (`403`). A link returns `token` and `url` once; only its HMAC is stored. Audited `conversation.shared` |
| `DELETE /conversations/:id/shares/:shareId` | Revokes at once. Audited `conversation.share.revoked` |
| `GET /shared-conversations` (`chat:read`) | What is shared with the caller: `[{conversationId, shareId, kind, title, label, owner, sharedAt, updatedAt}]` |
| `GET /shared-conversations/:id` | The active branch, read only: `{id, title, label, owner, messages: [{id, role, content, state, profile, model, label, citations, tools, createdAt}], readOnly: true}`. Checked on every read: a live share and clearance for the label as it is now |
| `POST /shared-links/open` `{token}` | The same view through a link, for a signed-in user of the same tenant (another tenant's link is `404`). Audited `conversation.share.opened` |
| `POST /conversations/:id/exports` `{format: markdown \| json}` (`chat:read`) | For the owner or a reader, within their clearance: a `conversation.export` job (`202`). Audited `conversation.export.requested` |
| `GET /conversation-exports?conversation=`, `GET /conversation-exports/:id` | The caller's own exports: `{id, conversationId, format, label, state, file, bytes, error, jobId, createdAt}` |
| `GET /conversation-exports/:id/download` | The file, if the caller can still read the conversation at its label. Audited `conversation.export.downloaded` |

An export holds the active branch with its sources (citations above the requester's clearance are left out), passes
the `export` guardrail checkpoint (a block fails it, a redaction is what is written) and is sealed with the tenant key
in the blob store. Answers that are not complete or stopped (streaming, failed, held) are never shown to readers or
exported. Audit action on completion: `conversation.export.ready`.

### Billing (`billing:read` to read; `billing:manage` to change)

| Route | Notes |
| --- | --- |
| `GET /admin/billing/price-books` | `{books: [{id, name, currency, isDefault, state, items}], meters, provider}` |
| `POST /admin/billing/price-books` `{name, currency?, isDefault?, items}` | Items: `{match: model \| profile \| any, value, usage: <kind> \| *, meter: prompt_tokens \| output_tokens \| thinking_tokens \| gpu_seconds \| requests \| calc_calls, perUnits, unitPriceMicros}` (millionths of the currency unit per `perUnits`). The most specific item wins: profile, then model, then any; a named usage kind beats `*` |
| `PATCH /admin/billing/price-books/:id` `{name?, currency?, isDefault?, items?, state?: active \| retired}` | The default book cannot be retired |
| `GET /admin/billing/settings?tenant=` | `{tenantId, priceBookId, effectiveBook, billingCustomer, provider}` |
| `PUT /admin/billing/tenants/:tenantId` `{priceBookId?, billingCustomer?}` | The tenant's book (none: the default) and its billing customer id |
| `GET /admin/billing/statements?tenant=` | Stored statements and a preview of the current month: `{current, provider, statements: [{month, state: preview \| open \| closed \| pushed \| push failed, currency, totalMicros, total, totals, lineCount, …}]}` |
| `GET /admin/billing/statements/:month` (`YYYY-MM`) | The stored statement or a preview: `{month, state, book, currency, totalMicros, totals: {promptTokens, outputTokens, thinkingTokens, gpuSeconds, requests, calcCalls}, lines: [{kind, model, profile, meter, quantity, perUnits, unitPriceMicros, amountMicros, priced}], providerRef, pushError}` |
| `POST /admin/billing/statements/:month/compute` | Stores (or recomputes) it; a finished month is `closed`. A pushed statement is final (`409`) |
| `POST /admin/billing/statements/:month/push` | With `BILLING_PROVIDER=stripe`: one Stripe invoice (invoice items per priced line, idempotency keys per statement and line) for the tenant's billing customer. Only a finished month; `409` without a customer; `502` when Stripe refuses |
| `GET /admin/billing/statements/:month/export?format=csv\|json` | The statement as a file. Audited `billing.statement.exported` |

`?tenant=` names another tenant for system admins. Statements group the month's usage records by kind, model and
profile, so their totals equal the usage report for the month; usage without a price is kept as zero-amount lines.
The `billing.close` schedule closes last month's statements. Audit actions: `billing.price-book.created`/`updated`,
`billing.tenant.updated`, `billing.statement.computed`/`pushed`/`push-failed`/`exported`.

## Sprint 15: Operations

- Rate limits (600 requests a minute per user or address, 30 credential attempts a minute on `/api/auth`) and the
  authorisation denial cap (20 full `authz.denied` entries a minute per principal) are counted in Redis when
  `REDIS_URL` is set, with one atomic Lua script per hit, so every instance shares one limit; without Redis, or while
  it is unreachable, they are counted in memory per instance (the limit still applies).
- Failed bearer credentials: 20 invalid API keys, access tokens or malformed `Authorization` headers a minute from one
  address, then `429` with `Retry-After` for every bearer request from that address (a valid key included) until
  the window ends.
- Media is sandboxed; see "Media origin" above. Platform routes for signer proposals, dns-01 and backups are under
  "Sprint 9: Platform operations". Data connections gained MySQL and OpenBao dynamic credentials; MCP server
  registration and tool approval check zones (`422`/`403 step: zone`, the refusal audited as `mcp.register.refused`).

## Sprint 16: Chat and AI depth

### `/v1` context and server tools

`POST /v1/chat/completions` takes three optional headers. Without them nothing changes. Each needs its own permission
beside `inference:invoke` (and, for an API key or OAuth token, the scope): `knowledge:read`, `memory:write` and
`tools:invoke` respectively (`403` with `code: denied_role` or `denied_scope` and the header as `param`).

| Header | Behaviour |
| --- | --- |
| `X-Exprsn-Knowledge: <id>[,<id>…]` (up to 10) | Retrieves from those knowledge bases with chat's context provider and rules: each must be one the caller may read (`404 knowledge_base_not_found` otherwise, exactly as for one that does not exist) and published (`409 knowledge_base_unavailable`); nothing above the lowest of the caller's clearance, the profile's label, the pool's ceiling and the workspace's ceiling is used. The items go in one delimited system message after the profile's prompt |
| `X-Exprsn-Memory: on \| off` | Adds the caller's memories (user and workspace scope), each through the `memory` checkpoint, as in chat |
| `X-Exprsn-Tools: profile \| none` | Offers the profile's read-only tools (calculate, and registry and MCP tools with side effect `read` that need no confirmation) and runs them on the server through the dispatcher, up to six rounds; only the final answer is returned. Refused with `400 tools_conflict` together with `tools`, and `400 tools_not_supported` for a model without tool calling. Calculations are metered |

With any of them the completion (and, when streaming, the chunk carrying the finish reason) has an extension field
`exprsn: {label, citations: [{n, kind: knowledge \| memory, label, kbId, kb, documentId, document, chunkId, section, score, span, passage} | {n, kind: memory, label, memoryId, scope, type}], tools: [{name, ok}]}`.
`label` is the request's label raised to the highest item used; the answer passes `model-output` at that label.
Citations are left out of an answer that was withheld.

### Held prompts (`require-approval` at `user-input`)

In chat (`POST /chat`, `POST /conversations/:id/messages`, edits), a prompt a `require-approval` rule holds is stored
with its question `state: held` and the answer `state: awaiting`; the send returns `202 {…, state: 'awaiting', reason}`
and nothing reaches the model. The Flags queue gets a `hold` flag at checkpoint `user-input` whose `held` shows the
question. `POST /flags/:ref/decide {decision: approved}` sends it: the owner is loaded again (clearance, profile
access and quota are checked now) and the answer is generated as usual (`chat.released {messageId: <question>,
answerId, state: queued}`, then the stream). `rejected` withdraws the question and its answer (the answer says the
question was not sent) and notifies the owner. Regenerating an awaiting answer is `409`. A hold caused by a check
that could not run still refuses the send (`422`); compare and `/v1` refuse held prompts. Audit: `chat.prompt.held`,
`chat.hold.approved` / `chat.hold.rejected`.

### Guard model while streaming

With enforced guard-model or classifier rules at `model-output`, each sentence window that passed the deterministic
rules is also checked by them in the background, over the text so far (`CHAT_GUARD_HOLDBACK_SENTENCES`,
`CHAT_GUARD_STREAM_CONCURRENCY`). A block stops the model and the answer is replaced; a hold holds it for review.
Tool results shown in chat pass the same screen before their `chat.chunk`: a block shows `{name, error: 'This tool
result was withheld…'}`, a redaction `{name, output: {redacted}}`; what is shown is what is stored.

### Live sharing (socket)

A reader of a conversation shared with them (user or workspace share) emits `shared.watch {conversationId}` with an
acknowledgement callback: `{ok: true, label}` after the server checked the share and the reader's clearance, `{ok:
true, owner: true}` for the owner (who already receives their events), `{ok: false}` otherwise (at most 20 watched
conversations per socket). The reader then receives `chat.chunk {conversationId, messageId, seq, delta? , tool?}`
(no thinking), `chat.status {conversationId, messageId, state}`, `chat.done` and `chat.released` for that conversation.
`shared.unwatch {conversationId}` stops. Revoking the share, or the conversation's label rising above the reader,
removes the socket from the room at once and sends `shared.revoked {conversationId}` (unless another live share still
admits them).

| Route | Notes |
| --- | --- |
| `GET /shared-conversations/:id/messages/:mid/stream?after=` (`chat:read`) | Catch-up for a reader: the answer's chunks after `after` (answer text and tools only), or its screened text so far; a held answer shows nothing |

### Anonymous share links

| Route | Notes |
| --- | --- |
| `GET /admin/tenants/:tid/sharing`, `PUT /admin/tenants/:tid/sharing` `{anonymousLinks: boolean, anonymousMaxHours?: 1–720}` (`tenant:manage`) | Off by default; maximum 72 hours by default. Turning it off ends every anonymous link at once. Audit: `tenant.sharing.updated` |
| `POST /conversations/:id/shares` `{kind: link, expiresInHours, anonymous: true}` | Only for a conversation labelled `public` (`403`), when the tenant allows it (`403`), within its maximum (`400`). The `url` is `…/#/shared?t=<token>`; shares list `anonymous: true` |
| `POST /api/public/shared-links/open` `{token}` (no sign-in) | Outside the authenticated API: no session is read or created and no cookie is set. `{id, title, label, createdAt, updatedAt, messages, readOnly: true}` (no owner). `404` for anything that does not open, including a conversation no longer `public` or the setting turned off; `429` past `SHARE_ANONYMOUS_PER_MINUTE` per client address. Audited `conversation.share.opened` with `{anonymous: true}` and the address |

The console's `#/shared?t=…` page opens it signed-out and takes the token out of the address bar at once.

### Retention per workspace and per user (`tenant:manage`)

| Route | Notes |
| --- | --- |
| `GET /admin/tenants/:tid/retention` | Adds `scopes: [{id, scope: workspace \| user, scopeId, name, conversationDays, updatedBy, updatedAt}]` |
| `PUT /admin/tenants/:tid/retention/scopes` `{scope, scopeId, conversationDays: 1–3650 \| null}` | Sets or (null) removes a period for a workspace or user of the tenant (`404` otherwise). Audit: `tenant.retention.scope.updated` |

A conversation is purged after the shortest period that applies to it: the tenant's, its workspace's and its
owner's. `POST …/retention/run` needs at least one period. The purge audit adds `scopes`.

### Prompt templates

`POST /prompts`, `POST /prompts/:id/versions` and publishing (`POST /prompts/:id/state {state: published}`) pass the
body through the `user-input` checkpoint: a block, hold or redaction refuses with `422` (`step: guardrail`, `action`,
`rules`) and nothing changes.

## Sprint 19: Knowledge, integrations and workflows

### Knowledge sources (`knowledge:manage` or manage access on the base)

| Route | Notes |
| --- | --- |
| `GET /knowledge/connections` | PostgreSQL and MySQL connections: `[{id, name, engine, label, objects, columns}]` |
| `POST /knowledge/bases/:id/sources` `{kind: database, location: "pg: …" \| "mysql: …", connectionId, idColumn?, watermarkColumn?, accessColumn?, accessKind?: group \| user, replication?, publication?}` | MySQL tables and views sync by watermark like PostgreSQL (names default to the connection's database). `accessColumn` (B-1002) names who may retrieve each row: a list of directory groups (`accessKind: group`, the default) or usernames, emails or user ids (`user`), as a comma or semicolon list, a JSON array or a PostgreSQL array. The list is carried onto the row's document and chunks; search, chat context and the document list for members drop rows that do not name the reader or one of their groups (matched case-insensitively against the groups of the user's identities); an empty value admits nobody. `replication: true` (B-1003, PostgreSQL tables only, `409` for views and MySQL) streams changes through logical replication (`publication` defaults to `exprsn_knowledge`) |
| `GET /knowledge/bases/:id` | Each database source carries `replication: {state: starting \| streaming \| fallback \| stopped, slot, publication, lsn, lastChangeAt, changes, error}` when it asked for it |
| `DELETE /knowledge/sources/:id` | Also stops the source's stream and drops its replication slot |

Replication: the database owner runs `CREATE PUBLICATION exprsn_knowledge FOR TABLE <table>`, the connection's account
has the `REPLICATION` attribute and the server runs with `wal_level=logical`. The slot is `exprsn_<source id>`
(pgoutput, created on first use). Inserts and updates become documents at once, deletes remove them (the id column must
be the primary key, or the table `REPLICA IDENTITY FULL`), a truncate empties the source; each transaction is
acknowledged only after it is applied. One instance holds each stream (a lease renewed every
`KNOWLEDGE_REPLICATION_TICK_MS`). When the stream cannot run, `replication.state` is `fallback` with the reason and the
source keeps syncing by watermark on its schedule; the watermark schedule also runs beside a healthy stream.

### Webhooks (`webhooks:manage`)

| Route | Notes |
| --- | --- |
| `POST /admin/webhooks` `{…, ordered?, signing?: hmac \| ed25519}` | `ordered`: deliveries go out one at a time in the order events were queued (`X-Exprsn-Sequence`); a delivery that keeps failing holds the ones after it until it gives up. `signing: ed25519` signs with the tenant's key instead of the shared secret (the first such webhook creates the key; audited `webhook.signing-key.created`) |
| `PATCH /admin/webhooks/:id` `{…, ordered?, signing?}` | Turning `ordered` off sends anything waiting for its turn |
| `GET /admin/webhooks/signing-key` | `{active: {kid, publicKey, createdAt} \| null, retired: [{kid, publicKey, retiredAt}], jwksUrl}` |
| `POST /admin/webhooks/signing-key/rotate` | A new Ed25519 key; the previous one stays published as `retired`. Audited `webhook.signing-key.rotated` |
| `GET /webhooks/keys/:tenant` (public, outside `/api`) | The tenant's signing keys as a JWKS: `{keys: [{kty: OKP, crv: Ed25519, x, kid, use: sig, alg: EdDSA, status}]}` |

An Ed25519 delivery carries `X-Exprsn-Signature-Ed25519` (base64 signature over `"<X-Exprsn-Timestamp>.<body>"`) and
`X-Exprsn-Key-Id` (the `kid`) instead of `X-Exprsn-Signature`. The private key is sealed with the tenant key.

### Billing

| Route | Notes |
| --- | --- |
| `GET /admin/billing/price-books` | System admins see every book; others the platform books and their tenant's own. Books carry `tenantId` (null: platform) |
| `POST /admin/billing/price-books` `{…, tenantId?}` (`billing:manage`) | A book only that tenant may use; one default among the platform books and one among each tenant's |
| `GET /admin/billing/settings?tenant=` | Adds `billingCurrency`, `taxRates: [{name, ratePercent}]` and `reconciliation` (whether the Stripe webhook is configured) |
| `PUT /admin/billing/tenants/:tenantId` `{priceBookId?, billingCustomer?, billingCurrency?, taxRates?}` (`billing:manage`) | With a currency, only books in it are used (`409` when assigning another; no conversion). The effective book is the assigned one, else the tenant's own default, else the platform default. Up to five taxes, each a percentage of the priced subtotal |
| `GET /admin/billing/statements/:month` | Adds `subtotalMicros`, `taxMicros`, `taxes: [{name, ratePpm, amountMicros}]` (the total includes them), `paidAt`, `providerStatus`; `state` may also be `paid`, `payment failed` or `void` |
| `POST /billing/stripe/webhook` (public, outside `/api`) | Stripe events, authenticated by `Stripe-Signature` (`t=`, `v1=` HMAC-SHA256 of `"<t>.<raw body>"` with `STRIPE_WEBHOOK_SECRET`, within `STRIPE_WEBHOOK_TOLERANCE_SECONDS`; `400` otherwise, `404` when no secret is set). `invoice.paid`/`invoice.payment_succeeded` mark the statement with that invoice `paid`, `invoice.payment_failed` marks it `payment failed`, `invoice.voided` marks it `void`; paid and void are final. Each event id is applied once (a redelivery answers `{duplicate: true}`); every verified event is acknowledged with `200`. Audited in the statement's tenant: `billing.statement.paid`/`payment-failed`/`voided` |

A pushed invoice gets one extra invoice item per tax. Statements in `pushed`, `paid`, `payment failed` or `void` are
final: compute and push answer `409`.

### Workflows and agent runs

- A workflow published as a tool that pauses on an approval returns a pending result: an agent run that called it
  waits (its step is `waiting` with `meta.awaiting: {kind: workflow-run, id}`, and `POST /runs/:id/steps/:n/decision`
  answers `409` for it) and is queued again when the workflow run finishes, continuing with the run's output or its
  failure as the tool result. Other callers get the pending message as an error, as before.
- Guardrail and tool steps take `approvalTimeoutMs` (60 s to 7 days, default 24 h) for the approval they pause for.
- Run events (`workflow.run`, `workflow.step`) also go to the holders of the approval roles a run asked for (cleared for
  its label), and `workflow.approval` tells them when an approval is requested or decided.

### Images and scripts

- `GET /images/backends` adds `safety.required` (`IMAGE_SAFETY_REQUIRED`): with it on and no classifier, generated
  images end `withheld` (not stored; audited `image.withheld` with `reason: not classified`) and sampled video frames
  are withheld.
- `GET /scripts/runtime` adds `runtime` (`SCRIPT_RUNTIME`, e.g. `runsc`) and `runtimeProblem`; the runner reports itself
  as `docker (runsc)`, passes `--runtime=runsc`, and refuses runs when the engine does not know the runtime.

## Sprint 18: Platform hardening

- Pool instances (`POST /api/admin/pools/:id/instances`, `PATCH /api/admin/instances/:id`) and zone endpoints
  (`POST /api/admin/zones/:id/endpoints`) refuse a cloud metadata, link-local or unspecified address with `400`
  ("The instance URL is refused: ..."); loopback and private addresses are accepted, public ones unless
  `SERVICE_INTERNAL_ONLY` is on. Connections to instances, endpoints, image backends and the training worker check the
  address they dial (a name that later resolves to such an address fails with "refused").
- Problem details never carry credentials: URLs with a password, `password=`/`token=`-style values, bearer and basic
  authorization values and private-key blocks are masked (`********`), as are driver messages in connection tests
  and health details.
- Guardrail rules as YAML (`yaml` in rule-set drafts and rule checks) are refused with `422 Invalid YAML` above 512 KiB,
  16 levels of nesting or with any alias; the identity file (`IDENTITY_CONFIG`) is capped at 4 MiB, 24 levels and 50
  aliases.

### Certificate push hooks (`platform:manage`)

| Route | Result |
| --- | --- |
| `GET /api/admin/platform/certificates/:id/hooks` | `{hooks: [{id, kind: command\|webhook, command, url, lastState: ok\|failed\|null, lastDetail, lastAt, createdAt}], commands: [names from ACME_RELOAD_COMMANDS]}` |
| `POST /api/admin/platform/certificates/:id/hooks` `{kind: "command", command}` or `{kind: "webhook", url}` | `201` hook; a webhook answer carries `secret` once (stored sealed). An unknown command or a non-internal URL is `400`; tracked certificates have no hooks (`409`); at most 10. Audited `platform.cert.hook.added` |
| `POST /api/admin/platform/certificates/:id/hooks/:hookId/test` | Runs the hook now (`certificate.test`); answers the hook with its `lastState` |
| `DELETE /api/admin/platform/certificates/:id/hooks/:hookId` | `204`; audited `platform.cert.hook.removed` |

After every issue and renewal, webhooks are POSTed from the issuing instance with `X-Exprsn-Event:
certificate.issued|certificate.renewed` and `X-Exprsn-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">`; the
body is `{event, certificate: {id, name, domains, serial, fingerprint, notBefore, notAfter}, chainPem}` (never the
key). Reload commands run on every instance after its certificate files are written. Each run is audited
`platform.cert.hook.ran` or `platform.cert.hook.failed`.

### Registry pushes (`platform:manage`)

| Route | Result |
| --- | --- |
| `GET /api/admin/platform/push-targets` | `[{id, mirrorId, kind: oci\|npm\|pypi, url, repository, username, hasSecret, state: active\|disabled, lastPushAt, lastPushOk, lastDetail, updatedAt}]` |
| `PUT /api/admin/platform/mirrors/:id/push-target` `{url, repository?, username?, secret?, state?}` | The mirror's target (created or replaced). Image mirrors push to an OCI registry such as Harbor (`repository`: the project), npm mirrors to Verdaccio, PyPI mirrors to devpi (`repository`: `user/index`); other kinds are `400`. The URL must be internal (`PLATFORM_ALLOWED_HOSTS` for others). `secret` is sealed and never returned; leave it out to keep the stored one. Audited |
| `DELETE /api/admin/platform/mirrors/:id/push-target` | `204`; audited |
| `GET /api/admin/platform/bundles/:id/pushes` | `[{id, bundleId, targetId, path, sha256, artefact, state: pushed\|exists\|failed, detail, at}]` |
| `POST /api/admin/platform/bundles/:id/push` | `202 {jobId}`: pushes a promoted bundle again (`409` when it is not in production or no target is active) |

Promotion queues the push (`ops.bundle.push`) when an active target exists; the outcome is audited
`platform.bundle.pushed` or `platform.bundle.push.failed`.

### Zones: members outside their zone (`zones:manage`)

| Route | Result |
| --- | --- |
| `GET /api/admin/zones/misplaced` | `{misplaced: [{kind: connection\|mcp, id, name, tenant, zone, label, reason, suggestion, pending}]}`: connections and MCP servers in an undefined or external zone, or labelled above their zone's ceiling, with the zone a move would target and the draft already moving them |
| `POST /api/admin/zones/:id/proposals` | Also takes `moveMembers: [{kind: connection\|mcp, id}]`; approval moves them into the zone. A member labelled above the zone's ceiling is `422`, the external zone `403` |

`GET /api/admin/zones` gains `misplaced` and each draft's `moveMembers`; `POST /api/admin/zones/seed` and
`POST /api/admin/zones/:id/draft/approve` answer `misplaced` (a count) when they define the first zones, and then
audit `zone.members.rechecked` and notify system admins if any member is outside its zone.

### Training worker callbacks (outside `/api`, grant tokens only)

| Route | Result |
| --- | --- |
| `POST /trainer/v1/keys/:grant` | `{key, cipher}` once; `401` wrong token, `403` missing client certificate (`TRAINER_CLIENT_CERT_SHA256`), `410` expired or already fetched. Audited `training.worker.key.released` / `.refused` |
| `PUT /trainer/v1/artifacts/:grant/:name?kind=checkpoint\|gguf\|other` | `201 {ref, name, sha256, bytes}`; the body is streamed into the blob store, sealed under the tenant key. Audited `training.worker.artifact.stored` |
| `GET /trainer/v1/artifacts/:grant/:name` | The artefact, streamed (`X-Artifact-SHA256`). Audited `training.worker.artifact.read` |

The whole contract is in [training-worker.md](training-worker.md).

## Sprint 17: Identity and security

### Sign-in and account (`/api/auth`, `/api/me`)

| Method and path | What it does |
| --- | --- |
| `POST /auth/login` (and upstream and Kerberos sign-ins) | Now also sets a long-lived signed device cookie (`exai_device`, `__Host-` prefixed with secure cookies). A sign-in from a browser or a network (/24, /48) the account has not used before sends a `New sign-in to your account` security notice (`SIGNIN_NOTICES`); the account's first sign-in does not. Audit `auth.login.new_context` |
| `POST /auth/password/check` `{password, token?, username?, breach?}` | The strength meter: `{bits, score 0-4, label, rules[{id, label, ok}], acceptable, breached {mode, checked, found, unavailable}}`. Needs a session (any stage) or a live reset, invite or enrolment `token`; `username` (whose name the password must not contain) is taken from the body only for callers with `identity:manage` or `users:manage`. With `BREACHED_PASSWORDS` on, the breach corpus is asked unless `breach: false`. Throttled to 600 an hour per session or link (`429`) |
| `POST /auth/password/reset` | With an enrolment link (`admin:create --enrol-link`) also signs in: `{…, session}` with `stage: enroll`, which reaches only the factor enrolment routes; audit `password.enrol.accepted` |
| `POST /auth/logout` | When the session signed in to applications with a front-channel logout URI (OIDC clients, SAML SPs with a redirect-binding logout endpoint), answers `200 {signedOut, next}`; `next` is the signed-out page (`/oauth/logged-out?handle=…`, single use, ten minutes) that loads each one in a frame. Otherwise `204` as before |
| `GET /me` | `stepUp.methods` includes `upstream` for a session from an enabled upstream OIDC or SAML provider, with `stepUp.upstream {name, protocol}` |
| `POST /me/step-up/upstream` | Starts a re-authentication at the session's upstream IdP (`prompt=login`, `max_age=0`; SAML `ForceAuthn`), bound to this browser and session; `{url, provider}`. `409` for a session that did not come from an upstream provider |
| `POST /me/step-up/upstream/complete` `{handle}` | Redeems the handle the upstream callback put in `/#/settings?stepup=<handle>`. Only the session that started it can redeem it, once, within five minutes; then the step-up time moves (`auth.step_up`). `400` otherwise |

The upstream callback accepts a step-up only when the IdP reports a fresh authentication (`auth_time`, or the
assertion's `AuthnInstant`, no older than the request minus a minute) as the same upstream account; otherwise it
shows an error page (`auth.step_up.failed` for another account).

### Users (`users:manage`)

| Method and path | What it does |
| --- | --- |
| `POST /admin/users/:id/password` | Now takes `revokeApiKeys` (default `true`): the account's API keys are revoked with the reset. The answer adds `apiKeysRevoked` |

### Protocol endpoints (outside `/api`)

| Method and path | What it does |
| --- | --- |
| `GET /oauth/logged-out?handle=` | The signed-out page after a console sign-out, with a frame per front-channel logout URL (CSP `frame-src` names exactly their origins); then back to the sign-in screen |
| `POST /oauth/token`, API calls with `DPoP` | With `DPOP_NONCES=true` every token response carries `DPoP-Nonce`; a proof without the current nonce gets `400 {error: use_dpop_nonce}` at the token endpoint and `401` with `WWW-Authenticate: DPoP error="use_dpop_nonce"` (and `DPoP-Nonce`) at `/oauth/userinfo` and the API. API proofs name `<API_PUBLIC_URL or PUBLIC_URL origin><path>` as `htu` |
| `POST /oauth/introspect` | A client registered as a resource server (`introspect: any`) sees the access tokens of every client in its tenant; refresh tokens stay visible to their own client only |

### Federation admin (`identity:manage`)

| Method and path | What it does |
| --- | --- |
| `GET /admin/federation/oidc/clients[/:id]` | Now also returns `introspect` (`own` or `any`) and `introspectPending` |
| `POST /admin/federation/oidc/clients/:id/introspect` `{mode: own\|any, reason?}` | `own` applies at once. `any` (confidential clients only) is a proposal (`202 {client, proposal}`) that a second identity admin approves |
| `GET /admin/federation/proposals[?state=]` | Changes waiting for approval (and decided ones): `{id, kind (client.introspect, metadata.sp, metadata.idp), targetId, name, summary, state, proposedBy (null: the metadata refresh), mine, …}` |
| `POST /admin/federation/proposals/:id/approve` `{note?}` | Applies the change. A person's proposal needs another identity admin (`403` dual control); the metadata refresh's needs any identity admin |
| `POST /admin/federation/proposals/:id/reject` `{note?}`, `…/withdraw` | Rejects (not your own), or withdraws your own |
| `POST /admin/federation/saml/sps` | Now takes `metadataUrl` instead of `xml` (fetched through the upstream host checks: internal or `FEDERATION_ALLOWED_HOSTS`, pinned, no redirects, 1 MB) and `signResponse` (sign the whole response as well as the assertion) |
| `PATCH /admin/federation/saml/sps/:id` | Now takes `signResponse` |
| `POST /admin/federation/upstream` | SAML metadata given as a URL is remembered and refreshed like SP metadata |
| `GET /admin/federation/metadata` | Metadata sources `{id, kind (sp, idp), url, fetchedAt, error}` |
| `PUT /admin/federation/metadata/:id` `{url}` | Starts fetching a registered SP's or SAML IdP's metadata from a URL; it must describe the same entity. A difference from what is in force becomes a proposal |
| `POST /admin/federation/metadata/:id/refresh` | Fetches now: `{state: unchanged\|proposed\|pending\|error, proposal, source}` |
| `DELETE /admin/federation/metadata/:id` | Stops fetching (the values in force stay) |

Every source is fetched again every `FEDERATION_METADATA_REFRESH_HOURS` (job `federation.metadata`). A change of
certificates, assertion consumer services, SSO or logout endpoints is proposed, never applied, until approved; the
previous values stay in force meanwhile. Metadata that now names another entity ID is refused (`error`).

### Platform (`platform:manage`)

| Method and path | What it does |
| --- | --- |
| `GET /admin/platform/summary` | Adds `passwords {breachedCheck}`; the console warns while it is `off` |

Audit actions: `auth.login.new_context`, `auth.step_up.started`, `password.enrol.accepted`, `user.enrol_link.issued`,
`federation.client.introspect_changed`, `federation.proposal.created`, `federation.proposal.approved`,
`federation.proposal.rejected`, `federation.proposal.withdrawn`, `federation.metadata.refreshed`,
`federation.metadata.failed`, `federation.metadata.source_set`, `federation.metadata.source_removed`,
`federation.saml_sp.metadata_applied`, `identity.provider.metadata_applied`.

## Sprint 20: Keys and supply chain

### Signed `/v1` requests (RFC 9421)

| Method and path | What it does |
| --- | --- |
| `POST /me/api-keys` | Now takes `signatureKey` (an Ed25519 public key: its JWK `x` value, or a PEM). Lists and the answer show `signatureKey` |
| `PUT /me/api-keys/:id/signature-key` `{publicKey: string \| null}` | Sets or (with `null`) removes the key's public key. Browser session with a recent sign-in, like creating a key; a security notice is sent |

When an API key has a public key, every `/v1` request made with it must carry `Signature-Input` and `Signature`
(HTTP Message Signatures, RFC 9421) by that key, `alg="ed25519"`, covering at least `"@method"`, `"@target-uri"` (the
URL under `PUBLIC_URL` the client called) and `"authorization"`, plus `"content-digest"` when there is a body, with a
`Content-Digest` header (RFC 9530, `sha-256` or `sha-512`) that matches it. `created` is required and must be within
`HTTP_SIGNATURE_MAX_AGE_SECONDS`; `keyid`, if given, is the key's id or its `exai_k1_<prefix>`. Any other signed
header field may be added (`x-data-label`, `content-type`). Otherwise the answer is `401` with
`error.code = invalid_signature` and a message that says what was wrong. OAuth access tokens are not affected. Such a key is
refused (`401 invalid_token`) everywhere outside `/v1`, where signatures are not checked.

### Webhooks

| Method and path | What it does |
| --- | --- |
| `POST /admin/webhooks`, `PATCH /admin/webhooks/:id` | Now take `messageSignatures` (boolean, default `false`); the webhook view shows it |
| `GET /admin/webhooks/signing-key` | `active.store` says where the Ed25519 private key is: `signer`, `kms` (OpenBao transit) or `sealed` |

With `messageSignatures`, each delivery also carries `Content-Digest`, `Signature-Input` and `Signature` under the label
`exprsn`, covering `"@method" "@target-uri" "content-type" "content-digest" "x-exprsn-delivery-id"` with `created` set to
`x-exprsn-timestamp`: `alg="hmac-sha256"` with the webhook's secret and `keyid` the webhook id, or `alg="ed25519"` with
the tenant's published key and `keyid` its kid (the JWKS at `/webhooks/keys/:tenant`). The existing headers are sent as
before. With OpenBao, or with the signer, Ed25519 keys are created and used there; a key sealed before is retired (it
stays in the JWKS) and replaced on the next signature.

Audit actions: `apikey.signature_key.set`, `apikey.signature_key.removed`; `webhook.signing-key.created` (also when a
key moves to the KMS or the signer, with `detail.retired`).

## Sprint 21: AI

### Held `/v1` requests (`require-approval` at `user-input`)

A `/v1` request sent with an API key whose prompt a `require-approval` rule stops is held for review instead of refused
(`POST /v1/chat/completions` and `POST /v1/responses`, streaming or not). It is filed in the Flags queue as a `hold`
flag with source `api-request`; approving it (`POST /api/flags/:ref/decide {decision: approved}`, not by the sender)
runs the request as a job (`openai.held`) as the sender with the key's scopes as they are then; rejecting it ends it.
A request sent with an OAuth access token is refused as before (`400 content_filter`).

| Method and path | What it does |
| --- | --- |
| (any `/v1` request that is held) | `202` with `Location: /v1/held/<id>` and `{id, object: "exprsn.held_request", api (chat.completions\|responses), status: "held", created, poll, message}` |
| `GET /v1/held/:id` (`inference:invoke`, the sender only) | `200 {id, object, api, status (held\|running\|completed\|failed\|rejected), created, poll, message?, error?, response?}`. When `completed`, `response` is the `chat.completion` or `response` object the request would have returned (never streamed). Another caller gets `404 held_request_not_found` |

Compare (`POST /api/compare`) holds the prompt the same way chat does: `202 {conversationId, userMessageId, columns:
[{…, state: "awaiting"}], state: "awaiting", reason}`; nothing is generated until a reviewer approves, then every
column starts (`chat.released` with `answerId` per column); a rejection withdraws every column.

Audit actions: `api.request.held`, `api.hold.approved`, `api.hold.rejected`.

### `POST /v1/responses`: the Responses API subset (`inference:invoke`)

A documented subset of OpenAI's Responses API, translated onto the chat completions path: the same profile
resolution, clearance, quotas, `user-input` and `model-output` checkpoints, metering (`api`) and `X-Data-Label`,
`X-Workspace` and `X-Exprsn-*` headers.

| Field | Supported |
| --- | --- |
| `model` | A profile or alias, as for chat completions |
| `input` | A string (one user message), or an array of items: messages `{type?: "message", role: user\|assistant\|system\|developer, content: string \| [{type: input_text\|output_text, text} \| {type: input_image, image_url: "data:…"}]}`, `{type: "function_call", call_id, name, arguments}` and `{type: "function_call_output", call_id, output}` |
| `instructions` | A system message before everything else; not stored and not carried over by `previous_response_id` |
| `tools`, `tool_choice` | Function tools only `{type: "function", name, description?, parameters?}`; calls come back as `function_call` output items for the caller to run (never run on the server), and their results go in the next request as `function_call_output` items. `tool_choice`: `none`, `auto`, `required` or `{type: "function", name}` |
| `temperature`, `top_p`, `max_output_tokens`, `reasoning.effort`, `metadata`, `user` | As in OpenAI's API (`max_output_tokens` caps the answer; the thinking ceiling of the profile still applies) |
| `store` | Default **false** (OpenAI's default is true). With `true` (needs `chat:write` as well) the exchange is saved as a chat conversation of the caller in the request's workspace: it appears in Chat and can be continued there. The response id is then `resp_<message id>` |
| `previous_response_id` | A stored response of the caller: its conversation up to that answer comes first (function calls it returned included), and with `store: true` the new turn is saved under it. Anything else is `404 response_not_found` |
| `stream` | Server-sent events with an `event:` line: `response.created` (`{type, sequence_number, response}` with `status: in_progress`, sent just before the first text), `response.output_text.delta` (`{type, sequence_number, item_id, output_index: 0, content_index: 0, delta}`), `response.completed` (`{type, sequence_number, response}`). No `[DONE]`. With `OPENAI_STREAM_MODE=checked` (default) the text arrives after the output check in one delta. An error after the stream started is an `error` event `{type: "error", code, message, param}` |

The response object: `{id, object: "response", created_at, status (completed\|incomplete), incomplete_details
({reason: max_output_tokens\|content_filter} or null), error: null, model, instructions, previous_response_id, store,
output: [{type: "message", id, status, role: "assistant", content: [{type: "output_text", text, annotations: []}]},
{type: "function_call", id, call_id, name, arguments, status}], tools, tool_choice, temperature, top_p,
max_output_tokens, metadata, usage: {input_tokens, output_tokens, total_tokens, input_tokens_details, output_tokens_details},
exprsn?}`.

Not supported: built-in tools (web search, file search, code interpreter, computer use), `background`, `include`,
`conversation` objects, `truncation`, `parallel_tool_calls`, audio, file inputs, and deleting or cancelling responses.

| Method and path | What it does |
| --- | --- |
| `POST /v1/responses` | As above |
| `GET /v1/responses/:id` | A stored response of the caller (`resp_<message id>`); `404 response_not_found` otherwise |

### Evaluations (`profiles:manage`)

| Method and path | What it does |
| --- | --- |
| `GET /api/admin/profiles/:id/evaluations` | `{profile {id, name, version, status, configHash}, sets, runs (newest first, the score history), overrides, gate {configHash, gated, failing [{setId, set, reason, score, threshold}], overridden, open}}`; sets above the caller's clearance are left out |
| `POST /api/admin/profiles/:id/eval-sets` `{name, description?, label?, threshold (0–1), gate (default true), judgeProfile?, cases: [{id?, name?, prompt, checks: [...]}]}` | Checks: `{kind: contains\|not-contains, value, caseSensitive?}`, `{kind: regex, pattern}` (RE2), `{kind: json-schema, schema}` (the answer, or its fenced JSON block, must validate), `{kind: judge, rubric, minScore? (0.5)}` (needs `judgeProfile`, a published profile cleared for the set's label). The label defaults to the profile's and may not exceed it or the caller's clearance. Cases are sealed |
| `PATCH /api/admin/profiles/:id/eval-sets/:sid` | Any of the fields; changing cases, threshold or judge (or turning the gate on) starts a new revision |
| `DELETE /api/admin/profiles/:id/eval-sets/:sid` | With its runs |
| `POST /api/admin/profiles/:id/evaluations/run` `{setId?, trigger?}` | `202` with one queued run per set (job `evals.run`) on the profile as saved now: `{id, setId, profileVersion, configHash, setRevision, state, …}` |
| `GET /api/admin/profiles/:id/evaluations/runs/:rid` | The run with `results: [{caseId, name, passed, checks [{kind, passed, detail}], output, judge, ms}]` |
| `POST /api/admin/profiles/:id/evaluations/overrides` `{reason}` | Asks to let the saved settings be published without passing evaluations |
| `POST /api/admin/profiles/:id/evaluations/overrides/:oid/decide` `{decision: approve\|reject}` | Someone other than the requester (`403` with `step: dual-control` otherwise) |

The publish gate: `POST /api/admin/profiles/:id/publish {status: published}`, and any change to a published profile
(edit, rollback, canary promotion) that changes its settings hash, is refused with `409 {code: eval_gate, failing,
configHash}` unless, for that hash, the latest run of every gated set at its current revision passed, or an approved
override exists. Runs are scored on what users would see (each answer passes `model-output`) and metered as `api`.

Audit actions: `profile.eval.set.created`, `profile.eval.set.updated`, `profile.eval.set.deleted`,
`profile.eval.started`, `profile.eval.passed`, `profile.eval.failed`, `profile.eval.error`,
`profile.eval.override.requested`, `profile.eval.override.approved`, `profile.eval.override.rejected`.

### Thinking at the full output check

The `model-output` check on a finished chat answer also runs on its thinking (`meta.part: thinking`). Thinking it
blocks or holds is withheld, a redaction replaces its spans; the message's `guard` gains `thinking {action, reason,
rules}`, and `chat.done` carries a higher `seq` so clients read the answer again.

### Live watches and workspace membership (socket)

A reader watching a conversation through a workspace share (`shared.watch`) gets `shared.revoked` and leaves the room
as soon as they stop being a member of that workspace: removed by an admin, or by a group mapping or the directory
(bus topic `workspace.membership`). A reader still entitled another way (a direct share, another workspace) is let
back in after a fresh check.

### Scheduled agent runs (`agents:run`; `agents:manage` sees every schedule)

| Method and path | What it does |
| --- | --- |
| `GET /api/agent-schedules[?all=true]` | Your schedules (all in the tenant for agent admins with `all`), within your clearance: `{id, name, agent, cron, cronText, label, budgets, enabled, nextRunAt, lastRunAt, lastRunId, lastResult, ownerId, owner, mine, workspaceId, input, createdAt, updatedAt}` |
| `POST /api/agent-schedules` `{name, agent, cron, input, label?, budgets?, enabled?}` | A five-field UTC cron expression. You must be able to start this run now (the agent, its label against your clearance and ceilings, its profile). The request is sealed. The schedule belongs to your current workspace |
| `GET /api/agent-schedules/:id` | One schedule |
| `PATCH /api/agent-schedules/:id` `{agent?, cron?, input?, label?, budgets?, enabled?}` | The owner changes it; an agent admin may only pause or resume someone else's |
| `DELETE /api/agent-schedules/:id` | The owner or an agent admin |
| `GET /api/agent-schedules/:id/history[?limit=]` | Each due time: `{dueAt, at, outcome (started\|skipped\|failed), reason, runId, runState}` |

Due schedules are fired by the `agents.schedules` job every `AGENT_SCHEDULE_TICK_SECONDS`; each due time is claimed
once across instances. The run starts as the owner with the roles, clearance and workspace memberships they hold then;
a disabled owner, one without `agents:run`, one who left the schedule's workspace or can no longer run the agent at
that label is skipped (recorded in the history and audited). Runs carry `scheduleId`.

Audit actions: `agent.schedule.created`, `agent.schedule.updated`, `agent.schedule.deleted`, `agent.schedule.started`,
`agent.schedule.skipped`, `agent.schedule.failed`.

## Sprint 22: Operations, second part

No new permissions. Tracing (B-1401) adds no routes: every request, job, gateway call, guardrail check and database
query is a span of the request's W3C trace when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (a caller's `traceparent` is
honoured, and `X-Trace-Id` is its trace id); Ollama calls carry a `traceparent` header.

### Health

| Method and path | What it does |
| --- | --- |
| `GET /readyz` | Adds `checks.schema`: `ok`, or `behind: <reason>` when the database has a migration this build does not know (B-1403). Such an instance answers 503 and claims no jobs until the database matches its build again |

### Zones applied in-cluster (`zones:manage`, B-1405)

| Method and path | What it does |
| --- | --- |
| `GET /admin/zones-cluster` | `{mode: off\|kubernetes, driftMinutes, fieldManager, drift, objects: [{zone, version, namespace, kind, name, state: pending\|applied\|drift\|missing\|error, detail, appliedAt, checkedAt}]}` |
| `POST /admin/zones-cluster/apply` `{}` | Applies every zone's current NetworkPolicy now with server-side apply (`PATCH … application/apply-patch+yaml`, the field manager, `force=true`): `{applied, failed, objects}`. Also how drift is put right. `409` while `ZONES_APPLY` is off; `502` when the API cannot be reached at all. Audited as `zone.cluster.applied` |
| `POST /admin/zones-cluster/check` `{}` | Compares each live policy with what was applied: `{checked, drift, missing, errors, objects}`. A policy that differs (the first differing field is named) or was deleted is drift; newly found drift is audited as `zone.cluster.drift` and system admins are notified |

Zone changes (approve, seed) queue the job `zones.cluster.apply` on their own when `ZONES_APPLY=kubernetes`; the job
`zones.cluster.drift` runs every `ZONES_APPLY_DRIFT_MINUTES`.

### Platform (`platform:manage`)

| Method and path | What it does |
| --- | --- |
| `GET /admin/platform/summary` | Adds `rateLimitHealth {degraded, since, detail, fallbacks}` (B-1407: Redis configured but not answering, so limits count per instance), `schema {code, database, pending, unknown, state: current\|pending\|behind, reason}` (B-1403), `escrow {id, threshold, shares, keyCheck, createdAt, verifiedAt} \| null` (B-1404), `tracing {enabled, exported, dropped, failed}` and `zonesApply`. `clock.ntp` (B-1406) adds `servers [{server, offsetMs, delayMs, stratum, error, outlier}]`, `outliers`, `quorum` and `warning`; with several `NTP_SERVER`s, `offsetMs` and `skewMs` are the median of the servers that agree and `server` lists them all |

CLI (no routes): `migrate --check`, `kms:escrow --shares <n> --threshold <k>`, `kms:recover --out <file>
[--share …] [--check <value>]`. Audit actions: `zone.cluster.applied`, `zone.cluster.drift`, `kms.escrow.created`.

## Sprint 23: Knowledge, integrations and accessibility

### Knowledge sources (`knowledge:manage` or manage access on the base)

| Route | Notes |
| --- | --- |
| `POST /knowledge/bases/:id/sources` `{kind: s3, location: "s3://bucket/prefix/", include?, endpoint?, region?, pathStyle?, accessKeyId?, secretAccessKey?}` | B-1501. `include`: up to 20 patterns relative to the prefix (`*` within a folder, `**` across folders, `?` one character); objects that match none are never fetched. Without `endpoint` the platform's S3 credentials are used (keys are refused, `400`). With `endpoint` (an S3-compatible service; internal, or named in `KNOWLEDGE_ALLOWED_HOSTS`, else `409`; link-local and metadata addresses always `409`) both keys are required and are sealed with the tenant key; responses and the audit entry carry only `ownKeys: true`. Objects are versioned by ETag: an unchanged object is not downloaded again, and one no longer listed is removed from every index |
| `POST /knowledge/bases/:id/sources` `{kind: web, location: "https://intranet.example.internal/", maxDepth?: 0-5 (2), maxPages?: 1-1000 (100), pathPrefix?, sitemap?: true}` | B-1502. Crawls an internal site from its start page: same scheme, host and port only (links, redirects and sitemap entries elsewhere are skipped), robots.txt honoured (user agent `ExprsnAI-Knowledge`), the sitemap's pages added at depth 1, `pathPrefix` limiting paths. HTML, plain text, Markdown, CSV, JSON and PDF pages are indexed; `noindex` pages are followed but not indexed, `nofollow` links are not followed. Pages are re-checked with `If-None-Match`/`If-Modified-Since`; a 304 keeps the document. Pages no longer reached are removed. The sync job's result lists up to 50 skipped URLs with the reason |
| `POST /knowledge/bases/:id/sources` `{kind: database, location: "pg: …", connectionId, roleMappings: [{group, role}]}` | B-1503, PostgreSQL only. Each sync reads the object once per mapped role (`SET LOCAL ROLE` in the read-only transaction); a row's document and chunks may be retrieved by the groups whose role saw it, and a row no role sees is not indexed. `409` when a role is missing, the connection's account is not a member, the role is superuser or BYPASSRLS or may not select the object, the table does not enable row security (or a mapped role owns it without FORCE), a view is not `security_invoker`, or with `accessColumn` or `replication`. Synced by full reads (no watermark) |

### Webhooks (`webhooks:manage`)

Ordered webhooks (B-1504) keep their order across instances: each event's position comes from the endpoint's
counter in the database, taken in the same transaction that queues the delivery, and only the holder of the
endpoint's delivery lease sends (one delivery in flight per ordered endpoint). `X-Exprsn-Sequence` is that position.
No route changes.

### Billing (`billing:manage`, `billing:read`)

| Route | Notes |
| --- | --- |
| `PATCH /admin/billing/price-books/:id` `{…, items?, effectiveFrom?}` | B-1505. New `items` take effect at `effectiveFrom` (an ISO date or date-time, UTC unless an offset is given; default now): no earlier than the start of the current month (`409`) and not in the future (`409`); `effectiveFrom` without `items` is `400`. Saving the same items again makes no version. Answers the book with `versions: [{id, items (a count), effectiveFrom, createdAt}]` (null `effectiveFrom`: from the start). Audited with `effectiveFrom` |
| `GET /admin/billing/statements/:month` | A month whose book changed during it is prorated: `prorated: true`, and each line carries `from` and `to` (ms, end exclusive) for the part of the month it covers, priced with the items in effect then. Also `refundedMicros`, `creditedMicros`, `credits: [{id, amountMicros, state: issued \| void}]`, `disputedMicros`, `disputeStatus`. New states `partly refunded`, `refunded`, `disputed`, `dispute lost` (all final, like `paid`) |
| `POST /billing/stripe/webhook` (public) | Also: `charge.refunded` (the charge's `amount_refunded` is the running total: the statement becomes `refunded` when it covers the charge's `amount`, else `partly refunded`; an older, smaller total is ignored), `credit_note.created`/`updated`/`voided` (recorded by id; voided notes no longer count), `charge.dispute.created`/`updated` (`disputed`, with the amount and status) and `charge.dispute.closed` (`won` returns the statement to paid, or refunded; `lost` makes it `dispute lost`). The statement is found by invoice id, then by the charge or payment intent remembered from `invoice.paid`, then by `metadata.statement` |

Audit actions: `billing.statement.refunded`, `billing.statement.credited`, `billing.statement.credit-voided`,
`billing.statement.disputed`, `billing.statement.dispute-updated`, `billing.statement.dispute-closed` (actor
`service: stripe`, detail with the amounts in micro-units and the statement's state).

## Sprint 24: Secrets vault (B-1701 to B-1703)

All routes are under `/api` and answer `Cache-Control: no-store`. Each needs a vault permission and then the **path
policy** for the capability it uses. Permissions: `secrets:read` (read and list secrets, use transit keys, explain
your own access), `secrets:write` (write, soft-delete and undelete, edit metadata), `secrets:admin` (destroy, remove
a path, manage transit keys, edit policies). Built-in roles: `tenant-admin` has all three, `connection-admin` read and
write, `member` read (a member reaches nothing until a policy grants it). Policy paths are `kv/<path>` for secrets and
`transit/<name>` for transit keys; a denial is `403` with `step: vault-policy`, `path`, `capability` and the deciding
`grant {id, effect, path, subjectKind, subject}` (null when nothing matched), and is written to the audit chain as
`vault.denied` (capped per principal like other denials). Secrets and keys carry a label; above the caller's clearance
they answer `404`. Paths are 1 to 16 segments of lower-case letters, digits, `.`, `-` and `_`.

### KV secrets (B-1701)

| Route | Capability | Notes |
| --- | --- | --- |
| `GET /vault/kv?prefix=` | `list` | Secrets under the prefix the caller may list: `{secrets: [{path, label, currentVersion, updatedAt}]}` |
| `PUT /vault/kv/data/*path` `{data: {key: value}, cas?, label?}` | `write` | Writes a new version (`201` for version 1, else `200`): `{path, version, label, createdAt}`. `data` has 1 to 200 string values, 64 KiB in all, sealed with the tenant data key (associated data: the version row id). `cas`: the write happens only if the current version is `cas` (`0`: only when the path is new), else `409` with `currentVersion`; required when the path's `casRequired` is set. `label` (default `internal`, at most the caller's clearance) applies when the path is created. Versions beyond `maxVersions` are removed, oldest first |
| `GET /vault/kv/data/*path?version=` | `read` | Reveals a version (default current): `{path, version, label, data, createdAt, createdBy}`. `410` with `state: deleted` or `destroyed`; `404` for a version removed by `maxVersions`. Audited as `vault.secret.read` (path, version and the number of keys; never values) |
| `GET /vault/kv/metadata/*path` | `list` | `{path, label, currentVersion, oldestVersion, maxVersions, casRequired, customMetadata, createdBy, createdAt, updatedAt, versions: [{version, state: active\|deleted\|destroyed, createdBy, createdAt, deletedAt, destroyedAt}]}` |
| `PATCH /vault/kv/metadata/*path` `{maxVersions?: 1-100, casRequired?, customMetadata?, label?}` | `write` | Lowering `maxVersions` removes older versions at once |
| `POST /vault/kv/delete/*path` `{versions?}` | `delete` | Soft delete (default: the current version); readable again after undelete |
| `POST /vault/kv/undelete/*path` `{versions}` | `delete` | `410` for a destroyed version |
| `POST /vault/kv/destroy/*path` `{versions}` (`secrets:admin`) | `destroy` | Removes the sealed values for good; the version numbers stay in the metadata |
| `DELETE /vault/kv/metadata/*path` (`secrets:admin`) | `destroy` | Removes the path, its metadata and every version (`204`) |

Soft delete and undelete need `secrets:write` and the `delete` capability. New secrets keep
`VAULT_KV_MAX_VERSIONS` versions (default 10). Audit actions: `vault.secret.written`, `vault.secret.read`,
`vault.secret.metadata.updated`, `vault.secret.deleted`, `vault.secret.undeleted`, `vault.secret.destroyed`,
`vault.secret.removed`.

### Transit (B-1702)

Named, versioned keys per tenant: `aes256-gcm96` (encrypt, decrypt, rewrap) and `ed25519` or `ecdsa-p256` (sign,
verify). Key material is generated in the server, sealed with the tenant data key and never exported. Ciphertext and
signatures are `exai:v<version>:<base64>`. Encryption binds the tenant, the key, the version and the optional
`context` (base64), which must be given again to decrypt. Plaintext, input and context are base64.

| Route | Capability | Notes |
| --- | --- | --- |
| `GET /vault/transit/keys` | `list` | `{keys: [{name, type, label, latestVersion, minDecryptVersion}]}` |
| `POST /vault/transit/keys` `{name, type?, label?}` (`secrets:admin`) | `manage` | `201` with the key view; `409` if the name exists. Names: 1 to 64 lower-case letters, digits, `.`, `-`, `_` |
| `GET /vault/transit/keys/:name` | `list` | `{name, type, label, latestVersion, minDecryptVersion, minAvailableVersion, deletionAllowed, supports, versions: [{version, createdAt, publicKey?}]}` (SPKI PEM for signing keys) |
| `POST /vault/transit/keys/:name/rotate` (`secrets:admin`) | `manage` | New latest version; older versions still decrypt and verify down to `minDecryptVersion` |
| `PATCH /vault/transit/keys/:name` `{minDecryptVersion?, deletionAllowed?}` (`secrets:admin`) | `manage` | `minDecryptVersion` between `minAvailableVersion` and `latestVersion`: ciphertext and signatures from older versions are refused (`400`, title `Version below minimum`) |
| `POST /vault/transit/keys/:name/trim` `{minAvailableVersion}` (`secrets:admin`) | `manage` | Deletes the material of versions below it; it may not pass `minDecryptVersion` (`400`) |
| `DELETE /vault/transit/keys/:name` (`secrets:admin`) | `manage` | Only with `deletionAllowed` (`409` otherwise); everything encrypted with the key becomes unreadable |
| `POST /vault/transit/encrypt/:name` `{plaintext, context?}` or `{batch: [{plaintext, context?}]}` | `encrypt` | `{ciphertext}` or `{batch: [{ciphertext}]}`, with the latest version. Up to 100 items |
| `POST /vault/transit/decrypt/:name` `{ciphertext, context?}` or `{batch}` | `decrypt` | `{plaintext}`; in a batch each item is `{plaintext}` or `{error, status}`. Audited as `vault.transit.decrypted` (counts only) |
| `POST /vault/transit/rewrap/:name` `{ciphertext, context?}` or `{batch}` | `rewrap` | Decrypts and re-encrypts with the latest version inside the server: `{ciphertext}`; the plaintext is never returned. Audited as `vault.transit.rewrapped` |
| `POST /vault/transit/sign/:name` `{input}` | `sign` | `{signature, version}` (Ed25519; ECDSA P-256 over SHA-256, DER). Audited as `vault.transit.signed` |
| `POST /vault/transit/verify/:name` `{input, signature}` | `verify` | `{valid, version}`; a signature below `minDecryptVersion` is refused (`400`) |

Audit actions: `vault.transit.key.created`, `.rotated`, `.configured`, `.trimmed`, `.deleted`,
`vault.transit.decrypted`, `vault.transit.rewrapped`, `vault.transit.signed`. Encrypt and verify reveal nothing and are
not audited.

### Policies (B-1703)

A grant allows or denies capabilities (`list`, `read`, `write`, `delete`, `destroy`, `encrypt`, `decrypt`, `rewrap`,
`sign`, `verify`, `manage`, or `*`) on a path prefix (`*`, `kv`, `transit`, or a path under them) to a subject: a
`user` (id), a directory `group` (name, matched case-insensitively against the groups the user's stores report), a
`workspace` (its members) or an `api_key` (id). An API key acts as its owner plus itself, so a grant to the key adds
to the owner's access and a deny on the key narrows it. Prefixes match whole segments (`kv/apps` covers `kv/apps/db`,
not `kv/apps2`). Any matching deny refuses, however specific the allows; otherwise the longest matching allow
decides; nothing matching is a default deny.

| Route | Notes |
| --- | --- |
| `GET /vault/policies` (`secrets:admin`) | `{policies: [{id, subjectKind, subject, path, capabilities, effect, description, createdBy, createdAt, updatedAt}]}` |
| `POST /vault/policies` `{subjectKind, subject, path, capabilities, effect?: allow\|deny, description?}` (`secrets:admin`) | `201`. The user, workspace or API key must exist in the tenant (`400`) |
| `PATCH /vault/policies/:id` `{path?, capabilities?, effect?, description?}` (`secrets:admin`) | The subject cannot change |
| `DELETE /vault/policies/:id` (`secrets:admin`) | `204` |
| `POST /vault/policies/explain` `{path, capability, userId?, apiKeyId?}` (`secrets:read`; another user or key needs `secrets:admin`) | `{subjects {userId, groups, workspaces, apiKeyId}, decision {allow, capability, path, grant, reason}, grants: [{grant, appliesToCapability, deciding}]}`: every grant naming the subject that covers the path, most specific first, with the deciding one marked |

Audit actions: `vault.policy.created`, `vault.policy.updated`, `vault.policy.deleted`, `vault.denied`.

## Sprint 24: Certificate authority (B-1601 to B-1604)

A platform root and one active intermediate per tenant. Issuer and OCSP responder keys are made and used in the
signer process (`SIGNER_SOCKET`) or OpenBao transit (`KMS_PROVIDER=openbao`); without either, key-making routes answer
`409` (`step: custody`). Rows hold the certificate, the public key and the signer's wrapped blob or the transit key
name, never a private key. Errors are problem details; refusals by policy are `422` with `step` (`names`, `key`,
`lifetime`) and, for a name, `name {type, value}`.

### Admin (`pki:manage`; the root also needs `platform:manage`)

| Method and path | What it does |
| --- | --- |
| `GET /api/pki` | `custody` (`signer process`, `OpenBao transit` or `unavailable`), the CRL and OCSP settings, `baseUrl`, `profileMaxDays`, `reasons` |
| `GET /api/pki/issuers[?all=true]` | The roots and the tenant's intermediates (every tenant's with `all=true` and `platform:manage`): `{id, tenantId, parentId, kind, name, organization, keyType, custody, serial, generation, pathLen, notBefore, notAfter, state: active\|retired\|revoked, revokedAt, revocationReason, crlNumber, replacedBy, certificatePem, urls {crl, certificate, ocsp}}` |
| `POST /api/pki/issuers` `{kind: root, commonName, organization?, keyType?: ecdsa-p256\|rsa-3072, days?: 30-9125 (3650)}` | `platform:manage` and a recent sign-in. Self-signed, CA with no path length, keyCertSign and cRLSign. `409` while a root is active (rotate instead). `201` |
| `POST /api/pki/issuers` `{kind: intermediate, commonName?, organization?, keyType?, days?: 7-1825 (1825)}` | The session's tenant's issuing CA, signed by the active root: pathLen 0, CRL distribution point and AIA (OCSP, caIssuers) pointing at the root's public routes, never past the root's expiry. `409` without an active root or with an active intermediate. `201` |
| `GET /api/pki/issuers/:id` | Adds `chain` (PEM, the issuer first) and the last five `crls` |
| `POST /api/pki/issuers/:id/rotate` `{days?}` | Recent sign-in. A new key and certificate (`generation` + 1); the old issuer becomes `retired` with `replacedBy`, stops issuing, and keeps serving its CRL and OCSP. `201` with the new issuer |
| `POST /api/pki/issuers/:id/reissue` `{days?}` | Recent sign-in. The same key, a new serial and validity; an intermediate is signed by the current root (after a root rotation). Certificates issued before still verify |
| `POST /api/pki/issuers/:id/revoke` `{reason?}` | Recent sign-in; intermediates only (a root is retired by rotation). Listed on the root's next CRL (a CRL job is queued) |
| `POST /api/pki/issuers/:id/issue` `{csr (PEM PKCS#10), profileId, days?, sans?: [{type: dns\|ip\|email\|uri, value}]}` | B-1602. The tenant's active intermediate only (`404` for a root or another tenant's, `409` when retired, revoked or expired). The CSR's self-signature must verify (`400`, `step: csr`); keys: P-256, P-384, RSA 2048/3072/4096, Ed25519, as the profile allows. Names come from `sans`, else the CSR's subjectAltName, else (server profiles) its CN; each is checked against the profile and a refusal is audited as `pki.issue.refused`. `days` over the profile's maximum is `422`; validity never passes the issuer's (`clamped: true`). The subject is the CN only. `201` `{…certificate, certificatePem, chainPem, clamped}` |
| `POST /api/pki/issuers/:id/crl` | Queues a `pki.crl` job now. `202 {jobId}` |
| `GET /api/pki/issuers/:id/crls` | The last 50 CRLs `{number, thisUpdate, nextUpdate, entries}` and the public `url` |
| `GET /api/pki/certificates[?issuerId&state=valid\|revoked&limit&before]` | The tenant's certificates, newest first: `{id, issuerId, profileId, serial, commonName, sans, keyType, notBefore, notAfter, fingerprint, state, revokedAt, revocationReason, invalidityDate, requestedBy, createdAt}` |
| `GET /api/pki/certificates/:id` | Adds `certificatePem` and `chainPem` |
| `POST /api/pki/certificates/:id/revoke` `{reason?: unspecified\|keyCompromise\|affiliationChanged\|superseded\|cessationOfOperation\|privilegeWithdrawn, invalidityDate?}` | B-1603. RFC 5280 reason codes (`cACompromise` is for issuers, `422`; holds and `removeFromCRL` are not supported, `400`). Drops cached OCSP answers on every instance and queues the issuer's next CRL. `409` when already revoked |
| `GET /api/pki/profiles`, `POST /api/pki/profiles` `{name, kind: server\|client\|code-signing, maxDays, defaultDays?, policy?}` | `policy {domains: ["host", "*.domain"], allowWildcard, ipRanges: [CIDR], emailDomains, uriPrefixes, keyTypes}`. Server profiles issue dNSName and iPAddress names (serverAuth, at most 398 days); client profiles dNSName, iPAddress, rfc822Name and URI (clientAuth, 825 days); code-signing rfc822Name and URI and need a CN (codeSigning, 1185 days). `*.domain` allows every name below it; a wildcard name also needs `allowWildcard`. `409` for a duplicate name |
| `PATCH /api/pki/profiles/:id` `{policy?, maxDays?, defaultDays?, state?: active\|disabled}`, `DELETE /api/pki/profiles/:id` | `204` on delete |

Audit actions: `pki.root.created`, `pki.intermediate.created`, `pki.issuer.rotated`, `pki.issuer.reissued`,
`pki.issuer.revoked`, `pki.profile.created`, `pki.profile.updated`, `pki.profile.deleted`, `pki.certificate.issued`,
`pki.issue.refused`, `pki.certificate.revoked`, `pki.crl.requested`, `pki.responder.issued` (system). Jobs:
`pki.crl` (every `PKI_CRL_MINUTES` per live issuer, and after each revocation; it also renews the issuer's OCSP
responder certificate).

### Public (no session; `PKI_PUBLIC_RATE_PER_MINUTE` per address, then `429`)

| Method and path | What it does |
| --- | --- |
| `GET /pki/crl/:issuer.crl`, `GET /pki/crl/:issuer.pem` | The issuer's latest CRL (X.509 v2, `application/pkix-crl` or PEM): `cRLNumber` increasing per issuer, the authority key identifier, each revoked certificate (and revoked child intermediate) not yet expired with its reason code (absent for unspecified) and invalidity date. Signed afresh on request when none exists or the latest is past `nextUpdate`. `Cache-Control: public, max-age` up to an hour, never past `nextUpdate` |
| `GET /pki/ca/:issuer.crt`, `GET /pki/ca/:issuer.pem` | The issuer's certificate (the caIssuers URL in what it issued) |
| `POST /pki/ocsp` (`application/ocsp-request`, at most 16 KiB), `GET /pki/ocsp/<url-encoded base64 request>` | B-1604, RFC 6960. CertIDs with SHA-1 or SHA-256, up to 10 per request, all under one issuer. Signed by the issuer's delegated responder (a P-256 certificate it issued with id-kp-OCSPSigning and id-pkix-ocsp-nocheck, `PKI_OCSP_SIGNER_DAYS`, renewed a third before expiry; responder id by key hash; the responder and issuer certificates are included). `good`, `revoked` (time and reason) or `unknown`; `thisUpdate` now, `nextUpdate` after `PKI_OCSP_VALIDITY_MINUTES`; a request nonce (RFC 8954, up to 32 octets) is echoed. Errors are OCSP statuses: `malformedRequest`, `unauthorized` (an issuer this CA does not know), `internalError` (the key store failed). Answers without a nonce are cached per instance for `PKI_OCSP_CACHE_SECONDS` and dropped on revocation; GET answers carry `Cache-Control: public, max-age` |

## Sprint 24c (1.4.0): platform core

The complete route list, with request and response schemas for the routes below, is [openapi.json](openapi.json)
(OpenAPI 3.1). `server/test/openapi.test.ts` fails when a registered route is missing from it or an operation in it is
no longer registered; `npx tsx server/test/openapi-routes.ts --write` adds missing routes with their summary from this
file.

### Event catalogue (`webhooks:manage` or `plugins:manage`)

| Route | Notes |
| --- | --- |
| `GET /events/catalogue` | B-2001. `{version, envelope, groups: [{pattern, description}], types: [{type, group, version, since, status: emitted \| reserved, description, schema}], auditActions: {version, since, description, schema}}`. The envelope is the body of every delivery `{id, type, tenant, label, createdAt, data}`; `schema` is the JSON Schema of `data`. Named types: `job.*`, `flag.*`, `approval.requested`, and, reserved until their domains ship, `record.*`, `file.*`, `group.*`, `message.*` and `post.*`. Every other type is an audit action whose data is the audit entry; a change audited under a named type's name (`flag.confirmed`) is delivered with both shapes, told apart by `data.hash`. `version` moves when a type is added or changes; a type's own `version` only when its data changes incompatibly. `ETag`, `304` on `If-None-Match` |

Every event the webhook fan-out sees is checked against the catalogue; a mismatch is still delivered, counted in
`exprsn_event_schema_violations_total{type}` and logged. `GET /admin/webhooks` lists the catalogue's groups as
`events` (now also `plugin.*`, `record.*`, `file.*`, `group.*`, `message.*`, `post.*`).

### Plugins (`plugins:manage`)

A plugin is data: a manifest and the capabilities granted to it, per tenant. Nothing in a manifest is loaded into the
server; declarative actions and script handlers (in the sandbox) run from Sprint 25 (below). Tenant admins hold
`plugins:manage`.

| Route | Notes |
| --- | --- |
| `GET /admin/plugins/capabilities` | The closed vocabulary `{capabilities: [{name, description, risk: low \| high, events?}], actions: {log: "emit:log", …}}`: `read:events`, `read:records`, `read:files`, `read:groups`, `read:messages`, `read:posts`, `emit:log`, `emit:audit`, `emit:notification`, `emit:flag` (low), `call:webhook`, `call:workflow`, `write:records`, `write:posts` (high) |
| `POST /admin/plugins/validate` `{manifest}` | `200 {valid: true, manifest}` or `422` with `errors` (every problem). A manifest is `{key, name, version (semver), kind: declarative \| webhook \| script, description?, publisher?, homepage?, events?, capabilities?, optionalCapabilities?, config?: {schema}, actions?: [{type, on?, with?}], webhook?: {url}, script?: {entry, source}}`; unknown fields are refused. Each capability must be in the vocabulary, each event a catalogue group or type covered by a read capability (`record.*` needs `read:records`), each action's capability declared, `config.schema` a JSON Schema |
| `GET /admin/plugins?removed=true` | `{plugins: [{id, key, name, version, kind, description, publisher, state: installed \| enabled \| disabled \| removed, events, capabilities, optionalCapabilities, granted, missing, maxLabel, configured, manifestHash, installedBy, stateChangedAt, createdAt, updatedAt}]}`; plugins above the caller's clearance are left out. `missing` lists required capabilities not granted |
| `POST /admin/plugins` `{manifest, grants?, maxLabel?: internal, config?, reason?}` | Installs, or reinstalls a removed plugin (same id, new manifest). `grants` default to the low-risk capabilities the manifest asks for; high-risk ones only when named; anything not in the manifest is `400`. `config` is checked against `config.schema` (`422`) and sealed with the tenant key. `409` when installed and not removed; `403` when `maxLabel` is above the caller's clearance. Audited `plugin.installed` or `plugin.reinstalled` |
| `GET /admin/plugins/:id` | `:id` is the id or the key. The plugin, its `manifest` (a script's source as `{entry, bytes}`) and `transitions` |
| `POST /admin/plugins/:id/enable` `{reason?}` | installed or disabled to enabled. `409` with `missing` when a required capability is not granted, and from any other state; since Sprint 25 also `409` for a script plugin not from a signed bundle (`PLUGINS_REQUIRE_SIGNED`) or without a sandbox, and `422` when a webhook endpoint it names is now refused. Audited `plugin.enabled` |
| `POST /admin/plugins/:id/disable` `{reason?}` | installed or enabled to disabled. Audited `plugin.disabled` |
| `DELETE /admin/plugins/:id?reason=` | installed, enabled or disabled to removed (`204`). Audited `plugin.removed` |
| `PUT /admin/plugins/:id/grants` `{grants, reason?}` | Replaces the grants; an enabled plugin that loses a required one is disabled. Audited `plugin.grants.updated` (`before`, `after`, `added`, `removed`, `highRisk`) |
| `GET /admin/plugins/:id/transitions` | `{transitions: [{event: install \| enable \| disable \| remove \| grants, from, to, version, actor, reason, at}]}`, oldest first |

Two transitions racing from one state never both apply (the second is `409`). Each change publishes `plugin.changed`
on the bus and clears the tenant's cached list of enabled plugins on every instance.

### Realtime rooms (sockets)

B-2101, the generic mechanism for the domains to come (messaging conversations, groups, feeds, channels). A client
asks `room.join {kind: conversation | group | feed | channel, id}` (acknowledged `{ok, label}` or `{ok: false,
error}`) and `room.leave {kind, id}`; the domain's authoriser decides from the session, and a kind no domain has
registered admits nobody. A socket holds at most 50 rooms. Domain events arrive named `<kind>.<event>` with `{kind, id,
…}`. When access ends (a member removed, a label raised, the workspace that admitted the user left) the socket leaves
the room before any further event is relayed and receives `room.closed {kind, id}`, unless a fresh check lets it back
in. No domain registers rooms yet.

### CLI

`exprsn-ai plugins list | show | capabilities | validate | install | enable | disable | remove | grants` (as the
routes above, for `--tenant <slug>`, audited with actor `service: cli`; exit 3 for a refused transition) and
`exprsn-ai events replay --webhook <id> [--source deliveries | audit] [--since] [--until] [--type]… [--state]
[--limit] [--dry-run]`: `deliveries` sends past deliveries again, each its exact body as a new delivery; `audit`
backfills audit-action events from the audit chain that the webhook never received, within its event list and label.
Audited `webhook.replayed`.

## Sprint 25d (1.4.0): plugins that run (B-2003 to B-2005)

Events reach enabled plugins as jobs. Every event the webhook fan-out sees (audit actions, `job.*` except the plugin
and webhook deliveries' own, `flag.*`, `approval.requested`) is offered to the tenant's enabled plugins that subscribe
to it at or below their `maxLabel` (a declarative plugin only when one of its actions is `on` it); each delivery is a
`plugin_invocations` row with the event sealed and a `plugin.invoke` job. An event reaches a plugin once. Bounds:
`PLUGIN_RATE_PER_MINUTE` invocations a minute per plugin (past it the event is dropped, counted in
`exprsn_plugin_dropped_total{reason="rate"}` and audited once a window as `plugin.throttled`), `PLUGIN_CONCURRENCY`
running at once per plugin across instances (the rest wait as queued jobs). The loop rule: an event caused by a
plugin's work carries the chain of plugins behind it and is never delivered to a plugin in that chain, nor at all once
the chain is `PLUGIN_MAX_DEPTH` long (`exprsn_plugin_dropped_total{reason="loop" | "depth"}`); see
`docs/security.md`. Metrics: `exprsn_plugin_invocations_total{result}`, `exprsn_plugin_calls_total{api,status}`.

### Declarative actions (B-2003)

Each action names its capability and is checked against the plugin's grants when it runs: an action whose capability
is not granted (an optional one, or one withdrawn since) is refused and audited `plugin.action.refused` (actor
`service: plugin:<key>`, detail `{action, capability, granted, event}`); the other actions still run. Strings in `with`
may use `{{event.type}}`, `{{event.data.<field>}}`, `{{config.<field>}}`, `{{plugin.key}}`.

| Action | Capability | `with` | Effect |
| --- | --- | --- | --- |
| `log` | `emit:log` | `message?`, `level?: info \| warn \| error` | A line in the plugin's own log (sealed) |
| `audit` | `emit:audit` | `message?`, `detail?` (flat values) | `plugin.audited` in the tenant's audit chain, attributed to the plugin |
| `notify` | `emit:notification` | `title?`, `body?`, `roles?` (default `tenant-admin`), `users?` | In-app notifications (kind `plugin`) to active users cleared for the event's label |
| `flag` | `emit:flag` | `reason?`, `severity?: low \| medium \| high` | A `report` flag at checkpoint `plugin` for human review (it never acts on its own) |
| `webhook` | `call:webhook` | `url?` (else the install's `config.webhookUrl`; a `webhook` plugin's `webhook.url`) | One delivery through the webhook path: a webhook named `plugin:<key>:<hash>` per endpoint (subscribed to nothing, Ed25519-signed, so receivers verify with the tenant's JWKS), its retries and breaker, and the outbound host checks at install, at enable and at every attempt (`422` when refused). The body is the triggering event. Removing the plugin removes its webhooks |
| `workflow` | `call:workflow` | `workflow` (name or id), `input?`, `includeEvent?` | Starts the tenant-wide published workflow as the user who installed the plugin (still active, with `agents:run`), at no more than the plugin's `maxLabel`; trigger `plugin:<chain>`; audited `workflow.run.started` |

A manifest's `with` is checked per action at install (`422` naming each problem).

### Script plugins (B-2004)

A script plugin names `script: {entry, source, language?: javascript | python}`; `entry` is a function the source
declares, called as `entry(event, platform)`. The source passes the scripts' checks (no network or process modules, no
credentials). Its handler runs per invocation in the script sandbox (`SCRIPT_RUNNER`: a disposable docker or podman
container with no network, optionally under gVisor), never in the server, within `PLUGIN_SCRIPT_TIMEOUT_SECONDS` and
`PLUGIN_SCRIPT_MEMORY_MB`. It reaches the platform only through the broker: `platform.call(api, args)` (and
`platform.log(message)`) sends the call over the container's stdout with the invocation's scoped token, and the answer
comes back on stdin. The token (`xpt_…`, stored as sha256) is made per invocation, lives for the time limit, carries the
grants at that moment, allows `PLUGIN_MAX_CALLS` calls and is revoked when the handler ends. Every call is checked
against the token's grants and the plugin's grants now: an ungranted call answers `403` (the handler sees an error
with `status` 403) and is audited `plugin.call.refused`. Calls: `log`, `audit`, `notify`, `flag`, `webhook`
(`args.data` as the body), `workflow` (as the actions above), and `records.read`, `records.write`, `files.read`,
`groups.read`, `posts.write` (`501` until their domains ship). The handler's output and return value go to the
plugin's log.

| Route | Notes |
| --- | --- |
| `POST /plugin-broker/v1/calls/:api` | Outside `/api`, no session: `Authorization: Bearer xpt_…` only. The same broker for a sandbox that can reach the server. `200` with the call's result; `401` (unknown, expired or revoked token), `403` (not granted, or the plugin is no longer enabled), `404` (no such call), `429` (`PLUGIN_MAX_CALLS`), `501` |

### Plugins from signed import bundles (B-2005)

A signed import bundle (`/admin/platform/bundles`) may carry plugin manifests: files with `mirror: "plugins"`, each a
JSON manifest. They go through the same verification (signature against the signer keys under dual control, digests,
SBOM scan, licence allow-list, staging) and promotion, which puts them in the plugin catalogue. With
`PLUGINS_REQUIRE_SIGNED=scripts` (default) script plugins are installed only this way; `all` makes it the only way for
every plugin; `none` allows inline installs of all kinds.

| Route | Notes |
| --- | --- |
| `GET /admin/plugins/available` | `{plugins: [{bundle: {id, name, digest, signer, promotedAt}, path, sha256, size, manifest: {key, name, version, kind, capabilities} \| null, problem}]}`: plugin files of promoted bundles |
| `POST /admin/plugins/import` `{bundle (id or name), path, grants?, maxLabel?, config?, reason?}` | Installs from a promoted bundle, reading the file again from the stored transfer: the transfer's digest, the signature against the signer keys registered now (a key revoked since fails it) and the file's sha256 against the signed manifest. `409` for a bundle not promoted (an unsigned or badly signed one is rejected at verification) or one that fails these checks (`title: Bundle refused`); otherwise as `POST /admin/plugins`. The plugin records `source: bundle` and `bundle: {id, digest, path, signer}`; audited `plugin.installed` with them |
| `GET /admin/plugins/:id/invocations?limit=&state=` | `{invocations: [{id, event, eventId, label, state: queued \| running \| succeeded \| failed \| cancelled, attempts, chain, outcome, error, jobId, createdAt, startedAt, finishedAt}]}`, newest first. `outcome` is `{actions: [{type, ok, status?, error?}]}` or, for a handler, `{calls: [{api, status}], exitCode, timedOut, durationMs, returned}` |
| `GET /admin/plugins/:id/logs?limit=&invocation=` | `{logs: [{id, invocationId, level, message, at}]}`, newest first (opened from the sealed log) |

`GET /admin/plugins/capabilities` also lists `calls` (each brokered call and its capability). Plugin views carry
`source` and `bundle`.

## Sprint 25c (1.4.0): database leases, vault references, rotation (B-1704 to B-1706)

### Database leases (B-1704)

Built-in PostgreSQL and MySQL engines make short-lived accounts on a tenant's own database server (OpenBao's database
engine for data connections stays as in Sprint 15, B-416). Vault policy paths gain a third namespace,
`database/<engine>/<role>`: `read` takes a lease, `list` shows the role. All routes answer `Cache-Control: no-store`.

Engines and roles need `connections:manage`. An engine is registered in a zone whose ceiling covers its label (the
B-415 checks: `422` for an undefined zone, `403` with `step: zone` and `zoneCeiling` above the ceiling; both audited as
`vault.database.engine.refused`) and within the caller's clearance. Its admin login is a password (sealed with the
tenant data key, never shown again) or `adminPasswordRef: vault:path#key` (B-1705: refused at save unless the caller
may read it, then read as that user every time the engine logs in). With `check` (default) the server logs in first
and refuses (`422`) an admin that cannot create accounts. The admin needs `CREATEROLE` (PostgreSQL) or `CREATE USER`
(MySQL), and grant options on what its roles hand out.

| Route | Notes |
| --- | --- |
| `GET /vault/database/engines` | `{engines: [{name, dialect, endpoint, database, tls, zone, label, adminUsername, adminPasswordFrom: sealed\|vault, adminPasswordRef, userHost, defaultTtlSeconds, maxTtlSeconds, state, activeLeases, roles, createdBy, createdAt, updatedAt}]}` (engines above the caller's clearance are left out) |
| `POST /vault/database/engines` `{name, dialect: postgres\|mysql, endpoint, database?, tls?, zone?, label?, adminUsername, adminPassword \| adminPasswordRef, userHost?, defaultTtlSeconds?, maxTtlSeconds?, check?}` | `201` with the engine (and `check {version, canCreate, detail}`); `409` if the name exists. TTLs default to `VAULT_LEASE_DEFAULT_TTL_SECONDS`, at most `VAULT_LEASE_MAX_TTL_SECONDS`. MySQL needs `database`; `userHost` (default `%`) is the host part of generated MySQL accounts |
| `GET /vault/database/engines/:name` | The engine |
| `PATCH /vault/database/engines/:name` `{endpoint?, database?, tls?, zone?, label?, adminUsername?, adminPassword?, adminPasswordRef?, userHost?, defaultTtlSeconds?, maxTtlSeconds?, state?: active\|disabled}` | Zone and label changes pass the same checks; a new password or reference makes the caller the login's owner. A disabled engine issues no leases (live ones keep running) |
| `DELETE /vault/database/engines/:name` | Drops every live lease's account first; `409` while any could not be dropped (they are retried). `204` |
| `POST /vault/database/engines/:name/test` | `{ok, version, canCreate, detail, ms}`; audited |
| `PUT /vault/database/engines/:name/roles/:role` `{privileges: read\|readwrite, schemas?, defaultTtlSeconds?, maxTtlSeconds?}` | Creates or replaces a role (`[a-z][a-z0-9_]{0,31}`). `schemas`: PostgreSQL schemas (default `public`) or MySQL databases (default the engine's), letters, digits, `_`, `$`, `-`. `read` grants `SELECT` on all tables in them; `readwrite` adds `INSERT, UPDATE, DELETE` (and sequence use on PostgreSQL). A role's maximum TTL cannot pass the engine's |
| `DELETE /vault/database/engines/:name/roles/:role` | `409` while the role has live leases |
| `POST /vault/database/sweep` | Runs the expiry sweeper for the tenant now (`202 {jobId}`); it also runs every `VAULT_LEASE_SWEEP_SECONDS` for tenants with a lease due |

Leases need `secrets:read` and the vault policy:

| Route | Notes |
| --- | --- |
| `GET /vault/database/roles` | The roles the caller's policy lists or lets them take, within their clearance: `{roles: [{engine, dialect, endpoint, database, label, name, privileges, schemas, defaultTtlSeconds, maxTtlSeconds, policyPath, canIssue}]}` |
| `POST /vault/database/creds/:engine/:role` `{ttlSeconds?}` | `read` on `database/<engine>/<role>` (else `403`, `step: vault-policy`, audited as `vault.denied`). Creates the account, then answers `201 {id, engine, role, username, label, state, issuedTo, issuedAt, expiresAt, maxExpiresAt, renewals, leaseDurationSeconds, renewable, password, connection {dialect, endpoint, database, tls}}`. **The password is in this response only**; it is not stored. The TTL is cut to the role's maximum; the lease can never outlive `maxExpiresAt` |
| `GET /vault/database/leases?all=&engine=&state=&limit=` | The caller's leases; `all=1` (every lease in the tenant) needs `connections:manage` or `secrets:admin` |
| `GET /vault/database/leases/:id` | One lease (the holder's, or any for those admins); never the password |
| `POST /vault/database/leases/:id/renew` `{incrementSeconds?}` | Moves the expiry by the increment (default the role's TTL), never past `maxExpiresAt` (`capped: true` when it reached it). The renewing caller's policy must still allow `read`. `410` once the lease ended |
| `POST /vault/database/leases/:id/revoke` | Drops the account at once: `{…, state: revoked}`. If the database refuses, `502` and the lease waits in `revoking` for the sweeper |

Generated names are `exai_<role>_<12 hex>` (at most 32 characters) and passwords are random; statements come from a
fixed set (`CREATE ROLE … LOGIN … VALID UNTIL`, `GRANT CONNECT/USAGE/SELECT…`, `ALTER ROLE … VALID UNTIL`, `REVOKE`,
`DROP ROLE`; `CREATE USER`, `GRANT … ON \`db\`.*`, `DROP USER`) with every identifier and literal quoted for the
dialect. PostgreSQL accounts carry `VALID UNTIL` the lease's expiry, so the login stops working at expiry even before
the sweeper runs; MySQL has no equivalent and relies on the sweeper. The sweeper (job `vault.leases.sweep`) claims each
lease past its expiry, ends its sessions where the admin may, revokes its grants and drops it; a drop the database
refuses leaves the lease `revoking` with `lastError` and `attempts`, retried with back-off (30 s doubling to an hour),
and the tenant's connection and tenant admins (and the engine's owner) are notified on the first failure.

Audit actions: `vault.database.engine.registered`, `.updated`, `.removed`, `.tested`, `.refused`,
`vault.database.role.saved`, `vault.database.role.removed`, `vault.database.lease.issued`, `.renewed`, `.revoked`,
`.expired`, `.revoke-failed`, `.failed`. None carries a password.

### `vault:` references (B-1705)

A `vault:<path>#<key>` reference names one key of the current version of a KV secret. It is accepted, beside the
existing `env:` and `file:` references, in:

- user stores: the LDAP bind password, the SQL store connection and the upstream OIDC client secret
  (`POST`/`PATCH /admin/identity-providers`, `POST /admin/federation/upstream`);
- data connections: the password (`POST /admin/connections`, `PUT /admin/connections/:id/credential`); the view
  shows `passwordFromVault: true`;
- MCP servers: the service token (`POST /admin/mcp-servers`, `PUT /admin/mcp-servers/:id/credential`);
- workflow HTTP steps: a header value that is a reference, optionally after `Bearer `, `Basic ` or `Token `. HTTP steps
  now also take an `Authorization` header, which must be a reference: a literal credential is refused at save (`400`);
- database engines: `adminPasswordRef` (above).

**At save**, the saving principal must hold `secrets:read`, their vault policy must allow `read` on `kv/<path>`, and
their clearance must reach the secret's label if it exists; otherwise `403` (`step: role`, `vault-policy` or
`clearance`), and a policy denial is audited as `vault.denied`. The saver becomes the object's reference owner.
**At use**, the reference is read as that owner (for workflow steps: as the run's principal) under their current
state, roles, policy and clearance, and audited as `vault.secret.read` with `actor.via` naming the object
(`identity-provider:<id>`, `connection:<id>`, `mcp-server:<id>`, `workflow:<id>`, `database-engine:<id>`). A reference
the owner can no longer read fails that use: a store reports an error and the chain moves on, a connection query is
`403` and audited as `connection.query.refused`, an MCP handshake fails, a workflow step fails without calling out.
Stores defined in the configuration file have no owner, so their `vault:` references do not resolve. Values never
appear in the audit chain, logs, graphs or step output.

### Rotation schedules (B-1706)

| Route | Notes |
| --- | --- |
| `PATCH /vault/kv/metadata/*path` `{…, rotationPeriodDays?: number\|null, owner?: userId\|null}` | A rotation schedule for the secret (null clears it); `owner` receives the notices (default the creator). The metadata view adds `rotationPeriodDays, rotatedAt, rotationDueAt, owner` |
| `PATCH /vault/transit/keys/:name` `{…, rotationPeriodDays?, autoRotate?, owner?}` | The same for a transit key; with `autoRotate` the key is rotated when it falls due. The key view adds `rotationPeriodDays, rotatedAt, rotationDueAt, owner, autoRotate` |

The job `vault.rotation.check` runs every `VAULT_ROTATION_CHECK_MINUTES` for tenants with schedules. A secret or key
whose current version falls due within `VAULT_ROTATION_NOTICE_DAYS` gets a `due` notice, and one past its period an
`overdue` notice: each once per version, as a notification (`kind: vault`, also by email when SMTP is set) to the
owner, or to the tenant admins when the owner is no longer active. Writing a new version or rotating the key starts
the schedule again. A key with `autoRotate` is rotated by the job instead (`vault.transit.key.rotated` with
`actor.service: vault.rotation` and `scheduled: true`) and the owner is told. Audit actions: `vault.rotation.due`,
`vault.rotation.overdue`.

## Sprint 25 (1.4.0): AT-Protocol trust (B-1608 to B-1611)

Each tenant may have its own service DID (`did:web` or `did:plc`); a tenant without one labels under the platform's,
the fallback. Keys are secp256k1 or P-256, made and used in the signer (`SIGNER_SOCKET`, both curves) or OpenBao
transit (`KMS_PROVIDER=openbao`, P-256 only: transit has no secp256k1 key type); without either, identity routes
answer `409` (`step: custody`). Rows hold the public key and the signer's wrapped blob or the transit key name, never
a private key. Signatures are ECDSA over SHA-256, compact r||s, folded to low-S. Errors are problem details; `step`
is `custody`, `identity` (no identity to sign with), `plc` (the directory refused or was unreachable, `502`),
`resolve` (`502`) or `document` (`422`).

A platform `did:web` is `did:web:<host of ATPROTO_PUBLIC_URL or PUBLIC_URL>`; a tenant's is `did:web:<its own host>`
when it names one, else `did:web:<base host>:atproto:<tenant slug>` with the labeler endpoint
`<base>/atproto/<slug>`. A `did:plc` is made by a genesis operation (DAG-CBOR, signed by its rotation key) submitted
to `ATPROTO_PLC_URL`; every key rotation is a further operation chained by `prev` (CIDv1 dag-cbor sha2-256) and signed
by the rotation key in force.

### Identities and keys (`pki:manage`; the platform's identity also `platform:manage` and a recent sign-in)

| Method and path | What it does |
| --- | --- |
| `GET /api/atproto` | `pki:manage` or `labels:manage`. `{custody: signer \| openbao \| null, curves, defaultCurve, plcUrl, base, identity, fallback}`: the tenant's own identity summary, or the platform's it falls back to |
| `GET /api/atproto/identity[?platform=true]` | `{id, platform, method, did, handle, host, endpoint, plcCid, state, keys: [{id, purpose: label \| rotation, curve, custody, didKey, state: active \| retired, createdAt, retiredAt}], document, createdAt, updatedAt}`. `document` is the DID document (`#atproto_label` Multikey, `#atproto_labeler` service). `404` without one |
| `POST /api/atproto/identity` `{platform?, method: web \| plc, handle?, host?, curve?: secp256k1 \| p256, rotationCurve?}` | B-1609. Makes the label key (and for `plc` the rotation key) in custody, then the DID. The handle defaults to the host (platform: the base host) when it is a valid domain; `host` is for tenants with their own name (`did:web:<host>`, served for requests with that `Host`). `curve` defaults to secp256k1 with the signer, P-256 with OpenBao; secp256k1 under OpenBao is `409`. For `plc`, the directory must accept the genesis operation (`502` otherwise, nothing stored). `409` when the tenant (or platform) has one, or the handle, host or path is taken. Audited `atproto.identity.created`. `201` |
| `POST /api/atproto/identity/rotate` `{platform?, purpose: label \| rotation, curve?}` | B-1608. A new key in custody; the old one is `retired`. A `did:web` document changes at once; a `did:plc` changes when the directory accepts the operation signed by the rotation key in force (a rotation key is replaced by an operation the old one signs). `rotation` on a `did:web` is `400`. Labels signed with a retired label key are signed again with the current one the next time they are served. Audited `atproto.key.rotated` (`plcCid`) |

### Labels (`labels:manage`)

A label is `{ver: 1, src, uri, cid?, val, neg, cts, exp?, sig}` signed over its DAG-CBOR without `sig` by the
identity's `#atproto_label` key, numbered with the identity's next `seq`. Values are lower-case letters, digits and
hyphens, optionally behind `!` (`!hide`, `!warn`). Guardrail decisions map as: `block` and `require-approval` to
`!hide`; `warn`, `flag` and `redact` to `!warn`; and each enforced finding's rule name and detail to categories
(`porn`, `sexual`, `nudity`, `graphic-media`, `spam`, `self-harm`, `hate`, `harassment`, `pii`, `secrets`).

| Method and path | What it does |
| --- | --- |
| `GET /api/atproto/labels[?uri&limit&before]` | The tenant's labels, newest first: `{labels: [{id, seq, flagId, createdAt, label}]}` (`label` in XRPC JSON form, `sig` as `{$bytes}`) |
| `POST /api/atproto/labels` `{uri, cid?, vals?: [val] \| flag?: "F-12", exp?}` | B-1610. Either explicit values or a flag's verdict (its rule action and name; a dismissed or approved flag is `409`; a flag above the caller's clearance is `404`). The subject is an `at://` URI, a DID or an https URL. Values already in force on the subject are not repeated. Audited `atproto.label.created` (subject as `subjectHash`). `201 {labels}` (`200` with none) |
| `POST /api/atproto/labels/negate` `{uri, val, reason?}` | A negation (`neg: true`, its own seq) of a label in force; `409` when none is. Audited `atproto.label.negated`. Dismissing or approving a flag negates the labels made from it (the hook an upheld appeal, B-1903, will call: `negateForFlag`) |

### Trusted external labelers (`labels:manage`)

| Method and path | What it does |
| --- | --- |
| `GET /api/atproto/labelers` | `{labelers: [{id, did, name, endpoint, didKey, workspaceId, vals, state: active \| paused, cursor, lastPullAt, lastError, received, rejected, createdAt, updatedAt}]}` |
| `POST /api/atproto/labelers` `{did, name, workspaceId?, vals?}` | B-1611. Resolves the DID (did:plc through `ATPROTO_PLC_URL`, did:web over https) through the service URL checks (B-901: metadata addresses always refused, link-local unless allowed), and records its `#atproto_label` key and `#atproto_labeler` endpoint (`422` without them). `vals` are the label values that become flags (default `!hide`, `!warn`, `porn`, `sexual`, `nudity`, `graphic-media`, `spam`). Audited `atproto.labeler.created`. `201` |
| `PATCH /api/atproto/labelers/:id` `{name?, workspaceId?, vals?, state?}`, `DELETE /api/atproto/labelers/:id` | Audited `atproto.labeler.updated`, `atproto.labeler.deleted`; `204` on delete |
| `GET /api/atproto/labelers/:id/labels[?limit]` | Verified labels received: `{labels: [{id, seq, uri, cid, val, neg, cts, exp, flagId, createdAt}]}` |
| `POST /api/atproto/labelers/:id/pull` | Queues an `atproto.labels.pull` job now. `202 {job}`. Audited `atproto.labeler.pulled` |

The pull job reads the labeler's `subscribeLabels` from its stored cursor (0 at first) until the stream is quiet,
verifies each label (`src` must be the labeler; the signature against its key, fetching the document again once when
it fails, for a rotated key), stores verified labels once, and raises a `report` flag (checkpoint `atproto-label`,
severity high for `!hide`, medium for `!warn`, else low) in the chosen workspace for each new one whose value is in
`vals`. A label that fails is dropped and audited `atproto.label.rejected` (`reason: signature | source | unsigned |
malformed`; at most 20 a pull, then one summary). Each pull with results is audited `atproto.labels.ingested`. Jobs
run every `ATPROTO_LABEL_PULL_MINUTES` per active labeler.

### Public (no session; `ATPROTO_PUBLIC_RATE_PER_MINUTE` per address, then `429`; `Access-Control-Allow-Origin: *`)

| Method and path | What it does |
| --- | --- |
| `GET /.well-known/did.json` | The `did:web` document of the identity for the request's `Host` (a tenant's own host, or the platform's on the base host), `application/did+json` |
| `GET /.well-known/atproto-did` | The DID whose handle is the request's host, `text/plain`; `404` otherwise |
| `GET /atproto/:key/did.json` | A tenant's path-form `did:web` document |
| `GET /xrpc/com.atproto.label.queryLabels`, `GET /atproto/:key/xrpc/com.atproto.label.queryLabels` `?uriPatterns=…&sources=…&limit=1-250 (50)&cursor` | The labels of the identity for the host (or path), in seq order: `{cursor?, labels}`. A pattern ending in `*` is a prefix; `*` alone matches everything. `sources` without this labeler's DID gives none. Errors are XRPC `{error: InvalidRequest \| NotFound, message}` |
| `WS /xrpc/com.atproto.label.subscribeLabels[?cursor]`, `WS /atproto/:key/xrpc/com.atproto.label.subscribeLabels` | An AT-Protocol event stream over a plain WebSocket: binary frames, each a DAG-CBOR header and body. `{op: 1, t: "#labels"}` `{seq, labels: [label]}`, one label per message in seq order; `{op: -1}` `{error: FutureCursor \| ConsumerTooSlow \| InvalidRequest \| InternalError, message}` then close. With a cursor, every label after it and then live; without, live only. New labels reach subscribers on every instance over the bus. At most `ATPROTO_SUBSCRIBERS_MAX` streams per instance (`503`), `429` past the rate limit |

Audit actions are in the event catalogue's `atproto.*` group.
