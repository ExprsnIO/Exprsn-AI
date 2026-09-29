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
