# Porting the platform's low-code builder into the Apps screen

1.7.0 port item, decided 2026-10-15 by the owner: the exprsn-platform low-code builder
(`exprsn-platform/web/src/features/lowcode/`, React and TypeScript, about 2,900 lines over the platform's `/lowcode`
service) is **ported** into Exprsn-AI's Apps screen as plain console code, not embedded as the React app. One console,
Exprsn-AI's permissions, labels, clearance and audit, and the content-security policy (`script-src 'self'`) unchanged.

This file is the gap analysis the port started from, and the record of what was ported.

## Platform flows become Workflows

A platform *flow* is: a trigger (hook-bus event, cron, incoming webhook or manual), an optional condition tree
(`all`/`any`/`none` groups of `{field, op, value}` leaves, the `match`), and an ordered list of actions, each with its
own optional condition (`when`), an error policy (`continue` or `stop`) and retries. The platform runs flows in its own
engine.

Exprsn-AI already has a durable automation engine, Workflows (`server/src/workflows/`): checkpointed runs, labels along
every path, approvals, retries and failure edges, dead letters, the chain context, and record triggers on app entities
(`apps/triggers.ts`, B-2206) that start a published workflow as its owner. A second engine would duplicate all of that
and bypass its controls. So **a flow is a workflow**:

- An app's flow is stored as its editable model in `app_flows` (migration `079_lowcode_port`) and **compiled** on the
  server into an ordinary Workflows graph (`apps/flows.ts`, `compileFlow`), saved as the draft of a workflow the flow
  owns and published as its next version. The graph is what runs; the model is only what the canvas edits.
- The trigger: record events (`created`, `updated`, `deleted`, `transitioned`) and schedules become the app's own
  record and schedule triggers (`app_triggers`), so the owner checks, label skips, chain depth and loop rules of
  B-2206 apply unchanged. A manual flow has no trigger; it runs from the console (a dry run of a chosen record).
- The condition tree compiles into `branch` steps: a leaf is one branch step, `all` chains them on the true edge,
  `any` on the false edge, `none` swaps the edges; `not_*`, `falsy`, `in` and `not_in` are rewritten into the branch
  step's operators. Exactly one path through the chain is live, which is how the engine joins (a step runs when one of
  the steps feeding it passed). The same compiler handles each action's own `when`.
- Actions map onto step kinds: `create`, `update` and `transition` onto `record` steps (as the run's owner, within the
  run's label); `notify` onto `notify`; `approval` onto `approval`; `wait` onto `wait`. Retries are the step's
  `retry` policy; `continue on error` is a failure edge to a small step that records the failure and carries on.
- Editing the workflow on the Workflows screen is still possible (it is an ordinary workflow). The flow keeps the
  draft revision it last wrote; when the workflow's draft has moved on, the canvas says it was edited on Workflows
  and saving from the canvas needs an explicit overwrite.

Taken over later (migration `082_app_flow_integration`, 2026-10-15): the platform's *incoming webhook* trigger and its
`http_request` action, done the Exprsn-AI way. The webhook is a per-flow public endpoint (`/hooks/apps/<tenant>/<flow>`)
that takes only requests signed with HMAC-SHA256 over the timestamp and the body under a per-flow secret (shown once,
sealed, rotated at once), within a five-minute window, once each (replays refused), capped in size and rate, off until
a designer turns it on, its payload screened by the `untrusted-content` and `user-input` checkpoints before any step,
audited. The HTTP request action compiles onto the HTTP step and is refused at save unless its host is on the
tenant's list of allowed hosts and its credentials are vault references. The other integration actions (tool, script,
agent, AI step, message) compile onto their workflow steps the same way; see `apps/flow-integrations.ts`. Still not
taken over: the platform's shared-secret-in-the-URL webhooks and unsigned starts.

## Feature by feature

Plan: **UI** = port the UI only, the API already does it; **server** = needs server work; **skip** = not ported, with
the reason. "Done" marks what this port delivered.

| Feature (platform file) | Platform | Exprsn-AI before the port | Plan |
| --- | --- | --- | --- |
| Visual flow canvas (`flow/FlowCanvas.tsx`, `LowcodeFlowEditor.tsx`, `pages/FlowDetailPage.tsx`) | reactflow canvas of trigger, condition and actions, inspector on the right | Apps had a Triggers tab that links an entity to a workflow designed on Workflows; no per-app automation canvas | **server + UI, done**: `apps/flows.ts`, `routes/apps-flows.ts`, migration `079_lowcode_port`, the Flows tab (`web/js/screens/apps-flows.js`) with an SVG canvas and inspector |
| Condition builder (`flow/ConditionBuilder.tsx`, `conditions.ts`) | nested all/any/none tree, 17 operators | Workflows `branch` step: one comparison; forms: one `visibleIf` leaf | **server + UI, done** for flows (compiled to branch steps; 14 operators: no regex `matches`, no `keywords_*`, no `length_*`, which the branch step cannot express). Forms take the same trees since follow-up 2 (evaluated on the server, not compiled), and their earlier one-leaf `visibleIf` still parses |
| Flow runs and test run (`flow/FlowRunsDialog.tsx`) | run history with per-step results; "Run now" with real side effects | Workflows runs and the Runs screen; dry runs of a draft | **server + UI, done**: runs of the flow's workflow listed in the flow panel and linked to Runs; "Test on a record" starts a dry run (record steps and notices mocked) instead of real side effects |
| AI generate (`AiGenerateDialog.tsx`) | describe an entity or a flow, get a validated draft, open it in the editor | `POST /api/apps/drafts` (entity or raw workflow graph) and `/apps/:app/model/draft` (whole data model), both in the Entities tab | **server + UI, done** for flows: `POST /api/apps/:app/flows/draft` returns a validated flow model that opens in the canvas unsaved; entity drafts were already there |
| Kanban board (`KanbanBoard.tsx`) | columns per enum value or lifecycle state; cards moved by a menu | none | **UI, done**: a Board view on the Records tab (`web/js/screens/apps-board.js`), columns by state or by an indexed enum or static-lookup field, each paged on the server with its count and "Load more" (follow-up 4, `apps/board.ts`); a move is a transition (409 shows the allowed ones) or a versioned update |
| Advanced data table (`AdvancedDataTable.tsx`, `RecordsPanel.tsx`) | sortable headers, per-column filters, paging, rows per page | Records tab: server sort (indexed and system fields), filter builder, search, cursor paging, bulk delete, export, aggregate | **UI, done**: column chooser (per entity, kept in the browser), sortable column headers on indexed and system fields, rows per page. Per-column filter controls stay the existing filter builder (the server filters only indexed fields, which the builder already restricts to) |
| Saved views (`RecordsPanel.tsx`) | named grid or kanban configurations, shared or private | none (`docs` mention views only as a design-time list) | **server + UI, done** (follow-up 1): `app_views` and `app_view_defaults` (migration `080_app_views`), `apps/views.ts`, `routes/apps-views.ts`, the view picker on the Records tab (`web/js/screens/apps-views.js`). Private or shared with the app's readers (sharing needs `apps:design`), clearance-checked by the view's label, name and settings sealed, a personal default per entity. A view stores settings only; records are read with each reader's own grant |
| CSV import (`ImportCsvDialog.tsx`) | pick a file or paste, header mapping preview, per-row report | paste a CSV, dry run, job `apps.import` with a per-row report | **UI, done**: choose a local file, a header-mapping step (column to field, by name or title, or skip) that rewrites the header before the existing import; the server path is unchanged |
| Form editor (`FormEditorDialog.tsx`) | sections, wizard steps, `visibleWhen` trees, public link | Forms tab: ordered fields, label and help, required, one-leaf `visibleIf`, live preview, public link with rotation, rate limit | **UI, done** in part: move up as well as down. **Server + UI, done** (follow-up 2): `layout` (sections, wizard steps, review) in `formDefinitionSchema` as version 2, `visibleIf` / `requiredIf` trees on fields, sections and steps evaluated by `planForm` (`apps/form-layout.ts`) on every submission; the editor in `web/js/screens/apps-forms.js` |
| Public form page (`PublicFormPage.tsx`) | `/f/:slug` anonymous page | public forms by token through `/api/public/forms/open` and `submit`, embeds (`/embed/...`) | **skip**: Exprsn-AI's public forms and embed pages already serve this, under their own CSP |
| Entity editor (`EntityEditor.tsx`, `pages/EntityDetailPage.tsx`) | typed fields, state machine builder, storage modes, raw JSON | Entities tab: typed fields with formulas and AI fields, state machine with its diagram, outside tables, group scope, policies | **skip**: already richer. Storage modes (`mirror`, `filevault`, `export`) are the platform's own; Exprsn-AI has outside tables (`apps/sources.ts`) and export jobs instead |
| Lookup lists (`LookupEditorDialog.tsx`) | reusable static or provider lookups | `lookup` fields: static options or a source (users, workspaces, another entity's records) per field | **skip**: a reusable list is an entity in Exprsn-AI (reference or record lookup); no separate object |
| Danger confirm (`ConfirmDangerDialog.tsx`) | type the name to delete | `ctx.confirm` with the counts | **skip**: the console's confirm pattern |
| Truncate an entity (`RecordsPanel.tsx`) | delete every record | bulk delete of selected records in one transaction | **skip**: an unbounded delete is not offered; bulk delete is |
| Catalog (`catalog.ts`) | event, action, field-type vocabularies from the server | the console's own constants; the event catalogue on Workflows | **skip**: not needed |
| Labels (`labels.ts`) | humanised field labels | field `title` | **UI**: titles fall back to the name already |

## Permissions, labels and audit

- Flows are designed with `apps:design` **and** `workflows:manage` (the workflow-admin role has both): a flow creates
  and publishes a workflow. Listing flows and their runs needs `apps:design`.
- The flow's workflow is created in the designer's current workspace at the entity's label, so the designer's
  clearance and the workspace ceiling apply as on Workflows. A run carries that label: its record steps can write the
  entity's records, and a record labelled above it is skipped by the trigger (audited `app.trigger.skipped`), as for
  any app trigger. Its trigger runs as the designer (the trigger's owner) with what
  they hold at that moment.
- Audit: `app.flow.created`, `app.flow.updated`, `app.flow.deleted`, `app.flow.tested`, `app.flow.drafted`, plus the
  `workflow.created`, `workflow.draft.saved`, `workflow.published` and `app.trigger.*` events of the objects the flow
  writes.

## Importing platform apps

Decided 2026-10-15 with the port: the platform's existing low-code apps (`cortex` and `spark`, made by
`scripts/exprsn-platform/ai/cortex-spark-platform.mjs`) are **imported** into Exprsn-AI's Apps, so the low-code work
lives in one environment. `apps/platform-import.ts` (`s.apps.platformImport`), `routes/apps-platform-import.ts`,
migration `083_platform_app_import` (080 is saved views; 081 and 082 were left to the other port work), the console's
"Import from Exprsn platform" action (`web/js/screens/apps-platform-import.js`) and the setup script
`scripts/exprsn-platform-apps-import.mjs` (dry run unless `--apply`, not part of `bin/exprsn-setup`).

**Reading the platform.** Through its own API (`/lowcode/api/design/apps`, `/entities`, `/lookups`, `/forms`, `/flows`
with `?appId`, and `/lowcode/api/data/<entity>/records` paged by 500, oldest first) as one platform account: the bearer
in `PLATFORM_LOWCODE_TOKEN_FILE` (a token, or a kept platform session JSON with `token`), or one passed for one import
and kept sealed until it ends. The base URL is `PLATFORM_LOWCODE_URL`; requests go through `guardedRequest` with the
operator service URL checks (`SERVICE_ALLOWED_HOSTS`), with certificates checked (the platform's local CA comes from
`NODE_EXTRA_CA_CERTS`, never by turning checks off). A webhook flow's secret is dropped as soon as it is read. A
platform account sees the apps whose scope it administers, so each assistant's app is read as its owner.

**Dry run first.** `plan` maps everything and returns the report (kept an hour); `start` takes that dry run's id and
queues the job `apps.platform-import`, which reads the platform again and refuses if the design changed in between
(a fingerprint of entities, lookups, forms and flows; records may change). The job writes as the person who started
it, through the services every other change uses: `AppService.create`, `createEntity` and `updateEntity`,
`createRecord`, `updateRecord` and `transition` (validation, policies, labels, the record events and audit),
`forms.create` and `update`, `flows.create` and `update`.

**Mapping.**

| Platform | Exprsn-AI |
| --- | --- |
| app key, name, description | app name (or the existing app named), title, description; the label is the importer's choice within their clearance and the workspace ceiling; scope, status and capabilities are reported as dropped |
| entity key, name | entity name (lower case, `_` for other characters), title; description and storage mode dropped |
| `string`, `text` | `string`, `text` multi-line; `maxLength` from `max` or raised to the longest value held; a `string` with line breaks becomes multi-line; `unique` kept when the text fits the index (255) |
| `number`, `integer` | `number` (`integer: true`), `min` and `max` kept |
| `boolean`, `date`, `datetime` | `boolean`, `date`, `date` with time (values rewritten as `YYYY-MM-DD` or ISO 8601 UTC) |
| `enum` with `enumValues` | `enum` (options deduplicated case-insensitively; over 200 options a static lookup) |
| `enum` with a static lookup | `lookup` of source `static` with the lookup's values and labels |
| `enum` with the `lowcode.entity` provider over record ids | `lookup` of source `entity` (values re-pointed at the imported records) |
| `enum` with another provider (users, groups, queues, topics, files) | `string`, values kept, reported |
| `reference` | `reference` to the imported entity; values re-pointed at the imported records (in two passes for cycles) |
| `json` | `json`; `file` | `json` holding the FileVault pointer (the file is not copied) |
| a formula | `formula` when Exprsn-AI's formula language reads it, else the stored values in a plain field |
| an AI field (`aiPrompt`) | plain text with the values it produced (an Exprsn-AI AI field needs one of the tenant's profiles) |
| `default`, `aggregation`, `format`, `role` | dropped (`role` dimension or measure makes an enum, boolean, number or date indexed) |
| state machine | states (renamed to Exprsn-AI's spelling), transitions grouped by event and target; guards and hook actions dropped. A record reaches the platform's state along the shortest path of transitions from the initial state, each a normal audited transition; a state no path reaches is reported |
| form sections, wizard steps, help, `visibleWhen` | a version 2 form: sections (wizard steps, one per section, when the platform shows steps), help, `visibleIf` trees over earlier fields; placeholders, public links (never carried over) and other settings dropped; a condition on a later field, `matches`, `length_*` or a dotted path is dropped and the field shown always |
| flow on `lowcode.record.created` / `updated`, schedule, manual, webhook | an app flow on `created` / `updated`, schedule, manual, or a webhook flow (hook off, no secret); other hook-bus events are not imported |
| `match` and `when` trees | condition trees: `app` and `entity` tests pick the flow's entity and are dropped, `record.data.<field>` and `record.state` map; `matches`, `keywords_*`, `length_*` and other paths are not imported |
| `create_record`, `update_record`, `transition_record` | `create`, `update`, `transition` (the event's single target state); `onError` and `retries` kept |
| `http_request` | an `http` action (the host must be on the tenant's allowed hosts); with a credential header it is not imported (a flow takes a vault reference) |
| `log`, `audit` | dropped (every run is kept with its steps) |
| `notify`, module actions (`post_timeline`, `send_spark`, `cortex`, ...), `export_entity` | the flow is not imported, with the reason |

A flow imports whole or not at all: a flow that would lose an action or a condition is listed as not imported with
every reason. Imported flows are created **off** (unless `enableFlows`), and after the records, so the import itself
does not run them. Into an existing app, an entity of the same name is merged: its fields win (values are converted to
them), enum options and missing fields are added (optional when it has records), missing states and transitions are
added.

**Idempotent.** `app_platform_links` keys every platform app, entity, record, form and flow by the platform's base URL
and id to what it became. A second import updates the same app (whatever target is chosen; the report says so),
leaves unchanged records and forms alone, updates the changed fields of a record (a field the platform cleared is
cleared), creates what is new, and recreates what was deleted here. A flow edited on Workflows since is not
overwritten (`409` reported).

**Writes to the platform** (allowed from 2026-10-15). Only with `markPlatform`, and only one: the lookup
`exprsn_ai_link` on the platform app, whose values name the Exprsn-AI apps it was imported into (tenant/app, server,
time), so a re-import or another environment knows where it went. It is listed in the dry run, made through the one
function that may write (`PlatformLowcodeClient.write`, which allows only that lookup's `POST` and `PUT`, never a
delete), and audited `app.platform-import.platform-write`. The importer ignores that lookup when it maps. A sync back
of record changes was considered and left out (see leftovers in the change log): it needs conflict rules both ways.

**Permissions.** `apps:design` and `platform:manage`. The connection and its token are operator settings shared by
every tenant of the server: with `apps:design` alone a tenant admin could read the platform account's apps and
records into their tenant. Flows also need `workflows:manage` (they create and publish workflows); without it they
are listed as not imported. Audit: `app.platform-import.planned`, `.started`, `.finished`, `.failed`,
`.platform-write`, plus the `app.*`, `app.record.*`, `app.form.*`, `app.flow.*` and `workflow.*` events of what is
written.

## Follow-ups

1. ~~Saved views (`app_views`): server and the Records tab's view picker.~~ Done: migration `080_app_views`,
   `apps/views.ts`, `routes/apps-views.ts`, `web/js/screens/apps-views.js`; `server/test/app-views.test.ts`,
   `e2e/tests/apps-views.spec.ts`.
2. ~~Form sections, wizard steps and nested `visibleIf` trees: `apps/forms.ts`, the public form page and the embed
   page together.~~ Done (no migration: the layout lives in the form definition, `version: 2`; a definition without
   one is a single untitled section, migrated on read and never rewritten): `apps/form-layout.ts` (the layout schema,
   `conditionMatches` over the flows condition model imported from `apps/flows.ts`, `planForm` in layout order,
   `layoutProblems`, `normalizeDefinition`), `apps/forms.ts` (checks, `describe` with the layout, required and
   hidden fields from the plan; problems name their step), `web/js/form-layout.js` (the browser's line-by-line copy,
   checked against the server in the unit test), the public link page `GET /form#token=…` and the embed page
   (`routes/apps-embed-public.ts`, `web/js/embed.js`: step list with `aria-current`, focus to the step heading,
   per-step checks, review), the editor `web/js/screens/apps-forms.js` (hooked from `renderForms` in `apps.js`);
   `server/test/app-form-layout.test.ts`, `e2e/tests/apps-forms-layout.spec.ts`. Semantics: a condition reads only
   fields earlier in layout order; text compares without regard to case; a section's or step's `requiredIf` makes all
   its shown fields required. Not ported: the platform's regex `matches`, `length_*` and dotted paths (a form's
   answers are flat). The workflow approval form (`workflows/steps`, the Workflows screen) still shows its form as a
   flat list; its answers are validated by the same plan.
3. Flows in app packages and bundles (`apps/packages.ts`, `apps/bundles.ts`). **Done** (migration
   `082_app_flow_integration`): an `exprsn-app/2` package carries each flow's model (`flows`, and `flows/<name>.json` in
   the git layout) instead of its compiled workflow and trigger; import and deployment re-create or update flows by
   name and compile them again in the target, re-binding entities, tools, scripts, agents and profiles by name;
   promotion pipelines carry them through `apply`. A webhook flow arrives with its hook off and no secret. The legacy
   `exprsn-app/1` bundle (`apps/bundles.ts`) carries no triggers and so no flows; it is unchanged.
4. ~~The board shows the 200 most recently updated records that match the search and filters (one records query,
   grouped in the browser); a board over more records needs per-column paging on indexed group fields.~~ Done: each
   column is paged on the server (`POST .../records/board`, `apps/board.ts`) with its count and "Load more"; a board
   groups by the state or an indexed enum or static lookup (an unindexed one is named with the hint to index it).
5. `flows` is now a reserved segment under `/api/apps/<app>/` (`RESERVED_SEGMENTS`): an entity named `flows` is not
   reachable through the entity API (`/api/apps/<app>/flows`), only through `/entities/flows`.
6. The system document (`scripts/system-docs/exprsn-ai/skills-tools-workflows.md`) should describe app flows; that
   revision waits for the owner's approval. Version 1.26.0 of that document (2026-10-15) adds "App flows (the Apps
   canvas)": the integration actions, the webhook trigger and flows in packages; not yet approved.
