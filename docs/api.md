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
| `POST /admin/pools/:id/instances` `{name, url, deploy: docker\|baremetal, tls?: {caFile, certFile, keyFile}, settings}` | Registers an Ollama endpoint; `settings`: `memoryBytes, hardware, node, device, parallel, maxLoaded, numCtx, kvCacheType, keepAlive`. Since 1.6.0 also `kind`, `socketPath`, `token`, `tokenRef` for Chat Completions servers (see Sprint 35a below) |
| `PATCH /admin/instances/:id` `{url?, tls?, settings?, state?: active\|disabled}`, `DELETE /admin/instances/:id` | Edits, removes. Since 1.6.0 also `socketPath`, `token`, `tokenRef` (Sprint 35a) |
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
| `POST /admin/models` `{name, source, expectedDigest?, license?: {name, url?, notes?}, label, notes?, poolId?}` | Import request. Pickle sources are refused (`422 Import refused`, `reason: pickle`); with `poolId` it is placed and pulled. Since 1.6.0 `{serverInstanceId, serverModel, …}` registers a model a server holds instead (Sprint 35a) |
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
| `POST /admin/classifiers` `{name, engine: linear\|guard\|llm\|vision, labels, profile?, instructions?, description?}` | A draft classifier with its own dataset. Since 1.6.0 also `vision`, which needs a `profile` (Sprint 36c below) |
| `GET /admin/classifiers/:id` | The classifier plus `versions` and `usage` |
| `PATCH /admin/classifiers/:id` `{thresholds?, profile?, instructions?, dataset?, description?}` | A new version |
| `POST /admin/classifiers/:id/publish` | `409 Eval set too small` below 200 labelled cases per label |
| `POST /admin/classifiers/:id/evaluate` | `202 {jobId}`: a `classifier.evaluate` job (`classify.batch` on the console) computes precision and recall per label over the dataset |
| `POST /admin/classifiers/:id/train` | `202 {jobId}`: trains a linear classifier on four fifths of the dataset and evaluates it on the rest |
| `POST /admin/classifiers/:id/samples` `{items: [{text, expected: <label>\|none, label?}]}` | Adds labelled cases (sealed): `201 {added, samples}`. Since 1.6.0 a vision classifier's cases are images: `{image (base64), expected, label?}` (Sprint 36c) |
| `PUT /admin/classifiers/:id/samples/image?expected=&label=` (body: the image) | 1.6.0, Sprint 36c: one image case of a vision classifier as a raw upload |
| `POST /classify` `{classifier, text, label?}` (`inference:invoke` or `classifiers:manage`) | Synchronous: `{classifier, version, labels, scores, hits, top: {label, score}, engine, ms, spans: [{kind, start, end, score}]}`; `503` when the model is unavailable. Since 1.6.0 a vision classifier takes `image` (base64) instead of `text` |
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

A graph: `{nodes: [{id, kind, title, x, y, config, input?, output?, ceiling?, raises?, timeoutMs?, retry?}], edges: [{from,
to, branch?: true|false|failure}], limits: {timeoutMs?, tokens?}}` (`retry` and `failure`: Sprint 32b, below). `input` and `output` are port schemas
`{type: string|number|integer|boolean|array|object|any, properties?, required?, items?}`. Step kinds:

| Kind | Config | Output |
| --- | --- | --- |
| `trigger` | `{source: manual\|api\|record\|schedule\|event, event?, cron?}` (`event` and `cron`: Sprint 32b, below) | the run input (checked against `output`) |
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
| `PATCH /knowledge/bases/:id` `{name?, description?, label?, reranker?, sharing?, status?: draft\|published, chunking?}` | Updates; a higher label floor applies to indexed chunks at once. Only published bases are used in chat. Since 1.6.0 also `visionProfile` and `imageClassifiers` (Sprint 36c below) |
| `DELETE /knowledge/bases/:id` | Deletes the base, its documents, chunks, vectors and stored files |
| `POST /knowledge/bases/:id/reindex` `{embedModel?}` | `202 index`: builds the next version beside the serving one by job (`knowledge.reindex`); the switch is one transaction, then the old index is dropped. `409` while one is building |
| `POST /knowledge/bases/:id/cancel-build` | Cancels the build and discards the partial index; the serving index is untouched |
| `GET /knowledge/bases/:id/access` | `[{id, kind: workspace\|user\|profile, principalId, name, access: read\|manage, createdBy, createdAt}]` |
| `POST /knowledge/bases/:id/access` `{kind, id, access}` | Shares with a workspace or user (read or manage), or attaches the base to a profile (read: retrieval in chat for that profile) |
| `DELETE /knowledge/bases/:id/access/:grant` | Removes a share |
| `POST /knowledge/bases/:id/sources` `{kind: upload\|s3\|git\|database, location, labelFloor?, schedule?: 15m\|hourly\|daily\|manual, ref?, path?, connectionId?, idColumn?, watermarkColumn?}` | Adds a source and queues its first sync. S3: `s3://bucket/prefix/`, read with the platform's S3 credentials. Git: an `https://` URL, cloned shallow by job. Database: `pg: schema.view` through a PostgreSQL connection, allow-listed, synced by watermark (`updated_at` by default); its floor is at least the connection's label |
| `POST /knowledge/sources/:id/sync` | `202 {jobId}` (`knowledge.sync`); unchanged documents are skipped by version (ETag, commit) or content hash |
| `DELETE /knowledge/sources/:id` | Removes the source and its documents from every index |
| `GET /knowledge/bases/:id/documents?q=` | `[document]` at or below the caller's clearance. Since 1.6.0 also `media`, `labels`, `labelsAll`, `minScore` (Sprint 36c) |
| `PUT /knowledge/bases/:id/uploads?name=<file>&label=<label>` (body: the file) | `202 document` in sealed quarantine; `knowledge.scan` detects the type from the bytes (text, Markdown, CSV, JSON, HTML, PDF, DOCX and, since 1.6.0, PNG, JPEG, WebP, GIF and HEIC) and runs ClamAV when configured, then indexing classifies and chunks it |
| `GET /knowledge/documents/:id` | `document` with `kb: {id, name}`; since 1.6.0 an image's description, labels and a document's image parts (Sprint 36c) |
| `PATCH /knowledge/documents/:id` `{label, reason?}` | Relabels: never below the classifier's finding or the floor (`409` naming the finding); chunks take the label at once |
| `POST /knowledge/documents/:id/reindex` | `202 {jobId}`: extraction and embedding again (retry after a failure); embeddings come from the cache where the text is unchanged |
| `DELETE /knowledge/documents/:id` | Removes it from every index; a synced document stays `removed` so the next sync does not bring it back |
| `POST /knowledge/search` `{kbIds, query, k?, rerank?}` | Test search as the caller: `{hits: [hit], ceiling, vectorSkipped, vectorStore}`. Since 1.6.0 also `labels: {any?, all?, minScore?}` (Sprint 36c) |
| `GET /knowledge/models` | `{embedding: [{name, label, state}], rerankers: [...]}`: approved models for the forms; since 1.6.0 also `visionProfiles` and `imageClassifiers` (Sprint 36c) |
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

#### Model-based memory management (1.5.0, Sprint 30: B-3701 to B-3703)

| Method and path | What it does |
| --- | --- |
| `GET /memory/settings` | `knowledge:manage`. `{profile, embedModel, effectiveEmbedModel, similarity, staleDays, reindex: {state: idle\|running\|done\|failed, model, jobId, done, total, error, startedAt, finishedAt}, updatedBy, updatedAt, embeddingModels: [{name, label, state}]}` for the tenant |
| `PUT /memory/settings` `{profile?: name\|null, embedModel?: name\|null, similarity?: 0.5-0.99, staleDays?: 1-3650\|null}` | `knowledge:manage`. `422` for a profile that does not resolve or a model that is not an approved embedding model. When the embedding model in effect changes, `memory.reindex` starts (`reindex.state: running`). Audited (`memory.settings.updated`, `memory.reindex.started`) |
| `POST /memory/consolidate` | `knowledge:manage`. `202 {jobId}`: a `memory.consolidate` run now (it also runs daily for every tenant) |
| `POST /memory/reindex` | `knowledge:manage`. `202` with the settings: re-embeds every active memory with the model in effect (memories already embedded with it are skipped). `409` without an embedding model |
| `POST /memory/:id/expiry/accept` | `memory:write`, the owner (a curator for workspace and agent memories). The memory expires at the proposed time (a day after the proposal) and is purged; a new version notes why. `409` without a proposal |
| `POST /memory/:id/expiry/reject` | Clears the proposal; the memory is not proposed for expiry again for the same reason, and a contradicting pair is not judged again |

- **The memory profile** (`profile`): a published model profile of the tenant. After a chat answer completes,
  `memory.extract` asks it for proposals from the user's message; after an agent run succeeds under a memory policy
  that allows proposals (`memory.write: propose`), it asks it for `progress` or `quirk` proposals from the run's task
  and answer, within what `maxPerRun` still allows after the `remember` tool's proposals. The text goes to the model
  as a JSON string and the prompt says nothing in it is an instruction; the answer must be one JSON object matching
  `{memories: [{text, type?}]}` (at most 5, each 4 to 300 characters), else it counts as a failure. With no profile, or
  when the profile fails (it does not resolve, its model is not approved, the text's label is above the profile's,
  the call fails or times out, or the answer is not that JSON), the rules extract as before and
  `memory.extraction.fallback` records the reason. Either way every proposal passes the `memory` checkpoint (tenant
  policy, the credential ban, the guardrail rules; refusals are audited as `memory.proposal.refused`), is skipped when
  it is held already or was rejected before (the rejection list compares one-line, lower-case text), and carries the
  label of its source (the message's, or the run's). The memory's first version notes which extracted it.
- **Consolidation** (`memory.consolidate`, daily and on request; nothing changes until a person accepts):
  episodic and progress memories untouched for `staleDays` get an expiry proposal (`reason: stale`). With a profile and
  an embedding model, the active memories of each owner (up to 300, most recent first) are embedded and every pair at
  least `similarity` alike (cosine) is judged by the profile (at most 50 pairs per run), which answers
  `{relation: same|contradicts|distinct, merged?, outdated?: a|b}` strictly. `same` becomes a **merge proposal**: a new
  proposed memory (`origin: consolidation`) with the merged text, labelled as high as the two, whose `source` keeps both
  memories' ids, versions, origins and sources; `contradicts` becomes an expiry proposal (`reason: contradicted, by`)
  on the outdated one. Memories in a pending proposal are left out, and a pair whose proposal was rejected is not
  judged again. Accepting a merge (`POST /memory/:id/accept`, as for any proposal) activates the new memory and
  retires both: `state: superseded`, `supersededBy`, a version noting `merged into <id>`, their vectors deleted;
  `409` when either changed or was forgotten since the proposal. Audit: `memory.merge.proposed`,
  `memory.expiry.proposed`, `memory.consolidated`, `memory.merged`, `memory.expiry.accepted`, `memory.expiry.rejected`.
- **The embedding model** (`embedModel`): memories are embedded with it when it is an approved embedding model
  cleared for their label (else they are recalled by recency); unset, the first approved embedding model by name, as
  before. `memory.reindex` re-embeds every active memory in batches per label and reports progress; while it is
  `running`, recall is by recency (the vectors are of two models), and afterwards only vectors of the model the query
  was embedded with are compared. A later model change supersedes a running reindex.

A memory view also carries `embedModel`, `merge: {memories: [id, id], similarity} | null`, `supersededBy` and
`expiryProposal: {expiresAt, reason: stale|contradicted, by, similarity, proposedAt} | null`; `origin` may be `agent` or
`consolidation`.

### Data connections (`connections:manage`)

| Method and path | What it does |
| --- | --- |
| `GET /admin/connections` | `[connection]` |
| `POST /admin/connections` `{name, engine: postgres\|mysql\|opensearch\|mongodb, endpoint, database?, zone, label, rowLimit, timeoutS, tls, username?, password?, baoRole?}` | Registers; the credential is sealed with the tenant key and never returned. With `baoRole` (PostgreSQL and MySQL; needs `OPENBAO_ADDR` and `OPENBAO_TOKEN`) no credential is stored: each instance takes a short-lived account from OpenBao's database engine (`GET <OPENBAO_DATABASE_MOUNT>/creds/<role>`), renews its lease while in use and revokes it when dropped. Once zones are defined, `422 step: zone` for a zone that is not defined and `403 step: zone` for the external zone or a label above the zone's ceiling (audited as `connection.register.refused`). Other engines are refused |
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
| `GET /knowledge/connections` | PostgreSQL, MySQL and MongoDB connections: `[{id, name, engine, label, objects, columns}]` |
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

### Event catalogue (`webhooks:manage`, `plugins:manage` or, since 1.5.0, `workflows:manage`)

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

## Sprint 26d (1.4.0): the file store (B-2401 to B-2405)

Workspace folders and files on the blob store. Members of a workspace read (`files:read`) and change (`files:write`)
its files within their clearance; members get both, tenant admins too. Every upload, new version and restored
version is quarantined: the bytes stream into the blob store sealed (64 KiB AES-GCM segments under a random key per
version, that key sealed with the tenant key), then the `file.scan` job detects the type from the bytes (text,
Markdown, CSV, JSON, HTML, PDF, Word, Excel, PowerPoint, PNG, JPEG, WebP, GIF), classifies text, scans with ClamAV
(`CLAMD_HOST`) and checks the label against the uploader's clearance and the workspace ceiling. Only a ready version
is served. Names are 1 to 255 characters without `/`, `\` or control characters, unique (case-insensitive) in their
folder. Every route answers `Cache-Control: no-store`.

### Folders, files and versions (B-2401)

| Route | Notes |
| --- | --- |
| `GET /files/browse?workspace=&folder=` | A folder's contents (the workspace root without `folder`): `{workspace, folder, path, folders, files}`; files above the caller's clearance are left out |
| `POST /files/folders` `{name, parentId?, workspaceId?}` | `201` with the folder; `409` if the name is taken |
| `PATCH /files/folders/:id` `{name?, parentId?}` | Rename or move within the workspace (not into itself) |
| `DELETE /files/folders/:id` | Puts the folder in the trash with everything in it: `{…folder, files, folders}` |
| `PUT /files/uploads?name=&label=&folder=&workspace=` | The raw body is the file, streamed (never buffered). `202` with the file (`state: pending`) and `version {number: 1, state: quarantined}`. `413` above `FILES_MAX_BYTES` or over a storage quota (checked while the bytes arrive) |
| `GET /files/:id` | The file: `{id, name, workspaceId, folderId, ownerId, ownerName, label, state: pending\|ready\|rejected, size, type, currentVersion, tags, access: workspace\|shared, preview: queued\|ready\|failed\|unavailable\|null, …}`; shared readers too |
| `PATCH /files/:id` `{name?, folderId?}` | Rename or move within the workspace |
| `PUT /files/:id/tags` `{tags}` | Up to 20 lower-case tags |
| `DELETE /files/:id` | To the trash (`purgeAfter` is `FILES_TRASH_DAYS` later) |
| `GET /files/:id/content` | The current version, streamed and audited (`file.downloaded`), as an attachment with `Content-Security-Policy: sandbox`, `nosniff` and the name escaped in `Content-Disposition` (`filename` and `filename*`). `409` while no version is ready |
| `PUT /files/:id/content?label=` | A new version (raw body, as an upload): `202`; it becomes current when its scan passes |
| `GET /files/:id/versions` | Every version, newest first: `{number, state, size, sha256, type, label, reason, findings, restoredFrom, createdBy, createdAt, scannedAt}` (members of the file's workspace) |
| `GET /files/:id/versions/:n/content` | An older ready version, audited |
| `POST /files/:id/versions/:n/restore` | Writes version `n`'s content again as a new version, which goes through quarantine and is **scanned again**: `202` |
| `GET /files/trash?workspace=` | What was put in the trash on its own (folders and files), within clearance |
| `POST /files/trash/restore` `{kind: file\|folder, id}` | Restores it with what went with it, to the workspace root when its folder is gone; a clashing name gets ` (2)`. `409` for something that went with a folder |
| `POST /files/trash/empty` `{workspaceId?}` | Purges the workspace's trash now: `202 {jobId}`. The `files.purge` job also runs every `FILES_PURGE_MINUTES` for what passed its purge date |

Events (catalogue group `file.*`, now emitted): `file.uploaded` (version 1 passed quarantine), `file.updated` (a later
version), `file.restored` (`from`), `file.deleted` (to the trash), `file.shared` (`with`). Audit actions:
`file.upload.received`, `file.version.ready`, `file.version.rejected`, `file.version.restore.requested`,
`file.downloaded`, `file.changed`, `file.tags.updated`, `file.trashed`, `file.untrashed`, `file.purged`,
`file.trash.emptied`, `file.folder.created`, `.updated`, `.trashed`, `.untrashed`, `file.share.created`,
`file.share.revoked`, `file.quota.updated`. The owner's sockets get `file.state` when a version is ready or rejected.

### Sharing (B-2402)

Read-only: a shared reader downloads the current version and its preview, nothing else.

| Route | Notes |
| --- | --- |
| `GET /files/:id/shares` | `[{id, kind, userId, userName, group, workspaceId, workspaceName, anonymous, expiresAt, maxUses, uses, state: active\|revoked\|expired\|used up, …}]` |
| `POST /files/:id/shares` `{kind: user, userId}` \| `{kind: group, group}` \| `{kind: workspace, workspaceId}` \| `{kind: link, expiresInHours?, maxUses?, anonymous?}` | `201`. A user must be cleared for the file's label, a workspace's ceiling must cover it; a group is a directory group (as the reader's identities carried it at sign-in or sync). A link answers with `token` (`exf_…`) **once**; it is stored as an HMAC. Anonymous links need the tenant's anonymous-link setting (`PUT /admin/tenants/:tid/sharing`, shared with conversations), a `public` file and a lifetime within the tenant's maximum |
| `DELETE /files/:id/shares/:shareId` | Revokes at once (`204`) |
| `GET /files/shared` | Files shared with the caller (directly, through a workspace or a group), live shares only, within clearance |
| `POST /file-links/open` `{token}` | Signed in, same tenant, cleared: `{name, size, type, label, expiresAt, usesLeft}`; does not use the link. Every other case is the same `404` |
| `POST /file-links/download` `{token}` | Signed in: takes one use atomically and streams the file (sandboxed, audited with the address). **A link past its use limit, expired or revoked is refused** with the same `404` as an unknown token |
| `POST /api/public/file-links/download` `{token}` | Anonymous (no session, no cookie; `SHARE_ANONYMOUS_PER_MINUTE` per address): only an anonymous link to a file that is `public` now, while the tenant allows anonymous links. No metadata route |

### Quotas and usage (B-2403)

Stored and quarantined versions count (trash too, until purged; previews do not).

| Route | Notes |
| --- | --- |
| `GET /files/usage?workspace=` | `{workspace: {usedBytes, maxBytes, files}, tenant: {…}, maxUploadBytes, trashDays}` (`files:read`) |
| `GET /admin/usage/storage` | Storage per tenant and workspace (`usage:read`) |
| `PUT /admin/tenants/:tid/file-quota` `{maxBytes \| null}` | The tenant total (`tenant:manage`, system admins only) |
| `PUT /admin/tenants/:tid/workspaces/:wid/file-quota` `{maxBytes \| null}` | A workspace's limit (`tenant:manage`), at most the tenant total. **An upload over either limit is refused** with `413 {limit: storage_bytes, scope, used, max, incoming}` |

### Previews (B-2404)

| Route | Notes |
| --- | --- |
| `GET /files/:id/preview` | A PNG of an image or a PDF's first page, drawn by the `file.preview` job (ffmpeg, `pdftoppm`), sealed like the original, served with the media sandbox headers (B-413); with `MEDIA_ORIGIN`, a `302` to a signed URL on the media origin. `409` while it is drawn, `404` when there is none (`unavailable` without the tool, or above `FILES_PREVIEW_MAX_BYTES`) |

### Search and folders as knowledge sources (B-2405)

| Route | Notes |
| --- | --- |
| `GET /files/search?q=&tag=&workspace=` | Ready files in the caller's workspaces whose name contains `q` (`%` and `_` literal) and that carry every `tag` (repeatable), within clearance; at most 100 |
| `POST /knowledge/bases/:id/sources` `{kind: folder, location: <folder id>}` | A folder (and its subfolders) the curator can read becomes a source (`location` shows `folder: <name>`). Each sync indexes its ready files of a knowledge type up to the base's label, named by their path below the folder; chat cites them like any document |

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
`groups.read`, `posts.write` (live since 1.5.0, B-3904: they act as the user who installed the plugin; see Sprint 32c
below). The handler's output and return value go to the
plugin's log.

| Route | Notes |
| --- | --- |
| `POST /plugin-broker/v1/calls/:api` | Outside `/api`, no session: `Authorization: Bearer xpt_…` only. The same broker for a sandbox that can reach the server. `200` with the call's result; `401` (unknown, expired or revoked token), `403` (not granted, or the plugin is no longer enabled), `404` (no such call), `429` (`PLUGIN_MAX_CALLS`), `400` (a domain call's arguments) |

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

## Sprint 25a (1.4.0): ACME server, certificate export, renewal and the pki CLI (B-1605 to B-1607)

Each tenant can open an RFC 8555 ACME directory at `/pki/acme/<tenant slug>/directory`. Its orders are issued by the
tenant's active intermediate under one server profile: the profile's allowed names are the upper bound of what may be
ordered, and each name must also be proven by http-01 or dns-01 before it is issued (domain-control validation;
`docs/pki.md` explains the mapping). Certificates issued here also have export, renewal and expiry notices.

### Admin (`pki:manage`)

| Method and path | What it does |
| --- | --- |
| `GET /api/pki/acme` | `{enabled, profileId, eabRequired, challenges: [http-01, dns-01], directoryUrl, updatedAt}` for the session's tenant |
| `PUT /api/pki/acme` `{enabled?, profileId?, eabRequired?, challenges?}` | B-1605. Opens or closes the tenant's directory, names the server profile its orders are issued under (`422` for a client or code-signing profile, or when opening without one), requires external account binding, and chooses the challenge types offered (wildcards need `dns-01`). Audited `pki.acme.settings.updated` |
| `GET /api/pki/acme/eab-keys` | `{keys: [{id, name, state: active\|bound\|revoked, accountId, createdAt, boundAt}]}` (never the MAC key) |
| `POST /api/pki/acme/eab-keys` `{name}` | An external account binding key (RFC 8555 7.3.4). `201 {id, kid, hmacKey, …}`: `hmacKey` (base64url, 32 bytes) is shown once and kept sealed with the tenant key. A key binds one account. Audited `pki.acme.eab.created` |
| `POST /api/pki/acme/eab-keys/:id/revoke` | The key can no longer bind an account (an account it bound stays). Audited `pki.acme.eab.revoked` |
| `GET /api/pki/acme/accounts` | `{accounts: [{id, thumbprint, keyType: EC\|RSA\|OKP, contact, status: valid\|deactivated\|revoked, eabKeyId, createdAt, updatedAt}]}` |
| `POST /api/pki/acme/accounts/:id/revoke` | The account is `revoked` (RFC 8555: by the server); its pending and ready orders become invalid. Audited `pki.acme.account.revoked` |
| `GET /api/pki/acme/orders[?accountId&status&limit]` | `{orders: [{id, accountId, status, identifiers, profileId, expiresAt, error, certificateId, createdAt, updatedAt}]}` |
| `POST /api/pki/issuers/:id/issue` `{profileId, generateKey: {keyType?: ec-p256\|ec-p384\|rsa-2048\|rsa-3072\|rsa-4096, password}, sans?, commonName?, days?}` | B-1606. Instead of a `csr`: the key is made here, put with the certificate and its chain into a PKCS#12 file under `password` (8 to 200 characters), returned once as `pkcs12` (base64) and never stored. Audited `pki.certificate.issued` with `keyGenerated: true` |
| `GET /api/pki/certificates/:id/export?format=pem\|der\|chain` | B-1606. The certificate as PEM (`application/x-pem-file`), DER (`application/pkix-cert`), or with its chain up to the root (`application/pem-certificate-chain`), as an attachment |
| `POST /api/pki/certificates/:id/pkcs12` `{password}` | The certificate and its chain as PKCS#12 (`application/x-pkcs12`): PBES2 with PBKDF2-HMAC-SHA256 (100,000 iterations) and AES-256-CBC, HMAC-SHA256 integrity. No private key (the CA never had it) |
| `POST /api/pki/certificates/:id/renew` `{csr?, days?, revokeOld?}` | B-1606. A new certificate for the same names under the same profile, from the tenant's active intermediate, for the CSR's key or (without one) the old certificate's key; `renewedFrom` names the old one, which is revoked as `superseded` with `revokeOld`. `409` for a revoked certificate. Audited `pki.certificate.renewed`. `201` |

Certificates now also carry `renewedFrom` and `acmeAccountId`. Audit actions: `pki.acme.settings.updated`,
`pki.acme.eab.created`, `pki.acme.eab.revoked`, `pki.acme.eab.refused`, `pki.acme.account.created`,
`pki.acme.account.updated`, `pki.acme.account.deactivated`, `pki.acme.account.key-changed`, `pki.acme.account.revoked`,
`pki.acme.order.created`, `pki.acme.order.refused`, `pki.acme.authz.deactivated`, `pki.acme.challenge.valid`,
`pki.acme.challenge.invalid`, `pki.acme.order.finalized`, `pki.acme.certificate.revoked`, `pki.certificate.renewed`,
`pki.certificate.expiry.notified` (ACME actions are recorded as actor `{service: acme, name: account <id>}`). Jobs:
`pki.acme.validate` (one per challenge response) and `pki.expiry` (every `PKI_EXPIRY_SWEEP_MINUTES`: expiry notices
and ACME housekeeping).

Expiry notices (B-1606): each valid certificate `PKI_EXPIRY_NOTICE_DAYS` (30 and 7) days from expiry notifies its owner
once per threshold (notification kind `pki.certificate.expiring`, also by email when SMTP is set): the user who
requested it, or for certificates without one (ACME, CLI) the tenant's holders of `pki:manage`. A certificate that has
a valid renewal is skipped.

### ACME (public; no session; `PKI_PUBLIC_RATE_PER_MINUTE` per address, and `PKI_ACME_RATE_PER_MINUTE` for writes)

All under `/pki/acme/<tenant slug>/`. A closed or unknown directory answers `404` with an ACME problem. Every answer
carries a fresh `Replay-Nonce`, `Link: <directory>;rel="index"` and `Cache-Control: no-store`; errors are
`application/problem+json` with `type: urn:ietf:params:acme:error:<type>`. POST bodies are flattened JWS
(`application/jose+json`, at most 64 KiB, `415` otherwise) signed with ES256, ES384, RS256 (2048 to 8192 bits) or
EdDSA (Ed25519); the protected header's `url` must be the URL posted to (`unauthorized`), the nonce must be fresh and
unused on any instance (`badNonce`, nonces last `PKI_ACME_NONCE_MINUTES`), and `kid` must be an account of this
directory (`accountDoesNotExist`). Every object is looked up by tenant and owning account: another account's (or
tenant's) order, authorization, challenge or certificate is `404`.

| Method and path | What it does |
| --- | --- |
| `GET /pki/acme/:tenant/directory` | `{newNonce, newAccount, newOrder, revokeCert, keyChange, meta: {externalAccountRequired, website}}` |
| `HEAD /pki/acme/:tenant/new-nonce`, `GET /pki/acme/:tenant/new-nonce` | `200` (HEAD) or `204` with a `Replay-Nonce` |
| `POST /pki/acme/:tenant/new-account` (jwk) | `{contact?: [mailto:…] (at most 5), termsOfServiceAgreed?, onlyReturnExisting?, externalAccountBinding?}`. `201` with `Location` (the `kid`); the key's existing account is `200`. `externalAccountRequired` when the tenant requires a binding; the binding is an HS256 JWS over the account JWK with this directory's newAccount URL and a key from `POST /api/pki/acme/eab-keys` (`unauthorized` for a bad MAC, audited, or a used or revoked key) |
| `POST /pki/acme/:tenant/acct/:id` | POST-as-GET: `{status, contact, orders, createdAt}`; `{contact}` updates it; `{status: deactivated}` ends it (its open orders become invalid) |
| `POST /pki/acme/:tenant/acct/:id/orders` | `{orders: [order URLs]}`: the account's unexpired orders that are not invalid |
| `POST /pki/acme/:tenant/key-change` | RFC 8555 7.3.5: the payload is a JWS signed by the new key (jwk, no nonce, the same url) with `{account, oldKey}`. `409` with `Location` when another account uses the new key |
| `POST /pki/acme/:tenant/new-order` | `{identifiers: [{type: dns, value}]}` (1 to 100; `notBefore` and `notAfter` are refused, the profile sets the lifetime). Each name must be allowed by the directory's profile (`rejectedIdentifier` with a subproblem per name; IP and other types `unsupportedIdentifier`); a wildcard needs `allowWildcard` and dns-01. At most 300 open orders per account (`rateLimited`). `201` with `Location`: `{status: pending, expires, identifiers, authorizations, finalize}`; orders last `PKI_ACME_ORDER_HOURS` |
| `POST /pki/acme/:tenant/order/:id` | POST-as-GET: the order; `certificate` once valid, `error` when invalid |
| `POST /pki/acme/:tenant/authz/:id` | POST-as-GET: `{identifier, status, expires, challenges, wildcard?}`; `{status: deactivated}` deactivates it (and invalidates its order) |
| `POST /pki/acme/:tenant/chall/:id` | `{}` starts validation (a `pki.acme.validate` job) and answers `processing` with `Link: <authz>;rel="up"`; POST-as-GET reads it. http-01 fetches `http://<name>:PKI_ACME_HTTP_PORT/.well-known/acme-challenge/<token>` (up to three redirects, to http on that port or https on 443; 8 KiB; trailing whitespace ignored) through the service address checks; dns-01 looks up TXT at `_acme-challenge.<name>` (PKI_ACME_DNS_SERVERS or the system resolver) for base64url(SHA-256(key authorization)). A failure (`incorrectResponse`, `connection`, `dns`, `unauthorized`) makes the challenge, the authorization and the order invalid |
| `POST /pki/acme/:tenant/order/:id/finalize` | `{csr}` (base64url DER). The order must be `ready` (`orderNotReady`); the CSR must name exactly the order's names (subjectAltName and CN) with a key type the profile accepts, not the account key (`badCSR`). Issued at once by the tenant's active intermediate; the order is `valid` with `certificate`, or `invalid` with the reason |
| `POST /pki/acme/:tenant/cert/:id` | POST-as-GET by the ordering account: `application/pem-certificate-chain`, the certificate and the intermediate (the root comes from trust stores) |
| `POST /pki/acme/:tenant/revoke-cert` | `{certificate (base64url DER), reason?: 0\|1\|3\|4\|5\|9}` signed by the ordering account, by an account holding valid authorizations for all its names, or by the certificate's key (jwk). `badRevocationReason`, `alreadyRevoked`; `404` for a certificate this directory did not issue |

### CLI

`exprsn-ai pki issuers | list | issue | revoke | crl` for `--tenant <slug>` (default `DEFAULT_TENANT`), through the same
service as the routes and audited with actor `service: cli`: `issue --csr <file> --profile <name|id> [--san
dns:<name>]… [--days] [--out <file>]` (from the tenant's active intermediate), `revoke <id | serial> [--reason]`
(queues the next CRL), `list [--state] [--issuer] [--limit] [--json]`, `crl [--issuer <id>] [--out <file>] [--der]`
(signs the next CRL now). Exit codes: 0 done, 1 refused or failed, 3 conflict (already revoked, no active
intermediate), 64 usage. See `docs/pki.md`.

## Sprint 26b (1.4.0): AT-Protocol accounts (B-1807, B-1808)

A user binds their own AT-Protocol DID (`did:plc` or `did:web`), and a tenant may sign people in with their
AT-Protocol accounts. Handles are resolved by the DNS TXT record `_atproto.<handle>` (`did=<did>`) and then
`https://<handle>/.well-known/atproto-did`; DID documents through `ATPROTO_PLC_URL` or over https. Every fetch goes
through the service URL checks (B-901): the address dialled is the address checked, so a handle, PDS or authorization
server that resolves to a link-local or cloud metadata address is refused (`422`, `step: handle`, `reason: refused`)
and never fetched. A handle counts for a DID only when the DID document names it back (`alsoKnownAs: at://<handle>`).
Errors are problem details with `step` (`handle`, `did`, `did_document`, `pds`, `challenge`, `proof`,
`authorization_server`, `par`, `provider`) and, for handles, `reason` (`syntax`, `refused`, `not_found`, `conflict`,
`mismatch`).

### The signed-in user's DID (`atproto:link`, a browser session)

| Method and path | What it does |
| --- | --- |
| `GET /api/me/atproto` | `{binding: {id, did, verified, proof: profile \| oauth \| null, handle, handleCheckedAt, pds, challengePending, challengeExpiresAt, verifiedAt, createdAt, updatedAt} \| null}` |
| `POST /api/me/atproto/claim` `{account}` | Recent sign-in. `account` is a handle or a DID. Resolves it (handle → DID → document → PDS) and issues a challenge `exprsn-ai-verify-<32 hex>`, valid 24 hours, shown once and stored as a SHA-256. Replaces the user's earlier claim. `409` when the DID is bound to another user of the tenant. Audited `atproto.did.claimed`. `201 {binding, challenge: {token, expiresAt, instructions}}` |
| `POST /api/me/atproto/verify` `{}` | Reads the account's `app.bsky.actor.profile` record (`rkey: self`) from its own PDS (`com.atproto.repo.getRecord`); its description must contain the challenge. On success the DID is bound (`proof: profile`), the challenge is used up and the handle the document names is checked both ways. `409` without an open challenge or when the token is not there (audited `atproto.did.verify_failed`). Audited `atproto.did.verified` |
| `POST /api/me/atproto/link` `{account}` | Recent sign-in. Starts the AT-Protocol OAuth flow below in "link" mode and sets the federation cookie; `{url}` is where the console sends the browser. The callback binds the DID to this user (`proof: oauth`) if the session that started it is still signed in, then redirects to `/#/settings?atproto=linked`. Audited `atproto.did.link_started`, then `atproto.did.verified` |
| `PUT /api/me/atproto/handle` `{handle}` | The handle shown for the bound DID: it must resolve to that DID and be named by its document (`422`, `reason: mismatch`). Audited `atproto.handle.set` |
| `DELETE /api/me/atproto` | Removes the claim or binding. Audited `atproto.did.removed`. `204` |

### Identity admins (`identity:manage`)

| Method and path | What it does |
| --- | --- |
| `GET /api/admin/atproto/accounts[?verified=true\|false&limit&offset]` | The tenant's claims and bindings with `userId` and `username` |
| `POST /api/admin/atproto/accounts/check` `{account}` | Resolves a handle or DID step by step (account, then its PDS's authorization server and that server's metadata): `{ok, steps: [{title, ok, ms, detail}], did?, handle?, pds?, issuer?}`. Audited `atproto.account.checked` |
| `DELETE /api/admin/atproto/accounts/:id` | Removes a user's binding. Audited `atproto.did.removed`. `204` |

### The `atproto` user store (B-1808)

A user store of kind `atproto` (`POST /api/admin/identity-providers`, config `{defaultRoles?, defaultClearance?,
boundOnly?: false, authServers?: [origin]}`) adds AT-Protocol sign-in to the tenant's chain. It takes no passwords
and has no directory. A DID bound to a user (above) signs in as that user, with the roles they have; any other account
is provisioned (just in time) with the verified handle as its username (or the DID with `:` made `-` when it has no
valid handle) and its DID as its only group, so group mappings name DIDs. `boundOnly` refuses unbound DIDs
(`auth.login.refused`, `reason: not_bound`); `authServers` limits the authorization servers accepted. Admin roles still
need their second factor. "Test connection" checks the client metadata address and the client assertion key.
`GET /api/auth/sign-in-options` lists the store with `protocol: atproto`.

### Public (no session; sign-in pages throttled per address like the other federation pages)

| Method and path | What it does |
| --- | --- |
| `GET /federation/atproto/client-metadata.json` | The OAuth client metadata document; its URL is the `client_id`. `{client_id, client_name, client_uri, application_type: web, grant_types: [authorization_code, refresh_token], response_types: [code], redirect_uris: [<issuer>/federation/atproto/callback], scope: atproto, token_endpoint_auth_method: private_key_jwt, token_endpoint_auth_signing_alg: ES256, jwks_uri: <issuer>/.well-known/jwks.json, dpop_bound_access_tokens: true}` |
| `GET /federation/atproto/start?provider=<store id>[&handle=<handle or DID>][&return]` | Without `handle`, a page asking for it. With it: resolves the account, reads the PDS's protected-resource metadata (exactly one authorization server) and that server's metadata (issuer, PAR, S256, ES256 DPoP, `iss` response parameter, `private_key_jwt`, the `atproto` scope), sends a pushed authorization request with PKCE S256, `login_hint` and a DPoP proof from a P-256 key made for this sign-in (retried once with the server's `DPoP-Nonce` after `use_dpop_nonce`), client-authenticated by a JWT the tenant's ES256 OIDC key signs, and redirects to the authorization endpoint with only `client_id` and `request_uri`. The state is bound to the browser by the federation cookie |
| `GET /federation/atproto/callback?code&state&iss` | `iss` must be the authorization server the request went to; the code is exchanged with PKCE and DPoP (nonce retry as above). The token must be `token_type: DPoP` with the `atproto` scope and a DID `sub` equal to the account asked for; that DID's own PDS must name the same authorization server, and `com.atproto.server.getSession` at the PDS with the token (DPoP proof with `ath` and the resource server's nonce) must answer for the same DID. The tokens are then revoked (best effort) and never stored. Sign-in continues as for upstream OIDC (JIT provisioning, second factor for admin roles, sign-in notices, `auth.login` with `kind: atproto`). Other tenants' paths are under `/t/<slug>/` |

## Sprint 26c (1.4.0): moderation actions and appeals (B-1901 to B-1907)

Moderation is built on the guardrails and the flag queue (`/api/flags`), not beside them: every check, report and
provider verdict ends in a guard flag, and reviewers keep working the queue there. Objects are named by `{type, id}`.
Types are registered by their domain (`GET /api/moderation/types`): today `conversation`, `message`,
`knowledge-document`, `media-asset` and `image`; later domains (posts, files, records, group content) register their
own. A registered type resolves the object's tenant, workspace, label, owner and state, and can hide it (state
`hidden`: a hidden message is shown to nobody, its owner included, and left out of model context, shares and `/v1`; a
hidden document is left out of search and retrieval; hidden media and images cannot be downloaded) and restore it
(compare-and-set on the state it had). Objects outside the caller's workspaces are `404`. Problem details carry
`step`: `type` (no such type, `422`), `text`, `clearance`, `independence`, `sanction`, `self`, `role`, `disabled`,
`zone`, `url`.

### Checks (`moderation:check`)

| Method and path | What it does |
| --- | --- |
| `GET /api/moderation/types` | `moderation:check` or `moderation:report`. `{items: [{type, description, hide, text}]}` |
| `POST /api/moderation/check` `{type, id, text?, workspaceId?, label?, checkpoint?, subject?, apply?}` | B-1901. Runs the guardrail engine on the object at `checkpoint` (default `user-input`): the text is the object's own (opened from its sealed form) unless given; a type nobody registered needs `text` and takes `workspaceId` (one the caller may use; default the current one) and `label`. A verdict of `flag` or worse files one flag per object: a second check finds the open flag (`flag.created: false`), and a dismissed flag is not raised again while the text is unchanged; two checks at once make one flag. A `block` hides a registered object that can be hidden (unless `apply: false`). With `subject` (an `at://` URI or DID) and a verdict of `warn` or worse, the tenant's labeler signs labels for it tied to the flag (`labels`, or `labelError` when there is no identity). Enabled external providers get a job each (`providers: [{id, mode, jobId}]`). `200 {object: {type, id, workspaceId, label, registered}, verdict: {action, reason, findings}, flag: {id, ref, state, severity, queueId, dueAt, created} \| null, action \| null, labels, providers}`. A new flag is audited `moderation.flagged`, a hide `moderation.action.applied` |
| `POST /api/moderation/batch` `{items: [check body]}` | B-1901. Up to 100 checks in order; an item that fails is `{ok: false, object, status, detail}` and the rest go on. `200 {items: [{ok, …check result}], flagged}` |

### Reports (`moderation:report`, held by members)

| Method and path | What it does |
| --- | --- |
| `POST /api/moderation/reports` `{type, id, reason, note?, severity?: high \| medium \| low}` | B-1902. Only a registered type, and only an object the reporter can see (a message in their own conversation, or a reviewer in its workspace; a knowledge document in a base they can read; media and images their own or in their workspace), within clearance; otherwise `404`. Files a `report` flag (a `reviewer` flag from a reviewer) in the object's workspace, checkpoint `user-report`, routed like any flag. The same reporter reporting the same object while their flag is open gets it back (`200 {duplicate: true}`). Audited `moderation.reported`. `201 {duplicate: false, flag: {id, ref, severity, dueAt, workspaceId, queueId}}` |

### Actions and appeals

| Method and path | What it does |
| --- | --- |
| `POST /api/moderation/flags/:ref/action` `{action: hide, reason}` | `moderation:review`. B-1903. Hides the object behind an open or confirmed flag (an open one is confirmed first); flags that point at no registered object are `409`. The owner is notified. Audited `moderation.action.applied`. `201 {flag, action}` |
| `GET /api/moderation/actions[?type&id&ownerId]` | `moderation:review`. `{items: [{id, objectType, objectId, workspaceId, ownerId, flagId, action, state: applied \| reversed, source: reviewer \| guardrail \| provider, createdBy, reason, createdAt, reversedBy, reversedAt, appealId}]}` |
| `GET /api/moderation/mine` | `moderation:appeal`. The caller's own `{sanctions, actions, appeals}` |
| `POST /api/moderation/appeals` `{actionId \| sanctionId, statement, forUserId?}` | `moderation:appeal` or `moderation:review`. B-1903. The owner of a hidden object, or a sanctioned user, appeals; a reviewer may record the appeal for someone who cannot sign in (`forUserId`). One open appeal per action or sanction (`409`). The statement is sealed. Audited `moderation.appeal.submitted`. `201 {id, ref: "A-3", kind: action \| sanction, actionId, sanctionId, flagId, workspaceId, label, restricted, userId, filedBy, statement, state: pending, …}` |
| `GET /api/moderation/appeals[?state]` | `moderation:review`. Appeals in the reviewer's workspaces (without statements) |
| `GET /api/moderation/appeals/:ref` | The appellant, or a reviewer in its workspace; the statement is withheld above the reviewer's clearance |
| `POST /api/moderation/appeals/:ref/review` | `moderation:review`. Claims it (`reviewing`). Neither the appellant nor whoever took the decision under appeal may review it (`403`, `step: independence`), nor anyone below its label. Audited `moderation.appeal.reviewing` |
| `POST /api/moderation/appeals/:ref/decide` `{decision: upheld \| denied, note?}` | `moderation:review`, same independence rules; while someone else reviews it, `409`. Upheld, for an action: the object is restored to its previous state (`moderation.action.reversed`), its flag reopened with a fresh timer (event `flag.reopened`) and the AT-Protocol labels made from the flag negated (`atproto.label.negated`); for a sanction: it ends as `reversed`. Audited `moderation.appeal.upheld` or `moderation.appeal.denied` with the effects. `200 {appeal, effects: {restored, flagReopened, labelsNegated} \| {sanctionEnded}}` |

### Sanctions (`moderation:sanction`, a browser session with a recent sign-in)

A `suspend` or `ban` keeps the user out: it revokes their sessions at once (their sockets close over the bus), no new
session is made for them however they sign in, and every request with any credential (session, API key, OAuth token)
is `403` (`step: sanction`, `sanction`, `until`). Background work run as them (schedules, plugins) stops. A `warn` only
notifies. The sweep (`MODERATION_SWEEP_SECONDS`) ends sanctions whose time is up (`expired`).

| Method and path | What it does |
| --- | --- |
| `GET /api/moderation/sanctions[?userId&state]` | `{items: [{id, userId, kind, reason, flagId, state: active \| expired \| lifted \| reversed, startsAt, endsAt, createdBy, createdAt, endedBy, endedAt, endReason}]}` |
| `POST /api/moderation/sanctions` `{userId, kind: warn \| suspend \| ban, durationMinutes?, reason, flag?}` | B-1904. A suspension needs a duration; a ban without one lasts until lifted. Not yourself; an administrator (a role that requires MFA) only by a tenant admin, a system admin only by a system admin. The user is notified (B-1907). Audited `moderation.sanction.created` (`sessionsRevoked`). Refused sign-ins are audited `moderation.signin.refused`. `201` |
| `POST /api/moderation/sanctions/:id/lift` `{reason?}` | Ends an active sanction (`lifted`). Audited `moderation.sanction.lifted` |

### Review queues and the dead-letter queue

| Method and path | What it does |
| --- | --- |
| `GET /api/moderation/queues` | `moderation:review` or `moderation:manage`. `{items: [{id, name, workspaceId, rules, labels, kinds, priority, slaMinutes, escalateTo, escalationSlaMinutes, enabled, createdAt, updatedAt}]}` |
| `POST /api/moderation/queues` `{name, workspaceId?, rules?, labels?, kinds?, priority?, slaMinutes, escalateTo: workspace \| tenant \| platform, escalationSlaMinutes?, enabled?}` | `moderation:manage`. B-1905. A new flag goes to the first enabled queue (lowest `priority`) whose workspace, rules (rule ids or names), labels and kinds (flag kind, object type or checkpoint) all match; its timer becomes the queue's SLA. The sweep escalates a routed flag past its timer to `escalateTo` with a fresh `escalationSlaMinutes` timer and notifies that level (event `flag.escalated`, audit `moderation.queue.escalated`). `409` for a name in use. Audited `moderation.queue.created` |
| `PATCH /api/moderation/queues/:id`, `DELETE /api/moderation/queues/:id` | `moderation:manage`. Audited `moderation.queue.updated`, `moderation.queue.deleted` (its flags become unrouted); `204` on delete |
| `GET /api/moderation/queues/:id/flags` | `moderation:review`. `{queue, open, overdue, escalated, items: [flag as in /api/flags, queueId, escalatedAt, object]}`, the flags the reviewer may work. Since 1.5.0 `object` is `{type, id, hideable}` (whether "Hide object" applies), or null for a flag above the reviewer's clearance or without an object |
| `GET /api/moderation/dead-letters[?state]` | `moderation:manage`. Moderation jobs (`moderation.provider`) that failed their last attempt: `{items: [{id, jobId, type, error, attempts, state: open \| redriven, failedAt, redrivenBy, redrivenAt, redriveJobId}]}`. Audited `moderation.job.dead_lettered` when one lands |
| `POST /api/moderation/dead-letters/:id/redrive` | `moderation:manage`. Queues the job again with its payload (texts in it stay sealed); `409` when already redriven. Audited `moderation.job.redriven`. `201 {…, jobId}` |

### External providers (`moderation:manage`)

Off unless `MODERATION_EXTERNAL_PROVIDERS` is set (`403`, `step: disabled`), and each provider only in a zone whose
egress reaches outside the site (an allow-list with a public range or the external zone; never with
`ZONES_AIR_GAPPED`; `403`, `step: zone`). A provider is created disabled and in `shadow`. When enabled, each check of a
type it takes queues a `moderation.provider` job (the text sealed in the payload): `shadow` records the verdict and does
nothing else; `enforce` files (or reuses) the object's flag on a flagged verdict, hides a registered object and audits
`moderation.provider.enforced`. A failed call retries, then lands in the dead-letter queue. Wire formats: `json`
(`POST {input, type}` → `{flagged, score?, categories?}`) and `openai` (the OpenAI moderation shape); the key goes as
`Authorization: Bearer` and is stored sealed, never shown. Connections go through the service address checks.

| Method and path | What it does |
| --- | --- |
| `GET /api/moderation/providers` | `{items: [{id, name, kind, url, hasSecret, zone, mode, enabled, objectTypes, threshold, createdAt, updatedAt}], enabled}` |
| `POST /api/moderation/providers` `{name, kind?: json \| openai, url, secret?, zone, mode?: shadow \| enforce, enabled?, objectTypes?, threshold?}` | B-1906. The URL passes the service URL checks (`422`, `step: url`). Audited `moderation.provider.created` (host only). `201` |
| `PATCH /api/moderation/providers/:id`, `DELETE /api/moderation/providers/:id` | The zone is checked again on every change. Audited `moderation.provider.updated`, `moderation.provider.deleted`; `204` on delete |
| `GET /api/moderation/providers/:id/verdicts` | `{items: [{id, objectType, objectId, mode, flagged, categories, score, acted, flagId, latencyMs, createdAt}]}` |

### Notices (B-1907)

The person concerned is notified in the console and by email (template `moderation-notice`, escaped like the other
templates, without the moderated content): an action on something of theirs, a sanction (issued, ended, lifted), an
appeal received and decided.

## Sprint 26a (1.4.0): identity gaps (B-1801 to B-1805) and the secrets and users CLI (B-2103)

Self-registration, email verification, invitations by workspace admins, the tenant MFA policy with trusted devices,
GitHub sign-in and CSV imports. Every route below answers `Cache-Control: no-store`. New permission: `members:invite`
(tenant admins and identity admins).

### Sign-up, verification and invitation links (public, under `/api/auth`, behind the sign-in limiter)

| Method and path | What it does |
| --- | --- |
| `POST /api/auth/register` `{tenant?, username, displayName, email, password}` | B-1801. Creates a local account under the tenant's signup policy: `403 {reason: closed}` while sign-up is closed (the default), `403 {reason: domain}` for an email domain outside the list (both audited `user.signup.refused`); `409` (the same answer for a taken username or address); `503` when verification is required and email is not configured. The password passes the policy and breached checks. `201 {username, tenant, state: active\|pending, verification: sent\|not_required, detail}`. With `approval` the account is created disabled (`pending`) and tenant and identity admins get a console notice. Throttled per address (`SIGNUP_PER_HOUR`) and per email (3 an hour). Audited `user.signup.created` |
| `POST /api/auth/email/verify` `{token}` | B-1802. Redeems a verification link (single use, `EMAIL_VERIFY_HOURS`, bound to the address it was sent to): `{verified: true, username, tenant}`; `400 Invalid link` otherwise. Audited `user.email.verified` |
| `POST /api/auth/email/resend` `{tenant?, identifier}` | B-1802. A new link for a local account whose address is not proven yet. `202` with the same answer whether or not such an account exists; throttled per address and identifier (`PASSWORD_RESET_PER_HOUR`) and per account (3 an hour, silently) |
| `POST /api/auth/invitations/preview` `{token}` | B-1801. `{tenant {slug, name}, workspace {id, name}\|null, invitedBy, email, roles, clearance, expiresAt}`; `400 Invalid link` for an unknown, used, withdrawn or expired invitation |
| `POST /api/auth/invitations/accept` `{token, username, displayName, password}` | B-1801. Creates a local account for the invited address (verified by the link), with the invitation's roles and clearance, in its workspace; it does not depend on the signup policy. `409` when an account has that address (accept as that account instead) or the username is taken. `201 {username, tenant}`. Audited `user.created` (`via: invitation`) and `user.invitation.accepted` |

Links are console links with the token in the fragment, like reset links: `#/signin?verify=<token>` and
`#/signin?invitation=<token>` (plus `&tenant=<slug>` outside the default tenant). Tokens are 256-bit random values,
stored as SHA-256.

`POST /api/auth/login` now also answers `403 {reason: signup_pending}` or `{reason: signup_rejected}` (after the right
password) for a sign-up waiting for or refused approval, and `403 {reason: email_unverified}` when the tenant requires
verified addresses and the local account has an unproven one (a new link is sent, throttled; audited
`auth.login.refused`). Its session body carries `mfa.enrolBy` during an MFA grace period and `mfa.trustedDevice: true`
when the second factor was skipped. `POST /api/auth/mfa/totp`, `/mfa/recovery` and `/mfa/webauthn` take
`rememberDevice: true` (not for recovery codes) and then answer `trustedDevice: {until}` (or `null` when the tenant
allows no trusted devices). `GET /api/auth/sign-in-options` adds `signup: false | {approval, verifyEmail}`.
Since Sprint 30 (B-3413) the session body at the `mfa` stage also carries `mfa.trustedDeviceDays`: the tenant's
period, or `0` when the account may not have a trusted device (admin roles, accounts marked as needing a factor), so the
sign-in page offers "trust this browser" only when it applies. `GET /api/me` adds `user.email` and `user.emailVerified`.

### Invitations by workspace admins (`members:invite`)

| Method and path | What it does |
| --- | --- |
| `GET /api/invitations[?state=pending\|accepted\|revoked]` | Tenant admins see every invitation, other inviters their own (within their clearance): `[{id, email, workspaceId, roles, clearance, invitedBy, state: pending\|accepted\|revoked\|expired, createdAt, expiresAt, acceptedBy, acceptedAt, revokedAt}]` |
| `POST /api/invitations` `{email, workspaceId?, roles, clearance?}` | Every role must be one the inviter may grant (`403 step: role`), the clearance at most theirs (`step: clearance`); without `tenant:manage` the workspace must be one the inviter belongs to (`step: workspace`). Needs SMTP (`409`). Replaces a pending invitation for the same address and workspace. Valid for `INVITATION_DAYS`. `201` with the invitation and `sent`. Audited `user.invitation.created` |
| `DELETE /api/invitations/:id` | The inviter or a tenant admin withdraws a pending invitation. `204`. Audited `user.invitation.revoked` |
| `POST /api/me/invitations/accept` `{token}` | The signed-in account accepts (its address must be the invited one, `403 step: email`): the roles are added to its direct roles, the clearance raised to the invitation's if lower, the workspace joined; the address counts as verified. Audited `user.invitation.accepted` |

### The account's own verification and trusted devices

| Method and path | What it does |
| --- | --- |
| `POST /api/me/email/verify` | Sends a verification link to the account's own unproven address (`202 {verified: false, sent}`); `{verified: true}` when it is proven; `403` for directory accounts or no address |
| `GET /api/me/trusted-devices` | `{periodDays, thisDevice, devices: [{browser, createdAt, expiresAt}]}` |
| `DELETE /api/me/trusted-devices` | Forgets every trusted device of the account: `{removed}`. Audited `auth.trusted_device.removed` |

### Tenant identity policy (`identity:manage`) and sign-ups (`users:manage`)

| Method and path | What it does |
| --- | --- |
| `GET /api/admin/identity-policy` | `{signup, mfa: {…, effectiveAt}, updatedBy, updatedAt}` |
| `PUT /api/admin/identity-policy/signup` `{mode: closed\|open\|approval, domains?, requireEmailVerification?, roles?, clearance?, workspaceId?}` | B-1801, B-1802. `domains` (up to 200): exact domains or `*.example.com` for subdomains; empty allows any. `roles`: `member`, `flag-reviewer`, `knowledge-curator` only. `clearance` at most the caller's. `requireEmailVerification` (default off) also covers other local accounts with an unproven address; accounts created by an admin, imported, or from an invitation count as proven. Audited `identity.signup_policy.updated` |
| `PUT /api/admin/identity-policy/mfa` `{require: off\|all\|roles, roles?, graceDays?, trustedDeviceDays?}` | B-1803. A second factor for everyone or for listed roles, on top of the roles that always need one. An account the requirement covers may sign in without a factor until `graceDays` after the requirement last widened (or after its creation, if later), then enrols first. `trustedDeviceDays` (0 to 90, default 0) lets a browser skip the factor after "trust this device"; shortening it ends older trust at once. `{…, effectiveAt}`. Audited `identity.mfa_policy.updated` (`graceRestarted` when the requirement widened) |
| `GET /api/admin/signups[?state=pending\|approved\|rejected\|active]` | `[{userId, username, displayName, email, emailVerified, domain, state, createdAt, decidedBy, decidedAt, reason}]` |
| `POST /api/admin/signups/:userId/approve`, `…/reject` `{reason?}` | Approval activates the account; rejection keeps it disabled. `409` once decided. The user is told by email. Audited `user.signup.approved`, `user.signup.rejected` |

Trusted devices are keyed by a digest of the user and the B-801 device cookie, and end when their period ends, when
the user's sessions are revoked (sign out everywhere, a password change or reset, an admin's factor reset, a disabled
account, a revoked tenant), when that session is revoked on purpose (`DELETE /api/me/sessions/:id`,
`DELETE /api/admin/sessions/:id`; a plain sign-out keeps it), or when the tenant shortens the period. A session that
skipped the factor counts as factor-verified (method `…, trusted device`). Upstream (OIDC, SAML, GitHub) and Kerberos
sign-ins follow the same policy.

### GitHub sign-in (B-1804)

A user store of kind `github` (`POST /api/admin/identity-providers`, `identity:manage`) with config
`{clientId, clientSecret (secret reference), webUrl? (https://github.com), apiUrl? (https://api.github.com),
allowedOrgs?, scopes? (read:user user:email read:org), defaultRoles?, defaultClearance?}`. Both URLs pass the service
URL checks (B-901) when saved (`400 {reason: service_url}`, e.g. a metadata or link-local address) and at every
connection. Register the OAuth app's callback as `<issuer>/federation/github/callback`.

| Method and path | What it does |
| --- | --- |
| `GET /federation/github/start?provider=<id>` (and `/t/<slug>/…`) | Redirects to GitHub's authorize page with a single-use `state` bound to the browser (`exai_fed` cookie) and PKCE (S256) |
| `GET /federation/github/callback?code&state` | Exchanges the code, reads `/user`, `/user/emails` (only a verified primary address is kept), `/user/orgs` and `/user/teams` (up to 500 each), then signs in like an upstream OIDC store: JIT provisioning linked by the numeric GitHub id, roles from group mappings, MFA policy. Organisations become groups `org` and teams `org/team-slug`; with `allowedOrgs` an account outside them is refused and other organisations' groups are dropped. The access token is never stored |

The store appears in `GET /api/auth/sign-in-options` and `GET /api/admin/federation/upstream` (`protocol: github`), and
"Test connection" checks the addresses, the API and the client secret reference.

### CSV imports of users, memberships and group mappings (B-1805, `users:manage`)

| Method and path | What it does |
| --- | --- |
| `POST /api/admin/user-imports[?dryRun=true][&sendInvites=true]` (body: the CSV, `Content-Type: text/csv`, at most `USER_IMPORT_MAX_BYTES`, `USER_IMPORT_MAX_ROWS` rows) | Stores the CSV sealed with the tenant key and queues job `users.import` (run as the submitter's current roles and clearance). `202 {id, jobId, dryRun}`. A malformed file is `400` at once. Audited `user.import.requested` or `user.import.dry_run` |
| `GET /api/admin/user-imports` | The tenant's last 100 imports without their reports |
| `GET /api/admin/user-imports/:id` | `{id, state: queued\|running\|done\|failed, dryRun, rows, summary {rows, create, update, unchanged, conflict, error, applied, dryRun}, report: [{row, kind, key, action: create\|update\|unchanged\|conflict\|error, detail, changes?, outcome?}], …}` |

The CSV has a header row; columns `kind,username,display_name,email,roles,clearance,workspace,provider,group` (any
order, unknown columns refused). `kind=user` creates a local account (roles separated by `;`; a password nobody knows,
or with `sendInvites` an invitation link) or updates a local account's name, address, direct roles and clearance (and
then ends its sessions); an account linked to another store, a username or address used twice or by another account
is a `conflict`. `kind=membership` adds a direct membership (`workspace` by slug or id). `kind=mapping` adds a group
mapping (`roles` holds one role; `provider` a store name or id, empty for any) or changes its clearance. Every row is
checked like the API (roles the importer may grant, clearance at or below theirs, accounts whose roles they may
manage). The plan only reads; a dry run reports it and changes nothing. A real run applies the accepted rows (accounts,
then mappings, then memberships), auditing each change (`user.created`, `user.updated`, `user.invited`,
`workspace.member.added`, `identity.mapping.created`, `identity.mapping.updated`, with `via: import`), then
`user.import.completed` or `user.import.dry_run_reported`.

### CLI

- `exprsn-ai secrets <command> --as <username> [--tenant <slug>]`: `kv list [<prefix>] [--json]`,
  `kv get <path> [--version] [--field]`, `kv put <path> <key>=<value>|<key>=@<file>… [--cas] [--label]`,
  `transit encrypt <key> --plaintext <text> [--base64] [--context]`, `transit decrypt <key> <ciphertext> [--base64]
  [--context]`, `policy explain <path> --capability <cap> [--group | --workspace]`. Through the vault service under
  the named account's roles (`secrets:read`, `secrets:write`), policy subjects and clearance; audited with actor
  `{service: cli, user, username, via: cli}` (values never). `policy explain` is audited `vault.policy.explained`.
- `exprsn-ai users import <file.csv> [--dry-run] [--send-invites] [--tenant <slug>] [--json]`: the same import, in the
  process, as the operator (no role ceiling, like `admin:create`); prints the report. Exit codes: 0 done, 1 refused or
  failed, 3 conflicts or errors in the file, 64 usage.

## Sprint 27 (1.4.0): AT-Protocol firehose ingest (B-1908)

A tenant subscribes to a Jetstream (JSON over WebSocket, cursor `time_us`) or a relay's
`com.atproto.sync.subscribeRepos` (DAG-CBOR frames with records in CAR blocks, cursor `seq`). Each record operation that
passes the filters (a collection on the allow-list, an author on the DID allow-list when there is one, and a
deterministic sample by the record's `at://` URI) and has text (a post's text and image alt text; names and descriptions
for other records) goes through the moderation check (B-1901) as an `atproto-post` object, checkpoint `user-input`,
with the subscription's workspace and label: a verdict of flag or worse raises the post's one flag in that workspace's
queue, and a verdict of warn or worse becomes signed labels on the post's URI from the tenant's labeler (B-1610; the
platform's when the tenant has none). Deletes and records without text advance the cursor and are not checked.
Since 1.5.0 (B-3604) a subscribeRepos commit is believed only when it verifies against the repo's DID key (see
[Sprint 31](#sprint-31-150-custom-feed-generators-b-3001-to-b-3003-and-relay-commit-verification-b-3604)); posts that pass
the check also go on to the tenant's feed generators.

The consumer runs on one worker instance at a time: every `FIREHOSE_TICK_MS` each instance claims or renews a lease on
the running subscriptions, and only the holder connects (a lease lasts three ticks; a stopping instance gives its leases
back at once). Messages are handled in order from a bounded queue; when `FIREHOSE_QUEUE_MAX` wait, the socket is paused
until half have been handled. The cursor (the last message handled) is stored every `FIREHOSE_CHECKPOINT_MS` and when
the consumer stops; a restart connects with `?cursor=<stored>` and skips messages at or before it. A disconnect, an
error frame (`{op: -1}`, shown as `lastError`) or `FIREHOSE_IDLE_MS` without a message reconnects from the cursor with
backoff (500 ms doubling, up to `FIREHOSE_BACKOFF_MAX_MS`). The endpoint is a service URL (B-901): checked when saved and
at every connection. Metrics: `exprsn_firehose_events_total{result}`, `exprsn_firehose_reconnects_total`,
`exprsn_firehose_pauses_total`, and per subscription `exprsn_firehose_queue_depth`, `exprsn_firehose_connected`,
`exprsn_firehose_paused`, `exprsn_firehose_lag_seconds`.

### Subscriptions (`firehose:manage`)

A subscription is `{id, name, protocol: jetstream | subscribe-repos, endpoint, collections, dids, sampleRate, workspaceId,
label, state: running | stopped, status: idle | waiting | connecting | streaming | backoff | error, held, cursor,
cursorAt, lastEventAt, lastError, counts: {received, checked, flagged, labelled, failed, rejected}, reconnects, rev, live,
createdAt, updatedAt}`. `held` says whether an instance holds its lease now (`waiting`: running but not yet taken);
`live` is `{connected, paused, queue, pauses, cursor}` when the instance answering is the holder, else null. Counts are
stored with the cursor. Subscriptions labelled above the caller's clearance are not shown (`404`).

| Method and path | What it does |
| --- | --- |
| `GET /api/atproto/firehose` | `{subscriptions: [subscription]}` |
| `POST /api/atproto/firehose` `{name, protocol, endpoint, collections?, dids?, sampleRate?, workspaceId?, label?, start?}` | B-1908. `endpoint` is `wss://`, `ws://`, `https://` or `http://` (dialled as WebSocket); for Jetstream a bare host gets `/subscribe`, for subscribeRepos the path gets `/xrpc/com.atproto.sync.subscribeRepos`. `collections` are NSIDs or `prefix.*` (default `[app.bsky.feed.post]`, at most 100); `dids` up to 10,000 `did:plc` or `did:web` authors (null: everyone; Jetstream also receives both lists as `wantedCollections` and `wantedDids`); `sampleRate` in (0, 1] (default 1); `label` defaults to `public` (`403` above the caller's clearance). A refused endpoint is `400` with `step: endpoint`; a name in use or more than `FIREHOSE_MAX_PER_TENANT` subscriptions `409`. Stopped unless `start: true`. Audited `atproto.firehose.created`. `201` |
| `GET /api/atproto/firehose/:id` | The subscription and its status |
| `PATCH /api/atproto/firehose/:id` `{name?, protocol?, endpoint?, collections?, dids?, sampleRate?, workspaceId?, label?, cursor?: null}` | Changes move `rev`; a running consumer restarts with them from its cursor. `cursor: null` starts again from live, only once the subscription is stopped and no instance holds it (`409` otherwise); changing the protocol needs it (a cursor of one means nothing to the other). Audited `atproto.firehose.updated` |
| `DELETE /api/atproto/firehose/:id` | The holder stops at its next tick. Audited `atproto.firehose.deleted`. `204` |
| `POST /api/atproto/firehose/:id/start`, `POST /api/atproto/firehose/:id/stop` `{}` | Sets what the admin wants; the instances act on it at once over the bus (a stop stores the cursor and gives the lease back). Audited `atproto.firehose.started`, `atproto.firehose.stopped` |

Audit actions are in the event catalogue's `atproto.*` group.

## Sprint 27b (1.4.0): low-code data apps (B-2201 to B-2208)

An app belongs to a tenant, and to one of its workspaces unless it is tenant-wide (`workspaceId: null`); members of
that workspace (every tenant member for a tenant-wide app) see it within their clearance, others get `404`. The app's
label is the highest label its records may carry; an entity's label is its records' default and lowest one. Reading
apps and records needs `records:read`, writing records `records:write` (both held by members); designing apps,
entities, forms and triggers, and exports, imports and drafts, `apps:design` (workflow admins and tenant admins).
`:app` is an app's id or name (the current workspace's app first, then a tenant-wide one), `:entity` and `:form` an id
or name within the app. Record values are sealed with the tenant key; fields marked `indexed` (or `unique`) are also
kept in a clear index, and only those can be filtered, sorted, searched and aggregated (`docs/security.md`). Every
change is audited (`app.*`); record changes are also emitted as `record.created`, `record.updated` (with `fields`),
`record.deleted` and `record.transitioned` (with `from`, `to`), fire the entity's triggers, and queue the AI fill.

Field types (`definition.fields[]`, each `{name, type, title?, description?, required?, indexed?, unique?}`):
`string` (`maxLength` (≤ 255 when indexed or unique), `minLength`, `pattern` (RE2), `multiline`), `number` (`min`,
`max`, `integer`), `boolean`, `date` (`YYYY-MM-DD`, or with `withTime` an ISO date and time with a zone), `enum`
(`options: [{value, label?}]`), `reference` (`entity`: a record of another entity of the app), `lookup` (`source`:
`static` with `options`, `entity` with `entity` and `display`, `user`, `workspace`), `file` (a file-store id the writer
can read), `json` (`maxBytes`), `formula` (`expression`, computed on write from the entity's other fields; functions
`if`, `coalesce`, `isblank`, `concat`, `upper`, `lower`, `trim`, `len`, `left`, `right`, `mid`, `contains`,
`replace`, `round`, `floor`, `ceil`, `abs`, `min`, `max`, `sum`, `number`, `text`, `today`, `now`, `year`, `month`,
`day`, `add_days`, `days_between`; operators `+ - * / % & = != < <= > >= and or not`; no other names), `ai`
(`profile`, `prompt` with `{{field}}` placeholders, `maxLength`: filled by the `apps.ai-fill` job, failing soft).
`definition.states` (optional): `{initial, states: [{name, title?}], transitions: [{name?, from: [state | "*"], to,
roles?}]}`; a new record starts in `initial`, and only listed transitions are allowed. Names reserved for record
properties (`id`, `state`, `label`, `version`, timestamps) cannot be field names.

A record is `{id, app, entity, label, state, values, version, source: api | form | import | workflow, aiState:
pending | filled | failed | null, aiError, createdBy, updatedBy, createdAt, updatedAt}`. Filters are `{field, op,
value}` with `op` one of `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in` (a list of up to 100), `contains`, `startsWith`,
`exists` (`value: false` for missing), combined with `{and: […]}`, `{or: […]}` and `{not: …}` (at most 4 levels and 30
conditions); text compares lower-cased, `ne` and `not` include records without the value; system fields `id`,
`state`, `createdAt`, `updatedAt`, `createdBy` can be used too. Sorts are `[{field, dir: asc | desc}]` (at most 3),
empty values last, then the record id. Invalid values answer `400` with `problems: [{field, message}]`; a duplicate
unique value `409` with `field`; a stale `version` `409`.

### Apps and entities

| Method and path | What it does |
| --- | --- |
| `GET /api/apps` | `records:read`. `{apps: [{id, name, title, description, label, workspaceId, scope, createdBy, updatedBy, createdAt, updatedAt}]}`: the apps the caller can see |
| `POST /api/apps` `{name, title?, description?, label?, workspaceId?}` | `apps:design`. B-2201. `workspaceId` defaults to the current workspace; `null` makes the app tenant-wide. The label must clear the caller and fit the workspace ceiling. Names are unique per workspace (and tenant-wide). Audited `app.created`. `201` app |
| `GET /api/apps/:app` | `records:read`. The app with `entities` (`{id, name, title, label, definition, rev}`), `forms`, and for designers `triggers` |
| `PATCH /api/apps/:app` `{title?, description?, label?}` | `apps:design`. Lowering the label is refused while entities or records are above it. Audited `app.updated` |
| `DELETE /api/apps/:app` | `apps:design`. Deletes the app with its entities, records, forms, triggers and transfers. Audited `app.deleted` with counts. `204` |
| `POST /api/apps/:app/entities` `{name, title?, label?, definition}` | `apps:design`. B-2201, B-2203, B-2204. The definition is checked whole (names, formulas, references to the app's entities, AI prompt placeholders, state machine, roles); the first problem is the `detail`, all are in `problems`. Audited `app.entity.created`. `201` entity |
| `GET /api/apps/:app/entities/:entity` | `records:read`. The entity |
| `PATCH /api/apps/:app/entities/:entity` `{title?, label?, definition?, rev?}` | `apps:design`. With records present, a field's type cannot change, an existing field cannot become unique, and a state a record holds cannot be removed (`409`). A change to the indexed, unique or formula fields reindexes every record in the `apps.reindex` job (`reindexJob`). Audited `app.entity.updated` |
| `DELETE /api/apps/:app/entities/:entity` | `apps:design`. Refused while another entity refers to it; deletes its records, forms and triggers. Audited `app.entity.deleted`. `204` |
| `GET /api/apps/:app/entities/:entity/fields/:field/options?q=&limit=` | `records:read`. B-2203: the options of an enum or lookup field, or the records a reference may point to (`{value: id, label: title field}`), users of the tenant (`user` lookups), the caller's workspaces (`workspace` lookups). `{options: [{value, label}]}` |

### Records (B-2202)

| Method and path | What it does |
| --- | --- |
| `GET /api/apps/:app/entities/:entity/records?filter=<json>&sort=field:dir,…&q=&limit=&offset=&cursor=` | `records:read`. The records the caller is cleared for (hidden ones left out). `{total, limit, offset, nextCursor, records}` |
| `POST /api/apps/:app/entities/:entity/records/query` `{filter?, sort?, q?, limit?, offset?, cursor?}` | `records:read`. The same as a body. `q` searches the indexed text fields (lower-cased, `%` and `_` literal). `limit` ≤ 200, `offset` ≤ 100,000. B-3601 (1.5.0): `nextCursor` is an opaque cursor for the page after this one (`null` on the last); send it back as `cursor`, with the same `filter`, `sort` and `q`, for the next page (keyset paging: each page costs the same however deep, and records written meanwhile do not shift it). A cursor made for another sort, or a cursor with an `offset`, is `400`; `offset` keeps working as before. `total` counts every match on every page |
| `POST /api/apps/:app/entities/:entity/records/aggregate` `{filter?, q?, groupBy?, metrics: [{op: count} \| {op: sum \| avg \| min \| max, field}]}` | `records:read`. Groups by an indexed field or `state`; metrics over indexed number, date and boolean fields. `{groupBy, metrics, groups: [{key, values}]}`, ordered by key with empty last, at most 1000 groups |
| `POST /api/apps/:app/entities/:entity/records` `{values, label?}` | `records:write`. Values are validated (unknown and computed fields refused), formulas computed, references, lookups and files checked against what the writer may see, then sealed; unique values are claimed in the same transaction. The label is between the entity's and the app's and within the caller's clearance. Audited `app.record.created`; `record.created`. `201` record |
| `POST /api/apps/:app/entities/:entity/records/bulk` `{create?: [{values, label?}], update?: [{id, values, version?}], delete?: [id]}` | `records:write`. Up to `APPS_BULK_MAX` operations, all validated and sealed first and written in one transaction: any problem (a duplicate, a stale version) writes nothing and names the operation (`op`, `index`). Audited once, `app.records.bulk`; one event per record. `{created, updated, deleted}` |
| `POST /api/apps/:app/entities/:entity/records/import` `{csv, dryRun?}` | `records:write`. A CSV whose header names fields (and optionally `label`; `id`, `state` and timestamps are ignored), at most `APPS_IMPORT_MAX_BYTES` and `APPS_IMPORT_MAX_ROWS`; an unknown column is `400`. Runs as the `apps.import` job: each row is a record of its own, so bad rows are reported (`report: [{row, problem}]`, up to 500) and the rest written; a dry run only validates (uniqueness too). The sealed CSV is dropped once the job has run. Audited `app.records.import.queued`, then `app.records.imported` or `app.records.import.checked`. `202 {id, jobId}` |
| `POST /api/apps/:app/entities/:entity/records/export` `{filter?, q?, sort?}` | `records:read`. Runs as the `apps.export` job, as the caller, with what they may read when it runs: a CSV (`id, state, label, createdAt, updatedAt`, then every field; cells starting with `= + - @` are prefixed with `'`) sealed into the blob store, at most `APPS_EXPORT_MAX_ROWS` records. Audited `app.records.export.queued`, `app.records.exported`. `202 {id, jobId}` |
| `GET /api/apps/transfers/:id` | `records:read`. An import or export the caller started (designers see all): `{id, kind, state, dryRun, summary, report, error, jobId, createdAt, finishedAt, download}` |
| `GET /api/apps/transfers/:id/download` | `records:read`. The export's CSV (`text/csv`, attachment), only for the person who asked and within their clearance. Audited `app.records.downloaded` |
| `GET /api/apps/:app/entities/:entity/records/:id` | `records:read`. The record |
| `PATCH /api/apps/:app/entities/:entity/records/:id` `{values, version?}` | `records:write`. Changes the fields given (`null` empties one); `version` guards against overwriting a newer write. Audited `app.record.updated` with the changed `fields`; `record.updated`. A change to an AI field's inputs clears it until the fill job runs again |
| `DELETE /api/apps/:app/entities/:entity/records/:id` | `records:write`. Audited `app.record.deleted`; `record.deleted`. `204` |
| `POST /api/apps/:app/entities/:entity/records/:id/transition` `{to, version?, note?}` | `records:write`. B-2204. Moves the record along a transition its entity lists (and, when the transition names `roles`, only for holders of one). An illegal transition is `409 Illegal transition` with `from`, `to` and `allowed`. Audited `app.record.transitioned`; `record.transitioned` |

### Forms (B-2205)

A form lists an entity's fields in order: `definition: {fields: [{field, required?, label?, help?, visibleIf?: {field,
op: eq | ne | in | truthy | falsy, value?}}], submitLabel?, successMessage?}`; a condition reads a field earlier on the
form, and the form must ask for every field the entity requires. On every submission the server keeps only the fields
the form lists and shows given the earlier answers; anything else is dropped (and counted in the audit), never written.
Every text value passes the `user-input` guardrail checkpoint: a block or a hold refuses the submission (`422`), a
redaction is written redacted.

| Method and path | What it does |
| --- | --- |
| `GET /api/apps/:app/forms` | `records:read`. `{forms: [{id, name, title, entity, definition, public, ratePerMinute, createdAt, updatedAt}]}` |
| `POST /api/apps/:app/forms` `{name, title?, entity, definition, ratePerMinute?}` | `apps:design`. Audited `app.form.created`. `201` form |
| `GET /api/apps/:app/forms/:form` | `records:read`. The form and `shown`: what it shows (each field's label, type, options, limits, condition) |
| `PATCH /api/apps/:app/forms/:form` `{title?, definition?, ratePerMinute?}` | `apps:design`. Audited `app.form.updated` |
| `DELETE /api/apps/:app/forms/:form` | `apps:design`. Audited `app.form.deleted`. `204` |
| `POST /api/apps/:app/forms/:form/public` `{enabled}` | `apps:design`. Makes the form public with a new link token, shown once (`exa_…`; an older link stops working), or private again. A public form cannot ask for files, references or user, workspace or record lookups. Audited `app.form.published`, `app.form.link.rotated`, `app.form.unpublished`. `{public, token}` |
| `POST /api/apps/:app/forms/:form/submit` `{values}` | `records:write`. A signed-in submission: a record with `source: form`. Audited `app.form.submitted` (and `app.record.created`). `201 {id, dropped}` |

Public (no session, at `/api/public`, `X-Robots-Tag: noindex`; the token travels in the body):

| Method and path | What it does |
| --- | --- |
| `POST /api/public/forms/open` `{token}` | What the form shows (`{title, submitLabel, fields}`), never other fields of the entity. `404` for an unknown or private link |
| `POST /api/public/forms/submit` `{token, values}` | Limited per address (`APPS_PUBLIC_FORM_PER_MINUTE`) and per form (`ratePerMinute`), then `429` with `Retry-After`. The record is written by no one (`createdBy: null`, `source: form`). Audited `app.form.submitted` with `public: true`, the address and the dropped field names. `201 {submitted: true, held: false, message, dropped}`; since 1.6.0 (B-4701) `202 {submitted: true, held: true, message, dropped}` when a value the `user-input` guardrail holds makes the submission wait for review (Sprint 36b below) |

### Triggers and workflow record steps (B-2206)

| Method and path | What it does |
| --- | --- |
| `GET /api/apps/:app/triggers` | `apps:design`. `{triggers: [{id, kind, entity, events, cron, schedule, workflowId, workflow, ownerId, enabled, nextRunAt, lastRunAt, lastRunId, lastResult}]}` |
| `POST /api/apps/:app/triggers` `{entity, kind: record \| schedule, events?, cron?, workflow, enabled?}` | `apps:design`. A record trigger fires on `created`, `updated`, `deleted` or `transitioned` records of the entity; a schedule trigger on a five-field UTC cron. `workflow` (id or name) must be published and visible in the caller's current workspace. The trigger runs as its creator. Audited `app.trigger.created`. `201` trigger |
| `PATCH /api/apps/:app/triggers/:id` `{enabled?, events?, cron?}` | `apps:design`. Audited `app.trigger.updated` |
| `DELETE /api/apps/:app/triggers/:id` | `apps:design`. Audited `app.trigger.deleted`. `204` |

A record event becomes an `apps.trigger` job per matching trigger; the job starts the workflow's published version
(trigger `record`) as the owner, with the input `{event, app, entity, record: {id, state, label, version, values},
fields?, from?, to?, trigger: {id, depth}}` (no values for `deleted`). Schedules start it with `{event: schedule, app,
entity, dueAt, trigger}` (trigger `schedule`); each due time is claimed once across instances. The owner must still be
active, hold `agents:run` and `records:read`, belong to the workflow's workspace and be cleared for the record, and the
record must not be above the workflow's label; otherwise the trigger records a skip (`lastResult`, audited
`app.trigger.skipped`). Runs that start are audited `app.trigger.fired`. A workflow's trigger node may say `source:
record` or `schedule`.

Workflow graphs have a `record` node: `config: {action: create | update | transition, app, entity, record?: template,
values?: {field: template}, to?}`; it writes as the run's owner (who needs `records:write`), outputs `{id, state,
label, values}`, and is mocked in dry runs. A new record is at least the run's label; writing a record below the run's
label blocks the step. The step passes the run's trigger depth on: chains stop at `APPS_TRIGGER_MAX_DEPTH`, and a
workflow's own record steps never fire that workflow's triggers.

### AI fields, drafts and bundles (B-2207, B-2208)

| Method and path | What it does |
| --- | --- |
| `POST /api/apps/drafts` `{kind: entity \| workflow, prompt, profile, label?}` | `apps:design`. A local model, through the gateway and the named published profile, drafts an entity definition or a workflow graph from the description (which passes `user-input` first). The draft is validated like a saved one and never saved: `{kind, draft, valid, problems}`. An answer that is not JSON is `422`; an unreachable model `503`. Audited `app.draft.created` |
| `GET /api/apps/:app/export` | `apps:design`. The app's design as a signed bundle: `{format: exprsn-app/1, exportedAt, app, entities, forms, key, signature}` (an HMAC over the canonical JSON of the rest with the KMS key `key`). No records, triggers or form links. Audited `app.exported` |
| `POST /api/apps/import` `{bundle, name?, workspaceId?}` | `apps:design`. Verifies the signature over exactly what arrived before reading anything else: a bundle changed after signing, signed elsewhere or naming another key is `422 Bundle refused`, audited `app.import.refused`. Then creates the app (under `name` if given) with its entities and forms (forms private); a name in use is `409` and leaves nothing behind. Audited `app.imported`. `201` app |

AI fields: after a create, or an update of other fields, the record's `aiState` is `pending` and the `apps.ai-fill` job
asks the field's profile with its prompt (placeholders filled from the record), as the person who last wrote the
record (their `inference:invoke` and clearance) or, for a public form's record, with only the profile's label checked;
the answer passes `model-output`. Any error (the model down, the profile unpublished, the guardrails holding the
answer) leaves the field empty and the record saved, with `aiState: failed` and `aiError`, audited
`app.record.ai.failed`; a filled field is audited `app.record.ai.filled` and emitted as `record.updated`.

Records are moderation objects (type `record`): a takedown hides the record from every list and read, an upheld appeal
shows it again.

## Sprint 27c (1.4.0): groups and events (B-2501 to B-2505)

Groups live inside one workspace, and workspace membership stays the outer boundary: every route starts from the
workspaces the caller may act in now, so a group outside them is `404` (it cannot be seen, joined or reported), and a
member who leaves the workspace loses its groups at once, whatever their group role. `groups:read` sees groups, their
content and events; `groups:write` creates groups, joins, posts, RSVPs and keeps calendar feeds (both held by
members and tenant admins); what someone may do inside a group is their **group role**: `owner` (settings, roles,
delete), `moderator` (requests, invitations, removing members, hiding posts, events, check-in, cases) or `member`
(posts, RSVPs). `groups:manage` (tenant admins) acts as owner of every group in the workspaces the holder may act in.
A group's `visibility` is `public` (listed and readable by everyone in the workspace; posting needs membership),
`private` (listed; content for members) or `hidden` (known only to members, invitees and managers); its `joinMode` is
`open`, `request` or `invite`. Its `label` (at most the workspace ceiling, default `internal`) is the label of all its
content: nobody below it sees the content or joins. Descriptions, posts and event titles, descriptions and locations
are sealed with the tenant key. Refusals for a reader carry `step`: `group` (join first), `group-role` (with
`right`), `clearance`, `join-mode`, `workspace`, `invitee`, `guardrails`. Every route answers `Cache-Control:
no-store`. Changes are audited under `group.*` and `calendar.feed.*`; the catalogue events `group.created`,
`group.updated`, `group.deleted`, `group.member.added`, `group.member.removed`, `group.post.created`,
`group.post.deleted`, `group.event.created`, `group.event.updated` and `group.event.cancelled` are emitted to
webhooks and plugins (ids only).

### Groups, members, requests and invitations (B-2501)

| Method and path | What it does |
| --- | --- |
| `GET /api/groups?workspace=&mine=true` | `groups:read`. The groups the caller may know of in their workspaces (or one): `[{id, workspaceId, name, description, visibility, joinMode, label, state, role, actingRole, members, …}]`; `description` is null where the caller may not read the content |
| `POST /api/groups` `{workspaceId?, name, description?, visibility?: private, joinMode?: request, label?}` | `groups:write`. In a workspace the caller may act in (default the current one), label at most the workspace ceiling (`422`) and the caller's clearance (`403`). The creator is the owner. `201` with the group |
| `GET /api/groups/:id` | `groups:read`. The group with the caller's `role`, `actingRole` and member count |
| `PATCH /api/groups/:id` `{name?, description?, visibility?, joinMode?, label?}` | Owner. A raised label raises its posts and events; sockets in the group's room are checked again |
| `DELETE /api/groups/:id` | Owner. The group is deleted (`state: deleted`), pending requests cancelled, reminders stopped |
| `GET /api/groups/:id/members` | Readers of the content. `[{userId, username, displayName, role, joinedAt}]` |
| `PATCH /api/groups/:id/members/:userId` `{role: owner \| moderator \| member}` | Owner. A group keeps at least one owner (`409`) |
| `DELETE /api/groups/:id/members/:userId` | Leave (one's own id) or remove (moderators remove members, owners anyone). The last owner cannot leave (`409`). The member's sockets leave the group's room at once |
| `POST /api/groups/:id/join` | `open`: `200 {joined: true, role}`. `request`: `202 {requested: true, request}` (the same pending request again if there is one; moderators are notified). `invite`: `403` (`step: join-mode`) unless the caller holds an invitation, which this accepts. Outside the workspace or below the label: `404` |
| `POST /api/groups/:id/invites` `{userId, role?: member}` | Moderators (owners for `moderator` and `owner`). The invitee must be active, in the group's workspace and cleared for its label (`422`, `step: workspace`); one pending invitation or request per user (`409`). Expires after `GROUP_INVITE_DAYS`. `201` with the invitation; the invitee is notified |
| `GET /api/groups/:id/candidates?q=` | Since 1.5.0. Moderators (the invite right). Up to 50 people the caller may invite: active members of the group's workspace cleared for its label, not members, without a pending request or invitation. `[{userId, username, displayName}]` |
| `GET /api/groups/:id/requests?state=` | Moderators. Requests and invitations (default `pending`; expired ones are marked so) |
| `GET /api/group-requests` | The caller's pending requests and the invitations waiting for them: `[{id, groupId, groupName, kind: request \| invite, role, state, expiresAt, …}]` |
| `POST /api/group-requests/:id/accept` | An invitation by its invitee; a request by a moderator. The workspace boundary and label are checked again now (`422`); expired is `410` |
| `POST /api/group-requests/:id/decline` | The same people. `200` with the request |
| `DELETE /api/group-requests/:id` | Withdraw: the requester their request, a moderator an invitation |

### Posts and cases (B-2505)

| Method and path | What it does |
| --- | --- |
| `GET /api/groups/:id/posts?before=&limit=` | Readers. Newest first: `[{id, groupId, authorId, authorName, body, label, state, createdAt, updatedAt}]`; moderators also see hidden posts (`body: null`) |
| `POST /api/groups/:id/posts` `{body}` | Members (up to 10,000 characters). Screened at the `user-input` guardrail checkpoint (`422`, `step: guardrails` on a block; a redaction is stored redacted). `201` with the post |
| `DELETE /api/group-posts/:id` | Its author, or a moderator |
| `GET /api/groups/:id/cases?state=` | Moderators. The flags on the group's content (reports and moderation checks through B-19), within clearance: `[{id, ref, kind, state, severity, objectType, objectId, label, ruleName, dueAt, createdAt}]` |

Group content is moderated through the moderation API (Sprint 26c) with three registered types: `group-post` (hidden
posts are shown to nobody but the group's moderators), `group` (its name and description; a hidden group is closed to
everyone but managers and its owners) and `group-event` (a hidden event is left out of calendars and its reminders are
not sent). `POST /api/moderation/reports {type: group-post, id}` by anyone who can read the post files a flag in the
group's workspace queue; a reviewer's hide and an upheld appeal work as for any object.

### Events, RSVPs and check-in (B-2502)

Times are given as an instant with an offset (`2026-11-03T08:00:00Z`) or as a wall-clock time (`2026-11-03T09:00`) or
date (all-day events) in `timeZone`, an IANA zone name (`Europe/Berlin`, `UTC`; offsets and unknown names are `400`).
They are stored in UTC with the zone. A wall-clock time that occurs twice takes the earlier instant; one in a
daylight-saving gap moves forward by the gap. Events last at most 31 days. Readers of the group read its events.

| Method and path | What it does |
| --- | --- |
| `GET /api/groups/:id/events?from=&to=&includeCancelled=` | Readers. Events overlapping the window (default from a day ago, a year long) |
| `POST /api/groups/:id/events` `{title, description?, location?, start, end? \| durationMinutes?, timeZone, allDay?, capacity?, maxGuests?, reminders?}` | Moderators. `reminders` are up to five offsets in minutes before the start (at most 28 days). `201 {id, title, startsAt, endsAt, timeZone, localStart, localEnd, allDay, capacity, maxGuests, reminders, label, state, sequence, attendance, myRsvp, canManage, …}` |
| `GET /api/calendar/events?from=&to=` | The caller's calendar: events of their groups and events they RSVPed to (going or maybe), still readable now; at most 400 days |
| `GET /api/calendar/events/:id` | With `attendance {going, maybe, guests, checkedIn}` and the caller's `myRsvp` |
| `PATCH /api/calendar/events/:id` | Moderators; the event fields, all optional. A change attendees see moves `sequence`; a new time or reminder list reschedules the reminders |
| `POST /api/calendar/events/:id/cancel` `{reason?}` | Moderators. Stops the reminders and notifies **every attendee** (going or maybe), in the console (`event.cancelled`) and by email (`event-notice`: the time and a link, never the event's title or the reason). `200` with the event and `notified` |
| `POST /api/calendar/events/:id/rsvp` `{response: going \| maybe \| declined, guests?}` | Members (and anyone in the workspace for a public group) until the event ends. Guests up to `maxGuests` (`422`); `capacity` counts people with their guests (`409` with `left`); since 1.5.0 (B-3603) the event row is locked while the places are counted, so simultaneous answers for the last place take turns and only one gets it |
| `GET /api/calendar/events/:id/attendees` | Readers see who is going or maybe; moderators also the declined and check-ins |
| `POST /api/calendar/events/:id/check-in` `{userId, checkedIn?: true}` | Moderators. Someone without an RSVP is added as going (if they can read the event) |
| `GET /api/calendar/events/:id/reminders` | Moderators. `[{id, minutesBefore, fireAt, state: scheduled \| sending \| sent \| cancelled \| skipped, recipients, sentAt}]` |

### Reminders (B-2503)

Each reminder offset is a row and a `calendar.reminder` job queued with `runAt` at its time. The queue claims a job
with a conditional update, so one instance runs it however many poll the database (tested with two instances on one
database); the reminder row also moves `scheduled` → `sending` → `sent` with a compare-and-set, so a retried or
duplicated job never sends twice. At its time the job notifies the attendees (going or maybe) who can still read the
event, in the console (`event.reminder`) and by email, and is audited `group.event.reminded`. A cancelled, hidden or
moved event's reminders are cancelled or skipped.

### Calendar feeds (B-2504)

| Method and path | What it does |
| --- | --- |
| `GET /api/calendar/feeds` | `groups:read`. The caller's feeds: `[{id, kind, targetId, name, url, createdAt, revokedAt, lastUsedAt}]` |
| `POST /api/calendar/feeds` `{kind: event \| group \| user, targetId?}` | `groups:write`. An event or group the caller can read, or their own calendar. `201` with the `url`. Audited `calendar.feed.created` |
| `DELETE /api/calendar/feeds/:id` | Revoke (the owner, or a `groups:manage` holder). Audited `calendar.feed.revoked` |
| `GET /calendar/feeds/:id/:signature.ics` | Public, outside `/api`: no session or cookie, rate-limited per address (`CALENDAR_FEED_PER_MINUTE`). `text/calendar` (RFC 5545: UTC times, all-day dates in the event's zone, escaped and folded). The signature is an HMAC-SHA256 over the feed's id, tenant, owner, kind and target with a key derived from `SESSION_SECRET` (HKDF). A bad signature, an unknown or revoked feed, or an owner who is disabled, sanctioned or no longer entitled is the same `404`. The feed is rendered as its owner at every fetch (workspace, group and clearance); a user feed covers the last 30 days and the next year, cancelled events as `STATUS:CANCELLED`. Events above `CALENDAR_FEED_MAX_LABEL` (default `internal`) appear as `Busy (<label>)` without details |

### Realtime (B-2101)

The `group` room kind: a socket joins with `room.join {kind: group, id}` when its user can read the group's content.
Events: `group.updated`, `group.member.added`, `group.member.removed`, `group.member.role`, `group.post.created`,
`group.post.deleted`, `group.event.created`, `group.event.updated`, `group.event.cancelled`, `group.event.rsvp`,
`group.event.check-in` (ids, never content). Removing a member closes their room at once; a visibility or label change
checks everyone in it again; leaving the workspace closes it.

## Sprint 28a (1.4.0): customer-service channels (B-2301 to B-2304) and email one-time codes (B-1806)

A channel lives in one workspace and answers customers with a published **profile** or **agent** (the agent's profile
and system prompt; customer channels never run an agent's tools), at the channel's **label**. The label must fit under
the workspace ceiling, the caller's clearance and the profile's (and agent's) label when the channel is saved, and the
gateway only leases a pool cleared for it when a customer is answered, so an answer never comes from a model or pool
below the channel's label. Every customer message passes the `user-input` guardrail checkpoint and every answer the
`model-output` checkpoint at that label. Transcripts are sealed per row with the tenant key; customer names, addresses
and subjects too.

`channels:manage` (tenant admins) creates and changes channels; `channels:review` (tenant admins, guardrail admins and
flag reviewers) works their sessions. Both only within the caller's workspaces and clearance (anything else is `404`).
Changes are audited under `channel.*`; the catalogue events `channel.session.started`, `channel.session.escalated`,
`channel.session.closed`, `channel.session.purged`, `channel.message.received`, `channel.reply.held`,
`channel.reply.sent`, `channel.reply.rejected` and `channel.bounce.recorded` (catalogue version 4) carry ids only.
Reviewers' consoles get `channels.changed` on the `channels:review` permission room.

### Channels (`channels:manage`)

| Method and path | What it does |
| --- | --- |
| `GET /api/channels?workspace=` | `channels:manage` or `channels:review`. The channels in the caller's workspaces at or below their clearance |
| `POST /api/channels` `{workspaceId?, kind: chat \| email, name, label, target: {kind: profile \| agent, name}, instructions?, reviewMode?: escalated, allowAnonymous?: true, messagesPerMinute?: 10, sessionsPerHour?: 10, retentionDays?: 30, greeting?, email?}` | Creates a channel. The binding is checked (`403` with `step: clearance` or `zone`; `422` with `step: target` when the profile or agent cannot answer at the label). `email` (email channels only): `{address, fromName?, imap?: {host, port?: 993, secure?: true, user, passwordRef, mailbox?: INBOX}, smtp?: {host, port?: 465, secure?: true, user, passwordRef}, mailgunKeyRef?}`; credentials are `vault:<path>#<key>` references only (`400` otherwise), checked readable for the caller at save (B-1705) and resolved as them at use; hosts are checked against the service address rules and the tenant's allowed hosts at every connection. `201` with the channel, its `publicKey`, the webhook URLs (email) and, **once**, `secrets: {identitySecret, webhookSecret?}` |
| `GET /api/channels/:id` | The channel (no secrets) |
| `PATCH /api/channels/:id` | Any of the create fields but `kind` and `workspaceId`, and `state: active \| paused`. A changed label, target or mail settings is checked again. Pausing refuses new sessions and ends customer tokens until it is active again |
| `DELETE /api/channels/:id` | Deletes the channel (`state: deleted`) and closes its open sessions |
| `POST /api/channels/:id/secrets` `{which: identity \| webhook}` | A new secret, shown once; the old one stops working at once |
| `POST /api/channels/:id/poll` | Polls the channel's IMAP mailbox now (a `channels.imap-poll` job). `202 {jobId}` |
| `POST /api/channels/:id/purge` | Runs the retention purge now (a `channels.retention` job). `202 {jobId}` |

`reviewMode`: `never` (answers go straight to the customer unless a guardrail holds them), `escalated` (the default:
once a session is escalated, every answer waits for a reviewer) or `always` (every answer waits).

### Sessions, held replies and exports (`channels:review`)

| Method and path | What it does |
| --- | --- |
| `GET /api/channels/:id/sessions?state=&before=&limit=` | Newest activity first: `[{id, state: open \| escalated \| closed \| hidden, label, customer: {kind, name, email, externalId}, subject, escalatedAt, escalation, messages, lastActivityAt, …}]` |
| `GET /api/channels/:id/sessions/:sessionId` | The session with its `transcript` (`[{id, seq, role: customer \| assistant \| agent \| notice, state: delivered \| held \| rejected \| hidden, via, text, original, flag, authorId, …}]`; `original` is the model's text of a reply a reviewer edited) and its email `outbox` (`queued \| sent \| failed \| bounced`) |
| `POST /api/channels/:id/sessions/:sessionId/messages` `{text}` | A person answers (role `agent`, delivered at once; by email for email sessions) |
| `POST /api/channels/:id/sessions/:sessionId/close` | Closes the session (the customer's token stops working) |
| `GET /api/channels/:id/sessions/:sessionId/transcript.csv` | The transcript as CSV (`channel, session, seq, time, role, state, via, label, text, original`; a leading `= + - @` is made inert). Audited `channel.transcript.exported` |
| `POST /api/channels/:id/exports` `{from?, to?}` | Every session created in the window (ISO 8601; at most 10,000 sessions, those within the caller's clearance) as one CSV, built by a `channels.export` job and sealed in the blob store. `202 {jobId}` |
| `GET /api/channels/exports/:jobId` | The finished export, for the person who started it. Audited `channel.transcript.exported` |
| `GET /api/channels/:id/bounces` | `[{id, outboxId, kind: hard \| soft \| complaint, status, reason, source: imap \| generic \| mailgun, createdAt}]` |
| `GET /api/channels/held` | Held replies in the caller's workspaces and clearance, oldest first, with their flag |
| `POST /api/channels/held/:messageId/decide` `{decision: approve \| edit \| reject, text?, reason?}` | B-2302. `approve` delivers the reply as written; `edit` delivers `text` instead (the model's text is kept as `original`); `reject` withdraws it and tells the customer a person will follow up. The reply's `hold` flag records the decision (`approved` or `rejected`) through the flag queue (reviewer clearance as there). Email sessions get the delivered reply by email. Audited `channel.reply.sent` (with `edited`), `channel.reply.edited`, `channel.reply.rejected` |

A held reply is a `hold` flag (`source_kind: channel-message`, checkpoint `model-output` when a guardrail held it,
`channel-review` when the channel's review mode did) in the workspace's flag queue: `GET /api/flags/:ref` shows it
under `held`, and `POST /api/flags/:ref/decide {decision: approved | rejected}` (`flags:review`) approves or rejects it
too (audited `channel.hold.approved` / `channel.hold.rejected`); editing needs the channel route. A session escalates
when the customer asks for a person, a guardrail asks for review of their message (`require-approval` at
`user-input`), a guardrail blocks an answer or the model cannot answer; reviewers holding `channels:review` in the
workspace are notified. Sessions (`channel-session`: hiding ends the customer's token) and messages
(`channel-message`: hiding removes the message from what the customer and the model see) are moderation object types.

### Customers (public, `/api/public/channels`)

No session cookie is read or set; answers carry `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`.

| Method and path | What it does |
| --- | --- |
| `POST /api/public/channels/sessions` `{channel: <publicKey>, identity?, name?}` | Starts a session on an active chat channel (`404` otherwise). Anonymous unless the channel requires an identity (`allowAnonymous: false`, `401` without one). `identity` is an assertion the channel's site signs: `<base64url(JSON {sub, name?, email?, exp})>.<base64url(HMAC-SHA256(identitySecret, first part))>`, `exp` in seconds and at most a day ahead; an identified customer comes back to their open session (`resumed: true`). Rate-limited per address: `CHANNELS_SESSIONS_PER_HOUR` across channels and the channel's `sessionsPerHour` (`429`). `201 {token, expiresAt, resumed, session: {id, channel, state, label, escalated}, messages}` |
| `GET /api/public/channels/session?after=` | `Authorization: Bearer <token>`. The session and its messages after a sequence number: the customer's own, delivered answers, notices; a held answer shows as `{state: pending, text: null}` until a reviewer decides. Poll this for answers released by review |
| `POST /api/public/channels/session/messages` `{text}` | Up to 8,000 characters; at most `messagesPerMinute` per session (`429`). A guardrail block is `422` (audited `channel.message.refused`). Answers when the reply is ready: `201 {message: {seq}, reply: {seq, role, state: delivered \| pending, text}, session: {state, escalated}}`. When the model cannot answer, the reply is a notice that a person will follow up and the session escalates |
| `POST /api/public/channels/session/escalate` `{reason?}` | Asks for a person: the session escalates (reviewers are notified) |
| `POST /api/public/channels/session/close` | Ends the session and its token |

The session token (`cst_…`) is HMAC-signed with a key derived from `SESSION_SECRET` and names one tenant, channel and
session; it lasts `CHANNELS_SESSION_HOURS` and stops working as soon as the session is closed or hidden or the channel
is paused or deleted.

### Email channels (B-2303)

Mail arrives by IMAP polling and by provider webhooks (both may be configured for one channel):

- **IMAP**: every `CHANNELS_IMAP_POLL_SECONDS` a `channels.imap-poll` job per channel (one per tick across instances)
  opens the mailbox read-only, reads up to `CHANNELS_IMAP_BATCH` messages above the last UID seen (another poll
  follows at once when more wait) and keeps the cursor with the mailbox's UIDVALIDITY (a new UIDVALIDITY reads from
  the start; Message-IDs keep anything from being taken twice). Implicit TLS, or STARTTLS which is then required.
  Messages over 10 MB are skipped.
- **Webhooks** at `POST /api/public/channels/:publicKey/email/generic` and `…/email/mailgun`, rate-limited per channel
  (`CHANNELS_WEBHOOK_PER_MINUTE`); the signature is checked over the raw body before anything is parsed (`401`), and
  a replay inside the tolerance window is acknowledged as `duplicate`. Answers `200 {accepted, result: {action:
  started | joined | duplicate | ignored | bounce, session?}}`.
  - Generic: headers `X-Exprsn-Timestamp: <unix seconds>` (within `CHANNELS_WEBHOOK_TOLERANCE_SECONDS`) and
    `X-Exprsn-Signature: v1=<hex HMAC-SHA256(webhookSecret, "<timestamp>.<raw body>")>`; JSON body `{type: message,
    from, fromName?, subject?, text, messageId, inReplyTo?, references?}`, or `{type: message, raw: "<RFC 5322
    message>"}`, or `{type: bounce, id?, recipient, messageId?, kind?: hard | soft | complaint, status?, reason?}`.
  - Mailgun: inbound routes (`forward()` to the URL; `application/x-www-form-urlencoded`, so without attachments) and
    event webhooks (JSON; `failed` and `complained` become bounces, others are acknowledged), both verified with
    HMAC-SHA256 of `timestamp + token` under the Mailgun webhook signing key named by `mailgunKeyRef`. Without it the
    endpoint is `404`.

A message joins a session when its `In-Reply-To` or `References` name a Message-ID of that session (one the customer
sent or one of our replies) **and** it comes from that session's customer address; a closed session reopens. Anything
else starts a new session, so a forged `In-Reply-To` from another sender never reads into someone else's thread.
Automatic mail (`Auto-Submitted`, `Precedence: bulk/list/junk`, `List-Id`, mailer daemons) and mail from the channel's
own address are ignored. The quoted part of a reply is dropped. Answers are generated by a `channels.reply` job and
sent from the outbox by a `channels.send` job (five attempts; then `failed`, audited `channel.mail.failed`) through
the channel's SMTP server, or the server's `SMTP_URL` when it has none, from the channel's address with `In-Reply-To`
and `References` threading and `Auto-Submitted: auto-replied` on model-written answers. Delivery status reports
(RFC 3464, by IMAP) and provider bounce events are recorded once each and mark the outbox row `bounced` (audited
`channel.bounce.recorded`).

### Retention (B-2304)

Each channel has `retentionDays` (default 30, `null` keeps sessions). A `channels.retention` job per tenant every
`CHANNELS_RETENTION_SWEEP_MINUTES` deletes sessions whose last activity is older than the period, with their
messages, threads and outbox rows; open review flags of their held replies are closed as rejected. Audited
`channel.session.purged` per channel with the count, and emitted as the event of the same name.

### Email one-time codes (B-1806)

| Method and path | What it does |
| --- | --- |
| `POST /api/me/mfa/email` `{label?}` | Enrolling or active browser sessions. Adds the account's email address as a factor: sends a six-digit code to it (`503` without SMTP, `409` without an address or with an email factor already). `201 {id, sentTo (masked), expiresAt}` |
| `POST /api/me/mfa/email/:id/confirm` `{code}` | Confirms the factor (a wrong code counts in the account's lockout like a wrong password; `400` with `attempts_remaining`). Like the other factors, the first one completes an enrolling sign-in. `201 {enrolled, stage, recoveryCodes, csrf?}` |
| `POST /api/auth/mfa/email/send` | A pending (`mfa`) session: sends a code to the confirmed email factor. `200 {sentTo, expiresAt}`. Audited `auth.mfa.email_sent` |
| `POST /api/auth/mfa/email` `{code, rememberDevice?}` | Completes the second factor like `POST /api/auth/mfa/totp`: wrong codes count in the pending session's lockout, and the fifth wrong code (of any factor) ends the pending session, so the sixth is refused like a sixth wrong TOTP code |

Codes are stored as an HMAC, valid for `MFA_EMAIL_CODE_MINUTES`, work once and only for the session they were sent
for; a new code replaces the previous one. At most `MFA_EMAIL_SENDS_PER_HOUR` codes are sent per user (`429`). The
code is in the body of the email, never its subject. `GET /api/auth/session` lists `email` among the `mfa.methods`.

## Sprint 28b (1.4.0): social relations (B-2606, shared with the feed's B-2702)

Blocks, mutes, follows, lists and contact rules, per tenant and per user; messaging (B-26) and the workspace feed
(B-27) both enforce them. `social:read` sees one's own relations, `social:write` changes them (both held by members and
tenant admins), `social:manage` (tenant admins) sees anyone's. Every route answers `Cache-Control: no-store`; changes
are audited under `social.*` (the people involved, never more).

- A **block** works in both directions: neither person can start a conversation with or message the other, each
  other's messages, posts and socket events (typing, presence, new messages and posts) are left out for the other, and
  blocking ends follows both ways. The blocked person is never told: to them it reads as "does not accept messages
  from you", the same words as a contact rule.
- A **mute** is one-way and private, for a number of minutes or until removed: the muted person's posts leave the
  muter's home feed and their messages notify the muter of nothing.
- **Follows** and **list** members must share a workspace with the caller (else `404`, as if unknown); blocks and
  mutes may name anyone active in the tenant. Someone in a block with the caller cannot be followed or listed (`409`
  for the blocker, `404` for the blocked).
- The **contact rule** says who may start a conversation with a user or add them to one: `workspace` (anyone who
  shares a workspace with them, the default), `following` (only people they follow) or `nobody`.

Limits per user: 5,000 blocks, mutes and follows each, 100 lists of up to 1,000 people.

| Method and path | What it does |
| --- | --- |
| `GET /api/social/settings` | `{contactRule: workspace \| following \| nobody}` |
| `PUT /api/social/settings` `{contactRule}` | Sets the caller's contact rule (audited `social.contact-rule.updated` when it changes) |
| `GET /api/social/people?q=&limit=200` | Since 1.5.0. The people who share a workspace with the caller now (active, not the caller), optionally matching `q` in the username or display name: `[{userId, username, displayName, workspaces: [{id, name}]}]`, for the console's person picker. Whether someone accepts the caller is still decided when they act |
| `GET /api/social/users/:id` | The caller's relation with one person: `{userId, blocking, muting, following, followedBy, canMessage}`. Someone outside the caller's workspaces is `404` unless the caller blocked or muted them. Being blocked by them shows only as `canMessage: false` |
| `GET /api/social/blocks` | `[{userId, username, displayName, createdAt}]` |
| `POST /api/social/blocks` `{userId}` | `201 {userId, blocked: true, created: true}`; `200` with `created: false` when already blocked; `422` for oneself |
| `DELETE /api/social/blocks/:userId` | Unblocks (`404` when there was no block) |
| `GET /api/social/mutes` | `[{userId, username, displayName, expiresAt, createdAt}]` (live mutes) |
| `POST /api/social/mutes` `{userId, minutes?}` | Mutes for `minutes` (at most a year) or until unmuted; muting again sets the new end. `201` |
| `DELETE /api/social/mutes/:userId` | Unmutes |
| `GET /api/social/following` | `[{userId, username, displayName, since}]` |
| `GET /api/social/followers` | The caller's followers, same shape |
| `POST /api/social/following` `{userId}` | Follows (`201`; `200` when already following) |
| `DELETE /api/social/following/:userId` | Unfollows |
| `GET /api/social/lists` | `[{id, name, description, members, createdAt, updatedAt}]` |
| `POST /api/social/lists` `{name, description?}` | `201`; a name the caller already uses (any case) is `409` |
| `GET /api/social/lists/:id` | The list with `people: [{userId, username, displayName}]`; someone else's list is `404` |
| `PATCH /api/social/lists/:id` `{name?, description?}` | Renames or describes it |
| `DELETE /api/social/lists/:id` | Deletes it |
| `POST /api/social/lists/:id/members` `{userId}` | Adds someone (`201`; `200` when already in it) |
| `DELETE /api/social/lists/:id/members/:userId` | Takes them off |
| `GET /api/social/admin/users/:id` | `social:manage`. `{userId, username, contactRule, blocks, blockedBy, mutes, following, followers, lists}` (user ids and a list count); audited `social.relations.viewed` |

For other modules, `server/src/social/service.ts` (`s.social`) has the shared checks: `isBlocked(tenantId, a, b)`
(either direction), `blockedWith` and `blockedAmong`, `mutedBy`, `isMuted`, `following`, `followers`, `isFollowing`,
`hiddenFor` (blocked and muted together, for feeds), `listMembers` and `inList`, `contactRule`, `mayContact` and
`requireContact`, and `emitToRoom`, which publishes a realtime room event with everyone in a block with the actor left
out (`exceptUserIds` on the room event), so the filter applies on every instance. Every change is also published on
the bus (`social.relation {tenantId, kind: block | mute | follow, userId, targetId, on}`).

## Sprint 28b (1.4.0): messaging (B-2601 to B-2605)

Person-to-person conversations inside the tenant, sealed at rest with the tenant key (no end-to-end encryption, so
search, summaries and moderation work). `messages:read` reads one's conversations, `messages:write` starts them, sends,
edits, reacts and pins (both held by members and tenant admins); what a member may do inside a conversation is their
**role**: `owner` (title, roles, delete), `admin` (add and remove members, pin, delete others' messages, title) or
`member` (send, react, receipts). Nobody reads a conversation they are not in: there is no administrator view
(moderation reads reported messages). Every route answers `Cache-Control: no-store`.

- A **direct** conversation is between two people, one per pair: starting one again, from either side, returns the
  first (`200`), also when both start it at once (a unique key on the pair). It has no workspace: the two must share
  one now (else `404`), and in it both may pin. A **group** conversation lives in one workspace; everyone in it must be
  a member of that workspace now. Workspace membership is the outer boundary, as for groups: losing it hides the
  conversation at once.
- Starting a conversation or adding someone follows their **contact rule** and refuses a block (`403`, `step:
  contact`, the same words either way; see social relations above). A direct conversation takes no messages while
  either person blocks the other. In a group conversation, messages, reactions, receipts and socket events of people
  in a block with the reader are left out of everything the reader gets.
- The `label` (default `internal`, at most the workspace ceiling, or for a direct conversation the highest ceiling of
  the shared workspaces) is set at creation; everyone in the conversation must be cleared for it (`422`).
- A member added to a group conversation reads messages from the moment they were added.

Refusals carry `step`: `contact`, `self`, `workspace`, `clearance`, `conversation-role` (with `right`), `author`,
`guardrails`. Changes are audited under `messaging.*` without any message text (a deleted message leaves
`messaging.message.deleted` with the author and edit count); the catalogue events `message.sent`, `message.edited` and
`message.deleted` (ids only) are emitted to webhooks and plugins (catalogue version 4).

### Conversations and members (B-2601)

| Method and path | What it does |
| --- | --- |
| `GET /api/messaging/conversations?workspace=` | The caller's conversations still within their workspaces and clearance, latest activity first: `[{id, kind, workspaceId, title, label, role, members, unread, muted, mutedUntil, notify, lastReadId, lastMessageAt, with?, …}]` (`with` is the other person of a direct conversation) |
| `POST /api/messaging/conversations` `{kind: direct, userId, label?}` | `201` with a new direct conversation, or `200` with the existing one for the pair |
| `POST /api/messaging/conversations` `{kind: group, workspaceId?, title?, memberIds, label?}` | `201`; in a workspace the caller may act in (default the current one), with people from that workspace (`422`, `step: workspace`) who accept the caller (`403`). At most `MESSAGING_MAX_MEMBERS` people. The creator is the owner |
| `GET /api/messaging/conversations/:id` | The conversation with `people: [{userId, username, displayName, role, joinedAt, lastSeenAt}]` |
| `PATCH /api/messaging/conversations/:id` `{title}` | Owner or admin of a group conversation (`409` for a direct one) |
| `DELETE /api/messaging/conversations/:id` | Owner. The conversation is deleted and its messages' bodies, terms and vectors removed |
| `GET /api/messaging/conversations/:id/members` | The people |
| `POST /api/messaging/conversations/:id/members` `{userId, role?: member}` | Owner or admin (owners for `admin` and `owner`). `201` |
| `PATCH /api/messaging/conversations/:id/members/:userId` `{role}` | Owner. A conversation keeps at least one owner (`409`) |
| `DELETE /api/messaging/conversations/:id/members/:userId` | Leave (one's own id) or remove (admins remove members, owners anyone). The last owner cannot leave (`409`). Their sockets leave the room at once |

### Messages (B-2602)

| Method and path | What it does |
| --- | --- |
| `GET /api/messaging/conversations/:id/messages?before=&thread=&limit=` | Newest first. Without `thread`, the main timeline (thread replies left out); with `thread=<first message id>`, the thread. `[{id, conversationId, authorId, authorName, body, state: sent \| hidden \| deleted, label, replyTo, threadId, replyCount, forwardedFrom, attachments: [{fileId, name, type, size, state}], reactions: [{emoji, count, mine}], pinned, pinnedAt, pinnedBy, edited, editedAt, createdAt}]`; deleted and hidden messages are tombstones (`body: null`) |
| `POST /api/messaging/conversations/:id/messages` `{body, replyTo?, threadId?, attachments?}` | Up to 10,000 characters, screened at the `user-input` guardrail checkpoint (`422`, `step: guardrails`; a redaction is stored redacted), sealed. `threadId` puts it in the thread of that message (threads are one level deep); `replyTo` quotes a message. `201` |
| `GET /api/messaging/conversations/:id/pins` | Pinned messages |
| `PATCH /api/messaging/messages/:id` `{body}` | Its author; screened again. Audited with the edit number and length |
| `DELETE /api/messaging/messages/:id` | Its author, or an owner or admin. The body, attachments, keyword terms, vector and reactions are deleted; the row stays as a tombstone |
| `POST /api/messaging/messages/:id/reactions` `{emoji}` | An emoji or a `:name:` (no spaces, up to 32 characters). `201` |
| `DELETE /api/messaging/messages/:id/reactions/:emoji` | Takes the caller's reaction back |
| `POST /api/messaging/messages/:id/pin`, `DELETE …/pin` | Owner or admin (anyone in a direct conversation) |
| `POST /api/messaging/messages/:id/forward` `{conversationId}` | Copies a message (and its attachments, checked again) into another conversation the caller writes in; a message above that conversation's label is `422`. `201` with the new message (`forwardedFrom`) |

### Receipts, typing and presence (B-2603)

| Method and path | What it does |
| --- | --- |
| `POST /api/messaging/conversations/:id/read` `{messageId}` | Moves the caller's read mark forward (never back); reading also counts as delivered |
| `POST /api/messaging/conversations/:id/delivered` `{messageId}` | Moves the delivered mark forward |
| `GET /api/messaging/conversations/:id/receipts` | `[{userId, lastReadId, lastReadAt, deliveredId, deliveredAt, lastSeenAt}]` without people in a block with the caller |

The `conversation` room kind: a socket joins with `room.join {kind: conversation, id}` when its user is a member,
inside the boundary and cleared. Events (ids, never text): `conversation.message.created {messageId, authorId,
threadId}`, `conversation.message.edited`, `conversation.message.deleted`, `conversation.reaction`,
`conversation.pin`, `conversation.member.added`, `conversation.member.removed`, `conversation.member.role`,
`conversation.updated`, `conversation.read {userId, messageId}`, `conversation.delivered`, `conversation.typing
{userId, typing}` and `conversation.presence {userId, state: online | offline, at}` (sent when a socket joins or
leaves the room). A socket in the room sends `room.signal {kind: conversation, id, signal: typing | read | delivered,
data: {typing?, messageId?}}` (at most `ROOM_SIGNALS_PER_MINUTE` a minute; the acknowledgement is `{ok}`). Every event
from a person leaves out the sockets of everyone in a block with them, on every instance (the platform's BUG-080):
a blocked user receives no typing, presence, receipt or message event from the person they blocked or who blocked
them.

### Attachments and notifications (B-2604)

Attachments are files from the file store (`PUT /api/files/uploads`): only a file the sender can read whose current
version passed its quarantine scan (`409` while it is pending), labelled at most the conversation's label, and in the
conversation's workspace (or, in a direct conversation, a workspace both people share; `422`, `step: workspace`), so
everyone reads it through the file store. At most 10 a message.

| Method and path | What it does |
| --- | --- |
| `PUT /api/messaging/conversations/:id/settings` `{muted?, mutedMinutes?, notify?: all \| mentions \| none}` | The caller's own: `muted: true` until unmuted, `mutedMinutes` for a while, `muted: false` to unmute. `{conversationId, muted, mutedUntil, notify}` |

A new message notifies (in the console, `kind: message`, naming the sender, never the text or the title) every other
member except those who muted the conversation, whose rule is `none`, whose rule is `mentions` and who were not named
(`@username`), who muted the sender, or who are in a block with the sender.

### Search, summaries and digests (B-2605)

| Method and path | What it does |
| --- | --- |
| `GET /api/messaging/conversations/:id/search?q=&mode=keyword \| semantic \| hybrid&limit=` | Over the messages the caller can see (since they joined, not deleted or hidden, none from people in a block with them). Keyword ranks by keyed-hash terms; semantic by the embeddings of `MESSAGING_EMBED_MODEL` (an approved embedding model; without it `semantic` and `hybrid` are `409` and the default is `keyword`); hybrid fuses both by reciprocal rank. The messages with `score {fused, keyword, semantic}` |
| `POST /api/messaging/conversations/:id/summary` `{threadId?, profile?, limit?}` | Also needs `inference:invoke`. A summary of a thread, or of the latest messages (up to `MESSAGING_SUMMARY_MAX_MESSAGES`), from the profile (default `MESSAGING_SUMMARY_PROFILE`). `{conversationId, kind: thread \| recent, profile, messages, from, to, summary, citations: [{n, messageId}]}` |
| `POST /api/messaging/conversations/:id/digest` `{profile?}` | Also needs `inference:invoke`. A catch-up digest of the messages from others after the caller's read mark; `summary: null` when there are none |

Only the messages the caller can see are numbered and sent to the model; citations `[n]` in its answer are kept only
when they name one of them (others are removed from the text), so a summary never cites a message its reader cannot
see. The answer passes the `model-output` guardrail checkpoint; a model that is down or refused is `503`. Audited
`messaging.summary.created` (counts only).

Messages are moderated through the moderation API with the registered type `dm-message`: anyone who can see a message
may report it (`POST /api/moderation/reports {type: dm-message, id}`); a hidden message shows to its conversation as a
tombstone and leaves search.

## Sprint 28c (1.4.0): the workspace feed (B-2701 to B-2705)

A feed for a workspace or a group, not a public social network. Workspace membership stays the outer boundary: every
route starts from the workspaces the caller may act in now and their clearance, so a post outside them is `404`.
`feed:read` reads feeds, posts, comments, trending tags and digests; `feed:write` posts, comments, reacts, reposts and
bookmarks (both held by members and tenant admins); `feed:manage` (tenant admins) removes anyone's posts and comments
in the holder's workspaces and sets and runs a workspace's digest. Every route answers `Cache-Control: no-store`.

- A **post** belongs to one workspace, or is targeted at a group of it (`groupId`): the group feed, with the group's
  rights (members post and comment, moderators remove, readers read; a private group's posts never reach the workspace
  feed). The group's Sprint 27 notices (`/api/groups/:id/posts`) stay as they are, beside the group feed.
- **Labels**: a workspace post is `internal` by default (or the `label` asked for), at most the workspace ceiling
  (`422`) and the author's clearance (`403`); a group post carries the group's label. **Media** are files from the file
  store (`media: [fileId]`, at most 10) in the post's workspace (`422` otherwise) that passed quarantine (`409` while
  pending or rejected); they raise the post's label to theirs. A **repost** carries the original's label and stays in
  its workspace and group, so the audience never widens.
- Bodies, comments and digest summaries are **sealed** with the tenant key. Posts and comments are at most
  `FEED_POST_MAX_CHARS` characters.
- **Relations** come from the shared social module (Sprint 28b): a block, either way, hides the other's posts,
  comments and reposts' originals in every feed and refuses comments, reactions and reposts on their posts (`404`, as
  if they did not exist), and their user feed is `404`; a mute takes the muted person's posts out of the muter's home
  feed only. Someone sharing no workspace with the caller is unknown to them.
- **Guardrails** (B-2704): a post's text passes the `user-input` checkpoint before it is published. A block is `422`
  (`step: guardrail`), a redaction is stored redacted, and a hold (`require-approval`) keeps the post `held`: `202`,
  seen only by its author, with a hold flag (`checkpoint: user-input`, source `feed-post`) in the Flags queue. A
  reviewer's `POST /api/flags/:ref/decide {decision: approved}` publishes it (the author is notified; a reviewer cannot
  decide on their own post), `rejected` withdraws it (`state: rejected`, still seen only by its author). Edits and
  comments do not wait for review: a hold refuses them (`422`).

Pages are `{items, nextCursor}`, newest first by publication time; pass `cursor` (opaque) and `limit` (1 to 100,
default 20) for the next page; a cursor the server did not give out is `400`. A post is `{id, workspaceId, groupId,
author: {id, username, displayName}, body, label, state: held | published | rejected | hidden, repostOf, original,
media: [{fileId, name, type, size, available}], tags, counts: {comments, reposts, reactions: {<kind>: n}}, mine:
{reactions, bookmarked, reposted}, createdAt, publishedAt, editedAt}`; `original` is the reposted post as the caller
may see it now, or `null` (blocked, gone or out of reach). Media are downloaded through the file routes
(`/api/files/:id/content`).

### Feeds (B-2703)

| Method and path | What it does |
| --- | --- |
| `GET /api/feed/home?cursor=&limit=` | `feed:read`. The caller's posts and those of the people they follow (`/api/social/following`), in every workspace and group they may read, minus muted people |
| `GET /api/feed/workspaces/:id` | A workspace's feed (its posts not targeted at a group). `404` outside the caller's workspaces |
| `GET /api/feed/groups/:id` | A group's feed (feed posts targeted at it): readers of the group's content (`403`, `step: group`, to non-members of a private group) |
| `GET /api/feed/users/:id` | A person's posts the caller may read; `404` when they share no workspace or are in a block with the caller |
| `GET /api/feed/lists/:id` | The posts of the people on one of the caller's lists (`/api/social/lists`); someone else's list is `404` |
| `GET /api/feed/tags/:tag?workspace=` | Posts with a hashtag (any case), in one workspace or all the caller's |
| `GET /api/feed/bookmarks` | The caller's bookmarks, most recently saved first (posts they can no longer see are left out) |
| `GET /api/feed/trending?workspace=&limit=` | `{tags: [{tag, posts, people}], computedAt, windowStart}`, from the last `feed.trending` run, counting only posts at labels the caller is cleared for |

### Posts, reposts, comments, reactions and bookmarks (B-2701)

| Method and path | What it does |
| --- | --- |
| `POST /api/feed/posts` `{workspaceId?, groupId?, body?, media?, label?}` | `feed:write`. In the current workspace when neither is named. Text or media are needed (`422`). Hashtags are extracted when published. `201` with the post, or `202` when held for review. Audited `feed.post.created` or `feed.post.held`; catalogue events `post.created`, `post.held` |
| `GET /api/feed/posts/:id` | `feed:read`. One post (held and rejected ones for their author only) |
| `PATCH /api/feed/posts/:id` `{body}` | The author. Checked again (a hold refuses); re-tags the post; `editedAt` is set. Audited `feed.post.updated`; event `post.updated` |
| `DELETE /api/feed/posts/:id` | The author, a moderator of its group, or `feed:manage` in its workspace. `{id, state: deleted}`. Audited `feed.post.deleted`; event `post.deleted` |
| `POST /api/feed/posts/:id/repost` `{body?}` | Reposts into the original's workspace or group (group members only). Plain (no text): once per person (`200` with the existing repost), and a plain repost of a plain repost reposts the original. With text it is a post of its own (guardrails, holds). `201`, `202` when held |
| `DELETE /api/feed/posts/:id/repost` | Takes back the caller's plain repost of the post |
| `GET /api/feed/posts/:id/comments?cursor=&limit=` | Oldest first: `{items: [{id, postId, parentId, author, body, state, createdAt}], nextCursor}`; threads are built from `parentId`. Comments by people in a block with the caller are left out |
| `POST /api/feed/posts/:id/comments` `{body, parentId?}` | A comment, or a reply to a comment on the same post (`404` otherwise). **A comment on a deleted post is refused** (`409`, problem+json), as are reactions and reposts; a post waiting for review takes none (`409`). Group posts take comments from members. `201`. Audited `feed.comment.created` |
| `DELETE /api/feed/comments/:id` | The comment's author, the post's author, a moderator of the group, or `feed:manage`. Audited `feed.comment.deleted` |
| `PUT /api/feed/posts/:id/reactions/:kind` | `kind`: `like`, `celebrate`, `support`, `insightful`, `funny`. `201 {postId, kind, added: true}`, `200` with `added: false` when already there. Audited `feed.reaction.added` |
| `DELETE /api/feed/posts/:id/reactions/:kind` | Removes it. Audited `feed.reaction.removed` |
| `PUT /api/feed/posts/:id/bookmark` | Saves it (`201`; `200` when already saved). Audited `feed.bookmark.added` |
| `DELETE /api/feed/posts/:id/bookmark` | Removes the bookmark, also of a post that is gone. Audited `feed.bookmark.removed` |

Posts and comments are moderation objects (Sprint 26c): `feed-post` (a hidden post leaves every feed) and
`feed-comment`. `POST /api/moderation/reports {type: feed-post, id}` by anyone who can read the post files a flag in
its workspace's queue; a reviewer's hide and an upheld appeal work as for any object.

### Trending and the weekly digest (B-2705)

The `feed.trending` job (every `FEED_TRENDING_MINUTES`, per tenant) counts the hashtags of workspace posts published
in the last `FEED_TRENDING_HOURS`, per workspace, tag and label (group posts are left out). The `feed.digest` job
(checked hourly) writes, for each workspace with a digest profile, the digest of the last complete week (Monday 00:00
UTC to Monday) once: its `FEED_DIGEST_TOP` workspace posts labelled up to `FEED_DIGEST_MAX_LABEL`, ranked by reactions
\+ 2 × comments + 3 × reposts, and a summary the profile writes through the gateway (the answer passes the
`model-output` checkpoint). A model failure keeps the ranked list (`state: failed`, `error`); a week without posts is
`empty`. Members cleared for the digest's label are notified (`feed`).

| Method and path | What it does |
| --- | --- |
| `GET /api/feed/workspaces/:id/digests` | `feed:read`. `[{id, workspaceId, weekStart, weekEnd, label, state: ready \| empty \| failed, posts, createdAt}]`, newest first, within the caller's clearance |
| `GET /api/feed/digests/:id` | `{id, workspaceId, weekStart, weekEnd, label, state, profile, error, summary, posts: [{id, score, reactions, comments, reposts, post}], createdAt}`; `post` is the post as the caller may see it now, or `null` |
| `GET /api/feed/workspaces/:id/settings` | `feed:manage`. `{digestEnabled, digestProfile, effectiveProfile, updatedBy, updatedAt}`; `effectiveProfile` falls back to `FEED_DIGEST_PROFILE` |
| `PUT /api/feed/workspaces/:id/settings` `{digestEnabled?, digestProfile?}` | `feed:manage`. A profile that does not resolve to a published profile is `422`. Audited `feed.settings.updated` |
| `POST /api/feed/workspaces/:id/digest` `{}` | `feed:manage`. Queues a digest of the last seven days now: `202 {jobId, workspaceId}`; `409` without a digest profile. Audited `feed.digest.requested`; the job audits `feed.digest.created` |

### Realtime (B-2703)

The `feed` room kind (B-2101), joined with `room.join {kind: feed, id}` by `feed:read` holders:

- `id` = a workspace the caller may act in: its feed. Events `feed.post.created`, `feed.post.updated`,
  `feed.post.deleted` and `feed.comment.created` (`{postId, authorId, workspaceId, groupId, repostOf}` or `{postId,
  commentId, parentId, authorId}`: ids only; the client fetches the post through the API). People below the post's
  label and everyone in a block with the author are left out on every instance.
- `id` = a group whose content the caller reads: its group feed, the same events.
- `id` = the caller's own user id: their home room. A new post reaches the home rooms of the author's followers who
  may read it and did not mute the author (`feed: home` in the data), up to `FEED_HOME_FANOUT_MAX` followers; the
  others see it on their next load. A person's feed (`/api/feed/users/:id`) updates from the workspace rooms.

## Sprint 29 (1.5.0): permission matrices, custom roles and access reviews (B-3301 to B-3305)

New permission `roles:manage` (tenant admins; system admins hold every permission). Every route below needs it,
except that the reviewers assigned to an access review's items list, read and decide them. Nothing here is a
second policy engine: role resolution, cells and `explain` steps all come from `server/src/authz/policy.ts`. Errors
are problem+json; a refusal names the failing `step`. Migration `031_access`.

### Role × permission matrix (B-3301)

| Method and path | What it does |
| --- | --- |
| `GET /api/authz/matrix` | The catalogue's matrix with the tenant's custom roles in force: `{permissions: [{id, admin, routes, anyOfRoutes}], roles: [{id, name, description, builtIn, requiresMfa, grantableBy, version, permissions}], authenticatedRoutes, publicRoutes}`. `admin` is any permission outside the member baseline; `routes` are the routes requiring the permission (from the route registry), `anyOfRoutes` those accepting it as one of several. `version` is null for built-in roles. `?format=csv` (or `Accept: text/csv`) answers `text/csv`: `permission,admin,routes,<role ids…>` with `x` where a role grants it |

`docs/permissions.md` is the same matrix for the built-in roles, with every route per permission. It is generated
(`npm run docs:permissions`) and the test suite fails when it differs from the catalogue.

### Custom roles (B-3302)

A custom role belongs to the tenant (workspaces do not define roles), has the id `custom-<lower-case ULID>` and is
built only from catalogue permissions. It never holds a permission its creator (and, for a pending version, its
approver) does not hold: a tenant admin cannot create a role holding `platform:manage` (`403`, `step: role`,
`permissions: [...]`). `grantableBy` names roles of the tenant (built-in or custom) whose holders may grant it; a
granter must also hold every permission the role carries. `requiresMfa` defaults to true and can be false only when
a built-in role without the requirement grants each of its permissions (`400` otherwise). A role holding an admin
permission is under dual control: its first version, and every later version, waits for a second holder of
`roles:manage` (`pending`) and the version in force stays as it was until then. Custom roles resolve wherever
built-in roles do: assignment (`PATCH /api/admin/users/:id`, group mappings, invitations, CSV imports, all checked
against the tenant's roles), `GET /api/admin/roles`, `GET /api/me`, the policy, effective permissions and `explain`
(whose role step names the granting roles). Other instances reload the roles in force from the bus.

Role view: `{id, builtIn: false, name, description, permissions, requiresMfa, grantableBy, state: pending | active |
retired, version (in force, null while the first is pending), createdBy, createdAt, updatedAt, pendingVersion}`.
Version view: `{version, name, description, permissions, requiresMfa, grantableBy, dualControl, state: pending |
applied | rejected | withdrawn | superseded, proposedBy, proposedAt, decidedBy, decidedAt, note}`.

| Method and path | What it does |
| --- | --- |
| `GET /api/authz/roles` | `{builtIn: [matrix role], custom: [role view]}`; `?retired=true` includes retired roles |
| `POST /api/authz/roles` `{name, description?, permissions, requiresMfa?, grantableBy?}` | `201 {role, version, pending}`. `grantableBy` defaults to `["system-admin", "tenant-admin"]`. A name taken by a built-in or live custom role is `409`. Audited `authz.role.created`, or `authz.role.proposed` under dual control (the other holders of `roles:manage` are notified) |
| `GET /api/authz/roles/:id` | The role view and `versions` (newest first) |
| `PATCH /api/authz/roles/:id` `{name?, description?, permissions?, requiresMfa?, grantableBy?}` | A new version: `{role, version, pending}`. `409` while another version is pending. Audited `authz.role.updated` (with the diff) or `authz.role.proposed` |
| `DELETE /api/authz/roles/:id` | Retires it: the role view. `409` while a user holds it, a group mapping or a pending invitation grants it. Audited `authz.role.retired` |
| `GET /api/authz/roles/:id/versions/:version` | One version view |
| `GET /api/authz/roles/:id/diff?from&to` | `{from, to, permissions: {added, removed}, grantableBy: {added, removed}, fields: {name?, description?, requiresMfa?: {from, to}}}`; `to` defaults to the newest version, `from` to the one before |
| `POST /api/authz/roles/:id/versions/:version/approve` `{note?}` | Dual control: another admin, holding every permission of the version, puts it in force: the role view. Your own change is `403` `step: dual-control`. Audited `authz.role.approved` |
| `POST /api/authz/roles/:id/versions/:version/reject` `{note?}` | Rejects a pending version (its proposer withdraws it): the version view. A role whose first version is rejected is retired. Audited `authz.role.rejected` or `authz.role.withdrawn` |

### Effective access (B-3303)

Each cell is `policy.explain` for the principal a request from that user (or with that API key) would carry and a
resource standing for the workspace: the tenant, the workspace's label ceiling (or `label`), and the ceiling of
`zone` when given. `member` says whether the subject may act in the workspace at all. Workspaces above the caller's
clearance are left out (at most 100 per answer).

| Method and path | What it does |
| --- | --- |
| `GET /api/authz/access?workspaceId&permissions&userId&q&label&zone&keys&limit&offset` | `{permissions, workspaces: [{id, name, labelCeiling}], resource: {label, zone: {name, ceiling} \| null}, total, limit, offset, rows: [{subject, cells: {<workspaceId>: {member, allow: [permission], deny: {<permission>: step}}}}]}`. `subject`: `{kind: user \| api_key, userId, username, displayName, apiKeyId, apiKeyName, active, roles, clearance, scopes}`; an inactive subject (disabled, sanctioned, revoked or expired key) is denied everything at `role`. `permissions` is a comma list (default all), `keys=true` adds a row per live API key, `limit` 1 to 100 (default 25) users per page. An unknown zone is `400` |
| `GET /api/authz/access/explain?userId&apiKeyId&workspaceId&permission&label&zone` | One cell in full: `{subject, workspace: {id, name, labelCeiling, member}, resource: {label, zoneCeiling}, decision: {allow, step, reason, action, policy}, steps: [{step, ok, detail}]}` |
| `GET /api/authz/who-can?permission&workspaceId&label&zone&limit&offset` | Users holding a role that grants the permission: `{permission, workspace, resource, roles (the granting role ids), total, limit, offset, users: [subject + {grantedBy, member, decision: {allow, step, reason}}]}`, allowed ones first within the page |

### Access reviews (B-3305)

A campaign certifies the direct grants in its scope (`kinds`: roles, workspace memberships or both; optionally only
some roles, or only the members of one workspace). Roles in scope are those named, else every role the creator may
grant; naming one the creator cannot grant is `403`. Grants from group mappings or the directory are reviewed at the
mapping. When the campaign opens, each grant becomes an item with its own reviewers:

- the admins of the grant: for a workspace membership, the tenant admins (holders of `tenant:manage`) and the members
  of that workspace holding `roles:manage`; for a role, the tenant admins;
- the member's directory manager, when their user store names one and that manager is an active user linked to the
  same store (LDAP: the `managerAttribute` of the store, default `manager`, a DN; SQL user tables: the
  `columns.manager` column, holding the manager's id column value). Sign-in and directory sync keep it; an empty
  attribute means only the admins are assigned;
- the campaign's extra reviewers (`reviewerIds`, optional).

Nobody is assigned their own grant (and deciding it is `403` `step: self`); when that leaves nobody, the tenant admins
are assigned, then the campaign's creator. Any assigned reviewer may decide; the first decision stands, and a later
one is `409` naming who decided (`decision`, `decidedBy`, `decidedAt` in the problem). A revoke removes the grant at
once: it is gone on the member's next request, and their sockets leave the permission rooms it gave. Deciding every
item closes the campaign. Each assigned reviewer is notified when it opens. The `authz.reviews` job (every five
minutes) opens scheduled campaigns and escalates an open one past its due date, once, to the tenant admins
(notification `authz.review.overdue`). Closing a campaign with `everyDays` schedules the next one `everyDays` after
this one opened. Audited `authz.review.created`, `opened`, `confirmed`, `revoked`, `escalated`, `closed` and
`cancelled`.

Review view (`reviewers` are the extra reviewers): `{id, name, state: scheduled | open | closed | cancelled, scope: {kinds, roles, workspaceId}, reviewers,
opensAt, dueDays, dueAt, everyDays, overdue, escalatedAt, counts: {total, decided}, nextId, createdBy, createdAt,
openedAt, closedAt}`.

| Method and path | What it does |
| --- | --- |
| `GET /api/authz/reviews?state&limit&offset` | Signed in. Review views: all of the tenant's for holders of `roles:manage`, else those with at least one item assigned to the caller |
| `POST /api/authz/reviews` `{name, kinds?, roles?, workspaceId?, reviewerIds?, opensAt?, dueDays?, everyDays?}` | `201` review view; opens at once unless `opensAt` (ISO time) is in the future. `dueDays` 1 to 90 (default 14), `everyDays` 7 to 366. At most 5000 grants (`409`: narrow it) |
| `GET /api/authz/reviews/:id?decision&limit&offset` | Signed in, for holders of `roles:manage` (every item) and assigned reviewers (their items only); else `404`. The review view and `items: [{id, user: {id, username, displayName}, kind: role \| workspace, grant: {id, name}, decision: pending \| confirmed \| revoked \| expired, reviewers, manager, decidedBy, decidedByName, decidedAt, note, removed}]` |
| `POST /api/authz/reviews/:id/items/:itemId/decision` `{decision: confirm \| revoke, note?}` | An assigned reviewer's decision: `{id, decision, decidedBy, decidedAt, note, removed}` (`removed` false when the grant was already gone). Not assigned: `403` `step: reviewer`. Already decided: `409` naming who decided first; campaign not open: `409` |
| `POST /api/authz/reviews/:id/open` | Opens a scheduled campaign now: the review view |
| `POST /api/authz/reviews/:id/close` | Closes it (undecided items expire and their grants stay) or cancels a scheduled one: the review view |

### Route permission registry (B-3304)

`server/src/authz/routes.ts` declares, for every route the server registers, the permission it requires (or several,
all required; `{anyOf}` when one of several suffices), `authenticated` (any signed-in caller; the handler decides) or
`public`. `server/test/route-registry.test.ts` walks the Express app and fails for a route missing from the table, an
entry for a route that is gone, or a route whose `requireAuth`, `requirePermission` or `requireAnyPermission`
middleware disagrees with its entry. `npx tsx server/test/route-registry.ts --write` adds missing routes with what
their middleware implies, for review.

## Sprint 30 (1.5.0): MongoDB connections (B-3602)

`engine: mongodb` on `POST /admin/connections` (`connections:manage`, same routes, checks and audit as the other
engines). `endpoint` is `host:port` (27017 by default); `database` is required and is the only database read. The
account is a sealed username and password or a `vault:` password reference (B-1705); it authenticates against the
connection's database (as a URI naming that database would) unless the username is written `<authdb>/<user>`, such as
`admin/reader`. `baoRole` is refused (`409`): OpenBao dynamic credentials are for
PostgreSQL and MySQL. Zones and `CONNECTIONS_ALLOWED_HOSTS` apply as for the other engines: the host is resolved and
checked once and the checked address is dialled (TLS still verifies the name), with one direct connection (no
replica-set discovery), no retries and the connection's timeout as the server-selection, connect and `maxTimeMS` limit.

- `POST /admin/connections/:id/test`: `ping`, `buildInfo` and `connectionStatus` with privileges. `readOnly: false` (and
  `degraded`) when the account holds a write action (`insert`, `update`, `remove`, index or collection changes, user
  administration, `anyAction`) or the server takes connections without an account; `degraded` when the account cannot
  `find` in the database; `unreachable` with the scrubbed driver message on a failed connection or authentication.
- `POST /admin/connections/:id/schema`: the database's collections and views (not `system.*`), with top-level fields and
  types sampled from the first 20 documents of each of the first 200 collections.
- `PUT /admin/connections/:id/allow-list`: collection names (case-sensitive) or patterns such as `orders_*`.
- `POST /admin/connections/:id/query` (and `/export`): `query` is JSON, `{"find": "<collection>", "filter": {…},
  "projection": {…}, "sort": {…}, "limit": n, "skip": n}` or `{"aggregate": "<collection>", "pipeline": [ … ]}`; with
  `object` (the collection picked in the schema tree) a bare object is the filter of a find on it. Values may use
  relaxed extended JSON (`{"$date": "…"}`, `{"$oid": "…"}`). Pipeline stages must be one of `$match`, `$project`,
  `$addFields`, `$set`, `$unset`, `$group`, `$sort`, `$limit`, `$skip`, `$count`, `$unwind`, `$lookup`, `$graphLookup`,
  `$unionWith`, `$facet`, `$bucket`, `$bucketAuto`, `$sortByCount`, `$replaceRoot`, `$replaceWith`, `$sample`,
  `$redact`, `$setWindowFields`, `$densify`, `$fill`, `$geoNear`; collections read through `$lookup`, `$graphLookup` and
  `$unionWith` (also in sub-pipelines and `$facet`) must be on the allow-list. Refusals (`422`, audited as
  `connection.query.refused`): `kind: write` for write commands, mongosh write methods (`db.orders.updateMany(…)`),
  `$out` and `$merge`; `kind: ddl` for `drop`, `create`, index and collection changes; `kind: denied` for a stage off
  the list, a collection off the allow-list, `system.*`, another database, `$where`, `$function`, `$accumulator`,
  `$code` and `mapReduce`; `kind: unparsed` for anything else (not JSON, mongosh read syntax, unknown keys), which
  cannot be confirmed. Reads fetch the row limit plus one (`$limit` appended to a pipeline), with `maxTimeMS`; documents
  become rows over the union of their top-level fields, sub-documents as JSON. Masking applies as for the other engines,
  inside sub-documents too.

Knowledge sources (`POST /knowledge/bases/:id/sources`, `kind: database`): on a MongoDB connection `location` is
`mongo: <collection>` or the bare collection name (introspected and allowed), and `fields` (1 to 50, dotted paths
allowed) names the fields whose text becomes the document; without `fields`, the text fields of the sampled schema other
than the id, watermark and access fields are indexed (`400` when there are none). `idColumn` is the id field (`_id` by
default), `watermarkColumn` an optional field that grows on every change (`updatedAt` or `updated_at` when the sampled
schema has one; `null` keeps none, so every sync reads the collection again), compared after the stored watermark as a
date, number, ObjectId or text; `accessColumn` and `accessKind` name a field listing the groups or users who may
retrieve each document (an array or a list, as for B-1002). Only the id, the fields, the watermark and the access field
are fetched. `replication` and `roleMappings` are refused (`409`). Documents carry at least the connection's label.
`GET /knowledge/connections` lists MongoDB connections with the allowed collections and their sampled fields.

## Sprint 30 (1.5.0): CalDAV and CardDAV (B-3101 to B-3104)

New permissions `calendars:read`, `calendars:write` (personal calendars), `contacts:read`, `contacts:write` (the
directory address book and personal address books); members and tenant admins hold them. Group events stay under
`groups:read` and `groups:write`. The protocols themselves are at `/dav` and are described in `docs/dav.md`; only
app passwords are JSON API routes. Migration `032_dav`.

### App passwords (B-3101)

An app password authenticates DAV clients (HTTP Basic, with the account's username) at `/dav` and nowhere else:
`/api`, `/v1` and the console refuse it. It carries DAV scopes (`caldav`, `carddav`, `webdav`), narrowed on every
request to what the owner's roles grant then. Roles that require MFA may have them, but creating one needs a browser
session whose second factor was confirmed within `STEPUP_WINDOW_SECONDS` (signing in with a factor, or
`POST /me/step-up` with a TOTP code or a passkey; a password step-up does not count): `401` with `step_up: true` and
`factor: true` otherwise, and `403` (`step: mfa`) for an account with no second factor. Created and revoked passwords
send a security notice and are audited (`dav.app_password.created`, `dav.app_password.revoked`).

| Method and path | What it does |
| --- | --- |
| `GET /api/me/app-passwords` | The caller's app passwords: `[{id, name, prefix, scopes, state, createdAt, expiresAt, lastUsedAt, lastUsedIp, lastUsedAgent, revokedAt}]`; `state` is active, expired or revoked (kept listed 30 days) |
| `POST /api/me/app-passwords` | `{name, scopes: ['caldav' \| 'carddav' \| 'webdav'], ttlDays?: 30 \| 90 \| 180 \| 365 \| null}` (null: no expiry). Answers `201` with the view, `password` (`exai_d1_…`, shown once), `username` and the `server` URLs (`url`, `caldav`, `carddav`, `webdav`). At most 50 active per user |
| `DELETE /api/me/app-passwords/:id` | Revokes it: the next DAV request with it is refused (`204`) |
| `GET /api/me/dav` | For Settings (Sprint 32, B-3415): `{username, usernameWithTenant, server: {url, caldav, carddav, webdav}, scopes: [{scope, available}], stepUp: {hasFactor, windowSeconds, freshUntil}}`. `available` is whether the caller's roles grant any permission of the scope now; `freshUntil` is when the session's second-factor confirmation stops counting for creating an app password (null when it already has). `server.webdav` is the file store's collection, `/dav/files/` (B-32, Sprint 34), which answers WebDAV with a `webdav`-scoped app password |

### DAV endpoints

| Method and path | What it does |
| --- | --- |
| `GET /.well-known/caldav`, `GET /.well-known/carddav` | `301` to `/dav/` (RFC 6764; also `HEAD`, `OPTIONS` and `PROPFIND`). Public |
| `GET /dav/:path` | A calendar object (`text/calendar`) or vCard (`text/vcard`) with its `ETag`; `If-None-Match` answers `304`. Also `HEAD` |
| `PUT /dav/:path` | Stores a calendar object or contact, or answers a group event (the caller's `PARTSTAT` becomes their RSVP). `If-Match` with a stale ETag is `412` |
| `DELETE /dav/:path` | Deletes a personal object or collection; cancels a group event (moderators and owners) |
| `OPTIONS /dav/:path` | `DAV: 1, 3, calendar-access, addressbook, extended-mkcol` and the methods allowed |

## Sprint 31 (1.5.0): custom feed generators (B-3001 to B-3003) and relay commit verification (B-3604)

### Relay commit verification (B-3604)

A subscribeRepos `#commit` is believed only when it verifies (`server/src/atproto/commit.ts`, over the PDS's repository
code: the MST walk in `pds/mst.ts`, the CAR reader in `pds/car.ts`, the signed bytes in `pds/repo.ts`): every block used hashes
to its CID; the commit object (`{did, version: 3, data, rev, prev, sig}`) names the frame's repo and rev; `sig` is a
compact low-S ECDSA-SHA256 signature over the DAG-CBOR of the commit without `sig`, by the `#atproto` key of the repo's
DID document (resolved through the service URL checks, cached five minutes; fetched once more, at most once a minute
per DID, when the signature fails, in case the key rotated); and each operation the subscription uses is proven against
the signed tree root `data`: a create or update by walking the Merkle search tree to its path and finding exactly the
operation's CID (with the record block hashing to it), a delete by finding nothing there. A commit that fails is
dropped whole (none of its posts are checked, labelled or indexed; the cursor moves past it), counted in the
subscription's `counts.rejected` and `exprsn_firehose_events_total{result="rejected"}`, and audited
`atproto.firehose.commit.rejected` `{subscription, did}` with `{reason: commit | repo | resolve | document | signature |
proof | too-big, detail, seq, posts, deletes, more?}`: at most `FIREHOSE_REJECT_AUDITS` a minute per subscription, the
rest counted in `more` on the next one. Jetstream carries no signatures; a Jetstream endpoint is trusted as the
operator's choice.

### Feed generators

A tenant's feeds are served by the tenant's own AT-Protocol identity (Sprint 25) as a feed generator: its DID document
gains a `#bsky_fg` service of type `BskyFeedGenerator` at the identity's endpoint when the first feed is made (computed
for did:web; for did:plc a signed PLC operation adds it, audited `atproto.identity.service-added`). The platform's
identity serves no feeds. Each post the tenant's firehose subscriptions take, and that the moderation check passed, is
indexed by every active feed whose rules all hold:

- `authors`: DIDs (null: anyone); `collections`: NSIDs or `prefix.*` (default `[app.bsky.feed.post]`);
- `keywords`: any of them, case-insensitive, not inside a longer word (null: any text);
- `labels`: any of these in force on the post (from the tenant's labeler, its trusted external labelers, or the
  check's own verdict: block is `!hide`, warn or flag `!warn`); `excludeLabels`: none of these (default `[!hide]`).

Authors, collections and labels are checked again when a page is served, so a post outside the current rules, or
labelled later, is never served. Narrowing authors or collections deletes what no longer matches; changing the keywords
or the ranking empties the index (the post text is not kept). A delete seen on the firehose takes the post out of every
feed.

Ranking (optional) orders a feed by a score instead of newest first, and `minScore` drops posts below it:
`{kind: embedding, profile, query, minScore?}` is the cosine similarity of the post to `query`, both embedded through
the gateway by the embedding model the profile routes to (the profile must handle the subscription's label);
`{kind: classifier, classifier, label, minScore?}` is a guardrail classifier's score for one of its labels. A post whose
ranking fails is not indexed (`counts.rankFailed`, `lastError`).

The index keeps the post URI, author, collection and a sort key (the time indexed, or the score × 1e9). Pages run by
(sort, id) descending; the cursor is the last row's `<sort>::<id>` and the next page starts strictly after it, so a
cursor never repeats a post however many arrive meanwhile. Rows older than `retentionHours` are not served and, with
anything beyond `maxItems`, are pruned every `FEED_PRUNE_MINUTES` (job `atproto.feeds.prune`).

A feed is `{id, rkey, uri, displayName, description, subscriptionId, rules, ranking, retentionHours, maxItems,
ratePerMinute, auth: optional | required, state: active | paused, rev, record, published, counts: {indexed, served,
rankFailed, items?}, lastError, createdAt, updatedAt}`. `uri` is `at://<publisher or generator DID>/app.bsky.feed.generator/<rkey>`;
`record` is the `app.bsky.feed.generator` record to publish (B-3004): `{$type, did: <the generator's service DID>,
displayName, description?, createdAt}`; `published` is `{did, uri, cid, at}` once recorded, after which only that URI
names the feed. The generator is `{ready, reason, did, method, endpoint, serviceId: '#bsky_fg', serviceType:
'BskyFeedGenerator', advertised}`.

### Feeds (`firehose:manage`)

| Method and path | What it does |
| --- | --- |
| `GET /api/atproto/feeds` | `{generator, feeds: [feed]}` (each with `counts.items`) |
| `POST /api/atproto/feeds` `{rkey, displayName, description?, subscriptionId?, rules?, ranking?, retentionHours?, maxItems?, ratePerMinute?, auth?, state?}` | B-3002. `rkey` 1 to 15 letters, digits or hyphens; `displayName` at most 24 characters, `description` 300; `retentionHours` 1 to 8760 (72); `maxItems` 10 to `FEED_ITEMS_MAX` (10,000); `ratePerMinute` 1 to 100,000 (300). A ranking whose profile does not route to an embedding model, or whose classifier lacks the label, is `400` with `step: ranking`. Without the tenant's own identity `409` with `step: identity`; a key in use or more than `FEEDS_MAX_PER_TENANT` feeds `409`. Audited `atproto.feed.created`. `201` |
| `GET /api/atproto/feeds/:id` | The feed |
| `PATCH /api/atproto/feeds/:id` `{displayName?, description?, subscriptionId?, rules?, ranking?, retentionHours?, maxItems?, ratePerMinute?, auth?, state?}` | Rules are merged field by field. Audited `atproto.feed.updated` (with `removed` when the index shrank) |
| `DELETE /api/atproto/feeds/:id` | The feed and its index. Audited `atproto.feed.deleted`. `204` |
| `GET /api/atproto/feeds/:id/skeleton?limit=1-100 (50)&cursor` | A preview page, as getFeedSkeleton serves it (not counted as served) |
| `PUT /api/atproto/feeds/:id/publication` `{did, uri, cid?}` | B-3004 records where the generator record was published (or an admin who published it from an external account); `uri` must be `at://<did>/app.bsky.feed.generator/<rkey>`. Audited `atproto.feed.published` |
| `DELETE /api/atproto/feeds/:id/publication` | Forgets it. Audited `atproto.feed.unpublished` |

### Public XRPC (no session; `ATPROTO_PUBLIC_RATE_PER_MINUTE` per address, shared with the labeler routes)

| Method and path | What it does |
| --- | --- |
| `GET /xrpc/app.bsky.feed.describeFeedGenerator`, `GET /atproto/:key/xrpc/app.bsky.feed.describeFeedGenerator` | `{did, feeds: [{uri}]}`: the active feeds of the tenant identity for this host (or path). `404 NotFound` where no identity is served |
| `GET /xrpc/app.bsky.feed.getFeedSkeleton`, `GET /atproto/:key/xrpc/app.bsky.feed.getFeedSkeleton` `?feed=<at-uri>&limit=1-100 (50)&cursor` | B-3001, B-3003. `{cursor?, feed: [{post}]}`. `Authorization: Bearer <service JWT>` from the AppView: `alg` ES256K or ES256, signed by the issuer's `#atproto` key (its DID document through the service URL checks), `aud` the generator DID or `<did>#bsky_fg`, `exp` in the future and at most an hour away, `lxm` (when given) `app.bsky.feed.getFeedSkeleton`. A token that does not verify is `401` (`BadJwt`, `BadJwtSignature`, `BadJwtAudience`, `JwtExpired`, `BadJwtLexiconMethod`) whatever the feed; a feed with `auth: required` answers a request without one `401 AuthenticationRequired`. `400 UnknownFeed`, `InvalidRequest`, `BadCursor`; `429 RateLimitExceeded` over the feed's `ratePerMinute` (shared counters, with `Retry-After`). Metric `exprsn_feed_requests_total{method, result}` |

Audit actions are in the event catalogue's `atproto.*` group. Configuration: `FIREHOSE_REJECT_AUDITS` (20),
`FEEDS_MAX_PER_TENANT` (20), `FEED_ITEMS_MAX` (50,000), `FEED_PRUNE_MINUTES` (15; 0 never).

## Sprint 31 (1.5.0): the AT-Protocol PDS (B-2901 to B-2906, B-3004)

Exprsn-AI hosts AT-Protocol repositories. The protocol endpoints are at `/xrpc` and are described, with hosting,
accounts, the firehose, migration and how labels apply, in [`docs/pds.md`](pds.md). This section lists the JSON API.
New permission `pds:manage` (tenant admins): the tenant's hosting settings, its accounts, invite codes and published
feed generator records. Members manage their own account with `atproto:link`. Turning hosting on or off is
`platform:manage` with a recent sign-in. Errors from the PDS carry `error` (the XRPC error name) as an extension.
Every change is audited (`pds.*`; the event catalogue's `pds.*` group, catalogue version 7). Migration `033_pds`.

An account view is `{id, did, handle, state: active|deactivated|takendown, stateReason, takedownAction, migrating,
userId, username?, email, didMethod: plc|web, signingKey, rotationKey (did:key), custody: signer|openbao, curve:
secp256k1|p256, rev, commit, records?, createdAt, updatedAt, deactivatedAt, takendownAt}`. A hosting view is
`{enabled, zone, handleDomain, inviteRequired, blobMaxBytes, blobTypes, enabledBy, enabledAt, updatedAt}`.

### Hosting (platform admins)

| Method and path | What it does |
| --- | --- |
| `GET /api/admin/pds/tenants` | Every tenant's hosting view (with `tenantId`, `slug`, `name`) and the service: `{did, endpoint, handleDomain, zone, custody, relays: [{relay, lastAt, lastStatus, lastError}]}` |
| `PUT /api/admin/pds/tenants/:tid` | `{enabled, zone?}`. Enabling fixes the handle domain `<tenant>.<PDS_HANDLE_DOMAIN>`; refused (`409`) in an air-gapped deployment, a zone without egress, without a signer or OpenBao, or when the domain is not a usable domain. Disabling is refused while active accounts remain. Audited `pds.hosting.enabled` / `pds.hosting.disabled` |
| `POST /api/admin/pds/crawl` | Sends `com.atproto.sync.requestCrawl` to every relay in `PDS_RELAYS` now: `{host, relays: [{relay, status, error}]}`. Audited `pds.crawl.requested` |

### The tenant's PDS (`pds:manage`)

| Method and path | What it does |
| --- | --- |
| `GET /api/admin/pds` | The hosting view, `accounts` counted by state, and `service: {did, endpoint, subscribeRepos, seq, custody, curves}` |
| `PATCH /api/admin/pds/settings` | `{inviteRequired?, blobMaxBytes? (null: the platform's), blobTypes? (null: the platform's)}`, within `PDS_BLOB_MAX_BYTES` and `PDS_BLOB_TYPES`. Audited `pds.settings.updated` |
| `GET /api/admin/pds/accounts?state&q&limit&before` | `{accounts: [view]}`, newest first; `q` matches part of a handle or a whole DID |
| `GET /api/admin/pds/accounts/:id` | One account view |
| `POST /api/admin/pds/accounts/:id/deactivate` | `{reason}`. The repo answers `RepoDeactivated`, sessions end. Audited `pds.account.deactivated` |
| `POST /api/admin/pds/accounts/:id/activate` | Audited `pds.account.activated` (a migrated account only once its DID names this PDS) |
| `POST /api/admin/pds/accounts/:id/takedown` | `{reason}`. A moderation action on the `pds-repo` object (B-1903; the owner is told and may appeal): `RepoTakendown`, blobs not served, sessions revoked, `!takedown` published on the DID (B-1610). Answers `{account, action}`. Audited `moderation.action.applied`, `pds.account.takendown` |
| `POST /api/admin/pds/accounts/:id/restore` | `{reason}`. Reverses that action: the previous state, the label withdrawn. Answers `{account, action, restored}`. Audited `moderation.action.reversed`, `pds.account.restored` |
| `GET /api/admin/pds/invites` | `{invites: [{id, hint, usesMax, uses, note, createdBy, createdAt, expiresAt, disabledAt, state: active\|expired\|used\|disabled}]}` (never the codes) |
| `POST /api/admin/pds/invites` | `{usesMax? (1), expiresInDays?, note?}`: `201` with the view and `code` (shown once). Audited `pds.invite.created` |
| `DELETE /api/admin/pds/invites/:id` | Disables the code (`204`). Audited `pds.invite.disabled` |
| `GET /api/admin/pds/feed-generators` | `{records: [{id, target: hosted\|external, accountId, repo, rkey, uri, cid, serviceDid, displayName, createdBy, createdAt, updatedAt}]}` (B-3004) |
| `POST /api/admin/pds/feed-generators` | `{target: {kind: 'hosted', accountId} \| {kind: 'external', identifier, appPassword, pdsUrl?}, serviceDid, rkey, displayName, description?, acceptsInteractions?, contentMode?}`: publishes (or replaces) the `app.bsky.feed.generator` record naming `serviceDid`; the external app password is used once and never stored. `201` with the record view. Audited `pds.feed.published`. Or `{target, feedId}` (no metadata): publishes the record of a feed defined under `/api/atproto/feeds`, built by the feed generator (its rkey, display name and description; `did` the generator's service DID, `409` while the tenant has no AT-Protocol identity, `404` for an unknown feed), and records the publication on the feed (`published`, audited `atproto.feed.published`); the response adds `feedId` |
| `POST /api/admin/pds/feed-generators/:id/withdraw` | `{identifier?, appPassword?, pdsUrl?}` (needed for an external record): deletes the record (`204`); a feed published as it forgets the publication (`published: null`, audited `atproto.feed.unpublished`). Audited `pds.feed.withdrawn` |

### One's own account (`atproto:link`, a browser session)

| Method and path | What it does |
| --- | --- |
| `GET /api/me/pds` | `{hosting: {enabled, handleDomain, endpoint}, account: view \| null, appPasswords: [{id, name, privileged, createdAt, lastUsedAt, revokedAt, state}]}` |
| `POST /api/me/pds` | `{handle}` (a name, or the full handle): creates the account (recent sign-in). `201` with the view. Audited `pds.account.created` |
| `PUT /api/me/pds/handle` | `{handle}` within the tenant's domain (recent sign-in). Audited `pds.account.handle_changed` |
| `POST /api/me/pds/deactivate`, `POST /api/me/pds/activate` | The account's own state |
| `POST /api/me/pds/app-passwords` | `{name, privileged?}`: a recent sign-in and, when the user has a second factor, one confirmed within `STEPUP_WINDOW_SECONDS` (`401` with `step_up` and `factor` otherwise). `201` with the view, `password` (`xxxx-xxxx-xxxx-xxxx`, shown once), `identifier` and `server`. At most 50 live. Audited `pds.app_password.created` |
| `DELETE /api/me/pds/app-passwords/:id` | Revokes it and its sessions at once (`204`). Audited `pds.app_password.revoked` |
| `POST /api/me/pds/plc-token` | A single-use code for `com.atproto.identity.signPlcOperation` (moving the account to another PDS), valid 15 minutes, shown once (recent sign-in): `201 {token, expiresAt}`. Audited `pds.plc.token_issued` |
## Sprint 30 (1.5.0): import repositories and model import (B-3801 to B-3803)

The server side of the import wizard (the Import screen is B-3807). New permissions: `imports:run` (browse
repositories and request imports; model, ML and knowledge admins and tenant admins; a destination also needs its own
permission, `models:manage` for a draft model), `imports:repositories` (model admins: propose, confirm and change
repositories) and `imports:review` (the new `legal-review` role, granted only by a system admin: licence exceptions and
the licence allow-list). Migration `033c_imports`. Audit actions `import.*` (also an event group). Configuration:
`IMPORT_CONNECTIVITY`, `IMPORT_PROXY_URL`, `IMPORT_ALLOWED_HOSTS`, `IMPORT_TIMEOUT_MS`, `IMPORT_PART_BYTES`,
`IMPORT_MAX_BYTES`, `IMPORT_HARVEST_MAX_ITEMS`, `IMPORT_HARVEST_TICK_MINUTES`, `IMPORT_BUNDLE_POLL_MINUTES`,
`IMPORT_BACKOFF_MAX_MINUTES`, `IMPORT_DATASET_QUOTA_GB` (`server/.env.example`).

### Repositories (B-3801)

Types (`GET /api/imports/types`): `hf` (Hugging Face compatible hub), `ollama` (Ollama compatible OCI registry), `ckan`,
`dcat` (DCAT-AP as JSON-LD), `sdmx` (SDMX 2.1 REST), `openml`, `invenio` (InvenioRDM, Zenodo), `kaggle` and `bundle`
(model files in promoted signed platform bundles). Model import is implemented for `hf`, `ollama` and `bundle`; the
others are browsable dataset catalogues until dataset import (B-3804).

A repository is **proposed** by one holder of `imports:repositories` (`state: pending`) and **confirmed** by another
(`403` `step: dual-control` for the proposer). Until then it is not browsable (`409`), not harvested and its hosts are
not on the allow-list. Confirming queues the first harvest. The base host and `extraHosts` (redirect and CDN hosts,
defaulted per type: `*.hf.co`, `cdn-lfs*.huggingface.co` for a hub, `*.r2.cloudflarestorage.com` for the Ollama
registry) are the repository's part of the staging-proxy allow-list; they cannot be changed afterwards (propose again).
`https://` only; plain `http://` only for hosts `IMPORT_ALLOWED_HOSTS` names.

The credential is a vault reference (`credentialRef: vault:<path>#<key>`, checked with the saver's vault policy) or a
value (`credential`) written into the vault at `imports/repositories/<id>` as the caller (they need vault write on that
path). It is resolved, at use, as the user who saved it (B-1705: they need `secrets:read` and the path policy), sent
only on the first request to the repository's own host, never along a redirect, and never shown again (the view has
`credential: {recorded, ref, required, kind}`). Hub and InvenioRDM tokens go as `Bearer`, Kaggle and registry
credentials (`username:key`) as Basic, CKAN keys as `Authorization`, OpenML keys as `X-API-Key`.

Harvests (`imports.harvest` job) replace the repository's catalogue snapshot in one transaction; `harvestMinutes`
(at least 15) schedules them (`imports.harvest-due`, every `IMPORT_HARVEST_TICK_MINUTES`). A source answering 429 (or
503 with `Retry-After`) puts the repository into backoff (the longer of `Retry-After` and one minute doubling per
failure, capped at `IMPORT_BACKOFF_MAX_MINUTES`): `status: rate limited`, `backoffUntil`; harvests, live search and
downloads wait for it.

Repository view: `{id, name, type, typeName, protocol, baseUrl, host, extraHosts, region, kinds, options, credential,
licencePolicy, harvestMinutes, nextHarvestAt, state: pending | active | disabled | rejected, status: unknown |
reachable | rate limited | unreachable | needs token | disabled, statusDetail, backoffUntil, liveSearch, modelImport,
snapshotAt, snapshotItems, harvestJob, requestedBy, decidedBy, decidedAt, decisionNote, createdAt, updatedAt}`.

Type options: `hf` `search`, `author`; `ollama` `models` (names to track; a registry answering `/v2/_catalog` needs
none), `maxTags`; `ckan` `query`, `fq`, `region`; `dcat`, `sdmx` `region`, `licence` (the provider's terms); `openml`
`detailLimit` (how many descriptions to read for licences); `invenio` `query` (for example `resource_type.type:dataset`);
`kaggle` `query`.

| Method and path | What it does |
| --- | --- |
| `GET /api/imports/types` | The types with kinds, protocol, example URL, default hosts, credential, live search and facet keys |
| `GET /api/imports/repositories` | Repository views |
| `POST /api/imports/repositories` `{name, type, baseUrl?, region?, kinds?, extraHosts?, options?, credentialRef? \| credential?, licencePolicy?, harvestMinutes?}` | `201` a pending repository; the other repository admins are notified |
| `GET /api/imports/repositories/:id` | One repository |
| `PATCH /api/imports/repositories/:id` `{name?, region?, options?, credentialRef?, credential?, licencePolicy?, harvestMinutes?}` | Changes it (not its hosts) |
| `POST /api/imports/repositories/:id/confirm` `{note?}` | The second admin's confirmation: the view and `harvestJobId` |
| `POST /api/imports/repositories/:id/reject` `{note?}` | Rejects a proposal |
| `POST /api/imports/repositories/:id/enable`, `/disable` | Enables or disables it |
| `POST /api/imports/repositories/:id/harvest` | `202 {jobId}` |
| `POST /api/imports/repositories/:id/check` | Probes the source (and the credential) and updates `status` |
| `DELETE /api/imports/repositories/:id` | `204`; `409` while any of its imports is in the queue |
| `GET /api/imports/proxy-allowlist?format=json\|squid` | `platform:manage`: the hosts of every confirmed repository (system admins: every tenant) plus `IMPORT_ALLOWED_HOSTS`, as `{proxy, hosts: [{host, repositories}]}` or squid `dstdomain` lines |

### Catalogue browse (B-3802)

`GET /api/imports/repositories/:id/catalog?kind&q&facet.<key>=<value>&live=auto|on|off&limit&offset` answers
`{repository, kind, query, selected, source: live | snapshot, liveReason, snapshotAt, total, limit, offset, items,
facets: [{key, label, values: [{value, count, selected}]}]}`. Items: `{itemId, name, publisher, description,
classification, licence, licenceAllowed, formats, gated, sizeBytes, updated, facets, data}`.

Facets come from the source's own taxonomy: models `classification` (the hub's pipeline tag, the registry's model
family), `format`, `licence`, `parameters`, `access` (open or gated), `library`, `family`, `quantization`; datasets
`classification` (CKAN groups, DCAT-AP themes, SDMX categorisations, OpenML task types, InvenioRDM resource types,
Kaggle and hub tags), `domain`, `format`, `licence`, `publisher`, `rows`, `region`, `updates`. Counts are disjunctive:
a value's count is the number of items matching the search and every other selected facet, which is exactly how many
rows selecting it returns. A search runs live through the proxy when the type can be searched (`hf`, `ckan`,
`invenio`, `kaggle`), the repository is reachable and not backing off, and the instance is not air-gapped; otherwise
(and with no search terms) the snapshot answers, and `liveReason` says why.

### Model import (B-3803)

The select and review steps:

| Method and path | What it does |
| --- | --- |
| `GET /api/imports/repositories/:id/item?id&revision` | The model as the source states it now: `{itemId, name, revision (the commit, or the manifest digest), files: [{name, size, pin: sha256:… \| gitsha1:…, format: gguf \| safetensors \| pickle \| onnx \| metadata \| manifest \| other, mediaType}], variants, gated, access: open \| granted \| gated, gate, licence, licenceSource, classification, family, parameters, capabilities, contextLength, source: live \| snapshot \| bundle}`. Air-gapped: from the snapshot. Rate limited: `503` |
| `POST /api/imports/repositories/:id/gate` `{item}` | Accepts a gate with the recorded token: `{item, access: granted, account, acceptedBy, acceptedAt}`; `409` `Gate pending` while the publisher has not approved |
| `POST /api/imports/plan` (the request body below) | `{repository, item, name, revision, mode, source, files (with selected), variants, selected (names), variant, sizeBytes, gated, access, gate, licence: {id, source, allowed, recorded, needsException}, label, tag, conversion: {needed, quantization}, manifestDigest, checks: [{name, result: passed \| refused \| warning \| info \| waiting, detail}], blocked, waiting}`; nothing is written |

Request body (plan and request): `{repositoryId, item, revision?, variants? (one GGUF file, or an Ollama tag),
files?, target: models, label (default internal), licence? (recorded when the source states none), attribution?, tag?,
quantization? Q4_K_M | Q5_K_M | Q8_0 | F16, poolId?, notes?, exception?: {reason}}`.

Checks, in the board's order: **Format** (only GGUF and safetensors; a pickle-only repository, a selected pickle,
ONNX or other weights, two GGUF variants, or GGUF and safetensors together are refused), **Licence** (from the card at
the pinned commit or the manifest's license layer; on the allow-list, or waiting for an exception), **Access** (the
gate), **Serving path** (classifier and speech models are refused until B-3806), **Conversion** (safetensors and
published GGUF go through the GPU training worker; refused without one), **Destination** (a valid, unused tag; the
caller's clearance; the pool's ceiling), **Size** (`IMPORT_MAX_BYTES`), **Connectivity**.

`POST /api/imports` (`imports:run` and, for a draft model, `models:manage`) answers `201` with the import, or:
`422 Import refused` (`import` holds the refused queue entry; nothing is downloaded, staged or registered), `409`
`reason: gate`, `409 reason: licence-unknown` (record `licence`), `409 reason: licence-exception-required` (send
`exception`). States: `queued`, `waiting on licence` (an exception `EXC-n` is pending; the legal reviewers are
notified), `queued for bundle` (air-gapped), `running` (`stage`: Pinning, Downloading, Converting, Registering),
`complete`, `refused`, `failed`, `cancelled`.

The `imports.model` job re-reads the source at the pinned revision (a file whose digest changed under it refuses the
import), downloads each file in parts of `IMPORT_PART_BYTES` (a retry resumes with `Range` from the stored parts),
refuses pickle by the first bytes (`\x80` protocol or a zip archive) whatever the name, and checks every file against
its pin (sha256, or the git blob id for small files). Verified files are kept content-addressed
(`imports/blobs/sha256/<hex>`). Registration: an Ollama manifest registers as `<name>:<tag>` (another registry's host
prefixed), `expected_digest` the manifest's digest, which is what the pools report; hub files are sealed as artefacts
of the import and converted (or packaged, `as-is`, for a published GGUF) by the training worker's `POST /v1/convert`
(`docs/training-worker.md`), and the digest it returns is pinned on the draft. The draft is an ordinary `draft` model
(pull, evaluate and dual-control approval on the Models screen); with `poolId` it is placed and pulled. The import's
`manifest` (`exprsn-import-manifest/1`: source, revision, files with pins and sha256, licence and its status, label,
attribution, requester, gate, model and expected digest, conversion) is signed with the KMS key `import-manifests`.

Import view: `{id, ref (IMP-2026-41), kind, repository, item, itemName, revision, target, mode, state, stage,
progress, note, files: [{name, size, pin, format, done, sha256, state}], options, checks, log: [{at, title, meta,
tone}], manifest, licence, licenceStatus: allowed | exception pending | exception granted | exception refused,
exception: {id, ref, state, decidedBy, decisionNote}, label, attribution, sizeBytes, storedBytes, jobId, model: {id,
name, state, expectedDigest}, error, requestedBy, requestedByName, createdAt, startedAt, finishedAt, updatedAt}`.

| Method and path | What it does |
| --- | --- |
| `GET /api/imports?state&kind&q&limit&offset` | `{counts: {total, running, waiting, queued}, imports}` within the caller's clearance |
| `POST /api/imports` | Requests an import (above) |
| `GET /api/imports/:id` | One import |
| `POST /api/imports/:id/cancel` | Cancels a queued, waiting or running one (a pending exception is withdrawn, stored parts discarded) |
| `POST /api/imports/:id/retry` | Retries a failed or cancelled one, resuming the downloads; a refused one is `409` |
| `GET /api/imports/exceptions?state` | `imports:run` or `imports:review`: `[{id, ref, licence, reason, state, import: {id, ref, item, itemName, state, label}, requestedBy, requestedByName, requestedAt, decidedBy, decidedByName, decidedAt, decisionNote}]` |
| `POST /api/imports/exceptions/:id/decision` `{decision: grant \| refuse, note?}` | `imports:review`. Whoever requested the import or the exception gets `403 step: dual-control`; an already decided one `409`. Granting queues the import; refusing refuses it |
| `GET /api/imports/settings` | `{allowedLicences, defaultLicences, updatedBy, updatedAt, connectivity: direct \| bundle, viaProxy, quota}` |
| `PUT /api/imports/settings/licences` `{allowedLicences}` | `imports:review`: the tenant's licence allow-list (ids are normalised; `unknown` and `other` are never allowed) |
| `GET /api/imports/quota` | `imports:run` or `usage:read`: `{maxBytes, custom, usedBytes: {datasets, models, total}, appliesTo: datasets, updatedAt}`. The quota (500 GB unless set) applies to dataset imports (B-3804); model imports are metered beside it |
| `PUT /api/admin/tenants/:tid/import-quota` `{maxBytes}` | `tenant:manage` and the system-admin role; `null` restores the default |
| `GET /api/imports/bundle-requests` | `platform:manage`: `{format: exprsn-import-requests/1, generatedAt, requests: [{id, ref, tenant, repository: {type, baseUrl, name}, item, revision, variant, manifestDigest, files, licence, path, requestedAt}]}`, what staging fetches for the next bundle |

**Bundle mode.** With `IMPORT_CONNECTIVITY=bundle` requests are planned from the snapshot and wait as
`queued for bundle`. Staging reads `GET /api/imports/bundle-requests`, fetches and scans, and ships the files in a
signed platform bundle under `imports/<import id>/` (the `models` mirror; Ollama layers as `<kind>-<12 hex>` beside
`manifest.json`; an optional `import.json` `{licence, source, item, revision}`). Once the bundle is verified and
promoted, `imports.bundle-match` (every `IMPORT_BUNDLE_POLL_MINUTES`) continues each request from the bundle's files with
the same checks; a pin recorded at request time must still match. A `bundle` repository browses and imports promoted
bundle files directly.

## Sprint 32 (1.5.0): the chain context, sub-workflow, agent, map and loop steps (B-4101, B-3901, B-3902, B-3905)

### The chain context (B-4101)

Every invocation is a node of one chain (`server/src/chain/context.ts`, tables `chains` and `chain_nodes`): a chat turn
whose answer called a tool, an agent run, a workflow run, a tool call, a skill load, a plugin action that started a
workflow, an app trigger. The first is the root; what it causes are its descendants. The rules, read from the database
so every instance gives the same answer:

- **Principal**: a child acts as the root's principal; a call that would act as someone else is refused (an app trigger
  owned by another user starts a chain of its own instead).
- **Label**: a child's label is at least the chain's high-water mark, and the mark rises with every node and every
  step output above it (a sub-workflow's result, an agent's answer). Nothing runs above a callee's ceiling: a tool call
  whose chain carries data above the tool's ceiling is refused (`tool_unavailable`).
- **Depth**: at most `CHAIN_MAX_DEPTH` (default 8; the root is depth 0) across kinds, with `WORKFLOW_MAX_DEPTH`
  (3) nested workflow runs and `AGENT_MAX_DEPTH` (3) nested agent runs as per-kind caps; `PLUGIN_MAX_DEPTH` and
  `APPS_TRIGGER_MAX_DEPTH` still apply to their own chains of events.
- **Budgets**: tokens, steps, wall time and GPU time (the cost meter) of every node are charged to the root's budgets:
  an agent root's are its run budgets, a workflow root's its graph limits (tokens, timeout; `CHAIN_MAX_STEPS` steps); a
  chat turn, plugin action, app trigger or bare tool call gets `CHAIN_MAX_TOKENS`, `CHAIN_MAX_STEPS`,
  `CHAIN_MAX_WALL_SECONDS` and `CHAIN_MAX_GPU_SECONDS`. Wall time is the time of the leaf work (model calls, tool
  calls, steps that do not hand their work to a child), so nested runs are not counted twice. Once a budget is used up
  the chain is `stopped` (audited `chain.stopped` once): nothing new begins in it, an agent run stops before its next
  thinking step (state `budget`, its error naming the root's budget), a workflow run fails before its next step. Raising
  a root agent run's budgets (`POST /api/runs/:id/resume`) raises its chain's.
- **Retries and instances**: a node is unique by `(kind, ref)` (the run id for runs) and its chain rides on the run's
  row (`chain_id`, `chain_node`), so a job retried on another instance resumes the node it began.

A refused invocation (`code`: `depth`, `kind-depth`, `principal`, `budget`, `stopped`) is audited `chain.refused`
`{chain, parent, kind, callee}` with `{rule, reason}`. A refused tool call comes back to the caller as an error
`chain_limit: …` (the model sees it as a tool error) and is recorded as a `refused` node under its would-be parent. A
refused sub-workflow, agent step or map item fails its step.

Run views carry `chain: {id, node}` and `caller: {kind, id, node}`: `GET /api/runs/:id` (agent runs) and `GET
/api/workflow-runs/:id`, which also lists `children: [{kind: workflow-run | agent-run, id, workflowId | agent, step,
state, label, error}]` (within the caller's clearance) and `items: [{nodeId, index, state, error, childRun, tokens}]` (map
and loop checkpoints). The tree view of a chain is `GET /api/chains/:id` (B-4107, Sprint 34a, below).

### New step kinds

Validated at publish with the existing codes; a reference that is not published to the workflow's workspace is
`unavailable`. Dry runs mock all four and call nothing.

| Kind | Config | Output |
| --- | --- | --- |
| `sub` | `workflow` (name or id, same workspace), `version?` (pinned; else the version published when the step runs), `input?` (field templates, one template rendering to an object, or the step's input) | `{run, output}`: the child run and the merged output of its last steps |
| `agent` | `agent` (registry name), `input?` (task template; the step's input as JSON when omitted), `budgets?` (`steps`, `tokens`, `wallSeconds`, `toolCalls`, up to the registry maximum) | `{run, text}` |
| `map` | `over` (a template rendering to a list), one action (below), `maxParallel` (1–20, default 10), `maxItems` (1–200, default 200), `as` (field name, default `results`) | `{[as]: [...], count}` in item order |
| `loop` | one action, `max` (1–40, default 5), `while?` `{left, op, right}` (branch operators, checked before every iteration) | `{iterations, last, results, stopped: condition \| max}` |

An action (map item or loop iteration) is a model prompt (`profile`, `prompt`, `format?`), a registry tool (`tool`,
`args?`; for a map without `args` the item itself, or `{item}`), or a published workflow run as a child (`workflow`,
`version?`, `input?`; default `{item, index}` for a map, `{iteration, last, results}` for a loop). Templates read
`{{item}}`, `{{index}}` (map), `{{iteration}}`, `{{last}}` and `{{results}}` (loop) as well as `input` and `steps`.

- **Sub-workflow (B-3901)**: the child runs as the parent's owner, under the higher of the step's label and the
  child workflow's, in the parent's chain (trigger `workflow:<parent run>`, `caller_kind: workflow-run`), audited
  `workflow.run.started` with `{parentRun, parentWorkflow, step}`. It runs inside the step while it can; when it waits
  on an approval the step and the parent wait, and the child's end resumes the parent with its output and label.
  Cancelling the parent cancels its waiting children (and agent runs). A workflow cannot run itself; `workflow.*`
  tools stay refused in tool steps and items; nesting is bounded by `WORKFLOW_MAX_DEPTH`.
- **Agent step (B-3902)**: starts a run of the published agent as the run's owner (audited `agent.run.started` with
  `{workflowRun, step}`), under the agent's ceiling (above it the step is blocked); the step waits without a worker and
  continues when the agent run ends; a failed, cancelled or budget-stopped run fails the step (with a typed error a
  failure edge reads, B-4106).
- **Skills on a model step (B-3902)**: `skills: [name…]` (up to 8) on a `model` step loads each published skill
  (a `skill-load` node in the chain): its instructions join the system prompt and its tools are offered through the
  dispatcher, so every call passes the tool's ceiling, its schema, the `tool-call` guardrail checkpoint and its rate
  limit. A write or destructive call runs only when an Approval step comes before the model step on every path;
  otherwise (since Sprint 34a, B-4106) the step pauses on an approval for the call. At most six rounds of calls.
  Skills load with their closure (B-4103). The step's detail lists `skills`,
  `tools`, `hidden` and `toolCalls: [{tool, ok, decision, error}]`.
- **Map and loop (B-3905)**: items run at most `maxParallel` at once; every item and iteration is a step of the chain
  (checked against the root's budgets before it starts) and its tokens count toward the run's token budget. A run's
  maps fan out over at most 200 items (`maxItems` declared on the maps are summed at publish, the real lists at run
  time); each loop iteration beyond the first counts toward the 40-step limit at publish. Each item's result is a
  checkpoint (`workflow_items`, sealed) so a map resumes without running finished items again. Items never pause one
  by one: a write tool in a map or loop needs an Approval step before it on every path (refused at publish otherwise),
  and child workflows that wait leave the step waiting until all are done. The first failing item fails the step.

| Method and path | What it does |
| --- | --- |
| `GET /api/workflow-callees` | `agents:run`. What the new steps may call from the current workspace, within the caller's clearance: `{workflows: [{id, name, label, version, input}], agents: [{name, version, description, label, budgets}], skills: [{name, version, description, label, tools}], limits: {chainMaxDepth, workflowMaxDepth, maxItems, maxParallel}}` |
## Sprint 32b (1.5.0): workflow triggers, failure handling and bundles (B-3903, B-3906, B-3909)

**Triggers on the workflow itself (B-3903).** The trigger step takes two more sources: `{source: event, event}` (a
catalogue event type such as `file.uploaded`, or a group such as `file.*`; not `*`) and `{source: schedule, cron}` (five
fields, UTC; a `schedule` trigger without `cron` is still started by an app's schedule trigger). Publishing checks the
event against the catalogue (`config`; a reserved type is a warning) and the cron expression, and writes the version's
trigger; republishing with another source removes it. Runs start as the person who published the version (the
trigger's owner), with the roles, clearance and memberships they hold at that moment: an owner who is disabled, lost
`agents:run`, left the workflow's workspace or is not cleared for the event gets a skip (`workflow.trigger.skipped`
with the reason) instead of a run, as does an event for a version that is no longer the published one. An event run's
input is `{event: {id, type, tenant, label, createdAt, data}, trigger: {id, kind: event, depth}}` and its trigger
`event:<firing id>`; a schedule run's input is `{event: schedule, dueAt, trigger: {id, kind: schedule, depth: 1}}` and its
trigger `schedule:<firing id>`.

Event fan-out follows the plugin rules: a workflow in a workspace receives only events that name that workspace
(`data.workspace` or the audit target's `workspace`), a tenant-level workflow the tenant's events; an event above the
workflow's label is not delivered; each trigger fires at most `WORKFLOW_EVENT_RATE_PER_MINUTE` times a minute (dropped
events are counted in `exprsn_workflow_trigger_dropped_total{reason}` and audited once a window as
`workflow.trigger.throttled`); an event caused by a chain of workflows is never delivered to a workflow in that chain,
events about a workflow's own runs never start it, and an event whose chain is `WORKFLOW_EVENT_MAX_DEPTH` long is
dropped. Each delivery is a firing, unique per trigger and event id, and a `workflow.trigger` job. Schedule triggers are
checked every `WORKFLOW_SCHEDULE_TICK_SECONDS`; each due time is claimed once across instances. Audited:
`workflow.trigger.set`, `workflow.trigger.removed`, `workflow.trigger.updated`, `workflow.trigger.fired`,
`workflow.trigger.skipped`, `workflow.trigger.throttled`.

| Method and path | What it does |
| --- | --- |
| `GET /api/workflows/:id/triggers?limit` | `agents:run`. The trigger of the published version and its recent firings within the caller's clearance: `{workflowId, trigger: {id, workflowId, version, kind: event \| schedule, event, cron, schedule, ownerId, enabled, nextRunAt, lastFiredAt, lastRunId, lastResult, createdAt, updatedAt} \| null, firings: [{id, event, eventId, label, chain, state: queued \| starting \| started \| skipped, runId, reason, createdAt, finishedAt}]}` |
| `PATCH /api/workflows/:id/triggers` `{enabled}` | `workflows:manage`. Turns the trigger off or on again (a schedule's next due time is recomputed); `404` without one |

**Failure handling (B-3906).** A step may carry `retry: {max: 1-5, delayMs: 1000-3600000 (5000), backoff: fixed |
exponential (exponential)}` (not on trigger, approval, wait or branch steps; a warning on writes): a step that fails is
tried again up to `max` more times, waiting durably between attempts (the step is `waiting` with `resumeAt` and
`detail: {retryAt, retries, lastError}`; the run is `waiting`). Label-ceiling and guardrail blocks and rejections are
not retried. An edge with `branch: failure` (from any step but the trigger) is taken when its step fails for good: the
steps on it receive `{error, step}` (also readable as `{{steps.<id>.error}}`), its other edges are skipped, and the run
does not fail for it. A run (not a dry run) that fails for good is a dead letter, audited `workflow.run.dead_lettered`.

| Method and path | What it does |
| --- | --- |
| `GET /api/workflow-dead-letters?state&workflow&limit` | `workflows:manage`. Dead letters of the current workspace's workflows within the caller's clearance: `{items: [{id, workflowId, workflow, runId, nodeId, label, error, state: open \| redriven, failedAt, redrivenBy, redrivenAt, redriveRunId}]}` |
| `POST /api/workflow-dead-letters/:id/redrive` | `workflows:manage`. Replays the run from the step that failed (steps before it keep their checkpoints): `201` the dead letter, `redriven` with `redriveRunId`; `409` when it was redriven already. Audited `workflow.dead_letter.redriven` |

**Bundles (B-3909).** `exprsn-workflow/1`: `{format, exportedAt, workflow: {name, description, label}, version (null for
the draft), graph, references: {tools: [{name, version}], profiles, apps, vault, trigger}, key, signature}`, signed with
the KMS HMAC key `<OPENBAO_KEY_PREFIX>workflow-bundles` over the canonical JSON of everything but the signature. Runs,
versions, the registry tool a workflow is published as and app triggers are not part of it.

| Method and path | What it does |
| --- | --- |
| `GET /api/workflows/:id/bundle` | `workflows:manage`. The signed bundle of the published version (the draft when nothing is published), as an attachment. Audited `workflow.exported` |
| `POST /api/workflows/import` `{bundle, name?, bindings?: {tools, profiles, apps, vault}}` | `workflows:manage`. Verifies the signature before reading anything else (changed after signing, another key or no signature: `422 Bundle refused`, audited `workflow.import.refused`), re-binds each reference (`bindings` maps a name to another; otherwise it keeps its name) and creates the workflow as a draft in the current workspace: `201 {workflow, bindings: [{kind: tool \| profile \| app \| vault \| trigger, from, to, status: bound \| missing \| on publish, detail}]}`. A taken name is `409`; a vault reference the importer cannot read is `409` (bind it). The trigger starts nothing until the importer publishes the workflow. Audited `workflow.imported` |

## Sprint 32c (1.5.0): domain built-in tools, approval forms, notify and webhook steps (B-3904, B-3907, B-3908)

### Domain built-ins (B-3904)

Five platform registry tools with `impl: builtin` (published to every tenant, like `calculate`), seeded by migration
`034c_workflow_steps`. They go through the one dispatcher, so chat, agent runs, workflow tool steps and the registry
harness call them the same way: the input schema, the tool's ceiling, the `tool-call` checkpoint and the approval rule
for writes (all five are `write`; a workflow tool step pauses for its approver role unless an Approval step comes
before it on every path). Each acts as the caller through the domain service: the permission the domain's route needs,
membership and rights, clearance and label ceilings, guardrails, the audit entry and the catalogue event. Data is never
sent somewhere labelled below it: a call made with confidential data into an internal conversation, group or session
fails with `Blocked by label ceiling: …`. The registry harness (`POST /admin/registry/:id/test`) holds writing
built-ins (`needsApproval`, `sandboxed: false`) instead of acting on live data.

| Tool | Arguments | Result | Needs |
| --- | --- | --- | --- |
| `messages.send` | `{conversation \| user, body, thread?}` (`user` opens or reuses the direct conversation) | `{conversation, message, label}` | `messages:write` |
| `feed.post` | `{workspace?, group?, body}` (the caller's current workspace by default) | `{post, state, label, workspace}`; the post is at least the call's label and records its source | `feed:write` |
| `files.write_version` | `{file, content, encoding?: utf8 \| base64, type?}` (up to 1 MB) | `{file, version, state, size}`; the version goes through quarantine and the scan, at least the call's label | `files:write` |
| `groups.create_event` | `{group, title, start, end? \| durationMinutes?, timeZone, description?, location?, reminders?}` | `{event, group, startsAt, label}` | `groups:write` and the group's `events` right |
| `channels.answer` | `{channel, session, text}` | `{message, seq}` | `channels:review` |

A post made by a built-in or a plugin carries `source: {kind, id}` in its view (`GET /feed/posts/:id` and every feed
page): `workflow-run` (a workflow tool step; the run's id), `agent-run`, `message` (chat), `api-request`, `plugin`.
`feed.post.created` audits it in `detail.source`.

**Plugin broker calls.** `records.read` `{app, entity, id? | filter?, q?, limit?}`, `records.write` `{app, entity,
action?: create | update | transition, id?, values, to?, version?}`, `files.read` `{file, version?}` (`text` for text
types, `base64` otherwise, at most 256 kB with `truncated`), `groups.read` `{group, events?}` (the group and its events
for the next 90 days) and `posts.write` `{workspace?, group?, body}` answer `200` with the result. They need the
capability (`read:records`, `write:records`, `read:files`, `read:groups`, `write:posts`) and act as the user who
installed the plugin: that user must still be active and hold `records:read`, `records:write`, `files:read`,
`groups:read` or `feed:write`, their clearance is capped at the plugin's max label, and a write carries at least the
event's label (records are written with `source: plugin`, posts with `source: {kind: plugin, id}`). Bad arguments are
`400`; a plugin installed from the command line, or whose installer is gone, is `403`.

### Approval forms (B-3907)

An `approval` step takes `form: {app, form}` (names or ids): the approver fills in that app form, and the answers
become the step's output (`{…input, approved, by, answers}`; the port schema adds `answers: object`). The form must
exist and be openable by whoever saves the graph (`422`, code `reference`, at save). When the step opens, the form is
resolved as the run's owner and kept with the approval.

| Method and path | Change |
| --- | --- |
| `GET /workflow-approvals`, `GET /workflow-runs/:id` | Each approval adds `form: {app, form, title, submitLabel, fields: [{name, label, help, type, required, options?, visibleIf…}]}` (null without one) and `answers` (once decided, within the caller's clearance) |
| `POST /workflow-approvals/:id` `{decision, reason?, answers?}` | Approving a step with a form needs `answers`, validated like a submission of that form: only the visible fields are kept (the rest dropped), required ones (including those a condition shows) present, text through the `user-input` checkpoint, then the entity's types, options and links. `400` with `problems` when they do not pass (the approval stays pending); answers on an approval without a form are `400`. Nothing is written to the app. The answers are sealed with the approval, returned as `answers`, and audited in `workflow.approval.approved` `detail.answers` (at the run's label) |

### Notify and webhook steps (B-3908)

Two new step kinds, both writes (a workflow offered as a tool with one is at least `write`); a dry run mocks them.

- `notify` `{users?: [template], roles?: [role], title, body?, email?: false, route?}`, output `{notified, skipped}`.
  `users` render to user ids or usernames. Only active users of the tenant cleared for the step's label are told, and
  for a workflow in a members-only workspace only its members; the rest (and unknown names) are skipped and counted.
  The notice carries the step's label and opens `route` (`workflows?run=<id>` by default); `email: true` also mails
  it. Audited `workflow.step.notified` `{notified, skipped, email, roles}`.
- `webhook` `{url, event?: workflow.<name> (workflow.webhook), body?: {field: template} | template}`, output
  `{webhook, delivery, event}`. The URL is fixed (no templates). It is checked against the operator's and the tenant's
  outbound host rules when the graph is saved (`POST /workflows`, `PUT /workflows/:id/draft`, publish): an endpoint
  outside them is refused with `422 Workflow invalid` and `errors: [{code: config, nodeId, message: "<step>: the
  endpoint is refused by the outbound host rules: …"}]`, and nothing is saved. At run time the step queues one delivery
  through the tenant's webhook path, on a webhook managed for the workflow and endpoint (`workflow:<id>:<hash>`, no
  subscriptions, removed with the workflow): the body is `{id, type: event, tenant, label, createdAt, data: {workflow,
  run, step, data}}` (`data` the step's input or its `body`), signed with the tenant's Ed25519 webhook key
  (`X-Exprsn-Key-Id`, `X-Exprsn-Timestamp`, `X-Exprsn-Signature-Ed25519`; JWKS at `/webhooks/keys/<tenant slug>`), with
  the webhook path's retries and breaker. One delivery per run and step (a retried job does not send twice; a replay is
  a new run and sends again). Audited `workflow.step.webhook` `{host, event, delivery}`.


## Sprint 32e (1.5.0): the live Workflows screen (B-3910)

The console's Workflows screen now edits every step kind the server has (the 1.4.0 `record` step, `notify`,
`webhook`, `sub`, `agent`, `map`, `loop`, skills on model steps, approval forms, vault references in HTTP headers,
per-step retries and failure edges), sets the trigger's `event` and `schedule` sources, and shows the triggers and
callers, dead letters and bundles of Sprint 32b. Two server changes back it:

| Method and path | What it does |
| --- | --- |
| `GET /api/workflows/:id/callers` | `agents:run`. What else starts the workflow, for the Triggers and callers tab: `{workflowId, appTriggers: [{id, kind: record \| schedule, app, appName, appTitle, entity, entityTitle, events, cron, ownerId, ownerName, enabled, nextRunAt, lastRunAt, lastRunId, lastResult}] (apps the caller is cleared for), workflows: [{workflowId, workflow, label, publishedVersion, step, stepTitle, kind: sub \| map \| loop, version, in: draft \| published \| published and draft}] (other workflows of the workspace that run it), tools: [{id, name, version, status, sideEffect, label, workflowVersion}], plugins: [{id, key, name, version, state, maxLabel, installedBy, installedByName}] (granted call:workflow), lastRuns: {<kind>: {runId, at, state, trigger, count}}}`. `lastRuns` counts the last 500 runs (not dry runs) by kind of start (`manual`, `api`, `record`, `schedule`, `event`, `plugin`, `workflow`, `tool`, `replay`), the caller's own unless they hold `workflows:manage`. The workflow's own event or schedule trigger is `GET /workflows/:id/triggers` |
| `GET /api/events/catalogue` | Also readable with `workflows:manage` (besides `webhooks:manage` and `plugins:manage`): the editor picks an event trigger's type from it |

## Sprint 34a (1.5.0): chaining agents, skills, tools and workflows (B-4102 to B-4107)

Built on the chain context of Sprint 32 (B-4101): every link below is a node of the caller's chain, acts as the
chain's principal, runs at the chain's label (the high-water mark) within the callee's ceiling, and is charged to the
root's budgets. Migration `036_chains` adds `chain_nodes.decision` and `error_type` and two indexes. Server only; the
boards and live screens (B-4108, B-4109) build on the shapes here.

### Registry fields (for the registry editor)

| Kind | Field | What it is |
| --- | --- | --- |
| agent | `definition.agents: [name…]` (up to 16) | **Delegates** (B-4102): agents this agent may call. Each is offered to the model as the tool `agent:<name>` (function name `agent_<name>`, with characters outside `[A-Za-z0-9_-]` as `_`), with the delegate's `inputSchema` or `{task: string}` as its parameters |
| agent | `definition.workflows: [name…]` (up to 16) | **Workflows** (B-4104): workflows (by name or id, resolved in the run's workspace) this agent may start and await, without publishing them as tools; offered as `workflow:<name>` (`workflow_<name>`) |
| agent | `inputSchema`, `outputSchema` (JSON Schema, optional; on `POST /api/admin/registry` and `PATCH`) | The task a delegating agent sends, and the answer it gets back typed: the delegate's answer is parsed as JSON (a fenced block or the whole text) and checked against `outputSchema` |
| skill | `definition.skills: [name…]` (up to 16) | **Skill dependencies** (B-4103): skills this skill builds on. Loading a skill loads its closure |
| skill | `definition.tools` | As before; the tools of the whole closure are offered |

`GET /api/agents` (the runnable agents) adds `skills`, `agents`, `workflows` and `outputSchema`. An entry's automated
checks add **Chain references** (agents and skills): every delegate, skill and listed workflow is published (a
workflow: in the entry's workspace), no delegate or listed workflow carries data above the agent's ceiling (a
delegate's ceiling, a workflow's label: what it returns reaches the agent), and no cycle cannot terminate (below).
Approval stays disabled while it fails. Agents with an `inputSchema` or `outputSchema` also get **Schema valid**.

### Delegation (B-4102)

A call to `agent:<name>` (only from an agent run, and only to a delegate its definition lists) passes the dispatcher
like any tool call (input schema, the delegate's ceiling against the chain's label, the `tool-call` guardrail
checkpoint) and starts a child run of the published delegate: the same principal, in the chain under the call's
`tool-call` node (so `AGENT_MAX_DEPTH` and `CHAIN_MAX_DEPTH` apply), at the chain's label, with budgets no larger than
the delegating run has left (`steps` and `toolCalls` less the ones used and this call, `tokens`, `wallSeconds`), as its
own job. The delegating run pauses (its step `waiting` with `meta.awaiting: {kind: agent-run, id}`) and continues when
the child ends; the child's tokens then count against the delegating run's token budget too. Audited
`agent.run.delegated` `{run, agent, version}` with `{parentRun, parentAgent, budgets, chain}`. The tool result is
`{run, agent, answer}` (`answer` is the text, or the parsed object when the delegate declares `outputSchema`).
Cancelling a run cancels the runs it delegated to. A delegate whose ceiling is below the chain's label is not offered
(`tool_unavailable … hidden: agent:<name>, its ceiling is …`).

### Workflows an agent lists (B-4104)

`workflow:<name>` runs the version published now, in the run's workspace, as a workflow tool does (B-1006): the
trigger's schema is the input, the side-effect class is what the steps imply (a write workflow is held for approval
in the agent run like a write tool), the workspace's ceiling is the most the call may carry, and the result is `{run,
output}` (validated when the workflow ends in one step with an output schema: `meta.valid`). A workflow run that
pauses on an approval leaves the agent run waiting until it finishes. A workflow the agent does not list is refused
(`tool_unavailable: workflow_<name> is not one of this agent's tools`). `GET /api/workflows/:id/callers` adds `agents:
[{id, name, version, status, label}]` (agents, not retired, that list the workflow).

### Skills compose (B-4103)

Loading a skill (an agent's `skills`, a model step's `skills`) loads its closure: each skill it builds on, transitively,
once, depth-first in listing order with a skill's dependencies before it (their instructions come first), at most 32.
The tools of every skill in the closure are offered (deduplicated, in that order), and every skill of the closure is a
`skill-load` node of the chain. On a model step a missing sub-skill fails the step and one whose ceiling is below the
data's label blocks it.

### Chain checks at publish and "used by" (B-4105)

The reference graph is built from the registry and the published workflow versions of the tenant. Edges are
**optional** when a model chooses them (an agent's delegates, workflows and tools; a skill's tools), **closure** for a
skill's sub-skills, and **mandatory** otherwise (an agent's skills; a workflow's sub-workflow, map and loop workflows,
agent steps, model-step skills and tool steps; a workflow tool's workflow). From the entry or workflow being published:

- a cycle made only of mandatory edges cannot terminate: refused (registry: the Chain references check; workflow
  publish: `422` with an error `{code: chain, message, path: ["workflow:<id>", …]}`);
- a cycle through an optional edge can end (the model decides; `CHAIN_MAX_DEPTH` and the root's budgets bound it): a
  warning (`{code: chain, …}` in the publish response's `warnings`, or in the check's detail);
- a cycle of sub-skills ends by itself: a warning in the check's detail.

| Method and path | What it does |
| --- | --- |
| `GET /api/admin/registry/:id/used-by` | `tools:manage` or `agents:manage` (by the entry's kind). `{id, kind, name, version, status, usedBy: [RefUsedBy], otherVersions: [{id, version, status}], retireBlocked}`. `RefUsedBy` is `{kind: agent \| skill \| tool \| workflow, id, name, version, status, via, live}`: `via` is how it references the entry (`delegate`, `workflow`, `tool`, `skill`, `sub-skill`, `skill-tool`, `sub-workflow`, `agent-step`, `model-skill`, `tool-step`, `workflow-tool`), `live` whether it is published or deprecated (a workflow: its published version) and so may reach the entry now; drafts are listed with `live: false`. `retireBlocked` is true when no other published or deprecated version of the name remains and something live uses it |
| `GET /api/admin/registry/:id` | `referencedBy` now lists the referrers of every kind (as `RefUsedBy`), not only agents and skills naming a tool |
| `POST /api/admin/registry/:id/lifecycle` `{to: retired}` | `409` `Still in use` with `usedBy` when it is the last callable version of a name something live uses, naming them (`close-checklist is used by agent Closer 1.0.0; …`). A deprecation still succeeds and returns `referencedBy` |
| `GET /api/workflows/:id/used-by` | `agents:run`. `{id, name, usedBy: [RefUsedBy], deleteBlocked}`: agents that list the workflow, workflow tools, other workflows' steps |
| `DELETE /api/workflows/:id` | `409` `Still in use` with `usedBy` while a published agent or workflow uses it (a workflow tool entry does not block it; it becomes unavailable as before) |

### Approvals and failures through the chain (B-4106)

A call held anywhere pauses the chain: an agent run waits on its step's approval and every run that delegated to it (or
started the workflow it is in) waits on it; a workflow run waits on its approval and its callers wait on it. **A
model step's skills** no longer report a held call to the model: the step pauses on an approval for that call
(`approverRole` on the model step, default `workflow-admin`; `approvalTimeoutMs`, default 24 h), its state sealed in
the step (`detail.skillHold: {approval, tool, since}`); approved, the step continues from where it was and makes the
call; rejected, the model is told (`Rejected by <name>: <reason>. Nothing was run.`) and goes on; expired, the step
fails. `detail.toolCalls[]` adds `approvedBy`, and `detail.holds[]` records each decided hold.

Held calls are listed where the root is: `GET /api/runs/:id` and `GET /api/workflow-runs/:id` add `held: [ChainHeldCall]`
when the run is its chain's root and the caller is cleared for the chain's label (else `[]`), and `GET
/api/chains/:id` lists them in `held` and on each node. `ChainHeldCall` is `{node, path: [{node, kind, ref, name,
depth}] (root first), at: {kind: agent-run, run, step} | {kind: workflow-run, run, approval, step}, tool, sideEffect,
since, approvers, canDecide}`.

| Method and path | What it does |
| --- | --- |
| `POST /api/chains/:id/held/:node/decision` `{decision: approve \| reject, note?, step?, approval?}` | `agents:run`, `tools:manage`, `agents:manage` or `workflows:manage`. Decides the call held at that node where it waits, with the rules there: an agent run's write call by its owner or a tool admin, a destructive one by a tool admin other than the owner (`POST /api/runs/:id/steps/:n/decision`); a workflow approval by a holder of its role (`POST /api/workflow-approvals/:id`). `step` or `approval` picks one when the node holds several (`409` otherwise; `409` when nothing is held there). `404` for someone who can neither see the chain nor decide the call. Returns `{chain, node, at, path, decision: approved \| rejected}`. Audited `chain.held.decided` `{chain, node, run, step \| approval}` with `{decision, tool, sideEffect, depth, path}`, plus `agent.call.approved`/`rejected` or `workflow.approval.approved`/`rejected` as at the place itself |

**Typed errors.** A child's failure reaches its parent typed (`ChainErrorType`: `failed`, `budget`, `cancelled`,
`rejected`, `chain_limit`, `output`, `label`, `timeout`), recorded on the chain node (`errorType`):

- an agent sees it as a tool error whose text starts with `child_<type>:` (`child_budget: Tiny run … stopped at its
  budget: …`), the step's `detail.errorType` and the tool message's `type`;
- a workflow step that fails passes `{error, step, type}` to its failure edge (`FAILURE_PORT` adds `type`; B-3906):
  an agent step whose run stopped at its budget is `budget`, a cancelled one `cancelled`, a refused chain call
  `chain_limit`, a timeout `timeout`.

A run that another run or a workflow step awaited ended for its caller when it stopped at its budget: `POST
/api/runs/:id/resume` on it is `409` (the caller took the stop as an error and went on); replay it instead. A root run's
budget stop is resumed as before.

### The chain view (B-4107)

| Method and path | What it does |
| --- | --- |
| `GET /api/chains/:id` | `agents:run`, `agents:manage`, `tools:manage` or `workflows:manage`; the chain's principal or an agent, tool or workflow admin, within clearance for the chain's label (`404` otherwise). Returns `ChainView` (below) |
| `POST /api/chains/:id/nodes/:node/replay` `{fromStep?, fromNode?}` | `agents:run` or `agents:manage`. Replays an `agent-run` node from a step (`fromStep`, as `POST /api/runs/:id/replay`) or a `workflow-run` node from a step (`fromNode`, as `POST /api/workflow-runs/:id/replay`), each as a new chain; other kinds `409`. `202` `{kind, run, chain, label, workflowId?}`; audited `chain.node.replayed` |
| `GET /api/admin/audit?target=<id>` | `audit:read`. New filter: events whose target names the id as a whole value (a run, a chain, a registry entry); also for exports |

`ChainView` is `{id, state: running | done | stopped, stopReason, label, principal: {id, name}, budgets, used, totals,
createdAt, updatedAt, nodes (count), maxDepth, limits: {maxDepth, kindCaps}, links: {audit}, held: [ChainHeldCall],
root: ChainNode}`, where `budgets`, `used` and `totals` are `{tokens, steps, wallMs, gpuMs}` (`gpuMs` is the cost
meter). `totals` is the sum over the nodes and equals `used`: every charge goes to the node and to the root in the same
atomic increments. `ChainNode` is:

```
{ id, parent, depth, kind: chat-turn | agent-run | workflow-run | tool-call | skill-load | plugin-action | app-trigger,
  ref (the run id for runs), callee, name (a workflow run: the workflow's name), label,
  state: running | succeeded | failed | refused | waiting | cancelled, error, errorType, decision (tool calls: the
  tool-call checkpoint's action),
  usage: {tokens, steps, wallMs, gpuMs}, subtree: {tokens, steps, wallMs, gpuMs, nodes},
  createdAt, finishedAt, durationMs,
  links: {run: "/api/runs/<id>" | "/api/workflow-runs/<id>" | null, audit: "/api/admin/audit?target=<ref>" | null},
  audit?: [{id, seq, action, ts}]   (holders of audit:read only; the run's newest 20),
  guardrails: [{id, checkpoint, action, label, at}]   (decisions made in the run: agent runs by run, workflow runs by step),
  replay: null | {href: "/api/chains/<id>/nodes/<node>/replay", fromStep: [n…]} | {href, fromNode: [stepId…]},
  held: [{at, tool, sideEffect, since, approvers, canDecide}],
  children: [ChainNode…] }
```

Siblings are in the order they began. Chat turns link to their chains with B-40 in 1.7.0; Runs (agent runs) and
workflow runs carry `chain: {id, node}`, and their views list `children` (agent runs: `[{kind: agent-run, id, agent,
node, state, label, error} | {kind: workflow-run, id, workflowId, node, state, label, error}]`).

## Sprint 34b (1.5.0): WebDAV for the file store (B-3201 to B-3203)

No new JSON routes. `/dav/files/` serves the file store to WebDAV clients (`docs/dav.md`), with the app passwords'
`webdav` scope and `files:read` / `files:write`; `LOCK` and `UNLOCK` join the DAV methods (`DAV: 1, 2, 3, …`).
Migration `036c_dav_files`.

## Sprint 34c (1.5.0): profiles and presence (B-5801, B-5802)

People write a profile beyond the name their user store gives them, and say whether they are available. Reading needs
`social:read`, changing one's own `social:write` (held by members and tenant admins); an avatar also needs
`files:write`, because it is stored in the file store. Every route answers `Cache-Control: no-store`.

- **Who sees a profile.** Someone is known to people who share a workspace with them (anyone else gets `404`, as for
  the person picker). Of those, a viewer sees the pronouns, bio and avatar only when their clearance reaches the
  profile's `label` (`limited: clearance` otherwise) and, when the owner named `workspaces`, they share one of those
  (`limited: hidden` otherwise). Two people in a block (either way) see each other's name only, with `limited: hidden`
  too, so the view does not tell a blocked person they are blocked; they also see no presence.
- **Pronouns and bio** pass the `user-input` guardrail like a post (`source {kind: profile, id: <user id>}`): a block
  or a hold is `422` with `step: guardrails, field`; a redaction is what is stored.
- **The avatar** is an image (PNG, JPEG, WebP or GIF, at most 2 MiB) uploaded into the file store of the caller's
  current workspace as `Profile picture <time>.<ext>` with the profile's label, so it goes through the file store's
  quarantine (type from the bytes, text classifier, ClamAV when configured). The profile pins that version. It is
  served only when the version is `ready`, is an image, the file is not in the trash (deleted, or taken down by
  moderation) and the viewer clears the version's label; a version that fails its scan is never served.
- **Presence**: `available`, `away`, `busy` or `offline`. A person chooses one or `auto`. Chosen `offline` (appear
  offline) always reads offline; without a connected socket a person reads offline; otherwise a chosen status stands,
  and `auto` reads `away` while every socket they hold reports idle and `available` otherwise. Presence is visible to
  people who share a workspace with the person and nothing at all is told to someone in a block with them.

| Method and path | What it does |
| --- | --- |
| `GET /api/people/me` | `{userId, username, displayName, pronouns, bio, label, workspaces: [id] \| null, avatar: {fileId, version, state: quarantined \| scanning \| ready \| rejected \| gone \| not an image, url} \| null, presence: {status, effective}, updatedAt}` |
| `PATCH /api/people/me` `{pronouns?, bio?, label?, workspaces?}` | Pronouns up to 40 characters, bio up to 500 (`null` or empty clears), screened at `user-input`. `label` at most the caller's clearance (else `403 step clearance`); `workspaces` the caller's own (else `422 step workspace`; `null` or `[]` for all shared ones). Audited `profile.updated {fields, label, workspaces, redacted?}`, never the text |
| `PUT /api/people/me/avatar` (raw image body) | `202` with the profile, its `avatar.state` quarantined. Another type is `415`, more than 2 MiB `413`, no workspace `409`, no `files:write` `403`. Audited `file.upload.received` (with `via: profile`) and `profile.avatar.set {file, version, workspace, replaced?}`; the scan's `file.version.ready` or `file.version.rejected` follows |
| `DELETE /api/people/me/avatar` | Stops using it (the image stays in the file store). Audited `profile.avatar.removed` |
| `GET /api/people/:id` | `{userId, username, displayName, self, limited: null \| clearance \| hidden, pronouns?, bio?, label?, avatar: {url} \| null, presence: {status} \| null, sharedWorkspaces: [{id, name}], relation}` (`relation` as `GET /api/social/users/:id`). For oneself, the `GET /api/people/me` fields with `self: true` |
| `GET /api/people/:id/avatar?v=` | The image (`Content-Disposition: inline`, the sandbox CSP and `nosniff`), or `404` when the viewer may not see it or it is not a ready image |
| `GET /api/presence?ids=a,b` | `{statuses: {<userId>: status}}` for up to 200 people; those the caller shares no workspace with or is in a block with are left out entirely |
| `GET /api/presence/me` | `{status: auto \| available \| away \| busy \| offline, effective}` |
| `PUT /api/presence/me` `{status}` | Chooses a status; the change is published at once. Audited `presence.status.updated {before, after}` |

Over the console's socket (the same connection as the B-2603 rooms):

| Event | Direction | What it carries |
| --- | --- | --- |
| `presence.watch {userIds}` | client to server | The people to hear about (replaces the previous set, at most 200). The server keeps those the caller may see, joins their presence rooms and answers `{ok, statuses: {<userId>: status}}` |
| `presence.unwatch` | client to server | Stops every watch |
| `presence.idle {idle}` | client to server | The person went idle (the console sends it after five minutes without input or while the page is hidden) or came back |
| `presence.changed {userId, status, at}` | server to client | Someone watched (or the person themselves) changed status. Published once (`TOPICS.presence`) and relayed by every instance without the sockets of people in a block with them; a block made later takes each out of the other's presence room at once |

Every socket counts as a connection of its person while it is open; connections are kept per instance in
`presence_connections` with a 30-second heartbeat, and the rows of an instance that stopped refreshing them for 90
seconds are swept (its people read offline unless connected elsewhere). `server/src/profiles/` has `s.people`
(`ProfileService`) and `s.presence` (`PresenceService`: `statuses`, `visibleAmong`, `effective`).

## Sprint 35a (1.6.0): model servers beyond Ollama (B-4301 to B-4307)

An instance has a `kind`: `ollama` (the default, every instance from before) or `openai`, a server speaking the Chat
Completions API: Apple's `fm serve` (macOS 27, on a port or a Unix socket), `mlx_lm.server`, llama.cpp's
`llama-server`, vLLM. It joins a pool like an Ollama node. The gateway reaches every server through one interface
(`server/src/gateway/server.ts`, `ModelServer`: `version`, `models`, `loaded`, `show`, `load`, `unload`, `pull`,
`delete`, `chat`, `embed`); `OllamaClient` implements it unchanged and `OpenAIServer` (`gateway/openai-server.ts`)
maps it onto Chat Completions. What a server cannot do throws `Unsupported` and is skipped, never an error: a Chat
Completions server reports nothing resident (a model it lists counts as ready), cannot load, unload, pull or delete
(those are recorded as `unsupported` in the instance's events), is skipped by pulls onto a mixed pool and by rolling
upgrades, and offers embeddings only when its `/v1/embeddings` answers (once it refuses, embedding requests go to
another instance that has the model, such as an Ollama pool; knowledge, memory and the guard are unchanged).

Health is `GET /health`, or `GET /v1/models` when the server has no `/health`; the models are `/v1/models` (a model
`fm serve`'s `/health` lists as unavailable, Private Cloud Compute, is not offered); llama.cpp's `/props` gives the
context length. What the server reported is kept in the instance's `settings.reported`: `server`, `contextLength`,
`tools` and `jsonSchema` (from the probe), `embeddings`, `models`, `probedAt`, `probedModel`, `probeDetail`.

Chat goes to `/v1/chat/completions`, streamed: messages and the system prompt, tools and tool calls (ids kept and
each tool result paired with its call), streamed deltas (`reasoning_content` as thinking), `response_format` from a
JSON schema, stop, temperature, top_p, seed, penalties, max tokens (`num_predict`) and usage (estimated at four
characters a token when the server does not report it, as `fm serve` does not while streaming). Ollama-only options
(`num_ctx`, `keep_alive`, `think` and the rest) are not sent and recorded once per client as a `dropped` instance
event. The server-side tool loop, guardrail checkpoints, labels and metering are unchanged.

| Method and path | What it does |
| --- | --- |
| `POST /admin/pools/:id/instances` `{name, kind: ollama\|openai, url?, socketPath?, token?, tokenRef?, deploy, tls?, settings?}` | `pools:manage`. `kind openai` with `socketPath` (an absolute path; no URL, no TLS) or a `url` (the egress check and mutual TLS as for Ollama). `token` is written to the caller's vault at `model-servers/<id>#token` (needs `secrets:write` and `secrets:read`, `403` otherwise) and never returned; `tokenRef` names one already there (checked readable). It is read, at use, as the person who saved it, in their tenant. A socket, token or reference on an Ollama instance is `400`. The answer is the instance view below, with `probeJobId` (the `instance.probe` job). Audited `instance.created {kind, url, socket, deploy, mtls, token: <vault reference> \| null, probeJob}` |
| `PATCH /admin/instances/:id` `{url?, socketPath?, token?, tokenRef?, tls?, settings?, state?}` | The kind does not change. `socketPath: null` drops the socket (give a `url` with it); `tokenRef: null` clears the token. `settings.reported` is kept when `settings` is replaced. Audited `instance.updated` (never the token) |
| `POST /admin/instances/:id/probe` | `pools:manage`. `202 {jobId}`: the `instance.probe` job asks the server's first chat model for a tool call and for JSON schema output and records `tools`, `jsonSchema`, `probedAt`, `probedModel`, `probeDetail`. `409` for an Ollama instance. Audited `instance.probe.started {job}` |
| `POST /admin/instances/:id/load`, `.../unload` | On a Chat Completions server: `200 {evicted: [], unsupported: true}` and `{ok: true, unsupported: true}`, nothing sent, an `unsupported` event recorded; audited `model.loaded`/`model.pinned`/`model.unloaded` with `unsupported: true` |
| `GET /admin/model-servers` | `models:manage`. The import picker: `[{instanceId, instance, poolId, pool, poolCeiling, transport: socket\|url, token, state, health, healthDetail, version, reported, models: [{id, available, reason, ownedBy, catalogued: {id, state, held} \| null}]}]`, after polling each server. No URL, socket path or token |
| `POST /admin/models` `{serverInstanceId, serverModel, label, license?, notes?}` | `models:manage`. Registers a model the server lists: `name` and `serverModel` the server's model id, `source` `server:<instance>/<model id>`, `format` `server`, no expected digest (`400` with one), `importState` `pulled`, capabilities `completion` (and `tools` when the probe saw a tool call; `embedding` for an id with "embed"), placed warm on the instance's pool, no pull job. `409` when the server does not list it or lists it unavailable (Apple's `pcc`), `403` above the caller's clearance or the pool's ceiling, `422` for a pickle-like id. Audited `model.import.requested {format: server, server, serverModel, pool, …}` |
| `GET /admin/models` | Each model also has `held`, `serverInstanceId`, `serverModel`, and for a held model `server: {instanceId, instance, model, health, reported: {server, contextLength, tools, jsonSchema, embeddings, probedAt}}` |

Server-held models follow the catalogue's rules: the licence, the conformance run (on the instance it came from when
that one can serve it; the tool-calling test always runs for them, and passing it gives the `tools` capability), a
label ceiling, and dual-control approval (`403 step dual-control` for the requester). Placements of a held model, and
any placement on a pool with a Chat Completions server, are `warm` only (`409` otherwise); a held model is placed only
on a pool where an instance lists it; an Ollama model cannot be placed on a pool whose instances are all Chat
Completions servers. `POST /admin/models/:id/pull` on a held model checks that an instance in the pool lists it.
Retiring a held model deletes nothing on the server. Migration `037_model_servers` adds `instances.kind`,
`socket_path`, `token_ref`, `token_tenant`, `token_owner` and `models.server_instance_id`, `server_model`.

## Sprint 35d (1.6.0): tenant provisioning templates (B-4501)

A system admin creates a tenant from a template with its first admin in one step (decision Q11). Templates are code
(`server/src/tenancy/templates.ts`): `enterprise`, `team` and `personal`, exprsn-platform's organisation types. Both
routes need `tenant:manage`; provisioning also needs the `system-admin` role (`403 step role`) and a clearance that
reaches the template's highest workspace ceiling (`403 step clearance`). The CLI does the same with `exprsn-ai
tenant:create --template <id> --slug <slug> --name <name> --admin-username <name> --admin-display-name <name>
[--admin-email <address>] [--password]` (without `--password` it prints the enrolment link).

| Method and path | What it does |
| --- | --- |
| `GET /api/admin/tenant-templates` | `[{id, name, description, workspaces: [{name, description, label, visibility}], roles: [{name, description, permissions}], profiles: [{name, displayName, description, label}], zone, issuer, adminClearance}]` |
| `POST /api/admin/tenants/from-template` `{template, slug, name, directoryDn?, admin: {username, displayName, email?, password?}}` | `201 {tenant, applied, admin}`. `tenant` as `GET /api/admin/tenants/:tid`; `applied: {template, workspaces: [{id, name, label}], roles: [{id, name}], profiles: [{id, name, poolId}], zone: {id, state: pinned \| no pool in zone, poolId, poolName}, issuer: {state: created \| skipped \| not in template, id, reason}}`; `admin: {id, username, roles: [tenant-admin], clearance, enrolLink, enrolHours}`. A taken slug is `409` with nothing created; a password the policy refuses is `422` (field `admin.password`) before anything is created; an unknown template `400` |

What provisioning makes, in order: the tenant with a Local accounts store and its data key (as `POST
/api/admin/tenants`); the template's workspaces; its custom roles, built only from member-baseline permissions and
applied as version 1 (`grantableBy` tenant-admin and identity-admin); its profiles as drafts without a model, pinned
to the first pool (by name) in the template's zone whose ceiling reaches the profile's label; the tenant's issuing
intermediate (ECDSA P-256, three years) under the active platform root when the template has an issuer, the root
exists and the CA's key custody is available, else `skipped` with the reason; then the first admin, `tenant-admin`
with the clearance of the highest workspace ceiling and a direct member of every workspace, with a single-use
enrolment link (`PASSWORD_INVITE_HOURS`; `POST /api/auth/password/reset` with its token sets the password and answers
an `enroll` session) or, with `admin.password`, a password (sign-in with `{tenant, username, password}` then asks for
the second factor, stage `enroll`). Audited in the new tenant's chain and in the provisioning admin's:
`tenant.created` (`detail.template`), `workspace.created`, `authz.role.created`, `profile.created`,
`pki.intermediate.created`, `user.created`, `user.enrol_link.issued`, `workspace.member.added` and the summary
`tenant.template.applied {template, workspaces, roles, profiles, zone, issuer, admin: {user, username, enrolLink}}`.

## Sprint 35d (1.6.0): Social and messaging (B-4206)

The administrator's policies and health views for the feed, groups, messaging and relations of every workspace they
may act in (all of them for a tenant admin), behind the Social and messaging screen (`#/social`). Decisions
(`design/platform-admin/DECISIONS.md`): `social:manage` governs the feed, group, messaging and relations policies
(Q4); whether posts pass `user-input` in full and who approves held posts are the moderation-facing parts and also
need `moderation:manage` (`403 step permission`); exporting another member's conversation is under dual control, a
second platform admin approving (Q5). Realtime needs `platform:manage`. Every route answers `Cache-Control: no-store`.
Migration `037d_platform_social`; `server/src/social/admin.ts` is `s.socialAdmin`.

**Workspace policies** apply where they belong. Without a row a workspace has the defaults shown.

| Field | Default | Where it applies |
| --- | --- | --- |
| `feedGuard` | `true` | Posting: `false` checks posts labelled internal or below against the platform baseline only (the engine's `meta.baselineOnly`); anything above internal, and every comment, is still checked in full |
| `feedApprover` | `reviewers` | Deciding a held post (`POST /api/flags/:ref/decide`): `reviewers` is any flag reviewer (`flags:review`), `feed` needs `feed:manage`, `guardrails` `guardrails:manage`, `moderators` `moderation:review` (`403 step approver, permission`) |
| `feedMedia`, `feedMediaMaxBytes` | `true`, `null` | Posting with media: off is `422 step workspace-policy`; a file larger than the limit too. Turning media off clears the limit |
| `groupCreate` | `members` | `admins`: creating a group needs `groups:manage` or `social:manage` (`403 step workspace-policy`) |
| `groupVisibility`, `groupJoin` | `private`, `request` | A new group without them (`visibility` and `joinMode` are now optional on `POST /api/groups`) |
| `eventCapacity` | `null` | A new event without `capacity` |
| `contactRule` | `workspace` | Starting a conversation or adding someone: `contacts` needs mutual follows, `admins` needs `social:manage` or `tenant:manage`; one shared workspace that admits the caller is enough, and each person's own contact rule and blocks still apply (the same `403` words) |

**Tenant settings**: the weekly digest's `digestProfile` (before `FEED_DIGEST_PROFILE`; a workspace's own digest
profile still comes first), `digestDay` (0 Monday to 6 Sunday) and `digestHour` (UTC: the digest week ends at the
latest such time, Monday 00:00 by default), `digestTop` (before `FEED_DIGEST_TOP`), `digestMaxLabel` (before
`FEED_DIGEST_MAX_LABEL`, at most the caller's clearance), and `summaryProfile` for messaging summaries (before
`MESSAGING_SUMMARY_PROFILE`). A profile must resolve through the gateway (`422` with `field`). `null` restores the
environment's value.

| Method and path | What it does |
| --- | --- |
| `PUT /api/admin/social/policies/:workspaceId` `{feedGuard?, feedApprover?: reviewers \| feed \| guardrails \| moderators, feedMedia?, feedMediaMaxBytes?: 1024 to 1 GiB \| null, groupCreate?: members \| admins, groupVisibility?, groupJoin?, eventCapacity?: 1 to 100000 \| null, contactRule?: workspace \| contacts \| admins}` | The policy after the change. A workspace the caller does not administer is `404`. Audited `social.policy.updated {changed, before, after, weakened?: feedGuard}` |
| `PUT /api/admin/social/settings` `{digestProfile?, digestDay?, digestHour?, digestTop?: 1 to 50, digestMaxLabel?, summaryProfile?}` | The settings after the change. Audited `social.settings.updated {changed, before, after}` |
| `GET /api/admin/social/feed` | `{counters: {postsToday, held, commentsToday, reactionsToday, trendingTags}, workspaces: [{id, name, label, feedGuard, feedApprover, feedMedia, feedMediaMaxBytes, postsToday, held}], trending: {minutes, hours, lastRun, tags: [{tag, posts, people, excluded}]}, digest: {settings, effective: {digestProfile, digestDay, digestHour, digestTop, digestMaxLabel, summaryProfile}, profiles: [name], last: {id, workspaceId, state: ready \| empty \| failed, profile, error, posts, weekStart, createdAt} \| null}, canModerate}`. Counts and tags only at labels the caller is cleared for |
| `POST /api/admin/social/trending/exclusions` `{tag}` | `201 {tag, excluded: true}` (the tag normalised; already excluded answers the same). An excluded tag leaves `GET /api/feed/trending` at once and the `feed.trending` job leaves it out; it still works on posts and in hashtag feeds. Audited `feed.trending.excluded` |
| `DELETE /api/admin/social/trending/exclusions/:tag` | `{tag, excluded: false}`. Audited `feed.trending.included` |
| `POST /api/admin/social/trending/run` | `202 {jobId}`: the `feed.trending` job for the tenant now (requests within the same minute share one job). Audited `feed.trending.requested` |
| `POST /api/admin/social/digest/test` | `202 {jobId, workspaces}`: the `feed.digest` job in test mode over the workspaces the caller administers that have a digest profile: the last seven days ranked and summarised, sent to the caller alone as a notification (never above their clearance); nothing is stored or posted. No workspace with a profile is `409`. Audited `feed.digest.test-requested` |
| `GET /api/admin/social/groups` | `{settings: {requestDays, inviteDays, feedPerMinute, feedMaxLabel}, defaults: [{workspaceId, name, groupCreate, groupVisibility, groupJoin, eventCapacity}], groups: [{id, name, workspaceId, workspace, label, visibility, joinMode, state: active \| hidden \| archived, members, pending, upcomingEvents, openReports, feeds, owners: [{userId, displayName}], createdAt}], above, feeds: [{id, kind: event \| group \| user, targetId, name, issuedTo: {userId, username, displayName}, label, createdAt, lastUsedAt, revokedAt, state}]}`. Groups above the caller's clearance are counted in `above`, not listed; feeds of groups and events outside the caller's workspaces or clearance are left out |
| `GET /api/admin/social/groups/:id/members` | `{id, name, state, members: [{userId, username, displayName, role}]}` (for the transfer picker) |
| `POST /api/admin/social/groups/:id/transfer` `{userId}` | `{id, owners: [userId], moderators: [previous owners]}`. The new owner must be a member (`422 step member`); an archived group is `409`. The members are told. Audited `group.ownership.transferred {before, after}` |
| `POST /api/admin/social/groups/:id/archive` | `{id, state: archived, members}`: read only from now on. Members keep reading posts and events; posting, commenting, reacting, reposting, joining, inviting and scheduling answer `409`; pending requests and reminders are cancelled; calendar feeds keep the events. The members are told. Audited `group.archived {members, requestsCancelled, remindersCancelled}` |
| `POST /api/admin/social/calendar-feeds/:id/revoke` | The feed view with `url: null`: its signed URL answers `404` on its next fetch. Audited `calendar.feed.revoked` (`detail.via: social-admin`) |
| `GET /api/admin/social/messaging` | `{retention: [{workspaceId, name, days, source: workspace \| tenant \| none}], limits: {maxMembers, attachmentMaxBytes, signalsPerMinute}, search: {keyword, semantic, embedModel}, summary: {profile, effective, maxMessages, profiles}, relations: {blocks, mutedConversations, exported}, exports: [export], approvers: [{userId, displayName, username}], canApprove}` |
| `GET /api/admin/social/conversations?q=` | Up to 200 conversations the caller may ask to export: group conversations in a workspace they administer and direct ones with a member in one, at labels they are cleared for, most recent first: `[{id, kind, title, workspace, members, label, lastMessageAt}]` (group titles, or the people's names; never a message) |
| `POST /api/admin/social/exports` `{conversationId, reason: 10 to 2000 characters, approverId}` | `201` export, `state: pending`. Needs a recent sign-in (`401 step_up`). The approver is another platform admin of the tenant (`403 step dual-control` for oneself, `422 field approverId` otherwise); one pending request per conversation (`409`). The reason is sealed; the approver is notified. Audited `messaging.export.requested {reason}` |
| `POST /api/admin/social/exports/:id/approve` `{note?}` | `platform:manage`, a recent sign-in, and not the requester (`403 step dual-control`). Queues the job `messaging.conversation.export`. Audited `messaging.export.approved` |
| `POST /api/admin/social/exports/:id/reject` `{note?}` | `platform:manage`, not the requester. Audited `messaging.export.rejected` |
| `POST /api/admin/social/exports/:id/withdraw` | The requester only, while pending. Audited `messaging.export.withdrawn` |
| `GET /api/admin/social/exports/:id/download` | The requester only (`404` for anyone else), once `ready`: `text/csv` with `message, sent, author, author_name, thread, reply_to, state, edits, attachments, label, text` (deleted messages as rows without text, attachments as file ids, cells defused against formulas, at most 50 000 messages). Audited `messaging.export.downloaded` |
| `GET /api/admin/social/realtime` | `platform:manage`. This instance's counts: `{instance, kinds: [{kind: conversation \| group \| feed \| channel, rooms, sockets, signalsPerMinute: [12 numbers, oldest first], refusedLastHour}], sockets, authFailuresLastHour, signalsPerMinuteLimit, redis}` |
| `GET /api/admin/social/people?q=` | `platform:manage`. Up to 200 active people of the tenant, for the Close rooms picker |
| `POST /api/admin/social/realtime/close` `{userId}` | `platform:manage`. Every socket of the user closes on every instance (`TOPICS.roomsClose`; the client hears `rooms.closed` first); the session stays. Audited `realtime.rooms.closed` |
| `GET /api/admin/social/relations` | `{counts: {follows, blocks, mutes, lists}, rules: [{workspaceId, name, contactRule}], mostBlocked: [{userId, displayName, username, blockedBy, workspace, sanction: {kind, endsAt} \| null}]}`: counts only, never who blocked whom |

An export is `{id, conversationId, label, reason (the requester and platform admins only), requestedBy, approver,
decidedBy, decidedAt, note, state: pending \| approved \| rejected \| withdrawn \| ready \| failed, jobId, file,
messages, error, downloadedAt, createdAt, mine, canDecide}`. Platform admins see every request of the tenant; others
their own. The job writes the CSV sealed with the tenant key (`exports/<tenant>/messaging/<id>.sealed`) and audits
`messaging.conversation.exported {reason, requestedBy, approvedBy, messages, truncated}`; the members are not told.

## Sprint 36a (1.6.0): groups depth (B-4401 to B-4405)

Channels inside groups, discovery, places with distance filters, trending groups and the tenant's group categories.
Migration `038_groups2`; `server/src/groups/service.ts` (channels, places, the list filters), `groups/depth.ts`
(`s.groups.depth`: categories, discovery, trending) and `groups/geo.ts` (the distance filter). Permissions are the
groups' own (`groups:read`, `groups:write`; what a member may do inside a group is their group role) and
`social:manage` for the categories (decision Q6).

**Channels (B-4401)** are groups one level down (`parentId`), with their own members, roles, posts and events: every
`/api/groups/:id/...` route works on a channel. The group is a channel's outer boundary as the workspace is a group's:
someone who does not read the group gets `404` for its channels; only the group's members join a channel (`403 step
parent` otherwise; the invitation picker offers them alone, and inviting anyone else is `422 step workspace`); leaving
or being removed from the group leaves its channels (`channels` in the answer and the audit detail); archiving or
deleting the group archives or deletes its channels. The group's owners (and `groups:manage`) act as owners of its
channels. A channel's label is at least its group's (the floor, `422 step label-floor`) and at most the workspace
ceiling; raising a group's label raises its channels below it with their posts and events (`channelsRaised` in the
audit detail) and re-checks their rooms. Channels do not nest (`422 step parent`); categories and places belong to
groups (`422 step parent` on a channel). `GET /api/groups` lists groups only; a group's view has `channels` (how many
the caller may know of), a channel's has `parentName` and `parentLabel`. The feed's group scope and fan-out follow the
same rule (a channel's post reaches readers of the channel and of its group).

**Places (B-4403)**: a group may have `location: {name?, lat?, lon?}` (the name sealed; a point needs both coordinates,
WGS 84 degrees, `422 step location` otherwise; `null` clears it) and an event `lat`, `lon` beside its `location` text
(moving the point moves the event's `sequence`). A group's place is shown to readers of its content, like its
description (an open decision in `Backlog-1.6.0.md` asks whether it should be members only); a distance filter only
matches places the caller may read. `near=<lat>,<lon>&km=<radius>` (default 25 km, at most 20 016) on `GET
/api/groups`, `GET /api/groups/discover` and `GET /api/calendar/events` keeps the rows within the radius, nearest
first, each with `distanceKm`. PostgreSQL with PostGIS narrows with `ST_DWithin` on the point as a geography (the GiST
index of `038_groups2`); without PostGIS (and on MySQL and SQLite) a bounding box on `lat` and `lon` does, across the
antimeridian and over the poles; either way the great-circle distance on the PostGIS sphere (radius 6 371.0088 km)
decides, so the three databases return the same rows. A malformed `near` is `400`.

**Categories (B-4405)**: one list per tenant, managed from Social and messaging. `categoryId` on `POST /api/groups` and
`PATCH /api/groups/:id` (an unknown id is `422 step category`; `null` uncategorises); `category=<id>` or
`category=none` filters `GET /api/groups`, `/discover` and `/trending`. Removing a category sets its groups'
`categoryId` to null in the same transaction: they stay listed.

| Method and path | What it does |
| --- | --- |
| `GET /api/groups?workspace=&mine=&category=&near=&km=` | As before, groups only (not channels); 1.6.0 adds `parentId`, `categoryId`, `location` (readers only, else `null`), `channels`, and with `near` `distanceKm` |
| `POST /api/groups` `{…, categoryId?, location?: {name?, lat?, lon?} \| null}` | 1.6.0 adds the category and the place. Audited `group.created` (`category`, `located` in the detail) |
| `PATCH /api/groups/:id` `{…, categoryId?, location?}` | 1.6.0 adds both (groups only) and the label floor of a channel. Audited `group.updated` (`category` before and after, `channelsRaised`) |
| `GET /api/groups/discover?workspace=&category=&near=&km=&limit=` | B-4402: `{groups: [group + {sharedMembers, activity: {posts, joins}, score, invited, requested}], windowDays: 30, total}`. The groups the caller may join now: groups (not channels) they see and are not a member of, active, open or by request, or invite-only with an invitation waiting for them; **never labelled above the caller's clearance**, even for a `groups:manage` holder who sees such a group in the list. Ranked by `3 × sharedMembers + 2 × joins + posts` (members of the group the caller shares another group or channel with; joins and published posts in the last 30 days), then members and name; with `near`, nearest first |
| `GET /api/groups/trending?workspace=&category=&limit=` | B-4404: `{groups: [group + {trend: {joins, posts, score}}], computedAt, windowStart, hours}` as the `groups.trending` job last counted them, the caller's workspaces, groups they may see and are cleared for |
| `GET /api/group-categories` | B-4405: `[{id, name, description, position, createdAt, updatedAt}]` in order |
| `GET /api/groups/:id/channels` | B-4401: the group's channels the caller may know of (a public channel is read by everyone who reads the group, a private one by its members and listed to the group's readers, a hidden one known only to its members); `403` for someone who sees the group but does not read it |
| `POST /api/groups/:id/channels` `{name, description?, visibility?: public, joinMode?: open, label?}` | `201` channel; the creator is its owner. Needs the `channels` group right (owners and moderators). The label defaults to the group's. Audited `group.channel.created {group, channel}`; the catalogue events `group.created` and `group.member.added` with the channel's id; `group.channel.created` in the group's room |
| `DELETE /api/groups/:id` | On a group, its channels are deleted too (`channels` in the answer); on a channel, audited `group.channel.deleted` |
| `DELETE /api/groups/:id/members/:userId` | On a group, also leaves its channels (`channels` in the answer) |
| `GET /api/calendar/events?from=&to=&near=&km=` | 1.6.0 adds the distance filter; events carry `lat`, `lon` |
| `POST /api/groups/:id/events`, `PATCH /api/calendar/events/:id` `{…, lat?, lon?}` | The event's point (both or neither, `422 step location`) |
| `POST /api/admin/social/group-categories` `{name: 1 to 80, description?, position?}` | `social:manage`. `201` category with `groups: 0`. Names are unique in the tenant whatever the case (`409`). Audited `group.category.created` |
| `PATCH /api/admin/social/group-categories/:id` `{name?, description?, position?}` | `social:manage`. Audited `group.category.updated {before, after}` |
| `DELETE /api/admin/social/group-categories/:id` | `social:manage`. `{id, removed: true, uncategorised}`: its groups stay, uncategorised. Audited `group.category.removed {name, uncategorised}` |
| `POST /api/admin/social/groups/trending/run` | `social:manage`. `202 {jobId}`: the `groups.trending` job for the tenant now (requests within the same minute share one job). Audited `group.trending.requested` |
| `GET /api/admin/social/groups` | 1.6.0 adds `categories: {categories: [category + {groups}], uncategorised}` (groups, not channels, at labels the caller is cleared for) and `trending` (as `GET /api/groups/trending`, ten at most); each group row names `parentId` (a channel) and `categoryId` |

**The `groups.trending` job** runs every `FEED_TRENDING_MINUTES` (with the hashtags' `feed.trending`; 0 turns both
off) per active tenant and counts, over the last `FEED_TRENDING_HOURS`, the joins (`group_members.joined_at`) and
published posts of each active, not hidden group (channels never trend): `score = 3 × joins + posts`, the top 50 per
workspace with a score, kept in `group_trending` (replaced each run, so it is idempotent).

## Sprint 35b (1.6.0): the Overview and Jobs and queues (B-4202, B-4203)

The two admin screens read and act on what already exists: the instances' readiness, the one `JobQueue`, the
`Scheduler` and the tenant cache. Reading needs `tenant:manage` or `platform:manage`; what acts on every tenant
(draining an instance, pausing a job type, running or pausing a schedule) needs `platform:manage`. A system admin sees
every tenant's jobs and may filter by `tenant`; a tenant admin sees their own tenant's, and another tenant's id is
`403` (decision Q9). Payloads are listed by key only. Every route answers `Cache-Control: no-store`. Migration
`037b_platform_ops` adds `platform_instances`, `job_type_pauses`, `schedule_pauses` and `platform_alert_acks`.

- **Instances.** Every server process writes its row of `platform_instances` at start and every 30 seconds: what its
  `/readyz` answered (the same `checks`: `database`, `migrations`, `schema`, `kms`, `blobs`, `shutdown`), its schema
  handshake, the jobs it is running, its sockets, its rate-limit store, its tracing counters and its last NTP offset.
  Its id is the job queue's worker id (`host:pid`), so a job's `node` names it. A row whose beat is older than three
  intervals reads `not answering`; a clean shutdown removes the row; rows a day old are removed.
- **Drain** (decision Q14): the instance stops claiming jobs (the job queue's gate, beside the schema handshake) and
  answers `/readyz` with `503` and `checks.shutdown: draining`, so a load balancer sends it nothing new; it finishes
  what it has. It takes the drain from `TOPICS.instanceDrain` at once or from its row at its next beat. Nothing is
  restarted from the console; a restart is a new instance.
- **Alerts** are computed when asked, never stored: an instance behind the schema (`schema`) or not answering
  (`instance`), the backup RPO watch (`rpo`), zone drift in the cluster (`drift`), platform certificates expiring within
  7 days (`certs`) and the rate-limit probe (`ratelimit`) for system admins; the tenant's own certificates expiring
  within 7 days (`pki`, with `pki:manage`) for everyone on the screen. Each has a `key` naming its occurrence; an
  acknowledgement (decision Q15) hides that key for every administrator of the tenant.
- **Pausing a job type** keeps it queuing and stops every instance claiming it: each poll reads `job_type_pauses`
  again, so the pause holds everywhere within one poll (`JOB_POLL_MS`; in BullMQ mode a dispatch that arrives while
  paused is left to the 30-second poll after the resume). **Pausing a schedule** makes the `Scheduler` skip its
  buckets; missed buckets are not caught up. **Run now** queues one run per target outside its bucket, with a dedupe key
  `<name>:<target>:now:<ms>`, so it is listed with the schedule's last runs.

| Method and path | What it does |
| --- | --- |
| `GET /api/admin/overview?window=1h\|24h\|7d` | `{scope: platform \| tenant, window, alerts: [{key, kind, tone, title, text, since, open: {route, params?, label} \| {instance, label}}], counters: {jobsScope, queued, oldestQueuedAt, running, failed, flags: {open, overdue}, heldReplies, signins, refusedBySanction, workspaces, sockets: {total, instances} \| null, runningOn}, schedules: {total, items}, audit: [{id, seq, ts, action, actor, object, label, redacted}] \| null, instances: [instance] \| null, heartbeatSeconds, capacity: {database: {client, bytes, pool: {used, max}}, vectors: {count, store}, blobs: {kind, ok}, rateLimit, cache} \| null, metricsUrl, metricsToken}`. `instances`, `capacity` and `metricsUrl` only for system admins; `audit` needs `audit:read`. An instance: `{id, node, pid, role, version, state: ready \| not ready \| draining \| not answering, checks, schema: {state, detail}, jobsClaimed, sockets, runtime: {rateLimit, tracing, ntpOffsetMs, jobQueue, concurrency, workersEnabled}, drain, drainedBy, drainedAt, startedAt, heartbeatAt, self}` |
| `POST /api/admin/overview/alerts/acknowledge` `{keys}` | Acknowledges the open alerts named (at most 50) for the tenant; `409` when none is open. Audited `platform.alert.acknowledged {alerts} {titles, kinds}`. `{alerts}` still open |
| `POST /api/admin/overview/instances/:id/drain` | `platform:manage`, a browser session and a recent sign-in (`401` with `step_up` otherwise). `404` unknown, `409` already draining or not answering. Audited `platform.instance.drained {instance} {node, pid, jobsClaimed, sockets}`. The instance |
| `GET /api/admin/queues?tenant=` | `{backend: db \| bullmq, concurrency, items: [{type, domain, description, registered, queued, running, oldestQueuedAt, failed24h, succeeded24h, p50Ms, p95Ms, series: [8 three-hour buckets], timeoutMs, paused, pause: {reason, by, byName, at} \| null}], instances: {total, claiming, notClaiming: [{id, state, reason}]}}` |
| `POST /api/admin/queues/:type/pause` `{reason?}` | `platform:manage`. `404` for a type not registered, `409` when paused. Audited `jobs.type.paused {type} {reason, queued}`. The queues |
| `POST /api/admin/queues/:type/resume` | `platform:manage`. `409` when not paused. Audited `jobs.type.resumed`. The queues |
| `GET /api/admin/jobs?state=&type=&window=&tenant=&q=&limit=` | `{items: [{id, type, domain, tenantId, tenantName, workspaceId, workspaceName, state, progress, attempts, maxAttempts, createdAt, runAt, startedAt, finishedAt, durationMs, node, message, error, payloadKeys, traceId, createdBy, createdByName}], counts: {queued, running, failed}, tracing}`. `q` is a job id or a trace id; at most 500 |
| `GET /api/admin/jobs/:id` | One job in scope with `timeline: [{title, text?, at, tone}]` built from its timestamps; `404` outside the scope |
| `POST /api/admin/jobs/:id/cancel` `{reason?}` | A queued job at once, a running one at its next step; `409` otherwise. Audited `jobs.cancelled {job, tenant} {type, state, reason}` |
| `POST /api/admin/jobs/:id/retry` | A failed, cancelled or preempted job queued again with a fresh attempt count (same id); `409` otherwise. Audited `jobs.retried {job, tenant} {type, from, attempts}` |
| `POST /api/admin/jobs/retry-failed` `{type?, window?, tenant?}` | Every failed job in scope created in the window (default `24h`), at most 500. `{retried}`; audited `jobs.retried {type, scope} {count, types}` when any |
| `GET /api/admin/schedules` | `{items: [{name, type, everyMs, setting, description, targets: platform \| "<n> tenants", targetCount, nextAt, paused, pause, last, runs: [{job, state, at, manual, result, durationMs}]}]}`: the schedules registered on the answering instance (an instance with `WORKERS_ENABLED=false` registers none) |
| `POST /api/admin/schedules/:name/run` | `platform:manage`. `202 {queued, jobs}`. Audited `jobs.schedule.run {schedule} {jobs}` |
| `POST /api/admin/schedules/:name/pause` `{reason?}` / `.../resume` | `platform:manage`. `409` when already in that state. Audited `jobs.schedule.paused` / `jobs.schedule.resumed`. The schedules |
| `GET /api/admin/dead-letters` | `{items: [{source: moderation \| workflow, id, item, reason, attempts, firstFailedAt, lastFailedAt, redrivesAs, link: {route, params}}], sources}`: the caller's tenant only, moderation jobs with `moderation:manage` and the current workspace's workflow runs within clearance with `workflows:manage` |
| `POST /api/admin/dead-letters/:source/:id/redrive` | `201 {source, id, jobId, runId}`; needs the domain's permission (`403` otherwise). Audited by the domain: `moderation.job.redriven` or `workflow.dead_letter.redriven` |
| `POST /api/admin/dead-letters/:source/:id/discard` `{reason}` | The row's state becomes `discarded`; `409` when it is not open. Audited `jobs.deadletter.discarded {source, deadLetter} {reason, type, error}`. The dead letters |
| `GET /api/admin/cache` | `{store: memory \| redis, instances, ttlSeconds: {short, medium, long}, maxEntries, items: [{ns, tier, description, requests, hits, invalidations: {local, bus}, entries}]}`. Reads and invalidations are this instance's since it started; `entries` is the tenant's live entries in a memory store, `null` in Redis |
| `POST /api/admin/cache/:ns/invalidate` | Drops the namespace for the caller's tenant here and over the bus on every instance; `404` for a namespace the server does not use. Audited `jobs.cache.invalidated {namespace} {store}`. The cache |

`server/src/ops/instances.ts` has `s.instances` (`InstanceRegistry`: `beat`, `list`, `drain`, and `readiness`, which
`/readyz` shares), `ops/overview.ts` `s.overview` (`alerts`, `acknowledge`, `counters`, `recentAudit`, `capacity`) and
`ops/jobs-admin.ts` `s.jobsAdmin`; the routes are `routes/admin/operations.ts`.

## Sprint 35c (1.6.0): Storage and Configuration (B-4204, B-4205)

Both screens are for platform admins (`platform:manage`, an MFA-verified session); changes need a browser session.
`server/src/ops/storage.ts` (`s.storage`, with `s.storage.integrity` in `ops/blob-integrity.ts`) and
`server/src/config/settings.ts` (`s.settings`). Migration `037c_platform_storage`.

### Storage (B-4204)

| Method and path | What it does |
| --- | --- |
| `GET /api/admin/storage/stores` | `{stores: [{id: blobs \| db \| vectors \| backups \| media \| datasets \| models, name, kind, location, usedBytes \| null, capacityBytes \| null, freeBytes?, objects, health: ok \| failing \| late, checkedAt, detail, settings: [name], growth: [bytes per day], verify?, migrate?, singleNode?, link?: {route, params, label}}], migration \| null, active: {label, migration \| null, mode}}`. The blob store's health is `/readyz`'s check on this instance, its size and object count come from the last verification, its capacity from `statfs` (a filesystem store; S3 reports none). The database row reports the dialect's own size and connections; growth lines are daily samples (`platform_storage_samples`, the `ops.storage.sample` job every 6 h and each verification) |
| `GET /api/admin/storage/usage` | `{workspaces: [{id, workspace, tenantId, tenant, label, files, versions, trash, media, knowledge, attachments, total, quotaBytes \| null, quotaUsed, users: [{id, name, bytes}] (top five), growth}], users: [{id, name, bytes, workspaces}], kinds: [{kind, bytes}], quotaCounts: [files, versions, trash]}` in bytes. `files` is each file's current version, `versions` the others, `trash` the versions of trashed files; the file quota (B-2403) counts those three (`quotaUsed`). Set a quota with `PUT /api/admin/tenants/:tid/workspaces/:wid/file-quota` (`tenant:manage`) |
| `GET /api/admin/storage/quarantine` | `{items: [{kind: attachment \| file \| knowledge \| media, id, object, label, workspace, workspaceId, tenantId, size, state, rawState, detail, at, by, holdsBytes, running, canRescan, canDelete}], scanner: {configured, host, reachable, error, engine, signatures: {version, date} \| null, scannedToday, refusedToday: {state: n}, failedToday}}`. Items wait for their scan (`state` scanning, or `scan failed` / `timed out` when the scan job failed) or were refused in the last 24 hours (`infected`, `type mismatch`, `too large`, `above the ceiling`, `refused`, `deleted`). The scanner panel asks clamd `PING` and `VERSION` with a 3-second timeout |
| `POST /api/admin/storage/quarantine/:kind/:id/rescan` | `202 {job}`: queues the item's scan job again (`attachment.scan`, `file.scan`, `knowledge.scan`, `media.ingest`). `409` when nothing is held any more or a scan is running, `503 step scanner` while `CLAMD_HOST` is set and does not answer. Audited `file.quarantine.rescanned` in the item's tenant |
| `POST /api/admin/storage/quarantine/:kind/:id/delete` `{reason?}` | `204`: deletes the quarantined bytes and refuses the item ("Deleted from quarantine by an administrator"); nothing was released, so no file, message or record changes. `409` while it is being scanned. Audited `file.quarantine.deleted` |
| `GET /api/admin/storage/integrity` | `{runs: [Run], last: Run \| null, running: Run \| null, findings: [{id, kind: missing \| orphan \| mismatch, object, size, modifiedAt, referencedBy: [{table, column, id}] \| null, expected, actual, state: open \| deleted \| accepted \| gone, resolvedAt, note, foundAt}], graceHours, dryRunMinutes, everyMinutes}`; a Run is `{id, state, checksums, store, objects, bytes, missing, orphans, orphanBytes, mismatches, references, error, jobId, createdAt, startedAt, finishedAt}`. Findings are those of the latest finished run (at most 10,000 per kind; the counts are exact) |
| `POST /api/admin/storage/integrity/verify` `{checksums?}` | `202` Run: queues `ops.blobs.verify` (also scheduled every `BLOBS_VERIFY_MINUTES`). `409` while one is queued or running. The job lists the store, walks every row of every table (the backups' B-903 reference walk, plus row ids in derived keys), and reports a `blob_key`, `manifest_key` or `report_key` the store does not have (checked twice) as **missing**, an object older than `BLOBS_ORPHAN_GRACE_HOURS` nothing references as an **orphan** (never backups or mirror files), and, with `checksums`, an object whose SHA-256 changed while its modification time did not as a **mismatch** (mirror files against their name). It never changes the store. Audited `platform.blobs.verify.started` and `platform.blobs.verified` |
| `POST /api/admin/storage/orphans/dry-run` `{objects?: [key]}` | `{id, count, bytes, oldest, skipped, expiresAt, keys}` (the first 50): the open orphans of the latest run (or the ones named), each looked at again against a fresh walk of the references; nothing is deleted. `409` with no finished run or nothing left to delete. Audited `platform.blobs.orphans.dry-run` |
| `POST /api/admin/storage/orphans/delete` `{dryRun, reason}` | `{deleted, bytes, failed}`: deletes exactly the dry run's objects (decision Q10: a dry run, then one admin with a reason). A dry run is used once and lasts `BLOBS_DRY_RUN_MINUTES` (`409 step dry-run` after). Audited `platform.blobs.orphans.deleted` with the reason and the list of objects |
| `POST /api/admin/storage/findings/:id/accept` `{reason}` | The finding: takes an object's current SHA-256 as the one to compare against (a change that was expected). `409` for anything but an open mismatch, or a mirror file. Audited `platform.blobs.checksum.accepted` |
| `GET /api/admin/storage/purges` | `[{what, policy, where: {route, params, label}, job, everyMinutes, setting, lastRun, lastState, removed, nextRun}]`: file trash, conversation and channel retention, memory purge, backup retention, feed indexes and the PDS trim, with the last finished run of each job and the next bucket |
| `GET /api/admin/storage/migrations` | `{migrations: [Migration], active: {label, migration}}`; a Migration is `{id, state: queued \| copying \| switched \| retired \| failed \| cancelled, from, to, target: {kind, dir? \| endpoint, bucket, region, pathStyle, accessKeyId}, reason, objects, copied, bytes, verified, error, jobId, createdBy, createdAt, switchedAt, retiredAt}` (never the secret) |
| `POST /api/admin/storage/migrations` `{kind: fs, dir, reason}` or `{kind: s3, endpoint, bucket, region?, pathStyle?, accessKeyId, secretAccessKey, reason}` | `202` Migration (decision Q16), with a recent sign-in (`401 step_up`). The target must answer its health check (`422`), an S3 endpoint passes the service URL checks, a directory is absolute and neither inside nor around the current one; one migration at a time (`409`). The job `ops.blobs.migrate` puts every instance in `dual` mode (writes and deletes also go to the target) and waits until each live instance reports it, copies every object with a SHA-256 check of the copy, makes a second pass for anything listed late, verifies the target has every object at the same size, then switches: reads and writes go to the target, reads of an object it lacks fall back to the old store. Any failure puts every instance back on the old store. The secret is sealed with the platform key. Audited `platform.blobs.migration.started`, `.switched`, `.failed` |
| `POST /api/admin/storage/migrations/:id/retire` `{reason}` | Migration: stops reading from the old store (nothing is deleted there). Recent sign-in. Audited `platform.blobs.migration.retired` |

### Configuration (B-4205)

The settings descriptor `server/src/config/settings.generated.ts` is generated from `server/src/config/index.ts` by
`npm run gen:settings -w server` (the suite fails when it is stale): for each of the environment schema's variables
its section, type, constraint, default, whether it is a secret (the `<NAME>_FILE` variables, `S3_ACCESS_KEY_ID` and
`OTEL_EXPORTER_OTLP_HEADERS`), whether a change applies `hot` (read from the live configuration at each use) or at the
next `restart`, whether it may be overridden, and the description from the comment above it (or `docs/deploy.md`).

| Method and path | What it does |
| --- | --- |
| `GET /api/admin/platform/settings` | `{build, instance, overridesEnabled, sections, instances: [{instance, host, version, startedAt, reportedAt, live, blobMode, self}], restartRequired: [{name, instances}], pending: [Proposal], settings: [Setting]}`. A Setting is the descriptor plus `{fileForm, file, mode?, chars?, value, source: env \| file \| default \| override, changed, differs, perInstance: [{instance, value, source, chars?, fingerprint?}], since, override: {value, applies, reason, proposedBy, approvedBy, appliedAt, waiting: [instance]} \| null, pending: Proposal \| null, history: [{action, from, to, reason, state, proposedBy, decidedBy, at, note}], deprecated}`. Every instance reports what it reads every `PLATFORM_INSTANCE_REPORT_SECONDS` under `INSTANCE_NAME` (default its host name); instances that reported within three periods are `live`, and a setting `differs` when live instances read different values. For a secret, `value` is `set` or `null` with its length, the file it came from and the file's mode, and a 16-hex fingerprint keyed with `SESSION_SECRET` so that instances can be compared; the value never leaves the server. `DATA_KEY_PREVIOUS` and `KMS_PREVIOUS_PROVIDER` are `deprecated` once a verified `kms:rewrap` is in the audit chain |
| `GET /api/admin/platform/settings/export?changed=true` | `{text, lines}`: the settings this instance reads as a `.env` file by section, secrets as `********` with a comment naming their file; `changed` keeps only those not at their default. Audited `platform.settings.exported` |
| `POST /api/admin/platform/settings/:name/proposals` `{value: string \| null, reason}` | `202` Proposal `{id, name, action: set \| clear, value, previous, reason, state, proposedBy, proposedAt, decidedBy, decidedAt, note}`: an override (or, with `value: null`, removing one) for a second platform admin to decide (decision Q2). The value is checked against the field's schema and the configuration's cross-field rules with every other override in force (`422 {setting, errors}`); one pending proposal per setting (`409`); secrets and what reaches the database (`DB_*`, `DATABASE_URL`, `SQLITE_FILENAME`, `NODE_ENV`, `PLATFORM_SETTINGS_OVERRIDES`, `INSTANCE_NAME`) are not overridable (`409 step not-overridable`); with `PLATFORM_SETTINGS_OVERRIDES=false` every proposal is `409 step overrides-disabled`. Audited `platform.setting.proposed` |
| `POST /api/admin/platform/settings/proposals/:id/approve` `{note?}` | `{proposal, applies, applied}`: a second platform admin approves (the proposer gets `403 step dual-control`); the value is checked again, stored in `platform_setting_overrides` and, for a hot setting, applied to every instance's configuration (at once over the bus, and at each instance's next report). A restart setting is read at the next start of each instance (applied before the services are built; if the stored overrides no longer pass the schema the instance starts with its environment and logs why), and `restartRequired` names the instances still running without it. Audited `platform.setting.approved` |
| `POST /api/admin/platform/settings/proposals/:id/reject` `{note?}` | The proposal, rejected; the proposer withdraws instead (`409`). Audited `platform.setting.rejected` |
| `POST /api/admin/platform/settings/proposals/:id/withdraw` | The proposal, withdrawn; only by its proposer (`403`). Audited `platform.setting.withdrawn` |

New settings: `PLATFORM_SETTINGS_OVERRIDES` (default `true`), `INSTANCE_NAME`, `PLATFORM_INSTANCE_REPORT_SECONDS`
(30), `BLOBS_VERIFY_MINUTES` (1440; 0 turns the schedule off), `BLOBS_ORPHAN_GRACE_HOURS` (24) and
`BLOBS_DRY_RUN_MINUTES` (60).

## Sprint 36b (1.6.0): blob deduplication, held form values and reveal anomalies (B-4601, B-4701, B-4803)

Migration `038b_dedup_held_vault`. New settings: `APPS_HELD_MAX_PER_FORM` (200), `APPS_HELD_KEEP_DAYS` (30),
`VAULT_ANOMALY_BURST` (5; 0 turns detection off), `VAULT_ANOMALY_BURST_SECONDS` (60), `VAULT_ANOMALY_HISTORY_DAYS`
(30) and `VAULT_ANOMALY_MIN_HISTORY` (20).

### Blob deduplication (B-4601)

No new route. `server/src/files/dedup.ts` (`s.files.dedup`): identical content in one tenant's file store is stored
once. Every upload still streams its full bytes, sealed under a key of its own, into quarantine and is scanned; when
the scan releases a version whose plaintext SHA-256 the tenant already stores (`file_blobs`), the version reads that
object (`file_versions.blob_id`), the blob's `refs` goes up and the quarantined copy is deleted. Otherwise the version's
object moves into the store as before and is registered as a blob. The trash purge releases references in the
transaction that deletes the version rows and deletes an object only with its last reader. Two tenants never share an
object (the lookup is keyed by tenant, and each tenant's key seals its own copy). Quotas still count every version's
own size. `file.version.ready` names the blob it shares in `detail.sharedWith`. The migration registers the first
ready version of each content per tenant as a blob, so later uploads share what was stored before 1.6.0.

| Method and path | What changes |
| --- | --- |
| `GET /api/admin/storage/usage` | Adds `dedup: {blobs, shared, references, logicalBytes, storedBytes, savedBytes, tenants: [{tenantId, tenant, blobs, shared, references, logicalBytes, storedBytes, savedBytes}]}`: objects, those read by more than one version, the versions reading them, the bytes the versions hold, the bytes stored and the difference |

The integrity check (`ops.blobs.verify`) sees `file_blobs.blob_key` like any other key column, so a shared object is
referenced while any version or blob row names it; blob store migrations copy it once.

### Held form values (B-4701)

`server/src/apps/forms-held.ts` (`s.apps.forms.held`). A public form submission with a value the `user-input`
guardrail holds (a `require-approval` rule in enforce; a hold from a check that could not run stays a refusal) is
kept: its screened values sealed with the tenant key (`app_form_holds`), a hold flag on the `user-input` checkpoint
with source kind `app-form-submission` (routed to a moderation queue like any flag; the Flags screen shows the values
in `held.content`). The submitter gets `202 {held: true}`. At most `APPS_HELD_MAX_PER_FORM` wait per form; past that a
held value is refused as before (`422 step held-queue-full`). Signed-in submissions are still refused (`422`).
Audited `app.form.held` (system, with the address).

| Method and path | What it does |
| --- | --- |
| `GET /api/apps/held?state=held\|accepted\|rejected\|all` | `flags:review` or `moderation:review`. `{items: [Held]}` in the caller's workspaces and clearance (default `held`, oldest first); a Held is `{id, state, label, workspaceId, app: {id, name, title}, form: {id, name, title}, held: [{field, rule, reason}], dropped, flag: {id, ref, state, queueId} \| null, recordId, decidedBy, decidedAt, reason, createdAt}` |
| `GET /api/apps/held/:id` | Held plus `values` (the screened values, null once decided). `404` outside the caller's workspaces or clearance |
| `POST /api/apps/held/:id/decide` `{decision: accept \| reject, reason?}` | `{recordId, state, flag: {id, ref, state}}`. Through the flag queue's hold decision (the flag becomes `approved` or `rejected`): accepting writes the record as an unheld public submission would (by no one, `source: form`, the entity's own validation; a refusal there puts the submission back to `held` and answers the entity's problem), rejecting writes nothing. The values are dropped either way. `409` when already decided. Audited `app.form.held.accepted` (with the record) or `app.form.held.rejected` |
| `POST /api/flags/:ref/decide` `{decision: approved \| rejected}` | For an `app-form-submission` hold flag: the same as accept and reject above |

The job `apps.held.purge` (every 6 h) deletes decided submissions `APPS_HELD_KEEP_DAYS` after their decision.

### Reveal anomalies (B-4803)

`server/src/vault/anomalies.ts` (`s.revealWatch`). Every reveal of a KV secret over the API (`GET
/api/vault/kv/data/*path`, with the caller's address) is kept in `vault_reveals` for `VAULT_ANOMALY_HISTORY_DAYS`
and, before the value is answered, compared with the secret's history: a **new address** (revealed from other
addresses in that time, never from this one), an **odd hour** (at least `VAULT_ANOMALY_MIN_HISTORY` reveals and none
in this UTC hour of the day), a **burst** (the `VAULT_ANOMALY_BURST`-th reveal by one principal within
`VAULT_ANOMALY_BURST_SECONDS`). A signal opens a flag for the secret's owner (its owner, else its creator), who gets a
notification (kind `vault`, with email) routed to `vault?tab=flags&flag=<id>`; one flag stays open per secret and
principal, later signals of a new kind are added to it (and tell the owner again), later reveals are counted on it.
Detection never refuses a reveal. Values the server resolves at use for `vault:` references carry no address and are
not watched. Audited `vault.reveal.flagged` and `vault.reveal.flag.updated` (system, signal kinds and principal;
never the value).

| Method and path | What it does |
| --- | --- |
| `GET /api/vault/reveal-flags?state=open\|expected\|suspicious\|all` | `secrets:read`. `{flags: [Flag]}`: the flags on secrets the caller owns, or every flag for `secrets:admin`, within their clearance (default `open`). A Flag is `{id, path, label, ownerId, principal: user:<id> \| key:<id>, principalName, ip, signals: [{kind: new-address \| odd-hour \| burst, detail, at}], reveals, state: open \| expected \| suspicious, resolvedBy, resolvedAt, note, createdAt, updatedAt}` |
| `GET /api/vault/reveal-flags/:id` | Flag plus `recent: [{principal, ip, hour, at, version, flagged}]`: the secret's reveals from a day before the flag on (at most 100). `404` for anyone but the owner and `secrets:admin` |
| `POST /api/vault/reveal-flags/:id/resolve` `{decision: expected \| suspicious, note?}` | The Flag, resolved by the owner or a vault administrator. `409` when already resolved. Audited `vault.reveal.flag.resolved`. A suspicious reveal calls for rotating the secret (a new version) and reviewing the path policies |

The job `vault.reveals.prune` (hourly) drops reveals older than `VAULT_ANOMALY_HISTORY_DAYS`.

## Sprint 36c (1.6.0): image classification in Knowledge (B-8801 to B-8805)

A knowledge base can hold images, describe them with a vision profile, label them with vision classifiers and search
and filter by those labels. `server/src/knowledge/images.ts` (detection, images inside PDF and Word documents, the
vision prompt and answer), `server/src/knowledge/service.ts`, and the `vision` engine in
`server/src/guardrails/classifiers.ts`. Migration `038c_knowledge_images`.

### Image documents (B-8801)

- Uploads accept PNG, JPEG, WebP, GIF and HEIC, detected from the bytes. They pass quarantine (`knowledge.scan`: the
  type, ClamAV when configured) like any upload; indexing then runs the image safety check (`IMAGE_SAFETY_URL`,
  `IMAGE_SAFETY_THRESHOLD`; with `IMAGE_SAFETY_REQUIRED` an image no classifier checked is refused too). A flagged
  image is `rejected`: its content is deleted, nothing reaches an index, and the system audit entry
  `knowledge.image.withheld` records the score, classifier and categories.
- The base's vision profile is asked for JSON `{caption, text}` (the text visible in the image). The answer is
  validated; `# <name>`, the caption and `Text in the image:` with the text become the document's indexed text, so a
  phrase from a screenshot finds it. The description is sealed with the document. A base without a vision profile, a
  profile whose model cannot read images, or an invalid answer leaves the document `failed` with the reason and a trace
  id (retry with `POST /knowledge/documents/:id/reindex`). The call is metered as `embed` usage with the vision model.
- When the base has a vision profile, the images inside a PDF (JPEG, and 8-bit RGB or grey Flate images) and a Word
  document (`word/media/`) become its **parts**: documents of their own with `parentId`, named `<document>, image <n>`,
  at least the document's label and with its row access, through quarantine and the safety check. At most 20 per
  document; images under 1 KB are skipped. Unchanged images keep their document on a re-index, images no longer in the
  document are removed, and removing the document removes its parts. A scanned PDF with no text layer but with images
  is `indexed` with no chunks of its own. A part cannot be relabelled below its document (`409`).

### Vision classifiers (B-8802, B-8805)

| Method and path | What it does |
| --- | --- |
| `POST /api/admin/classifiers` `{name, engine: vision, labels, profile, instructions?}` | A draft vision classifier; `profile` names the tenant profile whose model reads images |
| `PATCH /api/admin/classifiers/:id` `{profile?, instructions?, thresholds?}` | A new version, as for the other model engines. A change to a published vision classifier re-labels the images of every base naming it |
| `POST /api/admin/classifiers/:id/samples` `{items: [{image, expected, label?}]}` | Image cases in the eval-set format: `image` is base64 (a PNG, JPEG, WebP, GIF or HEIC image, `422` otherwise), `expected` a label or `none`. A vision classifier refuses text cases and the other engines refuse images (`422`). `201 {added, samples}`; audited `classifier.samples.added` with `images: true` |
| `PUT /api/admin/classifiers/:id/samples/image?expected=<label>&label=<label>` (body: the image) | One image case as a raw upload (up to `ATTACHMENT_MAX_BYTES`), for images larger than a JSON request allows. `409` for a text classifier. `201 {added, samples}` |
| `POST /api/classify` `{classifier, image, label?}` | A vision classifier scores one image (base64) synchronously; nothing is stored. `422` with text for a vision classifier or an image for another engine; `503` when the model is unavailable |

The vision profile is asked to score every label from 0 to 1 and answer `{"scores": {"<label>": <score>}}`; an
unknown label, a score outside 0 to 1 or no `scores` is an error (the case counts in `errors` during an evaluation). A
label at or above its threshold is a hit, as for `llm`. Image cases are sealed in the blob store
(`eval-images/<tenant>/<case id>`); `samples` and the publish rule count only image cases for a vision classifier (and
only text cases for the others), so a vision classifier publishes after an evaluation with at least 200 image cases
per label (`409 Eval set too small` otherwise). The evaluation scores the image cases of the dataset.

### Image labels on knowledge bases (B-8802, B-8803)

| Method and path | What it does |
| --- | --- |
| `PATCH /api/knowledge/bases/:id` `{visionProfile?: <profile> \| null, imageClassifiers?: [<id or slug>]}` | The vision profile must route to a model with the `vision` capability, and the profile and the model must be cleared for the base's label (`409`). Image classifiers (at most 10) must be published `vision` classifiers (`409` for a draft or another engine, `404` unknown). A newly named classifier labels the base's images in the background; the labels of one no longer named are deleted. Audited `knowledge.updated` with `visionProfile` and `imageClassifiers` in the detail |
| `GET /api/knowledge/models` | Adds `visionProfiles: [{name, displayName, model, label}]` (published profiles whose model reads images) and `imageClassifiers: [{id, slug, name, status, version, labels}]` (the tenant's vision classifiers, drafts included, so the form can say why one cannot be picked) |
| `GET /api/knowledge/bases/:id/documents?media=image&labels=a,b&labelsAll=c&minScore=0.6` | `media=image` lists image documents only; `labels` (any of them) and `labelsAll` (every one), comma-separated, keep the image documents carrying them at or above `minScore`, or at or above each classifier's threshold without it |
| `GET /api/knowledge/bases/:id/labels` | `[{label, documents}]`: the labels the base's images carry (hits), counted over documents at or below the caller's clearance |
| `POST /api/knowledge/bases/:id/reclassify` | `202 {jobId, images}`: labels every indexed image again with every classifier the base names (`knowledge.reclassify`, forced). Manage access; `409` when the base names no image classifier. Audited `knowledge.reclassify.started` |
| `GET /api/knowledge/documents/:id` | Adds `caption`, `text`, `visionModel` (an image's description, `null` otherwise), `labels` and `parts: [document]` (the images of a PDF or Word document, at or below the caller's clearance); `kb` carries `imageClassifiers` (how many the base names) |
| `GET /api/knowledge/documents/:id/thumbnail` | The image itself (PNG, JPEG, WebP or GIF), for readers cleared for its label and allowed by its row access, once its safety check passed and it was indexed; `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, no-store`. `404` for HEIC and for quarantined, rejected or failed images. Nothing is resized on the server |
| `POST /api/knowledge/documents/:id/reclassify` | `202 {jobId, images: 1}`: labels one indexed image again (`knowledge.classify`). Manage access. Audited `knowledge.document.reclassify.started` |

A document gains `parentId`, `media: image | null`, `thumbnail` (the URL above, or `null`), `safetyScore` and, for an
image, `labels: [{label, score, hit, classifierId, classifier, version}]` (hits first, then by score). Labels are stored
per document, classifier and label in `knowledge_doc_labels` with the score, whether it reached the threshold and the
classifier version that scored it; they carry the image's own label and follow a relabel.

Jobs: `knowledge.classify` `{documentId}` scores one indexed image with the base's published vision classifiers (queued
after the image is indexed, when the base names any); `knowledge.reclassify` `{kbId, classifierId?, force?}` labels the
base's images again, skipping images the classifier's current version already labelled unless forced, and ends with
the system audit entry `knowledge.reclassified` `{images, classified, failed, force}`. A published classifier's new
version (`PATCH` while published, or `publish`) queues `knowledge.reclassify` for each base naming it, so the images are
re-labelled without being uploaded again.

### Search with label filters (B-8803)

| Method and path | What it does |
| --- | --- |
| `POST /api/knowledge/search` `{kbIds, query, k?, rerank?, labels?: {any?: [label], all?: [label], minScore?}}` | With `labels`, only the chunks of image documents carrying any of `any` and every one of `all` (at or above `minScore`, or each classifier's threshold) are ranked; the filter is applied inside the ranking, at or below the caller's clearance |

An image hit adds `image: {caption, ocr, labels, thumbnail}`: `ocr` is an excerpt of the image's text (300
characters). The caption and excerpt pass the `context` checkpoint as well as the chunk: a blocking rule withholds them
(`null`), a redacting rule rewrites them.

The built-in tool **`knowledge_search`** (seeded by `038c`, `read`, ceiling `restricted`) is the knowledge step of
agents and workflows: `{kbIds (1 to 20), query, k? (1 to 20, default 8), labels?: {any?, all?, minScore?}}` returns
`{ceiling, hits: [{kb, document, documentId, section, label, score, text | withheld, image?}]}`. It needs
`knowledge:read`, searches only published bases shared with the caller (refused otherwise), and searches at most at the
label of the conversation or run it is called from, capped by the caller's clearance.

