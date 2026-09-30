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
| `GET /admin/exports/:id/download` | The CSV (logged to audit) |

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

An entry: `{id, kind, name, version, description, impl: builtin|mcp|script|archive|agent, sideEffect, confirm,
ratePerHour, label, inputSchema, outputSchema, definition, status, schemaHash, approvedHash, checks: [{name, ok,
detail}], checksPassed, checkedAt, platform, owner, ownerId, submittedAt, reviewedBy, reviewedAt, reviewNote,
publishScope: tenant|workspace|platform, publishWorkspaces, replacement, createdAt, updatedAt}`. The checks: Required
fields, Schema valid (tools), Description quality, Side effect declared (tools; a name that suggests write or
destructive must declare at least that), Secrets scan, Referenced tools published (agents and skills), Limits within
workspace policy (agents: at most 100 steps, 200,000 tokens, 3,600 s).

A dispatcher outcome (harness, and each doing step of a run): `{name, arguments, ok, result?, error?, decision
(the tool-call guardrail's action), denied?, needsApproval?, valid (output schema), durationMs}`. Every call passes the
`tool-call` guardrail checkpoint with `meta: {tool, sideEffect, toolLabel, ceiling, confirm, impl}`.

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
| `GET /workflows/:id` | `{…, draft: graph, dirty, validation, limits, versions: [{version, state: published\|deprecated, note, publishedBy, publishedAt, graph}]}` |
| `PUT /workflows/:id/draft` `{graph?, rev?, description?, label?}` | Saves the draft; `rev` is the revision the editor loaded (`409` when someone saved since) |
| `POST /workflows/:id/validate` `{graph?}` | Validates the given graph (or the draft) without saving |
| `POST /workflows/:id/publish` `{note?}` | Publishes the draft as the next version; `422` with `errors` when it is invalid |
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
| `tool` | `{tool, args?}` | not available until the registry ships (publishing refuses it) |

Templates read `{{input.path}}` and `{{steps.<id>.path}}` of upstream steps; a template that is a single placeholder
keeps the value's type, and URL placeholders are percent-encoded. Validation errors are `{code: structure|cycle|config|
schema|label|limit|reference|unavailable|unreachable, message, nodeId?, edge?, expected?, actual?}`. Limits: 40 steps,
fan-out 10, 30 minutes per step, 2 hours and 200,000 tokens per run.

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
